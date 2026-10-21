const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { entries } = require('../replay');
const { build } = require('./coverage-e3-manifest');

test('the generated manifest reads into the 40 bug rows of the E1 confirmation list, in order, with unique ids, the right heads and a pr_text source', () => {
  const bugs = require('./coverage-e1-confirm.json').rows.filter((r) => r.kind === 'bug'), file = path.join(__dirname, 'coverage-e3-manifest.json'), e = entries(file), m = require('./coverage-e3-manifest.json');
  assert.strictEqual(e.length, 40);
  assert.deepStrictEqual(e.map((x) => x.id), bugs.map((r) => r.id));
  assert.strictEqual(new Set(e.map((x) => x.id)).size, 40);
  e.forEach((x, i) => { assert.strictEqual(x.head, bugs[i].introducing.head); assert.strictEqual(x.base, bugs[i].introducing.base); assert.strictEqual(x.set, 'bug'); assert.ok(x.title); });
  assert.ok(m.bugs.every((b) => b.pr_text === 'github' || b.pr_text === 'commit'));
  assert.strictEqual(m.pr_text_fallback, m.bugs.filter((b) => b.pr_text === 'commit').length);
});

test('build uses the PR own GitHub text, falls back to the commit subject with an empty body, and counts fallbacks', () => {
  const rows = [{ id: 'hono-1', repo: 'honojs/hono', kind: 'bug', introducing: { head: 'h1', base: 'b1', number: 1 } }, { id: 'hono-2', repo: 'honojs/hono', kind: 'bug', introducing: { head: 'h2', base: 'b2', number: 2 } },
    { id: 'hono-ctl-3', repo: 'honojs/hono', kind: 'control' }];
  const r = build(rows, { 'honojs/hono#1': { title: 'T', body: null }, 'honojs/hono#2': { failed: true } }, (c, h) => `subject ${c} ${h}`);
  assert.strictEqual(r.pr_text_fallback, 1);
  assert.deepStrictEqual(r.bugs.map((b) => [b.title, b.body, b.pr_text]), [['T', '', 'github'], ['subject hono h2', '', 'commit']]);
});
