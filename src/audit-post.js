// Audit mode, last step (actions/github-script): validates the model's result and every citation against the checked-out HEAD,
// renders it to the job summary and, with audit_issue, to ONE issue we own. Advisory; never fails the run.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const post = require('./post');
const { ours } = require('./preflight');

const { neutralize, quoteLine, safeRel, readFile, usageLine, mergeUsage } = post;
const STATUS = ['covered', 'partial', 'missing_test', 'not_implemented', 'contradicted', 'unknown', 'needs_human'];
const RISK = ['contradicted', 'not_implemented', 'missing_test', 'partial', 'unknown', 'needs_human', 'covered']; // header order: worst first
const CLASS = ['static', 'unit', 'higher_level', 'human'];
const LAYER = ['unit', 'component', 'integration', 'e2e'];
const MARK = '<!-- specguard:audit -->', TITLE = 'SpecGuard requirements audit';
const SUMMARY_MAX = 900000, ISSUE_MAX = 64000; // job summary 1 MiB; issue body 65536 characters
const NEAR = 5; // a quote may sit this many lines from the cited one

const lines = (s) => String(s || '').split('\n').filter(Boolean);
const oneLine = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const cell = (s, n = Infinity) => oneLine(neutralize(String(s)), n).replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ');

// Hand-rolled mirror of audit.schema.json: structural problems reject the output (the repair turn's trigger); evidence that does not
// fit the status is not rejected here but downgraded by verify().
function validate(o) {
  const bad = (m) => ({ ok: false, error: m });
  const text = (v) => typeof v === 'string' && v.trim().length > 0;
  const cite = (v) => !!v && typeof v === 'object' && text(v.path) && Number.isInteger(v.line) && v.line >= 1 && text(v.quote);
  if (!o || typeof o !== 'object' || Array.isArray(o)) return bad('not an object');
  if (!Array.isArray(o.docs_reviewed) || !o.docs_reviewed.every(text)) return bad('docs_reviewed must be an array of paths');
  if (!Array.isArray(o.not_reviewed) || !o.not_reviewed.every(text)) return bad('not_reviewed must be an array of strings');
  if (!Number.isInteger(o.requirements_found) || o.requirements_found < 0) return bad('requirements_found must be a non-negative integer');
  if (!Array.isArray(o.requirements)) return bad('requirements must be an array');
  const ids = new Set();
  for (const [i, r] of o.requirements.entries()) {
    const w = `requirements[${i}]`;
    if (!r || typeof r !== 'object' || Array.isArray(r)) return bad(`${w} is not an object`);
    if (!text(r.id) || !text(r.text)) return bad(`${w}: id and text are required`);
    if (ids.has(r.id)) return bad(`${w}: duplicate id ${String(r.id).slice(0, 40)}`);
    ids.add(r.id);
    if (!cite(r.source)) return bad(`${w}: source needs path, line and quote`);
    if (!CLASS.includes(r.class)) return bad(`${w}: class must be one of ${CLASS.join(', ')}`);
    if (!STATUS.includes(r.status)) return bad(`${w}: status must be one of ${STATUS.join(', ')}`);
    if (!Array.isArray(r.code) || !r.code.every(cite)) return bad(`${w}: code must be an array of {path, line, quote}`);
    if (!Array.isArray(r.tests) || !r.tests.every((t) => cite(t) && LAYER.includes(t.layer))) return bad(`${w}: tests must be an array of {path, line, quote, layer: ${LAYER.join('|')}}`);
    if (r.note === undefined) r.note = '';
    else if (typeof r.note !== 'string') return bad(`${w}: note must be a string`);
    for (const c of [r.source, ...r.code, ...r.tests]) c.quote = c.quote.slice(0, 200); // a prefix of a verbatim quote still verifies
  }
  return { ok: true };
}

// Why the cited evidence cannot carry the status, or ''.
function gap(r) {
  const unit = r.tests.some((t) => t.layer === 'unit');
  if (r.status === 'covered') {
    if (!r.code.length) return 'covered needs a code citation';
    if (r.class === 'human') return 'a human requirement is never covered';
    if (r.class === 'unit' && !unit) return 'covered needs a unit test citation';
    if (r.class === 'higher_level' && !r.tests.length) return 'covered needs a test citation';
  }
  if (r.status === 'partial' && !r.tests.length) return 'partial needs a test citation';
  if ((r.status === 'missing_test' || r.status === 'contradicted') && !r.code.length) return `${r.status} needs a code citation`;
  return '';
}

function trackedFiles(root) {
  try { return new Set(execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 1 << 28 }).split('\0').filter(Boolean)); } catch { return null; }
}

// Checks every citation against the file at HEAD (tracked files only) and corrects the line when the quote sits within NEAR lines of it.
// A requirement whose own citation fails goes to not_reviewed; failed code/test citations are removed and the status downgraded to unknown when the rest cannot carry it.
// docs: the admitted documents (null = any); max: the row cap.
function verify(data, { read = readFile, tracked = null, docs = null, max = Infinity } = {}) {
  const cache = new Map();
  const file = (p) => { if (!cache.has(p)) cache.set(p, read(p)); return cache.get(p); };
  const locate = (c) => {
    const rel = safeRel(c.path);
    if (!rel || (tracked && !tracked.has(rel))) return false;
    const all = file(rel);
    if (!all) return false;
    const a = Math.max(0, c.line - 1 - NEAR), n = String(c.quote).split('\n').length;
    const k = quoteLine(all.slice(a, c.line - 1 + NEAR + n), c.quote);
    if (!k) return false;
    if (Math.abs(a + k - c.line) > NEAR) return false;
    c.path = rel; c.line = a + k;
    return true;
  };
  const out = { ...data, requirements: [], not_reviewed: [...data.not_reviewed] };
  const drop = (r, why) => out.not_reviewed.push(`${r.id} (${r.source.path}:${r.source.line}): ${why}`);
  for (const r of data.requirements) {
    const source = { ...r.source };
    if (docs && !docs.has(safeRel(source.path))) { drop(r, 'its source is not an admitted requirement document'); continue; }
    if (!locate(source)) { drop(r, 'the requirement quote was not found at the cited line'); continue; }
    const code = r.code.map((c) => ({ ...c })).filter(locate), tests = r.tests.map((c) => ({ ...c })).filter(locate);
    const lost = r.code.length - code.length + r.tests.length - tests.length;
    const row = { ...r, source, code, tests, note: r.note };
    if (lost) row.note = `${row.note} ${lost} citation(s) could not be verified and were removed.`.trim();
    const why = gap(row);
    if (why && row.status !== 'unknown') { row.note = `${row.note} Downgraded to unknown: ${why}.`.trim(); row.status = 'unknown'; }
    out.requirements.push(row);
  }
  if (out.requirements.length > max) {
    out.not_reviewed.push(`${out.requirements.length - max} further requirement(s) beyond audit_max_requirements (${max}) were not listed.`);
    out.requirements = out.requirements.slice(0, max);
  }
  return out;
}

const count = (rows, key, values) => values.map((v) => [v, rows.filter((r) => r[key] === v).length]).filter(([, n]) => n);

// Markdown that fits `max` characters: header and footer first, then whole table rows while they fit (never cut mid-row).
function render({ data, docs = [], rejected = [], limitations = [], blob = '', usage = '', failure = '', max = SUMMARY_MAX }) {
  const link = (p, line, label) => {
    const t = neutralize(label).replace(/[\[\]]/g, '').replace(/\|/g, '\\|');
    const rel = safeRel(p);
    return blob && rel ? `[${t}](${blob}/${rel.split('/').map(encodeURIComponent).join('/')}#L${line})` : t;
  };
  const at = (c) => link(c.path, c.line, `${c.path}:${c.line}`);
  const rows = data ? data.requirements : [];
  const groups = [];
  for (const r of rows) {
    let g = groups.find((x) => x.path === r.source.path);
    if (!g) groups.push(g = { path: r.source.path, rows: [] });
    const ev = [r.code.length ? `code: ${r.code.map(at).join('; ')}` : '', r.tests.length ? `tests: ${r.tests.map((t) => `${t.layer} ${at(t)}`).join('; ')}` : ''].filter(Boolean).join('<br>');
    g.rows.push(`| ${link(r.source.path, r.source.line, r.id)} ${cell(r.text, 300)}${r.note ? `<br><sub>${cell(r.note, 300)}</sub>` : ''} | ${r.status} | ${r.class} | ${ev || 'none'} |\n`);
  }

  const by = (rs, key, vs) => count(rs, key, vs).map(([v, n]) => `${v} ${n}`).join(' · ') || 'none';
  let head = `## ${TITLE}\n\n`;
  if (failure) head += `Could not complete: ${cell(failure, 400)}\n\n`;
  else if (!data) head += 'No requirement documents were found, so nothing was audited.\n\n';
  else {
    const found = data.requirements_found;
    head += `**${rows.length} requirement${rows.length === 1 ? '' : 's'}** from ${groups.length} document${groups.length === 1 ? '' : 's'}${found > rows.length ? ` (listed ${rows.length} of ${found} found; the rest are under not reviewed)` : ''}\n\n`
      + `By status: ${by(rows, 'status', RISK)}\n\nBy class: ${by(rows, 'class', CLASS)}\n\n`;
  }
  head += '> Static review; not coverage; not for scoring people. Tests were not executed: a requirement is `covered` when a cited unit assertion with an independent expected value proves it.\n\n';

  const list = (a, n, f) => a.slice(0, n).map(f).join('') + (a.length > n ? `- +${a.length - n} more\n` : '');
  let foot = '';
  if (rejected.length) foot += `### Documents not included\n\nThese looked like requirement documents but were not admitted (add them to \`requirements_paths\` to include):\n\n${list(rejected, 20, ([p, why]) => `- \`${cell(p, 200)}\`: ${cell(why, 200)}\n`)}\n`;
  const nr = [...(data ? data.not_reviewed : []), ...limitations];
  const unread = data ? docs.filter(([p]) => !data.docs_reviewed.includes(p)).map(([p]) => `\`${p}\` was admitted but is not in docs_reviewed.`) : [];
  if (nr.length || unread.length) foot += `### Not reviewed\n\n${list([...nr, ...unread], 40, (s) => `- ${cell(s, 400)}\n`)}\n`;
  if (usage) foot += `${usage}\n`;

  let room = max - head.length - foot.length - 300, omitted = 0, body = '';
  for (const g of groups) {
    const top = `### \`${cell(g.path, 200)}\`\n\n| Requirement | Status | Class | Evidence |\n|---|---|---|---|\n`;
    const kept = [];
    let used = top.length + 1;
    for (const r of g.rows) { if (used + r.length > room) break; kept.push(r); used += r.length; }
    omitted += g.rows.length - kept.length;
    if (kept.length) { body += `${top}${kept.join('')}\n`; room -= used; }
  }
  if (omitted) body += `_${omitted} row${omitted === 1 ? '' : 's'} omitted: the report exceeded the size limit; \`audit.json\` in the run artifact has them all._\n\n`;
  return head + body + foot;
}

module.exports = async ({ github, context, core }) => {
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
  const shared = { docs, rejected, limitations: (meta && meta.limitations) || [], blob, usage: usageHtml };
  const finish = (md) => core.summary.addRaw(md).write();

  if (!meta) return finish(render({ ...shared, failure: 'the collection step did not produce its context.' }));
  if (env.SKIP === 'true') return finish(render({ ...shared, data: null }));
  const data = json('findings.json');
  const v = validate(data);
  const why = v.ok ? '' : data ? `the result failed validation: ${v.error}` : 'the engine returned no usable JSON';
  const st = (readCtx('engine-status') || '').trim();
  if (why) return finish(render({ ...shared, failure: st === 'timeout' ? 'the engine timed out (raise review_timeout_minutes)' : st === 'failed' ? 'the engine failed; see the job log' : why }));

  const checked = verify(data, { tracked: trackedFiles(process.env.GITHUB_WORKSPACE || process.cwd()), docs: new Set(docs.map(([p]) => p)), max: meta.max_requirements });
  try { fs.writeFileSync(path.join(ctx, 'audit.json'), JSON.stringify({ head: meta.head, ...checked }, null, 2) + '\n'); } catch (e) { core.warning(`SpecGuard: could not write audit.json: ${e.message}`); }
  const md = render({ ...shared, data: checked });
  await finish(md);

  if (String(env.AUDIT_ISSUE).toLowerCase() !== 'true') return;
  try {
    const me = await (async () => { try { return (await github.rest.users.getAuthenticated()).data.login; } catch { return null; } })();
    // ponytail: lists every open issue; narrow with a label or `creator` if a repo has thousands
    const open = await github.paginate(github.rest.issues.listForRepo, { owner, repo, state: 'open', per_page: 100 });
    const mine = open.find((i) => !i.pull_request && ours(i.user, me) && typeof i.body === 'string' && i.body.startsWith(MARK));
    const body = `${MARK}\n${render({ ...shared, data: checked, max: ISSUE_MAX })}`;
    if (mine) await github.rest.issues.update({ owner, repo, issue_number: mine.number, title: TITLE, body });
    else await github.rest.issues.create({ owner, repo, title: TITLE, body });
  } catch (e) { core.warning(`SpecGuard: could not write the audit issue (needs permissions: issues: write): ${e.message}`); }
};
Object.assign(module.exports, { validate, verify, render, gap, STATUS, CLASS, MARK, TITLE });
