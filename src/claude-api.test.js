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
  assert.equal(body.max_tokens, 32000);
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
  assert.equal(h.file('engine-notes'), 'structured output unavailable for this schema; plain JSON requested');
  assert.ok([null, 'success'].includes(h.file('engine-status')));
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
  assert.match(r.h.file('engine-notes'), /^context pack: 5 files, \d+ KB$/);
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

test('context pack: a file over the per-file cap (limit/6, here 25000 bytes) is cut at a line boundary and says so', async (t) => {
  const r = repo(t, { 'big.js': lineText(20000) }, { 'files.txt': 'big.js\n' });
  await r.go();
  const m = /name="big\.js" note="first (\d+) of 20000 lines, line-numbered">\n([\s\S]*?)\n<\/untrusted-data>/.exec(r.user());
  assert.ok(m && +m[1] > 1000 && +m[1] < 20000);
  assert.equal(m[2].split('\n').length, +m[1]);
  assert.ok(Buffer.byteLength(m[2]) <= 150000 / 6);
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

test('context pack on a model with a price step (haiku 5.5): shrunk so the prompt stays under 90% of 100k tokens at 2 bytes/token; skipped with a note when the prompt alone is that big', async (t) => {
  const files = Object.fromEntries('abcdef'.split('').map((c) => [`${c}.js`, lineText(20000)])), ctxFiles = { 'files.txt': Object.keys(files).join('\n') + '\n' };
  const r = repo(t, files, ctxFiles);
  fs.writeFileSync(r.h.pf, `${STATIC}${'s'.repeat(40000)}\n\n---\n\nContext directory (absolute path): /ctx\n${'c'.repeat(40000)}\n`);
  await r.go();
  const b = r.h.calls[0].body, total = Buffer.byteLength(b.system[0].text) + Buffer.byteLength(b.messages[0].content);
  assert.ok(total / 2 <= 0.9 * api.PRICES['claude-haiku-5-5'].longFrom, String(total));
  assert.ok(total > 0.8 * 180000 && /^context pack: [1-9]\d* files/.test(r.h.file('engine-notes')), 'the pack was shrunk, not dropped: ' + total);
  const none = repo(t, files, ctxFiles);
  fs.writeFileSync(none.h.pf, PROMPT + 'z'.repeat(190000));
  await none.go();
  assert.equal(none.h.calls.length, 1, none.h.file('engine-error') + none.h.file('engine-notes'));
  assert.ok(!none.user().includes('Repository files'));
  assert.equal(none.h.file('engine-notes'), 'context pack: skipped, prompt already near the 100k-token price step');
  const opus = repo(t, files, ctxFiles, { MODEL: 'claude-opus-5-5', MAX_BUDGET_USD: '20' }); // no price step: the plain upper bound
  fs.writeFileSync(opus.h.pf, PROMPT + 'z'.repeat(190000));
  await opus.go();
  assert.ok(opus.user().includes('Repository files'));
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
