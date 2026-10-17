const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { inventory, write, pick, risk, factorOf, publicCount, testSignals, history, sha8 } = require('./audit-units');
const { mapTests, testStem } = require('./test-map');
const { contextPack } = require('./engines/claude-api');

const NOW = Date.parse('2026-10-14T00:00:00Z'); // the history below is relative to this: 180 days before it is 2026-04-17
const OLD = '2026-01-10T10:00:00Z', RECENT = (d) => `2026-09-${String(d).padStart(2, '0')}T10:00:00Z`;

const FILES = {
  'src/js/orders.js': ['exports.create = (o) => o;', 'exports.cancel = (o) => ({ ...o, on: false });', 'exports.refund = (o) => o;', '// a comment', 'function helper() { return 1; }', 'exports.total = () => helper();'],
  'src/js/cart.js': ['export function add(c, i) { return [...c, i]; }', 'export const total = (c) => c.length;', 'const hidden = 1;', 'export default add;'],
  'src/js/price.js': ['export function price(x) {', '  return x * 2;', '}', 'export function discount(x) {', '  return x - 1;', '}'],
  'src/js/legacy.js': ['module.exports = function legacy(a) {', '  return a;', '};', ''],
  'src/js/res.js': ['var res = {};', 'res.send = function send(b) { return b; };', 'res.json = function json(b) { return b; };', 'module.exports = res;'],
  'src/js/index.js': ['exports.a = 1;', 'exports.b = 2;', 'exports.c = 3;'],
  'src/js/tiny.js': ['exports.x = 1;', '// nothing else'],
  'src/types.d.ts': ['export interface A { a: string }', 'export interface B { b: string }', 'export interface C { c: string }'],
  'jest.config.js': ['module.exports = {', "  testEnvironment: 'node',", '};'],
  'examples/demo.js': ['exports.demo = () => 1;', 'exports.demo2 = () => 2;', 'exports.demo3 = () => 3;'],
  'vendor/lib.js': ['exports.v1 = 1;', 'exports.v2 = 2;', 'exports.v3 = 3;'],
  'docs/guide.md': '# Guide\n',
  'src/py/billing.py': ['def charge(x):', '    return x', '', 'def _private(x):', '    return x', '', 'class Invoice:', '    pass'],
  'src/py/_hidden.py': ['def _a(): pass', 'def _b(): pass', 'def _c(): pass'],
  'src/go/ledger.go': ['package ledger', '', 'func Post(e Entry) int {', '\treturn 1', '}', 'func internal() int {', '\treturn 2', '}', 'type Entry struct{}'],
  'src/java/com/acme/Order.java': ['package com.acme;', 'public class Order {', '  public int total() { return 1; }', '  private int hidden() { return 2; }', '}'],
  'lib/rb/shop.rb': ['class Shop', '  def open', '    true', '  end', '  def _close', '    false', '  end', 'end'],
  'test/cart.test.js': ["const { add } = require('../src/js/cart');", "it('adds', () => {", '  assert.deepEqual(add([], 1), [1]);', '});', "it('totals', () => {", '  assert.equal(total([1, 2]), 2);', '});'],
  'test/price.test.js': ["it('has a price', () => {", '  const r = price(2);', '  assert.ok(r);', '});', "it.skip('discounts', () => {", '  assert.equal(discount(3), 2);', '});', "it('is defined', () => {", '  expect(discount(1)).toBeDefined();', '});'],
  'test/calls.js': ["const res = require('../src/js/res');", "it('sends', () => {", '  res.send(1);', '});'],
  'test/misc.js': ["const orders = require('../src/js/orders');", "it('mentions orders but checks nothing', () => {", '  orders.create({});', '});'],
  'tests/test_billing.py': ['def test_charge():', '    assert charge(2) == 2', '', 'def test_invoice():', '    assert Invoice() is not None'],
  'src/go/ledger_test.go': ['package ledger', '', 'func TestPost(t *testing.T) {', '\tt.Skip("later")', '\tif Post(Entry{}) != 1 { t.Fatal("x") }', '}'],
  'src/test/java/com/acme/OrderTest.java': ['public class OrderTest {', '  @Disabled', '  @Test', '  void totals() { assertEquals(1, new Order().total()); }', '}'],
};

function repo(t, files = FILES) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'specguard-units-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const git = (date, ...a) => execFileSync('git', ['-c', 'core.autocrlf=false', ...a], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } }).trim();
  git(OLD, 'init'); git(OLD, 'config', 'user.name', 'SpecGuard test'); git(OLD, 'config', 'user.email', 'test@example.invalid');
  const put = (f, s) => { fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true }); fs.writeFileSync(path.join(root, f), (Array.isArray(s) ? s.join('\n') : s) + '\n'); };
  for (const [f, s] of Object.entries(files)) put(f, s);
  git(OLD, 'add', '.'); git(OLD, 'commit', '-m', 'init');
  // synthetic history: orders.js: two fix commits and one plain commit in the last 180 days; price.js: one fix commit long ago (not counted); cart.js: one plain recent commit
  const touch = (date, f, msg) => { fs.appendFileSync(path.join(root, f), `// ${msg}\n`); git(date, 'add', '.'); git(date, 'commit', '-m', msg); };
  if (!files['src/js/orders.js']) return { root, git, put };
  touch(OLD, 'src/js/price.js', 'fix: price rounding');
  touch(RECENT(1), 'src/js/orders.js', 'fix: orders rounding');
  touch(RECENT(2), 'src/js/orders.js', 'Fixes a bug in cancel');
  touch(RECENT(3), 'src/js/orders.js', 'refactor orders');
  touch(RECENT(4), 'src/js/cart.js', 'feat: cart totals');
  touch(RECENT(5), 'src/js/cart.js', 'Prefix commit that is not a fixture'); // "fixture" must not read as a fix
  return { root, git, put };
}
const byPath = (inv) => Object.fromEntries(inv.rows.map((r) => [r.path, r]));
const run = (t, o = {}) => { const r = repo(t); return { ...r, inv: inventory({ cwd: r.root, head: 'HEAD', now: NOW, ...o }) }; };

test('units: source files only; tests, docs, vendored, examples, config, declarations and files under 3 code lines are not units', (t) => {
  const { inv } = run(t);
  const paths = inv.rows.map((r) => r.path).sort();
  assert.deepEqual(paths, ['lib/rb/shop.rb', 'src/go/ledger.go', 'src/java/com/acme/Order.java', 'src/js/cart.js', 'src/js/index.js', 'src/js/legacy.js', 'src/js/orders.js', 'src/js/price.js', 'src/js/res.js', 'src/py/billing.py', 'src/py/_hidden.py'].sort());
  assert.equal(inv.rows.find((r) => r.path === 'src/js/orders.js').id, sha8('src/js/orders.js'));
});

test('test infrastructure by name is not a unit: smoke, e2e, runner, harness, fixture tokens and support dirs; testrunner.js and smokestack.js are not such tokens', (t) => {
  const body = ['exports.a = 1;', 'exports.b = 2;', 'exports.c = 3;'], f = {};
  for (const n of ['electron/smoke.cjs', 'tools/e2e-runner.js', 'src/runner-utils.js', 'src/harness.js', 'lib/fixtures.js', 'spec/support/db.js', 'src/real.js', 'src/testrunner.js', 'src/smokestack.js']) f[n] = body;
  const r = repo(t, f), got = inventory({ cwd: r.root, head: 'HEAD', now: NOW }).rows.map((x) => x.path).sort();
  assert.deepEqual(got, ['src/real.js', 'src/smokestack.js', 'src/testrunner.js']);
});

test('public definitions per language; the fallback counts top-level functions when nothing is public', () => {
  const n = (f, ls) => publicCount(f, Array.isArray(ls) ? ls : ls.split('\n'));
  assert.equal(n('a.js', FILES['src/js/orders.js']), 4, 'exports.x assignments');
  assert.equal(n('a.ts', FILES['src/js/cart.js']), 3, 'export lines; a non-exported const is not public');
  assert.equal(n('a.js', FILES['src/js/legacy.js']), 1, 'module.exports = function');
  assert.equal(n('a.js', FILES['src/js/res.js']), 3, 'res.x = function assignments (express style) and module.exports');
  assert.equal(n('a.py', FILES['src/py/billing.py']), 2, 'def and class not starting with _');
  assert.equal(n('a.py', FILES['src/py/_hidden.py']), 3, 'only private defs: the top-level function count');
  assert.equal(n('a.go', FILES['src/go/ledger.go']), 2, 'capitalised func and type');
  assert.equal(n('A.java', FILES['src/java/com/acme/Order.java']), 2, 'public class and public method');
  assert.equal(n('a.rb', FILES['lib/rb/shop.rb']), 1, 'def not starting with _');
  assert.equal(n('a.kt', ['class A {', '  fun open() {}', '  private fun hid() {}', '}']), 2);
  assert.equal(n('a.rs', ['pub fn a() {}', 'fn b() {}', 'pub struct S;']), 2);
  assert.equal(n('a.cs', ['public class A {', '  public void M() {}', '  void N() {}', '}']), 2);
  assert.equal(n('a.js', ['function helper() { return 1; }', 'const f = () => 2;', '// export const nope = 1']), 2, 'fallback: top-level function and arrow');
  assert.equal(n('a.txt', ['x']), 0);
});

test('test mapping across conventions: same stem, test/ folder, __tests__, test_x.py, x_test.go, XTest.java, mention and same directory', (t) => {
  const { inv } = run(t);
  const rows = byPath(inv), tests = (p) => rows[p].tests;
  assert.deepEqual(tests('src/js/cart.js'), ['test/cart.test.js']);
  assert.deepEqual(tests('src/js/price.js'), ['test/price.test.js']);
  assert.deepEqual(tests('src/py/billing.py'), ['tests/test_billing.py']);
  assert.deepEqual(tests('src/go/ledger.go'), ['src/go/ledger_test.go']);
  assert.deepEqual(tests('src/java/com/acme/Order.java'), ['src/test/java/com/acme/OrderTest.java']);
  assert.deepEqual(tests('src/js/res.js'), ['test/calls.js'], 'by mention');
  assert.deepEqual(tests('src/js/orders.js'), ['test/misc.js'], 'by mention');
  assert.deepEqual(tests('src/js/legacy.js'), [], 'no test');
  // the pure mapping, in the three tiers and the generic-name rule
  const all = ['test/a.test.js', 'src/__tests__/b.js', 'src/b.js', 'tests/test_c.py', 'pkg/d_test.go', 'pkg/FooTests.cs'];
  const map = (f, mentions = []) => [...mapTests(f, { tests: all, mentions: () => mentions }).entries()];
  assert.deepEqual(map('lib/a.js'), [['test/a.test.js', 'same name']]);
  assert.deepEqual(map('src/b.js'), [['src/__tests__/b.js', 'same name'], ['src/b.js', 'same name']]);
  assert.deepEqual(map('x/c.py'), [['tests/test_c.py', 'same name']]);
  assert.deepEqual(map('pkg/d.go'), [['pkg/d_test.go', 'same name'], ['pkg/FooTests.cs', 'same directory']]);
  assert.deepEqual(map('pkg/Foo.cs').slice(0, 1), [['pkg/FooTests.cs', 'same name']]);
  assert.deepEqual(map('src/zzz.js', ['test/a.test.js']), [['test/a.test.js', 'mentions zzz'], ['src/__tests__/b.js', 'same directory'], ['src/b.js', 'same directory']]);
  assert.deepEqual(map('src/index.js', ['test/a.test.js']).map((x) => x[1]), ['same directory', 'same directory'], 'a generic stem is never searched by mention');
  assert.equal(testStem('test/FooTest.java'), 'foo');
});

test('churn and fix commits come from one git log pass over the last 180 days; "fixture" is not a fix; a shallow clone has no history', (t) => {
  const { inv, root } = run(t);
  const rows = byPath(inv);
  assert.deepEqual([rows['src/js/orders.js'].churn, rows['src/js/orders.js'].fixes], [3, 2]);
  assert.deepEqual([rows['src/js/cart.js'].churn, rows['src/js/cart.js'].fixes], [2, 0]);
  assert.deepEqual([rows['src/js/price.js'].churn, rows['src/js/price.js'].fixes], [0, 0], 'a fix older than 180 days is not counted');
  assert.match(rows['src/js/orders.js'].why, /2 fix commits in 180 days/);
  const h = history(root, NOW);
  assert.equal(h.get('src/js/orders.js').churn, 3);
  assert.equal(history(root, Date.parse('2027-06-01T00:00:00Z')).get('src/js/orders.js'), undefined, 'everything is older than 180 days');
  const clone = fs.mkdtempSync(path.join(os.tmpdir(), 'specguard-shallow-'));
  t.after(() => fs.rmSync(clone, { recursive: true, force: true }));
  execFileSync('git', ['clone', '--depth', '1', '--no-local', root, path.join(clone, 'r')], { stdio: 'ignore' });
  assert.equal(history(path.join(clone, 'r'), NOW), null);
  const shallow = inventory({ cwd: path.join(clone, 'r'), head: 'HEAD', now: NOW });
  assert.equal(shallow.shallow, true);
  assert.match(shallow.limitations.join('\n'), /no git history \(shallow clone\?/);
  assert.ok(shallow.rows.every((r) => r.churn === 0 && r.fixes === 0));
});

test('test signals: skipped and disabled tests, tests without an assertion, weak assertions', () => {
  const s = testSignals(FILES['test/price.test.js'].join('\n'));
  assert.equal(s.tests, 3);
  assert.equal(s.skipped, 1);
  assert.equal(s.noAssert, 0);
  assert.deepEqual(s.weak.map((w) => w.what), ['truthy', 'exists']);
  const none = testSignals(FILES['test/misc.js'].join('\n'));
  assert.deepEqual([none.tests, none.noAssert, none.asserts], [1, 1, 0]);
  const go = testSignals(FILES['src/go/ledger_test.go'].join('\n'));
  assert.equal(go.skipped, 1);
  assert.equal(testSignals(FILES['src/test/java/com/acme/OrderTest.java'].join('\n')).skipped, 1, '@Disabled');
  assert.equal(testSignals(FILES['tests/test_billing.py'].join('\n')).tests, 2);
  assert.equal(testSignals('x.skip();\nxit("a", () => {});\nit.todo("b");\n@pytest.mark.skip\n').skipped, 4);
});

test('signals reach the rows: skipped tests, tests without an assertion, weak assertions with their lines, and the factor', (t) => {
  const { inv } = run(t);
  const rows = byPath(inv);
  assert.match(rows['src/js/price.js'].why, /1 skipped test, 2 weak assertions/);
  assert.deepEqual(rows['src/js/price.js'].signals.weak.map((w) => `${w.path}:${w.line}`), ['test/price.test.js:3', 'test/price.test.js:9']);
  assert.equal(rows['src/js/price.js'].factor, 0.6, 'half of its assertions or more are weak');
  assert.equal(rows['src/js/cart.js'].factor, 0.3);
  assert.equal(rows['src/js/orders.js'].factor, 0.6, 'a test that asserts nothing');
  assert.match(rows['src/js/orders.js'].why, /1 test without an assertion/);
  assert.equal(rows['src/js/legacy.js'].factor, 1);
  assert.match(rows['src/js/legacy.js'].why, /^no test/);
  assert.equal(rows['src/go/ledger.go'].factor, 0.6, 'all tests skipped');
  assert.match(rows['src/go/ledger.go'].why, /1 skipped test/);
  assert.match(rows['src/java/com/acme/Order.java'].why, /1 skipped test/);
  assert.equal(inv.totals.units, 11);
  assert.equal(inv.totals.without_tests, inv.rows.filter((r) => !r.tests.length).length);
  assert.equal(inv.totals.skipped_tests, 3, 'distinct matched test files: price, ledger and Order tests');
  assert.equal(inv.totals.tests_without_assertion, 2, 'misc.js and calls.js each have one test that asserts nothing');
  assert.equal(inv.totals.weak_assertions, 2 + 1, 'price.test.js (2) and test_billing.py (is not None, 1)');
});

test('risk: (1 + public) * log2(2 + loc/50) * (1 + churn/5 + fixes) * testFactor, rounded to 0.1; ranking puts the untested, fixed and public first', (t) => {
  assert.equal(risk({ pub: 3, loc: 100, churn: 5, fixes: 1, factor: 1 }), 24, '(1 + 3) * log2(4) * (1 + 1 + 1) * 1');
  assert.equal(risk({ pub: 0, loc: 0, churn: 0, fixes: 0, factor: 0.3 }), 0.3, '1 * log2(2) * 1 * 0.3');
  assert.equal(risk({ pub: 1, loc: 100, churn: 0, fixes: 0, factor: 1 }), 2 * 2 * 1 * 1);
  assert.ok(risk({ pub: 2, loc: 80, churn: 4, fixes: 1, factor: 1 }) > risk({ pub: 2, loc: 80, churn: 4, fixes: 1, factor: 0.3 }) * 3);
  assert.equal(factorOf([], { asserts: 5, tests: 1, skipped: 0, weak: [] }), 1);
  assert.equal(factorOf(['t'], { asserts: 0, tests: 2, skipped: 0, weak: [] }), 0.6);
  assert.equal(factorOf(['t'], { asserts: 4, tests: 2, skipped: 2, weak: [] }), 0.6);
  assert.equal(factorOf(['t'], { asserts: 4, tests: 2, skipped: 0, weak: [{}, {}] }), 0.6);
  assert.equal(factorOf(['t'], { asserts: 4, tests: 2, skipped: 1, weak: [{}] }), 0.3);
  const { inv } = run(t);
  const order = inv.rows.map((r) => r.path);
  assert.equal(order[0], 'src/js/orders.js', 'public, two fixes, a test that asserts nothing');
  assert.ok(order.indexOf('src/js/legacy.js') < order.indexOf('src/js/cart.js'), 'untested before tested');
  for (let i = 1; i < inv.rows.length; i++) assert.ok(inv.rows[i - 1].score >= inv.rows[i].score);
  const o = inv.rows[0];
  assert.equal(o.score, risk({ pub: o.pub, loc: o.loc, churn: o.churn, fixes: o.fixes, factor: o.factor }));
});

test('scope (scan_paths) limits the units only, not their tests; test_paths makes any non-document file there a test', (t) => {
  const r = repo(t);
  const scoped = inventory({ cwd: r.root, head: 'HEAD', now: NOW, scope: (p) => p.startsWith('src/js/') || p.startsWith('test/') });
  assert.ok(scoped.rows.every((u) => u.path.startsWith('src/js/')));
  assert.deepEqual(scoped.rows.find((u) => u.path === 'src/js/cart.js').tests, ['test/cart.test.js']);
  const only = inventory({ cwd: r.root, head: 'HEAD', now: NOW, scope: (p) => p.startsWith('src/js/') });
  assert.deepEqual(only.rows.find((u) => u.path === 'src/js/cart.js').tests, ['test/cart.test.js'], 'a test outside the scope still matches: scope selects units only');
  const set = inventory({ cwd: r.root, head: 'HEAD', now: NOW, testPaths: 'src/js/orders.js' }); // a source file declared as the test location
  assert.ok(!set.rows.some((u) => u.path === 'src/js/orders.js'));
});

test('selection and rotation: the riskiest first; with a state the confirming, never reviewed and then the least recently reviewed units', () => {
  const rows = Array.from({ length: 8 }, (_, i) => ({ id: `0000000${i}`, path: `f${i}.js`, score: 80 - i }));
  assert.deepEqual(pick(rows, 3, null).picked.map((r) => r.id), ['00000000', '00000001', '00000002']);
  const prior = { head: 'abc', blocks: [
    { cid: '00000000', status: 'covered', runs: 1, at: { date: '2026-10-02' } },
    { cid: '00000001', status: 'gap', runs: 1, at: { date: '2026-10-09' } },
    { cid: '00000002', status: 'covered', runs: 2, at: { date: '2026-10-01' } },
    { cid: '00000003', status: 'gap', runs: 2, at: { date: '2026-10-09' } },
    { cid: 'deadbeef', status: 'covered', runs: 1, at: { date: '2026-09-01' } }, // a block of a design document, not a unit
  ] };
  const a = pick(rows, 4, prior);
  assert.deepEqual(a.picked.map((r) => r.id), ['00000001', '00000004', '00000005', '00000006'], 'confirming, then never reviewed by risk');
  assert.deepEqual(a.tally, { c: 1, s: 0, n: 3, o: 0 });
  const b = pick(rows, 6, prior);
  assert.deepEqual(b.picked.map((r) => r.id), ['00000001', '00000004', '00000005', '00000006', '00000007', '00000002'], 'then the least recently reviewed');
  assert.deepEqual(b.tally, { c: 1, s: 0, n: 4, o: 1 });
  // a full cycle: every unit is reviewed once before one is reviewed again
  const seen = new Set();
  let state = { head: 'x', blocks: [] };
  for (let day = 1; day <= 3; day++) {
    const p = pick(rows, 3, state);
    for (const r of p.picked) { assert.ok(!seen.has(r.id) || seen.size === rows.length, `${r.id} reviewed twice before all units were`); seen.add(r.id); }
    state = { head: 'x', blocks: [...state.blocks.filter((x) => !p.picked.some((r) => r.id === x.cid)), ...p.picked.map((r) => ({ cid: r.id, status: 'covered', runs: 1, at: { date: `2026-10-0${day}` } }))] };
  }
  assert.equal(seen.size, 8, 'three runs of three cover eight units');
});

test('inventory with a state: rotation counts, review labels and the carried units', (t) => {
  const r = repo(t);
  const first = inventory({ cwd: r.root, head: 'HEAD', now: NOW, maxUnits: 4 });
  assert.deepEqual([first.rotation.rotate, first.rotation.picked, first.rotation.total, first.rotation.run, first.rotation.runs], [false, 4, 11, 1, 3]);
  const prior = { head: 'a', blocks: first.picked.map((u) => ({ cid: u.id, status: 'covered', runs: 1, at: { date: '2026-10-01' } })) };
  const second = inventory({ cwd: r.root, head: 'HEAD', now: NOW, maxUnits: 4, prior });
  assert.equal(second.rotation.rotate, true);
  assert.equal(second.rotation.reviewed, 8);
  assert.equal(second.rotation.run, 2);
  assert.deepEqual(second.rotation, { rotate: true, picked: 4, confirming: 0, changed: 0, new: 4, oldest: 0, reviewed: 8, total: 11, run: 2, runs: 3 });
  assert.ok(second.picked.every((u) => !first.picked.some((v) => v.id === u.id)), 'the units reviewed last time rest');
  assert.deepEqual(second.carried.map((u) => u.id).sort(), first.picked.map((u) => u.id).sort());
  assert.equal(second.review(first.picked[0]), 'reviewed 2026-10-01');
  assert.equal(second.review(second.picked[0]), 'this run');
  // review F06: a unit whose file or matched tests changed since its review (the state's version differs) is due again, before never-reviewed units
  const changed = first.picked[3], versions = { uv: Object.fromEntries(first.picked.map((u) => [u.id, u === changed ? 'deadbeef' : u.ver])), ev: {} };
  const third = inventory({ cwd: r.root, head: 'HEAD', now: NOW, maxUnits: 4, prior: { ...prior, versions } });
  assert.equal(third.picked[0].id, changed.id);
  assert.equal(third.rotation.changed, 1);
  const one = inventory({ cwd: r.root, head: 'HEAD', now: NOW, maxUnits: 0, prior: { ...prior, versions } });
  assert.deepEqual(one.stale, [changed.id], 'not picked: still reported stale');
  assert.match(one.review(changed), /reviewed 2026-10-01; changed since, due again/);
  assert.equal(inventory({ cwd: r.root, head: 'HEAD', now: NOW, maxUnits: 4, prior: { ...prior, versions: { uv: Object.fromEntries(first.picked.map((u) => [u.id, u.ver])), ev: {} } } }).rotation.changed, 0, 'same versions: nothing stale');
  assert.equal(second.review(second.rows.find((u) => !second.picked.includes(u) && !first.picked.some((v) => v.id === u.id))), 'not yet reviewed');
});

test('a unit too large for one call is reviewed in parts (review F07): fixed line windows, the cursor from the state, and an unfinished unit is picked first', (t) => {
  const big = Array.from({ length: 2000 }, (_, i) => `exports.f${i} = (x) => x + ${i}; // ${'pad '.repeat(6)}`); // about 90 KB: three parts
  const r = repo(t, { ...FILES, 'src/js/big.js': big });
  const id = sha8('src/js/big.js');
  const first = inventory({ cwd: r.root, head: 'HEAD', now: NOW, maxUnits: 20 }), row = first.rows.find((u) => u.id === id);
  assert.deepEqual(first.picked.find((u) => u.id === id).part, { k: 0, n: 3, a: 1, b: 667 });
  assert.equal(first.picked.find((u) => u.path === 'src/js/orders.js').part, undefined, 'a small unit is reviewed whole');
  const prior = { head: 'a', blocks: first.rows.map((u) => ({ cid: u.id, status: 'covered', runs: 1, at: { date: '2026-10-01' } })), versions: { uv: { [id]: row.ver }, ev: {}, uc: { [id]: [2, 3] } } };
  const next = inventory({ cwd: r.root, head: 'HEAD', now: NOW, maxUnits: 1, prior });
  assert.deepEqual([next.picked[0].id, next.picked[0].part], [id, { k: 2, n: 3, a: 1335, b: 2000 }], 'the unfinished unit first, at its cursor');
  const ctx = path.join(r.root, '.ctx'); fs.mkdirSync(ctx);
  write(ctx, 'HEAD', 1, next);
  assert.equal(fs.readFileSync(path.join(ctx, 'audit-units.txt'), 'utf8').split('\t')[7].trim(), 'part 3/3 lines 1335-2000');
  assert.ok(row.size > 80 * 1024);
});

test('claude api scan: 8 split units (short and long lines), a rule file and big matched tests: the units chosen are the ones whose part and tests fit, and each lands whole in the pack; another engine keeps 40 KB parts', (t) => {
  const N = 8, LIMIT = 250000, files = { 'docs/rules.md': `# Rules\n${'- keep functions small and tested\n'.repeat(300)}` };
  for (let u = 0; u < N; u++) { // 4 units of short lines (the line prefix is most of what the pack shows), 4 of long lines; each over a 1/8 share of the pack
    files[`src/js/u${u}.js`] = Array.from({ length: u < 4 ? 24000 : 330 }, (_, i) => (u < 4 ? (i % 2 ? '' : 'x;') : `exports.f${i} = (x) => x + ${i}; // ${'pad '.repeat(40)};`));
    files[`test/u${u}.test.js`] = [`const u = require('../src/js/u${u}');`, "it('works', () => { assert.equal(u.f1, 1); });", ...Array.from({ length: 700 }, (_, i) => `// ${'filler '.repeat(4)}${i}`)];
  }
  const r = repo(t, files);
  const inv = (o) => inventory({ cwd: r.root, head: 'HEAD', now: NOW, maxUnits: N, ...o });
  let cur = inv({ packBytes: LIMIT });
  assert.ok(cur.picked.length >= 1 && cur.picked.length < N && cur.picked.every((u) => u.part && u.part.n > 1), 'fewer units than the cap are chosen: their tests would not fit otherwise');
  const first = cur, parts = Math.max(...first.picked.map((u) => u.part.n));
  for (let k = 0; k < parts; k++) { // run k of the scan
    const ctx = path.join(r.root, `.ctx${k}`); fs.mkdirSync(ctx);
    write(ctx, 'HEAD', N, cur);
    fs.writeFileSync(path.join(ctx, 'standards.txt'), 'docs/rules.md\n');
    const pack = contextPack(ctx, r.root, LIMIT);
    assert.deepEqual(pack.notWhole.filter((p) => p.startsWith('src/js/') || p.startsWith('test/')), [], `run ${k + 1}: a unit part or one of its tests was cut or left out`);
    assert.equal((pack.text.match(/part \d+ of \d+: lines/g) || []).length, cur.picked.length, `run ${k + 1}: every chosen unit shown`);
    const uv = Object.fromEntries(first.rows.map((u) => [u.id, u.ver])), uc = Object.fromEntries(cur.picked.filter((u) => u.part && u.part.k + 1 < u.part.n).map((u) => [u.id, [u.part.k + 1, u.part.n]]));
    cur = inv({ packBytes: LIMIT, prior: { head: 'a', blocks: first.rows.map((u) => ({ cid: u.id, status: 'covered', runs: 1, at: { date: '2026-10-01' } })), versions: { uv, ev: {}, uc } } });
  }
  assert.ok(inv({}).picked.filter((u) => first.picked.some((x) => x.id === u.id)).every((u) => u.part.n < first.picked.find((x) => x.id === u.id).part.n), 'without a pack (another engine) the parts are bigger: 40 KB');
});

test('write: audit-units.txt, audit-units-carried.txt and audit-inventory.json carry the selected units, the totals and a capped risk table', (t) => {
  const { inv, root } = run(t, { maxUnits: 3 });
  const ctx = path.join(root, '.ctx');
  fs.mkdirSync(ctx);
  write(ctx, 'abc123', 3, inv);
  const rows = fs.readFileSync(path.join(ctx, 'audit-units.txt'), 'utf8').split('\n').filter(Boolean).map((l) => l.split('\t'));
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0].slice(0, 2), [sha8('src/js/orders.js'), 'src/js/orders.js']);
  assert.equal(rows[0].length, 8, 'id, path, risk, why, tests, leads, version, part');
  assert.match(rows[0][6], /^[0-9a-f]{8}$/);
  assert.equal(rows[0][7], '-', 'a unit that fits is reviewed whole');
  assert.match(rows[0][3], /fix commits in 180 days/);
  assert.equal(rows[0][4], 'test/misc.js');
  const price = rows.find((x) => x[1] === 'src/js/price.js');
  if (price) assert.match(price[5], /weak\? test\/price\.test\.js:3/);
  const json = JSON.parse(fs.readFileSync(path.join(ctx, 'audit-inventory.json'), 'utf8'));
  assert.deepEqual([json.units, json.max_units, json.selected.units, json.rotation.picked], [11, 3, 3, 3]);
  assert.equal(json.rows.length, 11);
  assert.ok(json.rows.every((x) => ['this run', 'not yet reviewed'].includes(x.review)));
  assert.equal(json.unreviewed.length, 8);
  assert.equal(fs.readFileSync(path.join(ctx, 'audit-units-carried.txt'), 'utf8'), '');
});

test('a repository with nothing to inventory has no units', (t) => {
  const r = repo(t, { 'README.md': '# x\n', 'a.js': 'x\n' });
  const inv = inventory({ cwd: r.root, head: 'HEAD', now: NOW });
  assert.equal(inv.rows.length, 0);
  assert.equal(inv.picked.length, 0);
});

test('staticFindings: no test = evidence not found; no assertion, skipped, weak majority or no assertions = weak signal; unread test file and healthy tests = none', () => {
  const { staticFindings } = require('./audit-units');
  const S = (o = {}) => ({ tests: 2, noAssert: 0, skipped: 0, asserts: 4, weak: 0, unread: 0, ...o }), row = (id, o = {}) => ({ id, path: `src/${id}.js`, tests: ['test/x.test.js'], signals: S(), ...o });
  const f = staticFindings([row('a', { tests: [], signals: S({ tests: 0, asserts: 0 }) }), row('b', { signals: S({ noAssert: 2, skipped: 1 }) }), row('c', { signals: S({ asserts: 4, weak: [1, 2] }) }), row('d', { signals: S({ asserts: 0 }) }),
    row('e', { signals: S({ asserts: 0, unread: 1 }) }), row('f'), row('g', { signals: S({ asserts: 4, weak: 1 }) }), row('h', { signals: undefined, tests: [] }), row('i', { signals: S({ skipped: 1 }) })]);
  assert.deepEqual(f.map((x) => [x.unit, x.kind]), [['a', 'test_evidence_not_found'], ['b', 'weak_test_signal'], ['c', 'weak_test_signal'], ['d', 'weak_test_signal'], ['i', 'weak_test_signal']]);
  assert.match(f[0].why, /not a confirmed missing test/);
  assert.equal(f[1].why, '2 tests without an assertion, 1 skipped');
  assert.equal(f[2].why, '2 weak assertions');
  assert.equal(f[3].why, 'no assertions');
  assert.deepEqual(Object.keys(f[1]), ['unit', 'path', 'kind', 'why']);
  assert.deepEqual(staticFindings(undefined), []);
});

test('write: audit-inventory.json rows carry the signal counts additively', (t) => {
  const { inv, root } = run(t, { maxUnits: 3 });
  const ctx = path.join(root, '.ctx');
  fs.mkdirSync(ctx);
  write(ctx, 'abc123', 3, inv);
  const json = JSON.parse(fs.readFileSync(path.join(ctx, 'audit-inventory.json'), 'utf8')), r = json.rows.find((x) => x.path === 'src/js/orders.js');
  assert.deepEqual(Object.keys(r.signals), ['tests', 'noAssert', 'skipped', 'asserts', 'weak', 'unread']);
  assert.ok(Number.isInteger(r.signals.weak));
  assert.ok(r.id && r.why && Array.isArray(r.tests) && 'churn' in r);
  const { staticFindings } = require('./audit-units');
  assert.ok(Array.isArray(staticFindings(json.rows)));
});

test('a unit over 9999 lines is sized with a 7-byte prefix (5-digit number plus 2), not a fixed 6', (t) => {
  const r = repo(t, { 'src/js/long.js': Array.from({ length: 11000 }, () => 'x;') }); // 33 KB: 3 parts at a 6-byte prefix, 4 at 7
  const u = inventory({ cwd: r.root, head: 'HEAD', now: NOW, maxUnits: 1, packBytes: 250000 }).picked.find((x) => x.path === 'src/js/long.js');
  assert.equal(u.part.n, 4);
});

// the cursor [next part, part count] holds only for the content version and the layout it was recorded under (review F22)
function cursorRepo(t) {
  const big = Array.from({ length: 600 }, (_, i) => `exports.function${i} = () => '${'x'.repeat(80)}';`).join('\n') + '\n';
  return { big, ...repo(t, { 'src/js/big.js': big }) };
}
const cursorState = (row) => { const a = require("./audit-post"); return a.readState(a.stateOf("h1", { requirements: [], not_requirements: [], not_reviewed: [], docs_reviewed: [], unit_findings: [] }, null, { date: "2026-10-01", code: { picked: [row.id], findings: [], carried: [], versions: new Map([[row.id, row.ver]]), parts: new Map([[row.id, row.part]]) } }).raw); }; // the state as the publisher writes it after reviewing row

test('F22 control: the same content and layout continue at the next part', (t) => {
  const r = cursorRepo(t), o = { cwd: r.root, head: 'HEAD', now: NOW, maxUnits: 1, packBytes: 250000 }, first = inventory(o).picked[0];
  assert.equal(first.part.k, 0);
  const next = inventory({ ...o, prior: cursorState(first) }).picked[0];
  assert.equal(next.part.k, 1);
});

test('F22 (P1): a unit edited between parts restarts at part 0 instead of continuing', (t) => {
  const r = cursorRepo(t), o = { cwd: r.root, head: 'HEAD', now: NOW, maxUnits: 1, packBytes: 250000 }, first = inventory(o).picked[0], prior = cursorState(first);
  fs.writeFileSync(path.join(r.root, 'src/js/big.js'), r.big.replace('xxxxxxxx', 'yyyyyyyy'));
  r.git(OLD, 'add', '.'); r.git(OLD, 'commit', '-m', 'edit part 1');
  const next = inventory({ ...o, prior }).picked[0];
  assert.notEqual(next.ver, first.ver);
  assert.equal(next.part.k, 0, 'the edited first part is read again');
});

test('F22 (P2): a changed part layout (max_units, pack budget) restarts at part 0', (t) => {
  const r = cursorRepo(t), o = { cwd: r.root, head: 'HEAD', now: NOW, packBytes: 250000 }, small = inventory({ ...o, maxUnits: 12 }).picked[0];
  const large = inventory({ ...o, maxUnits: 1 }).picked[0];
  assert.notEqual(small.part.n, large.part.n, 'the fixture changes the layout');
  const next = inventory({ ...o, maxUnits: 1, prior: cursorState(small) }).picked[0];
  assert.equal(next.part.k, 0, 'lines past the first part of the old layout are not skipped');
});

// a unit's whole context (part, matched tests) must fit the pack, or the scan repeats the same cut forever (review F23)
test('F23 (P7): units with big matched tests are chosen so that they fit whole, and the next run chooses others', (t) => {
  const files = { 'docs/rules.md': `# Rules\n${'- keep functions small and tested\n'.repeat(300)}` };
  for (let u = 0; u < 8; u++) {
    files[`src/js/u${u}.js`] = Array.from({ length: u < 4 ? 3500 : 330 }, (_, i) => (u < 4 ? `exports.f${i} = ${i};` : `exports.f${i} = (x) => x + ${i}; // ${'pad '.repeat(40)}`));
    files[`test/u${u}.test.js`] = [`const u = require('../src/js/u${u}');`, "it('works', () => { assert.equal(u.f1, 1); });", ...Array.from({ length: 700 }, (_, i) => `// ${'filler '.repeat(4)}${i}`)];
  }
  const r = repo(t, files), inv = (prior) => inventory({ cwd: r.root, head: 'HEAD', now: NOW, maxUnits: 8, packBytes: 250000, prior });
  const first = inv(), ctx = path.join(r.root, '.ctx'); fs.mkdirSync(ctx);
  write(ctx, 'HEAD', 8, first); fs.writeFileSync(path.join(ctx, 'standards.txt'), 'docs/rules.md\n');
  const cut = new Set(contextPack(ctx, r.root, 250000).notWhole);
  const unseen = first.picked.filter((u) => cut.has(u.path) || u.tests.some((x) => cut.has(x)));
  assert.ok(first.picked.length >= 1 && first.picked.length < 8, 'fewer units than the cap');
  assert.deepEqual(unseen, [], 'every chosen unit is seen whole with its tests, so it is written to state');
  const prior = { head: 'a', blocks: first.picked.map((u) => ({ cid: u.id, status: u.part ? 'unsure' : 'covered', runs: 1, at: { date: '2026-10-01' } })), versions: { uv: Object.fromEntries(first.picked.map((u) => [u.id, u.ver])), ev: {}, uc: Object.fromEntries(first.picked.filter((u) => u.part).map((u) => [u.id, [1, u.part.n]])) } };
  assert.notDeepEqual(inv(prior).picked.map((u) => [u.id, u.part]), first.picked.map((u) => [u.id, u.part]), 'the next run does not repeat the same selection');
});

test('F23 control: small units are still packed many per run; a unit that can never fit is named, not silently retried', (t) => {
  const small = {}; for (let u = 0; u < 8; u++) { small[`src/js/s${u}.js`] = Array.from({ length: 60 }, (_, i) => `exports.f${i} = (x) => x + ${i};`); small[`test/s${u}.test.js`] = ["it('works', () => { assert.equal(1, 1); });"]; }
  assert.equal(inventory({ cwd: repo(t, small).root, head: 'HEAD', now: NOW, maxUnits: 8, packBytes: 250000 }).picked.length, 8);
  const huge = { 'src/js/h.js': Array.from({ length: 200 }, (_, i) => `exports.f${i} = (x) => x + ${i};`), 'test/h.test.js': Array.from({ length: 4000 }, (_, i) => `// ${'filler '.repeat(6)}${i}`).concat("it('h', () => { assert.equal(h.f1(1), 2); });") };
  const b = inventory({ cwd: repo(t, huge).root, head: 'HEAD', now: NOW, maxUnits: 1, packBytes: 6000 });
  assert.equal(b.picked.length, 1, 'the unit is still chosen');
  assert.ok(b.limitations.some((l) => /cannot fit|no unit fits/.test(l)), 'and the limit is named');
});

test('F23 (review): when no unit fits, the unit chosen anyway is recorded as unsure, so the next run chooses another', (t) => {
  const files = {};
  for (const u of ['a', 'b']) {
    files[`src/js/${u}.js`] = Array.from({ length: 200 }, (_, i) => `exports.f${i} = (x) => x + ${i};`);
    files[`test/${u}.test.js`] = Array.from({ length: 4000 }, (_, i) => `// ${'filler '.repeat(6)}${i}`).concat(`it('${u}', () => { assert.equal(${u}.f1(1), 2); });`);
  }
  const r = repo(t, files), o = { cwd: r.root, head: 'HEAD', now: NOW, maxUnits: 1, packBytes: 2000 };
  const first = inventory(o);
  assert.deepEqual(first.forced, [first.picked[0].id], 'the unit chosen although it cannot fit is named');
  const post = require('./audit-post'), pick1 = first.picked[0];
  const state = post.readState(post.stateOf('h1', { requirements: [], not_requirements: [], not_reviewed: [], docs_reviewed: [], unit_findings: [] }, null, { date: '2026-10-01', code: { picked: [pick1.id], cut: new Set([pick1.id]), findings: [], carried: [], versions: new Map([[pick1.id, pick1.ver]]), parts: new Map() } }).raw);
  assert.equal(state.blocks[0].status, 'unsure', 'reviewed with its tests cut: not covered');
  const second = inventory({ ...o, prior: state });
  assert.notEqual(second.picked[0].id, pick1.id, 'the rotation moves on');
});

test('F23 (review): when no unit fits, a unit unfinished in parts does not take the single place again', (t) => {
  const files = {};
  for (const u of ['a', 'b']) {
    files[`src/js/${u}.js`] = Array.from({ length: 600 }, (_, i) => `exports.f${i} = (x) => x + ${i}; // ${'pad '.repeat(6)}`);
    files[`test/${u}.test.js`] = Array.from({ length: 4000 }, (_, i) => `// ${'filler '.repeat(6)}${i}`).concat(`it('${u}', () => { assert.equal(${u}.f1(1), 2); });`);
  }
  const r = repo(t, files), o = { cwd: r.root, head: 'HEAD', now: NOW, maxUnits: 1, packBytes: 2000 };
  const first = inventory(o).picked[0];
  assert.ok(first.part && first.part.n > 1, 'the fixture splits the unit');
  const prior = { head: 'a', blocks: [{ cid: first.id, status: 'unsure', runs: 1, at: { date: '2026-10-01' } }], versions: { uv: { [first.id]: first.ver }, ev: {}, uc: { [first.id]: [1, first.part.n] } } };
  const second = inventory({ ...o, prior }).picked[0];
  assert.notEqual(second.id, first.id, 'the unit in progress is not chosen again while nothing fits');
});

test('eligible counts the source files the time budget never reached: eligible = inventoried + over 512 KiB + not reached', (t) => {
  const body = ['function a(v) {', '  return v + 1;', '}', 'function b(v) {', '  return v + 2;', '}', 'module.exports = { a, b };'];
  const r = repo(t, { 'src/one.js': body, 'src/two.js': body, 'src/three.js': body });
  const full = inventory({ cwd: r.root, head: 'HEAD', now: NOW }), cut = inventory({ cwd: r.root, head: 'HEAD', now: NOW, budgetMs: 0 });
  assert.equal(full.totals.not_reached, 0);
  assert.equal(full.totals.eligible, 3);
  assert.ok(cut.totals.not_reached > 0, JSON.stringify(cut.totals));
  assert.equal(cut.totals.eligible, 3, 'the files the budget cut are still eligible');
  assert.equal(cut.totals.eligible, cut.totals.units + cut.totals.not_inventoried + cut.totals.not_reached);
  assert.equal(cut.totals.not_reached, cut.totals.not_reached_cap + cut.totals.not_reached_time);
});

test('not reached splits into the deterministic inventory cap and the time budget: eligible = inventoried + over 512 KiB + past the cap + unread on time', (t) => {
  const body = ['function a(v) {', '  return v + 1;', '}', 'function b(v) {', '  return v + 2;', '}', 'module.exports = { a, b };'];
  const r = repo(t, { 'src/one.js': body, 'src/two.js': body, 'src/three.js': body });
  const eq = (x) => x.eligible === x.units + x.not_inventoried + x.not_reached_cap + x.not_reached_time;
  const capd = inventory({ cwd: r.root, head: 'HEAD', now: NOW, maxRead: 2 }).totals, cut = inventory({ cwd: r.root, head: 'HEAD', now: NOW, budgetMs: 0 }).totals;
  assert.deepEqual([capd.not_reached_cap, capd.not_reached_time, capd.units, capd.eligible], [1, 0, 2, 3]);
  assert.ok(cut.not_reached_time > 0 && cut.not_reached_cap === 0, JSON.stringify(cut));
  assert.ok(eq(capd) && eq(cut));
});

test('source files over 512 KiB are named in a limitation and counted as not inventoried; no big file, no limitation; skipped paths are not counted', (t) => {
  const big = '// big\n' + Array.from({ length: 16000 }, (_, i) => `function f${i}(v) { return v + ${i}; }`).join('\n');
  const small = ['function a(v) {', '  return v + 1;', '}', 'function b(v) {', '  return v + 2;', '}', 'module.exports = { a, b };'];
  const files = { 'src/small.js': small, 'src/big1.js': big, 'src/big2.js': big, 'src/big3.js': big, 'src/big4.js': big, 'vendor/huge.js': big, 'src/big.min.js': big };
  const r = repo(t, files), inv = inventory({ cwd: r.root, head: 'HEAD', now: NOW });
  assert.deepEqual(inv.rows.map((x) => x.path), ['src/small.js']);
  assert.ok(inv.limitations.includes('4 source file(s) over 512 KiB were not inventoried: src/big1.js, src/big2.js, src/big3.js, ...'), inv.limitations.join('|'));
  assert.equal(inv.totals.not_inventoried, 4);
  assert.equal(inv.totals.eligible, inv.totals.units + inv.totals.not_inventoried, 'eligible = inventoried + not inventoried; vendor/ and .min.js are skipped, not eligible');
  assert.equal(inv.totals.eligible, 5);
  const ok = inventory({ cwd: repo(t, { 'src/small.js': small }).root, head: 'HEAD', now: NOW });
  assert.ok(!ok.limitations.some((l) => /512 KiB/.test(l)));
  assert.equal(ok.totals.not_inventoried, 0);
});

test('test_paths with exclusions only: the excluded test no longer maps to the unit', (t) => {
  const f = { 'src/js/cart.js': ['exports.a = 1;', 'exports.b = 2;', 'exports.c = 3;'], 'tests/legacy/cart.test.js': ['test("x", () => { assert(1); });'], 'tests/new/cart.test.js': ['test("y", () => { assert(1); });'] };
  const r = repo(t, f), tests = (o) => byPath(inventory({ cwd: r.root, head: 'HEAD', now: NOW, ...o }))['src/js/cart.js'].tests;
  assert.deepEqual(tests({}), ['tests/legacy/cart.test.js', 'tests/new/cart.test.js']);
  assert.deepEqual(tests({ testPaths: '!tests/legacy/**' }), ['tests/new/cart.test.js']);
});

// wave 4 E3: ver also folds in the blobs of first-level relative imports (the unit's own, and its matched tests' helpers)
test('ver: a weakened test helper or a changed imported file makes the covered unit stale; an unrelated file does not; a legacy ver is not a change', (t) => {
  const f = {
    'src/b.js': ['function base(v) {', '  return v * 2;', '}', 'module.exports = { base };'],
    'src/a.js': ["const { base } = require('./b');", 'function a(v) {', '  return base(v) + 1;', '}', 'module.exports = { a };'],
    'src/unrelated.js': ['function u(v) {', '  return v;', '}', 'module.exports = { u };'],
    'tests/a.test.js': ["const { a } = require('../src/a');", "const { verifyExact } = require('./helpers/check');", "test('a', () => { verifyExact(a(2), 5); });"],
    'tests/helpers/check.js': ["const assert = require('node:assert/strict');", 'exports.verifyExact = (actual, expected) => {', '  assert.equal(actual, expected);', '};'],
  };
  const r = repo(t, f), first = inventory({ cwd: r.root, head: 'HEAD', now: NOW, maxUnits: 5 }), A = byPath(first)['src/a.js'];
  const mk = (uv) => ({ head: 'x', blocks: first.rows.map((u) => ({ cid: u.id, status: 'covered', runs: 2, at: { date: '2026-10-01' } })), versions: { uv, ev: {} } });
  const uvNow = Object.fromEntries(first.rows.map((u) => [u.id, u.ver])), inv = () => inventory({ cwd: r.root, head: 'HEAD', now: NOW, maxUnits: 0, prior: mk(uvNow) });
  const change = (file, lines, msg) => { r.put(file, lines); r.git(OLD, 'add', '.'); r.git(OLD, 'commit', '-m', msg); };
  assert.deepEqual(A.tests, ['tests/a.test.js']);
  assert.deepEqual(inv().stale, [], 'control: nothing changed');
  change('src/unrelated.js', ['function u(v) {', '  return v + 1;', '}', 'module.exports = { u };'], 'unrelated');
  assert.deepEqual(inv().stale, [byPath(first)['src/unrelated.js'].id], 'control: only the changed unit is stale, a.js is not');
  change('tests/helpers/check.js', ["const assert = require('node:assert/strict');", 'exports.verifyExact = (actual, expected) => {', '  assert.ok(actual);', '};'], 'weaken helper');
  assert.ok(inv().stale.includes(A.id), 'a weakened helper of a matched test makes the unit stale');
  change('src/b.js', ['function base(v) {', '  return v * 3;', '}', 'module.exports = { base };'], 'change b');
  const next = inv(), row = byPath(next)['src/a.js'];
  assert.ok(next.stale.includes(A.id) && next.stale.includes(byPath(first)['src/b.js'].id), 'a changed imported file makes the importer stale');
  // migration: a stored ver from before imports were folded in is not a change
  assert.notEqual(row.ver, row.verLegacy);
  assert.ok(!inventory({ cwd: r.root, head: 'HEAD', now: NOW, maxUnits: 0, prior: mk({ ...uvNow, [A.id]: row.verLegacy }) }).stale.includes(A.id), 'a legacy ver is not a change');
  assert.equal(byPath(next)['src/unrelated.js'].ver, byPath(next)['src/unrelated.js'].verLegacy, 'no imports: ver is unchanged from before');
});

// several packs per run (rooms): pick() fills K rooms of at most `cap` units each
const fakeRoom = (total, cost) => ({ total, cost: (r, withTests = true) => (withTests ? cost : 100), trim: () => ({ tests: [], cost: 100 }) });
const rowsOf = (n) => Array.from({ length: n }, (_, i) => ({ id: i.toString(16).padStart(8, '0'), tests: [] }));

test('rooms: 30 small units fill three rooms of 12 (12 + 12 + 6, in risk order); one room keeps 12, as before; the units of a room are listed in audit-unit-rooms.json', (t) => {
  const rows = rowsOf(30), room = () => fakeRoom(10000, 100);
  const one = pick(rows, 12, null, undefined, room(), 1), three = pick(rows, 12, null, undefined, room(), 3);
  assert.equal(one.picked.length, 12, 'control: one room, today');
  assert.equal(three.picked.length, 30);
  assert.deepEqual(three.picked.map((r) => r.id), rows.map((r) => r.id), 'risk order is kept');
  const sizes = [0, 1, 2].map((k) => three.picked.filter((r) => three.roomOf.get(r.id) === k).length);
  assert.deepEqual(sizes, [12, 12, 6]);
  assert.equal(pick(rows, 12, null, undefined, room(), 2).picked.length, 24, 'rooms bound the run');
  const r = repo(t, Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`src/m${i}.js`, [`exports.a${i} = 1;`, `exports.b${i} = 2;`, `exports.c${i} = 3;`]])));
  const inv = inventory({ cwd: r.root, head: 'HEAD', now: NOW, maxUnits: 12, rooms: 3, packBytes: 250000 }), ctx = path.join(r.root, '.ctx'); fs.mkdirSync(ctx);
  assert.equal(inv.picked.length, 30);
  write(ctx, 'HEAD', 12, inv);
  const rooms = JSON.parse(fs.readFileSync(path.join(ctx, 'audit-unit-rooms.json'), 'utf8'));
  assert.deepEqual(rooms.map((x) => x.length), [12, 12, 6]);
  assert.deepEqual(rooms.flat(), inv.picked.map((u) => u.id));
  const one1 = inventory({ cwd: r.root, head: 'HEAD', now: NOW, maxUnits: 12, packBytes: 250000 }), c1 = path.join(r.root, '.ctx1'); fs.mkdirSync(c1);
  write(c1, 'HEAD', 12, one1);
  assert.equal(one1.picked.length, 12, 'control: no rooms given, one pack');
  assert.ok(!fs.existsSync(path.join(c1, 'audit-unit-rooms.json')), 'one room writes no room file');
});

test('rooms: a Kite-sized repository (43 units) at the default budget (5 unit calls) is selected whole in one run, not in 4', (t) => {
  const r = repo(t, Object.fromEntries(Array.from({ length: 43 }, (_, i) => [`src/k${i}.js`, [`exports.a${i} = 1;`, `exports.b${i} = 2;`, `exports.c${i} = 3;`]])));
  const o = { cwd: r.root, head: 'HEAD', now: NOW, maxUnits: 12, packBytes: 250000 };
  const before = inventory(o), after = inventory({ ...o, rooms: require('./engines/claude-api').unitCalls({ model: 'claude-haiku-5-5', budget: 1, maxTokens: 32000, packBytes: 250000 }) });
  assert.equal(before.rotation.runs, 4);
  assert.equal(after.picked.length, 43);
  assert.equal(after.rotation.runs, 1);
});

// a stateless run (allParts) plans every part of a unit reviewed in parts; a rotating run keeps one part per run
const twoPart = (t) => repo(t, { 'src/js/big.js': Array.from({ length: 400 }, (_, i) => `exports.function${i} = () => '${'x'.repeat(80)}';`), ...Object.fromEntries(Array.from({ length: 3 }, (_, i) => [`src/s${i}.js`, [`exports.a${i} = 1;`, `exports.b${i} = 2;`, `exports.c${i} = 3;`]])) });

test('stateless: a unit of two parts gets both parts planned across the rooms, one part per room, and the unit rooms and units file name them', (t) => {
  const r = twoPart(t), o = { cwd: r.root, head: 'HEAD', now: NOW, maxUnits: 2, rooms: 3, packBytes: 250000 };
  const inv = inventory({ ...o, allParts: true }), big = inv.picked.filter((u) => u.path === 'src/js/big.js');
  assert.deepEqual(big.map((u) => [u.part.k + 1, u.part.n]), [[1, 2], [2, 2]]);
  assert.equal(inv.rotation.picked, 4, 'the funnel counts units, not parts');
  const ctx = path.join(r.root, '.ctx'); fs.mkdirSync(ctx);
  write(ctx, 'HEAD', 1, inv);
  const rows = fs.readFileSync(path.join(ctx, 'audit-units.txt'), 'utf8').split('\n').filter(Boolean).map((l) => l.split('\t')), mine = rows.filter((x) => x[1] === 'src/js/big.js');
  assert.deepEqual(mine.map((x) => x[7].replace(/ lines.*/, '')), ['part 1/2', 'part 2/2']);
  const rooms = JSON.parse(fs.readFileSync(path.join(ctx, 'audit-unit-rooms.json'), 'utf8')), id = sha8('src/js/big.js');
  assert.equal(rooms.filter((ids) => ids.some((x) => x.startsWith(id))).length, 2, 'the two parts are in two different calls');
  assert.equal(inventory(o).picked.filter((u) => u.path === 'src/js/big.js').length, 1, 'control: without allParts one part, as before');
});

test('stateful: a rotating run still reads one part of the unit', (t) => {
  const r = twoPart(t), o = { cwd: r.root, head: 'HEAD', now: NOW, maxUnits: 1, rooms: 3, packBytes: 250000, allParts: true };
  const first = inventory({ ...o, allParts: false }), prior = { head: 'a', blocks: first.rows.map((u) => ({ cid: u.id, status: 'covered', runs: 1, at: { date: '2026-10-01' } })), versions: { uv: Object.fromEntries(first.rows.map((u) => [u.id, u.ver])), ev: {}, uc: {} } };
  const inv = inventory({ ...o, prior });
  assert.equal(inv.picked.filter((u) => u.path === 'src/js/big.js').length, 1);
  assert.ok(!inv.allParts, "a run with state plans no extra parts");
});

test('stateless: parts that do not fit are listed as not reached (budget) and the unit keeps its first part', (t) => {
  const r = twoPart(t), inv = inventory({ cwd: r.root, head: 'HEAD', now: NOW, maxUnits: 12, rooms: 1, packBytes: 250000, allParts: true }), n = inv.picked.find((u) => u.path === 'src/js/big.js').part.n;
  assert.deepEqual(inv.picked.filter((u) => u.path === 'src/js/big.js').map((u) => u.part.k), [0], 'one call holds one part of a unit');
  assert.equal(inv.partsLeft.length, n - 1);
  assert.match(inv.limitations.join('\n'), new RegExp(`${n - 1} unit parts? not reached \\(budget\\): src/js/big\\.js part 2 of ${n}`));
});

test('budget hint: units no call had room for give K and the cost of covering all of them; ample budget gives none', (t) => {
  const files = Object.fromEntries(Array.from({ length: 70 }, (_, i) => [`src/m${i}.js`, Array.from({ length: 300 }, (_, j) => `exports.f${i}_${j} = () => '${'x'.repeat(70)}';`)]));
  const r = repo(t, files), price = { usd: 0.2, budget: 1, max: 8 }, o = { cwd: r.root, head: 'HEAD', now: NOW, maxUnits: 60, packBytes: 250000, price };
  const one = inventory({ ...o, rooms: 1 });
  assert.ok(one.picked.length < 70, 'one room cannot hold every unit');
  assert.equal(one.hint.left, 70 - one.picked.length);
  assert.equal(one.hint.calls, 1);
  assert.ok(one.hint.need > 1 && one.hint.usd > 0.2 * one.hint.calls, JSON.stringify(one.hint)); // the budget needed exceeds the one call that was afforded
  const wide = inventory({ ...o, rooms: 8 });
  assert.equal(wide.picked.length, 70);
  assert.equal(wide.hint, null, 'control: everything fits, no hint');
  const capped = repo(t, Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`src/c${i}.js`, [`exports.a${i} = 1;`, `exports.b${i} = 2;`, `exports.c${i} = 3;`]])));
  assert.equal(inventory({ ...o, cwd: capped.root, maxUnits: 12, rooms: 1 }).hint, null, 'control: units left because of max_units are not a budget problem');
  const ctx = path.join(r.root, '.ctx'); fs.mkdirSync(ctx);
  write(ctx, 'HEAD', 12, one);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(ctx, 'audit-inventory.json'), 'utf8')).budget_hint, one.hint);
});

test('static leads: in a tsx unit a plain function ranks before components and use* hooks, and none is dropped; a .ts unit keeps its order', (t) => {
  const tsx = ['export const Panel = () => <div/>;', 'export function useThing() { return 1; }', 'export function clampValue(v) { return v; }', 'export function Frame() { return null; }', 'export const mapRows = (r) => r;'], ts = tsx.map((l) => l.replace('<div/>', 'null'));
  const r = repo(t, { 'src/ui/panel.tsx': tsx, 'src/ui/panel.ts': ts });
  const names = (p) => inventory({ cwd: r.root, head: 'HEAD', now: NOW, maxUnits: 12 }).rows.find((x) => x.path === p).defs.map((d) => d.name);
  assert.deepEqual(names('src/ui/panel.tsx'), ['clampValue', 'mapRows', 'Panel', 'useThing', 'Frame']);
  assert.deepEqual(names('src/ui/panel.ts'), ['Panel', 'useThing', 'clampValue', 'Frame', 'mapRows']);
});

test('rooms: unitCalls is how many full-pack calls the worst case allows, 1 to 8; a tiny budget or a dear model is one', () => {
  const { unitCalls } = require('./engines/claude-api');
  const k = (model, budget) => unitCalls({ model, budget, maxTokens: 32000, packBytes: 250000 });
  assert.equal(k('claude-haiku-5-5', 1), 5);
  assert.equal(k('claude-haiku-5-5', 20), 8);
  assert.equal(k('claude-haiku-5-5', 0.01), 1);
  assert.equal(k('claude-sonnet-5-5', 1), 1);
  assert.equal(k('claude-haiku-5-5', NaN), 1);
});

test('trimmed unit: its tests get at most half a room, in priority order, so the other units still fit (K=1 no longer collapses to one unit); the pack sends only the counted tests and lists the rest as cut', (t) => {
  const files = {};
  files['src/big.js'] = Array.from({ length: 60 }, (_, i) => `exports.big_${i} = (v) => v + ${i};`);
  for (let k = 0; k < 8; k++) files[`test/big${k}.test.js`] = ["it('big', () => { assert.equal(big_1(1), 2); });", ...Array.from({ length: 140 }, (_, i) => `// ${'filler '.repeat(6)}${i}`)];
  for (let u = 0; u < 5; u++) { files[`src/s${u}.js`] = Array.from({ length: 5 }, (_, i) => `exports.s${u}_${i} = (v) => v + ${i};`); files[`test/s${u}.test.js`] = [`it('s${u}', () => { assert.equal(s${u}_1(1), 2); });`]; }
  const r = repo(t, files), LIMIT = 60000;
  for (const rooms of [1, 3]) {
    const inv = inventory({ cwd: r.root, head: 'HEAD', now: NOW, maxUnits: 12, rooms, packBytes: LIMIT });
    const big = inv.picked[0];
    assert.equal(big.path, 'src/big.js', 'ranked first');
    assert.ok(big.tests.length >= 7 && big.packTests.length >= 1 && big.packTests.length < big.tests.length, `trimmed: ${big.packTests && big.packTests.length} of ${big.tests.length} tests counted`);
    const size = (p) => fs.statSync(path.join(r.root, p)).size, share = big.packTests.reduce((n, p) => n + Math.ceil(Math.min(size(p), 10000) * 1.15) + 300, 0);
    assert.ok(share <= Math.floor(LIMIT * 0.9 / 2), `its tests take ${share} bytes, at most half of the room`);
    assert.equal(inv.picked.filter((u) => u.path !== 'src/big.js').length, 5, `rooms ${rooms}: the five small units are selected whole beside it`);
    const ctx = path.join(r.root, `.ctx${rooms}`); fs.mkdirSync(ctx);
    write(ctx, 'HEAD', 12, inv);
    const row = fs.readFileSync(path.join(ctx, 'audit-units.txt'), 'utf8').split('\n')[0].split('\t');
    assert.equal(row[4], big.tests.join(', '), 'the full list stays for the verifier');
    assert.equal(row[8], big.packTests.join(', '), 'the counted tests are written for the pack');
    const pack = contextPack(ctx, r.root, LIMIT), omitted = big.tests.filter((p) => !big.packTests.includes(p));
    assert.ok((pack.text.match(/name="test\/big\d\.test\.js"/g) || []).length <= big.packTests.length,'the pack loads no more of its tests than were counted');
    for (const p of omitted) assert.ok(pack.notWhole.includes(p), `${p} is listed as cut`);
  }
});

const matched = (r) => byPath(inventory({ cwd: r.root, head: 'HEAD', now: NOW, maxUnits: 12 }));
const body = (...ls) => [...ls, 'export const pad1 = 1;', 'export const pad2 = 2;'];
const spec = (...ls) => ["it('works', () => {", ...ls, '  assert.ok(true);', '});'];

test('test matching: a spec that imports a dotted unit (multer.constants.ts) is matched; a spec sharing only a word segment in another package is not', (t) => {
  const r = repo(t, {
    'packages/express/multer/multer/multer.constants.ts': ['export const multerExceptions = {', "  LIMIT: 'x',", '};', ''],
    'packages/express/test/multer/multer/multer.utils.spec.ts': ["import { multerExceptions } from '../../../multer/multer/multer.constants';", ...spec('  multerExceptions.LIMIT;')],
    'packages/other/test/constants.spec.ts': spec('  // multer constants of another package'),
  });
  const row = matched(r)['packages/express/multer/multer/multer.constants.ts'];
  assert.deepEqual(row.tests, ['packages/express/test/multer/multer/multer.utils.spec.ts']);
  assert.ok(row.names.includes('multerExceptions'), 'export const NAME is a public name');
});

test('test matching: a dotted stem written in a spec without an import counts as a whole path-like token, not as its parts', (t) => {
  const r = repo(t, {
    'src/multer.constants.ts': body('export const a = 1;'),
    'test/by-token.js': spec("  require.resolve('multer.constants.js');"),
    'test/parts.js': spec('  const multer = 1, constants = 2;'),
  });
  assert.deepEqual(matched(r)['src/multer.constants.ts'].tests, ['test/by-token.js']);
});

test('test matching: a plural kebab spec (listeners-metadata-explorer.spec.ts) is matched by its import, by the plural fold in a related folder, and by the class name', (t) => {
  const r = repo(t, {
    'packages/ms/listener-metadata-explorer.ts': ['export class ListenerMetadataExplorer {', '  explore() { return 1; }', '}'],
    'packages/ms/test/listeners-metadata-explorer.spec.ts': spec('  assert.ok(1);'), // no import, no class: the plural fold only
    'packages/ms/test/by-import.spec.ts': ["import { x } from '../listener-metadata-explorer';", ...spec()],
    'packages/ms/test/by-class.spec.ts': spec('  new ListenerMetadataExplorer();'),
    'packages/zzz/test/listeners-metadata-explorer.spec.ts': spec('  assert.ok(1);'), // plural name in an unrelated package: not matched
  });
  assert.deepEqual(matched(r)['packages/ms/listener-metadata-explorer.ts'].tests, ['packages/ms/test/by-import.spec.ts', 'packages/ms/test/listeners-metadata-explorer.spec.ts', 'packages/ms/test/by-class.spec.ts'], 'import > plural fold > class name');
});

test('test matching: a mirrored root test/ tree (test/packages/ms/...) counts as related to packages/ms; another package does not', (t) => {
  const r = repo(t, {
    'packages/ms/listener-x.ts': ['export class ListenerX {', '  run() { return 1; }', '}'],
    'test/packages/ms/listeners-x.spec.ts': spec('  assert.ok(1);'), // plural fold only: no import, no class
    'test/packages/zzz/listeners-x.spec.ts': spec('  assert.ok(1);'), // same name, unrelated package: not matched
  });
  assert.deepEqual(matched(r)['packages/ms/listener-x.ts'].tests, ['test/packages/ms/listeners-x.spec.ts']);
});

test('test matching: 25 specs that only contain the word "messages" do not push out the one spec that imports messages.ts', (t) => {
  const files = { 'packages/core/errors/messages.ts': body('export const MESSAGES = {};') };
  for (let i = 0; i < 25; i++) files[`packages/core/test/noise${i}.spec.ts`] = spec(`  const messages = ${i};`);
  files['elsewhere/deep/real.spec.ts'] = ["import { MESSAGES } from '../../packages/core/errors/messages';", ...spec('  MESSAGES;')];
  const got = matched(repo(t, files))['packages/core/errors/messages.ts'].tests;
  assert.equal(got.length, 20);
  assert.equal(got[0], 'elsewhere/deep/real.spec.ts', 'the importing spec is ranked first');
});

test('test matching: a folder import (index.ts) matches the index unit; the exact stem still ranks before an importer', (t) => {
  const r = repo(t, {
    'src/foo.ts': body('export function foo() { return 1; }'),
    'src/bar/index.ts': body('export function bar() { return 1; }'),
    'test/a-importer.spec.ts': ["import { foo } from '../src/foo';", ...spec('  foo();')],
    'test/foo.spec.ts': spec('  assert.ok(1);'),
    'test/bar-importer.spec.ts': ["import { bar } from '../src/bar';", ...spec()],
  });
  const m = matched(r);
  assert.deepEqual(m['src/foo.ts'].tests, ['test/foo.spec.ts', 'test/a-importer.spec.ts']);
  assert.deepEqual(m['src/bar/index.ts'].tests, ['test/bar-importer.spec.ts']);
});

// ---- static leads: truthiness-only assertions (one classifier with PR mode) and exported names no test references ----
const LEAD_FILES = {
  'src/calc.js': ['export function moveCrop(r, d) {', '  return { ...r, x: r.x + d };', '}', 'export function clampValue(v) {', '  return Math.min(v, 9);', '}', 'export function fit(v) {', '  return v;', '}', 'export function render(v) {', '  return v;', '}', 'export const STAMP_MAX = 5;', 'export interface Options { a: number }'],
  'test/calc.test.js': ["import { clampValue } from '../src/calc';", "it('clamps', () => {", '  assert.ok(clampValue(5));', '  assert.ok(a === b);', '  assert.ok(list.includes(x));', '  assert.ok(isReady(x));', '  assert.equal(clampValue(20), 9);', '});'],
};
const leadRows = (t, files = LEAD_FILES) => { const r = repo(t, files), inv = inventory({ cwd: r.root, head: 'HEAD', now: NOW }), ctx = path.join(r.root, '.ctx'); fs.mkdirSync(ctx); write(ctx, 'abc', 12, inv); return { r, inv, json: JSON.parse(fs.readFileSync(path.join(ctx, 'audit-inventory.json'), 'utf8')) }; };

test('testSignals: assert.ok(f(x)) is a weak assertion (one classifier with PR mode); a comparison and a boolean predicate are not', () => {
  const s = testSignals(LEAD_FILES['test/calc.test.js'].join('\n'));
  assert.deepEqual(s.weak.map((w) => w.line), [3], 'only assert.ok(clampValue(5)): a === b, list.includes(x) and isReady(x) are value checks');
  assert.equal(s.weak[0].text, 'assert.ok(clampValue(5));');
  const post = require('./post');
  assert.equal(post.weakAssertion('assert.ok(list.includes(x))'), false, 'PR mode: a boolean predicate is a value check');
  assert.equal(post.weakAssertion('assert.ok(keyName(k))'), true);
  assert.equal(post.weakAssertion('assert.ok(r.streams![0].duration)'), true);
  assert.equal(post.weakAssertion('assert.ok(a === b)'), false);
});

test('testSignals: a weak assertion whose boolean is also asserted negated in the same test is pinned both ways, not weak', () => {
  assert.equal(testSignals(["it('x', () => {", '  assert.ok(firstValid(c));', '  assert.ok(!firstValid(d));', '});'].join('\n')).weak.length, 0);
  assert.equal(testSignals(["it('x', () => {", '  assert.ok(firstValid(c));', '});'].join('\n')).weak.length, 1);
});

test('staticLeads: an exported name no test file references is a lead with its definition line; a referenced name, a short or stoplisted name, a type and a constant are not', (t) => {
  const { staticLeads } = require('./audit-units');
  const { json } = leadRows(t), row = json.rows.find((x) => x.path === 'src/calc.js');
  assert.deepEqual(row.leads.unref, [{ name: 'moveCrop', line: 1 }]);
  const L = staticLeads(json.rows);
  const un = L.items.filter((i) => i.kind === 'unreferenced_export');
  assert.deepEqual(un.map((i) => [i.path, i.line]), [['src/calc.js', 1]]);
  assert.equal(un[0].why, '`moveCrop` (src/calc.js:1) is exported and no test file references it');
  assert.deepEqual(L.items.filter((i) => i.kind === 'truthiness_only').map((i) => [i.path, i.line]), [['test/calc.test.js', 3]]);
  assert.equal(L.items.find((i) => i.kind === 'truthiness_only').why, '`calc.test.js:3` asserts only truthiness (`assert.ok(clampValue(5));`)');
  assert.equal(L.extra, 0);
});

test('inventory: a test file that was not read means no "no test references it" lead (it may name the symbol)', (t) => {
  const { json } = leadRows(t, { ...LEAD_FILES, 'test/zz.test.js': 'it("x", () => {});\n\0binary' });
  assert.equal(json.rows.find((x) => x.path === 'src/calc.js').leads.unref.length, 0);
  assert.match(json.limitations.join('\n'), /no "no test references it" lead is made/);
});

test('staticLeads: at most 20 leads in row (risk) order, the rest counted; a weak line shared by two units is listed once', () => {
  const { staticLeads } = require('./audit-units');
  const rows = Array.from({ length: 25 }, (_, i) => ({ id: `u${i}`, path: `src/u${i}.js`, leads: { unref: [{ name: `fn${i}ab`, line: 2 }] } }));
  const L = staticLeads(rows);
  assert.equal(L.items.length, 20);
  assert.equal(L.extra, 5);
  assert.deepEqual(L.items.map((i) => i.unit), rows.slice(0, 20).map((r) => r.id));
  const w = { path: 'test/a.test.js', line: 4, text: 'assert.ok(f(x))' };
  assert.equal(staticLeads([{ id: 'a', path: 'src/a.js', leads: { weak: [w] } }, { id: 'b', path: 'src/b.js', leads: { weak: [w] } }]).items.length, 1);
  assert.deepEqual(staticLeads([{ id: 'a', path: 'src/a.js' }, undefined]), { items: [], extra: 0 });
});

test('staticLeads: when the cap bites, the 20 slots go round-robin over weak, boundary and unreferenced leads: 25 unref + 3 weak + 2 boundary show all 5, then 15 unref, +10 more', () => {
  const { staticLeads } = require('./audit-units');
  const rows = [...Array.from({ length: 25 }, (_, i) => ({ id: `u${i}`, path: `src/u${i}.js`, leads: { unref: [{ name: `fn${i}ab`, line: 2 }] } })),
    ...Array.from({ length: 3 }, (_, i) => ({ id: `w${i}`, path: `src/w${i}.js`, leads: { weak: [{ path: `test/w${i}.test.js`, line: 4, text: 'assert.ok(f(x))' }] } })),
    ...Array.from({ length: 2 }, (_, i) => ({ id: `b${i}`, path: `src/b${i}.js`, leads: { boundary: [{ line: 3, name: 'LIMIT_X', value: 5 }] } }))];
  const L = staticLeads(rows), n = (k) => L.items.filter((i) => i.kind === k).length;
  assert.deepEqual([L.items.length, n('truthiness_only'), n('boundary_unpinned'), n('unreferenced_export'), L.extra], [20, 3, 2, 15, 10]);
  assert.deepEqual(L.items.slice(0, 3).map((i) => i.kind), ['truthiness_only', 'boundary_unpinned', 'unreferenced_export'], 'weak, boundary, unref in each round');
});

test('staticLeads: control: with 15 weak and 8 unref leads the cap alternates weak and unref, each kind in its risk order', () => {
  const { staticLeads } = require('./audit-units');
  const w = (i) => ({ path: `test/w${i}.test.js`, line: 4, text: 'assert.ok(f(x))' });
  const rows = [...Array.from({ length: 15 }, (_, i) => ({ id: `w${i}`, path: `src/w${i}.js`, leads: { weak: [w(i)] } })), ...Array.from({ length: 8 }, (_, i) => ({ id: `u${i}`, path: `src/u${i}.js`, leads: { unref: [{ name: `fn${i}ab`, line: 2 }] } }))];
  const L = staticLeads(rows);
  assert.deepEqual(L.items.map((i) => i.unit), [...Array.from({ length: 8 }, (_, i) => [rows[i].id, rows[15 + i].id]).flat(), ...rows.slice(8, 12).map((r) => r.id)]);
  assert.equal(L.extra, 3);
});

// ---- boundary lead: a comparison against a named numeric constant that no matched test uses ----
const bsrc = (...ls) => ['export const LOW_SPACE_BYTES = 50 * 1024 * 1024;', 'export function check(f) {', ...ls, '}', 'export const pad1 = 1;'];
const bound = (t, src, files = {}) => { const { json } = leadRows(t, { 'src/precheck.js': src, ...files }); return require('./audit-units').staticLeads(json.rows).items.filter((i) => i.kind === 'boundary_unpinned'); };
const btest = (...ls) => ({ 'test/precheck.test.js': ["import { check, LOW_SPACE_BYTES } from '../src/precheck';", "it('checks', () => {", '  assert.equal(check({ freeBytes: 1 }), true);', ...ls, '});'] });
const BCMP = bsrc('  return f.freeBytes < LOW_SPACE_BYTES;');

test('boundary lead: a comparison with a named constant whose name and value no matched test uses is a lead (the test imports the constant and never uses it)', (t) => {
  assert.deepEqual(bound(t, BCMP, btest()).map((i) => [i.path, i.line, i.why]), [['src/precheck.js', 3, 'line 3 compares with LOW_SPACE_BYTES (= 52428800); no matched test uses LOW_SPACE_BYTES or its value']]);
});

test('boundary lead: control: a test that uses the constant by name or by value pins it; the name or number inside arithmetic does not', (t) => {
  assert.equal(bound(t, BCMP, btest('  assert.equal(check({ freeBytes: LOW_SPACE_BYTES }), false);')).length, 0);
  assert.equal(bound(t, BCMP, btest('  assert.equal(check({ freeBytes: 52_428_800 }), false);')).length, 0);
  assert.equal(bound(t, BCMP, btest('  assert.equal(check({ freeBytes: LOW_SPACE_BYTES - 1 }), true);')).length, 1);
});

test('boundary lead: control: a literal comparison, a unit with no matched test and a constant that is not a plain numeric expression make no lead', (t) => {
  assert.equal(bound(t, bsrc('  return f.freeBytes < 200;'), btest()).length, 0);
  assert.equal(bound(t, BCMP, { 'test/other.test.js': "it('x', () => { assert.equal(1, 1); });" }).length, 0);
  assert.equal(bound(t, ['export const LOW_SPACE_BYTES = os.total() / 2;', ...BCMP.slice(1)], btest()).length, 0);
});
