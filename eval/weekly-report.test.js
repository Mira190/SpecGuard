const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { findingsOf, copilotOutcome, patchTouches, analyze, render, quantile } = require('./weekly-report');
const { exportRows, toCsv } = require('./label-export');

const D = (day, h = 0) => `2026-09-${String(day).padStart(2, '0')}T${String(h).padStart(2, '0')}:00:00Z`;
const pr = (number, arm, hrs, extra = {}) => ({ number, created_at: D(1), merged_at: hrs == null ? null : new Date(Date.parse(D(1)) + hrs * 36e5).toISOString(), user: { login: 'dev', type: 'User' }, labels: arm == null ? [] : [{ name: `review-arm:${arm}` }], ...extra });
const counts = (n, since, extra = {}) => ({ issue_url: `https://api.github.com/repos/o/r/issues/${n}`, updated_at: D(2), body: `<!-- specguard:summary -->\n<!-- specguard:counts ${JSON.stringify({ pr: n, complete: true, since, credits: 2.5, ms: 300000, ...extra })} -->` });
const S = (addressed, open = 0, dismissed = 0, not_observed = 0) => ({ addressed, open, dismissed, not_observed });
let id = 100;
const sg = (n, p, line, fp) => ({ id: ++id, pr: n, path: p, line, body: `**Missing test**\n\nbody <!-- specguard:fp=${fp.repeat(40).slice(0, 40)} -->`, user: { login: 'github-actions[bot]', type: 'Bot' }, html_url: `u${id}` });
const cp = (n, p, line, extra = {}) => ({ id: ++id, pr: n, path: p, line, body: 'Consider a null check', user: { login: 'Copilot', type: 'Bot' }, html_url: `u${id}`, ...extra });

function small() {
  id = 100;
  const rc = [
    sg(3, 'a.js', 10, 'a'), sg(6, 'b.js', 5, 'b'), // arm 0
    cp(4, 'c.js', 7, { anchor_touched: true, tests_changed: false }), cp(7, 'c.js', 9, { anchor_touched: false, tests_changed: false }), // arm 1 (ids 103, 104)
    sg(5, 'd.js', 20, 'c'), cp(5, 'd.js', 22, { anchor_touched: false, tests_changed: true }), // arm 2, within 3 lines: overlap
    sg(8, 'e.js', 30, 'd'), cp(8, 'e.js', 99, { anchor_touched: false, tests_changed: false }), // arm 2, far apart (ids 107, 108)
  ];
  return {
    repo: 'o/r', since: '2026-09-01', until: '2026-09-30',
    prs: [pr(3, 0, 10), pr(6, 0, 20), pr(4, 1, 30), pr(7, 1, 40), pr(5, 2, 50), pr(8, 2, 60), pr(9, null, 5), pr(12, 0, 1, { user: { login: 'dependabot[bot]', type: 'Bot' } }), pr(10, 1, 2, { labels: [{ name: 'review-arm:1' }, { name: 'copilot-request-failed' }] })],
    baseline: [pr(101, null, 8), pr(102, null, 12)],
    issue_comments: [counts(3, S(1, 1)), counts(6, S(0, 2, 1)), counts(5, S(2, 0, 0, 1)), counts(8, S(0, 1))],
    review_comments: rc,
    threads: [{ pr: 7, isResolved: true, resolvedBy: 'dev', comments: [{ id: 104, author: 'Copilot' }, { id: 900, author: 'dev' }] }, { pr: 8, isResolved: false, comments: [{ id: 108, author: 'Copilot' }] }],
  };
}

test('findings: tool by marker or bot login, per-PR dedupe, arm 2 overlap within 3 lines', () => {
  const f = findingsOf(small());
  assert.equal(f.filter((x) => x.tool === 'specguard').length, 4);
  assert.equal(f.filter((x) => x.tool === 'copilot').length, 4);
  const ov = (tool, n) => f.find((x) => x.tool === tool && x.pr === n).overlap;
  assert.equal(ov('specguard', 5), true);
  assert.equal(ov('copilot', 5), true);
  assert.equal(ov('specguard', 8), false);
  assert.equal(f.find((x) => x.pr === 3).overlap, undefined); // overlap exists only in arm 2
  assert.ok(!f.some((x) => /specguard:fp/.test(x.text)), 'hidden markers stripped');
});

test('copilot outcome mirrors the SpecGuard rule', () => {
  const res = { isResolved: true }, open = { isResolved: false };
  assert.equal(copilotOutcome({ thread: open, anchor_touched: true, tests_changed: false }), 'addressed');
  assert.equal(copilotOutcome({ thread: open, anchor_touched: false, tests_changed: true }), 'addressed'); // a test-file fix counts
  assert.equal(copilotOutcome({ thread: res, anchor_touched: false, tests_changed: false }), 'dismissed');
  assert.equal(copilotOutcome({ thread: res, anchor_touched: false, tests_changed: true }), 'addressed');
  assert.equal(copilotOutcome({ thread: open, anchor_touched: false, tests_changed: false }), 'open');
  assert.equal(copilotOutcome({ thread: open }), 'not_observed'); // unknown is never "unchanged"
});

test('patchTouches: removed lines and insertions at the anchor, not context', () => {
  const patch = '@@ -10,4 +10,4 @@\n a\n-b\n+B\n c\n d';
  assert.equal(patchTouches(patch, 11, 11), true);
  assert.equal(patchTouches(patch, 10, 10), false);
  assert.equal(patchTouches(patch, 13, 13), false);
});

test('report: per-arm numbers, outcomes, overlap, exclusions, and insufficient data everywhere', () => {
  const r = analyze(small());
  assert.equal(r.excluded_copilot_request_failed, 1);
  assert.equal(r.unlabeled, 1);
  assert.deepEqual([r.arms[0].prs, r.arms[1].prs, r.arms[2].prs], [2, 2, 2]);
  assert.equal(r.arms[0].specguard.findings_per_pr, 1);
  assert.equal(r.arms[0].specguard.credits_median, 2.5);
  assert.equal(r.arms[1].ttm.median, 35);
  assert.equal(r.arms[1].ttm.n, 2);
  assert.equal(r.baseline.median, 10);
  assert.deepEqual(r.specguard.outcomes, { addressed: 3, open: 4, dismissed: 1, not_observed: 1 }); // arms 0+2
  assert.equal(r.specguard.prs, 4);
  // arms 1+2: PR4 addressed (anchor), PR7 dismissed (resolved, nothing changed), PR5 addressed (test file), PR8 open
  assert.deepEqual(r.copilot.outcomes, { addressed: 2, open: 1, dismissed: 1, not_observed: 0 });
  assert.deepEqual([r.overlap.specguard_findings, r.overlap.specguard_also_raised_by_copilot, r.overlap.copilot_also_raised_by_specguard], [2, 1, 1]);
  assert.ok(r.decision.rules.every((x) => x.status === 'insufficient data'));
  assert.match(r.decision.verdict, /KEEP COLLECTING/);
  const md = render(r);
  assert.match(md, /INSUFFICIENT DATA\*\*: Fix-through/);
  assert.match(md, /Overlap in arm 2/);
  assert.match(md, /Copilot A would be/);
});

// A big synthetic trial: SpecGuard fixes ~58%, time-to-merge on par with the baseline, one SpecGuard finding per PR and one Copilot finding per arm-2 PR.
function big({ copilotCoversAll = false } = {}) {
  id = 100;
  const prs = [], issue_comments = [], review_comments = [];
  for (let n = 1; n <= 150; n++) {
    const arm = n % 3;
    prs.push(pr(n, arm, 10 + (n % 7)));
    if (arm === 1) continue;
    issue_comments.push(counts(n, n % 2 ? S(3, 2, 1, 0) : S(4, 1, 0, 1)));
    review_comments.push(sg(n, 'x.js', 10, n.toString(16).padStart(2, '0')));
    if (arm === 2) review_comments.push(cp(n, 'x.js', copilotCoversAll || n % 2 ? 12 : 90, { anchor_touched: false, tests_changed: false }));
  }
  return { repo: 'o/r', since: '2026-09-01', until: '2026-09-30', prs, baseline: Array.from({ length: 40 }, (_, i) => pr(1000 + i, null, 10 + (i % 7))), issue_comments, review_comments, threads: [] };
}
const labelsFor = (ds, share) => {
  const f = findingsOf(ds).filter((x) => x.tool === 'specguard'), m = new Map();
  f.forEach((x, i) => m.set(x.fid, i / f.length < share ? 'valid' : 'invalid'));
  return m;
};

test('decision: every rule passes at target sample sizes -> CONTINUE', () => {
  const ds = big();
  const r = analyze(ds, { labels: labelsFor(ds, 0.8) });
  assert.ok(r.specguard.A > 0.5 && r.specguard.cluster_bootstrap_95[0] > 0.15);
  assert.deepEqual(r.decision.rules.map((x) => x.status), ['pass', 'pass', 'pass', 'pass'], JSON.stringify(r.decision.rules));
  assert.ok(r.decision.falsifiers.slice(0, 4).every((x) => x.status === 'not fired'), JSON.stringify(r.decision.falsifiers));
  assert.match(r.decision.verdict, /^CONTINUE/);
});

test('decision: Copilot covering the valid findings fires F4; low precision fires F1', () => {
  const ds = big({ copilotCoversAll: true });
  let r = analyze(ds, { labels: labelsFor(ds, 0.8) });
  assert.equal(r.decision.falsifiers[3].status, 'FIRED');
  assert.equal(r.decision.rules[3].status, 'fail');
  assert.match(r.decision.verdict, /^STOP/);
  const ds2 = big();
  r = analyze(ds2, { labels: labelsFor(ds2, 0.3) });
  assert.equal(r.decision.falsifiers[0].status, 'FIRED');
});

test('quantile interpolates', () => {
  assert.equal(quantile([1, 2, 3, 4], 0.5), 2.5);
  assert.equal(quantile([], 0.5), null);
});

test('CLI on a fixture: markdown and --json; labels flow through --labels and label-export --import', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wr-'));
  const ds = big(), fx = path.join(dir, 'ds.json');
  fs.writeFileSync(fx, JSON.stringify(ds));
  const rows = exportRows(findingsOf(ds).filter((f) => f.tool === 'specguard'), { sample: 0, seed: 1 });
  const lab = labelsFor(ds, 0.8);
  rows.forEach((r) => { r.label = lab.get(r.id); });
  fs.writeFileSync(path.join(dir, 'l.csv'), toCsv(rows));
  const run = (...a) => spawnSync(process.execPath, [path.join(__dirname, 'weekly-report.js'), '--fixture', fx, ...a], { encoding: 'utf8' });
  const md = run('--labels', path.join(dir, 'l.csv'));
  assert.equal(md.status, 0, md.stderr);
  assert.match(md.stdout, /\*\*CONTINUE/);
  assert.equal(JSON.parse(run('--json').stdout).prs, 150);
  const imp = spawnSync(process.execPath, [path.join(__dirname, 'label-export.js'), '--fixture', fx, '--import', path.join(dir, 'l.csv')], { encoding: 'utf8' });
  assert.equal(imp.status, 0, imp.stderr);
  assert.ok(JSON.parse(imp.stdout).specguard.precision > 0.7);
  assert.equal(spawnSync(process.execPath, [path.join(__dirname, 'weekly-report.js')], { encoding: 'utf8' }).status, 2);
});

// S9: weekly's anchor_touched / tests_changed must follow src/post.js (own first-parent non-merge commits; deleted file = unknown), not the raw compare.
test('load: a merged base and a deleted anchor file give the same anchor/tests answer as post.js', () => {
  const cpm = require('node:child_process');
  const post = require('../src/post');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-weekly-'));
  const git = (...a) => cpm.execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@e.invalid', ...a], { cwd: dir, encoding: 'utf8' }).trim();
  const put = (f, t) => { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), t); };
  const commit = (m) => { git('add', '-A'); git('commit', '-q', '-m', m); return git('rev-parse', 'HEAD'); };
  git('init', '-q', '-b', 'main');
  put('src/a.js', Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join('\n') + '\n'); put('src/gone.js', 'a\nb\nc\nd\ne\nf\n'); commit('base');
  git('checkout', '-q', '-b', 'pr'); put('README.md', 'pr\n'); const orig = commit('pr work');
  git('checkout', '-q', 'main'); put('src/a.js', fs.readFileSync(path.join(dir, 'src/a.js'), 'utf8').replace('line 5', 'line 5 MAIN')); put('tests/base.test.js', 'x\n'); commit('main edits anchor and adds a test');
  git('checkout', '-q', 'pr'); git('merge', '-q', '--no-edit', 'main'); const merged = git('rev-parse', 'HEAD');
  git('rm', '-q', 'src/gone.js'); const deleted = commit('pr deletes gone.js');
  const commitInfo = (sha) => {
    const files = git('diff-tree', '--no-commit-id', '--name-status', '-r', '--no-renames', '-m', '--first-parent', sha).split('\n').filter(Boolean).map((l) => {
      const [s, name] = l.split('\t'); const d = git('diff', '--no-renames', '-U3', `${sha}^1`, sha, '--', name); const i = d.indexOf('\n@@');
      return { filename: name, status: s === 'D' ? 'removed' : s === 'A' ? 'added' : 'modified', patch: i < 0 ? undefined : d.slice(i + 1) };
    });
    return { sha, parents: git('rev-list', '--parents', '-n', '1', sha).split(' ').slice(1).map((p) => ({ sha: p })), files };
  };
  const compare = (a, b) => {
    const commits = git('rev-list', '--reverse', `${a}..${b}`).split('\n').filter(Boolean).map(commitInfo);
    const names = git('diff', '--name-status', '--no-renames', a, b).split('\n').filter(Boolean).map((l) => { const [s, name] = l.split('\t'); const d = git('diff', '--no-renames', a, b, '--', name); const i = d.indexOf('\n@@'); return { filename: name, status: s === 'D' ? 'removed' : s === 'A' ? 'added' : 'modified', patch: i < 0 ? undefined : d.slice(i + 1) }; });
    return { status: 'ahead', total_commits: commits.length, commits, files: names };
  };
  const mk = (id, p, line, sha) => ({ id, user: { login: 'copilot-pull-request-reviewer[bot]', type: 'Bot' }, pull_request_url: 'https://api.github.com/repos/o/r/pulls/1', path: p, line, original_line: line, original_commit_id: sha, body: 'x' });
  const run = (cmts, headSha) => {
    const gh = (a) => {
      const s = a.join(' '); let m;
      if (s.includes('search/issues')) return JSON.stringify([{ number: 1, created_at: '2026-10-10T00:00:00Z', closed_at: null, pull_request: { merged_at: null }, user: { login: 'dev', type: 'User' }, labels: [] }]);
      if (s.includes('issues/comments')) return '[]';
      if (s.includes('pulls/comments')) return JSON.stringify(cmts);
      if (s.includes('graphql')) return JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } } });
      if ((m = /compare\/(\w+)\.\.\.(\w+)/.exec(s))) return JSON.stringify(compare(m[1], m[2]));
      if ((m = /commits\/(\w+)$/.exec(s))) return JSON.stringify(commitInfo(m[1]));
      if (/pulls\/1$/.test(s)) return JSON.stringify({ head: { sha: headSha } });
      throw new Error('unexpected gh call: ' + s);
    };
    const real = cpm.execFileSync;
    cpm.execFileSync = (cmd, args, o) => (cmd === 'gh' ? gh(args) : real(cmd, args, o));
    try { delete require.cache[require.resolve('./weekly-report')]; return require('./weekly-report').load({ repo: 'o/r', since: '2026-10-01', until: '2026-10-16' }).review_comments[0]; }
    finally { cpm.execFileSync = real; delete require.cache[require.resolve('./weekly-report')]; }
  };
  const a = run([mk(11, 'src/a.js', 5, orig)], merged);
  assert.deepEqual([a.anchor_touched, a.tests_changed], [post.anchorTouched(orig, merged, 'src/a.js', 5, 5, dir), post.testsChanged(orig, merged, dir)]);
  assert.deepEqual([a.anchor_touched, a.tests_changed], [false, false]);
  const b = run([mk(12, 'src/gone.js', 3, merged)], deleted);
  assert.equal(b.anchor_touched, post.anchorTouched(merged, deleted, 'src/gone.js', 3, 3, dir));
  assert.equal(b.anchor_touched, null);
});

// S9 review: unified0 re-derives -U0 hunks from a -U3 patch; each shape must match real `git diff -U0` (header numbers).
test('unified0: matches git diff -U0 for add, delete, modify, two runs in a hunk, and no-newline', () => {
  const cpm = require('node:child_process');
  const { unified0, apiGit } = require('./weekly-report');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-u0-'));
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', HOME: dir, USERPROFILE: dir };
  const git = (...a) => cpm.execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@e.invalid', ...a], { cwd: dir, encoding: 'utf8', env });
  const lines = (n) => Array.from({ length: n }, (_, i) => `l${i + 1}`);
  const cases = {
    add: [lines(10), (l) => { l.splice(4, 0, 'new'); return l; }],
    del: [lines(10), (l) => { l.splice(4, 2); return l; }],
    modify: [lines(10), (l) => { l.splice(4, 3, 'x', 'y'); return l; }],
    two: [lines(12), (l) => { l[3] = 'A'; l.splice(7, 1); return l; }],
    nonl: [lines(6), (l) => l.slice(0, 5).concat('last')],
  };
  git('init', '-q', '-b', 'main');
  for (const [name, [before, edit]] of Object.entries(cases)) {
    const f = `${name}.txt`, nl = name === 'nonl' ? '' : '\n';
    fs.writeFileSync(path.join(dir, f), before.join('\n') + nl); git('add', '-A'); git('commit', '-q', '-m', `a ${name}`);
    fs.writeFileSync(path.join(dir, f), edit([...before]).join('\n') + (name === 'nonl' ? '' : '\n')); git('add', '-A'); git('commit', '-q', '-m', `b ${name}`);
    const hdr = (d) => d.split('\n').filter((l) => l.startsWith('@@')).map((l) => /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(l)).map((m) => [+m[1], m[2] === undefined ? 1 : +m[2], m[4] === undefined ? 1 : +m[4]]);
    const real = hdr(git('diff', '-U0', 'HEAD~1', 'HEAD', '--', f));
    const d3 = git('diff', '-U3', 'HEAD~1', 'HEAD', '--', f), patch = d3.slice(d3.indexOf('@@'));
    assert.deepEqual(hdr(unified0(patch)), real, name);
  }
  // a throwing git (unusable compare / commit unavailable) must end as unknown (null) in post.anchorTouched/testsChanged, never false
  const post = require('../src/post');
  const sha = 'a'.repeat(40);
  assert.throws(() => apiGit(null, sha, () => [])('merge-base'));
  assert.equal(post.anchorTouched(sha, sha, 'f.js', 1, 1, null, apiGit(null, sha, () => [])), null);
  assert.equal(post.testsChanged(sha, sha, null, apiGit({ status: 'diverged', commits: [] }, sha, () => [])), null);
  const cmp = { status: 'ahead', total_commits: 1, commits: [{ sha, parents: [{ sha: 'b'.repeat(40) }] }] };
  assert.equal(post.anchorTouched('b'.repeat(40), sha, 'f.js', 1, 1, null, apiGit(cmp, sha, () => null)), null);
  assert.equal(post.testsChanged('b'.repeat(40), sha, null, apiGit(cmp, sha, () => null)), null);
});

test('apiGit: a truncated compare (more commits than returned) is unusable, so unknown', () => {
  const post = require('../src/post'), { apiGit } = require('./weekly-report');
  const sha = 'a'.repeat(40), cmp = { status: 'ahead', total_commits: 300, commits: [{ sha, parents: [{ sha: 'b'.repeat(40) }] }] };
  assert.equal(post.testsChanged('b'.repeat(40), sha, null, apiGit(cmp, sha, () => [{ filename: 'x.test.js' }])), null);
});
