const test = require('node:test');
const assert = require('node:assert/strict');
const { decide, sticky } = require('./preflight');

const SHA = 'a'.repeat(40);
const pr = (o = {}) => ({ state: 'open', user: { login: 'alice', type: 'User' }, ...o });
const mine = (sha = SHA) => ({ user: { type: 'Bot' }, body: `<!-- specguard:summary -->\n<!-- specguard:head=${sha} -->\n## SpecGuard\n` });

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
  assert.equal(sticky({ user: { type: 'Bot' }, body: `quote ${mine().body}` }, SHA), false);
  assert.equal(sticky({ user: { type: 'Bot' }, body: '<!-- specguard:summary -->\n## SpecGuard\n' }, SHA), false); // old summary: no head marker
  assert.equal(sticky(mine(), SHA), true);
});
