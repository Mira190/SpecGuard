const test = require('node:test');
const assert = require('node:assert');
const { classifyReason, gateNotes, triggersOf, likelyExists } = require('./testgap-demotion');

const f = { kind: 'missing_test', path: 'm/x.go', line: 5 };
const A = 'low confidence: a candidate test file was only partly visible (m/x_test.go); missing_test m/x.go is not counted.';
const B = 'low confidence: candidate tests were not looked up for m/x.go (too many changed files); missing_test m/x.go is not counted.';
const C = 'low confidence: a test may already cover this: a delegated helper is tested: get at m/y_test.go:3; missing_test m/x.go is not counted.';
const E = 'Obligation row contradicted finding missing_test m/x.go: kept the finding at low confidence and marked the row covered.';
const D = 'reduced review: needs high confidence and two citations; low confidence';

test('each pattern', () => {
  assert.deepEqual([classifyReason(f, [A]).reason, classifyReason(f, [A]).file], ['a', 'm/x_test.go']);
  assert.equal(classifyReason(f, [B]).reason, 'b');
  assert.equal(classifyReason(f, [C]).reason, 'c');
  assert.equal(classifyReason(f, [], D).reason, 'd');
  assert.equal(classifyReason(f, [E]).reason, 'e');
  assert.equal(classifyReason(f, ['low confidence: weird; missing_test m/x.go is odd']).reason, 'f');
  assert.equal(classifyReason(f, [], 'some other reason').reason, 'f');
  assert.equal(classifyReason(f, [], 'low confidence').reason, 'g');
  assert.equal(classifyReason(f, [A.replace('m/x.go', 'm/z.go')], '').reason, 'g'); // note about another path
});
test('priority a > b > c > d > e > f > g, and also lists every match', () => {
  const r = classifyReason(f, [E, C, B, A], D);
  assert.equal(r.reason, 'a'); assert.deepEqual(r.also, ['a', 'b', 'c', 'd', 'e']);
  assert.equal(classifyReason(f, [E, C, B], D).reason, 'b');
  assert.equal(classifyReason(f, [E, C], D).reason, 'c');
  assert.equal(classifyReason(f, [E], D).reason, 'd');
  assert.equal(classifyReason(f, [E]).reason, 'e');
});
test('notes and triggers', () => {
  assert.deepEqual(gateNotes(`- ${A}\n- Obligation O1 marked unknown: x\n- ${E}`), [A, E]);
  assert.deepEqual(triggersOf('Reasons: fast-tier model; 3 of 8 obligations degraded by validation (model: claude-haiku-5-5). Only high-confidence findings were posted inline.'), ['tier', 'degraded']);
  assert.deepEqual(triggersOf('Reasons: fast-tier model; 4 engine notes; the JSON needed a repair turn (model: x). Only'), ['tier', 'repair', 'notes']);
  assert.deepEqual(triggersOf('nothing'), []);
});
test('likelyExists', () => {
  assert.equal(likelyExists('foo', () => true), 'test likely exists (false gap)');
  assert.equal(likelyExists('foo', () => false), 'no test found');
  assert.equal(likelyExists(null, () => true), 'unknown');
});
