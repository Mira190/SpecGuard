const test = require('node:test');
const assert = require('node:assert/strict');
const { slugify } = require('./slug.js');

test('lowercases and joins words with single hyphens', () => {
  assert.equal(slugify('Hello   World'), 'hello-world');
});

test('strips leading and trailing hyphens', () => {
  assert.equal(slugify('  --Hi!--  '), 'hi');
});

test('rejects non-string titles', () => {
  assert.throws(() => slugify(42), { name: 'TypeError', message: 'title must be a string' });
});
