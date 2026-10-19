// A PR that only removes or weakens a test assertion still points at the code and requirement it protected (via: "test").
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const T = require('./trace');

function repo(t, baseFiles, headFiles) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'specguard-weak-')), ctx = dir + '-ctx';
  fs.mkdirSync(ctx); t.after(() => { fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(ctx, { recursive: true, force: true }); });
  const git = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'core.autocrlf=false', '-c', 'commit.gpgsign=false', ...a], { cwd: dir, encoding: 'utf8' }).trim();
  const put = (files) => { for (const [f, text] of Object.entries(files)) { const p = path.join(dir, f); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); } };
  git('init', '-q'); put(baseFiles); git('add', '-A'); git('commit', '-qm', 'base');
  const base = git('rev-parse', 'HEAD');
  put(headFiles); git('add', '-A'); git('commit', '-qm', 'head', '--allow-empty');
  return { dir, base, head: git('rev-parse', 'HEAD'), ctx };
}

const DOC = '# Server\n\n## Limits\n\nThe request body limit must default to 1048576 bytes.\n\nThe server must log every request.\n';
const SRC = 'export const defaults = {\n  bodyLimit: 1048576,\n  logLevel: "info",\n};\n';
const TEST = (line) => `import assert from 'node:assert';\ntest('defaults', () => {\n  const opts = build();\n${line}\n  assert.equal(opts.logLevel, 'info');\n});\n`;
const PINNED = '  assert.strictEqual(opts.bodyLimit, 1048576);';
const files = (testText, src = SRC) => ({ 'docs/specs/server.md': DOC, 'src/server.js': src, 'src/other.js': 'export const unrelated = 7;\n', 'test/server.test.js': testText });
const run = (r) => { T.run({ cwd: r.dir, base: r.base, head: r.head, ctx: r.ctx }); return JSON.parse(fs.readFileSync(path.join(r.ctx, 'trace-candidates.json'), 'utf8')); };
const viaTest = (c) => ({ code: c.requirement_to_code.filter((x) => x.via === 'test'), req: c.code_to_requirement.filter((x) => x.via === 'test') });

test('a weakened assertion: the code line and the requirement item it protected are emitted, marked via test', (t) => {
  const c = run(repo(t, files(TEST(PINNED)), files(TEST('  assert.ok(opts.bodyLimit);')))), { code, req } = viaTest(c);
  assert.equal(code.length, 1);
  const w = code[0].code[0];
  assert.deepEqual([w.path, w.line <= 2 && w.end >= 2, code[0].tests], ['src/server.js', true, []]);
  assert.match(code[0].note, /removed or weakened test assertion/);
  assert.equal(req.length, 1);
  assert.deepEqual([req[0].path, req[0].candidates[0].path, req[0].candidates[0].line], ['test/server.test.js', 'docs/specs/server.md', 5]);
  assert.equal(c.code_to_requirement.length, 1);
});

test('a deleted assertion line is a removed assertion too', (t) => {
  const { code, req } = viaTest(run(repo(t, files(TEST(PINNED)), files(TEST('  // gone')))));
  assert.deepEqual([code.length, req.length], [1, 1]);
  assert.deepEqual([code[0].code[0].path, req[0].candidates[0].path, req[0].candidates[0].line], ['src/server.js', 'docs/specs/server.md', 5]);
});

test('counterexamples emit nothing: added assertion, renamed test, reformatted assertion, literal found nowhere, no literal', (t) => {
  const none = (base, head) => {
    const c = run(repo(t, files(base), files(head)));
    assert.deepEqual([c.requirement_to_code.length, c.code_to_requirement.length], [0, 0], head);
  };
  none(TEST(PINNED), TEST(PINNED + '\n  assert.ok(opts.extra);'));
  none(TEST(PINNED), TEST(PINNED).replace("'defaults'", "'default options'"));
  none(TEST(PINNED), TEST('  assert.strictEqual(opts.bodyLimit,1048576)'));
  none(TEST('  assert.strictEqual(opts.ghost, 7777);'), TEST('  assert.ok(opts.ghost);'));
  none(TEST('  assert.deepEqual(opts, expected);'), TEST('  assert.ok(opts.bodyLimit);'));
});

test('a code-change PR with an ordinary test edit has the same trace output as without it, and carries no via', (t) => {
  const src = SRC.replace('"info"', '"warn"');
  const a = repo(t, files(TEST(PINNED)), files(TEST(PINNED), src)), b = repo(t, files(TEST(PINNED)), files(TEST(PINNED + '\n  assert.ok(opts.more);'), src));
  const ca = run(a), cb = run(b);
  assert.deepEqual(ca, cb);
  assert.ok(ca.code_to_requirement.length > 0 && !JSON.stringify(ca).includes('"via"'));
});

// 200 is held by many files and doc items: it anchors nothing. A rare literal in the same repo still does.
const busy = (testText) => {
  const extra = {};
  for (let i = 1; i <= 6; i++) extra[`src/route${i}.js`] = `export const route${i} = (res) => { res.statusCode = 200; };
`;
  const doc = DOC + [1, 2, 3, 4, 5, 6].map((i) => `
Route ${i} must answer with status 200 when it succeeds.
`).join('');
  return { ...files(testText), ...extra, 'docs/specs/server.md': doc };
};
test('a common literal (200) is no anchor: nothing is emitted; a rare literal still is', (t) => {
  const common = run(repo(t, busy(TEST('  assert.equal(res.statusCode, 200);')), busy(TEST('  assert.ok(res.statusCode);'))));
  assert.deepEqual([common.requirement_to_code.length, common.code_to_requirement.length], [0, 0]);
  const rare = viaTest(run(repo(t, busy(TEST(PINNED)), busy(TEST('  assert.ok(opts.bodyLimit);')))));
  assert.deepEqual([rare.code.length, rare.req.length], [1, 1]);
});
