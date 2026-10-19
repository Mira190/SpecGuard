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

const { F2P, EV, ROOT, sha, readJson, cloneOf } = f2p;
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
  const tar = path.join(os.tmpdir(), `f2p-${process.pid}-${rev.slice(0, 8)}.tar`);
  execFileSync('git', ['-C', clone, 'archive', '--format=tar', '-o', tar, rev]);
  spawnSync('tar', ['-xf', tar, '-C', dest], { stdio: 'ignore' }); // symlink warnings on Windows are not fatal
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
  const summary = {};
  for (const [group, cs] of Object.entries(by)) {
    cs.sort((a, b) => a.id.localeCompare(b.id)); shuffle(cs, rng(1));
    const repo = cs[0].repo, cfg = R[repo] || {}, tree = path.join(F2P, 'trees', group, 'buggy');
    const L = [`# Packet ${group}`, '', `Repository: ${repo}`, `Source tree (read-only reference, no git history): \`${posix(tree)}\``, '', `Test command for one test file (run through the harness so dependencies are present; it prints only pass, assertion failure or error on this source tree): \`node eval/f2p/f2p.js try <finding-id>\``, `The repo's own command shape: \`${fill(cfg.cmd || '(see repos.json)', { test: '<test file>', out: 'out.json', testdir: '<dir>', evidence: '<evidence>' })}\``, '',
      'Write ONE new test file per finding (a new file next to the existing tests for that code, never an edit of an existing test file). Save it at `' + posix(F2P) + '/tests/<finding-id>/<path of the new test file relative to the repo root>`. You may iterate on the source tree until your test runs without a compile, import or collection error. Read only this packet and the source tree. The goal: a test that expresses what the finding says is missing or weak.', ''];
    cs.forEach((c, i) => {
      const f = fieldsOf(c.id);
      L.push(`## Finding ${i + 1}: \`${c.id}\``, '', `- kind: ${f.kind}`, `- path: ${f.path}`, `- line: ${f.line}`, `- title: ${f.title}`, '', 'Body:', '', f.body || '(none)', '');
      if (f.counterexample) L.push('Counterexample:', '', f.counterexample, '');
      if (f.skeleton) L.push('Test skeleton suggested by the finding:', '', f.skeleton, '');
      if (f.quote) L.push('Cited code:', '', '```', f.quote, '```', '');
    });
    fs.writeFileSync(path.join(F2P, 'packets', `${group}.md`), L.join('\n'));
    summary[repo] = summary[repo] || { packets: 0, findings: 0 }; summary[repo].packets++; summary[repo].findings += cs.length;
  }
  console.log(JSON.stringify(summary, null, 1));
}

// Work dir = tree at some base sha plus installed dependencies (<evidence>/f2p/work/<name>, .sha marker). Sources move between shas by overlaying the git diff (tracked files only).
function workDir(repo) { return path.join(F2P, 'work', REPOS()[repo].name); }
function sync(repo, to) {
  const dir = workDir(repo), clone = cloneOf(repo), mark = path.join(dir, '.sha');
  const from = fs.readFileSync(mark, 'utf8').trim();
  if (from !== to) {
    const rows = execFileSync('git', ['-C', clone, 'diff', '--name-status', '--no-renames', from, to], { encoding: 'utf8', maxBuffer: 1 << 28 }).split('\n').filter(Boolean).map((l) => l.split('\t'));
    for (const [st, p] of rows) {
      const abs = path.join(dir, p);
      if (st === 'D') fs.rmSync(abs, { force: true });
      else { fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, execFileSync('git', ['-C', clone, 'show', `${to}:${p}`], { maxBuffer: 1 << 28 })); }
    }
    fs.writeFileSync(mark, to);
  }
  return dir;
}
function cmdSetup(repo, rev) {
  const dir = workDir(repo);
  if (fs.existsSync(path.join(dir, '.sha'))) return console.log(`${dir} exists`);
  archive(cloneOf(repo), rev, dir); fs.writeFileSync(path.join(dir, '.sha'), rev); fs.writeFileSync(path.join(dir, '.base'), rev);
  console.log(`work dir ${dir} at ${rev}; install dependencies there, then record the decision in repos.json`);
}

// One run of a test file in dir -> { outcome, msg?, origin?, frame? }.
function runOnce(repo, dir, testRel, timeout = 180) {
  const cfg = REPOS()[repo], out = path.join(os.tmpdir(), `f2p-${process.pid}.out`);
  fs.rmSync(out, { force: true });
  const env = Object.fromEntries(ENV_KEEP.filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(cfg.env || {})) env[k] = fill(v, { evidence: posix(EV) });
  const vars = { test: posix(testRel), out: posix(out), testdir: posix(path.posix.dirname(posix(testRel))) || '.', evidence: posix(EV) };
  const res = spawnSync(fill(cfg.cmd, vars), { cwd: dir, shell: true, env, timeout: timeout * 1000, encoding: 'utf8', maxBuffer: 1 << 28 });
  if (res.error && res.error.code === 'ETIMEDOUT') return { outcome: 'error', msg: 'timeout' };
  if (cfg.runner === 'vitest') return parseVitest(res, out, dir);
  if (cfg.runner === 'pytest') return parsePytest(fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : '', dir);
  if (cfg.runner === 'go') return parseGo(res.stdout, dir);
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
    const dir = sync(repo, rev), base = fs.readFileSync(path.join(dir, '.base'), 'utf8').trim();
    try { return fn(dir); } finally { sync(repo, base); }
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
    if (d === '.' || d === '/') return null;
  }
}
function cmdBaseline() {
  const { reps } = scope(), R = REPOS(), file = path.join(__dirname, 'baseline.json'), B = fs.existsSync(file) ? readJson(file) : {}, seen = new Set();
  for (const c of reps) {
    if (seen.has(c.group)) continue; seen.add(c.group);
    const cfg = R[c.repo]; if (!cfg || cfg.status === 'unrunnable') { B[c.group] = { status: 'unrunnable', reason: (cfg && cfg.reason) || 'repo not configured' }; continue; }
    const paths = reps.filter((x) => x.group === c.group).map((x) => x.path), tests = [...new Set(paths.map((p) => nearestTest(path.join(F2P, 'trees', c.group, 'buggy'), p)).filter(Boolean))];
    const free = lock(c.repo);
    try { B[c.group] = withTree(c.repo, c.group, c.buggy, 'baseline', (dir) => { const r = tests.slice(0, 3).map((t) => ({ test: t, ...runOnce(c.repo, dir, t) })); return { status: r.length && r.every((x) => x.outcome === 'pass') ? 'green' : 'not_green', reason: r.length ? r.filter((x) => x.outcome !== 'pass').map((x) => `${x.test}: ${x.outcome} ${x.msg || ''}`).join('; ') : 'no existing test file found', tests: r.map((x) => x.test) }; }); } finally { free(); }
    console.error(c.group, B[c.group].status);
    fs.writeFileSync(file, JSON.stringify(B, null, 1) + '\n');
  }
}

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
    if (!cfg || cfg.status === 'unrunnable') { Object.assign(row, { verdict: 'unrunnable', reason: (cfg && cfg.reason) || 'repo not configured' }); saveResults(res); continue; }
    if (!bl || bl.status !== 'green') { Object.assign(row, { verdict: 'unrunnable', reason: `baseline: ${bl ? bl.status + ' ' + bl.reason : 'not checked'}` }); saveResults(res); continue; }
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

function cmdReport() {
  const res = loadResults(), cands = CAND().candidates, armOf = Object.fromEntries(cands.map((c) => [c.id, c.arm])), rows = Object.values(res.rows).filter((r) => armOf[r.id]);
  const t = report.tables(rows, armOf), cmp = { primary: report.compare(t, rows, armOf, 'primary'), secondary: report.compare(t, rows, armOf, 'secondary'), sensitivity: report.compare(t, rows, armOf, 'sensitivity') };
  console.log(report.format(t, cmp));
  const near = f2p.perPr(rows.filter((r) => armOf[r.id] === 'NEAR' && r.verdict !== 'unrunnable').map((r) => ({ pr: r.pr, arm: 'NEAR' })), 'NEAR'), far = f2p.perPr(rows.filter((r) => armOf[r.id] === 'FAR' && r.verdict !== 'unrunnable').map((r) => ({ pr: r.pr, arm: 'FAR' })), 'FAR');
  if (Object.keys(near).length && Object.keys(far).length) console.log('\npower on runnable counts (decision cell icc0.3, p0 0.05):', JSON.stringify(f2p.powerTable(near, far, { sims: 300, reps: 300 })));
  const mut = Object.values(res.rows).filter((r) => r.pr === 'hono-5ca49b0');
  if (mut.length) console.log('\nMutation arm (descriptive, no rate):', JSON.stringify(mut.map((r) => ({ id: r.id.slice(0, 8), verdict: r.verdict, kills: r.kills, kills_uncertain: r.kills_uncertain, claim_match: r.claim_match }))));
}

module.exports = { cmdExport, cmdPackets, cmdSetup, cmdBaseline, cmdTry, cmdRun, cmdRunMutation, cmdReport, freeze, hashes, nearestTest, scope };
