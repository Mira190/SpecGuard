#!/usr/bin/env node
// Step 0: deterministic skip decision before any model tokens are spent. Fails open: when GitHub cannot be read, the review runs.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');

// Our own comment author: a Bot whose login is the authenticated actor (or the login our earlier summary recorded), else github-actions[bot]
// (what GITHUB_TOKEN posts as). A User counts only when it IS the authenticated actor (a PAT). REST gives user.type, GraphQL author.__typename
// (with a login lacking the [bot] suffix). Shared by preflight, comment dedup and stale-thread resolve.
const bare = (s) => String(s).replace(/\[bot\]$/i, '').toLowerCase();
const ours = (u, actor) => {
  if (!u || typeof u.login !== 'string') return false;
  const t = u.type || u.__typename;
  return t === 'Bot' ? bare(u.login) === bare(actor || 'github-actions[bot]') : t === 'User' && !!actor && u.login.toLowerCase() === String(actor).toLowerCase();
};
// An App token cannot call /user, so the posting login is recorded in our summary (<!-- specguard:by=LOGIN -->). Trusted only inside a
// summary comment whose Bot author IS that login; a person can never become "ours" this way.
const SUMMARY = '<!-- specguard:summary -->';
const recordedLogin = (comments = []) => {
  for (const c of comments) {
    const m = c?.user?.type === 'Bot' && typeof c.body === 'string' && c.body.startsWith(SUMMARY) && /^<!-- specguard:by=([\w-]+(?:\[bot\])?) -->$/m.exec(c.body);
    if (m && bare(c.user.login) === bare(m[1])) return m[1];
  }
  return null;
};

// Our own sticky summary (our comment that starts with the marker) that records this head SHA. The SHA marker is
// absent from "could not complete" and incomplete summaries, so those runs are retried.
// Requirements fingerprint (PR title + body, the requirement sources). A req marker that differs from `req` means they changed since the review: review again.
// A summary with no req marker (older version) still counts, so an upgrade does not re-review every open PR.
const reqKey = (pr) => require('node:crypto').createHash('sha1').update(`${pr?.title || ''}\n${pr?.body || ''}`.replace(/\r\n/g, '\n').trim()).digest('hex').slice(0, 12);
const sticky = (c, sha, actor, req) => !!c && ours(c.user, actor) && typeof c.body === 'string'
  && c.body.startsWith(SUMMARY) && c.body.includes(`<!-- specguard:head=${sha} -->`)
  && !(req && /<!-- specguard:req=\w+ -->/.test(c.body) && !c.body.includes(`<!-- specguard:req=${req} -->`));

// Returns the reason to skip, or '' to review.
function decide({ pr, comments = [], headSha, includeBots = false, force = false, actor = null }) {
  if (pr.state === 'closed') return 'PR is closed';
  const u = pr.user || {};
  if (!includeBots && (u.type === 'Bot' || /\[bot\]$/i.test(u.login || ''))) return `PR author ${u.login} is a bot (set include_bots: true to review bot PRs)`;
  const who = actor || recordedLogin(comments);
  if (!force && comments.some((c) => sticky(c, headSha, who, reqKey(pr)))) return `head ${String(headSha).slice(0, 7)} already has a SpecGuard summary (set force: true to rerun)`;
  return '';
}

if (require.main === module) {
  const env = process.env;
  const on = (v) => String(v).toLowerCase() === 'true';
  const gh = (args) => JSON.parse(execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000 }));
  let why = '';
  try {
    const pr = gh(['api', `repos/${env.GH_REPO}/pulls/${env.PR_NUMBER}`]);
    const comments = gh(['api', '--paginate', '--slurp', `repos/${env.GH_REPO}/issues/${env.PR_NUMBER}/comments?per_page=100`]).flat();
    let actor = null;
    try { actor = gh(['api', 'user']).login; } catch { /* GITHUB_TOKEN cannot read /user: github-actions[bot] */ }
    why = decide({ pr, comments, headSha: env.HEAD_SHA, includeBots: on(env.INCLUDE_BOTS), force: on(env.FORCE), actor });
  } catch (e) { console.log(`::warning::preflight could not read the PR (${String(e.message).split('\n')[0]}); reviewing`); }
  console.log(why ? `SpecGuard: skipping the run: ${why}` : 'SpecGuard: preflight passed');
  if (env.GITHUB_OUTPUT) fs.appendFileSync(env.GITHUB_OUTPUT, `skip=${why ? 'true' : 'false'}\n`);
}
module.exports = { decide, sticky, reqKey, ours, recordedLogin };
