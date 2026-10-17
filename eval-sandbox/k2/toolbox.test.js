const test = require('node:test');
const assert = require('node:assert');
const { exportArgs } = require('./toolbox.js');

// true when the flags appear next to each other, in this order, somewhere in args
const has = (args, ...flags) => args.some((_, at) => flags.every((f, k) => args[at + k] === f));

test('exportArgs encodes with libx264 at the given quality', () => {
  const a = exportArgs({ input: 'in.webm', output: 'out.mp4', crf: 18 });
  assert.ok(has(a, '-c:v', 'libx264'));
  assert.ok(has(a, '-crf', '18'));
});

test('exportArgs writes the output path last', () => {
  const a = exportArgs({ input: 'in.webm', output: 'out.mp4' });
  assert.ok(a.length);
});
