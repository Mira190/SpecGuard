const test = require('node:test');
const assert = require('node:assert/strict');
const { check } = require('./superseded');

const A = 'a'.repeat(40), B = 'b'.repeat(40);
const run = (pr) => check({ repo: 'o/r', pr: 7, headSha: A, gh: (args) => { assert.deepEqual(args, ['api', 'repos/o/r/pulls/7']); return pr; } });

test('same head on an open PR is not superseded', () => assert.deepEqual(run({ state: 'open', head: { sha: A } }), { superseded: false }));
test('a different live head is superseded', () => assert.equal(run({ state: 'open', head: { sha: B } }).superseded, true));
test('a closed PR is superseded', () => assert.equal(run({ state: 'closed', head: { sha: A } }).superseded, true));
test('an API error fails open with a warning', () => {
  const r = check({ repo: 'o/r', pr: 7, headSha: A, gh: () => { throw new Error('boom\nmore'); } });
  assert.equal(r.superseded, false);
  assert.match(r.warning, /boom/);
});
test('a PR without a readable head sha fails open', () => assert.equal(run({ state: 'open' }).superseded, false));

// The CLI entry point against a fake `gh`: a copy of the node binary named gh, which a --require preload (active only in that copy) turns into a canned `gh api` answer. Portable: execFileSync('gh') finds gh.exe on Windows, gh elsewhere.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
function cli(t, pr) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'specguard-superseded-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const gh = path.join(dir, process.platform === 'win32' ? 'gh.exe' : 'gh'), preload = path.join(dir, 'preload.js');
  fs.copyFileSync(process.execPath, gh);
  fs.writeFileSync(preload, `if (/^gh(\.exe)?$/.test(require('node:path').basename(process.execPath))) { console.log(process.env.FAKE_PR); process.exit(0); }
`);
  const summary = path.join(dir, 'summary.md'), output = path.join(dir, 'output.txt');
  const r = spawnSync(process.execPath, [path.join(__dirname, 'superseded.js')], { encoding: 'utf8', env: { ...process.env, PATH: dir + path.delimiter + process.env.PATH, GH_REPO: 'o/r', PR_NUMBER: '7', HEAD_SHA: A, GITHUB_STEP_SUMMARY: summary, GITHUB_OUTPUT: output, FAKE_PR: JSON.stringify(pr), NODE_OPTIONS: `--require=${preload.split(path.sep).join('/')}` } });
  assert.equal(r.status, 0, r.stderr);
  const read = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '');
  return { summary: read(summary), output: read(output) };
}

test('CLI: a superseded PR writes the skip line to the job summary and superseded=true', (t) => {
  for (const pr of [{ state: 'open', head: { sha: B } }, { state: 'closed', head: { sha: A } }]) {
    const r = cli(t, pr);
    assert.equal(r.summary, 'Skipped: a newer commit was pushed while collecting context (no AI credits spent).\n');
    assert.equal(r.output, 'superseded=true\n');
  }
});

test('CLI: a current open PR writes no summary line and superseded=false', (t) => {
  const r = cli(t, { state: 'open', head: { sha: A } });
  assert.equal(r.summary, '');
  assert.equal(r.output, 'superseded=false\n');
});
