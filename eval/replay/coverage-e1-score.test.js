const test = require('node:test');
const assert = require('node:assert');
const { parse } = require('../../src/coverage');
const { makeB } = require('./testgap-score');
const { loadHits, coverFlags, errCoversSource, unusableReason, evalCover, armScore, labelLine, drawNull, powerOf, summarize, runValid, medianUpper } = require('./coverage-e1-score');

const lcov = (file, da) => `TN:\nSF:${file}\n${da.map(([l, h]) => `DA:${l},${h}`).join('\n')}\nend_of_record\n`;
const U = (path, name, start, end, added) => ({ path, name, start, end, added });
const el = (d) => d.changedUnits.map((u) => ({ path: u.path, lines: u.added }));
const opt = { perms: 200, boots: 100 };

test('C flags the first added instrumented line with 0 hits; uninstrumented unit skipped', () => {
  const hits = loadHits(parse(lcov('src/a.ts', [[2, 5], [3, 0], [4, 0], [20, 1]])), new Set(['src/a.ts']));
  const units = [U('src/a.ts', 'f', 1, 10, [2, 3, 4]), U('src/a.ts', 'g', 11, 15, [12, 13]), U('src/a.ts', 'h', 16, 25, [17, 20])];
  const r = coverFlags(units, hits);
  assert.deepStrictEqual(r.flags, [{ path: 'src/a.ts', line: 3, name: 'f' }]); // g has no instrumented line, h is fully executed
  assert.strictEqual(r.noInst, 1);
});

test('hits resolve through a path prefix of another machine', () => {
  const hits = loadHits(parse(lcov('/home/ci/work/src/a.ts', [[2, 0]])), new Set(['src/a.ts']));
  assert.strictEqual(hits.get('src/a.ts').get(2), 0);
});

test('unusable rules in order, collection vs empty', () => {
  const hits = new Map([['src/a.ts', new Map([[2, 0]])]]), src = ['src/a.ts'], rec = { selected_tests: 3, file_errors: {} };
  assert.strictEqual(unusableReason({ rec, hits: null, changedSrc: src }), 'no_report');
  assert.strictEqual(unusableReason({ rec: null, hits, changedSrc: src }), 'no_report');
  assert.strictEqual(unusableReason({ rec: { ...rec, selected_tests: 0 }, hits, changedSrc: src }), 'no_selected_tests');
  assert.strictEqual(unusableReason({ rec, hits, changedSrc: ['src/b.ts'] }), 'covers_no_changed_file');
  const fe = (p, kind) => ({ ...rec, file_errors: { [p]: { kind, msg: 'x' } } });
  assert.strictEqual(unusableReason({ rec: fe('src/a.test.ts', 'collection'), hits, changedSrc: src }), 'collection_error');
  assert.strictEqual(unusableReason({ rec: fe('src/a.test.ts', 'empty'), hits, changedSrc: src }), null);
  assert.strictEqual(unusableReason({ rec: fe('src/a.test.ts', 'other'), hits, changedSrc: src }), null);
  assert.strictEqual(unusableReason({ rec: fe('lib/z.test.ts', 'collection'), hits, changedSrc: src }), null); // other module, other directory
  assert.strictEqual(unusableReason({ rec: fe('src/z.test.ts', 'collection'), hits, changedSrc: src }), 'collection_error'); // other module, same directory
});

test('error file in the source directory or the mirrored tests directory counts', () => {
  assert.ok(errCoversSource('src/x/other.test.ts', 'src/x/a.ts'));
  assert.ok(errCoversSource('libs/core/tests/unit_tests/runnables/test_z.py', 'libs/core/pkg/runnables/config.py'));
  assert.ok(errCoversSource('lib/test_utilsx.py', 'pkg/utils.py') === false);
});

test('collection rule: generic stems are not matched by name; flat test dirs match the file name', () => {
  for (const g of ['utils', 'index', '__init__', 'main', 'types', 'package']) assert.ok(!errCoversSource('lib/test_' + g + '.py', 'pkg/x/' + g + '.py'), g);
  assert.ok(errCoversSource('src/index.test.ts', 'src/index.ts')); // same directory still counts
  // flat dirs: sqlglot tests/ and langchain libs/core/tests/unit_tests/
  assert.ok(errCoversSource('tests/test_parser.py', 'sqlglot/parser.py'));
  assert.ok(!errCoversSource('tests/test_executor.py', 'sqlglot/parser.py'));
  assert.ok(errCoversSource('libs/core/tests/unit_tests/test_tools.py', 'libs/core/langchain_core/tools.py'));
  assert.ok(!errCoversSource('libs/core/tests/unit_tests/test_graph.py', 'libs/core/langchain_core/tools.py'));
});

test('evalCover: unusable gives outcome 0, usable catch gives 1', () => {
  const units = [U('src/a.ts', 'f', 1, 10, [2, 3])], B = makeB([{ path: 'src/a.ts', line: 3 }], { 'src/a.ts': [{ name: 'f', start: 1, end: 10 }] });
  const parsed = parse(lcov('src/a.ts', [[2, 1], [3, 0]])), base = { changedUnits: units, changedFiles: new Set(['src/a.ts']), B };
  assert.strictEqual(evalCover({ ...base, rec: { selected_tests: 1 }, parsed }).outcome, 1);
  const bad = evalCover({ ...base, rec: { selected_tests: 0 }, parsed });
  assert.deepStrictEqual([bad.usable, bad.outcome, bad.reason], [false, 0, 'no_selected_tests']);
});

// n PRs, each one unit that is (or is not) entirely inside B
const prs = (n, inB) => Array.from({ length: n }, () => {
  const u = U('a.ts', 'f', 1, 10, [2, 3, 4, 5, 6, 7, 8, 9, 10]);
  return { changedUnits: [u, U('a.ts', 'g', 11, 20, [12, 13, 14, 15, 16, 17, 18, 19, 20])], B: makeB(inB ? [{ path: 'a.ts', line: 5 }] : [{ path: 'a.ts', line: 50 }], { 'a.ts': [{ name: 'f', start: 1, end: 10 }, { name: 'g', start: 11, end: 20 }] }) };
});

test('unusable PR: observed 0 with a 1-flag null pulls lift down', () => {
  const d = prs(1, true)[0], usable = armScore([{ d, k: 1, outcome: 1, elig: el(d) }], opt), unusable = armScore([{ d, k: 1, outcome: 0, elig: el(d) }], opt);
  assert.strictEqual(unusable.observed, 0);
  assert.ok(unusable.chance > 0.3 && unusable.effect < 0); // one flag over two equal units: chance about 0.5
  assert.ok(usable.effect > unusable.effect);
});

test('PASS boundary: needs p < 0.05 and effect >= 0.10', () => {
  const d = prs(1, true)[0];
  // 40 PRs, 1 flag each over 2 equal-weight units (chance 0.5): all caught is far above chance
  const hi = armScore(Array.from({ length: 40 }, () => ({ d, k: 1, outcome: 1, elig: el(d) })), opt);
  assert.ok(hi.pass && hi.p < 0.05 && hi.effect >= 0.10);
  // at chance: observed 0.5 is no pass
  const mid = armScore(Array.from({ length: 40 }, (_, i) => ({ d, k: 1, outcome: i % 2, elig: el(d) })), opt);
  assert.ok(!mid.pass);
  // significant but small: 40 PRs, chance 0.5, observed 0.55 -> effect < 0.10 even if p were small
  const lo = armScore(Array.from({ length: 400 }, (_, i) => ({ d, k: 1, outcome: i % 20 < 11 ? 1 : 0, elig: el(d) })), opt);
  assert.ok(lo.p < 0.05 && lo.effect < 0.10 && !lo.pass);
});

test('flag-everything arm gets chance equal to observed', () => {
  const [d] = prs(1, true), items = Array.from({ length: 20 }, () => ({ d, k: 2, outcome: 1, elig: el(d) })); // 2 units, both flagged, one in B
  const r = armScore(items, opt);
  assert.strictEqual(r.observed, 1);
  assert.strictEqual(r.chance, r.observed);
  assert.ok(!r.pass);
});

test('comparison 4 labels', () => {
  const hits = new Map([['a.ts', new Map([[1, 0], [2, 3]])]]);
  assert.strictEqual(labelLine(hits, 'a.ts', 1), 'confirmed');
  assert.strictEqual(labelLine(hits, 'a.ts', 2), 'contradicted');
  assert.strictEqual(labelLine(hits, 'a.ts', 9), 'unknown');
  assert.strictEqual(labelLine(hits, 'b.ts', 1), 'unknown');
  assert.strictEqual(labelLine(null, 'a.ts', 1), 'unknown');
});

test('2 eligible units both flagged, one in B: null hits in every permutation (both nulls)', () => {
  const [d] = prs(1, true), rng = () => 0.3;
  for (const uni of [false, true]) assert.ok(drawNull(rng, 50, 2, el(d), d.B, uni, 1).every((b) => b === 1));
});

test('distinct units: k=1 over 2 equal units hits B half the time; never double-draws', () => {
  const [d] = prs(1, true), b = drawNull(require('../szz').mulberry32(7), 2000, 1, el(d), d.B, true, 0);
  assert.ok(Math.abs(b.reduce((s, x) => s + x, 0) / 2000 - 0.5) < 0.05);
});

test('unusable PR with 1 changed unit inside B: observed 0, null still tests B', () => {
  const d = { changedUnits: [U('a.ts', 'f', 1, 10, [2, 3, 4])], B: makeB([{ path: 'a.ts', line: 3 }], { 'a.ts': [{ name: 'f', start: 1, end: 10 }] }) };
  const r = armScore([{ d, k: 1, outcome: 0, elig: el(d), forced: true }], opt);
  assert.strictEqual(r.observed, 0);
  assert.strictEqual(r.chance, 1);
});

// ---- discriminating tests (each fails under one of the five mutations in the report) ----
test('(a,d) unequal units: primary chance about 0.1, secondary about 0.5, verdict uses secondary', () => {
  const B = { has: (p, l) => p === 'a.ts' && l <= 5 }, units = [U('a.ts', 'f', 1, 2, [2]), U('a.ts', 'g', 20, 30, [20, 21, 22, 23, 24, 25, 26, 27, 28])];
  const d = { changedUnits: units, B }, items = Array.from({ length: 60 }, () => ({ d, k: 1, outcome: 0, elig: el(d) }));
  const r = armScore(items, { perms: 400, boots: 20 });
  assert.ok(Math.abs(r.primary.chance - 0.1) < 0.04, 'primary ' + r.primary.chance);
  assert.ok(Math.abs(r.secondary.chance - 0.5) < 0.05, 'secondary ' + r.secondary.chance);
  assert.strictEqual(r.verdict_null, 'secondary');
});

test('(b) ties count: p is the share of null >= observed', () => {
  const d = prs(1, true)[0], r = armScore([{ d, k: 2, outcome: 1, elig: el(d) }], opt); // both units flagged, null = observed in every permutation
  assert.strictEqual(r.p, 1);
  assert.strictEqual(r.pass, false);
});

test('(c) the null flag line is drawn from the eligible lines, not always the first', () => {
  const B = { has: (p, l) => l >= 15 }, u = (n) => U('a.ts', n, 10, 19, [10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
  const d = { changedUnits: [u('f'), U('b.ts', 'g', 10, 19, [10, 11, 12, 13, 14, 15, 16, 17, 18, 19])], B };
  const bits = drawNull(require('../szz').mulberry32(3), 2000, 1, el(d), B, true, 0);
  const share = bits.reduce((s, x) => s + x, 0) / 2000;
  assert.ok(Math.abs(share - 0.5) < 0.05, 'share ' + share);
});

test('(e) summarize end to end with an unusable item: observed 0, 1-flag null on a single unit in B', () => {
  const units = [U('a.ts', 'f', 1, 10, [2, 3, 4])], B = makeB([{ path: 'a.ts', line: 3 }], { 'a.ts': [{ name: 'f', start: 1, end: 10 }] });
  const d = { changedUnits: units, B }, mk = (id, c) => ({ id, repo: 'x/y', rec: { deps_changed: false, health: { exit_code: 1 }, file_errors: { 't.py': { kind: 'other' } } }, d, c, sflags: [] });
  const bad = evalCover({ rec: null, parsed: null, changedUnits: units, changedFiles: new Set(['a.ts']), B });
  const s = summarize([mk('p1', bad)], { ...opt, seed: 20261020, powerN: 5, sims: 20 });
  assert.strictEqual(s.unusable.count, 1);
  assert.strictEqual(s.c.observed, 0);
  assert.strictEqual(s.c.chance, 1);
  assert.strictEqual(s.c_minus_static.prs_unusable_for_c, 1);
  assert.ok(s.power_c && s.power_c.n === 5 && s.power_c.sims === 20);
  const good = evalCover({ rec: { selected_tests: 1, health: { exit_code: 1, timed_out: true }, file_errors: { 't.py': { kind: 'other' } } }, parsed: parse(lcov('a.ts', [[2, 1], [3, 0]])), changedUnits: units, changedFiles: new Set(['a.ts']), B });
  const s2 = summarize([mk('p2', good)], opt);
  assert.strictEqual(s2.unusable.count, 0);
  assert.strictEqual(s2.usable_suite_health.with_other_errors, 1);
  assert.strictEqual(s2.usable_suite_health.nonzero_exit_code, 1);
  assert.strictEqual(s2.by_deps_changed_usable_only.false.prs, 1);
});

test('power: share of resampled sims that PASS; empty is null', () => {
  const d = prs(1, true)[0], items = Array.from({ length: 10 }, () => ({ d, k: 1, outcome: 1, elig: el(d) }));
  assert.strictEqual(powerOf(items, { perms: 200 }, 40, 30).pass_share, 1);
  const none = Array.from({ length: 10 }, () => ({ d, k: 1, outcome: 0, elig: el(d) }));
  assert.strictEqual(powerOf(none, { perms: 200 }, 40, 30).pass_share, 0);
  assert.strictEqual(powerOf([], opt, 40, 30), null);
});

test('median: upper middle for even n, null when no usable control; run validity', () => {
  assert.strictEqual(medianUpper([1, 5]), 5);
  assert.strictEqual(medianUpper([4, 1, 9]), 4);
  assert.strictEqual(medianUpper([]), null);
  assert.ok(runValid({ engine_status: 'success', findings: [] }));
  assert.ok(!runValid({ engine_status: 'success', findings: [], valid: false }));
  assert.ok(!runValid({ engine_status: 'success', findings: [], engine_notes: ['context pack: 0 files'] }));
  assert.ok(!runValid(null));
});
