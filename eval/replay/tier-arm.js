#!/usr/bin/env node
// Haiku fast-tier reduced review ON vs OFF, same ctx, same post.js. No model call. Arm A = the saved ctx of a `replay-arms.js --engine mock-replay` run (engine-model.json as is,
// tier 'fast'); arm B = a COPY of that ctx with engine-model.json `tier` rewritten to 'normal'. Both go through finishRealOne of THIS tree; nothing else differs.
// usage: node tier-arm.js --src DIR --raw DIR --repos DIR --blind DIR --out DIR --work DIR [--bug run1,run2,run3]
//   --src  replay-arms output (<src>/r<run>/run0-A/<id>/{meta.json,ctx}); --raw holdout2-raw (<run>/replay-<id>/result.json: saved findings, validity); --repos clones (read-only, 'clone --shared');
//   --blind blind-h2 (items.json, results/item-*.json, regrade-ungradable.json); --out gets rows.jsonl (resumable), result.json, table.md; --work is scratch (one shared checkout at a time, deleted).
// Reduced reasons are read from the posted summary ("Reasons: a; b (model: ...)" in Details), NOT from reducedReasons(): its `data.degraded` exists only inside post.run().
// Delivered = the finding is an inline comment (blind-h2 catch-delivery.json "delivered inline"); direct = blind-h2 grade 'direct'. A moved finding's label comes from the blind grade of
// that (PR, rep) item: its graded finding index -> raw findings[idx-1] -> matched by kind|path|line|title; an item with a catch but no recorded index is 'ungraded'.
// Serial on purpose (memory/disk): one post.js at a time, the checkout of a PR is removed after its runs.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const o = require('node:util').parseArgs({ options: { src: { type: 'string' }, raw: { type: 'string' }, repos: { type: 'string' }, blind: { type: 'string' }, out: { type: 'string' }, work: { type: 'string' }, bug: { type: 'string', default: '39120706885,39120718089,39120729276' } } }).values;
if (!o.src || !o.raw || !o.repos || !o.blind || !o.out || !o.work) { console.error('usage: see the header of this file'); process.exit(2); }
const { finishRealOne, summaryItems } = require('../replay.js');
const { parseComment } = require('../grade.js');
const readJson = (p, d = null) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return d; } };
const key = (f) => [f.kind, f.path, f.line, f.title].join('|');
const bugRuns = o.bug.split(',');
const REASON_ID = [[/^fast-tier model$/, 'tier'], [/^the JSON (needed a repair|repair turn failed)|^the engine ran out of budget/, 'repair'], [/^\d+ engine notes$/, 'notes'], [/^\d+ of \d+ obligations degraded/, 'degraded']];
const reasonsOf = (summary) => { const m = /Reasons: (.*?) \(model: /.exec(summary); return m ? m[1].split('; ').map((t) => (REASON_ID.find(([re]) => re.test(t)) || [0, `?${t}`])[1]) : []; };

// the posted result of one arm: inline findings and summary-side findings (any other place in the summary), reasons, status
function harvest(dir) {
  const posted = readJson(path.join(dir, 'posted.json'), { comments: [] }), summary = fs.readFileSync(path.join(dir, 'summary.md'), 'utf8');
  const inline = posted.comments.map(parseComment).filter(Boolean).map((f) => ({ kind: f.kind, path: f.path, line: f.line, title: f.title, confidence: f.confidence }));
  const sum = summaryItems(summary).map((x) => ({ kind: x.kind, path: x.path, line: x.line, title: x.title, why: x.why }));
  return { inline, summary: sum, reasons: reasonsOf(summary), status: /<!-- specguard:status=(\w+) -->/.exec(summary)?.[1] || null };
}

async function arm(srcDir, work, name, id, repoCopy, tier) {
  const dir = path.join(work, name, id);
  fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(path.dirname(dir), { recursive: true });
  fs.cpSync(srcDir, dir, { recursive: true });
  for (const f of ['counts.json', 'summary.md', 'posted.json', 'row.json', 'visible.md']) fs.rmSync(path.join(dir, f), { force: true });
  fs.rmSync(path.join(dir, 'ctx', 'counts.json'), { force: true });
  const meta = readJson(path.join(dir, 'meta.json')); fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ ...meta, repo: repoCopy, ctx: path.join(dir, 'ctx') }));
  if (tier) { const f = path.join(dir, 'ctx', 'engine-model.json'), em = readJson(f, {}); fs.writeFileSync(f, JSON.stringify({ ...em, tier })); }
  const log = console.log; console.log = () => {};
  try { await finishRealOne(id, path.join(work, name), { engine: 'claude', model: 'claude-haiku-5-5' }); } finally { console.log = log; }
  const h = harvest(dir); fs.rmSync(dir, { recursive: true, force: true });
  return h;
}

async function main() {
  fs.mkdirSync(o.out, { recursive: true }); fs.mkdirSync(o.work, { recursive: true });
  const rowsFile = path.join(o.out, 'rows.jsonl'), done = new Map((fs.existsSync(rowsFile) ? fs.readFileSync(rowsFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []).map((r) => [`${r.run}/${r.id}`, r]));
  const byId = new Map();
  for (const d of fs.readdirSync(o.src).filter((x) => /^r\d+$/.test(x))) for (const id of fs.readdirSync(path.join(o.src, d, 'run0-A'))) (byId.get(id) || byId.set(id, []).get(id)).push(d.slice(1));
  for (const [id, runs] of [...byId].sort()) {
    const todo = runs.filter((r) => !done.has(`${r}/${id}`));
    if (!todo.length) continue;
    let repoCopy = null;
    for (const run of todo.sort()) {
      const srcDir = path.join(o.src, `r${run}`, 'run0-A', id), res = readJson(path.join(o.raw, run, `replay-${id}`, 'result.json'), {}), row = { run, id, bug: bugRuns.includes(run) };
      try {
        if (res.valid === false || res.invalid_reason) throw new Error(`invalid replay: ${res.invalid_reason}`);
        if (!fs.existsSync(path.join(srcDir, 'ctx', 'findings.json'))) throw new Error('no ctx/findings.json');
        if (!repoCopy) { // one shared checkout at head for every run of this PR
          const meta = readJson(path.join(srcDir, 'meta.json')), clone = path.join(o.repos, path.basename(res.repo || ''));
          repoCopy = path.join(o.work, '_repo', id); fs.rmSync(repoCopy, { recursive: true, force: true });
          for (const a of [['clone', '-q', '--shared', '--no-checkout', clone, repoCopy], ['-C', repoCopy, 'checkout', '-q', '--detach', meta.head]]) execFileSync('git', ['-c', 'core.longpaths=true', ...a], { stdio: 'pipe' });
        }
        row.tierA = readJson(path.join(srcDir, 'ctx', 'engine-model.json'), {}).tier || null;
        row.A = await arm(srcDir, o.work, 'A', id, repoCopy, null);
        if (row.A.status === 'failed') throw new Error('publisher failed in A (post.js rejected the saved answer): not a measurement'); // never reaches reducedReasons
        row.B = await arm(srcDir, o.work, 'B', id, repoCopy, 'normal');
        row.raw = (res.findings || []).map((f) => ({ where: f.where, kind: f.kind, path: f.path, line: f.line, title: f.title }));
      } catch (e) { row.unusable = String(e.message || e).split('\n')[0]; }
      fs.appendFileSync(rowsFile, JSON.stringify(row) + '\n'); done.set(`${run}/${id}`, row);
    }
    fs.rmSync(repoCopy || path.join(o.work, '_repo', id), { recursive: true, force: true });
  }
  report([...done.values()]);
}

const q = (a, p) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.max(0, Math.ceil(p * s.length) - 1)]; }; // nearest rank
const dist = (a) => ({ n: a.length, median: q(a, 0.5), p90: q(a, 0.9), max: a.length ? Math.max(...a) : null });

function report(all) {
  const rows = all.filter((r) => !r.unusable), unusable = all.filter((r) => r.unusable).map(({ run, id, unusable: u }) => ({ run, id, reason: u }));
  // blind-h2 grade per (replay id, rep): rep k = the k-th run of the bug set
  const items = readJson(path.join(o.blind, 'items.json')).items.filter((i) => i.arm === 'real'), reg = new Map((readJson(path.join(o.blind, 'regrade-ungradable.json'), { rows: [] }).rows).map((r) => [r.id, r.again]));
  const grade = new Map(items.map((i) => { const r = readJson(path.join(o.blind, 'results', `${i.id}.json`), {}); return [`${i.replay_id}#${bugRuns[i.rep - 1]}`, { item: i.id, grade: r.grade === 'ungradable' ? reg.get(i.id) || 'ungradable' : r.grade, finding: Number.isInteger(r.finding) ? r.finding : null }]; }));
  const checks = { rowsChecked: rows.length, reasonViolations: [], tierMismatch: [], rawMismatchA: 0 }, nonTier = [], out = { bug: null, clean: null };
  const moved = { bug: { toInline: [], toSummary: [] }, clean: { toInline: [], toSummary: [] } }, labels = { 'real direct': 0, 'real indirect': 0, miss: 0, ungraded: 0 }, deliveredDirect = { A: [], B: [] }, deliveredDirectUnindexed = [];
  for (const r of rows) {
    const set = r.bug ? 'bug' : 'clean', ra = r.A.reasons, rb = r.B.reasons, want = ra.filter((x) => x !== 'tier');
    if (JSON.stringify(rb) !== JSON.stringify(want) || (r.tierA === 'fast') !== ra.includes('tier') || ra.some((x) => x.startsWith('?'))) checks.reasonViolations.push({ run: r.run, id: r.id, tierA: r.tierA, A: ra, B: rb });
    if (want.length) nonTier.push({ run: r.run, id: r.id, set, reasons: want });
    const inA = new Set(r.A.inline.map(key)), inB = new Set(r.B.inline.map(key));
    if ([...r.raw.filter((f) => f.where === 'inline').map(key)].sort().join() !== [...inA].sort().join()) checks.rawMismatchA++;
    const g = r.bug ? grade.get(`${r.id}#${r.run}`) : null;
    for (const f of r.B.inline) if (!inA.has(key(f))) {
      const m = { run: r.run, id: r.id, kind: f.kind, path: f.path, line: f.line, title: f.title }; moved[set].toInline.push(m);
      if (r.bug) {
        const gf = g?.finding ? r.raw[g.finding - 1] : null;
        m.label = !g || g.grade === 'ungradable' ? 'ungraded' : g.grade === 'miss' ? 'miss' : !gf ? 'ungraded' : key(gf) === key(f) ? `real ${g.grade}` : 'miss';
        labels[m.label]++;
      }
    }
    for (const f of r.A.inline) if (!inB.has(key(f))) moved[set].toSummary.push({ run: r.run, id: r.id, kind: f.kind, path: f.path, line: f.line, title: f.title });
    if (r.bug && g && g.grade === 'direct') {
      const gf = g.finding ? r.raw[g.finding - 1] : null;
      if (!gf) deliveredDirectUnindexed.push({ run: r.run, id: r.id, item: g.item });
      else { if (inA.has(key(gf))) deliveredDirect.A.push({ run: r.run, id: r.id, item: g.item }); if (inB.has(key(gf))) deliveredDirect.B.push({ run: r.run, id: r.id, item: g.item }); }
    }
  }
  for (const set of ['bug', 'clean']) {
    const rs = rows.filter((r) => (set === 'bug') === r.bug);
    out[set] = { prRuns: rs.length, reducedA: rs.filter((r) => r.A.reasons.length).length, reducedOnlyByTier: rs.filter((r) => r.A.reasons.length && r.A.reasons.every((x) => x === 'tier')).length, nonTierReason: rs.filter((r) => r.A.reasons.some((x) => x !== 'tier')).length,
      reducedB: rs.filter((r) => r.B.reasons.length).length, movedToInline: moved[set].toInline.length, movedToSummary: moved[set].toSummary.length, inlineA: dist(rs.map((r) => r.A.inline.length)), inlineB: dist(rs.map((r) => r.B.inline.length)),
      statusFlips: rs.filter((r) => r.A.status !== r.B.status).length };
  }
  const dd = { A: deliveredDirect.A.length, B: deliveredDirect.B.length, ARuns: new Set(deliveredDirect.A.map((x) => x.id)).size, BRuns: new Set(deliveredDirect.B.map((x) => x.id)).size, unindexedDirectItems: deliveredDirectUnindexed.length };
  const reading = !(dd.B < dd.A) && out.clean.inlineB.median <= 2 ? 'DELETE the tier reason (delivered-direct did not fall and clean median inline <= 2)' : `KEEP the tier reason (${dd.B < dd.A ? `delivered-direct fell ${dd.A} -> ${dd.B}` : 'delivered-direct did not fall'}; clean median inline under B = ${out.clean.inlineB.median}, limit 2)`;
  const result = { checks, summary: out, movedLabels: labels, deliveredDirect: dd, deliveredDirectDetail: deliveredDirect, deliveredDirectUnindexed, nonTierRuns: nonTier, unusable, moved, reading };
  fs.writeFileSync(path.join(o.out, 'result.json'), JSON.stringify(result, null, 1));
  const d = (x) => `${x.median} / ${x.p90} / ${x.max}`;
  const md = [`# Fast-tier reduced review on vs off (holdout 2, offline)`, '', `PR-runs scored: ${rows.length} (bug ${out.bug.prRuns}, clean ${out.clean.prRuns}); unusable: ${unusable.length}`, '',
    '| | bug runs | clean runs |', '|---|---|---|',
    `| A reduced at all | ${out.bug.reducedA} | ${out.clean.reducedA} |`, `| A reduced only by tier | ${out.bug.reducedOnlyByTier} | ${out.clean.reducedOnlyByTier} |`, `| A with a non-tier reason (cannot move) | ${out.bug.nonTierReason} | ${out.clean.nonTierReason} |`, `| B still reduced | ${out.bug.reducedB} | ${out.clean.reducedB} |`,
    `| findings moved summary -> inline (A -> B) | ${out.bug.movedToInline} | ${out.clean.movedToInline} |`, `| findings moved inline -> summary | ${out.bug.movedToSummary} | ${out.clean.movedToSummary} |`,
    `| inline per PR-run A: median / p90 / max | ${d(out.bug.inlineA)} | ${d(out.clean.inlineA)} |`, `| inline per PR-run B: median / p90 / max | ${d(out.bug.inlineB)} | ${d(out.clean.inlineB)} |`, `| status flips A -> B | ${out.bug.statusFlips} | ${out.clean.statusFlips} |`, '',
    `Moved findings on bug PRs by blind-h2 label: real direct ${labels['real direct']}, real indirect ${labels['real indirect']}, miss ${labels.miss}, ungraded ${labels.ungraded}`, '',
    `Delivered-direct catches (graded direct, the graded finding is an inline comment): A ${dd.A} (${dd.ARuns} PRs), B ${dd.B} (${dd.BRuns} PRs); direct items with no recorded finding index (cannot be placed): ${dd.unindexedDirectItems}`, '',
    `Checks: reason violations ${checks.reasonViolations.length}, A-inline vs saved raw findings mismatching runs ${checks.rawMismatchA} of ${rows.length}`, '', `Reading: ${reading}`, ''].join('\n');
  fs.writeFileSync(path.join(o.out, 'table.md'), md); console.log(md);
  if (checks.reasonViolations.length) { console.error('REASON VIOLATIONS', JSON.stringify(checks.reasonViolations.slice(0, 5))); process.exit(3); }
}

main().catch((e) => { console.error(e); process.exit(1); });
