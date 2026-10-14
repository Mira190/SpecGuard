const test = require('node:test');
const assert = require('node:assert/strict');
const { decide, sticky, ours } = require('./preflight');

const SHA = 'a'.repeat(40);
const pr = (o = {}) => ({ state: 'open', user: { login: 'alice', type: 'User' }, ...o });
const mine = (sha = SHA) => ({ user: { type: 'Bot', login: 'github-actions[bot]' }, body: `<!-- specguard:summary -->\n<!-- specguard:head=${sha} -->\n## SpecGuard\n` });

test('an open PR from a person with no summary yet is reviewed', () => {
  assert.equal(decide({ pr: pr(), comments: [], headSha: SHA }), '');
});

test('a closed PR is skipped', () => {
  assert.match(decide({ pr: pr({ state: 'closed' }), comments: [], headSha: SHA }), /closed/);
});

test('bot authors are skipped by type or [bot] login unless include_bots', () => {
  for (const user of [{ login: 'dependabot[bot]', type: 'Bot' }, { login: 'x[bot]', type: 'User' }, { login: 'app', type: 'Bot' }]) {
    assert.match(decide({ pr: pr({ user }), comments: [], headSha: SHA }), /bot/);
    assert.equal(decide({ pr: pr({ user }), comments: [], headSha: SHA, includeBots: true }), '');
  }
});

test('a summary recording this head SHA skips the rerun unless forced; another SHA does not', () => {
  assert.match(decide({ pr: pr(), comments: [mine()], headSha: SHA }), /already/);
  assert.equal(decide({ pr: pr(), comments: [mine()], headSha: SHA, force: true }), '');
  assert.equal(decide({ pr: pr(), comments: [mine('b'.repeat(40))], headSha: SHA }), '');
});

test('only a Bot-authored comment that starts with the summary marker counts', () => {
  assert.equal(sticky({ user: { type: 'User' }, body: mine().body }, SHA), false);
  assert.equal(sticky({ user: { type: 'Bot', login: 'github-actions[bot]' }, body: `quote ${mine().body}` }, SHA), false);
  assert.equal(sticky({ user: { type: 'Bot', login: 'github-actions[bot]' }, body: '<!-- specguard:summary -->\n## SpecGuard\n' }, SHA), false); // old summary: no head marker
  assert.equal(sticky(mine(), SHA), true);
});

test('M7: a marked summary from another bot does not skip the run; ours (default or custom identity) does', () => {
  const by = (login, sha = SHA) => ({ ...mine(sha), user: { type: 'Bot', login } });
  assert.equal(decide({ pr: pr(), comments: [by('other-app[bot]')], headSha: SHA }), '');
  assert.match(decide({ pr: pr(), comments: [by('github-actions[bot]')], headSha: SHA }), /already/);
  assert.equal(decide({ pr: pr(), comments: [by('github-actions[bot]')], headSha: SHA, actor: 'review-app[bot]' }), '');
  assert.match(decide({ pr: pr(), comments: [by('review-app[bot]')], headSha: SHA, actor: 'review-app[bot]' }), /already/);
});

test('M7: ours matches REST and GraphQL author shapes and rejects humans, other bots and a missing login', () => {
  assert.equal(ours({ type: 'Bot', login: 'github-actions[bot]' }), true);
  assert.equal(ours({ __typename: 'Bot', login: 'github-actions' }), true); // GraphQL drops the [bot] suffix
  assert.equal(ours({ type: 'User', login: 'github-actions[bot]' }), false);
  assert.equal(ours({ type: 'Bot', login: 'other[bot]' }), false);
  assert.equal(ours({ type: 'Bot' }), false);
  assert.equal(ours(null), false);
  assert.equal(ours({ type: 'Bot', login: 'review-app[bot]' }, 'review-app[bot]'), true);
});

const { reqKey } = require('./preflight');

test('re-review when the requirements change: same head + same title/body skips, edited body reviews, legacy marker skips, force wins', () => {
  const p = (o) => pr({ title: 'T', body: 'B', ...o });
  const withReq = (r) => ({ ...mine(), body: mine().body.replace('## SpecGuard', `<!-- specguard:req=${r} -->\n## SpecGuard`) });
  assert.match(reqKey(p()), /^[0-9a-f]{12}$/);
  assert.equal(reqKey({ title: 'T', body: 'x\r\ny ' }), reqKey({ title: 'T', body: 'x\ny' }));
  assert.notEqual(reqKey(p()), reqKey(p({ body: 'B2' })));
  assert.equal(reqKey({}), reqKey({ title: '', body: null }));
  const c = [withReq(reqKey(p()))];
  assert.match(decide({ pr: p(), comments: c, headSha: SHA }), /already/);
  assert.equal(decide({ pr: p({ body: 'edited' }), comments: c, headSha: SHA }), '');
  assert.equal(decide({ pr: p({ title: 'T2' }), comments: c, headSha: SHA }), '');
  assert.match(decide({ pr: p({ body: 'edited' }), comments: [mine()], headSha: SHA }), /already/, 'legacy summary without a req marker still skips');
  assert.equal(decide({ pr: p(), comments: c, headSha: SHA, force: true }), '');
  assert.equal(decide({ pr: p({ body: 'edited' }), comments: c, headSha: SHA, force: true }), '');
  assert.equal(reqKey(undefined), reqKey({}), 'no PR object is the empty text, not a crash');
});

test('writer/reader contract: the summary post.js writes makes decide() skip the same text and re-review an edited one', () => {
  const { buildSummary } = require('./post');
  const p = (o) => pr({ title: 'T', body: 'B', ...o });
  const summary = (text) => ({ user: { type: 'Bot', login: 'github-actions[bot]' }, body: buildSummary({ status: 'R', state: 'complete', headSha: SHA, req: reqKey(text) }) });
  const c = [summary(p())];
  assert.match(decide({ pr: p(), comments: c, headSha: SHA }), /already/);
  assert.equal(decide({ pr: p({ body: 'B edited' }), comments: c, headSha: SHA }), '', 'edited requirements: review again');
  assert.equal(decide({ pr: p(), comments: c, headSha: 'b'.repeat(40) }), '', 'a new head: review again');
  const incomplete = [{ ...c[0], body: buildSummary({ status: 'R', state: 'incomplete', req: reqKey(p()) }) }]; // no head marker: never recorded as reviewed
  assert.equal(decide({ pr: p(), comments: incomplete, headSha: SHA }), '');
});

const { recordedLogin } = require('./preflight');
const APP = { type: 'Bot', login: 'my-app[bot]' }, PAT = { type: 'User', login: 'dev-pat' };

test('A3 preflight: the recorded login lets an App-token run skip; a person or another bot cannot make themselves ours', () => {
  const SHA = 'a'.repeat(40), pr = { state: 'open', user: { login: 'alice', type: 'User' } };
  const head = (by) => `<!-- specguard:summary -->\n${by ? `<!-- specguard:by=${by} -->\n` : ''}<!-- specguard:head=${SHA} -->\n`;
  const c = (user, body) => ({ user, body });
  assert.match(decide({ pr, comments: [c(APP, head('my-app[bot]'))], headSha: SHA }), /already/); // App token: /user is unreadable, actor null
  assert.equal(decide({ pr, comments: [c(APP, head(''))], headSha: SHA }), '', 'no recorded login: an App comment is not recognised');
  assert.equal(decide({ pr, comments: [c({ type: 'Bot', login: 'other[bot]' }, head('my-app[bot]'))], headSha: SHA }), '', 'author differs from the recorded login');
  assert.equal(decide({ pr, comments: [c({ type: 'User', login: 'mallory' }, head('mallory'))], headSha: SHA }), '', 'a person cannot record themselves');
  assert.match(decide({ pr, comments: [c(PAT, head(''))], headSha: SHA, actor: 'dev-pat' }), /already/); // PAT: /user answers
  assert.equal(decide({ pr, comments: [c({ type: 'User', login: 'mallory' }, head(''))], headSha: SHA, actor: 'dev-pat' }), '');
  assert.equal(recordedLogin([c(APP, `quote\n${head('my-app[bot]')}`)]), null, 'the summary marker must open the comment');
  assert.equal(ours({ type: 'User', login: 'Dev-Pat' }, 'dev-pat'), true);
  assert.equal(ours({ type: 'User', login: 'github-actions[bot]' }), false);
  assert.match(decide({ pr, comments: [c({ type: 'Bot', login: 'github-actions[bot]' }, head(''))], headSha: SHA }), /already/); // GITHUB_TOKEN: no /user, no marker
  assert.match(decide({ pr, comments: [c({ type: 'Bot', login: 'github-actions[bot]' }, head('github-actions[bot]'))], headSha: SHA }), /already/);
  assert.equal(decide({ pr, comments: [c(APP, head('my-app[bot]'))], headSha: SHA, actor: 'github-actions[bot]' }), '', 'a known actor wins over a recorded login');
});
