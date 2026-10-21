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


// a guard whose child_process.execFileSync is wrapped (test-map binds it at require time): records every git grep, optionally failing it
function withSpy(root, fail) {
  const cp = require('node:child_process'), real = cp.execFileSync, calls = [], mod = require.resolve('./test-map');
  delete require.cache[mod];
  cp.execFileSync = (cmd, args, ...r) => {
    if (cmd === 'git' && args[0] === 'grep') { calls.push(args); if (fail) throw Object.assign(new Error('x'), fail); }
    return real(cmd, args, ...r);
  };
  try { var guard = require('./test-map').makeCoverGuard({ cwd: root }); } finally { cp.execFileSync = real; delete require.cache[mod]; }
  return { guard, calls };
}

test('the cover guard greps only tracked test files (pathspec), not large tracked data', (t) => {
  const root = repo(t);
  fs.mkdirSync(path.join(root, 'docs'));
  fs.writeFileSync(path.join(root, 'docs/big.json'), '{"m":"Invalid status code"}\n');
  execFileSync('git', ['add', '.'], { cwd: root });
  const s = withSpy(root, null);
  assert.match(s.guard(RESPONSE, 5), /^test\/res\.status\.js:\d+$/, 'control: a real covering test still demotes');
  assert.ok(s.calls.length > 0);
  for (const a of s.calls) {
    const i = a.indexOf('--');
    assert.ok(i > 0, 'a pathspec follows --');
    assert.ok(a.length > i + 1 && a.slice(i + 1).every((p) => /^tests?\//.test(p)), `only test paths: ${a.slice(i + 1)}`);
  }
  assert.deepEqual(s.guard.limits, []);
});

test('the cover guard reports a timed-out search instead of a silent no-hit; exit 1 is a plain no-hit', (t) => {
  const root = repo(t);
  const slow = withSpy(root, { code: 'ETIMEDOUT', killed: true, status: null });
  assert.equal(slow.guard(RESPONSE, 5, 'lib/response.js'), null);
  assert.deepEqual(slow.guard.limits, ['could not check whether a test covers lib/response.js (timeout)']);
  const none = withSpy(root, { status: 1 });
  assert.equal(none.guard(RESPONSE, 5, 'lib/response.js'), null);
  assert.deepEqual(none.guard.limits, [], 'no match is not a limitation');
});

// a guard over a fake git: `git ls-files` lists n test files, each `git grep` goes to onGrep(paths after --, call number) and is recorded
function withFakeGit(n, onGrep) {
  const cp = require('node:child_process'), real = cp.execFileSync, calls = [], mod = require.resolve('./test-map');
  const files = Array.from({ length: n }, (_, i) => `test/t${String(i).padStart(4, '0')}.test.js`);
  delete require.cache[mod];
  cp.execFileSync = (cmd, args) => {
    if (args[0] === 'ls-files') return files.join('\0') + '\0';
    if (args[0] === 'grep') { const paths = args.slice(args.indexOf('--') + 1); calls.push(paths); return onGrep(paths, calls.length); }
    throw Object.assign(new Error('x'), { status: 1 });
  };
  try { var guard = require('./test-map').makeCoverGuard({ cwd: '.' }); } finally { cp.execFileSync = real; delete require.cache[mod]; }
  return { guard, calls, files };
}
const NO_MATCH = () => { throw Object.assign(new Error('no match'), { status: 1 }); };

test('the cover guard searches every 300-file batch: a hit in the third of 650 test files is found', () => {
  const s = withFakeGit(650, (paths, k) => (k === 3 ? `${paths[5]}:7:x\n` : NO_MATCH()));
  assert.equal(s.guard(RESPONSE, 5, 'lib/response.js'), `${s.files[605]}:7`);
  assert.deepEqual(s.calls.map((c) => c.length), [300, 300, 50]);
  assert.deepEqual(s.calls.flat(), s.files, 'every tracked test file searched once, in order');
  assert.deepEqual(s.guard.limits, []);
});

test('the cover guard reports a timeout in batch 2 even when the hit is in batch 3 (no silent no-hit)', () => {
  const s = withFakeGit(650, (paths) => { // keyed on the batch, since the guard may run further searches after the first fails
    if (paths[0] === 'test/t0300.test.js') throw Object.assign(new Error('x'), { code: 'ETIMEDOUT', killed: true, status: null });
    return paths[0] === 'test/t0600.test.js' ? `${paths[0]}:1:x\n` : NO_MATCH();
  });
  assert.equal(s.guard(RESPONSE, 5, 'lib/response.js'), null);
  assert.deepEqual(s.guard.limits, ['could not check whether a test covers lib/response.js (timeout)']);
});

test('the cover guard stops at the first batch that hits (control)', () => {
  const s = withFakeGit(650, (paths) => `${paths[2]}:4:x\n`);
  assert.equal(s.guard(RESPONSE, 5, 'lib/response.js'), `${s.files[2]}:4`);
  assert.equal(s.calls.length, 1);
  assert.equal(s.calls[0].length, 300);
});

// CommonJS export shapes: the exported names, and nothing for a helper that is not exported
const names = (file, src) => publicDefs(file, src.split('\n')).names;
test('publicDefs: module.exports = { a, b: c, d() {} } names the keys and the referenced functions', () => {
  const n = names('lib/a.js', 'function foo() {}\nfunction bar() {}\nfunction helper() {}\nmodule.exports = {\n  foo,\n  baz: bar,\n  qux() { return { nested: 1 }; },\n  z: make(1),\n};');
  assert.deepEqual(n.sort(), ['bar', 'baz', 'foo', 'qux', 'z']);
});
test('publicDefs: module.exports = name / function name', () => {
  assert.deepEqual(names('lib/a.js', 'function build() {}\nfunction helper() {}\nmodule.exports = build;'), ['build']);
  assert.deepEqual(names('lib/a.js', 'module.exports = function make() {};'), ['make']);
});
test('publicDefs: exports.x = and module.exports.x = still name x', () => {
  assert.deepEqual(names('lib/a.js', 'function helper() {}\nmodule.exports.x = function () {};\nexports.y = 1;'), ['x', 'y']);
});
test('publicDefs: ESM, TS, Python and Go are unchanged', () => {
  assert.deepEqual(names('a.js', 'function helper() {}\nexport function pub() {}'), ['pub']);
  assert.deepEqual(names('a.ts', 'export const x = 1;\nexport function run(): void {}'), ['run']);
  assert.deepEqual(names('a.py', 'def _h(): pass\ndef api(): pass'), ['api']);
  assert.deepEqual(names('a.go', 'func helper() {}\nfunc Serve() {}'), ['Serve']);
});

test('enclosingDef: a // inside a regex literal is not a comment, so the definition ends where its braces end', () => {
  const { enclosingDef } = require('./test-map');
  const lines = [
    'function trackerRefs({ title = "", branch = "" }) {',
    '  const keys = [];',
    '  if (!/^(?:dependabot|renovate)\\//i.test(branch)) keys.push(...[title]);',
    '  return keys;',
    '}',
    '',
    'if (require.main === module) {',
    '  main();',
    '}',
  ];
  assert.deepEqual(enclosingDef(lines, 4), { line: 1, name: 'trackerRefs', end: 5 });
  assert.equal(enclosingDef(lines, 8), null, 'the entry-point block is not part of trackerRefs');
  const divide = ['function half(a, b) {', '  const c = a / b; // ratio', '  return c / 2;', '}', 'const z = 1;'];
  assert.deepEqual(enclosingDef(divide, 3), { line: 1, name: 'half', end: 4 }, 'a division is not a regex');
});

test('enclosingDef: a definition ends at the next declaration of the same or lower indentation even when a quote-holding regex keeps its braces open (requirements.js sanitize shape)', () => {
  const { enclosingDef } = require('./test-map');
  const lines = [
    'const sanitize = (s) => {',
    "  let t = decode(String(s || '').replace(/\\r\\n?/g, '\\n')).replace(INVISIBLE, '');",
    '  return t.replace(/<!--[\\s\\S]*$/, \'\')',
    "    .replace(/(\\]\\(\\s*<?[^\\s)]+>?)\\s+(?:\"[^\"]*\"|'[^']*')\\s*\\)/g, '$1)'); // link and image titles",
    '};',
    '',
    'const AC_LINE = /^\\s*AC[\\s._-]*\\d+\\s*[:]/i;',
    'function next(a) {',
    '  return a + 1;',
    '}',
    'function last(b) {',
    '  return b;',
    '}',
  ];
  const d = enclosingDef(lines, 3);
  assert.equal(d.name, 'sanitize');
  assert.ok(d.end <= 7, `sanitize must not run into next(): ended at ${d.end}`);
  assert.equal(enclosingDef(lines, 9).name, 'next');
  assert.equal(enclosingDef(lines, 12).name, 'last');
});
