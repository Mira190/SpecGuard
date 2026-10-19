#!/usr/bin/env node
// Computes the arms (A = main, O, F, FC, FCH) on one corpus, offline, and writes one JSON row per PR. No model call.
// usage: node run-arms.js <holdout|specguard|fresh> <evidence-dir> <scratch-dir> <out.json> [specguard: <repo-dir> | fresh: <list.txt> <prepared-dir>]
//   holdout   : collector inputs out/r*/_prep/<id>/ctx + head trees from <evidence>/repos (the Windows collector wrote symlinks as plain files; so does the Tree)
//   specguard : <evidence>/c2/pr<N> (the specguard-ctx artifacts) + the PR head from c2-manifest.json in <repo-dir>'s object store (symlinks followed, as on the Linux runner)
//   fresh     : prep-fresh.js output for the frozen list
const fs = require('node:fs');
const path = require('node:path');
const { Tree, measure, rd } = require('./lib.js');
const [mode, ev, scratch, outFile, a1, a2] = process.argv.slice(2);
const cases = [];
if (mode === 'holdout') {
  const seen = new Set();
  for (const r of fs.readdirSync(path.join(ev, 'out')).filter((d) => /^r\d+$/.test(d))) for (const id of fs.readdirSync(path.join(ev, 'out', r, 'run0-A'))) {
    if (seen.has(id) || !fs.existsSync(path.join(ev, 'out', r, 'run0-A', id, 'ctx', 'diff.patch'))) continue;
    seen.add(id);
    const prep = path.join(ev, 'out', r, '_prep', id), repo = path.basename(JSON.parse(rd(path.join(ev, 'holdout2-raw', r.slice(1), `replay-${id}`, 'result.json'))).repo);
    cases.push({ id, clone: path.join(ev, 'repos', repo), head: JSON.parse(rd(path.join(prep, 'meta.json'))).head, ctx: path.join(prep, 'ctx'), follow: false });
  }
} else if (mode === 'specguard') {
  for (const m of JSON.parse(rd(path.join(ev, 'c2-manifest.json')))) if (fs.existsSync(path.join(ev, 'c2', `pr${m.pr}`, 'diff.patch'))) cases.push({ id: `pr${m.pr}`, clone: a1, head: m.sha, ctx: path.join(ev, 'c2', `pr${m.pr}`), follow: true });
} else {
  for (const l of rd(a1).split('\n').filter((x) => x && !x.startsWith('#'))) {
    const [repo, head] = l.split('\t'), dir = path.join(a2, repo, head.slice(0, 12)), meta = rd(path.join(dir, 'meta.json'));
    if (meta && !JSON.parse(meta).skip && fs.existsSync(path.join(dir, 'ctx', 'diff.patch'))) cases.push({ id: `${repo}-${head.slice(0, 12)}`, clone: path.join(ev, 'repos', repo), head, ctx: path.join(dir, 'ctx'), follow: false });
  }
}
cases.sort((x, y) => x.clone.localeCompare(y.clone));
const ARMS = process.env.ARMS ? ['', ...process.env.ARMS.split(',')] : ['', 'O', 'F', 'FC', 'FCH'], rows = [];
let tree = null, cur = null;
for (const c of cases) {
  if (cur !== c.clone) { tree?.destroy(); cur = c.clone; tree = new Tree(c.clone, path.join(scratch, `${mode}-${path.basename(c.clone)}`), c.follow); }
  try {
    tree.moveTo(c.head);
    const a = measure('', c.ctx, tree.dir), row = { id: c.id, A: a };
    for (const arm of ARMS.slice(1)) row[arm] = measure(arm, c.ctx, tree.dir, 250000, a);
    rows.push(row);
    console.log(c.id, `A content-lost ${a.contentLost}`, ARMS.slice(1).map((x) => `${x}:${row[x].lostAny ? row[x].unseen : 0}`).join(' '));
  } catch (e) { rows.push({ id: c.id, error: String(e.message).slice(0, 200) }); console.log(c.id, 'ERROR', e.message.slice(0, 100)); }
}
tree?.destroy();
fs.writeFileSync(outFile, JSON.stringify(rows));
console.log('done', rows.length, 'errors', rows.filter((r) => r.error).length);
