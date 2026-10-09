const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const f = require('./field.js');

const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();
function tmpRepo() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'field-'));
  git(d, 'init', '-q');
  for (const [k, v] of [['user.name', 't'], ['user.email', 't@t'], ['core.autocrlf', 'false'], ['commit.gpgsign', 'false']]) git(d, 'config', k, v);
  const commit = (files, msg) => {
    for (const [p, c] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(d, p)), { recursive: true }); fs.writeFileSync(path.join(d, p), c); }
    git(d, 'add', '-A'); git(d, 'commit', '-qm', msg);
    return git(d, 'rev-parse', 'HEAD');
  };
  return { d, commit };
}

test('pickCommits keeps mixed doc+code and code-only commits, skips root, huge and doc-only', () => {
  const log = [
    { sha: 'a', parents: 1, files: ['src/x.js', 'docs/s.md'] },
    { sha: 'b', parents: 1, files: ['src/y.js'] },
    { sha: 'c', parents: 1, files: ['docs/only.md'] },
    { sha: 'd', parents: 1, files: ['package-lock.json'] },
    { sha: 'e', parents: 0, files: ['src/z.js', 'README.md'] },
    { sha: 'f', parents: 1, files: Array.from({ length: 300 }, (_, i) => `v/${i}.js`) },
    { sha: 'g', parents: 1, files: ['a.js', 'b.feature'] },
    { sha: 'h', parents: 1, files: ['q.go'] },
  ];
  const r = f.pickCommits(log, 2);
  assert.deepEqual(r.mixed.map((c) => c.sha), ['a', 'g']);
  assert.deepEqual(r.code.map((c) => c.sha), ['b', 'h']);
  assert.equal(f.pickCommits(log, 1).code.length, 1);
});

test('quantile and aggregate: percentiles, crash/timeouts counted, crashed rows skipped in distributions', () => {
  assert.equal(f.quantile([], 0.5), null);
  assert.equal(f.quantile([1, 2, 3, 4], 0.5), 2.5);
  assert.ok(Math.abs(f.quantile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.95) - 9.55) < 1e-9);
  const rows = [
    { wall_s: 1, s_items: 0, tokens: 100, limitations: [] },
    { wall_s: 3, s_items: 2, tokens: 300, limitations: ['x'] },
    { wall_s: 99, crashed: true, timed_out: true },
  ];
  const a = f.aggregate(rows);
  assert.equal(a.n, 3); assert.equal(a.crashed, 1); assert.equal(a.timedOut, 1); assert.equal(a.with_limitations, 1);
  assert.equal(a.wall_s.p50, 2); assert.equal(a.wall_s.max, 3); assert.equal(a.tokens.p95, 290);
  assert.equal(f.aggregate([]).wall_s.p50, null);
});

test('renderTable escapes pipes and newlines', () => {
  const t = f.renderTable(['a', 'b'], [['x|y', 'l1\nl2'], [1, null]]);
  assert.equal(t, '| a | b |\n| --- | --- |\n| x\\|y | l1 l2 |\n| 1 |  |');
});

test('listCommits + pickCommits on a real temp repo', () => {
  const { d, commit } = tmpRepo();
  commit({ 'src/a.js': '1\n' }, 'root');
  commit({ 'src/a.js': '2\n', 'docs/s.md': 'R1: x\n' }, 'mixed');
  commit({ 'src/a.js': '3\n' }, 'code');
  commit({ 'docs/s.md': 'R1: y\n' }, 'doc');
  const log = f.listCommits(d);
  assert.equal(log.length, 4);
  assert.deepEqual(log[0].files, ['docs/s.md']);
  const p = f.pickCommits(log, 5);
  assert.equal(p.mixed.length, 1);
  assert.equal(p.code.length, 1); // the root commit has no parent
  fs.rmSync(d, { recursive: true, force: true });
});

test('discoverRepo classifies requirement docs and reports file hazards', () => {
  const { d, commit } = tmpRepo();
  commit({
    'docs/spec.md': '# Refunds\r\nR1: Refunds are allowed within 30 days.\r\nR2: The system must send a receipt.\r\n',
    'docs/notes.md': 'Just some prose about the project.\n',
    'docs/bom.md': '﻿R1: Orders must be unique.\nR2: Orders shall be audited.\n',
    'src/a.js': 'x\n',
  }, 'one');
  const r = f.discoverRepo(d, { rev: 'HEAD' });
  assert.equal(r.tracked, 4); assert.equal(r.docs, 3); assert.equal(r.classified, 2);
  assert.deepEqual(r.doc_list.map((x) => x.path).sort(), ['docs/bom.md', 'docs/spec.md']);
  assert.equal(r.shape.crlf, 1); assert.equal(r.shape.bom, 1);
  assert.ok(r.items >= 4);
  fs.rmSync(d, { recursive: true, force: true });
});

test('adjudicate applies the first matching path rule and computes strict/lenient precision', () => {
  const disc = {
    OpenSpec: { doc_list: [
      { path: 'openspec/specs/a/spec.md', items: 5, noise_items: 0 },
      { path: 'openspec/changes/x/design.md', items: 2, noise_items: 1 },
      { path: 'skills/foo/SKILL.md', items: 3, noise_items: 0 },
    ] },
    fastapi: { doc_list: [{ path: 'docs/en/tutorial/cors.md', items: 2 }] },
  };
  const a = f.adjudicate(disc);
  assert.equal(a.per.OpenSpec.TP, 1); assert.equal(a.per.OpenSpec.BORDER, 1); assert.equal(a.per.OpenSpec.FP, 1);
  assert.equal(a.per.OpenSpec.fpItems, 3); assert.equal(a.per.OpenSpec.noiseItems, 1);
  assert.equal(a.total.docs, 4); assert.equal(a.total.strict, 0.25); assert.equal(a.total.lenient, 0.5);
  assert.equal(f.verdictOf('unknown-repo', 'x.md').verdict, 'UNREVIEWED');
});

test('readCtx extracts metrics from a collect context dir', () => {
  const ctx = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-'));
  fs.writeFileSync(path.join(ctx, 'requirements-status.json'), JSON.stringify({ criteria: [{ id: 'S1' }, { id: 'R1' }, { id: 'S2' }], spec: { files: 3, items: 9 } }));
  fs.writeFileSync(path.join(ctx, 'trace-candidates.json'), JSON.stringify({ code_to_requirement: [{ candidates: [1, 2, 3] }, { candidates: [1] }], requirement_to_code: [1], occurrences: [1, 2], limitations: ['l'] }));
  fs.writeFileSync(path.join(ctx, 'requirements-index.md'), 'x'.repeat(400));
  const m = f.readCtx(ctx);
  assert.equal(m.s_items, 2); assert.equal(m.hunks, 2); assert.equal(m.cand_per_hunk_mean, 2); assert.equal(m.cand_per_hunk_max, 3);
  assert.equal(m.occurrences, 2); assert.equal(m.spec_items, 9); assert.deepEqual(m.limitations, ['l']);
  assert.equal(m.index_bytes, 400);
  assert.equal(m.tokens, Math.round((400 + m.cand_bytes) / 4));
  fs.rmSync(ctx, { recursive: true, force: true });
});

test('REPOS: 12 picks, 5+ languages, 4+ with and 4+ without requirement docs', () => {
  assert.equal(f.REPOS.length, 12);
  assert.ok(new Set(f.REPOS.map((r) => r.lang)).size >= 5);
  assert.ok(f.REPOS.filter((r) => r.reqDocs).length >= 4);
  assert.ok(f.REPOS.filter((r) => !r.reqDocs).length >= 4);
});

test('aggregate separates trace timeouts from crashes', () => {
  const a = f.aggregate([
    { wall_s: 62, timed_out: true, trace_timed_out: true, crashed: true, warnings: ['::warning::requirement tracing failed'] },
    { wall_s: 61, timed_out: true, warnings: ['::warning::requirement tracing failed; continuing'] },
    { wall_s: 2, crashed: true, trace_error: 'boom' },
  ]);
  assert.equal(a.crashed, 1); assert.equal(a.trace_timeouts, 2); assert.equal(a.timedOut, 2);
});
