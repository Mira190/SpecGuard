const test = require('node:test');
const assert = require('node:assert/strict');
const { calcPremium } = require('./premium.js');

test('charges base times risk factor below the cap', () => {
  assert.equal(calcPremium(100, 1.5), 150);
});

test('allows a premium of exactly the cap', () => {
  assert.equal(calcPremium(100, 3), 300);
});

test('limits the premium to the cap', () => {
  assert.equal(calcPremium(100, 6), 300);
});
