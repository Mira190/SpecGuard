#!/usr/bin/env node
// Fail-to-pass execution oracle for SpecGuard missing_test / weak_test findings (eval/f2p/README.md). Node built-ins only.
//   node eval/f2p/f2p.js candidates | power | export | packets | run | report
// Evidence root: $F2P_EVIDENCE (default: ../SpecGuard-evidence next to the repo). Generated tests, trees and packets live under <evidence>/f2p/, never in the repo.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { rng, shuffle, mdd, mddUnclustered } = require('./stats');

const ROOT = path.resolve(__dirname, '..', '..');
const EV = path.resolve(process.env.F2P_EVIDENCE || path.join(ROOT, '..', 'SpecGuard-evidence'));
const F2P = path.join(EV, 'f2p');
const N_DEFAULT = 20; // lines from a fix hunk: NEAR <= N < FAR (pre-registered, README)
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const git = (clone, ...a) => execFileSync('git', ['-C', clone, ...a], { encoding: 'utf8', maxBuffer: 1 << 28 }).trim();
const cloneOf = (slug) => path.join(EV, 'repos', slug.split('/')[1] === 'cli' ? 'cli' : slug.split('/')[1]);
const findingId = (run, pr, f) => sha([run, pr, f.path, f.line, f.title].join('|'));

// Fix commit of PR number n on the clone's HEAD: squash subject "... (#n)" or "Merge pull request #n". Buggy = its first parent.
function resolveFix(clone, n, slug) {
  const out = git(clone, 'log', 'HEAD', '-E', `--grep=(\\(#${n}\\)|Merge pull request #${n} )`, '--format=%H%x09%P%x09%s');
  const hits = out.split('\n').filter(Boolean).map((l) => l.split('\t')).filter(([, , s]) => new RegExp(`\\(#${n}\\)\\s*$|^Merge pull request #${n}\\b`).test(s));
  if (!hits.length) return viaGh(clone, n, slug);
  const [fix, parents] = hits[hits.length - 1];
  const parent = parents.split(' ')[0];
  if (!parent) return { error: 'fix commit has no parent' };
  return { fix, parent, sha_method: `${hits.length > 1 ? 'oldest of ' + hits.length + ' subject matches; ' : ''}${parents.split(' ').length > 1 ? 'merge commit and its first parent' : 'squash commit and its first parent'}` };
}

// Fallback for rebase merges: GitHub's merge_commit_sha, accepted only when it is in the clone and its first-parent diff has the PR's changed_files count.
function viaGh(clone, n, slug) {
  try {
    const j = JSON.parse(execFileSync('gh', ['api', 'repos/' + slug + '/pulls/' + n], { encoding: 'utf8' })), fix = j.merge_commit_sha;
    const parent = git(clone, 'rev-parse', fix + '^1'), files = git(clone, 'diff', '--name-only', parent, fix).split('\n').filter(Boolean).length;
    if (files !== j.changed_files) return { error: 'GitHub merge_commit_sha diff has ' + files + ' files, the PR has ' + j.changed_files };
    return { fix, parent, sha_method: 'GitHub merge_commit_sha (rebase merge) and its first parent; changed-file count equals the PR' };
  } catch (e) { return { error: 'fix commit not found by subject (#N), Merge pull request #N or GitHub merge_commit_sha' }; }
}

// Old-side hunk ranges per touched file: { file: [[start, end]] } from `git diff --no-renames -U0 parent fix`. An insertion (count 0) counts as the single line it follows.
function hunks(clone, parent, fix) {
  const out = git(clone, 'diff', '--no-renames', '-U0', '--no-color', parent, fix), res = {};
  let cur = null;
  for (const l of out.split('\n')) {
    let m;
    if ((m = /^diff --git a\/(.+) b\/(.+)$/.exec(l))) { cur = res[m[2]] = []; continue; }
    if (cur && (m = /^@@ -(\d+)(?:,(\d+))? \+/.exec(l))) { const s = Number(m[1]), c = m[2] === undefined ? 1 : Number(m[2]); if (c > 0) cur.push([s, s + c - 1]); else if (s > 0) cur.push([s, s]); }
  }
  return res;
}
// Dependency manifests: a fix that changes one cannot be run with the installed dependencies (no reinstall is implemented), so its fixed runs are `deps_changed` and excluded.
const MANIFEST = /(^|\/)(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|pyproject\.toml|uv\.lock|requirements[^/]*\.txt|go\.mod|go\.sum)$/;
const distance = (hs, line) => (hs.length ? Math.min(...hs.map(([s, e]) => Math.max(0, s - line, line - e))) : Infinity);

// Source files a test file may belong to: same directory, same stem without the test marker (x.test.ts, x.spec.ts, x_test.go, test_x.py, x_test.py).
function siblings(testPath) {
  const p = path.posix.parse(testPath);
  const stem = p.name.replace(/\.(test|spec)$/, '').replace(/^test_/, '').replace(/_test$/, '');
  return stem === p.name ? [] : [stem];
}
const stemOf = (f) => path.posix.parse(f).name;
function unitTouched(f, touched) {
  const st = siblings(f.path), d = path.posix.dirname(f.path);
  return f.kind === 'weak_test' && st.length > 0 && Object.keys(touched).some((t) => path.posix.dirname(t) === d && t !== f.path && stemOf(t) === st[0]);
}

// Arm of one finding: NEAR, FAR, UNTOUCHED, UNIT_TOUCHED_WEAK or EXCLUDED_NO_LINE; dist = lines to the nearest old-side hunk (null when untouched).
function classify(f, touched, N = N_DEFAULT) {
  const hs = touched[f.path];
  if (hs) {
    if (!Number.isInteger(f.line) || f.line < 1) return { arm: 'EXCLUDED_NO_LINE', dist: null };
    const dist = distance(hs, f.line);
    return { arm: dist <= N ? 'NEAR' : 'FAR', dist: Number.isFinite(dist) ? dist : 1e9 };
  }
  return { arm: unitTouched(f, touched) ? 'UNIT_TOUCHED_WEAK' : 'UNTOUCHED', dist: null };
}

// Deterministic summary findings (assertion removed ...) exist only in counts.json `sum` and summary.md; body = the summary bullet text.
function summaryBody(summaryMd, f) {
  const lines = summaryMd.split('\n'), i = lines.findIndex((l) => l.includes('`' + f.path + ':' + f.line + '`'));
  if (i < 0) return null;
  const m = /—\s*(.*)$/.exec(lines[i]);
  return [m ? m[1] : lines[i], /^\s{2,}\S/.test(lines[i + 1] || '') ? lines[i + 1].trim() : ''].filter(Boolean).join(' ');
}
const whereOf = (summaryMd, f) => {
  const i = summaryMd.indexOf('`' + f.path + ':' + f.line + '`');
  return i < 0 ? 'not_in_summary' : i < summaryMd.indexOf('<details>') || summaryMd.indexOf('<details>') < 0 ? 'summary_visible' : 'details';
};

// Replay-arm candidate pool: the three bug runs (ascending run id = rep 1..3), deduplicated within a PR by path + line + title.
function replayCandidates({ N = N_DEFAULT } = {}) {
  const pairs = readJson(path.join(ROOT, 'eval/replay/holdout2-pairs.json')).pairs.filter((p) => p.replay_eligible);
  const raw = path.join(EV, 'holdout2-raw');
  const runs = fs.readdirSync(raw).filter((r) => fs.existsSync(path.join(raw, r, 'replay-' + pairs[0].replay_id))).sort();
  const prs = [], cands = [];
  for (const p of pairs) {
    const clone = cloneOf(p.repo), r = resolveFix(clone, p.fix.number, p.repo), row = { replay_id: p.replay_id, repo: p.repo, fix: p.fix.number, runs };
    if (r.error) { row.error = r.error; prs.push(row); continue; }
    Object.assign(row, { buggy_sha: r.parent, fixed_sha: r.fix, sha_method: r.sha_method });
    const touched = hunks(clone, r.parent, r.fix), seen = new Map();
    row.deps_changed = git(clone, 'diff', '--name-only', '--no-renames', r.parent, r.fix).split('\n').some((p) => MANIFEST.test(p));
    runs.forEach((run, rep) => {
      const dir = path.join(raw, run, 'replay-' + p.replay_id);
      let fj, cj, md = '';
      try { fj = readJson(path.join(dir, 'ctx/findings.json')); } catch { return; }
      try { cj = readJson(path.join(dir, 'ctx/counts.json')); } catch { cj = {}; }
      try { md = fs.readFileSync(path.join(dir, 'summary.md'), 'utf8'); } catch { /* none */ }
      const own = (fj.findings || []).filter((f) => f.kind === 'missing_test' || f.kind === 'weak_test').map((f) => ({ ...f, source_file: 'findings.json' }));
      const have = new Set(own.map((f) => `${f.path}|${f.line}|${f.title}`));
      const det = (cj.sum || []).filter((f) => (f.kind === 'missing_test' || f.kind === 'weak_test') && !have.has(`${f.path}|${f.line}|${f.title}`)).map((f) => ({ kind: f.kind, path: f.path, line: f.line, title: f.title, body: summaryBody(md, f) || f.title, confidence: null, source_file: 'counts.json sum (deterministic)' }));
      for (const f of [...own, ...det]) {
        const key = `${f.path}|${f.line}|${f.title}`;
        if (seen.has(key)) { seen.get(key).reps.push(rep + 1); continue; }
        const c = { id: findingId(run, p.replay_id, f), pr: p.replay_id, repo: p.repo, run, reps: [rep + 1], kind: f.kind, path: f.path, line: f.line ?? null, title: f.title, confidence: f.confidence, where: whereOf(md, f), source: f.source_file, buggy_sha: r.parent, fixed_sha: r.fix, fix_touched_file: Boolean(touched[f.path]), ...classify(f, touched, N) };
        c.fields = { title: f.title, body: f.body, counterexample: f.counterexample, quote: f.quote, path: f.path, line: f.line ?? null, kind: f.kind };
        seen.set(key, c); cands.push(c);
      }
    });
    prs.push(row);
  }
  return { prs, cands };
}

const ARMS = ['NEAR', 'FAR', 'UNTOUCHED', 'UNIT_TOUCHED_WEAK', 'EXCLUDED_NO_LINE'];
function summarize(cands, prs) {
  const cnt = (f) => cands.filter(f).length, by = {};
  for (const a of ARMS) by[a] = { n: cnt((c) => c.arm === a), prs: new Set(cands.filter((c) => c.arm === a).map((c) => c.pr)).size };
  const reArm = (N) => { const o = { NEAR: 0, FAR: 0 }; for (const c of cands) if (c.dist !== null && c.arm !== 'EXCLUDED_NO_LINE') o[c.dist <= N ? 'NEAR' : 'FAR']++; return o; };
  const perRepo = {}, perPr = {};
  for (const c of cands) { const r = (perRepo[c.repo] = perRepo[c.repo] || {}); r[c.arm] = (r[c.arm] || 0) + 1; const q = (perPr[c.pr] = perPr[c.pr] || {}); q[c.arm] = (q[c.arm] || 0) + 1; }
  return { N: N_DEFAULT, arms: by, sensitivity: { 10: reArm(10), 20: reArm(20), 40: reArm(40) }, unresolved_prs: prs.filter((p) => p.error).map((p) => p.replay_id), per_repo: perRepo, per_pr: perPr };
}

function cmdCandidates() {
  const { prs, cands } = replayCandidates();
  for (const c of cands) c.in_oracle_set = c.arm === 'NEAR' || c.arm === 'FAR' || c.arm === 'UNIT_TOUCHED_WEAK'; // UNTOUCHED was not run: structural zero by construction
  const out = { generated_by: 'node eval/f2p/f2p.js candidates', reps_by_run: prs[0].runs, summary: summarize(cands, prs), prs, candidates: cands.map(({ fields, ...c }) => c) };
  fs.writeFileSync(path.join(__dirname, 'holdout2-candidates.json'), JSON.stringify(out, null, 1) + '\n');
  fs.mkdirSync(F2P, { recursive: true });
  fs.writeFileSync(path.join(F2P, 'holdout2-fields.json'), JSON.stringify(Object.fromEntries(cands.map((c) => [c.id, c.fields])), null, 1)); // verbatim finding text stays outside the repo
  console.log(JSON.stringify({ ...out.summary, per_pr: undefined, per_repo: out.summary.per_repo }, null, 1));
  honoCandidates();
}

// Mutation arm: findings of the scan run on the 14 manifest units; unit = manifest file (a weak_test path is a test file beside it).
function honoCandidates() {
  const man = readJson(path.join(ROOT, 'eval/mutation/hono-5ca49b0.json')), dir = path.join(F2P, 'mutation-scan');
  const fj = readJson(path.join(dir, 'findings.json')), files = [...new Set(man.mutants.map((m) => m.file))];
  const unitOf = (f) => files.includes(f.path) ? f.path : files.find((x) => x.replace(/\.[A-Za-z]+$/, '') === f.path.replace(/\.(test|spec)(\.[A-Za-z]+)$/, '$2').replace(/\.[A-Za-z]+$/, '')) || null;
  const cands = (fj.unit_findings || []).filter((f) => f.kind === 'missing_test' || f.kind === 'weak_test').map((f) => {
    const unit = unitOf(f), ms = man.mutants.filter((m) => m.file === unit);
    return { id: findingId('39187431386', 'hono-5ca49b0', f), pr: 'hono-5ca49b0', repo: 'honojs/hono', run: '39187431386', kind: f.kind, path: f.path, line: f.line, title: f.title, confidence: null, unit, buggy_sha: man.sha, survivors: ms.filter((m) => m.status === 'survived' && !m.uncertain).map((m) => m.id), uncertain_survivors: ms.filter((m) => m.status === 'survived' && m.uncertain).map((m) => m.id), fields: { title: f.title, body: f.body, skeleton: f.skeleton, quote: f.quote, path: f.path, line: f.line, kind: f.kind } };
  });
  fs.writeFileSync(path.join(__dirname, 'hono-candidates.json'), JSON.stringify({ generated_by: 'node eval/f2p/f2p.js candidates', sha: man.sha, candidates: cands.map(({ fields, ...c }) => c) }, null, 1) + '\n');
  fs.writeFileSync(path.join(F2P, 'hono-fields.json'), JSON.stringify(Object.fromEntries(cands.map((c) => [c.id, c.fields])), null, 1));
  console.log(`hono: ${cands.length} candidates, ${cands.filter((c) => !c.unit).length} without a manifest unit`);
}

// Per-PR finding counts of one arm: { pr: n }.
const perPr = (cands, arm) => { const o = {}; for (const c of cands) if (c.arm === arm) o[c.pr] = (o[c.pr] || 0) + 1; return o; };

// Minimum detectable NEAR-FAR difference at 80% power. Clustered (governs the decision): per-PR Beta rates with ICC 0.1 and 0.3, test = PR-cluster bootstrap 95% interval excludes 0,
// seed 1, `sims` simulations x `reps` resamples. Unclustered (Fisher, findings independent) overstates power and is not used for the decision.
// Decision rule (README amendment): clustered MDD at p0 = 0.05, ICC = 0.3 > 0.30 means DESCRIPTIVE ONLY.
function powerTable(near, far, { sims = 1000, reps = 1000 } = {}) {
  const n1 = Object.values(near).reduce((a, b) => a + b, 0), n2 = Object.values(far).reduce((a, b) => a + b, 0), out = { n_near: n1, n_far: n2, prs_near: Object.keys(near).length, prs_far: Object.keys(far).length, sims, reps, clustered: {}, unclustered_not_used: {} };
  for (const icc of [0.1, 0.3]) for (const p0 of [0.02, 0.05, 0.1]) (out.clustered[`icc${icc}`] = out.clustered[`icc${icc}`] || {})[p0] = mdd(near, far, p0, { icc, sims, reps });
  for (const p0 of [0.02, 0.05, 0.1]) out.unclustered_not_used[p0] = mddUnclustered(n1, n2, p0);
  const m = out.clustered['icc0.3'][0.05];
  out.decision = m === null || m > 0.3 ? 'DESCRIPTIVE ONLY' : 'inferential';
  return out;
}

function cmdPower() {
  const cands = readJson(path.join(__dirname, 'holdout2-candidates.json')).candidates;
  console.log(JSON.stringify(powerTable(perPr(cands, 'NEAR'), perPr(cands, 'FAR'), { sims: Number(process.argv[3] || 1000), reps: Number(process.argv[4] || 1000) })));
}

module.exports = { MANIFEST, resolveFix, hunks, distance, classify, siblings, unitTouched, findingId, summaryBody, ARMS, EV, F2P, ROOT, cloneOf, readJson, sha, powerTable, perPr };

if (require.main === module) {
  const raw = process.argv.slice(2), opts = {}, rest = []; // --set <name> (operate on a list set) and --name <set> (import) are flags; everything else is positional
  for (let i = 0; i < raw.length; i++) { if (raw[i] === '--set' || raw[i] === '--name') opts[raw[i].slice(2)] = raw[++i]; else rest.push(raw[i]); }
  const [cmd, ...args] = rest, H = () => { const h = require('./harness'); if (opts.set) h.useSet(opts.set); return h; };
  const cmds = { candidates: cmdCandidates, power: cmdPower, export: () => H().cmdExport(), packets: () => H().cmdPackets(), setup: () => H().cmdSetup(args[0], args[1]), baseline: () => H().cmdBaseline(args.length ? args : null), try: () => H().cmdTry(args[0]),
    run: () => (args[0] === '--mutation' ? H().cmdRunMutation(args.length > 1 ? args.slice(1) : null) : H().cmdRun(args.length ? args : null)), report: () => H().cmdReport(), controls: () => H().cmdControls(args.length ? args : null), 'writers-done': () => H().cmdWritersDone(args[0]), verify: () => H().cmdVerify(args[0]), import: () => H().cmdImport(args[0], opts.name) };
  if (!cmds[cmd]) { console.error('usage: f2p.js candidates | power | import <list.json> --name <set> | export | packets | setup <repo> <sha> | baseline | try <id> | run [--mutation] [id|pr...] | report | controls [repo|pr...] | writers-done <repo>   (export, packets, baseline, try, run, report accept --set <set>)'); process.exitCode = 2; } else cmds[cmd]();
}
