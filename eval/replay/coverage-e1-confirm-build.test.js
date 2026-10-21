const test = require('node:test');
const assert = require('node:assert');
const { coreOnly, bugRow, assemble, allocate, validId } = require('./coverage-e1-confirm-build');

const row = (clone, i, core = true) => ({ repo: 'o/' + clone, clone, fix: 'f' + clone + i, introducing: 'i' + clone + i, pr: 100 + i, base: 'b' + clone + i, core });
const q = (clone, n, bad = []) => Array.from({ length: n }, (_, i) => row(clone, i, !bad.includes(i)));
const ok = (r) => r.clone !== 'langchain' || r.core;

test('core rule: code files only, all under libs/core/, at least one', () => {
  assert.ok(coreOnly(['libs/core/langchain_core/x.py', 'libs/core/uv.lock', 'libs/core/tests/test_x.py']));
  assert.ok(!coreOnly(['libs/core/a.py', 'libs/partners/openai/b.py']));
  assert.ok(!coreOnly(['libs/core/uv.lock'])); // no code file
  assert.ok(coreOnly(['libs/core/a.py', '.github/scripts/check_diff.py']));
});

test('frozen = first 6 per repo BEFORE the core rule, then filtered; the top-up skips frozen rows even if they failed the core rule', () => {
  // langchain rows 1 and 4 are not core: frozen keeps 4 of the first 6; rows 0..5 never re-enter the top-up
  const queues = { hono: q('hono', 10), langchain: q('langchain', 12, [1, 4, 7]), sqlglot: q('sqlglot', 3) };
  const a = assemble({ queues, unfiltered: { hono: [], langchain: [], sqlglot: [] }, ok });
  assert.deepStrictEqual(a.frozen.filter((r) => r.clone === 'langchain').map((r) => r.pr), [100, 102, 103, 105]);
  assert.strictEqual(a.funnel.frozen_before_core.langchain, 6);
  assert.strictEqual(a.funnel.frozen_kept.langchain, 4);
  assert.strictEqual(a.frozen.length, 6 + 4 + 3);
  const top = a.topup;
  assert.ok(!top.some((r) => r.clone === 'langchain' && r.pr <= 105)); // frozen window, kept or dropped, is not re-drawn
  assert.ok(!top.some((r) => r.clone === 'langchain' && r.pr === 107)); // core rule applies in the top-up
});

test('top-up is round robin hono, langchain, sqlglot, newest first, until 40; short queues give needs_window_extension', () => {
  const queues = { hono: q('hono', 30), langchain: q('langchain', 30), sqlglot: q('sqlglot', 30) };
  const a = assemble({ queues, unfiltered: { hono: [], langchain: [], sqlglot: [] }, ok });
  assert.strictEqual(a.frozen.length + a.topup.length, 40);
  assert.deepStrictEqual(a.topup.slice(0, 6).map((r) => r.clone + r.pr), ['hono106', 'langchain106', 'sqlglot106', 'hono107', 'langchain107', 'sqlglot107']);
  assert.strictEqual(a.status, 'ok');
  const short = assemble({ queues: { hono: q('hono', 8), langchain: q('langchain', 2), sqlglot: q('sqlglot', 3) }, unfiltered: { hono: [], langchain: [], sqlglot: [] }, ok });
  assert.strictEqual(short.status, 'needs_window_extension');
  assert.strictEqual(short.frozen.length + short.topup.length, 8 + 2 + 3);
});

test('unfiltered: at most 20, round robin, core rule, never a bug-set row', () => {
  const queues = { hono: q('hono', 8), langchain: q('langchain', 8), sqlglot: q('sqlglot', 8) };
  const u = (c, bad) => Array.from({ length: 12 }, (_, i) => ({ ...row(c, 50 + i, !bad.includes(i)), introducing: 'u' + c + i }));
  const a = assemble({ queues, unfiltered: { hono: u('hono', []), langchain: u('langchain', [0]), sqlglot: u('sqlglot', []) }, ok });
  assert.strictEqual(a.unfiltered.length, 20);
  assert.deepStrictEqual(a.unfiltered.slice(0, 3).map((r) => r.introducing), ['uhono0', 'ulangchain1', 'usqlglot0']); // langchain row 0 fails the core rule
  assert.ok(!a.unfiltered.some((r) => r.clone === 'langchain' && r.introducing === 'ulangchain0'));
});

test('ids are unique and file-name safe; rows carry what the scorer needs', () => {
  const queues = { hono: q('hono', 20), langchain: q('langchain', 20), sqlglot: q('sqlglot', 20) };
  const a = assemble({ queues, unfiltered: { hono: [], langchain: [], sqlglot: [] }, ok });
  const rows = [...a.frozen.map((r) => bugRow(r, 'frozen')), ...a.topup.map((r) => bugRow(r, 'topup'))];
  const ids = rows.map((r) => r.id);
  assert.strictEqual(new Set(ids).size, ids.length);
  assert.ok(ids.every(validId));
  assert.deepStrictEqual(Object.keys(rows[0]).sort(), ['base', 'buggy_sha', 'fix_sha', 'fixed_sha', 'id', 'introducing', 'kind', 'repo', 'set', 'subgroup']);
  assert.deepStrictEqual(rows[0].introducing, { base: 'bhono0', head: 'ihono0', merge_commit: 'ihono0', number: 100 });
  assert.ok(!validId('a b') && !validId('a/b'));
});

test('control quotas: largest remainder, sums to 30, ties alphabetical', () => {
  const q2 = allocate(30, { hono: 20, langchain: 10, sqlglot: 10 });
  assert.strictEqual(q2.hono + q2.langchain + q2.sqlglot, 30);
  assert.deepStrictEqual(q2, { hono: 15, langchain: 8, sqlglot: 7 }); // 15, 7.5, 7.5: first remainder tie goes to langchain
  assert.deepStrictEqual(allocate(30, { a: 0, b: 0 }), { a: 0, b: 0 });
});

// ---- window-extension fallback (prereg fixed 2026-10-20) ----
const dated = (clone, n, sub) => Array.from({ length: n }, (_, i) => ({ ...row(clone, i + (sub === 'u' ? 500 : 0)), fix_date: `2026-0${9 - (i % 9)}-1${i % 9}T00:00:00Z`, introducing: sub + clone + i }));
const none = { hono: [], langchain: [], sqlglot: [] };

test('branch 1: under 40 filtered and not extended gives needs_window_extension, primary filtered', () => {
  const a = assemble({ queues: { hono: dated('hono', 10, 'f'), langchain: dated('langchain', 5, 'f'), sqlglot: dated('sqlglot', 5, 'f') }, unfiltered: none, ok });
  assert.strictEqual(a.status, 'needs_window_extension');
  assert.strictEqual(a.primary, 'filtered');
});

test('branch 2: extended with 30..39 filtered stays filtered and draws the unfiltered comparison set', () => {
  const a = assemble({ queues: { hono: dated('hono', 12, 'f'), langchain: dated('langchain', 12, 'f'), sqlglot: dated('sqlglot', 10, 'f') }, unfiltered: { hono: dated('hono', 8, 'u'), langchain: dated('langchain', 8, 'u'), sqlglot: dated('sqlglot', 8, 'u') }, ok, extended: true });
  assert.strictEqual(a.primary, 'filtered');
  assert.strictEqual(a.status, 'ok');
  assert.strictEqual(a.frozen.length + a.topup.length, 34);
  assert.ok([...a.frozen, ...a.topup].every((r) => !r._sub || r._sub === 'filtered'));
  assert.ok(a.unfiltered.length > 0 && a.unfiltered.length <= 20);
});

test('branch 3: extended with under 30 filtered builds filtered + unfiltered, frozen first, subgroup marked, no separate comparison set', () => {
  const queues = { hono: dated('hono', 8, 'f'), langchain: dated('langchain', 4, 'f'), sqlglot: dated('sqlglot', 4, 'f') }; // 16 filtered
  const a = assemble({ queues, unfiltered: { hono: dated('hono', 10, 'u'), langchain: dated('langchain', 10, 'u'), sqlglot: dated('sqlglot', 10, 'u') }, ok, extended: true });
  assert.strictEqual(a.primary, 'union');
  assert.strictEqual(a.unfiltered.length, 0);
  assert.strictEqual(a.frozen.length + a.topup.length, 40);
  assert.strictEqual(a.status, 'ok');
  const rows = [...a.frozen, ...a.topup].map((r) => bugRow(r, 'x'));
  assert.ok(rows.some((r) => r.subgroup === 'unfiltered') && rows.some((r) => r.subgroup === 'filtered'));
  assert.ok(a.frozen.every((r) => bugRow(r, 'frozen').subgroup === 'filtered')); // frozen members come first and are filtered rows
  assert.strictEqual(new Set(rows.map((r) => r.id)).size, rows.length);
  // under 30 even as a union: not tested
  const small = assemble({ queues: { hono: dated('hono', 5, 'f'), langchain: dated('langchain', 2, 'f'), sqlglot: dated('sqlglot', 2, 'f') }, unfiltered: { hono: dated('hono', 5, 'u'), langchain: dated('langchain', 2, 'u'), sqlglot: dated('sqlglot', 3, 'u') }, ok, extended: true });
  assert.strictEqual(small.primary, 'union');
  assert.strictEqual(small.status, 'not_tested');
});
