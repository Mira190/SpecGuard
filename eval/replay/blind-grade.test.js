const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const bg = require('./blind-grade.js');

const SHA = (c) => c.repeat(40);
const pair = (id, repo, fix, intro, extra = {}) => ({ id, replay_id: `r${intro}`, repo, fix: { number: fix }, introducing: { number: intro, merge_commit: SHA('a'), base: SHA('b'), head: SHA('c') }, replay_eligible: true, bug_card: { behaviour: `Broken since #${intro} (https://github.com/o/r/pull/${intro}) in handler`, trigger: `call with x, see PR ${fix}`, region: 'src/a.js:10', test_gap: 'no test', bug_fix_pr: fix }, ...extra });
const PAIRS = [pair('a-9<-1', 'o/a', 9, 1), pair('a-8<-2', 'o/a', 8, 2), pair('a-7<-3', 'o/a', 7, 3), pair('b-6<-4', 'o/b', 6, 4), pair('b-5<-5', 'o/b', 5, 5), pair('c-4<-6', 'o/c', 4, 6)];

function fixture() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-'));
  fs.mkdirSync(path.join(d, 'fixdiff'));
  fs.writeFileSync(path.join(d, 'pairs.json'), JSON.stringify({ pairs: PAIRS }));
  fs.writeFileSync(path.join(d, 'audit.json'), '[]');
  fs.writeFileSync(path.join(d, 'fixshas.json'), '{}');
  for (const run of ['run1', 'run2']) for (const p of PAIRS) {
    const dir = path.join(d, 'raw', run, `replay-${p.replay_id}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify({ findings: [{ where: 'inline', kind: 'weak_test', path: 'src/a.js', line: 10, title: `Title from #${p.introducing.number} see https://github.com/o/r/pull/${p.introducing.number}`, confidence: 'high' }] }));
  }
  for (const p of PAIRS) fs.writeFileSync(path.join(d, 'fixdiff', `${p.replay_id}.diff`), `diff --git a/x b/x\n+// fixes PR #${p.fix.number}\n+ok\n`);
  return { pairs: path.join(d, 'pairs.json'), raw: path.join(d, 'raw'), runs: 'run1,run2', audit: path.join(d, 'audit.json'), fixdiff: path.join(d, 'fixdiff'), fixshas: path.join(d, 'fixshas.json'), repos: d, out: path.join(d, 'out'), template: path.join(__dirname, 'blind-grade-prompt.md') };
}

test('items: real and mismatched arms, singleton repo dropped, Y is another PR of the same repo', () => {
  const b = bg.build(fixture());
  assert.equal(b.items.length, 3 * 5 * 2); // 5 pairs in repos with >= 2, 2 reps, 3 arms (real, M1, M2)
  assert.deepEqual(b.dropped.repos, ['o/c']);
  assert.equal(b.dropped.items, 6);
  for (const it of b.items.filter((i) => i.arm !== 'real')) { assert.notEqual(it.findings_from, it.pair); assert.equal(it.findings_from.split('-')[0], it.pair.split('-')[0]); }
  assert.deepEqual(b.items.map((i) => i.id), b.items.map((_, i) => `item-${String(i + 1).padStart(3, '0')}`));
  assert.deepEqual(bg.build(fixture()).items, b.items); // seeded
});

test('blinding: no prompt holds a pair id, PR number or sha', () => {
  const b = bg.build(fixture());
  for (const [id, p] of Object.entries(b.prompts)) {
    assert.deepEqual(bg.leaks(p, PAIRS), [], id);
    for (const pr of PAIRS) { assert.ok(!p.includes(pr.id)); assert.ok(!p.includes(SHA('a').slice(0, 7))); assert.ok(!new RegExp(`#${pr.introducing.number}\\b|pull/${pr.introducing.number}\\b`).test(p)); }
    assert.ok(!/real|mismatched/i.test(p.replace(/# Rubric[\s\S]*?# BUG/, '')), id);
  }
});

test('blinding test fails when the stripping is removed (temp copy of the script)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-mut-'));
  const src = fs.readFileSync(path.join(__dirname, 'blind-grade.js'), 'utf8').replace(/^const strip = .*$/m, 'const strip = (s) => String(s ?? "");');
  assert.notEqual(src, fs.readFileSync(path.join(__dirname, 'blind-grade.js'), 'utf8'));
  fs.writeFileSync(path.join(dir, 'mut.js'), src.replace("path.join(__dirname, '..', '..', 'src'", `path.join(${JSON.stringify(path.join(__dirname, '..', '..'))}, 'src'`));
  assert.throws(() => require(path.join(dir, 'mut.js')).build(fixture()), /leaks/);
});

test('prompt template holds the README rubric verbatim', () => {
  const readme = fs.readFileSync(path.join(__dirname, 'README.md'), 'utf8').replace(/\r\n/g, '\n');
  const rubric = /## Grading rubric[^\n]*\n\n([\s\S]*?)\n\n## Running/.exec(readme)[1];
  assert.ok(fs.readFileSync(path.join(__dirname, 'blind-grade-prompt.md'), 'utf8').replace(/\r\n/g, '\n').includes(rubric));
});

test('diff cap is the same for every item and says how it is cut', () => {
  const big = Array.from({ length: 5000 }, (_, i) => `+line ${i}`).join('\n');
  const c = bg.cutDiff(big);
  assert.ok(c.text.length <= bg.DIFF_CAP && c.text.endsWith('\n') && /cut to its first/.test(c.note));
  assert.match(bg.cutDiff('+a\n').note, /complete/);
});

test('estimate picks sonnet under $3.50, haiku above', () => {
  const items = [{ id: 'item-001' }];
  assert.equal(bg.estimate({ 'item-001': 'x'.repeat(4000) }, items).model, 'claude-sonnet-5-5');
  assert.equal(bg.estimate({ 'item-001': 'x'.repeat(4e7) }, items).model, 'claude-haiku-5-5');
});

test('parseGrade accepts only the strict shape', () => {
  assert.equal(bg.parseGrade('{"grade":"miss","finding":null,"why":"x"}').grade, 'miss');
  assert.equal(bg.parseGrade('{"grade":"great","finding":null,"why":"x"}'), null);
  assert.equal(bg.parseGrade('nope'), null);
});

test('runAll: retries once then ungradable; stops before a call over the cap', async () => {
  const o = fixture(), b = bg.build(o), ids = b.items.slice(0, 3).map((i) => i.id);
  b.items = b.items.slice(0, 3);
  let n = 0;
  const call = async () => { n++; return { text: n <= 2 ? 'bad' : '{"grade":"direct","finding":1,"why":"y"}', usage: { input_tokens: 1000, output_tokens: 10 } }; };
  const est = { model: 'claude-sonnet-5-5' };
  const r = await bg.runAll({ ...o, budget: 5 }, b, est, { call });
  assert.equal(r.rows[0].grade, 'ungradable'); assert.equal(r.rows[0].tries, 2);
  assert.equal(r.rows[1].grade, 'direct');
  const o2 = fixture(), b2 = bg.build(o2); b2.items = b2.items.slice(0, 3);
  const r2 = await bg.runAll({ ...o2, budget: 0.0001 }, b2, est, { call });
  assert.equal(r2.stopped, ids[0]); assert.equal(r2.rows.length, 0); assert.equal(r2.ungraded.length, 3);
});

test('analyse: perfect separation gives a small p; only pairs with both arms graded count', () => {
  const items = [], rows = [];
  for (let k = 0; k < 12; k++) {
    const repo = k < 6 ? 'o/a' : 'o/b';
    items.push({ id: `r${k}`, arm: 'real', pair: `p${k}`, replay_id: `p${k}`, repo, rep: 1 }, { id: `m${k}`, arm: 'M1', pair: `p${k}`, repo, rep: 1 });
    rows.push({ id: `r${k}`, grade: 'direct' }, { id: `m${k}`, grade: 'miss' });
  }
  rows.pop(); // last mismatched item ungraded
  const s = bg.analyse(items, rows, [{ id: 'p0', rep: 1, new_grade: 'miss' }]), c = s.primary.real_vs_M1;
  assert.equal(c.pairs_used, 11); assert.equal(c.real_catch_rate, 1); assert.equal(c.control_catch_rate, 0);
  assert.ok(c.p_one_sided < 0.001);
  assert.equal(s.primary.real_vs_M2.pairs_used, 0);
  assert.equal(s.audit_agreement.agree, 0);
});

test('M2 keeps X path:line, takes Y text, cycles, and handles empty lists', () => {
  const x = [1, 2, 3].map((n) => ({ where: 'inline', path: `x${n}.js`, line: n, kind: 'missing_test', confidence: 'high', title: `X${n}`, why: null }));
  const y = [{ kind: 'weak_test', confidence: null, title: 'Y1', why: 'w1' }, { kind: 'missing_test', confidence: 'low', title: 'Y2', why: null }];
  const m = bg.swapContent(x, y);
  assert.deepEqual(m.map((f) => [f.path, f.line]), [['x1.js', 1], ['x2.js', 2], ['x3.js', 3]]);
  assert.deepEqual(m.map((f) => f.title), ['Y1', 'Y2', 'Y1']);
  assert.deepEqual(m.map((f) => f.kind), ['weak_test', 'missing_test', 'weak_test']);
  assert.equal(m[0].why, 'w1'); assert.equal(m[1].confidence, 'low');
  assert.deepEqual(bg.swapContent([], y), []);
  const e = bg.swapContent(x, []);
  assert.deepEqual(e.map((f) => [f.path, f.line, f.title, f.kind]), [['x1.js', 1, '', 'none'], ['x2.js', 2, '', 'none'], ['x3.js', 3, '', 'none']]);
});

test('M2 items exist in the pool, carry Y title with X location, and pass the leak check', () => {
  const b = bg.build(fixture()), m2 = b.items.filter((i) => i.arm === 'M2');
  assert.equal(m2.length, 10);
  for (const it of m2) {
    const p = b.prompts[it.id];
    assert.ok(/src\/a\.js:10/.test(p) && p.includes(`Title from [ref]`));
    assert.deepEqual(bg.leaks(p, PAIRS), []);
    assert.equal(typeof it.tell, 'number');
  }
});

test('tell: names an identifier foreign to the diffs', () => {
  assert.deepEqual(bg.tokensOf('Calls `foo_bar` and parseThing() but not plain words'), ['foo_bar', 'parseThing']);
  assert.equal(bg.tells([{ title: 'uses `foo_bar`' }], '+ foo_bar(1)'), 0);
  assert.equal(bg.tells([{ title: 'uses `foo_bar`' }], '+ foo_barx(1)', 'other'), 1);
  assert.equal(bg.tells([{ title: 'no code here' }], ''), 0);
});
