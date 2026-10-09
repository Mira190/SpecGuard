const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const b = require('./bundle.js');

const comment = (p, line, title, body, kind = 'missing_test') => ({ path: p, line, body: `**${title}**\n\n${body}\n\n<details><summary>Why this was flagged</summary>\n\nkind: ${kind}, confidence: high\n</details>\n\n<!-- specguard:fp=${'a'.repeat(40)} -->` });
const summary = (items, notes = '') => `<!-- specguard:summary -->\n## SpecGuard\n\n<details><summary>${items.length} more item(s): low confidence, inferred, overflow, unanchored</summary>\n\n${items.map((i) => `- **${i.t}** (\`${i.p}:${i.l}\`, ${i.k}, low confidence)\n\n  ${i.b}\n`).join('\n')}\n</details>\n${notes ? `\n<details><summary>Validation notes (1)</summary>\n\n- ${notes}\n</details>\n` : ''}`;

function fixture() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-'));
  const put = (v, id, posted, md, raw) => {
    const dir = path.join(d, 'ab', v, id, 'ctx'); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '..', 'meta.json'), '{}');
    fs.writeFileSync(path.join(dir, '..', 'posted.json'), JSON.stringify({ comments: posted }));
    fs.writeFileSync(path.join(dir, '..', 'summary.md'), md);
    fs.writeFileSync(path.join(dir, 'findings.json'), JSON.stringify({ findings: raw }));
  };
  // bug PR "r-1": v1 and lean report the same finding (lines 10 vs 14); v1 also one far away; v2 gets it in summary only
  put('v1', 'r-1', [comment('a.js', 10, 'Branch untested', 'body one'), comment('a.js', 90, 'Other thing', 'body other')], summary([]), []);
  put('v2', 'r-1', [], summary([{ t: 'Branch is untested', p: 'a.js', l: 12, k: 'missing_test', b: 'body two' }]), []);
  put('lean', 'r-1', [comment('a.js', 14, 'Branch untested again', 'longer body for the same thing')], summary([], 'Dropped findings[0] weak_test b.js Dropped idea: contradicts coverage.'), [{ kind: 'weak_test', path: 'b.js', line: 3, title: 'Dropped idea', body: 'raw body', confidence: 'low' }]);
  // clean PR "c-1"
  put('v1', 'c-1', [], summary([]), []);
  put('v2', 'c-1', [comment('c.js', 5, 'Noise', 'noise body')], summary([]), []);
  put('lean', 'c-1', [], summary([]), []);
  const pairs = path.join(d, 'pairs.json'), clean = path.join(d, 'clean.json');
  fs.writeFileSync(pairs, JSON.stringify({ pairs: [{ replay_id: 'r-1', fix: { number: 99 }, introducing: { pr_title: 'T', pr_body: 'B' }, size_changed_lines: 50, bug_card: { behaviour: 'bh', trigger: 'tr', region: 'rg', test_gap: 'tg' } }] }));
  fs.writeFileSync(clean, JSON.stringify({ clean: [{ id: 'c-1', pr_title: 'CT', pr_body: 'CB', size: 7 }] }));
  return { d, ab: path.join(d, 'ab'), out: path.join(d, 'out'), pairs, clean };
}

test('parsers', () => {
  const [i] = b.parseInline({ comments: [comment('x.js', 3, 'Title', 'Body\n\nmore')] });
  assert.deepEqual([i.kind, i.confidence, i.class, i.path, i.line, i.title, i.body], ['missing_test', 'high', 'inline', 'x.js', 3, 'Title', 'Body\n\nmore']);
  const [s] = b.parseSummary(summary([{ t: 'T', p: 'p/q.js', l: 8, k: 'weak_test', b: 'l1\n  l2' }]));
  assert.deepEqual([s.kind, s.confidence, s.class, s.path, s.line, s.title, s.body], ['weak_test', 'low', 'summary', 'p/q.js', 8, 'T', 'l1\nl2']);
  assert.equal(b.parseDropped('- Dropped findings[0] weak_test b.js Dropped idea: contradicts coverage.', { findings: [{ title: 'Dropped idea', body: 'x', kind: 'weak_test', path: 'b.js', line: 3 }] })[0].line, 3);
});

test('same: conservative', () => {
  const f = (o) => ({ kind: 'missing_test', path: 'a', line: 10, title: 'x', ...o });
  assert.ok(b.same(f({}), f({ line: 16 })));
  assert.ok(!b.same(f({}), f({ line: 17 })));
  assert.ok(!b.same(f({}), f({ kind: 'weak_test' })));
  assert.ok(!b.same(f({}), f({ path: 'b' })));
  assert.ok(b.same(f({ line: 1, title: 'mergeTwoLevels is untested' }), f({ line: 99, title: 'No test for mergeTwoLevels' })));
  assert.ok(!b.same(f({ line: 1, title: 'Branch untested' }), f({ line: 99, title: 'Other branch untested' })));
});

test('build: dedup, anonymity, mapping; join: tables', () => {
  const x = fixture();
  const r = b.build(x.ab, x.out, { pairs: x.pairs, clean: x.clean, seed: 's' });
  assert.deepEqual(r.variants, ['lean', 'v1', 'v2']);
  assert.equal(r.total, 4); // merged 3-way, far one, dropped, clean noise
  assert.deepEqual(r.by, { 1: 3, 2: 0, 3: 1 });
  const bug = JSON.parse(fs.readFileSync(path.join(x.out, 'r-1.json'), 'utf8'));
  assert.equal(bug.bug_fix_pr, 99); assert.equal(bug.bug_card.trigger, 'tr'); assert.equal(bug.size, 50); assert.equal(bug.findings.length, 3);
  const merged = bug.findings.find((f) => f.path === 'a.js' && f.line < 20);
  assert.equal(merged.class, 'inline'); assert.equal(merged.body, 'longer body for the same thing');
  assert.equal(bug.findings.find((f) => f.class === 'dropped').body, 'raw body');
  for (const f of fs.readdirSync(x.out)) if (f[0] !== '_') assert.ok(!/\b(v1|v2|lean)\b|variant/i.test(JSON.stringify(JSON.parse(fs.readFileSync(path.join(x.out, f), 'utf8')).findings)), f);
  const map = JSON.parse(fs.readFileSync(path.join(x.out, '_mapping.json'), 'utf8'));
  assert.deepEqual(map[merged.fid].map((m) => `${m.variant}:${m.class}`), ['lean:inline', 'v1:inline', 'v2:summary']);
  // deterministic
  b.build(x.ab, path.join(x.d, 'out2'), { pairs: x.pairs, clean: x.clean, seed: 's' });
  assert.equal(fs.readFileSync(path.join(x.out, 'r-1.json'), 'utf8'), fs.readFileSync(path.join(x.d, 'out2', 'r-1.json'), 'utf8'));

  const noise = JSON.parse(fs.readFileSync(path.join(x.out, 'c-1.json'), 'utf8')).findings[0];
  const far = bug.findings.find((f) => f.line === 90);
  const vf = path.join(x.d, 'v.json');
  fs.writeFileSync(vf, JSON.stringify({ 'r-1': { [merged.fid]: { verdict: 'hit_direct', useful: 'would_fix' }, [far.fid]: { verdict: 'trivial', useful: 'would_ignore' } }, 'c-1': { [noise.fid]: { verdict: 'wrong', useful: 'annoying' } } }));
  const t = b.join(x.ab, x.out, vf, { pairs: x.pairs, clean: x.clean });
  assert.deepEqual(t.v1.bug.inline, { direct: 1, near: 0, miss: 0 });
  assert.deepEqual(t.v2.bug.inline, { direct: 0, near: 0, miss: 1 });
  assert.deepEqual(t.v2.bug.summary, { direct: 1, near: 0, miss: 0 });
  assert.deepEqual(t.v2.bug.any, { direct: 1, near: 0, miss: 0 });
  assert.equal(t.v1.inline_precision, 0.5); // merged (good) + far (trivial)
  assert.equal(t.lean.dropped, 1);
  assert.equal(t.v2.clean.findings, 1); assert.equal(t.v2.clean.byVerdict.wrong, 1); assert.equal(t.v2.clean.would_fix, 0);
  assert.equal(t.v1.clean.findings, 0);
});

test('join metrics: both vocabularies, zero-finding variant', () => {
  const x = fixture();
  b.build(x.ab, x.out, { pairs: x.pairs, clean: x.clean, seed: 's' });
  const bug = JSON.parse(fs.readFileSync(path.join(x.out, 'r-1.json'), 'utf8'));
  const noise = JSON.parse(fs.readFileSync(path.join(x.out, 'c-1.json'), 'utf8')).findings[0];
  const merged = bug.findings.find((f) => f.path === 'a.js' && f.line < 20);
  const far = bug.findings.find((f) => f.line === 90);
  const dropped = bug.findings.find((f) => f.class === 'dropped');
  const run = (v) => { const vf = path.join(x.d, 'm.json'); fs.writeFileSync(vf, JSON.stringify(v)); return b.join(x.ab, x.out, vf, { pairs: x.pairs, clean: x.clean }); };
  // new vocabulary: hit field + true_gap/wrong/unverifiable verdicts
  const t = run({ [merged.fid]: { verdict: 'true_gap', hit: 'direct', useful: 'would_fix' }, [far.fid]: { verdict: 'unverifiable', useful: 'would_ignore' }, [noise.fid]: { verdict: 'wrong', useful: 'noise' }, [dropped.fid]: { verdict: 'wrong' } });
  assert.deepEqual(t.v1.bug.inline, { direct: 1, near: 0, miss: 0 });
  assert.deepEqual(t.v2.bug.summary, { direct: 1, near: 0, miss: 0 });
  const m1 = t.v1.metrics; // v1: 2 inline on r-1 (merged good, far unverifiable), none on c-1
  assert.equal(m1.false_gap_inline, 0.5); assert.equal(m1.false_gap_all, 0.5);
  assert.equal(m1.inline_per_pr_mean, 1); assert.equal(m1.inline_per_pr_max, 2); assert.equal(m1.summary_per_pr_mean, 0);
  assert.equal(m1.actionable_share, 0.5); assert.equal(m1.noise_share, 0);
  const m2 = t.v2.metrics; // v2: summary on r-1 (true_gap), inline noise on c-1 (wrong)
  assert.equal(m2.false_gap_inline, 1); assert.equal(m2.false_gap_all, 0.5);
  assert.equal(m2.summary_per_pr_mean, 0.5); assert.equal(m2.actionable_share, 0); assert.equal(m2.noise_share, 1);
  // lean: inline merged (good) only; its dropped finding is not counted
  assert.equal(t.lean.metrics.false_gap_all, 0); assert.equal(t.lean.metrics.inline_per_pr_mean, 0.5);
  // legacy vocabulary, and `hit` wins over a legacy verdict
  assert.deepEqual(run({ [merged.fid]: { verdict: 'hit_near', useful: 'would_fix' } }).v1.bug.inline, { direct: 0, near: 1, miss: 0 });
  assert.deepEqual(run({ [merged.fid]: { verdict: 'hit_near', hit: 'direct' } }).v1.bug.inline, { direct: 1, near: 0, miss: 0 });
  // zero-finding variant: no division by zero
  fs.mkdirSync(path.join(x.ab, 'empty', 'r-1'), { recursive: true }); fs.writeFileSync(path.join(x.ab, 'empty', 'r-1', 'meta.json'), '{}');
  const z = run({}).empty.metrics;
  assert.deepEqual([z.false_gap_inline, z.false_gap_all, z.actionable_share, z.noise_share, z.inline_per_pr_max, z.inline_per_pr_mean], [null, null, null, null, 0, 0]);
});
