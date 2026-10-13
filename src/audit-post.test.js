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
  assert.deepEqual(v.requirements.map((r) => r.id), ['R1']);
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
  assert.deepEqual(v.requirements.map((r) => r.id), ['R1', 'R2']);
  assert.match(v.not_reviewed.join('\n'), /1 further requirement\(s\) beyond audit_max_requirements \(2\)/);
});

const sample = () => {
  const rs = [req(), req({ id: 'AC-4', text: 'A plan must start in the future.', source: cite('docs/design.md', 4), class: 'unit', status: 'missing_test', tests: [], note: 'No test rejects a past start.' }),
    req({ id: 'R3', status: 'needs_human', class: 'human', code: [], tests: [], text: 'The plan list looks calm.' })];
  return verify(result(rs, { requirements_found: 5, not_reviewed: ['docs/old.md: unreadable'] }), { read });
};

test('render: header counts by status and class, no percentage, the disclaimer, a table per document', () => {
  const md = render({ data: sample(), docs: [['docs/design.md', 'discovered']], blob: 'https://github.com/o/r/blob/abc', usage: '<sub>Engine: copilot</sub>' });
  const head = md.slice(0, md.indexOf('### '));
  assert.match(head, /^## SpecGuard requirements audit\n\n\*\*3 requirements\*\* from 1 document \(listed 3 of 5 found/);
  assert.match(head, /By status: missing_test 1 · needs_human 1 · covered 1\n/);
  assert.match(head, /By class: unit 2 · human 1\n/);
  assert.match(head, /Static review; not coverage; not for scoring people\./);
  assert.doesNotMatch(md, /\d\s*%|percent/i);
  assert.match(md, /### `docs\/design\.md`\n\n\| Requirement \| Status \| Class \| Evidence \|\n\|---\|---\|---\|---\|\n/);
  assert.match(md, /\| \[AC-4\]\(https:\/\/github\.com\/o\/r\/blob\/abc\/docs\/design\.md#L4\) A plan must start in the future\.<br><sub>No test rejects a past start\.<\/sub> \| missing_test \| unit \| code: \[src\/plan\.js:2\]\(https:\/\/github\.com\/o\/r\/blob\/abc\/src\/plan\.js#L2\) \|/);
  assert.match(md, /tests: unit \[tests\/plan\.test\.js:2\]/);
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
  assert.ok(small.length <= 9000 && small.length < full.length);
  const tableRows = small.split('\n').filter((l) => /^\| R\d+ /.test(l));
  assert.ok(tableRows.length > 0 && tableRows.length < 60);
  for (const l of tableRows) assert.match(l, /\| covered \| unit \| code: .* \|$/, 'every kept row is complete');
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
  const bad = req({ id: 'R2', source: { path: 'docs/design.md', line: 3, quote: 'not in the doc' } });
  const r = await runPost(t, { ctxFiles: { 'findings.json': result([req(), bad]), 'usage.json': { totalNanoAiu: 2e9 } }, env: { ENGINE: 'copilot', MODEL: 'auto' } });
  assert.match(r.calls.summary, /\*\*1 requirement\*\* from 1 document/);
  assert.match(r.calls.summary, /R2 \(docs\/design\.md:3\): the requirement quote was not found/);
  assert.match(r.calls.summary, /<sub>Engine: copilot · Model: auto · Cost ≈ \$0\.02/);
  assert.match(r.calls.summary, /\]\(https:\/\/github\.com\/o\/r\/blob\/abc123\/src\/plan\.js#L2\)/);
  const saved = JSON.parse(fs.readFileSync(path.join(r.w.ctx, 'audit.json'), 'utf8'));
  assert.equal(saved.head, 'abc123');
  assert.deepEqual(saved.requirements.map((x) => x.id), ['R1']);
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
  assert.ok(body.length <= 65536, String(body.length));
  assert.match(body, /_\d+ rows omitted: the report exceeded the size limit/);
  for (const l of body.split('\n').filter((x) => x.startsWith('| [R'))) assert.match(l, /\| covered \| unit \| code: .* \|$/);
  assert.ok(r.calls.summary.length > body.length, 'the job summary keeps every row');
  assert.doesNotMatch(r.calls.summary, /rows omitted/);
});
