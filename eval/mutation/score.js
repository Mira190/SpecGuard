#!/usr/bin/env node
// Scores a SpecGuard scan of the UNMUTATED repo against a mutation manifest (eval/mutation/README.md). Offline.
//   node eval/mutation/score.js --manifest m.json --ctx DIR [--window 5] [--out score.json]
// DIR is the scan's specguard-ctx artifact: findings.json, audit-units.txt and, to tell visible from Details-only findings, summary.md.
// Unit = source file. Survivor unit: >=1 survived mutant. Killed-only unit: >=1 killed, 0 survived. invalid/timeout mutants are ignored.
// A unit SpecGuard did not review counts as a miss for recall and is reported on its own line; it is not a false alarm.
const fs = require('node:fs');
const path = require('node:path');

const read = (d, f) => { try { return fs.readFileSync(path.join(d, f), 'utf8'); } catch { return null; } };
const pct = (n, d) => (d ? Math.round((1000 * n) / d) / 10 : null);

// audit-units.txt rows: id <TAB> path <TAB> ...
const unitMap = (txt) => new Map(String(txt || '').split('\n').filter(Boolean).map((l) => l.split('\t')).map(([id, p]) => [id, p]));

// Verdict per unit file from the mutants: { file: { survived, killed } }.
function unitsOf(mutants) {
  const u = {};
  for (const m of mutants) if (m.status === 'survived' || m.status === 'killed') (u[m.file] = u[m.file] || { survived: 0, killed: 0 })[m.status]++;
  return u;
}

function score(manifest, findings, units, summary, window = 5) {
  const byId = unitMap(units), paths = new Set(byId.values());
  const lowText = (String(summary || '').split(/Low-confidence unit findings/)[1] || '');
  const hasSummary = summary != null;
  const nr = (findings.not_reviewed || []).map(String);
  const reviewed = (p) => paths.has(p) && ![...byId].some(([id, q]) => q === p && nr.some((s) => s.includes(id) || s.includes(p)));
  const fs_ = (findings.unit_findings || []).filter((f) => f.kind === 'missing_test' || f.kind === 'weak_test').map((f) => ({ ...f, file: byId.get(f.unit), low: hasSummary && (lowText.includes(`${f.path}:${f.line}`) || lowText.includes(`${f.path}#L${f.line}`)) }));
  const U = unitsOf(manifest.mutants), files = Object.keys(U);
  const surv = files.filter((f) => U[f].survived), kon = files.filter((f) => !U[f].survived && U[f].killed);
  const flagged = (f, vis) => fs_.some((x) => x.file === f && (!vis || !x.low));
  const rate = (set, vis) => ({ hit: set.filter((f) => reviewed(f) && flagged(f, vis)).length, of: set.length, of_reviewed: set.filter(reviewed).length });
  const withPct = (r) => ({ ...r, pct_of_all: pct(r.hit, r.of), pct_of_reviewed: pct(r.hit, r.of_reviewed) });
  const sm = manifest.mutants.filter((m) => m.status === 'survived' && reviewed(m.file));
  const lineHit = sm.filter((m) => fs_.some((x) => x.kind === 'missing_test' && x.path === m.file && Math.abs(x.line - m.line) <= window));
  return {
    repo: manifest.repo, sha: manifest.sha, mutants: { survived: manifest.mutants.filter((m) => m.status === 'survived').length, killed: manifest.mutants.filter((m) => m.status === 'killed').length, other: manifest.mutants.filter((m) => !['survived', 'killed'].includes(m.status)).length },
    units: { survivor: surv.length, killed_only: kon.length, reviewed: files.filter(reviewed).length, not_reviewed: files.filter((f) => !reviewed(f)) },
    summary_available: hasSummary,
    survivor_unit_recall_any: withPct(rate(surv, false)),
    survivor_unit_recall_visible: withPct(rate(surv, true)),
    line_hit: { window, hit: lineHit.length, of_reviewed_survivors: sm.length, pct: pct(lineHit.length, sm.length), note: 'missing_test findings only (weak_test cites a test file line)' },
    false_alarm_any: withPct(rate(kon, false)),
    false_alarm_visible: withPct(rate(kon, true)),
    findings: { total: fs_.length, visible: fs_.filter((x) => !x.low).length, details_only: fs_.filter((x) => x.low).length, outside_manifest: fs_.filter((x) => !U[x.file]).length },
  };
}

function main(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i += 2) a[argv[i].replace(/^--/, '')] = argv[i + 1];
  if (!a.manifest || !a.ctx) { console.error('usage: score.js --manifest m.json --ctx DIR [--window 5] [--out score.json]'); return 2; }
  const f = read(a.ctx, 'findings.json');
  if (f == null) { console.error('no findings.json in ctx'); return 2; }
  const r = score(JSON.parse(fs.readFileSync(a.manifest, 'utf8')), JSON.parse(f), read(a.ctx, 'audit-units.txt'), read(a.ctx, 'summary.md'), Number(a.window || 5));
  const s = JSON.stringify(r, null, 1);
  if (a.out) fs.writeFileSync(a.out, s + '\n'); else console.log(s);
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));
module.exports = { score, unitMap, unitsOf };
