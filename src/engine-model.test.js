const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { run, parseEvents, tierOf } = require('./engine-model.js');

const ev = (chosen, d = {}) => JSON.stringify({ type: 'session.auto_mode_resolved', data: { chosenModel: chosen, candidateModels: [chosen, 'b'], availableModels: [chosen], routingMethod: 'auto_v2', categoryScores: { reasoning: 0.3 }, fallback: false, ...d } });
function env(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'specguard-em-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ctx = path.join(dir, 'ctx'), home = path.join(dir, 'home', 'session-state', 'S1');
  fs.mkdirSync(ctx); fs.mkdirSync(home, { recursive: true });
  return { dir, ctx, events: path.join(home, 'events.jsonl'), home: path.join(dir, 'home') };
}

test('parseEvents keeps the routing fields and skips garbage', () => {
  const [e, ...rest] = parseEvents(['{"type":"session.info"}', 'garbage', ev('x-1', { fallback: true }), '{"type":"session.auto_mode_resolved","data":{}}'].join('\n'));
  assert.equal(rest.length, 0);
  assert.deepEqual(e, { chosen: 'x-1', candidates: ['x-1', 'b'], available: ['x-1'], routing: 'auto_v2', scores: { reasoning: 0.3 }, fallback: true });
});

test('turns are attributed once: a later call only labels the new events of the shared session', (t) => {
  const e = env(t);
  fs.writeFileSync(e.events, ev('gpt-6-luna') + '\n');
  run({ ctx: e.ctx, sid: 'S1', turn: 'main', home: e.home });
  fs.appendFileSync(e.events, ev('claude-haiku-5.5') + '\n');
  const d = run({ ctx: e.ctx, sid: 'S1', turn: 'repair', home: e.home });
  assert.deepEqual(d.turns.map((x) => [x.turn, x.chosen]), [['main', 'gpt-6-luna'], ['repair', 'claude-haiku-5.5']]);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(e.ctx, 'engine-model.json'), 'utf8')), d);
  assert.equal(d.tier, 'fast');
});

test('usage.json currentModel / modelMetrics fill in when there is no event; corrupt events or usage files record what is known', (t) => {
  const e = env(t);
  const u = path.join(e.dir, 'u.json');
  fs.writeFileSync(u, JSON.stringify({ currentModel: 'a-1', modelMetrics: { 'a-1': {}, 'b-2': {} } }));
  const d = run({ ctx: e.ctx, sid: 'S1', turn: 'main', usage: u, home: e.home });
  assert.deepEqual(d.used, ['a-1', 'b-2']);
  assert.ok(d.turns.every((x) => x.source === 'usage'));
  const e2 = env(t);
  fs.writeFileSync(e2.events, '\u0000\u0001 {{{');
  fs.writeFileSync(path.join(e2.dir, 'bad.json'), '{');
  const d2 = run({ ctx: e2.ctx, sid: 'S1', requested: 'auto', turn: 'main', usage: path.join(e2.dir, 'bad.json'), home: e2.home });
  assert.deepEqual([d2.turns, d2.used, d2.tier], [[], [], 'normal']);
  assert.doesNotThrow(() => run({ ctx: path.join(e2.dir, 'nope'), sid: undefined, home: e2.home })); // unwritable ctx, no sid
});

test('a garbled engine-model.json is replaced, not fatal', (t) => {
  const e = env(t);
  fs.writeFileSync(path.join(e.ctx, 'engine-model.json'), '{oops');
  fs.writeFileSync(e.events, ev('m-1') + '\n');
  assert.deepEqual(run({ ctx: e.ctx, sid: 'S1', home: e.home }).used, ['m-1']);
});

test('tier table: name patterns are fast, everything else (including unknown) is normal', () => {
  for (const n of ['mai-code-1.1-flash', 'gpt-5.4-mini', 'claude-haiku-4.5', 'gemini-3.7-flash', 'raptor-mini', 'x-nano', 'y-lite', 'z-small-2']) assert.equal(tierOf(n), 'fast', n);
  for (const n of ['gpt-6-luna', 'claude-sonnet-4.6', 'gpt-5.4', 'auto', 'terminal', 'miniature', 'flashy']) assert.equal(tierOf(n), 'normal', n);
});

test('fast_models: exact names (case-insensitive, comma or newline) and /regex/ extend the table; a bad regex is ignored', () => {
  assert.equal(tierOf('gpt-6-luna', 'gpt-6-luna'), 'fast');
  assert.equal(tierOf('GPT-6-Luna', 'foo, gpt-6-luna'), 'fast');
  assert.equal(tierOf('gpt-6-luna', 'gpt-6'), 'normal'); // exact, not a substring
  assert.equal(tierOf('gpt-6-luna', 'foo\n/^gpt-[0-9]-lu/'), 'fast');
  assert.equal(tierOf('gpt-6-luna', '/(unclosed/\n/^claude/'), 'normal');
  assert.equal(tierOf('model-a', '/a$/'), 'fast');
});

test('tier is fast when ANY turn used a fast model', (t) => {
  const e = env(t);
  fs.writeFileSync(e.events, [ev('gpt-6-luna'), ev('thing-mini')].join('\n') + '\n');
  assert.equal(run({ ctx: e.ctx, sid: 'S1', home: e.home }).tier, 'fast');
  const e2 = env(t);
  fs.writeFileSync(e2.events, ev('gpt-6-luna') + '\n');
  assert.equal(run({ ctx: e2.ctx, sid: 'S1', home: e2.home }).tier, 'normal');
  assert.equal(run({ ctx: e2.ctx, sid: 'S1', home: e2.home, fast: 'gpt-6-luna' }).tier, 'fast');
});
