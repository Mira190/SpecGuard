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
  const off = run({ GITHUB_REF_NAME: 'dev', GITHUB_EVENT_PATH: ev });
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

test('scan_paths: documents, code and tests are searched only in the scope (! excludes); without it the whole repository is', (t) => {
  const all = repo(t, MONO);
  collect({ cwd: all.root, ctx: all.ctx });
  assert.deepEqual(rows(all.ctx, 'audit-docs.txt').map((d) => d[0]).sort(), ['packages/a/docs/design.md', 'packages/b/docs/design.md']);
  const retry = cidOfText(all.ctx, /retry delay/);
  assert.deepEqual(evRows(all.ctx).filter((e) => e[0] === retry && e[1] === 'code').map((e) => e[2].split(':')[0]).sort(), ['packages/a/src/scheduler.js', 'packages/b/src/scheduler.js']);

  const a = repo(t, MONO);
  collect({ cwd: a.root, ctx: a.ctx, scanPaths: 'packages/a/**' });
  assert.deepEqual(rows(a.ctx, 'audit-docs.txt').map((d) => d[0]), ['packages/a/docs/design.md']);
  assert.ok(cands(a.ctx).every((c) => c[1].startsWith('packages/a/')));
  const ev = evRows(a.ctx).filter((e) => e[1] !== 'none');
  assert.ok(ev.length > 0 && ev.every((e) => e[2].startsWith('packages/a/')), JSON.stringify(ev));
  assert.deepEqual(metaOf(a.ctx).scope, ['packages/a/**']);
  assert.deepEqual(metaOf(a.ctx).candidates, 2);

  const x = repo(t, MONO);
  collect({ cwd: x.root, ctx: x.ctx, scanPaths: 'packages/a/**\n!packages/a/tests/**' });
  assert.ok(evRows(x.ctx).some((e) => e[1] === 'code') && !evRows(x.ctx).some((e) => e[1] === 'test'), 'the excluded tests are not offered');
  const only = scopeFn('!packages/b/**');
  assert.ok(only('packages/a/x.js') && !only('packages/b/x.js'), 'an exclude-only scope keeps the rest');
  assert.equal(scopeFn(''), null);
  assert.ok(scopeFn('packages/a')('packages/a/src/x.js') && !scopeFn('packages/a')('packages/ab/x.js'), 'a plain path is a folder');
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
