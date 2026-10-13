const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { adaptPrompt, makeSubmit, permissionHandler, run, SUBMIT, FOLLOW_UP } = require('./copilot-sdk-run.js');

const GOOD = { requirements_source: 'none', coverage: [], findings: [], not_reviewed: [], standards: {}, layering: {}, requirements: [] };
const BAD = { findings: [] };
const check = (o) => (Array.isArray(o.coverage) ? { ok: true } : { ok: false, error: 'coverage must be an array' });

// A mock SDK: `script(n, call, prompt)` plays the model for message number n; call(args) invokes the registered submit_review handler and returns its result.
function mock(t, script, { createFails = false } = {}) {
  const ctx = fs.mkdtempSync(path.join(os.tmpdir(), 'specguard-sdk-'));
  t.after(() => fs.rmSync(ctx, { recursive: true, force: true }));
  const seen = { prompts: [], configs: [], disconnected: false };
  class CopilotClient {
    async start() {}
    async stop() {}
    async forceStop() {}
    async createSession(cfg) {
      seen.configs.push(cfg);
      if (createFails) throw new Error('boom');
      const handlers = {};
      const tool = cfg.tools[0];
      return {
        sessionId: cfg.sessionId,
        on: (ev, fn) => { handlers[ev] = fn; },
        async sendAndWait({ prompt }) {
          seen.prompts.push(prompt);
          await script(seen.prompts.length, (args) => tool.handler(args, {}), prompt);
        },
        async disconnect() { seen.disconnected = true; handlers['session.shutdown']?.({ data: { currentModel: 'mock-model', totalNanoAiu: 5e9, modelMetrics: {} } }); },
      };
    }
  }
  const go = (extra = {}) => run({ sdk: { CopilotClient }, env: { CTX: ctx, PROMPT: 'REVIEW', MODEL: 'auto', ...extra.env }, check, cwd: ctx, budgetMs: extra.budgetMs });
  const file = (n) => { try { return fs.readFileSync(path.join(ctx, n), 'utf8').trim(); } catch { return null; } };
  return { go, seen, file, ctx };
}

test('valid first call: findings written, no repair note, usage kept in the CLI shape', async (t) => {
  const m = mock(t, async (n, call) => { assert.equal(await call(GOOD), 'Review recorded.'); });
  const log = await m.go();
  assert.equal(log.status, 'ok');
  assert.deepEqual(JSON.parse(m.file('findings.json')), GOOD);
  assert.equal(m.file('engine-repair'), null);
  assert.equal(m.file('engine-status'), null);
  assert.equal(m.seen.prompts.length, 1);
  assert.equal(JSON.parse(m.file('usage.json')).totalNanoAiu, 5e9);
  assert.equal(JSON.parse(m.file('usage.json')).currentModel, 'mock-model');
  assert.match(m.file('engine-notes'), /engine: sdk/);
});

test('session is read-only: only view/glob/grep plus submit_review, the credit cap is passed, GH_TOKEN is not', async (t) => {
  const m = mock(t, async (n, call) => { await call(GOOD); });
  await m.go({ env: { MAX_CREDITS: '90', GH_TOKEN: 'x', COPILOT_GITHUB_TOKEN: '' } });
  const cfg = m.seen.configs[0];
  assert.equal(cfg.model, 'auto');
  assert.deepEqual(cfg.capi, { autoTier: 'intelligence' });
  assert.deepEqual(cfg.sessionLimits, { maxAiCredits: 90 });
  assert.equal(cfg.tools[0].name, SUBMIT);
  assert.equal(cfg.tools[0].parameters.$schema, undefined);
  assert.equal(cfg.tools[0].isTerminal, true);
  assert.deepEqual(cfg.availableTools, ['view', 'glob', 'grep', SUBMIT]);
});

test('rejected call: the model gets the problem back, a later valid call counts as repaired', async (t) => {
  let first;
  const m = mock(t, async (n, call) => { first = await call(BAD); assert.equal(first.resultType, 'failure'); assert.match(first.textResultForLlm, /coverage must be an array/); assert.equal(await call(GOOD), 'Review recorded.'); });
  const log = await m.go();
  assert.deepEqual(log.submits.map((s) => s.ok), [false, true]);
  assert.equal(m.file('engine-repair'), 'repaired');
  assert.deepEqual(JSON.parse(m.file('findings.json')), GOOD);
});

test('three invalid calls: the last object is kept for post.js and the repair is reported failed', async (t) => {
  const m = mock(t, async (n, call) => { for (let i = 0; i < 5; i++) await call({ ...BAD, i }); });
  const log = await m.go();
  assert.equal(log.submits.length, 5); // the mock keeps calling; the real run stops at acceptance (done wins the race)
  assert.equal(m.file('engine-repair'), 'repair_failed');
  assert.equal(JSON.parse(m.file('findings.json')).i, 4);
});

test('model ends without the tool: exactly one follow-up, then a valid call is a repair', async (t) => {
  const m = mock(t, async (n, call) => { if (n === 2) await call(GOOD); });
  const log = await m.go();
  assert.equal(log.followups, 1);
  assert.equal(m.seen.prompts[1], FOLLOW_UP);
  assert.equal(m.file('engine-repair'), 'repaired');
  assert.deepEqual(JSON.parse(m.file('findings.json')), GOOD);
});

test('model never calls the tool: one follow-up only, no findings, repair_failed, not an engine failure', async (t) => {
  const m = mock(t, async () => {});
  const log = await m.go();
  assert.equal(m.seen.prompts.length, 2);
  assert.equal(log.status, 'no_submit');
  assert.equal(m.file('findings.json'), null);
  assert.equal(m.file('engine-repair'), 'repair_failed');
  assert.equal(m.file('engine-status'), null);
});

test('hung model: the hard limit writes engine-status timeout and the run still returns', async (t) => {
  const m = mock(t, () => new Promise(() => {}));
  const log = await m.go({ budgetMs: 150 });
  assert.equal(log.status, 'timeout');
  assert.equal(m.file('engine-status'), 'timeout');
  assert.equal(m.seen.disconnected, true);
});

test('SDK failure never throws: engine-status failed', async (t) => {
  const m = mock(t, async () => {}, { createFails: true });
  const log = await m.go();
  assert.equal(log.status, 'failed');
  assert.equal(m.file('engine-status'), 'failed');
  assert.equal(m.seen.configs.length, 2); // retried once without the router profile; auto has no further fallback
});

test('prompt: the "JSON only" instruction becomes a tool call, both prompt variants', () => {
  const copilot = 'skill\n\nYour final answer must be JSON only, matching this schema: {"type":"object"}\n\nexample\n\nReminder: output only the JSON object matching the schema.\n';
  const out = adaptPrompt(copilot);
  assert.doesNotMatch(out, /JSON only|output only the JSON/);
  assert.match(out, /submit_review/);
  assert.match(out, /example/);
  const claude = adaptPrompt('x\n\nYour final answer must be the JSON object of the structured-output tool, whose schema is enforced there.');
  assert.match(claude, /submit_review/);
});

test('permissions: reads inside the checkout or ctx, the submit tool; nothing else', () => {
  const root = path.resolve(os.tmpdir(), 'repo'), ctx = path.resolve(os.tmpdir(), 'ctx');
  const h = permissionHandler([root, ctx]);
  assert.equal(h({ kind: 'read', path: path.join(root, 'src', 'a.js') }).kind, 'approve-once');
  assert.equal(h({ kind: 'read', path: path.join(ctx, 'diff.patch') }).kind, 'approve-once');
  assert.equal(h({ kind: 'read', path: path.join(root, '..', 'secret') }).kind, 'reject');
  assert.equal(h({ kind: 'read', path: path.resolve(os.tmpdir(), 'repo-evil', 'x') }).kind, 'reject');
  for (const kind of ['shell', 'write', 'mcp', 'url', 'memory']) assert.equal(h({ kind, path: path.join(root, 'a') }).kind, 'reject');
  assert.equal(h({ kind: 'custom-tool', skipPermission: true }).kind, 'approve-once');
  assert.equal(h({ kind: 'custom-tool' }).kind, 'reject');
});

test('makeSubmit rejects non-objects without throwing', async () => {
  const { tool, state } = makeSubmit({ schema: {}, check, write: () => {} });
  const r = await tool.handler('{"coverage":[]}', {});
  assert.equal(r.resultType, 'failure');
  assert.equal(state.accepted, false);
});
