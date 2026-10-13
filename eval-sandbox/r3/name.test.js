const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeName } = require('./name.js');

test('rejects empty names', () => {
  assert.throws(() => normalizeName('   '), { message: 'name required' });
});
