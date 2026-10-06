const test = require('node:test');
const assert = require('node:assert/strict');
const { findUser } = require('./users.js');

test('returns a known user', () => {
  assert.deepEqual(findUser(1), { id: 1, name: 'Ada' });
});
