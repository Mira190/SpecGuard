// Escaped defects per trial arm (docs/validation-plan.md step 7), read 8-12 weeks after the trial starts.
// Input: `szz.js mine` output (fix -> introducing commit -> PR, with the blamed spots) and the trial PRs. Output per arm: introducing PRs, escaped
// defects per 100 PRs (PR-cluster bootstrap), and for each escaped defect whether a SpecGuard finding sat on the blamed lines.
// Arms 0/2 and unlabelled PRs: the findings SpecGuard delivered. Arm 1: the shadow run's findings, read from the `specguard-ctx` artifact into a local JSONL cache.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { wilson } = require('./aggregate-counts');
const { mulberry32 } = require('./szz');

// The one place that names the shadow run's contract (workflow, artifact, file inside it). counts.json is what post.js writes at the end of a finished
// run: its `sum` lists the findings that went to the summary (all of them under `delivery: summary`); a run that failed early writes none.
const SHADOW = { workflow: 'SpecGuard validation', artifact: 'specguard-ctx', file: 'counts.json' };
// Floors: 30 PRs per arm is the plan's rate floor (step 2, same as time-to-merge); 10 located defects is the least that gives a catch rate a non-silly interval.
const FLOOR = { prs: 30, located: 10 };
const TOL = 3; // lines, the overlap rule of weekly-report.js
const USABLE = ['complete', 'incomplete']; // sticky summary status: a review ran. `failed` (auth_failed, quota...) and no summary are unusable, never a miss.

const near = (f, s) => f.path === s.path && (f.line == null || Math.abs(f.line - s.line) <= TOL);

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
    if (p.arm === 1) { const ok = (shadow.get(p.number) || []).filter((e) => e.status === 'ok'); return ok.length ? ok.flatMap((e) => e.findings) : null; }
    return USABLE.includes(status.get(p.number)) ? findings.filter((f) => f.pr === p.number) : null;
  };
  const groups = {};
  for (const p of by.values()) {
    const g = groups[p.arm ?? 'unlabeled'] ||= { prs: [], via: p.arm === 1 ? 'shadow' : 'delivered' };
    const rv = review(p), pairs = { hit: 0, miss: 0, unusable: 0, no_location: 0 };
    for (const spots of p.defects.values()) {
      if (!spots.length) pairs.no_location++;
      else if (!rv) pairs.unusable++;
      else if (spots.some((s) => rv.some((f) => near(f, s)))) pairs.hit++;
      else pairs.miss++;
    }
    g.prs.push({ number: p.number, defects: p.defects.size, ...pairs });
  }
  for (const [k, g] of Object.entries(groups)) {
    const ps = g.prs, n = ps.length, e = ps.reduce((t, x) => t + x.defects, 0), sum = (f) => ps.reduce((t, x) => t + x[f], 0);
    const hit = sum('hit'), seen = hit + sum('miss');
    groups[k] = { via: g.via, prs: n, escaped: e, prs_with_escape: ps.filter((x) => x.defects).length, per_100: n >= FLOOR.prs ? 100 * e / n : null, cluster_95: n >= FLOOR.prs ? boot(ps, (x) => x.defects * 100, () => 1)  : null,
      hit, seen, unusable: sum('unusable'), no_location: sum('no_location'), rate: seen >= FLOOR.located ? hit / seen : null, wilson: seen >= FLOOR.located ? wilson(hit, seen) : null,
      cluster_hit_95: seen >= FLOOR.located ? boot(ps.filter((x) => x.hit + x.miss), (x) => x.hit, (x) => x.hit + x.miss) : null, hit_prs: ps.filter((x) => x.hit).map((x) => x.number) };
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
const defaultDownload = (repo, run, dir) => execFileSync('gh', ['run', 'download', String(run), '-R', repo, '-n', SHADOW.artifact, '-D', dir], { stdio: ['ignore', 'pipe', 'pipe'] });

// Add the arm-1 PRs' shadow runs that the cache lacks. A run whose artifact has no counts.json failed early: cached as status `failed` (unusable).
// An expired or missing artifact is not cached (so a later run can still find it) and is counted in `missing`.
function syncShadow({ repo, since, prs, file, gh = defaultGh, download = defaultDownload }) {
  const have = new Set([...readCache(file).values()].flat().map((e) => `${e.pr}@${e.head}`)), want = new Set(prs), out = { added: 0, missing: 0 };
  const seen = new Set();
  const runs = gh(['api', '--paginate', '-X', 'GET', `repos/${repo}/actions/runs`, '-f', 'event=pull_request', '-f', `created=>=${since}`, '-f', 'per_page=100', '--jq', '.workflow_runs[] | {id, name, head_sha, pr: .pull_requests[0].number} | tojson'])
    .split('\n').filter(Boolean).map((l) => JSON.parse(l));
  for (const r of runs) {
    const key = `${r.pr}@${r.head_sha}`;
    if (r.name !== SHADOW.workflow || !want.has(r.pr) || have.has(key) || seen.has(key)) continue;
    seen.add(key); // newest run first: a re-run of the same head is not read twice
    const arts = JSON.parse(gh(['api', `repos/${repo}/actions/runs/${r.id}/artifacts`, '--jq', `[.artifacts[] | select(.name == "${SHADOW.artifact}" and (.expired | not))]`]));
    if (!arts.length) { out.missing++; continue; }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-shadow-'));
    try {
      download(repo, r.id, dir);
      let e = { pr: r.pr, head: r.head_sha, run: r.id, status: 'failed', findings: [] };
      try {
        const t = JSON.parse(fs.readFileSync(path.join(dir, SHADOW.file), 'utf8'));
        e = { ...e, status: 'ok', findings: (Array.isArray(t.sum) ? t.sum : []).filter((x) => typeof x?.path === 'string').map((x) => ({ path: x.path, line: Number.isInteger(x.line) ? x.line : null, kind: x.kind })) };
      } catch { /* no counts.json: failed run */ }
      fs.appendFileSync(file, JSON.stringify(e) + '\n');
      out.added++;
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
  return out;
}

// ---- rendering --------------------------------------------------------------------------------------------------
const P = (x) => (x == null ? 'n/a' : `${(x * 100).toFixed(0)}%`);
const CI = (c) => (c ? `[${P(c[0])}, ${P(c[1])}]` : 'n/a');
const NAME = { 0: '0 SpecGuard only (delivered)', 1: '1 Copilot only (shadow SpecGuard run)', 2: '2 both (delivered)', unlabeled: 'no arm label (delivered)' };
function renderEscapes(x) {
  const L = ['## Escaped defects (SZZ, read 8-12 weeks after the trial starts)', '', `${x.fixes} fix candidates read. A defect counts for each trial PR that SpecGuard's SZZ blames for it; fixes not yet made are invisible, so recent PRs are undercounted. Below ${FLOOR.prs} PRs per arm the rate is withheld; below ${FLOOR.located} located defects the catch rate is.`, '',
    '| Arm | PRs | PRs with an escape | escaped defects | per 100 PRs | PR-cluster 95% | on blamed lines | Wilson 95% | PR-cluster 95% | unusable review | no location |', '|---|---|---|---|---|---|---|---|---|---|---|'];
  for (const k of ['0', '1', '2', 'unlabeled']) {
    const g = x.groups[k];
    if (g) L.push(`| ${NAME[k]} | ${g.prs} | ${g.prs_with_escape} | ${g.escaped} | ${g.per_100 == null ? `insufficient data (need ${FLOOR.prs} PRs)` : g.per_100.toFixed(1)} | ${g.per_100 == null ? 'n/a' : `[${g.cluster_95?.[0]?.toFixed(1) ?? 'n/a'}, ${g.cluster_95?.[1]?.toFixed(1) ?? 'n/a'}]`} | ${g.hit}/${g.seen}${g.rate == null ? ` (insufficient data, need ${FLOOR.located})` : ` = ${P(g.rate)}`} | ${CI(g.wilson)} | ${CI(g.cluster_hit_95)} | ${g.unusable} | ${g.no_location} |`);
  }
  L.push('', '"On blamed lines": a SpecGuard finding on the introducing PR with the same file and a line within 3 of a blamed line (arm 1: the hidden shadow run; the others: findings delivered on the PR). Location match, not proof the finding was about the bug. Unusable = the review failed or is missing (never a miss); no location = SZZ gave no blamed lines (reverts, old manifests).', '');
  return L;
}

module.exports = { escapes, syncShadow, readCache, renderEscapes, SHADOW, FLOOR };
