const test = require('node:test');
const assert = require('node:assert/strict');
const { findingId, exportRows, toCsv, parseCsv, readLabels, labelPrecision, COLUMNS } = require('./label-export');

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

test('export: a delivery column; summary-only rows link to the summary comment, inline rows to the files page', () => {
  const rows = exportRows([{ ...F('specguard', 5, 10, 'x'), delivery: 'summary', url: 'https://github.com/o/r/pull/5#issuecomment-1' }, F('copilot', 5, 12, 'y')], { sample: 0, seed: 1 });
  const by = Object.fromEntries(rows.map((r) => [r.delivery, r]));
  assert.equal(by.summary.link, 'https://github.com/o/r/pull/5#issuecomment-1');
  assert.equal(by.inline.link, 'https://github.com/o/r/pull/5/files'); // a finding with no delivery field is inline
  assert.match(toCsv(rows).split('\n')[0], /,link,delivery,label,notes$/);
});
