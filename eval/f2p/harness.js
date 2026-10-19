// F2P harness commands: export, packets, setup, baseline, try, run, report (README). Node built-ins only. Generated trees, tests, packets and work dirs live under <evidence>/f2p/.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const f2p = require('./f2p');
const { rng, shuffle } = require('./stats');
const { verdict, signatureChanged } = require('./verdict');
const { parseVitest, parsePytest, parseGo } = require('./runners');
const { apply, testOf } = require('../mutation/mutate');
const report = require('./report');

const { F2P, EV, ROOT, sha, readJson, cloneOf, MANIFEST } = f2p;
const REPOS = () => readJson(path.join(__dirname, 'repos.json'));
const RESULTS = path.join(__dirname, 'results.json');
const CAND = () => readJson(path.join(__dirname, 'holdout2-candidates.json'));
const HONO = () => readJson(path.join(__dirname, 'hono-candidates.json'));
const REPEATS = 3;
const ENV_KEEP = ['PATH', 'Path', 'SYSTEMROOT', 'SystemRoot', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'COMSPEC', 'PATHEXT', 'NODE_OPTIONS'];
const fill = (s, v) => String(s).replace(/\{(\w+)\}/g, (m, k) => (k in v ? v[k] : m));
const posix = (p) => p.replace(/\\/g, '/');
const loadResults = () => (fs.existsSync(RESULTS) ? readJson(RESULTS) : { rows: {} });
const saveResults = (r) => fs.writeFileSync(RESULTS, JSON.stringify(r, null, 1) + '\n');

// Findings that get a packet and a test: NEAR, FAR (and unit-touched weak_test); UNTOUCHED was not run: structural zero by construction. hono findings are the mutation arm.
function scope() {
  const c = CAND(), pairs = new Map(c.prs.map((p) => [p.replay_id, p]));
  const reps = c.candidates.filter((x) => x.in_oracle_set).map((x) => ({ ...x, group: x.pr, buggy: x.buggy_sha, fixed: x.fixed_sha }));
  const hono = HONO().candidates.map((x) => ({ ...x, group: 'hono-5ca49b0', buggy: x.buggy_sha, fixed: null, arm: 'MUTATION' }));
  return { reps, hono, pairs };
}
const fieldsOf = (id) => ({ ...(readJson(path.join(F2P, 'holdout2-fields.json'))[id] || readJson(path.join(F2P, 'hono-fields.json'))[id]) });

// Buggy trees only. The fixed tree is never written under <evidence>/f2p/trees; run exports it into a temp dir after the writer is done.
function archive(clone, rev, dest) {
  fs.mkdirSync(dest, { recursive: true });
  const name = `f2p-${process.pid}-${rev.slice(0, 8)}.tar`, tar = path.join(os.tmpdir(), name);
  execFileSync('git', ['-C', clone, 'archive', '--format=tar', '-o', tar, rev]);
  spawnSync('tar', ['-xf', name, '-C', dest.replace(/\\/g, '/').replace(/^([A-Za-z]):\//, (m, d) => '/' + d.toLowerCase() + '/')], { cwd: os.tmpdir(), stdio: 'ignore' }); // relative -f: GNU tar reads 'C:' as a host // symlink warnings on Windows are not fatal
  fs.rmSync(tar, { force: true });
  if (!fs.readdirSync(dest).length) throw new Error(`empty export of ${rev}`);
}
function cmdExport() {
  const { reps, hono } = scope(), done = new Set();
  for (const c of [...reps, ...hono]) {
    if (done.has(c.group)) continue; done.add(c.group);
    const dest = path.join(F2P, 'trees', c.group, 'buggy');
    if (!fs.existsSync(dest)) archive(cloneOf(c.repo), c.buggy, dest);
    fs.rmSync(path.join(F2P, 'trees', c.group, 'fixed'), { recursive: true, force: true });
  }
  console.log(`exported ${done.size} buggy trees to ${path.join(F2P, 'trees')}`);
}

// One markdown packet per PR: finding fields verbatim, buggy tree path, how to run, where to save. No fix information, no arm, no distance; findings shuffled with seed 1.
function cmdPackets() {
  const { reps, hono } = scope(), R = REPOS(), by = {};
  for (const c of [...reps, ...hono]) (by[c.group] = by[c.group] || []).push(c);
  fs.mkdirSync(path.join(F2P, 'packets'), { recursive: true });
  const summary = {}, bf = path.join(__dirname, 'baseline.json'), B = fs.existsSync(bf) ? readJson(bf) : {}, HS = harnessStatus(loadResults(), B);
  for (const [group, cs] of Object.entries(by)) {
    const cfg0 = R[cs[0].repo] || {}, bl = B[group], hst = (HS[cs[0].repo] || {}).status; // no packet where the repo or the PR cannot run: those findings are `unrunnable` without a test
    summary[cs[0].repo] = summary[cs[0].repo] || { packets: 0, findings: 0, findings_total: 0 }; summary[cs[0].repo].findings_total += cs.length;
    if (cfg0.status === 'unrunnable' || hst === 'invalid' || (bl && bl.status !== 'green') || (!bl && group !== 'hono-5ca49b0' && process.env.F2P_NO_BASELINE !== '1')) { try { fs.rmSync(path.join(F2P, 'packets', group + '.md')); } catch { /* none */ } continue; }
    cs.sort((a, b) => a.id.localeCompare(b.id)); shuffle(cs, rng(1));
    const repo = cs[0].repo, cfg = R[repo] || {}, tree = path.join(F2P, 'trees', group, 'buggy');
    const L = [`# Packet ${group}`, '', `Repository: ${repo}`, `Source tree (read-only reference, no git history): \`${posix(tree)}\``, '', `Test command for one test file (run through the harness so dependencies are present; it prints only pass, assertion failure or error on this source tree): \`node ${posix(ROOT)}/eval/f2p/f2p.js try <finding-id>\``, `The repo's own command shape: \`${fill(cfg.cmd || '(see repos.json)', { test: '<test file>', out: 'out.json', testdir: '<dir>', evidence: '<evidence>' })}\``, '',
      'Write ONE new test file per finding (a new file next to the existing tests for that code, never an edit of an existing test file). Save it at `' + posix(F2P) + '/tests/<finding-id>/<path of the new test file relative to the repo root>`. You may iterate on the source tree until your test runs without a compile, import or collection error. Read only this packet and the source tree. The goal: a test that expresses what the finding says is missing or weak.', ''];
    cs.forEach((c, i) => {
      const f = fieldsOf(c.id);
      L.push(`## Finding ${i + 1}: \`${c.id}\``, '', `- kind: ${f.kind}`, `- path: ${f.path}`, `- line: ${f.line}`, `- title: ${f.title}`, '', 'Body:', '', f.body || '(none)', '');
      if (f.counterexample) L.push('Counterexample:', '', f.counterexample, '');
      if (f.skeleton) L.push('Test skeleton suggested by the finding:', '', f.skeleton, '');
      if (f.quote) L.push('Cited code:', '', '```', f.quote, '```', '');
    });
    fs.writeFileSync(path.join(F2P, 'packets', `${group}.md`), L.join('\n'));
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
  const out = new Map(); let off = 0, pax = null;
  const str = (a, b) => buf.toString('utf8', a, b).replace(/\0.*$/s, '');
  while (off + 512 <= buf.length) {
    if (buf.subarray(off, off + 512).every((x) => x === 0)) break;
    const type = String.fromCharCode(buf[off + 156] || 48), size = parseInt(str(off + 124, off + 136).trim() || '0', 8), data = buf.subarray(off + 512, off + 512 + size);
    let name = (str(off + 345, off + 500) ? str(off + 345, off + 500) + '/' : '') + str(off, off + 100);
    if (type === 'x') { for (const m of data.toString('utf8').matchAll(/\d+ path=([^\n]*)\n/g)) pax = m[1]; }
    else if (type === 'g') { /* global header: commit id */ }
    else { if (pax) { name = pax; pax = null; } if (type === '0' || type === '\0') out.set(name, Buffer.from(data)); }
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

// One run of a test file in dir -> { outcome, msg?, origin?, frame? }.
function runOnce(repo, dir, testRel, timeout) {
  const cfg = REPOS()[repo], out = path.join(os.tmpdir(), `f2p-${process.pid}.out`);
  fs.rmSync(out, { force: true });
  const env = Object.fromEntries(ENV_KEEP.filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(cfg.env || {})) env[k] = fill(v, { evidence: posix(EV), cwd: posix(dir) });
  if (cfg.path_prepend) { const v = cfg.path_prepend.map((p) => fill(p, { evidence: EV })).join(path.delimiter) + path.delimiter + (env.Path || env.PATH || ''); env.Path = v; env.PATH = v; }
  timeout = timeout || cfg.timeout || 180;
  let run = '.'; try { const fns = [...fs.readFileSync(path.join(dir, testRel), 'utf8').matchAll(/^func (Test\w+)\(/gm)].map((m) => m[1]); if (fns.length) run = `^(${fns.join('|')})$`; } catch { /* not a Go file */ }
  const vars = { run, test: posix(testRel), out: posix(out), testdir: posix(path.posix.dirname(posix(testRel))) || '.', evidence: posix(EV) };
  const res = spawnSync(fill(cfg.cmd, vars), { cwd: dir, shell: true, env, timeout: timeout * 1000, encoding: 'utf8', maxBuffer: 1 << 28 });
  if (res.error && res.error.code === 'ETIMEDOUT') return { outcome: 'error', msg: 'timeout' };
  if (cfg.runner === 'vitest') return parseVitest(res, out, dir);
  if (cfg.runner === 'pytest') return parsePytest(fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : '', dir);
  if (cfg.runner === 'go') return parseGo(res.stdout, dir, res.stderr);
  throw new Error(`unknown runner ${cfg.runner}`);
}

const testFiles = (id) => { const base = path.join(F2P, 'tests', id), out = []; const walk = (d) => { for (const e of fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }) : []) e.isDirectory() ? walk(path.join(d, e.name)) : out.push(posix(path.relative(base, path.join(d, e.name)))); }; walk(base); return out.sort(); };
const hashes = (id) => Object.fromEntries(testFiles(id).map((r) => [r, sha(fs.readFileSync(path.join(F2P, 'tests', id, r), 'utf8'))]));

// Freeze: record the hashes of the submitted test files before any fixed run; refuse when a recorded hash no longer matches.
function freeze(row, h) {
  if (row.test_sha256_frozen && JSON.stringify(row.test_sha256_frozen) !== JSON.stringify(h)) throw new Error(`test file changed since it was frozen: ${row.id}`);
  row.test_sha256_frozen = row.test_sha256_frozen || h;
  return row;
}

// Run `fn(dir)` with the tree at `rev` in place. overlay: dependency work dir moved to rev (restored to its base afterwards); export: a fresh temp export deleted afterwards.
function withTree(repo, group, rev, kind, fn) {
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
const place = (dir, id) => { for (const r of testFiles(id)) { fs.mkdirSync(path.dirname(path.join(dir, r)), { recursive: true }); fs.copyFileSync(path.join(F2P, 'tests', id, r), path.join(dir, r)); } };
const unplace = (dir, id) => { for (const r of testFiles(id)) fs.rmSync(path.join(dir, r), { force: true }); };
const lock = (repo) => { const l = path.join(F2P, 'work', REPOS()[repo].name + '.lock'); for (let i = 0; i < 600; i++) { try { fs.mkdirSync(l); return () => fs.rmSync(l, { recursive: true, force: true }); } catch { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000); } } throw new Error('lock timeout'); };

// try: one run on the buggy tree for a writer; prints the outcome only (no fixed information).
function cmdTry(id) {
  const c = [...scope().reps, ...scope().hono].find((x) => x.id === id); if (!c) throw new Error('unknown finding id');
  const cfg = REPOS()[c.repo]; if (cfg.status === 'unrunnable') return console.log(`unrunnable: ${cfg.reason}`);
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
  const { reps } = scope(), R = REPOS(), file = path.join(__dirname, 'baseline.json'), B = fs.existsSync(file) ? readJson(file) : {}, seen = new Set();
  for (const c of reps) {
    if (seen.has(c.group) || (only && !only.includes(c.group) && !only.includes(c.repo))) continue; seen.add(c.group);
    const cfg = R[c.repo]; if (!cfg || cfg.status === 'unrunnable') { B[c.group] = { status: 'unrunnable', reason: (cfg && cfg.reason) || 'repo not configured' }; fs.writeFileSync(file, JSON.stringify(B, null, 1) + '\n'); continue; }
    const paths = reps.filter((x) => x.group === c.group).map((x) => x.path), tests = [...new Set(paths.map((p) => nearestTest(path.join(F2P, 'trees', c.group, 'buggy'), p)).filter(Boolean))];
    const free = lock(c.repo);
    try { B[c.group] = withTree(c.repo, c.group, c.buggy, 'baseline', (dir) => { const r = tests.slice(0, 3).map((t) => ({ test: t, ...runOnce(c.repo, dir, t) })); return { status: r.length && r.every((x) => x.outcome === 'pass') ? 'green' : 'not_green', reason: r.length ? r.filter((x) => x.outcome !== 'pass').map((x) => `${x.test}: ${x.outcome} ${x.msg || ''}`).join('; ') : 'no existing test file found', tests: r.map((x) => x.test) }; }); } finally { free(); }
    console.error(c.group, B[c.group].status);
    fs.writeFileSync(file, JSON.stringify(B, null, 1) + '\n');
  }
}

// Positive control: every test file the fix added or edited, run through the identical harness (fix version copied into the buggy tree, 3x; then 3x on fixed). Expected: verified or verified_throw.
// Fix tests never appear in packets. A PR is a control success when at least one of its fix test files is verified/verified_throw.
const TESTFILE = /(\.(test|spec)\.[cm]?[jt]sx?|_test\.go|(^|\/)test_[^/]*\.py|_test\.py)$/;
function cmdControls(only) {
  const { reps } = scope(), R = REPOS(), res = loadResults(), PC = (res.positive_control = res.positive_control || {}), seen = new Set();
  for (const c of reps) {
    if (seen.has(c.group) || (only && !only.includes(c.group) && !only.includes(c.repo))) continue; seen.add(c.group);
    const cfg = R[c.repo];
    if (!cfg || cfg.status === 'unrunnable') { PC[c.group] = { repo: c.repo, status: 'unrunnable', reason: (cfg && cfg.reason) || 'repo not configured' }; continue; }
    const tests = nameStatus(c.repo, c.buggy, c.fixed).filter(([st, p]) => st !== 'D' && TESTFILE.test(p)).map(([, p]) => p);
    if (!tests.length) { PC[c.group] = { repo: c.repo, status: 'none', reason: 'the fix adds or edits no test file' }; continue; }
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
    } catch (e) { PC[c.group] = { repo: c.repo, status: 'harness_error', reason: String(e.message).slice(0, 300), files }; saveResults(res); continue; } finally { free(); }
    const ok = files.some((x) => x.verdict === 'verified' || x.verdict === 'verified_throw');
    PC[c.group] = { repo: c.repo, status: ok ? 'verified' : 'not_verified', files };
    saveResults(res); console.error(c.group, PC[c.group].status, files.map((x) => x.verdict).join(','));
  }
  saveResults(res);
}
// Per-repo harness validity from the positive controls: k/n over runnable controls; < 80% invalid; no control at all unvalidated.
function harnessStatus(res, baseline = {}) {
  const out = {};
  for (const [grp, pc] of Object.entries(res.positive_control || {})) {
    if (baseline[grp] && baseline[grp].status !== 'green') { out[pc.repo] = out[pc.repo] || { k: 0, n: 0 }; continue; } // baseline not green: the control is not runnable
    const o = (out[pc.repo] = out[pc.repo] || { k: 0, n: 0 });
    if (pc.status === 'verified') { o.k++; o.n++; } else if (pc.status === 'not_verified' || pc.status === 'harness_error') o.n++;
  }
  for (const o of Object.values(out)) o.status = o.n === 0 ? 'unvalidated' : o.k / o.n < 0.8 ? 'invalid' : 'valid';
  return out;
}
const cmdWritersDone = (repo) => { const d = path.join(F2P, 'writers_done'); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, REPOS()[repo].name), new Date().toISOString()); };
const writersDone = (repo) => fs.existsSync(path.join(F2P, 'writers_done', REPOS()[repo].name));

const diffText = (repo, a, b) => execFileSync('git', ['-C', cloneOf(repo), 'diff', '-U0', '--no-renames', a, b], { encoding: 'utf8', maxBuffer: 1 << 28 });
const callNames = (id) => [...new Set(testFiles(id).flatMap((r) => [...fs.readFileSync(path.join(F2P, 'tests', id, r), 'utf8').matchAll(/\b([A-Za-z_]\w*)\s*\(/g)].map((m) => m[1])))];

// run: for each finding with a written test (replay arm). Freeze -> 3 buggy runs -> 3 fixed runs (fixed tree only exists during these runs) -> verdict.
function cmdRun(only) {
  const { reps } = scope(), R = REPOS(), res = loadResults(), baselineFile = path.join(__dirname, 'baseline.json'), B = fs.existsSync(baselineFile) ? readJson(baselineFile) : {};
  for (const c of reps) {
    if (only && !only.includes(c.id) && !only.includes(c.group)) continue;
    if (!testFiles(c.id).length) continue;
    const row = freeze(res.rows[c.id] || { id: c.id, pr: c.pr, repo: c.repo, kind: c.kind, claim_match: null, claim_reason: null }, hashes(c.id)); res.rows[c.id] = row;
    const cfg = R[c.repo], bl = B[c.group];
    if (cfg && !writersDone(c.repo)) { console.error(`skip ${c.id.slice(0, 8)}: writers for ${c.repo} not marked done (writers-done)`); continue; }
    if (!cfg || cfg.status === 'unrunnable') { Object.assign(row, { verdict: 'unrunnable', reason: (cfg && cfg.reason) || 'repo not configured' }); saveResults(res); continue; }
    if (!bl || bl.status !== 'green') { Object.assign(row, { verdict: 'unrunnable', reason: `baseline: ${bl ? bl.status + ' ' + bl.reason : 'not checked'}` }); saveResults(res); continue; }
    if (scope().pairs.get(c.group).deps_changed) { Object.assign(row, { verdict: 'deps_changed', reason: 'the fix changes a dependency manifest and no reinstall is done; excluded from the measures' }); saveResults(res); continue; }
    saveResults(res); // frozen hashes are on disk before any fixed run
    const free = lock(c.repo);
    try {
      const go = (rev, kind) => withTree(c.repo, c.group, rev, kind, (dir) => { place(dir, c.id); try { return testFiles(c.id).length ? Array.from({ length: REPEATS }, () => testFiles(c.id).map((t) => runOnce(c.repo, dir, t)).reduce((a, b) => (a.outcome === 'pass' ? b : a))) : []; } finally { unplace(dir, c.id); } });
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
  const man = readJson(path.join(ROOT, 'eval/mutation/hono-5ca49b0.json')), res = loadResults();
  for (const c of HONO().candidates) {
    if ((only && !only.includes(c.id)) || !testFiles(c.id).length) continue;
    const row = freeze(res.rows[c.id] || { id: c.id, pr: c.pr, repo: c.repo, kind: c.kind, claim_match: null, claim_reason: null }, hashes(c.id)); res.rows[c.id] = row; saveResults(res);
    const free = lock(c.repo);
    try {
      const dir = sync(c.repo, man.sha); place(dir, c.id);
      try {
        const rep = () => Array.from({ length: REPEATS }, () => testFiles(c.id).map((t) => runOnce(c.repo, dir, t)).reduce((a, b) => (a.outcome === 'pass' ? b : a)));
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

const baselineOf = () => { const f = path.join(__dirname, 'baseline.json'); return fs.existsSync(f) ? readJson(f) : {}; };
function cmdReport() {
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

module.exports = { cmdVerify, runOnce, withTree, cmdControls, cmdWritersDone, harnessStatus, cmdExport, cmdPackets, cmdSetup, cmdBaseline, cmdTry, cmdRun, cmdRunMutation, cmdReport, freeze, hashes, nearestTest, scope };
