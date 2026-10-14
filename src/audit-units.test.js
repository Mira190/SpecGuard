const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { inventory, write, pick, risk, factorOf, publicCount, testSignals, history, sha8 } = require('./audit-units');
const { mapTests, testStem } = require('./test-map');

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

test('scope (scan_paths) limits both units and tests; test_paths makes any non-document file there a test', (t) => {
  const r = repo(t);
  const scoped = inventory({ cwd: r.root, head: 'HEAD', now: NOW, scope: (p) => p.startsWith('src/js/') || p.startsWith('test/') });
  assert.ok(scoped.rows.every((u) => u.path.startsWith('src/js/')));
  assert.deepEqual(scoped.rows.find((u) => u.path === 'src/js/cart.js').tests, ['test/cart.test.js']);
  const only = inventory({ cwd: r.root, head: 'HEAD', now: NOW, scope: (p) => p.startsWith('src/js/') });
  assert.deepEqual(only.rows.find((u) => u.path === 'src/js/cart.js').tests, [], 'a test outside the scope is not searched');
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
  assert.deepEqual(a.tally, { c: 1, n: 3, o: 0 });
  const b = pick(rows, 6, prior);
  assert.deepEqual(b.picked.map((r) => r.id), ['00000001', '00000004', '00000005', '00000006', '00000007', '00000002'], 'then the least recently reviewed');
  assert.deepEqual(b.tally, { c: 1, n: 4, o: 1 });
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
  assert.deepEqual(second.rotation, { rotate: true, picked: 4, confirming: 0, new: 4, oldest: 0, reviewed: 8, total: 11, run: 2, runs: 3 });
  assert.ok(second.picked.every((u) => !first.picked.some((v) => v.id === u.id)), 'the units reviewed last time rest');
  assert.deepEqual(second.carried.map((u) => u.id).sort(), first.picked.map((u) => u.id).sort());
  assert.equal(second.review(first.picked[0]), 'reviewed 2026-10-01');
  assert.equal(second.review(second.picked[0]), 'this run');
  assert.equal(second.review(second.rows.find((u) => !second.picked.includes(u) && !first.picked.some((v) => v.id === u.id))), 'not yet reviewed');
});

test('write: audit-units.txt, audit-units-carried.txt and audit-inventory.json carry the selected units, the totals and a capped risk table', (t) => {
  const { inv, root } = run(t, { maxUnits: 3 });
  const ctx = path.join(root, '.ctx');
  fs.mkdirSync(ctx);
  write(ctx, 'abc123', 3, inv);
  const rows = fs.readFileSync(path.join(ctx, 'audit-units.txt'), 'utf8').split('\n').filter(Boolean).map((l) => l.split('\t'));
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0].slice(0, 2), [sha8('src/js/orders.js'), 'src/js/orders.js']);
  assert.equal(rows[0].length, 6, 'id, path, risk, why, tests, leads');
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
