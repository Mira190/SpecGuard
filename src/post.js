// Step 3: the only step holding a write token. Validates, filters, anchors and posts. Never throws, never blocks the PR.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const KINDS = ['missing_test', 'weak_test', 'standard', 'pushdown'];
const STATUSES = ['covered', 'weak_test', 'missing_test', 'needs_human'];
const FILE_CAP = 3, HARD_CAP = 30, BODY_MAX = 65000;
const SECRET = /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-ant-[A-Za-z0-9_-]{20,})/g;

const redact = (s) => String(s).replace(SECRET, '[REDACTED]');
const truncate = (s, n = BODY_MAX) => (s.length > n ? s.slice(0, n - 20) + '\n...(truncated)' : s);
const clean = (s) => truncate(redact(s));

// line -> hunk index per side. RIGHT: '+' and ' ' lines, LEFT: '-' lines.
function parsePatch(patch) {
  const m = { RIGHT: new Map(), LEFT: new Map() };
  let h = -1, l = 0, r = 0;
  for (const ln of String(patch || '').split('\n')) {
    const hd = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(ln);
    if (hd) { h++; l = +hd[1]; r = +hd[2]; continue; }
    if (h < 0 || ln === '' || ln[0] === '\\') continue;
    if (ln[0] === '+') m.RIGHT.set(r++, h);
    else if (ln[0] === '-') m.LEFT.set(l++, h);
    else { m.RIGHT.set(r++, h); l++; }
  }
  return m;
}

// Hand-rolled mirror of findings.schema.json. ponytail: swap for ajv if the schema grows.
function validate(o) {
  const bad = (m) => ({ ok: false, error: m });
  const str = (v) => typeof v === 'string';
  const int = (v) => Number.isInteger(v) && v >= 1;
  if (!o || typeof o !== 'object' || Array.isArray(o)) return bad('not an object');
  if (!str(o.requirements_source)) return bad('requirements_source must be a string');
  if (!str(o.not_reviewed)) return bad('not_reviewed must be a string');
  if (!Array.isArray(o.coverage)) return bad('coverage must be an array');
  for (const [i, c] of o.coverage.entries()) {
    if (!c || !str(c.obligation) || !str(c.source) || !Array.isArray(c.tests) || !c.tests.every(str)) return bad(`coverage[${i}] malformed`);
    if (!STATUSES.includes(c.status)) return bad(`coverage[${i}].status invalid`);
  }
  if (!Array.isArray(o.findings)) return bad('findings must be an array');
  for (const [i, f] of o.findings.entries()) {
    if (!f || typeof f !== 'object') return bad(`findings[${i}] not an object`);
    if (!KINDS.includes(f.kind)) return bad(`findings[${i}].kind invalid`);
    if (!str(f.path) || !str(f.title) || !str(f.body) || !str(f.quote)) return bad(`findings[${i}] path/title/body/quote must be strings`);
    if (!int(f.line)) return bad(`findings[${i}].line must be an integer >= 1`);
    if (f.start_line !== undefined && !int(f.start_line)) return bad(`findings[${i}].start_line invalid`);
    if (f.suggestion !== undefined && !str(f.suggestion)) return bad(`findings[${i}].suggestion invalid`);
    if (f.rule_source !== undefined && !str(f.rule_source)) return bad(`findings[${i}].rule_source invalid`);
    if (f.rule_quote !== undefined && !str(f.rule_quote)) return bad(`findings[${i}].rule_quote invalid`);
    if (f.source !== undefined && !str(f.source)) return bad(`findings[${i}].source invalid`);
    if (!['high', 'low'].includes(f.confidence)) return bad(`findings[${i}].confidence invalid`);
  }
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
const AC = /^(issue #\d+|PR body) AC \d+$/;
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
  if (q.length >= 10) lines.forEach((l, i) => { if (norm(l).includes(q) && (!best || Math.abs(i + 1 - n) < Math.abs(best - n))) best = i + 1; });
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
  return rows.length ? `Proven: ${rows.filter((c) => c.status === 'covered').length}/${rows.length} obligations` : '';
};
// Nothing found and nothing unproven: covered and needs_human rows are not gaps.
const noGaps = (data) => !data.findings.length && data.coverage.every((c) => c.status === 'covered' || c.status === 'needs_human');

const cell = (s) => redact(s).replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ');
const item = ({ f, why }) => `- **${f.title}** (\`${f.path}:${f.line}\`, ${f.kind}${why ? `, ${why}` : ''})\n\n  ${redact(f.body + fix(f, false)).replace(/\n/g, '\n  ')}\n`;

function buildSummary({ status, data, items = [], partial, engine, model }) {
  let s = `<!-- specguard:summary -->\n## SpecGuard\n\n${status}\n\n`;
  if (engine) s += `_Engine: ${engine}${model ? ` (${model})` : ''}_\n\n`;
  if (partial) s += '> Partially reviewed: the diff exceeded `max_diff_kb` and was truncated.\n\n';
  if (data) {
    s += `**Requirements source:** ${redact(data.requirements_source)}\n\n`;
    if (data.coverage.length) {
      s += '| Obligation | Source | Tests | Status |\n|---|---|---|---|\n';
      for (const c of data.coverage) s += `| ${cell(c.obligation)} | ${cell(c.source)} | ${cell(c.tests.join(', '))} | ${c.status} |\n`;
      s += '\n';
    }
    if (data.not_reviewed) s += `**Not reviewed:** ${redact(data.not_reviewed)}\n\n`;
  }
  if (items.length) s += `<details><summary>${items.length} more item(s): low confidence, inferred, overflow, unanchored</summary>\n\n${items.map(item).join('\n')}\n</details>\n`;
  return clean(s);
}

const readLines = (p) => {
  try { return fs.readFileSync(path.join(process.env.GITHUB_WORKSPACE || process.cwd(), p), 'utf8').split('\n'); } catch { return null; }
};

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

  const publish = async (text) => {
    await core.summary.addRaw(text).write();
    try {
      const cs = await github.paginate(github.rest.issues.listComments, { owner, repo, issue_number: pr.number, per_page: 100 });
      const mine = cs.find((c) => c.body && c.body.includes('<!-- specguard:summary -->') && c.user && c.user.type === 'Bot');
      if (mine) await github.rest.issues.updateComment({ owner, repo, comment_id: mine.id, body: text });
      else await github.rest.issues.createComment({ owner, repo, issue_number: pr.number, body: text });
    } catch (e) { core.warning(`SpecGuard: could not post summary comment: ${e.message}`); }
  };

  if (env.SKIP === 'true') return publish(buildSummary({ status: 'Nothing to review: every changed file is ignored (lockfiles, docs, generated files).' }));
  const failed = (why) => publish(buildSummary({ status: `Could not complete: ${why}`, engine, model, partial }));

  let data;
  try { data = JSON.parse(fs.readFileSync(path.join(ctx, 'findings.json'), 'utf8')); }
  catch (e) { return failed(`no valid findings.json (${e.code || 'parse error'}); see the job log`); }
  const v = validate(data);
  if (!v.ok) return failed(`findings.json failed validation: ${v.error}`);

  const maps = new Map();
  for (const f of await github.paginate(github.rest.pulls.listFiles, { owner, repo, pull_number: pr.number, per_page: 100 })) maps.set(f.filename, parsePatch(f.patch));
  const lines = (n) => { try { return fs.readFileSync(path.join(ctx, n), 'utf8').split('\n').filter(Boolean); } catch { return []; } };
  const reviewable = new Set(lines('files.txt')), standards = new Set(lines('standards.txt'));

  const known = new Set();
  for (const c of await github.paginate(github.rest.pulls.listReviewComments, { owner, repo, pull_number: pr.number, per_page: 100 })) {
    const m = /specguard:fp=([0-9a-f]{40})/.exec(c.body || ''); // outdated comments have line=null: fingerprint only
    if (m) known.add(m[1]);
  }

  const kept = [];
  let already = 0;
  const seen = new Set();
  const unanchored = []; // items that failed to post or anchor; they go to the summary
  for (let f of data.findings) {
    if (!maps.has(f.path) || !reviewable.has(f.path)) continue;
    if (f.kind === 'standard') {
      const m = /^(.+):(\d+)$/.exec(f.rule_source || '');
      const rl = m && standards.has(m[1]) ? readLines(m[1]) : null;
      const at = rl && ruleLine(f.rule_quote, rl, +m[2]);
      if (at) f = { ...f, rule_source: `${m[1]}:${at}` };
      else if (!(f.confidence === 'low' && !f.rule_source)) continue; // inferred (no rule, low) stays; bad citations drop
    }
    const d = snap(f, readLines(f.path));
    if (d === null) { unanchored.push({ f, why: 'citation did not match the file' }); continue; }
    const fp = fingerprint(f.kind, f.path, f.quote, f.source);
    if (known.has(fp)) already++;
    else if (!seen.has(fp)) { seen.add(fp); kept.push({ ...f, line: f.line + d, ...(f.start_line !== undefined && { start_line: f.start_line + d }), fp }); }
  }

  const p = plan(kept, maps, maxComments);
  const comments = p.inline.map((f) => ({
    path: f.path, line: f.line, side: 'RIGHT', body: commentBody(f, f.fp),
    ...(f.start_line !== undefined && { start_line: f.start_line, start_side: 'RIGHT' }),
  }));
  const prov = proven(data.coverage);
  const counts = `${comments.length} inline, ${p.file.length} file-level, ${p.summary.length + unanchored.length} in summary${already ? `, ${already} already posted` : ''}`;
  const head = `<!-- specguard:review -->\nSpecGuard found ${axes(kept)}; ${counts}.${prov ? `\n${prov}.` : ''}\nEngine: ${engine || 'n/a'}${model ? ` (${model})` : ''}.`;

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

  await publish(buildSummary({ status: `${noGaps(data) ? 'No test gaps found.' : `Reviewed: ${axes(kept)}; ${counts}.`}${prov ? `\n\n${prov}.` : ''}`, data, items: [...p.summary, ...unanchored], partial, engine, model }));
}

module.exports = async (a) => {
  try { await run(a); } catch (e) { a.core.warning(`SpecGuard post failed: ${e.message}`); }
};
Object.assign(module.exports, { parsePatch, validate, anchor, snap, ruleLine, plan, fingerprint, redact, truncate, buildSummary, commentBody, axes, proven, noGaps });
