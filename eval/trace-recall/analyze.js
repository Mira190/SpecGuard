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
  };
  const times = [];
  const vs = results.variants || [];
  for (const v of vs) {
    const c = byId.get(v.case);
    if (!c) throw new Error('result for unknown case ' + v.case);
    times.push((v.trace_ms || 0) + (v.cand_ms || 0));
    const ex = c.expect;
    if (v.variant !== 'C') { // requirement edited: which code and tests does it point at
      const r2c = v.req_to_code || [], g = groups['req->code'];
      const codeLists = r2c.map((x) => x.code || []), testLists = r2c.map((x) => x.tests || []);
      add(g.code, ex.code.map((loc) => rankOf(codeLists, (it) => overlaps(it, loc, locRanges(loc)))));
      add(g.code_file_level, ex.code.map((loc) => rankOf(codeLists, (it) => it.path === loc.file)));
      add(g.tests, ex.tests.map((t) => rankOf(testLists, (it) => it.path === t)));
    }
    if (v.variant !== 'R') { // code edited: which requirement and tests does it point at
      const g = groups['code->req'];
      const reqLists = (v.code_to_req || []).map((h) => h.candidates.slice().sort((a, b) => b.score - a.score));
      const [a, b] = ex.requirement.lines; // +-1 line: the candidate is the item's first line
      add(g.requirement, [rankOf(reqLists, (it) => it.path === ex.requirement.file && it.line >= a - 1 && it.line <= b + 1)]);
      const tl = parseTestCandidates(v.test_candidates);
      add(g.tests, ex.tests.map((t) => rankOf(tl, (it) => it.path === t)));
    }
  }
  const out = { variants: vs.length, cases: new Set(vs.map((v) => v.case)).size, directions: {} };
  for (const [d, kinds] of Object.entries(groups)) { out.directions[d] = {}; for (const [k, a] of Object.entries(kinds)) out.directions[d][k] = finish(a); }
  const s = times.slice().sort((x, y) => x - y);
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
  lines.push('', `runtime per variant (trace + test candidates): p50 ${res.runtime_ms.p50} ms, max ${res.runtime_ms.max} ms, n=${res.runtime_ms.n}`);
  return lines.join('\n');
}

module.exports = { analyze, format, parseTestCandidates };

if (require.main === module) {
  const args = process.argv.slice(2), opt = (n) => { const i = args.indexOf(n); return i < 0 ? null : args.splice(i, 2)[1]; };
  const casesFile = opt('--cases') || path.join(__dirname, 'cases.json'), jsonOut = opt('--json');
  const resultsFile = args[0] || path.join(__dirname, 'results.json');
  const res = analyze(JSON.parse(fs.readFileSync(resultsFile, 'utf8')), JSON.parse(fs.readFileSync(casesFile, 'utf8')));
  console.log(format(res));
  if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(res, null, 1) + '\n');
}
