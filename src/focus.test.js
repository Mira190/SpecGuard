const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { splitDiff, stats, thresholds, parseCandidates, plan, main, DIFF_BUDGET } = require('./focus.js');
const { LIMITS } = require('./prompt.js');

// One file's diff: `add` added lines, `del` removed lines (each a branch line when `branchy`), optionally a whole-file deletion.
const fileDiff = (p, { add = 5, del = 0, branchy = false, deleted = false } = {}) => `diff --git a/${p} b/${p}\n${deleted ? 'deleted file mode 100644\n' : ''}--- a/${p}\n+++ b/${p}\n@@ -1,${del} +1,${add} @@\n`
  + Array.from({ length: del }, (_, i) => `-${branchy ? 'if (x) return' : 'const v'} ${i}\n`).join('')
  + Array.from({ length: add }, (_, i) => `+const line${i} = ${i};\n`).join('');

function ctx(diffs, extra = {}) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'focus-'));
  fs.writeFileSync(path.join(d, 'diff.patch'), diffs.join(''));
  for (const [k, v] of Object.entries(extra)) fs.writeFileSync(path.join(d, k), v);
  return d;
}
const names = (r) => r.chosen.map((f) => f.path);

// 30 files: 12 logic modules of different weight, 8 tests, 4 docs, 4 configs, 2 generated
function mixed() {
  const logic = Array.from({ length: 12 }, (_, i) => fileDiff(`src/mod${i}.js`, { add: 20 + i * 3 }));
  logic[3] = fileDiff('src/mod3.js', { add: 30, del: 12, branchy: true }); // removes error handling
  return [
    ...logic,
    ...Array.from({ length: 8 }, (_, i) => fileDiff(`src/mod${i}.test.js`, { add: 25 })),
    ...Array.from({ length: 4 }, (_, i) => fileDiff(`docs/guide${i}.md`, { add: 60 })),
    ...Array.from({ length: 4 }, (_, i) => fileDiff(`config/c${i}.yml`, { add: 40 })),
    fileDiff('dist/bundle.js', { add: 200 }), fileDiff('assets/logo.snap', { add: 200 }),
  ];
}
const candidates = (withTest) => Array.from({ length: 12 }, (_, i) => `src/mod${i}.js\n` + (withTest.has(i) ? `  src/mod${i}.test.js  (same name)\n` : '  (no candidate test file found)\n')).join('');

test('splitDiff and stats: per file text, changed lines and removed branch lines', () => {
  const parts = splitDiff(fileDiff('a/b.js', { add: 2, del: 3, branchy: true }) + fileDiff('c.js'));
  assert.deepEqual(parts.map((p) => p.path), ['a/b.js', 'c.js']);
  assert.deepEqual(stats(parts[0].text), { lines: 5, risky: 3, deleted: false });
  assert.equal(stats(splitDiff(fileDiff('x.js', { deleted: true, del: 2 }))[0].text).deleted, true);
  assert.equal(stats('diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n--- sql comment\n+++ b\n').lines, 2, 'a removed "-- x" line is not a header');
});

test('thresholds: defaults, "lines,files", off, bad input falls back', () => {
  assert.deepEqual(thresholds({}), { lines: 600, files: 25, k: 12 });
  assert.deepEqual(thresholds({ FOCUS_THRESHOLD: '100, 5', FOCUS_FILES: '3' }), { lines: 100, files: 5, k: 3 });
  assert.equal(thresholds({ FOCUS_THRESHOLD: 'OFF' }), null);
  assert.deepEqual(thresholds({ FOCUS_THRESHOLD: 'lots', FOCUS_FILES: '0' }), { lines: 600, files: 25, k: 12 });
});

test('parseCandidates: a source with a found test lists it, one without maps to []', () => {
  const m = parseCandidates(candidates(new Set([1])) + '(3 more changed file(s) not listed)\n');
  assert.deepEqual(m.get('src/mod1.js'), ['src/mod1.test.js']);
  assert.deepEqual(m.get('src/mod0.js'), []);
  assert.equal(m.size, 12);
});

test('gate: a small PR stays normal; many lines or many files turns focus on; off disables', () => {
  assert.equal(plan(ctx([fileDiff('a.js', { add: 100 }), fileDiff('b.js', { add: 100 })]), {}).focused, false);
  assert.equal(plan(ctx([fileDiff('a.js', { add: 301 }), fileDiff('b.js', { add: 300 })]), {}).focused, true);
  assert.equal(plan(ctx(Array.from({ length: 25 }, (_, i) => fileDiff(`f${i}.js`, { add: 1 }))), {}).focused, false, '25 files is at the limit');
  assert.equal(plan(ctx(Array.from({ length: 26 }, (_, i) => fileDiff(`f${i}.js`, { add: 1 }))), {}).focused, true);
  assert.equal(plan(ctx(mixed()), { FOCUS_THRESHOLD: 'off' }).focused, false);
  assert.equal(plan(ctx([fileDiff('a.js', { add: 30 })]), { FOCUS_THRESHOLD: '10,5' }).focused, true);
});

test('ranking: a 30-file mixed PR keeps logic first and drops docs, config and generated files', () => {
  const d = ctx(mixed(), { 'test-candidates.txt': candidates(new Set([0, 1, 2, 4, 5, 6, 7])) });
  const r = plan(d, {});
  assert.equal(r.focused, true);
  const src = names(r).filter((p) => !p.includes('.test.'));
  assert.ok(src.every((p) => /^src\/mod\d+\.js$/.test(p)), src.join());
  assert.equal(names(r)[0], 'src/mod3.js', 'removed error handling and no test found rank first');
  assert.match(r.chosen[0].why.join(), /no test found/);
  assert.match(r.chosen[0].why.join(), /12 removed branch\/error line/);
  const out = new Set(r.skipped.map((f) => f.path));
  assert.ok(!names(r).includes('dist/bundle.js') && !names(r).includes('assets/logo.snap'));
  assert.equal(r.chosen.length + r.skipped.length, 30);
  assert.equal(new Set([...names(r), ...out]).size, 30, 'every file is either chosen or skipped');
});

test('budget: chosen source diffs fit 60% of the prompt budget; a changed test of a chosen file rides in the rest', () => {
  assert.equal(DIFF_BUDGET, LIMITS.diff);
  const big = Array.from({ length: 10 }, (_, i) => fileDiff(`src/big${i}.js`, { add: 250 }));
  const r = plan(ctx([...big, fileDiff('src/big0.test.js', { add: 20 }), ...Array.from({ length: 20 }, (_, i) => fileDiff(`x${i}.js`, { add: 1 }))],
    { 'test-candidates.txt': 'src/big0.js\n  src/big0.test.js  (same name)\n' }), {});
  const srcBytes = r.chosen.filter((f) => !f.path.includes('.test.')).reduce((a, f) => a + Buffer.byteLength(f.text), 0);
  assert.ok(srcBytes < DIFF_BUDGET * 0.6 + 8000, String(srcBytes)); // numbered text is a little larger than the raw one
  assert.ok(Buffer.byteLength(r.numbered) <= DIFF_BUDGET, 'the numbered focused diff fits the prompt budget');
  assert.ok(names(r).filter((p) => p.startsWith('src/big') && !p.includes('.test.')).length <= 4, 'only a few big files fit');
  if (names(r).includes('src/big0.js')) assert.ok(names(r).includes('src/big0.test.js'));
});

test('deleted files rank low, a requirement naming a file raises it, at most FOCUS_FILES are kept', () => {
  const r = plan(ctx([fileDiff('src/old.js', { add: 0, del: 400, deleted: true }), fileDiff('src/new.js', { add: 30 }), fileDiff('src/named.js', { add: 30 }),
    ...Array.from({ length: 30 }, (_, i) => fileDiff(`pad/p${i}.js`, { add: 20 }))],
  { 'requirements.md': 'Criterion: src/named.js must validate\n' }), { FOCUS_FILES: '3' });
  assert.equal(r.chosen.length, 3);
  assert.equal(names(r)[0], 'src/named.js');
  assert.ok(!names(r).includes('src/old.js'));
  assert.ok(r.skipped.some((f) => f.path === 'src/old.js'));
});

test('main: writes focus.txt, focus-skipped.txt and a numbered diff of the chosen files only; diff.patch is left whole; a small PR writes nothing', () => {
  const d = ctx(mixed(), { 'test-candidates.txt': candidates(new Set([5])) });
  const before = fs.readFileSync(path.join(d, 'diff.patch'), 'utf8');
  assert.equal(main(d, {}).focused, true);
  const focus = fs.readFileSync(path.join(d, 'focus.txt'), 'utf8').split('\n').filter(Boolean);
  assert.match(focus[0], /^src\/mod3\.js\t\d+\.\d\tlogic, no test found, 12 removed branch\/error line\(s\)$/);
  const skipped = fs.readFileSync(path.join(d, 'focus-skipped.txt'), 'utf8').split('\n').filter(Boolean);
  assert.match(skipped[0], /^[^\t]+\t\d+$/);
  assert.equal(focus.length + skipped.length, 30);
  const numbered = fs.readFileSync(path.join(d, 'diff.numbered.txt'), 'utf8');
  assert.match(numbered, /^diff --git a\/src\/mod0\.js/); // diff order, not score order
  assert.match(numbered, /^diff --git a\/src\/mod3\.js/m);
  assert.match(numbered, /\n\s+1 \| \+const line0 = 0;/);
  assert.ok(!numbered.includes('docs/guide0.md') && !numbered.includes('dist/bundle.js'));
  assert.equal(fs.readFileSync(path.join(d, 'diff.patch'), 'utf8'), before);
  const small = ctx([fileDiff('a.js')]);
  assert.equal(main(small, {}).focused, false);
  assert.deepEqual(fs.readdirSync(small), ['diff.patch']);
});
