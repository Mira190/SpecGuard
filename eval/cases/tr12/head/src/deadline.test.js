const test = require('node:test');
const assert = require('node:assert/strict');
const { isLate } = require('./deadline.js');

const days = (n) => n * 86400000;

test('accepts a claim filed on the incident day', () => {
  assert.equal(isLate(0, 0), false);
});

test('accepts a claim filed on the last day of the window', () => {
  assert.equal(isLate(0, days(45)), false);
});

test('rejects a claim filed one day after the window', () => {
  assert.equal(isLate(0, days(46)), true);
});
