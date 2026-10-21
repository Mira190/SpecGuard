const test = require('node:test');
const assert = require('node:assert');
const { parse } = require('../../src/coverage');
const { wilson, titleLines, raName, g1For, jaccard, rankGate, measures, cleanIds, score } = require('./v2-score');

const lcov = (file, da) => `TN:\nSF:${file}\n${da.map(([l, h]) => `DA:${l},${h}`).join('\n')}\nend_of_record\n`;
const ra = (name, line, where = 'inline') => ({ where, kind: 'missing_test', path: 'src/a.ts', line, source: 'coverage', confidence: 'high', title: `${name}: 1 added line never executed by any unit test (L${line})` });
const rb = (line) => ({ where: 'summary', kind: 'weak_test', path: 'src/a.ts', line, source: 'relabel', title: 'weak' });
const rc = (line) => ({ where: 'inline', kind: 'missing_test', path: 'src/a.ts', line, title: 'model claim' });
const reps = (findings, extra = {}) => [1, 2, 3].map((k) => ({ valid: true, rep: 'rep' + k, findings, ...extra }));
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
  const runs = reps([ra('alpha_fn', 3)]); runs[2] = { valid: true, rep: 'rep3', findings: [ra('alpha_fn', 20)] };
  assert.strictEqual(measures(['x'], X({ x: { runs } })).G2.pass, false);
});

// ranking gate: the permutation, not a bare comparison
test('ranking gate: V2@3 above random@3 by a hair is NOT a pass (p >= .05); a clear separation over many PRs is', () => {
  // one PR, 4 groups, V2 shows 3 inline of which 2 were later tested; random expectation 0.5, V2 0.667, but chance alone gives that often
  const weak = rankGate([{ id: 'p', items: [{ y: 1, top: true }, { y: 1, top: true }, { y: 0, top: true }, { y: 0, top: false }] }], { perms: 500 });
  assert.ok(weak.v2_at3 > weak.random_at3, 'V2@3 > random@3 numerically');
  assert.ok(weak.p >= 0.05 && weak.pass === false, JSON.stringify(weak));
  const strong = rankGate(Array.from({ length: 6 }, (_, i) => ({ id: 'p' + i, items: [1, 1, 1, 0, 0, 0].map((y, j) => ({ y, top: j < 3 })) })), { perms: 500 });
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
  const v = reps([]).map((r) => ({ ...r, prompt_sha256: 'a' })), a = reps([]).map((r, i) => ({ ...r, prompt_sha256: i ? 'a' : 'b' })).reverse(); // order must not matter: paired by rep name (rep1 has 'b')
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

// ---- red-team fixes ----
const { mulberry32 } = require('../szz');

test('H0 calibration: random ranking over 30 PRs with 3 identical reps passes the ranking gate at most 8% of the time (one shuffle per PR, reps not shuffled independently)', () => {
  const rnd = mulberry32(777), sims = 250; let pass = 0;
  for (let s = 0; s < sims; s++) {
    const yOf = {}, spec = {};
    for (let i = 0; i < 30; i++) {
      const id = 'hono-' + i; spec[id] = { runs: reps([...names.slice(0, 3).map((n, k) => ra(n, lines[k])), ...names.slice(3).map((n, k) => ra(n, lines[3 + k], 'summary'))]) };
      names.forEach((n) => { yOf[id + n] = rnd() < 0.5; }); // later-tested is independent of V2's rank: H0
    }
    const m = measures(Object.keys(spec), X(spec, { perms: 200, seed: 1000 + s, later: (id, n) => yOf[id + n] }));
    if (m.E1p.gate_raw) pass++;
  }
  assert.ok(pass / sims <= 0.08, `false-pass rate ${pass / sims}`);
  console.log('H0 false-pass rate', pass / sims, 'of', sims);
});

test('a PR whose named items are all rollups (no named top item) is out of obs AND null and cannot flip the gate', () => {
  const strong = Array.from({ length: 4 }, (_, i) => ({ id: 's' + i, items: [1, 1, 1, 0, 0, 0].map((y, j) => ({ y, top: j < 3 })) }));
  const rollOnly = Array.from({ length: 6 }, (_, i) => ({ id: 'r' + i, items: [1, 1, 1].map((y) => ({ y, top: false })) }));
  const g = rankGate([...strong, ...rollOnly], { perms: 500 });
  assert.deepStrictEqual([g.n_prs, g.v2_at3, g.pass], [4, 1, true], JSON.stringify(g));
  assert.deepStrictEqual(g, rankGate(strong, { perms: 500 }));
});

test('unnamed inline R-a: V2@3 with unnamed as 0 is reported, and above 20% unnamed the ranking gate is not readable (null)', () => {
  const un = (line) => ({ ...ra('x', line), title: `definition at L${line}: 1 added line never executed by any unit test (L${line})` });
  const spec = Object.fromEntries(['hono-1', 'hono-2', 'hono-3', 'hono-4'].map((id) => [id, { runs: reps([ra('alpha_fn', 3), un(5), ra('gamma_fn', 7)], { rollup: [{ path: 'src/a.ts', count: 10, names: ['delta_fn'] }] }) }]));
  const m = measures(Object.keys(spec), X(spec, { later: () => true }));
  assert.deepStrictEqual([m.E1p.unnamed_share_top3 > 0.2, m.E1p.readable, m.E1p.pass], [true, false, null]);
  assert.ok(m.E1p.v2_at3_unnamed_as_0 < m.E1p.v2_at3, JSON.stringify(m.E1p));
  assert.deepStrictEqual(m.E1p.unscorable_items, { unnamed: 4, rollup_more: 36 });
  const ok = measures(['hono-1'], X({ 'hono-1': { runs: reps([ra('alpha_fn', 3), ra('beta_fn', 5), ra('gamma_fn', 7), ra('delta_fn', 9, 'summary')]) } }, { later: () => true }));
  assert.strictEqual(ok.E1p.readable, true);
});

test('R-a sets that differ between reps are reported per PR (rep_set_mismatch)', () => {
  const runs = reps([ra('alpha_fn', 3)]); runs[1] = { ...runs[1], findings: [ra('alpha_fn', 3), ra('beta_fn', 5)] };
  const m = measures(['hono-1', 'hono-2'], X({ 'hono-1': { runs }, 'hono-2': { runs: reps([ra('alpha_fn', 3)]) } }));
  assert.deepStrictEqual(m.E1p.rep_set_mismatch, ['hono-1']);
});

test('g1_all verifies every never-run line coverage.json lists (rollup R-a too) against the raw report', () => {
  const raw = parse(lcov('src/a.ts', [[3, 0], [5, 2], [9, 0]]));
  const covJson = { files: { 'src/a.ts': { never: [[3, 3], [5, 5], [9, 9]] } } };
  const m = measures(['hono-1'], X({ 'hono-1': { runs: reps([ra('alpha_fn', 3)]), report: raw, covJson } }));
  assert.deepStrictEqual([m.G1.g1_all.lines, m.G1.g1_all.verified], [3, 2]);
});

test('judge: the gate is null unless every item is labelled; missing labels are counted', () => {
  const spec = { 'hono-1': { runs: reps([ra('alpha_fn', 3), ra('beta_fn', 5)]) } }, items = (n, type, label) => Array.from({ length: n }, () => ({ type, label }));
  const calib = { items: [...items(40, 'positive', 'yes'), ...items(40, 'negative', 'no')] };
  const part = { labels: { 'hono-1|src/a.ts|3': 'yes' } }, full = { labels: { 'hono-1|src/a.ts|3': 'yes', 'hono-1|src/a.ts|5': 'yes' } };
  const sp = score(X(spec, { judge: part, calib })), sf = score(X(spec, { judge: full, calib }));
  assert.deepStrictEqual([sp.clean.E1j.missing_labels, sp.gates.judge], [1, null]);
  assert.deepStrictEqual([sf.clean.E1j.missing_labels, sf.gates.judge], [0, false]); // 2 of 2 yes: Wilson lower bound ~0.34 < 0.70
});

test('judge validity needs n >= 40 per type: 39 perfect positives are not enough', () => {
  const items = (n, type, label) => Array.from({ length: n }, () => ({ type, label }));
  const s = score(X({ 'hono-1': { runs: reps([]) } }, { calib: { items: [...items(39, 'positive', 'yes'), ...items(80, 'negative', 'no')] } }));
  assert.strictEqual(s.judge_calibration.valid, false);
  assert.strictEqual(score(X({ 'hono-1': { runs: reps([]) } }, { calib: { items: [...items(40, 'positive', 'yes'), ...items(40, 'negative', 'no')] } })).judge_calibration.valid, true);
});

test('volume counts model inline findings too; summary p90 is the real summary count; per PR (median over reps)', () => {
  const spec = { 'hono-1': { runs: reps([ra('alpha_fn', 3), rc(8), rc(9), rb(11), rb(12)]) } };
  const m = measures(['hono-1'], X(spec));
  assert.deepStrictEqual([m.volume.inline_median, m.volume.inline_p90, m.volume.summary_p90, m.volume.ra_inline_share], [3, 3, 2, 1 / 3]);
  const varied = [1, 2, 3].map((k) => ({ valid: true, rep: 'rep' + k, findings: Array.from({ length: k === 3 ? 9 : 1 }, (_, i) => rc(i + 1)) })); // one noisy rep does not move the PR's median
  assert.strictEqual(measures(['hono-1'], X({ 'hono-1': { runs: varied } })).volume.inline_median, 1);
});

test('a false G1 with an unknown G2 is a failed pass, not a pending one; the prompt check pairs reps by name', () => {
  const ran = parse(lcov('src/a.ts', [[3, 5]]));
  const s = score(X({ 'hono-1': { runs: reps([ra('alpha_fn', 3)]).slice(0, 1), report: ran } }, { reps: 1 }));
  assert.deepStrictEqual([s.clean.G1.pass, s.clean.G2.pass, s.gates.g1_g2, s.pass], [false, null, false, false]);
  const v = reps([]).map((r, i) => ({ ...r, prompt_sha256: 'xyz'[i] })), a = [...v].reverse();
  assert.deepStrictEqual(score(X({ 'hono-1': { runs: v, runsA: a } })).prompt_check, { same: 3, differ: 0, arm_a_must_run_live: false });
});

test('clean subset does not depend on findings: a PR with zero R-a but a failing (or erroring) counterpart test is NOT clean', () => {
  const x = X({ 'hono-1': { runs: reps([]), health: { selected_tests: 3, file_errors: {}, file_failures: { 'src/a.test.ts': 2 } } }, 'hono-2': { runs: reps([]), health: { selected_tests: 3, file_errors: {}, file_failures: { 'other/z.test.ts': 1 } } }, 'hono-3': { runs: reps([]) }, 'hono-4': { runs: reps([ra('alpha_fn', 3)]), health: { selected_tests: 3, file_errors: { 'src/a.test.ts': { kind: 'other' } } } } });
  assert.deepStrictEqual(cleanIds(x.ids, x), ['hono-2', 'hono-3']); // hono-2's failure is in a file that neither names nor neighbours a changed source
});
