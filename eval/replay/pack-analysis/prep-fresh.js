#!/usr/bin/env node
// Builds the collector inputs (ctx) of a frozen fresh-corpus list by running the real src/collect.sh on base = first parent, head = commit, offline (gh shimmed), exactly as eval/replay.js prepareReal does.
// One shared clone per repo is reused across its commits (collect.sh checks out HEAD_SHA itself, inside that scratch clone only) and removed afterwards.
// usage: node prep-fresh.js <evidence-dir> <list.txt> <out-dir> <scratch-dir>      -> <out-dir>/<repo>/<sha12>/{ctx,meta.json,collect.log}; existing ones are kept (resumable)
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const [ev, list, out, scratch] = process.argv.slice(2);
const fwd = (p) => path.resolve(p).split(path.sep).join('/');
const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const SHIM = `const cp = require('node:child_process'), fs = require('node:fs'), orig = cp.execFileSync;
cp.execFileSync = function (file, args) {
  if (file !== 'gh') return orig.apply(this, arguments);
  if (args[0] === 'pr' && args[1] === 'view') return fs.readFileSync(process.env.SG_PR_JSON, 'utf8');
  if (args[0] === 'api') return '[]';
  throw new Error('gh is offline');
};
`;
const rows = fs.readFileSync(list, 'utf8').split('\n').filter((l) => l && !l.startsWith('#')).map((l) => l.split('\t'));
const byRepo = new Map();
for (const r of rows) (byRepo.get(r[0]) || byRepo.set(r[0], []).get(r[0])).push(r);
fs.mkdirSync(out, { recursive: true });
const shim = path.join(out, 'gh-shim.js');
fs.writeFileSync(shim, SHIM);
for (const [repo, items] of byRepo) {
  const todo = items.filter(([, h]) => !fs.existsSync(path.join(out, repo, h.slice(0, 12), 'meta.json')));
  if (!todo.length) continue;
  const clone = path.join(scratch, repo);
  for (const [, head, base, subj] of todo) {
    fs.rmSync(clone, { recursive: true, force: true, maxRetries: 5 }); // collect.sh leaves restored rule files in the work tree, so the next checkout would refuse: a fresh shared clone per commit
    execFileSync('git', ['-c', 'core.longpaths=true', 'clone', '-q', '--shared', '--no-checkout', path.resolve(ev, 'repos', repo), clone], { stdio: 'pipe' });
    for (const [k, v] of [['core.longpaths', 'true'], ['user.name', 'specguard-local'], ['user.email', 'local@example.invalid'], ['core.autocrlf', 'false']]) git(clone, 'config', k, v);
    const dir = path.join(out, repo, head.slice(0, 12)), ctx = path.join(dir, 'ctx'), pr = path.join(dir, 'pr.json'), go = path.join(dir, 'gh-output.txt');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(pr, JSON.stringify({ number: 1, title: subj, body: '', closingIssuesReferences: [] })); fs.writeFileSync(go, '');
    const r = spawnSync('bash', [fwd(path.join(__dirname, '..', '..', '..', 'src', 'collect.sh'))], {
      cwd: clone, encoding: 'utf8', maxBuffer: 1 << 28, timeout: 1800000,
      env: { ...process.env, BASE_SHA: base, HEAD_SHA: head, CTX: fwd(ctx), TRACE: process.env.PREP_TRACE || 'auto', REQ_PATHS: '', IGNORE_EXTRA: '', PR_NUMBER: '1', GH_REPO: 'local/eval', GH_TOKEN: 'offline', GITHUB_OUTPUT: fwd(go), SG_PR_JSON: fwd(pr), NODE_OPTIONS: `--require "${fwd(shim)}"` },
    });
    fs.writeFileSync(path.join(dir, 'collect.log'), `${r.stdout || ''}${r.stderr || ''}`.slice(-20000));
    const o = fs.readFileSync(go, 'utf8');
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ repo, head, base, subject: subj, ok: r.status === 0, skip: o.includes('skip=true') }) + '\n');
    console.log(repo, head.slice(0, 12), r.status === 0 ? 'ok' : `collect exit ${r.status}`, o.includes('skip=true') ? 'skip' : '');
  }
  fs.rmSync(clone, { recursive: true, force: true });
}
