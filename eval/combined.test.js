const test = require('node:test');
const assert = require('node:assert/strict');
const { extractCriteria } = require('../src/requirements.js');
const { filterSummary } = require('./grade.js');
const { combine, allIds, loadCase, COMBINED_SKIP } = require('./run.js');

const cs = allIds().filter((id) => !COMBINED_SKIP.includes(id)).map(loadCase);

test('combined PR body yields exactly the union of each case\'s criteria quotes', () => {
  const alone = cs.flatMap((c) => extractCriteria([{ source: 'PR body', text: `${c.pr_title}\n${c.pr_body}` }]).map((r) => r.quote));
  const m = combine(cs);
  assert.ok(alone.length > 0);
  assert.deepEqual(m.criteria.map((r) => r.quote), alone);
  assert.deepEqual(m.criteria.map((r) => r.id), alone.map((_, i) => `R${i + 1}`));
});

test('combined overlay has no duplicate paths and excludes x1/x2', () => {
  assert.deepEqual(COMBINED_SKIP.filter((id) => cs.some((c) => c.id === id)), []);
  assert.throws(() => combine([cs[0], cs[0]]), /appears twice/);
});

test('filterSummary keeps only items and coverage rows under the prefix', () => {
  const s = ['intro', '- **A** (`eval-sandbox/r1/a.js:3`, missing_test, low)', '- **B** (`eval-sandbox/r2/b.js:4`, weak_test)',
    '| R1 | x; eval-sandbox/r1/a.js:3 — y | z | w | missing_test: q |', '| R2 | x; eval-sandbox/r2/b.js:4 — y | z | w | missing_test: q |'].join('\n');
  const out = filterSummary(s, 'eval-sandbox/r1/');
  assert.deepEqual(out.split(String.fromCharCode(10)).map((l) => /r2/.test(l)), [false, false, false]);
  assert.equal(filterSummary(null, 'x'), null);
});
