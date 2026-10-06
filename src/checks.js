// Only explicitly named checks count. No model judgement, regex guessing or polling.
async function inspectChecks({ github, owner, repo, ref, names }) {
  const expected = [...new Set(String(names || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean))];
  if (!expected.length) return { status: 'not_configured', ref, checks: [] };
  if (expected.some((s) => !/^(check|status):\S.*$/.test(s))) return { status: 'unavailable', ref, checks: [], reason: 'Use check:NAME or status:CONTEXT, one per line.' };
  try {
    const [runs, statuses] = await Promise.all([
      expected.some((s) => s.startsWith('check:')) ? github.paginate(github.rest.checks.listForRef, { owner, repo, ref, filter: 'latest', per_page: 100 }) : [],
      expected.some((s) => s.startsWith('status:')) ? github.paginate(github.rest.repos.listCommitStatusesForRef, { owner, repo, ref, per_page: 100 }) : [],
    ]);
    const checks = expected.map((key) => {
      const isCheck = key.startsWith('check:');
      const name = key.slice(key.indexOf(':') + 1);
      const matches = (isCheck ? runs : statuses).filter((r) => (isCheck ? r.name : r.context) === name);
      const r = matches.sort((a, b) => b.id - a.id)[0];
      if (!r) return { name: key, state: 'not_found', url: '' };
      const state = isCheck ? (r.status === 'completed' ? r.conclusion : 'pending') : r.state;
      return { name: key, state: state || 'unknown', url: (isCheck ? r.html_url : r.target_url) || '', producer: isCheck ? r.app?.slug || 'unknown' : r.creator?.login || 'unknown', id: r.id };
    });
    const states = checks.map((c) => c.state);
    const status = states.some((s) => ['failure', 'error', 'cancelled', 'timed_out', 'action_required', 'startup_failure'].includes(s)) ? 'failed'
      : states.includes('not_found') ? 'not_found' : states.includes('pending') ? 'pending'
        : states.every((s) => s === 'success') ? 'passed' : 'incomplete';
    return { status, ref, checks };
  } catch { return { status: 'unavailable', ref, checks: [], reason: 'Could not read configured checks/statuses. Verify token read permissions.' }; }
}

module.exports = { inspectChecks };
