const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const post = require('./post.js');

const behaviour = { path: 'src.js', line: 3, quote: 'if (x) {' };
const evidence = { path: 'test.js', line: 2, quote: 'assert.equal(result, 42);', layer: 'unit', kind: 'assertion', proves: 'Returns the required total for the boundary input.' };
const NA = { status: 'not_applicable', reason: 'No requirement governs this obligation.' };
const aligned = (d) => { for (const c of d.coverage) c.alignment ??= { status: 'unknown', reason: 'Fixture recorded before the alignment contract.' }; return d; };
const OK = { status: 'consistent', reason: 'Requirement says X; code does X.' };
const row = (status = 'covered', extra = {}) => ({ id: 'O1', obligation: 'Returns the required total', source: 'issue #1 AC 1', behaviour: { ...behaviour }, change: { ...behaviour }, evidence: status === 'missing_test' ? [] : [{ ...evidence }], status, reason: 'Searched unit and integration suites for the public total function.', alignment: { ...NA }, ...extra });
const finding = (kind = 'missing_test', extra = {}) => ({ kind, obligation_ids: kind === 'standard' ? [] : ['O1'], ...behaviour, title: 'Verify the boundary total', body: 'The boundary has no assertion. Add assert.equal(total(1), 42).', confidence: 'high', ...extra, kind });
const report = (extra = {}) => ({ requirements: [], requirements_source: 'issue #1', not_reviewed: '', coverage: [row('missing_test')], findings: [finding()], standards: { status: 'checked', sources: ['RULES.md'], reason: 'Checked the changed code against the error handling rule.' }, layering: { status: 'checked', reason: 'Searched unit and integration suites; no suitable additional pushdown.' }, ...extra });

const patch = '@@ -1,3 +1,4 @@\n l1\n-old\n+l2\n+if (x) {\n l4\n';
test('maps diff hunks and routes low confidence and overflow to summary', () => {
  const map = post.parsePatch(patch);
  assert.deepEqual([...map.RIGHT], [[1, 0], [2, 0], [3, 0], [4, 0]]);
  assert.deepEqual([...map.LEFT], [[2, 0]]);
  assert.equal(post.parsePatch(undefined).RIGHT.size, 0);
  assert.equal(post.anchor(finding(), map), 'inline');
  assert.equal(post.anchor(finding('missing_test', { line: 8 }), map), 'file');
  assert.equal(post.anchor(finding(), undefined), 'summary');
  assert.equal(post.anchor(finding('missing_test', { start_line: 3 }), map), 'file');
  const plan = post.plan([finding(), finding('weak_test', { confidence: 'low' }), finding('pushdown')], new Map([['src.js', map]]), 1);
  assert.equal(plan.inline.length, 1);
  assert.deepEqual(plan.summary.map((i) => i.why), ['low confidence', 'over max_comments']);
  assert.equal(post.plan(Array(40).fill(finding()), new Map([['src.js', map]]), 99).inline.length, 30);
});

test('rejects structurally unusable output', () => {
  assert.deepEqual(post.validate(report()), { ok: true });
  for (const d of [null, [], 'x', report({ coverage: undefined }), report({ findings: {} }), report({ requirements: null })]) assert.equal(post.validate(d).ok, false);
});

test('degrades only the part with a semantic problem and records a note', () => {
  const run = (d) => { const r = post.validate(d); assert.equal(r.ok, true); return d; };
  const noted = (d, re) => assert.ok(d.validation_notes.some((n) => re.test(n)), d.validation_notes.join('|'));
  let d = run(report({ standards: undefined, layering: undefined }));
  assert.deepEqual([d.standards.status, d.layering.status, d.findings.length], ['not_reviewed', 'not_reviewed', 1]);
  d = run(report({ coverage: [row('covered', { evidence: [] })], findings: [] }));
  assert.equal(d.coverage[0].status, 'unknown'); noted(d, /covered needs a current unit assertion/);
  d = run(report({ coverage: [row('covered', { evidence: [{ ...evidence, layer: 'integration' }] })], findings: [] }));
  assert.equal(d.coverage[0].status, 'unknown');
  d = run(report({ findings: [] }));
  assert.equal(d.coverage[0].status, 'unknown'); noted(d, /needs exactly one missing_test/);
  d = run(report({ findings: [finding(), finding()] }));
  assert.deepEqual([d.coverage[0].status, d.findings.length], ['unknown', 0]);
  d = run(report({ findings: [finding('pushdown')] }));
  assert.equal(d.findings.length, 0); noted(d, /contradicts coverage/);
  d = run(report({ findings: [finding(), finding('missing_test', { obligation_ids: ['absent'] })] }));
  assert.equal(d.findings.length, 1); noted(d, /no valid obligation/);
  d = run(report({ findings: [finding(), finding('missing_test', { line: 0, title: 'Bad line' })] }));
  assert.equal(d.findings.length, 1); noted(d, /Dropped findings\[1\] missing_test src.js Bad line/);
  d = run(report({ coverage: [row('missing_test'), row('missing_test')] }));
  assert.equal(d.coverage.length, 1); noted(d, /duplicate id/);
  d = run(report({ coverage: [row('missing_test', { evidence: [evidence] })] }));
  assert.deepEqual([d.coverage[0].status, d.findings.length], ['missing_test', 1]); // assertion evidence on a missing_test row is dropped, not the row
  d = run(report({ requirements: [{ id: 'R1', source: 'PR body', quote: 'q', obligation_ids: ['nope'], reason: 'r' }, { id: 'R2' }] }));
  assert.deepEqual([d.requirements.length, d.requirements[0].obligation_ids], [1, []]);
  d = run(report({ standards: { status: 'checked', sources: [], reason: 'ok' }, findings: [finding(), finding('standard')] }));
  assert.deepEqual([d.standards.status, d.findings.map((f) => f.kind)], ['not_reviewed', ['missing_test']]);
  assert.equal(post.noGaps(d), false);
});

test('records integration-only evidence without claiming unit coverage or forcing pushdown', () => {
  const c = row('higher_level_only', { evidence: [{ ...evidence, layer: 'integration' }] });
  assert.equal(post.validate(report({ coverage: [c], findings: [] })).ok, true);
  assert.equal(post.validate(report({ coverage: [c], findings: [finding('pushdown')] })).ok, true);
  assert.equal(post.noGaps(report({ coverage: [c], findings: [] })), false);
  assert.match(post.proven([c]), /Unit evidence: 0\/1/);
  assert.equal(post.proven([]), '');
  assert.equal(post.proven([row('needs_human')]), '');
});

test('never labels empty, partial, unknown or incomplete checks as a clean review', () => {
  const clean = report({ coverage: [row()], findings: [] });
  assert.equal(post.noGaps(clean), true);
  for (const d of [{ ...clean, coverage: [] }, { ...clean, not_reviewed: 'Issue unavailable' },
    { ...clean, coverage: [row('unknown')] }, { ...clean, coverage: [row('needs_human')] },
    { ...clean, standards: { status: 'not_reviewed' } }, { ...clean, layering: { status: 'not_reviewed' } }]) assert.equal(post.noGaps(d), false);
});

test('verifies assertion citations and rejects a false no-rules assessment', () => {
  const read = (p) => ({ 'src.js': ['l1', 'l2', behaviour.quote], 'test.js': ['test', evidence.quote] })[p];
  assert.equal(post.verifyEvidence(report({ coverage: [row()], findings: [] }), new Set(['src.js']), new Set(['RULES.md']), read, new Map([['src.js', post.parsePatch(patch)]])).coverage[0].status, 'covered');
  const bad = report({ coverage: [row('weak_test', { evidence: [{ ...evidence, quote: 'invented assertion' }] })], findings: [finding('weak_test')] });
  const result = post.verifyEvidence(bad, new Set(['src.js']), new Set(['RULES.md']), read, new Map([['src.js', post.parsePatch(patch)]]));
  assert.equal(result.coverage[0].status, 'unknown');
  assert.deepEqual(result.findings, []);
  const rules = report({ standards: { status: 'no_rules', sources: [], reason: 'No rules' } });
  assert.equal(post.verifyEvidence(rules, new Set(['src.js']), new Set(['RULES.md']), read, new Map([['src.js', post.parsePatch(patch)]])).standards.status, 'not_reviewed');
});

test('anchors nearby quotes and deduplicates stable criteria', () => {
  const lines = ['a', '  throw new Error(x);', '}', 'c'];
  assert.equal(post.snap({ line: 3, quote: 'throw new Error(x);' }, lines), -1);
  assert.equal(post.snap({ line: 3, start_line: 1, quote: 'throw new Error(x);' }, lines), null);
  assert.equal(post.snap({ line: 2, quote: 'invented' }, lines), null);
  assert.equal(post.ruleLine('throw new Error(x);', lines, 3), 2);
  assert.equal(post.ruleLine('', lines, 1), 0);
  assert.equal(post.fingerprint('missing_test', 'a.js', 'x', 'issue #1 AC 1'), post.fingerprint('missing_test', 'a.js', 'y', 'issue #1 AC 1'));
  assert.notEqual(post.fingerprint('missing_test', 'a.js', 'x'), post.fingerprint('missing_test', 'a.js', 'y'));
});

test('renders suggestions only for standards and redacts secrets', () => {
  const standard = finding('standard', { suggestion: 'fixed();' });
  assert.match(post.commentBody(standard, 'abc'), /```suggestion\nfixed\(\);/);
  assert.doesNotMatch(post.commentBody(standard, 'abc', false), /```suggestion/);
  assert.doesNotMatch(post.commentBody(finding('missing_test', { suggestion: 'fixed();' }), 'abc'), /fixed\(\);/);
  assert.equal(post.redact('ghp_' + 'a'.repeat(36)), '[REDACTED]');
  assert.ok(post.truncate('x'.repeat(70000)).length <= 65000);
  assert.equal(post.axes([finding(), finding('pushdown')]), 'Tests: 1 missing, 0 weak · Standards: 0 · Layering: 1');
});

const track = (s, ...files) => execFileSync('git', ['add', ...files], { cwd: s.dir }); // workspace files a test adds must be tracked to be read
const fileDiff = (p, body, head = `--- a/${p}\n+++ b/${p}`) => `diff --git a/${p} b/${p}\n${head}\n${body}\n`;

function setup(t, data = report(), options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-'));
  const previous = { ...process.env };
  t.after(() => {
    for (const key of ['CTX', 'GITHUB_WORKSPACE', 'HEAD_SHA', 'MAX_COMMENTS', 'ENGINE', 'SKIP', 'PARTIAL', 'STANDARDS_CHECKS', 'STANDARDS_REF']) {
      if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  fs.mkdirSync(path.join(dir, 'ctx'));
  fs.writeFileSync(path.join(dir, 'src.js'), 'l1\nl2\nif (x) {\nl4\nl5\nl6\nl7\nl8\n');
  fs.writeFileSync(path.join(dir, 'test.js'), `test\n${evidence.quote}\n`);
  fs.writeFileSync(path.join(dir, 'RULES.md'), 'rule one\nrule two\n');
  for (const a of [['init', '-q'], ['add', 'src.js', 'test.js', 'RULES.md']]) execFileSync('git', a, { cwd: dir }); // citations are only read from tracked files
  for (const [name, value] of Object.entries({ 'files.txt': 'src.js\n', 'diff.patch': fileDiff('src.js', patch),'standards.txt': 'RULES.md\n', 'findings.json': JSON.stringify(data), 'requirements-status.json': JSON.stringify({ status: 'available', sources: ['PR body', 'issue #1'], limitations: [] }) })) fs.writeFileSync(path.join(dir, 'ctx', name), value);
  const calls = { review: [], file: [], summary: [], list: 0 };
  let count = 0;
  const github = { paginate: async (fn, args) => (await fn(args)).data, rest: {
    pulls: {
      get: async () => ({ data: { head: { sha: options.head || 'HEADSHA' }, ...options.pr } }),
      listFiles: async () => { calls.list++; if (options.listError) throw Object.assign(new Error('Server Error: diff temporarily unavailable'), { status: 500 }); return { data: options.listed || [{ filename: 'src.js', patch }] }; },
      listReviewComments: async () => ({ data: options.existing || [] }),
      createReview: async (args) => { calls.review.push(args); if (options.retry422 && count++ === 0) throw Object.assign(new Error('bad anchor'), { status: 422 }); },
      createReviewComment: async (args) => { calls.file.push(args); },
    },
    issues: {
      listComments: async () => ({ data: options.issueComments || [] }),
      createComment: async (args) => { calls.summary.push(args); },
      updateComment: async (args) => { calls.summary.push(args); },
    },
  } };
  const warnings = [];
  const core = { warning: (s) => warnings.push(s), summary: { addRaw() { return this; }, async write() {} } };
  const context = { repo: { owner: 'o', repo: 'r' }, serverUrl: 'https://github.com', payload: { pull_request: { number: 7, head: { sha: 'HEADSHA' } } } };
  Object.assign(process.env, { CTX: path.join(dir, 'ctx'), GITHUB_WORKSPACE: dir, HEAD_SHA: 'HEADSHA', MAX_COMMENTS: '10', ENGINE: 'copilot', SKIP: 'false', PARTIAL: 'false', STANDARDS_CHECKS: '', STANDARDS_REF: 'head' });
  return { github, context, core, calls, warnings, dir };
}

test('posts requirement-aware findings and reports standards and layers independently', async (t) => {
  const s = setup(t);
  await post(s);
  assert.equal(s.calls.review.length, 1);
  assert.equal(s.calls.review[0].commit_id, 'HEADSHA');
  assert.equal(s.calls.review[0].event, 'COMMENT');
  assert.equal(s.calls.review[0].comments[0].line, 3);
  assert.match(s.calls.summary[0].body, /Coding standards: checked/);
  assert.match(s.calls.summary[0].body, /Test layers: checked/);
  assert.match(s.calls.summary[0].body, /O1: Returns the required total/);
});

test('keeps persistent gaps in coverage when their inline comment was already posted', async (t) => {
  const fp = post.fingerprint('missing_test', 'src.js', behaviour.quote);
  const s = setup(t, report(), { existing: [{ body: `<!-- specguard:fp=${fp} -->`, user: { type: 'Bot', login: 'github-actions[bot]' } }] });
  await post(s);
  assert.equal(s.calls.review.length, 0);
  assert.match(s.calls.summary[0].body, /1 already posted/);
  assert.match(s.calls.summary[0].body, /missing_test/);
  assert.doesNotMatch(s.calls.summary[0].body, /No test gaps found/);
});

test('preserves weak assertions outside the diff in the summary', async (t) => {
  const s = setup(t, report({ coverage: [row('weak_test')], findings: [finding('weak_test', evidence)] }));
  await post(s);
  assert.equal(s.calls.review.length, 0);
  assert.match(s.calls.summary[0].body, /assertion outside the reviewed diff/);
  assert.match(s.calls.summary[0].body, /test.js:2/);
});

test('does not publish results for a superseded commit', async (t) => {
  const s = setup(t, report(), { head: 'NEWHEAD' });
  await post(s);
  assert.deepEqual(s.calls, { review: [], file: [], summary: [], list: 0 });
  assert.match(s.warnings[0], /superseded HEAD/);
});

test('retries rejected inline anchors as a body-only review', async (t) => {
  const s = setup(t, report(), { retry422: true });
  await post(s);
  assert.equal(s.calls.review.length, 2);
  assert.equal(s.calls.review[1].comments, undefined);
  assert.match(s.calls.review[1].body, /unanchored/);
});

test('reports missing model output as incomplete', async (t) => {
  const s = setup(t);
  fs.unlinkSync(path.join(s.dir, 'ctx/findings.json'));
  await post(s);
  assert.equal(s.calls.review.length, 0);
  assert.match(s.calls.summary[0].body, /Could not complete/);
});

test('verifies unit assertions and displays their text and layer without claiming execution', async (t) => {
  const s = setup(t, report({ coverage: [row()], findings: [] }));
  await post(s);
  assert.match(s.calls.summary[0].body, /No test gaps found/);
  assert.match(s.calls.summary[0].body, /unit: test.js:2/);
  assert.match(s.calls.summary[0].body, /assert.equal\(result, 42\)/);
  assert.match(s.calls.summary[0].body, /static review; tests not executed/);
});

test('unavailable requirements and truncated diffs prevent clean-review wording', async (t) => {
  const s = setup(t, report({ coverage: [row()], findings: [] }));
  fs.writeFileSync(path.join(s.dir, 'ctx/requirements-status.json'), JSON.stringify({ status: 'partial', sources: ['PR body'], limitations: ['Could not read issue #2.'] }));
  process.env.PARTIAL = 'true';
  await post(s);
  assert.doesNotMatch(s.calls.summary[0].body, /No test gaps found/);
  assert.match(s.calls.summary[0].body, /Could not read issue #2/);
  assert.match(s.calls.summary[0].body, /Diff truncated/);
});

test('refuses assertion citations outside the workspace', async (t) => {
  const s = setup(t, report({ coverage: [row('covered', { evidence: [{ ...evidence, path: '../outside.js' }] })], findings: [] }));
  await post(s);
  assert.match(s.calls.summary[0].body, /unknown/);
  assert.match(s.calls.summary[0].body, /Unit evidence: 0\/1/);
});

test('renders empty assessments honestly', () => {
  const summary = post.buildSummary({ status: 'Reviewed', data: report({ coverage: [], findings: [] }) });
  assert.match(summary, /No obligations assessed/);
  assert.doesNotMatch(summary, /No test gaps found/);
});

test('corrects a rule citation, rejects an invented rule and preserves the review limitation', async (t) => {
  const s = setup(t, report({ coverage: [], findings: [
    finding('standard', { line: 2, quote: 'l2', rule_source: 'RULES.md:1', rule_quote: 'rule two', suggestion: 'fixed();' }),
    finding('standard', { rule_source: 'RULES.md:2', rule_quote: 'invented rule' }),
  ] }));
  await post(s);
  assert.equal(s.calls.review[0].comments.length, 1);
  assert.match(s.calls.review[0].comments[0].body, /rule: RULES.md:2/);
  assert.match(s.calls.review[0].comments[0].body, /```suggestion/);
  assert.match(s.calls.summary[0].body, /Unverified standards finding omitted/);
});

test('posts a file-level finding when its valid citation is outside the diff hunk', async (t) => {
  const s = setup(t, report({ findings: [finding('missing_test', { line: 8, quote: 'l8' })] }));
  await post(s);
  assert.equal(s.calls.review.length, 0);
  assert.equal(s.calls.file[0].subject_type, 'file');
  assert.match(s.calls.file[0].body, /blob\/HEADSHA\/src.js#L8/);
});

test('does not let a human-supplied fingerprint suppress the review', async (t) => {
  const fp = post.fingerprint('missing_test', 'src.js', behaviour.quote);
  const s = setup(t, report(), { existing: [{ body: `<!-- specguard:fp=${fp} -->`, user: { type: 'User' } }] });
  await post(s);
  assert.equal(s.calls.review[0].comments.length, 1);
});

test('rechecks HEAD after analysis and before posting comments', async (t) => {
  const s = setup(t);
  let reads = 0;
  s.github.rest.pulls.get = async () => ({ data: { head: { sha: reads++ === 0 ? 'HEADSHA' : 'NEWHEAD' } } });
  await post(s);
  assert.equal(s.calls.review.length, 0);
  assert.equal(s.calls.summary.length, 0);
});

test('summary preserves the integration assertion and proposed pushdown as a distinct finding', async (t) => {
  const s = setup(t, report({ coverage: [row('higher_level_only', { evidence: [{ ...evidence, layer: 'integration' }] })], findings: [finding('pushdown', { body: 'Unit-test total(1) = 42; keep the integration persistence check.' })] }));
  await post(s);
  assert.match(s.calls.summary[0].body, /integration: test.js:2/);
  assert.match(s.calls.summary[0].body, /Unit evidence: 0\/1/);
  assert.match(s.calls.summary[0].body, /Layering: 1/);
  assert.match(s.calls.review[0].comments[0].body, /keep the integration persistence check/);
});

test('reports a weakened assertion in a test-only PR with unchanged production behaviour', async (t) => {
  const s = setup(t, report({ coverage: [row('weak_test', { change: { ...evidence } })], findings: [finding('weak_test', evidence)] }));
  fs.writeFileSync(path.join(s.dir, 'ctx/files.txt'), 'test.js\n');
  fs.writeFileSync(path.join(s.dir, 'ctx/diff.patch'), fileDiff('test.js', `@@ -1,2 +1,2 @@\n test\n-assert.equal(result, 43);\n+${evidence.quote}`));
  await post(s);
  assert.equal(s.calls.review[0].comments[0].path, 'test.js');
  assert.match(s.calls.summary[0].body, /weak_test/);
  assert.doesNotMatch(s.calls.summary[0].body, /unknown/);
});

test('accepts a real zero-assertion or disabled test location without inventing an assertion', () => {
  for (const kind of ['no_assertion', 'disabled']) {
    const d = report({ coverage: [row('weak_test', { evidence: [{ ...evidence, kind }] })], findings: [finding('weak_test')] });
    assert.equal(post.validate(d).ok, true);
    d.coverage[0].status = 'covered'; d.findings = [];
    post.validate(d);
    assert.equal(d.coverage[0].status, 'unknown');
  }
});

test('preserves removed assertions from deleted test files as LEFT-side summary evidence', async (t) => {
  const removed = { ...evidence, side: 'LEFT', kind: 'removed' };
  const s = setup(t, report({ coverage: [row('weak_test', { change: removed, evidence: [removed] })], findings: [finding('weak_test', removed)] }));
  fs.unlinkSync(path.join(s.dir, 'test.js'));
  fs.writeFileSync(path.join(s.dir, 'ctx/files.txt'), 'test.js\n');
  fs.writeFileSync(path.join(s.dir, 'ctx/diff.patch'), fileDiff('test.js', `@@ -1,2 +0,0 @@\n-test\n-${evidence.quote}`, '--- a/test.js\n+++ /dev/null'));
  await post(s);
  assert.equal(s.calls.review.length, 0);
  assert.match(s.calls.summary[0].body, /removed test or assertion/);
  assert.match(s.calls.summary[0].body, /Tests: 0 missing, 1 weak/);
});

test('does not accept an unrelated historical line as the changed-line citation', () => {
  const d = report({ coverage: [row('weak_test', { change: { ...behaviour, line: 1, quote: 'l1' } })], findings: [finding('weak_test')] });
  post.verifyEvidence(d, new Set(['src.js']), new Set(['RULES.md']), (p) => p === 'src.js' ? ['l1', 'l2', behaviour.quote] : ['test', evidence.quote], new Map([['src.js', post.parsePatch(patch)]]));
  assert.equal(d.coverage[0].status, 'unknown');
  assert.equal(d.findings.length, 0);
});

test('restores omitted collected criteria to the report as unassessed', () => {
  const r = { id: 'R1', source: 'PR body', quote: 'Return 42.', obligation_ids: ['O1'], reason: 'Unit assertion found.' };
  const d = report({ requirements: [r], coverage: [row()], findings: [] });
  post.verifyRequirements(d, { documents: [{ source: 'PR body', text: 'Return 42.\nReject zero.' }], criteria: [{ id: 'R1', source: 'PR body', quote: 'Return 42.' }, { id: 'R2', source: 'PR body', quote: 'Reject zero.' }] });
  assert.equal(d.requirements.length, 2);
  assert.deepEqual(d.requirements[1].obligation_ids, []);
  assert.equal(post.noGaps(d), false);
  assert.match(post.buildSummary({ status: 'Reviewed', data: d }), /NOT ASSESSED/);
});

test('a compound criterion is covered only when all its obligations are', () => {
  const r = { id: 'R1', source: 'PR body', quote: 'Rejects empty names and trims whitespace.', obligation_ids: ['O1', 'O2'], reason: 'Split in two.' };
  const d = report({ requirements: [r], coverage: [row(), row('missing_test', { id: 'O2' })], findings: [finding('missing_test', { obligation_ids: ['O2'] })] });
  assert.equal(post.validate(d).ok, true);
  assert.match(post.buildSummary({ status: 'Reviewed', data: d }), /1\/2 obligations covered \(not fully covered\)/);
  const all = report({ requirements: [r], coverage: [row(), row('covered', { id: 'O2' })], findings: [] });
  assert.match(post.buildSummary({ status: 'Reviewed', data: all }), /2\/2 obligations covered\. Split/);
});

test('invalid requirement wording cannot support a covered obligation', () => {
  const d = report({ requirements: [{ id: 'R1', source: 'PR body', quote: 'Made up.', obligation_ids: ['O1'], reason: 'Covered' }], coverage: [row()], findings: [] });
  post.verifyRequirements(d, { documents: [{ source: 'PR body', text: 'Return 42.' }], criteria: [] });
  assert.equal(d.coverage[0].status, 'unknown');
  assert.equal(post.noGaps(d), false);
});

test('retains unimplemented requirements without a fabricated production location', () => {
  const d = report({ requirements: [{ id: 'R1', source: 'PR body', quote: 'Send receipts.', obligation_ids: ['O1'], reason: 'Implementation not located.' }], coverage: [row('unknown', { change: null, behaviour: null, evidence: [] })], findings: [] });
  assert.equal(post.validate(d).ok, true);
  assert.match(post.buildSummary({ status: 'Reviewed', data: d }), /implementation not located/);
  assert.equal(post.noGaps(d), false);
});

test('tooling results overwrite model claims and remain visible if the model fails', async (t) => {
  const s = setup(t, report({ tooling: { status: 'passed', checks: [], ref: 'fake' } }));
  process.env.STANDARDS_CHECKS = 'check:lint';
  s.github.rest.checks = { listForRef: async () => ({ data: [{ name: 'lint', status: 'completed', conclusion: 'failure', id: 1 }] }) };
  await post(s);
  assert.match(s.calls.summary[0].body, /Standards tooling: failed/);
  fs.unlinkSync(path.join(s.dir, 'ctx/findings.json'));
  await post(s);
  assert.match(s.calls.summary[1].body, /Could not complete/);
  assert.match(s.calls.summary[1].body, /Standards tooling: failed/);
});

test('live failure: checked standards without sources do not discard valid test findings', async (t) => {
  const s = setup(t, report({ coverage: [row('missing_test'), row('weak_test', { id: 'O2', evidence: [evidence] })],
    findings: [finding(), finding('weak_test', { obligation_ids: ['O2'], ...evidence })], standards: { status: 'checked', sources: [], reason: 'Checked everything.' } }));
  await post(s);
  const body = s.calls.summary[0].body;
  assert.match(body, /Tests: 1 missing, 1 weak/);
  assert.equal(s.calls.review[0].comments.length, 1);
  assert.match(body, /Coding standards: not_reviewed./);
  assert.match(body, /checked standards need sources/);
  assert.match(body, /Validation notes \(1\)/);
  assert.doesNotMatch(body, /No test gaps found|Could not complete/);
});

test('a degraded but otherwise clean report is never called clean', async (t) => {
  const s = setup(t, report({ coverage: [row()], findings: [], standards: { status: 'checked', sources: [], reason: 'x' } }));
  await post(s);
  assert.doesNotMatch(s.calls.summary[0].body, /No test gaps found/);
  assert.match(s.calls.summary[0].body, /Validation notes/);
});

test('accepts the documented "PR body AC k" citation on real r1 output and keeps every finding', () => {
  const load = (f) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/r1', f), 'utf8'));
  const d = aligned(load('findings.json')), status = load('requirements-status.json');
  const before = d.findings.length;
  assert.equal(post.validate(d).ok, true);
  post.verifyRequirements(d, status);
  assert.deepEqual(d.requirements.map((r) => [r.id, r.source, r.obligation_ids.length > 0]), [['R1', 'PR body', true], ['R2', 'PR body', true], ['R3', 'PR body', true], ['R4', 'PR body', true]]);
  assert.equal(d.findings.length, before);
  assert.equal(d.not_reviewed, '');
  const bad = report({ requirements: [{ id: 'R1', source: 'PR body AC x', quote: 'Return 42.', obligation_ids: ['O1'], reason: 'r' }], coverage: [row()], findings: [] });
  post.verifyRequirements(bad, { documents: [{ source: 'PR body', text: 'Return 42.' }], criteria: [{ id: 'R1', source: 'PR body', quote: 'Return 42.' }] });
  assert.deepEqual(bad.requirements[0].obligation_ids, []);
});

// Real model output from the first full evaluation (eval/results/full1): every expected finding must survive validation and citation checks.
function realRun(c) {
  const dir = path.join(__dirname, 'fixtures', c), load = (f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  const d = aligned(load('findings.json'));
  const maps = new Map();
  for (const part of fs.readFileSync(path.join(dir, 'diff.patch'), 'utf8').split(/^diff --git /m).filter(Boolean)) maps.set(/^a\/\S+ b\/(\S+)/.exec(part)[1], post.parsePatch(part.slice(part.indexOf('@@'))));
  const read = (p) => { // fixture files live under eval/cases/<case>/head; other repo paths are real
    const m = new RegExp(`^eval-sandbox/${c}/(.+)$`).exec(p);
    try { return fs.readFileSync(m ? path.join(__dirname, '..', 'eval/cases', c, 'head', m[1]) : path.join(__dirname, '..', p), 'utf8').split('\n'); } catch { return null; }
  };
  assert.equal(post.validate(d).ok, true);
  post.verifyEvidence(d, new Set(maps.keys()), new Set(d.standards.sources), read, maps);
  post.verifyRequirements(d, load('requirements-status.json'), read);
  return d;
}
const kept = (d) => d.findings.map((f) => `${f.kind}:${f.path.split('/').pop()}:${f.line}`);

test('l1: pushdown findings with component evidence survive (model omitted evidence kind)', () => {
  const d = realRun('l1');
  assert.deepEqual(kept(d).filter((k) => k.startsWith('pushdown')), ['pushdown:pricing.py:6', 'pushdown:pricing.py:8']);
  assert.deepEqual(d.coverage.filter((c) => c.status === 'higher_level_only').map((c) => c.id), ['O1', 'O2', 'O4', 'O6']);
  assert.equal(d.coverage.find((c) => c.id === 'O3').status, 'missing_test');
  assert.ok(kept(d).some((k) => k.startsWith('missing_test')));
  assert.deepEqual(d.validation_notes, []);
});

test('r3: compound-criterion missing_test findings survive (model omitted change; disabled evidence allowed)', () => {
  const d = realRun('r3');
  assert.deepEqual(kept(d).filter((k) => k.startsWith('missing_test')), ['missing_test:name.js:3', 'missing_test:name.js:5']);
  assert.deepEqual(d.coverage.map((c) => c.status), ['missing_test', 'missing_test']);
});

test('t3: a skipped test cited as disabled evidence keeps its missing_test finding', () => {
  const d = realRun('t3');
  assert.deepEqual(kept(d), ['missing_test:qty.test.js:9']);
  assert.equal(d.coverage[0].status, 'missing_test');
  assert.deepEqual(d.validation_notes, []);
});

test('a missing_test row may not cite assertion evidence, and covered still needs a real unit assertion', () => {
  const noted = (c) => { const d = report({ coverage: [c], findings: [finding()] }); post.validate(d); return d.validation_notes.join(); };
  assert.match(noted(row('missing_test', { evidence: [{ ...evidence }] })), /cannot claim assertion evidence/);
  // ... but the row and its finding survive: dropping a verified finding over a harmless evidence field lost real bug hits
  const d = report({ coverage: [row('missing_test', { evidence: [{ ...evidence }] })], findings: [finding()] });
  assert.equal(post.validate(d).ok, true);
  assert.equal(d.coverage[0].status, 'missing_test');
  assert.deepEqual(d.coverage[0].evidence, []);
  assert.equal(d.findings.length, 1);
  assert.match(noted(row('covered', { evidence: [{ ...evidence, kind: 'disabled' }] })), /covered needs a current unit assertion/);
});

test('reports an engine timeout or failure instead of a missing file', async (t) => {
  for (const [st, re] of [['timeout', /timed out after 7 minutes; raise review_timeout_minutes/], ['failed', /engine failed; see the job log/]]) {
    const s = setup(t);
    fs.unlinkSync(path.join(s.dir, 'ctx/findings.json'));
    fs.writeFileSync(path.join(s.dir, 'ctx/engine-status'), st + '\n');
    process.env.REVIEW_TIMEOUT_MINUTES = '7';
    await post(s);
    delete process.env.REVIEW_TIMEOUT_MINUTES;
    assert.match(s.calls.summary[0].body, re);
  }
});

test('parseDiff splits a multi-file diff: added, deleted and spaced paths', () => {
  const d = fileDiff('a b.js', patch) + fileDiff('new.js', '@@ -0,0 +1,2 @@\n+x\n+y', '--- /dev/null\n+++ b/new.js') + fileDiff('gone.js', '@@ -1,2 +0,0 @@\n-x\n-y', '--- a/gone.js\n+++ /dev/null');
  const m = post.parseDiff(d);
  assert.deepEqual([...m.keys()], ['a b.js', 'new.js', 'gone.js']);
  assert.equal(m.get('a b.js').RIGHT.has(3), true);
  assert.equal(m.get('new.js').RIGHT.size, 2);
  assert.equal(m.get('gone.js').changed.LEFT.get(2), 'y');
  assert.equal(m.get('gone.js').RIGHT.size, 0);
});

test('does not call the GitHub diff API when the local diff is complete', async (t) => {
  const s = setup(t);
  await post(s);
  assert.equal(s.calls.list, 0);
  assert.equal(s.calls.review[0].comments.length, 1);
});

test('falls back to the API for a partial diff and survives its failure', async (t) => {
  const s = setup(t, report(), { listError: true });
  process.env.PARTIAL = 'true';
  fs.writeFileSync(path.join(s.dir, 'ctx/files.txt'), 'src.js\nother.js\n');
  await post(s);
  assert.equal(s.calls.list, 1);
  assert.equal(s.calls.review[0].comments.length, 1);
  assert.match(s.calls.summary[0].body, /GitHub diff API unavailable; anchored with the local diff only/);
});

test('a missing local diff uses the API, and its failure never throws', async (t) => {
  const ok = setup(t);
  fs.unlinkSync(path.join(ok.dir, 'ctx/diff.patch'));
  await post(ok);
  assert.equal(ok.calls.list, 1);
  assert.equal(ok.calls.review[0].comments.length, 1);
  const bad = setup(t, report(), { listError: true });
  fs.unlinkSync(path.join(bad.dir, 'ctx/diff.patch'));
  await post(bad);
  assert.equal(bad.warnings.length, 0);
  assert.match(bad.calls.summary[0].body, /GitHub diff API unavailable/);
});

test('a missing_test and a pushdown on one line are different obligations and both survive', async (t) => {
  const pd = { ...evidence, layer: 'integration' };
  const data = () => report({
    coverage: [row('higher_level_only', { id: 'O1', obligation: 'True branch', evidence: [pd] }), row('missing_test', { id: 'O2', obligation: 'False branch' })],
    findings: [finding('pushdown', { obligation_ids: ['O1'] }), finding('missing_test', { obligation_ids: ['O2'], title: 'Test the false branch' })],
  });
  const d = data();
  assert.equal(post.validate(d).ok, true);
  assert.deepEqual(d.coverage.map((c) => c.status), ['higher_level_only', 'missing_test']);
  assert.deepEqual(d.findings.map((f) => f.obligation_ids[0]), ['O1', 'O2']);
  assert.deepEqual(d.validation_notes, []);
  const s = setup(t, data());
  await post(s);
  assert.equal(s.calls.review[0].comments.length, 2);
  assert.ok(s.calls.review[0].comments.some((c) => /Test the false branch/.test(c.body) && /kind: missing_test/.test(c.body)));
});

test('merges same-kind findings on one line into one comment; other kinds stay separate', async (t) => {
  const second = finding('missing_test', { title: 'Second obligation', body: 'Other gap.', obligation_ids: ['O2'] });
  const data = () => report({ coverage: [row('missing_test'), row('missing_test', { id: 'O2' })], findings: [finding('missing_test', { source: 'issue #1 AC 1' }), { ...second, source: 'issue #1 AC 2' }] });
  const s = setup(t, data());
  await post(s);
  const cs = s.calls.review[0].comments;
  assert.equal(cs.length, 1);
  assert.match(cs[0].body, /Verify the boundary total; Second obligation/);
  assert.match(cs[0].body, /Other gap\./);
  const fp = /specguard:fp=([0-9a-f]{40})/.exec(cs[0].body)[1];
  const again = setup(t, data(), { existing: [{ body: `<!-- specguard:fp=${fp} -->`, user: { type: 'Bot' } }] });
  await post(again);
  assert.equal(again.calls.review.length, 0);
  const std = { ...finding('standard', { title: 'Rule', rule_source: 'RULES.md:1', rule_quote: 'rule one' }) };
  assert.equal(post.merge([finding(), std]).length, 2);
  assert.equal(post.merge([finding(), finding('missing_test', { title: 'Other', obligation_ids: ['O2'] })]).length, 1);
});

test('a high and a low finding on one line never merge: the low one goes to the summary only', async (t) => {
  const low = finding('missing_test', { title: 'Second obligation', confidence: 'low', body: 'Other gap.', obligation_ids: ['O2'] });
  assert.deepEqual(post.merge([finding(), low]).map((f) => f.confidence).sort(), ['high', 'low']);
  const s = setup(t, report({ coverage: [row('missing_test'), row('missing_test', { id: 'O2' })], findings: [finding(), low] }));
  await post(s);
  const cs = s.calls.review[0].comments;
  assert.equal(cs.length, 1);
  assert.match(cs[0].body, /confidence: high/);
  assert.doesNotMatch(cs[0].body, /Second obligation/);
  assert.match(s.calls.summary[0].body, /Second obligation[^]*low confidence/);
});

test('distinct same-line gaps without an AC source are merged, not dropped; reruns skip the merged comment', async (t) => {
  const row3 = row('missing_test', { id: 'O3', behaviour: { path: 'src.js', line: 2, quote: 'l2' }, change: { path: 'src.js', line: 2, quote: 'l2' } });
  const data = () => report({
    coverage: [row('missing_test'), row('missing_test', { id: 'O2' }), row3],
    findings: [finding(), finding('missing_test', { title: 'Second obligation', body: 'Other gap.', obligation_ids: ['O2'] }),
      finding('missing_test', { title: 'Other line', obligation_ids: ['O3'], line: 2, quote: 'l2' })],
  });
  const s = setup(t, data());
  await post(s);
  const cs = s.calls.review[0].comments;
  assert.equal(cs.length, 2);
  const merged = cs.find((c) => c.line === 3);
  assert.match(merged.body, /Verify the boundary total; Second obligation/);
  assert.match(merged.body, /Other gap./);
  assert.ok(cs.some((c) => c.line === 2 && /Other line/.test(c.body)));
  const fp = /specguard:fp=([0-9a-f]{40})/.exec(merged.body)[1];
  const again = setup(t, data(), { existing: [{ body: `<!-- specguard:fp=${fp} -->`, user: { type: 'Bot' } }] });
  await post(again);
  assert.deepEqual(again.calls.review[0].comments.map((c) => c.line), [2]);
});

test('parseDiff decodes Git C-quoted paths', () => {
  const q = (p) => '"' + p + '"';
  const two = (p) => ['--- ' + q('a/' + p), '+++ ' + q('b/' + p)].join('\n');
  const d = fileDiff('x', patch, two('\\344\\270\\255.js')) + fileDiff('y', patch, two('q\\"t\\tab.js'));
  assert.deepEqual([...post.parseDiff(d).keys()], ['中.js', 'q"t\tab.js']);
});

test('calls listFiles for a reviewable file missing from the local diff and uses its patch', async (t) => {
  const data = report({ coverage: [row('missing_test', { behaviour: { ...behaviour, path: 'extra.js' }, change: { ...behaviour, path: 'extra.js' } })], findings: [finding('missing_test', { path: 'extra.js' })] });
  const s = setup(t, data, { listed: [{ filename: 'extra.js', patch }] });
  fs.writeFileSync(path.join(s.dir, 'extra.js'), fs.readFileSync(path.join(s.dir, 'src.js')));
  track(s, 'extra.js');
  fs.writeFileSync(path.join(s.dir, 'ctx/files.txt'), 'src.js\nextra.js\n');
  await post(s);
  assert.equal(s.calls.list, 1);
  assert.deepEqual(s.calls.review[0].comments.map((c) => c.path), ['extra.js']);
});

// Review-candidate regressions.
const withStatus = (s, value) => { const f = path.join(s.dir, 'ctx', 'requirements-status.json'); value === null ? fs.rmSync(f) : fs.writeFileSync(f, JSON.stringify(value)); };

test('c1: a model-added requirement cited as "PR body AC 3" resolves to the collected document and keeps its findings', () => {
  const d = report({ requirements: [{ id: 'X1', source: 'PR body AC 3', quote: 'Return 42.', obligation_ids: ['O1'], reason: 'Added.' }] });
  post.verifyRequirements(d, { documents: [{ source: 'PR body', text: 'Return 42.' }], criteria: [] });
  assert.deepEqual(d.requirements[0].obligation_ids, ['O1']);
  assert.equal(d.findings.length, 1);
  const bad = report({ requirements: [{ id: 'X1', source: 'PR body AC 3', quote: 'Invented.', obligation_ids: ['O1'], reason: 'Added.' }] });
  post.verifyRequirements(bad, { documents: [{ source: 'PR body', text: 'Return 42.' }], criteria: [] });
  assert.deepEqual(bad.requirements[0].obligation_ids, []);
  assert.equal(bad.findings.length, 0);
});

test('c2: findings with a suggestion or a start_line are never merged', () => {
  const a = finding('standard', { suggestion: 'a()', start_line: 2 }), b = finding('standard', { title: 'B', suggestion: 'b()', start_line: 1 });
  assert.equal(post.merge([a, b]).length, 2);
  assert.equal(post.merge([a, finding('standard', { title: 'C' })]).length, 2);
  assert.equal(post.merge([finding('standard', { title: 'C' }), finding('standard', { title: 'D' })]).length, 1);
});

test('c4: merge standards ref needs mergeable === true', async (t) => {
  const s = setup(t, report(), { pr: { mergeable: false, merge_commit_sha: 'STALE' } });
  process.env.STANDARDS_REF = 'merge';
  await post(s);
  assert.match(s.calls.summary[0].body, /Standards tooling: unavailable/);
  assert.match(s.calls.summary[0].body, /PR has no current test-merge commit/);
});

test('c5: missing requirements status still verifies; an invented quote is never shown as verified and findings survive', async (t) => {
  const reqs = [{ id: 'X1', source: 'issue #1', quote: 'Invented wording.', obligation_ids: ['O1'], reason: 'Added.' }];
  const s = setup(t, report({ requirements: reqs }));
  withStatus(s, null);
  await post(s);
  assert.equal(s.calls.review[0].comments.length, 1);
  assert.match(s.calls.summary[0].body, /X1[^\n]*NOT ASSESSED/);
  assert.match(s.calls.summary[0].body, /Requirement X1 is not assessed/);
  assert.match(s.calls.summary[0].body, /Requirement collection status unavailable/);
  const ok = setup(t, report({ requirements: [{ ...reqs[0], source: 'RULES.md', quote: 'rule one' }] }));
  fs.writeFileSync(path.join(ok.dir, 'ctx', 'requirements-status.json'), '{bad');
  await post(ok);
  assert.doesNotMatch(ok.calls.summary[0].body, /X1[^\n]*NOT ASSESSED/);
});

test('c6: summary items outside the diff show the snapped line', async (t) => {
  const s = setup(t, report({ coverage: [row('weak_test')], findings: [finding('weak_test', { ...evidence, line: 3 })] }));
  await post(s);
  assert.match(s.calls.summary[0].body, /`test\.js:2`/);
});

test('c7: the summary status counts reflect failed posts', async (t) => {
  const s = setup(t, report(), { retry422: true });
  await post(s);
  assert.match(s.calls.review[0].body, /1 inline, 0 file-level/);
  assert.match(s.calls.summary[0].body, /Reviewed: [^\n]*0 inline, 0 file-level, 1 in summary/);
});

test('c8: a failing pulls.get does not abort publishing, and notes that HEAD was not rechecked', async (t) => {
  const s = setup(t);
  s.github.rest.pulls.get = async () => { throw new Error('502'); };
  await post(s);
  assert.equal(s.calls.review.length, 1);
  assert.match(s.calls.summary[0].body, /could not be rechecked/);
  const k = setup(t);
  k.github.rest.pulls.get = async () => { throw new Error('502'); };
  process.env.SKIP = 'true';
  await post(k);
  assert.equal(k.calls.summary.length, 1);
});

test('c9: a merged title is cut on one line with an ellipsis', () => {
  const [m] = post.merge([finding('missing_test', { title: 'a'.repeat(150) }), finding('missing_test', { title: 'b'.repeat(150), obligation_ids: ['O2'] })]);
  assert.doesNotMatch(m.title, /\n/);
  assert.ok(m.title.endsWith('…') && m.title.length <= 200);
});

test('r4: coverage citations snap +-5 lines to the quote; a missing quote or an unchanged change line stays unknown', () => {
  const read = (p) => ({ 'src.js': ['l1', 'l2', behaviour.quote], 'test.js': ['test', evidence.quote] })[p];
  const run = (d) => post.verifyEvidence(d, new Set(['src.js']), new Set(['RULES.md']), read, new Map([['src.js', post.parsePatch(patch)]]));
  const d = run(report({ coverage: [row('covered', { behaviour: { ...behaviour, line: 4 }, change: { ...behaviour, line: 4 }, evidence: [{ ...evidence, line: 3 }] })], findings: [] }));
  assert.deepEqual([d.coverage[0].status, d.coverage[0].behaviour.line, d.coverage[0].change.line, d.coverage[0].evidence[0].line], ['covered', 3, 3, 2]);
  const far = run(report({ coverage: [row('covered', { behaviour: { ...behaviour, line: 30 }, change: { ...behaviour } })], findings: [] }));
  assert.equal(far.coverage[0].status, 'unknown');
  const ctxLine = run(report({ coverage: [row('weak_test', { change: { path: 'src.js', line: 2, quote: 'l1' } })], findings: [finding('weak_test')] }));
  assert.equal(ctxLine.coverage[0].status, 'unknown');
  assert.equal(ctxLine.findings.length, 0);
});

test('s2: the summary names rule or agent-config files the PR modified and says they were not reviewed', async (t) => {
  const s = setup(t, report({ coverage: [row()], findings: [] }));
  fs.writeFileSync(path.join(s.dir, 'ctx/rule-changes.txt'), 'pkg/REVIEW.md\n.claude/settings.json\n');
  await post(s);
  assert.match(s.calls.summary[0].body, /modifies review rule or agent-config files \(pkg\/REVIEW\.md, \.claude\/settings\.json\); they were not reviewed, and the base versions were applied/);
});

// ---- WP3: requirement <-> code traceability contract ----
const SPEC_Q = 'Claims must be filed within 30 days.';
const sreq = (extra = {}) => ({ id: 'G1', source: 'docs/spec.md', ref: 'AC-4', quote: SPEC_Q, obligation_ids: ['O1'], reason: 'Governs the filing window.', ...extra });
const MM = (since = 'introduced') => ({ status: 'mismatch', since, reason: 'Requirement says 30 days; code allows 45.' });
const specFinding = (extra = {}) => finding('spec_mismatch', { title: 'Code contradicts AC-4', body: 'docs/spec.md:1 says 30 days.', ...extra });
const mismatchReport = (since = 'introduced', extra = {}) => report({ requirements: [sreq()], coverage: [row('missing_test', { alignment: MM(since) })], findings: [specFinding()], ...extra });
const noted = (d, re) => assert.ok(d.validation_notes.some((n) => re.test(n)), d.validation_notes.join('|'));

test('schema requires coverage alignment, spec_mismatch, and optional requirement fields', () => {
  const schema = JSON.parse(fs.readFileSync(path.join(__dirname, 'findings.schema.json'), 'utf8')).properties;
  const cov = schema.coverage.items;
  assert.ok(cov.required.includes('alignment'));
  assert.deepEqual(cov.properties.alignment.properties.status.enum, ['consistent', 'mismatch', 'impacted', 'not_verifiable', 'not_applicable', 'unknown']);
  assert.deepEqual(cov.properties.alignment.properties.since.enum, ['introduced', 'pre_existing']);
  assert.deepEqual(cov.properties.alignment.then.required, ['since']);
  assert.ok(schema.findings.items.properties.kind.enum.includes('spec_mismatch'));
  assert.ok(!schema.requirements.items.required.some((k) => ['ref', 'line', 'pr_quote'].includes(k)));
  for (const k of ['ref', 'line', 'pr_quote']) assert.ok(schema.requirements.items.properties[k]);
});

test('an old report without coverage alignment is rejected as incomplete', () => {
  const old = report();
  delete old.coverage[0].alignment;
  const r = post.validate(old);
  assert.equal(r.ok, false);
  assert.match(r.error, /alignment is required/);
});

test('alignment degrades to unknown unless its evidence rules hold', () => {
  const run = (alignment, o = {}) => {
    const d = report({ requirements: o.noReq ? [] : [sreq()], coverage: [row('unknown', { alignment, ...(o.row || {}) })], findings: [] });
    assert.equal(post.validate(d).ok, true);
    return d.coverage[0].alignment.status;
  };
  assert.equal(run(OK), 'consistent');
  assert.equal(run(OK, { noReq: true }), 'unknown');
  assert.equal(run(OK, { row: { behaviour: null } }), 'unknown');
  assert.equal(run({ status: 'impacted', reason: 'r' }), 'unknown'); // since is required
  assert.equal(run({ status: 'impacted', since: 'introduced', reason: 'Governed behaviour changed.' }), 'impacted');
  assert.equal(run({ status: 'not_verifiable', reason: 'Searched code, config and migrations.' }), 'not_verifiable');
  assert.equal(run({ status: 'not_verifiable', reason: 'Searched code, config and migrations.' }, { noReq: true }), 'unknown');
  assert.equal(run({ status: 'not_verifiable', reason: '  ' }), 'unknown');
  assert.equal(run(NA, { noReq: true }), 'not_applicable');
  assert.equal(run(NA), 'unknown'); // not_applicable with a linked requirement
  assert.equal(run({ status: 'bogus', reason: 'r' }), 'unknown');
  assert.equal(run({ status: 'consistent' }), 'unknown');
  assert.equal(run({ ...OK, since: 'sometime' }), 'unknown');
});

test('a mismatch row pairs with exactly one spec_mismatch finding and replaces the missing/weak finding', () => {
  let d = mismatchReport();
  assert.equal(post.validate(d).ok, true);
  assert.deepEqual([d.coverage[0].alignment.status, d.findings.map((f) => f.kind)], ['mismatch', ['spec_mismatch']]);
  d = mismatchReport('introduced', { findings: [specFinding(), finding('missing_test')] });
  post.validate(d);
  assert.deepEqual([d.coverage[0].alignment.status, d.findings.map((f) => f.kind)], ['mismatch', ['spec_mismatch']]); // no double comment
  d = mismatchReport('introduced', { findings: [] });
  post.validate(d);
  assert.equal(d.coverage[0].alignment.status, 'unknown'); noted(d, /needs exactly one spec_mismatch/);
  d = mismatchReport('introduced', { findings: [specFinding(), specFinding({ title: 'Again' })] });
  post.validate(d);
  assert.deepEqual([d.coverage[0].alignment.status, d.findings.length], ['unknown', 0]);
  d = report({ requirements: [sreq({ obligation_ids: ['O1', 'O2'] })], coverage: [row('missing_test', { alignment: MM() }), row('missing_test', { id: 'O2', alignment: MM() })], findings: [specFinding({ obligation_ids: ['O1', 'O2'] })] });
  post.validate(d);
  assert.equal(d.findings.length, 0); noted(d, /spec_mismatch needs exactly one obligation/);
  d = report({ requirements: [sreq()], coverage: [row('missing_test', { alignment: OK })], findings: [specFinding(), finding()] });
  post.validate(d);
  assert.deepEqual(d.findings.map((f) => f.kind), ['missing_test']); // a spec_mismatch needs a mismatch row
});

test('a mismatch row can never be covered: a test of the contradicting value is the wrong oracle', () => {
  const d = mismatchReport('introduced', { coverage: [row('covered', { alignment: MM() })] });
  assert.equal(post.validate(d).ok, true);
  assert.equal(d.coverage[0].alignment.status, 'mismatch');
  assert.equal(d.coverage[0].status, 'needs_human');
  assert.match(d.coverage[0].reason, /cannot be covered/);
  assert.equal(post.noGaps(d), false);
});

test('mismatch and unknown alignment are gaps, never a clean review', () => {
  const clean = report({ requirements: [sreq()], coverage: [row('covered', { alignment: OK })], findings: [] });
  assert.equal(post.noGaps(clean), true);
  for (const a of [MM(), { status: 'unknown', reason: 'r' }]) assert.equal(post.noGaps({ ...clean, coverage: [row('covered', { alignment: a })] }), false);
  assert.equal(post.noGaps({ ...clean, coverage: [row('covered', { alignment: { status: 'not_verifiable', reason: 'r' } })] }), true);
});

test('validate keeps optional requirement ref, line and pr_quote', () => {
  const d = report({ requirements: [sreq({ line: 7, pr_quote: 'Raise the window.' }), sreq({ id: 'G2', ref: '', line: 0, pr_quote: null }), sreq({ id: 'G3', pr_quote: 5 })], coverage: [row('missing_test', { alignment: MM() })], findings: [specFinding()] });
  post.validate(d);
  assert.deepEqual([d.requirements[0].ref, d.requirements[0].line, d.requirements[0].pr_quote], ['AC-4', 7, 'Raise the window.']);
  assert.deepEqual([d.requirements[1].ref, d.requirements[1].line, d.requirements[1].pr_quote], [undefined, undefined, null]);
  assert.equal('pr_quote' in d.requirements[2], false);
});

const specLines = ['# Claims', '', 'AC-4: Claims must be filed', '  within 30 days.', 'AC-5: other'];
const specRead = (p) => ({ 'docs/spec.md': specLines, 'src/code.js': ['// ' + SPEC_Q] })[p] || null;

test('spec path allow-list: a requirement citing a file outside spec-files.txt is unlinked', () => {
  const build = (source) => mismatchReport('introduced', { requirements: [sreq({ source })] });
  let d = build('src/code.js');
  post.validate(d);
  post.verifyRequirements(d, { documents: [], criteria: [], specFiles: ['docs/spec.md'] }, specRead);
  assert.deepEqual(d.requirements[0].obligation_ids, []);
  assert.equal(d.coverage[0].status, 'unknown');
  assert.equal(d.coverage[0].alignment.status, 'unknown');
  assert.deepEqual(d.findings, []);
  assert.match(d.requirements[0].reason, /not a collected requirement document/);
  assert.match(d.not_reviewed, /Requirement G1 is not assessed/);
  d = build('src/code.js'); // no allow-list (older collector): unchanged behaviour
  post.validate(d);
  post.verifyRequirements(d, { documents: [], criteria: [] }, specRead);
  assert.deepEqual(d.requirements[0].obligation_ids, ['O1']);
  d = build('docs/spec.md');
  post.validate(d);
  post.verifyRequirements(d, { documents: [], criteria: [], specFiles: ['docs/spec.md'] }, specRead);
  assert.deepEqual(d.requirements[0].obligation_ids, ['O1']);
  assert.equal(d.coverage[0].alignment.status, 'mismatch');
  d = build('PR body'); // labels are not paths: the allow-list never applies
  post.validate(d);
  post.verifyRequirements(d, { documents: [{ source: 'PR body', text: SPEC_Q }], criteria: [], specFiles: [] }, specRead);
  assert.deepEqual(d.requirements[0].obligation_ids, ['O1']);
});

test('requirement quote is found in HEAD and its line re-derived; wrong lines and invented quotes do not survive', () => {
  assert.equal(post.quoteLine(specLines, SPEC_Q), 3);
  assert.equal(post.quoteLine(specLines, 'AC-5: other'), 5);
  assert.equal(post.quoteLine(specLines, 'nothing like it'), 0);
  assert.equal(post.quoteLine(specLines, ''), 0);
  const ctx = { documents: [], criteria: [], specFiles: ['docs/spec.md'] };
  const d = mismatchReport('introduced', { requirements: [sreq({ line: 99 })] });
  post.validate(d);
  post.verifyRequirements(d, ctx, specRead);
  assert.deepEqual([d.requirements[0].line, d.requirements[0].obligation_ids], [3, ['O1']]);
  const bad = mismatchReport('introduced', { requirements: [sreq({ quote: 'Claims may be filed any time.' })] });
  post.validate(bad);
  post.verifyRequirements(bad, ctx, specRead);
  assert.deepEqual([bad.requirements[0].obligation_ids, bad.coverage[0].alignment.status], [[], 'unknown']);
});

test('removed spec items verify against the "<path> (removed)" document, with the line re-derived', () => {
  const removed = { source: 'docs/spec.md (removed)', text: 'AC-9: Old rule.\nAC-4: Claims must be filed within 30 days.\n' };
  const ctx = { documents: [removed], criteria: [], specFiles: ['docs/spec.md'] };
  const d = mismatchReport('introduced', { requirements: [sreq({ source: 'docs/spec.md (removed)', line: 40 })] });
  post.validate(d);
  post.verifyRequirements(d, ctx, specRead);
  assert.deepEqual([d.requirements[0].obligation_ids, d.requirements[0].line], [['O1'], 2]);
  const invented = mismatchReport('introduced', { requirements: [sreq({ source: 'docs/spec.md (removed)', quote: 'AC-4: never existed' })] });
  post.validate(invented);
  post.verifyRequirements(invented, ctx, specRead);
  assert.deepEqual(invented.requirements[0].obligation_ids, []);
  const nodoc = mismatchReport('introduced', { requirements: [sreq({ source: 'docs/other.md (removed)' })] });
  post.validate(nodoc);
  post.verifyRequirements(nodoc, ctx, specRead);
  assert.deepEqual(nodoc.requirements[0].obligation_ids, []);
});

test('omitted spec (S) criteria are re-added as NOT ASSESSED; optional history (H) criteria are not', () => {
  const d = report({ requirements: [], coverage: [row()], findings: [] });
  const criteria = [
    { id: 'S1', source: 'docs/spec.md', ref: 'AC-4', line: 3, quote: SPEC_Q },
    { id: 'H1', source: 'history PR #3', quote: 'Old intent.', optional: true },
  ];
  post.verifyRequirements(d, { documents: [{ source: 'docs/spec.md', text: `# t

${SPEC_Q}` }, { source: 'history PR #3', text: 'Old intent.' }], criteria, specFiles: ['docs/spec.md'] });
  assert.deepEqual(d.requirements.map((r) => r.id), ['S1']);
  assert.deepEqual([d.requirements[0].ref, d.requirements[0].line, d.requirements[0].obligation_ids], ['AC-4', 3, []]);
  assert.match(post.buildSummary({ status: 'Reviewed', data: d }), /NOT ASSESSED/);
  // a model-supplied H criterion still verifies against its collected document
  const h = report({ requirements: [{ id: 'H1', source: 'history PR #3', quote: 'Old intent.', obligation_ids: ['O1'], reason: 'r' }], coverage: [row('unknown', { alignment: OK })], findings: [] });
  post.validate(h);
  post.verifyRequirements(h, { documents: [{ source: 'history PR #3', text: 'Old intent.' }], criteria: [criteria[1]] });
  assert.deepEqual(h.requirements[0].obligation_ids, ['O1']);
});

test('pr_quote is kept only when it is a verbatim sentence of the PR body', () => {
  const ctx = { documents: [{ source: 'PR body', text: 'Raise the cap to 3x. Tidy up.' }], criteria: [], specFiles: ['docs/spec.md'] };
  const keep = mismatchReport('introduced', { requirements: [sreq({ pr_quote: 'Raise the cap to 3x.' })] });
  post.validate(keep);
  post.verifyRequirements(keep, ctx, specRead);
  assert.equal(keep.requirements[0].pr_quote, 'Raise the cap to 3x.');
  const fake = mismatchReport('introduced', { requirements: [sreq({ pr_quote: 'Documented the change.' })] });
  post.validate(fake);
  post.verifyRequirements(fake, ctx, specRead);
  assert.equal(fake.requirements[0].pr_quote, null);
});

const dpatch = '@@ -1,3 +1,4 @@\n a\n-old\n+new\n+behaviour\n c\n@@ -20,2 +21,3 @@\n x\n+z\n y\n';
const spec2 = '@@ -3,1 +3,1 @@\n-AC-4: 45 days\n+AC-4: Claims must be filed within 30 days.\n';
const align = (since, o = {}) => {
  const d = report({
    requirements: [sreq({ line: 3, end: 4, ...(o.req || {}) })],
    coverage: [row('missing_test', { alignment: { status: o.status || 'mismatch', since, reason: 'Requirement says 30; code says 45.' }, behaviour: { path: 'code.js', line: 4, quote: 'behaviour' }, change: { path: o.changePath || 'code.js', line: o.changeLine || 3, quote: 'behaviour = new' } })],
    findings: [specFinding()],
  });
  post.validate(d);
  return d;
};
const dmaps = (extra = {}) => new Map(Object.entries({ 'code.js': post.parsePatch(dpatch), ...extra }));

test('differential: introduced is downgraded to pre_existing unless the PR changed the relation', () => {
  const since = (d, maps) => { post.differential(d, maps); return d.coverage[0].alignment.since; };
  // behaviour (code.js:4) is a changed RIGHT line: stays introduced
  assert.equal(since(align('introduced'), dmaps()), 'introduced');
  // behaviour untouched (context line 1 of hunk 0 is not changed) and the change is in a different hunk, spec not in the diff
  const far = (o = {}) => { const d = align(o.since || 'introduced', o); Object.assign(d.coverage[0], { behaviour: { path: 'code.js', line: 1, quote: 'a' }, change: { path: 'code.js', line: 22, quote: 'z' } }); return d; };
  assert.equal(since(far(), dmaps()), 'pre_existing');
  const downgraded = far(); post.differential(downgraded, dmaps());
  assert.match(downgraded.coverage[0].alignment.reason, /Downgraded to pre_existing/);
  // the change shares a hunk with the behaviour AND names something the behaviour line uses
  const same = far(); Object.assign(same.coverage[0], { behaviour: { path: 'code.js', line: 1, quote: 'use(behaviour)' }, change: { path: 'code.js', line: 3, quote: 'behaviour = new' } });
  assert.equal(since(same, dmaps()), 'introduced');
  // ... but an unrelated edit in the same hunk does not make old drift the PR's doing
  const unrelated = far(); unrelated.coverage[0].change = { path: 'code.js', line: 3, quote: 'console.log(1)' };
  assert.equal(since(unrelated, dmaps()), 'pre_existing');
  // the requirement item lines intersect the diff (RIGHT) or are a removed item
  assert.equal(since(far(), dmaps({ 'docs/spec.md': post.parsePatch(spec2) })), 'introduced');
  const left = far({ req: { line: 3, end: 3 } });
  assert.equal(since(left, dmaps({ 'docs/spec.md': post.parsePatch('@@ -3,1 +9,1 @@\n-AC-4: old\n+other\n') })), 'introduced'); // LEFT line 3 intersects too
  const rem = far({ req: { source: 'docs/spec.md (removed)' } });
  assert.equal(since(rem, dmaps()), 'introduced');
  // an untouched pre_existing row and not-mismatch rows are left alone; impacted is also downgraded
  assert.equal(since(far({ since: 'pre_existing' }), dmaps()), 'pre_existing');
  const imp = far(); imp.coverage[0].alignment = { status: 'impacted', since: 'introduced', reason: 'r' };
  assert.equal(since(imp, dmaps()), 'pre_existing');
  const ok = far(); ok.coverage[0].alignment = { ...OK };
  assert.equal(since(ok, dmaps()), undefined);
});

test('differential: a modified line far from the unchanged behaviour keeps introduced; an add-only hunk does not', () => {
  const run = (patch, line, quote = 'CAP_LIMIT = 3') => {
    const d = align('introduced');
    Object.assign(d.coverage[0], { behaviour: { path: 'code.js', line: 9, quote: 'return Math.min(raw, CAP_LIMIT)' }, change: { path: 'code.js', line, quote } });
    post.differential(d, new Map([['code.js', post.parsePatch(patch)]]));
    return d.coverage[0].alignment.since;
  };
  // constant modified on line 1 (-/+), the use on line 9 is untouched and outside the hunk
  assert.equal(run('@@ -1,3 +1,3 @@\n-CAP = 2\n+CAP = 3\n a\n b\n', 1), 'introduced');
  // only a logging line added: the drift pre-dated the PR
  assert.equal(run('@@ -1,3 +1,4 @@\n a\n+console.log(1)\n b\n c\n', 2, 'console.log(1)'), 'pre_existing');
  // a modified line that does not touch anything the behaviour uses (a reworded message): still pre-existing
  assert.equal(run('@@ -1,3 +1,3 @@\n-throw new Error("old")\n+throw new Error("new")\n a\n b\n', 1, 'throw new Error("new")'), 'pre_existing');
});

test('renameMaps reads renames with git diff -M so a moved file is not wholly "changed"', () => {
  const calls = [];
  const git = (...a) => {
    calls.push(a);
    if (a.includes('--name-status')) return 'R095\0old/spec.md\0docs/spec.md\0M\0code.js\0R100\0a.md\0b.md\0';
    return a.at(-1) === 'docs/spec.md' ? 'diff --git a/old/spec.md b/docs/spec.md\nsimilarity index 95%\n--- a/old/spec.md\n+++ b/docs/spec.md\n@@ -2,1 +2,1 @@\n-x\n+y\n' : '';
  };
  const m = post.renameMaps('base', 'head', '.', git);
  assert.deepEqual([...m.keys()], ['docs/spec.md', 'b.md']);
  assert.deepEqual([...m.get('docs/spec.md').changed.RIGHT.keys()], [2]);
  assert.equal(m.get('b.md').changed.RIGHT.size, 0); // pure rename: nothing changed
  assert.ok(calls.every((a) => a.includes('-M')));
  assert.equal(post.renameMaps('base', 'head', '.', () => { throw new Error('no git'); }).size, 0);
});

test('reflected_in reports whether the spec, the tests and the PR description were updated', () => {
  const d = report({
    requirements: [sreq({ line: 3, end: 3, pr_quote: 'Raise the cap.' }), sreq({ id: 'G2', source: 'PR body', obligation_ids: ['O2'] }), sreq({ id: 'G3', obligation_ids: ['O3'] })],
    coverage: [row('missing_test', { alignment: MM(), evidence: [] }), row('covered', { id: 'O2', alignment: NA }), row('covered', { id: 'O3', alignment: { status: 'not_verifiable', reason: 'r' } })],
  });
  d.coverage[0].evidence = [{ ...evidence, path: 'a.test.js' }];
  const maps = new Map([['docs/spec.md', post.parsePatch(spec2)]]);
  post.reflect(d, maps, new Set(['a.test.js']));
  assert.deepEqual(d.requirements[0].reflected_in, { spec: true, tests: true, pr: true });
  assert.equal(d.requirements[1].reflected_in, undefined); // not_applicable: not assessed
  assert.equal(d.requirements[2].reflected_in, undefined); // not_verifiable: not assessed
  post.reflect(d, new Map(), new Set());
  assert.deepEqual(d.requirements[0].reflected_in, { spec: false, tests: false, pr: true });
  d.requirements[0].pr_quote = null;
  post.reflect(d, new Map(), new Set());
  assert.equal(d.requirements[0].reflected_in.pr, false);
});

test('fingerprint keys spec sources on "path ref", never on the quote or line', () => {
  const f = (q, s) => post.fingerprint('spec_mismatch', 'code.js', q, s);
  assert.equal(f('a', 'docs/spec.md AC-4'), f('b', 'docs/spec.md AC-4'));
  assert.notEqual(f('a', 'docs/spec.md AC-4'), f('a', 'docs/spec.md AC-5'));
  assert.notEqual(f('a', 'PR body'), f('b', 'PR body'));
  assert.equal(post.axes([specFinding(), finding()]).endsWith('Spec: 1 mismatch'), true);
});

test('summary renders a Traceability table with HEAD permalinks and the no-documents line', () => {
  const d = mismatchReport('introduced', { requirements: [sreq({ line: 3, reflected_in: { spec: false, tests: false, pr: true } })] });
  d.coverage[0].change = { path: 'src.js', line: 3, quote: 'if (x) {' };
  d.coverage[0].evidence = [{ ...evidence }];
  d.coverage[0].status = 'weak_test';
  const blob = 'https://github.com/o/r/blob/HEADSHA';
  const s = post.buildSummary({ status: 'Reviewed', data: d, blob, specFiles: ['docs/spec.md'] });
  assert.match(s, /\*\*Traceability\*\*/);
  assert.ok(s.includes('| Requirement | Changed | Implementation | Tests | Alignment | Reflected in |'));
  assert.ok(s.includes(`[docs/spec.md AC-4](${blob}/docs/spec.md#L3)`));
  assert.ok(s.includes(`[src.js:3](${blob}/src.js#L3)`) && s.includes(`[test.js:2](${blob}/test.js#L2)`));
  assert.match(s, /mismatch \(introduced\): Requirement says 30 days/);
  assert.match(s, /spec ✗, tests ✗, PR ✓/);
  assert.doesNotMatch(s, /No requirement documents found/);
  assert.match(post.buildSummary({ status: 'Reviewed', data: d, specFiles: ['docs/spec.md'] }), /\| docs\/spec\.md AC-4 \|/); // no blob: plain text
  const none = post.buildSummary({ status: 'Reviewed', data: report({ coverage: [row()], findings: [] }), specFiles: [] });
  assert.match(none, /No requirement documents found \(content-based discovery; see `requirements_paths` to add or exclude\)\./);
  assert.doesNotMatch(none, /Traceability/);
  assert.doesNotMatch(post.buildSummary({ status: 'Reviewed', data: report({ coverage: [row()], findings: [] }) }), /No requirement documents found/);
  const removed = mismatchReport('introduced', { requirements: [sreq({ source: 'docs/spec.md (removed)' })] });
  assert.match(post.buildSummary({ status: 'Reviewed', data: removed, blob }), /docs\/spec\.md AC-4 \(removed\)/);
  const pre = post.buildSummary({ status: 'Reviewed', data: d, pre: [specFinding({ title: 'Old drift' })] });
  assert.match(pre, /### Pre-existing drift \(not caused by this PR\)\n\n- \*\*Old drift\*\*/);
});

function specSetup(t, since, o = {}) {
  const behaviourAt = o.behaviour || { path: 'src.js', line: 3, quote: 'if (x) {' };
  const data = report({
    requirements: [sreq({ line: 1, pr_quote: null })],
    coverage: [row(o.status || 'missing_test', { alignment: MM(since), behaviour: behaviourAt, change: 'change' in o ? o.change : { ...behaviour }, ...(o.status === 'unknown' && { evidence: [] }) })],
    findings: [specFinding(o.finding || {})],
  });
  const s = setup(t, data);
  fs.writeFileSync(path.join(s.dir, 'other.js'), 'limit = 3;\n');
  fs.mkdirSync(path.join(s.dir, 'docs'));
  fs.writeFileSync(path.join(s.dir, 'docs/spec.md'), `${SPEC_Q}\n`);
  fs.writeFileSync(path.join(s.dir, 'ctx/spec-files.txt'), 'docs/spec.md\n');
  track(s, 'other.js', 'docs/spec.md');
  return s;
}

test('end to end: an introduced spec_mismatch is posted inline and the summary shows traceability', async (t) => {
  const s = specSetup(t, 'introduced');
  await post(s);
  assert.equal(s.calls.review[0].comments.length, 1);
  assert.match(s.calls.review[0].comments[0].body, /Code contradicts AC-4/);
  assert.match(s.calls.review[0].comments[0].body, /kind: spec_mismatch/);
  const body = s.calls.summary[0].body;
  assert.ok(body.includes('https://github.com/o/r/blob/HEADSHA/docs/spec.md#L1'));
  assert.match(body, /Spec: 1 mismatch/);
  assert.doesNotMatch(body, /Pre-existing drift/);
  assert.doesNotMatch(body, /No test gaps found/);
});

test('end to end: pre-existing drift goes to its summary section, never inline', async (t) => {
  const s = specSetup(t, 'introduced', { behaviour: { path: 'other.js', line: 1, quote: 'limit = 3;' } });
  fs.writeFileSync(path.join(s.dir, 'ctx/diff.patch'), fileDiff('src.js', '@@ -1,2 +1,4 @@\n l1\n+l2\n+if (x) {\n l4\n')); // add-only hunk: nothing modified
  await post(s); // behaviour is untouched and in another file, and the spec is not in the diff: downgraded
  assert.equal(s.calls.review.length, 0);
  const body = s.calls.summary[0].body;
  assert.match(body, /### Pre-existing drift \(not caused by this PR\)/);
  assert.match(body, /Code contradicts AC-4/);
  assert.match(body, /pre_existing/);
});

test('end to end: a spec outside spec-files.txt cannot produce a spec_mismatch', async (t) => {
  const s = specSetup(t, 'introduced');
  fs.writeFileSync(path.join(s.dir, 'ctx/spec-files.txt'), 'docs/other.md\n');
  await post(s);
  assert.equal(s.calls.review.length, 0);
  assert.doesNotMatch(s.calls.summary[0].body, /Code contradicts AC-4/);
  assert.match(s.calls.summary[0].body, /not a collected requirement document|NOT ASSESSED/);
});

test('end to end: an empty spec-files.txt prints the no-documents line', async (t) => {
  const s = setup(t, report({ coverage: [row()], findings: [] }));
  fs.writeFileSync(path.join(s.dir, 'ctx/spec-files.txt'), '');
  await post(s);
  assert.match(s.calls.summary[0].body, /No requirement documents found/);
});

test('a mismatch row stated as unknown or covered is normalised to needs_human and keeps its inline spec_mismatch', async (t) => {
  for (const status of ['unknown', 'covered']) {
    const s = specSetup(t, 'introduced', { status });
    await post(s);
    assert.equal(s.calls.review[0].comments.length, 1, status);
    assert.match(s.calls.review[0].comments[0].body, /kind: spec_mismatch/);
    assert.doesNotMatch(s.calls.summary[0].body, /No test gaps found/);
  }
  const d = mismatchReport('introduced', { coverage: [row('covered', { alignment: MM() })] });
  assert.ok(post.validate(d).ok);
  assert.equal(d.coverage[0].status, 'needs_human');
  assert.equal(d.findings.length, 1);
  assert.equal(post.noGaps(d), false);
});

test('a pre_existing mismatch row with its spec_mismatch finding renders in the Pre-existing section, not inline', async (t) => {
  const at = { path: 'other.js', line: 1, quote: 'limit = 3;' }; // a pre_existing claim only stands when the PR did not touch the relation
  const s = specSetup(t, 'pre_existing', { behaviour: at, finding: at, change: null, status: 'needs_human' });
  await post(s);
  assert.equal(s.calls.review.length, 0);
  assert.match(s.calls.summary[0].body, /### Pre-existing drift \(not caused by this PR\)/);
  assert.match(s.calls.summary[0].body, /Code contradicts AC-4/);
});

test('an unverifiable citation still sets the row unknown and drops its spec_mismatch finding', async (t) => {
  const s = specSetup(t, 'introduced', { behaviour: { path: 'src.js', line: 3, quote: 'no such line' } });
  await post(s);
  assert.equal(s.calls.review.length, 0);
  assert.doesNotMatch(s.calls.summary[0].body, /Code contradicts AC-4/);
});

test('pre-existing drift with no changed line: change null + needs_human + a finding on an unchanged line renders in the Pre-existing section', async (t) => {
  const at = { path: 'other.js', line: 1, quote: 'limit = 3;' };
  const data = report({
    requirements: [sreq({ line: 1, pr_quote: null })],
    coverage: [row('needs_human', { alignment: MM('pre_existing'), behaviour: at, change: null, evidence: [] })],
    findings: [specFinding({ ...at })],
  });
  const s = setup(t, data);
  fs.writeFileSync(path.join(s.dir, 'other.js'), 'limit = 3;\n');
  fs.mkdirSync(path.join(s.dir, 'docs'));
  fs.writeFileSync(path.join(s.dir, 'docs/spec.md'), `${SPEC_Q}\n`);
  fs.writeFileSync(path.join(s.dir, 'ctx/spec-files.txt'), 'docs/spec.md\n');
  track(s, 'other.js', 'docs/spec.md');
  await post(s);
  assert.equal(s.calls.review.length, 0);
  assert.match(s.calls.summary[0].body, /### Pre-existing drift \(not caused by this PR\)/);
  assert.match(s.calls.summary[0].body, /Code contradicts AC-4/);
});

test('CRLF and lone CR: parsePatch, readFile, snap, quoteLine and the requirement quote checks match LF', (t) => {
  const lfPatch = '@@ -1,2 +1,3 @@\n keep\n-old 30\n+new 45\n+added\n';
  const crPatch = lfPatch.replace(/\n/g, '\r\n');
  assert.deepEqual(post.parsePatch(crPatch), post.parsePatch(lfPatch));
  assert.equal(post.parsePatch(crPatch).changed.RIGHT.get(2), 'new 45');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'specguard-post-crlf-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'a.md'), 'one\r\nAC-4: late after 45 days\r\n\r\nthree\rfour\n');
  const old = process.env.GITHUB_WORKSPACE; process.env.GITHUB_WORKSPACE = dir;
  t.after(() => { if (old === undefined) delete process.env.GITHUB_WORKSPACE; else process.env.GITHUB_WORKSPACE = old; });
  const lines = post.readFile('a.md');
  assert.deepEqual(lines.slice(0, 3), ['one', 'AC-4: late after 45 days', '']);
  assert.equal(post.snap({ line: 2, quote: 'AC-4: late after 45 days' }, lines), 0);
  assert.equal(post.snap({ line: 2, quote: 'AC-4: late after 45 days\r' }, ['x', 'AC-4: late after 45 days\r']), 0); // CRLF lines read some other way
  assert.equal(post.quoteLine(lines, 'AC-4: late after 45 days'), 2);
  assert.equal(post.quoteLine(['x\r', 'AC-4: late\r', 'after 45 days\r'], 'AC-4: late\nafter 45 days'), 2);
  assert.equal(post.quoteLine(lines, 'three four'), 4); // a lone CR is whitespace
  const mk = (source, quote) => ({ requirements: [{ id: 'Q1', source, quote, obligation_ids: ['O1'], reason: 'r' }],
    coverage: [{ id: 'O1', status: 'needs_human', reason: 'r', alignment: { status: 'unknown', reason: 'r' }, evidence: [], behaviour: null, change: null }], findings: [] });
  for (const [doc, q] of [['AC-4: late\r\nafter 45 days\r\n', 'AC-4: late\nafter 45 days'], ['AC-4: late\nafter 45 days\n', 'AC-4: late\r\nafter 45 days'], ['AC-4: late\rafter 45 days', 'AC-4: late after 45 days']]) {
    const d = post.verifyRequirements(mk('PR body', q), { documents: [{ source: 'PR body', text: doc }], criteria: [{ id: 'Q1', source: 'PR body', quote: q }] });
    assert.deepEqual(d.requirements[0].obligation_ids, ['O1'], JSON.stringify([doc, q]));
  }
  const d = post.verifyRequirements(mk('a.md', 'AC-4: late after 45 days'), { specFiles: ['a.md'] }, post.readFile);
  assert.deepEqual([d.requirements[0].obligation_ids, d.requirements[0].line], [['O1'], 2]);
});

// ---- security hardening regressions (red team) ----
const B64 = 'eC1hY2Nlc3MtdG9rZW46Z2hzX0FBQUFBQUFBQUFBQUFBQUFBQUFBQUFB';
const EXTRAHEADER = `extraheader = AUTHORIZATION: basic ${B64}`;
const reqData = (source, quote, extra = {}) => ({
  requirements: [{ id: 'S1', source, quote, obligation_ids: ['O1'], reason: 'x', ...extra }],
  coverage: [{ id: 'O1', obligation: 'o', source: 's', behaviour: null, change: null, evidence: [], status: 'unknown', reason: 'r', alignment: { status: 'not_verifiable', reason: 'r' } }],
  findings: [], standards: { status: 'no_rules', sources: [], reason: 'r' }, layering: { status: 'checked', reason: 'r' }, requirements_source: '', not_reviewed: '',
});
// A workspace that is a real git repo whose .git/config holds a checkout credential.
function credentialWorkspace(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-cred-'));
  const prev = process.env.GITHUB_WORKSPACE;
  execFileSync('git', ['init', '-q'], { cwd: dir });
  fs.appendFileSync(path.join(dir, '.git', 'config'), `[http "https://github.com/"]\n\t${EXTRAHEADER}\n`);
  fs.writeFileSync(path.join(dir, 'a.md'), 'plain\n');
  process.env.GITHUB_WORKSPACE = dir;
  t.after(() => { if (prev === undefined) delete process.env.GITHUB_WORKSPACE; else process.env.GITHUB_WORKSPACE = prev; fs.rmSync(dir, { recursive: true, force: true }); });
  return dir;
}

test('F1: a requirement source that merely starts like a label cannot read .git/config into the summary', (t) => {
  credentialWorkspace(t);
  for (const src of ['history/../.git/config', 'issue/../.git/config', 'PR body/../.git/config', '.git/config', 'history PR #1/../.git/config']) {
    for (const ctx of [{ specFiles: ['docs/a.md'], documents: [] }, { documents: [] }, { specFiles: ['a', '.git/config', 'b.md'], documents: [] }]) {
      const d = reqData(src, EXTRAHEADER);
      post.verifyRequirements(d, ctx);
      assert.deepEqual(d.requirements[0].obligation_ids, [], `${src} ${JSON.stringify(ctx.specFiles)}`);
      assert.doesNotMatch(post.buildSummary({ status: 'x', data: d }), new RegExp(B64));
    }
  }
});

test('F1: paths with .. , absolute, backslash or control characters are rejected even if allow-listed; labels must be exact', (t) => {
  const dir = credentialWorkspace(t);
  for (const bad of ['../a.md', 'docs/../a.md', '/etc/passwd', 'C:/x.md', 'docs\\a.md', 'a.md\n', './/a.md', '']) assert.equal(post.safeRel(bad), null, JSON.stringify(bad));
  assert.equal(post.safeRel('./docs/a.md'), 'docs/a.md');
  assert.equal(post.readFile('.git/config'), null);
  assert.equal(post.readFile('.GIT/config'), null);
  assert.equal(post.readFile('a.md')[0], 'plain');
  fs.mkdirSync(path.join(dir, '.specguard-ctx'));
  fs.writeFileSync(path.join(dir, '.specguard-ctx/findings.json'), 'secret\n');
  assert.equal(post.readFile('.specguard-ctx/findings.json'), null);
  const prev = process.env.CTX;
  fs.mkdirSync(path.join(dir, 'myctx')); fs.writeFileSync(path.join(dir, 'myctx/x.txt'), 'secret\n');
  process.env.CTX = path.join(dir, 'myctx'); t.after(() => { if (prev === undefined) delete process.env.CTX; else process.env.CTX = prev; });
  assert.equal(post.readFile('myctx/x.txt'), null);
  // a label that was not collected verifies against nothing, not against a file of that name
  fs.writeFileSync(path.join(dir, 'issue #9'), 'The system must do it.\n');
  const d = reqData('issue #9', 'The system must do it.');
  post.verifyRequirements(d, { specFiles: [], documents: [] });
  assert.deepEqual(d.requirements[0].obligation_ids, []);
  const ok = reqData('issue #9', 'The system must do it.');
  post.verifyRequirements(ok, { documents: [{ source: 'issue #9', text: 'The system must do it.' }] });
  assert.deepEqual(ok.requirements[0].obligation_ids, ['O1']);
});

test('F1: behaviour or evidence citing .git/config is unverifiable', (t) => {
  credentialWorkspace(t);
  const d = reqData('PR body', 'q');
  d.coverage[0].behaviour = { path: '.git/config', line: 2, quote: EXTRAHEADER };
  d.coverage[0].status = 'needs_human';
  post.verifyEvidence(d, new Set(), new Set());
  assert.equal(d.coverage[0].status, 'unknown');
  assert.doesNotMatch(post.buildSummary({ status: 'x', data: d }), new RegExp(B64));
});

test('F1: evidence from an untracked workspace file is unverifiable; a tracked out-of-diff test file still verifies', async (t) => {
  const s = setup(t, report({ coverage: [row('covered', { evidence: [{ ...evidence, path: 'secret.txt', quote: 'token=abc' }] })], findings: [] }));
  fs.writeFileSync(path.join(s.dir, 'secret.txt'), 'x\ntoken=abc\n');
  await post(s);
  assert.match(s.calls.summary[0].body, /Unit evidence: 0\/1/);
  const ok = setup(t, report({ coverage: [row('covered')], findings: [] }));
  await post(ok); // test.js is tracked and not in the diff
  assert.match(ok.calls.summary[0].body, /Unit evidence: 1\/1/);
});

test('F1: redaction covers base64 AUTHORIZATION headers and extraheader lines', () => {
  assert.equal(post.redact(EXTRAHEADER), '[REDACTED]');
  assert.doesNotMatch(post.redact(`Authorization: Bearer abcdefgh12345678`), /abcdefgh/);
  assert.doesNotMatch(post.redact(`http.https://github.com/.extraheader=AUTHORIZATION: basic ${B64}`), new RegExp(B64));
});

test('F3b: trace-status failed/unavailable fails closed with a visible notice; ok keeps the list; absent status is the old collector', async (t) => {
  const withStatus2 = async (status, list) => {
    const s = setup(t, report({ requirements: [{ id: 'S1', source: 'docs/a.md', quote: 'The system must do it.', obligation_ids: ['O1'], reason: 'x' }], coverage: [row('covered', { source: 'docs/a.md R1' })], findings: [] }));
    fs.mkdirSync(path.join(s.dir, 'docs')); fs.writeFileSync(path.join(s.dir, 'docs/a.md'), 'The system must do it.\n'); track(s, 'docs/a.md');
    if (status !== null) fs.writeFileSync(path.join(s.dir, 'ctx/trace-status'), `${status}\n`);
    if (list !== null) fs.writeFileSync(path.join(s.dir, 'ctx/spec-files.txt'), list);
    await post(s);
    return s.calls.summary[0].body;
  };
  for (const st of ['failed', 'unavailable']) {
    const body = await withStatus2(st, 'docs/a.md\n'); // even a stale list is ignored
    assert.match(body, /Traceability unavailable for this PR \(/);
    assert.match(body, /not a collected requirement document/);
  }
  const ok = await withStatus2('ok', 'docs/a.md\n');
  assert.doesNotMatch(ok, /Traceability unavailable/);
  assert.doesNotMatch(ok, /not a collected requirement document/);
  assert.doesNotMatch(await withStatus2(null, null), /Traceability unavailable/); // old collector: no restriction
  assert.match(await withStatus2('ok', ''), /not a collected requirement document/); // empty list restricts
});

test('F4: rows whose requirement text this PR changed show the base text, a banner, and never count as clean', () => {
  const clean = (extra = {}) => ({ findings: [], validation_notes: [], coverage: [{ id: 'O1', obligation: 'o', source: 'docs/s.md R1', behaviour: { path: 'a.js', line: 1, quote: 'q' }, change: null, evidence: [], status: 'covered', reason: 'r', alignment: { status: 'consistent', reason: 'matches' } }],
    not_reviewed: '', standards: { status: 'checked', sources: ['x'], reason: 'r' }, layering: { status: 'checked', reason: 'r' }, tooling: { status: 'not_configured' },
    requirements: [{ id: 'S1', source: 'docs/s.md', ref: 'AC-1', quote: 'file within 45 days', obligation_ids: ['O1'], reason: 'r', line: 1, ...extra }], requirements_source: 'PR body' });
  const d = clean();
  assert.equal(post.noGaps(d), true);
  post.markChanged(d, { criteria: [{ id: 'S1', source: 'docs/s.md', change: 'modified', previous: 'file within 30 days' }], spec: { added: [] } });
  assert.equal(post.noGaps(d), false);
  const s = post.buildSummary({ status: 'x', data: d });
  assert.match(s, /Requirement text was changed by this PR: consistency with the changed text does not prove the change itself is approved/);
  assert.match(s, /Requirement changed in this PR — was: "file within 30 days"/);
  const authored = clean(); post.markChanged(authored, { criteria: [], spec: { added: ['docs/s.md'] } });
  assert.match(post.buildSummary({ status: 'x', data: authored }), /document authored in this PR/);
  assert.equal(post.noGaps(authored), false);
  const spec = clean({ reflected_in: { spec: true, tests: false, pr: false } });
  assert.equal(post.noGaps(spec), false); // even before markChanged: the spec item lines are in the diff
  post.markChanged(spec, null); // no criterion: the diff lines say it changed
  assert.equal(post.noGaps(spec), false);
  const same = clean(); post.markChanged(same, { criteria: [{ id: 'S9', source: 'other.md', change: 'modified' }], spec: { added: [] } });
  assert.equal(post.noGaps(same), true);
});

test('F4: end to end, a changed requirement is not announced as "No test gaps" and creates no finding', async (t) => {
  const s = setup(t, report({ requirements: [{ id: 'S1', source: 'docs/spec.md', quote: 'file within 45 days', obligation_ids: ['O1'], reason: 'x', ref: 'AC-1' }],
    coverage: [row('covered', { source: 'docs/spec.md AC-1', alignment: { status: 'consistent', reason: 'Spec says 45; code says 45.' } })], findings: [], not_reviewed: '' }));
  fs.mkdirSync(path.join(s.dir, 'docs')); fs.writeFileSync(path.join(s.dir, 'docs/spec.md'), 'AC-1: file within 45 days\n'); track(s, 'docs/spec.md');
  fs.writeFileSync(path.join(s.dir, 'ctx/spec-files.txt'), 'docs/spec.md\n');
  fs.writeFileSync(path.join(s.dir, 'ctx/requirements-status.json'), JSON.stringify({ status: 'available', sources: ['PR body'], limitations: [], documents: [], criteria: [{ id: 'S1', source: 'docs/spec.md', ref: 'AC-1', quote: 'file within 45 days', line: 1, change: 'modified', previous: 'file within 30 days' }] }));
  await post(s);
  const body = s.calls.summary[0].body;
  assert.doesNotMatch(body, /No test gaps found/);
  assert.match(body, /Requirement changed in this PR — review it/);
  assert.match(body, /was: "file within 30 days"/);
  assert.equal(s.calls.review.length, 0);
});

test('F5: a model-emitted pre_existing is upgraded to introduced when the PR touched the relation, with a note', () => {
  const mk = (since, line) => ({ coverage: [{ id: 'O1', obligation: 'o', source: 'docs/s.md R1', behaviour: { path: 'src/a.js', line, quote: 'const KEEP=90;' }, change: { path: 'src/a.js', line, quote: 'const KEEP=90;' }, evidence: [], status: 'needs_human', reason: 'r', alignment: { status: 'mismatch', since, reason: 'code keeps 90d, spec says 30d' } }],
    requirements: [{ id: 'S1', source: 'docs/s.md', quote: 'q', obligation_ids: ['O1'], reason: 'r', line: 3 }], findings: [] });
  const maps = post.parseDiff('diff --git a/src/a.js b/src/a.js\n--- a/src/a.js\n+++ b/src/a.js\n@@ -1 +1 @@\n-const KEEP=30;\n+const KEEP=90;\n');
  const forged = mk('pre_existing', 1);
  post.differential(forged, maps);
  assert.equal(forged.coverage[0].alignment.since, 'introduced');
  assert.match(forged.validation_notes.join(' '), /pre_existing claim overridden/);
  const honest = mk('pre_existing', 9); // an untouched line far from the diff
  post.differential(honest, maps);
  assert.equal(honest.coverage[0].alignment.since, 'pre_existing');
  assert.equal(honest.validation_notes, undefined);
});

test('F6: thousands of NOT ASSESSED rows keep the findings and the Traceability table, stay under the limit and end cleanly', () => {
  const reqs = Array.from({ length: 4540 }, (_, i) => ({ id: `S${i}`, source: 'docs/d.md', quote: `The system must do thing ${i} within 5 days.`, obligation_ids: [], reason: 'Structured acceptance criterion was not assessed.' }));
  const traced = { id: 'T1', source: 'docs/t.md', ref: 'AC-1', quote: 'traced', obligation_ids: ['O1'], reason: 'r', line: 1 };
  const f = { kind: 'spec_mismatch', path: 'src/a.js', line: 1, title: 'REAL FINDING', body: 'b', confidence: 'high', obligation_ids: [] };
  const cov = { id: 'O1', obligation: 'o', source: 'docs/t.md AC-1', behaviour: null, change: null, evidence: [], status: 'needs_human', reason: 'r', alignment: { status: 'consistent', reason: 'fine' } };
  const s = post.buildSummary({ status: 'x', data: { requirements_source: '', requirements: [traced, ...reqs], coverage: [cov], standards: { status: 'no_rules', sources: [], reason: 'r' }, layering: { status: 'checked', reason: 'r' } }, items: [{ f, why: 'not in a diff hunk' }], pre: [{ ...f, title: 'OLD DRIFT' }] });
  assert.ok(s.length <= 65536, `${s.length}`);
  assert.ok(s.indexOf('REAL FINDING') > 0 && s.indexOf('REAL FINDING') < s.indexOf('Traceability'), 'findings come before the Traceability table');
  assert.ok(s.indexOf('OLD DRIFT') < s.indexOf('Traceability'));
  assert.match(s, /\*\*Traceability\*\*/);
  assert.match(s, /\+\d+ more NOT ASSESSED criteria not shown/);
  assert.equal((s.match(/<details>/g) || []).length, (s.match(/<\/details>/g) || []).length);
  // a huge assessed table is cut on a row boundary with a visible marker, never mid-row
  const many = Array.from({ length: 3000 }, (_, i) => ({ id: `R${i}`, source: 'issue #1', quote: 'q'.repeat(400), obligation_ids: [`O${i}`], reason: 'r'.repeat(300) }));
  const big = post.buildSummary({ status: 'x', data: { requirements_source: '', requirements: many, coverage: [], standards: { status: 'no_rules', sources: [], reason: 'r' }, layering: { status: 'checked', reason: 'r' } } });
  assert.ok(big.length <= 65536);
  assert.match(big, /\(truncated/);
  assert.ok(big.split('\n').filter((l) => l.startsWith('| R')).every((l) => l.endsWith('|')));
});

test('F6: truncate never leaves half a surrogate pair; verifyRequirements indexes by id (thousands of criteria stay fast)', () => {
  const t1 = post.truncate('a'.repeat(64979) + '\u{1F600}' + 'b'.repeat(100));
  assert.doesNotMatch(t1.slice(0, t1.indexOf('\n...(trunc')), /[\uD800-\uDBFF]$/);
  const criteria = Array.from({ length: 6000 }, (_, i) => ({ id: `R${i}`, source: 'PR body', quote: `quote ${i}` }));
  const data = { requirements: [], coverage: [], findings: [], standards: {}, layering: {} };
  const t0 = Date.now();
  post.verifyRequirements(data, { criteria, documents: [{ source: 'PR body', text: criteria.map((c) => c.quote).join('\n') }] });
  assert.equal(data.requirements.length, 6000);
  assert.ok(Date.now() - t0 < 3000);
});

test('F7: only a single-line, markup-free suggestion for a single-line quote is one-click; the rest is plain text', () => {
  const std = (extra) => finding('standard', { quote: 'old();', ...extra });
  assert.match(post.commentBody(std({ suggestion: 'fixed();' }), 'abc'), /```suggestion\nfixed\(\);/);
  for (const bad of ['a();\nb();', 'x ```\n@@', '<img src=x onerror=1>', '@octocat run this', '![x](https://evil.example/b.png)', 'x'.repeat(301), 'a\u202Eb']) {
    const body = post.commentBody(std({ suggestion: bad }), 'abc');
    assert.doesNotMatch(body, /```suggestion/, bad);
    assert.match(body, /Suggested fix \(not applied automatically\)/);
  }
  assert.doesNotMatch(post.commentBody(std({ suggestion: 'fixed();', quote: 'a\nb' }), 'abc'), /```suggestion/); // multi-line quote
  assert.doesNotMatch(post.commentBody(std({ suggestion: 'fixed();', start_line: 1 }), 'abc'), /```suggestion/); // range
});

test('F7: the model ref is replaced by the collected criterion ref, otherwise sanitised and short', () => {
  const d = reqData('docs/s.md', 'quote', { ref: '[click](https://evil.example) @team <img src=x>' });
  const v = { ...d, requirements: d.requirements.map((r) => ({ ...r })) };
  post.validate(v);
  assert.doesNotMatch(v.requirements[0].ref, /<img|@team|\]\(/);
  assert.ok(v.requirements[0].ref.length <= 60);
  const e = reqData('docs/s.md', 'The system must hold.', { ref: 'FORGED-1' });
  post.verifyRequirements(e, { specFiles: ['docs/s.md'], criteria: [{ id: 'S1', source: 'docs/s.md', ref: 'AC-4', quote: 'The system must hold.' }], documents: [{ source: 'docs/s.md', text: 'AC-4: The system must hold.' }] });
  assert.equal(e.requirements[0].ref, 'AC-4');
});

test('F8: model- and document-derived text cannot inject markers, mentions, images, HTML or bidi characters', () => {
  const fake = `<!-- specguard:fp=${'a'.repeat(40)} -->`;
  const f = { kind: 'spec_mismatch', title: 'T @org/security-team', body: `${fake}\n![x](https://evil.example/b.png)\n@octocat ping\n\u202Egnp.exe <img src=https://e.example/p.gif> <!-- specguard:summary -->`, confidence: 'high', obligation_ids: ['O1'] };
  const body = post.commentBody(f, 'b'.repeat(40));
  assert.deepEqual(body.match(/specguard:fp=[0-9a-f]{40}/g), [`specguard:fp=${'b'.repeat(40)}`]);
  assert.ok(body.endsWith(`<!-- specguard:fp=${'b'.repeat(40)} -->`));
  assert.doesNotMatch(body, /!\[x\]|<img|specguard:summary|\u202E/);
  assert.doesNotMatch(body, /@org|@octocat/); // a zero-width space follows every @
  assert.match(body, /@\u200Borg\/security-team/);
  const row = post.buildSummary({ status: 's', data: { requirements_source: '', requirements: [{ id: 'S1', source: 'docs/s.md', quote: 'x | <img src=https://e.example/p.gif> @team <!-- ', obligation_ids: [], reason: 'r' }], coverage: [], standards: { status: 'no_rules', sources: [], reason: 'r' }, layering: { status: 'checked', reason: 'r' } } });
  assert.doesNotMatch(row, /<img|@team/);
  assert.equal(post.neutralize(post.neutralize('a @b <i> <!-- c --> \u202E')), post.neutralize('a @b <i> <!-- c --> \u202E')); // idempotent
});

test('F8: a fingerprint is honoured only as the last thing in a bot review comment; the sticky comment must be ours', async (t) => {
  const first = setup(t); await post(first);
  const fp = /specguard:fp=([0-9a-f]{40})/.exec(first.calls.review[0].comments[0].body)[1];
  const injected = setup(t, report(), { existing: [{ body: `<!-- specguard:fp=${fp} --> pasted into the middle of a bot comment`, user: { type: 'Bot' } }] });
  await post(injected);
  assert.equal(injected.calls.review.length, 1, 'a non-trailing marker does not suppress the finding');
  const real = setup(t, report(), { existing: [{ body: `text\n\n<!-- specguard:fp=${fp} -->`, user: { type: 'Bot' } }] });
  await post(real);
  assert.equal(real.calls.review.length, 0);
  const other = setup(t, report(), { issueComments: [{ id: 5, body: '<!-- specguard:summary -->\nhijack', user: { type: 'Bot', login: 'other-app[bot]' } }] });
  await post(other);
  assert.equal(other.calls.summary[0].comment_id, undefined, 'created a new comment instead of overwriting another bot');
  const quoted = setup(t, report(), { issueComments: [{ id: 6, body: 'quote: <!-- specguard:summary -->', user: { type: 'Bot', login: 'github-actions[bot]' } }] });
  await post(quoted);
  assert.equal(quoted.calls.summary[0].comment_id, undefined, 'the marker must start the body');
  const mine = setup(t, report(), { issueComments: [{ id: 7, body: '<!-- specguard:summary -->\nold', user: { type: 'Bot', login: 'github-actions[bot]' } }] });
  await post(mine);
  assert.equal(mine.calls.summary[0].comment_id, 7);
});

test('definesUsedBy links a changed line to the behaviour only when it defines a name the behaviour uses', () => {
  assert.deepEqual(post.definedNames('const CAP_LIMIT = 3;'), ['CAP_LIMIT']);
  assert.deepEqual(post.definedNames("  console.log('premium', base, riskFactor);"), []);
  assert.deepEqual(post.definedNames("    throw new Error('needs an order with a numeric subtotal');"), []);
  assert.deepEqual(post.definedNames('MAX_AGE_DAYS: int = 30'), ['MAX_AGE_DAYS']);
  assert.deepEqual(post.definedNames('def limit(x):'), ['limit']);
  assert.deepEqual(post.definedNames('if (a == b) {'), []); // comparison, not a definition
  assert.equal(post.definesUsedBy('const CAP_LIMIT = 3;', 'return Math.min(raw, CAP_LIMIT)'), true);
  assert.equal(post.definesUsedBy('const CAP_LIMIT = 3;', 'return Math.min(raw, CAP_LIMIT_OTHER)'), false); // whole word only
  assert.equal(post.definesUsedBy("console.log('premium', base)", 'return Math.min(raw, base * CAP)'), false);
  assert.equal(post.definesUsedBy(undefined, 'x'), false);
});

test("a finding on a row the model marked covered is kept at low confidence and the row follows it", () => {
  const d = report({ coverage: [row("covered")], findings: [finding()] });
  assert.equal(post.validate(d).ok, true);
  assert.equal(d.findings.length, 1);
  assert.equal(d.findings[0].confidence, "low");
  assert.equal(d.coverage[0].status, "missing_test");
  assert.ok(d.validation_notes.some((n) => /contradicted finding/.test(n)), d.validation_notes.join("|"));
  // unknown or malformed rows still drop the finding (their citations were not verified)
  const u = report({ coverage: [row("covered", { evidence: [] })], findings: [finding()] });
  post.validate(u);
  assert.equal(u.findings.length, 0);
});
