const test = require('node:test');
const assert = require('node:assert/strict');
const { buildRequest, REQUEST_TIMEOUT_MS } = require('./client.js');

test('requests carry the timeout', () => {
  assert.equal(buildRequest('https://example.com').timeoutMs, REQUEST_TIMEOUT_MS);
});

test('the timeout is thirty seconds', () => {
  assert.equal(REQUEST_TIMEOUT_MS, 30000);
});

test('plain http is rejected', () => {
  assert.throws(() => buildRequest('http://example.com'));
});
