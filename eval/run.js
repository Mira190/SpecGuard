#!/usr/bin/env node
// Runs the acceptance cases against the real Action on GitHub (gh + git), grades them, writes eval/results/<runId>.{json,md}.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { grade, aggregate, parseComment, parseSummary, filterSummary } = require('./grade.js');
const { extractCriteria } = require('../src/requirements.js');

const ROOT = path.join(__dirname, '..');
const CASES = path.join(__dirname, 'cases');
const GOALS = ['requirements', 'test_quality', 'standards', 'layering', 'robustness'];
const USAGE = `Usage: node eval/run.js --repo OWNER/REPO --target BRANCH [options]

  --repo OWNER/REPO   repository that has the Action wired up in its CI workflow; origin must point at it
  --target BRANCH     branch the sandbox PRs are based on (must contain the Action and workflow)
  --cases r1,t2       comma-separated case ids (default: all)
  --runs N            repetitions per case, or per combined PR (default 1)
  --run-id ID         result file name (default: timestamp, plus the model when --model is set)
  --model ID|default  set repo variable SPECGUARD_EVAL_MODEL for the batch ("default" deletes it); the previous value is restored afterwards
  --billing           record the Copilot cost delta from the billing usage API (needs gh scope "user"; day-granular)
  --workflow NAME     workflow to wait for (default: CI)
  --combined          put all selected cases (except x1, x2) into ONE PR and review once; graded per case by sandbox path
  --keep              keep the PRs and branches
  --dry-run           validate the case directories (and with --combined the merged overlay and PR body) and exit; no git, no GitHub
  --help

Push auth: git credential helper "!gh auth git-credential"; override with SPECGUARD_EVAL_CRED_HELPER.
Runs are sequential and open real PRs, so each run spends Copilot credits. Cost is measured only with --billing.`;

const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 << 20, ...opts }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const walk = (dir, rel = '') => fs.existsSync(path.join(dir, rel))
  ? fs.readdirSync(path.join(dir, rel), { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(dir, path.join(rel, d.name)) : [path.join(rel, d.name).replace(/\\/g, '/')]))
  : [];

function loadCase(id) {
  return JSON.parse(fs.readFileSync(path.join(CASES, id, 'case.json'), 'utf8'));
}

// Returns a list of problems; empty means the case is runnable.
function validateCase(id) {
  const errs = [];
  const bad = (m) => errs.push(`${id}: ${m}`);
  let c;
  try { c = loadCase(id); } catch (e) { return [`${id}: case.json unreadable (${e.message})`]; }
  const dir = path.join(CASES, id), sandbox = `eval-sandbox/${id}/`;
  if (c.id !== id) bad('id must equal the directory name');
  if (!GOALS.includes(c.goal)) bad(`goal must be one of ${GOALS.join(', ')}`);
  for (const k of ['description', 'pr_title', 'pr_body']) if (typeof c[k] !== 'string' || !c[k].trim()) bad(`${k} must be a non-empty string`);
  if (/claude|generated with|co-authored|\u{1F916}/iu.test(`${c.pr_title}\n${c.pr_body}`)) bad('PR text must not carry attribution');
  const base = walk(path.join(dir, 'base')), head = walk(path.join(dir, 'head'));
  const inBase = new Set(base.map((f) => sandbox + f)), inHead = new Set(head.map((f) => sandbox + f));
  if (!Array.isArray(c.delete)) bad('delete must be an array');
  for (const d of c.delete || []) if (!d.startsWith(sandbox) || !inBase.has(d)) bad(`delete ${d} must be a base file under ${sandbox}`);
  if (!head.length && !(c.delete || []).length) bad('head changes nothing');
  const e = c.expected;
  for (const a of e?.acceptable || []) if (!a.kind || ![].concat(a.path || []).length || !Number.isInteger(a.line) || !a.reason) bad(`acceptable needs kind, path, integer line and reason: ${JSON.stringify(a)}`);
  if (!e || !Array.isArray(e.findings) || !Array.isArray(e.must_not)) return [...errs, `${id}: expected.findings and expected.must_not must be arrays`];
  for (const f of e.findings) {
    const paths = [].concat(f.path || []);
    if (!f.kind || !paths.length || !Number.isInteger(f.line)) { bad(`finding needs kind, path and integer line: ${JSON.stringify(f)}`); continue; }
    for (const p of paths) if (!p.startsWith(sandbox) || !(inHead.has(p) || inBase.has(p))) bad(`finding path ${p} is not a case file`);
    const p = paths[0], src = inHead.has(p) ? path.join(dir, 'head') : path.join(dir, 'base');
    if (f.quote && (inHead.has(p) || inBase.has(p))) {
      const line = fs.readFileSync(path.join(src, p.slice(sandbox.length)), 'utf8').split('\n')[f.line - 1];
      if (!(line || '').includes(f.quote)) bad(`${p}:${f.line} does not contain "${f.quote}"`);
    }
  }
  return errs;
}

const allIds = () => fs.readdirSync(CASES).filter((d) => fs.existsSync(path.join(CASES, d, 'case.json'))).sort();

function git(wt, args, extra = {}) { return sh('git', ['-C', wt, ...args], extra); }
const push = (wt, branch) => git(wt, ['-c', 'credential.helper=', '-c', `credential.helper=${process.env.SPECGUARD_EVAL_CRED_HELPER || '!gh auth git-credential'}`, 'push', '-q', '-u', 'origin', branch]);
const ghJson = (args) => JSON.parse(sh('gh', args));
// Repo variable SPECGUARD_EVAL_MODEL is read by the dogfood step; null means unset.
const VAR = 'SPECGUARD_EVAL_MODEL';
// Only "not found" means unset; any other failure must not look like unset, or restore() would delete a real variable.
function varLookup(get) {
  try { return get(); } catch (e) {
    const msg = String(e.stderr || e.message);
    if (/HTTP 404|not found/i.test(msg)) return null;
    throw new Error(`could not read repo variable (aborting before changing any variable): ${msg.trim().split('\n')[0]}`);
  }
}
const getVar = (repo, name = VAR) => varLookup(() => sh('gh', ['variable', 'get', name, '--repo', repo]));
const setVar = (repo, v, name = VAR) => (v == null ? (() => { try { sh('gh', ['variable', 'delete', name, '--repo', repo]); } catch {} })() : sh('gh', ['variable', 'set', name, '--body', v, '--repo', repo]));
// Combined mode: x1 (expect_skip) cannot coexist with code changes; x2's prompt injection would contaminate every other scenario.
const COMBINED_SKIP = ['x1', 'x2'];
const BUDGET = 30, BUDGET_VAR = 'SPECGUARD_EVAL_MAX_COMMENTS';

// Assumed response of users/<owner>/settings/billing/usage: { usageItems: [{ product, sku, grossAmount, netAmount, ... }] }.
// Copilot items = product or sku containing "copilot"; amount = netAmount, else grossAmount. Anything else is skipped.
const utcDay = (d = new Date()) => `year=${d.getUTCFullYear()}&month=${d.getUTCMonth() + 1}&day=${d.getUTCDate()}`;
// premium_request/usage is Copilot-only: when it returns items use only those, else the Copilot SKUs of the general endpoint.
function copilotItems(general, premium) {
  const bySku = {};
  for (const i of premium.length ? premium : general.filter((i) => /copilot/i.test(`${i.product} ${i.sku}`))) {
    const k = `${i.sku || i.product}${i.model ? ` ${i.model}` : ''}`;
    bySku[k] = (bySku[k] || 0) + (Number(i.netAmount ?? i.grossAmount) || 0);
  }
  return bySku;
}
function billingTotals(owner, day) {
  const [general, premium] = ['usage', 'premium_request/usage'].map((ep) => {
    const j = JSON.parse(sh('gh', ['api', `users/${owner}/settings/billing/${ep}?${day}`]));
    if (!Array.isArray(j.usageItems)) throw new Error(`unexpected billing response shape from ${ep} (keys: ${Object.keys(j).join(',')}); expected usageItems[]`);
    return j.usageItems;
  });
  return copilotItems(general, premium);
}
function billingDelta(before, after) {
  // No Copilot items at all means AI Credits are not itemized (or are delayed) here: never report that as $0.
  if (!Object.keys(after).length) throw new Error('billing API returned no Copilot usage items (AI Credits not itemized or delayed); check the billing page');
  const bySku = {};
  for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) bySku[k] = +((after[k] || 0) - (before[k] || 0)).toFixed(4);
  return { cost_usd_delta: +Object.values(bySku).reduce((a, b) => a + b, 0).toFixed(4), cost_by_sku: bySku };
}
const ghLines = (endpoint) => sh('gh', ['api', '--paginate', endpoint, '--jq', '.[]']).split('\n').filter(Boolean).map((l) => JSON.parse(l));

// One PR for several cases: merged overlay (no path may appear twice) and one body section per case. extractCriteria
// numbers R1..Rn across the whole body, so criterion ids differ from the isolated runs; grading is by path, so that is fine.
// "## <id>: <title>" is a level-2 heading, which ends the previous case's "## Acceptance criteria" section, so each case's list stays its own.
function combine(cs) {
  const files = { base: [], head: [], delete: cs.flatMap((c) => c.delete) };
  for (const layer of ['base', 'head']) files[layer] = cs.flatMap((c) => walk(path.join(CASES, c.id, layer)).map((f) => `eval-sandbox/${c.id}/${f}`));
  for (const [layer, list] of Object.entries(files)) if (new Set(list).size !== list.length) throw new Error(`a path appears twice in the combined ${layer} overlay`);
  const title = `SpecGuard combined evaluation (${cs.length} cases)`;
  const body = cs.map((c) => `## ${c.id}: ${c.pr_title}\n\n${c.pr_body.trim()}`).join('\n\n') + '\n';
  const criteria = extractCriteria([{ source: 'PR body', text: `${title}\n${body}` }]);
  return { title, body, criteria, files, expected: cs.reduce((t, c) => t + c.expected.findings.length, 0) };
}

function stage(wt, cs, layer, message) {
  for (const c of cs) {
    const src = path.join(CASES, c.id, layer);
    if (fs.existsSync(src)) fs.cpSync(src, path.join(wt, 'eval-sandbox', c.id), { recursive: true });
    if (layer === 'head') for (const d of c.delete) fs.rmSync(path.join(wt, d), { force: true });
  }
  git(wt, ['add', '-A']); // fresh worktree: only these cases' overlays and deletes are changed
  git(wt, ['commit', '-q', '--allow-empty', '-m', message]);
}

async function waitForRun({ repo, branch, sha, workflow, timeoutMs = 25 * 60e3 }) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const run = ghJson(['run', 'list', '--repo', repo, '--branch', branch, '--event', 'pull_request', '--limit', '20',
      '--json', 'databaseId,headSha,status,conclusion,workflowName,url']).find((r) => r.headSha === sha && r.workflowName === workflow);
    if (run && run.status === 'completed') return run;
    await sleep(20e3);
  }
  throw new Error(`timed out waiting for ${workflow} on ${branch}`);
}

// Non-fatal: the dogfood job uploads .specguard-ctx as artifact specguard-ctx. The artifact can lag the "completed" run, so retry;
// a failure is recorded in raw_error, never swallowed.
async function rawOutput(repo, runId, tries = 5, waitMs = 10e3) {
  let err = '';
  for (let i = 0; i < tries; i++) {
    if (i) await sleep(waitMs);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'specguard-ctx-'));
    try {
      sh('gh', ['run', 'download', String(runId), '--repo', repo, '-n', 'specguard-ctx', '-D', tmp]);
      const files = walk(tmp), at = (n) => files.find((f) => path.basename(f) === n);
      const first = ['copilot.out', 'claude.json', 'findings.json'].map(at).find(Boolean);
      const found = at('findings.json');
      let valid = false;
      if (found) try { JSON.parse(fs.readFileSync(path.join(tmp, found), 'utf8')); valid = true; } catch {}
      return { raw_findings_present: !!found, raw_findings_valid_json: valid, raw_excerpt: first ? fs.readFileSync(path.join(tmp, first), 'utf8').slice(0, 2000) : '' };
    } catch (e) { err = String(e.stderr || e.message || e).trim().split('\n')[0]; } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  }
  return { raw_error: `artifact download failed after ${tries} tries: ${err}` };
}

// Opens one PR for the cases cs, waits for the Action, returns what it posted. Errors carry pr_url.
async function runPR({ repo, target, cs, name, title, body, n, runId, keep, workflow }) {
  const tag = `eval/${runId}-${name}-${n}`, baseBr = `${tag}-base`, headBr = `${tag}-head`;
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'specguard-eval-'));
  let pr = null;
  const pushed = [];
  try {
    fs.rmSync(wt, { recursive: true, force: true });
    sh('git', ['worktree', 'add', '-q', '--detach', wt, `origin/${target}`], { cwd: ROOT });
    git(wt, ['checkout', '-q', '-b', baseBr]);
    stage(wt, cs, 'base', `eval ${name} base`);
    push(wt, baseBr); pushed.push(baseBr);
    git(wt, ['checkout', '-q', '-b', headBr]);
    stage(wt, cs, 'head', `eval ${name} head`);
    push(wt, headBr); pushed.push(headBr);
    const sha = git(wt, ['rev-parse', 'HEAD']);
    const url = sh('gh', ['pr', 'create', '--repo', repo, '--base', baseBr, '--head', headBr, '--title', title, '--body', body]).split('\n').pop();
    pr = { url, number: +url.match(/(\d+)\s*$/)[1] };

    const run = await waitForRun({ repo, branch: headBr, sha, workflow });
    const job = ghJson(['run', 'view', String(run.databaseId), '--repo', repo, '--json', 'jobs']).jobs.find((j) => j.name === 'dogfood');
    const latency_s = job && job.startedAt && job.completedAt ? Math.round((Date.parse(job.completedAt) - Date.parse(job.startedAt)) / 1000) : null;

    const comments = ghLines(`repos/${repo}/pulls/${pr.number}/comments`).map(parseComment).filter(Boolean);
    const reviews = ghLines(`repos/${repo}/pulls/${pr.number}/reviews`).map((r) => ({ state: r.state, body: r.body || '' }));
    const sticky = ghLines(`repos/${repo}/issues/${pr.number}/comments`).find((x) => (x.body || '').includes('<!-- specguard:summary -->'));
    const observed = { comments, reviews, summary: sticky ? sticky.body : null, latency_s, conclusion: run.conclusion, job_conclusion: job && job.conclusion, ...await rawOutput(repo, run.databaseId) };
    return { observed, url, run };
  } catch (e) {
    throw Object.assign(e, { pr_url: pr && pr.url });
  } finally {
    if (!keep) {
      if (pr) try { sh('gh', ['pr', 'close', String(pr.number), '--repo', repo]); } catch {}
      for (const b of pushed) try { sh('gh', ['api', '-X', 'DELETE', `repos/${repo}/git/refs/heads/${b}`]); } catch {}
    }
    try { sh('git', ['worktree', 'remove', '--force', wt], { cwd: ROOT }); } catch { fs.rmSync(wt, { recursive: true, force: true }); try { sh('git', ['worktree', 'prune'], { cwd: ROOT }); } catch {} }
  }
}

async function runOne({ c, n, ...rest }) {
  try {
    const { observed, url, run } = await runPR({ ...rest, cs: [c], name: c.id, title: c.pr_title, body: c.pr_body, n });
    return { ...grade(c, observed), rep: n, pr_url: url, run_url: run.url, conclusion: run.conclusion, job_conclusion: observed.job_conclusion, observed };
  } catch (e) {
    return { id: c.id, goal: c.goal, rep: n, error: String(e.message || e).split('\n')[0], pr_url: e.pr_url };
  }
}

// One combined PR: each case is graded against the findings under its own sandbox path; json_valid/complete come from the single run.
async function runCombined({ cs, n, ...rest }) {
  const prefix = (c) => `eval-sandbox/${c.id}/`;
  try {
    const { title, body } = combine(cs);
    const { observed, url, run } = await runPR({ ...rest, cs, name: 'combined', title, body, n });
    const inScope = (p) => cs.some((c) => String(p).startsWith(prefix(c)));
    const rows = cs.map((c) => ({ ...grade(c, { ...observed, comments: observed.comments.filter((x) => String(x.path).startsWith(prefix(c))), summary: filterSummary(observed.summary, prefix(c)) }), rep: n, pr_url: url, run_url: run.url, conclusion: run.conclusion, job_conclusion: observed.job_conclusion }));
    const sum = (k) => rows.reduce((t, r) => t + r[k], 0);
    const outside = observed.comments.filter((x) => x.confidence === 'high' && !inScope(x.path)).length;
    const items = parseSummary(observed.summary).items;
    return { rows, combined: { rep: n, pr_url: url, run_url: run.url, pass: rows.every((r) => r.pass), tp: sum('tp'), fp: sum('fp') + outside, fn: sum('fn'), outside_fp: outside, outside_summary: items.filter((i) => !inScope(i.path)).length,
      posted: observed.comments.length, budget: BUDGET, overflow: items.filter((i) => /over max_comments/.test(i.why)).length, latency_s: observed.latency_s, observed } };
  } catch (e) {
    const error = String(e.message || e).split('\n')[0];
    return { rows: cs.map((c) => ({ id: c.id, goal: c.goal, rep: n, error, pr_url: e.pr_url })), combined: { rep: n, error, pr_url: e.pr_url } };
  }
}

const pct = (x) => (x == null ? 'n/a' : `${(x * 100).toFixed(0)}%`);
const sec = (x) => (x == null ? 'n/a' : `${x}s`);
function markdown({ runId, repo, target, model, cost, results, agg, combined }) {
  const why = (r) => (r.error ? `error: ${r.error}` : [
    ...r.missed.map((e) => `FN ${[].concat(e.kind).join('|')} ${[].concat(e.path)[0].split('/').pop()}:${e.line}`),
    ...(r.acceptable_findings || []).map((f) => `acceptable ${f.kind} ${f.path.split("/").pop()}:${f.line}`),
    ...r.false_positives.map((f) => `FP ${f.kind} ${f.path.split('/').pop()}:${f.line}`),
    ...r.must_not_violations.map((m) => `must_not ${JSON.stringify(m)}`),
    ...r.text_misses.map((e) => `text /${e.text}/`),
    ...(r.json_valid ? [] : ['model JSON missing or invalid']), ...(r.complete ? [] : ['incomplete']), ...(r.degraded ? [`degraded: ${r.validation_notes.length} validation note(s)`] : []), ...(r.skip_ok ? [] : ['not skipped']), ...(r.clean_ok ? [] : ['not clean']),
  ].join('; '));
  let s = `# Evaluation ${runId}\n\n${combined ? `Mode: combined: ${combined.cases.length} cases in one PR, budget ${BUDGET} (${combined.cases.join(', ')}). Results measure big-PR behaviour, not per-scenario accuracy; findings outside every sandbox count as FP of the combined run.\n\n` : ''}Repo ${repo}, target ${target}. Model: ${model} (requested via SPECGUARD_EVAL_MODEL; the Copilot output does not state the model actually used). ${cost.cost_usd_delta == null ? `Cost: ${cost.cost}` : `Cost delta: $${cost.cost_usd_delta} (${Object.entries(cost.cost_by_sku).map(([k, v]) => `${k} $${v}`).join(', ') || 'no Copilot items'}); billing is day-granular and includes any other Copilot usage in the window`}. Latency is the dogfood job duration.\n\n`;
  s += '| Case | Goal | Rep | Pass | TP | FP | Acceptable | FN | Summary only | JSON valid | Degraded | Latency | Notes |\n|---|---|---|---|---|---|---|---|---|---|---|---|---|\n';
  for (const r of results) s += r.error
    ? `| ${r.id} | ${r.goal} | ${r.rep} | error | | | | | | | | | ${why(r)} |\n`
    : `| ${r.id} | ${r.goal} | ${r.rep} | ${r.pass ? 'yes' : 'no'} | ${r.tp} | ${r.fp} | ${r.acceptable || 0} | ${r.fn} | ${r.summary_only} | ${r.json_valid ? 'yes' : 'no'} | ${r.degraded ? 'yes' : 'no'} | ${sec(r.latency_s)} | ${why(r)} |\n`;
  const row = (name, a) => `| ${name} | ${a.runs} | ${a.errors} | ${a.acceptable} | ${pct(a.precision)} | ${pct(a.recall)} | ${pct(a.json_valid_rate)} | ${pct(a.degraded_rate)} | ${pct(a.pass_rate)} | ${sec(a.latency_median_s)} | ${sec(a.latency_max_s)} |\n`;
  s += '\n## Aggregate\n\n| Scope | Runs | Errors | Acceptable | Precision | Recall | JSON valid | Degraded | Pass rate | Latency median | Latency max |\n|---|---|---|---|---|---|---|---|---|---|---|\n' + row('all', agg);
  for (const [g, a] of Object.entries(agg.by_goal)) s += row(g, a);
  if (combined) {
    s += '\n## Combined PR\n\n| Rep | Pass | TP | FP | FN | Outside sandbox (FP) | Posted / budget | Summary overflow | Latency | PR |\n|---|---|---|---|---|---|---|---|---|---|\n';
    for (const r of combined.reps) s += r.error ? `| ${r.rep} | error | | | | | | | | ${r.error} |\n`
      : `| ${r.rep} | ${r.pass ? 'yes' : 'no'} | ${r.tp} | ${r.fp} | ${r.fn} | ${r.outside_fp} | ${r.posted} / ${r.budget} | ${r.overflow} | ${sec(r.latency_s)} | ${r.pr_url} |\n`;
  }
  return s;
}

async function main() {
  const { values: o } = require('node:util').parseArgs({ options: {
    repo: { type: 'string' }, target: { type: 'string' }, cases: { type: 'string' }, runs: { type: 'string', default: '1' }, 'run-id': { type: 'string' }, model: { type: 'string' }, billing: { type: 'boolean' }, combined: { type: 'boolean' },
    workflow: { type: 'string', default: 'CI' }, keep: { type: 'boolean' }, 'dry-run': { type: 'boolean' }, help: { type: 'boolean' } } });
  if (o.help) return console.log(USAGE);
  let ids = o.cases ? o.cases.split(',').map((s) => s.trim()) : allIds();
  if (o.combined) ids = ids.filter((id) => !COMBINED_SKIP.includes(id));
  const errs = ids.flatMap((id) => (fs.existsSync(path.join(CASES, id)) ? validateCase(id) : [`${id}: no such case`]));
  if (errs.length) { console.error(errs.join('\n')); process.exit(1); }
  if (o['dry-run'] && o.combined) {
    const m = combine(ids.map(loadCase));
    return console.log(`ok combined: ${ids.join(', ')}\n${ids.length} cases, ${m.criteria.length} criteria extracted, ${m.expected} expected findings, ${m.files.base.length} base files, ${m.files.head.length} head files, ${m.files.delete.length} deletes, no duplicate paths, budget ${BUDGET}`);
  }
  if (o['dry-run']) return ids.forEach((id) => { const c = loadCase(id); console.log(`ok ${id} (${c.goal}) ${c.expected.findings.length} expected, ${walk(path.join(CASES, id, 'base')).length} base files, ${walk(path.join(CASES, id, 'head')).length} head files`); });
  if (!o.repo || !o.target) { console.error(USAGE); process.exit(2); }

  const model = o.model || 'unchanged';
  const runId = o['run-id'] || `${new Date().toISOString().replace(/\.\d+Z$/, '').replace(/[-:]/g, '').replace('T', '-')}${o.model ? `-${o.model.replace(/[^\w.-]/g, '_')}` : ''}`;
  sh('git', ['fetch', '-q', 'origin', o.target], { cwd: ROOT });
  const saved = []; // [name, previous value] of every repo variable overridden for this batch; null means unset
  const override = (name, v) => { saved.push([name, getVar(o.repo, name)]); setVar(o.repo, v, name); };
  const restore = () => { while (saved.length) { const [name, prev] = saved.pop(); try { setVar(o.repo, prev, name); console.log(`restored ${name} to ${prev == null ? '(unset)' : prev}`); } catch (e) { console.error(`could NOT restore ${name} (was ${prev}): ${e.message}`); } } };
  process.on('SIGINT', () => { restore(); process.exit(130); });
  let cost = { cost: 'not measured (pass --billing)' }, before;
  const day = utcDay(); // one date for both snapshots
  const results = [], reps = [];
  try {
    if (o.model) override(VAR, o.model === 'default' ? null : o.model);
    if (o.combined) override(BUDGET_VAR, String(BUDGET));
    if (o.billing) try { before = billingTotals(o.repo.split('/')[0], day); } catch (e) { cost = { cost: `not measured: ${String(e.stderr || e.message).trim().split('\n')[0]}` }; }
    if (o.combined) for (let n = 1; n <= +o.runs; n++) {
      console.log(`running combined #${n} (${ids.length} cases)`);
      const r = await runCombined({ repo: o.repo, target: o.target, cs: ids.map(loadCase), n, runId, keep: o.keep, workflow: o.workflow });
      results.push(...r.rows.map((x) => ({ ...x, model })));
      reps.push(r.combined);
      const k = r.combined;
      console.log(k.error ? `  error: ${k.error}` : `  ${k.pass ? 'pass' : 'FAIL'} tp=${k.tp} fp=${k.fp} fn=${k.fn} outside=${k.outside_fp} posted=${k.posted}/${k.budget} overflow=${k.overflow}`);
    }
    else for (const id of ids) for (let n = 1; n <= +o.runs; n++) {
      console.log(`running ${id} #${n}`);
      const r = { ...await runOne({ repo: o.repo, target: o.target, c: loadCase(id), n, runId, keep: o.keep, workflow: o.workflow }), model };
      results.push(r);
      console.log(r.error ? `  error: ${r.error}` : `  ${r.pass ? 'pass' : 'FAIL'} tp=${r.tp} fp=${r.fp} fn=${r.fn} latency=${sec(r.latency_s)}`);
    }
    if (before) try { cost = utcDay() !== day ? { cost: 'not measured: batch crossed UTC midnight' } : billingDelta(before, billingTotals(o.repo.split('/')[0], day)); } catch (e) { cost = { cost: `not measured: ${String(e.stderr || e.message).trim().split('\n')[0]}` }; }
  } finally { restore(); }
  const agg = aggregate(results);
  const combined = o.combined ? { cases: ids, budget: BUDGET, reps } : null;
  const dir = path.join(__dirname, 'results');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${runId}.json`), JSON.stringify({ runId, repo: o.repo, target: o.target, model, ...cost, ...(combined && { combined }), results, aggregate: agg }, null, 2) + '\n');
  fs.writeFileSync(path.join(dir, `${runId}.md`), markdown({ runId, repo: o.repo, target: o.target, model, cost, results, agg, combined }));
  console.log(`\nwrote eval/results/${runId}.json and .md`);
  console.log(cost.cost_usd_delta == null ? `Cost: ${cost.cost}` : `Cost delta $${cost.cost_usd_delta}`);
}

if (require.main === module) main().catch((e) => { console.error(e.message); process.exit(1); });
module.exports = { copilotItems, utcDay, varLookup, rawOutput, validateCase, allIds, loadCase, markdown, combine, COMBINED_SKIP };
