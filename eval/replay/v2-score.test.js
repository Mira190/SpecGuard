const test = require('node:test');
const assert = require('node:assert');
const { parse } = require('../../src/coverage');
const { wilson, titleLines, raName, g1For, jaccard, rankGate, measures, cleanIds, score } = require('./v2-score');

const lcov = (file, da) => `TN:\nSF:${file}\n${da.map(([l, h]) => `DA:${l},${h}`).join('\n')}\nend_of_record\n`;
const ra = (name, line, where = 'inline') => ({ where, kind: 'missing_test', path: 'src/a.ts', line, source: 'coverage', confidence: 'high', title: `${name}: 1 added line never executed by any unit test (L${line})` });
const rb = (line) => ({ where: 'summary', kind: 'weak_test', path: 'src/a.ts', line, source: 'relabel', title: 'weak' });
const rc = (line) => ({ where: 'inline', kind: 'missing_test', path: 'src/a.ts', line, title: 'model claim' });
const reps = (findings, extra = {}) => [1, 2, 3].map(() => ({ valid: true, findings, ...extra }));
const NEVER = parse(lcov('src/a.ts', [[3, 0], [5, 0], [7, 0], [9, 0], [11, 0], [13, 0], [20, 4]]));
const HEALTH = { selected_tests: 3, file_errors: {} };

// Builds the scorer input. spec: { id: { runs, report, health, strat } }
function X(spec, over = {}) {
  const ids = Object.keys(spec), g = (f) => Object.fromEntries(ids.map((id) => [id, f(spec[id])]));
  return { ids, reps: 3, seed: 20261021, perms: 400, runsV2: g((s) => s.runs), runsA: g((s) => s.runsA || []), reports: g((s) => ('report' in s ? s.report : NEVER)), covJson: g((s) => s.covJson || null),
    health: g((s) => s.health || HEALTH), stratum: g((s) => s.strat || 's1'), changed: () => ['src/a.ts'], tests: () => false, later: () => false, defOf: () => null, judge: null, calib: null, skeleton: null, ...over };
}
const names = ['alpha_fn', 'beta_fn', 'gamma_fn', 'delta_fn', 'eps_fn', 'zeta_fn'], lines = [3, 5, 7, 9, 11, 13];

test('wilson bounds and title line parsing', () => {
  const [lo, hi] = wilson(40, 40); assert.ok(lo > 0.91 && hi === 1);
  assert.deepStrictEqual(wilson(0, 0), [null, null]);
  assert.deepStrictEqual(titleLines({ title: 'f: 4 added lines never executed by any unit test (L3, L9-L11)' }), { lines: [3, 9, 10, 11], truncated: false });
  assert.strictEqual(titleLines({ title: 'f: 9 added lines never executed by any unit test (L1, L3, L5, +6 more)' }).truncated, true);
  assert.strictEqual(raName({ title: 'definition at L12: 1 added line never executed by any unit test (L12)' }), null);
  assert.strictEqual(raName(ra('alpha_fn', 3)), 'alpha_fn');
});

test('G1 is line level from the RAW report: a line that ran, or one the report does not instrument, makes the claim false', () => {
  const runs = reps([ra('alpha_fn', 3), ra('beta_fn', 20), ra('gamma_fn', 99)]);
  const r = g1For('x', runs, NEVER, null);
  assert.deepStrictEqual([r.total, r.verified, r.false_], [9, 3, 6]); // line 3 never ran; 20 ran (4 hits); 99 is uninstrumented
  assert.strictEqual(g1For('x', runs, null, null).unverifiable, 9);
});

test('G1 does not trust coverage.json: raw report says the line ran while coverage.json says never', () => {
  const ran = parse(lcov('src/a.ts', [[3, 2]]));
  const covJson = { files: { 'src/a.ts': { never: [[3, 3]] } } };
  const r = g1For('x', reps([ra('alpha_fn', 3)]), ran, covJson);
  assert.deepStrictEqual([r.verified, r.false_, r.covjson_disagree], [0, 3, 3]);
  const m = measures(['x'], X({ x: { runs: reps([ra('alpha_fn', 3)]), report: ran, covJson } }));
  assert.strictEqual(m.G1.pass, false);
});

test('env artifact: a test file names the definition although the report says it never ran', () => {
  const m = measures(['x'], X({ x: { runs: reps([ra('alpha_fn', 3), ra('beta_fn', 5)]) } }, { tests: (id, n) => n === 'alpha_fn' }));
  assert.deepStrictEqual(m.env_artifact, { definitions_named: 2, test_file_names_definition_but_never_ran: 1 });
});

test('G2: R-a identical in 3 reps = 1.0; a rep that moves a finding by more than 5 lines fails', () => {
  assert.strictEqual(jaccard([{ path: 'a', line: 3 }], [{ path: 'a', line: 8 }]), 1);
  assert.strictEqual(jaccard([{ path: 'a', line: 3 }], [{ path: 'a', line: 9 }]), 0);
  assert.strictEqual(measures(['x'], X({ x: { runs: reps([ra('alpha_fn', 3)]) } })).G2.pass, true);
  const runs = reps([ra('alpha_fn', 3)]); runs[2] = { valid: true, findings: [ra('alpha_fn', 20)] };
  assert.strictEqual(measures(['x'], X({ x: { runs } })).G2.pass, false);
});

// ranking gate: the permutation, not a bare comparison
test('ranking gate: V2@3 above random@3 by a hair is NOT a pass (p >= .05); a clear separation over many PRs is', () => {
  // one PR, 4 groups, V2 shows 3 inline of which 2 were later tested; random expectation 0.5, V2 0.667, but chance alone gives that often
  const weak = rankGate([{ id: 'p', runs: [[{ y: 1, top: true }, { y: 1, top: true }, { y: 0, top: true }, { y: 0, top: false }]] }], { perms: 500 });
  assert.ok(weak.v2_at3 > weak.random_at3, 'V2@3 > random@3 numerically');
  assert.ok(weak.p >= 0.05 && weak.pass === false, JSON.stringify(weak));
  const strong = rankGate(Array.from({ length: 6 }, (_, i) => ({ id: 'p' + i, runs: [0, 1, 2].map(() => [1, 1, 1, 0, 0, 0].map((y, j) => ({ y, top: j < 3 }))) })), { perms: 500 });
  assert.strictEqual(strong.v2_at3, 1); assert.ok(strong.p < 0.05 && strong.pass === true, JSON.stringify(strong));
});

test('ranking gate through measures: seed is the prereg seed and results are reproducible', () => {
  const later = (id, n) => names.slice(0, 3).includes(n);
  const spec = Object.fromEntries(['hono-1', 'hono-2', 'sqlglot-3', 'sqlglot-4', 'hono-5', 'sqlglot-6'].map((id) => [id,
    { runs: reps([...names.slice(0, 3).map((n, i) => ra(n, lines[i])), ...names.slice(3).map((n, i) => ra(n, lines[3 + i], 'summary'))]) }]));
  const a = measures(Object.keys(spec), X(spec, { later })), b = measures(Object.keys(spec), X(spec, { later }));
  assert.deepStrictEqual(a.E1p, b.E1p); assert.strictEqual(a.E1p.v2_at3, 1); assert.ok(a.E1p.pass);
  assert.deepStrictEqual(Object.keys(a.E1p.base_rate_by_repo).sort(), ['hono', 'sqlglot']);
});

test('H: R-a verified line level; R-b and R-c count as unknown in the worst case (not verified)', () => {
  const m = measures(['x'], X({ x: { runs: reps([ra('alpha_fn', 3), rb(8), rc(9)]) } }));
  assert.deepStrictEqual([m.H.delivered, m.H.verified, m.H.unknown], [9, 3, 6]);
  assert.strictEqual(m.H.worst, 1 / 3); assert.strictEqual(m.H.best, 1); assert.strictEqual(m.H.target_met_worst, false);
});

test('silence, volume per stratum, D and the judge report "not run" when their inputs are absent', () => {
  const spec = { 'hono-1': { runs: reps([ra('alpha_fn', 3)]), strat: 's1' }, 'hono-2': { runs: reps([]), strat: 's2' } };
  const m = measures(Object.keys(spec), X(spec));
  assert.strictEqual(m.volume.silence, 0.5); assert.strictEqual(m.volume.by_stratum.s2.silence, 1); assert.strictEqual(m.volume.by_stratum.s1.inline_median, 1);
  assert.deepStrictEqual([m.D, m.E1j], [{ status: 'not run' }, { status: 'judge not run' }]);
  const s = score(X(spec));
  assert.deepStrictEqual(s.judge_calibration, { status: 'not run', valid: null }); assert.strictEqual(s.gates.judge, null); assert.notStrictEqual(s.pass, true);
});

test('judge interface: labels give a Wilson bound; the gate needs a valid calibration with n >= 40 per type and lower bounds >= .75', () => {
  const spec = { 'hono-1': { runs: reps([ra('alpha_fn', 3)]) } };
  const judge = { labels: { 'hono-1|src/a.ts|3': 'yes' } };
  const m = measures(Object.keys(spec), X(spec, { judge }));
  assert.deepStrictEqual([m.E1j.status, m.E1j.labelled, m.E1j.yes], ['run', 1, 1]);
  const items = (n, type, label) => Array.from({ length: n }, () => ({ type, label }));
  const good = { items: [...items(40, 'positive', 'yes'), ...items(40, 'negative', 'no')] }, bad = { items: [...items(40, 'positive', 'yes'), ...items(40, 'negative', 'yes')] }, small = { items: [...items(10, 'positive', 'yes'), ...items(10, 'negative', 'no')] };
  assert.strictEqual(score(X(spec, { judge, calib: good })).judge_calibration.valid, true);
  assert.strictEqual(score(X(spec, { judge, calib: bad })).judge_calibration.valid, false);
  assert.strictEqual(score(X(spec, { judge, calib: small })).judge_calibration.valid, false);
  assert.strictEqual(score(X(spec, { judge, calib: bad })).gates.judge, false);
});

test('D reads skeleton-run results: compiles AND executes the gap lines', () => {
  const spec = { 'hono-1': { runs: reps([ra('alpha_fn', 3), ra('beta_fn', 5)]) } };
  const skeleton = { items: [{ id: 'hono-1', path: 'src/a.ts', line: 3, compiles: true, executes_gap: true, has_skeleton: true }, { id: 'hono-1', path: 'src/a.ts', line: 5, compiles: true, executes_gap: false, has_skeleton: true }] };
  const m = measures(Object.keys(spec), X(spec, { skeleton }));
  assert.deepStrictEqual([m.D.rate, m.D.reading], [0.5, 'plus an executable test skeleton']);
});

test('prompt hash check (B5): differing prompt hashes between V2 and arm A mean A must run live', () => {
  const v = reps([]).map((r) => ({ ...r, prompt_sha256: 'a' })), a = reps([]).map((r, i) => ({ ...r, prompt_sha256: i ? 'a' : 'b' }));
  assert.deepStrictEqual(score(X({ 'hono-1': { runs: v, runsA: a } })).prompt_check, { same: 2, differ: 1, arm_a_must_run_live: true });
});

// the clean-counterpart subset decides the gates; all-PR numbers are reported beside it
test('gates read the CLEAN subset: unclean PRs with heavy volume do not fail the gate, but show in the all-PR numbers', () => {
  const dirty = { file_errors: { 'src/a.test.ts': { kind: 'other' } }, selected_tests: 3 };
  const heavy = reps(Array.from({ length: 5 }, (_, i) => ra(names[i], lines[i]))), light = reps([ra('alpha_fn', 3), ra('beta_fn', 5)]);
  const spec = { 'hono-1': { runs: light }, 'hono-2': { runs: light }, 'hono-3': { runs: heavy, health: dirty }, 'hono-4': { runs: heavy, health: dirty }, 'hono-5': { runs: heavy, health: dirty }, 'hono-6': { runs: heavy, health: dirty } };
  const x = X(spec), s = score(x);
  assert.deepStrictEqual(cleanIds(x.ids, x), ['hono-1', 'hono-2']);
  assert.strictEqual(s.clean.volume.inline_median, 2); assert.strictEqual(s.all.volume.inline_median, 5);
  assert.strictEqual(s.gates.inline_median, true);
  assert.deepStrictEqual([s.clean_n, s.all_n], [2, 6]);
});

test('unusable PRs (no report, no selected tests) are not clean', () => {
  const x = X({ 'hono-1': { runs: reps([]), report: null }, 'hono-2': { runs: reps([]), health: { selected_tests: 0, file_errors: {} } }, 'hono-3': { runs: reps([]) } });
  assert.deepStrictEqual(cleanIds(x.ids, x), ['hono-3']);
});
