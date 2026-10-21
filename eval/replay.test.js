const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { prepareReal, finishReal, finishRealOne, countFindings, table } = require('./replay.js');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'specguard-replay-test-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();

function mkRepo() {
  const d = path.join(tmp, 'src-repo');
  fs.mkdirSync(path.join(d, 'src'), { recursive: true });
  git(d, 'init', '-q');
  for (const [k, v] of [['user.name', 't'], ['user.email', 't@example.invalid'], ['commit.gpgsign', 'false']]) git(d, 'config', k, v);
  fs.writeFileSync(path.join(d, 'src', 'a.js'), 'exports.limit = (n) => n > 3;\n');
  git(d, 'add', '-A'); git(d, 'commit', '-q', '-m', 'base');
  const base = git(d, 'rev-parse', 'HEAD');
  fs.writeFileSync(path.join(d, 'src', 'a.js'), 'exports.limit = (n) => n > 5;\n');
  git(d, 'add', '-A'); git(d, 'commit', '-q', '-m', 'head');
  return { d, base, head: git(d, 'rev-parse', 'HEAD') };
}

test('prepareReal clones at head, runs collect.sh, writes prompt.md and meta.json', () => {
  const { d, base, head } = mkRepo();
  const m = prepareReal({ repoDir: d, base, head, prTitle: 'Raise limit', prBody: 'limit is 5', out: path.join(tmp, 'out'), id: 'r1' });
  assert.ok(m.collect_ok, fs.readFileSync(path.join(tmp, 'out', 'r1', 'collect.log'), 'utf8'));
  assert.strictEqual(m.head, head);
  assert.strictEqual(m.files, 1);
  assert.ok(fs.readFileSync(path.join(tmp, 'out', 'r1', 'prompt.md'), 'utf8').includes('Context directory'));
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(tmp, 'out', 'r1', 'meta.json'), 'utf8')).pr_title, 'Raise limit');
  assert.ok(fs.existsSync(path.join(tmp, 'out', 'r1', 'repo', 'src', 'a.js')));
});

test('countFindings splits inline by kind/confidence, summary-only and pre-existing', () => {
  const c = (kind, conf) => ({ path: 'a.js', line: 1, body: `**T**\n\nkind: ${kind}, confidence: ${conf}` });
  const summary = '## S\n\n### Unit test gaps (2)\n\n- ❌ **Missing test:** x `a.js:1` (low confidence) — body\n- ❌ **Weak test:** y `a.js:2` — body\n\n<details><summary>Details: x</summary>\n\n**Pre-existing drift (not caused by this PR)**\n\n- **Mismatch:** z `a.js:3` — body\n\n**Sources read**\n\n- x\n\n</details>\n';
  const r = countFindings([c('missing_test', 'high'), c('missing_test', 'low'), c('spec_mismatch', 'high')], summary);
  assert.deepStrictEqual(r.inline, { total: 3, byKind: { missing_test: 2, spec_mismatch: 1 }, byConfidence: { high: 2, low: 1 } });
  assert.strictEqual(r.summary_only, 2);
  assert.strictEqual(r.pre_existing, 1);
  assert.deepStrictEqual(countFindings([], ''), { inline: { total: 0, byKind: {}, byConfidence: { high: 0, low: 0 } }, summary_only: 0, pre_existing: 0 });
});

test('countFindings reads the summary src/post.js really builds: summary-only items and pre-existing drift are not silently 0', () => {
  const { buildSummary } = require('../src/post.js');
  const f = (kind, title, extra = {}) => ({ kind, path: 'src/a.js', line: 3, title, body: `${title} body. More text.`, confidence: 'high', obligation_ids: ['O1'], ...extra });
  const data = { requirements: [], findings: [], requirements_source: 'none', not_reviewed: '', coverage: [], standards: { status: 'checked', sources: ['R.md'], reason: 'ok' }, layering: { status: 'checked', reason: 'ok' } };
  const summary = buildSummary({
    data, specFiles: [], blob: 'https://github.com/o/r/blob/abc',
    posted: [{ f: f('missing_test', 'POSTED'), url: 'https://github.com/o/r/pull/1#discussion_r1' }],
    items: [{ f: f('weak_test', 'SUM1', { confidence: 'low' }), why: 'low confidence' }, { f: f('weak_test', 'SUM2'), why: 'not in a diff hunk' }, { f: f('pushdown', 'SUM3'), why: 'over max_comments' }, { f: f('standard', 'SUM4'), why: 'not in a diff hunk' }],
    pre: [{ ...f('spec_mismatch', 'DRIFT1') }, { ...f('spec_mismatch', 'DRIFT2') }],
  });
  assert.match(summary, /\*\*Pre-existing drift \(not caused by this PR\)\*\*/); // the layout this parser depends on
  assert.match(summary, /^- \*\*Weak test:\*\* SUM1 .*`src\/a\.js:3`.* \(low confidence\) — /m);
  const r = countFindings([], summary);
  assert.strictEqual(r.summary_only, 4, summary);
  assert.strictEqual(r.pre_existing, 2, summary);
  assert.notStrictEqual(countFindings([], '## SpecGuard\n\nnothing\n').summary_only, 4);
});

test('table prints a row per PR with kind columns and no pass/fail', () => {
  const t = table([{ id: 'a', trace: 'auto', inline: { total: 1, byKind: { bug: 1 }, byConfidence: { high: 1, low: 0 } }, summary_only: 2, pre_existing: 0 }, { id: 'b', error: 'boom' }]);
  assert.match(t, /bug/); assert.match(t, /ERROR/); assert.doesNotMatch(t, /PASS|FAIL/);
});

test('finishReal runs post.run on findings.json and writes posted.json and summary.md', async () => {
  const { d, base, head } = mkRepo();
  const out = path.join(tmp, 'out2');
  prepareReal({ repoDir: d, base, head, out, id: 'r2' });
  const f = { requirements_source: 'none', not_reviewed: '', standards: { status: 'no_rules', sources: [], reason: 'none' }, layering: { status: 'checked', reason: 'x' },
    requirements: [], coverage: [{ id: 'O1', obligation: 'limit is 5', source: 'PR body', behaviour: { path: 'src/a.js', line: 1, quote: 'exports.limit = (n) => n > 5;' }, change: { path: 'src/a.js', line: 1, quote: 'exports.limit = (n) => n > 5;', side: 'RIGHT' }, evidence: [], status: 'missing_test', reason: 'no test', alignment: { status: 'aligned', since: 'introduced', reason: 'ok' } }], findings: [{ kind: 'missing_test', path: 'src/a.js', line: 1, quote: 'exports.limit = (n) => n > 5;', side: 'RIGHT', title: 'No test', body: 'The limit change has no test.', confidence: "high", obligation_ids: ['O1'] }] };
  fs.writeFileSync(path.join(out, 'r2', 'ctx', 'findings.json'), JSON.stringify(f));
  const logs = [];
  const rows = await finishReal({ ids: ['r2', 'nope'], out, log: (s) => logs.push(s) });
  assert.strictEqual(rows[0].findings_present, true);
  assert.strictEqual(rows[0].inline.total + rows[0].summary_only, 1);
  assert.ok(rows[1].error);
  assert.ok(fs.existsSync(path.join(out, 'r2', 'posted.json')) && fs.existsSync(path.join(out, 'r2', 'summary.md')));
  assert.strictEqual((await finishRealOne('r2', out)).id, 'r2');
  assert.match(logs[0], /r2/);
});

test('prepareReal shared:true checks out head and borrows objects via alternates', () => {
  const { d, base, head } = mkRepo();
  const out = path.join(tmp, 'out-shared');
  const m = prepareReal({ repoDir: d, base, head, out, id: 's1', shared: true });
  const repo = path.join(out, 's1', 'repo');
  assert.ok(m.collect_ok);
  assert.strictEqual(git(repo, 'rev-parse', 'HEAD'), head);
  assert.ok(fs.readFileSync(path.join(repo, '.git', 'objects', 'info', 'alternates'), 'utf8').includes('src-repo'));
});

test('runReal: injected engine -> result.json with status, cost and counts; entries/sample read the holdout manifests', async () => {
  const { runReal, entries, sample } = require('./replay.js');
  const { d, base, head } = mkRepo();
  const engine = ({ ctx, model }) => { fs.writeFileSync(path.join(ctx, 'engine-status'), 'failed\n'); fs.writeFileSync(path.join(ctx, 'usage.json'), JSON.stringify({ totalCostUsd: 0.07, currentModel: model })); return 0; };
  const r = await runReal({ entry: { id: 'rr1', repo: 'o/r', number: 5, base, head, title: 'Raise limit', body: 'limit is 5' }, repoDir: d, out: path.join(tmp, 'out-run'), engine });
  assert.strictEqual(r.engine_status, 'failed');
  assert.strictEqual(r.usage.cost_usd, 0.07);
  assert.strictEqual(r.counts.inline, 0);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(tmp, 'out-run', 'rr1', 'result.json'), 'utf8')).id, 'rr1');
  const bugs = entries(path.join(__dirname, 'replay', 'holdout-pairs.json'));
  assert.strictEqual(bugs.length, 12);
  assert.ok(bugs.every((e) => e.base && e.head && e.title));
  assert.strictEqual(entries(path.join(__dirname, 'replay', 'holdout-clean.json')).length, 12);
  assert.deepStrictEqual(sample([1, 2, 3, 4, 5], 3, 7), sample([1, 2, 3, 4, 5], 3, 7));
});

const LINE = 'exports.limit = (n) => n > 5;';
const findings = () => ({ requirements_source: 'none', not_reviewed: '', standards: { status: 'no_rules', sources: [], reason: 'none' }, layering: { status: 'checked', reason: 'x' }, requirements: [],
  coverage: [['O1', 'limit is 5', 1, LINE], ['O2', 'limit is 5 (2)', 1, LINE]].map(([id, obligation, line, quote]) => ({ id, obligation, source: 'PR body', behaviour: { path: 'src/a.js', line, quote }, change: { path: 'src/a.js', line, quote, side: 'RIGHT' }, evidence: [], status: 'missing_test', reason: 'no test', alignment: { status: 'aligned', since: 'introduced', reason: 'ok' } })),
  findings: [{ kind: 'missing_test', path: 'src/a.js', line: 1, quote: LINE, side: 'RIGHT', title: 'No test', body: 'The limit change has no test.', confidence: 'high', obligation_ids: ['O1'] },
    { kind: 'missing_test', path: 'src/a.js', line: 1, quote: LINE, side: 'RIGHT', title: 'Low gap', body: 'Maybe no test.', confidence: 'low', obligation_ids: ['O2'] }] });
// an injected engine: writes what claude-api.js writes (findings.json, engine-notes; engine-status only when not success) and returns the exit code
const fake = ({ exit = 0, status, notes = ['context pack: 1 files, 0 KB'], find = true } = {}) => ({ ctx }) => {
  if (find) fs.writeFileSync(path.join(ctx, 'findings.json'), JSON.stringify(findings()));
  if (status) fs.writeFileSync(path.join(ctx, 'engine-status'), status + '\n');
  if (notes) fs.writeFileSync(path.join(ctx, 'engine-notes'), notes.join('\n') + '\n');
  return exit;
};
const replay = (id, engine) => { const { runReal } = require('./replay.js'); const { d, base, head } = mkRepo(); return runReal({ entry: { id, repo: 'o/r', number: 5, base, head, title: 't', body: 'limit is 5' }, repoDir: d, out: path.join(tmp, 'out-valid'), engine }); };

test('runReal hands the engine the prepared checkout as its pack root', async () => {
  let seen;
  await replay('rg1', ({ repo }) => { seen = repo; return 0; });
  assert.ok(fs.existsSync(path.join(seen, 'src', 'a.js')), 'engine root must contain the repo files');
});

test('runReal: a normal success is valid and its findings are exact (inline and summary-only)', async () => {
  const r = await replay('v-ok', fake());
  assert.deepStrictEqual([r.valid, r.invalid_reason, r.engine_exit, r.findings_present], [true, null, 0, true]);
  assert.deepStrictEqual(r.findings.map(({ where, kind, path: p, line, title }) => ({ where, kind, path: p, line, title })), [
    { where: 'inline', kind: 'missing_test', path: 'src/a.js', line: 1, title: 'No test' },
    { where: 'summary', kind: 'missing_test', path: 'src/a.js', line: 1, title: 'Low gap' }]);
  assert.deepStrictEqual(r.counts, { inline: 1, summary_only: 1, pre_existing: 0 });
});

test('runReal fault injection: every way the run is not a measurement is invalid, with result.json still written', async () => {
  for (const [id, engine, reason] of [
    ['v-exit1', fake({ exit: 1, find: false }), /engine exit 1/],
    ['v-failed', fake({ status: 'failed' }), /engine status failed/],
    ['v-nofind', fake({ find: false }), /no findings\.json/],
    ['v-zero', fake({ notes: ['context pack: 0 files, 0 KB; not included: a.js'] }), /context pack is empty/],
    ['v-nonote', fake({ notes: null }), /no context pack note/],
    ['v-noexit', () => {}, /engine exit undefined/]]) {
    const r = await replay(id, engine);
    assert.strictEqual(r.valid, false, id); assert.match(r.invalid_reason, reason, id);
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(tmp, 'out-valid', id, 'result.json'), 'utf8')).valid, false);
  }
});

test('runReal: findings.json={} (post.js rejects the shape) is invalid with the publisher reason; revalidate recomputes it from result.json + summary.md, also for an old result without publisher_status', async () => {
  const { revalidate } = require('./replay.js');
  const r = await replay('v-shape', ({ ctx }) => { fs.writeFileSync(path.join(ctx, 'findings.json'), '{}'); fs.writeFileSync(path.join(ctx, 'engine-notes'), 'context pack: 1 files, 0 KB\n'); return 0; });
  assert.deepStrictEqual([r.valid, r.publisher_status, r.publisher_reason], [false, 'failed', 'findings.json failed validation: coverage must be an array']);
  assert.match(r.invalid_reason, /^publisher: findings\.json failed validation/);
  const dir = path.join(tmp, 'out-valid', 'v-shape'), old = JSON.parse(fs.readFileSync(path.join(dir, 'result.json'), 'utf8'));
  assert.match(revalidate(dir), /^publisher: findings\.json failed validation/);
  delete old.publisher_status; delete old.publisher_reason; old.valid = true; old.invalid_reason = null;
  fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(old));
  assert.match(revalidate(dir), /^publisher: findings\.json failed validation/, 'old result: status read from the summary marker');
  assert.strictEqual(revalidate(path.join(tmp, 'out-valid', 'v-ok')), null);
});

test('invalid: publisher failed is invalid; incomplete (a reduced review) stays a valid measurement', () => {
  const { invalid } = require('./replay.js');
  const ok = { collect_ok: true, skip: false, engine_exit: 0, engine_status: 'success', findings_present: true, files: 0, engine_notes: [] };
  assert.strictEqual(invalid({ ...ok, publisher_status: 'incomplete' }), null);
  assert.strictEqual(invalid({ ...ok, publisher_status: 'complete' }), null);
  assert.strictEqual(invalid({ ...ok, publisher_status: 'failed', publisher_reason: 'x' }), 'publisher: x');
});

test('invalid: no pack note is fine when the PR changed no files', () => {
  const { invalid } = require('./replay.js');
  const ok = { collect_ok: true, skip: false, engine_exit: 0, engine_status: 'success', findings_present: true, files: 1, engine_notes: ['context pack: 8 files, 1 KB'] };
  assert.strictEqual(invalid(ok), null);
  assert.strictEqual(invalid({ ...ok, files: 0, engine_notes: [] }), null);
  assert.match(invalid({ ...ok, skip: true }), /skipped/);
});

test('batch: real claude-api.js with mocked HTTP: cap, resume, reps, total cap, retryable stop on a dead key', async () => {
  const { batch } = require('./replay.js'), api = require('../src/engines/claude-api.js');
  const { d } = mkRepo(), repos = path.join(tmp, 'b-repos');
  fs.mkdirSync(repos, { recursive: true }); fs.cpSync(d, path.join(repos, 'r'), { recursive: true });
  const { base, head } = { base: git(d, 'rev-parse', 'HEAD~1'), head: git(d, 'rev-parse', 'HEAD') };
  const ids = ['b1', 'b2', 'b3', 'b4'], man = path.join(tmp, 'b-man.json');
  fs.writeFileSync(man, JSON.stringify({ clean: ids.map((id) => ({ id, repo: 'o/r', number: 5, base, head, pr_title: 't', pr_body: 'limit is 5' })) }));
  const dirs = ids.map((id) => { const x = path.join(tmp, 'b-dl', `replay-${id}`); fs.mkdirSync(x, { recursive: true }); fs.writeFileSync(path.join(x, 'result.json'), JSON.stringify({ id, repo: 'o/r' })); return x; });
  let calls = [], bad = null;
  const fetchFn = async (url, init) => {
    const body = JSON.parse(init.body); calls.push({ key: init.headers['x-api-key'], model: body.model });
    if (bad) return { status: 401, ok: false, headers: { get: () => null }, text: async () => JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'bad key' } }) };
    return { status: 200, ok: true, headers: { get: () => null }, text: async () => JSON.stringify({ type: 'message', model: body.model, stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(findings()) }], usage: { input_tokens: 1000, output_tokens: 100 } }) };
  };
  const engine = async ({ dir, ctx, repo, model, budget }) => { const log = console.log; console.log = () => {};
    try { await api.run({ GITHUB_WORKSPACE: repo, CTX: ctx, PROMPT_FILE: path.join(dir, 'prompt.md'), ANTHROPIC_API_KEY: 'sk-ant-offline-mock', MODEL: model, MAX_BUDGET_USD: budget, MAX_OUTPUT_TOKENS: '32000', TIMEOUT: '12' }, { fetchFn, sleep: async () => {} }); } finally { console.log = log; }
    return 0; };
  const run = (o) => batch({ dirs: dirs.slice(0, 2), manifests: [man], repos, budget: '0.5', maxTotal: 100, engine, log: () => {}, ...o });
  const out = path.join(tmp, 'b-out');
  let r = await run({ out, cap: 1 });                                   // 1. cap
  assert.deepStrictEqual([r.ran, r.skipped, r.stopped, calls.length], [1, 0, null, 1]);
  assert.deepStrictEqual(calls[0], { key: 'sk-ant-offline-mock', model: 'claude-haiku-5-5' });
  const first = JSON.parse(fs.readFileSync(path.join(out, 'rep1', 'b1', 'result.json'), 'utf8'));
  assert.ok(first.valid, first.invalid_reason); assert.ok(first.usage.cost_usd > 0); assert.ok(!fs.existsSync(path.join(out, 'rep1', 'b2')));
  assert.ok(!fs.existsSync(path.join(out, 'rep1', 'b1', 'repo')) && fs.existsSync(path.join(out, 'rep1', 'b1', 'summary.md'))); // the checkout is dropped, the evidence kept
  r = await run({ out, cap: 5 });                                       // 2. resume
  assert.deepStrictEqual([r.ran, r.skipped, r.stopped, calls.length], [1, 1, null, 2]);
  assert.ok(fs.existsSync(path.join(out, 'rep1', 'b2', 'result.json')));
  assert.ok(Math.abs(r.spent - 2 * first.usage.cost_usd) < 1e-9);       // spent counts every result.json under out
  const logs = [], out2 = path.join(tmp, 'b-out2'); calls = [];        // reps=2, rep-major, separate dirs
  r = await run({ out: out2, cap: 9, reps: 2, log: (s) => logs.push(s) });
  assert.strictEqual(r.ran, 4); assert.deepStrictEqual(logs.map((s) => /^(\w+ rep\d)/.exec(s)[1]), ['b1 rep1', 'b2 rep1', 'b1 rep2', 'b2 rep2']);
  assert.ok(['rep1', 'rep2'].every((k) => ['b1', 'b2'].every((i) => fs.existsSync(path.join(out2, k, i, 'result.json')))));
  const out3 = path.join(tmp, 'b-out3'); calls = [];                    // max-total: the 2nd run could pass the cap
  r = await run({ out: out3, cap: 9, maxTotal: 0.5 + first.usage.cost_usd / 2 });
  assert.deepStrictEqual([r.ran, r.stopped, calls.length], [1, 'budget', 1]);
  const out4 = path.join(tmp, 'b-out4'); calls = []; bad = true;        // 3. dead key: invalid + retryable, stop, later ids not run
  r = await run({ out: out4, cap: 9 });
  assert.deepStrictEqual([r.ran, r.stopped, calls.length], [1, 'b1', 1]);
  const dead = JSON.parse(fs.readFileSync(path.join(out4, 'rep1', 'b1', 'result.json'), 'utf8'));
  assert.deepStrictEqual([dead.valid, dead.retryable], [false, true]);
  assert.ok(!fs.existsSync(path.join(out4, 'rep1', 'b2')));
  dead.usage.cost_usd = 0.25; fs.writeFileSync(path.join(out4, 'rep1', 'b1', 'result.json'), JSON.stringify(dead)); bad = false; calls = []; // 4. resume with a good key: the retryable id reruns, its attempt is kept and counted
  r = await run({ out: out4, cap: 9 });
  assert.deepStrictEqual([r.ran, r.stopped, calls.length], [2, null, 2]);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(out4, 'rep1', 'b1', 'result.attempt-1.json'), 'utf8')).retryable, true);
  assert.ok(JSON.parse(fs.readFileSync(path.join(out4, 'rep1', 'b1', 'result.json'), 'utf8')).valid);
  assert.ok(Math.abs(r.spent - (0.25 + 2 * first.usage.cost_usd)) < 1e-9, r.spent);
  assert.deepStrictEqual(r.attempts.map((a) => [a.id, a.rep, a.reason]), [['b1', 1, dead.invalid_reason]]); // e. the retried attempt is reported
  await assert.rejects(batch({ dirs: [dirs[0]], manifests: [], repos, out, cap: 1, maxTotal: 1, budget: '1', engine, log: () => {} }), /no manifest entry for b1/);
});

test('batch: manifest + ids input (confirm-corpus shape, no dirs): manifest order, --ids subset, unknown id throws; a base-less control runs at head~1', async () => {
  const { batch, entries } = require('./replay.js'), api = require('../src/engines/claude-api.js');
  const { d } = mkRepo(), repos = path.join(tmp, 'm-repos'); fs.mkdirSync(repos, { recursive: true }); fs.cpSync(d, path.join(repos, 'clone1'), { recursive: true });
  const base = git(d, 'rev-parse', 'HEAD~1'), head = git(d, 'rev-parse', 'HEAD'), man = path.join(tmp, 'm-man.json');
  fs.writeFileSync(man, JSON.stringify({ status: 'frozen', bugs: [{ repo: 'o/r', clone: 'clone1', introducing: head, pr: 7, base }], controls: [{ repo: 'o/r', clone: 'clone1', sha: head, pr: 8 }] }));
  const e = entries(man); assert.deepStrictEqual(e.map((x) => [x.id, x.set, x.base, x.number, x.title]), [['clone1-7', 'bug', base, 7, ''], ['clone1-8', 'control', head + '~1', 8, '']]);
  const fetchFn = async (url, init) => ({ status: 200, ok: true, headers: { get: () => null }, text: async () => JSON.stringify({ type: 'message', model: JSON.parse(init.body).model, stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(findings()) }], usage: { input_tokens: 1000, output_tokens: 100 } }) });
  const engine = async ({ dir, ctx, repo, model, budget }) => { const log = console.log; console.log = () => {};
    try { await api.run({ GITHUB_WORKSPACE: repo, CTX: ctx, PROMPT_FILE: path.join(dir, 'prompt.md'), ANTHROPIC_API_KEY: 'sk-ant-offline-mock', MODEL: model, MAX_BUDGET_USD: budget, MAX_OUTPUT_TOKENS: '32000', TIMEOUT: '12' }, { fetchFn, sleep: async () => {} }); } finally { console.log = log; }
    return 0; };
  const logs = []; let r = await batch({ list: e, repos, out: path.join(tmp, 'm-out'), cap: 9, maxTotal: 100, budget: '0.5', engine, log: (x) => logs.push(x) });
  assert.deepStrictEqual([r.ran, r.stopped], [2, null]); assert.deepStrictEqual(logs.map((x) => /^(\S+)/.exec(x)[1]), ['clone1-7', 'clone1-8']);
  assert.ok(['clone1-7', 'clone1-8'].every((i) => JSON.parse(fs.readFileSync(path.join(tmp, 'm-out', 'rep1', i, 'result.json'), 'utf8')).valid));
});

test('batch: an invalid run that is not an account/config error is recorded, the batch continues, and a second batch never re-rolls it', async () => {
  const { batch } = require('./replay.js');
  const { d } = mkRepo(), repos = path.join(tmp, 'x-repos'); fs.mkdirSync(repos, { recursive: true }); fs.cpSync(d, path.join(repos, 'r'), { recursive: true });
  const base = git(d, 'rev-parse', 'HEAD~1'), head = git(d, 'rev-parse', 'HEAD'), out = path.join(tmp, 'x-out'), calls = [];
  const list = [{ id: 'x1', repo: 'o/r', number: 1, base, head, title: 't', body: '' }, { id: 'x2', repo: 'o/r', number: 2, base, head, title: 't', body: '' }, { id: 'x3', repo: 'o/r', number: 3, base: 'f'.repeat(40), head, title: 't', body: '' }];
  const engine = async ({ ctx }) => { calls.push(ctx); fs.writeFileSync(path.join(ctx, 'findings.json'), '{}'); return 1; }; // exits 1: not a model/account failure
  let r = await batch({ list, repos, out, cap: 9, maxTotal: 100, budget: '0.5', engine, log: () => {} });
  assert.deepStrictEqual([r.ran, r.stopped, calls.length], [3, null, 2]);
  const res = (i) => JSON.parse(fs.readFileSync(path.join(out, 'rep1', i, 'result.json'), 'utf8'));
  assert.deepStrictEqual([res('x1').valid, res('x1').retryable, res('x2').valid], [false, undefined, false]); assert.match(res('x3').invalid_reason, /skipped by collect|collect failed/);
  r = await batch({ list, repos, out, cap: 9, maxTotal: 100, budget: '0.5', engine, log: () => {} });
  assert.deepStrictEqual([r.ran, r.skipped, calls.length], [0, 3, 2]);
  r = await batch({ list: [{ id: 'x4', repo: 'o/gone', number: 4, base, head, title: 't', body: '' }], repos, out, cap: 9, maxTotal: 100, budget: '0.5', engine, log: () => {} }); // no clone to copy: a throw is infrastructure, so a retryable stop, not a recorded miss
  assert.deepStrictEqual([r.ran, r.stopped, res('x4').retryable, calls.length], [1, 'x4', true, 2]);
});

test('batch: a run that reached the model is a miss (billed answer then 429; a throw after a billed engine run); duplicate ids throw', async () => {
  const { batch } = require('./replay.js'), api = require('../src/engines/claude-api.js');
  const { d } = mkRepo(), repos = path.join(tmp, 'y-repos'); fs.mkdirSync(repos, { recursive: true }); fs.cpSync(d, path.join(repos, 'r'), { recursive: true });
  const base = git(d, 'rev-parse', 'HEAD~1'), head = git(d, 'rev-parse', 'HEAD'), out = path.join(tmp, 'y-out'), E = (id) => ({ id, repo: 'o/r', number: 1, base, head, title: 't', body: '' });
  let n = 0;
  const fetchFn = async (url, init) => ++n === 1 ? { status: 200, ok: true, headers: { get: () => null }, text: async () => JSON.stringify({ type: 'message', model: JSON.parse(init.body).model, stop_reason: 'end_turn', content: [{ type: 'text', text: 'no json here' }], usage: { input_tokens: 1000, output_tokens: 100 } }) }
    : n > 3 ? { status: 200, ok: true, headers: { get: () => null }, text: async () => JSON.stringify({ type: 'message', model: JSON.parse(init.body).model, stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(findings()) }], usage: { input_tokens: 1000, output_tokens: 100 } }) } : { status: 429, ok: false, headers: { get: () => null }, text: async () => JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }) };
  const api_engine = async ({ dir, ctx, repo, model, budget }) => { const log = console.log; console.log = () => {};
    try { await api.run({ GITHUB_WORKSPACE: repo, CTX: ctx, PROMPT_FILE: path.join(dir, 'prompt.md'), ANTHROPIC_API_KEY: 'sk-ant-offline-mock', MODEL: model, MAX_BUDGET_USD: budget, MAX_OUTPUT_TOKENS: '32000', TIMEOUT: '12' }, { fetchFn, sleep: async () => {} }); } finally { console.log = log; }
    return 0; };
  const res = (i) => JSON.parse(fs.readFileSync(path.join(out, 'rep1', i, 'result.json'), 'utf8'));
  const engine = async (a) => { if (a.dir.endsWith('y2')) { fs.writeFileSync(path.join(a.ctx, 'usage.json'), JSON.stringify({ totalCostUsd: 0.3 })); fs.writeFileSync(path.join(a.ctx, 'findings.json'), '{}'); fs.rmSync(path.join(a.dir, 'meta.json')); return 0; } return api_engine(a); };
  const list = [E('y1'), E('y2'), E('y3')];
  let r = await batch({ list, repos, out, cap: 9, maxTotal: 100, budget: '0.5', engine, log: () => {} });
  assert.deepStrictEqual([r.ran, r.stopped], [3, null]);                                           // a. billed then 429: a miss, the batch goes on
  assert.strictEqual(fs.readFileSync(path.join(out, 'rep1', 'y1', 'ctx', 'engine-error'), 'utf8').trim().split(/\s/)[0], 'rate');
  assert.deepStrictEqual([res('y1').valid, res('y1').retryable, res('y1').usage.cost_usd > 0], [false, undefined, true]);
  assert.deepStrictEqual([res('y2').valid, res('y2').retryable, res('y2').thrown, res('y2').usage.cost_usd], [false, undefined, true, 0.3]); // b. a throw after a billed engine run
  assert.ok(Math.abs(r.spent - (0.3 + res('y1').usage.cost_usd + res('y3').usage.cost_usd)) < 1e-9);
  const calls = n; r = await batch({ list, repos, out, cap: 9, maxTotal: 100, budget: '0.5', engine, log: () => {} });
  assert.deepStrictEqual([r.ran, r.skipped, n, r.attempts], [0, 3, calls, []]);
  await assert.rejects(batch({ list: [E('z'), E('z')], repos, out, cap: 9, maxTotal: 100, budget: '0.5', engine, log: () => {} }), /duplicate id z/); // d.
});

test('batch: an unbilled rate limit (429) or quota error (402) is a retryable stop, never a recorded miss', async () => {
  const { batch } = require('./replay.js'), api = require('../src/engines/claude-api.js');
  const { d } = mkRepo(), repos = path.join(tmp, 'q-repos'); fs.mkdirSync(repos, { recursive: true }); fs.cpSync(d, path.join(repos, 'r'), { recursive: true });
  const base = git(d, 'rev-parse', 'HEAD~1'), head = git(d, 'rev-parse', 'HEAD');
  for (const [status, type, reason] of [[429, 'rate_limit_error', 'rate'], [402, 'billing_error', 'quota']]) {
    const out = path.join(tmp, `q-out-${status}`), fetchFn = async () => ({ status, ok: false, headers: { get: () => null }, text: async () => JSON.stringify({ type: 'error', error: { type, message: 'no' } }) });
    const engine = async ({ dir, ctx, repo, model, budget }) => { const log = console.log; console.log = () => {};
      try { await api.run({ GITHUB_WORKSPACE: repo, CTX: ctx, PROMPT_FILE: path.join(dir, 'prompt.md'), ANTHROPIC_API_KEY: 'sk-ant-offline-mock', MODEL: model, MAX_BUDGET_USD: budget, MAX_OUTPUT_TOKENS: '32000', TIMEOUT: '12' }, { fetchFn, sleep: async () => {} }); } finally { console.log = log; }
      return 0; };
    const r = await batch({ list: ['q1', 'q2'].map((id) => ({ id, repo: 'o/r', number: 1, base, head, title: 't', body: '' })), repos, out, cap: 9, maxTotal: 100, budget: '0.5', engine, log: () => {} });
    const res = JSON.parse(fs.readFileSync(path.join(out, 'rep1', 'q1', 'result.json'), 'utf8'));
    assert.strictEqual(fs.readFileSync(path.join(out, 'rep1', 'q1', 'ctx', 'engine-error'), 'utf8').split('\n')[0], reason, `${status}`);
    assert.deepStrictEqual([res.valid, res.usage.cost_usd, res.retryable, r.stopped, r.ran, fs.existsSync(path.join(out, 'rep1', 'q2'))], [false, 0, true, 'q1', 1, false], `${status}`);
  }
});

// ---- V2: --cover-dir (real coverage.js before the engine) and arm A (--post-ref / repost) ----
const PRE_V2 = '8af6d2a8cdc715eb2ab1b7e8a5d48e482b984e2e'; // main before #430
const HAS_PRE_V2 = (() => { try { execFileSync('git', ['-C', path.join(__dirname, '..'), 'cat-file', '-e', `${PRE_V2}^{commit}`], { stdio: 'ignore' }); return true; } catch { return false; } })();
function mkCovRepo(name) {
  const d = path.join(tmp, name);
  fs.mkdirSync(path.join(d, 'src'), { recursive: true });
  git(d, 'init', '-q');
  for (const [k, v] of [['user.name', 't'], ['user.email', 't@example.invalid'], ['commit.gpgsign', 'false']]) git(d, 'config', k, v);
  fs.writeFileSync(path.join(d, 'src', 'a.js'), 'exports.limit = (n) => n > 3;\n');
  git(d, 'add', '-A'); git(d, 'commit', '-q', '-m', 'base');
  const base = git(d, 'rev-parse', 'HEAD');
  fs.writeFileSync(path.join(d, 'src', 'a.js'), "function limit(n) {\n  if (n > 5) {\n    return 'big';\n  }\n  return 'small';\n}\nfunction bump(n) {\n  return n + 1;\n}\nexports.limit = limit;\n");
  git(d, 'add', '-A'); git(d, 'commit', '-q', '-m', 'head');
  return { d, base, head: git(d, 'rev-parse', 'HEAD') };
}
const LCOV = 'TN:\nSF:src/a.js\nDA:1,1\nDA:2,1\nDA:3,0\nDA:5,1\nDA:7,4\nDA:8,4\nDA:10,1\nend_of_record\n';
// the model claims a missing test at line 8 (bump), which the report says ran (R-b: relabelled, summary only)
const covFindings = () => {
  const q = 'return n + 1;', row = { id: 'O1', obligation: 'limit returns small', source: 'PR body', behaviour: { path: 'src/a.js', line: 8, quote: q }, change: { path: 'src/a.js', line: 8, quote: q, side: 'RIGHT' }, evidence: [], status: 'missing_test', reason: 'no test', alignment: { status: 'consistent', since: 'introduced', reason: 'ok' } };
  return { requirements_source: 'none', not_reviewed: '', standards: { status: 'no_rules', sources: [], reason: 'none' }, layering: { status: 'checked', reason: 'x' }, requirements: [], coverage: [row],
    findings: [{ kind: 'missing_test', path: 'src/a.js', line: 8, quote: q, side: 'RIGHT', title: 'bump untested', body: 'No test asserts bump.', confidence: 'high', obligation_ids: ['O1'] }] };
};
const covEngine = ({ ctx }) => { fs.writeFileSync(path.join(ctx, 'findings.json'), JSON.stringify(covFindings())); fs.writeFileSync(path.join(ctx, 'engine-notes'), 'context pack: 1 files, 0 KB\n'); return 0; };
const key = (r) => r.findings.map((f) => [f.where, f.kind, f.path, f.line, f.title, f.source || ''].join('|')).sort();
async function v2Runs() {
  const { runReal } = require('./replay.js'), { d, base, head } = mkCovRepo('cov-repo');
  const coverDir = path.join(tmp, 'cov-reports'); fs.mkdirSync(path.join(coverDir, 'c1'), { recursive: true }); fs.writeFileSync(path.join(coverDir, 'c1', 'lcov.info'), LCOV);
  const entry = { id: 'c1', repo: 'o/r', number: 5, base, head, title: 't', body: 'limit' };
  const withCov = await runReal({ entry, repoDir: d, out: path.join(tmp, 'v2-with', 'rep1'), engine: covEngine, coverDir });
  const without = await runReal({ entry, repoDir: d, out: path.join(tmp, 'v2-without', 'rep1'), engine: covEngine });
  const none = await runReal({ entry: { ...entry, id: 'c-none' }, repoDir: d, out: path.join(tmp, 'v2-none', 'rep1'), engine: covEngine, coverDir }); // a coverDir without a report for this id
  return { withCov, without, none, coverDir, d };
}
let v2Cache; const v2 = () => (v2Cache ||= v2Runs());

test('V2 --cover-dir: a never-run changed line becomes a source: coverage finding in result.json; the ran line is a relabelled summary item', async () => {
  const { withCov } = await v2();
  assert.deepStrictEqual([withCov.coverage.report, withCov.coverage.used], ['lcov.info', true], JSON.stringify(withCov.coverage));
  const ra = withCov.findings.filter((f) => f.source === 'coverage');
  assert.strictEqual(ra.length, 1, JSON.stringify(withCov.findings));
  assert.deepStrictEqual([ra[0].where, ra[0].kind, ra[0].path, ra[0].line], ['inline', 'missing_test', 'src/a.js', 3]);
  assert.match(ra[0].title, /limit: 1 added line never executed by any unit test \(L3\)/);
  const rb = withCov.findings.filter((f) => f.source === 'relabel');
  assert.deepStrictEqual(rb.map((f) => [f.where, f.kind, f.line]), [['summary', 'weak_test', 8]]); // source read from the counts marker
  assert.ok(withCov.valid, withCov.invalid_reason);
});

test('V2 without --cover-dir the output is unchanged: no coverage block, no source, no R-a', async () => {
  const { without, none } = await v2();
  assert.ok(!('coverage' in without) && !('rollup' in without));
  assert.ok(without.findings.every((f) => !f.source), JSON.stringify(without.findings));
  assert.deepStrictEqual(without.findings.map((f) => [f.where, f.kind, f.line]), [['inline', 'missing_test', 8]]);
  assert.deepStrictEqual(none.coverage, { report: null, used: false, note: 'no report for this id' }); // a cover dir without this id's report: nothing runs, V1 behaviour
  assert.deepStrictEqual(key(none), key(without));
});

test('V2 repost: re-posts the saved findings (no model call) into a parallel tree; --post-ref reproduces the pre-V2 behaviour, no ref reproduces V2', { skip: !HAS_PRE_V2 && 'pre-V2 commit not in this clone' }, async () => {
  const { repost, dropRefRoots } = require('./replay.js'), { withCov, without, coverDir, d } = await v2();
  const from = path.join(tmp, 'v2-with'), repos = path.join(tmp, 'repos');
  fs.mkdirSync(repos, { recursive: true }); fs.cpSync(d, path.join(repos, 'r'), { recursive: true }); // the checkout is rebuilt from <repos>/<entry.repo's last segment>
  try {
    const now = path.join(tmp, 'v2-repost-now'), old = path.join(tmp, 'v2-repost-old');
    await repost({ from, to: now, repos, coverDir, log: () => {} });
    await repost({ from, to: old, repos, coverDir, postRef: PRE_V2, log: () => {} });
    const rd = (o) => JSON.parse(fs.readFileSync(path.join(o, 'rep1', 'c1', 'result.json'), 'utf8')), rNow = rd(now), rOld = rd(old);
    assert.deepStrictEqual(key(rNow), key(withCov)); // same code, same saved model output: the same result
    assert.ok(rOld.findings.length && rOld.findings.every((f) => !f.source), JSON.stringify(rOld.findings)); // pre-V2 post.js knows neither R-a nor R-b
    assert.deepStrictEqual(key(rOld), key(without)); // arm A = what main did before V2 with the same model output
    assert.strictEqual(fs.readFileSync(path.join(from, 'rep1', 'c1', 'ctx', 'findings.json'), 'utf8'), fs.readFileSync(path.join(old, 'rep1', 'c1', 'ctx', 'findings.json'), 'utf8')); // the model output is the saved one
  } finally { dropRefRoots(); }
});

test('V2 prompt hash (B5): the prompt bytes are hashed per run; coverage changes them; repost records whether the arm saw the same prompt', async () => {
  const { withCov, without, none, coverDir, d } = await v2();
  const h = /^[0-9a-f]{64}$/;
  assert.ok([withCov, without, none].every((r) => h.test(r.prompt_sha256)));
  assert.notStrictEqual(withCov.prompt_sha256, without.prompt_sha256); // coverage.txt is in the prompt
  const { repost } = require('./replay.js'), repos = path.join(tmp, 'repos-h');
  fs.mkdirSync(repos, { recursive: true }); fs.cpSync(d, path.join(repos, 'r'), { recursive: true });
  const same = path.join(tmp, 'v2-hash-same'), diff = path.join(tmp, 'v2-hash-diff'), rd = (o) => JSON.parse(fs.readFileSync(path.join(o, 'rep1', 'c1', 'result.json'), 'utf8'));
  await repost({ from: path.join(tmp, 'v2-with'), to: same, repos, coverDir, log: () => {} });
  await repost({ from: path.join(tmp, 'v2-with'), to: diff, repos, log: () => {} }); // arm without a report: another prompt, so it could not share the model output
  assert.deepStrictEqual([rd(same).prompt_matches_source, rd(same).source_prompt_sha256], [true, withCov.prompt_sha256]);
  assert.deepStrictEqual([rd(diff).prompt_matches_source, rd(diff).prompt_sha256], [false, without.prompt_sha256]);
});

test('V2 repost with a cover dir lacking this id: no coverage, no R-a/R-b, and the no-report notice is in the summary', async () => {
  const { coverDir, d } = await v2(), { repost } = require('./replay.js'), repos = path.join(tmp, 'repos-n');
  fs.mkdirSync(repos, { recursive: true }); fs.cpSync(d, path.join(repos, 'r'), { recursive: true });
  const from = path.join(tmp, 'v2-with'), to = path.join(tmp, 'v2-repost-nobody'), empty = path.join(tmp, 'cov-empty'); fs.mkdirSync(empty, { recursive: true });
  await repost({ from, to, repos, coverDir: empty, log: () => {} });
  const r = JSON.parse(fs.readFileSync(path.join(to, 'rep1', 'c1', 'result.json'), 'utf8')), s = fs.readFileSync(path.join(to, 'rep1', 'c1', 'summary.md'), 'utf8');
  assert.deepStrictEqual(r.coverage, { report: null, used: false, note: 'no report for this id' });
  assert.ok(r.findings.every((f) => !f.source), JSON.stringify(r.findings));
  assert.match(s, /not verified: no coverage report/);
  assert.ok(coverDir);
});

test('entries reads v2-corpus.json rows (bug-blind PRs: parent -> sha, no fix)', () => {
  const { entries } = require('./replay.js'), f = path.join(tmp, 'v2c.json');
  fs.writeFileSync(f, JSON.stringify({ seed: 1, rows: [{ id: 'hono-4862', repo: 'honojs/hono', clone: 'hono', pr: 4862, sha: 'bbb', parent: 'aaa', title: 'feat', body: 'text', stratum: 's1' }] }));
  assert.deepStrictEqual(entries(f), [{ id: 'hono-4862', repo: 'honojs/hono', clone: 'hono', number: 4862, base: 'aaa', head: 'bbb', title: 'feat', body: 'text', set: 'v2' }]);
});

test('a batch that stops (exit 1) with --post-ref still removes its temp worktree', { skip: !HAS_PRE_V2 && 'pre-V2 commit not in this clone' }, () => {
  const { spawnSync } = require('node:child_process'), root = path.join(__dirname, '..'), f = path.join(tmp, 'v2c-stop.json'), repos = path.join(tmp, 'no-repos');
  fs.mkdirSync(repos, { recursive: true });
  fs.writeFileSync(f, JSON.stringify({ rows: [{ id: 'hono-1', repo: 'o/hono', clone: 'hono', pr: 1, sha: 'bbb', parent: 'aaa', title: 't', body: '' }] }));
  const decoy = path.join(os.tmpdir(), `specguard-postref-decoy-${process.pid}`); // a concurrent run's worktree: the test must leave it alone
  execFileSync('git', ['-C', root, 'worktree', 'add', '--detach', '-f', decoy, PRE_V2], { stdio: 'ignore' });
  const env = { ...process.env }; delete env.ANTHROPIC_API_KEY;
  const r = spawnSync('node', [path.join(__dirname, 'replay.js'), 'batch', '--out', path.join(tmp, 'stop-out'), '--repos', repos, '--cap', '1', '--budget', '0.25', '--max-total', '6', '--manifest', f, '--ids', 'all', '--post-ref', PRE_V2], { encoding: 'utf8', env });
  const wt = execFileSync('git', ['-C', root, 'worktree', 'list', '--porcelain'], { encoding: 'utf8' });
  // only THIS child's worktree (specguard-postref-<sha12>-<child pid>) is ours to remove; a concurrent run may own another
  const mine = [...wt.matchAll(/^worktree (.*specguard-postref-[0-9a-f]{12}-(\d+))$/gm)].filter((m) => +m[2] === r.pid).map((m) => m[1]);
  for (const d of mine) execFileSync('git', ['-C', root, 'worktree', 'remove', '--force', d]);
  const decoyAlive = fs.existsSync(decoy);
  execFileSync('git', ['-C', root, 'worktree', 'remove', '--force', decoy]);
  assert.strictEqual(r.status, 1, `${r.stdout}${r.stderr}`); // the batch stopped (a clone that cannot be made is a retryable stop)
  assert.deepStrictEqual(mine, [], 'temp worktree of the child left behind');
  assert.ok(decoyAlive, "another run's specguard-postref worktree must not be touched");
});
