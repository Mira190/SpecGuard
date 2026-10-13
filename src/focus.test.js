const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { splitDiff, stats, trim, thresholds, parseCandidates, plan, main, DIFF_BUDGET } = require('./focus.js');
const { numberDiff } = require('./numdiff.js');
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
  assert.deepEqual(stats(parts[0].text), { lines: 5, risky: 3, branch: 3, deleted: false });
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
  assert.match(r.chosen[0].why.join(), /12 branch\/error line\(s\) changed.*12 of them removed/);
  const out = new Set(r.skipped.map((f) => f.path));
  assert.ok(!names(r).includes('dist/bundle.js') && !names(r).includes('assets/logo.snap'));
  assert.equal(r.chosen.length + r.skipped.length, 30);
  assert.equal(new Set([...names(r), ...out]).size, 30, 'every file is either chosen or skipped');
});

test('budget: every chosen file is kept, each cut to its share of the prompt budget with a marker; a small file keeps all of its diff', () => {
  assert.equal(DIFF_BUDGET, LIMITS.diff);
  const big = Array.from({ length: 14 }, (_, i) => fileDiff(`src/big${i}.js`, { add: 250 + i }));
  const r = plan(ctx([...big, fileDiff('src/big0.test.js', { add: 20 }), fileDiff('src/small.js', { add: 3 }), ...Array.from({ length: 20 }, (_, i) => fileDiff(`x${i}.js`, { add: 1 }))],
    { 'test-candidates.txt': 'src/big0.js\n  src/big0.test.js  (same name)\n' }), {});
  assert.equal(names(r).filter((p) => !p.includes('.test.')).length, 12, 'K files, none dropped for size');
  assert.ok(names(r).includes('src/big0.test.js'), 'a changed test of a chosen file rides along');
  assert.ok(Buffer.byteLength(r.numbered) <= DIFF_BUDGET, `the numbered focused diff fits the prompt budget: ${Buffer.byteLength(r.numbered)}`);
  const pieces = r.numbered.split(/^(?=diff --git )/m);
  assert.equal(pieces.length, r.chosen.length);
  for (const piece of pieces.filter((x) => /^diff --git a\/src\/big\d+\.js/.test(x))) {
    assert.match(piece, /\n… \d+ more changed lines in this file not shown \(read the file for them\)\n$/);
    assert.ok(Buffer.byteLength(piece) > 1500, 'every file keeps a real share, not one line');
  }
  const only = plan(ctx([fileDiff('src/small.js', { add: 3 }), ...big.slice(0, 2)]), { FOCUS_THRESHOLD: '1,1' });
  assert.ok(!only.numbered.split('diff --git a/src/big')[0].includes('more changed lines'), 'no marker on a file that fits');
});

test('trim: whole hunks up to the allowance, the first hunk cut by lines when alone too big, a marker counts the changed lines left out', () => {
  const hunk = (at, n) => `@@ -${at},${n} +${at},${n} @@\n${Array.from({ length: n }, (_, i) => `+line ${at + i}\n`).join('')}`;
  const nd = numberDiff(`diff --git a/f.js b/f.js\n--- a/f.js\n+++ b/f.js\n${hunk(1, 20)}${hunk(100, 20)}${hunk(200, 20)}`);
  assert.equal(trim(nd, 1e6), nd);
  const two = trim(nd, Buffer.byteLength(nd) - 50);
  assert.match(two, /@@ -100,20/);
  assert.doesNotMatch(two, /@@ -200,20/);
  assert.match(two, /… 20 more changed lines in this file not shown \(read the file for them\)\n$/);
  const cut = trim(nd, 300);
  assert.match(cut, /@@ -1,20/);
  assert.doesNotMatch(cut, /@@ -100,20/);
  assert.match(cut, /… (4\d|5\d|60) more changed lines/);
  assert.ok(Buffer.byteLength(cut) < 450);
});

test('requirement documents are not review files: listed in focus-requirements.txt, neither chosen nor skipped', () => {
  const d = ctx([fileDiff('docs/spec.md', { add: 300 }), fileDiff('src/a.js', { add: 20 }), ...Array.from({ length: 26 }, (_, i) => fileDiff(`src/m${i}.js`, { add: 2 }))], { 'spec-files.txt': 'docs/spec.md\n' });
  const r = main(d, {});
  assert.ok(!names(r).includes('docs/spec.md') && !r.skipped.some((f) => f.path === 'docs/spec.md'));
  assert.equal(fs.readFileSync(path.join(d, 'focus-requirements.txt'), 'utf8'), 'docs/spec.md\t300\n');
  assert.ok(!fs.readFileSync(path.join(d, 'diff.numbered.txt'), 'utf8').includes('docs/spec.md'));
});

// PR #111 (721dd1a..7909236): the live focused review spent its three files on the offline eval tool and skipped the product. Names and sizes are the real ones.
test('PR #111 shape: post, prompt, focus, collect.sh and action.yml are chosen before eval/* and docs/*', () => {
  const pr = {
    'README.md': [3], 'action.yml': [4, ['  focus_files: { default: "12" }']], 'docs/validation-plan.md': [98], 'docs/validation-workflow.example.yml': [112],
    'eval/assign.js': [17], 'eval/assign.test.js': [38], 'eval/label-export.js': [103, ['if (!rows.length) return;', 'throw new Error("bad")']], 'eval/label-export.test.js': [54],
    'eval/weekly-report.js': [259, Array.from({ length: 30 }, (_, i) => `if (x${i}) return;`)], 'eval/weekly-report.test.js': [150],
    'src/collect.sh': [4, ['timeout 60 node "$HERE/focus.js" "$CTX" || { echo failed; }']], 'src/collect.test.js': [17],
    'src/focus.js': [145, ["const { numberDiff } = require('./numdiff.js');", 'if (!th) return { focused: false };']], 'src/focus.test.js': [122],
    'src/post.js': [7, ['const focusNote = (n) => n; // see src/focus.js']], 'src/post.test.js': [17],
    'src/prompt.js': [22, ["const { splitDiff } = require('./focus.js');", 'if (focus) return null;']], 'src/prompt.test.js': [19],
  };
  const diffs = Object.entries(pr).map(([p, [add, extra = []]]) => fileDiff(p, { add }) + extra.map((l) => `+${l}\n`).join(''));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'focus-root-'));
  fs.writeFileSync(path.join(root, 'action.yml'), 'runs:\n  steps:\n    - run: bash "$GITHUB_ACTION_PATH/src/collect.sh"\n    - run: node "$GITHUB_ACTION_PATH/src/prompt.js" && node "$GITHUB_ACTION_PATH/src/post.js"\n');
  const cands = ['src/collect.sh', 'src/focus.js', 'src/post.js', 'src/prompt.js', 'eval/assign.js', 'eval/label-export.js', 'eval/weekly-report.js']
    .map((p) => `${p}\n  ${p.replace(/\.(js|sh)$/, '.test.js')}  (same name)\n`).join('');
  const d = ctx(diffs, { 'test-candidates.txt': cands });
  const r = plan(d, { FOCUS_ROOT: root });
  const src = names(r).filter((p) => !p.includes('.test.'));
  const core = ['src/post.js', 'src/prompt.js', 'src/focus.js', 'src/collect.sh', 'action.yml'];
  assert.deepEqual(src.slice(0, 5).sort(), core.slice().sort(), r.chosen.map((f) => `${f.path} ${f.score.toFixed(1)}`).join('\n'));
  assert.ok(src.slice(5).every((p) => /^(eval|docs)\/|^README/.test(p)));
  const k6 = plan(d, { FOCUS_ROOT: root, FOCUS_FILES: '6' });
  assert.deepEqual(names(k6).filter((p) => !p.includes('.test.')).slice(0, 5).sort(), core.slice().sort());
  const why = Object.fromEntries(r.chosen.map((f) => [f.path, f.why.join(', ')]));
  assert.match(why['src/post.js'], /entry point \+3\.0/);
  assert.match(why['src/focus.js'], /fan-in 3 \+3\.0/);
  assert.match(why['eval/weekly-report.js'], /tooling\/docs path x0\.35/);
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
  assert.match(focus[0], /^src\/mod3\.js\t\d+\.\d\tlogic \+3\.0, size \+2\.5, 12 branch\/error line\(s\) changed \+2\.0, 12 of them removed \+2\.0, no test found \+0\.5$/);
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
