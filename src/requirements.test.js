const test = require('node:test');
const assert = require('node:assert/strict');
const { collectRequirements, extractCriteria } = require('./requirements');

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
