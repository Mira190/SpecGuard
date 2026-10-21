const test = require('node:test');
const assert = require('node:assert');
const { parse } = require('../../src/coverage');
const { hitsForFindings, exclusionReason, labelOf, runItems, rate, diffOf, permP, clusterBoot, primary, secondaries } = require('./coverage-e3-score');

const lcov = (file, da) => `TN:\nSF:${file}\n${da.map(([l, h]) => `DA:${l},${h}`).join('\n')}\nend_of_record\n`;
const it = (pr, rep, label, c, extra = {}) => ({ pr, rep, repo: 'hono', subgroup: 'filtered', label, catch: c, delivered: true, deps: false, failed: '<=20', ...extra });
const opt = { seed: 20261020, perms: 2000, boots: 200 };
const B = { has: (p, l) => p === 'src/a.ts' && l === 5 };

test('labels come from hits of the CITED file, which need not be a changed file (kills: hits only in changed files)', () => {
  const parsed = parse(lcov('src/changed.ts', [[1, 1]]) + lcov('src/untouched.ts', [[7, 0], [8, 3]]));
  const hits = hitsForFindings(parsed, new Set(['src/changed.ts']), [{ path: 'src/untouched.ts', line: 7 }]);
  assert.strictEqual(labelOf(true, hits, { path: 'src/untouched.ts', line: 7 }), 'confirmed');
  assert.strictEqual(labelOf(true, hits, { path: 'src/untouched.ts', line: 8 }), 'contradicted');
  assert.strictEqual(labelOf(true, hits, { path: 'src/changed.ts', line: 1 }), 'contradicted');
});

test('unknown: not instrumented, no report, unusable PR; never contradicted (kills: unknown as contradicted)', () => {
  const hits = hitsForFindings(parse(lcov('src/a.ts', [[1, 0], [2, 4]])), new Set(['src/a.ts']), [{ path: 'src/a.ts' }]);
  assert.strictEqual(labelOf(true, hits, { path: 'src/a.ts', line: 99 }), 'unknown'); // line not instrumented
  assert.strictEqual(labelOf(true, hits, { path: 'src/b.ts', line: 1 }), 'unknown'); // file not in report
  assert.strictEqual(labelOf(true, null, { path: 'src/a.ts', line: 1 }), 'unknown'); // no report
  assert.strictEqual(labelOf(false, hits, { path: 'src/a.ts', line: 1 }), 'unknown'); // PR unusable under E1's rules, even though the line is 0-hit
  assert.strictEqual(hitsForFindings(null, new Set(), []), null);
});

test('unknown findings stay out of the contradicted rate and out of the shuffle', () => {
  const base = [], withUnk = [];
  for (let i = 0; i < 12; i++) { const a = [it('p' + i, 1, 'confirmed', i % 3 === 0 ? 1 : 0), it('p' + i, 1, 'contradicted', i % 4 === 0 ? 1 : 0)]; base.push(...a); withUnk.push(...a, it('p' + i, 1, 'unknown', 1), it('p' + i, 1, 'unknown', 1)); }
  assert.deepStrictEqual(rate(withUnk, 'contradicted'), rate(base, 'contradicted'));
  assert.strictEqual(diffOf(withUnk), diffOf(base));
  assert.deepStrictEqual(permP(withUnk, opt), permP(base, opt));
  assert.strictEqual(primary(withUnk, [], opt).contradicted, 12);
});

test('shuffle is within each PR-run: labels perfectly confounded with the run get p = 1 (kills: shuffle across PRs/runs, ties as >)', () => {
  const items = [];
  for (let i = 0; i < 20; i++) { const hit = i < 10 ? 1 : 0; // every finding of a run shares one outcome, so any within-run shuffle leaves the statistic untouched
    items.push(it('p' + i, 1, 'confirmed', hit), it('p' + i, 1, 'contradicted', hit));
    if (i < 10) items.push(it('p' + i, 1, 'confirmed', hit)); else items.push(it('p' + i, 1, 'contradicted', hit)); }
  assert.ok(diffOf(items) > 0.15); // confirmed findings sit mostly in the hit runs
  const r = permP(items, opt);
  assert.strictEqual(r.p, 1); // every permutation equals the observed value: ties count
  assert.strictEqual(primary(items, [], opt).verdict, 'FAIL');
});

test('genuine within-run signal gives a small p and PASS; the 15-point and p rules both apply', () => {
  const items = [];
  for (let i = 0; i < 14; i++) items.push(it('p' + i, 1, 'confirmed', 1), it('p' + i, 1, 'contradicted', 0));
  const r = primary(items, Array.from({ length: 14 }, (_, i) => 'p' + i), opt);
  assert.strictEqual(r.verdict, 'PASS'); assert.strictEqual(r.difference, 1); assert.ok(r.p < 0.05); assert.ok(r.ci95[0] > 0.9);
  const small = []; // p small but difference 10 points: FAIL on the effect rule
  for (let i = 0; i < 40; i++) small.push(it('q' + i, 1, 'confirmed', i < 22 ? 1 : 0), it('q' + i, 1, 'contradicted', i < 18 ? 1 : 0));
  const s = primary(small, [], opt); assert.ok(Math.abs(s.difference - 0.1) < 1e-9); assert.strictEqual(s.verdict, 'FAIL');
});

test('a PR-run with one label keeps its findings; p never counts a group with a single label as shuffled', () => {
  const items = [it('a', 1, 'confirmed', 1), it('a', 1, 'confirmed', 1), it('b', 1, 'contradicted', 0), it('b', 1, 'contradicted', 0)];
  assert.strictEqual(permP(items, opt).p, 1); // nothing can move: statistic equals observed in every permutation
});

test('not tested below 10 confirmed or 10 contradicted, decided before any p', () => {
  const few = [];
  for (let i = 0; i < 9; i++) few.push(it('p' + i, 1, 'confirmed', 1));
  for (let i = 0; i < 20; i++) few.push(it('c' + i, 1, 'contradicted', 0));
  const r = primary(few, [], opt); assert.strictEqual(r.verdict, 'not_tested'); assert.strictEqual(r.p, undefined);
  assert.strictEqual(primary(few.slice(-20), [], opt).verdict, 'not_tested');
});

test('exclusions by reason and run items carry label, catch, delivered flag and failing-test cut', () => {
  assert.strictEqual(exclusionReason({ line: 3 }), 'no_path');
  assert.strictEqual(exclusionReason({ path: 'src/a.ts' }), 'no_line');
  assert.strictEqual(exclusionReason({ path: 'README.md', line: 2 }), 'non_code');
  assert.strictEqual(exclusionReason({ path: 'src/a.ts', line: 2 }), null);
  const hits = hitsForFindings(parse(lcov('src/a.ts', [[5, 0], [9, 2]])), new Set(['src/a.ts']), [{ path: 'src/a.ts' }]);
  const run = { findings: [{ kind: 'missing_test', where: 'inline', path: 'src/a.ts', line: 5, confidence: 'high' }, { kind: 'missing_test', where: 'summary', path: 'src/a.ts', line: 9, why: 'low confidence' },
    { kind: 'missing_test', where: 'summary', path: 'src/a.ts' }, { kind: 'weak_test', path: 'src/a.ts', line: 5 }, { kind: 'missing_test', path: 'x.md', line: 1 }] };
  const out = runItems({ id: 'p', repo: 'hono', subgroup: 'filtered', usable: true, hits, B, deps: true, failed: 21 }, 2, run);
  assert.deepStrictEqual(out.excluded, { no_line: 1, non_code: 1 });
  assert.deepStrictEqual(out.items.map((x) => [x.label, x.catch, x.delivered, x.rep, x.deps, x.failed]), [['confirmed', 1, true, 2, true, '>20'], ['contradicted', 0, false, 2, true, '>20']]);
});

test('cluster bootstrap resamples PRs and is deterministic; secondaries split by label and delivered', () => {
  const items = [it('a', 1, 'confirmed', 1), it('a', 2, 'confirmed', 1), it('b', 1, 'contradicted', 0), it('c', 1, 'unknown', 0, { delivered: false })];
  const a = clusterBoot(items, ['a', 'b', 'c'], 'confirmed', 'contradicted', 1, 300), b = clusterBoot(items, ['a', 'b', 'c'], 'confirmed', 'contradicted', 1, 300);
  assert.deepStrictEqual(a, b); assert.ok(a.skipped > 0); assert.deepStrictEqual(a.ci95, [1, 1]);
  const s = secondaries(items, ['a', 'b', 'c'], opt);
  assert.strictEqual(s.delivered_only.findings, 3); assert.strictEqual(s.confirmed_vs_unknown.difference, 1);
  assert.deepStrictEqual(s.by_deps_changed.false.rates.unknown, { n: 1, catches: 0, rate: 0 });
});
