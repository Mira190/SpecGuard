#!/usr/bin/env node
// Arm H gates (prereg-pack-fallback.md) from run-arms.js rows with ARMS=O,H, plus the per-repo split.
// usage: node summarize3.js <name=rows.json>...
const fs = require('node:fs');
const sub = (a, b) => a.filter((x) => !b.includes(x));
const repoOf = (name, id) => (name === 'specguard' ? 'specguard' : id.replace(/-[0-9a-f]{12}$/, '').replace(/-(hclean\d+-\d+|\d+)$/, ''));
const out = {};
for (const spec of process.argv.slice(2)) {
  const [name, file] = spec.split('='), rows = JSON.parse(fs.readFileSync(file, 'utf8')).filter((r) => !r.error);
  const t = { n: rows.length, aLost: 0, hFixed: 0, hLost: 0, oFixed: 0, newly: 0, lineViolations: [], noLossPRs: 0, noLossMismatch: [], hEqualsO: 0, aLossHnotO: [], dropTotal: 0, dropPRs: 0, split: {} };
  for (const r of rows) {
    const A = r.A, H = r.H, O = r.O, s = t.split[repoOf(name, r.id)] ||= { n: 0, aLost: 0, hFixed: 0, drops: 0 };
    s.n++;
    if (H.contentLost) t.hLost++;
    if (sub(H.contentKeys, A.contentKeys).length) t.lineViolations.push(r.id); // a line or deleted-line file unseen under H that A showed
    if (A.contentLost) {
      t.aLost++; s.aLost++;
      if (!H.contentLost) { t.hFixed++; s.hFixed++; }
      if (O && !O.contentLost) t.oFixed++;
      if (JSON.stringify(H.cut) !== JSON.stringify(O.cut) || H.bytes !== O.bytes || JSON.stringify(H.contentKeys) !== JSON.stringify(O.contentKeys)) t.aLossHnotO.push(r.id);
    } else {
      t.noLossPRs++;
      if (!H.sameText) t.noLossMismatch.push(r.id);
    }
    t.dropTotal += H.ruleLostVsA.length; s.drops += H.ruleLostVsA.length;
    if (H.ruleLostVsA.length) t.dropPRs++;
  }
  t.newly = t.lineViolations.length;
  out[name] = t;
}
console.log(JSON.stringify(out, null, 1));
