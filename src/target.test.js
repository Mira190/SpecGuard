const test = require('node:test');
const assert = require('node:assert/strict');
const { withTarget, readOnly } = require('./target.js');

// What github-script hands over on a workflow_dispatch in the SpecGuard repo: `repo` is a prototype getter, `payload` has no pull_request.
class Ctx { constructor() { this.payload = { inputs: { x: 1 } }; this.serverUrl = 'https://github.com'; this.sha = 'speccccc'; this.eventName = 'workflow_dispatch'; } get repo() { return { owner: 'org', repo: 'specguard' }; } }

test('withTarget: no overrides leaves the context untouched (the pull_request flow)', () => {
  const c = new Ctx();
  assert.equal(withTarget(c, {}), c);
  assert.equal(withTarget(c, { TARGET_REPO: '', TARGET_PR: '' }), c);
});

test('withTarget: repo, PR and commits come from the inputs; the rest of the event survives; the original is not mutated', () => {
  const c = new Ctx();
  const t = withTarget(c, { TARGET_REPO: 'acme/shop', TARGET_PR: '12', HEAD_SHA: 'h'.repeat(40), BASE_SHA: 'b'.repeat(40), TARGET_SHA: 't' });
  assert.deepEqual(t.repo, { owner: 'acme', repo: 'shop' });
  assert.deepEqual(t.payload.pull_request, { number: 12, head: { sha: 'h'.repeat(40) }, base: { sha: 'b'.repeat(40) } });
  assert.equal(t.payload.inputs.x, 1);
  assert.equal(t.serverUrl, 'https://github.com');
  assert.equal(t.sha, 't', 'audit links point at the reviewed commit, not the workflow commit');
  assert.deepEqual(c.repo, { owner: 'org', repo: 'specguard' });
  assert.equal(c.payload.pull_request, undefined);
});

test('withTarget: repository only (audit): no pull_request is invented; a bad repo or PR value is ignored', () => {
  const a = withTarget(new Ctx(), { TARGET_REPO: 'acme/shop' });
  assert.deepEqual(a.repo, { owner: 'acme', repo: 'shop' });
  assert.equal(a.payload.pull_request, undefined);
  assert.equal(a.sha, '', 'no workflow sha in links to another repository');
  const b = withTarget(new Ctx(), { TARGET_REPO: 'not a repo', TARGET_PR: '1; drop' });
  assert.equal(b.repo.owner, 'org');
});

test('readOnly: reads pass through, every write is refused, GraphQL mutations are refused, other properties are untouched', async () => {
  const hits = [];
  const fn = (name) => async (...a) => { hits.push(name); return { data: name }; };
  const github = {
    rest: { pulls: { get: fn('pulls.get'), listFiles: fn('listFiles'), createReview: fn('createReview'), createReviewComment: fn('createReviewComment') },
      issues: { listComments: fn('listComments'), createComment: fn('createComment'), updateComment: fn('updateComment') }, users: { getAuthenticated: fn('me') }, marker: 7 },
    graphql: async (q) => { hits.push('graphql'); return { q }; },
    paginate: async (f, o) => (await f(o)).data, other: 'x',
  };
  const ro = readOnly(github);
  assert.equal((await ro.rest.pulls.get({})).data, 'pulls.get');
  assert.equal(await ro.paginate(ro.rest.issues.listComments, {}), 'listComments');
  assert.equal((await ro.rest.users.getAuthenticated()).data, 'me');
  assert.deepEqual(await ro.graphql('query { viewer { login } }'), { q: 'query { viewer { login } }' });
  assert.equal(ro.rest.marker, 7);
  assert.equal(ro.other, 'x');
  for (const call of [() => ro.rest.pulls.createReview({}), () => ro.rest.pulls.createReviewComment({}), () => ro.rest.issues.createComment({}), () => ro.rest.issues.updateComment({}), () => ro.graphql('mutation { resolveReviewThread(input: {}) { thread { id } } }'), () => ro.graphql('  MUTATION X { a }')]) {
    await assert.rejects(call(), /delivery=summary, nothing is written/);
  }
  assert.deepEqual(hits, ['pulls.get', 'listComments', 'me', 'graphql'], 'no write reached the real client');
});

test('action.yml wires the manual-run overrides and test_paths without changing the pull_request defaults', () => {
  const y = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'action.yml'), 'utf8').replace(/\r\n/g, '\n');
  for (const re of [
    /^ {2}test_paths: /m, /^ {2}delivery: \{[^}]*default: pr \}/m, /^ {2}repository: \{[^}]*default: ""/m, /^ {2}pr_number: \{[^}]*default: ""/m,
    /TEST_PATHS: \$\{\{ inputs\.test_paths \}\}\n {8}TRACE:/, // collect
    /TEST_PATHS: \$\{\{ inputs\.test_paths \}\}\n {8}MAX_REQUIREMENTS:/, // audit collect
    /AUDIT_BRANCH_GUARD: \$\{\{ inputs\.repository && inputs\.repository != github\.repository && 'off' \|\| 'on' \}\}/,
    /GH_REPO: \$\{\{ inputs\.repository \|\| github\.repository \}\}/,
    /PR_NUMBER: \$\{\{ inputs\.pr_number \|\| github\.event\.pull_request\.number \}\}/,
    /HEAD_SHA: \$\{\{ inputs\.head_sha \|\| github\.event\.pull_request\.head\.sha \}\}/,
    /BASE_SHA: \$\{\{ inputs\.base_sha \|\| github\.event\.pull_request\.base\.sha \}\}/,
    /DELIVERY: \$\{\{ inputs\.delivery \}\}/,
    /github: env\.DELIVERY === 'summary' \? t\.readOnly\(github\) : github, context: t\.withTarget\(context, env\)/,
  ]) assert.match(y, re);
});
