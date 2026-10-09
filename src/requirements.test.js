const test = require('node:test');
const assert = require('node:assert/strict');
const { collectRequirements, extractCriteria, leftRanges, blameShas } = require('./requirements');

test('resolves qualified issues without confusing them with local issue numbers', () => {
  const calls = [];
  const result = collectRequirements({ repo: 'org/app', pr: { number: 9, title: 'Change', body: 'Closes #1; org/spec#2; https://github.com/org/other/issues/3; #1; #9', closingIssuesReferences: [{ number: 2, url: 'https://github.com/org/spec/issues/2' }] },
    commits: 'Also #4', loadIssue: (repo, number) => { calls.push([repo, number]); return { title: 'AC', body: 'Return 42' }; } });
  assert.deepEqual(calls, [['org/spec', 2], ['org/other', 3], ['org/app', 1], ['org/app', 4]]);
  assert.equal(result.status, 'available');
  assert.match(result.text, /issue org\/spec#2/);
  assert.equal(result.sources.length, 5);
});

test('records inaccessible issues and fetch limits instead of claiming complete context', () => {
  const result = collectRequirements({ repo: 'org/app', pr: { number: 10, body: '#1 #2 #3 #4 #5 #6' }, loadIssue: () => { throw new Error('403'); } });
  assert.equal(result.status, 'partial');
  assert.equal(result.limitations.length, 6);
  assert.match(result.limitations[0], /1 linked issue/);
  assert.match(result.limitations[1], /Could not read issue #1/);
});

test('sanitizes hidden text and labels absent requirements', () => {
  const result = collectRequirements({ repo: 'org/app', pr: { number: 1, title: 'A\u200bB<!-- hidden -->', body: '' }, loadIssue: () => assert.fail('no issue requested') });
  assert.match(result.text, /# PR: AB/);
  assert.equal(result.status, 'partial');
  assert.match(result.limitations[0], /only changed behaviour/);
});

test('inventories numbered, checkbox and explicitly labelled acceptance criteria with stable source IDs', () => {
  const criteria = extractCriteria([{ source: 'PR body', text: '# Acceptance criteria\n1. Reject zero.\n2. Accept positive values.\n   Keep precision.\n# Checklist\n- [x] Read style guide\nAC 3: Preserve existing callers.' },
    { source: 'issue #2', text: '## 验收标准\n- [ ] 返回明确错误。\n```\n- not a criterion\n```' }]);
  assert.deepEqual(criteria.map((r) => [r.id, r.source, r.quote]), [
    ['R1', 'PR body', 'Reject zero.'], ['R2', 'PR body', 'Accept positive values.\nKeep precision.'], ['R3', 'PR body', 'Preserve existing callers.'], ['R4', 'issue #2', '返回明确错误。'],
  ]);
  assert.deepEqual(extractCriteria([{ source: 'PR body', text: 'Make the system faster.' }]), []);
});

test('ignores HTML entities and merge-commit text but keeps real references', () => {
  const calls = [];
  const loadIssue = (repo, n) => { calls.push(n); return { title: 't', body: '' }; };
  collectRequirements({ repo: 'org/app', pr: { number: 9, body: 'Don&#39;t break it &#x27; a#5' }, commits: 'Merge pull request #4 from x/y\nMerge branch \'a\' into b #7', loadIssue });
  assert.deepEqual(calls, []);
  collectRequirements({ repo: 'org/app', pr: { number: 9, body: 'Closes #12' }, commits: 'Merge pull request #4 from x/y\nfix (#13)', loadIssue });
  assert.deepEqual(calls, [12, 13]);
});

test('indented sub-bullets continue their criterion', () => {
  const criteria = extractCriteria([{ source: 'PR body', text: '## Acceptance criteria\n- Parent\n  - sub one\n  - sub two\n- Second' }]);
  assert.deepEqual(criteria.map((r) => r.quote), ['Parent\n- sub one\n- sub two', 'Second']);
});

const SHA1 = 'a'.repeat(40), SHA2 = 'b'.repeat(40), SHA3 = 'c'.repeat(40);

test('leftRanges lists LEFT ranges of production hunks only', () => {
  const diff = ['diff --git a/src/a.js b/src/a.js', '@@ -10,3 +10,4 @@ fn', '@@ -30 +31 @@', '@@ -40,0 +41,2 @@',
    'diff --git a/docs/x.md b/docs/x.md', '@@ -1,2 +1,2 @@', 'diff --git a/src/a.test.js b/src/a.test.js', '@@ -5,2 +5,2 @@'].join('\n');
  assert.deepEqual(leftRanges(diff), [{ path: 'src/a.js', a: 10, b: 12 }, { path: 'src/a.js', a: 30, b: 30 }]);
});

test('blameShas ranks commits by blamed line count across hunks', () => {
  const porcelain = (shas) => shas.map((s, i) => `${s} ${i + 1} ${i + 1}\n\tcode`).join('\n');
  const calls = [];
  const diff = 'diff --git a/src/a.js b/src/a.js\n@@ -1,3 +1,3 @@\n@@ -9,2 +9,2 @@';
  const out = blameShas(diff, (p, a, b) => { calls.push([p, a, b]); return a === 1 ? porcelain([SHA1, SHA2, SHA2]) : porcelain([SHA3, SHA2]); });
  assert.deepEqual(calls, [['src/a.js', 1, 3], ['src/a.js', 9, 10]]);
  assert.deepEqual(out, [SHA2, SHA1, SHA3]);
});

test('history: blame -> PR -> closing issue become optional criteria; direct pushes are skipped', () => {
  const issues = [];
  const history = { shas: [SHA1, SHA2], pulls: (sha) => (sha === SHA1 ? [{ number: 7 }] : []),
    pr: (n) => { assert.equal(n, 7); return { number: 7, title: 'Old', body: '## Acceptance criteria\n- Cap at twice base', closingIssuesReferences: [{ number: 3, url: 'https://github.com/org/app/issues/3' }] }; } };
  const r = collectRequirements({ repo: 'org/app', pr: { number: 9, body: 'x' }, history, loadIssue: (repo, n) => { issues.push([repo, n]); return { title: 'Issue', body: 'AC 1: never above 2x' }; } });
  assert.deepEqual(issues, [['org/app', 3]]);
  assert.deepEqual(r.sources, ['PR body', 'history PR #7', 'history issue #3']);
  assert.deepEqual(r.criteria.map((c) => [c.id, c.source, c.quote, c.optional]), [['H1', 'history PR #7', 'Cap at twice base', true], ['H2', 'history issue #3', 'never above 2x', true]]);
  assert.equal(r.status, 'available');
});

test('history: API failures become limitations and collection continues', () => {
  const history = { shas: [SHA1, SHA2, SHA3], pulls: (sha) => { if (sha === SHA1) throw new Error('403'); return [{ number: 8 }]; },
    pr: (n) => ({ number: n, title: 'T', body: '', closingIssuesReferences: [{ number: 4 }] }) };
  const r = collectRequirements({ repo: 'org/app', pr: { number: 9, body: 'x' }, history, loadIssue: () => { throw new Error('404'); } });
  assert.equal(r.status, 'partial');
  assert.ok(r.limitations.some((l) => /Could not map commit aaaaaaa/.test(l)));
  assert.ok(r.limitations.some((l) => /Could not read history issue org\/app#4/.test(l)));
  assert.ok(r.sources.includes('history PR #8'));
  assert.equal(collectRequirements({ repo: 'org/app', pr: { number: 9, body: 'x' }, history: { error: true }, loadIssue: () => assert.fail('none') }).limitations.some((l) => /Historical intent unavailable/.test(l)), true);
});

test('history: stops at three documents and skips the current PR and already linked issues', () => {
  const history = { shas: [SHA1, SHA2, SHA3], pulls: (sha) => [{ number: sha === SHA1 ? 9 : sha === SHA2 ? 5 : 6 }],
    pr: (n) => ({ number: n, title: `PR${n}`, body: '', closingIssuesReferences: [{ number: 1 }, { number: 2 }] }) };
  const r = collectRequirements({ repo: 'org/app', pr: { number: 9, body: 'Closes #1' }, history, loadIssue: (repo, n) => ({ title: `I${n}`, body: '' }) });
  assert.deepEqual(r.sources.filter((s) => s.startsWith('history')), ['history PR #5', 'history issue #2', 'history PR #6']);
});

test('GitHub CRLF bodies: sanitised, criteria inventoried without CR, a lone CR is a line break', () => {
  const body = '# Acceptance criteria\r\n1. Reject zero.\r\n2. Accept positive values.\r\n   Keep precision.\r\n\r\nAC 3: Preserve existing callers.\r\n';
  const lf = body.replace(/\r\n/g, '\n');
  const want = [['R1', 'Reject zero.'], ['R2', 'Accept positive values.\nKeep precision.'], ['R3', 'Preserve existing callers.']];
  for (const text of [body, lf, body.replace(/\r\n/g, '\r')]) assert.deepEqual(extractCriteria([{ source: 'PR body', text }]).map((r) => [r.id, r.quote]), want);
  const r = collectRequirements({ repo: 'o/a', pr: { number: 1, title: 'T', body }, loadIssue: () => assert.fail('none') });
  assert.doesNotMatch(r.text, /\r/);
  assert.match(r.text, /1\. Reject zero\.\n2\. Accept positive values\.\n {3}Keep precision\./);
  assert.deepEqual(extractCriteria([{ source: 'PR body', text: r.text }]).map((c) => c.quote), want.map((w) => w[1]));
  assert.equal(collectRequirements({ repo: 'o/a', pr: { number: 1, title: 'a\rb', body: 'x\ry' }, loadIssue: () => assert.fail('none') }).text.includes('x\ny'), true);
});
