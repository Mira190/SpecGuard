// Express-shaped fixture: one test file per public method (test/res.status.js for lib/response.js), supertest-style assertions, an error message asserted by a regex.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { inventory, testSignals } = require('./audit-units');
const { mapTests, publicDefs, needlesOf, makeCoverGuard } = require('./test-map');
const { ASSERTION } = require('./post');
const { weakCandidates } = require('./leads');

const RESPONSE = [
  "var res = Object.create(http.ServerResponse.prototype);",
  "module.exports = res;",
  "res.status = function status(code) {",
  "  if (!Number.isInteger(code)) {",
  "    throw new TypeError(`Invalid status code: ${JSON.stringify(code)}. Status code must be an integer.`);",
  "  }",
  "  this.statusCode = code;",
  "  return this;",
  "};",
  "res.cookie = function (name, value, options) {",
  "  var opts = { ...options };",
  "  var secret = this.req.secret;",
  "  var signed = opts.signed;",
  "  if (signed && !secret) {",
  "    throw new Error('cookieParser(\"secret\") required for signed cookies');",
  "  }",
  "  return this;",
  "};",
  "res.vary = res.varyHeader = function vary(field) {",
  "  return this;",
  "};",
];
const FILES = {
  'lib/response.js': RESPONSE,
  'lib/other.js': ['exports.noop = function noop() {', '  return 1;', '};', 'exports.nothing = function nothing() {', '  return 2;', '};'],
  'test/res.status.js': [
    "describe('res', function () {",
    "  describe('.status(code)', function () {",
    "    it('should set the response .statusCode', function (done) {",
    "      request(createApp(201)).get('/').expect(201, 'Created', done)",
    "    })",
    "    it('should throw for non-integer codes', function (done) {",
    "      request(createApp(1.5)).get('/').expect(500, /Invalid status code/, done)",
    "    })",
    "  })",
    "})",
  ],
  'test/res.cookie.js': [
    "describe('res', function () {",
    "  it('should throw if signed without a secret', function (done) {",
    "    request(app).get('/').expect(500, /secret\\S+ required for signed cookies/, done)",
    "  })",
    "  it('sets a cookie', function (done) {",
    "    request(app).get('/').expect('Set-Cookie', 'name=tobi; Path=/', done)",
    "  })",
    "})",
  ],
  'test/app.options.js': ["it('responds', function (done) {", "  request(app).options('/').expect(200, done)", "})"],
  'test/exports.js': ["it('exposes', function () {", "  assert.equal(typeof express.json, 'function')", "})"],
};

function repo(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'specguard-map-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const git = (...a) => execFileSync('git', ['-c', 'core.autocrlf=false', ...a], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init'); git('config', 'user.name', 'SpecGuard test'); git('config', 'user.email', 'test@example.invalid');
  for (const [f, s] of Object.entries(FILES)) { fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true }); fs.writeFileSync(path.join(root, f), s.join('\n') + '\n'); }
  git('add', '.'); git('commit', '-m', 'init');
  return root;
}

test('public names: assignments (also chained), exports, declarations', () => {
  assert.deepEqual(publicDefs('lib/response.js', RESPONSE).names, ['status', 'cookie', 'vary', 'varyHeader']);
  assert.equal(publicDefs('lib/response.js', RESPONSE).count, 4);
  assert.deepEqual(publicDefs('a.js', ['exports.create = (o) => o;', 'export function remove() {}']).names, ['create', 'remove']);
  assert.deepEqual(publicDefs('lib/request.js', ["defineGetter(req, 'fresh', function(){", "Object.defineProperty(exports, 'protocol', {"]).names, ['fresh', 'protocol'], 'properties defined by name');
});

test('assertion styles: supertest, chai, should, sinon, tap/ava, testify, XCTest, pytest, unittest count; a bare call does not', () => {
  for (const l of ["  .expect(500, /Invalid status code/, done)", "  expect(x).to.equal(1)", "  x.should.equal(1)", "  should(x).be.ok()", "  sinon.assert.calledOnce(spy)",
    "  t.equal(a, b)", "  t.same(a, b)", "  t.ok(a)", "  t.throws(() => f())", "  assertThat(x, is(1))", "  require.Equal(t, 1, x)", "  assert.Equal(t, 1, x)", "  XCTAssertEqual(a, b)",
    "  with pytest.raises(ValueError):", "  self.assertEqual(a, b)", "  await expect(p).rejects.toThrow()"]) assert.ok(ASSERTION.test(l), l);
  for (const l of ["  request(app).get('/')", "  test(app1);", "  t.plan(1)"]) assert.ok(!ASSERTION.test(l), l);
  // a keyword inside a name, an import or a test title is no assertion (review F13); a python assert statement still is
  for (const l of ['const expectedTotal = 42;', "const assert = require('node:assert/strict');", "import assert from 'node:assert';", "it('should work and throws nothing', () => {", "  throw new Error('bad');", 'const n = expected.length;']) assert.ok(!ASSERTION.test(l), l);
  assert.ok(ASSERTION.test('    assert total == 42'));
  assert.ok(ASSERTION.test('  assert_eq!(a, b);'));
  // a helper named test(app) is not a test declaration, so its tests are not counted as tests without an assertion
  const s = testSignals(["describe('x', function () {", '  function check(app) {', '    test(app);', '  }', "  it('a', function (done) {", '    request(app).get("/").expect(200, done)', '  })', '})'].join('\n'));
  assert.deepEqual([s.tests, s.noAssert, s.asserts], [1, 0, 1]);
  assert.ok(weakCandidates('it("a", () => {\n  assert.ok(x)\n})\n').length > 0, 'assert.ok stays weak');
});

test('mapping: same stem > public name in the file name > calls > mention > same directory; names under 4 characters and generic names do not match', () => {
  const tests = Object.keys(FILES).filter((f) => f.startsWith('test/'));
  const names = publicDefs('lib/response.js', RESPONSE).names;
  const got = [...mapTests('lib/response.js', { tests, mentions: () => ['test/exports.js'], names, per: 12 }).entries()];
  assert.deepEqual(got.slice(0, 2).map((x) => x[0]).sort(), ['test/res.cookie.js', 'test/res.status.js']);
  assert.match(got[0][1], /^file name has (status|cookie)$/);
  assert.equal(got[2][0], 'test/exports.js', 'a mention comes after the name tiers');
  assert.ok(got.slice(0, 2).every((x) => !/app\.options/.test(x[0])), 'an unrelated test never outranks them');
  // calls need two distinct public names
  const calls = (n) => ({ status: ['test/app.options.js', 'test/exports.js'], cookie: ['test/exports.js'] }[n] || []);
  const c = [...mapTests('lib/response.js', { tests: ['test/app.options.js', 'test/exports.js'], mentions: () => [], names, calls, per: 12 }).entries()];
  assert.deepEqual(c, [['test/exports.js', 'calls status, cookie']]);
  assert.deepEqual([...mapTests('lib/x.js', { tests, mentions: () => [], names: ['get', 'set', 'a', 'handle'] }).keys()], [], 'short and generic names are not searched');
});

test('literal guard: needles are the static runs and 3-word windows of the strings on the cited line', () => {
  const n = needlesOf(RESPONSE, 5);
  assert.ok(n.includes('Invalid status code'), n.join(' | '));
  assert.ok(n.includes('Status code must be an integer.'.replace(/\.$/, '')) || n.some((x) => /^Status code must/.test(x)));
  assert.deepEqual(needlesOf(['x = 1;', 'const y = "ok";', 'z();'], 2), [], 'short strings are no literal');
});

test('the express shape: the res.* tests are matched first and their .expect( chains count as assertions; a missing_test on the Invalid status code throw is downgraded, citing test/res.status.js', (t) => {
  const root = repo(t);
  const inv = inventory({ cwd: root, head: 'HEAD' });
  const row = inv.rows.find((r) => r.path === 'lib/response.js');
  assert.deepEqual(row.tests.slice(0, 2).sort(), ['test/res.cookie.js', 'test/res.status.js']);
  assert.ok(!row.tests.includes('test/app.options.js') || row.tests.indexOf('test/app.options.js') > 1);
  assert.equal(row.signals.noAssert, 0, 'supertest .expect( is an assertion');
  assert.ok(row.signals.asserts >= 4);
  assert.match(row.why, /^\d+ public definitions$|weak/);
  const covers = makeCoverGuard({ cwd: root });
  assert.match(covers(RESPONSE, 5), /^test\/res\.status\.js:\d+$/, 'the throw line of res.status');
  assert.match(covers(RESPONSE, 15), /^test\/res\.cookie\.js:\d+$/, 'the throw line of res.cookie');
  assert.equal(covers(RESPONSE, 8), null, 'a plain assignment line has no literal to find');
  const other = fs.readFileSync(path.join(root, 'lib/other.js'), 'utf8').split('\n');
  assert.equal(covers(other, 2), null);
  assert.equal(covers(['throw new RangeError("a message nobody tests at all");'], 1), null);
});

test('the guard also finds a thrown class on a test line with the method name, and never throws', (t) => {
  const root = repo(t);
  fs.writeFileSync(path.join(root, 'test/res.vary.js'), "it('x', () => { assert.throws(() => res.vary(1), RangeError) })\n");
  execFileSync('git', ['add', '.'], { cwd: root });
  const covers = makeCoverGuard({ cwd: root });
  assert.match(covers(['res.vary = function vary(f) {', '  if (!f) throw new RangeError(x);', '};'], 2), /^test\/res\.vary\.js:1$/);
  assert.equal(makeCoverGuard({ cwd: path.join(root, 'nope') })(RESPONSE, 5), null, 'no repository: no hit');
  assert.equal(covers(null, 5), null);
});

test('enclosingName: the definition around a cited line, for the common shapes', () => {
  const { enclosingName } = require('./test-map');
  const at = (src, line) => enclosingName(src.split('\n'), line);
  assert.equal(at("defineGetter(req, 'fresh', function(){\n  var x = 1;\n  return x;\n});", 3), 'fresh');
  assert.equal(at('res.status = function status(code) {\n  a();\n  b();\n};', 3), 'status');
  assert.equal(at('function parseRange(size) {\n  a();\n  b();\n}', 3), 'parseRange');
  assert.equal(at('  def render_page(self):\n    a()\n    b()', 3), 'render_page');
  assert.equal(at('func ServeFile(w int) {\n\ta()\n\tb()\n}', 3), 'ServeFile');
  assert.equal(at('a();\nb();', 2), null);
});

test('the guard follows a delegated helper: a guard line that calls a tested helper is a hit citing its test; builtins and untested names are not', (t) => {
  const root = repo(t);
  fs.writeFileSync(path.join(root, 'test/filename.test.ts'), "it('isDirectChild guards rename/delete against traversal', () => { assert.equal(E.isDirectChild('/a', '/a/../b'), false) })\nit('labels', () => { assert.deepEqual(rows.filter(Boolean), []) })\n");
  fs.mkdirSync(path.join(root, 'src/engine'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src/engine/filename.ts'), 'export function isDirectChild(dir: string, file: string): boolean {\n  return true\n}\n');
  execFileSync('git', ['add', '.'], { cwd: root });
  const covers = makeCoverGuard({ cwd: root });
  const own = ["const ownFile = (p) => typeof p === 'string' && E.isDirectChild(dirOf(), p) && MEDIA_EXT.test(p)"];
  assert.match(covers(own, 1, 'electron/app.cjs'), /^a delegated helper is tested: isDirectChild at test\/filename\.test\.ts:1$/);
  assert.equal(covers(["const ok = (p) => p.includes('x') && list.map((a) => a.trim()).filter(Boolean).push(p)"], 1), null, 'builtins only');
  assert.equal(covers(['const ownFile = (p) => E.untestedHelperName(p)'], 1), null, 'a helper no test mentions');
  // Kite recall run 2: library and array methods a test also calls are not delegates; a claim on a test file follows no delegate
  assert.equal(covers(['const labels = keys.filter((k) => k > 3).map(mouseLabel)'], 1, 'src/engine/keys.ts'), null, 'filter is not defined here');
  assert.equal(covers(['  for (const c of cases) assert.deepEqual(nextTrigger(c.now), c.want)'], 1, 'test/schedule.test.ts'), null, 'a test file');
  assert.equal(covers(['  assert.deepEqual(isDirectChild(a, b), true)'], 1, 'test/other.test.ts'), null, 'a test file, even with a tested helper');
});

test('makeCoverGuard: test_paths, when set, is authoritative over the name heuristic (F26)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-'));
  const git = (...a) => execFileSync('git', a, { cwd: root });
  git('init', '-q');
  fs.mkdirSync(path.join(root, 'qa'));
  fs.mkdirSync(path.join(root, 'tests'));
  fs.writeFileSync(path.join(root, 'qa/a.js'), "assert.throws(f, /boom happened here/);\n");
  fs.writeFileSync(path.join(root, 'tests/b.test.js'), "assert.throws(f, /bang happened here/);\n");
  git('add', '.');
  const line = (m) => [`throw new Error('${m} happened here');`];
  assert.match(makeCoverGuard({ cwd: root, testPaths: 'qa/**' })(line('boom'), 1), /^qa\/a\.js:1$/);
  assert.equal(makeCoverGuard({ cwd: root, testPaths: 'qa/**' })(line('bang'), 1), null, 'tests/b.test.js is outside the configured scope');
  assert.match(makeCoverGuard({ cwd: root })(line('bang'), 1), /^tests\/b\.test\.js:1$/, 'control: no scope, the heuristic');
});

test('makeCoverGuard: an eligible-test set limits a hit to the claim\'s own candidate tests (wave 4 E5)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'specguard-guard-'));
  const run = (...a) => execFileSync('git', a, { cwd: root, stdio: 'ignore' });
  try {
    run('init'); fs.mkdirSync(path.join(root, 'tests'));
    fs.writeFileSync(path.join(root, 'tests/logger.test.js'), 'test("logger", () => { expect(log).toContain("invalid amount"); });\n');
    fs.writeFileSync(path.join(root, 'tests/amount.test.js'), 'test("amount", () => { expect(() => amount(-1)).toThrow("invalid amount"); });\n');
    run('add', '.');
    const covers = makeCoverGuard({ cwd: root }), src = ['function amount(v) {', '  if (v < 0) throw new Error("invalid amount");', '}'];
    assert.match(covers(src, 2, 'src/amount.js'), /^tests\/(logger|amount)\.test\.js:1$/, 'no set: any tracked test counts, as before');
    assert.equal(covers(src, 2, 'src/amount.js', ['tests/other.test.js']), null, 'a hit in an unrelated test is no demotion');
    assert.equal(covers(src, 2, 'src/amount.js', ['tests/logger.test.js']), 'tests/logger.test.js:1');
    assert.equal(covers(src, 2, 'src/amount.js', ['tests/amount.test.js']), 'tests/amount.test.js:1', 'the unit\'s own candidate test still demotes');
    assert.equal(covers(src, 2, 'src/amount.js', []), null, 'no candidate tests: no demotion');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('enclosingName: a generator method and an exported constant table are definitions (declName sees neither)', () => {
  const { enclosingName } = require('./test-map');
  const at = (src, line) => enclosingName(src.split('\n'), line);
  assert.equal(at('class A {\n  public *scanForClientHooks(\n    instance,\n  ) {\n    yield 1;\n  }\n}', 5), 'scanForClientHooks');
  assert.equal(at("export const multerExceptions = {\n  A: 'a',\n  INVALID_FIELD_NAME: 'Invalid field name',\n};", 3), 'multerExceptions');
  assert.equal(at('function wrapper() {\n  /**\n   * retry(3) is used below\n   */\n  return 1;\n}', 5), 'wrapper', 'control: a comment line that looks like a generator call is no definition');
  assert.equal(at('function plain() {\n  return 1;\n}', 2), 'plain', 'control: ordinary functions still resolve');
});

test('symbol guard: a whole-word hit in a tracked test file; no hit for an unreferenced name, a partial word, or a method that other files define too', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sym-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const put = (p, s) => { fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true }); fs.writeFileSync(path.join(root, p), s); };
  put('src/a.ts', 'export const multerExceptions = {};\nexport const lonelyTable = {};\n');
  put('src/b.go', 'func (t *B) TransformSourceFile(f int) int {\n}\n');
  put('src/c.go', 'func (t *C) TransformSourceFile(f int) int {\n}\n');
  put('test/a.spec.ts', "import { multerExceptions } from '../src/a';\nconst multerExceptionsX = 1;\n");
  put('test/x.test.go', 'x.TransformSourceFile(f)\n');
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['add', '.'], { cwd: root });
  const { symbol } = makeCoverGuard({ cwd: root });
  assert.equal(symbol('multerExceptions', 'src/a.ts'), 'test/a.spec.ts:1');
  assert.equal(symbol('lonelyTable', 'src/a.ts'), null, 'control: referenced in no test');
  assert.equal(symbol('multerException', 'src/a.ts'), null, 'whole word only');
  assert.equal(symbol('TransformSourceFile', 'src/b.go'), null, 'another file defines the same method');
});

test('hunkTokens: a deleted file (+++ /dev/null) does not leak its removed lines into the previous file', () => {
  const { hunkTokens } = require('./test-map');
  const hdr = (f) => `diff --git a/${f} b/${f}\n--- a/${f}\n`;
  const del = `diff --git a/lib/z.js b/lib/z.js\ndeleted file mode 100644\n--- a/lib/z.js\n+++ /dev/null\n@@ -1 +0,0 @@\n-const zOnlyIdentifier = 1;\n`;
  const mod = (f, id) => hdr(f) + `+++ b/${f}\n@@ -1 +1 @@\n-const oldName = 1;\n+const ${id} = 2;\n`;
  const t = hunkTokens(mod('lib/a.js', 'aOnlyIdentifier') + del);
  assert.ok(t.get('lib/a.js').includes('aOnlyIdentifier') && !t.get('lib/a.js').includes('zOnlyIdentifier'));
  const c = hunkTokens(mod('lib/a.js', 'aOnlyIdentifier') + mod('lib/b.js', 'bOnlyIdentifier'));
  assert.ok(c.get('lib/a.js').includes('aOnlyIdentifier') && !c.get('lib/a.js').includes('bOnlyIdentifier') && c.get('lib/b.js').includes('bOnlyIdentifier'));
  const p = hunkTokens(mod('lib/a.js', 'aOnlyIdentifier') + '+++ markdown rule\n+const afterPlusLine = 3;\n'); // an added line "++ markdown rule" looks like a header: it must not end the file
  assert.ok(p.get('lib/a.js').includes('afterPlusLine'));
});

