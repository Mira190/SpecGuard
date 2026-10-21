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

test('a visible summary-only finding that matches nothing is a FP and breaks expect_clean; one that served a TP, an acceptable one or one in Details is not', () => {
  const visible = '<!-- specguard:summary -->\n## SpecGuard\n\n### Missing unit tests (1)\n\n- Extra `b.js:4` — body\n';
  const r = grade(spec([], { expect_clean: true }), obs([], { summary: visible }));
  assert.deepEqual([r.fp, r.false_positives[0].level, r.clean_ok, r.pass], [1, 'summary', false, false]);
  const tp = grade(spec([exp({ path: 'b.js', line: 4, allow_summary: true })]), obs([], { summary: visible }));
  assert.deepEqual([tp.tp, tp.fp], [1, 0], 'the item that matched the expected finding is not also a FP');
  assert.deepEqual([grade(spec([], { acceptable: [{ kind: 'missing_test', path: 'b.js', line: 4, reason: 'truly untested' }] }), obs([], { summary: visible })).fp], [0]);
  const hidden = `${visible.replace(/### [^\n]+\n\n- [^\n]+\n/, '')}\n<details><summary>Details: more</summary>\n\n**Not reviewed**\n\n- Extra \`b.js:4\` — body\n</details>\n`;
  assert.equal(grade(spec([], { expect_clean: true }), obs([], { summary: hidden })).clean_ok, true);
});

test('one summary item or row matches at most one expected finding; its text is checked like a posted one (review F15)', () => {
  const two = [exp({ line: 10, allow_summary: true }), exp({ line: 12, allow_summary: true })];
  const one = obs([], { summary: summaryWith('- \u274c **Missing test:** Unrelated `a.js:11` \u2014 body\n') });
  const r = grade(spec(two), one);
  assert.deepEqual([r.tp, r.fn, r.pass], [1, 1, false]);
  const both = obs([], { summary: summaryWith('- \u274c **Missing test:** Boundary A `a.js:10` \u2014 x\n- \u274c **Missing test:** Boundary B `a.js:12` \u2014 y\n') });
  assert.deepEqual([grade(spec(two), both).tp, grade(spec(two), both).fp], [2, 0], 'two items, two hits');
  const t = grade(spec([exp({ allow_summary: true, text: 'exact-now' })]), one);
  assert.deepEqual([t.tp, t.text_misses.length, t.pass], [1, 1, false], 'the expected behaviour text applies to a summary hit too');
});

test('allow_summary counts a summary item or coverage row matching kind and path', () => {
  const e = exp({ allow_summary: true, path: ['p.js', 'p.spec.js'], kind: ['weak_test', 'missing_test'], tolerance: 10 }); // the line tolerance is the identity; path and kind alone are not
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
  const u = parseSummary(summaryWith('') + '| O1: a | src; x.js:5 — q | none | Unconfirmed: r |\n| O2: a | src; y.js:6 — q | none | Not assessed: r |\n');
  assert.deepEqual(u.rows.map((r) => [r.status, r.path]), [['unknown', 'x.js'], ['unknown', 'y.js']], 'the new label and the old one both parse');
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
    '### ❌ Requirements to check (1)', '', '| Status | Requirement | What to do |', '|---|---|---|', '| ❌ Gap | x | Add the test: y |', '',
    '### ❌ Coding standard violations (1)', '', '- Throw an Error `d.js:1` — rule: `RULES.md`', '',
    '<details><summary>Details: x</summary>', '', '**Low-confidence findings (1)**', '', '- ❌ **Weak test:** Old label `e.js:2` (low confidence) — z', '- Bare in Details `f.js:5` — must not inherit the Weak heading', '', '</details>'].join('\n');
  assert.deepEqual(parseSummary(md).items.map((i) => [i.kind, i.path, i.line, i.why]), [['missing_test', 'b.js', 7, 'inline limit reached'], ['weak_test', 'c.js', 9, ''], ['standard', 'd.js', 1, ''], ['weak_test', 'e.js', 2, 'low confidence']]);
  assert.deepEqual(parseSummary('### Unit test gaps (1)\n\n- ❌ **Missing test:** Old `a.js:3` — x\n').items.map((i) => i.kind), ['missing_test']);
  assert.deepEqual(parseSummary('### ❌ Requirements to check (1)\n\n- stray `a.js:3` — x\n').items, []);
  assert.deepEqual(parseSummary('### Missing unit tests (1)\n\n- Plain `a.js:3` — x\n\n### Weak unit tests (1)\n\n- Plain two `b.js:4` — y\n\n### Requirements to check (1)\n\n- stray `c.js:1` — z\n').items.map((i) => i.kind), ['missing_test', 'weak_test'], 'headings without an icon');
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

// F29: one logical finding rendered as a summary item and a coverage row is one match identity.
const { buildSummary } = require('../src/post.js');
const mirrored = () => {
  const f = { kind: 'missing_test', path: 'a.js', line: 10, title: 'Boundary A', body: 'Missing assertion', confidence: 'high', obligation_id: 'O1' };
  const b = { path: 'a.js', line: 10, quote: 'return boundary(value);' };
  const data = { requirements: [], requirements_source: 'none', not_reviewed: '', coverage: [{ id: 'O1', obligation: 'Boundary A', source: 'from behaviour', behaviour: b, change: b, evidence: [], status: 'missing_test', reason: 'No test', alignment: { status: 'not_applicable', reason: 'No explicit requirement' } }], findings: [f], standards: { status: 'no_rules', sources: [], reason: 'None' }, layering: { status: 'checked', reason: 'No higher layer tests' } };
  return buildSummary({ cov: { reports: 0 }, data, items: [{ f, why: 'not on diff' }], notes: [], blob: 'https://github.com/example/repo/blob/abc/' });
};

test('F29: a summary item and its mirrored coverage row are one finding, not two true positives', () => {
  const summary = mirrored(), one = { kind: 'missing_test', path: 'a.js', line: 10, allow_summary: true };
  const parsed = parseSummary(summary);
  assert.deepEqual([parsed.items.length, parsed.rows.length], [1, 1]);
  const s = spec([one, { ...one, line: 30 }]);
  const g = grade(s, obs([], { summary }));
  assert.deepEqual([g.tp, g.fn, g.pass], [1, 1, false]);
  const noRow = grade(s, obs([], { summary: summary.split('\n').filter((l) => !l.startsWith('| O1:')).join('\n') }));
  assert.deepEqual([noRow.tp, noRow.fn], [1, 1], 'same result without the mirror');
});

test('F29 control: two distinct findings, each as item plus row, are two true positives', () => {
  const item = (t, n) => `- ${t} \`a.js:${n}\` — x\n`, row = (id, t, n) => `| ${id}: ${t} | PR body; a.js:${n} — code | none | Missing test: no test |\n`;
  const summary = `### Missing unit tests (2)\n\n${item('Boundary A', 10)}${item('Boundary B', 30)}\n${row('O1', 'Boundary A', 10)}${row('O2', 'Boundary B', 30)}`;
  const one = { kind: 'missing_test', path: 'a.js', line: 10, allow_summary: true };
  const g = grade(spec([one, { ...one, line: 30 }]), obs([], { summary }));
  assert.deepEqual([g.tp, g.fn, g.fp, g.pass], [2, 0, 0, true]);
});

test('F29: an item and its row citing different lines for the same obligation count once', () => {
  const summary = '### Missing unit tests (1)\n\n- Boundary A `a.js:10` — x\n\n| O1: Boundary A | PR body; a.js:30 — code | none | Missing test: no test |\n';
  const one = { kind: 'missing_test', path: 'a.js', line: 10, allow_summary: true };
  const g = grade(spec([one, { ...one, line: 30 }]), obs([], { summary }));
  assert.deepEqual([g.tp, g.fn, g.pass], [1, 1, false]);
});

test('F29: an inline comment and its summary copy are not counted twice', () => {
  const one = { kind: 'missing_test', path: 'a.js', line: 10, tolerance: 50, allow_summary: true };
  const g = grade(spec([one, { ...one, line: 30 }]), obs([com({ line: 10 })], { summary: mirrored() }));
  assert.deepEqual([g.tp, g.fn, g.fp], [1, 1, 0]);
});

// S10: an unexpected "Missing test" coverage row is a false positive like the same gap as a summary item, counted once.
test('S10: a wrong coverage row counts as a false positive, the same as the gap listed as a summary item', () => {
  const b = { path: 'a.js', line: 10, quote: 'return boundary(value);' };
  const f = { kind: 'missing_test', path: 'a.js', line: 10, title: 'Boundary A', body: 'Missing assertion', confidence: 'high', obligation_ids: ['O1'] };
  const mk = (findings, items) => buildSummary({ cov: { reports: 0 }, data: { requirements: [], requirements_source: 'none', not_reviewed: '', coverage: [{ id: 'O1', obligation: 'Boundary A', source: 'from behaviour', behaviour: b, change: b, evidence: [], status: 'missing_test', reason: 'No test', alignment: { status: 'not_applicable', reason: 'No explicit requirement' } }], findings, standards: { status: 'no_rules', sources: [], reason: 'None' }, layering: { status: 'checked', reason: 'No higher layer tests' } }, items, notes: [], blob: 'https://github.com/example/repo/blob/abc/' });
  const clean = { id: 'clean', goal: 'requirements', expected: { findings: [], expect_clean: true } };
  const coverageRowOnly = grade(clean, obs([], { summary: mk([], []) }));
  const sameGapAsSummaryItem = grade(clean, obs([], { summary: mk([f], [{ f, why: 'not on diff' }]) }));
  assert.equal(coverageRowOnly.fp, sameGapAsSummaryItem.fp);
  assert.equal(coverageRowOnly.fp, 1);
  assert.equal(coverageRowOnly.clean_ok, false);
});

// S10 review: a row whose gap is also a posted comment is one candidate, not two (the item case is covered above; F29 tests cover the matched case).
test('S10: a coverage row for a gap that is also a posted comment counts once', () => {
  const b = { path: 'a.js', line: 10, quote: 'return boundary(value);' };
  const f = { kind: 'missing_test', path: 'a.js', line: 10, title: 'Boundary A', body: 'Missing assertion', confidence: 'high', obligation_ids: ['O1'] };
  const summary = buildSummary({ cov: { reports: 0 }, data: { requirements: [], requirements_source: 'none', not_reviewed: '', coverage: [{ id: 'O1', obligation: 'Boundary A', source: 'from behaviour', behaviour: b, change: b, evidence: [], status: 'missing_test', reason: 'No test', alignment: { status: 'not_applicable', reason: 'No explicit requirement' } }], findings: [f], standards: { status: 'no_rules', sources: [], reason: 'None' }, layering: { status: 'checked', reason: 'No higher layer tests' } }, items: [], notes: [], blob: 'https://github.com/example/repo/blob/abc/' });
  const g = grade({ id: 'clean', goal: 'requirements', expected: { findings: [], expect_clean: true } }, obs([com({ line: 10 })], { summary }));
  assert.equal(g.fp, 1);
});

test('a coverage row whose assertion evidence sits at the posted comment is the same finding, not an FP (PR 296)', () => {
  const summary = '<!-- specguard:summary -->\n## SpecGuard\n\n<details><summary>Details: x</summary>\n\n| Obligation | Source / behaviour | Assertion evidence / layer | Status / reason |\n|---|---|---|---|\n'
    + '| O1: clamp returns the maximum | PR body; t2/limits.js:2 — return Math.min(); | unit: t2/limits.test.js:6 —   assert.ok(clamp(15, 0, 10)); (assertion) | Weak test: only truthy. |\n</details>\n';
  const g = grade(spec([exp({ kind: 'weak_test', path: 't2/limits.test.js', line: 6 })]), obs([com({ kind: 'weak_test', path: 't2/limits.test.js', line: 6 })], { summary }));
  assert.deepEqual([g.tp, g.fp], [1, 0]);
  assert.equal(grade(spec([]), obs([], { summary })).fp, 1); // control: without the comment the row is a FP
});

// U4 contract: a coverage row is a request for action only when its gap's finding is actionable. A low-confidence/Details copy of the same gap
// is explicitly discounted, so the row is not an FP; a row with no finding at all still counts (S10).
test('coverage-row FP contract: row with a low-confidence copy is not an FP; the row alone is', () => {
  const { buildSummary } = require('../src/post');
  const clean = { id: 'c', goal: 'requirements', expected: { findings: [], expect_clean: true } };
  const b = { path: 'a.js', line: 10, quote: 'return boundary(value);' };
  const row = '| O1: Boundary A | PR body; a.js:10 — return boundary(value); | none | Missing test: No test |\n';
  const data = { requirements: [], requirements_source: 'none', not_reviewed: '', coverage: [{ id: 'O1', obligation: 'Boundary A', source: 'from behaviour', behaviour: b, change: b, evidence: [], status: 'missing_test', reason: 'No test', alignment: { status: 'not_applicable', reason: 'No explicit requirement' } }], findings: [], standards: { status: 'no_rules', sources: [], reason: 'None' }, layering: { status: 'checked', reason: 'None' } };
  const f = { kind: 'missing_test', path: 'a.js', line: 10, title: 'Boundary A', body: 'Missing assertion', confidence: 'low', obligation_ids: ['O1'] };
  const built = buildSummary({ cov: { reports: 0 }, data: { ...data, findings: [f] }, items: [{ f, why: 'low confidence' }], notes: [], blob: 'https://github.com/example/repo/blob/abc/' });
  const o = (summary) => ({ comments: [], reviews: [], summary, latency_s: 1 });
  const hidden = grade(clean, o(built)), alone = grade(clean, o('## SpecGuard\n\n' + row));
  assert.equal(hidden.fp, 0); assert.equal(hidden.clean_ok, true);
  assert.equal(alone.fp, 1); assert.equal(alone.clean_ok, false);
});

// M1/M3/M4 (shift-left review 2026-10-17): delivered recall shares the FP exposure set; end-to-end recall keeps errored runs.
const mkSummary = (confidence, why) => {
  const b = { path: 'a.js', line: 10, quote: 'return boundary(value);' };
  const f = { kind: 'missing_test', path: 'a.js', line: 10, title: 'Boundary A', body: 'Missing assertion', confidence, obligation_ids: ['O1'] };
  return buildSummary({ cov: { reports: 0 }, data: { requirements: [], requirements_source: 'none', not_reviewed: '', coverage: [{ id: 'O1', obligation: 'Boundary A', source: 'from behaviour', behaviour: b, change: b, evidence: [], status: 'missing_test', reason: 'No test', alignment: { status: 'not_applicable', reason: 'No explicit requirement' } }], findings: [f], standards: { status: 'no_rules', sources: [], reason: 'None' }, layering: { status: 'checked', reason: 'None' } }, items: [{ f, why }], notes: [], blob: 'https://github.com/example/repo/blob/abc/' });
};
const sumSpec = spec([exp({ allow_summary: true })]);

test('M1: a low-confidence Details-only hit is a raw TP but not a delivered TP, and costs no FP on a clean case', () => {
  const low = mkSummary('low', 'low confidence');
  const g = grade(sumSpec, obs([], { summary: low }));
  assert.deepEqual([g.tp, g.fn, g.tp_delivered, g.fn_delivered, g.pass, g.strict_pass], [1, 0, 0, 1, true, false]);
  const clean = grade(spec([], { expect_clean: true }), obs([], { summary: low }));
  assert.deepEqual([clean.fp, clean.clean_ok], [0, true]);
});

test('M1 control: an actionable summary-only finding is a delivered TP; so is a posted comment', () => {
  const g = grade(sumSpec, obs([], { summary: mkSummary('high', 'not on diff') }));
  assert.deepEqual([g.tp, g.tp_delivered, g.fn_delivered, g.strict_pass], [1, 1, 0, true]);
  const p = grade(spec(), obs([com()]));
  assert.deepEqual([p.tp, p.tp_delivered, p.strict_pass], [1, 1, true]);
});

test('delivered recall for coverage rows: a row with no finding is delivered; a row whose group has only a low-confidence item is not', () => {
  const row = '| O1: Boundary A | PR body; a.js:10 — return boundary(value); | none | Missing test: No test |\n';
  const alone = grade(sumSpec, obs([], { summary: '## SpecGuard\n\n' + row }));
  assert.deepEqual([alone.tp, alone.tp_delivered], [1, 1]);
  const hidden = grade(sumSpec, obs([], { summary: mkSummary('low', 'low confidence') }));
  assert.deepEqual([hidden.tp, hidden.tp_delivered, hidden.summary_only], [1, 0, 1]);
});

test('strict_pass_rate counts strict passes; rows from old result files give null, not the pass rate', () => {
  const good = grade(spec(), obs([com()])), loose = grade(spec(), obs([com(), com({ line: 50 })]));
  const a = aggregate([good, loose]);
  assert.deepEqual([a.pass_rate, a.strict_pass_rate, a.strict_pass_n, a.strict_pass_missing], [1, 0.5, 2, 0]);
  const { strict_pass, tp_delivered, fn_delivered, ...old } = good;
  const o = aggregate([old, loose]);
  assert.deepEqual([o.strict_pass_rate, o.strict_pass_n, o.strict_pass_missing, o.recall_delivered, o.recall_delivered_e2e], [null, 1, 1, null, null]);
});

test('M3: 1 TP + 1 FP is an acceptance pass but not a strict pass', () => {
  const g = grade(spec(), obs([com(), com({ line: 50 })]));
  assert.deepEqual([g.tp, g.fp, g.pass, g.strict_pass], [1, 1, true, false]);
});

test('M4: an errored positive run stays in the end-to-end denominator and is not an FP', () => {
  const ok = grade(spec(), obs([com()]));
  const a = aggregate([{ ...ok, goal: 'requirements' }, { goal: 'requirements', error: 'timeout', expected_findings: 1 }]);
  assert.deepEqual([a.recall, a.precision, a.pass_rate, a.recall_delivered, a.recall_delivered_e2e, a.errors, a.errors_expected_findings, a.fp], [1, 1, 1, 1, 0.5, 1, 1, 0]);
});

test('precision_delivered uses delivered TPs; precision stays on raw TPs', () => {
  const rows = [{ goal: 'g', tp: 1, tp_delivered: 0, fn: 0, fn_delivered: 1, fp: 1 }];
  const a = aggregate(rows);
  assert.deepEqual([a.precision, a.precision_delivered], [0.5, 0]);
  assert.equal(aggregate([{ goal: 'g', tp: 0, tp_delivered: 0, fn: 0, fn_delivered: 0, fp: 0 }]).precision_delivered, null);
  const old = aggregate([{ goal: 'g', tp: 1, fn: 0, fp: 1, summary_only: 0 }]);
  assert.deepEqual([old.precision, old.precision_delivered, old.recall_delivered], [0.5, null, null], 'old rows without tp_delivered: unknown, not 0');
});

test('an errored row without expected_findings makes e2e recall unknown; stamped rows keep the number', () => {
  const ok = { ...grade(spec(), obs([com()])), goal: 'g' };
  const legacy = aggregate([ok, { goal: 'g', error: 'x' }]);
  assert.deepEqual([legacy.recall_delivered_e2e, legacy.unknown_expected], [null, 1]);
  const stamped = aggregate([ok, { goal: 'g', error: 'x', expected_findings: 1 }]);
  assert.deepEqual([stamped.recall_delivered_e2e, stamped.unknown_expected], [0.5, 0]);
});

test('parseComment tolerates a medium-confidence comment (V2 relabel)', () => {
  const c = parseComment({ path: 'a.js', line: 7, body: '**T**\n\nkind: weak_test, confidence: medium' });
  assert.deepEqual([c.kind, c.confidence], ['weak_test', 'medium']);
});
