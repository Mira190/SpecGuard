const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { summarize, table } = require('./engine-ab.js');

const GOOD = { requirements_source: 'none', coverage: [], findings: [], not_reviewed: [], standards: { status: 'no_rules' }, layering: { status: 'ok' }, requirements: [] };
function ctx(t, files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'specguard-ab-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const [n, v] of Object.entries(files)) fs.writeFileSync(path.join(dir, n), typeof v === 'string' ? v : JSON.stringify(v));
  return dir;
}

test('cli: first try needs usable findings and no repair note; credits sum both turns', (t) => {
  const ok = summarize(ctx(t, { 'findings.json': GOOD, 'usage.json': { totalNanoAiu: 2e9 } }), 'cli', 1000);
  assert.equal(ok.first_try, true);
  assert.equal(ok.credits, 2);
  const fixed = summarize(ctx(t, { 'findings.json': GOOD, 'engine-repair': 'repaired\n', 'usage.json': { totalNanoAiu: 1e9 }, 'usage-repair.json': { totalNanoAiu: 5e8 } }), 'cli', 1000);
  assert.deepEqual([fixed.first_try, fixed.usable, fixed.repair, fixed.credits], [false, true, 'repaired', 1.5]);
  const broken = summarize(ctx(t, { 'findings.json': '{"findings":[]}', 'engine-repair': 'repair_failed' }), 'cli', 1000);
  assert.deepEqual([broken.first_try, broken.usable], [false, false]);
});

test('sdk: first try = first submit valid and no follow-up message', (t) => {
  const run = (l) => summarize(ctx(t, { 'findings.json': GOOD, 'sdk-run.json': l }), 'sdk', 1);
  assert.equal(run({ followups: 0, submits: [{ ok: true }] }).first_try, true);
  assert.equal(run({ followups: 1, submits: [{ ok: true }] }).first_try, false);
  assert.equal(run({ followups: 0, submits: [{ ok: false }, { ok: true }] }).first_try, false);
});

test('table: one row per run plus a per-engine total', () => {
  const rows = [{ id: 'l1', engine: 'cli', first_try: true, usable: true, tp: 1, fp: 0, fn: 0, pass: true, ms: 4000, credits: 1.25, model: 'm' },
    { id: 'l1', engine: 'sdk', first_try: false, usable: false, tp: 0, fp: 0, fn: 1, pass: false, ms: 6000, credits: 0.5, repair: 'repair_failed', status: 'timeout' }];
  const out = table(rows);
  assert.match(out, /l1 +cli +yes +yes +1 +0 +0 +PASS +4 +1\.250/);
  assert.match(out, /cli: first-try 1\/1, usable 1\/1, pass 1\/1/);
  assert.match(out, /sdk: first-try 0\/1, usable 0\/1, pass 0\/1/);
  assert.match(out, /repair:repair_failed timeout/);
});
