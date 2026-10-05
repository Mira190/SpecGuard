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
    if (!str(f.path) || !str(f.title) || !str(f.body)) return bad(`findings[${i}] path/title/body must be strings`);
    if (!int(f.line)) return bad(`findings[${i}].line must be an integer >= 1`);
    if (f.start_line !== undefined && !int(f.start_line)) return bad(`findings[${i}].start_line invalid`);
    if (f.rule_source !== undefined && !str(f.rule_source)) return bad(`findings[${i}].rule_source invalid`);
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
const fingerprint = (kind, p, lineText) => crypto.createHash('sha1').update(`${kind}\0${p}\0${norm(lineText)}`).digest('hex');

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

function commentBody(f, fp) {
  const why = `kind: ${f.kind}, confidence: ${f.confidence}${f.rule_source ? `, rule: ${f.rule_source}` : ''}`;
  return clean(`**${f.title}**\n\n${f.body}\n\n<details><summary>Why this was flagged</summary>\n\n${why}\n</details>\n\n<!-- specguard:fp=${fp} -->`);
}

const cell = (s) => redact(s).replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ');
const item = ({ f, why }) => `- **${f.title}** (\`${f.path}:${f.line}\`, ${f.kind}${why ? `, ${why}` : ''})\n\n  ${redact(f.body).replace(/\n/g, '\n  ')}\n`;

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
  for (const f of data.findings) {
    if (!maps.has(f.path) || !reviewable.has(f.path)) continue;
    if (f.kind === 'standard') {
      const m = /^(.+):(\d+)$/.exec(f.rule_source || '');
      const rl = m && standards.has(m[1]) ? readLines(m[1]) : null;
      const okRule = rl && +m[2] >= 1 && +m[2] <= rl.length;
      if (!okRule && !(f.confidence === 'low' && !f.rule_source)) continue; // inferred (no rule, low) stays; bad citations drop
    }
    const src = readLines(f.path);
    const fp = fingerprint(f.kind, f.path, (src && src[f.line - 1]) ?? f.title);
    if (known.has(fp)) already++;
    else kept.push({ ...f, fp });
  }

  const p = plan(kept, maps, maxComments);
  const unanchored = []; // items that failed to post; they go to the summary
  const comments = p.inline.map((f) => ({
    path: f.path, line: f.line, side: 'RIGHT', body: commentBody(f, f.fp),
    ...(f.start_line !== undefined && { start_line: f.start_line, start_side: 'RIGHT' }),
  }));
  const counts = `${comments.length} inline, ${p.file.length} file-level, ${p.summary.length} in summary${already ? `, ${already} already posted` : ''}`;
  const head = `<!-- specguard:review -->\nSpecGuard found ${counts}. Engine: ${engine || 'n/a'}${model ? ` (${model})` : ''}.`;

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
      await github.rest.pulls.createReviewComment({ owner, repo, pull_number: pr.number, commit_id: headSha, path: f.path, subject_type: 'file', body: commentBody({ ...f, body: `${f.body}\n\n[${f.path}:${f.line}](${link})` }, f.fp) });
    } catch (e) { core.warning(`SpecGuard: file-level comment failed: ${e.message}`); unanchored.push({ f, why: 'could not post' }); }
  }

  await publish(buildSummary({ status: `Reviewed: ${counts}.`, data, items: [...p.summary, ...unanchored], partial, engine, model }));
}

module.exports = async (a) => {
  try { await run(a); } catch (e) { a.core.warning(`SpecGuard post failed: ${e.message}`); }
};
Object.assign(module.exports, { parsePatch, validate, anchor, plan, fingerprint, redact, truncate, buildSummary, commentBody });
