#!/usr/bin/env node
// Step 0: deterministic skip decision before any model tokens are spent. Fails open: when GitHub cannot be read, the review runs.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');

// Our own comment author: a Bot whose login is the authenticated actor, else github-actions[bot] (what GITHUB_TOKEN posts as).
// REST gives user.type, GraphQL author.__typename (with a login lacking the [bot] suffix). Shared by preflight, comment dedup and stale-thread resolve.
const bare = (s) => String(s).replace(/\[bot\]$/i, '').toLowerCase();
const ours = (u, actor) => !!u && (u.type || u.__typename) === 'Bot' && typeof u.login === 'string' && bare(u.login) === bare(actor || 'github-actions[bot]');

// Our own sticky summary (our comment that starts with the marker) that records this head SHA. The SHA marker is
// absent from "could not complete" and incomplete summaries, so those runs are retried.
const sticky = (c, sha, actor) => !!c && ours(c.user, actor) && typeof c.body === 'string'
  && c.body.startsWith('<!-- specguard:summary -->') && c.body.includes(`<!-- specguard:head=${sha} -->`);

// Returns the reason to skip, or '' to review.
function decide({ pr, comments = [], headSha, includeBots = false, force = false, actor = null }) {
  if (pr.state === 'closed') return 'PR is closed';
  const u = pr.user || {};
  if (!includeBots && (u.type === 'Bot' || /\[bot\]$/i.test(u.login || ''))) return `PR author ${u.login} is a bot (set include_bots: true to review bot PRs)`;
  if (!force && comments.some((c) => sticky(c, headSha, actor))) return `head ${String(headSha).slice(0, 7)} already has a SpecGuard summary (set force: true to rerun)`;
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
module.exports = { decide, sticky, ours };
