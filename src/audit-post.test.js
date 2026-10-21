const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const audit = require('./audit-post');
const { validate, verify, render, MARK, TITLE, HEADING } = audit;

const DATE = '2026-10-13'; // the audit date stored in the scan state
const SCHEMA = JSON.parse(fs.readFileSync(path.join(__dirname, 'audit.schema.json'), 'utf8'));
const FILES = {
  'docs/design.md': ['# Plan design', '', 'A repeating plan stays on after it fires.', 'A plan must start in the future.'],
  'src/plan.js': ['function fire(p) {', '  if (p.repeat) return p;', '  return { ...p, on: false };', '}'],
  'tests/plan.test.js': ['test("repeat stays on", () => {', '  assert.equal(fire({ repeat: true }).on, true);', '});'],
};
const read = (p) => FILES[p] || null;
const C1 = '1111111a', C2 = '2222222b', C3 = '3333333c';
const cand = (cid, line, text) => ({ cid, path: 'docs/design.md', line, heading: 'Plan design', text });
const candsOf = (...cs) => new Map(cs.map((c) => [c.cid, c]));
const ONE = () => candsOf(cand(C1, 3, 'A repeating plan stays on after it fires.'));
const TWO = () => candsOf(cand(C1, 3, 'A repeating plan stays on after it fires.'), cand(C2, 4, 'A plan must start in the future.'));
const candTxt = (m) => [...m.values()].map((c) => `${c.cid}\t${c.path}:${c.line}\t${c.heading}\t${c.text}\n`).join('');
const cid = (i) => i.toString(16).padStart(8, '0');
const cite = (path, line) => ({ path, line, quote: FILES[path][line - 1] });
const req = (over = {}) => ({
  id: C1, source: cite('docs/design.md', 3), text: 'A repeating plan stays on after it fires.', class: 'unit', status: 'covered',
  code: [cite('src/plan.js', 2)], tests: [{ ...cite('tests/plan.test.js', 2), layer: 'unit' }], note: '', ...over,
});
const result = (rs = [req()], over = {}) => ({ docs_reviewed: ['docs/design.md'], requirements: rs, not_requirements: [], not_reviewed: [], unit_findings: [], ...over });
const clone = (o) => JSON.parse(JSON.stringify(o));

test('validate: accepts a good result and the enum lists match audit.schema.json', () => {
  assert.deepEqual(validate(result()), { ok: true });
  assert.deepEqual(validate(result([])), { ok: true });
  const item = SCHEMA.properties.requirements.items.properties;
  assert.deepEqual(item.status.enum, audit.STATUS);
  assert.deepEqual(item.class.enum, audit.CLASS);
  assert.deepEqual(item.tests.items.properties.layer.enum, ['unit', 'component', 'integration', 'e2e']);
  assert.deepEqual(SCHEMA.properties.requirements.items.required.sort(), ['class', 'code', 'id', 'note', 'source', 'status', 'tests', 'text']);
  assert.deepEqual(SCHEMA.required.slice().sort(), ['docs_reviewed', 'not_requirements', 'not_reviewed', 'requirements', 'unit_findings']);
  assert.deepEqual(SCHEMA.properties.not_requirements.items.required, ['cid', 'reason']);
  assert.equal(SCHEMA.properties.requirements_found, undefined);
});

test('validate: rejects an unusable output and names the failing JSON path; clips long quotes', () => {
  const bad = (mutate, re) => { const o = result(); mutate(o); const v = validate(o); assert.equal(v.ok, false); assert.match(v.error, re); };
  bad((o) => { o.requirements[0].status = 'fine'; }, /requirements\[0\]: status must be one of/);
  bad((o) => { o.requirements[0].class = 'integration'; }, /requirements\[0\]: class not stated/);
  bad((o) => { delete o.requirements[0].text; }, /requirements\[0\]: id and text/);
  bad((o) => { delete o.requirements[0].source; }, /requirements\[0\]: source needs/);
  bad((o) => { o.requirements[0].source.line = 0; }, /requirements\[0\]: source needs/);
  bad((o) => { o.requirements[0].code = 'none'; }, /requirements\[0\]: code must be an array/);
  bad((o) => { o.requirements = [null]; }, /requirements\[0\]: not an object/);
  bad((o) => { delete o.requirements; }, /requirements must be an array/);
  bad((o) => { o.requirements.push({ id: 'x' }, { id: 'y' }); }, /requirements\[1\]: id and text are required \(2 of 3 requirement rows are unusable\)/);
  for (const x of [null, [], 'x', 3]) assert.equal(validate(x).ok, false);
  assert.match(validate([]).error, /\$ is not an object/);
  const long = result([req({ source: { ...cite('docs/design.md', 3), quote: 'x'.repeat(300) } })]);
  assert.equal(validate(long).ok, true);
  assert.equal(long.requirements[0].source.quote.length, 200);
  const noNote = result([req()]); delete noNote.requirements[0].note;
  assert.equal(validate(noNote).ok, true);
  assert.equal(noNote.requirements[0].note, '');
});

test('validate: cosmetic defects are normalised and per-row problems degrade only the row, with a note', () => {
  const ok = (mutate, extra = []) => { const o = result([req(), ...extra]); mutate(o); assert.deepEqual(validate(o), { ok: true }); return o; };
  let o = ok((x) => { x.docs_reviewed = 3; x.not_reviewed = 'none'; x.not_requirements = 'none'; });
  assert.deepEqual([o.docs_reviewed, o.not_requirements], [[], []]);
  assert.match(o.not_reviewed.join('|'), /docs_reviewed was not an array[\s\S]*not_reviewed was not an array[\s\S]*not_requirements was not an array/);
  o = ok((x) => { Object.assign(x.requirements[0], { status: 'Covered', class: ' UNIT ' }); x.requirements[0].source.line = '3'; x.requirements[0].tests[0].layer = 'Unit'; x.requirements[0].code[0].line = '2'; });
  assert.deepEqual([o.requirements[0].status, o.requirements[0].class, o.requirements[0].source.line, o.requirements[0].tests[0].layer, o.requirements[0].code[0].line], ['covered', 'unit', 3, 'unit', 2]);
  o = ok((x) => { x.requirements[0].status = 'Missing Test'; x.requirements[0].class = 'higher-level'; });
  assert.deepEqual([o.requirements[0].status, o.requirements[0].class], ['missing_test', 'higher_level']);
  o = ok((x) => { x.requirements[0].tests[0].layer = 'system'; x.requirements[0].code.push({ path: 'a', line: 1 }); });
  assert.deepEqual([o.requirements[0].tests.length, o.requirements[0].code.length], [0, 1]);
  assert.match(o.not_reviewed.join('|'), /requirements\[0\]: 1 malformed code citation\(s\) ignored[\s\S]*1 malformed tests citation/);
  o = ok(() => {}, [req({ id: C2, status: 'great' })]); // one unusable row of two is not more than half
  assert.deepEqual(o.requirements.map((r) => [r.id, r.status, r.class]), [[C1, 'covered', 'unit'], [C2, 'unknown', 'unit']]);
  assert.match(o.not_reviewed.join('|'), /requirements\[1\] marked unknown: status must be one of/);
  o = ok(() => {}, [req()]); // a duplicate id: dropped, the rest stands
  assert.equal(o.requirements.length, 1);
  assert.match(o.not_reviewed.join('|'), /requirements\[1\] dropped: duplicate id/);
  const d = validate(result([req({ id: C1, text: undefined })]), ONE()); // the block's own text comes from the candidate list
  assert.equal(d.ok, true);
  const nr = (c) => ({ cid: c, reason: 'rationale, not behaviour' });
  const w = result([req()], { not_requirements: [nr('nope'), { cid: C2 }, nr('ffffffff'), nr(C2), nr(C2)] });
  assert.deepEqual(validate(w, TWO()), { ok: true });
  assert.deepEqual(w.not_requirements, [nr(C2)]);
  assert.match(w.not_reviewed.join('|'), /not_requirements\[0\] ignored: it needs a block cid[\s\S]*unknown block ffffffff[\s\S]*duplicate block/);
});

test('validate: a not_requirements entry whose reason says the block was not assessed is an unanswered block, not a non-requirement', () => {
  const D = ['4444444d', '5555555e', '6666666f', '7777777a', '8888888b'], six = () => candsOf(cand(C1, 3, 'A.'), cand(C2, 4, 'B.'), ...D.map((c, i) => cand(c, 5 + i, 'C.'))), others = D.map((c) => ({ cid: c, reason: 'rationale, not behaviour' })); // six blocks: one unanswered stays under MISSING_MAX
  const bad = ['not assessed in this run', 'crash recovery behaviour not assessed', 'Shortcut set not fully reviewed', 'Live settings ranges need deeper review', 'Not yet reviewed', 'unassessed'];
  for (const reason of bad) {
    const o = result([req()], { not_requirements: [{ cid: C2, reason }, ...others] });
    assert.deepEqual(validate(o, six()), { ok: true }, reason);
    assert.equal(o.not_requirements.length, D.length, reason);
    assert.ok(!o.not_requirements.some((n) => n.cid === C2), reason);
    assert.match(o.not_reviewed.join('|'), /was not assessed.*counts as not reviewed/, reason);
  }
  for (const reason of ['Document introduction, no checkable behaviour', 'UI hint text only', 'rationale, reviewed and not behaviour']) {
    const o = result([req()], { not_requirements: [{ cid: C2, reason }, ...others] });
    validate(o, six());
    assert.equal(o.not_requirements.length, D.length + 1, `control: ${reason}`);
  }
});

test('verify: good citations pass, a near-miss line is corrected, an untracked or escaping path fails', () => {
  const o = result([req({ code: [{ ...cite('src/plan.js', 2), line: 4 }] })]);
  const v = verify(o, { read, tracked: new Set(Object.keys(FILES)), docs: new Set(['docs/design.md']) });
  assert.equal(v.requirements.length, 1);
  assert.equal(v.requirements[0].status, 'covered');
  assert.equal(v.requirements[0].code[0].line, 2, 'line snapped to where the quote is');
  const far = verify(result([req({ code: [{ ...cite('src/plan.js', 2), line: 40 }] })]), { read }); // the line is a hint: the one place the quote is wins
  assert.equal(far.requirements[0].status, 'covered');
  assert.equal(far.requirements[0].code[0].line, 2);
  const twice = { ...FILES, 'src/plan.js': [...FILES['src/plan.js'], ...FILES['src/plan.js']] }; // the same quote twice: never choose
  assert.equal(verify(result([req({ code: [{ ...cite('src/plan.js', 2), line: 40 }] })]), { read: (p) => twice[p] || null }).requirements[0].status, 'unknown');
  assert.equal(verify(result([req({ code: [{ ...cite('src/plan.js', 2), line: 6 }] })]), { read: (p) => twice[p] || null }).requirements[0].code[0].line, 6, 'within 5 lines of the hint it is the near one');
  const untracked = verify(result([req({ code: [cite('src/plan.js', 2)] })]), { read, tracked: new Set(['docs/design.md', 'tests/plan.test.js']) });
  assert.equal(untracked.requirements[0].status, 'unknown');
  for (const p of ['../x.js', '/etc/passwd', 'src\\plan.js']) {
    const w = verify(result([req({ code: [{ path: p, line: 1, quote: 'x' }] })]), { read: (q) => FILES[q] || ['x'] });
    assert.equal(w.requirements[0].code.length, 0, p);
  }
});

test('verify: a bad requirement quote moves the row to not_reviewed with the reason', () => {
  const bad = req({ id: 'R2', source: { path: 'docs/design.md', line: 3, quote: 'A plan never turns off.' } });
  const v = verify(result([req(), bad]), { read });
  assert.equal(v.requirements.length, 1);
  assert.match(v.not_reviewed.join('\n'), /R2 \(docs\/design\.md:3\): the requirement quote was not found at the cited line/);
});

test('verify: a source outside the admitted documents is not reviewed', () => {
  const o = result([req({ source: cite('src/plan.js', 1) })]);
  const v = verify(o, { read, docs: new Set(['docs/design.md']) });
  assert.equal(v.requirements.length, 0);
  assert.match(v.not_reviewed[0], /not an admitted requirement document/);
});

test('verify: a bad test quote removes the evidence and covered becomes unknown', () => {
  const o = result([req({ tests: [{ path: 'tests/plan.test.js', line: 2, quote: 'assert.equal(fire(x), 99);', layer: 'unit' }] })]);
  const v = verify(o, { read });
  const r = v.requirements[0];
  assert.equal(r.status, 'unknown');
  assert.deepEqual(r.tests, []);
  assert.match(r.note, /1 citation\(s\) could not be verified and were removed\. Downgraded to unknown: covered needs a unit test citation/);
  const code = verify(result([req({ code: [{ path: 'src/plan.js', line: 2, quote: 'nope' }] })]), { read }).requirements[0];
  assert.equal(code.status, 'unknown');
  assert.match(code.note, /covered needs a code citation/);
});

// outside the test body: SpecGuard's own skip detector reads the span from a test declaration to the cited line
const SKIP_FILES = { ...FILES, 'tests/skip.test.js': ['test.skip("repeat stays on", () => {', '  assert.equal(fire({ repeat: true }).on, true);', '});', 'test("repeat stays on, empty body", () => {', '});'] };
test('verify: a skipped, empty or declaration-only test cannot carry covered (same rule as PR mode); a real assertion still does', () => {
  const files = SKIP_FILES;
  const rd = (p) => files[p] || null;
  const at = (line) => verify(result([req({ tests: [{ path: 'tests/skip.test.js', line, quote: files['tests/skip.test.js'][line - 1], layer: 'unit' }] })]), { read: rd }).requirements[0];
  for (const line of [1, 2, 4]) {
    const r = at(line);
    assert.equal(r.status, 'unknown', `line ${line}`);
    assert.match(r.note, /1 test citation\(s\) removed: not an assertion or in a skipped test\. Downgraded to unknown/);
  }
  assert.equal(verify(result(), { read: rd }).requirements[0].status, 'covered', 'control: a running assertion covers');
});

test('verify: a variable, a commented-out assertion or an import line cannot carry covered (review F13)', () => {
  for (const line of ['const expectedTotal = 42;', '// assert.equal(total, 42);', "const assert = require('node:assert/strict');"]) {
    const rd = (p) => (p === 'tests/only.test.js' ? [line] : FILES[p] || null);
    const r = verify(result([req({ tests: [{ path: 'tests/only.test.js', line: 1, quote: line, layer: 'unit' }] })]), { read: rd }).requirements[0];
    assert.equal(r.status, 'unknown', line);
  }
});

test('verify: evidence that cannot carry the status downgrades; a sound row is left alone', () => {
  const ok = (over) => verify(result([req(over)]), { read }).requirements[0];
  assert.equal(ok({ class: 'human' }).status, 'unknown');
  assert.equal(ok({ class: 'static', tests: [] }).status, 'covered');
  assert.equal(ok({ class: 'higher_level', tests: [] }).status, 'unknown');
  assert.equal(ok({ class: 'unit', tests: [{ ...cite('tests/plan.test.js', 2), layer: 'e2e' }] }).status, 'unknown');
  assert.equal(ok({ status: 'partial', tests: [] }).status, 'unknown');
  assert.equal(ok({ status: 'missing_test', code: [], tests: [] }).status, 'unknown');
  assert.equal(ok({ status: 'missing_test', tests: [] }).status, 'missing_test');
  assert.equal(ok({ status: 'not_implemented', code: [], tests: [] }).status, 'not_implemented');
  assert.equal(ok({ status: 'needs_human', class: 'human', code: [], tests: [] }).status, 'needs_human');
  assert.equal(ok({ status: 'contradicted', code: [], tests: [] }).status, 'unknown');
});

test('validate: every result names a listed block (an unusable majority is rejected); cid.N ids are accepted', () => {
  const rej = (o, re, cands = TWO()) => { const v = validate(o, cands); assert.equal(v.ok, false); assert.match(v.error, re); };
  const nr = (c, reason = 'rationale, not behaviour') => ({ cid: c, reason });
  rej(result([req({ id: 'R1' })], { not_requirements: [nr(C2)] }), /id R1 is not a listed block id/);
  rej(result([req({ id: 'ffffffff' })], { not_requirements: [nr(C2)] }), /not a listed block id/);
  rej(result([req({ id: `${C1}.0` })], { not_requirements: [nr(C2)] }), /not a listed block id/);
  // a block answered both ways is a conflict for a person, never a deletion: the row stays as unknown and leaves not_requirements
  const both = result([req()], { not_requirements: [nr(C1, 'volume range is rationale')] });
  assert.deepEqual(validate(both, ONE()), { ok: true });
  assert.deepEqual([both.requirements.length, both.requirements[0].status, both.not_requirements.length], [1, 'unknown', 0]);
  assert.match(both.requirements[0].note, /Also answered as not a requirement \(volume range is rationale\); status unknown until a person decides/);
  assert.match(both.not_reviewed.join('\n'), /block 1111111a was answered both as a requirement and as not a requirement; kept as unknown/);
  // review F17: the conflicting requirement row is malformed (no source) and dropped; the block still never becomes a non-requirement
  const bad = result([req({ source: null }), req({ id: C2, source: cite('docs/design.md', 4), text: 'A plan must start in the future.' })], { not_requirements: [nr(C1)] });
  assert.deepEqual(validate(bad, TWO()), { ok: true });
  assert.equal(bad.not_requirements.length, 0);
  const vb = verify(bad, { read, cands: TWO() });
  assert.deepEqual([vb.requirements.map((r) => [r.id, r.status]), vb.not_requirements.length], [[[C1, 'unknown'], [C2, 'covered']], 0]);
  const v = verify(both, { read, cands: ONE() });
  assert.deepEqual([v.requirements.map((r) => [r.id, r.status]), v.not_requirements.length], [[[C1, 'unknown']], 0]);
  assert.deepEqual(validate(result([req()], { not_requirements: [nr(C2)] }), TWO()), { ok: true });
  assert.deepEqual(validate(result([req({ id: `${C1}.1` }), req({ id: `${C1}.2` })], { not_requirements: [nr(C2)] }), TWO()), { ok: true }, 'a bundled block yields cid.1, cid.2');
});

test('validate: up to 20% of the blocks may be unanswered (they become unknown); more is rejected and names the missing cids', () => {
  const five = candsOf(...[1, 2, 3, 4, 5].map((i) => cand(cid(i), 3, `block ${i}`)));
  const row = (i) => req({ id: cid(i) });
  const nr = (i) => ({ cid: cid(i), reason: 'an example only' });
  assert.deepEqual(validate(result([row(1), row(2), row(3)], { not_requirements: [nr(4)] }), five), { ok: true }, '1 of 5 missing = 20%');
  const v = validate(result([row(1), row(2), row(3)]), five);
  assert.equal(v.ok, false);
  assert.match(v.error, /2 of 5 listed blocks were not answered \(e\.g\. 00000004, 00000005\)/);
  assert.equal(validate(result([]), five).ok, false);
  assert.deepEqual(validate(result([]), candsOf()), { ok: true }, 'no candidates, nothing to answer');
  assert.deepEqual(validate(result([row(1), row(2), row(3), row(4)], { not_requirements: [nr(5)] }), five), { ok: true });
  assert.equal(validate(result([req({ id: 'R1' })]), null).ok, true, 'without a candidate list only the structure is checked');
});

test('verify: the id is the block cid, the heading comes from the candidate, and rows keep document order across .N rows', () => {
  const three = candsOf(cand(C1, 3, 'A repeating plan stays on after it fires.'), cand(C2, 4, 'A plan must start in the future.'), cand(C3, 3, 'x'));
  const o = result([req({ id: C2, source: cite('docs/design.md', 4) }), req({ id: `${C1}.2`, text: 'second' }), req({ id: `${C1}.1`, text: 'first' })], { not_requirements: [{ cid: C3, reason: 'rationale only' }] });
  assert.equal(validate(o, three).ok, true);
  const v = verify(o, { read, cands: three });
  assert.deepEqual(v.requirements.map((x) => x.id), [`${C1}.2`, `${C1}.1`, C2], 'candidate order first, the model order within a block');
  assert.deepEqual(v.requirements.map((x) => x.heading), ['Plan design', 'Plan design', 'Plan design']);
  assert.equal(v.requirements[0].doc_id, undefined);
  assert.deepEqual(v.not_requirements, [{ ...three.get(C3), reason: 'rationale only' }]);
});

test('verify: a block the model skipped, or whose rows all failed verification, becomes an unknown "unconfirmed" row', () => {
  const missed = verify(result([req()]), { read, cands: TWO() });
  assert.deepEqual(missed.requirements.map((x) => [x.id, x.status]), [[C1, 'covered'], [C2, 'unknown']]);
  assert.equal(missed.requirements[1].note, 'Unconfirmed: the model did not assess this block.');
  assert.deepEqual(missed.requirements[1].source, { path: 'docs/design.md', line: 4, quote: 'A plan must start in the future.' });
  assert.equal(missed.requirements[1].text, 'A plan must start in the future.');
  const bad = req({ id: C2, source: { path: 'docs/design.md', line: 4, quote: 'A plan never turns off at all.' } });
  const failed = verify(result([req(), bad]), { read, cands: TWO() });
  assert.deepEqual(failed.requirements.map((x) => [x.id, x.status]), [[C1, 'covered'], [C2, 'unknown']]);
  assert.match(failed.requirements[1].note, /Unconfirmed: the model's citation for this block did not verify\./);
  assert.match(failed.not_reviewed.join('\n'), new RegExp(`${C2} \\(docs/design\\.md:4\\): the requirement quote was not found`));
  const skipped = verify(result([req()], { not_requirements: [{ cid: C2, reason: 'rationale only' }] }), { read, cands: TWO() });
  assert.equal(skipped.requirements.length, 1, 'a not_a_requirement block gets no row');
});

const sample = () => {
  const rs = [req(), req({ id: C2, text: 'A plan must start in the future.', source: cite('docs/design.md', 4), class: 'unit', status: 'missing_test', tests: [], note: 'No test rejects a past start.' }),
    req({ id: C3, status: 'needs_human', class: 'human', code: [], tests: [], text: 'The plan list looks calm.' })];
  return verify(result(rs, { not_reviewed: ['docs/old.md: unreadable'] }), { read });
};

test('render: the verdict counts gaps, the visible tables are what to act on, everything else is in one Details block', () => {
  const md = render({ data: sample(), docs: [['docs/design.md', 'discovered']], blob: 'https://github.com/o/r/blob/abc', usage: '<sub>Engine: copilot</sub>', cap: 80, candidates: 131, head: 'abc1234def' });
  const vis = md.slice(0, md.indexOf('<details>'));
  assert.match(vis, /^## SpecGuard scan\n\n\*\*❌ 1 new gap \(first report\)\*\* in the design documents at `abc1234`\. Static review; tests were not run\.\n\n### New gaps \(1\)\n\n\| Document says \| Next step \|\n\|---\|---\|\n\| \[docs\/design\.md:4\]\(https:\/\/github\.com\/o\/r\/blob\/abc\/docs\/design\.md#L4\) A plan must start in the future\. \| Add a unit test that checks it\. \|\n\n$/);
  assert.doesNotMatch(vis, /\d\s*%|percent|Unsure|Covered|Sub-row|missing_test|needs_human/i, 'nothing else is visible');
  assert.equal((md.match(/<details>/g) || []).length, 1, 'one disclosure layer');
  const det = md.slice(md.indexOf('<details>'));
  assert.match(det, /\*\*This scan\*\*\n\n\*\*3 requirements\*\* from 1 document\n\n3 blocks scanned of 131 in the documents \(cap 80\)\.\n\nBy block: new gap \(first report\) 1 · unsure 1 · covered 1\n\nThis is the first scan run[^\n]*every gap is a \*\*first report\*\*; one more scan run will show/);
  assert.doesNotMatch(md, /\d\s*%|percent/i);
  assert.match(det, /\*\*How to read this scan\*\*\n\nStatic review; not coverage; not for scoring people\./);
  assert.match(det, /\*\*Unsure \(1\)\*\*\n\n\| Block[^\n]*\n\|---[^\n]*\n\| `3333333c`[^\n]*\| unsure \| needs human ×1 \|\n/);
  assert.match(det, /\*\*Covered \(1\)\*\*\n\n\| Block[^\n]*\n\|---[^\n]*\n\| `1111111a`[^\n]*\| covered \| covered ×1 \|\n/);
  const at = (x) => md.indexOf(x);
  assert.ok(at('### New gaps') < at('<details>') && at('**Unsure') < at('**Covered') && at('**Covered') < at('**Sub-row evidence') && at('**Sub-row evidence') < at('**Sources**'));
  // the per-sub-row evidence is one table per document
  assert.match(det, /\*\*Sub-row evidence: docs\/design\.md \(3 rows\)\*\*\n\n\| Requirement \| Status \| Class \| Evidence \|\n\|---\|---\|---\|---\|\n/);
  assert.match(md, /\| \[2222222b\]\(https:\/\/github\.com\/o\/r\/blob\/abc\/docs\/design\.md#L4\) A plan must start in the future\.<br><sub>No test rejects a past start\.<\/sub> \| missing test \| unit \| code: \[src\/plan\.js:2\]\(https:\/\/github\.com\/o\/r\/blob\/abc\/src\/plan\.js#L2\) \|/);
  assert.match(md.slice(md.indexOf('**Sub-row evidence')), /tests: unit \[tests\/plan\.test\.js:2\]/);
  assert.match(md, /`not_implemented` and `missing_test` are model claims|Not implemented and missing test are model claims \(not verified statically\)/);
  assert.match(md, /\*\*Not reviewed \(1 item\)\*\*\n\n- docs\/old\.md: unreadable\n/, 'a complete run lists Not reviewed in Details');
  assert.doesNotMatch(md, /### Not reviewed/);
  const part = render({ data: sample(), partial: 'engine timeout' });
  assert.match(part, /### Not reviewed \(1\)\n\n- docs\/old\.md: unreadable\n/, 'an incomplete run keeps the reasons visible');
  assert.doesNotMatch(part, /\*\*Not reviewed \(/);
  assert.doesNotMatch(md, /not requirements\*\*/, 'no block when every block was a requirement');
  assert.equal(md.trimEnd().split('\n').pop(), '<sub>Engine: copilot</sub>', 'the cost line is the last line');
  assert.ok(md.lastIndexOf('<sub>Engine: copilot</sub>') > md.lastIndexOf('</details>'), 'outside Details, not folded');
  assert.equal((md.match(/Engine: copilot/g) || []).length, 1);
});

test('render: rejected candidate documents say how to include them; unread admitted documents are listed; markup in model text is neutralised', () => {
  const data = result([req({ text: 'Click <img src=x> @team <!-- hidden --> | pipe', note: '' })]);
  const md = render({ data, docs: [['docs/design.md', 'discovered'], ['docs/other.md', 'discovered']], rejected: [['README.md', 'only 1 normative item']] });
  assert.doesNotMatch(md, /### Documents not included/, 'never in the visible body');
  const src = md.slice(md.indexOf('**Sources**'));
  assert.match(src, /^\*\*Sources\*\*\n\n- Requirement documents: `docs\/design\.md` \(discovered\), `docs\/other\.md` \(discovered\)\n- 1 candidate document was not admitted \(add to `requirements_paths` to include\):\n {2}- `README\.md`: only 1 normative item\n/);
  assert.equal(md.replace(/<details>[\s\S]*?<\/details>/g, '').includes('README.md'), false, 'the rejected document appears only inside Details');
  assert.doesNotMatch(md, /Candidates not admitted/, 'a plain list, no third disclosure level');
  assert.match(md, /`docs\/other\.md` was admitted but is not in docs_reviewed\./);
  assert.doesNotMatch(md, /<img|<!--|@team/);
  assert.match(md, /\\\| pipe/);
});

test('render: no documents and failures say so', () => {
  assert.match(render({ data: null, rejected: [['README.md', 'x']] }), /\*\*No design documents were found, so nothing was scanned\.\*\*[\s\S]*\*\*Sources\*\*[\s\S]*1 candidate document was not admitted/);
  const failed = render({ failure: 'the engine timed out', usage: '<sub>Cost $0.01 · m</sub>', run: 'Run: engine copilot' });
  assert.match(failed, /^## SpecGuard scan\n\n\*\*⚠️ Could not complete: the engine timed out\*\*\n/);
  assert.doesNotMatch(failed.slice(0, failed.indexOf('<details>')), /###/);
  assert.match(failed, /<details><summary>Details: run information<\/summary>[\s\S]*Run: engine copilot[\s\S]*<\/details>\n\n<sub>Cost \$0\.01 · m<\/sub>\n$/);
});

test('render: blocks that were not requirements are counted in the header and listed in a collapsed block, not in the tables', () => {
  const data = verify(result([req()], { not_requirements: [{ cid: C2, reason: 'rationale, not behaviour <b>x</b>' }] }), { read, cands: TWO() });
  const md = render({ data, blob: 'https://github.com/o/r/blob/abc', candidates: 9, cap: 5, capLeft: ['docs/design.md § 4. After: 3 blocks not scanned (cap)'] });
  assert.match(md, /2 blocks scanned of 9 in the documents \(cap 5\)\./);
  assert.doesNotMatch(md.slice(0, md.indexOf('<details>')), /not a requirement|not requirements/, 'only Details says it');
  assert.ok(md.includes('**1 block was not a requirement**\n\n- [docs/design.md:4](https://github.com/o/r/blob/abc/docs/design.md#L4) `2222222b` A plan must start in the future. (rationale, not behaviour &lt;b>x&lt;/b>)'), md);
  assert.doesNotMatch(md.slice(0, md.indexOf('<details>')), /2222222b/, 'not in the main tables');
  assert.match(md, /\*\*Not reviewed \(1 item\)\*\*\n\n- docs\/design\.md § 4\. After: 3 blocks not scanned \(cap\)\n/);
  assert.doesNotMatch(md, /<b>/, "markup in the reason is neutralised");
  const two = render({ data: { ...data, not_requirements: [data.not_requirements[0], data.not_requirements[0]] }, candidates: 2 });
  assert.match(two, /\*\*2 blocks were not requirements\*\*/);
});

test('render: over the limit, whole rows are dropped (never cut mid-row) and the omission is stated', () => {
  const rs = Array.from({ length: 60 }, (_, i) => req({ id: cid(i + 1), status: 'missing_test', tests: [], note: 'n'.repeat(250) }));
  const data = verify(result(rs), { read });
  const full = render({ data });
  const small = render({ data, max: 9000 });
  assert.ok(Buffer.byteLength(small) <= 9000 && small.length < full.length);
  const tableRows = small.split('\n').filter((l) => /^\| (?:\[|docs\/)/.test(l));
  assert.ok(tableRows.length > 0);
  for (const l of tableRows) assert.match(l, /\|$/, 'every kept row is complete');
  assert.match(small, /_\d+ rows omitted: the report exceeded the size limit/);
  assert.match(small, /Static review; not coverage/, 'header survives');
});

// ---- publishing ----
function workspace(t, files = FILES) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'specguard-audit-post-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const git = (...a) => execFileSync('git', ['-c', 'core.autocrlf=false', ...a], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init'); git('config', 'user.name', 't'); git('config', 'user.email', 't@example.invalid');
  for (const [f, ls] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true }); fs.writeFileSync(path.join(root, f), ls.join('\n') + '\n'); }
  git('add', '.'); git('commit', '-m', 'x');
  const ctx = path.join(root, '.specguard-ctx');
  fs.mkdirSync(ctx);
  return { root, ctx, put: (n, v) => fs.writeFileSync(path.join(ctx, n), typeof v === 'string' ? v : JSON.stringify(v)) };
}
function mocks({ issues = [], login = null, failList = false, failWrite = false, failSummary = false } = {}) {
  const calls = { created: [], updated: [], summary: '', warnings: [], outputs: {}, statuses: [] };
  const github = {
    paginate: async (fn) => { if (failList) throw new Error('403'); return fn(); },
    rest: { users: { getAuthenticated: async () => { if (!login) throw new Error('no /user for GITHUB_TOKEN'); return { data: { login } }; } },
      issues: { listForRepo: () => issues, create: async (a) => { if (failWrite) throw new Error('403 write'); calls.created.push(a); }, update: async (a) => { if (failWrite) throw new Error('403 write'); calls.updated.push(a); } } },
  };
  const core = { warning: (m) => calls.warnings.push(m), setOutput: (k, v) => { calls.outputs[k] = v; if (k === 'status') calls.statuses.push(v); }, summary: { addRaw(s) { calls.summary = s; return this; }, async write() { if (failSummary) throw new Error('disk full'); } } };
  return { github, core, calls, context: { repo: { owner: 'o', repo: 'r' }, sha: 'abc123' } };
}
const BOT = { type: 'Bot', login: 'github-actions[bot]' };
async function runPost(t, { ctxFiles = {}, env = {}, mock = {}, files } = {}) {
  const w = workspace(t, files);
  w.put('audit-meta.json', { head: 'abc123', max_requirements: 80, docs: 1, limitations: [] });
  w.put('audit-docs.txt', 'docs/design.md\tdiscovered\n');
  w.put('audit-candidates.txt', candTxt(ONE()));
  for (const [n, v] of Object.entries(ctxFiles)) w.put(n, v);
  const m = mocks(mock);
  const saved = { ...process.env };
  Object.assign(process.env, { CTX: w.ctx, GITHUB_WORKSPACE: w.root, ENGINE: '', MODEL: '', SKIP: '', AUDIT_ISSUE: 'false', ...env });
  try { await audit({ github: m.github, context: m.context, core: m.core, date: DATE }); } finally { for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]; Object.assign(process.env, saved); }
  return { ...m, w };
}

test('run: validates citations at HEAD, renders the summary, writes audit.json, usage line included, no issue by default', async (t) => {
  const bad = req({ id: C2, source: { path: 'docs/design.md', line: 4, quote: 'not in the doc at all' } });
  const r = await runPost(t, { ctxFiles: { 'findings.json': result([req(), bad]), 'audit-candidates.txt': candTxt(TWO()), 'usage.json': { totalNanoAiu: 2e9 } }, env: { ENGINE: 'copilot', MODEL: 'auto' } });
  assert.match(r.calls.summary, /\*\*2 requirements\*\* from 1 document/);
  assert.match(r.calls.summary, /2222222b \(docs\/design\.md:4\): the requirement quote was not found/);
  assert.match(r.calls.summary, /Unconfirmed: the model's citation for this block did not verify/);
  assert.match(r.calls.summary, /\n<sub>Cost ≈ \$0\.02 \(2\.00 AI credits\) · auto<\/sub>\n$/);
  assert.match(r.calls.summary, /\nRun: engine copilot\nSpecGuard build [0-9a-f]{12}\n\n<\/details>/);
  assert.match(r.calls.summary, /\]\(https:\/\/github\.com\/o\/r\/blob\/abc123\/src\/plan\.js#L2\)/);
  const saved = JSON.parse(fs.readFileSync(path.join(r.w.ctx, 'audit.json'), 'utf8'));
  assert.equal(saved.head, 'abc123');
  assert.equal(saved.requirements.length, 2);
  assert.equal(saved.requirements[0].id, C1);
  assert.deepEqual([r.calls.created, r.calls.updated], [[], []]);
});

test('run: missing, invalid or failed engine output is reported as could not complete, never as an audit', async (t) => {
  const none = await runPost(t);
  assert.match(none.calls.summary, /Could not complete: the engine returned no usable JSON/);
  const invalid = await runPost(t, { ctxFiles: { 'findings.json': result([req({ status: 'great' })]) } });
  assert.match(invalid.calls.summary, /Could not complete: the result failed validation: requirements\[0\]: status must be one of/);
  const unlisted = await runPost(t, { ctxFiles: { 'findings.json': result([req({ id: 'R1' })]) } });
  assert.match(unlisted.calls.summary, /Could not complete: the result failed validation: requirements\[0\]: id R1 is not a listed block id/);
  const gaps = await runPost(t, { ctxFiles: { 'findings.json': result([]) } });
  assert.match(gaps.calls.summary, /failed validation: 1 of 1 listed blocks were not answered \(e\.g\. 1111111a\)/);
  const timeout = await runPost(t, { ctxFiles: { 'engine-status': 'timeout\n' } });
  assert.match(timeout.calls.summary, /the engine timed out/);
  assert.equal(fs.existsSync(path.join(timeout.w.ctx, 'audit.json')), false);
  const skip = await runPost(t, { env: { SKIP: 'true' }, ctxFiles: { 'audit-rejected.txt': 'README.md\tonly 1 normative item\n' } });
  assert.match(skip.calls.summary, /No design documents were found[\s\S]*README\.md/);
  const failed = await runPost(t, { mock: {}, ctxFiles: { 'audit-meta.json': 'not json' } });
  assert.match(failed.calls.summary, /the collection step did not produce its context/);
  assert.deepEqual([none, invalid, unlisted, gaps, timeout, skip, failed].flatMap((x) => [...x.calls.created, ...x.calls.updated]), []);
});

test('run: audit_issue true creates one issue titled and marked for us', async (t) => {
  const r = await runPost(t, { ctxFiles: { 'findings.json': result() }, env: { AUDIT_ISSUE: 'true' } });
  assert.equal(r.calls.created.length, 1);
  assert.equal(r.calls.updated.length, 0);
  const c = r.calls.created[0];
  assert.deepEqual([c.owner, c.repo, c.title], ['o', 'r', TITLE]);
  assert.ok(c.body.startsWith(`${MARK}\n## ${HEADING}`));
  assert.equal(c.title, 'SpecGuard: unit test gap scan');
  assert.ok(c.body.includes('Static review; not coverage; not for scoring people.'));
});

test('run: audit_issue updates our own issue, and ignores a same-marker issue by someone else and PRs', async (t) => {
  const mine = { number: 7, body: `${MARK}\nold`, user: BOT };
  const forged = { number: 3, body: `${MARK}\nforged`, user: { type: 'User', login: 'mallory' } };
  const forgedBot = { number: 4, body: `${MARK}\nforged`, user: { type: 'Bot', login: 'other-app[bot]' } };
  const pr = { number: 5, body: `${MARK}\npr`, user: BOT, pull_request: {} };
  const other = { number: 6, body: 'unrelated', user: BOT };
  const r = await runPost(t, { ctxFiles: { 'findings.json': result() }, env: { AUDIT_ISSUE: 'true' }, mock: { issues: [forged, forgedBot, pr, other, mine] } });
  assert.deepEqual(r.calls.updated.map((u) => u.issue_number), [7]);
  assert.equal(r.calls.created.length, 0);
  assert.equal(r.calls.updated[0].title, TITLE);
  const none = await runPost(t, { ctxFiles: { 'findings.json': result() }, env: { AUDIT_ISSUE: 'true' }, mock: { issues: [forged, forgedBot, pr, other] } });
  assert.equal(none.calls.created.length, 1, 'only foreign marked issues exist: a new one is created');
  const authed = await runPost(t, { ctxFiles: { 'findings.json': result() }, env: { AUDIT_ISSUE: 'true' }, mock: { login: 'my-app[bot]', issues: [mine, { number: 8, body: `${MARK}\nx`, user: { type: 'Bot', login: 'my-app[bot]' } }] } });
  assert.deepEqual(authed.calls.updated.map((u) => u.issue_number), [8], 'identity is the authenticated actor when /user is readable');
});

test('run: an issue failure only warns; the summary is still written', async (t) => {
  const r = await runPost(t, { ctxFiles: { 'findings.json': result() }, env: { AUDIT_ISSUE: 'true' }, mock: { failList: true } });
  assert.match(r.calls.summary, /requirement/);
  assert.match(r.calls.warnings.join('\n'), /could not write the scan issue \(needs permissions: issues: write\)/);
});

test('run: the issue body fits GitHub\'s limit by dropping whole rows and says so', async (t) => {
  const D = ['docs/a.md', 'docs/b.md', 'docs/c.md', 'docs/d.md']; // the per-document evidence list is capped, so the overflow needs several documents
  const mk = (i) => ({ ...req({ id: cid(i + 1), text: `Requirement ${i + 1} ${'w'.repeat(280)}`, note: 'n'.repeat(290) }), source: { ...cite('docs/design.md', 3), path: D[i % 4] } });
  const rs = Array.from({ length: 80 }, (_, i) => mk(i));
  const files = { ...FILES, ...Object.fromEntries(D.map((d) => [d, FILES['docs/design.md']])) };
  const r = await runPost(t, { files, ctxFiles: { 'audit-docs.txt': D.map((d) => `${d}\tdiscovered\n`).join(''), 'findings.json': result(rs, { docs_reviewed: D }), 'audit-candidates.txt': candTxt(candsOf(...rs.map((x) => ({ ...cand(x.id, 3, 'x'), path: x.source.path })))) }, env: { AUDIT_ISSUE: 'true' } });
  const body = r.calls.created[0].body;
  assert.ok(Buffer.byteLength(body) <= 65536, String(Buffer.byteLength(body)));
  assert.match(body, /_\d+ rows omitted: the report exceeded the size limit/);
  assert.match(body, /<!-- specguard:audit-state \{"v":4,/, 'the previous state survives the cut');
  for (const l of body.split('\n').filter((x) => x.startsWith('| ['))) assert.match(l, /\| unit \| code: .* \|$/);
  assert.ok(r.calls.summary.length > body.length, 'the job summary keeps every row');
  assert.doesNotMatch(r.calls.summary, /rows omitted/);
});

// ---- citation strength, ids, contradictions, change view, partial runs ----
test('verify: a quote under 12 non-space characters is no evidence (requirement quote drops the row)', () => {
  const short = verify(result([req({ code: [{ path: 'src/plan.js', line: 1, quote: 'function' }] })]), { read }).requirements[0];
  assert.equal(short.code.length, 0);
  assert.equal(short.status, 'unknown');
  const src = verify(result([req({ source: { path: 'docs/design.md', line: 1, quote: '# Plan' } })]), { read });
  assert.equal(src.requirements.length, 0);
  assert.match(src.not_reviewed[0], /under 12 characters/);
});

test('verify: tests must sit in a test path, code must be neither a document nor a test file; layer must fit the class', () => {
  const files = { ...FILES, 'README.md': ['This README says the plan repeats and that assert.equal(fire(x)).'], 'docs/spec.md': ['assert.equal(fire({ repeat: true }).on, true);'] };
  const rd = (p) => files[p] || null;
  const row = (over) => verify(result([req(over)]), { read: rd, docs: new Set(['docs/design.md']) }).requirements[0];
  const inReadme = row({ tests: [{ path: 'README.md', line: 1, quote: 'assert.equal(fire(x)).', layer: 'unit' }] });
  assert.deepEqual([inReadme.tests.length, inReadme.status], [0, 'unknown']);
  const inSpecDoc = row({ tests: [{ path: 'docs/spec.md', line: 1, quote: files['docs/spec.md'][0], layer: 'unit' }] });
  assert.equal(inSpecDoc.tests.length, 0, 'spec.md matches the test-path rule but is a document');
  const notTest = row({ tests: [{ ...cite('src/plan.js', 2), layer: 'unit' }] });
  assert.equal(notTest.tests.length, 0);
  assert.equal(row({ code: [cite('tests/plan.test.js', 2)] }).code.length, 0, 'a test file is not code evidence');
  assert.equal(row({ code: [{ path: 'docs/design.md', line: 3, quote: files['docs/design.md'][2] }] }).code.length, 0, 'a requirement document is not code evidence');
  assert.equal(row({ class: 'higher_level', tests: [{ ...cite('tests/plan.test.js', 2), layer: 'unit' }] }).status, 'unknown', 'a unit test does not carry a higher-level requirement');
  assert.equal(row({ class: 'higher_level', tests: [{ ...cite('tests/plan.test.js', 2), layer: 'e2e' }] }).status, 'covered');
  assert.equal(row({ class: 'static', tests: [] }).status, 'covered');
});

test('verify: the id is the block cid whatever the model wrote in the text or the quoted line, so a moved line keeps it', () => {
  const id = (over, read_ = read) => verify(result([req(over)]), { read: read_, cands: ONE() }).requirements[0];
  const a = id({}), b = id({ text: 'worded differently by the model' });
  assert.equal(a.id, C1);
  assert.equal(a.id, b.id, 'the model\'s wording does not change it');
  assert.equal(a.heading, 'Plan design');
  const moved = { ...FILES, 'docs/design.md': ['# Plan design', '', '', 'A repeating plan stays on after it fires.'] };
  const m = id({ source: { path: 'docs/design.md', line: 4, quote: 'A repeating plan stays on after it fires.' } }, (p) => moved[p] || null);
  assert.deepEqual([m.id, m.source.line], [C1, 4], 'the cited line moved, the id did not');
});

test('contradicted: both quotes must verify, and it renders as a disagreement with the two quotes side by side, labelled unconfirmed until a second run', () => {
  const ok = verify(result([req({ status: 'contradicted', class: 'unit', tests: [], note: 'the code turns it off' })]), { read }).requirements[0];
  assert.equal(ok.status, 'contradicted');
  const bad = verify(result([req({ status: 'contradicted', tests: [], code: [{ path: 'src/plan.js', line: 2, quote: 'this line is not in the code' }] })]), { read }).requirements[0];
  assert.equal(bad.status, 'unknown');
  const data = { ...result(), requirements: [ok] };
  const md = render({ data, blob: 'https://github.com/o/r/blob/abc' });
  assert.match(md, /### Documents and code disagree \(1\)\n\nA model judgement: only the existence of both quotes was verified\.[^\n]*\n\n\| Document says \| Code says \|\n\|---\|---\|\n/);
  assert.match(md, /\| "A repeating plan stays on after it fires\."<br>\[docs\/design\.md:3\][^\n]*\| "  if \(p\.repeat\) return p;"<br>\[src\/plan\.js:2\]/);
  assert.match(md, /\| The code contradicts it: see Documents and code disagree\. \|/, 'the gap row points at the disagreement');
  const prior = audit.readState(audit.stateComment('aaaaaaa1', data)); // the same block was a gap in the previous run
  const two = render({ data, prior });
  assert.match(two, /### Reported in two runs \(1\)[\s\S]*### Documents and code disagree \(1\)/);
});

// ---- block aggregation and confirmation across runs ----
const one = (id, status) => req({ id, status, class: 'unit', code: [cite('src/plan.js', 2)], tests: [] });
const dataOf = (spec, notReq = []) => ({ ...result(), requirements: Object.entries(spec).flatMap(([c, ss]) => [].concat(ss).map((s, i) => one(`${c}${[].concat(ss).length > 1 ? `.${i + 1}` : ''}`, s))), not_requirements: notReq });
// one audit run after another: the state of each run is read back as the next run's prior
function chain(...runs) {
  let state = '';
  return runs.map((spec, i) => {
    const d = dataOf(spec), prior = audit.readState(state), blocks = audit.track(audit.blocksOf(d), prior, `h${i + 1}`);
    state = audit.stateComment(`h${i + 1}`, d, prior);
    return { blocks, marks: Object.fromEntries(blocks.map((b) => [b.cid, b.mark])), md: render({ data: d, prior, head: `h${i + 1}` }), state, prior };
  });
}
const A = cid(10), B = cid(11), U = cid(12), Z = cid(13);

test('blocks: sub-rows aggregate to one status per block (gap beats everything, covered needs all, the rest is unsure, skipped blocks are not_req)', () => {
  const d = dataOf({ [cid(1)]: ['missing_test', 'covered'], [cid(2)]: ['covered', 'covered'], [cid(3)]: ['covered', 'unknown'], [cid(4)]: 'needs_human', [cid(5)]: 'partial', [cid(6)]: 'contradicted', [cid(7)]: ['unknown', 'not_implemented'], [cid(8)]: 'unknown' },
    [{ cid: cid(9), path: 'docs/design.md', line: 4, text: 'why', reason: 'rationale' }]);
  const bs = audit.blocksOf(d);
  assert.deepEqual(bs.map((b) => [b.cid, b.status]), [[cid(1), 'gap'], [cid(2), 'covered'], [cid(3), 'unsure'], [cid(4), 'unsure'], [cid(5), 'gap'], [cid(6), 'gap'], [cid(7), 'gap'], [cid(8), 'unsure'], [cid(9), 'not_req']]);
  assert.equal(bs[0].rows.length, 2);
  const md = render({ data: d });
  assert.match(md, /### New gaps \(4\)/);
  for (const next of ['Add a unit test that checks it.', 'Strengthen the unit test: it checks only part of it.', 'The code contradicts it: see Documents and code disagree.', 'Not implemented: add the behaviour and a unit test.']) assert.ok(md.includes(`| ${next} |`), next);
});

test('confirmation: gap twice is confirmed, a new gap is unconfirmed, a confirmed gap covered once is "resolved? recheck", covered twice is resolved', () => {
  const r = chain({ [A]: 'missing_test', [U]: 'unknown', [Z]: 'covered' }, { [A]: 'partial', [B]: 'missing_test', [U]: 'missing_test', [Z]: 'unknown' }, { [A]: 'covered', [B]: 'missing_test', [U]: 'unknown', [Z]: 'covered' }, { [A]: 'covered', [B]: 'covered', [U]: 'unknown', [Z]: 'covered' }, { [A]: 'covered', [B]: 'covered', [U]: 'unknown', [Z]: 'covered' });
  assert.deepEqual(r.map((x) => x.marks[A]), ['new', 'confirmed', 'recheck', 'resolved', '']);
  assert.deepEqual(r.map((x) => x.marks[B]), [undefined, 'new', 'confirmed', 'recheck', 'resolved']);
  assert.deepEqual(r.map((x) => x.marks[U]), ['', 'new', '', '', ''], 'an unsure block becoming a gap is unconfirmed');
  // counters: [cid, status, firstSeenHead, consecutive runs]; the first-seen head survives while the status holds
  assert.deepEqual(r[1].blocks.find((b) => b.cid === A).next, [A, 'gap', 'h1', 2, 'partial', 0]);
  assert.deepEqual(r[2].blocks.find((b) => b.cid === A).next, [A, 'recheck', 'h3', 1]);
  assert.deepEqual(r[3].blocks.find((b) => b.cid === A).next, [A, 'covered', 'h3', 2]);
  assert.deepEqual(r[4].blocks.find((b) => b.cid === A).next, [A, 'covered', 'h3', 3]);
  const many = chain(...Array.from({ length: 14 }, () => ({ [A]: 'missing_test' })));
  assert.equal(many[13].blocks[0].next[3], 3, 'the run counter is capped');
  assert.equal(many[13].marks[A], 'confirmed');
  // a recheck that turns into a gap again is a new, unconfirmed gap
  const flap = chain({ [A]: 'missing_test' }, { [A]: 'missing_test' }, { [A]: 'covered' }, { [A]: 'missing_test' });
  assert.equal(flap[3].marks[A], 'new');
});

test('render: first run says one more run will confirm; later runs list confirmed gaps first, then new gaps, then collapsed unsure and covered', () => {
  const [first, second] = chain({ [A]: 'missing_test', [B]: 'missing_test', [U]: 'unknown', [Z]: 'covered' }, { [A]: 'missing_test', [B]: 'covered', [cid(14)]: 'partial', [U]: 'unknown', [Z]: 'covered' });
  assert.match(first.md, /first scan run[^\n]*every gap is a \*\*first report\*\*; one more scan run will show/);
  assert.doesNotMatch(first.md, /### Reported in two runs|Changed since the last scan/);
  assert.match(first.md, /By block: new gap \(first report\) 2 · unsure 1 · covered 1\n/);
  const md = second.md;
  assert.doesNotMatch(md, /first scan run/);
  assert.match(md, /By block: reported in two runs 1 · new gap \(first report\) 1 · unsure 1 · covered 2\n/);
  assert.match(md, /A gap is \*\*reported in two runs\*\* when the block was a gap in this run and in the previous one \(`h1`\)/);
  assert.match(md, /### Reported in two runs \(1\)\n\n\| Document says \| Next step \|\n\|---\|---\|\n\| docs\/design\.md:\d+ /);
  assert.match(md, /### New since the last scan \(1\)\n\n\| Document says \| Next step \|/);
  const at = (x) => md.indexOf(x);
  assert.ok(at('### Reported in two runs') < at('### New since') && at('### New since') < at('<details>') && at('<details>') < at('**Changed since') && at('**Changed since') < at('**Unsure (1)**') && at('**Unsure (1)**') < at('**Covered (2)**') && at('**Covered (2)**') < at('**Sub-row evidence'));
  assert.match(md, /\*\*Unsure \(1\)\*\*\n\n\| Block/);
  assert.match(md, /\*\*Covered \(2\)\*\*\n\n\| Block/);
});

test('changed since last audit: only 2-run-stable changes are listed; status churn is a count line', () => {
  const [, second, third, fourth] = chain({ [A]: 'missing_test', [U]: 'unknown', [Z]: 'covered', [B]: 'missing_test' }, { [A]: 'missing_test', [U]: 'missing_test', [Z]: 'unknown', [B]: 'covered' },
    { [A]: 'covered', [U]: 'unknown', [Z]: 'covered', [B]: 'covered' }, { [A]: 'covered', [U]: 'unknown', [Z]: 'covered', [B]: 'covered' });
  assert.match(second.md, new RegExp(`\\*\\*Changed since the last scan \\(\`h1\`\\)\\*\\*\\n\\n- Reported in two runs, newly \\(1\\):\\n  - \`${A}\` [^\\n]*\\n\\nUnstable: 3 blocks changed status between the last two runs \\(not listed\\)\\.\\n`));
  assert.doesNotMatch(second.md.slice(second.md.indexOf('**Changed'), second.md.indexOf('**This scan**')), new RegExp(`${U}|${Z}|${B}`), 'unsure churn is counted, not listed');
  assert.match(third.md, new RegExp(`- Resolved\\? Covered once, recheck next run \\(1\\):\\n  - \`${A}\``));
  assert.match(third.md, /Unstable: 2 blocks changed status/);
  assert.match(fourth.md, new RegExp(`- Resolved \\(covered in two runs\\) \\(1\\):\\n  - \`${A}\``));
  assert.doesNotMatch(fourth.md, /Unstable/);
  assert.match(chain({ [A]: 'covered' }, { [A]: 'covered' })[1].md, /\*\*Changed since the last scan \(`h1`\)\*\*\n\nNo confirmed changes\.\n/);
});

test('state: v4 round trip and tamper check; v3 and a v2 (per-row) state still read as one prior run; v1 and foreign comments are no state', () => {
  const rows = verify(result([req(), req({ id: C2, source: cite('docs/design.md', 4), status: 'missing_test', tests: [], text: 'A plan must start in the future.' })]), { read, cands: TWO() });
  const state = audit.stateComment('abc123def', rows, null, { date: DATE });
  assert.match(state, /^<!-- specguard:audit-state \{"v":4,"head":"abc123def","audits":\[\["abc123d","2026-10-13"\]\],"blocks":\[\["1111111a","covered","abc123d",1,0\],\["2222222b","gap","abc123d",1,0,"missing_test",0]],"ev":\[\["1111111a","f76d5660","487bebfb"\]\]\} -->$/); // ev: sha8 of the files the covered verdict cited (F06)
  const at = { head: 'abc123d', date: '2026-10-13' };
  assert.deepEqual(audit.readState(`${MARK}\nbody\n${state}`), { head: 'abc123def', blocks: [{ cid: C1, status: 'covered', since: 'abc123d', runs: 1, at }, { cid: C2, status: 'gap', since: 'abc123d', runs: 1, at, top: 'missing_test', hl: 0 }],
    versions: { uv: {}, ev: { [C1]: ['f76d5660', '487bebfb'] } } }); // sha8('src/plan.js'), sha8('tests/plan.test.js')
  // v3 (no audit dates) is the previous format: it reads with an unknown audit date
  const v3 = audit.readState('<!-- specguard:audit-state {"v":3,"head":"abc123def","blocks":[["1111111a","covered","abc123d",1],["2222222b","gap","abc123d",2]]} -->');
  assert.deepEqual(v3, { head: 'abc123def', blocks: [{ cid: C1, status: 'covered', since: 'abc123d', runs: 1, at: null }, { cid: C2, status: 'gap', since: 'abc123d', runs: 2, at: null }] });
  const bad4 = (audits, blocks) => audit.readState(`<!-- specguard:audit-state ${JSON.stringify({ v: 4, head: 'a', audits, blocks })} -->`);
  assert.equal(bad4([['abc', '2026-10-13']], [[C1, 'gap', 'a', 1, 1]]), null, 'an audit index out of range');
  assert.equal(bad4([['abc', 'yesterday']], [[C1, 'gap', 'a', 1, 0]]), null, 'a date must be ISO');
  assert.equal(bad4([['abc', '2026-10-13']], [[C1, 'gap', 'a', 1, 0]]).blocks[0].at.date, '2026-10-13');
  assert.equal(bad4([], [[C1, 'gap', 'a', 1, -1]]).blocks[0].at, null);
  assert.ok(!state.includes('plan'), 'ids and statuses only');
  const bad = (blocks) => audit.readState(`<!-- specguard:audit-state ${JSON.stringify({ v: 3, head: 'a', blocks })} -->`);
  assert.equal(bad([['<script>', 'gap', 'a', 1]]), null);
  assert.equal(bad([[C1, 'fine', 'a', 1]]), null);
  assert.equal(bad([[C1, 'gap', 'a', 0]]), null);
  assert.equal(bad([[C1, 'gap', 'a', 4]]), null);
  assert.equal(bad([[C1, 'gap', '<b>', 1]]), null);
  assert.equal(audit.readState('<!-- specguard:audit-state {"v":1,"head":"a","rows":[["1111111a","covered"]]} -->'), null, 'a v1 state (quote-hash ids) cannot be compared with cids');
  assert.equal(audit.readState('<!-- specguard:audit-state {nope} -->'), null);
  assert.equal(audit.readState('no state'), null);
  // v2: per-row [id, status]; sub-rows fold into the block, and it counts as one run
  const v2 = audit.readState('<!-- specguard:audit-state {"v":2,"head":"abcdef123456","rows":[["1111111a.1","covered"],["1111111a.2","missing_test"],["2222222b","covered"],["3333333c","unknown"]]} -->');
  assert.deepEqual(v2, { head: 'abcdef123456', blocks: [{ cid: C1, status: 'gap', since: 'abcdef1', runs: 1, at: null }, { cid: C2, status: 'covered', since: 'abcdef1', runs: 1, at: null }, { cid: C3, status: 'unsure', since: 'abcdef1', runs: 1, at: null }] });
  const now = dataOf({ [C1]: 'missing_test', [C2]: 'missing_test', [C3]: 'unknown' });
  const md = render({ data: now, prior: v2, head: 'h2' });
  assert.match(md, /### Reported in two runs \(1\)[\s\S]*`1111111a`/, 'gap in the v2 run and now: confirmed');
  assert.match(md, /### New since the last scan \(1\)/);
  assert.match(md, /Unstable: 1 block changed status/);
  assert.match(audit.stateComment('h2', now, v2, { date: DATE }), /"blocks":\[\["1111111a","gap","abcdef1",2,0,"missing_test",0\],\["2222222b","gap","h2",1,0,"missing_test",0\],\["3333333c","unsure","abcdef1",2,0,"unknown",0\]\]/);
});

test('run: a previous issue state drives confirmation in summary and issue; the issue ends with the new v4 state', async (t) => {
  const first = await runPost(t, { ctxFiles: { 'findings.json': result() }, env: { AUDIT_ISSUE: 'true' } });
  const old = first.calls.created[0].body;
  assert.doesNotMatch(old, /Changed since the last scan/);
  assert.match(old, /first scan run/);
  assert.match(old, /<!-- specguard:audit-state \{"v":4,"head":"abc123","audits":\[\["abc123","2026-10-13"\]\],"blocks":\[\["1111111a","covered","abc123",1,0\]\],"ev":\[\["1111111a","f76d5660","487bebfb"\]\]\} -->$/);
  const rs = [req({ status: 'missing_test', tests: [] }), req({ id: C2, source: cite('docs/design.md', 4), text: 'A plan must start in the future.', status: 'missing_test', tests: [] })];
  const r = await runPost(t, { ctxFiles: { 'findings.json': result(rs), 'audit-candidates.txt': candTxt(TWO()) }, env: { AUDIT_ISSUE: 'true' }, mock: { issues: [{ number: 9, body: old, user: BOT }] } });
  const second = r.calls.updated[0].body;
  for (const md of [r.calls.summary, second]) {
    assert.match(md, /\*\*Changed since the last scan \(`abc123`\)\*\*/);
    assert.match(md, /No confirmed changes\.[\s\S]*Unstable: 1 block changed status between the last two runs \(not listed\)\./);
    assert.match(md, /### New since the last scan \(2\)/);
    assert.doesNotMatch(md, /### Reported in two runs/);
  }
  assert.match(second, /"blocks":\[\["1111111a","gap","abc123",1,0,"missing_test",0],\["2222222b","gap","abc123",1,0,"missing_test",0]\]/);
  const third = await runPost(t, { ctxFiles: { 'findings.json': result(rs), 'audit-candidates.txt': candTxt(TWO()) }, env: { AUDIT_ISSUE: 'true' }, mock: { issues: [{ number: 9, body: second, user: BOT }] } });
  for (const md of [third.calls.summary, third.calls.updated[0].body]) {
    assert.match(md, /### Reported in two runs \(2\)/);
    assert.match(md, /Reported in two runs, newly \(2\):/);
  }
  assert.match(third.calls.updated[0].body, /"blocks":\[\["1111111a","gap","abc123",2,0,"missing_test",0],\["2222222b","gap","abc123",2,0,"missing_test",0]\]/);
});

// Real audits of one commit (same model, 80 fixed blocks): set SPECGUARD_REPLAY to the directory holding r1/ and r2/ (each with audit.json, or specguard-audit-1/audit.json).
test('replay: two real audits of the same commit confirm the gaps that agree (46 of the 80 blocks)', { skip: !process.env.SPECGUARD_REPLAY }, () => {
  const load = (n) => { const d = path.join(process.env.SPECGUARD_REPLAY, n), f = fs.existsSync(path.join(d, 'audit.json')) ? d : path.join(d, 'specguard-audit-1'); return JSON.parse(fs.readFileSync(path.join(f, 'audit.json'), 'utf8')); };
  const r1 = load('r1'), r2 = load('r2');
  const prior = audit.readState(audit.stateComment(r1.head, r1));
  const bs = audit.track(audit.blocksOf(r2), prior, r2.head), n = (m) => bs.filter((b) => b.mark === m).length;
  assert.deepEqual([bs.length, n('confirmed'), n('new')], [80, 46, 14]);
  const first = render({ data: r1, head: r1.head }), md = render({ data: r2, prior, head: r2.head });
  assert.match(first, /new gap \(first report\) \d+/);
  assert.match(md, /By block: reported in two runs 46 · new gap \(first report\) 14 · unsure 11 · covered 6 · not a requirement 3/);
});

test('scan summary: one icon in the whole report, on the verdict line; headings and cells are plain', () => {
  const icons = (x) => (x.match(/\p{Extended_Pictographic}/gu) || []).length;
  const complete = render({ data: sample(), blob: 'https://github.com/o/r/blob/abc' }), partial = render({ data: sample(), partial: 'engine timeout' });
  assert.equal(icons(complete), 1);
  assert.equal(icons(partial), 1);
  assert.match(complete, /\n### New gaps \(1\)\n/);
  assert.match(partial, /\n### Not reviewed \(1\)\n/);
});

test('run (A5): an engine that did not succeed gives a Partial scan banner, keeps verified rows, writes no issue', async (t) => {
  const r = await runPost(t, { ctxFiles: { 'findings.json': result(), 'engine-status': 'timeout\n' }, env: { AUDIT_ISSUE: 'true' }, mock: { issues: [{ number: 9, body: `${MARK}\nold`, user: BOT }] } });
  assert.match(r.calls.summary, /\*\*⚠️ Incomplete scan: no unit test gaps found so far\*\*\n\n> \*\*Incomplete scan\.\*\* The rows below passed verification but the list may be incomplete \(engine timeout\)\./);
  assert.ok(r.calls.summary.indexOf('Incomplete scan') < r.calls.summary.indexOf('**1 requirement**'), 'the banner comes first');
  assert.match(r.calls.summary, /\*\*1 requirement\*\*/);
  assert.deepEqual([r.calls.created, r.calls.updated], [[], []]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(r.w.ctx, 'audit.json'), 'utf8')).partial, 'engine timeout');
  const ok = await runPost(t, { ctxFiles: { 'findings.json': result(), 'engine-status': 'success\n' } });
  assert.doesNotMatch(ok.calls.summary, /Partial scan/);
  const rf = await runPost(t, { ctxFiles: { 'findings.json': result(), 'engine-repair': 'repair_failed\n' } });
  assert.match(rf.calls.summary, /Incomplete scan\.\*\* [^\n]*\(engine JSON repair failed\)/);
});

test('run (A19): a closed issue is reopened, an unchanged body is not rewritten, an open one is preferred', async (t) => {
  const first = await runPost(t, { ctxFiles: { 'findings.json': result() }, env: { AUDIT_ISSUE: 'true' } });
  const body = first.calls.created[0].body;
  const closed = { number: 4, state: 'closed', body: `${MARK}\nold`, user: BOT };
  const r = await runPost(t, { ctxFiles: { 'findings.json': result() }, env: { AUDIT_ISSUE: 'true' }, mock: { issues: [closed] } });
  assert.deepEqual([r.calls.updated.length, r.calls.updated[0].issue_number, r.calls.updated[0].state, r.calls.created.length], [1, 4, 'open', 0]);
  const next = await runPost(t, { ctxFiles: { 'findings.json': result() }, env: { AUDIT_ISSUE: 'true' }, mock: { issues: [{ number: 5, body, user: BOT }] } });
  assert.match(next.calls.updated[0].body, /No confirmed changes\./);
  const again = await runPost(t, { ctxFiles: { 'findings.json': result() }, env: { AUDIT_ISSUE: 'true' }, mock: { issues: [{ number: 5, body: next.calls.updated[0].body, user: BOT }] } }); // run counters settle after three runs
  const same = await runPost(t, { ctxFiles: { 'findings.json': result() }, env: { AUDIT_ISSUE: 'true' }, mock: { issues: [{ number: 5, title: TITLE, body: again.calls.updated[0].body.replace(/\n/g, '\r\n') + '\n', user: BOT }] } });
  assert.deepEqual([same.calls.updated, same.calls.created], [[], []]);
  const both = await runPost(t, { ctxFiles: { 'findings.json': result() }, env: { AUDIT_ISSUE: 'true' }, mock: { issues: [closed, { number: 6, state: 'open', body: `${MARK}\nold`, user: BOT }] } });
  assert.deepEqual(both.calls.updated.map((u) => [u.issue_number, u.state]), [[6, undefined]]);
});

test('run (A19): no admitted document updates the existing issue (state kept) and creates none', async (t) => {
  const first = await runPost(t, { ctxFiles: { 'findings.json': result() }, env: { AUDIT_ISSUE: 'true' } });
  const old = first.calls.created[0].body;
  const r = await runPost(t, { env: { SKIP: 'true', AUDIT_ISSUE: 'true' }, mock: { issues: [{ number: 4, body: old, user: BOT }] } });
  assert.equal(r.calls.updated.length, 1);
  const body = r.calls.updated[0].body;
  assert.match(body, /No design documents were found, so nothing was scanned\./);
  assert.doesNotMatch(body, /Covered in full/);
  assert.match(body, /<!-- specguard:audit-state /, 'the previous state is kept for the next audit');
  const none = await runPost(t, { env: { SKIP: 'true', AUDIT_ISSUE: 'true' } });
  assert.deepEqual([none.calls.created, none.calls.updated], [[], []]);
  assert.match(none.calls.summary, /No design documents were found/);
});

test('rename: the head names the unit test gap scan and the short sha; no "audit" wording is left in the report', () => {
  const md = render({ data: sample(), head: 'abcdef1234567', prior: { head: 'h1', blocks: [{ cid: C1, status: 'covered', since: 'h1', runs: 1 }] }, cap: 80, candidates: 9 });
  assert.ok(md.startsWith('## SpecGuard scan\n\n**❌ '));
  assert.match(md.split('\n')[2], /in the design documents at `abcdef1`\. Static review; tests were not run\.$/);
  assert.doesNotMatch(md, /audit/i);
  assert.doesNotMatch(render({ data: null, head: 'abcdef1' }), /audit/i);
  assert.doesNotMatch(render({ data: sample(), failure: 'x', partial: 'engine timeout' }), /audit/i);
  assert.equal(TITLE, 'SpecGuard: unit test gap scan');
});

test('run (rename): an issue created under the old title and marker is found and updated, not duplicated', async (t) => {
  const first = await runPost(t, { ctxFiles: { 'findings.json': result() }, env: { AUDIT_ISSUE: 'true' } });
  const legacy = { number: 11, title: 'SpecGuard requirements audit', body: first.calls.created[0].body.replace('## SpecGuard scan', '## SpecGuard requirements audit'), user: BOT };
  assert.ok(legacy.body.startsWith('<!-- specguard:audit -->\n## SpecGuard requirements audit'), 'the old marker is the one still in use');
  const r = await runPost(t, { ctxFiles: { 'findings.json': result() }, env: { SCAN_ISSUE: 'true' }, mock: { issues: [legacy] } });
  assert.equal(r.calls.created.length, 0, 'no duplicate');
  assert.deepEqual(r.calls.updated.map((u) => [u.issue_number, u.title]), [[11, TITLE]]);
  assert.ok(r.calls.updated[0].body.startsWith(`${MARK}\n## SpecGuard scan`));
  assert.match(r.calls.updated[0].body, /No confirmed changes\./, 'the hidden state of the old issue is still read');
});

test('run (rename): scan_issue wins over the deprecated audit_issue; either alone works', async (t) => {
  const files = { 'findings.json': result() };
  const on = await runPost(t, { ctxFiles: files, env: { SCAN_ISSUE: 'true', AUDIT_ISSUE: 'false' } });
  assert.equal(on.calls.created.length, 1, 'scan_issue true beats audit_issue false');
  const off = await runPost(t, { ctxFiles: files, env: { SCAN_ISSUE: 'false', AUDIT_ISSUE: 'true' } });
  assert.deepEqual([off.calls.created, off.calls.updated], [[], []], 'scan_issue false beats audit_issue true');
  const empty = await runPost(t, { ctxFiles: files, env: { SCAN_ISSUE: '', AUDIT_ISSUE: 'true' } });
  assert.equal(empty.calls.created.length, 1, 'an unset scan_issue (empty) falls back to the alias');
  const alone = await runPost(t, { ctxFiles: files, env: { SCAN_ISSUE: 'true' } });
  assert.equal(alone.calls.created.length, 1);
});

test('run (A18): the size caps are bytes, and a failing summary write or lookup never throws', async (t) => {
  const rs = Array.from({ length: 80 }, (_, i) => req({ id: cid(i + 1), text: `需求${i + 1} ${'要'.repeat(95)}`, note: '注'.repeat(98) }));
  const r = await runPost(t, { ctxFiles: { 'findings.json': result(rs), 'audit-candidates.txt': candTxt(candsOf(...rs.map((x) => cand(x.id, 3, 'x')))) }, env: { AUDIT_ISSUE: 'true' } });
  assert.ok(Buffer.byteLength(r.calls.created[0].body) <= 65536, String(Buffer.byteLength(r.calls.created[0].body)));
  assert.ok(Buffer.byteLength(r.calls.summary) <= 1048576);
  const w = workspace(t);
  w.put('audit-meta.json', { head: 'abc123', max_requirements: 80, docs: 1, limitations: [] });
  w.put('findings.json', result());
  w.put('audit-candidates.txt', candTxt(ONE()));
  const m = mocks();
  m.core.summary = { addRaw() { return this; }, async write() { throw new Error('summary too large'); } };
  const saved = process.env.CTX; process.env.CTX = w.ctx;
  try { await audit({ github: m.github, context: m.context, core: m.core }); } finally { process.env.CTX = saved; }
  assert.match(m.calls.warnings.join('\n'), /could not write the job summary: summary too large/);
  const boom = mocks();
  boom.context = null; // anything unexpected is a warning, not a red job
  await audit({ github: boom.github, context: boom.context, core: boom.core });
  assert.match(boom.calls.warnings.join('\n'), /scan report failed/);
});

test('run: the header counts blocks from the candidate file and meta, the not-a-requirement block is listed collapsed, and the cap leftovers are in not reviewed', async (t) => {
  const r = await runPost(t, { ctxFiles: {
    'findings.json': result([req()], { not_requirements: [{ cid: C2, reason: 'rationale, not behaviour' }] }),
    'audit-candidates.txt': candTxt(TWO()),
    'audit-meta.json': { head: 'abc123', max_requirements: 2, docs: 1, candidates: 14, candidates_listed: 2, cap_left: ['docs/design.md § 4. After: 12 blocks not scanned (cap)'], limitations: [] } } });
  const md = r.calls.summary;
  assert.match(md, /\*\*1 requirement\*\* from 1 document\n\n2 blocks scanned of 14 in the documents \(cap 2\)\./);
  assert.match(md, /\*\*1 block was not a requirement\*\*[\s\S]*2222222b[\s\S]*\(rationale, not behaviour\)/);
  assert.match(md, /\*\*Not reviewed \(1 item\)\*\*\n\n- docs\/design\.md § 4\. After: 12 blocks not scanned \(cap\)\n/);
  const saved = JSON.parse(fs.readFileSync(path.join(r.w.ctx, 'audit.json'), 'utf8'));
  assert.deepEqual(saved.not_requirements.map((x) => [x.cid, x.path, x.line, x.reason]), [[C2, 'docs/design.md', 4, 'rationale, not behaviour']]);
});

test('validate: without an explicit list it reads audit-candidates.txt from $CTX, which is how the engine repair check sees the blocks', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'specguard-audit-ctx-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'audit-candidates.txt'), candTxt(TWO()));
  const saved = process.env.CTX;
  try {
    process.env.CTX = dir;
    assert.match(validate(result([req({ id: 'R1' })])).error, /not a listed block id/);
    assert.match(validate(result([])).error, /2 of 2 listed blocks were not answered/);
    assert.deepEqual(validate(result([req()], { not_requirements: [{ cid: C2, reason: 'an example only' }] })), { ok: true });
    delete process.env.CTX;
    assert.deepEqual(validate(result([req({ id: 'R1' })])), { ok: true });
  } finally { if (saved === undefined) delete process.env.CTX; else process.env.CTX = saved; }
  assert.deepEqual([...audit.readCandidates(candTxt(TWO())).keys()], [C1, C2]);
  assert.equal(audit.readCandidates('bad line\n\n').size, 0);
});

test('verify: a citation under .specguard-src/ fails like any unreadable one', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-own-'));
  const old = process.env.GITHUB_WORKSPACE; process.env.GITHUB_WORKSPACE = dir;
  t.after(() => { fs.rmSync(dir, { recursive: true, force: true }); if (old === undefined) delete process.env.GITHUB_WORKSPACE; else process.env.GITHUB_WORKSPACE = old; });
  fs.mkdirSync(path.join(dir, '.specguard-src'));
  fs.writeFileSync(path.join(dir, '.specguard-src', 'plan.js'), FILES['src/plan.js'].join('\n') + '\n');
  fs.writeFileSync(path.join(dir, 'plan.js'), FILES['src/plan.js'].join('\n') + '\n');
  const code = (p) => verify(result([req({ code: [{ path: p, line: 2, quote: FILES['src/plan.js'][1] }], tests: [] })]), { read: (x) => (x === 'docs/design.md' ? FILES[x] : require('./post').readFile(x)) }).requirements[0].code.length;
  assert.equal(code('plan.js'), 1);
  assert.equal(code('.specguard-src/plan.js'), 0);
});

// ---- scan_paths scopes, rotation, coverage ----
const stateBody = (mark, head, audits, blocks) => `${mark}\n## SpecGuard unit test gap scan\n\n<!-- specguard:audit-state ${JSON.stringify({ v: 4, head, audits, blocks })} -->`;

test('scopeOf: no scope keeps the original marker and title; a scope has its own marker (order-insensitive) and names itself in the title', () => {
  const none = audit.scopeOf('');
  assert.deepEqual([none.mark, none.title, none.lines], [MARK, TITLE, []]);
  assert.deepEqual(audit.scopeOf(undefined), none);
  const a = audit.scopeOf('packages/payments/**'), a2 = audit.scopeOf(' packages/payments/** \r\n'), b = audit.scopeOf('packages/search/**');
  assert.match(a.mark, /^<!-- specguard:audit scope=[0-9a-f]{8} -->$/);
  assert.equal(a.title, 'SpecGuard: unit test gap scan (packages/payments/**)');
  assert.equal(a.mark, a2.mark);
  assert.notEqual(a.mark, b.mark);
  const two = audit.scopeOf('packages/b/**\npackages/a/**\n!packages/a/legacy/**'), swapped = audit.scopeOf('!packages/a/legacy/**\npackages/a/**\npackages/b/**');
  assert.equal(two.mark, swapped.mark);
  assert.equal(two.title, 'SpecGuard: unit test gap scan (packages/a/**, packages/b/**)', 'the title lists the includes');
  assert.ok(audit.scopeOf('x'.repeat(300)).title.length < 120 && !/[<>\n]/.test(audit.scopeOf('<b>\nx').title));
  assert.ok(!a.mark.startsWith(MARK) && !MARK.startsWith(a.mark.slice(0, 24)), 'a scoped marker is never mistaken for the unscoped one');
});

test('run: per-scope issues do not collide; the unscoped scan still finds the issue created before scopes existed', async (t) => {
  const unscoped = { number: 1, body: `${MARK}\nold`, user: BOT, state: 'open', title: TITLE };
  const payments = { number: 2, body: `${audit.scopeOf('packages/payments/**').mark}\nold`, user: BOT, state: 'open', title: 'x' };
  const issues = [unscoped, payments];
  const go = (SCAN_PATHS) => runPost(t, { ctxFiles: { 'findings.json': result() }, env: { SCAN_ISSUE: 'true', SCAN_PATHS }, mock: { issues } });
  const u = await go('');
  assert.deepEqual([u.calls.updated.map((x) => x.issue_number), u.calls.created.length], [[1], 0]);
  assert.equal(u.calls.updated[0].title, TITLE);
  assert.ok(u.calls.updated[0].body.startsWith(`${MARK}\n`));
  const p = await go('packages/payments/**');
  assert.deepEqual([p.calls.updated.map((x) => x.issue_number), p.calls.created.length], [[2], 0]);
  assert.equal(p.calls.updated[0].title, 'SpecGuard: unit test gap scan (packages/payments/**)');
  assert.ok(p.calls.updated[0].body.startsWith(`${audit.scopeOf('packages/payments/**').mark}\n`));
  const s = await go('packages/search/**');
  assert.deepEqual([s.calls.updated.length, s.calls.created.length], [0, 1], 'a new scope gets its own issue');
  assert.equal(s.calls.created[0].title, 'SpecGuard: unit test gap scan (packages/search/**)');
  assert.match(s.calls.created[0].body, /Units reviewed \(scan_paths\): `packages\/search\/\*\*`; requirements, tests and evidence are read from the whole repository\./);
});

const ROT = { rotate: true, state: true, picked: 1, changed: 0, confirming: 1, new: 0, oldest: 0, carried: 3 };

test('run: a carried covered block whose cited code or tests changed since (audit-stale.txt, review F06) is not shown as covered; the state keeps its old entry so it stays due', async (t) => {
  const old = stateBody(MARK, 'oldhead', [['aaaa111', '2026-09-01'], ['bbbb222', '2026-08-01']], [[C1, 'gap', 'aaaa111', 1, 0], [C2, 'covered', 'bbbb222', 1, 1]]);
  const r = await runPost(t, { ctxFiles: { 'findings.json': result(), 'audit-carried.txt': `${C2}\tdocs/design.md:4\tPlan design\tA plan must start in the future.\n`, 'audit-stale.txt': `${C2}\n`,
    'audit-meta.json': { head: 'abc123', max_requirements: 1, docs: 1, candidates: 2, limitations: [], rotation: ROT, evidence: { blocks: 1, with_code: 1, with_tests: 0, cut: false } } },
    env: { SCAN_ISSUE: 'true' }, mock: { issues: [{ number: 9, body: old, user: BOT, state: 'open', title: TITLE }] } });
  const md = r.calls.updated[0].body;
  assert.match(md, /`2222222b`[^\n]*covered when last audited; its code, tests or requirement text changed since \(recheck due\)/);
  assert.doesNotMatch(md, /\*\*Covered \(\d+\)\*\*[^#]*`2222222b`/, 'not listed under Covered');
  assert.deepEqual(audit.readState(md).blocks.find((b) => b.cid === C2), { cid: C2, status: 'covered', since: 'bbbb222', runs: 1, at: { head: 'bbbb222', date: '2026-08-01' } }, 'the old entry: the next run still sees it stale');
});

test('run: runs that rotate keep the blocks they did not audit, marked from their date, in the report and in the next state; blocks gone from the documents are dropped', async (t) => {
  const old = stateBody(MARK, 'oldhead', [['aaaa111', '2026-09-01'], ['bbbb222', '2026-08-01'], ['cccc333', '2026-09-15']],
    [[C1, 'gap', 'aaaa111', 1, 0], [C2, 'covered', 'bbbb222', 1, 1], [C3, 'gap', 'bbbb222', 2, 2], ['deadbeef', 'gap', 'bbbb222', 2, 1]]);
  const carriedTxt = `${C2}\tdocs/design.md:4\tPlan design\tA plan must start in the future.\n${C3}\tdocs/design.md:3\tPlan design\tPlans fire at most once a minute.\n`; // deadbeef is not in the documents any more
  const r = await runPost(t, { ctxFiles: { 'findings.json': result(), 'audit-carried.txt': carriedTxt,
    'audit-meta.json': { head: 'abc123', max_requirements: 1, docs: 1, candidates: 3, limitations: [], rotation: ROT, evidence: { blocks: 1, with_code: 1, with_tests: 0, cut: false } } },
    env: { SCAN_ISSUE: 'true' }, mock: { issues: [{ number: 9, body: old, user: BOT, state: 'open', title: TITLE }] } });
  for (const md of [r.calls.summary, r.calls.updated[0].body]) {
    assert.match(md, /1 block audited this run\b/);
    assert.match(md, /Coverage: 3 of 3 blocks audited at least once; this run audited 1 \(changed 0, confirming 1, new 0, oldest 0\)\./);
    assert.match(md, /Evidence candidates found before the model ran: 1 of 1 blocks have a code location, 0 a test location\./);
    assert.match(md, /A gap is \*\*reported in two runs\*\* when the block was a gap in this run and the last time it was audited/);
    assert.match(md, /### Reported in two runs \(1\)[\s\S]*docs\/design\.md:3[^\n]*Plans fire at most once a minute\.<br><sub>from 2026-09-15<\/sub> \|/, 'a carried confirmed gap shows its date');
    assert.match(md, /\*\*Covered \(2\)\*\*[\s\S]*`1111111a`[\s\S]*`2222222b`[^\n]*covered<br><sub>from 2026-08-01<\/sub>/);
    assert.doesNotMatch(md, /deadbeef/);
    assert.match(md, /By block: reported in two runs 1 · covered 2/);
  }
  assert.doesNotMatch(r.calls.updated[0].body, /Reported in two runs, newly/, 'a carried confirmed gap is not announced again');
  const next = audit.readState(r.calls.updated[0].body);
  assert.deepEqual(next.blocks.map((b) => [b.cid, b.status, b.runs, b.at.date]).sort(), [[C1, 'covered', 1, '2026-10-13'], [C2, 'covered', 1, '2026-08-01'], [C3, 'gap', 2, '2026-09-15']].sort());
  assert.equal(next.head, 'abc123');
  assert.equal(next.blocks.find((b) => b.cid === C1).since, 'abc123', 'this run is stored with the head and date it was audited at');
});

test('render: coverage without an issue says to schedule with scan_issue: true; with it the first run is "audited at least once" too; a full scan needs neither', () => {
  const data = sample();
  const plain = render({ data, candidates: 9, cap: 5, rotation: { rotate: false, state: false, picked: 3, changed: 0, confirming: 0, new: 3, oldest: 0, carried: 0 } });
  assert.match(plain, /Scanned in document order: the first 3 of 9 blocks \(cap 5\)\. Schedule with scan_issue: true to rotate through all blocks\./);
  assert.doesNotMatch(plain, /Coverage:/);
  const first = render({ data, candidates: 9, cap: 5, rotation: { rotate: true, state: false, picked: 3, changed: 0, confirming: 0, new: 3, oldest: 0, carried: 0 } });
  assert.match(first, /Coverage: 3 of 9 blocks audited at least once; this run audited 3 \(changed 0, confirming 0, new 3, oldest 0\)\./);
  const full = render({ data, candidates: 3, cap: 5, rotation: { rotate: false, state: false, picked: 3, changed: 0, confirming: 0, new: 3, oldest: 0, carried: 0 } });
  assert.doesNotMatch(full, /Schedule with scan_issue|Coverage:/);
  const dropped = render({ data, candidates: 9, cap: 5, stateDropped: 7, rotation: ROT });
  assert.match(dropped, /the scan issue state keeps at most 600 blocks \(40000 bytes\): 7 older block\(s\) are dropped and will count as never audited/, 'a state cap is visible');
  const scoped = render({ data, candidates: 9, cap: 5, scope: ['packages/payments/**', '!**/legacy/**'], rotation: ROT });
  assert.match(scoped, /Units reviewed \(scan_paths\): `packages\/payments\/\*\*`, `!\*\*\/legacy\/\*\*`; requirements, tests and evidence are read from the whole repository\./);
});

test('state: only the newest runs fit STATE_MAX; covered, long-ago blocks go first and the drop is counted', () => {
  const data = dataOf({ [C1]: 'missing_test' });
  const mk = (i, status, date) => ({ cid: cid(0x1000 + i), status, since: 'h', runs: 1, at: { head: 'h', date } });
  const carried = Array.from({ length: 620 }, (_, i) => mk(i, i % 2 ? 'covered' : 'gap', `2026-0${1 + (i % 9)}-01`));
  const s = audit.stateOf('h9', data, null, { carried, date: DATE });
  const back = audit.readState(s.raw);
  assert.equal(back.blocks.length, 600);
  assert.equal(s.dropped, 21);
  assert.equal(back.blocks[0].cid, C1, 'this run first');
  assert.ok(back.blocks.filter((b) => b.status === 'gap').length === 311, 'all 310 carried gaps and this run\'s are kept');
  assert.ok(Buffer.byteLength(s.raw) < 40000, `${Buffer.byteLength(s.raw)} bytes`);
});

test('render: blocks skipped by rule are listed in their own collapsed block with the reason and do not change the counts', () => {
  const data = verify(result([req()], {}), { read, cands: TWO() });
  const ruled = [{ cid: '3333333c', path: 'docs/design.md', line: 9, text: '| Pilot run | 88% |', reason: 'results/data table row' }];
  const md = render({ data, blob: 'https://github.com/o/r/blob/abc', candidates: 2, cap: 5, ruled });
  assert.ok(md.includes('**1 block was skipped by rule**\n\n- [docs/design.md:9](https://github.com/o/r/blob/abc/docs/design.md#L9) `3333333c` \\| Pilot run \\| 88% \\| (skipped by rule: results/data table row)'), md);
  assert.equal(md.replace(/\*\*1 block was skipped by rule\*\*\n\n- [^\n]*\n\n/, ''), render({ data, blob: 'https://github.com/o/r/blob/abc', candidates: 2, cap: 5 }), 'only the extra block differs');
});

test('run: the status output (and the reason when failed) is set in scan mode for every outcome', async (t) => {
  const out = async (o) => (await runPost(t, o)).calls.outputs;
  assert.deepEqual(await out({ ctxFiles: { 'findings.json': result(), 'engine-status': 'success\n' } }), { status: 'complete' });
  assert.deepEqual(await out({ ctxFiles: { 'findings.json': result(), 'engine-status': 'timeout\n' } }), { status: 'incomplete', reason: 'engine timeout' });
  assert.deepEqual(await out({ env: { SKIP: 'true' } }), { status: 'complete' }, 'nothing to scan is not a failure');
  assert.deepEqual(await out({ mock: {}, ctxFiles: { 'audit-meta.json': 'not json' } }), { status: 'failed', reason: 'the collection step did not produce its context.' });
  const bad = await out({ ctxFiles: { 'findings.json': result([req({ status: 'great' })]) } });
  assert.equal(bad.status, 'failed');
  assert.match(bad.reason, /^the result failed validation: requirements\[0\]: status must be one of/);
  // the engine step's classified reason (quota, auth, policy) reaches the output and the summary instead of "see the job log"
  const quota = await runPost(t, { ctxFiles: { 'engine-status': 'failed\n', 'engine-error': 'quota\nYou have exceeded your monthly quota\n' } });
  assert.deepEqual(quota.calls.outputs, { status: 'failed', reason: 'You have exceeded your monthly quota' });
  assert.match(quota.calls.summary, /Could not complete: You have exceeded your monthly quota/);
  assert.deepEqual((await runPost(t, { ctxFiles: { 'engine-status': 'failed\n' } })).calls.outputs, { status: 'failed', reason: 'the engine failed; see the job log' });
});

test('scan layout: clean, person-check and incomplete verdicts; icons carry labels; no internal tokens outside Details', () => {
  const clean = render({ data: dataOf({ [A]: 'covered' }), head: 'abc1234def' });
  assert.match(clean, /^## SpecGuard scan\n\n\*\*✅ No unit test gaps found\*\* in the design documents at `abc1234`\. Static review; tests were not run\.\n\n<details>/);
  assert.doesNotMatch(clean.slice(0, clean.indexOf('<details>')), /###/);
  const unsure = render({ data: dataOf({ [A]: 'needs_human' }), head: 'abc1234def' });
  assert.match(unsure, /\*\*❔ No gaps found; 1 block needs a person to check\*\* in the design documents/);
  const gaps = render({ data: dataOf({ [A]: 'missing_test', [B]: 'missing_test', [U]: 'unknown' }), head: 'abc1234def' });
  const vis = gaps.slice(0, gaps.indexOf('<details>'));
  assert.match(vis, /\*\*❌ 2 new gaps \(first report\)\*\*/);
  assert.doesNotMatch(vis, /missing_test|needs_human|not_implemented|unsure|Unsure|Covered/);
  const partial = render({ data: dataOf({ [A]: 'missing_test' }), partial: 'engine timeout' });
  assert.match(partial, /\*\*⚠️ Incomplete scan: 1 new gap \(first report\) found so far\*\*/);
  assert.equal((gaps.match(/<details>/g) || []).length, 1);
});

test('scan layout: every SpecGuard-authored string is English; repository text only inside quotes', () => {
  const ZH = '重复计划触发后保持开启';
  const cjk = /[぀-ヿ㐀-鿿가-힯豈-﫿]/;
  const d = dataOf({ [A]: 'missing_test', [B]: 'contradicted', [U]: 'needs_human' });
  for (const r of d.requirements) { r.text = ZH; r.source = { ...r.source, quote: ZH }; r.note = `The document says "${ZH}".`; }
  const md = render({ data: d, head: 'abc1234def', rejected: [['docs/说明.md', 'no items']], docs: [['docs/说明.md', 'discovered']] });
  assert.ok(cjk.test(md));
  assert.doesNotMatch(md.split(ZH).join('').split('说明').join(''), cjk);
});

test('coverage ledger: counts come from unique block ids; a failed part is neither audited now nor double counted (Kite: 131 blocks, 80 selected, 10 failed, 61 in the state)', () => {
  const data = sample(), cs = Array.from({ length: 61 }, (_, i) => ({ cid: cid(0x2000 + i), path: 'docs/a.md', line: i + 1, text: `t${i}`, status: 'covered', since: 'h', runs: 1, at: null }));
  const failed = Array.from({ length: 10 }, (_, i) => ({ cid: cid(0x3000 + i), path: 'docs/a.md', line: i + 1, text: `f${i}` }));
  const rot = { rotate: true, state: true, picked: 80, changed: 0, confirming: 20, new: 0, oldest: 60, carried: 51 };
  const md = render({ data, candidates: 131, cap: 80, rotation: rot, carried: cs, notAudited: { blocks: failed, failed: 10, dropped: 0 } });
  assert.match(md, /Coverage: 131 of 131 blocks audited at least once; this run audited 70 \(changed 0, confirming 20, new 0, oldest 60\)\./);
  assert.doesNotMatch(md, /clamped/);
  const over = render({ data, candidates: 131, cap: 80, rotation: { ...rot, picked: 80 }, carried: cs.concat(Array.from({ length: 70 }, (_, i) => ({ ...cs[0], cid: cid(0x4000 + i) }))), notAudited: { blocks: [], failed: 0, dropped: 0 } });
  assert.match(over, /Coverage: 131 of 131 blocks audited at least once; this run audited 80/);
  assert.match(over, /coverage counts were inconsistent \(211 audited at least once of 131 blocks\) and were clamped/);
});

test('state: a carried block keeps its real status and class; a contradicted higher_level block is not turned into "Add a unit test"', () => {
  const rowOf = (status) => req({ status, class: 'higher_level', tests: [] });
  const run = (status) => {
    const state = audit.stateComment('h1', { ...result([rowOf(status)]) }, null, { date: DATE }), prior = audit.readState(`${MARK}\n${state}`);
    assert.deepEqual([prior.blocks[0].top, prior.blocks[0].hl], [status, 1]);
    const carried = [{ ...cand(C1, 3, 'A repeating plan stays on after it fires.'), ...prior.blocks[0] }];
    return render({ data: sample(), prior, carried, candidates: 9, cap: 5, rotation: { ...ROT, picked: 1 } });
  };
  const c = run('contradicted'), p = run('partial'), m = run('missing_test');
  assert.match(c, /A repeating plan stays on after it fires\.<br><sub>from 2026-10-13<\/sub> \| The code contradicted it when last audited: fix the code or the requirement\. \|/);
  assert.match(p, /\| Strengthen the component or integration test: it checks only part of it\. \|/);
  assert.match(m, /\| Add a component or integration test that checks it\. \|/);
  // old 4/5-field entries still parse, and the extra fields fit the budget
  assert.deepEqual(audit.readState('<!-- specguard:audit-state {"v":4,"head":"h","audits":[["h","2026-10-13"]],"blocks":[["1111111a","gap","h",1,0]]} -->').blocks[0], { cid: C1, status: 'gap', since: 'h', runs: 1, at: { head: 'h', date: '2026-10-13' } });
  const big = audit.stateOf('h1', { ...result([]) }, null, { date: DATE, carried: Array.from({ length: 700 }, (_, i) => ({ cid: cid(0x5000 + i), status: 'gap', since: 'abcdef1', runs: 2, at: { head: 'abcdef1', date: '2026-10-13' }, top: 'contradicted', hl: 1 })) });
  assert.ok(Buffer.byteLength(big.raw) < 64000 / 1.5, `${Buffer.byteLength(big.raw)} bytes`);
});

// ---- incomplete review, posting failures, static test signals ----
const UID = '5555555e';
const SIG = (over = {}) => ({ tests: 2, noAssert: 0, skipped: 0, asserts: 4, weak: 0, unread: 0, ...over });
const invOf = (rows) => ({ units: rows.length, with_tests: 0, without_tests: 0, skipped_tests: 0, tests_without_assertion: 0, weak_assertions: 0, max_units: 12, selected: { units: rows.length, skipped_tests: 0 }, unreviewed: [], limitations: [],
  rotation: { rotate: false, picked: rows.length, confirming: 0, new: rows.length, oldest: 0, reviewed: rows.length, total: rows.length, run: 1, runs: 1 }, rows });
const urow = (id, over = {}) => ({ id, path: `src/${id}.js`, score: 5, why: 'x', tests: ['test/a.test.js'], review: 'this run', signals: SIG(), ...over });
const codeOf = (rows) => ({ list: new Map(rows.map((r) => [r.id, { id: r.id, path: r.path, score: r.score }])), inv: invOf(rows), findings: [], unseen: [] });
const clean = () => verify(result([req()]), { read });
const A1 = '00000a01', A2 = '00000a02';

test('render: static test signals are listed visibly with the caveat, the verdict is the unconfirmed form, nothing enters the state', () => {
  const rows = [urow(A1, { tests: [], signals: SIG({ tests: 0, asserts: 0 }) }), urow(A2, { signals: SIG({ noAssert: 2, skipped: 1 }) }), urow('00000a03')];
  const md = render({ data: clean(), code: codeOf(rows), head: 'abc1234def' });
  const vis = md.slice(0, md.indexOf('<details>'));
  assert.match(vis, /\*\*❔ No model-verified unit test gaps in the 3 riskiest units; 2 units have static test signals to check\*\*/);
  assert.doesNotMatch(vis, /✅/);
  assert.match(vis, /### Static test signals \(no model\) \(2\)/);
  assert.match(vis, /Found by rule from the test files at this commit, not by the model; a missing or weak signal is a lead, not a confirmed gap\./);
  assert.match(vis, /\| src\/00000a01\.js \| test evidence not found \|/);
  assert.match(vis, /\| src\/00000a02\.js \| weak test signal \| 2 tests without an assertion, 1 skipped \|/);
  assert.doesNotMatch(vis, /00000a03/);
  assert.doesNotMatch(audit.stateComment('h', clean(), null, { date: DATE, code: { picked: [A1], findings: [], carried: [] } }), /static|test_evidence/);
});

test('render: static signals are not capped (the lead table has its own cap of 20); none: the clean verdict stays; an inventory without signals still renders', () => {
  const many = Array.from({ length: 12 }, (_, i) => urow(`0000b0${i.toString(16).padStart(2, '0')}`, { tests: [], signals: SIG() }));
  const md = render({ data: clean(), code: codeOf(many) });
  const vis = md.slice(0, md.indexOf('<details>'));
  assert.match(vis, /### Static test signals \(no model\) \(12\)/);
  assert.equal((vis.match(/test evidence not found \|/g) || []).length, 12);
  assert.doesNotMatch(md, /More static test signals/);
  const none = render({ data: clean(), code: codeOf([urow(A1)]) });
  assert.match(none, /\*\*✅ No unit test gaps in the riskiest unit\*\*/);
  assert.doesNotMatch(none, /Static test signals/);
  const o = render({ data: clean(), code: codeOf([urow(A1, { signals: undefined, tests: [] })]) });
  assert.match(o, /✅ No unit test gaps/);
  assert.doesNotMatch(o, /Static test signals/);
});

test('render: unseen units or unanswered blocks never leave the clean verdict; the unanswered line is visible', () => {
  const c = codeOf([urow(A1), urow(A2)]);
  const unseen = render({ data: clean(), code: { ...c, unseen: [A2] } });
  assert.match(unseen, /\*\*⚠️ Incomplete scan: no gaps found so far\*\*/);
  assert.doesNotMatch(unseen, /✅/);
  const un = render({ data: clean(), code: c, unanswered: 2 });
  assert.match(un, /\*\*⚠️ Incomplete scan: no gaps found so far\*\*/);
  assert.match(un, /\*\*Not answered by the model:\*\* 2 document blocks/);
  assert.match(render({ data: clean(), code: c, unanswered: 0 }), /✅/);
});

const UFILES = { 'audit-units.txt': `${UID}\tsrc/plan.js\t5\twhy\tnone\t-\n`, 'audit-inventory.json': invOf([urow(UID, { path: 'src/plan.js', tests: [] })]) };
test('run: units the model context did not hold make the status incomplete with the count; a clean run stays complete', async (t) => {
  const cut = await runPost(t, { ctxFiles: { ...UFILES, 'findings.json': result(), 'pack-cut.txt': 'src/plan.js\n' } });
  assert.equal(cut.calls.outputs.status, 'incomplete');
  assert.match(cut.calls.outputs.reason, /1 unit did not fit the model's context/);
  assert.doesNotMatch(cut.calls.summary, /✅/);
  const ok = await runPost(t, { ctxFiles: { ...UFILES, 'findings.json': result(), 'pack-cut.txt': '' } });
  assert.equal(ok.calls.outputs.status, 'complete');
  assert.equal(ok.calls.outputs.reason, undefined);
});

test('run: a unit finding that fails validation leaves its unit unreviewed (not covered, runs not advanced, status incomplete); a valid finding or no finding is unchanged (F20)', async (t) => {
  const bad = { unit: UID, kind: 'missing_test', path: 'src/plan.js', line: 2, quote: FILES['src/plan.js'][1] }; // no title
  const prior = { number: 7, body: stateBody(MARK, 'old1234', [['old1234', '2026-01-01']], [[UID, 'covered', 'old1234', 1, 0]]), user: BOT };
  const run = (findings, issues = []) => runPost(t, { ctxFiles: { ...UFILES, 'findings.json': result([req()], { unit_findings: findings }) }, env: { AUDIT_ISSUE: 'true' }, mock: { issues } });
  const blockOf = (r) => audit.readState((r.calls.created[0] || r.calls.updated[0]).body).blocks.find((b) => b.cid === UID);
  const fresh = await run([bad]);
  assert.equal(fresh.calls.outputs.status, 'incomplete');
  assert.match(fresh.calls.outputs.reason, /1 unit had a finding that failed validation/);
  assert.deepEqual([blockOf(fresh).status, blockOf(fresh).at.date], ['unsure', DATE], 'seen but inconclusive: unsure with the run date, never covered');
  assert.doesNotMatch(fresh.calls.summary, /✅/);
  const again = await run([bad], [prior]);
  assert.equal(again.calls.outputs.status, 'incomplete');
  assert.deepEqual([blockOf(again).status, blockOf(again).runs], ['unsure', 1], 'a prior covered is not confirmed');
  const good = await run([]);
  assert.equal(good.calls.outputs.status, 'complete');
  assert.equal(blockOf(good).status, 'covered');
  const valid = await run([{ ...bad, title: 'No test for the plan', skeleton: 'it("keeps a repeating plan on", () => {});' }]);
  assert.equal(blockOf(valid).status, 'gap');
});

test('run: a unit whose finding is dropped past the cap, dropped by verification or kept only as low confidence is not recorded covered (prior state carried, incomplete); a solid finding keeps the unit a gap (F20 siblings)', async (t) => {
  const U2 = '6666666f', q = FILES['src/plan.js'][0];
  const f = (unit, over = {}) => ({ unit, kind: 'missing_test', path: 'src/plan.js', line: 1, quote: q, title: 'No test', skeleton: 'it("fires", () => {});', ...over });
  const files = { 'audit-units.txt': `${UID}\tsrc/plan.js\t5\twhy\tnone\t-\n${U2}\tsrc/plan.js\t4\twhy\tnone\t-\n`, 'audit-inventory.json': invOf([urow(UID, { path: 'src/plan.js', tests: [] }), urow(U2, { path: 'src/plan.js', tests: [] })]) };
  const prior = { number: 7, body: stateBody(MARK, 'old1234', [['old1234', '2026-01-01']], [[U2, 'covered', 'old1234', 1, 0]]), user: BOT };
  const run = (unit_findings, issues = []) => runPost(t, { ctxFiles: { ...files, 'findings.json': result([req()], { unit_findings }) }, env: { AUDIT_ISSUE: 'true' }, mock: { issues } });
  const block = (r, id) => audit.readState((r.calls.created[0] || r.calls.updated[0]).body).blocks.find((b) => b.cid === id);
  const stages = {
    cap: [...Array.from({ length: 60 }, () => f(UID)), f(U2)], // the 61st finding, the only one of U2, is past UNIT_MAX
    verify: [f(UID), f(U2, { quote: 'a line that is not in the file' })],
    low: [f(UID), f(U2, { skeleton: '' })],
  };
  for (const [stage, list] of Object.entries(stages)) {
    const fresh = await run(list);
    assert.equal(fresh.calls.outputs.status, stage === 'low' ? 'complete' : 'incomplete', stage);
    assert.deepEqual([block(fresh, U2).status, block(fresh, U2).at.date], ['unsure', DATE], `${stage}: tracked as unsure this run`);
    assert.equal(block(fresh, UID).status, 'gap', `${stage}: the unit with a solid finding is a gap`);
    const carried = await run(list, [prior]);
    assert.deepEqual([block(carried, U2).status, block(carried, U2).runs], ['unsure', 1], `${stage}: a prior covered is not confirmed`);
  }
  assert.equal((await run(stages.low)).calls.outputs.status, 'complete', 'low-only findings are a valid result, not an incomplete run');
  assert.match((await run(stages.verify)).calls.outputs.reason, /1 unit had a finding that failed validation or verification/);
  assert.match((await run(stages.low)).calls.summary, /low-confidence|Low-confidence/, 'the low finding stays visible');
  const none = await run([f(UID)]);
  assert.equal(none.calls.outputs.status, 'complete'); assert.equal(block(none, U2).status, 'covered');
});

test('run: a deterministic low-confidence unit is tracked as unsure every run (never covered, never a stall); a finding outside the unit\'s part still advances its part cursor (F20)', async (t) => {
  const low = [{ unit: UID, kind: 'missing_test', path: 'src/plan.js', line: 1, quote: FILES['src/plan.js'][0], title: 'No test' }]; // no skeleton: low every run
  const stateOf = (r) => (r.calls.created[0] || r.calls.updated[0]).body;
  const run = (unit_findings, issues = [], files = UFILES) => runPost(t, { ctxFiles: { ...files, 'findings.json': result([req()], { unit_findings }) }, env: { AUDIT_ISSUE: 'true' }, mock: { issues } });
  const one = await run(low), two = await run(low, [{ number: 7, body: stateOf(one), user: BOT }]);
  for (const r of [one, two]) { assert.equal(r.calls.outputs.status, 'complete'); assert.equal(audit.readState(stateOf(r)).blocks.find((b) => b.cid === UID).status, 'unsure'); }
  assert.equal(audit.readState(stateOf(two)).blocks.find((b) => b.cid === UID).runs, 2);
  const part = { ...UFILES, 'audit-units.txt': `${UID}\tsrc/plan.js\t5\twhy\tnone\t-\tabcdef12\tpart 1/2 lines 1-2\n` };
  const outside = await run([{ ...low[0], line: 3, quote: FILES['src/plan.js'][2], title: 'No test', skeleton: 'it("x", () => {});' }], [], part);
  assert.match(outside.calls.summary, /outside this run's part/);
  assert.deepEqual(audit.readState(stateOf(outside)).versions.uc[UID], [1, 2], 'the cursor moves to part 2 of 2');
  assert.equal(outside.calls.outputs.status, 'complete');
});

test('run: an inconclusive run (low-only finding) keeps a confirmed gap: still a gap with its original finding and run count, only the date advances (F20)', async (t) => {
  const solid = { unit: UID, kind: 'missing_test', path: 'src/plan.js', line: 1, quote: FILES['src/plan.js'][0], title: 'No test', skeleton: 'it("fires", () => {});' };
  const run = (unit_findings, issues = []) => runPost(t, { ctxFiles: { ...UFILES, 'findings.json': result([req()], { unit_findings }) }, env: { AUDIT_ISSUE: 'true' }, mock: { issues } });
  const body = (r) => (r.calls.created[0] || r.calls.updated[0]).body, st = (r) => audit.readState(body(r));
  const one = await run([solid]), two = await run([solid], [{ number: 7, body: body(one), user: BOT }]);
  const gap2 = st(two).blocks.find((b) => b.cid === UID);
  assert.deepEqual([gap2.status, gap2.runs], ['gap', 2]);
  const earlier = body(two).split(DATE).join('2026-01-01'); // the confirmed gap was last audited long ago
  const three = await run([{ ...solid, skeleton: '' }], [{ number: 7, body: earlier, user: BOT }]);
  const gap3 = st(three).blocks.find((b) => b.cid === UID);
  assert.deepEqual([gap3.status, gap3.runs, gap3.at.date], ['gap', 2, DATE], 'still a gap, runs unchanged, date advanced');
  assert.deepEqual(st(three).findings, st(two).findings, 'the original finding is carried');
  assert.equal(three.calls.outputs.status, 'complete');
  const dropped = await run([{ ...solid, quote: 'a line that is not in the file' }], [{ number: 7, body: earlier, user: BOT }]); // verify drops it: dropped, not just low
  const gap4 = st(dropped).blocks.find((b) => b.cid === UID);
  assert.deepEqual([gap4.status, gap4.runs, gap4.at.date], ['gap', 2, DATE], 'verify-dropped: same outcome');
  assert.deepEqual(st(dropped).findings, st(two).findings);
  assert.equal(dropped.calls.outputs.status, 'incomplete');
});

test('run (F23 review): a forced unit whose test was cut is written to the state as unsure with today\'s date, and the status names the cut', async (t) => {
  const inv = { ...invOf([urow(UID, { path: 'src/plan.js', tests: ['test/a.test.js'] })]), forced: [UID] };
  const r = await runPost(t, { ctxFiles: { 'audit-units.txt': `${UID}\tsrc/plan.js\t5\twhy\ttest/a.test.js\t-\tabcdef12\t-\n`, 'audit-inventory.json': inv, 'findings.json': result(), 'pack-cut.txt': 'test/a.test.js\n' }, env: { AUDIT_ISSUE: 'true' } });
  assert.equal(r.calls.outputs.status, 'incomplete');
  assert.match(r.calls.outputs.reason, /1 unit was reviewed with only part of their tests \(recorded unsure\)/);
  assert.doesNotMatch(r.calls.outputs.reason, /did not fit/);
  const b = audit.readState(r.calls.created[0].body).blocks.find((x) => x.cid === UID);
  assert.deepEqual([b.status, b.at.date], ['unsure', DATE]);
});

test('run: two units reviewed with part of their tests and one that did not fit: the reason and the report name them apart', async (t) => {
  const [A, B, C] = ['aaaaaaa1', 'bbbbbbb2', 'ccccccc3'], row = (id, tests) => `${id}\tsrc/${id}.js\t5\twhy\t${tests}\t-\tabcdef12\t-\n`;
  const inv = { ...invOf([urow(A), urow(B), urow(C, { tests: [] })]), forced: [A, B] };
  const r = await runPost(t, { ctxFiles: { 'audit-units.txt': row(A, 'test/a.test.js') + row(B, 'test/a.test.js') + row(C, 'none'), 'audit-inventory.json': inv, 'findings.json': result(), 'pack-cut.txt': 'test/a.test.js\nsrc/ccccccc3.js\n' }, env: { AUDIT_ISSUE: 'true' } });
  assert.equal(r.calls.outputs.status, 'incomplete');
  assert.match(r.calls.outputs.reason, /1 unit did not fit the model's context; 2 units were reviewed with only part of their tests \(recorded unsure\)/);
  assert.match(r.calls.summary, /\*\*Not reviewed this run:\*\* 1 unit did not fit the model's context: `src\/ccccccc3\.js`/);
  assert.match(r.calls.summary, /\*\*Reviewed with part of their tests\*\*[^\n]*aaaaaaa1\.js[^\n]*bbbbbbb2\.js/);
});

test('run: a shared test cut only in the call of unit B makes B unsure, not A (pack-cut.txt "path<TAB>ids"); a line without ids still cuts for everyone', async (t) => {
  const [A, B] = ['aaaaaaa1', 'bbbbbbb2'], row = (id) => `${id}\tsrc/${id}.js\t5\twhy\ttest/a.test.js\t-\tabcdef12\t-\n`;
  const go = (cut) => runPost(t, { ctxFiles: { 'audit-units.txt': row(A) + row(B), 'audit-inventory.json': invOf([urow(A), urow(B)]), 'findings.json': result(), 'pack-cut.txt': cut }, env: { AUDIT_ISSUE: 'true' } });
  const one = await go(`test/a.test.js\t${B}\n`);
  assert.match(one.calls.outputs.reason, /1 unit was reviewed with only part of their tests/);
  assert.match(one.calls.summary, /\*\*Reviewed with part of their tests\*\*[^\n]*bbbbbbb2\.js/);
  assert.doesNotMatch(one.calls.summary, /\*\*Reviewed with part of their tests\*\*[^\n]*aaaaaaa1\.js/);
  const all = await go('test/a.test.js\n');
  assert.match(all.calls.outputs.reason, /2 units were reviewed with only part of their tests/);
});

test('run: a block the model neither answered nor ruled out makes the status incomplete; all answered is complete', async (t) => {
  const five = candsOf(cand(C1, 3, 'A repeating plan stays on after it fires.'), ...[1, 2, 3, 4].map((i) => cand(cid(i), 4, `Block ${i}.`)));
  const skip = (i) => ({ cid: cid(i), reason: 'rationale' });
  const miss = await runPost(t, { ctxFiles: { 'audit-candidates.txt': candTxt(five), 'findings.json': result([req()], { not_requirements: [1, 2, 3].map(skip) }) } });
  assert.equal(miss.calls.outputs.status, 'incomplete');
  assert.match(miss.calls.outputs.reason, /1 document block was not answered by the model/);
  assert.match(miss.calls.summary, /\*\*Not answered by the model:\*\* 1 document block/);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(miss.w.ctx, 'audit-unanswered.json'), 'utf8')), { blocks: 1, units: 0 }, 'fail-on-error.js reads the count');
  const all = await runPost(t, { ctxFiles: { 'audit-candidates.txt': candTxt(five), 'findings.json': result([req()], { not_requirements: [1, 2, 3, 4].map(skip) }) } });
  assert.equal(all.calls.outputs.status, 'complete');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(all.w.ctx, 'audit-unanswered.json'), 'utf8')), { blocks: 0, units: 0 });
});

test('run (review S6): a block unanswered once is marked for a retry; unanswered in two consecutive runs it is named in the limitations and no longer marked', async (t) => {
  const five = candsOf(cand(C1, 3, 'A repeating plan stays on after it fires.'), ...[1, 2, 3, 4].map((i) => cand(cid(i), 4, `Block ${i}.`)));
  const skip = (i) => ({ cid: cid(i), reason: 'rationale' });
  const run = (issues = []) => runPost(t, { ctxFiles: { 'audit-candidates.txt': candTxt(five), 'findings.json': result([req()], { not_requirements: [1, 2, 3].map(skip) }) }, env: { AUDIT_ISSUE: 'true' }, mock: { issues } });
  const body = (r) => (r.calls.created[0] || r.calls.updated[0]).body;
  const one = await run();
  assert.deepEqual(audit.readState(body(one)).versions.un, [cid(4)]);
  assert.doesNotMatch(one.calls.summary, /two consecutive runs/);
  const two = await run([{ number: 7, body: body(one), user: BOT }]);
  assert.match(two.calls.summary, new RegExp(`1 document block not answered in two consecutive runs.*${cid(4)}`));
  const st = audit.readState(body(two)), b4 = st.blocks.find((b) => b.cid === cid(4));
  assert.deepEqual([b4.status, b4.at.date, st.versions && st.versions.un], ['unsure', DATE, undefined]);
  const three = await run([{ number: 7, body: body(two), user: BOT }]);
  assert.deepEqual(audit.readState(body(three)).versions.un, [cid(4)], 'a third miss starts the count again: one retry, not a loop');
  assert.doesNotMatch(three.calls.summary, /two consecutive runs/);
});

test('run: a failed issue write or lookup, or a failed job summary, fails the status (last output wins) and warns', async (t) => {
  const env = { AUDIT_ISSUE: 'true' };
  const w = await runPost(t, { env, mock: { failWrite: true }, ctxFiles: { 'findings.json': result() } });
  assert.equal(w.calls.statuses.at(-1), 'failed');
  assert.match(w.calls.outputs.reason, /could not write the scan issue: 403 write/);
  assert.ok(w.calls.warnings.some((x) => /could not write the scan issue/.test(x)));
  const l = await runPost(t, { env, mock: { failList: true }, ctxFiles: { 'findings.json': result() } });
  assert.equal(l.calls.statuses.at(-1), 'failed');
  assert.match(l.calls.outputs.reason, /could not write the scan issue: 403/);
  const s = await runPost(t, { mock: { failSummary: true }, ctxFiles: { 'findings.json': result() } });
  assert.equal(s.calls.statuses.at(-1), 'failed');
  assert.equal(s.calls.outputs.reason, 'could not write the job summary');
  assert.ok(s.calls.warnings.some((x) => /could not write the job summary/.test(x)));
  const ok = await runPost(t, { env, ctxFiles: { 'findings.json': result() } });
  assert.equal(ok.calls.statuses.at(-1), 'complete');
  assert.equal(ok.calls.created.length, 1);
});

test('verify: incomplete block evidence cannot prove absence, but positive cited evidence survives', () => {
  for (const status of ['missing_test', 'partial', 'not_implemented']) {
    const v = verify(result([req({ status, tests: [] })]), { read, blockCuts: { [C1]: ['test/plan.test.js'] } });
    assert.equal(v.requirements[0].status, 'unknown', status);
    assert.match(v.requirements[0].note, /evidence files were not fully visible/);
  }
  const v = verify(result([req()]), { read, blockCuts: { [C1]: ['test/plan.test.js'] } });
  assert.equal(v.requirements[0].status, 'covered');
  const other = verify(result([req({ status: 'missing_test', tests: [] })]), { read, blockCuts: { [C2]: ['test/other.test.js'] } });
  assert.equal(other.requirements[0].status, 'missing_test', 'another block does not contaminate this one');
});

// F21 (audit 3.3, P4): a row's source must be its own candidate's block (same document, line inside the block), whatever else it cites
test('verify: a row citing another candidate\'s requirement (other document, or outside its own block) is unknown and never borrows that evidence; the control still covers', () => {
  const F = { ...FILES, 'docs/A.md': ['# A', '', 'The service must reject negative amounts.', '', 'Other filler text for the second block here.'], 'docs/B.md': ['# B', '', 'The service must accept positive amounts.'] };
  const cite = (p, l) => ({ path: p, line: l, quote: F[p][l - 1] }), rd = (p) => F[p] || null;
  const own = { cid: 'aaaaaaaa', path: 'docs/A.md', line: 3, end: 3, heading: 'A', text: 'The service must reject negative amounts.' };
  const other = { cid: 'bbbbbbbb', path: 'docs/B.md', line: 3, end: 3, heading: 'B', text: 'The service must accept positive amounts.' };
  const cs = candsOf(own, other);
  const row = (id, source) => req({ id, source, text: 'x' });
  const o = result([row('aaaaaaaa', cite('docs/B.md', 3)), row('bbbbbbbb', cite('docs/B.md', 3))]);
  const v = verify(o, { read: rd, cands: cs });
  const by = Object.fromEntries(v.requirements.map((r) => [r.id, r]));
  assert.equal(by.aaaaaaaa.status, 'unknown');
  assert.deepEqual([by.aaaaaaaa.code, by.aaaaaaaa.tests], [[], []]);
  assert.ok(v.not_reviewed.some((n) => /^aaaaaaaa /.test(n) && /not the block/.test(n)), JSON.stringify(v.not_reviewed));
  assert.equal(by.bbbbbbbb.status, 'covered', 'control: a row citing its own block verifies');
  // same document, line outside the block's range (and a .N sub-row uses its parent's range)
  const o2 = result([row('aaaaaaaa.1', cite('docs/A.md', 5)), row('aaaaaaaa.2', cite('docs/A.md', 3))]);
  const v2 = verify(o2, { read: rd, cands: cs });
  assert.ok(!v2.requirements.some((r) => r.id === 'aaaaaaaa.1' && r.status === 'covered'), 'line 5 is outside the block 3-3');
  assert.ok(v2.requirements.some((r) => r.id === 'aaaaaaaa.2' && r.status === 'covered'));
});

test('readCandidates: path:line-end carries the block range; path:line stays valid', () => {
  const m = audit.readCandidates('aaaaaaaa\tdocs/A.md:3-6\th\ttext\nbbbbbbbb\tdocs/B.md:9\th\ttext\n');
  assert.deepEqual([m.get('aaaaaaaa').line, m.get('aaaaaaaa').end, m.get('bbbbbbbb').line, m.get('bbbbbbbb').end], [3, 6, 9, undefined]);
});

// F25 (audit 3.5, N1): the text version of a block is part of the persisted state
test('state: the requirement-text version (tv) round-trips through the scan state', () => {
  const data = result([req()]);
  const s = audit.readState(audit.stateComment('h1', data, null, { date: DATE, tv: new Map([[C1, 'deadbeef']]) }));
  assert.deepEqual(s.versions.tv, { [C1]: 'deadbeef' });
  const carried = [{ cid: C1, status: 'covered', since: 'h1', runs: 1, at: { head: 'h1', date: DATE } }];
  const kept = audit.readState(audit.stateComment('h2', result([]), s, { date: DATE, carried }));
  assert.deepEqual(kept.versions.tv, { [C1]: 'deadbeef' }, 'a carried block keeps its recorded version');
});

test('verify: test_paths is authoritative for what a test file is (F26); without it the name heuristic applies', () => {
  const files = { ...FILES, 'qa/checks/amount.js': ['check("amount", () => {', '  assert.equal(total([1, 2]), 3);', '});'] };
  const rd = (p) => files[p] || null;
  const r = () => result([req({ tests: [{ path: 'qa/checks/amount.js', line: 2, quote: files['qa/checks/amount.js'][1], layer: 'unit' }] })]);
  const scoped = verify(r(), { read: rd, testPaths: 'qa/checks/**' });
  assert.equal(scoped.requirements[0].status, 'covered');
  assert.equal(scoped.requirements[0].tests.length, 1);
  const heuristic = verify(r(), { read: rd });
  assert.equal(heuristic.requirements[0].status, 'unknown', 'no scope: qa/checks/amount.js is not recognised as a test by name');
  const out = verify(result([req()]), { read: rd, testPaths: 'qa/checks/**' }); // authoritative: tests/plan.test.js is outside the scope
  assert.equal(out.requirements[0].tests.length, 0);
});

test('state (F22): the part cursor is written as [next part, part count], dropped after the last part, and rejected when malformed', () => {
  const ID = 'a0000001', V = 'b0000001', data = dataOf({});
  const at = (prior, k) => audit.stateOf('h1', data, prior, { date: DATE, code: { picked: [ID], findings: [], carried: [], versions: new Map([[ID, V]]), parts: new Map([[ID, { k, n: 3 }]]) } });
  const s1 = audit.readState(at(null, 0).raw);
  assert.deepEqual(s1.versions.uc, { [ID]: [1, 3] });
  const s2 = audit.readState(at(s1, 1).raw);
  assert.deepEqual(s2.versions.uc, { [ID]: [2, 3] });
  assert.equal(audit.readState(at(s2, 2).raw).versions.uc, undefined, 'after the last part the cursor is gone, not left at the last part');
  const bad = at(null, 0).raw.replace(`"uc":{"${ID}":[1,3]}`, `"uc":{"${ID}":2}`);
  assert.notEqual(bad, at(null, 0).raw);
  assert.equal(audit.readState(bad).versions.uc, undefined, 'a bare integer (old format) is ignored: the unit restarts at part 0');
});

test('state (F22 review): a restart after an edit drops the findings of the old parts, so a clean pass ends covered', () => {
  const ID = 'a0000001', V1 = 'b0000001', V2 = 'b0000002', data = dataOf({});
  const run = (prior, k, v, findings = []) => audit.readState(audit.stateOf('h1', data, prior, { date: DATE, code: { picked: [ID], findings, carried: [], versions: new Map([[ID, v]]), parts: new Map([[ID, { k, n: 3 }]]) } }).raw);
  const s0 = run(null, 0, V1), s1 = run(s0, 1, V1, [{ unit: ID, next: ['c0000001', ID, 'h1', 1, 1] }]);
  assert.equal(s1.blocks[0].status, 'gap');
  const r0 = run(s1, 0, V2); // edited: the unit restarts at part 0
  assert.deepEqual([r0.blocks[0].status, r0.findings], ['unsure', undefined], 'the part-1 finding of the old version is gone');
  const r2 = run(run(r0, 1, V2), 2, V2);
  assert.equal(r2.blocks[0].status, 'covered');
  const cont = run(s1, 2, V1); // control: the same version continuing keeps the part-1 finding
  assert.deepEqual([cont.blocks[0].status, cont.findings.map((f) => f.part)], ['gap', [1]]);
});

test('E1 scan: a covered requirement whose only test is a truthiness or interaction assertion is unknown; value evidence still covers', () => {
  const withTest = (line) => { const f = { ...FILES, 'tests/plan.test.js': ['test("repeat stays on", () => {', line, '});'] }; return verify(result([req({ tests: [{ path: 'tests/plan.test.js', line: 2, quote: line, layer: 'unit' }] })]), { read: (p) => f[p] || null }).requirements[0]; };
  for (const q of ['  assert.ok(fire({ repeat: true }));', '  expect(fire(p)).toBeTruthy();', '  expect(spy).toHaveBeenCalled();']) {
    const r = withTest(q);
    assert.equal(r.status, 'unknown', q);
    assert.match(r.note, /only truthiness\/interaction assertions/);
  }
  for (const q of ['  assert.equal(fire({ repeat: true }).on, true);', '  expect(spy).toHaveBeenCalledWith(100);']) assert.equal(withTest(q).status, 'covered', q);
});

test('E2 scan: a unit weak_test finding refuted by its own assertion is low; a different input is not', () => {
  const run = (counterexample) => verify(result([req()], { unit_findings: [{ unit: 'u', kind: 'weak_test', path: 'tests/plan.test.js', line: 2, quote: FILES['tests/plan.test.js'][1], title: 't', body: 'b', counterexample, skeleton: 'x' }] }), { read }).unit_findings[0];
  assert.equal(run('fire({ repeat: true }).on returns false -> still passes').low, true);
  assert.equal(run('fire({ repeat: false }).on returns false -> still passes').low, false);
});

// findIssue / resolveIssueTarget: a scan never adopts another target's issue; repo names compare case-insensitively
const gh = (issues) => ({ paginate: async (fn) => fn(), rest: { issues: { listForRepo: () => issues } } });
const iss = (number, title, state = 'open') => ({ number, title, state, user: BOT, body: `${audit.MARK}\nx` });
const find = (issues, extra = {}) => audit.findIssue({ github: gh(issues), owner: 'o', repo: 'r', me: null, ...extra });
const FOREIGN = `${audit.TITLE}: org/other`;

test('scan issue: with a foreign target issue listed first, the own issue is picked', async () => {
  assert.equal((await find([iss(1, FOREIGN), iss(2, audit.TITLE)])).number, 2);
});
test('scan issue: a foreign target issue alone is never adopted', async () => {
  assert.equal(await find([iss(1, FOREIGN), iss(3, `${FOREIGN} (src)`)]), null);
});
test('scan issue: an explicit title still selects that issue, case-insensitively', async () => {
  assert.equal((await find([iss(1, FOREIGN), iss(2, audit.TITLE)], { title: FOREIGN })).number, 1);
  assert.equal((await find([iss(1, FOREIGN)], { title: FOREIGN.toUpperCase() })).number, 1);
});
test('scan issue control: a single own issue (plain, scoped, or titled for this very repository) is found', async () => {
  assert.equal((await find([iss(1, audit.TITLE)])).number, 1);
  assert.equal((await find([iss(1, `${audit.TITLE} (src)`)])).number, 1);
  assert.equal((await find([iss(1, `${audit.TITLE}: O/R`)])).number, 1);
});
test('scan issue: ISSUE_REPO differing only in case is the scanned repository (away=false)', () => {
  const t = audit.resolveIssueTarget({ ISSUE_REPO: 'mira190/specguard' }, 'Mira190', 'SpecGuard');
  assert.equal(t.away, false);
  assert.equal(t.scope.title, audit.TITLE);
});
test('scan issue control: a real foreign ISSUE_REPO is away', () => {
  const t = audit.resolveIssueTarget({ ISSUE_REPO: 'org/other' }, 'Mira190', 'SpecGuard');
  assert.equal(t.away, true);
  assert.deepEqual(t.target, { owner: 'org', repo: 'other' });
});

test('run: a stateless scan of a non-default ref names the ref in the summary and makes no issue call', async (t) => {
  const r = await runPost(t, { ctxFiles: { 'findings.json': result([req()]), 'audit-meta.json': { head: 'abc123', max_requirements: 80, docs: 1, limitations: [], ref_note: 'Scanned ref: dev @ abc1234 (not the default branch main; no scan state was read or written)' } } });
  assert.match(r.calls.summary, /Scanned ref: dev @ abc1234 \(not the default branch main; no scan state was read or written\)/);
  assert.deepEqual([r.calls.created, r.calls.updated], [[], []]);
  const ctl = await runPost(t, { ctxFiles: { 'findings.json': result([req()]) } });
  assert.doesNotMatch(ctl.calls.summary, /Scanned ref:/);
});

test('render: static leads (truthiness-only assertion, exported name no test references) are table rows with exact locations; 25 leads show 20 and a count; nothing enters the state', () => {
  const leads = { weak: [{ path: 'test/keys.test.js', line: 12, text: "assert.ok(keyName('A'))" }], unref: [{ name: 'moveCrop', line: 28 }] };
  const md = render({ data: clean(), code: codeOf([urow(A1, { leads })]), head: 'abc1234def' });
  const vis = md.slice(0, md.indexOf('<details>'));
  assert.match(vis, /1 unit has static test signals to check/);
  assert.match(vis, /\| test\/keys\.test\.js:12 \| asserts only truthiness \| `keys\.test\.js:12` asserts only truthiness \(`assert\.ok\(keyName\('A'\)\)`\) \|/);
  assert.match(vis, /\| src\/00000a01\.js:28 \| no test references it \| `moveCrop` \(src\/00000a01\.js:28\) is exported and no test file references it \|/);
  assert.doesNotMatch(audit.stateComment('h', clean(), null, { date: DATE, code: { picked: [A1], findings: [], carried: [] } }), /moveCrop|truthiness/);
  const many = Array.from({ length: 25 }, (_, i) => urow(`0000c0${i.toString(16).padStart(2, '0')}`, { leads: { unref: [{ name: `fn${i}abc`, line: 3 }] } }));
  const all = render({ data: clean(), code: codeOf(many) });
  assert.match(all, /\| \+5 more \| \| not listed: only the top 20 leads by unit risk are shown \|/);
  assert.equal((all.match(/ is exported and no test file references it/g) || []).length, 20);
});

test('render: scan_scope all lists the leads past the top 20 in Details; without it the count line says they are not listed', () => {
  const many = Array.from({ length: 25 }, (_, i) => urow(`0000c0${i.toString(16).padStart(2, '0')}`, { leads: { unref: [{ name: `fn${i}abc`, line: 3 }] } }));
  const all = render({ data: clean(), code: codeOf(many), reach: { scope: 'all', notReached: {} } }), vis = all.slice(0, all.indexOf('<details>'));
  assert.equal((vis.match(/ is exported and no test file references it/g) || []).length, 20, 'the visible top 20 is unchanged');
  assert.match(vis, /\| \+5 more \| \| listed in Details \|/);
  assert.match(all, /All other static leads \(5\)/);
  assert.equal((all.match(/ is exported and no test file references it/g) || []).length, 25, 'every generated lead is in the report');
  assert.doesNotMatch(render({ data: clean(), code: codeOf(many) }), /All other static leads/);
});

test('render: the lead table shows 20 rows in the visible part, shared round-robin by lead kind when the cap bites; control: 12 rule signals are all listed', () => {
  const id = (i) => `0000d${i.toString(16).padStart(3, '0')}`;
  const weak = Array.from({ length: 15 }, (_, i) => urow(id(i), { leads: { weak: [{ path: `test/w${i}.test.js`, line: 3, text: 'assert.ok(x)' }] } }));
  const unref = Array.from({ length: 15 }, (_, i) => urow(id(100 + i), { leads: { unref: [{ name: `moveCrop${i}`, line: 28 }] } }));
  const md = render({ data: clean(), code: codeOf([...weak, ...unref]), head: 'abc1234def' }), vis = md.slice(0, md.indexOf('<details>'));
  const n = (re) => (vis.match(re) || []).length;
  assert.equal(n(/ no test references it \|/g), 10, 'half of the 20 slots');
  assert.equal(n(/ asserts only truthiness \|/g), 10, 'the weak leads take the other half (round-robin over lead kinds)');
  assert.match(vis, /\| \+10 more \| \| not listed: only the top 20 leads by unit risk are shown \|/);
  const many = Array.from({ length: 12 }, (_, i) => urow(id(200 + i), { tests: [], signals: SIG() }));
  assert.equal((render({ data: clean(), code: codeOf(many) }).match(/test evidence not found \|/g) || []).length, 12, 'control: rule signals are not capped at 10 any more');
});

test('U1 run: a unit finding in a part scan-parts.json dropped or failed is removed; one in the part that ran is kept', async (t) => {
  const four = ['function a() {}', 'function b() {}', 'function c() {}', 'function d() {}'];
  const units = { 'audit-units.txt': [1, 2].map((k) => `${UID}\tsrc/plan.js\t5\twhy\tnone\t-\tabcdef12\tpart ${k}/2 lines ${k * 2 - 1}-${k * 2}\n`).join(''), 'audit-inventory.json': invOf([urow(UID, { path: 'src/plan.js', tests: [] })]) };
  const f = (line) => [{ unit: UID, kind: 'missing_test', path: 'src/plan.js', line, quote: four[line - 1], title: 'No test', skeleton: 'it("x", () => {});' }];
  const run = (line, parts) => runPost(t, { files: { 'src/plan.js': four }, ctxFiles: { ...units, 'scan-parts.json': parts, 'findings.json': result([req()], { unit_findings: f(line) }) } });
  const dropped = { calls: 1, failed: [], dropped: [], droppedParts: [`${UID}:2`] }, failed = { calls: 2, failed: [{ part: 'units', units: [UID], keys: [`${UID}:2`], reason: 'timeout' }], dropped: [] };
  for (const parts of [dropped, failed]) {
    assert.match((await run(3, parts)).calls.summary, /outside this run's part of the unit \(lines 1-2\)/);
    assert.doesNotMatch((await run(1, parts)).calls.summary, /outside this run's part/);
  }
});

test('scan_scope all: the top line says how many unit parts and blocks were not reached (budget, deadline) and the worst-case ceiling; a complete all run adds nothing', () => {
  const reach = { scope: 'all', notReached: { budget: { parts: 3, blocks: 7 }, deadline: { parts: 0, blocks: 0 } }, needUsd: 2.5 };
  const md = render({ data: sample(), reach });
  assert.match(md.slice(0, 900), /Incomplete: the whole repository was not reviewed\.\*\* 3 unit parts \/ 7 document blocks not reached \(budget\)\..*the default is \$1\.00.*at most \$2\.50 by the worst-case estimate/s);
  const late = render({ data: sample(), reach: { ...reach, notReached: { budget: { parts: 0, blocks: 0 }, deadline: { parts: 2, blocks: 0 } } } });
  assert.match(late, /2 unit parts \/ 0 document blocks not reached \(deadline\)\. The review time limit stopped the run/);
  assert.doesNotMatch(late, /max_budget_usd stopped the run/);
  assert.doesNotMatch(render({ data: sample(), reach: { ...reach, notReached: { budget: { parts: 0, blocks: 0 }, deadline: { parts: 0, blocks: 0 } } } }), /whole repository was not reviewed/);
  assert.doesNotMatch(render({ data: sample() }), /whole repository was not reviewed/);
});

test('R1 run: a unit finding is checked against the parts of the call that returned it; control: the call that held the line keeps it', async (t) => {
  const four = ['function a() {}', 'function b() {}', 'function c() {}', 'function d() {}'];
  const units = { 'audit-units.txt': [1, 2].map((k) => `${UID}\tsrc/plan.js\t5\twhy\tnone\t-\tabcdef12\tpart ${k}/2 lines ${k * 2 - 1}-${k * 2}\n`).join(''), 'audit-inventory.json': invOf([urow(UID, { path: 'src/plan.js', tests: [] })]) };
  const run = (callKeys) => runPost(t, { files: { 'src/plan.js': four }, ctxFiles: { ...units, 'scan-parts.json': { calls: 2, failed: [], dropped: [] }, 'findings.json': result([req()], { unit_findings: [{ unit: UID, kind: 'missing_test', path: 'src/plan.js', line: 3, quote: four[2], title: 'No test', skeleton: 'it("x", () => {});', callKeys }] }) } });
  assert.match((await run([`${UID}:1`])).calls.summary, /outside this run's part of the unit \(lines 1-2\)/, 'call 1 saw part 1 only: a part-2 line is not its finding');
  assert.doesNotMatch((await run([`${UID}:2`])).calls.summary, /outside this run's part/);
  assert.doesNotMatch((await run(undefined)).calls.summary, /outside this run's part/, 'unstamped: the union of the parts that ran, as before');
});

test('R2 run: a finding past the lines of a cut file the single call was shown is low confidence; a line it was shown is not', async (t) => {
  const four = ['function a() {}', 'function b() {}', 'function c() {}', 'function d() {}'];
  const ctxFiles = { 'audit-units.txt': `${UID}\tsrc/plan.js\t5\twhy\tnone\t-\tabcdef12\t-\n`, 'audit-inventory.json': invOf([urow(UID, { path: 'src/plan.js', tests: [] })]), 'pack-cut.txt': 'src/plan.js\n', 'pack-shown.txt': 'src/plan.js\t2\n' };
  const run = (line) => runPost(t, { files: { 'src/plan.js': four }, ctxFiles: { ...ctxFiles, 'findings.json': result([req()], { unit_findings: [{ unit: UID, kind: 'missing_test', path: 'src/plan.js', line, quote: four[line - 1], title: 'No test', skeleton: 'it("x", () => {});' }] }) } });
  assert.match((await run(3)).calls.summary, /line 3 is past the 2 lines of the file the model was shown/);
  assert.doesNotMatch((await run(2)).calls.summary, /is past the/);
});

test('unit provenance: a missing_test citing another unit\'s file, a test not listed for the unit, or a unit absent from the call is dropped; the unit\'s own file is kept', async (t) => {
  const A = 'aaaaaaaa', B = 'bbbbbbbb', body = ['function a() {}', 'function b() {}'];
  const units = { 'audit-units.txt': `${A}\tlib/a.js\t5\twhy\ttest/a.test.js\t-\tabcdef12\t-\n${B}\tlib/b.js\t5\twhy\ttest/b.test.js\t-\tabcdef12\t-\n`, 'audit-inventory.json': invOf([urow(A, { path: 'lib/a.js' }), urow(B, { path: 'lib/b.js' })]) };
  const f = (over) => ({ unit: A, kind: 'missing_test', path: 'lib/a.js', line: 1, quote: body[0], title: 'No test', skeleton: 'it("x", () => {});', callKeys: [A], ...over });
  const run = (over) => runPost(t, { files: { 'lib/a.js': body, 'lib/b.js': body, 'test/a.test.js': ['it("a", () => { assert.ok(a()); });'], 'test/b.test.js': ['it("b", () => { assert.ok(b()); });'] }, ctxFiles: { ...units, 'scan-parts.json': { calls: 2, failed: [], dropped: [] }, 'findings.json': result([req()], { unit_findings: [f(over)] }) } });
  assert.match((await run({ path: 'lib/b.js' })).calls.summary, /a missing_test cites another unit's file/);
  assert.doesNotMatch((await run({})).calls.summary, /another unit's file|not listed|not reviewed in the call/, 'control: its own file');
  assert.match((await run({ kind: 'weak_test', path: 'test/b.test.js', line: 1, quote: 'it("b", () => { assert.ok(b()); });', counterexample: 'x' })).calls.summary, /weak_test cites a test that is not listed/);
  assert.match((await run({ callKeys: [B] })).calls.summary, /declared unit was not reviewed in the call/);
});

test('validate: UNIT_MAX caps the rows kept per model answer (callKeys), not the merged list of a scan_scope all run', () => {
  const f = (unit, callKeys) => ({ unit, kind: 'missing_test', path: 'src/a.js', line: 1, quote: 'q', title: 't', ...(callKeys ? { callKeys } : {}) });
  const ids = (n, o = 0) => Array.from({ length: n }, (_, i) => (i + o).toString(16).padStart(8, '0'));
  const run = (list) => { const o = result([req()], { unit_findings: list }); assert.deepEqual(validate(o, null, null), { ok: true }); return o; };
  const two = run([...ids(50).map((u) => f(u, ['a:1'])), ...ids(50, 50).map((u) => f(u, ['b:1']))]);
  assert.equal(two.unit_findings.length, 100, 'two calls under the cap are all kept');
  assert.deepEqual(two.invalid_units, []);
  assert.doesNotMatch(two.not_reviewed.join('\n'), /more than 60/);
  const one = run([...ids(70).map((u) => f(u)), ...ids(5, 70).map((u) => f(u, ['b:1']))]);
  assert.equal(one.unit_findings.length, 65, 'a single answer over 60 keeps 60; another call has its own 60');
  assert.deepEqual(one.invalid_units, ids(10, 60), 'the 10 past the cap are invalid, as today');
  assert.equal(one.not_reviewed.filter((n) => /more than 60 findings from one call/.test(n)).length, 10);
});

// R3 #1/#2/#5: the scan contract. Unknown is never "no gap"; eligible files that never reached the model make a scan_scope all run incomplete; the issue state always fits the issue.
const ALL = { 'audit-meta.json': { head: 'abc123', scan_scope: 'all', max_requirements: 0, docs: 0, limitations: [] }, 'scan-parts.json': { scope: 'all', calls: 1, failed: [], dropped: [] } };
test('run: scan_scope all with eligible files the inventory never reached (over 512 KiB, past the cap, time budget) is incomplete with the count; outside all it stays a limitation', async (t) => {
  for (const [field, re] of [['not_inventoried', /2 source files over 512 KiB not inventoried/], ['not_reached_cap', /2 source files past the inventory cap/], ['not_reached_time', /2 source files unread when the inventory time budget ran out/]]) {
    const ctxFiles = { ...UFILES, 'audit-inventory.json': { ...invOf([urow(UID, { path: 'src/plan.js', tests: [] })]), eligible: 3, [field]: 2 }, 'findings.json': result(), ...ALL };
    const r = await runPost(t, { ctxFiles });
    assert.equal(r.calls.outputs.status, 'incomplete', field);
    assert.match(r.calls.outputs.reason, re, field);
    const sel = await runPost(t, { ctxFiles: { ...ctxFiles, 'audit-meta.json': { head: 'abc123', max_requirements: 80, docs: 1, limitations: [] }, 'scan-parts.json': {} } });
    assert.equal(sel.calls.outputs.status, 'complete', `${field} outside scan_scope all: shown, not a failure`);
  }
  const ok = await runPost(t, { ctxFiles: { ...UFILES, 'audit-inventory.json': { ...invOf([urow(UID, { path: 'src/plan.js', tests: [] })]), eligible: 1 }, 'findings.json': result(), ...ALL } });
  assert.equal(ok.calls.outputs.status, 'complete', 'files excluded by scan_paths or NOT_UNIT are not eligible: nothing to count');
});

test('run: scan_scope all with admissible documents past the 60-document limit is incomplete with the count; outside scan_scope all it stays complete (listed as not admitted)', async (t) => {
  const ctxFiles = { ...UFILES, 'audit-inventory.json': invOf([urow(UID, { path: 'src/plan.js', tests: [] })]), 'findings.json': result(), ...ALL, 'audit-meta.json': { ...ALL['audit-meta.json'], docs_over_cap: 3 } };
  const r = await runPost(t, { ctxFiles });
  assert.equal(r.calls.outputs.status, 'incomplete');
  assert.match(r.calls.outputs.reason, /3 requirement documents over the \d+-document limit were not reviewed/);
  const sel = await runPost(t, { ctxFiles: { ...ctxFiles, 'audit-meta.json': { head: 'abc123', max_requirements: 80, docs: 1, docs_over_cap: 1, limitations: [] }, 'scan-parts.json': {} } });
  assert.equal(sel.calls.outputs.status, 'complete'); assert.doesNotMatch(sel.calls.outputs.reason || '', /document limit/);
});

test('run: scan_scope all with oversize requirement documents (docs_over_size) or scan_paths files dropped by the default non-unit rule (not_unit) is incomplete with the count; outside scan_scope all it stays complete', async (t) => {
  for (const [k, re] of [['docs_over_size', /2 requirement documents over 256 KiB not admitted/], ['not_unit', /2 source files in scan_paths dropped by the default non-unit paths/]]) {
    const ctxFiles = { ...UFILES, 'audit-inventory.json': invOf([urow(UID, { path: 'src/plan.js', tests: [] })]), 'findings.json': result(), ...ALL, 'audit-meta.json': { ...ALL['audit-meta.json'], [k]: 2 } };
    const r = await runPost(t, { ctxFiles });
    assert.equal(r.calls.outputs.status, 'incomplete', k); assert.match(r.calls.outputs.reason, re, k);
    const sel = await runPost(t, { ctxFiles: { ...ctxFiles, 'audit-meta.json': { head: 'abc123', max_requirements: 80, docs: 1, [k]: 2, limitations: [] }, 'scan-parts.json': {} } });
    assert.equal(sel.calls.outputs.status, 'complete', `${k} outside scan_scope all`);
  }
});

test('validate: unit_findings that is not an array makes every listed unit invalid (not reviewed); a valid empty array is "no findings"', async (t) => {
  const units = new Map([[UID, { id: UID }], [A1, { id: A1 }]]);
  const bad = clone(result([req()], { unit_findings: 'none' })), good = clone(result([req()], { unit_findings: [] }));
  assert.equal(validate(bad, ONE(), units).ok, true);
  assert.deepEqual(bad.invalid_units.sort(), [A1, UID].sort());
  assert.match(bad.not_reviewed.join('\n'), /unit_findings was not an array/);
  validate(good, ONE(), units);
  assert.deepEqual(good.invalid_units, []);
  const r = await runPost(t, { ctxFiles: { ...UFILES, 'findings.json': result([req()], { unit_findings: { unit: UID } }) }, env: { AUDIT_ISSUE: 'true' } });
  assert.equal(r.calls.outputs.status, 'incomplete');
  assert.match(r.calls.outputs.reason, /1 unit had a finding that failed validation or verification/);
  const st = audit.readState(r.calls.created[0].body).blocks.find((b) => b.cid === UID);
  assert.equal(st.status, 'unsure', 'never covered');
  assert.doesNotMatch(r.calls.summary, /✅/);
});

test('state: a 1500 or 3000 unit run keeps the issue body under ISSUE_MAX; gaps and unsure are kept before covered, oldest audited dropped first, the version maps follow, the drop is stated', async (t) => {
  for (const n of [1500, 3000]) {
    const rows = Array.from({ length: n }, (_, i) => urow(cid(0x20000 + i), { path: `src/u${i}.js`, tests: [], ver: cid(0x90000 + i) }));
    const unitsTxt = rows.map((r) => `${r.id}\t${r.path}\t5\twhy\tnone\t-\t${r.ver}\n`).join('');
    const gapId = rows[n - 1].id, gap = { unit: gapId, kind: 'missing_test', path: 'src/plan.js', line: 2, quote: FILES['src/plan.js'][1], title: 't' };
    const inv = { ...invOf(rows), rotation: { rotate: true, picked: n, confirming: 0, new: n, oldest: 0, reviewed: n, total: n, run: 1, runs: 1 } };
    const r = await runPost(t, { ctxFiles: { 'audit-units.txt': unitsTxt, 'audit-inventory.json': inv, 'findings.json': result([req()], { unit_findings: [gap] }), ...ALL, 'audit-meta.json': { ...ALL['audit-meta.json'], rotation: { rotate: true } } }, env: { AUDIT_ISSUE: 'true', SCAN_SCOPE: 'all' } });
    const issue = r.calls.created[0];
    assert.ok(issue, `${n}: the issue was written (status ${r.calls.outputs.status})`);
    assert.ok(Buffer.byteLength(issue.body) <= 64000, `${n}: ${Buffer.byteLength(issue.body)} bytes`);
    const st = audit.readState(issue.body), ids = new Set(st.blocks.map((b) => b.cid));
    assert.ok(ids.has(gapId), `${n}: the gap is kept`);
    assert.ok(st.blocks.length < n);
    assert.deepEqual(Object.keys(st.versions.uv).filter((k) => !ids.has(k)), [], 'uv holds only kept units');
    assert.match(issue.body, new RegExp(`${n + 1 - st.blocks.length} older block\\(s\\) are dropped`));
  }
});

test('validate: unit_findings null, missing or holding a non-object row, with units listed, leaves every listed unit not reviewed; a valid [] and runs with no units listed keep "no findings"', () => {
  const units = new Map([[UID, { id: UID }], [A1, { id: A1 }]]), all = [A1, UID].sort();
  const mk = (uf) => { const r = clone(result([req()])); if (uf === undefined) delete r.unit_findings; else r.unit_findings = uf; return r; };
  for (const [name, uf, re] of [['null', null, /unit_findings was missing or null/], ['missing', undefined, /unit_findings was missing or null/], ['[null]', [null], /dropped: not an object/]]) {
    const o = mk(uf); assert.equal(validate(o, ONE(), units).ok, true, name);
    assert.deepEqual(o.invalid_units.sort(), all, name + ': not reviewed'); assert.match(o.not_reviewed.join('\n'), re, name);
  }
  const ok = mk([]); validate(ok, ONE(), units); assert.deepEqual(ok.invalid_units, [], 'a valid [] is no findings');
  for (const uf of [null, undefined, [null]]) { const o = mk(uf); validate(o, ONE(), new Map()); assert.deepEqual(o.invalid_units, [], 'no units listed: unchanged'); assert.deepEqual(o.unit_findings, []); }
});

test('run: scan_scope all with eligible source but nothing reviewed (every file over the size cap, no document) is incomplete and fails the strict gate; nothing in scope stays complete', async (t) => {
  const { spawnSync } = require('node:child_process');
  const inv = { head: 'abc123', eligible: 1, units: 0, not_inventoried: 1, not_reached: 0, not_reached_cap: 0, not_reached_time: 0, rows: [], unreviewed: [] };
  const meta = { head: 'abc123', max_requirements: 80, docs: 0, scan_scope: 'all', limitations: [] };
  const r = await runPost(t, { env: { SKIP: 'true', SCAN_SCOPE: 'all' }, ctxFiles: { 'audit-meta.json': meta, 'audit-inventory.json': inv } });
  assert.equal(r.calls.outputs.status, 'incomplete'); assert.match(r.calls.outputs.reason, /1 eligible source file not reviewed/);
  assert.match(r.calls.summary, /1 eligible source file not reviewed/);
  const gate = (status, foe) => spawnSync(process.execPath, [path.join(__dirname, 'fail-on-error.js')], { encoding: 'utf8', env: { ...process.env, STATUS: status, REASON: '', CTX: r.w.ctx, FAIL_ON_ERROR: foe } });
  assert.equal(gate('incomplete', 'true').status, 1); assert.match(gate('incomplete', 'true').stdout, /1 source file over 512 KiB not inventoried/); assert.equal(gate('incomplete', 'false').status, 0);
  const none = await runPost(t, { env: { SKIP: 'true', SCAN_SCOPE: 'all' }, ctxFiles: { 'audit-meta.json': meta } });
  assert.equal(none.calls.outputs.status, 'complete');
  const sample = await runPost(t, { env: { SKIP: 'true' }, ctxFiles: { 'audit-meta.json': { ...meta, scan_scope: undefined }, 'audit-inventory.json': inv } });
  assert.equal(sample.calls.outputs.status, 'complete', 'outside scan_scope all it stays a sample');
});

test('run: scan_scope all, zero units and zero documents, but scan_paths files dropped as non-unit or an oversize document: the SKIP run is incomplete and fails the strict gate', async (t) => {
  const { spawnSync } = require('node:child_process');
  const meta = { head: 'abc123', max_requirements: 80, docs: 0, scan_scope: 'all', limitations: [] };
  for (const [name, extra, re] of [['not_unit', { not_unit: 2 }, /2 source files in scan_paths dropped/], ['docs_over_size', { docs_over_size: 1 }, /1 requirement document over 256 KiB not admitted/]]) {
    const r = await runPost(t, { env: { SKIP: 'true', SCAN_SCOPE: 'all' }, ctxFiles: { 'audit-meta.json': { ...meta, ...extra } } });
    assert.equal(r.calls.outputs.status, 'incomplete', name); assert.match(r.calls.outputs.reason, re, name);
    const gate = (foe) => spawnSync(process.execPath, [path.join(__dirname, 'fail-on-error.js')], { encoding: 'utf8', env: { ...process.env, STATUS: 'incomplete', REASON: '', CTX: r.w.ctx, FAIL_ON_ERROR: foe } });
    assert.equal(gate('true').status, 1, name); assert.match(gate('true').stdout, re, name); assert.equal(gate('false').status, 0, name);
  }
  const sample = await runPost(t, { env: { SKIP: 'true' }, ctxFiles: { 'audit-meta.json': { ...meta, scan_scope: undefined, not_unit: 2, docs_over_size: 1 } } });
  assert.equal(sample.calls.outputs.status, 'complete', 'outside scan_scope all it stays a sample');
});

// ---- coverage-backed audit (coverage_files in scan mode) ----
const CSRC = {
  'src/m.js': [
    'function guard(x) {', '  if (!x) {', '    throw new Error("no");', '  }', '  return x;', '}', '',
    'function logIt(m) {', '  console.log(m);', '}',
    'function plain(a) {', '  const b = a + 1;', '  const c = b * 2;', '  return c;', '}',
    'function ran(a) {', '  return a + 1;', '}',
    'function logThrow(m) {', '  console.log(m);', '  throw new Error(m);', '}',
  ],
};
const covOf = (files, over = {}) => ({ v: 2, mode: 'all', reports: 1, total: {}, files, unreported: [], notes: [], ...over });
const CFILE = { 'src/m.js': { inst: 14, exec: 3, never: [[3, 3], [9, 9], [12, 13], [20, 21]], ran: [[2, 2], [5, 5], [17, 17]], miss: [[3, 3], [9, 9], [12, 13], [20, 21]] } };
const rd = (p) => CSRC[p] || null;
const notTest = (p) => /test/.test(p);
const mt = (line, over = {}) => ({ unit: A1, kind: 'missing_test', path: 'src/m.js', line, quote: CSRC['src/m.js'][line - 1].trim(), title: `claim at ${line}`, body: 'model text', skeleton: '', fid: `fid${line}`, low: false, ...over });
const scanOf = (findings, cov = covOf(CFILE), top = 10) => audit.scanCoverage({ cov, findings, readLines: rd, isTest: notTest, top });
const codeWith = (sc) => ({ ...codeOf([urow(A1, { path: 'src/m.js' })]), findings: sc.findings, gaps: sc.gaps });

test('scan coverage: never-run lines are grouped per definition repo-wide; logging-only groups are dropped, guard and error branches are kept, branching ranks first', () => {
  const { gaps } = scanOf([]);
  assert.equal(gaps.filtered, 1, 'logIt (console.log only) is not worth a test');
  const names = [...gaps.emit, ...gaps.roll.flatMap((r) => r.groups)].map((g) => g.name);
  assert.deepEqual(names, ['logThrow', 'guard', 'plain'], 'a throw or if line is kept; a logging line next to a throw does not drop the group; branching first, then size');
  assert.deepEqual(gaps.emit.map((g) => g.lines), [[20, 21], [3], [12, 13]]);
  assert.ok(gaps.emit[0].branch > 0 && gaps.emit[1].branch > 0 && gaps.emit[2].branch === 0);
});

test('scan coverage: the top K are listed with exact line ranges and source: coverage, the rest are one rollup line per file in Details', () => {
  const sc = scanOf([], covOf(CFILE), 1);
  assert.equal(sc.gaps.emit.length, 1);
  assert.equal(sc.gaps.roll.length, 1);
  assert.equal(sc.gaps.roll[0].groups.length, 2);
  const md = render({ data: clean(), code: codeWith(sc) });
  const vis = md.slice(0, md.indexOf('<details>')), det = md.slice(md.indexOf('<details>'));
  assert.match(vis, /### Unit test gaps from the coverage report \(1\)/);
  assert.match(vis, /logThrow: 2 lines never executed by any unit test \(L20-L21\)/);
  assert.match(vis, /source: coverage/);
  assert.doesNotMatch(vis, /guard|plain/);
  assert.match(vis, /❌ 3 unit test gaps/, 'the deterministic gaps count in the verdict');
  assert.match(det, /More never-executed definitions, per file \(2; coverage report\)/);
  assert.match(det, /`src\/m\.js`: 2 more never-executed definitions: guard, plain/);
});

test('scan coverage: a model missing_test on a line that ran becomes a low-confidence weak_test (source relabel) and is never counted as a gap', () => {
  const sc = scanOf([mt(17)]);
  const f = sc.findings[0];
  assert.equal(f.kind, 'weak_test');
  assert.equal(f.source, 'relabel');
  assert.equal(f.low, true);
  assert.match(f.title, /this line runs under unit tests/);
  assert.equal(sc.relabeled, 1);
  const md = render({ data: clean(), code: codeWith(sc) });
  assert.doesNotMatch(md.slice(0, md.indexOf('<details>')), /claim at 17/);
});

test('scan coverage: a claim on an uninstrumented line says (not verified by coverage); one on a never-run line outside any gap group says so', () => {
  const sc = scanOf([mt(16), mt(9)]);
  assert.match(sc.findings[0].title, /claim at 16 \(not verified by coverage\)/);
  assert.equal(sc.findings[0].kind, 'missing_test');
  assert.equal(sc.unverified, 1);
  assert.match(sc.findings[1].title, /\(coverage: never executed\)/, 'logIt was filtered, so the claim keeps its own entry');
});

test('scan coverage: the model skeleton of a claim inside a never-run definition is attached to its gap entry, not listed twice', () => {
  const sc = scanOf([mt(3, { title: 'throw on empty is untested', skeleton: 'test("guard throws", () => { assert.throws(() => guard(0)); });' })]);
  assert.equal(sc.findings.length, 0);
  assert.equal(sc.merged, 1);
  const md = render({ data: clean(), code: codeWith(sc) });
  const vis = md.slice(0, md.indexOf('<details>'));
  assert.match(vis, /throw on empty is untested/);
  assert.match(vis, /guard throws/);
  assert.doesNotMatch(vis, /### Untested behaviour/);
});

test('scan coverage: without a report the output is unchanged plus one line that missing_test findings are not verified', () => {
  const f = mt(17);
  const off = scanOf([f], null);
  assert.deepEqual(off.findings, [f]);
  assert.equal(off.gaps, null);
  assert.deepEqual(scanOf([f], covOf(CFILE, { reports: 0 })).findings, [f]);
  const md = render({ data: clean(), code: codeWith(off) });
  assert.match(md, /Missing-unit-test findings are not verified: no coverage report/);
  assert.doesNotMatch(render({ data: clean(), code: codeWith(scanOf([f])) }), /not verified: no coverage report/);
  assert.doesNotMatch(render({ data: clean(), code: codeWith(scanOf([], null)) }), /not verified: no coverage report/, 'no missing_test, no line');
});

test('scan coverage: a hostile path or definition name from the report cannot inject markup, mentions or comments; the model cannot set source', () => {
  const bad = 'src/<img src=x onerror=1>@everyone<!-- x -->.js';
  const lines = ['function f(x) {', '  if (x) {', '    throw new Error("boom");', '  }', '}'];
  const sc = audit.scanCoverage({ cov: covOf({ [bad]: { inst: 3, exec: 0, never: [[3, 3]], ran: [], miss: [] } }), findings: [], readLines: (p) => (p === bad ? lines : null), isTest: notTest });
  assert.equal(sc.gaps.emit.length, 1);
  const md = render({ data: clean(), code: { ...codeOf([urow(A1)]), gaps: sc.gaps } });
  assert.doesNotMatch(md, /<img|@everyone|<!--/);
  const v = clone(result([], { unit_findings: [{ unit: A1, kind: 'missing_test', path: 'src/m.js', line: 3, quote: 'throw', title: 't', source: 'coverage', confidence: 'high' }] }));
  assert.deepEqual(validate(v, new Map(), new Map([[A1, { id: A1 }]])), { ok: true });
  assert.equal(v.unit_findings[0].source, undefined);
});
