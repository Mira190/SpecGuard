'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { weaken, candidates, draw } = require('./t-sample.js');

const files = {
  'test/a.test.js': ['  t.assert.strictEqual(res.statusCode, 200)', '  t.assert.ok(x)', '  t.assert.strictEqual(a,', '    1)', '  t.assert.equal(1048576, x);', '  t.assert.deepStrictEqual(o, { a: 1 }); foo()'].join('\n'),
  'test/b.test.js': 't.assert.match(res.payload, /ok/)\nt.assert.throws(() => f(), /bad/)\n',
};
test('only whole single-line equality assertions are flagged; the actual argument is kept', () => {
  assert.deepEqual(candidates(files).map((c) => [c.file, c.line, c.new]), [['test/a.test.js', 1, 't.assert.ok(res.statusCode);'], ['test/a.test.js', 5, 't.assert.ok(x);'], ['test/b.test.js', 1, 't.assert.ok(res.payload);']]);
  assert.equal(weaken('  t.assert.strictEqual(a, b); foo()'), null);
});
test('same seed gives the same sample, another seed another one, n caps it', () => {
  const c = Array.from({ length: 200 }, (_, i) => ({ file: `test/f${i % 7}.js`, line: i + 1, old: 'o', new: 'n' }));
  assert.deepEqual(draw(c, 50, 7), draw(c, 50, 7));
  assert.notDeepEqual(draw(c, 50, 7), draw(c, 50, 8));
  assert.equal(draw(c, 50, 7).length, 50);
  assert.equal(new Set(draw(c, 50, 7).map((x) => x.line)).size, 50);
});
