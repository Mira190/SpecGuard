#!/usr/bin/env node
// Noise side of the fast-tier-off design look (no model call): findings re-published by two post.js trees (eval/replay/two-posts.js out dir: <posted>/{main,branch}/run<R>-A/<replay_id>/{posted.json,summary.md}).
//   node eval/replay/testgap-tier.js --pairs holdout2-pairs.json --posted <two-posts out> --runs R1,R2,R3 --repos <clones> --out tier-noise.json
// Tree A = main, tree B = main without the `tier` trigger. Delivered = testgap-score.js derived rule. "test likely exists" = the name-match heuristic of testgap-demotion.js, NOT the audited grade.
const fs = require('node:fs');
const path = require('node:path');
const { parseComment } = require('../grade');
const { summaryItems } = require('../replay');
const { isCandidate } = require('./testgap-score');
const { makeGrep, enclosing, likelyExists } = require('./testgap-demotion');

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i < 0 ? d : process.argv[i + 1]; };
const mean = (a) => a.reduce((s, x) => s + x, 0) / (a.length || 1);
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? (s[(s.length - 1) >> 1] + s[s.length >> 1]) / 2 : null; };
const key = (f) => [f.kind, f.path, f.line, f.title].join('|');

function load(dir) {
  try {
    const po = JSON.parse(fs.readFileSync(path.join(dir, 'posted.json'), 'utf8')), sm = fs.readFileSync(path.join(dir, 'summary.md'), 'utf8');
    return [...po.comments.map(parseComment).filter(Boolean).map((x) => ({ where: 'inline', kind: x.kind, path: x.path, line: x.line, title: x.title, confidence: x.confidence || null })),
      ...summaryItems(sm).map((x) => ({ where: 'summary', kind: x.kind, path: x.path, line: x.line, title: x.title, confidence: x.confidence || null, why: x.why || '' }))];
  } catch { return null; }
}

function main() {
  const pairs = JSON.parse(fs.readFileSync(arg('pairs'), 'utf8')).pairs.filter((p) => p.replay_eligible), runs = arg('runs').split(','), repos = arg('repos'), posted = arg('posted');
  const per = { A: [], B: [] }, extra = [], unusable = [];
  for (const p of pairs) {
    const dir = path.join(repos, p.repo.split('/')[1]), head = p.introducing.head; let grep = null;
    runs.forEach((run, ri) => {
      const fa = load(path.join(posted, 'main', `run${run}-A`, p.replay_id)), fb = load(path.join(posted, 'branch', `run${run}-A`, p.replay_id));
      if (!fa || !fb) { unusable.push(`${p.id}#${ri + 1}`); return; }
      for (const [t, fs_] of [['A', fa], ['B', fb]]) {
        const del = fs_.filter((f) => isCandidate(f, 'derived'));
        per[t].push({ pair: p.id, rep: ri + 1, inline: fs_.filter((f) => f.where === 'inline').length, delivered: del.length, delivered_missing_test: del.filter((f) => f.kind === 'missing_test').length });
      }
      const inA = new Set(fa.filter((f) => isCandidate(f, 'derived')).map(key));
      for (const f of fb.filter((x) => isCandidate(x, 'derived') && !inA.has(key(x)))) {
        grep ||= makeGrep(dir, head);
        const nm = f.kind === 'missing_test' && f.path ? enclosing(dir, head, f.path, f.line) : undefined;
        extra.push({ pair: p.id, rep: ri + 1, kind: f.kind, where: f.where, path: f.path, line: f.line, title: f.title, noise: f.kind === 'missing_test' ? likelyExists(nm, grep) : 'n/a (not missing_test)' });
      }
    });
  }
  const stat = (rows, k) => ({ mean: mean(rows.map((r) => r[k])), median: median(rows.map((r) => r[k])), total: rows.reduce((s, r) => s + r[k], 0) });
  const prLevel = (rows, k) => { const m = {}; for (const r of rows) (m[r.pair] ||= []).push(r[k]); return { mean: mean(Object.values(m).map(mean)), median: median(Object.values(m).map(mean)) }; };
  const out = { note: 'per PR-run (n runs) and per PR (mean of its reps); B-only noise is a name-match heuristic, not the audited grade', unusable,
    runs: per.A.length, prs: new Set(per.A.map((r) => r.pair)).size,
    A: { inline: stat(per.A, 'inline'), delivered_missing_test: stat(per.A, 'delivered_missing_test'), delivered: stat(per.A, 'delivered'), inline_per_pr: prLevel(per.A, 'inline'), missing_test_per_pr: prLevel(per.A, 'delivered_missing_test') },
    B: { inline: stat(per.B, 'inline'), delivered_missing_test: stat(per.B, 'delivered_missing_test'), delivered: stat(per.B, 'delivered'), inline_per_pr: prLevel(per.B, 'inline'), missing_test_per_pr: prLevel(per.B, 'delivered_missing_test') },
    b_not_a: { findings: extra.length, missing_test: extra.filter((e) => e.kind === 'missing_test').length, by_noise: Object.fromEntries(['test likely exists (false gap)', 'no test found', 'unknown', 'n/a (not missing_test)'].map((k) => [k, extra.filter((e) => e.noise === k).length])), rows: extra } };
  const mt = out.b_not_a.missing_test;
  out.b_not_a.share_likely_exists_of_missing_test = mt ? out.b_not_a.by_noise['test likely exists (false gap)'] / mt : null;
  fs.writeFileSync(arg('out'), JSON.stringify(out, null, 1));
  console.log(JSON.stringify({ ...out, b_not_a: { ...out.b_not_a, rows: undefined } }, null, 1));
}
if (require.main === module) main();
