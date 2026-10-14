const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { run, assertionDelta, declName, expectedArgs, mirrorCandidates, weakCandidates } = require('./leads.js');

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

test('weak assertions: every language form is a lead', () => {
  assert.deepEqual(weak("test('a', () => {\n  const total = f();\n  assert.ok(total);\n  assert(total2);\n  assert.ok(total3, 'msg');\n  assert.notEqual(r, null);\n  assert.notStrictEqual(r2, undefined);\n  assert(typeof r3 === 'number');\n  assert.ok(!!r4);\n});\n"),
    ['3 total truthy', '4 total2 truthy', '5 total3 truthy', '6 r exists', '7 r2 exists', '8 r3 type', '9 r4 truthy']);
  assert.deepEqual(weak("it('a', () => {\n  expect(f(1)).toBeDefined();\n  expect(a).toBeTruthy();\n  expect(b).not.toBeNull();\n  expect(c).not.toBeUndefined();\n  expect(d).toBeInstanceOf(Foo);\n  expect(e).toBeTypeOf('number');\n});\n"),
    ['2 f(1) exists', '3 a truthy', '4 b exists', '5 c exists', '6 d type', '7 e type']);
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
});
