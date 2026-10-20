#!/usr/bin/env node
// Same ctx, two post.js: takes the output of `eval/replay-arms.js --engine mock-replay` (its arm A holds the ctx after the mock engine, pack-cut.txt included) and
// re-runs finishRealOne of two code trees on a fresh copy of each run, so collect/engine variance cannot differ between the arms. No model call.
// usage: node two-posts.js --src DIR --out DIR --main TREE --branch TREE      (TREE = a SpecGuard checkout; src = replay-arms --out dir)
// Prints one JSON object (status flips, new "diff shortened" reasons, headlines turned green, other differences) and writes rows.json to --out.
const fs = require('node:fs');
const path = require('node:path');
const o = require('node:util').parseArgs({ options: { src: { type: 'string' }, out: { type: 'string' }, main: { type: 'string' }, branch: { type: 'string' } } }).values;
if (!o.src || !o.out || !o.main || !o.branch) { console.error('usage: see the header of this file'); process.exit(2); }
const trees = { main: require(path.resolve(o.main, 'eval', 'replay.js')), branch: require(path.resolve(o.branch, 'eval', 'replay.js')) };
const st = (s) => /<!-- specguard:status=(\w+) -->/.exec(s)?.[1] || null, REASON = /Deleted lines of (.*?) not shown \(diff shortened\)/;
// everything that may differ legitimately: the new reason's line, the status/head/counts markers (build hash, timings) and the headline
const strip = (s) => s.replace(/^.*not shown \(diff shortened\).*\n/m, '').replace(/<!-- specguard:[^>]*-->\n?/g, '').replace(/^\*\*.*\n/m, '').replace(/### Not reviewed \(\d+\)/, '').replace(/Incomplete review[^\n]*\n/, '');

(async () => {
  const rows = [];
  for (const run of fs.readdirSync(o.src).filter((d) => /-A$/.test(d))) for (const id of fs.readdirSync(path.join(o.src, run)).filter((d) => fs.existsSync(path.join(o.src, run, d, 'meta.json')))) {
    const res = {};
    for (const arm of ['main', 'branch']) {
      const base = path.join(o.out, arm, run), dir = path.join(base, id);
      fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(base, { recursive: true });
      fs.cpSync(path.join(o.src, run, id), dir, { recursive: true });
      for (const f of ['counts.json', 'summary.md', 'posted.json']) fs.rmSync(path.join(dir, f), { force: true });
      fs.rmSync(path.join(dir, 'ctx', 'counts.json'), { force: true });
      const log = console.log; console.log = () => {};
      try { await trees[arm].finishRealOne(id, base, { engine: 'claude', model: '' }); } finally { console.log = log; }
      res[arm] = fs.readFileSync(path.join(dir, 'summary.md'), 'utf8');
    }
    const m = res.main, b = res.branch, rb = REASON.exec(b);
    rows.push({ run, id, mainStatus: st(m), branchStatus: st(b), newReason: !REASON.test(m) && !!rb, files: rb?.[1] || null, mainGreen: /\*\*✅/.test(m), branchGreen: /\*\*✅/.test(b), otherDiff: strip(m) !== strip(b) });
  }
  fs.writeFileSync(path.join(o.out, 'rows.json'), JSON.stringify(rows, null, 1));
  console.log(JSON.stringify({ compared: rows.length, newReason: rows.filter((r) => r.newReason).length, flips: rows.filter((r) => r.mainStatus !== r.branchStatus).length, turnedGreen: rows.filter((r) => !r.mainGreen && r.branchGreen).length, otherDiff: rows.filter((r) => r.otherDiff).map((r) => r.id) }));
})();
