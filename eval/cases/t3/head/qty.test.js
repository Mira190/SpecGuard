const test = require('node:test');
const assert = require('node:assert/strict');
const { parseQty } = require('./qty.js');

test('parses a positive integer', () => {
  assert.equal(parseQty('3'), 3);
});

test.skip('rejects negative quantities', () => {
  assert.throws(() => parseQty('-2'), RangeError);
});

test('rejects fractions', () => {
  assert.throws(() => parseQty('1.5'), RangeError);
});
