#!/usr/bin/env node
// Runs the repo's own src/trace.js (and collect.sh's test-candidates step) on the pinned target, no model.
// Needs the network once (git fetch of the pinned SHA). Not part of CI. See README.md.
// usage: node run.js [--out results.json] [--work <dir>] [--src <dir with trace.js + collect.sh>] [--only caseId[,caseId]]
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { extractCandidates, checkCandidates, checkNotAllEmpty, harnessEnv, PINNED_UNSET } = require('./candidates.js');

const args = process.argv.slice(2), opt = (n, d) => { const i = args.indexOf(n); return i < 0 ? d : args[i + 1]; };
const cases = JSON.parse(fs.readFileSync(path.join(__dirname, 'cases.json'), 'utf8'));
const { repo, sha: BASE, req_paths: REQ_PATHS } = cases.target;
const SRC = path.resolve(opt('--src', path.join(__dirname, '..', '..', 'src')));
const OUT = path.resolve(opt('--out', path.join(__dirname, 'results.json')));
const WORK = path.resolve(opt('--work', path.join(os.tmpdir(), 'specguard-trace-recall-' + BASE.slice(0, 8))));
const only = opt('--only') ? new Set(opt('--only').split(',')) : null;
const TARGET = path.join(WORK, 'target');

function git(a, o = {}) {
  const r = spawnSync('git', ['-c', 'core.autocrlf=false', '-c', 'user.name=eval', '-c', 'user.email=eval@example.invalid', ...a], { cwd: TARGET, encoding: 'utf8', maxBuffer: 1 << 28, ...o });
  if (r.status !== 0) throw new Error(`git ${a.join(' ')} failed: ${r.stderr || r.error}`);
  return r.stdout.trim();
}

function prepare() { // fetch only the pinned commit; reuse the work dir when it is already there
  fs.mkdirSync(TARGET, { recursive: true });
  if (!fs.existsSync(path.join(TARGET, '.git'))) { git(['init', '-q']); git(['remote', 'add', 'origin', repo]); }
  let have = true;
  try { git(['cat-file', '-e', BASE + '^{commit}']); } catch { have = false; }
  if (!have) { console.log(`fetching ${repo} @ ${BASE.slice(0, 8)}`); git(['fetch', '-q', '--depth', '1', 'origin', BASE]); }
  git(['checkout', '-q', '--detach', '-f', BASE]);
  git(['clean', '-qfdx']);
  if (git(['rev-parse', 'HEAD']) !== BASE) throw new Error('target is not at the pinned SHA');
}

// An edit replaces `old` with `new` (first occurrence; `all`: every one; `line`: only on that 1-based line). A miss is an error: the set is pinned.
function apply(edits) {
  const text = {};
  for (const e of edits) {
    const f = path.join(TARGET, e.file);
    let t = text[e.file] ?? fs.readFileSync(f, 'utf8');
    if (e.line) {
      const ls = t.split('\n');
      if (!ls[e.line - 1].includes(e.old)) throw new Error(`edit misses ${e.file}:${e.line}`);
      ls[e.line - 1] = ls[e.line - 1].replace(e.old, e.new); t = ls.join('\n');
    } else {
      if (!t.includes(e.old)) throw new Error(`edit misses ${e.file}`);
      t = e.all ? t.split(e.old).join(e.new) : t.replace(e.old, e.new);
    }
    text[e.file] = t;
  }
  for (const f of Object.keys(text)) fs.writeFileSync(path.join(TARGET, f), text[f]);
}

function makeVariants() { // R / C / RC as local commits on top of the pinned SHA
  const heads = {};
  for (const c of cases.cases) {
    if (only && !only.has(c.id)) continue;
    for (const [v, edits] of [['R', c.edits.R], ['C', c.edits.C], ['RC', [...c.edits.R, ...c.edits.C]], ...(c.edits.T ? [['T', c.edits.T]] : [])]) {
      git(['checkout', '-q', '--detach', '-f', BASE]);
      apply(edits);
      git(['commit', '-qam', `${v} ${c.id}`]);
      heads[`${c.id}-${v}`] = { case: c.id, variant: v, head: git(['rev-parse', 'HEAD']) };
    }
  }
  git(['checkout', '-q', '--detach', '-f', BASE]);
  return heads;
}

// collect.sh's `candidates()` is an inline node heredoc; run that very text so the harness cannot drift from it.
function candidatesScript() {
  const f = path.join(WORK, 'candidates.js'); fs.writeFileSync(f, extractCandidates(fs.readFileSync(path.join(SRC, 'collect.sh'), 'utf8'))); return f;
}

function runVariant(id, h, candJs) {
  const ctx = path.join(WORK, 'out', id); fs.rmSync(ctx, { recursive: true, force: true }); fs.mkdirSync(ctx, { recursive: true });
  git(['checkout', '-q', '--detach', '-f', h.head]);
  fs.writeFileSync(path.join(ctx, 'files.txt'), git(['diff', '--name-only', BASE, h.head]) + '\n');
  const env = harnessEnv(process.env, { CTX: ctx, DIFF_BASE_SHA: BASE, BASE_SHA: BASE, HEAD_SHA: h.head, REQ_PATHS });
  const t0 = Date.now();
  const tr = spawnSync(process.execPath, [path.join(SRC, 'trace.js')], { cwd: TARGET, env, encoding: 'utf8', timeout: 60000, maxBuffer: 1 << 28 });
  const t1 = Date.now();
  const cd = spawnSync(process.execPath, [candJs, path.join(SRC, 'trace.js'), ctx], { cwd: TARGET, env, encoding: 'utf8', timeout: 60000, maxBuffer: 1 << 28 });
  const t2 = Date.now();
  const rd = (f) => { try { return fs.readFileSync(path.join(ctx, f), 'utf8'); } catch { return ''; } };
  checkCandidates(id, cd);
  let tc = null; try { tc = JSON.parse(rd('trace-candidates.json')); } catch {}
  const failed = tr.status !== 0 || !tc;
  return {
    id, case: h.case, variant: h.variant, head: h.head, trace_ms: t1 - t0, cand_ms: t2 - t1,
    status: failed ? 'trace failed: ' + (tr.stderr || '').split('\n')[0] : 'ok',
    limitations: tc ? tc.limitations : [],
    req_to_code: tc ? tc.requirement_to_code.map((x) => ({ criterion: x.criterion, code: x.code.map(slim), tests: x.tests.map(slim) })) : [],
    code_to_req: tc ? tc.code_to_requirement.map((x) => ({ path: x.path, line: x.line, candidates: x.candidates.map((c) => ({ path: c.path, line: c.line, score: c.score, kind: c.kind })) })) : [],
    test_candidates: rd('test-candidates.txt'),
  };
}
const slim = (x) => ({ path: x.path, line: x.line, end: x.end });

prepare();
const heads = makeVariants();
const candJs = candidatesScript();
const variants = [];
for (const [id, h] of Object.entries(heads)) { const r = runVariant(id, h, candJs); variants.push(r); console.log(`${id}: ${r.status} ${r.trace_ms + r.cand_ms} ms`); }
checkNotAllEmpty(variants.filter((v) => v.variant === 'C' || v.variant === 'RC').map((v) => ({ id: v.id, text: v.test_candidates })));
let srcSha = ''; try { srcSha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: SRC, encoding: 'utf8' }).stdout.trim(); } catch {}
fs.writeFileSync(OUT, JSON.stringify({ target: cases.target, specguard_sha: srcSha, node: process.version, env_unset: PINNED_UNSET, variants }, null, 1) + '\n');
console.log(`wrote ${OUT}`);
