// Seeded regressions for the two Kite run #12 false positives (ownFile, toolbox; found by a manual review of the scan findings), through the offline harness:
// real collect.sh -> a canned model answer that makes the original claim -> real post.run against a fake GitHub -> grade.js.
// Each case also carries a true-positive control, so a guard that suppresses everything would fail here.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { prepareOne, finishOne } = require('./local.js');

const out = fs.mkdtempSync(path.join(os.tmpdir(), 'specguard-kite-fp-'));
test.after(() => fs.rmSync(out, { recursive: true, force: true }));

const cite = (p, line, quote) => ({ path: p, line, quote, side: 'RIGHT' });
// One gap row + its finding. kind: missing_test | weak_test; at: the finding's citation; code: the behaviour; ev: the unit test location (weak_test).
const gap = (id, kind, at, code, ev) => ({
  row: { id, obligation: `${kind} ${id}`, source: 'PR body', behaviour: code, change: code, evidence: ev ? [{ ...ev, layer: 'unit', kind: 'assertion' }] : [], status: kind, reason: 'seeded' },
  finding: { kind, ...at, title: `${kind} ${id}`, body: `Seeded claim ${id}.`, confidence: 'high', obligation_ids: [id],
    ...(kind === 'weak_test' && { counterexample: `args() returns ['-y', '-i', 'in.mp4'] without the output path -> the cited assertion still passes` }) }, // as a model following the skill writes it: the F04 gate checks its shape, not its truth
});
const answer = (gaps) => ({
  requirements_source: 'PR body', not_reviewed: '',
  standards: { status: 'no_rules', sources: [], reason: 'No rule files.' },
  layering: { status: 'checked', reason: 'Unit tests only.' },
  requirements: [], coverage: gaps.map((g) => g.row), findings: gaps.map((g) => g.finding),
});
async function run(id, gaps) {
  const m = prepareOne(id, out);
  assert.equal(m.skip, false, `${id}: collect must review the PR`);
  fs.writeFileSync(path.join(out, id, 'ctx', 'findings.json'), JSON.stringify(answer(gaps)));
  const r = await finishOne(id, out);
  return { r, summary: fs.readFileSync(path.join(out, id, 'summary.md'), 'utf8'), posted: JSON.parse(fs.readFileSync(path.join(out, id, 'posted.json'), 'utf8')).comments };
}

const K1 = 'eval-sandbox/k1/electron/app.cjs';
const OWN = "const ownFile = (candidate) => typeof candidate === 'string' && MEDIA_EXT.test(candidate) && E.isDirectChild(dirOf(), candidate);";
const TITLE = "const titleOf = (clip) => 'Sample - ' + E.labelOf(clip.name);";

test('k1 ownFile: a missing_test on a wrapper whose delegate (isDirectChild) is unit-tested is kept off the PR; the untested wrapper (titleOf -> labelOf) still posts', async () => {
  const { r, summary, posted } = await run('k1', [
    gap('O1', 'missing_test', cite(K1, 6, OWN), cite(K1, 6, OWN)),
    gap('O2', 'missing_test', cite(K1, 11, TITLE), cite(K1, 11, TITLE)),
  ]);
  assert.equal(r.must_not_violations.length, 0, 'ownFile must not be a posted gap');
  assert.equal(r.tp, 1, 'recall control: the titleOf gap must post');
  assert.equal(r.fp, 0);
  assert.equal(r.pass, true, JSON.stringify(r));
  assert.deepEqual(posted.map((c) => c.line), [11]);
  assert.match(summary, /a delegated helper is tested: isDirectChild at eval-sandbox\/k1\/test\/filename\.test\.js:\d+/, 'the downgrade names its evidence');
  // the real collect.sh keys the PR text it fetched (what the model reads) and post records that key, not the event payload
  const c = JSON.parse(fs.readFileSync(path.join(__dirname, 'cases', 'k1', 'case.json'), 'utf8')), key = require('../src/preflight').reqKey({ title: c.pr_title, body: c.pr_body });
  assert.equal(fs.readFileSync(path.join(out, 'k1', 'ctx', 'pr-req-key.txt'), 'utf8'), key);
  assert.ok(summary.includes(`<!-- specguard:req=${key} -->`), 'the summary records the collected requirements key');
});

const K2 = 'eval-sandbox/k2/toolbox.test.js', K2SRC = 'eval-sandbox/k2/toolbox.js';
const HAS = "  assert.ok(has(a, '-c:v', 'libx264'));", LEN = '  assert.ok(a.length);';
const ARGS = "  return ['-y', '-i', input, '-c:v', 'libx264', '-crf', String(crf), '-pix_fmt', 'yuv420p', output];";

test('k2 toolbox control: a weak_test on assert.ok(a.length) for "writes the output path last" posts', async () => {
  const { r } = await run('k2', [gap('O2', 'weak_test', cite(K2, 16, LEN), cite(K2SRC, 3, ARGS), cite(K2, 16, LEN))]);
  assert.equal(r.tp, 1, JSON.stringify(r));
  assert.equal(r.pass, true, JSON.stringify(r));
});

// Known gap, model-dependent: no deterministic layer judges what a weak_test claim says about an assertion, so the model's false
// claim on the contiguous-sequence has() check is posted unchanged. The first test pins today's behaviour so a change is noticed;
// the todo states the wanted behaviour and is reported (not failed) until a guard exists. Do not tune a heuristic to make it pass
// without a real-model recall run (eval/run.js --cases k2,t1,t2,t3,t4).
const FP = () => [gap('O1', 'weak_test', cite(K2, 10, HAS), cite(K2SRC, 3, ARGS), cite(K2, 10, HAS)), gap('O2', 'weak_test', cite(K2, 16, LEN), cite(K2SRC, 3, ARGS), cite(K2, 16, LEN))];
test('k2 toolbox (current behaviour): the model false positive on has() reaches the PR; the control still posts', async () => {
  const { r, posted } = await run('k2', FP());
  assert.equal(r.tp, 1);
  assert.equal(r.must_not_violations.length, 1, 'if this is 0, a guard now catches it: flip the todo below into a real test');
  assert.deepEqual(posted.map((c) => c.line).sort((a, b) => a - b), [10, 16]);
});
test('k2 toolbox (wanted): the has() claim is not posted as a weak test', { todo: 'no deterministic weak_test guard; model-dependent' }, async () => {
  const { r } = await run('k2', FP());
  assert.equal(r.must_not_violations.length, 0);
  assert.equal(r.pass, true);
});
