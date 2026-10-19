// Escaped defects per trial arm (docs/validation-plan.md step 7), read 8-12 weeks after the trial starts.
// Input: `szz.js mine` output (fix -> introducing commit -> PR, with the blamed spots) and the trial PRs. Output per arm: introducing PRs, escaped
// defects per 100 PRs (PR-cluster bootstrap), and for each escaped defect whether a SpecGuard finding sat on the blamed lines.
// Arms 0/2 and unlabelled PRs: the findings SpecGuard delivered. Arm 1: the shadow run's findings, read from the `specguard-ctx-<PR>-<attempt>` artifact into a local JSONL cache.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { wilson } = require('./aggregate-counts');
const { mulberry32 } = require('./szz');

// The one place that names the shadow run's contract (workflow, artifact, file inside it). counts.json is what post.js writes at the end of a finished
// run: its `sum` lists the findings that went to the summary (all of them under `delivery: summary`); a run that failed early writes none.
// One artifact per run: specguard-ctx-<PR number>-<run attempt> (action.yml of the shadow job, 90 days). counts.json is the validated set, not the raw findings.json.
const SHADOW = { workflow: 'SpecGuard validation', artifact: (pr) => new RegExp(`^specguard-ctx-${pr}-(\\d+)$`), file: 'counts.json' };
// Floors: 30 PRs per arm is the plan's rate floor (step 2, same as time-to-merge); 10 located defects is the least that gives a catch rate a non-silly interval.
const FLOOR = { prs: 30, located: 10 };
const TOL = 3; // lines, the overlap rule of weekly-report.js
const USABLE = ['complete', 'incomplete']; // sticky summary status: a review ran. `failed` (auth_failed, quota...) and no summary are unusable, never a miss.

// A line hit needs a finding with a line; a file-level or summary finding with no line is only "same file".
const lineHit = (f, s) => f.path === s.path && f.line != null && Math.abs(f.line - s.line) <= TOL;

// Resampling whole PRs: ratio of sums num/den over `items`; null below 2 PRs.
function boot(items, num, den, seed = 1, rounds = 2000) {
  if (items.length < 2) return null;
  const rnd = mulberry32(seed), xs = [];
  for (let r = 0; r < rounds; r++) { let a = 0, b = 0; for (let i = 0; i < items.length; i++) { const x = items[Math.floor(rnd() * items.length)]; a += num(x); b += den(x); } if (b) xs.push(a / b); }
  xs.sort((a, b) => a - b);
  return xs.length ? [xs[Math.floor(0.025 * xs.length)], xs[Math.min(xs.length - 1, Math.floor(0.975 * xs.length))]] : null;
}

// prs [{ number, arm }]; fixes: szz mine JSON; findings: SpecGuard findings [{ pr, path, line }]; status: Map pr -> sticky status; shadow: Map pr -> [{ status, findings }].
function escapes({ prs, fixes, findings = [], status = new Map(), shadow = new Map() }) {
  const by = new Map(prs.map((p) => [p.number, { ...p, defects: new Map() }]));
  for (const c of fixes?.candidates || []) {
    if (!['located', undefined].includes(c.status)) continue;
    for (const i of c.introducing || []) {
      const p = by.get(i.pr);
      if (!p || i.confirmed === false || c.fix.pr === i.pr) continue; // out of the trial; rejected by hand; fixed inside the same PR (not escaped)
      p.defects.set(c.fix.sha, (p.defects.get(c.fix.sha) || []).concat(i.spots || []));
    }
  }
  const review = (p) => { // null = no usable review of this PR
    if (p.arm === 1) { const last = (shadow.get(p.number) || []).reduce((a, e) => (!a || e.run > a.run ? e : a), null); return last?.status === 'ok' ? { list: last.findings, capped: !!last.capped } : null; } // the final head's latest run: a failed last run is unusable, whatever an earlier push said
    return USABLE.includes(status.get(p.number)) ? { list: findings.filter((f) => f.pr === p.number) } : null;
  };
  const groups = {};
  for (const p of by.values()) {
    const g = groups[p.arm ?? 'unlabeled'] ||= { prs: [], via: p.arm === 1 ? 'shadow' : 'delivered' };
    const rv = review(p), pairs = { hit: 0, same_file: 0, miss: 0, unusable: 0, no_location: 0 };
    for (const spots of p.defects.values()) {
      if (!spots.length) pairs.no_location++;
      else if (!rv) pairs.unusable++;
      else if (spots.some((s) => rv.list.some((f) => lineHit(f, s)))) pairs.hit++;
      else if (spots.some((s) => rv.list.some((f) => f.path === s.path))) pairs.same_file++;
      else pairs.miss++;
    }
    g.prs.push({ number: p.number, defects: p.defects.size, capped: rv?.capped ? 1 : 0, ...pairs });
  }
  for (const [k, g] of Object.entries(groups)) {
    const ps = g.prs, n = ps.length, e = ps.reduce((t, x) => t + x.defects, 0), sum = (f) => ps.reduce((t, x) => t + x[f], 0);
    const hit = sum('hit'), seen = hit + sum('same_file') + sum('miss');
    groups[k] = { via: g.via, prs: n, escaped: e, prs_with_escape: ps.filter((x) => x.defects).length, per_100: n >= FLOOR.prs ? 100 * e / n : null, cluster_95: n >= FLOOR.prs ? boot(ps, (x) => x.defects * 100, () => 1)  : null,
      hit, same_file: sum('same_file'), seen, unusable: sum('unusable'), no_location: sum('no_location'), capped_prs: sum('capped'), rate: seen >= FLOOR.located ? hit / seen : null, wilson: seen >= FLOOR.located ? wilson(hit, seen) : null,
      cluster_hit_95: seen >= FLOOR.located ? boot(ps.filter((x) => x.hit + x.same_file + x.miss), (x) => x.hit, (x) => x.hit + x.same_file + x.miss) : null, hit_prs: ps.filter((x) => x.hit).map((x) => x.number) };
  }
  return { fixes: (fixes?.candidates || []).length, groups };
}

// ---- shadow cache: one JSON line per (PR, head); appended so weekly runs outlive the artifact retention ----------
const readCache = (file) => {
  const m = new Map();
  try { for (const l of fs.readFileSync(file, 'utf8').split('\n')) if (l.trim()) { const e = JSON.parse(l); (m.get(e.pr) || m.set(e.pr, []).get(e.pr)).push(e); } } catch { /* no cache yet */ }
  return m;
};
const defaultGh = (a) => execFileSync('gh', a, { encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'pipe'] });
const defaultDownload = (repo, run, dir, name) => execFileSync('gh', ['run', 'download', String(run), '-R', repo, '-n', name, '-D', dir], { stdio: ['ignore', 'pipe', 'pipe'] });

// Add the arm-1 PRs' shadow runs that the cache lacks. A run's PR comes from the run, or from its head SHA when GitHub leaves `pull_requests` empty (fork PRs).
// Per (PR, head): newest run first, newest attempt first, until one has counts.json; if none has, the head is cached as `failed` (unusable). A head whose
// artifacts are expired or missing is not cached (a later run can still find it) and is counted in `missing`.
function syncShadow({ repo, since, prs, file, gh = defaultGh, download = defaultDownload }) {
  const have = new Set([...readCache(file).values()].flat().map((e) => `${e.pr}@${e.head}`)), want = new Set(prs), out = { added: 0, missing: 0 };
  const runs = gh(['api', '--paginate', '-X', 'GET', `repos/${repo}/actions/runs`, '-f', 'event=pull_request', '-f', `created=>=${since}`, '-f', 'per_page=100', '--jq', '.workflow_runs[] | {id, name, head_sha, pr: .pull_requests[0].number} | tojson'])
    .split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.name === SHADOW.workflow);
  const byHead = new Map(); // head sha -> PR number, looked up once
  const prOf = (r) => {
    if (r.pr) return r.pr;
    if (!byHead.has(r.head_sha)) { let n = null; try { n = JSON.parse(gh(['api', `repos/${repo}/commits/${r.head_sha}/pulls`, '--jq', '[.[].number]'])).find((x) => want.has(x)) ?? null; } catch { /* unknown commit */ } byHead.set(r.head_sha, n); }
    return byHead.get(r.head_sha);
  };
  const groups = new Map();
  for (const r of runs) { const pr = prOf(r); if (want.has(pr) && !have.has(`${pr}@${r.head_sha}`)) (groups.get(`${pr}@${r.head_sha}`) || groups.set(`${pr}@${r.head_sha}`, []).get(`${pr}@${r.head_sha}`)).push({ ...r, pr }); }
  for (const rs of groups.values()) {
    const tries = rs.flatMap((r) => JSON.parse(gh(['api', `repos/${repo}/actions/runs/${r.id}/artifacts`, '--jq', '[.artifacts[] | select(.expired | not) | .name]']))
      .map((n) => [r, n, SHADOW.artifact(r.pr).exec(n)?.[1]]).filter((x) => x[2]).sort((a, b) => b[2] - a[2]).map(([run, name, attempt]) => ({ run, name, attempt: +attempt })));
    if (!tries.length) { out.missing++; continue; }
    let e = { pr: rs[0].pr, head: rs[0].head_sha, run: tries[0].run.id, attempt: tries[0].attempt, status: 'failed', findings: [] };
    for (const t of tries) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-shadow-'));
      try {
        download(repo, t.run.id, dir, t.name);
        const c = JSON.parse(fs.readFileSync(path.join(dir, SHADOW.file), 'utf8')), sum = Array.isArray(c.sum) ? c.sum : [];
        e = { ...e, run: t.run.id, attempt: t.attempt, status: 'ok', capped: sum.length >= 20, findings: sum.filter((x) => typeof x?.path === 'string').map((x) => ({ path: x.path, line: Number.isInteger(x.line) ? x.line : null, kind: x.kind })) };
        break;
      } catch { /* no counts.json (or no download): a failed attempt, try the next */ } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    }
    fs.appendFileSync(file, JSON.stringify(e) + '\n');
    out.added++;
  }
  return out;
}

// ---- rendering --------------------------------------------------------------------------------------------------
const P = (x) => (x == null ? 'n/a' : `${(x * 100).toFixed(0)}%`);
const CI = (c) => (c ? `[${P(c[0])}, ${P(c[1])}]` : 'n/a');
const F = (x) => (x == null ? 'n/a' : x.toFixed(1));
const NAME = { 0: '0 SpecGuard only', 1: '1 Copilot only', 2: '2 both', unlabeled: 'no arm label' };
function renderEscapes(x) {
  const g = x.groups, ks = ['0', '1', '2', 'unlabeled'].filter((k) => g[k]);
  const L = ['## Escaped defects (SZZ, read 8-12 weeks after the trial starts)', '', `${x.fixes} fix candidates read. A defect counts once for each trial PR that SZZ blames for it; fixes not yet made are invisible, so recent PRs are undercounted. Every PR stays in the arm it was assigned (intention to treat).`, '',
    `**Outcome, comparable across arms: escaped defects per 100 PRs** (withheld below ${FLOOR.prs} PRs per arm).`, '', '| Arm | PRs | PRs with an escape | escaped defects | per 100 PRs | PR-cluster 95% |', '|---|---|---|---|---|---|'];
  for (const k of ks) L.push(`| ${NAME[k]} | ${g[k].prs} | ${g[k].prs_with_escape} | ${g[k].escaped} | ${g[k].per_100 == null ? `insufficient data (need ${FLOOR.prs} PRs)` : F(g[k].per_100)} | ${g[k].per_100 == null ? 'n/a' : `[${F(g[k].cluster_95?.[0])}, ${F(g[k].cluster_95?.[1])}]`} |`);
  L.push('', `**Not comparable between rows: what SpecGuard said about the blamed lines** (withheld below ${FLOOR.located} located defects). Arms 0, 2 and unlabelled: a finding was delivered on the introducing PR and the defect escaped anyway ("flagged but still escaped", an adoption or noise failure, not a catch). Arm 1: a finding the hidden shadow run would have posted ("would have caught", a counterfactual). The finding sets are the same: every kind and confidence the run reported, inline plus summary (a run's summary list holds at most 20).`, '',
    '| Arm | reading | line hit (finding within 3 lines) | Wilson 95% | PR-cluster 95% | same file only (file-level or farther) | unusable review | no location | runs with the 20-finding cap |', '|---|---|---|---|---|---|---|---|---|');
  for (const k of ks) L.push(`| ${NAME[k]} | ${k === '1' ? 'would have caught (shadow)' : 'flagged but still escaped (delivered)'} | ${g[k].hit}/${g[k].seen}${g[k].rate == null ? ` (insufficient data, need ${FLOOR.located})` : ` = ${P(g[k].rate)}`} | ${CI(g[k].wilson)} | ${CI(g[k].cluster_hit_95)} | ${g[k].same_file} | ${g[k].unusable} | ${g[k].no_location} | ${g[k].capped_prs} |`);
  L.push('', 'A line hit is a location match, not proof the finding was about the bug. Unusable = the review failed or is missing (never a miss, not in the denominator); no location = SZZ gave no blamed lines (reverts, old manifests).', '');
  return L;
}

module.exports = { escapes, syncShadow, readCache, renderEscapes, SHADOW, FLOOR };
