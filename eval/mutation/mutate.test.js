const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { sites, candidates, apply, pick, testOf, verdict, OPS } = require('./mutate');
const { score } = require('./score');

test('operators skip strings and comments, keep syntax valid', () => {
  assert.deepStrictEqual(sites('if (a < b && c) // x < y', OPS.bound[0]).map((s) => s.col), [5]);
  assert.deepStrictEqual(sites('const s = "a < b"', OPS.bound[0]), []);
  const t = 'function f(a) {\n  if (a >= 3 && a !== 4) return a + 1\n  return true\n}\n';
  const cs = candidates(t);
  assert.deepStrictEqual([...new Set(cs.map((c) => c.op))].sort(), ['arith', 'bound', 'eq', 'lit', 'logic', 'ret']);
  const m = cs.find((c) => c.op === 'bound');
  assert.strictEqual(apply(t, m).split('\n')[1], '  if (a > 3 && a !== 4) return a + 1');
  assert.strictEqual(apply(t, cs.find((c) => c.op === 'ret' && c.line === 3)).split('\n')[2], '  return false');
  assert.strictEqual(apply(t, { ...m, col: 99 }), null);
});

test('pick: seeded, spread over files, one mutant per line', () => {
  const by = { a: candidates('x = 1 + 2\ny = 3 < 4\nz = 5 - 6\n'), b: candidates('q = 7 < 8\n') };
  const p = pick(by, 3, 1);
  assert.deepStrictEqual(p, pick(by, 3, 1));
  assert.strictEqual(new Set(p.map((m) => `${m.file}:${m.line}`)).size, p.length);
  assert.ok(p.some((m) => m.file === 'b'));
});

test('testOf finds the test beside the source; verdict reads the vitest json', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mut-'));
  fs.writeFileSync(path.join(d, 'x.test.ts'), '');
  assert.strictEqual(testOf(d, 'x.ts'), 'x.test.ts');
  assert.strictEqual(testOf(d, 'y.ts'), null);
  const j = path.join(d, 'r.json'), w = (o) => fs.writeFileSync(j, JSON.stringify(o));
  const st = (res) => verdict(res, j).status, tr = (msgs) => ({ numFailedTests: 1, numTotalTests: 3, testResults: [{ assertionResults: [{ status: 'failed', failureMessages: msgs }] }] });
  w(tr(['AssertionError: expected 1 to be 2 at x'])); assert.deepStrictEqual(verdict({ status: 1 }, j), { status: 'killed', reason: 'assertion' });
  w(tr(["TypeError: Cannot read properties of undefined (reading 'x')"])); assert.strictEqual(st({ status: 1 }), 'invalid'); // thrown error, not an assertion
  w(tr(['Error: Test timed out in 5000ms.'])); assert.strictEqual(st({ status: 1 }), 'invalid');
  w({ numFailedTests: 0, numTotalTests: 3, numFailedTestSuites: 0 }); assert.strictEqual(st({ status: 0 }), 'survived');
  w({ numFailedTests: 0, numTotalTests: 0, numFailedTestSuites: 1 }); assert.strictEqual(st({ status: 1 }), 'invalid'); // import/compile error
  assert.strictEqual(st({ error: { code: 'ETIMEDOUT' } }), 'timeout');
});

test('score on a real-shaped result artifact (fixtures/real-shape): units file absent, free-text not_reviewed, low-confidence section, usage', () => {
  const dir = path.join(__dirname, 'fixtures', 'real-shape'), rd = (f) => fs.readFileSync(path.join(dir, f), 'utf8');
  const mutants = [['src/a.ts', 134, 'survived'], ['src/a.ts', 20, 'survived', 'defensive'], ['src/b.ts', 5, 'survived'], ['src/c.ts', 55, 'survived'], ['src/d.ts', 5, 'killed'], ['src/e.ts', 5, 'survived'], ['src/f.ts', 5, 'survived', 'equivalent'], ['src/g.ts', 3, 'killed'], ['src/b.ts', 9, 'invalid']]
    .map(([file, line, status, uncertain]) => ({ file, line, status, ...(uncertain ? { uncertain } : {}) }));
  const s = score({ repo: 'x', sha: 'y', mutants }, JSON.parse(rd('findings.json')), null, rd('summary.md'), 5, JSON.parse(rd('usage.json')));
  assert.deepStrictEqual([s.units.survivor, s.units.killed_only, s.units.uncertain_only], [4, 2, 1]);
  assert.strictEqual(s.units.summary_units_reviewed, '4 of 5');
  assert.deepStrictEqual(s.units.not_reviewed, ['src/e.ts']); // named in the free-text not_reviewed, and the summary says 4 of 5
  // a.ts flagged (visible), b.ts weak_test mapped to b.ts through its test path (visible), c.ts only low-confidence, e.ts not reviewed
  assert.deepStrictEqual([s.survivor_unit_recall_any.hit, s.survivor_unit_recall_any.of, s.survivor_unit_recall_any.of_reviewed], [3, 4, 3]);
  assert.strictEqual(s.survivor_unit_recall_visible.hit, 2);
  assert.deepStrictEqual([s.line_hit.hit, s.line_hit.of_reviewed_survivors], [2, 3]); // a.ts:134 and c.ts:55 (within 5 of the low-confidence c.ts:57); the uncertain a.ts:20 is excluded
  assert.deepStrictEqual([s.false_alarm_any.hit, s.false_alarm_any.of], [0, 2]);
  assert.strictEqual(s.mutants.survived_uncertain, 2);
  assert.strictEqual(s.findings.details_only, 1);
  assert.deepStrictEqual(s.base_rate, { in_manifest: { of: 6, any: 3, visible: 2 }, all_units: { of: 4, any: 3, visible: 2 } }); // 6 reviewed manifest files (a,b,c,d,f,g; e is not reviewed); a, b, c flagged
  assert.strictEqual(s.cost_usd, 0.42);
  const all = score({ mutants }, JSON.parse(rd('findings.json')), null, rd('summary.md').replace('4 of 5', '5 of 5'));
  assert.deepStrictEqual(all.units.not_reviewed, []); // every unit reviewed: the named file is a caveat
});

test('score: an audit-units.txt maps unit ids when it is present', () => {
  const mutants = [{ file: 'a.ts', line: 10, status: 'survived' }, { file: 'c.ts', line: 5, status: 'killed' }];
  const findings = { unit_findings: [{ unit: '11111111', kind: 'weak_test', path: 'tests/whatever.js', line: 2 }, { unit: '33333333', kind: 'weak_test', path: 'tests/c.js', line: 2 }] };
  const s = score({ mutants }, findings, '11111111\ta.ts\n33333333\tc.ts', null);
  assert.deepStrictEqual([s.survivor_unit_recall_any.hit, s.false_alarm_any.hit], [1, 1]);
});
