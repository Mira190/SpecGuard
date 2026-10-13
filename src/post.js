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

// Take expected values from the requirement, never from the code under test (the mirror-test trap). Verbatim in every agent prompt.
const AGENT_RULE = 'Take expected values from the requirement quote or an independent literal; never compute them from the implementation under test. If the requirement is ambiguous, stop and ask.';
const FENCED = /^[ \t]*(`{3,}|~{3,})[^\n]*\n([\s\S]*?)\n[ \t]*\1[`~]*[ \t]*$/gm;
// Paste-ready prompt for a coding agent, built only from validated fields (path, line, title, body, linked requirement). Style findings carry their own fix: none.
// req: { source, quote } of a verified linked requirement, or null. Bounded (about 3 KB), so the comment trailer can never push a comment over the limit.
function agentPrompt(f, req) {
  if (f.kind === 'standard') return '';
  const body = String(f.body), code = [...body.matchAll(FENCED)][0]?.[2];
  const prose = body.replace(FENCED, '').replace(/\n{3,}/g, '\n\n').trim();
  const parts = [`File: ${oneLine(String(f.path).replace(/\s+/g, ' '), 200)}:${f.line}`, `Gap: ${oneLine(String(f.title).replace(/\s+/g, ' ').trim(), 200)}\n${truncate(prose, 700)}`];
  if (req && req.quote) parts.push(`Requirement (${oneLine(norm(req.source), 100)}): "${oneLine(norm(req.quote), 400)}"`);
  if (code && code.length <= 1500) parts.push(`Test skeleton:\n${fence('', code)}`);
  parts.push(AGENT_RULE);
  return `\n\n<details><summary>Prompt for a coding agent</summary>\n\n${fence('text', neutralize(parts.join('\n\n')))}\n</details>`;
}

function commentBody(f, fp, inline = true, req = null) {
  const why = neutralize(`kind: ${f.kind}, confidence: ${f.confidence}${f.rule_source ? `, rule: ${f.rule_source}` : ''}`);
  // the trailer (suggestion, agent prompt, rationale, rating hint, fingerprint marker) is never cut: only the model's own text is truncated
  const trailer = `${fix(f, inline)}${agentPrompt(f, req)}\n\n<details><summary>Why this was flagged</summary>\n\n${why}\n</details>\n\n<sub>Useful? React 👍 / 👎.</sub>\n\n<!-- specguard:fp=${fp} -->`;
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
  for (const k of ['totalNanoAiu', 'totalApiDurationMs']) if (both(a[k], b[k])) out[k] = add(a[k], b[k]);
  if (ok(a.tokenDetails) || ok(b.tokenDetails)) out.tokenDetails = Object.fromEntries(['input', 'cache_read', 'cache_write', 'output'].map((k) => [k, { tokenCount: add(a.tokenDetails?.[k]?.tokenCount, b.tokenDetails?.[k]?.tokenCount) }]));
  const ma = ok(a.modelMetrics) ? a.modelMetrics : {}, mb = ok(b.modelMetrics) ? b.modelMetrics : {};
  out.modelMetrics = Object.fromEntries([...new Set([...Object.keys(ma), ...Object.keys(mb)])].map((n) => [n, { usage: sum(ma[n]?.usage, mb[n]?.usage, ['inputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'outputTokens']) }]));
  return out;
}
// One small-print line: engine, model(s), tokens, cost, API time, then `notes` (effort, model fallback, JSON repair). `raw` is the engine's usage JSON (copilot --usage-output-file, or claude --output-format json) or null; only numbers and model names are read from it.
function usageLine({ engine, model, raw, notes = [] }) {
  const tok = (i, cr, cw, o) => { i = (fin(i) ?? 0) + (fin(cr) ?? 0) + (fin(cw) ?? 0); return { i, c: fin(cr) ?? 0, o: fin(o) ?? 0 }; };
  const show = (t) => `${kM(t.i)} in${t.c ? ` (${kM(t.c)} cached)` : ''} · ${kM(t.o)} out`;
  let models = [], total, usd, credits, ms, timeLabel = 'API time';
  const u = raw && typeof raw === 'object' ? raw : {};
  if (engine === 'copilot') {
    for (const [n, m] of Object.entries(u.modelMetrics || {})) { const x = m?.usage; if (x) models.push({ n, t: tok(x.inputTokens, x.cacheReadTokens, x.cacheWriteTokens, x.outputTokens) }); }
    const d = u.tokenDetails; if (d) total = tok(d.input?.tokenCount, d.cache_read?.tokenCount, d.cache_write?.tokenCount, d.output?.tokenCount);
    if (fin(u.totalNanoAiu) !== undefined) { credits = u.totalNanoAiu / 1e9; usd = credits * USD_PER_AI_CREDIT; }
    ms = fin(u.totalApiDurationMs);
    if (!models.length && typeof u.currentModel === 'string') models = [{ n: u.currentModel }];
  } else if (engine === 'claude') {
    for (const [n, m] of Object.entries(u.modelUsage || {})) if (m) models.push({ n, t: tok(m.inputTokens, m.cacheReadInputTokens, m.cacheCreationInputTokens, m.outputTokens), usd: fin(m.costUSD) });
    const x = u.usage; if (x) total = tok(x.input_tokens, x.cache_read_input_tokens, x.cache_creation_input_tokens, x.output_tokens);
    usd = fin(u.total_cost_usd) ?? (models.some((m) => m.usd !== undefined) ? models.reduce((a, m) => a + (m.usd || 0), 0) : undefined);
    ms = fin(u.duration_api_ms); if (ms === undefined) { ms = fin(u.duration_ms); timeLabel = 'Time'; }
  }
  const nm = (s) => cell(s, 80);
  const parts = [`Engine: ${nm(engine)}`];
  if (models.length > 1) parts.push(`Models: ${models.map((m) => `${nm(m.n)}${m.t ? ` (${show(m.t)})` : ''}`).join(', ')}`);
  else {
    const n = models[0]?.n || model;
    if (n) parts.push(`Model: ${nm(n)}${models[0]?.n && model && models[0].n !== model && !notes.some((x) => x.startsWith('model_fallback')) ? ` (requested ${nm(model)})` : ''}`);
    const t = total || models[0]?.t;
    if (t) parts.push(`Tokens: ${show(t)}`);
  }
  if (usd !== undefined) parts.push(`Cost ${engine === 'copilot' ? '≈ ' : ''}$${usd.toFixed(usd < 0.01 ? 4 : 2)}${credits !== undefined ? ` (${credits.toFixed(credits < 10 ? 2 : 1)} AI credits)` : ''}`);
  if (ms !== undefined) parts.push(`${timeLabel} ${ms < 6e4 ? `${(ms / 1e3).toFixed(1)}s` : `${Math.floor(ms / 6e4)}m${String(Math.round((ms % 6e4) / 1e3)).padStart(2, '0')}s`}`);
  for (const x of notes) parts.push(nm(x));
  return `<sub>${parts.join(' · ')}</sub>`;
}
// Fix-through telemetry (0 tokens). The outcome of an earlier finding, conservatively: nothing here is ever "fixed", only observed.
//   dismissed: a human resolved the thread with the anchor untouched, or more 👎 than 👍 (people other than us)
//   open: reported again; addressed: not reported and the anchored lines changed since the comment; not_observed: not reported, anchor untouched or unknown (could be a miss)
const outcome = (p) => ((p.thread === 'human' && p.anchor_touched === false) || p.down > p.up ? 'dismissed' : p.still_reported ? 'open' : p.anchor_touched === true ? 'addressed' : 'not_observed');
const COUNTS_MAX = 8192;
// Hidden machine-readable line in the sticky summary. `outcomes` drops its oldest entries first to stay under COUNTS_MAX; the tally in `since` always covers all of them.
function countsComment(c) {
  const o = { ...c, outcomes: [...(c.outcomes || [])] };
  const json = () => JSON.stringify(o).replace(/[<>]/g, (ch) => (ch === '<' ? '\\u003c' : '\\u003e')).replace(/--/g, '-\\u002d'); // can never close the HTML comment
  while (json().length > COUNTS_MAX && o.outcomes.length) { o.outcomes.shift(); o.dropped = (o.dropped || 0) + 1; }
  return `<!-- specguard:counts ${json()} -->`;
}
// Collapsed list of what the review read. Paths are repo-relative and come from the collector, not the model.
function sourcesRead({ reqDocs = [], standards = [], trace, head, base, rejected = [] }) {
  const list = (a) => (a.length ? a.slice(0, 15).map((x) => `\`${cell(x)}\``).join(', ') + (a.length > 15 ? `, +${a.length - 15} more` : '') : 'none');
  // candidate documents the collector looked at and did not admit as requirements: [path, reason]
  const rej = rejected.slice(0, 10).map(([p, why]) => `- Considered, not admitted: \`${cell(p)}\` — ${cell(why)} (add to \`requirements_paths\` to include)\n`).join('') + (rejected.length > 10 ? `- +${rejected.length - 10} more considered, not admitted\n` : '');
  return `<details><summary>Sources read</summary>\n\n- Requirement documents: ${list(reqDocs)}\n- Standards files: ${list(standards)}\n- Trace: ${cell(trace)}\n${rej}- Commits: head \`${cell(String(head).slice(0, 7))}\`, base \`${cell(String(base).slice(0, 7))}\`\n\n</details>\n`;
}
// One compact result line for a finding: where it is, what it is, why, linked to its inline comment when posted (else to the blob line).
const sentence = (s) => { const t = neutralize(String(s)).replace(/```[\s\S]*?```/g, ' ').replace(/\s+/g, ' ').trim(); return oneLine((/^.*?[.!?](?=\s|$)/.exec(t) || [t])[0], 200); };
const parens = (u) => u.replace(/[()]/g, (c) => `%${c.charCodeAt(0).toString(16)}`);
const compact = (f, url, blob) => {
  const label = neutralize(`${f.path}:${f.line}`).replace(/[\[\]]/g, '');
  const to = /^https:\/\//.test(url || '') ? parens(url) : blob ? parens(`${blob}/${String(f.path).split('/').map(encodeURIComponent).join('/')}#L${f.line}`) : '';
  return `- **${title1(f.title)}** — ${to ? `[${label}](${to})` : `\`${cell(`${f.path}:${f.line}`)}\``} · ${cell(f.kind)} · ${sentence(f.body)}\n`;
};
// The one-line verdict: results in goal order (unit tests, requirements, standards, layering). Counts cover every finding of this run, wherever it was delivered.
function verdict(data, fs_) {
  const n = (k) => fs_.filter((f) => f.kind === k).length;
  const covById = new Map(data.coverage.map((c) => [c.id, c]));
  const ok = data.requirements.filter((r) => r.obligation_ids.length && r.obligation_ids.every((id) => covById.get(id)?.status === 'covered')).length;
  const std = data.standards.status === 'checked' ? (n('standard') ? `${n('standard')} finding${n('standard') === 1 ? '' : 's'}` : 'confirmed') : data.standards.status === 'no_rules' ? 'no rules' : 'not reviewed';
  return [`Unit tests: ${n('missing_test')} missing, ${n('weak_test')} weak`, data.requirements.length && `Requirements: ${ok}/${data.requirements.length} criteria with unit evidence${n('spec_mismatch') ? `, ${n('spec_mismatch')} spec mismatch` : ''}`, `Standards: ${std}`, `Pushdown: ${data.layering.status === 'checked' ? n('pushdown') : 'not reviewed'}`].filter(Boolean).join(' · ');
}
// Sections in goal order, which is also the importance order: unit test gaps, requirements, standards, layers, completeness, then collapsed reference
// material. Each section's items are added while they fit under the comment limit; what does not fit is counted, never cut mid-item, and the summary says so.
// posted: [{ f, url }] findings delivered as a comment (or already posted earlier); items: [{ f, why }] findings that carry their full text here.
function buildSummary({ status, data, tooling = data?.tooling, items = [], posted = [], delivery, prov, partial, engine, model, usage, notes, rules = [], blob, specFiles, pre = [], traceNote, headSha, manifest, incomplete = [], counts, resolveNote }) {
  const all = [...posted.map((x) => x.f), ...items.map((x) => x.f)];
  if (data && !status) status = `${incomplete.length ? 'Incomplete review (see below). ' : ''}${gapFree(data) && reqChanged(data) ? 'Requirement changed in this PR — review it. ' : ''}${verdict(data, all)}`;
  // hidden: the preflight skips a rerun on a head SHA that already has a completed summary (never written for a failed run)
  let head = `<!-- specguard:summary -->\n${/^\w+$/.test(headSha || '') ? `<!-- specguard:head=${headSha} -->\n` : ''}${counts ? `${countsComment(counts)}\n` : ''}## SpecGuard\n\n${neutralize(status)}${prov ? `\n\n${neutralize(prov)}.` : ''}\n\n`;
  if (incomplete.length) head += `> **Incomplete review.** Not everything was covered; verified findings are still listed, no threads were auto-resolved, and the next push or rerun reviews again.\n${incomplete.map((r) => `> - ${cell(r)}`).join('\n')}\n\n`;
  if (partial) head += '> Partially reviewed: the diff exceeded `max_diff_kb` and was truncated.\n\n';
  if (rules.length) head += `> This PR modifies review rule or agent-config files (${rules.map((x) => cell(x)).join(', ')}); they were not reviewed, and the base versions were applied.\n\n`;
  if (traceNote) head += `> Traceability unavailable for this PR (${cell(traceNote)}).\n\n`;
  const sn = counts && counts.complete && counts.since;
  if (sn && counts.since_total) head += `<sub>Since earlier reviews: ${sn.addressed} addressed · ${sn.open} still open · ${sn.dismissed} dismissed · ${sn.not_observed} not observed (not proof of a fix)</sub>\n\n`;
  if (resolveNote) head += `<sub>Threads for findings no longer reported were left open: ${resolveNote} (see README, resolve_stale).</sub>\n\n`;
  const sections = []; // { g: group heading, h, atoms, tail }
  let g = '';
  const add = (h, atoms = [], tail = '') => sections.push({ g, h, atoms, tail });
  const of = (kinds) => [...posted.filter((x) => kinds.includes(x.f.kind)).map((x) => compact(x.f, x.url, blob)), ...items.filter((x) => kinds.includes(x.f.kind)).map((x) => `${item(x)}\n`)];
  const toolingAdd = () => add(`**Standards tooling: ${cell(tooling.status)}.** Commit: ${cell(tooling.ref || 'not selected')}. ${cell(tooling.reason || '')}\n\n`,
    (tooling.checks || []).map((c) => `- ${cell(c.name)}: ${cell(c.state)}; producer: ${cell(c.producer || 'unknown')}${/^https:\/\//.test(c.url) ? ` — [run](${c.url.replace(/[()]/g, (s) => encodeURIComponent(s))})` : ''}\n`), '\n');
  const appendix = [];
  const reference = (h, atoms, tail) => appendix.push({ g: '', h, atoms, tail });
  g = '### Unit test gaps\n\n';
  add('', of(['missing_test', 'weak_test']), '\n');
  if (data) {
    const covById = new Map(data.coverage.map((c) => [c.id, c]));
    g = '### Requirements\n\n';
    add(`**Requirements source:** ${cell(data.requirements_source)}\n\n`);
    if (reqChanged(data)) add('> Requirement changed in this PR: consistency with the changed text does not prove the change itself is approved.\n\n');
    if (data.requirements.length) {
      const assessed = data.requirements.filter((r) => r.obligation_ids.length), open = data.requirements.filter((r) => !r.obligation_ids.length);
      const shown = [...assessed, ...open.slice(0, MAX_ROWS)];
      add('| Criterion | Source / original wording | Obligations | Assessment |\n|---|---|---|---|\n',
        shown.map((r) => `| ${cell(r.id, 40)} | ${cell(`${r.source}: ${r.quote}`, 500)} | ${cell(r.obligation_ids.join(', ') || 'NOT ASSESSED')} | ${cell(`${met(r, covById)}${r.reason}`, 400)} |\n`),
        open.length > MAX_ROWS ? `\n_+${open.length - MAX_ROWS} more NOT ASSESSED criteria not shown._\n\n` : '\n');
    }
    add('', of(['spec_mismatch']), '\n');
    if (!data.coverage.length) add('**No obligations assessed.** This is not evidence that tests are sufficient.\n\n');
    if (specFiles && !specFiles.length && !traceNote) add('No requirement documents found (content-based discovery; see `requirements_paths` to add or exclude).\n\n');
    g = '### Coding standards\n\n';
    add(`**Coding standards: ${cell(data.standards.status)}.** ${cell(data.standards.reason)} Sources: ${cell(data.standards.sources.join(', ') || 'none')}.\n\n`, of(['standard']), '\n');
    if (tooling) toolingAdd();
    g = '### Test layers\n\n';
    add(`**Test layers: ${cell(data.layering.status)}.** ${cell(data.layering.reason)}\n\n`, of(['pushdown']), '\n');
    g = '';
    if (data.not_reviewed) add(`**Not reviewed:** ${neutralize(data.not_reviewed)}\n\n`);
  } else if (tooling) {
    g = '### Coding standards\n\n';
    toolingAdd();
    g = '';
  }
  if (engine) add(`${usageLine({ engine, model, raw: usage, notes })}\n\n`);
  if (delivery) add(`<sub>Comments: ${neutralize(delivery)}</sub>\n\n`);
  if (data) {
    const covById = new Map(data.coverage.map((c) => [c.id, c]));
    if (data.coverage.length) {
      reference(`<details><summary>Obligations (${data.coverage.length})</summary>\n\n| Obligation | Source / behaviour | Assertion evidence / layer | Status / reason |\n|---|---|---|---|\n`,
        data.coverage.map((c) => `| ${cell(`${c.id}: ${c.obligation}`, 500)} | ${cell(`${c.source}; ${c.behaviour ? `${c.behaviour.path}:${c.behaviour.line} — ${c.behaviour.quote}` : 'implementation not located'}`, 500)} | ${cell(c.evidence.map((e) => `${e.layer}: ${e.path}:${e.line} — ${e.quote} (${e.kind}; ${e.proves})`).join('; ') || 'none', 800)} | ${cell(`${c.status}: ${c.reason}`, 500)} |\n`), '\n</details>\n\n');
    }
    const t = traceTable(data, blob, specFiles, covById);
    if (t) reference(`<details><summary>Traceability (${t.atoms.length})</summary>\n\n${t.head}`, t.atoms, '\n</details>\n\n');
  }
  if (pre.length) reference('<details><summary>Pre-existing drift (not caused by this PR)</summary>\n\n', pre.map((f) => `${item({ f })}\n`), '</details>\n\n');
  const vn = data?.validation_notes || [];
  if (vn.length) reference(`<details><summary>Validation notes (${vn.length})</summary>\n\n`, vn.map((m) => `- ${neutralize(m).replace(/\s*\n\s*/g, ' ')}\n`), '</details>\n\n');
  sections.push(...appendix);
  const RESERVE = 200; // for the closing "(truncated)" line
  let out = head, cut = false, lastG = '';
  for (const { g: grp, h, atoms, tail } of sections) {
    if (!atoms.length && !h) continue; // no findings of this kind
    const gh = grp && grp !== lastG ? grp : '';
    let body = '', n = 0;
    for (const a of atoms) { if (out.length + gh.length + h.length + body.length + a.length + tail.length + RESERVE > BODY_MAX) break; body += a; n++; }
    if (n < atoms.length || (!atoms.length && out.length + gh.length + h.length + RESERVE > BODY_MAX)) {
      cut = true;
      if (!n) continue;
      body += `_+${atoms.length - n} more not shown._\n`;
    }
    out += gh + h + body + tail;
    if (gh) lastG = grp;
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
    const { change } = c, fails = []; // every citation is checked (locate corrects lines in place); the failures are named
    const check = (label, x, pass) => { if (!pass) fails.push(`${label} ${x.path}:${x.line}`); };
    if (change) check('changed line', change, reviewable.has(change.path) && locate(change, changed(change), keys(change)));
    if (c.behaviour) check('behaviour', c.behaviour, exact(c.behaviour));
    c.evidence.forEach((e, i) => check(`evidence ${i + 1}`, e, exact(e)));
    if (fails.length) {
      const why = `could not verify citation: ${fails.join('; ')}`;
      c.status = 'unknown';
      c.reason = `Could not verify the citation: ${fails.join('; ')}.`;
      c.alignment = unknownAlign(`A citation could not be verified (${fails.join('; ')}).`);
      (data.validation_notes ||= []).push(`Obligation ${c.id} marked unknown: ${why}.`);
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
  const invalid = new Map(), unassessed = []; // invalid: obligation id -> the requirement citation that failed
  const fail = (r, why) => r.obligation_ids.forEach((id) => invalid.set(id, `requirement ${r.id} ${r.source}${r.line ? `:${r.line}` : ''}: ${why}`));
  const texts = new Map(); // normalised once per source, not once per criterion
  const textOf = (key, get) => { if (!texts.has(key)) { const text = get(); texts.set(key, { text, n: norm(text) }); } return texts.get(key); };
  const byId = new Map(data.requirements.map((r) => [r.id, r]));
  const docs = new Map();
  for (const d of context.documents || []) if (!docs.has(d.source)) docs.set(d.source, d);
  for (const expected of context.criteria || []) {
    const r = byId.get(expected.id);
    if (!r) { if (!expected.optional) data.requirements.push({ id: expected.id, source: expected.source, quote: expected.quote, ...(expected.ref && { ref: expected.ref }), ...(expected.line && { line: expected.line }), obligation_ids: [], reason: 'Structured acceptance criterion was not assessed.' }); } // optional (history) criteria are never re-added
    else if (!(r.source === expected.source || r.source.startsWith(`${expected.source} AC `) && /^\d+$/.test(r.source.slice(expected.source.length + 4))) || norm(r.quote) !== norm(expected.quote)) {
      fail(r, 'its ID did not match the collected source text');
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
      if (rejected || !context.unavailable) fail(r, rejected ? 'not a collected requirement document' : 'quote not found in its source'); // no status file: citations that verify on their own keep their findings
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

// All review threads (first 300), each { id, isResolved, resolvedBy, comments: { nodes: [first two] } }. Throws on a GraphQL error.
const THREADS_Q = 'query($o:String!,$r:String!,$n:Int!,$a:String){repository(owner:$o,name:$r){pullRequest(number:$n){reviewThreads(first:100,after:$a){pageInfo{hasNextPage endCursor}nodes{id isResolved resolvedBy{login __typename} comments(first:2){nodes{author{login __typename} body}}}}}}}';
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

// Did the diff from `from` to `to` change a line of the old side of `file` in [start, end]? true / false, or null when git cannot say
// (commit not fetched, shallow clone, file deleted or renamed: that is not evidence about the anchor). Whitespace-only edits do not count.
function anchorTouched(from, to, file, start, end, cwd, git = (...a) => execFileSync('git', a, { cwd, encoding: 'utf8', maxBuffer: 1 << 26 })) {
  if (!/^[0-9a-f]{7,64}$/i.test(String(from)) || !file || !(end >= 1)) return null;
  try {
    const d = git('diff', '-U0', '-w', '--no-color', '--no-ext-diff', '--no-renames', from, to, '--', file);
    if (/^(?:deleted file mode|\+\+\+ \/dev\/null)/m.test(d)) return null;
    for (const m of d.matchAll(/^@@ -(\d+)(?:,(\d+))? \+/gm)) {
      const a = +m[1], n = m[2] === undefined ? 1 : +m[2]; // n === 0: pure insertion after old line a
      if (n ? a <= end && a + n - 1 >= start : a >= start && a < end) return true;
    }
    return false;
  } catch { return null; }
}

// One record per earlier SpecGuard finding (priors: Map fp -> REST review comment, oldest first). Only called on a complete run:
// `survive` is then every fingerprint still reported. Each lookup failing degrades that field to unknown, never the run.
async function followUp({ github, core, owner, repo, number, priors, survive, me, headSha, cwd, threads }) {
  const byFp = new Map();
  for (const th of threads || []) {
    const c = th.comments.nodes[0], m = c && ours(c.author, me) && /<!-- specguard:fp=([0-9a-f]{40}) -->\s*$/.exec(c.body || '');
    if (m) byFp.set(m[1], th);
  }
  const out = [];
  for (const [fp, c] of [...priors].slice(-HARD_CAP)) {
    let up = 0, down = 0;
    const roll = c.reactions || {}, n = (k) => (Number.isInteger(roll[k]) ? roll[k] : 0);
    if (n('+1') || n('-1')) {
      try { // our own 👍/👎 (G2) are not feedback
        for (const r of await github.paginate(github.rest.reactions.listForPullRequestReviewComment, { owner, repo, comment_id: c.id, per_page: 100 })) {
          if (ours(r.user, me)) continue;
          if (r.content === '+1') up++; else if (r.content === '-1') down++;
        }
      } catch { [up, down] = [Math.max(0, n('+1') - 1), Math.max(0, n('-1') - 1)]; } // assume our own pair is in the rollup
    }
    const th = byFp.get(fp);
    const link = /\]\(https?:\/\/[^)\s]*\/blob\/[0-9a-f]+\/[^)\s]*#L(\d+)(?:-L(\d+))?\)/.exec(c.body || ''); // a file-level comment names its lines only in this link
    const end = c.original_line ?? (link ? +(link[2] || link[1]) : null), start = c.original_start_line ?? (link ? +link[1] : end);
    const rec = {
      fp, kind: (/kind: (\w+), confidence/.exec(c.body || '') || [])[1] || null, still_reported: survive.has(fp),
      anchor_touched: anchorTouched(c.original_commit_id, headSha, c.path, start, end, cwd),
      thread: !th ? 'unknown' : !th.isResolved ? 'open' : th.resolvedBy && ours(th.resolvedBy, me) ? 'specguard' : 'human', up, down,
    };
    out.push({ ...rec, outcome: outcome(rec) });
  }
  return out;
}

// Adds 👍 and 👎 from our token to each new comment (the review's comments, then file-level ones) so a reviewer can rate it with one click.
// Stops at the first failure (a rate limit would repeat); any failure is a warning, never a run failure.
async function react({ github, core, owner, repo, number, reviewId, ids = [] }) {
  try {
    const all = [...(reviewId ? (await github.paginate(github.rest.pulls.listCommentsForReview, { owner, repo, pull_number: number, review_id: reviewId, per_page: 100 })).map((c) => c.id) : []), ...ids];
    for (const comment_id of all) for (const content of ['+1', '-1']) await github.rest.reactions.createForPullRequestReviewComment({ owner, repo, comment_id, content });
  } catch (e) { core.warning(`SpecGuard: could not add 👍/👎 reactions: ${e.message}`); }
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
  const readCtx = (n) => { try { return fs.readFileSync(path.join(ctx, n), 'utf8'); } catch { return null; } };
  let usage = null; // engine usage JSON (tokens, cost); shown on every summary that ran the engine, including failed runs
  try { usage = JSON.parse(readCtx(engine === 'claude' ? 'claude.json' : 'usage.json')); } catch { /* no usage data */ }
  if (engine === 'copilot') try { usage = mergeUsage(usage, JSON.parse(readCtx('usage-repair.json'))); } catch { /* no repair turn */ }
  const repair = (readCtx('engine-repair') || '').trim();
  const notes = [...(readCtx('engine-notes') || '').split('\n').map((x) => x.trim()).filter(Boolean).slice(0, 4), ...(repair === 'repaired' ? ['JSON repaired in one extra turn'] : repair === 'repair_failed' ? ['JSON repair turn failed'] : [])]; // written by the engine step, never by the model
  const failed = (why) => publish(buildSummary({ rules, status: `Could not complete: ${why}`, tooling, engine, model, usage, notes, partial }));
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

  const known = new Set(), priors = new Map(); // priors: fp -> our latest earlier comment with it, oldest first
  let withheld = ''; // why inline comments cannot be posted safely
  try {
    const me = await actor();
    for (const c of await github.paginate(github.rest.pulls.listReviewComments, { owner, repo, pull_number: pr.number, per_page: 100 })) {
      const m = /<!-- specguard:fp=([0-9a-f]{40}) -->\s*$/.exec(c.body || ''); // the marker is always last; outdated comments have line=null: fingerprint only
      if (m && ours(c.user, me)) { known.add(m[1]); priors.delete(m[1]); priors.set(m[1], c); }
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
  const reqFor = (f) => data.requirements.find((r) => r.obligation_ids.some((id) => (f.obligation_ids || []).includes(id))) || null; // a linked requirement (its quote is verified)
  const comments = p.inline.map((f) => ({
    path: f.path, line: f.line, side: 'RIGHT', body: commentBody(f, f.fp, true, reqFor(f)),
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
  let reviewId; // the posted review: its comments get the 👍/👎 reactions
  const fileIds = [];
  const urls = new Map(); // fp -> link to our comment, for the result lines in the summary
  for (const [fp, c] of priors) if (c.html_url) urls.set(fp, c.html_url);
  if (!stop && comments.length) {
    const post = (body, cs) => github.rest.pulls.createReview({ owner, repo, pull_number: pr.number, commit_id: headSha, event: 'COMMENT', body: clean(body), ...(cs && { comments: cs }) });
    try {
      reviewId = (await post(head, comments))?.data?.id;
      try { for (const c of await github.paginate(github.rest.pulls.listCommentsForReview, { owner, repo, pull_number: pr.number, review_id: reviewId, per_page: 100 })) { const m = /<!-- specguard:fp=([0-9a-f]{40}) -->\s*$/.exec(c.body || ''); if (m && c.html_url) urls.set(m[1], c.html_url); } } catch { /* the blob line is the fallback link */ }
    }
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
      const r = await github.rest.pulls.createReviewComment({ owner, repo, pull_number: pr.number, commit_id: headSha, path: f.path, subject_type: 'file', body: commentBody({ ...f, body: `${f.body}\n\n[${f.path}:${f.line}](${link})` }, f.fp, false, reqFor(f)) });
      if (r?.data?.id) fileIds.push(r.data.id);
      if (r?.data?.html_url) urls.set(f.fp, r.data.html_url);
    } catch (e) { core.warning(`SpecGuard: file-level comment failed: ${e.message}`); unanchored.push({ f, why: 'could not post' }); filed--; }
  }
  if (reviewId || fileIds.length) await react({ github, core, owner, repo, number: pr.number, reviewId, ids: fileIds });

  // Fix-through telemetry. Only a complete run can say an earlier finding is no longer reported: otherwise counts only (complete:false, no outcomes).
  const complete = !incomplete.length && !degraded;
  const me = await actor();
  let threads, outcomes = [];
  if (complete && priors.size) {
    try { threads = await fetchThreads({ github, owner, repo, number: pr.number }); }
    catch (e) { core.warning(`SpecGuard: review threads could not be read for telemetry: ${e.message}`); }
    outcomes = await followUp({ github, core, owner, repo, number: pr.number, priors, survive, me, headSha, cwd: root, threads });
  }
  const byKind = {};
  const tally = (list, k) => list.forEach((f) => { (byKind[f.kind] ||= { posted: 0, already: 0, summary: 0 })[k]++; });
  const unplaced = new Set(unanchored.map((x) => x.f));
  tally(merged.filter((f) => known.has(f.fp)), 'already');
  tally([...p.inline, ...p.file].filter((f) => !unplaced.has(f)), 'posted');
  tally([...p.summary, ...unanchored].map((x) => x.f), 'summary');
  const since = { addressed: 0, open: 0, dismissed: 0, not_observed: 0 };
  for (const o of outcomes) since[o.outcome]++;
  const tele = { v: 1, head: headSha, engine: engine || 'n/a', complete, findings: byKind, pre_existing: preExisting.length, posted: { inline, file: filed }, already, since, since_total: outcomes.length, outcomes };
  const resolveNote = !stop && complete && env.RESOLVE_STALE !== 'false' ? await resolveStale({ github, core, owner, repo, number: pr.number, current: survive, actor: me, threads }) : undefined;

  const clean_ = noGaps(data) && !incomplete.length;
  const placed = [...merged.filter((f) => known.has(f.fp)), ...[...p.inline, ...p.file].filter((f) => !unplaced.has(f))].map((f) => ({ f, url: urls.get(f.fp) }));
  await publish(buildSummary({ status: clean_ ? 'No test gaps found in the assessed obligations.' : undefined, prov, delivery: counts(), traceNote, data, posted: placed, items: [...p.summary, ...unanchored], rules, incomplete, engine, model, usage, notes, specFiles, pre: preExisting, blob: `${context.serverUrl}/${owner}/${repo}/blob/${headSha}`, resolveNote, headSha: incomplete.length ? undefined : headSha, // no head marker: the preflight must retry an incomplete run
    manifest: { reqDocs: specFiles || [], standards: smap ? [...smap.keys()] : [...standards], trace: traceNote ? 'unavailable' : traceStatus === 'off' ? 'off' : specFiles?.length ? 'spec found' : 'SPEC_NOT_FOUND', head: headSha, base,
    rejected: (readCtx('spec-rejected.txt') || '').split('\n').filter(Boolean).map((l) => { const i = l.indexOf('\t'); return i < 0 ? [l, 'not admitted'] : [l.slice(0, i), l.slice(i + 1)]; }) }, counts: tele }));
}

module.exports = async (a) => {
  try { await run(a); } catch (e) { a.core.warning(`SpecGuard post failed: ${e.message}`); }
};
Object.assign(module.exports, { agentPrompt, outcome, anchorTouched, countsComment, placeholder, skeletonGate, definedNames, definesUsedBy, parsePatch, parseDiff, validate, anchor, snap, ruleLine, merge, plan, fingerprint, redact, truncate, buildSummary, usageLine, mergeUsage, commentBody, axes, proven, noGaps, verifyEvidence, verifyRequirements, settle, differential, reflect, renameMaps, quoteLine, neutralize, markChanged, readFile, safeRel });
