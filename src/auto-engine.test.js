// End to end through action.yml's own wiring: the credential step, the engine step and the env of the "Run the review engine" step are read from action.yml,
// their ${{ }} expressions evaluated, and the scripts run with a fake `copilot` and a fake `claude` on PATH. One workflow line must work for both credential kinds:
//   llm_token: ${{ secrets.SPECGUARD_LLM_TOKEN || secrets.SPEC }}, engine auto, model haiku-5.5
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const bash = process.platform === 'win32' ? path.join(process.env.ProgramFiles, 'Git/bin/bash.exe') : 'bash';
const fwd = (p) => p.replace(/\\/g, '/');
const VALID = { coverage: [], findings: [], requirements: [] };
const TOKENS = { // made up; none may appear in any output
  copilot: 'github_pat_11TESTONLY0_abcdefghijklmnopqrstuvwxyz0123456789',
  anthropic: 'sk-ant-api03-TESTONLY_abcdefghijklmnopqrstuvwxyz-0123456789',
};

function loadAction() {
  const py = 'import sys,json,yaml\nprint(json.dumps(yaml.safe_load(open(sys.argv[1],encoding="utf8"))))\n';
  for (const exe of ['python3', 'python']) {
    try { return JSON.parse(execFileSync(exe, ['-c', py, path.join(root, 'action.yml')], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })); } catch { /* try the next */ }
  }
  return null;
}
// ${{ a || b && c }} -> value. Only the forms action.yml uses: inputs.X, steps.S.outputs.X, ==, !=, &&, ||, parentheses, string literals.
function evaluate(str, ctx) {
  return String(str).replace(/\$\{\{([\s\S]*?)\}\}/g, (_, e) => {
    const js = e.replace(/\binputs\.(\w+)/g, 'ctx.inputs.$1').replace(/\bsteps\.(\w+)\.outputs\.(\w+)/g, 'ctx.steps.$1.$2').replace(/\bgithub\.[\w.]+/g, "''")
      .replace(/!=(?!=)/g, '!==').replace(/(?<![!=])==(?!=)/g, '===');
    return String(new Function('ctx', `return (${js}) ?? ''`)(ctx));
  });
}
const envOf = (step, ctx) => Object.fromEntries(Object.entries(step.env || {}).map(([k, v]) => [k, evaluate(v, ctx)]));

function sandbox(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'specguard-auto-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'bin'), ctx = path.join(dir, 'ctx'), log = path.join(dir, 'calls.log'), envlog = path.join(dir, 'env.log');
  for (const d of [bin, ctx]) fs.mkdirSync(d);
  fs.writeFileSync(path.join(dir, 'prompt.txt'), 'REVIEW PROMPT');
  const unavailable = path.join(dir, 'unavailable');
  fs.writeFileSync(path.join(bin, 'copilot'), `#!/usr/bin/env bash
[ "$1" = --version ] && { echo "GitHub Copilot CLI 1.0.92."; exit 0; }
{ echo copilot; printf '%s\\n' "$@"; echo '---'; } >> "${fwd(log)}"
echo "copilot token=\${COPILOT_GITHUB_TOKEN:+set} anthropic=\${ANTHROPIC_API_KEY:+set}" >> "${fwd(envlog)}"
cat > /dev/null
model=''; prev=''; for a in "$@"; do [ "$prev" = --model ] && model=$a; [ "$prev" = --usage-output-file ] && echo '{"totalNanoAiu":1000000000,"currentModel":"claude-haiku-5.5"}' > "$a"; prev=$a; done
[ -f "${fwd(unavailable)}" ] && [ "$model" = claude-haiku-5.5 ] && { echo "Model from --model flag is not available" >&2; exit 1; }
printf '%s' '${JSON.stringify(VALID)}'
`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'claude'), `#!/usr/bin/env bash
[ "$1" = --version ] && { echo "2.1.284 (Claude Code)"; exit 0; }
{ echo claude; printf '%s\\n' "$@"; echo '---'; } >> "${fwd(log)}"
echo "claude token=\${COPILOT_GITHUB_TOKEN:+set} anthropic=\${ANTHROPIC_API_KEY:+set}" >> "${fwd(envlog)}"
cat > /dev/null
printf '%s' '${JSON.stringify({ type: 'result', subtype: 'success', is_error: false, structured_output: VALID, total_cost_usd: 0.01, duration_api_ms: 900, modelUsage: { 'claude-haiku-5-5': { inputTokens: 10, outputTokens: 5 } } })}'
`, { mode: 0o755 });
  const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } };
  return {
    dir, bin, ctx, unavailable,
    calls: () => read(log).split('---\n').filter(Boolean).map((c) => c.split('\n').filter(Boolean)), // [engine, ...argv]
    envs: () => read(envlog).split('\n').filter(Boolean),
    ctxFiles: () => fs.readdirSync(ctx).map((n) => read(path.join(ctx, n))).join('\n'),
    prompt: path.join(dir, 'prompt.txt'),
  };
}

// Runs the credential step, the engine step's script and the engine itself the way the composite action would.
function runAction(t, a, inputs, { unavailable = false } = {}) {
  const s = sandbox(t);
  if (unavailable) fs.writeFileSync(s.unavailable, '1');
  const defaults = Object.fromEntries(Object.entries(a.inputs).map(([k, v]) => [k, v.default ?? '']));
  const ctx = { inputs: { ...defaults, ...inputs }, steps: { mode: { mode: 'pr' } } };
  const output = path.join(s.dir, 'github_output');
  const base = { ...process.env, PATH: s.bin + path.delimiter + process.env.PATH, GITHUB_ACTION_PATH: fwd(root), GITHUB_OUTPUT: fwd(output), COPILOT_GITHUB_TOKEN: '', ANTHROPIC_API_KEY: '' };
  const outputs = () => Object.fromEntries(fs.readFileSync(output, 'utf8').split('\n').filter(Boolean).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
  const step = (id) => a.runs.steps.find((x) => x.id === id);
  const seen = [];
  const sh = (cmd, env) => { const r = spawnSync(bash, ['-c', cmd], { encoding: 'utf8', env: { ...base, ...env }, timeout: 60000 }); seen.push(r.stdout, r.stderr); return r; };

  const cred = sh(step('credential').run, envOf(step('credential'), ctx));
  assert.equal(cred.status, 0, cred.stdout + cred.stderr);
  ctx.steps.credential = outputs();
  const eng = sh(step('engine').run, envOf(step('engine'), ctx));
  assert.equal(eng.status, 0, eng.stdout + eng.stderr);
  ctx.steps.engine = outputs(); // later lines win, as in Actions
  const run = a.runs.steps.find((x) => x.name === 'Run the review engine');
  const env = { ...envOf(run, ctx), CTX: fwd(s.ctx), PROMPT_FILE: fwd(s.prompt) };
  const r = sh('bash "$GITHUB_ACTION_PATH/src/engines/$ENGINE.sh"', env);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  return { s, outputs: ctx.steps.credential, engine: ctx.steps.engine.engine, env, everything: () => [...seen, s.ctxFiles(), ...s.calls().map((c) => c.join(' ')), ...s.envs(), fs.readFileSync(output, 'utf8')].join('\n') };
}

const TOKEN_LINE = (tok) => ({ llm_token: tok, engine: 'auto', model: 'haiku-5.5' });

test('a GitHub fine-grained PAT: copilot adapter, model claude-haiku-5.5, COPILOT_GITHUB_TOKEN only, nothing leaks', (t) => {
  const a = loadAction();
  if (!a) return t.skip('python yaml unavailable');
  const tok = TOKENS.copilot;
  const x = runAction(t, a, TOKEN_LINE(tok));
  assert.equal(x.outputs.kind, 'copilot');
  assert.equal(x.engine, 'copilot');
  assert.equal(x.env.MODEL, 'claude-haiku-5.5');
  assert.equal(x.env.COPILOT_GITHUB_TOKEN, tok, 'the token reaches the adapter by environment');
  assert.equal(x.env.ANTHROPIC_API_KEY, '');
  const calls = x.s.calls();
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'copilot');
  assert.equal(calls[0][calls[0].indexOf('--model') + 1], 'claude-haiku-5.5');
  assert.deepEqual(x.s.envs(), ['copilot token=set anthropic=']);
  assert.ok(!x.everything().includes(tok) && !x.everything().includes('TESTONLY'));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(x.s.ctx, 'findings.json'), 'utf8')), VALID);
});

test('a GitHub PAT whose plan lacks the model falls back to auto once and says so', (t) => {
  const a = loadAction();
  if (!a) return t.skip('python yaml unavailable');
  const x = runAction(t, a, TOKEN_LINE(TOKENS.copilot), { unavailable: true });
  const models = x.s.calls().map((c) => c[c.indexOf('--model') + 1]);
  assert.deepEqual(models, ['claude-haiku-5.5', 'auto']);
  assert.match(fs.readFileSync(path.join(x.s.ctx, 'engine-notes'), 'utf8'), /model_fallback: claude-haiku-5\.5 → auto/);
  assert.ok(!x.everything().includes(TOKENS.copilot));
});

test('an Anthropic API key: claude adapter, model claude-haiku-5-5, ANTHROPIC_API_KEY only, nothing leaks', (t) => {
  const a = loadAction();
  if (!a) return t.skip('python yaml unavailable');
  const tok = TOKENS.anthropic;
  const x = runAction(t, a, TOKEN_LINE(tok));
  assert.equal(x.outputs.kind, 'anthropic');
  assert.equal(x.engine, 'claude');
  assert.equal(x.env.MODEL, 'claude-haiku-5-5');
  assert.equal(x.env.ANTHROPIC_API_KEY, tok);
  assert.equal(x.env.COPILOT_GITHUB_TOKEN, '');
  const calls = x.s.calls();
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'claude');
  assert.equal(calls[0][calls[0].indexOf('--model') + 1], 'claude-haiku-5-5');
  assert.deepEqual(x.s.envs(), ['claude token= anthropic=set']);
  assert.ok(!x.everything().includes(tok) && !x.everything().includes('TESTONLY'));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(x.s.ctx, 'findings.json'), 'utf8')), VALID);
  assert.equal(JSON.parse(fs.readFileSync(path.join(x.s.ctx, 'usage.json'), 'utf8')).totalCostUsd, 0.01);
});

test('copilot_token keeps working as before: the alias goes to Copilot; llm_token wins when both are set', (t) => {
  const a = loadAction();
  if (!a) return t.skip('python yaml unavailable');
  const alias = runAction(t, a, { copilot_token: TOKENS.copilot });
  assert.equal(alias.engine, 'copilot');
  assert.equal(alias.env.COPILOT_GITHUB_TOKEN, TOKENS.copilot);
  assert.equal(alias.env.MODEL, '');
  assert.deepEqual(alias.s.envs(), ['copilot token=set anthropic=']);
  const both = runAction(t, a, { copilot_token: TOKENS.copilot, llm_token: TOKENS.anthropic });
  assert.equal(both.engine, 'claude');
  assert.equal(both.env.COPILOT_GITHUB_TOKEN, '');
});

test('no token: copilot on the job token (no token env at all); a rejected credential fails before any engine runs', (t) => {
  const a = loadAction();
  if (!a) return t.skip('python yaml unavailable');
  const x = runAction(t, a, {});
  assert.equal(x.engine, 'copilot');
  assert.deepEqual(x.s.envs(), ['copilot token= anthropic=']);
  const s = sandbox(t);
  const r = spawnSync(process.execPath, [path.join(__dirname, 'credential.js')], { encoding: 'utf8', env: { PATH: process.env.PATH, LLM_TOKEN: 'ghp_TESTONLYclassic0123456789', ENGINE: 'auto', GITHUB_OUTPUT: path.join(s.dir, 'o') } });
  assert.equal(r.status, 1);
  assert.equal(s.calls().length, 0);
  assert.ok(!(r.stdout + r.stderr).includes('TESTONLY'));
});
