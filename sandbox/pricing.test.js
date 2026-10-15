const test = require('node:test');
const assert = require('node:assert');
const { applyDiscount } = require('./pricing');

test('works', () => {
  assert.ok(typeof applyDiscount(50, 'SAVE10') === 'number');
});
