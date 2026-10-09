// Mutation benchmark tooling (docs/traceability-plan.md section 7.4.2). Deterministic and offline: no model, no network, Node built-ins only.
// 1. proposeTriples: (spec item, 1-3 production sites, >=1 test) sharing an integer value, sites in the BM25 top 8 for the item. A human sets confirmed.
// 2. mutate: the 8 operators applied to a CONFIRMED triple -> line edits for base/head + an `expected` block in the case.json schema.
// 3. mineHistory (--mine): commits that change a spec item and a production file with the same numeric token.
// 4. validateProposals / validateBenchManifest; unconfirmed triples never become cases.
// Usage: node eval/mutate.js --help
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { tokenize, buildIndex, parseItems, isRequirementDoc, pathKind } = require('../src/trace');
const { validateManifest } = require('./run');

const DOC = /\.(md|mdx|markdown|rst|adoc|txt|feature)$/i;
const SKIP_DIR = new Set(['.git', 'node_modules', 'vendor', 'dist', 'build', '.specguard-ctx']);
const SKIP_NAME = /(^|\/)(CHANGELOG|LICENSE)[^/]*$/i;
const MAX_FILE = 256 * 1024, MAX_FILES = 10000, WIN = 40, STEP = 20;
const INT = /(?<![\w.#-])\d+(?![\w.])/g;
const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const tokenRe = (n) => new RegExp(`(?<![\\w.])${n}(?![\\w.])`);
const isComment = (l) => /^\s*(\/\/|#|\*|\/\*|--)/.test(l);
const base = (p) => path.posix.basename(p);
// Non-equivalent replacement for n: x1.5 rounded, at least n + 1, so it can never equal n.
const nPrime = (n) => Math.max(n + 1, Math.round(n * 1.5));

// ---- file snapshot -------------------------------------------------------------------------------------------
// { 'rel/path': text } for the text files under dir (no .git, node_modules, symlinks, binaries or files over 256 KB).
function walk(dir) {
  const out = {};
  (function rec(d, rel) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (SKIP_DIR.has(e.name) || e.isSymbolicLink() || Object.keys(out).length >= MAX_FILES) continue;
      const r = rel ? `${rel}/${e.name}` : e.name, full = path.join(d, e.name);
      if (e.isDirectory()) rec(full, r);
      else if (e.isFile() && fs.statSync(full).size <= MAX_FILE) { const b = fs.readFileSync(full); if (!b.includes(0)) out[r] = b.toString('utf8'); }
    }
  })(dir, '');
  return out;
}

// ---- (1) triple proposal ---------------------------------------------------------------------------------------
const lineAt = (files, p, l) => { const x = (files[p] ?? '').split('\n')[l - 1]; return x === undefined ? null : x; };

function proposeTriples({ dir, top = 8, max = 50 }) {
  const files = walk(dir), kind = (p) => (DOC.test(p) ? 'doc' : pathKind(p));
  const meta = [], lineCache = new Map();
  function* windows() {
    for (const p of Object.keys(files).sort()) {
      if (kind(p) !== 'src') continue;
      const lines = files[p].split('\n'), pt = tokenize(p), lt = lines.map((l) => tokenize(l.slice(0, 400)));
      lineCache.set(p, lines);
      for (let a = 0; a < lines.length; a += STEP) {
        const z = Math.min(a + WIN, lines.length), toks = pt.slice();
        for (let i = a; i < z; i++) toks.push(...lt[i]);
        meta.push([p, a + 1, z]);
        yield toks;
        if (z >= lines.length) break;
      }
    }
  }
  const index = buildIndex(windows());
  const testPaths = Object.keys(files).filter((p) => kind(p) === 'test').sort();
  const out = [];
  for (const dp of Object.keys(files).filter((p) => kind(p) === 'doc' && !SKIP_NAME.test(p)).sort()) {
    const items = parseItems(dp, files[dp]);
    if (!isRequirementDoc(items)) continue;
    const dlines = files[dp].split('\n');
    for (const it of items) {
      const vals = [...new Set([...it.raw.replace(it.ref, '').matchAll(INT)].map((m) => m[0]))].filter((v) => +v >= 2);
      if (!vals.length) continue;
      const s = index.search(tokenize(`${it.path} ${it.heading} ${it.ref} ${it.text}`));
      const ranked = [];
      for (const i of [...s.keys()].filter((k) => s[k] > 0).sort((a, b) => s[b] - s[a])) { // top windows, one per 40-line neighbourhood (as trace.js)
        if (ranked.some((r) => r.path === meta[i][0] && Math.abs(r.a - meta[i][1]) < WIN)) continue;
        ranked.push({ path: meta[i][0], a: meta[i][1], z: meta[i][2] });
        if (ranked.length === top) break;
      }
      for (const v of vals) {
        const re = tokenRe(v), near = new RegExp(`(?<![\\w.])(${+v - 1}|${v}|${+v + 1})(?![\\w.])`);
        let specLine = null;
        for (let l = it.line; l <= it.end; l++) if (re.test(dlines[l - 1] || '')) { specLine = l; break; }
        if (!specLine) continue;
        const sites = [], seen = new Set();
        ranked.forEach((r, rank) => {
          const lines = lineCache.get(r.path);
          for (let l = r.a; l <= r.z; l++) if (re.test(lines[l - 1]) && !isComment(lines[l - 1]) && !seen.has(`${r.path}:${l}`)) {
            seen.add(`${r.path}:${l}`); sites.push({ path: r.path, line: l, text: lines[l - 1].trim().slice(0, 160), rank: rank + 1 });
          }
        });
        if (!sites.length) continue;
        const picked = sites.slice(0, 3), stems = picked.map((x) => base(x.path).replace(/\.[^.]+$/, ''));
        const tests = [];
        for (const tp of testPaths) {
          if (!stems.some((st) => files[tp].includes(st))) continue;
          files[tp].split('\n').forEach((l, k) => { if (near.test(l) && !isComment(l) && tests.length < 3 && tests.filter((x) => x.path === tp).length < 2) tests.push({ path: tp, line: k + 1, text: l.trim().slice(0, 160) }); });
        }
        if (!tests.length) continue;
        out.push({ best: picked[0].rank, t: { id: `${base(dp).replace(/\.[^.]+$/, '')}-${it.ref}-${v}`.replace(/[^\w.-]+/g, '_'), value: v,
          spec: { path: dp, ref: it.ref, line: specLine, text: it.text.slice(0, 200) }, sites: picked, tests, confirmed: null, note: '' } });
      }
    }
  }
  out.sort((a, b) => a.best - b.best || (a.t.id < b.t.id ? -1 : 1));
  const ids = new Set();
  const triples = out.slice(0, max).map(({ t }) => { let id = t.id, k = 2; while (ids.has(id)) id = `${t.id}_${k++}`; ids.add(id); return { ...t, id }; });
  return { schema: 'specguard-bench-proposals/1', triples };
}

// ---- triple validation and confirmation --------------------------------------------------------------------------
const isInt = Number.isInteger;
// files (optional): { path: text } of the base snapshot; then every line must really contain the value.
function validateTriple(t, files) {
  const errs = [], bad = (m) => errs.push(`${t && t.id || '?'}: ${m}`);
  if (!t || typeof t !== 'object') return ['triple must be an object'];
  if (!/^[\w.-]+$/.test(t.id || '')) bad('id must match [A-Za-z0-9_.-]+');
  if (!/^\d+$/.test(String(t.value)) || +t.value < 2) { bad('value must be an integer >= 2'); return errs; }
  const n = +t.value, re = tokenRe(n), near = new RegExp(`(?<![\\w.])(${n - 1}|${n}|${n + 1})(?![\\w.])`);
  const at = (x, what, rx) => {
    if (!x || typeof x.path !== 'string' || !isInt(x.line) || x.line < 1) return bad(`${what} needs path and integer line`);
    if (files && !rx.test(lineAt(files, x.path, x.line) ?? '')) bad(`${what} ${x.path}:${x.line} does not contain ${rx === re ? n : `${n - 1}, ${n} or ${n + 1}`}`);
  };
  at(t.spec, 'spec', re);
  if (t.kind !== 'mined' && (!t.spec || typeof t.spec.ref !== 'string' || !t.spec.ref)) bad('spec.ref must be a non-empty string');
  if (!Array.isArray(t.sites) || t.sites.length < 1 || t.sites.length > 3) bad('sites must list 1-3 production sites');
  else t.sites.forEach((s) => { at(s, 'site', re); if (s && pathKind(s.path || '') !== 'src') bad(`site ${s.path} is not a production file`); });
  if (!Array.isArray(t.tests) || t.tests.length < (t.kind === 'mined' ? 0 : 1)) bad('tests must list at least 1 test');
  else t.tests.forEach((x) => { at(x, 'test', near); if (x && pathKind(x.path || '') !== 'test') bad(`test ${x.path} is not a test file`); });
  if (![null, true, false].includes(t.confirmed)) bad('confirmed must be null, true or false');
  return errs;
}
function requireConfirmed(t) {
  if (!t || t.confirmed !== true) throw new Error(`${t && t.id}: triple is not confirmed (a human must set confirmed: true); refusing to emit a case`);
}
function validateProposals(p) {
  if (!p || p.schema !== 'specguard-bench-proposals/1' || !Array.isArray(p.triples)) return ['proposals must be {schema: "specguard-bench-proposals/1", triples: [...]}'];
  const seen = new Set();
  return p.triples.flatMap((t) => { const e = validateTriple(t); if (t && seen.has(t.id)) e.push(`${t.id}: duplicate id`); seen.add(t && t.id); return e; });
}

// ---- line edits ----------------------------------------------------------------------------------------------------
// Edit = {path, line, before, after}: line `line` (1-based) must equal `before` and becomes `after` (which may hold several lines).
function editLine(files, p, line, fn) {
  const before = lineAt(files, p, line);
  if (before === null) throw new Error(`${p}:${line}: no such line`);
  const after = fn(before);
  if (after === before) throw new Error(`${p}:${line}: edit changes nothing`);
  return { path: p, line, before, after };
}
function applyEdits(files, edits) {
  const out = { ...files }, by = new Map();
  for (const e of edits) { if (!by.has(e.path)) by.set(e.path, []); by.get(e.path).push(e); }
  for (const [p, es] of by) {
    if (out[p] === undefined) throw new Error(`${p}: no such file`);
    const lines = out[p].split('\n');
    for (const e of es.sort((a, b) => b.line - a.line)) {
      if (lines[e.line - 1] !== e.before) throw new Error(`${p}:${e.line}: line does not match the edit`);
      lines[e.line - 1] = e.after;
    }
    out[p] = lines.join('\n');
  }
  return out;
}

// ---- (2) operators ----------------------------------------------------------------------------------------------------
const repl = (l, n, m) => l.replace(tokenRe(n), String(m));
// n -> m, n+1 -> m+1, n-1 -> m-1 (tests probe the boundary around the value).
const shiftLine = (l, n, m) => l.replace(/(?<![\w.])\d+(?![\w.])/g, (v) => (+v === n ? m : +v === n + 1 ? m + 1 : +v === n - 1 ? m - 1 : v));
const CMP = / (>=|<=|>|<) /, CMP_SWAP = { '>': '>=', '>=': '>', '<': '<=', '<=': '<' };
const BOUNDARY = [[/(?<!\bno )(?<!\bnot )\bmore than\b/i, 'at least'], [/\bat least\b/i, 'more than'], [/\b(?:fewer|less) than\b/i, 'at most'], [/\bat most\b/i, 'fewer than']];
// Nearest line (within 8 of the site, preferring the site line) holding a ` > `-style comparison.
function findComparison(files, site) {
  for (let d = 0; d <= 8; d++) for (const l of d ? [site.line + d, site.line - d] : [site.line]) {
    const x = lineAt(files, site.path, l);
    if (x !== null && !isComment(x) && CMP.test(x)) return l;
  }
  return 0;
}
const siteRef = (s) => `${base(s.path)}:${s.line}`;
const siteRe = (sites) => sites.map((s) => `${esc(base(s.path))}:${s.line}\\b`).join('|');
const weakTests = (tests) => tests.map((x) => ({ kind: ['weak_test', 'missing_test'], path: x.path, line: x.line, tolerance: 6, reason: 'the test still pins the old value' }));
const uniq = (a) => [...new Set(a)];
const exp = (findings, extra = {}) => ({ findings, must_not: [], expect_skip: false, expect_clean: false, ...extra });
const NO_DRIFT = [{ kind: 'spec_mismatch' }];

function bValue(t, f, n) {
  const m = nPrime(n), e = editLine(f, t.spec.path, t.spec.line, (l) => repl(l, n, m));
  return { description: `B-value: ${t.spec.ref} goes from ${n} to ${m} in the spec; the production sites and tests keep ${n}.`,
    pr_title: `Change ${t.spec.ref} from ${n} to ${m}`, pr_body: `Update the spec: ${t.spec.ref} now uses ${m} instead of ${n}.\n`, edits: { base: [], head: [e] },
    expected: exp([{ kind: 'spec_mismatch', path: t.spec.path, line: t.spec.line, quote: String(m), text: siteRe(t.sites), sites: t.sites.map(siteRef) }], { acceptable: weakTests(t.tests) }) };
}
function bBoundary(t, f) {
  const hit = BOUNDARY.find(([re]) => re.test(lineAt(f, t.spec.path, t.spec.line)));
  if (!hit) throw new Error(`${t.id}: no "more than"/"at least"/"fewer than"/"at most" phrase on the spec line`);
  const e = editLine(f, t.spec.path, t.spec.line, (l) => l.replace(hit[0], hit[1]));
  return { description: `B-boundary: ${t.spec.ref} now says "${hit[1]}" instead of the original comparison; code and tests keep the old boundary.`,
    pr_title: `Clarify the boundary of ${t.spec.ref}`, pr_body: `Update the spec: ${t.spec.ref} now says "${hit[1]}".\n`, edits: { base: [], head: [e] },
    expected: exp([{ kind: ['spec_mismatch', 'weak_test'], path: uniq([t.spec.path, ...t.tests.map((x) => x.path)]), line: t.spec.line, tolerance: 1000, quote: hit[1] }]) };
}
function aValue(t, f, n) {
  const s = t.sites[0], m = nPrime(n), e = editLine(f, s.path, s.line, (l) => repl(l, n, m));
  return { description: `A-value: the literal ${n} at ${siteRef(s)} becomes ${m}; the spec (${t.spec.ref}) and tests keep ${n}.`,
    pr_title: `Change the limit in ${base(s.path)} to ${m}`, pr_body: `Adjust the limit in ${base(s.path)} from ${n} to ${m}.\n`, edits: { base: [], head: [e] },
    expected: exp([{ kind: 'spec_mismatch', path: s.path, line: s.line, quote: String(m), text: `${esc(t.spec.ref)}|${esc(base(t.spec.path))}` }], { acceptable: weakTests(t.tests) }) };
}
function aOperator(t, f) {
  const s = t.sites.find((x) => findComparison(f, x)), line = s && findComparison(f, s);
  if (!s) throw new Error(`${t.id}: no comparison within 8 lines of any site`);
  let to;
  const e = editLine(f, s.path, line, (l) => l.replace(CMP, (_, o) => ` ${to = CMP_SWAP[o]} `));
  return { description: `A-operator: the comparison at ${s.path}:${line} is flipped to "${to}"; spec (${t.spec.ref}) and tests are unchanged.`,
    pr_title: `Adjust the comparison in ${base(s.path)}`, pr_body: `Change the comparison to "${to}" in ${base(s.path)}.\n`, edits: { base: [], head: [e] },
    expected: exp([{ kind: ['spec_mismatch', 'weak_test'], path: uniq([s.path, ...t.tests.map((x) => x.path)]), line, tolerance: 1000, quote: to }]) };
}
const specSiteTestEdits = (t, f, n, m, sites, tests) => [editLine(f, t.spec.path, t.spec.line, (l) => repl(l, n, m)),
  ...sites.map((s) => editLine(f, s.path, s.line, (l) => repl(l, n, m))), ...tests.map((x) => editLine(f, x.path, x.line, (l) => shiftLine(l, n, m)))];
function partial(t, f, n) {
  if (t.sites.length < 2) throw new Error(`${t.id}: Partial needs at least 2 production sites`);
  const m = nPrime(n), rest = t.sites.slice(1);
  return { description: `Partial: ${t.spec.ref}, ${siteRef(t.sites[0])} and its test change ${n} -> ${m}; ${rest.map(siteRef).join(', ')} keep ${n}.`,
    pr_title: `Change ${t.spec.ref} from ${n} to ${m}`, pr_body: `Update ${t.spec.ref} and ${base(t.sites[0].path)} to ${m}.\n`,
    edits: { base: [], head: specSiteTestEdits(t, f, n, m, [t.sites[0]], t.tests.filter((x) => x.path === t.tests[0].path)) },
    expected: exp([{ kind: 'spec_mismatch', path: t.spec.path, line: t.spec.line, quote: String(m), text: siteRe(rest), sites: rest.map(siteRef) }]) };
}
// Behaviour-preserving by construction: the literal at the site moves into a new named constant declared on the line above.
const LANG = [
  { ext: /\.(m?js|cjs|jsx|tsx?)$/, name: 'SG_BENCH_VALUE', decl: (i, nm, n) => `${i}const ${nm} = ${n};`, stmt: /^\s*(export\s+)?(const|let|var|return)\b/, prev: /(^|[;{}])\s*$|^\s*\/\/.*$/, log: (i) => `${i}console.log('specguard-bench: limit check');`, whole: /;\s*$/ },
  { ext: /\.py$/, name: 'SG_BENCH_VALUE', decl: (i, nm, n) => `${i}${nm} = ${n}`, stmt: /^\s*(\w+\s*=|return\b)/, prev: /(^|[^,(\[\\])\s*$/, log: (i) => `${i}print('specguard-bench: limit check')`, whole: /[^:,(\[\\\s]\s*$/ },
  { ext: /\.go$/, name: 'sgBenchValue', decl: (i, nm, n) => `${i}const ${nm} = ${n}`, stmt: /^\s*(const|var|return)\b|^\s*\w+\s*:=/, prev: /(^|[;{}])\s*$|[\w)"'\]]\s*$/ },
];
const langOf = (p) => LANG.find((l) => l.ext.test(p));
function controlNoop(t, f, n) {
  for (const s of t.sites) {
    const lang = langOf(s.path), line = lineAt(f, s.path, s.line), prev = s.line > 1 ? lineAt(f, s.path, s.line - 1) : '';
    if (!lang || !lang.stmt.test(line) || !lang.prev.test(prev) || f[s.path].includes(lang.name)) continue;
    const indent = /^\s*/.exec(line)[0];
    const e = editLine(f, s.path, s.line, (l) => `${lang.decl(indent, lang.name, n)}\n${repl(l, n, lang.name)}`);
    return { description: `Control no-op: ${s.path}:${s.line} extracts the literal ${n} into a constant; behaviour is identical.`,
      pr_title: `Extract a named constant in ${base(s.path)}`, pr_body: 'Refactor: move the literal into a named constant. No behaviour change.\n', edits: { base: [], head: [e] },
      expected: exp([], { must_not: NO_DRIFT, trace: [{ requirement: esc(t.spec.ref), alignment: 'consistent' }] }) };
  }
  throw new Error(`${t.id}: no site is a plain statement in a supported language (js/ts, python, go); the no-op control is not applicable`);
}
function controlConsistent(t, f, n) {
  const m = nPrime(n);
  return { description: `Control consistent: the spec, every site and the tests change ${n} -> ${m} together.`,
    pr_title: `Change ${t.spec.ref} from ${n} to ${m} everywhere`, pr_body: `Change the limit from ${n} to ${m} in the spec, the code and the tests.\n`,
    edits: { base: [], head: specSiteTestEdits(t, f, n, m, t.sites, t.tests) }, expected: exp([], { must_not: NO_DRIFT }) };
}
function controlPreExisting(t, f, n) {
  const s = t.sites[0], lang = langOf(s.path), m = nPrime(n);
  if (!lang || !lang.log || !lang.whole.test(lineAt(f, s.path, s.line))) throw new Error(`${t.id}: the pre-existing control needs a js/ts or python site that is a whole statement`);
  const baseEdit = editLine(f, s.path, s.line, (l) => repl(l, n, m)), mutated = applyEdits(f, [baseEdit]);
  const head = editLine(mutated, s.path, s.line, (l) => `${l}\n${lang.log(/^\s*/.exec(l)[0])}`);
  return { description: `Control pre-existing: base already has ${siteRef(s)} = ${m} against the spec's ${n}; head only adds a log line next to it.`,
    pr_title: `Add a diagnostic log line in ${base(s.path)}`, pr_body: 'Add a log line for diagnostics. No other change.\n', edits: { base: [baseEdit], head: [head] },
    expected: exp([], { must_not: NO_DRIFT, pre_existing: true }) };
}

const OPERATORS = {
  'B-value': ['bv', bValue], 'B-boundary': ['bb', bBoundary], 'A-value': ['av', aValue], 'A-operator': ['ao', aOperator], Partial: ['pt', partial],
  'Control-noop': ['cn', controlNoop], 'Control-consistent': ['cc', controlConsistent], 'Control-pre-existing': ['cp', controlPreExisting],
};

// files: { path: text } of the base snapshot. Throws for an unconfirmed or invalid triple, or an inapplicable operator.
function mutate(operator, triple, files) {
  const o = OPERATORS[operator];
  if (!o) throw new Error(`unknown operator ${operator}; one of ${Object.keys(OPERATORS).join(', ')}`);
  requireConfirmed(triple);
  if (triple.kind === 'mined') throw new Error(`${triple.id}: mined triples are real edits (revert the production half by hand), not mutation sources`);
  const errs = validateTriple(triple, files);
  if (errs.length) throw new Error(errs.join('; '));
  return { id: `${triple.id}-${o[0]}`, operator, triple, delete: [], ...o[1](triple, files, +triple.value) };
}
// Every operator for every confirmed triple. Unconfirmed triples are counted, inapplicable operators listed in `skipped`.
function mutateAll({ triples, files, operators = Object.keys(OPERATORS) }) {
  const ops = [], skipped = [];
  let unconfirmed = 0;
  for (const t of triples) {
    if (!t || t.confirmed !== true) { unconfirmed++; continue; }
    for (const name of operators) { try { ops.push(mutate(name, t, files)); } catch (e) { skipped.push({ triple: t.id, operator: name, reason: e.message }); } }
  }
  return { ops, skipped, unconfirmed };
}

// Trees of one case: base = the triple's files after the base edits, head = only the files the PR changes (the eval/cases layout).
function trees(op, files) {
  const b = applyEdits(files, op.edits.base), h = applyEdits(b, op.edits.head);
  const rel = uniq([op.triple.spec.path, ...op.triple.sites.map((s) => s.path), ...op.triple.tests.map((x) => x.path), ...op.edits.base.map((e) => e.path)]);
  return { base: Object.fromEntries(rel.map((p) => [p, b[p]])), head: Object.fromEntries(Object.keys(h).filter((p) => h[p] !== b[p]).map((p) => [p, h[p]])) };
}
// case.json object. sandbox: true prefixes expected paths with eval-sandbox/<id>/ (the in-repo eval/cases layout).
function toCase(op, { sandbox = false } = {}) {
  const pre = (p) => (sandbox ? `eval-sandbox/${op.id}/${p}` : p);
  const e = op.expected, one = (x) => (x.path === undefined ? x : { ...x, path: Array.isArray(x.path) ? x.path.map(pre) : pre(x.path) });
  return { id: op.id, goal: 'traceability', description: op.description, pr_title: op.pr_title, pr_body: op.pr_body, delete: op.delete,
    expected: { ...e, findings: e.findings.map(one), ...(e.acceptable ? { acceptable: e.acceptable.map(one) } : {}), must_not: e.must_not.map(one) } };
}
function writeCase(dir, op, files, opts) {
  const root = path.join(dir, op.id), t = trees(op, files);
  for (const side of ['base', 'head']) for (const [p, text] of Object.entries(t[side])) {
    fs.mkdirSync(path.dirname(path.join(root, side, p)), { recursive: true });
    fs.writeFileSync(path.join(root, side, p), text);
  }
  fs.writeFileSync(path.join(root, 'case.json'), JSON.stringify(toCase(op, opts), null, 2) + '\n');
  return root;
}

// ---- (4) external manifest entries -------------------------------------------------------------------------------------
// Entry for eval/run.js --external. base/head default to branch names that `materialize` creates in a private fork of the source.
function manifestEntry(op, { source, base: b, head: h }) {
  const { expected } = toCase(op);
  return { id: op.id, goal: 'traceability', source, base: b || `bench/${op.id}/base`, head: h || `bench/${op.id}/head`, pr_title: op.pr_title, pr_body: op.pr_body, expected,
    mutation: { operator: op.operator, triple: op.triple, edits: op.edits } };
}
function validateBenchManifest(m) {
  const errs = validateManifest(m);
  if (errs.length && !Array.isArray(m)) return errs;
  const bad = (e, msg) => errs.push(`${e && e.id}: ${msg}`);
  for (const e of Array.isArray(m) ? m : []) {
    const mu = e && e.mutation;
    if (!mu || !OPERATORS[mu.operator]) { bad(e, `mutation.operator must be one of ${Object.keys(OPERATORS).join(', ')}`); continue; }
    if (!mu.triple || mu.triple.confirmed !== true) bad(e, 'mutation.triple must be a confirmed triple');
    else validateTriple(mu.triple).forEach((x) => errs.push(x));
    for (const side of ['base', 'head']) {
      const es = mu.edits && mu.edits[side];
      if (!Array.isArray(es) || es.some((x) => typeof x.path !== 'string' || !isInt(x.line) || typeof x.before !== 'string' || typeof x.after !== 'string')) bad(e, `mutation.edits.${side} must be an array of {path, line, before, after}`);
    }
    if (mu.edits && Array.isArray(mu.edits.head) && !mu.edits.head.length) bad(e, 'mutation.edits.head must not be empty');
  }
  return errs;
}

// In a private clone of the source (dir, at entry.source.sha): create branches entry.base and entry.head holding the mutation. Never run it in this repo.
function materialize({ dir, entry }) {
  const rel = path.relative(path.resolve(__dirname, '..'), path.resolve(dir));
  if (!rel.startsWith('..') && !path.isAbsolute(rel)) throw new Error('materialize refuses to run inside this repository; use a clone of the source repo in a temp directory');
  const g = (...a) => execFileSync('git', ['-C', dir, '-c', 'user.name=specguard-bench', '-c', 'user.email=bench@example.invalid', ...a], { encoding: 'utf8' }).trim();
  const apply = (edits) => {
    const touched = uniq(edits.map((e) => e.path)), cur = Object.fromEntries(touched.map((p) => [p, fs.readFileSync(path.join(dir, p), 'utf8')]));
    for (const [p, text] of Object.entries(applyEdits(cur, edits))) fs.writeFileSync(path.join(dir, p), text);
  };
  g('switch', '-q', '-c', entry.base, entry.source.sha);
  if (entry.mutation.edits.base.length) { apply(entry.mutation.edits.base); g('commit', '-q', '-a', '-m', 'bench base'); }
  const baseSha = g('rev-parse', 'HEAD');
  g('switch', '-q', '-c', entry.head);
  apply(entry.mutation.edits.head);
  g('commit', '-q', '-a', '-m', 'bench head');
  return { baseSha, headSha: g('rev-parse', 'HEAD') };
}

// ---- (3) --mine ------------------------------------------------------------------------------------------------------------
// Per file: [{line, from, to, text}] for hunks where exactly one integer changed (removed lines vs added lines).
function numericChanges(diff) {
  const out = new Map();
  let file = null, hunk = null;
  const flush = () => {
    if (file && hunk) {
      const multiset = (ls) => ls.flatMap((l) => l.t.match(INT) || []).filter((v) => +v >= 2);
      const rem = multiset(hunk.r), add = multiset(hunk.a), cnt = (a, v) => a.filter((x) => x === v).length;
      const gone = uniq(rem).filter((v) => cnt(rem, v) > cnt(add, v)), came = uniq(add).filter((v) => cnt(add, v) > cnt(rem, v));
      if (gone.length === 1 && came.length === 1) {
        const l = hunk.a.find((x) => tokenRe(came[0]).test(x.t));
        if (l) out.get(file).push({ line: l.n, from: gone[0], to: came[0], text: l.t.trim().slice(0, 160) });
      }
    }
    hunk = null;
  };
  for (const l of diff.split('\n')) {
    let m;
    if (l.startsWith('diff --git ')) { flush(); file = null; } else if ((m = /^\+\+\+ b\/(.*)$/.exec(l))) { file = m[1]; if (!out.has(file)) out.set(file, []); }
    else if ((m = /^@@ -\S+ \+(\d+)/.exec(l))) { flush(); hunk = { r: [], a: [], at: +m[1] }; }
    else if (hunk && l.startsWith('+')) hunk.a.push({ n: hunk.at++, t: l.slice(1) });
    else if (hunk && l.startsWith('-')) hunk.r.push({ t: l.slice(1) });
  }
  flush();
  return out;
}
function mineHistory({ dir, commits = 200 }) {
  const g = (...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'pipe'] });
  const out = [];
  for (const row of g('log', '--no-merges', `-n${commits}`, '--format=%H %s').split('\n').filter(Boolean)) {
    const sha = row.slice(0, 40), subject = row.slice(41);
    const ch = numericChanges(g('show', '--no-color', '--no-ext-diff', '--no-renames', '-U0', '--format=', sha));
    if (ch.size > 40) continue;
    const kind = (p) => (DOC.test(p) ? 'doc' : pathKind(p)), all = [...ch].flatMap(([p, cs]) => cs.map((c) => ({ ...c, path: p })));
    for (const sp of all.filter((c) => kind(c.path) === 'doc' && !SKIP_NAME.test(c.path))) {
      const sites = all.filter((c) => kind(c.path) === 'src' && c.from === sp.from && c.to === sp.to);
      if (!sites.length) continue;
      let ref = '';
      try { ref = parseItems(sp.path, g('show', `${sha}:${sp.path}`)).find((i) => i.line <= sp.line && sp.line <= i.end)?.ref || ''; } catch { /* ref is best effort */ }
      out.push({ id: `mined-${sha.slice(0, 10)}-${sp.from}-${sp.to}`, kind: 'mined', commit: sha, subject, value: sp.from, new_value: sp.to,
        spec: { path: sp.path, ref, line: sp.line, text: sp.text }, sites: sites.slice(0, 3).map(({ path: p, line, text }) => ({ path: p, line, text })),
        tests: all.filter((c) => kind(c.path) === 'test' && c.from === sp.from && c.to === sp.to).slice(0, 3).map(({ path: p, line, text }) => ({ path: p, line, text })),
        confirmed: null, note: '' });
    }
  }
  return { schema: 'specguard-bench-proposals/1', triples: out };
}

// ---- CLI ---------------------------------------------------------------------------------------------------------------------
const USAGE = `Usage:
  node eval/mutate.js --propose DIR [--out F] [--top 8] [--max 50]     propose unconfirmed triples from a base snapshot
  node eval/mutate.js --mine DIR [--out F] [--commits 200]            propose from git history (spec + code change of the same number)
  node eval/mutate.js --emit PROPOSALS --dir DIR --source-url URL --source-sha SHA [--ops a,b] [--triple ID] [--manifest F] [--cases-dir D]
                                                                     build cases for CONFIRMED triples only (confirmed: true)
Operators: ${Object.keys(OPERATORS).join(', ')}`;
function main() {
  const { values: o } = require('node:util').parseArgs({ options: { propose: { type: 'string' }, mine: { type: 'string' }, emit: { type: 'string' }, dir: { type: 'string' }, out: { type: 'string' },
    top: { type: 'string', default: '8' }, max: { type: 'string', default: '50' }, commits: { type: 'string', default: '200' }, 'source-url': { type: 'string' }, 'source-sha': { type: 'string' },
    ops: { type: 'string' }, triple: { type: 'string' }, manifest: { type: 'string' }, 'cases-dir': { type: 'string' }, help: { type: 'boolean' } } });
  const save = (obj, f) => (f ? (fs.writeFileSync(f, JSON.stringify(obj, null, 2) + '\n'), console.log(`wrote ${f} (${obj.triples.length} unconfirmed triples)`)) : console.log(JSON.stringify(obj, null, 2)));
  if (o.propose) return save(proposeTriples({ dir: o.propose, top: +o.top, max: +o.max }), o.out);
  if (o.mine) return save(mineHistory({ dir: o.mine, commits: +o.commits }), o.out);
  if (!o.emit || !o.dir || !o['source-url'] || !o['source-sha']) return console.log(USAGE);
  const props = JSON.parse(fs.readFileSync(o.emit, 'utf8')), errs = validateProposals(props);
  if (errs.length) { console.error(errs.join('\n')); process.exit(1); }
  const triples = o.triple ? props.triples.filter((t) => t.id === o.triple) : props.triples;
  if (o.triple && !triples.length) { console.error(`no triple ${o.triple}`); process.exit(1); }
  if (o.triple) requireConfirmed(triples[0]);
  const files = walk(o.dir), r = mutateAll({ triples, files, operators: o.ops && o.ops.split(',') });
  const source = { url: o['source-url'], sha: o['source-sha'] }, entries = r.ops.map((op) => manifestEntry(op, { source }));
  if (!entries.length) { console.error(`no cases: ${r.unconfirmed} unconfirmed triple(s) skipped; set confirmed: true after human review`); process.exit(1); }
  const bad = validateBenchManifest(entries);
  if (bad.length) { console.error(bad.join('\n')); process.exit(1); }
  if (o['cases-dir']) r.ops.forEach((op) => writeCase(o['cases-dir'], op, files, { sandbox: true }));
  fs.writeFileSync(o.manifest || 'bench-manifest.json', JSON.stringify(entries, null, 2) + '\n');
  console.log(`${entries.length} cases; ${r.unconfirmed} unconfirmed triple(s) skipped; ${r.skipped.length} inapplicable operator(s)`);
  r.skipped.forEach((s) => console.log(`  skipped ${s.triple} ${s.operator}: ${s.reason}`));
}

if (require.main === module) { try { main(); } catch (e) { console.error(e.message); process.exit(1); } }
module.exports = { OPERATORS, nPrime, walk, proposeTriples, validateTriple, requireConfirmed, validateProposals, editLine, applyEdits, mutate, mutateAll, trees, toCase, writeCase,
  manifestEntry, validateBenchManifest, materialize, numericChanges, mineHistory };
