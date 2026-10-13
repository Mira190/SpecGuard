const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { collect, testLayout, branchGuard } = require('./audit-collect');

const DESIGN = '# Plan design\n\nA repeating plan stays on after it fires.\n\nA plan MUST be rejected when its start is in the past.\n\nA plan SHALL NOT fire twice in one minute.\n';

function repo(t, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'specguard-audit-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const git = (...a) => execFileSync('git', ['-c', 'core.autocrlf=false', ...a], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init'); git('config', 'user.name', 'SpecGuard test'); git('config', 'user.email', 'test@example.invalid');
  for (const [f, s] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true }); fs.writeFileSync(path.join(root, f), s); }
  git('add', '.'); git('commit', '-m', 'init');
  return { root, ctx: path.join(root, '.specguard-ctx'), git };
}
const rows = (ctx, n) => fs.readFileSync(path.join(ctx, n), 'utf8').split('\n').filter(Boolean).map((l) => l.split('\t'));

const FILES = {
  'docs/design.md': DESIGN,
  'notes/loose.md': '# Notes\n\nSome thoughts about the plan.\n',
  'README.md': '# Tool\n\nThe tool must validate the input.\n\nThe tool must log errors.\n\nUsage text goes here. '.padEnd(20000, 'x') + '\n',
  'CONTRIBUTING.md': 'Write tests.\n',
  'src/plan.js': 'exports.fire = () => 1;\n',
  'tests/plan.test.js': 'test("x", () => {});\n',
};

test('collect: discovered design doc, forced glob, rejected README (with a reason), standards file, test layout', (t) => {
  const { root, ctx, git } = repo(t, FILES);
  const r = collect({ cwd: root, ctx, reqPaths: 'notes/*.md', maxRequirements: 12 });
  const docs = rows(ctx, 'audit-docs.txt');
  assert.deepEqual(docs.find((d) => d[0] === 'docs/design.md'), ['docs/design.md', 'discovered']);
  assert.deepEqual(docs.find((d) => d[0] === 'notes/loose.md'), ['notes/loose.md', 'requirements_paths']);
  assert.equal(docs[0][0], 'notes/loose.md', 'forced documents come first');
  assert.ok(!docs.some((d) => d[0] === 'README.md'));
  const rej = rows(ctx, 'audit-rejected.txt');
  assert.ok(rej.some(([p, why]) => p === 'README.md' && /normative|density/.test(why)), JSON.stringify(rej));
  assert.deepEqual(fs.readFileSync(path.join(ctx, 'standards.txt'), 'utf8').split('\n').filter(Boolean), ['CONTRIBUTING.md']);
  assert.match(fs.readFileSync(path.join(ctx, 'test-layout.txt'), 'utf8'), /test directories: tests \(1\)[\s\S]*\*\.test\.\* \(1\)/);
  const meta = JSON.parse(fs.readFileSync(path.join(ctx, 'audit-meta.json'), 'utf8'));
  assert.equal(meta.head, git('rev-parse', 'HEAD'));
  assert.equal(meta.max_requirements, 12);
  assert.equal(r.docs.length, 2);
});

test('collect: an excluded glob drops a document; no discovery output means no documents', (t) => {
  const { root, ctx } = repo(t, FILES);
  collect({ cwd: root, ctx, reqPaths: '!docs/**' });
  assert.ok(!rows(ctx, 'audit-docs.txt').some((d) => d[0] === 'docs/design.md'));
  const none = repo(t, { 'src/a.js': 'x\n' });
  collect({ cwd: none.root, ctx: none.ctx });
  assert.equal(fs.readFileSync(path.join(none.ctx, 'audit-docs.txt'), 'utf8'), '');
});

test('collect: uncommitted files are not seen (HEAD only), and a stale context directory is wiped', (t) => {
  const { root, ctx } = repo(t, FILES);
  fs.mkdirSync(ctx); fs.writeFileSync(path.join(ctx, 'stale.txt'), 'x');
  fs.writeFileSync(path.join(root, 'docs/untracked.md'), DESIGN);
  collect({ cwd: root, ctx });
  assert.ok(!fs.existsSync(path.join(ctx, 'stale.txt')));
  assert.ok(!rows(ctx, 'audit-docs.txt').some((d) => d[0] === 'docs/untracked.md'));
});

test('collect: the 60-document cap moves the rest to audit-rejected', (t) => {
  const files = { 'src/a.js': 'x\n' };
  for (let i = 0; i < 62; i++) files[`docs/d${String(i).padStart(2, '0')}.md`] = DESIGN;
  const { root, ctx } = repo(t, files);
  const r = collect({ cwd: root, ctx });
  assert.equal(r.docs.length, 60);
  assert.equal(rows(ctx, 'audit-rejected.txt').filter(([, why]) => /audit limit/.test(why)).length, 2);
});

test('collect: standards use the PR review globs, STANDARDS_PATHS adds and excludes, and a STANDARDS_PATHS doc is not a requirement doc', (t) => {
  const { root, ctx } = repo(t, { ...FILES, '.cursor/BUGBOT.md': 'Be nice.\n', 'pkg/BUGBOT.md': 'x\n', '.gemini/styleguide.md': 'x\n', '.greptile/rules.md': 'x\n',
    'docs/house-rules.md': DESIGN, 'AGENTS.md': 'x\n' });
  collect({ cwd: root, ctx, standardsPaths: 'docs/house-rules.md\n!AGENTS.md' });
  const std = fs.readFileSync(path.join(ctx, 'standards.txt'), 'utf8').split('\n').filter(Boolean);
  assert.deepEqual(std, ['.cursor/BUGBOT.md', '.gemini/styleguide.md', '.greptile/rules.md', 'CONTRIBUTING.md', 'docs/house-rules.md', 'pkg/BUGBOT.md']);
  const docs = rows(ctx, 'audit-docs.txt').map((d) => d[0]);
  assert.ok(docs.includes('docs/design.md') && !docs.includes('docs/house-rules.md'), docs.join());
});

test('collect: audit-candidates.txt seeds one line per deterministic requirement (path:line, heading, text); the total is in the meta', (t) => {
  const { root, ctx } = repo(t, FILES);
  const r = collect({ cwd: root, ctx });
  const c = rows(ctx, 'audit-candidates.txt');
  assert.deepEqual(c.map((x) => x[0]), ['docs/design.md:5', 'docs/design.md:7']);
  assert.equal(c[0][1], 'Plan design');
  assert.match(c[0][2], /^A plan MUST be rejected when its start is in the past\./);
  const meta = JSON.parse(fs.readFileSync(path.join(ctx, 'audit-meta.json'), 'utf8'));
  assert.deepEqual([meta.candidates, meta.candidates_listed, r.candidates], [2, 2, 2]);
});

test('branchGuard: only the default branch is audited; unknown ref or payload warns and continues', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'specguard-event-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ev = path.join(dir, 'event.json');
  fs.writeFileSync(ev, JSON.stringify({ repository: { default_branch: 'main' } }));
  assert.deepEqual(branchGuard({ refName: 'main', eventPath: ev }), {});
  assert.match(branchGuard({ refName: 'feature/x', eventPath: ev }).error, /audits the default branch \(main\); this run is on feature\/x/);
  assert.match(branchGuard({ refName: 'main', eventPath: path.join(dir, 'none.json') }).warn, /could not tell/);
  assert.match(branchGuard({ refName: '', eventPath: ev }).warn, /could not tell/);
});

test('testLayout: names the directories, file-name patterns and config that exist', () => {
  const l = testLayout(['src/a.js', 'src/__tests__/a.test.ts', 'test/b_test.go', 'app/FooTests.cs', 'package.json', 'docs/test-plan.md']);
  assert.match(l, /^test directories: [^\n]*src\/__tests__ \(1\)/);
  assert.match(l, /test file names: [^\n]*\*\.test\.\* \(1\)[^\n]*\*_test\.\* \(1\)/);
  assert.match(l, /test config files: package\.json/);
  assert.doesNotMatch(l, /test-plan/);
});

test('CLI: rejects a bad audit_max_requirements and writes the skip output', (t) => {
  const { root, ctx } = repo(t, FILES);
  const run = (env) => spawnSync(process.execPath, [path.join(__dirname, 'audit-collect.js')], { cwd: root, encoding: 'utf8', env: { ...process.env, CTX: ctx, GITHUB_REF_NAME: '', GITHUB_EVENT_PATH: '', ...env } });
  for (const bad of ['0', '501', 'x', '-3', '8.5']) assert.equal(run({ MAX_REQUIREMENTS: bad }).status, 1, bad);
  const out = path.join(root, 'out.txt');
  const ok = run({ MAX_REQUIREMENTS: '80', GITHUB_OUTPUT: out });
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(fs.readFileSync(out, 'utf8'), 'skip=false\n');
  assert.match(ok.stdout, /::warning::could not tell whether this ref is the default branch/);
  const ev = path.join(root, 'event.json');
  fs.writeFileSync(ev, JSON.stringify({ repository: { default_branch: 'main' } }));
  const off = run({ GITHUB_REF_NAME: 'dev', GITHUB_EVENT_PATH: ev });
  assert.equal(off.status, 1);
  assert.match(off.stdout, /::error::mode audit audits the default branch \(main\); this run is on dev/);
  assert.equal(run({ GITHUB_REF_NAME: 'main', GITHUB_EVENT_PATH: ev }).status, 0);
  const none = repo(t, { 'a.js': 'x\n' });
  spawnSync(process.execPath, [path.join(__dirname, 'audit-collect.js')], { cwd: none.root, env: { ...process.env, CTX: none.ctx, GITHUB_REF_NAME: '', GITHUB_OUTPUT: path.join(none.root, 'o.txt') } });
  assert.equal(fs.readFileSync(path.join(none.root, 'o.txt'), 'utf8'), 'skip=true\n');
});
