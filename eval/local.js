#!/usr/bin/env node
// Local evaluation harness: runs the real collect.sh and post.js for eval cases with no GitHub and no Copilot.
// The model step is done externally: `prepare` writes <out>/<id>/prompt.md, an agent writes <out>/<id>/ctx/findings.json,
// `finish` posts it through the real post.run against a fake GitHub and grades what was posted.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { grade, aggregate, parseComment } = require('./grade.js');
const { allIds, loadCase } = require('./run.js');
const { assemble } = require('../src/prompt.js');

const ROOT = path.join(__dirname, '..');
const CASES = path.join(__dirname, 'cases');
const SKILL = path.join(ROOT, 'skills', 'test-review');
const USAGE = `Usage:
  node eval/local.js prepare --case ID[,ID...|all] --out DIR [--trace auto|off]
  node eval/local.js finish  --case ID[,ID...|all] --out DIR [--json]

prepare builds <out>/<id>/repo (base + head commits), runs the real src/collect.sh into <out>/<id>/ctx and writes <out>/<id>/prompt.md.
An external model agent then writes <out>/<id>/ctx/findings.json. finish runs the real src/post.js on it and grades the result.`;

const fwd = (p) => path.resolve(p).replace(/\\/g, '/');
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const readLines = (p) => { try { return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean); } catch { return []; } };

function resolveCases(arg) {
  if (!arg) throw new Error('--case is required');
  const ids = arg === 'all' ? allIds() : arg.split(',').map((s) => s.trim()).filter(Boolean);
  for (const id of ids) if (!fs.existsSync(path.join(CASES, id, 'case.json'))) throw new Error(`no such case: ${id}`);
  return ids;
}

// The production prompt: src/prompt.js is the single assembler (action.yml calls it too). Local agents have no --json-schema flag, hence 'copilot' wording.
function buildPrompt(ctx) {
  return assemble({ skillDir: SKILL, ctxDir: ctx, schemaPath: path.join(ROOT, 'src', 'findings.schema.json') });
}

// Preloaded into collect.sh's node processes: requirements.js calls `gh`, which has no network here. Serves the case's PR from a file.
const SHIM = `const cp = require('node:child_process'), fs = require('node:fs'), orig = cp.execFileSync;
cp.execFileSync = function (file, args) {
  if (file !== 'gh') return orig.apply(this, arguments);
  if (args[0] === 'pr' && args[1] === 'view') return fs.readFileSync(process.env.SG_PR_JSON, 'utf8');
  if (args[0] === 'api') return '[]';
  throw new Error('gh is offline');
};
`;

function buildRepo(id, c, repo) {
  fs.rmSync(repo, { recursive: true, force: true });
  fs.mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q');
  for (const [k, v] of [['user.name', 'specguard-local'], ['user.email', 'local@example.invalid'], ['core.autocrlf', 'false'], ['commit.gpgsign', 'false']]) git(repo, 'config', k, v);
  const stage = (layer, message) => {
    const src = path.join(CASES, id, layer);
    if (fs.existsSync(src)) fs.cpSync(src, path.join(repo, 'eval-sandbox', id), { recursive: true });
    if (layer === 'head') for (const d of c.delete || []) fs.rmSync(path.join(repo, d), { force: true });
    fs.rmSync(path.join(repo, '.git', 'index'), { force: true }); // same-size rewrites within one timestamp tick are invisible to git's stat cache
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '--allow-empty', '-m', message);
    return git(repo, 'rev-parse', 'HEAD');
  };
  const base = stage('base', `${id} base`);
  return { base, head: stage('head', `${id} head`) };
}

function prepareOne(id, out, trace = 'auto') {
  const c = loadCase(id), dir = path.resolve(out, id), repo = path.join(dir, 'repo'), ctx = path.join(dir, 'ctx');
  fs.mkdirSync(dir, { recursive: true });
  const { base, head } = buildRepo(id, c, repo);
  const shim = path.join(path.resolve(out), 'gh-shim.js'), pr = path.join(dir, 'pr.json'), outputs = path.join(dir, 'gh-output.txt');
  fs.writeFileSync(shim, SHIM);
  fs.writeFileSync(pr, JSON.stringify({ number: 1, title: c.pr_title, body: c.pr_body, closingIssuesReferences: [] }));
  fs.writeFileSync(outputs, '');
  const r = spawnSync('bash', [fwd(path.join(ROOT, 'src', 'collect.sh'))], {
    cwd: repo, encoding: 'utf8', maxBuffer: 1 << 28,
    env: { ...process.env, BASE_SHA: base, HEAD_SHA: head, CTX: fwd(ctx), TRACE: trace, REQ_PATHS: '', IGNORE_EXTRA: '', PR_NUMBER: '1', GH_REPO: 'local/eval', GH_TOKEN: 'offline',
      GITHUB_OUTPUT: fwd(outputs), SG_PR_JSON: fwd(pr), NODE_OPTIONS: `--require "${fwd(shim)}"` },
  });
  fs.writeFileSync(path.join(dir, 'collect.log'), `${r.stdout || ''}${r.stderr || ''}`);
  const outLines = readLines(outputs);
  const skip = outLines.includes('skip=true'), partial = outLines.includes('partial=true');
  const ok = r.status === 0;
  fs.writeFileSync(path.join(dir, 'prompt.md'), buildPrompt(ctx));
  const files = readLines(path.join(ctx, 'files.txt')).length, specs = readLines(path.join(ctx, 'spec-files.txt')).length;
  let specItems = 0;
  try { specItems = JSON.parse(fs.readFileSync(path.join(ctx, 'requirements-status.json'), 'utf8')).spec?.items || 0; } catch {}
  const meta = { id, base, head, pr_number: 1, skip, partial, trace, collect_ok: ok, files, spec_files: specs, spec_items: specItems, repo, ctx };
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2) + '\n');
  return meta;
}

function prepare({ cases, out, trace = 'auto', log = console.log }) {
  const metas = resolveCases(cases).map((id) => {
    let m;
    try { m = prepareOne(id, out, trace); } catch (e) { m = { id, error: String(e.message || e).split('\n')[0] }; }
    log(m.error ? `${id}: ERROR ${m.error}` : `${id}: ${m.collect_ok ? 'ok' : 'COLLECT FAILED (see collect.log)'} skipped=${m.skip} files=${m.files} spec_files=${m.spec_files} spec_items=${m.spec_items}${m.partial ? ' partial' : ''}`);
    return m;
  });
  return metas;
}

// A fake GitHub that records what post.js publishes. Nothing leaves the process.
function fakeGithub({ headSha }) {
  const posted = { comments: [], reviews: [], summary: null, warnings: [], outputs: {} };
  const fns = { listFiles: 'files', listReviewComments: 'rc', listComments: 'ic' };
  const github = {
    rest: {
      pulls: {
        get: async () => ({ data: { head: { sha: headSha }, mergeable: false } }),
        listFiles: fns.listFiles, listReviewComments: fns.listReviewComments,
        createReviewComment: async (c) => { posted.comments.push({ ...c, user: { type: 'Bot' } }); },
      },
      issues: {
        listComments: fns.listComments,
        createComment: async ({ body }) => { posted.summary = body; },
        updateComment: async ({ body }) => { posted.summary = body; },
      },
    },
    paginate: async () => [], // nothing is already posted, and every reviewable file is in the local diff
  };
  const core = {
    summary: { addRaw() { return this; }, write: async () => {} },
    warning: (m) => posted.warnings.push(String(m)), info() {}, setOutput: (k, v) => { posted.outputs[k] = String(v); }, setFailed: (m) => posted.warnings.push(`setFailed: ${m}`),
  };
  return { github, core, posted };
}

async function finishOne(id, out) {
  const c = loadCase(id), dir = path.resolve(out, id), meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
  const ctx = path.join(dir, 'ctx'), findings = path.join(ctx, 'findings.json');
  let present = fs.existsSync(findings), valid = false;
  if (present) try { JSON.parse(fs.readFileSync(findings, 'utf8')); valid = true; } catch {}
  const { github, core, posted } = fakeGithub({ headSha: meta.head });
  const context = { repo: { owner: 'local', repo: 'eval' }, serverUrl: 'https://github.com', payload: { pull_request: { number: 1, head: { sha: meta.head }, base: { sha: meta.base } } } };
  const env = { CTX: ctx, HEAD_SHA: meta.head, BASE_SHA: meta.base, GITHUB_WORKSPACE: meta.repo, SKIP: String(!!meta.skip), PARTIAL: String(!!meta.partial), MAX_COMMENTS: '10', ENGINE: 'local', MODEL: '', STANDARDS_REF: 'head', STANDARDS_CHECKS: '', UNVERIFIED_MISSING_TESTS: process.env.UNVERIFIED_MISSING_TESTS || 'show' }; // frozen evals predate the hold: default show; the caller's env may set details
  const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  try { await require('../src/post.js')({ github, context, core }); }
  finally { for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v; }

  const comments = posted.comments.map(parseComment).filter(Boolean);
  const obs = { comments, reviews: posted.reviews, summary: posted.summary, raw_findings_present: present, raw_findings_valid_json: valid };
  fs.writeFileSync(path.join(dir, 'posted.json'), JSON.stringify({ comments: posted.comments, reviews: posted.reviews, warnings: posted.warnings }, null, 2) + '\n');
  fs.writeFileSync(path.join(dir, 'summary.md'), posted.summary || '');
  return { ...grade(c, obs), engine_failed: !present };
}

function note(r) {
  return [
    ...(r.engine_failed ? ['engine failed: no findings.json'] : r.json_valid ? [] : ['findings.json invalid']),
    ...r.missed.map((e) => `FN ${[].concat(e.kind).join('|')} ${[].concat(e.path)[0].split('/').pop()}:${e.line}`),
    ...r.false_positives.map((f) => `FP ${f.kind} ${String(f.path).split('/').pop()}:${f.line}`),
    ...r.summary_misses.map((m) => `summary ${m}`),
    ...(r.skip_ok ? [] : ['not skipped']), ...(r.clean_ok ? [] : ['not clean']), ...(r.complete ? [] : ['incomplete']),
  ].join('; ');
}

function table(results) {
  const rows = results.map((r) => r.error ? [r.id, 'ERROR', '', '', '', '', '', '', r.error]
    : [r.id, r.pass ? 'PASS' : 'FAIL', r.tp, r.fp, r.fn, r.text_misses.length, r.summary_misses.length, r.must_not_violations.length, note(r)]);
  const head = ['case', 'result', 'TP', 'FP', 'FN', 'text', 'summary', 'must_not', 'notes'];
  const w = head.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
  const fmt = (r) => r.map((x, i) => String(x).padEnd(w[i])).join('  ').trimEnd();
  return [fmt(head), ...rows.map(fmt)].join('\n');
}

async function finish({ cases, out, json, log = console.log }) {
  const results = [];
  for (const id of resolveCases(cases)) {
    try { results.push(await finishOne(id, out)); } catch (e) { results.push({ id, error: String(e.message || e).split('\n')[0] }); }
  }
  const agg = aggregate(results.map((r) => (r.error ? { ...r, goal: 'error' } : r)));
  log(table(results));
  const pct = (x) => (x == null ? 'n/a' : `${(x * 100).toFixed(0)}%`);
  log(`\n${results.filter((r) => r.pass).length}/${results.length} pass; precision ${pct(agg.precision)} (delivered ${pct(agg.precision_delivered)}), recall ${pct(agg.recall)}`);
  if (json) fs.writeFileSync(path.join(path.resolve(out), 'results.json'), JSON.stringify({ results, aggregate: agg }, null, 2) + '\n');
  return { results, agg };
}

async function main() {
  const { values: o, positionals } = require('node:util').parseArgs({ allowPositionals: true, options: {
    case: { type: 'string' }, out: { type: 'string' }, trace: { type: 'string', default: 'auto' }, json: { type: 'boolean' }, help: { type: 'boolean' } } });
  const [cmd] = positionals;
  if (o.help || !['prepare', 'finish'].includes(cmd) || !o.out) { console.log(USAGE); process.exit(o.help ? 0 : 2); }
  if (!['auto', 'off'].includes(o.trace)) { console.error('--trace takes auto or off'); process.exit(2); }
  if (cmd === 'prepare') prepare({ cases: o.case, out: o.out, trace: o.trace });
  else await finish({ cases: o.case, out: o.out, json: o.json });
}

if (require.main === module) main().catch((e) => { console.error(e.message); process.exit(1); });
module.exports = { resolveCases, buildPrompt, prepare, prepareOne, fakeGithub, finish, finishOne, table };
