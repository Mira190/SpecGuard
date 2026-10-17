const test = require('node:test');
const assert = require('node:assert/strict');
const { buildRequest, TIMEOUT } = require('./client.js');

test('requests carry the timeout', () => {
  assert.equal(buildRequest('https://example.com').timeoutMs, TIMEOUT);
});

test('the timeout is thirty seconds', () => {
  assert.equal(TIMEOUT, 30000);
});

test('plain http is rejected', () => {
  assert.throws(() => buildRequest('http://example.com'));
});
