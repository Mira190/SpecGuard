// Audit mode, last step (actions/github-script): validates the model's result and every citation against the checked-out HEAD,
// renders it to the job summary and, with audit_issue, to ONE issue we own. Advisory; never fails the run.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const post = require('./post');
const { ours } = require('./preflight');
// trace.js's test-path rule; the fallback is a local copy of it in case the export moves (ponytail: keep in sync).
const { isTestPath = (p) => /(^|[/._-])(test|tests|spec|__tests__)([/._-]|$)/.test(p) } = require('./trace');

const { neutralize, quoteLine, safeRel, readFile, usageLine, mergeUsage } = post;
const STATUS = ['covered', 'partial', 'missing_test', 'not_implemented', 'contradicted', 'unknown', 'needs_human'];
const RISK = ['contradicted', 'not_implemented', 'missing_test', 'partial', 'unknown', 'needs_human', 'covered']; // header order: worst first
const CLASS = ['static', 'unit', 'higher_level', 'human'];
const LAYER = ['unit', 'component', 'integration', 'e2e'];
const MARK = '<!-- specguard:audit -->', TITLE = 'SpecGuard requirements audit';
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
const MISSING_MAX = 0.2; // more unanswered blocks than this share of the candidates reject the output (the repair turn)

// Hand-rolled mirror of audit.schema.json. Only an unusable output is rejected (the repair turn's trigger): not an object, no requirements
// array, more than half of the rows unusable, or more than MISSING_MAX of the listed blocks unanswered. Every other problem degrades one
// row (an unknown status or class becomes unknown/human, a malformed citation is dropped, so verify() downgrades what it no longer carries)
// and is listed in not_reviewed. Enum case, spaces for underscores and numeric strings are normalised. Evidence that does not fit the status
// is downgraded by verify(). cands (default: audit-candidates.txt in $CTX; null = unknown): a result must name a listed block.
function validate(o, cands = ctxCandidates()) {
  const bad = (m) => ({ ok: false, error: m });
  const text = (v) => typeof v === 'string' && v.trim().length > 0;
  const { slug, whole } = post;
  const cite = (v) => !!v && typeof v === 'object' && text(v.path) && Number.isInteger(v.line) && v.line >= 1 && text(v.quote);
  const tidy = (v) => { if (v && typeof v === 'object') { v.line = whole(v.line); if (v.layer !== undefined) v.layer = slug(v.layer); } return v; };
  if (!o || typeof o !== 'object' || Array.isArray(o)) return bad('$ is not an object');
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
// skipped, or whose rows all failed verification, becomes an `unknown` row ("not assessed"); not_requirements gains the block's location and text.
// docs: the admitted documents (null = any); cands: the candidate blocks (Map from readCandidates; null = unknown).
function verify(data, { read = readFile, tracked = null, docs = null, cands = null } = {}) {
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
        note: failed.has(c.cid) ? "Not assessed: the model's citation for this block did not verify." : 'Not assessed by the model.' });
    }
    const at = new Map([...cands.keys()].map((k, i) => [k, i])), pos = (id) => at.get(cidOf(id)) ?? Infinity;
    out.requirements.sort((a, b) => pos(a.id) - pos(b.id)); // stable: a block's .1, .2 rows keep the model's order
    out.not_requirements = [...skipped].filter(([k]) => cands.has(k)).map(([k, reason]) => ({ ...cands.get(k), reason })).sort((a, b) => pos(a.cid) - pos(b.cid));
  } else out.not_requirements = [...skipped].map(([cid, reason]) => ({ cid, reason }));
  return out;
}

const count = (rows, key, values) => values.map((v) => [v, rows.filter((r) => r[key] === v).length]).filter(([, n]) => n);

// Hidden machine-readable previous state: ids and statuses only (never row text), so the next run can say what changed.
const stateComment = (head, rows) => `<!-- specguard:audit-state ${JSON.stringify({ v: 2, head: String(head || '').slice(0, 40), rows: rows.map((r) => [r.id, r.status]) }).replace(/[<>]/g, (c) => (c === '<' ? '\\u003c' : '\\u003e')).replace(/--/g, '-\\u002d')} -->`;
function readState(body) {
  const m = STATE_RE.exec(String(body || ''));
  if (!m) return null;
  try {
    const o = JSON.parse(m[1]);
    if (o && o.v === 2 && Array.isArray(o.rows) && o.rows.every((x) => Array.isArray(x) && CID.test(x[0]) && STATUS.includes(x[1]))) return { head: String(o.head || ''), rows: o.rows.map(([id, status]) => ({ id, status })) };
  } catch { /* an edited or foreign comment is no state */ }
  return null;
}

// Markdown that fits `max` bytes: header and footer first, then whole table rows while they fit (never cut mid-row).
// partial: why the audit is incomplete (shown first); prior: { head, rows: [{id, status}] } of the last full audit; cap: audit_max_requirements.
function render({ data, docs = [], rejected = [], limitations = [], capLeft = [], blob = '', usage = '', failure = '', partial = '', prior = null, cap = 0, candidates = 0, max = SUMMARY_MAX }) {
  const link = (p, line, label) => {
    const t = neutralize(label).replace(/[\[\]]/g, '').replace(/\|/g, '\\|');
    const rel = safeRel(p);
    return blob && rel ? `[${t}](${blob}/${rel.split('/').map(encodeURIComponent).join('/')}#L${line})` : t;
  };
  const at = (c) => link(c.path, c.line, `${c.path}:${c.line}`);
  const rows = data ? data.requirements : [];
  const name = (r) => `${link(r.source.path, r.source.line, r.id)}`;
  const evidence = (r) => [r.code.length ? `code: ${r.code.map(at).join('; ')}` : '', r.tests.length ? `tests: ${r.tests.map((t) => `${t.layer} ${at(t)}`).join('; ')}` : ''].filter(Boolean).join('<br>');
  const first = (r) => `${name(r)} ${cell(r.text, 300)}${r.note ? `<br><sub>${cell(r.note, 300)}</sub>` : ''}`;
  const groups = [], clash = [], done = [];
  for (const r of rows) {
    if (r.status === 'contradicted') { clash.push(`| ${first(r)} | "${cell(r.source.quote, 200)}"<br>${at(r.source)} | "${cell(r.code[0].quote, 200)}"<br>${r.code.map(at).join('; ')} |\n`); continue; }
    if (r.status === 'covered') { done.push(`| ${first(r)} | ${r.class} | ${evidence(r) || 'none'} |\n`); continue; }
    let g = groups.find((x) => x.path === r.source.path);
    if (!g) groups.push(g = { path: r.source.path, rows: [] });
    g.rows.push(`| ${first(r)} | ${r.status} | ${r.class} | ${evidence(r) || 'none'} |\n`);
  }

  const by = (rs, key, vs) => count(rs, key, vs).map(([v, n]) => `${v} ${n}`).join(' · ') || 'none';
  const docCount = new Set(rows.map((r) => r.source.path)).size;
  let head = `## ${TITLE}\n\n`;
  if (partial) head += `> **Partial audit: ${cell(partial, 200)}.** The rows below passed verification but the list may be incomplete. The audit issue, if enabled, was not updated.\n\n`;
  if (failure) head += `Could not complete: ${cell(failure, 400)}\n\n`;
  else if (!data) head += 'No requirement documents were found, so nothing was audited.\n\n';
  else {
    const skipped = data.not_requirements || [], blocks = new Set(rows.map((r) => cidOf(r.id) || r.id)).size + skipped.length;
    head += `**${rows.length} requirement${rows.length === 1 ? '' : 's'}** from ${docCount} document${docCount === 1 ? '' : 's'}\n\n`
      + `${candidates ? `${blocks} block${blocks === 1 ? '' : 's'} audited of ${candidates} in the documents${cap ? ` (cap ${cap})` : ''}` : `${blocks} block${blocks === 1 ? '' : 's'} audited`}; ${skipped.length} block${skipped.length === 1 ? ' was' : 's were'} not ${skipped.length === 1 ? 'a requirement' : 'requirements'}.\n\n`
      + `By status: ${by(rows, 'status', RISK)}\n\nBy class: ${by(rows, 'class', CLASS)}\n\n`
      + 'The blocks are fixed by the documents (every paragraph, list item and table row, in document order, up to the cap), not chosen by the model: the same commit lists the same blocks. The model only assesses each one; the counts describe that list, not the repository.\n\n';
  }
  head += '> Static review; not coverage; not for scoring people. Tests were not executed: a requirement is `covered` when a cited unit assertion with an independent expected value proves it. `not_implemented` and `missing_test` are model claims (not verified statically): the search that found nothing is not checked. Rows are identified by a stable id (a hash of the document, heading and block text, plus .1, .2 when a block bundles several requirements), so a reworded block shows as removed and new.\n\n';
  if (prior && data) head += changedSince(prior, rows, cell);

  const list = (a, n, f) => a.slice(0, n).map(f).join('') + (a.length > n ? `- +${a.length - n} more\n` : '');
  let foot = '';
  if (rejected.length) foot += `### Documents not included\n\nThese looked like requirement documents but were not admitted (add them to \`requirements_paths\` to include):\n\n${list(rejected, 20, ([p, why]) => `- \`${cell(p, 200)}\`: ${cell(why, 200)}\n`)}\n`;
  const nr = [...(data ? data.not_reviewed : []), ...capLeft, ...limitations];
  const nrq = data && data.not_requirements ? data.not_requirements : [];
  if (nrq.length) foot += `<details><summary>${nrq.length} block${nrq.length === 1 ? ' was' : 's were'} not ${nrq.length === 1 ? 'a requirement' : 'requirements'}</summary>\n\n${list(nrq, 60, (n) => `- ${n.path ? `${link(n.path, n.line, `${n.path}:${n.line}`)} ` : ''}\`${n.cid}\` ${n.text ? `${cell(n.text, 100)} ` : ''}(${cell(n.reason, 80)})\n`)}\n</details>\n\n`;
  const unread = data ? docs.filter(([p]) => !data.docs_reviewed.includes(p)).map(([p]) => `\`${p}\` was admitted but is not in docs_reviewed.`) : [];
  if (nr.length || unread.length) foot += `### Not reviewed\n\n${list([...nr, ...unread], 40, (s) => `- ${cell(s, 400)}\n`)}\n`;
  if (usage) foot += `${usage}\n`;

  let room = max - bytes(head) - bytes(foot) - 300, omitted = 0, body = '';
  const take = (top, rs, end = '') => { // whole rows while they fit
    const kept = [];
    let used = bytes(top) + bytes(end) + 1;
    for (const r of rs) { const b = bytes(r); if (used + b > room) break; kept.push(r); used += b; }
    omitted += rs.length - kept.length;
    if (!kept.length) return '';
    room -= used;
    return `${top}${kept.join('')}${end}\n`;
  };
  if (clash.length) body += take('### Doc and code disagree (unconfirmed)\n\nThe requirement line and the code line below look contradictory. A model judgement: only the existence of both quotes was verified. Check before acting.\n\n| Requirement | Document says | Code says |\n|---|---|---|\n', clash);
  for (const g of groups) body += take(`### \`${cell(g.path, 200)}\`\n\n| Requirement | Status | Class | Evidence |\n|---|---|---|---|\n`, g.rows);
  if (done.length) body += take(`<details><summary>Covered in full (${done.length})</summary>\n\n| Requirement | Class | Evidence |\n|---|---|---|\n`, done, '\n</details>\n');
  if (omitted) body += `_${omitted} row${omitted === 1 ? '' : 's'} omitted: the report exceeded the size limit; \`audit.json\` in the run artifact has them all._\n\n`;
  return head + body + foot;
}

// New rows, removed rows (ids only: the state keeps no text) and status changes against the last full audit.
function changedSince(prior, rows, cell) {
  const was = new Map(prior.rows.map((r) => [r.id, r.status])), now = new Set(rows.map((r) => r.id));
  const fresh = rows.filter((r) => !was.has(r.id)), moved = rows.filter((r) => was.has(r.id) && was.get(r.id) !== r.status);
  const gone = prior.rows.filter((r) => !now.has(r.id));
  const sec = (title, a, f) => (a.length ? `- ${title} (${a.length}):\n${a.slice(0, SHOW).map((x) => `  - ${f(x)}\n`).join('')}${a.length > SHOW ? `  - +${a.length - SHOW} more\n` : ''}` : '');
  const body = sec('New', fresh, (r) => `\`${r.id}\` ${cell(r.text, 160)} (${r.status})`)
    + sec('Status changed', moved, (r) => `\`${r.id}\` ${cell(r.text, 160)}: ${was.get(r.id)} → ${r.status}`)
    + sec('Removed or not listed this time', gone, (r) => `\`${r.id}\` (was ${r.status})`);
  return `### Changed since last audit${prior.head ? ` (\`${cell(prior.head.slice(0, 7), 12)}\`)` : ''}\n\n${body || 'No changes in the listed requirements.\n'}\n`;
}

// Our audit issue among open and closed issues (marker plus identity); an open one wins.
async function findIssue({ github, owner, repo, me }) {
  // ponytail: lists every issue; narrow with a label or `creator` if a repo has thousands
  const all = await github.paginate(github.rest.issues.listForRepo, { owner, repo, state: 'all', per_page: 100 });
  const mine = all.filter((i) => !i.pull_request && ours(i.user, me) && typeof i.body === 'string' && i.body.startsWith(MARK));
  return mine.find((i) => i.state !== 'closed') || mine[0] || null;
}

async function main({ github, context, core }) {
  const env = process.env, ctx = env.CTX;
  const readCtx = (n) => { try { return fs.readFileSync(path.join(ctx, n), 'utf8'); } catch { return null; } };
  const { owner, repo } = context.repo, sha = context.sha || env.GITHUB_SHA || '';
  const blob = sha ? `${env.GITHUB_SERVER_URL || 'https://github.com'}/${owner}/${repo}/blob/${sha}` : '';
  const json = (n) => { try { return JSON.parse(readCtx(n) ?? ''); } catch { return null; } };
  const meta = json('audit-meta.json');
  const tab = (n) => lines(readCtx(n)).map((l) => l.split('\t'));
  const docs = tab('audit-docs.txt'), rejected = tab('audit-rejected.txt');
  const engine = env.ENGINE || '';
  let usage = json(engine === 'claude' ? 'claude.json' : 'usage.json');
  if (engine === 'copilot') usage = mergeUsage(usage, json('usage-repair.json'));
  const repair = (readCtx('engine-repair') || '').trim();
  const notes = [...lines(readCtx('engine-notes')).map((x) => x.trim()).slice(0, 4), ...(repair === 'repaired' ? ['JSON repaired in one extra turn'] : repair === 'repair_failed' ? ['JSON repair turn failed'] : [])];
  const usageHtml = engine ? usageLine({ engine, model: env.MODEL || '', raw: usage, notes }) : '';
  const cap = meta && meta.max_requirements;
  const cands = readCandidates(readCtx('audit-candidates.txt'));
  const shared = { docs, rejected, limitations: (meta && meta.limitations) || [], capLeft: (meta && meta.cap_left) || [], blob, usage: usageHtml, cap, candidates: (meta && meta.candidates) || 0 };
  const finish = async (md) => { try { await core.summary.addRaw(md).write(); } catch (e) { core.warning(`SpecGuard: could not write the job summary: ${e.message}`); } };
  const wantIssue = String(env.AUDIT_ISSUE).toLowerCase() === 'true';
  // issue lookup: our open or closed issue and the state it holds; a failure only warns
  let mine = null, prior = null;
  const lookup = async () => {
    if (!wantIssue) return;
    try {
      const me = await (async () => { try { return (await github.rest.users.getAuthenticated()).data.login; } catch { return null; } })();
      mine = await findIssue({ github, owner, repo, me });
      prior = mine && readState(mine.body);
    } catch (e) { core.warning(`SpecGuard: could not write the audit issue (needs permissions: issues: write): ${e.message}`); mine = null; return false; }
    return true;
  };
  const publish = async (md, state) => {
    try {
      const body = `${MARK}\n${[md.trimEnd(), state].filter(Boolean).join('\n\n')}`;
      const flat = (s) => String(s).replace(/\r\n/g, '\n').trim();
      if (mine) {
        const closed = mine.state === 'closed';
        if (flat(body) !== flat(mine.body) || closed) await github.rest.issues.update({ owner, repo, issue_number: mine.number, title: TITLE, body, ...(closed ? { state: 'open' } : {}) });
      } else await github.rest.issues.create({ owner, repo, title: TITLE, body });
    } catch (e) { core.warning(`SpecGuard: could not write the audit issue (needs permissions: issues: write): ${e.message}`); }
  };
  const room = (state) => ISSUE_MAX - bytes(MARK) - bytes(state) - 4;

  if (!meta) return finish(render({ ...shared, failure: 'the collection step did not produce its context.' }));
  if (env.SKIP === 'true') {
    await finish(render({ ...shared, data: null }));
    // no document admitted: a stale issue must not keep claiming old results (none is created for an empty audit)
    if (wantIssue && await lookup() && mine) {
      const keep = prior ? stateComment(prior.head, prior.rows) : '';
      await publish(render({ ...shared, data: null, max: room(keep) }), keep);
    }
    return;
  }
  const data = json('findings.json');
  const v = validate(data, cands);
  const why = v.ok ? '' : data ? `the result failed validation: ${v.error}` : 'the engine returned no usable JSON';
  const st = (readCtx('engine-status') || '').trim();
  if (why) return finish(render({ ...shared, failure: st === 'timeout' ? 'the engine timed out (raise review_timeout_minutes)' : st === 'failed' ? 'the engine failed; see the job log' : why }));
  // valid JSON can still come from a run that timed out or failed (or whose repair turn failed): show what verifies, change nothing else
  const partial = st && st !== 'success' ? `engine ${st}` : repair === 'repair_failed' ? 'engine JSON repair failed' : '';

  const checked = verify(data, { tracked: trackedFiles(process.env.GITHUB_WORKSPACE || process.cwd()), docs: new Set(docs.map(([p]) => p)), cands });
  try { fs.writeFileSync(path.join(ctx, 'audit.json'), JSON.stringify({ head: meta.head, ...(partial ? { partial } : {}), ...checked }, null, 2) + '\n'); } catch (e) { core.warning(`SpecGuard: could not write audit.json: ${e.message}`); }
  const looked = wantIssue && !partial && await lookup();
  await finish(render({ ...shared, data: checked, partial, prior }));
  if (!looked) return; // no issue wanted, a partial audit, or the lookup failed (a blind create could duplicate the issue)
  const state = stateComment(meta.head, checked.requirements);
  await publish(render({ ...shared, data: checked, prior, max: room(state) }), state);
}

// Never fails the run: any error here is a warning.
module.exports = async (args) => {
  try { await main(args); } catch (e) { try { args.core.warning(`SpecGuard: audit report failed: ${e.message}`); } catch { /* nothing left to report to */ } }
};
Object.assign(module.exports, { readCandidates, validate, verify, render, gap, readState, stateComment, STATUS, CLASS, MARK, TITLE });
