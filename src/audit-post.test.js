const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const audit = require('./audit-post');
const { validate, verify, render, MARK, TITLE } = audit;

const SCHEMA = JSON.parse(fs.readFileSync(path.join(__dirname, 'audit.schema.json'), 'utf8'));
const FILES = {
  'docs/design.md': ['# Plan design', '', 'A repeating plan stays on after it fires.', 'A plan must start in the future.'],
  'src/plan.js': ['function fire(p) {', '  if (p.repeat) return p;', '  return { ...p, on: false };', '}'],
  'tests/plan.test.js': ['test("repeat stays on", () => {', '  assert.equal(fire({ repeat: true }).on, true);', '});'],
};
const read = (p) => FILES[p] || null;
const cite = (path, line) => ({ path, line, quote: FILES[path][line - 1] });
const req = (over = {}) => ({
  id: 'R1', source: cite('docs/design.md', 3), text: 'A repeating plan stays on after it fires.', class: 'unit', status: 'covered',
  code: [cite('src/plan.js', 2)], tests: [{ ...cite('tests/plan.test.js', 2), layer: 'unit' }], note: '', ...over,
});
const result = (rs = [req()], over = {}) => ({ docs_reviewed: ['docs/design.md'], requirements_found: rs.length, requirements: rs, not_reviewed: [], ...over });
const clone = (o) => JSON.parse(JSON.stringify(o));

test('validate: accepts a good result and the enum lists match audit.schema.json', () => {
  assert.deepEqual(validate(result()), { ok: true });
  assert.deepEqual(validate(result([])), { ok: true });
  const item = SCHEMA.properties.requirements.items.properties;
  assert.deepEqual(item.status.enum, audit.STATUS);
  assert.deepEqual(item.class.enum, audit.CLASS);
  assert.deepEqual(item.tests.items.properties.layer.enum, ['unit', 'component', 'integration', 'e2e']);
  assert.deepEqual(SCHEMA.properties.requirements.items.required.sort(), ['class', 'code', 'id', 'note', 'source', 'status', 'tests', 'text']);
});

test('validate: rejects bad enums, missing fields, duplicate ids and bad citations; clips long quotes', () => {
  const bad = (mutate, re) => { const o = result(); mutate(o); const v = validate(o); assert.equal(v.ok, false); assert.match(v.error, re); };
  bad((o) => { o.requirements[0].status = 'fine'; }, /status must be one of/);
  bad((o) => { o.requirements[0].class = 'integration'; }, /class must be one of/);
  bad((o) => { o.requirements[0].tests[0].layer = 'system'; }, /tests must be/);
  bad((o) => { delete o.requirements[0].text; }, /id and text/);
  bad((o) => { delete o.requirements[0].source; }, /source needs/);
  bad((o) => { o.requirements[0].source.line = 0; }, /source needs/);
  bad((o) => { o.requirements[0].code = [{ path: 'a', line: 1 }]; }, /code must be/);
  bad((o) => { o.requirements[0].code = 'none'; }, /code must be/);
  bad((o) => { o.requirements.push(req()); }, /duplicate id/);
  bad((o) => { delete o.docs_reviewed; }, /docs_reviewed/);
  bad((o) => { o.not_reviewed = 'none'; }, /not_reviewed/);
  bad((o) => { o.requirements_found = -1; }, /requirements_found/);
  bad((o) => { delete o.requirements; }, /requirements must be an array/);
  for (const x of [null, [], 'x', 3]) assert.equal(validate(x).ok, false);
  const long = result([req({ source: { ...cite('docs/design.md', 3), quote: 'x'.repeat(300) } })]);
  assert.equal(validate(long).ok, true);
  assert.equal(long.requirements[0].source.quote.length, 200);
  const noNote = result([req()]); delete noNote.requirements[0].note;
  assert.equal(validate(noNote).ok, true);
  assert.equal(noNote.requirements[0].note, '');
});

test('verify: good citations pass, a near-miss line is corrected, an untracked or escaping path fails', () => {
  const o = result([req({ code: [{ ...cite('src/plan.js', 2), line: 4 }] })]);
  const v = verify(o, { read, tracked: new Set(Object.keys(FILES)), docs: new Set(['docs/design.md']) });
  assert.equal(v.requirements.length, 1);
  assert.equal(v.requirements[0].status, 'covered');
  assert.equal(v.requirements[0].code[0].line, 2, 'line snapped to where the quote is');
  const far = verify(result([req({ code: [{ ...cite('src/plan.js', 2), line: 40 }] })]), { read });
  assert.equal(far.requirements[0].status, 'unknown');
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

test('verify: the row cap keeps the first rows and says what was cut', () => {
  const rs = [1, 2, 3].map((n) => req({ id: `R${n}` }));
  const v = verify(result(rs), { read, max: 2 });
  assert.equal(v.requirements.length, 2);
  assert.match(v.not_reviewed.join('\n'), /1 further requirement\(s\) beyond audit_max_requirements \(2\)/);
});

const sample = () => {
  const rs = [req(), req({ id: 'AC-4', text: 'A plan must start in the future.', source: cite('docs/design.md', 4), class: 'unit', status: 'missing_test', tests: [], note: 'No test rejects a past start.' }),
    req({ id: 'R3', status: 'needs_human', class: 'human', code: [], tests: [], text: 'The plan list looks calm.' })];
  return verify(result(rs, { requirements_found: 5, not_reviewed: ['docs/old.md: unreadable'] }), { read });
};

test('render: header counts by status and class, no percentage, the disclaimer, a table per document', () => {
  const md = render({ data: sample(), docs: [['docs/design.md', 'discovered']], blob: 'https://github.com/o/r/blob/abc', usage: '<sub>Engine: copilot</sub>', cap: 80 });
  const head = md.slice(0, md.indexOf('### '));
  assert.match(head, /^## SpecGuard requirements audit\n\n\*\*3 requirements\*\* from 1 document \(listed 3 of 5 found; the model chose which rows to list, the cap of 80 was not reached; see not reviewed\)/);
  assert.match(head, /By status: missing_test 1 · needs_human 1 · covered 1\n/);
  assert.match(head, /By class: unit 2 · human 1\n/);
  assert.match(head, /Static review; not coverage; not for scoring people\./);
  assert.doesNotMatch(md, /\d\s*%|percent/i);
  assert.match(md, /### `docs\/design\.md`\n\n\| Requirement \| Status \| Class \| Evidence \|\n\|---\|---\|---\|---\|\n/);
  assert.match(md, /\| \[[0-9a-f]{8}\]\(https:\/\/github\.com\/o\/r\/blob\/abc\/docs\/design\.md#L4\) \(AC-4\) A plan must start in the future\.<br><sub>No test rejects a past start\.<\/sub> \| missing_test \| unit \| code: \[src\/plan\.js:2\]\(https:\/\/github\.com\/o\/r\/blob\/abc\/src\/plan\.js#L2\) \|/);
  // covered rows are not listed with the gaps: one collapsed table
  assert.match(md, /<details><summary>Covered in full \(1\)<\/summary>\n\n\| Requirement \| Class \| Evidence \|\n\|---\|---\|---\|\n\| \[[0-9a-f]{8}\][^\n]*tests: unit \[tests\/plan\.test\.js:2\][^\n]*\|\n\n<\/details>/);
  assert.doesNotMatch(md.slice(0, md.indexOf('<details>')), /\| covered \|/);
  assert.match(md, /`not_implemented` and `missing_test` are model claims \(not verified statically\)/);
  assert.match(md, /### Not reviewed\n\n- docs\/old\.md: unreadable\n/);
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
  assert.match(render({ data: null, rejected: [['README.md', 'x']] }), /No requirement documents were found, so nothing was audited\.[\s\S]*Documents not included/);
  assert.match(render({ failure: 'the engine timed out' }), /Could not complete: the engine timed out/);
});

test('render: over the limit, whole rows are dropped (never cut mid-row) and the omission is stated', () => {
  const rs = Array.from({ length: 60 }, (_, i) => req({ id: `R${i + 1}`, note: 'n'.repeat(250) }));
  const data = verify(result(rs), { read });
  const full = render({ data });
  const small = render({ data, max: 9000 });
  assert.ok(Buffer.byteLength(small) <= 9000 && small.length < full.length);
  const tableRows = small.split('\n').filter((l) => /^\| [0-9a-f]{8}(-\d+)? /.test(l));
  assert.ok(tableRows.length > 0 && tableRows.length < 60);
  for (const l of tableRows) assert.match(l, /\| unit \| code: .* \|$/, 'every kept row is complete');
  assert.match(small, new RegExp(`_${60 - tableRows.length} rows omitted: the report exceeded the size limit`));
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
  for (const [n, v] of Object.entries(ctxFiles)) w.put(n, v);
  const m = mocks(mock);
  const saved = { ...process.env };
  Object.assign(process.env, { CTX: w.ctx, GITHUB_WORKSPACE: w.root, ENGINE: '', MODEL: '', SKIP: '', AUDIT_ISSUE: 'false', ...env });
  try { await audit({ github: m.github, context: m.context, core: m.core }); } finally { for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]; Object.assign(process.env, saved); }
  return { ...m, w };
}

test('run: validates citations at HEAD, renders the summary, writes audit.json, usage line included, no issue by default', async (t) => {
  const bad = req({ id: 'R2', source: { path: 'docs/design.md', line: 3, quote: 'not in the doc at all' } });
  const r = await runPost(t, { ctxFiles: { 'findings.json': result([req(), bad]), 'usage.json': { totalNanoAiu: 2e9 } }, env: { ENGINE: 'copilot', MODEL: 'auto' } });
  assert.match(r.calls.summary, /\*\*1 requirement\*\* from 1 document/);
  assert.match(r.calls.summary, /R2 \(docs\/design\.md:3\): the requirement quote was not found/);
  assert.match(r.calls.summary, /<sub>Engine: copilot · Model: auto · Cost ≈ \$0\.02/);
  assert.match(r.calls.summary, /\]\(https:\/\/github\.com\/o\/r\/blob\/abc123\/src\/plan\.js#L2\)/);
  const saved = JSON.parse(fs.readFileSync(path.join(r.w.ctx, 'audit.json'), 'utf8'));
  assert.equal(saved.head, 'abc123');
  assert.equal(saved.requirements.length, 1);
  assert.match(saved.requirements[0].id, /^[0-9a-f]{8}$/);
  assert.deepEqual([r.calls.created, r.calls.updated], [[], []]);
});

test('run: missing, invalid or failed engine output is reported as could not complete, never as an audit', async (t) => {
  const none = await runPost(t);
  assert.match(none.calls.summary, /Could not complete: the engine returned no usable JSON/);
  const invalid = await runPost(t, { ctxFiles: { 'findings.json': result([req({ status: 'great' })]) } });
  assert.match(invalid.calls.summary, /Could not complete: the result failed validation: requirements\[0\]: status must be one of/);
  const timeout = await runPost(t, { ctxFiles: { 'engine-status': 'timeout\n' } });
  assert.match(timeout.calls.summary, /the engine timed out/);
  assert.equal(fs.existsSync(path.join(timeout.w.ctx, 'audit.json')), false);
  const skip = await runPost(t, { env: { SKIP: 'true' }, ctxFiles: { 'audit-rejected.txt': 'README.md\tonly 1 normative item\n' } });
  assert.match(skip.calls.summary, /No requirement documents were found[\s\S]*README\.md/);
  const failed = await runPost(t, { mock: {}, ctxFiles: { 'audit-meta.json': 'not json' } });
  assert.match(failed.calls.summary, /the collection step did not produce its context/);
  assert.deepEqual([none, invalid, timeout, skip, failed].flatMap((x) => [...x.calls.created, ...x.calls.updated]), []);
});

test('run: audit_issue true creates one issue titled and marked for us', async (t) => {
  const r = await runPost(t, { ctxFiles: { 'findings.json': result() }, env: { AUDIT_ISSUE: 'true' } });
  assert.equal(r.calls.created.length, 1);
  assert.equal(r.calls.updated.length, 0);
  const c = r.calls.created[0];
  assert.deepEqual([c.owner, c.repo, c.title], ['o', 'r', TITLE]);
  assert.ok(c.body.startsWith(`${MARK}\n## ${TITLE}`));
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
  assert.match(r.calls.warnings.join('\n'), /could not write the audit issue \(needs permissions: issues: write\)/);
});

test('run: the issue body fits GitHub\'s limit by dropping whole rows and says so', async (t) => {
  const rs = Array.from({ length: 80 }, (_, i) => req({ id: `R${i + 1}`, text: `Requirement ${i + 1} ${'w'.repeat(280)}`, note: 'n'.repeat(290) }));
  const r = await runPost(t, { ctxFiles: { 'findings.json': result(rs) }, env: { AUDIT_ISSUE: 'true' } });
  const body = r.calls.created[0].body;
  assert.ok(Buffer.byteLength(body) <= 65536, String(Buffer.byteLength(body)));
  assert.match(body, /_\d+ rows omitted: the report exceeded the size limit/);
  assert.match(body, /<!-- specguard:audit-state \{"v":1,/, 'the previous state survives the cut');
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

test('verify: stable ids hash path, nearest heading and the source line; the model id survives only as doc_id', () => {
  const id = (over, read_ = read) => verify(result([req(over)]), { read: read_ }).requirements[0];
  const a = id({ id: 'R1' }), b = id({ id: 'R9', text: 'worded differently by the model' }), c = id({ id: 'AC-4' });
  assert.match(a.id, /^[0-9a-f]{8}$/);
  assert.equal(a.id, b.id, 'the model\'s numbering and wording do not change it');
  assert.equal(a.doc_id, undefined);
  assert.deepEqual([c.id, c.doc_id], [a.id, 'AC-4']);
  assert.equal(a.heading, 'Plan design');
  const sub = { ...FILES, 'docs/design.md': ['# Other heading', '', 'A repeating plan stays on after it fires.'] };
  assert.notEqual(id({}, (p) => sub[p] || null).id, a.id, 'the heading is part of the id');
  const moved = { ...FILES, 'docs/design.md': ['# Plan design', '', '', 'A repeating plan stays on after it fires.'] };
  assert.equal(id({ source: { path: 'docs/design.md', line: 4, quote: 'A repeating plan stays on after it fires.' } }, (p) => moved[p] || null).id, a.id, 'a moved line keeps its id');
  const twice = verify(result([req({ id: 'R1' }), req({ id: 'R2', text: 'a second behaviour on the same line' })]), { read }).requirements.map((r) => r.id);
  assert.equal(new Set(twice).size, 2, 'two rows on one line still get distinct ids');
});

test('contradicted: both quotes must verify, and it renders as an unconfirmed disagreement with the two quotes side by side', () => {
  const ok = verify(result([req({ status: 'contradicted', class: 'unit', tests: [], note: 'the code turns it off' })]), { read }).requirements[0];
  assert.equal(ok.status, 'contradicted');
  const bad = verify(result([req({ status: 'contradicted', tests: [], code: [{ path: 'src/plan.js', line: 2, quote: 'this line is not in the code' }] })]), { read }).requirements[0];
  assert.equal(bad.status, 'unknown');
  const md = render({ data: { ...result(), requirements: [ok] }, blob: 'https://github.com/o/r/blob/abc' });
  assert.match(md, /### Doc and code disagree \(unconfirmed\)[\s\S]*\| Requirement \| Document says \| Code says \|\n\|---\|---\|---\|\n/);
  assert.match(md, /\| "A repeating plan stays on after it fires\."<br>\[docs\/design\.md:3\][^\n]*\| "  if \(p\.repeat\) return p;"<br>\[src\/plan\.js:2\]/);
  assert.doesNotMatch(md, /\| contradicted \|/);
});

test('verify: "over the cap" is only kept when the cap was reached', () => {
  const nr = ['docs/a.md: left out, over the cap', 'docs/b.md: unreadable'];
  assert.deepEqual(verify(result([req()], { not_reviewed: nr }), { read, max: 80 }).not_reviewed, ['docs/b.md: unreadable']);
  assert.deepEqual(verify(result([req(), req({ id: 'R2', text: 'again' })], { not_reviewed: nr }), { read, max: 2 }).not_reviewed, nr);
  const md = render({ data: { ...result([req()], { requirements_found: 5 }) }, cap: 80 });
  assert.match(md, /listed 1 of 5 found; the model chose which rows to list, the cap of 80 was not reached/);
  assert.match(render({ data: { ...result([req()], { requirements_found: 5 }) }, cap: 1 }), /the rest are over the cap of 1/);
});

test('changed since last audit: new, removed and status-changed rows from the hidden state; round trip and tamper check', () => {
  const rows = verify(result([req(), req({ source: cite('docs/design.md', 4), status: 'missing_test', tests: [], text: 'A plan must start in the future.' })]), { read }).requirements;
  const [a, b] = rows;
  const prior = { head: 'abcdef123456', rows: [{ id: a.id, status: 'partial' }, { id: 'deadbeef', status: 'missing_test' }] };
  const md = render({ data: { ...result(), requirements: rows }, prior });
  assert.match(md, /### Changed since last audit \(`abcdef1`\)\n\n- New \(1\):\n  - `[0-9a-f]{8}` A plan must start in the future\. \(missing_test\)\n- Status changed \(1\):\n  - `[0-9a-f]{8}` A repeating plan[^\n]*: partial → covered\n- Removed or not listed this time \(1\):\n  - `deadbeef` \(was missing_test\)\n/);
  assert.ok(md.indexOf('### Changed since') < md.indexOf('Covered in full'));
  assert.match(render({ data: { ...result(), requirements: rows }, prior: { head: '', rows: rows.map((r) => ({ id: r.id, status: r.status })) } }), /No changes in the listed requirements\./);
  const state = audit.stateComment('abc123', rows);
  assert.deepEqual(audit.readState(`${MARK}\nbody\n${state}`), { head: 'abc123', rows: rows.map((r) => ({ id: r.id, status: r.status })) });
  assert.equal(audit.readState('<!-- specguard:audit-state {"v":1,"rows":[["<script>","covered"]]} -->'), null);
  assert.equal(audit.readState('<!-- specguard:audit-state {nope} -->'), null);
  assert.equal(audit.readState('no state'), null);
  assert.ok(!state.includes(b.text) && !state.includes('plan'), 'ids and statuses only');
});

test('run: a previous issue state drives the changed-since section in summary and issue; the issue ends with the new state', async (t) => {
  const first = await runPost(t, { ctxFiles: { 'findings.json': result() }, env: { AUDIT_ISSUE: 'true' } });
  const old = first.calls.created[0].body;
  assert.doesNotMatch(old, /Changed since last audit/);
  assert.match(old, /<!-- specguard:audit-state \{"v":1,"head":"abc123","rows":\[\["[0-9a-f]{8}","covered"\]\]\} -->$/);
  const rs = [req({ status: 'missing_test', tests: [] }), req({ id: 'R2', source: cite('docs/design.md', 4), text: 'A plan must start in the future.', status: 'missing_test', tests: [] })];
  const r = await runPost(t, { ctxFiles: { 'findings.json': result(rs) }, env: { AUDIT_ISSUE: 'true' }, mock: { issues: [{ number: 9, body: old, user: BOT }] } });
  for (const md of [r.calls.summary, r.calls.updated[0].body]) {
    assert.match(md, /### Changed since last audit \(`abc123`\)/);
    assert.match(md, /- New \(1\):/);
    assert.match(md, /: covered → missing_test/);
  }
  assert.match(r.calls.updated[0].body, /"rows":\[\["[0-9a-f]{8}","missing_test"\],\["[0-9a-f]{8}","missing_test"\]\]/);
});

test('run (A5): an engine that did not succeed gives a Partial audit banner, keeps verified rows, writes no issue', async (t) => {
  const r = await runPost(t, { ctxFiles: { 'findings.json': result(), 'engine-status': 'timeout\n' }, env: { AUDIT_ISSUE: 'true' }, mock: { issues: [{ number: 9, body: `${MARK}\nold`, user: BOT }] } });
  assert.match(r.calls.summary, /> \*\*Partial audit: engine timeout\.\*\*/);
  assert.match(r.calls.summary.slice(0, r.calls.summary.indexOf('**1 requirement**')), /Partial audit/, 'the banner comes first');
  assert.match(r.calls.summary, /\*\*1 requirement\*\*/);
  assert.deepEqual([r.calls.created, r.calls.updated], [[], []]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(r.w.ctx, 'audit.json'), 'utf8')).partial, 'engine timeout');
  const ok = await runPost(t, { ctxFiles: { 'findings.json': result(), 'engine-status': 'success\n' } });
  assert.doesNotMatch(ok.calls.summary, /Partial audit/);
  const rf = await runPost(t, { ctxFiles: { 'findings.json': result(), 'engine-repair': 'repair_failed\n' } });
  assert.match(rf.calls.summary, /Partial audit: engine JSON repair failed/);
});

test('run (A19): a closed issue is reopened, an unchanged body is not rewritten, an open one is preferred', async (t) => {
  const first = await runPost(t, { ctxFiles: { 'findings.json': result() }, env: { AUDIT_ISSUE: 'true' } });
  const body = first.calls.created[0].body;
  const closed = { number: 4, state: 'closed', body: `${MARK}\nold`, user: BOT };
  const r = await runPost(t, { ctxFiles: { 'findings.json': result() }, env: { AUDIT_ISSUE: 'true' }, mock: { issues: [closed] } });
  assert.deepEqual([r.calls.updated.length, r.calls.updated[0].issue_number, r.calls.updated[0].state, r.calls.created.length], [1, 4, 'open', 0]);
  const next = await runPost(t, { ctxFiles: { 'findings.json': result() }, env: { AUDIT_ISSUE: 'true' }, mock: { issues: [{ number: 5, body, user: BOT }] } });
  assert.match(next.calls.updated[0].body, /No changes in the listed requirements\./);
  const same = await runPost(t, { ctxFiles: { 'findings.json': result() }, env: { AUDIT_ISSUE: 'true' }, mock: { issues: [{ number: 5, body: next.calls.updated[0].body.replace(/\n/g, '\r\n') + '\n', user: BOT }] } });
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
  assert.match(body, /No requirement documents were found, so nothing was audited\./);
  assert.doesNotMatch(body, /Covered in full/);
  assert.match(body, /<!-- specguard:audit-state /, 'the previous state is kept for the next audit');
  const none = await runPost(t, { env: { SKIP: 'true', AUDIT_ISSUE: 'true' } });
  assert.deepEqual([none.calls.created, none.calls.updated], [[], []]);
  assert.match(none.calls.summary, /No requirement documents were found/);
});

test('run (A18): the size caps are bytes, and a failing summary write or lookup never throws', async (t) => {
  const rs = Array.from({ length: 80 }, (_, i) => req({ id: `R${i + 1}`, text: `需求${i + 1} ${'要'.repeat(95)}`, note: '注'.repeat(98) }));
  const r = await runPost(t, { ctxFiles: { 'findings.json': result(rs) }, env: { AUDIT_ISSUE: 'true' } });
  assert.ok(Buffer.byteLength(r.calls.created[0].body) <= 65536, String(Buffer.byteLength(r.calls.created[0].body)));
  assert.ok(Buffer.byteLength(r.calls.summary) <= 1048576);
  const w = workspace(t);
  w.put('audit-meta.json', { head: 'abc123', max_requirements: 80, docs: 1, limitations: [] });
  w.put('findings.json', result());
  const m = mocks();
  m.core.summary = { addRaw() { return this; }, async write() { throw new Error('summary too large'); } };
  const saved = process.env.CTX; process.env.CTX = w.ctx;
  try { await audit({ github: m.github, context: m.context, core: m.core }); } finally { process.env.CTX = saved; }
  assert.match(m.calls.warnings.join('\n'), /could not write the job summary: summary too large/);
  const boom = mocks();
  boom.context = null; // anything unexpected is a warning, not a red job
  await audit({ github: boom.github, context: boom.context, core: boom.core });
  assert.match(boom.calls.warnings.join('\n'), /audit report failed/);
});
