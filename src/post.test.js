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

test('rejects missing checks, unsupported coverage, orphan findings and contradictory classifications', () => {
  assert.deepEqual(post.validate(report()), { ok: true });
  const covered = report({ coverage: [row()], findings: [] });
  assert.equal(post.validate(covered).ok, true);
  for (const d of [null, { ...covered, standards: undefined }, { ...covered, layering: undefined },
    report({ coverage: [row('covered', { evidence: [] })], findings: [] }),
    report({ coverage: [row('covered', { evidence: [{ ...evidence, layer: 'integration' }] })], findings: [] }),
    report({ findings: [] }), report({ findings: [finding(), finding()] }),
    report({ findings: [finding('pushdown')] }), report({ findings: [finding('missing_test', { obligation_ids: ['absent'] })] }),
    report({ findings: [finding('missing_test', { line: 0 })] }),
    report({ coverage: [row('missing_test'), row('missing_test')] }),
    report({ coverage: [row('missing_test', { evidence: [evidence] })] })]) assert.equal(post.validate(d).ok, false);
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
  for (const [name, value] of Object.entries({ 'files.txt': 'src.js\n', 'standards.txt': 'RULES.md\n', 'findings.json': JSON.stringify(data), 'requirements-status.json': JSON.stringify({ status: 'available', sources: ['PR body', 'issue #1'], limitations: [] }) })) fs.writeFileSync(path.join(dir, 'ctx', name), value);
  const calls = { review: [], file: [], summary: [] };
  let count = 0;
  const github = { paginate: async (fn, args) => (await fn(args)).data, rest: {
    pulls: {
      get: async () => ({ data: { head: { sha: options.head || 'HEADSHA' } } }),
      listFiles: async () => ({ data: [{ filename: 'src.js', patch }] }),
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
  assert.deepEqual(s.calls, { review: [], file: [], summary: [] });
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
  s.github.rest.pulls.listFiles = async () => ({ data: [{ filename: 'test.js', patch: `@@ -1,2 +1,2 @@\n test\n-assert.equal(result, 43);\n+${evidence.quote}` }] });
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
    assert.equal(post.validate(d).ok, false);
  }
});

test('preserves removed assertions from deleted test files as LEFT-side summary evidence', async (t) => {
  const removed = { ...evidence, side: 'LEFT', kind: 'removed' };
  const s = setup(t, report({ coverage: [row('weak_test', { change: removed, evidence: [removed] })], findings: [finding('weak_test', removed)] }));
  fs.unlinkSync(path.join(s.dir, 'test.js'));
  fs.writeFileSync(path.join(s.dir, 'ctx/files.txt'), 'test.js\n');
  s.github.rest.pulls.listFiles = async () => ({ data: [{ filename: 'test.js', patch: `@@ -1,2 +0,0 @@\n-test\n-${evidence.quote}` }] });
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
