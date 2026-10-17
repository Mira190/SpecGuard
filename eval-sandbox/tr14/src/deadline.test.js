const test = require('node:test');
const assert = require('node:assert/strict');
const { isLate } = require('./deadline.js');

test('rejects a claim 60 days old', () => {
  assert.equal(isLate(60 * 864e5), true);
});
