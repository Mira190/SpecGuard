#!/usr/bin/env node
// Zero-cost diagnosis: why are missing_test findings on the test-gap qualifying pairs demoted to low confidence, and what would delivering them cost in noise? No model call.
//   node eval/replay/testgap-demotion.js --pairs holdout2-pairs.json --raw <holdout2-raw> --runs R1,R2,R3 --audit audit.json --repos <clones> --fixshas fixshas.json \
//     --score <testgap-h2/result.json (filter.list)> --arms <replay-arms --engine mock-replay out dir (run<R>-A/<id>/ctx/pack-cut.txt)> --out result.json --md table.md
// Reuses the filter, B and the catch rule of testgap-score.js. A demoted finding gets ONE reason (priority a..g); `also` lists every reason that matched.
const fs = require('node:fs');
const path = require('node:path');
const { isTest } = require('../szz');
const { enclosingName } = require('../../src/test-map');
const { fileCap, packLimit } = require('../../src/pack-cap');
const { tryGit } = require('./holdout2-null');
const { isCandidate, isLow, pairData } = require('./testgap-score');

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i < 0 ? d : process.argv[i + 1]; };
const REASONS = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
const LABEL = { a: 'candidate test partly visible', b: 'candidate tests not looked up', c: 'a test may already cover this', d: 'reduced review (high confidence + two citations)', e: 'obligation row contradicted', f: 'other', g: 'no note found' };

// ---- pure pieces (tested) ----
// validation-note lines of a summary.md that can demote a finding
const gateNotes = (summary) => String(summary || '').split('\n').filter((l) => /^- (low confidence:|Obligation row contradicted)/.test(l)).map((l) => l.slice(2));
// -> { reason, note, also, file }   (note: the matching raw note, or the quoted `why` for d/f)
function classifyReason(f, notes, why = f.why || '') {
  const mine = notes.filter((n) => n.includes(`${f.kind} ${f.path}`));
  const hit = {};
  const a = mine.find((n) => /a candidate test file was only partly visible/.test(n)); if (a) hit.a = a;
  const b = mine.find((n) => /candidate tests were not looked up/.test(n)); if (b) hit.b = b;
  const c = mine.find((n) => /a test may already cover this/.test(n)); if (c) hit.c = c;
  if (/reduced review/i.test(why)) hit.d = why;
  const e = mine.find((n) => /^Obligation row contradicted/.test(n)); if (e) hit.e = e;
  const other = mine.find((n) => ![a, b, c, e].includes(n));
  const whyOther = why.replace(/reduced review:[^;]*/i, '').replace(/(^|;)\s*low confidence\s*/gi, '').replace(/[;\s]+/g, ' ').trim();
  if (other) hit.f = other; else if (whyOther) hit.f = why;
  const reason = REASONS.find((r) => hit[r]) || 'g';
  return { reason, note: hit[reason] || null, also: REASONS.filter((r) => hit[r]), file: hit.a ? /only partly visible \(([^)]+)\)/.exec(hit.a)[1] : null };
}
// run-level reduced-review triggers from the summary's "Reasons: ..." line (src/post.js reducedReasons)
function triggersOf(summary) {
  const m = /^Reasons: (.*?)(?: \(model:|\. Only)/m.exec(String(summary || ''));
  if (!m) return [];
  const t = [], s = m[1];
  if (/fast-tier model/.test(s)) t.push('tier');
  if (/repair turn|ran out of budget/.test(s)) t.push('repair');
  if (/\d+ engine notes/.test(s)) t.push('notes');
  if (/obligations degraded/.test(s)) t.push('degraded');
  return t;
}
// degraded noise check: a name-match heuristic, NOT the audited grade. names: enclosing definition at the cited line; testFiles: test paths at I's head
function likelyExists(name, grep) { return name ? (grep(name) ? 'test likely exists (false gap)' : 'no test found') : 'unknown'; }

// ---- git helpers ----
function makeGrep(dir, head) {
  const tests = tryGit(dir, 'ls-tree', '-r', '--name-only', head).split('\n').filter((f) => f && isTest(f)), cache = new Map();
  return (nm) => {
    if (!cache.has(nm)) { let hit = false; for (let i = 0; i < tests.length && !hit; i += 200) hit = !!tryGit(dir, 'grep', '-lw', '-F', '-e', nm, head, '--', ...tests.slice(i, i + 200)); cache.set(nm, hit); }
    return cache.get(nm);
  };
}
const enclosing = (dir, head, p, line) => { const t = tryGit(dir, 'show', `${head}:${p}`); return t && line != null ? enclosingName(t.split('\n'), line) : null; };
const rd = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };

function main() {
  const repos = arg('repos'), runIds = arg('runs').split(','), raw = arg('raw'), arms = arg('arms');
  const pairs = JSON.parse(rd(arg('pairs'))).pairs.filter((p) => p.replay_eligible), audit = JSON.parse(rd(arg('audit'))), fixsha = JSON.parse(rd(arg('fixshas')));
  const qual = new Set(JSON.parse(rd(arg('score'))).filter.list.map((x) => x.id)), cap = fileCap(packLimit({}));
  const dirOf = (p) => path.join(repos, p.repo.split('/')[1]);
  const rows = [], runs = [], greps = {};
  for (const p of pairs.filter((q) => qual.has(q.id))) {
    const dir = dirOf(p), head = p.introducing.head, d = pairData(dir, p, fixsha[p.id]), grep = (greps[head] ||= makeGrep(dir, head));
    runIds.forEach((run, ri) => {
      const base = path.join(raw, run, 'replay-' + p.replay_id);
      let r = null; try { r = JSON.parse(rd(path.join(base, 'result.json'))); } catch { /* unusable */ }
      const summary = rd(path.join(base, 'summary.md')) || '', notes = gateNotes(summary), trig = triggersOf(summary);
      const cut = (rd(path.join(arms, `run${run}-A`, p.replay_id, 'pack-cut.txt')) || '').split('\n').filter(Boolean).map((l) => l.split('\t')[0]);
      const shown = Object.fromEntries((rd(path.join(arms, `run${run}-A`, p.replay_id, 'pack-shown.txt')) || '').split('\n').filter(Boolean).map((l) => l.split('\t')));
      const mt = ((r && r.findings) || []).filter((f) => f.kind === 'missing_test' && (f.where === 'inline' || f.where === 'summary'));
      const run1 = { pair: p.id, replay_id: p.replay_id, rep: ri + 1, run, triggers: trig, trigger_key: trig.join('+') || 'none', missing_test: mt.length, delivered: 0, demoted: 0, delivered_catch: 0, demoted_catch: 0, audit_grade: (audit.find((x) => x.id === p.replay_id && x.rep === ri + 1) || {}).new_grade ?? null };
      for (const f of mt) {
        const loc = f.line != null && !!f.path && d.B.has(f.path, f.line);
        if (isCandidate(f, 'derived')) { run1.delivered++; if (loc) run1.delivered_catch++; continue; }
        run1.demoted++; if (loc) run1.demoted_catch++;
        const c = classifyReason(f, notes), row = { pair: p.id, rep: ri + 1, run, where: f.where, path: f.path, line: f.line, title: f.title, why: f.why || '', confidence: f.confidence, ...c, catch: loc, triggers: trig };
        if (c.reason === 'a') {
          const sz = c.file ? +tryGit(dir, 'cat-file', '-s', `${head}:${c.file}`).trim() || null : null, inCut = cut.includes(c.file);
          row.test_file = c.file; row.test_bytes = sz; row.cap = cap; row.in_rebuilt_cut = inCut; row.shown_lines = shown[c.file] ?? null;
          row.pack_cause = sz == null ? 'unknown' : sz > cap ? 'over_cap' : inCut ? 'budget' : 'unknown';
        }
        const nm = enclosing(dir, head, f.path, f.line); row.enclosing = nm; row.noise = likelyExists(nm, grep);
        rows.push(row);
      }
      runs.push(run1);
    });
  }
  // ---- tables ----
  const byReason = {};
  for (const x of REASONS) {
    const rs = rows.filter((r) => r.reason === x), ct = rs.filter((r) => r.catch);
    byReason[x] = { label: LABEL[x], findings: rs.length, catches: ct.length, catch_runs: new Set(ct.map((r) => r.pair + '#' + r.rep)).size, prs: new Set(rs.map((r) => r.pair)).size, catch_prs: new Set(ct.map((r) => r.pair)).size,
      examples: rs.slice(0, 3).map((r) => r.note), also_matching: rs.filter((r) => r.also.length > 1).length };
  }
  const cause = (rs) => ({ over_cap: rs.filter((r) => r.pack_cause === 'over_cap').length, budget: rs.filter((r) => r.pack_cause === 'budget').length, unknown: rs.filter((r) => r.pack_cause === 'unknown').length });
  const a = rows.filter((r) => r.reason === 'a');
  const packCause = { all_a: cause(a), a_catches: cause(a.filter((r) => r.catch)), a_catch_files: a.filter((r) => r.catch).map((r) => ({ pair: r.pair, rep: r.rep, file: r.test_file, bytes: r.test_bytes, cap: r.cap, cause: r.pack_cause, shown_lines: r.shown_lines })),
    size_stats: { bytes: a.map((r) => r.test_bytes).filter((x) => x != null).sort((x, y) => x - y) } };
  const noise = {};
  for (const x of REASONS) { noise[x] = {}; for (const k of ['test likely exists (false gap)', 'no test found', 'unknown']) noise[x][k] = { catch: rows.filter((r) => r.reason === x && r.noise === k && r.catch).length, non_catch: rows.filter((r) => r.reason === x && r.noise === k && !r.catch).length }; }
  const trigRuns = {}; for (const r of runs) { const t = (trigRuns[r.trigger_key] ||= { runs: 0, missing_test: 0, delivered: 0, demoted: 0 }); t.runs++; t.missing_test += r.missing_test; t.delivered += r.delivered; t.demoted += r.demoted; }
  const dTrig = {}; for (const r of rows.filter((x) => x.reason === 'd')) { const k = r.triggers.join('+') || 'none', t = (dTrig[k] ||= { findings: 0, catches: 0 }); t.findings++; if (r.catch) t.catches++; }
  const allTrig = {}; for (const r of rows) { const k = r.triggers.join('+') || 'none', t = (allTrig[k] ||= { demoted_findings: 0, demoted_catches: 0 }); t.demoted_findings++; if (r.catch) t.demoted_catches++; }
  const catchRuns = runs.filter((r) => r.demoted_catch).map((r) => ({ pair: r.pair, rep: r.rep, audit_grade: r.audit_grade, also_delivered_catch: r.delivered_catch > 0, reasons: [...new Set(rows.filter((x) => x.pair === r.pair && x.rep === r.rep && x.catch).map((x) => x.reason))] }));
  const out = { note: 'noise = name-match heuristic (enclosing definition name found as a whole word in a test file at I\'s head), NOT the audited grade; audit_grade is descriptive only', pairs: qual.size, runs: runs.length,
    totals: { missing_test: rows.length + runs.reduce((s, r) => s + r.delivered, 0), delivered: runs.reduce((s, r) => s + r.delivered, 0), demoted: rows.length, demoted_catches: rows.filter((r) => r.catch).length, delivered_catches: runs.reduce((s, r) => s + r.delivered_catch, 0) },
    by_reason: byReason, pack_cause_a: packCause, noise_check: noise, runs_by_trigger: trigRuns, d_by_trigger: dTrig, demoted_by_trigger: allTrig, catch_runs: catchRuns, run_rows: runs, findings: rows };
  fs.writeFileSync(arg('out'), JSON.stringify(out, null, 1));
  fs.writeFileSync(arg('md'), markdown(out));
  console.log(markdown(out));
}

function markdown(o) {
  const L = [`# Test-gap demotion diagnosis (${o.pairs} pairs x 3 runs = ${o.runs} runs; no model calls)`, '',
    `missing_test findings: ${o.totals.missing_test}; delivered ${o.totals.delivered} (${o.totals.delivered_catches} catches); demoted ${o.totals.demoted} (${o.totals.demoted_catches} would be catches by the location rule).`, '',
    '## Reasons (one per demoted finding, priority a..g)', '', '| reason | findings | catches | runs with >=1 catch | distinct PRs | PRs with a catch |', '|---|---|---|---|---|---|'];
  for (const x of REASONS) { const r = o.by_reason[x]; L.push(`| (${x}) ${r.label} | ${r.findings} | ${r.catches} | ${r.catch_runs} | ${r.prs} | ${r.catch_prs} |`); }
  L.push('', '### Raw example notes', '');
  for (const x of REASONS) { L.push(`(${x}) ${LABEL[x]}:`); for (const e of o.by_reason[x].examples) L.push(`- ${e}`); if (!o.by_reason[x].examples.length) L.push('- (none)'); L.push(''); }
  const pc = o.pack_cause_a;
  L.push('## Pack cause of the cut candidate test file, reason (a)', '', '| set | over per-file cap | squeezed by budget | unknown |', '|---|---|---|---|',
    `| all (a) findings | ${pc.all_a.over_cap} | ${pc.all_a.budget} | ${pc.all_a.unknown} |`, `| (a) catches | ${pc.a_catches.over_cap} | ${pc.a_catches.budget} | ${pc.a_catches.unknown} |`, '',
    'Catch test files: ' + (pc.a_catch_files.map((c) => `${c.pair}#${c.rep} ${c.file} ${c.bytes}B (cap ${Math.round(c.cap)}) ${c.cause}`).join('; ') || 'none'), '',
    `(a) test file sizes in bytes (sorted): ${pc.size_stats.bytes.join(', ')}`, '', '## Noise side (name-match heuristic, not the audited grade)', '', '| reason | likely exists: catch / non-catch | no test found: catch / non-catch | unknown: catch / non-catch |', '|---|---|---|---|');
  for (const x of REASONS) { const n = o.noise_check[x], f = (k) => `${n[k].catch} / ${n[k].non_catch}`; L.push(`| (${x}) | ${f('test likely exists (false gap)')} | ${f('no test found')} | ${f('unknown')} |`); }
  L.push('', '## Reduced-review trigger per run', '', '| triggers | runs | missing_test | delivered | demoted |', '|---|---|---|---|---|');
  for (const [k, v] of Object.entries(o.runs_by_trigger)) L.push(`| ${k} | ${v.runs} | ${v.missing_test} | ${v.delivered} | ${v.demoted} |`);
  L.push('', '(d) findings / catches by trigger: ' + (Object.entries(o.d_by_trigger).map(([k, v]) => `${k}: ${v.findings} / ${v.catches}`).join('; ') || 'none'), '', 'Runs with a demoted catch (audited grade, descriptive only):', '');
  for (const c of o.catch_runs) L.push(`- ${c.pair} rep ${c.rep}: audit ${c.audit_grade}; reasons ${c.reasons.join(',')}; also a delivered catch: ${c.also_delivered_catch}`);
  return L.join('\n') + '\n';
}

if (require.main === module) main();
module.exports = { classifyReason, gateNotes, triggersOf, likelyExists, makeGrep, enclosing, REASONS };
