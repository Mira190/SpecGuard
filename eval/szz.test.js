const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const szz = require('./szz.js');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'specguard-szz-test-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
let n = 0;

// A temp repo; commit(files, msg, day) writes files (null deletes) and commits at 2026-01-<day>.
function mkRepo() {
  const d = path.join(tmp, `r${++n}`);
  fs.mkdirSync(d, { recursive: true });
  const git = (...a) => execFileSync('git', a, { cwd: d, encoding: 'utf8' }).trim();
  git('init', '-q');
  for (const [k, v] of [['user.name', 't'], ['user.email', 't@example.invalid'], ['commit.gpgsign', 'false'], ['core.autocrlf', 'false']]) git('config', k, v);
  const commit = (files, msg, day) => {
    for (const [f, t] of Object.entries(files)) {
      const p = path.join(d, f);
      if (t === null) fs.rmSync(p, { force: true }); else { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, t); }
    }
    git('add', '-A');
    const date = `2026-01-${String(day).padStart(2, '0')}T12:00:00Z`;
    execFileSync('git', ['commit', '-q', '-m', msg], { cwd: d, env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } });
    return git('rev-parse', 'HEAD');
  };
  return { d, git, commit };
}
const SRC = (extra = '') => `function limit(n) {\n  return n > 3;\n}\n${extra}`;
const SINCE = '2025-12-01';
const ghFor = (map) => (args) => {
  const key = args[1] in map ? args[1] : args[1].split("/").pop();
  if (!(key in map)) throw new Error(`no fixture for ${key}`);
  return JSON.stringify(map[key]);
};

test('mine finds the introducing commit of a fix and maps it to a PR from the message', () => {
  const { d, commit } = mkRepo();
  commit({ 'src/a.js': SRC(), 'README.md': 'x\n' }, 'init', 1);
  const bug = commit({ 'src/a.js': SRC().replace('n > 3', 'n >= 3') }, 'Tune limit (#11)', 2);
  const fix = commit({ 'src/a.js': SRC().replace('n > 3', 'n > 3 && n < 10') }, 'fix: limit boundary (#12)', 5);
  const m = szz.mine({ repoDir: d, since: SINCE });
  assert.strictEqual(m.candidates.length, 1);
  const c = m.candidates[0];
  assert.strictEqual(c.fix.sha, fix);
  assert.strictEqual(c.fix.pr, 12);
  assert.strictEqual(c.status, 'located');
  assert.deepStrictEqual(c.signals.map((s) => s.signal), ['title_prefix']);
  assert.strictEqual(c.introducing[0].sha, bug);
  assert.strictEqual(c.introducing[0].pr, 11);
  assert.deepStrictEqual([c.introducing[0].confirmed, c.introducing[0].scope, c.introducing[0].grade], [null, null, null]);
  assert.strictEqual(m.stats.located, 1);
  assert.strictEqual(m.stats.pairs_with_pr, 1);
  assert.match(m.contamination, /training data/);
});

test('mine resolves PRs through the injected gh when the message has no number', () => {
  const { d, commit } = mkRepo();
  commit({ 'src/a.js': SRC() }, 'init', 1);
  const bug = commit({ 'src/a.js': SRC().replace('n > 3', 'n >= 3') }, 'Tune limit', 2);
  commit({ 'src/a.js': SRC() }, 'fix: boundary', 5);
  const gh = ghFor({ [`repos/o/r/commits/${bug}/pulls`]: [{ number: 77 }] });
  const m = szz.mine({ repoDir: d, since: SINCE, repo: 'o/r', gh });
  assert.strictEqual(m.candidates[0].introducing[0].pr, 77);
});

test('revert commits name the reverted commit directly with the strongest signal', () => {
  const { d, commit } = mkRepo();
  commit({ 'src/a.js': SRC() }, 'init', 1);
  const bad = commit({ 'src/a.js': SRC('const x = 1;\n') }, 'Add feature (#3)', 2);
  commit({ 'src/a.js': SRC() }, `Revert "Add feature (#3)"\n\nThis reverts commit ${bad}.`, 4);
  const m = szz.mine({ repoDir: d, since: SINCE });
  const c = m.candidates.find((x) => x.signals.some((s) => s.signal === 'revert'));
  assert.ok(c);
  assert.strictEqual(c.signals[0].strength, 'strongest');
  assert.strictEqual(c.introducing[0].sha, bad);
  assert.strictEqual(c.introducing[0].via, 'revert');
  assert.strictEqual(c.introducing[0].pr, 3);
  assert.strictEqual(m.stats.revert_direct, 1);
});

test('a blamed commit made after the bug report is filtered', () => {
  const { d, commit } = mkRepo();
  const Z = (v) => SRC('const z = ' + v + ';\n');
  commit({ 'src/a.js': Z(1) }, 'init', 1);
  const bug = commit({ 'src/a.js': Z(1).replace('n > 3', 'n >= 3') }, 'Tune limit (#2)', 2);
  commit({ 'src/a.js': Z(2).replace('n > 3', 'n >= 3') }, 'Rework z (#4)', 8);
  const fix = commit({ 'src/a.js': Z(1) }, 'fix: limit (#5)\n\nCloses #1', 10);
  const gh = ghFor({ 1: { labels: [{ name: 'bug' }], created_at: '2026-01-05T00:00:00Z' }, 5: { labels: [], pull_request: {} } });
  const m = szz.mine({ repoDir: d, since: SINCE, repo: 'o/r', gh });
  const c = m.candidates.find((x) => x.fix.sha === fix);
  assert.strictEqual(c.report_date_source, 'issue');
  assert.ok(c.signals.some((s) => s.signal === 'issue_label' && s.number === 1));
  assert.deepStrictEqual(c.introducing.map((i) => i.sha), [bug]);
  assert.deepStrictEqual(c.dropped, { after_report: 1 });
});

test('an add-only fix is unlocatable, not guessed', () => {
  const { d, commit } = mkRepo();
  commit({ 'src/a.js': SRC() }, 'init', 1);
  commit({ 'src/a.js': SRC('if (!x) throw new Error("x");\n') }, 'fix: validate input (#6)', 3);
  const m = szz.mine({ repoDir: d, since: SINCE });
  assert.strictEqual(m.candidates[0].status, 'unlocatable');
  assert.deepStrictEqual(m.candidates[0].introducing, []);
  assert.strictEqual(m.stats.unlocatable, 1);
});

test('fixes touching only docs or tests are excluded; whitespace and comment-only edits are not blamed', () => {
  const { d, commit } = mkRepo();
  commit({ 'src/a.js': SRC('// note\n'), 'test/a.test.js': 't\n', 'docs/x.md': 'd\n' }, 'init', 1);
  commit({ 'test/a.test.js': 't2\n', 'docs/x.md': 'd2\n' }, 'fix: tests and docs', 2);
  commit({ 'src/a.js': SRC('// changed note\n') }, 'fix: comment typo', 3);
  const m = szz.mine({ repoDir: d, since: SINCE });
  assert.strictEqual(m.stats.excluded_docs_tests, 1);
  assert.strictEqual(m.candidates.length, 1);
  assert.strictEqual(m.candidates[0].status, 'unlocatable'); // comment-only: nothing to blame
});

test('mass-change introducing commits are dropped', () => {
  const { d, commit } = mkRepo();
  const many = Object.fromEntries(Array.from({ length: szz.MASS + 1 }, (_, i) => [`src/f${i}.js`, `${SRC()}// ${i}\n`]));
  commit(many, 'Mass import', 1);
  commit({ 'src/f0.js': SRC().replace('n > 3', 'n > 4') + '// 0\n' }, 'fix: limit (#9)', 3);
  const m = szz.mine({ repoDir: d, since: SINCE });
  assert.deepStrictEqual(m.candidates[0].introducing, []);
  assert.strictEqual(m.candidates[0].status, 'no_introducing');
  assert.strictEqual(m.candidates[0].dropped.mass_change, 1);
});

test('branch and keyword signals; features with the keyword are not weak fix candidates', () => {
  const sig = (subject, body = '') => szz.messageSignals({ subject, body }).signals.map((s) => s.signal);
  assert.deepStrictEqual(sig("Merge branch 'fix/off-by-one' into main"), ['branch']);
  assert.deepStrictEqual(sig('Fix(parser): crash'), ['title_prefix']);
  assert.deepStrictEqual(sig('Handle broken links'), ['keyword']);
  assert.deepStrictEqual(sig('Add support for fixed width'), []);
  assert.deepStrictEqual(sig('Revert "x"'), ['revert']);
});

test('helpers: isProd, isCommentLine, prFromMessage, ranges', () => {
  assert.ok(szz.isProd('src/a.js') && szz.isProd('lib/Main.java'));
  for (const p of ['README.md', 'docs/a.js', 'test/a.js', 'a.test.ts', 'pkg/x_test.go', 'tests/test_a.py', 'FooTests.java']) assert.ok(!szz.isProd(p), p);
  assert.ok(szz.isCommentLine('  // x') && szz.isCommentLine('# y') && !szz.isCommentLine('x = 1 // y'));
  assert.strictEqual(szz.prFromMessage('Fix thing (#123)'), 123);
  assert.strictEqual(szz.prFromMessage('Merge pull request #45 from a/fix/b'), 45);
  assert.strictEqual(szz.prFromMessage('No number'), null);
  assert.deepStrictEqual(szz.ranges([1, 2, 3, 7, 9, 10]), [[1, 3], [7, 7], [9, 10]]);
});

test('labelSignals needs gh and a repo; distinguishes issue and PR labels; blame and fixLines work on a repo', () => {
  assert.deepStrictEqual(szz.labelSignals({ subject: 'x #1', body: '' }, { gh: null, repo: 'o/r', labels: ['bug'] }), { signals: [], issue: null });
  const gh = ghFor({ 1: { labels: [{ name: 'type: bug' }], created_at: '2026-01-01T00:00:00Z' }, 2: { labels: [{ name: 'bug' }], pull_request: {}, created_at: '2026-01-02T00:00:00Z' } });
  const r = szz.labelSignals({ subject: 'x (#2)', body: 'Fixes #1' }, { gh, repo: 'o/r', labels: ['bug'] });
  assert.deepStrictEqual(r.signals.map((s) => s.signal).sort(), ['issue_label', 'pr_label']);
  assert.strictEqual(r.issue.number, 1);

  const { d, commit } = mkRepo();
  const first = commit({ 'src/a.js': SRC() }, 'init', 1);
  const second = commit({ 'src/a.js': SRC().replace('n > 3', 'n > 4') }, 'change', 2);
  const f = szz.fixLines(d, first, second);
  assert.deepStrictEqual(f, [{ path: 'src/a.js', lines: [2], addOnly: false }]);
  assert.deepStrictEqual(szz.blame(d, second, { path: 'src/a.js', lines: [2] }), { [second]: 1 });
  assert.deepStrictEqual(szz.blame(d, second, { path: 'src/a.js', lines: [] }), {});
  assert.deepStrictEqual(szz.listCommits(d, SINCE).map((c) => c.sha), [second, first]);
});

test('cleanSample is seeded, skips fixes and excluded shas, and respects n', () => {
  const { d, commit } = mkRepo();
  commit({ 'src/a.js': 'a\n' }, 'init', 1);
  const shas = [];
  for (let i = 0; i < 8; i++) shas.push(commit({ [`src/f${i}.js`]: Array.from({ length: 10 }, (_, k) => `l${i}${k}`).join('\n') + '\n' }, `Add module ${i} (#${20 + i})`, 2 + i));
  commit({ 'src/a.js': 'b\nc\nd\ne\nf\ng\n' }, 'fix: a (#40)', 12);
  const window = { since: SINCE };
  const a = szz.cleanSample({ repoDir: d, n: 3, seed: 7, window, exclude: [shas[0]] });
  const b = szz.cleanSample({ repoDir: d, n: 3, seed: 7, window, exclude: [shas[0]] });
  assert.deepStrictEqual(a, b);
  assert.strictEqual(a.length, 3);
  assert.ok(a.every((c) => !/^fix/.test(c.title) && c.sha !== shas[0] && c.pr >= 20));
  assert.notDeepStrictEqual(szz.cleanSample({ repoDir: d, n: 3, seed: 8, window }).map((c) => c.sha), a.map((c) => c.sha));
  const r = szz.mulberry32(1);
  const x = r();
  assert.ok(x >= 0 && x < 1 && szz.mulberry32(1)() === x);
});
