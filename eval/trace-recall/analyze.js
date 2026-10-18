#!/usr/bin/env node
// Retrieval metrics for the trace-recall set. Reads results.json (run.js) and cases.json (ground truth); no network, no model.
// usage: node analyze.js [results.json] [--cases cases.json] [--json out.json]
'use strict';
const fs = require('node:fs');
const path = require('node:path');

// A query is one (variant, direction, kind). It has a list of relevant items and ranked lists of retrieved items
// (one list per criterion / changed hunk / changed file; an item's rank is its best rank over those lists).
// Empty relevant set: the query is counted in `empty` and left out of every denominator (never scored 0 or 1).
const K = 3, MRR_K = 10;
const rankOf = (lists, isRel) => {
  let best = null;
  for (const l of lists) { const i = l.findIndex(isRel); if (i >= 0 && (best === null || i + 1 < best)) best = i + 1; }
  return best;
};

function emptyAgg() {
  return { queries: 0, empty: 0, hit1: 0, hit3: 0, recall1: 0, recall3: 0, recallK: 0, relevant: 0, mrr_sum: 0, all3: 0 };
}
function add(agg, ranks) { // ranks: best rank (or null) of each relevant item
  if (!ranks.length) { agg.empty++; return; }
  const best = Math.min(...ranks.filter((r) => r !== null), Infinity);
  agg.queries++; agg.relevant += ranks.length;
  if (best <= 1) agg.hit1++;
  if (best <= K) agg.hit3++;
  agg.recall1 += ranks.filter((r) => r !== null && r <= 1).length;
  agg.recall3 += ranks.filter((r) => r !== null && r <= K).length;
  agg.recallK += ranks.filter((r) => r !== null).length;
  if (best <= MRR_K) agg.mrr_sum += 1 / best;
  if (ranks.every((r) => r !== null && r <= K)) agg.all3++;
}
const rate = (k, n) => ({ k, n, rate: n ? k / n : null });
function finish(a) {
  return {
    queries: a.queries, empty_relevant_excluded: a.empty, relevant_items: a.relevant,
    hit_at_1: rate(a.hit1, a.queries), hit_at_3: rate(a.hit3, a.queries),
    recall_at_1: rate(a.recall1, a.relevant), recall_at_3: rate(a.recall3, a.relevant), recall_at_K: rate(a.recallK, a.relevant),
    mrr_at_10: { sum: +a.mrr_sum.toFixed(6), n: a.queries, value: a.queries ? a.mrr_sum / a.queries : null },
    all_required_at_3: rate(a.all3, a.queries),
  };
}

const overlaps = (item, loc, ranges) => item.path === loc.file && ranges.some(([a, b]) => item.line <= b && (item.end ?? item.line) >= a);
const locRanges = (loc) => [loc.lines, ...(loc.alt || [])];

// test-candidates.txt: "file\n  test  (why)\n  test  (why)\n" blocks; each block is one ranked list of tests
function parseTestCandidates(text) {
  const lists = [];
  for (const line of String(text || '').split('\n')) {
    if (/^\S/.test(line) && !line.startsWith('(')) lists.push([]);
    else { const m = /^ {2}(\S+)\s+\(/.exec(line); if (m && lists.length) lists[lists.length - 1].push({ path: m[1] }); }
  }
  return lists;
}

function analyze(results, cases) {
  const byId = new Map(cases.cases.map((c) => [c.id, c]));
  const groups = {
    'req->code': { code: emptyAgg(), code_file_level: emptyAgg(), tests: emptyAgg() },
    'code->req': { requirement: emptyAgg(), tests: emptyAgg() },
    'test->code': { code: emptyAgg() },
    'test->req': { requirement: emptyAgg() },
  };
  const times = [], del = { wrong: 0, windows: 0, per_query: [], bytes: [] }; // delivered req->code code windows: wrong = overlaps no expect.code range (incl. alt)
  const vs = results.variants || [];
  if (results.target?.sha && cases.target?.sha && results.target.sha !== cases.target.sha) throw new Error(`results are for target ${results.target.sha}, cases.json pins ${cases.target.sha}`);
  const failed = [];
  for (const v of vs) {
    const c = byId.get(v.case);
    if (!c) throw new Error('result for unknown case ' + v.case);
    if (v.status !== undefined && v.status !== 'ok') failed.push({ case: v.case, variant: v.variant, status: v.status }); // stays in every denominator: a failed trace is a miss, not a skipped query
    if (typeof v.trace_ms === 'number' && typeof v.cand_ms === 'number') times.push(v.trace_ms + v.cand_ms);
    const ex = c.expect;
    if (v.variant === 'R' || v.variant === 'RC') { // requirement edited: which code and tests does it point at
      const r2c = v.req_to_code || [], g = groups['req->code'];
      const codeLists = r2c.map((x) => x.code || []), testLists = r2c.map((x) => x.tests || []);
      add(g.code, ex.code.map((loc) => rankOf(codeLists, (it) => overlaps(it, loc, locRanges(loc)))));
      const win = r2c.flatMap((x) => x.code || []), good = (it) => ex.code.some((loc) => overlaps(it, loc, locRanges(loc)));
      del.windows += win.length; del.wrong += win.filter((it) => !good(it)).length; del.per_query.push(win.length);
      if (typeof v.cand_bytes === 'number') del.bytes.push(v.cand_bytes);
      add(g.code_file_level, ex.code.map((loc) => rankOf(codeLists, (it) => it.path === loc.file)));
      add(g.tests, ex.tests.map((t) => rankOf(testLists, (it) => it.path === t)));
    }
    if (v.variant === 'T') { // only a test assertion weakened: which code and requirement lost protection (relevant = the case's expect.code / expect.requirement; retrieved = what the pipeline emits, possibly nothing)
      const [a, b] = ex.requirement.lines;
      const codeLists = (v.req_to_code || []).map((x) => x.code || []);
      add(groups['test->code'].code, ex.code.map((loc) => rankOf(codeLists, (it) => overlaps(it, loc, locRanges(loc)))));
      const reqLists = (v.code_to_req || []).map((h) => h.candidates.slice().sort((p, q) => q.score - p.score));
      add(groups['test->req'].requirement, [rankOf(reqLists, (it) => it.path === ex.requirement.file && it.line >= a - 1 && it.line <= b + 1)]);
    }
    if (v.variant === 'C' || v.variant === 'RC') { // code edited: which requirement and tests does it point at
      const g = groups['code->req'];
      const reqLists = (v.code_to_req || []).map((h) => h.candidates.slice().sort((a, b) => b.score - a.score));
      const [a, b] = ex.requirement.lines; // +-1 line: the candidate is the item's first line
      add(g.requirement, [rankOf(reqLists, (it) => it.path === ex.requirement.file && it.line >= a - 1 && it.line <= b + 1)]);
      const tl = parseTestCandidates(v.test_candidates);
      add(g.tests, ex.tests.map((t) => rankOf(tl, (it) => it.path === t)));
    }
  }
  const out = { variants: vs.length, ok_variants: vs.length - failed.length, failed_variants: failed, cases: new Set(vs.map((v) => v.case)).size, directions: {} };
  for (const [d, kinds] of Object.entries(groups)) { out.directions[d] = {}; for (const [k, a] of Object.entries(kinds)) out.directions[d][k] = finish(a); }
  const s = times.slice().sort((x, y) => x - y);
  const pq = del.per_query.slice().sort((x, y) => x - y), bs = del.bytes.slice().sort((x, y) => x - y);
  out.req_to_code_delivery = { queries: pq.length, wrong_windows: rate(del.wrong, del.windows), windows_per_query: { p50: pq.length ? pq[Math.ceil(pq.length * 0.5) - 1] : null, max: pq.length ? pq[pq.length - 1] : null },
    candidate_bytes: { n: bs.length, p50: bs.length ? bs[Math.ceil(bs.length * 0.5) - 1] : null, max: bs.length ? bs[bs.length - 1] : null } };
  out.runtime_ms = { n: s.length, p50: s.length ? s[Math.ceil(s.length * 0.5) - 1] : null, max: s.length ? s[s.length - 1] : null };
  return out;
}

const pct = (r) => (r.rate === null ? '-' : `${Math.round(r.rate * 100)}% (${r.k}/${r.n})`);
function format(res) {
  const lines = [`${res.variants} variants of ${res.cases} independent cases (a case is counted once per variant; do not read this as ${res.variants} cases)`];
  for (const [d, kinds] of Object.entries(res.directions)) {
    for (const [k, m] of Object.entries(kinds)) {
      lines.push('', `${d} / ${k}: ${m.queries} queries, ${m.relevant_items} relevant items` + (m.empty_relevant_excluded ? `, ${m.empty_relevant_excluded} with no relevant item excluded` : ''));
      lines.push(`  Hit@1 ${pct(m.hit_at_1)}  Hit@3 ${pct(m.hit_at_3)}`);
      lines.push(`  Recall@1 ${pct(m.recall_at_1)}  Recall@3 ${pct(m.recall_at_3)}  Recall@K ${pct(m.recall_at_K)}`);
      lines.push(`  MRR@10 ${m.mrr_at_10.value === null ? '-' : m.mrr_at_10.value.toFixed(3)} (sum ${m.mrr_at_10.sum} over ${m.mrr_at_10.n})  All-required@3 ${pct(m.all_required_at_3)}`);
    }
  }
  const dv = res.req_to_code_delivery;
  lines.push('', `req->code delivered code windows: wrong_windows ${pct(dv.wrong_windows)} (overlap no expect.code range), windows per query p50 ${dv.windows_per_query.p50} max ${dv.windows_per_query.max}` + (dv.candidate_bytes.n ? `, trace-candidates.json bytes p50 ${dv.candidate_bytes.p50} max ${dv.candidate_bytes.max} (n=${dv.candidate_bytes.n})` : ', candidate bytes not recorded'));
  lines.push('', `runtime per variant (trace + test candidates): p50 ${res.runtime_ms.p50} ms, max ${res.runtime_ms.max} ms, n=${res.runtime_ms.n} of ${res.variants} variants (only those with both timings)`);
  if (res.failed_variants.length) lines.push(`FAILED: ${res.failed_variants.length} of ${res.variants} variants failed and are scored as misses: ` + res.failed_variants.map((f) => `${f.case}/${f.variant} (${f.status})`).join('; '));
  return lines.join('\n');
}

module.exports = { analyze, format, parseTestCandidates };

if (require.main === module) {
  const args = process.argv.slice(2), opt = (n) => { const i = args.indexOf(n); return i < 0 ? null : args.splice(i, 2)[1]; };
  const only = opt('--only'), group = opt('--group'); // --only id1,id2 ; --group original|holdout (cases flagged "holdout": true)
  const casesFile = opt('--cases') || path.join(__dirname, 'cases.json'), jsonOut = opt('--json');
  const resultsFile = args[0] || path.join(__dirname, 'results.json');
  const results = JSON.parse(fs.readFileSync(resultsFile, 'utf8')), cs = JSON.parse(fs.readFileSync(casesFile, 'utf8'));
  const keep = new Set(cs.cases.filter((c) => (!only || only.split(',').includes(c.id)) && (!group || !!c.holdout === (group === 'holdout'))).map((c) => c.id));
  results.variants = (results.variants || []).filter((v) => keep.has(v.case));
  const res = analyze(results, cs);
  console.log(format(res));
  if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(res, null, 1) + '\n');
}
