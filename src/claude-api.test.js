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

test('a refused output schema: ONE retry asking for plain JSON (no output_config), with a note; a plain answer is still extracted', async (t) => {
  const h = harness(t, [err(400, 'invalid_request_error', 'Schema is too complex for compilation.'), good({ content: [{ type: 'text', text: `Here you go:\n${JSON.stringify(VALID)}` }] })]);
  await h.go();
  assert.equal(h.calls.length, 2);
  assert.ok(h.calls[0].body.output_config && !h.calls[1].body.output_config);
  assert.deepEqual(JSON.parse(h.file('findings.json')), VALID);
  assert.equal(h.file('engine-notes'), '', 'the usage line carries no engine note for it');
  assert.ok(!/structured output/.test(h.everything()), 'and no file or call carries it');
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
const sliceRepo = (t, hit, ctxExtra = {}) => repo(t, { 'src/svc.js': 'const x = 1;\nfunction computeTotal(a) {\n  return a;\n}\n', 'test/svc.test.js': bigTest(hit) }, {
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

test('context pack: a symbol counts only as a whole word: recomputeTotal is no reference to computeTotal (the head is shown and the file listed as cut)', async (t) => {
  const r = repo(t, { 'src/svc.js': 'const x = 1;\nfunction computeTotal(a) {\n  return a;\n}\n', 'test/svc.test.js': bigTest((i) => i === 400).replace('computeTotal(1);', 'recomputeTotal(1);') }, {
    'files.txt': 'src/svc.js\n', 'test-candidates.txt': 'src/svc.js\n  test/svc.test.js  (same stem)\n',
    'diff.numbered.txt': 'diff --git a/src/svc.js b/src/svc.js\n--- a/src/svc.js\n+++ b/src/svc.js\n@@ -1,1 +1,4 @@\n   1 |  const x = 1;\n   2 | +function computeTotal(a) {\n   3 | +  return a;\n   4 | +}\n' });
  await r.go();
  assert.match(r.user(), /name="test\/svc\.test\.js" note="first \d+ of 2999 lines, line-numbered"/);
  assert.equal(r.h.file('pack-cut.txt'), 'test/svc.test.js');
});

test('context pack: no symbol of the diff in the test file -> the head, as before, and the file is listed as cut; leads.txt symbols and a raw diff.patch are used too', async (t) => {
  const none = sliceRepo(t, (i) => i === 400, { 'diff.numbered.txt': '+++ b/src/svc.js\n@@ -1,1 +1,2 @@\n   2 | +function zzzNothing() {}\n' });
  await none.go();
  assert.match(none.user(), /name="test\/svc\.test\.js" note="first \d+ of 2999 lines, line-numbered"/);
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

test('action.yml: scan_batch_blocks (default 20) reaches the validation and engine steps; validate-inputs.sh accepts 1 to 100 only', () => {
  const yml = fs.readFileSync(path.join(__dirname, '..', 'action.yml'), 'utf8');
  assert.match(/^ {2}scan_batch_blocks: \{[^}]*\}/m.exec(yml)[0], /default: "20" \}$/);
  assert.equal(yml.split('SCAN_BATCH_BLOCKS: ${{ inputs.scan_batch_blocks }}').length - 1, 2);
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
  const r = sharedRepo(t), p = api.contextPack(r.ctx, r.root, 1000);
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
