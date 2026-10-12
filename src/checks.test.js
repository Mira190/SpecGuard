const test = require('node:test');
const assert = require('node:assert/strict');
const { inspectChecks } = require('./checks');

const inspect = (names, runs = [], statuses = []) => inspectChecks({ owner: 'o', repo: 'r', ref: 'HEAD', names,
  github: { paginate: async (fn, args) => { assert.equal(args.ref, 'HEAD'); return fn(); }, rest: {
    checks: { listForRef: () => runs }, repos: { listCommitStatusesForRef: () => statuses },
  } } });
const check = (name, conclusion, extra = {}) => ({ name, conclusion, status: 'completed', id: 1, html_url: 'https://github.com/o/r/actions/runs/1', app: { slug: 'github-actions' }, ...extra });

test('confirms only when every configured check and status succeeds', async () => {
  const r = await inspect('check:lint\nstatus:format', [check('lint', 'success')], [{ context: 'format', state: 'success', id: 2 }]);
  assert.equal(r.status, 'passed');
  assert.equal(r.checks[0].producer, 'github-actions');
  assert.equal(r.checks[0].url, 'https://github.com/o/r/actions/runs/1');
  assert.equal((await inspect('check:lint\ncheck:format', [check('lint', 'success')])).status, 'not_found');
  assert.equal((await inspect('check:lint', [check('lint-extra', 'success')])).status, 'not_found');
});

test('does not treat pending, skipped, neutral or unavailable as success', async () => {
  for (const conclusion of ['neutral', 'skipped', null]) assert.equal((await inspect('check:lint', [check('lint', conclusion)])).status, 'incomplete');
  assert.equal((await inspect('check:lint', [check('lint', null, { status: 'in_progress' })])).status, 'pending');
  assert.equal((await inspect('check:lint', [check('lint', 'failure')])).status, 'failed');
  assert.equal((await inspect('')).status, 'not_configured');
  assert.equal((await inspect('lint')).status, 'unavailable');
  assert.equal((await inspectChecks({ names: 'check:lint', ref: 'HEAD', github: { paginate: async () => { throw new Error('403'); }, rest: { checks: {} } } })).status, 'unavailable');
});

test('uses the latest rerun and ignores unrelated green checks', async () => {
  assert.equal((await inspect('check:lint', [check('lint', 'success'), check('lint', 'failure', { id: 2 }), check('tests', 'success', { id: 3 })])).status, 'failed');
  assert.equal((await inspect('status:lint', [], [{ context: 'lint', state: 'failure', id: 1 }, { context: 'lint', state: 'success', id: 2 }])).status, 'passed');
});

test('M10: one name reported by two producers is ambiguous, never passed, and lists both producers and ids', async () => {
  const runs = [check('lint', 'failure', { id: 11, app: { slug: 'trusted-ci' } }), check('lint', 'success', { id: 12, app: { slug: 'other-app' } })];
  const r = await inspect('check:lint', runs);
  assert.equal(r.status, 'ambiguous');
  assert.equal(r.checks[0].state, 'ambiguous');
  assert.deepEqual(r.checks[0].producers.map((p) => [p.producer, p.id, p.state]), [['other-app', 12, 'success'], ['trusted-ci', 11, 'failure']]);
  assert.equal(r.checks[0].producer, 'other-app #12 success, trusted-ci #11 failure');
  assert.match(r.reason, /More than one producer reports check:lint/);
  const s = await inspect('status:format', [], [{ context: 'format', state: 'success', id: 5, creator: { login: 'a' } }, { context: 'format', state: 'success', id: 6, creator: { login: 'b' } }]);
  assert.equal(s.status, 'ambiguous'); // two all-green producers are still ambiguous
  assert.equal((await inspect('check:lint\ncheck:tests', [...runs, check('tests', 'failure', { id: 13 })])).status, 'failed'); // a plain failure elsewhere still dominates
});

test('M10: one producer rerunning keeps the latest-wins rule, also next to a different producer elsewhere', async () => {
  const rerun = [check('lint', 'failure', { id: 1 }), check('lint', 'success', { id: 2 })];
  const r = await inspect('check:lint\ncheck:tests', [...rerun, check('tests', 'success', { id: 3, app: { slug: 'other-app' } })]);
  assert.equal(r.status, 'passed');
  assert.deepEqual([r.checks[0].state, r.checks[0].id, r.checks[0].producer, r.reason], ['success', 2, 'github-actions', undefined]);
});
