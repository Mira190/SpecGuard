// Validates, filters, anchors and posts an advisory review. Never blocks the PR.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { inspectChecks } = require('./checks');
const { ours, recordedLogin, reqKey, cfgKey } = require('./preflight');
const { isFactLimitation } = require('./limitations');

const KINDS = ['spec_mismatch', 'missing_test', 'weak_test', 'standard', 'pushdown'];
const ALIGN = ['consistent', 'mismatch', 'impacted', 'not_verifiable', 'not_applicable', 'unknown'];
const unknownAlign = (reason) => ({ status: 'unknown', reason });
const STATUSES = ['covered', 'weak_test', 'missing_test', 'higher_level_only', 'needs_human', 'unknown'];
const FILE_CAP = 3, HARD_CAP = 30, BODY_MAX = 65000;
// Tokens, plus the credential lines `actions/checkout` leaves in .git/config (a base64 "AUTHORIZATION: basic ..." extraheader).
const SECRET = /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-ant-[A-Za-z0-9_-]{20,})|authorization:\s*(?:basic|bearer|token)\s+[A-Za-z0-9+/=._-]{8,}|\S*extraheader[^\n]*/gi;

const redact = (s) => String(s).replace(SECRET, '[REDACTED]');
// Cut at a code point (never between the halves of a surrogate pair).
const truncate = (s, n = BODY_MAX) => {
  if (s.length <= n) return s;
  let end = n - 20;
  if (end > 0 && /[\uD800-\uDBFF]/.test(s[end - 1])) end--;
  return s.slice(0, end) + '\n...(truncated)';
};
const { matches } = require('./standards-map');
const { parseCandidates } = require('./focus');
const { standardsCut } = require('./prompt');
const clean = (s) => truncate(redact(s));
const oneLine = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// The one sanitiser for every piece of model- or document-derived text that reaches a comment or the summary.
// Idempotent. Removes HTML comments (our markers live in them), neutralises tags, @mentions and images, and drops control and bidi characters.
const INVISIBLE = /[\u0000-\u0008\u000B-\u001F\u007F\u00AD\u034F\u115F\u1160\u17B4\u17B5\u180B-\u180F\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\u2800\u3164\uFE00-\uFE0F\uFEFF\uFFA0\u{E0000}-\u{E007F}\u{E0100}-\u{E01EF}]/gu; // control, bidi, zero-width, tag and variation-selector characters, and the blank Hangul/Braille fillers
function neutralize(s) {
  let t = String(s).replace(INVISIBLE, '');
  for (let prev; prev !== t;) { prev = t; t = t.replace(/<!--[\s\S]*?-->/g, ''); }
  t = t.replace(/<!--[\s\S]*$/, '').replace(/!\[[^\]]*\](?:\([^)]*\)|\[[^\]]*\])?/g, '')
    .replace(/<(?=[A-Za-z/!?])/g, '&lt;').replace(/@(?=[A-Za-z0-9_])/g, '@​');
  return redact(t);
}

// line -> hunk index per side. RIGHT: '+' and ' ' lines, LEFT: '-' lines.
function parsePatch(patch) {
  const m = { RIGHT: new Map(), LEFT: new Map(), changed: { RIGHT: new Map(), LEFT: new Map() }, rightAt: new Map() }; // rightAt: removed LEFT line -> the RIGHT line it sits before
  let h = -1, l = 0, r = 0;
  for (const ln of String(patch || '').split(/\r?\n/)) { // CRLF files: content lines end in CR
    const hd = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(ln);
    if (hd) { h++; l = +hd[1]; r = +hd[2]; continue; }
    if (h < 0 || ln === '' || ln[0] === '\\') continue;
    if (ln[0] === '+') { m.changed.RIGHT.set(r, ln.slice(1)); m.RIGHT.set(r++, h); }
    else if (ln[0] === '-') { m.changed.LEFT.set(l, ln.slice(1)); m.rightAt.set(l, r); m.LEFT.set(l++, h); }
    else { m.RIGHT.set(r++, h); l++; }
  }
  return m;
}

// Git C-quotes paths with special or non-ASCII bytes ("b/\344\270\255.js"): decode the escapes to bytes, then UTF-8.
const ESC = { a: '\x07', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v' };
const unquote = (s) => (/^".*"$/.test(s) ? Buffer.concat([...s.slice(1, -1).matchAll(/\\([0-7]{3})|\\(.)|([^\\]+)/gs)]
  .map((m) => (m[1] ? Buffer.from([parseInt(m[1], 8)]) : Buffer.from(m[3] ?? ESC[m[2]] ?? m[2])))).toString('utf8') : s);
const diffPath = (re, prefix, chunk) => { const m = re.exec(chunk), p = m ? unquote(m[1]) : ''; return p === '/dev/null' ? '' : p.replace(prefix, ''); };

// Local diff.patch -> Map(path -> parsePatch). Keyed by the new path, or the old path for a deletion.
function parseDiff(text) {
  const maps = new Map();
  for (const chunk of String(text || '').split(/^diff --git /m).slice(1)) {
    const p = diffPath(/^\+\+\+ (.+?)\t?$/m, /^b\//, chunk) || diffPath(/^--- (.+?)\t?$/m, /^a\//, chunk);
    const at = chunk.search(/^@@ /m);
    if (p && at >= 0) maps.set(p, parsePatch(chunk.slice(at)));
  }
  return maps;
}

// Deterministic alignment rules (a failure only degrades, never upgrades), run after every step that can unlink a requirement or finding.
// Idempotent. Mutates d.coverage[].alignment/status and d.findings.
function settle(d, notes) {
  const links = new Set(d.requirements.flatMap((r) => r.obligation_ids));
  const linked = (id) => links.has(id);
  const down = (c, why) => { notes.push(`Obligation ${c.id} alignment unknown: ${why}.`); c.alignment = unknownAlign(`Alignment ${c.alignment.status} degraded: ${why}.`); };
  for (const c of d.coverage) {
    const { status: s, since } = c.alignment;
    if (['consistent', 'mismatch', 'impacted'].includes(s) && !linked(c.id)) down(c, 'needs a linked requirement');
    else if (['consistent', 'mismatch', 'impacted'].includes(s) && !c.behaviour) down(c, 'needs a located behaviour');
    else if (['mismatch', 'impacted'].includes(s) && !since) down(c, 'needs since');
    else if (s === 'not_verifiable' && (!linked(c.id) || !String(c.alignment.reason).trim())) down(c, 'not_verifiable needs a linked requirement and a reason');
    else if (s === 'not_applicable' && linked(c.id)) down(c, 'not_applicable cannot have a linked requirement');
  }
  for (const c of d.coverage) if (c.alignment.status === 'mismatch') {
    if (d.findings.filter((f) => f.kind === 'spec_mismatch' && f.obligation_ids.includes(c.id)).length !== 1) down(c, 'needs exactly one spec_mismatch finding');
    else if (c.status === 'covered') Object.assign(c, { status: 'needs_human', reason: 'A mismatch row cannot be covered: a test of the contradicting behaviour does not prove the requirement.' });
  }
  const mm = new Set(d.coverage.filter((c) => c.alignment.status === 'mismatch').map((c) => c.id));
  d.findings = d.findings.map((f) => (['missing_test', 'weak_test'].includes(f.kind) ? { ...f, obligation_ids: f.obligation_ids.filter((id) => !mm.has(id)) } : f)) // the spec_mismatch finding replaces them
    .filter((f) => (f.kind === 'spec_mismatch' ? f.obligation_ids.length === 1 && mm.has(f.obligation_ids[0]) : f.kind === 'standard' || f.obligation_ids.length));
}

// Cosmetic differences a weak model produces: enum case, spaces or hyphens for underscores, whole numbers as strings, a missing line
// (the quote locates it). Normalised in place before validation; the verifier still decides every fact.
const slug = (v) => (typeof v === 'string' ? v.trim().toLowerCase().replace(/[\s-]+/g, '_') : v);
const whole = (v) => (typeof v === 'string' && /^\s*\d+\s*$/.test(v) ? Number(v) : v);
function tidy(o) {
  const set = (x, k, f) => { if (x[k] === null) delete x[k]; else if (x[k] !== undefined) x[k] = f(x[k]); };
  const cite = (x) => {
    if (!x || typeof x !== 'object') return;
    x.line = whole(x.line);
    if (!Number.isInteger(x.line) || x.line < 1) x.line = 1; // a hint only: the quote locates the line, or the citation stays unverified
    set(x, 'start_line', whole); set(x, 'side', (v) => String(v).trim().toUpperCase()); set(x, 'layer', slug);
  };
  for (const c of o.coverage) {
    if (!c || typeof c !== 'object') continue;
    set(c, 'status', slug); cite(c.behaviour); cite(c.change);
    if (Array.isArray(c.evidence)) for (const e of c.evidence) { cite(e); if (e && typeof e === 'object') set(e, 'kind', slug); }
    if (c.alignment && typeof c.alignment === 'object') { set(c.alignment, 'status', slug); set(c.alignment, 'since', slug); }
  }
  for (const f of o.findings) if (f && typeof f === 'object') { cite(f); set(f, 'kind', slug); set(f, 'confidence', slug); }
  for (const r of o.requirements) if (r && typeof r === 'object') set(r, 'line', whole);
  for (const k of ['standards', 'layering']) if (o[k] && typeof o[k] === 'object') set(o[k], 'status', slug);
}

// Layer of an evidence citation that omits it: a higher-layer word in the path, else unit for a test file, else undefined (malformed).
// ponytail: names only; the model states layer whenever it is not a plain unit test, and a stated layer is never overridden.
const layerOf = (p) => { const s = String(p);
  return /(^|[/._-])(e2e|end-to-end|cypress|playwright)([/._-]|$)/i.test(s) ? 'e2e' : /(^|[/._-])(integration|acceptance|functional)([/._-]|$)/i.test(s) ? 'integration'
    : /(^|[/._-])components?([/._-]|$)/i.test(s) ? 'component' : require('./trace').isTestPath(s) ? 'unit' : undefined; };

// A path that is clearly a plain unit test: a test file outside integration/e2e/api/db/ui/component folders and name tokens, not a React component test (.tsx/.jsx),
// not an IT/integration-named class. Only such a path may omit `layer` on a row that claims `covered`.
// ponytail: names only, no framework config; a Playwright `.spec.ts`, an Angular TestBed `.spec.ts` or a unit test under tests/api/ needs `layer: unit` stated. Read the repo's test config if this bites.
const NOT_PLAIN_UNIT = /(^|[/._-])(integration|integ|e2e|end-to-end|acceptance|functional|api|apis|db|database|components?|ui|cypress|playwright|contract|smoke|it|itests?)([/._-]|$)|(?:IT|ITCase|Integration(?:Tests?)?|E2E)\.[A-Za-z]+$|\.(?:test|spec)\.[jt]sx$|(^|\/)__tests__\/[^/]+\//i;
const clearlyUnit = (p) => layerOf(p) === 'unit' && !NOT_PLAIN_UNIT.test(String(p));

// Does the cited line (or the quoted block) look like an assertion, and is its test disabled? Common frameworks only.
// ponytail: regex over the cited text; a custom helper (checkTotal(x)) or an assertion wrapped in a local function reads as no_assertion, and
// a skip marker is looked for only on the enclosing test declaration (up to 3 stacked lines above it), never on describe-level skips or runner config.
// Assertion styles: assert*/expect*/should*/verify* (node, chai, jest, sinon.assert, supertest .expect(, assertThat, testify assert./require.), t.* (tap, ava), XCTAssert, pytest.raises, self.assert*.
// A keyword counts only as a call or member access (assert.equal(, expect(, x.should.), so a variable (expectedTotal), an import (const assert = require(...)) or a test name ('should work') is no assertion.
const ASSERTION = /\b(?:[Aa]ssert\w*!?|[Ee]xpect(?!ed|ation)\w*|[Ss]hould\w*|[Vv]erify\w*|[Ff]ail\w*|require\.\w+|XCTAssert\w*|raises?|[Tt]hrows?)\s*[(.]|\bt\.(?:Errorf|Fatalf|Error|Fatal|Fail\w*)\b|\bt\.(?:equals?|same|ok|notOk|not|is|throws|doesNotThrow|notThrows|rejects|resolves|match|deepEquals?|strictEqual|notEqual|true|false|truthy|falsy|pass|snapshot)\(|\b(?:Is|Has|Does|Contains)\.\w+|\.(?:to[A-Z]\w*|not\.to\w+)\(|^\s*assert\s+(?![=:])/m;
const COMMENT_LINE = /^\s*(?:\/\/|#|\/?\*|--)/;
// Tier of a cited assertion: weak = truthiness or interaction-only (pins no expected value); anything else, and any syntax not recognised, is a value assertion (fail open).
const WEAK = /\.(?:toBeTruthy|toBeFalsy|toBeDefined)\(|\.not\.(?:toBeNull|toBeUndefined)\(|\.toHaveBeenCalled\(\s*\)|\.toThrow(?:Error)?\(\s*\)/;
// assert.ok(x) / assert(x) / t.ok(x) whose only argument (an optional message may follow) is an identifier, a member chain or ONE call result: truthiness, not a value.
// A boolean predicate (list.includes(x), isFoo(x), s.startsWith(y)) or any operator (a === b, !x) is a value check. -> that argument's text, else null.
// The scan's weak detector (leads.js) uses it too, so PR mode and the scan share one definition.
const OK_ARG = /(?:(?<![.\w$])(?:t\.ok|assert(?:\.ok)?)|(?<=\bt\.)assert(?:\.ok)?)\(\s*([A-Za-z_$][\w$.!?\[\]]*(?:\((?:[^()]|\([^()]*\))*\))?)\s*(?:,\s*(?:'[^']*'|"[^"]*"|`[^`]*`)\s*)?\)/;
const BOOL_CALL = /^(?:(?:is|has|can|should|was|did|are)(?![a-z])\w*|includes|startsWith|endsWith|test|some|every|equals|matches|contains|exists\w*)$/;
// A boolean-looking value (isFoo, x.has(..), handlerCalled, session.modified): asserting it IS the value check. Name = last member, call args dropped.
const boolName = (x) => { const n = String(x).replace(/^await\s+/, '').replace(/\(.*$/, '').split('.').pop(); return BOOL_CALL.test(n) || /(?:^|[a-z_])(?:[Cc]alled|[Ee]xecuted|[Mm]odified)$/.test(n) || /^ok\d*$|(?:Equals?|Match(?:es)?)$/.test(n); };
const okArg = (l) => { const m = OK_ARG.exec(l); return m && !/^(?:true|false|null|undefined)$/.test(m[1]) && !boolName(m[1]) ? m[1] : null; };
const isWeak = (l) => !!okArg(l) || WEAK.test(l);
const weakAssertion = (quote) => { const ls = String(quote).split('\n').filter((l) => !COMMENT_LINE.test(l) && ASSERTION.test(l)); return ls.length > 0 && ls.every(isWeak); };
// A weak_test counterexample refuted by the cited assertion itself: assert.equal(EXPR, LIT) / expect(EXPR).toBe(LIT) with a primitive literal, and the counterexample says the SAME EXPR gives a different literal.
// Narrow on purpose: a different input, several claims, or anything unparsed is not refuted.
const LIT = String.raw`-?\d+(?:\.\d+)?|'[^']*'|"[^"]*"|true|false|null`, unq = (x) => x.replace(/^(['"])(.*)\1$/, '$2');
const EXACT = [new RegExp(String.raw`^\s*(?:await\s+)?assert(?:\.strict)?\.(?:equal|strictEqual|deepEqual|deepStrictEqual)\(\s*(.+?)\s*,\s*(${LIT})\s*(?:,\s*(?:'[^']*'|"[^"]*"))?\)\s*;?\s*$`), new RegExp(String.raw`^\s*(?:await\s+)?expect\(\s*(.+)\s*\)\.(?:toBe|toEqual|toStrictEqual)\(\s*(${LIT})\s*\)\s*;?\s*$`)];
function refutedBy(quote, counterexample) {
  const m = EXACT.map((r) => r.exec(String(quote).trim().replace(/\s+/g, ' '))).find(Boolean);
  if (!m || typeof counterexample !== 'string') return false;
  const expr = m[1].replace(/\s+/g, ' ').trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const claims = [...counterexample.trim().replace(/\s+/g, ' ').matchAll(new RegExp(String.raw`(?<![\w$.])${expr}\s+(?:returns?|yields?|gives?|evaluates to|is|=>|=)\s+(${LIT})(?![\w])(?!\.\d)`, 'g'))];
  return claims.length > 0 && claims.every((c) => unq(c[1]) !== unq(m[2]));
}
const SKIPPED = /\.skip\(|\bx(?:it|describe|test)\(|\.todo\(|@Disabled\b|@Ignore\b|\[Ignore\b|\bt\.Skip\w*\(|pytest\.mark\.(?:skip|xfail)|@unittest\.skip|\bskipIf\b/;
const TEST_DECL = /\bx?(?:it|test|describe)(?:\.\w+)?\s*\(|^\s*(?:async\s+)?def\s+test_|^\s*func\s+Test|@Test\b|\[(?:Test|Fact|Theory|TestCase)\b|\bvoid\s+test/;
function assertionKind(lines, line, quote) {
  const at = (i) => String(lines[i - 1] ?? '');
  let d = line;
  for (let n = 0; d > 0 && n < 30 && !TEST_DECL.test(at(d)); n++) d--;
  let from = d;
  if (TEST_DECL.test(at(d))) while (from > 1 && d - from < 3 && at(from - 1).trim() && !/[;}]\s*$/.test(at(from - 1))) from--; // annotations and decorators stack directly above the declaration
  const span = TEST_DECL.test(at(d)) ? Array.from({ length: line - from + 1 }, (_, i) => at(from + i)).join('\n') : at(line);
  return SKIPPED.test(span) ? 'disabled' : String(quote).split('\n').some((l) => !COMMENT_LINE.test(l) && ASSERTION.test(l)) ? 'assertion' : 'no_assertion';
}

// Hand-rolled mirror of findings.schema.json. ponytail: swap for ajv if the schema grows.
// Structural problems (not an object, core arrays missing, more than half of the coverage rows unusable) reject the output and
// say which JSON path failed. Every other problem degrades only the affected part, is repaired in place, and is listed in o.validation_notes.
function validate(o) {
  const bad = (m) => ({ ok: false, error: m });
  const str = (v) => typeof v === 'string';
  const int = (v) => Number.isInteger(v) && v >= 1;
  const text = (v) => str(v) && v.trim().length > 0;
  const citation = (v) => v && text(v.path) && int(v.line) && text(v.quote) && (v.side === undefined || ['LEFT', 'RIGHT'].includes(v.side));
  if (!o || typeof o !== 'object' || Array.isArray(o)) return bad('$ is not an object');
  for (const k of ['coverage', 'findings', 'requirements']) if (!Array.isArray(o[k])) return bad(`${k} must be an array`);
  tidy(o);
  const notes = [], degraded = []; // degraded: ids of rows marked unknown on their own content; reducedReasons counts these, never note wording
  if (!str(o.requirements_source)) { o.requirements_source = ''; notes.push('requirements_source was not a string; ignored.'); }
  if (!str(o.not_reviewed)) { o.not_reviewed = ''; notes.push('not_reviewed was not a string; ignored.'); }
  const demote = (key, why) => {
    notes.push(`${key} assessment ignored: ${why}.`);
    o[key] = { status: 'not_reviewed', ...(key === 'standards' && { sources: [] }), reason: `The ${key} assessment was unusable (${why}); not reviewed.` };
  };
  const s = o.standards, l = o.layering;
  if (!s || typeof s !== 'object' || !['checked', 'no_rules', 'not_reviewed'].includes(s.status)
    || !Array.isArray(s.sources) || !s.sources.every(text) || !text(s.reason)) demote('standards', 'missing or malformed');
  else if (s.status === 'checked' && !s.sources.length) demote('standards', 'checked standards need sources');
  if (!l || typeof l !== 'object' || !['checked', 'not_reviewed'].includes(l.status) || !text(l.reason)) demote('layering', 'missing or malformed');

  // A row problem is structural (the row says nothing usable: it counts toward rejecting the whole ledger) or semantic (the row is
  // well formed but its status is not supported: it becomes unknown and the rest of the review stands).
  let structural = false;
  const shape = (why) => { structural = true; return why; };
  const rowError = (c) => {
    structural = false;
    if (!text(c.obligation) || !text(c.source) || !text(c.reason)) return shape('obligation, source and reason are required');
    if (c.change === undefined) c.change = c.behaviour; // ponytail: omitted change = the cited behaviour; verifyEvidence still checks it against the diff
    if (!(c.behaviour === null || citation(c.behaviour)) || !(c.change === null || citation(c.change))) return shape('malformed citation');
    if (!Array.isArray(c.evidence)) return shape('evidence must be an array');
    if (!STATUSES.includes(c.status)) return shape('invalid status');
    const loose = new Set(); // evidence whose layer was omitted on a path that is not clearly a unit test: shown as unit, never counted for `covered`
    for (const [j, e] of c.evidence.entries()) {
      if (e && typeof e === 'object') {
        if (e.kind === undefined) e.kind = 'assertion'; // the documented meaning of an evidence quote; the quote is still verified
        if (e.layer === undefined) { e.layer = layerOf(e.path); if (e.layer === 'unit' && !clearlyUnit(e.path)) loose.add(e); } // omitted: a higher-layer name in the path wins, else unit only for a test file
        if (!text(e.proves)) delete e.proves; // optional: the row's reason says what the assertion checks
      }
      if (!citation(e) || !['unit', 'component', 'integration', 'e2e'].includes(e.layer)
        || !['assertion', 'no_assertion', 'disabled', 'removed'].includes(e.kind)) return shape(`evidence[${j}] malformed`);
      // removed evidence lives on the diff's LEFT side by definition: set it, don't demote the row (the quote is still checked against the removed lines later)
      if (e.kind === 'removed' && e.side !== 'LEFT') { e.side = 'LEFT'; notes.push(`${c.id}: removed evidence ${e.path}:${e.line} cited without side LEFT; set to LEFT.`); }
    }
    const unitProof = (e) => e.layer === 'unit' && e.kind === 'assertion' && e.side !== 'LEFT';
    if (c.status === 'covered' && (!c.behaviour || !c.evidence.some(unitProof))) return 'covered needs a current unit assertion';
    if (c.status === 'covered' && !c.evidence.some((e) => unitProof(e) && !loose.has(e))) { // a test file with no stated layer is not a malformed row: keep its evidence, do not count it as unit proof, and say what is unknown
      notes.push(`Obligation ${c.id}: test layer not stated (the test path is not clearly a unit test); not counted as unit evidence.`);
      Object.assign(c, { status: 'unknown', reason: 'Test layer not stated (the test path is not clearly a unit test); not counted as unit evidence.', proto: 'Test layer not stated, so the cited test is not counted as unit evidence' });
    }
    if (c.status === 'weak_test' && !c.evidence.some((e) => e.layer === 'unit')) return 'weak_test needs a unit test location';
    if (c.status === 'higher_level_only' && (!c.evidence.length || c.evidence.some((e) => e.layer === 'unit'))) return 'higher_level_only needs higher-layer evidence only';
    if (c.status === 'missing_test' && c.evidence.some((e) => e.kind === 'assertion')) { // citing the nearby test that shows the gap is how a model explains a missing_test; drop the claim of proof, keep the row and its finding
      const n = c.evidence.length;
      c.evidence = c.evidence.filter((e) => e.kind !== 'assertion');
      notes.push(`Obligation ${c.id}: missing_test cannot claim assertion evidence; ignored ${n - c.evidence.length} evidence ${n - c.evidence.length === 1 ? 'entry' : 'entries'} and kept the row.`);
    }
    if (!c.change && !['unknown', 'needs_human'].includes(c.status)) return 'needs a changed-line citation';
    return '';
  };
  const ids = new Set(), rows = [];
  const links = new Set(o.requirements.flatMap((r) => (r && Array.isArray(r.obligation_ids) ? r.obligation_ids : [])));
  let unusable = 0, firstBad = '';
  const align = (a) => {
    if (!a || typeof a !== 'object' || !ALIGN.includes(a.status) || !text(a.reason) || (a.since !== undefined && !['introduced', 'pre_existing'].includes(a.since))) return null;
    return { status: a.status, ...(a.since && { since: a.since }), reason: a.reason };
  };
  for (const [i, c] of o.coverage.entries()) {
    if (!c || typeof c !== 'object' || !text(c.id) || ids.has(c.id)) { notes.push(`Dropped coverage[${i}]: missing or duplicate id.`); unusable++; firstBad ||= `coverage[${i}]: missing or duplicate id`; continue; }
    ids.add(c.id);
    const why = rowError(c);
    if (structural) { unusable++; firstBad ||= `coverage[${i}]: ${why}`; }
    if (!why) {
      if (c.alignment === undefined || c.alignment === null) { // optional in practice: derived, never invented
        if (links.has(c.id)) { c.alignment = unknownAlign('not stated'); }
        else c.alignment = { status: 'not_applicable', reason: 'not stated; no requirement is linked to this obligation' };
      }
      const a = align(c.alignment);
      if (!a) notes.push(`Obligation ${c.id} alignment unknown: malformed alignment.`);
      const al = a || unknownAlign('Malformed alignment.');
      if (al.status === 'mismatch' && ['unknown', 'covered'].includes(c.status)) { // never covered; 'unknown' would drop its spec_mismatch finding
        notes.push(`Obligation ${c.id}: mismatch row with status ${c.status} normalised to needs_human.`);
        rows.push({ ...c, status: 'needs_human', reason: 'A mismatch row cannot be covered: a test of the contradicting behaviour does not prove the requirement.', alignment: al });
      } else rows.push({ ...c, alignment: al });
      continue;
    }
    notes.push(`Obligation ${c.id} marked unknown: ${why}.`); degraded.push(c.id);
    rows.push({ id: c.id, obligation: text(c.obligation) ? c.obligation : '(not stated)', source: text(c.source) ? c.source : '(not stated)',
      behaviour: citation(c.behaviour) ? c.behaviour : null, change: citation(c.change) ? c.change : null, evidence: [], status: 'unknown', reason: `Malformed coverage row: ${why}.`, alignment: unknownAlign('Malformed coverage row.') });
  }
  if (unusable * 2 > o.coverage.length) return bad(`${firstBad} (${unusable} of ${o.coverage.length} coverage rows are unusable)`);
  const status = (id) => rows.find((c) => c.id === id).status;

  const reqIds = new Set(), reqs = [];
  for (const [i, r] of o.requirements.entries()) {
    // a collected criterion (R*, S*, H*, D*) may give only id, obligation_ids and reason: verifyRequirements fills source and quote from requirements-status.json
    const collected = r && typeof r === 'object' && /^[RSHD]\d+$/.test(String(r.id));
    if (!r || typeof r !== 'object' || !text(r.id) || reqIds.has(r.id) || (!collected && (!text(r.source) || !text(r.quote)))) { notes.push(`Dropped requirements[${i}]: malformed or duplicate.`); continue; }
    reqIds.add(r.id);
    const linked = Array.isArray(r.obligation_ids) ? r.obligation_ids.filter((id) => ids.has(id)) : [];
    const broken = !Array.isArray(r.obligation_ids) || linked.length !== r.obligation_ids.length;
    if (broken) notes.push(`Requirement ${r.id}: unknown or malformed obligation links removed.`);
    reqs.push({ id: r.id, source: text(r.source) ? r.source : '', quote: text(r.quote) ? r.quote : '', obligation_ids: linked,
      ...(text(r.ref) && safeRef(r.ref) && { ref: safeRef(r.ref) }), ...(int(r.line) && { line: r.line }), ...((r.pr_quote === null || text(r.pr_quote)) && { pr_quote: r.pr_quote }),
      reason: broken && !linked.length ? 'Its obligation links were missing or invalid.' : text(r.reason) ? r.reason : 'No reason given.' });
  }

  const findingError = (f) => {
    if (!f || typeof f !== 'object') return 'not an object';
    if (!KINDS.includes(f.kind)) return 'invalid kind';
    if (!str(f.path) || !str(f.title) || !str(f.body) || !str(f.quote)) return 'path, title, body and quote must be strings';
    if (!int(f.line)) return 'line must be an integer >= 1';
    if (f.start_line !== undefined && !int(f.start_line)) return 'invalid start_line';
    if (f.side !== undefined && !['LEFT', 'RIGHT'].includes(f.side)) return 'invalid side';
    for (const k of ['suggestion', 'rule_source', 'rule_quote', 'source', 'counterexample']) if (f[k] !== undefined && !str(f[k])) return `invalid ${k}`;
    if (!['high', 'low'].includes(f.confidence)) { notes.push(`findings: ${f.kind} ${f.path} had no valid confidence; kept at low.`); f.confidence = 'low'; } // a failure only degrades
    if (!Array.isArray(f.obligation_ids)) return 'obligation_ids must be an array';
    f.obligation_ids = [...new Set(f.obligation_ids.filter((id) => ids.has(id)))];
    if (f.kind !== 'standard' && !f.obligation_ids.length) return 'no valid obligation';
    if (f.kind === 'spec_mismatch' && f.obligation_ids.length !== 1) return 'spec_mismatch needs exactly one obligation';
    const expected = { missing_test: 'missing_test', weak_test: 'weak_test', pushdown: 'higher_level_only' }[f.kind];
    if (expected && f.obligation_ids.some((id) => status(id) !== expected)) return 'contradicts coverage';
    if (f.kind === 'standard' && o.standards.status !== 'checked') return 'standards were not reviewed';
    if (f.kind === 'pushdown' && o.layering.status !== 'checked') return 'layering was not reviewed';
    return '';
  };
  // A finding whose row the model marked `covered` is a bookkeeping slip, not evidence against the finding: its own citations are verified later.
  // Keep it, make the row agree, and demote it to the summary. Only `covered` rows are repaired; unknown or malformed rows still drop the finding.
  const repair = (f) => {
    const want = f && { missing_test: 'missing_test', weak_test: 'weak_test', pushdown: 'higher_level_only' }[f.kind];
    if (!want || !Array.isArray(f.obligation_ids)) return;
    let fixed = false;
    for (const id of f.obligation_ids) {
      const r = rows.find((c) => c.id === id);
      if (r && r.status === 'covered') { r.status = want; r.reason = `The model raised a ${f.kind} finding on this obligation although it marked it covered.`; fixed = true; }
    }
    if (fixed) { f.confidence = 'low'; f.gated = true; notes.push(`Obligation row contradicted finding ${f.kind} ${f.path}: kept the finding at low confidence and marked the row ${want}.`); }
  };
  let kept = [];
  for (const [i, f] of o.findings.entries()) {
    repair(f);
    const why = findingError(f);
    if (why) notes.push(`Dropped ${[`findings[${i}]`, ...(f && typeof f === 'object' ? [f.kind, f.path, f.title].filter(text) : [])].join(' ')}: ${why}.`);
    else kept.push(f);
  }
  // a high weak_test must name a wrong behaviour the assertion still accepts (review F04); the claim is the model's, but without one it is only a lead
  for (const f of kept) if (f.kind === 'weak_test' && f.confidence === 'high') {
    const ok = counterexampleOk(f.counterexample), refuted = ok && refutedBy(f.quote, f.counterexample);
    if (ok && !refuted) continue;
    f.confidence = 'low'; f.gated = true;
    notes.push(refuted ? `low confidence: weak_test ${f.path}:${f.line} counterexample is refuted by the cited assertion itself.` : `low confidence: weak_test ${f.path}:${f.line} names no concrete wrong behaviour that the assertion still accepts.`);
  }
  const d = { coverage: rows, requirements: reqs, findings: kept };
  settle(d, notes);
  kept = d.findings;
  const demoted = new Set();
  for (const c of rows) {
    if (c.alignment.status !== 'mismatch' && ['missing_test', 'weak_test'].includes(c.status) && kept.filter((f) => f.kind === c.status && f.obligation_ids.includes(c.id)).length !== 1) {
      notes.push(`Obligation ${c.id} marked unknown: needs exactly one ${c.status} finding.`);
      degraded.push(c.id);
      demoted.add(c.id);
      Object.assign(c, { status: 'unknown', reason: 'Inconsistent findings for this gap.' });
    }
  }
  kept = kept.map((f) => ({ ...f, obligation_ids: f.obligation_ids.filter((id) => !demoted.has(id)) })).filter((f) => f.kind === 'standard' || f.obligation_ids.length);
  Object.assign(o, { coverage: rows, requirements: reqs, findings: kept, validation_notes: notes, degraded }); // always overwritten: a model-supplied degraded list is never trusted
  return { ok: true };
}

// maps: parsePatch result when the file is in the diff, else undefined. Never moves a finding to a "nearest" line.
function anchor(f, maps, fileUsed = 0) {
  if (maps) {
    const R = maps.RIGHT;
    if (R.has(f.line) && (f.start_line === undefined || (f.start_line < f.line && R.get(f.start_line) === R.get(f.line)))) return 'inline';
    if (f.confidence === 'high' && fileUsed < FILE_CAP) return 'file';
  }
  return 'summary';
}

const norm = (s) => String(s).replace(/\s+/g, ' ').trim();
// Requirement wording as plain text: a model quotes a criterion without its markdown (backticks, checkbox, emphasis, link syntax, heading #s)
// and with straight quotes. Both sides of every requirement-quote comparison go through this; code citations stay exact (norm).
const MARKER = /^[ \t]*(?:#{1,6}[ \t]+|>[ \t]?|(?:[-*+]|\d+[.)])[ \t]+(?:\[[ xX]\][ \t]+)?)/gm;
const plain = (s) => norm(String(s).replace(MARKER, '').replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/`+/g, '').replace(/\*\*|__/g, '')
  .replace(/(^|[^\w*])[*_](?=\S)|(?<=\S)[*_](?![\w*])/g, '$1').replace(/[‘’]/g, "'").replace(/[“”]/g, '"'));
// An acceptance-criterion source is stabler than a quote: the model re-anchors the same finding on different lines between runs.
// ponytail: AC-only means a new gap on the same AC and file at another line is hidden once the first is posted; add the line to the key if that bites.
const AC = /^(issue (?:[\w.-]+\/[\w.-]+)?#\d+|PR body) AC \d+$/;
const SPEC = /^(?=\S*[./])\S+ \S.*$/; // "docs/specs/pricing.md R3": a spec source keys on path + ref, never on line numbers
const fingerprint = (kind, p, quote, ...sources) => {
  const ac = sources.filter((s) => AC.test(s) || SPEC.test(s)).sort();
  return crypto.createHash('sha1').update(`${kind}\0${p}\0${ac.length ? ac.join('\0') : norm(quote)}`).digest('hex');
};

// Quote-first location: the model's line is only a hint. Returns the 1-based line that holds the quote, or 0. Never chooses among duplicates.
//  1. the same text within +-5 lines of the hint (nearest first)   2. the one line in `all` with that text
//  3. a quote of at least 20 non-space characters cut short: the hint line if it starts with the quote's first 20, else the one line in `all` that does.
// at(l): text of line l (or undefined); all: candidate line numbers; ok(l): a line the caller can use. A trailing "..." or "…" is not part of the quote.
const PREFIX = 20;
function findLine(quote, hint, at, all = [], ok = () => true) {
  const raw = norm(quote ?? ''), cut = norm(raw.replace(/\s*(?:\.\.\.|…)$/, ''));
  const qs = [...new Set([raw, cut].filter(Boolean))];
  if (!qs.length) return 0;
  const text = (l) => norm(at(l) ?? ''), L = [...all], one = (hits) => (hits.length === 1 && ok(hits[0]) ? hits[0] : 0);
  for (const q of qs) for (let d = 0; d <= 5; d++) for (const s of d ? [-d, d] : [0]) if (hint + s >= 1 && ok(hint + s) && text(hint + s) === q) return hint + s;
  for (const q of qs) { const l = one(L.filter((x) => text(x) === q)); if (l) return l; }
  for (const q of qs) {
    let n = 0, i = 0;
    for (; i < q.length && n < PREFIX; i++) if (q[i] !== ' ') n++;
    if (n < PREFIX) continue;
    const p = q.slice(0, i), span = (x) => norm([0, 1, 2, 3].map((k) => at(x + k)).filter((s) => s != null).join(' ')), has = (x) => text(x).startsWith(p) && span(x).includes(q); // the whole (trimmed) quote must be on the line or the next 3 (a call split over lines): the same first 20 characters with a different tail is another line
    if (hint >= 1 && ok(hint) && has(hint)) return hint;
    const l = one(L.filter(has));
    if (l) return l;
  }
  return 0;
}
// Line delta that puts the quote on the cited line (see findLine), or null.
function snap(f, lines) {
  if (!lines) return null;
  const l = findLine(f.quote, f.line, (x) => lines[x - 1], lines.map((_, i) => i + 1), (x) => f.start_line === undefined || f.start_line + (x - f.line) >= 1);
  return l ? l - f.line : null;
}
// The finding with its quote replaced by the line's own text when the model gave a trimmed one (the verified text is what is posted and fingerprinted).
const verified = (f, lines, line) => (norm(lines[line - 1]) === norm(f.quote) ? f : { ...f, quote: lines[line - 1].trim() });

// One comment per kind, path, line and confidence (a low finding never rides on a high comment). One fingerprint per
// merged comment from stable data only (kind, path, quote or the members' AC sources), so reruns dedupe without dropping findings.
// A finding with a suggestion or a range is never merged: the block would replace a range it was not written for.
function merge(fs_) {
  const groups = new Map();
  for (const [i, f] of fs_.entries()) { const k = `${f.kind}\0${f.path}\0${f.line}\0${f.confidence}${f.suggestion || f.start_line !== undefined ? `\0${i}` : ''}`; groups.set(k, [...(groups.get(k) || []), f]); }
  return [...groups.values()].map((g) => ({
    ...g[0],
    fp: fingerprint(g[0].kind, g[0].path, g[0].quote, ...g.map((f) => f.source)),
    ...(g.length > 1 && {
    title: oneLine(g.map((f) => f.title).join('; '), 200),
    body: g.map((f) => `**${f.title}**\n\n${f.body}`).join('\n\n---\n\n'),
    obligation_ids: [...new Set(g.flatMap((f) => f.obligation_ids))],
    }),
  }));
}

// 1-based line of the rule text nearest to n, or 0. Never guesses.
function ruleLine(quote, lines, n) {
  const q = norm(quote || '');
  let best = 0;
  if (q) lines.forEach((l, i) => { if (norm(l).includes(q) && (!best || Math.abs(i + 1 - n) < Math.abs(best - n))) best = i + 1; });
  return best;
}

// Quality gate: a code block with unresolved placeholders (<expected SQL>, TODO, a lone "...") is not a usable skeleton: keep the prose, drop the block.
// Pure; returns { f, note } and leaves a validation note when it fires. Blind adjudication: all 4 such skeletons were judged unusable.
const PLACEHOLDER_WORD = /^(?:expected|actual|sql|value|result|output|input|your|fill|placeholder|todo)(?![a-z])/i;
function placeholder(code) {
  const t = String(code).replace(/&lt;/g, '<');
  if (/\bTODO\b/.test(t) || /^\s*(?:\.\.\.|…)\s*$/m.test(t)) return true;
  // <expected SQL ...> or <some words>; not Foo<T> generics (preceded by a word), not comparisons (a < b), not single-word tags (<div>)
  for (const m of t.matchAll(/(?<![\w)\]>])<([a-z_][^<>\n]{1,300})>/gi)) if (PLACEHOLDER_WORD.test(m[1]) || /^[a-z_]+(?: [a-z_]+){1,6}$/i.test(m[1])) return true;
  return false;
}
function skeletonGate(f) {
  const out = [];
  let dropped = 0, open = null, buf = [];
  const close = () => { if (placeholder(buf.slice(1, buf.length - (open.closed ? 1 : 0)).join('\n'))) dropped++; else out.push(...buf); open = null; };
  for (const line of String(f.body).split(/\r?\n/)) {
    const m = /^\s*(`{3,}|~{3,})/.exec(line);
    if (!open && m) { open = { ch: m[1][0], n: m[1].length }; buf = [line]; continue; }
    if (!open) { out.push(line); continue; }
    buf.push(line);
    if (m && m[1][0] === open.ch && m[1].length >= open.n) { open.closed = true; close(); }
  }
  if (open) close(); // an unclosed fence runs to the end
  const sug = f.kind === 'standard' && typeof f.suggestion === 'string' && placeholder(f.suggestion);
  if (!dropped && !sug) return { f, note: '' };
  const { suggestion, ...rest } = f;
  return { f: { ...(sug ? rest : f), body: `${out.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n\n_Skeleton omitted: placeholder._` }, note: `Finding ${f.kind} ${f.path}:${f.line}: skeleton omitted: placeholder.` };
}

// Order, cap, and route findings. Summary items carry the reason they are there.
function plan(findings, maps, maxComments = 10) {
  const cap = Math.min(HARD_CAP, maxComments);
  const rank = (f) => KINDS.indexOf(f.kind) * 2 + (f.confidence === 'high' ? 0 : 1);
  const out = { inline: [], file: [], summary: [] };
  for (const f of [...findings].sort((a, b) => rank(a) - rank(b))) {
    if (f.confidence === 'low') { out.summary.push({ f, why: 'low confidence' }); continue; }
    const a = anchor(f, maps.get(f.path), out.file.length);
    if (a === 'inline' && out.inline.length < cap) out.inline.push(f);
    else if (a === 'inline') out.summary.push({ f, why: 'over max_comments' });
    else if (a === 'file') out.file.push(f);
    else out.summary.push({ f, why: 'not in a diff hunk' });
  }
  return out;
}

// Reduced review: a fast-tier model or a struggling run gives weaker evidence, so it publishes less (never wrong beats complete).
// ponytail: the triggers are the four cheap signals the engine step and validation already leave behind; add one here when a new failure mode shows up in telemetry.
const REDUCED_INLINE = 3;
// The fast tier alone is a grade, not a gap: the run finished, so status and the head marker follow `incomplete`. The other triggers (repair, engine notes, degraded rows) say the run struggled and still make it incomplete.
const gradeOnly = (r) => !!r && r.reasons.length > 0 && r.reasons.every((x) => x.id === 'tier');
// a validation note that counts toward a reduced review: its obligation id goes in data.degraded, so completeness never depends on the note's wording
const degrade = (data, id, text) => { (data.validation_notes ||= []).push(text); (data.degraded ||= []).push(id); };
function reducedReasons({ em, repair, engineNotes = [], data }) {
  const out = [];
  if (em?.tier === 'fast') out.push({ id: 'tier', text: 'fast-tier model' });
  if (repair === 'repaired' || repair === 'repair_failed') out.push({ id: 'repair', text: repair === 'repaired' ? 'the JSON needed a repair turn' : 'the JSON repair turn failed' });
  if (repair === 'finalized') out.push({ id: 'repair', text: 'the engine ran out of budget and answered from what it had read so far' });
  if (engineNotes.length >= 3) out.push({ id: 'notes', text: `${engineNotes.length} engine notes` });
  // its own citations failed; a row only reached through an unverified requirement link is not counted
  const bad = new Set(data.degraded || []); // explicit kind (degrade()), never the wording of a note
  if (bad.size * 4 > data.coverage.length) out.push({ id: 'degraded', text: `${bad.size} of ${data.coverage.length} obligations degraded by validation` });
  return out;
}
// Verified citations behind a finding: the located behaviour, plus its test evidence or a linked requirement (a standard: its own line and the rule line).
function citationsOf(f, data) {
  if (f.kind === 'standard') return f.rule_source ? 2 : 1;
  return Math.max(0, ...data.coverage.filter((c) => f.obligation_ids.includes(c.id))
    .map((c) => (c.behaviour ? 1 : 0) + (c.evidence.length || data.requirements.some((r) => r.obligation_ids.includes(c.id)) ? 1 : 0)));
}

// Fenced block longer than any backtick run inside. A "suggestion" block is only valid on an inline range.
function fence(lang, text) {
  const f = '`'.repeat(Math.max(3, ...(text.match(/`+/g) || []).map((r) => r.length + 1)));
  return `${f}${lang}\n${text}\n${f}`;
}
// A one-click suggestion replaces the quoted line, so it must be a single line for a single-line finding and carry nothing
// the sanitiser would change (markup, mentions, images, invisible characters, secrets). Anything else is shown as plain text.
const oneClick = (f) => typeof f.suggestion === 'string' && f.suggestion.length > 0 && f.suggestion.length <= 300
  && !/[\n\r]/.test(f.suggestion) && !/[\n\r]/.test(f.quote || '') && f.start_line === undefined
  && !/```|~~~/.test(f.suggestion) && neutralize(f.suggestion) === f.suggestion;
const fix = (f, inline) => (f.kind === 'standard' && typeof f.suggestion === 'string' && f.suggestion
  ? `\n\n${inline && oneClick(f) ? fence('suggestion', f.suggestion) : `Suggested fix (not applied automatically):\n\n${fence('', neutralize(f.suggestion))}`}` : '');
const title1 = (t) => oneLine(neutralize(t).replace(/\s+/g, ' ').trim(), 200);

// A usable counterexample: 20+ characters with something concrete in it (a number, a quoted value or an arrow input -> result). ponytail: shape only; whether the
// wrong behaviour really passes the assertion is the model's claim, not checked here.
const counterexampleOk = (s) => typeof s === 'string' && s.replace(/\s/g, '').length >= 20 && /\d|['"`]|->|\u2192/.test(s);
// kind and confidence stay machine-readable in a hidden comment (the eval graders and the fix-through telemetry read them); only the fp marker comes after it.
function commentBody(f, fp, inline = true) {
  const rule = f.rule_source ? `, rule: ${neutralize(f.rule_source).replace(/[<>\r\n]|--/g, ' ')}` : '';
  // the trailer (suggestion, hidden markers) is never cut: only the model's own text is truncated
  const trailer = `${fix(f, inline)}\n\n<!--\nkind: ${f.kind}, confidence: ${f.confidence}${rule}\n-->\n<!-- specguard:fp=${fp} -->`;
  const still = f.kind === 'weak_test' && counterexampleOk(f.counterexample) ? `\n\nStill passes when: ${neutralize(f.counterexample.trim())}` : '';
  return truncate(`**${title1(f.title)}${f.confidence === 'low' ? ' (low confidence)' : ''}**\n\n${neutralize(f.body)}${still}`, BODY_MAX - trailer.length) + trailer;
}

const gapFree = (data) => !data.findings.length && !(data.validation_notes || []).length && data.coverage.length > 0 && !data.not_reviewed
  && data.standards.status !== 'not_reviewed' && data.layering.status === 'checked'
  && data.requirements.every((r) => r.obligation_ids.length > 0)
  && (!data.tooling || ['passed', 'not_configured'].includes(data.tooling.status))
  && data.coverage.every((c) => c.status === 'covered' && !['mismatch', 'unknown'].includes(c.alignment?.status));
// The requirement text is read from the PR head, so a PR can weaken it and still be "consistent": never clean when it did.
const reqChanged = (data) => data.requirements.some((r) => r.req_change || (r.reflected_in && r.reflected_in.spec));
const noGaps = (data) => gapFree(data) && !reqChanged(data);

// Per obligation: a unit test gap (its own status or a finding on it), unit-evidenced, or left to a human / a higher layer.
const gapIds = (fs_) => new Set(fs_.filter((f) => ['missing_test', 'weak_test'].includes(f.kind)).flatMap((f) => f.obligation_ids || []));
const hasGap = (r, covById, gaps) => r.obligation_ids.some((id) => gaps.has(id) || ['missing_test', 'weak_test'].includes(covById.get(id)?.status));
// Criteria the model filed under not_reviewed as process or CI results ("npm test passes") are not requirements to assess: they stay in Not reviewed only.
// Hidden: no obligations, and the model's own not_reviewed text names the criterion (its id or quote; the automatic "Requirement X is not assessed"
// notes do not count), or it is CI-style wording while that text also talks CI. Wording alone never hides a criterion.
const PROCESS = /\b(?:npm|yarn|pnpm|pytest|mvn|gradle|cargo|go|make)\s+(?:run\s+)?(?:test|build|lint|check)|\b(?:ci|build|lint(?:ing)?|pipeline|workflow|checks?|tests?)\s+(?:\w+\s+){0,2}(?:pass(?:es)?|succeeds?|green)\b|\bgreen\b/i;
const reqRows = (data) => {
  const text = data.requirements.filter((r) => !r.obligation_ids.length).reduce((t, r) => t.split(`Requirement ${r.id} is not assessed: ${r.reason}`).join(' '), data.not_reviewed || '');
  if (!text.trim()) return data.requirements;
  const n = norm(text).toLowerCase(), esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const said = (r) => (norm(r.quote || '') && n.includes(norm(r.quote).toLowerCase()))
    || (/[A-Za-z]/.test(r.id) && new RegExp(`(^|[^\\w-])${esc(String(r.id))}(?![\\w-])`, 'i').test(text))
    || (PROCESS.test(r.quote || '') && PROCESS.test(text));
  return data.requirements.filter((r) => r.obligation_ids.length || !said(r));
};
const cell = (s, n = Infinity) => oneLine(neutralize(s), n).replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ');

// A requirement source is either exactly a collected document label or a repository path; nothing in between.
const LABEL = /^(?:PR body|issue (?:[\w.-]+\/[\w.-]+)?#\d+|history (?:PR|issue) (?:[\w.-]+\/[\w.-]+)?#\d+)$/;
const REMOVED = / [(]removed[)]$/;
const specPath = (src) => !LABEL.test(String(src).replace(/ AC \d+$/, '')); // the source cites a repository file, not a PR/issue label
// A canonical source followed by an item label ("PR body U1", "PR body — U1", "docs/x.md AC-3") is that source; the label is returned apart.
function canonSource(src, labels) {
  const s = String(src);
  if (labels.has(s)) return { source: s };
  for (const l of [...labels].sort((a, b) => b.length - a.length)) {
    const m = s.startsWith(l) && /^(?:\s+|\s*[:—–]\s*)(?:[-—–:]\s+)?(\S.*)$/.exec(s.slice(l.length));
    if (m) return { source: l, item: m[1].trim() };
  }
  return { source: s };
}
// Normalised workspace-relative path, or null for anything absolute, parent-relative, backslashed or with control characters.
function safeRel(p) {
  if (typeof p !== 'string' || !p || /[\\\u0000-\u001F\u007F]/.test(p) || p.startsWith('/') || /^[A-Za-z]:/.test(p)) return null;
  const segs = p.replace(/^(\.\/)+/, '').split('/');
  return segs.some((s) => s === '' || s === '.' || s === '..') ? null : segs.join('/');
}
const safeRef = (s) => oneLine(neutralize(String(s).replace(/[\[\]()<>`*|\\]/g, '')).replace(/\s+/g, ' ').trim(), 60); // an identifier, not markup

// Traceability rows: one per spec-sourced requirement and linked obligation. blob = permalink prefix at HEAD_SHA (no links when absent).
function traceTable(data, blob, specFiles = [], covById = new Map(data.coverage.map((c) => [c.id, c]))) {
  const link = (p, line, label) => {
    const t = String(label).replace(/[\[\]]/g, '');
    return blob && line ? `[${t}](${blob}/${p.split('/').map(encodeURIComponent).join('/')}#L${line})` : t;
  };
  const at = (c) => (c ? (c.side === 'LEFT' ? `${c.path}:${c.line} (removed line)` : link(c.path, c.line, `${c.path}:${c.line}`)) : ''); // a removed line has no place at head
  const rows = [];
  for (const r of data.requirements) {
    if (!specPath(r.source) || !r.obligation_ids.length) continue;
    const removed = REMOVED.test(r.source), p = r.source.replace(REMOVED, '');
    let req = removed ? `${p} ${r.ref || ''} (removed)` : link(p, r.line, `${p}${r.ref ? ` ${r.ref}` : ''}`);
    const ch = r.req_change;
    if (ch) {
      req += ch.kind === 'authored' ? ' — requirement document authored in this PR (no base version)'
        : ` — requirement ${ch.kind === 'removed' ? 'removed' : ch.kind === 'added' ? 'added' : 'changed'} in this PR${ch.previous ? ` — was: "${oneLine(String(ch.previous).replace(/\s+/g, ' '), 160)}"` : ''}`;
    }
    for (const id of r.obligation_ids) {
      const c = covById.get(id);
      if (!c) continue;
      const a = c.alignment, ri = r.reflected_in;
      const kind = c.change && (specFiles.includes(c.change.path) ? 'spec' : 'code');
      rows.push(`| ${cell(req)} | ${cell(c.change ? `${kind}: ${at(c.change)}` : 'none')} | ${cell(c.behaviour ? at(c.behaviour) : 'not located')} | ${cell(c.evidence.map((e) => at(e)).join('; ') || 'none')} | ${cell(`${a.status}${a.since ? ` (${a.since})` : ''}: ${a.reason}`, 600)} | ${ri ? cell(`spec ${ri.spec ? '✓' : '✗'}, tests ${ri.tests ? '✓' : '✗'}, PR ${ri.pr ? '✓' : '✗'}`) : 'n/a'} |`);
    }
  }
  if (!rows.length) return null;
  return { head: `**Traceability (${rows.length})**\n\n| Requirement | Changed | Implementation | Tests | Alignment | Reflected in |\n|---|---|---|---|---|---|\n`, atoms: rows.map((x) => `${x}\n`) };
}

// Files the collector left out of the diff (diff-dropped.txt, one path per line): one bullet of the Not reviewed list.
const notReviewed = (paths) => `Diff over \`max_diff_kb\`, files not reviewed: ${paths.slice(0, 10).map((x) => `\`${cell(x, 120)}\``).join(', ')}${paths.length > 10 ? `, … (+${paths.length - 10} more)` : ''}`;
// Large PR (src/focus.js): the files outside the focused review, riskiest first, as focus-skipped.txt lists them.
const focusNote = (n, of, paths) => `Large PR: focused review of ${n} of ${of} files (highest risk first); not reviewed: ${paths.slice(0, 10).map((x) => `\`${cell(x, 120)}\``).join(', ')}${paths.length > 10 ? `, … (+${paths.length - 10} more)` : ''}`;
// ponytail: 1 nano-AIU = 1e-9 AI credit = $0.01 / credit (GitHub AI Credit price since 2026-06-01); update this one constant if GitHub reprices. The billing API stays authoritative.
const USD_PER_AI_CREDIT = 0.01;
const fin = (x) => (typeof x === 'number' && Number.isFinite(x) && x >= 0 ? x : undefined);
const kM = (n) => (n < 1e3 ? String(n) : n < 1e6 ? `${(n / 1e3).toFixed(1)}k` : `${(n / 1e6).toFixed(1)}M`);
// Sums two copilot usage files (the first turn and the repair turn): tokens per model and in total, credits, API time.
function mergeUsage(a, b) {
  const ok = (x) => x && typeof x === 'object' && !Array.isArray(x);
  if (!ok(b)) return a;
  if (!ok(a)) return b;
  const add = (x, y) => (fin(x) ?? 0) + (fin(y) ?? 0), both = (x, y) => fin(x) !== undefined || fin(y) !== undefined;
  const sum = (x, y, keys) => Object.fromEntries(keys.map((k) => [k, add(x?.[k], y?.[k])]));
  const out = { ...a };
  for (const k of ['totalNanoAiu', 'totalCostUsd', 'totalApiDurationMs']) if (both(a[k], b[k])) out[k] = add(a[k], b[k]);
  if (ok(a.tokenDetails) || ok(b.tokenDetails)) out.tokenDetails = Object.fromEntries(['input', 'cache_read', 'cache_write', 'output'].map((k) => [k, { tokenCount: add(a.tokenDetails?.[k]?.tokenCount, b.tokenDetails?.[k]?.tokenCount) }]));
  const ma = ok(a.modelMetrics) ? a.modelMetrics : {}, mb = ok(b.modelMetrics) ? b.modelMetrics : {};
  out.modelMetrics = Object.fromEntries([...new Set([...Object.keys(ma), ...Object.keys(mb)])].map((n) => [n, { usage: sum(ma[n]?.usage, mb[n]?.usage, ['inputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'outputTokens']) }]));
  return out;
}
// The engine's notes (one per line, at most 4, no repeats) plus a label for the repair/finalize turn, unless an engine note already says it ("finalize turn failed: ...", "finalized: ...").
function engineNotes(raw, repair) {
  const notes = [...new Set((raw || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean))].slice(0, 4);
  const label = { repaired: 'JSON repaired in one extra turn', repair_failed: 'JSON repair turn failed', finalized: 'finalized after the budget ran out', finalize_failed: 'finalize turn failed' }[repair];
  return label && !notes.some((n) => n.toLowerCase().startsWith(label.slice(0, 8).toLowerCase())) ? [...notes, label] : notes;
}
// The parts of the small-print cost line: cost, model(s), tokens, API time. `raw` is the Copilot usage JSON (--usage-output-file) or null; only numbers and model names are read from it.
function usageParts({ engine, model, raw, notes = [], used = [], tier }) {
  const tok = (i, cr, cw, o) => { i = (fin(i) ?? 0) + (fin(cr) ?? 0) + (fin(cw) ?? 0); return { i, c: fin(cr) ?? 0, o: fin(o) ?? 0 }; };
  const show = (t) => `${kM(t.i)} in${t.c ? ` (${kM(t.c)} cached)` : ''} · ${kM(t.o)} out`;
  // copilot's per-model inputTokens already include cache read and write (tokenDetails.input is the uncached part): tok adds them back once
  let models = [], total, usd, credits, ms;
  const u = raw && typeof raw === 'object' ? raw : {};
  { // the copilot shape; the claude adapter writes the same one (src/engines/claude-result.js) plus totalCostUsd
    for (const [n, m] of Object.entries(u.modelMetrics || {})) { const x = m?.usage; if (x) models.push({ n, t: tok(Math.max(0, (fin(x.inputTokens) ?? 0) - (fin(x.cacheReadTokens) ?? 0) - (fin(x.cacheWriteTokens) ?? 0)), x.cacheReadTokens, x.cacheWriteTokens, x.outputTokens) }); }
    const d = u.tokenDetails; if (d) total = tok(d.input?.tokenCount, d.cache_read?.tokenCount, d.cache_write?.tokenCount, d.output?.tokenCount);
    if (fin(u.totalNanoAiu) !== undefined) { credits = u.totalNanoAiu / 1e9; usd = credits * USD_PER_AI_CREDIT; }
    else if (fin(u.totalCostUsd)) usd = u.totalCostUsd; // exact, reported by the engine
    ms = fin(u.totalApiDurationMs);
    if (!models.length && typeof u.currentModel === 'string') models = [{ n: u.currentModel }];
  }
  const nm = (s) => cell(s, 80), parts = [], tokens = []; // used: the model(s) the engine step recorded (engine-model.json), more exact than the request
  const recorded = !!(usd || ms || (total && (total.i || total.o)) || models.some((m) => m.t && (m.t.i || m.t.o)));
  if (usd) parts.push(`Cost ${engine === 'copilot' ? '≈ ' : ''}$${usd.toFixed(usd < 0.01 ? 4 : 2)}${credits !== undefined ? ` (${credits.toFixed(credits < 10 ? 2 : 1)} AI credits)` : ''}`); // cost first; with no price there is no Cost part, never a guess
  let model1 = ''; // the model(s), also for the run line when no usage was recorded
  if (models.length > 1) model1 = `Models: ${models.map((m) => `${nm(m.n)}${m.t ? ` (${show(m.t)})` : ''}`).join(', ')}`;
  else if (used.length > 1) { model1 = `Models: ${used.map(nm).join(', ')}`; const t = total || models[0]?.t; if (t) tokens.push(show(t)); }
  else {
    const actual = used[0] || models[0]?.n, n = actual || model;
    if (n) model1 = `${nm(n)}${actual && model && actual !== model && !notes.some((x) => x.startsWith('model_fallback')) ? ` (requested ${nm(model)})` : ''}`;
    const t = total || models[0]?.t;
    if (t && (t.i || t.o)) tokens.push(show(t)); // a run that failed before the model answered records zeros: no noise
  }
  parts.push(...(model1 ? [model1] : []), ...tokens);
  if (ms) parts.push(ms < 6e4 ? `${Math.round(ms / 1e3)}s` : `${Math.floor(ms / 6e4)}m${String(Math.round((ms % 6e4) / 1e3)).padStart(2, '0')}s`);
  if (recorded && notes.includes('usage partial')) parts.push('usage partial'); // qualifies a total that exists
  return Object.assign(recorded ? parts : [], { model: model1, recorded }); // nothing recorded (a failed run): no cost line, just the model for the run line
}
// The visible cost line: cost first, then model and tokens; '' when nothing was recorded.
const usageLine = (a) => { const p = usageParts(a); return p.length ? `<sub>${p.join(' · ')}</sub>` : ''; };
// The run information that stays in Details: engine and the engine's notes (effort, context pack, model fallback, JSON repair).
const runLine = (a) => `Run: engine ${cell(a.engine, 80)}${[usageParts(a).recorded ? '' : usageParts(a).model, ...(a.notes || []).filter((x) => x !== 'usage partial')].filter(Boolean).map((x) => ` · ${cell(x, 160)}`).join('')}`;
// Fix-through telemetry (0 tokens). The outcome of an earlier finding, conservatively: nothing here is ever "fixed", only observed.
//   dismissed: a person resolved the thread with neither the anchor nor any test changed, or 👎 outnumber 👍 by 2 (we add no reactions: all are people's)
//   open: reported again; addressed: not reported and the author changed the anchored lines or any test file since the comment (first-parent, no base merges)
//   not_observed: not reported, nothing observed to change, or unknown (could be a miss)
const outcome = (p) => ((p.thread === 'human' && p.anchor_touched === false && p.tests_changed !== true) || p.down - p.up >= 2 ? 'dismissed' : p.still_reported ? 'open' : p.anchor_touched === true || p.tests_changed === true ? 'addressed' : 'not_observed');
const COUNTS_MAX = 8192;
// Hidden machine-readable line in the sticky summary. It repeats finding titles, so a consumer that greps the comment body for finding text must strip the `specguard:counts` line first. `outcomes` drops its oldest entries first to stay under COUNTS_MAX; the tally in `since` always covers all of them.
function countsComment(c) {
  const o = { ...c, outcomes: [...(c.outcomes || [])], ...(c.sum && { sum: [...c.sum] }) };
  const json = () => JSON.stringify(o).replace(/[<>]/g, (ch) => (ch === '<' ? '\\u003c' : '\\u003e')).replace(/--/g, '-\\u002d'); // can never close the HTML comment
  while (json().length > COUNTS_MAX && o.outcomes.length) { o.outcomes.shift(); o.dropped = (o.dropped || 0) + 1; }
  while (o.sum?.length && json().length > COUNTS_MAX) { o.sum.pop(); o.sum_dropped = (o.sum_dropped || 0) + 1; } // then the summary-only entries, last first (carried-forward ones sit after this run's)
  return `<!-- specguard:counts ${json()} -->`;
}
// A failed run must not erase a real review of the same commit: keep the previous comment (markers untouched, so preflight still sees that valid result) under a one-line banner.
// Another head, a failed or a missing prior: the failure summary `text`. The banner is hidden-marked so the next failure replaces it and the next success rewrites the whole body.
const BANNER = /<!-- specguard:failed-rerun -->[^\n]*\n\n/;
function keepPrior(prior, text, why, run, now) {
  const st = /<!-- specguard:status=(\w+) -->/.exec(prior)?.[1];
  let counts; try { counts = JSON.parse(/<!-- specguard:counts (\{.*\}) -->/.exec(prior)?.[1]); } catch { return text; }
  if (!counts?.head || counts.head !== now || !['complete', 'incomplete'].includes(st) || !prior.includes('## SpecGuard\n\n')) return text;
  return prior.replace(BANNER, '').replace('## SpecGuard\n\n', `## SpecGuard\n\n<!-- specguard:failed-rerun -->⚠️ The latest run${run ? ` (${run})` : ''} could not complete: ${neutralize(String(why).replace(/\n/g, ' '))}. Showing the previous result for this same commit.\n\n`);
}
// What the review read, as a plain list for Details. Paths are repo-relative and come from the collector, not the model.
function sourcesRead({ reqDocs = [], standards = [], trace, head, base, rejected = [] }) {
  // an entry is a path, or { path, bytes, lines, truncated } for a standards file (size, line count, cut off in the prompt)
  const one = (x) => (typeof x === 'string' ? `\`${cell(x)}\`` : `\`${cell(x.path)}\`${Number.isInteger(x.bytes) ? ` (${x.bytes} bytes, ${x.lines} lines${x.truncated ? '; truncated in prompt' : ''})` : x.truncated ? ' (truncated in prompt)' : ''}`);
  const list = (a) => (a.length ? a.slice(0, 15).map(one).join(', ') + (a.length > 15 ? `, +${a.length - 15} more` : '') : 'none');
  // candidate documents the collector looked at and did not admit as requirements: [path, reason]
  const n = rejected.length;
  const atoms = [`- Requirement documents: ${list(reqDocs)}\n`, `- Standards files: ${list(standards)}\n`, `- Trace: ${cell(trace)}\n`];
  if (n) atoms.push(`- ${n} candidate document${n === 1 ? ' was' : 's were'} not admitted (add to \`requirements_paths\` to include):\n${rejected.slice(0, 10).map(([p, why]) => `  - \`${cell(p)}\` — ${cell(why)}\n`).join('')}${n > 10 ? `  - +${n - 10} more\n` : ''}`);
  atoms.push(`- Commits: head \`${cell(String(head).slice(0, 7))}\`, base \`${cell(String(base).slice(0, 7))}\`\n`);
  return { h: '**Sources read**\n\n', atoms };
}

// ---- the sticky summary ---------------------------------------------------------------------------------------------------------------------
// Visible = what the developer acts on (plus "Not reviewed" when the run is incomplete); everything else sits in ONE collapsed Details block.
// One icon per summary, on the verdict line only: ❌ needs action, ✅ met by static review, ❔ a person must check, ⚠️ incomplete or reduced review. Everything else is plain words.
// Every string SpecGuard writes is English; repository text appears only inside quotes.
const KIND_LABEL = { missing_test: 'Missing test', weak_test: 'Weak test', spec_mismatch: 'Mismatch', standard: 'Violation', pushdown: 'Move down' };
const STATUS_LABEL = { covered: 'Evidenced', weak_test: 'Weak test', missing_test: 'Missing test', higher_level_only: 'Higher-level only', needs_human: 'Needs a person', unknown: 'Unconfirmed' };
// Why a finding is in the summary instead of an inline comment, in words.
const ROUTES = [[/^low confidence$/, 'low confidence'], [/^summary only$/, ''], [/over max_comments|inline limit/, 'inline limit reached'], [/not in a diff hunk/, 'outside the diff'], [/removed test or assertion/, 'removed test or assertion'],
  [/outside the reviewed diff/, 'outside the reviewed diff'], [/withheld/, 'withheld: could not deduplicate'], [/anchor rejected|could not post/, 'could not be posted inline'], [/^not posted/, 'not posted'], [/not high confidence/, 'reduced review: needs high confidence and two citations'], [/reduced review/, 'reduced review']];
const route = (why) => (ROUTES.find(([re]) => re.test(String(why || ''))) || [0, String(why || '')])[1];
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const andList = (xs) => (xs.length > 1 ? `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}` : xs[0] || '');
const sentence = (s) => { const t = neutralize(String(s)).replace(/```[\s\S]*?```/g, ' ').replace(/\s+/g, ' ').trim(); return oneLine((/^.*?[.!?](?=\s|$)/.exec(t) || [t])[0], 200); };
// A requirement as plain text for a table cell: emphasis and link syntax removed, code spans kept; cut at a word, never mid-code.
const mdPlain = (s) => String(s).replace(/\s+/g, ' ').trim().replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').split(/(`[^`]*`)/)
  .map((p, i) => (i % 2 ? p : p.replace(/\*\*|__/g, '').replace(/(^|[^\w*])[*_](?=\S)|(?<=\S)[*_](?![\w*])/g, '$1'))).join('');
function words(s, n) {
  if (s.length <= n) return s;
  let t = s.slice(0, n - 1);
  if (/\S/.test(s[n - 1])) t = t.replace(/\s+\S*$/, '');
  if ((t.match(/`/g) || []).length % 2) t = t.slice(0, t.lastIndexOf('`'));
  return `${t.replace(/[\s,;:(–—-]+$/, '')}…`;
}
const INTERNAL = /malformed|coverage row|layer not stated|citation|alignment|obligation/i; // validator wording: never shown to a developer
const parens = (u) => u.replace(/[()]/g, (c) => `%${c.charCodeAt(0).toString(16)}`);
const pin = (f, blob) => (blob ? parens(`${blob}/${String(f.path).split('/').map(encodeURIComponent).join('/')}#L${f.line}`) : '');
const LIST_CAP = 10, ROW_CAP = 15, NR_CAP = 8, MORE_CAP = 30; // visible caps; MORE_CAP: rows of one overflow list in Details, so a thousand rows never starve the sections behind it

// One list item: label (bare: none, the section heading names the kind), title (linked to its inline comment when posted, else the location is linked to the blob line), location, and the first sentence (a standard: its rule);
// req: the requirement the finding belongs to, on a second line.
function findingHead(f, { url, why, posted: isPosted, bare, req } = {}, blob = '') {
  const blobUrl = pin(f, blob), link = /^https:\/\//.test(url || '') ? parens(url) : isPosted ? blobUrl : '', title = title1(f.title).replace(/[\[\]]/g, ''), r = route(why);
  const loc = `\`${cell(`${f.path}:${f.line}`)}\``, notes = [r, f.confidence === 'low' && !/low confidence/.test(r) ? 'low confidence' : ''].filter(Boolean);
  const tail = f.kind === 'standard' && f.rule_source ? `rule: \`${cell(String(f.rule_source).replace(/:\d+$/, ''))}\`` : sentence(f.body);
  return `- ${bare ? '' : `**${KIND_LABEL[f.kind]}:** `}${link ? `[${title}](${link})` : title} ${!link && blobUrl ? `[${loc}](${blobUrl})` : loc}${notes.length ? ` (${notes.join('; ')})` : ''}${tail ? ` — ${tail}` : ''}\n${req ? `  Requirement: "${neutralize(req)}"\n` : ''}`;
}
const acts = (fs_) => { const n = (...ks) => fs_.filter((f) => ks.includes(f.kind)).length; return [[n('missing_test', 'weak_test'), 'unit test gap'], [n('spec_mismatch'), 'spec mismatch', 'spec mismatches'], [n('standard'), 'standards violation'], [n('pushdown'), 'test to move down', 'tests to move down']].filter(([k]) => k).map(([k, one, many]) => plural(k, one, many)); };
const FENCED = /^(`{3,}|~{3,})[^\n]*\n[\s\S]*?\n\1[`~]*[ \t]*$/gm;
// A finding that carries its full text here (it was not posted as a comment): the head line, then the rest of the prose and the skeleton under it. A long text folds into a per-item
// <details>; the code skeleton of the top three stays visible.
function findingBlock(it, blob, rank, opts = {}) {
  const { f } = it, { flat, sketch, ...o } = opts, head = findingHead(f, { why: it.why, ...o }, blob);
  if (it.brief) return head;
  const body = neutralize(f.body), blocks = [...(body.match(FENCED) || []).map((b) => (sketch ? `Sketch, not run:
${b}` : b)), fix(f, false).trim().replace(/:\n\n/, ':\n')].filter(Boolean); // the skeleton or suggested fix keeps its label
  const prose = body.replace(FENCED, '').replace(/\n{3,}/g, '\n\n').trim();
  const first = /^[\s\S]*?[.!?](?=\s|$)/.exec(prose), rest = f.kind === 'standard' && f.rule_source ? prose : first && first[0].length <= 200 ? prose.slice(first[0].length).trim() : prose;
  const long = !flat && rest.length > 300, open = flat || rank < 3, code = blocks.join('\n');
  const shown = [long ? '' : rest, open ? code : ''].filter(Boolean).join('\n'), folded = [long ? rest : '', open ? '' : code].filter(Boolean).join('\n\n');
  const nested = folded && `\n<details><summary>Full text</summary>\n\n${folded}\n\n</details>\n`;
  const inner = [shown, nested].filter(Boolean).join('\n');
  return inner ? `${head}${inner.replace(/^(?=.)/gm, '  ')}\n` : head;
}

// One row per criterion with what to do about it: gap and mismatch rows name the finding behind them; evidenced rows are not shown above.
function criteriaOf(data, all) {
  const covById = new Map(data.coverage.map((c) => [c.id, c])), gaps = gapIds(all);
  return reqRows(data).map((r) => {
    const cs = r.obligation_ids.map((id) => covById.get(id)), mine = (kinds) => all.filter((f) => kinds.includes(f.kind) && f.obligation_ids.some((id) => r.obligation_ids.includes(id)));
    const mismatch = cs.some((c) => c?.alignment?.status === 'mismatch') && mine(['spec_mismatch']).length > 0, gap = hasGap(r, covById, gaps) && mine(['missing_test', 'weak_test']).length > 0; // a pre-existing drift, or a gap with no verified finding, is not an action here
    const done = cs.length && cs.every((c) => c?.status === 'covered');
    // a governing requirement (D*, or linked by the trace) with no verified gap or mismatch whose alignment nobody settled: the open question is whether the code does what the text says, so ask for that, not for a test
    // (a missing test on it has its own finding and takes the gap branch; the model may also have filed the sentence itself as an "unknown" obligation)
    const align = (!!r.trace_linked || /^D\d+$/.test(r.id)) && cs.length > 0 && !mismatch && !gap && cs.some((c) => c?.alignment?.status === 'unknown');
    const proto = !cs.length ? !!r.proto : cs.some((c) => c?.proto) && cs.every((c) => c?.proto || c?.status === 'covered'); // unknown only because of a source or layer format problem: no test is shown missing
    const kind = !cs.length ? (proto ? 'link' : 'unassessed') : mismatch ? 'mismatch' : gap ? 'gap' : proto ? 'link' : align ? 'check' : done ? 'evidenced' : 'check';
    return { r, kind, align, cs, f: (mismatch ? mine(['spec_mismatch']) : mine(['missing_test', 'weak_test']))[0], higher: cs.some((c) => c?.status === 'higher_level_only') };
  });
}
const STD_WORD = { checked: 'reviewed', no_rules: 'no rule files found', not_reviewed: 'not reviewed' };

// Sections in goal order: unit test gaps, requirements, standards, test layers; then Details. Items are added while they fit under the comment limit; Details items are dropped before
// anything visible, and what does not fit is counted, never cut mid-item.
// posted: [{ f, url }] findings delivered as a comment (or already posted earlier); items: [{ f, why }] findings that carry their full text here.
// status: the whole verdict for a run without findings data (a skipped run); delivery: how the findings reached the PR ("7 inline comments"); runNotes: Details-only facts about the run.
function buildSummary({ cov, status, data, tooling = data?.tooling, items = [], posted = [], delivery, banner = [], partial, engine, model, usage, notes, rules = [], lint = {}, blob, specFiles, pre = [], traceNote, headSha, req, cfg, issues = [], manifest, incomplete = [], counts, resolveNote, state, dropped = [], reduced, used, tier, runNotes = [] }) {
  const isLow = (x) => x.f.confidence === 'low' || x.why === 'low confidence', lows = [...posted, ...items].filter(isLow); // low-confidence findings are never an action: Details only
  posted = posted.filter((x) => !isLow(x)); items = items.filter((x) => !isLow(x));
  const all = [...posted.map((x) => x.f), ...items.map((x) => x.f)], failed = state === 'failed';
  const urls = new Map(posted.map((x) => [x.f, x.url]));
  const inc = incomplete.length > 0;
  // hidden: the preflight skips a rerun on a head SHA that already has a completed summary (never written for a failed run)
  const markers = `<!-- specguard:summary -->\n${/^\w+$/.test(headSha || '') ? `<!-- specguard:head=${headSha} -->\n` : ''}${counts ? `${countsComment(counts)}\n` : ''}${/^\w+$/.test(headSha || '') && /^\w+$/.test(req || '') ? `<!-- specguard:req=${req} -->\n` : ''}${/^\w+$/.test(headSha || '') && /^\w+$/.test(cfg || '') ? `<!-- specguard:cfg=${cfg} -->\n` : ''}${/^\w+$/.test(headSha || '') && issues.length ? `<!-- specguard:issues=${issues.join(',')} -->\n` : ''}<!-- specguard:status=${state || (inc ? 'incomplete' : 'complete')} -->\n## SpecGuard\n\n`;
  const act = acts(all), rows = data && !failed ? criteriaOf(data, all) : [], todo = rows.filter((x) => x.kind !== 'evidenced');
  // One displayed sentence = one row: the model often splits a PR-body bullet into several criteria that show the same sentence. Counts: the counts table and the verdict count
  // criteria (as the model assessed them); the "Requirements to check (N)" heading counts the merged rows actually shown.
  const sentOf = (x) => mdPlain(x.r.sentence || x.r.quote).replace(/\s+/g, ' ').trim() || `#${x.r.id}`;
  const RANK = { mismatch: 0, gap: 1, unassessed: 2, check: 2, link: 3 }, groups = new Map();
  for (const x of todo) { const k = sentOf(x); groups.set(k, [...(groups.get(k) || []), x]); }
  const merged = [...groups.values()].map((g) => ({ ...g.reduce((a, b) => (RANK[b.kind] < RANK[a.kind] ? b : a)), grp: g }));
  const todoKeys = new Set(groups.keys()), seenEv = new Set();
  const evidenced = rows.filter((x) => x.kind === 'evidenced' && !todoKeys.has(sentOf(x)) && !seenEv.has(sentOf(x)) && seenEv.add(sentOf(x))); // a sentence with a gap or unconfirmed row is not also "evidenced"
  const checks = todo.filter((x) => x.kind === 'unassessed' || x.kind === 'check').length, isClean = !!data && noGaps({ findings: [], ...data }) && !inc && (!reduced || gradeOnly(reduced));
  const changed = !!data && reqChanged(data);

  let verdict = '';
  if (failed) verdict = `**⚠️ Could not complete: ${neutralize(String(status || '').replace(/^Could not complete:\s*/i, ''))}**`;
  else if (!data) verdict = status ? `**${neutralize(status)}**` : '';
  else if (reduced && (!gradeOnly(reduced) || (inc && act.length))) verdict = act.length ? `**❌ ${andList(act)} to fix**` : '**⚠️ Reduced review: no high-confidence gaps**'; // the explanation is a blockquote after the table; never a pass line
  else if (inc) verdict = `**⚠️ Incomplete review: ${act.length ? `${andList(act)} found so far` : 'no unit test gaps found so far'}**`;
  else if (act.length) verdict = `**❌ ${andList(act)} to fix**`;
  else if (checks) verdict = `**❔ No gaps found; ${plural(checks, 'criterion', 'criteria')} need${checks === 1 ? 's' : ''} a person to check**`;
  else if (changed) verdict = '**❔ No gaps found; requirement text changed in this PR, so review it**';
  else if (!data.coverage.length) verdict = '**❔ No gaps found; no behaviour was assessed, so this is not evidence that tests are sufficient**';
  else if (isClean && reduced) verdict = '**✅ Review complete (fast model): no high-confidence gaps**. Static review; tests were not run.';
  else if (isClean) verdict = `**✅ No unit test gaps found** in ${rows.length ? `the ${rows.length} assessed ${rows.length === 1 ? 'criterion' : 'criteria'}` : 'the changed behaviour'}. Static review; tests were not run.`;
  else verdict = '**❔ No gaps found; part of the review could not be assessed**';

  // under the verdict: the shape of the result in one glance, as a 4-column table (not for an incomplete run; a reduced run never shows a pass)
  let line2 = '';
  if (data && !failed && !inc) {
    const n = (k) => rows.filter((x) => x.kind === k).length, nk = (k) => all.filter((f) => f.kind === k).length;
    const req = rows.length ? `${rows.length}: ${[`${n('evidenced')} evidenced`, plural(n('gap'), 'gap'), plural(n('mismatch'), 'mismatch', 'mismatches'), `${n('unassessed') + n('check')} unconfirmed`, `${n('link')} not verified`].filter((x) => !x.startsWith('0 ')).join(', ')}` : specFiles?.length ? 'none linked' : 'none found'; // a requirement document was read, but no criterion links to the change
    const tool = tooling && tooling.status !== 'not_configured' ? `; tool checks ${cell(tooling.status)}` : ''; // a configured check always says its state, a pass too (review F11)
    const std = data.standards.status === 'checked' ? (nk('standard') ? plural(nk('standard'), 'violation') : 'no violations') : data.standards.status === 'no_rules' ? 'none found' : 'not reviewed';
    const lay = data.layering.status === 'checked' ? (nk('pushdown') ? `${nk('pushdown')} to move down` : 'nothing to move down') : 'not reviewed';
    const unit = nk('missing_test') || nk('weak_test') ? [nk('missing_test') && `${nk('missing_test')} missing`, nk('weak_test') && `${nk('weak_test')} weak`].filter(Boolean).join(' · ') : reduced ? 'no high-confidence gaps' : 'no gaps';
    const snc = counts && counts.complete && counts.since_total && counts.since, delta = snc ? [snc.addressed && `${snc.addressed} with later changes (fix not verified)`, Math.max(0, all.length - snc.open) && `${Math.max(0, all.length - snc.open)} new`].filter(Boolean) : []; // push-to-push: addressed earlier findings (a proxy: never called fixed), and findings not reported before
    line2 = `| Unit tests | Requirements | Coding standards | Test layers |\n|---|---|---|---|\n| ${unit} | ${req || 'none found'} | ${std}${tool} | ${lay} |\n${delta.length ? `\nSince last push: ${delta.join(' · ')}\n` : ''}`;
  }

  // notices: one blockquote after the last visible section, just before Details. The incomplete sentence leads; rule and lint notices stay visible only because they change how to read the result.
  const lintChanged = lint.changed || [];
  const bullets = [...banner.map((r) => cell(r)), ...(changed ? ['Requirement text was changed by this PR: consistency with the changed text does not prove the change itself is approved.'] : []),
    ...(rules.length ? [`This PR modifies review rule or agent-config files (${rules.map((x) => cell(x)).join(', ')}); they were not reviewed, and the base versions were applied.`] : []),
    ...(lintChanged.length ? [`Lint/format configuration changed in this PR (${lintChanged.map((x) => cell(x)).join(', ')}): a passing check may reflect the relaxed config.`] : [])];
  const notice = failed ? '' : [inc ? '> **Incomplete review.** Not everything was covered; the findings above were verified, and the next push or rerun reviews again.' : '', gradeOnly(reduced) ? '> Fast-tier model: only high-confidence findings are posted inline.' : reduced && act.length ? `> Reduced review${reduced.reasons?.some((x) => x.id === 'tier') ? ' (fast model)' : ''}: only high-confidence findings are shown.` : '', ...bullets.map((b) => `> - ${b}`)].filter(Boolean).join('\n');
  // the model's not_reviewed text as sentences; the automatic "Requirement X is not assessed" note is dropped when X has its own row in the table
  const shownIds = new Set(rows.map((x) => String(x.r.id)));
  const nrParts = (t) => String(t || '').split(/(?<=[.!?])\s+(?=[A-Z0-9`"'(])/).filter((x) => x.trim() && !shownIds.has((/^Requirement (\S+) is not assessed: /.exec(x) || [])[1]));
  const nrAll =!failed && inc ? [...incomplete.map((r) => cell(r)), ...nrParts(data?.not_reviewed).map((x) => cell(x))] : [];

  // ---- visible sections
  const vis = []; // { h, atoms, tail }
  const det = [];
  const add = (target, h, atoms = [], tail = '') => target.push({ h, atoms, tail });
  const detail = (h, atoms, tail = '\n') => atoms.length && add(det, h, atoms, tail);
  if (nrAll.length) {
    detail('**Not reviewed (more)**\n\n', nrAll.slice(NR_CAP).map((x) => `- ${x}\n`));
  }
  if (!failed && data) {
    const entry = (kinds) => [...posted.filter((x) => kinds.includes(x.f.kind)).map((x) => ({ f: x.f, url: x.url, posted: true })), ...items.filter((x) => kinds.includes(x.f.kind))];
    let rank = 0; // the top three findings overall keep their skeleton visible
    const listed = new Set(); // findings whose title is in a visible list: they carry their requirement on a second line, so it is not also a row
    const reqOf = (f) => { const x = ['missing_test', 'weak_test', 'spec_mismatch'].includes(f.kind) && rows.find((y) => y.kind !== 'evidenced' && y.r.obligation_ids.some((id) => (f.obligation_ids || []).includes(id))); return x ? words(sentOf(x), 200) : ''; };
    const listOf = (title, kinds, more, onlyItems) => {
      const es = entry(kinds).filter((e) => !(onlyItems && e.posted));
      if (!es.length) return;
      es.slice(0, LIST_CAP).forEach((e) => listed.add(e.f));
      const atoms = es.map((e) => { const r = rank++; const req = reqOf(e.f); return e.posted ? findingHead(e.f, { url: e.url, posted: true, bare: true, req }, blob) : findingBlock(e, blob, r, { bare: true, req }); });
      add(vis, `### ${title} (${es.length})\n\n`, atoms.slice(0, LIST_CAP), es.length > LIST_CAP ? `- +${es.length - LIST_CAP} more in Details\n\n` : '\n');
      detail(`**${more} (${es.length - LIST_CAP})**\n\n`, es.slice(LIST_CAP).map((e) => findingHead(e.f, { url: e.url, why: e.why, posted: e.posted }, blob)));
    };
    listOf('Missing unit tests', ['missing_test'], 'More missing unit tests');
    listOf('Weak unit tests', ['weak_test'], 'More weak unit tests');
    // a posted mismatch is a row below and a comment; one that was not posted carries its full text here, since no comment holds it
    listOf('Spec mismatches', ['spec_mismatch'], 'More spec mismatches', true);
    const folded = (y) => (y.kind === 'gap' || y.kind === 'mismatch') && y.f && listed.has(y.f); // a finding listed above already says it, with its requirement
    const shown = merged.flatMap((m) => { const g = m.grp.filter((y) => !folded(y)); return g.length ? [{ ...g.reduce((a, b) => (RANK[b.kind] < RANK[a.kind] ? b : a)), grp: g }] : []; });
    if (shown.length) {
      const url = (x) => { const u = x.f && (urls.get(x.f) || pin(x.f, blob)); return u ? `[finding](${/^https:\/\//.test(u) ? parens(u) : u})` : ''; };
      const link = (x) => (url(x) ? ` (${url(x)})` : '');
      const ask = 'Point to the unit test or add one';
      const why = (x) => { // a short human reason; the validator's own wording is never shown
        const t = String(x.higher ? 'only higher-level tests cover it.' : x.cs.find((c) => c?.status === 'unknown' && c.reason)?.reason || '').replace(/^(?:Not assessed|Unconfirmed):\s*/i, '').trim();
        return t && !INTERNAL.test(t) ? `: ${words(t.replace(/^[A-Z](?=[a-z])/, (c) => c.toLowerCase()), 160 - ask.length - 2)}` : '.';
      };
      // each fact once: a finding listed above is only pointed to; its title stays here only when no visible list holds it (overflow, or a posted mismatch)
      const act = (x, say) => (x.f && listed.has(x.f) ? `${say}${link(x) || '.'}` : x.f ? `${say}: ${cell(title1(x.f.title), 110)}${link(x)}` : `${say}.`);
      const next = (x) => {
        if (x.align) { // the reviewer's open question (e.g. "rounded" in the text, a floor in the code) is what the person has to settle
          const q = String(x.cs.find((c) => c?.alignment?.status === 'unknown' && c.alignment.reason)?.alignment.reason || '').trim(), say = 'Check that the change does what this requirement says';
          return q && !INTERNAL.test(q) && !/^not stated\.?$/i.test(q) ? cell(`${say}: ${words(q.replace(/^[A-Z](?=[a-z])/, (c) => c.toLowerCase()), 160 - say.length - 2)}`, 160) : say;
        }
        if (x.kind === 'link') return cell(x.r.proto || x.cs.find((c) => c?.proto).proto, 160); // what is unknown, with no request for a test
        if (x.kind === 'unassessed' || x.kind === 'check') return cell(`${ask}${why(x.grp.find((y) => RANK[y.kind] === 2 && why(y) !== '.') || x)}`, 160); // the first human reason in the group
        const say = x.kind === 'mismatch' ? 'Fix the code or the requirement' : x.f?.kind === 'weak_test' ? 'Strengthen the test' : 'Add the test';
        const links = [...new Set(x.grp.filter((y) => y.kind === x.kind).map(url).filter(Boolean))]; // each finding once
        return links.length > 1 ? `${say} (${links.join(', ')})` : act(x, say);
      };
      const row = (ids) => (x) => `| ${x.kind === 'gap' ? 'Gap' : x.kind === 'mismatch' ? 'Mismatch' : 'Unconfirmed'} | ${ids ? `**${x.grp.map((y) => cell(y.r.id, 40)).join(', ')}** ` : ''}${cell(words(sentOf(x), 120))} | ${next(x)} |\n`;
      const th = '| Status | Requirement | What to do |\n|---|---|---|\n';
      add(vis, `### Requirements to check (${shown.length})\n\n${th}`, shown.slice(0, ROW_CAP).map(row(false)), shown.length > ROW_CAP ? `\n+${shown.length - ROW_CAP} more in Details.\n\n` : '\n');
      detail(`**More criteria to check (${shown.length - ROW_CAP})**\n\n${th}`, shown.slice(ROW_CAP, ROW_CAP + MORE_CAP).map(row(true)), shown.length > ROW_CAP + MORE_CAP ? `\n+${shown.length - ROW_CAP - MORE_CAP} more not shown.\n\n` : '\n');
    }
    listOf('Coding standard violations', ['standard'], 'More standards violations');
    listOf('Tests to move down', ['pushdown'], 'More tests to move down');
    detail(`**Low-confidence findings (${lows.length})**\n\n`, lows.map((e) => findingHead(e.f, { url: e.url, why: e.why, posted: 'url' in e }, blob)));
  }
  if (nrAll.length) add(vis, `### Not reviewed (${nrAll.length})\n\n`, nrAll.slice(0, NR_CAP).map((x) => `- ${x}\n`), nrAll.length > NR_CAP ? `- +${nrAll.length - NR_CAP} more in Details\n\n` : '\n');

  // ---- Details: the rest of the result, then run information
  let preDone = false; // pre-existing drift sits after Traceability whether or not there is findings data
  const addPre = () => { if (!preDone && !failed && pre.length) detail('**Pre-existing drift (not caused by this PR)**\n\n', pre.map((f, i) => `${findingBlock({ f }, blob, i, { flat: true })}\n`)); preDone = true; };
  if (!failed && data) {
    const covById = new Map(data.coverage.map((c) => [c.id, c]));
    detail(`**Evidenced criteria (${evidenced.length})**\n\n`, evidenced.slice(0, 50).map((x) => `- Evidenced: **${cell(x.r.id, 40)}** ${cell(words(sentOf(x), 120))}\n`), evidenced.length > 50 ? `- +${evidenced.length - 50} more\n\n` : '\n');
    const std = data.standards, lay = data.layering;
    detail('**Coding standards and test layers**\n\n', [`- Coding standards: ${STD_WORD[std.status] || cell(std.status)}. ${cell(std.reason)}${std.sources.length ? ` Sources: ${std.sources.map((s) => `\`${cell(s)}\``).join(', ')}.` : ''}\n`, `- Test layers: ${lay.status === 'checked' ? 'reviewed' : 'not reviewed'}. ${cell(lay.reason)}\n`]);
    if (tooling && tooling.status !== 'not_configured') add(det, `**Standards tooling: ${cell(tooling.status)}.** Commit: ${cell(tooling.ref || 'not selected')}. ${cell(tooling.reason || '')}\n\n`, (tooling.checks || []).map((c) => `- ${cell(c.name)}: ${cell(c.state)}; producer: ${cell(c.producer || 'unknown')}${/^https:\/\//.test(c.url) ? ` — [run](${c.url.replace(/[()]/g, (s) => encodeURIComponent(s))})` : ''}\n`), '\n');
    else if (lint.count > 0) detail('**Standards tooling**\n\n', [`Lint/format tools are configured (${lint.count} file${lint.count === 1 ? '' : 's'}) but no \`standards_checks\` are set, so their results are not confirmed.\n`]);
    detail('', [`**Requirements source:** ${cell(data.requirements_source)}\n\n`, ...(specFiles && !specFiles.length && !traceNote ? ['No requirement documents found (content-based discovery; see `requirements_paths` to add or exclude).\n\n'] : [])], '');
    if (data.coverage.length) {
      const k = data.coverage.filter((c) => c.status !== 'needs_human'), pr = k.length ? ` · Unit evidence: ${k.filter((c) => c.status === 'covered').length}/${k.length} obligations` : '';
      detail(`**Obligations (${data.coverage.length})${pr}**\n\nAn obligation is one testable behaviour taken from a criterion or from the changed code; a criterion can have several.\n\n| Obligation | Source / behaviour | Assertion evidence / layer | Status / reason |\n|---|---|---|---|\n`,
        data.coverage.map((c) => `| ${cell(`${c.id}: ${c.obligation}`, 500)} | ${cell(`${c.source}; ${c.behaviour ? `${c.behaviour.path}:${c.behaviour.line} — ${c.behaviour.quote}` : 'implementation not located'}`, 500)} | ${cell(c.evidence.map((e) => `${e.layer}: ${e.path}:${e.line} — ${e.quote} (${e.kind.replace(/_/g, ' ')}${e.proves ? `; ${e.proves}` : ''})`).join('; ') || 'none', 800)} | ${cell(`${STATUS_LABEL[c.status] || c.status}: ${c.reason}`, 500)} |\n`));
    }
    const t = traceTable(data, blob, specFiles, covById);
    if (t) add(det, t.head, t.atoms, '\n');
    addPre();
    if (!inc && data.not_reviewed) {
      const parts = nrParts(data.not_reviewed);
      detail(`**Not reviewed (${plural(parts.length, 'item')})**\n\n`, parts.slice(0, 40).map((x) => `- ${cell(x, 400)}\n`), `${parts.length > 40 ? `- +${parts.length - 40} more\n` : ''}\n`);
    }
    const vn = data.validation_notes || [];
    detail(`**Validation notes (${vn.length})**\n\n`, vn.map((m) => `- ${neutralize(m).replace(/\s*\n\s*/g, ' ')}\n`));
    detail('**Coverage evidence**\n\n', coverageAtoms(cov).map((x) => x.replace(/^<sub>|<\/sub>\n\n$/g, '').replace(/\n+$/, '\n')));
  }
  addPre();
  if (!failed) {
    const src = manifest && sourcesRead(manifest);
    if (src) detail(src.h, src.atoms);
    if (reduced) detail('**Reduced review**\n\n', [`Reasons: ${reduced.reasons.map((r) => cell(r.text)).join('; ')} (model: ${cell(reduced.model || 'unknown', 80)}). Only high-confidence findings were posted inline.\n`]);
    const sn = counts && counts.complete && counts.since;
    const more = [...runNotes.map((x) => `${cell(x)}\n`),
      ...(traceNote ? [`Traceability unavailable for this PR (${cell(traceNote)}).\n`] : []),
      ...(sn && counts.since_total ? [`Since earlier reviews${counts.prior_total > counts.since_total ? `, of the ${counts.since_total} most recent` : ''}: ${sn.addressed} addressed · ${sn.open} still open · ${sn.dismissed} dismissed · ${sn.not_observed} not observed (not proof of a fix)\n`] : []),
      ...(resolveNote ? [`Threads for findings no longer reported were left open: ${cell(resolveNote)} (see README, resolve_stale).\n`] : [])];
    detail('**Run notes**\n\n', more);
  }
  // the cost stays visible (money was spent, a failed run too): the last line, in small text, merged with the delivery
  const runAtom = engine ? `${runLine({ engine, model, raw: usage, notes, used, tier })}\n${require('./version').versionLine()}\n` : ''; // which SpecGuard produced this (review F12)
  const tailParts = [...(engine ? usageParts({ engine, model, raw: usage, notes, used, tier }) : []), ...(delivery ? [neutralize(delivery)] : [])];
  const delivered = tailParts.length ? `\n<sub>${tailParts.join(' · ')}</sub>\n` : '';

  // ---- assemble under BODY_MAX: visible first, then Details with what is left
  const RESERVE = 200; // for the closing "(truncated)" line
  const last = notice ? `${notice}\n\n` : ''; // after the last visible section, before Details
  let out = `${markers}${verdict}\n${line2 ? `\n${line2}` : ''}\n`, cut = false, pend = last.length;
  const room = () => BODY_MAX - RESERVE - out.length - delivered.length - pend;
  for (const { h, atoms, tail } of vis) {
    if (!atoms.length && !h) continue;
    let body = '', n = 0;
    for (const a of atoms) { if (h.length + body.length + a.length + tail.length > room()) break; body += a; n++; }
    if (n < atoms.length) { cut = true; if (!n) continue; body += `_+${atoms.length - n} more not shown._\n`; }
    out += h + body + tail;
  }
  out += last; pend = 0;
  const open = `<details><summary>${failed ? 'Details: run information' : 'Details: evidenced criteria, obligations, sources, run information'}</summary>\n\n`, close = '</details>\n';
  let inner = '', dropped_ = 0;
  const left = () => room() - open.length - close.length - runAtom.length - 2;
  for (const { h, atoms, tail } of det) {
    let body = '', n = 0;
    for (const a of atoms) { if (h.length + inner.length + body.length + a.length + tail.length > left()) break; body += a; n++; }
    dropped_ += atoms.length - n;
    if (n || !atoms.length) inner += `${h}${body}${n < atoms.length ? `_+${atoms.length - n} more not shown._\n` : ''}${tail}`;
  }
  if (inner || runAtom) out += `${open}${inner}${runAtom}\n${close}`;
  if (dropped_ || cut) out += `\n_(truncated: the summary exceeded the comment size limit; ${cut ? 'the most important sections come first' : 'details were dropped first'})_\n`;
  return clean(out + delivered);
}

// Workspace file as lines. Never anything under .git/ or the collection context, never a path that escapes the workspace
// (also after symlinks): those hold credentials and the collector's own state.
const DENIED = /^(?:\.git|\.specguard-ctx|\.specguard-src)(?:\/|$)/i; // .specguard-src: the reviewer's own checkout in manual runs, not the repository under review
const readFile = (p) => {
  try {
    const rel = safeRel(p);
    if (!rel || DENIED.test(rel)) return null;
    const root = fs.realpathSync(process.env.GITHUB_WORKSPACE || process.cwd());
    const target = fs.realpathSync(path.resolve(root, rel));
    const relative = path.relative(root, target);
    if (!relative || relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative)) return null;
    if (DENIED.test(relative.split(path.sep).join('/'))) return null;
    if (process.env.CTX) { // the context directory, wherever it sits
      let ctx = null;
      try { ctx = fs.realpathSync(path.resolve(root, process.env.CTX)); } catch { /* no such directory: nothing to protect */ }
      if (ctx && (target === ctx || target.startsWith(ctx + path.sep))) return null;
    }
    return fs.readFileSync(target, 'utf8').split(/\r?\n/);
  } catch { return null; }
};
// Tracked files at the checked-out head (git ls-files), or null when git cannot say. Evidence, behaviour and finding citations
// are only read from these: an untracked or ignored file is never something the PR changed or tests exercise.
function trackedFiles(root) {
  try { return new Set(execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 1 << 28 }).split('\0').filter(Boolean)); }
  catch { return null; }
}

// Verifies citations, not the model's semantic judgement. Never upgrades missing evidence.
function verifyEvidence(data, reviewable, standards, read = readFile, maps = new Map()) {
  // Corrects c.line (a hint) to where the quote is, by findLine: within +-5 lines, else the one line among `all` (candidate line numbers)
  // holding it (e.g. when the model cited a diff.patch line number), else the one line starting with its first 20 non-space characters.
  // Several matches or none keep the citation unverified. A trimmed quote is replaced by the line's own text.
  const locate = (c, at, all = []) => {
    const l = findLine(c.quote, c.line, at, all);
    if (!l) return false;
    c.line = l;
    if (norm(at(l)) !== norm(c.quote)) c.quote = String(at(l)).trim();
    return true;
  };
  const changed = (c) => (l) => maps.get(c.path)?.changed[c.side || 'RIGHT'].get(l);
  const keys = (c) => maps.get(c.path)?.changed[c.side || 'RIGHT'].keys() || []; // the known (changed) line range of that side
  const exact = (c) => {
    const lines = c.side === 'LEFT' ? null : read(c.path);
    return c.side === 'LEFT' ? locate(c, changed(c), keys(c)) : locate(c, (l) => lines?.[l - 1], lines ? lines.map((_, i) => i + 1) : []);
  };
  // a behaviour or changed-line quote that is a removed line, cited without side LEFT: set to LEFT with a note (same repair as findings and removed evidence).
  // Never for assertion evidence: a removed assertion cannot carry coverage.
  const toLeft = (c, id) => {
    if (c.side === 'LEFT' || !maps.get(c.path)) return false;
    const l = { ...c, side: 'LEFT' };
    if (!locate(l, changed(l), keys(l))) return false;
    Object.assign(c, l);
    (data.validation_notes ||= []).push(`${id}: ${c.path}:${c.line} is a removed line cited without side LEFT; set to LEFT.`);
    return true;
  };
  const stray = []; // obligations whose change citation is an unchanged line of a changed file
  for (const c of data.coverage) {
    const { change } = c, fails = []; // every citation is checked (locate corrects lines in place); the failures are named
    const check = (label, x, pass) => { if (!pass) fails.push(`${label} ${x.path}:${x.line}`); };
    if (change) {
      const rev = reviewable.has(change.path), onChange = rev && (locate(change, changed(change), keys(change)) || toLeft(change, c.id));
      const unchanged = rev && !onChange && change.side !== 'LEFT' && exact(change); // a real line of the file at head that the PR did not change: the citation is dropped, not the obligation
      if (unchanged) c.change = null;
      else check('changed line', change, onChange);
    }
    if (c.behaviour) check('behaviour', c.behaviour, exact(c.behaviour) || toLeft(c.behaviour, c.id));
    c.evidence.forEach((e, i) => check(`evidence ${i + 1}`, e, exact(e)));
    if (!fails.length && c.status === 'covered') { // a quote that exists must also be an assertion in a test that runs
      const bad = [];
      for (const e of c.evidence) if (e.kind === 'assertion' && e.side !== 'LEFT') { const k = assertionKind(read(e.path) || [], e.line, e.quote); if (k !== 'assertion') { e.kind = k; bad.push(`${e.path}:${e.line} is ${k === 'disabled' ? 'in a skipped or disabled test' : 'not an assertion'}`); } }
      if (bad.length && !c.evidence.some((e) => e.layer === 'unit' && e.kind === 'assertion' && e.side !== 'LEFT')) {
        c.status = 'unknown';
        c.reason = `Not covered: the cited evidence is not a running assertion (${bad.join('; ')}).`;
        degrade(data, c.id, `Obligation ${c.id} marked unknown: ${bad.join('; ')}.`);
      }
    }
    if (!fails.length && c.status === 'covered') { // evidence that only checks truthiness or that a call happened pins no expected value
      const as = c.evidence.filter((e) => e.kind === 'assertion' && e.side !== 'LEFT');
      if (as.length && as.every((e) => weakAssertion(e.quote))) {
        c.status = 'unknown';
        c.reason = 'Not covered: only truthiness/interaction assertions are cited; no assertion pins the expected value.';
        (data.validation_notes ||= []).push(`Obligation ${c.id} not covered: only truthiness/interaction assertions are cited.`);
      }
    }
    if (change && !c.change && !fails.length) stray.push(c.id);
    if (fails.length) {
      const why = `could not verify citation: ${fails.join('; ')}`;
      c.status = 'unknown';
      c.reason = `Could not verify the citation: ${fails.join('; ')}.`;
      c.alignment = unknownAlign(`A citation could not be verified (${fails.join('; ')}).`);
      degrade(data, c.id, `Obligation ${c.id} marked unknown: ${why}.`);
    }
  }
  if (stray.length) (data.validation_notes ||= []).push(`${stray.length} ${stray.length === 1 ? 'obligation cites an unchanged line' : 'obligations cite unchanged lines'} of changed files (${stray.join(', ')}); their tests were still checked.`);
  const invalid = new Set(data.coverage.filter((c) => c.status === 'unknown').map((c) => c.id));
  data.findings = data.findings.map((f) => ({ ...f, obligation_ids: f.obligation_ids.filter((id) => !invalid.has(id)) }))
    .filter((f) => f.kind === 'standard' || f.obligation_ids.length);
  settle(data, data.validation_notes ||= []);
  if ((data.standards.status === 'no_rules' && standards.size) || data.standards.sources.some((s) => !standards.has(s))) {
    data.standards = { status: 'not_reviewed', sources: [], reason: 'The standards assessment does not match the trusted rule inventory.' };
    data.findings = data.findings.filter((f) => f.kind !== 'standard');
    (data.validation_notes ||= []).push('Standards assessment does not match the trusted rule inventory; not reviewed.');
  }
  return data;
}

// 1-based first line of text where the (normalised) quote starts, or 0. Never guesses.
function quoteLine(lines, quote) {
  const q = plain(quote), qs = String(quote).split('\n').map(plain).filter(Boolean), N = lines.map(plain);
  if (!qs.length) return 0;
  const win = (i) => N.slice(i, i + qs.length + 6).join(' ').includes(q); // tolerates a quote wrapped over a few lines
  return N.findIndex((l, i) => l && win(i) && !win(i + 1)) + 1; // the quote starts on the last line from which it still fits
}

// "R1, R2, R3, R4, S1" -> "R1-R4, S1": a run of three or more consecutive numbers of one prefix is a range.
function idRange(ids) {
  const by = new Map(), other = [];
  for (const id of ids) { const m = /^([A-Za-z]+)(\d+)$/.exec(id); if (m) by.set(m[1], [...(by.get(m[1]) || []), +m[2]]); else other.push(id); }
  const out = [];
  for (const [p, ns] of by) {
    ns.sort((a, b) => a - b);
    for (let i = 0; i < ns.length;) {
      let j = i;
      while (j + 1 < ns.length && ns[j + 1] === ns[j] + 1) j++;
      if (j - i >= 2) out.push(`${p}${ns[i]}-${p}${ns[j]}`); else for (let k = i; k <= j; k++) out.push(`${p}${ns[k]}`);
      i = j + 1;
    }
  }
  return [...out, ...other].join(', ');
}

// context.specFiles (optional): the trusted spec-files.txt allow-list. A requirement citing a repository file outside it is unlinked.
function verifyRequirements(data, context, read = readFile) {
  const allow = context.specFiles ? new Set(context.specFiles) : null;
  const note = (s) => { data.not_reviewed = [data.not_reviewed, s].filter(Boolean).join(' '); };
  const invalid = new Map(), unassessed = [], unverified = new Set(); // invalid: obligation id -> the requirement citation that failed; unverified: obligations behind a criterion whose wording is not in its source
  const fail = (r, why) => r.obligation_ids.forEach((id) => invalid.set(id, `requirement ${r.id} ${r.source}${r.line ? `:${r.line}` : ''}: ${why}`));
  const texts = new Map(); // normalised once per source, not once per criterion
  const textOf = (key, get) => { if (!texts.has(key)) { const text = get(); const lines = text.split(/\r\n|\r|\n/), pl = lines.map(plain); texts.set(key, { text, n: plain(text), x: norm(text), lines, pl, at: new Map(pl.map((p, i) => [p, i]).reverse()) }); } return texts.get(key); }; // at: first line index per plain line
  const byId = new Map(data.requirements.map((r) => [r.id, r]));
  const docs = new Map();
  for (const d of context.documents || []) if (!docs.has(d.source)) docs.set(d.source, d);
  const labels = new Set([...docs.keys(), ...(context.criteria || []).map((e) => e.source)]);
  const collectedIds = new Set((context.criteria || []).map((e) => e.id));
  for (const r of data.requirements) { // the model's source may carry an item label: it becomes the item (ref) only when the source text has that ID, else it is display text and dropped
    const c = typeof r.source === 'string' && !collectedIds.has(r.id) ? canonSource(r.source, labels) : null; // a collected criterion keeps the strict check below
    if (!c || c.source === r.source) continue;
    r.source = c.source;
    const d = docs.get(c.source);
    if (c.item && !r.ref && d && new RegExp(`(?<![\\w-])${c.item.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`).test(d.text) && safeRef(c.item)) r.ref = safeRef(c.item);
  }
  for (const expected of context.criteria || []) {
    const r = byId.get(expected.id);
    if (r) { if (!r.source) r.source = expected.source; if (!r.quote) r.quote = expected.quote; } // omitted by the model: the collected text is the trusted copy
    if (!r) { if (!expected.optional) data.requirements.push({ id: expected.id, source: expected.source, quote: expected.quote, ...(expected.ref && { ref: expected.ref }), ...(expected.line && { line: expected.line }), obligation_ids: [], reason: 'Structured acceptance criterion was not assessed.' }); } // optional (history) criteria are never re-added
    else if (!(r.source === expected.source || r.source.startsWith(`${expected.source} AC `) && /^\d+$/.test(r.source.slice(expected.source.length + 4))) || plain(r.quote) !== plain(expected.quote)) {
      fail(r, 'its ID did not match the collected source text');
      Object.assign(r, { source: expected.source, quote: expected.quote, obligation_ids: [], reason: 'Criterion ID did not match its collected source text.' });
    } else { // "PR body AC 1" is accepted; the collected label and ref are canonical (the model's own ref is never trusted)
      r.source = expected.source;
      r.quote = expected.quote;
      if (expected.ref) r.ref = safeRef(expected.ref); else delete r.ref;
    }
  }
  // A D criterion the model gave no obligations for: the trace knows the hunks that picked it, so it links every obligation whose behaviour or change line falls inside them.
  for (const expected of context.criteria || []) {
    const r = byId.get(expected.id) || data.requirements.find((x) => x.id === expected.id);
    if (!r || !Array.isArray(expected.hunks) || r.obligation_ids.length) continue;
    const inside = (v) => v && expected.hunks.some((h) => h && v.path === h.path && v.line >= h.start && v.line <= h.end);
    const hit = data.coverage.filter((c) => inside(c.behaviour) || inside(c.change));
    if (!hit.length) continue;
    r.obligation_ids = hit.map((c) => c.id);
    r.reason = `Linked by the trace to ${r.obligation_ids.join(", ")}.`;
    r.trace_linked = true;
    for (const c of hit) if (c.alignment?.status === 'not_applicable') c.alignment = unknownAlign('not stated');
  }
  // an R/S/H id with nothing to fill it from is not a collected criterion: there is nothing to assess against, so it gets no row. The obligations it named stay "from behaviour".
  const phantom = data.requirements.filter((r) => !r.source || !r.quote).map((r) => String(r.id));
  if (phantom.length) {
    data.requirements = data.requirements.filter((r) => r.source && r.quote);
    note(`The review cited criteria ${idRange(phantom)} that were not collected; they were ignored.`);
  }
  for (const r of data.requirements) {
    const label = r.source.replace(/ AC \d+$/, '');// "PR body AC 3" -> the collected document label
    const collected = docs.get(label);
    // A source is exactly a collected document label, or a normalised repository path that the allow-list names (when there is one).
    const file = safeRel(label.replace(REMOVED, ''));
    const isPath = specPath(label);
    const rejected = !collected && isPath && !(file && (!allow || allow.has(file)));
    const T = rejected ? { text: '', n: '' } : textOf(collected ? `label:${label}` : `file:${file}`, () => (collected ? collected.text : isPath ? (read(file) || []).join('\n') : ''));
    const has = (q) => { const p = plain(q); return !!p && T.n.includes(p); };
    const found = !rejected && has(r.quote);
    if (!found) {
      if (rejected) fail(r, 'not a collected requirement document');
      else if (!context.unavailable) r.obligation_ids.forEach((id) => unverified.add(id)); // the criterion is unassessed; the obligations' own citations are verified independently
      r.obligation_ids = [];
      if (rejected) r.proto = 'Requirement link not verified: the cited source is not a collected requirement document';
      r.reason = rejected ? 'The cited file is not a collected requirement document.' : 'Requirement wording not verified: the quote was not found in its source, so this criterion is not assessed.';
    } else if (!T.x.includes(norm(r.quote))) { // matched only as plain text: store the source's own line when the quote is one whole line
      const line = T.text.split(/\r\n|\r|\n/).find((l) => plain(l) === plain(r.quote));
      if (line !== undefined) r.quote = line.replace(MARKER, '').trim();
    }
    if (found) { // the display text is the source's whole line (a model quotes a fragment of the bullet), without its list marker; a quote wrapped over lines stays as is
      const pq = plain(r.quote), i = T.at.has(pq) ? T.at.get(pq) : T.pl.findIndex((l) => l.includes(pq));
      if (i >= 0) r.sentence = T.lines[i].replace(MARKER, '').trim();
    }
    if (found && specPath(label)) { // re-derive the line from the quote; a model-supplied line is never trusted
      const at = quoteLine(T.text.split('\n'), r.quote);
      if (at) { r.line = at; r.end = at + String(r.quote).split('\n').length - 1; } else delete r.line;
    }
    if (r.pr_quote !== undefined) { // a verified sentence from the PR body, else null
      const pr = docs.get('PR body');
      if (!(typeof r.pr_quote === 'string' && pr && plain(r.pr_quote) && textOf('label:PR body', () => pr.text).n.includes(plain(r.pr_quote)))) r.pr_quote = null;
    }
    if (!r.obligation_ids.length) unassessed.push(`Requirement ${r.id} is not assessed: ${r.reason}`);
  }
  if (unassessed.length) note(unassessed.slice(0, 10).join(' ') + (unassessed.length > 10 ? ` ${unassessed.length - 10} more requirements are not assessed.` : ''));
  const linked = new Set(data.requirements.flatMap((r) => r.obligation_ids));
  for (const c of data.coverage) if (unverified.has(c.id) && !invalid.has(c.id) && !linked.has(c.id) && c.alignment.status !== 'unknown') { // status and citations stand; only the alignment needs the requirement
    (data.validation_notes ||= []).push(`Obligation ${c.id} alignment unknown: requirement wording not verified.`);
    c.alignment = unknownAlign('Requirement wording not verified.');
  }
  // A broken requirement link drops only the link: a row whose own behaviour citation stands (verifyEvidence already unknowned any that failed) keeps its status and finding; settle() makes its alignment unknown.
  for (const c of data.coverage) if (invalid.has(c.id) && c.behaviour && c.status !== 'unknown') invalid.delete(c.id);
  for (const c of data.coverage) if (invalid.has(c.id)) {
    const why = `The linked requirement citation could not be verified (${invalid.get(c.id)})`;
    c.status = 'unknown'; c.reason = `${why}.`;
    c.alignment = unknownAlign(`${why}.`);
    (data.validation_notes ||= []).push(`Obligation ${c.id} marked unknown: ${why}.`);
  }
  data.findings = data.findings.map((f) => ({ ...f, obligation_ids: f.obligation_ids.filter((id) => !invalid.has(id)) }))
    .filter((f) => f.kind === 'standard' || f.obligation_ids.length);
  settle(data, data.validation_notes ||= []);
  return data;
}

// Differential check: an 'introduced' mismatch/impacted becomes 'pre_existing' unless this PR touched the relation, i.e. the
// requirement item's lines (either side), the behaviour line (RIGHT), or a change in the same hunk as the behaviour.
// Cross-language keywords that are never a defined name. ponytail: tiny stoplist; upgrade = parse the declaration with the language's own tooling.
const KW = new Set('return const let var function async await class this self true false null none nil else elif throw raise import from export public private static void string number bool int float then with while for if not and or new def func type'.split(' '));
// Names a line DEFINES (assignment, declaration, object/keyword property, function or class head), not names it merely mentions.
function definedNames(t) {
  const s = String(t || ''), out = new Set();
  for (const m of s.matchAll(/(?:^|[^\w.])([A-Za-z_]\w{2,})\s*(?::[^=\n]*)?=(?![=>])/g)) out.add(m[1]);
  for (const m of s.matchAll(/(?:function|def|func|fn|class|let|var|const)\s+([A-Za-z_]\w{2,})/g)) out.add(m[1]);
  for (const m of s.matchAll(/^\s*["']?([A-Za-z_]\w{2,})["']?\s*:(?!:)/g)) out.add(m[1]);
  return [...out].filter((w) => !KW.has(w.toLowerCase()));
}
// True when the changed line defines a name the behaviour line uses (a constant defined away from its use).
function definesUsedBy(change, behaviour) {
  const b = String(behaviour || '');
  return definedNames(change).some((w) => new RegExp('(?:^|[^\\w])' + w + '(?![\\w])').test(b));
}

// Execution evidence from src/coverage.js (coverage.json); null = off (no report, unreadable, or none usable). `miss` = [[from, to]] lines of a changed file that are
// instrumented and never ran (whole file); `never` = the same restricted to lines this PR added. Only a changed file has an entry: elsewhere nothing is known.
function loadCoverage(raw) {
  try {
    const j = JSON.parse(raw);
    return j && j.v === 1 && j.files && typeof j.files === 'object' ? j : null;
  } catch { return null; }
}
const neverRan = (cov, p, l) => {
  const f = cov && cov.reports > 0 && Number.isInteger(l) && Object.hasOwn(cov.files, p) ? cov.files[p] : null;
  return !!f && Array.isArray(f.miss) && f.miss.some((r) => Array.isArray(r) && l >= r[0] && l <= r[1]);
};
// A row the model marked covered whose behaviour line never ran in the report is not covered. Never an upgrade.
function applyCoverage(data, cov) {
  if (!cov || !(cov.reports > 0)) return;
  const down = new Set();
  for (const c of data.coverage) {
    const b = c.behaviour;
    if (c.status === 'covered' && b && b.side !== 'LEFT' && neverRan(cov, b.path, b.line)) {
      Object.assign(c, { status: 'unknown', reason: `The coverage report shows this line never ran (${b.path}:${b.line}).` });
      degrade(data, c.id, `Obligation ${c.id} marked unknown: the coverage report shows ${b.path}:${b.line} never ran.`);
      down.add(c.id);
    }
  }
  if (!down.size) return;
  data.findings = data.findings.map((f) => ({ ...f, obligation_ids: f.obligation_ids.filter((id) => !down.has(id)) })).filter((f) => f.kind === 'standard' || f.obligation_ids.length);
  settle(data, data.validation_notes ||= []);
}
// Summary facts for the Unit test gaps section; deterministic, not model findings. Compact and capped.
function coverageAtoms(cov) {
  if (!cov) return [];
  if (!(cov.reports > 0)) return cov.notes?.length ? [`<sub>Coverage evidence not used: ${cell(String(cov.notes[0]), 200)}</sub>\n\n`] : [];
  const n = (x) => (Number.isInteger(x) && x >= 0 ? x : 0), t = cov.total || {}, out = [];
  if (n(t.instrumented)) out.push(`Changed lines executed by tests: ${n(t.executed)} of ${n(t.instrumented)} instrumented (coverage report)\n\n`);
  const lines = (f) => (f.never || []).reduce((a, r) => a + (Array.isArray(r) ? n(r[1]) - n(r[0]) + 1 : 0), 0);
  const rows = Object.entries(cov.files).filter(([, f]) => f && Array.isArray(f.never) && f.never.length).sort((a, b) => lines(b[1]) - lines(a[1]));
  if (rows.length) {
    const rs = (f) => f.never.slice(0, 8).filter(Array.isArray).map(([a, b]) => (a === b ? `L${n(a)}` : `L${n(a)}-L${n(b)}`)).join(', ') + (f.never.length > 8 ? `, +${f.never.length - 8} more` : '');
    out.push(`Changed lines no test executed (coverage report):\n${rows.slice(0, 10).map(([p, f]) => `- \`${cell(p, 120)}\`: ${rs(f)}\n`).join('')}${rows.length > 10 ? `- +${rows.length - 10} more files\n` : ''}\n`);
  }
  return out;
}

function differential(data, maps) {
  for (const c of data.coverage) {
    const a = c.alignment;
    if (!['mismatch', 'impacted'].includes(a.status) || !['introduced', 'pre_existing'].includes(a.since)) continue;
    const specTouched = data.requirements.filter((r) => r.obligation_ids.includes(c.id)).some((r) => {
      if (REMOVED.test(r.source)) return true;
      const m = maps.get(r.source);
      if (!m || !r.line) return false;
      for (let l = r.line; l <= (r.end || r.line); l++) if (m.changed.RIGHT.has(l) || m.changed.LEFT.has(l)) return true;
      return false;
    });
    const b = c.behaviour, ch = c.change, mb = b && maps.get(b.path);
    const behaviourChanged = !!mb && mb.changed.RIGHT.has(b.line);
    const hunk = mb && ch && ch.path === b.path ? (ch.side === 'LEFT' ? mb.LEFT : mb.RIGHT).get(ch.line) : undefined;
    const linked = !!ch && !!b && definesUsedBy(ch.quote, b.quote); // a nearby edit only counts when it defines something the behaviour line uses
    const sameHunk = linked && hunk !== undefined && hunk === mb.RIGHT.get(b.line);
    // (d) the PR modified existing text (hunk has removed lines) at `change`, e.g. a constant defined away from its use.
    // ponytail: (c) and (d) need `change` to DEFINE a name that `behaviour` uses (the constant defined away from its use). Misses an indirect change (a callee body); upgrade = the call graph.
    const mc = ch && ch.side !== 'LEFT' && maps.get(ch.path), ch_h = mc && mc.changed.RIGHT.has(ch.line) ? mc.RIGHT.get(ch.line) : undefined;
    const modified = linked && ch_h !== undefined && !data.requirements.some((r) => r.source === ch.path) && [...mc.LEFT.values()].includes(ch_h);
    // (e) the PR removed code at `change` in the behaviour's file (a deleted check or branch): the surviving behaviour line is unchanged, but this PR made the drift
    // also when the model cited the surviving neighbour instead: the hunk that holds the behaviour line deletes code (more lines removed than added; a rewrite does not count)
    // (Kite #16: the writable check deleted next to the folder check)
    const hb = mb && b.side !== 'LEFT' ? mb.RIGHT.get(b.line) : undefined, count = (side) => [...mb.changed[side].keys()].filter((l) => mb[side].get(l) === hb).length;
    const removedHere = (!!ch && !!b && ch.side === 'LEFT' && ch.path === b.path && !!mb && mb.changed.LEFT.has(ch.line)) || (hb !== undefined && count('LEFT') > count('RIGHT'));
    const touched = specTouched || behaviourChanged || sameHunk || modified || removedHere;
    if (a.since === 'introduced' && !touched) c.alignment = { ...a, since: 'pre_existing', reason: `${a.reason} (Downgraded to pre_existing: this PR changed neither the requirement nor the behaviour.)` };
    else if (a.since === 'pre_existing' && touched) { // symmetric: a model-emitted pre_existing cannot hide drift this PR touched
      c.alignment = { ...a, since: 'introduced', reason: `${a.reason} (Upgraded to introduced: this PR changed the requirement or the behaviour.)` };
      (data.validation_notes ||= []).push(`Obligation ${c.id}: pre_existing claim overridden to introduced; the PR touched the requirement or the behaviour.`);
    }
  }
}

// Marks requirement rows whose text this PR changed (from the collected S criteria, else the spec item lines in the diff) or whose
// document it authored. The requirement text is read from the PR head, so this is shown, never silently trusted.
function markChanged(data, status) {
  const crit = new Map(((status && status.criteria) || []).filter((c) => c.change).map((c) => [c.id, c]));
  const added = new Set((status && status.spec && status.spec.added) || []);
  for (const r of data.requirements) {
    const label = r.source.replace(REMOVED, ''), c = crit.get(r.id);
    if (added.has(label)) r.req_change = { kind: 'authored' };
    else if (c && c.source === label) r.req_change = { kind: c.change, ...(c.previous && { previous: c.previous }) };
    else if (r.reflected_in && r.reflected_in.spec) r.req_change = { kind: 'modified' };
  }
}

// reflected_in per requirement with an assessed alignment: did the PR also update the spec, the tests, and say so in its description?
function reflect(data, maps, reviewable) {
  for (const r of data.requirements) {
    const rows = data.coverage.filter((c) => r.obligation_ids.includes(c.id) && ['consistent', 'mismatch', 'impacted'].includes(c.alignment.status));
    if (!rows.length) continue;
    const m = maps.get(r.source);
    let spec = REMOVED.test(r.source);
    if (m && r.line) for (let l = r.line; l <= (r.end || r.line); l++) if (m.changed.RIGHT.has(l)) spec = true;
    r.reflected_in = { spec, tests: rows.some((c) => c.evidence.some((e) => reviewable.has(e.path))), pr: typeof r.pr_quote === 'string' && r.pr_quote.length > 0 };
  }
}

// Rename-aware maps (git diff -M) for the differential only: diff.patch is written with --no-renames, so a moved file would look wholly changed.
function renameMaps(base, head, cwd, git = (...a) => execFileSync('git', a, { cwd, encoding: 'utf8', maxBuffer: 1 << 28 })) {
  const out = new Map();
  try {
    const t = git('diff', '-M', '--name-status', '-z', `${base}...${head}`).split('\0');
    for (let i = 0; i < t.length - 1;) {
      if (!/^[RC]/.test(t[i++])) { i++; continue; }
      const [from, to] = [t[i++], t[i++]];
      out.set(to, parseDiff(git('diff', '-M', '--no-color', '--no-ext-diff', `${base}...${head}`, '--', from, to)).get(to) || parsePatch(''));
    }
  } catch { /* fall back to the plain maps */ }
  return out;
}

// All review threads (first 300), each { id, isResolved, resolvedBy, comments: { nodes: [first 30] } }. Throws on a GraphQL error.
const THREADS_Q = 'query($o:String!,$r:String!,$n:Int!,$a:String){repository(owner:$o,name:$r){pullRequest(number:$n){reviewThreads(first:100,after:$a){pageInfo{hasNextPage endCursor}nodes{id isResolved resolvedBy{login __typename} comments(first:30){nodes{author{login __typename} body}}}}}}}';
async function fetchThreads({ github, owner, repo, number, maxThreads = 300 }) {
  const nodes = [];
  let after = null;
  while (nodes.length < maxThreads) {
    const t = (await github.graphql(THREADS_Q, { o: owner, r: repo, n: number, a: after })).repository.pullRequest.reviewThreads;
    nodes.push(...t.nodes);
    if (!t.pageInfo.hasNextPage) break;
    after = t.pageInfo.endCursor;
  }
  return nodes;
}

// Resolve review threads whose only comment is our own bot comment for a finding this run no longer reports. Any failure is a limitation note, never a run failure.
// threads: the already fetched thread list (the telemetry read), else fetched here.
async function resolveStale({ github, core, owner, repo, number, current, actor = null, maxResolve = 20, threads }) {
  try {
    const stale = [];
    for (const th of threads || await fetchThreads({ github, owner, repo, number })) {
      const cs = th.comments.nodes;
      const m = cs.length === 1 && !th.isResolved && ours(cs[0].author, actor) && /<!-- specguard:fp=([0-9a-f]{40}) -->\s*$/.exec(cs[0].body || '');
      if (m && !current.has(m[1])) stale.push(th.id);
    }
    for (const threadId of stale.slice(0, maxResolve)) await github.graphql('mutation($t:ID!){resolveReviewThread(input:{threadId:$t}){thread{id}}}', { t: threadId });
  } catch (e) {
    core.warning(`SpecGuard: stale review threads could not be resolved: ${e.message}`);
    // returns a short reason when the token itself is not allowed to resolve threads, so the summary can say why they stayed open
    if (e.status === 403 || /Resource not accessible by integration/i.test(e.message)) return 'this token cannot resolve review threads';
  }
}

// Did the author's own commits from `from` to `to` change a line of the old side of `file` in [start, end]? true / false, or null when git
// cannot say (commit not fetched, shallow clone, the PR was rewritten so `from` is no ancestor, file deleted or renamed: not evidence about the anchor).
// First-parent, non-merge commits only (a base branch merged into the PR is not the author's change); the range is followed through each commit in turn.
// Whitespace-only edits do not count.
function anchorTouched(from, to, file, start, end, cwd, git = (...a) => execFileSync('git', a, { cwd, encoding: 'utf8', maxBuffer: 1 << 26 })) {
  if (!/^[0-9a-f]{7,64}$/i.test(String(from)) || !file || !(end >= 1)) return null;
  try {
    git('merge-base', '--is-ancestor', from, to);
    const log = git('log', '--first-parent', '--no-merges', '--reverse', '-p', '-U0', '-w', '--no-color', '--no-ext-diff', '--no-renames', '--format=%x00', `${from}..${to}`, '--', file);
    let s = start, e = end;
    for (const d of log.split('\0')) {
      if (/^(?:deleted file mode|\+\+\+ \/dev\/null)/m.test(d)) return null;
      let shift = 0;
      for (const m of d.matchAll(/^@@ -(\d+)(?:,(\d+))? \+\d+(?:,(\d+))? @@/gm)) {
        const a = +m[1], n = m[2] === undefined ? 1 : +m[2], k = m[3] === undefined ? 1 : +m[3]; // n === 0: pure insertion after old line a
        if (n ? a <= e && a + n - 1 >= s : a >= s && a < e) return true;
        if ((n ? a + n - 1 : a) < s) shift += k - n; // wholly before the range: it moves
      }
      s += shift; e += shift;
    }
    return false;
  } catch { return null; }
}

// Did the author's own commits from `from` to `to` (first-parent, no merges) change any test file? true / false, or null when git cannot say.
const isTest = (p) => require('./trace').isTestPath(p); // lazily: trace.js requires this module
function testsChanged(from, to, cwd, git = (...a) => execFileSync('git', a, { cwd, encoding: 'utf8', maxBuffer: 1 << 26 })) {
  if (!/^[0-9a-f]{7,64}$/i.test(String(from))) return null;
  try {
    git('merge-base', '--is-ancestor', from, to);
    return git('log', '--first-parent', '--no-merges', '--name-only', '--format=', '--no-renames', `${from}..${to}`).split('\n').some((p) => p && isTest(p));
  } catch { return null; }
}

// The author's verdict on a finding: the last reply by a person (not us, not a bot) that STARTS with a verdict word, optionally after "specguard:" or "/specguard". Else null.
const VERDICT = /^\s*(?:\/?specguard\b\s*[:,-]?\s*)?(fixed|wrong|false[ -]positive|intentional|by[ -]design|won'?t[ -]fix|not[ -]important|doesn'?t[ -]matter|nit)(?![\w'])/i;
const VERDICT_AS = { false_positive: 'wrong', by_design: 'intentional', wont_fix: 'intentional', doesnt_matter: 'not_important', nit: 'not_important' };
const verdictOf = (th, me) => {
  let v = null;
  for (const c of (th?.comments.nodes || []).slice(1)) {
    const k = c.author?.__typename === 'User' && !ours(c.author, me) && VERDICT.exec(c.body || '')?.[1].toLowerCase().replace(/[ -]/g, '_').replace(/'/g, '');
    if (k) v = VERDICT_AS[k] || k;
  }
  return v;
};
// fp -> its review thread (the latest when several share one), for threads whose first comment is ours.
const threadsByFp = (threads, me) => {
  const m = new Map();
  for (const th of threads || []) {
    const c = th.comments.nodes[0], f = c && ours(c.author, me) && /<!-- specguard:fp=([0-9a-f]{40}) -->\s*$/.exec(c.body || '');
    if (f) m.set(f[1], th);
  }
  return m;
};

// One record per earlier SpecGuard finding (priors: Map fp -> REST review comment, oldest first). Only called on a complete run:
// `survive` is then every fingerprint still reported. Each lookup failing degrades that field to unknown, never the run.
// `unseen(path)`: this run could not see that file, so its silence about a finding there is no evidence (addressed -> not_observed, judged: false).
// A synthetic prior (summary-only finding, see `sum`) has a 16-hex fp and no thread: it can never be dismissed.
function followUp({ priors, survive, me, headSha, cwd, threads, unseen = () => false }) {
  const byFp = threadsByFp(threads, me);
  const out = [];
  for (const [fp, c] of [...priors].slice(-HARD_CAP)) {
    const roll = c.reactions || {}, n = (k) => (Number.isInteger(roll[k]) ? roll[k] : 0); // we add no reactions: every one is a person's
    const th = byFp.get(fp);
    const link = /\]\(https?:\/\/[^)\s]*\/blob\/[0-9a-f]+\/[^)\s]*#L(\d+)(?:-L(\d+))?\)/.exec(c.body || ''); // a file-level comment names its lines only in this link
    const end = c.original_line ?? (link ? +(link[2] || link[1]) : null), start = c.original_start_line ?? (link ? +link[1] : end);
    const rec = {
      fp, kind: (/kind: (\w+), confidence/.exec(c.body || '') || [])[1] || c.kind || null, still_reported: survive.has(fp) || (fp.length === 16 && [...survive].some((x) => x.startsWith(fp))),
      anchor_touched: anchorTouched(c.original_commit_id, headSha, c.path, start, end, cwd),
      tests_changed: testsChanged(c.original_commit_id, headSha, cwd),
      thread: !th ? 'unknown' : !th.isResolved ? 'open' : th.resolvedBy && ours(th.resolvedBy, me) ? 'specguard' : 'human', up: n('+1'), down: n('-1'), ...(verdictOf(th, me) && { verdict: verdictOf(th, me) }),
    };
    const oc = outcome(rec);
    out.push(oc === 'addressed' && unseen(c.path) ? { ...rec, outcome: 'not_observed', judged: false } : { ...rec, outcome: oc });
  }
  return out;
}

async function run({ github, context, core }) {
  const { owner, repo } = context.repo;
  const pr = context.payload.pull_request;
  if (!pr) return core.warning('SpecGuard: not a pull_request event');
  const env = process.env;
  const summaryOnly = env.DELIVERY === 'summary'; // manual run: results go to the job summary only; nothing is ever written to the PR
  const ctx = env.CTX || '';
  const engine = env.ENGINE || '', model = env.MODEL || '';
  const partial = env.PARTIAL === 'true';
  const maxComments = Math.max(1, parseInt(env.MAX_COMMENTS, 10) || 10);
  const headSha = env.HEAD_SHA || pr.head.sha;
  // '' when the PR is still open at our head; else why not. Not being able to tell is also a reason: nothing is posted then (no atomicity is claimed: a push can still land right after).
  let livePR, rechecked = true, readFp = ''; // readFp: the key of the PR text the model read, once known
  const REQ_CHANGED = 'requirements changed during the review (the newer run publishes)', say = (stop, msg) => (stop === REQ_CHANGED ? core.notice?.(msg) : core.warning(msg)); // a newer run owns the PR: not a warning
  const current = async () => {
    try { livePR = (await github.rest.pulls.get({ owner, repo, pull_number: pr.number })).data; rechecked = true; }
    catch (e) { rechecked = false; core.warning(`SpecGuard: could not recheck HEAD: ${e.message}`); return 'could not recheck HEAD'; }
    return livePR.head.sha !== headSha ? 'superseded HEAD' : livePR.state === 'closed' && !summaryOnly ? 'PR is no longer open' : readFp && !summaryOnly && livePR.title !== undefined && reqKey(livePR) !== readFp ? REQ_CHANGED : ''; // a body edit mid-run: the edited run reviews the new text; this one must not overwrite it
  };
  const early = await current();
  if (early && rechecked) return say(early, `SpecGuard: ${early}; no results published`); // a failed read continues: the result still reaches the job summary
  // Requirements fingerprint: the key requirements.js took from the PR text the model reads (collect time); else the payload (a re-run reuses a stale one) or the live PR.
  const snapPr = pr?.title !== undefined ? pr : livePR || pr;
  let collected = ''; try { collected = fs.readFileSync(path.join(ctx, 'pr-req-key.txt'), 'utf8').trim(); } catch {}
  const reqFp = /^[0-9a-f]{12}$/.test(collected) ? collected : reqKey(snapPr);
  if (/^[0-9a-f]{12}$/.test(collected)) readFp = collected; // only a key collected with the model input is checked against the live PR (the payload fallback may be a re-run's stale one)
  // the linked issues the model read and their versions (requirements.js): the summary records them so preflight re-reviews when one changes
  let issueVers = []; try { issueVers = fs.readFileSync(path.join(ctx, 'pr-issues.txt'), 'utf8').split('\n').map((l) => /^([\w.-]+\/[\w.-]+#\d+) (\d{4}-\d\d-\d\dT[\d:.]+Z)$/.exec(l.trim())).filter(Boolean).map((m) => `${m[1]}@${m[2]}`).slice(0, 10); } catch {}
  // Our login: the authenticated user (a PAT), else the login our earlier summary recorded (an App token cannot call /user), else null
  // (GITHUB_TOKEN: github-actions[bot]). A null is replaced once, by the author of the first thing we post.
  let who;
  const actor = async () => {
    if (who === undefined) {
      try { who = (await github.rest.users.getAuthenticated()).data.login || null; }
      catch {
        try { who = recordedLogin(await github.paginate(github.rest.issues.listComments, { owner, repo, issue_number: pr.number, per_page: 100 })); } catch { who = null; }
      }
    }
    return who;
  };
  const learn = (r) => { const l = r?.data?.user?.login; if (who === null && typeof l === 'string' && /^[\w-]+(?:\[bot\])?$/.test(l)) who = l; };
  const stamp = (text) => (who && !text.includes('<!-- specguard:by=') ? text.replace('<!-- specguard:summary -->\n', (m) => `${m}<!-- specguard:by=${who} -->\n`) : text); // preflight reads it back

  const publish = async (text, state, why = '') => {
    core.setOutput?.('status', state);
    try { await core.summary.addRaw(text).write(); }
    catch (e) { core.warning(`SpecGuard: could not write the job summary: ${e.message}`); core.setOutput?.('status', 'failed'); core.setOutput?.('reason', 'could not write the job summary'); }
    if (summaryOnly) return;
    try {
      const stop = await current();
      if (stop) return say(stop, `SpecGuard: ${stop}; summary comment not updated`);
      const cs = await github.paginate(github.rest.issues.listComments, { owner, repo, issue_number: pr.number, per_page: 100 });
      const me = await actor();
      const mine = cs.find((c) => ours(c.user, me) && typeof c.body === 'string' && c.body.startsWith('<!-- specguard:summary -->'));
      if (state === 'failed' && mine) text = keepPrior(mine.body, text, why, context.runId && `[run ${context.runId}](${context.serverUrl}/${owner}/${repo}/actions/runs/${context.runId})`, headSha);
      const r = mine ? await github.rest.issues.updateComment({ owner, repo, comment_id: mine.id, body: stamp(text) })
        : await github.rest.issues.createComment({ owner, repo, issue_number: pr.number, body: stamp(text) });
      if (who === null) { // first contact with an unknown identity: record it in the summary
        learn(r);
        const id = mine?.id ?? r?.data?.id;
        if (who && id) await github.rest.issues.updateComment({ owner, repo, comment_id: id, body: stamp(text) });
      }
    } catch (e) { // the PR comment is the deliverable: a run that could not write it is failed (fail_on_error), not complete
      core.warning(`SpecGuard: could not post summary comment: ${e.message}`);
      core.setOutput?.('status', 'failed'); core.setOutput?.('reason', `could not post the summary comment: ${e.message}`);
    }
  };

  let rules = [];
  try { rules = fs.readFileSync(path.join(ctx, 'rule-changes.txt'), 'utf8').split('\n').filter(Boolean); } catch {}
  const ctxLines = (n) => { try { return fs.readFileSync(path.join(ctx, n), 'utf8').split('\n').filter(Boolean); } catch { return []; } };
  const lint = { count: ctxLines('lint-configs.txt').length, changed: ctxLines('lint-changes.txt') }; // linter/formatter configs at base; those the PR changes
  const denied = ctxLines('denied.txt').map((x) => x.trim()).filter(Boolean); // secret-like files collect.sh kept out of the model input: stated, not an incomplete run (deliberate, like ignored files)
  const deniedNote = denied.length ? `Not reviewed: ${denied.length} secret-like file(s) (${denied.slice(0, 10).map((x) => `\`${cell(x, 120)}\``).join(', ')}${denied.length > 10 ? `, … (+${denied.length - 10} more)` : ''}): their diff was not sent to the model` : '';
  const collectError = (() => { try { return fs.readFileSync(path.join(ctx, 'collect-error.txt'), 'utf8'); } catch { return ''; } })().trim(); // collect.sh could not compute the diff: a failed run, never "nothing to review"
  if (env.SKIP === 'true' && !collectError) return publish(buildSummary({ rules, lint, headSha, req: reqFp, cfg: cfgKey(env.CFG), issues: issueVers, state: 'complete', status: `Nothing to review: every changed file is ignored (lockfiles, docs, generated files) or secret-like.${deniedNote ? ` ${deniedNote}.` : ''}` }), 'complete');
  const target = env.STANDARDS_REF || 'head';
  const ref = target === 'head' ? headSha : target === 'merge' && livePR?.mergeable === true ? livePR.merge_commit_sha : null;
  const tooling = ref ? await inspectChecks({ github, owner, repo, ref, names: env.STANDARDS_CHECKS })
    : { status: 'unavailable', ref: '', checks: [], reason: target === 'merge' ? 'PR has no current test-merge commit' : 'Configured standards ref must be head or an available current merge commit.' };
  const readCtx = (n) => { try { return fs.readFileSync(path.join(ctx, n), 'utf8'); } catch { return null; } };
  let usage = null; // engine usage JSON (tokens, cost); shown on every summary that ran the engine, including failed runs
  try { usage = JSON.parse(readCtx('usage.json')); } catch { /* no usage data */ }
  try { usage = mergeUsage(usage, JSON.parse(readCtx('usage-repair.json'))); } catch { /* no repair or finalize turn */ } // copilot repair turn, claude finalize turn
  const repair = (readCtx('engine-repair') || '').trim();
  const notes = engineNotes(readCtx('engine-notes'), repair); // written by the engine step, never by the model
  let em = null; try { em = JSON.parse(readCtx('engine-model.json')); } catch { /* absent or garbled: normal mode */ }
  const strs = (xs) => [...new Set(xs.filter((x) => typeof x === 'string' && x))];
  // the model(s) the engine step recorded; else the ones the usage file names (the request alone says nothing when it was `auto`)
  const used = Array.isArray(em?.used) && strs(em.used).length ? strs(em.used) : strs([usage?.currentModel, ...Object.keys(usage?.modelMetrics && typeof usage.modelMetrics === 'object' ? usage.modelMetrics : {})]), tier = em?.tier === 'fast' ? 'fast' : undefined;
  const chosen = (readCtx('focus.txt') || '').split('\n').filter(Boolean), skipped = (readCtx('focus-skipped.txt') || '').split('\n').map((x) => x.split('\t')[0].trim()).filter(Boolean);
  const shortened = ((readCtx('diff.numbered.txt') || '').match(/^… \d+ more changed lines in this file not shown/gm) || []).length; // src/focus.js's trim marker, one per cut file
  const focused = chosen.length ? { files: chosen.length, of: chosen.length + skipped.length, shortened } : undefined; // not reduced mode, not a failure: incomplete only when a changed file was left out, so the next push reviews again
  const dropped = (readCtx('diff-dropped.txt') || '').split('\n').map((x) => x.trim()).filter(Boolean);
  // What the run cost, for the owner's own accounting: attempt count, engine time (recorded wall time, else API time), credits (nano AI units / 1e9), where it ran and how it was delivered.
  const measure = () => {
    const nano = fin(usage?.totalNanoAiu), ms = fin(em?.ms) ?? fin(usage?.totalApiDurationMs), runs = parseInt(env.GITHUB_RUN_ATTEMPT, 10), ev = context.eventName || env.GITHUB_EVENT_NAME;
    return { ...(runs > 0 && { runs }), ...(ms !== undefined && { ms }), ...(nano !== undefined && { nanoAiu: nano, credits: nano / 1e9 }), model: used.join(', ') || model || undefined, mode: 'pr', delivery: summaryOnly ? 'summary' : 'pr', ...(ev && { event: ev }) };
  };
  const failed = (why) => (core.setOutput?.('reason', why), publish(buildSummary({ rules, lint, status: `Could not complete: ${why}`, tooling, engine, model, usage, notes: notes.filter((n) => !n.startsWith(why)), partial, dropped, state: 'failed', used, tier }), 'failed', why));
  if (collectError) return failed(collectError);
  // One run-completeness state, from collector and engine status files only (never model output). A non-empty list withholds the HEAD marker and stale-thread resolution.
  const incomplete = [];
  const st = (readCtx('engine-status') || '').trim();
  if (partial) incomplete.push('The diff exceeded `max_diff_kb` and was truncated; obligations outside the reviewed portion are unknown.');
  if (dropped.length) incomplete.push(notReviewed(dropped));
  if (focused && skipped.length) incomplete.push(focusNote(focused.files, focused.of, skipped));

  let data;
  try { data = JSON.parse(fs.readFileSync(path.join(ctx, 'findings.json'), 'utf8')); }
  catch (e) {
    if (st === 'timeout') return failed(`the review timed out after ${env.REVIEW_TIMEOUT_MINUTES || '12'} minutes; raise review_timeout_minutes or split the PR`);
    const why = (readCtx('engine-error') || '').split('\n')[1]?.trim(); // the engine step's classified failure (quota, policy, auth, rate); absent = unknown
    if (why && st === 'failed') return failed(why);
    if (st === 'failed') return failed('the review engine failed; see the job log');
    return failed(`no valid findings.json (${e.code || 'parse error'}); see the job log`);
  }
  const proposed = Array.isArray(data?.findings) ? data.findings.length : 0; // what the model reported: a finding dropped or demoted later is a degrade, not a fix
  const proposedPaths = Array.isArray(data?.findings) ? data.findings.map((f) => f?.path) : []; // for the fix-through telemetry: which files lost a proposed finding to validation
  const v = validate(data);
  if (!v.ok) return failed(`findings.json failed validation: ${v.error}`);
  const packCut = new Set((readCtx('pack-cut.txt') || '').split('\n').filter(Boolean).map((l) => l.split('\t')[0])); // a scan's lines carry "\tunit ids" (audit-post.js reads those) // the claude engine's pack: files the model saw only partly or not at all
  if (packCut.size) { // a missing/weak-test claim is only trustworthy when its candidate tests were fully visible
    const cands = parseCandidates(readCtx('test-candidates.txt') || '');
    for (const f of data.findings) {
      const seen = ['missing_test', 'weak_test'].includes(f.kind) && [...(f.kind === 'weak_test' ? [f.path] : []), ...(cands.get(f.path) || [])].find((p) => packCut.has(p));
      if (seen) { f.confidence = 'low'; f.gated = true; (data.validation_notes ||= []).push(`low confidence: a candidate test file was only partly visible (${seen}); ${f.kind} ${f.path} is not counted.`); }
    }
  }
  const noCands = new Set((readCtx('candidates-cut.txt') || '').split('\n').filter(Boolean)); // collect.sh: changed files whose candidate tests were never looked up (list cap)
  for (const f of data.findings) if (f.kind === 'missing_test' && f.confidence !== 'low' && noCands.has(f.path)) { f.confidence = 'low'; (data.validation_notes ||= []).push(`low confidence: candidate tests were not looked up for ${f.path} (too many changed files); missing_test ${f.path} is not counted.`); }
  if (noCands.size) incomplete.push(`Candidate tests were not looked up for ${noCands.size} changed file(s) (too many changed files): ${[...noCands].slice(0, 5).map((x) => `\`${cell(x, 120)}\``).join(', ')}${noCands.size > 5 ? ', …' : ''}; their missing-test claims are not counted.`);
  if (packCut.size) { // a cut changed file, or a cut candidate test of one, means the model never saw what the obligations depend on: no clean verdict, no head marker
    const cands = parseCandidates(readCtx('test-candidates.txt') || '');
    // a cut candidate test always counts; a cut changed file only when a changed line lies past the lines the pack showed (pack-shown.txt; no entry = not shown at all). ponytail: the diff section itself is not checked for cuts.
    const shown = new Map((readCtx('pack-shown.txt') || '').split('\n').filter(Boolean).map((l) => l.split('\t')));
    const dm = parseDiff(readCtx('diff.patch') || '');
    const past = (f) => !shown.has(f) || [...(dm.get(f)?.changed.RIGHT.keys() || [])].some((n) => n > +shown.get(f));
    const lost = [...new Set((readCtx('files.txt') || '').split('\n').filter(Boolean).flatMap((f) => [...(packCut.has(f) && past(f) ? [f] : []), ...(cands.get(f) || []).filter((x) => packCut.has(x))]))];
    if (lost.length) incomplete.push(`Review context was cut: the model saw only part of ${lost.slice(0, 10).map((x) => `\`${cell(x, 120)}\``).join(', ')}${lost.length > 10 ? `, … (+${lost.length - 10} more)` : ''}; obligations that depend on them are unknown.`);
  }
  // The engine can leave a parseable findings.json and still have timed out or failed: keep what verifies, but the run is not complete.
  if (st && st !== 'success') incomplete.push(st === 'timeout' ? `The review engine timed out after ${env.REVIEW_TIMEOUT_MINUTES || '12'} minutes; the findings may be partial.` : st === 'failed' ? 'The review engine failed; the findings may be partial.' : `The review engine did not finish cleanly (${st}); the findings may be partial.`);
  const addNote = (m) => { data.not_reviewed = [data.not_reviewed, m].filter(Boolean).join(' '); };
  const memoed = (read) => { const m = new Map(); return (p) => (m.has(p) ? m : m.set(p, read(p))).get(p); }; // files do not change during a run
  const root = env.GITHUB_WORKSPACE || process.cwd();
  const tracked = trackedFiles(root);
  if (!tracked) (data.validation_notes ||= []).push('Tracked files could not be listed; no workspace file was read as evidence.');
  // citations (evidence, behaviour, findings, requirement files) are read only from files tracked at the checked-out head
  const readLines = memoed((p) => { const rel = safeRel(p); return rel && tracked && tracked.has(rel) ? readFile(rel) : null; });
  { // a missing_test claim whose error message or literal already sits in a tracked test file may be covered there: low confidence, not counted (src/test-map.js)
    // hunk-tier candidates stay out of the guard's scope: a test that merely shares a literal with the diff is the "logger test contains 'invalid amount'" case (#217)
    const cands = parseCandidates(readCtx('test-candidates.txt') || '', { skipHunk: true }), covers = require('./test-map').makeCoverGuard({ cwd: root, testPaths: readCtx('test-paths.txt') || '' }); // collect.sh writes it when test_paths is set
    for (const f of data.findings) {
      // a file absent from test-candidates.txt gets an unscoped search (cands.get is undefined); safe only because such files are in candidates-cut.txt, which already makes the run incomplete
      const hit = f.kind === 'missing_test' && covers(readLines(f.path), f.line, f.path, cands.get(f.path));
      if (hit && f.confidence === 'low') f.gated = true; // already low: just keep it from being raised later
      else if (hit) { f.confidence = 'low'; f.gated = true; (data.validation_notes ||= []).push(`low confidence: a test may already cover this: ${hit}; missing_test ${f.path} is not counted.`); }
    }
    for (const n of new Set(covers.limits)) (data.validation_notes ||= []).push(n); // a timed-out search is not "no test covers it": the finding keeps its confidence
  }
  const readRule = memoed(readFile); // the trusted rule inventory may include base-restored files that are not tracked at head
  data.tooling = tooling; // Always overwrite any model-supplied tooling claim.

  const cov = loadCoverage(readCtx('coverage.json')); // optional: the target's own coverage report, joined with the diff by src/coverage.js
  let local = '';
  try { local = fs.readFileSync(path.join(ctx, 'diff.patch'), 'utf8'); } catch {}
  const maps = parseDiff(local);
  const lines = (n) => { try { return fs.readFileSync(path.join(ctx, n), 'utf8').split('\n').filter(Boolean); } catch { return []; } };
  const reviewable = new Set(lines('files.txt')), standards = new Set(lines('standards.txt'));
  if ([...reviewable].some((p) => !maps.has(p))) { // the API is the fallback only: it can fail under load
    try {
      for (const f of await github.paginate(github.rest.pulls.listFiles, { owner, repo, pull_number: pr.number, per_page: 100 })) if (!maps.has(f.filename)) maps.set(f.filename, parsePatch(f.patch));
    } catch { (data.validation_notes ||= []).push('GitHub diff API unavailable; anchored with the local diff only.'); }
  }
  // The trusted spec allow-list. trace-status says whether tracing ran: failed/unavailable means an EMPTY list (fail closed) and a visible
  // notice; an absent list with no status is an older collector (no restriction, but paths are still normalised and tracked-only).
  let specFiles, traceNote = '';
  const traceStatus = (readCtx('trace-status') || '').trim(), listed = readCtx('spec-files.txt');
  if (listed !== null) specFiles = listed.split('\n').filter(Boolean);
  if (['failed', 'unavailable'].includes(traceStatus)) {
    specFiles = [];
    traceNote = traceStatus === 'failed' ? 'requirement tracing failed or timed out' : 'requirement tracing is not available';
    incomplete.push(`Requirement tracing was not done: ${traceNote}.`);
  } else if (traceStatus === 'off') specFiles = [];
  let smap = null, sentries = []; // path -> scope; absent for older collectors, which skips the applicability check
  try { sentries = JSON.parse(readCtx('standards-map.json')); smap = new Map(sentries.map((e) => [e.path, e.scope])); } catch { /* no map */ }
  const cutInPrompt = standardsCut(ctx);
  if (deniedNote) addNote(deniedNote);
  for (const l of (readCtx('collect-limits.txt') || '').split('\n').filter(Boolean)) addNote(l);
  verifyEvidence(data, reviewable, standards, readLines, maps);
  let requirements = null;
  try { requirements = JSON.parse(fs.readFileSync(path.join(ctx, 'requirements-status.json'), 'utf8')); verifyRequirements(data, { ...requirements, specFiles }, readLines); } catch { requirements = null; }
  if (requirements) {
    data.requirements_source = requirements.sources.length ? `${requirements.sources.join(', ')}${(requirements.criteria || []).length ? '' : ' (no structured acceptance criteria found)'}` : 'unavailable; changed behaviour only';
    if (requirements.status !== 'available') addNote((requirements.limitations || []).join(' '));
    // What the collector did not collect. Not facts: an empty PR body, the capped requirements-index.md, an unreadable or other-repository reference (all notes).
    const lims = [...(requirements.limitations || []), ...(requirements.spec?.limitations || [])].filter((l) => !isFactLimitation(l)); // facts and unreadable references are notes (requirements.js decides the kind); the rest lost requirement text
    if (lims.length) incomplete.push(`Requirement collection did not cover everything: ${lims.slice(0, 10).join(' ')}${lims.length > 10 ? ` (+${lims.length - 10} more)` : ''}`);
  } else { // no collected documents: quotes verify only against files; unverifiable ones are unassessed but their obligations keep their own citations
    verifyRequirements(data, { unavailable: true, specFiles }, readLines);
    data.requirements_source = 'unavailable; changed behaviour only';
    addNote('Requirement collection status unavailable.');
    incomplete.push('Requirement collection status was unavailable; only changed behaviour was assessed.');
  }
  if (partial) addNote('Diff truncated; obligations outside the reviewed portion are unknown.');
  applyCoverage(data, cov);
  const base = env.BASE_SHA || pr.base?.sha;
  const dmaps = new Map([...maps, ...(base ? renameMaps(base, headSha, process.env.GITHUB_WORKSPACE || process.cwd()) : [])]);
  differential(data, dmaps);
  reflect(data, dmaps, reviewable);
  markChanged(data, requirements);
  const pre = new Set(data.coverage.filter((c) => ['mismatch', 'impacted'].includes(c.alignment.status) && c.alignment.since === 'pre_existing').map((c) => c.id));
  const preExisting = []; // drift this PR did not cause: summary section only, never inline

  const known = new Set(), priors = new Map(); // priors: fp -> our latest earlier comment with it, oldest first
  let withheld = ''; // why inline comments cannot be posted safely
  try {
    const me = await actor();
    for (const c of await github.paginate(github.rest.pulls.listReviewComments, { owner, repo, pull_number: pr.number, per_page: 100 })) {
      const m = /<!-- specguard:fp=([0-9a-f]{40}) -->\s*$/.exec(c.body || ''); // the marker is always last; outdated comments have line=null: fingerprint only
      if (m && ours(c.user, me)) { known.add(m[1]); priors.delete(m[1]); priors.set(m[1], c); }
    }
  } catch (e) {
    if (summaryOnly) core.warning(`SpecGuard: existing review comments could not be read: ${e.message}`);
    else {
    withheld = `existing review comments could not be listed (${e.status ? `${e.status}: ` : ''}${String(e.message).split('\n')[0]}), so inline comments were withheld to avoid duplicates`;
    core.warning(`SpecGuard: ${withheld}`);
    incomplete.push(`Delivery degraded: ${withheld}; the findings are in this summary.`);
    }
  }
  if (summaryOnly) known.clear(); // nothing is posted, so no finding is "already posted": every one carries its full text here
  let threads; // review threads (first 300), read once for the dedup below, the telemetry and the stale resolver
  if (priors.size) {
    try { threads = await fetchThreads({ github, owner, repo, number: pr.number }); }
    catch (e) { core.warning(`SpecGuard: review threads could not be read: ${e.message}`); }
    const me = await actor();
    // a thread we resolved ourselves (its finding was absent from an earlier run) does not hide the finding when it is reported again; a person's resolution is respected
    for (const [fp, th] of threadsByFp(threads, me)) if (th.isResolved && th.resolvedBy && ours(th.resolvedBy, me)) known.delete(fp);
  }
  // Summary-only findings have no review comment, so no prior. The previous summary's counts list them (`sum`); they become synthetic priors (thread unknown, never dismissed).
  let prevSum = [], prevHead; // the previous summary's `sum`: carried forward below once a finding is addressed
  if (!withheld) try {
    const me = await actor(), cs = await github.paginate(github.rest.issues.listComments, { owner, repo, issue_number: pr.number, per_page: 100 });
    const mine = cs.find((c) => ours(c.user, me) && typeof c.body === 'string' && c.body.startsWith('<!-- specguard:summary -->'));
    const pc = JSON.parse(/<!-- specguard:counts (\{.*\}) -->/.exec(mine?.body || '')?.[1]);
    if (Array.isArray(pc?.sum)) { prevSum = pc.sum.slice(0, 20); prevHead = pc.head; }
    if (/^[0-9a-f]{7,40}$/.test(pc?.head) && Array.isArray(pc.sum)) for (const e of pc.sum.slice(0, 20)) {
      if (/^[0-9a-f]{16}$/.test(e?.fp) && typeof e.path === 'string' && Number.isInteger(e.line) && ![...priors.keys()].some((k) => k.startsWith(e.fp))) priors.set(e.fp, { path: e.path, original_line: e.line, original_commit_id: /^[0-9a-f]{7,40}$/.test(e.at) ? e.at : pc.head, kind: typeof e.kind === 'string' ? e.kind : null });
    }
  } catch { /* no earlier summary, or no counts in it: no synthetic priors */ }
  const survive = new Set(); // fingerprints of every finding still present after validation, wherever it ends up (inline, summary, capped, unverifiable)

  const kept = [];
  let already = 0;
  const seen = new Set();
  const cands = [];
  const unanchored = []; // items that failed to post or anchor; they go to the summary
  const gate = (r) => { if (r.note) (data.validation_notes ||= []).push(r.note); return r.f; }; // quality gates only demote or trim; each leaves a validation note
  // A removed assertion with no replacement is a fact (leads.txt), not a judgement: report it when no missing_test/weak_test finding cites that test file near it (either side).
  const auto = [];
  // leads.txt indents each lead; and a lead is trusted only as far as the diff agrees: recomputing it drops removals re-pinned through a helper.
  const standing = new Set(require('./leads').assertionDelta(local, () => true).filter((d) => d.kind === 'removed').map((d) => `${d.file}:${d.line}`));
  for (const m of (readCtx('leads.txt') || '').matchAll(/^\s*assertion removed: .* \((.+):(\d+)\)\s*$/gm)) {
    const path_ = m[1], line = +m[2], ch = maps.get(path_)?.changed.LEFT, rightAt = maps.get(path_)?.rightAt.get(line);
    if (!standing.has(`${path_}:${line}`)) continue;
    if (auto.length >= 5 || !ch || !reviewable.has(path_) || !ch.has(line)) continue;
    const near = data.findings.findIndex((f) => ['missing_test', 'weak_test'].includes(f.kind) && f.path === path_ && Math.abs(f.line - (f.side === 'LEFT' ? line : rightAt)) <= 5); // one coordinate system: a RIGHT finding is compared at the removal's RIGHT position
    if (near >= 0) {
      // a low-confidence nearby finding is raised, not duplicated. A cross-file re-pin is no new risk: the lead is already posted when no finding is nearby.
      const n = data.findings[near];
      if (n.confidence !== 'high' && !n.gated && (n.kind !== 'weak_test' || counterexampleOk(n.counterexample))) data.findings[near] = { ...n, confidence: 'high', body: `${n.body}\n\nRemoval confirmed by the diff.` };
      continue;
    }
    const quote = ch.get(line).trim();
    auto.push({ kind: 'missing_test', confidence: 'high', path: path_, side: 'LEFT', line, quote, title: 'Assertion removed with no replacement', obligation_ids: [], // ponytail: no coverage row; the LEFT path below never reads obligations
      body: `The assertion \`${quote}\` was removed and nothing in this change pins the same behaviour. Restore it or pin the behaviour in another test.` });
  }
  for (let f of [...data.findings, ...auto]) {
    if (f.kind === 'spec_mismatch') {
      const req = data.requirements.find((r) => r.obligation_ids.includes(f.obligation_ids[0]));
      if (req && specPath(req.source) && req.ref) f = { ...f, source: `${req.source.replace(REMOVED, '')} ${req.ref}` };
    }
    const sfp = fingerprint(f.kind, f.path, f.quote, f.source);
    survive.add(sfp); // before any route or drop below
    f = { ...f, sfp }; // kept for `sum`: an unanchored copy may carry a rewritten quote
    if (f.kind === 'spec_mismatch' && f.obligation_ids.every((id) => pre.has(id))) {
      const rl = readLines(f.path), d = snap(f, rl);
      if (d === null) addNote(`Finding citation did not match: ${f.path}:${f.line}.`); else preExisting.push({ ...verified(f, rl, f.line + d), line: f.line + d });
      continue;
    }
    f = gate(skeletonGate(f));
    if (f.side === 'LEFT') {
      const ch = maps.get(f.path)?.changed.LEFT, l = f.kind !== 'standard' && reviewable.has(f.path) && ch ? findLine(f.quote, f.line, (x) => ch.get(x), ch.keys()) : 0;
      if (l) {
        const g = norm(ch.get(l)) === norm(f.quote) ? { ...f, line: l } : { ...f, line: l, quote: ch.get(l).trim() };
        unanchored.push({ f: g, why: 'removed test or assertion; location is on the LEFT side of the diff' });
      } else addNote(`Removed-line citation could not be verified: ${f.path}:${f.line}.`);
      continue;
    }
    if (!maps.has(f.path) || !reviewable.has(f.path)) {
      const rl = readLines(f.path), d = f.kind !== 'standard' ? snap(f, rl) : null;
      if (d !== null) {
        unanchored.push({ f: { ...verified(f, rl, f.line + d), line: f.line + d }, why: 'assertion outside the reviewed diff' });
      } else addNote(`Finding location could not be verified: ${f.path}:${f.line}.`);
      continue;
    }
    if (f.kind === 'standard') {
      const m = /^(.+):(\d+)$/.exec(f.rule_source || '');
      const rl = m && standards.has(m[1]) ? readRule(m[1]) : null;
      const at = rl && ruleLine(f.rule_quote, rl, +m[2]);
      if (at && smap?.get(m[1]) && !matches(smap.get(m[1]), f.path)) {
        addNote(`Standards finding omitted: ${m[1]} does not apply to ${f.path} (its scope: ${smap.get(m[1]).join(', ')}).`);
        continue;
      }
      if (at) f = { ...f, rule_source: `${m[1]}:${at}` };
      else if (!(f.confidence === 'low' && !f.rule_source)) {
        addNote(`Unverified standards finding omitted: ${f.title}.`);
        continue;
      }
    }
    const rl = readLines(f.path), d = snap(f, rl);
    if (d === null) {
      const ch = f.kind !== 'standard' && maps.get(f.path)?.changed.LEFT, l = ch ? findLine(f.quote, f.line, (x) => ch.get(x), ch.keys()) : 0;
      if (l) { // the quote is a removed line (the model omitted side LEFT): same path as a cited LEFT finding
        addNote(`Finding citation ${f.path}:${f.line} matches a removed line; set to LEFT line ${l}.`);
        unanchored.push({ f: { ...f, side: 'LEFT', line: l, quote: ch.get(l).trim() }, why: 'removed test or assertion; location is on the LEFT side of the diff' });
      } else addNote(`Finding citation did not match: ${f.path}:${f.line}.`);
      continue;
    }
    const exact = [f.kind, f.path, f.line + d, f.title, f.body].join('\0'); // only a verbatim repeat is dropped
    if (seen.has(exact)) continue;
    seen.add(exact);
    cands.push({ ...verified(f.kind === 'missing_test' && neverRan(cov, f.path, f.line + d) ? { ...f, title: `${f.title} (coverage: never executed)` } : f, rl, f.line + d), line: f.line + d, ...(f.start_line !== undefined && { start_line: f.start_line + d }) });

  }
  const merged = merge(cands);
  for (const f of merged) { survive.add(f.fp); known.has(f.fp) ? already++ : kept.push(f); } // a merged comment's fp covers all its members
  // ponytail: a finding that validation/verification dropped (its citation or requirement link failed) cannot be fingerprinted like its comment was; hold all resolving instead of guessing.
  const degraded = proposed > data.findings.length;

  // Reduced review: only a high-confidence finding with two verified citations goes inline (at most REDUCED_INLINE); the rest are one-liners in the summary.
  const reasons = reducedReasons({ em, repair, engineNotes: (readCtx('engine-notes') || '').split('\n').filter((x) => x.trim()), data }), reduced = reasons.length > 0;
  // Experiment MISSING_TEST_STATIC_CITATION (env, default off): in a reduced review a missing_test on a PR-added line that no tracked test references by its enclosing symbol goes inline
  // without the high-confidence and two-citation requirements (a missing_test has one citation by construction). The REDUCED_INLINE cap, anchoring and dedup still apply.
  const staticMissing = reduced && env.MISSING_TEST_STATIC_CITATION === '1' ? (() => {
    const { enclosingName, makeCoverGuard } = require('./test-map'), guard = makeCoverGuard({ cwd: root, testPaths: readCtx('test-paths.txt') || '' });
    return (f) => { // ponytail: a failed or timed-out search, or no enclosing name, is not "no test references it": not eligible
      if (f.kind !== 'missing_test' || f.gated || f.side === 'LEFT' || !maps.get(f.path)?.changed.RIGHT.has(f.line)) return false;
      const name = enclosingName(readLines(f.path) || [], f.line), n = guard.limits.length;
      return !!name && !guard.symbol(name, f.path) && guard.limits.length === n;
    };
  })() : () => false;
  const p = plan(reduced ? kept.filter((f) => (f.confidence === 'high' && citationsOf(f, data) >= 2) || staticMissing(f)) : kept, maps, reduced ? Math.min(REDUCED_INLINE, maxComments) : maxComments);
  if (reduced) {
    const brief = (f, why) => ({ f, why, brief: true });
    p.summary = [...p.summary.map((x) => brief(x.f, x.why === 'over max_comments' ? 'reduced review: inline limit' : x.why)), ...p.file.map((f) => brief(f, 'reduced review: not inline')),
      ...kept.filter((f) => !p.inline.includes(f) && !p.file.includes(f) && !p.summary.some((x) => x.f === f)).map((f) => brief(f, 'reduced review: not high confidence with two citations'))];
    p.file = [];
  }
  const comments = p.inline.map((f) => ({
    path: f.path, line: f.line, side: 'RIGHT', body: commentBody(f, f.fp, true),
    ...(f.start_line !== undefined && { start_line: f.start_line, start_side: 'RIGHT' }),
  }));
  let inline = comments.length, filed = p.file.length;

  const stop = summaryOnly ? '' : withheld ? 'inline comments withheld: could not deduplicate' : await current(); // never post what cannot be deduplicated or what may be stale
  if (summaryOnly) {
    for (const f of [...p.inline, ...p.file]) unanchored.push({ f, why: 'summary only' });
    inline = filed = 0;
  } else if (stop) {
    if (!withheld) { say(stop, `SpecGuard: ${stop}; no comments published`); incomplete.push(`Delivery degraded: ${stop}; the review comments and PR summary were not updated (this text is the job summary).`); }
    for (const f of [...p.inline, ...p.file]) unanchored.push({ f, why: withheld ? 'withheld: could not deduplicate' : `not posted: ${stop}` });
    inline = filed = 0;
  }
  const urls = new Map(); // fp -> link to our comment, for the result lines in the summary
  for (const [fp, c] of priors) if (c.html_url) urls.set(fp, c.html_url);
  // No review wrapper: every finding is its own review comment (the summary comment is the only aggregate). One that GitHub rejects (a line outside the diff) goes to the summary; the rest continue.
  let annotated = 0;
  const lost = []; // non-422 post failures (a 422 anchor rejection is normal): the delivery is degraded, so the run is incomplete and retried
  if (!stop && !summaryOnly) for (const [i, c] of comments.entries()) {
    const f = p.inline[i];
    try {
      const r = await github.rest.pulls.createReviewComment({ owner, repo, pull_number: pr.number, commit_id: headSha, ...c });
      learn(r);
      if (r?.data?.html_url) urls.set(f.fp, r.data.html_url); // else the blob line is the fallback link
    } catch (e) {
      core.warning(`SpecGuard: could not post a comment on ${c.path}:${c.line} (${e.status}): ${e.message}`);
      if ((e.status === 403 || e.status === 404) && annotated++ < 10) core.warning(f.title, { file: f.path, startLine: f.start_line || f.line, title: `SpecGuard ${f.kind}` });
      unanchored.push({ f, why: e.status === 422 ? 'anchor rejected' : 'could not post' });
      if (e.status !== 422) lost.push(e.status || 'error');
      inline--;
    }
  }
  for (const f of stop || summaryOnly ? [] : p.file) {
    const range = f.start_line ? `#L${f.start_line}-L${f.line}` : `#L${f.line}`;
    const link = `${context.serverUrl}/${owner}/${repo}/blob/${headSha}/${f.path}${range}`;
    try {
      const r = await github.rest.pulls.createReviewComment({ owner, repo, pull_number: pr.number, commit_id: headSha, path: f.path, subject_type: 'file', body: commentBody({ ...f, body: `${f.body}\n\n[${f.path}:${f.line}](${link})` }, f.fp, false) });
      learn(r);
      if (r?.data?.html_url) urls.set(f.fp, r.data.html_url);
    } catch (e) { core.warning(`SpecGuard: file-level comment failed: ${e.message}`); unanchored.push({ f, why: 'could not post' }); filed--; if (e.status !== 422) lost.push(e.status || 'error'); }
  }
  if (lost.length) incomplete.push(`Delivery degraded: ${lost.length} comment(s) could not be posted (${[...new Set(lost)].join(', ')}); the findings are in this summary.`);

  // Fix-through telemetry. execution_complete: the run itself finished (nothing cut, failed or degraded); complete: also a full-strength model.
  // Outcomes are judged per finding, not per run: a prior is not_observed only when this run could not see its file (cut from the pack, not reviewed, diff truncated).
  // A run whose engine failed or that lost findings to validation has no valid outcomes at all. A reduced (fast-tier) run judges like any other: its `survive` set
  // holds every finding it reported, low confidence and summary ones included, and the counts carry `tier` for stratifying. Review F09 (superseded).
  const execComplete = !incomplete.length && !degraded, complete = execComplete && !reduced;
  // A finding validation dropped may be the re-report of a prior: that file's priors are not judged. If the dropped paths cannot be recovered, the whole run is not valid.
  const left = new Map(); for (const f of data.findings) left.set(f.path, (left.get(f.path) || 0) + 1);
  const droppedPaths = new Set(), pathsKnown = proposedPaths.every((x) => typeof x === 'string' && x);
  for (const x of proposedPaths) if (typeof x === 'string') { if (left.get(x)) left.set(x, left.get(x) - 1); else droppedPaths.add(x); }
  const valid = (!degraded || pathsKnown) && !withheld && !(st && st !== 'success');
  const me = await actor();
  const cutSet = new Set([...packCut, ...dropped, ...skipped]);
  const outcomes = valid && priors.size ? followUp({ priors, survive, me, headSha, cwd: root, threads, unseen: (p) => partial || cutSet.has(p) || droppedPaths.has(p) || !reviewable.has(p) }) : [];
  const sum = [], seenSum = new Set(); // this run's summary-only and unanchored findings, tracked by the next run
  for (const { f } of [...p.summary, ...unanchored]) {
    const fp = (f.fp || f.sfp || '').slice(0, 16);
    if (/^[0-9a-f]{16}$/.test(fp) && !seenSum.has(fp) && sum.length < 20) { seenSum.add(fp); sum.push({ fp, path: f.path, line: f.line, kind: f.kind, title: oneLine(neutralize(f.title).replace(/\s+/g, ' ').trim(), 100) }); } // title: the claim a blind labeller judges (eval/label-export.js)
  }
  // A summary-only finding that was judged this round and is no longer reported keeps its entry, so the blind-label pool (eval/weekly-report.js) still has it. After this round's own entries: the cap drops them first.
  for (const e of prevSum) if (sum.length < 20 && /^[0-9a-f]{16}$/.test(e?.fp) && !seenSum.has(e.fp) && outcomes.some((o) => o.fp.startsWith(e.fp) && o.outcome !== 'open')) { seenSum.add(e.fp); sum.push({ fp: e.fp, path: e.path, line: e.line, kind: e.kind, title: e.title, at: /^[0-9a-f]{7,40}$/.test(e.at) ? e.at : prevHead }); } // at: the head it was first reported at, so later rounds judge it against the same commit
  const byKind = {};
  const tally = (list, k) => list.forEach((f) => { (byKind[f.kind] ||= { posted: 0, already: 0, summary: 0 })[k]++; });
  const unplaced = new Set(unanchored.map((x) => x.f));
  tally(merged.filter((f) => known.has(f.fp)), 'already');
  tally([...p.inline, ...p.file].filter((f) => !unplaced.has(f)), 'posted');
  tally([...p.summary, ...unanchored].map((x) => x.f), 'summary');
  const since = { addressed: 0, open: 0, dismissed: 0, not_observed: 0 };
  for (const o of outcomes) since[o.outcome]++;
  const tele = { v: 1, ...(em && { model: used.join(', '), ...(tier && { tier }), ...(reduced && { reduced: true }) }), ...measure(), ...(focused && { focused }), pr: pr.number, merged: livePR?.merged === true || !!livePR?.merged_at, head: headSha, engine: engine || 'n/a', specguard: require('./version').version(), complete, execution_complete: execComplete, outcome_valid: valid, findings: byKind, pre_existing: preExisting.length, posted: { inline, file: filed }, already, since, since_total: outcomes.length, prior_total: priors.size, outcomes, ...(sum.length && { sum }) };
  if (ctx) try { fs.writeFileSync(path.join(ctx, 'counts.json'), JSON.stringify(tele) + '\n'); } catch { /* ctx not writable: the sticky comment still carries the counts */ } // summary-only and manual runs have no sticky comment: the artifact carries it
  const resolveNote = !stop && !summaryOnly && complete && env.RESOLVE_STALE !== 'false' ? await resolveStale({ github, core, owner, repo, number: pr.number, current: survive, actor: me, threads }) : undefined;

  const struggling = reduced && !gradeOnly({ reasons }), state = incomplete.length || struggling ? 'incomplete' : 'complete'; // the fast tier alone is reported in counts and the notice, not in the status
  // how the findings reached the PR, said once at the end of the summary; nothing is said when no comment was posted in a normal run
  const delivered = summaryOnly ? 'summary only, nothing posted' : [inline && plural(inline, 'inline comment'), filed && plural(filed, 'file-level comment'), already && `${already} already posted`].filter(Boolean).join(' · ');
  const placed = [...merged.filter((f) => known.has(f.fp)), ...[...p.inline, ...p.file].filter((f) => !unplaced.has(f))].map((f) => ({ f, url: urls.get(f.fp) }));
  await publish(buildSummary({ cov, reduced: reduced && { reasons, model: used.join(', ') || model }, used, tier, delivery: delivered, runNotes: summaryOnly && livePR?.state === 'closed' ? ['The PR is closed; it was reviewed because the run asked for it.'] : [], banner: [...(focused && !skipped.length && focused.shortened ? [`Large PR: diffs of ${focused.shortened} large file${focused.shortened === 1 ? '' : 's'} ${focused.shortened === 1 ? 'was' : 'were'} shortened in the prompt`] : [])], traceNote, data, posted: placed, items: [...p.summary, ...unanchored], rules, lint, incomplete, engine, model, usage, notes, specFiles, pre: preExisting, blob: `${context.serverUrl}/${owner}/${repo}/blob/${headSha}`, resolveNote, headSha: incomplete.length || struggling ? undefined : headSha, req: reqFp, cfg: cfgKey(env.CFG), issues: issueVers, // no head marker: the preflight must retry an incomplete run
    manifest: { reqDocs: specFiles || [], standards: smap ? sentries.map((e) => ({ path: e.path, bytes: e.bytes, lines: e.lines, truncated: cutInPrompt.has(e.path) })) : [...standards], trace: traceNote ? 'unavailable' : traceStatus === 'off' ? 'off' : specFiles?.length ? 'spec found' : 'SPEC_NOT_FOUND', head: headSha, base,
    rejected: (readCtx('spec-rejected.txt') || '').split('\n').filter(Boolean).map((l) => { const i = l.indexOf('\t'); return i < 0 ? [l, 'not admitted'] : [l.slice(0, i), l.slice(i + 1)]; }) }, counts: tele, state }), state);
}

module.exports = async (a) => {
  try { await run(a); } catch (e) {
    a.core.warning(`SpecGuard post failed: ${e.message}`);
    try { a.core.setOutput?.('status', 'failed'); a.core.setOutput?.('reason', `SpecGuard post failed: ${e.message}`); } catch { /* core may be partial */ }
  }
};
Object.assign(module.exports, { assertionKind, weakAssertion, okArg, boolName, refutedBy, counterexampleOk, engineNotes, reducedReasons, citationsOf, layerOf, findLine, slug, whole, outcome, verdictOf, followUp, fetchThreads, anchorTouched, testsChanged, countsComment, placeholder, skeletonGate, definedNames, definesUsedBy, parsePatch, parseDiff, validate, anchor, snap, ruleLine, merge, plan, fingerprint, redact, truncate, buildSummary, usageLine, runLine, mergeUsage, loadCoverage, neverRan, applyCoverage, coverageAtoms, commentBody, noGaps, verifyEvidence, verifyRequirements, settle, differential, reflect, renameMaps, quoteLine, neutralize, markChanged, readFile, safeRel, ASSERTION, SKIPPED, TEST_DECL, findingBlock, findingHead });
