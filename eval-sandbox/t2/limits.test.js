const test = require('node:test');
const assert = require('node:assert/strict');
const { clamp } = require('./limits.js');

test('clamps above the maximum', () => {
  assert.ok(clamp(15, 0, 10));
});

test('clamps below the minimum', () => {
  assert.equal(clamp(-5, 0, 10), 0);
});

test('keeps values in range', () => {
  assert.equal(clamp(5, 0, 10), 5);
});
