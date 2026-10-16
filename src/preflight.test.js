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

test('re-review when a linked issue the model read changed (review F10): same head and PR text skip only while every recorded issue is unchanged; unreadable reviews', () => {
  const { buildSummary } = require('./post');
  const p = pr({ title: 'T', body: 'Fixes #12' });
  const c = [{ user: { type: 'Bot', login: 'github-actions[bot]' }, body: buildSummary({ status: 'R', state: 'complete', headSha: SHA, req: reqKey(p), issues: ['o/r#12@2026-10-15T08:00:00Z'] }) }];
  const at = (v) => (repo, n) => { assert.deepEqual([repo, n], ['o/r', 12]); if (v instanceof Error) throw v; return v; };
  assert.match(decide({ pr: p, comments: c, headSha: SHA, issueAt: at('2026-10-15T08:00:00Z') }), /already/);
  assert.equal(decide({ pr: p, comments: c, headSha: SHA, issueAt: at('2026-10-15T09:30:00Z') }), '', 'the issue was edited or commented on');
  assert.equal(decide({ pr: p, comments: c, headSha: SHA, issueAt: at(new Error('404')) }), '', 'unreadable: fail open, review');
  const none = [{ ...c[0], body: buildSummary({ status: 'R', state: 'complete', headSha: SHA, req: reqKey(p) }) }];
  assert.match(decide({ pr: p, comments: none, headSha: SHA, issueAt: () => { throw new Error('never called'); } }), /already/, 'no issue read: nothing to check');
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

// S13: the skip key must cover what the review used (SpecGuard build + review inputs), not only the head SHA
test('a rerun on the same head is skipped only when the config marker matches', () => {
  const { cfgKey } = require('./preflight');
  const cfg = cfgKey('copilot|gpt-5|||');
  const withCfg = (k) => ({ ...mine(), body: mine().body.replace('## SpecGuard', `<!-- specguard:cfg=${k} -->\n## SpecGuard`) });
  assert.match(decide({ pr: pr(), comments: [withCfg(cfg)], headSha: SHA, cfg }), /already/, 'same everything: skip');
  assert.equal(decide({ pr: pr(), comments: [withCfg(cfg)], headSha: SHA, cfg: cfgKey('copilot|other-model|||') }), '', 'changed model: review');
  assert.equal(decide({ pr: pr(), comments: [withCfg(cfg)], headSha: SHA, cfg: cfgKey('copilot|gpt-5|||' + '|base2') }), '', 'same head, different base: review');
  assert.equal(decide({ pr: pr(), comments: [mine()], headSha: SHA, cfg }), '', 'summary without a cfg marker (older version): review once');
  assert.match(decide({ pr: pr(), comments: [mine()], headSha: SHA }), /already/, 'no CFG in the env: not checked');
});

test('post.js writes the cfg marker that preflight computes from the same CFG', () => {
  const { buildSummary } = require('./post');
  const { cfgKey } = require('./preflight');
  const cfg = cfgKey('claude|opus|||');
  assert.match(buildSummary({ headSha: SHA, req: 'abc123', cfg, state: 'complete' }), new RegExp(`<!-- specguard:cfg=${cfg} -->`));
});
