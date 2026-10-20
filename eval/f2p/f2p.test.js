const test = require('node:test');
const assert = require('node:assert');
const { verdict, throwOrigin, signatureChanged } = require('./verdict');
const f2p = require('./f2p');
const { fisher2, wilson, mdd } = require('./stats');

const r = (outcome, extra = {}) => ({ outcome, ...extra });
const x3 = (o, e) => [r(o, e), r(o, e), r(o, e)];
const prod = { origin: 'production', frame: 'src/a.ts:10' };

test('assertion verdicts from synthetic outcomes', () => {
  assert.strictEqual(verdict(x3('assert_fail'), x3('pass')).verdict, 'verified');
  assert.strictEqual(verdict(x3('pass'), x3('pass')).verdict, 'not_discriminating');
  assert.strictEqual(verdict(x3('assert_fail'), x3('assert_fail')).verdict, 'not_discriminating');
  assert.strictEqual(verdict(x3('pass'), x3('assert_fail')).verdict, 'reversed');
  assert.strictEqual(verdict(x3('error', { msg: 'import' }), x3('pass')).verdict, 'invalid');
  assert.strictEqual(verdict([r('assert_fail'), r('pass'), r('assert_fail')], x3('pass')).verdict, 'flaky');
  assert.strictEqual(verdict(x3('assert_fail'), [r('pass'), r('pass'), r('assert_fail')]).verdict, 'flaky');
});

test('verified_throw needs a production-code origin on all buggy runs and clean passes on fixed', () => {
  const v = verdict(x3('throw', prod), x3('pass'));
  assert.deepStrictEqual([v.verdict, v.frame], ['verified_throw', 'src/a.ts:10']);
  assert.strictEqual(verdict(x3('throw', { origin: 'test', frame: 'src/a.test.ts:3' }), x3('pass')).verdict, 'invalid');
  assert.strictEqual(verdict(x3('throw', { origin: 'bad_call' }), x3('pass')).verdict, 'invalid');
  assert.strictEqual(verdict(x3('throw', prod), x3('throw', prod)).verdict, 'invalid');
  assert.strictEqual(verdict([r('throw', prod), r('pass'), r('throw', prod)], x3('pass')).verdict, 'flaky');
  assert.strictEqual(verdict(x3('throw', prod), x3('pass'), { apiShift: true }).verdict, 'api_shift');
});

test('throwOrigin: framework frames are skipped, test frames and bad calls are not code under test', () => {
  assert.strictEqual(throwOrigin(['node_modules/x/y.js:1', 'src/a.ts:9', 'src/a.test.ts:4']).origin, 'production');
  assert.strictEqual(throwOrigin(['src/a.test.ts:4', 'src/a.ts:9']).origin, 'test');
  assert.strictEqual(throwOrigin(['tests/conftest.py:8']).origin, 'test');
  assert.strictEqual(throwOrigin(['pkg/a_test.go:12']).origin, 'test');
  assert.strictEqual(throwOrigin(['src/a.ts:9'], 'TypeError: foo is not a function').origin, 'bad_call');
  assert.strictEqual(throwOrigin(['node:internal/x:1']).origin, 'unknown');
});

test('signatureChanged sees a declaration change of a named function only', () => {
  const d = '@@ -1,1 +1,1 @@\n-export function parse(a: string): number {\n+export function parse(a: string, strict: boolean): number {\n';
  assert.ok(signatureChanged(d, ['parse']));
  assert.ok(!signatureChanged(d, ['other']));
  assert.ok(signatureChanged('-def build(a):\n+def build(a, b):\n', ['build']));
  assert.ok(signatureChanged('+const run = async (x) => {\n', ['run']));
  assert.ok(!signatureChanged('-  return parse(a)\n+  return parse(a, true)\n', ['parse']));
});

test('finding id is stable and depends on run, pr, path, line and title', () => {
  const f = { path: 'a.ts', line: 3, title: 't' };
  assert.strictEqual(f2p.findingId('r1', 'p1', f), f2p.findingId('r1', 'p1', { ...f }));
  assert.notStrictEqual(f2p.findingId('r1', 'p1', f), f2p.findingId('r2', 'p1', f));
  assert.notStrictEqual(f2p.findingId('r1', 'p1', f), f2p.findingId('r1', 'p1', { ...f, line: 4 }));
});

test('arm classification by distance from old-side hunks', () => {
  const t = { 'a.ts': [[100, 110]], 'b.ts': [] };
  assert.strictEqual(f2p.classify({ path: 'a.ts', line: 90, kind: 'missing_test' }, t).arm, 'NEAR');
  assert.strictEqual(f2p.classify({ path: 'a.ts', line: 79, kind: 'missing_test' }, t).arm, 'FAR');
  assert.strictEqual(f2p.classify({ path: 'a.ts', line: 79, kind: 'missing_test' }, t, 40).arm, 'NEAR');
  assert.strictEqual(f2p.classify({ path: 'b.ts', line: 5, kind: 'missing_test' }, t).arm, 'FAR');
  assert.strictEqual(f2p.classify({ path: 'a.ts', line: null, kind: 'missing_test' }, t).arm, 'EXCLUDED_NO_LINE');
  assert.strictEqual(f2p.classify({ path: 'c.ts', line: 1, kind: 'missing_test' }, t).arm, 'UNTOUCHED');
  assert.strictEqual(f2p.classify({ path: 'src/c.test.ts', line: 1, kind: 'weak_test' }, { 'src/c.ts': [[1, 1]] }).arm, 'UNIT_TOUCHED_WEAK');
});

test('stats: Fisher, Wilson and the clustered MDD behave', () => {
  assert.ok(Math.abs(fisher2(3, 3, 0, 3) - 0.1) < 1e-9);
  const w = wilson(5, 10); assert.ok(w[0] < 0.5 && w[1] > 0.5);
  const small = mdd([3, 3, 3, 3], [3, 3, 3, 3], 0.05, { icc: 0.3, sims: 60, reps: 100 });
  assert.ok(small === null || small > 0.3); // 24 findings cannot detect small effects
});

test('report: exclusion classes per arm and the excluded-yes sensitivity line', () => {
  const report = require('./report');
  const rows = [
    { id: 'a', pr: 'p1', verdict: 'verified', claim_match: 'yes' },
    { id: 'b', pr: 'p1', verdict: 'api_shift', claim_match: 'yes' },
    { id: 'c', pr: 'p2', verdict: 'invalid', subtype: 'bad_call', claim_match: 'yes' },
    { id: 'd', pr: 'p2', verdict: 'invalid', subtype: 'compile', claim_match: 'yes' },
    { id: 'e', pr: 'p3', verdict: 'verified', claim_match: 'no' },
    { id: 'f', pr: 'p3', verdict: 'unrunnable' },
    { id: 'g', pr: 'p4', verdict: 'flaky' },
    { id: 'h', pr: 'p4', verdict: 'verified_throw', claim_match: 'yes' },
    { id: 'i', pr: 'p5', verdict: 'invalid', subtype: 'throw_on_fixed' },
  ];
  const arm = { a: 'NEAR', b: 'NEAR', c: 'NEAR', d: 'NEAR', e: 'NEAR', f: 'NEAR', g: 'FAR', h: 'FAR', i: 'FAR' };
  const t = report.tables(rows, arm);
  assert.strictEqual(t.NEAR.exclusions.api_shift, 1);
  assert.strictEqual(t.NEAR.exclusions.invalid_bad_call, 1);
  assert.strictEqual(t.NEAR.exclusions.unrunnable, 1);
  assert.strictEqual(t.FAR.exclusions.flaky, 1);
  assert.strictEqual(t.FAR.exclusions.invalid_throw_on_fixed, 1);
  assert.strictEqual(t.NEAR.runnable, 5);
  assert.strictEqual(t.NEAR.primary, 1); // only verified + yes
  assert.strictEqual(t.NEAR.verified_no, 1);
  assert.strictEqual(t.NEAR.sensitivity, 3); // verified + api_shift + bad_call; compile error is never counted
  assert.strictEqual(t.FAR.secondary, 1);
  assert.match(report.format(t, { primary: report.compare(t, rows, arm, 'primary') }), /api_shift\t1\t0/);
});

test('run refuses a test file that changed after it was frozen', () => {
  const { freeze } = require('./harness');
  const row = freeze({ id: 'x' }, { 'a.test.ts': 'h1' });
  assert.deepStrictEqual(row.test_sha256_frozen, { 'a.test.ts': 'h1' });
  assert.doesNotThrow(() => freeze(row, { 'a.test.ts': 'h1' }));
  assert.throws(() => freeze(row, { 'a.test.ts': 'h2' }), /changed since it was frozen/);
});

test('results.json carries no test text', () => {
  const p = require('node:path').join(__dirname, 'results.json');
  if (!require('node:fs').existsSync(p)) return;
  const txt = require('node:fs').readFileSync(p, 'utf8');
  assert.ok(!/\b(describe|it|test)\(|expect\(|assert\./.test(txt));
});

test('report: deps_changed and harness-invalid repos are excluded from the measures but counted per arm', () => {
  const report = require('./report');
  const rows = [
    { id: 'a', pr: 'p1', repo: 'r1', verdict: 'verified', claim_match: 'yes' },
    { id: 'b', pr: 'p2', repo: 'r1', verdict: 'deps_changed' },
    { id: 'c', pr: 'p3', repo: 'bad', verdict: 'verified', claim_match: 'yes' },
    { id: 'd', pr: 'p3', repo: 'r1', verdict: 'not_discriminating' },
  ];
  const t = report.tables(rows, { a: 'NEAR', b: 'NEAR', c: 'NEAR', d: 'FAR' }, { invalidRepos: new Set(['bad']) });
  assert.strictEqual(t.NEAR.runnable, 1);
  assert.strictEqual(t.NEAR.primary, 1);
  assert.strictEqual(t.NEAR.exclusions.deps_changed, 1);
  assert.strictEqual(t.NEAR.exclusions.harness_invalid, 1);
  assert.strictEqual(t.FAR.runnable, 1);
});

test('harnessStatus: k/n of the positive controls decides valid, invalid or unvalidated', () => {
  const { harnessStatus } = require('./harness');
  const pc = (repo, status) => ({ repo, status });
  const s = harnessStatus({ positive_control: { a: pc('ok', 'verified'), b: pc('ok', 'verified'), c: pc('ok', 'verified'), d: pc('ok', 'verified'), e: pc('ok', 'not_verified'), f: pc('low', 'not_verified'), g: pc('low', 'verified'), h: pc('none', 'none'), i: pc('un', 'unrunnable') } });
  assert.deepStrictEqual([s.ok.k, s.ok.n, s.ok.status], [4, 5, 'valid']);
  assert.strictEqual(s.low.status, 'invalid');
  assert.strictEqual(s.none.status, 'unvalidated');
  assert.strictEqual(s.un.status, 'unvalidated');
});

test('manifest changes are recognised as deps_changed', () => {
  const { MANIFEST } = f2p;
  for (const p of ['package.json', 'packages/a/package.json', 'pnpm-lock.yaml', 'go.mod', 'go.sum', 'pyproject.toml', 'uv.lock', 'requirements-dev.txt', 'libs/core/pyproject.toml']) assert.ok(MANIFEST.test(p), p);
  for (const p of ['src/package.json.ts', 'docs/go.md', 'README.md']) assert.ok(!MANIFEST.test(p), p);
});

test('list import: row shape, id stability, unknown repos recorded, unresolved shas', () => {
  const { buildListRows } = require('./harness');
  const holdoutKeys = Object.keys(f2p.readJson(require('node:path').join(__dirname, 'holdout2-candidates.json')).candidates[0]);
  const repos = { 'honojs/hono': { name: 'hono', status: 'runnable' }, 'go-gitea/gitea': { name: 'gitea', status: 'unrunnable', reason: 'not set up' }, 'rqlite/rqlite': { name: 'rqlite', status: 'runnable' } };
  const env = { repos, harness: (r) => (r === 'honojs/hono' ? 'valid' : 'invalid'), hasClone: () => true, shaExists: (r, s) => s !== 'dead', depsChanged: () => false };
  const fin = (path, line) => ({ kind: 'missing_test', path, line, title: `t ${path}`, body: 'b' });
  const list = [
    { repo: 'honojs/hono', buggy_sha: 'aaaaaaaa11', fixed_sha: 'bbbbbbbb22', finding: fin('src/a.ts', 3) },
    { repo: 'honojs/hono', buggy_sha: 'aaaaaaaa11', fixed_sha: 'bbbbbbbb22', pr: 'case-7', id: 'given-id', finding: fin('src/b.ts', 4) },
    { repo: 'someone/else', buggy_sha: 'c1', fixed_sha: 'c2', finding: fin('x.py', 1) },
    { repo: 'go-gitea/gitea', buggy_sha: 'd1', fixed_sha: 'd2', finding: fin('m.go', 2) },
    { repo: 'rqlite/rqlite', buggy_sha: 'e1', fixed_sha: 'e2', finding: fin('db/db.go', 5) },
    { repo: 'honojs/hono', buggy_sha: 'dead', fixed_sha: 'bbbbbbbb22', finding: fin('src/c.ts', 6) },
  ];
  const a = buildListRows(list, 'setx', env), b = buildListRows(list, 'setx', env), c = buildListRows(list, 'sety', env);
  assert.strictEqual(a.rows.length, list.length); // nothing is dropped
  assert.deepStrictEqual(a.rows.map((x) => x.id), b.rows.map((x) => x.id)); // stable
  assert.notStrictEqual(a.rows[0].id, c.rows[0].id); // the set name is part of the id
  assert.strictEqual(a.rows[0].id, f2p.sha(['setx', 'honojs/hono', 'aaaaaaaa11', 'src/a.ts', 3, 't src/a.ts'].join('|')));
  assert.strictEqual(a.rows[1].id, 'given-id');
  assert.deepStrictEqual([a.rows[0].pr, a.rows[1].pr], ['hono-aaaaaaaa', 'case-7']);
  for (const k of holdoutKeys.filter((k) => k !== 'fields')) assert.ok(k in a.rows[0], `row has ${k}`);
  assert.ok(a.rows.every((x) => x.arm === 'LIST' && x.in_oracle_set === true));
  assert.deepStrictEqual(a.rows.map((x) => x.status), ['ok', 'ok', 'unrunnable', 'unrunnable', 'unrunnable', 'unresolved']);
  assert.match(a.rows[2].reason, /not in repos\.json/);
  assert.strictEqual(a.rows[3].reason, 'not set up');
  assert.match(a.rows[4].reason, /harness is invalid/);
  assert.match(a.rows[5].reason, /not in the local clone/);
  assert.strictEqual(a.fields[a.rows[0].id].body, 'b');
  assert.throws(() => buildListRows([list[0], list[0]], 'setx', env), /duplicate id/);
  assert.throws(() => buildListRows([{ repo: 'honojs/hono', buggy_sha: 'a', fixed_sha: 'b', finding: { kind: 'missing_test' } }], 'setx', env), /finding\.path is required/);
});

test('default file names are unchanged without --set; a set gets its own files', () => {
  const h = require('./harness');
  h.useSet(null);
  assert.deepStrictEqual(h.files(), { results: 'results.json', baseline: 'baseline.json', cand: 'holdout2-candidates.json', fields: 'holdout2-fields.json' });
  const sc = h.scope();
  assert.strictEqual(sc.reps.length, f2p.readJson(require('node:path').join(__dirname, 'holdout2-candidates.json')).candidates.filter((x) => x.in_oracle_set).length);
  h.useSet('demo');
  assert.deepStrictEqual(h.files(), { results: 'results-demo.json', baseline: 'baseline-demo.json', cand: 'demo-candidates.json', fields: 'demo-fields.json' });
  h.useSet(null);
});
