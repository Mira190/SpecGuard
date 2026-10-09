const test = require('node:test');
const assert = require('node:assert/strict');
const { newState, recordFailure, recordSuccess, passwordLongEnough } = require('./lockout.js');

test('a single failure does not lock the account', () => {
  assert.equal(recordFailure(newState()).locked, false);
});

test('many failures in a row lock the account', () => {
  let state = newState();
  for (let i = 0; i < 20; i++) state = recordFailure(state);
  assert.equal(state.locked, true);
});

test('a success resets the failure count', () => {
  const state = recordSuccess({ failures: 2, locked: false });
  assert.equal(state.failures, 0);
});

test('short passwords are rejected', () => {
  assert.equal(passwordLongEnough('short'), false);
  assert.equal(passwordLongEnough('long enough pass'), true);
});
