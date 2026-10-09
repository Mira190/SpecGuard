const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveCases, buildPrompt, prepare, prepareOne, fakeGithub, finish, finishOne, table } = require('./local.js');

const out = fs.mkdtempSync(path.join(os.tmpdir(), 'specguard-local-test-'));
test.after(() => fs.rmSync(out, { recursive: true, force: true }));
const quiet = () => {};
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.name === '.git' ? [] : e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
const SPEC = 'eval-sandbox/tr3/docs/specs/claims.md';
const AC4 = 'AC-4: A claim must be filed within 45 days of the incident.';

const findings = (body) => ({
  requirements_source: 'PR body, ' + SPEC, not_reviewed: '',
  standards: { status: 'no_rules', sources: [], reason: 'No rule files in the repository.' },
  layering: { status: 'checked', reason: 'Only a unit test exists.' },
  requirements: [{ id: 'S1', source: SPEC, quote: AC4, ref: 'AC-4', obligation_ids: ['O1'], reason: 'The spec says 45 days; the code says 30.' }],
  coverage: [{
    id: 'O1', obligation: 'A claim must be filed within 45 days', source: `${SPEC} AC-4`,
    behaviour: { path: 'eval-sandbox/tr3/src/deadline.js', line: 2, quote: 'const FILING_WINDOW_DAYS = 30;' },
    change: { path: SPEC, line: 11, quote: AC4, side: 'RIGHT' }, evidence: [], status: 'needs_human', reason: 'The code still uses 30.',
    alignment: { status: 'mismatch', since: 'introduced', reason: 'FILING_WINDOW_DAYS is 30.' },
  }],
  findings: [{
    kind: 'spec_mismatch', path: SPEC, line: 11, quote: AC4, side: 'RIGHT', title: 'Spec says 45 days, code says 30', body, confidence: 'high', obligation_ids: ['O1'],
  }],
});
const writeFindings = (id, o) => { fs.mkdirSync(path.join(out, id, 'ctx'), { recursive: true }); fs.writeFileSync(path.join(out, id, 'ctx', 'findings.json'), JSON.stringify(o)); };

test('resolveCases: lists, all, unknown ids', () => {
  assert.deepStrictEqual(resolveCases('tr3, r1'), ['tr3', 'r1']);
  assert.ok(resolveCases('all').includes('tr9'));
  assert.throws(() => resolveCases('nope'), /no such case/);
  assert.throws(() => resolveCases(''), /--case/);
});

test('buildPrompt: skill body, references except ccr, context lines, schema', () => {
  const p = buildPrompt('/x/ctx');
  assert.ok(!p.startsWith('---') && !p.includes('description: Review a PR'), 'front matter stripped');
  assert.ok(p.includes('# references/trace.md') && p.includes('# references/output.md'));
  assert.ok(!p.includes('# references/ccr.md'));
  assert.ok(p.includes('Context directory (absolute path): /x/ctx'));
  assert.ok(p.includes('Your final answer must be JSON only, matching this schema: {'));
  assert.ok(p.includes('"validation_notes"') === false && p.includes('"coverage"'));
});

test('prepare: builds repos, runs collect, writes prompt and meta', () => {
  const lines = [];
  const metas = prepare({ cases: 'tr3,tr9,tr7,r1', out, log: (l) => lines.push(l) });
  assert.strictEqual(lines.length, 4);
  const by = Object.fromEntries(metas.map((m) => [m.id, m]));

  const repo = path.join(out, 'tr3', 'repo'), files = walk(repo).map((f) => path.relative(repo, f).replace(/\\/g, '/'));
  assert.ok(files.includes('eval-sandbox/tr3/src/deadline.js'));
  assert.ok(files.every((f) => f.startsWith('eval-sandbox/')), 'only sandbox files, no eval data or SpecGuard source');
  assert.ok(!files.some((f) => /expected|case\.json/.test(f)));
  assert.ok(!files.some((f) => fs.readFileSync(path.join(repo, f), 'utf8').includes('"expected"')));
  assert.strictEqual(by.tr3.skip, false);
  assert.ok(by.tr3.base && by.tr3.head && by.tr3.base !== by.tr3.head);
  for (const f of ['spec-files.txt', 'trace-candidates.json', 'files.txt', 'diff.patch']) assert.ok(fs.existsSync(path.join(out, 'tr3', 'ctx', f)), f);
  assert.ok(fs.readFileSync(path.join(out, 'tr3', 'ctx', 'diff.patch'), 'utf8').includes('+AC-4: A claim must be filed within 45 days'));
  assert.ok(by.tr3.spec_files >= 1 && by.tr3.spec_items >= 1);

  assert.strictEqual(by.tr9.skip, true);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(out, 'tr9', 'meta.json'), 'utf8')).skip, true);
  assert.strictEqual(by.r1.skip, false);
  assert.ok(by.r1.files > 0 && by.tr7.collect_ok);

  const prompt = fs.readFileSync(path.join(out, 'tr3', 'prompt.md'), 'utf8');
  assert.ok(prompt.includes('"coverage"') && prompt.includes(fs.readFileSync(path.join(__dirname, '..', 'skills', 'test-review', 'references', 'trace.md'), 'utf8').slice(0, 200)));
  assert.ok(prompt.includes(path.join(out, 'tr3', 'ctx')));
});

test('prepareOne: trace off skips spec classification', () => {
  const m = prepareOne('tr3', path.join(out, 'off'), 'off');
  assert.strictEqual(m.skip, true); // the only change is a spec doc, which is reviewable only with tracing
  assert.strictEqual(m.trace, 'off');
});

test('fakeGithub: records the review, file comment and summary', async () => {
  const { github, core, posted } = fakeGithub({ headSha: 'abc' });
  assert.strictEqual((await github.rest.pulls.get({})).data.head.sha, 'abc');
  assert.deepStrictEqual(await github.paginate(github.rest.pulls.listFiles, {}), []);
  await github.rest.pulls.createReview({ body: 'b', comments: [{ path: 'p', line: 1, side: 'RIGHT', body: 'x' }] });
  await github.rest.pulls.createReviewComment({ path: 'q', subject_type: 'file', body: 'y' });
  await github.rest.issues.createComment({ body: 'sum' });
  core.warning('w');
  await core.summary.addRaw('t').write();
  assert.strictEqual(posted.comments.length, 2);
  assert.strictEqual(posted.comments[0].user.type, 'Bot');
  assert.deepStrictEqual(posted.reviews, [{ state: 'COMMENTED', body: 'b' }]);
  assert.strictEqual(posted.summary, 'sum');
  assert.deepStrictEqual(posted.warnings, ['w']);
});

test('finish: a correct spec_mismatch passes tr3', async () => {
  writeFindings('tr3', findings('The spec now requires 45 days but deadline.js:2 still uses a 30-day window.'));
  const r = await finishOne('tr3', out);
  assert.strictEqual(r.tp, 1, JSON.stringify(r.missed));
  assert.strictEqual(r.pass, true, JSON.stringify(r));
  assert.ok(fs.readFileSync(path.join(out, 'tr3', 'summary.md'), 'utf8').includes('SpecGuard'));
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(out, 'tr3', 'posted.json'), 'utf8')).comments.length, 1);
});

test('finish: a finding without the required citation fails tr3', async () => {
  writeFindings('tr3', findings('The window changed.'));
  const r = await finishOne('tr3', out);
  assert.strictEqual(r.pass, false);
  assert.strictEqual(r.text_misses.length, 1);
});

test('finish: missing findings.json is an engine failure; skip case passes with none', async () => {
  fs.rmSync(path.join(out, 'tr7', 'ctx', 'findings.json'), { force: true });
  const r = await finishOne('tr7', out);
  assert.strictEqual(r.engine_failed, true);
  assert.strictEqual(r.pass, false);
  assert.strictEqual(r.complete, false);
  const skipped = await finishOne('tr9', out);
  assert.strictEqual(skipped.engine_failed, true); // no model ran, but a skip case is graded on the "Nothing to review" summary
  assert.strictEqual(skipped.skip_ok, true);
});

test('finish: prints a table and aggregate, writes results.json with --json', async () => {
  writeFindings('tr3', findings('Spec says 45, deadline.js:2 says 30.'));
  const lines = [];
  const { results, agg } = await finish({ cases: 'tr3,tr7', out, json: true, log: (l) => lines.push(l) });
  assert.strictEqual(results.length, 2);
  assert.strictEqual(agg.runs, 2);
  const text = lines.join('\n');
  assert.match(text, /tr3\s+PASS/);
  assert.match(text, /tr7\s+FAIL.*engine failed/);
  assert.match(text, /1\/2 pass/);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(out, 'results.json'), 'utf8')).results.length, 2);
});

test('table: error rows and result rows', () => {
  const t = table([{ id: 'a', error: 'boom' }]);
  assert.match(t, /a\s+ERROR.*boom/);
  assert.match(t.split('\n')[0], /^case\s+result\s+TP/);
});
