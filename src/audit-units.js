// Code-first inventory for the unit test gap scan (mode scan), no model, no repo code executed: which source files ("units") are most at risk and least protected by unit tests.
// Used by audit-collect.js. Pure functions over the tracked tree at HEAD plus ONE `git log` pass for churn and fix commits.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { fileCap } = require('./pack-cap');
const { isTestPath, testScope, lsTree, catBatch, makeClock } = require('./trace');
const { weakCandidates, TEST_START, GENERIC: LEAD_GENERIC } = require('./leads');
const { ASSERTION, SKIPPED } = require('./post');
const { mapTests, indexTests, testStem, near, key, noExt, publicDefs: baseDefs, GENERIC } = require('./test-map');

const DAYS = 180, FIX = /\b(fix|bug|hotfix|regression|revert)\b/i, MIN_LOC = 3;
const MAX_FILE = 512 * 1024, MAX_UNITS_READ = 6000, MAX_TESTS_READ = 4000, TEST_FILE = 512 * 1024, TEST_TOTAL = 48 * 1024 * 1024, BUDGET_MS = 40000;
const PER_UNIT_TESTS = 20, ROWS_KEPT = 100, LEADS = 3;
const CODE = /\.(?:[cm]?[jt]sx?|py|go|java|kt|cs|rb|php|rs|swift|scala)$/i;
// Not product code: examples, benchmarks, docs, generated or build output, config files, type declarations. ponytail: a name list; a repo that keeps product code in `examples/` narrows with scan_paths.
const NOT_UNIT = /(^|\/)(?:examples?|samples?|demos?|benchmarks?|bench|docs|integration|e2e|perf[\w-]*|dist|build|out|coverage|migrations?|node_modules|vendor|third_party|generated)\/|^scripts\/|\.d\.[cm]?ts$|(^|\/)(?:[\w.-]*\.config|\.[\w-]*rc|gulpfile|Gruntfile|Rakefile|setup|conftest|__init__)\.[a-z]+$|\.(?:min|bundle)\./i;
// Test infrastructure by name: a basename with a smoke/e2e/harness/runner/fixture/playwright/cypress token (runner-utils.js counts, testrunner.js does not), or a support/helpers dir under a test dir.
const TEST_INFRA = /(^|\/)[^/]*(?<![a-z0-9])(?:smoke|e2e|harness|runners?|fixtures?|playwright|cypress)(?![a-z0-9])[^/]*$|(^|\/)(?:tests?|specs?|__tests__|e2e)\/(?:[^/]+\/)*(?:support|helpers)\//i;
// First-level relative imports of a source text (JS/TS require, import, export-from, dynamic import), resolved against the tracked files -> blob shas.
// ponytail: one level only (a change two imports deep is not tracked), relative specifiers only (bare packages, Python and Go imports are ignored); the extension/index list is the Node/TS one.
const REL = /(?:\brequire\s*\(|\bfrom\s*|\bimport\s*\(?)\s*['"](\.\.?(?:\/[^'"\n]*)?)['"]/g, EXTS = ['', '.js', '.cjs', '.mjs', '.ts', '.tsx', '.jsx', '.json'];
function importPaths(from, src, shaOf) {
  const out = new Set();
  for (const m of src.matchAll(REL)) {
    const base = path.posix.join(path.posix.dirname(from), m[1]), stem = base.replace(/\.[cm]?jsx?$/, ''); // ./x.js in TS means x.ts
    const hit = [base, stem !== base && stem].filter((b) => b !== false).flatMap((b) => [...EXTS.map((e) => b + e), ...EXTS.slice(1).map((e) => path.posix.join(b, 'index' + e))]).find((p) => shaOf.has(p));
    if (hit) out.add(hit);
  }
  return [...out];
}
const importShas = (from, src, shaOf) => importPaths(from, src, shaOf).map((p) => `${p}:${shaOf.get(p)}`);
const sha8 = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 8);
const comment = (l) => /^\s*(?:\/\/|#|\*|\/\*|--)/.test(l);
const loc = (ls) => ls.filter((l) => l.trim() && !comment(l)).length;
const START = new RegExp(`${TEST_START.source}|(?<![.\\w$])x(?:it|test)\\s*\\(`); // leads.js's test start, plus xit/xtest (a disabled test is still a test)

// test-map's publicDefs plus `export const NAME =` (a constant or config object: no function, so the base list has no name for it).
const EXPORT_VAR = /^\s*export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/;
function publicDefs(file, ls) {
  const d = baseDefs(file, ls);
  if (!/\.[cm]?[jt]sx?$/i.test(file)) return d;
  const more = ls.filter((l) => !comment(l)).map((l) => (EXPORT_VAR.exec(l) || [])[1]).filter((n) => n && !d.names.includes(n));
  return more.length ? { ...d, names: [...d.names, ...new Set(more)] } : d;
}
// ponytail: a TS file with type/interface declarations and no runtime declaration has nothing to unit test; a line-start regex, not a parser.
const RUNTIME = /^\s*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:function|class|const|let|var|enum)\s|module\.exports|^\s*exports\./, TYPE_DECL = /^\s*(?:export\s+)?(?:declare\s+)?(?:interface|type)\s/;
const typeOnly = (file, ls) => /\.[cm]?tsx?$/i.test(file) && ls.some((l) => TYPE_DECL.test(l)) && !ls.some((l) => !comment(l) && RUNTIME.test(l));
const publicCount = (file, ls) => publicDefs(file, ls).count;
// Names a "no test references it" lead may be about: 4+ characters, not a generic word, not a type (no runtime value to test) or an UPPER_CASE constant. [{name, line}] with the line of the first code line that has the name (its definition).
const STOP = new Set('props state config options types data value values name test util utils helper helpers exports module'.split(' '));
// In a .tsx/.jsx unit PascalCase components and use* hooks come after the plain functions (a component renders, a function is what a unit test reaches); the lead list is capped, so the order decides what is named.
const UI = /^(?:[A-Z]|use[A-Z])/;
const leadNames = (names, ls, file = '') => names.filter((n) => n.length >= 4 && ![GENERIC, LEAD_GENERIC, STOP].some((s) => s.has(n.toLowerCase())))
  .map((name) => { const re = new RegExp(`(?<![\\w$])${name.replace(/\$/g, '\\$')}(?![\\w$])`); const decl = new RegExp(`\\b(?:def|function\\*?|class|const|let|var|func|type|interface|enum|struct|fn)\\s+(?:\\([^)]*\\)\\s*)?${name.replace(/\$/g, '\\$')}(?![\\w$])`); let i = ls.findIndex((l) => !comment(l) && decl.test(l)); if (i < 0) i = ls.findIndex((l) => !comment(l) && re.test(l)); return { name, line: i + 1, type: i >= 0 && /^\s*(?:export\s+)?(?:declare\s+)?(?:interface|type)\s/.test(ls[i]) }; }).filter((x) => x.line && !x.type && !/^[A-Z][A-Z0-9_]+$/.test(x.name)).map(({ name, line }) => ({ name, line })).sort((a, b) => /\.[jt]sx$/i.test(file) ? UI.test(a.name) - UI.test(b.name) : 0);

// Signals of one test file: tests, tests without an assertion, skipped or disabled tests, assertion lines, weak assertion lines (leads.js).
// ponytail: a test is a block from one test declaration to the next, an assertion is any line post.js's ASSERTION matches; an assertion inside a helper the test calls reads as no assertion.
function testSignals(src) {
  const ls = src.split('\n').slice(0, 6000).map((l) => l.replace(/\r$/, '')), starts = [];
  ls.forEach((l, i) => { if (l.length <= 400 && START.test(l)) starts.push(i); });
  const noAssert = starts.filter((s, k) => !ls.slice(s, starts[k + 1] ?? ls.length).some((l) => !comment(l) && ASSERTION.test(l))).length;
  return { tests: starts.length, noAssert, skipped: ls.filter((l) => SKIPPED.test(l)).length, asserts: ls.filter((l) => !comment(l) && ASSERTION.test(l)).length, weak: weakCandidates(src).map((w) => ({ line: w.line, what: w.what, text: w.text.slice(0, 100) })) };
}

// Boundary lead: a comparison against a named numeric constant (`x < LOW_SPACE_BYTES`) whose value no matched test uses. Static, from the unit text and the matched tests' words.
// ponytail: JS/TS only; the constant must be `const NAME = <digits and + - * / ( )>` (this file first, else the one repo definition); a literal or a dynamic bound is too noisy to claim.
const CMP = /([\w$.]+(?:\(\))?)\s+(<=|>=|<|>)\s+(-?[\w$.]+(?:\(\))?)/g, CONSTANT = /^(?:\w+\.)*([A-Z][A-Z0-9_]{2,})$/, CONST_DEF = /\bconst\s+([A-Z][A-Z0-9_]{2,})\s*(?::\s*\w+\s*)?=\s*([-\d_.*+/() ]+?)\s*(?:as const)?\s*;?\s*$/;
const FN = /^\s*(?:export\s+)?(?:async\s+)?(?:function\*?\s+([\w$]+)|(?:const|let)\s+([\w$]+)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[\w$]+)\s*(?::[^=]+)?=>|(?:public\s+|private\s+|protected\s+|static\s+|async\s+)*([\w$]+)\s*\([^)]*\)\s*(?::\s*[^{]+)?\{)/, NOT_FN = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'function']);
function arith(src) { // + - * / ( ) over numbers, no eval; NaN when it is anything else
  const t = src.replace(/(\d)_(?=\d)/g, '$1').match(/\d+(?:\.\d+)?|[-+*/()]|\S/g) || [];
  let i = 0;
  const unary = () => { const c = t[i++]; if (c === '-') return -unary(); if (c === '(') { const v = sum(); return t[i++] === ')' ? v : NaN; } return /^\d+(?:\.\d+)?$/.test(c) ? Number(c) : NaN; };
  const prod = () => { let v = unary(); while (t[i] === '*' || t[i] === '/') v = t[i++] === '*' ? v * unary() : v / unary(); return v; };
  const sum = () => { let v = prod(); while (t[i] === '+' || t[i] === '-') v = t[i++] === '+' ? v + prod() : v - prod(); return v; };
  const v = sum();
  return i === t.length && Number.isFinite(v) ? v : NaN;
}
function codeLines(ls) { // lines without comments and string contents
  let inB = false;
  return ls.map((l) => {
    let o = '', i = 0;
    while (i < l.length) {
      if (inB) { const e = l.indexOf('*/', i); if (e < 0) i = l.length; else { inB = false; i = e + 2; } continue; }
      const c = l[i];
      if (c === '/' && l[i + 1] === '*') { inB = true; i += 2; continue; }
      if (c === '/' && l[i + 1] === '/') break;
      if (c === "'" || c === '"' || c === '`') { let j = i + 1; while (j < l.length && l[j] !== c) j += l[j] === '\\' ? 2 : 1; o += '""'; i = j + 1; continue; }
      o += c; i++;
    }
    return o;
  });
}
// -> { consts: {NAME: value}, cmps: [{ line, name, fn }] } of one file; cmps only when asked (a unit)
function boundaryOf(file, ls, wantCmps) {
  const out = { consts: {}, cmps: [] };
  if (!/\.[cm]?[jt]sx?$/i.test(file)) return out;
  const cl = codeLines(ls);
  cl.forEach((l, i) => {
    const d = CONST_DEF.exec(l), v = d && /\d/.test(d[2]) ? arith(d[2]) : NaN;
    if (d && Number.isFinite(v)) out.consts[d[1]] = v;
    if (!wantCmps || /^\s*(import|export\s+(type|interface)|type\s|interface\s)/.test(l) || /\bextends\b.*</.test(l)) return;
    for (const m of l.matchAll(CMP)) {
      const c = CONSTANT.exec(m[1]) || CONSTANT.exec(m[3]);
      if (!c) continue;
      let fn = null; const ind = l.search(/\S/);
      for (let k = i; k >= 0 && !fn; k--) { const f = FN.exec(cl[k]); if (f && /(\{|=>|\()\s*$/.test(cl[k]) && cl[k].search(/\S/) < ind) { const n = f[1] || f[2] || f[3]; if (n && !NOT_FN.has(n)) fn = n; } }
      if (!out.cmps.some((x) => x.line === i + 1)) out.cmps.push({ line: i + 1, name: c[1], fn });
    }
  });
  return out;
}

// ONE git log pass: path -> { churn: commits touching it in the last DAYS days, fixes: of those, commits whose subject says fix/bug/hotfix/regression/revert }. A shallow clone has no history: null.
function history(cwd, now = Date.now()) {
  const git = (...a) => execFileSync('git', ['-c', 'core.quotepath=off', ...a], { cwd, encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'ignore'] });
  try { if (git('rev-parse', '--is-shallow-repository').trim() === 'true') return null; } catch { return null; }
  const out = new Map();
  let log = '';
  try { log = git('log', '--no-merges', '--no-renames', `--since=${new Date(now - DAYS * 864e5).toISOString()}`, '--name-only', '--format=%x00%s'); } catch { return null; }
  for (const c of log.split('\0').slice(1)) {
    const nl = c.indexOf('\n'), fix = FIX.test(nl < 0 ? c : c.slice(0, nl));
    for (const f of nl < 0 ? [] : c.slice(nl + 1).split('\n').filter(Boolean)) { const o = out.get(f) || { churn: 0, fixes: 0 }; o.churn++; if (fix) o.fixes++; out.set(f, o); }
  }
  return out;
}

// Risk = (1 + public) * log2(2 + loc / 50) * (1 + churn / 5 + fixes) * testFactor, rounded to 0.1. testFactor: 1.0 no matched test, 0.6 tests that cannot protect it (no assertion, all skipped,
// or at least half of the assertions weak), 0.3 tested. Public definitions are what a unit test can reach, size and churn say how likely a change is to break it, every fix commit is a bug that escaped once.
// ponytail: a heuristic ranking tuned by eye, not a defect predictor: it orders the work of one scan, it is never shown as a probability. Ceiling: no coupling, ownership or complexity; a generated file that escaped the name list ranks high.
const risk = ({ pub, loc: n, churn, fixes, factor }) => Math.round((1 + pub) * Math.log2(2 + n / 50) * (1 + churn / 5 + fixes) * factor * 10) / 10;
const factorOf = (tests, s) => (!tests.length ? 1 : s.asserts === 0 || (s.tests > 0 && s.skipped >= s.tests) || s.weak.length * 2 >= s.asserts ? 0.6 : 0.3);

// Which units this run reviews (at most cap). rows: sorted by risk, highest first. prior = the scan issue's state { head, blocks: [{ cid, status, runs, at: { date } }] } (unit id = cid); null = the riskiest first.
//   c confirming: a unit whose findings were seen in one run only; s stale: the unit or its matched tests changed since it was reviewed (the state's version differs);
//   n never reviewed (riskiest first); o everything else, least recently reviewed first (ties: riskiest first).
// ponytail: verLegacy (ver before first-level imports were folded in) is a temporary migration: a stored legacy ver is not a change. Drop it after one full rotation has re-reviewed every unit.
const sameVer = (v, r) => v === r.ver || v === r.verLegacy;
const staleUnit = (r, prior) => { const v = prior && prior.versions && prior.versions.uv[r.id]; return !!v && !sameVer(v, r); };
// A unit too large for one model call is reviewed in parts (review F07): fixed line windows of about PART_BYTES, one per run, the cursor in the state (uc: [next part, part count]).
// A stateless run (no cursor, so it would never get past part 1) plans every part as its own item (r.partK, see inventory allParts).
// -> { k, n, a, b } (part k of n, 0-based, lines a-b) or null when the file fits whole. A unit in progress is picked again until its last part.
const PART_BYTES = 40 * 1024;
// Claude api engine only (the one engine with a context pack; the others read files themselves): a part, as shown line-numbered (6 bytes a line), must fit the per-file cap and a 1/N share of the pack
// (claude-api.js contextPack adds every unit file before any test); 5/6 leaves slack for the block markup and rule files.
// shortcut: parts are equal line counts, so a part of unusually long lines can exceed the average; the pack then lists it as cut.
const partBytes = (packBytes, units) => (packBytes ? { max: Math.min(PART_BYTES, Math.max(4096, Math.floor(Math.min(fileCap(packBytes), packBytes / units) * 5 / 6))), pre: 4 } : { max: PART_BYTES, pre: 0 }); // pre: minimum width of the line number in the pack's prefix (0 = no prefix)
const shownOf = (r, bytes) => r.size + (bytes.pre && Math.max(bytes.pre, String(r.lines).length) + 2) * r.lines; // prefix: the number, padded, plus 2
const partOf = (r, prior, bytes = partBytes(0)) => {
  const shown = shownOf(r, bytes);
  if (!(shown > bytes.max)) return null;
  const n = Math.ceil(shown / bytes.max), per = Math.ceil(r.lines / n), v = prior && prior.versions, at = v && v.uc && v.uv && sameVer(v.uv[r.id], r) ? v.uc[r.id] : null, k = r.partK ?? (Array.isArray(at) && at[1] === n && at[0] > 0 && at[0] < n ? at[0] : 0); // the cursor [next part, part count] counts only for the same content version and the same layout; otherwise the unit restarts at part 0
  return { k, n, a: k * per + 1, b: Math.min(r.lines, (k + 1) * per) };
};
const inProgress = (r, prior, bytes) => { const p = partOf(r, prior, bytes); return !!p && p.k > 0; };
// room (claude api engine): { total, cost(r) }: a unit is taken only while its whole context (part, matched tests) still fits in what is left of a call's pack, so every call finishes at least one unit's context (review F23).
// rooms = how many calls (packs) the run makes, each holding at most cap units: a unit goes into the first room it fits. A unit whose tests do not fit a whole pack ("trimmed") keeps the tests that fit in half a room (room.trim: r.packTests),
// so it cannot starve the rest. over = the units whose own part never fits.
const partId = (r) => (r.partK === undefined ? r.id : `${r.id}:${r.partK + 1}`); // a part of a stateless run is told apart from its unit's other parts
function pick(rows, cap, prior, bytes, room = null, rooms = 1) {
  const kind = new Map(), picked = [], over = [], trimmed = [], slots = [], roomOf = new Map(), noRoom = [], max = cap * rooms; // noRoom: units refused because every call's room was taken (the budget), not because of cap
  const open = (c, id) => slots.find((s) => s.n < cap && c <= s.left && !s.ids.has(id)), fresh = (left) => { const s = { left, n: 0, ids: new Set() }; slots.push(s); return s; };
  const afford = (r) => {
    if (!room) return true;
    let c = room.cost(r), t = null;
    if (c > room.total) { // the tests do not fit a whole pack: the unit is reviewed with the tests that fit in half a room and recorded unsure (the pack lists the rest as cut)
      if (room.cost(r, false) > room.total) { if (!over.some((o) => o.id === r.id)) over.push(r); return false; }
      t = room.trim(r); c = t.cost;
    }
    const s = open(c, r.id) || (slots.length < rooms && fresh(room.total));
    if (!s) { noRoom.push(r); return false; }
    if (t) { r.packTests = t.tests; r.weakCut = new Set(r.tests.filter((x, i) => i >= (r.strong ?? Infinity) && !t.tests.includes(x))); if (r.tests.length - r.weakCut.size > t.tests.length) trimmed.push(r); } // ponytail: name-only matches that do not fit are left out of the unit's list instead of cutting it (else every big-test repo is mostly forced); ceiling: a gap only such a test would cover is reported missing
    s.left -= c; s.n++; s.ids.add(r.id); roomOf.set(partId(r), slots.indexOf(s));
    return true;
  };
  const out = (tally) => ({ picked, kind, over, trimmed, tally, roomOf, noRoom, rooms: slots.length });
  if (!prior) { for (const r of rows) if (picked.length < max && afford(r)) { kind.set(r.id, 'n'); picked.push(r); } return out({ c: 0, s: 0, n: picked.length, o: 0 }); }
  const st = new Map(prior.blocks.map((b) => [b.cid, b])), when = (r) => (st.get(r.id).at || {}).date || '';
  const take = (list, k) => { for (const r of list) if (picked.length < max && !kind.has(r.id) && afford(r)) { kind.set(r.id, k); picked.push(r); } };
  take(rows.filter((r) => st.has(r.id) && ((st.get(r.id).status === 'gap' && st.get(r.id).runs === 1) || inProgress(r, prior, bytes))), 'c'); // confirming, or continuing a unit reviewed in parts
  take(rows.filter((r) => st.has(r.id) && staleUnit(r, prior)), 's');
  take(rows.filter((r) => !st.has(r.id)), 'n');
  take(rows.filter((r) => st.has(r.id)).sort((a, b) => (when(a) < when(b) ? -1 : when(a) > when(b) ? 1 : 0)), 'o'); // stable: ties keep the risk order
  const tally = { c: 0, s: 0, n: 0, o: 0 };
  for (const k of kind.values()) tally[k]++;
  return out(tally);
}

// A test file's directory relates to a unit's: the same folder, below it, or the unit's folder mirrored under a test/ segment (pkg/test/x for pkg/x).
const related = (unit, t) => { const d = path.posix.dirname(unit), td = path.posix.dirname(t); return td === d || td.startsWith(d + '/') || td.split('/').filter((x) => !/^(?:tests?|__tests__|specs?)$/.test(x)).join('/') === d; };
const plural = (k) => k.replace(/(?<=[sxz]|ch|sh)es$|(?<!s)s$/, ''); // listeners -> listener, classes -> class
const fold = (p) => noExt(p).replace(/^tests?[_-]/i, '').replace(/[._-]?(?:tests?|spec)$/i, '').toLowerCase().split(/[-_.]+/).map(plural).join(''); // a file name with every segment singular: both sides of a comparison are folded
// The unit's tests, best evidence first, at most PER_UNIT_TESTS: same name > imports the unit > plural-folded name (related folder only) > file name or calls of its public names > class or dotted/kebab stem as a token > stem as a word > same folder.
// base: mapTests' own tiers (uncapped), whose reasons say which tier a test came from.
function rankTests(u, base, { importers, token, classHit, classOf, folded }) {
  const stem = noExt(u.path), want = key(stem), folded1 = fold(u.path), tiers = [[], [], [], [], [], [], []], seen = new Set();
  const add = (i, ts) => { for (const t of ts) if (!seen.has(t)) { seen.add(t); tiers[i].push(t); } };
  const closest = (ts) => ts.slice().sort((a, b) => near(u.path, b) - near(u.path, a) || (a < b ? -1 : 1));
  const of = (re) => [...base].filter(([, why]) => re.test(why)).map(([t]) => t);
  const same = of(/^same name/), imp = importers.get(u.path) || [], mine = same.filter((t) => related(u.path, t) || imp.includes(t));
  // ponytail: a generic stem (index, handler, types) names a test in every folder; once some same-name test sits in the unit's own tree or imports it, the others are other units' tests and are dropped (they fill the 20 and the pack and get the unit's tests cut). Ceiling: a unit tested from a mirrored tree outside related() loses a same-name test when another sits in its tree.
  if (mine.length && mine.length < same.length) for (const t of same) if (!mine.includes(t)) seen.add(t);
  add(0, same);
  add(1, closest(imp));
  if (folded1.length >= 4) add(2, closest((folded.get(folded1) || []).filter((t) => testStem(t) !== want && related(u.path, t))));
  add(3, of(/^(?:file name has|calls) /));
  add(4, closest([...(token.get(stem) || []), ...(classHit.get(classOf.get(u.path)) || [])]));
  add(5, of(/^mentions /));
  add(6, of(/^same directory/));
  const tests = tiers.flat().slice(0, PER_UNIT_TESTS);
  return { tests, strong: Math.min(tests.length, tiers.slice(0, 5).reduce((n, t) => n + t.length, 0)) }; // the first `strong` carry the unit's name or import it; the rest only mention its name or sit in its folder
}

// extra: more unit calls for the engine to admit at run time (claude api engine, stateless run): the items the planned calls left out, in the same breadth-first order, packed into that many more rooms. allParts: a stateless run plans every part of a unit reviewed in parts; price { usd, budget, max, reserve }: one unit call's worst case, max_budget_usd, the most calls a run makes, and what the document block calls take of the budget (for the budget hint). files: lsTree entries at head; skip(path): not evidence (documents, data, vendored, rule files); scope: scan_paths predicate or null; testPaths: test_paths. -> { rows, picked, ... } (rows by risk).
function inventory({ cwd, head, files = lsTree(cwd, head), skip = () => false, scope = null, testPaths = '', maxUnits = 12, rooms = 1, prior = null, now = Date.now(), budgetMs = BUDGET_MS, packBytes = 0, maxRead = MAX_UNITS_READ, allParts = false, price = null, extra = 0 }) {
  const dl = makeClock(budgetMs), limits = [], tscope = testScope(testPaths);
  const inScope = files.filter((e) => !skip(e.path)); // read repo-wide: scope only picks the units, their tests may live outside it
  const isTest = (p) => (tscope ? tscope(p) : isTestPath(p));
  const testEntries = inScope.filter((e) => isTest(e.path) && CODE.test(e.path)), tests = testEntries.map((e) => e.path).sort();
  const elig = inScope.filter((e) => (!scope || scope(e.path)) && !isTest(e.path) && !isTestPath(e.path) && CODE.test(e.path) && !TEST_INFRA.test(e.path));
  let cand = elig.filter((e) => !NOT_UNIT.test(e.path)).sort((a, b) => (a.path < b.path ? -1 : 1));
  const notUnit = scope ? elig.filter((e) => NOT_UNIT.test(e.path)) : []; // in scan_paths but dropped by the default non-unit rule (scripts/, migrations/, examples/, ...): still not units, but counted and named, never silent
  if (notUnit.length) limits.push(`${notUnit.length} source file(s) in scan_paths were not reviewed (default non-unit paths such as scripts/, migrations/, examples/): ${notUnit.slice(0, 3).map((e) => e.path).join(', ')}${notUnit.length > 3 ? ', ...' : ''}`);
  const big = cand.filter((e) => e.size > MAX_FILE); // the largest files are often the most complex: say so, never drop them silently
  if (big.length) limits.push(`${big.length} source file(s) over 512 KiB were not inventoried: ${big.slice(0, 3).map((e) => e.path).join(', ')}${big.length > 3 ? ', ...' : ''}`);
  cand = cand.filter((e) => e.size <= MAX_FILE);
  const capped = Math.max(0, cand.length - maxRead); // files past the read cap, never reached
  if (cand.length > maxRead) { limits.push(`only the first ${maxRead} of ${cand.length} source files were inventoried (narrow with scan_paths)`); cand = cand.slice(0, maxRead); }
  const units = [], srcImports = new Map(), importers = new Map(); // srcImports: path -> the relative imports of its text (units and read tests); importers: unit path -> the read tests that import it
  const consts = new Map(), anyConst = new Map(); // numeric constants per file; any name -> value when the repo has one definition (NaN: two)
  const shaOf = new Map(files.map((e) => [e.path, e.sha]));
  let reached = 0; // reached: files whose chunk was read before the time budget ended
  for (let i = 0; i < cand.length && !dl.over(); i += 300) {
    const part = cand.slice(i, i + 300), bufs = catBatch(cwd, part.map((e) => e.sha));
    reached = Math.min(cand.length, i + 300);
    part.forEach((e, k) => {
      if (!bufs[k] || bufs[k].subarray(0, 8192).includes(0)) return;
      const ls = bufs[k].toString('utf8').split('\n').map((l) => l.replace(/\r$/, ''));
      const n = loc(ls), bd = boundaryOf(e.path, ls, n >= MIN_LOC);
      if (Object.keys(bd.consts).length) { consts.set(e.path, bd.consts); for (const [k, v] of Object.entries(bd.consts)) anyConst.set(k, anyConst.has(k) && anyConst.get(k) !== v ? NaN : v); }
      if (n >= MIN_LOC && !typeOnly(e.path, ls)) { srcImports.set(e.path, importShas(e.path, ls.join('\n'), shaOf)); const d = publicDefs(e.path, ls); units.push({ id: sha8(e.path), path: e.path, loc: n, pub: d.count, names: d.names, defs: leadNames(d.names, ls, e.path), cjsOnly: d.cjsOnly, size: bufs[k].length, lines: ls.length - (ls[ls.length - 1] === '' ? 1 : 0), cmps: bd.cmps }); }
    });
  }
  if (dl.over() && units.length < cand.length) limits.push(`the inventory time budget ended after ${units.length} of ${cand.length} source files`);
  // tests: text read once (capped); words that are a unit's file stem indexed for the "mentions" tier, calls of a unit's public names for the "calls" tier
  const stems = new Set(units.map((u) => noExt(u.path)).filter((s) => s.length >= 3 && !GENERIC.has(s.toLowerCase()) && /^[\w$]+$/.test(s)));
  // dotted or kebab stems (multer.constants, listener-metadata-explorer) match only as a whole path-like token; a class named like the PascalCase stem (ListenerMetadataExplorer) as a word
  const pascal = (p) => noExt(p).split(/[-_.]+/).map((x) => x.charAt(0).toUpperCase() + x.slice(1)).join('');
  const pathStems = new Set(units.map((u) => noExt(u.path)).filter((s) => s.length >= 3 && !GENERIC.has(s.toLowerCase()) && /^[\w$][\w$.-]*$/.test(s) && !/^[\w$]+$/.test(s)));
  const classOf = new Map(units.filter((u) => /[-_.]/.test(noExt(u.path)) && u.names.includes(pascal(u.path))).map((u) => [u.path, pascal(u.path)])), classes = new Set(classOf.values());
  const names = new Set(units.flatMap((u) => u.names)), sig = new Map(), mention = new Map(), called = new Map(), token = new Map(), classHit = new Map();
  const put = (m, k, v) => { if (!m.has(k)) m.set(k, []); m.get(k).push(v); };
  const want = new Set(units.flatMap((u) => u.defs.map((d) => d.name))), refd = new Set(); // refd: lead names some read test file mentions as a word
  const bw = new Set(), bn = new Set(), bt = new Map(); // boundary lead: words and numbers of interest, and what each read test file has of them
  for (const u of units) u.cmps = u.cmps.filter((c) => { c.v = (consts.get(u.path) || {})[c.name] ?? anyConst.get(c.name); if (!Number.isFinite(c.v)) return false; bw.add(c.name); if (c.fn) bw.add(c.fn); bn.add(String(c.v)); return true; });
  let bytes = 0, readN = 0;
  const readable = testEntries.filter((e) => e.size <= TEST_FILE).sort((a, b) => (a.path < b.path ? -1 : 1));
  for (let i = 0; i < readable.length && readN < MAX_TESTS_READ && bytes < TEST_TOTAL && !dl.over(); i += 300) {
    const part = readable.slice(i, i + 300), bufs = catBatch(cwd, part.map((e) => e.sha));
    part.forEach((e, k) => {
      if (!bufs[k] || readN >= MAX_TESTS_READ || bufs[k].subarray(0, 8192).includes(0)) return;
      readN++; bytes += bufs[k].length;
      const src = bufs[k].toString('utf8');
      sig.set(e.path, testSignals(src));
      if (bw.size) { // an import line is not a use
        const t = src.replace(/\bimport\s+[^;'"]*?\bfrom\s*['"][^'"]*['"]/g, '').split('\n').filter((l) => !/^\s*(import\b|.*\brequire\(|export\s.*\bfrom\b)/.test(l)).join('\n').replace(/(\d)_(?=\d)/g, '$1'), b = { w: new Set(), p: new Set(), n: new Set() };
        for (const m of t.matchAll(/([A-Za-z_$][\w$]*)(\s*[-+*/])?/g)) if (bw.has(m[1])) { b.w.add(m[1]); if (!m[2]) b.p.add(m[1]); }
        for (const m of t.matchAll(/(?<![\w.])(-?)(\d+(?:\.\d+)?)(?![\w.])/g)) { const neg = m[1] && !/[\w$)\]]$/.test(t.slice(0, m.index).trimEnd()), n = String(neg ? -m[2] : +m[2]); if (bn.has(n)) b.n.add(n); } // a minus is a sign only when unary (`f(-10)`, `= -10`), not `x-10`; same normal form as String(c.v)
        bt.set(e.path, b);
      } const ip = importPaths(e.path, src, shaOf); srcImports.set(e.path, ip.map((p) => `${p}:${shaOf.get(p)}`)); for (const p of ip) put(importers, p, e.path);
      for (const w of new Set(src.match(/[A-Za-z_$][\w$]*/g) || [])) { if (want.has(w)) refd.add(w); if (stems.has(w)) put(mention, w, e.path); if (classes.has(w)) put(classHit, w, e.path); }
      if (pathStems.size) for (const c of new Set(src.match(/[\w$][\w$.-]*/g) || [])) { const w = c.replace(/[.-]+$/, ''); for (const k of new Set([w, w.replace(/\.[a-z]{1,4}$/i, '')])) if (pathStems.has(k)) put(token, k, e.path); }
      for (const w of new Set(src.match(/[A-Za-z_$][\w$]*(?=\s*\()/g) || [])) if (names.has(w)) { if (!called.has(w)) called.set(w, []); called.get(w).push(e.path); }
    });
  }
  const unread = tests.length - sig.size;
  if (unread > 0) limits.push(`${unread} of ${tests.length} test files were not read (over the size, count or time limit): their assertions are unknown, and a unit they alone cover may be missed, and no "no test references it" lead is made`);
  const hist = history(cwd, now);
  if (!hist) limits.push('no git history (shallow clone? use fetch-depth: 0): churn and fix commits are not used in the ranking');
  const notReachedTime = cand.length - reached;
  const none = { tests: 0, noAssert: 0, skipped: 0, asserts: 0, weak: [] };
  const index = indexTests(tests), folded = new Map();
  for (const t of tests) put(folded, fold(t), t);
  const rows = units.map((u) => {
    const { tests: got, strong } = rankTests(u, mapTests(u.path, { tests, index, names: u.names, calls: (n) => called.get(n) || [], mentions: (s) => mention.get(s) || [], per: Infinity }), { importers, token, classHit, classOf, folded });
    const real = got.filter((t) => !sig.has(t) || sig.get(t).tests > 0); // a matched file that declares no test (a fixture) is a match, not evidence
    const ss = real.map((t) => sig.get(t) || none), sum = (f) => ss.reduce((a, s) => a + f(s), 0);
    const s = { tests: sum((x) => x.tests), noAssert: sum((x) => x.noAssert), skipped: sum((x) => x.skipped), asserts: sum((x) => x.asserts), weak: real.flatMap((t) => (sig.get(t) || none).weak.map((w) => ({ ...w, path: t }))), unread: real.filter((t) => !sig.has(t)).length };
    const h = (hist && hist.get(u.path)) || { churn: 0, fixes: 0 }, factor = factorOf(real, real.some((t) => !sig.has(t)) ? { ...s, asserts: Math.max(s.asserts, 1) } : s); // a test file that was not read is assumed to assert
    const why = [!got.length && 'no test', s.skipped && `${s.skipped} skipped test${s.skipped === 1 ? '' : 's'}`, s.noAssert && `${s.noAssert} test${s.noAssert === 1 ? '' : 's'} without an assertion`, s.weak.length && `${s.weak.length} weak assertion${s.weak.length === 1 ? '' : 's'}`,
      h.fixes && `${h.fixes} fix commit${h.fixes === 1 ? '' : 's'} in ${DAYS} days`, !h.fixes && h.churn >= 3 && `${h.churn} commits in ${DAYS} days`].filter(Boolean).join(', ') || `${u.pub} public definition${u.pub === 1 ? '' : 's'}`;
    const seen = [u.path, ...got].map((p) => `${p}:${shaOf.get(p) || ''}`).join('\n'), deps = [...new Set([u.path, ...got].flatMap((p) => srcImports.get(p) || []))].sort().join('\n');
    const verLegacy = sha8(seen), ver = deps ? sha8(`${seen}\n${deps}`) : verLegacy; // what a review of this unit saw: its blob, its matched tests' blobs, and the blobs they import (helpers, fixtures, the unit's own dependencies)
    // ponytail: "no test references it" is only claimed when every test file was read (an unread one may name it) and the unit has matched tests (else test_evidence_not_found already says it); an in-memory word match, so a name in a comment counts as a reference
    const unref = unread || !got.length ? [] : u.defs.filter((d) => !refd.has(d.name) && !(u.cjsOnly || []).includes(d.name)); // ponytail: an untested CommonJS module's exports are not flagged (internal lib files are tested through the public API); upgrade: count a name as referenced when a module a test imports, transitively, requires it
    // a comparison in a function the tests call (else it is a missing test, which has its own signal) whose constant no matched test uses by name or by value
    const boundary = unread || !got.length ? [] : u.cmps.filter((c) => (!c.fn || got.some((t) => bt.get(t)?.w.has(c.fn))) && !got.some((t) => bt.get(t)?.p.has(c.name) || bt.get(t)?.n.has(String(c.v)))).map((c) => ({ line: c.line, name: c.name, value: c.v }));
    return { ...u, strong, unref, boundary, churn: h.churn, fixes: h.fixes, tests: got, factor, signals: s, why, ver, verLegacy, score: risk({ ...u, ...h, factor }) };
  }).sort((a, b) => b.score - a.score || (a.path < b.path ? -1 : 1));
  const size = partBytes(packBytes, maxUnits), tsize = new Map(testEntries.map((e) => [e.path, e.size]));
  // A test over the per-file cap is shown by the pack as slices around the names the unit defines (claude-api.js slices); when those hold every matching block the pack uses their size, not the whole file's. p: the unit's part or null.
  // ponytail: priced from the unit's own names; a test shared by units of one call is sliced for all their names, which the per-unit sums cover (merged windows are smaller than the sum). Ceiling: a name another unit adds can make the slice incomplete, the pack then lists it cut.
  const lineCache = new Map(), sliceCost = new Map();
  const linesOf = (p) => { if (!lineCache.has(p)) { const b = shaOf.has(p) ? catBatch(cwd, [shaOf.get(p)])[0] : null; lineCache.set(p, b && !b.subarray(0, 8192).includes(0) ? b.toString('utf8').replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n') : null); } return lineCache.get(p); };
  const tcost = (t, r, p) => {
    const sz = tsize.get(t) || 0, whole = Math.ceil(Math.min(sz, fileCap(packBytes)) * 1.15) + 300;
    if (!packBytes || sz * 1.15 <= fileCap(packBytes)) return whole;
    const k = `${r.id}:${p ? p.k : ''}:${t}`;
    if (!sliceCost.has(k)) {
      const api = require('./engines/claude-api'), u = linesOf(r.path), x = linesOf(t), syms = u && x ? api.unitSyms(p ? u.slice(p.a - 1, p.b) : u) : [], sl = syms.length && !syms.capped ? api.slices(x, syms, fileCap(packBytes) - 300) : null;
      sliceCost.set(k, sl && sl.complete ? Buffer.byteLength(sl.text) + 300 : Infinity); // incomplete (a block cut or dropped): costed as today
    }
    return Math.min(whole, sliceCost.get(k));
  };
  // what a unit costs in the pack: its part (or whole file) and its matched tests, line-numbered (about 15% more) plus a block header each; 90% of the pack, the rest is markup and neighbours
  const room = packBytes ? { total: Math.floor(packBytes * 0.9), cost: (r, withTests = true) => { const p = partOf(r, prior, size); return Math.ceil(shownOf(r, size) / (p ? p.n : 1)) + 300 + (withTests ? r.tests : []).reduce((n, t) => n + tcost(t, r, p), 0); } } : null;
  if (room) room.trim = (r) => { const p = partOf(r, prior, size), c = (t) => tcost(t, r, p); let left = Math.min(Math.floor(room.total / 2), room.total - room.cost(r, false)); const tests = r.tests.filter((t) => c(t) <= left && (left -= c(t), true)); return { tests, cost: room.cost(r, false) + tests.reduce((n, t) => n + c(t), 0) }; }; // a trimmed unit's tests get at most half a room, in priority order
  const calls = room ? Math.max(1, rooms) : 1; // rooms: the run's unit calls (claude api engine); maxUnits applies to each
  const items = room && allParts && !prior ? rows.flatMap((r) => { const p = partOf(r, null, size); return p ? Array.from({ length: p.n }, (_, k) => ({ ...r, partK: k })) : [r]; }).sort((a, b) => (a.partK || 0) - (b.partK || 0)) : rows; // one item per part of a unit reviewed in parts; every unit's first part comes before any second part, so a unit is read before another is read twice
  let sel = pick(items, maxUnits, prior, size, room, calls);
  let forced = []; // nothing fits: the fallback ignores the part cursors, so a unit unfinished in parts does not take the single place again
  if (room && !sel.picked.length && rows.length) { sel = pick(rows, 1, prior && { ...prior, versions: { ...prior.versions, uc: {} } }, size); forced = sel.picked.map((r) => r.id); limits.push('no unit fits the context pack with its matched tests; the scan reviews the first one and its tests may be cut; it is recorded as reviewed in part (unsure), so the next run moves on'); }
  let ext = null; // ponytail: extras only for a stateless run (it plans every part; a rotation defers on purpose)
  if (extra > 0 && room && allParts && !prior && sel.picked.length && !forced.length) { const planned = new Set(sel.picked); ext = pick(items.filter((r) => !planned.has(r)), maxUnits, null, size, room, extra); if (!ext.picked.length) ext = null; }
  const pickedAll = ext ? [...sel.picked, ...ext.picked] : sel.picked;
  if (sel.over.length) limits.push(`${sel.over.length} unit${sel.over.length === 1 ? '' : 's'} (${sel.over.slice(0, 3).map((r) => r.path).join(', ')}${sel.over.length > 3 ? ', ...' : ''}) cannot fit the context pack with their matched tests and ${sel.over.length === 1 ? 'is' : 'are'} not reviewed`);
  const uniq = (rs) => [...new Map(rs.map((r) => [r.id, r])).values()], trimmed = uniq([...sel.trimmed, ...(ext ? ext.trimmed : [])].filter((r) => pickedAll.includes(r)));
  const got = new Set(pickedAll.map((r) => r.id)), noRoom = (ext || sel).noRoom, partsLeft = items.filter((r) => r.partK !== undefined && got.has(r.id) && !pickedAll.includes(r) && !sel.over.some((o) => o.id === r.id)); // a unit read in some parts but not all: none of this run's calls had room for the rest (a unit not read at all is in the budget hint)
  if (partsLeft.length) limits.push(`${partsLeft.length} unit part${partsLeft.length === 1 ? '' : 's'} not reached (${partsLeft.some((r) => noRoom.includes(r)) ? 'budget' : 'max_units'}): ${partsLeft.slice(0, 3).map((r) => `${r.path} part ${r.partK + 1} of ${partOf(r, null, size).n}`).join(', ')}${partsLeft.length > 3 ? ', ...' : ''}`);
  if (trimmed.length) limits.push(`${trimmed.length} unit${trimmed.length === 1 ? '' : 's'} (${trimmed.slice(0, 3).map((r) => r.path).join(', ')}${trimmed.length > 3 ? ', ...' : ''}) ${trimmed.length === 1 ? "has" : "have"} matched tests that cannot fit the context pack whole: reviewed with the tests that fit, recorded unsure`);
  const chosen = new Set(pickedAll.map((r) => r.id));
  const left = uniq(noRoom.filter((r) => !chosen.has(r.id))); // units no call had room for
  let hint = null;
  if (price && left.length) { const need = pick(items, maxUnits, null, size, room, Infinity).rooms; hint = { left: left.length, ...(ext && { extra: ext.picked.length }), calls, need, usd: Math.ceil((need * price.usd + (price.reserve || 0)) * 100) / 100, budget: price.budget, max: price.max, runs: Math.ceil(need / calls) }; }
  const distinct = (rs) => [...new Set(rs.flatMap((r) => r.tests))].map((t) => sig.get(t) || none);
  const tot = (ss) => ({ skipped_tests: ss.reduce((a, s) => a + s.skipped, 0), tests_without_assertion: ss.reduce((a, s) => a + s.noAssert, 0), weak_assertions: ss.reduce((a, s) => a + s.weak.length, 0) });
  const known = new Set(prior ? prior.blocks.map((b) => b.cid) : []), reviewed = new Set([...rows.filter((r) => known.has(r.id)).map((r) => r.id), ...chosen]);
  const rotation = { rotate: !!prior, picked: chosen.size, confirming: sel.tally.c, changed: sel.tally.s, new: sel.tally.n, oldest: sel.tally.o, reviewed: reviewed.size, total: rows.length, run: Math.max(1, Math.ceil(reviewed.size / (maxUnits * calls))), runs: Math.max(1, Math.ceil(rows.length / (maxUnits * calls))) };
  const date = (r) => (prior && (prior.blocks.find((b) => b.cid === r.id) || {}).at || {}).date;
  for (const r of pickedAll) { const p = partOf(r, prior, size); if (p) r.part = p; if (room) r.tneed = (r.packTests || r.tests).reduce((n, t) => n + tcost(t, r, p), 0); }
  const unitRooms = []; // the picked unit ids per call, in risk order
  for (const r of sel.picked) (unitRooms[(sel.roomOf && sel.roomOf.get(partId(r))) || 0] ||= []).push(partId(r));
  const extraRooms = []; // the picked unit parts of the extra calls, in the order the engine admits them
  if (ext) for (const r of ext.picked) (extraRooms[ext.roomOf.get(partId(r)) || 0] ||= []).push(partId(r));
  return { rows, picked: pickedAll, unitRooms: unitRooms.filter(Boolean), extraRooms: extraRooms.filter(Boolean), extraKeys: ext ? ext.picked.map(partId) : [], unitCalls: calls, forced, carried: rows.filter((r) => known.has(r.id) && !chosen.has(r.id)), limitations: limits, shallow: !hist, rotation, hint, allParts: items !== rows, partsLeftN: partsLeft.length, partsLeftBy: partsLeft.reduce((m, r) => ({ ...m, [r.path]: (m[r.path] || 0) + 1 }), {}), partsLeft: partsLeft.slice(0, 10).map((r) => ({ path: r.path, part: r.partK + 1, of: partOf(r, null, size).n })),
    totals: { eligible: rows.length + big.length + capped + notReachedTime, not_reached: capped + notReachedTime, not_reached_cap: capped, not_reached_time: notReachedTime, units: rows.length, not_inventoried: big.length, not_unit: notUnit.length, with_tests: rows.filter((r) => r.tests.length).length, without_tests: rows.filter((r) => !r.tests.length).length, ...tot(distinct(rows)), selected: { units: chosen.size, without_tests: pickedAll.filter((r) => !r.tests.length).length, ...tot(distinct(pickedAll)) } },
    stale: rows.filter((r) => known.has(r.id) && !chosen.has(r.id) && staleUnit(r, prior)).map((r) => r.id),
    review: (r) => (chosen.has(r.id) ? 'this run' : known.has(r.id) ? `reviewed ${date(r) || 'earlier'}${staleUnit(r, prior) ? '; changed since, due again' : ''}` : 'not yet reviewed') };
}

// audit-units.txt (id, path, risk, why, matched tests, leads: tab separated), audit-units-carried.txt (id, path: units the state knows that this run does not review), audit-inventory.json.
function write(ctx, head, maxUnits, inv) {
  const picked = new Set(inv.picked.map((r) => r.id)), w = (n, s) => fs.writeFileSync(path.join(ctx, n), s), flat = (s) => String(s).replace(/[\t\r\n]+/g, ' ');
  // the pack gives each unit's tests an equal share of what is left, in this order: the units with the least test bytes go first, so what they leave over goes to the big ones (risk order starved the big ones early in a call)
  w('audit-units.txt', [...inv.picked].sort((a, b) => (a.tneed || 0) - (b.tneed || 0)).map((r) => [r.id, r.path, r.score, r.why, (r.weakCut ? r.tests.filter((t) => !r.weakCut.has(t)) : r.tests).join(', ') || 'none', r.signals.weak.slice(0, LEADS).map((x) => `weak? ${x.path}:${x.line}`).join('; ') || '-', r.ver, r.part ? `part ${r.part.k + 1}/${r.part.n} lines ${r.part.a}-${r.part.b}` : '-', ...(r.packTests ? [r.packTests.join(', ') || '-'] : [])].map(flat).join('\t') + '\n').join(''));
  fs.rmSync(path.join(ctx, 'audit-unit-extra.json'), { force: true });
  fs.rmSync(path.join(ctx, 'audit-unit-rooms.json'), { force: true }); // a plan written earlier into this ctx (the collector plans again when the pre-flight keeps fewer calls)
  const xr = inv.extraRooms || [], rooms = [...(inv.unitRooms || []), ...xr];
  if (rooms.length > 1) w('audit-unit-rooms.json', JSON.stringify(rooms)); // more than one call: scan-parts.js makes one unit part per room
  if (xr.length) w('audit-unit-extra.json', String(xr.length)); // the last rooms are extras: admitted at run time, not planned by the pre-flight
  w('audit-units-carried.txt', inv.carried.map((r) => `${r.id}\t${flat(r.path)}\n`).join(''));
  w('audit-inventory.json', JSON.stringify({ head, max_units: maxUnits, ...(inv.unitCalls > 1 && { unit_calls: inv.unitCalls }), ...(inv.allParts && { all_parts: true, parts_left: inv.partsLeft, parts_left_n: inv.partsLeftN, parts_left_by_path: inv.partsLeftBy }), ...(inv.extraKeys && inv.extraKeys.length && { extra_keys: inv.extraKeys }), ...(inv.hint && { budget_hint: inv.hint }), ...inv.totals, rotation: inv.rotation, shallow: inv.shallow, limitations: inv.limitations,
    rows: inv.rows.filter((r, i) => i < ROWS_KEPT || picked.has(r.id)).map((r) => ({ id: r.id, path: r.path, score: r.score, why: r.why, tests: r.tests, loc: r.loc, public: r.pub, churn: r.churn, fixes: r.fixes, review: inv.review(r), signals: { tests: r.signals.tests, noAssert: r.signals.noAssert, skipped: r.signals.skipped, asserts: r.signals.asserts, weak: r.signals.weak.length, unread: r.signals.unread },
      ...((r.signals.weak.length || r.unref.length || (r.boundary || []).length) && { leads: { boundary: (r.boundary || []).slice(0, 3), weak: r.signals.weak.slice(0, LEADS).map((x) => ({ path: x.path, line: x.line, text: x.text })), unref: r.unref.slice(0, 5) } }) })),
    forced: inv.forced, // picked although it cannot fit the pack: the publisher records it as unsure even when its tests were cut, so the rotation moves on
    unreviewed: inv.rows.filter((r) => inv.review(r) === 'not yet reviewed').slice(0, 30).map((r) => ({ id: r.id, path: r.path, score: r.score })) }) + '\n');
}

// Rule-based leads from the per-unit signals (rows of inventory() or of audit-inventory.json; a row without `signals` is skipped): at most one per row, never a model claim.
// test_evidence_not_found = the test SEARCH found nothing (not a confirmed missing test); weak_test_signal = matched tests that cannot protect much. A test file that was not read is assumed to assert (as inventory() does for the factor).
function staticFindings(rows) {
  const out = [], n = (k, one, many = `${one}s`) => `${k} ${k === 1 ? one : many}`;
  for (const r of rows || []) {
    const s = r && r.signals;
    if (!s) continue;
    const base = { unit: r.id, path: r.path };
    if (!(r.tests || []).length) { out.push({ ...base, kind: 'test_evidence_not_found', why: 'the test search found no matching test file (not a confirmed missing test)' }); continue; }
    const weak = Array.isArray(s.weak) ? s.weak.length : s.weak || 0, asserts = s.unread ? Math.max(s.asserts, 1) : s.asserts;
    if (s.noAssert > 0 || s.skipped > 0 || weak * 2 >= asserts) out.push({ ...base, kind: 'weak_test_signal', why: [s.noAssert && `${n(s.noAssert, 'test')} without an assertion`, s.skipped && `${s.skipped} skipped`, weak && n(weak, 'weak assertion'), asserts === 0 && 'no assertions'].filter(Boolean).join(', ') });
  }
  return out;
}

// Exact-location facts from the same rows (row.leads, written by write()): a weak assertion that only checks truthiness, an exported name no test file mentions. In row order (risk order); at most `cap` kept, `extra` counts the rest.
// Facts for a reader to check, never counted as gaps and never in the state.
function staticLeads(rows, cap = 20) {
  const all = [], unref = [], bnd = [], seen = new Set(), exp = (p) => (/\.[cm]?[jt]sx?$/i.test(p) ? 'exported' : 'public');
  for (const r of rows || []) {
    const l = r && r.leads;
    if (!l) continue;
    for (const w of l.weak || []) !seen.has(w.path + ":" + w.line) && seen.add(w.path + ":" + w.line) && all.push({ unit: r.id, path: w.path, line: w.line, kind: 'truthiness_only', why: `\`${w.path.split('/').pop()}:${w.line}\` asserts only truthiness (\`${String(w.text).replace(/`/g, "'")}\`)` });
    for (const b of l.boundary || []) bnd.push({ unit: r.id, path: r.path, line: b.line, kind: 'boundary_unpinned', why: `line ${b.line} compares with ${b.name} (= ${b.value}); no matched test uses ${b.name} or its value` });
    for (const d of l.unref || []) unref.push({ unit: r.id, path: r.path, line: d.line, kind: 'unreferenced_export', why: `\`${d.name}\` (${r.path}:${d.line}) is ${exp(r.path)} and no test file references it` });
  }
  // the cap is filled round-robin over the kinds (weak assertion, boundary, unreferenced export), each in its own risk order: every kind that exists is visible, and the noisiest one (unreferenced exports) cannot crowd out the rest
  const kinds = [all, bnd, unref], mixed = [];
  for (let k = 0; mixed.length < all.length + bnd.length + unref.length; k++) for (const g of kinds) if (k < g.length) mixed.push(g[k]);
  return { items: mixed.slice(0, cap), extra: Math.max(0, mixed.length - cap) };
}

module.exports = { NOT_UNIT, staticFindings, staticLeads, inventory, write, pick, risk, factorOf, publicCount, testSignals, history, sha8, DAYS };
