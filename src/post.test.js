const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const post = require('./post.js');

const behaviour = { path: 'src.js', line: 3, quote: 'if (x) {' };
const evidence = { path: 'test.js', line: 2, quote: 'assert.equal(result, 42);', layer: 'unit', kind: 'assertion', proves: 'Returns the required total for the boundary input.' };
const row = (status = 'covered', extra = {}) => ({ id: 'O1', obligation: 'Returns the required total', source: 'issue #1 AC 1', behaviour: { ...behaviour }, change: { ...behaviour }, evidence: status === 'missing_test' ? [] : [{ ...evidence }], status, reason: 'Searched unit and integration suites for the public total function.', ...extra });
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
  assert.deepEqual([d.coverage[0].status, d.findings.length], ['unknown', 0]);
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
      listComments: async () => ({ data: [] }),
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
  const d = load('findings.json'), status = load('requirements-status.json');
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
  const d = load('findings.json');
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
