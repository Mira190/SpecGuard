const test = require('node:test');
const assert = require('node:assert/strict');
const { addTax } = require('./tax.js');

test('adds 20% tax', () => {
  assert.equal(addTax(50), Math.round(50 * 1.2 * 100) / 100);
});

test('rounds to cents', () => {
  assert.equal(addTax(0.07), 0.08);
});

test('rejects negative amounts', () => {
  assert.throws(() => addTax(-1), { name: 'RangeError', message: 'amount must not be negative' });
});
