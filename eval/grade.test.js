const test = require('node:test');
const assert = require('node:assert/strict');
const { grade, aggregate, parseComment, parseSummary } = require('./grade.js');
const { validateCase, allIds } = require('./run.js');

const exp = (extra = {}) => ({ kind: 'missing_test', path: 'a.js', line: 10, ...extra });
const spec = (findings = [exp()], rest = {}) => ({ id: 'c', goal: 'requirements', expected: { findings, must_not: [], ...rest } });
const obs = (comments = [], extra = {}) => ({ comments, reviews: [], summary: '<!-- specguard:summary -->\n## SpecGuard\n\nReviewed.', latency_s: 60, ...extra });
const com = (extra = {}) => ({ kind: 'missing_test', confidence: 'high', path: 'a.js', line: 10, title: 't', body: 'b', rule: '', source: '', ...extra });
const summaryWith = (items) => `<!-- specguard:summary -->\n## SpecGuard\n\nReviewed.\n\n<details><summary>x</summary>\n\n${items}\n</details>\n`;

test('matches within tolerance and counts the rest as FP/FN', () => {
  assert.equal(grade(spec(), obs([com({ line: 12 })])).tp, 1);
  const r = grade(spec(), obs([com({ line: 13 })]));
  assert.deepEqual([r.tp, r.fp, r.fn, r.pass], [0, 1, 1, false]);
  assert.equal(grade(spec([exp({ tolerance: 5 })]), obs([com({ line: 13 })])).tp, 1);
  assert.equal(grade(spec(), obs([com({ kind: 'weak_test' })])).tp, 0);
  assert.equal(grade(spec(), obs([com({ path: 'b.js' })])).tp, 0);
  assert.equal(grade(spec([exp({ kind: ['weak_test', 'missing_test'], path: ['z.js', 'a.js'] })]), obs([com()])).tp, 1);
});

test('source equality matches when the line is far off', () => {
  const e = exp({ source: 'PR body AC 2' });
  assert.equal(grade(spec([e]), obs([com({ line: 90, source: 'PR body AC 2' })])).tp, 1);
  assert.equal(grade(spec([e]), obs([com({ line: 90, source: 'PR body AC 3' })])).tp, 0);
});

test('one observed finding matches one expected finding, closest first', () => {
  const r = grade(spec([exp(), exp()]), obs([com()]));
  assert.deepEqual([r.tp, r.fn], [1, 1]);
  const two = grade(spec([exp({ line: 10 }), exp({ line: 12 })]), obs([com({ line: 12 }), com({ line: 10 })]));
  assert.deepEqual([two.tp, two.fp, two.fn], [2, 0, 0]);
});

test('rule and text expectations', () => {
  const e = exp({ kind: 'standard', rule: 'pkg/REVIEW.md', text: 'Error objects' });
  assert.equal(grade(spec([e]), obs([com({ kind: 'standard', rule: 'other/REVIEW.md:3' })])).tp, 0);
  const ok = grade(spec([e]), obs([com({ kind: 'standard', rule: 'pkg/REVIEW.md:3', body: 'Throw Error objects' })]));
  assert.deepEqual([ok.tp, ok.pass], [1, true]);
  const miss = grade(spec([e]), obs([com({ kind: 'standard', rule: 'pkg/REVIEW.md:3', body: 'nope' })]));
  assert.deepEqual([miss.tp, miss.pass], [1, false]);
});

test('low-confidence and summary-only items are never TP or FP', () => {
  const r = grade(spec(), obs([com({ confidence: 'low' })], { summary: summaryWith('- **Weak** (`a.js:10`, missing_test, low confidence)\n\n  body\n') }));
  assert.deepEqual([r.tp, r.fp, r.fn, r.summary_only], [0, 0, 1, 1]);
});

test('allow_summary counts a summary item or coverage row matching kind and path', () => {
  const e = exp({ allow_summary: true, path: ['p.js', 'p.spec.js'], kind: ['weak_test', 'missing_test'] });
  const item = grade(spec([e]), obs([], { summary: summaryWith('- **Gone** (`p.spec.js:3`, weak_test, removed test)\n') }));
  assert.deepEqual([item.tp, item.fn, item.matched[0].via_summary], [1, 0, true]);
  const row = '| O1: sums | PR body; p.js:2 — return x | none | missing_test: no test |';
  assert.equal(grade(spec([e]), obs([], { summary: `Reviewed\n${row}\n` })).tp, 1);
  assert.equal(grade(spec([e]), obs([], { summary: 'Reviewed\n| O1: sums | PR body; p.js:2 — return x | e | covered: fine |\n' })).fn, 1);
  assert.equal(grade(spec([{ ...e, allow_summary: false }]), obs([], { summary: summaryWith('- **Gone** (`p.spec.js:3`, weak_test)\n') })).fn, 1);
});

test('expect_skip and expect_clean', () => {
  const skip = spec([], { expect_skip: true });
  assert.equal(grade(skip, obs([], { summary: '<!-- specguard:summary -->\n## SpecGuard\n\nNothing to review: every changed file is ignored.' })).pass, true);
  assert.equal(grade(skip, obs()).skip_ok, false);
  const clean = spec([], { expect_clean: true });
  assert.equal(grade(clean, obs()).pass, true);
  const dirty = grade(clean, obs([com()]));
  assert.deepEqual([dirty.clean_ok, dirty.pass, dirty.fp], [false, false, 1]);
});

test('json_valid fails on a missing, incomplete or partial summary', () => {
  assert.equal(grade(spec([]), obs([], { summary: null })).json_valid, false);
  assert.equal(grade(spec([]), obs([], { summary: 'Could not complete: no valid findings.json' })).pass, false);
  assert.equal(grade(spec([]), obs([], { summary: '> Partially reviewed: the diff exceeded' })).json_valid, false);
  assert.equal(grade(spec([]), obs()).json_valid, true);
});

test('must_not: kind/path/line, text and review state', () => {
  const s = (m) => spec([], { must_not: [m] });
  assert.equal(grade(s({ kind: 'missing_test', path: 'a.js', line: 3 }), obs([com({ line: 4 })])).must_not_violations.length, 1);
  assert.equal(grade(s({ kind: 'missing_test', path: 'a.js', line: 3 }), obs([com({ line: 9 })])).pass, true);
  assert.equal(grade(s({ text: 'LGTM' }), obs([com({ body: 'lgtm!' })])).pass, false);
  assert.equal(grade(s({ text: 'LGTM' }), obs([], { reviews: [{ state: 'COMMENT', body: 'LGTM' }] })).pass, false);
  assert.equal(grade(s({ state: 'APPROVED' }), obs([], { reviews: [{ state: 'APPROVED', body: '' }] })).pass, false);
  assert.equal(grade(s({ state: 'APPROVED' }), obs([], { reviews: [{ state: 'COMMENT', body: '' }] })).pass, true);
});

test('parses Action comments and summaries', () => {
  const body = '**Missing test**\n\ntext\n\n<details><summary>Why this was flagged</summary>\n\nkind: standard, confidence: high, rule: pkg/REVIEW.md:3\n</details>\n\n<!-- specguard:fp=abc -->';
  assert.deepEqual(['kind', 'confidence', 'rule', 'line', 'level', 'title'].map((k) => parseComment({ path: 'a.js', line: 7, body })[k]), ['standard', 'high', 'pkg/REVIEW.md:3', 7, 'inline', 'Missing test']);
  const file = parseComment({ path: 'a.js', line: null, subject_type: 'file', body: `**T**\n\nx\n\n[a.js:42](https://github.com/o/r/blob/abc/a.js#L42)\n\nkind: pushdown, confidence: high` });
  assert.deepEqual([file.line, file.level], [42, 'file']);
  assert.equal(parseComment({ body: 'a human comment' }), null);
  const s = parseSummary(summaryWith('- **A** (`x.js:5`, weak_test, low confidence)\n\n  b\n') + '| O1: a \\| b | src; x.js:5 — q | none | weak_test: r |\n');
  assert.deepEqual([s.items.length, s.rows.length, s.rows[0].path], [1, 1, 'x.js']);
});

test('aggregate: precision, recall, validity, pass rate, latency and per-goal split', () => {
  const r = (goal, tp, fp, fn, extra = {}) => ({ goal, tp, fp, fn, summary_only: 0, json_valid: true, pass: !fn, latency_s: 100, ...extra });
  const a = aggregate([r('requirements', 3, 1, 0, { latency_s: 60 }), r('standards', 1, 0, 1, { latency_s: 120 }), r('standards', 0, 0, 0, { json_valid: false, latency_s: 300 }), { goal: 'layering', error: 'timeout' }]);
  assert.deepEqual([a.precision, a.recall, a.json_valid_rate, a.pass_rate, a.runs, a.errors], [0.8, 0.8, 0.667, 0.667, 4, 1]);
  assert.deepEqual([a.latency_median_s, a.latency_max_s, a.cost], [120, 300, 'not measured']);
  assert.equal(a.by_goal.standards.recall, 0.5);
  assert.equal(aggregate([r('x', 0, 0, 0)]).precision, null);
});

test('shipped cases are well formed', () => {
  assert.equal(allIds().length, 14);
  assert.deepEqual(allIds().flatMap(validateCase), []);
});
