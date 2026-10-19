const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { assign, armOf } = require('./assign');

test('assign: PR number mod 3 -> 0 SpecGuard only, 1 Copilot only, 2 both', () => {
  assert.deepEqual(assign(3), { arm: 0, specguard: true, copilot: false });
  assert.deepEqual(assign(4), { arm: 1, specguard: false, copilot: true });
  assert.deepEqual(assign(5), { arm: 2, specguard: true, copilot: true });
  assert.equal(assign(1000).arm, 1);
  for (const bad of [0, -1, 1.5, NaN, '7']) assert.throws(() => assign(bad));
});

test('armOf reads the review-arm label (names or label objects)', () => {
  assert.equal(armOf([{ name: 'bug' }, { name: 'review-arm:2' }]), 2);
  assert.equal(armOf(['review-arm:0']), 0);
  assert.equal(armOf([{ name: 'review-arm:3' }, 'x']), null);
});

test('unsalted assign is PR number % 3 for 1..300 (backward compatible)', () => {
  for (let n = 1; n <= 300; n++) assert.equal(assign(n, '').arm, n % 3);
});

test('salted assign: HMAC-SHA256 first 4 bytes mod 3, differs from n % 3, roughly uniform over 1..3000', () => {
  assert.equal(assign(7, 's3cret').arm, require('node:crypto').createHmac('sha256', 's3cret').update('7').digest().readUInt32BE(0) % 3);
  let diff = 0; const c = [0, 0, 0];
  for (let n = 1; n <= 3000; n++) { const a = assign(n, 's3cret').arm; c[a]++; if (a !== n % 3) diff++; }
  console.log('salted arm counts over 1..3000:', c.join(' '));
  for (const k of c) assert.ok(k > 700 && k < 1300, `arm count ${k}`);
  assert.ok(diff > 1500, 'not the PR number mod 3');
});

test('the example workflow computes the same arm as assign() for 1..30 with two salts, and fails without a salt', () => {
  const yml = fs.readFileSync(path.join(__dirname, '..', 'docs', 'validation-workflow.example.yml'), 'utf8').replace(/\r\n/g, '\n'); // a Windows checkout may have CRLF
  const m = /# BEGIN arm\n([\s\S]*?)\n\s*# END arm/.exec(yml);
  assert.ok(m, 'BEGIN/END arm markers');
  const script = m[1].split('\n').map((l) => l.replace(/^ {10}/, '')).join('\n');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arm-'));
  const run = (n, salt) => spawnSync('sh', ['-c', script], { env: { ...process.env, SPECGUARD_ARM_SALT: salt, PR_NUMBER: String(n), GITHUB_OUTPUT: path.join(dir, `o${n}`).split(path.sep).join('/') }, encoding: 'utf8' });
  const none = run(1, '');
  assert.notEqual(none.status, 0, 'no salt: the arm job must fail');
  assert.match(none.stdout + none.stderr, /SPECGUARD_ARM_SALT is not set/);
  let hit = 0;
  for (const salt of ['s3cret', 'another salt']) for (let n = 1; n <= 30; n++) {
    const r = run(n, salt);
    assert.equal(r.status, 0, r.stderr);
    const o = Object.fromEntries(fs.readFileSync(path.join(dir, `o${n}`), 'utf8').trim().split('\n').map((l) => l.split('=')));
    const a = assign(n, salt);
    assert.deepEqual({ arm: +o.arm, specguard: o.specguard === 'true', copilot: o.copilot === 'true' }, a, `PR ${n} salt ${salt}`);
    if (a.arm !== n % 3) hit++;
    fs.rmSync(path.join(dir, `o${n}`));
  }
  assert.ok(hit > 10, 'the salted arm is not n % 3');
});
