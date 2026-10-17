// Read-only review probes. Load pinned sources using a verified remote tree;
// never check out, commit, call a provider, or write to the repository's Git data.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const cp = require('node:child_process');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const ROOT = path.resolve(__dirname, '../..');
const MAIN = '8415eae217a5c4eed3c1d46ccf9294b127fc97d2';
const DENY_PR = '84475bad28af4f452f70ab4bbc779851cc36c094';
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, 'latest-source-manifest-2026-10-17.json'), 'utf8'));
assert.equal(manifest.commit, MAIN); assert.equal(manifest.truncated, false);
function source(sha, file) {
  if (sha !== MAIN) return cp.execFileSync('git', ['show', `${sha}:${file}`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 8 << 20 });
  const blob = manifest.files[file]; assert(blob, 'No remote tree entry: ' + file);
  const text = manifest.text_blobs?.[blob] ?? cp.execFileSync('git', ['cat-file', 'blob', blob], { cwd: ROOT, encoding: 'utf8', maxBuffer: 8 << 20 });
  assert.equal(crypto.createHash('sha1').update(`blob ${Buffer.byteLength(text)}\0`).update(text).digest('hex'), blob, 'Source blob hash mismatch: ' + file);
  return text;
}
const temps = [];
const temp = () => { const p = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-unknown-')); temps.push(p); return p; };
function loader(sha, overrides = {}) {
  const cache = new Map();
  const load = (file) => {
    if (Object.hasOwn(overrides, file)) return overrides[file];
    if (cache.has(file)) return cache.get(file).exports;
    const code = source(sha, file);
    const m = { exports: {} }; cache.set(file, m);
    if (file.endsWith('.json')) { m.exports = JSON.parse(code); return m.exports; }
    const req = (s) => {
      if (Object.hasOwn(overrides, s)) return overrides[s];
      if (s === 'node:fs' || s === 'fs') return { ...fs, readFileSync(file, options) {
        const rel = typeof file === 'string' ? path.relative(ROOT, file).replace(/\\/g, '/') : '';
        if (sha === MAIN && /^(?:src\/[^/]+\.schema\.json|skills\/(?:spec-audit|test-review)\/)/.test(rel) && manifest.files[rel]) {
          const text = source(sha, rel), encoding = typeof options === 'string' ? options : options?.encoding;
          return encoding ? text : Buffer.from(text);
        }
        return fs.readFileSync(file, options);
      } };
      if (!s.startsWith('.')) return require(s);
      let p = path.posix.normalize(path.posix.join(path.posix.dirname(file), s));
      if (!/\.(?:js|cjs|json)$/.test(p)) p += '.js';
      return load(p);
    };
    req.main = null;
    const filename = path.join(ROOT, ...file.split('/'));
    new Function('require', 'module', 'exports', '__dirname', '__filename', code.replace(/^#![^\n]*\n/, ''))(req, m, m.exports, path.dirname(filename), filename);
    return m.exports;
  };
  return load;
}
const results = [];
function record(id, observed, control, scope) { results.push({ id, observed, control, scope }); }
async function main() {
  const load = loader(MAIN), post = load('src/post.js'), weekly = load('eval/weekly-report.js');
  const a = 'a'.repeat(40), b = 'b'.repeat(40);
  const cmp = { status: 'ahead', total_commits: 1, commits: [{ sha: b, parents: [{ sha: a }] }] };
  const git = (files) => weekly.apiGit(cmp, b, () => files);
  const patched = [{ filename: 'app.js', status: 'modified', patch: '@@ -7 +7 @@\n-old();\n+newer();' }];
  const missing = post.anchorTouched(a, b, 'app.js', 7, 7, null, git([{ filename: 'app.js', status: 'modified', changes: 90000 }]));
  const touched = post.anchorTouched(a, b, 'app.js', 7, 7, null, git(patched));
  assert.equal(missing, false); assert.equal(touched, true);
  record('U1-missing-api-patch', { anchor_touched: missing, wanted: null }, { complete_patch_touched: touched }, 'real weekly adapter + real post helpers, synthetic GitHub commit objects');

  const renamed = post.testsChanged(a, b, null, git([{ filename: 'app.js', previous_filename: 'app.test.js', status: 'renamed' }]));
  const namedTest = post.testsChanged(a, b, null, git([{ filename: 'app.test.js', status: 'modified' }]));
  assert.equal(renamed, false); assert.equal(namedTest, true);
  record('U2-renamed-test', { tests_changed: renamed, wanted: true }, { modified_test_detected: namedTest }, 'GitHub rename object; post git command uses --no-renames and would include both paths');

  const white = post.anchorTouched(a, b, 'app.js', 7, 7, null, git([{ filename: 'app.js', status: 'modified', patch: '@@ -7 +7 @@\n-return value;\n+return  value;' }]));
  const whiteDir = temp(), left = path.join(whiteDir, 'before.js'), right = path.join(whiteDir, 'after.js');
  fs.writeFileSync(left, 'return value;\n'); fs.writeFileSync(right, 'return  value;\n');
  const ignoredWhite = cp.spawnSync('git', ['diff', '--no-index', '-w', '-U0', '--', left, right], { encoding: 'utf8' });
  assert.equal(white, true); assert.equal(ignoredWhite.stdout, ''); assert.equal(ignoredWhite.status, 0);
  record('U3-whitespace-adapter', { anchor_touched: white, wanted: false }, { non_whitespace_touched: touched, real_git_ignore_whitespace_exit: ignoredWhite.status, real_git_patch: ignoredWhite.stdout }, 'real apiGit ignores -w; independent real git diff -w control, no Git repository created');

  const grade = load('eval/grade.js').grade;
  const clean = { id: 'synthetic-clean', expected: { findings: [], expect_clean: true } };
  const row = '| O1: Boundary A | PR body; a.js:10 — return boundary(value); | none | Missing test: No test |\n';
  const specData = { requirements: [], requirements_source: 'none', not_reviewed: '', coverage: [{ id: 'O1', obligation: 'Boundary A', source: 'from behaviour', behaviour: { path: 'a.js', line: 10, quote: 'return boundary(value);' }, change: { path: 'a.js', line: 10, quote: 'return boundary(value);' }, evidence: [], status: 'missing_test', reason: 'No test', alignment: { status: 'not_applicable', reason: 'No explicit requirement' } }], findings: [], standards: { status: 'no_rules', sources: [], reason: 'None' }, layering: { status: 'checked', reason: 'None' } };
  const f = { kind: 'missing_test', path: 'a.js', line: 10, title: 'Boundary A', body: 'Missing assertion', confidence: 'low', obligation_ids: ['O1'] };
  const built = post.buildSummary({ cov: { reports: 0 }, data: { ...specData, findings: [f] }, items: [{ f, why: 'low confidence' }], notes: [], blob: 'https://github.com/example/repo/blob/abc/' });
  const obs = (summary) => ({ comments: [], reviews: [], summary });
  const alone = grade(clean, obs('## SpecGuard\n\n' + row)), hidden = grade(clean, obs(built));
  assert.equal(alone.fp, 1); assert.equal(hidden.fp, 0); assert.equal(hidden.clean_ok, true);
  record('U4-low-item-hides-coverage-fp', { fp: hidden.fp, clean_ok: hidden.clean_ok, pass: hidden.pass }, { row_without_low_item_fp: alone.fp, row_without_low_item_clean_ok: alone.clean_ok }, 'real buildSummary -> real grade, identical missing_test coverage claim');

  const sentinel = 'SYNTHETIC_NOT_A_REAL_SECRET_U5';
  const deniedPath = '.env.production.md';
  const doc = `# Runtime requirements\n\nThe deployment MUST retain ${sentinel}.\nThe service MUST reject missing configuration.\n`;
  const app = 'module.exports = 2;\n';
  const docSha = 'c'.repeat(40), appSha = 'd'.repeat(40);
  const patch = 'diff --git a/app.js b/app.js\n--- a/app.js\n+++ b/app.js\n@@ -1 +1 @@\n-module.exports = 1;\n+module.exports = 2;\n';
  const fakeCp = { ...cp, execFileSync(command, args, opts = {}) {
    assert.equal(command, 'git');
    if (args[0] === 'ls-tree') return `100644 blob ${docSha} ${Buffer.byteLength(doc)}\t${deniedPath}\0` + `100644 blob ${appSha} ${Buffer.byteLength(app)}\tapp.js\0`;
    if (args[0] === 'cat-file') return Buffer.concat(String(opts.input).trim().split('\n').filter(Boolean).map(s => {
      const body = s === docSha || s.endsWith(':' + deniedPath) ? doc : s === appSha || s.endsWith(':app.js') ? app : null;
      return body === null ? Buffer.from(s + ' missing\n') : Buffer.from(`${s.includes(':') ? docSha : s} blob ${Buffer.byteLength(body)}\n${body}\n`);
    }));
    if (args[0] === 'diff') return args.includes('--name-status') ? 'M\0app.js\0' : patch;
    throw new Error('unexpected fixture git: ' + args.join(' '));
  } };
  const trace = loader(MAIN, { 'node:child_process': fakeCp })('src/trace.js');
  const prLoad = load, engine = prLoad('src/engines/claude-api.js');
  assert.equal(engine.DENY.test(deniedPath), true);
  const traceOnce = (reqPaths) => {
    const ctx = temp(); fs.writeFileSync(path.join(ctx, 'requirements-status.json'), JSON.stringify({ documents: [], criteria: [] }));
    fs.writeFileSync(path.join(ctx, 'files.txt'), 'app.js\n'); fs.writeFileSync(path.join(ctx, 'diff.patch'), patch);
    fs.writeFileSync(path.join(ctx, 'denied.txt'), deniedPath + '\n');
    trace.run({ cwd: ROOT, base: a, head: b, ctx, reqPaths });
    const prompt = prLoad('src/prompt.js').assemble({ skillDir: path.join(ROOT, 'skills/test-review'), ctxDir: ctx, schemaPath: path.join(ROOT, 'src/findings.schema.json') });
    return { prompt_contains_sentinel: prompt.includes(sentinel), index_contains_sentinel: fs.readFileSync(path.join(ctx, 'requirements-index.md'), 'utf8').includes(sentinel), spec_files: fs.readFileSync(path.join(ctx, 'spec-files.txt'), 'utf8').trim() };
  };
  const leaking = traceOnce(deniedPath), excluded = traceOnce('!' + deniedPath);
  assert.equal(leaking.prompt_contains_sentinel, true); assert.equal(excluded.prompt_contains_sentinel, false);
  record('U5-denied-doc-trace-path', leaking, excluded, 'latest main trace.run -> prompt.assemble with fake Git objects; not full collect.sh e2e; synthetic marker only');

  const quotaCtx = temp();
  fs.writeFileSync(path.join(quotaCtx, 'audit-candidates.txt'), '1234abcd\tREADME.md:1\tA\tSynthetic background A.\n5678dcba\tREADME.md:2\tB\tSynthetic background B.\n');
  fs.writeFileSync(path.join(quotaCtx, 'audit-meta.json'), JSON.stringify({ head: b, candidates: 2, candidates_listed: 2, limitations: [] }));
  fs.writeFileSync(path.join(quotaCtx, 'audit-docs.txt'), 'README.md\n');
  const api = load('src/engines/claude-api.js');
  let calls = 0;
  await api.run({ CTX: quotaCtx, ANTHROPIC_API_KEY: 'synthetic-key-not-real', MODEL: 'claude-haiku-5-5', PROMPT: 'Synthetic review', CHECK: 'audit', SCAN_BATCH_BLOCKS: '1', CONTEXT_PACK_BYTES: '0', MAX_OUTPUT_TOKENS: '100', MAX_BUDGET_USD: '10', GITHUB_WORKSPACE: ROOT }, { fetchFn: async () => {
    calls++;
    const status = calls === 1 ? 200 : 402;
    const obj = status === 200 ? { stop_reason: 'end_turn', model: 'claude-haiku-5-5', usage: { input_tokens: 10, output_tokens: 10 }, content: [{ type: 'text', text: '{"unit_findings":[],"docs_reviewed":["README.md"],"requirements":[],"not_requirements":[{"cid":"1234abcd","reason":"Synthetic background only"}],"not_reviewed":[]}' }] } : { error: { type: 'billing_error', message: 'Synthetic account has no credit balance' } };
    return { status, ok: status === 200, headers: { get: () => null }, text: async () => JSON.stringify(obj) };
  }, sleep: async () => {} });
  const parts = JSON.parse(fs.readFileSync(path.join(quotaCtx, 'scan-parts.json'), 'utf8'));
  const engineErrorPresent = fs.existsSync(path.join(quotaCtx, 'engine-error'));
  const previousEnv = { ...process.env }, outputs = {}, warnings = [];
  try {
    Object.assign(process.env, { CTX: quotaCtx, GITHUB_WORKSPACE: ROOT, SCAN_ISSUE: 'false', ENGINE: 'claude', MODEL: 'claude-haiku-5-5' });
    const summary = { addRaw() { return this; }, async write() {} };
    await load('src/audit-post.js')({ github: {}, context: { repo: { owner: 'synthetic', repo: 'fixture' }, sha: b }, core: { setOutput: (k, v) => { outputs[k] = v; }, warning: s => warnings.push(s), summary } });
  } finally {
    for (const k of Object.keys(process.env)) if (!Object.hasOwn(previousEnv, k)) delete process.env[k];
    Object.assign(process.env, previousEnv);
  }
  assert.equal(outputs.status, 'incomplete', JSON.stringify({ outputs, warnings }));
  const gateScript = path.join(quotaCtx, 'gate.cjs'); fs.writeFileSync(gateScript, source(MAIN, 'src/fail-on-error.js'));
  const gate = cp.spawnSync(process.execPath, [gateScript], { encoding: 'utf8', env: { ...process.env, CTX: quotaCtx, STATUS: outputs.status, FAIL_ON_ERROR: 'false' } });
  const strictGate = cp.spawnSync(process.execPath, [gateScript], { encoding: 'utf8', env: { ...process.env, CTX: quotaCtx, STATUS: outputs.status, FAIL_ON_ERROR: 'true' } });
  const fullFailureCtx = temp(); fs.writeFileSync(path.join(fullFailureCtx, 'engine-error'), 'quota\nSynthetic account out of credit\n');
  const fullFailure = cp.spawnSync(process.execPath, [gateScript], { encoding: 'utf8', env: { ...process.env, CTX: fullFailureCtx, STATUS: 'failed', FAIL_ON_ERROR: 'false' } });
  assert.equal(calls, 2); assert.equal(parts.failed.length, 1); assert.equal(engineErrorPresent, false); assert.equal(gate.status, 0); assert.equal(strictGate.status, 0); assert.equal(fullFailure.status, 1);
  record('U6-partial-config-failure', { calls, part_failed: parts.failed, engine_error_present: engineErrorPresent, scan_status: outputs.status, gate_exit: gate.status, fail_on_error_true_exit: strictGate.status }, { first_part_output_preserved: fs.existsSync(path.join(quotaCtx, 'findings.json')), failed_quota_gate_exit: fullFailure.status }, 'real scan-parts planner -> API adapter -> audit-post -> config gate; synthetic fetch responses; no provider/network calls');
  console.log(JSON.stringify({ main_sha: MAIN, pr223_sha: DENY_PR, network_calls: 0, real_secrets_used: false, results }, null, 2));
}
main().catch(e => { console.error(e.stack); process.exitCode = 1; }).finally(() => {
  for (const p of temps) if (path.dirname(p) === os.tmpdir() && path.basename(p).startsWith('sg-unknown-')) fs.rmSync(p, { recursive: true, force: true });
});
