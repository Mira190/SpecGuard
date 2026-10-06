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
