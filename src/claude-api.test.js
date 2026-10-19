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
  const fetchFn = async (url, init) => { calls.push({ url, init, body: JSON.parse(init.body) }); const a = answers[Math.min(calls.length - 1, answers.length - 1)]; return typeof a === 'function' ? a(calls[calls.length - 1]) : a; };
  const go = async (extra = {}) => {
    const log = console.log; console.log = (...a) => logged.push(a.join(' '));
    try { await api.run({ CTX: ctx, PROMPT_FILE: pf, ANTHROPIC_API_KEY: KEY, MODEL: 'claude-haiku-5-5', TIMEOUT: '5', ...env, ...extra }, { fetchFn, sleep: async (ms) => { slept.push(ms); } }); } finally { console.log = log; }
  };
  const file = (n) => { try { return fs.readFileSync(path.join(ctx, n), 'utf8').trim(); } catch { return null; } };
  const everything = () => [logged.join('\n'), ...(fs.existsSync(ctx) ? fs.readdirSync(ctx).map(file) : []), JSON.stringify(calls.map((c) => c.body))].join('\n');
  return { go, file, calls, slept, logged, everything, pf, ctx, dir, answers };
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
  assert.equal(body.max_tokens, 32000);
  assert.deepEqual(body.system, [{ type: 'text', text: STATIC, cache_control: { type: 'ephemeral' } }]);
  assert.equal(body.messages.length, 1);
  assert.equal(body.messages[0].role, 'user');
  assert.match(body.messages[0].content, /no file tools[\s\S]*---\n\nContext directory[\s\S]*PER-PR CONTEXT/);
  assert.ok(!body.tools, 'no tools: nothing to loop');
  assert.ok(!body.output_config, 'the PR findings schema is too large for the provider grammar: plain JSON, validated by post.js');
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
  assert.match(line, /^<sub>Cost [^\n]*· claude-haiku-5-5 · /);
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
  const w = api.worstCase('claude-haiku-5-5', sys, user, 32000);
  assert.ok(w.usd < 0.03 && w.usd < 1, String(w.usd));
  const typical = api.cost('claude-haiku-5-5', { input_tokens: 15000, cache_creation_input_tokens: 8000, output_tokens: 6000 });
  assert.ok(typical > 0.003 && typical < 0.015, String(typical));
});

test('pre-flight: a worst case above max_budget_usd makes NO call, status failed, reason budget, a message with both numbers; a larger budget passes', async (t) => {
  const h = harness(t, [good()]);
  await h.go({ MODEL: 'claude-opus-5-5', MAX_BUDGET_USD: '0.05' }); // 32000 x $20/M alone is $0.64
  assert.equal(h.calls.length, 0, 'nothing was sent');
  assert.equal(h.file('engine-status'), 'failed');
  const [reason, why] = h.file('engine-error').split('\n');
  assert.equal(reason, 'budget');
  assert.match(why, /^estimated worst-case cost \$0\.\d+ exceeds max_budget_usd \$0\.05/);
  assert.match(h.file('engine-notes'), /^estimated worst-case cost/);
  assert.match(h.logged.join('\n'), /::warning::Claude review failed \(budget\): estimated worst-case cost/);
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
  assert.match(h.logged.join('\n'), /::warning::Claude review failed \(auth, HTTP 401\): The Anthropic API key was rejected/);
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

test('a refused output schema (scan): ONE retry asking for plain JSON (no output_config), with a note; a plain answer is still extracted', async (t) => {
  const h = harness(t, [err(400, 'invalid_request_error', 'Schema is too complex for compilation.'), good({ content: [{ type: 'text', text: `Here you go:\n${JSON.stringify(VALID)}` }] })]);
  await h.go({ CHECK: 'audit' });
  assert.equal(h.calls.length, 2);
  assert.ok(h.calls[0].body.output_config && !h.calls[1].body.output_config);
  assert.deepEqual(JSON.parse(h.file('findings.json')), VALID);
  assert.equal(h.file('engine-notes'), '', 'the usage line carries no engine note for it');
  assert.ok(!/structured output/.test(h.everything()), 'and no file or call carries it');
  assert.ok([null, 'success'].includes(h.file('engine-status')));
});

test('a refused output schema (scan) logs the provider message (scrubbed, capped); the log never carries the key', async (t) => {
  const h = harness(t, [err(400, 'invalid_request_error', `Schema is too complex for compilation. ${KEY} ${'x'.repeat(400)}`), good()]);
  const errs = [], e0 = console.error; console.error = (...a) => errs.push(a.join(' '));
  try { await h.go({ CHECK: 'audit' }); } finally { console.error = e0; }
  const line = errs.find((l) => /structured output unavailable/.test(l));
  assert.match(line, /structured output unavailable \(Schema is too complex for compilation\. \*\*\* x+\); plain JSON requested$/);
  assert.ok(!line.includes('sk-ant') && line.length < 400);
});

test('an answer with no JSON keeps the scrubbed raw text in engine-raw-answer.txt and still fails the same way', async (t) => {
  const h = harness(t, [good({ content: [{ type: 'text', text: `sorry, no ${KEY}` }] })]);
  await h.go();
  assert.equal(h.file('engine-raw-answer.txt'), 'sorry, no ***');
  assert.equal(h.file('engine-status'), 'failed');
  assert.match(h.file('engine-notes'), /no JSON found in the engine output[\s\S]*engine-raw-answer\.txt/);
  const big = harness(t, [good({ content: [{ type: 'text', text: 'z'.repeat(250000) }] })]);
  await big.go();
  assert.equal(big.file('engine-raw-answer.txt').length, 200000, 'a long answer is kept capped at 200000 chars');
  const ok = harness(t, [good()]);
  await ok.go();
  assert.equal(ok.file('engine-raw-answer.txt'), null, 'a good answer leaves no raw file');
});

test('max_tokens and refusal stops, an answer with no JSON, a timeout and a network error all end failed or timeout without throwing', async (t) => {
  const cut = harness(t, [good({ stop_reason: 'max_tokens', content: [{ type: 'text', text: '{"coverage": [' }] })]);
  await cut.go();
  assert.equal(cut.file('engine-status'), 'failed');
  assert.equal(cut.file('engine-error').split('\n')[0], 'length');
  assert.match(cut.file('engine-error'), /max_output_tokens \(32000\)/);
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

// --- the context pack: repository files appended to the user message ---
function repo(t, files, ctxFiles = {}, env = {}) {
  const h = harness(t, [good()], env), root = path.join(h.dir, 'repo');
  fs.mkdirSync(root); fs.mkdirSync(h.ctx, { recursive: true });
  const put = (base, n, c) => { fs.mkdirSync(path.dirname(path.join(base, n)), { recursive: true }); fs.writeFileSync(path.join(base, n), c); };
  for (const [n, c] of Object.entries(files)) put(root, n, c);
  for (const [n, c] of Object.entries(ctxFiles)) put(h.ctx, n, c);
  return { h, root, go: (extra) => h.go({ GITHUB_WORKSPACE: root, ...extra }), user: () => h.calls[0].body.messages[0].content };
}
const lineText = (n) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n') + '\n';

test('context pack: rule files, changed files (focus order) each followed by its tests, rest of a cut diff, requirement docs, in that order; line-numbered, de-duplicated, deleted files skipped; one note', async (t) => {
  const diff = Array.from({ length: 5000 }, (_, i) => `${String(i + 1).padStart(4)}| +code ${i}`).join('\n') + '\n'; // far above the 40 KiB prompt limit
  const r = repo(t, { 'RULES.md': 'Rule one\n', 'src/a.js': 'const a = 1;\nconst b = 2;\n', 'src/b.js': 'b();\n', 'test/a.test.js': 'test(a);\n', 'docs/req.md': 'REQ text\n' }, {
    'diff.numbered.txt': diff, 'standards.txt': 'RULES.md\n', 'files.txt': 'src/a.js\nsrc/b.js\nsrc/gone.js\n', 'focus.txt': 'src/b.js\t9\tx\nsrc/a.js\t5\ty\nsrc/gone.js\t1\tz\n',
    'test-candidates.txt': 'src/a.js\n  test/a.test.js  (same stem)\n  src/b.js  (dup)\nsrc/b.js\n  (no candidate test file found)\n', 'spec-files.txt': 'docs/req.md\nRULES.md\n' });
  await r.go();
  const u = r.user(), at = (s) => u.indexOf(s);
  assert.ok(at('name="RULES.md"') > 0 && at('name="RULES.md"') < at('name="src/b.js"') && at('name="src/b.js"') < at('name="src/a.js"') && at('name="src/a.js"') < at('name="test/a.test.js"') && at('name="test/a.test.js"') < at('diff.numbered.txt (rest)') && at('diff.numbered.txt (rest)') < at('name="docs/req.md"'), 'priority order');
  assert.match(u, /name="diff\.numbered\.txt \(rest\)" note="lines \d+ to 5000 of 5000; continues the diff block above"/);
  assert.match(u, /name="src\/a\.js" note="full file, line-numbered">\n {3}1\| const a = 1;\n {3}2\| const b = 2;\n<\/untrusted-data>/);
  assert.match(u, /name="RULES\.md" note="full file">\nRule one\n/);
  assert.equal(u.split('name="src/b.js"').length, 2, 'de-duplicated');
  assert.ok(!u.includes('gone.js"'));
  assert.match(u, /no file tools[\s\S]*Repository files[\s\S]*full current text/);
  assert.match(r.h.file('engine-notes'), /^context pack: 5 files, \d+ KB; not included: src\/gone\.js$/);
});

test('context pack: a source file is followed at once by its tests, before the next source file', async (t) => {
  const r = repo(t, { 'src/a.js': 'a();\n', 'src/b.js': 'b();\n', 'test/a.test.js': 'ta();\n', 'test/b.test.js': 'tb();\n' }, { 'files.txt': 'src/a.js\nsrc/b.js\n', 'test-candidates.txt': 'src/a.js\n  test/a.test.js  (same stem)\nsrc/b.js\n  test/b.test.js  (same stem)\n' });
  await r.go();
  const u = r.user(), at = (n) => u.indexOf(`name="${n}"`);
  assert.ok(at('src/a.js') > 0 && at('src/a.js') < at('test/a.test.js') && at('test/a.test.js') < at('src/b.js') && at('src/b.js') < at('test/b.test.js'), 'a, its test, b, its test');
});

test('context pack: files.txt order without focus.txt; the byte budget cuts a file at a line boundary and lists what did not fit', async (t) => {
  const names = 'abcdefgh'.split('').map((c) => `${c}.js`);
  const r = repo(t, Object.fromEntries(names.map((n) => [n, Array.from({ length: 10 }, () => 'x'.repeat(99)).join('\n') + '\n'])), { 'files.txt': names.join('\n') + '\n' }, { CONTEXT_PACK_BYTES: '2000' });
  await r.go();
  const u = r.user();
  assert.match(u, /name="a\.js" note="full file, line-numbered"/);
  assert.match(u, /name="b\.js" note="first \d of 10 lines, line-numbered"/);
  assert.ok(!u.includes('name="c.js"'));
  assert.equal(r.h.file('engine-notes').split('\n').length, 1);
  assert.match(r.h.file('engine-notes'), /^context pack: 2 files, \d KB; not included: c\.js, d\.js, e\.js, f\.js \(\+2 more\)$/);
});

test('context pack: pack-cut.txt lists every file that was cut or not included, one repo-relative path per line, no contents; absent when the pack is off; the note tells the model not to report on them', async (t) => {
  const body = Array.from({ length: 10 }, () => 'x'.repeat(99)).join('\n') + '\n';
  const r = repo(t, { 'a.js': body, 'b.js': body, 'c.js': body, 'd.js': body, 'e.js': body, 'f.js': body }, { 'files.txt': 'a.js\nb.js\nc.js\nd.js\ne.js\nf.js\n' }, { CONTEXT_PACK_BYTES: '2000' });
  await r.go();
  assert.equal(r.h.file('pack-cut.txt'), 'b.js\nc.js\nd.js\ne.js\nf.js', 'b.js cut, c.js-f.js not included, a.js whole');
  assert.match(r.h.file('pack-shown.txt'), /^b\.js\t\d+$/, 'a file cut from the top records how many lines were shown; files not included have no entry');
  assert.match(r.user(), /Do not report a missing or weak test when a candidate test file for that code was cut or not included/);
  const whole = repo(t, { 'a.js': 'a();\n' }, { 'files.txt': 'a.js\n' });
  await whole.go();
  assert.equal(whole.h.file('pack-cut.txt'), '', 'the pack ran and cut nothing: an empty list');
  const off = repo(t, { 'a.js': body }, { 'files.txt': 'a.js\n' }, { CONTEXT_PACK_BYTES: '0' });
  await off.go();
  assert.equal(off.h.file('pack-cut.txt'), null);
});

test('context pack: scan units share the budget; a first unit with many big tests cannot starve the later unit files', async (t) => {
  const big = Array.from({ length: 120 }, () => 'x'.repeat(99)).join('\n') + '\n', tests = Array.from({ length: 10 }, (_, i) => `test/t${i}.js`);
  const r = repo(t, { 'lib/a.js': 'function alpha() {}\n', 'lib/b.js': 'function beta() {}\n', 'lib/c.js': 'function gamma() {}\n', ...Object.fromEntries(tests.map((n) => [n, big])) },
    { 'audit-units.txt': `u1\tlib/a.js\t1\tw\t${tests.join(', ')}\t\nu2\tlib/b.js\t1\tw\tnone\t\nu3\tlib/c.js\t1\tw\tnone\t\n` }, { CONTEXT_PACK_BYTES: '100000' });
  await r.go();
  const u = r.user(), cut = r.h.file('pack-cut.txt').split('\n');
  for (const n of ['lib/a.js', 'lib/b.js', 'lib/c.js']) assert.ok(u.includes(`name="${n}" note="full file`) && !cut.includes(n), n);
  assert.ok(cut.includes('test/t9.js'), 'excess tests of unit 1 are listed as not whole');
});

const track = (root) => { for (const a of [['init', '-q'], ['add', '-A']]) spawnSync('git', a, { cwd: root }); }; // the extra tiers read `git ls-files`

test('context pack: a file the requirements name (by file name or folder name) is inlined with its sibling test; generic tokens and tokens that match nothing are skipped; at most 8 files', async (t) => {
  const files = { 'src/core/subMonths/index.ts': 'export const subMonths = 1;\n', 'src/core/subMonths/test.ts': 'test(subMonths);\n', 'src/core/addMonths/index.ts': 'export const addMonths = 1;\n', 'src/changed.ts': 'c();\n', 'src/other/index.ts': 'o();\n' };
  for (let i = 0; i < 4; i++) files[`pkg${i}/shared_thing.ts`] = 'x();\n'; // 4 files with the same stem: generic
  for (let i = 0; i < 10; i++) files[`many/helper_${i}.ts`] = `h${i}();\n`;
  const r = repo(t, files, { 'files.txt': 'src/changed.ts\n', 'requirements.md': 'subMonths delegates to `addMonths`; see `shared_thing` and `nothing_here` and helper_0 helper_1 helper_2 helper_3 helper_4 helper_5 helper_6 helper_7 helper_8 helper_9.\n' });
  track(r.root);
  await r.go();
  const u = r.user(), at = (n) => u.indexOf(`name="${n}"`);
  assert.ok(at('src/changed.ts') > 0 && at('src/changed.ts') < at('src/core/subMonths/index.ts') && at('src/core/subMonths/index.ts') < at('src/core/subMonths/test.ts'), 'review file, then the named file, then its sibling test');
  assert.ok(at('src/core/addMonths/index.ts') > 0, 'a backticked identifier matches a folder name');
  assert.equal(at('pkg0/shared_thing.ts'), -1, 'a token that matches more than 3 files is generic');
  assert.match(u, /name="src\/core\/subMonths\/index\.ts" note="full file, line-numbered"/);
  assert.equal((u.match(/name="many\/helper_\d\.ts"/g) || []).length, 6, 'addMonths and subMonths first, then helper_0..5: 8 named files; helper_6..9 are over the cap');
  assert.equal(r.h.file('pack-cut.txt'), '', 'nothing from the review-file tier was cut');
});

test('context pack: the smallest other source files beside a review file come after it, at most 3 per folder, each <= 16 KiB, never tests; their omission is not listed in pack-cut.txt', async (t) => {
  const r = repo(t, { 'src/a.ts': 'a();\n', 'src/s1.ts': 's1();\n', 'src/s2.ts': 's2();\ns2();\n', 'src/s3.ts': 's3();\n\n\n\n', 'src/s4.ts': 's4();\n'.repeat(20), 'src/big.ts': 'x'.repeat(17 * 1024), 'src/a.test.ts': 'ta();\n', 'src/notes.md': 'doc\n' }, { 'files.txt': 'src/a.ts\n' });
  track(r.root);
  await r.go();
  const u = r.user(), has = (n) => u.includes(`name="${n}"`);
  assert.deepEqual(['src/s1.ts', 'src/s2.ts', 'src/s3.ts'].map(has), [true, true, true]);
  assert.deepEqual(['src/s4.ts', 'src/big.ts', 'src/a.test.ts', 'src/notes.md'].map(has), [false, false, false, false], 'a fourth sibling, a big file, a test and a document are left out');
  assert.equal(r.h.file('pack-cut.txt'), '');
  const tight = repo(t, { 'a.ts': 'a();\n'.repeat(300), 'b.ts': 'b();\n' }, { 'files.txt': 'a.ts\n' }, { CONTEXT_PACK_BYTES: '1500' });
  track(tight.root);
  await tight.go();
  assert.equal(tight.h.file('pack-cut.txt'), 'a.ts', 'the review file is cut; the sibling that did not fit is not listed');
});

test('context pack: files of the extra tiers (siblings, named files) stop at 60% of the budget, so a later requirement document still fits', async (t) => {
  const big = Array.from({ length: 25 }, () => 'x'.repeat(99)).join('\n') + '\n'; // ~2.6 KB numbered: s1 is cut at the 60% line, nothing is left for s2
  const r = repo(t, { 'src/a.ts': 'a();\n', 'src/s1.ts': big, 'src/s2.ts': big + 'y\n', 'src/s3.ts': big + 'y\ny\n', 'docs/req.md': 'REQ-TEXT\n' }, { 'files.txt': 'src/a.ts\n', 'spec-files.txt': 'docs/req.md\n' }, { CONTEXT_PACK_BYTES: '4000' });
  track(r.root);
  await r.go();
  const u = r.user(), has = (n) => u.includes(`name="${n}"`);
  assert.deepEqual(['src/a.ts', 'src/s1.ts'].map(has), [true, true]);
  assert.deepEqual(['src/s2.ts', 'src/s3.ts'].map(has), [false, false], 'past 60% of 4000 bytes the other siblings are skipped');
  assert.ok(has('docs/req.md'), 'the requirement document fits in the rest');
  assert.equal(r.h.file('pack-cut.txt'), '', 'skipped extra-tier files are not listed as cut');
});

test('context pack: a file over the per-file cap (limit/6, here 41666 bytes) is cut at a line boundary and says so', async (t) => {
  const r = repo(t, { 'big.js': lineText(20000) }, { 'files.txt': 'big.js\n' });
  await r.go();
  const m = /name="big\.js" note="first (\d+) of 20000 lines, line-numbered">\n([\s\S]*?)\n<\/untrusted-data>/.exec(r.user());
  assert.ok(m && +m[1] > 1000 && +m[1] < 20000);
  assert.equal(m[2].split('\n').length, +m[1]);
  assert.ok(Buffer.byteLength(m[2]) <= 250000 / 6);
  assert.doesNotMatch(r.h.file('engine-notes'), /not included/, 'a cut file is not an omitted file');
});

test('context pack: CONTEXT_PACK_BYTES=0 turns it off (old note, no files, no pack note); an empty value means the default', async (t) => {
  const off = repo(t, { 'a.js': 'secret-body\n' }, { 'files.txt': 'a.js\n' }, { CONTEXT_PACK_BYTES: '0' });
  await off.go();
  assert.ok(!off.user().includes('secret-body') && !off.user().includes('Repository files'));
  assert.match(off.user(), /Use only the context inlined below/);
  assert.equal(off.h.file('engine-notes'), '');
  const dflt = repo(t, { 'a.js': 'secret-body\n' }, { 'files.txt': 'a.js\n' }, { CONTEXT_PACK_BYTES: '' });
  await dflt.go();
  assert.ok(dflt.user().includes('secret-body'));
});

test('context pack: ../ traversal, absolute paths and symlinks out of the repository are never read', async (t) => {
  const r = repo(t, { 'ok.js': 'fine\n' }, { 'files.txt': '../outside.txt\n/etc/hostname\nok.js\nlink.txt\nlinkdir/inner.txt\n' });
  const outside = path.join(r.h.dir, 'outside.txt');
  fs.writeFileSync(outside, 'TOPSECRET\n');
  fs.mkdirSync(path.join(r.h.dir, 'outdir')); fs.writeFileSync(path.join(r.h.dir, 'outdir', 'inner.txt'), 'TOPSECRET2\n');
  let linked = true;
  try { fs.symlinkSync(outside, path.join(r.root, 'link.txt')); fs.symlinkSync(path.join(r.h.dir, 'outdir'), path.join(r.root, 'linkdir'), 'junction'); } catch { linked = false; } // Windows without the privilege
  await r.go();
  const body = JSON.stringify(r.h.calls[0].body);
  assert.ok(body.includes('name=\\"ok.js\\"'));
  assert.ok(!body.includes('TOPSECRET') && !body.includes('outside.txt'), `symlinks created: ${linked}`);
  assert.match(r.h.file('engine-notes'), /^context pack: 1 files/);
});

test('context pack: .env files, keys, .git, binaries and huge files are skipped', async (t) => {
  const files = { 'ok.js': 'fine\n', '.env': 'K=ENVSECRET\n', 'sub/prod.env': 'ENVSECRET\n', 'sub/.env.local': 'ENVSECRET\n', 'k.pem': 'ENVSECRET\n', 'my.key': 'ENVSECRET\n', 'id_rsa': 'ENVSECRET\n', 'id_rsa.pub': 'ENVSECRET\n', '.git/config': 'ENVSECRET\n', 'sub/.git/HEAD': 'ENVSECRET\n', 'bin.dat': Buffer.concat([Buffer.from('ENVSECRET'), Buffer.from([0, 1, 2])]), 'huge.txt': 'ENVSECRET\n'.repeat(250000) };
  const r = repo(t, files, { 'files.txt': Object.keys(files).join('\n') + '\n', 'standards.txt': '.env\n' });
  await r.go();
  const u = r.user();
  assert.ok(u.includes('name="ok.js"') && !u.includes('ENVSECRET'), 'only the plain file');
  assert.match(r.h.file('engine-notes'), /^context pack: 1 files/);
});

test('context pack: the pre-flight cost check includes the pack', async (t) => {
  const files = { 'a.js': lineText(8000), 'b.js': lineText(8000), 'c.js': lineText(8000) }, ctxFiles = { 'files.txt': 'a.js\nb.js\nc.js\n' };
  const env = { MODEL: 'claude-opus-5-5', MAX_BUDGET_USD: '0.05', MAX_OUTPUT_TOKENS: '1000' }; // the prompt alone is a few cents of nothing; about 100 KB of pack is not
  const on = repo(t, files, ctxFiles, env);
  await on.go();
  assert.equal(on.h.calls.length, 0, 'nothing was sent');
  assert.equal(on.h.file('engine-error').split('\n')[0], 'budget');
  const off = repo(t, files, ctxFiles, { ...env, CONTEXT_PACK_BYTES: '0' });
  await off.go();
  assert.equal(off.h.calls.length, 1);
});

test('pre-flight counts 1.5 bytes per token: a budget that 3.5 would pass is refused', async (t) => {
  const big = PROMPT + 'y'.repeat(100000); // about 28.6k tokens at 3.5, 66.7k at 1.5; opus 5.5 is $4/M input
  assert.equal(api.worstCase('claude-opus-5-5', 0, 90000, 1000).tokens, 60000);
  const h = harness(t, [good()]);
  fs.writeFileSync(h.pf, big);
  await h.go({ MODEL: 'claude-opus-5-5', MAX_BUDGET_USD: '0.2', MAX_OUTPUT_TOKENS: '1000', CONTEXT_PACK_BYTES: '0' }); // 3.5: $0.13, 1.5: $0.29
  assert.equal(h.calls.length, 0);
  assert.equal(h.file('engine-error').split('\n')[0], 'budget');
});

test('context pack on a model with a price step (haiku 5.5): not shrunk for the step; the pre-flight still refuses when the budget is too low for the prompt', async (t) => {
  const files = Object.fromEntries('abcdef'.split('').map((c) => [`${c}.js`, lineText(20000)])), ctxFiles = { 'files.txt': Object.keys(files).join('\n') + '\n' };
  const r = repo(t, files, ctxFiles);
  fs.writeFileSync(r.h.pf, PROMPT + 'z'.repeat(190000));
  await r.go();
  assert.equal(r.h.calls.length, 1, r.h.file('engine-error'));
  const b = r.h.calls[0].body, total = Buffer.byteLength(b.system[0].text) + Buffer.byteLength(b.messages[0].content);
  assert.ok(total / 2 > api.PRICES['claude-haiku-5-5'].longFrom && /^context pack: [1-9]\d* files/.test(r.h.file('engine-notes')), 'the pack went in past the step: ' + total);
  const low = repo(t, files, ctxFiles, { MAX_BUDGET_USD: '0.05' }); // over 100k tokens is the long card
  fs.writeFileSync(low.h.pf, PROMPT + 'z'.repeat(190000));
  await low.go();
  assert.equal(low.h.calls.length, 0);
  assert.equal(low.h.file('engine-error').split('\n')[0], 'budget');
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
test('action.yml: claude_mode defaults to api, max_output_tokens to 32000, and both reach the engine step as env', () => {
  const py = 'import sys,json,yaml\nprint(json.dumps(yaml.safe_load(open(sys.argv[1],encoding="utf8"))))\n';
  let a = null;
  for (const exe of ['python3', 'python']) { try { a = JSON.parse(require('node:child_process').execFileSync(exe, ['-c', py, path.join(__dirname, '..', 'action.yml')], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })); break; } catch { /* next */ } }
  if (!a) return; // python yaml unavailable: the text checks below still run
  assert.equal(a.inputs.claude_mode.default, 'api');
  assert.equal(a.inputs.max_output_tokens.default, '32000');
  assert.match(a.inputs.claude_mode.description, /api.*agent/s);
  assert.match(a.inputs.max_budget_usd.description, /HARD bound/);
  for (const name of ['engine', 'Run the review engine']) {
    const step = a.runs.steps.find((s) => s.id === name || s.name === name);
    assert.equal(step.env.CLAUDE_MODE, '${{ inputs.claude_mode }}', name);
    assert.equal(step.env.MAX_OUTPUT_TOKENS, '${{ inputs.max_output_tokens }}', name);
  }
});

// --- big candidate tests: relevant slices around the changed symbols instead of the head ---
const bigTest = (hit) => Array.from({ length: 600 }, (_, i) => `test('case ${i}', () => {\n  assert.equal(helper(${i}), ${i});\n  ${hit(i) ? 'computeTotal(1);' : 'ok();'}\n});\n`).join('\n'); // 3000 lines, 5 per case: case i starts at line 5i+1, its call is on 5i+3
const sliceRepo = (t, hit, ctxExtra = {}, pre = '') => repo(t, { 'src/svc.js': 'const x = 1;\nfunction computeTotal(a) {\n  return a;\n}\n', 'test/svc.test.js': pre + bigTest(hit) }, {
  'files.txt': 'src/svc.js\n', 'test-candidates.txt': 'src/svc.js\n  test/svc.test.js  (same stem)\n',
  'diff.numbered.txt': 'diff --git a/src/svc.js b/src/svc.js\n--- a/src/svc.js\n+++ b/src/svc.js\n@@ -1,1 +1,4 @@\n   1 |  const x = 1;\n   2 | +function computeTotal(a) {\n   3 | +  return a;\n   4 | +}\n', ...ctxExtra });

test('context pack: a test file over its cap is shown as the relevant slices (head plus the tests that mention a changed symbol), with real line numbers, not as its head', async (t) => {
  const r = sliceRepo(t, (i) => i === 400);
  await r.go();
  const u = r.user();
  assert.match(u, /name="test\/svc\.test\.js" note="relevant slices: lines 1-30, 2001-2005 of 2999 \(tests referencing computeTotal\), line-numbered">\n {3}1\| test\('case 0'/);

 {2}30|  assert.match(u, /\n {2}30\| .*\n {3}…\| \(lines 31-2000 omitted\)\n2001\| test\('case 400'[\s\S]*\n2003\|   computeTotal\(1\);\n2004\| \}\);\n2005\| \n {3}…\| \(lines 2006-2999 omitted\)\n<\/untrusted-data>/);
  assert.ok(!u.includes('\n 100| '), 'the head is not used past the first 30 lines');
  assert.match(u, /"relevant slices" shows bounded windows[^]*omitted code may contain assertions or indirect coverage/);
  assert.equal(r.h.file('pack-cut.txt'), '', 'every test that mentions the symbol is visible: not listed as cut');
});

test('context pack: an import line that names the symbol is not a cut test: the slices stay complete and the file is not listed as cut', async (t) => {
  const r = sliceRepo(t, (i) => i === 400, {}, "const { computeTotal } = require('../src/svc');\n");
  await r.go();
  assert.doesNotMatch(r.user(), /truncated at the search window/);
  assert.equal(r.h.file('pack-cut.txt'), '');
});

test('context pack: a symbol counts only as a whole word: recomputeTotal is no reference to computeTotal (the file is omitted and listed as cut, no head)', async (t) => {
  const r = repo(t, { 'src/svc.js': 'const x = 1;\nfunction computeTotal(a) {\n  return a;\n}\n', 'test/svc.test.js': bigTest((i) => i === 400).replace('computeTotal(1);', 'recomputeTotal(1);') }, {
    'files.txt': 'src/svc.js\n', 'test-candidates.txt': 'src/svc.js\n  test/svc.test.js  (same stem)\n',
    'diff.numbered.txt': 'diff --git a/src/svc.js b/src/svc.js\n--- a/src/svc.js\n+++ b/src/svc.js\n@@ -1,1 +1,4 @@\n   1 |  const x = 1;\n   2 | +function computeTotal(a) {\n   3 | +  return a;\n   4 | +}\n' });
  await r.go();
  assert.doesNotMatch(r.user(), /name="test\/svc\.test\.js"/);
  assert.equal(r.h.file('pack-cut.txt'), 'test/svc.test.js');
});

test('context pack: no symbol of the diff in the test file -> the file is omitted (no head) and listed as cut; leads.txt symbols and a raw diff.patch are used too', async (t) => {
  const none = sliceRepo(t, (i) => i === 400, { 'diff.numbered.txt': '+++ b/src/svc.js\n@@ -1,1 +1,2 @@\n   2 | +function zzzNothing() {}\n' });
  await none.go();
  assert.doesNotMatch(none.user(), /name="test\/svc\.test\.js"/);
  assert.equal(none.h.file('pack-cut.txt'), 'test/svc.test.js');
  const leads = sliceRepo(t, (i) => i === 400, { 'diff.numbered.txt': '', 'diff.patch': 'diff --git a/src/svc.js b/src/svc.js\n+++ b/src/svc.js\n@@ -1 +1,2 @@\n+function other() {}\n', 'leads.txt': 'Changed symbols with no test reference:\n  src/svc.js:2 computeTotal\n  src/other.js:9 helper\n' });
  await leads.go();
  assert.match(leads.user(), /note="relevant slices: lines 1-30, 2001-2005 of 2999 \(tests referencing computeTotal\)/);
  const raw = sliceRepo(t, (i) => i === 400, { 'diff.numbered.txt': '', 'diff.patch': 'diff --git a/src/svc.js b/src/svc.js\n+++ b/src/svc.js\n@@ -1 +1,2 @@ function computeTotal(a) {\n+  return a + 1;\n' });
  await raw.go();
  assert.match(raw.user(), /relevant slices: lines 1-30, 2001-2005 of 2999 \(tests referencing computeTotal\)/, 'the git hunk header names the enclosing function');
});

test('context pack: slices that leave out some matching test blocks list the file in pack-cut.txt and say so in the note', async (t) => {
  const r = sliceRepo(t, (i) => i < 3 || (i >= 100 && i < 500) || i === 550); // a 2000-line block of matches that cannot fit, small ones that can
  await r.go();
  const u = r.user();
  assert.match(u, /note="relevant slices: lines 1-30, 2751-2755 of 2999 \(tests referencing computeTotal\); some matching tests did not fit, line-numbered"/);
  assert.equal(r.h.file('pack-cut.txt'), 'test/svc.test.js');
});

// --- a scan with many document blocks is split into budgeted parts (src/scan-parts.js) and merged ---
const cidOf = (i) => i.toString(16).padStart(8, '0');
// n candidate blocks, 3 units; `answer(req, ok)` may override the reply of a call (ok = the valid answer for what the call listed)
function scanRepo(t, n, env = {}) {
  const ok = (req) => {
    const u = req.body.messages[0].content, rows = [...u.matchAll(/^([0-9a-f]{8})\tdocs\/d\.md:1/gm)].map((m) => m[1]), unit = /name="audit-units\.txt"/.test(u);
    return good({ content: [{ type: 'text', text: JSON.stringify({ docs_reviewed: ['docs/d.md'], requirements: unit ? [] : rows.map((c) => ({ id: c, text: 'x', source: { path: 'docs/d.md', line: 1, quote: 'quote of the block' }, class: 'unit', status: 'unknown', code: [], tests: [], note: '' })),
      not_requirements: [], unit_findings: unit ? [{ unit: 'aaaaaaaa', kind: 'missing_test', path: 'lib/a.js', line: 1, quote: 'function alpha() {}', title: 't' }] : [], not_reviewed: [] }) }] });
  };
  const cids = Array.from({ length: n }, (_, i) => cidOf(i + 1));
  const r = repo(t, { 'lib/a.js': 'function alpha() {}\n', 'lib/b.js': 'function beta() {}\n', 'lib/c.js': 'function gamma() {}\n', 'test/a.test.js': 'test(1);\n' }, {
    'audit-candidates.txt': cids.map((c) => `${c}\tdocs/d.md:1\tH\ttext ${c}\n`).join(''),
    'audit-evidence.txt': cids.map((c) => `${c}\tcode\tlib/a.js:1\tfunction alpha() {}\n${c}\ttest\ttest/a.test.js:1\ttest(1);\n`).join(''),
    'audit-docs.txt': 'docs/d.md\tadmitted\n', 'audit-meta.json': JSON.stringify({ max_requirements: 80, candidates: n, candidates_listed: n, units: { total: 3, picked: 3 }, max_units: 12 }),
    'audit-units.txt': 'aaaaaaaa\tlib/a.js\t1\tw\ttest/a.test.js\t\nbbbbbbbb\tlib/b.js\t1\tw\tnone\t\ncccccccc\tlib/c.js\t1\tw\tnone\t\n' }, { CHECK: 'audit', ...env });
  return { ...r, cids, answers: (f) => { r.h.answers[0] = (req) => f(req, ok); } };
}
const blockCalls = (h) => h.calls.filter((c) => !/name="audit-units\.txt"/.test(c.body.messages[0].content));

test('scan parts: 45 blocks + 3 units = one unit call and three block calls of at most 20; the answers are merged, usage is summed, the notes say how many calls', async (t) => {
  const s = scanRepo(t, 45);
  s.answers((req, ok) => ok(req));
  await s.h.go({ GITHUB_WORKSPACE: s.root });
  assert.equal(s.h.calls.length, 4);
  assert.equal(s.h.calls.filter((c) => /name="audit-units\.txt"/.test(c.body.messages[0].content)).length, 1);
  const sizes = blockCalls(s.h).map((c) => new Set([...c.body.messages[0].content.matchAll(/^([0-9a-f]{8})\tdocs\/d\.md:1/gm)].map((m) => m[1])).size);
  assert.deepEqual(sizes, [20, 20, 5]);
  const f = JSON.parse(s.h.file('findings.json'));
  assert.equal(f.requirements.length, 45);
  assert.deepEqual(f.requirements.map((r) => r.id), s.cids);
  assert.equal(f.unit_findings.length, 1);
  assert.deepEqual(f.docs_reviewed, ['docs/d.md']);
  assert.equal(JSON.parse(s.h.file('usage.json')).totalCostUsd, 4 * api.cost('claude-haiku-5-5', { input_tokens: 1000, cache_creation_input_tokens: 20000, output_tokens: 4000 }));
  assert.match(s.h.file('engine-notes'), /scan in 4 calls/);
  assert.deepEqual(JSON.parse(s.h.file('scan-parts.json')), { calls: 4, failed: [], dropped: [] });
  assert.ok(blockCalls(s.h)[0].body.messages[0].content.includes('name="lib/a.js"'), 'the block call carries the files its evidence cites');
  assert.ok(!blockCalls(s.h)[0].body.messages[0].content.includes('name="audit-units.txt"'));
});

test('scan parts: a block part packs a line-numbered window around a cited line deep in a large file, not the whole file, and writes no pack-cut.txt', async (t) => {
  const s = scanRepo(t, 25);
  s.answers((req, ok) => ok(req));
  fs.mkdirSync(path.join(s.root, 'electron'));
  fs.writeFileSync(path.join(s.root, 'electron', 'big.cjs'), Array.from({ length: 3000 }, (_, i) => (i === 899 ? "mk('main', { width: 1000, height: 800, minWidth: 820 })" : `// filler ${i + 1}`)).join('\n') + '\n');
  fs.appendFileSync(path.join(s.h.ctx, 'audit-evidence.txt'), `${s.cids[0]}\tcode\telectron/big.cjs:900\tmk('main'\n`);
  await s.h.go({ GITHUB_WORKSPACE: s.root });
  const u = blockCalls(s.h)[0].body.messages[0].content;
  assert.match(u, /name="electron\/big\.cjs" note="relevant windows around the cited lines \(900\) of 3000/);
  assert.match(u, /^ 900\| mk\('main', \{ width: 1000, height: 800, minWidth: 820 \}\)$/m);
  assert.match(u, /^ 860\| \/\/ filler 860$/m);
  assert.ok(!/^ 100\| /m.test(u) && !/^2000\| /m.test(u), 'lines far from the cited one are not shown');
  assert.match(u, /^ {3}1\| \/\/ filler 1$/m, 'the file head is kept');
  assert.equal(s.h.file('pack-cut.txt'), '', 'only the unit part writes pack-cut.txt');
  assert.deepEqual(JSON.parse(s.h.file('scan-parts.json')).blockCuts, { [s.cids[0]]: ['electron/big.cjs'] });
});

test('scan parts: at most SCAN_BATCH_BLOCKS blocks keep the single call', async (t) => {
  const s = scanRepo(t, 20);
  s.answers((req, ok) => ok(req));
  await s.h.go({ GITHUB_WORKSPACE: s.root });
  assert.equal(s.h.calls.length, 1);
  assert.equal(s.h.file('scan-parts.json'), null);
});

test('scan parts: a block call with invalid JSON loses only its own blocks (listed in scan-parts.json); the other answers are kept and the run succeeds', async (t) => {
  const s = scanRepo(t, 45);
  s.answers((req, ok) => (/text 00000021\b/.test(req.body.messages[0].content) ? good({ content: [{ type: 'text', text: 'not json at all' }] }) : ok(req))); // the second batch (blocks 21-40)
  await s.h.go({ GITHUB_WORKSPACE: s.root });
  assert.equal(s.h.calls.length, 4);
  assert.ok([null, 'success'].includes(s.h.file('engine-status')));
  const f = JSON.parse(s.h.file('findings.json')), parts = JSON.parse(s.h.file('scan-parts.json'));
  assert.equal(f.requirements.length, 25);
  assert.deepEqual(parts.failed.map((x) => [x.part, x.blocks.length]), [['blocks', 20]]);
  assert.deepEqual(parts.failed[0].blocks, s.cids.slice(20, 40));
  assert.match(s.h.file('engine-notes'), /20 blocks not audited/);
  assert.ok(JSON.parse(s.h.file('usage.json')).totalCostUsd > 0, 'the failed reply is paid for and counted');
});

// the real answer of scanRepo cut to its first n requirements (and a usage of its own)
const cut = async (ok, req, n, usage) => { const b = JSON.parse(await ok(req).text()), o = JSON.parse(b.content[0].text); o.requirements = o.requirements.slice(0, n); b.content[0].text = JSON.stringify(o); if (usage) b.usage = usage; return reply(200, b); };
const unanswered = (s, n1, n3, usage) => { // 20 blocks in two parts of 10; block call 1 answers n1, call 2 everything, call 3 (the retry) n3
  let n = 0;
  s.answers((req, ok) => (/name="audit-units\.txt"/.test(req.body.messages[0].content) ? ok(req) : (++n === 1 ? cut(ok, req, n1, usage) : n === 3 ? cut(ok, req, n3) : ok(req))));
};

test('scan parts: a part that answers 1 of 10 blocks keeps the 1; the 9 go back once as a part of their own; the retry answers 5: 6 audited, 4 not audited with the reason', async (t) => {
  const s = scanRepo(t, 20, { SCAN_BATCH_BLOCKS: '10', MAX_BUDGET_USD: '50' });
  unanswered(s, 1, 5);
  await s.h.go({ GITHUB_WORKSPACE: s.root });
  const f = JSON.parse(s.h.file('findings.json')), parts = JSON.parse(s.h.file('scan-parts.json'));
  assert.equal(s.h.calls.length, 4, 'units, two block parts, one retry: never a second retry');
  assert.deepEqual(blockCalls(s.h).map(listed), [10, 10, 9]);
  assert.equal(f.requirements.length, 1 + 10 + 5);
  assert.deepEqual(parts.retried, [s.cids.slice(1, 10)]);
  assert.deepEqual(parts.failed.map((x) => [x.part, x.blocks]), [['blocks', s.cids.slice(6, 10)]]);
  assert.match(parts.failed[0].reason, /4 of 9 blocks were not answered in two attempts/);
  assert.match(s.h.file('engine-notes'), /9 unanswered blocks sent again once/);
  assert.match(s.h.file('engine-notes'), /4 blocks not audited: 4 of 9 blocks were not answered in two attempts/);
});

test('scan parts: the retry of unanswered blocks is refused when it would exceed max_budget_usd; the answers kept, the unanswered listed', async (t) => {
  const s = scanRepo(t, 20, { SCAN_BATCH_BLOCKS: '10', MAX_BUDGET_USD: '1' });
  unanswered(s, 1, 5, { input_tokens: 1000, output_tokens: 5000000 }); // that reply cost more than the whole budget
  await s.h.go({ GITHUB_WORKSPACE: s.root });
  const f = JSON.parse(s.h.file('findings.json')), parts = JSON.parse(s.h.file('scan-parts.json'));
  assert.equal(s.h.calls.length, 3);
  assert.equal(f.requirements.length, 1 + 10);
  assert.equal(parts.retried, undefined);
  assert.deepEqual(parts.failed.map((x) => x.blocks), [s.cids.slice(1, 10)]);
  assert.match(parts.failed[0].reason, /9 of 10 blocks were not answered; not retried: the retry would exceed max_budget_usd/);
});

const overflow = () => good({ stop_reason: 'max_tokens', content: [{ type: 'text', text: '{"requirements": [' }] });
const listed = (req) => new Set([...req.body.messages[0].content.matchAll(/^([0-9a-f]{8})\tdocs\/d\.md:1/gm)].map((m) => m[1])).size;

test('scan parts: a block part whose reply hit max_output_tokens is split in halves (recursively) and every block is audited', async (t) => {
  const s = scanRepo(t, 25);
  s.answers((req, ok) => (!/name="audit-units\.txt"/.test(req.body.messages[0].content) && listed(req) > 6 ? overflow() : ok(req)));
  await s.h.go({ GITHUB_WORKSPACE: s.root, MAX_BUDGET_USD: '50' });
  const f = JSON.parse(s.h.file('findings.json')), parts = JSON.parse(s.h.file('scan-parts.json'));
  assert.deepEqual(f.requirements.map((r) => r.id).sort(), s.cids.slice().sort());
  assert.deepEqual(blockCalls(s.h).map(listed), [20, 10, 5, 5, 10, 5, 5, 5]); // 20 -> 10+10 -> (10 -> 5+5) ...; the 5-block part was not split
  assert.deepEqual(parts, { calls: 9, splits: 3, failed: [], dropped: [] });
  assert.match(s.h.file('engine-notes'), /scan in 9 calls \(3 parts split after max_output_tokens\)/);
});

test('scan parts: a one-block part that still overflows fails as before; the split stops when the next calls would exceed the budget', async (t) => {
  const a = scanRepo(t, 21);
  a.answers((req, ok) => (/text 00000001\b/.test(req.body.messages[0].content) ? overflow() : ok(req)));
  await a.h.go({ GITHUB_WORKSPACE: a.root, MAX_BUDGET_USD: '50' });
  const pa = JSON.parse(a.h.file('scan-parts.json'));
  assert.deepEqual(pa.failed.map((x) => x.blocks), [[a.cids[0]]]);
  assert.match(pa.failed[0].reason, /max_output_tokens/);
  assert.equal(JSON.parse(a.h.file('findings.json')).requirements.length, 20);
  const b = scanRepo(t, 25, { MODEL: 'claude-sonnet-5-5' });
  const fat = (x) => ({ ...x, text: async () => { const j = JSON.parse(await x.text()); j.model = 'claude-sonnet-5-5'; j.usage.output_tokens = 32000; return JSON.stringify(j); } }); // every reply costs its worst case
  b.answers((req, ok) => (!/name="audit-units\.txt"/.test(req.body.messages[0].content) && listed(req) > 6 ? fat(overflow()) : fat(ok(req))));
  const ok = scanRepo(t, 25, { MODEL: 'claude-sonnet-5-5', MAX_BUDGET_USD: '50' });
  ok.answers((req, o) => o(req));
  await ok.h.go({ GITHUB_WORKSPACE: ok.root });
  const sum = ok.h.calls.reduce((x, c) => x + api.worstCase('claude-sonnet-5-5', Buffer.byteLength(JSON.stringify(c.body.system || '')), Buffer.byteLength(c.body.messages[0].content), c.body.max_tokens).usd, 0); // the initial plan's worst case
  await b.h.go({ GITHUB_WORKSPACE: b.root, MAX_BUDGET_USD: String(sum.toFixed(4)) });
  const pb = JSON.parse(b.h.file('scan-parts.json'));
  assert.ok(pb.failed.some((x) => /not split: the halves would exceed max_budget_usd/.test(x.reason)), JSON.stringify(pb));
});

test('scan parts: a one-block part that hit its priced cap is retried once with a larger cap; a second overflow fails with the reason; a budget that does not cover the retry fails it unretried', async (t) => {
  const one = (req) => req.body.max_tokens < 32000; // the only priced-down call is the one-block part
  const a = scanRepo(t, 21);
  a.answers((req, ok) => (one(req) && req.body.max_tokens <= 3500 ? overflow() : ok(req)));
  await a.h.go({ GITHUB_WORKSPACE: a.root, MAX_BUDGET_USD: '50' });
  const mine = a.h.calls.filter((c) => one(c)).map((c) => c.body.max_tokens);
  assert.deepEqual(mine, [3500, 14000]);
  assert.deepEqual(JSON.parse(a.h.file('scan-parts.json')).failed, []);
  assert.equal(JSON.parse(a.h.file('findings.json')).requirements.length, 21);
  const b = scanRepo(t, 21);
  b.answers((req, ok) => (one(req) ? overflow() : ok(req)));
  await b.h.go({ GITHUB_WORKSPACE: b.root, MAX_BUDGET_USD: '50' });
  assert.equal(b.h.calls.filter((c) => one(c)).length, 2, 'retried once, never twice');
  const pb = JSON.parse(b.h.file('scan-parts.json'));
  assert.equal(pb.failed.length, 1);
  assert.match(pb.failed[0].reason, /max_output_tokens \(14000\)/);
  const c = scanRepo(t, 21, { MODEL: 'claude-sonnet-5-5' });
  const fat = (x) => ({ ...x, text: async () => { const j = JSON.parse(await x.text()); j.model = 'claude-sonnet-5-5'; j.usage.output_tokens = 32000; return JSON.stringify(j); } }); // every reply costs its worst case
  c.answers((req, ok) => fat(one(req) ? overflow() : ok(req)));
  const base = scanRepo(t, 21, { MODEL: 'claude-sonnet-5-5', MAX_BUDGET_USD: '50' });
  base.answers((req, o) => o(req));
  await base.h.go({ GITHUB_WORKSPACE: base.root });
  const sum = base.h.calls.reduce((x, k) => x + api.worstCase('claude-sonnet-5-5', Buffer.byteLength(JSON.stringify(k.body.system || '')), Buffer.byteLength(k.body.messages[0].content), k.body.max_tokens).usd, 0);
  await c.h.go({ GITHUB_WORKSPACE: c.root, MAX_BUDGET_USD: String(sum.toFixed(4)) });
  assert.equal(c.h.calls.filter((k) => one(k)).length, 1);
  assert.match(JSON.parse(c.h.file('scan-parts.json')).failed[0].reason, /not retried: the retry with 14000 tokens would exceed max_budget_usd/);
});

test('scan parts: a failing unit call keeps the block answers; all calls failing fails the run like one call', async (t) => {
  const a = scanRepo(t, 45);
  a.answers((req, ok) => (/name="audit-units\.txt"/.test(req.body.messages[0].content) ? err(401, 'authentication_error', 'invalid x-api-key') : ok(req)));
  await a.h.go({ GITHUB_WORKSPACE: a.root });
  assert.equal(JSON.parse(a.h.file('findings.json')).requirements.length, 45);
  assert.equal(JSON.parse(a.h.file('scan-parts.json')).failed[0].part, 'units');
  const b = scanRepo(t, 45);
  b.answers(() => err(401, 'authentication_error', 'invalid x-api-key'));
  await b.h.go({ GITHUB_WORKSPACE: b.root });
  assert.equal(b.h.file('engine-status'), 'failed');
  assert.equal(b.h.file('engine-error').split('\n')[0], 'auth');
  assert.equal(b.h.file('findings.json'), null);
});

test('scan parts: a budget too small for every part drops the trailing batches (listed as dropped), the estimate of what was sent stays under the budget', async (t) => {
  const s = scanRepo(t, 45, { MODEL: 'claude-sonnet-5-5', MAX_OUTPUT_TOKENS: '4000' }); // sonnet: a 20-block batch may emit up to 4000 tokens here
  s.answers((req, ok) => ok(req));
  const all = scanRepo(t, 45, { MODEL: 'claude-sonnet-5-5', MAX_OUTPUT_TOKENS: '4000', MAX_BUDGET_USD: '5' });
  all.answers((req, ok) => ok(req));
  await all.h.go({ GITHUB_WORKSPACE: all.root });
  assert.equal(all.h.calls.length, 4);
  const per = api.worstCase('claude-sonnet-5-5', 0, Math.max(...all.h.calls.map((c) => Buffer.byteLength(c.body.messages[0].content) + Buffer.byteLength(JSON.stringify(c.body.system || '')))), 4000).usd; // the largest part
  await s.h.go({ GITHUB_WORKSPACE: s.root, MAX_BUDGET_USD: String((per * 2.5).toFixed(4)) });
  assert.ok(s.h.calls.length >= 2 && s.h.calls.length < 4, `calls: ${s.h.calls.length}`);
  const parts = JSON.parse(s.h.file('scan-parts.json'));
  assert.deepEqual(parts.dropped, s.cids.slice(s.cids.length - parts.dropped.length)); // the tail, in candidate order
  assert.ok(parts.dropped.length >= 5);
  assert.equal(JSON.parse(s.h.file('findings.json')).requirements.length + parts.dropped.length, 45);
  assert.match(s.h.file('engine-notes'), /blocks? left for the next run/);
  const none = scanRepo(t, 45, { MODEL: 'claude-opus-5-5', MAX_BUDGET_USD: '0.01' });
  await none.h.go({ GITHUB_WORKSPACE: none.root });
  assert.equal(none.h.calls.length, 0);
  assert.equal(none.h.file('engine-error').split('\n')[0], 'budget');
});

test('action.yml: scan_batch_blocks (default 20) reaches the validation, collector and engine steps; validate-inputs.sh accepts 1 to 100 only', () => {
  const yml = fs.readFileSync(path.join(__dirname, '..', 'action.yml'), 'utf8');
  assert.match(/^ {2}scan_batch_blocks: \{[^}]*\}/m.exec(yml)[0], /default: "20" \}$/);
  assert.equal(yml.split('SCAN_BATCH_BLOCKS: ${{ inputs.scan_batch_blocks }}').length - 1, 3); // validation, collector (it prices the block calls), engine
  for (const [v, code] of [['0', 1], ['101', 1], ['x', 1], ['20', 0], ['100', 0]]) assert.equal(spawnSync(bash, [path.join(__dirname, 'validate-inputs.sh')], { env: { ...process.env, ENGINE: 'claude', SCAN_BATCH_BLOCKS: v }, encoding: 'utf8' }).status, code, v);
});

test('windowPack: a large file shows the lines around each cited line (line-numbered) and its header, not the whole file; a small file is shown whole; windowed files are listed as partial', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'big.cjs'), Array.from({ length: 3000 }, (_, i) => `line ${i + 1}`).join('\n') + '\n');
  fs.writeFileSync(path.join(root, 'small.js'), 'exports.a = 1;\n');
  const r = api.windowPack(root, new Map([['big.cjs', [900]], ['small.js', [1]]]), 60000);
  assert.match(r.text, /^ 900\| line 900$/m);
  assert.match(r.text, /^ 860\| line 860$/m);
  assert.match(r.text, /^   1\| line 1$/m, 'the header lines');
  assert.doesNotMatch(r.text, /^2000\| /m, 'far from the cited line');
  assert.match(r.text, /exports\.a = 1;/);
  assert.deepEqual(r.notWhole, ['big.cjs']);
});

test('scan parts: each block part carries the full text of its blocks (audit-blocks.txt rows), also past the 240-character candidate cut', async (t) => {
  const s = scanRepo(t, 25), tail = 'DECISIVE_CLAUSE_AFTER_300';
  s.answers((req, ok) => ok(req));
  fs.writeFileSync(path.join(s.h.ctx, 'audit-blocks.txt'), s.cids.map((c, i) => `${c}\t${i === 22 ? 'x'.repeat(300) + tail : `body of ${c}`}\n`).join(''));
  await s.h.go({ GITHUB_WORKSPACE: s.root });
  const calls = blockCalls(s.h).map((c) => c.body.messages[0].content);
  assert.equal(calls.length, 2);
  assert.ok(!calls[0].includes(tail) && calls[1].includes(tail), 'the long block is whole in its own part only');
  assert.match(calls[1], /name="audit-blocks\.txt"/);
  assert.ok(calls[0].includes(`body of ${s.cids[0]}`) && !calls[0].includes(`body of ${s.cids[24]}`));
});

test('context pack: a long matching test with its assertion outside the slice remains incomplete', async (t) => {
  const r = sliceRepo(t, () => false);
  const body = `test('long computation', () => {\n  const actual = computeTotal(1);\n${'  prepare();\n'.repeat(100)}  assert.equal(actual, 1);\n});\n`;
  fs.writeFileSync(path.join(r.root, 'test/svc.test.js'), bigTest(() => false) + body);
  await r.go();
  assert.match(r.user(), /const actual = computeTotal\(1\)/);
  assert.doesNotMatch(r.user(), /assert.equal\(actual, 1\)/);
  assert.equal(r.h.file('pack-cut.txt'), 'test/svc.test.js');
  assert.match(r.user(), /matching tests were truncated/);
});

test('context pack: unreadable candidate tests are listed as incomplete', async (t) => {
  const r = repo(t, { 'src/a.js': 'function alpha() {}\n' }, {
    'files.txt': 'src/a.js\n', 'test-candidates.txt': 'src/a.js\n  test/missing.test.js  (same stem)\n',
  });
  await r.go();
  assert.equal(r.h.file('pack-cut.txt'), 'test/missing.test.js');
});

test('windowPack: omitted and partial evidence files are reported instead of claiming a complete pack', (t) => {
  const r = repo(t, { 'big.js': lineText(3000), 'small.js': 'exports.a = 1;\n' });
  const packed = api.windowPack(r.root, new Map([['big.js', [900]], ['missing.test.js', [1]], ['small.js', [1]]]), 60000);
  assert.deepEqual(packed.notWhole, ['big.js', 'missing.test.js']);
  const tight = api.windowPack(r.root, new Map([['big.js', [900]], ['small.js', [1]]]), 100);
  assert.deepEqual(tight.notWhole, ['big.js', 'small.js']);
});

// --- unit part test slices and block evidence in the single-call pack (audit F27, F28) ---
const tmpRepo = (t, files, ctxFiles) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ev-')), ctx = path.join(root, '.ctx');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [base, fs0] of [[root, files], [ctx, ctxFiles]]) for (const [n, c] of Object.entries(fs0)) { fs.mkdirSync(path.dirname(path.join(base, n)), { recursive: true }); fs.writeFileSync(path.join(base, n), c); }
  return { root, ctx };
};
const unitName = (i) => `unit${String(i).padStart(3, '0')}`;
const unitsRepo = (t, n, part, pad = 200) => tmpRepo(t, {
  'src/units.js': Array.from({ length: n }, (_, i) => `function ${unitName(i)}(value) { return value + ${i}; } // ${'x'.repeat(pad)}`).join('\n') + '\n',
  'tests/units.test.js': Array.from({ length: n }, (_, i) => `test('unit ${i}', () => { assert.equal(${unitName(i)}(1), ${i + 1}); }); // ${'x'.repeat(pad * 3)}`).join('\n') + '\n',
}, { 'audit-units.txt': `aaaaaaaa\tsrc/units.js\t5\twhy\ttests/units.test.js\t-\tv1\t${part}\n` });

test('context pack (N3): the test slices follow the unit part\'s lines, not the first symbols of the file', (t) => {
  const r = unitsRepo(t, 200, 'part 2/2 lines 101-200', 80);
  const p = api.contextPack(r.ctx, r.root, 250000);
  assert.ok(p.text.includes('function unit170'));
  assert.ok(p.text.includes('assert.equal(unit170('), 'the current part\'s assertion is visible');
  assert.ok(!p.text.includes('assert.equal(unit050('), 'the tests of the other part are not (beyond the head of the file)');
  assert.deepEqual(p.notWhole, []);
  const big = unitsRepo(t, 200, 'part 2/2 lines 101-200'); // the audit's fixture: the part's 100 matching tests do not fit the per-file cap
  assert.ok(api.contextPack(big.ctx, big.root, 250000).notWhole.includes('tests/units.test.js'), 'what does not fit is listed as cut');
});

test('context pack (N3): more symbols in the unit part than the cap -> the test file is listed as cut, never a silent complete', (t) => {
  const r = unitsRepo(t, 400, 'part 1/1 lines 1-400', 20);
  const p = api.contextPack(r.ctx, r.root, 250000);
  assert.ok(p.notWhole.includes('tests/units.test.js'), JSON.stringify(p.notWhole));
});

test('context pack (N3 control): a small whole file is shown whole and nothing is listed as cut', (t) => {
  const r = unitsRepo(t, 5, '-', 5);
  const p = api.contextPack(r.ctx, r.root, 250000);
  assert.ok(p.text.includes('assert.equal(unit000(') && p.text.includes('assert.equal(unit004('));
  assert.deepEqual(p.notWhole, []);
});

// N4: evidence rows of the candidate blocks reach the model at batch-1, batch and batch+1 blocks
const evRepo = (t, n) => {
  const cid = (i) => i.toString(16).padStart(8, '0');
  return tmpRepo(t, { 'config/policy.yaml': 'amount_minimum: 10\n', 'tests/policy.test.js': 'test("minimum", () => { assert.equal(policy.amount_minimum, 10); });\n' }, {
    'audit-candidates.txt': Array.from({ length: n }, (_, i) => `${cid(i)}\tdocs/design.md:${i + 1}\tPolicy\tMinimum must be 10.`).join('\n') + '\n',
    'audit-evidence.txt': Array.from({ length: n }, (_, i) => `${cid(i)}\tcode\tconfig/policy.yaml:1\tamount_minimum: 10\n${cid(i)}\ttest\ttests/policy.test.js:1\tassert.equal(policy.amount_minimum, 10)`).join('\n') + '\n',
  });
};
const packFor = (r, limit) => { // the pack of the first call the scan would make: a block part when split, else the single call's pack
  const split = require('./scan-parts.js').plan({ ctx: r.ctx, root: r.root, batch: 20, limit, schemaFile: path.join(__dirname, 'audit.schema.json'), contextPack: api.contextPack, evidencePack: api.evidencePack, assembleAudit: require('./prompt.js').assembleAudit });
  return { split, pack: split ? split.parts[split.parts.length - 1].pack : api.contextPack(r.ctx, r.root, limit) };
};
for (const n of [19, 20, 21]) {
  test(`evidence (N4): ${n} candidate blocks with batch 20 -> the cited config file is in the pack`, (t) => {
    const { split, pack } = packFor(evRepo(t, n), 250000);
    assert.equal(split === null, n <= 20);
    assert.ok(pack.text.includes('amount_minimum: 10'));
    assert.ok(pack.text.includes('assert.equal(policy.amount_minimum, 10)'));
    assert.deepEqual(pack.notWhole, []);
  });
}
test('evidence (N4): a budget too small for the cited files lists them as cut, at every block count', (t) => {
  for (const n of [19, 21]) assert.deepEqual([...packFor(evRepo(t, n), 100).pack.notWhole].sort(), ['config/policy.yaml', 'tests/policy.test.js'], `n=${n}`);
});

test('evidence (N4): a cut evidence file is recorded per block (blockCuts) in the single call, which writes scan-parts.json for audit-post', async (t) => {
  const e = evRepo(t, 3), ctxFiles = Object.fromEntries(['audit-candidates.txt', 'audit-evidence.txt'].map((n) => [n, fs.readFileSync(path.join(e.ctx, n), 'utf8')]));
  const r = repo(t, { 'config/policy.yaml': 'amount_minimum: 10\n', 'tests/policy.test.js': 'test("minimum", () => { assert.equal(policy.amount_minimum, 10); });\n' }, ctxFiles, { CHECK: 'audit', CONTEXT_PACK_BYTES: '100' });
  await r.go();
  const cuts = JSON.parse(r.h.file('scan-parts.json')).blockCuts;
  assert.deepEqual(Object.keys(cuts).sort(), ['00000000', '00000001', '00000002']);
  assert.deepEqual([...cuts['00000000']].sort(), ['config/policy.yaml', 'tests/policy.test.js']);
});

test('evidence (N4): a file shown only as slices is windowed again for the lines the evidence cites', (t) => {
  const r = unitsRepo(t, 200, 'part 2/2 lines 101-200', 80);
  fs.writeFileSync(path.join(r.ctx, 'audit-evidence.txt'), '1111111a\ttest\ttests/units.test.js:50\tassert.equal(unit049(1), 50)\n');
  const p = api.contextPack(r.ctx, r.root, 250000);
  assert.ok(p.text.includes('assert.equal(unit049('), 'the cited line 50 is visible');
  assert.deepEqual(p.notWhole, ['tests/units.test.js'], 'the file is still not whole');
  assert.deepEqual(p.blockCuts, { '1111111a': ['tests/units.test.js'] });
});

test('evidence (Q8): from the real collector, the validator the requirement names is in the single-call pack, or listed as cut', (t) => {
  const { execFileSync } = require('node:child_process');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'q8-')), ctx = path.join(root, '.ctx');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const files = {
    'specs/contract.md': '# Contract\n\nAC-1: The validator rejects negative invoice amounts before charging.\n',
    'app/selection.js': Array.from({ length: 30 }, (_, i) => `exports.select${i} = value => value ? ${i} : 0;`).join('\n') + '\n',
    'billing/validator.js': 'function validateInvoice(amount) {\n  if (amount < 0) throw new Error("validator rejects negative invoice amounts before charging");\n  return amount;\n}\nmodule.exports = { validateInvoice };\n',
    'billing/validator.test.js': 'const test = require("node:test"), assert = require("node:assert/strict");\nconst { validateInvoice } = require("./validator");\ntest("validator rejects negative invoice amounts before charging", () => {\n  assert.throws(() => validateInvoice(-1));\n});\n',
  };
  for (const [f, s] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true }); fs.writeFileSync(path.join(root, f), s); }
  const git = (...a) => execFileSync('git', ['-c', 'core.autocrlf=false', ...a], { cwd: root, stdio: 'ignore' });
  git('init'); git('config', 'user.name', 't'); git('config', 'user.email', 't@example.invalid'); git('add', '.'); git('commit', '-m', 'init');
  require('./audit-collect').collect({ cwd: root, ctx, reqPaths: 'specs/**', maxUnits: 1 });
  assert.ok(fs.readFileSync(path.join(ctx, 'audit-evidence.txt'), 'utf8').includes('billing/validator.js'));
  assert.ok(fs.readFileSync(path.join(ctx, 'audit-units.txt'), 'utf8').includes('app/selection.js'));
  const p = api.contextPack(ctx, root, 250000);
  assert.ok(p.text.includes('validator rejects negative invoice amounts') || p.notWhole.includes('billing/validator.js'));
  assert.ok(p.text.includes('validator rejects negative invoice amounts'), 'with a normal budget it is visible');
  const tight = api.contextPack(ctx, root, 100);
  assert.ok(Object.values(tight.blockCuts).some((f) => f.includes('billing/validator.js')), 'with no room it is cut for its block');
});

// S3: a big test file shared by several review files is sliced around the symbols of all of them
const sharedRepo = (t, extra = {}) => {
  const pad = 'x'.repeat(100), tests = [];
  for (let i = 0; i < 400; i++) tests.push(`test('filler ${i}', () => { assert.equal(filler${i}(1), ${i}); }); // ${pad}`);
  tests.splice(100, 0, "test('alpha', () => {\n  assert.equal(alphaThing(1), 111);\n});");
  tests.splice(300, 0, "test('beta', () => {\n  assert.equal(betaThing(2), 222);\n});");
  const diff = (p, fn) => `diff --git a/${p} b/${p}\n--- a/${p}\n+++ b/${p}\n@@ -0,0 +1,2 @@\n+function ${fn}(v) { return v; }\n+module.exports = { ${fn} };\n`;
  return tmpRepo(t, { 'src/a.js': 'function alphaThing(v) { return v + 110; }\n', 'src/b.js': 'function betaThing(v) { return v + 220; }\n', 'tests/shared.test.js': tests.join('\n') + '\n', 'tests/only-b.test.js': tests.join('\n') + '\n', ...extra }, {
    'files.txt': 'src/a.js\nsrc/b.js\n', 'diff.patch': diff('src/a.js', 'alphaThing') + diff('src/b.js', 'betaThing'),
    'test-candidates.txt': 'src/a.js\n  tests/shared.test.js  (name)\nsrc/b.js\n  tests/shared.test.js  (name)\n  tests/only-b.test.js  (name)\n' });
};

test('context pack (S3): a big test shared by two review files shows the assertions of both, not only those of the first', (t) => {
  const r = sharedRepo(t), p = api.contextPack(r.ctx, r.root, 250000);
  const shared = p.text.slice(p.text.indexOf('tests/shared.test.js'), p.text.indexOf('tests/only-b.test.js'));
  assert.ok(shared.includes('assert.equal(alphaThing(1), 111)'));
  assert.ok(shared.includes('assert.equal(betaThing(2), 222)'), 'the second file\'s assertion is visible too');
  assert.ok(!p.notWhole.includes('tests/shared.test.js'));
  assert.equal((p.text.match(/tests\/shared\.test\.js/g) || []).length, 1, 'still added once');
});

test('context pack (S3 control): a big test used by one review file is sliced around that file\'s symbols only', (t) => {
  const r = sharedRepo(t), p = api.contextPack(r.ctx, r.root, 250000);
  const only = p.text.slice(p.text.indexOf('tests/only-b.test.js'));
  assert.ok(only.includes('assert.equal(betaThing(2), 222)'));
  assert.ok(!only.includes('assert.equal(alphaThing(1), 111)'));
});

test('context pack (S3): when the union of symbols does not fit, the shared test is listed as cut', (t) => {
  const r = sharedRepo(t), p = api.contextPack(r.ctx, r.root, 650);
  assert.ok(p.notWhole.includes('tests/shared.test.js'), JSON.stringify(p.notWhole));
});

// S7: a pack that throws must not look like a pack that cut nothing
test('pack error (S7): the single call lists the review files and their candidate tests in pack-cut.txt and warns with the error\'s first line', async (t) => {
  const r = repo(t, { 'src.js': 'a();\n' }, { 'files.txt': 'src.js\nb.js\n', 'test-candidates.txt': 'src.js\n  test.js  (same stem)\nb.js\n  (no candidate test file found)\n' });
  await r.go({ GITHUB_WORKSPACE: path.join(r.h.dir, 'does-not-exist') });
  assert.equal(r.h.file('pack-cut.txt'), 'src.js\ntest.js\nb.js');
  assert.ok(r.h.logged.some((l) => /^::warning::Context pack failed \(.*ENOENT.*\)/.test(l)), r.h.logged.join('|'));
  assert.ok(r.h.file('findings.json'), 'the review itself still ran');
});

test('pack error (S7): scan-parts returns the unit files and their tests as cut, not []', (t) => {
  const r = tmpRepo(t, { 'src/a.js': 'x\n' }, { 'audit-units.txt': 'aaaaaaaa\tsrc/a.js\t5\tno test\ttests/a.test.js, tests/b.test.js\t-\tabcdef12\t-\n', 'audit-candidates.txt': Array.from({ length: 21 }, (_, i) => `${i.toString(16).padStart(8, '0')}\td.md:${i + 1}\tH\ttext`).join('\n') + '\n' });
  const log = console.log; console.log = () => {};
  let plan; try { plan = require('./scan-parts.js').plan({ ctx: r.ctx, root: r.root, batch: 20, limit: 250000, schemaFile: path.join(__dirname, 'audit.schema.json'), contextPack: () => { throw new Error('injected'); }, evidencePack: api.evidencePack, assembleAudit: require('./prompt.js').assembleAudit }); } finally { console.log = log; }
  assert.deepEqual(plan.packCut, ['src/a.js', 'tests/a.test.js', 'tests/b.test.js']);
});

test('auth reasons tell the owner what to fix: no key, 401 rejected, 403 lacks permission; the log names class and HTTP status', async (t) => {
  const none = harness(t, [good()]);
  await none.go({ ANTHROPIC_API_KEY: '' });
  assert.match(none.file('engine-error'), /^auth\nNo API key was provided \(set llm_token\)/);
  assert.match(none.logged.join('\n'), /::warning::Claude review failed \(auth\): No API key was provided/);
  const f = harness(t, [err(403, 'permission_error', 'not allowed')]);
  await f.go();
  assert.equal(f.calls.length, 1);
  assert.match(f.file('engine-error'), /^auth\nThe Anthropic API key lacks permission for this model or workspace/);
  assert.match(f.logged.join('\n'), /\(auth, HTTP 403\)/);
  assert.equal(api.classify(401, 'authentication_error', 'x')[1], 'The Anthropic API key was rejected (check the llm_token secret)');
});

test('classify: credit/billing is quota and unknown model is model (config); 429 and 529 are rate (transient)', () => {
  assert.equal(api.classify(400, 'invalid_request_error', 'Your credit balance is too low')[0], 'quota');
  assert.equal(api.classify(402, '', '')[0], 'quota');
  assert.equal(api.classify(404, 'not_found_error', 'model: x')[0], 'model');
  assert.equal(api.classify(429, 'rate_limit_error', 'slow down')[0], 'rate');
  assert.equal(api.classify(529, 'overloaded_error', 'busy')[0], 'rate');
  assert.equal(api.classify(500, 'api_error', 'oops')[0], '');
});

// --- a configuration failure in one part of a split scan fails the job; the parts that succeeded are kept ---
// Runs the real chain: planner + adapter (api.run) -> audit-post -> fail-on-error.js. `second` is the reply of every call after the first.
async function scanChain(t, second, env = {}) {
  const s = scanRepo(t, 2, { SCAN_BATCH_BLOCKS: '1', ...env }), head = 'a'.repeat(40);
  s.answers((req, ok) => (req === s.h.calls[0] ? ok(req) : second));
  fs.writeFileSync(path.join(s.h.ctx, 'audit-meta.json'), JSON.stringify({ head, max_requirements: 80, candidates: 2, candidates_listed: 2, units: { total: 3, picked: 3 }, max_units: 12 }));
  await s.h.go({ GITHUB_WORKSPACE: s.root });
  const saved = { ...process.env }, outputs = {};
  try {
    Object.assign(process.env, { CTX: s.h.ctx, GITHUB_WORKSPACE: s.root, SCAN_ISSUE: 'false', ENGINE: 'claude', MODEL: 'claude-haiku-5-5' });
    const summary = { addRaw() { return this; }, async write() {} };
    await require('./audit-post.js')({ github: {}, context: { repo: { owner: 'o', repo: 'r' }, sha: head }, core: { setOutput: (k, v) => { outputs[k] = v; }, warning() {}, summary } });
  } finally { for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]; Object.assign(process.env, saved); }
  const gate = (FAIL_ON_ERROR) => spawnSync(process.execPath, [path.join(__dirname, 'fail-on-error.js')], { encoding: 'utf8', env: { ...process.env, CTX: s.h.ctx, STATUS: outputs.status, REASON: outputs.reason || '', FAIL_ON_ERROR } });
  return { s, outputs, gate };
}

for (const [name, reply, cls] of [['quota', err(402, 'billing_error', 'no credit balance'), 'quota'], ['auth', err(401, 'authentication_error', 'invalid x-api-key'), 'auth']]) {
  test(`scan parts: 200 then ${name}: findings of the first part are kept, status incomplete, engine-error says ${cls}, the gate fails even without fail_on_error`, async (t) => {
    const { s, outputs, gate } = await scanChain(t, reply);
    assert.equal(s.h.calls.length, 3);
    assert.equal(JSON.parse(s.h.file('findings.json')).unit_findings.length, 1, 'part 1 is kept');
    assert.equal(outputs.status, 'incomplete');
    assert.match(s.h.file('engine-error'), new RegExp(`^${cls}\\n.*; 1 of 3 parts were reviewed$`));
    for (const f of ['false', 'true']) {
      const g = gate(f);
      assert.equal(g.status, 1);
      assert.match(g.stdout, new RegExp(`^::error::SpecGuard could not finish the scan \\(${cls}\\): .*; 1 of 3 parts were reviewed; the partial result was kept`));
    }
  });
}

test('scan parts: 200 then a rate limit stays incomplete with a warning and exit 0 (no engine-error)', async (t) => {
  const { s, outputs, gate } = await scanChain(t, err(529, 'overloaded_error', 'busy'));
  assert.equal(outputs.status, 'incomplete');
  assert.equal(s.h.file('engine-error'), null);
  const g = gate('true');
  assert.equal(g.status, 0);
  assert.match(g.stdout, /^::warning::SpecGuard result is incomplete/);
});

test('scan parts: the budget stop (parts left for the next run) stays incomplete, exit 0', async (t) => {
  const { s, outputs, gate } = await scanChain(t, err(402, 'billing_error', 'never reached'), { MAX_BUDGET_USD: '0.02' });
  assert.equal(s.h.calls.length, 1, 'the second part was dropped, not sent');
  assert.equal(s.h.file('engine-error'), null);
  assert.equal(outputs.status, 'incomplete');
  assert.equal(gate('true').status, 0);
});

test('fail-on-error.js: incomplete without engine-error, with a non-configuration class, or reduced exits 0; incomplete with a configuration class exits 1', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'specguard-foe2-'));
  try {
    const run = (STATUS = 'incomplete') => spawnSync(process.execPath, [path.join(__dirname, 'fail-on-error.js')], { encoding: 'utf8', env: { ...process.env, STATUS, CTX: dir, REASON: 'r', FAIL_ON_ERROR: 'true' } });
    assert.equal(run().status, 0, 'no engine-error');
    fs.writeFileSync(path.join(dir, 'engine-error'), 'rate\nbusy\n');
    assert.equal(run().status, 0, 'rate');
    fs.writeFileSync(path.join(dir, 'counts.json'), JSON.stringify({ reduced: true }));
    fs.writeFileSync(path.join(dir, 'engine-error'), 'policy\nblocked\n');
    assert.equal(run().status, 1, 'policy fails even when incomplete');
    fs.rmSync(path.join(dir, 'engine-error'));
    assert.equal(run().status, 0, 'a reduced fast-tier run');
    assert.match(run().stdout, /reduced review/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// unit rooms: one unit part per room (audit-unit-rooms.json), no document blocks at all
function roomRepo(t, env = {}, rooms = [['aaaaaaaa'], ['bbbbbbbb'], ['cccccccc']], unitRows = null) {
  const name = { aaaaaaaa: 'lib/a.js', bbbbbbbb: 'lib/b.js', cccccccc: 'lib/c.js' }, fn = { aaaaaaaa: 'alpha', bbbbbbbb: 'beta', cccccccc: 'gamma' };
  const ok = (req) => {
    const u = req.body.messages[0].content, ids = [...u.matchAll(/^([0-9a-f]{8})\tlib\//gm)].map((m) => m[1]);
    return good({ content: [{ type: 'text', text: JSON.stringify({ docs_reviewed: [], requirements: [], not_requirements: [], not_reviewed: [], unit_findings: ids.map((id) => ({ unit: id, kind: 'missing_test', path: name[id], line: 1, quote: `function ${fn[id]}() {}`, title: 't' })) }) }] });
  };
  const r = repo(t, { 'lib/a.js': 'function alpha() {}\n', 'lib/b.js': 'function beta() {}\n', 'lib/c.js': 'function gamma() {}\n' }, {
    'audit-candidates.txt': '', 'audit-docs.txt': '', 'audit-meta.json': JSON.stringify({ max_requirements: 80, units: { total: 3, picked: 3 }, max_units: 12 }),
    'audit-unit-rooms.json': JSON.stringify(rooms),
    'audit-units.txt': unitRows || ['aaaaaaaa\tlib/a.js\t1\tw\tnone\t-\t-\t-\n','bbbbbbbb\tlib/b.js\t1\tw\tnone\t-\t-\t-\n', 'cccccccc\tlib/c.js\t1\tw\tnone\t-\t-\t-\n'].join('') }, { CHECK: 'audit', ...env });
  return { ...r, answers: (f) => { r.h.answers[0] = (req) => f(req, ok); } };
}
const unitsIn = (c) => [...c.body.messages[0].content.matchAll(/^([0-9a-f]{8})\tlib\//gm)].map((m) => m[1]);

test('unit rooms: a stateless run lists two parts of one unit as id:part, and each call gets only its own part', async (t) => {
  const rows = ['aaaaaaaa\tlib/a.js\t1\tw\tnone\t-\t-\tpart 1/2 lines 1-1\n', 'aaaaaaaa\tlib/a.js\t1\tw\tnone\t-\t-\tpart 2/2 lines 2-2\n'].join('');
  const s = roomRepo(t, {}, [['aaaaaaaa:1'], ['aaaaaaaa:2']], rows);
  s.answers((req, ok) => ok(req));
  await s.h.go({ GITHUB_WORKSPACE: s.root });
  assert.deepEqual(s.h.calls.map((c) => [...c.body.messages[0].content.matchAll(/^aaaaaaaa\t.*?\t(part \d\/2)/gm)].map((m) => m[1])), [['part 1/2'], ['part 2/2']]);
});

test('unit rooms: three rooms make three unit parts (one call each, only that room\'s units in the prompt); every finding is merged; the run is not split when there is one room', async (t) => {
  const s = roomRepo(t);
  s.answers((req, ok) => ok(req));
  await s.h.go({ GITHUB_WORKSPACE: s.root });
  assert.deepEqual(s.h.calls.map(unitsIn), [['aaaaaaaa'], ['bbbbbbbb'], ['cccccccc']]);
  assert.deepEqual(JSON.parse(s.h.file('findings.json')).unit_findings.map((f) => f.unit), ['aaaaaaaa', 'bbbbbbbb', 'cccccccc']);
  assert.deepEqual(JSON.parse(s.h.file('scan-parts.json')), { calls: 3, failed: [], dropped: [] });
  assert.match(s.h.file('engine-notes'), /scan in 3 calls/);
  const one = roomRepo(t, {}, [['aaaaaaaa', 'bbbbbbbb', 'cccccccc']]); // control: one room is today's single call
  one.answers((req, ok) => ok(req));
  await one.h.go({ GITHUB_WORKSPACE: one.root });
  assert.equal(one.h.calls.length, 1);
  assert.equal(one.h.file('scan-parts.json'), null, 'no scan-parts.json for a single call');
});

test('unit rooms: a budget for two calls drops the third unit part; its units are listed as not reached (droppedUnits), the estimate of what was sent stays under the budget', async (t) => {
  const env = { MODEL: 'claude-sonnet-5-5', MAX_OUTPUT_TOKENS: '4000' }, all = roomRepo(t, { ...env, MAX_BUDGET_USD: '5' });
  all.answers((req, ok) => ok(req));
  await all.h.go({ GITHUB_WORKSPACE: all.root });
  assert.equal(all.h.calls.length, 3);
  const per = api.worstCase('claude-sonnet-5-5', 0, Math.max(...all.h.calls.map((c) => Buffer.byteLength(c.body.messages[0].content) + Buffer.byteLength(JSON.stringify(c.body.system || '')))), 4000).usd;
  const s = roomRepo(t, env);
  s.answers((req, ok) => ok(req));
  await s.h.go({ GITHUB_WORKSPACE: s.root, MAX_BUDGET_USD: String((per * 2.5).toFixed(4)) });
  assert.deepEqual(s.h.calls.map(unitsIn), [['aaaaaaaa'], ['bbbbbbbb']]);
  const parts = JSON.parse(s.h.file('scan-parts.json'));
  assert.deepEqual(parts.droppedUnits, ['cccccccc']);
  assert.deepEqual(parts.dropped, []);
  assert.equal(JSON.parse(s.h.file('findings.json')).unit_findings.length, 2);
  assert.match(s.h.file('engine-notes'), /1 unit not reached \(max_budget_usd\)/);
});

test('unit rooms: one unit part failing (529) leaves only its own units unseen; the other parts\' findings are kept and its pack-cut covers the parts that answered', async (t) => {
  const s = roomRepo(t);
  s.answers((req, ok) => (unitsIn(req)[0] === 'bbbbbbbb' ? err(529, 'overloaded_error', 'Overloaded') : ok(req)));
  await s.h.go({ GITHUB_WORKSPACE: s.root });
  assert.deepEqual(JSON.parse(s.h.file('findings.json')).unit_findings.map((f) => f.unit), ['aaaaaaaa', 'cccccccc']);
  const parts = JSON.parse(s.h.file('scan-parts.json'));
  assert.equal(parts.failed.length, 1);
  assert.equal(parts.failed[0].part, 'units');
  assert.deepEqual(parts.failed[0].units, ['bbbbbbbb'], 'the failed part records which units it held');
  assert.notEqual(s.h.file('pack-cut.txt'), null, 'the parts that answered still write their pack-cut');
  assert.equal(s.h.file('engine-status'), null, 'a partial success');
});

test('unit rooms: pack-cut.txt names the units of the call whose pack cut a file, so a test shown whole in unit A\'s call is not cut for A', async (t) => {
  const rows = ['aaaaaaaa\tlib/a.js\t1\tw\tlib/t.test.js\t-\t-\t-\n', 'bbbbbbbb\tlib/b.js\t1\tw\tlib/t.test.js\t-\t-\t-\t-\n'].join(''); // b's collector list drops the test (counted out), a's keeps it
  const s = roomRepo(t, {}, [['aaaaaaaa'], ['bbbbbbbb']], rows);
  fs.writeFileSync(path.join(s.root, 'lib/t.test.js'), "it('t', () => {});\n");
  s.answers((req, ok) => ok(req));
  await s.h.go({ GITHUB_WORKSPACE: s.root });
  assert.equal(s.h.file('pack-cut.txt'), 'lib/t.test.js\tbbbbbbbb');
});

// --- PR pack: large changed and candidate files are sliced around the diff's own hunks, never kept as a head cut ---
const hunkDiff = (p, start, lines) => `diff --git a/${p} b/${p}\n--- a/${p}\n+++ b/${p}\n@@ -${start - 1},0 +${start},${lines.length} @@\n${lines.map((l) => `+${l}`).join('\n')}\n`;
const padLine = (n = 900) => `// ${'x'.repeat(n)}`;

test('PR pack: a changed 4000-line test file shows the tests the PR added at its end, not only the head', (t) => {
  const lines = Array.from({ length: 4000 }, (_, i) => `test('filler ${i}', () => { assert.ok(${i}); }); // ${'x'.repeat(40)}`);
  const added = ["test('added by the PR', () => {", ...Array.from({ length: 49 }, (_, i) => `  assert.ok(ADDED_MARK_${i});`), '});'];
  lines.splice(3899, 51, ...added); // lines 3900-3950
  const r = tmpRepo(t, { 'tests/big.test.js': lines.join('\n') + '\n' }, { 'files.txt': 'tests/big.test.js\n', 'diff.patch': hunkDiff('tests/big.test.js', 3900, added) });
  const p = api.contextPack(r.ctx, r.root, 250000);
  assert.ok(p.text.includes("test('added by the PR'") && p.text.includes('ADDED_MARK_0') && p.text.includes('ADDED_MARK_48'), 'the added test and its whole block are shown');
  assert.ok(p.notWhole.includes('tests/big.test.js'), 'still not whole');
  assert.equal(p.shown.get('tests/big.test.js'), 4000, 'every changed line was shown (post.js then raises no "Review context was cut" for it)');
});

const hitRepo = (t, extra = {}) => {
  const lines = Array.from({ length: 2000 }, () => padLine());
  lines[1500] = "test('hit', () => {"; for (let i = 1501; i < 1531; i++) lines[i] = `  // body ${'y'.repeat(900)}`;
  lines[1502] = '  assert.equal(alphaThing(1), 1);'; lines[1531] = '});'; lines[1532] = "test('after', () => {";
  return tmpRepo(t, { 'src/a.js': 'function alphaThing(v) { return v; }\n', 'tests/c.test.js': lines.join('\n') + '\n', ...extra }, {
    'files.txt': 'src/a.js\n', 'diff.patch': hunkDiff('src/a.js', 1, ['function alphaThing(v) { return v; }']), 'test-candidates.txt': 'src/a.js\n  tests/c.test.js  (name)\n' });
};

test('PR pack: a big candidate test shows the block with the symbol hit when the head plus the block do not fit', (t) => {
  const r = hitRepo(t), p = api.contextPack(r.ctx, r.root, 250000);
  assert.ok(p.text.includes('assert.equal(alphaThing(1), 1)'), 'the hit block is shown');
});

test('PR pack: a big candidate test with no hit is omitted and listed as cut, with no head lines', (t) => {
  const r = hitRepo(t, { 'tests/d.test.js': Array.from({ length: 2000 }, () => padLine()).join('\n') + '\n' });
  fs.writeFileSync(path.join(r.ctx, 'test-candidates.txt'), 'src/a.js\n  tests/d.test.js  (name)\n');
  const p = api.contextPack(r.ctx, r.root, 250000);
  assert.ok(!p.text.includes('name="tests/d.test.js"'), 'no block for it');
  assert.ok(p.notWhole.includes('tests/d.test.js'));
});

test('PR pack: five candidate tests of one review file each get at least 8 KB while the budget allows', (t) => {
  const cands = [1, 2, 3, 4, 5].map((k) => {
    const lines = Array.from({ length: 100 }, () => padLine());
    lines[60] = `test('hit ${k}', () => {`; for (let i = 62; i < 69; i++) lines[i] = `  // body ${'y'.repeat(900)}`; lines[61] = `  assert.equal(alphaThing(${k}), ${k}); // HIT_${k}`; lines[69] = '});'; lines[70] = "test('after', () => {"; // a 7 KB block
    return [`tests/t${k}.test.js`, lines.join('\n') + '\n'];
  });
  const r = tmpRepo(t, { 'src/a.js': 'function alphaThing(v) { return v; }\n', 'src/r2.js': 'x();\n', 'src/r3.js': 'y();\n', ...Object.fromEntries(cands) }, {
    'files.txt': 'src/a.js\nsrc/r2.js\nsrc/r3.js\n', 'diff.patch': hunkDiff('src/a.js', 1, ['function alphaThing(v) { return v; }']),
    'test-candidates.txt': `src/a.js\n${cands.map(([n]) => `  ${n}  (name)\n`).join('')}` });
  const limit = 100000, p = api.contextPack(r.ctx, r.root, limit);
  for (let k = 1; k <= 5; k++) assert.ok(p.text.includes(`HIT_${k}`), `candidate ${k} is shown`);
  assert.ok(Buffer.byteLength(p.text) <= limit, 'the pack stays within CONTEXT_PACK_BYTES');
});

test('PR pack (control): a changed file that fits whole is shown whole and unlisted', (t) => {
  const r = tmpRepo(t, { 'src/s.js': 'a();\nb();\nc();\n' }, { 'files.txt': 'src/s.js\n', 'diff.patch': hunkDiff('src/s.js', 2, ['b();']) });
  const p = api.contextPack(r.ctx, r.root, 250000);
  assert.ok(p.text.includes('note="full file, line-numbered">\n   1| a();\n   2| b();\n   3| c();\n</untrusted-data>'));
  assert.deepEqual(p.notWhole, []);
  assert.equal(p.shown.size, 0);
});

test('PR pack (control): the pack never exceeds CONTEXT_PACK_BYTES, however tight', (t) => {
  const r = hitRepo(t);
  for (const limit of [500, 5000, 20000, 60000]) assert.ok(Buffer.byteLength(api.contextPack(r.ctx, r.root, limit).text) <= limit + 400, `limit ${limit}`); // +400: the one-line header
});

const partRows = ['aaaaaaaa\tlib/a.js\t1\tw\tnone\t-\t-\tpart 1/2 lines 1-1\n', 'bbbbbbbb\tlib/b.js\t1\tw\tnone\t-\t-\t-\n', 'aaaaaaaa\tlib/a.js\t1\tw\tnone\t-\t-\tpart 2/2 lines 2-2\n'].join('');

test('unit rooms: a budget for one call drops the room of a second part; the unit stays reached and the part is named (droppedParts), not counted as a unit not reached', async (t) => {
  const env = { MODEL: 'claude-sonnet-5-5', MAX_OUTPUT_TOKENS: '4000' }, rooms = [['aaaaaaaa:1', 'bbbbbbbb'], ['aaaaaaaa:2']];
  const all = roomRepo(t, { ...env, MAX_BUDGET_USD: '5' }, rooms, partRows);
  all.answers((req, ok) => ok(req));
  await all.go();
  assert.equal(all.h.calls.length, 2);
  const per = api.worstCase('claude-sonnet-5-5', 0, Math.max(...all.h.calls.map((c) => Buffer.byteLength(c.body.messages[0].content) + Buffer.byteLength(JSON.stringify(c.body.system || '')))), 4000).usd;
  const s = roomRepo(t, env, rooms, partRows);
  s.answers((req, ok) => ok(req));
  await s.h.go({ GITHUB_WORKSPACE: s.root, MAX_BUDGET_USD: String((per * 1.5).toFixed(4)) });
  assert.equal(s.h.calls.length, 1);
  const parts = JSON.parse(s.h.file('scan-parts.json'));
  assert.deepEqual(parts.droppedParts, ['aaaaaaaa:2']);
  assert.equal(parts.droppedUnits, undefined, 'unit a was reached through its first part');
  assert.match(s.h.file('engine-notes'), /1 unit part not reached \(max_budget_usd\)/);
  assert.doesNotMatch(s.h.file('engine-notes'), /unit not reached/);
});

// Runtime admission: the last room of audit-unit-extra.json is an extra, admitted only while actual spend + its worst case fits max_budget_usd
{
  const model = 'claude-sonnet-5-5', env = { MODEL: model, MAX_OUTPUT_TOKENS: '4000' }, rooms = [['aaaaaaaa:1', 'bbbbbbbb'], ['aaaaaaaa:2']];
  const worst = (c) => api.worstCase(model, Buffer.byteLength(c.body.system[0].text), Buffer.byteLength(c.body.messages[0].content), 4000).usd;
  const withUsage = (usage, then = usage) => { let n = 0; return async (req, ok) => reply(200, { ...JSON.parse(await ok(req).text()), model, usage: n++ ? then : usage }); }; // then: the usage of every call after the first
  const extraRepo = async (t, extra = true) => {
    const s = roomRepo(t, env, rooms, partRows);
    if (extra) fs.writeFileSync(path.join(s.h.ctx, 'audit-unit-extra.json'), '1');
    return s;
  };
  // the two call prices (call 1 is planned, call 2 is the extra), from an unconstrained run
  const prices = async (t) => { const s = await extraRepo(t); s.answers((req, ok) => ok(req)); await s.h.go({ GITHUB_WORKSPACE: s.root, MAX_BUDGET_USD: '5' }); return s.h.calls.map(worst); };
  const spend = (s) => JSON.parse(s.h.file('usage.json')).totalCostUsd;

  test('admission: actual spend low, the extra part is admitted (planned budget is one call); both parts ran, nothing is reported not reached', async (t) => {
    const [p1] = await prices(t), s = await extraRepo(t);
    s.answers(withUsage({ input_tokens: 100, output_tokens: 100 }));
    await s.h.go({ GITHUB_WORKSPACE: s.root, MAX_BUDGET_USD: String((p1 * 1.5).toFixed(6)) });
    assert.equal(s.h.calls.length, 2);
    const parts = JSON.parse(s.h.file('scan-parts.json'));
    assert.equal(parts.droppedParts, undefined);
    assert.equal(parts.droppedUnits, undefined);
    assert.deepEqual(parts.failed, []);
    assert.doesNotMatch(s.h.file('engine-notes'), /not reached/);
    assert.ok(spend(s) <= p1 * 1.5);
  });

  test('admission: actual spend high, the extra part is skipped and named in droppedParts (not reached), one call only', async (t) => {
    const [p1] = await prices(t), s = await extraRepo(t);
    s.answers(withUsage({ input_tokens: 100, output_tokens: Math.floor(p1 * 0.9 * 1e5) }));
    await s.h.go({ GITHUB_WORKSPACE: s.root, MAX_BUDGET_USD: String((p1 * 1.5).toFixed(6)) });
    assert.equal(s.h.calls.length, 1);
    const parts = JSON.parse(s.h.file('scan-parts.json'));
    assert.deepEqual(parts.droppedParts, ['aaaaaaaa:2']);
    assert.equal(parts.droppedUnits, undefined, 'unit a was reached through its first part');
    assert.match(s.h.file('engine-notes'), /1 unit part not reached \(max_budget_usd\)/);
  });

  test('admission boundary: an extra whose worst case equals the remainder is admitted; a hair over is skipped; spend never exceeds the budget', async (t) => {
    const [p1, p2] = await prices(t), usage = { input_tokens: 0, output_tokens: Math.floor(p1 * 1e5) }, a = api.cost(model, usage), edge = a + p2;
    const at = await extraRepo(t);
    at.answers(withUsage(usage, { input_tokens: 10, output_tokens: 10 }));
    await at.h.go({ GITHUB_WORKSPACE: at.root, MAX_BUDGET_USD: String(edge) });
    assert.equal(at.h.calls.length, 2);
    assert.ok(spend(at) <= edge);
    const over = await extraRepo(t);
    over.answers(withUsage(usage));
    await over.h.go({ GITHUB_WORKSPACE: over.root, MAX_BUDGET_USD: String(edge - 1e-6) });
    assert.equal(over.h.calls.length, 1);
    assert.deepEqual(JSON.parse(over.h.file('scan-parts.json')).droppedParts, ['aaaaaaaa:2']);
    assert.ok(spend(over) <= edge - 1e-6);
  });

  // U4: a reply with unknown usage (missing, empty, partial) or a failed call without usage may have been billed: it is charged its part's worst case, so the reserve is not released
  for (const [name, usage] of [['missing', undefined], ['empty', {}], ['partial (no output_tokens)', { input_tokens: 100 }]]) {
    test(`admission: usage ${name} on a finished call is charged its worst case; the second extra is not admitted; usage.json says the cost is estimated`, async (t) => {
      const [p1, p2] = await prices(t), budget = String(p1 + p2 - 1e-6), s = await extraRepo(t);
      s.answers(withUsage(usage));
      await s.h.go({ GITHUB_WORKSPACE: s.root, MAX_BUDGET_USD: budget });
      assert.equal(s.h.calls.length, 1);
      assert.deepEqual(JSON.parse(s.h.file('scan-parts.json')).droppedParts, ['aaaaaaaa:2']);
      assert.ok(s.h.file('engine-notes').includes('usage unknown for 1 call(s): charged their worst-case reserve'));
      const u = JSON.parse(s.h.file('usage.json'));
      assert.equal(u.costEstimated, true);
      assert.ok(Math.abs(u.totalCostUsd - p1) < 1e-9);
      const ok = await extraRepo(t);  // control: known usage releases the reserve, the extra runs, no estimate flag
      ok.answers(withUsage({ input_tokens: 100, output_tokens: 100 }));
      await ok.h.go({ GITHUB_WORKSPACE: ok.root, MAX_BUDGET_USD: budget });
      assert.equal(ok.h.calls.length, 2);
      assert.equal(JSON.parse(ok.h.file('usage.json')).costEstimated, undefined);
      assert.doesNotMatch(ok.h.file('engine-notes'), /usage unknown/);
    });
  }

  test('admission: a failed call without usage is charged its worst case; the second extra is not admitted', async (t) => {
    const [p1, p2] = await prices(t), s = await extraRepo(t);
    s.answers(() => err(400, 'invalid_request_error', 'bad request'));
    await s.h.go({ GITHUB_WORKSPACE: s.root, MAX_BUDGET_USD: String(p1 + p2 - 1e-6) });
    assert.equal(s.h.calls.length, 1);
  });

  test('admission: when the worst-case plan itself drops a room, no extra is admitted even with spend near zero; the extra is named with the dropped parts (control: plan intact, extra admitted, is the first admission test)', async (t) => {
    const s = roomRepo(t, env, [['aaaaaaaa:1'], ['bbbbbbbb'], ['aaaaaaaa:2']], partRows);
    fs.writeFileSync(path.join(s.h.ctx, 'audit-unit-extra.json'), '1'); // the last room is the extra; the second is planned but does not fit
    s.answers(withUsage({ input_tokens: 100, output_tokens: 100 }));
    const probe = roomRepo(t, env, [['aaaaaaaa:1'], ['bbbbbbbb']], partRows); probe.answers((req, ok) => ok(req));
    await probe.h.go({ GITHUB_WORKSPACE: probe.root, MAX_BUDGET_USD: '5' });
    const p1 = worst(probe.h.calls[0]);
    await s.h.go({ GITHUB_WORKSPACE: s.root, MAX_BUDGET_USD: String((p1 * 1.2).toFixed(6)) });
    assert.equal(s.h.calls.length, 1);
    const parts = JSON.parse(s.h.file('scan-parts.json'));
    assert.deepEqual(parts.droppedUnits, ['bbbbbbbb']);
    assert.deepEqual(parts.droppedParts, ['aaaaaaaa:2']);
  });

  test('admission (control): without audit-unit-extra.json the second room is planned as before and the budget drops it up front', async (t) => {
    const [p1] = await prices(t), s = await extraRepo(t, false);
    s.answers(withUsage({ input_tokens: 100, output_tokens: 100 }));
    await s.h.go({ GITHUB_WORKSPACE: s.root, MAX_BUDGET_USD: String((p1 * 1.5).toFixed(6)) });
    assert.equal(s.h.calls.length, 1);
    assert.deepEqual(JSON.parse(s.h.file('scan-parts.json')).droppedParts, ['aaaaaaaa:2']);
  });

  test('admission: keptRooms counts the planned calls only, never the extras', async (t) => {
    const s = await extraRepo(t), base = { ctx: s.h.ctx, root: s.root, batch: 20, model, maxTokens: 4000, packBytes: 250000, budget: 5 };
    assert.equal(api.keptRooms(base).rooms, 1);
  });

  test('run as a script: the extra queue executes (an offline fetch stub is preloaded) and the second part is admitted after the first', (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'specguard-admit-')), ctx = path.join(dir, 'ctx');
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    fs.mkdirSync(ctx); fs.mkdirSync(path.join(dir, 'lib'));
    for (const [n, c] of [['a', 'function alpha() {}\nfunction alpha2() {}\n'], ['b', 'function beta() {}\n']]) fs.writeFileSync(path.join(dir, 'lib', `${n}.js`), c);
    const w = (n, c) => fs.writeFileSync(path.join(ctx, n), c);
    w('audit-candidates.txt', ''); w('audit-docs.txt', ''); w('audit-meta.json', JSON.stringify({ max_requirements: 80, units: { total: 2, picked: 2 }, max_units: 12 }));
    w('audit-units.txt', partRows); w('audit-unit-rooms.json', JSON.stringify(rooms)); w('audit-unit-extra.json', '1');
    const stub = path.join(dir, 'stub.js'), log = path.join(dir, 'calls.log');
    fs.writeFileSync(stub, `const fs = require('node:fs'); globalThis.fetch = async (u, init) => { fs.appendFileSync(${JSON.stringify(log)}, 'call,'); const b = { type: 'message', model: 'claude-haiku-5-5', stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ docs_reviewed: [], requirements: [], not_requirements: [], not_reviewed: [], unit_findings: [] }) }], usage: { input_tokens: 10, output_tokens: 10 } }; return { status: 200, ok: true, headers: { get: () => null }, text: async () => JSON.stringify(b) }; };`);
    const r = spawnSync(process.execPath, ['-r', stub, path.join(__dirname, 'engines', 'claude-api.js')], { encoding: 'utf8', cwd: dir, env: { ...process.env, CHECK: 'audit', CTX: ctx, PROMPT: 'p', ANTHROPIC_API_KEY: 'sk-ant-fake', MAX_BUDGET_USD: '0.02', MAX_OUTPUT_TOKENS: '1000', SCAN_BATCH_BLOCKS: '20', GITHUB_WORKSPACE: dir } });
    const err = fs.existsSync(path.join(ctx, 'engine-error')) ? fs.readFileSync(path.join(ctx, 'engine-error'), 'utf8') : '';
    assert.equal(err, '', r.stdout + r.stderr);
    assert.equal(fs.readFileSync(log, 'utf8').split(',').filter(Boolean).length, 2);
    assert.equal(JSON.parse(fs.readFileSync(path.join(ctx, 'scan-parts.json'), 'utf8')).droppedParts, undefined);
  });
}

test('keptRooms: the pre-flight on a ctx says how many unit calls stay (the collector plans that many); one call is null', async (t) => {
  const rooms = [['aaaaaaaa:1', 'bbbbbbbb'], ['aaaaaaaa:2']], s = roomRepo(t, {}, rooms, partRows), base = { ctx: s.h.ctx, root: s.root, batch: 20, model: 'claude-sonnet-5-5', maxTokens: 4000, packBytes: 250000 };
  assert.equal(api.keptRooms({ ...base, budget: 5 }).rooms, 2);
  assert.equal(api.keptRooms({ ...base, budget: 0.0001 }).rooms, 1, 'the first unit call always stays');
  const one = roomRepo(t, {}, [['aaaaaaaa', 'bbbbbbbb', 'cccccccc']]);
  assert.equal(api.keptRooms({ ...base, ctx: one.h.ctx, root: one.root, budget: 5 }), null);
});

test('run as a script: a split scan gets past planning (no initialisation error) and ends with the budget class, offline', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'specguard-script-')), ctx = path.join(dir, 'ctx');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(ctx);
  const cands = Array.from({ length: 25 }, (_, i) => `${i.toString(16).padStart(8, '0')}\tdocs/d.md:${i + 1}\th\tA block MUST hold ${i}.\n`).join('');
  fs.writeFileSync(path.join(ctx, 'audit-candidates.txt'), cands);
  fs.writeFileSync(path.join(ctx, 'audit-docs.txt'), 'docs/d.md\n');
  const r = spawnSync(process.execPath, [path.join(__dirname, 'engines', 'claude-api.js')], { encoding: 'utf8', cwd: dir, env: { ...process.env, CHECK: 'audit', CTX: ctx, PROMPT: 'p', ANTHROPIC_API_KEY: 'sk-ant-fake', MAX_BUDGET_USD: '0.0001', SCAN_BATCH_BLOCKS: '20', GITHUB_WORKSPACE: dir } });
  assert.doesNotMatch(r.stdout + r.stderr + (fs.existsSync(path.join(ctx, 'engine-notes')) ? fs.readFileSync(path.join(ctx, 'engine-notes'), 'utf8') : ''), /before initialization|adapter error/);
  assert.equal(fs.readFileSync(path.join(ctx, 'engine-error'), 'utf8').split('\n')[0], 'budget');
});

test('an adapter exception (our own code throwing) is class internal; a 529 stays rate', async (t) => {
  const h = harness(t, [good()]);
  await h.go({ PROMPT_FILE: path.join(h.dir, 'missing.txt') });
  assert.equal(h.file('engine-error').split('\n')[0], 'internal');
  assert.equal(h.file('engine-status'), 'failed');
  const o = harness(t, [err(529, 'overloaded_error', 'Overloaded')]);
  await o.go();
  assert.equal(o.file('engine-error').split('\n')[0], 'rate');
});

test('unit rooms: a failed unit call names the parts it held (keys, like droppedParts), so the publisher can fail those parts and not the whole unit', async (t) => {
  const rows = ['aaaaaaaa\tlib/a.js\t1\tw\tnone\t-\t-\tpart 1/2 lines 1-1\n', 'aaaaaaaa\tlib/a.js\t1\tw\tnone\t-\t-\tpart 2/2 lines 2-2\n'].join('');
  const s = roomRepo(t, {}, [['aaaaaaaa:1'], ['aaaaaaaa:2']], rows);
  s.answers((req, ok) => (/part 2\/2/.test(req.body.messages[0].content) ? good({ content: [{ type: 'text', text: 'not json at all' }] }) : ok(req)));
  await s.h.go({ GITHUB_WORKSPACE: s.root });
  const parts = JSON.parse(s.h.file('scan-parts.json'));
  assert.deepEqual(parts.failed.map((x) => [x.part, x.units, x.keys]), [['units', ['aaaaaaaa'], ['aaaaaaaa:2']]]);
});

test('context_pack_bytes: a scan with 0 or a non-number fails as a config error with no call (the model would see no source); PR mode keeps 0 = diff only', async (t) => {
  for (const bad of ['0', 'abc', '-1']) {
    const h = harness(t, [good()]);
    await h.go({ CHECK: 'audit', CONTEXT_PACK_BYTES: bad });
    assert.equal(h.calls.length, 0, bad);
    assert.equal(h.file('engine-status'), 'failed');
    assert.match(h.file('engine-error'), /^config\n.*context_pack_bytes/s);
  }
  const pr = harness(t, [good()]);
  await pr.go({ CONTEXT_PACK_BYTES: '0' });
  assert.equal(pr.calls.length, 1);
  assert.notEqual(pr.file('engine-status'), 'failed');
  const ok = harness(t, [good({ content: [{ type: 'text', text: JSON.stringify({ docs_reviewed: [], requirements: [], not_requirements: [], not_reviewed: [] }) }] })]);
  await ok.go({ CHECK: 'audit' });
  assert.equal(ok.calls.length, 1, 'the default pack is unchanged');
});

// --- PR pack: a changed test file that is also a candidate of an earlier source keeps its own hunks; candidate tests are sliced by the hunk identifiers too ---
const padTest = (hits) => { const lines = Array.from({ length: 2000 }, () => padLine()); for (const [i, l] of hits) { lines[i] = "test('block', () => {"; lines[i + 1] = l; lines[i + 2] = '});'; lines[i + 3] = "test('next', () => {"; } return lines; };

test('PR pack: a changed test that is also a candidate of an earlier source shows its added lines', (t) => {
  const lines = padTest([[500, '  assert.ok(alphaThing(1)); // CAND_HIT'], [1800, '  assert.ok(ADDED_BY_PR); // ADDED_HUNK']]);
  const r = tmpRepo(t, { 'src/a.js': 'function alphaThing(v) { return v; }\n', 'tests/a.test.js': lines.join('\n') + '\n' }, {
    'files.txt': 'src/a.js\ntests/a.test.js\n', 'diff.patch': hunkDiff('src/a.js', 1, ['function alphaThing(v) { return v; }']) + hunkDiff('tests/a.test.js', 1802, ['  assert.ok(ADDED_BY_PR); // ADDED_HUNK']),
    'test-candidates.txt': 'src/a.js\n  tests/a.test.js  (name)\n' });
  const p = api.contextPack(r.ctx, r.root, 250000);
  assert.ok(p.text.includes('ADDED_HUNK'), 'the hunk window of the changed test is in the pack');
});

test('PR pack (control): a changed test that is not a candidate keeps showing its added lines', (t) => {
  const lines = padTest([[1800, '  assert.ok(ADDED_BY_PR); // ADDED_HUNK']]);
  const r = tmpRepo(t, { 'src/a.js': 'function alphaThing(v) { return v; }\n', 'tests/a.test.js': lines.join('\n') + '\n' }, {
    'files.txt': 'src/a.js\ntests/a.test.js\n', 'diff.patch': hunkDiff('src/a.js', 1, ['function alphaThing(v) { return v; }']) + hunkDiff('tests/a.test.js', 1802, ['  assert.ok(ADDED_BY_PR); // ADDED_HUNK']) });
  assert.ok(api.contextPack(r.ctx, r.root, 250000).text.includes('ADDED_HUNK'));
});

test('PR pack: a candidate test is sliced by an identifier on a changed (not declared) line of the source', (t) => {
  const lines = padTest([[1500, '  assert.equal(run(), maxRetryCount); // HUNK_TOKEN_HIT']]);
  const r = tmpRepo(t, { 'src/a.js': 'function run() {\n  return maxRetryCount;\n}\n', 'tests/c.test.js': lines.join('\n') + '\n' }, {
    'files.txt': 'src/a.js\n', 'diff.patch': hunkDiff('src/a.js', 2, ['  return maxRetryCount;']), 'test-candidates.txt': 'src/a.js\n  tests/c.test.js  (name)\n' });
  assert.ok(api.contextPack(r.ctx, r.root, 250000).text.includes('HUNK_TOKEN_HIT'), 'the block that names the changed identifier is shown');
  for (const limit of [5000, 20000, 60000]) assert.ok(Buffer.byteLength(api.contextPack(r.ctx, r.root, limit).text) <= limit + 400, `limit ${limit}`);
});

const bigSrc = (mark, at) => Array.from({ length: 100 }, (_, i) => (i === at ? `const ${mark} = 1;` : padLine(70))).join('\n') + '\n'; // ~8 KB numbered, one changed line at index `at`
const shareRepo = (t, limit) => {
  const r = tmpRepo(t, { 'src/a1.js': bigSrc('CHANGED_A1', 50), 'src/a2.js': bigSrc('CHANGED_A2', 50), 'src/a3.js': bigSrc('CHANGED_A3', 50), 'src/b.js': 'function lateOne() { return CHANGED_B; }\n', 'src/b.test.js': "test('late', () => { assert.ok(CHANGED_BT); });\n" }, {
    'files.txt': 'src/a1.js\nsrc/a2.js\nsrc/a3.js\nsrc/b.js\nsrc/b.test.js\n', 'test-candidates.txt': 'src/b.js\n  src/b.test.js  (name)\n',
    'diff.patch': hunkDiff('src/a1.js', 51, ['const CHANGED_A1 = 1;']) + hunkDiff('src/a2.js', 51, ['const CHANGED_A2 = 1;']) + hunkDiff('src/a3.js', 51, ['const CHANGED_A3 = 1;']) + hunkDiff('src/b.js', 1, ['function lateOne() { return CHANGED_B; }']) + hunkDiff('src/b.test.js', 1, ["test('late', () => { assert.ok(CHANGED_BT); });"]) });
  return api.contextPack(r.ctx, r.root, limit);
};

test('PR pack: review files that together fill the pack each get a share, so a later changed file and its test still appear', (t) => {
  const p = shareRepo(t, 18000);
  assert.ok(p.text.includes('CHANGED_A1') && p.text.includes('CHANGED_A2') && p.text.includes('CHANGED_A3'), 'the early files show their changed lines');
  assert.ok(p.text.includes('CHANGED_B') && p.text.includes('CHANGED_BT'), 'the late file and its test are not starved');
  assert.ok(p.notWhole.includes('src/a1.js'), 'a file shown only as slices around its hunks is listed as cut');
});

test('PR pack (control): review files that fit together are shown whole', (t) => {
  const p = shareRepo(t, 250000);
  assert.ok(p.text.includes('name="src/a1.js" note="full file, line-numbered"') && p.text.includes('name="src/a2.js" note="full file, line-numbered"'));
  assert.deepEqual(p.notWhole, []);
});

test('PR pack: a changed test reached first as a candidate keeps its hunk when the candidates before it spent its source\'s share', (t) => {
  const cand = (k) => [`tests/c${k}.test.js`, Array.from({ length: 90 }, (_, i) => (i === 3 ? 'test(\'x\', () => { alphaThing(); });' : padLine(70))).join('\n') + '\n']; // ~7.5 KB each: whole at their room, three spend the share
  const r = tmpRepo(t, { 'src/a.js': 'function alphaThing() { return 1; }\n', 'tests/own.test.js': "test('own', () => { alphaThing(); /* CHANGED_OWN */ });\n", ...Object.fromEntries([1, 2, 3].map(cand)) }, {
    'files.txt': 'src/a.js\ntests/own.test.js\n', 'test-candidates.txt': 'src/a.js\n  tests/c1.test.js  (name)\n  tests/c2.test.js  (name)\n  tests/c3.test.js  (name)\n  tests/own.test.js  (name)\n',
    'diff.patch': hunkDiff('src/a.js', 1, ['function alphaThing() { return 1; }']) + hunkDiff('tests/own.test.js', 1, ["test('own', () => { alphaThing(); /* CHANGED_OWN */ });"]) });
  const p = api.contextPack(r.ctx, r.root, 40000);
  assert.ok(p.text.includes('CHANGED_OWN'), 'the changed test\'s added line is shown although its source\'s share is spent');
});

// The provider refuses the findings schema ("The compiled grammar is too large"), so PR mode sends none; scans still send theirs.
const cit = { path: 'a.js', line: 3, quote: 'x()', side: 'RIGHT' };
const ORIGINAL = () => ({
  requirements_source: 'pr', not_reviewed: '', standards: { status: 'checked', sources: ['S.md'], reason: 'r' }, layering: { status: 'checked', reason: 'r' },
  coverage: [
    { id: 'o1', obligation: 'o', source: 's', behaviour: { ...cit }, change: { ...cit }, evidence: [{ path: 't.js', line: 1, quote: 'q', layer: 'unit', proves: 'p', kind: 'assertion', side: 'RIGHT' }, { path: 't.js', line: 2, quote: 'q' }], status: 'covered', reason: 'r', alignment: { status: 'mismatch', since: 'introduced', reason: 'r' } },
    { id: 'o2', obligation: 'o', source: 's', behaviour: null, evidence: [], status: 'unknown', reason: 'r' },
    { id: 'o3', obligation: 'o', source: 's', behaviour: { ...cit }, change: null, evidence: [{ path: 't.js', line: 9, quote: 'q', kind: 'no_assertion' }], status: 'needs_human', reason: 'r' },
  ],
  findings: [
    { kind: 'weak_test', path: 'a.js', line: 4, start_line: 2, quote: 'q', title: 't', body: 'b', counterexample: 'c', rule_source: 'R.md:1', rule_quote: 'rq', suggestion: 's', source: 'x', confidence: 'high', obligation_ids: ['o1'], side: 'LEFT' },
    { kind: 'missing_test', path: 'a.js', line: 4, quote: 'q', title: 't', body: 'b', confidence: 'low', obligation_ids: [] },
  ],
  requirements: [{ id: 'R1', source: 's', quote: 'q', obligation_ids: ['o1'], reason: 'r', ref: 'x', line: 2, pr_quote: 'p' }, { id: 'R2', obligation_ids: [], reason: 'r' }],
});
test('PR mode sends no output_config and writes the answer as the model gave it', async (t) => {
  const h = harness(t, [good({ content: [{ type: 'text', text: JSON.stringify(ORIGINAL()) }] })]);
  await h.go();
  assert.equal(h.calls.length, 1);
  assert.ok(!h.calls[0].body.output_config);
  assert.deepEqual(JSON.parse(h.file('findings.json')), ORIGINAL());
});

test('scan mode still sends its schema as structured output', async (t) => {
  const h = harness(t, [good({ content: [{ type: 'text', text: JSON.stringify({ docs_reviewed: [], requirements: [], not_requirements: [], not_reviewed: [] }) }] })]);
  await h.go({ CHECK: 'audit' });
  assert.equal(h.calls[0].body.output_config.format.type, 'json_schema');
});

test('repair turn: prose with no JSON, then ONE more call with the answer as the assistant turn and a request for the JSON object only; both calls are in usage', async (t) => {
  const h = harness(t, [good({ content: [{ type: 'text', text: 'I reviewed the diff and found it fine.' }] }), good()]);
  await h.go();
  assert.equal(h.calls.length, 2);
  const m = h.calls[1].body.messages;
  assert.deepEqual(m.slice(1), [{ role: 'assistant', content: 'I reviewed the diff and found it fine.' }, { role: 'user', content: 'Return only the JSON object for the schema.' }]);
  assert.deepEqual(JSON.parse(h.file('findings.json')), VALID);
  assert.ok([null, 'success'].includes(h.file('engine-status')));
  assert.equal(JSON.parse(h.file('usage.json')).tokenDetails.output.tokenCount, 8000, 'two replies summed');
});

test('repair turn: a repair reply with unknown usage is charged its own worst case, not $0', async (t) => {
  const h = harness(t, [good({ content: [{ type: 'text', text: 'prose' }] }), good({ usage: {} })]);
  await h.go();
  const u = JSON.parse(h.file('usage.json')), first = api.cost('claude-haiku-5-5', { input_tokens: 1000, cache_creation_input_tokens: 20000, output_tokens: 4000 });
  assert.ok(u.totalCostUsd > first * 1.5, 'the unknown repair reply took a reserve');
  assert.equal(u.costEstimated, true);
});

test('repair turn: prose twice fails after exactly two calls; a budget that cannot cover the second call, a length stop and an HTTP error make no second call', async (t) => {
  const prose = () => good({ content: [{ type: 'text', text: 'no json here' }] });
  const twice = harness(t, [prose(), prose()]);
  await twice.go();
  assert.equal(twice.calls.length, 2);
  assert.equal(twice.file('engine-status'), 'failed');
  const poor = harness(t, [prose(), good()]);
  await poor.go({ MAX_BUDGET_USD: '0.02' });
  assert.equal(poor.calls.length, 1, 'worst case of a second call does not fit');
  const len = harness(t, [good({ stop_reason: 'max_tokens', content: [{ type: 'text', text: 'cut off' }] }), good()]);
  await len.go();
  assert.equal(len.calls.length, 1);
  const http = harness(t, [err(401, 'authentication_error', 'bad key'), good()]);
  await http.go();
  assert.equal(http.calls.length, 1);
});

test('single call: a reply with unknown usage is charged the call\'s worst case and the cost is flagged as estimated', async (t) => {
  const h = harness(t, [good({ usage: {} })]);
  await h.go();
  const u = JSON.parse(h.file('usage.json'));
  assert.ok(u.totalCostUsd > 0, 'was 0');
  assert.equal(u.costEstimated, true);
});

test('unit rooms: each unit finding carries the part keys of the call that returned it', async (t) => {
  const rows = ['aaaaaaaa\tlib/a.js\t1\tw\tnone\t-\t-\tpart 1/2 lines 1-1\n', 'aaaaaaaa\tlib/a.js\t1\tw\tnone\t-\t-\tpart 2/2 lines 2-2\n'].join('');
  const s = roomRepo(t, {}, [['aaaaaaaa:1'], ['aaaaaaaa:2']], rows);
  s.answers((req, ok) => ok(req));
  await s.h.go({ GITHUB_WORKSPACE: s.root });
  assert.deepEqual(JSON.parse(s.h.file('findings.json')).unit_findings.map((f) => f.callKeys), [['aaaaaaaa:1'], ['aaaaaaaa:2']]);
});

// R3 #6: a network error (status 0) may follow a request the server ran and billed; its usage is unknown, so it is charged at the call's worst case, and the retry needs another worst case under the budget
const reset = () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }); };
const GOOD_USAGE = { input_tokens: 1000, cache_creation_input_tokens: 20000, cache_read_input_tokens: 0, output_tokens: 4000 };
const worstOf = async (t) => { const h = harness(t, [good()]); await h.go({ MAX_BUDGET_USD: '0.000001' }); return parseFloat(/worst-case cost \$([\d.]+)/.exec(h.file('engine-notes'))[1]); };
const near = (a, b) => assert.ok(Math.abs(a - b) < 2e-4, `${a} vs ${b}`);

test('network reset then success: both attempts are recorded (the lost one at the call worst case), cost estimated', async (t) => {
  const W = await worstOf(t), h = harness(t, [reset, good()]);
  await h.go({ MAX_BUDGET_USD: String(2.5 * W) });
  assert.equal(h.calls.length, 2);
  const u = JSON.parse(h.file('usage.json'));
  near(u.totalCostUsd, api.cost('claude-haiku-5-5', GOOD_USAGE) + W);
  assert.equal(u.costEstimated, true);
  assert.match(h.file('engine-notes'), /usage unknown for 1 call/);
});

// R5 #6: a reset (lost) AND a final reply without usage are two attempts that may both have been billed
test('network reset then a reply with unknown usage: both attempts are charged at the worst case (2W, not 1W)', async (t) => {
  const W = await worstOf(t), h = harness(t, [reset, good({ usage: {} })]);
  await h.go({ MAX_BUDGET_USD: String(2.5 * W) });
  assert.equal(h.calls.length, 2);
  const u = JSON.parse(h.file('usage.json'));
  near(u.totalCostUsd, 2 * W); assert.equal(u.costEstimated, true);
});

test('network reset, then an unknown-usage reply with no JSON: the repair turn is not admitted past the budget (3W needed, 2.5W declared); the 2W is recorded', async (t) => {
  const W = await worstOf(t), prose = () => good({ usage: {}, content: [{ type: 'text', text: 'prose, no json' }] }), h = harness(t, [reset, prose(), good({ usage: {} })]);
  await h.go({ MAX_BUDGET_USD: String(2.5 * W) });
  assert.equal(h.calls.length, 2, 'no repair request');
  near(JSON.parse(h.file('usage.json')).totalCostUsd, 2 * W);
  const roomy = harness(t, [reset, prose(), good({ usage: {} })]);
  await roomy.go({ MAX_BUDGET_USD: String(3.5 * W) });
  assert.equal(roomy.calls.length, 3, 'control: admitted when 3W fits');
  near(JSON.parse(roomy.file('usage.json')).totalCostUsd, 3 * W);
});

test('network reset: the retry is refused when it would exceed the budget; the lost attempt is still charged', async (t) => {
  const W = await worstOf(t), h = harness(t, [reset, good()]);
  await h.go({ MAX_BUDGET_USD: String(1.5 * W) });
  assert.equal(h.calls.length, 1, 'no second request');
  assert.equal(h.file('engine-status'), 'failed');
  const u = JSON.parse(h.file('usage.json'));
  near(u.totalCostUsd, W); assert.equal(u.costEstimated, true);
});

test('deadline timeout/abort as the only attempt, or after a reset: charged at the call worst case, cost estimated', async (t) => {
  const W = await worstOf(t), abort = (name) => () => { throw Object.assign(new Error('aborted'), { name }); };
  for (const name of ['TimeoutError', 'AbortError']) {
    const h = harness(t, [abort(name)]);
    await h.go({ MAX_BUDGET_USD: String(2.5 * W) });
    assert.equal(h.file('engine-status'), 'timeout');
    const u = JSON.parse(h.file('usage.json'));
    near(u.totalCostUsd, W); assert.equal(u.costEstimated, true, name);
  }
  const h = harness(t, [reset, abort('TimeoutError')]);
  await h.go({ MAX_BUDGET_USD: String(2.5 * W) });
  near(JSON.parse(h.file('usage.json')).totalCostUsd, 2 * W);
});

test('429 then success: the retry and the charge are unchanged (an HTTP error reply was not run): exact cost, not estimated, even with a budget below two worst cases', async (t) => {
  const W = await worstOf(t), h = harness(t, [err(429, 'rate_limit_error', 'slow down'), good()]);
  await h.go({ MAX_BUDGET_USD: String(1.5 * W) });
  assert.equal(h.calls.length, 2);
  const u = JSON.parse(h.file('usage.json'));
  assert.equal(u.costEstimated, undefined);
  near(u.totalCostUsd, api.cost('claude-haiku-5-5', GOOD_USAGE));
});

test('unit rooms: a unit part whose unit_findings is not an array fails only its own units (not reviewed); the other parts\' findings are kept', async (t) => {
  const s = roomRepo(t);
  s.answers((req, ok) => (unitsIn(req)[0] === 'bbbbbbbb' ? good({ content: [{ type: 'text', text: JSON.stringify({ docs_reviewed: [], requirements: [], not_requirements: [], not_reviewed: [], unit_findings: 'none' }) }] }) : ok(req)));
  await s.h.go({ GITHUB_WORKSPACE: s.root });
  assert.deepEqual(JSON.parse(s.h.file('findings.json')).unit_findings.map((f) => f.unit), ['aaaaaaaa', 'cccccccc']);
  const failed = JSON.parse(s.h.file('scan-parts.json')).failed;
  assert.equal(failed.length, 1); assert.deepEqual(failed[0].units, ['bbbbbbbb']); assert.match(failed[0].reason, /unit_findings was not an array/);
});

// invariant: an attempt whose usage is unknown is charged at the worst case W (each lost attempt and the final reply without usage); a reply with known usage is charged its cost once, plus W per lost attempt before it
test('charge invariant over lost / unknown / HTTP-error / repair paths', async (t) => {
  const W = await worstOf(t), K = api.cost('claude-haiku-5-5', good().usage || { input_tokens: 1000, cache_creation_input_tokens: 20000, cache_read_input_tokens: 0, output_tokens: 4000 });
  const prose = () => good({ usage: {}, content: [{ type: 'text', text: 'prose, no json' }] });
  const rows = [ // [name, replies, budget in W, attempts, expected charge]
    ['lost + known', [reset, good()], 2.5, 2, K + W],
    ['lost + unknown', [reset, good({ usage: {} })], 2.5, 2, 2 * W],
    ['unknown only', [good({ usage: {} })], 2.5, 1, W],
        ['two lost, no reply', [reset, reset], 3.5, 2, 2 * W],
    ['two lost + unknown reply (repair turn)', [reset, prose, reset, good({ usage: {} })], 4.5, 4, 4 * W],
    ['lost + unknown + repair', [reset, prose, good({ usage: {} })], 3.5, 3, 3 * W],
  ];
  const rej = harness(t, [() => err(400, 'invalid_request_error', 'bad request')]); await rej.go({ MAX_BUDGET_USD: String(2.5 * W) }); // a rejected request was not run: nothing billed, nothing recorded
  assert.equal(rej.calls.length, 1); assert.equal(rej.file('usage.json'), null, 'HTTP error only: no cost recorded');
  for (const [name, replies, budget, attempts, want] of rows) {
    const h = harness(t, replies);
    await h.go({ MAX_BUDGET_USD: String(budget * W) });
    assert.equal(h.calls.length, attempts, name);
    const got = JSON.parse(h.file('usage.json')).totalCostUsd;
    near(got, want); if (name !== 'lost + known') assert.ok(got >= want - 2e-4, `${name}: charged ${got} < ${want}`);
  }
});
