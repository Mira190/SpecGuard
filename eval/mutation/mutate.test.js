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
  w({ numFailedTests: 1, numTotalTests: 3 }); assert.strictEqual(verdict({ status: 1 }, j), 'killed');
  w({ numFailedTests: 0, numTotalTests: 3, numFailedTestSuites: 0 }); assert.strictEqual(verdict({ status: 0 }, j), 'survived');
  w({ numFailedTests: 0, numTotalTests: 0, numFailedTestSuites: 1 }); assert.strictEqual(verdict({ status: 1 }, j), 'invalid');
  assert.strictEqual(verdict({ error: { code: 'ETIMEDOUT' } }, j), 'timeout');
});

test('score: recall, line hit, false alarm, unreviewed units are misses', () => {
  const mutants = [['a.ts', 10, 'survived'], ['b.ts', 5, 'survived'], ['c.ts', 5, 'killed'], ['d.ts', 5, 'killed'], ['e.ts', 5, 'survived'], ['b.ts', 9, 'invalid']].map(([file, line, status]) => ({ file, line, status }));
  const units = ['11111111\ta.ts', '22222222\tb.ts', '33333333\tc.ts', '44444444\td.ts'].join('\n');
  const findings = { not_reviewed: ['44444444 did not fit'], unit_findings: [
    { unit: '11111111', kind: 'missing_test', path: 'a.ts', line: 13 },
    { unit: '22222222', kind: 'weak_test', path: 'b.test.ts', line: 40 },
    { unit: '33333333', kind: 'weak_test', path: 'c.test.ts', line: 2 },
    { unit: '44444444', kind: 'missing_test', path: 'd.ts', line: 5 }] };
  const s = score({ mutants }, findings, units, 'x\nLow-confidence unit findings\nb.test.ts:40', 5);
  assert.strictEqual(s.units.survivor, 3);
  assert.deepStrictEqual(s.units.not_reviewed, ['d.ts', 'e.ts']);
  assert.deepStrictEqual([s.survivor_unit_recall_any.hit, s.survivor_unit_recall_any.of, s.survivor_unit_recall_any.of_reviewed], [2, 3, 2]);
  assert.strictEqual(s.survivor_unit_recall_visible.hit, 1); // b.ts is Details-only
  assert.deepStrictEqual([s.line_hit.hit, s.line_hit.of_reviewed_survivors], [1, 2]);
  assert.deepStrictEqual([s.false_alarm_visible.hit, s.false_alarm_visible.of, s.false_alarm_visible.of_reviewed], [1, 2, 1]); // c.ts flagged, d.ts unreviewed
});
