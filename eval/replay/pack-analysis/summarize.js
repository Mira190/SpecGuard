#!/usr/bin/env node
// Gate counts of the pack experiment from run-arms.js rows (and gate 4 from the saved published outputs).
// usage: node summarize.js <name=rows.json>...        e.g. holdout=holdout.json specguard=sg.json fresh=fresh1.json,fresh2.json
//        node summarize.js gate4 <evidence-dir> <holdout-rows.json>
const fs = require('node:fs');
const path = require('node:path');
const { fileCap } = require('../../../src/pack-cap.js');
const ARMS = ['O', 'F', 'FC', 'FCH'], cap = fileCap(250000), BUDGET = 250000;
const load = (spec) => spec.split(',').flatMap((f) => JSON.parse(fs.readFileSync(f, 'utf8')));
const sub = (a, b) => a.filter((x) => !b.includes(x));

if (process.argv[2] === 'gate4') { // kept standards findings of the published arm-A runs whose cited rule file an arm would not have shown
  const [ev, rowsFile] = process.argv.slice(3), rows = new Map(JSON.parse(fs.readFileSync(rowsFile, 'utf8')).map((r) => [r.id, r]));
  const res = Object.fromEntries(ARMS.map((a) => [a, { runs: 0, kept: 0, keptDropped: 0, all: 0, allDropped: 0, hits: [] }]));
  let n = 0;
  for (const r of fs.readdirSync(path.join(ev, 'out')).filter((d) => /^r\d+$/.test(d))) for (const id of fs.readdirSync(path.join(ev, 'out', r, 'run0-A'))) {
    const dir = path.join(ev, 'out', r, 'run0-A', id), row = rows.get(id);
    if (!row || row.error || !fs.existsSync(path.join(dir, 'ctx', 'findings.json'))) continue;
    n++;
    let f; try { f = JSON.parse(fs.readFileSync(path.join(dir, 'ctx', 'findings.json'), 'utf8')); } catch { continue; }
    const published = ['posted.json', 'visible.md', 'summary.md'].map((x) => { try { return fs.readFileSync(path.join(dir, x), 'utf8'); } catch { return ''; } }).join('\n');
    for (const x of (f.findings || []).filter((y) => y.kind === 'standard' && y.rule_source)) {
      const rule = x.rule_source.replace(/:\d+(-\d+)?$/, ''), kept = published.includes(x.title) || published.includes(x.rule_source);
      for (const a of ARMS) {
        const s = res[a], drop = !row[a].ruleShown.includes(rule) && row.A.ruleShown.includes(rule);
        s.all++; if (drop) s.allDropped++;
        if (kept) { s.kept++; if (drop) { s.keptDropped++; s.hits.push(`${r}/${id}: ${x.rule_source}`); } }
      }
    }
  }
  console.log(JSON.stringify({ runsWithFindings: n, ...Object.fromEntries(ARMS.map((a) => [a, res[a]])) }, null, 1));
  process.exit(0);
}

const out = {};
for (const spec of process.argv.slice(2)) {
  const [name, files] = spec.split('='), all = load(files), rows = all.filter((r) => !r.error);
  const o = out[name] = { n: rows.length, errors: all.length - rows.length, A: {}, arms: {} };
  const A = (r) => r.A;
  o.A = { lostAny: rows.filter((r) => A(r).lostAny).length, lostSrcOrConfig: rows.filter((r) => A(r).lostSrc).length, lostCode: rows.filter((r) => A(r).lostCode).length, unseen: rows.reduce((n, r) => n + A(r).unseen, 0),
    bigFile: rows.filter((r) => A(r).maxFile > BUDGET / 2).length, reviewHalf: rows.filter((r) => A(r).reviewBytes > BUDGET / 2).length, ruleEmpty: rows.filter((r) => A(r).ruleEmptyButInScope).length, ruleBytes: rows.reduce((n, r) => n + A(r).ruleBytes, 0), cutTests: rows.reduce((n, r) => n + A(r).cutTests.length, 0), notice: rows.filter((r) => A(r).notice).length };
  for (const a of ARMS) {
    const X = (r) => r[a], lostA = rows.filter((r) => A(r).lostAny), fine = rows.filter((r) => !A(r).lostAny);
    const std = rows.filter((r) => r.A.ruleBytes <= cap && r.A.inScope === r.A.rules); // rule files fit one cap and all shown (scope check below)
    o.arms[a] = {
      lostAny: rows.filter((r) => X(r).lostAny).length, lostSrcOrConfig: rows.filter((r) => X(r).lostSrc).length, lostCode: rows.filter((r) => X(r).lostCode).length, unseen: rows.reduce((n, r) => n + X(r).unseen, 0),
      newlyLost: rows.filter((r) => sub(X(r).unseenKeys, A(r).unseenKeys).length).length, newlyLostIds: rows.filter((r) => sub(X(r).unseenKeys, A(r).unseenKeys).length).map((r) => r.id),
      fixedOfLostAny: `${lostA.filter((r) => !X(r).lostAny).length}/${lostA.length}`, fixedOfLostSrc: `${rows.filter((r) => A(r).lostSrc && !X(r).lostSrc).length}/${rows.filter((r) => A(r).lostSrc).length}`,
      gate6: `${fine.filter((r) => X(r).gate6.length).length}/${fine.length}`, gate6Ids: fine.filter((r) => X(r).gate6.length).map((r) => `${r.id}: ${X(r).gate6.slice(0, 3).join(',')}`),
      identical: `${std.filter((r) => X(r).sameText).length}/${std.length}`, identicalIds: std.filter((r) => !X(r).sameText).map((r) => r.id),
      ruleDroppedTotal: rows.reduce((n, r) => n + X(r).ruleLostVsA.length, 0), ruleDroppedPRs: rows.filter((r) => X(r).ruleLostVsA.length).length, ruleDroppedPRsWhereALost: rows.filter((r) => A(r).lostAny && X(r).ruleLostVsA.length).length,
      ruleDroppedWhereALost: rows.filter((r) => A(r).lostAny).reduce((n, r) => n + X(r).ruleLostVsA.length, 0), ruleBytes: rows.reduce((n, r) => n + X(r).ruleBytes, 0),
      bigFile: rows.filter((r) => X(r).maxFile > BUDGET / 2).length, reviewHalf: rows.filter((r) => X(r).reviewBytes > BUDGET / 2).length, ruleEmpty: rows.filter((r) => X(r).ruleEmptyButInScope).length,
      cutTestsGrow: rows.filter((r) => X(r).cutTests.length > A(r).cutTests.length).length, cutTestsShrink: rows.filter((r) => X(r).cutTests.length < A(r).cutTests.length).length, cutTestsTotal: rows.reduce((n, r) => n + X(r).cutTests.length, 0),
      noticeOnToOff: rows.filter((r) => A(r).notice && !X(r).notice).length, noticeOffToOn: rows.filter((r) => !A(r).notice && X(r).notice).length,
    };
  }
}
console.log(JSON.stringify(out, null, 1));
