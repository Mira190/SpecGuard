// Fixture test for testgap-confirm-build.js: a tiny temp git repo and a hand-written mine JSON, no real mine, no gh (the 40-qualifying draw that calls gh is never reached).
// The builder at 194f785 (before --queues-only) is the reference: flag off must give the same counts and status; flag on must add only `unfiltered`, `blamedBy`-style fields and unfiltered_* counters.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPLAY = __dirname, BUILD = path.join(REPLAY, 'testgap-confirm-build.js'), BASE_SHA = '194f785';
const sh = (cwd, ...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...a], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const fn = (name, tag) => `function ${name}() {\n${Array.from({ length: 36 }, (_, i) => `  const v${i} = ${i}${tag};`).join('\n')}\n  return 0;\n}\n`; // 38 lines

function fixture(dir) {
  const repo = path.join(dir, 'repos', 'demo'); fs.mkdirSync(repo, { recursive: true });
  sh(repo, 'init', '-q');
  const commit = (msg) => { sh(repo, 'add', '-A'); sh(repo, 'commit', '-q', '-m', msg); return sh(repo, 'rev-parse', 'HEAD'); };
  fs.writeFileSync(path.join(repo, 'README'), 'x\n'); commit('init');
  const out = {};
  // pair 1: fix adds a test naming `foo` (qualifies). pair 2: fix adds a test that names nothing changed (fails only the test-gap filter).
  for (const [k, name, test] of [['q', 'computeTotals', 'computeTotals();\n'], ['u', 'renderReport', 'other();\n']]) {
    fs.mkdirSync(path.join(repo, 'src'), { recursive: true }); fs.mkdirSync(path.join(repo, 'test'), { recursive: true });
    const f = path.join(repo, 'src', name + '.js');
    fs.writeFileSync(f, fn(name, ''));
    const par = sh(repo, 'rev-parse', 'HEAD'), i = commit(`add ${name} (#${k === 'q' ? 1 : 2})`);
    fs.writeFileSync(f, fs.readFileSync(f, 'utf8').split('\n').map((l, n) => (n >= 5 && n <= 9 ? l.replace(/= (\d+);/, '= $1 + 1;') : l)).join('\n'));
    fs.writeFileSync(path.join(repo, 'test', name + '.test.js'), test);
    const fix = commit(`fix ${name} (#${k === 'q' ? 11 : 12})`);
    out[k] = { par, i, fixParent: i, fix };
  }
  const mine = { stats: { commits: 5 }, candidates: [
    { fix: { sha: out.q.fix, parent: out.q.fixParent, date: '2026-02-02T00:00:00Z', pr: 11 }, introducing: [{ sha: out.q.i, pr: 1 }] },
    { fix: { sha: out.u.fix, parent: out.u.fixParent, date: '2026-02-03T00:00:00Z', pr: 12 }, introducing: [{ sha: out.u.i, pr: 2 }] } ] };
  fs.mkdirSync(path.join(dir, 'mined')); fs.writeFileSync(path.join(dir, 'mined', 'mine-demo.json'), JSON.stringify(mine)); fs.writeFileSync(path.join(dir, 'mined', 'repos.txt'), 'demo o/demo\n');
  return out;
}
// the 194f785 builder, with its relative requires and __dirname pointed at the real replay directory
function referenceBuilder(dir) {
  const src = execFileSync('git', ['-C', REPLAY, 'show', `${BASE_SHA}:eval/replay/testgap-confirm-build.js`], { encoding: 'utf8' })
    .replace("require('../szz')", 'require(' + JSON.stringify(path.join(REPLAY, '..', 'szz')) + ')').replace("require('./testgap-score')", 'require(' + JSON.stringify(path.join(REPLAY, 'testgap-score')) + ')')
    .replace("require('./holdout2-null')", 'require(' + JSON.stringify(path.join(REPLAY, 'holdout2-null')) + ')').replace('const here = (f) => path.join(__dirname, f);', `const here = (f) => path.join(${JSON.stringify(REPLAY)}, f);`)
    .split('git(__dirname,').join(`git(${JSON.stringify(REPLAY)},`);
  const f = path.join(dir, 'reference-build.js'); fs.writeFileSync(f, src); return f;
}
const run = (script, dir, outName, ...extra) => {
  const out = path.join(dir, outName);
  execFileSync(process.execPath, [script, '--repos', path.join(dir, 'repos'), '--mined', path.join(dir, 'mined'), '--out', out, ...extra], { stdio: ['ignore', 'pipe', 'pipe'] });
  return JSON.parse(fs.readFileSync(out, 'utf8'));
};
const strip = (o) => { const c = JSON.parse(JSON.stringify(o)); delete c.frozen_at; delete c.branch_head; return c; };

test('flag off is identical to the 194f785 builder; flag on adds only unfiltered rows, blamed_by, mined_shas and unfiltered_* counters', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tcb-'));
  try {
    const fx = fixture(dir), ref = run(referenceBuilder(dir), dir, 'ref.json'), off = run(BUILD, dir, 'off.json'), on = run(BUILD, dir, 'on.json', '--queues-only');
    assert.strictEqual(ref.repos.demo.counts.qualifying, 1);
    assert.strictEqual(ref.status, 'not_tested');
    assert.deepStrictEqual(strip(off), strip(ref)); // flag off: same counts, same status
    // flag on: the existing counters and the qualifying queue are unchanged
    const counts = { ...on.repos.demo.counts }; for (const k of Object.keys(counts)) if (k.startsWith('unfiltered_')) delete counts[k];
    assert.deepStrictEqual(counts, ref.repos.demo.counts);
    assert.deepStrictEqual(on.queues.demo.map((r) => r.introducing), [fx.q.i]);
    assert.deepStrictEqual(on.unfiltered.demo.map((r) => r.introducing), [fx.u.i]); // fails only the test-gap filter
    assert.strictEqual(on.repos.demo.counts.unfiltered_qualifying, 1);
    assert.strictEqual(on.repos.demo.counts.unfiltered_size_and_source_ok, 1);
    assert.ok(Array.isArray(on.repos.demo.blamed_by) && on.repos.demo.blamed_by.length === 2 && on.repos.demo.mined_shas.includes(fx.q.fix));
    assert.strictEqual(on.status, undefined); // returned before the 40-check
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
