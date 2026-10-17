#!/usr/bin/env node
// Offline A-factor estimate from the sticky summaries' hidden `<!-- specguard:counts {json} -->` lines.
//   node eval/aggregate-counts.js --repo OWNER/REPO [--seed N]     (needs an authenticated `gh`)
//   node eval/aggregate-counts.js --file comments.json [--seed N]  (output of: gh api --paginate repos/O/R/issues/comments)
// One sticky summary per PR is edited in place, so the last complete counts line per PR is that PR's state at its latest complete run.
// `since` = { addressed, open, dismissed, not_observed }. A = addressed / all four. Optional per-PR fields `pr`, `merged`, `tests_changed`
// are used when present. PRs are censored at their last complete review, not at merge: read A as "addressed by the latest push", not as a final rate.
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

const OUTCOMES = ['addressed', 'open', 'dismissed', 'not_observed'];
const COUNTS = /<!-- specguard:counts (\{.*?\}) -->/s;

// gh --paginate prints one JSON array per page; the pages may be concatenated as `][`.
function parseComments(text) {
  const t = String(text).trim();
  if (!t) return [];
  try { return [].concat(JSON.parse(t)); } catch { /* fall through to the page-join form */ }
  return JSON.parse(t.replace(/\]\s*\[/g, ',')).flat();
}

// Last complete counts record per PR, in input order (comments arrive oldest first; a later updated_at wins when both have one).
function lastPerPr(comments) {
  const by = new Map();
  for (const c of comments) {
    const m = COUNTS.exec((c && c.body) || '');
    if (!m) continue;
    let t;
    try { t = JSON.parse(m[1]); } catch { continue; }
    const since = t && t.since;
    if (!('outcome_valid' in t ? t.outcome_valid === true : t.complete) || !since || !OUTCOMES.every((k) => Number.isFinite(since[k]) && since[k] >= 0)) continue; // a run without valid outcomes (old counts: not complete) carries none
    const key = Number.isInteger(t.pr) ? `pr:${t.pr}` : String(c.issue_url || c.html_url || by.size);
    const at = String(c.updated_at || '');
    const old = by.get(key);
    if (old && old.at > at) continue;
    by.set(key, { at, since, merged: typeof t.merged === 'boolean' ? t.merged : undefined, tests_changed: typeof t.tests_changed === 'boolean' ? t.tests_changed : undefined });
  }
  return [...by.values()];
}

const sum = (a, k) => a.reduce((s, x) => s + x.since[k], 0);
const total = (a) => OUTCOMES.reduce((s, k) => s + sum(a, k), 0);
const rate = (a) => (total(a) ? sum(a, 'addressed') / total(a) : null);
function wilson(k, n, z = 1.96) {
  if (!n) return null;
  const p = k / n, d = 1 + z * z / n, c = p + z * z / (2 * n), r = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n));
  return [(c - r) / d, (c + r) / d];
}
function mulberry32(a) { return () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
// Resample whole PRs, not findings: findings within one PR are not independent, so the Wilson interval is the optimistic one.
function bootstrap(prs, { seed = 1, rounds = 2000 } = {}) {
  if (prs.length < 2) return null;
  const rnd = mulberry32(seed), pick = () => prs[Math.floor(rnd() * prs.length)];
  const xs = Array.from({ length: rounds }, () => rate(prs.map(pick))).filter((x) => x !== null).sort((a, b) => a - b);
  return xs.length ? [xs[Math.floor(0.025 * xs.length)], xs[Math.min(xs.length - 1, Math.floor(0.975 * xs.length))]] : null;
}

function stratum(prs) { return { prs: prs.length, findings: total(prs), A: rate(prs) }; }
function summarize(prs, opts = {}) {
  const N = total(prs), k = sum(prs, 'addressed');
  const out = { prs: prs.length, findings: N, outcomes: Object.fromEntries(OUTCOMES.map((o) => [o, sum(prs, o)])), A: rate(prs), wilson_if_independent: wilson(k, N), cluster_bootstrap_95: bootstrap(prs, opts) };
  const strata = {};
  for (const [key, label] of [['merged', ['merged', 'not_merged']], ['tests_changed', ['tests_changed', 'tests_unchanged']]]) {
    const known = prs.filter((p) => p[key] !== undefined);
    if (known.length) strata[key] = { [label[0]]: stratum(known.filter((p) => p[key])), [label[1]]: stratum(known.filter((p) => !p[key])), unknown: prs.length - known.length };
  }
  if (Object.keys(strata).length) out.strata = strata;
  return out;
}

function fromGh(repo) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('--repo must be OWNER/REPO');
  return execFileSync('gh', ['api', '--paginate', `repos/${repo}/issues/comments`], { encoding: 'utf8', maxBuffer: 1 << 28 });
}

if (require.main === module) {
  const a = process.argv.slice(2), opt = (n) => { const i = a.indexOf(n); return i < 0 ? '' : a[i + 1] || ''; };
  if (!opt('--repo') && !opt('--file')) { console.error('Usage: node eval/aggregate-counts.js (--repo OWNER/REPO | --file comments.json) [--seed N]'); process.exit(2); }
  const text = opt('--file') ? fs.readFileSync(opt('--file'), 'utf8') : fromGh(opt('--repo'));
  console.log(JSON.stringify(summarize(lastPerPr(parseComments(text)), { seed: +opt('--seed') || 1 }), null, 2));
}
module.exports = { parseComments, lastPerPr, summarize, wilson, bootstrap };
