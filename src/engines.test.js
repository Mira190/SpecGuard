const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const bash = process.platform === 'win32' ? path.join(process.env.ProgramFiles, 'Git/bin/bash.exe') : 'bash';
const ENGINES_DIR = path.join(__dirname, 'engines');
const VALID = { coverage: [], findings: [], requirements: [] };
const fwd = (p) => p.replace(/\\/g, '/');
const allowList = () => /^ENGINES=\(([^)]*)\)/m.exec(fs.readFileSync(path.join(__dirname, 'validate-inputs.sh'), 'utf8'))[1].trim().split(/\s+/);

// A fake `copilot` and a fake `npm` on PATH, and a mock @github/copilot-sdk (a module dir for NODE_PATH, or what the fake `npm install --prefix` creates).
function sandbox(t, { copilotRc = 0, copilotErr = '', copilotOut = JSON.stringify(VALID), npmRc = 0, sdk = 'ok' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'specguard-engines-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'bin'), ctx = path.join(dir, 'ctx'), mods = path.join(dir, 'mods'), log = path.join(dir, 'argv.log');
  for (const d of [bin, ctx, mods]) fs.mkdirSync(d);
  fs.writeFileSync(path.join(dir, 'prompt.txt'), 'REVIEW PROMPT');
  const sdkSource = sdk === 'ok'
    ? `exports.CopilotClient = class { async start() {} async stop() {} async forceStop() {}
        async createSession(cfg) { const tool = cfg.tools[0]; return { sessionId: cfg.sessionId, on() {},
          async sendAndWait() { await tool.handler(${JSON.stringify(VALID)}, {}); },
          async disconnect() {} }; } };`
    : 'exports.CopilotClient = class { async start() { throw new Error("no auth"); } async stop() {} async forceStop() {} };';
  const put = (root) => { fs.mkdirSync(path.join(root, '@github/copilot-sdk'), { recursive: true }); fs.writeFileSync(path.join(root, '@github/copilot-sdk/index.js'), sdkSource); };
  put(mods);
  fs.writeFileSync(path.join(dir, 'sdk-source.js'), sdkSource);
  fs.writeFileSync(path.join(bin, 'copilot'), `#!/usr/bin/env bash
{ printf '%s\\n' "$@"; echo '---'; } >> "${fwd(log)}"
cat > /dev/null
prev=''; for a in "$@"; do [ "$prev" = --usage-output-file ] && echo '{"totalNanoAiu":1000000000,"currentModel":"fake-model"}' > "$a"; prev=$a; done
printf '%s' '${copilotOut.replace(/'/g, "'\\''")}'
printf '%s' '${copilotErr.replace(/'/g, "'\\''")}' >&2
exit ${copilotRc}
`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'npm'), `#!/usr/bin/env bash
{ echo "npm $*"; } >> "${fwd(log)}"
[ ${npmRc} = 0 ] || exit ${npmRc}
prev=''; for a in "$@"; do [ "$prev" = --prefix ] && { mkdir -p "$a/node_modules/@github/copilot-sdk"; cp "${fwd(path.join(dir, 'sdk-source.js'))}" "$a/node_modules/@github/copilot-sdk/index.js"; }; prev=$a; done
exit 0
`, { mode: 0o755 });
  const run = (name, extra = {}) => spawnSync(bash, [fwd(path.join(ENGINES_DIR, `${name}.sh`))], {
    encoding: 'utf8', timeout: 60000,
    env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH, MSYS2_ENV_CONV_EXCL: 'NODE_PATH', NODE_PATH: mods, CTX: fwd(ctx), PROMPT_FILE: fwd(path.join(dir, 'prompt.txt')), RUNNER_TEMP: fwd(path.join(dir, 'tmp')),
      MODEL: '', EFFORT: '', AUTO_TIER: undefined, MAX_CREDITS: '60', TIMEOUT: '5', COPILOT_VERSION: '', SDK_VERSION: '', COPILOT_GITHUB_TOKEN: '', CHECK: '', ...extra },
  });
  const file = (n) => { try { return fs.readFileSync(path.join(ctx, n), 'utf8').trim(); } catch { return null; } };
  const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('---\n').filter(Boolean).map((c) => c.split('\n').filter(Boolean)) : []);
  return { run, file, calls, ctx, log: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '') };
}
const flag = (c, f) => (c.includes(f) ? c[c.indexOf(f) + 1] : undefined);

test('engine allow-list: copilot and copilot-sdk pass, anything else (incl. path tricks) fails, and every allowed engine has its script', () => {
  const v = (env) => spawnSync(bash, [fwd(path.join(__dirname, 'validate-inputs.sh'))], { encoding: 'utf8', env: { ...process.env, MODEL: '', EFFORT: '', MAX_CREDITS: '60', TIMEOUT: '5', ...env } });
  assert.deepEqual(allowList(), ['copilot', 'copilot-sdk']);
  for (const ENGINE of allowList()) { assert.equal(v({ ENGINE }).status, 0, ENGINE); assert.ok(fs.existsSync(path.join(ENGINES_DIR, `${ENGINE}.sh`)), `${ENGINE}.sh`); }
  for (const ENGINE of ['', 'claude', 'copilot ', '../copilot', 'copilot.sh', 'copilot-sdk;id', 'COPILOT']) {
    const r = v({ ENGINE });
    assert.equal(r.status, 1, JSON.stringify(ENGINE));
    assert.match(r.stdout, /^::error::engine must be one of: copilot copilot-sdk/m);
  }
  assert.equal(v({}).status, 0, 'no ENGINE (an adapter run directly) is not checked');
  for (const bad of [{ COPILOT_VERSION: '1.0.92; rm -rf /' }, { SDK_VERSION: '$(id)' }, { SDK_VERSION: '-g' }, { COPILOT_VERSION: 'latest' }]) assert.equal(v(bad).status, 1, JSON.stringify(bad));
  for (const ok of [{ COPILOT_VERSION: '1.0.92' }, { SDK_VERSION: '1.0.15' }, { SDK_VERSION: '2.0.0-beta.1' }]) assert.equal(v(ok).status, 0, JSON.stringify(ok));
});

test('action.yml dispatches on the validated engine: one engine step runs src/engines/$ENGINE.sh, no per-engine step', () => {
  const y = fs.readFileSync(path.join(__dirname, '..', 'action.yml'), 'utf8').replace(/\r\n/g, '\n');
  assert.equal((y.match(/src\/engines\/\$ENGINE\.sh/g) || []).length, 1);
  assert.match(y, /- name: Run the review engine\n {6}if: .*\n {6}shell: bash\n {6}env:\n {8}ENGINE: \$\{\{ steps\.engine\.outputs\.engine \}\}/); // the step reads the validated output, never the raw input
  assert.match(y, /- id: engine\n[\s\S]*?validate-inputs\.sh" \|\| exit 1[^\n]*\n {8}echo "engine=\$ENGINE" >> "\$GITHUB_OUTPUT"/);
  assert.doesNotMatch(y, /src\/copilot-run\.sh|Review with Copilot CLI/);
  assert.match(y, /^ {2}copilot_sdk_version: \{[^}]*default: "1\.0\.15"/m);
  assert.match(y, /^ {2}test_paths: /m);
  const readme = fs.readFileSync(path.join(ENGINES_DIR, 'README.md'), 'utf8');
  for (const e of allowList()) assert.ok(readme.includes(`\`${e}\``), `README names ${e}`);
});

// The adapter contract (src/engines/README.md): the same env in, the same files out, exit 0, never a write to anything but $CTX.
const ADAPTERS = ['copilot', 'copilot-sdk'];
for (const name of ADAPTERS) {
  test(`contract: ${name} succeeds: exit 0, findings.json is the raw answer, no failure status, usage in the documented shape, engine-model.json`, (t) => {
    const s = sandbox(t);
    const r = s.run(name);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.ok(isAnswer(s.file('findings.json')));
    assert.ok([null, 'success'].includes(s.file('engine-status')), String(s.file('engine-status')));
    const u = s.file('usage.json');
    if (u) assert.equal(typeof JSON.parse(u), 'object');
    assert.ok(s.file('engine-model.json') === null || typeof JSON.parse(s.file('engine-model.json')) === 'object');
    assert.equal(s.file('engine-repair'), null);
  });
  test(`contract: ${name} reads a prompt of 300 KB from PROMPT_FILE (never argv or the environment)`, (t) => {
    const s = sandbox(t);
    const big = 'x"y\'z $HOME é\n'.repeat(22000);
    const file = path.join(path.dirname(s.ctx), 'big.txt');
    fs.writeFileSync(file, big);
    const r = s.run(name, { PROMPT_FILE: fwd(file) });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.ok(!s.log().includes('xyz') && !s.log().includes(big.slice(0, 40)));
    assert.ok(isAnswer(s.file('findings.json')));
  });
  test(`contract: ${name} never throws past the script: a failing engine is engine-status failed, a warning, exit 0`, (t) => {
    const s = sandbox(t, name === 'copilot' ? { copilotRc: 1, copilotOut: '', copilotErr: 'boom' } : { sdk: 'bad' });
    const r = s.run(name);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(s.file('engine-status'), 'failed');
    assert.match(r.stdout, /::warning::/);
  });
  test(`contract: ${name} respects TIMEOUT including the install: a failed install is engine-status failed and a note, exit 0`, (t) => {
    const s = sandbox(t, { npmRc: 1 });
    const r = s.run(name, name === 'copilot' ? { COPILOT_VERSION: '1.0.92' } : { SDK_VERSION: '1.0.15' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(s.file('engine-status'), 'failed');
    assert.match(s.file('engine-notes'), /engine install failed/);
    assert.equal(s.file('findings.json'), null);
  });
  test(`contract: ${name} refuses a bad config (exit 1, ::error::) before doing anything`, (t) => {
    const s = sandbox(t);
    const r = s.run(name, { MODEL: '--yolo' });
    assert.equal(r.status, 1);
    assert.match(r.stdout, /^::error::/m);
    assert.equal(s.calls().length, 0);
  });
}

test('copilot-sdk adapter: installs the pinned SDK into $RUNNER_TEMP/sg-sdk without scripts, then runs from it (NODE_PATH)', (t) => {
  const s = sandbox(t);
  const r = s.run('copilot-sdk', { SDK_VERSION: '1.0.15', NODE_PATH: '' }); // the module exists only where the fake npm puts it
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const npm = s.log().split('\n').find((l) => l.startsWith('npm '));
  assert.match(npm, /^npm install --prefix \S+\/tmp\/sg-sdk --no-audit --no-fund --ignore-scripts @github\/copilot-sdk@1\.0\.15$/);
  assert.ok(isAnswer(s.file('findings.json')));
  assert.match(s.file('engine-notes'), /engine: sdk/);
});

test('copilot adapter: installs @github/copilot only when COPILOT_VERSION is set', (t) => {
  const s = sandbox(t);
  s.run('copilot');
  assert.ok(!s.log().includes('npm '));
  const s2 = sandbox(t);
  s2.run('copilot', { COPILOT_VERSION: '1.0.92' });
  assert.match(s2.log(), /^npm install -g @github\/copilot@1\.0\.92$/m);
});

test('auto tier: an empty model with a tier is `--model auto --auto-tier X` (the CLI rejects --auto-tier without an explicit auto model)', (t) => {
  const cases = [
    [{ MODEL: '' }, 'auto', 'intelligence'], // the default tier
    [{ MODEL: '', AUTO_TIER: 'balance' }, 'auto', 'balance'],
    [{ MODEL: 'auto', AUTO_TIER: 'efficiency' }, 'auto', 'efficiency'],
    [{ MODEL: '', AUTO_TIER: '' }, undefined, undefined], // tier explicitly off: the CLI default, no flags
    [{ MODEL: 'claude-opus-4.5', AUTO_TIER: 'balance' }, 'claude-opus-4.5', undefined], // a named model has no router profile
  ];
  for (const [env, model, tier] of cases) {
    const s = sandbox(t);
    assert.equal(s.run('copilot', env).status, 0);
    const [c] = s.calls();
    assert.equal(flag(c, '--model'), model, JSON.stringify(env));
    assert.equal(flag(c, '--auto-tier'), tier, JSON.stringify(env));
  }
});

test('auto tier: a CLI that rejects the tier is retried once without --auto-tier and without the implied --model auto, and says so', (t) => {
  // first call is rejected like the real CLI; the fake keys on the flag being present
  const s = sandbox(t);
  fs.writeFileSync(path.join(path.dirname(s.ctx), 'bin', 'copilot'), `#!/usr/bin/env bash
{ printf '%s\\n' "$@"; echo '---'; } >> "${fwd(path.join(path.dirname(s.ctx), 'argv.log'))}"
cat > /dev/null
for a in "$@"; do [ "$a" = --auto-tier ] && { echo 'error: Auto preference requires the selected model to be \`auto\`' >&2; exit 1; }; done
printf '%s' '${JSON.stringify(VALID)}'
`, { mode: 0o755 });
  const r = s.run('copilot');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const [first, second] = s.calls();
  assert.equal(flag(first, '--model'), 'auto');
  assert.equal(flag(first, '--auto-tier'), 'intelligence');
  assert.ok(!second.includes('--auto-tier') && !second.includes('--model'));
  assert.match(s.file('engine-notes'), /auto_tier ignored/);
  assert.ok(isAnswer(s.file('findings.json')));
});

// An adapter may normalise the object while validating it (the SDK's validator fills defaults in place): the answer is the same one.
function isAnswer(text) { const o = JSON.parse(text); return ['coverage', 'findings', 'requirements'].every((k) => Array.isArray(o[k]) && o[k].length === 0); }
