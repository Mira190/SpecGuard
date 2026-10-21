#!/usr/bin/env node
// SZZ replay on a REAL repo (docs/traceability-plan.md 7.4.3). Same flow as eval/local.js: `prepareReal` runs the real collect.sh
// at (base, head) and writes prompt.md; an agent writes ctx/findings.json; `finishReal` runs the real post.run against a fake
// GitHub and counts findings. No case.json, so no pass/fail: grading is human adjudication against the later fix.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFileSync, spawnSync } = require('node:child_process');
const { buildPrompt, fakeGithub } = require('./local.js');
const { parseComment, parseSummary } = require('./grade.js');

const ROOT = path.join(__dirname, '..');
const fwd = (p) => path.resolve(p).replace(/\\/g, '/');
const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
// prereg B5: hash of the prompt bytes the model sees (prompt.md). The prompt names its ctx directory, which differs per arm/rep, so that path is blanked first.
const promptHash = (prompt, ctx) => crypto.createHash('sha256').update(String(prompt).split(fwd(ctx)).join('<CTX>').split(path.resolve(ctx)).join('<CTX>')).digest('hex');
const readJson = (p, d = null) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return d; } };
const readLines = (p) => { try { return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean); } catch { return []; } };

// local.js does not export its gh shim; this serves the original PR title/body from pr.json and nothing else.
const SHIM = `const cp = require('node:child_process'), fs = require('node:fs'), orig = cp.execFileSync;
cp.execFileSync = function (file, args) {
  if (file !== 'gh') return orig.apply(this, arguments);
  if (args[0] === 'pr' && args[1] === 'view') return fs.readFileSync(process.env.SG_PR_JSON, 'utf8');
  if (args[0] === 'api') return '[]';
  throw new Error('gh is offline');
};
`;

function cloneRepo(repoDir, repo, shared) {
  if (fs.existsSync(path.join(repo, '.git'))) return;
  execFileSync('git', ['-c', 'core.longpaths=true', 'clone', '-q', ...(shared ? ['--shared'] : ['--no-hardlinks']), '--no-checkout', path.resolve(repoDir), repo], { stdio: 'pipe' });
  for (const [k, v] of [['core.longpaths', 'true'], ['user.name', 'specguard-local'], ['user.email', 'local@example.invalid'], ['core.autocrlf', 'false']]) git(repo, 'config', k, v);
}

// ---- V2: coverage report + arm A (post-processing by an older SpecGuard) ----
// The report of an id lives in <coverDir>/<id>/lcov.info or coverage.xml.
const coverReport = (coverDir, id) => (coverDir ? ['lcov.info', 'coverage.xml'].map((n) => path.join(coverDir, id, n)).find((p) => fs.existsSync(p)) || null : null);
// A SpecGuard source root for `ref`: an existing directory is used as is; otherwise a sha gets a detached git worktree of this repo (under the temp dir; dropRefRoots removes it).
const refRoots = new Map();
function refRoot(ref) {
  if (!ref) return ROOT;
  if (fs.existsSync(path.join(ref, 'src', 'post.js'))) return path.resolve(ref);
  if (!refRoots.has(ref)) {
    const sha = git(ROOT, 'rev-parse', '--verify', `${ref}^{commit}`), dir = path.join(os.tmpdir(), `specguard-postref-${sha.slice(0, 12)}-${process.pid}`);
    if (!fs.existsSync(dir)) git(ROOT, 'worktree', 'add', '--detach', '-f', dir, sha);
    refRoots.set(ref, dir);
  }
  return refRoots.get(ref);
}
function dropRefRoots() {
  for (const dir of refRoots.values()) { try { git(ROOT, 'worktree', 'remove', '--force', dir); } catch { fs.rmSync(dir, { recursive: true, force: true }); } }
  refRoots.clear();
}
// What action.yml's coverage step does, with the real <root>/src/coverage.js. The report is copied into the checkout first (expand() refuses paths outside the workspace).
// Returns the result.json `coverage` block. coverage.json/txt of an earlier run are removed first, so no report means no V2 input.
function runCoverage({ root = ROOT, report, repo, ctx, head }) {
  for (const n of ['coverage.json', 'coverage.txt']) fs.rmSync(path.join(ctx, n), { force: true });
  if (!report) return { report: null, used: false, note: 'no report for this id' };
  const rel = `.specguard-cov/${path.basename(report)}`;
  fs.mkdirSync(path.join(repo, '.specguard-cov'), { recursive: true });
  fs.copyFileSync(report, path.join(repo, rel));
  const env = { ...process.env, CTX: fwd(ctx), GITHUB_WORKSPACE: fwd(repo), HEAD_SHA: head, COVERAGE_FILES: rel };
  for (const k of ['ANTHROPIC_API_KEY', 'GH_TOKEN', 'GITHUB_TOKEN', 'NODE_OPTIONS']) delete env[k];
  const r = spawnSync('node', [path.join(root, 'src', 'coverage.js')], { encoding: 'utf8', env });
  const j = readJson(path.join(ctx, 'coverage.json'));
  return { report: path.basename(report), used: !!j && j.reports > 0, note: `${r.status ? `exit ${r.status}: ` : ''}${r.stdout || ''}${r.stderr || ''}`.trim().split('\n')[0].slice(0, 300) };
}
// `source` of a summary-only finding (the summary text does not show it): the counts marker's `sum` list, keyed by kind + path + line.
function summarySources(summary) {
  try {
    const sum = JSON.parse(/<!-- specguard:counts (\{.*\}) -->/.exec(summary || '')?.[1]).sum || [];
    return new Map(sum.filter((e) => e.source).map((e) => [`${e.kind}|${e.path}|${e.line}`, e.source]));
  } catch { return new Map(); }
}
// "### More never-executed definitions": the R-a groups past the inline cap -> [{ path, count, names }] (the names the summary shows; absorbed model titles in parentheses are dropped)
function rollupGroups(summary) {
  const block = /### More never-executed definitions\n\n((?:- [^\n]*\n)+)/.exec(String(summary || ''));
  return (block ? block[1].split('\n').filter(Boolean) : []).map((l) => {
    const m = /^- `(.+?)`: (\d+) more never-executed definitions?: (.*)$/.exec(l);
    return m && { path: m[1], count: +m[2], names: m[3].replace(/, \+\d+ more$/, '').replace(/\s\((?:[^()]|\([^()]*\))*\)/g, '').split(', ').filter(Boolean) };
  }).filter(Boolean);
}

// Clone repoDir to <out>/<id>/repo at head (full history, so base is reachable), run the real collect.sh, write prompt.md and meta.json.
// shared: true uses 'git clone --shared' (objects via .git/objects/info/alternates) instead of a full copy, saving disk. The working copy then
// DEPENDS ON repoDir staying where it is and keeping its objects: do not move, delete or gc/prune the source clone while shared copies exist.
function prepareReal({ repoDir, base, head, prTitle = '', prBody = '', out, id, trace = 'auto', shared = false }) {
  const dir = path.resolve(out, id), repo = path.join(dir, 'repo'), ctx = path.join(dir, 'ctx');
  fs.mkdirSync(dir, { recursive: true });
  cloneRepo(repoDir, repo, shared);
  head = git(repo, 'rev-parse', head); base = git(repo, 'rev-parse', base);
  git(repo, 'checkout', '-q', '--detach', head);
  fs.rmSync(ctx, { recursive: true, force: true });
  const shim = path.join(path.resolve(out), 'gh-shim.js'), pr = path.join(dir, 'pr.json'), outputs = path.join(dir, 'gh-output.txt');
  fs.writeFileSync(shim, SHIM);
  fs.writeFileSync(pr, JSON.stringify({ number: 1, title: prTitle, body: prBody, closingIssuesReferences: [] }));
  fs.writeFileSync(outputs, '');
  const r = spawnSync('bash', [fwd(path.join(ROOT, 'src', 'collect.sh'))], {
    cwd: repo, encoding: 'utf8', maxBuffer: 1 << 28,
    env: { ...process.env, BASE_SHA: base, HEAD_SHA: head, CTX: fwd(ctx), TRACE: trace, REQ_PATHS: '', IGNORE_EXTRA: '', PR_NUMBER: '1', GH_REPO: 'local/eval', GH_TOKEN: 'offline',
      GITHUB_OUTPUT: fwd(outputs), SG_PR_JSON: fwd(pr), NODE_OPTIONS: `--require "${fwd(shim)}"` },
  });
  fs.writeFileSync(path.join(dir, 'collect.log'), `${r.stdout || ''}${r.stderr || ''}`);
  const o = readLines(outputs);
  fs.writeFileSync(path.join(dir, 'prompt.md'), buildPrompt(ctx));
  const meta = { id, base, head, pr_title: prTitle, trace, collect_ok: r.status === 0, skip: o.includes('skip=true'), partial: o.includes('partial=true'),
    files: readLines(path.join(ctx, 'files.txt')).length, spec_files: readLines(path.join(ctx, 'spec-files.txt')).length, repo, ctx };
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2) + '\n');
  return meta;
}

// Counts from the posted comments and the sticky summary. Summary-only = findings carried in full by the summary (`- title `path:line` (why)` under a kind heading, or the older `- ❌ **Missing test:** …`),
// outside the Pre-existing drift block of Details; findings posted as comments appear there with a linked title (`[title](url)`) and are not counted.
function countFindings(comments, summary) {
  const inline = { total: 0, byKind: {}, byConfidence: { high: 0, low: 0 } };
  for (const c of comments.map(parseComment).filter(Boolean)) {
    inline.total++; inline.byConfidence[c.confidence]++;
    inline.byKind[c.kind] = (inline.byKind[c.kind] || 0) + 1;
  }
  let s = String(summary || '');
  // the Pre-existing drift block (a bold heading in Details) runs to the next bold heading or the end of Details
  const pre = /\*\*Pre-existing drift[^*\n]*\*\*\n\n([^]*?)(?=\n\*\*[^\n]+\*\*\n|<\/details>|$)/.exec(s);
  if (pre) s = s.replace(pre[0], '');
  const count = (t) => parseSummary(t).items.length;
  return { inline, summary_only: count(s), pre_existing: pre ? count(pre[1]) : 0 };
}

// The summary-only items themselves (same exclusion of the Pre-existing drift block as countFindings).
function summaryItems(summary) {
  let s = String(summary || '');
  const pre = /\*\*Pre-existing drift[^*\n]*\*\*\n\n([^]*?)(?=\n\*\*[^\n]+\*\*\n|<\/details>|$)/.exec(s);
  if (pre) s = s.replace(pre[0], '');
  return parseSummary(s).items;
}

// post.js's final status/reason: its core outputs, else (an old result, a downloaded artifact) the summary's status marker and "Could not complete: <reason>" line.
const publisher = (summary, outputs = {}) => ({ publisher_status: outputs.status || /<!-- specguard:status=(\w+) -->/.exec(summary || '')?.[1] || null, publisher_reason: outputs.reason || /Could not complete: ([^\n]*)/.exec(summary || '')?.[1] || null });

async function finishRealOne(id, out, { engine = 'local', model = '', root = ROOT } = {}) {
  const dir = path.resolve(out, id), meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
  const ctx = path.join(dir, 'ctx'), present = fs.existsSync(path.join(ctx, 'findings.json'));
  const { github, core, posted } = fakeGithub({ headSha: meta.head });
  const context = { repo: { owner: 'local', repo: 'eval' }, serverUrl: 'https://github.com', payload: { pull_request: { number: 1, head: { sha: meta.head }, base: { sha: meta.base } } } };
  const env = { CTX: ctx, HEAD_SHA: meta.head, BASE_SHA: meta.base, GITHUB_WORKSPACE: meta.repo, SKIP: String(!!meta.skip), PARTIAL: String(!!meta.partial), MAX_COMMENTS: '10', ENGINE: engine, MODEL: model, STANDARDS_REF: 'head', STANDARDS_CHECKS: '' };
  const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  try { await require(path.join(root, 'src', 'post.js'))({ github, context, core }); }
  finally { for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  fs.writeFileSync(path.join(dir, 'posted.json'), JSON.stringify({ comments: posted.comments, reviews: posted.reviews, warnings: posted.warnings }, null, 2) + '\n');
  fs.writeFileSync(path.join(dir, 'summary.md'), posted.summary || '');
  return { id, trace: meta.trace, findings_present: present, ...publisher(posted.summary, posted.outputs), ...countFindings(posted.comments, posted.summary) };
}

function table(rows) {
  const kinds = [...new Set(rows.flatMap((r) => Object.keys(r.inline?.byKind || {})))].sort();
  const head = ['pr', 'trace', 'inline', 'high', 'low', ...kinds, 'summary', 'pre-existing'];
  const body = rows.map((r) => r.error ? [r.id, 'ERROR', r.error] : [r.id, r.trace, r.inline.total, r.inline.byConfidence.high, r.inline.byConfidence.low,
    ...kinds.map((k) => r.inline.byKind[k] || 0), r.summary_only, r.pre_existing]);
  const w = head.map((h, i) => Math.max(h.length, ...body.map((r) => String(r[i] ?? '').length)));
  const fmt = (r) => r.map((x, i) => String(x ?? '').padEnd(w[i])).join('  ').trimEnd();
  return [fmt(head), ...body.map(fmt)].join('\n');
}

async function finishReal({ ids, out, log = console.log }) {
  const rows = [];
  for (const id of ids) {
    try { rows.push(await finishRealOne(id, out)); } catch (e) { rows.push({ id, error: String(e.message || e).split('\n')[0] }); }
  }
  log(table(rows));
  return rows;
}

// ---- the real engine (eval/replay-workflow.yml) ----
// Manifest entry -> { id, repo, number, base, head, title, body }. holdout-pairs.json: the INTRODUCING PR of a replay_eligible pair; holdout-clean.json: a clean PR.
function entries(manifestPath) {
  const j = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (j.bugs) return [...j.bugs.map((b) => [b, b.introducing, 'bug']), ...j.controls.map((c) => [c, c.sha, 'control'])].map(([x, head, set]) => ({ id: `${x.clone}-${x.pr}`, repo: x.repo, clone: x.clone, number: x.pr, base: x.base || `${head}~1`, head, title: x.title || x.pr_title || '', body: x.body || x.pr_body || '', set })); // testgap-confirm-build.js
  if (j.pairs) return j.pairs.filter((p) => p.replay_eligible).map((p) => ({ id: p.replay_id, repo: p.repo, number: p.introducing.number, base: p.introducing.base, head: p.introducing.head, title: p.introducing.pr_title, body: p.introducing.pr_body, fix: p.fix.number }));
  return j.clean.map((c) => ({ id: c.id, repo: c.repo, number: c.number, base: c.base, head: c.head, title: c.pr_title, body: c.pr_body }));
}

// Seeded sample (mulberry32 shuffle), so "12 clean PRs" is the same 12 on every run.
function sample(list, n, seed = 1) {
  let a = seed >>> 0; const rnd = () => { a = (a + 0x6D2B79F5) >>> 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const l = [...list]; for (let i = l.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [l[i], l[j]] = [l[j], l[i]]; }
  return l.slice(0, n);
}

// What action.yml's engine step does for engine=claude, claude_mode=api: src/engines/claude.sh with the same env (the prompt is the one prepareReal wrote with src/prompt.js's assembler).
function runEngine({ dir, ctx, repo, model, budget, maxOutput, timeout }) {
  // GITHUB_WORKSPACE = the prepared checkout: claude-api.js reads the context pack from it (default: cwd = dir, which holds no repo files -> empty pack)
  const env = { ...process.env, GITHUB_WORKSPACE: fwd(repo || dir), CTX: fwd(ctx), PROMPT_FILE: fwd(path.join(dir, 'prompt.md')), ENGINE: 'claude', CLAUDE_MODE: 'api', CLAUDE_VERSION: '', MODEL: model, MAX_BUDGET_USD: budget, MAX_OUTPUT_TOKENS: maxOutput, TIMEOUT: timeout, EFFORT: '' };
  delete env.GH_TOKEN; delete env.GITHUB_TOKEN;
  const r = spawnSync('bash', [fwd(path.join(ROOT, 'src', 'engines', 'claude.sh'))], { cwd: dir, encoding: 'utf8', env, maxBuffer: 1 << 28 });
  fs.writeFileSync(path.join(dir, 'engine.log'), `${r.stdout || ''}${r.stderr || ''}`.replace(/sk-ant-[\w-]+/g, '***'));
  return r.status;
}

// An eval must never silently degrade: the reason a run is NOT a valid measurement, or null. A crashed engine, a missing findings.json or an empty/unreported context pack must not look like a miss.
const invalid = (r) => {
  if (!r.collect_ok) return 'collect failed'; if (r.skip) return 'skipped by collect';
  if (r.engine_exit !== 0) return `engine exit ${r.engine_exit}`; if (r.engine_status !== 'success') return `engine status ${r.engine_status}`;
  if (!r.findings_present) return 'no findings.json';
  // post.js rejected the run (findings.json of the wrong shape, ...): not a measurement. `incomplete` stays valid: a fast-tier reduced review is a real, if smaller, measurement.
  if (r.publisher_status === 'failed') return `publisher: ${r.publisher_reason || 'failed'}`;
  if (r.files > 0) { const m = (r.engine_notes || []).map((n) => /^context pack: (\d+) files/.exec(n)).find(Boolean); if (!m) return 'no context pack note'; if (+m[1] === 0) return `context pack is empty (0 files) although the PR changed ${r.files} file(s)`; }
  return null;
};

// Offline: the invalid reason (or null) of a downloaded artifact dir (result.json + summary.md), also for results written before publisher_status existed. `node eval/replay.js revalidate --out DIR --id ID`.
const revalidate = (dir) => { const r = readJson(path.join(dir, 'result.json'), {}); return invalid({ ...r, ...(r.publisher_status ? {} : publisher(fs.existsSync(path.join(dir, 'summary.md')) ? fs.readFileSync(path.join(dir, 'summary.md'), 'utf8') : ''))}); };

// finish (real post.run from `root`) -> findings, source, rollup, counts and validity written to <out>/<id>/result.json. Shared by runReal and repost.
async function record(id, out, result, { model, root }) {
  const dir = path.resolve(out, id);
  const row = await finishRealOne(id, out, { engine: 'claude', model, root });
  const posted = readJson(path.join(dir, 'posted.json'), { comments: [] }), summary = fs.readFileSync(path.join(dir, 'summary.md'), 'utf8'), srcs = summarySources(summary);
  const f = (where) => (x) => ({ where, kind: x.kind, path: x.path, line: x.line, title: x.title, confidence: x.confidence || null });
  result.findings = [...posted.comments.map(parseComment).filter(Boolean).map((x) => ({ ...f('inline')(x), ...(x.origin && { source: x.origin }) })),
    ...summaryItems(summary).map((x) => ({ ...f('summary')(x), ...(srcs.has(`${x.kind}|${x.path}|${x.line}`) && { source: srcs.get(`${x.kind}|${x.path}|${x.line}`) }), why: x.why || '' }))];
  const roll = rollupGroups(summary); if (roll.length) result.rollup = roll; else delete result.rollup;
  result.findings_present = row.findings_present; result.publisher_status = row.publisher_status; result.publisher_reason = row.publisher_reason; result.invalid_reason = invalid(result); result.valid = !result.invalid_reason;
  result.counts = { inline: row.inline.total, summary_only: row.summary_only, pre_existing: row.pre_existing };
  fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(result, null, 2) + '\n');
  return result;
}

// prepare -> [V2: real coverage.js on <coverDir>/<id>'s report] -> real engine -> finish (real post.run) -> <out>/<id>/result.json. `engine` is injectable for tests.
// postRef (arm A): coverage.js and post.js come from that older SpecGuard (sha or directory) instead of this tree; the model output is whatever the engine writes.
async function runReal({ entry, repoDir, out, model = 'claude-haiku-5-5', budget = '1.00', maxOutput = '32000', timeout = '12', trace = 'auto', engine = runEngine, coverDir, postRef }) {
  const root = refRoot(postRef);
  const meta = prepareReal({ repoDir, base: entry.base, head: entry.head, prTitle: entry.title, prBody: entry.body, out, id: entry.id, trace, shared: true });
  const dir = path.resolve(out, entry.id), ctx = path.join(dir, 'ctx');
  const result = { id: entry.id, repo: entry.repo, pr: entry.number, base: meta.base, head: meta.head, trace, model, files: meta.files, spec_files: meta.spec_files, collect_ok: meta.collect_ok, skip: meta.skip, partial: meta.partial };
  if (coverDir && meta.collect_ok && !meta.skip) { // the action's coverage step sits before the engine, so the model's prompt carries coverage.txt
    result.coverage = runCoverage({ root, report: coverReport(coverDir, entry.id), repo: meta.repo, ctx, head: meta.head });
    if (result.coverage.used) fs.writeFileSync(path.join(dir, 'prompt.md'), buildPrompt(ctx));
  }
  result.prompt_sha256 = promptHash(fs.readFileSync(path.join(dir, 'prompt.md'), 'utf8'), ctx);
  if (meta.collect_ok && !meta.skip) result.engine_exit = await engine({ dir, ctx, repo: meta.repo, model, budget, maxOutput, timeout });
  const sf = path.join(ctx, 'engine-status'), status = fs.existsSync(sf) ? fs.readFileSync(sf, 'utf8').trim() : 'success';
  result.engine_status = meta.skip ? 'skipped' : !meta.collect_ok ? 'collect_failed' : status;
  result.engine_notes = readLines(path.join(ctx, 'engine-notes'));
  const u = readJson(path.join(ctx, 'usage.json'), {}), u2 = readJson(path.join(ctx, 'usage-repair.json'), {});
  result.usage = { cost_usd: (u.totalCostUsd || 0) + (u2.totalCostUsd || 0), model: u.currentModel || null, metrics: u.modelMetrics || null };
  return record(entry.id, out, result, { model, root });
}

// Arm A / re-post: re-run only coverage + post.js on saved run dirs (<from>/rep<k>/<id>: ctx with the saved findings.json, result.json) into a parallel <to> tree. The model is never called.
// postRef = the older SpecGuard whose coverage.js and post.js process the SAME model output; no postRef = this tree. repos rebuilds the checkout (batch deletes it after each run).
async function repost({ from, to, repos, coverDir, postRef, model = 'claude-haiku-5-5', log = console.log }) {
  const root = refRoot(postRef), done = [];
  for (const rep of fs.readdirSync(from).filter((n) => /^rep\d+$/.test(n)).sort()) for (const id of fs.readdirSync(path.join(from, rep)).sort()) {
    const src = path.join(from, rep, id), prev = readJson(path.join(src, 'result.json'));
    if (!prev || !fs.existsSync(path.join(src, 'ctx', 'findings.json'))) { log(`${id} ${rep}: no saved findings, skipped`); continue; }
    const o = path.join(to, rep), dir = path.join(o, id), ctx = path.join(dir, 'ctx'), meta = readJson(path.join(src, 'meta.json'));
    fs.rmSync(dir, { recursive: true, force: true });
    fs.cpSync(src, dir, { recursive: true, filter: (p) => path.basename(p) !== 'repo' });
    cloneRepo(path.join(repos, prev.repo.split('/').pop()), path.join(dir, 'repo'), true);
    git(path.join(dir, 'repo'), 'checkout', '-q', '--detach', meta.head);
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ ...meta, repo: path.join(dir, 'repo'), ctx }, null, 2) + '\n');
    const result = { ...prev, ...(coverDir && { coverage: runCoverage({ root, report: coverReport(coverDir, id), repo: path.join(dir, 'repo'), ctx, head: meta.head }) }) };
    if (!coverDir) for (const n of ['coverage.json', 'coverage.txt']) fs.rmSync(path.join(ctx, n), { force: true });
    // B5: the prompt this arm's coverage.js would have sent. If it differs from the source run's, the saved model output is not this arm's: arm A must run live.
    const prompt = buildPrompt(ctx); fs.writeFileSync(path.join(dir, 'prompt.md'), prompt);
    Object.assign(result, { source_prompt_sha256: prev.prompt_sha256 || null, prompt_sha256: promptHash(prompt, ctx), prompt_matches_source: !!prev.prompt_sha256 && prev.prompt_sha256 === promptHash(prompt, ctx) });
    await record(id, o, result, { model: prev.model || model, root });
    fs.rmSync(path.join(dir, 'repo'), { recursive: true, force: true });
    log(`${id} ${rep}: reposted`); done.push(`${rep}/${id}`);
  }
  return done;
}

// Local batch over saved replay dirs (<dl>/<run>/replay-<id>, each with result.json {id, repo}) or `list` (entries, e.g. from a confirm-corpus manifest): sequential, rep-major (rep k writes <out>/rep<k>/<id>), at most `cap` engine runs.
// Resume skips every id with a result.json, except one marked retryable. A run that reached the model is never re-rolled (a failure is a miss): retryable iff invalid, never billed (usage.cost_usd 0) and either threw before the engine ran (clone, disk) or stopped for an account/config reason (engine-error auth/quota/config/model/rate); it stops the batch (a dead key must not burn the rest).
// Any other invalid result, and a throw after a billed engine run (its cost is read from ctx/usage*.json), is recorded as a miss and the batch goes on. Ids in `list` must be unique. The result lists `attempts` (one per result.attempt-*.json). A retryable result is renamed result.attempt-<n>.json before its re-run, and spent sums result.json + result.attempt-*.json under out. Stops before a run that could pass `maxTotal` (spent + this run's `budget`).
const RETRYABLE = new Set(['auth', 'quota', 'config', 'model', 'rate']);
async function batch({ dirs, list, manifests, repos, out, cap, maxTotal, reps = 1, model = 'claude-haiku-5-5', budget, engine = runEngine, coverDir, postRef, log = console.log }) {
  const subs = (d) => { try { return fs.readdirSync(d, { withFileTypes: true }).filter((x) => x.isDirectory()).map((x) => path.join(d, x.name)); } catch { return []; } };
  const cost = (f) => readJson(f, {}).usage?.cost_usd || 0, files = (d) => { try { return fs.readdirSync(d).filter((n) => /^result(\.attempt-\d+)?\.json$/.test(n)).map((n) => path.join(d, n)); } catch { return []; } };
  let spent = [out, ...subs(out)].flatMap(subs).flatMap(files).reduce((t, f) => t + cost(f), 0), ran = 0, skipped = 0, stopped = null;
  const todo = list || dirs.map((d) => { const id = readJson(path.join(d, 'result.json'), {}).id; const entry = manifests.flatMap(entries).find((e) => e.id === id); if (!entry) throw new Error(`no manifest entry for ${id}`); return entry; });
  const ids = todo.map((e) => e.id); for (const id of ids) if (ids.indexOf(id) !== ids.lastIndexOf(id)) throw new Error(`duplicate id ${id}`);
  outer: for (let k = 1; k <= reps; k++) for (const entry of todo) {
    const id = entry.id, o = path.join(out, `rep${k}`), rf = path.join(o, id, 'result.json'), prev = readJson(rf);
    if (prev && !prev.retryable) { skipped++; log(`${id} rep${k}: done, skipped`); continue; }
    if (ran >= cap) break outer;
    if (spent + +budget > maxTotal) { stopped = 'budget'; log(`total cap: spent $${spent} of $${maxTotal}`); break outer; }
    if (prev) { let n = 1; while (fs.existsSync(path.join(o, id, `result.attempt-${n}.json`))) n++; fs.renameSync(rf, path.join(o, id, `result.attempt-${n}.json`)); } // its cost stays in spent
    let r; try { r = await runReal({ entry, repoDir: path.join(repos, entry.clone || entry.repo.split('/').pop()), out: o, model, budget, engine, coverDir, postRef }); } catch (e) { // a throw (clone, full disk, post.js crash): a retryable stop for a human when nothing was billed, else a miss with its cost
      r = { id, valid: false, engine_status: 'error', invalid_reason: `run failed: ${String(e.message || e).split('\n')[0]}`, usage: { cost_usd: ['usage.json', 'usage-repair.json'].reduce((t, n) => t + (readJson(path.join(o, id, 'ctx', n), {}).totalCostUsd || 0), 0) }, thrown: true }; fs.mkdirSync(path.join(o, id), { recursive: true }); fs.writeFileSync(rf, JSON.stringify(r, null, 2) + '\n'); }
    ran++; const c = r.usage?.cost_usd || 0; spent += c;
    fs.rmSync(path.join(o, id, 'repo'), { recursive: true, force: true }); // a full checkout per PR and rep (100+ MB on gitea/langchain); nothing reads it after post.js, and replay-arms/two-posts rebuild it from --repos
    log(`${id} rep${k}: ${r.engine_status} cost=$${c} ${r.valid ? 'valid' : `invalid: ${r.invalid_reason}`}`);
    if (!r.valid && !(c > 0) && (r.thrown || RETRYABLE.has(readLines(path.join(o, id, 'ctx', 'engine-error'))[0]))) { fs.writeFileSync(rf, JSON.stringify({ ...r, retryable: true }, null, 2) + '\n'); stopped = id; break outer; }
  }
  const attempts = subs(out).flatMap((rd) => subs(rd).flatMap((idd) => files(idd).filter((f) => /attempt/.test(f)).map((f) => ({ id: path.basename(idd), rep: +path.basename(rd).slice(3), reason: readJson(f, {}).invalid_reason }))));
  return { ran, skipped, stopped, spent, attempts };
}

const USAGE = `Usage:
  node eval/replay.js prepare --repo DIR --base SHA --head SHA --out DIR --id ID [--title T] [--body B] [--trace auto|off] [--shared]
  node eval/replay.js finish  --id ID[,ID...] --out DIR
  node eval/replay.js plan    --manifest FILE [--ids a,b] [--sample N --seed S]     prints the matrix JSON [{id, repo}]
  node eval/replay.js run     --manifest FILE --id ID --repo DIR --out DIR [--model M] [--budget USD] [--max-output N] [--timeout MIN] [--trace auto|off]
                              prepare -> real src/engines/claude.sh (needs ANTHROPIC_API_KEY) -> finish -> <out>/<id>/result.json
  node eval/replay.js batch   --out DIR --repos DIR --cap N --budget USD --max-total USD [--reps N] [--model M] [--manifest a.json,b.json] DIR...
  node eval/replay.js batch   --out DIR --repos DIR --cap N --budget USD --max-total USD [--reps N] [--model M] --manifest FILE --ids all|a,b     (no DIRs: confirm-corpus manifest, in manifest order)
                              local sequential real-engine runs over saved replay dirs (<dl>/<run>/replay-<id>) or manifest entries; writes <out>/rep<k>/<id>; resumes (skips every result.json except retryable: true);
                              never re-rolls an invalid PR: only an account/config error (auth, quota, config, model, rate) is retryable and stops the batch (exit 1), as does the total cap
  node eval/replay.js repost  --from DIR --out DIR --repos DIR [--post-ref SHA] [--cover-dir D]
                              V2 arm A: re-run only coverage.js + post.js (from the old SpecGuard at --post-ref; default this tree) on the saved <from>/rep<k>/<id> findings into <out>; no model call
  batch and run also take --cover-dir D (D/<id>/lcov.info|coverage.xml: real src/coverage.js before the engine) and --post-ref SHA|DIR
No pass/fail: findings are adjudicated by a human against the later fix (eval/replay/README.md, "Running on the real engine").`;

async function main() {
  const { values: o, positionals } = require('node:util').parseArgs({ allowPositionals: true, options: {
    repo: { type: 'string' }, base: { type: 'string' }, head: { type: 'string' }, out: { type: 'string' }, id: { type: 'string' },
    title: { type: 'string', default: '' }, body: { type: 'string', default: '' }, trace: { type: 'string', default: 'auto' }, shared: { type: 'boolean' }, help: { type: 'boolean' },
    manifest: { type: 'string' }, ids: { type: 'string' }, sample: { type: 'string' }, seed: { type: 'string', default: '1' },
    model: { type: 'string', default: 'claude-haiku-5-5' }, budget: { type: 'string', default: '1.00' }, 'max-output': { type: 'string', default: '32000' }, timeout: { type: 'string', default: '12' },
    'cover-dir': { type: 'string' }, 'post-ref': { type: 'string' }, from: { type: 'string' },
    repos: { type: 'string' }, cap: { type: 'string' }, 'max-total': { type: 'string' }, reps: { type: 'string', default: '1' } } });
  const [cmd] = positionals;
  if (cmd === 'plan' && o.manifest) {
    let l = entries(o.manifest);
    if (o.ids) l = o.ids.split(',').map((id) => l.find((e) => e.id === id) || (() => { throw new Error(`no such id: ${id}`); })());
    else if (o.sample) l = sample(l, +o.sample, +o.seed);
    return console.log(JSON.stringify(l.map(({ id, repo }) => ({ id, repo }))));
  }
  if (cmd === 'run' && o.manifest && o.id && o.repo && o.out) {
    const entry = entries(o.manifest).find((e) => e.id === o.id);
    if (!entry) throw new Error(`no such id: ${o.id}`);
    const r = await runReal({ entry, repoDir: o.repo, out: o.out, model: o.model, budget: o.budget, maxOutput: o['max-output'], timeout: o.timeout, trace: o.trace, coverDir: o['cover-dir'], postRef: o['post-ref'] });
    if (!r.valid) throw new Error(`${r.id}: invalid replay: ${r.invalid_reason}`); // result.json is already written and uploaded
    return console.log(`${r.id}: ${r.engine_status} inline=${r.counts.inline} summary=${r.counts.summary_only} cost=$${r.usage.cost_usd}`);
  }
  if (cmd === 'batch') {
    const pos = (x) => +x > 0 ? +x : null, cap = pos(o.cap), maxTotal = pos(o['max-total']), reps = pos(o.reps), budget = process.argv.includes('--budget') ? pos(o.budget) : null;
    if (!o.out || !o.repos || !cap || !maxTotal || !reps || !budget || (positionals.length < 2 && !(o.manifest && o.ids))) { console.log(USAGE); process.exit(2); }
    const manifests = o.manifest ? o.manifest.split(',') : ['holdout2-pairs.json', 'holdout2-clean.json'].map((f) => path.join(__dirname, 'replay', f));
    let list; if (positionals.length < 2) { const all = o.manifest.split(',').flatMap(entries); list = o.ids === 'all' ? all : o.ids.split(',').map((id) => all.find((e) => e.id === id) || (() => { throw new Error(`no such id: ${id}`); })()); list = all.filter((e) => list.includes(e)); } // manifest order
    const r = await batch({ dirs: positionals.slice(1), list, manifests, repos: o.repos, out: o.out, cap, maxTotal, reps, model: o.model, budget: o.budget, coverDir: o['cover-dir'], postRef: o['post-ref'] });
    console.log(JSON.stringify(r)); if (r.stopped) process.exit(1); return;
  }
  if (cmd === 'repost') {
    if (!o.from || !o.out || !o.repos) { console.log(USAGE); process.exit(2); }
    const done = await repost({ from: o.from, to: o.out, repos: o.repos, coverDir: o['cover-dir'], postRef: o['post-ref'], model: o.model });
    return console.log(JSON.stringify({ reposted: done.length }));
  }
  if (cmd === 'revalidate' && o.out && o.id) return o.id.split(',').forEach((id) => console.log(`${id}: ${revalidate(path.resolve(o.out, id)) || 'valid'}`));
  if (o.help || !['prepare', 'finish'].includes(cmd) || !o.out || !o.id) { console.log(USAGE); process.exit(o.help ? 0 : 2); }
  if (cmd === 'prepare') console.log(JSON.stringify(prepareReal({ repoDir: o.repo, base: o.base, head: o.head, prTitle: o.title, prBody: o.body, out: o.out, id: o.id, trace: o.trace, shared: o.shared }), null, 2));
  else await finishReal({ ids: o.id.split(','), out: o.out });
}

if (require.main === module) main().catch((e) => { console.error(e.message); process.exitCode = 1; }).finally(dropRefRoots);
module.exports = { repost, refRoot, dropRefRoots, runCoverage, coverReport, rollupGroups, summarySources, prepareReal, finishReal, finishRealOne, countFindings, summaryItems, table, entries, sample, runReal, batch, runEngine, invalid, revalidate, publisher };
