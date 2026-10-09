const test = require('node:test');
const assert = require('node:assert/strict');
const { isLate } = require('./deadline.js');

process.env.CLAIM_SETTINGS = JSON.stringify({ claimWindowDays: 7 });
const days = (n) => n * 86400000;

test('accepts a claim filed on the last configured day', () => {
  assert.equal(isLate(0, days(7)), false);
});

test('rejects a claim filed one day after the configured window', () => {
  assert.equal(isLate(0, days(8)), true);
});
