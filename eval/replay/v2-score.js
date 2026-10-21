#!/usr/bin/env node
// Scorer for pre-registered eval V2 (eval/replay/prereg-v2-gap-claims.md, Revision 2 + Amendment 3). Offline, no model calls, no repo code beyond SpecGuard's own parsers.
//   node eval/replay/v2-score.js --corpus v2-corpus.json --v2 DIR --arma DIR --cover-dir DIR --health cover-results.json --later later-tested.json --repos CLONES
//        [--covjson-from-ctx] [--judge judge-labels.json] [--calib calibration.json] [--skeleton skeleton-results.json] [--seed 20261021] [--perms 1000] --out result.json
// DIR layout: DIR/rep<k>/<id>/result.json (+ ctx/coverage.json for the V2 arm). Everything is gated on the clean-counterpart subset; all-PR numbers are reported next to it.
const fs = require('node:fs');
const path = require('node:path');
const { mulberry32, isTest } = require('../szz');
const { parse } = require('../../src/coverage');
const { loadHits, unusableReason, errCoversSource } = require('./coverage-e1-score');

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i < 0 ? d : process.argv[i + 1]; };
const SEED = 20261021; // the only seed the V2 prereg names (corpus seed)
const pct = (a, q) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : null; }; // p90 of n=30 = 3rd largest
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
const uniq = (a) => [...new Set(a)];

function wilson(k, n, z = 1.96) {
  if (!n) return [null, null];
  const p = k / n, d = 1 + z * z / n, c = p + z * z / (2 * n), m = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n));
  return [Math.max(0, (c - m) / d), Math.min(1, (c + m) / d)];
}

// ---- finding classes: `source` comes from the counts marker / trailer (replay.js puts it on result.findings) ----
const isRa = (f) => f.source === 'coverage';
const isRb = (f) => f.source === 'relabel';
const isRc = (f) => f.kind === 'missing_test' && !f.source; // a model missing_test (verified-or-not decided by the report; "unknown" in the worst case)
const validRun = (r) => !!r && r.valid !== false && Array.isArray(r.findings);

// "L3, L9-L11, +2 more" in an R-a title -> { lines, truncated }
function titleLines(f) {
  const m = /\(((?:L\d+(?:-L\d+)?(?:, )?)+)(, \+\d+ more)?\)\s*$/.exec(f.title || '');
  if (!m) return { lines: [f.line], truncated: true };
  const lines = [];
  for (const r of m[1].split(', ')) { const [a, b] = r.replace(/L/g, '').split('-').map(Number); for (let l = a; l <= (b ?? a); l++) lines.push(l); }
  return { lines, truncated: !!m[2] };
}
// definition name of an R-a title ("name: N added lines never executed ..."); null for "definition at L12" or a path label
const raName = (f) => { const m = /^([A-Za-z_$][\w$]*): \d+ added lines? never executed/.exec(f.title || ''); return m && m[1].length >= 4 ? m[1] : null; };

// G1: technical truth of each R-a at LINE level from the RAW report (E1's loadHits), never from coverage.json. covJson is only an audit of coverage.json against the raw report.
// known: all changed non-test files of the PR (as src/coverage.js resolves report paths), not just the R-a paths.
function g1For(id, runs, report, covJson, known) {
  const ra = runs.flatMap((r, rep) => r.findings.filter(isRa).map((f) => ({ f, rep }))), out = { total: ra.length, verified: 0, false_: 0, unverifiable: 0, truncated: 0, covjson_disagree: 0, detail: [] };
  if (!ra.length) return out;
  const hits = report ? loadHits(report, uniq([...(known || []), ...ra.map((x) => x.f.path)])) : null;
  for (const { f, rep } of ra) {
    const { lines, truncated } = titleLines(f), h = hits && hits.get(f.path);
    if (truncated) out.truncated++;
    if (!hits) { out.unverifiable++; out.detail.push({ rep, path: f.path, line: f.line, verdict: 'no_report' }); continue; }
    const bad = lines.filter((l) => !h || h.get(l) !== 0);
    if (!bad.length) out.verified++; else { out.false_++; out.detail.push({ rep, path: f.path, line: f.line, verdict: 'not_never_run', lines: bad }); }
    const never = (covJson?.files?.[f.path]?.never || []).some((r) => lines.every((l) => l >= r[0] && l <= r[1]) || false);
    if (covJson && bad.length && never) out.covjson_disagree++; // coverage.json says never, the raw report disagrees
  }
  return out;
}

// g1_all: every never-run line coverage.json lists for the changed files (inline R-a, rolled-up R-a and unreported ones alike) checked against the raw report.
function g1All(report, covJson, known) {
  const out = { lines: 0, verified: 0, rate: null };
  if (!report || !covJson || !covJson.files) return out;
  const hits = loadHits(report, uniq([...(known || []), ...Object.keys(covJson.files)]));
  for (const [p, cf] of Object.entries(covJson.files)) for (const r of cf.never || []) for (let l = r[0]; l <= r[1]; l++) { out.lines++; if (hits.get(p)?.get(l) === 0) out.verified++; }
  out.rate = out.lines ? out.verified / out.lines : null;
  return out;
}

// G2: R-a stability. Jaccard of the R-a sets (kind+path+/-5 lines) between every pair of reps; 1.0 required. Empty vs empty = 1.
function jaccard(a, b) {
  const used = new Set(); let m = 0;
  for (const x of a) { const i = b.findIndex((y, j) => !used.has(j) && y.path === x.path && Math.abs(y.line - x.line) <= 5); if (i >= 0) { used.add(i); m++; } }
  const u = a.length + b.length - m; return u ? m / u : 1;
}
function stability(runs, pick) {
  const sets = runs.map((r) => r.findings.filter(pick).map((f) => ({ path: f.path, line: f.line }))), js = [];
  for (let i = 0; i < sets.length; i++) for (let j = i + 1; j < sets.length; j++) js.push(jaccard(sets[i], sets[j]));
  return js.length ? Math.min(...js) : null;
}

// ---- E1' (p): later-tested precision@3 ----
// R-a set of a run: the inline groups (V2's top 3, in rank order) then the rolled-up groups (names only). Items without a usable name cannot be matched and are counted apart.
function raSet(r) {
  const inline = r.findings.filter((f) => isRa(f) && f.where === 'inline').map((f) => ({ name: raName(f), inline: true }));
  const rest = r.findings.filter((f) => isRa(f) && f.where !== 'inline').map((f) => ({ name: raName(f), inline: false }));
  const roll = (r.rollup || []).flatMap((g) => g.names.map((n) => ({ name: /^[A-Za-z_$][\w$]*$/.test(n) && n.length >= 4 ? n : null, inline: false })));
  return [...inline, ...rest, ...roll];
}
// One-sided PR-cluster permutation: within every run the order of the R-a set is shuffled (the random-order arm), the statistic is the mean over PRs of the mean precision@3 of its runs.
// obs = V2's own top-3 (its delivered inline R-a); p = share of permutations whose statistic >= obs. The gate is p < .05, never a bare obs > mean(random).
function rankGate(clusters, { seed = SEED, perms = 1000 } = {}) {
  // clusters: [{ id, items: [{ y: 0|1, top: bool }...] }]: one PR = ONE ranking (R-a is deterministic, rep 1's set); y = later tested; top = V2 put it in its top 3.
  // A PR with no named top item has no observed value, so it is out of the observed AND the null statistic.
  const cl = clusters.filter((c) => c.items.some((x) => x.top));
  if (!cl.length) return { n_prs: 0, v2_at3: null, random_at3: null, p: null, pass: null };
  const sum = (a) => a.reduce((s, x) => s + x.y, 0), ns = cl.map((c) => c.items.filter((x) => x.top).length);
  const obs = mean(cl.map((c, i) => sum(c.items.filter((x) => x.top)) / ns[i]));
  const rnd = mulberry32(seed), nulls = [];
  for (let b = 0; b < perms; b++) {
    // one shuffle per PR per permutation (reps repeat the same ranking, so they must not be shuffled independently)
    nulls.push(mean(cl.map((c, i) => { const a = [...c.items]; for (let q = a.length - 1; q > 0; q--) { const j = Math.floor(rnd() * (q + 1)); [a[q], a[j]] = [a[j], a[q]]; } return sum(a.slice(0, ns[i])) / ns[i]; })));
  }
  const p = (1 + nulls.filter((x) => x >= obs - 1e-12).length) / (1 + perms);
  return { n_prs: cl.length, v2_at3: obs, random_at3: mean(nulls), p, pass: p < 0.05 };
}

// ---- the measures of one PR subset ----
function measures(ids, X) {
  const { runsV2, runsA, reports, covJson, later, tests, defOf, judge, skeleton } = X;
  const scored = ids.filter((id) => (runsV2[id] || []).length >= (X.reps || 3));
  const out = { prs: ids.length, scored_prs: scored.length };
  // G1 + env artifact
  const g = { total: 0, verified: 0, false: 0, unverifiable: 0, truncated: 0, covjson_disagree: 0 }; let env = 0, named = 0; const gAll = { lines: 0, verified: 0 };
  for (const id of scored) {
    const x = g1For(id, runsV2[id], reports[id], covJson[id], X.changed(id)), ga = g1All(reports[id], covJson[id], X.changed(id));
    gAll.lines += ga.lines; gAll.verified += ga.verified;
    g.total += x.total; g.verified += x.verified; g.false += x.false_; g.unverifiable += x.unverifiable; g.truncated += x.truncated; g.covjson_disagree += x.covjson_disagree;
    for (const n of uniq(runsV2[id].flatMap((r) => r.findings.filter(isRa).map(raName)).filter(Boolean))) { named++; if (tests(id, n)) env++; }
  }
  out.G1 = { ...g, rate: g.total ? g.verified / g.total : null, pass: g.total ? g.verified === g.total : null, g1_all: { ...gAll, rate: gAll.lines ? gAll.verified / gAll.lines : null } };
  out.env_artifact = { definitions_named: named, test_file_names_definition_but_never_ran: env };
  // G2
  const st = scored.map((id) => stability(runsV2[id], isRa)).filter((x) => x !== null);
  out.G2 = { min_jaccard: st.length ? Math.min(...st) : null, pass: st.length ? st.every((x) => x === 1) : null };
  const ms = scored.map((id) => stability(runsV2[id], (f) => f.kind === 'missing_test' && !isRa(f))).filter((x) => x !== null).sort((a, b) => a - b);
  out.model_stability_median = ms.length ? ms[Math.floor(ms.length / 2)] : null; // descriptive (Revision 1: >= 0.5)
  // E1'(p)
  // R-a is deterministic: every PR is scored on rep 1's set, and the sets of all reps must be equal (a difference is reported and is also a G2 failure)
  const clusters = [], base = {}, mismatch = [], tops = [], unscorable = { unnamed: 0, rollup_more: 0 };
  const sig = (r) => raSet(r).map((it) => `${it.inline ? 'I' : 'R'}:${it.name}`).join(',');
  for (const id of scored) {
    const repo = id.split('-')[0], r1 = runsV2[id][0], set = raSet(r1);
    if (runsV2[id].some((r) => sig(r) !== sig(r1))) mismatch.push(id);
    unscorable.unnamed += set.filter((it) => !it.name).length;
    unscorable.rollup_more += (r1.rollup || []).reduce((s, g) => s + Math.max(0, g.count - g.names.length), 0); // "+N more" names the summary does not list
    const items = set.filter((it) => it.name).map((it) => ({ y: later(id, it.name) ? 1 : 0, top: it.inline }));
    clusters.push({ id, items });
    const inl = set.filter((it) => it.inline);
    if (inl.length) tops.push({ n: inl.length, unnamed: inl.filter((it) => !it.name).length, hits: inl.filter((it) => it.name && later(id, it.name)).length });
    for (const it of items) { (base[repo] ||= [0, 0])[0] += it.y; base[repo][1]++; }
  }
  const gate = rankGate(clusters, X), topN = tops.reduce((s, t) => s + t.n, 0), share = topN ? tops.reduce((s, t) => s + t.unnamed, 0) / topN : null;
  out.E1p = { ...gate, gate_raw: gate.pass, v2_at3_unnamed_as_0: tops.length ? mean(tops.map((t) => t.hits / t.n)) : null, unnamed_share_top3: share, readable: share === null ? null : share <= 0.2,
    unscorable_items: unscorable, rep_set_mismatch: mismatch, base_rate_by_repo: Object.fromEntries(Object.entries(base).map(([k, [a, n]]) => [k, { later_tested: a, n, rate: a / n }])), by_kind: {} };
  if (share !== null && share > 0.2) out.E1p.pass = null; // not readable: too many inline R-a have no name to match (pre-stated threshold 0.20)
  const label = (f) => (isRa(f) ? 'missing_test:R-a' : isRb(f) ? 'weak_test:R-b' : f.kind + (f.source ? ':' + f.source : ':model'));
  for (const [arm, runsOf] of [['v2', runsV2], ['armA', runsA]]) {
    const acc = {};
    for (const id of scored) for (const r of runsOf[id] || []) {
      const seen = {};
      for (const f of r.findings) {
        const k = label(f); if ((seen[k] = (seen[k] || 0) + 1) > 3) continue; // first 3 delivered of a kind per run (inline first, as listed)
        const name = isRa(f) ? raName(f) : defOf(id, f.path, f.line);
        const a = (acc[k] ||= { hits: 0, n: 0, unnamed: 0 });
        if (!name) a.unnamed++; else { a.n++; a.hits += later(id, name) ? 1 : 0; }
      }
    }
    out.E1p.by_kind[arm] = Object.fromEntries(Object.entries(acc).map(([k, a]) => [k, { ...a, precision_at3: a.n ? a.hits / a.n : null }]));
  }
  // E1'(j): judge interface
  const top = uniq(scored.flatMap((id) => runsV2[id].flatMap((r) => r.findings.filter((f) => isRa(f) && f.where === 'inline').slice(0, 3).map((f) => `${id}|${f.path}|${f.line}`))));
  const lab = judge && judge.labels ? top.filter((k) => judge.labels[k]) : [];
  if (!judge || !lab.length) out.E1j = { status: 'judge not run' };
  else { const yes = lab.filter((k) => judge.labels[k] === 'yes').length; out.E1j = { status: 'run', items: top.length, labelled: lab.length, missing_labels: top.length - lab.length, yes, rate: yes / lab.length, wilson: wilson(yes, lab.length) }; }
  // silence + volume per PR: each PR's value is the median over its reps (R-a repeats, model findings vary), then the median across PRs (p90 = element floor(0.9n) of the ascending sort; n=30 -> the 3rd largest)
  const per = scored.map((id) => { const rs = runsV2[id], med = (f) => pct(rs.map(f), 0.5), cnt = (r, w) => r.findings.filter((f) => f.where === w).length; return { id, inline: med((r) => cnt(r, 'inline')), summary: med((r) => cnt(r, 'summary')), inline_all: rs.reduce((s, r) => s + cnt(r, 'inline'), 0), ra_inline: rs.reduce((s, r) => s + r.findings.filter((f) => isRa(f) && f.where === 'inline').length, 0) }; });
  const vol = (rs) => ({ prs: rs.length, inline_median: pct(rs.map((r) => r.inline), 0.5), inline_p90: pct(rs.map((r) => r.inline), 0.9), summary_median: pct(rs.map((r) => r.summary), 0.5), summary_p90: pct(rs.map((r) => r.summary), 0.9), silence: rs.length ? rs.filter((r) => !r.inline).length / rs.length : null, ra_inline_share: rs.reduce((s, r) => s + r.inline_all, 0) ? rs.reduce((s, r) => s + r.ra_inline, 0) / rs.reduce((s, r) => s + r.inline_all, 0) : null });
  out.volume = { ...vol(per), by_stratum: Object.fromEntries(uniq(scored.map((id) => X.stratum[id] || '?')).sort().map((s) => [s, vol(per.filter((r) => (X.stratum[r.id] || '?') === s))])) };
  // D
  const inl = scored.flatMap((id) => runsV2[id].flatMap((r) => r.findings.filter((f) => isRa(f) && f.where === 'inline').map((f) => `${id}|${f.path}|${f.line}`)));
  if (!skeleton) out.D = { status: 'not run' };
  else { const m = new Map((skeleton.items || []).map((i) => [`${i.id}|${i.path}|${i.line}`, i])); const ok = inl.filter((k) => m.get(k)?.compiles && m.get(k)?.executes_gap).length, none = inl.filter((k) => !m.get(k)?.has_skeleton).length; out.D = { status: 'run', inline_ra: inl.length, ok, rate: inl.length ? ok / inl.length : null, without_skeleton: none, reading: inl.length && ok / inl.length >= 0.5 ? 'plus an executable test skeleton' : 'patch coverage grouped and ranked by definition' }; }
  // H: R-a verified line-level; R-b and R-c unknown (worst case counts them as NOT verified)
  let all = 0, ver = 0, unk = 0;
  for (const id of scored) {
    const v = g1For(id, runsV2[id], reports[id], null, X.changed(id));
    for (const r of runsV2[id]) { all += r.findings.filter((f) => isRa(f) || isRb(f) || isRc(f)).length + (r.rollup || []).reduce((s, g) => s + g.count, 0); unk += r.findings.filter((f) => isRb(f) || isRc(f)).length + (r.rollup || []).reduce((s, g) => s + g.count, 0); }
    ver += v.verified;
  }
  out.H = { delivered: all, verified: ver, unknown: unk, false_or_unverified_ra: all - ver - unk, worst: all ? ver / all : null, best: all ? (ver + unk) / all : null, target_met_worst: all ? ver / all >= 0.9 : null };
  return out;
}

// clean-counterpart subset (B3): a usable cover run and no file error AND no failing test (file_failures, f2p/cover.js) on a test file that names or neighbours ANY changed code file (E1's errCoversSource).
function cleanIds(ids, { health, reports, changed }) {
  return ids.filter((id) => {
    const rec = health[id] || null, src = changed(id), hits = reports[id] ? loadHits(reports[id], src) : null;
    if (unusableReason({ rec, hits, changedSrc: src })) return false;
    // independent of the findings: NO counterpart test file of ANY changed code file may have a load error or a failing test
    return ![...Object.keys(rec.file_errors || {}), ...Object.keys(rec.file_failures || {})].some((ef) => src.some((s) => errCoversSource(ef, s)));
  });
}

function score(X) {
  const ids = X.ids, clean = cleanIds(ids, X), mAll = measures(ids, X), mClean = measures(clean, X);
  const judgeCal = (() => {
    const c = X.calib; if (!c) return { status: 'not run', valid: null };
    const pos = c.items.filter((i) => i.type === 'positive'), neg = c.items.filter((i) => i.type === 'negative');
    const sens = wilson(pos.filter((i) => i.label === 'yes').length, pos.length), spec = wilson(neg.filter((i) => i.label === 'no').length, neg.length);
    return { status: 'run', n_pos: pos.length, n_neg: neg.length, sensitivity_wilson: sens, specificity_wilson: spec, valid: pos.length >= 40 && neg.length >= 40 && sens[0] >= 0.75 && spec[0] >= 0.75 };
  })();
  const m = mClean; // N1: every gate reads the clean-counterpart subset
  const j = m.E1j.status === 'run' && judgeCal.valid !== null && m.E1j.missing_labels === 0 ? (judgeCal.valid ? m.E1j.wilson[0] >= 0.7 : false) : null; // every item must be labelled
  const gates = {
    g1_g2: m.G1.pass === false || m.G2.pass === false ? false : m.G1.pass === null || m.G2.pass === null ? null : true, // false wins over null
    ranking: m.E1p.pass,
    judge: j,
    inline_median: m.volume.inline_median === null ? null : m.volume.inline_median <= 3,
  };
  const vals = Object.values(gates);
  const prompt = (() => { let same = 0, diff = 0; for (const id of ids) (X.runsV2[id] || []).forEach((r) => { const a = (X.runsA[id] || []).find((x) => x.rep === r.rep); if (a && r.prompt_sha256 && a.prompt_sha256) (r.prompt_sha256 === a.prompt_sha256 ? same++ : diff++); }); return { same, differ: diff, arm_a_must_run_live: diff > 0 }; })();
  return { clean_ids: clean, clean_n: clean.length, all_n: ids.length, clean: mClean, all: mAll, judge_calibration: judgeCal, gates, pass: vals.includes(false) ? false : vals.includes(null) ? null : true, prompt_check: prompt };
}

// ---- CLI loading ----
function loadRuns(dir) {
  const out = {};
  if (!dir || !fs.existsSync(dir)) return out;
  for (const rep of fs.readdirSync(dir).filter((n) => /^rep\d+$/.test(n)).sort()) for (const id of fs.readdirSync(path.join(dir, rep))) {
    try { const r = JSON.parse(fs.readFileSync(path.join(dir, rep, id, 'result.json'), 'utf8')); if (validRun(r)) (out[id] ||= []).push({ ...r, rep }); } catch { /* missing */ }
  }
  return out;
}
function main() {
  const { execFileSync } = require('node:child_process'), { enclosingDef } = require('../../src/test-map');
  const corpus = JSON.parse(fs.readFileSync(arg('corpus'), 'utf8')), repos = arg('repos'), v2 = arg('v2'), cdir = arg('cover-dir');
  const rj = (f) => (f ? JSON.parse(fs.readFileSync(f, 'utf8')) : null), lt = rj(arg('later')), rows = Object.fromEntries(corpus.rows.map((r) => [r.id, r]));
  const git = (r, ...a) => execFileSync('git', ['-C', path.join(repos, r.clone), ...a], { encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'ignore'] });
  const { testsName } = require('./testgap-score');
  const scope = (r) => { const c = require('../f2p/repos.json')[r.repo].cover; return git(r, 'ls-tree', '-r', '--name-only', r.sha).split('\n').filter((p) => c.dirs.some((d) => p.startsWith(d)) && new RegExp(c.file_re).test(p) && !(c.exclude || []).some((e) => p.includes(e))); };
  const loadReport = (id) => { for (const f of ['lcov.info', 'coverage.xml']) { try { return parse(fs.readFileSync(path.join(cdir, id, f), 'utf8')); } catch { /* next */ } } return null; };
  const ids = Object.keys(rows), reports = Object.fromEntries(ids.map((id) => [id, loadReport(id)])), tf = {}, cache = new Map();
  const X = {
    ids, reps: +arg('reps', 3), seed: +arg('seed', SEED), perms: +arg('perms', 1000), runsV2: loadRuns(v2), runsA: loadRuns(arg('arma')), reports,
    covJson: Object.fromEntries(ids.map((id) => { try { return [id, JSON.parse(fs.readFileSync(path.join(v2, 'rep1', id, 'ctx', 'coverage.json'), 'utf8'))]; } catch { return [id, null]; } })),
    health: (rj(arg('health')) || {}).groups || {}, stratum: Object.fromEntries(ids.map((id) => [id, rows[id].stratum])),
    changed: (id) => git(rows[id], 'diff-tree', '--no-commit-id', '--name-only', '-r', rows[id].parent, rows[id].sha).split('\n').filter((f) => f && !isTest(f)), // changed code files (non-test), as src/coverage.js's `known`
    tests: (id, n) => testsName(path.join(repos, rows[id].clone), rows[id].sha, (tf[id] ||= scope(rows[id])), n),
    later: (id, n) => { const row = lt.rows.find((x) => x.id === id); return row.commits.some((c) => testsName(path.join(repos, rows[id].clone), c.sha, c.test_files.map((t) => t.path), n)); },
    defOf: (id, p, l) => { try { const d = enclosingDef(git(rows[id], 'show', `${rows[id].sha}:${p}`).split('\n'), l, cache); return d && d.name && d.name.length >= 4 ? d.name : null; } catch { return null; } },
    judge: rj(arg('judge')), calib: rj(arg('calib')), skeleton: rj(arg('skeleton')),
  };
  const out = score(X);
  fs.writeFileSync(arg('out'), JSON.stringify(out, null, 1));
  console.log(JSON.stringify({ pass: out.pass, gates: out.gates, clean_n: out.clean_n, all_n: out.all_n }, null, 1));
}
if (require.main === module) main();
module.exports = { wilson, titleLines, raName, g1For, jaccard, stability, rankGate, measures, cleanIds, score, loadRuns };
