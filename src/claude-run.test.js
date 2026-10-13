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

// A fake `claude` on PATH: prints stdout, stderr, exits rc; logs its argv, whether ANTHROPIC_API_KEY was set and the prompt it read on stdin (stdin.N per call).
// `then` = the answers of the 2nd, 3rd... call: [{ out, err, rc }] (a key left out repeats the first call's).
function setup(t, { out = result(), err = '', rc = 0, npmRc = 0, version = '2.1.284 (Claude Code)', then = [] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'specguard-claude-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'bin'), ctx = path.join(dir, 'ctx'), fake = path.join(dir, 'fake');
  for (const d of [bin, ctx, fake]) fs.mkdirSync(d);
  fs.writeFileSync(path.join(fake, 'out'), out);
  fs.writeFileSync(path.join(fake, 'err'), err);
  fs.writeFileSync(path.join(fake, 'rc'), String(rc));
  then.forEach((x, i) => { for (const k of ['out', 'err', 'rc']) if (x[k] !== undefined) fs.writeFileSync(path.join(fake, `${k}.${i + 2}`), String(x[k])); });
  fs.writeFileSync(path.join(dir, 'prompt.txt'), 'REVIEW PROMPT');
  fs.writeFileSync(path.join(bin, 'claude'), `#!/usr/bin/env bash
F="${fwd(fake)}"
[ "$1" = --version ] && { echo "${version}"; exit 0; }
{ printf '%s\\n' "$@"; echo '---'; } >> "$F/argv.log"
echo "key=\${ANTHROPIC_API_KEY:+set} gh=\${GH_TOKEN:-unset}" >> "$F/env.log"
n=$(( $(cat "$F/n" 2>/dev/null || echo 0) + 1 )); echo $n > "$F/n"
cat > "$F/stdin.$n"
pick() { if [ -f "$F/$1.$n" ]; then cat "$F/$1.$n"; else cat "$F/$1"; fi; }
pick out; pick err >&2
exit $(pick rc)
`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'npm'), `#!/usr/bin/env bash\necho "npm $*" >> "${fwd(fake)}/argv.log"\nexit ${npmRc}\n`, { mode: 0o755 });
  const run = (extra = {}) => spawnSync(bash, [fwd(path.join(__dirname, 'engines', 'claude.sh'))], {
    encoding: 'utf8', timeout: 60000,
    env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH, CTX: fwd(ctx), PROMPT_FILE: fwd(path.join(dir, 'prompt.txt')), ANTHROPIC_API_KEY: KEY, GH_TOKEN: 'job-token',
      MODEL: 'claude-haiku-5-5', EFFORT: '', MAX_BUDGET_USD: '', TIMEOUT: '5', CLAUDE_VERSION: '', CHECK: '', CLAUDE_MODE: 'agent', ...extra },
  });
  const file = (n) => { try { return fs.readFileSync(path.join(ctx, n), 'utf8').trim(); } catch { return null; } };
  const read = (n) => { try { return fs.readFileSync(path.join(fake, n), 'utf8'); } catch { return ''; } };
  const everything = (r) => [r.stdout, r.stderr, ...fs.readdirSync(ctx).map((n) => file(n)), read('argv.log')].join('\n'); // all output of the run
  return { run, file, read, everything, calls: () => read('argv.log').split('---\n').filter(Boolean).map((c) => c.split('\n').slice(0, -1)) }; // empty arguments (--tools "") are kept
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
  assert.equal(more.length, 0, 'one turn, no finalize');
  assert.equal(s.read('stdin.1'), 'REVIEW PROMPT');
  assert.ok(c.includes('-p') && !c.includes('REVIEW PROMPT'));
  assert.equal(flag(c, '--tools'), 'Read,Grep,Glob');
  assert.equal(flag(c, '--allowedTools'), 'Read,Grep,Glob');
  assert.equal(flag(c, '--permission-mode'), 'dontAsk');
  assert.equal(flag(c, '--output-format'), 'json');
  assert.equal(flag(c, '--model'), 'claude-haiku-5-5');
  assert.equal(flag(c, '--max-budget-usd'), '1.00', 'default max_budget_usd');
  assert.match(flag(c, '--session-id'), /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/, 'a session id of ours, so a finalize turn can resume it');
  assert.ok(c.includes('--bare') && c.includes('--restricted') && !c.includes('--no-session-persistence'));
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

test('the audit schema is used for a scan; an empty model passes no --model; effort is ignored with a note; the budget follows MAX_BUDGET_USD (MAX_CREDITS is ignored)', (t) => {
  const s = setup(t, { out: result({ structured_output: { requirements: [] } }) });
  s.run({ CHECK: 'audit', MODEL: '', EFFORT: 'high', MAX_CREDITS: '100', MAX_BUDGET_USD: '5' });
  const [c] = s.calls();
  assert.ok(!c.includes('--model') && !c.includes('--effort'));
  assert.equal(flag(c, '--max-budget-usd'), '5.00');
  assert.ok(!c.includes('--resume'));
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

test('account credit exhausted is quota and gets NO finalize turn; the per-run budget stop is told apart from it', (t) => {
  const a = setup(t, { out: JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: 'Credit balance is too low', total_cost_usd: 0.4, duration_api_ms: 900 }), rc: 1 });
  a.run();
  assert.equal(a.file('engine-status'), 'failed');
  assert.equal(a.file('engine-error').split('\n')[0], 'quota');
  assert.match(a.file('engine-error').split('\n')[1], /account has no credit.*not the per-run budget/);
  assert.equal(a.calls().length, 1, 'no finalize after an account failure, even with money spent');
  assert.equal(a.file('engine-repair'), null);
  const b = setup(t, { out: '', rc: 1, err: 'API Error 402: your credit balance is too low to access the Anthropic API.' });
  b.run();
  assert.equal(b.file('engine-error').split('\n')[0], 'quota');
  assert.equal(b.calls().length, 1);
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

const BUDGET_STOP = JSON.stringify({ type: 'result', subtype: 'error_max_budget_usd', is_error: true, total_cost_usd: 1.01, duration_api_ms: 9000,
  modelUsage: { 'claude-haiku-5-5': { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0, cacheReadInputTokens: 9000, cacheCreationInputTokens: 0 } } });
const FINAL_OK = result({ total_cost_usd: 0.05, duration_api_ms: 1500, modelUsage: { 'claude-haiku-5-5': { inputTokens: 100, outputTokens: 50, cacheReadInputTokens: 800, cacheCreationInputTokens: 0 } } });

test('a budget stop without an answer: ONE finalize turn on the same session, no tools, same schema, 20% budget; findings written, finalized note, usage summed', (t) => {
  const s = setup(t, { out: BUDGET_STOP, rc: 1, then: [{ out: FINAL_OK, rc: 0 }] });
  const r = s.run({ MAX_BUDGET_USD: '2.00' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const [main, fin, ...more] = s.calls();
  assert.equal(more.length, 0, 'exactly one finalize turn');
  assert.equal(flag(main, '--max-budget-usd'), '2.00');
  assert.equal(flag(fin, '--resume'), flag(main, '--session-id'), 'the same session');
  assert.ok(!fin.includes('--session-id'));
  assert.equal(flag(fin, '--tools'), '', 'no tools');
  assert.ok(!fin.includes('--allowedTools'));
  assert.equal(flag(fin, '--max-budget-usd'), '0.40');
  assert.equal(flag(fin, '--permission-mode'), 'dontAsk');
  assert.ok(fin.includes('--bare') && fin.includes('--restricted'));
  assert.equal(flag(fin, '--json-schema'), flag(main, '--json-schema'), 'the same schema');
  assert.equal(flag(fin, '--model'), 'claude-haiku-5-5');
  assert.match(s.read('stdin.2'), /^Stop investigating\. Using only what you have already read, return the final JSON object now; mark anything unsettled as unknown\.$/);
  assert.deepEqual(JSON.parse(s.file('findings.json')), VALID);
  assert.equal(s.file('engine-repair'), 'finalized');
  assert.ok([null, 'success'].includes(s.file('engine-status')) && s.file('engine-status') === 'success');
  assert.equal(s.file('engine-error'), null);
  assert.match(s.file('engine-notes'), /^finalized: The per-run budget of \$2\.00 was reached .*raise max_budget_usd/);
  assert.match(r.stdout, /::warning::Claude review stopped early \(budget\); finalized/);
  const { mergeUsage, usageLine } = require('./post.js');
  const sum = mergeUsage(JSON.parse(s.file('usage.json')), JSON.parse(s.file('usage-repair.json')));
  assert.ok(Math.abs(sum.totalCostUsd - 1.06) < 1e-9, 'both turns are in the cost');
  assert.match(usageLine({ engine: 'claude', model: 'claude-haiku-5-5', raw: sum, used: ['claude-haiku-5-5'] }), /Cost \$1\.06/);
  assert.ok(!s.everything(r).includes(KEY));
  const m = setup(t, { out: JSON.stringify({ type: 'result', subtype: 'error_max_turns', is_error: true, total_cost_usd: 0.5 }), rc: 1, then: [{ out: FINAL_OK, rc: 0 }] });
  m.run();
  assert.equal(m.calls().length, 2, 'the turn limit also gets a finalize turn');
  assert.equal(m.file('engine-repair'), 'finalized');
});

test('the finalize turn fails too: finalize_failed, status failed, the budget message names max_budget_usd, both usages kept', (t) => {
  const s = setup(t, { out: BUDGET_STOP, rc: 1, then: [{ out: BUDGET_STOP, rc: 1 }] });
  const r = s.run();
  assert.equal(r.status, 0);
  assert.equal(s.calls().length, 2);
  assert.equal(s.file('engine-repair'), 'finalize_failed');
  assert.equal(s.file('engine-status'), 'failed');
  assert.equal(s.file('engine-error').split('\n')[0], 'budget');
  assert.match(s.file('engine-error').split('\n')[1], /per-run budget of \$1\.00.*raise max_budget_usd/);
  assert.match(s.file('engine-notes'), /finalize turn failed/);
  assert.match(r.stdout, /::warning::Claude review failed: The per-run budget/);
  assert.equal(s.file('findings.json'), null);
  assert.equal(JSON.parse(s.file('usage-repair.json')).totalCostUsd, 1.01);
  const bad = setup(t, { out: BUDGET_STOP, rc: 1, then: [{ out: result({ structured_output: { findings: [] } }), rc: 0 }] });
  bad.run();
  assert.equal(bad.file('engine-repair'), 'finalize_failed', 'an invalid finalize answer does not count');
  assert.equal(bad.file('engine-status'), 'failed');
});

test('the finalize budget is 20% of the main one, at least 0.10; no finalize for auth, rate, model errors, a timeout or an error before any work', (t) => {
  const s = setup(t, { out: BUDGET_STOP, rc: 1, then: [{ out: FINAL_OK }] });
  s.run({ MAX_BUDGET_USD: '0.30' });
  assert.equal(flag(s.calls()[1], '--max-budget-usd'), '0.10');
  for (const err of ['API Error: 401 invalid x-api-key', 'API Error: 429 rate_limit_error']) {
    const x = setup(t, { out: JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: err, total_cost_usd: 0.3 }), rc: 1 });
    x.run();
    assert.equal(x.calls().length, 1, err);
  }
  const none = setup(t, { out: JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'boom' }), rc: 1 });
  none.run();
  assert.equal(none.calls().length, 1, 'nothing was spent: nothing to finalize');
  assert.equal(none.file('engine-status'), 'failed');
});

test('messages are engine-neutral: no JSON found in the engine output; validate-inputs checks max_budget_usd', (t) => {
  const s = setup(t, { out: result({ structured_output: undefined, result: '' }) });
  const r = s.run();
  assert.match(r.stdout, /no JSON found in the engine output/);
  assert.doesNotMatch(r.stdout, /Copilot/);
  const v = (b) => spawnSync(bash, [fwd(path.join(__dirname, 'validate-inputs.sh'))], { encoding: 'utf8', env: { ...process.env, ENGINE: 'claude', MODEL: '', EFFORT: '', MAX_CREDITS: '60', TIMEOUT: '12', MAX_BUDGET_USD: b } });
  for (const ok of ['', '1.00', '0.5', '20']) assert.equal(v(ok).status, 0, ok);
  for (const bad of ['0', '20.01', '-1', 'abc', '1.234', '100']) { const x = v(bad); assert.equal(x.status, 1, bad); assert.match(x.stdout, /^::error::max_budget_usd must be a positive decimal of at most 20/m); }
});

test('a Could not complete summary carries the usage line exactly once (comment and job summary)', () => {
  const { buildSummary } = require('./post.js');
  const body = buildSummary({ status: 'Could not complete: x', engine: 'claude', model: 'claude-haiku-5-5', usage: { totalCostUsd: 3.58 }, notes: ['n'], state: 'failed', used: ['claude-haiku-5-5'], tooling: { status: 'not_configured', checks: [] } });
  assert.equal(body.split('<sub>Engine:').length - 1, 1);
});

test('engine notes are de-duplicated: the finalize note and the repair label say the same fact once', (t) => {
  const { engineNotes } = require('./post.js');
  const s = setup(t, { out: BUDGET_STOP, rc: 1, then: [{ out: BUDGET_STOP, rc: 1 }] });
  s.run();
  const raw = s.file('engine-notes');
  assert.doesNotMatch(raw, /:\s*(\n|$)/, 'no dangling colon when the CLI gave no message');
  const notes = engineNotes(raw, s.file('engine-repair'));
  assert.equal(notes.filter((n) => /^finalize turn failed/.test(n)).length, 1, notes.join(' | '));
  assert.deepEqual(engineNotes('finalize turn failed: error_max_budget_usd\nfinalize turn failed: error_max_budget_usd\n', 'finalize_failed'), ['finalize turn failed: error_max_budget_usd']);
  assert.deepEqual(engineNotes('finalized: budget reached; answered from what it had read', 'finalized'), ['finalized: budget reached; answered from what it had read']);
  assert.deepEqual(engineNotes('effort ignored: claude engine', 'finalize_failed'), ['effort ignored: claude engine', 'finalize turn failed']);
  assert.deepEqual(engineNotes('', ''), []);
});
