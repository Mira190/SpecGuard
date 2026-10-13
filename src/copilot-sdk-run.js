#!/usr/bin/env node
// Copilot SDK engine (spike): one session with read-only tools plus a `submit_review` tool whose parameters are the findings schema, so the
// result arrives as tool-call arguments instead of JSON in prose. The handler validates (the runtime does NOT enforce the schema, verified 2026-10)
// and rejects invalid calls so the model fixes them in-session; if the model ends without calling it, ONE follow-up message asks for the call.
// Env: CTX PROMPT_FILE (or PROMPT, small prompts) MODEL EFFORT AUTO_TIER MAX_CREDITS TIMEOUT (minutes, whole run) CHECK=audit (audit-post's validator). Writes in $CTX: findings.json,
// usage.json (the SDK's session.shutdown data: same shape as copilot --usage-output-file), engine-status (timeout|failed), engine-repair, engine-notes,
// engine-model.json (engine-model.js), sdk-run.json (what happened, for eval). Never throws past the script; always exits 0.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const SUBMIT = 'submit_review';
const READ_ONLY = ['view', 'glob', 'grep'];
const DESCRIPTION = 'Submit the finished review. Call this exactly once with the complete result object; it is your final answer, so do not print the JSON as text. If the call is rejected, fix the named problem and call again with the whole corrected object.';
const FOLLOW_UP = `You ended without calling ${SUBMIT}. Call ${SUBMIT} now with the complete review object. Do not investigate again and do not print the JSON as text.`;

// The CLI prompt asks for "JSON only" as the final answer; here the answer is a tool call. Handles both prompt variants of src/prompt.js.
function adaptPrompt(p) {
  return String(p)
    .replace(/\n\nYour final answer must be JSON only, matching this schema: [^\n]*/, `\n\nDeliver your final answer by calling the \`${SUBMIT}\` tool once; its parameters are the result schema.`)
    .replace('Your final answer must be the JSON object of the structured-output tool, whose schema is enforced there.', `Deliver your final answer by calling the \`${SUBMIT}\` tool once; its parameters are the result schema.`)
    .replace(/Reminder: output only the JSON object matching the schema\./g, `Reminder: call \`${SUBMIT}\` with the complete object; do not print it.`);
}

// The submit tool. check(obj) -> { ok, error }; write(obj) stores the latest arguments; after maxRejects rejections the last object is accepted
// anyway so post.js (which degrades per row and reports) decides, instead of the run looping.
function makeSubmit({ schema, check, write, maxRejects = 2 }) {
  const state = { calls: [], accepted: false, valid: false };
  let release; const done = new Promise((r) => { release = r; });
  const tool = {
    name: SUBMIT, description: DESCRIPTION, parameters: schema, skipPermission: true, defer: 'never', isTerminal: true,
    handler: async (args) => {
      let v;
      try { v = args && typeof args === 'object' && !Array.isArray(args) ? check(args) : { ok: false, error: 'arguments must be one JSON object' }; } catch (e) { v = { ok: false, error: String(e.message || e) }; }
      state.calls.push({ ok: !!v.ok, error: v.ok ? undefined : String(v.error).slice(0, 300) });
      try { write(args); } catch { /* ctx not writable: the run reports no findings */ }
      if (v.ok || state.calls.length > maxRejects) { state.accepted = true; state.valid = !!v.ok; release(); return v.ok ? 'Review recorded.' : { resultType: 'failure', textResultForLlm: 'Recorded with problems.', error: String(v.error) }; }
      const msg = `Rejected: ${String(v.error).slice(0, 500)}. Call ${SUBMIT} again with the complete corrected object.`;
      return { resultType: 'failure', textResultForLlm: msg, error: msg };
    },
  };
  return { tool, state, done };
}

// Reads only, and only inside the repo checkout or the context directory. Everything else (shell, write, url, mcp, memory...) is refused.
function permissionHandler(roots) {
  const inside = (p) => roots.some((r) => { const rel = path.relative(r, path.resolve(r, String(p))); return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel)); });
  return (req) => (req && req.kind === 'read' && inside(req.path) ? { kind: 'approve-once' } : req && req.kind === 'custom-tool' && req.skipPermission ? { kind: 'approve-once' } : { kind: 'reject' });
}

const bounded = (p, ms) => { let t; return Promise.race([Promise.resolve(p).catch(() => {}), new Promise((r) => { t = setTimeout(r, ms); })]).finally(() => clearTimeout(t)); };

// ponytail: the checkout may not have the SDK locally; the action installs it globally, so fall back to the global root. Ceiling: a custom prefix.
function loadSdk() {
  try { return require('@github/copilot-sdk'); } catch { /* not local */ }
  return require(path.join(execFileSync('npm', ['root', '-g'], { encoding: 'utf8', shell: process.platform === 'win32' }).trim(), '@github/copilot-sdk'));
}

async function run({ sdk, env = process.env, check, now = Date.now, cwd = process.cwd(), budgetMs }) {
  const ctx = env.CTX;
  const put = (n, v) => { try { fs.writeFileSync(path.join(ctx, n), typeof v === 'string' ? v : JSON.stringify(v, null, 2) + '\n'); } catch { /* ignore */ } };
  const notes = [];
  const t0 = now(), budget = budgetMs || (parseInt(env.TIMEOUT, 10) || 12) * 60000, left = () => Math.max(1000, budget - (now() - t0));
  const schemaFile = env.SCHEMA_FILE || path.join(__dirname, env.CHECK === 'audit' ? 'audit.schema.json' : 'findings.schema.json');
  const log = { submits: [], followups: 0, status: 'ok' };
  let client, session, timer, model = '', usage = null, err = '';
  try {
    const schema = JSON.parse(fs.readFileSync(schemaFile, 'utf8'));
    delete schema.$schema; // draft-07 marker; the runtime takes plain JSON Schema
    const submit = makeSubmit({ schema, check, write: (o) => put('findings.json', JSON.stringify(o)) });
    const sid = require('node:crypto').randomUUID();
    const runtimeEnv = { ...env }; delete runtimeEnv.GH_TOKEN; // precedence is COPILOT_GITHUB_TOKEN > GH_TOKEN > GITHUB_TOKEN: a job-level GH_TOKEN would hijack the auth
    if (!runtimeEnv.COPILOT_GITHUB_TOKEN) delete runtimeEnv.COPILOT_GITHUB_TOKEN;
    client = new sdk.CopilotClient({ logLevel: 'error', env: runtimeEnv });
    await client.start();
    const base = {
      sessionId: sid, tools: [submit.tool], workingDirectory: cwd, onPermissionRequest: permissionHandler([cwd, ctx]),
      availableTools: sdk.ToolSet ? new sdk.ToolSet().addBuiltIn(READ_ONLY).addCustom(SUBMIT) : [...READ_ONLY, SUBMIT],
      sessionLimits: { maxAiCredits: parseInt(env.MAX_CREDITS, 10) || 60 },
    };
    const wanted = env.MODEL || 'auto', auto = wanted === 'auto';
    const tier = env.AUTO_TIER === undefined ? 'intelligence' : env.AUTO_TIER;
    const cfg = { ...base, model: wanted, ...(auto && tier ? { capi: { autoTier: tier } } : {}), ...(!auto && env.EFFORT ? { reasoningEffort: env.EFFORT } : {}) };
    try { session = await client.createSession(cfg); } catch (e) { // old runtime or strict policy: once more without the router profile, then on auto
      const { capi, ...noTier } = cfg;
      try { session = await client.createSession(noTier); notes.push('auto_tier ignored'); } catch (e2) {
        if (auto) throw e2;
        session = await client.createSession({ ...base, model: 'auto' }); notes.push(`model_fallback: ${wanted} → auto`);
      }
    }
    if (auto && env.EFFORT) notes.push('effort ignored: model auto');
    session.on('session.shutdown', (e) => { usage = e.data; });
    session.on('assistant.usage', (e) => { if (e?.data?.model) model = e.data.model; });
    session.on('tool.execution_start', (e) => { if (e?.data?.model) model = e.data.model; });

    const deadline = new Promise((r) => { timer = setTimeout(() => r('timeout'), budget); });
    const turn = (prompt) => Promise.race([
      Promise.resolve().then(() => session.sendAndWait({ prompt }, left())).then(() => 'idle', (e) => { err = String(e?.message || e); return /time/i.test(err) ? 'timeout' : 'error'; }),
      submit.done.then(() => 'accepted'), deadline,
    ]);
    let r = await turn(adaptPrompt(env.PROMPT_FILE ? fs.readFileSync(env.PROMPT_FILE, 'utf8') : env.PROMPT || '')); // a file: the prompt can exceed one environment variable (128 KiB on Linux)
    if (r === 'idle' && !submit.state.accepted) { log.followups = 1; r = await turn(FOLLOW_UP); }
    if (r === 'timeout') log.status = 'timeout'; else if (r === 'error') log.status = 'failed';
    log.submits = submit.state.calls;
    const first = submit.state.calls[0];
    if (log.followups || submit.state.calls.length > 1 || (first && !first.ok)) put('engine-repair', submit.state.valid ? 'repaired' : 'repair_failed');
    if (!submit.state.accepted && log.status === 'ok') { log.status = 'no_submit'; notes.push(`model never called ${SUBMIT}`); }
  } catch (e) {
    err = String(e?.message || e); log.status = /time/i.test(err) ? 'timeout' : 'failed';
  } finally {
    clearTimeout(timer);
    await bounded(session?.disconnect(), 8000); // disconnecting emits session.shutdown: the usage totals
    await bounded(client?.stop(), 5000);
    await bounded(client?.forceStop(), 2000);
  }
  if (log.status === 'timeout' || log.status === 'failed') {
    console.log(`::warning::Copilot SDK review ${log.status === 'timeout' ? 'timed out' : 'failed'}${err ? `: ${err.slice(0, 200)}` : ''} (needs 'permissions: copilot-requests: write' or a copilot_token)`);
    put('engine-status', log.status);
  }
  if (usage || model) { // same shape as the CLI's usage file; minimal when the shutdown event never arrived
    put('usage.json', { ...(usage || {}), currentModel: usage?.currentModel || model });
    try { require('./engine-model').run({ ctx, sid: session?.sessionId, requested: env.MODEL || '', turn: 'main', usage: path.join(ctx, 'usage.json') }); } catch { /* never fails the step */ }
  }
  put('engine-notes', ['engine: sdk', ...notes].join('\n') + '\n');
  log.ms = now() - t0; log.model = usage?.currentModel || model;
  put('sdk-run.json', log);
  return log;
}

if (require.main === module) {
  (async () => {
    try {
      const audit = process.env.CHECK === 'audit';
      const { validate } = require(audit ? './audit-post' : './post');
      const log = await run({ sdk: loadSdk(), check: (o) => { const v = validate(o); return v.ok ? { ok: true } : { ok: false, error: v.error }; } });
      console.log(`copilot-sdk-run: ${log.status} in ${Math.round(log.ms / 1000)}s, submits ${JSON.stringify(log.submits.map((s) => s.ok))}, follow-ups ${log.followups}`);
    } catch (e) {
      console.log(`::warning::Copilot SDK review failed: ${String(e?.message || e).slice(0, 200)}`);
      try { fs.writeFileSync(path.join(process.env.CTX, 'engine-status'), 'failed'); } catch { /* ignore */ }
    }
    process.exit(0); // the runtime child process must not keep the step alive
  })();
}
module.exports = { adaptPrompt, makeSubmit, permissionHandler, run, SUBMIT, FOLLOW_UP };
