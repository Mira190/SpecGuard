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

const lines = ['see secretproj here', '(secretproj)', 'github.com/acme/secretproj/blob/x.js', 'secretproj-api', 'SecretProj_internal', 'github.com/acme/ledger-core/blob/x.js'];
test('denylist: a name inside a URL, kebab or snake token, or a hyphenated name inside a URL, still hits', () => {
  for (const [l, name] of [...lines.slice(0, 5).map((l) => [l, 'secretproj']), [lines[5], 'ledger-core']]) {
    const r = run(l, sha(name));
    assert.strictEqual(r.status, 1, l);
    assert.ok(!/secretproj|ledger/i.test(r.stderr));
  }
  assert.strictEqual(run('secretprojects and my-secret-proj', sha('secretproj')).status, 0);
});

// hook: add-then-delete across two commits must be blocked, scanning added lines of the pushed range only
const git = (cwd, ...a) => spawnSync('git', a, { cwd, encoding: 'utf8' });
test('pre-push hook blocks a leak added in one commit and deleted in the next; .git/specguard-deny feeds the denylist', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-'));
  const [bare, w] = [path.join(d, 'r.git'), path.join(d, 'w')];
  git(d, 'init', '-q', '--bare', bare);
  git(d, 'init', '-q', w);
  git(w, 'remote', 'add', 'origin', bare);
  const commit = (m) => git(w, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qam', m);
  fs.writeFileSync(path.join(w, 'a.txt'), 'ok\n');
  git(w, 'add', 'a.txt'); commit('base');
  git(w, 'push', '-q', 'origin', 'HEAD:refs/heads/main');
  const base = git(w, 'rev-parse', 'HEAD').stdout.trim();
  fs.writeFileSync(path.join(w, 'a.txt'), `${M}0123456789abcdef\nsee secretproj-api\n`); commit('leak');
  fs.writeFileSync(path.join(w, 'a.txt'), 'ok\n'); commit('delete');
  const head = git(w, 'rev-parse', 'HEAD').stdout.trim();
  fs.cpSync(path.join(__dirname, '..', 'bin'), path.join(w, 'bin'), { recursive: true });
  const hook = (stdin) => {
    const env = { ...process.env };
    delete env.SPECGUARD_DENY_SHA256;
    env.PATH = env.PATH.split(path.delimiter).filter((p) => !fs.existsSync(path.join(p, 'gitleaks')) && !fs.existsSync(path.join(p, 'gitleaks.exe'))).join(path.delimiter); // gitleaks not installed
    return spawnSync('sh', [path.join(__dirname, '..', '.githooks', 'pre-push')], { cwd: w, input: stdin, encoding: 'utf8', env });
  };
  const r = hook(`refs/heads/x ${head} refs/heads/x 0000000000000000000000000000000000000000\n`);
  assert.strictEqual(r.status, 1, r.stderr);
  assert.match(r.stderr, /a\.txt:1: honey marker/);
  assert.match(r.stderr, /gitleaks not installed/); // leak-check still ran and blocked without gitleaks
  const clean = hook(`refs/heads/main ${base} refs/heads/main ${base}\n`); // empty range
  assert.strictEqual(clean.status, 0, clean.stderr);
  assert.match(clean.stderr, /gitleaks not installed/);
  fs.writeFileSync(path.join(w, '.git', 'specguard-deny'), sha('secretproj') + '\n');
  assert.match(hook(`refs/heads/main ${head} refs/heads/main ${base}\n`).stderr, /a\.txt:2: denylisted token/);
});

const { scanDiff, denyList } = require('./leak-check');
test('scanDiff: header vs content, "++" content lines, line numbers per file from @@', () => {
  assert.deepStrictEqual(scanDiff(`+++ b/a.txt\n@@ -0,0 +1 @@\n+${M}0123456789abcdef\n`, new Set()), ['a.txt:1: honey marker']);
  const d = `diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1,2 @@\n+ok\n++${M}0123456789abcdef\n` +
    `diff --git a/b.txt b/b.txt\n--- a/b.txt\n+++ b/b.txt\n@@ -4,0 +5 @@\n+${M}fedcba9876543210\n-${M}0000000000000000\n`;
  assert.deepStrictEqual(scanDiff(d, new Set()), ['a.txt:2: honey marker', 'b.txt:5: honey marker']);
  assert.deepStrictEqual(scanDiff('diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n+++ b/evil\n+clean\n', new Set()), []);
});
test('denyList: env and the per-clone git-path file combine, case-insensitive; a missing file is fine', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'deny-')), 'specguard-deny');
  fs.writeFileSync(f, sha('b').toUpperCase() + '\n\n' + sha('c') + '\n');
  const got = [...denyList({ SPECGUARD_DENY_SHA256: sha('a').toUpperCase() + ',' + sha('d') }, () => f)].sort();
  assert.deepStrictEqual(got, ['a', 'b', 'c', 'd'].map(sha).sort());
  assert.deepStrictEqual([...denyList({}, () => { throw new Error('no repo'); })], []);
});
test('gitleaks workflow: push on every branch, pull_request and workflow_dispatch kept', () => {
  const y = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'gitleaks.yml'), 'utf8');
  assert.match(y, /^\s*push:\s*\{[^}]*'\*\*'/m);
  assert.match(y, /^\s*pull_request:/m);
  assert.match(y, /^\s*workflow_dispatch:/m);
});
