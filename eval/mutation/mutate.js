#!/usr/bin/env node
// Mutation-survivor ground truth for SpecGuard's scan (eval/mutation/README.md). Offline, no model, Node built-ins only.
//   node eval/mutation/mutate.js gen --repo DIR --files a.ts,b.ts [--max 40] [--seed 1] [--out m.json] [--cmd 'TEMPLATE with {test}']
//   node eval/mutation/mutate.js run --repo DIR --manifest m.json [--timeout 120] [--out m.json]
// gen: token-level mutants (comparison boundary, + -, && ||, === !==, integer literal +1, return value) of tracked source files, spread over the files.
// run: applies one mutant at a time, runs the unit's own test file, restores the file. killed = a test failed; survived = tests ran and all passed;
//      invalid = nothing ran or the run crashed; timeout. A mutant is (file, line, op, col): the manifest holds no third-party code text.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');

// name -> [regexp over one code line (global), replacement of the match]. Every replacement keeps the syntax valid.
const OPS = {
  bound: [/ (<=|>=|<|>) /g, (m) => ({ '<': ' <= ', '<=': ' < ', '>': ' >= ', '>=': ' > ' })[m.trim()]],
  arith: [/ [+-] /g, (m) => (m.includes('+') ? ' - ' : ' + ')],
  logic: [/ (&&|\|\|) /g, (m) => (m.includes('&') ? ' || ' : ' && ')],
  eq: [/ (===|!==) /g, (m) => (m.includes('!') ? ' === ' : ' !== ')],
  lit: [/(?<![\w.$#'"`-])\d+(?![\w.])/g, (m) => String(Number(m) + 1)],
  ret: [/(?<=\breturn )[^;]+?(?=;?\s*$)/g, (m) => (m === 'true' ? 'false' : m === 'false' ? 'true' : m === 'undefined' ? 'null' : 'undefined')],
};
const SKIP_LINE = /^\s*(\/\/|\/\*|\*|import\b|export\s+(type|interface)\b|type\b|interface\b|(export\s+)?(const|let)\s+[A-Z0-9_]+\s*[:=])/;

// Match positions of re in line that are neither inside a string/template literal nor after a `//` comment.
function sites(line, re) {
  let q = null; const bad = new Array(line.length).fill(false);
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { bad[i] = true; if (c === '\\') { bad[++i] = true; } else if (c === q) q = null; continue; }
    if (c === '"' || c === "'" || c === '`') { q = c; bad[i] = true; } else if (c === '/' && line[i + 1] === '/') { bad.fill(true, i); break; } else if (c === '/' && line[i - 1] !== '<' && /[=(,:]\s*$/.test(line.slice(0, i))) { for (i++; i < line.length && line[i] !== '/'; i++) { bad[i] = true; if (line[i] === '\\') bad[++i] = true; } } // regex literal
  }
  const out = []; re.lastIndex = 0;
  for (let m; (m = re.exec(line));) { if (!bad.slice(m.index, m.index + m[0].length).some(Boolean)) out.push({ col: m.index, text: m[0] }); if (!m[0]) re.lastIndex++; }
  return out;
}

// A one-line return value: brackets balanced and no trailing operator, so replacing it keeps the syntax valid.
const wholeExpr = (e) => !/[([{,&|?:+\-*/=<>]$/.test(e) && [...e].reduce((n, c) => n + ('([{'.includes(c) ? 1 : ')]}'.includes(c) ? -1 : 0), 0) === 0;

// All mutants of one file's text: [{ line (1-based), op, col }].
function candidates(text) {
  const out = [];
  text.split('\n').forEach((l, i) => {
    if (SKIP_LINE.test(l)) return;
    for (const [op, [re]] of Object.entries(OPS)) for (const s of sites(l, re)) if (op !== 'ret' || wholeExpr(s.text)) out.push({ line: i + 1, op, col: s.col });
  });
  return out;
}

// Text with mutant m applied, or null when the site is gone (stale manifest).
function apply(text, m) {
  const ls = text.split('\n'), l = ls[m.line - 1];
  if (l === undefined) return null;
  const [re, rep] = OPS[m.op], s = sites(l, re).find((x) => x.col === m.col);
  if (!s) return null;
  ls[m.line - 1] = l.slice(0, s.col) + rep(s.text) + l.slice(s.col + s.text.length);
  return ls.join('\n');
}

// mulberry32: small seeded PRNG so a manifest regenerates identically.
const rng = (a) => () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const shuffle = (a, r) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

// Up to max mutants, round-robin over files; inside a file round-robin over operators, random sites. Never two mutants on one line.
function pick(byFile, max, seed) {
  const r = rng(seed), q = {};
  for (const [f, cs] of Object.entries(byFile)) { const g = {}; for (const c of shuffle([...cs], r)) (g[c.op] = g[c.op] || []).push(c); q[f] = Object.values(g); }
  const out = [], used = new Set(), turn = {};
  for (let more = true; more && out.length < max;) { // one mutant per file per pass, operators in turn
    more = false;
    for (const [f, groups] of Object.entries(q)) {
      for (let k = 0; k < groups.length && out.length < max; k++) {
        const g = groups[turn[f] = ((turn[f] ?? -1) + 1) % groups.length]; let c;
        while ((c = g.shift()) && used.has(`${f}:${c.line}`));
        if (c) { used.add(`${f}:${c.line}`); out.push({ file: f, ...c }); more = true; break; }
      }
    }
  }
  return out.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line).map((m, i) => ({ id: `m${String(i + 1).padStart(2, '0')}`, ...m }));
}

// Test file of a source file: x.ts -> x.test.ts / x.spec.ts (also .js, .tsx) beside it; null when there is none.
function testOf(repo, file) {
  const p = path.parse(file);
  for (const t of ['test', 'spec']) for (const e of [p.ext, '.ts', '.js']) { const c = path.posix.join(p.dir, `${p.name}.${t}${e}`); if (fs.existsSync(path.join(repo, c))) return c; }
  return null;
}

const ENV_KEEP = ['PATH', 'Path', 'SYSTEMROOT', 'SystemRoot', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'COMSPEC', 'PATHEXT', 'NODE_OPTIONS'];
// vitest json reporter -> { status, reason }. killed only when a test ASSERTION failed in the target test file (reason 'assertion').
// A failed test that threw some other error (TypeError, test-level timeout), a failed suite (import/compile/setup) or no report is invalid: the mutant was not caught by an assertion.
const isAssertion = (msg) => /AssertionError|^Error: expect\(|expected .* to |toMatchSnapshot|Snapshot .* mismatched/m.test(String(msg));
function verdict(res, jsonFile) {
  if (res.error && res.error.code === 'ETIMEDOUT') return { status: 'timeout', reason: 'process timeout' };
  let j; try { j = JSON.parse(fs.readFileSync(jsonFile, 'utf8')); } catch { return { status: 'invalid', reason: 'no report' }; }
  if (j.numFailedTests > 0) {
    const failed = (j.testResults || []).flatMap((s) => s.assertionResults || []).filter((a) => a.status === 'failed');
    if (failed.some((a) => (a.failureMessages || []).some(isAssertion))) return { status: 'killed', reason: 'assertion' };
    return { status: 'invalid', reason: failed.length ? 'non-assertion test failure (thrown error or test timeout)' : 'failed tests without detail' };
  }
  if (j.numFailedTestSuites > 0) return { status: 'invalid', reason: 'suite error (import, compile or setup)' };
  return j.numTotalTests > 0 && res.status === 0 ? { status: 'survived', reason: 'all tests passed' } : { status: 'invalid', reason: 'no tests ran or non-zero exit' };
}

function runOne(repo, cmd, test, timeout) {
  const out = path.join(require('node:os').tmpdir(), `mut-${process.pid}.json`);
  fs.rmSync(out, { force: true });
  const env = Object.fromEntries(ENV_KEEP.filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]]));
  const res = spawnSync(cmd.replace('{test}', test).replace('{out}', out), { cwd: repo, shell: true, env, timeout: timeout * 1000, encoding: 'utf8' });
  return verdict(res, out);
}

function runAll(repo, manifest, { timeout = 120, log = console.error } = {}) {
  const orig = {}, cmd = manifest.cmd;
  const restore = () => { for (const [f, t] of Object.entries(orig)) fs.writeFileSync(path.join(repo, f), t); };
  process.on('SIGINT', () => { restore(); process.exit(130); });
  try {
    const base = {};
    for (const m of manifest.mutants) {
      const abs = path.join(repo, m.file), test = testOf(repo, m.file);
      if (!(m.file in orig)) orig[m.file] = fs.readFileSync(abs, 'utf8');
      if (!(test in base)) { base[test] = runOne(repo, cmd, test, timeout); log(`baseline ${test}: ${base[test].status}`); }
      if (base[test].status !== 'survived') { m.status = 'invalid'; m.kill_reason = 'baseline does not pass'; continue; }
      const t = apply(orig[m.file], m);
      if (t === null) { m.status = 'invalid'; m.kill_reason = 'site gone'; continue; }
      fs.writeFileSync(abs, t);
      try { const v = runOne(repo, cmd, test, timeout); m.status = v.status; m.kill_reason = v.reason; } finally { fs.writeFileSync(abs, orig[m.file]); }
      log(`${m.id} ${m.file}:${m.line} ${m.op} -> ${m.status} (${m.kill_reason})`);
    }
  } finally { restore(); }
  return manifest;
}

// Manifest with per-unit summary: survived / killed counts (invalid and timeout mutants are ignored by the scorer).
function summarize(manifest) {
  const units = {};
  for (const m of manifest.mutants) { const u = (units[m.file] = units[m.file] || { survived: 0, killed: 0, other: 0 }); u[m.status === 'survived' || m.status === 'killed' ? m.status : 'other']++; }
  manifest.units = units;
  return manifest;
}

function main(argv) {
  const [cmd, ...rest] = argv, a = {};
  for (let i = 0; i < rest.length; i += 2) a[rest[i].replace(/^--/, '')] = rest[i + 1];
  if (!['gen', 'run'].includes(cmd) || !a.repo) { console.error(fs.readFileSync(__filename, 'utf8').split('\n').slice(1, 7).join('\n').replace(/^\/\/ ?/gm, '')); return 2; }
  const repo = path.resolve(a.repo), git = (...x) => execFileSync('git', ['-C', repo, ...x], { encoding: 'utf8' }).trim();
  if (cmd === 'gen') {
    const files = String(a.files || '').split(',').filter(Boolean), byFile = {};
    for (const f of files) { if (!testOf(repo, f)) { console.error(`no test file beside ${f}: skipped`); continue; } byFile[f] = candidates(fs.readFileSync(path.join(repo, f), 'utf8')); }
    const m = { repo: a.slug || path.basename(repo), sha: git('rev-parse', 'HEAD'), cmd: a.cmd || 'npx vitest run --reporter=json --outputFile={out} {test}', seed: Number(a.seed || 1), mutants: pick(byFile, Number(a.max || 40), Number(a.seed || 1)) };
    fs.writeFileSync(a.out || 'mutants.json', JSON.stringify(m, null, 1) + '\n');
    console.error(`${m.mutants.length} mutants over ${Object.keys(byFile).length} files`);
    return 0;
  }
  const m = JSON.parse(fs.readFileSync(a.manifest, 'utf8')); if (a.cmd) m.cmd = a.cmd;
  if (git('rev-parse', 'HEAD') !== m.sha) { console.error(`repo is at ${git('rev-parse', 'HEAD')}, manifest was frozen at ${m.sha}`); return 2; }
  if (git('status', '--porcelain', '--untracked-files=no')) { console.error('repo has local changes; refusing to mutate'); return 2; }
  fs.writeFileSync(a.out || a.manifest, JSON.stringify(summarize(runAll(repo, m, { timeout: Number(a.timeout || 120) })), null, 1) + '\n');
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));
module.exports = { OPS, sites, candidates, apply, pick, testOf, verdict, summarize };
