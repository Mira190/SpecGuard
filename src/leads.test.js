const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { run, assertionDelta, goneAtHead, declName, expectedArgs, mirrorCandidates, weakCandidates } = require('./leads.js');

// Temp repo: base commit, then head commit; ctx gets diff.patch and files.txt like collect.sh writes them. Returns the leads as {section: [lines]}.
function leads(t, baseFiles, headFiles, ctxFiles = {}, env = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'specguard-leads-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const write = (f, c) => { fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true }); fs.writeFileSync(path.join(root, f), c); };
  git('init'); git('config', 'user.name', 't'); git('config', 'user.email', 't@example.invalid'); git('config', 'core.autocrlf', 'false');
  for (const [f, c] of Object.entries({ 'README.txt': 'x\n', ...baseFiles })) write(f, c);
  git('add', '.'); git('commit', '-m', 'base');
  const base = git('rev-parse', 'HEAD').trim();
  for (const [f, c] of Object.entries(headFiles)) write(f, c);
  git('add', '-A'); git('commit', '-m', 'head');
  const ctx = path.join(root, '.ctx');
  fs.mkdirSync(ctx);
  fs.writeFileSync(path.join(ctx, 'diff.patch'), git('diff', '--no-color', '--no-ext-diff', '--no-renames', base + '...HEAD'));
  fs.writeFileSync(path.join(ctx, 'files.txt'), git('diff', '--name-only', base + '...HEAD').trim() + '\n');
  for (const [f, c] of Object.entries(ctxFiles)) fs.writeFileSync(path.join(ctx, f), c);
  const out = run(ctx, { cwd: root, env });
  const sections = {};
  for (const b of out.split(/\n(?=\S)/).filter(Boolean)) { const [h, ...rest] = b.trim().split('\n'); sections[h.replace(/:$/, '')] = rest.map((l) => l.trim()); }
  return { out, sections, root };
}
const NO = 'Changed symbols with no test reference', YES = 'Changed symbols referenced by tests', MIRROR = 'Possible mirror assertions (expected value taken from production code)';

test('symbols: untested vs tested across JS, Python, Go and Java; generic names and test files are skipped', (t) => {
  const { sections, out } = leads(t, { 'app/svc.py': 'class Svc:\n    def method_inner(self):\n        x = 1\n        return x\n' }, {
    'src/lib.js': 'export const MAX_DUR = 86399;\nexport function parseThing(s) {\n  return s;\n}\nexport function lonelyThing(x) {\n  return x;\n}\nexport function init() {}\nexport const arrowHelper = (x) => x;\n',
    'test/lib.test.js': 'import { parseThing, MAX_DUR } from "../src/lib";\nfunction helperInTest(x) {\n  return x;\n}\ntest("p", () => {});\n',
    'app/svc.py': 'class Svc:\n    def method_inner(self):\n        x = 2\n        return x\n\ndef compute_total(x):\n    return x\n\ndef tested_py():\n    pass\n',
    'tests/test_svc.py': 'from svc import tested_py\ndef test_a():\n    tested_py()\n',
    'pkg/calc.go': 'package pkg\n\nfunc ComputeFee(x int) int {\n\treturn x\n}\n\nfunc (c *Calc) TestedGo() int {\n\treturn 1\n}\n',
    'pkg/calc_test.go': 'package pkg\n\nfunc TestIt(t *testing.T) { c.TestedGo() }\n',
    'src/main/java/Limits.java': 'public class Limits {\n  public static int parseLimit(String s) {\n    return 1;\n  }\n}\n',
    'src/test/java/LimitsTest.java': 'class LimitsTest { void a() { Limits.parseLimit("x"); } }\n',
  });
  const none = sections[NO].map((l) => l.replace(/^\S+:\d+ /, '')).sort();
  assert.deepEqual(none, ['ComputeFee', 'arrowHelper', 'compute_total', 'lonelyThing', 'method_inner'], out);
  assert.match(sections[NO].join('\n'), /app\/svc\.py:2 method_inner/); // body change attributed to the enclosing method, not the class
  const yes = Object.fromEntries(sections[YES].map((l) => l.split(' -> ')));
  assert.equal(yes.parseThing, 'test/lib.test.js');
  assert.equal(yes.tested_py, 'tests/test_svc.py');
  assert.equal(yes.TestedGo, 'pkg/calc_test.go');
  assert.equal(yes.parseLimit, 'src/test/java/LimitsTest.java');
  assert.equal(yes.Limits, 'src/test/java/LimitsTest.java');
  assert.ok(!/\binit\b|helperInTest|MAX_DUR/.test(out.split('Possible')[0]), 'generic names, test-file symbols and constants are not symbols');
});

test('symbols: test_paths narrows what counts as a test; a reference outside it is no test reference', (t) => {
  const { sections } = leads(t, {}, { 'src/lib.js': 'export function fooBar() {\n  return 1;\n}\n', 'spec2/x.js': 'fooBar();\n', 'check/y.js': 'fooBar();\n' }, {}, { TEST_PATHS: 'check/' });
  assert.deepEqual(sections[YES], ['fooBar -> check/y.js']);
});

test('mirror assertions: constants from production code are flagged; literals, local constants and unknown names are not', (t) => {
  const { sections } = leads(t, {}, {
    'src/lib.js': 'export const MAX_DUR = 86399;\nexport const LIMIT = 5;\nexport function parseHms(s) {\n  return 1;\n}\n',
    'test/lib.test.js': [
      'import { parseHms, MAX_DUR, LIMIT } from "../src/lib";',
      'const LOCAL_MAX = 5;',
      "assert.equal(parseHms('23:59:59'), MAX_DUR);", //  3 mirror
      "assert.equal(parseHms('0:0:1'), 86399);", //        4 literal
      'assert.equal(parseHms("x"), LOCAL_MAX);', //        5 local constant
      'expect(parseHms("y")).toBe(LIMIT);', //             6 mirror
      'expect(parseHms("z")).toBe(NOT_IN_CODE);', //       7 unknown name
      'expect(parseHms("z")).toEqual({ a: 1 });', //       8 literal
      '',
    ].join('\n'),
  });
  assert.deepEqual(sections[MIRROR], ['test/lib.test.js:3 MAX_DUR', 'test/lib.test.js:6 LIMIT']);
});

test('mirror assertions: Python, Go, Java forms, in a candidate test that the PR did not change', (t) => {
  const { sections } = leads(t, {
    'tests/test_svc.py': 'from svc import MAX_ITEMS, compute\n\nclass T(TestCase):\n    def test_a(self):\n        self.assertEqual(compute(1), MAX_ITEMS)\n        assert compute(2) == 7\n        assert compute(3) == MAX_ITEMS\n',
    'pkg/calc_test.go': 'package pkg\n\nimport (\n\t"testing"\n\t"example.com/x/calc"\n)\n\nfunc TestA(t *testing.T) {\n\tassert.Equal(t, calc.MaxFee, got)\n\tassert.Equal(t, 42, got)\n\tassert.Equal(t, want.Name, got.Name)\n}\n',
    'src/test/java/LimitsTest.java': 'class LimitsTest {\n  void a() {\n    assertEquals(Limits.MAX_LEN, parse("x"));\n    assertEquals(5, parse("x"));\n  }\n}\n',
    'svc.py': 'MAX_ITEMS = 3\n', 'calc/calc.go': 'package calc\nconst MaxFee = 9\n', 'src/main/java/Limits.java': 'public class Limits { public static final int MAX_LEN = 10; }\n',
  }, { 'svc.py': 'MAX_ITEMS = 3\ndef compute(x):\n    return x\n' },
  { 'test-candidates.txt': 'svc.py\n  tests/test_svc.py  (same name)\npkg/calc.go\n  pkg/calc_test.go  (same name)\nsrc/main/java/Limits.java\n  src/test/java/LimitsTest.java  (same name)\n' });
  assert.deepEqual(sections[MIRROR], ['tests/test_svc.py:5 MAX_ITEMS', 'tests/test_svc.py:7 MAX_ITEMS', 'pkg/calc_test.go:9 calc.MaxFee', 'src/test/java/LimitsTest.java:3 Limits.MAX_LEN']);
});

test('no leads, no output; a focused review only gets leads for the chosen files', (t) => {
  assert.equal(leads(t, {}, { 'docs/a.md': 'x\n', 'cfg.json': '{}\n' }).out, '');
  const { sections } = leads(t, {}, { 'src/a.js': 'export function aaaThing() {\n  return 1;\n}\n', 'src/b.js': 'export function bbbThing() {\n  return 1;\n}\n' }, { 'focus.txt': 'src/b.js\t5\treason\n' });
  assert.deepEqual(sections[NO], ['src/b.js:1 bbbThing']);
});

const WEAK = 'Weak assertions (only existence, truthiness or type is checked)';
const weak = (src) => weakCandidates(src).map((c) => `${c.line} ${c.x} ${c.what}`);

test('weak classifier: node:test t.assert.ok is seen, foo.assert.ok is not', () => {
  assert.deepEqual(weak("test('a', (t) => {\n  const result = f();\n  t.assert.ok(result);\n  foo.assert.ok(other);\n});\n"), ['3 result truthy']);
});
test('weak classifier: toBeInstanceOf / toBeTypeOf pin the class, toBeDefined stays weak', () => {
  assert.deepEqual(weak("it('a', () => {\n  expect(p).toBeInstanceOf(Foo);\n  expect(e).toBeTypeOf('number');\n  expect(user).toBeDefined();\n});\n"), ['4 user exists']);
});
test('weak classifier: boolean values are value checks, objects stay weak', () => {
  assert.deepEqual(weak("it('a', async () => {\n  expect(handlerExecuted).toBeTruthy();\n  expect(c.req.headers.has('x')).toBeTruthy();\n  expect(await isMatch(a, b)).toBeTruthy();\n  expect(app2).not.toBeUndefined();\n  expect(result).toBeTruthy();\n});\n"), ['5 app2 exists', '6 result truthy']);
  assert.deepEqual(weak("def test_a():\n    assert app_after_called\n    assert rv.is_json\n    assert session.modified\n    assert result\n"), ['5 result truthy']);
});
test('weak classifier: ok flags and Equal/Match helpers are booleans, a plain result stays weak', () => {
  assert.deepEqual(weak("test('a', (t) => {\n  t.assert.ok(result.ok);\n  t.assert.ok(result2.ok);\n  t.assert.ok(ok);\n  t.assert.ok(ok2);\n  t.assert.ok(partialDeepStrictEqual(line, x));\n  t.assert.ok(isMatch(a));\n  t.assert.ok(result);\n});\n"), ['8 result truthy']);
});
test('weak classifier: Go nil guard is skipped when else or a later line pins the value', () => {
  assert.deepEqual(weak('func TestA(t *testing.T) {\n\tif got == nil {\n\t\tt.Fatal("x")\n\t} else if got.Name() != "a" {\n\t\tt.Error("y")\n\t}\n}\n'), []);
  assert.deepEqual(weak('func TestA(t *testing.T) {\n\tif called == nil {\n\t\tt.Fatal("x")\n\t}\n\tif called.Name() != "a" {\n\t\tt.Error("y")\n\t}\n}\n'), []);
  assert.deepEqual(weak('func TestA(t *testing.T) {\n\tif got == nil {\n\t\tt.Fatal("x")\n\t}\n}\n'), ['2 got exists']);
});

test('weak assertions: every language form is a lead', () => {
  assert.deepEqual(weak("test('a', () => {\n  const total = f();\n  assert.ok(total);\n  assert(total2);\n  assert.ok(total3, 'msg');\n  assert.notEqual(r, null);\n  assert.notStrictEqual(r2, undefined);\n  assert(typeof r3 === 'number');\n  assert.ok(!!r4);\n});\n"),
    ['3 total truthy', '4 total2 truthy', '5 total3 truthy', '6 r exists', '7 r2 exists', '8 r3 type', '9 r4 truthy']);
  assert.deepEqual(weak("it('a', () => {\n  expect(f(1)).toBeDefined();\n  expect(a).toBeTruthy();\n  expect(b).not.toBeNull();\n  expect(c).not.toBeUndefined();\n});\n"),
    ['2 f(1) exists', '3 a truthy', '4 b exists', '5 c exists']);
  assert.deepEqual(weak("def test_a():\n    assert x\n    assert y is not None\n    assert z, 'msg'\n    self.assertIsNotNone(r)\n    self.assertTrue(q)\n    self.assertTrue(s is not None)\n"),
    ['2 x truthy', '3 y exists', '4 z truthy', '5 r exists', '6 q truthy', '7 s exists']);
  assert.deepEqual(weak('@Test\nvoid a() {\n  assertNotNull(r);\n  assertNotNull("msg", r2);\n  assertTrue(s != null);\n}\n'), ['3 r exists', '4 r2 exists', '5 s exists']);
  assert.deepEqual(weak('func TestA(t *testing.T) {\n\tif got == nil {\n\t\tt.Fatal("x")\n\t}\n\tif err == nil {\n\t\tt.Fatal("y")\n\t}\n\tassert.NotNil(t, v)\n}\n'), ['2 got exists', '8 v exists']);
  assert.deepEqual(weak('[Fact]\npublic void A() {\n  Assert.IsNotNull(r);\n  Assert.NotNull(r2);\n}\n'), ['3 r exists', '4 r2 exists']);
});

test('weak assertions: value assertions, toBeNull, predicates and comments are not leads; a value on the same result in the same test excludes it', () => {
  assert.deepEqual(weak("test('a', () => {\n  assert.ok(total);\n  assert.equal(total, 40);\n});\ntest('b', () => {\n  assert.ok(total);\n});\n"), ['6 total truthy']);
  assert.deepEqual(weak("it('a', () => {\n  expect(f(1)).toBeDefined();\n  expect(f(1)).toBe(5);\n});\nit('b', () => {\n  expect(g()).toBeDefined();\n  expect(h()).toBe(5);\n});\n"), ['6 g() exists']);
  assert.deepEqual(weak('def test_a():\n    assert x is not None\n    assert x == 3\ndef test_b():\n    assert y\n    assert x == 3\n'), ['5 y truthy']);
  assert.deepEqual(weak('@Test void a() { assertNotNull(r); assertEquals(1, r.size()); }\n'), []);
  assert.deepEqual(weak("test('a', () => {\n  expect(a).toBeNull();\n  expect(b).toBeUndefined();\n  expect(c).toBe(1);\n  assert.ok(isValid(x));\n  assert.ok(x === 5);\n  assert.ok(true);\n  assert.equal(a, 1);\n  // assert.ok(z);\n  const re = /x/; re.test(y);\n});\n"), []);
});

test('weak assertions: lead lines in changed and candidate tests, capped', (t) => {
  const { sections, out } = leads(t, {}, { 'src/discount.js': 'exports.f = (x) => x;\n', 'src/discount.test.js': "test('a', () => {\n  const total = f(1);\n  assert.ok(total);\n});\n" });
  assert.deepEqual(sections[WEAK], ['weak? src/discount.test.js:3 — assert.ok(total); only checks that total is truthy; nothing pins its value']);
  const many = Array.from({ length: 40 }, (_, i) => `test('t${i}', () => {\n  assert.ok(value${i});\n});\n`).join('');
  const big = leads(t, {}, { 'src/a.test.js': many });
  assert.equal(big.sections[WEAK].length, 16);
  assert.match(big.sections[WEAK][15], /^\(25 more not listed\)$/);
  assert.ok(Buffer.byteLength(big.out) <= 5.5 * 1024);
  assert.ok(out.includes('Weak assertions'));
});

test('helpers: declaration forms, assertion argument extraction', () => {
  for (const [line, name] of [['function foo() {', 'foo'], ['export async function* gen(a) {', 'gen'], ['def bar(self):', 'bar'], ['func (r *T) Baz(x int) {', 'Baz'], ['pub fn qux() -> u8 {', 'qux'],
    ['class Widget extends B {', 'Widget'], ['  public static int parseLimit(String s) {', 'parseLimit'], ['const fn1 = (a, b) => a + b;', 'fn1'], ['const fn2 = async x => x;', 'fn2'], ['  doIt(a, b) {', 'doIt'], ['fun greet(n: String) {', 'greet']])
    assert.equal(declName(line), name, line);
  for (const line of ['if (x) {', '} else if (y) {', 'const x = (1 + 2) * 3;', 'return foo(x);', '// function commented()', 'for (const a of b) {', 'catch (e) {'])
    assert.equal(declName(line), null, line);
  assert.deepEqual(expectedArgs("assert.equal(f(1, 2), MAX)"), ['MAX']);
  assert.deepEqual(expectedArgs('assertEquals(MAX, f(1, 2));'), ['MAX']);
  assert.deepEqual(expectedArgs('assert.Equal(t, MAX, f(1))'), ['MAX']);
  assert.deepEqual(expectedArgs('expect(f(1, "a,b")).toBe(MAX);'), ['MAX']);
  assert.deepEqual(expectedArgs('assert f(1) == MAX'), ['MAX']);
  assert.deepEqual(mirrorCandidates('const E = 1;\nexpect(f()).toBe(E);\n'), []);
});

test('weak leads: assert.ok of a helper call comparing explicit values is a real check, a bare result is a lead', () => {
  assert.deepEqual(weak("it('a', () => {\n  assert.ok(has(t('avi'), '-c:v', 'mpeg4'));\n});"), []);
  assert.deepEqual(weak("it('a', () => {\n  assert.ok(result);\n});"), ['2 result truthy']);
});

const mkdiff = (file, body) => `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -10,6 +10,6 @@\n${body}`;
const delta = (body) => assertionDelta(mkdiff('test/x.test.ts', body), () => true).map((d) => `${d.kind} ${d.line} ${d.new ? d.old + ' => ' + d.new : d.old}`);

test('removed or weakened assertions: a removed assertion and deepEqual turned into ok are leads', () => {
  assert.deepEqual(delta(" a\n-  assert.equal(check('BIG'), true);\n+  assert.equal(check('big'), true);\n b\n"), ["removed 11 assert.equal(check('BIG'), true);"]);
  assert.deepEqual(delta(" a\n-  assert.deepEqual(regionToCrop(r, f), { x: 1 });\n+  assert.ok(regionToCrop(r, f));\n"), ['weakened 11 assert.deepEqual(regionToCrop(r, f), { x: 1 }); => assert.ok(regionToCrop(r, f));']);
});
test('removed or weakened assertions: a move, a reformat or a stronger replacement is no lead', () => {
  assert.deepEqual(delta("-  assert.equal(f(1), 2);\n+  assert.strictEqual(f( 1 ), 2);\n"), []);
  assert.deepEqual(delta("-  assert.equal(f(1), 2);\n+  assert.equal(g(), 3);\n+  assert.equal(f(1), 2);\n"), []);
  assert.deepEqual(delta("-  assert.ok(f(1));\n+  assert.deepEqual(f(1), { a: 1 });\n"), []);
  assert.deepEqual(delta("-  // assert.equal(f(1), 2);\n+  const x = 1;\n"), []);
  assert.deepEqual(delta("-  assert.ok(f(1));\n+  assert.ok(f( 1 ));\n"), [], 'a reformatted weak assertion was already weak: not weakened');
});

test('removed assertions: a helper refactor re-pins the calls it wraps; only the assertion deleted outright is a lead (synthetic catalog)', () => {
  const diff = fs.readFileSync(path.join(__dirname, 'fixtures/helper-refactor.diff'), 'utf8');
  const d = assertionDelta(diff, () => true);
  assert.deepEqual(d.map((x) => [x.kind, x.line]), [['removed', 4]]);
  assert.match(d[0].old, /'DUP'.*'west'.*duplicate/);
});
test('removed assertions: a complete move into a parameter table is no lead; a row dropped in the move, or rows that only share the numbers across rows, stay leads (review F01/P3)', () => {
  const table = (rows) => `-  assert.equal(next(1), 2);\n-  assert.equal(next(2), 3);\n+  for (const [input, expected] of ${rows}) {\n+    assert.equal(next(input), expected);\n+  }\n`;
  assert.deepEqual(delta(table('[[1, 2], [2, 3]]')), []);
  assert.deepEqual(delta(table('[{ input: 1, expected: 2 }, { input: 2, expected: 3 }]')), [], 'object rows');
  assert.deepEqual(delta(table('[[1, 2]]')), ['removed 11 assert.equal(next(2), 3);'], 'the exact-now row was dropped in the move');
  assert.deepEqual(delta(table('[[1, 2], [3, 4]]')), ['removed 11 assert.equal(next(2), 3);'], '2 and 3 sit in different rows');
  assert.deepEqual(delta('-  assert.equal(next(2), 3);\n+  const cases = [[2, 3]];\n'), ['removed 10 assert.equal(next(2), 3);'], 'a table with no assertion on the same function re-pins nothing');
  // review F14: the table must feed the assertion; unrelated data or a literal assertion keeps the lead
  assert.deepEqual(delta('-  assert.equal(next(2), 3);\n+  const otherCases = [[2, 3]];\n+  assert.equal(next(10), 11);\n'), ['removed 10 assert.equal(next(2), 3);'], 'unused array, literal assertion');
  const named = (decls) => delta(`-  assert.equal(next(1), 2);\n-  assert.equal(next(2), 3);\n${decls}+  for (const [i, e] of cases) {\n+    assert.equal(next(i), e);\n+  }\n`);
  assert.deepEqual(named('+  const cases = [[1, 2], [2, 3]];\n'), [], 'a named table the loop iterates');
  assert.deepEqual(named('+  const otherCases = [[2, 3]];\n+  const cases = [[1, 2]];\n'), ['removed 11 assert.equal(next(2), 3);'], 'the row sits in an array the loop does not read');
  assert.deepEqual(named('+  const cases = [\n+    [1, 2],\n+    [2, 3],\n+  ];\n'), [], 'a multi-line named table');
});

test('removed assertions: a synthetic fold into a typed TypeScript table with nested calls in each row: only the dropped exact-now case is a lead', () => {
  const diff = fs.readFileSync(path.join(__dirname, 'fixtures/table-refactor.diff'), 'utf8');
  assert.deepEqual(assertionDelta(diff, () => true).map((x) => [x.kind, x.line]), [['removed', 3]]);
  // a row is one element of the table, not a run of literals across rows
  assert.deepEqual(delta('-  assert.deepEqual(f(at(1, 2), 3), 4);\n+  const cases: [Date, number, number][] = [[at(1, 2), 3, 9], [at(0, 0), 4, 4]];\n+  for (const [d, x, y] of cases) assert.deepEqual(f(d, x), y);\n'), ['removed 10 assert.deepEqual(f(at(1, 2), 3), 4);']);
});

test('removed assertions: a replacement line over 400 characters still re-pins its subject (found by SpecGuard on PR 195)', () => {
  assert.deepEqual(delta(`-  assert.match(p, /short note/);\n+  assert.match(p, /${'longer note '.repeat(40)}/);\n`), []);
});

test('removed assertions: assert.match, notEqual and throws count as assertions', () => {
  const d = assertionDelta('diff --git a/t.test.js b/t.test.js\n--- a/t.test.js\n+++ b/t.test.js\n@@ -1,4 +1,1 @@\n-assert.match(f("zq1"), /x/)\n-assert.notEqual(g("zq2"), 1)\n-assert.throws(() => h("zq3"), /bad/)\n x\n', () => true);
  assert.equal(d.length, 3);
});

test('removed assertions: only an added assertion in the same hunk re-pins; one in another test does not (audit U5)', () => {
  const a = " test('a', () => {\n   const result = run();\n-  expect(result).toEqual({a:1,b:2});\n   done();\n });\n";
  const c = "@@ -40,3 +40,4 @@\n test('c', () => {\n   const result = other();\n+  expect(result).toBe(true);\n });\n";
  const two = (add) => assertionDelta(mkdiff('t/x.test.js', a + add), () => true).map((d) => d.kind);
  assert.deepEqual(two(c), ['removed'], 'an unrelated assertion on the same name elsewhere hides nothing');
  assert.deepEqual(two("+  expect(result).toEqual({a:1,b:2});\n"), [], 'control: a same-hunk re-pin is suppressed');
  assert.deepEqual(delta("-  expect(f(1)).toBe(2);\n+  expect(g(1)).toBe(3);\n"), ['removed 10 expect(f(1)).toBe(2);'], 'control: a different subject stays removed');
});
test('weakened assertions: an exact value replaced by a range matcher on the same subject is weakened (audit U5)', () => {
  assert.deepEqual(delta("-  expect(total(2)).toBe(5);\n+  expect(total(2)).toBeGreaterThan(0);\n"), ['weakened 10 expect(total(2)).toBe(5); => expect(total(2)).toBeGreaterThan(0);']);
  assert.deepEqual(delta("-  expect(total(2)).toBe(5);\n+  expect(total(2)).toBe(6);\n"), [], 'control: another exact value is still a pin');
});
test('removed assertions: a deleted test file gives removed leads under its old path (audit U6)', () => {
  const del = 'diff --git a/t/x.test.js b/t/x.test.js\ndeleted file mode 100644\n--- a/t/x.test.js\n+++ /dev/null\n@@ -1,3 +0,0 @@\n-test("f", () => {\n-  expect(f(1)).toBe(2);\n-});\n';
  assert.deepEqual(assertionDelta(del, () => true).map((d) => [d.file, d.kind, d.line]), [['t/x.test.js', 'removed', 2]]);
});
test('removed assertions: an assertion cut from one hunk and pasted unchanged into another is no lead', () => {
  const d = mkdiff('t/x.test.js', " test('a', () => {\n-  expect(result).toEqual({a:1,b:2});\n });\n@@ -40,3 +40,4 @@\n test('c', () => {\n+  expect(result).toEqual({ a: 1, b: 2 });\n });\n");
  assert.deepEqual(assertionDelta(d, () => true), []);
});

test('symbols: with test_paths set, a test-named file outside it is no test reference (same rule as the cover guard)', (t) => {
  const { sections } = leads(t, {}, { 'src/lib.js': 'export function fooBar() {\n  return 1;\n}\n', 'test/x.test.js': 'fooBar();\n', 'check/y.js': 'fooBar();\n' }, {}, { TEST_PATHS: 'check/' });
  assert.deepEqual(sections[YES], ['fooBar -> check/y.js']);
});

test('removed assertions: text inside a string literal is not an assertion', () => {
  assert.deepEqual(delta("-  const body = ' assertion removed: assert.equal(validateBaseName(\\'new name\\', 1), true)';\n+  const body = 'x';\n"), []);
  assert.deepEqual(delta("-  const s = `assert.match(f(1), /a/)`;\n+  const s = 1;\n"), []);
  assert.deepEqual(delta("-  assert.match(validateBaseName('BIG', '.mp4', others), /已存在/);\n+  const x = 1;\n"), ["removed 10 assert.match(validateBaseName('BIG', '.mp4', others), /已存在/);"]);
});
test('removed assertions: one whose function no longer exists at head went with its code, one whose function stays is a lead', () => {
  const src = mkdiff('src/x.ts', "-export function packGuard(r) {}\n-export function validateBaseName(a) {}\n-const S = new Set();\n");
  const d = (gone, dropSrc = true) => assertionDelta((dropSrc ? src : '') + mkdiff('test/x.test.ts', "-  assert.match(packGuard(p), /context pack is empty/);\n-  assert.match(validateBaseName('BIG', '.mp4', o), /x/);\n-  assert.equal(new Set(a).size, 1);\n+  const x = 1;\n"), (f) => f.includes('.test.'), gone).map((x) => x.old);
  assert.equal(d().length, 3);
  assert.deepEqual(d((n) => n === 'packGuard' || n === 'Set').map((x) => x.slice(0, 22)), ['assert.match(validateB', 'assert.equal(new Set(a'], 'only the function this diff dropped and head lacks; `new Set` is no function of the code');
  assert.equal(d((n) => n === 'packGuard', false).length, 3, 'a name this diff never dropped is not claimed gone');
});
test('goneAtHead: a name only in test files is gone, one in source is not, git failing keeps the lead', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gone-')), git = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' });
  git('init', '-q');
  fs.writeFileSync(path.join(dir, 'a.js'), 'function alive() {}\n');
  fs.writeFileSync(path.join(dir, 'a.test.js'), 'alive(); onlyInTest();\n');
  git('add', '.');
  const g = goneAtHead(dir, (p) => p.endsWith('.test.js'));
  assert.deepEqual([g('alive'), g('onlyInTest'), g('nowhere')], [false, true, true]);
  assert.equal(goneAtHead(path.join(dir, 'missing'), () => false)('alive'), false, 'git cannot say: not gone');
  fs.rmSync(dir, { recursive: true, force: true });
});
test('removed or weakened assertions: a loop-prefixed assertion extended past 400 chars still re-pins; a different subject is still removed', () => {
  const pad = (n) => Array.from({ length: n }, (_, i) => `'case${i}'`).join(', ');
  const loop = (n, subj, want = 'covered') => `  for (const p of [${pad(n)}]) assert.equal(run(${subj}).status, '${want}', p);\n`;
  assert.ok(loop(20, 'evOf(p)').length < 400 && loop(60, 'evOf(p)').length > 400);
  assert.deepEqual(delta(`-${loop(20, 'evOf(p)')}+${loop(60, 'evOf(p)')}`), []);
  assert.deepEqual(delta(`-${loop(20, 'evOf(p)')}+${loop(60, 'other(p)', 'gap')}`), ['removed 10 for (const p of [' + pad(20) + "]) assert.equal(run(evOf(p)).status, 'covered', p);"]);
});

test('removed assertions: a removed loop line over 400 chars is read in full (assertion past char 400; name dropped past char 400)', () => {
  const pad = (n) => Array.from({ length: n }, (_, i) => `'case${i}'`).join(', ');
  const loop = (subj) => `  for (const p of [${pad(60)}]) assert.equal(run(${subj}).status, 'covered', p);\n`;
  assert.ok(loop('evOf(p)').length > 400);
  assert.deepEqual(delta(`-${loop('evOf(p)')}+  const x = 1;\n`).map((x) => x.slice(0, 10)), ['removed 10']);
  assert.deepEqual(delta(`-${loop('evOf(p)')}+${loop('evOf(p)')}`), []);
  const src = mkdiff('src/x.ts', `-const T = [${pad(60)}]; export function lateGuard(r) {}\n`);
  const d = (gone) => assertionDelta(src + mkdiff('test/x.test.ts', "-  assert.equal(lateGuard(p), 1);\n+  const x = 1;\n"), (f) => f.includes('.test.'), gone).length;
  assert.equal(d((n) => n === 'lateGuard'), 0);
  assert.equal(d(() => false), 1);
});
test('removed assertions: a long added line equal to the removed one in its first 400 chars but with another trailing subject is no move', () => {
  const pad = Array.from({ length: 60 }, (_, i) => `'case${i}'`).join(', ');
  const loop = (subj, want) => `  for (const p of [${pad}]) assert.equal(run(${subj}).status, '${want}', p);\n`;
  assert.deepEqual(delta(`-${loop('evOf(p)', 'covered')}+${loop('other(p)', 'gap')}`).map((x) => x.slice(0, 10)), ['removed 10']);
  assert.deepEqual(delta(`-${loop('evOf(p)', 'covered')}+${loop('evOf(p)', 'covered')}`), []);
});
test('removed assertions: a table-driven added line over 400 chars keeps its rows past char 400', () => {
  const row = (last) => `+  for (const [input, expected] of [${Array.from({ length: 50 }, (_, i) => `[${i + 10}, ${i + 11}]`).join(', ')}, ${last}]) assert.equal(next(input), expected);\n`;
  assert.ok(row('[2, 3]').length > 500);
  assert.deepEqual(delta(`-  assert.equal(next(2), 3);\n${row('[2, 3]')}`), []);
  assert.deepEqual(delta(`-  assert.equal(next(2), 3);\n${row('[2, 4]')}`), ['removed 10 assert.equal(next(2), 3);']);
});
test('removed assertions: 50 literal-dense added lines of ~100 KB each finish fast (literal sets computed once per entry)', () => {
  const dense = (k) => `  assert.equal(f${k}(x), { ${Array.from({ length: 6000 }, (_, i) => `k${i}: 'v${i}_${k}'`).join(', ')} });\n`;
  let body = `-${dense(0)}`;
  for (let k = 1; k <= 50; k++) body += `+${dense(k)}`;
  const t = Date.now();
  assert.equal(delta(body).length, 1);
  assert.ok(Date.now() - t < 2000, `took ${Date.now() - t} ms`);
});

test('removed assertions: counterexamples for in-place edits (a token-subsequence "only adds" rule was evaluated and not adopted: it would hide the inverted assertion)', () => {
  assert.deepEqual(delta("-  assert.equal(f(1), 2);\n+  assert.equal(f(2), 3);\n"), ['removed 10 assert.equal(f(1), 2);'], 'input 1 dropped');
  assert.ok(delta("-  assert.match(validateBaseName('BIG', '.mp4', others), /x/); // case-insensitive FS\n+  assert.match(check('a'), /x/);\n").some((d) => d.includes("'BIG'")), 'Kite #10: the BIG case removed');
  assert.deepEqual(delta("-  assert.deepEqual(nextTrigger(a, 10, 0, 0), x);\n+  for (const [n, h, w] of cases) assert.deepEqual(nextTrigger(n, h, 0, 0), w);\n"), ['removed 10 assert.deepEqual(nextTrigger(a, 10, 0, 0), x);'], 'Kite #12: a table row dropped');
  assert.deepEqual(delta("-  assert.ok(f(x));\n+  assert.ok(!f(x));\n"), ['removed 10 assert.ok(f(x));'], 'an inverted assertion');
});
