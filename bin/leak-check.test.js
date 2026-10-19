'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const run = (content) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'leak-'));
  const f = path.join(dir, 'x.md');
  fs.writeFileSync(f, content);
  return spawnSync(process.execPath, [path.join(__dirname, 'leak-check.js'), f], { encoding: 'utf8' });
};

// fixtures are assembled at runtime so this file never trips the check itself
test('honey marker fails', () => {
  assert.strictEqual(run('see ' + 'SPECGUARD-HONEY-' + '0123456789abcdef').status, 1);
});
test('local user paths fail', () => {
  for (const p of ['C:\\Users\\', 'C:/Users/', '/Users/', '/home/']) assert.strictEqual(run(p + 'alice' + p.slice(-1) + 'x').status, 1, p);
});
test('clean text and generic placeholder paths pass', () => {
  assert.strictEqual(run('SPECGUARD-HONEY- short, /home/runner/work and ' + '/home/user/x').status, 0);
});
