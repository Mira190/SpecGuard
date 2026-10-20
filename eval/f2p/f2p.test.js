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

// ---- red-team fixes B1-B4 ----
const fsx = require('node:fs');
const osx = require('node:os');
const pathx = require('node:path');
const runners = require('./runners');
const goEvents = (test, lines, action = 'fail') => [...lines.map((l) => ({ Action: 'output', Test: test, Output: l + '\n' })), { Action: action, Test: test }, { Action: action }].map((e) => JSON.stringify(e)).join('\n');
const TESTING = ['testing.tRunner.func1.2({0x1234, 0x5678})', '\ttesting/testing.go:1734 +0x21c', 'testing.tRunner.func1()', '\ttesting/testing.go:1737 +0x35e', 'panic({0x1234?, 0x5678?})', '\truntime/panic.go:787 +0x132'];
const HEAD = ['panic: runtime error: invalid memory address or nil pointer dereference [recovered]', '\tpanic: runtime error: invalid memory address or nil pointer dereference', 'goroutine 7 [running]:'];

test('B1 parseGo: a nil dereference inside a _test.go (trimpath trace) is origin test', () => {
  const trace = [...HEAD, ...TESTING, 'github.com/acme/proj/db.TestThing(0xc000)', '\tgithub.com/acme/proj/db/db_new_test.go:21 +0x20', 'testing.tRunner(0xc0001, 0x2345)', '\ttesting/testing.go:1792 +0xf4'];
  const o = runners.parseGo(goEvents('TestThing', trace), 'C:/tmp/x');
  assert.deepStrictEqual([o.outcome, o.origin, o.frame], ['throw', 'test', 'github.com/acme/proj/db/db_new_test.go:21']);
});

test('B1 parseGo: a panic in production code is production, stdlib and runtime frames are skipped', () => {
  const trace = [...HEAD, ...TESTING, 'github.com/acme/proj/db.(*DB).Query(...)', '\tgithub.com/acme/proj/db/db.go:100 +0x4c', 'github.com/acme/proj/db.TestThing(0xc000)', '\tgithub.com/acme/proj/db/db_new_test.go:21 +0x20'];
  const o = runners.parseGo(goEvents('TestThing', trace), 'C:/tmp/x');
  assert.deepStrictEqual([o.outcome, o.origin, o.frame], ['throw', 'production', 'github.com/acme/proj/db/db.go:100']);
  // a dependency (@v) and an absolute GOROOT frame are runtime too; an absolute frame under cwd is repo-local
  assert.strictEqual(runners.goFrame('golang.org/x/sys@v0.1.0/unix/a.go', 'C:/tmp/x'), null);
  assert.strictEqual(runners.goFrame('C:/Go/src/testing/testing.go', 'C:/tmp/x'), null);
  assert.strictEqual(runners.goFrame('C:/tmp/x/db/db.go', 'C:/tmp/x'), 'db/db.go');
});

test('B1 parseGo: test timed out is an error, not a throw', () => {
  const o = runners.parseGo(goEvents('TestSlow', ['panic: test timed out after 15m0s', 'running tests:', '\tTestSlow (15m0s)', 'goroutine 9 [running]:', 'testing.(*M).startAlarm.func1()', '\ttesting/testing.go:2484 +0x1b']), 'C:/tmp/x');
  assert.deepStrictEqual([o.outcome, o.msg], ['error', 'test timed out']);
});

test('B1 parsePytest: a Windows interpreter stdlib frame (...\\Lib\\json\\...) is skipped, a test frame is test', () => {
  const xml = (frames) => `<testsuite><testcase classname="t" name="a"><failure message="ValueError: x">${frames}\nE   ValueError: x</failure></testcase></testsuite>`;
  const prod = runners.parsePytest(xml('tests/test_x.py:5: in test_a\nsrc/pkg/mod.py:9: in f\nD:\\Python312\\Lib\\json\\decoder.py:355: in raw_decode'), 'C:/tmp/x');
  assert.deepStrictEqual([prod.outcome, prod.origin, prod.frame], ['throw', 'production', 'src/pkg/mod.py:9']);
  const tst = runners.parsePytest(xml('tests/test_x.py:5: in test_a\nD:\\Python312\\Lib\\json\\decoder.py:355: in raw_decode'), 'C:/tmp/x');
  assert.deepStrictEqual([tst.outcome, tst.origin], ['throw', 'test']);
});

test('B4 parseGo: all tests skipped is an error, a skip next to a pass is a pass', () => {
  const skipped = [{ Action: 'skip', Test: 'TestA' }, { Action: 'pass' }].map((e) => JSON.stringify(e)).join('\n');
  assert.deepStrictEqual(runners.parseGo(skipped, 'C:/tmp/x'), { outcome: 'error', msg: 'all tests skipped' });
  const mixed = [{ Action: 'skip', Test: 'TestA' }, { Action: 'pass', Test: 'TestB' }, { Action: 'pass' }].map((e) => JSON.stringify(e)).join('\n');
  assert.strictEqual(runners.parseGo(mixed, 'C:/tmp/x').outcome, 'pass');
});

test('B4 parseVitest: skipped counts are not a pass; assertion next to a non-assertion failure is an error', () => {
  const dir = fsx.mkdtempSync(pathx.join(osx.tmpdir(), 'f2p-vt-')), file = pathx.join(dir, 'o.json');
  const run = (j, status = 0) => { fsx.writeFileSync(file, JSON.stringify(j)); return runners.parseVitest({ status }, file, dir); };
  try {
    const base = { numFailedTestSuites: 0, testResults: [{ assertionResults: [] }] };
    assert.deepStrictEqual(run({ ...base, numFailedTests: 0, numTotalTests: 2, numPassedTests: 0 }), { outcome: 'error', msg: 'all tests skipped' });
    assert.strictEqual(run({ ...base, numFailedTests: 0, numTotalTests: 2, numPassedTests: 1 }).outcome, 'pass');
    const f = (m) => ({ status: 'failed', failureMessages: [m] });
    assert.strictEqual(run({ numFailedTestSuites: 0, numFailedTests: 1, numTotalTests: 1, numPassedTests: 0, testResults: [{ assertionResults: [f('AssertionError: expected 1 to be 2')] }] }, 1).outcome, 'assert_fail');
    assert.strictEqual(run({ numFailedTestSuites: 0, numFailedTests: 2, numTotalTests: 2, numPassedTests: 0, testResults: [{ assertionResults: [f('AssertionError: expected 1 to be 2'), f('TypeError: x is not a function')] }] }, 1).outcome, 'error');
  } finally { fsx.rmSync(dir, { recursive: true, force: true }); }
});

test('pytest: DID NOT RAISE and pytest.fail are assertions; an assertion next to a thrown error is an error; combine() cannot hide an error', () => {
  const tc = (msg, body = '') => `<testcase classname="t" name="n"><failure message="${msg}">${body}</failure></testcase>`;
  const x = (...c) => `<testsuite>${c.join('')}</testsuite>`;
  assert.strictEqual(runners.parsePytest(x(tc('Failed: DID NOT RAISE &lt;class ValueError&gt;')), '').outcome, 'assert_fail');
  assert.strictEqual(runners.parsePytest(x(tc('Failed: boom')), '').outcome, 'assert_fail');
  assert.strictEqual(runners.parsePytest(x(tc('assert 1 == 2'), tc('TypeError: bad', 'src/a.py:1: in f')), '').outcome, 'error');
  const ok = { outcome: 'pass' }, af = { outcome: 'assert_fail' }, er = { outcome: 'error', msg: 'import' };
  assert.strictEqual(runners.combine([af, er]).outcome, 'error');
  assert.strictEqual(runners.combine([er, af]).outcome, 'error');
  assert.strictEqual(runners.combine([ok, af]).outcome, 'assert_fail');
  assert.strictEqual(runners.combine([ok, ok]).outcome, 'pass');
  assert.strictEqual(runners.combine([af, { outcome: 'throw' }]).outcome, 'error');
});

test('B2 list import: a group that exists in another set, a duplicate id and one group with two pairs are refused', () => {
  const { buildListRows } = require('./harness');
  const env = (existing) => ({ repos: { 'honojs/hono': { name: 'hono', status: 'runnable' } }, harness: () => 'valid', hasClone: () => true, shaExists: () => true, depsChanged: () => false, existing });
  const e = (over = {}) => ({ repo: 'honojs/hono', buggy_sha: 'aaaaaaaa11', fixed_sha: 'bbbbbbbb22', finding: { kind: 'missing_test', path: 'a.ts', line: 1, title: 't', body: 'b' }, ...over });
  assert.throws(() => buildListRows([e()], 's', env({ ids: new Map(), groups: new Map([['hono-aaaaaaaa', 'holdout2']]) })), /group hono-aaaaaaaa already exists in set holdout2/);
  assert.throws(() => buildListRows([e({ id: 'x1' })], 's', env({ ids: new Map([['x1', 'hono']]), groups: new Map() })), /already exists in another set/);
  assert.throws(() => buildListRows([e({ pr: 'g' }), e({ pr: 'g', fixed_sha: 'cccccccc33', finding: { kind: 'missing_test', path: 'b.ts', line: 2, title: 'u', body: 'b' } })], 's', env({ ids: new Map(), groups: new Map() })), /more than one buggy\/fixed pair/);
  assert.doesNotThrow(() => buildListRows([e({ pr: 'g' }), e({ pr: 'g', finding: { kind: 'missing_test', path: 'b.ts', line: 2, title: 'u', body: 'b' } })], 's', env({ ids: new Map(), groups: new Map() })));
});

test('B2 trees, tests and packets are namespaced per set; an exported tree whose .sha differs is refused', () => {
  const h = require('./harness');
  h.useSet(null);
  const plain = [h.treeDir('g'), h.testsRoot('i'), h.packetsDir()].map((p) => p.split('\\').join('/'));
  h.useSet('demo');
  const named = [h.treeDir('g'), h.testsRoot('i'), h.packetsDir()].map((p) => p.split('\\').join('/'));
  h.useSet(null);
  assert.ok(plain[0].endsWith('/trees/g/buggy') && plain[1].endsWith('/tests/i') && plain[2].endsWith('/packets'));
  assert.ok(named[0].endsWith('/trees/demo/g/buggy') && named[1].endsWith('/tests/demo/i') && named[2].endsWith('/packets/demo'));
  const dir = fsx.mkdtempSync(pathx.join(osx.tmpdir(), 'f2p-sha-'));
  try {
    assert.throws(() => h.checkTree('g', 'bbb', dir), /no \.sha/);
    fsx.writeFileSync(pathx.join(dir, '.sha'), 'aaa\n');
    assert.throws(() => h.checkTree('g', 'bbb', dir), /expected bbb/);
    assert.doesNotThrow(() => h.checkTree('g', 'aaa', dir));
    assert.throws(() => h.assertFree(dir, ['.sha']), /already exists in the tree/);
    assert.doesNotThrow(() => h.assertFree(dir, ['new.test.ts']));
  } finally { fsx.rmSync(dir, { recursive: true, force: true }); }
});

test('--set without a value and --set=x are refused', () => {
  assert.throws(() => f2p.parseFlags(['run', '--set']), /needs a value/);
  assert.throws(() => f2p.parseFlags(['run', '--set', '--name', 'x']), /needs a value/);
  assert.throws(() => f2p.parseFlags(['run', '--set=x']), /not accepted/);
  assert.deepStrictEqual(f2p.parseFlags(['run', '--set', 'x', 'id1']), { opts: { set: 'x' }, rest: ['run', 'id1'] });
});

test('N1a parseVitest: a rejects failure (promise resolved instead of rejecting) is an assertion failure', () => {
  const dir = fsx.mkdtempSync(pathx.join(osx.tmpdir(), 'f2p-vt2-')), file = pathx.join(dir, 'o.json');
  const run = (msgs) => { fsx.writeFileSync(file, JSON.stringify({ numFailedTestSuites: 0, numFailedTests: msgs.length, numTotalTests: msgs.length, numPassedTests: 0, testResults: [{ assertionResults: msgs.map((m) => ({ status: 'failed', failureMessages: [m] })) }] })); return runners.parseVitest({ status: 1 }, file, dir); };
  try {
    assert.strictEqual(run(['Error: promise resolved "5" instead of rejecting']).outcome, 'assert_fail');
    assert.strictEqual(run(['Error: promise resolved "5" instead of rejecting', 'AssertionError: expected 1 to be 2']).outcome, 'assert_fail');
    assert.strictEqual(run(['Error: promise resolved "5" instead of rejecting', 'TypeError: x is not a function']).outcome, 'error');
    assert.strictEqual(run(['TypeError: x is not a function\n    at f (src/a.ts:1:1)']).outcome, 'throw');
  } finally { fsx.rmSync(dir, { recursive: true, force: true }); }
});

test('N1b list names: ids, groups and set names are file-name safe; buggy, fixed and existing groups are refused', () => {
  const { buildListRows, badName } = require('./harness');
  for (const bad of ['', '.', '..', 'a/b', 'a b', 'buggy', 'fixed', 'x:y', 'é']) assert.ok(badName(bad), JSON.stringify(bad));
  for (const ok of ['a', 'hono-5ca49b0', 'case_1.2', 'AbC-9']) assert.ok(!badName(ok), ok);
  const env = (existing) => ({ repos: { 'honojs/hono': { name: 'hono', status: 'runnable' } }, harness: () => 'valid', hasClone: () => true, shaExists: () => true, depsChanged: () => false, existing });
  const none = { ids: new Map(), groups: new Map(), sets: new Set() };
  const e = (over = {}) => ({ repo: 'honojs/hono', buggy_sha: 'aaaaaaaa11', fixed_sha: 'bbbbbbbb22', finding: { kind: 'missing_test', path: 'a.ts', line: 1, title: 't', body: 'b' }, ...over });
  assert.throws(() => buildListRows([e()], '../x', env(none)), /set name/);
  assert.throws(() => buildListRows([e()], 'fixed', env(none)), /set name/);
  assert.throws(() => buildListRows([e()], 'hono-3604', env({ ...none, groups: new Map([['hono-3604', 'holdout2']]) })), /equals an existing group/);
  assert.throws(() => buildListRows([e({ id: '../evil' })], 's', env(none)), /id .* is not allowed/);
  assert.throws(() => buildListRows([e({ pr: 'buggy' })], 's', env(none)), /group .* is not allowed/);
  assert.throws(() => buildListRows([e({ pr: 'a/b' })], 's', env(none)), /group .* is not allowed/);
  assert.throws(() => buildListRows([e({ pr: 'other' })], 's', env({ ...none, sets: new Set(['other']) })), /equals the name of an existing set/);
  assert.doesNotThrow(() => buildListRows([e({ pr: 'g1', id: 'id.1' })], 's', env(none)));
});

test('N1c archive: an incomplete export is refused (tar status and file count against the commit)', () => {
  const h = require('./harness');
  assert.throws(() => h.assertExport({ status: null, files: 3, expected: 3, rev: 'abcdef123' }), /tar did not run/);
  assert.throws(() => h.assertExport({ status: 0, files: 2, expected: 3, rev: 'abcdef123' }), /incomplete: tar exit 0, 2 files on disk, 3 in the commit/);
  assert.throws(() => h.assertExport({ status: 2, files: 2, expected: 3, rev: 'abcdef123' }), /incomplete/);
  assert.doesNotThrow(() => h.assertExport({ status: 0, files: 3, expected: 3, rev: 'abcdef123' }));
  assert.doesNotThrow(() => h.assertExport({ status: 1, files: 3, expected: 3, rev: 'abcdef123' })); // symlink warnings on Windows, every file present
  const dir = fsx.mkdtempSync(pathx.join(osx.tmpdir(), 'f2p-cnt-'));
  try {
    fsx.mkdirSync(pathx.join(dir, 'a')); fsx.writeFileSync(pathx.join(dir, 'a', 'x.txt'), '1'); fsx.writeFileSync(pathx.join(dir, 'y.txt'), '2'); fsx.writeFileSync(pathx.join(dir, '.sha'), 's');
    assert.strictEqual(h.countFiles(dir), 2); // the root .sha is not a tree file
  } finally { fsx.rmSync(dir, { recursive: true, force: true }); }
});

test('N1d controls: an interrupted run is a harness_error that never replaces a completed result and is not in k/n', () => {
  const h = require('./harness');
  const res = { positive_control: { 'g1': { repo: 'r', status: 'verified' } } };
  const kept = h.recordControl(res, 'g1', { repo: 'r', status: 'harness_error', reason: 'disk guard' });
  assert.strictEqual(kept.status, 'verified');
  assert.strictEqual(res.positive_control.g1.status, 'verified');
  assert.strictEqual(res.positive_control_errors.g1.reason, 'disk guard');
  h.recordControl(res, 'g2', { repo: 'r', status: 'harness_error', reason: 'oom' }); // nothing completed before: recorded as is
  assert.strictEqual(res.positive_control.g2.status, 'harness_error');
  h.recordControl(res, 'g1', { repo: 'r', status: 'not_verified' }); // a completed rerun does replace it
  assert.strictEqual(res.positive_control.g1.status, 'not_verified');
  assert.deepStrictEqual([h.harnessStatus(res).r.k, h.harnessStatus(res).r.n], [0, 1]); // g2 (harness_error) is out of n
});

// ---- cover (E1) ----
const cov = require('./cover');
test('cover: lcov fixture gives covered/total lines per repo-relative file', () => {
  const lcov = String.raw`TN:
SF:C:\t\tree\src\a.ts
DA:1,3
DA:2,0
DA:3,1
LF:3
LH:2
end_of_record
SF:/t/tree/src/b.ts
DA:5,0
end_of_record
`;
  assert.deepStrictEqual(cov.parseLcov(lcov, String.raw`C:\t\tree`)['src/a.ts'], [2, 3]);
  assert.deepStrictEqual(cov.parseLcov(lcov, '/t/tree')['src/b.ts'], [0, 1]);
});

test('cover: coverage.xml fixture gives covered/total lines per repo-relative file', () => {
  const xml = `<coverage><sources><source>/t/tree</source></sources><packages><package name="sqlglot"><classes>
<class name="a.py" filename="sqlglot/a.py"><methods/><lines><line number="1" hits="1"/><line number="2" hits="0"/><line number="4" hits="2"/></lines></class>
<class name="b.py" filename="sqlglot/b.py"><methods/><lines/></class></classes></package></packages></coverage>`;
  assert.deepStrictEqual(cov.parseCoverageXml(xml, '/t/tree', () => true), { 'sqlglot/a.py': [2, 3], 'sqlglot/b.py': [0, 0] });
});

test('cover: zero selected test files (or a missing dir) is an error, never 0% covered', () => {
  const dir = fsx.mkdtempSync(pathx.join(osx.tmpdir(), 'f2p-cov-'));
  try {
    fsx.mkdirSync(pathx.join(dir, 'src', 'runtime-tests'), { recursive: true });
    fsx.writeFileSync(pathx.join(dir, 'src', 'runtime-tests', 'x.test.ts'), '');
    const c = { dirs: ['src'], file_re: '\\.test\\.ts$', exclude: ['runtime-tests'] };
    assert.throws(() => cov.selectTests(dir, c), /0 test files selected/); // only an excluded file
    assert.throws(() => cov.selectTests(dir, { ...c, dirs: ['nope'] }), /does not exist/);
    fsx.writeFileSync(pathx.join(dir, 'src', 'a.test.ts'), '');
    assert.deepStrictEqual(cov.selectTests(dir, c), ['src/a.test.ts']);
  } finally { fsx.rmSync(dir, { recursive: true, force: true }); }
});

test('cover: collection and import errors are recorded per file with a repo-relative posix path', () => {
  const stdout = String.raw`ERROR tests\test_x.py - ImportError: cannot import name q from D:\build\tree\mod.py
ERROR /t/tree/tests/sub/test_y.py - ModuleNotFoundError: No module named z
ERROR tests/test_z.py::test_a - fixture boom
FAILED tests/test_w.py::t - assert 0
`;
  const xml = '<testsuites><testsuite name="pytest" errors="3" failures="1" skipped="2" tests="9"></testsuite></testsuites>';
  const r = cov.pytestHealth(xml, stdout, '/t/tree');
  assert.deepStrictEqual(Object.keys(r.file_errors), ['tests/test_x.py', 'tests/sub/test_y.py']); // the :: line is a test error, not a file error
  assert.ok(!/[A-Za-z]:[\\/]|build/.test(JSON.stringify(r.file_errors)), 'no local paths in messages');
  assert.deepStrictEqual(r.health, { passed: 3, failed: 1, errored: 3, skipped: 2 });
  const j = { numPassedTests: 5, numFailedTests: 1, numPendingTests: 1, numTodoTests: 1, testResults: [{ name: '/t/tree/src/ok.test.ts', status: 'passed', assertionResults: [{}] }, { name: '/t/tree/src/utils/bad.test.ts', status: 'failed', message: 'Failed to resolve import', assertionResults: [] }] };
  const v = cov.vitestHealth(j, ['src/ok.test.ts', 'src/utils/bad.test.ts', 'src/lost.test.ts'], '/t/tree');
  assert.deepStrictEqual(v.file_errors, { 'src/utils/bad.test.ts': 'Failed to resolve import', 'src/lost.test.ts': 'no result' });
  assert.deepStrictEqual(v.health, { passed: 5, failed: 1, errored: 2, skipped: 2 });
});

test('cover: deps_changed is flagged only for the env manifests', () => {
  assert.strictEqual(cov.depsChanged(['src/a.ts', 'package.json'], ['package.json']), true);
  assert.strictEqual(cov.depsChanged(['libs/partners/x/pyproject.toml', 'src/a.ts'], ['libs/core/pyproject.toml', 'libs/core/uv.lock']), false);
  assert.strictEqual(cov.depsChanged([], ['package.json']), false);
});
