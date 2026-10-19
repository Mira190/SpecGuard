#!/usr/bin/env node
// Offline scoring of the test-gap MVP prereg (eval/replay/prereg-testgap-mvp.md) on the holdout-2 design set. No model calls.
//   node eval/replay/testgap-score.js --pairs holdout2-pairs.json --raw <holdout2-raw> --runs R1,R2,R3 --audit audit.json \
//     --repos <clones dir> --fixshas fixshas.json --out result.json [--seed 20261020] [--perms 1000] [--boots 2000] [--sims 1000]
// Confidence filter: PRIMARY treats a finding as low when confidence === 'low' OR its `why` says "low confidence" (summary findings carry
// confidence null and the marker only in `why`). SENSITIVITY = the literal field only. Both are computed in the same invocation.
const fs = require('node:fs');
const path = require('node:path');
const { isProd, isTest, isCommentLine, mulberry32 } = require('../szz');
const { enclosingName } = require('../../src/test-map');
const { git, tryGit, addedLines, blamedSpots } = require('./holdout2-null');

const TOL = 3, KINDS = new Set(['missing_test', 'weak_test']);
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i < 0 ? d : process.argv[i + 1]; };

// ---- pure pieces (tested) ----
// Maximal runs of consecutive lines with the same enclosingName: [{ name, start, end }] (1-based, inclusive).
function buildUnits(lines) {
  const out = [];
  for (let i = 1; i <= lines.length; i++) {
    const name = enclosingName(lines, i), t = out[out.length - 1];
    if (t && t.name === name) t.end = i; else out.push({ name, start: i, end: i });
  }
  return out;
}
const isLow = (f, mode = 'derived') => f.confidence === 'low' || (mode === 'derived' && /low confidence/i.test(f.why || ''));
// delivered missing_test/weak_test finding, not low confidence
const isCandidate = (f, mode) => KINDS.has(f.kind) && (f.where === 'inline' || f.where === 'summary') && !isLow(f, mode);
// B: blamed lines +-TOL, plus the full span of each NAMED unit enclosing a blamed line. unitsByPath: path -> buildUnits(...)
function makeB(blamed, unitsByPath) {
  const spans = [];
  for (const b of blamed) {
    const u = (unitsByPath[b.path] || []).find((x) => b.line >= x.start && b.line <= x.end);
    if (u && u.name !== null) spans.push({ path: b.path, start: u.start, end: u.end });
  }
  return { has: (p, l) => l != null && (spans.some((s) => s.path === p && l >= s.start && l <= s.end) || blamed.some((b) => b.path === p && Math.abs(b.line - l) <= TOL)) };
}
const isCatch = (f, B, mode) => isCandidate(f, mode) && f.line != null && !!f.path && B.has(f.path, f.line);

// ---- stats helpers ----
const pct = (a, q) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.max(0, Math.floor(q * s.length)))]; };
const mean = (a) => a.reduce((s, x) => s + x, 0) / (a.length || 1);
const ci = (a) => [pct(a, 0.025), pct(a, 0.975)];

// ---- git helpers ----
function parseDiff(raw) {
  const files = []; let cur = null, o = 0, n = 0;
  for (const l of raw.split('\n')) {
    if (l.startsWith('diff --git ')) { cur = { oldPath: null, newPath: null, removed: [], added: [] }; files.push(cur); continue; }
    if (!cur) continue;
    if (l.startsWith('--- ')) { cur.oldPath = l === '--- /dev/null' ? null : l.slice(6); continue; }
    if (l.startsWith('+++ ')) { cur.newPath = l === '+++ /dev/null' ? null : l.slice(6); continue; }
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(l);
    if (h) { o = +h[1]; n = +h[2]; continue; }
    if (l.startsWith('-')) cur.removed.push({ n: o++, text: l.slice(1) });
    else if (l.startsWith('+')) cur.added.push({ n: n++, text: l.slice(1) });
  }
  return files;
}
const linesAt = (dir, rev, file) => tryGit(dir, 'show', `${rev}:${file}`).split('\n');
const real = (x) => x.text.trim() !== '' && !isCommentLine(x.text);
const word = (name) => new RegExp('(?<![\\w$])' + name.replace(/[$]/g, '\\$') + '(?![\\w$])');

// test-gap filter on fix commit fx
function qualifies(dir, fx) {
  const files = parseDiff(git(dir, 'diff', '-U0', '-w', '-M', '--no-color', fx + '^', fx));
  const names = new Set(); let src = false; const testText = [];
  for (const f of files) {
    if (f.newPath && isTest(f.newPath)) { testText.push(...f.added.map((x) => x.text)); continue; }
    if (!(f.newPath || f.oldPath) || !isProd(f.newPath || f.oldPath) || (f.oldPath && !isProd(f.oldPath))) continue;
    const rem = f.removed.filter(real), add = f.added.filter(real);
    if (rem.length || add.length) src = true;
    if (rem.length && f.oldPath) { const L = linesAt(dir, fx + '^', f.oldPath); for (const x of rem) { const nm = enclosingName(L, x.n); if (nm) names.add(nm); } }
    if (add.length && f.newPath) { const L = linesAt(dir, fx, f.newPath); for (const x of add) { const nm = enclosingName(L, x.n); if (nm) names.add(nm); } }
  }
  const text = testText.join('\n'), hit = [...names].filter((nm) => word(nm).test(text));
  return { ok: src && hit.length > 0, names: [...names], hit };
}

// per-pair data: I's changed non-test files, units, added lines per unit, B, static flags
function pairData(dir, p, fx) {
  const I = p.introducing, blamed = blamedSpots(dir, fx, I.merge_commit);
  const changed = git(dir, 'diff', '--name-only', '--no-renames', I.base, I.head).split('\n').filter((f) => f && isProd(f));
  const unitsByPath = {}, changedUnits = [];
  const testRaw = parseDiff(git(dir, 'diff', '-U0', '--no-color', '--no-renames', I.base, I.head));
  const testText = testRaw.filter((f) => f.newPath && isTest(f.newPath)).flatMap((f) => f.added.map((x) => x.text)).join('\n');
  const headTests = tryGit(dir, 'ls-tree', '-r', '--name-only', I.head).split('\n').filter((f) => f && isTest(f));
  for (const file of changed) {
    const lines = linesAt(dir, I.head, file), units = buildUnits(lines); unitsByPath[file] = units;
    const add = addedLines(dir, I.base, I.head, file);
    for (const u of units) { const a = add.filter((n) => n >= u.start && n <= u.end); if (a.length) changedUnits.push({ path: file, name: u.name, start: u.start, end: u.end, added: a }); }
  }
  for (const b of blamed) if (!unitsByPath[b.path]) unitsByPath[b.path] = buildUnits(linesAt(dir, I.head, b.path));
  const B = makeB(blamed, unitsByPath);
  const resolved = blamed.filter((b) => { const u = unitsByPath[b.path].find((x) => b.line >= x.start && b.line <= x.end); return u && u.name !== null; }).length;
  // static arm: changed named definitions whose name is in neither I's test diff nor any test file at I's head
  const grepTests = (nm) => { if (!headTests.length) return false; for (let i = 0; i < headTests.length; i += 200) if (tryGit(dir, 'grep', '-qw', '-F', '-e', nm, I.head, '--', ...headTests.slice(i, i + 200))) return true; return false; };
  const flags = changedUnits.filter((u) => u.name && !word(u.name).test(testText) && !grepTests(u.name)).map((u) => ({ path: u.path, line: u.added[0], name: u.name }));
  return { blamed, resolved, changedFiles: new Set(changed), changedUnits, B, flags };
}

// ---- per-run null draws ----
// returns Uint8Array(perms) of "this run's reassigned findings caught" for a list of candidate-finding paths
function nullBits(rng, perms, items, d, uniformUnits) {
  const out = new Uint8Array(perms), U = d.changedUnits;
  const w = U.map((u) => (uniformUnits ? 1 : u.added.length)), tot = w.reduce((a, b) => a + b, 0);
  if (!items || !U.length) return out;
  for (let k = 0; k < perms; k++) for (let j = 0; j < items; j++) {
    let r = rng() * tot, i = 0; while (i < U.length - 1 && r >= w[i]) { r -= w[i]; i++; }
    const u = U[i], line = u.added[Math.floor(rng() * u.added.length)];
    if (d.B.has(u.path, line)) out[k] = 1;
  }
  return out;
}

function main() {
  const seed = +arg('seed', 20261020), perms = +arg('perms', 1000), boots = +arg('boots', 2000), sims = +arg('sims', 1000);
  const repos = arg('repos'), runIds = arg('runs').split(',');
  const pairs = JSON.parse(fs.readFileSync(arg('pairs'), 'utf8')).pairs.filter((p) => p.replay_eligible);
  const audit = JSON.parse(fs.readFileSync(arg('audit'), 'utf8'));
  const fixsha = JSON.parse(fs.readFileSync(arg('fixshas'), 'utf8'));
  const dirOf = (p) => path.join(repos, p.repo.split('/')[1]);

  const D = {}, Q = {};
  for (const p of pairs) { const dir = dirOf(p), fx = fixsha[p.id]; Q[p.id] = qualifies(dir, fx); D[p.id] = pairData(dir, p, fx); }
  const qual = pairs.filter((p) => Q[p.id].ok);

  // runs
  const runsOf = {}; const cost = [];
  for (const p of pairs) runsOf[p.id] = runIds.map((run, ri) => {
    let r = null;
    try { r = JSON.parse(fs.readFileSync(path.join(arg('raw'), run, 'replay-' + p.replay_id, 'result.json'), 'utf8')); } catch { /* unusable */ }
    const ok = !!r && r.valid !== false && r.engine_status === 'success' && !r.skip && Array.isArray(r.findings) && !(r.engine_notes || []).some((n) => /context pack: 0 files/.test(n));
    if (r && r.usage && typeof r.usage.cost_usd === 'number') cost.push(r.usage.cost_usd);
    return { id: p.replay_id, rep: ri + 1, ok, findings: ok ? r.findings : [] };
  });

  function scoreRow(set, mode) {
    const rng = mulberry32(seed), brng = mulberry32(seed);
    const R = []; // flat runs
    set.forEach((p, pi) => runsOf[p.id].forEach((r) => {
      const d = D[p.id], cand = r.findings.filter((f) => isCandidate(f, mode));
      const elig = cand.filter((f) => f.line != null && isProd(f.path) && d.changedFiles.has(f.path));
      const catches = cand.filter((f) => isCatch(f, d.B, mode));
      R.push({ pi, id: r.id, rep: r.rep, ok: r.ok, cand: cand.length, elig: elig.length,
        catch: catches.length > 0 ? 1 : 0, weak: catches.some((f) => f.kind === 'weak_test') ? 1 : 0,
        pbits: nullBits(rng, perms, elig.length, d, false), sbits: nullBits(rng, perms, elig.length, d, true) });
    }));
    const nPR = set.length, reps = runIds.length;
    const prVal = (bitsOf) => set.map((_, pi) => mean(R.filter((r) => r.pi === pi).map(bitsOf)));
    const obsPR = prVal((r) => r.catch), obs = mean(obsPR);
    const nullStat = (key) => Array.from({ length: perms }, (_, k) => mean(set.map((_, pi) => mean(R.filter((r) => r.pi === pi).map((r) => r[key][k])))));
    const nulls = {};
    for (const [nm, key] of [['primary', 'pbits'], ['secondary', 'sbits']]) {
      const st = nullStat(key);
      nulls[nm] = { chance: mean(st), ci: ci(st), p: st.filter((x) => x >= obs - 1e-12).length / perms, lift: mean(st) ? obs / mean(st) : null };
    }
    const vn = nulls.primary.ci[1] >= nulls.secondary.ci[1] ? 'primary' : 'secondary';
    const bs = Array.from({ length: boots }, () => mean(Array.from({ length: nPR }, () => obsPR[Math.floor(brng() * nPR)])));
    const k = R.reduce((s, r) => s + r.catch, 0), n = R.length;
    const v = nulls[vn];
    // static arm: flags per PR, same catch rule and nulls
    const stat = set.map((p) => { const d = D[p.id]; return { flags: d.flags.length, catch: d.flags.some((f) => d.B.has(f.path, f.line)) ? 1 : 0 }; });
    const srng = mulberry32(seed), sNull = { primary: [], secondary: [] };
    const sbitsP = set.map((p) => nullBits(srng, perms, stat[set.indexOf(p)].flags, D[p.id], false));
    const sbitsS = set.map((p) => nullBits(srng, perms, stat[set.indexOf(p)].flags, D[p.id], true));
    const sObs = mean(stat.map((s) => s.catch));
    const sn = (bits) => Array.from({ length: perms }, (_, kk) => mean(bits.map((b) => b[kk])));
    const spn = sn(sbitsP), ssn = sn(sbitsS);
    const union = mean(set.map((_, pi) => mean(R.filter((r) => r.pi === pi).map((r) => (r.catch || stat[pi].catch ? 1 : 0)))));
    const diff = set.map((_, pi) => obsPR[pi] - stat[pi].catch), drng = mulberry32(seed);
    const dboot = Array.from({ length: boots }, () => mean(Array.from({ length: nPR }, () => diff[Math.floor(drng() * nPR)])));
    // power: resample PRs to 40, 1 rep or all reps; new verdict (p < .05 and effect >= .10 vs verdict null)
    const power = {};
    for (const nr of [1, reps]) {
      const prng = mulberry32(seed + nr); let pass = 0;
      for (let s = 0; s < sims; s++) {
        const pick = Array.from({ length: 40 }, () => {
          const pi = Math.floor(prng() * nPR), rs = R.filter((r) => r.pi === pi);
          return nr === 1 ? [rs[Math.floor(prng() * rs.length)]] : rs;
        });
        const o = mean(pick.map((rs) => mean(rs.map((r) => r.catch))));
        const st = (key) => Array.from({ length: perms }, (_, kk) => mean(pick.map((rs) => mean(rs.map((r) => r[key][kk])))));
        const a = st('pbits'), b = st('sbits'), A = pct(a, 0.975), Bq = pct(b, 0.975), z = A >= Bq ? a : b;
        const pv = z.filter((x) => x >= o - 1e-12).length / perms;
        if (pv < 0.05 && o - mean(z) >= 0.10) pass++;
      }
      power[nr + '_rep'] = pass / sims;
    }
    const cell = (c) => R.filter(c).map((r) => `${r.id}#${r.rep}`);
    const grade = (r) => { const a = audit.find((x) => x.id === r.id && x.rep === r.rep); return a ? a.new_grade !== 'miss' : null; };
    return {
      pairs: nPR, runs: n, unusable_runs: R.filter((r) => !r.ok).map((r) => `${r.id}#${r.rep}`),
      observed: { k, n, pr_level_mean: obs, per_rep: runIds.map((_, i) => { const rr = R.filter((r) => r.rep === i + 1); return { rep: i + 1, k: rr.reduce((s, r) => s + r.catch, 0), n: rr.length }; }),
        bootstrap_ci95: ci(bs), weak_test_catch_runs: R.reduce((s, r) => s + r.weak, 0) },
      findings: { candidate: R.reduce((s, r) => s + r.cand, 0), eligible_for_null: R.reduce((s, r) => s + r.elig, 0), not_eligible: R.reduce((s, r) => s + r.cand - r.elig, 0) },
      nulls, verdict_null: vn,
      verdict: { a_p_lt_0_05: v.p < 0.05, b_effect_ge_10pts: obs - v.chance >= 0.10, effect_pts: 100 * (obs - v.chance), location_pass: v.p < 0.05 && obs - v.chance >= 0.10 },
      static: { observed: sObs, flags_total: stat.reduce((s, x) => s + x.flags, 0), prs_with_flags: stat.filter((x) => x.flags).length,
        primary_null: { chance: mean(spn), ci: ci(spn), p: spn.filter((x) => x >= sObs - 1e-12).length / perms },
        secondary_null: { chance: mean(ssn), ci: ci(ssn), p: ssn.filter((x) => x >= sObs - 1e-12).length / perms } },
      model_union_static: union,
      model_minus_static: { mean: mean(diff), ci95: ci(dboot) },
      power_new_rule_n40: power,
      cross_tab: { caught_and_catch: cell((r) => r.ok && r.catch && grade(r)), caught_no_catch: cell((r) => r.ok && !r.catch && grade(r)),
        catch_graded_miss: cell((r) => r.ok && r.catch && grade(r) === false), neither: cell((r) => r.ok && !r.catch && grade(r) === false) },
    };
  }

  const out = { seed, perms, boots, sims, runs: runIds,
    filter: { qualifying: qual.length, of: pairs.length, list: qual.map((p) => ({ id: p.id, hit_names: Q[p.id].hit })), power_informative: qual.length >= 15 },
    blamed: { lines: pairs.reduce((s, p) => s + D[p.id].blamed.length, 0), resolved_to_named_definition: pairs.reduce((s, p) => s + D[p.id].resolved, 0), pairs_without_blamed: pairs.filter((p) => !D[p.id].blamed.length).map((p) => p.id) },
    static_note: 'candidate tests cannot be rebuilt offline (saved ctx has no pack); a definition is unflagged if its name appears as a whole word in I\'s added test lines or in any test file at I\'s head',
    cost: { runs: cost.length, mean: mean(cost), median: pct(cost, 0.5), max: Math.max(...cost),
      total_88pr: Object.fromEntries([1, 3].map((r) => [r + '_rep', { at_mean: 88 * r * mean(cost), at_max: 88 * r * Math.max(...cost) }])) },
    rows: {} };
  for (const mode of ['derived', 'literal']) {
    out.rows[mode] = { qualifying: scoreRow(qual, mode), all45: scoreRow(pairs, mode) };
  }
  fs.writeFileSync(arg('out'), JSON.stringify(out, null, 1));
  console.log(JSON.stringify(out, null, 1));
}
if (require.main === module) main();
module.exports = { buildUnits, makeB, isCatch, isCandidate };
