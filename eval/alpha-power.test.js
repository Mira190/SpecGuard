const test = require('node:test');
const assert = require('node:assert/strict');
const { power } = require('./alpha-power');

test('alpha-power: the plan table cell for 90% agreement at n=30 (18%) reproduces with seed 1, 200 trials (other cells: run node eval/alpha-power.js)', () => {
  assert.equal(power({ agreement: 0.9, n: 30 }).decisionGrade, 0.18);
});

test('alpha-power simulation is seeded and reproducible; good labellers pass more often as n grows, mediocre ones rarely', () => {
  const a = power({ agreement: 0.95, n: 100, trials: 6 }), b = power({ agreement: 0.95, n: 100, trials: 6 });
  assert.deepEqual(a, b);
  assert.ok(power({ agreement: 0.95, n: 150, trials: 6 }).decisionGrade > power({ agreement: 0.95, n: 30, trials: 6 }).decisionGrade);
  assert.ok(power({ agreement: 0.8, n: 100, trials: 6 }).decisionGrade <= 0.1);
});
