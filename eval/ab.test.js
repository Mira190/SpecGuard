const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ab = require('./ab.js');
const { prepareOne } = require('./local.js');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'specguard-ab-test-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const quiet = () => {};
const put = (p, s) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); };

// fake worktrees: A has src/prompt.js (assemble), B only eval/local.js (buildPrompt)
const wtA = path.join(tmp, 'wtA'), wtB = path.join(tmp, 'wtB');
put(path.join(wtA, 'src', 'prompt.js'), `exports.assemble = ({ skillDir, ctxDir, schemaPath, engine }) => 'A|' + engine + '|' + skillDir.replace(/\\\\/g, '/').split('/').slice(-2).join('/') + '|' + require('node:path').basename(schemaPath) + '|ctx=' + ctxDir + '|' + 'x'.repeat(50);`);
put(path.join(wtB, 'eval', 'local.js'), `exports.buildPrompt = (ctx) => 'B|ctx=' + ctx;`);

// a fake prepared source dir (shared repo is NOT copied)
const src = path.join(tmp, 'src');
for (const id of ['one', 'two']) {
  put(path.join(src, id, 'ctx', 'diff.patch'), 'diff ' + id);
  put(path.join(src, id, 'ctx', 'findings.json'), '{"old":true}');
  put(path.join(src, id, 'ctx', 'engine-status.txt'), 'ok');
  put(path.join(src, id, 'meta.json'), JSON.stringify({ id, repo: path.join(src, id, 'repo'), ctx: path.join(src, id, 'ctx'), head: 'h', base: 'b' }));
}

test('parseVariants: name=dir, errors', () => {
  assert.deepStrictEqual(ab.parseVariants(['v2=/x/y']).map((v) => v.name), ['v2']);
  assert.throws(() => ab.parseVariants(['nodir']), /name=dir/);
  assert.throws(() => ab.parseVariants([]), /at least one/);
  assert.throws(() => ab.parseVariants(['a=/x', 'a=/y']), /duplicate/);
});

test('promptBuilder: prefers src/prompt.js (copilot wording), falls back to eval/local.js, errors otherwise', () => {
  assert.match(ab.promptBuilder(wtA)('/c'), /^A\|copilot\|skills\/test-review\|findings\.schema\.json\|ctx=\/c/);
  assert.strictEqual(ab.promptBuilder(wtB)('/c'), 'B|ctx=/c');
  assert.throws(() => ab.promptBuilder(tmp), /neither/);
});

test('taskText: names prompt, ctx, repo, read rule, 30-turn cap, deliverable and the anatomy marker', () => {
  const t = ab.taskText({ promptPath: 'C:\\p\\prompt.md', ctxDir: 'C:\\p\\ctx', repo: 'C:\\r', findingsPath: 'C:\\p\\ctx\\findings.json' });
  for (const s of ['C:\\p\\prompt.md', 'C:\\p\\ctx', 'C:\\r', 'ONLY', '30 turns', 'Write', 'C:\\p\\ctx\\findings.json', 'review model inside a CI code-review Action']) assert.ok(t.includes(s), s);
});

const abDir = path.join(tmp, 'ab');
test('setup: per variant ctx copy without findings/engine-status, rewritten meta, prompt on variant ctx, task, manifest', () => {
  const m = ab.setup({ src, ids: ['one', 'two'], ab: abDir, variants: ab.parseVariants([`A=${wtA}`, `B=${wtB}`]), log: quiet });
  assert.strictEqual(m.length, 4);
  assert.deepStrictEqual(ab.loadManifest(abDir), m);
  for (const e of m) {
    const d = path.join(abDir, e.variant, e.id), ctx = path.join(d, 'ctx'), meta = JSON.parse(fs.readFileSync(path.join(d, 'meta.json'), 'utf8'));
    assert.deepStrictEqual(fs.readdirSync(ctx), ['diff.patch']);
    assert.strictEqual(meta.ctx, ctx);
    assert.strictEqual(meta.repo, path.join(src, e.id, 'repo'));
    const prompt = fs.readFileSync(path.join(d, 'prompt.md'), 'utf8');
    assert.ok(prompt.includes(`ctx=${ctx}`) && !prompt.includes(path.join(src, e.id, 'ctx')));
    assert.strictEqual(e.promptBytes, Buffer.byteLength(prompt));
    const task = fs.readFileSync(e.taskPath, 'utf8');
    assert.ok(task.includes(path.join(d, 'prompt.md')) && task.includes(meta.repo) && task.includes(path.join(ctx, 'findings.json')));
  }
  assert.ok(fs.existsSync(path.join(src, 'one', 'ctx', 'findings.json')), 'source untouched');
});

test('setup: rejects a prompt that points at a foreign ctx, and a missing source id', () => {
  const bad = path.join(tmp, 'wtBad');
  put(path.join(bad, 'eval', 'local.js'), `exports.buildPrompt = (ctx) => 'ctx=' + ctx + ' also ${path.join(src, 'one', 'ctx').replace(/\\/g, '\\\\')}';`);
  assert.throws(() => ab.setup({ src, ids: ['one'], ab: path.join(tmp, 'ab2'), variants: ab.parseVariants([`bad=${bad}`]), log: quiet }), /foreign ctx/);
  assert.throws(() => ab.setup({ src, ids: ['nope'], ab: path.join(tmp, 'ab3'), variants: ab.parseVariants([`B=${wtB}`]), log: quiet }), /no .*meta\.json/);
  assert.throws(() => ab.setup({ src, ids: [], ab: abDir, variants: [] }), /required/);
});

test('totals and report: aggregate per variant, engine failures counted', () => {
  const rs = [
    { variant: 'A', id: 'x', kind: 'seeded', pass: true, tp: 1, fp: 0, fn: 0, text: 0, summary: 0, must_not: 0, inline: 1, summary_only: 2 },
    { variant: 'B', id: 'x', kind: 'seeded', pass: false, tp: 0, fp: 1, fn: 1, text: 0, summary: 0, must_not: 0, inline: 1, summary_only: 0 },
    { variant: 'A', id: 'y', kind: 'real', inline: 3, high: 2, low: 1, summary_only: 1, pre_existing: 0 },
    { variant: 'B', id: 'y', engine_failed: true },
  ];
  const t = ab.totals(rs, ['A', 'B']);
  assert.deepStrictEqual([t[0].pass, t[0].inline, t[0].summary_only, t[1].fp, t[1].engine_failed], [1, 4, 3, 1, 1]);
  const r = ab.report(rs, ['A', 'B']);
  assert.match(r.text, /PASS tp1/);
  assert.match(r.text, /engine failed/);
  assert.match(r.text, /in3 \(hi2\/lo1\)/);
});

const findings = (id) => ({
  requirements_source: 'PR body', not_reviewed: '',
  standards: { status: 'no_rules', sources: [], reason: 'none' }, layering: { status: 'checked', reason: 'none' },
  requirements: [], coverage: [], findings: [],
});

test('finishRun and finish: engine failed without findings; real post.run + grading on seeded and counts on real ids', async () => {
  const prep = path.join(tmp, 'prep');
  const meta = prepareOne('tr3', prep, 'auto');
  assert.ok(meta.collect_ok);
  fs.cpSync(path.join(prep, 'tr3'), path.join(prep, 'real-1'), { recursive: true, filter: (p) => !/[\\/]repo([\\/]|$)/.test(p) });
  const rm = JSON.parse(fs.readFileSync(path.join(prep, 'real-1', 'meta.json'), 'utf8'));
  fs.writeFileSync(path.join(prep, 'real-1', 'meta.json'), JSON.stringify({ ...rm, id: 'real-1' })); // repo still points at tr3's repo
  const dir2 = path.join(tmp, 'ab-finish');
  ab.setup({ src: prep, ids: ['tr3', 'real-1'], ab: dir2, variants: ab.parseVariants([`B=${wtB}`, `C=${wtB}`]), log: quiet });
  fs.writeFileSync(path.join(dir2, 'B', 'tr3', 'ctx', 'findings.json'), JSON.stringify(findings('tr3')));
  fs.writeFileSync(path.join(dir2, 'B', 'real-1', 'ctx', 'findings.json'), JSON.stringify(findings('real-1')));
  const lines = [];
  const { results, totals } = await ab.finish({ ab: dir2, log: (s) => lines.push(s) });
  const get = (v, id) => results.find((r) => r.variant === v && r.id === id);
  assert.strictEqual(get('C', 'tr3').engine_failed, true);
  assert.strictEqual(get('B', 'tr3').kind, 'seeded');
  assert.strictEqual(get('B', 'tr3').pass, false); // empty findings miss the seeded mismatch
  assert.strictEqual(get('B', 'tr3').fn, 1);
  assert.strictEqual(get('B', 'real-1').kind, 'real');
  assert.strictEqual(get('B', 'real-1').inline, 0);
  assert.strictEqual(totals.find((t) => t.variant === 'C').engine_failed, 2);
  assert.ok(fs.existsSync(path.join(dir2, 'results.json')));
  assert.match(lines.join('\n'), /engine failed/);
  const one = await ab.finishRun({ variant: 'C', id: 'tr3' }, dir2, path.join(__dirname, '..'));
  assert.deepStrictEqual(one, { variant: 'C', id: 'tr3', engine_failed: true });
});

test('loadAnatomy: exposes parse and files without running the report', () => {
  const a = ab.loadAnatomy();
  assert.strictEqual(typeof a.parse, 'function');
  assert.strictEqual(typeof a.files, 'function');
});

// minimal sub-agent transcript: kickoff message naming <dir>\prompt.md, then assistant turns with growing usage
function transcript(file, dir, usages, agentId) {
  const lines = [{ type: 'user', agentId, message: { content: `You are acting as the review model inside a CI code-review Action. Read ${path.join(dir, 'prompt.md')} now.` } }];
  usages.forEach(([input, out], i) => lines.push({ type: 'assistant', agentId, uuid: `u${i}`, message: { id: `m${i}`, usage: { input_tokens: input, output_tokens: out }, content: [{ type: 'text', text: 'ok' }] } }));
  put(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return file;
}

test('tokens: matches transcripts by variant dir, per-variant stats and paired deltas', async () => {
  const dir3 = path.join(tmp, 'ab-tok'), t = path.join(tmp, 'tr');
  ab.setup({ src, ids: ['one', 'two'], ab: dir3, variants: ab.parseVariants([`A=${wtA}`, `B=${wtB}`]), log: quiet });
  const P = (v, id) => path.join(dir3, v, id);
  const files = [
    transcript(path.join(t, 'a1.jsonl'), P('A', 'one'), [[100, 5], [300, 5], [320, 7]], 'a1'),
    transcript(path.join(t, 'a2.jsonl'), P('A', 'two'), [[100, 5], [300, 5], [320, 7]], 'a2'),
    transcript(path.join(t, 'b1.jsonl'), P('B', 'one'), [[100, 5], [200, 5]], 'b1'),
    transcript(path.join(t, 'noise.jsonl'), path.join(tmp, 'elsewhere'), [[1, 1], [2, 2]], 'n'),
  ];
  const lines = [];
  const r = await ab.tokens({ ab: dir3, transcripts: files, log: (s) => lines.push(s) });
  assert.deepStrictEqual(r.per.map((p) => [p.variant, p.runs]), [['A', 2], ['B', 1]]);
  assert.strictEqual(r.per[0].turns_median, 3);
  assert.strictEqual(r.per[0].cum_mean, 720);
  assert.strictEqual(r.per[0].outTok_mean, 17);
  assert.strictEqual(r.paired[0].n, 1);
  assert.deepStrictEqual(r.paired[0].metrics.cum.deltas, [300 - 720]);
  assert.deepStrictEqual(r.paired[0].metrics.turns.deltas, [-1]);
  assert.deepStrictEqual(r.missing, ['B/two']);
  assert.match(lines.join('\n'), /Constant across variants/);
  assert.ok(fs.existsSync(path.join(dir3, 'tokens.json')));
});

test('tokens: matches a task.md kickoff with a literal Windows backslash path', async () => {
  const dir4 = path.join(tmp, 'ab-task');
  ab.setup({ src, ids: ['one'], ab: dir4, variants: ab.parseVariants([`A=${wtA}`]), log: quiet });
  const win = path.join(dir4, 'A', 'one').split(path.sep).join('\\') + '\\task.md';
  const f = path.join(tmp, 'tr', 'task.jsonl');
  const asst = (i, input, tools) => ({ type: 'assistant', agentId: 'w', uuid: 'w' + i, message: { id: 'w' + i, usage: { input_tokens: input, output_tokens: 3 }, content: tools.map((id) => ({ type: 'tool_use', id, name: 'Read', input: {} })) } });
  put(f, [{ type: 'user', agentId: 'w', message: { content: 'You are acting as the review model inside a CI code-review Action, run locally and offline. Read the task file `' + win + '` and follow it exactly.' } },
    asst(0, 100, ['a', 'b']), asst(1, 150, ['c'])].map((l) => JSON.stringify(l)).join('\n') + '\n');
  const r = await ab.tokens({ ab: dir4, transcripts: [f], log: quiet });
  assert.strictEqual(r.per[0].runs, 1);
  assert.strictEqual(r.per[0].calls_mean, 3);
  assert.strictEqual(r.per[0].parPerTurn_mean, 1.5);
  assert.strictEqual(r.per[0].cumFirst_mean, 200);
  assert.strictEqual(r.per[0].cumLater_mean, 50);
});

// ---- --prompt-file (free-form competitor stand-ins) ----
const COMP = process.env.AB_COMP_DIR || ''; // competitor stand-in prompts live outside the repo; the test skips without AB_COMP_DIR
const stand = path.join(tmp, 'stand.txt');
put(stand, '<!-- PROVENANCE: inferred -->\nReview the PR.\nWrite {"comments":[]}.\n');

test('parseVariants: --prompt-file name=file mixes with --variant, errors on bad form', () => {
  const v = ab.parseVariants([`A=${wtA}`], [`cp=${stand}`]);
  assert.deepStrictEqual(v.map((x) => [x.name, !!x.dir, !!x.promptFile]), [['A', true, false], ['cp', false, true]]);
  assert.throws(() => ab.parseVariants([], ['nofile']), /name=file/);
  assert.throws(() => ab.parseVariants([`cp=${stand}`], [`cp=${stand}`]), /duplicate/);
});

test('prompt-file variant: provenance stripped, inlined blocks + parallel-batch line + review.json tail; task asks for review.json without schema', () => {
  put(path.join(src, 'one', 'ctx', 'files.txt'), 'a.js\n');
  const dir5 = path.join(tmp, 'ab-free');
  const m = ab.setup({ src, ids: ['one'], ab: dir5, variants: ab.parseVariants([], [`cp=${stand}`]), log: quiet });
  assert.strictEqual(m[0].free, true);
  const d = path.join(dir5, 'cp', 'one'), prompt = fs.readFileSync(path.join(d, 'prompt.md'), 'utf8'), ctx = path.join(d, 'ctx').split(path.sep).join('/');
  assert.ok(prompt.startsWith('Review the PR.') && !prompt.includes('PROVENANCE'));
  assert.ok(prompt.includes('<untrusted-data name="files.txt">') && prompt.includes('<untrusted-data name="diff.patch">') && prompt.includes('ONE parallel batch') && prompt.includes(`${ctx}/review.json`));
  const task = fs.readFileSync(m[0].taskPath, 'utf8');
  assert.ok(task.includes('review.json') && !task.includes('schema') && !task.includes('findings.json'));
});

test('finish on a free variant: counts by severity, writes bundle-readable files; bundle.js parses all as inline review_comment', async () => {
  const dir6 = path.join(tmp, 'ab-free2');
  ab.setup({ src, ids: ['one', 'two'], ab: dir6, variants: ab.parseVariants([], [`cp=${stand}`]), log: quiet });
  fs.writeFileSync(path.join(dir6, 'cp', 'one', 'ctx', 'review.json'), JSON.stringify({ summary: 'S', comments: [
    { path: 'a.js', line: 3, severity: 'High', title: 'T1', body: 'B1', suggestion: 'x = 1;' }, { path: 'b.js', start_line: 7, severity: 'low', body: 'B2' }] }));
  const { results } = await ab.finish({ ab: dir6, log: quiet });
  const r = results.find((x) => x.id === 'one'), e = results.find((x) => x.id === 'two');
  assert.deepStrictEqual([r.kind, r.inline, r.high, r.medium, r.low], ['free', 2, 1, 0, 1]);
  assert.strictEqual(e.engine_failed, true);
  const bundle = require('./bundle.js'), posted = JSON.parse(fs.readFileSync(path.join(dir6, 'cp', 'one', 'posted.json'), 'utf8'));
  const inl = bundle.parseInline(posted);
  assert.deepStrictEqual(inl.map((x) => [x.kind, x.confidence, x.class, x.path, x.line, x.title]), [['review_comment', 'high', 'inline', 'a.js', 3, 'T1'], ['review_comment', 'low', 'inline', 'b.js', 7, 'B2']]);
  assert.strictEqual(inl[0].suggestion, 'x = 1;');
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir6, 'cp', 'one', 'ctx', 'findings.json'), 'utf8')).findings[0].origin, 'free');
});

test('competitor prompt files never mention SpecGuard, coverage, alignment, obligation', { skip: !COMP || !fs.existsSync(path.join(COMP, 'copilot-style.txt')) }, () => {
  for (const f of ['copilot-style.txt', 'pocock-style.txt']) {
    const ctx = path.join(src, 'one', 'ctx');
    const text = ab.freePromptBuilder(path.join(COMP, f))(ctx);
    for (const w of ['SpecGuard', 'coverage', 'alignment', 'obligation', 'schema', 'PROVENANCE', 'INFERRED', 'RECONSTRUCTED']) assert.ok(!new RegExp(w, 'i').test(text.split(/\n---\n/)[0]), `${f} contains ${w}`);
  }
});
