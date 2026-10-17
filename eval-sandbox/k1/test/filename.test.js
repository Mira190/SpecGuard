const test = require('node:test');
const assert = require('node:assert');
const { isDirectChild } = require('../engine/filename.js');

test('isDirectChild accepts a file directly inside the folder', () => {
  assert.equal(isDirectChild('/m', '/m/a.mp4'), true);
});

test('isDirectChild rejects traversal, nested paths and a sibling with the same prefix', () => {
  assert.equal(isDirectChild('/m', '/m/../etc/passwd'), false);
  assert.equal(isDirectChild('/m', '/m/sub/a.mp4'), false);
  assert.equal(isDirectChild('/mx', '/m/a.mp4'), false);
});
