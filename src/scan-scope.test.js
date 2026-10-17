// scan_scope: all (README "Manual run"): the whole repository in one run. Collector (no caps), engine (runtime admission, dispatch deadline, split halves), configuration errors.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const api = require('./engines/claude-api.js');

const MODEL = 'claude-sonnet-5-5', cidOf = (i) => i.toString(16).padStart(8, '0');
const reply = (body) => ({ status: 200, ok: true, headers: { get: () => null }, text: async () => JSON.stringify(body) });
const LOW = { input_tokens: 1000, cache_creation_input_tokens: 20000, cache_read_input_tokens: 0, output_tokens: 4000 }, FAT = { input_tokens: 1000, output_tokens: 32000 };
const answer = (req, { usage = LOW, stop = 'end_turn' } = {}) => {
  const u = req.body.messages[0].content, unit = /name="audit-units\.txt"/.test(u), rows = [...u.matchAll(/^([0-9a-f]{8})\tdocs\/d\.md:1/gm)].map((m) => m[1]);
  const body = { docs_reviewed: ['docs/d.md'], requirements: unit ? [] : rows.map((c) => ({ id: c, text: 'x', source: { path: 'docs/d.md', line: 1, quote: 'quote of the block' }, class: 'unit', status: 'unknown', code: [], tests: [], note: '' })), not_requirements: [], unit_findings: [], not_reviewed: [] };
  return reply({ type: 'message', model: MODEL, stop_reason: stop, usage, content: [{ type: 'text', text: stop === 'max_tokens' ? '{"requirements": [' : JSON.stringify(body) }] });
};
const listed = (req) => new Set([...req.body.messages[0].content.matchAll(/^([0-9a-f]{8})\tdocs\/d\.md:1/gm)].map((m) => m[1])).size;
const isUnit = (req) => /name="audit-units\.txt"/.test(req.body.messages[0].content);
const worst = (c) => api.worstCase(MODEL, Buffer.byteLength(c.body.system?.[0]?.text || ''), Buffer.byteLength(c.body.messages[0].content), c.body.max_tokens).usd;

// n document blocks + 3 units (one unit call); every call goes to `reply(req)`
function scan(t, n, reply_, env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'specguard-scope-')), ctx = path.join(dir, 'ctx'), root = path.join(dir, 'repo'), calls = [];
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'lib'), { recursive: true }); fs.mkdirSync(ctx);
  for (const [f, c] of [['a', 'alpha'], ['b', 'beta'], ['c', 'gamma']]) fs.writeFileSync(path.join(root, 'lib', `${f}.js`), `function ${c}() {}\n`);
  fs.mkdirSync(path.join(root, 'test')); fs.writeFileSync(path.join(root, 'test', 'a.test.js'), 'test(1);\n');
  const cids = Array.from({ length: n }, (_, i) => cidOf(i + 1)), w = (f, c) => fs.writeFileSync(path.join(ctx, f), c);
  w('audit-candidates.txt', cids.map((c) => `${c}\tdocs/d.md:1\tH\ttext ${c}\n`).join(''));
  w('audit-evidence.txt', cids.map((c) => `${c}\tcode\tlib/a.js:1\tfunction alpha() {}\n`).join(''));
  w('audit-docs.txt', 'docs/d.md\tadmitted\n'); w('audit-meta.json', JSON.stringify({ max_requirements: 80, candidates: n, candidates_listed: n, units: { total: 3, picked: 3 }, max_units: 12 }));
  w('audit-units.txt', 'aaaaaaaa\tlib/a.js\t1\tw\tnone\t-\t-\t-\nbbbbbbbb\tlib/b.js\t1\tw\tnone\t-\t-\t-\ncccccccc\tlib/c.js\t1\tw\tnone\t-\t-\t-\n');
  const pf = path.join(dir, 'p.txt'); fs.writeFileSync(pf, 'STATIC\n\n---\n\nContext directory (absolute path): /ctx\nCTX\n');
  const file = (f) => { try { return fs.readFileSync(path.join(ctx, f), 'utf8').trim(); } catch { return null; } };
  const go = async (extra = {}) => {
    const log = console.log; console.log = () => {};
    try { await api.run({ CTX: ctx, PROMPT_FILE: pf, ANTHROPIC_API_KEY: 'sk-ant-test', MODEL, CHECK: 'audit', TIMEOUT: '12', MAX_OUTPUT_TOKENS: '32000', GITHUB_WORKSPACE: root, ...env, ...extra }, { fetchFn: async (u, init) => { const c = { body: JSON.parse(init.body) }; calls.push(c); return reply_(c, calls.length); }, sleep: async () => {} }); } finally { console.log = log; }
  };
  return { go, file, calls, cids, parts: () => JSON.parse(file('scan-parts.json')), dir, ctx, root };
}
const prices = async (t, n, env) => { const s = scan(t, n, (c) => answer(c), env); await s.go({ MAX_BUDGET_USD: '50' }); return s.calls.map(worst); };

test('all, low actual spend: the batches the worst-case plan cuts are admitted at run time; every part and block runs, nothing is reported not reached', async (t) => {
  const [unit, block] = await prices(t, 45, { SCAN_SCOPE: 'all' }), budget = String((unit + block * 1.2).toFixed(4));
  const sel = scan(t, 45, (c) => answer(c));
  await sel.go({ MAX_BUDGET_USD: budget }); // control: selected drops the trailing batches up front
  assert.ok(sel.calls.length < 4 && sel.parts().dropped.length > 0, 'selected is unchanged');
  const s = scan(t, 45, (c) => answer(c), { SCAN_SCOPE: 'all' });
  await s.go({ MAX_BUDGET_USD: budget });
  assert.equal(s.calls.length, 4);
  const p = s.parts();
  assert.deepEqual([p.scope, p.dropped, p.failed, p.notReached], ['all', [], [], { budget: { parts: 0, blocks: 0 }, deadline: { parts: 0, blocks: 0 } }]);
  assert.equal(JSON.parse(s.file('findings.json')).requirements.length, 45);
  assert.ok(JSON.parse(s.file('usage.json')).totalCostUsd <= Number(budget));
});

test('all, budget exhausted: the rest is not reached (budget), named in the ledger with a worst-case ceiling; spend stays within the budget', async (t) => {
  const [unit, block] = await prices(t, 45, { SCAN_SCOPE: 'all' }), budget = unit + block * 1.2;
  const rate = api.cost(MODEL, { input_tokens: 0, output_tokens: 1e6 }) / 1e6; // every call costs 97% of its worst case
  const s = scan(t, 45, (c) => answer(c, { usage: { input_tokens: 100, output_tokens: Math.floor((worst(c) * 0.97) / rate) } }), { SCAN_SCOPE: 'all' });
  await s.go({ MAX_BUDGET_USD: String(budget.toFixed(4)) });
  const p = s.parts();
  assert.ok(s.calls.length < 4);
  assert.ok(p.notReached.budget.blocks > 0 && p.notReached.deadline.blocks === 0 && p.dropped.length === p.notReached.budget.blocks, JSON.stringify(p));
  assert.ok(p.needUsd > budget, 'the ceiling is what everything would need');
  assert.ok(JSON.parse(s.file('usage.json')).totalCostUsd <= Number(budget.toFixed(4)));
  assert.match(s.file('engine-notes'), /left for the next run \(max_budget_usd\)/);
});

test('all, slow engine: no call starts once elapsed reaches the timeout minus the headroom (5 min, or twice the longest call); the rest is recorded with reason deadline and the run still succeeds', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1e12 });
  // 12 min limit: after call 1 (200 s) the threshold is 720 - max(300, 400) = 320 s -> call 2 starts; after call 2 (400 s) it is over -> stop
  const s = scan(t, 45, (c) => { t.mock.timers.tick(200000); return answer(c); }, { SCAN_SCOPE: 'all' });
  await s.go({ MAX_BUDGET_USD: '50' });
  assert.equal(s.calls.length, 2);
  const p = s.parts();
  assert.equal(p.failed.length, 2);
  assert.ok(p.failed.every((x) => /^deadline/.test(x.reason)), JSON.stringify(p.failed));
  assert.deepEqual(p.notReached, { budget: { parts: 0, blocks: 0 }, deadline: { parts: 0, blocks: 25 } });
  assert.equal(s.file('engine-status'), null, 'the engine succeeds: the post step still runs on what was reviewed');
  assert.equal(JSON.parse(s.file('findings.json')).requirements.length, 20);
});

test('all: the first call always runs, even when the limit is shorter than the headroom', async (t) => {
  const s = scan(t, 45, (c) => answer(c), { SCAN_SCOPE: 'all', TIMEOUT: '1' });
  await s.go({ MAX_BUDGET_USD: '50' });
  assert.equal(s.calls.length, 1);
  assert.ok(s.parts().failed.every((x) => /^deadline/.test(x.reason)));
});

test('all: an overflowing block part is split against the actual spend, not the worst case of everything still queued (selected refuses the same split)', async (t) => {
  const env = { SCAN_BATCH_BLOCKS: '2' }, [unit, block] = await prices(t, 4, env), budget = String((unit + 2 * block).toFixed(6)); // the plan fits exactly; the halves would not on top of it
  // the unit call costs 97% of its worst case and the first block call (which overflows) a tenth of the unit's: actual spend + the next half fits, the queue's worst case on top of the halves does not
  const rate = api.cost(MODEL, { input_tokens: 0, output_tokens: 1e6 }) / 1e6, small = { input_tokens: 100, output_tokens: 100 };
  const reply_ = (c) => (isUnit(c) ? answer(c, { usage: { input_tokens: 100, output_tokens: Math.floor((unit * 0.97) / rate) } }) : /text 00000001\b/.test(c.body.messages[0].content) && listed(c) === 2 ? answer(c, { usage: { input_tokens: 100, output_tokens: Math.floor((unit * 0.1) / rate) }, stop: 'max_tokens' }) : answer(c, { usage: small }));
  const s = scan(t, 4, reply_, { ...env, SCAN_SCOPE: 'all' });
  await s.go({ MAX_BUDGET_USD: budget });
  const p = s.parts();  assert.ok(p.splits >= 1 && p.failed.length === 0, JSON.stringify(p));
  assert.equal(JSON.parse(s.file('findings.json')).requirements.length, 4, 'every block answered');
  assert.ok(JSON.parse(s.file('usage.json')).totalCostUsd <= Number(budget));
  const ctl = scan(t, 4, reply_, env);
  await ctl.go({ MAX_BUDGET_USD: budget });
  assert.equal(ctl.parts().splits, undefined);
  assert.ok(ctl.parts().failed.some((x) => /not split: the halves would exceed/.test(x.reason)), JSON.stringify(ctl.parts()));
});

test('all: the engine run as a script executes the new path (an offline fetch stub is preloaded)', (t) => {
  const s = scan(t, 45, null), log = path.join(s.dir, 'calls.log'), stub = path.join(s.dir, 'stub.js');
  fs.writeFileSync(stub, `const fs = require('node:fs'); globalThis.fetch = async () => { fs.appendFileSync(${JSON.stringify(log)}, 'call,'); return { status: 200, ok: true, headers: { get: () => null }, text: async () => JSON.stringify({ type: 'message', model: ${JSON.stringify(MODEL)}, stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 10 }, content: [{ type: 'text', text: JSON.stringify({ docs_reviewed: [], requirements: [], not_requirements: [], unit_findings: [], not_reviewed: [] }) }] }) }; };`);
  const r = spawnSync(process.execPath, ['-r', stub, path.join(__dirname, 'engines', 'claude-api.js')], { encoding: 'utf8', cwd: s.dir, env: { ...process.env, CHECK: 'audit', CTX: s.ctx, PROMPT: 'p', ANTHROPIC_API_KEY: 'sk-ant-fake', MODEL, MAX_BUDGET_USD: '0.05', MAX_OUTPUT_TOKENS: '1000', SCAN_SCOPE: 'all', GITHUB_WORKSPACE: s.root } });
  assert.equal(s.file('engine-error'), null, r.stdout + r.stderr);
  assert.ok(fs.readFileSync(log, 'utf8').split(',').filter(Boolean).length >= 4, 'every part ran although the $0.05 worst-case plan fits one call');
  assert.equal(s.parts().scope, 'all');
});

// --- the collector and the configuration ---
function gitRepo(t, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'specguard-scope-repo-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const git = (...a) => execFileSync('git', ['-c', 'core.autocrlf=false', ...a], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  git('init'); git('config', 'user.name', 't'); git('config', 'user.email', 't@example.invalid');
  for (const [f, c] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true }); fs.writeFileSync(path.join(root, f), c); }
  git('add', '.'); git('commit', '-m', 'init');
  return { root, ctx: path.join(root, '.specguard-ctx') };
}
const collectCli = (root, ctx, env) => spawnSync(process.execPath, [path.join(__dirname, 'audit-collect.js')], { cwd: root, encoding: 'utf8', env: { ...process.env, CTX: ctx, GITHUB_REF_NAME: '', GITHUB_EVENT_PATH: '', ...env } });

test('collect CLI: all lifts the block cap and plans every unit (extra calls beyond the budgeted rooms); selected keeps both caps', (t) => {
  const doc = '# Design\n\n' + Array.from({ length: 40 }, (_, i) => `- Order ${i} must be validated before shipment number ${i} is created.\n`).join('');
  const files = { 'docs/design.md': doc }; for (let i = 0; i < 9; i++) files[`src/m${i}.js`] = `exports.f${i} = (a) => a + ${i};\nexports.g${i} = (a) => a * ${i};\nexports.h${i} = (a) => a - ${i};\n`;
  const { root, ctx } = gitRepo(t, files), base = { PACK_SPLIT: 'true', CONTEXT_PACK_BYTES: '250000', MAX_BUDGET_USD: '0.03', MODEL: 'claude-haiku-5-5', MAX_UNITS: '2', SCAN_MAX_BLOCKS: '5', SCAN_BATCH_BLOCKS: '10' };
  const meta = () => JSON.parse(fs.readFileSync(path.join(ctx, 'audit-meta.json'), 'utf8'));
  assert.equal(collectCli(root, ctx, base).status, 0);
  const sel = meta();  assert.ok(sel.candidates_listed <= 5 && sel.units.picked < 9 && sel.scan_scope === undefined, JSON.stringify(sel));
  const r = collectCli(root, ctx, { ...base, SCAN_SCOPE: 'all' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const all = meta();
  assert.equal(all.scan_scope, 'all');
  assert.equal(all.candidates_listed, all.candidates, 'every admitted block');
  assert.ok(all.candidates > 5);
  assert.equal(all.units.picked, 9, 'every unit');
  assert.ok(fs.existsSync(path.join(ctx, 'audit-unit-extra.json')), 'the calls beyond the worst-case plan are extras');
});

test('collect CLI and validate-inputs.sh: scan_scope all with an engine that does not split scans is a configuration error; a bad value too', (t) => {
  const { root, ctx } = gitRepo(t, { 'src/a.js': 'exports.a = 1;\n' });
  const bad = collectCli(root, ctx, { SCAN_SCOPE: 'all', PACK_SPLIT: 'false' });
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /::error::scan_scope: all needs the claude engine in api mode/);
  assert.match(collectCli(root, ctx, { SCAN_SCOPE: 'everything', PACK_SPLIT: 'true' }).stdout, /::error::scan_scope must be selected or all/);
  assert.equal(collectCli(root, ctx, { SCAN_SCOPE: 'selected', PACK_SPLIT: 'false' }).status, 0);
  const bash = process.platform === 'win32' ? path.join(process.env.ProgramFiles, 'Git/bin/bash.exe') : 'bash', sh = path.join(__dirname, 'validate-inputs.sh').replace(/\\/g, '/');
  const v = (env) => spawnSync(bash, [sh], { encoding: 'utf8', env: { ...process.env, ENGINE: 'claude', CLAUDE_MODE: 'api', MODE: 'scan', ...env } });
  assert.equal(v({ SCAN_SCOPE: 'all' }).status, 0);
  assert.equal(v({ SCAN_SCOPE: 'selected', ENGINE: 'copilot' }).status, 0);
  for (const env of [{ ENGINE: 'copilot' }, { CLAUDE_MODE: 'agent' }, { MODE: 'pr' }]) { const r = v({ SCAN_SCOPE: 'all', ...env }); assert.equal(r.status, 1, JSON.stringify(env)); assert.match(r.stdout, /::error::scan_scope: all needs/); }
  assert.match(v({ SCAN_SCOPE: 'x' }).stdout, /::error::scan_scope must be selected or all/);
});

test('action.yml and the workflows: scan_scope reaches the collector, the validation and the engine; the reusable workflow forwards it', () => {
  const yml = fs.readFileSync(path.join(__dirname, '..', 'action.yml'), 'utf8').replace(/\r\n/g, '\n'), reuse = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'specguard.yml'), 'utf8').replace(/\r\n/g, '\n');
  assert.match(/^ {2}scan_scope: \{[^}]*\}/m.exec(yml)[0], /default: "selected" \}$/);
  assert.equal(yml.split('SCAN_SCOPE: ${{ inputs.scan_scope }}').length - 1, 3, 'collector, validation, engine');
  assert.match(reuse, /\n {6}scan_scope: \{[^\n]*default: selected \}/);
  assert.match(reuse, /\n {10}scan_scope: \$\{\{ inputs\.scan_scope \}\}\n/);
});
