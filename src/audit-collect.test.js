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

const DOC = [
  '# Window design', '', 'Short.', '', '## 2. Window structure', '',
  '| Window | Form |', '|---|---|', '| Main window | Regular window, 1000x740, minimum 820x600 |', '| Ball | 76x76 collapsed control bar |', '',
  'The main window is hidden once recording starts and returns on stop.', '',
  '- The first row of the recording list is selected by default', '- Renaming starts only when the button is clicked', '', '```js', 'const hiddenInCode = "a code line that is long enough";', '```', '',
  '[design-1]: https://example.invalid/some/long/link/reference', '', '## 3. Rules', '', 'A plan MUST be rejected when its start is in the past.', '', 'A plan SHALL NOT fire twice in one minute.', '',
  '## Changelog', '', '- 2025-01-02 changed the window height to 800 pixels', '', '### 2025-01', '', 'Renamed the navigation rail in this release.', '', '## 4. After', '', 'The completion card stays until the user closes it.', ''];
const cands = (ctx) => rows(ctx, 'audit-candidates.txt');
const textOf = (c) => c.map((x) => x[3]);
const metaOf = (ctx) => JSON.parse(fs.readFileSync(path.join(ctx, 'audit-meta.json'), 'utf8'));

test('collect: audit-candidates.txt lists every requirement-bearing block in document order (cid, path:line, heading, text)', (t) => {
  const { root, ctx } = repo(t, { 'docs/design.md': DOC.join('\n') });
  const r = collect({ cwd: root, ctx });
  const c = cands(ctx);
  assert.deepEqual(textOf(c).map((x) => x.slice(0, 20)), ['| Main window | Regu', '| Ball | 76x76 colla', 'The main window is h', 'The first row of the', 'Renaming starts only', 'A plan MUST be rejec', 'A plan SHALL NOT fir', 'The completion card ']);
  assert.deepEqual(c.map((x) => x[1]), ['docs/design.md:9', 'docs/design.md:10', 'docs/design.md:12', 'docs/design.md:14', 'docs/design.md:15', 'docs/design.md:25', 'docs/design.md:27', 'docs/design.md:39']);
  assert.deepEqual(c.map((x) => x[2]), ['2. Window structure', '2. Window structure', '2. Window structure', '2. Window structure', '2. Window structure', '3. Rules', '3. Rules', '4. After']);
  for (const x of c) assert.match(x[0], /^[0-9a-f]{8}$/);
  assert.equal(new Set(c.map((x) => x[0])).size, c.length);
  const meta = metaOf(ctx);
  assert.deepEqual([meta.candidates, meta.candidates_listed, r.candidates, meta.cap_left], [8, 8, 8, []]);
});

test('collect: headings, table header and separator rows, code fences, link references, short blocks and Changelog sections are not candidates', (t) => {
  const { root, ctx } = repo(t, { 'docs/design.md': DOC.join('\n') });
  collect({ cwd: root, ctx });
  const all = textOf(cands(ctx)).join('\n');
  for (const gone of ['Window structure', '| Window | Form |', '|---|', 'hiddenInCode', 'design-1', 'Short.', '800 pixels', 'navigation rail']) assert.ok(!all.includes(gone), gone);
});

test('collect: a cid ignores line moves but not the block text or heading; a repeated block gets its own cid', (t) => {
  const ids = (doc) => { const { root, ctx } = repo(t, { 'docs/design.md': doc }); collect({ cwd: root, ctx }); return new Map(cands(ctx).map((x) => [x[3], x[0]])); };
  const pick = (m, start) => [...m.entries()].find(([x]) => x.startsWith(start))[1];
  const base = ids(DOC.join('\n'));
  const moved = ids(['Intro paragraph that was added above everything else.', '', ...DOC].join('\n'));
  for (const [text, cid] of base) assert.equal(moved.get(text), cid, text);
  const reworded = ids(DOC.join('\n').replace('is selected by default', 'is highlighted by default'));
  assert.notEqual(pick(reworded, 'The first row'), pick(base, 'The first row'));
  assert.equal(pick(reworded, '| Main window'), pick(base, '| Main window'), 'other blocks keep their cid');
  const reheaded = ids(DOC.join('\n').replace('## 4. After', '## 4. Afterwards'));
  assert.notEqual(pick(reheaded, 'The completion'), pick(base, 'The completion'));
  const { root, ctx } = repo(t, { 'docs/design.md': `${DOC.join('\n')}\nThe completion card stays until the user closes it.\n` });
  collect({ cwd: root, ctx });
  const same = cands(ctx).filter((x) => x[3].startsWith('The completion'));
  assert.equal(same.length, 2);
  assert.notEqual(same[0][0], same[1][0]);
});

test('collect: the cap takes the first blocks in document order across documents; the rest are counted by document and heading', (t) => {
  const { root, ctx } = repo(t, { 'docs/design.md': DOC.join('\n'), 'docs/spec.md': '# Other\n\n## Limits\n\nThe name MUST be at most 40 characters long.\n\nThe list MUST show 50 rows per page at most.\n' });
  const r = collect({ cwd: root, ctx, maxRequirements: 4 });
  assert.deepEqual(cands(ctx).map((x) => x[1]), ['docs/design.md:9', 'docs/design.md:10', 'docs/design.md:12', 'docs/design.md:14']);
  const meta = metaOf(ctx);
  assert.deepEqual([meta.candidates, meta.candidates_listed, r.candidates], [10, 4, 10]);
  assert.deepEqual(meta.cap_left, ['docs/design.md § 2. Window structure: 1 block not audited (cap)', 'docs/design.md § 3. Rules: 2 blocks not audited (cap)', 'docs/design.md § 4. After: 1 block not audited (cap)', 'docs/spec.md § Limits: 2 blocks not audited (cap)']);
});

test('collect: a candidate file over 60 KB lowers the cap instead of cutting a row, and says so', (t) => {
  const para = (i) => `Block ${i} ${'the window keeps its size '.repeat(12)}and must stay ${i} px wide.`;
  const { root, ctx } = repo(t, { 'docs/design.md': `# Big design\n\n${Array.from({ length: 300 }, (_, i) => para(i)).join('\n\n')}\n` });
  collect({ cwd: root, ctx, maxRequirements: 500 });
  const text = fs.readFileSync(path.join(ctx, 'audit-candidates.txt'), 'utf8');
  const c = cands(ctx);
  assert.ok(Buffer.byteLength(text) <= 60 * 1024 && c.length > 150 && c.length < 300, String(c.length));
  assert.ok(c.every((x) => x.length === 4 && /^Block \d+ /.test(x[3])), 'whole rows only');
  const meta = metaOf(ctx);
  assert.equal(meta.candidates, 300);
  assert.equal(meta.cap_left[0], `audit-candidates.txt would pass 60 KB: the cap was lowered to ${c.length} blocks`);
  assert.match(meta.cap_left[1], /^docs\/design\.md § Big design: \d+ blocks not audited \(cap\)$/);
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
