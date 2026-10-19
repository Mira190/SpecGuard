const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { escapes, syncShadow, readCache, SHADOW, FLOOR } = require('./escapes');
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
  const gh = (a) => (a[1] === '--paginate' ? runs.map((r) => JSON.stringify(r)).join('\n') : JSON.stringify(a[1].includes('/runs/3/') ? [] : [{ name: SHADOW.artifact }]));
  const download = (repo, run, d) => { if (run === 1) fs.writeFileSync(path.join(d, SHADOW.file), JSON.stringify({ sum: [{ fp: 'a'.repeat(16), path: 'd.js', line: 8, kind: 'missing_test', title: 'secret claim' }, { path: 'n.js', line: null }] })); };
  const s = syncShadow({ repo: 'o/r', since: '2026-09-01', prs: [4, 7, 10], file, gh, download });
  assert.deepEqual(s, { added: 2, missing: 1 }); // PR 10 has no live artifact: not cached
  const c = readCache(file);
  assert.deepEqual(c.get(4)[0].findings, [{ path: 'd.js', line: 8, kind: 'missing_test' }, { path: 'n.js', line: null }]);
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
