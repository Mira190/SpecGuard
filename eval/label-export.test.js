const test = require('node:test');
const assert = require('node:assert/strict');
const { findingId, exportRows, toCsv, parseCsv, readLabels, labelPrecision, alpha, alphaInterval, agreement, COLUMNS } = require('./label-export');

const F = (tool, pr, line, text) => ({ tool, repo: 'o/r', pr, arm: 2, path: 'src/a.js', line, ref: `${tool}${pr}${line}`, text });
const FINDINGS = [
  F('specguard', 5, 10, '**Missing test** for `foo()`, "quoted"\nsecond line <!-- specguard:fp=abc --> SpecGuard says so'),
  F('specguard', 8, 20, '=SUM(A1) looks like a formula'),
  F('copilot', 5, 12, 'Copilot suggests a null check'), F('copilot', 8, 99, 'Style nit'), F('copilot', 9, 1, 'Another'),
];

test('findingId is deterministic and depends on the tool', () => {
  assert.equal(findingId(FINDINGS[0]), findingId({ ...FINDINGS[0] }));
  assert.notEqual(findingId(FINDINGS[0]), findingId({ ...FINDINGS[0], tool: 'copilot' }));
});

test('export: tool hidden, shuffled by seed (stable per seed), sample is per tool', () => {
  const a = exportRows(FINDINGS, { sample: 2, seed: 3 }), b = exportRows(FINDINGS, { sample: 2, seed: 3 }), c = exportRows(FINDINGS, { sample: 2, seed: 4 });
  assert.deepEqual(a, b);
  assert.equal(a.length, 4); // 2 specguard + 2 of 3 copilot
  assert.ok(!JSON.stringify(a).match(/specguard|copilot/i), 'no tool name leaks');
  assert.notDeepEqual(a.map((r) => r.id), c.map((r) => r.id)); // another seed, another order or draw
  assert.deepEqual(Object.keys(a[0]), COLUMNS);
  assert.deepEqual(COLUMNS.slice(-2), ['guess_tool_a', 'guess_tool_b']);
  assert.ok(a.every((r) => r.guess_tool_a === '' && r.guess_tool_b === ''));
  assert.equal(exportRows(FINDINGS, { sample: 0, seed: 1 }).length, 5);
});

test('CSV round trip keeps quotes, commas and newlines; formula-like text is defused', () => {
  const rows = exportRows(FINDINGS, { sample: 0, seed: 1 });
  const back = parseCsv(toCsv(rows));
  assert.equal(back.length, rows.length);
  assert.deepEqual(back.map((r) => r.id), rows.map((r) => r.id));
  assert.ok(back.some((r) => r.text.includes('"quoted"')));
  assert.ok(back.every((r) => !/^[=+\-@]/.test(r.text)));
});

test('import: labels per tool, precision with Wilson interval, unsure not counted', () => {
  const rows = exportRows(FINDINGS, { sample: 0, seed: 1 });
  const want = new Map(FINDINGS.map((f) => [findingId(f), f]));
  const give = { specguard: ['valid', 'invalid'], copilot: ['valid', 'valid', 'UNSURE'] }, used = { specguard: 0, copilot: 0 };
  for (const r of rows) { const t = want.get(r.id).tool; r.label = give[t][used[t]++]; }
  const p = labelPrecision(FINDINGS, readLabels(parseCsv(toCsv(rows))));
  assert.deepEqual([p.specguard.valid, p.specguard.invalid, p.specguard.precision], [1, 1, 0.5]);
  assert.deepEqual([p.copilot.valid, p.copilot.unsure, p.copilot.n, p.copilot.precision], [2, 1, 2, 1]);
  assert.ok(p.specguard.wilson[0] < 0.5 && p.specguard.wilson[1] > 0.5);
  assert.ok(p.copilot.wilson[0] > 0.1 && p.copilot.wilson[1] <= 1);
});

test('import rejects unknown labels and duplicate ids; unlabelled rows are skipped; foreign ids are reported', () => {
  assert.throws(() => readLabels([{ id: 'F1', label: 'maybe' }]), /not one of/);
  assert.throws(() => readLabels([{ id: 'F1', label: 'valid' }, { id: 'F1', label: 'invalid' }]), /duplicate/);
  assert.equal(readLabels([{ id: 'F1', label: '' }]).size, 0);
  assert.deepEqual(labelPrecision(FINDINGS, new Map([['Fnope', 'valid']])).unmatched, ['Fnope']);
  assert.throws(() => parseCsv('a,b\n1,2'), /id and label/);
});

test('export: the labeller sheet has no delivery column and no sticky-comment link; the claim is the recorded title', () => {
  const s = { ...F('specguard', 5, 10, 'Missing test for foo'), delivery: 'summary', url: 'https://github.com/o/r/pull/5#issuecomment-1' };
  const rows = exportRows([s, F('copilot', 5, 12, 'y')], { sample: 0, seed: 1 });
  const csv = toCsv(rows);
  assert.ok(!COLUMNS.includes('delivery') && !/delivery|issuecomment/.test(csv));
  assert.ok(rows.every((r) => r.link === 'https://github.com/o/r/pull/5/files'));
  assert.ok(rows.some((r) => r.text === 'Missing test for foo'));
});

test('export: a finding with no claim text is left out and counted', () => {
  const fs_ = [{ ...F('specguard', 5, 10, 'no claim text'), no_claim: true }, F('specguard', 6, 10, 'real')];
  assert.equal(exportRows(fs_, { sample: 0, seed: 1 }).length, 1);
  assert.equal(require('./label-export').claimless(fs_), 1);
});

// Krippendorff 2011, "Computing Krippendorff's Alpha-Reliability": 4 coders x 12 units, values 1-5, missing = null; nominal alpha = 0.743.
const KRIPP = [[1, 1, null, 1], [2, 2, 3, 2], [3, 3, 3, 3], [3, 3, 3, 3], [2, 2, 2, 2], [1, 2, 3, 4], [4, 4, 4, 4], [1, 1, 2, 1], [2, 2, 2, 2], [null, 5, 5, 5], [null, null, 1, 1], [null, 3, null, null]]; // the last unit has one value and does not pair
test('alpha: Krippendorff 2011 worked example (missing data) = 0.743; units with < 2 values are ignored', () => {
  assert.equal(alpha(KRIPP).toFixed(3), '0.743');
});

test('alpha: two coders by hand (n=20, Do=4, De=2*12*8/19 -> 1-76/192 = 0.604); perfect = 1; no variation = null', () => {
  const A = Array.from({ length: 10 }, (_, i) => (i < 6 ? 'valid' : 'invalid')), B = ['valid', 'valid', 'valid', 'valid', 'valid', 'invalid', 'invalid', 'invalid', 'invalid', 'valid'];
  assert.ok(Math.abs(alpha(A.map((a, i) => [a, B[i]])) - 0.6041667) < 1e-6);
  assert.equal(alpha(A.map((a) => [a, a])), 1);
  assert.equal(alpha([['valid', 'valid'], ['valid', 'valid']]), null);
});

test('agreement: unsure and blank are missing; below 0.667 is not ok; old single-label sheets have no check', () => {
  const sheet = (pairs) => pairs.map(([a, b], i) => ({ id: `F${i}`, label_a: a, label_b: b }));
  const good = agreement(sheet([['valid', 'valid'], ['invalid', 'invalid'], ['valid', 'valid'], ['invalid', 'invalid'], ['unsure', 'valid'], ['', 'invalid']]));
  assert.deepEqual([good.alpha, good.ok, good.n], [1, true, 4]);
  const bad = agreement(sheet([['valid', 'valid'], ['valid', 'valid'], ['valid', 'valid'], ['valid', 'valid'], ['valid', 'valid'], ['valid', 'invalid'], ['invalid', 'invalid'], ['invalid', 'invalid'], ['invalid', 'invalid'], ['invalid', 'valid']]));
  assert.ok(bad.alpha < 0.667 && !bad.ok);
  assert.equal(agreement([{ id: 'F1', label: 'valid' }]), null);
  assert.throws(() => agreement(sheet([['maybe', 'valid']])), /not one of/);
});

test('CLI import: alpha < 0.667 blocks precision; alpha passed needs a reconciled label column', () => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), { spawnSync } = require('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lx-')), fx = path.join(dir, 'ds.json');
  const prs = [1, 2, 3, 4].map((number) => ({ number, created_at: '2026-09-01T00:00:00Z', user: { login: 'dev', type: 'User' }, labels: [{ name: 'review-arm:0' }] }));
  const review_comments = prs.map((p) => ({ id: p.number, pr: p.number, path: 'x.js', line: 1, body: `**Gap** <!-- specguard:fp=${String(p.number).repeat(40).slice(0, 40)} -->`, user: { login: 'github-actions[bot]', type: 'Bot' }, html_url: `u${p.number}` }));
  const ds = { repo: 'o/r', since: '2026-09-01', until: '2026-09-30', prs, baseline: [], issue_comments: [], review_comments, threads: [] };
  fs.writeFileSync(fx, JSON.stringify(ds));
  const rows = exportRows(require('./weekly-report').findingsOf(ds), { sample: 0, seed: 1 });
  const imp = (ab, label) => {
    fs.writeFileSync(path.join(dir, 'l.csv'), `id,label_a,label_b,label\n${rows.map((r, i) => `${r.id},${ab[i][0]},${ab[i][1]},${label || ''}`).join('\n')}\n`);
    return spawnSync(process.execPath, [path.join(__dirname, 'label-export.js'), '--fixture', fx, '--import', path.join(dir, 'l.csv')], { encoding: 'utf8' });
  };
  const bad = imp([['valid', 'invalid'], ['valid', 'valid'], ['invalid', 'valid'], ['invalid', 'invalid']], 'valid');
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /labels not reliable: alpha=\d\.\d+ < 0\.667, revise the labelling guide and relabel/);
  assert.equal(bad.stdout, '');
  const agree = [['valid', 'valid'], ['valid', 'valid'], ['invalid', 'invalid'], ['invalid', 'invalid']];
  assert.match(imp(agree).stderr, /reconcile/);
  const ok = imp(agree, 'valid');
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(JSON.parse(ok.stdout).specguard.n, 4);
});

// 40 doubly labelled findings per tool. The pairs list is [a, b] for one tool; tool x's labellers agree except where told.
const sheetOf = (byTool) => { const rows = [], tools = new Map(); let i = 0; for (const [tool, pairs] of Object.entries(byTool)) for (const [a, b] of pairs) { const id = `F${i++}`; rows.push({ id, label_a: a, label_b: b }); tools.set(id, tool); } return { rows, toolOf: (id) => tools.get(id) }; };
const rep = (n, p) => Array.from({ length: n }, () => p);
const AGREE = [...rep(20, ['valid', 'valid']), ...rep(20, ['invalid', 'invalid'])];

test('agreement per tool: a good SpecGuard sheet cannot hide a bad Copilot sheet; tentative is not a decision', () => {
  const bad = [...rep(8, ['valid', 'valid']), ...rep(8, ['invalid', 'invalid']), ...rep(12, ['valid', 'invalid']), ...rep(12, ['invalid', 'valid'])];
  const { rows, toolOf } = sheetOf({ specguard: AGREE, copilot: bad });
  const ag = agreement(rows, toolOf);
  assert.equal(ag.scopes.specguard.status, 'reliable');
  assert.ok(ag.scopes.copilot.alpha < 0.667 && ag.scopes.copilot.status === 'fail');
  assert.ok(ag.scopes.overall.alpha < 0.8 && ag.scopes.overall.status !== 'reliable');
  assert.equal(ag.ok, false);
  const mid = [...rep(17, ['valid', 'valid']), ...rep(17, ['invalid', 'invalid']), ...rep(3, ['valid', 'invalid']), ...rep(3, ['invalid', 'valid'])]; // alpha ~ 0.70
  const t = agreement(sheetOf({ specguard: AGREE, copilot: mid }).rows, sheetOf({ specguard: AGREE, copilot: mid }).toolOf);
  assert.ok(t.scopes.copilot.alpha > 0.667 && t.scopes.copilot.alpha < 0.8 && t.scopes.copilot.status === 'tentative');
  assert.deepEqual([t.ok, t.decision], [true, false]);
  const good = agreement(sheetOf({ specguard: AGREE, copilot: AGREE }).rows, sheetOf({ specguard: AGREE, copilot: AGREE }).toolOf);
  assert.deepEqual([good.ok, good.decision, good.scopes.overall.prevalence], [true, true, 0.5]);
});

test('agreement: a small sample has a wide bootstrap interval (lower bound < 0.667) and the interval is seeded', () => {
  const pairs = [...rep(4, ['valid', 'valid']), ...rep(4, ['invalid', 'invalid']), ['valid', 'invalid']];
  const a = alpha(pairs), ci = alphaInterval(pairs), ci2 = alphaInterval(pairs);
  assert.deepEqual(ci, ci2);
  assert.ok(ci[0] < a && a < ci[1] + 1e-9 && ci[0] < 0.667, `alpha ${a} ci ${ci}`);
});

test('agreement: an unsure rate above 20% for either labeller refuses, even with perfect agreement on the rest', () => {
  const { rows, toolOf } = sheetOf({ specguard: [...AGREE, ...rep(12, ['unsure', 'valid'])] });
  const ag = agreement(rows, toolOf);
  assert.ok(ag.unsure.a > 0.2 && ag.unsure.b === 0 && ag.scopes.overall.alpha === 1);
  assert.equal(ag.ok, false);
});

test('export normalises text: markdown, links, comments and tool-specific prefixes are gone', () => {
  const r = exportRows([F('specguard', 1, 1, '## **Gap:** See [docs](https://x.y/z) <!-- specguard:fp=1 --> and https://a.b/c now')], { sample: 0, seed: 1 });
  assert.equal(r[0].text, 'See docs and now');
  assert.equal(exportRows([F('copilot', 1, 1, '[Copilot] Suggestion: add a null check')], { sample: 0, seed: 1 })[0].text, 'add a null check');
});

test('blinding: correct-guess share, Bang index, blank = do not know', () => {
  const rows = [['specguard', 'specguard'], ['copilot', 'specguard'], ['specguard', ''], ['copilot', 'copilot']].map(([g, t], i) => ({ id: `F${i}`, guess_tool_a: g, guess_tool_b: '', _t: t }));
  const b = require('./label-export').blinding(rows, (id) => rows[+id.slice(1)]._t);
  assert.deepEqual([b.a.correct, b.a.wrong, b.a.dont_know, b.a.share, b.a.bi], [2, 1, 0, 2 / 3, 1 / 3]);
  assert.equal(b.b.dont_know, 3); // the row with no known tool is skipped
  assert.equal(require('./label-export').blinding([{ id: 'F0' }], () => 'x').a, undefined);
});

test('classify: alpha exactly 0.800 with lower 0.667 is reliable; exactly 0.667 is tentative; just below 0.667 or undefined fails; a low bound blocks reliable', () => {
  const { classify } = require('./label-export');
  assert.equal(classify(0.8, 0.667), 'reliable');
  assert.equal(classify(0.7999, 0.9), 'tentative');
  assert.equal(classify(0.8, 0.6669), 'tentative');
  assert.equal(classify(0.8, null), 'tentative');
  assert.equal(classify(0.667, 0.5), 'tentative');
  assert.equal(classify(0.6669, 0.9), 'fail');
  assert.equal(classify(null, null), 'fail');
});

test('parseCsv accepts a two-labeller sheet with no label column (label_a and label_b only)', () => {
  const rows = parseCsv('id,label_a,label_b\nF1,valid,invalid\n');
  assert.deepEqual(rows, [{ id: 'F1', label_a: 'valid', label_b: 'invalid' }]);
  assert.throws(() => parseCsv('id,notes\nF1,x'), /id and label/);
});

test('agreement: labeller b above 20% unsure refuses too (labeller a clean)', () => {
  const { rows, toolOf } = sheetOf({ specguard: [...AGREE, ...rep(12, ['valid', 'unsure'])] });
  const ag = agreement(rows, toolOf);
  assert.ok(ag.unsure.b > 0.2 && ag.unsure.a === 0);
  assert.equal(ag.ok, false);
});
