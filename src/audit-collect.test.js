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
  assert.deepEqual(c.map((x) => x[1]), ['docs/design.md:9-9', 'docs/design.md:10-10', 'docs/design.md:12-12', 'docs/design.md:14-14', 'docs/design.md:15-15', 'docs/design.md:25-25', 'docs/design.md:27-27', 'docs/design.md:39-39']);
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
  assert.deepEqual(cands(ctx).map((x) => x[1]), ['docs/design.md:9-9', 'docs/design.md:10-10', 'docs/design.md:12-12', 'docs/design.md:14-14']);
  const meta = metaOf(ctx);
  assert.deepEqual([meta.candidates, meta.candidates_listed, r.candidates], [10, 4, 10]);
  assert.deepEqual(meta.cap_left, ['docs/design.md § 2. Window structure: 1 block not scanned (cap)', 'docs/design.md § 3. Rules: 2 blocks not scanned (cap)', 'docs/design.md § 4. After: 1 block not scanned (cap)', 'docs/spec.md § Limits: 2 blocks not scanned (cap)']);
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
  assert.match(meta.cap_left[1], /^docs\/design\.md § Big design: \d+ blocks not scanned \(cap\)$/);
});

test('branchGuard: only the default branch is scanned; unknown ref or payload warns and continues', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'specguard-event-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ev = path.join(dir, 'event.json');
  fs.writeFileSync(ev, JSON.stringify({ repository: { default_branch: 'main' } }));
  assert.deepEqual(branchGuard({ refName: 'main', eventPath: ev }), {});
  assert.match(branchGuard({ refName: 'feature/x', eventPath: ev }).error, /reads the default branch \(main\); this run is on feature\/x/);
  assert.match(branchGuard({ refName: 'main', eventPath: path.join(dir, 'none.json') }).warn, /could not tell/);
  assert.match(branchGuard({ refName: '', eventPath: ev }).warn, /could not tell/);
  assert.deepEqual(branchGuard({ refName: 'feature/x', eventPath: ev, stateless: true, sha: 'abcdef0123' }), { note: 'Scanned ref: feature/x @ abcdef0 (not the default branch main; no scan state was read or written)' });
  assert.deepEqual(branchGuard({ refName: 'main', eventPath: ev, stateless: true, sha: 'abcdef0123' }), {}, 'the default branch needs no note');
  assert.match(branchGuard({ refName: 'feature/x', eventPath: ev, stateless: false, sha: 'abcdef0' }).error, /reads the default branch/);
});

test('testLayout: names the directories, file-name patterns and config that exist', () => {
  const l = testLayout(['src/a.js', 'src/__tests__/a.test.ts', 'test/b_test.go', 'app/FooTests.cs', 'package.json', 'docs/test-plan.md']);
  assert.match(l, /^test directories: [^\n]*src\/__tests__ \(1\)/);
  assert.match(l, /test file names: [^\n]*\*\.test\.\* \(1\)[^\n]*\*_test\.\* \(1\)/);
  assert.match(l, /test config files: package\.json/);
  assert.doesNotMatch(l, /test-plan/);
});

test('CLI: rejects a bad audit_max_requirements (deprecated) or scan_max_blocks and writes the skip output', (t) => {
  const { root, ctx } = repo(t, FILES);
  const run = (env) => spawnSync(process.execPath, [path.join(__dirname, 'audit-collect.js')], { cwd: root, encoding: 'utf8', env: { ...process.env, CTX: ctx, GITHUB_REF_NAME: '', GITHUB_EVENT_PATH: '', ...env } });
  for (const bad of ['0', '501', 'x', '-3', '8.5']) assert.equal(run({ MAX_REQUIREMENTS: bad }).status, 1, bad);
  for (const bad of ['0', '501', 'x']) { const r = run({ SCAN_MAX_BLOCKS: bad }); assert.equal(r.status, 1, bad); assert.match(r.stdout, /::error::scan_max_blocks must be an integer from 1 to 500/); }
  assert.match(run({ MAX_REQUIREMENTS: '0' }).stdout, /::error::audit_max_requirements must be an integer/);
  const out = path.join(root, 'out.txt');
  const ok = run({ MAX_REQUIREMENTS: '80', GITHUB_OUTPUT: out });
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(fs.readFileSync(out, 'utf8'), 'skip=false\n');
  assert.match(ok.stdout, /::warning::could not tell whether this ref is the default branch/);
  const cap = (env) => { assert.equal(run(env).status, 0); return JSON.parse(fs.readFileSync(path.join(ctx, 'audit-meta.json'), 'utf8')).max_requirements; };
  assert.equal(cap({ MAX_REQUIREMENTS: '3' }), 3, 'the deprecated name still works alone');
  assert.equal(cap({ SCAN_MAX_BLOCKS: '7' }), 7);
  assert.equal(cap({ SCAN_MAX_BLOCKS: '7', MAX_REQUIREMENTS: '3' }), 7, 'scan_max_blocks wins over audit_max_requirements');
  assert.equal(cap({ SCAN_MAX_BLOCKS: '', MAX_REQUIREMENTS: '3' }), 3, 'an unset (empty) scan_max_blocks falls back to the alias');
  assert.equal(cap({ SCAN_MAX_BLOCKS: '', MAX_REQUIREMENTS: '' }), 80);
  const ev = path.join(root, 'event.json');
  fs.writeFileSync(ev, JSON.stringify({ repository: { default_branch: 'main' } }));
  const off = run({ GITHUB_REF_NAME: 'dev', GITHUB_EVENT_PATH: ev, SCAN_ISSUE: 'true' }); // with scan_issue off a non-default ref is allowed (own test below)
  assert.equal(off.status, 1);
  assert.match(off.stdout, /::error::mode scan reads the default branch \(main\); this run is on dev/);
  assert.equal(run({ GITHUB_REF_NAME: 'main', GITHUB_EVENT_PATH: ev }).status, 0);
  const none = repo(t, { 'a.js': 'x\n' });
  spawnSync(process.execPath, [path.join(__dirname, 'audit-collect.js')], { cwd: none.root, env: { ...process.env, CTX: none.ctx, GITHUB_REF_NAME: '', GITHUB_OUTPUT: path.join(none.root, 'o.txt') } });
  assert.equal(fs.readFileSync(path.join(none.root, 'o.txt'), 'utf8'), 'skip=true\n');
});

test('testLayout with test_paths: the configured locations are listed as authoritative and every non-document file there counts as a test', () => {
  const files = ['src/a.js', 'qa/checks/pay_check.js', 'qa/checks/README.md', 'qa/helpers/util.js', 'tests/a.test.js', 'package.json'];
  const plain = testLayout(files);
  assert.match(plain, /test directories: tests \(1\)/);
  assert.doesNotMatch(plain, /configured test locations/);
  const set = testLayout(files, 'qa\n!qa/helpers/');
  assert.match(set, /^configured test locations \(authoritative, set by the repository owner; a ! line is excluded\): qa, !qa\/helpers\/\n/);
  assert.match(set, /test directories: qa\/checks \(1\)\n/, 'the test-like file outside the configured folders is not listed; README and excluded folders do not count');
  assert.equal(testLayout(files, ''), plain);
});

test('collect with testPaths writes the configured layout to test-layout.txt', (t) => {
  const r = repo(t, { ...FILES, 'qa/checks/plan_check.js': 'x\n' });
  collect({ cwd: r.root, ctx: r.ctx, testPaths: 'qa/checks' });
  assert.match(fs.readFileSync(path.join(r.ctx, 'test-layout.txt'), 'utf8'), /configured test locations[^\n]*: qa\/checks\ntest directories: qa\/checks \(1\)/);
});

// ---- evidence candidates, scan_paths, rotation ----
const { select, scopeFn, loadPrior } = require('./audit-collect');
const audit = require('./audit-post');
const evRows = (ctx) => rows(ctx, 'audit-evidence.txt');
const SCHED_DOC = '# Delivery\n\nThe scheduler MUST double the retry delay after each failed delivery attempt, up to the maxDelay limit.\n\nThe community team MUST publish the release notes every month.\n';
const SCHED_SRC = '// Delivery retry scheduling\nfunction nextRetryDelay(retryDelay, maxDelay) {\n  // double the retry delay after each failed delivery attempt, capped at maxDelay\n  return Math.min(retryDelay * 2, maxDelay);\n}\nmodule.exports = { nextRetryDelay };\n';
const SCHED_TEST = "test('doubles the retry delay after a failed delivery attempt', () => {\n  assert.equal(nextRetryDelay(100, 1000), 200);\n});\ntest('caps the retry delay at maxDelay', () => {\n  assert.equal(nextRetryDelay(800, 1000), 1000);\n});\n";
const SCHED = {
  'docs/design.md': SCHED_DOC,
  'src/scheduler.js': SCHED_SRC,
  'src/invoice.js': 'exports.total = (items) => items.reduce((a, i) => a + i.price, 0);\n',
  'tests/scheduler.test.js': SCHED_TEST,
  'data/results/run1.json': '{"note": "double the retry delay after each failed delivery attempt maxDelay limit"}\n',
};
const cidOfText = (ctx, re) => cands(ctx).find((c) => re.test(c[3]))[0];

test('evidence: a block gets code and test locations (path:line and the matching line); an unrelated block, a data file and a document get none', (t) => {
  const { root, ctx } = repo(t, SCHED);
  const r = collect({ cwd: root, ctx });
  const ev = evRows(ctx), retry = cidOfText(ctx, /retry delay/), notes = cidOfText(ctx, /release notes/);
  const mine = ev.filter((e) => e[0] === retry), code = mine.filter((e) => e[1] === 'code'), tests = mine.filter((e) => e[1] === 'test');
  assert.deepEqual(code.map((e) => e[2].split(':')[0]), ['src/scheduler.js']);
  assert.deepEqual(tests.map((e) => e[2].split(':')[0]), ['tests/scheduler.test.js']);
  assert.ok(code.length <= 3 && tests.length <= 3);
  const [p, l] = code[0].slice(2, 3)[0].split(':');
  assert.equal(fs.readFileSync(path.join(root, p), 'utf8').split('\n')[l - 1].trim(), code[0][3], 'the line number points at the snippet');
  assert.match(code[0][3], /double the retry delay/);
  assert.deepEqual(ev.filter((e) => e[0] === notes), [[notes, 'none']], 'a block with no match says none');
  assert.ok(ev.every((e) => !/results|\.json|\.md/.test(e[2] || '')));
  assert.deepEqual([r.evidence.blocks, r.evidence.with_code, r.evidence.with_tests], [2, 1, 1]);
  assert.deepEqual(metaOf(ctx).evidence, { blocks: 2, with_code: 1, with_tests: 1, cut: false, files: 5 });
  assert.ok(metaOf(ctx).limitations.some((x) => /capped at 3 code and 3 test locations per block/.test(x)), 'the cap is stated');
});

test('evidence: a long table row whose sizes sit in one config line gets that line through two of its numbers, though UI files hold more of the row words', (t) => {
  const ROW = ['# Windows', '', '| Main window | Regular window, 1000×740, minimum 820×600; 84 px navigation rail on the left (Record / Recordings / Toolbox / Settings) | Visible when idle and after stopping; hidden while recording, restored from the tray icon |', '',
    '| Toolbar | 48 px tall with 12 px padding; buttons for Record / Recordings / Toolbox / Settings on the navigation rail, hidden while recording |', ''].join('\n');
  const UI = ['// navigation rail on the left: Record, Recordings, Toolbox, Settings', "export const rail = ['Record', 'Recordings', 'Toolbox', 'Settings']",
    '// main window visible when idle and after stopping; hidden while recording', 'export function onStop(win) { win.show() } // restored from the tray icon',
    'export function onRecord(win) { win.hide() }', '// regular window with a navigation rail, recordings list and toolbox', ''].join('\n');
  const filler = (s) => `${s}\n`.repeat(60);
  const { root, ctx } = repo(t, {
    'docs/design.md': ROW,
    'electron/app.cjs': `${filler('// ipc plumbing for the capture process')}const w = mk('main', { width: 1000, height: 800, minWidth: 820, minHeight: 600, title: 'rec' }, true)\n${filler('// ffmpeg argument assembly')}`,
    'electron/bar.cjs': `${filler('// codec probing helpers')}const bar = { height: 48, padding: 12 }\n${filler('// muxer flags')}`,
    'src/ui/MainWindow.tsx': UI, 'src/ui/Tray.tsx': UI, 'src/ui/Rail.tsx': UI, 'src/ui/Nav.tsx': UI,
  });
  collect({ cwd: root, ctx, reqPaths: 'docs/design.md' });
  const code = evRows(ctx).filter((e) => e[1] === 'code').map((e) => e[2]);
  assert.ok(code.some((c) => /^electron\/app\.cjs:/.test(c)), code.join(' | '));
  const bar = cidOfText(ctx, /Toolbar/), barCode = evRows(ctx).filter((e) => e[0] === bar && e[1] === 'code').map((e) => e[2]);
  assert.ok(barCode.some((c) => /^electron\/bar\.cjs:/.test(c)), `two-digit values count: ${barCode.join(' | ')}`);
});

test('evidence: with many UI files holding more of the row words, the window with two of the row numbers is still a candidate (literal windows are taken before the score order)', (t) => {
  const ROW = ['# Windows', '', '| Main window | Regular window, 1000×740, minimum 820×600; 84 px navigation rail on the left (Record / Recordings / Toolbox / Settings) | Visible when idle and after stopping; hidden while recording, restored from the tray icon |', ''].join('\n');
  const UI = ['// navigation rail on the left: Record, Recordings, Toolbox, Settings', "export const rail = ['Record', 'Recordings', 'Toolbox', 'Settings']",
    '// main window visible when idle and after stopping; hidden while recording', 'export function onStop(win) { win.show() } // restored from the tray icon',
    'export function onRecord(win) { win.hide() }', '// regular window with a navigation rail, recordings list and toolbox', ''].join('\n');
  const files = { 'docs/design.md': ROW, 'electron/app.cjs': `${'// ipc plumbing\n'.repeat(60)}const w = mk('main', { width: 1000, height: 800, minWidth: 820, minHeight: 600 }, true)\n${'// ffmpeg flags\n'.repeat(60)}` };
  for (let i = 0; i < 12; i++) files[`src/ui/View${i}.tsx`] = UI;
  const { root, ctx } = repo(t, files);
  collect({ cwd: root, ctx, reqPaths: 'docs/design.md' });
  const code = evRows(ctx).filter((e) => e[1] === 'code').map((e) => e[2]);
  assert.ok(code.some((c) => /^electron\/app\.cjs:/.test(c)), code.join(' | '));
});

test('evidence: the time budget ends the search; every block says none and the limitation names it', (t) => {
  const { root, ctx } = repo(t, SCHED);
  const r = collect({ cwd: root, ctx, evidenceBudgetMs: 0 });
  assert.ok(evRows(ctx).length === 2 && evRows(ctx).every((e) => e[1] === 'none'));
  assert.equal(r.evidence.cut, true);
  assert.ok(metaOf(ctx).limitations.some((x) => /time budget ended the evidence search/.test(x)));
});

const MONO = {
  'packages/a/docs/design.md': SCHED_DOC, 'packages/a/src/scheduler.js': SCHED_SRC, 'packages/a/tests/scheduler.test.js': SCHED_TEST,
  'packages/b/docs/design.md': '# Billing\n\nThe billing service MUST round every invoice total to two decimals before sending it.\n\nThe billing service MUST NOT send an invoice twice.\n',
  'packages/b/src/billing.js': 'function roundInvoiceTotal(total) { return Math.round(total * 100) / 100; } // round every invoice total to two decimals before sending it\n',
  'packages/b/src/scheduler.js': SCHED_SRC, // the same names in another package: must not be offered to package a
  'packages/b/tests/billing.test.js': "test('rounds every invoice total to two decimals before sending it', () => { assert.equal(roundInvoiceTotal(1.005), 1.01); });\n",
};

// scan_paths selects the units to review; documents, tests and evidence are read repo-wide (a unit's tests often live outside its package)
test('scan_paths: documents, code and tests are still read from the whole repository (! excludes only narrow the units); without it the result is the same', (t) => {
  const all = repo(t, MONO);
  collect({ cwd: all.root, ctx: all.ctx });
  assert.deepEqual(rows(all.ctx, 'audit-docs.txt').map((d) => d[0]).sort(), ['packages/a/docs/design.md', 'packages/b/docs/design.md']);
  const retry = cidOfText(all.ctx, /retry delay/);
  assert.deepEqual(evRows(all.ctx).filter((e) => e[0] === retry && e[1] === 'code').map((e) => e[2].split(':')[0]).sort(), ['packages/a/src/scheduler.js', 'packages/b/src/scheduler.js']);

  const a = repo(t, MONO);
  collect({ cwd: a.root, ctx: a.ctx, scanPaths: 'packages/a/**' });
  assert.deepEqual(rows(a.ctx, 'audit-docs.txt').map((d) => d[0]).sort(), ['packages/a/docs/design.md', 'packages/b/docs/design.md'], 'the other package\'s documents are still read');
  assert.ok(cands(a.ctx).every((c) => c[1].startsWith('packages/a/')), 'blocks whose evidence is only in packages/b are not audited');
  assert.ok(metaOf(a.ctx).limitations.some((l) => /document block\(s\) skipped: their evidence is outside scan_paths \(packages\/b\/docs\/design\.md\)/.test(l)));
  assert.deepEqual(evRows(a.ctx).filter((e) => e[0] === retry && e[1] === 'code').map((e) => e[2].split(':')[0]).sort(), ['packages/a/src/scheduler.js', 'packages/b/src/scheduler.js']);
  assert.deepEqual(metaOf(a.ctx).scope, ['packages/a/**']);
  assert.deepEqual(metaOf(a.ctx).candidates, metaOf(all.ctx).candidates);

  const x = repo(t, MONO);
  collect({ cwd: x.root, ctx: x.ctx, scanPaths: 'packages/a/**\n!packages/a/tests/**' });
  assert.ok(evRows(x.ctx).some((e) => e[1] === 'test'), 'tests are evidence wherever they live');
  const only = scopeFn('!packages/b/**');
  assert.ok(only('packages/a/x.js') && !only('packages/b/x.js'), 'an exclude-only scope keeps the rest');
  assert.equal(scopeFn(''), null);
  assert.ok(scopeFn('packages/a')('packages/a/src/x.js') && !scopeFn('packages/a')('packages/ab/x.js'), 'a plain path is a folder');
});

test('scan_paths: a document block is audited in a scoped run only when its evidence touches the scope; the rest are skipped, listed and carried; no scope audits all', (t) => {
  const files = { 'docs/design.md': SCHED_DOC.replace(/\nThe community.*\n/, '') + '\nThe billing service MUST round every invoice total to two decimals before sending it.\n', 'packages/core/src/scheduler.js': SCHED_SRC, 'packages/other/src/billing.js': MONO['packages/b/src/billing.js'] };
  const all = repo(t, files);
  collect({ cwd: all.root, ctx: all.ctx });
  assert.equal(cands(all.ctx).length, 2, 'control: no scope audits every block');
  const bill = cidOfText(all.ctx, /invoice total/), retry = cidOfText(all.ctx, /retry delay/);
  const s = repo(t, files);
  collect({ cwd: s.root, ctx: s.ctx, scanPaths: 'packages/core/**', prior: { head: 'x', blocks: [{ cid: bill, status: 'covered', runs: 1, since: 'x', at: { date: '2026-10-01' } }] }, rotate: true });
  assert.deepEqual(cands(s.ctx).map((c) => c[0]), [retry]);
  assert.deepEqual(rows(s.ctx, 'audit-carried.txt').map((c) => c[0]), [bill], 'its last status is kept');
  assert.ok(metaOf(s.ctx).limitations.some((l) => /1 document block\(s\) skipped: their evidence is outside scan_paths \(docs\/design\.md\)/.test(l)));
});

test('scan_paths: the "N of M blocks not audited" line counts the scope-skipped blocks in both N and M', (t) => {
  const doc = '# Billing\n\nThe billing service MUST round every invoice total to two decimals before sending it.\n\n# Delivery\n\nThe scheduler MUST double the retry delay after each failed delivery attempt, up to the maxDelay limit.\n\n# Limits\n\nThe scheduler MUST double the retry delay after each failed delivery attempt, never below the minDelay limit.\n';
  const r = repo(t, { 'docs/design.md': doc, 'packages/core/src/scheduler.js': SCHED_SRC, 'packages/other/src/billing.js': MONO['packages/b/src/billing.js'] });
  collect({ cwd: r.root, ctx: r.ctx, scanPaths: 'packages/core/**', maxRequirements: 1, rotate: true, prior: { head: 'x', blocks: [] } });
  assert.match(metaOf(r.ctx).limitations.join('\n'), /1 document block\(s\) skipped/);
  assert.equal(rows(r.ctx, 'audit-candidates.txt').length, 1);
  const line = metaOf(r.ctx).cap_left.find((l) => /blocks were not audited this run/.test(l)); // 3 blocks: 1 audited, 1 over the cap, 1 skipped by scope
  assert.match(line, /^2 of 3 blocks were not audited this run \(scan_max_blocks 1\); 0 keep the status of their last audit, 2 have never been audited/, line);
});

test('scan_paths: out-of-scope blocks do not take selection slots run after run (scan_max_blocks 1: the in-scope block is audited in run 2)', (t) => {
  const files = { 'docs/design.md': '# Billing\n\nThe billing service MUST round every invoice total to two decimals before sending it.\n\n# Delivery\n\nThe scheduler MUST double the retry delay after each failed delivery attempt, up to the maxDelay limit.\n', 'packages/core/src/scheduler.js': SCHED_SRC, 'packages/other/src/billing.js': MONO['packages/b/src/billing.js'] };
  const r = repo(t, files);
  const run = (prior) => { collect({ cwd: r.root, ctx: r.ctx, scanPaths: 'packages/core/**', maxRequirements: 1, rotate: true, prior }); return cands(r.ctx).map((c) => c[0]); };
  const first = run(null), second = run({ head: 'x', blocks: first.map((cid) => ({ cid, status: 'covered', runs: 1, since: 'x', at: { date: '2026-10-01' } })) });
  const retry = cidOfText(r.ctx, /retry delay/);
  assert.deepEqual(first, [retry], 'the out-of-scope billing block (ranked first) does not take the single slot');
  assert.deepEqual(second, [retry], 'run 2 audits the in-scope block again, not the skipped one');
  assert.match(metaOf(r.ctx).limitations.join('\n'), /1 document block\(s\) skipped/);
});

const B = (cid, p) => ({ cid, path: p, line: 1, heading: '', text: cid, full: cid });
const [A1, A2, A3, B1, B2, B3, B4, B5, B6, C1] = ['aaaaaaa1', 'aaaaaaa2', 'aaaaaaa3', 'bbbbbbb1', 'bbbbbbb2', 'bbbbbbb3', 'bbbbbbb4', 'bbbbbbb5', 'bbbbbbb6', 'ccccccc1'];
const at = (date) => ({ head: 'h', date });
const ALL = [B(A1, 'docs/a.md'), B(A2, 'docs/a.md'), B(A3, 'docs/a.md'), B(B1, 'docs/b.md'), B(B2, 'docs/b.md'), B(B3, 'docs/b.md'), B(B4, 'docs/b.md'), B(B5, 'docs/b.md'), B(B6, 'docs/b.md'), B(C1, 'docs/c.md')];
const STATE = { head: 'old', blocks: [
  { cid: A1, status: 'gap', since: 'x', runs: 2, at: at('2026-09-15') }, { cid: A2, status: 'covered', since: 'x', runs: 3, at: at('2026-10-01') }, { cid: A3, status: 'gap', since: 'x', runs: 1, at: at('2026-09-10') },
  { cid: B2, status: 'covered', since: 'x', runs: 1, at: at('2026-01-01') }, { cid: B4, status: 'recheck', since: 'x', runs: 1, at: at('2026-09-30') }, { cid: B5, status: 'not_req', since: 'x', runs: 1, at: at('2026-05-01') },
  { cid: B6, status: 'covered', since: 'x', runs: 1, at: null } ] };
const CHANGED = new Map([['docs/b.md', new Set([B2, B3, B4, B5, B6])]]); // B1 is new or edited in the changed document; B3 existed (never audited)

test('select: changed first, then gaps to confirm, then never-audited, then the least recently audited (an unknown date first); no state is document order', () => {
  const order = (cap) => select(ALL, cap, STATE, CHANGED);
  assert.deepEqual(order(99).picked.map((b) => b.cid), [B1, A3, B4, B3, C1, B6, B2, B5, A1, A2]);
  const four = order(4);
  assert.deepEqual(four.picked.map((b) => b.cid), [B1, A3, B4, B3]);
  assert.deepEqual(four.tally, { d: 1, c: 2, n: 1, o: 0 });
  assert.deepEqual(order(7).tally, { d: 1, c: 2, n: 2, o: 2 });
  assert.deepEqual(select(ALL, 3, STATE, null).picked.map((b) => b.cid), [A3, B4, B1], 'no diff available: the new blocks are plain new ones, in document order');
  const plain = select(ALL, 3, null);
  assert.deepEqual([plain.picked.map((b) => b.cid), plain.tally], [[A1, A2, A3], { d: 0, c: 0, n: 3, o: 0 }]);
  assert.deepEqual(select(ALL, 4, { head: 'old', blocks: STATE.blocks.map((b) => (b.cid === A3 ? { ...b, runs: 2 } : b)) }, CHANGED).picked.map((b) => b.cid), [B1, B4, B3, C1], 'a confirmed gap (two runs) is not a gap to confirm');
});

const AB = {
  'docs/a.md': '# A\n\nThe alpha service MUST retry failed uploads three times.\n\nThe alpha service MUST log every rejected upload.\n\nThe alpha service MUST NOT store passwords in plain text.\n',
  'docs/b.md': '# B\n\nThe beta service MUST cache every lookup for ten minutes.\n\nThe beta service MUST evict the oldest entry first.\n\nThe beta service MUST NOT cache failed lookups.\n',
  'src/a.js': 'x\n',
};

test('collect with the issue state: the edited block first, then the gap to confirm, then the oldest; the others are carried by cid; the meta says how many of each', (t) => {
  const { root, ctx, git } = repo(t, AB);
  collect({ cwd: root, ctx });
  const [a1, a2, a3, b1, b2, b3] = cands(ctx).map((c) => c[0]);
  const head1 = git('rev-parse', 'HEAD');
  const state = { head: head1, blocks: [
    { cid: a1, status: 'gap', since: 's', runs: 1, at: at('2026-09-01') }, { cid: a2, status: 'covered', since: 's', runs: 1, at: at('2026-08-01') }, { cid: a3, status: 'covered', since: 's', runs: 1, at: at('2026-09-20') },
    { cid: b1, status: 'covered', since: 's', runs: 1, at: at('2026-07-01') }, { cid: b2, status: 'covered', since: 's', runs: 1, at: at('2026-06-01') }, { cid: b3, status: 'covered', since: 's', runs: 1, at: at('2026-10-01') }] };
  fs.writeFileSync(path.join(root, 'docs/b.md'), AB['docs/b.md'].replace('evict the oldest entry first', 'evict the least recently used entry first'));
  git('add', '.'); git('commit', '-m', 'edit b');
  const r = collect({ cwd: root, ctx, maxRequirements: 3, rotate: true, prior: state });
  const picked = cands(ctx);
  assert.deepEqual(picked.map((c) => c[0]).filter((c) => c !== a1 && c !== b1), picked.map((c) => c[0]).filter((c) => ![a1, b1].includes(c)));
  assert.equal(picked.length, 3);
  assert.deepEqual(picked.slice(0, 2).map((c) => c[0]), [a1, b1], 'listed in document order');
  assert.match(picked[2][3], /least recently used/, 'the edited block (a new cid in a changed document) is chosen');
  assert.deepEqual(r.rotation, { rotate: true, state: true, picked: 3, changed: 1, confirming: 1, new: 0, oldest: 1, carried: 3 });
  assert.deepEqual(rows(ctx, 'audit-carried.txt').map((c) => c[0]), [a2, a3, b3], 'the edited block replaced b2: its old cid is gone from the documents');
  assert.ok(rows(ctx, 'audit-carried.txt').every((c) => /^docs\/[ab]\.md:\d+$/.test(c[1]) && c[3]));
  assert.ok(metaOf(ctx).cap_left.some((l) => /3 of 6 blocks were not audited this run \(scan_max_blocks 3\); 3 keep the status of their last audit, 0 have never been audited/.test(l)), JSON.stringify(metaOf(ctx).cap_left));
  assert.deepEqual(metaOf(ctx).rotation, r.rotation);
});

test('collect with versions (review F06): a covered block whose cited file changed since its audit is stale and audited first; an unchanged citation is not; an unknown audit commit counts as changed', (t) => {
  const files = { ...AB, 'src/cache.js': 'exports.evict = (c) => c.slice(1);\n', 'test/cache.test.js': 'test("evicts", () => assert.equal(evict([1, 2]).length, 1));\n' };
  const { root, ctx, git } = repo(t, files);
  collect({ cwd: root, ctx });
  const ids = cands(ctx).map((c) => c[0]), h = git('rev-parse', 'HEAD').slice(0, 7), hash = (p) => require('node:crypto').createHash('sha1').update(p).digest('hex').slice(0, 8);
  const covered = (cid, date) => ({ cid, status: 'covered', since: h, runs: 1, at: { head: h, date } });
  // the block with the most recent audit date would rest; its cited test file changes in the next commit
  const state = { head: h, blocks: ids.map((c, i) => covered(c, `2026-09-0${i + 1}`)), versions: { uv: {}, ev: { [ids[5]]: [hash('test/cache.test.js')], [ids[4]]: [hash('src/other.js')] } } };
  fs.writeFileSync(path.join(root, 'test/cache.test.js'), 'test("evicts", () => {});\n');
  git('add', '.'); git('commit', '-m', 'weaken the test');
  const r = collect({ cwd: root, ctx, maxRequirements: 1, rotate: true, prior: state });
  assert.deepEqual(cands(ctx).map((c) => c[0]), [ids[5]], 'the stale block before the least recently audited one');
  assert.equal(r.rotation.changed, 1);
  assert.deepEqual(rows(ctx, 'audit-stale.txt').map((c) => c[0]), [ids[5]], 'its neighbour cites an unchanged file');
  const lost = { ...state, blocks: state.blocks.map((b) => (b.cid === ids[4] ? { ...b, at: { head: 'fffffff', date: b.at.date } } : b)) };
  collect({ cwd: root, ctx, maxRequirements: 1, rotate: true, prior: lost });
  assert.deepEqual(rows(ctx, 'audit-stale.txt').map((c) => c[0]).sort(), [ids[4], ids[5]].sort(), 'an audit commit missing from the clone: rechecked');
  assert.ok(metaOf(ctx).limitations.some((l) => /could not diff against an earlier audit commit/.test(l)));
});

test('collect with a state head this clone does not have: the run goes on without the changed-document priority and says so', (t) => {
  const { root, ctx } = repo(t, AB);
  collect({ cwd: root, ctx });
  const state = { head: 'f'.repeat(40), blocks: cands(ctx).map((c) => ({ cid: c[0], status: 'covered', since: 's', runs: 1, at: at('2026-09-01') })) };
  const r = collect({ cwd: root, ctx, maxRequirements: 2, rotate: true, prior: state });
  assert.equal(r.rotation.picked, 2);
  assert.ok(metaOf(ctx).limitations.some((l) => /could not diff against the last scanned commit fffffff \(shallow clone\? use fetch-depth: 0\)/.test(l)));
});

test('collect without a state keeps document order and the per-document leftovers', (t) => {
  const { root, ctx } = repo(t, AB);
  const r = collect({ cwd: root, ctx, maxRequirements: 4, rotate: true });
  assert.deepEqual(r.rotation, { rotate: true, state: false, picked: 4, changed: 0, confirming: 0, new: 4, oldest: 0, carried: 0 });
  assert.deepEqual(cands(ctx).map((c) => c[1].split(':')[0]), ['docs/a.md', 'docs/a.md', 'docs/a.md', 'docs/b.md']);
  assert.deepEqual(metaOf(ctx).cap_left, ['docs/b.md § B: 2 blocks not scanned (cap)']);
  assert.equal(fs.readFileSync(path.join(ctx, 'audit-carried.txt'), 'utf8'), '');
});

test('loadPrior: reads the state of this scope\'s issue over REST (an unscoped scan finds the old unscoped issue); a failure warns and gives no state', async () => {
  const body = (mark, cid) => `${mark}\n## SpecGuard unit test gap scan\n<!-- specguard:audit-state {"v":4,"head":"abc","audits":[["abc","2026-10-01"]],"blocks":[["${cid}","gap","abc",1,0]]} -->`;
  const bot = { type: 'Bot', login: 'github-actions[bot]' };
  const issues = [{ number: 1, body: body(audit.MARK, 'aaaaaaa1'), user: bot }, { number: 2, body: body(audit.scopeOf('packages/a/**').mark, 'bbbbbbb1'), user: bot }, { number: 3, body: body(audit.MARK, 'cccccccc'), user: { type: 'User', login: 'mallory' } }];
  const seen = [];
  const fetchFn = async (url, init) => {
    seen.push([url, init.headers.authorization]);
    if (url.endsWith('/user')) return { ok: false, status: 403, json: async () => ({}) };
    return { ok: true, json: async () => issues };
  };
  const env = (SCAN_PATHS) => ({ GH_REPO: 'o/r', GH_TOKEN: 'tok', SCAN_PATHS });
  const first = (p) => p && p.blocks.map((b) => b.cid);
  assert.deepEqual(first(await loadPrior(env(''), fetchFn)), ['aaaaaaa1'], 'the pre-scope issue still belongs to the unscoped scan');
  assert.deepEqual(first(await loadPrior(env('packages/a/**'), fetchFn)), ['bbbbbbb1']);
  assert.equal(await loadPrior(env('packages/z/**'), fetchFn), null);
  assert.ok(seen.some(([u, a]) => u === 'https://api.github.com/repos/o/r/issues?state=all&per_page=100&page=1' && a === 'Bearer tok'));
  const logs = [], log = console.log;
  console.log = (m) => logs.push(m);
  try { assert.equal(await loadPrior(env(''), async () => ({ ok: false, status: 500, json: async () => ({}) })), null); } finally { console.log = log; }
  assert.match(logs.join('\n'), /::warning::SpecGuard: could not read the previous scan state/);
});

test('collect: blocks the prefilter rules out are listed in audit-ruled.txt with the reason, never reach the candidates, and do not count against the cap', (t) => {
  const design = [
    '# Plan design', '', '## Behaviour', '',
    'A plan MUST be rejected when its start is in the past.', '', 'A repeating plan stays on after it fires.', '', 'A plan SHALL NOT fire twice in one minute.', '',
    '## Results', '', '| Pilot run on Kite | 88% | 2026-10-07 |', '', '| Pilot run on Rea | 93% | 2026-10-08 |', '', 'Node 20 locally vs 22 in CI.', '',
  ].join('\n');
  const { root, ctx } = repo(t, { 'docs/design.md': design });
  const r = collect({ cwd: root, ctx, maxRequirements: 3 });
  const meta = JSON.parse(fs.readFileSync(path.join(ctx, 'audit-meta.json'), 'utf8'));
  const ruled = rows(ctx, 'audit-ruled.txt'), cands = rows(ctx, 'audit-candidates.txt');
  assert.deepEqual(ruled.map((x) => x[4]), ['results/data table row', 'results/data table row', 'under a results/status/sources heading']);
  assert.ok(ruled.every(([cid, loc]) => /^[0-9a-f]{8}$/.test(cid) && /^docs\/design\.md:\d+$/.test(loc)));
  assert.equal(cands.length, 3, 'the three behaviour blocks fit the cap of 3 because the ruled ones are not counted');
  assert.ok(!cands.some(([cid]) => ruled.some(([c]) => c === cid)));
  assert.equal(meta.candidates, 3);
  assert.equal(meta.ruled, 3);
  assert.equal(r.candidates, 3);
});

test('collect: with a pack size, rule files shrink the room for unit parts (a unit that fits alone is split once a big AGENTS.md rides in the pack)', (t) => {
  const src = { 'src/js/a.js': ('x'.repeat(149) + '\n').repeat(100) };
  const part = (files) => { const { root, ctx } = repo(t, { ...src, ...files }); collect({ cwd: root, ctx, packBytes: 250000 }); return rows(ctx, 'audit-units.txt')[0][7]; };
  assert.equal(part({}), '-');
  assert.match(part({ 'AGENTS.md': 'rule\n'.repeat(10000) }), /^part 1\/\d+/);
});

test('collect: audit-blocks.txt holds each candidate block whole (past the 240-character row cut); a block over 4000 characters is marked [truncated] and noted as not fully read', (t) => {
  const decisive = 'The writer MUST use the atomic rename DECISIVE_CLAUSE.', long = `The importer MUST validate ${'every field of the record and '.repeat(150)}end.`;
  const { root, ctx } = repo(t, { 'docs/design.md': `# Design\n\n${'The plan MUST keep state and also '.repeat(10)}${decisive}\n\n${long}\n` });
  collect({ cwd: root, ctx, maxRequirements: 12 });
  const cand = rows(ctx, 'audit-candidates.txt'), blocks = new Map(rows(ctx, 'audit-blocks.txt').map(([c, b]) => [c, b]));
  const [a, b] = cand.map((r) => r[0]);
  assert.ok(!cand[0][3].includes('DECISIVE_CLAUSE') && cand[0][3].length <= 240, 'the row stays cut');
  assert.ok(blocks.get(a).includes('DECISIVE_CLAUSE') && !blocks.get(a).includes('[truncated]'));
  assert.ok(blocks.get(b).endsWith(' [truncated]') && blocks.get(b).length < 4020);
  const meta = JSON.parse(fs.readFileSync(path.join(ctx, 'audit-meta.json'), 'utf8'));
  assert.ok(meta.limitations.some((l) => /longer than 4000 characters.*not fully read/.test(l)), JSON.stringify(meta.limitations));
});

// F25 (audit 3.5, N1): the cid ignores symbols and case, so the persisted text version (versions.tv) is what notices a changed requirement
test('collect with versions (F25): a semantic text change that keeps the cid (operator, sign, literal case) is stale and audited first; whitespace and markdown formatting are not', (t) => {
  const doc = (last) => `# Limits\n\nThe service must log every request it serves.\n\nThe service must cache every response it serves.\n\n${last}\n`;
  const BASE = 'The service must reject amounts >= 10 and offsets of -1 and the literal \'ABC\' always.';
  const { root, ctx, git } = repo(t, { 'docs/design.md': doc(BASE) });
  collect({ cwd: root, ctx });
  const ids = cands(ctx).map((c) => c[0]), h = git('rev-parse', 'HEAD').slice(0, 7);
  const tv = Object.fromEntries(rows(ctx, 'audit-textver.txt'));
  assert.deepEqual(Object.keys(tv).sort(), ids.slice().sort());
  const state = { head: h, blocks: ids.map((c, i) => ({ cid: c, status: 'covered', since: h, runs: 1, at: { head: h, date: `2026-09-0${i + 1}` } })), versions: { uv: {}, ev: {}, tv } };
  const staleAfter = (last) => {
    fs.writeFileSync(path.join(root, 'docs/design.md'), doc(last)); git('add', '.'); git('commit', '-m', 'edit');
    collect({ cwd: root, ctx, maxRequirements: 1, rotate: true, prior: state });
    return { picked: cands(ctx).map((c) => c[0]), stale: rows(ctx, 'audit-stale.txt').map((c) => c[0]) };
  };
  const last = ids[2];
  for (const edit of [BASE.replace('>= 10', '> 10'), BASE.replace('-1', '1'), BASE.replace("'ABC'", "'abc'")]) {
    const r = staleAfter(edit);
    assert.deepEqual([r.picked, r.stale], [[last], [last]], edit);
    assert.equal(cands(ctx)[0][0], last, 'the cid did not change: only the text version noticed');
  }
  for (const edit of [BASE.replace('amounts >= 10', 'amounts   >=  10'), BASE.replace('reject', '**reject**').replace("'ABC'", "`'ABC'`")]) {
    const r = staleAfter(edit);
    assert.deepEqual(r.stale, [], edit);
    assert.deepEqual(r.picked, [ids[0]], 'the least recently audited block, as before');
  }
  // old state without tv: unknown version, nothing is reset
  const old = { ...state, versions: { uv: {}, ev: {} } };
  collect({ cwd: root, ctx, maxRequirements: 1, rotate: true, prior: old });
  assert.deepEqual(rows(ctx, 'audit-stale.txt'), []);
});

test('F21 through the real chain: collect writes path:line-end for a single-line block, and verify rejects a row citing a later line of the same document', (t) => {
  const { root, ctx } = repo(t, { 'docs/design.md': '# Plan\n\nThe service must reject negative amounts.\n\nFiller paragraph that is not a requirement here.\n\nThe service must accept positive amounts.\n' });
  collect({ cwd: root, ctx });
  const { readCandidates, verify } = require('./audit-post');
  const cs = readCandidates(fs.readFileSync(path.join(ctx, 'audit-candidates.txt'), 'utf8'));
  const [a, b] = [...cs.values()];
  assert.deepEqual([a.line, a.end], [3, 3]);
  const lines = fs.readFileSync(path.join(root, 'docs/design.md'), 'utf8').split('\n');
  const cite = (l) => ({ path: 'docs/design.md', line: l, quote: lines[l - 1] });
  const row = (id, l) => ({ id, source: cite(l), text: 'x', class: 'human', status: 'needs_human', code: [], tests: [], note: '' });
  const run = (l) => verify({ docs_reviewed: ['docs/design.md'], requirements: [row(a.cid, l)], not_requirements: [], not_reviewed: [] }, { read: () => lines, cands: cs });
  const v = run(b.line);
  assert.ok(v.not_reviewed.some((n) => n.startsWith(a.cid)), JSON.stringify(v.not_reviewed));
  assert.equal(v.requirements.find((r) => r.id === a.cid).note.startsWith('Unconfirmed'), true);
  assert.deepEqual(run(a.line).not_reviewed, [], 'control: its own line verifies');
});

test('loadPrior: with scan_issue_repo the state is read from that repository under its token, titled by the scanned repository (F24)', async () => {
  const state = '<!-- specguard:audit-state {"v":4,"head":"abc","audits":[["abc","2026-10-01"]],"blocks":[["ddddddd1","gap","abc",1,0]]} -->';
  const bot = { type: 'Bot', login: 'github-actions[bot]' };
  const sc = audit.scopeOf('', 'o/src');
  const issues = [{ number: 1, title: sc.title, body: `${sc.mark}\n${state}`, user: bot }, { number: 2, title: audit.scopeOf('', 'o/other').title, body: `${sc.mark}\n${state.replace('ddddddd1', 'eeeeeee2')}`, user: bot }];
  const seen = [];
  const mk = (reportsVisibility, srcVisibility = 'private') => async (url, init) => {
    seen.push([url, init.headers.authorization]);
    if (url.endsWith('/repos/org/reports')) return { ok: true, json: async () => ({ visibility: reportsVisibility }) };
    if (url.endsWith('/repos/o/src')) return { ok: true, json: async () => ({ visibility: srcVisibility }) };
    if (url.endsWith('/user')) return { ok: false, status: 403, json: async () => ({}) };
    return { ok: true, json: async () => issues };
  };
  const env = { GH_REPO: 'o/src', GH_TOKEN: 'src-tok', ISSUE_REPO: 'org/reports', ISSUE_TOKEN: 'rep-tok', SCAN_PATHS: '' };
  const p = await loadPrior(env, mk('private'));
  assert.deepEqual(p && p.blocks.map((b) => b.cid), ['ddddddd1'], 'only this source repository\'s issue');
  assert.ok(seen.some(([u, a]) => u === 'https://api.github.com/repos/org/reports/issues?state=all&per_page=100&page=1' && a === 'Bearer rep-tok'));
  assert.ok(!seen.some(([u]) => u.includes('/repos/o/src/issues')));
  const logs = [], log = console.log; console.log = (m) => logs.push(m);
  try { assert.equal(await loadPrior(env, mk('public', 'private')), null, 'a public report repository is not used for a private source (the publisher guard)'); } finally { console.log = log; }
  assert.match(logs.join('\n'), /scan issue not read from org\/reports/);
  const same = await loadPrior({ GH_REPO: 'o/src', GH_TOKEN: 'src-tok', ISSUE_REPO: 'o/src', ISSUE_TOKEN: 'x' }, async (u) => (u.endsWith('/user') ? { ok: false, status: 403, json: async () => ({}) } : { ok: true, json: async () => [{ number: 3, body: `${audit.MARK}\n${state}`, user: bot }] }));
  assert.deepEqual(same && same.blocks.map((b) => b.cid), ['ddddddd1'], 'control: the same repository is read as before');
});

test('loadPrior: a malformed scan_issue_repo warns and reads nothing (F24 review)', async () => {
  const logs = [], log = console.log;
  console.log = (m) => logs.push(m);
  try { assert.equal(await loadPrior({ GH_REPO: 'o/src', GH_TOKEN: 't', ISSUE_REPO: 'not-a-repo' }, async () => { throw new Error('no request expected'); }), null); } finally { console.log = log; }
  assert.match(logs.join('\n'), /::warning::SpecGuard: scan_issue_repo "not-a-repo" is not owner\/name; the previous scan state is not read/);
});

test('the publisher and loadPrior pick the same scan issue: same repository, another repository, another repository with scan_paths (F24 review)', async () => {
  const os = require('node:os'), BOT = { type: 'Bot', login: 'github-actions[bot]' };
  const state = (cid) => `<!-- specguard:audit-state {"v":4,"head":"abc","audits":[["abc","2026-10-01"]],"blocks":[["${cid}","gap","abc",1,0]]} -->`;
  const scoped = audit.scopeOf('packages/a/**', 'acme/shop'), plain = audit.scopeOf('', 'acme/shop'), local = audit.scopeOf('packages/a/**');
  const issues = [
    { number: 1, title: audit.TITLE, body: `${audit.MARK}\n${state('00000001')}`, user: BOT, state: 'open' },
    { number: 2, title: plain.title, body: `${plain.mark}\n${state('00000002')}`, user: BOT, state: 'open' },
    { number: 3, title: scoped.title, body: `${scoped.mark}\n${state('00000003')}`, user: BOT, state: 'open' },
    { number: 4, title: audit.scopeOf('', 'acme/other').title, body: `${plain.mark}\n${state('00000004')}`, user: BOT, state: 'open' },
    { number: 5, title: local.title, body: `${local.mark}\n${state('00000005')}`, user: BOT, state: 'open' },
  ];
  const cases = [
    ['same repository', { ISSUE_REPO: '', SCAN_PATHS: '' }, 1],
    ['another repository', { ISSUE_REPO: 'corp/reports', SCAN_PATHS: '' }, 2],
    ['another repository with scan_paths', { ISSUE_REPO: 'corp/reports', SCAN_PATHS: 'packages/a/**' }, 3],
  ];
  for (const [name, extra, number] of cases) {
    const ctx = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-same-'));
    fs.writeFileSync(path.join(ctx, 'audit-meta.json'), JSON.stringify({ head: 'abc123', max_requirements: 80, docs: 0, limitations: [] }));
    const updated = [];
    const client = { rest: { users: { getAuthenticated: async () => { throw new Error('no /user'); } }, repos: { get: async () => ({ data: { visibility: 'private' } }) },
      issues: { listForRepo: () => issues, update: async (a) => { updated.push(a.issue_number); }, create: async () => { updated.push('create'); } } }, paginate: async (fn, a) => fn(a) };
    const env = { CTX: ctx, SKIP: 'true', SCAN_ISSUE: 'true', ENGINE: '', MODEL: '', ...extra }, saved = { ...process.env };
    const core = { warning() {}, summary: { addRaw() { return this; }, async write() {} } };
    try {
      Object.assign(process.env, env);
      await audit({ github: client, issueGithub: client, context: { repo: { owner: 'acme', repo: 'shop' }, sha: 'abc123' }, core });
    } finally { for (const k of Object.keys(env)) if (k in saved) process.env[k] = saved[k]; else delete process.env[k]; fs.rmSync(ctx, { recursive: true, force: true }); }
    const fetchFn = async (u) => (/\/repos\/[^/]+\/[^/]+$/.test(u) ? { ok: true, json: async () => ({ visibility: 'private' }) } : u.endsWith('/user') ? { ok: false, status: 403, json: async () => ({}) } : { ok: true, json: async () => issues });
    const prior = await loadPrior({ GH_REPO: 'acme/shop', GH_TOKEN: 't', ISSUE_TOKEN: 'i', ...extra }, fetchFn);
    assert.deepEqual(updated, [number], `${name}: the publisher updates issue ${number}`);
    assert.deepEqual(prior && prior.blocks.map((b) => b.cid), [`0000000${number}`], `${name}: the loader reads the same issue`);
  }
});

// state built through the real audit-post (verify/stateOf/readState), the collector reads it back (review S4, S6)
const stateFixture = (t, files, docs = 'docs/design.md') => {
  const ap = require('./audit-post'), { allBlocks } = require('./audit-collect');
  const r = repo(t, files), head = r.git('rev-parse', 'HEAD'), blocks = allBlocks(r.root, head, [docs]);
  const base = { not_requirements: [], not_reviewed: [], docs_reviewed: [], unit_findings: [] };
  const covered = (b, cited = ['src/x.js', 'tests/x.test.js']) => ({ id: b.cid, source: { path: b.path, line: b.line, quote: b.text }, text: b.text, class: 'unit', status: 'covered',
    code: cited.filter((p) => !p.startsWith('tests/')).map((p) => ({ path: p, line: 1, quote: 'x' })), tests: cited.filter((p) => p.startsWith('tests/')).map((p) => ({ path: p, line: 1, quote: 'x', layer: 'unit' })), note: '' });
  return { ...r, ap, head, blocks, base, covered };
};
const pickedBy = (r, prior, cap = 1) => { collect({ cwd: r.root, ctx: r.ctx, reqPaths: 'docs/design.md', maxRequirements: cap, maxUnits: 1, rotate: true, prior }); return { picked: cands(r.ctx).map((c) => c[0]), stale: rows(r.ctx, 'audit-stale.txt').map((c) => c[0]) }; };

test('review S4: a covered block citing more than 8 files is stale when only the 9th changes; a block citing exactly 8 behaves as before', (t) => {
  for (const [n, untouched] of [[9, null], [8, 'tests/t4.test.js']]) {
    const cited = [1, 2, 3, 4, 5].map((i) => `src/c${i}.js`).concat([1, 2, 3, 4].map((i) => `tests/t${i}.test.js`)).slice(0, n);
    const files = { 'docs/design.md': '# Design\n\n## Rule\nService must reject invalid amounts.\n' };
    for (const p of [1, 2, 3, 4, 5].map((i) => `src/c${i}.js`).concat([1, 2, 3, 4].map((i) => `tests/t${i}.test.js`))) files[p] = `// ${p}\n`;
    const f = stateFixture(t, files), cid = f.blocks[0].cid;
    const prior = f.ap.readState(f.ap.stateOf(f.head, { ...f.base, requirements: [f.covered(f.blocks[0], cited)] }, null, { date: '2026-10-01' }).raw);
    assert.ok(prior.versions.ev[cid].length <= 8, 'the state stays small');
    const edit = (p) => { fs.appendFileSync(path.join(f.root, p), '// edited\n'); f.git('add', '.'); f.git('commit', '-m', `edit ${p}`); };
    if (n === 9) { edit(cited[8]); assert.deepEqual(pickedBy(f, prior).stale, [cid], 'only the 9th cited file changed'); assert.ok(JSON.parse(fs.readFileSync(path.join(f.ctx, 'audit-meta.json'), 'utf8')).limitations.includes('1 block(s) cite more than 8 files; their freshness cannot be tracked, so they are rechecked each run')); }
    else {
      edit(untouched); assert.deepEqual(pickedBy(f, prior).stale, [], 'an uncited file changed: not stale (8-file control)');
      assert.ok(!JSON.parse(fs.readFileSync(path.join(f.ctx, 'audit-meta.json'), 'utf8')).limitations.some((l) => /cite more than 8 files/.test(l)));
      edit(cited[7]); assert.deepEqual(pickedBy(f, prior).stale, [cid], 'the 8th cited file changed');
    }
  }
});

test('review S6: a block the model did not answer is retried first once; unanswered twice it is recorded unsure with the date advanced and rotation moves on', (t) => {
  const f = stateFixture(t, { 'docs/design.md': '# D\n\n## A\nService must reject negative amounts.\n\n## B\nService must reject blank names.\n\n## C\nService must round totals half up.\n\n## D\nService must log every refund.\n', 'src/x.js': 'exports.x = () => 1;\n', 'tests/x.test.js': 'assert.equal(x(), 1);\n' });
  const [A, B, C, D] = f.blocks, { ap, base, covered } = f;
  const s0 = ap.readState(ap.stateOf(f.head, { ...base, requirements: f.blocks.map((b) => covered(b)) }, null, { date: '2026-10-01' }).raw);
  const read = (p) => { try { return fs.readFileSync(path.join(f.root, p), 'utf8').split('\n'); } catch { return null; } };
  const answer = (sent, answered) => ap.verify({ ...base, requirements: answered.map((b) => covered(b)) }, { read, cands: ap.readCandidates(sent.map((b) => `${b.cid}\t${b.path}:${b.line}\t${b.heading}\t${b.text}`).join('\n') + '\n'), docs: new Set(['docs/design.md']) });
  // run 1: A, B, C sent, C not answered; D not sent
  const s1 = ap.readState(ap.stateOf(f.head, answer([A, B, C], [A, B]), s0, { date: '2026-10-15', carried: [s0.blocks.find((b) => b.cid === D.cid)], unanswered: new Set([C.cid]) }).raw);
  assert.deepEqual([s1.blocks.find((b) => b.cid === C.cid).status, s1.versions.un], ['unsure', [C.cid]]);
  assert.deepEqual(pickedBy(f, s1).picked, [C.cid], 'run 2 retries C before the older D');
  // run 2: C sent again and still unanswered: no more retry, the date advances
  const carried = s1.blocks.filter((b) => b.cid !== C.cid);
  const s2 = ap.readState(ap.stateOf(f.head, answer([C], []), s1, { date: '2026-10-16', carried, unanswered: new Set([C.cid]) }).raw);
  const c2 = s2.blocks.find((b) => b.cid === C.cid);
  assert.deepEqual([c2.status, c2.at.date, s2.versions && s2.versions.un], ['unsure', '2026-10-16', undefined]);
  assert.notDeepEqual(pickedBy(f, s2).picked, [C.cid], 'run 3 is not forced to pick C again');
  // control: C answered in run 2 clears the retry
  const ok = ap.readState(ap.stateOf(f.head, answer([C], [C]), s1, { date: '2026-10-16', carried }).raw);
  assert.equal(ok.versions && ok.versions.un, undefined);
});

test('collect: a Gherkin Background is in every scenario body and tv, but the cid is unchanged by it', (t) => {
  const feat = (who) => `Feature: Tenants\n\n  Background:\n    Given a tenant in state ${who}\n\n  Scenario: Login is refused\n    When the user logs in\n    Then access is denied\n\n  Scenario: Export is refused\n    When the user exports data\n    Then access is denied\n`;
  const { allBlocks } = require('./audit-collect');
  const a = repo(t, { 'f/t.feature': feat('SUSPENDED_TENANT') }), b = repo(t, { 'f/t.feature': feat('ACTIVE_TENANT') });
  const x = allBlocks(a.root, 'HEAD', ['f/t.feature']), y = allBlocks(b.root, 'HEAD', ['f/t.feature']);
  assert.equal(x.length, 2);
  assert.equal(x[1].cid, y[1].cid);
  assert.notEqual(x[1].tv, y[1].tv);
  assert.match(x[1].body, /SUSPENDED_TENANT/);
  assert.match(y[1].body, /ACTIVE_TENANT/);
  const plain = allBlocks(repo(t, { 'f/p.feature': 'Feature: P\n\n  Scenario: Only one\n    When the user logs in\n    Then access is denied\n' }).root, 'HEAD', ['f/p.feature'])[0];
  assert.doesNotMatch(plain.body, /Background/);
});

test('collect with versions (F32): a legacy tv (written without the Background) is not stale; a real Background edit is', (t) => {
  const feat = (who) => `Feature: Tenants\n\n  Background:\n    Given a tenant in state ${who}\n\n  Scenario: Login is refused\n    When the user logs in\n    Then access is denied\n`;
  const { allBlocks } = require('./audit-collect');
  const { root, ctx, git } = repo(t, { 'f/t.feature': feat('SUSPENDED_TENANT') });
  collect({ cwd: root, ctx, reqPaths: 'f/t.feature' });
  const [cid] = cands(ctx).map((c) => c[0]), h = git('rev-parse', 'HEAD').slice(0, 7);
  const blk = allBlocks(root, 'HEAD', ['f/t.feature'])[0];
  const stateWith = (tv) => ({ head: h, blocks: [{ cid, status: 'covered', since: h, runs: 1, at: { head: h, date: '2026-09-01' } }], versions: { uv: {}, ev: {}, tv: { [cid]: tv } } });
  const staleFor = (tv) => { collect({ cwd: root, ctx, reqPaths: 'f/t.feature', rotate: true, prior: stateWith(tv) }); return rows(ctx, 'audit-stale.txt').map((r) => r[0]); };
  assert.notEqual(blk.tv, blk.tvLegacy);
  assert.deepEqual(staleFor(blk.tvLegacy), [], 'a state from before Background context is not reset');
  assert.deepEqual(staleFor(blk.tv), []);
  fs.writeFileSync(path.join(root, 'f/t.feature'), feat('ACTIVE_TENANT')); git('add', '.'); git('commit', '-m', 'edit');
  assert.deepEqual(staleFor(blk.tv), [cid], 'a Background edit makes the scenario stale');
});

test('prior-head diff uses --no-renames: in a blobless clone with no network, rename detection needs old blobs and fails, names-only does not', () => {
  assert.match(fs.readFileSync(path.join(__dirname, 'audit-collect.js'), 'utf8'), /\['diff', '--name-only', '--no-renames', '-z', prior\.head, head\]/);
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-blobless-')), run = (cwd, ...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd, encoding: 'utf8' });
  try {
    const src = path.join(d, 'src'), cl = path.join(d, 'cl');
    fs.mkdirSync(src); run(src, 'init', '-q'); run(src, 'config', 'uploadpack.allowFilter', 'true'); run(src, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
    fs.writeFileSync(path.join(src, 'a.md'), Array.from({ length: 40 }, (_, i) => `line ${i} of the design`).join('\n') + '\n'); run(src, 'add', '.'); run(src, 'commit', '-qm', 'one');
    const first = run(src, 'rev-parse', 'HEAD').trim();
    run(src, 'mv', 'a.md', 'b.md'); fs.appendFileSync(path.join(src, 'b.md'), 'one more line\n'); run(src, 'add', '.'); run(src, 'commit', '-qm', 'two');
    run(d, 'clone', '-q', '--filter=blob:none', 'file://' + src.replace(/\\/g, '/'), 'cl');
    run(cl, 'remote', 'remove', 'origin'); // no network from here on
    assert.deepEqual(run(cl, 'diff', '--name-only', '--no-renames', '-z', first, 'HEAD').split('\0').filter(Boolean).sort(), ['a.md', 'b.md']);
    assert.throws(() => execFileSync('git', ['diff', '--name-only', '-z', first, 'HEAD'], { cwd: cl, stdio: 'pipe' }), 'rename detection reads the old blob');
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('CLI: a non-default ref is scanned only when the run reads and writes no scan state, and the note names the ref', (t) => {
  const { root, ctx } = repo(t, FILES);
  const ev = path.join(root, 'event.json');
  fs.writeFileSync(ev, JSON.stringify({ repository: { default_branch: 'main' } }));
  const run = (env) => spawnSync(process.execPath, [path.join(__dirname, 'audit-collect.js')], { cwd: root, encoding: 'utf8', env: { ...process.env, CTX: ctx, GITHUB_REF_NAME: 'dev', GITHUB_EVENT_PATH: ev, SCAN_ISSUE: '', AUDIT_ISSUE: '', GH_TOKEN: '', ...env } });
  const meta = () => JSON.parse(fs.readFileSync(path.join(ctx, 'audit-meta.json'), 'utf8'));
  const off = run({});
  assert.equal(off.status, 0, off.stdout + off.stderr);
  assert.doesNotMatch(off.stdout, /previous scan state/, 'no state lookup');
  assert.match(meta().ref_note, /^Scanned ref: dev @ [0-9a-f]{7} \(not the default branch main; no scan state was read or written\)$/);
  const on = run({ SCAN_ISSUE: 'true' });
  assert.equal(on.status, 1);
  assert.match(on.stdout, /::error::mode scan reads the default branch \(main\); this run is on dev/);
  assert.equal(run({ GITHUB_REF_NAME: 'main', SCAN_ISSUE: 'true' }).status, 0, 'default ref with scan_issue on is unchanged');
  assert.equal(run({ GITHUB_REF_NAME: 'main' }).status, 0);
  assert.equal(meta().ref_note, '', 'no note on the default branch');
});

// the unit calls the collector plans are the ones the engine's pre-flight keeps (claude-api.js keptRooms): block calls take budget first
test('stateless: the collector plans no more unit rooms than the pre-flight keeps, and the budget hint counts the block calls; a stateful run and a pre-flight that keeps all rooms are unchanged', (t) => {
  const files = Object.fromEntries(Array.from({ length: 70 }, (_, i) => [`src/m${i}.js`, Array.from({ length: 300 }, (_, j) => `exports.f${i}_${j} = () => '${'x'.repeat(70)}';`).join(String.fromCharCode(10)) + String.fromCharCode(10)]));
  const { root, ctx } = repo(t, files), run = (o) => { collect({ cwd: root, ctx, maxUnits: 60, packBytes: 250000, unitParts: 3, ...o }); return { inv: JSON.parse(fs.readFileSync(path.join(ctx, 'audit-inventory.json'), 'utf8')), rooms: fs.existsSync(path.join(ctx, 'audit-unit-rooms.json')) ? JSON.parse(fs.readFileSync(path.join(ctx, 'audit-unit-rooms.json'), 'utf8')) : [] }; };
  const price = (fit) => ({ usd: 0.1, budget: 1, max: 8, fit });
  const seen = [];
  const two = run({ price: price(() => ({ rooms: 3, blockUsd: 0.1 })) }), room1 = two.rooms[0].length;
  assert.equal(two.rooms.length, 3, 'control: the pre-flight keeps both rooms');
  const cut = run({ price: price((c) => { seen.push(fs.existsSync(path.join(c, 'audit-units.txt'))); return { rooms: 1, blockUsd: 0.5 }; }) });
  assert.equal(cut.rooms.length, 0, 'one room kept: no room file, one call');
  assert.equal(cut.inv.selected.units, room1);
  assert.equal(seen[0], true, 'the pre-flight reads the ctx the collector wrote');
  const h = cut.inv.budget_hint;
  assert.equal(h.calls, 1);
  assert.equal(h.usd, Math.ceil((h.need * 0.1 + 0.5) * 100) / 100, 'the rooms it takes at 0.10 plus the 0.50 the block calls take');
  const noFit = run({ price: { usd: 0.1, budget: 1, max: 8 } });
  assert.equal(noFit.rooms.length, 3, 'control: no pre-flight to ask');
  const keep = (o) => run({ rotate: true, prior: null, ...o }).rooms.map((x) => x.length);
  assert.deepEqual(keep({ price: price(() => ({ rooms: 3, blockUsd: 0.1 })) }), keep({ price: { usd: 0.1, budget: 1, max: 8 } }), 'control: a stateful run whose rooms the pre-flight keeps is unchanged');
});
