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
  const summary = '## S\n\n<details><summary>2 more item(s): low</summary>\n\n- **x** (`a.js:1`, k)\n- **y** (`a.js:2`, k)\n</details>\n\n### Pre-existing drift (not caused by this PR)\n\n- **z** (`a.js:3`, k)\n';
  const r = countFindings([c('missing_test', 'high'), c('missing_test', 'low'), c('spec_mismatch', 'high')], summary);
  assert.deepStrictEqual(r.inline, { total: 3, byKind: { missing_test: 2, spec_mismatch: 1 }, byConfidence: { high: 2, low: 1 } });
  assert.strictEqual(r.summary_only, 2);
  assert.strictEqual(r.pre_existing, 1);
  assert.deepStrictEqual(countFindings([], ''), { inline: { total: 0, byKind: {}, byConfidence: { high: 0, low: 0 } }, summary_only: 0, pre_existing: 0 });
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
