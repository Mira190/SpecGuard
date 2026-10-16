// Code-first part of the unit test gap scan: unit_findings in the schema, validation, verification, confirmation, state and the summary (audit-post.js), the collector's files (audit-collect.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const audit = require('./audit-post');
const { validate, verify, render, readUnits, readState, stateOf, trackFindings } = audit;
const { sha8: unitId } = require('./audit-units');
const sha8 = (...p) => require('node:crypto').createHash('sha1').update(p.join('\n')).digest('hex').slice(0, 8); // finding ids (variadic, as in audit-post.js); unit ids hash the path alone
const { collect } = require('./audit-collect');
const { strict } = require('./engines/claude-api');

const SCHEMA = JSON.parse(fs.readFileSync(path.join(__dirname, 'audit.schema.json'), 'utf8'));
const DATE = '2026-10-14';
const FILES = {
  'src/js/orders.js': ['exports.create = (o) => o;', 'exports.cancel = (o) => ({ ...o, on: false });', 'exports.total = (o) => o.items.length;'],
  'src/js/legacy.js': ['module.exports = function legacy(a) {', '  return a * 2;', '};'],
  'src/js/cart.js': ['export function add(c, i) { return [...c, i]; }', 'export const count = (c) => c.length;', 'export default add;'],
  'test/orders.test.js': ["it('creates', () => {", '  assert.ok(create({}));', '});'],
  'test/e2e/checkout.test.js': ["it('checks out', async () => {", "  const res = await request(app).post('/checkout');", '  assert.equal(res.body.total, 12);', '});'],
  'docs/design.md': ['# Plan design', '', 'A repeating plan stays on after it fires.', 'A plan must start in the future.'],
};
const read = (p) => FILES[p] || null;
const U1 = unitId('src/js/orders.js'), U2 = unitId('src/js/legacy.js'), U3 = unitId('src/js/cart.js');
const UNITS = () => readUnits([[U1, 'src/js/orders.js', 54.2, '1 weak assertion, 2 fix commits in 180 days', 'test/orders.test.js', 'weak? test/orders.test.js:2'], [U2, 'src/js/legacy.js', 21.5, 'no test', 'none', '-'], [U3, 'src/js/cart.js', 9, '3 public definitions', 'none', '-']].map((r) => r.join('\t')).join('\n') + '\n');
const cite = (p, line) => ({ path: p, line, quote: FILES[p][line - 1].trim() });
const uf = (over = {}) => ({ unit: U2, kind: 'missing_test', ...cite('src/js/legacy.js', 1), title: 'legacy doubles its argument', body: 'No test checks the doubled result.', skeleton: "it('doubles', () => {\n  assert.equal(legacy(2), 4);\n});", ...over });
const WEAK = () => uf({ unit: U1, kind: 'weak_test', ...cite('test/orders.test.js', 2), title: 'create is only checked to be truthy', body: 'assert.ok(create({})) passes for any object.', counterexample: 'create({}) returns { broken: true } -> assert.ok still passes', skeleton: "it('rejects an empty order', () => {\n  assert.throws(() => create({}));\n});" });
const PUSH = () => uf({ unit: U1, kind: 'pushdown', ...cite('test/e2e/checkout.test.js', 3), title: 'the total is computed in an e2e test', body: 'A unit test of total() could prove it.', skeleton: '' });
const result = (fs_ = [uf()], over = {}) => ({ docs_reviewed: [], requirements: [], not_requirements: [], not_reviewed: [], unit_findings: fs_, ...over });
const clone = (o) => JSON.parse(JSON.stringify(o));
const ROW = (id, p, score, why, tests, review = 'this run') => ({ id, path: p, score, why, tests, loc: 20, public: 2, churn: 3, fixes: 1, review });
const INV = (over = {}) => ({ head: 'abc123', max_units: 12, units: 140, with_tests: 100, without_tests: 40, skipped_tests: 9, tests_without_assertion: 3, weak_assertions: 4,
  selected: { units: 3, without_tests: 2, skipped_tests: 5, tests_without_assertion: 1, weak_assertions: 1 }, rotation: { rotate: false, picked: 3, confirming: 0, new: 3, oldest: 0, reviewed: 3, total: 140, run: 1, runs: 12 }, shallow: false, limitations: [],
  rows: [ROW(U1, 'src/js/orders.js', 54.2, '1 weak assertion, 2 fix commits in 180 days', ['test/orders.test.js']), ROW(U2, 'src/js/legacy.js', 21.5, 'no test', []), ROW(U3, 'src/js/cart.js', 9, '3 public definitions', []), ROW('99999999', 'src/js/other.js', 3, 'no test', [], 'not yet reviewed')],
  unreviewed: [{ id: '99999999', path: 'src/js/other.js', score: 3 }], ...over });
const CODE = (findings, over = {}) => ({ list: UNITS(), inv: INV(over), findings });
const checked = (fs_, o = {}) => verify(result(fs_), { read, units: UNITS(), ...o });
const BLOB = 'https://github.com/o/r/blob/abc';

test('schema: unit_findings is required, its rows need unit, kind, path, line, quote and title, and the strict form for structured output keeps it', () => {
  assert.ok(SCHEMA.required.includes('unit_findings'));
  const item = SCHEMA.properties.unit_findings.items;
  assert.deepEqual(item.required, ['unit', 'kind', 'path', 'line', 'quote', 'title']);
  assert.deepEqual(item.properties.kind.enum, ['missing_test', 'weak_test', 'pushdown']);
  assert.ok(item.properties.body && item.properties.skeleton && !item.required.includes('body') && !item.required.includes('skeleton'));
  const s = strict(SCHEMA).properties.unit_findings.items;
  assert.equal(s.additionalProperties, false);
  assert.equal(s.properties.quote.minLength, undefined, 'bounds are dropped for the structured-output grammar');
  assert.deepEqual(s.required, item.required);
});

test('validate: a result without documents needs no requirements; rows name a listed unit, a known kind and the citation fields; a bad row is dropped with a note, never a rejection', () => {
  const o = { docs_reviewed: [], not_requirements: [], not_reviewed: [], unit_findings: [uf(), { ...uf(), unit: 'ffffffff' }, uf({ kind: 'Weak Test', unit: U1, ...cite('test/orders.test.js', 2) }), uf({ kind: 'nonsense' }), uf({ title: '  ' }), uf({ line: '0' }), 'x', uf({ unit: U2.toUpperCase(), quote: 'q'.repeat(300) })] };
  const v = validate(o, new Map(), UNITS());
  assert.deepEqual(v, { ok: true });
  assert.deepEqual(o.requirements, []);
  assert.deepEqual(o.unit_findings.map((f) => [f.unit, f.kind]), [[U2, 'missing_test'], [U1, 'weak_test'], [U2, 'missing_test']]);
  assert.equal(o.unit_findings[2].quote.length, 200);
  assert.equal(o.not_reviewed.length, 5);
  assert.match(o.not_reviewed.join('\n'), /unit_findings\[1\] dropped: unknown unit ffffffff; only the listed units may be reviewed\./);
  assert.match(o.not_reviewed.join('\n'), /unit_findings\[3\] dropped: kind must be one of missing_test, weak_test, pushdown\./);
  assert.match(o.not_reviewed.join('\n'), /unit_findings\[4\] dropped: path, line, quote and title are required\./);
  assert.match(o.not_reviewed.join('\n'), /unit_findings\[6\] dropped: not an object\./);
  // absent or malformed unit_findings: an older result, and a result that is not an array
  const old = { docs_reviewed: [], requirements: [], not_requirements: [], not_reviewed: [] };
  assert.equal(validate(old, new Map(), UNITS()).ok, true);
  assert.deepEqual(old.unit_findings, []);
  const odd = { ...clone(old), unit_findings: 'none' };
  assert.equal(validate(odd, new Map(), UNITS()).ok, true);
  assert.match(odd.not_reviewed[0], /unit_findings was not an array; ignored/);
  // no unit was listed: every finding names an unknown unit; unknown list (null): the shape is checked only
  const none = { ...clone(old), unit_findings: [uf()] };
  validate(none, new Map(), new Map());
  assert.deepEqual(none.unit_findings, []);
  const blind = { ...clone(old), unit_findings: [uf()] };
  validate(blind, new Map(), null);
  assert.equal(blind.unit_findings.length, 1);
  // a document scan still needs its requirements array
  assert.equal(validate({ docs_reviewed: [], not_requirements: [], not_reviewed: [] }, new Map([['1111111a', {}]]), UNITS()).ok, false);
  const many = { ...clone(old), unit_findings: Array.from({ length: 70 }, (_, i) => uf({ title: `t${i}` })) };
  validate(many, new Map(), UNITS());
  assert.equal(many.unit_findings.length, 60);
});

test('verify: the quote must sit at path:line (a near line is corrected); the kind decides which file may be cited; duplicates collapse; a placeholder skeleton is dropped', () => {
  const out = checked([uf(), uf({ line: 3 }), uf({ title: 'again', line: 2, quote: FILES['src/js/legacy.js'][0] }), WEAK(), PUSH(),
    uf({ quote: 'this line is not in the file at all' }), uf({ quote: 'short' }), uf({ ...cite('test/orders.test.js', 2) }), WEAK() && { ...WEAK(), ...cite('src/js/orders.js', 1) }, uf({ ...cite('docs/design.md', 3) }),
    uf({ unit: U3, ...cite('src/js/cart.js', 1), skeleton: 'it("x", () => { expect(<the expected value>).toBe(1); });' })]);
  const rows = out.unit_findings;
  assert.deepEqual(rows.map((f) => [f.unit === U2 ? 'legacy' : f.unit === U1 ? 'orders' : 'cart', f.kind, f.path, f.line]), [
    ['legacy', 'missing_test', 'src/js/legacy.js', 1], ['orders', 'weak_test', 'test/orders.test.js', 2], ['orders', 'pushdown', 'test/e2e/checkout.test.js', 3], ['cart', 'missing_test', 'src/js/cart.js', 1]]);
  assert.equal(out.unit_findings[0].line, 1, 'the near-miss line 3 was corrected, and it is the same finding as line 1');
  assert.match(out.not_reviewed.join('\n'), /unit finding "legacy doubles its argument" \(src\/js\/legacy\.js:1\): the quote was not found at the cited line/);
  assert.match(out.not_reviewed.join('\n'), /the quote is under 12 characters/);
  assert.match(out.not_reviewed.join('\n'), /a missing_test cites the unit's code, not a test or a document/);
  assert.match(out.not_reviewed.join('\n'), /a weak_test cites a test file/);
  assert.equal(rows[3].skeleton, '', 'a skeleton with a placeholder is omitted');
  assert.match(out.not_reviewed.join('\n'), /skeleton omitted: placeholder/);
  for (const f of rows) assert.match(f.fid, /^[0-9a-f]{8}$/);
  assert.equal(rows[0].fid, sha8(U2, 'missing_test', 'module exports function legacy a'), 'the key is the unit, the kind and the normalised quote');
});

test('verify: a missing_test on a unit with no matched test file is deterministic; one on a unit whose tests were cut from the pack, or a weak_test on a cut file, is low confidence', () => {
  const a = checked([uf(), uf({ unit: U3, ...cite('src/js/cart.js', 2), title: 'count is untested' }), uf({ unit: U1, ...cite('src/js/orders.js', 1), title: 'create is untested' })]).unit_findings;
  assert.deepEqual(a.map((f) => [f.confirmed, f.low]), [[undefined, false], [undefined, false], [undefined, false]], 'no matched test file is no longer a confirmation: the verdict waits for a second run');
  const cut = checked([uf({ unit: U1, ...cite('src/js/orders.js', 1), title: 'create is untested' }), WEAK(), PUSH()], { packCut: new Set(['test/orders.test.js']) }).unit_findings;
  assert.deepEqual(cut.map((f) => [f.kind, f.low]), [['missing_test', true], ['weak_test', true], ['pushdown', false]]);
  const other = checked([WEAK()], { packCut: new Set(['some/other.js']) }).unit_findings;
  assert.equal(other[0].low, false);
});

test('a unit reviewed in parts (review F07): a finding outside this run\'s lines is dropped; the state keeps other parts\' findings, is unsure until the last part, then covered, and moves the cursor', () => {
  const unitsAt = (spec) => readUnits(`${U2}\tsrc/js/legacy.js\t9\tno test\tnone\t-\tabcdef12\t${spec}\n`);
  assert.deepEqual(unitsAt('part 2/2 lines 2-3').get(U2).part, { k: 1, n: 2, a: 2, b: 3 });
  const out = verify(result([uf()]), { read, units: unitsAt('part 2/2 lines 2-3') });
  assert.deepEqual(out.unit_findings, [], 'line 1 is not in this run\'s part');
  assert.match(out.not_reviewed.join('\n'), /outside this run's part of the unit \(lines 2-3\)/);
  const v = verify(result([uf()]), { read, units: unitsAt('part 1/2 lines 1-2') });
  assert.deepEqual(v.unit_findings.map((f) => [f.line, f.part]), [[1, 0]]);
  const parts = (k) => new Map([[U2, { k, n: 2, a: 1, b: 2 }]]);
  // part 1: one finding; part 2 (next run): none new, the part-1 finding is kept, the unit stays a gap; with none anywhere the last part makes it covered
  const one = readState(stateOf('a1', result([]), null, { date: DATE, code: { picked: [U2], findings: trackFindings(v.unit_findings, null, 'a1'), carried: [], parts: parts(0) } }).raw);
  assert.deepEqual([one.blocks[0].status, one.versions.uc, one.findings.map((f) => f.part)], ['gap', { [U2]: [1, 2] }, [0]]);
  const two = readState(stateOf('b2', result([]), one, { date: DATE, code: { picked: [U2], findings: [], carried: [], parts: parts(1) } }).raw);
  assert.deepEqual([two.blocks[0].status, two.versions && two.versions.uc, two.findings.map((f) => f.part)], ['gap', undefined, [0]], 'cursor done; the other part\'s finding stays');
  const clean1 = readState(stateOf('a1', result([]), null, { date: DATE, code: { picked: [U2], findings: [], carried: [], parts: parts(0) } }).raw);
  assert.equal(clean1.blocks[0].status, 'unsure', 'one part seen: not covered yet');
  assert.equal(readState(stateOf('b2', result([]), clean1, { date: DATE, code: { picked: [U2], findings: [], carried: [], parts: parts(1) } }).raw).blocks[0].status, 'covered');
});

test('verify: a weak_test without a concrete wrong behaviour the assertion still accepts is low confidence with the reason (review F04)', () => {
  const { counterexample, ...noCe } = WEAK();
  const [vague] = checked([noCe]).unit_findings;
  assert.deepEqual([vague.low, vague.lowWhy], [true, 'no concrete wrong behaviour that the assertion still accepts']);
  assert.equal(checked([WEAK()]).unit_findings[0].low, false);
  assert.match(render({ code: CODE(checked([WEAK()]).unit_findings), head: 'abc123' }), /Still passes when: create\(\{\}\) returns \{ broken: true \} -(&gt;|>) assert\.ok still passes/);
});

test('verify: a missing_test whose cited line a tracked test already contains (covers) is low confidence with the reason, not deterministic; other kinds are not searched', () => {
  const seen = [];
  const covers = (lines, line) => { seen.push(line); return 'test/orders.test.js:7'; };
  const out = checked([uf(), uf({ unit: U1, ...cite('src/js/orders.js', 1), title: 'create is untested' }), WEAK()], { covers }).unit_findings;
  assert.deepEqual(out.map((f) => [f.kind, f.low, f.lowWhy]), [['missing_test', true, 'a test may already cover this: test/orders.test.js:7'], ['missing_test', true, 'a test may already cover this: test/orders.test.js:7'], ['weak_test', false, undefined]]);
  assert.equal(seen.length, 2);
  assert.equal(checked([uf()], { covers: () => null }).unit_findings[0].low, false);
});

test('confirmation: a finding is confirmed by the same (unit, kind, quote) in the previous run, never at once', () => {
  const [det, weak] = checked([uf(), WEAK()]).unit_findings;
  const first = trackFindings([det, weak], null, 'abcdef1234');
  assert.deepEqual(first.map((f) => f.confirmed), [false, false]);
  assert.deepEqual(first.map((f) => f.next), [[det.fid, U2, 'abcdef1', 1], [weak.fid, U1, 'abcdef1', 1]]);
  const prior = { head: 'abcdef1', blocks: [], findings: [{ fid: weak.fid, unit: U1, since: 'abcdef1', runs: 1 }, { fid: det.fid, unit: U2, since: 'abcdef1', runs: 1 }] };
  const second = trackFindings([det, weak], prior, '1234567890');
  assert.deepEqual(second.map((f) => f.confirmed), [true, true]);
  assert.deepEqual(second[1].next, [weak.fid, U1, 'abcdef1', 2], 'since keeps the first commit');
  const reworded = trackFindings([{ ...weak, fid: sha8(U1, 'weak_test', 'a different line') }], prior, 'x');
  assert.equal(reworded[0].confirmed, false, 'another quote is another finding');
  assert.equal(trackFindings([weak], { head: 'a', blocks: [], findings: [{ fid: weak.fid, unit: U1, since: 'a', runs: 3 }] }, 'x')[0].next[3], 3, 'runs stop at the cap');
});

test('state: units ride as block entries and their findings as an optional f; an old reader ignores f, an invalid f is dropped and not the state', () => {
  const [det, weak] = checked([uf(), WEAK()]).unit_findings;
  const tracked = trackFindings([det, weak], null, 'abcdef1234');
  const raw = stateOf('abcdef1234', result([], { requirements: [] }), null, { date: DATE, code: { picked: [U1, U2], findings: tracked, carried: [] } }).raw;
  const st = readState(raw);
  assert.deepEqual(st.blocks.map((b) => [b.cid, b.status, b.runs, b.at.date]), [[U1, 'gap', 1, DATE], [U2, 'gap', 1, DATE]]);
  assert.deepEqual(st.findings.map((f) => [f.fid, f.unit, f.since, f.runs]), [[det.fid, U2, 'abcdef1', 1], [weak.fid, U1, 'abcdef1', 1]]);
  assert.ok(!raw.includes('--') || !/-->.*-->/.test(raw), 'the comment stays closed');
  const quiet = stateOf('abcdef1234', result([]), null, { date: DATE, code: { picked: [U3], findings: [], carried: [] } });
  assert.deepEqual(readState(quiet.raw).blocks.map((b) => [b.cid, b.status]), [[U3, 'covered']]);
  assert.equal(readState(quiet.raw).findings, undefined, 'no findings: the old state shape');
  const bad = raw.replace(/"f":\[\[/, '"f":[["zz",');
  const dropped = readState(bad);
  assert.equal(dropped.blocks.length, 2);
  assert.equal(dropped.findings, undefined);
  assert.equal(stateOf('a', result([]), null, { date: DATE }).raw.includes('"f"'), false, 'a document-only scan writes the old shape');
});

test('state: a unit gap seen once is picked again; a finding of a unit not reviewed this run is carried, one of a unit reviewed now and not found again is dropped; a unit gone from the repository leaves the state', () => {
  const first = stateOf('aaaaaaa1', result([]), null, { date: '2026-10-01', code: { picked: [U1, U2, U3], findings: trackFindings(checked([uf(), WEAK(), uf({ unit: U3, ...cite('src/js/cart.js', 2), title: 'count' })]).unit_findings, null, 'aaaaaaa1'), carried: [] } });
  const prior = readState(first.raw);
  assert.equal(prior.findings.length, 3);
  // run 2 reviews only U1 (its weak finding is found again) and U2 (its finding is gone); U3 is carried; U3's finding stays; an old unit entry that is no longer carried disappears
  const f2 = trackFindings(checked([WEAK()]).unit_findings, prior, 'bbbbbbb2');
  const second = stateOf('bbbbbbb2', result([]), prior, { date: '2026-10-08', code: { picked: [U1, U2], findings: f2, carried: prior.blocks.filter((b) => b.cid === U3) } });
  const st = readState(second.raw);
  assert.deepEqual(st.blocks.map((b) => [b.cid, b.status, b.runs, b.at.date]), [[U1, 'gap', 2, '2026-10-08'], [U2, 'covered', 1, '2026-10-08'], [U3, 'gap', 1, '2026-10-01']]);
  assert.deepEqual(st.findings.map((f) => [f.unit, f.runs]).sort(), [[U1, 2], [U3, 1]].sort());
  // review F06: versions are recorded for the units reviewed now and kept for carried ones; a carried unit that changed since (stale) loses its old findings
  const withVer = readState(stateOf('aaaaaaa1', result([]), null, { date: '2026-10-01', code: { picked: [U1, U2, U3], findings: trackFindings(checked([uf({ unit: U3, ...cite('src/js/cart.js', 2), title: 'count' })]).unit_findings, null, 'aaaaaaa1'), carried: [], versions: new Map([[U1, '11111111'], [U3, '33333333']]) } }).raw);
  assert.deepEqual(withVer.versions.uv, { [U1]: '11111111', [U3]: '33333333' });
  const carry = (stale) => readState(stateOf('bbbbbbb2', result([]), withVer, { date: '2026-10-08', stale, code: { picked: [U1], findings: [], carried: withVer.blocks.filter((b) => b.cid === U3), versions: new Map([[U1, '1111111f']]) } }).raw);
  assert.deepEqual([carry(new Set()).findings.length, carry(new Set()).versions.uv], [1, { [U1]: '1111111f', [U3]: '33333333' }]);
  assert.equal(carry(new Set([U3])).findings, undefined, 'stale: the old finding may no longer apply');
  assert.equal(carry(new Set([U3])).versions.uv[U3], '33333333', 'the old version stays, so the unit stays stale until it is reviewed');
  const third = stateOf('ccccccc3', result([]), st, { date: '2026-10-15', code: { picked: [U3], findings: [], carried: [] } });
  assert.deepEqual(readState(third.raw).blocks.map((b) => b.cid), [U3], 'U1 and U2 are not carried (gone from the repository), so they leave the state');
  assert.equal(readState(third.raw).findings, undefined);
  assert.equal(audit.stateComment('x', result([]), null, { date: DATE, code: { picked: [], findings: [], carried: [] } }).includes('audit-state'), true);
});

test('render: no design documents, two findings: verdict, counts table, sections with icon and count, one collapsed Details, the cost line last', () => {
  const data = checked([uf(), WEAK(), PUSH()]);
  const md = render({ data, code: CODE(data.unit_findings), blob: BLOB, head: 'abc1234def', usage: '<sub>Cost $0.12 · haiku-5.5 · 21k tokens · 40s</sub>', run: 'Run: engine claude' });
  const vis = md.slice(0, md.indexOf('<details>'));
  assert.match(vis, /^## SpecGuard scan\n\n\*\*❌ 2 unit test gaps and 1 test to move down in the 3 riskiest units\*\* at `abc1234`\. Static review; tests were not run\.\n\n/);
  assert.match(vis, /\| Units reviewed \| No unit test \| Weak tests \| Skipped tests \| Design documents \|\n\|---\|---\|---\|---\|---\|\n\| 3 of 140 \| 1 \| 1 \| 5 \| none found \|\n/);
  assert.match(vis, /### Untested behaviour \(1\)\n\n- \[legacy doubles its argument\]\(https:\/\/github\.com\/o\/r\/blob\/abc\/src\/js\/legacy\.js#L1\) `src\/js\/legacy\.js:1` \(first report\) — No test checks the doubled result\.\n/);
  assert.match(vis, /assert\.equal\(legacy\(2\), 4\);/, 'the skeleton of a top finding is visible');
  assert.match(vis, /### Weak unit tests \(1\)\n\n- \[create is only checked to be truthy\]\(https:\/\/github\.com\/o\/r\/blob\/abc\/test\/orders\.test\.js#L2\) `test\/orders\.test\.js:2` \(first report\) — /);
  assert.match(vis, /### Tests to move down \(1\)\n\n- \[the total is computed in an e2e test\]/);
  assert.ok(vis.indexOf('Untested behaviour') < vis.indexOf('Weak unit tests') && vis.indexOf('Weak unit tests') < vis.indexOf('Tests to move down'));
  assert.doesNotMatch(vis, /missing_test|weak_test|pushdown|No design documents|nothing was scanned/);
  assert.equal((md.match(/<details><summary>Details/g) || []).length, 1);
  const det = md.slice(md.indexOf('<details>'));
  assert.match(det, /<summary>Details: riskiest units, inventory, rotation, document blocks, sources<\/summary>/);
  assert.match(det, /\*\*Riskiest units \(top 4 of 140\)\*\*\n\n\| Unit \| Risk \| Why \| Matched tests \| Review \|\n\|---\|---\|---\|---\|---\|\n\| \[src\/js\/orders\.js\]\(https:\/\/github\.com\/o\/r\/blob\/abc\/src\/js\/orders\.js#L1\) \| 54\.2 \| 1 weak assertion, 2 fix commits in 180 days \| test\/orders\.test\.js \| this run \|\n/);
  assert.match(det, /\| \[src\/js\/legacy\.js\]\([^)]*\) \| 21\.5 \| no test \| none \| this run \|/);
  assert.match(det, /\*\*Inventory\*\*\n\n140 source files \(units\), 100 with a matched test file and 40 without\. The matched tests hold 9 skipped tests, 3 tests without an assertion and 4 weak assertions\./);
  assert.match(det, /3 of the 3 selected units were reviewed whole. Schedule with scan_issue: true to rotate through all units\./);
  assert.match(det, /\*\*Units not yet reviewed \(137\)\*\*\n\n- \[src\/js\/other\.js\]\([^)]*\) \(risk 3\)\n- \+122 more\n/);
  assert.match(det, /\*\*How to read the unit part\*\*[\s\S]*risk is \(1 \+ public definitions\) times log2\(2 \+ lines \/ 50\)[\s\S]*not a prediction of defects[\s\S]*every finding is a first report/);
  assert.doesNotMatch(md, /Sub-row|This scan\*\*|How to read this scan|requirements\*\* from/, 'no document statistics when there are no documents');
  assert.equal(md.trimEnd().split('\n').pop(), '<sub>Cost $0.12 · haiku-5.5 · 21k tokens · 40s</sub>');
  assert.ok(md.lastIndexOf('<sub>Cost') > md.lastIndexOf('</details>'));
  assert.match(det, /Run: engine claude\n\n<\/details>/);
});

test('render: clean and person-check verdicts never claim the repository is tested; one unit reads singular; an incomplete scan has no counts table', () => {
  const none = checked([]);
  const clean = render({ data: none, code: CODE([]), head: 'abc1234def' });
  assert.match(clean, /^## SpecGuard scan\n\n\*\*✅ No unit test gaps in the 3 riskiest units\*\* at `abc1234`\. Static review; tests were not run\.\n\n\| Units reviewed \| No unit test \| Weak tests \| Skipped tests \| Design documents \|\n\|---\|---\|---\|---\|---\|\n\| 3 of 140 \| none \| none \| 5 \| none found \|\n\n<details>/);
  assert.doesNotMatch(clean, /fully tested|well tested|sufficient/);
  assert.equal(clean.slice(0, clean.indexOf('<details>')).includes('###'), false);
  const one = render({ data: none, code: CODE([], { rotation: { rotate: false, picked: 1, confirming: 0, new: 1, oldest: 0, reviewed: 1, total: 1, run: 1, runs: 1 } }) });
  assert.match(one, /\*\*✅ No unit test gaps in the riskiest unit\*\*/);
  const part = render({ data: checked([uf()]), code: CODE(checked([uf()]).unit_findings), partial: 'engine timeout' });
  assert.match(part, /\*\*⚠️ Incomplete scan: 1 unit test gap in the 3 riskiest units found so far\*\*/);
  assert.doesNotMatch(part, /\| Units reviewed \|/);
  assert.match(part, /> \*\*Incomplete scan\.\*\*/);
  const empty = render({ data: checked([]), code: CODE([]), partial: 'engine timeout' });
  assert.match(empty, /\*\*⚠️ Incomplete scan: no unit test gaps found so far\*\*/);
  const failed = render({ failure: 'the engine timed out', code: CODE([]) });
  assert.match(failed, /\*\*⚠️ Could not complete: the engine timed out\*\*/);
  assert.doesNotMatch(failed, /Units reviewed/);
});

test('render: a low-confidence finding is Details only and not counted; the rotation shows in the table and Details; confirmed findings carry no tag', () => {
  const data = checked([uf(), WEAK()], { packCut: new Set(['test/orders.test.js']) });
  const md = render({ data, code: CODE(data.unit_findings, { rotation: { rotate: true, picked: 3, confirming: 1, new: 2, oldest: 0, reviewed: 24, total: 140, run: 2, runs: 12 } }), blob: BLOB, prior: { head: 'abcdef1', blocks: [], findings: [] } });
  const vis = md.slice(0, md.indexOf('<details>'));
  assert.match(vis, /\*\*❌ 1 unit test gap in the 3 riskiest units\*\*/);
  assert.match(vis, /\| 3 of 140 \(rotation 2 of 12\) \| 1 \| none \| 5 \| none found \|/);
  assert.doesNotMatch(vis, /create is only checked/);
  assert.match(vis, /\(first report\)/, 'a missing test on a unit without a test file is a first report like any other');
  assert.match(vis, /Sketch, not run:/);
  const det = md.slice(md.indexOf('<details>'));
  assert.match(det, /\*\*Low-confidence unit findings \(1\)\*\*\n\nA test file the model could not see whole, or a test that may already cover it, is behind each; they are not counted\.\n\n- \[create is only checked to be truthy\]\([^)]*\) `test\/orders\.test\.js:2` \(low confidence\)/);
  assert.match(det, /Rotation: 24 of 140 units reviewed at least once; this run reviewed 3 \(confirming 1, never reviewed 2, least recently reviewed 0\)\. A full cycle takes 12 runs of 12 units\./);
  assert.match(det, /the same finding was reported in the previous run;/, 'with a state the first-run sentence is not shown');
});

test('render: a second run confirms the finding it saw before; the verdict counts the same either way', () => {
  const data = checked([WEAK()]);
  const first = render({ data, code: CODE(data.unit_findings), blob: BLOB });
  assert.match(first, /\(first report\)/);
  const prior = { head: 'abcdef1', blocks: [], findings: [{ fid: data.unit_findings[0].fid, unit: U1, since: 'abcdef1', runs: 1 }] };
  const second = render({ data, code: CODE(data.unit_findings, { rotation: { rotate: true, picked: 3, confirming: 0, new: 3, oldest: 0, reviewed: 3, total: 140, run: 1, runs: 12 } }), blob: BLOB, prior });
  assert.doesNotMatch(second.slice(0, second.indexOf('<details>')), /first report/);
  assert.match(second, /\*\*❌ 1 unit test gap in the 3 riskiest units\*\*/);
});

test('render: more than 15 findings of a kind: the rest are one-line items in Details; the top three keep their skeleton visible and the rest fold it', () => {
  const rows = Array.from({ length: 18 }, (_, i) => uf({ title: `behaviour ${i}`, quote: `module.exports = function legacy(a) {   // ${i}`.slice(0, 41) }));
  const data = { ...checked([]), unit_findings: rows.map((f, i) => ({ ...f, ...cite('src/js/legacy.js', 1), fid: sha8('x', String(i)), low: false })) };
  const md = render({ data, code: CODE(data.unit_findings), blob: BLOB });
  const main = md.indexOf('<details><summary>Details'), vis = md.slice(0, main);
  assert.match(vis, /### Untested behaviour \(18\)/);
  assert.match(vis, /\+8 more in Details\./);
  assert.equal((vis.match(/- \[behaviour \d+\]/g) || []).length, 10, 'ten are listed');
  assert.equal((vis.slice(0, vis.indexOf('<summary>Full text')).match(/assert\.equal\(legacy\(2\), 4\);/g) || []).length, 3, 'the top three skeletons are open');
  assert.equal((vis.match(/<summary>Full text<\/summary>/g) || []).length, 7, 'the other skeletons are folded');
  assert.match(md.slice(main), /\*\*More untested behaviour \(8 more\)\*\*[\s\S]*behaviour 17/);
});

test('render: with design documents both parts show: the verdict names both, the table counts the documents, the document sections follow the unit sections', () => {
  const doc = { docs_reviewed: ['docs/design.md'], requirements: [{ id: '1111111a', source: cite('docs/design.md', 3), text: 'A repeating plan stays on after it fires.', class: 'unit', status: 'missing_test', code: [cite('src/js/orders.js', 1)], tests: [], note: '' }], not_requirements: [], not_reviewed: [], unit_findings: [uf()] };
  const data = verify(doc, { read, units: UNITS(), docs: new Set(['docs/design.md']), cands: new Map([['1111111a', { cid: '1111111a', path: 'docs/design.md', line: 3, heading: 'Plan design', text: 'A repeating plan stays on after it fires.' }]]) });
  const md = render({ data, code: CODE(data.unit_findings), blob: BLOB, docs: [['docs/design.md', 'discovered']], head: 'abc1234def' });
  assert.match(md, /\*\*❌ 1 unit test gap in the 3 riskiest units; 1 new gap \(first report\) in the design documents\*\* at `abc1234`/);
  assert.match(md, /\| 3 of 140 \| 1 \| none \| 5 \| 1 read \|/);
  const vis = md.slice(0, md.indexOf('<details>'));
  assert.ok(vis.indexOf('### Untested behaviour') < vis.indexOf('### New gaps'));
  assert.match(md, /\*\*This scan\*\*\n\n\*\*1 requirement\*\* from 1 document/);
  assert.match(md, /Details: riskiest units, inventory, rotation, document blocks, sources/);
});

test('render: text that SpecGuard writes is English and repository text sits only in quoted or code positions; markup in model text is neutralised', () => {
  const ZH = '重复计划触发后保持开启';
  const cjk = /[぀-ヿ㐀-鿿가-힯豈-﫿]/;
  const data = { ...checked([]), unit_findings: [{ ...uf(), title: `${ZH} <img src=x> @team`, body: `<!-- hidden --> ${ZH}.`, skeleton: `it('${ZH}', () => {});`, fid: sha8('z'), low: false, det: true }] };
  const md = render({ data, code: CODE(data.unit_findings), blob: BLOB });
  assert.ok(cjk.test(md));
  assert.doesNotMatch(md, /<img|<!--|@team/);
  assert.doesNotMatch(md.split(ZH).join(''), cjk);
});

test('render: the report stays under the size limit by dropping whole Details rows, never a visible section', () => {
  const rows = Array.from({ length: 100 }, (_, i) => ROW(sha8(`f${i}`), `src/long/path/to/file${i}.js`, 50 - i / 10, 'no test', []));
  const data = checked([uf(), WEAK()]);
  const small = render({ data, code: CODE(data.unit_findings, { rows, units: 400 }), blob: BLOB, max: 3600 });
  assert.ok(Buffer.byteLength(small) <= 3600, String(Buffer.byteLength(small)));
  assert.match(small.slice(0, small.indexOf('<details>')), /### Untested behaviour/);
  assert.match(small, /_\d+ rows? omitted: the report exceeded the size limit/);
  for (const l of small.split('\n').filter((x) => /^\| \[src\/long/.test(x))) assert.match(l, /\|$/);
});

// ---- the collector ----
function repoOf(t, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'specguard-code-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const git = (...a) => execFileSync('git', ['-c', 'core.autocrlf=false', ...a], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init'); git('config', 'user.name', 't'); git('config', 'user.email', 't@example.invalid');
  for (const [f, ls] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true }); fs.writeFileSync(path.join(root, f), (Array.isArray(ls) ? ls.join('\n') : ls) + '\n'); }
  git('add', '.'); git('commit', '-m', 'init');
  return { root, ctx: path.join(root, '.specguard-ctx'), git };
}
const CODE_ONLY = { 'src/js/orders.js': FILES['src/js/orders.js'], 'src/js/legacy.js': FILES['src/js/legacy.js'], 'test/orders.test.js': FILES['test/orders.test.js'] };

test('collect: a repository without design documents still gets its units, inventory and meta; the scan is not skipped', (t) => {
  const { root, ctx } = repoOf(t, CODE_ONLY);
  const r = collect({ cwd: root, ctx, maxUnits: 5 });
  assert.equal(r.docs.length, 0);
  assert.deepEqual([r.units.total, r.units.picked.length], [2, 2]);
  const units = fs.readFileSync(path.join(ctx, 'audit-units.txt'), 'utf8').split('\n').filter(Boolean).map((l) => l.split('\t'));
  assert.deepEqual(units.map((u) => u[1]).sort(), ['src/js/legacy.js', 'src/js/orders.js']);
  assert.equal(units[0][1], 'src/js/legacy.js', 'the untested unit ranks first');
  assert.equal(units[0][3], 'no test');
  const meta = JSON.parse(fs.readFileSync(path.join(ctx, 'audit-meta.json'), 'utf8'));
  assert.deepEqual([meta.max_units, meta.units, meta.docs], [5, { total: 2, picked: 2 }, 0]);
  const inv = JSON.parse(fs.readFileSync(path.join(ctx, 'audit-inventory.json'), 'utf8'));
  assert.deepEqual([inv.units, inv.with_tests, inv.without_tests, inv.rotation.rotate], [2, 1, 1, false]);
  assert.equal(fs.readFileSync(path.join(ctx, 'audit-candidates.txt'), 'utf8'), '');
  const cli = (env) => spawnSync(process.execPath, [path.join(__dirname, 'audit-collect.js')], { cwd: root, encoding: 'utf8', env: { ...process.env, CTX: ctx, GITHUB_REF_NAME: '', GITHUB_EVENT_PATH: '', ...env } });
  const out = path.join(root, 'out.txt');
  assert.equal(cli({ GITHUB_OUTPUT: out }).status, 0);
  assert.equal(fs.readFileSync(out, 'utf8'), 'skip=false\n', 'units alone keep the scan going');
  assert.match(cli({}).stdout, /SpecGuard unit test gap scan: 2 of 2 units, 0 design document\(s\)/);
});

test('collect: max_units caps the selection (riskiest first); with a scan state the units rotate; scan_paths limits the units', (t) => {
  const files = { ...CODE_ONLY, 'src/js/cart.js': FILES['src/js/cart.js'], 'pkg/a/x.js': ['exports.x = 1;', 'exports.y = 2;', 'exports.z = 3;'] };
  const { root, ctx } = repoOf(t, files);
  const one = collect({ cwd: root, ctx, maxUnits: 1 });
  assert.equal(one.units.picked.length, 1);
  assert.equal(one.units.total, 4);
  assert.equal(one.units.rotation.runs, 4);
  const prior = { head: 'x', blocks: [{ cid: one.units.picked[0], status: 'covered', runs: 1, since: 'x', at: { date: '2026-10-01' } }] };
  const next = collect({ cwd: root, ctx, maxUnits: 1, prior, rotate: true });
  assert.notEqual(next.units.picked[0], one.units.picked[0], 'the unit reviewed last time rests');
  assert.equal(next.units.rotation.rotate, true);
  assert.equal(fs.readFileSync(path.join(ctx, 'audit-units-carried.txt'), 'utf8').trim().split('\t')[0], one.units.picked[0]);
  const scoped = collect({ cwd: root, ctx, maxUnits: 9, scanPaths: 'pkg/**' });
  assert.deepEqual(fs.readFileSync(path.join(ctx, 'audit-units.txt'), 'utf8').split('\n').filter(Boolean).map((l) => l.split('\t')[1]), ['pkg/a/x.js']);
  assert.equal(scoped.units.total, 1);
});

test('collect CLI: max_units must be an integer from 1 to 100; a repository with neither documents nor units is skipped', (t) => {
  const { root, ctx } = repoOf(t, CODE_ONLY);
  const cli = (cwd, env) => spawnSync(process.execPath, [path.join(__dirname, 'audit-collect.js')], { cwd, encoding: 'utf8', env: { ...process.env, CTX: ctx, GITHUB_REF_NAME: '', GITHUB_EVENT_PATH: '', ...env } });
  for (const bad of ['0', '101', 'x', '-1', '2.5']) { const r = cli(root, { MAX_UNITS: bad }); assert.equal(r.status, 1, bad); assert.match(r.stdout, /::error::max_units must be an integer from 1 to 100/); }
  assert.equal(cli(root, { MAX_UNITS: '100' }).status, 0);
  assert.equal(cli(root, { MAX_UNITS: '' }).status, 0, 'empty means the default 12');
  const none = repoOf(t, { 'README.md': '# nothing\n', 'a.js': 'x\n' });
  const out = path.join(none.root, 'o.txt');
  cli(none.root, { CTX: none.ctx, GITHUB_OUTPUT: out });
  assert.equal(fs.readFileSync(out, 'utf8'), 'skip=true\n');
  assert.equal(fs.existsSync(path.join(none.ctx, 'audit-units.txt')), false, 'no units: no unit files');
});

// ---- the whole post step ----
function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'specguard-code-post-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const git = (...a) => execFileSync('git', ['-c', 'core.autocrlf=false', ...a], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init'); git('config', 'user.name', 't'); git('config', 'user.email', 't@example.invalid');
  for (const [f, ls] of Object.entries(FILES)) { fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true }); fs.writeFileSync(path.join(root, f), ls.join('\n') + '\n'); }
  git('add', '.'); git('commit', '-m', 'x');
  const ctx = path.join(root, '.specguard-ctx');
  fs.mkdirSync(ctx);
  return { root, ctx, put: (n, v) => fs.writeFileSync(path.join(ctx, n), typeof v === 'string' ? v : JSON.stringify(v)) };
}
function mocks({ issues = [] } = {}) {
  const calls = { created: [], updated: [], summary: '', warnings: [], outputs: {} };
  const github = { paginate: async (fn) => fn(), rest: { users: { getAuthenticated: async () => { throw new Error('no /user'); } }, issues: { listForRepo: () => issues, create: async (a) => { calls.created.push(a); }, update: async (a) => { calls.updated.push(a); } } } };
  const core = { warning: (m) => calls.warnings.push(m), setOutput: (k, v) => { calls.outputs[k] = v; }, summary: { addRaw(s) { calls.summary = s; return this; }, async write() {} } };
  return { github, core, calls, context: { repo: { owner: 'o', repo: 'r' }, sha: 'abc123' } };
}
const BOT = { type: 'Bot', login: 'github-actions[bot]' };
async function post(t, { files = {}, env = {}, issues = [], w = workspace(t) } = {}) {
  w.put('audit-meta.json', { head: 'abc123', max_requirements: 80, max_units: 12, docs: 0, limitations: [], units: { total: 140, picked: 3 } });
  w.put('audit-units.txt', [...UNITS().values()].map((u) => [u.id, u.path, u.score, u.why, u.tests.join(', ') || 'none', u.leads].join('\t')).join('\n') + '\n');
  w.put('audit-inventory.json', INV());
  for (const [n, v] of Object.entries(files)) w.put(n, v);
  const m = mocks({ issues });
  const saved = { ...process.env };
  Object.assign(process.env, { CTX: w.ctx, GITHUB_WORKSPACE: w.root, ENGINE: '', MODEL: '', SKIP: '', SCAN_ISSUE: '', AUDIT_ISSUE: '', ...env });
  try { await audit({ github: m.github, context: m.context, core: m.core, date: DATE }); } finally { for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]; Object.assign(process.env, saved); }
  return { ...m, w };
}

test('run: a scan without design documents validates the unit findings at HEAD, renders them, writes audit.json and the unit state into the scan issue', async (t) => {
  const r = await post(t, { env: { SCAN_ISSUE: 'true', ENGINE: 'claude', MODEL: 'claude-haiku-5-5' }, files: { 'findings.json': result([uf(), WEAK(), uf({ quote: 'not in the file anywhere' })]), 'usage.json': { currentModel: 'claude-haiku-5-5', totalCostUsd: 0.12 } } });
  assert.match(r.calls.summary, /\*\*❌ 2 unit test gaps in the 3 riskiest units\*\* at `abc123`/);
  assert.match(r.calls.summary, /\n<sub>Cost \$0\.12 · /);
  assert.match(r.calls.summary, /unit finding "legacy doubles its argument" \(src\/js\/legacy\.js:1\): the quote was not found/);
  const saved = JSON.parse(fs.readFileSync(path.join(r.w.ctx, 'audit.json'), 'utf8'));
  assert.equal(saved.unit_findings.length, 2);
  assert.deepEqual(r.calls.outputs, { status: 'complete' });
  assert.equal(r.calls.created.length, 1);
  const body = r.calls.created[0].body;
  assert.match(body, /^<!-- specguard:audit -->\n## SpecGuard scan/);
  const st = readState(body);
  assert.deepEqual(st.blocks.map((b) => [b.cid, b.status]).sort(), [[U1, 'gap'], [U2, 'gap'], [U3, 'covered']].sort());
  assert.equal(st.findings.length, 2);
  // the next run (same findings) reads that state: the weak finding is confirmed and the rows are not duplicated
  const again = await post(t, { env: { SCAN_ISSUE: 'true' }, files: { 'findings.json': result([uf(), WEAK()]), 'audit-meta.json': { head: 'def456', max_requirements: 80, docs: 0, limitations: [], units: { total: 140, picked: 3 }, rotation: null } },
    issues: [{ number: 7, state: 'open', title: audit.TITLE, user: BOT, body }] });
  assert.doesNotMatch(again.calls.summary.slice(0, again.calls.summary.indexOf('<details>')), /unconfirmed/);
  assert.equal(again.calls.updated.length, 1);
  assert.deepEqual(readState(again.calls.updated[0].body).findings.map((f) => f.runs).sort(), [2, 2]);
});

test('run: a unit finding about an unlisted unit, or a result with neither requirements nor unit_findings, is handled without rejecting the scan', async (t) => {
  const r = await post(t, { files: { 'findings.json': { docs_reviewed: [], not_requirements: [], not_reviewed: [], unit_findings: [{ ...uf(), unit: 'abababab' }] } } });
  assert.match(r.calls.summary, /\*\*✅ No unit test gaps in the 3 riskiest units\*\*/);
  assert.match(r.calls.summary, /unit_findings\[0\] dropped: unknown unit abababab/);
  const old = await post(t, { files: { 'findings.json': { docs_reviewed: [], not_requirements: [], not_reviewed: [] } } });
  assert.match(old.calls.summary, /\*\*✅ No unit test gaps in the 3 riskiest units\*\*/);
  assert.deepEqual(old.calls.outputs, { status: 'complete' });
});

test('run: the claude engine pack cut a test file: a missing_test claim about its unit stays out of the counts', async (t) => {
  const f = uf({ unit: U1, ...cite('src/js/orders.js', 1), title: 'create is untested' });
  const r = await post(t, { files: { 'findings.json': result([f]), 'pack-cut.txt': 'test/orders.test.js\n' } });
  assert.match(r.calls.summary, /\*\*⚠️ Incomplete scan: no gaps found so far\*\*/);
  assert.match(r.calls.summary, /\*\*Low-confidence unit findings \(1\)\*\*[\s\S]*create is untested/);
});

test('run: a scan with documents and units runs the document audit too; units without findings still count as reviewed', async (t) => {
  const w = workspace(t);
  w.put('audit-docs.txt', 'docs/design.md\tdiscovered\n');
  w.put('audit-candidates.txt', '1111111a\tdocs/design.md:3\tPlan design\tA repeating plan stays on after it fires.\n');
  const doc = { id: '1111111a', source: cite('docs/design.md', 3), text: 'A repeating plan stays on after it fires.', class: 'unit', status: 'covered', code: [cite('src/js/orders.js', 1)], tests: [{ ...cite('test/orders.test.js', 2), layer: 'unit' }], note: '' };
  const r = await post(t, { w, files: { 'findings.json': { docs_reviewed: ['docs/design.md'], requirements: [doc], not_requirements: [], not_reviewed: [], unit_findings: [] }, 'audit-meta.json': { head: 'abc123', max_requirements: 80, max_units: 12, docs: 1, candidates: 1, limitations: [], units: { total: 140, picked: 3 } } } });
  assert.match(r.calls.summary, /\*\*✅ No unit test gaps in the 3 riskiest units\*\*/);
  assert.match(r.calls.summary, /\| 3 of 140 \| none \| none \| 5 \| 1 read \|/);
  assert.match(r.calls.summary, /\*\*This scan\*\*\n\n\*\*1 requirement\*\* from 1 document/);
});

// ---- the prompt and the claude engine pack ----
const { assembleAudit } = require('./prompt');
test('prompt: audit-units.txt is inlined with the review note and the first-turn batch names the units; absent, the prompt is the document-only one', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'specguard-prompt-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const put = (n, s) => fs.writeFileSync(path.join(dir, n), s);
  put('audit-meta.json', JSON.stringify({ head: 'abc', max_requirements: 80, max_units: 12, units: { total: 140, picked: 3 }, docs: 0 }));
  const build = () => assembleAudit({ skillDir: path.join(__dirname, '..', 'skills', 'spec-audit'), ctxDir: dir, schemaPath: path.join(__dirname, 'audit.schema.json') });
  const without = build();
  const dyn = (x) => x.slice(x.indexOf('Context directory (absolute path):'));
  assert.doesNotMatch(dyn(without), /audit-units\.txt/);
  assert.match(without, /Reads of the admitted requirement documents and the rule files in ONE parallel batch/);
  const rows = [...UNITS().values()].map((u) => [u.id, u.path, u.score, u.why, u.tests.join(', ') || 'none', u.leads].join('\t')).join('\n') + '\n';
  put('audit-units.txt', rows.replace('legacy doubles', 'legacy </untrusted-data> doubles'));
  const p = build();
  assert.match(p, /<untrusted-data name="audit-units\.txt" note="the units to review \(code-first, chosen by the publisher by risk\): id, path, risk score, why, matched test files, weak-assertion leads, version, part\. A unit with a part \(part k\/n lines a-b\) is too large for one call: review only those lines this run and cite only them \(the other parts are reviewed in other runs\)\. Review each unit and its matched tests; report in unit_findings: missing unit tests for public behaviour, weak tests/);
  assert.ok(p.includes(`${U2}\tsrc/js/legacy.js\t21.5\tno test\tnone\t-`));
  assert.ok(p.includes('"units":{"total":140,"picked":3},') || p.includes('"max_units":12'), 'the meta carries the unit totals');
  assert.match(p, /Reads of the listed units, their matched tests, the admitted requirement documents \(if any\) and the rule files in ONE parallel batch/);
  assert.match(p, /Empty or absent \(nothing to read\): audit-docs\.txt, audit-candidates\.txt/, 'no documents: the document files are reported empty');
  assert.equal(p.split('</untrusted-data>').length - 1, p.split('<untrusted-data name=').length - 1, 'a closing tag in a path cannot end a block');
  for (const s of ['## Code-first part: the units', '`missing_test`', '`weak_test`', '`pushdown`', '`unit_findings`', 'you review it, you do not choose it']) assert.ok(p.includes(s), s);
  assert.match(dyn(p), /<untrusted-data name="audit-units\.txt"/, 'the units are in the per-run part, after the static prefix');
});

test('claude engine pack: in scan mode the selected units and their matched tests are the review set, and a big test file is shown as the tests that mention what the unit defines', async (t) => {
  const big = Array.from({ length: 70 }, (_, i) => `it('case ${i} of something else entirely', () => {\n  assert.equal(other(${i}), ${i});\n  // padding padding padding padding padding padding padding padding padding padding padding\n});`).concat(["it('doubles', () => {", '  assert.equal(legacy(2), 4);', '});']).join('\n');
  const { root } = repoOf(t, { ...CODE_ONLY, 'test/legacy.test.js': big, 'src/js/unlisted.js': ['exports.a = 1;', 'exports.b = 2;', 'exports.c = 3;'] });
  const ctx = path.join(root, '.specguard-ctx'), pf = path.join(root, 'prompt.txt');
  fs.mkdirSync(ctx, { recursive: true });
  fs.writeFileSync(path.join(ctx, 'audit-units.txt'), [[U2, 'src/js/legacy.js', 21.5, 'no test', 'test/legacy.test.js', '-'], [U1, 'src/js/orders.js', 54.2, 'x', 'test/orders.test.js', '-']].map((r) => r.join('\t')).join('\n') + '\n');
  fs.writeFileSync(pf, 'STATIC\n\n---\n\nContext directory (absolute path): /ctx\nUNITS\n');
  const sent = [];
  const fetchFn = async (url, init) => { sent.push(JSON.parse(init.body)); return { status: 200, ok: true, headers: { get: () => null }, text: async () => JSON.stringify({ type: 'message', model: 'claude-haiku-5-5', stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(result([])) }], usage: { input_tokens: 1000, output_tokens: 10 } }) }; };
  const log = console.log; console.log = () => {};
  try { await require('./engines/claude-api.js').run({ CTX: ctx, PROMPT_FILE: pf, ANTHROPIC_API_KEY: 'sk-ant-api03-TESTONLY_0123456789-abcdef', MODEL: 'claude-haiku-5-5', TIMEOUT: '5', CHECK: 'audit', GITHUB_WORKSPACE: root, CONTEXT_PACK_BYTES: '60000' }, { fetchFn }); } finally { console.log = log; }
  assert.equal(sent.length, 1);
  const user = sent[0].messages[0].content;
  assert.match(user, /<untrusted-data name="src\/js\/legacy\.js"[^>]*>/);
  assert.match(user, /<untrusted-data name="src\/js\/orders\.js"/);
  assert.match(user, /<untrusted-data name="test\/orders\.test\.js"/);
  assert.match(user, /<untrusted-data name="test\/legacy\.test\.js" note="relevant slices: lines [^"]*tests referencing legacy[^"]*"/);
  assert.ok(user.includes('assert.equal(legacy(2), 4);'), 'the test block that mentions the unit is shown');
  assert.ok(!user.includes('case 35 of something else'), 'a block that mentions none of its symbols is not');
  assert.ok(user.indexOf('src/js/legacy.js') < user.indexOf('test/legacy.test.js'), 'a unit, then its tests');
  assert.equal(fs.readFileSync(path.join(ctx, 'pack-cut.txt'), 'utf8'), '', 'every test that mentions the unit was visible: nothing was cut');
  assert.equal(JSON.parse(fs.readFileSync(path.join(ctx, 'findings.json'), 'utf8')).unit_findings.length, 0);
});

test('render: a unit reviewed in parts says which part this run reviewed (review F07)', () => {
  const code = { ...CODE([]), list: readUnits(`${U2}\tsrc/js/legacy.js\t21.5\tno test\tnone\t-\tabcdef12\tpart 2/3 lines 101-200\n`) };
  assert.match(render({ data: result([]), code, head: 'abc1234' }), /\*\*Reviewed in parts\*\* \(too large for one call; one part per run\): `src\/js\/legacy\.js` part 2 of 3 \(lines 101-200\)\./);
});

test('claude engine pack: a unit reviewed in parts shows only this run\'s lines, with real line numbers, and is not listed as cut (review F07)', (t) => {
  const big = Array.from({ length: 300 }, (_, i) => `exports.f${i} = (x) => x + ${i};`);
  const { root } = repoOf(t, { ...CODE_ONLY, 'src/js/big.js': big });
  const ctx = path.join(root, '.specguard-ctx'); fs.mkdirSync(ctx, { recursive: true });
  fs.writeFileSync(path.join(ctx, 'audit-units.txt'), [unitId('src/js/big.js'), 'src/js/big.js', 9, 'no test', 'none', '-', 'abcdef12', 'part 2/3 lines 101-200'].join('\t') + '\n');
  const p = require('./engines/claude-api.js').contextPack(ctx, root, 200000);
  assert.match(p.text, /<untrusted-data name="src\/js\/big\.js" note="part 2 of 3: lines 101-200 of 300, line-numbered; the other parts are reviewed in other runs">\n 101\| exports\.f100 = /);
  assert.ok(p.text.includes(' 200| exports.f199 =') && !p.text.includes('exports.f99 =') && !p.text.includes('exports.f200 ='), 'only lines 101-200');
  assert.deepEqual(p.notWhole, []);
});

// ---- the action ----
test('action.yml: max_units (default 12) reaches the scan collector and the input validation; validate-inputs.sh accepts 1 to 100 only', () => {
  const yml = fs.readFileSync(path.join(__dirname, '..', 'action.yml'), 'utf8').replace(/\r\n/g, '\n');
  assert.match(/^ {2}max_units: \{[^}]*\}/m.exec(yml)[0], /most source files \(units\) reviewed per run, riskiest first \(integer 1-100\)[^}]*default: "12" \}$/);
  assert.match(yml, /id: audit_collect[\s\S]*?MAX_UNITS: \$\{\{ inputs\.max_units \}\}[\s\S]*?run: node "\$GITHUB_ACTION_PATH\/src\/audit-collect\.js"/);
  assert.match(yml, /MAX_UNITS: \$\{\{ inputs\.max_units \}\}\n {8}TIMEOUT: \$\{\{ inputs\.review_timeout_minutes \}\}\n {6}run: \|\n {8}bash "\$GITHUB_ACTION_PATH\/src\/validate-inputs\.sh"/);
  assert.equal((yml.match(/MAX_UNITS:/g) || []).length, 2, 'the PR steps do not read it');
  const bash = process.platform === 'win32' ? path.join(process.env.ProgramFiles, 'Git/bin/bash.exe') : 'bash';
  const v = (env) => spawnSync(bash, [path.join(__dirname, 'validate-inputs.sh').replace(/\\/g, '/')], { encoding: 'utf8', env: { ...process.env, MODEL: '', EFFORT: '', MAX_CREDITS: '200', ...env } });
  assert.equal(v({}).status, 0, 'unset: the default');
  for (const MAX_UNITS of ['1', '12', '100', '007']) assert.equal(v({ MAX_UNITS }).status, 0, MAX_UNITS);
  for (const MAX_UNITS of ['0', '101', 'x', '-1', '2.5', '1000']) { const r = v({ MAX_UNITS }); assert.equal(r.status, 1, MAX_UNITS); assert.match(r.stdout, /::error::max_units must be an integer from 1 to 100/); }
});

test('verify: a cut matched test makes a missing_test low only when it mentions the definition enclosing the cited line; an unreadable cut test or no name stays low', () => {
  const cutOf = (body, f = uf({ unit: U1, ...cite('src/js/orders.js', 2), title: 'cancel is untested' })) => checked([f], { packCut: new Set(['test/orders.test.js']), read: (p) => (p === 'test/orders.test.js' ? body : read(p)) }).unit_findings[0].low;
  assert.equal(cutOf(["it('creates', () => {", '  assert.ok(create({}));', '});']), false, 'the cut test never mentions cancel');
  assert.equal(cutOf(["it('cancels', () => {", '  assert.ok(cancel({}));', '});']), true, 'it mentions cancel');
  assert.equal(cutOf(null), true, 'a cut test that cannot be read');
});

test('run: units whose file the model did not see whole (pack-cut.txt) are not reviewed this run: listed visibly, not counted, not tracked, still due; without pack-cut.txt nothing changes', async (t) => {
  const env = { SCAN_ISSUE: 'true', ENGINE: 'claude' }, vis = (s) => s.slice(0, s.indexOf('<details>'));
  const r = await post(t, { env, files: { 'findings.json': result([uf()]), 'pack-cut.txt': 'src/js/cart.js\n' } });
  const v = vis(r.calls.summary);
  assert.match(v, /\*\*❌ 1 unit test gap in the 2 units that fit the model's context\*\*/);
  assert.match(v, /\| 2 of 140 \|/);
  assert.match(v, /\*\*Not reviewed this run:\*\* 1 unit did not fit the model's context: `src\/js\/cart\.js`\. It stays due for the next run\./);
  assert.deepEqual(readState(r.calls.created[0].body).blocks.map((b) => b.cid).sort(), [U1, U2].sort(), 'the unseen unit is not recorded as covered');
  const all = await post(t, { env, files: { 'findings.json': result([]), 'pack-cut.txt': 'src/js/orders.js\nsrc/js/legacy.js\nsrc/js/cart.js\n' } });
  assert.match(vis(all.calls.summary), /\*\*⚠️ The scan could not review any unit: none fit the model's context\*\*/);
  assert.doesNotMatch(vis(all.calls.summary), /✅/);
  const plain = await post(t, { env, files: { 'findings.json': result([uf()]) } });
  assert.doesNotMatch(plain.calls.summary, /Not reviewed this run/);
  assert.match(vis(plain.calls.summary), /in the 3 riskiest units/);
  assert.deepEqual(readState(plain.calls.created[0].body).blocks.map((b) => b.cid).sort(), [U1, U2, U3].sort());
});

test('run: blocks of a failed or dropped scan part are not rejected, not answered "unknown", not recorded as audited and listed as not audited; a failed unit call leaves the units unreviewed', async (t) => {
  const A = '1111111a', B = '2222222b', C = '3333333c';
  const doc = { id: A, source: cite('docs/design.md', 3), text: 'A repeating plan stays on after it fires.', class: 'unit', status: 'covered', code: [cite('src/js/orders.js', 1)], tests: [{ ...cite('test/orders.test.js', 2), layer: 'unit' }], note: '' };
  const meta = { head: 'abc123', max_requirements: 80, max_units: 12, docs: 1, candidates: 3, limitations: [], units: { total: 140, picked: 3 } };
  const w = workspace(t);
  w.put('audit-docs.txt', 'docs/design.md\tdiscovered\n');
  w.put('audit-candidates.txt', `${A}\tdocs/design.md:3\tPlan design\tA repeating plan stays on after it fires.\n${B}\tdocs/design.md:4\tPlan design\tSecond.\n${C}\tdocs/design.md:5\tPlan design\tThird.\n`);
  const run = (parts) => post(t, { w, env: { SCAN_ISSUE: 'true', ENGINE: 'claude' }, files: { 'findings.json': { docs_reviewed: ['docs/design.md'], requirements: [doc], not_requirements: [], not_reviewed: [], unit_findings: [] }, 'audit-meta.json': meta, 'scan-parts.json': parts } });
  const r = await run({ calls: 2, failed: [{ part: 'blocks', blocks: [B], reason: 'the answer was not a JSON object' }], dropped: [C] });
  assert.doesNotMatch(r.calls.summary, /Could not complete/); // one of three answered: the 20% rule applies to the blocks sent in a part that succeeded
  assert.match(r.calls.summary, /\*\*Not audited this run:\*\* 2 document blocks \(1 in a call that failed, 1 left out by max_budget_usd\)/);
  assert.deepEqual(r.calls.outputs, { status: 'incomplete', reason: '2 document blocks not audited' }, 'one part answered, the others did not: not complete');
  assert.match(r.calls.summary, /^## SpecGuard scan\n\n\*\*⚠️ Incomplete scan: no gaps found so far; 2 document blocks not audited \(a call failed, left out by max_budget_usd\)\*\*/);
  assert.doesNotMatch(r.calls.summary.split('\n')[2], /✅/);
  const out = JSON.parse(fs.readFileSync(path.join(w.ctx, 'audit.json'), 'utf8'));
  assert.deepEqual(out.requirements.map((x) => x.id), [A], 'no "unconfirmed" row for a block that was never sent or answered');
  const state = readState(r.calls.created[0].body);
  assert.deepEqual(state.blocks.map((b) => b.cid).filter((c) => [A, B, C].includes(c)), [A], 'only the answered block is recorded as audited');
  // the same blocks answered nothing without scan-parts.json: rejected as before
  const bad = await post(t, { w: workspace(t), files: { 'audit-docs.txt': 'docs/design.md\tdiscovered\n', 'audit-candidates.txt': `${A}\tdocs/design.md:3\tP\tx\n${B}\tdocs/design.md:4\tP\ty\n`, 'findings.json': { docs_reviewed: [], requirements: [doc], not_requirements: [], not_reviewed: [], unit_findings: [] }, 'audit-meta.json': meta } });
  assert.match(bad.calls.summary, /1 of 2 listed blocks were not answered/);
  // the unit call failed: no unit is reviewed (not counted), the wording says why
  w.put('audit-candidates.txt', `${A}\tdocs/design.md:3\tPlan design\tA repeating plan stays on after it fires.\n`);
  const u = await run({ calls: 2, failed: [{ part: 'units', reason: 'HTTP 500' }], dropped: [] });
  assert.match(u.calls.summary, /unit call failed/);
  assert.equal(u.calls.outputs.status, 'incomplete');
  assert.doesNotMatch(u.calls.summary, /did not fit the model's context/);
});

test('summary: a gap on a higher_level row asks for a component or integration test; a no-sketch finding is Details only and not counted; the riskiest list is capped at 15; the sketch is labelled', () => {
  const row = (cls, status) => ({ id: '1111111a', source: cite('docs/design.md', 3), text: 'Keyboard shortcuts move focus.', class: cls, status, code: [cite('src/js/orders.js', 1)], tests: status === 'partial' ? [{ ...cite('test/orders.test.js', 2), layer: cls === 'unit' ? 'unit' : 'component' }] : [], note: '' });
  const doc = (cls, status) => verify({ docs_reviewed: ['docs/design.md'], requirements: [row(cls, status)], not_requirements: [], not_reviewed: [], unit_findings: [] }, { read, units: UNITS(), docs: new Set(['docs/design.md']), cands: new Map([['1111111a', { cid: '1111111a', path: 'docs/design.md', line: 3, heading: 'H', text: 'Keyboard shortcuts move focus.' }]]) });
  const next = (cls, status) => render({ data: doc(cls, status), blob: BLOB, head: 'abc1234def' }).match(/\| (Add|Strengthen)[^|]*\|/)[0];
  assert.equal(next('higher_level', 'missing_test'), '| Add a component or integration test that checks it. |');
  assert.equal(next('higher_level', 'partial'), '| Strengthen the component or integration test: it checks only part of it. |');
  assert.equal(next('unit', 'missing_test'), '| Add a unit test that checks it. |');
  const data = checked([uf(), uf({ unit: U3, ...cite('src/js/cart.js', 1), title: 'cursorBoxes covered by unit tests; no gap found', skeleton: '' })]);
  assert.deepEqual(data.unit_findings.map((f) => [f.low, f.lowWhy]), [[false, undefined], [true, 'no test sketch: the finding may not be a gap']]);
  const rows = Array.from({ length: 30 }, (_, i) => ROW(sha8('r', String(i)), `src/js/f${i}.js`, 30 - i, 'no test', []));
  const md = render({ data, code: CODE(data.unit_findings, { rows }), blob: BLOB, head: 'abc1234def' });
  assert.match(md, /\*\*❌ 1 unit test gap in the/);
  assert.match(md, /Sketch, not run:\n/);
  assert.match(md, /Riskiest units \(top 15 of/);
  assert.equal((md.match(/\| \[src\/js\/f\d+\.js\]/g) || []).length, 15);
});

// ---- scan mode with the real cover guard (the PR-mode twin is eval/kite-fp.test.js) ----
const addFiles = (w, files) => { // extra tracked files in the temp repo: the guard greps git
  for (const [f, ls] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(w.root, f)), { recursive: true }); fs.writeFileSync(path.join(w.root, f), ls.join('\n') + '\n'); }
  execFileSync('git', ['add', '.'], { cwd: w.root }); execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-m', 'y'], { cwd: w.root, stdio: 'ignore' });
};
const scanFinding = (id, files, p, line, title) => ({ unit: id, kind: 'missing_test', path: p, line, quote: files[p][line - 1].trim(), title, body: 'No test checks it.', skeleton: "it('works', () => {\n  assert.equal(f(1), 2);\n});" });

test('run: scan mode with the real guard downgrades a wrapper that delegates to a unit-tested helper, and keeps the untested one (recall control)', async (t) => {
  const extra = {
    'src/engine/filename.js': ['function isDirectChild(dir, p) {', '  return p.startsWith(dir);', '}', 'function labelOf(name) {', '  return name.trim();', '}'],
    'test/filename.test.js': ["it('is a direct child', () => {", "  assert.ok(isDirectChild('a/', 'a/b'));", '});'],
    'src/app.js': ["const ownFile = (p) => typeof p === 'string' && E.isDirectChild(dirOf(), p) && MEDIA_EXT.test(p);", '', '', '', '', "const titleOf = (clip) => 'Kite - ' + E.labelOf(clip.name);"],
  };
  const w = workspace(t); addFiles(w, extra);
  const A = unitId('src/app.js');
  w.put('audit-units.txt', [A, 'src/app.js', 30, 'no test', 'none', '-'].join('\t') + '\n');
  w.put('audit-inventory.json', INV({ rows: [ROW(A, 'src/app.js', 30, 'no test', [])], selected: { units: 1, without_tests: 1, skipped_tests: 0, tests_without_assertion: 0, weak_assertions: 0 } }));
  const r = await post(t, { w, files: { 'findings.json': result([scanFinding(A, extra, 'src/app.js', 1, 'ownFile is untested'), scanFinding(A, extra, 'src/app.js', 6, 'titleOf is untested')]), 'audit-units.txt': [A, 'src/app.js', 30, 'no test', 'none', '-'].join('\t') + '\n' } });
  const rows = JSON.parse(fs.readFileSync(path.join(w.ctx, 'audit.json'), 'utf8')).unit_findings;
  assert.equal(rows.length, 2);
  const [own, title] = rows;
  assert.equal(own.low, true);
  assert.match(own.lowWhy, /a delegated helper is tested: isDirectChild at test\/filename\.test\.js:\d+/);
  assert.equal(title.low, false, 'labelOf has no test: still a deterministic gap');
  assert.match(r.calls.summary, /\*\*❌ 1 unit test gap in the /);
});

test('run: TEST_PATHS reaches the scan post step: a file under a non-test directory then counts as a test that already holds the literal', async (t) => {
  const MSG = 'order total must be positive';
  const extra = { 'src/pay.js': [`if (t <= 0) throw new Error('${MSG}');`, 'exports.ok = 1;'], 'qa/checks/orders.js': ['// expects', `check('${MSG}');`] };
  const P = unitId('src/pay.js');
  const run = async (env) => {
    const w = workspace(t); addFiles(w, extra);
    await post(t, { w, env, files: { 'findings.json': result([scanFinding(P, extra, 'src/pay.js', 1, 'pay rejects a bad total')]), 'audit-units.txt': [P, 'src/pay.js', 30, 'no test', 'none', '-'].join('\t') + '\n' } });
    return JSON.parse(fs.readFileSync(path.join(w.ctx, 'audit.json'), 'utf8')).unit_findings[0];
  };
  const on = await run({ TEST_PATHS: 'qa/checks' });
  assert.equal(on.low, true);
  assert.match(on.lowWhy, /a test may already cover this: qa\/checks\/orders\.js:2/);
  assert.equal((await run({})).low, false, 'without TEST_PATHS the directory is not a test location');
});

test('chained: the real collector writes the ctx files and the post step reads them; a finding on the untested unit counts, one on an unselected unit is dropped', async (t) => {
  const { root, ctx } = repoOf(t, CODE_ONLY);
  collect({ cwd: root, ctx, maxUnits: 1 }); // only the riskiest unit (legacy, no test) is selected
  const picked = fs.readFileSync(path.join(ctx, 'audit-units.txt'), 'utf8').trim().split('\t');
  assert.deepEqual([picked[0], picked[1]], [U2, 'src/js/legacy.js']);
  fs.writeFileSync(path.join(ctx, 'findings.json'), JSON.stringify(result([uf(), uf({ unit: U1, ...cite('src/js/orders.js', 1), title: 'create is untested' })])));
  const m = mocks();
  const saved = { ...process.env };
  Object.assign(process.env, { CTX: ctx, GITHUB_WORKSPACE: root, ENGINE: '', MODEL: '', SKIP: '', SCAN_ISSUE: '', AUDIT_ISSUE: '' });
  try { await audit({ github: m.github, context: m.context, core: m.core, date: DATE }); } finally { for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]; Object.assign(process.env, saved); }
  assert.match(m.calls.summary, /\*\*❌ 1 unit test gap in the /);
  assert.ok(m.calls.summary.includes(`unit_findings[1] dropped: unknown unit ${U1}`));
  const rows = JSON.parse(fs.readFileSync(path.join(ctx, 'audit.json'), 'utf8')).unit_findings;
  assert.deepEqual(rows.map((r) => [r.unit, r.low]), [[U2, false]]);
  assert.equal(m.calls.outputs.status, 'complete');
});

test('run: a unit with an incomplete candidate test stays due instead of being saved as covered', async (t) => {
  const r = await post(t, { env: { SCAN_ISSUE: 'true', ENGINE: 'claude' }, files: {
    'findings.json': result([]), 'pack-cut.txt': 'test/orders.test.js\n',
  } });
  assert.equal(r.calls.outputs.status, 'incomplete');
  assert.ok(!readState(r.calls.created[0].body).blocks.some((b) => b.cid === U1));
  assert.match(r.calls.summary, /Not reviewed this run/);
});

test('run: a single call (20 blocks or fewer) hands blockCuts alone in scan-parts.json: a missing_test block whose evidence was cut ends unknown', async (t) => {
  const w = workspace(t), id = '1111111a';
  w.put('audit-docs.txt', 'docs/design.md\tdiscovered\n');
  w.put('audit-candidates.txt', `${id}\tdocs/design.md:3\tPlan design\tA repeating plan stays on after it fires.\n`);
  const doc = { id, source: cite('docs/design.md', 3), text: 'A repeating plan stays on after it fires.', class: 'unit', status: 'missing_test', code: [cite('src/js/orders.js', 1)], tests: [], note: 'No test was visible.' };
  const r = await post(t, { w, files: {
    'findings.json': result([], { docs_reviewed: ['docs/design.md'], requirements: [doc] }),
    'scan-parts.json': { blockCuts: { [id]: ['config/policy.yaml'] } },
    'audit-meta.json': { head: 'abc123', max_requirements: 80, docs: 1, candidates: 1, limitations: [] },
  } });
  const saved = JSON.parse(fs.readFileSync(path.join(r.w.ctx, 'audit.json'), 'utf8'));
  assert.equal(saved.requirements[0].status, 'unknown');
  assert.match(saved.requirements[0].note, /config\/policy.yaml/);
});

test('run: per-block context omissions reach the validated audit artifact', async (t) => {
  const w = workspace(t), id = '1111111a';
  w.put('audit-docs.txt', 'docs/design.md\tdiscovered\n');
  w.put('audit-candidates.txt', `${id}\tdocs/design.md:3\tPlan design\tA repeating plan stays on after it fires.\n`);
  const doc = { id, source: cite('docs/design.md', 3), text: 'A repeating plan stays on after it fires.', class: 'unit', status: 'missing_test', code: [cite('src/js/orders.js', 1)], tests: [], note: 'No test was visible.' };
  const r = await post(t, { w, files: {
    'findings.json': result([], { docs_reviewed: ['docs/design.md'], requirements: [doc] }),
    'scan-parts.json': { calls: 2, failed: [], dropped: [], blockCuts: { [id]: ['test/orders.test.js'] } },
    'audit-meta.json': { head: 'abc123', max_requirements: 80, docs: 1, candidates: 1, limitations: [] },
  } });
  const saved = JSON.parse(fs.readFileSync(path.join(r.w.ctx, 'audit.json'), 'utf8'));
  assert.equal(saved.requirements[0].status, 'unknown');
  assert.match(saved.requirements[0].note, /test\/orders.test.js/);
});

test('verifyUnits: test_paths decides which cited files are tests (F26): weak_test and pushdown may cite a configured path, missing_test may not; no scope keeps the name heuristic', () => {
  const files = { ...FILES, 'qa/checks/orders.js': ["check('creates', () => {", '  assert.ok(create({}));', '});'] };
  const rd = (p) => files[p] || null;
  const weak = () => uf({ unit: U1, kind: 'weak_test', path: 'qa/checks/orders.js', line: 2, quote: 'assert.ok(create({}));', title: 'create is only checked to be truthy', body: 'passes for any object', counterexample: 'create({}) returns a broken object -> still passes' });
  const n = (o) => verify(result([weak()]), { read: rd, units: UNITS(), ...o }).unit_findings.length;
  assert.equal(n({ testPaths: 'qa/checks/**' }), 1, 'a configured test path is a test');
  assert.equal(n({}), 0, 'control: without a scope the heuristic does not know qa/checks');
  const miss = uf({ unit: U1, kind: 'missing_test', path: 'qa/checks/orders.js', line: 2, quote: 'assert.ok(create({}));' });
  assert.equal(verify(result([miss]), { read: rd, units: UNITS(), testPaths: 'qa/checks/**' }).unit_findings.length, 0, 'missing_test cites code, not a configured test file');
  assert.equal(verify(result([PUSH()]), { read: rd, units: UNITS(), testPaths: 'qa/checks/**' }).unit_findings.length, 0, 'authoritative: test/e2e is outside the scope');
  assert.equal(verify(result([PUSH()]), { read: rd, units: UNITS() }).unit_findings.length, 1, 'control: heuristic');
});

test('funnel through the real collect -> pack -> audit-post path: 8 eligible = 7 inventoried + 1 over 512 KiB; 6 selected = 5 reviewed whole + 1 did not fit', async (t) => {
  const fn = (n, k) => Array.from({ length: k }, (_, i) => `exports.${n}${i} = (v) => (v > ${i} ? v - ${i} : ${i});`).join('\n') + '\n';
  const files = {};
  for (let i = 0; i < 6; i++) files[`src/u${i}.js`] = fn(`u${i}_`, 10 + i);
  files['tests/u0.test.js'] = 'const assert = require("node:assert/strict");\ntest("u0", () => { assert.equal(u0_0(5), 5); });\n';
  files['tests/u1.test.js'] = 'const assert = require("node:assert/strict");\ntest("u1", () => { assert.equal(u1_0(5), 5); });\n';
  files['src/over.js'] = fn('over_', 20); // its matched tests are too big for the pack together
  for (let k = 0; k < 4; k++) files[`tests/over${k}.test.js`] = Array.from({ length: 300 }, (_, i) => `test("t${i}", () => { assert.equal(over_${i % 20}(${i}), ${i}); }); // ${'pad '.repeat(10)}`).join('\n') + '\n';
  files['src/huge.js'] = Array.from({ length: 5000 }, (_, i) => `exports.h${i} = (v) => v + ${i}; // ${'padding '.repeat(12)}`).join('\n') + '\n'; // over 512 KiB
  const { root, ctx } = repoOf(t, files), head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  require('./audit-collect').collect({ cwd: root, ctx, maxUnits: 6, rotate: true, packBytes: 60000 });
  const pack = require('./engines/claude-api').contextPack(ctx, root, 60000), put = (n, v) => fs.writeFileSync(path.join(ctx, n), typeof v === 'string' ? v : JSON.stringify(v));
  put('engine-status', 'success'); put('pack-cut.txt', pack.notWhole.map((x) => `${x}\n`).join(''));
  put('findings.json', { requirements: [], not_requirements: [], not_reviewed: [], docs_reviewed: [], unit_findings: [] });
  const m = mocks(), saved = { ...process.env };
  Object.assign(process.env, { CTX: ctx, GITHUB_WORKSPACE: root, SCAN_ISSUE: 'true', ISSUE_REPO: '', SKIP: 'false', ENGINE: 'claude' });
  try { await audit({ github: m.github, context: { ...m.context, sha: head }, core: m.core, date: DATE }); } finally { for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]; Object.assign(process.env, saved); }
  const l = /^Units: .*$/m.exec(m.calls.summary)[0];
  assert.match(l, /^Units: 8 eligible = 7 inventoried \+ 1 not inventoried \(over 512 KiB\); 6 selected this run = 5 reviewed whole \+ 1 did not fit/);
  assert.match(m.calls.summary, /\| \[src\/over\.js\][^\n]*selected, did not fit \(not reviewed\) \|/);
  assert.match(m.calls.summary, /5 of the 6 selected units were reviewed whole/);
});

test('render: the funnel line reconciles eligible, selected, reviewed, did not fit and forced; the Details row says what happened', () => {
  const data = checked([uf()]), vis = (code) => { const md = render({ data, code, blob: BLOB, head: 'abc1234def', usage: '', run: '' }); return { md, top: md.slice(0, md.indexOf('<details>')) }; };
  const line = (t) => /^Units: .*$/m.exec(t)[0], num = (l, re) => Number((re.exec(l) || [0, 0])[1]);
  const ok = line(vis(CODE(data.unit_findings, { eligible: 140 })).top); // everything reviewed whole: no zero terms
  assert.equal(ok, 'Units: 140 eligible = 140 inventoried; 3 selected this run = 3 reviewed whole; 137 not yet reviewed.');
  const a = vis({ ...CODE(data.unit_findings, { eligible: 141, not_inventoried: 1 }), unseen: [U1] }), l = line(a.top); // one file over 512 KiB, one selected unit did not fit
  assert.equal(l, 'Units: 141 eligible = 140 inventoried + 1 not inventoried (over 512 KiB); 3 selected this run = 2 reviewed whole + 1 did not fit; 138 not yet reviewed.');
  assert.equal(num(l, /^Units: (\d+) eligible/), num(l, /= (\d+) inventoried/) + num(l, /\+ (\d+) not inventoried/));
  assert.equal(num(l, /selected this run = (\d+) reviewed/) + num(l, /\+ (\d+) did not fit/), 3);
  assert.match(a.md, /\| \[src\/js\/orders\.js\]\([^)]*\) \| 54\.2 \| [^|]* \| [^|]* \| selected, did not fit \(not reviewed\) \|/);
  assert.match(a.md, /\| \[src\/js\/legacy\.js\]\([^)]*\) \| 21\.5 \| no test \| none \| this run \|/);
  assert.doesNotMatch(a.md, /riskiest of \d+ units were reviewed/);
  assert.match(line(vis(CODE(data.unit_findings, { eligible: 145, not_reached: 5 })).top), /^Units: 145 eligible = 140 inventoried \+ 5 not reached \(inventory cap \/ time budget\); /);
  const f = vis({ ...CODE(data.unit_findings, { eligible: 140, forced: [U1] }), unseen: [U1] }); // forced: nothing fits, tests cut
  assert.match(line(f.top), /3 selected this run = 2 reviewed whole \+ 1 forced \(recorded unsure\)/);
  assert.match(f.md, /forced: tests cut \(unsure\)/);
});
