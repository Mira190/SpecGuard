const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const bash = process.platform === 'win32' ? path.join(process.env.ProgramFiles, 'Git/bin/bash.exe') : 'bash';
const fwd = (p) => p.replace(/\\/g, '/');
const VALID = { coverage: [], findings: [], requirements: [] };
const KEY = 'sk-ant-api03-TESTONLY_0123456789-abcdef'; // made up; must never reach a file, the log or an argument
const result = (extra = {}) => JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: '', structured_output: VALID, total_cost_usd: 0.0421, duration_api_ms: 2500,
  usage: { input_tokens: 5, output_tokens: 7 }, modelUsage: { 'claude-haiku-5-5': { inputTokens: 1000, outputTokens: 200, cacheReadInputTokens: 3000, cacheCreationInputTokens: 500, costUSD: 0.0421 } }, ...extra });

// A fake `claude` on PATH: prints stdout, stderr, exits rc; logs its argv, whether ANTHROPIC_API_KEY was set and the prompt it read on stdin.
function setup(t, { out = result(), err = '', rc = 0, npmRc = 0, version = '2.1.284 (Claude Code)' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'specguard-claude-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'bin'), ctx = path.join(dir, 'ctx'), fake = path.join(dir, 'fake');
  for (const d of [bin, ctx, fake]) fs.mkdirSync(d);
  fs.writeFileSync(path.join(fake, 'out'), out);
  fs.writeFileSync(path.join(fake, 'err'), err);
  fs.writeFileSync(path.join(dir, 'prompt.txt'), 'REVIEW PROMPT');
  fs.writeFileSync(path.join(bin, 'claude'), `#!/usr/bin/env bash
F="${fwd(fake)}"
[ "$1" = --version ] && { echo "${version}"; exit 0; }
{ printf '%s\\n' "$@"; echo '---'; } >> "$F/argv.log"
echo "key=\${ANTHROPIC_API_KEY:+set} gh=\${GH_TOKEN:-unset}" >> "$F/env.log"
cat > "$F/stdin"
cat "$F/out"; cat "$F/err" >&2
exit ${rc}
`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'npm'), `#!/usr/bin/env bash\necho "npm $*" >> "${fwd(fake)}/argv.log"\nexit ${npmRc}\n`, { mode: 0o755 });
  const run = (extra = {}) => spawnSync(bash, [fwd(path.join(__dirname, 'engines', 'claude.sh'))], {
    encoding: 'utf8', timeout: 60000,
    env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH, CTX: fwd(ctx), PROMPT_FILE: fwd(path.join(dir, 'prompt.txt')), ANTHROPIC_API_KEY: KEY, GH_TOKEN: 'job-token',
      MODEL: 'claude-haiku-5-5', EFFORT: '', MAX_CREDITS: '60', TIMEOUT: '5', CLAUDE_VERSION: '', CHECK: '', ...extra },
  });
  const file = (n) => { try { return fs.readFileSync(path.join(ctx, n), 'utf8').trim(); } catch { return null; } };
  const read = (n) => { try { return fs.readFileSync(path.join(fake, n), 'utf8'); } catch { return ''; } };
  const everything = (r) => [r.stdout, r.stderr, ...fs.readdirSync(ctx).map((n) => file(n)), read('argv.log')].join('\n'); // all output of the run
  return { run, file, read, everything, calls: () => read('argv.log').split('---\n').filter(Boolean).map((c) => c.split('\n').filter(Boolean)) };
}
const flag = (c, f) => c[c.indexOf(f) + 1];
// the schema argument is multi-line pretty JSON: cut it out of the raw argv log
const schemaOf = (s) => JSON.parse(s.read('argv.log').split('--json-schema\n')[1].split('\n--max-budget-usd')[0]);

test('a valid structured answer: findings.json from structured_output, normalized usage.json, read-only tools, prompt on stdin, key only in the environment', (t) => {
  const s = setup(t);
  const r = s.run();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(JSON.parse(s.file('findings.json')), VALID);
  assert.ok([null, 'success'].includes(s.file('engine-status')));
  assert.equal(s.file('engine-notes'), '');
  const [c, ...more] = s.calls();
  assert.equal(more.length, 0, 'one turn, no repair');
  assert.equal(s.read('stdin'), 'REVIEW PROMPT');
  assert.ok(c.includes('-p') && !c.includes('REVIEW PROMPT'));
  assert.equal(flag(c, '--tools'), 'Read,Grep,Glob');
  assert.equal(flag(c, '--allowedTools'), 'Read,Grep,Glob');
  assert.equal(flag(c, '--permission-mode'), 'dontAsk');
  assert.equal(flag(c, '--output-format'), 'json');
  assert.equal(flag(c, '--model'), 'claude-haiku-5-5');
  assert.equal(flag(c, '--max-budget-usd'), '3.00');
  assert.ok(c.includes('--bare') && c.includes('--restricted') && c.includes('--no-session-persistence'));
  for (const k of ['coverage', 'findings', 'requirements']) assert.ok(k in schemaOf(s).properties, k);
  for (const f of ['--dangerously-skip-permissions', '--allow-dangerously-skip-permissions']) assert.ok(!c.includes(f), f);
  assert.equal(s.read('env.log').trim(), 'key=set gh=unset', 'the key reaches the CLI by environment; the job token does not');
  assert.ok(!s.everything(r).includes(KEY));
  const u = JSON.parse(s.file('usage.json'));
  assert.equal(u.currentModel, 'claude-haiku-5-5');
  assert.equal(u.totalCostUsd, 0.0421);
  assert.equal(u.totalApiDurationMs, 2500);
  assert.deepEqual(u.modelMetrics['claude-haiku-5-5'].usage, { inputTokens: 4500, cacheReadTokens: 3000, cacheWriteTokens: 500, outputTokens: 200 }); // inputTokens includes the cache tokens, like copilot's
  assert.deepEqual(u.tokenDetails, { input: { tokenCount: 1000 }, cache_read: { tokenCount: 3000 }, cache_write: { tokenCount: 500 }, output: { tokenCount: 200 } });
  assert.deepEqual(JSON.parse(s.file('engine-model.json')).used, ['claude-haiku-5-5']);
});

test('usage.json feeds the summary usage line: exact cost in USD, model, tokens', (t) => {
  const s = setup(t);
  s.run();
  const { usageLine } = require('./post.js');
  const line = usageLine({ engine: 'claude', model: 'claude-haiku-5-5', raw: JSON.parse(s.file('usage.json')), used: ['claude-haiku-5-5'] });
  assert.match(line, /Engine: claude/);
  assert.match(line, /Model: claude-haiku-5-5/);
  assert.match(line, /4\.5k in \(3\.0k cached\) · 200 out/);
  assert.match(line, /Cost \$0\.04(?!.*≈)/);
});

test('the audit schema is used for a scan; an empty model passes no --model; effort is ignored with a note; the budget follows MAX_CREDITS', (t) => {
  const s = setup(t, { out: result({ structured_output: { requirements: [] } }) });
  s.run({ CHECK: 'audit', MODEL: '', EFFORT: 'high', MAX_CREDITS: '100' });
  const [c] = s.calls();
  assert.ok(!c.includes('--model') && !c.includes('--effort'));
  assert.equal(flag(c, '--max-budget-usd'), '5.00');
  assert.ok(!('findings' in schemaOf(s).properties));
  assert.equal(s.file('engine-notes'), 'effort ignored: claude engine');
});

test('an install is bounded and pinned; a failed install is engine-status failed, a note, exit 0', (t) => {
  const s = setup(t);
  assert.equal(s.run({ CLAUDE_VERSION: '2.1.284' }).status, 0);
  assert.match(s.read('argv.log'), /^npm install -g @anthropic-ai\/claude-code@2\.1\.284$/m);
  const bad = setup(t, { npmRc: 1 });
  assert.equal(bad.run({ CLAUDE_VERSION: '2.1.284' }).status, 0);
  assert.equal(bad.file('engine-status'), 'failed');
  assert.match(bad.file('engine-notes'), /engine install failed: @anthropic-ai\/claude-code@2\.1\.284/);
  assert.equal(bad.file('findings.json'), null);
});

test('auth error: classified, noted, status failed, and the key is redacted everywhere', (t) => {
  const s = setup(t, { out: '', rc: 1, err: `API Error: 401 invalid x-api-key (${KEY}) Authorization: Bearer ${KEY}` });
  const r = s.run();
  assert.equal(r.status, 0);
  assert.equal(s.file('engine-status'), 'failed');
  assert.equal(s.file('engine-error').split('\n')[0], 'auth');
  assert.match(s.file('engine-notes'), /Anthropic API key was rejected/);
  assert.match(s.file('engine-notes'), /\*\*\*/);
  assert.match(r.stdout, /::warning::Claude review failed/);
  assert.ok(!s.everything(r).includes(KEY) && !s.everything(r).includes('TESTONLY'));
});

test('quota errors (credit balance on stderr, the per-run budget in the JSON result) are classified as quota', (t) => {
  const a = setup(t, { out: '', rc: 1, err: 'Your credit balance is too low to access the Anthropic API.' });
  a.run();
  assert.equal(a.file('engine-status'), 'failed');
  assert.equal(a.file('engine-error').split('\n')[0], 'quota');
  const b = setup(t, { out: JSON.stringify({ type: 'result', subtype: 'error_max_budget_usd', is_error: true, total_cost_usd: 3.01, duration_api_ms: 9000 }), rc: 1 });
  b.run();
  assert.equal(b.file('engine-status'), 'failed');
  assert.equal(b.file('engine-error').split('\n')[0], 'quota');
  assert.equal(JSON.parse(b.file('usage.json')).totalCostUsd, 3.01, 'what was spent is still recorded');
});

test('rate limit and unavailable model are classified', (t) => {
  const a = setup(t, { out: '', rc: 1, err: 'API Error: 429 rate_limit_error' });
  a.run();
  assert.equal(a.file('engine-error').split('\n')[0], 'rate');
  const b = setup(t, { out: JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: 'There is an issue with the selected model (claude-haiku-5-5). It may not exist.' }), rc: 1 });
  b.run({ MODEL: 'claude-haiku-5-5' });
  assert.equal(b.file('engine-error').split('\n')[0], 'model');
});

test('garbage output: status failed, a note, no findings, exit 0, and no repair turn', (t) => {
  const s = setup(t, { out: 'this is not json at all', rc: 0 });
  const r = s.run();
  assert.equal(r.status, 0);
  assert.equal(s.file('engine-status'), 'failed');
  assert.match(s.file('engine-notes'), /unparsable/);
  assert.equal(s.calls().length, 1);
  assert.equal(s.file('engine-repair'), null);
});

test('no structured output but a JSON answer in the result text is still extracted; an invalid object fails without a repair turn', (t) => {
  const a = setup(t, { out: result({ structured_output: undefined, result: `Here you go:\n${JSON.stringify(VALID)}` }) });
  a.run();
  assert.deepEqual(JSON.parse(a.file('findings.json')), VALID);
  const b = setup(t, { out: result({ structured_output: { findings: [] } }) });
  const r = b.run();
  assert.equal(r.status, 0);
  assert.match(r.stdout, /::warning::/, 'post.js validates again; the adapter reports the problem');
  assert.equal(b.calls().length, 1);
});

test('a bad model is refused (exit 1) and a CLI that does not report its version is reported without throwing', (t) => {
  const s = setup(t);
  const r = s.run({ MODEL: '--yolo' });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^::error::/m);
  assert.equal(s.calls().length, 0);
  const stub = setup(t, { version: 'Cannot find Claude Code' });
  assert.equal(stub.run().status, 0);
  assert.equal(stub.file('engine-status'), 'failed');
  assert.match(stub.file('engine-notes'), /not found or not runnable/);
  assert.equal(stub.calls().length, 0);
});

test('redaction patterns: github_pat_, gh[pousr]_, sk-ant- and Bearer values become ***', () => {
  const r = spawnSync(bash, ['-c', `. "${fwd(path.join(__dirname, 'engines', '_redact.sh'))}"; redact`], {
    input: 'a github_pat_11AA_bb b ghp_Abc123 c gho_x1 d ghu_x1 e ghs_x1 f ghr_x1 g sk-ant-api03-A_b-c h Bearer eyJ.abc-d i keep-this ghx_stays\n', encoding: 'utf8' });
  assert.equal(r.stdout.trim(), 'a *** b *** c *** d *** e *** f *** g *** h *** i keep-this ghx_stays');
});
