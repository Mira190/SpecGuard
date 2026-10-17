const test = require('node:test');
const assert = require('node:assert/strict');
const { ageOnDate, canRegister } = require('./signup.js');

test('a child cannot register', () => {
  assert.equal(canRegister(10), false);
});

test('an adult can register', () => {
  assert.equal(canRegister(30), true);
});

test('age is reduced before the birthday', () => {
  assert.equal(ageOnDate(new Date(2000, 5, 15), new Date(2020, 5, 14)), 19);
});
