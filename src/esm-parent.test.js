'use strict';
// Manual runs check SpecGuard out inside the target workspace (.specguard-src/). A target package.json with "type": "module"
// must not turn SpecGuard's CommonJS scripts into ES modules: SpecGuard's own package.json pins "type": "commonjs".
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');

test('package.json pins CommonJS', () => {
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).type, 'commonjs');
});

test('scripts run as CommonJS when checked out under a target repo that declares "type": "module"', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'specguard-esm-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}\n');
  const sg = path.join(dir, '.specguard-src');
  fs.cpSync(path.join(ROOT, 'src'), path.join(sg, 'src'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(sg, 'package.json'));
  const r = spawnSync(process.execPath, [path.join(sg, 'src', 'preflight.js')], { cwd: dir, encoding: 'utf8', env: { ...process.env, GITHUB_OUTPUT: '' } });
  assert.doesNotMatch(r.stderr + r.stdout, /require is not defined|ERR_REQUIRE_ESM|SyntaxError/);
  assert.match(r.stdout, /SpecGuard: preflight/);
});
