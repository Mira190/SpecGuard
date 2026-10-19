#!/usr/bin/env node
// Scores a SpecGuard scan of the UNMUTATED repo against a mutation manifest (eval/mutation/README.md). Offline.
//   node eval/mutation/score.js --manifest m.json --ctx DIR [--window 5] [--out score.json]
// DIR is the manual run's result artifact: findings.json, summary.md (visible vs low-confidence findings, "Units reviewed X of Y"), usage.json (cost); audit-units.txt only if present.
// Unit = source file. Survivor unit: >=1 survived mutant not marked `uncertain`. Killed-only unit: >=1 killed, 0 survived of any kind. Units whose survivors are all `uncertain` are reported apart.
// invalid/timeout mutants are ignored. A unit SpecGuard did not review counts as a miss for recall and is listed; it is not a false alarm.
const fs = require('node:fs');
const path = require('node:path');

const read = (d, f) => { try { return fs.readFileSync(path.join(d, f), 'utf8'); } catch { return null; } };
const pct = (n, d) => (d ? Math.round((1000 * n) / d) / 10 : null);

// audit-units.txt rows: id <TAB> path <TAB> ... (optional: the result artifact does not carry it)
const unitMap = (txt) => new Map(String(txt || '').split('\n').filter(Boolean).map((l) => l.split('\t')).map(([id, p]) => [id, p]));

// Verdict per unit file from the mutants: { file: { survived, uncertain, killed } }. A survived mutant marked `uncertain` (likely equivalent) is counted apart.
function unitsOf(mutants) {
  const u = {};
  for (const m of mutants) if (m.status === 'survived' || m.status === 'killed') { const r = (u[m.file] = u[m.file] || { survived: 0, uncertain: 0, killed: 0 }); r[m.status === 'killed' ? 'killed' : m.uncertain ? 'uncertain' : 'survived']++; }
  return u;
}

// The unit's source file from a finding: audit-units.txt when given; else a missing_test path is the source file; a weak_test path is a test file, so x.test.ts -> the manifest file x.ts beside it.
function fileOf(f, byId, files) {
  if (byId.has(f.unit)) return byId.get(f.unit);
  if (files.includes(f.path)) return f.path;
  const stem = String(f.path).replace(/\.(test|spec)(\.[A-Za-z]+)$/, '$2').replace(/\.[A-Za-z]+$/, '');
  return files.find((x) => x.replace(/\.[A-Za-z]+$/, '') === stem) || f.path;
}

// summary.md: the "Units reviewed | X of Y" cell, and the text of the "Low-confidence unit findings (N)" section (up to the next bold heading or ##).
function readSummary(summary) {
  const t = String(summary || '');
  const row = /\|\s*Units reviewed\s*\|[^\n]*\n\|[^\n]*\n\|\s*(\d+) of (\d+)\s*\|/.exec(t);
  const low = /\*\*Low-confidence unit findings[^\n]*\*\*([\s\S]*?)(?=\n\*\*[^\n]+\*\*\n|\n#{2,3} |$)/.exec(t);
  return { reviewed: row ? Number(row[1]) : null, of: row ? Number(row[2]) : null, low: low ? low[1] : '' };
}

function score(manifest, findings, units, summary, window = 5, usage = null) {
  const byId = unitMap(units), hasSummary = summary != null, S = readSummary(summary);
  const U = unitsOf(manifest.mutants), files = Object.keys(U);
  const nr = (findings.not_reviewed || []).map(String);
  const mention = (f) => nr.some((s) => s.includes(f));
  // not_reviewed items are free text. When the summary says every unit was reviewed (X of X) a unit named there is a caveat, not a skipped unit; otherwise it counts as not reviewed.
  const allReviewed = S.reviewed != null && S.reviewed === S.of;
  const reviewed = (f) => allReviewed || !mention(f);
  const fs_ = (findings.unit_findings || []).filter((f) => f.kind === 'missing_test' || f.kind === 'weak_test').map((f) => ({ ...f, file: fileOf(f, byId, files), low: hasSummary && S.low.includes(`${f.path}:${f.line}`) }));
  const surv = files.filter((f) => U[f].survived), kon = files.filter((f) => !U[f].survived && !U[f].uncertain && U[f].killed), unc = files.filter((f) => !U[f].survived && U[f].uncertain);
  const flagged = (f, vis) => fs_.some((x) => x.file === f && (!vis || !x.low));
  const rate = (set, vis) => ({ hit: set.filter((f) => reviewed(f) && flagged(f, vis)).length, of: set.length, of_reviewed: set.filter(reviewed).length });
  const withPct = (r) => ({ ...r, pct_of_all: pct(r.hit, r.of), pct_of_reviewed: pct(r.hit, r.of_reviewed) });
  const sm = manifest.mutants.filter((m) => m.status === 'survived' && !m.uncertain && reviewed(m.file));
  const lineHit = sm.filter((m) => fs_.some((x) => x.kind === 'missing_test' && x.file === m.file && Math.abs(x.line - m.line) <= window));
  const cnt = (p) => manifest.mutants.filter(p).length;
  return {
    repo: manifest.repo, sha: manifest.sha,
    mutants: { survived: cnt((m) => m.status === 'survived'), survived_candidate: cnt((m) => m.status === 'survived' && !m.uncertain), survived_uncertain: cnt((m) => m.status === 'survived' && m.uncertain), killed: cnt((m) => m.status === 'killed'), other: cnt((m) => !['survived', 'killed'].includes(m.status)) },
    units: { survivor: surv.length, killed_only: kon.length, uncertain_only: unc.length, summary_units_reviewed: S.reviewed == null ? null : `${S.reviewed} of ${S.of}`, not_reviewed: files.filter((f) => !reviewed(f)), named_in_not_reviewed: files.filter(mention) },
    summary_available: hasSummary,
    survivor_unit_recall_any: withPct(rate(surv, false)),
    survivor_unit_recall_visible: withPct(rate(surv, true)),
    line_hit: { window, hit: lineHit.length, of_reviewed_survivors: sm.length, pct: pct(lineHit.length, sm.length), note: 'missing_test findings only (weak_test cites a test file line); uncertain survivors excluded' },
    false_alarm_any: withPct(rate(kon, false)),
    false_alarm_visible: withPct(rate(kon, true)),
    uncertain_only_units_flagged: { any: unc.filter((f) => reviewed(f) && flagged(f, false)).length, visible: unc.filter((f) => reviewed(f) && flagged(f, true)).length, of: unc.length },
    findings: { total: fs_.length, visible: fs_.filter((x) => !x.low).length, details_only: fs_.filter((x) => x.low).length, outside_manifest: fs_.filter((x) => !U[x.file]).length },
    // base rate: how often ANY reviewed unit gets a finding, to read the survivor and killed-only rates against. all_units counts distinct unit files with a finding over the summary's reviewed count.
    base_rate: (() => { const fl = (vis) => new Set(fs_.filter((x) => !vis || !x.low).map((x) => x.file)); const inM = files.filter(reviewed); return { in_manifest: { of: inM.length, any: inM.filter((f) => fl(false).has(f)).length, visible: inM.filter((f) => fl(true).has(f)).length }, all_units: { of: S.reviewed, any: fl(false).size, visible: fl(true).size } }; })(),
    cost_usd: usage && typeof usage.totalCostUsd === 'number' ? usage.totalCostUsd : null,
  };
}

function main(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i += 2) a[argv[i].replace(/^--/, '')] = argv[i + 1];
  if (!a.manifest || !a.ctx) { console.error('usage: score.js --manifest m.json --ctx DIR [--window 5] [--out score.json]'); return 2; }
  const f = read(a.ctx, 'findings.json');
  if (f == null) { console.error('no findings.json in ctx'); return 2; }
  const r = score(JSON.parse(fs.readFileSync(a.manifest, 'utf8')), JSON.parse(f), read(a.ctx, 'audit-units.txt'), read(a.ctx, 'summary.md'), Number(a.window || 5), JSON.parse(read(a.ctx, 'usage.json') || 'null'));
  const s = JSON.stringify(r, null, 1);
  if (a.out) fs.writeFileSync(a.out, s + '\n'); else console.log(s);
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));
module.exports = { score, unitMap, unitsOf, readSummary };
