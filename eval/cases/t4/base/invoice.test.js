const test = require('node:test');
const assert = require('node:assert/strict');
const { total } = require('./invoice.js');

test('sums line totals', () => {
  assert.equal(total([{ price: 2, qty: 3 }, { price: 1, qty: 1 }]), 7);
});

test('an empty invoice totals zero', () => {
  assert.equal(total([]), 0);
});
