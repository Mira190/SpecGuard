#!/usr/bin/env node
// Proof tooling: are test-gap findings actionable and discriminating? Mutation is the ground truth.
//   plan        findings.json -> <out>/<id>/prove.json (finding + target line + deterministic mutants)
//   agent-brief -> <out>/<id>/test-writer-prompt.md (finding text only, never the mutants)
//   check       agent-written test: passes on head? kills mutants? do the EXISTING tests already kill them?
// Node built-ins only. Mutants are textual, single-line, and only ever run inside temp copies of the repo.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');

const USAGE = `Usage:
  node eval/prove.js plan        --case ID --out DIR
  node eval/prove.js agent-brief --case ID --out DIR
  node eval/prove.js check       --case ID --out DIR [--timeout MS]
  node eval/prove.js oracle-check --case ID --out DIR
DIR is a local-eval output dir: DIR/<id>/ctx/findings.json and DIR/<id>/repo (head commit checked out).`;

const TIMEOUT = 10000;
const TEST_RE = /(\.(test|spec)\.[cm]?[jt]sx?$)|(^|\/)(__tests__|tests?)\/.*\.[cm]?[jt]sx?$|_test\.[cm]?js$/;
const isTest = (p) => TEST_RE.test(String(p).replace(/\\/g, '/'));
const GAP = new Set(['missing_test', 'weak_test']);
const ORACLE = 'oracle_independence (not mutation-testable)';
const ORACLE_RE = /mirror|recompute|tautolog|same formula|derived from the implementation/i;
// A weak_test whose weakness is a non-independent oracle: production mutation cannot show it (the test is a change-detector).
const oracleLike = (f) => f.kind === 'weak_test' && ORACLE_RE.test(String(f.title || '') + ' ' + String(f.body || ''));

// ---- mutation engine ---------------------------------------------------------------------------------------
// Blank out string literals and trailing // comments (same length) so operators inside them are not mutated.
function mask(line) {
  let out = '', q = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '\\') { out += '  '; i++; continue; }
      if (c === q) { q = null; out += c; } else out += ' ';
    } else if (c === '"' || c === "'" || c === '`') { q = c; out += c; }
    else if (c === '/' && line[i + 1] === '/') { out += ' '.repeat(line.length - i); break; }
    else out += c;
  }
  return out;
}

const REL = { '<': '<=', '<=': '<', '>': '>=', '>=': '>', '==': '!=', '===': '!==', '!=': '==', '!==': '===' };

const KW = new Set('Math JSON Number String Object Array return if else for while do const let var function new typeof instanceof in of this null undefined true false await async throw class switch case break continue try catch finally void delete default'.split(' '));
// Identifiers (not keywords or call names) and numeric literals on a masked line.
function idents(m) {
  const set = new Set(); let r;
  const re = /(?<![\w$.])([A-Za-z_$][\w$]*|\d+(?:\.\d+)?)(?![\w$])/g;
  while ((r = re.exec(m))) {
    if (KW.has(r[1]) || /^\s*\(/.test(m.slice(r.index + r[0].length))) continue;
    set.add(r[1]);
  }
  return [...set];
}
// Index of the bracket closing the one at i (masked text), or -1.
function closeParen(m, i) {
  let d = 0;
  for (let k = i; k < m.length; k++) { if ('([{'.includes(m[k])) d++; else if (')]}'.includes(m[k]) && --d === 0) return k; }
  return -1;
}
// Value-level operators: returned/assigned expression, negated condition, Math.min<->max, swapped call arguments.
function exprVariants(line, m, out) {
  const sub = (op, s, e, rep) => out.push({ op, text: line.slice(0, s) + rep + line.slice(e) });
  const onExpr = (start, end, skip) => {
    const expr = m.slice(start, end).trim();
    if (!expr) return;
    for (const t of idents(m)) if (t !== expr && !skip.includes(t)) sub('replace-expr', start, end, t);
    if (/^[\w$.()\s+\-*/%,]+$/.test(expr) && /[\w$]/.test(expr) && !/^(new|typeof|await|true|false|null|undefined)\b/.test(expr)) {
      for (const sfx of ['+ 1', '- 1', '* 2']) sub('arith-shift', start, end, `(${expr}) ${sfx}`);
    }
    if (/&&|\|\||[=!]==?|[<>]=?/.test(expr) || expr.startsWith('!')) sub('bool-flip', start, end, `!(${expr})`);
  };
  const stmtEnd = m.replace(/;?\s*$/, '').length;
  let r = /^(\s*)return\s+\S/.exec(m);
  if (r) onExpr(r[1].length + 7, stmtEnd, []);
  r = /^(\s*(?:(?:const|let|var)\s+)?([\w$.]+)\s*=(?![=>])\s*)\S/.exec(m);
  if (r) onExpr(r[1].length, stmtEnd, [r[2], r[2].split('.').pop()]);
  r = /\b(?:if|while)\s*\(/.exec(m);
  if (r) { const o = r.index + r[0].length - 1, c = closeParen(m, o); if (c > o) sub('negate-cond', o + 1, c, `!(${m.slice(o + 1, c)})`); }
  const mm = /Math\.(min|max)\b/g;
  while ((r = mm.exec(m))) sub('minmax', r.index + 5, r.index + 8, r[1] === 'min' ? 'max' : 'min');
  for (let i = 0; i < m.length; i++) {
    const name = m[i] === '(' && /[\w$]+$/.exec(m.slice(0, i));
    const c = name && !KW.has(name[0]) && !/Math\.(min|max)$/.test(name.input.slice(0, i)) ? closeParen(m, i) : -1; // Math.min/max are commutative: swapping is equivalent
    if (c < 0) continue;
    const cuts = [i]; let d = 0;
    for (let k = i + 1; k < c; k++) { if ('([{'.includes(m[k])) d++; else if (')]}'.includes(m[k])) d--; else if (m[k] === ',' && d === 0) cuts.push(k); }
    cuts.push(c);
    for (let p = 0; p + 2 < cuts.length; p++) {
      const A = line.slice(cuts[p] + 1, cuts[p + 1]), B = line.slice(cuts[p + 1] + 1, cuts[p + 2]);
      if (A.trim() !== B.trim()) sub('swap-args', cuts[p] + 1, cuts[p + 2], `${A.match(/^\s*/)[0]}${B.trim()}, ${A.trim()}`);
    }
  }
}

// Sub-expression operators: every identifier / numeric literal on the statement (not call names, keywords, property names or
// an assignment target) shifted (+1, -1, *2) or replaced by another in-scope identifier/literal; every call unwrapped to one argument
// (covers dropping an argument of Math.min/Math.max). Each applies independently to each occurrence.
function subExprVariants(line, m, out) {
  if (FN_HEAD.test(line)) return;
  const lhs = /^\s*(?:(?:const|let|var)\s+)?[\w$.\[\]]+\s*=(?![=>])/.exec(m), from = lhs ? lhs[0].length : 0;
  const ids = idents(m), re = /(?<![\w$.])([A-Za-z_$][\w$]*|\d+(?:\.\d+)?)(?![\w$])/g;
  let r;
  while ((r = re.exec(m))) {
    const t = r[1], s = r.index, e = s + t.length;
    if (s < from || KW.has(t) || /^\s*\(/.test(m.slice(e)) || /^\s*:/.test(m.slice(e)) && /[{,]\s*$/.test(m.slice(0, s))) continue;
    const arg = /[(,]\s*$/.test(m.slice(0, s)) && /^\s*[,)]/.test(m.slice(e)), w = (x) => (arg ? x : `(${x})`);
    const numeric = /^\d/.test(t);
    if (!(numeric && Number(t) === 0)) for (const sfx of ['+ 1', '- 1', '* 2']) out.push({ op: 'sub-shift', text: line.slice(0, s) + w(`${t} ${sfx}`) + line.slice(e) });
    for (const o of ids) if (o !== t) out.push({ op: 'sub-replace', text: line.slice(0, s) + o + line.slice(e) });
  }
  for (let i = from; i < m.length; i++) {
    const name = m[i] === '(' && /[\w$]+(?:\.[\w$]+)*$/.exec(m.slice(0, i));
    const c = name && !KW.has(name[0]) ? closeParen(m, i) : -1;
    if (c < 0) continue;
    const cuts = [i]; let d = 0;
    for (let k = i + 1; k < c; k++) { if ('([{'.includes(m[k])) d++; else if (')]}'.includes(m[k])) d--; else if (m[k] === ',' && d === 0) cuts.push(k); }
    cuts.push(c);
    for (let p = 0; p + 1 < cuts.length; p++) {
      const a = line.slice(cuts[p] + 1, cuts[p + 1]).trim();
      if (a) out.push({ op: 'unwrap-call', text: line.slice(0, i - name[0].length) + a + line.slice(c + 1) });
    }
  }
}

// All single-edit variants of one line: [{op, text}] (unfiltered; may include no-ops and duplicates).
function lineVariants(line) {
  const m = mask(line), out = [];
  const put = (op, i, len, rep) => out.push({ op, text: line.slice(0, i) + rep + line.slice(i + len) });
  let r;
  const rel = /===|!==|==|!=|<=|>=|=>|<<|>>>?|<|>/g;
  while ((r = rel.exec(m))) if (REL[r[0]]) put('relational', r.index, r[0].length, REL[r[0]]);
  const logic = /&&|\|\|/g;
  while ((r = logic.exec(m))) put('logical', r.index, 2, r[0] === '&&' ? '||' : '&&');
  const bool = /\b(true|false)\b/g;
  while ((r = bool.exec(m))) put('boolean', r.index, r[0].length, r[0] === 'true' ? 'false' : 'true');
  const neg = /!(?!=)/g;
  while ((r = neg.exec(m))) put('negation', r.index, 1, '');
  const num = /(?<![\w.$])\d+(\.\d+)?(?![\w.])/g;
  while ((r = num.exec(m))) {
    if (r[1]) { put('number', r.index, r[0].length, '0'); put('number', r.index, r[0].length, '1'); continue; }
    const n = Number(r[0]);
    put('boundary', r.index, r[0].length, String(n + 1));
    put('boundary', r.index, r[0].length, String(n - 1));
  }
  const arith = /\s([+\-*/])=?\s/g; // spaced binary operators and compound assignments only
  while ((r = arith.exec(m))) put('arith', r.index + 1, 1, { '+': '-', '-': '+', '*': '/', '/': '*' }[r[1]]);
  const ret = /^(\s*)return\s+\S.*?;?\s*$/.exec(m);
  if (ret) {
    const start = ret[1].length + 'return '.length, end = m.replace(/;?\s*$/, '').length;
    for (const v of ['null', '0', "''"]) put('return-value', start, end - start, v);
  }
  exprVariants(line, m, out);
  subExprVariants(line, m, out);
  const thr = /^(\s*)throw\b.*;\s*$/.exec(m);
  if (thr) out.push({ op: 'delete-throw', text: `${thr[1]};` });
  return out;
}

const NEIGHBOUR_LINES = 10, CAP = 40, CORE_CAP = 30;
const indentOf = (s) => s.match(/^\s*/)[0].length;
const FN_HEAD = /(\bfunction\b[^{]*\{\s*$)|(=>\s*\{\s*$)|(^\s*(?:(?:async|static|get|set)\s+)*[A-Za-z_$][\w$]*\s*\([^)]*\)\s*\{\s*$)/;
const CONTROL = /^\s*(\}\s*)?(else|if|for|while|switch|catch)\b/;

// 1-based [first, last] body lines of the function enclosing `line`, or null.
function enclosingFunction(lines, line) {
  const cited = lines[line - 1];
  if (cited === undefined) return null;
  for (let i = line - 2; i >= 0; i--) {
    if (!lines[i].trim() || indentOf(lines[i]) >= indentOf(cited) || CONTROL.test(lines[i])) continue;
    if (!FN_HEAD.test(lines[i])) { if (indentOf(lines[i]) === 0) return null; continue; }
    let end = lines.length;
    for (let k = i + 1; k < lines.length; k++) if (lines[k].trim() && indentOf(lines[k]) <= indentOf(lines[i])) { end = k; break; }
    return [i + 2, end];
  }
  return null;
}

// Candidate mutants (deduplicated, not yet syntax-checked) for the cited line (scope 'cited'), the head of its enclosing
// if/while/for ('head') and other statements of the enclosing function within NEIGHBOUR_LINES ('neighbour').
function mutantsForTarget(source, line) {
  const lines = source.split('\n'), targets = [[line, 'cited']];
  const cited = lines[line - 1];
  if (cited !== undefined && cited.trim()) {
    for (let i = line - 2; i >= 0; i--) {
      if (!lines[i].trim() || indentOf(lines[i]) >= indentOf(cited)) continue;
      if (/^\s*(\}\s*)?(else\s+)?(if|while|for)\b/.test(lines[i])) targets.push([i + 1, 'head']);
      break;
    }
    const fn = enclosingFunction(lines, line);
    if (fn) for (let ln = Math.max(fn[0], line - NEIGHBOUR_LINES); ln <= Math.min(fn[1], line + NEIGHBOUR_LINES); ln++) {
      if (!targets.some((t) => t[0] === ln) && lines[ln - 1].trim() && !/^\s*(\/\/|\/?\*|[})\]]+[;,]?\s*$)/.test(lines[ln - 1])) targets.push([ln, 'neighbour']);
    }
  }
  const seen = new Set(), res = [];
  for (const [ln, scope] of targets) {
    const orig = lines[ln - 1];
    if (orig === undefined) continue;
    for (const v of lineVariants(orig)) {
      const key = `${ln}\n${v.text}`;
      if (v.text === orig || seen.has(key)) continue;
      seen.add(key);
      res.push({ line: ln, op: v.op, scope, original: orig, mutated: v.text });
    }
  }
  return res;
}

// Pick up to CAP syntax-valid mutants: cited+head first (round-robin over operators, at most CORE_CAP), neighbours fill the rest.
function selectMutants(cands, ok) {
  const out = [];
  const fill = (list, limit) => {
    const groups = new Map();
    for (const c of list) groups.set(c.op, [...(groups.get(c.op) || []), c]);
    const qs = [...groups.values()];
    while (out.length < limit && qs.some((q) => q.length)) for (const q of qs) { const c = q.shift(); if (c && out.length < limit && ok(c)) out.push(c); }
  };
  fill(cands.filter((c) => c.scope !== 'neighbour'), CORE_CAP);
  fill(cands.filter((c) => c.scope === 'neighbour'), CAP);
  return out;
}

// Replace one line, refusing when the original text no longer matches (stale mutant).
function applyMutant(source, m) {
  const lines = source.split('\n');
  if (lines[m.line - 1] !== m.original) throw new Error(`mutant does not apply: line ${m.line} differs`);
  lines[m.line - 1] = m.mutated;
  return lines.join('\n');
}

// JS syntax check through node --check (stdin; accepted as CommonJS or as an ES module). Other languages pass.
function syntaxOk(file, text) {
  if (!/\.[cm]?js$/.test(file)) return true;
  const run = (extra) => spawnSync(process.execPath, [...extra, '--check', '-'], { input: text, timeout: TIMEOUT, encoding: 'utf8' }).status === 0;
  return run([]) || run(['--input-type=module']);
}

// ---- plan --------------------------------------------------------------------------------------------------
// weak_test: the coverage row's behaviour citation; otherwise the finding's own path/line unless that is a test file.
function targetOf(f, coverage) {
  const rows = (f.obligation_ids || []).map((id) => coverage.find((c) => c.id === id)).filter(Boolean);
  const b = rows.map((r) => r.behaviour).find((x) => x && x.path && x.line && !isTest(x.path));
  if (f.kind === 'weak_test' && b) return { path: b.path, line: b.line, quote: b.quote };
  if (f.path && !isTest(f.path)) return { path: f.path, line: f.line, quote: f.quote };
  return b ? { path: b.path, line: b.line, quote: b.quote } : null;
}

function planFindings(findings, repo) {
  const out = [];
  (findings.findings || []).forEach((f, index) => {
    if (!GAP.has(f.kind)) return;
    const target = targetOf(f, findings.coverage || []);
    let mutants = [], note;
    const file = target && path.join(repo, target.path);
    if (!target) note = 'no production target';
    else if (!fs.existsSync(file)) note = `missing ${target.path}`;
    else {
      const src = fs.readFileSync(file, 'utf8');
      mutants = selectMutants(mutantsForTarget(src, target.line), (m) => syntaxOk(target.path, applyMutant(src, m)));
      mutants.forEach((m, i) => { m.id = `m${i + 1}`; m.path = target.path; });
    }
    out.push({ index, finding: f, target, mutants, ...(note ? { note } : {}) });
  });
  return out;
}

function plan({ id, out }) {
  const dir = path.resolve(out, id);
  const findings = JSON.parse(fs.readFileSync(path.join(dir, 'ctx', 'findings.json'), 'utf8'));
  const result = { id, findings: planFindings(findings, path.join(dir, 'repo')) };
  fs.writeFileSync(path.join(dir, 'prove.json'), JSON.stringify(result, null, 2) + '\n');
  return result;
}

// oracle-check: list weak_test findings that complain about a non-independent oracle (not mutation-testable).
function oracleCheck({ id, out }) {
  const dir = path.resolve(out, id), j = JSON.parse(fs.readFileSync(path.join(dir, 'ctx', 'findings.json'), 'utf8'));
  return (j.findings || []).map((f, index) => ({ index, title: f.title, oracle: oracleLike(f) })).filter((f) => f.oracle);
}

// ---- agent brief -------------------------------------------------------------------------------------------
function agentBrief({ id, out }) {
  const dir = path.resolve(out, id);
  const gaps = JSON.parse(fs.readFileSync(path.join(dir, 'ctx', 'findings.json'), 'utf8')).findings.filter((f) => GAP.has(f.kind));
  const items = gaps.map((f, i) => `## Finding ${i + 1}: ${f.title}\n\nAnchored at ${f.path}${f.line ? `:${f.line}` : ''}\n\n${f.body}\n${f.suggestion ? `\nSuggestion:\n${f.suggestion}\n` : ''}`).join('\n');
  const text = `# Task: close the test gaps below

A code reviewer left the following findings on the repository checked out at ${path.join(dir, 'repo')}. Write ONE new test file that closes all of them.

Rules:
- Follow the repo's existing test conventions (runner, location, naming). Create a new file next to the existing tests; do not rewrite existing test files.
- Do NOT modify any production code.
- Tests must pass against the code as it is now, and must fail if the behaviour described were broken. Assert exact expected values and boundaries, not truthiness.
- Run the tests (for example \`node --test <your file>\`) and confirm they pass before finishing.
- Reply with the path of the file you created.

${items}`;
  fs.writeFileSync(path.join(dir, 'test-writer-prompt.md'), text);
  return text;
}

// ---- check -------------------------------------------------------------------------------------------------
const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `prove-${name}-`));
const copyRepo = (repo, dest) => fs.cpSync(repo, dest, { recursive: true, filter: (s) => path.basename(s) !== '.git' });

// New or changed test files in the working tree vs HEAD: { added: [...], modified: [...] }.
function changedTests(repo) {
  const added = [], modified = [];
  for (const l of git(repo, 'status', '--porcelain', '-uall').split('\n')) {
    if (!l.trim()) continue;
    const p = l.slice(3).replace(/^"|"$/g, '');
    if (!isTest(p)) continue;
    (l.startsWith('??') || l[0] === 'A' ? added : modified).push(p);
  }
  return { added, modified };
}

function runTests(cwd, files, timeout = TIMEOUT) {
  if (!files.length) return { ran: false, passed: false, pass: 0, fail: 0 };
  const flags = files.some((f) => /\.[cm]?ts$/.test(f)) && Number(process.versions.node.split('.')[0]) >= 22 ? ['--experimental-strip-types'] : [];
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT; // else a nested run inside node --test emits no summary
  const r = spawnSync(process.execPath, [...flags, '--test', ...files], { cwd, timeout, encoding: 'utf8', maxBuffer: 1 << 24, env });
  const text = `${r.stdout || ''}${r.stderr || ''}`;
  const n = (k) => Number((new RegExp(`(?:#|\\u2139)\\s*${k}\\s+(\\d+)`).exec(text) || [0, 0])[1]);
  return { ran: true, passed: r.status === 0, timedOut: !!r.error, pass: n('pass'), fail: n('fail'), output: text };
}

// Two sandboxes: sNew has the agent's tests; sOld has HEAD's tests only (modified ones restored, new ones removed).
function sandboxes(repo, tests) {
  const sNew = tmp('new'), sOld = tmp('old');
  copyRepo(repo, sNew); copyRepo(repo, sOld);
  for (const p of tests.added) fs.rmSync(path.join(sOld, p), { force: true });
  for (const p of tests.modified) fs.writeFileSync(path.join(sOld, p), git(repo, 'show', `HEAD:${p}`));
  return { sNew, sOld };
}

// Existing tests of a module: tracked test files in the production file's directory, else all tracked tests.
function existingTests(repo, prodPath) {
  const tracked = git(repo, 'ls-files').split('\n').filter((p) => p && isTest(p));
  const dir = path.posix.dirname(prodPath.replace(/\\/g, '/'));
  const near = tracked.filter((p) => path.posix.dirname(p) === dir);
  return near.length ? near : tracked;
}

// Failing node --test output (spec or TAP): an assertion failure (defect exposed) vs a harness/test-authoring failure.
function classifyFailure(output, timedOut) {
  const text = String(output || '');
  const assertion = /AssertionError|ERR_ASSERTION|Missing expected exception|\bexpected:|\bactual:|\+ actual - expected/i.test(text);
  const harness = /SyntaxError|ReferenceError|TypeError|MODULE_NOT_FOUND|ERR_MODULE_NOT_FOUND|Cannot find module|ERR_REQUIRE_ESM|ERR_UNKNOWN_FILE_EXTENSION/.test(text);
  const names = new Set();
  for (const l of text.split('\n')) {
    const r = /^\s*(?:\u2716|not ok \d+ -)\s+(.+?)(?:\s+\(\d[\d.]*ms\))?\s*$/.exec(l);
    if (r && !/\.[cm]?[jt]s$/.test(r[1]) && !/^failing tests:?$/i.test(r[1])) names.add(r[1]);
  }
  const kind = timedOut ? 'harness' : assertion && !harness ? 'assertion' : harness && !assertion ? 'harness' : 'unknown';
  return { kind, failing_tests: [...names] };
}

// Does a failing test name/message share >= 2 distinctive words with the finding text?
function namesBehaviour(f, failure, output) {
  const words = (s) => new Set(String(s).toLowerCase().match(/[a-z][a-z0-9_]{3,}/g) || []);
  const fw = words((f.title || '') + ' ' + (f.body || '')), tw = words(failure.failing_tests.join(' ') + ' ' + String(output || '').slice(0, 4000));
  return [...tw].filter((w) => fw.has(w)).length >= 2;
}

function outcomeOf(row, baseline, failure) {
  if (row.kind === 'weak_test' && row.oracle) return ORACLE;
  if (!baseline.ran) return 'undetermined';
  if (!baseline.passed) return failure.kind === 'assertion' ? 'defect_exposed' : failure.kind === 'harness' ? 'broken_test' : 'undetermined';
  if (row.mutants_total === 0) return 'no_mutants';
  return row.discriminating ? 'discriminating' : row.false_alarm ? 'false_alarm' : 'undetermined';
}

function checkPlan({ id, repo, planned, timeout = TIMEOUT }) {
  const tests = changedTests(repo), newFiles = [...tests.added, ...tests.modified];
  const { sNew, sOld } = sandboxes(repo, tests);
  try {
    const baseline = runTests(sNew, newFiles, timeout);
    const failure = baseline.ran && !baseline.passed ? classifyFailure(baseline.output, baseline.timedOut) : null;
    const findings = planned.findings.map((p) => {
      const existing = p.target ? existingTests(repo, p.target.path) : [];
      const row = { index: p.index, kind: p.finding.kind, title: p.finding.title, target: p.target, new_test_passes_on_head: baseline.passed,
        existing_passes_on_head: runTests(sOld, existing, timeout).passed, mutants_total: p.mutants.length, mutants_killed_by_new: 0, mutants_killed_by_existing: 0, mutants: [] };
      for (const m of p.mutants) {
        const orig = {};
        const mutate = (root) => { const f = path.join(root, m.path); orig[root] = fs.readFileSync(f, 'utf8'); fs.writeFileSync(f, applyMutant(orig[root], m)); };
        const restore = (root) => fs.writeFileSync(path.join(root, m.path), orig[root]);
        mutate(sNew); mutate(sOld);
        try {
          const byNew = baseline.passed && !runTests(sNew, newFiles, timeout).passed;
          const byOld = row.existing_passes_on_head && !runTests(sOld, existing, timeout).passed;
          row.mutants_killed_by_new += byNew ? 1 : 0;
          row.mutants_killed_by_existing += byOld ? 1 : 0;
          row.mutants.push({ id: m.id, op: m.op, line: m.line, mutated: m.mutated.trim(), killed_by_new: byNew, killed_by_existing: byOld });
        } finally { restore(sNew); restore(sOld); }
      }
      row.discriminating = row.mutants.some((x) => x.killed_by_new && !x.killed_by_existing); // the new test closes a gap the existing tests leave open
      row.false_alarm = row.mutants_total > 0 && row.mutants_killed_by_existing >= row.mutants_total;
      row.oracle = oracleLike(p.finding);
      row.outcome = outcomeOf(row, baseline, failure);
      if (failure) { row.failing_tests = failure.failing_tests; row.failure_kind = failure.kind; row.failure_names_finding_behaviour = namesBehaviour(p.finding, failure, baseline.output); }
      return row;
    });
    const { output, ...base } = baseline;
    return { id, new_test_files: newFiles, baseline: base, findings, metrics: metrics(findings) };
  } finally {
    fs.rmSync(sNew, { recursive: true, force: true });
    fs.rmSync(sOld, { recursive: true, force: true });
  }
}

const rate = (a, b) => (b ? Math.round((a / b) * 1000) / 1000 : null);
function metrics(findings) {
  const withM = findings.filter((f) => f.mutants_total > 0);
  const total = withM.reduce((s, f) => s + f.mutants_total, 0);
  const kn = withM.reduce((s, f) => s + f.mutants_killed_by_new, 0), ke = withM.reduce((s, f) => s + f.mutants_killed_by_existing, 0);
  const count = (o) => findings.filter((f) => f.outcome === o).length;
  const gradable = withM.filter((f) => f.outcome !== ORACLE); // oracle findings cannot be false alarms
  return {
    findings: findings.length, with_mutants: withM.length,
    defect_exposed_rate: rate(count('defect_exposed'), findings.length),
    value_shown_rate: rate(count('discriminating') + count('defect_exposed'), findings.length),
    outcomes: Object.fromEntries([...new Set(findings.map((f) => f.outcome).filter(Boolean))].map((o) => [o, count(o)])),
    actionable_rate: rate(findings.filter((f) => f.new_test_passes_on_head).length, findings.length),
    discriminating_rate: rate(withM.filter((f) => f.discriminating).length, withM.length),
    false_alarm_rate: rate(gradable.filter((f) => f.false_alarm).length, gradable.length),
    kill_rate_new: rate(kn, total), kill_rate_existing: rate(ke, total), kill_rate_uplift: rate(kn - ke, total),
  };
}

function table(r) {
  const head = ['#', 'kind', 'new on head', 'killed new', 'killed existing', 'discriminating', 'false alarm', 'outcome'];
  const rows = r.findings.map((f) => [f.index, f.kind, f.new_test_passes_on_head ? 'pass' : 'FAIL', `${f.mutants_killed_by_new}/${f.mutants_total}`, `${f.mutants_killed_by_existing}/${f.mutants_total}`, f.discriminating ? 'yes' : 'no', f.false_alarm ? 'yes' : 'no', f.outcome || '-']);
  return [head, ...rows].map((c) => c.join(' | ')).join('\n');
}

function check({ id, out, timeout = TIMEOUT }) {
  const dir = path.resolve(out, id), planned = JSON.parse(fs.readFileSync(path.join(dir, 'prove.json'), 'utf8'));
  const result = checkPlan({ id, repo: path.join(dir, 'repo'), planned, timeout });
  fs.writeFileSync(path.join(path.resolve(out), 'results-prove.json'), JSON.stringify(result, null, 2) + '\n');
  return result;
}

function main(argv) {
  const [cmd, ...rest] = argv, a = {};
  for (let i = 0; i < rest.length; i += 2) a[String(rest[i]).replace(/^--/, '')] = rest[i + 1];
  if (!['plan', 'agent-brief', 'check', 'oracle-check'].includes(cmd) || !a.case || !a.out) { console.log(USAGE); return 2; }
  const args = { id: a.case, out: a.out, timeout: a.timeout ? Number(a.timeout) : TIMEOUT };
  if (cmd === 'plan') for (const f of plan(args).findings) console.log(`finding ${f.index} ${f.finding.kind} ${f.target ? `${f.target.path}:${f.target.line}` : '-'}: ${f.mutants.length} mutants${f.note ? ` (${f.note})` : ''}`);
  if (cmd === 'agent-brief') { agentBrief(args); console.log(`wrote ${path.join(path.resolve(a.out, a.case), 'test-writer-prompt.md')}`); }
  if (cmd === 'oracle-check') for (const f of oracleCheck(args)) console.log(`finding ${f.index}: ${ORACLE}: ${f.title}`);
  if (cmd === 'check') { const r = check(args); console.log(table(r)); console.log(JSON.stringify(r.metrics, null, 2)); }
  return 0;
}

module.exports = { mask, lineVariants, subExprVariants, enclosingFunction, selectMutants, oracleLike, oracleCheck, classifyFailure, outcomeOf, mutantsForTarget, applyMutant, syntaxOk, isTest, targetOf, planFindings, plan, agentBrief, changedTests, runTests, checkPlan, metrics, table, check, main };
if (require.main === module) process.exit(main(process.argv.slice(2)));
