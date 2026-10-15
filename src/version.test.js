const test = require('node:test');
const assert = require('node:assert/strict');
const { version, versionLine } = require('./version');

test('version (review F12): a stable 12-hex build id of the shipped files, the workflow ref when it is a plain ref, and one line for Details', () => {
  const a = version({ SPECGUARD_REF: 'main' }), b = version({ SPECGUARD_REF: '0123abc' });
  assert.match(a.build, /^[0-9a-f]{12}$/);
  assert.equal(a.build, b.build, 'the build does not depend on the ref');
  assert.deepEqual([a.ref, b.ref, version({}).ref, version({ SPECGUARD_REF: 'x y; rm' }).ref], ['main', '0123abc', '', '']);
  assert.equal(versionLine({ ref: 'v1', build: 'abcdefabcdef' }), 'SpecGuard build abcdefabcdef (ref v1)');
  assert.equal(versionLine({ ref: '', build: 'abcdefabcdef' }), 'SpecGuard build abcdefabcdef');
});
