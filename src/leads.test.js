const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { run, declName, expectedArgs, mirrorCandidates } = require('./leads.js');

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
