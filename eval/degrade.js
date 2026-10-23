#!/usr/bin/env node
// Weak-model degradation simulator. Takes a known-good findings.json, applies the output defects a weaker model produces
// (cosmetic ones, and ones that really make the output unusable), and pushes each through extract-json -> post.validate ->
// the real post.run against a fake GitHub. It measures how much of the true review survives: findings delivered, coverage rows
// that still verify, new findings that were not in the baseline. A cosmetic defect must never cost the review; an unusable
// output must still fail (the repair turn's trigger). Facts stay decided by the deterministic verifier: nothing here loosens it.
//
//   node eval/degrade.js [--pilot CTX_DIR] [--json]
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { extract } = require('../src/extract-json.js');
const post = require('../src/post.js');
const { fakeGithub } = require('./local.js');
const { parseComment, parseSummary } = require('./grade.js');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(p, 'utf8');
const J = (d, n) => JSON.stringify(d, null, n);
const clone = (d) => JSON.parse(J(d));

// ---- fixtures: { name, ctx: { file: text }, files: { path: text } } ----
const diffPaths = (diff) => [...post.parseDiff(diff).keys()];

function fromCase(name) {
  const dir = path.join(ROOT, 'src', 'fixtures', name), head = path.join(ROOT, 'eval', 'cases', name, 'head');
  const ctx = {};
  for (const f of ['diff.patch', 'findings.json', 'requirements-status.json']) ctx[f] = read(path.join(dir, f));
  const good = JSON.parse(ctx['findings.json']); // recorded before the alignment contract: the known-good baseline states it
  for (const c of good.coverage) c.alignment ??= { status: 'unknown', reason: 'Fixture recorded before the alignment contract.' };
  ctx['findings.json'] = J(good);
  ctx['files.txt'] = `${diffPaths(ctx['diff.patch']).join('\n')}\n`;
  const files = {};
  (function walk(d, rel) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(path.join(d, e.name), `${rel}/${e.name}`);
      else files[`${rel}/${e.name}`] = read(path.join(d, e.name));
    }
  })(head, `eval-sandbox/${name}`);
  return { name, ctx, files };
}

// A real run's ctx directory (e.g. a pilot artifact). Its checkout is not available, so rebuild the files the findings cite:
// the head side of every diff hunk, then each cited quote at its cited line, unique filler elsewhere.
function fromCtxDir(dir, name = path.basename(dir)) {
  const ctx = {};
  for (const f of fs.readdirSync(dir)) if (fs.statSync(path.join(dir, f)).isFile()) ctx[f] = read(path.join(dir, f));
  const lines = {};
  for (const chunk of ctx['diff.patch'].split(/^diff --git /m).slice(1)) {
    const p = /^\+\+\+ b\/(.+?)\t?$/m.exec(chunk)?.[1];
    if (!p) continue;
    const L = (lines[p] ||= {});
    let r = 0;
    for (const ln of chunk.slice(chunk.search(/^@@ /m)).split(/\r?\n/)) {
      const h = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(ln);
      if (h) { r = +h[1]; continue; }
      if (ln[0] === '+' || ln[0] === ' ') L[r++] = ln.slice(1);
    }
  }
  const d = JSON.parse(ctx['findings.json']);
  for (const c of citations(d)) if (c && c.path && c.line && c.quote && !/\n/.test(c.quote)) { const L = (lines[c.path] ||= {}); L[c.line] ??= c.quote; }
  const files = {};
  for (const [p, L] of Object.entries(lines)) {
    const n = Math.max(...Object.keys(L).map(Number));
    files[p] = `${Array.from({ length: n }, (_, i) => L[i + 1] ?? `// filler line ${i + 1} of ${p}`).join('\n')}\n`;
  }
  return { name, ctx, files };
}

// Every {path, line, quote} object in a findings document.
function citations(d) {
  return [...(d.coverage || []).flatMap((c) => [c.behaviour, c.change, ...(c.evidence || [])]), ...(d.findings || [])].filter((x) => x && typeof x === 'object');
}

// ---- mutations: each returns the text a weak model would have printed ----
const every = (d, f) => citations(d).forEach(f);
const cap = (s) => (typeof s === 'string' ? s.split('_').map((w) => w[0].toUpperCase() + w.slice(1)).join('_') : s);
const shiftBy = (lo, hi) => (d) => { let k = 0; every(d, (c) => { if (Number.isInteger(c.line)) { const m = lo + (k % (hi - lo + 1)); c.line = Math.max(1, c.line + (k++ % 2 ? m : -m)); } }); return d; };
// Cuts a quote to its first 70% (at least 30 non-space characters kept); quotes under 40 non-space characters stay whole.
const trim = (suffix) => (d) => {
  every(d, (c) => {
    const q = c.quote;
    if (typeof q !== 'string' || q.replace(/\s/g, '').length < 40) return;
    let n = 0, i = 0;
    for (; i < q.length && n < 30; i++) if (/\S/.test(q[i])) n++;
    c.quote = q.slice(0, Math.max(Math.floor(q.length * 0.7), i)).trimEnd() + suffix;
  });
  return d;
};
const lateRows = (d, f) => (d.coverage || []).forEach((c, i) => { if (i >= Math.floor(d.coverage.length / 2)) f(c); });
const enumCase = (d) => {
  for (const c of d.coverage || []) { c.status = cap(c.status); if (c.alignment?.status) c.alignment.status = cap(c.alignment.status); for (const e of c.evidence || []) { e.layer = cap(e.layer); e.kind = cap(e.kind); } }
  for (const f of d.findings || []) { f.kind = cap(f.kind); f.confidence = cap(f.confidence); }
  return d;
};
const enumSpace = (d) => {
  for (const c of d.coverage || []) c.status = String(c.status).replace(/_/g, String(c.id).length % 2 ? ' ' : '-');
  for (const f of d.findings || []) f.kind = String(f.kind).replace(/_/g, '-');
  return d;
};
const strNums = (d) => { every(d, (c) => { for (const k of ['line', 'start_line']) if (c[k] !== undefined) c[k] = String(c[k]); }); return d; };
const obj = (f) => (d) => J(f(d));

// expect: 'ok' = usable, nothing lost; 'soft' = usable, may lose what the verifier cannot verify; 'reject' = unusable, must route to the repair turn.
const MUTATIONS = [
  { id: 'baseline', expect: 'ok', text: obj((d) => d) },
  { id: 'json fence', expect: 'ok', text: (d) => `\`\`\`json\n${J(d, 2)}\n\`\`\`` },
  { id: 'trailing prose', expect: 'ok', text: (d) => `${J(d)}\n\nLet me know if you want any row expanded {optional}.` },
  { id: 'trailing comma', expect: 'ok', text: (d) => J(d, 2).replace(/([^[{,\s])\n(\s*)([}\]])/g, '$1,\n$2$3') },
  { id: 'alignment gone (late rows)', expect: 'ok', text: obj((d) => { lateRows(d, (c) => { delete c.alignment; }); return d; }) },
  { id: 'alignment gone (all rows)', expect: 'ok', text: obj((d) => { for (const c of d.coverage) delete c.alignment; return d; }) },
  { id: 'change gone (late rows)', expect: 'soft', // a row whose changed line differs from its behaviour cannot be re-derived: unknown, never guessed
 text: obj((d) => { lateRows(d, (c) => { delete c.change; }); return d; }) },
  // the v2 contract: optional fields a lean model leaves out. A unit layer is omitted (a stated higher layer stays), change only when it equals behaviour.
  { id: 'proves gone (all rows)', expect: 'ok', text: obj((d) => { for (const c of d.coverage) for (const e of c.evidence || []) delete e.proves; return d; }) },
  { id: 'layer gone (unit evidence)', expect: 'ok', text: obj((d) => { for (const c of d.coverage) for (const e of c.evidence || []) if (e.layer === 'unit') delete e.layer; return d; }) },
  { id: 'v2 minimal (no change/alignment/kind/proves/unit layer)', expect: 'ok', text: obj((d) => { for (const c of d.coverage) {
    delete c.alignment; if (J(c.change) === J(c.behaviour)) delete c.change;
    for (const e of c.evidence || []) { delete e.proves; if (e.kind === 'assertion') delete e.kind; if (e.layer === 'unit') delete e.layer; } } return d; }) },
  { id: 'enum case (Missing_Test)', expect: 'ok', text: obj(enumCase) },
  { id: 'enum space/hyphen', expect: 'ok', text: obj(enumSpace) },
  { id: 'numbers as strings', expect: 'ok', text: obj(strNums) },
  { id: 'line shift 1..5', expect: 'ok', text: obj(shiftBy(1, 5)) },
  { id: 'line shift 6..9', expect: 'ok', text: obj(shiftBy(6, 9)) },
  { id: 'quote trimmed', expect: 'ok', text: obj(trim('')) },
  { id: 'quote trimmed + ellipsis', expect: 'ok', text: obj(trim('...')) },
  { id: 'quote lower-cased (paraphrase)', expect: 'soft', text: obj((d) => { every(d, (c) => { if (typeof c.quote === 'string') c.quote = c.quote.toLowerCase(); }); return d; }) },
  // Kite PR #5: the AC reads "- [ ] `f(x)` returns 1." and the model quoted "f(x) returns 1." A requirement quote compares as plain text (post.js plain), so no row may be lost.
  { id: 'requirement quote with markdown stripped', expect: 'ok', text: obj((d) => { for (const r of d.requirements || []) if (typeof r.quote === 'string') r.quote = r.quote.replace(/^\s*(?:[-*]\s+)?(?:\[[ xX]\]\s+)?/, '').replace(/`/g, ''); return d; }) },
  { id: 'all cosmetic at once', expect: 'ok', text: (d) => `Here is the review:\n\`\`\`json\n${J(trim('')(shiftBy(1, 5)(strNums(enumCase((lateRows(d, (c) => { delete c.alignment; }), d))))), 2)}\n\`\`\`\nDone.` },
  { id: 'truncated mid-ledger', expect: 'reject', text: (d) => J(d).slice(0, Math.floor(J(d).length * 0.6)) },
  { id: 'ledger missing', expect: 'reject', text: obj((d) => { delete d.coverage; return d; }) },
  { id: 'most rows garbage', expect: 'reject', text: obj((d) => { d.coverage = d.coverage.map((c, i) => (i % 4 === 3 ? c : i % 2 ? 'see above' : { note: 'omitted' })); return d; }) },
];

// ---- one trial ----
function workspace(fx) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-degrade-'));
  const w = (rel, text) => { const f = path.join(dir, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
  for (const [p, t] of Object.entries(fx.files)) w(p, t);
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: dir });
  execFileSync('git', ['add', '-A'], { cwd: dir });
  for (const [n, t] of Object.entries(fx.ctx)) w(`.specguard-ctx/${n}`, t);
  return dir;
}

const key = (kind, p, line) => `${kind}:${p}:${line}`;
async function observe(fx, ws, text) {
  const out = { route: 'ok', why: '', delivered: new Set(), rows: 0, hard: false };
  const j = extract(text);
  if (!j) return { ...out, route: 'repair', why: 'no JSON found' };
  const o = JSON.parse(j), v = post.validate(clone(o));
  if (!v.ok) return { ...out, route: 'repair', why: v.error };
  const ctx = path.join(ws, '.specguard-ctx');
  fs.writeFileSync(path.join(ctx, 'findings.json'), j);
  const lines = (p) => { try { return read(path.join(ws, p)).split(/\r?\n/); } catch { return null; } };
  const d = clone(o);
  post.validate(d);
  post.verifyEvidence(d, new Set(fx.ctx['files.txt'].split('\n').filter(Boolean)), new Set(), lines, post.parseDiff(fx.ctx['diff.patch']));
  out.rows = d.coverage.filter((c) => c.status !== 'unknown').length;
  const { github, core, posted } = fakeGithub({ headSha: 'HEADSHA' });
  const context = { repo: { owner: 'o', repo: 'r' }, serverUrl: 'https://github.com', payload: { pull_request: { number: 1, head: { sha: 'HEADSHA' } } } };
  const env = { CTX: ctx, GITHUB_WORKSPACE: ws, HEAD_SHA: 'HEADSHA', SKIP: 'false', PARTIAL: 'false', MAX_COMMENTS: '10', ENGINE: 'degrade', MODEL: '', STANDARDS_REF: 'head', STANDARDS_CHECKS: '', UNVERIFIED_MISSING_TESTS: process.env.UNVERIFIED_MISSING_TESTS || 'show' }; // frozen evals predate the hold: default show; the caller's env may set details
  const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  try { await post({ github, context, core }); }
  finally { for (const [k, x] of Object.entries(saved)) if (x === undefined) delete process.env[k]; else process.env[k] = x; }
  for (const c of posted.comments.map(parseComment).filter(Boolean)) out.delivered.add(key(c.kind, c.path, c.line));
  for (const i of parseSummary(posted.summary).items) out.delivered.add(key(i.kind, i.path, i.line));
  out.hard = /Could not complete/.test(posted.summary || '');
  return out;
}

// Runs every mutation on one fixture. Returns [{ id, expect, route, kept, total, extra, rows, rowsTotal, hard, ok }].
async function evaluate(fx, mutations = MUTATIONS) {
  const ws = workspace(fx);
  try {
    const good = JSON.parse(fx.ctx['findings.json']);
    const base = await observe(fx, ws, J(good));
    const results = [];
    for (const m of mutations) {
      const r = await observe(fx, ws, m.text(clone(good)));
      const kept = [...base.delivered].filter((k) => r.delivered.has(k)).length, extra = [...r.delivered].filter((k) => !base.delivered.has(k)).length;
      const usable = r.route === 'ok' && !r.hard;
      const ok = m.expect === 'reject' ? !usable : usable && extra === 0 && (m.expect === 'soft' || (kept === base.delivered.size && r.rows >= Math.ceil(base.rows * 0.9)));
      results.push({ fixture: fx.name, id: m.id, expect: m.expect, route: r.hard ? 'hard fail' : r.route, why: r.why, kept, total: base.delivered.size, rows: r.rows, rowsTotal: base.rows, extra, ok });
    }
    return results;
  } finally { fs.rmSync(ws, { recursive: true, force: true }); }
}

const builtin = () => ['l1', 't3'].map(fromCase);

function table(results) {
  const head = ['fixture', 'mutation', 'expect', 'route', 'findings', 'rows', 'new', ''];
  const rows = results.map((r) => [r.fixture, r.id, r.expect, r.route, `${r.kept}/${r.total}`, `${r.rows}/${r.rowsTotal}`, r.extra, r.ok ? 'ok' : `FAIL${r.why ? ` (${r.why.slice(0, 60)})` : ''}`]);
  const w = head.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
  return [head, ...rows].map((r) => r.map((x, i) => String(x).padEnd(w[i])).join('  ').trimEnd()).join('\n');
}

// ---- audit mode: the same idea for audit-post.js validate (citations are not re-verified here: they need the checkout) ----
const audit = require('../src/audit-post.js');
const auditFixture = (dir, name = path.basename(path.dirname(dir)) + '/' + path.basename(dir)) => ({
  name: `audit ${name}`, good: JSON.parse(read(path.join(dir, 'findings.json'))), cands: audit.readCandidates(read(path.join(dir, 'audit-candidates.txt'))) });

// A small synthetic audit result for the built-in run: five blocks, four answered as requirements, one as not a requirement.
function auditBuiltin() {
  const cands = new Map(), cid = (i) => i.toString(16).padStart(8, '0');
  const requirements = [];
  for (let i = 1; i <= 5; i++) cands.set(cid(i), { cid: cid(i), path: 'docs/d.md', line: i, heading: 'D', text: `Requirement ${i} holds.` });
  for (let i = 1; i <= 4; i++) requirements.push({ id: cid(i), text: `Requirement ${i} holds.`, source: { path: 'docs/d.md', line: i, quote: `Requirement ${i} holds.` }, class: i % 2 ? 'unit' : 'higher_level', status: 'covered', code: [{ path: 'src/a.js', line: i, quote: `code ${i}` }], tests: [{ path: 'test/a.test.js', line: i, quote: `test ${i}`, layer: i % 2 ? 'unit' : 'integration' }], note: '' });
  return { name: 'audit synthetic', cands, good: { docs_reviewed: ['docs/d.md'], requirements, not_requirements: [{ cid: cid(5), reason: 'only an example, no behaviour' }], not_reviewed: [] } };
}

// loss: how many answered rows a defect may cost (a row whose own field is unusable becomes unknown; nothing else may be lost).
const eachRow = (d, f) => d.requirements.forEach(f);
const AUDIT_MUTATIONS = [
  { id: 'baseline', loss: 0, text: obj((d) => d) },
  { id: 'json fence', loss: 0, text: (d) => `\`\`\`json\n${J(d, 2)}\n\`\`\`` },
  { id: 'trailing prose', loss: 0, text: (d) => `${J(d)}\n\nDone.` },
  { id: 'trailing comma', loss: 0, text: (d) => J(d, 2).replace(/([^[{,\s])\n(\s*)([}\]])/g, '$1,\n$2$3') },
  { id: 'hallucinated cid in not_requirements', loss: 0, text: obj((d) => { d.not_requirements = [...(d.not_requirements || []), { cid: '527dd1ec', reason: 'looks like a heading, not a requirement' }]; return d; }) },
  { id: 'hallucinated requirement id', loss: 0, text: obj((d) => { d.requirements.push({ ...clone(d.requirements[0]), id: 'deadbeef' }); return d; }) },
  { id: 'invalid class on one row', loss: 1, text: obj((d) => { d.requirements[Math.min(10, d.requirements.length - 1)].class = 'unknown'; return d; }) },
  { id: 'class case/spacing', loss: 0, text: obj((d) => { eachRow(d, (r) => { r.class = cap(r.class).replace('_', ' '); }); return d; }) },
  { id: 'status case', loss: 0, text: obj((d) => { eachRow(d, (r) => { r.status = cap(r.status); }); return d; }) },
  { id: 'numbers as strings', loss: 0, text: obj((d) => { eachRow(d, (r) => { for (const c of [r.source, ...r.code, ...r.tests]) c.line = String(c.line); }); return d; }) },
  { id: 'layer case', loss: 0, text: obj((d) => { eachRow(d, (r) => { for (const t of r.tests) t.layer = cap(t.layer); }); return d; }) },
  { id: 'note gone', loss: 0, text: obj((d) => { eachRow(d, (r) => { delete r.note; }); return d; }) },
  { id: 'text gone on one row', loss: 0, text: obj((d) => { delete d.requirements[0].text; return d; }) },
  { id: 'docs_reviewed gone', loss: 0, text: obj((d) => { delete d.docs_reviewed; return d; }) },
  { id: 'truncated mid-list', loss: Infinity, reject: true, text: (d) => J(d).slice(0, Math.floor(J(d).length * 0.6)) },
  { id: 'requirements missing', loss: Infinity, reject: true, text: obj((d) => { delete d.requirements; return d; }) },
  { id: '40% of the blocks unanswered', loss: Infinity, reject: true, text: obj((d) => { d.requirements = d.requirements.filter((_, i) => i % 5 > 1); d.not_requirements = []; return d; }) },
];

function evaluateAudit(fx) {
  const accepted = (text) => {
    const j = extract(text);
    if (!j) return { route: 'repair', why: 'no JSON found' };
    const o = JSON.parse(j), v = audit.validate(o, fx.cands);
    return v.ok ? { route: 'ok', rows: o.requirements.filter((r) => r.status !== 'unknown').length, all: o.requirements.length } : { route: 'repair', why: v.error };
  };
  const base = accepted(J(fx.good));
  return AUDIT_MUTATIONS.map((m) => {
    const r = accepted(m.text(clone(fx.good)));
    const ok = m.reject ? r.route === 'repair' : r.route === 'ok' && r.rows >= base.rows - m.loss && r.all >= base.all - m.loss;
    return { fixture: fx.name, id: m.id, expect: m.reject ? 'reject' : 'ok', route: r.route, why: r.why || '', kept: r.rows ?? 0, total: base.rows, rows: r.all ?? 0, rowsTotal: base.all, extra: 0, ok };
  });
}

async function main() {
  const { values: o } = require('node:util').parseArgs({ options: { pilot: { type: 'string', multiple: true }, audit: { type: 'string', multiple: true }, json: { type: 'boolean' } } });
  const fixtures = [...builtin(), ...(o.pilot || []).map((d) => fromCtxDir(path.resolve(d)))];
  const all = [];
  for (const fx of fixtures) all.push(...await evaluate(fx));
  for (const fx of [auditBuiltin(), ...(o.audit || []).map((d) => auditFixture(path.resolve(d)))]) all.push(...evaluateAudit(fx));
  console.log(o.json ? J(all, 2) : table(all));
  const bad = all.filter((r) => !r.ok);
  console.log(`\n${all.length - bad.length}/${all.length} ok`);
  if (bad.length) process.exitCode = 1;
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
module.exports = { AUDIT_MUTATIONS, auditBuiltin, auditFixture, evaluateAudit, MUTATIONS, fromCase, fromCtxDir, builtin, evaluate, observe, table };
