const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { parseComments, lastPerPr, summarize, wilson, bootstrap } = require('./aggregate-counts');

const counts = (since, extra = {}) => `<!-- specguard:summary -->\n<!-- specguard:counts ${JSON.stringify({ complete: true, since_total: Object.values(since).reduce((a, b) => a + b, 0), since, ...extra })} -->\n## SpecGuard\n`;
const S = (addressed, open = 0, dismissed = 0, not_observed = 0) => ({ addressed, open, dismissed, not_observed });
const c = (n, body, updated_at = '') => ({ issue_url: `https://api.github.com/repos/o/r/issues/${n}`, updated_at, body });
const FIXTURE = [
  c(1, counts(S(1, 1)), '2026-01-01'), c(1, counts(S(3, 1)), '2026-01-03'), // same PR: the later line wins
  c(2, counts(S(0, 4)), '2026-01-02'),
  c(3, counts(S(2, 0, 1, 1)), '2026-01-02'),
  c(4, '<!-- specguard:summary -->\nno counts here'), // not a SpecGuard counts line
  c(5, `<!-- specguard:counts ${JSON.stringify({ complete: false, since: S(9) })} -->`), // incomplete runs carry no outcomes
  c(6, '<!-- specguard:counts {broken} -->'),
  { issue_url: 'x', body: null },
];

test('lastPerPr: last complete counts line per PR; comments without a usable line are skipped', () => {
  const prs = lastPerPr(FIXTURE);
  assert.equal(prs.length, 3);
  assert.deepEqual(prs.map((p) => p.since), [S(3, 1), S(0, 4), S(2, 0, 1, 1)]);
});

test('summarize: per-outcome counts, A, Wilson interval, cluster bootstrap (deterministic for a seed)', () => {
  const s = summarize(lastPerPr(FIXTURE), { seed: 7 });
  assert.deepEqual(s.outcomes, { addressed: 5, open: 5, dismissed: 1, not_observed: 1 });
  assert.equal(s.prs, 3);
  assert.equal(s.findings, 12);
  assert.ok(Math.abs(s.A - 5 / 12) < 1e-12);
  const [lo, hi] = s.wilson_if_independent;
  assert.ok(lo < s.A && s.A < hi && lo > 0.15 && hi < 0.7);
  const [bl, bh] = s.cluster_bootstrap_95;
  assert.ok(bl <= s.A && s.A <= bh);
  assert.deepEqual(summarize(lastPerPr(FIXTURE), { seed: 7 }).cluster_bootstrap_95, s.cluster_bootstrap_95);
  assert.equal(s.strata, undefined, 'no merged / tests_changed fields, no strata');
});

test('summarize: empty and single-PR inputs do not divide by zero', () => {
  const none = summarize([]);
  assert.deepEqual([none.prs, none.findings, none.A, none.wilson_if_independent, none.cluster_bootstrap_95], [0, 0, null, null, null]);
  const one = summarize(lastPerPr([c(1, counts(S(2, 2)))]));
  assert.equal(one.A, 0.5);
  assert.equal(one.cluster_bootstrap_95, null);
  assert.deepEqual(wilson(0, 0), null);
  assert.equal(bootstrap([]), null);
});

test('optional pr, merged and tests_changed fields: pr keys the PR, strata appear when present', () => {
  const rows = [
    c(11, counts(S(4, 0), { pr: 1, merged: true, tests_changed: true })), c(12, counts(S(1, 3), { pr: 1, merged: true, tests_changed: true }), 'b'), // same pr: one record
    c(13, counts(S(0, 2), { pr: 2, merged: false, tests_changed: false })),
    c(14, counts(S(1, 1), { pr: 3 })), // fields absent: counted overall, in no stratum
  ];
  const s = summarize(lastPerPr(rows));
  assert.equal(s.prs, 3);
  assert.deepEqual(s.strata.merged.merged, { prs: 1, findings: 4, A: 0.25 });
  assert.deepEqual(s.strata.merged.not_merged, { prs: 1, findings: 2, A: 0 });
  assert.equal(s.strata.merged.unknown, 1);
  assert.equal(s.strata.tests_changed.tests_changed.prs, 1);
  assert.equal(s.strata.tests_changed.tests_unchanged.A, 0);
});

test('parseComments: one array, concatenated gh pages, and empty input; CLI reads --file', (t) => {
  assert.equal(parseComments('[{"a":1}]').length, 1);
  assert.equal(parseComments('[{"a":1}]\n[{"a":2},{"a":3}]').length, 3);
  assert.deepEqual(parseComments('  '), []);
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agg-')), 'comments.json');
  t.after(() => fs.rmSync(path.dirname(f), { recursive: true, force: true }));
  fs.writeFileSync(f, JSON.stringify(FIXTURE.slice(0, 4)));
  const r = spawnSync(process.execPath, [path.join(__dirname, 'aggregate-counts.js'), '--file', f, '--seed', '3'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.deepEqual([out.prs, out.findings], [3, 12]);
  assert.equal(spawnSync(process.execPath, [path.join(__dirname, 'aggregate-counts.js')], { encoding: 'utf8' }).status, 2);
});

test('lastPerPr: the latest run with valid outcomes wins, even when incomplete; old counts keep the complete-only rule', () => {
  const rows = [
    c(1, counts(S(0, 2)), '2026-01-01'), // complete, old counts
    c(1, counts(S(3, 0), { complete: false, outcome_valid: true }), '2026-01-02'), // later, incomplete but judged per finding
    c(2, counts(S(1, 1)), '2026-01-01'),
    c(2, counts(S(9), { complete: false }), '2026-01-02'), // old counts, incomplete: skipped
    c(3, counts(S(0, 1)), '2026-01-01'),
    c(3, counts(S(5), { complete: true, outcome_valid: false }), '2026-01-02'), // explicitly not valid
  ];
  assert.deepEqual(lastPerPr(rows).map((p) => p.since), [S(3, 0), S(1, 1), S(0, 1)]);
});
