#!/usr/bin/env node
// Offline scorer for pre-registered eval E3 (eval/replay/prereg-coverage-confirmed-e3.md): do haiku missing_test findings whose cited line the unit-coverage report shows never ran ("confirmed") hit the bug location more often than findings whose line ran ("contradicted")? No model calls.
//   node eval/replay/coverage-e3-score.js --rows coverage-e1-confirm.json --repos <clones dir> --cover-results results-cover-SET.json --cover-dir <evidence>/f2p/cover/SET \
//     --raw <batch out dir (rep<k>/<id>/result.json)> --reps 3 --out result.json [--seed 20261020] [--perms 10000] [--boots 2000]
const fs = require('node:fs');
const path = require('node:path');
const { mulberry32 } = require('../szz');
const { parse } = require('../../src/coverage');
const { isCode, pairData, isCandidate } = require('./testgap-score');
const { loadHits, evalCover, runValid, labelLine, groupOf } = require('./coverage-e1-score');

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i < 0 ? d : process.argv[i + 1]; };
const EPS = 1e-12, MIN_LABEL = 10, MIN_DIFF = 0.15, ALPHA = 0.05, FAIL_CUT = 20;
const LABELS = ['confirmed', 'contradicted', 'unknown'];
const pct = (a, q) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.max(0, Math.floor(q * s.length)))] : null; };

// ---- pure pieces (tested) ----
// hits for the CITED files from the whole report: the resolver's known set is the changed files plus every cited path (not only changed files)
const hitsForFindings = (parsed, changedFiles, findings) => (parsed ? loadHits(parsed, new Set([...changedFiles, ...findings.map((f) => f.path).filter(Boolean)])) : null);
// why a missing_test finding is left out of the finding-level counts (null = included): no path, no line, non-code path
const exclusionReason = (f) => (!f.path ? 'no_path' : f.line == null ? 'no_line' : !isCode(f.path) ? 'non_code' : null);
// unusable PR (E1's rules) or no report -> unknown; otherwise E1's labelLine on the whole-report hits
const labelOf = (usable, hits, f) => (usable && hits ? labelLine(hits, f.path, f.line) : 'unknown');
// one valid run of one PR -> { items, excluded }. pr: { id, repo, subgroup, usable, hits, B, deps, failed }
function runItems(pr, rep, run) {
  const items = [], excluded = {};
  for (const f of run.findings.filter((x) => x.kind === 'missing_test')) {
    const why = exclusionReason(f);
    if (why) { excluded[why] = (excluded[why] || 0) + 1; continue; }
    items.push({ pr: pr.id, rep, repo: pr.repo, subgroup: pr.subgroup, label: labelOf(pr.usable, pr.hits, f), catch: pr.B.has(f.path, f.line) ? 1 : 0, delivered: isCandidate(f, 'derived'),
      deps: !!pr.deps, failed: pr.failed == null ? 'na' : pr.failed > FAIL_CUT ? '>20' : '<=20' });
  }
  return { items, excluded };
}
const rate = (items, label) => { const s = items.filter((x) => x.label === label), k = s.reduce((a, x) => a + x.catch, 0); return { n: s.length, catches: k, rate: s.length ? k / s.length : null }; };
const rates = (items) => Object.fromEntries(LABELS.map((l) => [l, rate(items, l)]));
// catch rate of label a minus label b; null when either has no finding
const diffOf = (items, a = 'confirmed', b = 'contradicted') => { const x = rate(items, a), y = rate(items, b); return x.n && y.n ? x.rate - y.rate : null; };
// one-sided permutation p: labels shuffled WITHIN each PR-run (PR x rep) among its confirmed + contradicted findings; unknown findings never enter. p = share of perms with statistic >= observed (ties included)
function permP(items, { seed = 20261020, perms = 10000 } = {}) {
  const obs = diffOf(items), rng = mulberry32(seed), groups = new Map();
  for (const x of items) if (x.label === 'confirmed' || x.label === 'contradicted') { const k = `${x.pr}|${x.rep}`; (groups.get(k) || groups.set(k, []).get(k)).push(x); }
  const G = [...groups.values()].map((g) => ({ catches: g.map((x) => x.catch), labels: g.map((x) => x.label) }));
  let ge = 0;
  for (let j = 0; j < perms; j++) {
    let cn = 0, ck = 0, dn = 0, dk = 0;
    for (const g of G) {
      const L = [...g.labels];
      for (let i = L.length - 1; i > 0; i--) { const r = Math.floor(rng() * (i + 1)); [L[i], L[r]] = [L[r], L[i]]; }
      L.forEach((l, i) => { if (l === 'confirmed') { cn++; ck += g.catches[i]; } else { dn++; dk += g.catches[i]; } });
    }
    if (ck / cn - dk / dn >= obs - EPS) ge++;
  }
  return { observed: obs, p: ge / perms, perms };
}
// PR-cluster bootstrap 95% CI of rate(a) - rate(b): resample the PRs (with all their reps' findings); resamples with no finding of either label are skipped and counted
function clusterBoot(items, prIds, a, b, seed = 20261020, boots = 2000) {
  const per = prIds.map((id) => { const s = items.filter((x) => x.pr === id); return [rate(s, a), rate(s, b)]; });
  const rng = mulberry32(seed), d = []; let skipped = 0;
  for (let j = 0; j < boots; j++) {
    let an = 0, ak = 0, bn = 0, bk = 0;
    for (let i = 0; i < per.length; i++) { const [x, y] = per[Math.floor(rng() * per.length)]; an += x.n; ak += x.catches; bn += y.n; bk += y.catches; }
    if (an && bn) d.push(ak / an - bk / bn); else skipped++;
  }
  return { ci95: d.length ? [pct(d, 0.025), pct(d, 0.975)] : null, boots, skipped };
}
// the pre-registered primary: not tested (decided first), else observed difference, permutation p, PASS rule, bootstrap CI
function primary(items, prIds, opt) {
  const c = rate(items, 'confirmed'), d = rate(items, 'contradicted'), counts = { confirmed: c.n, contradicted: d.n };
  if (c.n < MIN_LABEL || d.n < MIN_LABEL) return { verdict: 'not_tested', ...counts, confirmed_rate: c.rate, contradicted_rate: d.rate };
  const t = permP(items, opt), pass = t.p < ALPHA && t.observed >= MIN_DIFF - EPS;
  return { verdict: pass ? 'PASS' : 'FAIL', ...counts, confirmed_rate: c.rate, contradicted_rate: d.rate, difference: t.observed, p: t.p, perms: t.perms, ...clusterBoot(items, prIds, 'confirmed', 'contradicted', opt.seed, opt.boots) };
}
const splitBy = (items, key) => { const m = {}; for (const x of items) (m[x[key]] ||= []).push(x); return Object.fromEntries(Object.entries(m).map(([k, s]) => [k, { findings: s.length, rates: rates(s), difference_confirmed_minus_contradicted: diffOf(s) }])); };
// secondaries 1-5 (descriptive, no tests); 6 is counted in main(); 7 is the fixed design-look constant
function secondaries(items, prIds, opt) {
  const del = items.filter((x) => x.delivered);
  return {
    confirmed_vs_unknown: { difference: diffOf(items, 'confirmed', 'unknown'), ...clusterBoot(items, prIds, 'confirmed', 'unknown', opt.seed, opt.boots) },
    delivered_only: { findings: del.length, rates: rates(del), difference_confirmed_minus_contradicted: diffOf(del) },
    per_repo: splitBy(items, 'repo'), per_subgroup: splitBy(items, 'subgroup'),
    by_deps_changed: splitBy(items, 'deps'), by_failing_tests: splitBy(items, 'failed'),
    design_look: { confirmed: '4/5', contradicted: '9/27', unknown: '0/24' },
  };
}

// ---- files ----
function loadReport(coverDir, group) { // same two files as E1's loader (not exported there)
  for (const f of ['lcov.info', 'coverage.xml']) { try { return parse(fs.readFileSync(path.join(coverDir, group, f), 'utf8')); } catch { /* next */ } }
  return null;
}
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const add = (o, k, n = 1) => { o[k] = (o[k] || 0) + n; };

function main() {
  const opt = { seed: +arg('seed', 20261020), perms: +arg('perms', 10000), boots: +arg('boots', 2000) }, reps = +arg('reps', 3);
  const rows = JSON.parse(fs.readFileSync(arg('rows'), 'utf8')).rows.filter((r) => r.kind === 'bug'), cover = (readJson(arg('cover-results')) || {}).groups || {};
  const items = [], excluded = {}, notRun = [], invalid = [], scored = [], unusable = {}; let spend = 0, runs = 0;
  for (const r of rows) {
    const raws = Array.from({ length: reps }, (_, k) => readJson(path.join(arg('raw'), `rep${k + 1}`, r.id, 'result.json')));
    if (raws.some((x) => !x)) { notRun.push({ id: r.id, reps_present: raws.filter(Boolean).length }); continue; } // a PR without all reps is never scored or topped up
    scored.push(r.id);
    const g = groupOf(r), rec = cover[g] || null, parsed = loadReport(arg('cover-dir'), g), dir = path.join(arg('repos'), r.repo.split('/')[1]);
    const d = pairData(dir, { id: r.id, replay_id: r.id, introducing: r.introducing }, r.fix_sha), c = evalCover({ rec, parsed, changedUnits: d.changedUnits, changedFiles: d.changedFiles, B: d.B });
    if (!c.usable) add(unusable, c.reason);
    raws.forEach((run, k) => {
      runs++; if (run.usage && typeof run.usage.cost_usd === 'number') spend += run.usage.cost_usd;
      if (!runValid(run)) { invalid.push({ id: r.id, rep: k + 1, reason: run.invalid_reason || run.engine_status || 'invalid' }); add(excluded, 'invalid_run', (run.findings || []).filter((x) => x.kind === 'missing_test').length); return; } // a miss for every metric it would have fed
      const hits = hitsForFindings(parsed, d.changedFiles, run.findings.filter((x) => x.kind === 'missing_test'));
      const out = runItems({ id: r.id, repo: r.repo.split('/')[1], subgroup: r.subgroup, usable: c.usable, hits, B: d.B, deps: rec && rec.deps_changed, failed: rec && rec.health ? rec.health.failed : null }, k + 1, run);
      items.push(...out.items);
      for (const [w, n] of Object.entries(out.excluded)) add(excluded, w, n);
    });
  }
  const validRuns = runs - invalid.length;
  const out = { seed: opt.seed, perms: opt.perms, boots: opt.boots, reps, prs: { rows: rows.length, scored: scored.length, not_run: notRun }, runs: { scored: runs, valid: validRuns, invalid_misses: invalid }, unusable_prs_by_reason: unusable,
    findings: { included: items.length, per_label: Object.fromEntries(LABELS.map((l) => [l, items.filter((x) => x.label === l).length])), per_valid_run: validRuns ? items.length / validRuns : 0, excluded_by_reason: excluded },
    spend_usd: spend, primary: primary(items, scored, opt), secondary: secondaries(items, scored, opt) };
  fs.writeFileSync(arg('out'), JSON.stringify(out, null, 1));
  console.log(JSON.stringify(out, null, 1));
}
if (require.main === module) main();
module.exports = { hitsForFindings, exclusionReason, labelOf, runItems, rate, rates, diffOf, permP, clusterBoot, primary, secondaries, splitBy, EPS };
