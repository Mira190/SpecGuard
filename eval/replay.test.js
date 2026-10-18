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
