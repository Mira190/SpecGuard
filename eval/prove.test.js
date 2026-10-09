const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const P = require('./prove.js');

const CLAMP = `function clamp(x, lo, hi) {
  if (x < lo) {
    return lo;
  }
  if (x >= hi) {
    return hi - 1;
  }
  return x;
}
module.exports = { clamp };
`;
const WEAK = `const test = require('node:test');
const assert = require('node:assert/strict');
const { clamp } = require('./clamp.js');
test('clamp returns a number', () => { assert.equal(typeof clamp(5, 0, 10), 'number'); });
`;
const GOOD = `const test = require('node:test');
const assert = require('node:assert/strict');
const { clamp } = require('./clamp.js');
test('clamp', () => {
  assert.equal(clamp(-1, 0, 10), 0);
  assert.equal(clamp(0, 0, 10), 0);
  assert.equal(clamp(5, 0, 10), 5);
  assert.equal(clamp(10, 0, 10), 9);
  assert.equal(clamp(11, 0, 10), 9);
});
`;
const BAD = `const test = require('node:test');
const assert = require('node:assert/strict');
const { clamp } = require('./clamp.js');
test('wrong expectation', () => { assert.equal(clamp(5, 0, 10), 6); });
`;
const git = (cwd, ...a) => execFileSync('git', a, { cwd, stdio: 'pipe' });

// <out>/<id>/{repo,ctx/findings.json}; head commit has clamp.js + a weak test; the finding targets the `x >= hi` line (6).
function stage(prodTest = WEAK) {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'prove-test-')), repo = path.join(out, 'c1', 'repo');
  fs.mkdirSync(path.join(out, 'c1', 'ctx'), { recursive: true });
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, 'clamp.js'), CLAMP);
  fs.writeFileSync(path.join(repo, 'clamp.test.js'), prodTest);
  git(repo, 'init', '-q');
  git(repo, 'add', '-A');
  git(repo, '-c', 'user.name=t', '-c', 'user.email=t@e.invalid', 'commit', '-q', '-m', 'head');
  const findings = {
    coverage: [{ id: 'O1', behaviour: { path: 'clamp.js', line: 5, quote: '  if (x >= hi) {' }, status: 'weak_test' }],
    findings: [{ kind: 'weak_test', obligation_ids: ['O1'], path: 'clamp.test.js', line: 4, quote: 'x', title: 'Clamp test is weak', body: 'Only checks the type. Assert clamp(11,0,10) === 10.' }],
  };
  fs.writeFileSync(path.join(out, 'c1', 'ctx', 'findings.json'), JSON.stringify(findings));
  return { out, repo };
}

test('mask hides strings and comments', () => {
  assert.equal(P.mask("a < 'b < c' // x < y"), "a < '     ' " + ' '.repeat(8));
});

test('lineVariants covers each operator class and skips arrows', () => {
  const ops = (l) => P.lineVariants(l).map((v) => `${v.op}:${v.text.trim()}`);
  assert.ok(ops('if (a < b) {').includes('relational:if (a <= b) {'));
  assert.ok(ops('if (a === b) {').includes('relational:if (a !== b) {'));
  assert.ok(ops('x = a && b;').includes('logical:x = a || b;'));
  assert.ok(ops('x = true;').includes('boolean:x = false;'));
  assert.ok(ops('if (!ok) {').includes('negation:if (ok) {'));
  assert.ok(ops('n = 10;').includes('boundary:n = 11;') && ops('n = 10;').includes('boundary:n = 9;'));
  assert.ok(ops('t = a + b;').includes('arith:t = a - b;'));
  assert.ok(ops('t *= 0.9;').includes('number:t *= 0;'));
  assert.deepEqual(['null', '0', "''"].map((v) => `return-value:return ${v};`), ops('  return a + b;').filter((o) => o.startsWith('return-value')));
  assert.ok(ops('  throw new Error("x");').includes('delete-throw:;'));
  assert.deepEqual(P.lineVariants('const f = (a) => a;').filter((v) => v.op === 'relational'), []);
  assert.deepEqual(P.lineVariants("log('a < b');").filter((v) => v.op === 'relational'), []);
});

test('mutantsForTarget adds the enclosing if and drops no-ops', () => {
  const ms = P.mutantsForTarget(CLAMP, 3); // `return lo;` inside `if (x < lo)`
  assert.ok(ms.some((m) => m.line === 3 && m.op === 'return-value'));
  assert.ok(ms.some((m) => m.line === 2 && m.mutated === '  if (x <= lo) {'));
  assert.ok(ms.every((m) => m.mutated !== m.original));
});

test('applyMutant replaces one line and rejects a stale mutant', () => {
  const m = P.mutantsForTarget(CLAMP, 5).find((x) => x.mutated === '  if (x > hi) {');
  assert.ok(m);
  assert.equal(P.applyMutant(CLAMP, m).split('\n')[4], '  if (x > hi) {');
  assert.throws(() => P.applyMutant('a\nb\nc\nd\ne\nf', m), /does not apply/);
});

test('syntaxOk accepts valid JS, rejects broken JS, passes other languages', () => {
  assert.equal(P.syntaxOk('a.js', 'const a = 1;'), true);
  assert.equal(P.syntaxOk('a.js', 'const a = ;'), false);
  assert.equal(P.syntaxOk('a.mjs', 'import fs from "node:fs"; export const a = fs;'), true);
  assert.equal(P.syntaxOk('a.py', 'not js'), true);
});

test('isTest recognises test paths', () => {
  for (const p of ['a/b.test.js', 'x.spec.ts', 'tests/foo.js', 'a\\__tests__\\b.mjs']) assert.equal(P.isTest(p), true, p);
  for (const p of ['a/b.js', 'src/testing.js']) assert.equal(P.isTest(p), false, p);
});

test('targetOf uses the coverage behaviour for weak_test and the finding for missing_test', () => {
  const cov = [{ id: 'O1', behaviour: { path: 'p.js', line: 9, quote: 'q' } }];
  assert.deepEqual(P.targetOf({ kind: 'weak_test', obligation_ids: ['O1'], path: 'p.test.js', line: 1 }, cov), { path: 'p.js', line: 9, quote: 'q' });
  assert.deepEqual(P.targetOf({ kind: 'missing_test', obligation_ids: ['O1'], path: 'p.js', line: 3, quote: 'z' }, cov), { path: 'p.js', line: 3, quote: 'z' });
  assert.equal(P.targetOf({ kind: 'missing_test', path: 'p.test.js' }, []), null);
});

test('plan writes prove.json with syntactically valid mutants for gap findings only', () => {
  const { out } = stage();
  const f = path.join(out, 'c1', 'ctx', 'findings.json'), j = JSON.parse(fs.readFileSync(f));
  j.findings.push({ kind: 'bug', path: 'clamp.js', line: 1, title: 't', body: 'b' });
  fs.writeFileSync(f, JSON.stringify(j));
  const r = P.plan({ id: 'c1', out });
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0].target.line, 5);
  assert.ok(r.findings[0].mutants.length >= 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(out, 'c1', 'prove.json'))).findings.length, 1);
  assert.equal(r.findings[0].mutants.every((m) => m.path === 'clamp.js' && /^m\d+$/.test(m.id)), true);
});

test('planFindings notes a missing production file', () => {
  const r = P.planFindings({ coverage: [], findings: [{ kind: 'missing_test', path: 'nope.js', line: 1 }] }, os.tmpdir());
  assert.equal(r[0].mutants.length, 0);
  assert.match(r[0].note, /missing/);
});

test('agentBrief carries finding text but no mutants', () => {
  const { out } = stage();
  P.plan({ id: 'c1', out });
  const text = P.agentBrief({ id: 'c1', out });
  assert.match(text, /Clamp test is weak/);
  assert.match(text, /Do NOT modify any production code/);
  assert.doesNotMatch(text, /mutant/i);
  assert.ok(fs.existsSync(path.join(out, 'c1', 'test-writer-prompt.md')));
});

test('changedTests finds new and modified test files only', () => {
  const { repo } = stage();
  fs.writeFileSync(path.join(repo, 'new.test.js'), GOOD);
  fs.appendFileSync(path.join(repo, 'clamp.test.js'), '\n');
  fs.appendFileSync(path.join(repo, 'clamp.js'), '\n');
  assert.deepEqual(P.changedTests(repo), { added: ['new.test.js'], modified: ['clamp.test.js'] });
});

test('runTests counts passes and fails, and reports no-run for no files', () => {
  const { repo } = stage();
  fs.writeFileSync(path.join(repo, 'bad.test.js'), BAD);
  const { output, ...good } = P.runTests(repo, ['clamp.test.js']);
  assert.deepEqual(good, { ran: true, passed: true, timedOut: false, pass: 1, fail: 0 });
  assert.match(output, /clamp returns a number/);
  const bad = P.runTests(repo, ['bad.test.js']);
  assert.equal(bad.passed, false);
  assert.equal(bad.fail, 1);
  assert.equal(P.runTests(repo, []).ran, false);
});

test('check: a good test passes on head, kills mutants the weak test missed, and is discriminating', () => {
  const { out, repo } = stage();
  P.plan({ id: 'c1', out });
  fs.writeFileSync(path.join(repo, 'clamp.extra.test.js'), GOOD);
  const r = P.check({ id: 'c1', out });
  const f = r.findings[0];
  assert.deepEqual(r.new_test_files, ['clamp.extra.test.js']);
  assert.equal(f.new_test_passes_on_head, true);
  assert.ok(f.mutants_total >= 1);
  assert.ok(f.mutants_killed_by_new > f.mutants_killed_by_existing);
  assert.equal(f.discriminating, true);
  assert.equal(f.false_alarm, false);
  assert.ok(f.mutants.some((m) => m.mutated === 'if (x > hi) {' && m.killed_by_new && !m.killed_by_existing)); // the boundary mutant
  assert.equal(r.metrics.actionable_rate, 1);
  assert.ok(r.metrics.kill_rate_uplift > 0);
  assert.ok(fs.existsSync(path.join(out, 'results-prove.json')));
  assert.equal(fs.readFileSync(path.join(repo, 'clamp.js'), 'utf8'), CLAMP); // original repo never touched
});

test('check: a test that fails on head is not actionable and kills nothing', () => {
  const { out, repo } = stage();
  P.plan({ id: 'c1', out });
  fs.writeFileSync(path.join(repo, 'bad.test.js'), BAD);
  const f = P.check({ id: 'c1', out }).findings[0];
  assert.equal(f.new_test_passes_on_head, false);
  assert.equal(f.mutants_killed_by_new, 0);
  assert.equal(f.discriminating, false);
});

test('check: false alarm when the existing tests already kill every mutant', () => {
  const { out, repo } = stage(GOOD);
  // keep only the boundary mutants so the existing GOOD test kills them all
  P.plan({ id: 'c1', out });
  const pj = path.join(out, 'c1', 'prove.json'), p = JSON.parse(fs.readFileSync(pj));
  p.findings[0].mutants = p.findings[0].mutants.filter((m) => m.mutated === '  if (x > hi) {');
  fs.writeFileSync(pj, JSON.stringify(p));
  fs.writeFileSync(path.join(repo, 'other.test.js'), GOOD);
  const f = P.check({ id: 'c1', out }).findings[0];
  assert.ok(f.mutants_total >= 1);
  assert.equal(f.mutants_killed_by_existing, f.mutants_total);
  assert.equal(f.false_alarm, true);
  assert.equal(f.discriminating, false);
});

test('metrics and table summarise rows', () => {
  const rows = [
    { index: 0, kind: 'weak_test', new_test_passes_on_head: true, mutants_total: 4, mutants_killed_by_new: 3, mutants_killed_by_existing: 1, discriminating: true, false_alarm: false },
    { index: 1, kind: 'missing_test', new_test_passes_on_head: false, mutants_total: 2, mutants_killed_by_new: 0, mutants_killed_by_existing: 2, discriminating: false, false_alarm: true },
    { index: 2, kind: 'missing_test', new_test_passes_on_head: true, mutants_total: 0, mutants_killed_by_new: 0, mutants_killed_by_existing: 0, discriminating: false, false_alarm: false },
  ];
  const m = P.metrics(rows);
  assert.equal(m.actionable_rate, 0.667);
  assert.equal(m.false_alarm_rate, 0.5);
  assert.equal(m.discriminating_rate, 0.5);
  assert.equal(m.kill_rate_uplift, rate3(3 - 1 - 2 + 0, 6));
  assert.match(P.table({ findings: rows }), /weak_test \| pass \| 3\/4 \| 1\/4 \| yes \| no/);
});
const rate3 = (a, b) => Math.round((a / b) * 1000) / 1000;

test('value operators: replace-expr, arith-shift, bool-flip, negate-cond, minmax, swap-args', () => {
  const ops = (l) => P.lineVariants(l).map((v) => `${v.op}:${v.text.trim()}`);
  const r = ops('  return a + b;');
  assert.ok(r.includes('replace-expr:return a;') && r.includes('replace-expr:return b;'));
  assert.ok(ops('  return n;').includes('arith-shift:return (n) + 1;') && ops('  return n;').includes('arith-shift:return (n) * 2;'));
  assert.ok(ops('  return a > b;').includes('bool-flip:return !(a > b);'));
  assert.ok(ops('const t = price * rate;').includes('replace-expr:const t = price;'));
  assert.ok(!ops('const t = price * rate;').includes('replace-expr:const t = t;'));
  assert.ok(ops('  if (a < b) {').includes('negate-cond:if (!(a < b)) {'));
  assert.ok(ops('  return Math.min(a, b);').includes('minmax:return Math.max(a, b);'));
  assert.ok(ops('  f(a, g(b, c));').includes('swap-args:f(g(b, c), a);') && ops('  f(a, g(b, c));').includes('swap-args:f(a, g(c, b));'));
  assert.deepEqual(ops('  return Math.min(a, b);').filter((o) => o.startsWith('swap-args')), []); // commutative
});

test('mutantsForTarget labels scope and adds neighbours of the enclosing function within 10 lines', () => {
  const ms = P.mutantsForTarget(CLAMP, 3);
  assert.ok(ms.some((m) => m.line === 3 && m.scope === 'cited'));
  assert.ok(ms.some((m) => m.line === 2 && m.scope === 'head'));
  assert.ok(ms.some((m) => m.line === 6 && m.scope === 'neighbour' && m.mutated === '    return hi - 0;'));
  assert.ok(!ms.some((m) => m.line === 10), 'module.exports line is outside the function');
  assert.deepEqual(P.enclosingFunction(CLAMP.split('\n'), 3), [2, 8]);
  const far = 'function f(a) {\n' + '  const x = a;\n'.repeat(30) + '  return a;\n}\n';
  assert.ok(P.mutantsForTarget(far, 16).every((m) => Math.abs(m.line - 16) <= 10));
});

test('sub-expression operators produce the clamp upper-bound defects and no commutative swap', () => {
  const line = '  return Math.min(Math.max(value, min), max);';
  const texts = P.lineVariants(line).map((v) => v.text.trim());
  for (const t of ['return Math.min(Math.max(value, min), max + 1);', 'return Math.min(Math.max(value, min), max * 2);', 'return Math.max(value, min);'])
    assert.ok(texts.includes(t), t);
  assert.ok(!texts.includes('return Math.min(max, Math.max(value, min));'));
  assert.ok(!texts.includes('return Math.min(Math.max(min, value), max);'));
  assert.ok(P.lineVariants(line).every((v) => v.text !== line));
  const ids = P.mutantsForTarget(`${line}\n`, 1).map((m) => m.mutated.trim());
  assert.ok(ids.includes('return Math.max(value, min);'));
});

test('selectMutants caps at 40, core first, skipping rejected mutants', () => {
  const cands = [];
  for (let i = 0; i < 40; i++) cands.push({ line: 1, op: 'o' + (i % 4), scope: 'cited', mutated: 'c' + i });
  for (let i = 0; i < 40; i++) cands.push({ line: 2, op: 'o' + (i % 4), scope: 'neighbour', mutated: 'n' + i });
  const sel = P.selectMutants(cands, (c) => c.mutated !== 'c0');
  assert.equal(sel.length, 40);
  assert.equal(sel.filter((c) => c.scope === 'cited').length, 30);
  assert.ok(!sel.some((c) => c.mutated === 'c0'));
  assert.equal(new Set(sel.map((c) => c.op)).size, 4);
});

test('oracleLike flags only weak_test findings about a non-independent oracle; oracleCheck lists them', () => {
  assert.equal(P.oracleLike({ kind: 'weak_test', title: 'Test mirrors the implementation' }), true);
  assert.equal(P.oracleLike({ kind: 'weak_test', title: 't', body: 'expected value is Derived From The Implementation' }), true);
  assert.equal(P.oracleLike({ kind: 'weak_test', title: 'Tautological assertion' }), true);
  assert.equal(P.oracleLike({ kind: 'weak_test', title: 'Only checks the type', body: 'x' }), false);
  assert.equal(P.oracleLike({ kind: 'missing_test', title: 'mirror' }), false);
  const { out } = stage();
  const f = path.join(out, 'c1', 'ctx', 'findings.json'), j = JSON.parse(fs.readFileSync(f));
  j.findings[0].body = 'Recomputes the same formula as the code.';
  fs.writeFileSync(f, JSON.stringify(j));
  assert.deepEqual(P.oracleCheck({ id: 'c1', out }), [{ index: 0, title: 'Clamp test is weak', oracle: true }]);
});

test('classifyFailure separates assertion failures from harness failures (spec and TAP)', () => {
  const spec = '✖ throws for unknown id (1.2ms)\n  AssertionError [ERR_ASSERTION]: Missing expected exception.\n✖ failing tests:\n✖ throws for unknown id (1.2ms)\n';
  assert.deepEqual(P.classifyFailure(spec), { kind: 'assertion', failing_tests: ['throws for unknown id'] });
  const tap = 'not ok 1 - wrong total\n  ---\n  error: |-\n    Expected values to be strictly equal:\n    actual: 5\n    expected: 6\n  code: ERR_ASSERTION\n';
  assert.deepEqual(P.classifyFailure(tap), { kind: 'assertion', failing_tests: ['wrong total'] });
  assert.equal(P.classifyFailure('SyntaxError: Unexpected token').kind, 'harness');
  assert.equal(P.classifyFailure("Error: Cannot find module './x.js'\ncode: 'MODULE_NOT_FOUND'").kind, 'harness');
  assert.equal(P.classifyFailure('ReferenceError: foo is not defined').kind, 'harness');
  assert.equal(P.classifyFailure('AssertionError ... ', true).kind, 'harness');
  assert.equal(P.classifyFailure('AssertionError and TypeError').kind, 'unknown');
  assert.equal(P.classifyFailure('something odd').kind, 'unknown');
});

test('outcomeOf maps a row to one outcome', () => {
  const up = { ran: true, passed: true }, down = { ran: true, passed: false };
  assert.equal(P.outcomeOf({ kind: 'weak_test', oracle: true, mutants_total: 3, discriminating: true }, up), 'oracle_independence (not mutation-testable)');
  assert.equal(P.outcomeOf({ mutants_total: 3, discriminating: true }, up), 'discriminating');
  assert.equal(P.outcomeOf({ mutants_total: 3, false_alarm: true }, up), 'false_alarm');
  assert.equal(P.outcomeOf({ mutants_total: 0 }, up), 'no_mutants');
  assert.equal(P.outcomeOf({ mutants_total: 3 }, up), 'undetermined');
  assert.equal(P.outcomeOf({ mutants_total: 3 }, down, { kind: 'assertion' }), 'defect_exposed');
  assert.equal(P.outcomeOf({ mutants_total: 3 }, down, { kind: 'harness' }), 'broken_test');
  assert.equal(P.outcomeOf({ mutants_total: 3 }, down, { kind: 'unknown' }), 'undetermined');
  assert.equal(P.outcomeOf({ mutants_total: 3 }, { ran: false }), 'undetermined');
});

test('check: a failing assertion is defect_exposed, a syntax error is broken_test', () => {
  const a = stage();
  P.plan({ id: 'c1', out: a.out });
  fs.writeFileSync(path.join(a.repo, 'bad.test.js'), BAD);
  const f = P.check({ id: 'c1', out: a.out }).findings[0];
  assert.equal(f.outcome, 'defect_exposed');
  assert.deepEqual(f.failing_tests, ['wrong expectation']);
  const b = stage();
  P.plan({ id: 'c1', out: b.out });
  fs.writeFileSync(path.join(b.repo, 'broken.test.js'), 'const = ;');
  const g = P.check({ id: 'c1', out: b.out });
  assert.equal(g.findings[0].outcome, 'broken_test');
  assert.equal(g.metrics.defect_exposed_rate, 0);
  assert.equal(g.baseline.output, undefined);
});

test('metrics: defect_exposed_rate, value_shown_rate, oracle findings excluded from false_alarm_rate', () => {
  const row = (outcome, o = {}) => ({ new_test_passes_on_head: true, mutants_total: 2, mutants_killed_by_new: 2, mutants_killed_by_existing: 0, discriminating: false, false_alarm: false, outcome, ...o });
  const m = P.metrics([row('discriminating'), row('defect_exposed', { new_test_passes_on_head: false }), row('false_alarm', { false_alarm: true }), row(P.outcomeOf({ kind: 'weak_test', oracle: true }, { ran: true, passed: true }), { false_alarm: true }), row('broken_test')]);
  assert.equal(m.defect_exposed_rate, 0.2);
  assert.equal(m.value_shown_rate, 0.4);
  assert.equal(m.false_alarm_rate, 0.25); // 1 of 4 gradable (oracle excluded)
  assert.equal(m.outcomes.defect_exposed, 1);
});

test('main prints usage for bad args and runs plan', () => {
  const log = console.log; let seen = '';
  console.log = (s) => { seen += s; };
  try {
    assert.equal(P.main([]), 2);
    assert.match(seen, /Usage/);
    const { out } = stage();
    seen = '';
    assert.equal(P.main(['plan', '--case', 'c1', '--out', out]), 0);
    assert.match(seen, /weak_test clamp\.js:5: \d+ mutants/);
    assert.equal(P.main(['agent-brief', '--case', 'c1', '--out', out]), 0);
  } finally { console.log = log; }
});
