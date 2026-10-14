// Unit test gap scan (mode scan; audit is an alias), last step (actions/github-script): validates the model's result and every citation against the checked-out HEAD,
// renders it to the job summary and, with scan_issue (deprecated alias audit_issue), to ONE issue we own. Advisory; never fails the run.
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const { execFileSync } = require('child_process');
const post = require('./post');
const { ours } = require('./preflight');
// trace.js's test-path rule; the fallback is a local copy of it in case the export moves (ponytail: keep in sync).
const { isTestPath = (p) => /(^|[/._-])(test|tests|spec|__tests__)([/._-]|$)/.test(p) } = require('./trace');

const { neutralize, quoteLine, safeRel, readFile, usageLine, runLine, mergeUsage, findingBlock, findingHead, placeholder } = post;
const STATUS = ['covered', 'partial', 'missing_test', 'not_implemented', 'contradicted', 'unknown', 'needs_human'];
const RISK = ['contradicted', 'not_implemented', 'missing_test', 'partial', 'unknown', 'needs_human', 'covered']; // header order: worst first
const CLASS = ['static', 'unit', 'higher_level', 'human'];
const LAYER = ['unit', 'component', 'integration', 'e2e'];
// MARK (and the state marker) stay 'specguard:audit': an issue created before the rename is still found and updated, not duplicated. TITLE: issue title; HEADING: summary head.
const MARK = '<!-- specguard:audit -->', TITLE = 'SpecGuard: unit test gap scan', HEADING = 'SpecGuard scan';
// One scan issue per scope (scan_paths): the marker carries a short hash of the sorted globs and the title names the scope. No scope keeps the original marker and title, so an older issue is still found.
function scopeOf(spec, target = '') {
  const ls = [...new Set(String(spec || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean))].sort();
  const base = target ? `${TITLE}: ${target}` : TITLE; // target: the scanned repository when the issue lives in another one
  if (!ls.length) return { lines: [], mark: MARK, title: base };
  const shown = (ls.filter((l) => !l.startsWith('!')).join(', ') || ls.join(', ')).replace(/[\x00-\x1F\x7F<>]/g, ' ');
  return { lines: ls, mark: `<!-- specguard:audit scope=${sha8(...ls)} -->`, title: `${base} (${oneLine(shown, 60)})` };
}
const SUMMARY_MAX = 1000000, ISSUE_MAX = 64000; // bytes: job summary 1 MiB; issue body 65536
const NEAR = 5; // a quote may sit this many lines from the cited one
const MIN_QUOTE = 12; // non-space characters a quote needs to count as evidence
const STATE_RE = /<!-- specguard:audit-state (\{[\s\S]*?\}) -->/, SHOW = 25; // hidden previous state in the issue body; rows listed per change kind
// Not code evidence: a requirement document (admitted, or any document-like file) and anything in a test path.
const DOCFILE = /\.(md|mdx|markdown|rst|adoc|txt|feature)$/i;
const testFile = (p) => isTestPath(p) || /Tests?\.(java|kt|cs|swift|scala)$/.test(p);

const lines = (s) => String(s || '').split('\n').filter(Boolean);
const bytes = (s) => Buffer.byteLength(s);
const oneLine = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const cell = (s, n = Infinity) => oneLine(neutralize(String(s)), n).replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ');
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const norm = (s) => String(s).replace(/\s+/g, ' ').trim();
const solid = (q) =>String(q).replace(/\s/g, '').length >= MIN_QUOTE;
const CID = /^([0-9a-f]{8})(?:\.[1-9]\d*)?$/; // a block id, or block id + .1, .2 for the atomic requirements a block bundles
const cidOf = (id) => (CID.exec(String(id)) || [])[1];

// audit-candidates.txt (cid TAB path:line TAB heading TAB text) -> Map cid -> { cid, path, line, heading, text }, in document order.
function readCandidates(txt) {
  const m = new Map();
  for (const l of lines(txt)) {
    const [cid, loc = '', heading = '', ...text] = l.split('\t'), k = loc.lastIndexOf(':');
    if (/^[0-9a-f]{8}$/.test(cid) && k > 0) m.set(cid, { cid, path: loc.slice(0, k), line: +loc.slice(k + 1), heading, text: text.join(' ') });
  }
  return m;
}
const ctxCandidates = () => { try { return readCandidates(fs.readFileSync(path.join(process.env.CTX, 'audit-candidates.txt'), 'utf8')); } catch { return null; } };
// audit-units.txt (id, path, risk, why, matched tests, leads: tab separated) -> Map id -> { id, path, score, why, tests: [paths], leads }, in risk order. The units this run reviews.
function readUnits(txt) {
  const m = new Map();
  for (const l of lines(txt)) {
    const [id, p = '', score = '0', why = '', tests = 'none', leads = '-'] = l.split('\t');
    if (/^[0-9a-f]{8}$/.test(id) && p) m.set(id, { id, path: p, score: +score || 0, why, tests: tests === 'none' ? [] : tests.split(', ').filter(Boolean), leads });
  }
  return m;
}
const ctxUnits = () => { try { return readUnits(fs.readFileSync(path.join(process.env.CTX, 'audit-units.txt'), 'utf8')); } catch { return null; } };
const UNIT_KINDS = ['missing_test', 'weak_test', 'pushdown'], UNIT_MAX = 60; // kinds of a unit finding; most rows kept from one result
const MISSING_MAX = 0.2; // more unanswered blocks than this share of the candidates reject the output (the repair turn)

// Hand-rolled mirror of audit.schema.json. Only an unusable output is rejected (the repair turn's trigger): not an object, no requirements
// array, more than half of the rows unusable, or more than MISSING_MAX of the listed blocks unanswered. Every other problem degrades one
// row (an unknown status or class becomes unknown/human, a malformed citation is dropped, so verify() downgrades what it no longer carries)
// and is listed in not_reviewed. Enum case, spaces for underscores and numeric strings are normalised. Evidence that does not fit the status
// is downgraded by verify(). cands (default: audit-candidates.txt in $CTX; null = unknown): a result must name a listed block.
function validate(o, cands = ctxCandidates(), units = ctxUnits()) {
  const bad = (m) => ({ ok: false, error: m });
  const text = (v) => typeof v === 'string' && v.trim().length > 0;
  const { slug, whole } = post;
  const cite = (v) => !!v && typeof v === 'object' && text(v.path) && Number.isInteger(v.line) && v.line >= 1 && text(v.quote);
  const tidy = (v) => { if (v && typeof v === 'object') { v.line = whole(v.line); if (v.layer !== undefined) v.layer = slug(v.layer); } return v; };
  if (!o || typeof o !== 'object' || Array.isArray(o)) return bad('$ is not an object');
  if (o.requirements === undefined && units && units.size && !(cands && cands.size)) o.requirements = []; // code-first run without design documents: nothing to answer there
  if (!Array.isArray(o.requirements)) return bad('requirements must be an array');
  const notes = [];
  for (const k of ['docs_reviewed', 'not_reviewed']) {
    if (!Array.isArray(o[k])) { if (o[k] !== undefined) notes.push(`${k} was not an array; ignored.`); o[k] = []; }
    else if (!o[k].every(text)) { notes.push(`${k} had entries that were not text; ignored.`); o[k] = o[k].filter(text); }
  }
  if (o.not_requirements === undefined || o.not_requirements === null) o.not_requirements = [];
  if (!Array.isArray(o.not_requirements)) { notes.push('not_requirements was not an array; ignored.'); o.not_requirements = []; }
  const ids = new Set(), answered = new Set(), skipped = new Set(), skips = [];
  for (const [i, n] of o.not_requirements.entries()) {
    const w = `not_requirements[${i}]`;
    if (!n || typeof n !== 'object' || !/^[0-9a-f]{8}$/.test(n.cid) || !text(n.reason)) notes.push(`${w} ignored: it needs a block cid and a reason.`);
    else if (cands && !cands.has(n.cid)) notes.push(`${w} ignored: unknown block ${n.cid}; only the listed candidates may be answered.`);
    else if (skipped.has(n.cid)) notes.push(`${w} ignored: duplicate block ${n.cid}.`);
    else { skipped.add(n.cid); skips.push(n); }
  }
  o.not_requirements = skips;
  let unusable = 0, first = '';
  const kept = [];
  for (const [i, r] of o.requirements.entries()) {
    const w = `requirements[${i}]`;
    const drop = (why) => { unusable++; first ||= `${w}: ${why}`; notes.push(`${w} dropped: ${why}.`); };
    if (!r || typeof r !== 'object' || Array.isArray(r)) { drop('not an object'); continue; }
    const cid = cidOf(r.id), cand = cands && cid && cands.get(cid);
    if (!text(r.text) && cand) r.text = cand.text; // the block's own text, from the trusted candidate list
    if (!text(r.id) || !text(r.text)) { drop('id and text are required'); continue; }
    if (ids.has(r.id)) { drop(`duplicate id ${String(r.id).slice(0, 40)}`); continue; }
    if (cands && (!cid || !cands.has(cid))) { drop(`id ${String(r.id).slice(0, 40)} is not a listed block id (the block cid, or cid.1, cid.2)`); continue; }
    if (cands && skipped.has(cid)) { drop(`block ${cid} is answered both as not_a_requirement and as a requirement`); continue; }
    if (!cite(tidy(r.source))) { drop('source needs path, line and quote'); continue; }
    ids.add(r.id);
    const problems = [];
    r.class = slug(r.class); r.status = slug(r.status);
    const noClass = !CLASS.includes(r.class); // a class is never invented: the row takes the one that can never be covered, and its status is unknown
    if (noClass) { problems.push(`class not stated (one of ${CLASS.join(', ')})`); r.class = 'human'; r.status = 'unknown'; }
    if (!noClass && !STATUS.includes(r.status)) { problems.push(`status must be one of ${STATUS.join(', ')}`); r.status = 'unknown'; }
    for (const [k, extra] of [['code', () => true], ['tests', (t) => LAYER.includes(t.layer)]]) {
      if (!Array.isArray(r[k])) { problems.push(`${k} must be an array of citations`); r[k] = []; continue; }
      const ok = r[k].map(tidy).filter((c) => cite(c) && extra(c));
      if (ok.length !== r[k].length) notes.push(`${w}: ${r[k].length - ok.length} malformed ${k} citation(s) ignored.`);
      r[k] = ok;
    }
    if (noClass) r.note = `${typeof r.note === 'string' ? r.note : ''} Class not stated; status unknown.`.trim();
    else if (r.note === undefined || r.note === null) r.note = '';
    else if (typeof r.note !== 'string') { r.note = ''; notes.push(`${w}: note was not a string; ignored.`); }
    for (const c of [r.source, ...r.code, ...r.tests]) c.quote = c.quote.slice(0, 200); // a prefix of a verbatim quote still verifies
    if (problems.length) { unusable++; first ||= `${w}: ${problems[0]}`; notes.push(`${w} marked unknown: ${problems.join('; ')}.`); }
    if (cid) answered.add(cid);
    kept.push(r);
  }
  if (unusable * 2 > o.requirements.length) return bad(`${first} (${unusable} of ${o.requirements.length} requirement rows are unusable)`);
  o.requirements = kept;
  if (cands) {
    const missing = [...cands.keys()].filter((k) => !answered.has(k) && !skipped.has(k));
    if (missing.length > cands.size * MISSING_MAX) return bad(`${missing.length} of ${cands.size} listed blocks were not answered (e.g. ${missing.slice(0, 5).join(', ')}); answer every block exactly once`);
  }
  // unit_findings (code-first): a malformed row is dropped with a note, never a reason to reject the result. A finding must name a listed unit (units: Map from readUnits; null = unknown).
  if (o.unit_findings === undefined || o.unit_findings === null) o.unit_findings = [];
  if (!Array.isArray(o.unit_findings)) { notes.push('unit_findings was not an array; ignored.'); o.unit_findings = []; }
  const keep = [];
  for (const [i, f] of o.unit_findings.entries()) {
    const w = `unit_findings[${i}]`, drop = (why) => notes.push(`${w} dropped: ${why}.`);
    if (!f || typeof f !== 'object' || Array.isArray(f)) { drop('not an object'); continue; }
    f.kind = slug(f.kind); f.line = whole(f.line); f.unit = typeof f.unit === 'string' ? f.unit.trim().toLowerCase() : f.unit;
    if (!/^[0-9a-f]{8}$/.test(f.unit)) drop('unit must be a unit id (8 hex characters)');
    else if (units && !units.has(f.unit)) drop(`unknown unit ${f.unit}; only the listed units may be reviewed`);
    else if (!UNIT_KINDS.includes(f.kind)) drop(`kind must be one of ${UNIT_KINDS.join(', ')}`);
    else if (!text(f.path) || !Number.isInteger(f.line) || f.line < 1 || !text(f.quote) || !text(f.title)) drop('path, line, quote and title are required');
    else if (keep.length >= UNIT_MAX) drop(`more than ${UNIT_MAX} findings; the rest are ignored`);
    else keep.push({ unit: f.unit, kind: f.kind, path: f.path, line: f.line, quote: f.quote.slice(0, 200), title: f.title.trim().slice(0, 120), body: text(f.body) ? f.body.trim() : '', skeleton: text(f.skeleton) ? f.skeleton.replace(/\s+$/, '') : '' });
  }
  o.unit_findings = keep;
  o.not_reviewed.push(...notes);
  return { ok: true };
}

// Why the cited evidence cannot carry the status, or ''. A covered row needs a test whose layer fits the class.
function gap(r) {
  const unit = r.tests.some((t) => t.layer === 'unit'), higher = r.tests.some((t) => t.layer !== 'unit');
  if (r.status === 'covered') {
    if (!r.code.length) return 'covered needs a code citation';
    if (r.class === 'human') return 'a human requirement is never covered';
    if (r.class === 'unit' && !unit) return 'covered needs a unit test citation';
    if (r.class === 'higher_level' && !higher) return 'covered needs a component, integration or e2e test citation';
  }
  if (r.status === 'partial' && !r.tests.length) return 'partial needs a test citation';
  if ((r.status === 'missing_test' || r.status === 'contradicted') && !r.code.length) return `${r.status} needs a code citation`;
  return '';
}

function trackedFiles(root) {
  try { return new Set(execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 1 << 28 }).split('\0').filter(Boolean)); } catch { return null; }
}

// Nearest markdown heading at or above a 1-based line of a file given as an array of lines (what readFile returns).
function headingAt(ls, line) {
  for (let i = Math.min(line, ls.length) - 1; i >= 0; i--) { const m = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(ls[i]); if (m) return m[1]; }
  return '';
}
const sha8 = (...parts) => crypto.createHash('sha1').update(parts.join('\n')).digest('hex').slice(0, 8);

// Checks every citation against the file at HEAD (tracked files only) and corrects the line when the quote sits within NEAR lines of it.
// A requirement whose own citation fails goes to not_reviewed; failed code/test citations are removed and the status downgraded to unknown when the rest cannot carry it.
// A quote under MIN_QUOTE non-space characters, a test outside a test path, or code that is a document or a test file does not count as evidence.
// The row id is the block cid (cid.N for a bundled block), the heading comes from the candidate, and rows keep document order. A block the model
// skipped, or whose rows all failed verification, becomes an `unknown` row ("unconfirmed"); not_requirements gains the block's location and text.
// docs: the admitted documents (null = any); cands: the candidate blocks (Map from readCandidates; null = unknown).
function verify(data, { read = readFile, tracked = null, docs = null, cands = null, units = null, packCut = new Set(), covers = null } = {}) {
  const cache = new Map();
  const file = (p) => { if (!cache.has(p)) cache.set(p, read(p)); return cache.get(p); };
  const locate = (c) => {
    if (!solid(c.quote)) return false;
    const rel = safeRel(c.path);
    if (!rel || (tracked && !tracked.has(rel))) return false;
    const all = file(rel);
    if (!all) return false;
    const a = Math.max(0, c.line - 1 - NEAR), n = String(c.quote).split('\n').length;
    const k = quoteLine(all.slice(a, c.line - 1 + NEAR + n), c.quote);
    c.path = rel;
    if (k && Math.abs(a + k - c.line) <= NEAR) { c.line = a + k; return true; }
    // quote-first: the model's line is a hint; the one place in the file where the quote starts wins, several never do
    const head = norm(String(c.quote).split('\n').find((x) => x.trim()) || '');
    const q = norm(c.quote), at = (i) => norm(all[i]), hits = all.map((_, i) => i).filter((i) => at(i).includes(head) && (n === 1 ? at(i).includes(q)
      : (() => { const k = norm(all.slice(i, i + n + 6).join(' ')).indexOf(q); return k >= 0 && k <= at(i).length; })())); // the quote starts in this line
    if (hits.length !== 1) return false;
    c.line = hits[0] + 1;
    return true;
  };
  const isDoc = (p) => DOCFILE.test(p) || (docs && docs.has(p));
  const out = { ...data, requirements: [], not_requirements: [], not_reviewed: [...data.not_reviewed] };
  const kept = new Set(), failed = new Set(), skipped = new Map((data.not_requirements || []).map((n) => [n.cid, n.reason]));
  const drop = (r, why) => { failed.add(cidOf(r.id)); out.not_reviewed.push(`${r.id} (${r.source.path}:${r.source.line}): ${why}`); };
  for (const r of data.requirements) {
    const source = { ...r.source };
    if (docs && !docs.has(safeRel(source.path))) { drop(r, 'its source is not an admitted requirement document'); continue; }
    if (!locate(source)) { drop(r, solid(source.quote) ? 'the requirement quote was not found at the cited line' : `the requirement quote is under ${MIN_QUOTE} characters`); continue; }
    const code = r.code.map((c) => ({ ...c })).filter((c) => locate(c) && !isDoc(c.path) && !testFile(c.path));
    const tests = r.tests.map((c) => ({ ...c })).filter((c) => locate(c) && !isDoc(c.path) && testFile(c.path));
    const lost = r.code.length - code.length + r.tests.length - tests.length;
    const cand = cands && cands.get(cidOf(r.id)), heading = cand ? cand.heading : headingAt(file(source.path), source.line);
    kept.add(cidOf(r.id));
    const row = { ...r, heading, source, code, tests, note: r.note };
    if (lost) row.note = `${row.note} ${lost} citation(s) could not be verified and were removed.`.trim();
    const why = gap(row);
    if (why && row.status !== 'unknown') { row.note = `${row.note} Downgraded to unknown: ${why}.`.trim(); row.status = 'unknown'; }
    out.requirements.push(row);
  }
  if (cands) {
    for (const c of cands.values()) {
      if (kept.has(c.cid) || skipped.has(c.cid)) continue;
      const quote = String((file(c.path) || [])[c.line - 1] || c.text).trim().slice(0, 200);
      out.requirements.push({ id: c.cid, text: oneLine(c.text, 200), source: { path: c.path, line: c.line, quote }, heading: c.heading, class: 'human', status: 'unknown', code: [], tests: [],
        note: failed.has(c.cid) ? "Unconfirmed: the model's citation for this block did not verify." : 'Unconfirmed: the model did not assess this block.' });
    }
    const at = new Map([...cands.keys()].map((k, i) => [k, i])), pos = (id) => at.get(cidOf(id)) ?? Infinity;
    out.requirements.sort((a, b) => pos(a.id) - pos(b.id)); // stable: a block's .1, .2 rows keep the model's order
    out.not_requirements = [...skipped].filter(([k]) => cands.has(k)).map(([k, reason]) => ({ ...cands.get(k), reason })).sort((a, b) => pos(a.cid) - pos(b.cid));
  } else out.not_requirements = [...skipped].map(([cid, reason]) => ({ cid, reason }));
  out.unit_findings = verifyUnits(data.unit_findings || [], { locate, isDoc, units, packCut, covers: covers && ((c) => covers(file(c.path), c.line)), notes: out.not_reviewed });
  return out;
}

// Unit findings (code-first), same quote-first check as a requirement citation: the quote must sit at path:line at the scanned commit (locate: verify's, which corrects a near-miss line).
// missing_test cites the unit's code, weak_test and pushdown a test file; a document is never evidence. fid = (unit id, kind, normalised quote): the stable key a second run confirms by.
// det: a missing_test on a unit with NO matched test file is confirmed at once (no test file is a fact the collector found). low: the claude engine's context pack cut a test file the claim depends on
// (the unit's matched tests for missing_test, the cited file for weak_test); same rule as PR mode: shown in Details, never counted. Also low: covers(c) found a test file that already contains the cited
// line's error message or literal (src/test-map.js, shared with PR mode): lowWhy names it.
function verifyUnits(list, { locate, isDoc, units, packCut, covers = null, notes }) {
  const out = [], seen = new Set(), key = (q) => String(q).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  for (const f of list) {
    const c = { path: f.path, line: f.line, quote: f.quote }, at = `unit finding "${oneLine(f.title, 60)}" (${f.path}:${f.line})`, u = units && units.get(f.unit);
    if (!locate(c)) { notes.push(`${at}: ${solid(f.quote) ? 'the quote was not found at the cited line' : `the quote is under ${MIN_QUOTE} characters`}`); continue; }
    if (isDoc(c.path) || (f.kind === 'missing_test') === testFile(c.path)) { notes.push(`${at}: ${f.kind === 'missing_test' ? 'a missing_test cites the unit\'s code, not a test or a document' : `a ${f.kind} cites a test file`}`); continue; }
    const fid = sha8(f.unit, f.kind, key(c.quote));
    if (seen.has(fid)) continue;
    seen.add(fid);
    const skeleton = f.skeleton && placeholder(f.skeleton) ? '' : f.skeleton;
    if (skeleton !== f.skeleton) notes.push(`${at}: skeleton omitted: placeholder`);
    const cut = !!u && (f.kind === 'missing_test' ? u.tests.some((t) => packCut.has(t)) : f.kind === 'weak_test' && packCut.has(c.path)), hit = !cut && f.kind === 'missing_test' && covers ? covers(c) : null;
    out.push({ ...f, ...c, skeleton, fid, low: cut || !!hit, ...(hit && { lowWhy: `a test may already cover this: ${hit}` }), det: f.kind === 'missing_test' && !!u && !u.tests.length && !hit });
  }
  return out;
}

const count = (rows, key, values) => values.map((v) => [v, rows.filter((r) => r[key] === v).length]).filter(([, n]) => n);

// One status per document block, the stable signal across runs: gap = any sub-row says missing_test/partial/contradicted/not_implemented,
// covered = all sub-rows covered, unsure = anything else (unknown, needs_human, a mix).
const GAP = ['missing_test', 'partial', 'contradicted', 'not_implemented'], MAXRUN = 3, // runs only matter up to 2 (confirmed, covered twice); 3 lets an unchanged scan settle so its issue body stops changing
   BSTATE = ['gap', 'covered', 'unsure', 'not_req', 'recheck'];
const blockStatus = (ss) => (ss.some((s) => GAP.includes(s)) ? 'gap' : ss.every((s) => s === 'covered') ? 'covered' : 'unsure');
function blocksOf(data) {
  const m = new Map();
  for (const r of data.requirements) {
    const cid = cidOf(r.id) || r.id;
    if (!m.has(cid)) m.set(cid, { cid, path: r.source.path, line: r.source.line, text: r.source.quote, rows: [] });
    m.get(cid).rows.push(r);
  }
  for (const b of m.values()) b.status = blockStatus(b.rows.map((r) => r.status));
  for (const n of data.not_requirements || []) if (!m.has(n.cid)) m.set(n.cid, { cid: n.cid, path: n.path || '', line: n.line || 0, text: n.text || '', status: 'not_req', rows: [] });
  return [...m.values()];
}

// Confirmation across runs. prior: { head, blocks: [{ cid, status, since, runs }] } (null = first run). Annotates each block with
// .was (previous status, a pending recheck counts as covered), .mark (confirmed | new | resolved | recheck | '') and .next, its state entry
// [cid, status, firstSeenHead, consecutive runs with this status]. A confirmed gap that is covered once is stored as `recheck`; covered twice = resolved.
function track(blocks, prior, head = '') {
  const was = new Map((prior ? prior.blocks : []).map((b) => [b.cid, b])), h = String(head || '').slice(0, 7);
  for (const b of blocks) {
    const p = was.get(b.cid), same = p && p.status === b.status;
    let st = b.status, runs = same ? Math.min(p.runs + 1, MAXRUN) : 1, since = same ? p.since : h;
    b.mark = '';
    if (b.status === 'gap') b.mark = p && p.status === 'gap' ? 'confirmed' : 'new';
    else if (b.status === 'covered' && p && p.status === 'recheck') { b.mark = 'resolved'; runs = 2; since = p.since; }
    else if (b.status === 'covered' && p && p.status === 'gap' && p.runs >= 2) { b.mark = 'recheck'; st = 'recheck'; runs = 1; since = h; }
    b.was = p ? (p.status === 'recheck' ? 'covered' : p.status) : null;
    b.next = [b.cid, st, since, runs];
  }
  return blocks;
}

// Hidden machine-readable previous state: block ids, statuses and when each block was last audited, never text, so the next run can confirm and rotate.
// v4: { head, audits: [[sha7, date]], blocks: [[cid, status, since, runs, index into audits (-1 = unknown)]] }. v3 (no audit dates) and v2 (per-row) still read.
// Code-first: a unit is a block entry (cid = the unit id: gap = it had a verified finding, covered = it had none; its audit date drives the rotation) and its findings are an optional `f`:
// [[fid, unit id, since sha7, runs]] (fid = hash of unit id, kind and normalised quote), so a finding is confirmed when the same one was reported in the previous run. Older readers ignore `f`.
const STATE_MAX = 600, FINDINGS_MAX = 300, ISO_DATE = /^\d{4}-\d\d-\d\d$/; // blocks kept (the covered, longest ago audited go first; a dropped block counts as never audited again)
const FID = (x) => Array.isArray(x) && /^[0-9a-f]{8}$/.test(x[0]) && /^[0-9a-f]{8}$/.test(x[1]) && /^[\w.-]{0,40}$/.test(x[2]) && Number.isInteger(x[3]) && x[3] >= 1 && x[3] <= MAXRUN;
const findingsOf = (o) => (Array.isArray(o.f) && o.f.length <= FINDINGS_MAX && o.f.every(FID) ? o.f.map(([fid, unit, since, runs]) => ({ fid, unit, since, runs })) : []); // an invalid `f` is dropped, not the state
const stateRaw = (head, entries, findings = []) => { // entries: [cid, status, since, runs, at: { head, date } | null]; findings: [[fid, unit, since, runs]]
  const audits = [], idx = new Map();
  const blocks = entries.map(([cid, status, since, runs, at]) => {
    if (!at) return [cid, status, since, runs, -1];
    const k = `${at.head}@${at.date}`;
    if (!idx.has(k)) { idx.set(k, audits.length); audits.push([at.head, at.date]); }
    return [cid, status, since, runs, idx.get(k)];
  });
  return `<!-- specguard:audit-state ${JSON.stringify({ v: 4, head: String(head || '').slice(0, 40), audits, blocks, ...(findings.length ? { f: findings } : {}) }).replace(/[<>]/g, (c) => (c === '<' ? '\\u003c' : '\\u003e')).replace(/--/g, '-\\u002d')} -->`;
};
const today = () => new Date().toISOString().slice(0, 10);
// This run's blocks (tracked against prior, audited now) plus the carried ones (prior blocks this run did not audit, still in the documents). dropped: carried blocks over STATE_MAX.
// code (code-first run): { picked: [unit ids audited now], findings: tracked verified findings (trackFindings), carried: prior block entries of units not audited now that are still in the repository }.
function stateOf(head, data, prior = null, { carried = [], date = today(), code = null } = {}) {
  const at = { head: String(head || '').slice(0, 7), date };
  const now = track(blocksOf(data), prior, head).filter((b) => /^[0-9a-f]{8}$/.test(b.cid)).map((b) => [...b.next, at]);
  if (code) { const hit = new Set(code.findings.map((f) => f.unit)); now.push(...track(code.picked.map((cid) => ({ cid, status: hit.has(cid) ? 'gap' : 'covered' })), prior, head).map((b) => [...b.next, at])); }
  const all = carried.concat(code ? code.carried : []);
  const rank = (b) => (b.status === 'covered' || b.status === 'not_req' ? 1 : 0), when = (b) => (b.at && b.at.date) || '';
  const old = all.slice().sort((a, b) => rank(a) - rank(b) || (when(a) < when(b) ? 1 : when(a) > when(b) ? -1 : 0)).slice(0, Math.max(0, STATE_MAX - now.length));
  const fs_ = code ? [...code.findings.map((f) => f.next), ...((prior && prior.findings) || []).filter((x) => !code.picked.includes(x.unit) && code.carried.some((b) => b.cid === x.unit)).map((x) => [x.fid, x.unit, x.since, x.runs])].slice(0, FINDINGS_MAX) : [];
  return { raw: stateRaw(head, [...now, ...old.map((b) => [b.cid, b.status, b.since, b.runs, b.at])], fs_), dropped: all.length - old.length };
}
// Verified unit findings against the previous state: confirmed = the collector's own fact (a missing_test on a unit with no test file) or the same finding (unit, kind, quote) in the previous run.
// -> copies with .confirmed and .next, the state entry [fid, unit, first-seen sha7, consecutive runs].
function trackFindings(list, prior, head = '') {
  const was = new Map(((prior && prior.findings) || []).map((x) => [x.fid, x])), h = String(head || '').slice(0, 7);
  return list.map((f) => { const p = was.get(f.fid); return { ...f, confirmed: !!f.det || !!p, next: [f.fid, f.unit, p ? p.since : h, Math.min((p ? p.runs : 0) + 1, MAXRUN)] }; });
}
const stateComment = (head, data, prior = null, opts) => stateOf(head, data, prior, opts).raw;
const priorState = (p) => stateRaw(p.head, p.blocks.map((b) => [b.cid, b.status, b.since, b.runs, b.at]), (p.findings || []).map((x) => [x.fid, x.unit, x.since, x.runs]));
function readState(body) {
  const m = STATE_RE.exec(String(body || ''));
  if (!m) return null;
  try {
    const o = JSON.parse(m[1]), head = String((o && o.head) || '');
    const v = o && (o.v === 3 || o.v === 4) && Array.isArray(o.blocks), audits = o && o.v === 4 && Array.isArray(o.audits) ? o.audits : [];
    if (v && (o.v === 3 || (Array.isArray(o.audits) && audits.every((a) => Array.isArray(a) && /^[\w.-]{0,40}$/.test(a[0]) && ISO_DATE.test(a[1]))))
      && o.blocks.every((x) => Array.isArray(x) && /^[0-9a-f]{8}$/.test(x[0]) && BSTATE.includes(x[1]) && /^[\w.-]{0,40}$/.test(x[2]) && Number.isInteger(x[3]) && x[3] >= 1 && x[3] <= MAXRUN
        && (o.v === 3 || (Number.isInteger(x[4]) && x[4] >= -1 && x[4] < audits.length))))
      return { head, blocks: o.blocks.map(([cid, status, since, runs, a]) => ({ cid, status, since, runs, at: o.v === 4 && a >= 0 ? { head: audits[a][0], date: audits[a][1] } : null })), ...(findingsOf(o).length ? { findings: findingsOf(o) } : {}) };
    if (o && o.v === 2 && Array.isArray(o.rows) && o.rows.every((x) => Array.isArray(x) && CID.test(x[0]) && STATUS.includes(x[1]))) {
      const by = new Map();
      for (const [id, s] of o.rows) by.set(cidOf(id), [...(by.get(cidOf(id)) || []), s]);
      return { head, blocks: [...by].map(([cid, ss]) => ({ cid, status: blockStatus(ss), since: head.slice(0, 7), runs: 1, at: null })) };
    }
  } catch { /* an edited or foreign comment is no state */ }
  return null;
}

// Markdown that fits `max` bytes: header and footer first, then whole table rows while they fit (never cut mid-row).
// partial: why the scan is incomplete (shown first); prior: readState() of the last full scan; head: this commit; cap: scan_max_blocks.
// carried: prior blocks this run did not audit ({ cid, path, line, text, status, since, runs, at }); they keep their status in the tables, marked "from <date>".
// rotation / search (evidence candidates): audit-meta.json's; scope: the scan_paths lines; stateDropped: carried blocks that no longer fit the state.
function render({ data, docs = [], rejected = [], limitations = [], capLeft = [], blob = '', usage = '', run = '', failure = '', partial = '', prior = null, head: sha = '', cap = 0, candidates = 0, max = SUMMARY_MAX,
  carried = [], rotation = null, search = null, scope = [], stateDropped = 0, ruled = [], code = null }) {
  const link = (p, line, label) => {
    const t = neutralize(label).replace(/[\[\]]/g, '').replace(/\|/g, '\\|');
    const rel = safeRel(p);
    return blob && rel ? `[${t}](${blob}/${rel.split('/').map(encodeURIComponent).join('/')}#L${line})` : t;
  };
  const at = (c) => link(c.path, c.line, `${c.path}:${c.line}`);
  const rows = data ? data.requirements : [];
  const blocks = data ? track(blocksOf(data), prior, sha) : [], byCid = new Map(blocks.map((b) => [b.cid, b]));
  // code-first part (code = { list: Map of the reviewed units, inv: audit-inventory.json, findings: verified unit findings }): confirmed findings first, then by the unit's risk; low-confidence ones are Details only
  const uall = code ? trackFindings(code.findings, prior, sha).sort((a, b) => (b.confirmed - a.confirmed) || (((code.list.get(b.unit) || {}).score || 0) - ((code.list.get(a.unit) || {}).score || 0))) : [];
  const uf = uall.filter((f) => !f.low), ulow = uall.filter((f) => f.low), inv = code ? code.inv : null;
  const riskiest = inv ? (inv.rotation.picked === 1 ? 'riskiest unit' : `${inv.rotation.picked} riskiest units`) : '';
  const docless = !!code && !docs.length && !rows.length; // a repository without design documents: the document statistics would only say zero
  // carried blocks: the previous status, no sub-rows; a pending recheck stays pending; blocks that were not requirements are only counted
  const old = carried.filter((p) => p.status !== 'not_req').map((p) => ({ cid: p.cid, path: p.path, line: p.line, text: p.text, rows: [], carried: true, at: p.at, next: [p.cid, p.status, p.since, p.runs],
    status: p.status === 'recheck' ? 'covered' : p.status, mark: p.status === 'recheck' ? 'recheck' : p.status === 'gap' ? (p.runs >= 2 ? 'confirmed' : 'new') : '' }));
  const name = (r) => `${link(r.source.path, r.source.line, r.id)}`;
  const evidence = (r) => [r.code.length ? `code: ${r.code.map(at).join('; ')}` : '', r.tests.length ? `tests: ${r.tests.map((t) => `${t.layer} ${at(t)}`).join('; ')}` : ''].filter(Boolean).join('<br>');
  const first = (r) => `${name(r)} ${cell(r.text, 300)}${r.note ? `<br><sub>${cell(r.note, 300)}</sub>` : ''}`;
  const label = (b) => (b.status === 'gap' ? (b.mark === 'confirmed' ? `gap (confirmed${b.next[2] ? ` since ${cell(b.next[2], 12)}` : ''})` : 'gap (unconfirmed)')
    : b.mark === 'resolved' ? 'covered (resolved)' : b.mark === 'recheck' ? 'covered (resolved? recheck next run)' : b.status);
  const subs = (b) => count(b.rows, 'status', RISK).map(([v, n]) => `${v.replace(/_/g, ' ')} ×${n}`).join(', ');
  const bline = (b) => `| \`${b.cid}\` | ${link(b.path, b.line, `${b.path}:${b.line}`)} | ${cell(b.text, 120)} | ${label(b)}${b.carried ? `<br><sub>from ${b.at ? cell(b.at.date, 12) : 'an earlier run'}</sub>` : ''} | ${subs(b)} |\n`;
  const BTOP = '| Block | Line | Requirement | Status | Sub-rows |\n|---|---|---|---|---|\n';
  const of = (s, m) => blocks.concat(old).filter((b) => b.status === s && (!m || b.mark === m));
  const confirmed = of('gap', 'confirmed'), fresh = of('gap', 'new'), unsure = of('unsure'), covered = of('covered');
  const evid = []; // per-document sub-row evidence
  for (const r of rows) {
    let g = evid.find((x) => x.path === r.source.path);
    if (!g) evid.push(g = { path: r.source.path, rows: [] });
    g.rows.push(`| ${first(r)} | ${r.status.replace(/_/g, ' ')} | ${r.class.replace(/_/g, ' ')} | ${evidence(r) || 'none'} |\n`);
  }

  const by = (pairs) => pairs.map(([v, n]) => `${v} ${n}`).join(' · ') || 'none';
  const docCount = new Set(rows.map((r) => r.source.path)).size;
  // how much of the repository this run covers, and how its blocks were chosen
  const coverage = () => {
    const where = scope.length ? `Scope (scan_paths): ${scope.map((l) => `\`${cell(l, 100)}\``).join(', ')}.\n\n` : '';
    if (!rotation || !candidates) return where;
    const k = rotation.picked;
    const found = search && search.blocks ? `Evidence candidates found before the model ran: ${search.with_code} of ${search.blocks} blocks have a code location, ${search.with_tests} a test location.\n\n` : '';
    if (!rotation.rotate) return `${where}${k < candidates ? `Scanned in document order: the first ${k} of ${candidates} blocks (cap ${cap}). Schedule with scan_issue: true to rotate through all blocks.\n\n` : ''}${found}`;
    return `${where}Coverage: ${k + carried.length} of ${candidates} blocks audited at least once; this run audited ${k} (changed ${rotation.changed}, confirming ${rotation.confirming}, new ${rotation.new}, oldest ${rotation.oldest}).\n\n${found}`;
  };
  // Visible = what to act on: confirmed gaps, new gaps to confirm, documents and code that disagree, and "Not reviewed" when the scan is incomplete. Everything else sits in ONE Details block.
  const skipped = data ? data.not_requirements || [] : [], gapN = confirmed.length + fresh.length;
  const NEXT = { contradicted: 'The code contradicts it: see Documents and code disagree.', not_implemented: 'Not implemented: add the behaviour and a unit test.', missing_test: 'Add a unit test that checks it.', partial: 'Strengthen the unit test: it checks only part of it.' };
  const nextStep = (b) => NEXT[RISK.find((v) => GAP.includes(v) && b.rows.some((r) => r.status === v))] || NEXT.missing_test;
  const grow = (b) => `| ${link(b.path, b.line, `${b.path}:${b.line}`)} ${cell(b.text, 120)}${b.carried ? `<br><sub>from ${b.at ? cell(b.at.date, 12) : 'an earlier run'}</sub>` : ''} | ${nextStep(b)} |\n`;
  const GTOP = '| Document says | Next step |\n|---|---|\n';
  const clashes = rows.filter((r) => r.status === 'contradicted').map((r) => `| "${cell(r.source.quote, 200)}"<br>${at(r.source)} | "${cell(r.code[0].quote, 200)}"<br>${r.code.map(at).join('; ')} |\n`);
  const nr = [...(data ? data.not_reviewed : []), ...capLeft, ...limitations, ...(stateDropped ? [`the scan issue state keeps at most ${STATE_MAX} blocks: ${stateDropped} older block(s) are dropped and will count as never audited`] : [])];
  const unread = data ? docs.filter(([p]) => !data.docs_reviewed.includes(p)).map(([p]) => `\`${p}\` was admitted but is not in docs_reviewed.`) : [];
  const nrAll = [...nr, ...unread];
  const where = sha ? ` in the design documents at \`${cell(sha.slice(0, 7), 12)}\`` : ' in the design documents';
  const found = [confirmed.length && plural(confirmed.length, 'confirmed gap'), fresh.length && (confirmed.length ? `${fresh.length} new to confirm` : `${plural(fresh.length, 'new gap')} to confirm`)].filter(Boolean).join(', ');
  let verdict;
  const at7 = sha ? ` at \`${cell(sha.slice(0, 7), 12)}\`` : '', gaps = uf.filter((f) => f.kind !== 'pushdown').length, down = uf.length - gaps, unitPart = uf.length ? `${[gaps && plural(gaps, 'unit test gap'), down && plural(down, 'test to move down', 'tests to move down')].filter(Boolean).join(' and ')} in the ${riskiest}` : '', docPart = found ? `${found} in the design documents` : '';
  if (failure) verdict = `**⚠️ Could not complete: ${cell(failure, 400)}**`;
  else if (code && data) {
    const both = [unitPart, docPart].filter(Boolean).join('; ');
    if (partial) verdict = `**⚠️ Incomplete scan: ${both ? `${both} found so far` : 'no unit test gaps found so far'}**`;
    else if (both) verdict = `**❌ ${both}**${at7}. Static review; tests were not run.`;
    else if (unsure.length) verdict = `**❔ No unit test gaps in the ${riskiest}; ${plural(unsure.length, 'block')} need${unsure.length === 1 ? 's' : ''} a person to check**${at7}. Static review; tests were not run.`;
    else verdict = `**✅ No unit test gaps in the ${riskiest}**${at7}. Static review; tests were not run.`;
  }
  else if (!data) verdict = '**No design documents were found, so nothing was scanned.**';
  else if (partial) verdict = `**⚠️ Incomplete scan: ${found ? `${found} found so far` : 'no unit test gaps found so far'}**`;
  else if (gapN) verdict = `**❌ ${found}**${where}. Static review; tests were not run.`;
  else if (unsure.length) verdict = `**❔ No gaps found; ${plural(unsure.length, 'block')} need${unsure.length === 1 ? 's' : ''} a person to check**${where}. Static review; tests were not run.`;
  else verdict = `**✅ No unit test gaps found**${where}. Static review; tests were not run.`;
  let top = `## ${HEADING}\n\n${verdict}\n\n`;
  if (code && data && !failure && !partial) { // the shape of the unit result in one glance (not for an incomplete run)
    const n = (k) => uf.filter((f) => f.kind === k).length, cellOf = (k) => (n(k) ? `${n(k)}` : 'none'), r = inv.rotation;
    top += `| Units reviewed | No unit test | Weak tests | Skipped tests | Design documents |\n|---|---|---|---|---|\n| ${r.picked} of ${r.total}${r.rotate ? ` (rotation ${r.run} of ${r.runs})` : ''} | ${cellOf('missing_test')} | ${cellOf('weak_test')} | ${(inv.selected && inv.selected.skipped_tests) || 'none'} | ${docs.length ? `${docs.length} read` : 'none found'} |\n\n`;
  }
  if (partial && !failure) top += `> **Incomplete scan.** The rows below passed verification but the list may be incomplete${partial ? ` (${cell(partial, 200)})` : ''}. The scan issue, if enabled, was not updated.\n\n`;
  const items = (a, n, f) => a.slice(0, n).map(f).join('') + (a.length > n ? `- +${a.length - n} more\n` : '');
  // an incomplete or failed scan keeps its reasons visible; a complete one lists them in Details
  const visibleNr = partial && !failure && nrAll.length ? `### Not reviewed (${nrAll.length})\n\n${items(nrAll, 40, (s) => `- ${cell(s, 400)}\n`)}\n` : '';

  // Details: what the scan looked at and the rest of its result. Fixed text first (counted against the size limit), then tables whole rows at a time.
  let dhead = '', dfoot = '';
  const stats = [];
  if (data && !docless) {
    const n = new Set(rows.map((r) => cidOf(r.id) || r.id)).size + skipped.length;
    const tally = [['confirmed gap', confirmed.length], ['new gap (unconfirmed)', fresh.length], ['unsure', unsure.length], ['covered', covered.length]].filter(([, k]) => k);
    stats.push(`**${rows.length} requirement${rows.length === 1 ? '' : 's'}** from ${docCount} document${docCount === 1 ? '' : 's'}`);
    stats.push(`${rotation ? `${n} block${n === 1 ? '' : 's'} audited this run` : candidates ? `${n} block${n === 1 ? '' : 's'} scanned of ${candidates} in the documents${cap ? ` (cap ${cap})` : ''}` : `${n} block${n === 1 ? '' : 's'} scanned`}.`);
    const cv = coverage().trim();
    if (cv) stats.push(cv);
    stats.push(`By block: ${by(tally)}`);
    stats.push(prior ? `A gap is **confirmed** when the block was a gap in this run and ${rotation && rotation.rotate ? 'the last time it was audited' : 'in the previous one'}${prior.head ? ` (\`${cell(prior.head.slice(0, 7), 12)}\`)` : ''}; one run alone is unconfirmed. Unsure blocks and sub-row detail vary from run to run and are not confirmed.`
      : 'This is the first scan run (no earlier result to compare with), so every gap is **unconfirmed**; one more scan run will confirm the ones that persist.');
    stats.push('The blocks are fixed by the documents (every paragraph, list item and table row, in document order) and the publisher, not the model, picks the ones a run assesses (up to the cap): the same commit and state list the same blocks. The model only assesses each one; the counts describe that list, not the repository.');
  }
  if (prior && data && !docless) dhead += changedSince(prior, blocks);
  if (stats.length) dhead += `**This scan**\n\n${stats.join('\n\n')}\n\n`;
  if (data && !docless) dhead += '**How to read this scan**\n\nStatic review; not coverage; not for scoring people. Tests were not executed: a requirement is covered when a cited unit assertion with an independent expected value proves it. Not implemented and missing test are model claims (not verified statically): the search that found nothing is not checked. A block is a gap when any of its sub-rows is a missing test, partial, contradicted or not implemented, covered when all are, unsure otherwise. Blocks are identified by a stable id (a hash of the document, heading and block text), so a reworded block shows as removed and new.\n\n';
  // what was read and what was not admitted: a plain list (a candidate document is not something the reader acts on)
  if (docs.length || rejected.length) {
    const k = rejected.length;
    const read = docs.length ? `- Requirement documents: ${docs.slice(0, 15).map(([p, how]) => `\`${cell(p, 200)}\`${how ? ` (${cell(how, 40)})` : ''}`).join(', ')}${docs.length > 15 ? `, +${docs.length - 15} more` : ''}\n` : '';
    const nope = k ? `- ${k} candidate document${k === 1 ? ' was' : 's were'} not admitted (add to \`requirements_paths\` to include):\n${items(rejected, 20, ([p, why]) => `  - \`${cell(p, 200)}\`: ${cell(why, 200)}\n`)}` : '';
    dfoot += `**Sources**\n\n${read}${nope}\n`;
  }
  if (skipped.length) dfoot += `**${skipped.length} block${skipped.length === 1 ? ' was' : 's were'} not ${skipped.length === 1 ? 'a requirement' : 'requirements'}**\n\n${items(skipped, 60, (n) => `- ${n.path ? `${link(n.path, n.line, `${n.path}:${n.line}`)} ` : ''}\`${n.cid}\` ${n.text ? `${cell(n.text, 100)} ` : ''}(${cell(n.reason, 80)})\n`)}\n`;
  // blocks the collector's prefilter dropped (audit-ruled.txt): data and status, not behaviour; never sent to the model, so not part of the counts above
  if (ruled.length) dfoot += `**${ruled.length} block${ruled.length === 1 ? ' was' : 's were'} skipped by rule**\n\n${items(ruled, 60, (n) => `- ${n.path ? `${link(n.path, n.line, `${n.path}:${n.line}`)} ` : ''}\`${n.cid}\` ${n.text ? `${cell(n.text, 100)} ` : ''}(skipped by rule: ${cell(n.reason, 80)})\n`)}\n`;
  if (nrAll.length && !visibleNr) dfoot += `**Not reviewed (${plural(nrAll.length, 'item')})**\n\n${items(nrAll, 40, (s) => `- ${cell(s, 400)}\n`)}\n`;
  const drun = run ? `${run}\n` : '', tail = usage ? `\n${usage}\n` : ''; // the cost line is the last visible line, outside Details (a failed scan spent money too)

  let room = max - bytes(top) - bytes(visibleNr) - bytes(tail) - 700, omitted = 0; // the visible tables come first
  const take = (title, rs, end = '') => { // whole rows while they fit
    const kept = [];
    let used = bytes(title) + bytes(end) + 1;
    for (const r of rs) { const b = bytes(r); if (used + b > room) break; kept.push(r); used += b; }
    omitted += rs.length - kept.length;
    if (!kept.length) return '';
    room -= used;
    return `${title}${kept.join('')}${end}\n`;
  };
  const CAP = 15, UCAP = 10; // rows shown per visible table; the rest are in Details. UCAP: unit findings listed (PR mode's list cap: each carries a skeleton)
  const vis = (title, rs, head, cap = CAP) => (rs.length ? take(`### ${title} (${rs.length})\n\n${head}`, rs.slice(0, cap), rs.length > cap ? `\n+${rs.length - cap} more in Details.\n` : '') : '');
  let body = '';
  // code-first sections first: untested behaviour, weak unit tests, tests to move down (the top three findings keep their skeleton visible)
  let rank = 0;
  const ulists = [['Untested behaviour', 'missing_test', 'More untested behaviour'], ['Weak unit tests', 'weak_test', 'More weak unit tests'], ['Tests to move down', 'pushdown', 'More tests to move down']].map(([title, kind, more]) => ({ title, more, fs: uf.filter((f) => f.kind === kind) }));
  const fence = (t) => `\n\n\`\`\`\n${t.replace(/`{3,}/g, "'''")}\n\`\`\``;
  const uitem = (f) => findingBlock({ f: { kind: f.kind, title: f.title, path: f.path, line: f.line, body: `${neutralize(f.body)}${f.skeleton ? fence(f.skeleton) : ''}` }, why: f.confirmed ? '' : 'unconfirmed' }, blob, rank++, { bare: true, posted: true });
  const uhead = (f) => findingHead({ kind: f.kind, title: f.title, path: f.path, line: f.line, body: f.body }, { why: f.low ? f.lowWhy || 'low confidence' : f.confirmed ? '' : 'unconfirmed', posted: true, bare: true }, blob);
  for (const l of ulists) body += vis(l.title, l.fs.map(uitem), '', UCAP);
  body += vis('Confirmed gaps', confirmed.map(grow), GTOP);
  body += vis(prior ? 'New since the last scan' : 'New gaps to confirm', fresh.map(grow), GTOP);
  body += clashes.length ? take(`### Documents and code disagree (${clashes.length})\n\nA model judgement: only the existence of both quotes was verified. Check before acting.\n\n| Document says | Code says |\n|---|---|\n`, clashes.slice(0, CAP), clashes.length > CAP ? `\n+${clashes.length - CAP} more in Details.\n` : '') : '';
  // Details: the run line is reserved, then the fixed text while it fits, then the tables with what is left
  room -= bytes(drun);
  const fit = (t) => { if (!t || bytes(t) > room) return ''; room -= bytes(t); return t; };
  const dh = fit(dhead), df = fit(dfoot);
  const more = (title, rs, head, cap = CAP) => (rs.length > cap ? take(`**${title} (${rs.length - cap} more)**\n\n${head}`, rs.slice(cap), '') : '');
  // code-first Details: the riskiest units table, the inventory and how to read it, units not yet reviewed, low-confidence findings
  let cdet = '';
  if (code) {
    const r = inv.rotation, URISK = '| Unit | Risk | Why | Matched tests | Review |\n|---|---|---|---|---|\n';
    const urow = (u) => `| ${link(u.path, 1, u.path)} | ${u.score} | ${cell(u.why, 160)} | ${u.tests.length ? cell(`${u.tests.slice(0, 3).join(', ')}${u.tests.length > 3 ? `, +${u.tests.length - 3} more` : ''}`, 200) : 'none'} | ${cell(u.review, 40)} |\n`;
    const text = `**Inventory**\n\n${inv.units} source files (units), ${inv.with_tests} with a matched test file and ${inv.without_tests} without. The matched tests hold ${plural(inv.skipped_tests, 'skipped test')}, ${plural(inv.tests_without_assertion, 'test')} without an assertion and ${plural(inv.weak_assertions, 'weak assertion')}.\n\n`
      + `${r.rotate ? `Rotation: ${r.reviewed} of ${r.total} units reviewed at least once; this run reviewed ${r.picked} (confirming ${r.confirming}, never reviewed ${r.new}, least recently reviewed ${r.oldest}). A full cycle takes ${r.runs} runs of ${inv.max_units} units.` : `The ${r.picked} riskiest of ${r.total} units were reviewed. Schedule with scan_issue: true to rotate through all units.`}\n\n`
      + `**How to read the unit part**\n\nA unit is a tracked source file. Its risk is (1 + public definitions) times log2(2 + lines / 50) times (1 + commits / 5 + fix commits) times a test factor (1.0 no matched test, 0.6 tests with no assertion, all skipped or mostly weak, 0.3 tested); commits are those of the last 180 days. A test file is matched to a unit by name, by mention or by folder. The ranking orders the work of one scan; it is not a prediction of defects. A finding is confirmed when it is a missing test for a unit with no matched test file, or when the same finding was reported in the previous run${prior ? '' : ' (there is no earlier run, so every other finding is unconfirmed)'}. Static review; not coverage; not for scoring people.\n\n`;
    const left = Math.max(0, inv.units - r.reviewed);
    cdet = take(`**Riskiest units (top ${Math.min(30, inv.rows.length)} of ${inv.units})**\n\n${URISK}`, inv.rows.slice(0, 30).map(urow), '') + fit(text)
      + (left ? take(`**Units not yet reviewed (${left})**\n\n`, [...inv.unreviewed.slice(0, 30).map((u) => `- ${link(u.path, 1, u.path)} (risk ${u.score})\n`), ...(left > 30 ? [`- +${left - 30} more\n`] : [])], '') : '')
      + ulists.map((l) => more(l.more, l.fs.map(uhead), '', UCAP)).join('')
      + (ulow.length ? take(`**Low-confidence unit findings (${ulow.length})**\n\nA test file the model could not see whole, or a test that may already cover it, is behind each; they are not counted.\n\n`, ulow.map(uhead), '') : '');
  }
  let det = [more('More confirmed gaps', confirmed.map(grow), GTOP), more('More new gaps', fresh.map(grow), GTOP), more('More disagreements', clashes, '| Document says | Code says |\n|---|---|\n')].join('');
  const fold = (s, bs) => take(`**${s} (${bs.length})**\n\n${BTOP}`, bs.map(bline), '');
  det += fold('Unsure', unsure) + fold('Covered', covered);
  for (const g of evid) det += take(`**Sub-row evidence: ${cell(g.path, 200).replace(/[<>&]/g, '')} (${g.rows.length} row${g.rows.length === 1 ? '' : 's'})**\n\n| Requirement | Status | Class | Evidence |\n|---|---|---|---|\n`, g.rows, '');
  const details = cdet || dh || det || df || drun ? `<details><summary>${failure ? 'Details: run information' : code ? 'Details: riskiest units, inventory, rotation, document blocks, sources' : 'Details: changed since last scan, evidence per block, skipped blocks, coverage of rotation, sources'}</summary>\n\n${cdet}${dh}${det}${df}${drun}\n</details>\n` : '';
  const omit = omitted ? `\n_${omitted} row${omitted === 1 ? '' : 's'} omitted: the report exceeded the size limit; \`audit.json\` in the run artifact has them all._\n` : '';
  return top + visibleNr + body + omit + details + tail;
}

// Only 2-run-stable changes are listed (confirmed gaps that appeared or resolved); status churn between the last two runs is counted, not listed.
function changedSince(prior, blocks) {
  const sec = (title, a) => (a.length ? `- ${title} (${a.length}):\n${a.slice(0, SHOW).map((b) => `  - \`${b.cid}\` ${cell(b.text, 160)}\n`).join('')}${a.length > SHOW ? `  - +${a.length - SHOW} more\n` : ''}` : '');
  const at = (m) => blocks.filter((b) => b.mark === m);
  const body = sec('Confirmed gaps that appeared', at('confirmed').filter((b) => b.next[3] === 2)) + sec('Resolved (covered in two runs)', at('resolved')) + sec('Resolved? Covered once, recheck next run', at('recheck'));
  const n = blocks.filter((b) => b.was && b.was !== b.status && b.mark !== 'resolved' && b.mark !== 'recheck').length;
  return `**Changed since the last scan${prior.head ? ` (\`${cell(prior.head.slice(0, 7), 12)}\`)` : ''}**\n\n${body || 'No confirmed changes.\n'}${n ? `\nUnstable: ${n} block${n === 1 ? '' : 's'} changed status between the last two runs (not listed).\n` : ''}\n`;
}

// Our scan issue among open and closed issues (marker plus identity); an open one wins.
async function findIssue({ github, owner, repo, me, mark = MARK, title = '' }) {
  // ponytail: lists every issue; narrow with a label or `creator` if a repo has thousands
  const all = await github.paginate(github.rest.issues.listForRepo, { owner, repo, state: 'all', per_page: 100 });
  const mine = all.filter((i) => !i.pull_request && ours(i.user, me) && (!title || i.title === title) && typeof i.body === 'string' && i.body.startsWith(mark));
  return mine.find((i) => i.state !== 'closed') || mine[0] || null;
}

const whoami = async (github) => { try { return (await github.rest.users.getAuthenticated()).data.login; } catch { return null; } };
const wantsIssue = (env) => String(env.SCAN_ISSUE || env.AUDIT_ISSUE).toLowerCase() === 'true'; // scan_issue wins; audit_issue is the deprecated alias

async function main({ github, issueGithub, context, core, date = today() }) {
  const env = process.env, ctx = env.CTX;
  const readCtx = (n) => { try { return fs.readFileSync(path.join(ctx, n), 'utf8'); } catch { return null; } };
  const { owner, repo } = context.repo, sha = context.sha || env.GITHUB_SHA || '';
  const blob = sha ? `${env.GITHUB_SERVER_URL || 'https://github.com'}/${owner}/${repo}/blob/${sha}` : '';
  const json = (n) => { try { return JSON.parse(readCtx(n) ?? ''); } catch { return null; } };
  const meta = json('audit-meta.json');
  const tab = (n) => lines(readCtx(n)).map((l) => l.split('\t'));
  const docs = tab('audit-docs.txt'), rejected = tab('audit-rejected.txt');
  const ruled = tab('audit-ruled.txt').flatMap(([cid, loc = '', , text = '', reason = ''], k) => (/^[0-9a-f]{8}$/.test(cid) && (k = loc.lastIndexOf(':')) > 0 ? [{ cid, path: loc.slice(0, k), line: +loc.slice(k + 1), text, reason }] : []));
  const engine = env.ENGINE || '';
  let usage = json('usage.json');
  usage = mergeUsage(usage, json('usage-repair.json')); // copilot repair turn, claude finalize turn
  const repair = (readCtx('engine-repair') || '').trim();
  const notes = [...lines(readCtx('engine-notes')).map((x) => x.trim()).slice(0, 4), ...(repair === 'repaired' ? ['JSON repaired in one extra turn'] : repair === 'repair_failed' ? ['JSON repair turn failed'] : [])];
  const usageHtml = engine ? usageLine({ engine, model: env.MODEL || '', raw: usage, notes }) : '', runHtml = engine ? runLine({ engine, model: env.MODEL || '', raw: usage, notes }) : '';
  const cap = meta && meta.max_requirements;
  const cands = readCandidates(readCtx('audit-candidates.txt'));
  let wantIssue = wantsIssue(env);
  // ISSUE_REPO (scan_issue_repo): the issue lives in another repository under its own client (issueGithub); one issue per scanned repository, told apart by the title
  const ir = /^([\w.-]+)\/([\w.-]+)$/.exec(env.ISSUE_REPO || ''), away = !!ir && !(ir[1] === owner && ir[2] === repo);
  if (env.ISSUE_REPO && !ir && wantIssue) { wantIssue = false; core.warning('SpecGuard: scan_issue_repo is not owner/name; no scan issue is written'); }
  const igh = issueGithub || github, issueRepo = away ? { owner: ir[1], repo: ir[2] } : { owner, repo };
  const scope = scopeOf(env.SCAN_PATHS, away ? `${owner}/${repo}` : '');
  const shared = { head: (meta && meta.head) || '', docs, rejected, limitations: (meta && meta.limitations) || [], capLeft: (meta && meta.cap_left) || [], blob, usage: usageHtml, run: runHtml, cap, candidates: (meta && meta.candidates) || 0,
    ruled, rotation: (meta && meta.rotation) || null, search: (meta && meta.evidence) || null, scope: scope.lines };
  const outcome = (status, reason = '') => { core.setOutput?.('status', status); if (reason) core.setOutput?.('reason', reason); }; // the action's `status` output (fail_on_error)
  const finish = async (md) => { try { await core.summary.addRaw(md).write(); } catch (e) { core.warning(`SpecGuard: could not write the job summary: ${e.message}`); } };
  // issue lookup: our open or closed issue (of this scope) and the state it holds; a failure only warns
  let mine = null, prior = null;
  const lookup = async () => {
    if (!wantIssue) return;
    try {
      mine = await findIssue({ github: igh, ...issueRepo, me: await whoami(igh), mark: scope.mark, title: away ? scope.title : '' });
      prior = mine && readState(mine.body);
    } catch (e) { core.warning(`SpecGuard: could not write the scan issue (needs permissions: issues: write): ${e.message}`); mine = null; return false; }
    return true;
  };
  const publish = async (md, state) => {
    try {
      const body = `${scope.mark}\n${[md.trimEnd(), state].filter(Boolean).join('\n\n')}`;
      const flat = (s) => String(s).replace(/\r\n/g, '\n').trim();
      if (mine) {
        const closed = mine.state === 'closed';
        if (flat(body) !== flat(mine.body) || mine.title !== scope.title || closed) await igh.rest.issues.update({ ...issueRepo, issue_number: mine.number, title: scope.title, body, ...(closed ? { state: 'open' } : {}) });
      } else await igh.rest.issues.create({ ...issueRepo, title: scope.title, body });
    } catch (e) { core.warning(`SpecGuard: could not write the scan issue (needs permissions: issues: write): ${e.message}`); }
  };
  const room = (state) => ISSUE_MAX - bytes(scope.mark) - bytes(state) - 4;

  if (!meta) { outcome('failed', 'the collection step did not produce its context.'); return finish(render({ ...shared, failure: 'the collection step did not produce its context.' })); }
  if (env.SKIP === 'true') {
    outcome('complete');
    await finish(render({ ...shared, data: null }));
    // no document admitted: a stale issue must not keep claiming old results (none is created for an empty scan)
    if (wantIssue && await lookup() && mine) {
      const keep = prior ? priorState(prior) : '';
      await publish(render({ ...shared, data: null, max: room(keep) }), keep);
    }
    return;
  }
  const data = json('findings.json');
  const units = readUnits(readCtx('audit-units.txt')), inv = json('audit-inventory.json'), packCut = new Set(lines(readCtx('pack-cut.txt')));
  const hasCode = units.size > 0 && !!inv && !!inv.rotation && Array.isArray(inv.rows) && Array.isArray(inv.unreviewed); // the collector's code-first part (absent in a run that predates it)
  const v = validate(data, cands, units);
  const why = v.ok ? '' : data ? `the result failed validation: ${v.error}` : 'the engine returned no usable JSON';
  const st = (readCtx('engine-status') || '').trim();
  if (why) {
    const engineWhy = (readCtx('engine-error') || '').split('\n')[1]?.trim(); // the engine step's classified failure (quota, policy, auth, rate)
    const failure = st === 'timeout' ? 'the engine timed out (raise review_timeout_minutes)' : st === 'failed' ? engineWhy || 'the engine failed; see the job log' : why;
    outcome('failed', failure);
    return finish(render({ ...shared, failure }));
  }
  // valid JSON can still come from a run that timed out or failed (or whose repair turn failed): show what verifies, change nothing else
  const partial = st && st !== 'success' ? `engine ${st}` : repair === 'repair_failed' ? 'engine JSON repair failed' : '';

  const root = process.env.GITHUB_WORKSPACE || process.cwd(), covers = require('./test-map').makeCoverGuard({ cwd: root, testPaths: readCtx('test-paths.txt') || process.env.TEST_PATHS || '' });
  const checked = verify(data, { tracked: trackedFiles(root), docs: new Set(docs.map(([p]) => p)), cands, units, packCut, covers });
  const code = hasCode ? { list: units, inv, findings: checked.unit_findings } : null;
  try { fs.writeFileSync(path.join(ctx, 'audit.json'), JSON.stringify({ head: meta.head, ...(partial ? { partial } : {}), ...checked }, null, 2) + '\n'); } catch (e) { core.warning(`SpecGuard: could not write audit.json: ${e.message}`); }
  const looked = wantIssue && !partial && await lookup();
  // the blocks this run did not audit: the state's blocks that are still in the documents (audit-carried.txt), with the text and place from the collector
  const left = readCandidates(readCtx('audit-carried.txt')), carried = prior && shared.rotation && shared.rotation.rotate
    ? prior.blocks.filter((b) => left.has(b.cid) && !cands.has(b.cid)).map((b) => ({ ...left.get(b.cid), ...b })) : [];
  outcome(partial ? 'incomplete' : 'complete', partial);
  await finish(render({ ...shared, data: checked, partial, prior, carried, code }));
  if (!looked) return; // no issue wanted, a partial audit, or the lookup failed (a blind create could duplicate the issue)
  const cu = readUnits(readCtx('audit-units-carried.txt')); // units the state knows that this run did not review, still in the repository
  const codeState = code && { picked: [...units.keys()], findings: trackFindings(code.findings.filter((f) => !f.low), prior, meta.head), carried: prior ? prior.blocks.filter((b) => cu.has(b.cid)) : [] };
  const state = stateOf(meta.head, checked, prior, { carried, date, code: codeState });
  await publish(render({ ...shared, data: checked, prior, carried, code, stateDropped: state.dropped, max: room(state.raw) }), state.raw);
}

// Never fails the run: any error here is a warning.
module.exports = async (args) => {
  try { await main(args); } catch (e) { try { args.core.setOutput?.('status', 'failed'); args.core.setOutput?.('reason', `the scan report failed: ${e.message}`); args.core.warning(`SpecGuard: scan report failed: ${e.message}`); } catch { /* nothing left to report to */ } }
};
Object.assign(module.exports, { readCandidates, readUnits, validate, verify, trackFindings, render, gap, readState, stateComment, stateOf, blocksOf, track, scopeOf, findIssue, STATUS, CLASS, MARK, TITLE, HEADING });
