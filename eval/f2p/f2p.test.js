const test = require('node:test');
const assert = require('node:assert');
const { verdict, throwOrigin, signatureChanged } = require('./verdict');
const f2p = require('./f2p');
const { fisher2, wilson, mdd } = require('./stats');

const r = (outcome, extra = {}) => ({ outcome, ...extra });
const x3 = (o, e) => [r(o, e), r(o, e), r(o, e)];
const prod = { origin: 'production', frame: 'src/a.ts:10' };

test('assertion verdicts from synthetic outcomes', () => {
  assert.strictEqual(verdict(x3('assert_fail'), x3('pass')).verdict, 'verified');
  assert.strictEqual(verdict(x3('pass'), x3('pass')).verdict, 'not_discriminating');
  assert.strictEqual(verdict(x3('assert_fail'), x3('assert_fail')).verdict, 'not_discriminating');
  assert.strictEqual(verdict(x3('pass'), x3('assert_fail')).verdict, 'reversed');
  assert.strictEqual(verdict(x3('error', { msg: 'import' }), x3('pass')).verdict, 'invalid');
  assert.strictEqual(verdict([r('assert_fail'), r('pass'), r('assert_fail')], x3('pass')).verdict, 'flaky');
  assert.strictEqual(verdict(x3('assert_fail'), [r('pass'), r('pass'), r('assert_fail')]).verdict, 'flaky');
});

test('verified_throw needs a production-code origin on all buggy runs and clean passes on fixed', () => {
  const v = verdict(x3('throw', prod), x3('pass'));
  assert.deepStrictEqual([v.verdict, v.frame], ['verified_throw', 'src/a.ts:10']);
  assert.strictEqual(verdict(x3('throw', { origin: 'test', frame: 'src/a.test.ts:3' }), x3('pass')).verdict, 'invalid');
  assert.strictEqual(verdict(x3('throw', { origin: 'bad_call' }), x3('pass')).verdict, 'invalid');
  assert.strictEqual(verdict(x3('throw', prod), x3('throw', prod)).verdict, 'invalid');
  assert.strictEqual(verdict([r('throw', prod), r('pass'), r('throw', prod)], x3('pass')).verdict, 'flaky');
  assert.strictEqual(verdict(x3('throw', prod), x3('pass'), { apiShift: true }).verdict, 'api_shift');
});

test('throwOrigin: framework frames are skipped, test frames and bad calls are not code under test', () => {
  assert.strictEqual(throwOrigin(['node_modules/x/y.js:1', 'src/a.ts:9', 'src/a.test.ts:4']).origin, 'production');
  assert.strictEqual(throwOrigin(['src/a.test.ts:4', 'src/a.ts:9']).origin, 'test');
  assert.strictEqual(throwOrigin(['tests/conftest.py:8']).origin, 'test');
  assert.strictEqual(throwOrigin(['pkg/a_test.go:12']).origin, 'test');
  assert.strictEqual(throwOrigin(['src/a.ts:9'], 'TypeError: foo is not a function').origin, 'bad_call');
  assert.strictEqual(throwOrigin(['node:internal/x:1']).origin, 'unknown');
});

test('signatureChanged sees a declaration change of a named function only', () => {
  const d = '@@ -1,1 +1,1 @@\n-export function parse(a: string): number {\n+export function parse(a: string, strict: boolean): number {\n';
  assert.ok(signatureChanged(d, ['parse']));
  assert.ok(!signatureChanged(d, ['other']));
  assert.ok(signatureChanged('-def build(a):\n+def build(a, b):\n', ['build']));
  assert.ok(signatureChanged('+const run = async (x) => {\n', ['run']));
  assert.ok(!signatureChanged('-  return parse(a)\n+  return parse(a, true)\n', ['parse']));
});

test('finding id is stable and depends on run, pr, path, line and title', () => {
  const f = { path: 'a.ts', line: 3, title: 't' };
  assert.strictEqual(f2p.findingId('r1', 'p1', f), f2p.findingId('r1', 'p1', { ...f }));
  assert.notStrictEqual(f2p.findingId('r1', 'p1', f), f2p.findingId('r2', 'p1', f));
  assert.notStrictEqual(f2p.findingId('r1', 'p1', f), f2p.findingId('r1', 'p1', { ...f, line: 4 }));
});

test('arm classification by distance from old-side hunks', () => {
  const t = { 'a.ts': [[100, 110]], 'b.ts': [] };
  assert.strictEqual(f2p.classify({ path: 'a.ts', line: 90, kind: 'missing_test' }, t).arm, 'NEAR');
  assert.strictEqual(f2p.classify({ path: 'a.ts', line: 79, kind: 'missing_test' }, t).arm, 'FAR');
  assert.strictEqual(f2p.classify({ path: 'a.ts', line: 79, kind: 'missing_test' }, t, 40).arm, 'NEAR');
  assert.strictEqual(f2p.classify({ path: 'b.ts', line: 5, kind: 'missing_test' }, t).arm, 'FAR');
  assert.strictEqual(f2p.classify({ path: 'a.ts', line: null, kind: 'missing_test' }, t).arm, 'EXCLUDED_NO_LINE');
  assert.strictEqual(f2p.classify({ path: 'c.ts', line: 1, kind: 'missing_test' }, t).arm, 'UNTOUCHED');
  assert.strictEqual(f2p.classify({ path: 'src/c.test.ts', line: 1, kind: 'weak_test' }, { 'src/c.ts': [[1, 1]] }).arm, 'UNIT_TOUCHED_WEAK');
});

test('stats: Fisher, Wilson and the clustered MDD behave', () => {
  assert.ok(Math.abs(fisher2(3, 3, 0, 3) - 0.1) < 1e-9);
  const w = wilson(5, 10); assert.ok(w[0] < 0.5 && w[1] > 0.5);
  const small = mdd([3, 3, 3, 3], [3, 3, 3, 3], 0.05, { icc: 0.3, sims: 60, reps: 100 });
  assert.ok(small === null || small > 0.3); // 24 findings cannot detect small effects
});
