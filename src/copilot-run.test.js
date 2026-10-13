const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const bash = process.platform === 'win32' ? path.join(process.env.ProgramFiles, 'Git/bin/bash.exe') : 'bash';
const VALID = JSON.stringify({ coverage: [], findings: [], requirements: [] });
const INVALID = JSON.stringify({ findings: [] }); // coverage must be an array

// A fake `copilot` on PATH: call N reads its prompt from stdin into N.stdin, prints N.out and N.err, exits with N.rc, records its argv, and writes a usage file when asked.
// Optional 5th element per turn: { events: [objects appended to COPILOT_HOME/session-state/<sid>/events.jsonl], usage: object for the usage file, reject: stderr text when --auto-tier is passed (exit 1) }.
function setup(t, turns, env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'specguard-copilot-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'bin'), ctx = path.join(dir, 'ctx'), fake = path.join(dir, 'fake');
  for (const d of [bin, ctx, fake]) fs.mkdirSync(d);
  const home = path.join(dir, 'home');
  turns.forEach(([out, rc = 0, err = '', sleep = 0, x = {}], i) => { if (x.events) fs.writeFileSync(path.join(fake, `${i + 1}.events`), x.events.map((e) => (typeof e === 'string' ? e : JSON.stringify(e))).join('\n') + '\n'); if (x.usage) fs.writeFileSync(path.join(fake, `${i + 1}.usage`), JSON.stringify(x.usage)); if (x.reject) fs.writeFileSync(path.join(fake, `${i + 1}.reject`), x.reject); fs.writeFileSync(path.join(fake, `${i + 1}.sleep`), String(sleep)); fs.writeFileSync(path.join(fake, `${i + 1}.out`), out); fs.writeFileSync(path.join(fake, `${i + 1}.err`), err); fs.writeFileSync(path.join(fake, `${i + 1}.rc`), String(rc)); });
  fs.writeFileSync(path.join(bin, 'copilot'), `#!/usr/bin/env bash
F="${fake.replace(/\\/g, '/')}"
if [ "$1" = --version ]; then cat "$F/version" 2>/dev/null || echo "GitHub Copilot CLI 1.0.92."; exit 0; fi
n=$(( $(cat "$F/count" 2>/dev/null || echo 0) + 1 )); echo $n > "$F/count"
{ printf '%s\\n' "$@"; echo '---'; } >> "$F/argv.log"
cat > "$F/$n.stdin"
echo "\${GH_TOKEN-unset}" >> "$F/gh.log"
sleep "$(cat "$F/$n.sleep")"
if [ -f "$F/$n.reject" ]; then for a in "$@"; do [ "$a" = --auto-tier ] && { cat "$F/$n.reject" >&2; exit 1; }; done; fi
prev=''; for a in "$@"; do
  [ "$prev" = --usage-output-file ] && { if [ -f "$F/$n.usage" ]; then cp "$F/$n.usage" "$a"; else echo '{"totalNanoAiu":1000000000}' > "$a"; fi; }
  [ "$prev" = --session-id ] && sid=$a
  prev=$a
done
if [ -f "$F/$n.events" ] && [ -n "$COPILOT_HOME" ]; then mkdir -p "$COPILOT_HOME/session-state/$sid"; cat "$F/$n.events" >> "$COPILOT_HOME/session-state/$sid/events.jsonl"; fi
cat "$F/$n.out" 2>/dev/null; cat "$F/$n.err" >&2 2>/dev/null; exit $(cat "$F/$n.rc" 2>/dev/null || echo 0)
`, { mode: 0o755 });
  const run = (extra = {}, args = []) => spawnSync(bash, [path.join(__dirname, 'engines', 'copilot.sh'), ...args], {
    encoding: 'utf8', env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH, CTX: ctx, COPILOT_HOME: home, PROMPT: 'REVIEW PROMPT', MODEL: '', EFFORT: '', MAX_CREDITS: '200', TIMEOUT: '5', ...env, ...extra },
  });
  const calls = () => (fs.existsSync(path.join(fake, 'argv.log')) ? fs.readFileSync(path.join(fake, 'argv.log'), 'utf8').split('---\n').filter(Boolean).map((c) => c.split('\n').filter(Boolean)) : []);
  const ctxFile = (n) => { try { return fs.readFileSync(path.join(ctx, n), 'utf8').trim(); } catch { return null; } };
  const ghLog = () => fs.readFileSync(path.join(fake, 'gh.log'), 'utf8').split('\n').filter(Boolean);
  const stdin = (n) => fs.readFileSync(path.join(fake, `${n}.stdin`), 'utf8'); // the prompt of call n (1-based) as copilot received it
  const ctxJson = (n) => { try { return JSON.parse(ctxFile(n)); } catch { return null; } };
  return { run, calls, ctxFile, ctxJson, ctx, ghLog, stdin, dir };
}
const flag = (c, f) => c[c.indexOf(f) + 1];
const ev = (chosen, extra = {}) => ({ type: 'session.auto_mode_resolved', data: { chosenModel: chosen, candidateModels: [chosen], availableModels: [chosen], routingMethod: 'auto_v2', fallback: false, categoryScores: { reasoning: 0.2 }, ...extra } });

test('a valid first answer: one call, no repair, safety flags and credit cap kept', (t) => {
  const s = setup(t, [[`Here:\n${VALID}`]]);
  const r = s.run();
  assert.equal(r.status, 0, r.stderr);
  const [c, ...more] = s.calls();
  assert.equal(more.length, 0);
  assert.equal(s.stdin(1), 'REVIEW PROMPT'); // the prompt arrives on stdin, never as an argument
  assert.ok(!c.includes('-p') && !c.includes('REVIEW PROMPT'));
  for (const f of ['--available-tools', '--allow-all-tools', '--no-ask-user', '-s', '--session-id', '--usage-output-file', '--max-ai-credits']) assert.ok(c.includes(f), f);
  for (const f of ['--allow-all', '--allow-all-paths', '--yolo', '--reasoning-effort']) assert.ok(!c.includes(f), f);
  assert.equal(flag(c, '--model'), 'auto'); // an empty model with the default tier is explicit auto: the CLI rejects --auto-tier otherwise
  assert.equal(flag(c, '--auto-tier'), 'intelligence');
  assert.equal(flag(c, '--available-tools'), 'view,glob,grep');
  assert.equal(flag(c, '--max-ai-credits'), '200');
  assert.match(flag(c, '--session-id'), /^[0-9a-f-]{36}$/);
  assert.equal(s.ctxFile('engine-repair'), null);
  assert.equal(s.ctxFile('findings.json'), VALID);
});

test('a prompt far over the single-argument limit (300 KB, multibyte, quotes) reaches every turn intact on stdin: main, auto-tier retry and model fallback', (t) => {
  const prompt = 'x"y\'z $HOME `id` é\n'.repeat(15000); // ~300 KB
  assert.ok(Buffer.byteLength(prompt) > 200 * 1024);
  const cases = [[[['', 1, "error: unknown option '--auto-tier'"], [VALID]], {}, 2], [[['', 1, 'Error: Model "gpt-9" from --model flag is not available.'], [VALID]], { MODEL: 'gpt-9' }, 2], [[[VALID]], {}, 1]];
  for (const [turns, env, n] of cases) {
    const s = setup(t, turns);
    const file = path.join(s.dir, 'big-prompt.txt');
    fs.writeFileSync(file, prompt);
    const r = s.run({ ...env, PROMPT: '', PROMPT_FILE: file.replace(/\\/g, '/') });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(s.calls().length, n);
    for (let i = 1; i <= n; i++) assert.ok(s.stdin(i) === prompt, `call ${i}`);
    assert.equal(s.ctxFile('findings.json'), VALID);
  }
});

test('PROMPT_FILE unset: PROMPT is written to $CTX/prompt.txt and piped', (t) => {
  const s = setup(t, [[VALID]]);
  assert.equal(s.run({ PROMPT: 'multi\nline "prompt"' }).status, 0);
  assert.equal(s.stdin(1), 'multi\nline "prompt"');
  assert.equal(s.ctxFile('prompt.txt'), 'multi\nline "prompt"');
});

test('prose without JSON: one repair turn on the same session quotes the error, and a valid answer is repaired', (t) => {
  const s = setup(t, [['I looked at everything and found nothing wrong.'], [VALID]]);
  const r = s.run();
  assert.equal(r.status, 0, r.stderr);
  const [a, b, ...more] = s.calls();
  assert.equal(more.length, 0);
  assert.equal(flag(b, '--session-id'), flag(a, '--session-id'));
  assert.equal(s.stdin(1), 'REVIEW PROMPT');
  assert.match(s.stdin(2), /no JSON found in Copilot output/);
  assert.match(s.stdin(2), /ONLY the complete corrected JSON/);
  assert.ok(!b.includes('-p'));
  assert.equal(flag(b, '--usage-output-file').replace(/\\/g, '/').split('/').pop(), 'usage-repair.json');
  assert.equal(flag(a, '--usage-output-file').replace(/\\/g, '/').split('/').pop(), 'usage.json');
  assert.equal(s.ctxFile('engine-repair'), 'repaired');
  assert.equal(s.ctxFile('findings.json'), VALID);
  assert.ok(s.ctxFile('usage.json') && s.ctxFile('usage-repair.json'));
});

test('invalid twice: repair_failed after exactly two calls; the validator error is quoted', (t) => {
  const s = setup(t, [[INVALID], [INVALID]]);
  assert.equal(s.run().status, 0);
  const calls = s.calls();
  assert.equal(calls.length, 2);
  assert.match(s.stdin(2), /output failed validation: coverage must be an array/);
  assert.equal(s.ctxFile('engine-repair'), 'repair_failed');
});

test('a failed or timed-out first turn is not repaired', (t) => {
  const s = setup(t, [['', 1, 'boom']]);
  assert.equal(s.run().status, 0);
  assert.equal(s.calls().length, 1);
  assert.equal(s.ctxFile('engine-status'), 'failed');
  assert.equal(s.ctxFile('engine-repair'), null);
  assert.equal(s.ctxFile('engine-notes'), 'usage partial'); // the usage file the turn wrote is kept, its total is not trusted
  assert.ok(s.ctxFile('usage.json'));
});

test('a job-level GH_TOKEN never reaches the Copilot CLI (token precedence: COPILOT_GITHUB_TOKEN > GH_TOKEN > GITHUB_TOKEN)', (t) => {
  const s = setup(t, [['prose'], [VALID]]);
  assert.equal(s.run({ GH_TOKEN: 'job-token', COPILOT_GITHUB_TOKEN: 'copilot-pat' }).status, 0);
  assert.deepEqual(s.ghLog(), ['unset', 'unset']);
});

test('a repair turn is not started with under 60 s of budget left; the notes say so', (t) => {
  const s = setup(t, [['prose', 0, '', 2]]);
  const r = s.run({ TIMEOUT: '1', MAX_CREDITS: '' }); // 58 s left after a 2 s turn
  assert.equal(r.status, 0, r.stderr);
  assert.equal(s.calls().length, 1);
  assert.equal(flag(s.calls()[0], '--max-ai-credits'), '60'); // the default cap
  assert.equal(s.ctxFile('engine-notes'), 'repair_skipped: no time');
  assert.equal(s.ctxFile('engine-repair'), null);
});

test('a failed repair turn notes usage partial next to the other notes', (t) => {
  const s = setup(t, [['prose'], ['', 1, 'boom']]);
  assert.equal(s.run({ EFFORT: 'high', MODEL: 'claude-opus-4.5' }).status, 0);
  assert.equal(s.ctxFile('engine-notes'), 'effort: high\nusage partial');
  assert.equal(s.ctxFile('engine-status'), 'failed');
});

test('model not available: one rerun on --model auto without an effort flag, noted', (t) => {
  const s = setup(t, [['', 1, 'Error: Model "gpt-9" from --model flag is not available.'], [VALID]]);
  const r = s.run({ MODEL: 'gpt-9', EFFORT: 'high' });
  assert.equal(r.status, 0, r.stderr);
  const [a, b, ...more] = s.calls();
  assert.equal(more.length, 0);
  assert.equal(flag(a, '--model'), 'gpt-9');
  assert.equal(flag(a, '--reasoning-effort'), 'high');
  assert.equal(flag(b, '--model'), 'auto');
  assert.ok(!b.includes('--reasoning-effort'));
  assert.equal(s.ctxFile('engine-notes'), 'model_fallback: gpt-9 → auto');
  assert.equal(s.ctxFile('engine-status'), null);
  assert.equal(s.ctxFile('findings.json'), VALID);
});

test('effort with auto or no model is not passed and is noted; with an explicit model it is passed', (t) => {
  for (const MODEL of ['', 'auto']) {
    const s = setup(t, [[VALID]]);
    assert.equal(s.run({ MODEL, EFFORT: 'high' }).status, 0);
    const [c] = s.calls();
    assert.ok(!c.includes('--reasoning-effort'));
    assert.equal(flag(c, '--model'), 'auto');
    assert.equal(s.ctxFile('engine-notes'), 'effort ignored: model auto');
  }
  const s = setup(t, [[VALID]]);
  s.run({ MODEL: 'claude-opus-4.5', EFFORT: 'xhigh' });
  assert.equal(flag(s.calls()[0], '--reasoning-effort'), 'xhigh');
  assert.equal(s.ctxFile('engine-notes'), 'effort: xhigh');
});

test('--auto-tier goes only with an empty or auto model; default intelligence, other values and empty are honoured', (t) => {
  for (const [env, want] of [[{ MODEL: '' }, 'intelligence'], [{ MODEL: 'auto' }, 'intelligence'], [{ MODEL: 'auto', AUTO_TIER: 'efficiency' }, 'efficiency'], [{ AUTO_TIER: 'balance' }, 'balance'], [{ MODEL: 'claude-opus-4.5' }, undefined], [{ MODEL: 'auto', AUTO_TIER: '' }, undefined]]) {
    const s = setup(t, [[VALID]]);
    assert.equal(s.run(env).status, 0);
    const [c] = s.calls();
    assert.equal(c.includes('--auto-tier') ? flag(c, '--auto-tier') : undefined, want, JSON.stringify(env));
  }
});

test('--auto-tier rejected by the CLI: that turn is retried once without it and the notes say so; later turns omit it', (t) => {
  for (const reject of ["error: unknown option '--auto-tier'", 'Error: Auto preference requires dynamic Auto tiers; choose an available preference']) {
    const s = setup(t, [['', 1, '', 0, { reject }], ['prose'], [VALID]]);
    const r = s.run();
    assert.equal(r.status, 0, r.stderr);
    const [a, b, c, ...more] = s.calls();
    assert.equal(more.length, 0);
    assert.ok(a.includes('--auto-tier'));
    assert.ok(!b.includes('--auto-tier') && !c.includes('--auto-tier'));
    assert.equal(flag(b, '--session-id'), flag(a, '--session-id'));
    assert.equal(s.ctxFile('engine-notes'), 'auto_tier ignored');
    assert.equal(s.ctxFile('engine-status'), null);
    assert.equal(s.ctxFile('engine-repair'), 'repaired');
  }
});

test('an unrelated failure with --auto-tier is not retried', (t) => {
  const s = setup(t, [['', 1, 'boom']]);
  assert.equal(s.run().status, 0);
  assert.equal(s.calls().length, 1);
  assert.equal(s.ctxFile('engine-status'), 'failed');
});

test('model fallback to auto passes --auto-tier on the rerun', (t) => {
  const s = setup(t, [['', 1, 'Error: Model "gpt-9" from --model flag is not available.'], [VALID]]);
  assert.equal(s.run({ MODEL: 'gpt-9' }).status, 0);
  const [a, b] = s.calls();
  assert.ok(!a.includes('--auto-tier'));
  assert.equal(flag(b, '--auto-tier'), 'intelligence');
});

test('engine-model.json: each turn reads its own events from the session; the repair turn may run on another model', (t) => {
  const s = setup(t, [['prose', 0, '', 0, { events: [ev('gpt-6-luna')] }], [VALID, 0, '', 0, { events: [ev('mai-code-1.1-flash', { routingMethod: 'auto_v3' })] }]]);
  assert.equal(s.run({ FAST_MODELS: '' }).status, 0);
  const m = s.ctxJson('engine-model.json');
  assert.equal(m.requested, '');
  assert.deepEqual(m.turns.map((x) => [x.turn, x.chosen]), [['main', 'gpt-6-luna'], ['repair', 'mai-code-1.1-flash']]);
  assert.equal(m.turns[1].routing, 'auto_v3');
  assert.deepEqual(m.used, ['gpt-6-luna', 'mai-code-1.1-flash']);
  assert.equal(m.tier, 'fast'); // any fast turn makes the run fast
});

test('engine-model.json: the fallback turn is labelled, fast_models extends the table, no event falls back to usage.json', (t) => {
  const s = setup(t, [['', 1, 'Error: Model "gpt-9" from --model flag is not available.'], [VALID, 0, '', 0, { usage: { currentModel: 'gpt-6-luna', modelMetrics: { 'gpt-6-luna': {} } } }]]);
  assert.equal(s.run({ MODEL: 'gpt-9', FAST_MODELS: '/^gpt-6/' }).status, 0);
  const m = s.ctxJson('engine-model.json');
  assert.equal(m.requested, 'gpt-9');
  assert.deepEqual(m.turns.map((x) => [x.turn, x.chosen, x.source]), [['fallback', 'gpt-6-luna', 'usage']]);
  assert.equal(m.tier, 'fast');
});

test('engine-model.json: garbage events and no usage names never fail the step', (t) => {
  const s = setup(t, [[VALID, 0, '', 0, { events: ['not json', '{"type":"session.auto_mode_resolved","data":', '{"type":"session.auto_mode_resolved","data":{"chosenModel":5}}'] }]]);
  const r = s.run({ MODEL: 'claude-opus-4.5' });
  assert.equal(r.status, 0, r.stderr);
  const m = s.ctxJson('engine-model.json');
  assert.deepEqual(m.turns, []);
  assert.deepEqual(m.used, ['claude-opus-4.5']); // explicit model: known without the router
  assert.equal(m.tier, 'normal');
});

test('bad model, effort, credits or timeout values fail the step before copilot runs', (t) => {
  const bad = [{ MODEL: '--allow-all' }, { MODEL: '-x' }, { MODEL: 'a b' }, { MODEL: 'a'.repeat(65) }, { MODEL: 'x;rm' }, { EFFORT: 'turbo' }, { MAX_CREDITS: '29' }, { MAX_CREDITS: '2001' }, { MAX_CREDITS: '1e3' }, { MAX_CREDITS: '-50' }, { MAX_CREDITS: 'abc' }, { TIMEOUT: '0' }, { TIMEOUT: 'x' }, { AUTO_TIER: 'turbo' }, { AUTO_TIER: '--yolo' }, { FAST_MODELS: 'x'.repeat(501) }];
  for (const env of bad) {
    const s = setup(t, [[VALID]]);
    const r = s.run(env);
    assert.equal(r.status, 1, JSON.stringify(env));
    assert.match(r.stdout, /^::error::/m, JSON.stringify(env));
    assert.equal(s.calls().length, 0);
  }
  for (const env of [{ MODEL: 'auto' }, { MODEL: 'claude-opus-4.5' }, { MODEL: 'opus[1m]' }, { MODEL: 'a:b_c-1.2' }, { MODEL: 'a'.repeat(64) }, { EFFORT: 'max' }, { AUTO_TIER: '' }, { AUTO_TIER: 'efficiency' }, { FAST_MODELS: '/flash/i\nfoo,bar' }, { MAX_CREDITS: '30' }, { MAX_CREDITS: '2000' }]) {
    const s = setup(t, [[VALID]]);
    assert.equal(s.run(env).status, 0, JSON.stringify(env));
  }
});

test('validate-inputs.sh alone (the engine step) rejects the same values', (t) => {
  const v = (env) => spawnSync(bash, [path.join(__dirname, 'validate-inputs.sh')], { encoding: 'utf8', env: { ...process.env, MODEL: '', EFFORT: '', MAX_CREDITS: '200', ...env } }).status;
  assert.equal(v({}), 0);
  assert.equal(v({ MODEL: '--yolo' }), 1);
  assert.equal(v({ MAX_CREDITS: '5' }), 1);
  assert.equal(v({ EFFORT: 'turbo' }), 1);
  assert.equal(v({ AUTO_TIER: 'turbo' }), 1);
  assert.equal(v({ AUTO_TIER: 'balance' }), 0);
  for (const TIMEOUT of ['0', '00', 'x', '-5', '12345', '1.5']) assert.equal(v({ TIMEOUT }), 1, TIMEOUT); // the engine step checks them with the same script
  for (const TIMEOUT of ['1', '12', '9999']) assert.equal(v({ TIMEOUT }), 0, TIMEOUT);
});

test('action.yml wires the new inputs, runs the Copilot script, and never uses an allow-all flag', () => {
  const y = fs.readFileSync(path.join(__dirname, '..', 'action.yml'), 'utf8').replace(/\r\n/g, '\n');
  for (const m of [/^ {2}effort: \{[^}]*default: ""/m, /^ {2}copilot_max_ai_credits: \{[^}]*default: "60"/m, /^ {2}ctx_retention_days: \{[^}]*default: "1"/m, /TIMEOUT: \$\{\{ inputs\.review_timeout_minutes \}\}\n {6}run: \|\n {8}bash "\$GITHUB_ACTION_PATH\/src\/validate-inputs\.sh"/, /^ {2}engine: \{[^}]*default: copilot/m, /ENGINE: \$\{\{ inputs\.engine \}\}/, /COPILOT_VERSION: \$\{\{ inputs\.copilot_version \}\}/, /ENGINE: \$\{\{ steps\.engine\.outputs\.engine \}\}/, /PROMPT_FILE="\$PROMPT_FILE" bash "\$GITHUB_ACTION_PATH\/src\/engines\/\$ENGINE\.sh"/,/EFFORT: \$\{\{ inputs\.effort \}\}/, /^ {2}auto_tier: \{[^}]*default: intelligence/m, /^ {2}fast_models: \{[^}]*default: ""/m, /AUTO_TIER: \$\{\{ inputs\.auto_tier \}\}/, /FAST_MODELS: \$\{\{ inputs\.fast_models \}\}/, /MAX_CREDITS: \$\{\{ inputs\.copilot_max_ai_credits \}\}/, /src\/validate-inputs\.sh/]) assert.match(y, m);
  assert.doesNotMatch(y + ['copilot.sh'].map((n) => fs.readFileSync(path.join(__dirname, 'engines', n), 'utf8').replace(/^#.*$/gm, '')).join(''), /--allow-all\b(?!-tools)|--allow-all-paths|--yolo/);
});

test('a stub copilot (prints "Cannot find GitHub Copilot CLI", exit 0): failed before any turn, first line in the notes', (t) => {
  const s = setup(t, [[VALID]]);
  fs.writeFileSync(path.join(path.dirname(s.ctx), 'fake', 'version'), 'Cannot find GitHub Copilot CLI (https://docs.github.com/copilot/x)\nmore\n');
  const r = s.run();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(s.calls().length, 0);
  assert.equal(s.ctxFile('engine-status'), 'failed');
  assert.match(s.ctxFile('engine-notes'), /^Copilot CLI not found or not runnable \(Cannot find GitHub Copilot CLI \(https:\/\/docs\.github\.com\/copilot\/x\)\)$/);
});

test('a real-looking version passes the check; a turn that prints the stub message is failed, not repaired', (t) => {
  const s = setup(t, [['Cannot find GitHub Copilot CLI (https://docs.github.com/x)\n']]);
  fs.writeFileSync(path.join(path.dirname(s.ctx), 'fake', 'version'), 'GitHub Copilot CLI 1.0.92.\nRun copilot update\n');
  assert.equal(s.run().status, 0);
  assert.equal(s.calls().length, 1); // no repair turn
  assert.equal(s.ctxFile('engine-status'), 'failed');
  assert.equal(s.ctxFile('engine-repair'), null);
});
