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

test('select: exact fallback rows when s3 short (walk order, 10 rows)', () => {
  const r = V.select([...cand('s1', 3), ...cand('s2', 6), ...cand('s3', 1)]);
  assert.equal(r.rows.length, 10);
  assert.deepEqual(r.rows.filter((x) => x.stratum === 's2').length, 4);
  const r2 = V.select([...cand('s1', 7), ...cand('s2', 2), ...cand('s3', 3)]);
  assert.equal(r2.rows.length, 10); assert.equal(r2.fallback, 2);
  const r3 = V.select([...cand('s1', 1), ...cand('s2', 4), ...cand('s3', 3)]);
  assert.deepEqual(r3.short, { s1: 2 });
});

test('walk: exact funnel counts by reason and early stop', () => {
  const q = { s1: 1, s2: 1, s3: 1 };
  const order = ['size', 'no_unit_code', 's1', 's2', 'not_core', 's1', 's2', 's3', 's1', 's1'].map((k) => ({ k }));
  const w = V.walk(order, (x) => (x.k.length === 2 ? { stratum: x.k } : { drop: x.k }), q);
  assert.deepEqual(w.funnel, { examined: 8, size: 1, no_unit_code: 1, not_core: 1 });
  assert.equal(w.accepted.length, 5);
});

test('sumNumstat skips docs, lockfiles and binary; inTestScope runtime-tests and no exclude dir', () => {
  assert.equal(V.sumNumstat('10\t5\tsrc/a.js\n-\t-\timg.png\n100\t100\tdocs/x.md\n50\t50\tpackage-lock.json\n9\t9\tyarn.lock\n3\t0\tREADME.md\n'), 15);
  const h = V.CLONES.hono.test;
  assert.ok(!V.inTestScope(h, 'src/runtime-tests/x.test.ts')); assert.ok(!V.inTestScope(h, 'src/a/runtime-tests/x.test.ts'));
  assert.ok(V.inTestScope(V.CLONES.langchain.test, 'libs/core/tests/unit_tests/test_x.py'));
  assert.ok(V.inTestScope({ dir: 'src/', file_re: /\.test\.js$/ }, 'src/a.test.js'));
});

test('poolOf keeps only single-parent (#N) subjects', () => {
  const p = V.poolOf([{ parents: ['a'], subject: 'x (#12)' }, { parents: ['a', 'b'], subject: 'merge (#13)' }, { parents: ['a'], subject: 'no pr' }, { parents: ['a'], subject: 'x (#14) tail' }, { parents: ['a'], subject: 'y (#15)' }]);
  assert.deepEqual(p.map((x) => x.pr), [12, 15]);
});

test('exclusionsFrom: nested 40-hex strings, fix.number keys, per-file counts', () => {
  const h = (ch) => ch.repeat(40);
  const ex = V.exclusionsFrom({
    pairs: JSON.stringify({ pairs: [{ repo: 'o/r', introducing: { merge_commit: h('a'), number: 5 }, fix: { number: 9, sha: h('b') } }] }),
    clean: JSON.stringify([]),
    'coverage-e1-design': JSON.stringify([{ replay_id: 'x-7', buggy_sha: h('c'), repo: 'o/r', n: { deep: [h('d'), 'a'.repeat(39), 'e'.repeat(41)] } }]),
  });
  assert.deepEqual([...ex.shas].sort(), [h('a'), h('b'), h('c'), h('d')]);
  assert.deepEqual([...ex.keys].sort(), ['o/r#5', 'o/r#7', 'o/r#9']);
  assert.deepEqual(ex.files, { pairs: { shas: 2, keys: 2 }, clean: { shas: 0, keys: 0 }, 'coverage-e1-design': { shas: 2, keys: 1 } });
});

test('git fixture: sampleRepo strata/exclusion/docs/window, sample merge_match, later window', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v2s-')), dir = path.join(root, 'fx');
  try {
    fs.mkdirSync(dir);
    const g = (date, ...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } });
    g('2025-01-01T00:00:00+0000', 'init', '-q');
    const put = (f, n) => { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), Array.from({ length: n }, (_, i) => 'l' + i).join('\n') + '\n'); };
    const commit = (date, msg, f, n) => { if (f) put(f, n); g(date, 'add', '-A'); g(date, 'commit', '-q', '-m', msg); return g(date, 'rev-parse', 'HEAD').trim(); };
    const sha = {};
    commit('2025-01-01T00:00:00+0000', 'old (#1)', 'src/old.js', 700);
    commit('2025-08-05T00:00:00+0000', 'early test', 'src/early.test.js', 3);
    sha[10] = commit('2025-08-10T00:00:00+0000', 'small (#10)', 'src/x.js', 40);
    commit('2025-08-10T00:00:00+0000', 'same instant', 'src/same.test.js', 3);
    sha[11] = commit('2025-08-11T00:00:00+0000', 'medium (#11)', 'src/y.js', 200);
    commit('2025-08-12T00:00:00+0000', 'add test', 'src/x.test.js', 3);
    sha[12] = commit('2025-08-13T00:00:00+0000', 'large (#12)', 'src/z.js', 600);
    commit('2025-08-15T00:00:00+0000', 'edit test', 'src/x.test.js', 4);
    sha[13] = commit('2025-08-16T00:00:00+0000', 'excluded (#13)', 'src/w.js', 40);
    sha[14] = commit('2025-08-17T00:00:00+0000', 'docs only (#14)', 'docs/big.md', 2000);
    commit('2025-08-18T00:00:00+0000', 'add q test', 'src/q.test.js', 3);
    fs.rmSync(path.join(dir, 'src/q.test.js')); commit('2025-08-19T00:00:00+0000', 'delete q test');
    sha[15] = commit('2025-08-20T00:00:00+0000', 'no unit code (#15)', 'lib/other.js', 50);
    commit('2025-08-21T00:00:00+0000', 'outside scope test', 'lib/z.test.js', 3);
    commit('2025-09-09T00:00:00+0000', 'edge of window', 'src/edge.test.js', 3);
    commit('2025-10-01T00:00:00+0000', 'too late', 'src/late.test.js', 3);
    commit('2025-12-31T00:00:00+0000', 'tail', 'tail.txt', 1);

    const tbl = { gh: 'o/fx', src: 'src/', test: { dir: 'src/', file_re: /\.test\.js$/ } }, clones = { fx: tbl };
    const ex = { shas: new Set([sha[13]]), keys: new Set(), files: { pairs: { shas: 1, keys: 0 } } }, q = { s1: 1, s2: 1, s3: 1 };
    const r = V.sampleRepo({ dir, clone: 'fx', tbl, ex, since: '2025-07-01', followDays: 30, seed: 1, q });
    assert.deepEqual(r.picked.map((x) => x.pr + x.stratum + x.drawn_from).sort(), ['10s1s1', '11s2s2', '12s3s3']);
    assert.ok(!r.picked.some((x) => x.sha === sha[13]));
    assert.equal(r.funnel.pool, 6); assert.equal(r.funnel.excluded, 1); assert.equal(r.funnel.size, 1); assert.equal(r.funnel.no_unit_code, 1);
    assert.deepEqual(r.short, {});

    const text = (gh, pr) => (pr === 10 ? { title: 'T', body: 'B', merge_commit_sha: sha[10] } : pr === 11 ? { title: 'T', body: 'B', merge_commit_sha: 'f'.repeat(40) } : { failed: true });
    const cache = { 'o/fx#10': { title: 'old' } }; // old entry without merge_commit_sha is refetched
    const out = V.sample({ repos: root, since: '2025-07-01', followDays: 30, seed: 1, ex, cache, clones, text, q });
    assert.deepEqual(out.rows.map((x) => [x.pr, x.merge_match, x.body, x.pr_text]), [[10, true, 'B', 'github'], [11, false, 'B', 'github'], [12, null, '', 'commit']]);
    assert.equal(out.merge_mismatch, 1); assert.equal(out.pr_text_fallback, 1);
    assert.deepEqual(out.exclusions, { files: ex.files, shas: 1, keys: 0 });

    const l = V.later({ repos: root, corpus: { rows: [{ id: 'fx-10', clone: 'fx', sha: sha[10], date: '2025-08-10T00:00:00.000Z' }] }, followDays: 30, clones });
    assert.deepEqual(l.rows[0].commits.map((x) => x.date.slice(0, 10) + ':' + x.test_files.map((f) => f.status + f.path).join(',')),
      ['2025-09-09:Asrc/edge.test.js', '2025-08-18:Asrc/q.test.js', '2025-08-15:Msrc/x.test.js', '2025-08-12:Asrc/x.test.js']);
    assert.equal(l.rows[0].follow_end, '2025-09-09T00:00:00.000Z');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
