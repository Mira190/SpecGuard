const test = require('node:test');
const assert = require('node:assert/strict');
const { findingId, exportRows, toCsv, parseCsv, readLabels, labelPrecision, alpha, agreement, COLUMNS } = require('./label-export');

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
