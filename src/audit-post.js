// Unit test gap scan (mode scan; audit is an alias), last step (actions/github-script): validates the model's result and every citation against the checked-out HEAD,
// renders it to the job summary and, with scan_issue (deprecated alias audit_issue), to ONE issue we own. Advisory; never fails the run.
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const { execFileSync } = require('child_process');
const post = require('./post');
const { ours } = require('./preflight');
const { enclosingName } = require('./test-map');
const { ASSERTION, TEST_DECL, SKIPPED } = post;
const { version, versionLine } = require('./version');
const { staticFindings, staticLeads } = require('./audit-units');
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
const heuristicTest = (p) => isTestPath(p) || /Tests?\.(java|kt|cs|swift|scala)$/.test(p);
// test_paths (the collector's trace.testScope) is authoritative when set; without it the name heuristic decides
const testFileOf = (testPaths) => { const scope = require('./trace').testScope(testPaths); return scope || heuristicTest; };

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
    const [cid, loc = '', heading = '', ...text] = l.split('\t'), at = /^(.+):(\d+)(?:-(\d+))?$/.exec(loc); // path:line or path:line-end (the block's last line)
    if (/^[0-9a-f]{8}$/.test(cid) && at) m.set(cid, { cid, path: at[1], line: +at[2], ...(at[3] ? { end: +at[3] } : {}), heading, text: text.join(' ') });
  }
  return m;
}
const ctxCandidates = () => { try { return readCandidates(fs.readFileSync(path.join(process.env.CTX, 'audit-candidates.txt'), 'utf8')); } catch { return null; } };
// audit-units.txt (id, path, risk, why, matched tests, leads: tab separated) -> Map id -> { id, path, score, why, tests: [paths], leads }, in risk order. The units this run reviews.
function readUnits(txt) {
  const m = new Map();
  for (const l of lines(txt)) {
    const [id, p = '', score = '0', why = '', tests = 'none', leads = '-', ver = '', part = '-'] = l.split('\t');
    const w = /^part (\d+)\/(\d+) lines (\d+)-(\d+)$/.exec(part); // a unit reviewed in parts: this run's window (audit-units.js partOf)
    if (/^[0-9a-f]{8}$/.test(id) && p) {
      const win = w && +w[1] >= 1 && +w[1] <= +w[2] ? { k: +w[1] - 1, n: +w[2], a: +w[3], b: +w[4] } : null, was = m.get(id) && m.get(id).part;
      // a stateless run lists several parts of one unit (one row each): they merge into one unit; ks = the parts, spans = their line windows, k = the last part
      if (was && win) { (was.ks ||= [was.k + 1]).push(win.k + 1); (was.spans ||= [[was.a, was.b]]).push([win.a, win.b]); was.k = Math.max(was.k, win.k); was.a = Math.min(was.a, win.a); was.b = Math.max(was.b, win.b); continue; }
      m.set(id, { id, path: p, score: +score || 0, why, tests: tests === 'none' ? [] : tests.split(', ').filter(Boolean), leads, ...(/^[0-9a-f]{8}$/.test(ver) ? { ver } : {}), ...(win ? { part: win } : {}) });
    }
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
  const kept = [], conflicts = new Set();
  for (const [i, r] of o.requirements.entries()) {
    const w = `requirements[${i}]`;
    const drop = (why) => { unusable++; first ||= `${w}: ${why}`; notes.push(`${w} dropped: ${why}.`); };
    if (!r || typeof r !== 'object' || Array.isArray(r)) { drop('not an object'); continue; }
    const cid = cidOf(r.id), cand = cands && cid && cands.get(cid);
    if (cand && skipped.has(cid)) conflicts.add(cid); // before any drop: a conflicting block never stays excluded, even when its requirement row is malformed
    if (!text(r.text) && cand) r.text = cand.text; // the block's own text, from the trusted candidate list
    if (!text(r.id) || !text(r.text)) { drop('id and text are required'); continue; }
    if (ids.has(r.id)) { drop(`duplicate id ${String(r.id).slice(0, 40)}`); continue; }
    if (cands && (!cid || !cands.has(cid))) { drop(`id ${String(r.id).slice(0, 40)} is not a listed block id (the block cid, or cid.1, cid.2)`); continue; }
    const conflict = conflicts.has(cid); // a conflict needs a person: the row stays, unknown, so the obligation never leaves the denominator
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
    if (conflict) {
      r.status = 'unknown';
      r.note = `${r.note} Also answered as not a requirement (${oneLine(skips.find((n) => n.cid === cid).reason, 120)}); status unknown until a person decides.`.trim();
      notes.push(`${w}: block ${cid} was answered both as a requirement and as not a requirement; kept as unknown.`);
    }
    for (const c of [r.source, ...r.code, ...r.tests]) c.quote = c.quote.slice(0, 200); // a prefix of a verbatim quote still verifies
    if (problems.length) { unusable++; first ||= `${w}: ${problems[0]}`; notes.push(`${w} marked unknown: ${problems.join('; ')}.`); }
    if (cid) answered.add(cid);
    kept.push(r);
  }
  if (unusable * 2 > o.requirements.length) return bad(`${first} (${unusable} of ${o.requirements.length} requirement rows are unusable)`);
  o.requirements = kept;
  for (const c of conflicts) { skipped.delete(c); if (!answered.has(c)) notes.push(`block ${c} was answered as not a requirement and by a requirement row that was dropped; it stays unknown.`); }
  o.not_requirements = skips.filter((n) => !conflicts.has(n.cid));
  if (cands) {
    const missing = [...cands.keys()].filter((k) => !answered.has(k) && !skipped.has(k) && !conflicts.has(k));
    if (missing.length > cands.size * MISSING_MAX) return bad(`${missing.length} of ${cands.size} listed blocks were not answered (e.g. ${missing.slice(0, 5).join(', ')}); answer every block exactly once`);
  }
  // unit_findings (code-first): a malformed row is dropped with a note, never a reason to reject the result. A finding must name a listed unit (units: Map from readUnits; null = unknown).
  if (o.unit_findings === undefined || o.unit_findings === null) o.unit_findings = [];
  if (!Array.isArray(o.unit_findings)) { notes.push('unit_findings was not an array; ignored.'); o.unit_findings = []; }
  const keep = [], invalid = new Set(); // invalid: listed units whose finding failed validation; they were not reviewed, never "no gap"
  for (const [i, f] of o.unit_findings.entries()) {
    const w = `unit_findings[${i}]`, drop = (why) => notes.push(`${w} dropped: ${why}.`);
    if (!f || typeof f !== 'object' || Array.isArray(f)) { drop('not an object'); continue; }
    f.kind = slug(f.kind); f.line = whole(f.line); f.unit = typeof f.unit === 'string' ? f.unit.trim().toLowerCase() : f.unit;
    if (!/^[0-9a-f]{8}$/.test(f.unit)) drop('unit must be a unit id (8 hex characters)');
    else if (units && !units.has(f.unit)) drop(`unknown unit ${f.unit}; only the listed units may be reviewed`);
    else if (!UNIT_KINDS.includes(f.kind)) { invalid.add(f.unit); drop(`kind must be one of ${UNIT_KINDS.join(', ')}`); }
    else if (!text(f.path) || !Number.isInteger(f.line) || f.line < 1 || !text(f.quote) || !text(f.title)) { invalid.add(f.unit); drop('path, line, quote and title are required'); }
    else if (keep.length >= UNIT_MAX) { invalid.add(f.unit); drop(`more than ${UNIT_MAX} findings; the rest are ignored`); }
    else keep.push({ unit: f.unit, kind: f.kind, path: f.path, line: f.line, quote: f.quote.slice(0, 200), title: f.title.trim().slice(0, 120), body: text(f.body) ? f.body.trim() : '', skeleton: text(f.skeleton) ? f.skeleton.replace(/\s+$/, '') : '',
      ...(text(f.counterexample) ? { counterexample: f.counterexample.trim().slice(0, 300) } : {}) });
  }
  o.unit_findings = keep;
  o.invalid_units = [...invalid].filter((u) => !keep.some((k) => k.unit === u));
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
function verify(data, { read = readFile, tracked = null, docs = null, cands = null, units = null, packCut = new Set(), blockCuts = {}, covers = null, testPaths = '' } = {}) {
  const testFile = testFileOf(testPaths);
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
    // the row's source is its own candidate's block (same document, a line inside it; a .N sub-row uses its parent's): it never borrows another requirement's quote
    const own = cands && cands.get(cidOf(r.id));
    if (own && (source.path !== own.path || source.line < own.line || source.line > (own.end ?? Infinity))) { drop(r, `its source is not the block ${own.path}:${own.line}${own.end > own.line ? `-${own.end}` : ''} that this id names`); continue; }
    const code = r.code.map((c) => ({ ...c })).filter((c) => locate(c) && !isDoc(c.path) && !testFile(c.path));
    const located = r.tests.map((c) => ({ ...c })).filter((c) => locate(c) && !isDoc(c.path) && testFile(c.path));
    // same rule as PR mode (post.verifyEvidence): a declaration, an empty or a skipped test carries no coverage
    const kinds = located.map((c) => post.assertionKind(file(c.path) || [], c.line, c.quote)), tests = located.filter((_, i) => kinds[i] === 'assertion');
    const inert = located.length - tests.length;
    const lost = r.code.length - code.length + r.tests.length - located.length;
    const cand = cands && cands.get(cidOf(r.id)), heading = cand ? cand.heading : headingAt(file(source.path), source.line);
    kept.add(cidOf(r.id));
    const row = { ...r, heading, source, code, tests, note: r.note };
    if (lost) row.note = `${row.note} ${lost} citation(s) could not be verified and were removed.`.trim();
    if (inert) row.note = `${row.note} ${inert} test citation(s) removed: not an assertion or in a skipped test.`.trim();
    if (row.status === 'covered' && tests.length && tests.every((t) => post.weakAssertion(t.quote))) {
      row.status = 'unknown';
      row.note = `${row.note} Downgraded to unknown: only truthiness/interaction assertions are cited; no assertion pins the expected value.`.trim();
    }
    const cut = blockCuts[cidOf(r.id)];
    if (Array.isArray(cut) && cut.length && ['missing_test', 'partial', 'not_implemented'].includes(row.status)) {
      row.status = 'unknown';
      row.note = `${row.note} Downgraded to unknown: evidence files were not fully visible: ${cut.join(', ')}.`.trim();
    }
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
  const dropped = new Set();
  out.unit_findings = verifyUnits(data.unit_findings || [], { locate, isDoc, units, packCut, covers: covers && ((c, u) => covers(file(c.path), c.line, c.path, u && u.tests)), symbol: covers && covers.symbol, baseline: baselineOf(tracked), notes: out.not_reviewed, file, testFile, dropped });
  out.unit_dropped = [...dropped]; // units whose finding verification dropped: not "no gap" (see main)
  return out;
}

// Unit findings (code-first), same quote-first check as a requirement citation: the quote must sit at path:line at the scanned commit (locate: verify's, which corrects a near-miss line).
// missing_test cites the unit's code, weak_test and pushdown a test file; a document is never evidence. fid = (unit id, kind, normalised quote): the stable key a second run confirms by.
// low: the claude engine's context pack cut a test file the claim depends on
// (the unit's matched tests for missing_test, the cited file for weak_test); same rule as PR mode: shown in Details, never counted. Also low: covers(c) found a test file that already contains the cited
// line's error message or literal (src/test-map.js, shared with PR mode): lowWhy names it.
// ---- precision gates for scan findings: a claim that a repo-wide symbol hit, a sibling test or a baseline system already answers is low confidence ----
// A repository tests through baselines (golden files) when >= 200 tracked files sit in a testdata/baselines or tests/baselines tree, or in __snapshots__ directories: { dir, n } of the largest tree, or null.
// ponytail: path names only; a symbol search by one identifier (whole word, case-sensitive); a sibling test is found by a call of an identifier shared by the cited assertion and the counterexample.
const BASELINE_MIN = 200, SYMBOL_MAX = 50, SYMBOL_STOP = new Set('exports visit transform process value values result results options config error errors string number object array format parse check method module target handler handlers helper helpers factory'.split(' '));
function baselineOf(tracked) {
  if (!tracked) return null;
  const n = new Map();
  for (const p of tracked) { const m = /^(.*?(?:testdata\/baselines|tests\/baselines))\//.exec(p), k = m ? m[1] : /(?:^|\/)__snapshots__\//.test(p) ? '__snapshots__' : null; if (k) n.set(k, (n.get(k) || 0) + 1); }
  const top = [...n].sort((a, b) => b[1] - a[1])[0];
  return top && top[1] >= BASELINE_MIN ? { dir: top[0], n: top[1] } : null;
}
// Another test of the same file (same describe block, or 40 lines each way) calls an identifier that both the cited assertion and the counterexample name, and asserts something: the line of that call, or 0.
const ID_SKIP = /^(?:expect|assert|should|not|new|this|true|false|null|undefined|return|const|let|var|await|async|function|it|test|describe|to[A-Z]\w*)$/;
function siblingCall(lines, line, quote, counterexample) {
  if (!Array.isArray(lines) || typeof counterexample !== 'string') return 0;
  const ids = (t) => new Set((String(t).match(/[A-Za-z_$][\w$]{2,}/g) || []).filter((x) => !ID_SKIP.test(x))), cx = ids(counterexample), names = [...ids(quote)].filter((x) => cx.has(x));
  if (!names.length) return 0;
  const at = (i) => String(lines[i - 1] ?? ''), ind = (i) => at(i).search(/\S|$/), decl = (i) => TEST_DECL.test(at(i));
  const startOf = (i) => { while (i > 1 && !decl(i)) i--; return i; }, endOf = (i) => { i++; while (i <= lines.length && !decl(i)) i++; return i; };
  const own = startOf(line), ownEnd = endOf(line);
  let a = Math.max(1, line - 40), b = Math.min(lines.length, line + 40);
  for (let i = line; i >= 1; i--) if (/\bdescribe(?:\.\w+)?\s*\(/.test(at(i)) && ind(i) < ind(own)) { a = Math.min(a, i); for (let j = line; j <= lines.length; j++) if (ind(j) === ind(i) && /^\s*[})\]]/.test(at(j))) { b = Math.max(b, j); break; } break; }
  const call = new RegExp(`(?<![\\w$])(?:${names.map((x) => x.replace(/\$/g, '\\$')).join('|')})\\s*\\(`);
  for (let i = a; i <= b; i++) {
    if (i >= own && i < ownEnd || !call.test(at(i))) continue;
    const s = startOf(i), span = Array.from({ length: endOf(i) - s }, (_, k) => at(s + k));
    if (s !== own && !SKIPPED.test(span.join('\n')) && span.some((x) => !/^\s*(?:\/\/|#|\/?\*)/.test(x) && ASSERTION.test(x))) return i;
  }
  return 0;
}
// a unit finding that says there is nothing to report
const NO_GAP = /\bno (?:gap|finding)\b|\bcovered; no\b/i;

function verifyUnits(list, { locate, isDoc, units, packCut, covers = null, symbol = null, baseline = null, notes, file = () => null, testFile = heuristicTest, dropped = new Set() }) {
  // a cut matched test makes a missing_test low only when it mentions (whole word) the definition enclosing the cited line; no name or an unreadable cut test: low, as before
  const cutTest = (u, c) => {
    const cutTests = u.tests.filter((t) => packCut.has(t));
    if (!cutTests.length) return false;
    const name = enclosingName(file(c.path) || [], c.line), re = name && new RegExp(`(?<![\\w$])${name.replace(/\$/g, '\\$')}(?![\\w$])`);
    return !re || cutTests.some((t) => { const body = file(t); return !body || re.test(body.join('\n')); });
  };
  const out = [], seen = new Set(), key = (q) => String(q).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  let symbols = 0, baselineNoted = 0;
  for (const f of list) {
    const c = { path: f.path, line: f.line, quote: f.quote }, at = `unit finding "${oneLine(f.title, 60)}" (${f.path}:${f.line})`, u = units && units.get(f.unit);
    if (!locate(c)) { notes.push(`${at}: ${solid(f.quote) ? 'the quote was not found at the cited line' : `the quote is under ${MIN_QUOTE} characters`}`); dropped.add(f.unit); continue; }
    if (isDoc(c.path) || (f.kind === 'missing_test') === testFile(c.path)) { notes.push(`${at}: ${f.kind === 'missing_test' ? 'a missing_test cites the unit\'s code, not a test or a document' : `a ${f.kind} cites a test file`}`); dropped.add(f.unit); continue; }
    if (u && u.part && c.path === u.path && !(u.part.spans || [[u.part.a, u.part.b]]).some(([a, b]) => c.line >= a && c.line <= b)) { notes.push(`${at}: outside this run's part of the unit (lines ${u.part.a}-${u.part.b}); that part is reviewed in another run`); continue; }
    if (NO_GAP.test(f.title) || NO_GAP.test(f.body || '')) { notes.push(`${at}: dropped: the finding says there is no gap`); continue; }
    const fid = sha8(f.unit, f.kind, key(c.quote));
    if (seen.has(fid)) continue;
    seen.add(fid);
    const skeleton = f.skeleton && placeholder(f.skeleton) ? '' : f.skeleton;
    if (skeleton !== f.skeleton) notes.push(`${at}: skeleton omitted: placeholder`);
    const cut = !!u && (f.kind === 'missing_test' ? cutTest(u, c) :f.kind === 'weak_test' && packCut.has(c.path)), hit = !cut && f.kind === 'missing_test' && covers ? covers(c, u) : null;
    let gate = null; // still deterministic, but answered elsewhere: baselines, a symbol hit in some test, a sibling test
    if (!cut && !hit && f.kind === 'missing_test') {
      if (baseline) { gate = `this repository tests through baselines (${baseline.dir}, ${baseline.n} files); check whether a baseline exercises it`; if (!baselineNoted++) notes.push(`${gate}: every missing_test is shown as low confidence`); }
      else if (symbol && symbols < SYMBOL_MAX) {
        const name = enclosingName(file(c.path) || [], c.line);
        if (name && name.length >= 5 && !SYMBOL_STOP.has(name.toLowerCase())) { symbols++; const h = symbol(name, c.path); if (h) gate = `may be covered by ${h} (${name} is referenced there)`; }
      }
    } else if (!cut && f.kind === 'weak_test') {
      const s = siblingCall(file(c.path), c.line, c.quote, f.counterexample);
      if (s) gate = `another test in the same file calls it and asserts: ${c.path}:${s}`;
    }
    const noSketch = f.kind !== 'pushdown' && !skeleton; // no test sketch: "no gap found" findings arrive this way
    const vague = f.kind === 'weak_test' && (!post.counterexampleOk(f.counterexample) || post.refutedBy(c.quote, f.counterexample)); // review F04: a weak test needs a wrong behaviour the assertion still accepts
    out.push({ ...f, ...c, skeleton, fid, ...(u && u.part ? { part: u.part.k } : {}), low: cut || !!hit || !!gate || noSketch || vague, ...(hit ? { lowWhy: `a test may already cover this: ${hit}` } : gate ? { lowWhy: gate } : noSketch && !cut ? { lowWhy: 'no test sketch: the finding may not be a gap' } : vague && !cut && { lowWhy: 'no concrete wrong behaviour that the assertion still accepts' }) });
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
    const top = st === 'gap' || st === 'unsure' ? RISK.find((x) => x !== 'covered' && b.rows && b.rows.some((r) => r.status === x)) : null; // the real row status and class survive in the state: a carried row must not turn a contradiction into a missing test
    if (top) b.next.push(top, b.rows.filter((r) => r.status === top).every((r) => r.class === 'higher_level') ? 1 : 0);
  }
  return blocks;
}

// Hidden machine-readable previous state: block ids, statuses and when each block was last audited, never text, so the next run can confirm and rotate.
// v4: { head, audits: [[sha7, date]], blocks: [[cid, status, since, runs, index into audits (-1 = unknown)]] }. v3 (no audit dates) and v2 (per-row) still read.
// Code-first: a unit is a block entry (cid = the unit id: gap = it had a verified finding, covered = it had none; its audit date drives the rotation) and its findings are an optional `f`:
// [[fid, unit id, since sha7, runs]] (fid = hash of unit id, kind and normalised quote), so a finding is confirmed when the same one was reported in the previous run. Older readers ignore `f`.
const STATE_MAX = 600, FINDINGS_MAX = 300, ISO_DATE = /^\d{4}-\d\d-\d\d$/; // blocks kept (the covered, longest ago audited go first; a dropped block counts as never audited again)
const FID = (x) => Array.isArray(x) && /^[0-9a-f]{8}$/.test(x[0]) && /^[0-9a-f]{8}$/.test(x[1]) && /^[\w.-]{0,40}$/.test(x[2]) && Number.isInteger(x[3]) && x[3] >= 1 && x[3] <= MAXRUN;
const findingsOf = (o) => (Array.isArray(o.f) && o.f.length <= FINDINGS_MAX && o.f.every(FID) ? o.f.map(([fid, unit, since, runs, part]) => ({ fid, unit, since, runs, ...(Number.isInteger(part) && part >= 0 && part < 100 ? { part } : {}) })) : []); // an invalid `f` is dropped, not the state; part (optional 5th): the window of a unit reviewed in parts
// Versions (review F06), optional, ignored by older readers: uv { unit id: version } (audit-units.js: hash of the unit's and its matched tests' blobs when it was reviewed);
// ev [[cid, path hash...]]: the code and test files a covered block's verdict cited, as sha8(path) (the state holds ids, never repository text). The collector marks
// a unit or block whose inputs changed since as stale (audit-stale.txt).
const EV_PER_BLOCK = 8, HEX8 = /^[0-9a-f]{8}$/, UNBOUNDED = 'ffffffff'; // a block citing more than EV_PER_BLOCK files stores [cid, UNBOUNDED] instead of a truncated list: stale when any file changed (review S4)
const versionsOf = (o) => {
  const uv = o.uv && typeof o.uv === 'object' && !Array.isArray(o.uv) ? Object.fromEntries(Object.entries(o.uv).filter(([k, v]) => HEX8.test(k) && HEX8.test(v))) : {};
  const ev = {};
  if (Array.isArray(o.ev)) for (const x of o.ev) if (Array.isArray(x) && x.length - 1 <= EV_PER_BLOCK && x.every((h) => HEX8.test(h))) ev[x[0]] = x.slice(1);
  // uc { unit id: [next part, part count] }: the cursor of a unit reviewed in parts (audit-units.js partOf)
  const uc = o.uc && typeof o.uc === 'object' && !Array.isArray(o.uc) ? Object.fromEntries(Object.entries(o.uc).filter(([k, v]) => HEX8.test(k) && Array.isArray(v) && v.length === 2 && v.every(Number.isInteger) && v[0] >= 1 && v[0] <= 100 && v[1] > v[0] && v[1] <= 1000)) : {};
  // tv { cid: text version }: sha8 of the block's text with symbols and case kept (the cid drops them), so an edited requirement under the same cid is noticed
  const tv = o.tv && typeof o.tv === 'object' && !Array.isArray(o.tv) ? Object.fromEntries(Object.entries(o.tv).filter(([k, v]) => HEX8.test(k) && HEX8.test(v))) : {};
  // un [cid]: blocks the model did not answer in the last run; the next run retries them first, once (review S6)
  const un = Array.isArray(o.un) ? [...new Set(o.un.filter((c) => HEX8.test(c)))].slice(0, STATE_MAX) : [];
  return { uv, ev, ...(Object.keys(uc).length ? { uc } : {}), ...(Object.keys(tv).length ? { tv } : {}), ...(un.length ? { un } : {}) };
};
const versionsRaw = ({ uv = {}, ev = {}, uc = {}, tv = {}, un = [] } = {}) => {
  const rows = Object.entries(ev).map(([cid, hs]) => { const u = [...new Set(hs)]; return [cid, ...(u.length > EV_PER_BLOCK ? [UNBOUNDED] : u)]; }).filter((x) => x.length > 1);
  return { ...(Object.keys(uv).length ? { uv } : {}), ...(rows.length ? { ev: rows } : {}), ...(Object.keys(uc).length ? { uc } : {}), ...(Object.keys(tv).length ? { tv } : {}), ...(un.length ? { un } : {}) };
};
const stateRaw = (head, entries, findings = [], versions = {}) => { // entries: [cid, status, since, runs, at: { head, date } | null]; findings: [[fid, unit, since, runs]]
  const audits = [], idx = new Map();
  const blocks = entries.map(([cid, status, since, runs, at, top, hl]) => {
    const x = top ? [top, hl ? 1 : 0] : [];
    if (!at) return [cid, status, since, runs, -1, ...x];
    const k = `${at.head}@${at.date}`;
    if (!idx.has(k)) { idx.set(k, audits.length); audits.push([at.head, at.date]); }
    return [cid, status, since, runs, idx.get(k), ...x];
  });
  return `<!-- specguard:audit-state ${JSON.stringify({ v: 4, head: String(head || '').slice(0, 40), audits, blocks, ...(findings.length ? { f: findings } : {}), ...versionsRaw(versions) }).replace(/[<>]/g, (c) => (c === '<' ? '\\u003c' : '\\u003e')).replace(/--/g, '-\\u002d')} -->`;
};
const today = () => new Date().toISOString().slice(0, 10);
// This run's blocks (tracked against prior, audited now) plus the carried ones (prior blocks this run did not audit, still in the documents). dropped: carried blocks over STATE_MAX.
// code (code-first run): { picked: [unit ids audited now], findings: tracked verified findings (trackFindings), carried: prior block entries of units not audited now that are still in the repository }.
// stale: unit ids and block cids the collector found changed since their last review (audit-stale.txt): a stale carried unit's findings are not carried.
function stateOf(head, data, prior = null, { carried = [], date = today(), code = null, stale = new Set(), tv: tvNow = new Map(), unanswered = new Set() } = {}) {
  const at = { head: String(head || '').slice(0, 7), date };
  const now = track(blocksOf(data), prior, head).filter((b) => /^[0-9a-f]{8}$/.test(b.cid)).map((b) => [b.next[0], b.next[1], b.next[2], b.next[3], at, b.next[4], b.next[5]]);
  // a unit reviewed in parts (code.parts: id -> { k, n }, review F07) keeps the findings of its other parts and is covered only after its last part with none
  const parts = (code && code.parts) || new Map(), pf = (prior && prior.findings) || [];
  const pvs = (prior && prior.versions) || {}, cont = (id) => { const c = pvs.uc && pvs.uc[id]; return !!c && c[1] === parts.get(id).n && c[0] === parts.get(id).k && (!code.versions || !code.versions.get(id) || (pvs.uv || {})[id] === code.versions.get(id)); }; // the cursor continued: a restart (new version or layout) drops the findings of the old parts
  const otherParts = code ? pf.filter((x) => parts.has(x.unit) && code.picked.includes(x.unit) && !stale.has(x.unit) && Number.isInteger(x.part) && x.part !== parts.get(x.unit).k && cont(x.unit)) : [];
  // inconclusive = seen but proves nothing: dropped or low-only findings (code.unsure) and forced units whose tests were cut (code.cut); same treatment for all
  const inc = new Set([...((code && code.unsure) || []), ...((code && code.cut) || [])]);
  const held = code ? ((prior && prior.blocks) || []).filter((b) => b.status === 'gap' && inc.has(b.cid) && code.picked.includes(b.cid) && !stale.has(b.cid)) : [];
  if (code) {
    const hit = new Set([...code.findings, ...otherParts].map((f) => f.unit));
    // an inconclusive run neither proves nor disproves: a prior gap stays a gap with its findings and run count, only the date advances
    now.push(...held.map((b) => [b.cid, 'gap', b.since, b.runs, at]), ...track(code.picked.filter((cid) => !held.some((b) => b.cid === cid)).map((cid) => ({ cid, status: hit.has(cid) ? 'gap' : inc.has(cid) || parts.has(cid) && parts.get(cid).k + 1 < parts.get(cid).n ? 'unsure' : 'covered' })), prior, head).map((b) => [...b.next, at]));
  }
  const all = carried.concat(code ? code.carried : []);
  const rank = (b) => (b.status === 'covered' || b.status === 'not_req' ? 1 : 0), when = (b) => (b.at && b.at.date) || '';
  const old = all.slice().sort((a, b) => rank(a) - rank(b) || (when(a) < when(b) ? 1 : when(a) > when(b) ? -1 : 0)).slice(0, Math.max(0, STATE_MAX - now.length));
  const entry = (x) => [x.fid, x.unit, x.since, x.runs, ...(Number.isInteger(x.part) ? [x.part] : [])];
  const fs_ = code ? [...code.findings.map((f) => f.next), ...otherParts.map(entry), ...pf.filter((x) => held.some((b) => b.cid === x.unit)).map(entry), ...pf.filter((x) => !code.picked.includes(x.unit) && !stale.has(x.unit) && code.carried.some((b) => b.cid === x.unit)).map(entry)].slice(0, FINDINGS_MAX) : [];
  // versions: what each verdict was made against; a carried entry keeps its old version, so it stays stale until it is reviewed again
  const pv = (prior && prior.versions) || { uv: {}, ev: {} }, kept = new Set(old.map((b) => b.cid)), uv = {}, ev = {}, uc = {}, tv = {};
  for (const [k, v] of Object.entries(pv.tv || {})) if (kept.has(k)) tv[k] = v; // a carried block keeps the text version it was reviewed at
  for (const [k, v] of Object.entries(pv.uv)) if (kept.has(k)) uv[k] = v;
  for (const [k, v] of Object.entries(pv.uc || {})) if (kept.has(k) && !(code && code.picked.includes(k))) uc[k] = v; // a unit reviewed now gets its cursor from this run
  for (const [id, p] of parts) if (code.picked.includes(id) && p.k + 1 < p.n) uc[id] = [p.k + 1, p.n]; // the next part; after the last one the cursor is gone
  for (const [k, v] of Object.entries(pv.ev)) if (kept.has(k)) ev[k] = v;
  if (code && code.versions) for (const id of code.picked) if (code.versions.get(id)) uv[id] = code.versions.get(id);
  for (const b of blocksOf(data)) if (tvNow.get(b.cid)) tv[b.cid] = tvNow.get(b.cid); // this run's text version (audit-textver.txt)
  for (const b of blocksOf(data)) if (b.status === 'covered') ev[b.cid] = b.rows.flatMap((r) => [...r.code, ...r.tests].map((c) => sha8(c.path)));
  // unanswered once: retried first next run (collector select); unanswered again: stored unsure with this run's date and not retried (the caller names it in the limitations), so rotation moves on
  const audited = new Set(blocksOf(data).map((b) => b.cid)), un0 = new Set(pv.un || []);
  const un = [...unanswered].filter((c) => audited.has(c) && !un0.has(c)).concat([...un0].filter((c) => kept.has(c) && !audited.has(c)));
  return { raw: stateRaw(head, [...now, ...old.map((b) => [b.cid, b.status, b.since, b.runs, b.at, b.top, b.hl])], fs_, { uv, ev, uc, tv, un }), dropped: all.length - old.length };
}
// Verified unit findings against the previous state: confirmed = the same finding (unit, kind, quote) was reported in the previous run (`!!p`).
// -> copies with .confirmed and .next, the state entry [fid, unit, first-seen sha7, consecutive runs].
function trackFindings(list, prior, head = '') {
  const was = new Map(((prior && prior.findings) || []).map((x) => [x.fid, x])), h = String(head || '').slice(0, 7);
  return list.map((f) => { const p = was.get(f.fid); return { ...f, confirmed: !!p, next: [f.fid, f.unit, p ? p.since : h, Math.min((p ? p.runs : 0) + 1, MAXRUN), ...(Number.isInteger(f.part) ? [f.part] : [])] }; });
}
const stateComment = (head, data, prior = null, opts) => stateOf(head, data, prior, opts).raw;
const priorState = (p) => stateRaw(p.head, p.blocks.map((b) => [b.cid, b.status, b.since, b.runs, b.at, b.top, b.hl]), (p.findings || []).map((x) => [x.fid, x.unit, x.since, x.runs, ...(Number.isInteger(x.part) ? [x.part] : [])]), p.versions);
function readState(body) {
  const m = STATE_RE.exec(String(body || ''));
  if (!m) return null;
  try {
    const o = JSON.parse(m[1]), head = String((o && o.head) || '');
    const v = o && (o.v === 3 || o.v === 4) && Array.isArray(o.blocks), audits = o && o.v === 4 && Array.isArray(o.audits) ? o.audits : [];
    if (v && (o.v === 3 || (Array.isArray(o.audits) && audits.every((a) => Array.isArray(a) && /^[\w.-]{0,40}$/.test(a[0]) && ISO_DATE.test(a[1]))))
      && o.blocks.every((x) => Array.isArray(x) && /^[0-9a-f]{8}$/.test(x[0]) && BSTATE.includes(x[1]) && /^[\w.-]{0,40}$/.test(x[2]) && Number.isInteger(x[3]) && x[3] >= 1 && x[3] <= MAXRUN
        && (o.v === 3 || (Number.isInteger(x[4]) && x[4] >= -1 && x[4] < audits.length)) && (x[5] === undefined || (STATUS.includes(x[5]) && (x[6] === 0 || x[6] === 1)))))
      return { head, blocks: o.blocks.map(([cid, status, since, runs, a, top, hl]) => ({ cid, status, since, runs, at: o.v === 4 && a >= 0 ? { head: audits[a][0], date: audits[a][1] } : null, ...(top ? { top, hl } : {}) })), ...(findingsOf(o).length ? { findings: findingsOf(o) } : {}), ...((vs) => (Object.keys(vs.uv).length || Object.keys(vs.ev).length || vs.uc || vs.tv || vs.un ? { versions: vs } : {}))(versionsOf(o)) };
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
function render({ data, docs = [], rejected = [], limitations = [], capLeft = [], blob = '', usage = '', run = '', failure = '', partial = '', prior = null, head: sha = '', refNote = '', cap = 0, candidates = 0, max = SUMMARY_MAX,
  carried = [], rotation = null, search = null, scope = [], stateDropped = 0, ruled = [], code = null, notAudited = { blocks: [], failed: 0, dropped: 0 }, unanswered = 0 }) {
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
  const unseen = (code && code.unseen) || [], failedS = new Set(code ? code.failed || (code.unitsFailed ? unseen : []) : []), reachS = new Set((code && code.unreached) || []), unfit = failedS.size ? 'were not reviewed: the unit call failed' : reachS.size ? 'were not reached (max_budget_usd)' : "did not fit the model's context", forcedS = new Set(inv && Array.isArray(inv.forced) ? inv.forced : []), lost = unseen.filter((u) => !forcedS.has(u) || failedS.has(u) || reachS.has(u)), seenN = inv ? inv.rotation.picked - lost.length : 0; // a forced unit (tests cut, recorded unsure) was reviewed: it counts as seen here, only the funnel line tells it apart // unseen: picked units the model's context did not hold whole (pack-cut.txt): not reviewed this run
  const riskiest = inv && lost.length ? `${seenN} unit${seenN === 1 ? '' : 's'} that fit the model's context` : inv ? (inv.rotation.picked === 1 ? 'riskiest unit' : `${inv.rotation.picked} riskiest units`) : '';
  // static test signals (no model): rule-based leads for the reviewed units, from the inventory's counts; an older inventory without `signals` has none. Never counted as gaps, never in the state.
  const sigRows = code && inv && Array.isArray(inv.rows) ? inv.rows.filter((r) => code.list.has(r.id)) : [], sig = staticFindings(sigRows), lead = staticLeads(sigRows), sigUnits = new Set([...sig, ...lead.items].map((s) => s.unit)).size; // lead: exact-location facts (a truthiness-only assertion, an exported name no test mentions), top 20 by unit risk
  const docless = !!code &&!docs.length && !rows.length; // a repository without design documents: the document statistics would only say zero
  // carried blocks: the previous status, no sub-rows; a pending recheck stays pending; blocks that were not requirements are only counted
  // a carried covered block whose cited code or tests changed since (p.stale, review F06) is no longer shown as covered: unsure until it is audited again
  const old = carried.filter((p) => p.status !== 'not_req').map((p) => ({ cid: p.cid, path: p.path, line: p.line, text: p.text, rows: [], carried: true, at: p.at, top: p.top, hl: p.hl, next: [p.cid, p.status, p.since, p.runs],
    ...(p.stale && (p.status === 'covered' || p.status === 'recheck') ? { status: 'unsure', mark: 'stale' }
      : { status: p.status === 'recheck' ? 'covered' : p.status, mark: p.status === 'recheck' ? 'recheck' : p.status === 'gap' ? (p.runs >= 2 ? 'confirmed' : 'new') : '' }) }));
  const name = (r) => `${link(r.source.path, r.source.line, r.id)}`;
  const evidence = (r) => [r.code.length ? `code: ${r.code.map(at).join('; ')}` : '', r.tests.length ? `tests: ${r.tests.map((t) => `${t.layer} ${at(t)}`).join('; ')}` : ''].filter(Boolean).join('<br>');
  const first = (r) => `${name(r)} ${cell(r.text, 300)}${r.note ? `<br><sub>${cell(r.note, 300)}</sub>` : ''}`;
  const label = (b) => (b.status === 'gap' ? (b.mark === 'confirmed' ? `gap (reported in two runs${b.next[2] ? ` since ${cell(b.next[2], 12)}` : ''})` : 'gap (first report)')
    : b.mark === 'resolved' ? 'covered (resolved)' : b.mark === 'recheck' ? 'covered (resolved? recheck next run)' : b.mark === 'stale' ? 'covered when last audited; its code, tests or requirement text changed since (recheck due)' : b.status);
  const subs = (b) => count(b.rows, 'status', RISK).map(([v, n]) => `${v.replace(/_/g, ' ')} ×${n}`).join(', ');
  const bline = (b) => `| \`${b.cid}\` | ${link(b.path, b.line, `${b.path}:${b.line}`)} | ${cell(b.text, 120)} | ${label(b)}${b.carried ? `<br><sub>from ${b.at ? cell(b.at.date, 12) : 'an earlier run'}</sub>` : ''} | ${subs(b)} |\n`;
  const BTOP = '| Block | Line | Requirement | Status | Sub-rows |\n|---|---|---|---|---|\n';
  const of = (s, m) => blocks.concat(old).filter((b) => b.status === s && (!m || b.mark === m));
  const confirmed = of('gap', 'confirmed'), fresh = of('gap', 'new'), unsure = of('unsure'), covered = of('covered');
  const evid = []; // per-document sub-row evidence
  for (const r of rows) {
    let g = evid.find((x) => x.path === r.source.path);
    if (!g) evid.push(g = { path: r.source.path, rows: [], cov: [] });
    (r.status === 'covered' ? g.cov : g.rows).push(`| ${first(r)} | ${r.status.replace(/_/g, ' ')} | ${r.class.replace(/_/g, ' ')} | ${evidence(r) || 'none'} |\n`);
  }

  const by = (pairs) => pairs.map(([v, n]) => `${v} ${n}`).join(' · ') || 'none';
  const docCount = new Set(rows.map((r) => r.source.path)).size;
  // how much of the repository this run covers, and how its blocks were chosen
  const lg = (() => { // unique block ids: selected = picked; audited now = selected minus the blocks of a failed or dropped part; audited ever = the state's blocks still in the documents plus those audited now
    const k = rotation ? rotation.picked : 0, skipN = new Set(notAudited.blocks.map((b) => b.cid)).size, notes = [];
    const now = Math.max(0, k - skipN);
    let ever = new Set(carried.map((b) => b.cid)).size + now;
    if (skipN > k) notes.push('coverage counts were inconsistent (more blocks not audited than selected) and were clamped');
    if (candidates && ever > candidates) { notes.push(`coverage counts were inconsistent (${ever} audited at least once of ${candidates} blocks) and were clamped`); ever = candidates; }
    return { k, now, ever, notes };
  })();
  const coverage = () => {
    const where = scope.length ? `Units reviewed (scan_paths): ${scope.map((l) => `\`${cell(l, 100)}\``).join(', ')}; requirements, tests and evidence are read from the whole repository.\n\n` : '';
    if (!rotation || !candidates) return where;
    const k = lg.k;
    const found = search && search.blocks ? `Evidence candidates found before the model ran: ${search.with_code} of ${search.blocks} blocks have a code location, ${search.with_tests} a test location.\n\n` : '';
    if (!rotation.rotate) return `${where}${k < candidates ? `Scanned in document order: the first ${k} of ${candidates} blocks (cap ${cap}). Schedule with scan_issue: true to rotate through all blocks.\n\n` : ''}${found}`;
    return `${where}Coverage: ${lg.ever} of ${candidates} blocks audited at least once; this run audited ${lg.now} (changed ${rotation.changed}, confirming ${rotation.confirming}, new ${rotation.new}, oldest ${rotation.oldest}).\n\n${found}`;
  };
  // Visible = what to act on: confirmed gaps, new gaps to confirm, documents and code that disagree, and "Not reviewed" when the scan is incomplete. Everything else sits in ONE Details block.
  const skipped = data ? data.not_requirements || [] : [], gapN = confirmed.length + fresh.length;
  const NEXT = { contradicted: 'The code contradicts it: see Documents and code disagree.', not_implemented: 'Not implemented: add the behaviour and a unit test.', missing_test: 'Add a unit test that checks it.', partial: 'Strengthen the unit test: it checks only part of it.' };
  const HIGH = { missing_test: 'Add a component or integration test that checks it.', partial: 'Strengthen the component or integration test: it checks only part of it.' };
  const nextStep = (b) => { // a requirement only a higher layer can prove asks for a test at that layer
    if (b.mark === 'stale') return 'Covered when last audited; its code, tests or requirement text changed since. It is rechecked first in the next run.';
    if (b.carried && b.top) return b.top === 'contradicted' ? 'The code contradicted it when last audited: fix the code or the requirement.' : (b.hl && HIGH[b.top]) || NEXT[b.top] || NEXT.missing_test; // a carried row has no sub-rows: its status comes from the state
    const v = RISK.find((x) => GAP.includes(x) && b.rows.some((r) => r.status === x)) || 'missing_test', rs = b.rows.filter((r) => r.status === v);
    return (rs.length && rs.every((r) => r.class === 'higher_level') && HIGH[v]) || NEXT[v];
  };
  const grow = (b) => `| ${link(b.path, b.line, `${b.path}:${b.line}`)} ${cell(b.text, 120)}${b.carried ? `<br><sub>from ${b.at ? cell(b.at.date, 12) : 'an earlier run'}</sub>` : ''} | ${nextStep(b)} |\n`;
  const GTOP = '| Document says | Next step |\n|---|---|\n';
  const clashes = rows.filter((r) => r.status === 'contradicted').map((r) => `| "${cell(r.source.quote, 200)}"<br>${at(r.source)} | "${cell(r.code[0].quote, 200)}"<br>${r.code.map(at).join('; ')} |\n`);
  const nr = [...(data ? data.not_reviewed : []), ...capLeft, ...limitations, ...lg.notes, ...(stateDropped ? [`the scan issue state keeps at most ${STATE_MAX} blocks: ${stateDropped} older block(s) are dropped and will count as never audited`] : [])];
  const unread = data ? docs.filter(([p]) => !data.docs_reviewed.includes(p)).map(([p]) => `\`${p}\` was admitted but is not in docs_reviewed.`) : [];
  const nrAll = [...nr, ...unread];
  const where = sha ? ` in the design documents at \`${cell(sha.slice(0, 7), 12)}\`` : ' in the design documents';
  const found = [confirmed.length && `${confirmed.length} gap${confirmed.length === 1 ? '' : 's'} reported in two runs`, fresh.length && (confirmed.length ? `${fresh.length} first reported` : `${plural(fresh.length, 'new gap')} (first report)`)].filter(Boolean).join(', ');
  let verdict;
  const at7 = sha ? ` at \`${cell(sha.slice(0, 7), 12)}\`` : '', gaps = uf.filter((f) => f.kind !== 'pushdown').length, down = uf.length - gaps, unitPart = uf.length ? `${[gaps && plural(gaps, 'unit test gap'), down && plural(down, 'test to move down', 'tests to move down')].filter(Boolean).join(' and ')} in the ${riskiest}` : '', docPart = found ? `${found} in the design documents` : '';
  if (failure) verdict = `**⚠️ Could not complete: ${cell(failure, 400)}**`;
  else if (code && data) {
    const both = [unitPart, docPart].filter(Boolean).join('; ');
    if (partial) verdict = `**⚠️ Incomplete scan: ${both ? `${both} found so far` : 'no unit test gaps found so far'}**`;
    else if (both) verdict = `**❌ ${both}**${at7}. Static review; tests were not run.`;
    else if (lost.length && !seenN) verdict = `**⚠️ The scan could not review any unit: ${code.unitsFailed ? 'the unit call failed' : reachS.size ? 'max_budget_usd did not cover the unit calls' : "none fit the model's context"}**${at7}.`;
    else if (unsure.length) verdict = `**❔ No unit test gaps in the ${riskiest}; ${plural(unsure.length, 'block')} need${unsure.length === 1 ? 's' : ''} a person to check**${at7}. Static review; tests were not run.`;
    else if (sigUnits) verdict = `**❔ No model-verified unit test gaps in the ${riskiest}; ${plural(sigUnits, 'unit')} ${sigUnits === 1 ? 'has' : 'have'} static test signals to check**${at7}. Static review; tests were not run.`;
    else verdict = `**✅ No unit test gaps in the ${riskiest}**${at7}. Static review; tests were not run.`;
  }
  else if (!data) verdict = '**No design documents were found, so nothing was scanned.**';
  else if (partial) verdict = `**⚠️ Incomplete scan: ${found ? `${found} found so far` : 'no unit test gaps found so far'}**`;
  else if (gapN) verdict = `**❌ ${found}**${where}. Static review; tests were not run.`;
  else if (unsure.length) verdict = `**❔ No gaps found; ${plural(unsure.length, 'block')} need${unsure.length === 1 ? 's' : ''} a person to check**${where}. Static review; tests were not run.`;
  else verdict = `**✅ No unit test gaps found**${where}. Static review; tests were not run.`;
  if (data && !failure && (notAudited.blocks.length || (code && code.unitsFailed) || unseen.length || unanswered > 0) && /^\*\*[✅❔]/u.test(verdict)) verdict = `**⚠️ Incomplete scan: no gaps found so far${unsure.length ? `; ${plural(unsure.length, 'block')} need${unsure.length === 1 ? 's' : ''} a person to check` : ''}**`; // never the clean form when part of the scan did not run
  if (data && !failure && notAudited.blocks.length) verdict = verdict.replace(/^(\*\*[\s\S]*?)\*\*/, `$1; ${plural(notAudited.blocks.length, 'document block')} not audited (${[notAudited.failed && 'a call failed', notAudited.dropped && 'left out by max_budget_usd'].filter(Boolean).join(', ')})**`);
  let top = `## ${HEADING}\n\n${verdict}\n\n${refNote ? `${refNote}\n\n` : ''}`;
  if (code && data && !failure && !partial) { // the shape of the unit result in one glance (not for an incomplete run)
    const n = (k) => uf.filter((f) => f.kind === k).length, cellOf = (k) => (n(k) ? `${n(k)}` : 'none'), r = inv.rotation;
    top += `| Units reviewed | No unit test | Weak tests | Skipped tests | Design documents |\n|---|---|---|---|---|\n| ${seenN} of ${r.total}${r.rotate ? ` (rotation ${r.run} of ${r.runs})` : ''} | ${cellOf('missing_test')} | ${cellOf('weak_test')} | ${(inv.selected && inv.selected.skipped_tests) || 'none'} | ${docs.length ? `${docs.length} read` : 'none found'} |\n\n`;
  }
  if (code && !failure && inv.eligible != null) { // one line that reconciles the funnel: eligible = inventoried + over 512 KiB; selected = reviewed whole + did not fit + forced
    const fz = new Set(inv.forced || []), F = unseen.filter((u) => fz.has(u) && !failedS.has(u) && !reachS.has(u)).length, N = unseen.filter((u) => reachS.has(u)).length, C = unseen.length - F - N, S = inv.rotation.picked, R = S - unseen.length, D = Math.max(0, inv.units - inv.rotation.reviewed) + C + N;
    top += `Units: ${[`${inv.eligible} eligible = ${[`${inv.units} inventoried`, inv.not_inventoried && `${inv.not_inventoried} not inventoried (over 512 KiB)`, inv.not_reached_cap && `${inv.not_reached_cap} past the inventory cap`, inv.not_reached_time && `${inv.not_reached_time} unread when the time budget ran out`].filter(Boolean).join(' + ')}`, `${S} selected this run = ${[R && `${R} reviewed whole`, C && `${C} did not fit`, F && `${F} forced (recorded unsure)`, N && `${N} not reached (budget)`].filter(Boolean).join(' + ')}`, D && `${D} not yet reviewed`].filter(Boolean).join('; ')}.

`;
  }
  const inParts = code ? [...code.list.values()].filter((u) => u.part && !unseen.includes(u.id)) : []; // too large for one call: one part per run (review F07)
  const allParts = !!(inv && inv.all_parts), partsLeft = new Map(((inv && inv.parts_left) || []).map((x) => [x.path, x])); // a stateless run plans every part of a unit; parts_left: the ones no call had room for
  if (code && data && !failure && inParts.length) top += `**Reviewed in parts** (too large for one call; ${allParts ? 'every part planned in this run, as far as max_budget_usd reaches' : 'one part per run'}): ${inParts.slice(0, 5).map((u) => `\`${cell(u.path, 100)}\` ${(u.part.ks || [u.part.k + 1]).length > 1 ? 'parts' : 'part'} ${(u.part.ks || [u.part.k + 1]).slice().sort((a, b) => a - b).join(', ')} of ${u.part.n} (lines ${u.part.a}-${u.part.b})${partsLeft.has(u.path) ? `; part ${partsLeft.get(u.path).part} not reached (budget)` : ''}`).join(', ')}${inParts.length > 5 ? `, +${inParts.length - 5} more` : ''}.\n\n`;
  if (code && data && !failure && (code.partsDropped || []).length) top += `**Unit parts not reached:** ${plural(code.partsDropped.length, 'part')} of units that were otherwise reviewed: max_budget_usd did not cover the call that held ${code.partsDropped.length === 1 ? 'it' : 'them'}: ${code.partsDropped.slice(0, 5).map((k) => `\`${cell((code.list.get(k.split(':')[0]) || {}).path || k, 100)}\` part ${k.split(':')[1]}`).join(', ')}${code.partsDropped.length > 5 ? `, +${code.partsDropped.length - 5} more` : ''}.

`;
  const bh = inv && inv.budget_hint; // units no call had room for: say what the budget allowed and what would cover them
  if (code && data && !failure && bh) top += `${plural(bh.left, 'unit')} not reviewed this run: max_budget_usd $${bh.budget.toFixed(2)} allows ${plural(bh.calls, 'call')}; ${bh.need > bh.max ? `covering all units takes ${bh.need} calls, more than the ${bh.max} a run makes (narrow scan_paths)` : `covering all units needs a budget of about $${bh.usd.toFixed(2)} (the pre-flight reserves the worst case per call; actual spend is usually far lower)`}${inv.rotation && inv.rotation.rotate ? `, or they rotate in over ~${bh.runs} runs` : ''}.\n\n`;
  const fzd = new Set(inv ? inv.forced || [] : []);
  for (const [why, list] of [['were not reviewed: the unit call failed', unseen.filter((u) => failedS.has(u))], ['not reached: max_budget_usd did not cover its call', unseen.filter((u) => reachS.has(u))], ["did not fit the model's context", unseen.filter((u) => !failedS.has(u) && !reachS.has(u) && !fzd.has(u))]]) {
    if (code && data && !failure && list.length) top += `**Not reviewed this run:** ${plural(list.length, 'unit')} ${why}: ${list.slice(0, 5).map((u) => `\`${cell((code.list.get(u) || {}).path || u, 100)}\``).join(', ')}${list.length > 5 ? `, +${list.length - 5} more` : ''}. ${list.length === 1 ? 'It stays' : 'They stay'} due for the next run.\n\n`;
  }
  const partTests = unseen.filter((u) => !failedS.has(u) && !reachS.has(u) && fzd.has(u)); // reviewed with the tests that fit and recorded unsure: not unseen, not due
  if (code && data && !failure && partTests.length) top += `**Reviewed with part of their tests** (recorded unsure; the rest of their tests did not fit): ${partTests.slice(0, 5).map((u) => `\`${cell((code.list.get(u) || {}).path || u, 100)}\``).join(', ')}${partTests.length > 5 ? `, +${partTests.length - 5} more` : ''}.\n\n`;
  if (data && !failure && notAudited.blocks.length) top += `**Not audited this run:** ${plural(notAudited.blocks.length, 'document block')} (${[notAudited.failed && `${notAudited.failed} in a call that failed`, notAudited.dropped && `${notAudited.dropped} left out by max_budget_usd`].filter(Boolean).join(', ')}): ${notAudited.blocks.slice(0, 5).map((b) => `\`${cell(b.path, 100)}:${b.line}\``).join(', ')}${notAudited.blocks.length > 5 ? `, +${notAudited.blocks.length - 5} more` : ''}. ${notAudited.blocks.length === 1 ? 'It stays' : 'They stay'} due for the next run.\n\n`;
  if (data && !failure && unanswered > 0) top += `**Not answered by the model:** ${plural(unanswered, 'document block')} (shown as unconfirmed). ${unanswered === 1 ? 'It stays' : 'They stay'} due for the next run.\n\n`;
  if (partial && !failure) top += `> **Incomplete scan.** The rows below passed verification but the list may be incomplete${partial ? ` (${cell(partial, 200)})` : ''}. The scan issue, if enabled, was not updated.\n\n`;
  const items = (a, n, f) => a.slice(0, n).map(f).join('') + (a.length > n ? `- +${a.length - n} more\n` : '');
  // an incomplete or failed scan keeps its reasons visible; a complete one lists them in Details
  const visibleNr = partial && !failure && nrAll.length ? `### Not reviewed (${nrAll.length})\n\n${items(nrAll, 40, (s) => `- ${cell(s, 400)}\n`)}\n` : '';

  // Details: what the scan looked at and the rest of its result. Fixed text first (counted against the size limit), then tables whole rows at a time.
  let dhead = '', dfoot = '';
  const stats = [];
  if (data && !docless) {
    const n = new Set(rows.map((r) => cidOf(r.id) || r.id)).size + skipped.length;
    const tally = [['reported in two runs', confirmed.length], ['new gap (first report)', fresh.length], ['unsure', unsure.length], ['covered', covered.length]].filter(([, k]) => k);
    stats.push(`**${rows.length} requirement${rows.length === 1 ? '' : 's'}** from ${docCount} document${docCount === 1 ? '' : 's'}`);
    stats.push(`${rotation ? `${n} block${n === 1 ? '' : 's'} audited this run` : candidates ? `${n} block${n === 1 ? '' : 's'} scanned of ${candidates} in the documents${cap ? ` (cap ${cap})` : ''}` : `${n} block${n === 1 ? '' : 's'} scanned`}.`);
    const cv = coverage().trim();
    if (cv) stats.push(cv);
    stats.push(`By block: ${by(tally)}`);
    stats.push(prior ? `A gap is **reported in two runs** when the block was a gap in this run and ${rotation && rotation.rotate ? 'the last time it was audited' : 'in the previous one'}${prior.head ? ` (\`${cell(prior.head.slice(0, 7), 12)}\`)` : ''}; one run alone is a first report. Unsure blocks and sub-row detail vary from run to run and are not counted as reported in two runs.`
      : 'This is the first scan run (no earlier result to compare with), so every gap is a **first report**; one more scan run will show which ones persist.');
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
  const CAP = 15, UCAP = 10, MORE = 15, EVID = 25; // EVID: sub-row evidence rows per document in Details (gap and unsure rows first) // rows shown per visible table; the rest are in Details. UCAP: unit findings listed (PR mode's list cap: each carries a skeleton)
  const vis = (title, rs, head, cap = CAP) => (rs.length ? take(`### ${title} (${rs.length})\n\n${head}`, rs.slice(0, cap), rs.length > cap ? `\n+${rs.length - cap} more in Details.\n` : '') : '');
  let body = '';
  // code-first sections first: untested behaviour, weak unit tests, tests to move down (the top three findings keep their skeleton visible)
  let rank = 0;
  const ulists = [['Untested behaviour', 'missing_test', 'More untested behaviour'], ['Weak unit tests', 'weak_test', 'More weak unit tests'], ['Tests to move down', 'pushdown', 'More tests to move down']].map(([title, kind, more]) => ({ title, more, fs: uf.filter((f) => f.kind === kind) }));
  const fence = (t) => `\n\n\`\`\`\n${t.replace(/`{3,}/g, "'''")}\n\`\`\``;
  const uitem = (f) => findingBlock({ f: { kind: f.kind, title: f.title, path: f.path, line: f.line, body: `${neutralize(f.body)}${f.counterexample ? ` Still passes when: ${neutralize(f.counterexample)}` : ''}${f.skeleton ? fence(f.skeleton) : ''}` }, why: f.confirmed ? '' : 'first report' }, blob, rank++, { bare: true, posted: true, sketch: true });
  const uhead = (f) => findingHead({ kind: f.kind, title: f.title, path: f.path, line: f.line, body: f.body }, { why: f.low ? f.lowWhy || 'low confidence' : f.confirmed ? '' : 'first report', posted: true, bare: true }, blob);
  for (const l of ulists) body += vis(l.title, l.fs.map(uitem), '', UCAP);
  const SIGH = 'Found by rule from the test files at this commit, not by the model; a missing or weak signal is a lead, not a confirmed gap.\n\n| Unit | Signal | Why |\n|---|---|---|\n', SIGN = { test_evidence_not_found: 'test evidence not found', weak_test_signal: 'weak test signal', truthiness_only: 'asserts only truthiness', unreferenced_export: 'no test references it' };
  const srow = (s) => `| ${link(s.path, s.line || 1, s.line ? `${s.path}:${s.line}` : s.path)} | ${SIGN[s.kind]} | ${cell(s.why, 200)} |\n`;
  const srows = [...sig, ...lead.items].map(srow).concat(lead.extra ? [`| +${lead.extra} more | | not listed: only the top 20 leads by unit risk are shown |\n`] : []), SCAP = sig.length + 21; // the rule findings, then the top 20 leads (staticLeads' cap) and the line that counts the rest
  if (!failure && data) body += vis('Static test signals (no model)', srows, SIGH, SCAP);
  body += vis('Reported in two runs', confirmed.map(grow), GTOP);
  body += vis(prior ? 'New since the last scan' : 'New gaps', fresh.map(grow), GTOP);
  body += clashes.length ? take(`### Documents and code disagree (${clashes.length})\n\nA model judgement: only the existence of both quotes was verified. Check before acting.\n\n| Document says | Code says |\n|---|---|\n`, clashes.slice(0, CAP), clashes.length > CAP ? `\n+${clashes.length - CAP} more in Details.\n` : '') : '';
  // Details: the run line is reserved, then the fixed text while it fits, then the tables with what is left
  room -= bytes(drun);
  const fit = (t) => { if (!t || bytes(t) > room) return ''; room -= bytes(t); return t; };
  const dh = fit(dhead), df = fit(dfoot);
  const more = (title, rs, head, cap = CAP) => (rs.length > cap ? take(`**${title} (${rs.length - cap} more)**\n\n${head}`, rs.slice(cap, cap + MORE), rs.length > cap + MORE ? `
+${rs.length - cap - MORE} more not listed.
` : '') : '');
  // code-first Details: the riskiest units table, the inventory and how to read it, units not yet reviewed, low-confidence findings
  let cdet = '';
  if (code) {
    const r = inv.rotation, URISK = '| Unit | Risk | Why | Matched tests | Review |\n|---|---|---|---|---|\n';
    const urow = (u) => `| ${link(u.path, 1, u.path)} | ${u.score} | ${cell(u.why, 160)} | ${u.tests.length ? cell(`${u.tests.slice(0, 3).join(', ')}${u.tests.length > 3 ? `, +${u.tests.length - 3} more` : ''}`, 200) : 'none'} | ${cell(unseen.includes(u.id) ? ((inv.forced || []).includes(u.id) && !code.unitsFailed ? 'forced: tests cut (unsure)' : 'selected, did not fit (not reviewed)') : u.review, 40)} |\n`;
    const text = `**Inventory**\n\n${inv.units} source files (units), ${inv.with_tests} with a matched test file and ${inv.without_tests} without. The matched tests hold ${plural(inv.skipped_tests, 'skipped test')}, ${plural(inv.tests_without_assertion, 'test')} without an assertion and ${plural(inv.weak_assertions, 'weak assertion')}.\n\n`
      + `${r.rotate ? `Rotation: ${r.reviewed} of ${r.total} units reviewed at least once; this run reviewed ${seenN} (confirming ${r.confirming}, never reviewed ${r.new}, least recently reviewed ${r.oldest}). A full cycle takes ${r.runs} runs of ${inv.max_units * (inv.unit_calls || 1)} units.` : `${r.picked - unseen.length} of the ${r.picked} selected units were reviewed whole${unseen.length ? ` (${unseen.length} more ${unfit})` : ''}. Schedule with scan_issue: true to rotate through all units.`}\n\n`
      + `**How to read the unit part**\n\nA unit is a tracked source file. Its risk is (1 + public definitions) times log2(2 + lines / 50) times (1 + commits / 5 + fix commits) times a test factor (1.0 no matched test, 0.6 tests with no assertion, all skipped or mostly weak, 0.3 tested); commits are those of the last 180 days. A test file is matched to a unit by name, by mention or by folder. The ranking orders the work of one scan; it is not a prediction of defects. A finding is reported in two runs when the same finding was reported in the previous run${prior ? '' : ' (there is no earlier run, so every finding is a first report)'}; a unit with no matched test file is not a confirmed gap, only evidence the test search found nothing. Static review; not coverage; not for scoring people.\n\n`;
    const left = Math.max(0, inv.units - r.reviewed);
    cdet = take(`**Riskiest units (top ${Math.min(15, inv.rows.length)} of ${inv.units})**\n\n${URISK}`, inv.rows.slice(0, 15).map(urow), '') + fit(text)
      + (left ? take(`**Units not yet reviewed (${left})**\n\n`, [...inv.unreviewed.slice(0, 15).map((u) => `- ${link(u.path, 1, u.path)} (risk ${u.score})\n`), ...(left > 15 ? [`- +${left - 15} more\n`] : [])], '') : '')
      + ulists.map((l) => more(l.more, l.fs.map(uhead), '', UCAP)).join('') + (failure || !data ? '' : more('More static test signals', srows, SIGH, SCAP))
      + (ulow.length ? take(`**Low-confidence unit findings (${ulow.length})**\n\nA test file the model could not see whole, or a test that may already cover it, is behind each; they are not counted.\n\n`, ulow.map(uhead), '') : '');
  }
  let det = [more('More confirmed gaps', confirmed.map(grow), GTOP), more('More new gaps', fresh.map(grow), GTOP), more('More disagreements', clashes, '| Document says | Code says |\n|---|---|\n')].join('');
  const fold = (s, bs) => take(`**${s} (${bs.length})**\n\n${BTOP}`, bs.map(bline), '');
  det += fold('Unsure', unsure) + fold('Covered', covered);
  for (const g of evid) { const all = [...g.rows, ...g.cov]; det += take(`**Sub-row evidence: ${cell(g.path, 200).replace(/[<>&]/g, '')} (${all.length} row${all.length === 1 ? '' : 's'}${all.length > EVID ? `, first ${EVID}; the rest are in audit.json` : ''})**\n\n| Requirement | Status | Class | Evidence |\n|---|---|---|---|\n`, all.slice(0, EVID), ''); }
  const details = cdet || dh || det || df || drun ? `<details><summary>${failure ? 'Details: run information' : code ? 'Details: riskiest units, inventory, rotation, document blocks, sources' : 'Details: changed since last scan, evidence per block, skipped blocks, coverage of rotation, sources'}</summary>\n\n${cdet}${dh}${det}${df}${drun}\n</details>\n` : '';
  const omit = omitted ? `\n_${omitted} row${omitted === 1 ? '' : 's'} omitted: the report exceeded the size limit; \`audit.json\` in the run artifact has them all._\n` : '';
  return top + visibleNr + body + omit + details + tail;
}

// Only 2-run-stable changes are listed (confirmed gaps that appeared or resolved); status churn between the last two runs is counted, not listed.
function changedSince(prior, blocks) {
  const sec = (title, a) => (a.length ? `- ${title} (${a.length}):\n${a.slice(0, SHOW).map((b) => `  - \`${b.cid}\` ${cell(b.text, 160)}\n`).join('')}${a.length > SHOW ? `  - +${a.length - SHOW} more\n` : ''}` : '');
  const at = (m) => blocks.filter((b) => b.mark === m);
  const body = sec('Reported in two runs, newly', at('confirmed').filter((b) => b.next[3] === 2)) + sec('Resolved (covered in two runs)', at('resolved')) + sec('Resolved? Covered once, recheck next run', at('recheck'));
  const n = blocks.filter((b) => b.was && b.was !== b.status && b.mark !== 'resolved' && b.mark !== 'recheck').length;
  return `**Changed since the last scan${prior.head ? ` (\`${cell(prior.head.slice(0, 7), 12)}\`)` : ''}**\n\n${body || 'No confirmed changes.\n'}${n ? `\nUnstable: ${n} block${n === 1 ? '' : 's'} changed status between the last two runs (not listed).\n` : ''}\n`;
}

// Our scan issue among open and closed issues (marker plus identity); an open one wins.
async function findIssue({ github, owner, repo, me, mark = MARK, title = '' }) {
  // no title given: an issue titled for another target (`TITLE: owner/repo`) is that target's, never ours; a legacy title without a target stays ours
  const foreign = (t) => { const m = new RegExp(`^${TITLE}: ([\\w.-]+/[\\w.-]+)(?: \\(|$)`).exec(t); return !!m && m[1].toLowerCase() !== `${owner}/${repo}`.toLowerCase(); };
  // ponytail: lists every issue; narrow with a label or `creator` if a repo has thousands
  const all = await github.paginate(github.rest.issues.listForRepo, { owner, repo, state: 'all', per_page: 100 });
  const mine = all.filter((i) => !i.pull_request && ours(i.user, me) && (title ? String(i.title).toLowerCase() === title.toLowerCase() : !foreign(i.title)) && typeof i.body === 'string' && i.body.startsWith(mark));
  return mine.find((i) => i.state !== 'closed') || mine[0] || null;
}

// The scan issue's target, shared by the publisher (main) and the collector's loadPrior so what is written is what is read back: scan_issue_repo (owner/name) or the scanned repository,
// and the scope (marker, title; the title names the scanned repository when the issue lives elsewhere). -> { error } | { away, target: { owner, repo }, scope }
function resolveIssueTarget(env, owner, repo) {
  const m = /^([\w.-]+)\/([\w.-]+)$/.exec(env.ISSUE_REPO || ''), away = !!m && `${m[1]}/${m[2]}`.toLowerCase() !== `${owner}/${repo}`.toLowerCase(); // GitHub names are case-insensitive
  if (env.ISSUE_REPO && !m) return { error: `scan_issue_repo "${oneLine(env.ISSUE_REPO, 60)}" is not owner/name` };
  return { away, target: away ? { owner: m[1], repo: m[2] } : { owner, repo }, scope: scopeOf(env.SCAN_PATHS, away ? `${owner}/${repo}` : '') };
}
// The visibility a repository response reports ('' = unknown, which the guard refuses).
const visibilityOf = (d) => d.visibility || (d.private === false ? 'public' : d.private ? 'private' : '');
// A scan issue in another repository may not reach a wider audience than the scanned one (fails closed). visTarget() / visSource() -> visibility string.
async function guardIssueTarget(t, visTarget, visSource) {
  if (!t.away) return { ok: true, reason: '' };
  return require('./visibility-guard').decide(await visTarget(), await visSource());
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
  const usageHtml = engine ? usageLine({ engine, model: env.MODEL || '', raw: usage, notes }) : '', runHtml = engine ? `${runLine({ engine, model: env.MODEL || '', raw: usage, notes })}\n${versionLine()}` : ''; // which SpecGuard produced this (review F12)
  const cap = meta && meta.max_requirements;
  const cands = readCandidates(readCtx('audit-candidates.txt'));
  let wantIssue = wantsIssue(env);
  // ISSUE_REPO (scan_issue_repo): the issue lives in another repository under its own client (issueGithub); one issue per scanned repository, told apart by the title
  const rt = resolveIssueTarget(env, owner, repo);
  if (rt.error && wantIssue) { wantIssue = false; core.warning(`SpecGuard: ${rt.error}; no scan issue is written`); }
  const { away = false, target: issueRepo = { owner, repo }, scope = scopeOf(env.SCAN_PATHS) } = rt, igh = issueGithub || github;
  const shared = { head: (meta && meta.head) || '', refNote: (meta && meta.ref_note) || '', docs, rejected, limitations: (meta && meta.limitations) || [], capLeft: (meta && meta.cap_left) || [], blob, usage: usageHtml, run: runHtml, cap, candidates: (meta && meta.candidates) || 0,
    ruled, rotation: (meta && meta.rotation) || null, search: (meta && meta.evidence) || null, scope: scope.lines };
  let last = '';
  const outcome = (status, reason = '') => { last = status; core.setOutput?.('status', status); if (reason) core.setOutput?.('reason', reason); }; // the action's `status` output (fail_on_error); the last call wins
  const finish = async (md) => { try { await core.summary.addRaw(md).write(); } catch (e) { core.warning(`SpecGuard: could not write the job summary: ${e.message}`); if (last !== 'failed') outcome('failed', 'could not write the job summary'); } };
  // issue lookup: our open or closed issue (of this scope) and the state it holds; a failure warns and fails the status (issueErr is re-applied once the run's own status is known)
  let mine = null, prior = null, issueErr = '';
  const issueFail = (e) => { issueErr = `could not write the scan issue: ${e.message}`; core.warning(`SpecGuard: could not write the scan issue (needs permissions: issues: write): ${e.message}`); outcome('failed', issueErr); };
  // a scan issue in another repository may not reach a wider audience than the scanned one (the manual workflow's guard, at the action's own boundary; fails closed)
  const vis = async (g, r) => { try { return visibilityOf((await g.rest.repos.get(r)).data); } catch { return ''; } };
  const lookup = async () => {
    if (!wantIssue) return;
    if (away) {
      const g = await guardIssueTarget(rt, () => vis(igh, issueRepo), () => vis(github, { owner, repo }));
      if (!g.ok) { issueErr = `scan issue not written to ${issueRepo.owner}/${issueRepo.repo}: ${g.reason}`; core.warning(`SpecGuard: ${issueErr}`); outcome('failed', issueErr); return false; }
    }
    try {
      mine = await findIssue({ github: igh, ...issueRepo, me: await whoami(igh), mark: scope.mark, title: away ? scope.title : '' });
      prior = mine && readState(mine.body);
    } catch (e) { issueFail(e); mine = null; return false; }
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
    } catch (e) { issueFail(e); return false; }
    return true;
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
  const units = readUnits(readCtx('audit-units.txt')), inv = json('audit-inventory.json'), pcText = readCtx('pack-cut.txt'), packCutOn = pcText != null, packCut = new Set(lines(pcText)); // pack-cut.txt exists only when the claude engine ran with the pack
  const hasCode = units.size > 0 && !!inv && !!inv.rotation && Array.isArray(inv.rows) && Array.isArray(inv.unreviewed); // the collector's code-first part (absent in a run that predates it)
  // scan-parts.json (claude api, a scan split into calls): blocks of a failed call or dropped for the budget were not sent (or not answered): not rejected, not recorded as audited (the state carries their prior status), listed as not audited
  const sp = json('scan-parts.json') || {}, spFailed = Array.isArray(sp.failed) ? sp.failed : [], isCid = (c) => /^[0-9a-f]{8}$/.test(c), spDropped = (Array.isArray(sp.dropped) ? sp.dropped : []).filter(isCid);
  const skip = new Set([...spFailed.flatMap((x) => (Array.isArray(x.blocks) ? x.blocks : [])).filter(isCid), ...spDropped].filter((c) => cands.has(c))), unitsFailed = spFailed.some((x) => x.part === 'units');
  // units: a failed unit part leaves only its own units unseen (a failure without a unit list, from an older engine, leaves all); units of a unit part dropped for the budget were not reached: both are not tracked, still due
  const unitIn = (a) => (Array.isArray(a) ? a : []).filter((u) => units.has(u)), failedU = new Set(spFailed.filter((x) => x.part === 'units').flatMap((x) => (Array.isArray(x.units) ? unitIn(x.units) : [...units.keys()]))), reachedNot = new Set(unitIn(sp.droppedUnits).filter((u) => !failedU.has(u))), notSeen = new Set([...failedU, ...reachedNot]), partsDropped = (Array.isArray(sp.droppedParts) ? sp.droppedParts : []).filter((k) => typeof k === 'string' && units.has(k.split(':')[0]) && !notSeen.has(k.split(':')[0])); // parts of a unit that has other parts reviewed: the budget dropped the call that held them
  const sent = new Map([...cands].filter(([k]) => !skip.has(k))); // only the blocks sent in a part that succeeded can be missing from the answer
  const v = validate(data, sent, units);
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

  // TEST_PATHS first: the exact input the collector scoped by; test-paths.txt (PR-mode collect.sh writes it from the same input) is only the fallback, so the two cannot disagree
  const root = process.env.GITHUB_WORKSPACE || process.cwd(), testPaths = process.env.TEST_PATHS || readCtx('test-paths.txt') || '', covers = require('./test-map').makeCoverGuard({ cwd: root, testPaths });
  const cutUnits = hasCode ? [...units.values()].filter((u) => notSeen.has(u.id) || (packCutOn && (packCut.has(u.path) || u.tests.some((t) => packCut.has(t))))).map((u) => u.id) : [];
  if (inv) { const testCut = cutUnits.filter((id) => !notSeen.has(id) && !packCut.has(units.get(id).path)); if (testCut.length) inv.forced = [...(Array.isArray(inv.forced) ? inv.forced : []), ...testCut]; } // only the tests were cut: the unit was reviewed, so it is recorded unsure like a forced one and the rotation moves on, instead of looking never reviewed
  const checked = verify(data, { tracked: trackedFiles(root), docs: new Set(docs.map(([p]) => p)), cands: sent, units, packCut, blockCuts: sp.blockCuts || {}, covers, testPaths });
  // A unit is "covered" only when no finding of it was dropped or lowered at any stage (validate, verify, low confidence): otherwise it was seen but inconclusive, tracked as unsure.
  const solid = new Set(checked.unit_findings.filter((f) => !f.low).map((f) => f.unit)), notCut = (u) => !cutUnits.includes(u) && !solid.has(u);
  const dropU = hasCode ? [...new Set([...data.invalid_units, ...checked.unit_dropped])].filter(notCut) : [];
  const lowU = hasCode ? [...new Set(checked.unit_findings.map((f) => f.unit))].filter((u) => notCut(u) && !dropU.includes(u)) : [];
  const unsure = [...dropU, ...lowU], unseen = cutUnits; // seen but inconclusive: tracked this run as unsure (rotation moves on, never covered); unseen: not tracked, still due
  const code = hasCode ? { list: units, inv, findings: checked.unit_findings, unseen, unitsFailed, failed: [...failedU], unreached: [...reachedNot], partsDropped } : null;
  const notAudited = { blocks: [...skip].map((c) => cands.get(c)), failed: [...skip].filter((c) => !spDropped.includes(c)).length, dropped: spDropped.filter((c) => skip.has(c)).length };
  try { fs.writeFileSync(path.join(ctx, 'audit.json'), JSON.stringify({ head: meta.head, specguard: version(), ...(partial ? { partial } : {}), ...checked }, null, 2) + '\n'); } catch (e) { core.warning(`SpecGuard: could not write audit.json: ${e.message}`); }
  const looked = wantIssue && !partial && await lookup();
  // the blocks this run did not audit: the state's blocks that are still in the documents (audit-carried.txt), with the text and place from the collector
  const tv = new Map(lines(readCtx('audit-textver.txt')).map((l) => l.split(String.fromCharCode(9))).filter((x) => HEX8.test(x[0]) && HEX8.test(x[1])));
  const stale = new Set(lines(readCtx('audit-stale.txt')).map((l) => l.trim()).filter((l) => /^[0-9a-f]{8}$/.test(l))); // changed since their review (collector, review F06)
  const left = readCandidates(readCtx('audit-carried.txt')), carried = prior && shared.rotation && shared.rotation.rotate
    ? prior.blocks.filter((b) => left.has(b.cid) && !cands.has(b.cid)).map((b) => ({ ...left.get(b.cid), ...b, ...(stale.has(b.cid) ? { stale: true } : {}) })) : [];
  if (prior) carried.push(...prior.blocks.filter((b) => skip.has(b.cid)).map((b) => ({ ...cands.get(b.cid), ...b }))); // an unaudited block keeps its previous status and age: it stays due
  // blocks sent to the model that it neither answered nor ruled out (validate tolerates up to MISSING_MAX of them: they become 'Unconfirmed' rows)
  const answeredC = new Set([...data.requirements.map((r) => cidOf(r.id)), ...data.not_requirements.map((n) => n.cid)]), unansweredC = new Set([...sent.keys()].filter((c) => !answeredC.has(c))), unanswered = unansweredC.size;
  // unanswered in the previous run too (review S6): recorded unsure with this run's date, no third try; named so it is not lost
  const twice = [...unansweredC].filter((c) => prior && prior.versions && (prior.versions.un || []).includes(c));
  if (twice.length) shared.limitations = [...shared.limitations, `${plural(twice.length, 'document block')} not answered in two consecutive runs (recorded unsure; rotation moves on): ${twice.slice(0, 3).map((c) => `${sent.get(c).path}:${sent.get(c).line} (${c})`).join(', ')}${twice.length > 3 ? ', ...' : ''}`];
  const fzAll = new Set(inv && Array.isArray(inv.forced) ? inv.forced : []), partN = cutUnits.filter((id) => !notSeen.has(id) && fzAll.has(id)).length, fitN = cutUnits.length - notSeen.size - partN; // forced = reviewed with part of their tests
  const incomplete = [partial, notAudited.blocks.length && `${plural(notAudited.blocks.length, 'document block')} not audited`, hasCode && unitsFailed && 'the unit call failed', reachedNot.size && `${plural(reachedNot.size, 'unit')} not reached (max_budget_usd)`, partsDropped.length && `${plural(partsDropped.length, 'unit part')} not reached (max_budget_usd)`,
    fitN > 0 && `${plural(fitN, 'unit')} did not fit the model's context`, partN > 0 && `${plural(partN, 'unit')} ${partN === 1 ? 'was' : 'were'} reviewed with only part of their tests (recorded unsure)`, dropU.length && `${plural(dropU.length, 'unit')} had a finding that failed validation or verification`, unanswered && `${plural(unanswered, 'document block')} ${unanswered === 1 ? 'was' : 'were'} not answered by the model`].filter(Boolean).join('; ');
  outcome(incomplete ? 'incomplete' : 'complete', incomplete);
  if (issueErr) outcome('failed', issueErr); // the lookup ran before the status was known
  await finish(render({ ...shared, data: checked, partial, prior, carried, code, notAudited, unanswered }));
  if (!looked) return; // no issue wanted, a partial audit, or the lookup failed (a blind create could duplicate the issue)
  const cu = readUnits(readCtx('audit-units-carried.txt')); // units the state knows that this run did not review, still in the repository
  const forced = new Set(inv && Array.isArray(inv.forced) ? inv.forced : []), cut = new Set(unseen.filter((u) => forced.has(u) && !notSeen.has(u)));
  const codeState = code && { cut, unsure, picked: [...units.keys()].filter((u) => !unseen.includes(u) || cut.has(u)), findings: trackFindings(code.findings.filter((f) => !f.low), prior, meta.head), carried: prior ? prior.blocks.filter((b) => cu.has(b.cid) || (unseen.includes(b.cid) && !cut.has(b.cid))) : [],
    versions: new Map([...units.values()].filter((u) => u.ver).map((u) => [u.id, u.ver])), parts: new Map([...units.values()].filter((u) => u.part && !unseen.includes(u.id)).map((u) => [u.id, u.part])) }; // an unseen unit is not tracked: its prior state is carried, it stays due
  const state = stateOf(meta.head, checked, prior, { carried, date, code: codeState, stale, tv, unanswered: unansweredC });
  await publish(render({ ...shared, data: checked, prior, carried, code, notAudited, unanswered, stateDropped: state.dropped, max: room(state.raw) }), state.raw);
}

// Never fails the run: any error here is a warning.
module.exports = async (args) => {
  try { await main(args); } catch (e) { try { args.core.setOutput?.('status', 'failed'); args.core.setOutput?.('reason', `the scan report failed: ${e.message}`); args.core.warning(`SpecGuard: scan report failed: ${e.message}`); } catch { /* nothing left to report to */ } }
};
Object.assign(module.exports, { readCandidates, readUnits, validate, verify, trackFindings, render, gap, readState, stateComment, stateOf, blocksOf, track, scopeOf, findIssue, resolveIssueTarget, guardIssueTarget, visibilityOf, STATUS, CLASS, MARK, TITLE, HEADING });
