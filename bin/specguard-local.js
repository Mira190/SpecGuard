#!/usr/bin/env node
// Pre-push SpecGuard review on the developer's machine: the real collect.sh, prompt, engines/copilot.sh and post.js, with no GitHub.
// Committed changes only. Runs in a throwaway git worktree because collect.sh checks out and restores files.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { parseArgs } = require('node:util');
const { fakeGithub } = require('../eval/local.js');
const { parseComment } = require('../eval/grade.js');
const { assemble } = require('../src/prompt.js');

const ROOT = path.join(__dirname, '..');
const USAGE = `Usage: node bin/specguard-local.js [--base REF] [--body FILE] [--model X] [--effort Y] [--auto-tier T] [--json] [--fail-on-gaps] [--keep]

Reviews the commits between the merge-base of --base (default: the remote default branch, else main, else master) and HEAD with Copilot.
Uncommitted changes are not reviewed. Advisory: exit 0 unless the tool crashed, or 1 with --fail-on-gaps when unit test gaps exist.
--body FILE   requirement text (default: the commit messages since the base; linked issues are unavailable offline)
--keep        keep the context directory (diff, prompt inputs, raw engine output) and print its path`;

const OPTIONS = { base: { type: 'string' }, body: { type: 'string' }, model: { type: 'string' }, effort: { type: 'string' }, 'auto-tier': { type: 'string' },
  json: { type: 'boolean' }, 'fail-on-gaps': { type: 'boolean' }, keep: { type: 'boolean' }, help: { type: 'boolean' } };

const fwd = (p) => path.resolve(p).replace(/\\/g, '/');
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const tryGit = (cwd, ...args) => { try { return git(cwd, ...args); } catch { return ''; } };
const readLines = (p) => { try { return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean); } catch { return []; } };

function parse(argv) {
  const { values } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: false });
  return { ...values };
}

// BASE = merge-base of the base ref and HEAD. Default base ref: origin's default branch, else main, else master.
function resolveBase(cwd, base) {
  const ref = base || tryGit(cwd, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD')
    || ['main', 'master'].find((b) => tryGit(cwd, 'rev-parse', '--verify', '-q', `${b}^{commit}`));
  if (!ref) throw new Error('no base branch found (tried the remote default branch, main, master); pass --base REF');
  const head = tryGit(cwd, 'rev-parse', '--verify', '-q', 'HEAD^{commit}');
  if (!head) throw new Error('HEAD has no commits');
  const baseTip = tryGit(cwd, 'rev-parse', '--verify', '-q', `${ref}^{commit}`);
  if (!baseTip) throw new Error(`unknown base ref: ${ref}`);
  const mergeBase = tryGit(cwd, 'merge-base', ref, head);
  if (!mergeBase) throw new Error(`no merge-base of ${ref} and HEAD`);
  return { ref, base: mergeBase, head };
}

// Preloaded into collect.sh's node processes: requirements.js calls `gh`, which has no network here (same approach as eval/local.js).
const SHIM = `const cp = require('node:child_process'), fs = require('node:fs'), orig = cp.execFileSync;
cp.execFileSync = function (file, args) {
  if (file !== 'gh') return orig.apply(this, arguments);
  if (args[0] === 'pr' && args[1] === 'view') return fs.readFileSync(process.env.SG_PR_JSON, 'utf8');
  if (args[0] === 'api') return '[]';
  throw new Error('gh is offline');
};
`;

const hidden = (s) => s.replace(/<!--[\s\S]*?-->/g, '').replace(/\n{3,}/g, '\n\n').trim();

async function run({ cwd = process.cwd(), opts = {}, log = (m) => console.error(m) } = {}) {
  if (Object.keys(process.env).some((k) => k === 'COPILOT_ALLOW_ALL' || k.startsWith('GITHUB_COPILOT_PROMPT_MODE_'))) {
    throw new Error('COPILOT_ALLOW_ALL / GITHUB_COPILOT_PROMPT_MODE_* must not be set: they load repo hooks and MCP servers');
  }
  const repoRoot = git(cwd, 'rev-parse', '--show-toplevel');
  const { ref, base, head } = resolveBase(repoRoot, opts.base);
  if (git(repoRoot, 'status', '--porcelain')) log('warning: uncommitted changes are not reviewed (committed changes only)');
  log(`reviewing ${ref}...HEAD (${base.slice(0, 8)}..${head.slice(0, 8)}), committed changes only`);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'specguard-local-'));
  const wt = path.join(tmp, 'repo'), ctx = path.join(tmp, 'ctx');
  git(repoRoot, 'worktree', 'add', '-q', '--detach', wt, head);
  try {
    const branch = tryGit(repoRoot, 'rev-parse', '--abbrev-ref', 'HEAD');
    const commits = tryGit(repoRoot, 'log', '--format=%B', `${base}..${head}`);
    const body = opts.body ? fs.readFileSync(opts.body, 'utf8') : commits;
    const title = tryGit(repoRoot, 'log', '-1', '--format=%s') || branch;
    const shim = path.join(tmp, 'gh-shim.js'), pr = path.join(tmp, 'pr.json'), outputs = path.join(tmp, 'gh-output.txt');
    fs.writeFileSync(shim, SHIM);
    fs.writeFileSync(pr, JSON.stringify({ number: 1, title, body, closingIssuesReferences: [], headRefName: branch, labels: [] }));
    fs.writeFileSync(outputs, '');

    const c = spawnSync('bash', [fwd(path.join(ROOT, 'src', 'collect.sh'))], {
      cwd: wt, encoding: 'utf8', maxBuffer: 1 << 28,
      env: { ...process.env, BASE_SHA: base, HEAD_SHA: head, CTX: fwd(ctx), TRACE: 'auto', REQ_PATHS: '', IGNORE_EXTRA: '', STANDARDS_PATHS: '', PR_NUMBER: '1', GH_REPO: 'local/local', GH_TOKEN: 'offline',
        GITHUB_OUTPUT: fwd(outputs), SG_PR_JSON: fwd(pr), NODE_OPTIONS: `--require "${fwd(shim)}"` },
    });
    if (c.status !== 0) throw new Error(`collect.sh failed:\n${`${c.stdout || ''}${c.stderr || ''}`.trim().split('\n').slice(-8).join('\n')}`);
    const outLines = readLines(outputs);
    const skip = outLines.includes('skip=true'), partial = outLines.includes('partial=true');

    const canned = process.env.SPECGUARD_LOCAL_FINDINGS; // tests: no model is called
    if (skip) log('nothing reviewable in the diff');
    else if (canned) fs.copyFileSync(canned, path.join(ctx, 'findings.json'));
    else {
      log('running Copilot (this takes a few minutes and spends AI credits)...');
      const prompt = assemble({ skillDir: path.join(ROOT, 'skills', 'test-review'), ctxDir: ctx, schemaPath: path.join(ROOT, 'src', 'findings.schema.json') });
      // engines/copilot.sh pipes the prompt file to copilot on stdin: no command-line or environment limit, so this works on Windows too (it needs bash: Git for Windows)
      const promptFile = path.join(ctx, 'prompt.txt');
      fs.writeFileSync(promptFile, prompt);
      const engineEnv = { ...process.env, CTX: fwd(ctx), PROMPT_FILE: fwd(promptFile), MODEL: opts.model || '', EFFORT: opts.effort || '' };
      if (opts['auto-tier'] !== undefined) engineEnv.AUTO_TIER = opts['auto-tier']; // unset = engines/copilot.sh's default (intelligence), like the action
      const e = spawnSync('bash', [fwd(path.join(ROOT, 'src', 'engines', 'copilot.sh'))], { cwd: wt, env: engineEnv, stdio: ['ignore', 2, 2] });
      if (e.status !== 0) log(`engines/copilot.sh exited ${e.status}`); // post.js reports "could not complete"
    }

    const { github, core, posted } = fakeGithub({ headSha: head });
    let status = '';
    core.setOutput = (k, v) => { if (k === 'status') status = v; };
    const context = { repo: { owner: 'local', repo: 'local' }, serverUrl: 'https://github.com', payload: { pull_request: { number: 1, head: { sha: head }, base: { sha: base } } } };
    const env = { CTX: fwd(ctx), HEAD_SHA: head, BASE_SHA: base, GITHUB_WORKSPACE: fwd(wt), SKIP: String(skip), PARTIAL: String(partial), MAX_COMMENTS: '10', ENGINE: 'copilot', MODEL: opts.model || '', STANDARDS_REF: 'head', STANDARDS_CHECKS: '' };
    const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
    Object.assign(process.env, env);
    try { await require('../src/post.js')({ github, context, core }); }
    finally { for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v; }

    const comments = posted.comments.map(parseComment).filter(Boolean).map((x) => ({ path: x.path, line: x.line, kind: x.kind, confidence: x.confidence, title: x.title, body: hidden(x.body) }));
    let gaps = false; // ponytail: raw findings.json, not the validated set; a finding the validator drops still counts
    try {
      const d = JSON.parse(fs.readFileSync(path.join(ctx, 'findings.json'), 'utf8')), t = ['missing_test', 'weak_test'];
      gaps = (d.findings || []).some((f) => t.includes(f.kind)) || (d.coverage || []).some((r) => t.includes(r.status));
    } catch { /* no findings: the summary says why */ }
    if (opts.keep) { const k = path.join(os.tmpdir(), `specguard-ctx-${head.slice(0, 8)}`); fs.rmSync(k, { recursive: true, force: true }); fs.cpSync(ctx, k, { recursive: true }); log(`context kept in ${k}`); }
    return { ref, base, head, status: status || 'unknown', summary: posted.summary || '', comments, warnings: posted.warnings, gaps };
  } finally {
    try { git(repoRoot, 'worktree', 'remove', '--force', wt); } catch { /* pruned below */ }
    fs.rmSync(tmp, { recursive: true, force: true });
    tryGit(repoRoot, 'worktree', 'prune');
  }
}

function format(r) {
  const out = [r.summary || '(no summary: ' + (r.warnings.join('; ') || 'post.js published nothing') + ')'];
  if (r.comments.length) out.push('', `Inline comments (${r.comments.length}):`);
  for (const c of r.comments) out.push('', `${c.path}:${c.line ?? '?'} — ${c.title}`, ...c.body.split('\n').map((l) => `  ${l}`));
  return out.join('\n');
}

async function main(argv = process.argv.slice(2)) {
  let o;
  try { o = parse(argv); } catch (e) { console.error(`${e.message}\n\n${USAGE}`); return 2; }
  if (o.help) { console.log(USAGE); return 0; }
  const r = await run({ opts: o });
  console.log(o.json ? JSON.stringify({ status: r.status, base: r.base, head: r.head, gaps: r.gaps, comments: r.comments, summary: r.summary, warnings: r.warnings }, null, 2) : format(r));
  return o['fail-on-gaps'] && r.gaps ? 1 : 0;
}

if (require.main === module) main().then((c) => { process.exitCode = c; }, (e) => { console.error(`specguard-local: ${e.message}`); process.exitCode = 3; });
module.exports = { parse, resolveBase, run, format, main };
