const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const audit = require('./audit-post');
const { validate, verify, render, MARK, TITLE, HEADING } = audit;

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
const result = (rs = [req()], over = {}) => ({ docs_reviewed: ['docs/design.md'], requirements: rs, not_requirements: [], not_reviewed: [], ...over });
const clone = (o) => JSON.parse(JSON.stringify(o));

test('validate: accepts a good result and the enum lists match audit.schema.json', () => {
  assert.deepEqual(validate(result()), { ok: true });
  assert.deepEqual(validate(result([])), { ok: true });
  const item = SCHEMA.properties.requirements.items.properties;
  assert.deepEqual(item.status.enum, audit.STATUS);
  assert.deepEqual(item.class.enum, audit.CLASS);
  assert.deepEqual(item.tests.items.properties.layer.enum, ['unit', 'component', 'integration', 'e2e']);
  assert.deepEqual(SCHEMA.properties.requirements.items.required.sort(), ['class', 'code', 'id', 'note', 'source', 'status', 'tests', 'text']);
  assert.deepEqual(SCHEMA.required.slice().sort(), ['docs_reviewed', 'not_requirements', 'not_reviewed', 'requirements']);
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
  rej(result([req()], { not_requirements: [nr(C1)] }), /answered both as not_a_requirement and as a requirement/);
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

test('verify: a block the model skipped, or whose rows all failed verification, becomes an unknown "not assessed" row', () => {
  const missed = verify(result([req()]), { read, cands: TWO() });
  assert.deepEqual(missed.requirements.map((x) => [x.id, x.status]), [[C1, 'covered'], [C2, 'unknown']]);
  assert.equal(missed.requirements[1].note, 'Not assessed by the model.');
  assert.deepEqual(missed.requirements[1].source, { path: 'docs/design.md', line: 4, quote: 'A plan must start in the future.' });
  assert.equal(missed.requirements[1].text, 'A plan must start in the future.');
  const bad = req({ id: C2, source: { path: 'docs/design.md', line: 4, quote: 'A plan never turns off at all.' } });
  const failed = verify(result([req(), bad]), { read, cands: TWO() });
  assert.deepEqual(failed.requirements.map((x) => [x.id, x.status]), [[C1, 'covered'], [C2, 'unknown']]);
  assert.match(failed.requirements[1].note, /Not assessed: the model's citation for this block did not verify\./);
  assert.match(failed.not_reviewed.join('\n'), new RegExp(`${C2} \\(docs/design\\.md:4\\): the requirement quote was not found`));
  const skipped = verify(result([req()], { not_requirements: [{ cid: C2, reason: 'rationale only' }] }), { read, cands: TWO() });
  assert.equal(skipped.requirements.length, 1, 'a not_a_requirement block gets no row');
});

const sample = () => {
  const rs = [req(), req({ id: C2, text: 'A plan must start in the future.', source: cite('docs/design.md', 4), class: 'unit', status: 'missing_test', tests: [], note: 'No test rejects a past start.' }),
    req({ id: C3, status: 'needs_human', class: 'human', code: [], tests: [], text: 'The plan list looks calm.' })];
  return verify(result(rs, { not_reviewed: ['docs/old.md: unreadable'] }), { read });
};

test('render: header counts by block status, no percentage, the disclaimer; one line per block, sub-row evidence collapsed per document', () => {
  const md = render({ data: sample(), docs: [['docs/design.md', 'discovered']], blob: 'https://github.com/o/r/blob/abc', usage: '<sub>Engine: copilot</sub>', cap: 80, candidates: 131 });
  const head = md.slice(0, md.indexOf('### '));
  assert.match(head, /^## SpecGuard unit test gap scan\n\nBehaviour described in the design documents, checked for unit-test evidence\.\n\n\*\*3 requirements\*\* from 1 document\n\n3 blocks scanned of 131 in the documents \(cap 80\); 0 blocks were not requirements\./);
  assert.doesNotMatch(head, /the model chose/);
  assert.match(head, /By block: new gap \(unconfirmed\) 1 · unsure 1 · covered 1\n/);
  assert.match(head, /first scan run[^\n]*every gap is \*\*unconfirmed\*\*; one more scan run will confirm/);
  assert.match(head, /Static review; not coverage; not for scoring people\./);
  assert.doesNotMatch(md, /\d\s*%|percent/i);
  assert.match(md, /### New gaps, unconfirmed \(1\)\n\n\| Block \| Line \| Requirement \| Status \| Sub-rows \|\n\|---\|---\|---\|---\|---\|\n/);
  assert.match(md, /\| \`2222222b\` \| \[docs\/design\.md:4\]\(https:\/\/github\.com\/o\/r\/blob\/abc\/docs\/design\.md#L4\) \| A plan must start in the future\. \| gap \(unconfirmed\) \| missing_test ×1 \|\n/);
  assert.doesNotMatch(md, /### Confirmed gaps/, 'nothing to confirm on a first run');
  // unsure and covered blocks are collapsed, in that order, after the gaps
  assert.match(md, /<details><summary>Unsure \(1\)<\/summary>\n\n\| Block[^\n]*\n\|---[^\n]*\n\| \`3333333c\`[^\n]*\| unsure \| needs_human ×1 \|\n\n<\/details>/);
  assert.match(md, /<details><summary>Covered \(1\)<\/summary>\n\n\| Block[^\n]*\n\|---[^\n]*\n\| \`1111111a\`[^\n]*\| covered \| covered ×1 \|\n\n<\/details>/);
  const at = (x) => md.indexOf(x);
  assert.ok(at('### New gaps') < at('<summary>Unsure') && at('<summary>Unsure') < at('<summary>Covered') && at('<summary>Covered') < at('<summary>Sub-row evidence'));
  // the per-sub-row evidence is one collapsed table per document
  assert.match(md, /<details><summary>Sub-row evidence: docs\/design\.md \(3 rows\)<\/summary>\n\n\| Requirement \| Status \| Class \| Evidence \|\n\|---\|---\|---\|---\|\n/);
  assert.match(md, /\| \[2222222b\]\(https:\/\/github\.com\/o\/r\/blob\/abc\/docs\/design\.md#L4\) A plan must start in the future\.<br><sub>No test rejects a past start\.<\/sub> \| missing_test \| unit \| code: \[src\/plan\.js:2\]\(https:\/\/github\.com\/o\/r\/blob\/abc\/src\/plan\.js#L2\) \|/);
  assert.match(md.slice(md.indexOf('<summary>Sub-row evidence')), /tests: unit \[tests\/plan\.test\.js:2\]/);
  assert.doesNotMatch(md.slice(0, md.indexOf('<details>')), /\| covered \|/);
  assert.match(md, /\`not_implemented\` and \`missing_test\` are model claims \(not verified statically\)/);
  assert.match(md, /### Not reviewed\n\n- docs\/old\.md: unreadable\n/);
  assert.doesNotMatch(md, /not requirements<\/summary>/, 'no details block when every block was a requirement');
  assert.ok(md.trimEnd().endsWith('<sub>Engine: copilot</sub>'));
});

test('render: rejected candidate documents say how to include them; unread admitted documents are listed; markup in model text is neutralised', () => {
  const data = result([req({ text: 'Click <img src=x> @team <!-- hidden --> | pipe', note: '' })]);
  const md = render({ data, docs: [['docs/design.md', 'discovered'], ['docs/other.md', 'discovered']], rejected: [['README.md', 'only 1 normative item']] });
  assert.match(md, /### Documents not included\n\nThese looked like requirement documents but were not admitted \(add them to `requirements_paths` to include\):\n\n- `README\.md`: only 1 normative item/);
  assert.match(md, /`docs\/other\.md` was admitted but is not in docs_reviewed\./);
  assert.doesNotMatch(md, /<img|<!--|@team/);
  assert.match(md, /\\\| pipe/);
});

test('render: no documents and failures say so', () => {
  assert.match(render({ data: null, rejected: [['README.md', 'x']] }), /No design documents were found, so nothing was scanned\.[\s\S]*Documents not included/);
  assert.match(render({ failure: 'the engine timed out' }), /Could not complete: the engine timed out/);
});

test('render: blocks that were not requirements are counted in the header and listed in a collapsed block, not in the tables', () => {
  const data = verify(result([req()], { not_requirements: [{ cid: C2, reason: 'rationale, not behaviour <b>x</b>' }] }), { read, cands: TWO() });
  const md = render({ data, blob: 'https://github.com/o/r/blob/abc', candidates: 9, cap: 5, capLeft: ['docs/design.md § 4. After: 3 blocks not scanned (cap)'] });
  assert.match(md, /2 blocks scanned of 9 in the documents \(cap 5\); 1 block was not a requirement\./);
  assert.ok(md.includes('<details><summary>1 block was not a requirement</summary>\n\n- [docs/design.md:4](https://github.com/o/r/blob/abc/docs/design.md#L4) `2222222b` A plan must start in the future. (rationale, not behaviour &lt;b>x&lt;/b>)'), md);
  assert.doesNotMatch(md.slice(0, md.indexOf('<details>')), /2222222b/, 'not in the main tables');
  assert.match(md, /### Not reviewed\n\n- docs\/design\.md § 4\. After: 3 blocks not scanned \(cap\)\n/);
  assert.doesNotMatch(md, /<b>/, "markup in the reason is neutralised");
  const two = render({ data: { ...data, not_requirements: [data.not_requirements[0], data.not_requirements[0]] }, candidates: 2 });
  assert.match(two, /2 blocks were not requirements/);
});

test('render: over the limit, whole rows are dropped (never cut mid-row) and the omission is stated', () => {
  const rs = Array.from({ length: 60 }, (_, i) => req({ id: cid(i + 1), status: 'missing_test', tests: [], note: 'n'.repeat(250) }));
  const data = verify(result(rs), { read });
  const full = render({ data });
  const small = render({ data, max: 9000 });
  assert.ok(Buffer.byteLength(small) <= 9000 && small.length < full.length);
  const tableRows = small.split('\n').filter((l) => /^\| [\`[]/.test(l));
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
function mocks({ issues = [], login = null, failList = false } = {}) {
  const calls = { created: [], updated: [], summary: '', warnings: [] };
  const github = {
    paginate: async (fn) => { if (failList) throw new Error('403'); return fn(); },
    rest: { users: { getAuthenticated: async () => { if (!login) throw new Error('no /user for GITHUB_TOKEN'); return { data: { login } }; } },
      issues: { listForRepo: () => issues, create: async (a) => { calls.created.push(a); }, update: async (a) => { calls.updated.push(a); } } },
  };
  const core = { warning: (m) => calls.warnings.push(m), summary: { addRaw(s) { calls.summary = s; return this; }, async write() {} } };
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
  try { await audit({ github: m.github, context: m.context, core: m.core }); } finally { for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]; Object.assign(process.env, saved); }
  return { ...m, w };
}

test('run: validates citations at HEAD, renders the summary, writes audit.json, usage line included, no issue by default', async (t) => {
  const bad = req({ id: C2, source: { path: 'docs/design.md', line: 4, quote: 'not in the doc at all' } });
  const r = await runPost(t, { ctxFiles: { 'findings.json': result([req(), bad]), 'audit-candidates.txt': candTxt(TWO()), 'usage.json': { totalNanoAiu: 2e9 } }, env: { ENGINE: 'copilot', MODEL: 'auto' } });
  assert.match(r.calls.summary, /\*\*2 requirements\*\* from 1 document/);
  assert.match(r.calls.summary, /2222222b \(docs\/design\.md:4\): the requirement quote was not found/);
  assert.match(r.calls.summary, /Not assessed: the model's citation for this block did not verify/);
  assert.match(r.calls.summary, /<sub>Engine: copilot · Model: auto · Cost ≈ \$0\.02/);
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
  const rs = Array.from({ length: 80 }, (_, i) => req({ id: cid(i + 1), text: `Requirement ${i + 1} ${'w'.repeat(280)}`, note: 'n'.repeat(290) }));
  const r = await runPost(t, { ctxFiles: { 'findings.json': result(rs), 'audit-candidates.txt': candTxt(candsOf(...rs.map((x) => cand(x.id, 3, 'x')))) }, env: { AUDIT_ISSUE: 'true' } });
  const body = r.calls.created[0].body;
  assert.ok(Buffer.byteLength(body) <= 65536, String(Buffer.byteLength(body)));
  assert.match(body, /_\d+ rows omitted: the report exceeded the size limit/);
  assert.match(body, /<!-- specguard:audit-state \{"v":3,/, 'the previous state survives the cut');
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
  assert.match(md, /### Doc and code disagree \(unconfirmed\)[\s\S]*\| Requirement \| Document says \| Code says \|\n\|---\|---\|---\|\n/);
  assert.match(md, /\| "A repeating plan stays on after it fires\."<br>\[docs\/design\.md:3\][^\n]*\| "  if \(p\.repeat\) return p;"<br>\[src\/plan\.js:2\]/);
  assert.doesNotMatch(md, /Doc and code disagree \(confirmed\)/);
  assert.match(md, /\| gap \(unconfirmed\) \| contradicted ×1 \|/, 'the block line carries the sub-row statuses');
  const prior = audit.readState(audit.stateComment('aaaaaaa1', data)); // the same block was a gap in the previous run
  const two = render({ data, prior });
  assert.match(two, /### Doc and code disagree \(confirmed\)/);
  assert.doesNotMatch(two, /Doc and code disagree \(unconfirmed\)/);
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
  assert.match(render({ data: d }), /\| gap \(unconfirmed\) \| missing_test ×1, covered ×1 \|/);
});

test('confirmation: gap twice is confirmed, a new gap is unconfirmed, a confirmed gap covered once is "resolved? recheck", covered twice is resolved', () => {
  const r = chain({ [A]: 'missing_test', [U]: 'unknown', [Z]: 'covered' }, { [A]: 'partial', [B]: 'missing_test', [U]: 'missing_test', [Z]: 'unknown' }, { [A]: 'covered', [B]: 'missing_test', [U]: 'unknown', [Z]: 'covered' }, { [A]: 'covered', [B]: 'covered', [U]: 'unknown', [Z]: 'covered' }, { [A]: 'covered', [B]: 'covered', [U]: 'unknown', [Z]: 'covered' });
  assert.deepEqual(r.map((x) => x.marks[A]), ['new', 'confirmed', 'recheck', 'resolved', '']);
  assert.deepEqual(r.map((x) => x.marks[B]), [undefined, 'new', 'confirmed', 'recheck', 'resolved']);
  assert.deepEqual(r.map((x) => x.marks[U]), ['', 'new', '', '', ''], 'an unsure block becoming a gap is unconfirmed');
  // counters: [cid, status, firstSeenHead, consecutive runs]; the first-seen head survives while the status holds
  assert.deepEqual(r[1].blocks.find((b) => b.cid === A).next, [A, 'gap', 'h1', 2]);
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
  assert.match(first.md, /first scan run[^\n]*every gap is \*\*unconfirmed\*\*; one more scan run will confirm/);
  assert.doesNotMatch(first.md, /### Confirmed gaps|Changed since the last scan/);
  assert.match(first.md, /By block: new gap \(unconfirmed\) 2 · unsure 1 · covered 1\n/);
  const md = second.md;
  assert.doesNotMatch(md, /first scan run/);
  assert.match(md, /By block: confirmed gap 1 · new gap \(unconfirmed\) 1 · unsure 1 · covered 2\n/);
  assert.match(md, /A gap is \*\*confirmed\*\* when the block was a gap in this run and in the previous one \(`h1`\)/);
  assert.match(md, new RegExp(`### Confirmed gaps \\(1\\)\\n\\n\\| Block[^\\n]*\\n\\|---[^\\n]*\\n\\| \`${A}\`[^\\n]*\\| gap \\(confirmed since h1\\) \\|`));
  assert.match(md, new RegExp(`### New gaps, unconfirmed \\(1\\)[\\s\\S]*\`${cid(14)}\`[^\\n]*gap \\(unconfirmed\\)`));
  const at = (x) => md.indexOf(x);
  assert.ok(at('### Changed since') < at('### Confirmed gaps') && at('### Confirmed gaps') < at('### New gaps') && at('### New gaps') < at('<summary>Unsure (1)') && at('<summary>Unsure (1)') < at('<summary>Covered (2)') && at('<summary>Covered (2)') < at('<summary>Sub-row evidence'));
  assert.match(md, /<details><summary>Unsure \(1\)<\/summary>\n\n\| Block/);
  assert.match(md, /<details><summary>Covered \(2\)<\/summary>\n\n\| Block/);
});

test('changed since last audit: only 2-run-stable changes are listed; status churn is a count line', () => {
  const [, second, third, fourth] = chain({ [A]: 'missing_test', [U]: 'unknown', [Z]: 'covered', [B]: 'missing_test' }, { [A]: 'missing_test', [U]: 'missing_test', [Z]: 'unknown', [B]: 'covered' },
    { [A]: 'covered', [U]: 'unknown', [Z]: 'covered', [B]: 'covered' }, { [A]: 'covered', [U]: 'unknown', [Z]: 'covered', [B]: 'covered' });
  assert.match(second.md, new RegExp(`### Changed since the last scan \\(\`h1\`\\)\\n\\n- Confirmed gaps that appeared \\(1\\):\\n  - \`${A}\` [^\\n]*\\n\\nUnstable: 3 blocks changed status between the last two runs \\(not listed\\)\\.\\n`));
  assert.doesNotMatch(second.md.slice(second.md.indexOf('### Changed'), second.md.indexOf('### Confirmed gaps')), new RegExp(`${U}|${Z}|${B}`), 'unsure churn is counted, not listed');
  assert.match(third.md, new RegExp(`- Resolved\\? Covered once, recheck next run \\(1\\):\\n  - \`${A}\``));
  assert.match(third.md, /Unstable: 2 blocks changed status/);
  assert.match(fourth.md, new RegExp(`- Resolved \\(covered in two runs\\) \\(1\\):\\n  - \`${A}\``));
  assert.doesNotMatch(fourth.md, /Unstable/);
  assert.match(chain({ [A]: 'covered' }, { [A]: 'covered' })[1].md, /### Changed since the last scan \(`h1`\)\n\nNo confirmed changes\.\n/);
});

test('state: v3 round trip and tamper check; a v2 (per-row) state reads as one prior run; v1 and foreign comments are no state', () => {
  const rows = verify(result([req(), req({ id: C2, source: cite('docs/design.md', 4), status: 'missing_test', tests: [], text: 'A plan must start in the future.' })]), { read, cands: TWO() });
  const state = audit.stateComment('abc123def', rows);
  assert.match(state, /^<!-- specguard:audit-state \{"v":3,"head":"abc123def","blocks":\[\["1111111a","covered","abc123d",1\],\["2222222b","gap","abc123d",1\]\]\} -->$/);
  assert.deepEqual(audit.readState(`${MARK}\nbody\n${state}`), { head: 'abc123def', blocks: [{ cid: C1, status: 'covered', since: 'abc123d', runs: 1 }, { cid: C2, status: 'gap', since: 'abc123d', runs: 1 }] });
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
  assert.deepEqual(v2, { head: 'abcdef123456', blocks: [{ cid: C1, status: 'gap', since: 'abcdef1', runs: 1 }, { cid: C2, status: 'covered', since: 'abcdef1', runs: 1 }, { cid: C3, status: 'unsure', since: 'abcdef1', runs: 1 }] });
  const now = dataOf({ [C1]: 'missing_test', [C2]: 'missing_test', [C3]: 'unknown' });
  const md = render({ data: now, prior: v2, head: 'h2' });
  assert.match(md, /### Confirmed gaps \(1\)[\s\S]*`1111111a`/, 'gap in the v2 run and now: confirmed');
  assert.match(md, /### New gaps, unconfirmed \(1\)[\s\S]*`2222222b`/);
  assert.match(md, /Unstable: 1 block changed status/);
  assert.match(audit.stateComment('h2', now, v2), /"blocks":\[\["1111111a","gap","abcdef1",2\],\["2222222b","gap","h2",1\],\["3333333c","unsure","abcdef1",2\]\]/);
});

test('run: a previous issue state drives confirmation in summary and issue; the issue ends with the new v3 state', async (t) => {
  const first = await runPost(t, { ctxFiles: { 'findings.json': result() }, env: { AUDIT_ISSUE: 'true' } });
  const old = first.calls.created[0].body;
  assert.doesNotMatch(old, /Changed since the last scan/);
  assert.match(old, /first scan run/);
  assert.match(old, /<!-- specguard:audit-state \{"v":3,"head":"abc123","blocks":\[\["1111111a","covered","abc123",1\]\]\} -->$/);
  const rs = [req({ status: 'missing_test', tests: [] }), req({ id: C2, source: cite('docs/design.md', 4), text: 'A plan must start in the future.', status: 'missing_test', tests: [] })];
  const r = await runPost(t, { ctxFiles: { 'findings.json': result(rs), 'audit-candidates.txt': candTxt(TWO()) }, env: { AUDIT_ISSUE: 'true' }, mock: { issues: [{ number: 9, body: old, user: BOT }] } });
  const second = r.calls.updated[0].body;
  for (const md of [r.calls.summary, second]) {
    assert.match(md, /### Changed since the last scan \(`abc123`\)/);
    assert.match(md, /No confirmed changes\.[\s\S]*Unstable: 1 block changed status between the last two runs \(not listed\)\./);
    assert.match(md, /### New gaps, unconfirmed \(2\)/);
    assert.doesNotMatch(md, /### Confirmed gaps/);
  }
  assert.match(second, /"blocks":\[\["1111111a","gap","abc123",1\],\["2222222b","gap","abc123",1\]\]/);
  const third = await runPost(t, { ctxFiles: { 'findings.json': result(rs), 'audit-candidates.txt': candTxt(TWO()) }, env: { AUDIT_ISSUE: 'true' }, mock: { issues: [{ number: 9, body: second, user: BOT }] } });
  for (const md of [third.calls.summary, third.calls.updated[0].body]) {
    assert.match(md, /### Confirmed gaps \(2\)/);
    assert.match(md, /Confirmed gaps that appeared \(2\):/);
  }
  assert.match(third.calls.updated[0].body, /"blocks":\[\["1111111a","gap","abc123",2\],\["2222222b","gap","abc123",2\]\]/);
});

// Real audits of one commit (same model, 80 fixed blocks): set SPECGUARD_REPLAY to the directory holding r1/ and r2/ (each with audit.json, or specguard-audit-1/audit.json).
test('replay: two real audits of the same commit confirm the gaps that agree (46 of the 80 blocks)', { skip: !process.env.SPECGUARD_REPLAY }, () => {
  const load = (n) => { const d = path.join(process.env.SPECGUARD_REPLAY, n), f = fs.existsSync(path.join(d, 'audit.json')) ? d : path.join(d, 'specguard-audit-1'); return JSON.parse(fs.readFileSync(path.join(f, 'audit.json'), 'utf8')); };
  const r1 = load('r1'), r2 = load('r2');
  const prior = audit.readState(audit.stateComment(r1.head, r1));
  const bs = audit.track(audit.blocksOf(r2), prior, r2.head), n = (m) => bs.filter((b) => b.mark === m).length;
  assert.deepEqual([bs.length, n('confirmed'), n('new')], [80, 46, 14]);
  const first = render({ data: r1, head: r1.head }), md = render({ data: r2, prior, head: r2.head });
  assert.match(first, /new gap \(unconfirmed\) \d+/);
  assert.match(md, /By block: confirmed gap 46 · new gap \(unconfirmed\) 14 · unsure 11 · covered 6 · not a requirement 3/);
});

test('run (A5): an engine that did not succeed gives a Partial scan banner, keeps verified rows, writes no issue', async (t) => {
  const r = await runPost(t, { ctxFiles: { 'findings.json': result(), 'engine-status': 'timeout\n' }, env: { AUDIT_ISSUE: 'true' }, mock: { issues: [{ number: 9, body: `${MARK}\nold`, user: BOT }] } });
  assert.match(r.calls.summary, /> \*\*Partial scan: engine timeout\.\*\*/);
  assert.match(r.calls.summary.slice(0, r.calls.summary.indexOf('**1 requirement**')), /Partial scan/, 'the banner comes first');
  assert.match(r.calls.summary, /\*\*1 requirement\*\*/);
  assert.deepEqual([r.calls.created, r.calls.updated], [[], []]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(r.w.ctx, 'audit.json'), 'utf8')).partial, 'engine timeout');
  const ok = await runPost(t, { ctxFiles: { 'findings.json': result(), 'engine-status': 'success\n' } });
  assert.doesNotMatch(ok.calls.summary, /Partial scan/);
  const rf = await runPost(t, { ctxFiles: { 'findings.json': result(), 'engine-repair': 'repair_failed\n' } });
  assert.match(rf.calls.summary, /Partial scan: engine JSON repair failed/);
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
  assert.ok(md.startsWith('## SpecGuard unit test gap scan\n\nBehaviour described in the design documents, checked for unit-test evidence at `abcdef1`.\n\n'));
  assert.doesNotMatch(md, /audit/i);
  assert.doesNotMatch(render({ data: null, head: 'abcdef1' }), /audit/i);
  assert.doesNotMatch(render({ data: sample(), failure: 'x', partial: 'engine timeout' }), /audit/i);
  assert.equal(TITLE, 'SpecGuard: unit test gap scan');
});

test('run (rename): an issue created under the old title and marker is found and updated, not duplicated', async (t) => {
  const first = await runPost(t, { ctxFiles: { 'findings.json': result() }, env: { AUDIT_ISSUE: 'true' } });
  const legacy = { number: 11, title: 'SpecGuard requirements audit', body: first.calls.created[0].body.replace('## SpecGuard unit test gap scan', '## SpecGuard requirements audit'), user: BOT };
  assert.ok(legacy.body.startsWith('<!-- specguard:audit -->\n## SpecGuard requirements audit'), 'the old marker is the one still in use');
  const r = await runPost(t, { ctxFiles: { 'findings.json': result() }, env: { SCAN_ISSUE: 'true' }, mock: { issues: [legacy] } });
  assert.equal(r.calls.created.length, 0, 'no duplicate');
  assert.deepEqual(r.calls.updated.map((u) => [u.issue_number, u.title]), [[11, TITLE]]);
  assert.ok(r.calls.updated[0].body.startsWith(`${MARK}\n## SpecGuard unit test gap scan`));
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
  assert.match(md, /\*\*1 requirement\*\* from 1 document\n\n2 blocks scanned of 14 in the documents \(cap 2\); 1 block was not a requirement\./);
  assert.match(md, /<details><summary>1 block was not a requirement<\/summary>[\s\S]*2222222b[\s\S]*\(rationale, not behaviour\)/);
  assert.match(md, /### Not reviewed\n\n- docs\/design\.md § 4\. After: 12 blocks not scanned \(cap\)\n/);
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
