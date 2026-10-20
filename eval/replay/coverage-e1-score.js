#!/usr/bin/env node
// Offline scorer for pre-registered eval E1 (eval/replay/prereg-coverage-gap-e1.md): do coverage gaps (changed lines no unit test executed) land where test-gap bugs were introduced? No model calls.
//   node eval/replay/coverage-e1-score.js --pairs holdout2-pairs.json --fixshas fixshas.json --repos <clones dir> --cover-results results-cover-SET.json \
//     --cover-dir <evidence>/f2p/cover/SET --rows coverage-e1-design.json --out result.json [--seed 20261020] [--perms 1000] [--boots 2000] [--raw <holdout2 raw> --runs R1,R2,R3] [--power-n 40 --sims 1000]
const fs = require('node:fs');
const path = require('node:path');
const { isTest, mulberry32 } = require('../szz');
const { git, tryGit, addedLines } = require('./holdout2-null');
const { parse, resolver } = require('../../src/coverage');
const { isCode, buildUnits, pairData, qualifies, testsName, word, parseDiff } = require('./testgap-score');

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i < 0 ? d : process.argv[i + 1]; };
const mean = (a) => { let s = 0; for (const x of a) s += x; return a.length ? s / a.length : 0; };
const pct = (a, q) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.max(0, Math.floor(q * s.length)))] : 0; };
const ci = (a) => [pct(a, 0.025), pct(a, 0.975)];
const EPS = 1e-12;

// ---- pure pieces (tested) ----
// parsed coverage report -> Map(repo-relative changed path -> Map(line -> hits)); paths the resolver cannot place on a changed file are dropped
function loadHits(parsed, changedFiles) {
  const resolve = resolver(new Set(changedFiles)), out = new Map();
  for (const [raw, lines] of parsed.files) {
    const to = resolve(raw, parsed.sources || []);
    if (!to) continue;
    const m = out.get(to) || out.set(to, new Map()).get(to);
    for (const [l, h] of lines) m.set(l, (m.get(l) || 0) + h);
  }
  return out;
}
// Arm C: per changed unit, the added lines the report instruments; flag at the first one with 0 hits. A unit with no instrumented added line is skipped and counted.
function coverFlags(changedUnits, hits) {
  const flags = [], elig = []; let noInst = 0;
  for (const u of changedUnits) {
    const h = hits.get(u.path), inst = h ? u.added.filter((l) => h.has(l)) : [];
    if (!inst.length) { noInst++; continue; }
    const miss = inst.find((l) => h.get(l) === 0);
    elig.push({ path: u.path, lines: inst });
    if (miss !== undefined) flags.push({ path: u.path, line: miss, name: u.name });
  }
  return { flags, noInst, elig };
}
const stem = (f) => path.posix.basename(f).replace(/\.[^.]*$/, '');
const GENERIC = new Set(['index', '__init__', 'main', 'types', 'utils', 'package']); // stems every module has: never matched by name
// does test file `errPath` name source file `src` (a non-generic module stem as a whole word in the test FILE name, which also covers flat test dirs such as sqlglot tests/ or libs/core/tests/unit_tests/)
// or sit beside its test counterpart (any file in that directory)?
// ponytail: counterpart = same directory as the source, or a tests/ directory whose last segment equals the source directory's last segment; upgrade if a repo mirrors differently.
function errCoversSource(errPath, src) {
  const s = stem(src);
  if (!GENERIC.has(s.toLowerCase()) && new RegExp('(?<![A-Za-z0-9])' + s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![A-Za-z0-9])').test(path.posix.basename(errPath))) return true;
  const ed = path.posix.dirname(errPath), sd = path.posix.dirname(src);
  return ed === sd || (/(^|\/)tests?\//.test(errPath + '/') && path.posix.basename(ed) === path.posix.basename(sd));
}
// first matching reason, or null. rec: the cover group record; hits: Map or null (no report); changedSrc: changed source file paths
function unusableReason({ rec, hits, changedSrc }) {
  if (!rec || rec.error || !hits) return 'no_report';
  if (!(rec.selected_tests > 0)) return 'no_selected_tests';
  if (!changedSrc.some((f) => hits.has(f))) return 'covers_no_changed_file';
  for (const [ef, e] of Object.entries(rec.file_errors || {})) if (e.kind === 'collection' && changedSrc.some((s) => errCoversSource(ef, s))) return 'collection_error';
  return null;
}
// one PR: usable flag/reason, C flags, outcome (1 = some flag is a catch, only when B is given)
function evalCover({ rec, parsed, changedUnits, changedFiles, B }) {
  const hits = parsed ? loadHits(parsed, changedFiles) : null, changedSrc = [...new Set(changedUnits.map((u) => u.path))];
  const reason = unusableReason({ rec, hits, changedSrc });
  if (reason) return { usable: false, reason, flags: [], noInst: 0, outcome: 0, elig: changedUnits.map((u) => ({ path: u.path, lines: u.added })) };
  const { flags, noInst, elig } = coverFlags(changedUnits, hits);
  return { usable: true, reason: null, flags, noInst, elig, outcome: B && flags.some((f) => B.has(f.path, f.line)) ? 1 : 0 };
}
function bootCi(vals, seed, boots) {
  if (!vals.length) return [0, 0];
  const rng = mulberry32(seed);
  return ci(Array.from({ length: boots }, () => mean(Array.from({ length: vals.length }, () => vals[Math.floor(rng() * vals.length)]))));
}
// E1 null for one PR: k flags on DISTINCT eligible units drawn without replacement (C and static flag a unit at most once); the flag sits on a uniformly random eligible line.
// Weights: eligible line count (primary) or 1 (secondary). k >= number of eligible units: every unit is flagged, so the null equals the observed outcome exactly.
function drawNull(rng, perms, k, elig, B, uniform, outcome, forced) { // forced: unusable PR, observed 0 is not from flagging, so no shortcut
  const out = new Uint8Array(perms);
  if (!k || !elig.length) return out;
  if (k >= elig.length && !forced) return out.fill(outcome);
  for (let j = 0; j < perms; j++) {
    const pool = elig.map((u) => ({ u, w: uniform ? 1 : u.lines.length }));
    for (let n = 0; n < Math.min(k, elig.length); n++) {
      let r = rng() * pool.reduce((s, x) => s + x.w, 0), i = 0;
      while (i < pool.length - 1 && r >= pool[i].w) { r -= pool[i].w; i++; }
      const { u } = pool.splice(i, 1)[0];
      if (B.has(u.path, u.lines[Math.floor(rng() * u.lines.length)])) out[j] = 1;
    }
  }
  return out;
}
// Null bits for every item, both nulls: { primary: Uint8Array[], secondary: Uint8Array[] } (the rng restarts per null kind).
// items: [{ d: { B }, k: flags used by the null, outcome, elig: [{ path, lines }], forced }]
function nullBitsAll(items, { seed = 20261020, perms = 1000 } = {}) {
  const out = {};
  for (const kind of ['primary', 'secondary']) { const rng = mulberry32(seed); out[kind] = items.map((i) => drawNull(rng, perms, i.k, i.elig, i.d.B, kind === 'secondary', i.outcome, i.forced)); }
  return out;
}
// Verdict from outcomes and their precomputed bits. The verdict uses the null with the higher chance. PASS iff p < 0.05 and observed - chance >= 0.10.
function decide(outcomes, bits, perms) {
  const obs = mean(outcomes), R = {};
  for (const kind of ['primary', 'secondary']) {
    const b = bits[kind], nul = Array.from({ length: perms }, (_, j) => { let s = 0; for (const x of b) s += x[j]; return s / b.length; });
    R[kind] = { chance: mean(nul), p: nul.filter((x) => x >= obs - EPS).length / perms };
  }
  const vn = R.primary.chance >= R.secondary.chance ? 'primary' : 'secondary', v = R[vn], effect = obs - v.chance;
  return { observed: obs, chance: v.chance, p: v.p, effect, verdict_null: vn, primary: R.primary, secondary: R.secondary, pass: v.p < 0.05 && effect >= 0.10 - EPS };
}
function armScore(items, { seed = 20261020, perms = 1000, boots = 2000 } = {}) {
  if (!items.length) return { n: 0, observed: 0, chance: 0, p: 1, effect: 0, pass: false };
  const bits = nullBitsAll(items, { seed, perms }), d = decide(items.map((i) => i.outcome), bits, perms);
  return { n: items.length, ...d, effect_ci95: bootCi(items.map((i, j) => i.outcome - mean(bits[d.verdict_null][j])), seed, boots) };
}
// Power for a confirmation of n PRs: resample the PRs with replacement to n, reuse each PR's precomputed null bits, share of sims that PASS.
function powerOf(items, { seed = 20261020, perms = 1000 } = {}, n, sims) {
  if (!items.length) return null;
  const bits = nullBitsAll(items, { seed, perms }), rng = mulberry32(seed + 1);
  let pass = 0;
  for (let s = 0; s < sims; s++) {
    const idx = Array.from({ length: n }, () => Math.floor(rng() * items.length));
    if (decide(idx.map((i) => items[i].outcome), { primary: idx.map((i) => bits.primary[i]), secondary: idx.map((i) => bits.secondary[i]) }, perms).pass) pass++;
  }
  return { n, sims, pass_share: pass / sims };
}
// Comparison 4 label of a cited line: confirmed (instrumented, 0 hits), contradicted (hits > 0), unknown (not instrumented)
function labelLine(hits, p, line) {
  const v = hits?.get(p)?.get(line);
  return v === undefined ? 'unknown' : v === 0 ? 'confirmed' : 'contradicted';
}

// ---- git side ----
const linesAt = (dir, rev, file) => tryGit(dir, 'show', `${rev}:${file}`).split('\n');
// changed units of base..head, shared by bug PRs (the same fields as pairData) and controls (no fix sha needed)
function unitsFor(dir, base, head) {
  const changedFiles = git(dir, 'diff', '--name-only', '--no-renames', base, head).split('\n').filter((f) => f && isCode(f)), changedUnits = [];
  for (const file of changedFiles) {
    const add = addedLines(dir, base, head, file);
    for (const u of buildUnits(linesAt(dir, head, file))) { const a = add.filter((n) => n >= u.start && n <= u.end); if (a.length) changedUnits.push({ path: file, name: u.name, start: u.start, end: u.end, added: a }); }
  }
  return { changedFiles: new Set(changedFiles), changedUnits };
}
// static arm for a PR without pairData (controls): same rule as pairData's flags
function staticFlags(dir, base, head, changedUnits) {
  const testText = parseDiff(git(dir, 'diff', '-U0', '--no-color', '--no-renames', base, head)).filter((f) => f.newPath && isTest(f.newPath)).flatMap((f) => f.added.map((x) => x.text)).join('\n');
  const headTests = tryGit(dir, 'ls-tree', '-r', '--name-only', head).split('\n').filter((f) => f && isTest(f));
  return changedUnits.filter((u) => u.name && !word(u.name).test(testText) && !testsName(dir, head, headTests, u.name)).map((u) => ({ path: u.path, line: u.added[0], name: u.name }));
}
const groupOf = (r) => r.id; // the findings-free import names each cover group by the row id
function loadReport(coverDir, group) {
  for (const f of ['lcov.info', 'coverage.xml']) { try { return parse(fs.readFileSync(path.join(coverDir, group, f), 'utf8')); } catch { /* next */ } }
  return null;
}

// The same validity check as testgap-score's main(): a run is usable only if it succeeded with findings and a non-empty context pack.
const runValid = (r) => !!r && r.valid !== false && r.engine_status === 'success' && !r.skip && Array.isArray(r.findings) && !(r.engine_notes || []).some((n) => /context pack: 0 files/.test(n));
// even n: the upper middle value (sorted[floor(n/2)]); computed over usable controls only; null with no usable control
const medianUpper = (a) => (a.length ? pct(a, 0.5) : null);

function summarize(set, opt) { // set: evaluated bug PRs { id, repo, rec, d: { changedUnits, B }, c: evalCover result, sflags }
  const item = (x, k) => ({ d: x.d, k, outcome: x.c.outcome, elig: x.c.elig, forced: !x.c.usable });
  const sElig = (x) => x.d.changedUnits.filter((u) => u.name).map((u) => ({ path: u.path, lines: u.added }));
  const usable = set.filter((x) => x.c.usable), sItems = set.map((x) => ({ d: x.d, k: x.sflags.length, elig: sElig(x), outcome: x.sflags.some((f) => x.d.B.has(f.path, f.line)) ? 1 : 0 }));
  const cItems = set.map((x) => item(x, x.c.usable ? x.c.flags.length : 1)); // unusable: observed 0, null uses 1 flag
  const byDeps = (v) => { const s = usable.filter((x) => !!(x.rec && x.rec.deps_changed) === v); return { prs: s.length, ...armScore(s.map((x) => item(x, x.c.flags.length)), opt) }; };
  const tally = (f) => set.filter((x) => !x.c.usable).reduce((a, x) => ((a[f(x)] = (a[f(x)] || 0) + 1), a), {});
  const diff = set.map((_, i) => cItems[i].outcome - sItems[i].outcome);
  const rec = (x) => x.rec || {}, health = (x) => rec(x).health || {};
  return {
    prs: set.length, flags_per_pr: set.map((x) => ({ id: x.id, c: x.c.flags.length, static: x.sflags.length })),
    unusable: { count: set.length - usable.length, by_reason: tally((x) => x.c.reason), by_repo: tally((x) => x.repo) },
    usable_suite_health: { prs: usable.length, with_other_errors: usable.filter((x) => Object.values(rec(x).file_errors || {}).some((e) => e.kind === 'other')).length,
      nonzero_exit_code: usable.filter((x) => health(x).exit_code != null && health(x).exit_code !== 0).length, timed_out: usable.filter((x) => health(x).timed_out).length },
    units_without_instrumented_lines: usable.reduce((s, x) => s + x.c.noInst, 0),
    c: armScore(cItems, opt), c_usable_only: armScore(usable.map((x) => item(x, x.c.flags.length)), opt), static: armScore(sItems, opt),
    c_minus_static: { mean: mean(diff), ci95: bootCi(diff, opt.seed, opt.boots), prs_unusable_for_c: set.length - usable.length, prs_unusable_for_static: 0 },
    by_deps_changed_usable_only: { true: byDeps(true), false: byDeps(false) },
    ...(opt.powerN ? { power_c: powerOf(cItems, opt, opt.powerN, opt.sims) } : {}),
  };
}

function main() {
  const opt = { seed: +arg('seed', 20261020), perms: +arg('perms', 1000), boots: +arg('boots', 2000), powerN: +arg('power-n', 0), sims: +arg('sims', 1000) };
  const rows = JSON.parse(fs.readFileSync(arg('rows'), 'utf8')), pairs = JSON.parse(fs.readFileSync(arg('pairs'), 'utf8')).pairs;
  const fixsha = JSON.parse(fs.readFileSync(arg('fixshas'), 'utf8')), cover = JSON.parse(fs.readFileSync(arg('cover-results'), 'utf8')).groups || {};
  const bugs = [], controls = [], kinds = { collection: 0, empty: 0, other: 0 };
  for (const r of rows) {
    const g = groupOf(r), rec = cover[g] || null, parsed = loadReport(arg('cover-dir'), g), dir = path.join(arg('repos'), r.repo.split('/')[1]);
    for (const e of Object.values((rec && rec.file_errors) || {})) kinds[e.kind] = (kinds[e.kind] || 0) + 1;
    if (r.kind === 'control') {
      const u = unitsFor(dir, r.base, r.buggy_sha);
      controls.push({ id: r.id, units: u.changedUnits.length, c: evalCover({ rec, parsed, ...u }), sflags: staticFlags(dir, r.base, r.buggy_sha, u.changedUnits) });
      continue;
    }
    // a row carries its own pair metadata (introducing { base, head, merge_commit, number } and fix_sha), else it is looked up in --pairs by replay_id
    const p = r.introducing ? { id: r.id, replay_id: r.id, introducing: r.introducing } : pairs.find((x) => x.replay_id === r.id);
    if (!p) throw new Error(`row ${r.id}: no introducing metadata and no pair with this replay_id`);
    const fx = r.fix_sha || fixsha[p.id] || r.fixed_sha, d = pairData(dir, p, fx);
    bugs.push({ id: r.id, repo: r.repo, p, rec: rec || {}, d, c: evalCover({ rec, parsed, changedUnits: d.changedUnits, changedFiles: d.changedFiles, B: d.B }), sflags: d.flags, ok: qualifies(dir, fx).ok, hits: parsed ? loadHits(parsed, d.changedFiles) : null });
  }
  const out = { seed: opt.seed, perms: opt.perms, boots: opt.boots, file_error_kinds: kinds,
    rows: { all: summarize(bugs, opt), filtered: summarize(bugs.filter((x) => x.ok), opt), unfiltered: summarize(bugs.filter((x) => !x.ok), opt) } };
  const cu = controls.filter((x) => x.c.usable), sum = (a, f) => a.reduce((s, x) => s + f(x), 0), ratio = (a, b) => (b ? a / b : 0);
  const med = medianUpper(cu.map((x) => x.c.flags.length));
  out.controls = { prs: controls.length, c_unusable: controls.length - cu.length,
    c: { flags_per_pr: controls.map((x) => ({ id: x.id, n: x.c.usable ? x.c.flags.length : null })), share_units_flagged: ratio(sum(cu, (x) => x.c.flags.length), sum(cu, (x) => x.units)),
      share_prs_with_flag: ratio(cu.filter((x) => x.c.flags.length).length, cu.length), median_flags: med, noise_ceiling_ok: med === null ? null : med <= 2 },
    static: { flags_per_pr: controls.map((x) => ({ id: x.id, n: x.sflags.length })), share_units_flagged: ratio(sum(controls, (x) => x.sflags.length), sum(controls, (x) => x.units)),
      share_prs_with_flag: ratio(controls.filter((x) => x.sflags.length).length, controls.length), median_flags: medianUpper(controls.map((x) => x.sflags.length)) } };
  if (arg('raw')) { // comparison 4: every saved missing_test finding of a valid run, hidden or delivered; unusable-for-C PRs are tallied separately
    const mk = () => ({ confirmed: [0, 0], contradicted: [0, 0], unknown: [0, 0] }), lab = { usable: mk(), unusable_pr: mk() };
    let dropped = 0, invalidRuns = 0;
    for (const b of bugs) for (const run of arg('runs').split(',')) {
      let r = null; try { r = JSON.parse(fs.readFileSync(path.join(arg('raw'), run, 'replay-' + b.p.replay_id, 'result.json'), 'utf8')); } catch { /* missing run */ }
      if (!runValid(r)) { invalidRuns++; continue; }
      for (const f of r.findings.filter((x) => x.kind === 'missing_test')) {
        if (f.line == null || !f.path) { dropped++; continue; }
        const l = lab[b.c.usable ? 'usable' : 'unusable_pr'][labelLine(b.hits, f.path, f.line)]; l[0]++; if (b.d.B.has(f.path, f.line)) l[1]++;
      }
    }
    const fmt = (m) => Object.fromEntries(Object.entries(m).map(([k, [n, c]]) => [k, { n, catches: c, catch_rate: n ? c / n : null }]));
    out.comparison4 = { usable: fmt(lab.usable), unusable_pr: fmt(lab.unusable_pr), findings_dropped_no_line_or_path: dropped, invalid_runs_skipped: invalidRuns };
  }
  fs.writeFileSync(arg('out'), JSON.stringify(out, null, 1));
  console.log(JSON.stringify(out, null, 1));
}
if (require.main === module) main();
module.exports = { drawNull, loadHits, coverFlags, errCoversSource, unusableReason, evalCover, armScore, powerOf, summarize, runValid, medianUpper, bootCi, labelLine, groupOf };
