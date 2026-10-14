const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { decide } = require('./visibility-guard.js');

test('decide: private or internal target needs a non-public control repository; public target is always allowed; unknown fails closed', () => {
  assert.equal(decide('public', 'public').ok, true);
  assert.equal(decide('private', 'public').ok, true);
  assert.equal(decide('private', 'private').ok, true);
  assert.equal(decide('internal', 'internal').ok, true);
  assert.equal(decide('public', 'private').ok, false);
  assert.equal(decide('public', 'internal').ok, false);
  assert.match(decide('public', 'private').reason, /private or internal control repository/);
  for (const bad of ['', undefined, 'weird']) {
    assert.equal(decide(bad, 'public').ok, false);
    assert.equal(decide('private', bad).ok, false);
    assert.equal(decide('public', bad).ok, false);
  }
});

test('specguard-run.yml: the visibility guard runs in the resolve job, before the review job checks the target out', () => {
  const y = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'specguard-run.yml'), 'utf8').replace(/\r\n/g, '\n');
  const g = y.indexOf('node src/visibility-guard.js');
  assert.ok(g > y.indexOf('node src/resolve-inputs.js'), 'after the target is resolved');
  assert.ok(g < y.indexOf('\n  review:'), 'in the resolve job');
  assert.ok(g < y.indexOf('repository: ${{ needs.resolve.outputs.repo }}'), 'before the target checkout');
  assert.match(y, /CONTROL_REPO: \$\{\{ github\.repository \}\}/);
  assert.match(y, /TARGET_REPO: \$\{\{ steps\.in\.outputs\.repo \}\}/);
});

// The script end to end with `gh` replaced: a repository the token cannot read (403/404 makes gh exit non-zero) must block the run.
test('main: a target the token cannot read, or a gh failure on the control repo, exits 1 with the reason; readable private -> private exits 0', () => {
  const os = require('node:os'), { spawnSync } = require('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'specguard-vis-')), shim = path.join(dir, 'gh-shim.js');
  fs.writeFileSync(shim, `const cp = require('node:child_process'), orig = cp.execFileSync, vis = JSON.parse(process.env.SG_VIS);
cp.execFileSync = function (file, args) {
  if (file !== 'gh') return orig.apply(this, arguments);
  const v = vis[args[1].slice('repos/'.length)];
  if (!v) throw new Error('gh: HTTP 404: Not Found');
  return v;
};
`);
  const run = (vis) => spawnSync(process.execPath, ['-r', shim, path.join(__dirname, 'visibility-guard.js')], { encoding: 'utf8', env: { ...process.env, SG_VIS: JSON.stringify(vis), CONTROL_REPO: 'me/control', TARGET_REPO: 'corp/app', CONTROL_TOKEN: 'c', TARGET_TOKEN: 't' } });
  try {
    const unread = run({ 'me/control': 'private' });
    assert.equal(unread.status, 1, unread.stderr);
    assert.equal(unread.stderr, '');
    assert.match(unread.stdout, /^::error::cannot determine the visibility of the target repository \(no answer\); the token may not reach it/);
    const noControl = run({ 'corp/app': 'public' });
    assert.equal(noControl.status, 1);
    assert.match(noControl.stdout, /cannot determine the visibility of the control repository/);
    const leak = run({ 'me/control': 'public', 'corp/app': 'private' });
    assert.equal(leak.status, 1);
    assert.match(leak.stdout, /Run SpecGuard from a private or internal control repository/);
    const ok = run({ 'me/control': 'private', 'corp/app': 'private' });
    assert.equal(ok.status, 0, ok.stdout + ok.stderr);
    assert.equal(ok.stdout, '');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
