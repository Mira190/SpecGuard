const test = require('node:test');
const assert = require('node:assert/strict');
const { shippingCost } = require('./shipping.js');

test('small orders pay the flat rate', () => {
  assert.equal(shippingCost({ subtotal: 40 }), 12);
});

test('very large orders ship free', () => {
  assert.equal(shippingCost({ subtotal: 2000 }), 0);
});

test('an order without a subtotal is rejected', () => {
  assert.throws(() => shippingCost({}));
});
