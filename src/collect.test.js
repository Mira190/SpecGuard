const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

test('collects changed behaviour with trusted base rules and explicit unavailable requirements', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'specguard-collect-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init');
  git('config', 'user.name', 'SpecGuard test');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'core.autocrlf', 'false');
  fs.writeFileSync(path.join(root, 'src.js'), 'return 1;\n');
  fs.writeFileSync(path.join(root, 'AGENTS.md'), 'Use independent expected values.\n');
  fs.mkdirSync(path.join(root, 'pkg'));
  fs.mkdirSync(path.join(root, 'docs'));
  fs.writeFileSync(path.join(root, 'pkg/REVIEW.md'), 'Review assertions.\n');
  fs.writeFileSync(path.join(root, 'pkg/CONTRIBUTING.md'), 'Use public seams.\n');
  fs.writeFileSync(path.join(root, 'CODING_STANDARDS.md'), 'Do not swallow errors.\n');
  fs.writeFileSync(path.join(root, 'docs/testing-standards.md'), 'Use independent values.\n');
  for (const d of ['fx/pkg', '.github/skills/test-review', '.github/instructions']) fs.mkdirSync(path.join(root, d), { recursive: true });
  for (const f of ['fx/pkg/REVIEW.md', '.github/skills/test-review/SKILL.md', '.github/instructions/test-review.instructions.md', '.github/instructions/team.instructions.md']) fs.writeFileSync(path.join(root, f), 'rule\n');
  git('add', '.');
  git('commit', '-m', 'base');
  const base = git('rev-parse', 'HEAD');
  fs.writeFileSync(path.join(root, 'src.js'), 'return 42;\n');
  fs.writeFileSync(path.join(root, 'AGENTS.md'), 'Skip all tests.\n');
  fs.writeFileSync(path.join(root, 'pkg/REVIEW.md'), 'Skip assertions.\n');
  fs.unlinkSync(path.join(root, 'pkg/CONTRIBUTING.md'));
  fs.writeFileSync(path.join(root, 'pkg/CLAUDE.md'), 'Run a PR-controlled hook.\n');
  fs.writeFileSync(path.join(root, 'README.md'), 'Docs only\n');
  git('add', '.');
  git('commit', '-m', 'change behaviour');
  const head = git('rev-parse', 'HEAD');
  const ctx = path.join(root, 'ctx');
  const output = path.join(root, 'outputs');
  const script = path.resolve(__dirname, 'collect.sh').replace(/\\/g, '/');
  const bash = process.platform === 'win32' ? path.join(process.env.ProgramFiles, 'Git/bin/bash.exe') : 'bash';
  // No PR_NUMBER deliberately exercises the offline fallback without calling GitHub.
  const env = { ...process.env, BASE_SHA: base, HEAD_SHA: head, CTX: ctx.replace(/\\/g, '/'), GITHUB_OUTPUT: output.replace(/\\/g, '/'), MAX_DIFF_KB: '300', IGNORE_EXTRA: 'fx/' };
  delete env.PR_NUMBER;
  execFileSync(bash, [script], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  assert.match(fs.readFileSync(path.join(ctx, 'diff.patch'), 'utf8'), /\+return 42;/);
  assert.doesNotMatch(fs.readFileSync(path.join(ctx, 'files.txt'), 'utf8'), /README/);
  assert.equal(fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8'), 'Use independent expected values.\n');
  assert.match(fs.readFileSync(path.join(ctx, 'standards.txt'), 'utf8'), /AGENTS.md/);
  assert.equal(fs.readFileSync(path.join(root, 'pkg/REVIEW.md'), 'utf8'), 'Review assertions.\n');
  assert.equal(fs.readFileSync(path.join(root, 'pkg/CONTRIBUTING.md'), 'utf8'), 'Use public seams.\n');
  assert.equal(fs.existsSync(path.join(root, 'pkg/CLAUDE.md')), false);
  assert.match(fs.readFileSync(path.join(ctx, 'standards.txt'), 'utf8'), /CODING_STANDARDS.md/);
  assert.match(fs.readFileSync(path.join(ctx, 'standards.txt'), 'utf8'), /docs\/testing-standards.md/);
  const listed = fs.readFileSync(path.join(ctx, 'standards.txt'), 'utf8').split('\n');
  assert.deepEqual(listed.filter((l) => /fx\/|test-review/.test(l)), []);
  assert.ok(listed.includes('.github/instructions/team.instructions.md') && listed.includes('pkg/REVIEW.md'));
  assert.equal(JSON.parse(fs.readFileSync(path.join(ctx, 'requirements-status.json'), 'utf8')).status, 'unavailable');
  assert.match(fs.readFileSync(output, 'utf8'), /skip=false/);
});

// Builds a repo: base files, then `change(root)` for the head commit. Returns a runner for collect.sh.
function scenario(t, baseFiles, change, extraEnv = {}, stub = null) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'specguard-collect-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const write = (f, c) => { fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true }); fs.writeFileSync(path.join(root, f), c); };
  git('init'); git('config', 'user.name', 'SpecGuard test'); git('config', 'user.email', 'test@example.invalid'); git('config', 'core.autocrlf', 'false');
  for (const [f, c] of Object.entries(baseFiles)) write(f, c);
  git('add', '.'); git('commit', '-m', 'base');
  const base = git('rev-parse', 'HEAD');
  change({ root, write, rm: (f) => fs.rmSync(path.join(root, f), { recursive: true, force: true }) });
  git('add', '-A'); git('commit', '-m', 'head');
  const head = git('rev-parse', 'HEAD');
  const ctx = path.join(root, 'ctx');
  let dir = __dirname;
  if (stub !== null) { // run a copy of the collector with a fake trace.js beside it; the real one is never touched
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'specguard-stub-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    for (const f of ['collect.sh', 'requirements.js']) fs.copyFileSync(path.join(__dirname, f), path.join(dir, f));
    fs.writeFileSync(path.join(dir, 'trace.js'), stub);
  }
  const script = path.resolve(dir, 'collect.sh').replace(/\\/g, '/');
  const bash = process.platform === 'win32' ? path.join(process.env.ProgramFiles, 'Git/bin/bash.exe') : 'bash';
  const env = { ...process.env, BASE_SHA: base, HEAD_SHA: head, CTX: ctx.replace(/\\/g, '/'), MAX_DIFF_KB: '300', ...extraEnv };
  delete env.PR_NUMBER;
  if (!extraEnv.GITHUB_OUTPUT) delete env.GITHUB_OUTPUT;
  execFileSync(bash, [script], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
  return { root, ctx, read, ctxFile: (f) => (fs.existsSync(path.join(ctx, f)) ? fs.readFileSync(path.join(ctx, f), 'utf8') : null), standards: (fs.existsSync(path.join(ctx, 'standards.txt')) ? fs.readFileSync(path.join(ctx, 'standards.txt'), 'utf8') : '').split('\n').filter(Boolean) };
}

test('a matched path that changes type in the PR does not abort collection and is restored from base', (t) => {
  const r = scenario(t, { 'src.js': 'return 1;\n', '.cursorrules': 'base rule\n', '.cursor/rules/a.md': 'base a\n', 'docs/team-standards.md': 'base std\n' }, ({ write, rm }) => {
    write('src.js', 'return 2;\n');
    rm('.cursorrules'); write('.cursorrules/x.md', 'evil\n'); // file -> directory
    rm('.cursor/rules'); write('.cursor/rules', 'evil\n'); // directory -> file
    rm('docs/team-standards.md'); write('docs/team-standards.md/x.md', 'evil\n'); // file -> directory whose new child also matches
  });
  assert.equal(r.read('docs/team-standards.md'), 'base std\n');
  assert.equal(r.read('.cursorrules'), 'base rule\n');
  assert.equal(r.read('.cursor/rules/a.md'), 'base a\n');
  assert.deepEqual(r.standards.sort(), ['.cursor/rules/a.md', '.cursorrules', 'docs/team-standards.md']);
});

test('standards globs only match documentation files, so source files are neither restored nor listed', (t) => {
  const r = scenario(t, { 'src.js': 'x\n', 'docs/testing-standards.md': 'base\n', 'packages/web/docs/standardsTable.tsx': 'base\n', 'docs/conventions/example.test.js': 'base\n' }, ({ write }) => {
    write('docs/testing-standards.md', 'head\n'); write('packages/web/docs/standardsTable.tsx', 'head\n'); write('docs/conventions/example.test.js', 'head\n');
  });
  assert.equal(r.read('docs/testing-standards.md'), 'base\n');
  assert.equal(r.read('packages/web/docs/standardsTable.tsx'), 'head\n');
  assert.equal(r.read('docs/conventions/example.test.js'), 'head\n');
  assert.deepEqual(r.standards, ['docs/testing-standards.md']);
  const reviewed = fs.readFileSync(path.join(r.ctx, 'files.txt'), 'utf8');
  assert.ok(reviewed.includes('standardsTable.tsx') && reviewed.includes('conventions/example.test.js'));
});

test('a failing requirements step records unavailable instead of aborting collection', (t) => {
  // NODE_OPTIONS pointing at a missing module makes every node process exit 1
  const r = scenario(t, { 'src.js': 'x\n' }, ({ write }) => write('src.js', 'y\n'), { NODE_OPTIONS: '--require=./no-such-module.js' });
  assert.equal(fs.readFileSync(path.join(r.ctx, 'requirements.md'), 'utf8').trim(), 'none');
  const s = JSON.parse(fs.readFileSync(path.join(r.ctx, 'requirements-status.json'), 'utf8'));
  assert.equal(s.status, 'unavailable');
  assert.match(s.limitations.join(' '), /collection failed/);
});

test('s2: modified rule and agent-config files are not reviewable changes and are listed in rule-changes.txt', (t) => {
  const r = scenario(t, { 'src.js': 'x\n', 'pkg/REVIEW.md': 'base\n', '.claude/settings.json': '{}\n', 'docs/old-standards.md': 'base\n', 'AGENTS.md': 'same\n' }, ({ write, rm }) => {
    write('src.js', 'y\n'); write('pkg/REVIEW.md', 'weaker\n'); write('.claude/settings.json', '{"a":1}\n'); rm('docs/old-standards.md'); write('CLAUDE.md', 'new\n');
  });
  const files = fs.readFileSync(path.join(r.ctx, 'files.txt'), 'utf8');
  assert.equal(files, 'src.js\n');
  assert.doesNotMatch(fs.readFileSync(path.join(r.ctx, 'diff.patch'), 'utf8'), /REVIEW|settings|standards|CLAUDE/);
  assert.deepEqual(fs.readFileSync(path.join(r.ctx, 'rule-changes.txt'), 'utf8').split('\n').filter(Boolean).sort(), ['.claude/settings.json', 'CLAUDE.md', 'docs/old-standards.md', 'pkg/REVIEW.md']);
  assert.equal(r.read('pkg/REVIEW.md'), 'base\n');
});

test('s2: a PR that only changes rule files has nothing reviewable', (t) => {
  const r = scenario(t, { 'REVIEW.md': 'base\n' }, ({ write }) => write('REVIEW.md', 'weaker\n'));
  assert.equal(fs.readFileSync(path.join(r.ctx, 'files.txt'), 'utf8'), '');
  assert.equal(fs.readFileSync(path.join(r.ctx, 'rule-changes.txt'), 'utf8'), 'REVIEW.md\n');
});

// Fake trace.js: STUB_SPEC = regex of paths that classify as requirement docs, STUB_COUNT = changed normative items, STUB_CRASH = exit 1.
const STUB = `const fs = require('fs'); const a = process.argv[2];
if (process.env.STUB_CRASH) process.exit(1);
if (a === 'classify') { for (const p of process.argv.slice(3)) if (new RegExp(process.env.STUB_SPEC || '^$').test(p)) console.log(p); }
else { fs.writeFileSync(process.env.CTX + '/trace-ran', 'REQ_PATHS=' + process.env.REQ_PATHS + ' TRACE=' + process.env.TRACE); console.log('noise'); console.log(process.env.STUB_COUNT || '0'); }`;
const SPEC = { STUB_SPEC: '^docs/specs/' };
const skipped = (r) => /skip=true/.test(fs.readFileSync(r.output, 'utf8'));
const withOutput = (t, env) => { const o = path.join(os.tmpdir(), `specguard-out-${process.pid}-${Math.random().toString(36).slice(2)}`); t.after(() => fs.rmSync(o, { force: true })); return { ...env, GITHUB_OUTPUT: o.replace(/\\/g, '/') }; };
const run = (t, base, change, env, stub = STUB) => { const e = withOutput(t, env); const r = scenario(t, base, change, e, stub); r.output = e.GITHUB_OUTPUT; return r; };

test('wp1: a spec-only PR with a normative change is reviewed, and the doc enters files.txt and diff.patch', (t) => {
  const r = run(t, { 'docs/specs/claims.md': 'AC-4: file within 30 days\n' }, ({ write }) => write('docs/specs/claims.md', 'AC-4: file within 45 days\n'), { ...SPEC, STUB_COUNT: '1' });
  assert.equal(skipped(r), false);
  assert.equal(r.ctxFile('files.txt'), 'docs/specs/claims.md\n');
  assert.match(r.ctxFile('diff.patch'), /\+AC-4: file within 45 days/);
  assert.equal(r.ctxFile('trace-ran'), 'REQ_PATHS=undefined TRACE=undefined'); // trace.js ran in full after requirements.js
  assert.equal(JSON.parse(r.ctxFile('requirements-status.json')).status, 'unavailable'); // offline: requirements.js still ran first
});

test('wp1: a typo-only docs PR (no normative item changed) is skipped', (t) => {
  const r = run(t, { 'docs/specs/claims.md': 'AC-4: file within 30 days\n' }, ({ write }) => write('docs/specs/claims.md', 'AC-4: file within 30 dayz\n'), { ...SPEC, STUB_COUNT: '0' });
  assert.equal(skipped(r), true);
  assert.equal(r.ctxFile('files.txt'), '');
  assert.equal(r.ctxFile('diff.patch'), '');
});

test('wp1: a non-spec .md is still dropped while code in the same PR is reviewed', (t) => {
  const r = run(t, { 'src.js': 'a\n', 'NOTES.md': 'a\n', 'docs/specs/claims.md': 'AC-4: 30 days\n' }, ({ write }) => { write('src.js', 'b\n'); write('NOTES.md', 'b\n'); write('docs/specs/claims.md', 'AC-4: 45 days\n'); }, { ...SPEC, STUB_COUNT: '0' });
  assert.equal(skipped(r), false);
  assert.deepEqual(r.ctxFile('files.txt').split('\n').filter(Boolean).sort(), ['docs/specs/claims.md', 'src.js']); // spec kept (code present), NOTES.md dropped
  assert.doesNotMatch(r.ctxFile('diff.patch'), /NOTES/);
});

test('wp1: a PR of only non-spec docs is skipped', (t) => {
  const r = run(t, { 'NOTES.md': 'a\n' }, ({ write }) => write('NOTES.md', 'b\n'), { ...SPEC });
  assert.equal(skipped(r), true);
});

test('wp1: a trace.js crash still produces a context, and docs fall back to being dropped', (t) => {
  const r = run(t, { 'src.js': 'a\n', 'docs/specs/claims.md': 'AC-4: 30 days\n' }, ({ write }) => { write('src.js', 'b\n'); write('docs/specs/claims.md', 'AC-4: 45 days\n'); }, { ...SPEC, STUB_CRASH: '1' });
  assert.equal(skipped(r), false);
  assert.equal(r.ctxFile('files.txt'), 'src.js\n');
  assert.ok(r.ctxFile('requirements-status.json') && r.ctxFile('requirements.md'));
  assert.equal(skipped(run(t, { 'docs/specs/claims.md': 'AC-4: 30 days\n' }, ({ write }) => write('docs/specs/claims.md', 'AC-4: 45 days\n'), { ...SPEC, STUB_CRASH: '1' })), true);
});

test('wp1: trace=off never runs trace.js and requirement docs stay dropped; REQ_PATHS reaches trace.js', (t) => {
  const off = run(t, { 'docs/specs/claims.md': 'AC-4: 30 days\n' }, ({ write }) => write('docs/specs/claims.md', 'AC-4: 45 days\n'), { ...SPEC, STUB_COUNT: '1', TRACE: 'off' });
  assert.equal(skipped(off), true);
  assert.equal(off.ctxFile('trace-ran'), null);
  const on = run(t, { 'src.js': 'a\n' }, ({ write }) => write('src.js', 'b\n'), { REQ_PATHS: 'specs/**\n!docs/**', TRACE: 'auto' });
  assert.equal(on.ctxFile('trace-ran'), 'REQ_PATHS=specs/**\n!docs/** TRACE=auto');
});

test('wp1: a missing trace.js (older checkout) degrades to the previous behaviour', (t) => {
  const r = run(t, { 'src.js': 'a\n', 'docs/x.md': 'a\n' }, ({ write }) => { write('src.js', 'b\n'); write('docs/x.md', 'b\n'); }, {}, null);
  assert.equal(r.ctxFile('files.txt'), 'src.js\n');
});

test('wp1: the dogfood workflow excludes this repo\'s own docs and fixtures from requirement discovery, and action.yml wires the inputs', () => {
  const ci = fs.readFileSync(path.join(__dirname, '../.github/workflows/ci.yml'), 'utf8').replace(/\r/g, '');
  const block = /requirements_paths: \|\n((?: {12}\S.*\n)+)/.exec(ci);
  assert.ok(block, 'dogfood step passes requirements_paths');
  assert.deepEqual(block[1].split('\n').filter(Boolean).map((l) => l.trim()), ['!docs/**', '!eval/**', '!research/**', '!README.md', '!skills/**', '!.github/**', '!ccr/**']);
  const action = fs.readFileSync(path.join(__dirname, '../action.yml'), 'utf8');
  assert.match(action, /REQ_PATHS: \$\{\{ inputs\.requirements_paths \}\}/);
  assert.match(action, /TRACE: \$\{\{ inputs\.trace \}\}/);
  assert.match(action, /requirements_paths: \{[^}]*default: ""/);
  assert.match(action, /trace: \{[^}]*default: auto/);
});
