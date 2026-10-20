#!/usr/bin/env node
// Faithfulness gate: run main's contextPack (arm A) on the saved collector inputs of holdout 2 and compare with the pack-cut.txt / pack-shown.txt the real run saved.
// usage: node repro.js <evidence-dir> <scratch-dir> <out.json>
const fs = require('node:fs');
const path = require('node:path');
const { Tree, pack, rd, lines } = require('./lib.js');
const [ev, scratch, outFile] = process.argv.slice(2);
const byId = new Map();
for (const r of fs.readdirSync(path.join(ev, 'out')).filter((d) => /^r\d+$/.test(d))) for (const id of fs.readdirSync(path.join(ev, 'out', r, 'run0-A'))) if (!byId.has(id) && fs.existsSync(path.join(ev, 'out', r, 'run0-A', id, 'ctx', 'diff.patch'))) byId.set(id, r);
const rows = [];
for (const [id, r] of [...byId].sort()) {
  const repo = path.basename(JSON.parse(rd(path.join(ev, 'holdout2-raw', r.slice(1), `replay-${id}`, 'result.json'))).repo), prep = path.join(ev, 'out', r, '_prep', id), saved = path.join(ev, 'out', r, 'run0-A', id, 'ctx');
  rows.push({ id, r, repo, head: JSON.parse(rd(path.join(prep, 'meta.json'))).head, ctx: path.join(prep, 'ctx'), saved });
}
rows.sort((a, b) => a.repo.localeCompare(b.repo));
let tree = null, cur = null;
const res = [];
for (const w of rows) {
  if (cur !== w.repo) { tree?.destroy(); cur = w.repo; tree = new Tree(path.join(ev, 'repos', w.repo), path.join(scratch, w.repo)); }
  let row;
  try {
    tree.moveTo(w.head);
    const p = pack('', w.ctx, tree.dir), cut = [...p.notWhole].sort(), sc = lines(path.join(w.saved, 'pack-cut.txt')).map((l) => l.split('\t')[0]).sort();
    const sh = new Map(lines(path.join(w.saved, 'pack-shown.txt')).map((l) => l.split('\t'))), mine = [...p.shown].map(([k, v]) => `${k}\t${v}`).sort(), theirs = [...sh].map(([k, v]) => `${k}\t${v}`).sort();
    row = { id: w.id, cutOk: JSON.stringify(cut) === JSON.stringify(sc), shownOk: JSON.stringify(mine) === JSON.stringify(theirs), cutMine: cut, cutSaved: sc, shownMine: mine, shownSaved: theirs, skipped: tree.skipped || 0 };
  } catch (e) { row = { id: w.id, error: String(e.message).slice(0, 200) }; }
  res.push(row); console.log(row.id, row.error || (row.cutOk && row.shownOk ? 'ok' : `DIFF cut=${row.cutOk} shown=${row.shownOk}`));
}
tree?.destroy();
fs.writeFileSync(outFile, JSON.stringify(res, null, 1));
console.log('ok', res.filter((x) => x.cutOk && x.shownOk).length, '/', res.length);
