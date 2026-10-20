#!/usr/bin/env node
// Amendment 2 gates for arm O under the "loses changed content" measure, with the per-repo split.
// usage: node summarize2.js <name=rows.json>...   (rows from run-arms.js with ARMS=O)
const fs = require('node:fs');
const sub = (a, b) => a.filter((x) => !b.includes(x));
const repoOf = (name, id) => (name === 'specguard' ? 'specguard' : id.replace(/-[0-9a-f]{12}$/, '').replace(/-(hclean\d+-\d+|\d+)$/, ''));
const out = {};
for (const spec of process.argv.slice(2)) {
  const [name, file] = spec.split('='), rows = JSON.parse(fs.readFileSync(file, 'utf8')).filter((r) => !r.error);
  const split = {}, tot = { n: rows.length, aLost: 0, fixed: 0, oLost: 0, newly: 0, newlyIds: [], g6fine: 0, g6viol: 0, g6Ids: [], dropTotal: 0, dropPRs: 0, dropWhereALost: 0 };
  for (const r of rows) {
    const k = repoOf(name, r.id), s = split[k] || (split[k] = { n: 0, aLost: 0, fixed: 0, newly: 0, g6viol: 0, drops: 0 });
    const A = r.A, O = r.O, nw = sub(O.contentKeys, A.contentKeys).length > 0;
    s.n++;
    if (A.contentLost) { tot.aLost++; s.aLost++; if (!O.contentLost) { tot.fixed++; s.fixed++; } }
    if (O.contentLost) tot.oLost++;
    if (nw) { tot.newly++; s.newly++; tot.newlyIds.push(r.id); }
    if (!A.contentLost) { tot.g6fine++; if (O.gate6.length) { tot.g6viol++; s.g6viol++; tot.g6Ids.push(`${r.id}: ${O.gate6.slice(0, 2).join(',')}`); } }
    tot.dropTotal += O.ruleLostVsA.length; s.drops += O.ruleLostVsA.length;
    if (O.ruleLostVsA.length) tot.dropPRs++;
    if (A.contentLost) tot.dropWhereALost += O.ruleLostVsA.length;
  }
  out[name] = { ...tot, split };
}
console.log(JSON.stringify(out, null, 1));
