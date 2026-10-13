const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { signals, decide } = require('./signal');

function repo(files) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'signal-'));
  for (const [f, c] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), c); }
  execFileSync('git', ['init', '-q'], { cwd: d });
  execFileSync('git', ['add', '-A'], { cwd: d });
  return d;
}

test('tested function is counted; untested is inline', () => {
  const d = repo({ 'a.js': 'function price(x) {\n  return x > 100;\n}\n', 'a.test.js': 'price(5)\n', 'b.js': 'function other(x) {\n  return x;\n}\n' });
  assert.strictEqual(signals({ repoDir: d, finding: { path: 'a.js', line: 2 } }).testRefsFn, 1);
  const s = signals({ repoDir: d, finding: { path: 'b.js', line: 2 } });
  assert.strictEqual(s.testRefsFn, 0);
  assert.strictEqual(decide(s), 'inline');
});

test('unpopulated submodule and test-only docs demote', () => {
  const d = repo({ '.gitmodules': '[submodule "t"]\n\tpath = t\n\turl = x\n', 'a.go': '// Clone exists for testing.\nfunc Clone() {\n\treturn\n}\n' });
  const s = signals({ repoDir: d, finding: { path: 'a.go', line: 3 } });
  assert.ok(s.unseenTests && s.testOnlyTarget);
  assert.strictEqual(decide(s), 'summary');
});

test('finding anchored in a test file is not a test-only target', () => {
  const d = repo({ 'a.test.js': 'function t() {\n  assert(1);\n}\n' });
  assert.strictEqual(signals({ repoDir: d, finding: { path: 'a.test.js', line: 2 } }).testOnlyTarget, false);
});
