#!/usr/bin/env node
// Weekly validation report for the three-arm trial (docs/validation-plan.md): arm 0 SpecGuard only, 1 native Copilot review only, 2 both
// (label review-arm:N, see eval/assign.js). Prints a markdown report, or JSON with --json.
//   node eval/weekly-report.js --repo OWNER/REPO --since YYYY-MM-DD [--until D] [--baseline-since D --baseline-until D] [--labels labels.csv] [--json]
//   node eval/weekly-report.js --fixture dataset.json [...]     (offline; the dataset is what load() builds from gh)
// Needs an authenticated `gh`. The pull request page is the unit: findings in one PR are not independent, so intervals resample PRs.
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const { parseComments, lastPerPr, summarize, wilson, bootstrap } = require('./aggregate-counts');
const { armOf } = require('./assign');
const { findingId, parseCsv, readLabels, labelPrecision } = require('./label-export');
const post = require('../src/post');

// Sample-size targets (docs/validation-plan.md step 5): below them a rule reports "insufficient data" instead of a verdict.
const TARGET = { fixPrs: 40, fixFindings: 100, labels: 30, ttm: 30, validUnique: 15 };
const RULE = { fix: 0.25, fixLower: 0.15, precision: 0.65, ttm: 1.15, unique: 0.4, falsifyFix: 0.15, falsifyPrecision: 0.5, breakEven: 0.18, falsifyOverlap: 0.6 };
const COPILOT = /^copilot(-pull-request-reviewer)?(\[bot\])?$/i;
const SG_FP = /<!-- specguard:fp=([0-9a-f]{40}) -->/;
const SG_COUNTS = /<!-- specguard:counts (\{.*?\}) -->/s;
const INVALID_LABEL = 'copilot-request-failed';

// ---- loading ------------------------------------------------------------------------------------------------
const gh = (...a) => execFileSync('gh', a, { encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'pipe'] });
const tryGh = (...a) => { try { return JSON.parse(gh(...a)); } catch { return null; } };
const day = (d) => { if (!/^\d{4}-\d{2}-\d{2}$/.test(d || '')) throw new Error(`bad date "${d}" (want YYYY-MM-DD)`); return d; };
const isBot = (u) => u && (u.type === 'Bot' || /\[bot\]$/.test(u.login || ''));

// Old-side line numbers touched by a unified-diff patch: removed lines, and the old position where lines were inserted.
function patchTouches(patch, start, end) {
  let old = 0;
  for (const l of String(patch || '').split('\n')) {
    const h = /^@@ -(\d+)(?:,\d+)? \+\d+/.exec(l);
    if (h) { old = +h[1]; continue; }
    if (!old) continue;
    if (l[0] === '-') { if (old >= start && old <= end) return true; old++; }
    else if (l[0] === '+') { if (old >= start && old <= end) return true; }
    else if (l[0] !== '\\') old++;
  }
  return false;
}

const CAP = 300;
// The same rule as post.js (its own anchorTouched/testsChanged, not a copy), fed from the GitHub API instead of a clone: a stand-in for the two
// git calls they make, answering from the first-parent, non-merge commits of the compare (a base merged into the PR is not the author's change).
function apiGit(cmp, head, filesOf) {
  const by = new Map((cmp?.commits || []).map((x) => [x.sha, x])), chain = [];
  for (let x = by.get(head); x; x = by.get(x.parents?.[0]?.sha)) if (x.parents.length === 1) chain.unshift(x.sha);
  return (...a) => {
    if (!cmp || !['ahead', 'identical'].includes(cmp.status) || (cmp.total_commits || 0) > by.size) throw new Error('compare not usable');
    if (a[0] === 'merge-base') return '';
    const per = chain.map((sha) => filesOf(sha) || (() => { throw new Error('commit unavailable'); })());
    const cut = (fs) => fs.length >= CAP; // GitHub caps a commit's file list at 300: a file missing from a full list may only be cut off
    if (!a.includes('-p')) { // --no-renames: a rename is a delete of the old path plus an add of the new one
      const names = per.flat().flatMap((f) => (f.status === 'renamed' && f.previous_filename ? [f.previous_filename, f.filename] : [f.filename]));
      if (per.some(cut) && !names.some((n) => require('../src/trace').isTestPath(n))) throw new Error('commit file list may be truncated');
      return names.join('\n');
    }
    const file = a[a.length - 1], ws = a.includes('-w');
    return per.map((fs) => {
      const f = fs.find((x) => x.filename === file), gone = f?.status === 'removed' || fs.some((x) => x.status === 'renamed' && x.previous_filename === file);
      if (!gone && !f && cut(fs)) throw new Error('commit file list may be truncated');
      if (!gone && f && f.patch == null && f.changes !== 0) throw new Error('no patch for a changed file (large or binary)'); // unknown, not unchanged
      return gone ? 'deleted file mode 100644\n' : f ? unified0(f.patch, ws) : '';
    }).join('\0');
  };
}
// A -U3 patch as the -U0 hunks post.anchorTouched reads: only the changed runs, with their old-side position.
// ws (git's -w): a run whose removed and added lines are equal pairwise once all whitespace is gone is dropped.
// ponytail: git's -w can realign hunks, so this pairwise check is an approximation; exact only for same-length runs.
function unified0(patch, ws) {
  const out = []; let old = 0, run = null;
  const nw = (x) => x.replace(/\s+/g, '');
  const end = () => { if (run && !(ws && run.d && run.dl.length === run.al.length && run.dl.every((x, i) => nw(x) === nw(run.al[i])))) out.push(`@@ -${run.d ? run.a : run.a - 1},${run.d} +0,${run.k} @@`); run = null; };
  for (const l of String(patch || '').split('\n')) {
    const h = /^@@ -(\d+)/.exec(l);
    if (h) { end(); old = +h[1]; } else if (!old || l[0] === '\\') continue;
    else if (l[0] === '-') { run ||= { a: old, d: 0, k: 0, dl: [], al: [] }; run.d++; run.dl.push(l.slice(1)); old++; }
    else if (l[0] === '+') { run ||= { a: old, d: 0, k: 0, dl: [], al: [] }; run.k++; run.al.push(l.slice(1)); }
    else { end(); old++; }
  }
  end();
  return out.join('\n');
}

const search = (repo, q) => parseComments(gh('api', '--paginate', '-X', 'GET', 'search/issues', '-f', `q=repo:${repo} is:pr created:${q}`, '-f', 'per_page=100', '--jq', '.items'));
const normPr = (i) => ({ number: i.number, created_at: i.created_at, merged_at: i.pull_request?.merged_at || i.merged_at || null, closed_at: i.closed_at, user: i.user, labels: i.labels || [] });

function loadLive({ repo, since, until, 'baseline-since': bs, 'baseline-until': bu }) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('--repo must be OWNER/REPO');
  const end = until ? day(until) : new Date().toISOString().slice(0, 10);
  const prs = search(repo, `${day(since)}..${end}`).map(normPr);
  const baseline = bs ? search(repo, `${day(bs)}..${day(bu || since)}`).map(normPr) : [];
  const inWindow = new Set(prs.map((p) => p.number));
  const prOf = (url) => +/\/(?:pulls|issues)\/(\d+)$/.exec(url || '')?.[1];
  const issue_comments = parseComments(gh('api', '--paginate', `repos/${repo}/issues/comments?since=${since}T00:00:00Z&per_page=100`)).filter((c) => inWindow.has(prOf(c.issue_url)));
  const review_comments = parseComments(gh('api', '--paginate', `repos/${repo}/pulls/comments?since=${since}T00:00:00Z&per_page=100`)).map((c) => ({ ...c, pr: prOf(c.pull_request_url) })).filter((c) => inWindow.has(c.pr));
  const threads = [], compare = new Map(), commits = new Map();
  const [owner, name] = repo.split('/');
  for (const n of [...new Set(review_comments.filter((c) => COPILOT.test(c.user?.login || '') && !c.in_reply_to_id).map((c) => c.pr))]) {
    const g = tryGh('api', 'graphql', '-f', 'query=query($o:String!,$r:String!,$n:Int!){repository(owner:$o,name:$r){pullRequest(number:$n){reviewThreads(first:100){nodes{isResolved resolvedBy{login} comments(first:30){nodes{databaseId author{login}}}}}}}}', '-f', `o=${owner}`, '-f', `r=${name}`, '-F', `n=${n}`);
    for (const t of g?.data?.repository?.pullRequest?.reviewThreads?.nodes || []) threads.push({ pr: n, isResolved: t.isResolved, resolvedBy: t.resolvedBy?.login || null, comments: t.comments.nodes.map((c) => ({ id: c.databaseId, author: c.author?.login || null })) });
    const head = tryGh('api', `repos/${repo}/pulls/${n}`)?.head?.sha;
    for (const c of review_comments.filter((x) => x.pr === n && COPILOT.test(x.user?.login || '') && !x.in_reply_to_id)) {
      const key = `${c.original_commit_id}...${head}`;
      if (!compare.has(key)) compare.set(key, head && c.original_commit_id ? tryGh('api', `repos/${repo}/compare/${key}`) : null);
      const cmp = compare.get(key); // force-push or unreachable commit: null, so unknown, never "unchanged"
      const git = apiGit(cmp, head, (sha) => { if (!commits.has(sha)) commits.set(sha, tryGh('api', `repos/${repo}/commits/${sha}`)?.files || null); return commits.get(sha); });
      const l = c.original_line ?? c.line, s = c.original_start_line ?? l;
      c.anchor_touched = post.anchorTouched(c.original_commit_id, head, c.path, s, l, null, git);
      c.tests_changed = post.testsChanged(c.original_commit_id, head, null, git);
    }
  }
  return { repo, since, until: end, prs, baseline, issue_comments, review_comments, threads };
}
const load = (o) => (o.fixture ? JSON.parse(fs.readFileSync(o.fixture, 'utf8')) : loadLive(o));

// ---- findings -----------------------------------------------------------------------------------------------
const stripHidden = (b) => String(b || '').replace(/<!--[\s\S]*?-->/g, '').trim();
const lineOf = (c) => c.line ?? c.original_line ?? null;

// Top-level inline review comments of both tools. SpecGuard is identified by its fingerprint marker, Copilot by its bot login.
function findingsOf(ds) {
  const armBy = new Map(ds.prs.map((p) => [p.number, armOf(p.labels)]));
  const out = [], seen = new Set();
  for (const c of ds.review_comments || []) {
    if (c.in_reply_to_id || !armBy.has(c.pr)) continue;
    const fp = SG_FP.exec(c.body || '')?.[1];
    const tool = fp ? 'specguard' : COPILOT.test(c.user?.login || '') ? 'copilot' : null;
    if (!tool) continue;
    const ref = fp || String(c.id);
    if (seen.has(`${tool}${c.pr}${ref}`)) continue;
    seen.add(`${tool}${c.pr}${ref}`);
    out.push({ tool, delivery: 'inline', repo: ds.repo, pr: c.pr, arm: armBy.get(c.pr), path: c.path, line: lineOf(c), ref, id: c.id, text: stripHidden(c.body), url: c.html_url });
  }
  // Summary-only findings have no review comment; the latest sticky summary's counts list them in `sum`, keyed by the 16-hex fp prefix post.js tracks them under.
  // They join the same exposure set as inline ones, so blind labels, findings/PR, overlap and fix-through see one list. Counts written before `sum` existed carry none.
  for (const [pr, { t, url }] of lastCounts(ds, new Set(armBy.keys()))) {
    for (const e of Array.isArray(t.sum) ? t.sum.slice(0, 20) : []) {
      const fp = e?.fp;
      if (!/^[0-9a-f]{16}$/.test(fp) || typeof e.path !== 'string' || out.some((g) => g.tool === 'specguard' && g.pr === pr && g.ref.startsWith(fp))) continue; // also inline: counted once
      const line = Number.isInteger(e.line) ? e.line : null;
      out.push({ tool: 'specguard', delivery: 'summary', repo: ds.repo, pr, arm: armBy.get(pr), path: e.path, line, ref: fp, text: `${e.kind || 'finding'} at ${e.path}${line == null ? '' : `:${line}`}; the full text is in the PR's sticky summary comment`, url });
    }
  }
  // Overlap, arm 2 only: same path and a line within 3 (a file-level comment matches any line of its file).
  const near = (a, b) => a.path === b.path && (a.line == null || b.line == null || Math.abs(a.line - b.line) <= 3);
  for (const f of out) if (f.arm === 2) f.overlap = out.some((g) => g.arm === 2 && g.tool !== f.tool && g.pr === f.pr && near(f, g));
  for (const f of out) f.fid = findingId(f);
  return out;
}

// Same rule as SpecGuard's followUp/outcome (src/post.js). No "still reported" signal exists for Copilot: an unresolved thread whose anchor and
// tests did not change is `open`; a human-resolved thread with nothing changed is `dismissed`; unknown change status is `not_observed`.
function copilotOutcome({ thread, anchor_touched, tests_changed }) {
  if (thread?.isResolved && anchor_touched === false && tests_changed !== true) return 'dismissed';
  if (anchor_touched === true || tests_changed === true) return 'addressed';
  if (anchor_touched === false && thread && !thread.isResolved) return 'open';
  return 'not_observed';
}

function copilotOutcomes(ds) {
  const byComment = new Map();
  for (const t of ds.threads || []) if (t.comments?.[0]) byComment.set(`${t.pr}:${t.comments[0].id}`, t);
  const out = [];
  for (const c of ds.review_comments || []) {
    if (c.in_reply_to_id || !COPILOT.test(c.user?.login || '')) continue;
    const thread = byComment.get(`${c.pr}:${c.id}`);
    const o = copilotOutcome({ thread, anchor_touched: c.anchor_touched, tests_changed: c.tests_changed });
    const replied = !!thread && thread.comments.slice(1).some((x) => x.author && !COPILOT.test(x.author));
    out.push({ pr: c.pr, outcome: o, replied, resolved: !!thread?.isResolved });
  }
  return out;
}

// ---- statistics ---------------------------------------------------------------------------------------------
function quantile(xs, q) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b), i = (s.length - 1) * q, lo = Math.floor(i);
  return s[lo] + (s[Math.min(lo + 1, s.length - 1)] - s[lo]) * (i - lo);
}
const hours = (p) => (new Date(p.merged_at) - new Date(p.created_at)) / 36e5;
const ttm = (prs) => { const h = prs.filter((p) => p.merged_at && !isBot(p.user)).map(hours).filter((x) => x >= 0); return { n: h.length, median: quantile(h, 0.5), p75: quantile(h, 0.75) }; };
const sinceOf = (rows) => { const s = { addressed: 0, open: 0, dismissed: 0, not_observed: 0 }; for (const r of rows) s[r.outcome]++; return s; };
// PR-level pseudo records so aggregate-counts' bootstrap/summarize resample whole PRs.
const asPrs = (rows) => { const by = new Map(); for (const r of rows) (by.get(r.pr) || by.set(r.pr, []).get(r.pr)).push(r); return [...by.values()].map((rs) => ({ since: sinceOf(rs) })); };

// pr -> { t: the latest sticky summary's parsed counts, url } for the PRs in prSet.
function lastCounts(ds, prSet) {
  const last = new Map();
  for (const c of ds.issue_comments || []) {
    if (!String(c.body || '').includes('<!-- specguard:summary -->')) continue;
    const m = SG_COUNTS.exec(c.body); let t;
    try { t = JSON.parse(m[1]); } catch { continue; }
    const n = Number.isInteger(t.pr) ? t.pr : +/\/issues\/(\d+)$/.exec(c.issue_url || '')?.[1];
    if (prSet.has(n)) last.set(n, { t, url: c.html_url });
  }
  return last;
}
// Per-finding outcomes from the counts line the A tally reads (same validity rule as aggregate-counts). A 16-hex fp is a summary-only finding.
function sgOutcomes(ds, prSet) {
  const rows = [];
  for (const [pr, { t }] of lastCounts(ds, prSet)) {
    if (!('outcome_valid' in t ? t.outcome_valid === true : t.complete) || !Array.isArray(t.outcomes)) continue;
    for (const o of t.outcomes) if (typeof o?.fp === 'string' && ['addressed', 'open', 'dismissed', 'not_observed'].includes(o.outcome)) rows.push({ pr, fp: o.fp, outcome: o.outcome, delivery: o.fp.length === 16 ? 'summary' : 'inline' });
  }
  return rows;
}

function sgCredits(ds, prSet) {
  const ts = [...lastCounts(ds, prSet).values()].map((x) => x.t);
  const num = (k) => ts.map((t) => t[k]).filter(Number.isFinite);
  return { prs_with_counts: ts.length, complete: ts.filter((t) => t.complete).length, credits_median: quantile(num('credits'), 0.5), credits_mean: num('credits').length ? num('credits').reduce((a, b) => a + b, 0) / num('credits').length : null, ms_median: quantile(num('ms'), 0.5) };
}

function analyze(ds, { labels } = {}) {
  const real = (p) => !isBot(p.user);
  const prs = ds.prs.filter(real);
  const invalid = prs.filter((p) => (p.labels || []).some((l) => (l.name || l) === INVALID_LABEL));
  const usable = prs.filter((p) => !invalid.includes(p));
  const armPrs = (a) => usable.filter((p) => armOf(p.labels) === a);
  const findings = findingsOf({ ...ds, prs: usable });
  const cop = copilotOutcomes({ ...ds, review_comments: (ds.review_comments || []).filter((c) => armPrs(1).concat(armPrs(2)).some((p) => p.number === c.pr)) });
  const arms = {};
  for (const a of [0, 1, 2]) {
    const ps = armPrs(a), set = new Set(ps.map((p) => p.number)), mine = (t) => findings.filter((f) => f.tool === t && f.arm === a);
    const row = { prs: ps.length, ttm: ttm(ps) };
    if (a !== 1) row.specguard = { findings: mine('specguard').length, findings_per_pr: ps.length ? mine('specguard').length / ps.length : null, ...sgCredits(ds, set) };
    if (a !== 0) { const o = cop.filter((r) => set.has(r.pr)); row.copilot = { findings: mine('copilot').length, findings_per_pr: ps.length ? mine('copilot').length / ps.length : null, prs_with_findings: new Set(mine('copilot').map((f) => f.pr)).size, outcomes: sinceOf(o) }; }
    arms[a] = row;
  }
  const sgSet = new Set([...armPrs(0), ...armPrs(2)].map((p) => p.number));
  const sgComments = (ds.issue_comments || []).filter((c) => sgSet.has(+/\/issues\/(\d+)$/.exec(c.issue_url || '')?.[1]) && String(c.body || '').includes('<!-- specguard:summary -->'));
  const specguard = summarize(lastPerPr(sgComments));
  const copRows = cop.filter((r) => [...armPrs(1), ...armPrs(2)].some((p) => p.number === r.pr));
  const copilot = summarize(asPrs(copRows));
  const withReplies = copRows.length ? (sinceOf(copRows).addressed + copRows.filter((r) => r.outcome === 'dismissed' && r.replied).length) / copRows.length : null;
  const sg2 = findings.filter((f) => f.tool === 'specguard' && f.arm === 2), cp2 = findings.filter((f) => f.tool === 'copilot' && f.arm === 2);
  const overlap = { specguard_findings: sg2.length, specguard_also_raised_by_copilot: sg2.filter((f) => f.overlap).length, copilot_findings: cp2.length, copilot_also_raised_by_specguard: cp2.filter((f) => f.overlap).length };
  const lab = labels ? labelPrecision(findings, labels) : null;
  const validSg2 = labels ? sg2.filter((f) => labels.get(f.fid) === 'valid') : [];
  const unique = labels ? { valid: validSg2.length, unique: validSg2.filter((f) => !f.overlap).length } : null;
  // SpecGuard per delivery channel; the combined numbers above are unchanged. Each channel reads findings, labels and outcomes off the same ids.
  const oc = sgOutcomes(ds, sgSet), sgAll = findings.filter((f) => f.tool === 'specguard');
  const channels = {};
  for (const d of ['inline', 'summary']) {
    const mine = sgAll.filter((f) => f.delivery === d), m2 = mine.filter((f) => f.arm === 2), v2 = labels ? m2.filter((f) => labels.get(f.fid) === 'valid') : null;
    const fx = summarize(asPrs(oc.filter((r) => r.delivery === d)));
    channels[d] = { findings: mine.length, fix_through: { prs: fx.prs, findings: fx.findings, outcomes: fx.outcomes, A: fx.A }, overlap: { findings: m2.length, also_raised_by_copilot: m2.filter((f) => f.overlap).length },
      labels: labels ? (() => { const x = labelPrecision(mine, labels).specguard; return x || null; })() : null, unique: v2 ? { valid: v2.length, unique: v2.filter((f) => !f.overlap).length } : null };
  }
  // Measured joint: valid AND addressed, over labelled (valid|invalid) findings that have an observed outcome on the same id (outcome fp prefix = finding ref prefix).
  let joint = null;
  if (labels) {
    const outBy = new Map(oc.map((r) => [`${r.pr}:${r.fp.slice(0, 16)}`, r.outcome]));
    const j = { labelled: 0, with_outcome: 0, valid: 0, valid_addressed: 0 };
    for (const f of sgAll) {
      const l = labels.get(f.fid), o = outBy.get(`${f.pr}:${f.ref.slice(0, 16)}`);
      if (l !== 'valid' && l !== 'invalid') continue;
      j.labelled++;
      if (!o || o === 'not_observed') continue;
      j.with_outcome++;
      if (l === 'valid') { j.valid++; if (o === 'addressed') j.valid_addressed++; }
    }
    joint = { ...j, rate: j.with_outcome >= TARGET.labels ? j.valid_addressed / j.with_outcome : null };
  }
  const report = { repo: ds.repo, window: [ds.since, ds.until], prs: prs.length, excluded_copilot_request_failed: invalid.length, unlabeled: usable.filter((p) => armOf(p.labels) === null).length,
    arms, baseline: ttm((ds.baseline || []).filter(real)), specguard, copilot: { ...copilot, A_if_replied_resolved_counts: withReplies }, overlap, labels: lab, unique, channels, joint };
  report.decision = decide(report);
  return report;
}

// ---- decision rule ------------------------------------------------------------------------------------------
const PASS = 'pass', FAIL = 'fail', NODATA = 'insufficient data';
function decide(r) {
  const a = r.specguard, boot = a.cluster_bootstrap_95, sg = r.labels?.specguard, u = r.unique;
  const fixOk = a.prs >= TARGET.fixPrs && a.findings >= TARGET.fixFindings && boot;
  const precOk = sg && sg.n >= TARGET.labels;
  const base = r.baseline, t0 = r.arms[0].ttm;
  const ttmOk = t0.n >= TARGET.ttm && base.n >= TARGET.ttm;
  const ratio = ttmOk ? t0.median / base.median : null;
  const uniqOk = u && u.valid >= TARGET.validUnique;
  const uniq = uniqOk ? u.unique / u.valid : null;
  const pa = fixOk && precOk ? sg.precision * a.A : null;
  const f = (x) => (x == null ? 'n/a' : `${(x * 100).toFixed(0)}%`);
  const rules = [
    { rule: `Fix-through A >= ${f(RULE.fix)} with PR-cluster lower bound > ${f(RULE.fixLower)}`, status: !fixOk ? NODATA : a.A >= RULE.fix && boot[0] > RULE.fixLower ? PASS : FAIL,
      detail: `A ${f(a.A)}, cluster 95% [${boot ? `${f(boot[0])}, ${f(boot[1])}` : 'n/a'}], ${a.prs} PRs / ${a.findings} findings (need ${TARGET.fixPrs} PRs, ${TARGET.fixFindings} findings)` },
    { rule: `Blind precision >= ${f(RULE.precision)}`, status: !precOk ? NODATA : sg.precision >= RULE.precision ? PASS : FAIL,
      detail: sg ? `${f(sg.precision)} (${sg.valid}/${sg.n}, Wilson [${f(sg.wilson?.[0])}, ${f(sg.wilson?.[1])}], ${sg.unsure} unsure; need ${TARGET.labels} labelled)` : `no labels (need ${TARGET.labels} labelled SpecGuard findings)` },
    { rule: `Time-to-merge, SpecGuard-only arm vs no-AI baseline, <= +${Math.round((RULE.ttm - 1) * 100)}%`, status: !ttmOk ? NODATA : ratio <= RULE.ttm ? PASS : FAIL,
      detail: `arm 0 median ${t0.median?.toFixed(1) ?? 'n/a'} h (n=${t0.n}) vs baseline ${base.median?.toFixed(1) ?? 'n/a'} h (n=${base.n})${ratio ? `, ratio ${ratio.toFixed(2)}` : ''} (need ${TARGET.ttm} merged PRs each)` },
    { rule: `>= ${f(RULE.unique)} of valid SpecGuard findings in arm 2 unique to SpecGuard`, status: !uniqOk ? NODATA : uniq >= RULE.unique ? PASS : FAIL,
      detail: u ? `${u.unique}/${u.valid} unique (need ${TARGET.validUnique} valid labelled findings in arm 2)` : `no labels; unlabelled estimate: ${r.overlap.specguard_findings - r.overlap.specguard_also_raised_by_copilot}/${r.overlap.specguard_findings} of SpecGuard findings in arm 2 have no Copilot finding within 3 lines` },
  ];
  const fix = (c) => (c === null ? NODATA : c ? 'FIRED' : 'not fired');
  const tri = (a1, a2) => (a1 === true || a2 === true ? true : a1 === false && a2 === false ? false : null); // one known true fires it; both known false clears it
  const falsifiers = [
    { falsifier: `F1 A < ${f(RULE.falsifyFix)} over >= ${TARGET.fixPrs} PRs, or precision < ${f(RULE.falsifyPrecision)} on >= ${TARGET.labels} labelled`, status: fix(tri(fixOk ? a.A < RULE.falsifyFix : null, precOk ? sg.precision < RULE.falsifyPrecision : null)) },
    { falsifier: `F2 P × A (economic assumption, not a measured joint rate) < ${RULE.breakEven} (break-even)`, status: fix(pa === null ? null : pa < RULE.breakEven), detail: pa === null ? undefined : `P x A = ${pa.toFixed(2)}` },
    { falsifier: 'F3 time-to-merge more than 15% worse than baseline (check by hand that review comments did not drop either)', status: fix(ratio === null ? null : ratio > RULE.ttm) },
    { falsifier: `F4 native Copilot raises >= ${f(RULE.falsifyOverlap)} of the valid SpecGuard findings`, status: fix(uniqOk ? 1 - uniq >= RULE.falsifyOverlap : null) },
    { falsifier: 'F5 SZZ replay of the last 50 bugs: < 10% PR-time visible, or SpecGuard flags < 1/3 of those', status: 'manual (docs/validation-plan.md step 1)' },
  ];
  const fired = falsifiers.some((x) => x.status === 'FIRED');
  const verdict = fired ? 'STOP OR REPOSITION: a falsifier fired.' : rules.every((x) => x.status === PASS) ? 'CONTINUE: every rule passes and no falsifier fired (F5 is checked by hand).'
    : rules.some((x) => x.status === FAIL) ? 'DO NOT EXPAND: at least one rule failed (no falsifier fired).' : 'KEEP COLLECTING: insufficient data for at least one rule.';
  return { rules, falsifiers, verdict };
}

// ---- rendering ----------------------------------------------------------------------------------------------
const P = (x) => (x == null ? 'n/a' : `${(x * 100).toFixed(0)}%`);
const N = (x, d = 1) => (x == null ? 'n/a' : x.toFixed(d));
const CI = (c) => (c ? `[${P(c[0])}, ${P(c[1])}]` : 'n/a');
const ARM = ['0 SpecGuard only', '1 Copilot only', '2 both'];
function render(r) {
  const L = [`# SpecGuard validation: ${r.repo}, ${r.window[0]} to ${r.window[1]}`, '',
    `${r.prs} human PRs; ${r.unlabeled} without a review-arm label; ${r.excluded_copilot_request_failed} excluded (label \`${INVALID_LABEL}\`).`,
    'Counts below ' + TARGET.ttm + ' PRs per arm are counts, not rates. Fix-through is read at each PR\'s latest run, not at merge.', '',
    '## Per arm', '', '| Arm | PRs | SpecGuard findings/PR | Copilot findings/PR | TTM median h | TTM p75 h | merged | SpecGuard credits/PR (last run) | complete runs |', '|---|---|---|---|---|---|---|---|---|'];
  for (const a of [0, 1, 2]) {
    const x = r.arms[a], s = x.specguard, c = x.copilot;
    L.push(`| ${ARM[a]} | ${x.prs} | ${s ? N(s.findings_per_pr, 2) : '-'} | ${c ? N(c.findings_per_pr, 2) : '-'} | ${N(x.ttm.median)} | ${N(x.ttm.p75)} | ${x.ttm.n} | ${s ? N(s.credits_median, 2) : '-'} | ${s ? `${s.complete}/${s.prs_with_counts}` : '-'} |`);
  }
  L.push(`| baseline (no AI window) | - | - | - | ${N(r.baseline.median)} | ${N(r.baseline.p75)} | ${r.baseline.n} | - | - |`, '');
  L.push('## Fix-through (addressed / all outcomes)', '', '| Tool | PRs | findings | A | Wilson (if independent) | PR-cluster bootstrap 95% |', '|---|---|---|---|---|---|');
  for (const [n, s] of [['SpecGuard (arms 0+2)', r.specguard], ['Native Copilot (arms 1+2)', r.copilot]]) L.push(`| ${n} | ${s.prs} | ${s.findings} | ${P(s.A)} | ${CI(s.wilson_if_independent)} | ${CI(s.cluster_bootstrap_95)} |`);
  L.push('', `Copilot outcome rule mirrors SpecGuard's: addressed = the flagged lines or any test file changed after the comment; dismissed = human-resolved with neither changed; open = unresolved and unchanged; not_observed = change status unknown. If a human-resolved thread with a reply counted as addressed, Copilot A would be ${P(r.copilot.A_if_replied_resolved_counts)}.`, '');
  L.push('## SpecGuard by delivery channel (arms 0+2)', '', '| Channel | findings (blind-label pool) | fix-through findings | A | precision | unique / valid (arm 2) |', '|---|---|---|---|---|---|');
  for (const d of ['inline', 'summary']) {
    const c = r.channels[d], x = c.fix_through, l = c.labels;
    L.push(`| ${d} | ${c.findings} | ${x.findings} | ${x.findings ? `${P(x.A)} (${x.outcomes.addressed}/${x.findings})` : 'n/a'} | ${l ? `${P(l.precision)} (${l.valid}/${l.n})` : 'n/a'} | ${c.unique ? `${c.unique.unique}/${c.unique.valid}` : 'n/a'} |`);
  }
  L.push(`| combined | ${r.channels.inline.findings + r.channels.summary.findings} | ${r.specguard.findings} | ${P(r.specguard.A)} | ${r.labels?.specguard ? `${P(r.labels.specguard.precision)} (${r.labels.specguard.valid}/${r.labels.specguard.n})` : 'n/a'} | ${r.unique ? `${r.unique.unique}/${r.unique.valid}` : 'n/a'} |`, '',
    'Summary-only findings are tracked from SpecGuard #233 (2026-10-17): counts written before it carry none, so earlier weeks have only inline findings in every channel. Outcomes are the per-finding list in the counts line, which drops its oldest entries when long, so channel outcome counts can be below the combined tally.', '');
  const o = r.overlap;
  L.push('## Overlap in arm 2 (same file, lines within 3)', '', `SpecGuard findings also raised by Copilot: ${o.specguard_also_raised_by_copilot}/${o.specguard_findings}. Copilot findings also raised by SpecGuard: ${o.copilot_also_raised_by_specguard}/${o.copilot_findings}. This is location overlap, not agreement on the same defect: the labels decide.`, '');
  if (r.labels) {
    L.push('## Blind labels', '', '| Tool | valid | invalid | unsure | precision | Wilson 95% |', '|---|---|---|---|---|---|');
    for (const t of ['specguard', 'copilot']) { const x = r.labels[t]; if (x) L.push(`| ${t} | ${x.valid} | ${x.invalid} | ${x.unsure} | ${P(x.precision)} | ${CI(x.wilson)} |`); }
    if (r.labels.unmatched) L.push('', `${r.labels.unmatched.length} label ids matched no finding in this window (wrong window or --seed?).`);
    L.push('');
  }
  const j = r.joint;
  L.push('## P × A (economic assumption, not a measured joint rate)', '', 'F2 multiplies two marginals; they cannot give the joint (50 valid + 50 invalid findings with 50 touched allows anywhere from 0 to 0.5). A counts touched lines, not verified fixes.',
    !j ? 'Measured joint (valid and addressed / labelled with an observed outcome): needs --labels.'
      : !j.with_outcome ? `Measured joint not computed: none of the ${j.labelled} labelled SpecGuard findings has an observed outcome under the same id (different window or seed, or no per-finding outcomes recorded).`
        : j.rate == null ? `Measured joint: insufficient data (${j.valid_addressed}/${j.with_outcome} valid and addressed; need ${TARGET.labels} labelled findings with an observed outcome).`
          : `Measured joint: ${P(j.rate)} (${j.valid_addressed}/${j.with_outcome} valid and addressed among labelled findings with an observed outcome; ${j.valid} of them valid).`, '');
  L.push('## Decision rule', '', ...r.decision.rules.map((x) => `- **${x.status.toUpperCase()}**: ${x.rule}. ${x.detail}`), '', '## Falsifiers', '', ...r.decision.falsifiers.map((x) => `- **${x.status}**: ${x.falsifier}${x.detail ? `. ${x.detail}` : ''}`), '', `**${r.decision.verdict}**`, '',
    'Privacy: this report has no code, but the label CSV and the PR comments do. Not measured here: escaped defects (follow up at 8-12 weeks), native Copilot cost (see the Copilot usage report).');
  return L.join('\n');
}

function main() {
  const { values: o } = require('node:util').parseArgs({ options: { repo: { type: 'string' }, since: { type: 'string' }, until: { type: 'string' }, fixture: { type: 'string' }, labels: { type: 'string' },
    'baseline-since': { type: 'string' }, 'baseline-until': { type: 'string' }, json: { type: 'boolean' } } });
  if (!o.fixture && !(o.repo && o.since)) { console.error('Usage: node eval/weekly-report.js (--repo OWNER/REPO --since YYYY-MM-DD [--until D] [--baseline-since D --baseline-until D] | --fixture FILE) [--labels labels.csv] [--json]'); process.exit(2); }
  const r = analyze(load(o), { labels: o.labels ? readLabels(parseCsv(fs.readFileSync(o.labels, 'utf8'))) : null });
  console.log(o.json ? JSON.stringify(r, null, 2) : render(r));
}
module.exports = { lastCounts, apiGit, unified0, load, findingsOf, copilotOutcome, patchTouches, analyze, decide, render, quantile, TARGET, RULE };
if (require.main === module) try { main(); } catch (e) { console.error(e.message); process.exit(1); }
