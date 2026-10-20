#!/usr/bin/env node
// Chance baseline for the holdout-2 replay, in the form PR #397 gave SpecGuard's own history (eval/escapes.js).
// REUSED, not copied: escapes() from eval/escapes.js does the line-hit rule (same file, within 3 lines, no line = never a hit) and the 1000-permutation
// primary null (lines the introducing commit added) and weak null (anywhere in the file). NEW here: the SZZ blamed lines per pair (via szz.fixLines/blame),
// the per-rep split, and the cross-tab against the audited semantic grade.
// Unit = PR-run (one replay of one introducing PR). A run is a hit if any saved finding (inline or summary) is a line hit.
//
// node eval/replay/holdout2-null.js --pairs holdout2-pairs.json --raw <holdout2-raw dir> --runs RUN1,RUN2,RUN3 (rep 1,2,3) --audit audit.json \
//   --repos <dir of clones named by repo basename> --fixshas <cache json, filled via `gh api` when missing> --out <result json> [--seed 1]
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { escapes } = require('../escapes');
const { fixLines, blame } = require('../szz');

const TOL = 3;
const lineHit = (f, s) => f.path === s.path && f.line != null && Math.abs(f.line - s.line) <= TOL; // same rule as escapes.js
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i < 0 ? d : process.argv[i + 1]; };
const git = (dir, ...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'ignore'] });
const tryGit = (dir, ...a) => { try { return git(dir, ...a); } catch { return ''; } };

// New-side line numbers a commit range added in one file.
function addedLines(dir, base, head, file) {
  const out = [];
  let n = 0;
  for (const l of tryGit(dir, 'diff', '-U0', '--no-color', base, head, '--', file).split('\n')) {
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(l);
    if (h) { n = +h[1]; continue; }
    if (l.startsWith('+') && !l.startsWith('+++')) out.push(n++);
  }
  return out;
}

// blamed lines of fix commit fx that sit in the introducing commit, as { path, line } in that commit's numbering
function blamedSpots(dir, fx, introSha) {
  const spots = {};
  for (const f of fixLines(dir, fx + '^', fx)) blame(dir, fx + '^', f, spots);
  return (spots[introSha] || []).map(({ path: pa, line }) => ({ path: pa, line }));
}

function main() {
  const seed = +arg('seed', 1), repos = arg('repos'), runs = arg('runs').split(',');
  const pairs = JSON.parse(fs.readFileSync(arg('pairs'), 'utf8')).pairs.filter((p) => p.replay_eligible);
  const audit = JSON.parse(fs.readFileSync(arg('audit'), 'utf8'));
  const fixFile = arg('fixshas');
  const fixsha = fs.existsSync(fixFile) ? JSON.parse(fs.readFileSync(fixFile, 'utf8')) : {};
  for (const p of pairs) if (!fixsha[p.id]) fixsha[p.id] = execFileSync('gh', ['api', `repos/${p.repo}/pulls/${p.fix.number}`, '--jq', '.merge_commit_sha'], { encoding: 'utf8' }).trim(); // read-only
  fs.writeFileSync(fixFile, JSON.stringify(fixsha, null, 1));

  // blamed spots in the introducing commit, per pair
  const blamed = {}, addedMemo = new Map(), lenMemo = new Map();
  for (const p of pairs) {
    const dir = path.join(repos, p.repo.split('/')[1]), fx = fixsha[p.id];
    blamed[p.id] = blamedSpots(dir, fx, p.introducing.merge_commit);
  }

  // runs: one escapes() "PR" per (pair, rep); number = running index
  const prs = [], findings = [], status = new Map(), meta = new Map(), cands = [], unusable = [];
  let k = 0;
  runs.forEach((run, ri) => pairs.forEach((p) => {
    const num = ++k, rep = ri + 1;
    let r = null;
    try { r = JSON.parse(fs.readFileSync(path.join(arg('raw'), run, 'replay-' + p.replay_id, 'result.json'), 'utf8')); } catch { /* missing */ }
    const ok = !!r && r.engine_status === 'success' && !r.skip;
    meta.set(num, { id: p.replay_id, rep, pair: p, findings: ok ? r.findings : [], ok });
    prs.push({ number: num });
    status.set(num, ok ? 'complete' : 'failed');
    if (!ok) unusable.push(`${p.replay_id}#${rep}`);
    for (const f of ok ? r.findings : []) findings.push({ pr: num, path: f.path, line: f.line });
    cands.push({ fix: { sha: p.id + '#' + rep, pr: -1 }, introducing: [{ pr: num, sha: p.introducing.merge_commit, spots: blamed[p.id] }] });
  }));
  const repoDir = (p) => path.join(repos, p.repo.split('/')[1]);
  const addedOf = ({ pr, path: file }) => {
    const m = meta.get(pr), key = m.id + '\0' + file;
    if (!addedMemo.has(key)) addedMemo.set(key, addedLines(repoDir(m.pair), m.pair.introducing.base, m.pair.introducing.head, file));
    return addedMemo.get(key);
  };
  const lengthOf = ({ pr, path: file }) => {
    const m = meta.get(pr), key = m.id + '\0' + file;
    if (!lenMemo.has(key)) lenMemo.set(key, tryGit(repoDir(m.pair), 'show', `${m.pair.introducing.head}:${file}`).split('\n').length - 1);
    return lenMemo.get(key);
  };
  const res = escapes({ prs, fixes: { candidates: cands }, findings, status, addedOf, lengthOf, seed });
  const g = res.groups.unlabeled;

  // per run: own classification (must equal escapes.js)
  const rows = [...meta].map(([, m]) => {
    const sp = blamed[m.pair.id];
    const cls = !m.ok ? 'unusable' : !sp.length ? 'no_location' : sp.some((s) => m.findings.some((f) => lineHit(f, s))) ? 'hit' : sp.some((s) => m.findings.some((f) => f.path === s.path)) ? 'same_file' : 'miss';
    const a = audit.find((x) => x.id === m.id && x.rep === m.rep);
    return { id: m.id, rep: m.rep, cls, grade: a ? a.new_grade : null, caught: a ? a.new_grade !== 'miss' : null, delivered: a ? a.delivered : null };
  });
  const cnt = (f) => rows.filter(f).length;
  if (cnt((r) => r.cls === 'hit') !== g.hit) throw new Error(`hit mismatch with escapes.js: ${cnt((r) => r.cls === 'hit')} vs ${g.hit}`);
  const scored = (r) => ['hit', 'same_file', 'miss'].includes(r.cls);
  const perRep = [1, 2, 3].map((rep) => ({ rep, k: cnt((r) => r.rep === rep && r.cls === 'hit'), n: cnt((r) => r.rep === rep && scored(r)) }));
  const ids = (f) => rows.filter(f).map((r) => `${r.id}#${r.rep}`);
  const cross = {
    caught_and_hit: ids((r) => scored(r) && r.caught && r.cls === 'hit'),
    caught_not_hit: ids((r) => scored(r) && r.caught && r.cls !== 'hit'),
    hit_graded_miss: ids((r) => r.cls === 'hit' && r.caught === false),
  };
  const out = {
    seed, tol: TOL, perms: g.chance.perms, runs, pairs: pairs.length, pair_runs: rows.length,
    unusable, no_location_pairs: pairs.filter((p) => !blamed[p.id].length).map((p) => p.replay_id),
    scored: cnt(scored), hit: g.hit, same_file: g.same_file, rate: g.hit / cnt(scored), per_rep: perRep,
    mean_rep_rate: perRep.reduce((s, r) => s + r.k / r.n, 0) / 3,
    primary: { rate: g.chance.rate, ci: g.chance.ci, diff: g.chance.diff, permuted: g.chance.permuted, dropped: g.chance.dropped },
    weak: g.chance.weak, weak_findings: g.chance.weak_findings,
    excess: g.chance.excess, above_chance: g.chance.above_chance, weak_above_chance: g.chance.weak_above_chance,
    cross: { ...cross, counts: { caught_and_hit: cross.caught_and_hit.length, caught_not_hit: cross.caught_not_hit.length, hit_graded_miss: cross.hit_graded_miss.length, neither: cnt((r) => scored(r) && r.caught === false && r.cls !== 'hit') } },
    classes: Object.fromEntries(['hit', 'same_file', 'miss', 'no_location', 'unusable'].map((c) => [c, cnt((r) => r.cls === c)])),
    rows,
  };
  fs.writeFileSync(arg('out'), JSON.stringify(out, null, 1));
  console.log(JSON.stringify(out, null, 1));
}
if (require.main === module) main();
module.exports = { git, tryGit, addedLines, blamedSpots };
