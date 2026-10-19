'use strict';
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const run = (content, deny) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'leak-'));
  const f = path.join(dir, 'x.json');
  fs.writeFileSync(f, content);
  const env = { ...process.env };
  delete env.SPECGUARD_DENY_SHA256;
  if (deny) env.SPECGUARD_DENY_SHA256 = deny;
  return spawnSync(process.execPath, [path.join(__dirname, 'leak-check.js'), f], { encoding: 'utf8', env });
};
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const M = 'SPECGUARD-HONEY-'; // fixtures are assembled at runtime so this file never trips the check itself

test('honey marker: 15 hex passes, 16 fails, 17+ fails (a longer run still contains a full marker)', () => {
  assert.strictEqual(run(M + '0123456789abcde').status, 0);
  assert.strictEqual(run(M + '0123456789abcdef').status, 1);
  assert.strictEqual(run(M + '0123456789abcdef0').status, 1);
  assert.strictEqual(run(M + '0123456789abcdef' + '0123456789abcdef').status, 1);
});
test('local user paths fail', () => {
  for (const p of ['C:\\Users\\', 'C:/Users/', '/Users/', '/home/']) assert.strictEqual(run(p + 'alice' + p.slice(-1) + 'x').status, 1, p);
});
test('clean text and generic placeholder paths pass', () => {
  assert.strictEqual(run('SPECGUARD-HONEY- short, /home/runner/work and ' + '/home/user/x').status, 0);
});

// shaped like the #334 leak: an evidence JSON naming a private repo plus a code snippet from it. No marker, no path, no secret: only the denylist can catch it.
const evidence = JSON.stringify({ repo: 'Acme-Private/ledger-core', finding: { file: 'src/ledger.js', snippet: 'function settle(a){return a.balance-a.hold}' } }, null, 2);
test('denylist: leak-shaped evidence JSON passes without the hash, fails with it, and prints the hash not the token', () => {
  const h = sha('acme-private/ledger-core');
  assert.strictEqual(run(evidence).status, 0);
  assert.strictEqual(run(evidence, 'deadbeef').status, 0);
  const r = run(evidence, `deadbeef\n${h.toUpperCase()}`);
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, new RegExp(`:2: denylisted token sha256=${h}`));
  assert.ok(!/acme/i.test(r.stderr));
});
test('denylist: trailing punctuation does not hide a name', () => {
  assert.strictEqual(run('see ledger-core.', sha('ledger-core')).status, 1);
});
