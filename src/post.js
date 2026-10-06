// Validates, filters, anchors and posts an advisory review. Never blocks the PR.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { inspectChecks } = require('./checks');

const KINDS = ['missing_test', 'weak_test', 'standard', 'pushdown'];
const STATUSES = ['covered', 'weak_test', 'missing_test', 'higher_level_only', 'needs_human', 'unknown'];
const FILE_CAP = 3, HARD_CAP = 30, BODY_MAX = 65000;
const SECRET = /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-ant-[A-Za-z0-9_-]{20,})/g;

const redact = (s) => String(s).replace(SECRET, '[REDACTED]');
const truncate = (s, n = BODY_MAX) => (s.length > n ? s.slice(0, n - 20) + '\n...(truncated)' : s);
const clean = (s) => truncate(redact(s));

// line -> hunk index per side. RIGHT: '+' and ' ' lines, LEFT: '-' lines.
function parsePatch(patch) {
  const m = { RIGHT: new Map(), LEFT: new Map(), changed: { RIGHT: new Map(), LEFT: new Map() } };
  let h = -1, l = 0, r = 0;
  for (const ln of String(patch || '').split('\n')) {
    const hd = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(ln);
    if (hd) { h++; l = +hd[1]; r = +hd[2]; continue; }
    if (h < 0 || ln === '' || ln[0] === '\\') continue;
    if (ln[0] === '+') { m.changed.RIGHT.set(r, ln.slice(1)); m.RIGHT.set(r++, h); }
    else if (ln[0] === '-') { m.changed.LEFT.set(l, ln.slice(1)); m.LEFT.set(l++, h); }
    else { m.RIGHT.set(r++, h); l++; }
  }
  return m;
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
    if (c.status === 'missing_test' && c.evidence.some((e) => e.kind === 'assertion')) return 'missing_test cannot claim assertion evidence';
    if (!c.change && !['unknown', 'needs_human'].includes(c.status)) return 'needs a changed-line citation';
    return '';
  };
  const ids = new Set(), rows = [];
  for (const [i, c] of o.coverage.entries()) {
    if (!c || typeof c !== 'object' || !text(c.id) || ids.has(c.id)) { notes.push(`Dropped coverage[${i}]: missing or duplicate id.`); continue; }
    ids.add(c.id);
    const why = rowError(c);
    if (!why) { rows.push(c); continue; }
    notes.push(`Obligation ${c.id} marked unknown: ${why}.`);
    rows.push({ id: c.id, obligation: text(c.obligation) ? c.obligation : '(not stated)', source: text(c.source) ? c.source : '(not stated)',
      behaviour: citation(c.behaviour) ? c.behaviour : null, change: citation(c.change) ? c.change : null, evidence: [], status: 'unknown', reason: `Malformed coverage row: ${why}.` });
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
    const expected = { missing_test: 'missing_test', weak_test: 'weak_test', pushdown: 'higher_level_only' }[f.kind];
    if (expected && f.obligation_ids.some((id) => status(id) !== expected)) return 'contradicts coverage';
    if (f.kind === 'standard' && o.standards.status !== 'checked') return 'standards were not reviewed';
    if (f.kind === 'pushdown' && o.layering.status !== 'checked') return 'layering was not reviewed';
    return '';
  };
  let kept = [];
  for (const [i, f] of o.findings.entries()) {
    const why = findingError(f);
    if (why) notes.push(`Dropped ${[`findings[${i}]`, ...(f && typeof f === 'object' ? [f.kind, f.path, f.title].filter(text) : [])].join(' ')}: ${why}.`);
    else kept.push(f);
  }
  const demoted = new Set();
  for (const c of rows) {
    if (['missing_test', 'weak_test'].includes(c.status) && kept.filter((f) => f.kind === c.status && f.obligation_ids.includes(c.id)).length !== 1) {
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
const AC = /^(issue (?:[\w.-]+\/[\w.-]+)?#\d+|PR body) AC \d+$/;
const fingerprint = (kind, p, quote, source) => crypto.createHash('sha1').update(`${kind}\0${p}\0${AC.test(source) ? source : norm(quote)}`).digest('hex');

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

// 1-based line of the rule text nearest to n, or 0. Never guesses.
function ruleLine(quote, lines, n) {
  const q = norm(quote || '');
  let best = 0;
  if (q) lines.forEach((l, i) => { if (norm(l).includes(q) && (!best || Math.abs(i + 1 - n) < Math.abs(best - n))) best = i + 1; });
  return best;
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
const fix = (f, inline) => (f.kind === 'standard' && typeof f.suggestion === 'string' && f.suggestion
  ? `\n\n${inline ? fence('suggestion', f.suggestion) : `Suggested fix:\n\n${fence('', f.suggestion)}`}` : '');

function commentBody(f, fp, inline = true) {
  const why = `kind: ${f.kind}, confidence: ${f.confidence}${f.rule_source ? `, rule: ${f.rule_source}` : ''}`;
  return clean(`**${f.title}**\n\n${f.body}${fix(f, inline)}\n\n<details><summary>Why this was flagged</summary>\n\n${why}\n</details>\n\n<!-- specguard:fp=${fp} -->`);
}

const axes = (fs) => { const n = (k) => fs.filter((f) => f.kind === k).length; return `Tests: ${n('missing_test')} missing, ${n('weak_test')} weak · Standards: ${n('standard')} · Layering: ${n('pushdown')}`; };
const proven = (cov) => {
  const rows = cov.filter((c) => c.status !== 'needs_human');
  return rows.length ? `Unit evidence: ${rows.filter((c) => c.status === 'covered').length}/${rows.length} obligations (static review; tests not executed)` : '';
};
const noGaps = (data) => !data.findings.length && !(data.validation_notes || []).length && data.coverage.length > 0 && !data.not_reviewed
  && data.standards.status !== 'not_reviewed' && data.layering.status === 'checked'
  && data.requirements.every((r) => r.obligation_ids.length > 0)
  && (!data.tooling || ['passed', 'not_configured'].includes(data.tooling.status))
  && data.coverage.every((c) => c.status === 'covered');

// A criterion split into several obligations is covered only when every one is.
const met = (r, cov) => {
  const n = r.obligation_ids.length, k = r.obligation_ids.filter((id) => cov.find((c) => c.id === id)?.status === 'covered').length;
  return n ? `${k}/${n} obligations covered${k < n ? ' (not fully covered)' : ''}. ` : '';
};
const cell = (s) => redact(s).replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ');
const item = ({ f, why }) => `- **${f.title}** (\`${f.path}:${f.line}\`, ${f.kind}${why ? `, ${why}` : ''})\n\n  ${redact(f.body + fix(f, false)).replace(/\n/g, '\n  ')}\n`;

function buildSummary({ status, data, tooling = data?.tooling, items = [], partial, engine, model }) {
  let s = `<!-- specguard:summary -->\n## SpecGuard\n\n${status}\n\n`;
  if (engine) s += `_Engine: ${engine}${model ? ` (${model})` : ''}_\n\n`;
  if (partial) s += '> Partially reviewed: the diff exceeded `max_diff_kb` and was truncated.\n\n';
  if (tooling) {
    s += `**Standards tooling: ${cell(tooling.status)}.** Commit: ${cell(tooling.ref || 'not selected')}. ${cell(tooling.reason || '')}\n\n`;
    for (const c of tooling.checks) s += `- ${cell(c.name)}: ${cell(c.state)}; producer: ${cell(c.producer || 'unknown')}${/^https:\/\//.test(c.url) ? ` — [run](${c.url.replace(/[()]/g, (s) => encodeURIComponent(s))})` : ''}\n`;
    s += '\n';
  }
  if (data) {
    s += `**Requirements source:** ${redact(data.requirements_source)}\n\n`;
    if (data.requirements.length) {
      s += '| Criterion | Source / original wording | Obligations | Assessment |\n|---|---|---|---|\n';
      for (const r of data.requirements) s += `| ${cell(r.id)} | ${cell(`${r.source}: ${r.quote}`)} | ${cell(r.obligation_ids.join(', ') || 'NOT ASSESSED')} | ${cell(`${met(r, data.coverage)}${r.reason}`)} |\n`;
      s += '\n';
    }
    s += `**Coding standards: ${cell(data.standards.status)}.** ${cell(data.standards.reason)} Sources: ${cell(data.standards.sources.join(', ') || 'none')}.\n\n`;
    s += `**Test layers: ${cell(data.layering.status)}.** ${cell(data.layering.reason)}\n\n`;
    if (data.coverage.length) {
      s += '| Obligation | Source / behaviour | Assertion evidence / layer | Status / reason |\n|---|---|---|---|\n';
      for (const c of data.coverage) s += `| ${cell(`${c.id}: ${c.obligation}`)} | ${cell(`${c.source}; ${c.behaviour ? `${c.behaviour.path}:${c.behaviour.line} — ${c.behaviour.quote}` : 'implementation not located'}`)} | ${cell(c.evidence.map((e) => `${e.layer}: ${e.path}:${e.line} — ${e.quote} (${e.kind}; ${e.proves})`).join('; ') || 'none')} | ${cell(`${c.status}: ${c.reason}`)} |\n`;
      s += '\n';
    } else s += '**No obligations assessed.** This is not evidence that tests are sufficient.\n\n';
    if (data.not_reviewed) s += `**Not reviewed:** ${redact(data.not_reviewed)}\n\n`;
    const vn = data.validation_notes || [];
    if (vn.length) s += `<details><summary>Validation notes (${vn.length})</summary>\n\n${vn.map((m) => `- ${redact(m).replace(/\s*\n\s*/g, ' ')}`).join('\n')}\n</details>\n\n`;
  }
  if (items.length) s += `<details><summary>${items.length} more item(s): low confidence, inferred, overflow, unanchored</summary>\n\n${items.map(item).join('\n')}\n</details>\n`;
  return clean(s);
}

const readLines = (p) => {
  try {
    const root = fs.realpathSync(process.env.GITHUB_WORKSPACE || process.cwd());
    const target = fs.realpathSync(path.resolve(root, p));
    const relative = path.relative(root, target);
    if (!relative || relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative)) return null;
    return fs.readFileSync(target, 'utf8').split('\n');
  } catch { return null; }
};

// Verifies citations, not the model's semantic judgement. Never upgrades missing evidence.
function verifyEvidence(data, reviewable, standards, read = readLines, maps = new Map()) {
  const exact = (c) => {
    if (c.side === 'LEFT') return norm(maps.get(c.path)?.changed.LEFT.get(c.line) || '') === norm(c.quote);
    const lines = read(c.path); return lines && norm(lines[c.line - 1] || '') === norm(c.quote);
  };
  for (const c of data.coverage) {
    const change = c.change;
    const inDiff = change && reviewable.has(change.path)
      && norm(maps.get(change.path)?.changed[change.side || 'RIGHT'].get(change.line) || '') === norm(change.quote);
    if ((change && !inDiff) || (c.behaviour && !exact(c.behaviour)) || c.evidence.some((e) => !exact(e))) {
      c.status = 'unknown';
      c.reason = 'Could not verify the changed-line, behaviour or test citation.';
    }
  }
  const invalid = new Set(data.coverage.filter((c) => c.status === 'unknown').map((c) => c.id));
  data.findings = data.findings.map((f) => ({ ...f, obligation_ids: f.obligation_ids.filter((id) => !invalid.has(id)) }))
    .filter((f) => f.kind === 'standard' || f.obligation_ids.length);
  if ((data.standards.status === 'no_rules' && standards.size) || data.standards.sources.some((s) => !standards.has(s))) {
    data.standards = { status: 'not_reviewed', sources: [], reason: 'The standards assessment does not match the trusted rule inventory.' };
    data.findings = data.findings.filter((f) => f.kind !== 'standard');
    (data.validation_notes ||= []).push('Standards assessment does not match the trusted rule inventory; not reviewed.');
  }
  return data;
}

function verifyRequirements(data, context, read = readLines) {
  const note = (s) => { data.not_reviewed = [data.not_reviewed, s].filter(Boolean).join(' '); };
  const invalid = new Set();
  for (const expected of context.criteria || []) {
    const r = data.requirements.find((r) => r.id === expected.id);
    if (!r) data.requirements.push({ ...expected, obligation_ids: [], reason: 'Structured acceptance criterion was not assessed.' });
    else if (!(r.source === expected.source || r.source.startsWith(`${expected.source} AC `) && /^\d+$/.test(r.source.slice(expected.source.length + 4))) || norm(r.quote) !== norm(expected.quote)) {
      r.obligation_ids.forEach((id) => invalid.add(id));
      Object.assign(r, expected, { obligation_ids: [], reason: 'Criterion ID did not match its collected source text.' });
    } else r.source = expected.source; // "PR body AC 1" is accepted; the collected label is canonical
  }
  for (const r of data.requirements) {
    const collected = (context.documents || []).find((d) => d.source === r.source);
    const text = collected ? collected.text : (read(r.source) || []).join('\n');
    if (!norm(text).includes(norm(r.quote))) {
      r.obligation_ids.forEach((id) => invalid.add(id));
      r.obligation_ids = [];
      r.reason = 'Could not verify the original criterion wording against its source.';
    }
    if (!r.obligation_ids.length) note(`Requirement ${r.id} is not assessed: ${r.reason}`);
  }
  for (const c of data.coverage) if (invalid.has(c.id)) {
    c.status = 'unknown'; c.reason = 'The linked requirement citation could not be verified.';
  }
  data.findings = data.findings.map((f) => ({ ...f, obligation_ids: f.obligation_ids.filter((id) => !invalid.has(id)) }))
    .filter((f) => f.kind === 'standard' || f.obligation_ids.length);
  return data;
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
  let livePR;
  const current = async () => { livePR = (await github.rest.pulls.get({ owner, repo, pull_number: pr.number })).data; return livePR.head.sha === headSha; };
  if (!await current()) return core.warning('SpecGuard: superseded HEAD; no results published');

  const publish = async (text) => {
    await core.summary.addRaw(text).write();
    try {
      if (!await current()) return core.warning('SpecGuard: superseded HEAD; summary not updated');
      const cs = await github.paginate(github.rest.issues.listComments, { owner, repo, issue_number: pr.number, per_page: 100 });
      const mine = cs.find((c) => c.body && c.body.includes('<!-- specguard:summary -->') && c.user && c.user.type === 'Bot');
      if (mine) await github.rest.issues.updateComment({ owner, repo, comment_id: mine.id, body: text });
      else await github.rest.issues.createComment({ owner, repo, issue_number: pr.number, body: text });
    } catch (e) { core.warning(`SpecGuard: could not post summary comment: ${e.message}`); }
  };

  if (env.SKIP === 'true') return publish(buildSummary({ status: 'Nothing to review: every changed file is ignored (lockfiles, docs, generated files).' }));
  const target = env.STANDARDS_REF || 'head';
  const ref = target === 'head' ? headSha : target === 'merge' && livePR.mergeable !== null ? livePR.merge_commit_sha : null;
  const tooling = ref ? await inspectChecks({ github, owner, repo, ref, names: env.STANDARDS_CHECKS })
    : { status: 'unavailable', ref: '', checks: [], reason: 'Configured standards ref must be head or an available current merge commit.' };
  const failed = (why) => publish(buildSummary({ status: `Could not complete: ${why}`, tooling, engine, model, partial }));

  let data;
  try { data = JSON.parse(fs.readFileSync(path.join(ctx, 'findings.json'), 'utf8')); }
  catch (e) { return failed(`no valid findings.json (${e.code || 'parse error'}); see the job log`); }
  const v = validate(data);
  if (!v.ok) return failed(`findings.json failed validation: ${v.error}`);
  data.tooling = tooling; // Always overwrite any model-supplied tooling claim.

  const maps = new Map();
  for (const f of await github.paginate(github.rest.pulls.listFiles, { owner, repo, pull_number: pr.number, per_page: 100 })) maps.set(f.filename, parsePatch(f.patch));
  const lines = (n) => { try { return fs.readFileSync(path.join(ctx, n), 'utf8').split('\n').filter(Boolean); } catch { return []; } };
  const reviewable = new Set(lines('files.txt')), standards = new Set(lines('standards.txt'));
  verifyEvidence(data, reviewable, standards, readLines, maps);
  try {
    const requirements = JSON.parse(fs.readFileSync(path.join(ctx, 'requirements-status.json'), 'utf8'));
    verifyRequirements(data, requirements);
    data.requirements_source = requirements.sources.join(', ') || 'unavailable; changed behaviour only';
    if (requirements.status !== 'available') data.not_reviewed = [data.not_reviewed, ...requirements.limitations].filter(Boolean).join(' ');
  } catch { data.not_reviewed = [data.not_reviewed, 'Requirement collection status unavailable.'].filter(Boolean).join(' '); }
  if (partial) data.not_reviewed = [data.not_reviewed, 'Diff truncated; obligations outside the reviewed portion are unknown.'].filter(Boolean).join(' ');

  const known = new Set();
  for (const c of await github.paginate(github.rest.pulls.listReviewComments, { owner, repo, pull_number: pr.number, per_page: 100 })) {
    const m = /specguard:fp=([0-9a-f]{40})/.exec(c.body || ''); // outdated comments have line=null: fingerprint only
    if (m && c.user && c.user.type === 'Bot') known.add(m[1]);
  }

  const kept = [];
  let already = 0;
  const seen = new Set();
  const assessed = [];
  const unanchored = []; // items that failed to post or anchor; they go to the summary
  for (let f of data.findings) {
    if (f.side === 'LEFT') {
      if (f.kind !== 'standard' && reviewable.has(f.path) && norm(maps.get(f.path)?.changed.LEFT.get(f.line) || '') === norm(f.quote)) {
        assessed.push(f);
        unanchored.push({ f, why: 'removed test or assertion; location is on the LEFT side of the diff' });
      } else data.not_reviewed = [data.not_reviewed, `Removed-line citation could not be verified: ${f.path}:${f.line}.`].filter(Boolean).join(' ');
      continue;
    }
    if (!maps.has(f.path) || !reviewable.has(f.path)) {
      if (f.kind !== 'standard' && snap(f, readLines(f.path)) !== null) {
        assessed.push(f);
        unanchored.push({ f, why: 'assertion outside the reviewed diff' });
      } else data.not_reviewed = [data.not_reviewed, `Finding location could not be verified: ${f.path}:${f.line}.`].filter(Boolean).join(' ');
      continue;
    }
    if (f.kind === 'standard') {
      const m = /^(.+):(\d+)$/.exec(f.rule_source || '');
      const rl = m && standards.has(m[1]) ? readLines(m[1]) : null;
      const at = rl && ruleLine(f.rule_quote, rl, +m[2]);
      if (at) f = { ...f, rule_source: `${m[1]}:${at}` };
      else if (!(f.confidence === 'low' && !f.rule_source)) {
        data.not_reviewed = [data.not_reviewed, `Unverified standards finding omitted: ${f.title}.`].filter(Boolean).join(' ');
        continue;
      }
    }
    const d = snap(f, readLines(f.path));
    if (d === null) {
      data.not_reviewed = [data.not_reviewed, `Finding citation did not match: ${f.path}:${f.line}.`].filter(Boolean).join(' ');
      continue;
    }
    const fp = fingerprint(f.kind, f.path, f.quote, f.source);
    if (seen.has(fp)) continue;
    seen.add(fp);
    assessed.push(f);
    if (known.has(fp)) already++;
    else kept.push({ ...f, line: f.line + d, ...(f.start_line !== undefined && { start_line: f.start_line + d }), fp });
  }

  const p = plan(kept, maps, maxComments);
  const comments = p.inline.map((f) => ({
    path: f.path, line: f.line, side: 'RIGHT', body: commentBody(f, f.fp),
    ...(f.start_line !== undefined && { start_line: f.start_line, start_side: 'RIGHT' }),
  }));
  const prov = proven(data.coverage);
  const counts = `${comments.length} inline, ${p.file.length} file-level, ${p.summary.length + unanchored.length} in summary${already ? `, ${already} already posted` : ''}`;
  const head = `<!-- specguard:review -->\nSpecGuard found ${axes(assessed)}; ${counts}.${prov ? `\n${prov}.` : ''}\nEngine: ${engine || 'n/a'}${model ? ` (${model})` : ''}.`;

  if (!await current()) return core.warning('SpecGuard: superseded HEAD; no review published');
  if (comments.length) {
    const post = (body, cs) => github.rest.pulls.createReview({ owner, repo, pull_number: pr.number, commit_id: headSha, event: 'COMMENT', body: clean(body), ...(cs && { comments: cs }) });
    try { await post(head, comments); }
    catch (e) {
      if (e.status === 422) {
        try { await post(`${head}\n\nInline anchors were rejected; unanchored findings:\n\n${p.inline.map((f) => item({ f })).join('\n')}`); }
        catch (e2) { core.warning(`SpecGuard: review retry failed: ${e2.message}`); }
        p.inline.forEach((f) => unanchored.push({ f, why: 'anchor rejected' }));
      } else {
        core.warning(`SpecGuard: could not post review (${e.status}): ${e.message}`);
        if (e.status === 403 || e.status === 404) p.inline.slice(0, 10).forEach((f) => core.warning(f.title, { file: f.path, startLine: f.start_line || f.line, title: `SpecGuard ${f.kind}` }));
        p.inline.forEach((f) => unanchored.push({ f, why: 'could not post' }));
      }
    }
  }
  for (const f of p.file) {
    const range = f.start_line ? `#L${f.start_line}-L${f.line}` : `#L${f.line}`;
    const link = `${context.serverUrl}/${owner}/${repo}/blob/${headSha}/${f.path}${range}`;
    try {
      await github.rest.pulls.createReviewComment({ owner, repo, pull_number: pr.number, commit_id: headSha, path: f.path, subject_type: 'file', body: commentBody({ ...f, body: `${f.body}\n\n[${f.path}:${f.line}](${link})` }, f.fp, false) });
    } catch (e) { core.warning(`SpecGuard: file-level comment failed: ${e.message}`); unanchored.push({ f, why: 'could not post' }); }
  }

  await publish(buildSummary({ status: `${noGaps(data) ? 'No test gaps found in the assessed obligations.' : `Reviewed: ${axes(assessed)}; ${counts}.`}${prov ? `\n\n${prov}.` : ''}`, data, items: [...p.summary, ...unanchored], partial, engine, model }));
}

module.exports = async (a) => {
  try { await run(a); } catch (e) { a.core.warning(`SpecGuard post failed: ${e.message}`); }
};
Object.assign(module.exports, { parsePatch, validate, anchor, snap, ruleLine, plan, fingerprint, redact, truncate, buildSummary, commentBody, axes, proven, noGaps, verifyEvidence, verifyRequirements });
