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
      const entry = (r) => ({ state: (isCheck ? (r.status === 'completed' ? r.conclusion : 'pending') : r.state) || 'unknown', url: (isCheck ? r.html_url : r.target_url) || '', producer: isCheck ? r.app?.slug || 'unknown' : r.creator?.login || 'unknown', id: r.id });
      // Same producer rerunning: the latest result wins. Different producers sharing the name: which one is authoritative is unknown.
      const latest = new Map();
      for (const r of (isCheck ? runs : statuses).filter((r) => (isCheck ? r.name : r.context) === name).map(entry)) if (!(latest.get(r.producer)?.id > r.id)) latest.set(r.producer, r);
      if (!latest.size) return { name: key, state: 'not_found', url: '' };
      if (latest.size === 1) return { name: key, ...[...latest.values()][0] };
      const producers = [...latest.values()].sort((a, b) => b.id - a.id);
      return { name: key, state: 'ambiguous', url: '', producer: producers.map((p) => `${p.producer} #${p.id} ${p.state}`).join(', '), producers };
    });
    const states = checks.map((c) => c.state);
    const status = states.some((s) => ['failure', 'error', 'cancelled', 'timed_out', 'action_required', 'startup_failure'].includes(s)) ? 'failed'
      : states.includes('ambiguous') ? 'ambiguous' : states.includes('not_found') ? 'not_found' : states.includes('pending') ? 'pending'
        : states.every((s) => s === 'success') ? 'passed' : 'incomplete';
    const amb = checks.filter((c) => c.state === 'ambiguous').map((c) => c.name);
    return { status, ref, checks, ...(status === 'ambiguous' ? { reason: `More than one producer reports ${amb.join(', ')}; the standards check cannot be confirmed. Keep one producer per configured name.` } : {}) };
  } catch { return { status: 'unavailable', ref, checks: [], reason: 'Could not read configured checks/statuses. Verify token read permissions.' }; }
}

module.exports = { inspectChecks };
