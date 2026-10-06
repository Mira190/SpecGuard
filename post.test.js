const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const post = require('./post.js');
const { parsePatch, validate, anchor, snap, plan, fingerprint, redact, truncate } = post;

const PATCH = ['@@ -1,3 +1,4 @@', ' ctx1', '-old2', '+new2', '+new3', ' ctx4', '\\ No newline at end of file', '@@ -20,2 +21,2 @@', ' c20', '+n22'].join('\n');

test('parsePatch: added, context, deleted, multiple hunks, no-newline marker', () => {
  const m = parsePatch(PATCH);
  assert.deepStrictEqual([...m.RIGHT], [[1, 0], [2, 0], [3, 0], [4, 0], [21, 1], [22, 1]]);
  assert.deepStrictEqual([...m.LEFT], [[2, 0]]);
  assert.strictEqual(parsePatch(undefined).RIGHT.size, 0);
  assert.strictEqual(parsePatch('@@ -1 +1 @@\n+a\n').RIGHT.size, 1); // trailing '' is not a context line
});

const F = (o) => ({ kind: 'missing_test', path: 'a.js', line: 2, quote: 'q', title: 't', body: 'b', confidence: 'high', ...o });
const maps = new Map([['a.js', parsePatch(PATCH)]]);

test('anchor ladder: inline / file-level / summary', () => {
  const m = maps.get('a.js');
  assert.strictEqual(anchor(F({ line: 2 }), m), 'inline');
  assert.strictEqual(anchor(F({ line: 10 }), m), 'file');
  assert.strictEqual(anchor(F({ line: 10, confidence: 'low' }), m), 'summary');
  assert.strictEqual(anchor(F({ line: 2 }), undefined), 'summary');
  assert.strictEqual(anchor(F({ line: 10 }), m, 3), 'summary');
});

test('range must stay in one hunk on RIGHT', () => {
  const m = maps.get('a.js');
  assert.strictEqual(anchor(F({ start_line: 1, line: 3 }), m), 'inline');
  assert.strictEqual(anchor(F({ start_line: 4, line: 21 }), m), 'file');
  assert.strictEqual(anchor(F({ start_line: 3, line: 3 }), m), 'file');
});

test('plan: low never inline, file-level cap 3, max_comments overflow, ordering', () => {
  const fs_ = [F({ line: 10, title: 'f1' }), F({ line: 11 }), F({ line: 12 }), F({ line: 13 }), F({ line: 2, confidence: 'low' }),
    F({ kind: 'pushdown', line: 1 }), F({ kind: 'weak_test', line: 3 }), F({ line: 4 })];
  const p = plan(fs_, maps, 2);
  assert.deepStrictEqual(p.inline.map((f) => f.kind), ['missing_test', 'weak_test']);
  assert.strictEqual(p.file.length, 3);
  const why = p.summary.map((s) => s.why).sort();
  assert.deepStrictEqual(why, ['low confidence', 'not in a diff hunk', 'over max_comments']);
  assert.strictEqual(plan(Array(40).fill(F({ line: 2 })), maps, 99).inline.length, 30);
});

test('validate rejects bad kind and line, accepts a sample', () => {
  const ok = { requirements_source: 'PR body', not_reviewed: '', coverage: [{ obligation: 'o', source: 's', tests: ['t.js:1'], status: 'covered' }], findings: [F({})] };
  assert.strictEqual(validate(ok).ok, true);
  assert.strictEqual(validate({ ...ok, findings: [F({ kind: 'nope' })] }).ok, false);
  assert.strictEqual(validate({ ...ok, findings: [F({ line: 0 })] }).ok, false);
  assert.strictEqual(validate({ ...ok, findings: [F({ line: 1.5 })] }).ok, false);
  assert.strictEqual(validate({ ...ok, coverage: [{ ...ok.coverage[0], status: 'x' }] }).ok, false);
  assert.strictEqual(validate(null).ok, false);
});

test('fingerprint is stable across line shifts, changes with text', () => {
  assert.strictEqual(fingerprint('standard', 'a.js', '  if (x)   {'), fingerprint('standard', 'a.js', 'if (x) {'));
  assert.strictEqual(fingerprint('standard', 'a.js', 'if (x) {'), fingerprint('standard', 'a.js', ' if (x)  { '));
  assert.notStrictEqual(fingerprint('standard', 'a.js', 'if (x) {'), fingerprint('weak_test', 'a.js', 'if (x) {'));
  assert.notStrictEqual(fingerprint('standard', 'a.js', 'if (x) {'), fingerprint('standard', 'a.js', 'if (y) {'));
});

test('redact and truncate', () => {
  const t = 'ghp_' + 'a'.repeat(36);
  assert.strictEqual(redact(`x ${t} y github_pat_${'B'.repeat(30)} sk-ant-${'c'.repeat(30)}`), 'x [REDACTED] y [REDACTED] [REDACTED]');
  assert.ok(truncate('x'.repeat(70000)).length <= 65000);
});

// ---- end to end with a stub github ----
function setup({ existing = [], failFirst422 = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-'));
  fs.mkdirSync(path.join(dir, 'ctx'));
  fs.writeFileSync(path.join(dir, 'src.js'), ['l1', 'l2', 'if (x) {', 'l4', 'l5', 'l6', 'l7', 'l8', ''].join('\n'));
  fs.writeFileSync(path.join(dir, 'RULES.md'), 'rule one\nrule two\n');
  fs.writeFileSync(path.join(dir, 'ctx/files.txt'), 'src.js\n');
  fs.writeFileSync(path.join(dir, 'ctx/standards.txt'), 'RULES.md\n');
  const findings = {
    requirements_source: 'PR body', not_reviewed: '', coverage: [],
    findings: [
      F({ path: 'src.js', line: 3, quote: 'if (x) {', title: 'inline one' }),
      F({ path: 'src.js', line: 8, quote: 'l8', title: 'file level' }),
      F({ path: 'other.js', line: 1, title: 'not in diff' }),
      F({ path: 'src.js', line: 4, quote: 'no such text', title: 'bad quote' }),
      F({ path: 'src.js', line: 4, quote: 'if (x) {', title: 'off by one' }),
      F({ path: 'src.js', line: 2, quote: 'l2', kind: 'standard', rule_source: 'RULES.md:2', title: 'good rule', suggestion: '  l2 fixed();' }),
      F({ path: 'src.js', line: 4, quote: 'l4', kind: 'standard', rule_source: 'RULES.md:50', title: 'bad rule' }),
    ],
  };
  fs.writeFileSync(path.join(dir, 'ctx/findings.json'), JSON.stringify(findings));
  const calls = { review: [], fileComment: [], issueCreate: [], issueUpdate: [] };
  const patch = '@@ -1,2 +1,4 @@\n l1\n+l2\n+if (x) {\n+l4';
  let n422 = failFirst422 ? 1 : 0;
  const github = {
    paginate: async (fn, p) => (await fn(p)).data,
    rest: {
      pulls: {
        listFiles: async () => ({ data: [{ filename: 'src.js', patch }] }),
        listReviewComments: async () => ({ data: existing }),
        createReview: async (a) => { calls.review.push(a); if (n422-- > 0) throw Object.assign(new Error('Line could not be resolved'), { status: 422 }); return {}; },
        createReviewComment: async (a) => { calls.fileComment.push(a); return {}; },
      },
      issues: {
        listComments: async () => ({ data: [] }),
        createComment: async (a) => { calls.issueCreate.push(a); return {}; },
        updateComment: async (a) => { calls.issueUpdate.push(a); return {}; },
      },
    },
  };
  const warnings = [];
  const core = { warning: (m) => warnings.push(m), summary: { addRaw() { return this; }, async write() {} } };
  const context = { repo: { owner: 'o', repo: 'r' }, serverUrl: 'https://github.com', payload: { pull_request: { number: 7, head: { sha: 'HEADSHA' } } } };
  Object.assign(process.env, { CTX: path.join(dir, 'ctx'), GITHUB_WORKSPACE: dir, HEAD_SHA: 'HEADSHA', MAX_COMMENTS: '10', ENGINE: 'copilot', SKIP: 'false', PARTIAL: 'false' });
  return { github, core, context, calls, warnings };
}

test('main flow: one review, file-level comment, rule filter, summary created', async () => {
  const s = setup();
  await post(s);
  assert.strictEqual(s.calls.review.length, 1);
  const r = s.calls.review[0];
  assert.strictEqual(r.event, 'COMMENT');
  assert.strictEqual(r.commit_id, 'HEADSHA');
  assert.deepStrictEqual(r.comments.map((c) => c.line).sort(), [2, 3]); // 'bad rule' and 'not in diff' dropped
  assert.ok(r.comments.every((c) => /<!-- specguard:fp=[0-9a-f]{40} -->/.test(c.body)));
  assert.ok(r.body.startsWith('<!-- specguard:review -->'));
  assert.strictEqual(s.calls.fileComment.length, 1);
  assert.strictEqual(s.calls.fileComment[0].subject_type, 'file');
  assert.ok(s.calls.fileComment[0].body.includes('/blob/HEADSHA/src.js#L8'));
  assert.ok(r.comments.find((c) => c.line === 2).body.includes('```suggestion\n  l2 fixed();\n```'));
  assert.strictEqual(s.calls.issueCreate.length, 1);
  assert.ok(s.calls.issueCreate[0].body.includes('citation did not match the file'));
  assert.strictEqual(r.comments.filter((c) => c.line === 3).length, 1); // off-by-one snapped onto line 3, deduped with 'inline one'
  assert.ok(s.calls.issueCreate[0].body.includes('<!-- specguard:summary -->'));
});

test('main flow: dedupe skips an existing fingerprint', async () => {
  const fp = fingerprint('missing_test', 'src.js', 'if (x) {');
  const s = setup({ existing: [{ body: `old <!-- specguard:fp=${fp} -->`, line: null }] });
  await post(s);
  assert.deepStrictEqual(s.calls.review[0].comments.map((c) => c.line), [2]);
  assert.ok(s.calls.review[0].body.includes('2 already posted'));
});

test('main flow: 422 retries once as a body-only review', async () => {
  const s = setup({ failFirst422: true });
  await post(s);
  assert.strictEqual(s.calls.review.length, 2);
  assert.strictEqual(s.calls.review[1].comments, undefined);
  assert.ok(s.calls.review[1].body.includes('unanchored'));
});

test('main flow: missing findings.json reports could not complete and does not throw', async () => {
  const s = setup();
  fs.unlinkSync(path.join(process.env.CTX, 'findings.json'));
  await post(s);
  assert.strictEqual(s.calls.review.length, 0);
  assert.ok(s.calls.issueCreate[0].body.includes('Could not complete'));
});

test('snap: exact, +-1, closest wins, no match / unreadable / start_line underflow', () => {
  const L = ['a', '  throw 1;', '}', 'c'];
  assert.strictEqual(snap({ line: 2, quote: 'throw 1;' }, L), 0);
  assert.strictEqual(snap({ line: 3, quote: 'throw 1;' }, L), -1);
  assert.strictEqual(snap({ line: 1, quote: 'throw   1;' }, L), 1);
  assert.strictEqual(snap({ line: 2, quote: 'nope' }, L), null);
  assert.strictEqual(snap({ line: 2, quote: 'throw 1;' }, null), null);
  assert.strictEqual(snap({ line: 3, start_line: 1, quote: 'throw 1;' }, L), null);
  assert.strictEqual(snap({ line: 50, quote: 'throw 1;' }, L), null); // beyond +-5
});

test('commentBody: suggestion block for inline standard, longer fence, ignored on other kinds, plain block at file level', () => {
  const S = (o) => F({ kind: 'standard', suggestion: 'throw new Error(x);', ...o });
  const inl = post.commentBody(S({}), 'a'.repeat(40));
  assert.ok(inl.includes('```suggestion\nthrow new Error(x);\n```'));
  assert.ok(inl.indexOf('```suggestion') < inl.indexOf('<details>'));
  assert.ok(post.commentBody(S({ suggestion: 'a ```b``` c' }), 'a'.repeat(40)).includes('````suggestion\na ```b``` c\n````'));
  assert.ok(!post.commentBody(F({ suggestion: 'x' }), 'a'.repeat(40)).includes('x\n```'));
  assert.ok(!post.commentBody(S({ suggestion: '' }), 'a'.repeat(40)).includes('suggestion'));
  const file = post.commentBody(S({}), 'a'.repeat(40), false);
  assert.ok(file.includes('Suggested fix:\n\n```\nthrow new Error(x);\n```') && !file.includes('```suggestion'));
  assert.strictEqual(validate({ requirements_source: '', not_reviewed: '', coverage: [], findings: [S({ suggestion: 1 })] }).ok, false);
});
