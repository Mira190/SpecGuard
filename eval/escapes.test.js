const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { escapes, syncShadow, readCache, renderEscapes, SHADOW, FLOOR, TOL } = require('./escapes');
const { escapesOf, render, analyze } = require('./weekly-report');
const szz = require('./szz');

const fix = (sha, pr, ...intro) => ({ fix: { sha, pr }, status: 'located', introducing: intro.map(([p, spots, extra]) => ({ pr: p, spots, ...extra })) });
const S = (p, line) => ({ path: p, line });
const sg = (pr, p, line) => ({ pr, path: p, line });
const ok = (...f) => [{ status: 'ok', findings: f.map(([p, l]) => ({ path: p, line: l })) }];
const prs = [[3, 0], [6, 0], [9, 0], [12, 0], [4, 1], [7, 1], [10, 1], [5, 2], [8, 2], [11, null]].map(([number, arm]) => ({ number, arm }));
const fixes = { candidates: [
  fix('f1', 100, [3, [S('a.js', 10)]]), // arm 0, finding on a.js:12 -> hit
  fix('f2', 101, [6, [S('b.js', 5)]]), // arm 0, finding far away -> miss
  fix('f3', 102, [9, [S('c.js', 1)]]), // arm 0, run failed -> unusable
  fix('f4', 103, [4, [S('d.js', 7)]]), // arm 1, shadow finding on d.js:8 -> hit
  fix('f5', 104, [7, [S('e.js', 7)]]), // arm 1, no shadow entry -> unusable
  fix('f6', 105, [10, [S('f.js', 7)]]), // arm 1, shadow run failed -> unusable
  fix('f7', 106, [5, [S('g.js', 2)]], [8, [S('g.js', 2)]]), // blamed on two PRs of arm 2: one defect for each
  fix('f8', 107, [12, []]), // arm 0, no location (revert)
  fix('f9', 5, [5, [S('g.js', 2)]]), // fixed inside the same PR: not escaped
  fix('fa', 108, [11, [S('h.js', 3)]]), // no arm label
  fix('fb', 109, [3, [S('a.js', 10)]], [999, [S('z.js', 1)]]), // second PR is outside the trial
  fix('fc', 110, [6, [S('b.js', 5)], { confirmed: false }]), // rejected by hand
  { fix: { sha: 'fd', pr: 111 }, status: 'no_introducing', introducing: [] },
] };
const status = new Map([[3, 'complete'], [6, 'incomplete'], [9, 'failed'], [12, 'complete'], [5, 'complete'], [8, 'complete'], [11, 'complete']]);
const findings = [sg(3, 'a.js', 12), sg(6, 'b.js', 40), sg(5, 'g.js', 4), sg(8, 'other.js', 2), sg(11, 'h.js', 3)];
const shadow = new Map([[4, ok(['d.js', 8])], [10, [{ status: 'failed', findings: [] }]]]);

test('escapes: per arm counts, would-have-caught, unusable and no-location are separate, never a miss', () => {
  const g = escapes({ prs, fixes, findings, status, shadow }).groups;
  assert.deepEqual([g[0].prs, g[0].escaped, g[0].prs_with_escape], [4, 5, 4]);
  assert.deepEqual([g[0].hit, g[0].seen, g[0].unusable, g[0].no_location], [2, 3, 1, 1]); // f1 + fb hit, f2 miss (fc rejected)
  assert.deepEqual(g[0].hit_prs, [3]);
  assert.equal(g[1].via, 'shadow');
  assert.deepEqual([g[1].escaped, g[1].hit, g[1].seen, g[1].unusable], [3, 1, 1, 2]);
  assert.deepEqual([g[2].escaped, g[2].hit, g[2].seen], [2, 1, 2]); // f7 on PR 5 (finding near) and PR 8 (not); f9 skipped
  assert.deepEqual([g.unlabeled.escaped, g.unlabeled.hit], [1, 1]);
});

test('escapes: arm 1 reads the last run of the PR; a failed last run is unusable even if an earlier push was fine', () => {
  const f = { candidates: [fix('x', 9, [4, [S('d.js', 7)]])] }, p = [{ number: 4, arm: 1 }];
  const run = (r, status) => ({ status, run: r, findings: status === 'ok' ? [{ path: 'd.js', line: 7 }] : [] });
  assert.equal(escapes({ prs: p, fixes: f, shadow: new Map([[4, [run(1, 'ok'), run(2, 'ok')]]]) }).groups[1].hit, 1);
  assert.equal(escapes({ prs: p, fixes: f, shadow: new Map([[4, [run(1, 'ok'), run(2, 'failed')]]]) }).groups[1].unusable, 1);
});

test('escapes: rate and interval are withheld below the PR floor, given at it', () => {
  const g = escapes({ prs, fixes, findings, status, shadow }).groups;
  assert.equal(g[0].per_100, null);
  assert.equal(g[0].rate, null); // 3 located < 10
  const many = Array.from({ length: FLOOR.prs }, (_, i) => ({ number: 1000 + i, arm: 0 }));
  const cands = many.slice(0, 6).map((p, i) => fix(`m${i}`, 50 + i, [p.number, [S('m.js', 1)]]));
  const st = new Map(many.map((p) => [p.number, 'complete']));
  const h = escapes({ prs: many, fixes: { candidates: cands }, findings: many.slice(0, 3).map((p) => sg(p.number, 'm.js', 2)), status: st }).groups[0];
  assert.equal(h.per_100, 20);
  assert.equal(h.cluster_95.length, 2);
  assert.ok(h.cluster_95[0] <= 20 && h.cluster_95[1] >= 20);
  assert.equal(h.rate, null); // 6 located < 10
});

test('weekly-report: escapesOf reads sticky status (failed is unusable) and renders the section; no --fixes means no section', () => {
  const sticky = (n, st, counts = '') => ({ issue_url: `https://api.github.com/repos/o/r/issues/${n}`, body: `<!-- specguard:summary -->\n${counts}<!-- specguard:status=${st} -->\n## SpecGuard` });
  const ds = { repo: 'o/r', since: '2026-09-01', until: '2026-09-30', baseline: [], threads: [], review_comments: [{ id: 1, pr: 3, path: 'a.js', line: 12, body: 'x <!-- specguard:fp=' + 'a'.repeat(40) + ' -->', user: { login: 'github-actions[bot]', type: 'Bot' } }],
    prs: [3, 6].map((number) => ({ number, created_at: '2026-09-01T00:00:00Z', merged_at: null, user: { login: 'dev', type: 'User' }, labels: [{ name: 'review-arm:0' }] })), issue_comments: [sticky(3, 'complete'), sticky(6, 'failed')] };
  const f = { candidates: [fix('f1', 100, [3, [S('a.js', 10)]]), fix('f2', 101, [6, [S('b.js', 5)]])] };
  const x = escapesOf(ds, f, new Map());
  assert.deepEqual([x.groups[0].hit, x.groups[0].seen, x.groups[0].unusable], [1, 1, 1]);
  const r = analyze(ds); r.escapes = x;
  assert.match(render(r), /## Escaped defects[\s\S]*insufficient data \(need 30 PRs\)/);
  assert.doesNotMatch(render(analyze(ds)), /Escaped defects \(SZZ/);
});

test('syncShadow: reads counts.json from the artifact, caches failed runs, skips cached and expired ones, appends across runs', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'esc-')), file = path.join(dir, 'shadow.jsonl');
  const runs = [{ id: 1, name: SHADOW.workflow, head_sha: 'h4', pr: 4 }, { id: 2, name: SHADOW.workflow, head_sha: 'h7', pr: 7 }, { id: 3, name: SHADOW.workflow, head_sha: 'h10', pr: 10 }, { id: 4, name: 'other', head_sha: 'x', pr: 4 }, { id: 5, name: SHADOW.workflow, head_sha: 'h99', pr: 99 }];
  const gh = (a) => (a[1] === '--paginate' ? runs.map((r) => JSON.stringify(r)).join('\n') : JSON.stringify(a[1].includes('/runs/3/') ? [] : a[1].includes('/runs/1/') ? ['specguard-ctx-4-1', 'specguard-ctx-4-2', 'specguard-ctx-44-9', 'other'] : ['specguard-ctx-7-1']));
  const got = [];
  const download = (repo, run, d, name) => { got.push(name); if (run === 1) fs.writeFileSync(path.join(d, SHADOW.file), JSON.stringify({ sum: [{ fp: 'a'.repeat(16), path: 'd.js', line: 8, kind: 'missing_test', title: 'secret claim' }, { path: 'n.js', line: null }] })); };
  const s = syncShadow({ repo: 'o/r', since: '2026-09-01', prs: [4, 7, 10], file, gh, download });
  assert.deepEqual(s, { added: 2, missing: 1 }); // PR 10 has no live artifact: not cached
  const c = readCache(file);
  assert.deepEqual(c.get(4)[0].findings, [{ path: 'd.js', line: 8, kind: 'missing_test' }, { path: 'n.js', line: null }]);
  assert.deepEqual(got, ['specguard-ctx-4-2', 'specguard-ctx-7-1']); // latest attempt of the PR's own artifact only
  assert.equal(c.get(7)[0].status, 'failed'); // artifact without counts.json
  assert.ok(!fs.readFileSync(file, 'utf8').includes('secret claim')); // titles are not stored
  assert.deepEqual(syncShadow({ repo: 'o/r', since: '2026-09-01', prs: [4, 7, 10], file, gh, download }), { added: 0, missing: 1 });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('szz: blame spots give the path and line in the introducing commit, and mine records them', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'esc-git-'));
  const git = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: d, encoding: 'utf8' }).trim();
  git('init', '-q');
  const commit = (body, msg, day) => { fs.mkdirSync(path.join(d, 'src'), { recursive: true }); fs.writeFileSync(path.join(d, 'src/a.js'), body); git('add', '-A'); execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', msg], { cwd: d, env: { ...process.env, GIT_COMMITTER_DATE: `2026-09-${day}T00:00:00Z`, GIT_AUTHOR_DATE: `2026-09-${day}T00:00:00Z` } }); return git('rev-parse', 'HEAD'); };
  commit('a\nb\nc\nlimit(n) { return n > 3; }\n', 'init', '01');
  const bug = commit('a\nb\nc\nlimit(n) { return n >= 3; }\n', 'Tune (#11)', '02');
  const fx = commit('a\nb\nc\nlimit(n) { return n > 3 && n < 9; }\n', 'fix: limit (#12)', '05');
  const spots = {};
  assert.deepEqual(szz.blame(d, bug, { path: 'src/a.js', lines: [4] }, spots), { [bug]: 1 });
  assert.deepEqual(spots[bug].map(({ path: p, line }) => ({ path: p, line })), [{ path: 'src/a.js', line: 4 }]);
  const m = szz.mine({ repoDir: d, since: '2026-08-01' });
  assert.deepEqual(m.candidates[0].introducing[0].spots, [{ path: 'src/a.js', line: 4 }]);
  assert.equal(m.candidates[0].fix.sha, fx);
  fs.rmSync(d, { recursive: true, force: true });
});

test('shadow artifact name matches the template action.yml uploads', () => {
  const yml = fs.readFileSync(path.join(__dirname, '..', 'action.yml'), 'utf8');
  const t = /name: (specguard-ctx-\$\{\{ github\.event\.pull_request\.number \}\}-\$\{\{ github\.run_attempt \}\})/.exec(yml)?.[1];
  assert.ok(t, 'action.yml no longer uploads specguard-ctx-<PR>-<attempt>: update SHADOW.artifact');
  const name = t.replace('${{ github.event.pull_request.number }}', '42').replace('${{ github.run_attempt }}', '3');
  assert.equal(SHADOW.artifact(42).exec(name)?.[1], '3');
  assert.equal(SHADOW.artifact(4).exec(name), null);
});

test('a finding with no line is "same file only", never a line hit', () => {
  const f = { candidates: [fix('x', 9, [3, [S('a.js', 10)]])] };
  const run = (fnd) => escapes({ prs: [{ number: 3, arm: 0 }], fixes: f, status: new Map([[3, 'complete']]), findings: fnd }).groups[0];
  assert.deepEqual([run([sg(3, 'a.js', null)]).hit, run([sg(3, 'a.js', null)]).same_file], [0, 1]);
  assert.deepEqual([run([sg(3, 'a.js', 40)]).hit, run([sg(3, 'a.js', 40)]).same_file], [0, 1]);
  assert.deepEqual([run([sg(3, 'a.js', 10 + TOL)]).hit, run([sg(3, 'a.js', 10 + TOL)]).same_file], [1, 0]); // exactly the tolerance: a hit
  assert.deepEqual([run([sg(3, 'a.js', 10 - TOL)]).hit, run([sg(3, 'a.js', 10 - TOL)]).same_file], [1, 0]);
  assert.deepEqual([run([sg(3, 'a.js', 10 + TOL + 1)]).hit, run([sg(3, 'a.js', 10 + TOL + 1)]).same_file], [0, 1]); // one more: same file only
  assert.deepEqual([run([sg(3, 'a.js', 10 - TOL - 1)]).hit, run([sg(3, 'a.js', 10 - TOL - 1)]).same_file], [0, 1]);
  assert.deepEqual([run([sg(3, 'b.js', 10)]).hit, run([sg(3, 'b.js', 10)]).same_file], [0, 0]);
});

test('syncShadow: fork PRs are matched by head sha; a failed newest attempt falls back to the latest good one; none good is failed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'esc-fork-')), file = path.join(dir, 's.jsonl');
  const runs = [{ id: 9, name: SHADOW.workflow, head_sha: 'hF', pr: null }, { id: 8, name: SHADOW.workflow, head_sha: 'hG', pr: 12 }];
  const gh = (a) => (a[1] === '--paginate' ? runs.map((r) => JSON.stringify(r)).join('\n')
    : a[1].includes('/commits/hF/pulls') ? '[7,99]' : a[1].includes('/runs/9/') ? JSON.stringify(['specguard-ctx-7-1', 'specguard-ctx-7-2']) : JSON.stringify(['specguard-ctx-12-1']));
  const download = (repo, run, d, name) => { if (name === 'specguard-ctx-7-1') fs.writeFileSync(path.join(d, SHADOW.file), JSON.stringify({ sum: Array.from({ length: 25 }, (_, i) => ({ path: 'f.js', line: i })) })); };
  assert.deepEqual(syncShadow({ repo: 'o/r', since: '2026-09-01', prs: [7, 12], file, gh, download }), { added: 2, missing: 0 });
  const c = readCache(file);
  assert.deepEqual([c.get(7)[0].status, c.get(7)[0].attempt, c.get(7)[0].findings.length, c.get(7)[0].capped], ['ok', 1, 25, true]); // attempt 2 had no counts.json
  assert.equal(c.get(12)[0].status, 'failed');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('renderEscapes: the cross-arm outcome and the not-comparable table are labelled separately, and unusable runs are shown as unusable', () => {
  const x = escapes({ prs, fixes, findings, status, shadow });
  const out = renderEscapes(x).join('\n');
  const [cross, other] = out.split('**Not comparable between rows');
  assert.match(cross, /Outcome, comparable across arms: escaped defects per 100 PRs/);
  assert.match(cross, /insufficient data \(need 30 PRs\)/); // under the floor: no rate
  assert.doesNotMatch(cross, /unusable review/);
  assert.match(other, /flagged but still escaped \(delivered\)/);
  assert.match(other, /would have caught \(shadow\)/);
  assert.match(other, /\| unusable review \|/);
  assert.match(other, /\| 1 Copilot only \| would have caught \(shadow\) \| 1\/1 = ?|\| 1 Copilot only \| would have caught \(shadow\) \| 1\/1 \(insufficient/); // PR 4 hit; PRs 7 and 10 are unusable, not misses
  assert.match(other, /\| 1 Copilot only \|[^\n]*\| 0 \| 2 \| 0 \| 0 \|\n/); // arm 1 row: same file 0, unusable 2, no location 0, capped 0
  assert.match(other, /Unusable = the review failed or is missing \(never a miss/);
});

test('escapesOf: a sticky summary with counts but no status marker (older format) is usable; with neither it is unusable', () => {
  const sticky = (n, body) => ({ issue_url: `https://api.github.com/repos/o/r/issues/${n}`, body: `<!-- specguard:summary -->\n${body}## SpecGuard` });
  const ds = { repo: 'o/r', since: '2026-09-01', until: '2026-09-30', baseline: [], threads: [], review_comments: [],
    prs: [3, 6].map((number) => ({ number, created_at: '2026-09-01T00:00:00Z', merged_at: null, user: { login: 'dev', type: 'User' }, labels: [{ name: 'review-arm:0' }] })),
    issue_comments: [sticky(3, `<!-- specguard:counts ${JSON.stringify({ pr: 3, complete: true })} -->\n`), sticky(6, '')] };
  const f = { candidates: [fix('f1', 100, [3, [S('a.js', 10)]]), fix('f2', 101, [6, [S('b.js', 5)]])] };
  const g = escapesOf(ds, f, new Map()).groups[0];
  assert.deepEqual([g.seen, g.unusable], [1, 1]); // PR 3 usable (no finding: a miss), PR 6 unusable
});

test('escapes: shadow runs with a full 20-finding list are counted as capped, and only those', () => {
  const f = { candidates: [fix('x', 9, [4, [S('d.js', 7)]]), fix('y', 10, [7, [S('e.js', 7)]])] }, p = [{ number: 4, arm: 1 }, { number: 7, arm: 1 }];
  const run = (capped) => ({ status: 'ok', run: 1, capped, findings: [{ path: 'd.js', line: 7 }] });
  const x = escapes({ prs: p, fixes: f, shadow: new Map([[4, [run(true)]], [7, [run(false)]]]) });
  assert.equal(x.groups[1].capped_prs, 1);
  assert.match(renderEscapes(x).join('\n'), /\| 1 \|\n\nA line hit/); // the last column of the arm row
});

// Chance baseline: 40 PRs, each with one escaped defect blamed on a line inside a 40-line changed hunk (lines 100-139) of a 5000-line file.
const chanceFx = () => {
  const ps = Array.from({ length: 40 }, (_, i) => ({ number: 2000 + i, arm: 0 }));
  const cands = ps.map((p, i) => fix(`z${i}`, 700 + i, [p.number, [S('f.js', 100 + ((i * 7) % 40))]]));
  const added = Array.from({ length: 40 }, (_, i) => 100 + i);
  return { ps, fixes: { candidates: cands }, status: new Map(ps.map((p) => [p.number, 'complete'])), addedOf: () => added, lengthOf: () => 5000 };
};
const group = (c, lineOf, extra = {}) => escapes({ prs: c.ps, fixes: c.fixes, status: c.status, addedOf: c.addedOf, lengthOf: c.lengthOf, findings: c.ps.map((p, i) => sg(p.number, 'f.js', lineOf(i))), ...extra }).groups[0];

test('chance: findings on the blamed lines are clearly above the primary null', () => {
  const g = group(chanceFx(), (i) => 100 + ((i * 7) % 40));
  assert.equal(g.rate, 1);
  assert.ok(g.chance.ci[1] < 0.5 && g.chance.rate > 0.05, JSON.stringify(g.chance)); // about 7 of 40 lines are within 3 of a blamed line
  assert.equal(g.chance.above_chance, true);
  assert.ok(g.chance.excess > 0.5);
  assert.equal(g.chance.diff, 40);
  assert.match(renderEscapes({ fixes: 1, groups: { 0: g } }).join('\n'), /above chance/);
});

test('chance: findings spread over the changed lines are not above the primary null, though the weak null (whole file) calls them above chance', () => {
  const g = group(chanceFx(), (i) => 100 + ((i * 13 + 5) % 40));
  assert.ok(g.rate < 0.5 && g.rate > 0, `observed ${g.rate}`);
  assert.equal(g.chance.above_chance, false);
  assert.equal(g.chance.weak_above_chance, true); // 5000 lines: random lines almost never land near a blamed one
  assert.ok(g.chance.weak.ci[1] < g.rate);
  const out = renderEscapes({ fixes: 1, groups: { 0: g } }).join('\n');
  assert.match(out, /not above chance/);
  assert.match(out, /weak null/);
});

test('chance: fixed seed reproduces, another seed differs; without a diff the line is permuted among other PRs findings, and a lone file is left out', () => {
  const c = chanceFx(), at = (i) => 100 + ((i * 13 + 5) % 40);
  assert.deepEqual(group(c, at).chance, group(c, at).chance);
  assert.notEqual(group(c, at, { seed: 2 }).chance.rate, group(c, at).chance.rate);
  const noDiff = group({ ...c, addedOf: undefined }, at).chance;
  assert.deepEqual([noDiff.diff, noDiff.permuted, noDiff.dropped], [0, 40, 0]);
  const lone = escapes({ prs: [c.ps[0]], fixes: { candidates: [c.fixes.candidates[0]] }, status: c.status, findings: [sg(c.ps[0].number, 'f.js', 100)] }).groups[0];
  assert.equal(lone.chance.dropped, 1); // no diff, no other PR with a finding in that file
});

test('gitSeams: added lines of a commit (new side) and the file length at it', () => {
  const { gitSeams } = require('./escapes');
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'esc-seam-'));
  const git = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: d, encoding: 'utf8' }).trim();
  git('init', '-q');
  fs.writeFileSync(path.join(d, 'a.js'), 'l1\nl2\nl3\nl4\nl5\n');
  git('add', '-A'); git('commit', '-q', '-m', 'one');
  fs.writeFileSync(path.join(d, 'a.js'), 'l1\nl2\nL3\nl4\nl5\nl6\n');
  git('add', '-A'); git('commit', '-q', '-m', 'two');
  const sha = git('rev-parse', 'HEAD'), s = gitSeams(d);
  assert.deepEqual(s.addedOf({ path: 'a.js', sha }), [3, 6]);
  assert.equal(s.lengthOf({ path: 'a.js', sha }), 6);
  assert.deepEqual(s.addedOf({ path: 'nope.js', sha }), []);
  assert.equal(s.lengthOf({ path: 'a.js', sha: undefined }), 0);
  fs.rmSync(d, { recursive: true, force: true });
});
