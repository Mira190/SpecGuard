// Metric math of analyze.js on a tiny bundled fixture. No network, no target repo.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { analyze, format, parseTestCandidates } = require('./analyze.js');
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
  const r = res.directions['code->req'].requirement; // A-C: D.md has the top score. A-RC: second hunk hits D.md:3, first hunk is D.md:9 (outside 1-3 +-1)
  assert.equal(r.queries, 2);
  assert.deepEqual([r.hit_at_1, r.recall_at_3, r.all_required_at_3], [kr(2, 2), kr(2, 2), kr(2, 2)]);
  assert.equal(r.mrr_at_10.value, 1);
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
