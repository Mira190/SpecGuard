const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { entries } = require('../replay');
const { build, titleIndex } = require('./coverage-e3-manifest');

test('the generated manifest reads into the 40 bug rows of the E1 confirmation list, in order, with unique ids and the right heads', () => {
  const bugs = require('./coverage-e1-confirm.json').rows.filter((r) => r.kind === 'bug'), e = entries(path.join(__dirname, 'coverage-e3-manifest.json'));
  assert.strictEqual(e.length, 40);
  assert.deepStrictEqual(e.map((x) => x.id), bugs.map((r) => r.id));
  assert.strictEqual(new Set(e.map((x) => x.id)).size, 40);
  e.forEach((x, i) => { assert.strictEqual(x.head, bugs[i].introducing.head); assert.strictEqual(x.base, bugs[i].introducing.base); assert.strictEqual(x.set, 'bug'); assert.ok(x.title); assert.strictEqual(typeof x.body, 'string'); });
});

test('build reports missing titles and bodies instead of inventing them', () => {
  const rows = [{ id: 'hono-1', repo: 'honojs/hono', kind: 'bug', introducing: { head: 'h', base: 'b', number: 1 } }, { id: 'hono-ctl-2', repo: 'honojs/hono', kind: 'control' }];
  const t = titleIndex({ hono: { candidates: [{ introducing: [{ sha: 'h', title: 'T (#1)' }] }] } });
  const r = build(rows, t, {});
  assert.deepStrictEqual(r.missing, { titles: [], bodies: ['hono-1'] }); assert.strictEqual(r.bugs.length, 1); assert.strictEqual(r.bugs[0].title, 'T (#1)');
  assert.deepStrictEqual(build(rows, new Map(), { 'hono-1': { body: 'B' } }).missing, { titles: ['hono-1'], bodies: [] });
});
