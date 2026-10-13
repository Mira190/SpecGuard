// Manual runs (.github/workflows/specguard-run.yml) review a repository that is not the workflow's own, on a workflow_dispatch event:
// withTarget builds the github-script `context` post.js and audit-post.js expect; readOnly is the safety net for delivery=summary.
// Env: TARGET_REPO (owner/name), TARGET_PR, BASE_SHA, HEAD_SHA, TARGET_SHA (audit: the reviewed commit, for source links).

// A pull_request event with no overrides is returned untouched, so the normal flow is unchanged.
function withTarget(context, env = process.env) {
  const repo = /^([\w.-]+)\/([\w.-]+)$/.exec(env.TARGET_REPO || '');
  const pr = /^\d+$/.test(env.TARGET_PR || '') ? { number: Number(env.TARGET_PR), head: { sha: env.HEAD_SHA || '' }, base: { sha: env.BASE_SHA || '' } } : null;
  if (!repo && !pr) return context;
  return {
    ...context, serverUrl: context.serverUrl, // own properties only: `repo` is a getter on the prototype
    ...(repo && { repo: { owner: repo[1], repo: repo[2] }, sha: env.TARGET_SHA || '' }),
    payload: { ...context.payload, ...(pr && { pull_request: pr }) },
  };
}

// Reads pass, writes fail. ponytail: an allow-list by method-name prefix over github.rest and GraphQL queries without `mutation`; github.request is not wrapped (post.js does not use it).
const READS = /^(get|list|check|compare|search|download)/;
const refuse = () => Promise.reject(new Error('SpecGuard: delivery=summary, nothing is written to the repository'));
function readOnly(github) {
  const ns = (o) => new Proxy(o, { get: (t, k) => (typeof t[k] === 'function' && !READS.test(String(k)) ? refuse : t[k]) });
  const rest = new Proxy(github.rest, { get: (t, k) => (t[k] && typeof t[k] === 'object' ? ns(t[k]) : t[k]) });
  return new Proxy(github, {
    get: (t, k) => (k === 'rest' ? rest : k === 'graphql' ? (q, ...a) => (/\bmutation\b/i.test(String(q)) ? refuse() : t.graphql(q, ...a)) : t[k]),
  });
}

module.exports = { withTarget, readOnly };
