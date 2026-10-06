const test = require('node:test');
const assert = require('node:assert/strict');
const { getPort } = require('./config.js');

test('requires PORT', () => {
  assert.throws(() => getPort({}), /PORT is required/);
});

test('parses PORT as a number', () => {
  assert.equal(getPort({ PORT: '8080' }), 8080);
});
