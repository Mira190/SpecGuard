const test = require('node:test');
const assert = require('node:assert/strict');
const { check } = require('./superseded');

const A = 'a'.repeat(40), B = 'b'.repeat(40);
const run = (pr) => check({ repo: 'o/r', pr: 7, headSha: A, gh: (args) => { assert.deepEqual(args, ['api', 'repos/o/r/pulls/7']); return pr; } });

test('same head on an open PR is not superseded', () => assert.deepEqual(run({ state: 'open', head: { sha: A } }), { superseded: false }));
test('a different live head is superseded', () => assert.equal(run({ state: 'open', head: { sha: B } }).superseded, true));
test('a closed PR is superseded', () => assert.equal(run({ state: 'closed', head: { sha: A } }).superseded, true));
test('an API error fails open with a warning', () => {
  const r = check({ repo: 'o/r', pr: 7, headSha: A, gh: () => { throw new Error('boom\nmore'); } });
  assert.equal(r.superseded, false);
  assert.match(r.warning, /boom/);
});
test('a PR without a readable head sha fails open', () => assert.equal(run({ state: 'open' }).superseded, false));
