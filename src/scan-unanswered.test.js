// scan_scope all, end to end with a mocked fetch: collector CLI -> prompt -> claude-api engine -> audit-post -> fail-on-error gate. Never calls the network.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');
const api = require('./engines/claude-api.js');
const post = require('./audit-post.js');
const { assembleAudit } = require('./prompt.js');

const SRC = 'exports.total = function total(items) {\n  let sum = 0;\n  for (const item of items) {\n    sum += item.price * item.quantity;\n  }\n  return sum;\n};\n';
const BIG = '/*' + 'padding '.repeat(70000) + '*/\n' + SRC; // over the 512 KiB inventory cap
const DOC = (i) => `# Guide ${i}\n\nThe system MUST add item prices.\n`;
const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

async function scan(t, files, { uf = 'empty', batch = '100' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-unans-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const repo = path.join(dir, 'repo'), ctx = path.join(dir, 'ctx'); fs.mkdirSync(repo); fs.mkdirSync(ctx);
  git(repo, 'init', '-q'); git(repo, 'config', 'user.name', 'A'); git(repo, 'config', 'user.email', 'a@example.invalid');
  for (const [f, c] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(repo, f)), { recursive: true }); fs.writeFileSync(path.join(repo, f), c); }
  git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'fixture');
  const out = path.join(dir, 'gho'); fs.writeFileSync(out, '');
  const env = { ...process.env, CTX: ctx, GITHUB_WORKSPACE: repo, GITHUB_OUTPUT: out, SCAN_SCOPE: 'all', MAX_UNITS: '12', MODEL: 'claude-haiku-5-5', MAX_BUDGET_USD: '20', MAX_OUTPUT_TOKENS: '32000', CONTEXT_PACK_BYTES: '', SCAN_BATCH_BLOCKS: batch, PACK_SPLIT: 'true', AUDIT_BRANCH_GUARD: 'off', REQ_PATHS: 'docs/*.md', FAIL_ON_ERROR: 'true', TIMEOUT: '12' };
  const col = spawnSync(process.execPath, [path.join(__dirname, 'audit-collect.js')], { cwd: repo, env, encoding: 'utf8' });
  assert.equal(col.status, 0, col.stderr + col.stdout);
  const skip = /skip=true/.test(fs.readFileSync(out, 'utf8'));
  if (!skip) {
    const cands = fs.readFileSync(path.join(ctx, 'audit-candidates.txt'), 'utf8').split('\n').filter(Boolean).map((l) => l.split('\t'));
    const prompt = assembleAudit({ skillDir: path.join(__dirname, '../skills/spec-audit'), ctxDir: ctx, schemaPath: path.join(__dirname, 'audit.schema.json') });
    const fetchFn = async (url, init) => {
      const text = init.body, sent = cands.filter((c) => text.includes(c[0]));
      const found = { requirements: [], not_requirements: sent.map((c) => ({ cid: c[0], reason: 'Introductory prose.' })), docs_reviewed: [...new Set(sent.map((c) => c[1].replace(/:\d+$/, '')))], not_reviewed: [] };
      if (uf === 'empty') found.unit_findings = []; else if (uf === 'null') found.unit_findings = null; else if (uf === 'bad-row') found.unit_findings = [null];
      return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ model: 'claude-haiku-5-5', usage: { input_tokens: 100, output_tokens: 100 }, stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(found) }] }) };
    };
    await api.run({ ...env, PROMPT: prompt, ANTHROPIC_API_KEY: 'sk-ant-fixture', CHECK: 'audit' }, { fetchFn, sleep: async () => {} });
  }
  let summary = '', issue = ''; const outputs = {};
  const core = { setOutput: (k, v) => { outputs[k] = v; }, warning() {}, info() {}, summary: { addRaw(s) { summary = s; return this; }, async write() {} } };
  const github = { paginate: async () => [], rest: { issues: { listForRepo() {}, async create(o) { issue = o.body; return { data: { number: 1 } }; }, async update(o) { issue = o.body; return {}; } }, users: { async getAuthenticated() { throw new Error('job token'); } } } };
  const saved = { ...process.env }; Object.assign(process.env, { CTX: ctx, GITHUB_WORKSPACE: repo, SCAN_ISSUE: 'true', SCAN_SCOPE: 'all', ENGINE: 'claude', SKIP: String(skip), ISSUE_REPO: '', SCAN_PATHS: '' });
  try { await post({ core, github, context: { repo: { owner: 'f', repo: 'r' }, serverUrl: 'https://github.com' } }); } finally { for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]; Object.assign(process.env, saved); }
  const gate = spawnSync(process.execPath, [path.join(__dirname, 'fail-on-error.js')], { env: { ...process.env, CTX: ctx, STATUS: outputs.status, REASON: outputs.reason || '', FAIL_ON_ERROR: 'true' }, encoding: 'utf8' }).status;
  let state = []; try { state = post.readState(issue).blocks.map((b) => b.status); } catch { /* no issue state in a skipped run */ }
  return { status: outputs.status, gate, state, headline: summary.split('\n').find((x) => x.startsWith('**')) || '', skip };
}

// no usable answer for a unit (unit_findings missing, null, a bad row) is never "covered", never green, and fails the strict gate; a valid [] is a real "no gap"
for (const [shape, docs, batch] of [['a: one call holds the blocks and the unit', 1, '100'], ['b: unit-only call split from the block calls', 2, '1']]) {
  test(`unit_findings matrix (${shape})`, async (t) => {
    const files = { 'src/total.js': SRC, ...Object.fromEntries(Array.from({ length: docs }, (_, i) => [`docs/g${i}.md`, DOC(i)])) };
    for (const uf of ['missing', 'null', 'bad-row']) {
      const r = await scan(t, files, { uf, batch });
      assert.equal(r.status, 'incomplete', uf); assert.equal(r.gate, 1, uf); assert.ok(!r.state.includes('covered'), `${uf}: ${r.state}`);
      assert.match(r.headline, batch === "1" ? /could not review any unit: the unit call failed/ : /Incomplete scan.*1 unit not reviewed/, uf);
    }
    const ok = await scan(t, files, { uf: 'empty', batch });
    assert.equal(ok.status, 'complete'); assert.equal(ok.gate, 0); assert.ok(ok.state.includes('covered')); assert.doesNotMatch(ok.headline, /Incomplete/);
  });
}

// eligibility under scan_scope all + fail_on_error: red only when eligible source went unreviewed
test('oversize and eligibility matrix', async (t) => {
  const rows = [
    ['1 oversized only', { 'src/a.js': BIG }, 'incomplete', 1],
    ['2 oversized', { 'src/a.js': BIG, 'src/b.js': BIG }, 'incomplete', 1],
    ['1 normal + 1 oversized', { 'src/a.js': SRC, 'src/b.js': BIG }, 'incomplete', 1],
    ['only unsupported language (.lua)', { 'src/a.lua': 'function f() return 1 end\n' }, 'complete', 0],
    ['no source at all', { 'README.md': '# hi\n' }, 'complete', 0],
    ['docs-only repo', { 'docs/g.md': DOC(0) }, 'complete', 0],
  ];
  for (const [name, files, status, gate] of rows) {
    const r = await scan(t, files);
    assert.equal(r.status, status, name); assert.equal(r.gate, gate, name);
    if (name === '1 normal + 1 oversized') assert.ok(r.state.includes('covered'), 'the normal unit was reviewed');
  }
});
