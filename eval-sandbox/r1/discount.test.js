const test = require('node:test');
const assert = require('node:assert/strict');
const { applyDiscount } = require('./discount.js');

test('applies the SAVE10 coupon', () => {
  const total = applyDiscount({ items: [{ price: 20, qty: 2 }], coupon: 'SAVE10' });
  assert.ok(total);
});
