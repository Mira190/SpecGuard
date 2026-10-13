const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { extract } = require('./extract-json.js');

const o = '{"a":{"b":"}"},"c":[1]}';

test('extracts the object from prose, fences, a BOM and trailing text', () => {
  for (const s of [o, `﻿${o}\n`, `Here you go:\n${o}\nDone.`, `\`\`\`json\n${o}\n\`\`\``, `\`\`\`\n${o}\n\`\`\`\ntrailing`])
    assert.deepEqual(JSON.parse(extract(s)), JSON.parse(o));
});

test('prefers the last valid fenced block', () => {
  assert.equal(extract('```json\n{"n":1}\n```\ntext\n```json\n{"n":2}\n```'), '{"n":2}');
  assert.equal(extract('```json\n{"findings":[]}\n```\n```json\n{"n": broken}\n```'), '{"findings":[]}');
  assert.equal(extract('```json\n{"n":1}\n```\n```json\n{"n": broken}\n```'), undefined); // other objects are not trusted next to a corrupt span
});

test('returns nothing for text with no valid object', () => {
  for (const s of ['', 'no json', '[1,2]', '{"a":']) assert.equal(extract(s), undefined);
});

test('real t1 copilot.out is not JSON (stray closing brace after the last coverage row); it is not repaired', () => {
  const s = fs.readFileSync(path.join(__dirname, 'fixtures/t1/copilot.out'), 'utf8');
  assert.throws(() => JSON.parse(s), /Expected ',' or '\]'/);
  assert.equal(extract(s), undefined);
});

test('keeps findings whose body holds a code fence, with stray braces in the prose', () => {
  const obj = { findings: [{ body: 'Add:\n```js\nit(1)\n```\ndone' }], coverage: [] };
  const s = `I checked {is} fine.\n\`\`\`json\n${JSON.stringify(obj)}\n\`\`\`\nbye`;
  assert.deepEqual(JSON.parse(extract(s)), obj);
  assert.deepEqual(JSON.parse(extract(`${s}\n{"n":1}`)), obj);
});

test('repairs only trailing commas and raw newlines inside strings; a truncated or otherwise broken span still fails', () => {
  assert.deepEqual(JSON.parse(extract('{"a":[1,2,],"b":{"c":"x",},}')), { a: [1, 2], b: { c: 'x' } });
  assert.deepEqual(JSON.parse(extract('{"a":"line1\nline2\ttab"}')), { a: 'line1\nline2\ttab' });
  assert.deepEqual(JSON.parse(extract('{"a":"keep, }  ,]"}')), { a: 'keep, }  ,]' }); // commas inside strings are data
  assert.equal(require('./post.js').validate(JSON.parse(extract('{"coverage":[{"id":"a"},{"id":"b"') || 'null')).ok, false); // truncated: at most an inner row comes out, which is not a usable report
  assert.equal(extract('{"a":1 "b":2}'), undefined);
});

const { spawnSync } = require('node:child_process');
const os = require('node:os');
function check(t, obj, env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-extract-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'in.txt'), typeof obj === 'string' ? obj : JSON.stringify(obj));
  const r = spawnSync(process.execPath, [path.join(__dirname, 'extract-json.js'), path.join(dir, 'in.txt'), path.join(dir, 'out.json'), '--check'], { encoding: 'utf8', env: { ...process.env, CHECK: '', CTX: dir, ...env } });
  return { status: r.status, out: r.stdout.trim(), dir };
}

test('--check asks for a repair turn only when the output is unusable, and names the failing JSON path', (t) => {
  const row = (i) => ({ id: `O${i}`, obligation: 'x', source: 'PR body', behaviour: null, change: null, evidence: [], status: 'unknown', reason: 'r' });
  const base = { requirements: [], coverage: [row(1), row(2)], findings: [], standards: { status: 'no_rules', sources: [], reason: 'none' }, layering: { status: 'not_reviewed', reason: 'r' } };
  assert.equal(check(t, base).status, 0); // no alignment on any row: derived, not a repair
  assert.equal(check(t, { ...base, coverage: [{ ...row(1), status: 'Unknown' }, { ...row(2), status: 'unknown ' }] }).status, 0); // enum case
  const bad = check(t, { ...base, coverage: [{ id: 'a' }, { id: 'b' }, row(3)] });
  assert.equal(bad.status, 1);
  assert.match(bad.out, /::warning::output failed validation: coverage\[0\]: obligation, source and reason are required \(2 of 3 coverage rows are unusable\)/);
  assert.match(check(t, { findings: [] }).out, /output failed validation: coverage must be an array/);
});

test('--check with CHECK=audit: one hallucinated block id or one unusable class is not a repair; a mostly unusable result is', (t) => {
  const cid = (i) => i.toString(16).padStart(8, '0');
  const N = 10, cands = Array.from({ length: N }, (_, i) => `${cid(i + 1)}\tdocs/d.md:${i + 1}\tH\tRequirement ${i + 1}`).join('\n');
  const rows = Array.from({ length: N - 1 }, (_, i) => ({ id: cid(i + 1), text: `Requirement ${i + 1}`, source: { path: 'docs/d.md', line: i + 1, quote: `Requirement ${i + 1} holds.` }, class: 'unit', status: 'unknown', code: [], tests: [], note: '' }));
  const res = (over = {}) => ({ docs_reviewed: ['docs/d.md'], requirements: rows, not_requirements: [{ cid: cid(N), reason: 'only an example' }], not_reviewed: [], ...over });
  const run = (o) => { const x = check(t, o, { CHECK: 'audit' }); return x; };
  const ctxRun = (o) => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-audit-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); fs.writeFileSync(path.join(dir, 'audit-candidates.txt'), cands); const x = check(t, o, { CHECK: 'audit', CTX: dir }); return x; };
  assert.equal(ctxRun(res()).status, 0);
  assert.equal(ctxRun(res({ not_requirements: [{ cid: cid(N), reason: 'only an example' }, { cid: '527dd1ec', reason: 'hallucinated block' }] })).status, 0);
  assert.equal(ctxRun(res({ requirements: rows.map((r, i) => (i === 3 ? { ...r, class: 'unknown' } : r)) })).status, 0);
  const many = ctxRun(res({ requirements: rows.map((r) => ({ ...r, class: 'weird' })) }));
  assert.equal(many.status, 1);
  assert.match(many.out, /requirements\[0\]: class not stated .*\(9 of 9 requirement rows are unusable\)/);
  assert.match(ctxRun(res({ requirements: rows.slice(0, 5), not_requirements: [] })).out, /5 of 10 listed blocks were not answered/);
  assert.equal(run('no json').status, 1);
});
