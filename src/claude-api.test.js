// The claude adapter's default mode: one Messages API call (src/engines/claude-api.js), tested with a mocked fetch. Never calls the network.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const api = require('./engines/claude-api.js');

const KEY = 'sk-ant-api03-TESTONLY_0123456789-abcdef'; // made up; must never reach a file, the log or an error message
const VALID = { requirements_source: '', coverage: [], findings: [], not_reviewed: '', standards: { status: 'no_rules', sources: [], reason: 'none' }, layering: { status: 'not_reviewed', reason: 'none' }, requirements: [] };
const STATIC = 'SKILL TEXT\n\nYour final answer must be JSON only';
const PROMPT = `${STATIC}\n\n---\n\nContext directory (absolute path): /ctx\nPER-PR CONTEXT\n`;
const bash = process.platform === 'win32' ? path.join(process.env.ProgramFiles, 'Git/bin/bash.exe') : 'bash';
const fwd = (p) => p.replace(/\\/g, '/');

const reply = (status, body, headers = {}) => ({ status, ok: status >= 200 && status < 300, headers: { get: (k) => headers[k.toLowerCase()] ?? null }, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
const good = (extra = {}) => reply(200, { type: 'message', model: 'claude-haiku-5-5', stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(VALID) }],
  usage: { input_tokens: 1000, cache_creation_input_tokens: 20000, cache_read_input_tokens: 0, output_tokens: 4000 }, ...extra });
const err = (status, type, message, headers) => reply(status, { type: 'error', error: { type, message } }, headers);

// answers = what fetch returns, in order (a function is called with the request); returns { go(envExtra), file, calls, slept, out }
function harness(t, answers, env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'specguard-api-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ctx = path.join(dir, 'ctx'), pf = path.join(dir, 'prompt.txt');
  fs.writeFileSync(pf, PROMPT);
  const calls = [], slept = [], logged = [];
  const fetchFn = async (url, init) => { calls.push({ url, init, body: JSON.parse(init.body) }); const a = answers[Math.min(calls.length - 1, answers.length - 1)]; return typeof a === 'function' ? a() : a; };
  const go = async (extra = {}) => {
    const log = console.log; console.log = (...a) => logged.push(a.join(' '));
    try { await api.run({ CTX: ctx, PROMPT_FILE: pf, ANTHROPIC_API_KEY: KEY, MODEL: 'claude-haiku-5-5', TIMEOUT: '5', ...env, ...extra }, { fetchFn, sleep: async (ms) => { slept.push(ms); } }); } finally { console.log = log; }
  };
  const file = (n) => { try { return fs.readFileSync(path.join(ctx, n), 'utf8').trim(); } catch { return null; } };
  const everything = () => [logged.join('\n'), ...(fs.existsSync(ctx) ? fs.readdirSync(ctx).map(file) : []), JSON.stringify(calls.map((c) => c.body))].join('\n');
  return { go, file, calls, slept, logged, everything, pf, ctx, dir };
}

test('success: one POST with key and version headers, cached static system block, user context, strict schema; findings.json, usage with an exact cost, engine-model', async (t) => {
  const h = harness(t, [good()]);
  await h.go();
  assert.equal(h.calls.length, 1);
  const { url, init, body } = h.calls[0];
  assert.equal(url, 'https://api.anthropic.com/v1/messages');
  assert.equal(init.method, 'POST');
  assert.equal(init.headers['x-api-key'], KEY);
  assert.equal(init.headers['anthropic-version'], '2023-06-01');
  assert.equal(init.headers['content-type'], 'application/json');
  assert.equal(body.model, 'claude-haiku-5-5');
  assert.equal(body.max_tokens, 16000);
  assert.deepEqual(body.system, [{ type: 'text', text: STATIC, cache_control: { type: 'ephemeral' } }]);
  assert.equal(body.messages.length, 1);
  assert.equal(body.messages[0].role, 'user');
  assert.match(body.messages[0].content, /no file tools[\s\S]*---\n\nContext directory[\s\S]*PER-PR CONTEXT/);
  assert.ok(!body.tools, 'no tools: nothing to loop');
  assert.equal(body.output_config.format.type, 'json_schema');
  assert.ok('findings' in body.output_config.format.schema.properties);
  assert.deepEqual(JSON.parse(h.file('findings.json')), VALID);
  assert.ok([null, 'success'].includes(h.file('engine-status')));
  assert.equal(h.file('engine-notes'), '');
  const u = JSON.parse(h.file('usage.json'));
  assert.equal(u.currentModel, 'claude-haiku-5-5');
  assert.ok(Math.abs(u.totalCostUsd - (1000 * 0.1 + 20000 * 0.1 * 1.25 + 4000 * 0.5) / 1e6) < 1e-12, String(u.totalCostUsd));
  assert.deepEqual(u.modelMetrics['claude-haiku-5-5'].usage, { inputTokens: 21000, cacheReadTokens: 0, cacheWriteTokens: 20000, outputTokens: 4000 });
  assert.deepEqual(u.tokenDetails, { input: { tokenCount: 1000 }, cache_read: { tokenCount: 0 }, cache_write: { tokenCount: 20000 }, output: { tokenCount: 4000 } });
  const em = JSON.parse(h.file('engine-model.json'));
  assert.deepEqual(em.used, ['claude-haiku-5-5']);
  assert.equal(em.tier, 'fast');
  assert.ok(!h.everything().replace(JSON.stringify(init.headers), '').includes(KEY));
});

test('the usage file feeds the summary usage line (cost without the copilot approximation)', async (t) => {
  const h = harness(t, [good()]);
  await h.go();
  const line = require('./post.js').usageLine({ engine: 'claude', model: 'claude-haiku-5-5', raw: JSON.parse(h.file('usage.json')), used: ['claude-haiku-5-5'] });
  assert.match(line, /Model: claude-haiku-5-5/);
  assert.match(line, /21\.0k in \(0 cached\)|21\.0k in/);
  assert.match(line, /Cost \$0\.0(?!.*≈)/);
});

test('the scan uses the audit schema; an empty model means claude-haiku-5-5; effort is ignored with a note; max_output_tokens is honoured', async (t) => {
  const h = harness(t, [good({ content: [{ type: 'text', text: JSON.stringify({ docs_reviewed: [], requirements: [], not_requirements: [], not_reviewed: [] }) }] })]);
  await h.go({ CHECK: 'audit', MODEL: '', EFFORT: 'high', MAX_OUTPUT_TOKENS: '9000' });
  const b = h.calls[0].body;
  assert.equal(b.model, 'claude-haiku-5-5');
  assert.equal(b.max_tokens, 9000);
  assert.ok('docs_reviewed' in b.output_config.format.schema.properties && !('findings' in b.output_config.format.schema.properties));
  assert.equal(h.file('engine-notes'), 'effort ignored: claude engine');
  assert.ok(!/effort/.test(JSON.stringify(b)));
});

test('schema transform: every object closed, no bounds or if/then, optional fields and enums kept; the repository schemas stay untouched', () => {
  for (const name of ['findings.schema.json', 'audit.schema.json']) {
    const src = fs.readFileSync(path.join(__dirname, name), 'utf8'), s = api.strict(JSON.parse(src));
    const text = JSON.stringify(s);
    for (const k of ['minLength', 'maxLength', 'minimum', 'maximum', 'uniqueItems', '"if"', '"then"', '$schema']) assert.ok(!text.includes(k), `${name} ${k}`);
    const objects = []; (function walk(n) { if (Array.isArray(n)) n.forEach(walk); else if (n && typeof n === 'object') { if (n.type === 'object') objects.push(n); Object.values(n).forEach(walk); } })(s);
    assert.ok(objects.length > 3);
    for (const o of objects) assert.equal(o.additionalProperties, false);
    assert.equal(fs.readFileSync(path.join(__dirname, name), 'utf8'), src);
  }
  const f = api.strict(JSON.parse(fs.readFileSync(path.join(__dirname, 'findings.schema.json'), 'utf8')));
  assert.deepEqual(f.properties.findings.items.properties.kind.enum, ['missing_test', 'weak_test', 'standard', 'pushdown', 'spec_mismatch']);
  assert.ok(f.properties.findings.items.properties.start_line, 'optional property kept');
  assert.ok(!f.properties.findings.items.required.includes('start_line'));
  assert.deepEqual(api.strict({ type: 'object', properties: { minimum: { type: 'integer', minimum: 1 } } }), { type: 'object', properties: { minimum: { type: 'integer' } }, additionalProperties: false }, 'a property NAMED like a keyword survives');
});

test('the prompt is split where prompt.js separates the static prefix from the per-PR context; no separator = everything is the user message', () => {
  const m = api.messages(PROMPT);
  assert.equal(m.system, STATIC);
  assert.ok(m.user.endsWith(PROMPT.slice(PROMPT.indexOf('---'))));
  const whole = api.messages('just a prompt');
  assert.equal(whole.system, '');
  assert.ok(whole.user.endsWith('just a prompt'));
});

test('a real prompt from src/prompt.js splits into a static system part and the context', () => {
  const root = path.join(__dirname, '..');
  const r = spawnSync(process.execPath, [path.join(__dirname, 'prompt.js'), '--skill', path.join(root, 'skills/test-review'), '--ctx', os.tmpdir(), '--schema', path.join(__dirname, 'findings.schema.json')], { encoding: 'utf8', maxBuffer: 1 << 26 });
  assert.equal(r.status, 0, r.stderr);
  const m = api.messages(r.stdout);
  assert.ok(m.system.length > 1000 && !m.system.includes('Context directory (absolute path)'));
  assert.match(m.user, /Context directory \(absolute path\)/);
});

test('cost: cache read 0.1x, write 1.25x, the long-prompt card of haiku 5.5, an unknown model priced high', () => {
  assert.ok(Math.abs(api.cost('claude-haiku-5-5', { input_tokens: 100000 }) - 0.01) < 1e-9);
  assert.ok(Math.abs(api.cost('claude-haiku-5-5', { input_tokens: 10, cache_read_input_tokens: 90000 }) - (10 * 0.1 + 90000 * 0.01) / 1e6) < 1e-9);
  assert.ok(Math.abs(api.cost('claude-haiku-5-5', { input_tokens: 200000, output_tokens: 1e6 }) - (200000 * 0.5 + 1e6 * 2.5) / 1e6) < 1e-9, 'above 100K prompt tokens the second card applies');
  assert.ok(Math.abs(api.cost('claude-haiku-5-5', { cache_creation_input_tokens: 10000 }) - (10000 * 0.1 * 1.25) / 1e6) < 1e-12);
  assert.ok(Math.abs(api.cost('claude-opus-5-5', { input_tokens: 1e6, output_tokens: 1e6 }) - 24) < 1e-9);
  assert.ok(api.cost('claude-future-9', { input_tokens: 1e6 }) >= 5 - 1e-9);
});

test('a typical PR review on haiku 5.5 costs well under a cent and a half; the worst case stays under the default budget', () => {
  const sys = 30 * 1024, user = 100 * 1024; // the largest prompt is about 128 KiB
  const w = api.worstCase('claude-haiku-5-5', sys, user, 16000);
  assert.ok(w.usd < 0.03 && w.usd < 1, String(w.usd));
  const typical = api.cost('claude-haiku-5-5', { input_tokens: 15000, cache_creation_input_tokens: 8000, output_tokens: 6000 });
  assert.ok(typical > 0.003 && typical < 0.015, String(typical));
});

test('pre-flight: a worst case above max_budget_usd makes NO call, status failed, reason budget, a message with both numbers; a larger budget passes', async (t) => {
  const h = harness(t, [good()]);
  await h.go({ MODEL: 'claude-opus-5-5', MAX_BUDGET_USD: '0.05' }); // 16000 x $20/M alone is $0.32
  assert.equal(h.calls.length, 0, 'nothing was sent');
  assert.equal(h.file('engine-status'), 'failed');
  const [reason, why] = h.file('engine-error').split('\n');
  assert.equal(reason, 'budget');
  assert.match(why, /^estimated worst-case cost \$0\.\d+ exceeds max_budget_usd \$0\.05/);
  assert.match(h.file('engine-notes'), /^estimated worst-case cost/);
  assert.match(h.logged.join('\n'), /::warning::Claude review failed: estimated worst-case cost/);
  assert.equal(h.file('findings.json'), null);
  const ok = harness(t, [good()]);
  await ok.go({ MODEL: 'claude-opus-5-5', MAX_BUDGET_USD: '1.00' });
  assert.equal(ok.calls.length, 1);
  const out = harness(t, [good()]); // a lower max_output_tokens lowers the bound
  await out.go({ MODEL: 'claude-opus-5-5', MAX_BUDGET_USD: '0.05', MAX_OUTPUT_TOKENS: '1000' });
  assert.equal(out.calls.length, 1);
});

test('401: auth, status failed, no retry, the key is not in any file or log even when the API echoes it', async (t) => {
  const h = harness(t, [err(401, 'authentication_error', `invalid x-api-key ${KEY} Authorization: Bearer ${KEY}`)]);
  await h.go();
  assert.equal(h.calls.length, 1);
  assert.equal(h.file('engine-status'), 'failed');
  assert.equal(h.file('engine-error').split('\n')[0], 'auth');
  assert.match(h.file('engine-notes'), /Anthropic API key was rejected/);
  assert.match(h.file('engine-notes'), /\*\*\*/);
  assert.match(h.logged.join('\n'), /::warning::Claude review failed: The Anthropic API key was rejected/);
  const all = h.everything().replace(KEY, '');
  assert.ok(!all.includes(KEY) && !all.includes('TESTONLY'.concat('_0123')), 'no part of the key in any output');
  assert.ok(![h.file('engine-notes'), h.file('engine-error'), h.logged.join('\n')].join('\n').includes('TESTONLY'));
});

test('no key in the environment is an auth failure without a call', async (t) => {
  const h = harness(t, [good()]);
  await h.go({ ANTHROPIC_API_KEY: '' });
  assert.equal(h.calls.length, 0);
  assert.equal(h.file('engine-error').split('\n')[0], 'auth');
});

test('402 and the 400 "credit balance is too low": quota ("account has no credit"), told apart from the budget, never retried or sent plain', async (t) => {
  for (const a of [err(402, 'billing_error', 'Payment required'), err(400, 'invalid_request_error', 'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing.')]) {
    const h = harness(t, [a, good()]);
    await h.go();
    assert.equal(h.calls.length, 1);
    assert.equal(h.file('engine-status'), 'failed');
    const [reason, why] = h.file('engine-error').split('\n');
    assert.equal(reason, 'quota');
    assert.match(why, /account has no credit.*not the per-run budget/);
  }
});

test('429 then success: one retry after retry-after, no failure; two 429 in a row is rate; 529 and 500 retry once too', async (t) => {
  const a = harness(t, [err(429, 'rate_limit_error', 'slow down', { 'retry-after': '3' }), good()]);
  await a.go();
  assert.equal(a.calls.length, 2);
  assert.deepEqual(a.slept, [3000]);
  assert.deepEqual(JSON.parse(a.file('findings.json')), VALID);
  assert.ok([null, 'success'].includes(a.file('engine-status')));
  const b = harness(t, [err(429, 'rate_limit_error', 'slow down'), err(429, 'rate_limit_error', 'slow down'), good()]);
  await b.go();
  assert.equal(b.calls.length, 2, 'one retry only');
  assert.equal(b.file('engine-error').split('\n')[0], 'rate');
  assert.equal(b.file('engine-status'), 'failed');
  for (const st of [529, 500]) {
    const c = harness(t, [err(st, 'overloaded_error', 'busy'), good()]);
    await c.go();
    assert.equal(c.calls.length, 2, String(st));
    assert.ok([null, 'success'].includes(c.file('engine-status')));
  }
  const d = harness(t, [err(429, 'rate_limit_error', 'later', { 'retry-after': '600' }), good()]);
  await d.go();
  assert.equal(d.calls.length, 1, 'a retry-after beyond 30 seconds is not waited for');
  assert.equal(d.file('engine-error').split('\n')[0], 'rate');
});

test('unavailable model: model, naming the model; other 400s are failed with the API message in the note', async (t) => {
  const h = harness(t, [err(404, 'not_found_error', 'model: claude-nope')]);
  await h.go({ MODEL: 'claude-nope' });
  const [reason, why] = h.file('engine-error').split('\n');
  assert.equal(reason, 'model');
  assert.match(why, /model 'claude-nope' is not available to this API key/);
  assert.equal(h.file('engine-status'), 'failed');
  const o = harness(t, [err(400, 'invalid_request_error', 'messages: text content blocks must be non-empty')]);
  await o.go();
  assert.equal(o.file('engine-error'), null, 'unclassified: no reason');
  assert.equal(o.file('engine-status'), 'failed');
  assert.match(o.file('engine-notes'), /HTTP 400 invalid_request_error: messages: text content blocks must be non-empty/);
});

test('a refused output schema: ONE retry asking for plain JSON (no output_config), with a note; a plain answer is still extracted', async (t) => {
  const h = harness(t, [err(400, 'invalid_request_error', 'Schema is too complex for compilation.'), good({ content: [{ type: 'text', text: `Here you go:\n${JSON.stringify(VALID)}` }] })]);
  await h.go();
  assert.equal(h.calls.length, 2);
  assert.ok(h.calls[0].body.output_config && !h.calls[1].body.output_config);
  assert.deepEqual(JSON.parse(h.file('findings.json')), VALID);
  assert.match(h.file('engine-notes'), /structured output rejected \(Schema is too complex/);
  assert.ok([null, 'success'].includes(h.file('engine-status')));
});

test('max_tokens and refusal stops, an answer with no JSON, a timeout and a network error all end failed or timeout without throwing', async (t) => {
  const cut = harness(t, [good({ stop_reason: 'max_tokens', content: [{ type: 'text', text: '{"coverage": [' }] })]);
  await cut.go();
  assert.equal(cut.file('engine-status'), 'failed');
  assert.equal(cut.file('engine-error').split('\n')[0], 'length');
  assert.match(cut.file('engine-error'), /max_output_tokens \(16000\)/);
  assert.equal(cut.file('findings.json'), null);
  assert.ok(cut.file('usage.json'), 'the tokens were paid for: usage is kept');
  const ref = harness(t, [good({ stop_reason: 'refusal', content: [] })]);
  await ref.go();
  assert.equal(ref.file('engine-error').split('\n')[0], 'policy');
  const none = harness(t, [good({ content: [{ type: 'text', text: 'sorry, no' }] })]);
  await none.go();
  assert.equal(none.file('engine-status'), 'failed');
  assert.match(none.file('engine-notes'), /no JSON found in the engine output/);
  const slow = harness(t, [() => { const e = new Error('The operation was aborted due to timeout'); e.name = 'TimeoutError'; throw e; }]);
  await slow.go();
  assert.equal(slow.file('engine-status'), 'timeout');
  assert.match(slow.logged.join('\n'), /::warning::Claude review timed out/);
  const net = harness(t, [() => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }); }]);
  await net.go();
  assert.equal(net.calls.length, 2, 'one retry for a network error');
  assert.equal(net.file('engine-status'), 'failed');
  assert.match(net.file('engine-notes'), /ECONNRESET/);
});

test('an unknown model is priced at the high default card and the cost is noted as an estimate', async (t) => {
  const h = harness(t, [good({ model: 'claude-future-9' })]);
  await h.go({ MODEL: 'claude-future-9' });
  assert.match(h.file('engine-notes'), /cost estimated at default rates: claude-future-9 is not in the price table/);
  assert.ok(JSON.parse(h.file('usage.json')).totalCostUsd > 0.1);
});

// --- claude.sh dispatch: api (default) needs no CLI and no install; agent runs the CLI ---
function shell(t, { mode, withClaude = false, validate } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'specguard-apish-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'bin'), ctx = path.join(dir, 'ctx'), log = path.join(dir, 'fetch.log'), argv = path.join(dir, 'claude.log');
  fs.mkdirSync(bin); fs.mkdirSync(ctx);
  fs.writeFileSync(path.join(dir, 'prompt.txt'), PROMPT);
  // a preload that replaces global fetch: records the request, answers like the API
  fs.writeFileSync(path.join(dir, 'stub.js'), `const fs = require('node:fs'); globalThis.fetch = async (url, init) => { fs.appendFileSync(${JSON.stringify(fwd(log))}, JSON.stringify({ url, key: init.headers['x-api-key'], model: JSON.parse(init.body).model }) + '\\n'); return { status: 200, ok: true, headers: { get: () => null }, text: async () => ${JSON.stringify(JSON.stringify({ model: 'claude-haiku-5-5', stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(VALID) }], usage: { input_tokens: 10, output_tokens: 5 } }))} }; };`);
  if (withClaude) fs.writeFileSync(path.join(bin, 'claude'), `#!/usr/bin/env bash\n[ "$1" = --version ] && { echo "2.1.284 (Claude Code)"; exit 0; }\necho called >> "${fwd(argv)}"\ncat > /dev/null\nprintf '%s' '${JSON.stringify({ type: 'result', subtype: 'success', is_error: false, structured_output: VALID, total_cost_usd: 0.01 })}'\n`, { mode: 0o755 });
  const r = spawnSync(bash, [fwd(path.join(__dirname, 'engines', 'claude.sh'))], {
    encoding: 'utf8', timeout: 60000,
    env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH, CTX: fwd(ctx), PROMPT_FILE: fwd(path.join(dir, 'prompt.txt')), ANTHROPIC_API_KEY: KEY, GH_TOKEN: 'job-token',
      MODEL: 'claude-haiku-5-5', EFFORT: '', MAX_BUDGET_USD: '', TIMEOUT: '5', CLAUDE_VERSION: '', CHECK: '', CLAUDE_MODE: mode, NODE_OPTIONS: `--require=${fwd(path.join(dir, 'stub.js'))}`, ...validate },
  });
  const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } };
  return { r, fetches: read(log).split('\n').filter(Boolean).map((l) => JSON.parse(l)), cliCalls: read(argv), file: (n) => read(path.join(ctx, n)).trim(), ctx };
}

test('claude.sh: api mode (also when CLAUDE_MODE is empty) makes the API call and never touches the CLI; agent mode runs the CLI and makes no API call', (t) => {
  for (const mode of ['api', '']) {
    const s = shell(t, { mode, withClaude: true });
    assert.equal(s.r.status, 0, s.r.stdout + s.r.stderr);
    assert.equal(s.fetches.length, 1, `mode '${mode}': ${s.r.stdout} ${s.file('engine-notes')}`);
    assert.deepEqual({ ...s.fetches[0], key: s.fetches[0].key === KEY }, { url: 'https://api.anthropic.com/v1/messages', key: true, model: 'claude-haiku-5-5' });
    assert.deepEqual(JSON.parse(s.file('findings.json')), VALID);
    assert.equal(s.cliCalls, '');
    assert.ok(![s.r.stdout, s.r.stderr, s.file('engine-notes'), s.file('usage.json')].join('\n').includes(KEY));
  }
  const a = shell(t, { mode: 'agent', withClaude: true });
  assert.equal(a.r.status, 0, a.r.stdout + a.r.stderr);
  assert.equal(a.fetches.length, 0);
  assert.match(a.cliCalls, /called/);
  assert.deepEqual(JSON.parse(a.file('findings.json')), VALID);
});

test('claude.sh: api mode with a budget below the worst case sends nothing and exits 0 with the budget reason; a bad claude_mode or max_output_tokens fails the step', (t) => {
  const s = shell(t, { mode: 'api', validate: { MODEL: 'claude-opus-5-5', MAX_BUDGET_USD: '0.05' } });
  assert.equal(s.r.status, 0);
  assert.equal(s.fetches.length, 0);
  assert.equal(s.file('engine-status'), 'failed');
  assert.equal(s.file('engine-error').split('\n')[0], 'budget');
  for (const env of [{ CLAUDE_MODE: 'cli' }, { CLAUDE_MODE: 'api', MAX_OUTPUT_TOKENS: '5' }, { CLAUDE_MODE: 'api', MAX_OUTPUT_TOKENS: '99999' }]) {
    const bad = shell(t, { mode: 'api', validate: env });
    assert.equal(bad.r.status, 1, JSON.stringify(env));
    assert.match(bad.r.stdout, /^::error::(claude_mode|max_output_tokens)/m);
    assert.equal(bad.fetches.length, 0);
  }
});

// --- action.yml contract ---
test('action.yml: claude_mode defaults to api, max_output_tokens to 16000, and both reach the engine step as env', () => {
  const py = 'import sys,json,yaml\nprint(json.dumps(yaml.safe_load(open(sys.argv[1],encoding="utf8"))))\n';
  let a = null;
  for (const exe of ['python3', 'python']) { try { a = JSON.parse(require('node:child_process').execFileSync(exe, ['-c', py, path.join(__dirname, '..', 'action.yml')], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })); break; } catch { /* next */ } }
  if (!a) return; // python yaml unavailable: the text checks below still run
  assert.equal(a.inputs.claude_mode.default, 'api');
  assert.equal(a.inputs.max_output_tokens.default, '16000');
  assert.match(a.inputs.claude_mode.description, /api.*agent/s);
  assert.match(a.inputs.max_budget_usd.description, /HARD bound/);
  for (const name of ['engine', 'Run the review engine']) {
    const step = a.runs.steps.find((s) => s.id === name || s.name === name);
    assert.equal(step.env.CLAUDE_MODE, '${{ inputs.claude_mode }}', name);
    assert.equal(step.env.MAX_OUTPUT_TOKENS, '${{ inputs.max_output_tokens }}', name);
  }
});
