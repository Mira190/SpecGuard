#!/usr/bin/env node
// Runs right before the engine: a push that landed while collecting context makes this run stale, so skip the model call (no credits spent).
// Fails open: when GitHub cannot be read, the review runs.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');

const defaultGh = (args) => JSON.parse(execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000 }));

// Returns { superseded, why, warning }; gh is injectable for tests.
function check({ repo, pr, headSha, gh = defaultGh }) {
  try {
    const p = gh(['api', `repos/${repo}/pulls/${pr}`]);
    if (p.state === 'closed') return { superseded: true, why: 'the PR was closed' };
    const live = p.head && p.head.sha;
    if (live && headSha && live !== headSha) return { superseded: true, why: `head moved to ${live.slice(0, 7)}` };
    return { superseded: false };
  } catch (e) { return { superseded: false, warning: `could not re-read the PR (${String(e.message).split('\n')[0]}); reviewing` }; }
}

if (require.main === module) {
  const env = process.env;
  const r = check({ repo: env.GH_REPO, pr: env.PR_NUMBER, headSha: env.HEAD_SHA });
  if (r.warning) console.log(`::warning::superseded check: ${r.warning}`);
  if (r.superseded) {
    console.log(`SpecGuard: skipping the review: ${r.why}`);
    if (env.GITHUB_STEP_SUMMARY) fs.appendFileSync(env.GITHUB_STEP_SUMMARY, 'Skipped: a newer commit was pushed while collecting context (no AI credits spent).\n');
  }
  if (env.GITHUB_OUTPUT) fs.appendFileSync(env.GITHUB_OUTPUT, `superseded=${r.superseded}\n`);
}
module.exports = { check };
