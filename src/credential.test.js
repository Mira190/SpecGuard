const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');
const { detect, resolveEngine, resolveModel, resolve } = require('./credential');

const root = path.join(__dirname, '..');
const TOKENS = { // made-up values; the tests assert none of them is ever echoed
  copilot: ['github_pat_11ZZZZ0Qq_rstUVWxyz0123456789', 'gho_QqRrSsTt0123456789', 'ghu_QqRrSsTt0123456789'],
  anthropic: ['sk-ant-api03-QqRrSsTt_0123-456789'],
};
function cli(env) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'specguard-cred-'));
  const out = path.join(dir, 'output');
  try {
    const r = spawnSync(process.execPath, [path.join(__dirname, 'credential.js')], { encoding: 'utf8', env: { PATH: process.env.PATH, GITHUB_OUTPUT: out, ...env } });
    const output = fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : '';
    return { r, output, all: `${r.stdout}${r.stderr}${output}` };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test('detection by prefix: fine-grained, OAuth and user-to-server tokens are copilot; sk-ant- is anthropic; empty means the job token', () => {
  for (const t of TOKENS.copilot) assert.deepEqual(detect(t), { kind: 'copilot' });
  for (const t of TOKENS.anthropic) assert.deepEqual(detect(t), { kind: 'anthropic' });
  assert.deepEqual(detect(''), { kind: '' });
  assert.deepEqual(detect(undefined), { kind: '' });
  assert.deepEqual(detect(`  ${TOKENS.copilot[0]}\n`), { kind: 'copilot' }, 'a pasted newline is trimmed');
});

test('ghp_ and unknown values are rejected with a message that never contains the value', () => {
  assert.equal(detect('ghp_Secret0123456789').error, 'classic GitHub PATs are not supported by Copilot; use a fine-grained PAT with Copilot Requests');
  for (const t of ['ghs_Secret0123456789', 'sk-proj-Secret0123', 'AIzaSecret0123', 'xyz']) {
    const e = detect(t).error;
    assert.equal(e, 'unrecognized credential type (expected a GitHub fine-grained PAT or an Anthropic API key)');
    assert.ok(!e.includes(t));
  }
});

test('cli: writes only kind, engine and model to GITHUB_OUTPUT and logs only the kind; the token appears nowhere', () => {
  const cases = [...TOKENS.copilot.map((t) => [t, 'copilot', 'copilot']), ...TOKENS.anthropic.map((t) => [t, 'anthropic', 'claude'])];
  for (const [LLM_TOKEN, kind, engine] of cases) {
    const { r, output, all } = cli({ LLM_TOKEN, ENGINE: 'auto', MODEL: 'haiku-5.5' });
    assert.equal(r.status, 0, all);
    assert.equal(r.stdout.trim(), `credential: ${kind}`);
    assert.equal(output, `kind=${kind}\nengine=${engine}\nmodel=${engine === 'claude' ? 'claude-haiku-5-5' : 'claude-haiku-5.5'}\n`);
    assert.ok(!all.includes(LLM_TOKEN), 'the token is never echoed');
    assert.ok(!all.includes(LLM_TOKEN.slice(0, 12)), 'nor a prefix of it');
  }
});

test('cli: failures exit 1 with ::error:: and no token; an empty token is the job token on copilot', () => {
  for (const LLM_TOKEN of ['ghp_Secret0123456789', 'something-else-Secret0123']) {
    const { r, all } = cli({ LLM_TOKEN, ENGINE: 'auto' });
    assert.equal(r.status, 1);
    assert.match(r.stdout, /^::error::/);
    assert.ok(!all.includes('Secret0123'));
  }
  const { r, output } = cli({ LLM_TOKEN: '', ENGINE: 'auto', MODEL: '' });
  assert.equal(r.status, 0);
  assert.equal(output, 'kind=\nengine=copilot\nmodel=\n');
  assert.equal(r.stdout.trim(), 'credential: job token');
});

test('cli: a newline in engine or model cannot inject extra GITHUB_OUTPUT lines', () => {
  const { r, output } = cli({ LLM_TOKEN: '', ENGINE: 'auto', MODEL: 'x\nengine=evil' });
  assert.equal(r.status, 1);
  assert.equal(output, '');
});

test('engine dispatch: auto follows the credential kind; an explicit engine must match it; unknown names are left for the allow-list', () => {
  assert.deepEqual(resolveEngine('auto', 'anthropic'), { engine: 'claude' });
  assert.deepEqual(resolveEngine('auto', 'copilot'), { engine: 'copilot' });
  assert.deepEqual(resolveEngine('auto', ''), { engine: 'copilot' }, 'no token: copilot on the job token');
  assert.deepEqual(resolveEngine('', 'anthropic'), { engine: 'claude' }, 'empty = auto');
  assert.deepEqual(resolveEngine('copilot', 'copilot'), { engine: 'copilot' });
  assert.deepEqual(resolveEngine('copilot', ''), { engine: 'copilot' });
  assert.deepEqual(resolveEngine('claude', 'anthropic'), { engine: 'claude' });
  assert.match(resolveEngine('claude', '').error, /needs an Anthropic API key/);
  assert.match(resolveEngine('claude', 'copilot').error, /needs an Anthropic API key/);
  assert.match(resolveEngine('copilot', 'anthropic').error, /needs a GitHub fine-grained PAT/);
  assert.deepEqual(resolveEngine('nope', 'copilot'), { engine: 'nope' });
});

test('model aliases: haiku-5.5 is per engine, case-insensitive; explicit full ids and empty pass through', () => {
  assert.equal(resolveModel('haiku-5.5', 'copilot'), 'claude-haiku-5.5');
  assert.equal(resolveModel('haiku-5.5', 'claude'), 'claude-haiku-5-5');
  assert.equal(resolveModel(' Haiku-5.5 ', 'claude'), 'claude-haiku-5-5');
  for (const m of ['claude-haiku-5.5', 'claude-opus-4-1', 'gpt-6-luna', 'auto']) assert.equal(resolveModel(m, 'claude'), m);
  assert.equal(resolveModel('', 'copilot'), '');
  assert.equal(resolveModel(undefined, 'claude'), '');
  assert.deepEqual(resolve({ token: TOKENS.anthropic[0], engine: 'auto', model: 'haiku-5.5' }), { kind: 'anthropic', engine: 'claude', model: 'claude-haiku-5-5' });
});

// Contract of action.yml and the workflows, parsed with python's yaml (skipped when python or pyyaml is missing).
function yamlOf(rel) {
  const py = 'import sys,json,yaml\nprint(json.dumps(yaml.safe_load(open(sys.argv[1],encoding="utf8")), default=str))\n';
  for (const exe of ['python3', 'python']) {
    try { return JSON.parse(execFileSync(exe, ['-c', py, path.join(root, rel)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })); } catch (e) { if (!/ENOENT|No module named yaml|not found|Python was not found/i.test(String(e.stderr) + e.message)) throw e; }
  }
  return null;
}
const stepOf = (a, id) => a.runs.steps.find((s) => s.id === id);

test('action.yml: llm_token and copilot_token inputs, engine defaults to auto, claude_version pinned; the token reaches only env, never a command line', (t) => {
  const a = yamlOf('action.yml');
  if (!a) return t.skip('python yaml unavailable');
  assert.equal(a.inputs.engine.default, 'auto');
  assert.equal(a.inputs.llm_token.default, '');
  assert.equal(a.inputs.copilot_token.default, '');
  assert.match(a.inputs.claude_version.default, /^2\.\d+\.\d+$/);
  const cred = stepOf(a, 'credential'), eng = stepOf(a, 'engine'), run = a.runs.steps.find((s) => s.name === 'Run the review engine');
  assert.equal(cred.env.LLM_TOKEN, '${{ inputs.llm_token || inputs.copilot_token }}');
  assert.equal(cred.run, 'node "$GITHUB_ACTION_PATH/src/credential.js"');
  assert.equal(eng.env.ENGINE, '${{ steps.credential.outputs.engine }}');
  assert.equal(eng.env.MODEL, '${{ steps.credential.outputs.model }}');
  assert.equal(run.env.MODEL, '${{ steps.credential.outputs.model }}');
  assert.match(run.env.ANTHROPIC_API_KEY, /steps\.credential\.outputs\.kind == 'anthropic' && \(inputs\.llm_token \|\| inputs\.copilot_token\) \|\| ''/);
  assert.match(run.env.COPILOT_GITHUB_TOKEN, /steps\.credential\.outputs\.kind != 'anthropic' && \(inputs\.llm_token \|\| inputs\.copilot_token\) \|\| ''/);
  for (const s of a.runs.steps) assert.doesNotMatch(String(s.run || '').replace(/^.*ANTHROPIC.*$/m, ''), /inputs\.(llm|copilot)_token/, 'secrets are only passed through env');
  assert.ok(a.runs.steps.indexOf(cred) < a.runs.steps.indexOf(eng) && a.runs.steps.indexOf(eng) < a.runs.steps.indexOf(run));
});

test('workflows: the dogfood job and the manual run use llm_token (SPECGUARD_LLM_TOKEN || SPEC) with model haiku-5.5; the reusable workflow forwards an optional llm_token secret next to copilot_token', (t) => {
  const ci = yamlOf('.github/workflows/ci.yml'), run = yamlOf('.github/workflows/specguard-run.yml'), reuse = yamlOf('.github/workflows/specguard.yml');
  if (!ci) return t.skip('python yaml unavailable');
  const TOKEN = '${{ secrets.SPECGUARD_LLM_TOKEN || secrets.SPEC }}';
  const dog = ci.jobs.dogfood.steps.find((s) => s.uses === './');
  assert.equal(dog.with.llm_token, TOKEN);
  assert.equal(dog.with.model, 'haiku-5.5');
  const review = Object.values(run.jobs).flatMap((j) => j.steps || []).find((s) => s.uses === './.specguard-src');
  assert.equal(review.with.llm_token, TOKEN);
  assert.equal(review.with.model, 'haiku-5.5');
  assert.equal(review.with.copilot_token, '${{ secrets.SPECGUARD_COPILOT_TOKEN }}', 'the Copilot PAT keeps working');
  assert.equal((reuse.on || reuse.true).workflow_call.secrets.llm_token.required, false);
  assert.equal((reuse.on || reuse.true).workflow_call.secrets.copilot_token.required, false);
  const call = reuse.jobs.specguard.steps.find((s) => /^Mira190\/SpecGuard@/.test(s.uses || ''));
  assert.equal(call.with.llm_token, '${{ secrets.llm_token || secrets.SPECGUARD_LLM_TOKEN }}');
  assert.equal(call.with.copilot_token, '${{ secrets.copilot_token || secrets.SPECGUARD_COPILOT_TOKEN }}');
});
