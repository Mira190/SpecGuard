// Metric math of analyze.js on a tiny bundled fixture. No network, no target repo.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { analyze, attribute, format, parseTestCandidates } = require('./analyze.js');
const fx = require('./fixture.json');

const res = analyze(fx.results, fx.cases);
const kr = (k, n) => ({ k, n, rate: n ? k / n : null });

test('req->code / code: Hit, Recall, MRR and All-required with raw counts', () => {
  // A-R: f1 at rank 1, f2 at rank 3. A-RC: f1 at rank 4, f2 not found. B-R has no relevant item and is left out.
  const m = res.directions['req->code'].code;
  assert.equal(m.queries, 2); assert.equal(m.empty_relevant_excluded, 1); assert.equal(m.relevant_items, 4);
  assert.deepEqual([m.hit_at_1, m.hit_at_3], [kr(1, 2), kr(1, 2)]);
  assert.deepEqual([m.recall_at_1, m.recall_at_3, m.recall_at_K], [kr(1, 4), kr(2, 4), kr(3, 4)]);
  assert.deepEqual(m.mrr_at_10, { sum: 1.25, n: 2, value: 0.625 }); // (1 + 1/4) / 2
  assert.deepEqual(m.all_required_at_3, kr(1, 2));
});

test('MRR high is not all entries found', () => {
  const hitOnly = analyze({ variants: [fx.results.variants[2]] }, fx.cases).directions['req->code'].code; // A-RC alone: first hit at rank 4
  assert.equal(hitOnly.mrr_at_10.value, 0.25); assert.equal(hitOnly.all_required_at_3.k, 0);
  const one = { variants: [{ ...fx.results.variants[0], req_to_code: [{ criterion: 'S1', code: [{ path: 'f1.js', line: 10, end: 10 }], tests: [] }] }] };
  const o = analyze(one, fx.cases).directions['req->code'].code;
  assert.equal(o.mrr_at_10.value, 1); assert.deepEqual(o.all_required_at_3, kr(0, 1)); assert.deepEqual(o.recall_at_3, kr(1, 2)); // first hit at 1, one of two found
});

test('empty relevant set: counted as excluded, never scored 0 or 1', () => {
  const m = res.directions['req->code'].tests;
  assert.equal(m.empty_relevant_excluded, 1); // B-R
  const only = analyze({ variants: [fx.results.variants[3]] }, fx.cases).directions['req->code'].code;
  assert.equal(only.queries, 0); assert.equal(only.empty_relevant_excluded, 1);
  assert.equal(only.hit_at_1.rate, null); assert.equal(only.mrr_at_10.value, null); assert.equal(only.all_required_at_3.rate, null); assert.equal(only.recall_at_3.rate, null);
});

test('req->code / tests: rank is the position in the delivered test list', () => {
  const m = res.directions['req->code'].tests; // A-R: t1 at rank 2. A-RC: no tests delivered.
  assert.equal(m.queries, 2);
  assert.deepEqual([m.hit_at_1, m.hit_at_3, m.recall_at_3, m.all_required_at_3], [kr(0, 2), kr(1, 2), kr(1, 2), kr(1, 2)]);
  assert.equal(m.mrr_at_10.sum, 0.5);
});

test('code->req: candidates are ranked by score; best rank over hunks; items outside the doc range do not count', () => {
  // A-C: D.md:2 has the top score (rank 1). A-RC: D.md:9 is outside 1-3 +-1 and scores higher, so D.md:3 is rank 2 (the other hunk has only D.md:9)
  const r = res.directions['code->req'].requirement;
  assert.equal(r.queries, 2);
  assert.deepEqual([r.hit_at_1, r.recall_at_3, r.all_required_at_3], [kr(1, 2), kr(2, 2), kr(2, 2)]);
  assert.equal(r.mrr_at_10.value, 0.75);
  const t = res.directions['code->req'].tests; // test-candidates.txt: A-C lists t1 first; A-RC says none found
  assert.deepEqual([t.queries, t.hit_at_1, t.recall_at_3, t.all_required_at_3], [2, kr(1, 2), kr(1, 2), kr(1, 2)]);
});

test('runtime p50 (nearest rank) and max over trace + candidate time', () => {
  assert.deepEqual(res.runtime_ms, { n: 4, p50: 150, max: 300 }); // totals 150, 200, 300, 10
  assert.equal(res.variants, 4); assert.equal(res.cases, 2);
});

test('parseTestCandidates reads blocks and ignores the trailer', () => {
  assert.deepEqual(parseTestCandidates('a.js\n  t1  (stem)\n  t2  (dir)\nb.js\n  (no candidate test file found)\n(3 more changed file(s) not listed)\n'), [[{ path: 't1' }, { path: 't2' }], []]);
});

test('CLI prints the report and writes json from a results file', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-recall-'));
  try {
    fs.writeFileSync(path.join(d, 'r.json'), JSON.stringify(fx.results)); fs.writeFileSync(path.join(d, 'c.json'), JSON.stringify(fx.cases));
    const out = execFileSync(process.execPath, [path.join(__dirname, 'analyze.js'), path.join(d, 'r.json'), '--cases', path.join(d, 'c.json'), '--json', path.join(d, 'o.json')], { encoding: 'utf8' });
    assert.match(out, /4 variants of 2 independent cases/); assert.match(out, /Hit@1 50% \(1\/2\)/);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(d, 'o.json'), 'utf8')), JSON.parse(JSON.stringify(res)));
    assert.equal(format(res).includes('MRR@10 0.625 (sum 1.25 over 2)'), true);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('candidates step fails loudly: no heredoc, non-zero exit, or every code variant empty', () => {
  const { extractCandidates, checkCandidates, checkNotAllEmpty } = require('./candidates.js');
  const sh = "x=1\ncandidates() { timeout 60 node - \"$HERE/trace.js\" \"$CTX\" <<'JS'\nconsole.log(1);\nJS\n}\n";
  assert.equal(extractCandidates(sh), 'console.log(1);\n');
  assert.throws(() => extractCandidates('candidates() { echo; }\n'), /cannot find the candidates\(\) heredoc/);
  assert.throws(() => checkCandidates('c-C', { status: 1, stderr: 'boom\n' }, 'f\n', true), /failed for c-C: exit 1 boom/);
  assert.throws(() => checkCandidates('c-C', { status: null, error: new Error('ETIMEDOUT') }, 'f\n', true), /ETIMEDOUT/);
  checkCandidates('c-C', { status: 0 }); // control: an empty list is data (Hit = 0), not a failure
  assert.throws(() => checkNotAllEmpty([{ id: 'a-C', text: '' }, { id: 'b-RC', text: '\n' }]), /any of the 2 code variants/);
  checkNotAllEmpty([{ id: 'a-C', text: '' }, { id: 'b-RC', text: 'lib/a.js\n  (no candidate test file found)\n' }]); // control: one empty variant among others
  checkNotAllEmpty([]);
});

test('a failed trace is reported and stays in the denominator; a successful empty retrieval is not flagged', () => {
  const v = fx.results.variants[1]; // A-C, scores a hit in the fixture
  const bad = { variants: [{ ...v, status: 'trace failed: timeout', trace_ms: undefined, req_to_code: [], code_to_req: [] }] };
  const r = analyze(bad, fx.cases);
  assert.deepEqual([r.variants, r.ok_variants, r.failed_variants], [1, 0, [{ case: v.case, variant: v.variant, status: 'trace failed: timeout' }]]);
  assert.equal(r.directions['code->req'].requirement.hit_at_3.n, 1); // still counted, as a miss
  assert.match(format(r), /FAILED: 1 of 1 variants.*A\/C \(trace failed: timeout\)/);
  assert.equal(r.runtime_ms.n, 0); // missing trace_ms is not 0 ms
  const empty = analyze({ variants: [{ ...v, status: 'ok', req_to_code: [], code_to_req: [] }] }, fx.cases); // control
  assert.deepEqual([empty.ok_variants, empty.failed_variants, empty.directions['code->req'].requirement.hit_at_3.k], [1, [], 0]);
  assert.doesNotMatch(format(empty), /FAILED/);
});

test('results for another target sha are refused; the same sha passes', () => {
  const cases = { ...fx.cases, target: { sha: 'aaa' } };
  assert.throws(() => analyze({ ...fx.results, target: { sha: 'bbb' } }, cases), /bbb.*pins aaa/);
  assert.equal(analyze({ ...fx.results, target: { sha: 'aaa' } }, cases).variants, 4);
});

test('the harness child env drops every ambient trace setting and keeps the rest', () => {
  const { harnessEnv, PINNED_UNSET } = require('./candidates.js');
  const e = harnessEnv({ TRACE: 'off', IGNORE_EXTRA: 'x', STANDARDS_PATHS: 'y', TRACE_BUDGET_MS: '1', TEST_PATHS: 'z', PATH: 'p' }, { CTX: 'c' });
  assert.deepEqual(e, { PATH: 'p', CTX: 'c' });
  assert.ok(PINNED_UNSET.includes('TRACE'));
});

test('attribute: ranked_out, not_retrieved, cut (note names the file), unknown (unnamed limit note); misses by location kind', () => {
  const at = attribute(fx.results, fx.cases);
  // A-RC: f1 delivered at rank 4 -> ranked_out; f2 absent -> not_retrieved, a different file of the same (root) module; t1 absent -> not_retrieved
  assert.deepEqual(at.counts['req->code code'], { ranked_out: 1, cut: 0, not_retrieved: 1, unknown: 0 });
  assert.deepEqual(at.counts['req->code tests'], { ranked_out: 0, cut: 0, not_retrieved: 1, unknown: 0 });
  assert.deepEqual(at.req_to_code_locations.find((l) => l.id === 'A-RC'), { id: 'A-RC', required: 2, found: 1, misses: [{ loc: 'f2.js:5-5', kind: 'same_dir', alt: false }] });
  const withT = attribute({ variants: [...fx.results.variants, ...fx.results_t.variants] }, fx.cases); // T variants add nothing to the four lists
  assert.deepEqual(withT.counts, at.counts); assert.equal(withT.misses.length, at.misses.length);
  const rc = fx.results.variants.find((v) => v.id === 'A-RC');
  const cut = attribute({ variants: [{ ...rc, limitations: ['2 more code/test candidate(s) for S1 not shown (top 3 kept): f2.js.'] }] }, fx.cases);
  assert.equal(cut.misses.find((m) => m.item === 'f2.js:5-5').class, 'cut');
  const unk = attribute({ variants: [{ ...rc, limitations: ['9 more code/test candidate(s) for S1 not shown (top 3 kept): a.js, b.js, c.js, d.js, e.js.'] }] }, fx.cases); // 5 names = list may be truncated
  const full = attribute({ variants: [{ ...rc, limitations: ['2 more code/test candidate(s) for S1 not shown (top 3 kept): a.js, b.js.'] }] }, fx.cases); // complete list without f2 = never retrieved
  assert.equal(full.misses.find((m) => m.item === 'f2.js:5-5').class, 'not_retrieved');
  assert.equal(unk.misses.find((m) => m.item === 'f2.js:5-5').class, 'unknown');
});

test('test->code / test->req: a T variant is scored against the case ground truth; nothing emitted is a 0 with k/n', () => {
  // A-T: f2.js:5 is rank 2 of the emitted windows, f1.js:10-20 is not found; D.md:2 is rank 2 (D.md:9 scores higher but is out of range). B-T has no code item but one requirement.
  const t = analyze(fx.results_t, fx.cases), c = t.directions['test->code'].code, r = t.directions['test->req'].requirement;
  assert.deepEqual([c.queries, c.empty_relevant_excluded, c.relevant_items], [1, 1, 2]);
  assert.deepEqual([c.hit_at_1, c.hit_at_3, c.recall_at_3, c.all_required_at_3], [kr(0, 1), kr(1, 1), kr(1, 2), kr(0, 1)]);
  assert.equal(c.mrr_at_10.value, 0.5);
  assert.deepEqual([r.queries, r.hit_at_1, r.hit_at_3, r.mrr_at_10.value], [2, kr(0, 2), kr(1, 2), 0.25]); // B-T has a requirement and nothing emitted: a miss, still in the denominator
  const none = analyze({ variants: [{ ...fx.results_t.variants[0], req_to_code: [], code_to_req: [] }] }, fx.cases); // control: the pipeline emits nothing
  assert.deepEqual([none.directions['test->code'].code.recall_at_K, none.directions['test->req'].requirement.hit_at_3], [kr(0, 2), kr(0, 1)]);
  assert.equal(analyze(fx.results, fx.cases).directions['test->code'].code.queries, 0); // R/C/RC feed no T direction
  const mixed = analyze({ variants: [...fx.results.variants, ...fx.results_t.variants] }, fx.cases); // T feeds no old direction
  assert.deepEqual(mixed.directions['req->code'], res.directions['req->code']);
  assert.deepEqual(mixed.directions['code->req'], res.directions['code->req']);
});

test('wrong_windows: delivered req->code code windows overlapping no expect.code range, k/n, windows per query, bytes', () => {
  // A-R delivers f1:15 (right), x.js (wrong), f2:5 (right). A-RC delivers x, y, z (wrong) and f1:10-12 (right). B-R expects no code, so its one delivered window is wrong.
  const d = res.req_to_code_delivery;
  assert.deepEqual(d.wrong_windows, kr(5, 8)); assert.deepEqual(d.windows_per_query, { p50: 3, max: 4 }); assert.equal(d.queries, 3);
  assert.deepEqual(d.candidate_bytes, { n: 0, p50: null, max: null });
  const withBytes = analyze({ variants: fx.results.variants.map((v, i) => ({ ...v, cand_bytes: 1000 * (i + 1) })) }, fx.cases).req_to_code_delivery;
  assert.deepEqual(withBytes.candidate_bytes, { n: 3, p50: 3000, max: 4000 });
  assert.match(format(res), /wrong_windows 63% \(5\/8\)/);
});

test('attribute: rank K is not a miss and K+1 is ranked_out; miss kinds same_file / generated_duplicate (alt) / other; shown-file unknown', () => {
  const cases = { cases: [{ id: 'X', expect: { requirement: { file: 'D.md', lines: [1, 1] }, tests: [], code: [
    { file: 'a.js', lines: [1, 1] }, { file: 'a.js', lines: [50, 50] }, { file: 'g.js', lines: [5, 5], alt: [[1, 1]] }, { file: 'z/q.js', lines: [1, 1] }] } }] };
  const w = (p) => ({ path: p, line: 1, end: 1 });
  const v = (id, code, limitations) => ({ id, case: 'X', variant: 'R', limitations, req_to_code: [{ criterion: 'S1', code: code.map(w), tests: [] }] });
  const note = ['3 more code/test candidate(s) for S1 not shown (top 3 kept): b.js, c.js.']; // 2 names: complete list
  const at = attribute({ variants: [v('X-3', ['p.js', 'p2.js', 'a.js'], note), v('X-4', ['p.js', 'p2.js', 'p3.js', 'a.js'], [])] }, cases);
  const of = (id, item) => at.misses.find((m) => m.id === id && m.item === item);
  assert.equal(of('X-3', 'a.js:1-1'), undefined); // rank exactly K: not a miss
  assert.equal(of('X-4', 'a.js:1-1').class, 'ranked_out'); // rank K+1
  assert.equal(of('X-3', 'a.js:50-50').class, 'unknown'); // a.js was delivered, a dropped window of a shown file is not listed
  assert.equal(of('X-4', 'a.js:50-50').class, 'not_retrieved'); // control: no note, nothing dropped
  assert.equal(of('X-3', 'g.js:5-5').class, 'not_retrieved'); // control: complete note does not name it
  assert.deepEqual(at.req_to_code_locations.find((l) => l.id === 'X-3').misses.map((m) => m.kind), ['same_file', 'generated_duplicate', 'other']);
});

test('attribute: code->req requirement and tests are counted; hunk and trailer notes make a miss unknown', () => {
  const rc = fx.results.variants.find((v) => v.id === 'A-RC'); // requirement found at rank 2; t1 absent
  const base = attribute({ variants: [rc] }, fx.cases);
  assert.deepEqual(base.counts['code->req requirement'], undefined); // found within K: no miss, no row
  assert.deepEqual(base.counts['code->req tests'], { ranked_out: 0, cut: 0, not_retrieved: 1, unknown: 0 });
  const far = [{ path: 'f1.js', line: 12, candidates: [{ path: 'D.md', line: 9, score: 7 }] }]; // D.md:9 is outside 1-3 +-1
  const miss = (extra) => attribute({ variants: [{ ...rc, code_to_req: far, ...extra }] }, fx.cases);
  const req = (a) => a.misses.find((m) => m.list === 'code->req requirement');
  assert.deepEqual(miss({}).counts['code->req requirement'], { ranked_out: 0, cut: 0, not_retrieved: 1, unknown: 0 });
  const hunk = miss({ limitations: ['2 weaker code hunk(s) not shown.'] });
  assert.equal(req(hunk).class, 'unknown'); assert.equal(hunk.counts['code->req requirement'].unknown, 1);
  const tr = miss({ test_candidates: 'f1.js\n  other.test.js  (stem)\n(3 more changed file(s) not listed)\n' });
  assert.equal(tr.misses.find((m) => m.list === 'code->req tests').class, 'unknown');
  assert.deepEqual(tr.counts['code->req tests'], { ranked_out: 0, cut: 0, not_retrieved: 0, unknown: 1 });
});

test('attribute: a more note naming 4 paths is complete (cap 5), so an absent item is not_retrieved', () => {
  const rc = fx.results.variants.find((v) => v.id === 'A-RC');
  const cls = (names) => attribute({ variants: [{ ...rc, limitations: ['9 more code/test candidate(s) for S1 not shown (top 3 kept): ' + names + '.'] }] }, fx.cases).misses.find((m) => m.item === 'f2.js:5-5').class;
  assert.equal(cls('a.js, b.js, c.js, d.js'), 'not_retrieved');
  assert.equal(cls('a.js, b.js, c.js, d.js, e.js'), 'unknown');
});
