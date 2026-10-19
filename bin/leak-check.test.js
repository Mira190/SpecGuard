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
  assert.strictEqual(hook(`refs/heads/x ${head} refs/heads/x ${'1'.repeat(40)}\n`).status, 1); // unknown remote sha (force push): still scanned, never fails open
  assert.strictEqual(hook(`(delete) 0000000000000000000000000000000000000000 refs/heads/x ${head}\n`).status, 0); // ref deletion: nothing to scan
  fs.writeFileSync(path.join(w, '.git', 'specguard-deny'), sha('secretproj') + '\n');
  assert.match(hook(`refs/heads/main ${head} refs/heads/main ${base}\n`).stderr, /a\.txt:2: denylisted token/);
});

test('denylist: runs of 3 parts match (joined with - or _), 4 parts do not', () => {
  assert.strictEqual(run('x/alpha-beta-gamma/y', sha('alpha_beta_gamma')).status, 1); // '_' join of a '-' split
  assert.strictEqual(run('x/alpha_beta_gamma/y', sha('alpha-beta-gamma')).status, 1); // '-' join of a '_' split
  assert.strictEqual(run('x/alpha-beta-gamma-delta/y', sha('alpha-beta-gamma-delta')).status, 0);
});

test('denylist: camelCase names hit, kebab pieces that merely concatenate do not', () => {
  assert.strictEqual(run('const secretProjApi = 1', sha('secretproj')).status, 1);
  assert.strictEqual(run('SecretProjInternal', sha('secretproj')).status, 1);
  assert.strictEqual(run('my-secret-proj and Secretprojects', sha('secretproj')).status, 0);
});

const tmpRepo = () => {
  const w = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-'));
  git(w, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(w, 'a.txt'), 'ok\n');
  git(w, 'add', 'a.txt');
  git(w, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'base');
  return w;
};
test('deny file in the main .git is visible from a linked worktree', () => {
  const w = tmpRepo();
  const wt = path.join(w, '..', path.basename(w) + '-linked');
  git(w, 'worktree', 'add', '-q', '-b', 'b', wt);
  fs.writeFileSync(path.join(w, '.git', 'specguard-deny'), sha('secretproj') + '\n');
  fs.writeFileSync(path.join(wt, 'x.txt'), 'see secretproj-api\n');
  const env = { ...process.env };
  delete env.SPECGUARD_DENY_SHA256;
  const r = spawnSync(process.execPath, [path.join(__dirname, 'leak-check.js'), 'x.txt'], { cwd: wt, encoding: 'utf8', env });
  assert.strictEqual(r.status, 1, r.stderr);
});
test('--stdin warns on stderr when the denylist is empty (and still passes), not when it is set', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'nodeny-'));
  const go = (deny) => {
    const env = { ...process.env };
    delete env.SPECGUARD_DENY_SHA256;
    if (deny) env.SPECGUARD_DENY_SHA256 = deny;
    return spawnSync(process.execPath, [path.join(__dirname, 'leak-check.js'), '--stdin'], { cwd: d, input: '', encoding: 'utf8', env });
  };
  const a = go();
  assert.strictEqual(a.status, 0);
  assert.match(a.stderr, /denylist empty: private-name check skipped/);
  assert.doesNotMatch(go(sha('x')).stderr, /denylist empty/);
});
test('pre-push hook scans content added while resolving a merge conflict', () => {
  const w = tmpRepo();
  const c = (m) => git(w, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qam', m);
  const base = git(w, 'rev-parse', 'HEAD').stdout.trim();
  git(w, 'checkout', '-q', '-b', 'side');
  fs.writeFileSync(path.join(w, 'a.txt'), 'side\n'); c('side');
  git(w, 'checkout', '-q', 'main');
  fs.writeFileSync(path.join(w, 'a.txt'), 'main\n'); c('main');
  git(w, '-c', 'user.name=t', '-c', 'user.email=t@t', 'merge', 'side');
  fs.writeFileSync(path.join(w, 'a.txt'), `${M}0123456789abcdef\n`);
  git(w, 'add', 'a.txt'); c('resolve');
  const head = git(w, 'rev-parse', 'HEAD').stdout.trim();
  fs.cpSync(path.join(__dirname, '..', 'bin'), path.join(w, 'bin'), { recursive: true });
  const env = { ...process.env };
  delete env.SPECGUARD_DENY_SHA256;
  const r = spawnSync('sh', [path.join(__dirname, '..', '.githooks', 'pre-push')], { cwd: w, input: `refs/heads/main ${head} refs/heads/main ${base}\n`, encoding: 'utf8', env });
  assert.strictEqual(r.status, 1, r.stderr);
  assert.match(r.stderr, /a\.txt:\d+: honey marker/);
});

const { scanDiff, denyList } = require('./leak-check');
test('scanDiff: header vs content, "++" content lines, line numbers per file from @@', () => {
  assert.deepStrictEqual(scanDiff(`+++ b/a.txt\n@@ -0,0 +1 @@\n+${M}0123456789abcdef\n`, new Set()), ['a.txt:1: honey marker']);
  const d = `diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1,2 @@\n+ok\n++${M}0123456789abcdef\n` +
    `diff --git a/b.txt b/b.txt\n--- a/b.txt\n+++ b/b.txt\n@@ -4,0 +5 @@\n+${M}fedcba9876543210\n-${M}0000000000000000\n`;
  assert.deepStrictEqual(scanDiff(d, new Set()), ['a.txt:2: honey marker', 'b.txt:5: honey marker']);
  assert.deepStrictEqual(scanDiff('diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n+++ b/evil\n+clean\n', new Set()), []);
});
test('scanDiff: combined diff reports ++ content lines, not single-parent + or - lines', () => {
  assert.deepStrictEqual(scanDiff(`diff --cc a.txt\n--- a/a.txt\n+++ b/a.txt\n@@@ -1 -1 +1 @@@\n++${M}0123456789abcdef\n`, new Set()), ['a.txt:1: honey marker']);
  assert.deepStrictEqual(scanDiff(`diff --cc a.txt\n--- a/a.txt\n+++ b/a.txt\n@@@ -1 -1 +1,2 @@@\n +${M}0123456789abcdef\n+ ${M}0123456789abcdef\n--${M}0123456789abcdef\n`, new Set()), []);
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
