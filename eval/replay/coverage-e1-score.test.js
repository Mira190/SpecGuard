const test = require('node:test');
const assert = require('node:assert');
const { parse } = require('../../src/coverage');
const { makeB } = require('./testgap-score');
const { loadHits, coverFlags, errCoversSource, unusableReason, evalCover, armScore, labelLine, drawNull } = require('./coverage-e1-score');

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
  assert.ok(errCoversSource('tests/test_utils.py', 'pkg/utils.py'));
  assert.ok(!errCoversSource('lib/test_utilsx.py', 'pkg/utils.py'));
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
