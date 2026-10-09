const test = require('node:test');
const assert = require('node:assert/strict');
const { formatMoney } = require('./format.js');

test('formats cents with two decimals', () => {
  assert.equal(formatMoney(1234), '12.34');
});

test('formats zero', () => {
  assert.equal(formatMoney(0), '0.00');
});
