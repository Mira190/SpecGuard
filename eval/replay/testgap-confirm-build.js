#!/usr/bin/env node
// Builds the test-gap confirmation corpus as eval/replay/prereg-testgap-mvp.md specifies. Offline except for the earlier `szz.js mine` step (read-only gh).
//   node eval/replay/testgap-confirm-build.js --repos <clones dir> --mined <dir with mine-<clone>.json + repos.txt "<clone> <owner/name>"> --out testgap-confirm.json [--seed 20261020]
const fs = require('node:fs');
const path = require('node:path');
const { fixLines, blame, cleanSample } = require('../szz');
const { qualifies, pairData } = require('./testgap-score');
const { git, tryGit } = require('./holdout2-null');

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i < 0 ? d : process.argv[i + 1]; };
const here = (f) => path.join(__dirname, f);
const SINCE = '2026-01-01', NBUG = 48, NCTL = 40, PER_REPO = 6, DAY = 864e5;

// earlier corpora (bug pairs and clean PRs), by owner/name
const seen = { fix: new Set(), intro: new Set(), sha: new Set(), clean: new Set() };
for (const f of ['pairs', 'holdout-pairs', 'holdout2-pairs']) for (const p of JSON.parse(fs.readFileSync(here(f + '.json'), 'utf8')).pairs) {
  seen.fix.add(`${p.repo}#${p.fix.number}`); seen.intro.add(`${p.repo}#${p.introducing.number}`); seen.sha.add(p.introducing.merge_commit);
}
for (const f of ['clean', 'holdout-clean', 'holdout2-clean']) {
  const j = JSON.parse(fs.readFileSync(here(f + '.json'), 'utf8'));
  for (const c of Array.isArray(j) ? j : j.prs || j.clean || j.pairs) { seen.clean.add(`${c.repo}#${c.number}`); seen.sha.add(c.merge_commit); }
}

const numstat = (dir, sha) => {
  const rows = tryGit(dir, 'show', '--numstat', '--format=', sha).split('\n').filter(Boolean).map((l) => l.split('\t'));
  return { files: rows.length, lines: rows.reduce((t, r) => t + (+r[0] || 0) + (+r[1] || 0), 0) };
};

function main() {
  const seed = +arg('seed', 20261020), repos = arg('repos'), mined = arg('mined');
  const names = fs.readFileSync(path.join(mined, 'repos.txt'), 'utf8').trim().split('\n').map((l) => l.split(' ')).sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const R = {}, queues = {};
  for (const [name, gh] of names) {
    const dir = path.join(repos, name), m = JSON.parse(fs.readFileSync(path.join(mined, `mine-${name}.json`), 'utf8'));
    const head = git(dir, 'rev-parse', 'HEAD').trim(), headDate = git(dir, 'log', '-1', '--format=%cI').trim();
    const c = { commits: m.stats.commits, mined_fixes: m.candidates.length, single_parent: 0, size_and_source_ok: 0, test_gap_name_match: 0, add_only_excluded: 0, blame_lt3: 0,
      top_blamed_not_mapped_by_mine: 0, i_not_squash_pr: 0, i_size_out: 0, in_earlier_set: 0, duplicate_i: 0, qualifying: 0 };
    const cands = [...m.candidates].sort((a, b) => (a.fix.date < b.fix.date ? 1 : -1));
    const blamedBy = []; // every mined fix: { date, shas } for the control drop rule
    const usedI = new Set(), qual = [];
    for (const cand of cands) {
      const fx = cand.fix.sha;
      const tally = {}, spots = {}; let anyLines = false;
      for (const f of fixLines(dir, cand.fix.parent, fx)) { if (f.lines.length) anyLines = true; for (const [s, n] of Object.entries(blame(dir, cand.fix.parent, f, spots))) tally[s] = (tally[s] || 0) + n; }
      blamedBy.push({ date: Date.parse(cand.fix.date), shas: new Set(Object.keys(tally)) });
      if (git(dir, 'rev-list', '--parents', '-n1', fx).trim().split(' ').length !== 2) continue;
      c.single_parent++;
      if (numstat(dir, fx).lines > 400) continue;
      const q = qualifies(dir, fx);
      if (!q.src) continue;
      c.size_and_source_ok++;
      if (!q.ok) continue;
      c.test_gap_name_match++;
      if (!anyLines) { c.add_only_excluded++; continue; }
      const top = Object.entries(tally).filter(([s]) => s !== fx).sort((a, b) => b[1] - a[1])[0];
      if (!top || top[1] < 3) { c.blame_lt3++; continue; }
      const ent = cand.introducing.find((i) => i.sha === top[0]);
      if (!ent) { c.top_blamed_not_mapped_by_mine++; continue; }
      const par = git(dir, 'rev-list', '--parents', '-n1', top[0]).trim().split(' ');
      if (par.length !== 2 || !ent.pr) { c.i_not_squash_pr++; continue; }
      const is = numstat(dir, top[0]);
      if (is.lines < 30 || is.lines > 1200 || is.files > 40) { c.i_size_out++; continue; }
      if (seen.intro.has(`${gh}#${ent.pr}`) || seen.sha.has(top[0]) || (cand.fix.pr && seen.fix.has(`${gh}#${cand.fix.pr}`))) { c.in_earlier_set++; continue; }
      if (usedI.has(top[0])) { c.duplicate_i++; continue; } // newest fix per I (cands are newest first)
      usedI.add(top[0]);
      const pd = pairData(dir, { introducing: { merge_commit: top[0], base: par[1], head: top[0] } }, fx, false);
      c.qualifying++;
      qual.push({ repo: gh, clone: name, fix: fx, fix_pr: cand.fix.pr, fix_date: cand.fix.date, introducing: top[0], pr: ent.pr, base: par[1], i_files: is.files, i_lines: is.lines,
        blamed_lines: pd.blamed, B: { blamed: pd.blamed.length, resolved_to_named_definition: pd.resolved, files: [...new Set(pd.blamed.map((b) => b.path))] } });
    }
    R[name] = { gh, dir, head, headDate, counts: c, blamedBy };
    queues[name] = qual;
    console.error(name, JSON.stringify(c));
  }
  const totalQual = Object.values(queues).reduce((s, q) => s + q.length, 0);
  const out = { frozen_at: new Date().toISOString(), seed, prereg_commit: git(__dirname, 'log', '-1', '--format=%H', '--', 'prereg-testgap-mvp.md').trim(), branch_head: git(__dirname, 'rev-parse', 'HEAD').trim(),
    repos: Object.fromEntries(names.map(([n]) => [n, { gh: R[n].gh, head: R[n].head, head_date: R[n].headDate, counts: R[n].counts }])), qualifying_total: totalQual };
  if (totalQual < 40) { out.status = 'not_tested'; fs.writeFileSync(arg('out'), JSON.stringify(out, null, 1)); console.log('NOT TESTED', totalQual); return; }

  // draw: round-robin over clone names alphabetically, newest first, <= 6 per repo
  const bugs = [], taken = Object.fromEntries(names.map(([n]) => [n, 0]));
  for (let go = true; go && bugs.length < NBUG;) {
    go = false;
    for (const [n] of names) {
      if (bugs.length >= NBUG) break;
      if (taken[n] >= PER_REPO || taken[n] >= queues[n].length) continue;
      bugs.push(queues[n][taken[n]++]); go = true;
    }
  }
  // controls: largest-remainder quotas, ties alphabetical
  const quota = {}, rem = [];
  for (const [n] of names) { const x = NCTL * taken[n] / bugs.length; quota[n] = Math.floor(x); rem.push([n, x - Math.floor(x)]); }
  rem.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  for (let i = 0, left = NCTL - Object.values(quota).reduce((a, b) => a + b, 0); i < left; i++) quota[rem[i][0]]++;
  const controls = [], ctlCounts = {};
  for (const [n] of names) {
    const r = R[n], until = new Date(Date.parse(r.headDate) - 90 * DAY).toISOString();
    const minedShas = JSON.parse(fs.readFileSync(path.join(mined, `mine-${n}.json`), 'utf8')).candidates.flatMap((c) => [c.fix.sha, ...c.introducing.map((i) => i.sha)]);
    const pool = cleanSample({ repoDir: r.dir, n: quota[n] + 60, seed, window: { since: SINCE, until }, exclude: [...minedShas, ...seen.sha] });
    const k = { quota: quota[n], pool: pool.length, no_pr: 0, earlier_set: 0, blamed_by_later_fix: 0, taken: 0 };
    for (const c of pool) {
      if (k.taken >= quota[n]) break;
      if (!c.pr) { k.no_pr++; continue; }
      if (seen.clean.has(`${r.gh}#${c.pr}`) || seen.intro.has(`${r.gh}#${c.pr}`)) { k.earlier_set++; continue; }
      const d = Date.parse(c.date);
      if (r.blamedBy.some((b) => b.date > d && b.date <= d + 90 * DAY && b.shas.has(c.sha))) { k.blamed_by_later_fix++; continue; }
      controls.push({ repo: r.gh, clone: n, sha: c.sha, pr: c.pr, date: c.date, files: c.files, lines: c.lines });
      k.taken++;
    }
    ctlCounts[n] = k;
  }
  for (const [n] of names) { out.repos[n].counts.drawn_bugs = taken[n]; out.repos[n].controls = ctlCounts[n]; }
  Object.assign(out, { status: 'frozen', n_bugs: bugs.length, n_controls: controls.length, bugs, controls });
  fs.writeFileSync(arg('out'), JSON.stringify(out, null, 1) + '\n');
  console.log(JSON.stringify({ n_bugs: bugs.length, n_controls: controls.length, repos: Object.fromEntries(names.map(([n]) => [n, { ...out.repos[n].counts, controls: out.repos[n].controls }])) }, null, 1));
}
main();
