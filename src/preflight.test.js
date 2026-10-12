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
