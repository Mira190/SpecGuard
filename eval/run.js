#!/usr/bin/env node
// Runs the acceptance cases against the real Action on GitHub (gh + git), grades them, writes eval/results/<runId>.{json,md}.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { grade, aggregate, parseComment } = require('./grade.js');

const ROOT = path.join(__dirname, '..');
const CASES = path.join(__dirname, 'cases');
const GOALS = ['requirements', 'test_quality', 'standards', 'layering', 'robustness'];
const USAGE = `Usage: node eval/run.js --repo OWNER/REPO --target BRANCH [options]

  --repo OWNER/REPO   repository that has the Action wired up in its CI workflow; origin must point at it
  --target BRANCH     branch the sandbox PRs are based on (must contain the Action and workflow)
  --cases r1,t2       comma-separated case ids (default: all)
  --runs N            repetitions per case (default 1)
  --run-id ID         result file name (default: timestamp)
  --workflow NAME     workflow to wait for (default: CI)
  --keep              keep the PRs and branches
  --dry-run           validate the case directories and exit; no git, no GitHub
  --help

Push auth: git credential helper "!gh auth git-credential"; override with SPECGUARD_EVAL_CRED_HELPER.
Runs are sequential and open real PRs, so each run spends Copilot credits. Cost is not measured.`;

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
const ghLines = (endpoint) => sh('gh', ['api', '--paginate', endpoint, '--jq', '.[]']).split('\n').filter(Boolean).map((l) => JSON.parse(l));

function stage(wt, c, layer, message) {
  const src = path.join(CASES, c.id, layer);
  if (fs.existsSync(src)) fs.cpSync(src, path.join(wt, 'eval-sandbox', c.id), { recursive: true });
  if (layer === 'head') for (const d of c.delete) fs.rmSync(path.join(wt, d), { force: true });
  git(wt, ['add', '-A']); // fresh worktree: only this case's overlay and deletes are changed
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

async function runOne({ repo, target, c, n, runId, keep, workflow }) {
  const tag = `eval/${runId}-${c.id}-${n}`, baseBr = `${tag}-base`, headBr = `${tag}-head`;
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'specguard-eval-'));
  let pr = null;
  const pushed = [];
  try {
    fs.rmSync(wt, { recursive: true, force: true });
    sh('git', ['worktree', 'add', '-q', '--detach', wt, `origin/${target}`], { cwd: ROOT });
    git(wt, ['checkout', '-q', '-b', baseBr]);
    stage(wt, c, 'base', `eval ${c.id} base`);
    push(wt, baseBr); pushed.push(baseBr);
    git(wt, ['checkout', '-q', '-b', headBr]);
    stage(wt, c, 'head', `eval ${c.id} head`);
    push(wt, headBr); pushed.push(headBr);
    const sha = git(wt, ['rev-parse', 'HEAD']);
    const url = sh('gh', ['pr', 'create', '--repo', repo, '--base', baseBr, '--head', headBr, '--title', c.pr_title, '--body', c.pr_body]).split('\n').pop();
    pr = { url, number: +url.match(/(\d+)\s*$/)[1] };

    const run = await waitForRun({ repo, branch: headBr, sha, workflow });
    const job = ghJson(['run', 'view', String(run.databaseId), '--repo', repo, '--json', 'jobs']).jobs.find((j) => j.name === 'dogfood');
    const latency_s = job && job.startedAt && job.completedAt ? Math.round((Date.parse(job.completedAt) - Date.parse(job.startedAt)) / 1000) : null;

    const comments = ghLines(`repos/${repo}/pulls/${pr.number}/comments`).map(parseComment).filter(Boolean);
    const reviews = ghLines(`repos/${repo}/pulls/${pr.number}/reviews`).map((r) => ({ state: r.state, body: r.body || '' }));
    const sticky = ghLines(`repos/${repo}/issues/${pr.number}/comments`).find((x) => (x.body || '').includes('<!-- specguard:summary -->'));
    const observed = { comments, reviews, summary: sticky ? sticky.body : null, latency_s, conclusion: run.conclusion, job_conclusion: job && job.conclusion, ...await rawOutput(repo, run.databaseId) };
    return { ...grade(c, observed), rep: n, pr_url: url, run_url: run.url, conclusion: run.conclusion, job_conclusion: observed.job_conclusion, observed };
  } catch (e) {
    return { id: c.id, goal: c.goal, rep: n, error: String(e.message || e).split('\n')[0], pr_url: pr && pr.url };
  } finally {
    if (!keep) {
      if (pr) try { sh('gh', ['pr', 'close', String(pr.number), '--repo', repo]); } catch {}
      for (const b of pushed) try { sh('gh', ['api', '-X', 'DELETE', `repos/${repo}/git/refs/heads/${b}`]); } catch {}
    }
    try { sh('git', ['worktree', 'remove', '--force', wt], { cwd: ROOT }); } catch { fs.rmSync(wt, { recursive: true, force: true }); try { sh('git', ['worktree', 'prune'], { cwd: ROOT }); } catch {} }
  }
}

const pct = (x) => (x == null ? 'n/a' : `${(x * 100).toFixed(0)}%`);
const sec = (x) => (x == null ? 'n/a' : `${x}s`);
function markdown({ runId, repo, target, results, agg }) {
  const why = (r) => (r.error ? `error: ${r.error}` : [
    ...r.missed.map((e) => `FN ${[].concat(e.kind).join('|')} ${[].concat(e.path)[0].split('/').pop()}:${e.line}`),
    ...r.false_positives.map((f) => `FP ${f.kind} ${f.path.split('/').pop()}:${f.line}`),
    ...r.must_not_violations.map((m) => `must_not ${JSON.stringify(m)}`),
    ...r.text_misses.map((e) => `text /${e.text}/`),
    ...(r.json_valid ? [] : ['model JSON missing or invalid']), ...(r.complete ? [] : ['incomplete']), ...(r.degraded ? [`degraded: ${r.validation_notes.length} validation note(s)`] : []), ...(r.skip_ok ? [] : ['not skipped']), ...(r.clean_ok ? [] : ['not clean']),
  ].join('; '));
  let s = `# Evaluation ${runId}\n\nRepo ${repo}, target ${target}. Cost: not measured (check the Copilot billing page for the run window). Latency is the dogfood job duration.\n\n`;
  s += '| Case | Goal | Rep | Pass | TP | FP | FN | Summary only | JSON valid | Degraded | Latency | Notes |\n|---|---|---|---|---|---|---|---|---|---|---|---|\n';
  for (const r of results) s += r.error
    ? `| ${r.id} | ${r.goal} | ${r.rep} | error | | | | | | | | ${why(r)} |\n`
    : `| ${r.id} | ${r.goal} | ${r.rep} | ${r.pass ? 'yes' : 'no'} | ${r.tp} | ${r.fp} | ${r.fn} | ${r.summary_only} | ${r.json_valid ? 'yes' : 'no'} | ${r.degraded ? 'yes' : 'no'} | ${sec(r.latency_s)} | ${why(r)} |\n`;
  const row = (name, a) => `| ${name} | ${a.runs} | ${a.errors} | ${pct(a.precision)} | ${pct(a.recall)} | ${pct(a.json_valid_rate)} | ${pct(a.degraded_rate)} | ${pct(a.pass_rate)} | ${sec(a.latency_median_s)} | ${sec(a.latency_max_s)} |\n`;
  s += '\n## Aggregate\n\n| Scope | Runs | Errors | Precision | Recall | JSON valid | Degraded | Pass rate | Latency median | Latency max |\n|---|---|---|---|---|---|---|---|---|---|\n' + row('all', agg);
  for (const [g, a] of Object.entries(agg.by_goal)) s += row(g, a);
  return s;
}

async function main() {
  const { values: o } = require('node:util').parseArgs({ options: {
    repo: { type: 'string' }, target: { type: 'string' }, cases: { type: 'string' }, runs: { type: 'string', default: '1' }, 'run-id': { type: 'string' },
    workflow: { type: 'string', default: 'CI' }, keep: { type: 'boolean' }, 'dry-run': { type: 'boolean' }, help: { type: 'boolean' } } });
  if (o.help) return console.log(USAGE);
  const ids = o.cases ? o.cases.split(',').map((s) => s.trim()) : allIds();
  const errs = ids.flatMap((id) => (fs.existsSync(path.join(CASES, id)) ? validateCase(id) : [`${id}: no such case`]));
  if (errs.length) { console.error(errs.join('\n')); process.exit(1); }
  if (o['dry-run']) return ids.forEach((id) => { const c = loadCase(id); console.log(`ok ${id} (${c.goal}) ${c.expected.findings.length} expected, ${walk(path.join(CASES, id, 'base')).length} base files, ${walk(path.join(CASES, id, 'head')).length} head files`); });
  if (!o.repo || !o.target) { console.error(USAGE); process.exit(2); }

  const runId = o['run-id'] || new Date().toISOString().replace(/\.\d+Z$/, '').replace(/[-:]/g, '').replace('T', '-');
  sh('git', ['fetch', '-q', 'origin', o.target], { cwd: ROOT });
  const results = [];
  for (const id of ids) for (let n = 1; n <= +o.runs; n++) {
    console.log(`running ${id} #${n}`);
    const r = await runOne({ repo: o.repo, target: o.target, c: loadCase(id), n, runId, keep: o.keep, workflow: o.workflow });
    results.push(r);
    console.log(r.error ? `  error: ${r.error}` : `  ${r.pass ? 'pass' : 'FAIL'} tp=${r.tp} fp=${r.fp} fn=${r.fn} latency=${sec(r.latency_s)}`);
  }
  const agg = aggregate(results);
  const dir = path.join(__dirname, 'results');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${runId}.json`), JSON.stringify({ runId, repo: o.repo, target: o.target, results, aggregate: agg }, null, 2) + '\n');
  fs.writeFileSync(path.join(dir, `${runId}.md`), markdown({ runId, repo: o.repo, target: o.target, results, agg }));
  console.log(`\nwrote eval/results/${runId}.json and .md`);
  console.log('Cost not measured: check the Copilot billing page (AI Credits) for the time window of this run.');
}

if (require.main === module) main().catch((e) => { console.error(e.message); process.exit(1); });
module.exports = { rawOutput, validateCase, allIds, loadCase, markdown };
