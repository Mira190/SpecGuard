const test = require('node:test');
const assert = require('node:assert/strict');
const { grade, aggregate, parseComment, parseSummary } = require('./grade.js');
const { validateCase, allIds, loadCase } = require('./run.js');

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
  const r = grade(spec(), obs([com({ confidence: 'low' })], { summary: summaryWith('- ❌ **Missing test:** Weak `a.js:10` (low confidence) — body\n') }));
  assert.deepEqual([r.tp, r.fp, r.fn, r.summary_only], [0, 0, 1, 1]);
});

test('allow_summary counts a summary item or coverage row matching kind and path', () => {
  const e = exp({ allow_summary: true, path: ['p.js', 'p.spec.js'], kind: ['weak_test', 'missing_test'] });
  const item = grade(spec([e]), obs([], { summary: summaryWith('- ❌ **Weak test:** Gone `p.spec.js:3` (removed test or assertion) — x\n') }));
  assert.deepEqual([item.tp, item.fn, item.matched[0].via_summary], [1, 0, true]);
  const row = '| O1: sums | PR body; p.js:2 — return x | none | missing_test: no test |';
  assert.equal(grade(spec([e]), obs([], { summary: `Reviewed\n${row}\n` })).tp, 1);
  assert.equal(grade(spec([e]), obs([], { summary: 'Reviewed\n| O1: sums | PR body; p.js:2 — return x | e | covered: fine |\n' })).fn, 1);
  assert.equal(grade(spec([{ ...e, allow_summary: false }]), obs([], { summary: summaryWith('- ❌ **Weak test:** Gone `p.spec.js:3` — x\n') })).fn, 1);
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
  assert.equal(grade(s({ kind: 'pushdown', confidence: 'high' }), obs([com({ kind: 'pushdown', confidence: 'low' })])).pass, true);
  assert.equal(grade(s({ kind: 'pushdown', confidence: 'high' }), obs([com({ kind: 'pushdown' })])).pass, false);
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
  const s = parseSummary(summaryWith('- ❌ **Weak test:** A `x.js:5` (low confidence) — b\n') + '| O1: a \\| b | src; x.js:5 — q | none | Weak test: r |\n');
  assert.deepEqual([s.items.length, s.rows.length, s.rows[0].path, s.rows[0].status, s.items[0].kind, s.items[0].why], [1, 1, 'x.js', 'weak_test', 'weak_test', 'low confidence']);
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
  assert.ok(allIds().length >= 38, 'every shipped case directory is listed');
  assert.deepEqual(allIds().flatMap(validateCase), []);
});

test('json_valid follows the raw model output when the artifact is available; degraded counts validation notes', () => {
  const failed = obs([], { summary: 'Could not complete: findings.json failed validation' });
  assert.deepEqual([grade(spec([]), { ...failed, raw_findings_present: true, raw_findings_valid_json: true }).json_valid, grade(spec([]), { ...failed, raw_findings_present: true, raw_findings_valid_json: true }).pass], [true, false]);
  assert.equal(grade(spec([]), { ...obs(), raw_findings_present: false, raw_findings_valid_json: false }).json_valid, false);
  assert.equal(grade(spec([]), { ...obs(), raw_findings_present: true, raw_findings_valid_json: false }).json_valid, false);
  assert.equal(grade(spec([]), failed).json_valid, false);
  const skip = '<!-- specguard:summary -->\n## SpecGuard\n\nNothing to review: every changed file is ignored.';
  assert.equal(grade(spec([], { expect_skip: true }), { ...obs([], { summary: skip }), raw_findings_present: false }).pass, true);
  const degraded = obs([], { summary: `${obs().summary}\n\n<details><summary>Details</summary>\n\n**Validation notes (2)**\n\n- Standards assessment ignored: checked standards need sources.\n- Dropped findings[1].\n\n**Sources read**\n\n- x\n</details>\n` });
  const r = grade(spec([]), degraded);
  assert.deepEqual([r.degraded, r.validation_notes.length, grade(spec([]), obs()).degraded], [true, 2, false]);
  assert.equal(aggregate([r, grade(spec([]), obs())]).degraded_rate, 0.5);
});

test('acceptable findings are neither TP nor FP, are reported, and aggregate', () => {
  const ok = { kind: 'missing_test', path: 'a.js', line: 3, tolerance: 1, reason: 'untested helper' };
  const r = grade(spec([exp()], { acceptable: [ok] }), obs([com(), com({ line: 4, title: 'helper' }), com({ line: 3 })]));
  assert.deepEqual([r.tp, r.fp, r.acceptable, r.fn, r.pass], [1, 1, 1, 0, true]);
  assert.deepEqual(r.acceptable_findings.map((f) => [f.line, f.reason]), [[4, 'untested helper']]);
  assert.equal(grade(spec([exp()], { acceptable: [ok] }), obs([com(), com({ line: 40 })])).fp, 1);
  const a = aggregate([r, { ...r, acceptable: 2 }, { goal: 'requirements', error: 'x' }]);
  assert.deepEqual([a.acceptable, a.precision], [3, 0.5]);
});

test('billing: premium_request items replace Copilot SKUs of the general endpoint (no double count)', () => {
  const { copilotItems } = require('./run.js');
  const general = [{ sku: 'Copilot premium request', netAmount: 1 }, { sku: 'Actions minutes', netAmount: 9 }];
  assert.deepEqual(copilotItems(general, [{ sku: 'Premium', model: 'm', netAmount: 2 }]), { 'Premium m': 2 });
  assert.deepEqual(copilotItems(general, []), { 'Copilot premium request': 1 });
});

test('billing: both snapshots use the batch-start UTC date; a UTC midnight crossing is flagged', () => {
  const { utcDay } = require('./run.js');
  assert.equal(utcDay(new Date('2026-01-31T23:59:59Z')), 'year=2026&month=1&day=31');
  assert.equal(utcDay(new Date('2026-02-01T00:00:00Z')), 'year=2026&month=2&day=1');
});

test('getVar: only a not-found error means unset; anything else aborts', () => {
  const { varLookup } = require('./run.js');
  assert.equal(varLookup(() => 'v'), 'v');
  assert.equal(varLookup(() => { throw Object.assign(new Error('x'), { stderr: 'HTTP 404: Not Found' }); }), null);
  assert.equal(varLookup(() => { throw Object.assign(new Error('x'), { stderr: 'variable FOO was not found' }); }), null);
  assert.throws(() => varLookup(() => { throw Object.assign(new Error('x'), { stderr: 'HTTP 502: bad gateway' }); }), /could not read repo variable/);
});

const TRACE = [
  '| Requirement | Changed | Implementation | Tests | Alignment | Reflected in |',
  '|---|---|---|---|---|---|',
  '| [pricing.md R3](https://github.com/o/r/blob/abc/pricing.md#L7) | code | [premium.js:1](https://github.com/o/r/blob/abc/premium.js#L1) | [premium.test.js:9](https://github.com/o/r/blob/abc/premium.test.js#L9) | consistent | spec ✓ tests ✓ PR ✓ |',
  '| AC-4 | spec | [deadline.js:2](https://x/deadline.js#L2) | none | mismatch (introduced) | spec ✓ tests ✗ PR ✗ |',
  '| R9 | code | x | y | not_verifiable | ✓ ✗ ✓ |',
].join('\n');
const traceSummary = (extra = '') => `<!-- specguard:summary -->
## SpecGuard

Reviewed.

### Traceability

${TRACE}

${extra}`;

test('parseSummary reads the Traceability table without disturbing coverage rows', () => {
  const cov = '| O1: sums | PR body; p.js:2 — return x | none | missing_test: no test |';
  const s = parseSummary(`${traceSummary()}
${cov}
`);
  assert.deepEqual(s.trace.map((r) => [r.alignment, r.reflected.spec, r.reflected.tests, r.reflected.pr]), [['consistent', true, true, true], ['mismatch', true, false, false], ['not_verifiable', true, false, true]]);
  assert.equal(s.trace[0].requirement.startsWith('[pricing.md R3]'), true);
  assert.deepEqual(s.rows.map((r) => [r.status, r.path, r.line]), [['missing_test', 'p.js', 2]]);
  assert.deepEqual([parseSummary(summaryWith('')).trace, parseSummary(summaryWith('')).preExisting], [[], null]);
});

test('parseSummary reads the Pre-existing drift section and the no-requirement-docs line', () => {
  const s = parseSummary(`${traceSummary()}
### Pre-existing drift (not caused by this PR)

- R3 says twice; premium.js:1 uses 3

### Next

rest`);
  assert.deepEqual([s.preExisting, s.noRequirementDocs], ['- R3 says twice; premium.js:1 uses 3', false]);
  const d = parseSummary('<details><summary>Pre-existing drift (not caused by this PR)</summary>\n\nR3 drift\n</details>\nafter');
  assert.equal(d.preExisting.endsWith('R3 drift'), true);
  assert.equal(parseSummary('No requirement documents found (content-based discovery; see x).').noRequirementDocs, true);
});

test('spec_mismatch is graded like any other kind, with text', () => {
  const e = exp({ kind: 'spec_mismatch', text: 'R3' });
  assert.equal(grade(spec([e]), obs([com({ kind: 'spec_mismatch', body: 'violates R3' })])).pass, true);
  assert.equal(grade(spec([e]), obs([com({ kind: 'spec_mismatch', body: 'violates R9' })])).pass, false);
  assert.equal(parseComment({ path: 'a.js', line: 7, body: '**Mismatch**\n\nkind: spec_mismatch, confidence: high' }).kind, 'spec_mismatch');
  assert.equal(grade(spec([], { must_not: [{ kind: 'spec_mismatch' }] }), obs([com({ kind: 'spec_mismatch' })])).pass, false);
});

test('summary expectations: summary_has, summary_lacks, trace, pre_existing, rows_not', () => {
  const g = (x, summary) => grade(spec([], x), obs([], { summary }));
  const sm = (x, summary) => g(x, summary).summary_misses;
  assert.deepEqual(sm({ summary_has: ['No requirement documents found'] }, 'No requirement documents found (x)'), []);
  assert.equal(g({ summary_has: ['not_verifiable'] }, obs().summary).pass, false);
  assert.equal(g({ summary_lacks: ['development\\.md'] }, 'cites docs/development.md').pass, false);
  assert.equal(g({ summary_lacks: ['development\\.md'] }, obs().summary).pass, true);
  const t = (x) => sm({ trace: [x] }, traceSummary());
  assert.deepEqual(t({ requirement: 'R3', alignment: 'consistent', reflected: { spec: true, tests: true, pr: true } }), []);
  assert.equal(t({ requirement: 'AC-4', alignment: 'consistent' }).length, 1);
  assert.equal(t({ requirement: 'AC-4', alignment_not: ['mismatch'] }).length, 1);
  assert.equal(t({ requirement: 'AC-4', reflected: { tests: true } }).length, 1);
  assert.equal(t({ requirement: 'R404' }).length, 1);
  assert.equal(sm({ pre_existing: 'R3' }, traceSummary()).length, 1);
  assert.deepEqual(sm({ pre_existing: 'R3' }, traceSummary('### Pre-existing drift (not caused by this PR)\n\n- R3 drift\n')), []);
  const cov = '| O1: cap | PR body; p.js:2 — min | e | covered: R3 holds |';
  assert.equal(sm({ rows_not: [{ status: 'covered', text: 'R3' }] }, `Reviewed
${cov}
`).length, 1);
  assert.equal(sm({ rows_not: [{ status: 'covered', text: 'R4' }] }, `Reviewed
${cov}
`).length, 0);
});

test('shipped traceability cases carry valid summary expectations', () => {
  const ids = allIds().filter((id) => id.startsWith('tr'));
  assert.equal(ids.length, 23);
  for (const id of ids) {
    const e = loadCase(id).expected;
    for (const p of [...(e.summary_has || []), ...(e.summary_lacks || []), ...(e.rows_not || []).map((r) => r.text).filter(Boolean), ...[e.pre_existing].filter((p) => typeof p === 'string'), ...e.findings.map((f) => f.text).filter(Boolean)]) new RegExp(p, 'i');
  }
});

test('parseSummary takes an item kind from its section heading (bare items) and still reads the old labelled items; Details never inherit a heading', () => {
  const md = [
    '## SpecGuard', '', '**❌ 4 unit test gaps to fix**', '', '### ❌ Missing unit tests (2)', '',
    '- [Posted](https://github.com/o/r/pull/1#discussion_r1) `a.js:3` — posted', '- Kept here [`b.js:7`](https://github.com/o/r/blob/x/b.js#L7) (inline limit reached) — text', '',
    '### ❌ Weak unit tests (1)', '', '- Weak one `c.js:9` — why', '',
    '### ❌ Requirements to check (1)', '', '| Status | Criterion | Next step |', '|---|---|---|', '| ❌ Gap | **R1** x | Missing test: y |', '',
    '### ❌ Coding standard violations (1)', '', '- Throw an Error `d.js:1` — rule: `RULES.md`', '',
    '<details><summary>Details: x</summary>', '', '**Low-confidence findings (1)**', '', '- ❌ **Weak test:** Old label `e.js:2` (low confidence) — z', '- note `f.js:5` is not an item', '', '</details>'].join('\n');
  assert.deepEqual(parseSummary(md).items.map((i) => [i.kind, i.path, i.line, i.why]), [['missing_test', 'b.js', 7, 'inline limit reached'], ['weak_test', 'c.js', 9, ''], ['standard', 'd.js', 1, ''], ['weak_test', 'e.js', 2, 'low confidence']]);
  assert.deepEqual(parseSummary('### Unit test gaps (1)\n\n- ❌ **Missing test:** Old `a.js:3` — x\n').items.map((i) => i.kind), ['missing_test']);
  assert.deepEqual(parseSummary('### ❌ Requirements to check (1)\n\n- stray `a.js:3` — x\n').items, []);
});

test('parseSummary reads the redesigned summary: linked (posted) titles are not summary items, the obligations table uses status words, Details sections are bold headings', () => {
  const md = [
    '<!-- specguard:summary -->', '## SpecGuard', '', '**❌ 2 unit test gaps and 1 spec mismatch to fix**',
    '- ❌ **Missing test:** [Posted one](https://github.com/o/r/pull/1#discussion_r1) `a.js:3` — posted',
    '- ❌ **Weak test:** Kept here `b.js:7` (outside the diff) — text',
    '- ❌ **Violation:** Throw an Error [`c.js:9`](https://github.com/o/r/blob/x/c.js#L9) — rule: `RULES.md`',
    '', '<details><summary>Details: x</summary>', '',
    '| Obligation | Source / behaviour | Assertion evidence / layer | Status / reason |', '|---|---|---|---|',
    '| O1: a | PR body; a.js:3 — q | none | Missing test: no test |', '| O2: b | PR body; b.js:7 — q | unit | Evidenced: fine |', '',
    '**Pre-existing drift (not caused by this PR)**', '', '- **Mismatch:** Old drift `d.js:1` — old', '  more text', '', '**Validation notes (1)**', '', '- One note.', '', '**Sources read**', '', '- x', '', '</details>'].join('\n');
  const s = parseSummary(md);
  assert.deepEqual(s.items.map((i) => [i.kind, i.path, i.line, i.why]), [['weak_test', 'b.js', 7, 'outside the diff'], ['standard', 'c.js', 9, ''], ['spec_mismatch', 'd.js', 1, '']]);
  assert.deepEqual(s.rows.map((r) => [r.status, r.path]), [['missing_test', 'a.js'], ['covered', 'b.js']]);
  assert.equal(s.preExisting.startsWith('- **Mismatch:** Old drift'), true);
  assert.equal(s.preExisting.includes('Sources read'), false);
  assert.deepEqual(s.notes, ['One note.']);
  assert.equal(parseSummary('**⚠️ Could not complete: x**').incomplete, true);
  assert.equal(parseSummary('> - The diff exceeded `max_diff_kb` and was truncated.').incomplete, true);
});
