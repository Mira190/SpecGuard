#!/usr/bin/env node
// Manual-run guard (resolve job, before any checkout of the target): results of a scan (scan issue, run summary, artifact) are written into THIS repository,
// so a non-public target needs a non-public control repository. Env: CONTROL_REPO, TARGET_REPO, CONTROL_TOKEN (job token), TARGET_TOKEN (the token that reads the target).
// Fails closed: a visibility that cannot be read blocks the run.
const { execFileSync } = require('node:child_process');

const known = (v) => ['public', 'private', 'internal'].includes(v);
// -> { ok, reason }; control/target = 'public' | 'private' | 'internal' | anything else (unknown)
function decide(control, target) {
  if (!known(control)) return { ok: false, reason: `cannot determine the visibility of the control repository (${control || 'no answer'})` };
  if (!known(target)) return { ok: false, reason: `cannot determine the visibility of the target repository (${target || 'no answer'}); the token may not reach it` };
  if (target !== 'public' && control === 'public') return { ok: false, reason: 'the target repository is not public but this control repository is public: the scan state, run summary and result artifact quote the target code here, where anyone can read it. Run SpecGuard from a private or internal control repository' };
  return { ok: true, reason: '' };
}

const visibility = (repo, token) => {
  try { return execFileSync('gh', ['api', `repos/${repo}`, '--jq', '.visibility'], { encoding: 'utf8', env: { ...process.env, GH_TOKEN: token }, stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; }
};

if (require.main === module) {
  const { CONTROL_REPO, TARGET_REPO, CONTROL_TOKEN, TARGET_TOKEN } = process.env;
  const r = decide(visibility(CONTROL_REPO, CONTROL_TOKEN), visibility(TARGET_REPO, TARGET_TOKEN));
  if (!r.ok) { console.log(`::error::${r.reason.replace(/\n/g, ' ')}`); process.exit(1); }
}
module.exports = { decide };
