// `cover` subcommand: run the UNIT test suite of a (buggy) tree under coverage and write the report plus suite health (README "Coverage (cover) for E1"). Node built-ins only.
// Parsers are pure functions over report text; the repo gets only hashes and counts (no source text, no local paths).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync, execFileSync } = require('node:child_process');
const f2p = require('./f2p');

const { F2P, EV, sha } = f2p;
const MIN_FREE_COVER = 5e9, MIN_FREE_RAM = 1.2e9;
const toPosix = (p) => String(p).replace(/\\/g, '/');
// Repo-relative posix path: backslashes to slashes, the tree root and a leading ./ removed.
const relPath = (p, cwd) => { let q = toPosix(p).replace(/^file:\/\/\//, ''); const c = toPosix(cwd || '').replace(/\/$/, ''); if (c && q.toLowerCase().startsWith(c.toLowerCase() + '/')) q = q.slice(c.length + 1); return q.replace(/^\.\//, ''); };
// A message for the committed report: local absolute paths and the evidence root are removed, one line, 120 characters.
const scrub = (m, cwd) => { let s = String(m || '').split('\n')[0]; for (const r of [cwd, EV].filter(Boolean)) s = s.split(toPosix(r)).join('<root>').split(String(r)).join('<root>'); return s.replace(/[A-Za-z]:[\\/][^\s'"]*/g, '<path>').slice(0, 120); };

// lcov: SF:<file> ... DA:<line>,<hits> ... end_of_record -> { file: [covered lines, total lines] }.
function parseLcov(text, cwd) {
  const files = {}; let cur = null;
  for (const l of String(text).split(/\r?\n/)) {
    if (l.startsWith('SF:')) cur = files[relPath(l.slice(3), cwd)] = [0, 0];
    else if (cur && l.startsWith('DA:')) { const [, h] = l.slice(3).split(','); cur[1]++; if (Number(h) > 0) cur[0]++; }
    else if (l === 'end_of_record') cur = null;
  }
  return files;
}
// coverage.py cobertura xml: <source> roots plus <class filename> <line number hits> -> { file: [covered, total] }. A filename is relative to a <source> root; the root that holds the file wins.
function parseCoverageXml(xml, cwd, exists = fs.existsSync) {
  const sources = [...String(xml).matchAll(/<source>([^<]*)<\/source>/g)].map((m) => m[1].trim());
  const files = {};
  for (const m of String(xml).matchAll(/<class\b[^>]*?\bfilename="([^"]*)"[^>]*>([\s\S]*?)<\/class>/g)) {
    const roots = sources.length ? sources : [''], hit = roots.find((s) => exists(path.join(s, m[1]))) ?? roots[0];
    const lines = [...m[2].matchAll(/<line\b[^>]*?\bnumber="\d+"[^>]*?\bhits="(\d+)"/g)];
    files[relPath(hit ? hit.replace(/[\\/]$/, '') + '/' + m[1] : m[1], cwd)] = [lines.filter((x) => Number(x[1]) > 0).length, lines.length];
  }
  return files;
}

// Kind of a per-file error. collection: the file's tests did not run because it failed to load (would fake "never executed" gaps); empty: the file has no tests (nothing would have run anyway); other: anything else (e.g. no result).
const EMPTY_RE = /No test suite found|no tests ran|collected 0 items/i;
const COLLECTION_RE = /Failed to (?:load|resolve)|Cannot find module|SyntaxError|Transform failed|ImportError|ModuleNotFoundError|collection error|error during collection|ERR_MODULE_NOT_FOUND|is not defined/i;
const errKind = (msg) => (EMPTY_RE.test(msg) ? 'empty' : COLLECTION_RE.test(msg) ? 'collection' : 'other');
const fileErr = (msg) => ({ kind: errKind(msg), msg });
const kindCounts = (fe) => { const c = { collection: 0, empty: 0, other: 0 }; for (const e of Object.values(fe)) c[e.kind]++; return c; };
// vitest --reporter=json: counts plus a per-file error for every test file that failed to load (status failed with no test results) or that has no result at all.
function vitestHealth(j, selected, cwd) {
  const res = (j && j.testResults) || [], file_errors = {}, file_failures = {}, seen = new Set();
  for (const r of res) {
    const f = relPath(r.name, cwd); seen.add(f);
    if (!selected.includes(f)) continue; // only the selected set is reported (the run uses exactly that set as its include)
    const nf = (r.assertionResults || []).filter((a) => a.status === 'failed').length; if (nf) file_failures[f] = nf; // a test that ran and failed (V2 B3: a counterpart with failures is not clean)
    if (r.status === 'failed' && !(r.assertionResults || []).length) file_errors[f] = fileErr(scrub(r.message || 'suite failed to run', cwd));
  }
  for (const f of selected) if (!seen.has(f)) file_errors[f] = fileErr('no result');
  const n = (k) => (j && Number(j[k])) || 0;
  return { health: { passed: n('numPassedTests'), failed: n('numFailedTests'), errored: Object.keys(file_errors).length, skipped: n('numPendingTests') + n('numTodoTests') }, file_errors, file_failures };
}
// pytest: counts from the junit <testsuite> attributes (collection errors are <error> testcases); per-file collection and import errors from the `ERROR <file> - <msg>` summary lines of stdout (a line with :: is a test-level error, counted but not a file error).
function pytestHealth(xml, stdout, cwd) {
  const at = (k) => Number((new RegExp(`<testsuite\\b[^>]*?\\b${k}="(\\d+)"`).exec(xml) || [])[1]) || 0;
  const tests = at('tests'), failed = at('failures'), errored = at('errors'), skipped = at('skipped'), file_errors = {}, file_failures = {};
  for (const m of String(xml).matchAll(/<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g)) { // a <failure> child = a failed test; its file: the file attribute, else the test module of classname (tests.test_x.TestC -> tests/test_x.py)
    if (!/<(?:failure|error)\b/.test(m[2] || '')) continue; // a test-level <error> (fixture/setup) means the test never ran: counted like a failure
    // classname fallback: cut at the LAST test module segment, ignoring the final segment first (it may be a test function: tests.test_utils.test_x -> tests/test_utils.py); a bare module classname (tests.test_x) falls back to the whole list
    const file = /\bfile="([^"]+)"/.exec(m[1]), cls = (/\bclassname="([^"]*)"/.exec(m[1]) || [])[1] || '', seg = cls.split('.'), isMod = (x) => /^test_|_test$/.test(x), i = seg.slice(0, -1).findLastIndex(isMod) >= 0 ? seg.slice(0, -1).findLastIndex(isMod) : seg.findLastIndex(isMod);
    const f = file ? relPath(file[1], cwd) : i >= 0 ? `${seg.slice(0, i + 1).join('/')}.py` : null; if (f) file_failures[f] = (file_failures[f] || 0) + 1;
  }
  for (const m of String(stdout).matchAll(/^ERROR (\S+?\.py)(?: - (.*))?$/gm)) file_errors[relPath(m[1], cwd)] = fileErr(scrub(m[2] || 'collection error', cwd));
  return { health: { passed: Math.max(0, tests - failed - errored - skipped), failed, errored, skipped }, file_errors, file_failures };
}

// Dependency manifests of the repo's cover block that differ between the env's base sha and the tree.
const depsChanged = (changedPaths, depsFiles) => changedPaths.some((p) => depsFiles.includes(p));

// Unit scope: test files under cover.dirs matching cover.file_re, minus cover.exclude directories. A missing dir or zero files is an error, never 0% coverage.
function selectTests(root, cover) {
  const re = new RegExp(cover.file_re), out = [];
  const walk = (rel) => { for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) { if (['node_modules', '.git', '__pycache__'].includes(e.name)) continue; const q = rel + '/' + e.name; if (e.isDirectory()) { if (!(cover.exclude || []).some((x) => q.split('/').includes(x.replace(/\/$/, '')))) walk(q); } else if (re.test(q)) out.push(q); } };
  for (const d of cover.dirs) {
    const dd = d.replace(/\/$/, '');
    if (!fs.existsSync(path.join(root, dd)) || !fs.statSync(path.join(root, dd)).isDirectory()) throw new Error(`cover scope: directory ${dd} does not exist in the tree`);
    walk(dd);
  }
  if (!out.length) throw new Error(`cover scope: 0 test files selected under ${cover.dirs.join(', ')}; refusing (not "0% covered")`);
  return out.sort();
}

const first = (s) => String(s || '').split(/\r?\n/)[0].trim();
const run = (exe, args, o) => spawnSync(exe, args, { encoding: 'utf8', maxBuffer: 1 << 28, windowsHide: true, ...o }); // no shell: a timeout kills exactly the child PID
function guards() {
  const s = fs.statfsSync(os.tmpdir());
  if (s.bavail * s.bsize < MIN_FREE_COVER) throw new Error('disk guard: under 5 GB free, refusing to run coverage');
  if (os.freemem() < MIN_FREE_RAM) throw new Error('memory guard: under 1.2 GB free RAM, refusing to run coverage');
}

// vitest config that runs exactly the selected files: the base config plus test.include = the selected paths (glob characters escaped), so "selected" equals "run".
const globEscape = (p) => p.replace(/[[\]{}()*?!+@]/g, (c) => '\\' + c);
function includeConfigText(baseConfig, selected) {
  return `import base from ${JSON.stringify(require('node:url').pathToFileURL(baseConfig).href)};
export default { ...base, test: { ...(base.test || {}), include: ${JSON.stringify(selected.map(globEscape))} } };
`;
}
function writeIncludeConfig(outDir, baseConfig, selected) { const p = path.join(outDir, 'vitest.cover.config.mjs'); fs.writeFileSync(p, includeConfigText(baseConfig, selected)); return p; }

// One coverage run in `dir` (the tree at rev). Returns the committed row; reports are written under outDir.
function coverTree(h, repo, cfg, dir, outDir, rev) {
  const cover = cfg.cover, selected = selectTests(dir, cover), env = h.buildEnv(cfg, dir), t0 = Date.now(), timeout = (cover.timeout || 1800) * 1000;
  fs.mkdirSync(outDir, { recursive: true });
  let report, files, hc, tools, exit_code, timed_out;
  if (cfg.runner === 'vitest') {
    if (cover.dirs.length !== 1) throw new Error('vitest cover scope needs exactly one dir');
    const wd = h.workDir(repo), json = path.join(outDir, 'vitest.json'), cj = (f) => JSON.parse(fs.readFileSync(path.join(wd, 'node_modules', f, 'package.json'), 'utf8')).version;
    fs.rmSync(json, { force: true }); fs.rmSync(path.join(outDir, 'lcov.info'), { force: true });
    const args = [path.join(wd, 'node_modules/vitest/vitest.mjs'), 'run', '--config', writeIncludeConfig(outDir, h.fill(cover.config, { evidence: h.posix(EV) }), selected), '--root', '.', ...(cover.exclude || []).flatMap((x) => ['--exclude', `**/${x.replace(/\/$/, '')}/**`]),
      '--reporter=json', `--outputFile=${json}`, '--coverage.enabled', '--coverage.provider=v8', '--coverage.reporter=lcov', '--coverage.reportOnFailure', `--coverage.reportsDirectory=${outDir}`, `--coverage.include=${cover.source}`, '--coverage.exclude=**/*.test.*', '--coverage.exclude=**/node_modules/**'];
    const r = run(process.execPath, args, { cwd: dir, env, timeout });
    exit_code = r.status; timed_out = Boolean(r.error && r.error.code === 'ETIMEDOUT');
    hc = vitestHealth(fs.existsSync(json) ? JSON.parse(fs.readFileSync(json, 'utf8')) : null, selected, dir);
    const rp = path.join(outDir, 'lcov.info'); if (!fs.existsSync(rp)) throw new Error(`no lcov report produced (exit ${exit_code}${timed_out ? ', timeout' : ''})`);
    report = { format: 'lcov', file: rp }; files = parseLcov(fs.readFileSync(rp, 'utf8'), dir);
    tools = { node: process.version, vitest: cj('vitest'), '@vitest/coverage-v8': cj('@vitest/coverage-v8') };
  } else if (cfg.runner === 'pytest') {
    const py = h.fill(cover.python, { evidence: h.posix(EV) }), rc = path.join(outDir, '.coveragerc'), data = path.join(outDir, '.coverage'), junit = path.join(outDir, 'junit.xml'), xmlp = path.join(outDir, 'coverage.xml');
    for (const f of [data, junit, xmlp]) fs.rmSync(f, { force: true });
    fs.writeFileSync(rc, `[run]\nsource = ${cover.source}\n`);
    const r = run(py, ['-m', 'coverage', 'run', '--rcfile', rc, '--data-file', data, '-m', 'pytest', ...cover.dirs, '-p', 'no:cacheprovider', '-q', '--tb=short', '--continue-on-collection-errors', `--junitxml=${junit}`], { cwd: dir, env, timeout });
    exit_code = r.status; timed_out = Boolean(r.error && r.error.code === 'ETIMEDOUT');
    hc = pytestHealth(fs.existsSync(junit) ? fs.readFileSync(junit, 'utf8') : '', r.stdout, dir);
    if (!fs.existsSync(data)) throw new Error(`no coverage data produced (exit ${exit_code}${timed_out ? ', timeout' : ''})`);
    const x = run(py, ['-m', 'coverage', 'xml', '--rcfile', rc, '--data-file', data, '-o', xmlp, '--ignore-errors'], { cwd: dir, env, timeout: 600000 });
    if (!fs.existsSync(xmlp)) throw new Error(`coverage xml failed: ${scrub(first(x.stderr || x.stdout), dir)}`);
    report = { format: 'coverage.xml', file: xmlp }; files = parseCoverageXml(fs.readFileSync(xmlp, 'utf8'), dir);
    const ver = (a, re) => { const v = run(py, a, { env }); return (re.exec(`${v.stdout || ''} ${v.stderr || ''}`) || [])[1] || null; };
    tools = { python: ver(['--version'], /Python (\S+)/), pytest: ver(['-m', 'pytest', '--version'], /pytest (\S+)/), coverage: ver(['-m', 'coverage', '--version'], /version (\S+)/) };
  } else throw new Error(`cover is not implemented for runner ${cfg.runner}`);
  const buf = fs.readFileSync(report.file);
  return { selected_tests: selected.length, health: { ...hc.health, exit_code, timed_out, file_errors_by_kind: kindCounts(hc.file_errors) }, file_errors: hc.file_errors, file_failures: hc.file_failures, tools, report: { format: report.format, sha256: sha(buf), bytes: buf.length }, files, wall_s: Math.round((Date.now() - t0) / 1000) };
}

function cmdCover(args, SET) {
  const h = require('./harness'), R = h.REPOS(), set = SET || 'holdout2', jobs = [], seen = new Set();
  if (SET) h.useSet(SET); // scope() reads the harness's own set; without this --set covered holdout2 groups
  const want = (args || []).filter((a) => !a.startsWith('head:'));
  const bySlug = (n) => Object.keys(R).find((k) => R[k].name === n && R[k].cover);
  for (const a of (args || []).filter((a) => a.startsWith('head:'))) { // smoke: the shared clone's current HEAD, no tree dir, nothing written to the repo
    const slug = bySlug(a.slice(5)); if (!slug) throw new Error(`no cover block for ${a}`);
    const rev = execFileSync('git', ['-C', h.cloneOf(slug), 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    jobs.push({ repo: slug, group: `head-${R[slug].name}-${rev.slice(0, 8)}`, rev, set: 'smoke', head: true });
  }
  if (!(args || []).some((a) => a.startsWith('head:')) || want.length) {
    const { reps, hono } = h.scope();
    for (const c of [...reps, ...(SET ? [] : hono)]) {
      if (seen.has(c.group) || !R[c.repo] || !R[c.repo].cover) continue;
      if (want.length && !want.includes(c.group) && !want.includes(c.repo) && !want.includes(R[c.repo].name)) continue;
      seen.add(c.group); jobs.push({ repo: c.repo, group: c.group, rev: c.buggy, set });
    }
  }
  const file = path.join(__dirname, SET ? `results-cover-${SET}.json` : 'results-cover.json'), out = !jobs.some((j) => j.head) && fs.existsSync(file) ? f2p.readJson(file) : { groups: {} };
  for (const j of jobs) {
    const cfg = R[j.repo], base = { repo: cfg.name, group: j.group, tree_sha: j.rev, scope: { dirs: cfg.cover.dirs, exclude: cfg.cover.exclude || [], file_re: cfg.cover.file_re, source: cfg.cover.source } };
    let row;
    try {
      guards();
      if (!j.head) h.checkTree(j.group, j.rev);
      const outDir = path.join(F2P, 'cover', j.set, j.group), free = h.lock(j.repo);
      try {
        const envBase = cfg.tree === 'overlay' ? fs.readFileSync(path.join(h.workDir(j.repo), '.base'), 'utf8').trim() : cfg.cover.env_base;
        const changed = h.nameStatus(j.repo, envBase, j.rev).map(([, p]) => p);
        const r = h.withTree(j.repo, j.group, j.rev, 'cover', (dir) => coverTree(h, j.repo, cfg, dir, outDir, j.rev));
        row = { ...base, env_base: envBase, deps_changed: depsChanged(changed, cfg.cover.deps_files), ...r };
      } finally { free(); }
      fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(row, null, 1) + '\n');
    } catch (e) { row = { ...base, error: scrub(e.message, null) }; }
    const { files, ...brief } = row; console.log(JSON.stringify({ ...brief, files: files ? Object.keys(files).length : 0 }));
    if (!j.head) { out.groups[j.group] = { ...row, wall_s: undefined }; fs.writeFileSync(file, JSON.stringify(out, null, 1) + '\n'); }
  }
}

module.exports = { errKind, includeConfigText, parseLcov, parseCoverageXml, vitestHealth, pytestHealth, depsChanged, selectTests, relPath, cmdCover };
