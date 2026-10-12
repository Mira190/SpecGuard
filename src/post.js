// Validates, filters, anchors and posts an advisory review. Never blocks the PR.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { inspectChecks } = require('./checks');
const { ours } = require('./preflight');

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
const clean = (s) => truncate(redact(s));
const oneLine = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// The one sanitiser for every piece of model- or document-derived text that reaches a comment or the summary.
// Idempotent. Removes HTML comments (our markers live in them), neutralises tags, @mentions and images, and drops control and bidi characters.
const INVISIBLE = /[\u0000-\u0008\u000B-\u001F\u007F​-‏‪-‮⁠-⁤⁦-⁩﻿]/g;
function neutralize(s) {
  let t = String(s).replace(INVISIBLE, '');
  for (let prev; prev !== t;) { prev = t; t = t.replace(/<!--[\s\S]*?-->/g, ''); }
  t = t.replace(/<!--[\s\S]*$/, '').replace(/!\[[^\]]*\](?:\([^)]*\)|\[[^\]]*\])?/g, '')
    .replace(/<(?=[A-Za-z/!?])/g, '&lt;').replace(/@(?=[A-Za-z0-9_])/g, '@​');
  return redact(t);
}

// line -> hunk index per side. RIGHT: '+' and ' ' lines, LEFT: '-' lines.
function parsePatch(patch) {
  const m = { RIGHT: new Map(), LEFT: new Map(), changed: { RIGHT: new Map(), LEFT: new Map() } };
  let h = -1, l = 0, r = 0;
  for (const ln of String(patch || '').split(/\r?\n/)) { // CRLF files: content lines end in CR
    const hd = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(ln);
    if (hd) { h++; l = +hd[1]; r = +hd[2]; continue; }
    if (h < 0 || ln === '' || ln[0] === '\\') continue;
    if (ln[0] === '+') { m.changed.RIGHT.set(r, ln.slice(1)); m.RIGHT.set(r++, h); }
    else if (ln[0] === '-') { m.changed.LEFT.set(l, ln.slice(1)); m.LEFT.set(l++, h); }
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

// Hand-rolled mirror of findings.schema.json. ponytail: swap for ajv if the schema grows.
// Structural problems (not an object, core arrays missing) reject the output. Every other problem degrades only
// the affected part, is repaired in place, and is listed in o.validation_notes.
function validate(o) {
  const bad = (m) => ({ ok: false, error: m });
  const str = (v) => typeof v === 'string';
  const int = (v) => Number.isInteger(v) && v >= 1;
  const text = (v) => str(v) && v.trim().length > 0;
  const citation = (v) => v && text(v.path) && int(v.line) && text(v.quote) && (v.side === undefined || ['LEFT', 'RIGHT'].includes(v.side));
  if (!o || typeof o !== 'object' || Array.isArray(o)) return bad('not an object');
  for (const k of ['coverage', 'findings', 'requirements']) if (!Array.isArray(o[k])) return bad(`${k} must be an array`);
  const notes = [];
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

  const rowError = (c) => {
    if (!text(c.obligation) || !text(c.source) || !text(c.reason)) return 'obligation, source and reason are required';
    if (c.change === undefined) c.change = c.behaviour; // ponytail: omitted change = the cited behaviour; verifyEvidence still checks it against the diff
    if (!(c.behaviour === null || citation(c.behaviour)) || !(c.change === null || citation(c.change))) return 'malformed citation';
    if (!Array.isArray(c.evidence)) return 'evidence must be an array';
    if (!STATUSES.includes(c.status)) return 'invalid status';
    for (const e of c.evidence) {
      if (e && e.kind === undefined) e.kind = 'assertion'; // the documented meaning of an evidence quote; the quote is still verified
      if (!citation(e) || !['unit', 'component', 'integration', 'e2e'].includes(e.layer) || !text(e.proves)
        || !['assertion', 'no_assertion', 'disabled', 'removed'].includes(e.kind)) return 'evidence malformed';
      if (e.kind === 'removed' && e.side !== 'LEFT') return "removed evidence must cite the diff's LEFT side";
    }
    if (c.status === 'covered' && (!c.behaviour || !c.evidence.some((e) => e.layer === 'unit' && e.kind === 'assertion' && e.side !== 'LEFT'))) return 'covered needs a current unit assertion';
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
  for (const [i, c] of o.coverage.entries()) if (c && typeof c === 'object' && c.alignment === undefined) return bad(`coverage[${i}].alignment is required (old report format)`);
  const align = (a) => {
    if (!a || typeof a !== 'object' || !ALIGN.includes(a.status) || !text(a.reason) || (a.since !== undefined && !['introduced', 'pre_existing'].includes(a.since))) return null;
    return { status: a.status, ...(a.since && { since: a.since }), reason: a.reason };
  };
  for (const [i, c] of o.coverage.entries()) {
    if (!c || typeof c !== 'object' || !text(c.id) || ids.has(c.id)) { notes.push(`Dropped coverage[${i}]: missing or duplicate id.`); continue; }
    ids.add(c.id);
    const why = rowError(c);
    if (!why) {
      const a = align(c.alignment);
      if (!a) notes.push(`Obligation ${c.id} alignment unknown: malformed alignment.`);
      const al = a || unknownAlign('Malformed alignment.');
      if (al.status === 'mismatch' && ['unknown', 'covered'].includes(c.status)) { // never covered; 'unknown' would drop its spec_mismatch finding
        notes.push(`Obligation ${c.id}: mismatch row with status ${c.status} normalised to needs_human.`);
        rows.push({ ...c, status: 'needs_human', reason: 'A mismatch row cannot be covered: a test of the contradicting behaviour does not prove the requirement.', alignment: al });
      } else rows.push({ ...c, alignment: al });
      continue;
    }
    notes.push(`Obligation ${c.id} marked unknown: ${why}.`);
    rows.push({ id: c.id, obligation: text(c.obligation) ? c.obligation : '(not stated)', source: text(c.source) ? c.source : '(not stated)',
      behaviour: citation(c.behaviour) ? c.behaviour : null, change: citation(c.change) ? c.change : null, evidence: [], status: 'unknown', reason: `Malformed coverage row: ${why}.`, alignment: unknownAlign('Malformed coverage row.') });
  }
  const status = (id) => rows.find((c) => c.id === id).status;

  const reqIds = new Set(), reqs = [];
  for (const [i, r] of o.requirements.entries()) {
    if (!r || typeof r !== 'object' || !text(r.id) || reqIds.has(r.id) || !text(r.source) || !text(r.quote)) { notes.push(`Dropped requirements[${i}]: malformed or duplicate.`); continue; }
    reqIds.add(r.id);
    const linked = Array.isArray(r.obligation_ids) ? r.obligation_ids.filter((id) => ids.has(id)) : [];
    const broken = !Array.isArray(r.obligation_ids) || linked.length !== r.obligation_ids.length;
    if (broken) notes.push(`Requirement ${r.id}: unknown or malformed obligation links removed.`);
    reqs.push({ id: r.id, source: r.source, quote: r.quote, obligation_ids: linked,
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
    for (const k of ['suggestion', 'rule_source', 'rule_quote', 'source']) if (f[k] !== undefined && !str(f[k])) return `invalid ${k}`;
    if (!['high', 'low'].includes(f.confidence)) return 'invalid confidence';
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
    if (fixed) { f.confidence = 'low'; notes.push(`Obligation row contradicted finding ${f.kind} ${f.path}: kept the finding at low confidence and marked the row ${want}.`); }
  };
  let kept = [];
  for (const [i, f] of o.findings.entries()) {
    repair(f);
    const why = findingError(f);
    if (why) notes.push(`Dropped ${[`findings[${i}]`, ...(f && typeof f === 'object' ? [f.kind, f.path, f.title].filter(text) : [])].join(' ')}: ${why}.`);
    else kept.push(f);
  }
  const d = { coverage: rows, requirements: reqs, findings: kept };
  settle(d, notes);
  kept = d.findings;
  const demoted = new Set();
  for (const c of rows) {
    if (c.alignment.status !== 'mismatch' && ['missing_test', 'weak_test'].includes(c.status) && kept.filter((f) => f.kind === c.status && f.obligation_ids.includes(c.id)).length !== 1) {
      notes.push(`Obligation ${c.id} marked unknown: needs exactly one ${c.status} finding.`);
      demoted.add(c.id);
      Object.assign(c, { status: 'unknown', reason: 'Inconsistent findings for this gap.' });
    }
  }
  kept = kept.map((f) => ({ ...f, obligation_ids: f.obligation_ids.filter((id) => !demoted.has(id)) })).filter((f) => f.kind === 'standard' || f.obligation_ids.length);
  Object.assign(o, { coverage: rows, requirements: reqs, findings: kept, validation_notes: notes });
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
// An acceptance-criterion source is stabler than a quote: the model re-anchors the same finding on different lines between runs.
// ponytail: AC-only means a new gap on the same AC and file at another line is hidden once the first is posted; add the line to the key if that bites.
const AC = /^(issue (?:[\w.-]+\/[\w.-]+)?#\d+|PR body) AC \d+$/;
const SPEC = /^(?=\S*[./])\S+ \S.*$/; // "docs/specs/pricing.md R3": a spec source keys on path + ref, never on line numbers
const fingerprint = (kind, p, quote, ...sources) => {
  const ac = sources.filter((s) => AC.test(s) || SPEC.test(s)).sort();
  return crypto.createHash('sha1').update(`${kind}\0${p}\0${ac.length ? ac.join('\0') : norm(quote)}`).digest('hex');
};

// Line delta (0, -1, +1, ... up to +-5) that puts the quote on the cited line, or null. Never guesses.
function snap(f, lines) {
  if (!lines) return null;
  const q = norm(f.quote);
  if (!q) return null;
  for (let d = 0; d <= 5; d++) for (const s of d ? [-d, d] : [0]) {
    const at = f.line - 1 + s;
    if (at >= 0 && at < lines.length && norm(lines[at]) === q && (f.start_line === undefined || f.start_line + s >= 1)) return s;
  }
  return null;
}

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

function commentBody(f, fp, inline = true) {
  const why = neutralize(`kind: ${f.kind}, confidence: ${f.confidence}${f.rule_source ? `, rule: ${f.rule_source}` : ''}`);
  // the trailer (suggestion, rationale, fingerprint marker) is never cut: only the model's own text is truncated
  const trailer = `${fix(f, inline)}\n\n<details><summary>Why this was flagged</summary>\n\n${why}\n</details>\n\n<!-- specguard:fp=${fp} -->`;
  return truncate(`**${title1(f.title)}**\n\n${neutralize(f.body)}`, BODY_MAX - trailer.length) + trailer;
}

const axes = (fs) => { const n = (k) => fs.filter((f) => f.kind === k).length; return `Tests: ${n('missing_test')} missing, ${n('weak_test')} weak · Standards: ${n('standard')} · Layering: ${n('pushdown')}${n('spec_mismatch') ? ` · Spec: ${n('spec_mismatch')} mismatch` : ''}`; };
const proven = (cov) => {
  const rows = cov.filter((c) => c.status !== 'needs_human');
  return rows.length ? `Unit evidence: ${rows.filter((c) => c.status === 'covered').length}/${rows.length} obligations (static review; tests not executed)` : '';
};
const gapFree = (data) => !data.findings.length && !(data.validation_notes || []).length && data.coverage.length > 0 && !data.not_reviewed
  && data.standards.status !== 'not_reviewed' && data.layering.status === 'checked'
  && data.requirements.every((r) => r.obligation_ids.length > 0)
  && (!data.tooling || ['passed', 'not_configured'].includes(data.tooling.status))
  && data.coverage.every((c) => c.status === 'covered' && !['mismatch', 'unknown'].includes(c.alignment?.status));
// The requirement text is read from the PR head, so a PR can weaken it and still be "consistent": never clean when it did.
const reqChanged = (data) => data.requirements.some((r) => r.req_change || (r.reflected_in && r.reflected_in.spec));
const noGaps = (data) => gapFree(data) && !reqChanged(data);

// A criterion split into several obligations is covered only when every one is.
const met = (r, covById) => {
  const n = r.obligation_ids.length, k = r.obligation_ids.filter((id) => covById.get(id)?.status === 'covered').length;
  return n ? `${k}/${n} obligations covered${k < n ? ' (not fully covered)' : ''}. ` : '';
};
const cell = (s, n = Infinity) => oneLine(neutralize(s), n).replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ');
const item = ({ f, why }) => `- **${title1(f.title)}** (\`${cell(`${f.path}:${f.line}`)}\`, ${cell(f.kind)}${why ? `, ${cell(why)}` : ''})\n\n  ${(neutralize(f.body) + fix(f, false)).replace(/\n/g, '\n  ')}\n`;

// A requirement source is either exactly a collected document label or a repository path; nothing in between.
const LABEL = /^(?:PR body|issue (?:[\w.-]+\/[\w.-]+)?#\d+|history (?:PR|issue) (?:[\w.-]+\/[\w.-]+)?#\d+)$/;
const REMOVED = / [(]removed[)]$/;
const specPath = (src) => !LABEL.test(String(src).replace(/ AC \d+$/, '')); // the source cites a repository file, not a PR/issue label
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
  const at = (c) => (c ? link(c.path, c.line, `${c.path}:${c.line}`) : '');
  const rows = [];
  let flagged = false;
  for (const r of data.requirements) {
    if (!specPath(r.source) || !r.obligation_ids.length) continue;
    const removed = REMOVED.test(r.source), p = r.source.replace(REMOVED, '');
    let req = removed ? `${p} ${r.ref || ''} (removed)` : link(p, r.line, `${p}${r.ref ? ` ${r.ref}` : ''}`);
    const ch = r.req_change;
    if (ch) {
      flagged = true;
      req += ch.kind === 'authored' ? ' ⚠ Requirement document authored in this PR (no base version)'
        : ` ⚠ Requirement ${ch.kind === 'removed' ? 'removed' : ch.kind === 'added' ? 'added' : 'changed'} in this PR${ch.previous ? ` — was: "${oneLine(String(ch.previous).replace(/\s+/g, ' '), 160)}"` : ''}`;
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
  const banner = flagged ? '> Requirement text was changed by this PR: consistency with the changed text does not prove the change itself is approved.\n\n' : '';
  return { head: `**Traceability**\n\n${banner}| Requirement | Changed | Implementation | Tests | Alignment | Reflected in |\n|---|---|---|---|---|---|\n`, atoms: rows.map((x) => `${x}\n`) };
}

const MAX_ROWS = 30;
// Collapsed list of what the review read. Paths are repo-relative and come from the collector, not the model.
function sourcesRead({ reqDocs = [], standards = [], trace, head, base }) {
  const list = (a) => (a.length ? a.slice(0, 15).map((x) => `\`${cell(x)}\``).join(', ') + (a.length > 15 ? `, +${a.length - 15} more` : '') : 'none');
  return `<details><summary>Sources read</summary>\n\n- Requirement documents: ${list(reqDocs)}\n- Standards files: ${list(standards)}\n- Trace: ${cell(trace)}\n- Commits: head \`${cell(String(head).slice(0, 7))}\`, base \`${cell(String(base).slice(0, 7))}\`\n\n</details>\n`;
}
// Sections in order of importance (findings, pre-existing drift, Traceability, then the long tables). Each section's items are
// added while they fit under the comment limit; what does not fit is counted, never cut mid-item, and the summary says so.
function buildSummary({ status, data, tooling = data?.tooling, items = [], partial, engine, model, rules = [], blob, specFiles, pre = [], traceNote, headSha, manifest, incomplete = [] }) {
  // hidden: the preflight skips a rerun on a head SHA that already has a completed summary (never written for a failed run)
  let head = `<!-- specguard:summary -->\n${/^\w+$/.test(headSha || '') ? `<!-- specguard:head=${headSha} -->\n` : ''}## SpecGuard\n\n${neutralize(status)}\n\n`;
  if (engine) head += `_Engine: ${cell(`${engine}${model ? ` (${model})` : ''}`)}_\n\n`;
  if (partial) head += '> Partially reviewed: the diff exceeded `max_diff_kb` and was truncated.\n\n';
  if (incomplete.length) head += `> **Incomplete review.** Not everything was covered; verified findings are still listed, no threads were auto-resolved, and the next push or rerun reviews again.\n${incomplete.map((r) => `> - ${cell(r)}`).join('\n')}\n\n`;
  if (traceNote) head += `> Traceability unavailable for this PR (${cell(traceNote)}).\n\n`;
  if (rules.length) head += `> This PR modifies review rule or agent-config files (${rules.map((x) => cell(x)).join(', ')}); they were not reviewed, and the base versions were applied.\n\n`;
  const sections = []; // { h, atoms, tail }
  const add = (h, atoms = [], tail = '') => sections.push({ h, atoms, tail });
  if (items.length) add(`<details><summary>${items.length} more item(s): low confidence, inferred, overflow, unanchored</summary>\n\n`, items.map((x) => `${item(x)}\n`), '</details>\n');
  if (pre.length) add('### Pre-existing drift (not caused by this PR)\n\n', pre.map((f) => `${item({ f })}\n`));
  if (data) {
    const covById = new Map(data.coverage.map((c) => [c.id, c]));
    const t = traceTable(data, blob, specFiles, covById);
    if (t) add(t.head, t.atoms, '\n');
    add(`**Requirements source:** ${cell(data.requirements_source)}\n\n`);
    if (data.requirements.length) {
      const assessed = data.requirements.filter((r) => r.obligation_ids.length), open = data.requirements.filter((r) => !r.obligation_ids.length);
      const shown = [...assessed, ...open.slice(0, MAX_ROWS)];
      add('| Criterion | Source / original wording | Obligations | Assessment |\n|---|---|---|---|\n',
        shown.map((r) => `| ${cell(r.id, 40)} | ${cell(`${r.source}: ${r.quote}`, 500)} | ${cell(r.obligation_ids.join(', ') || 'NOT ASSESSED')} | ${cell(`${met(r, covById)}${r.reason}`, 400)} |\n`),
        open.length > MAX_ROWS ? `\n_+${open.length - MAX_ROWS} more NOT ASSESSED criteria not shown._\n\n` : '\n');
    }
    if (data.coverage.length) {
      add('| Obligation | Source / behaviour | Assertion evidence / layer | Status / reason |\n|---|---|---|---|\n',
        data.coverage.map((c) => `| ${cell(`${c.id}: ${c.obligation}`, 500)} | ${cell(`${c.source}; ${c.behaviour ? `${c.behaviour.path}:${c.behaviour.line} — ${c.behaviour.quote}` : 'implementation not located'}`, 500)} | ${cell(c.evidence.map((e) => `${e.layer}: ${e.path}:${e.line} — ${e.quote} (${e.kind}; ${e.proves})`).join('; ') || 'none', 800)} | ${cell(`${c.status}: ${c.reason}`, 500)} |\n`), '\n');
    } else add('**No obligations assessed.** This is not evidence that tests are sufficient.\n\n');
    add(`**Coding standards: ${cell(data.standards.status)}.** ${cell(data.standards.reason)} Sources: ${cell(data.standards.sources.join(', ') || 'none')}.\n\n`);
    add(`**Test layers: ${cell(data.layering.status)}.** ${cell(data.layering.reason)}\n\n`);
    if (specFiles && !specFiles.length && !traceNote) add('No requirement documents found (content-based discovery; see `requirements_paths` to add or exclude).\n\n');
    if (tooling) {
      add(`**Standards tooling: ${cell(tooling.status)}.** Commit: ${cell(tooling.ref || 'not selected')}. ${cell(tooling.reason || '')}\n\n`,
        (tooling.checks || []).map((c) => `- ${cell(c.name)}: ${cell(c.state)}; producer: ${cell(c.producer || 'unknown')}${/^https:\/\//.test(c.url) ? ` — [run](${c.url.replace(/[()]/g, (s) => encodeURIComponent(s))})` : ''}\n`), '\n');
    }
    if (data.not_reviewed) add(`**Not reviewed:** ${neutralize(data.not_reviewed)}\n\n`);
    const vn = data.validation_notes || [];
    if (vn.length) add(`<details><summary>Validation notes (${vn.length})</summary>\n\n`, vn.map((m) => `- ${neutralize(m).replace(/\s*\n\s*/g, ' ')}\n`), '</details>\n\n');
  } else if (tooling) {
    add(`**Standards tooling: ${cell(tooling.status)}.** Commit: ${cell(tooling.ref || 'not selected')}. ${cell(tooling.reason || '')}\n\n`,
      (tooling.checks || []).map((c) => `- ${cell(c.name)}: ${cell(c.state)}; producer: ${cell(c.producer || 'unknown')}${/^https:\/\//.test(c.url) ? ` — [run](${c.url.replace(/[()]/g, (s) => encodeURIComponent(s))})` : ''}\n`), '\n');
  }
  const RESERVE = 200; // for the closing "(truncated)" line
  let out = head, cut = false;
  for (const { h, atoms, tail } of sections) {
    let body = '', n = 0;
    for (const a of atoms) { if (out.length + h.length + body.length + a.length + tail.length + RESERVE > BODY_MAX) break; body += a; n++; }
    if (n < atoms.length || (!atoms.length && out.length + h.length + RESERVE > BODY_MAX)) {
      cut = true;
      if (!n) continue;
      body += `_+${atoms.length - n} more not shown._\n`;
    }
    out += h + body + tail;
  }
  const src = manifest && sourcesRead(manifest); // metadata: dropped before anything else, and never alongside a cut section
  if (src && !cut && out.length + src.length + RESERVE <= BODY_MAX) out += src;
  return clean(cut ? `${out}\n_(truncated: the summary exceeded the comment size limit; the most important sections come first)_\n` : out);
}

// Workspace file as lines. Never anything under .git/ or the collection context, never a path that escapes the workspace
// (also after symlinks): those hold credentials and the collector's own state.
const DENIED = /^(?:\.git|\.specguard-ctx)(?:\/|$)/i;
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
  // Corrects c.line to the nearest line within +-5 whose text equals the quote (the way snap does for findings); false when none.
  // Failing that, snaps to the one line among `all` (candidate line numbers) whose text equals the quote, e.g. when the model cited a
  // diff.patch line number; several matches or none keep the citation unverified.
  const locate = (c, at, all = []) => {
    const q = norm(c.quote);
    for (let d = 0; d <= 5; d++) for (const s of d ? [-d, d] : [0]) if (c.line + s >= 1 && norm(at(c.line + s) || '') === q) { c.line += s; return true; }
    const hits = [...all].filter((l) => norm(at(l) || '') === q);
    if (hits.length === 1) { c.line = hits[0]; return true; }
    return false;
  };
  const changed = (c) => (l) => maps.get(c.path)?.changed[c.side || 'RIGHT'].get(l);
  const keys = (c) => maps.get(c.path)?.changed[c.side || 'RIGHT'].keys() || []; // the known (changed) line range of that side
  const exact = (c) => {
    const lines = c.side === 'LEFT' ? null : read(c.path);
    return c.side === 'LEFT' ? locate(c, changed(c), keys(c)) : locate(c, (l) => lines?.[l - 1], lines ? lines.map((_, i) => i + 1) : []);
  };
  for (const c of data.coverage) {
    const { change } = c;
    const ok = [!change || (reviewable.has(change.path) && locate(change, changed(change), keys(change))), !c.behaviour || exact(c.behaviour), ...c.evidence.map((e) => exact(e))];
    if (ok.includes(false)) {
      c.status = 'unknown';
      c.reason = 'Could not verify the changed-line, behaviour or test citation.';
      c.alignment = unknownAlign('A citation could not be verified.');
    }
  }
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
  const q = norm(quote), qs = String(quote).split('\n').map(norm).filter(Boolean);
  if (!qs.length) return 0;
  const win = (i) => norm(lines.slice(i, i + qs.length + 6).join(' ')).includes(q); // tolerates a quote wrapped over a few lines
  return lines.findIndex((l, i) => norm(l) && win(i) && !win(i + 1)) + 1; // the quote starts on the last line from which it still fits
}

// context.specFiles (optional): the trusted spec-files.txt allow-list. A requirement citing a repository file outside it is unlinked.
function verifyRequirements(data, context, read = readFile) {
  const allow = context.specFiles ? new Set(context.specFiles) : null;
  const note = (s) => { data.not_reviewed = [data.not_reviewed, s].filter(Boolean).join(' '); };
  const invalid = new Set(), unassessed = [];
  const texts = new Map(); // normalised once per source, not once per criterion
  const textOf = (key, get) => { if (!texts.has(key)) { const text = get(); texts.set(key, { text, n: norm(text) }); } return texts.get(key); };
  const byId = new Map(data.requirements.map((r) => [r.id, r]));
  const docs = new Map();
  for (const d of context.documents || []) if (!docs.has(d.source)) docs.set(d.source, d);
  for (const expected of context.criteria || []) {
    const r = byId.get(expected.id);
    if (!r) { if (!expected.optional) data.requirements.push({ id: expected.id, source: expected.source, quote: expected.quote, ...(expected.ref && { ref: expected.ref }), ...(expected.line && { line: expected.line }), obligation_ids: [], reason: 'Structured acceptance criterion was not assessed.' }); } // optional (history) criteria are never re-added
    else if (!(r.source === expected.source || r.source.startsWith(`${expected.source} AC `) && /^\d+$/.test(r.source.slice(expected.source.length + 4))) || norm(r.quote) !== norm(expected.quote)) {
      r.obligation_ids.forEach((id) => invalid.add(id));
      Object.assign(r, { source: expected.source, quote: expected.quote, obligation_ids: [], reason: 'Criterion ID did not match its collected source text.' });
    } else { // "PR body AC 1" is accepted; the collected label and ref are canonical (the model's own ref is never trusted)
      r.source = expected.source;
      if (expected.ref) r.ref = safeRef(expected.ref); else delete r.ref;
    }
  }
  for (const r of data.requirements) {
    const label = r.source.replace(/ AC \d+$/, ''); // "PR body AC 3" -> the collected document label
    const collected = docs.get(label);
    // A source is exactly a collected document label, or a normalised repository path that the allow-list names (when there is one).
    const file = safeRel(label.replace(REMOVED, ''));
    const isPath = specPath(label);
    const rejected = !collected && isPath && !(file && (!allow || allow.has(file)));
    const T = rejected ? { text: '', n: '' } : textOf(collected ? `label:${label}` : `file:${file}`, () => (collected ? collected.text : isPath ? (read(file) || []).join('\n') : ''));
    if (rejected || !T.n.includes(norm(r.quote))) {
      if (rejected || !context.unavailable) r.obligation_ids.forEach((id) => invalid.add(id)); // no status file: citations that verify on their own keep their findings
      r.obligation_ids = [];
      r.reason = rejected ? 'The cited file is not a collected requirement document.' : 'Could not verify the original criterion wording against its source.';
    } else if (specPath(label)) { // re-derive the line from the quote; a model-supplied line is never trusted
      const at = quoteLine(T.text.split('\n'), r.quote);
      if (at) { r.line = at; r.end = at + String(r.quote).split('\n').length - 1; } else delete r.line;
    }
    if (r.pr_quote !== undefined) { // a verified sentence from the PR body, else null
      const pr = docs.get('PR body');
      if (!(typeof r.pr_quote === 'string' && pr && textOf('label:PR body', () => pr.text).n.includes(norm(r.pr_quote)))) r.pr_quote = null;
    }
    if (!r.obligation_ids.length) unassessed.push(`Requirement ${r.id} is not assessed: ${r.reason}`);
  }
  if (unassessed.length) note(unassessed.slice(0, 10).join(' ') + (unassessed.length > 10 ? ` ${unassessed.length - 10} more requirements are not assessed.` : ''));
  for (const c of data.coverage) if (invalid.has(c.id)) {
    c.status = 'unknown'; c.reason = 'The linked requirement citation could not be verified.';
    c.alignment = unknownAlign('The linked requirement citation could not be verified.');
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
    const touched = specTouched || behaviourChanged || sameHunk || modified;
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

// Resolve review threads whose only comment is our own bot comment for a finding this run no longer reports. Any failure is a limitation note, never a run failure.
async function resolveStale({ github, core, owner, repo, number, current, actor = null, maxThreads = 300, maxResolve = 20 }) {
  const q = 'query($o:String!,$r:String!,$n:Int!,$a:String){repository(owner:$o,name:$r){pullRequest(number:$n){reviewThreads(first:100,after:$a){pageInfo{hasNextPage endCursor}nodes{id isResolved comments(first:2){nodes{author{login __typename} body}}}}}}}';
  try {
    const stale = [];
    let after = null, seen = 0;
    while (seen < maxThreads) {
      const t = (await github.graphql(q, { o: owner, r: repo, n: number, a: after })).repository.pullRequest.reviewThreads;
      for (const th of t.nodes) {
        seen++;
        const cs = th.comments.nodes;
        const m = cs.length === 1 && !th.isResolved && ours(cs[0].author, actor) && /<!-- specguard:fp=([0-9a-f]{40}) -->\s*$/.exec(cs[0].body || '');
        if (m && !current.has(m[1])) stale.push(th.id);
      }
      if (!t.pageInfo.hasNextPage) break;
      after = t.pageInfo.endCursor;
    }
    for (const threadId of stale.slice(0, maxResolve)) await github.graphql('mutation($t:ID!){resolveReviewThread(input:{threadId:$t}){thread{id}}}', { t: threadId });
  } catch (e) { core.warning(`SpecGuard: stale review threads could not be resolved: ${e.message}`); }
}

async function run({ github, context, core }) {
  const { owner, repo } = context.repo;
  const pr = context.payload.pull_request;
  if (!pr) return core.warning('SpecGuard: not a pull_request event');
  const env = process.env;
  const ctx = env.CTX || '';
  const engine = env.ENGINE || '', model = env.MODEL || '';
  const partial = env.PARTIAL === 'true';
  const maxComments = Math.max(1, parseInt(env.MAX_COMMENTS, 10) || 10);
  const headSha = env.HEAD_SHA || pr.head.sha;
  // '' when the PR is still open at our head; else why not. Not being able to tell is also a reason: nothing is posted then (no atomicity is claimed: a push can still land right after).
  let livePR, rechecked = true;
  const current = async () => {
    try { livePR = (await github.rest.pulls.get({ owner, repo, pull_number: pr.number })).data; rechecked = true; }
    catch (e) { rechecked = false; core.warning(`SpecGuard: could not recheck HEAD: ${e.message}`); return 'could not recheck HEAD'; }
    return livePR.head.sha !== headSha ? 'superseded HEAD' : livePR.state === 'closed' ? 'PR is no longer open' : '';
  };
  const early = await current();
  if (early && rechecked) return core.warning(`SpecGuard: ${early}; no results published`); // a failed read continues: the result still reaches the job summary
  let actorId; // the authenticated login, or null (GITHUB_TOKEN cannot call /user: github-actions[bot])
  const actor = async () => {
    if (actorId === undefined) { try { actorId = (await github.rest.users.getAuthenticated()).data.login; } catch { actorId = null; } }
    return actorId;
  };

  const publish = async (text) => {
    await core.summary.addRaw(text).write();
    try {
      const stop = await current();
      if (stop) return core.warning(`SpecGuard: ${stop}; summary comment not updated`);
      const cs = await github.paginate(github.rest.issues.listComments, { owner, repo, issue_number: pr.number, per_page: 100 });
      const me = await actor();
      const mine = cs.find((c) => ours(c.user, me) && typeof c.body === 'string' && c.body.startsWith('<!-- specguard:summary -->'));
      if (mine) await github.rest.issues.updateComment({ owner, repo, comment_id: mine.id, body: text });
      else await github.rest.issues.createComment({ owner, repo, issue_number: pr.number, body: text });
    } catch (e) { core.warning(`SpecGuard: could not post summary comment: ${e.message}`); }
  };

  let rules = [];
  try { rules = fs.readFileSync(path.join(ctx, 'rule-changes.txt'), 'utf8').split('\n').filter(Boolean); } catch {}
  if (env.SKIP === 'true') return publish(buildSummary({ rules, headSha, status: 'Nothing to review: every changed file is ignored (lockfiles, docs, generated files).' }));
  const target = env.STANDARDS_REF || 'head';
  const ref = target === 'head' ? headSha : target === 'merge' && livePR?.mergeable === true ? livePR.merge_commit_sha : null;
  const tooling = ref ? await inspectChecks({ github, owner, repo, ref, names: env.STANDARDS_CHECKS })
    : { status: 'unavailable', ref: '', checks: [], reason: target === 'merge' ? 'PR has no current test-merge commit' : 'Configured standards ref must be head or an available current merge commit.' };
  const failed = (why) => publish(buildSummary({ rules, status: `Could not complete: ${why}`, tooling, engine, model, partial }));

  const readCtx = (n) => { try { return fs.readFileSync(path.join(ctx, n), 'utf8'); } catch { return null; } };
  // One run-completeness state, from collector and engine status files only (never model output). A non-empty list withholds the HEAD marker and stale-thread resolution.
  const incomplete = [];
  const st = (readCtx('engine-status') || '').trim();
  if (partial) incomplete.push('The diff exceeded `max_diff_kb` and was truncated; obligations outside the reviewed portion are unknown.');

  let data;
  try { data = JSON.parse(fs.readFileSync(path.join(ctx, 'findings.json'), 'utf8')); }
  catch (e) {
    if (st === 'timeout') return failed(`the review timed out after ${env.REVIEW_TIMEOUT_MINUTES || '12'} minutes; raise review_timeout_minutes or split the PR`);
    if (st === 'failed') return failed('the review engine failed; see the job log');
    return failed(`no valid findings.json (${e.code || 'parse error'}); see the job log`);
  }
  const proposed = Array.isArray(data?.findings) ? data.findings.length : 0; // what the model reported: a finding dropped or demoted later is a degrade, not a fix
  const v = validate(data);
  if (!v.ok) return failed(`findings.json failed validation: ${v.error}`);
  // The engine can leave a parseable findings.json and still have timed out or failed: keep what verifies, but the run is not complete.
  if (st && st !== 'success') incomplete.push(st === 'timeout' ? `The review engine timed out after ${env.REVIEW_TIMEOUT_MINUTES || '12'} minutes; the findings may be partial.` : st === 'failed' ? 'The review engine failed; the findings may be partial.' : `The review engine did not finish cleanly (${st}); the findings may be partial.`);
  const addNote = (m) => { data.not_reviewed = [data.not_reviewed, m].filter(Boolean).join(' '); };
  const memoed = (read) => { const m = new Map(); return (p) => (m.has(p) ? m : m.set(p, read(p))).get(p); }; // files do not change during a run
  const root = env.GITHUB_WORKSPACE || process.cwd();
  const tracked = trackedFiles(root);
  if (!tracked) (data.validation_notes ||= []).push('Tracked files could not be listed; no workspace file was read as evidence.');
  // citations (evidence, behaviour, findings, requirement files) are read only from files tracked at the checked-out head
  const readLines = memoed((p) => { const rel = safeRel(p); return rel && tracked && tracked.has(rel) ? readFile(rel) : null; });
  const readRule = memoed(readFile); // the trusted rule inventory may include base-restored files that are not tracked at head
  data.tooling = tooling; // Always overwrite any model-supplied tooling claim.

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
  let smap = null; // path -> scope; absent for older collectors, which skips the applicability check
  try { smap = new Map(JSON.parse(readCtx('standards-map.json')).map((e) => [e.path, e.scope])); } catch { /* no map */ }
  for (const l of (readCtx('collect-limits.txt') || '').split('\n').filter(Boolean)) addNote(l);
  verifyEvidence(data, reviewable, standards, readLines, maps);
  let requirements = null;
  try { requirements = JSON.parse(fs.readFileSync(path.join(ctx, 'requirements-status.json'), 'utf8')); verifyRequirements(data, { ...requirements, specFiles }, readLines); } catch { requirements = null; }
  if (requirements) {
    data.requirements_source = requirements.sources.join(', ') || 'unavailable; changed behaviour only';
    if (requirements.status !== 'available') addNote((requirements.limitations || []).join(' '));
    // What the collector did not collect. Not these: an empty PR body (a fact about the PR) and the capped requirements-index.md (the documents stay readable).
    const lims = [...(requirements.limitations || []), ...(requirements.spec?.limitations || [])].filter((l) => !/^No requirement text available|^requirements-index\.md exceeded /.test(l));
    if (lims.length) incomplete.push(`Requirement collection did not cover everything: ${lims.slice(0, 10).join(' ')}${lims.length > 10 ? ` (+${lims.length - 10} more)` : ''}`);
  } else { // no collected documents: quotes verify only against files; unverifiable ones are unassessed but their obligations keep their own citations
    verifyRequirements(data, { unavailable: true, specFiles }, readLines);
    data.requirements_source = 'unavailable; changed behaviour only';
    addNote('Requirement collection status unavailable.');
    incomplete.push('Requirement collection status was unavailable; only changed behaviour was assessed.');
  }
  if (partial) addNote('Diff truncated; obligations outside the reviewed portion are unknown.');
  const base = env.BASE_SHA || pr.base?.sha;
  const dmaps = new Map([...maps, ...(base ? renameMaps(base, headSha, process.env.GITHUB_WORKSPACE || process.cwd()) : [])]);
  differential(data, dmaps);
  reflect(data, dmaps, reviewable);
  markChanged(data, requirements);
  const pre = new Set(data.coverage.filter((c) => ['mismatch', 'impacted'].includes(c.alignment.status) && c.alignment.since === 'pre_existing').map((c) => c.id));
  const preExisting = []; // drift this PR did not cause: summary section only, never inline

  const known = new Set();
  let withheld = ''; // why inline comments cannot be posted safely
  try {
    const me = await actor();
    for (const c of await github.paginate(github.rest.pulls.listReviewComments, { owner, repo, pull_number: pr.number, per_page: 100 })) {
      const m = /<!-- specguard:fp=([0-9a-f]{40}) -->\s*$/.exec(c.body || ''); // the marker is always last; outdated comments have line=null: fingerprint only
      if (m && ours(c.user, me)) known.add(m[1]);
    }
  } catch (e) {
    withheld = `existing review comments could not be listed (${e.status ? `${e.status}: ` : ''}${String(e.message).split('\n')[0]}), so inline comments were withheld to avoid duplicates`;
    core.warning(`SpecGuard: ${withheld}`);
    incomplete.push(`Delivery degraded: ${withheld}; the findings are in this summary.`);
  }
  const survive = new Set(); // fingerprints of every finding still present after validation, wherever it ends up (inline, summary, capped, unverifiable)

  const kept = [];
  let already = 0;
  const seen = new Set();
  const cands = [];
  const assessed = [];
  const unanchored = []; // items that failed to post or anchor; they go to the summary
  const gate = (r) => { if (r.note) (data.validation_notes ||= []).push(r.note); return r.f; }; // quality gates only demote or trim; each leaves a validation note
  for (let f of data.findings) {
    if (f.kind === 'spec_mismatch') {
      const req = data.requirements.find((r) => r.obligation_ids.includes(f.obligation_ids[0]));
      if (req && specPath(req.source) && req.ref) f = { ...f, source: `${req.source.replace(REMOVED, '')} ${req.ref}` };
    }
    survive.add(fingerprint(f.kind, f.path, f.quote, f.source)); // before any route or drop below
    if (f.kind === 'spec_mismatch' && f.obligation_ids.every((id) => pre.has(id))) {
      const d = snap(f, readLines(f.path));
      if (d === null) addNote(`Finding citation did not match: ${f.path}:${f.line}.`); else preExisting.push({ ...f, line: f.line + d });
      continue;
    }
    f = gate(skeletonGate(f));
    if (f.side === 'LEFT') {
      if (f.kind !== 'standard' && reviewable.has(f.path) && norm(maps.get(f.path)?.changed.LEFT.get(f.line) || '') === norm(f.quote)) {
        assessed.push(f);
        unanchored.push({ f, why: 'removed test or assertion; location is on the LEFT side of the diff' });
      } else addNote(`Removed-line citation could not be verified: ${f.path}:${f.line}.`);
      continue;
    }
    if (!maps.has(f.path) || !reviewable.has(f.path)) {
      const d = f.kind !== 'standard' ? snap(f, readLines(f.path)) : null;
      if (d !== null) {
        assessed.push(f);
        unanchored.push({ f: { ...f, line: f.line + d }, why: 'assertion outside the reviewed diff' });
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
    const d = snap(f, readLines(f.path));
    if (d === null) {
      addNote(`Finding citation did not match: ${f.path}:${f.line}.`);
      continue;
    }
    const exact = [f.kind, f.path, f.line + d, f.title, f.body].join('\0'); // only a verbatim repeat is dropped
    if (seen.has(exact)) continue;
    seen.add(exact);
    assessed.push(f);
    cands.push({ ...f, line: f.line + d, ...(f.start_line !== undefined && { start_line: f.start_line + d }) });

  }
  const merged = merge(cands);
  for (const f of merged) { survive.add(f.fp); known.has(f.fp) ? already++ : kept.push(f); } // a merged comment's fp covers all its members
  // ponytail: a finding that validation/verification dropped (its citation or requirement link failed) cannot be fingerprinted like its comment was; hold all resolving instead of guessing.
  const degraded = proposed > data.findings.length;

  const p = plan(kept, maps, maxComments);
  const comments = p.inline.map((f) => ({
    path: f.path, line: f.line, side: 'RIGHT', body: commentBody(f, f.fp),
    ...(f.start_line !== undefined && { start_line: f.start_line, start_side: 'RIGHT' }),
  }));
  const prov = proven(data.coverage);
  let inline = comments.length, filed = p.file.length;
  const counts = () => `${inline} inline, ${filed} file-level, ${p.summary.length + unanchored.length} in summary${already ? `, ${already} already posted` : ''}`;
  const head = `<!-- specguard:review -->\nSpecGuard found ${axes(assessed)}; ${counts()}.${prov ? `\n${prov}.` : ''}\nEngine: ${engine || 'n/a'}${model ? ` (${model})` : ''}.`;

  const stop = withheld ? 'inline comments withheld: could not deduplicate' : await current(); // never post what cannot be deduplicated or what may be stale
  if (stop) {
    if (!withheld) { core.warning(`SpecGuard: ${stop}; no review published`); incomplete.push(`Delivery degraded: ${stop}; the review comments and PR summary were not updated (this text is the job summary).`); }
    for (const f of [...p.inline, ...p.file]) unanchored.push({ f, why: withheld ? 'withheld: could not deduplicate' : `not posted: ${stop}` });
    inline = filed = 0;
  }
  if (!stop && comments.length) {
    const post = (body, cs) => github.rest.pulls.createReview({ owner, repo, pull_number: pr.number, commit_id: headSha, event: 'COMMENT', body: clean(body), ...(cs && { comments: cs }) });
    try { await post(head, comments); }
    catch (e) {
      if (e.status === 422) {
        try { await post(`${head}\n\nInline anchors were rejected; unanchored findings:\n\n${p.inline.map((f) => item({ f })).join('\n')}`); }
        catch (e2) { core.warning(`SpecGuard: review retry failed: ${e2.message}`); }
        p.inline.forEach((f) => unanchored.push({ f, why: 'anchor rejected' }));
        inline = 0;
      } else {
        core.warning(`SpecGuard: could not post review (${e.status}): ${e.message}`);
        if (e.status === 403 || e.status === 404) p.inline.slice(0, 10).forEach((f) => core.warning(f.title, { file: f.path, startLine: f.start_line || f.line, title: `SpecGuard ${f.kind}` }));
        p.inline.forEach((f) => unanchored.push({ f, why: 'could not post' }));
        inline = 0;
      }
    }
  }
  for (const f of stop ? [] : p.file) {
    const range = f.start_line ? `#L${f.start_line}-L${f.line}` : `#L${f.line}`;
    const link = `${context.serverUrl}/${owner}/${repo}/blob/${headSha}/${f.path}${range}`;
    try {
      await github.rest.pulls.createReviewComment({ owner, repo, pull_number: pr.number, commit_id: headSha, path: f.path, subject_type: 'file', body: commentBody({ ...f, body: `${f.body}\n\n[${f.path}:${f.line}](${link})` }, f.fp, false) });
    } catch (e) { core.warning(`SpecGuard: file-level comment failed: ${e.message}`); unanchored.push({ f, why: 'could not post' }); filed--; }
  }
  if (!stop && !incomplete.length && !degraded && env.RESOLVE_STALE !== 'false') await resolveStale({ github, core, owner, repo, number: pr.number, current: survive, actor: await actor() });

  const clean_ = noGaps(data) && !incomplete.length;
  await publish(buildSummary({ status: `${clean_ ? 'No test gaps found in the assessed obligations.' : `${incomplete.length ? 'Incomplete review (see below). ' : ''}${gapFree(data) && reqChanged(data) ? 'Requirement changed in this PR — review it. ' : ''}Reviewed: ${axes(assessed)}; ${counts()}.`}${prov ? `\n\n${prov}.` : ''}`, traceNote, data, items: [...p.summary, ...unanchored], rules, incomplete, engine, model, specFiles, pre: preExisting, blob: `${context.serverUrl}/${owner}/${repo}/blob/${headSha}`, headSha: incomplete.length ? undefined : headSha, // no head marker: the preflight must retry an incomplete run
    manifest: { reqDocs: specFiles || [], standards: smap ? [...smap.keys()] : [...standards], trace: traceNote ? 'unavailable' : traceStatus === 'off' ? 'off' : specFiles?.length ? 'spec found' : 'SPEC_NOT_FOUND', head: headSha, base } }));
}

module.exports = async (a) => {
  try { await run(a); } catch (e) { a.core.warning(`SpecGuard post failed: ${e.message}`); }
};
Object.assign(module.exports, { placeholder, skeletonGate, definedNames, definesUsedBy, parsePatch, parseDiff, validate, anchor, snap, ruleLine, merge, plan, fingerprint, redact, truncate, buildSummary, commentBody, axes, proven, noGaps, verifyEvidence, verifyRequirements, settle, differential, reflect, renameMaps, quoteLine, neutralize, markChanged, readFile, safeRel });
