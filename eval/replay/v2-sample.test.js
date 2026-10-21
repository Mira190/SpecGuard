const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { listCommits } = require('../szz');
const V = require('./v2-sample');

const cand = (s, n) => Array.from({ length: n }, (_, i) => ({ id: `${s}${i}`, stratum: s }));
const ids = (rows) => rows.map((r) => r.id);

test('stratum boundaries', () => {
  const got = [29, 30, 149, 150, 499, 500, 1200, 1201].map(V.stratumOf);
  assert.deepEqual(got, [null, 's1', 's1', 's2', 's2', 's3', 's3', null]);
});

test('select: own quotas, no fallback', () => {
  const r = V.select([...cand('s3', 4), ...cand('s1', 4), ...cand('s2', 5)]);
  assert.equal(r.rows.length, 10); assert.equal(r.fallback, 0); assert.deepEqual(r.short, {});
  assert.ok(r.rows.every((x) => x.drawn_from === x.stratum));
  assert.deepEqual(ids(r.rows.filter((x) => x.stratum === 's3')), ['s30', 's31', 's32']);
});

test('select: s3 short is filled from extra s2 (s3 labelled, drawn_from s2)', () => {
  const r = V.select([...cand('s1', 3), ...cand('s2', 7), ...cand('s3', 1)]);
  const s3 = r.rows.filter((x) => x.stratum === 's3');
  assert.deepEqual(ids(s3), ['s30', 's24', 's25']);
  assert.deepEqual(s3.map((x) => x.drawn_from), ['s3', 's2', 's2']);
  assert.equal(r.fallback, 2); assert.deepEqual(r.short, {});
});

test('select: s2 short is filled from extra s1; s3 short then uses nothing left in s2', () => {
  const r = V.select([...cand('s1', 6), ...cand('s2', 2), ...cand('s3', 3)]);
  const s2 = r.rows.filter((x) => x.stratum === 's2');
  assert.deepEqual(ids(s2), ['s20', 's21', 's13', 's14']);
  assert.deepEqual(s2.map((x) => x.drawn_from), ['s2', 's2', 's1', 's1']);
  assert.deepEqual(r.short, {}); assert.equal(r.fallback, 2);
});

test('select: still short is reported, not thrown; s1 has no fallback', () => {
  const r = V.select([...cand('s1', 2), ...cand('s2', 1), ...cand('s3', 0)]);
  assert.deepEqual(r.short, { s1: 1, s2: 3, s3: 3 });
  assert.equal(r.rows.length, 3);
  // s2 short filled from s1 extras only when they exist beyond s1's own quota
  const r2 = V.select([...cand('s1', 5), ...cand('s2', 3)]);
  assert.deepEqual(r2.short, { s3: 3 }); assert.equal(r2.rows.filter((x) => x.drawn_from === 's1').length, 3 + 1);
});

test('walk: classify drops are counted, early stop happens', () => {
  const order = Array.from({ length: 100 }, (_, i) => ({ i }));
  const classify = (c) => (c.i % 5 === 0 ? { drop: 'size' } : { stratum: ['s1', 's2', 's3'][c.i % 3] });
  const w = V.walk(order, classify);
  assert.ok(w.funnel.examined < 100); assert.ok(w.funnel.size > 0);
  assert.equal(w.funnel.examined, w.funnel.size + w.accepted.length);
});

test('exclusion by sha or repo#pr', () => {
  const ex = { shas: new Set(), keys: new Set() };
  V.addEx(ex, 'aaa', 'o/r', 7); V.addEx(ex, null, 'o/r', null);
  assert.ok(V.isExcluded(ex, 'aaa', 'o/r#99'));
  assert.ok(V.isExcluded(ex, 'bbb', 'o/r#7'));
  assert.ok(!V.isExcluded(ex, 'bbb', 'o/r#8'));
  assert.equal(ex.keys.size, 1);
});

test('shuffle is deterministic per seed and a permutation', () => {
  const a = Array.from({ length: 30 }, (_, i) => i);
  assert.deepEqual(V.shuffle(a, 5), V.shuffle(a, 5));
  assert.notDeepEqual(V.shuffle(a, 5), V.shuffle(a, 6));
  assert.deepEqual(V.shuffle(a, 5).sort((x, y) => x - y), a);
});

test('numstat sum treats binary as 0; test scope rules', () => {
  assert.equal(V.sumNumstat('3\t4\tf\n-\t-\timg.png\n10\t0\tg\n'), 17);
  const h = V.CLONES.hono.test, s = V.CLONES.sqlglot.test;
  assert.ok(V.inTestScope(h, 'src/a.test.ts'));
  assert.ok(!V.inTestScope(h, 'runtime-tests/a.test.ts')); assert.ok(!V.inTestScope(h, 'src/a.ts'));
  assert.ok(V.inTestScope(s, 'tests/dialects/test_x.py')); assert.ok(V.inTestScope(s, 'tests/x_test.py')); assert.ok(!V.inTestScope(s, 'tests/helpers.py'));
});

test('git fixture: pool filter and later data', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-sample-'));
  try {
    const g = (env, ...a) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_DATE: env, GIT_COMMITTER_DATE: env } }).trim();
    const put = (f, txt) => { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), txt); g('2026-01-01T00:00:00+00:00', 'add', f); };
    const commit = (d, msg) => { g(d, 'commit', '-m', msg); return g(d, 'rev-parse', 'HEAD'); };
    g('2026-01-01T00:00:00+00:00', 'init', '-b', 'main');
    put('README.md', 'r'); commit('2026-01-01T00:00:00+00:00', 'init');
    put('sqlglot/a.py', 'x = 1\n'); const c1 = commit('2026-01-10T00:00:00+00:00', 'x (#1)');
    put('tests/test_a.py', 'def test_a(): pass\n'); const c2 = commit('2026-01-20T00:00:00+00:00', 'y (#2)');
    put('tests/test_a.py', 'def test_a(): pass\ndef test_b(): pass\n'); put('tests/helpers.py', 'h'); const c3 = commit('2026-02-01T00:00:00+00:00', 'no pr number here');
    put('docs.md', 'd'); const c4 = commit('2026-02-05T00:00:00+00:00', 'z (#4)');
    const tree = g('2026-02-10T00:00:00+00:00', 'rev-parse', 'HEAD^{tree}');
    const side = g('2026-02-06T00:00:00+00:00', 'commit-tree', tree, '-p', c1, '-m', 'side');
    const merge = g('2026-02-10T00:00:00+00:00', 'commit-tree', tree, '-p', c4, '-p', side, '-m', 'Merge pull request #3 from o/b');
    g('2026-02-10T00:00:00+00:00', 'update-ref', 'refs/heads/main', merge);

    const pool = V.poolOf(listCommits(dir, '2025-01-01'));
    assert.deepEqual(pool.map((c) => c.pr).sort(), [1, 2, 4]);

    const tbl = { fx: { gh: 'o/fx', src: 'sqlglot/', test: V.CLONES.sqlglot.test } };
    const corpus = { rows: [{ id: 'fx-1', clone: 'fx', sha: c1, date: '2026-01-10T00:00:00+00:00' }, { id: 'fx-2', clone: 'fx', sha: c2, date: '2026-01-20T00:00:00+00:00' }] };
    const out = V.later({ repos: path.dirname(dir), corpus: { rows: corpus.rows.map((r) => ({ ...r, clone: path.basename(dir) })) }, followDays: 90, clones: { [path.basename(dir)]: tbl.fx } });
    const [r1, r2] = out.rows;
    assert.equal(r1.follow_days_available, 31); assert.equal(r2.follow_days_available, 21);
    assert.deepEqual(r1.commits.map((c) => c.sha), [c3, c2]); // git log order: newest first
    assert.deepEqual(r1.commits.find((c) => c.sha === c2).test_files, [{ path: 'tests/test_a.py', status: 'A' }]);
    assert.deepEqual(r1.commits.find((c) => c.sha === c3).test_files, [{ path: 'tests/test_a.py', status: 'M' }]);
    assert.deepEqual(r2.commits.map((c) => c.sha), [c3]); // strictly after the merge date, c2 itself excluded
    assert.equal(r1.follow_end, '2026-04-10T00:00:00.000Z');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
