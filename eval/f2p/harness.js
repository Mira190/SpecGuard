// F2P harness commands: export, packets, setup, baseline, try, run, report (README). Node built-ins only. Generated trees, tests, packets and work dirs live under <evidence>/f2p/.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const f2p = require('./f2p');
const { rng, shuffle } = require('./stats');
const { verdict, signatureChanged } = require('./verdict');
const { parseVitest, parsePytest, parseGo, combine } = require('./runners');
const { apply, testOf } = require('../mutation/mutate');
const report = require('./report');

const { F2P, EV, ROOT, sha, readJson, cloneOf, MANIFEST } = f2p;
const REPOS = () => readJson(path.join(__dirname, 'repos.json'));
// --set <name>: every command works on eval/f2p/<name>-candidates.json (list input, see import) with its own results-<name>.json and baseline-<name>.json; with no set the file names are the original ones.
let SET = null;
const useSet = (name) => { SET = name || null; };
const files = () => ({ results: SET ? `results-${SET}.json` : 'results.json', baseline: SET ? `baseline-${SET}.json` : 'baseline.json', cand: SET ? `${SET}-candidates.json` : 'holdout2-candidates.json', fields: SET ? `${SET}-fields.json` : 'holdout2-fields.json' });
// With --set the trees, packets and tests live under trees/<set>/, packets/<set>/ and tests/<set>/; without it under trees/, packets/ and tests/ as before.
const under = (...p) => path.join(F2P, p[0], ...(SET ? [SET] : []), ...p.slice(1));
const treeRoot = () => under('trees');
const treeDir = (group) => path.join(under('trees', group), 'buggy');
const testsRoot = (id) => under('tests', id);
const packetsDir = () => under('packets');
const resultsFile = () => path.join(__dirname, files().results);
const baselineFile = () => path.join(__dirname, files().baseline);
const CAND = () => readJson(path.join(__dirname, files().cand));
const HONO = () => (SET ? { candidates: [] } : readJson(path.join(__dirname, 'hono-candidates.json')));
const mainResults = () => (fs.existsSync(path.join(__dirname, 'results.json')) ? readJson(path.join(__dirname, 'results.json')) : { rows: {} }); // positive controls live here
const REPEATS = 3;
const ENV_KEEP = ['PATH', 'Path', 'SYSTEMROOT', 'SystemRoot', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'COMSPEC', 'PATHEXT', 'NODE_OPTIONS'];
const fill = (s, v) => String(s).replace(/\{(\w+)\}/g, (m, k) => (k in v ? v[k] : m));
const posix = (p) => p.replace(/\\/g, '/');
const loadResults = () => (fs.existsSync(resultsFile()) ? readJson(resultsFile()) : { rows: {} });
const saveResults = (r) => fs.writeFileSync(resultsFile(), JSON.stringify(r, null, 1) + '\n');

// Findings that get a packet and a test: NEAR, FAR (and unit-touched weak_test); UNTOUCHED was not run: structural zero by construction. hono findings are the mutation arm.
function scope() {
  const c = CAND(), pairs = new Map(c.prs.map((p) => [p.replay_id, p]));
  const reps = c.candidates.filter((x) => x.in_oracle_set && (x.status === undefined || x.status === 'ok')).map((x) => ({ ...x, group: x.pr, buggy: x.buggy_sha, fixed: x.fixed_sha }));
  const hono = HONO().candidates.map((x) => ({ ...x, group: 'hono-5ca49b0', buggy: x.buggy_sha, fixed: null, arm: 'MUTATION' }));
  return { reps, hono, pairs };
}
const fieldsOf = (id) => (SET ? { ...readJson(path.join(F2P, files().fields))[id] } : { ...(readJson(path.join(F2P, 'holdout2-fields.json'))[id] || readJson(path.join(F2P, 'hono-fields.json'))[id]) });

// Buggy trees only. The fixed tree is never written under <evidence>/f2p/trees; run exports it into a temp dir after the writer is done.
function archive(clone, rev, dest) {
  diskGuard();
  fs.mkdirSync(dest, { recursive: true });
  const name = `f2p-${process.pid}-${rev.slice(0, 8)}.tar`, tar = path.join(os.tmpdir(), name);
  execFileSync('git', ['-C', clone, 'archive', '--format=tar', '-o', tar, rev]);
  const x = spawnSync('tar', ['-xf', name, '-C', dest.replace(/\\/g, '/').replace(/^([A-Za-z]):\//, (m, d) => '/' + d.toLowerCase() + '/')], { cwd: os.tmpdir(), stdio: 'ignore' }); // relative -f: GNU tar reads 'C:' as a host // symlink warnings on Windows are not fatal
  fs.rmSync(tar, { force: true });
  assertExport({ status: x.status, files: countFiles(dest), expected: expectedFiles(clone, rev), rev });
}
// An export is complete when tar ran and the number of files on disk equals the number of files of the commit (`git ls-tree -r`, submodule entries excluded). tar may exit non-zero on Windows when it cannot create a symlink; that is accepted only when every file is there.
const countFiles = (dir) => { let n = 0; const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (e.isDirectory()) walk(path.join(d, e.name)); else if (!(d === dir && e.name === '.sha')) n++; } }; walk(dir); return n; };
const expectedFiles = (clone, rev) => execFileSync('git', ['-C', clone, 'ls-tree', '-r', rev], { encoding: 'utf8', maxBuffer: 1 << 28 }).split('\n').filter((l) => l && !l.startsWith('160000')).length;
function assertExport({ status, files, expected, rev }) {
  if (status === null || status === undefined) throw new Error(`tar did not run for ${String(rev).slice(0, 8)}`);
  if (files !== expected) throw new Error(`export of ${String(rev).slice(0, 8)} is incomplete: tar exit ${status}, ${files} files on disk, ${expected} in the commit`);
}
// Every exported tree carries .sha (the commit it was exported from); export, baseline, try and run refuse a tree whose .sha differs, or a tree without one (run seal-trees for trees exported before .sha existed).
const treeSha = (group, dir) => { try { return fs.readFileSync(path.join(dir || treeDir(group), '.sha'), 'utf8').trim(); } catch { return null; } };
function checkTree(group, rev, dir) { const have = treeSha(group, dir); if (have !== rev) throw new Error(`exported tree ${group} is at ${have || 'an unknown commit (no .sha; run seal-trees)'}, expected ${rev.slice(0, 8)}`); }
// seal-trees: write .sha into an existing tree only after the tree matches `git archive` of its buggy sha byte for byte; a tree that does not match is reported and left alone.
function cmdSealTrees() {
  diskGuard();
  const { reps, hono } = scope(), done = new Set(), report = [];
  for (const c of [...reps, ...hono]) {
    if (done.has(c.group)) continue; done.add(c.group);
    const dir = treeDir(c.group); if (!fs.existsSync(dir)) { report.push({ group: c.group, status: 'no tree' }); continue; }
    if (treeSha(c.group) === c.buggy) { report.push({ group: c.group, status: 'sealed' }); continue; }
    const want = readTar(execFileSync('git', ['-C', cloneOf(c.repo), 'archive', '--format=tar', c.buggy], { maxBuffer: 1 << 30 })), have = new Map(), walk = (rel) => { for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) { const q = rel ? rel + '/' + e.name : e.name; if (e.isDirectory()) walk(q); else if (q !== '.sha') have.set(q, true); } };
    walk('');
    const missing = [...want.keys()].filter((p) => !have.has(p)), extra = [...have.keys()].filter((p) => !want.has(p) && !want.links.has(p) && !/(^|\/)__pycache__\//.test(p)), // symlinks of the archive are plain files on Windows; __pycache__ is bytecode written by running tests in the tree
       diff = [...want.keys()].filter((p) => have.has(p) && sha(fs.readFileSync(path.join(dir, p))) !== sha(want.get(p)));
    if (missing.length || extra.length || diff.length) report.push({ group: c.group, status: 'MISMATCH, not sealed', missing: missing.length, extra: extra.length, different: diff.length, example: (missing[0] || extra[0] || diff[0]) });
    else { fs.writeFileSync(path.join(dir, '.sha'), c.buggy + '\n'); report.push({ group: c.group, status: 'sealed now' }); }
  }
  console.log(JSON.stringify(report, null, 1));
}
function cmdExport() {
  const { reps, hono } = scope(), done = new Set();
  for (const c of [...reps, ...hono]) {
    if (done.has(c.group)) continue; done.add(c.group);
    const dest = treeDir(c.group);
    if (!fs.existsSync(dest)) { archive(cloneOf(c.repo), c.buggy, dest); fs.writeFileSync(path.join(dest, '.sha'), c.buggy + '\n'); }
    else checkTree(c.group, c.buggy);
    fs.rmSync(path.join(treeRoot(), c.group, 'fixed'), { recursive: true, force: true });
  }
  console.log(`exported ${done.size} buggy trees to ${treeRoot()}`);
}

// One markdown packet per PR: finding fields verbatim, buggy tree path, how to run, where to save. No fix information, no arm, no distance; findings shuffled with seed 1.
function cmdPackets() {
  const { reps, hono } = scope(), R = REPOS(), by = {};
  for (const c of [...reps, ...hono]) (by[c.group] = by[c.group] || []).push(c);
  fs.mkdirSync(packetsDir(), { recursive: true });
  const summary = {}, bf = baselineFile(), B = fs.existsSync(bf) ? readJson(bf) : {}, HS = harnessStatus(mainResults(), mainBaseline());
  for (const [group, cs] of Object.entries(by)) {
    const cfg0 = R[cs[0].repo] || {}, bl = B[group], hst = (HS[cs[0].repo] || {}).status; // no packet where the repo or the PR cannot run: those findings are `unrunnable` without a test
    summary[cs[0].repo] = summary[cs[0].repo] || { packets: 0, findings: 0, findings_total: 0 }; summary[cs[0].repo].findings_total += cs.length;
    if (cfg0.status === 'unrunnable' || hst === 'invalid' || (bl && bl.status !== 'green') || (!bl && group !== 'hono-5ca49b0' && process.env.F2P_NO_BASELINE !== '1')) { try { fs.rmSync(path.join(packetsDir(), group + '.md')); } catch { /* none */ } continue; }
    cs.sort((a, b) => a.id.localeCompare(b.id)); shuffle(cs, rng(1));
    const repo = cs[0].repo, cfg = R[repo] || {}, tree = treeDir(group);
    const L = [`# Packet ${group}`, '', `Repository: ${repo}`, `Source tree (read-only reference, no git history): \`${posix(tree)}\``, '', `Test command for one test file (run through the harness so dependencies are present; it prints only pass, assertion failure or error on this source tree): \`node ${posix(ROOT)}/eval/f2p/f2p.js try <finding-id>\``, `The repo's own command shape: \`${fill(cfg.cmd || '(see repos.json)', { test: '<test file>', out: 'out.json', testdir: '<dir>', evidence: '<evidence>' })}\``, '',
      'Write ONE new test file per finding (a new file next to the existing tests for that code, never an edit of an existing test file). Save it at `' + posix(testsRoot('')) + '/<finding-id>/<path of the new test file relative to the repo root>`. You may iterate on the source tree until your test runs without a compile, import or collection error. Read only this packet and the source tree. The goal: a test that expresses what the finding says is missing or weak.', ''];
    cs.forEach((c, i) => {
      const f = fieldsOf(c.id);
      L.push(`## Finding ${i + 1}: \`${c.id}\``, '', `- kind: ${f.kind}`, `- path: ${f.path}`, `- line: ${f.line}`, `- title: ${f.title}`, '', 'Body:', '', f.body || '(none)', '');
      if (f.counterexample) L.push('Counterexample:', '', f.counterexample, '');
      if (f.skeleton) L.push('Test skeleton suggested by the finding:', '', f.skeleton, '');
      if (f.quote) L.push('Cited code:', '', '```', f.quote, '```', '');
    });
    fs.writeFileSync(path.join(packetsDir(), `${group}.md`), L.join('\n'));
    summary[repo].packets++; summary[repo].findings += cs.length;
  }
  console.log(JSON.stringify(summary, null, 1));
}

// Work dir = tree at some base sha plus installed dependencies (<evidence>/f2p/work/<name>, .sha marker). Sources move between shas by overlaying the git diff (tracked files only).
function workDir(repo) { return path.join(F2P, 'work', REPOS()[repo].name); }
const nameStatus = (repo, a, b) => execFileSync('git', ['-C', cloneOf(repo), 'diff', '--name-status', '--no-renames', a, b], { encoding: 'utf8', maxBuffer: 1 << 28 }).split('\n').filter(Boolean).map((l) => l.split('\t'));
const blob = (repo, rev, p) => blobs(repo, rev, [p]).get(p);
// Tar reader for `git archive` output: Map(path -> Buffer). Handles ustar prefix and pax `path=` records; skips directories and symlinks.
function readTar(buf) {
  const out = new Map(); out.links = new Set(); let off = 0, pax = null;
  const str = (a, b) => buf.toString('utf8', a, b).replace(/\0.*$/s, '');
  while (off + 512 <= buf.length) {
    if (buf.subarray(off, off + 512).every((x) => x === 0)) break;
    const type = String.fromCharCode(buf[off + 156] || 48), size = parseInt(str(off + 124, off + 136).trim() || '0', 8), data = buf.subarray(off + 512, off + 512 + size);
    let name = (str(off + 345, off + 500) ? str(off + 345, off + 500) + '/' : '') + str(off, off + 100);
    if (type === 'x') { for (const m of data.toString('utf8').matchAll(/\d+ path=([^\n]*)\n/g)) pax = m[1]; }
    else if (type === 'g') { /* global header: commit id */ }
    else { if (pax) { name = pax; pax = null; } if (type === '0' || type === '\0') out.set(name, Buffer.from(data)); else if (type === '2') out.links.add(name); }
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return out;
}
// Content of many paths at one rev exactly as `git archive` writes them (this clone applies eol conversion, so blobs differ): Map(path -> Buffer | null when absent at rev).
function blobs(repo, rev, paths) {
  const out = new Map(paths.map((p) => [p, null])); if (!paths.length) return out;
  const clone = cloneOf(repo), have = execFileSync('git', ['-C', clone, 'cat-file', '--batch-check'], { input: paths.map((p) => `${rev}:${p}\n`).join(''), encoding: 'utf8', maxBuffer: 1 << 28 }).split('\n');
  const present = paths.filter((p, i) => have[i] && !/ (missing|ambiguous)$/.test(have[i]));
  for (let i = 0; i < present.length; i += 100) for (const [p, b] of readTar(execFileSync('git', ['-C', clone, 'archive', '--format=tar', rev, '--', ...present.slice(i, i + 100)], { maxBuffer: 1 << 30 }))) out.set(p, b);
  return out;
}

// Whole-diff overlay: added, modified and deleted files (name-status --no-renames) from the marker sha to `to`. Returns the work dir.
function sync(repo, to) {
  const dir = workDir(repo), mark = path.join(dir, '.sha'), from = fs.readFileSync(mark, 'utf8').trim();
  if (from !== to) {
    const rows = nameStatus(repo, from, to), data = blobs(repo, to, rows.filter(([st]) => st !== 'D').map(([, p]) => p));
    for (const [st, p] of rows) {
      const abs = path.join(dir, p);
      if (st === 'D') fs.rmSync(abs, { force: true });
      else { fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, data.get(p)); }
    }
    fs.writeFileSync(mark, to);
  }
  return dir;
}
// Every path of the diff base..rev must be byte-identical (sha256) to `git archive` of `at`, or absent when it does not exist there. Refuses otherwise.
function verifyTree(repo, dir, at, paths) {
  const want = blobs(repo, at, paths);
  const bad = paths.filter((p) => { const w = want.get(p), abs = path.join(dir, p), have = fs.existsSync(abs) ? fs.readFileSync(abs) : null; return w === null ? have !== null : have === null || sha(have) !== sha(w); });
  if (bad.length) throw new Error(`work dir differs from ${at.slice(0, 8)} at ${bad.length} path(s), e.g. ${bad[0]}`);
}
// Build step and cache clearing after every overlay and restore (repos.json `build`): dist/ of workspace packages, tsbuildinfo, vitest/vite caches.
function rebuild(repo, dir) {
  const cfg = REPOS()[repo];
  for (const c of ['node_modules/.vite', 'node_modules/.vitest', 'node_modules/.cache', '.vitest', '.turbo']) fs.rmSync(path.join(dir, c), { recursive: true, force: true });
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (e.name === 'node_modules' || e.name === '.git') continue; const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.name.endsWith('.tsbuildinfo')) fs.rmSync(p, { force: true }); } };
  walk(dir);
  if (cfg.build) { const r = spawnSync(fill(cfg.build, { evidence: posix(EV) }), { cwd: dir, shell: true, encoding: 'utf8', timeout: 900000, maxBuffer: 1 << 28 }); if (r.status !== 0) throw new Error(`build failed: ${(r.stderr || r.stdout || '').slice(-300)}`); }
}
// Full check of a work dir against its marker sha: every tracked file byte-identical (use after an interrupted run).
function cmdVerify(repo) {
  const dir = workDir(repo), rev = fs.readFileSync(path.join(dir, '.sha'), 'utf8').trim();
  const paths = execFileSync('git', ['-C', cloneOf(repo), 'ls-tree', '-r', '--name-only', rev], { encoding: 'utf8', maxBuffer: 1 << 28 }).split('\n').filter(Boolean);
  if (process.argv.includes('--repair')) { const want = blobs(repo, rev, paths); for (const p of paths) { const abs = path.join(dir, p), w = want.get(p); if (w && (!fs.existsSync(abs) || sha(fs.readFileSync(abs)) !== sha(w))) fs.writeFileSync(abs, w); } }
  verifyTree(repo, dir, rev, paths); console.log(`${repo}: ${paths.length} tracked files identical to ${rev.slice(0, 8)}`);
}
function cmdSetup(repo, rev) {
  const dir = workDir(repo);
  if (fs.existsSync(path.join(dir, '.sha'))) return console.log(`${dir} exists`);
  archive(cloneOf(repo), rev, dir); fs.writeFileSync(path.join(dir, '.sha'), rev); fs.writeFileSync(path.join(dir, '.base'), rev);
  console.log(`work dir ${dir} at ${rev}; install dependencies there, then record the decision in repos.json`);
}

// Whitelisted environment of one run (ENV_KEEP + the repo's env + path_prepend).
function buildEnv(cfg, dir) {
  const env = Object.fromEntries(ENV_KEEP.filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]]));
  env.CI = '1'; // vitest never writes snapshots under CI
  for (const [k, v] of Object.entries(cfg.env || {})) env[k] = fill(v, { evidence: posix(EV), cwd: posix(dir) });
  if (cfg.path_prepend) { const v = cfg.path_prepend.map((p) => fill(p, { evidence: EV })).join(path.delimiter) + path.delimiter + (env.Path || env.PATH || ''); env.Path = v; env.PATH = v; }
  return env;
}
// One run of a test file in dir -> { outcome, msg?, origin?, frame? }.
function runOnce(repo, dir, testRel, timeout) {
  const cfg = REPOS()[repo], out = path.join(os.tmpdir(), `f2p-${process.pid}.out`);
  fs.rmSync(out, { force: true });
  const env = buildEnv(cfg, dir);
  timeout = timeout || cfg.timeout || 180;
  let run = '.'; try { const fns = [...fs.readFileSync(path.join(dir, testRel), 'utf8').matchAll(/^func (Test\w+)\(/gm)].map((m) => m[1]); if (fns.length) run = `^(${fns.join('|')})$`; } catch { /* not a Go file */ }
  const vars = { run, test: posix(testRel), out: posix(out), testdir: posix(path.posix.dirname(posix(testRel))) || '.', evidence: posix(EV) };
  let cmd = cfg.cmd; // alt: a second environment for trees whose conftest needs different test plugins
  if (cfg.alt) { try { if (fs.readFileSync(path.join(dir, cfg.alt.file), 'utf8').includes(cfg.alt.has)) cmd = cfg.alt.cmd; } catch { /* keep default */ } }
  const res = spawnSync(fill(cmd, vars), { cwd: dir, shell: true, env, timeout: timeout * 1000, encoding: 'utf8', maxBuffer: 1 << 28 });
  if (res.error && res.error.code === 'ETIMEDOUT') return { outcome: 'error', msg: 'timeout' };
  if (cfg.runner === 'vitest') return parseVitest(res, out, dir);
  if (cfg.runner === 'pytest') return parsePytest(fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : '', dir);
  if (cfg.runner === 'go') return parseGo(res.stdout, dir, res.stderr);
  throw new Error(`unknown runner ${cfg.runner}`);
}

const testFiles = (id) => { const base = testsRoot(id), out = []; const walk = (d) => { for (const e of fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }) : []) e.isDirectory() ? walk(path.join(d, e.name)) : out.push(posix(path.relative(base, path.join(d, e.name)))); }; walk(base); return out.sort(); };
const hashes = (id) => Object.fromEntries(testFiles(id).map((r) => [r, sha(fs.readFileSync(path.join(testsRoot(id), r), 'utf8'))]));

// Freeze: record the hashes of the submitted test files before any fixed run; refuse when a recorded hash no longer matches.
function freeze(row, h) {
  if (row.test_sha256_frozen && JSON.stringify(row.test_sha256_frozen) !== JSON.stringify(h)) throw new Error(`test file changed since it was frozen: ${row.id}`);
  row.test_sha256_frozen = row.test_sha256_frozen || h;
  return row;
}

// Run `fn(dir)` with the tree at `rev` in place. overlay: dependency work dir moved to rev (restored to its base afterwards); export: a fresh temp export deleted afterwards.
// Shared machine: refuse any tree step when C: (or the temp drive) has less than 1.5 GB free.
const MIN_FREE = 1.5e9;
function diskGuard() { const s = fs.statfsSync(os.tmpdir()); if (s.bavail * s.bsize < MIN_FREE) throw new Error(`disk guard: under 1.5 GB free on the temp drive, refusing to run`); }
function withTree(repo, group, rev, kind, fn) {
  diskGuard();
  const cfg = REPOS()[repo];
  if (cfg.tree === 'overlay') {
    const dir = workDir(repo), base = fs.readFileSync(path.join(dir, '.base'), 'utf8').trim();
    const paths = nameStatus(repo, base, rev).map(([, p]) => p);
    sync(repo, rev); verifyTree(repo, dir, rev, paths); rebuild(repo, dir);
    try { return fn(dir); } finally { sync(repo, base); verifyTree(repo, dir, base, paths); rebuild(repo, dir); }
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `f2p-${kind}-`));
  try { archive(cloneOf(repo), rev, tmp); return fn(tmp); } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}
// A test file is placed only at a path that does not exist in the tree yet.
const assertFree = (dir, rels) => { for (const r of rels) if (fs.existsSync(path.join(dir, r))) throw new Error(`test path already exists in the tree: ${r}`); };
const place = (dir, id) => { assertFree(dir, testFiles(id)); for (const r of testFiles(id)) { fs.mkdirSync(path.dirname(path.join(dir, r)), { recursive: true }); fs.copyFileSync(path.join(testsRoot(id), r), path.join(dir, r)); } };
const unplace = (dir, id) => { for (const r of testFiles(id)) fs.rmSync(path.join(dir, r), { force: true }); };
const lock = (repo) => { const l = path.join(F2P, 'work', REPOS()[repo].name + '.lock'); for (let i = 0; i < 600; i++) { try { fs.mkdirSync(l); return () => fs.rmSync(l, { recursive: true, force: true }); } catch { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000); } } throw new Error('lock timeout'); };

// try: one run on the buggy tree for a writer; prints the outcome only (no fixed information).
function cmdTry(id) {
  const c = [...scope().reps, ...scope().hono].find((x) => x.id === id); if (!c) throw new Error('unknown finding id');
  const cfg = REPOS()[c.repo]; if (cfg.status === 'unrunnable') return console.log(`unrunnable: ${cfg.reason}`);
  checkTree(c.group, c.buggy);
  const free = lock(c.repo);
  try { const o = withTree(c.repo, c.group, c.buggy, 'try', (dir) => { place(dir, id); try { return testFiles(id).map((t) => runOnce(c.repo, dir, t)); } finally { unplace(dir, id); } }); console.log(JSON.stringify(o)); } finally { free(); }
}

// Nearest existing test file of a candidate path in a tree: the file itself when it is a test, a sibling test, else any test file in the directory.
function nearestTest(dir, p) {
  const isTest = (f) => /(\.(test|spec)\.[cm]?[jt]sx?|_test\.go|(^|\/)test_[^/]*\.py|_test\.py)$/.test(f);
  if (isTest(p)) return p;
  for (let d = path.posix.dirname(p); ; d = path.posix.dirname(d)) {
    const abs = path.join(dir, d === '.' ? '' : d), names = fs.existsSync(abs) ? fs.readdirSync(abs) : [];
    const stem = path.posix.parse(p).name, hit = names.find((n) => isTest(n) && n.startsWith(stem)) || names.find(isTest);
    if (hit) return posix(path.posix.join(d === '.' ? '' : d, hit));
    if (d === '.' || d === '/') break;
  }
  const stem = path.posix.parse(p).name, found = [], walk = (rel) => { for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) { if (['node_modules', '.git'].includes(e.name)) continue; const q = path.posix.join(rel, e.name); if (e.isDirectory()) walk(q); else if (isTest(e.name) && (e.name.includes(stem) || q.split('/').includes(stem))) found.push(q); } };
  walk('.');
  const common = (q) => { let i = 0; while (i < p.length && p[i] === q[i]) i++; return i; };
  return found.sort((a, b) => common(b) - common(a) || a.length - b.length)[0] || null;
}
function cmdBaseline(only) {
  const { reps } = scope(), R = REPOS(), file = baselineFile(), B = fs.existsSync(file) ? readJson(file) : {}, seen = new Set();
  for (const c of reps) {
    if (seen.has(c.group) || (only && !only.includes(c.group) && !only.includes(c.repo))) continue; seen.add(c.group);
    const cfg = R[c.repo]; if (!cfg || cfg.status === 'unrunnable') { B[c.group] = { status: 'unrunnable', reason: (cfg && cfg.reason) || 'repo not configured' }; fs.writeFileSync(file, JSON.stringify(B, null, 1) + '\n'); continue; }
    checkTree(c.group, c.buggy);
    const paths = reps.filter((x) => x.group === c.group).map((x) => x.path), tests = [...new Set(paths.map((p) => nearestTest(treeDir(c.group), p)).filter(Boolean))];
    const free = lock(c.repo);
    try { B[c.group] = withTree(c.repo, c.group, c.buggy, 'baseline', (dir) => { const r = tests.slice(0, 3).map((t) => ({ test: t, ...runOnce(c.repo, dir, t) })); return { status: r.length && r.every((x) => x.outcome === 'pass') ? 'green' : 'not_green', reason: r.length ? r.filter((x) => x.outcome !== 'pass').map((x) => `${x.test}: ${x.outcome} ${x.msg || ''}`).join('; ') : 'no existing test file found', tests: r.map((x) => x.test) }; }); } finally { free(); }
    console.error(c.group, B[c.group].status);
    fs.writeFileSync(file, JSON.stringify(B, null, 1) + '\n');
  }
}

// Positive control: every test file the fix added or edited, run through the identical harness (fix version copied into the buggy tree, 3x; then 3x on fixed). Expected: verified or verified_throw.
// Fix tests never appear in packets. A PR is a control success when at least one of its fix test files is verified/verified_throw.
const TESTFILE = /(\.(test|spec)\.[cm]?[jt]sx?|_test\.go|(^|\/)test_[^/]*\.py|_test\.py)$/;
// A control result is recorded here. An interrupted run (disk guard, memory, a harness exception) is a harness_error: it never replaces an earlier completed result (it is kept under positive_control_errors) and it is not counted in k/n.
function recordControl(res, group, entry) {
  const PC = (res.positive_control = res.positive_control || {}), old = PC[group];
  if (entry.status === 'harness_error' && old && old.status !== 'harness_error') { (res.positive_control_errors = res.positive_control_errors || {})[group] = { reason: entry.reason }; return old; }
  PC[group] = entry; return entry;
}
function cmdControls(only) {
  if (SET) throw new Error('positive controls are per harness, not per list set');
  const { reps } = scope(), R = REPOS(), res = loadResults(), PC = (res.positive_control = res.positive_control || {}), seen = new Set();
  for (const c of reps) {
    if (seen.has(c.group) || (only && !only.includes(c.group) && !only.includes(c.repo))) continue; seen.add(c.group);
    const cfg = R[c.repo];
    try {
    if (!cfg || cfg.status === 'unrunnable') { recordControl(res, c.group, { repo: c.repo, status: 'unrunnable', reason: (cfg && cfg.reason) || 'repo not configured' }); continue; }
    const tests = nameStatus(c.repo, c.buggy, c.fixed).filter(([st, p]) => st !== 'D' && TESTFILE.test(p)).map(([, p]) => p);
    if (!tests.length) { recordControl(res, c.group, { repo: c.repo, status: 'none', reason: 'the fix adds or edits no test file' }); continue; }
    const files = [], free = lock(c.repo);
    try {
      for (const f of tests) {
        const want = blob(c.repo, c.fixed, f), before = blob(c.repo, c.buggy, f);
        const buggy = withTree(c.repo, c.group, c.buggy, 'pc-buggy', (dir) => {
          const abs = path.join(dir, f); fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, want);
          try { return Array.from({ length: REPEATS }, () => runOnce(c.repo, dir, f)); } finally { if (before) fs.writeFileSync(abs, before); else fs.rmSync(abs, { force: true }); }
        });
        const fixed = withTree(c.repo, c.group, c.fixed, 'pc-fixed', (dir) => Array.from({ length: REPEATS }, () => runOnce(c.repo, dir, f)));
        const v = verdict(buggy, fixed, {});
        files.push({ file_sha256: sha(f).slice(0, 12), verdict: v.verdict, reason: v.reason, buggy: buggy.map((r) => r.outcome), fixed: fixed.map((r) => r.outcome) });
      }
    } finally { free(); }
    const ok = files.some((x) => x.verdict === 'verified' || x.verdict === 'verified_throw');
    recordControl(res, c.group, { repo: c.repo, status: ok ? 'verified' : 'not_verified', files });
    saveResults(res); console.error(c.group, PC[c.group].status, files.map((x) => x.verdict).join(','));
    } catch (e) { recordControl(res, c.group, { repo: c.repo, status: 'harness_error', reason: String(e.message).slice(0, 300) }); saveResults(res); console.error(c.group, 'harness_error', String(e.message).slice(0, 120)); }
  }
  saveResults(res);
}
// Per-repo harness validity from the positive controls: k/n over runnable controls; < 80% invalid; no control at all unvalidated.
function harnessStatus(res, baseline = {}) {
  const out = {};
  for (const [grp, pc] of Object.entries(res.positive_control || {})) {
    if (baseline[grp] && baseline[grp].status !== 'green') { out[pc.repo] = out[pc.repo] || { k: 0, n: 0 }; continue; } // baseline not green: the control is not runnable
    const o = (out[pc.repo] = out[pc.repo] || { k: 0, n: 0 });
    if (pc.status === 'verified') { o.k++; o.n++; } else if (pc.status === 'not_verified') o.n++; // harness_error (interrupted run) is not counted
  }
  for (const o of Object.values(out)) o.status = o.n === 0 ? 'unvalidated' : o.k / o.n < 0.8 ? 'invalid' : 'valid';
  return out;
}
// The gate is per set: a list set's writers are separate from the holdout2 writers of the same repo.
const doneDir = () => path.join(F2P, SET ? `writers_done-${SET}` : 'writers_done');
const cmdWritersDone = (repo) => { const d = doneDir(); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, REPOS()[repo].name), new Date().toISOString()); };
const writersDone = (repo) => fs.existsSync(path.join(doneDir(), REPOS()[repo].name));

const diffText = (repo, a, b) => execFileSync('git', ['-C', cloneOf(repo), 'diff', '-U0', '--no-renames', a, b], { encoding: 'utf8', maxBuffer: 1 << 28 });
const callNames = (id) => [...new Set(testFiles(id).flatMap((r) => [...fs.readFileSync(path.join(testsRoot(id), r), 'utf8').matchAll(/\b([A-Za-z_]\w*)\s*\(/g)].map((m) => m[1])))];

// run: for each finding with a written test (replay arm). Freeze -> 3 buggy runs -> 3 fixed runs (fixed tree only exists during these runs) -> verdict.
function cmdRun(only) {
  const { reps } = scope(), R = REPOS(), res = loadResults(), bfile = baselineFile(), B = fs.existsSync(bfile) ? readJson(bfile) : {};
  for (const c of reps) {
    if (only && !only.includes(c.id) && !only.includes(c.group)) continue;
    if (!testFiles(c.id).length) continue;
    const cfg = R[c.repo], bl = B[c.group];
    if (cfg && !writersDone(c.repo)) { console.error(`skip ${c.id.slice(0, 8)}: writers for ${c.repo} not marked done (writers-done)`); continue; }
    const row = res.rows[c.id] || { id: c.id, pr: c.pr, repo: c.repo, kind: c.kind, claim_match: null, claim_reason: null }; res.rows[c.id] = row;
    if (!cfg || cfg.status === 'unrunnable') { Object.assign(row, { verdict: 'unrunnable', reason: (cfg && cfg.reason) || 'repo not configured' }); saveResults(res); continue; }
    if (!bl || bl.status !== 'green') { Object.assign(row, { verdict: 'unrunnable', reason: `baseline: ${bl ? bl.status + ' ' + bl.reason : 'not checked'}` }); saveResults(res); continue; }
    if (scope().pairs.get(c.group).deps_changed) { Object.assign(row, { verdict: 'deps_changed', reason: 'the fix changes a dependency manifest and no reinstall is done; excluded from the measures' }); saveResults(res); continue; }
    checkTree(c.group, c.buggy);
    freeze(row, hashes(c.id)); // after every gate: a refused or skipped finding is never frozen
    saveResults(res); // frozen hashes are on disk before any fixed run
    const free = lock(c.repo);
    try {
      const go = (rev, kind) => withTree(c.repo, c.group, rev, kind, (dir) => { place(dir, c.id); try { return testFiles(c.id).length ? Array.from({ length: REPEATS }, () => combine(testFiles(c.id).map((t) => runOnce(c.repo, dir, t)))) : []; } finally { unplace(dir, c.id); } });
      const buggy = go(c.buggy, 'buggy'), fixed = go(c.fixed, 'fixed');
      const apiShift = buggy.some((r) => r.outcome === 'throw') && signatureChanged(diffText(c.repo, c.buggy, c.fixed), callNames(c.id));
      const v = verdict(buggy, fixed, { apiShift });
      Object.assign(row, { verdict: v.verdict, subtype: v.subtype, reason: v.reason, top_frame: v.frame, runs: { buggy: buggy.map((r) => r.outcome), fixed: fixed.map((r) => r.outcome) } });
    } finally { free(); }
    saveResults(res);
    console.error(c.id.slice(0, 8), c.pr, row.verdict);
  }
}

// Mutation arm (hono): unmutated 3x, then each survivor/uncertain mutant of the unit 3x, applied by the harness at run time only.
function cmdRunMutation(only) {
  if (SET) throw new Error('the mutation arm is not available for list sets');
  diskGuard();
  const man = readJson(path.join(ROOT, 'eval/mutation/hono-5ca49b0.json')), res = loadResults();
  for (const c of HONO().candidates) {
    if ((only && !only.includes(c.id)) || !testFiles(c.id).length) continue;
    const row = freeze(res.rows[c.id] || { id: c.id, pr: c.pr, repo: c.repo, kind: c.kind, claim_match: null, claim_reason: null }, hashes(c.id)); res.rows[c.id] = row; saveResults(res);
    const free = lock(c.repo);
    try {
      const dir = sync(c.repo, man.sha); place(dir, c.id);
      try {
        const rep = () => Array.from({ length: REPEATS }, () => combine(testFiles(c.id).map((t) => runOnce(c.repo, dir, t))));
        const base = rep();
        if (base.some((r) => r.outcome !== 'pass')) { Object.assign(row, { verdict: 'invalid', subtype: 'other', reason: 'does not pass 3/3 on the unmutated tree', runs: { unmutated: base.map((r) => r.outcome) } }); continue; }
        const abs = c.unit && path.join(dir, c.unit), orig = abs && fs.readFileSync(abs, 'utf8'), kills = [], killsUncertain = [], flaky = [];
        for (const mid of [...c.survivors, ...c.uncertain_survivors]) {
          const m = man.mutants.find((x) => x.id === mid), t = apply(orig, m); if (t === null) continue;
          fs.writeFileSync(abs, t);
          try { const o = rep().map((r) => r.outcome); if (o.every((x) => x === 'assert_fail')) (c.survivors.includes(mid) ? kills : killsUncertain).push(mid); else if (new Set(o).size > 1) flaky.push(mid); } finally { fs.writeFileSync(abs, orig); }
        }
        Object.assign(row, { verdict: kills.length ? 'verified' : flaky.length ? 'flaky' : 'not_discriminating', reason: `kills ${kills.length} survivor(s), ${killsUncertain.length} uncertain`, kills, kills_uncertain: killsUncertain, flaky_mutants: flaky, runs: { unmutated: base.map((r) => r.outcome) } });
      } finally { unplace(dir, c.id); }
    } finally { free(); }
    saveResults(res);
  }
}

// ---- list input: rows from another eval, verified through the same harness ----
// Pure: rows and per-finding fields from the caller's list. env = { repos, harness(repo) -> 'valid'|..., hasClone(repo), shaExists(repo, sha), depsChanged(repo, a, b) }.
// Ids, groups and set names become file names: letters, digits, dot, underscore, dash only, never only dots, never 'buggy' or 'fixed'.
const badName = (v) => !/^[A-Za-z0-9._-]+$/.test(String(v)) || /^\.+$/.test(String(v)) || ['buggy', 'fixed'].includes(String(v));
function buildListRows(list, name, env) {
  if (!Array.isArray(list)) throw new Error('the list must be a JSON array');
  const ex = env.existing || { ids: new Set(), groups: new Map(), sets: new Set() }, pairOf = new Map();
  if (badName(name)) throw new Error(`set name ${name} is not allowed (letters, digits, . _ - only; not buggy or fixed)`);
  if (ex.groups.has(name)) throw new Error(`set name ${name} equals an existing group`);
  const rows = [], fields = {}, prs = new Map(), seen = new Set();
  list.forEach((e, i) => {
    const f = e.finding || {};
    for (const k of ['repo', 'buggy_sha', 'fixed_sha']) if (!e[k]) throw new Error(`entry ${i}: ${k} is required`);
    for (const k of ['kind', 'path', 'title', 'body']) if (!f[k]) throw new Error(`entry ${i}: finding.${k} is required`);
    const cfg = env.repos[e.repo], rname = (cfg && cfg.name) || String(e.repo).split('/').pop();
    const group = e.pr || `${rname}-${e.buggy_sha.slice(0, 8)}`;
    const id = e.id || sha([name, e.repo, e.buggy_sha, f.path, f.line, f.title].join('|'));
    if (badName(id)) throw new Error(`entry ${i}: id ${String(id).slice(0, 20)} is not allowed (letters, digits, . _ - only)`);
    if (badName(group)) throw new Error(`entry ${i}: group ${String(group).slice(0, 20)} is not allowed (letters, digits, . _ - only; not buggy or fixed)`);
    if (ex.sets && ex.sets.has(group)) throw new Error(`entry ${i}: group ${group} equals the name of an existing set`);
    if (seen.has(id)) throw new Error(`entry ${i}: duplicate id ${id.slice(0, 12)}`);
    if (ex.ids.has(id)) throw new Error(`entry ${i}: id ${id.slice(0, 12)} already exists in another set (${ex.ids.get ? ex.ids.get(id) : 'elsewhere'})`);
    if (ex.groups.has(group)) throw new Error(`entry ${i}: group ${group} already exists in set ${ex.groups.get(group)}`);
    const pair = e.buggy_sha + '..' + e.fixed_sha;
    if (pairOf.has(group) && pairOf.get(group) !== pair) throw new Error(`entry ${i}: group ${group} appears with more than one buggy/fixed pair`);
    pairOf.set(group, pair);
    seen.add(id);
    let status = 'ok', reason = null;
    if (!cfg) { status = 'unrunnable'; reason = 'repo is not in repos.json'; }
    else if (cfg.status === 'unrunnable') { status = 'unrunnable'; reason = cfg.reason; }
    else if (env.harness(e.repo) !== 'valid') { status = 'unrunnable'; reason = `harness is ${env.harness(e.repo) || 'unvalidated'}, not valid`; }
    else if (!env.hasClone(e.repo) || !env.shaExists(e.repo, e.buggy_sha) || !env.shaExists(e.repo, e.fixed_sha)) { status = 'unresolved'; reason = 'buggy or fixed sha is not in the local clone'; }
    rows.push({ id, pr: group, repo: e.repo, run: name, reps: [1], kind: f.kind, path: f.path, line: Number.isInteger(f.line) ? f.line : null, title: f.title, confidence: f.confidence ?? null, where: 'list', source: `list:${name}`, buggy_sha: e.buggy_sha, fixed_sha: e.fixed_sha, fix_touched_file: null, arm: 'LIST', dist: null, in_oracle_set: true, status, reason });
    fields[id] = { title: f.title, body: f.body, counterexample: f.counterexample, quote: f.quote, path: f.path, line: f.line ?? null, kind: f.kind };
    if (!prs.has(group)) prs.set(group, { replay_id: group, repo: e.repo, buggy_sha: e.buggy_sha, fixed_sha: e.fixed_sha, sha_method: 'caller supplied', deps_changed: status === 'ok' ? env.depsChanged(e.repo, e.buggy_sha, e.fixed_sha) : false });
  });
  return { rows, fields, prs: [...prs.values()] };
}
// Ids and groups of every other candidate file (holdout2, hono, other list sets): a list may not reuse them.
function existingIds(except) {
  const ids = new Map(), groups = new Map(), sets = new Set(['holdout2', 'hono']);
  for (const fn of fs.readdirSync(__dirname).filter((n) => /-candidates\.json$/.test(n) && n !== `${except}-candidates.json`)) {
    const set = fn.replace(/-candidates\.json$/, ''), j = readJson(path.join(__dirname, fn)); sets.add(set);
    for (const c of j.candidates || []) { ids.set(c.id, set); if (c.pr) groups.set(c.pr, set); }
  }
  return { ids, groups, sets };
}
function cmdImport(listFile, name) {
  if (!listFile || !name || badName(name) || ['holdout2', 'hono'].includes(name)) throw new Error('usage: f2p.js import <list.json> --name <set> (set: letters, digits, . _ -; not buggy, fixed, holdout2 or hono)');
  const hs = harnessStatus(mainResults(), mainBaseline()), R = REPOS();
  const env = { existing: existingIds(name), repos: R, harness: (r) => (hs[r] || {}).status, hasClone: (r) => fs.existsSync(cloneOf(r)), shaExists: (r, x) => { try { execFileSync('git', ['-C', cloneOf(r), 'cat-file', '-e', x + '^{commit}'], { stdio: 'ignore' }); return true; } catch { return false; } }, depsChanged: (r, a, b) => nameStatus(r, a, b).some(([, p]) => MANIFEST.test(p)) };
  const { rows, fields, prs } = buildListRows(readJson(listFile), name, env);
  const count = (st) => rows.filter((r) => r.status === st).length;
  fs.writeFileSync(path.join(__dirname, `${name}-candidates.json`), JSON.stringify({ generated_by: `node eval/f2p/f2p.js import <list> --name ${name}`, set: name, summary: { rows: rows.length, ok: count('ok'), unrunnable: count('unrunnable'), unresolved: count('unresolved') }, prs, candidates: rows }, null, 1) + '\n');
  fs.mkdirSync(F2P, { recursive: true });
  fs.writeFileSync(path.join(F2P, `${name}-fields.json`), JSON.stringify(fields, null, 1)); // verbatim finding text stays outside the repo
  console.log(JSON.stringify({ set: name, rows: rows.length, ok: count('ok'), unrunnable: count('unrunnable'), unresolved: count('unresolved'), reasons: [...new Set(rows.filter((r) => r.status !== 'ok').map((r) => r.status + ': ' + r.reason))] }, null, 1));
}
// report --set: per-finding verdicts and the headline count (verified + claim_match yes over runnable). No NEAR/FAR arms, no power.
function cmdReportList() {
  const res = loadResults(), cands = CAND().candidates, out = [];
  for (const c of cands) {
    const r = res.rows[c.id] || {};
    out.push({ id: c.id.slice(0, 8), repo: c.repo, group: c.pr, kind: c.kind, status: c.status, verdict: c.status !== 'ok' ? c.status : r.verdict || 'not_run', claim_match: r.claim_match || null, reason: c.status !== 'ok' ? c.reason : r.reason || '' });
  }
  for (const o of out) console.log([o.id, o.repo, o.group, o.kind, o.verdict, o.claim_match || '-', o.reason].join('\t'));
  const run = out.filter((o) => !['unrunnable', 'unresolved', 'not_run', 'deps_changed'].includes(o.verdict));
  const hit = run.filter((o) => o.verdict === 'verified' && o.claim_match === 'yes').length;
  const by = out.reduce((a, o) => ((a[o.verdict] = (a[o.verdict] || 0) + 1), a), {});
  console.log('\nverdicts:', JSON.stringify(by));
  console.log(`verified and claim_match yes: ${hit} / ${run.length} runnable (of ${out.length} rows); verified without a claim_match label yet: ${run.filter((o) => o.verdict === 'verified' && !o.claim_match).length}`);
}
const mainBaseline = () => { const f = path.join(__dirname, 'baseline.json'); return fs.existsSync(f) ? readJson(f) : {}; };
const baselineOf = mainBaseline;
function cmdReport() {
  if (SET) return cmdReportList();
  const res = loadResults(), cands = CAND().candidates, armOf = Object.fromEntries(cands.map((c) => [c.id, c.arm])), rows = Object.values(res.rows).filter((r) => armOf[r.id]);
  const hs = harnessStatus(res, baselineOf()), invalidRepos = new Set(Object.entries(hs).filter(([, v]) => v.status === 'invalid').map(([k]) => k));
  console.log('Harness (positive controls, k/n):', JSON.stringify(hs));
  const t = report.tables(rows, armOf, { invalidRepos }), cmp = { primary: report.compare(t, rows, armOf, 'primary'), secondary: report.compare(t, rows, armOf, 'secondary'), sensitivity: report.compare(t, rows, armOf, 'sensitivity') };
  console.log(report.format(t, cmp));
  const near = f2p.perPr(rows.filter((r) => armOf[r.id] === 'NEAR' && r.verdict !== 'unrunnable').map((r) => ({ pr: r.pr, arm: 'NEAR' })), 'NEAR'), far = f2p.perPr(rows.filter((r) => armOf[r.id] === 'FAR' && r.verdict !== 'unrunnable').map((r) => ({ pr: r.pr, arm: 'FAR' })), 'FAR');
  if (Object.keys(near).length && Object.keys(far).length) console.log('\npower on runnable counts (decision cell icc0.3, p0 0.05):', JSON.stringify(f2p.powerTable(near, far, { sims: 300, reps: 300 })));
  const mut = Object.values(res.rows).filter((r) => r.pr === 'hono-5ca49b0');
  if (mut.length) console.log('\nMutation arm (descriptive, no rate):', JSON.stringify(mut.map((r) => ({ id: r.id.slice(0, 8), verdict: r.verdict, kills: r.kills, kills_uncertain: r.kills_uncertain, claim_match: r.claim_match }))));
}

module.exports = { buildEnv, diskGuard, lock, nameStatus, workDir, REPOS, fill, posix, cloneOf, recordControl, assertExport, countFiles, badName, assertFree, treeDir, testsRoot, packetsDir, checkTree, existingIds, cmdSealTrees, useSet, files, cmdImport, buildListRows, cmdReportList, cmdVerify, runOnce, withTree, cmdControls, cmdWritersDone, harnessStatus, cmdExport, cmdPackets, cmdSetup, cmdBaseline, cmdTry, cmdRun, cmdRunMutation, cmdReport, freeze, hashes, nearestTest, scope };
