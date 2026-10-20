#!/usr/bin/env node
// Builds the E1 confirmation list (eval/replay/prereg-coverage-gap-e1.md, "Confirmation") from three per-repo `testgap-confirm-build.js --queues-only` outputs. Offline; no model calls.
//   node eval/replay/coverage-e1-confirm-build.js --queues hono.json,langchain.json,sqlglot.json --repos <clones dir> --out eval/replay/coverage-e1-confirm.json [--seed 20261020] [--extended]
// Sets: frozen (each repo's first <= 6 queue rows, taken BEFORE the langchain-core rule, then filtered by it), topup (round-robin, newest first, until 40 bugs),
// unfiltered (<= 20 candidates that fail only the test-gap filter, same round-robin), control (30 via szz.js cleanSample, proportional to bugs per repo).
const fs = require('node:fs');
const path = require('node:path');
const { cleanSample } = require('../szz');
const { isCode } = require('./testgap-score');
const { git, tryGit } = require('./holdout2-null');

const MIN_FILTERED = 30, SINCE = '2026-01-01', NBUG = 40, NUNF = 20, NCTL = 30, PER_REPO = 6, DAY = 864e5;
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i < 0 ? d : process.argv[i + 1]; };
const here = (f) => path.join(__dirname, f);

// ---- pure pieces (tested) ----
// langchain rule: every code file of the change lies under libs/core/ (and there is at least one)
const coreOnly = (files) => { const c = files.filter(isCode); return c.length > 0 && c.every((f) => f.startsWith('libs/core/')); };
const bugRow = (q, set) => ({ id: `${q.clone}-${q.pr}`, repo: q.repo, kind: 'bug', buggy_sha: q.introducing, fixed_sha: q.fix, base: q.base,
  introducing: { base: q.base, head: q.introducing, merge_commit: q.introducing, number: q.pr }, fix_sha: q.fix, set, subgroup: q._sub || 'filtered' });
// round-robin over `names` (alphabetical), each queue newest first, taking rows that pass `ok` and are not in `taken`, until `limit` rows
function roundRobin(names, queues, ok, taken, limit) {
  const pos = Object.fromEntries(names.map((n) => [n, 0])), out = [];
  for (let go = true; go && out.length < limit;) {
    go = false;
    for (const n of names) {
      let r = null;
      while (pos[n] < queues[n].length) { const c = queues[n][pos[n]++]; if (!taken.has(c.introducing) && ok(c, n)) { r = c; break; } }
      if (r) { out.push(r); taken.add(r.introducing); go = true; if (out.length >= limit) break; }
    }
  }
  return out;
}
// frozen + topup + unfiltered row lists. ok(row, cloneName): the langchain-core rule (injected so tests need no git).
function assemble({ queues, unfiltered, ok, extended = false }) {
  const names = Object.keys(queues).sort(), taken = new Set(), funnel = { queue_len: {}, frozen_before_core: {}, frozen_kept: {} };
  const frozen = [];
  for (const n of names) {
    const first = queues[n].slice(0, PER_REPO); // what the full builder would draw, before the core rule
    funnel.queue_len[n] = queues[n].length; funnel.frozen_before_core[n] = first.length;
    const kept = first.filter((r) => ok(r, n)); funnel.frozen_kept[n] = kept.length;
    for (const r of kept) { frozen.push(r); taken.add(r.introducing); }
  }
  const frozenIds = new Set(frozen.map((r) => r.introducing));
  for (const n of names) for (const r of queues[n].slice(0, PER_REPO)) frozenIds.add(r.introducing); // frozen rows that failed the core rule stay out of the top-up
  for (const i of frozenIds) taken.add(i);
  const topup = roundRobin(names, queues, ok, taken, Math.max(0, NBUG - frozen.length));
  const nF = frozen.length + topup.length;
  if (extended && nF < MIN_FILTERED) { // fallback fixed in the prereg: after the single window extension, the primary population is filtered + unfiltered, frozen members first, round-robin newest first up to 40
    const newest = (a, b) => (a.fix_date < b.fix_date ? 1 : a.fix_date > b.fix_date ? -1 : 0);
    const U = Object.fromEntries(names.map((n) => [n, [...queues[n].map((r) => ({ ...r, _sub: 'filtered' })), ...(unfiltered[n] || []).map((r) => ({ ...r, _sub: 'unfiltered' }))].sort(newest)]));
    const top = roundRobin(names, U, ok, new Set(frozenIds), Math.max(0, NBUG - frozen.length));
    return { primary: 'union', frozen, topup: top, unfiltered: [], status: frozen.length + top.length >= MIN_FILTERED ? 'ok' : 'not_tested', funnel };
  }
  const bugs = [...frozen, ...topup], un = roundRobin(names, unfiltered, ok, new Set(bugs.map((r) => r.introducing)), NUNF);
  return { primary: 'filtered', frozen, topup, unfiltered: un, status: bugs.length >= NBUG || extended ? 'ok' : 'needs_window_extension', funnel };
}
// largest-remainder allocation of `total` over names by weight; ties alphabetical
function allocate(total, weights) {
  const names = Object.keys(weights).sort(), sum = names.reduce((s, n) => s + weights[n], 0), q = {}, rem = [];
  for (const n of names) { const x = sum ? total * weights[n] / sum : 0; q[n] = Math.floor(x); rem.push([n, x - Math.floor(x)]); }
  rem.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  for (let i = 0, left = (sum ? total : 0) - Object.values(q).reduce((a, b) => a + b, 0); i < left; i++) q[rem[i][0]]++;
  return q;
}
const validId = (s) => /^[A-Za-z0-9._-]+$/.test(s);

// ---- main (git side) ----
function main() {
  const seed = +arg('seed', 20261020), repos = arg('repos'), files = arg('queues').split(',').map((f) => JSON.parse(fs.readFileSync(f, 'utf8')));
  const R = {}, queues = {}, unfiltered = {};
  for (const j of files) for (const n of Object.keys(j.queues)) { R[n] = j.repos[n]; queues[n] = j.queues[n]; unfiltered[n] = j.unfiltered[n] || []; }
  const names = Object.keys(queues).sort(), dirOf = (n) => path.join(repos, n);
  const changed = (n, a, b) => tryGit(dirOf(n), 'diff', '--name-only', '--no-renames', a, b).split('\n').filter(Boolean);
  const ok = (r, n) => n !== 'langchain' || coreOnly(changed(n, r.base, r.introducing));
  const a = assemble({ queues, unfiltered, ok, extended: process.argv.includes('--extended') }); // --extended: the queues already include the 2025-07-01 window extension
  const rows = [...a.frozen.map((r) => bugRow(r, 'frozen')), ...a.topup.map((r) => bugRow(r, 'topup')), ...a.unfiltered.map((r) => bugRow(r, 'unfiltered'))];

  // earlier corpora (bug pairs and clean PRs), as the builder does
  const seen = { intro: new Set(), sha: new Set(), clean: new Set() };
  for (const f of ['pairs', 'holdout-pairs', 'holdout2-pairs']) for (const p of JSON.parse(fs.readFileSync(here(f + '.json'), 'utf8')).pairs) { seen.intro.add(`${p.repo}#${p.introducing.number}`); seen.sha.add(p.introducing.merge_commit); }
  for (const f of ['clean', 'holdout-clean', 'holdout2-clean']) { const j = JSON.parse(fs.readFileSync(here(f + '.json'), 'utf8')); for (const c of Array.isArray(j) ? j : j.prs || j.clean || j.pairs) { seen.clean.add(`${c.repo}#${c.number}`); seen.sha.add(c.merge_commit); } }

  const perRepo = Object.fromEntries(names.map((n) => [n, rows.filter((r) => (r.set === 'frozen' || r.set === 'topup') && r.repo === R[n].gh).length]));
  const quota = allocate(NCTL, perRepo), ctl = {};
  for (const n of names) {
    const r = R[n], until = new Date(Date.parse(r.head_date) - 90 * DAY).toISOString(), k = { quota: quota[n], pool: 0, no_pr: 0, earlier_set: 0, blamed_by_later_fix: 0, not_core: 0, taken: 0 };
    const pool = cleanSample({ repoDir: dirOf(n), n: quota[n] + 200, seed, window: { since: SINCE, until }, exclude: [...r.mined_shas, ...seen.sha] });
    k.pool = pool.length; ctl[n] = k;
    for (const c of pool) {
      if (k.taken >= quota[n]) break;
      if (!c.pr) { k.no_pr++; continue; }
      if (seen.clean.has(`${r.gh}#${c.pr}`) || seen.intro.has(`${r.gh}#${c.pr}`)) { k.earlier_set++; continue; }
      const d = Date.parse(c.date);
      if (r.blamed_by.some((b) => b.date > d && b.date <= d + 90 * DAY && b.shas.includes(c.sha))) { k.blamed_by_later_fix++; continue; }
      if (n === 'langchain' && !coreOnly(changed(n, c.parent, c.sha))) { k.not_core++; continue; }
      rows.push({ id: `${n}-ctl-${c.pr}`, repo: r.gh, kind: 'control', buggy_sha: c.sha, base: c.parent, pr: c.pr, date: c.date, set: 'control' });
      k.taken++;
    }
  }
  const ids = rows.map((r) => r.id);
  if (new Set(ids).size !== ids.length || !ids.every(validId)) throw new Error('ids are not unique or not file-name safe');
  const count = (set) => rows.filter((r) => r.set === set).length, by = (set) => Object.fromEntries(names.map((n) => [n, rows.filter((r) => r.set === set && r.repo === R[n].gh).length]));
  const out = { status: a.status, primary: a.primary, extended: process.argv.includes('--extended'), seed, queue_files: arg('queues').split(',').map((f) => path.basename(f)), branch_heads: Object.fromEntries(files.map((j) => [j.branch_head, j.prereg_commit])),
    funnel: { ...a.funnel, bugs: count('frozen') + count('topup'), frozen: count('frozen'), topup: count('topup'), unfiltered: count('unfiltered'), controls: count('control'),
      bugs_by_repo: Object.fromEntries(names.map((n) => [n, by('frozen')[n] + by('topup')[n]])), unfiltered_by_repo: by('unfiltered'), controls_by_repo: by('control'), control_quota: quota, control_funnel: ctl },
    rows };
  fs.writeFileSync(arg('out'), JSON.stringify(out, null, 1) + '\n');
  console.log(JSON.stringify({ status: out.status, ...out.funnel }, null, 1));
}
if (require.main === module) main();
module.exports = { coreOnly, bugRow, roundRobin, assemble, allocate, validId };
