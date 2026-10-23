#!/usr/bin/env node
// SpecGuard review on the developer's machine (opt-in, before the PR exists): the real collect.sh, prompt, engines/copilot.sh and post.js, with no GitHub.
// Committed changes only. Runs in a throwaway git worktree because collect.sh checks out and restores files.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn, spawnSync } = require('node:child_process');
const { parseArgs } = require('node:util');
const { fakeGithub } = require('../eval/local.js');
const { parseComment, parseSummary } = require('../eval/grade.js');
const { assemble } = require('../src/prompt.js');

const ROOT = path.join(__dirname, '..');
const USAGE = `Usage: node bin/specguard-local.js [--base REF] [--body FILE] [--model X] [--effort Y] [--auto-tier T] [--unverified-missing-tests details|show] [--json] [--fail-on-gaps] [--keep]
       [--requirements-paths GLOB]... [--standards-paths GLOB]... [--test-paths GLOB]... [--ignore GLOB]...

Reviews the commits between the merge-base of --base (default: the remote default branch, else main, else master) and HEAD with Copilot.
The base is fetched first (a warning when offline). Uncommitted changes are not reviewed.
Advisory: exit 0 unless the tool crashed (3). With --fail-on-gaps: 1 when the VALIDATED review (what post.js would post) holds a high-confidence unit test gap,
2 when the run did not complete (status failed or incomplete: "no gaps" is not known), else 0.
--body FILE            requirement text (default: the commit messages since the base; linked issues are unavailable offline)
--requirements-paths, --standards-paths, --test-paths, --ignore
                       the CI action's inputs of the same names (a glob or folder per flag, repeatable; !glob excludes). Copy them from your workflow so the local run matches CI.
--unverified-missing-tests details|show
                       the action input of the same name. details (default): a model missing_test without coverage evidence is listed in Details, not delivered or counted (the gate ignores it); show: deliver it as before.
--keep                 keep the context directory (diff, prompt inputs, raw engine output) and print its path`;

const list = { type: 'string', multiple: true };
const OPTIONS = { base: { type: 'string' }, body: { type: 'string' }, model: { type: 'string' }, effort: { type: 'string' }, 'auto-tier': { type: 'string' }, 'unverified-missing-tests': { type: 'string' },
  'requirements-paths': list, 'standards-paths': list, 'test-paths': list, ignore: list,
  json: { type: 'boolean' }, 'fail-on-gaps': { type: 'boolean' }, keep: { type: 'boolean' }, help: { type: 'boolean' } };

const fwd = (p) => path.resolve(p).replace(/\\/g, '/');
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const tryGit = (cwd, ...args) => { try { return git(cwd, ...args); } catch { return ''; } };
// Windows: a PATH `bash` can be the WSL bash.exe in System32, which cannot open a Windows path. SPECGUARD_BASH, else Git for Windows' bash beside `git --exec-path` (<root>/mingw64/libexec/git-core), else `bash`.
function bashPath({ platform = process.platform, env = process.env, exists = fs.existsSync, execPath = () => tryGit('.', '--exec-path') } = {}) {
  if (platform !== 'win32') return 'bash';
  if (env.SPECGUARD_BASH) return env.SPECGUARD_BASH;
  const g = execPath().replace(/[\\/]mingw(?:64|32)[\\/]libexec[\\/]git-core[\\/]?$/i, '');
  return g && exists(`${g}/bin/bash.exe`) ? `${g}/bin/bash.exe` : 'bash';
}
let BASH;
const readLines = (p) => { try { return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean); } catch { return []; } };

function parse(argv) {
  const { values } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: false });
  if (values['unverified-missing-tests'] !== undefined && !['details', 'show'].includes(values['unverified-missing-tests'])) throw new Error('--unverified-missing-tests must be details or show');
  return { ...values };
}

// Default base ref: origin's default branch, else main, else master.
const baseRef = (cwd, base) => base || tryGit(cwd, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD')
  || ['main', 'master'].find((b) => tryGit(cwd, 'rev-parse', '--verify', '-q', `${b}^{commit}`));

// A stale remote-tracking base (merge-base of the old tip) drags the target branch's newer commits into the diff, so refresh it first.
// Offline or unreachable: warn and review against what is there. A local branch (main) is not touched.
function fetchBase(cwd, ref, log) {
  const m = /^([^/]+)\/(.+)$/.exec(ref || '');
  if (!m || !tryGit(cwd, 'remote').split('\n').includes(m[1])) return false;
  try { execFileSync('git', ['fetch', '--quiet', m[1], m[2]], { cwd, stdio: 'ignore', timeout: 30000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }); return true; }
  catch { log(`warning: could not fetch ${ref} (offline?): reviewing against the ${ref} you have, which may be stale`); return false; }
}

// BASE = merge-base of the base ref and HEAD.
function resolveBase(cwd, base) {
  const ref = baseRef(cwd, base);
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

// The gate for --fail-on-gaps: what post.js delivered after validation (citations verified, anchored to the diff, capped), never the raw findings.json.
// A gap = a high-confidence missing_test / weak_test comment, or a summary item of those kinds that post.js did not mark "low confidence" (comment cap, outside the diff, ...).
const GAP = ['missing_test', 'weak_test'];
function validatedGaps(posted) { // a summary item is "- title `path:line` (why) — sentence" under "### Missing unit tests" / "### Weak unit tests" (older runs: with a leading icon), or the older "- ❌ **Missing test:** …" (post.js buildSummary; eval/grade.js parseSummary reads it)
  const inline = (posted.comments || []).map(parseComment).filter(Boolean).some((c) => GAP.includes(c.kind) && c.confidence === 'high');
  return inline || parseSummary(posted.summary).items.some((i) => GAP.includes(i.kind) && !/low confidence/i.test(i.why));
}

const hidden = (s) => s.replace(/<!--[\s\S]*?-->/g, '').replace(/\n{3,}/g, '\n\n').trim();

// Async (not spawnSync) so SIGINT / SIGTERM handlers can run while collect.sh or the engine is working.
function exec(state, cmd, args, { capture, ...opts }) {
  return new Promise((resolve, reject) => {
    if (state.interrupted) return reject(new Error('interrupted'));
    const c = spawn(cmd, args, { ...opts, stdio: capture ? ['ignore', 'pipe', 'pipe'] : ['ignore', 2, 2], detached: process.platform !== 'win32' }); // own process group: one kill reaches copilot too
    let out = '';
    state.child = c;
    if (capture) for (const s of [c.stdout, c.stderr]) s.on('data', (d) => { out = (out + d).slice(-65536); });
    c.on('error', (e) => { state.child = null; reject(e); });
    c.on('close', (status) => { state.child = null; if (state.interrupted) reject(new Error('interrupted')); else resolve({ status, out }); });
  });
}
// The same check as engines/copilot.sh, through bash so the same copilot is found: a stub that prints "Cannot find GitHub Copilot CLI" (VS Code's) must not pass.
function copilotProblem() {
  const r = spawnSync('bash', ['-c', 'timeout 30 copilot --version < /dev/null 2>&1 | head -n 3'], { encoding: 'utf8' });
  const out = (r.stdout || '').trim();
  return /GitHub Copilot CLI v?\d+\.\d+\.\d+/i.test(out) ? '' : `Copilot CLI not found or not runnable (${out.split('\n')[0] || r.error?.message || 'no output'}); install @github/copilot (npm install -g @github/copilot) or put it first on PATH`;
}
const lines = (v) => [].concat(v || []).join('\n');

async function run({ cwd = process.cwd(), opts = {}, log = (m) => console.error(m), proc = process } = {}) {
  if (Object.keys(process.env).some((k) => k === 'COPILOT_ALLOW_ALL' || k.startsWith('GITHUB_COPILOT_PROMPT_MODE_'))) {
    throw new Error('COPILOT_ALLOW_ALL / GITHUB_COPILOT_PROMPT_MODE_* must not be set: they load repo hooks and MCP servers');
  }
  if (!process.env.SPECGUARD_LOCAL_FINDINGS) { const p = copilotProblem(); if (p) throw new Error(p); } // exit 3 (main's caller) before any worktree exists
  const repoRoot = git(cwd, 'rev-parse', '--show-toplevel');
  fetchBase(repoRoot, baseRef(repoRoot, opts.base), log);
  const { ref, base, head } = resolveBase(repoRoot, opts.base);
  if (git(repoRoot, 'status', '--porcelain')) log('warning: uncommitted changes are not reviewed (committed changes only)');
  log(`reviewing ${ref}...HEAD (${base.slice(0, 8)}..${head.slice(0, 8)}), committed changes only`);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'specguard-local-'));
  const wt = path.join(tmp, 'repo'), ctx = path.join(tmp, 'ctx');
  const cleanup = () => { // idempotent: the signal handler and the finally block both call it
    try { git(repoRoot, 'worktree', 'remove', '--force', wt); } catch { /* pruned below */ }
    fs.rmSync(tmp, { recursive: true, force: true });
    tryGit(repoRoot, 'worktree', 'prune');
  };
  // Ctrl-C or kill would skip finally: the tmp dir and the registered worktree would stay (git worktree prune cannot remove a worktree whose directory exists).
  const state = { interrupted: false, child: null };
  const onSignal = (sig) => {
    state.interrupted = true;
    try { if (state.child) { if (process.platform === 'win32') state.child.kill(); else process.kill(-state.child.pid, 'SIGTERM'); } } catch { /* already gone */ }
    cleanup();
    log(`interrupted (${sig}): temporary worktree removed`);
    proc.exit(128 + (os.constants.signals[sig] || 2));
  };
  const handlers = { SIGINT: () => onSignal('SIGINT'), SIGTERM: () => onSignal('SIGTERM') };
  for (const [sig, h] of Object.entries(handlers)) proc.on(sig, h);
  try {
    git(repoRoot, 'worktree', 'add', '-q', '--detach', wt, head);
    const branch = tryGit(repoRoot, 'rev-parse', '--abbrev-ref', 'HEAD');
    const commits = tryGit(repoRoot, 'log', '--format=%B', `${base}..${head}`);
    const body = opts.body ? fs.readFileSync(opts.body, 'utf8') : commits;
    const title = tryGit(repoRoot, 'log', '-1', '--format=%s') || branch;
    const shim = path.join(tmp, 'gh-shim.js'), pr = path.join(tmp, 'pr.json'), outputs = path.join(tmp, 'gh-output.txt');
    fs.writeFileSync(shim, SHIM);
    fs.writeFileSync(pr, JSON.stringify({ number: 1, title, body, closingIssuesReferences: [], headRefName: branch, labels: [] }));
    fs.writeFileSync(outputs, '');

    // the same four inputs the action reads (flags only: an exported REQ_PATHS in the shell must not change the review)
    const c = await exec(state, BASH ||= bashPath(), [fwd(path.join(ROOT, 'src', 'collect.sh'))], {
      cwd: wt, capture: true,
      env: { ...process.env, BASE_SHA: base, HEAD_SHA: head, CTX: fwd(ctx), TRACE: 'auto', PR_NUMBER: '1', GH_REPO: 'local/local', GH_TOKEN: 'offline',
        REQ_PATHS: lines(opts['requirements-paths']), STANDARDS_PATHS: lines(opts['standards-paths']), TEST_PATHS: lines(opts['test-paths']), IGNORE_EXTRA: lines(opts.ignore),
        GITHUB_OUTPUT: fwd(outputs), SG_PR_JSON: fwd(pr), NODE_OPTIONS: `--require "${fwd(shim)}"` },
    });
    if (c.status !== 0) throw new Error(`collect.sh failed:\n${c.out.trim().split('\n').slice(-8).join('\n')}`);
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
      const e = await exec(state, BASH ||= bashPath(), [fwd(path.join(ROOT, 'src', 'engines', 'copilot.sh'))], { cwd: wt, env: engineEnv });
      if (e.status !== 0) log(`engines/copilot.sh exited ${e.status}`); // post.js reports "could not complete"
    }

    const { github, core, posted } = fakeGithub({ headSha: head });
    let status = '';
    core.setOutput = (k, v) => { if (k === 'status') status = v; };
    const context = { repo: { owner: 'local', repo: 'local' }, serverUrl: 'https://github.com', payload: { pull_request: { number: 1, head: { sha: head }, base: { sha: base } } } };
    const env = { CTX: fwd(ctx), HEAD_SHA: head, BASE_SHA: base, GITHUB_WORKSPACE: fwd(wt), SKIP: String(skip), PARTIAL: String(partial), MAX_COMMENTS: '10', ENGINE: 'copilot', MODEL: opts.model || '', STANDARDS_REF: 'head', STANDARDS_CHECKS: '', UNVERIFIED_MISSING_TESTS: opts['unverified-missing-tests'] || 'details' }; // the action's default; a flag only (an exported variable must not change the review)
    const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
    Object.assign(process.env, env);
    try { await require('../src/post.js')({ github, context, core }); }
    finally { for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v; }

    const comments = posted.comments.map(parseComment).filter(Boolean).map((x) => ({ path: x.path, line: x.line, kind: x.kind, confidence: x.confidence, title: x.title, body: hidden(x.body) }));
    const gaps = validatedGaps(posted);
    if (opts.keep) { const k = path.join(os.tmpdir(), `specguard-ctx-${head.slice(0, 8)}`); fs.rmSync(k, { recursive: true, force: true }); fs.cpSync(ctx, k, { recursive: true }); log(`context kept in ${k}`); }
    return { ref, base, head, status: status || 'unknown', summary: posted.summary || '', comments, warnings: posted.warnings, gaps };
  } finally {
    for (const [sig, h] of Object.entries(handlers)) proc.off(sig, h);
    cleanup();
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
  return !o['fail-on-gaps'] ? 0 : r.gaps ? 1 : r.status === 'complete' ? 0 : 2; // a gap is conclusive; "no gap" on a run that did not complete is not
}

if (require.main === module) main().then((c) => { process.exitCode = c; }, (e) => { console.error(`specguard-local: ${e.message}`); process.exitCode = 3; });
module.exports = { bashPath, parse, baseRef, fetchBase, resolveBase, validatedGaps, run, format, main };
