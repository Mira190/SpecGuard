#!/usr/bin/env node
// SZZ replay on a REAL repo (docs/traceability-plan.md 7.4.3). Same flow as eval/local.js: `prepareReal` runs the real collect.sh
// at (base, head) and writes prompt.md; an agent writes ctx/findings.json; `finishReal` runs the real post.run against a fake
// GitHub and counts findings. No case.json, so no pass/fail: grading is human adjudication against the later fix.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { buildPrompt, fakeGithub } = require('./local.js');
const { parseComment } = require('./grade.js');

const ROOT = path.join(__dirname, '..');
const fwd = (p) => path.resolve(p).replace(/\\/g, '/');
const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
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

// Clone repoDir to <out>/<id>/repo at head (full history, so base is reachable), run the real collect.sh, write prompt.md and meta.json.
// shared: true uses 'git clone --shared' (objects via .git/objects/info/alternates) instead of a full copy, saving disk. The working copy then
// DEPENDS ON repoDir staying where it is and keeping its objects: do not move, delete or gc/prune the source clone while shared copies exist.
function prepareReal({ repoDir, base, head, prTitle = '', prBody = '', out, id, trace = 'auto', shared = false }) {
  const dir = path.resolve(out, id), repo = path.join(dir, 'repo'), ctx = path.join(dir, 'ctx');
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(path.join(repo, '.git'))) {
    execFileSync('git', ['clone', '-q', ...(shared ? ['--shared'] : ['--no-hardlinks']), '--no-checkout', path.resolve(repoDir), repo], { stdio: 'pipe' });
    for (const [k, v] of [['user.name', 'specguard-local'], ['user.email', 'local@example.invalid'], ['core.autocrlf', 'false']]) git(repo, 'config', k, v);
  }
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

// Counts from the posted comments and the sticky summary. Summary-only = findings carried in full by the summary (`- **title** (`path:line`, kind, why)`),
// outside the collapsed Pre-existing drift block; findings posted as comments appear there as `- **title** — [link]` and are not counted.
function countFindings(comments, summary) {
  const inline = { total: 0, byKind: {}, byConfidence: { high: 0, low: 0 } };
  for (const c of comments.map(parseComment).filter(Boolean)) {
    inline.total++; inline.byConfidence[c.confidence]++;
    inline.byKind[c.kind] = (inline.byKind[c.kind] || 0) + 1;
  }
  let s = String(summary || '');
  const pre = /<details><summary>Pre-existing drift[^<]*<\/summary>([^]*?)<\/details>/.exec(s);
  if (pre) s = s.replace(pre[0], '');
  const count = (t) => (t.match(/^- \*\*[^\n]*?\*\* \(`[^`\n]+`, \w+/gm) || []).length;
  return { inline, summary_only: count(s), pre_existing: pre ? count(pre[1]) : 0 };
}

async function finishRealOne(id, out) {
  const dir = path.resolve(out, id), meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
  const ctx = path.join(dir, 'ctx'), present = fs.existsSync(path.join(ctx, 'findings.json'));
  const { github, core, posted } = fakeGithub({ headSha: meta.head });
  const context = { repo: { owner: 'local', repo: 'eval' }, serverUrl: 'https://github.com', payload: { pull_request: { number: 1, head: { sha: meta.head }, base: { sha: meta.base } } } };
  const env = { CTX: ctx, HEAD_SHA: meta.head, BASE_SHA: meta.base, GITHUB_WORKSPACE: meta.repo, SKIP: String(!!meta.skip), PARTIAL: String(!!meta.partial), MAX_COMMENTS: '10', ENGINE: 'local', MODEL: '', STANDARDS_REF: 'head', STANDARDS_CHECKS: '' };
  const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  try { await require('../src/post.js')({ github, context, core }); }
  finally { for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  fs.writeFileSync(path.join(dir, 'posted.json'), JSON.stringify({ comments: posted.comments, reviews: posted.reviews, warnings: posted.warnings }, null, 2) + '\n');
  fs.writeFileSync(path.join(dir, 'summary.md'), posted.summary || '');
  return { id, trace: meta.trace, findings_present: present, ...countFindings(posted.comments, posted.summary) };
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

const USAGE = `Usage:
  node eval/replay.js prepare --repo DIR --base SHA --head SHA --out DIR --id ID [--title T] [--body B] [--trace auto|off] [--shared]
  node eval/replay.js finish  --id ID[,ID...] --out DIR
No pass/fail: findings are adjudicated by a human against the later fix (eval/replay/README.md).`;

async function main() {
  const { values: o, positionals } = require('node:util').parseArgs({ allowPositionals: true, options: {
    repo: { type: 'string' }, base: { type: 'string' }, head: { type: 'string' }, out: { type: 'string' }, id: { type: 'string' },
    title: { type: 'string', default: '' }, body: { type: 'string', default: '' }, trace: { type: 'string', default: 'auto' }, shared: { type: 'boolean' }, help: { type: 'boolean' } } });
  const [cmd] = positionals;
  if (o.help || !['prepare', 'finish'].includes(cmd) || !o.out || !o.id) { console.log(USAGE); process.exit(o.help ? 0 : 2); }
  if (cmd === 'prepare') console.log(JSON.stringify(prepareReal({ repoDir: o.repo, base: o.base, head: o.head, prTitle: o.title, prBody: o.body, out: o.out, id: o.id, trace: o.trace, shared: o.shared }), null, 2));
  else await finishReal({ ids: o.id.split(','), out: o.out });
}

if (require.main === module) main().catch((e) => { console.error(e.message); process.exit(1); });
module.exports = { prepareReal, finishReal, finishRealOne, countFindings, table };
