#!/usr/bin/env node
// Execution evidence from the target repository's own coverage report (optional input coverage_files). No AI, no dependencies.
// SpecGuard never runs tests: the target workflow runs them with coverage BEFORE this step, in the same job.
// Reads LCOV, Cobertura XML, JaCoCo XML, Go cover profiles and Istanbul coverage-final.json; joins them with the added lines of diff.patch.
// Writes $CTX/coverage.txt (for the prompt) and $CTX/coverage.json (for post.js). Never fails the job: a problem becomes a note in coverage.json.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { parseDiff } = require('./post');
const { isTestPath } = require('./trace');
const { matches } = require('./standards-map');

const MAX_REPORT = 40 << 20, MAX_REPORTS = 25, MAX_WALK = 100000;
const MAX_FILES_JSON = 400, MAX_RANGES = 300; // coverage.json caps
const TXT_MAX = 3500, TXT_RANGES = 12; // coverage.txt caps (the prompt block is 4 KiB)
const CODE = /\.(js|jsx|mjs|cjs|ts|tsx|py|rb|go|rs|java|kt|kts|scala|cs|php|swift|c|h|cc|cpp|hpp|m|mm)$/i;

const norm = (p) => String(p).replace(/\\/g, '/').replace(/^file:\/\/\/?(?=[A-Za-z]:|\/)/, '').replace(/^\.\//, '');
const unxml = (s) => s.replace(/&(lt|gt|quot|apos|amp);/g, (_, e) => ({ lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' })[e]);
const attrs = (s) => { const o = {}; for (const m of s.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) o[m[1]] = unxml(m[2] ?? m[3]); return o; };
const entry = (files, p) => files.get(p) || files.set(p, new Map()).get(p);
const hit = (m, line, n) => { if (Number.isInteger(line) && line > 0) m.set(line, (m.get(line) || 0) + (Number.isFinite(n) && n > 0 ? n : 0)); };

// Every parser returns { files: Map(rawPath -> Map(line -> hits)), sources: [dir], ts: ms | undefined }; a line present is instrumented.
function lcov(text) {
  const files = new Map();
  let cur = null;
  for (const raw of text.split(/\r?\n/)) {
    if (raw.startsWith('SF:')) cur = entry(files, raw.slice(3).trim());
    else if (raw === 'end_of_record') cur = null;
    else if (cur && raw.startsWith('DA:')) { const [l, h] = raw.slice(3).split(','); hit(cur, +l, +h); }
  }
  return { files, sources: [] };
}
// Cobertura (<class filename><lines><line number hits>, also the newer <package> layout) and JaCoCo (<package name><sourcefile name><line nr mi ci>) share one tag walk.
function xml(text) {
  const files = new Map(), sources = [];
  let cur = null, pkg = '', ts;
  const stamp = (v) => { const n = Number(v); if (n > 0) ts = Math.max(ts || 0, n < 1e11 ? n * 1000 : n); };
  for (const m of text.matchAll(/<(\/?)(coverage|sessioninfo|source|package|class|sourcefile|line)\b([^>]*)>([^<]*)/g)) {
    const [, close, tag, rest, inner] = m, a = close ? {} : attrs(rest), self = /\/\s*$/.test(rest);
    if (tag === 'coverage' && !close) stamp(a.timestamp);
    else if (tag === 'sessioninfo') stamp(a.dump || a.start);
    else if (tag === 'source' && !close && inner.trim()) sources.push(unxml(inner.trim()));
    else if (tag === 'package') pkg = close ? '' : a.name ? `${a.name.replace(/\./g, '/')}/` : '';
    else if (tag === 'class') cur = close || self || !a.filename ? null : entry(files, a.filename);
    else if (tag === 'sourcefile') cur = close || self || !a.name ? null : entry(files, pkg + a.name);
    else if (tag === 'line' && cur && !close) {
      if (a.nr !== undefined) { if (+a.mi + +a.ci > 0) hit(cur, +a.nr, +a.ci); } // JaCoCo: ci = covered instructions
      else hit(cur, +a.number, +a.hits);
    }
  }
  return { files, sources, ts };
}
function gocover(text) {
  const files = new Map();
  for (const raw of text.split(/\r?\n/)) {
    const m = /^(.+):(\d+)\.\d+,(\d+)\.\d+ \d+ (\d+)$/.exec(raw.trim()); // file:startLine.col,endLine.col numStmts count
    if (!m) continue;
    const f = entry(files, m[1]);
    for (let l = +m[2]; l <= Math.min(+m[3], +m[2] + 5000); l++) hit(f, l, +m[4]); // ponytail: a line shared by an executed and a never-run block counts as executed (errs towards covered)
  }
  return { files, sources: [] };
}
function istanbul(text) {
  const files = new Map();
  for (const [p, f] of Object.entries(JSON.parse(text))) {
    if (!f || typeof f !== 'object' || !f.statementMap || !f.s) continue;
    const m = entry(files, f.path || p);
    for (const [id, s] of Object.entries(f.statementMap)) hit(m, s?.start?.line, f.s[id]);
  }
  return { files, sources: [] };
}
function parse(text) {
  const t = text.replace(/^﻿/, '').trimStart();
  if (t.startsWith('{')) return { format: 'istanbul', ...istanbul(t) };
  if (t.startsWith('<')) return { format: /<report\b/.test(t.slice(0, 2000)) ? 'jacoco' : 'cobertura', ...xml(t) };
  if (/^mode:\s*(set|count|atomic)\b/.test(t)) return { format: 'go', ...gocover(t) };
  if (/^(TN:|SF:)/m.test(t)) return { format: 'lcov', ...lcov(t) };
  throw new Error('unrecognised format');
}

// Report path -> repo-relative path among `known` (the changed files), or null. Handles workspace prefixes, absolute CI paths of another machine,
// Cobertura <source> roots, JaCoCo package paths and Go import paths. ponytail: suffix matching can pair a bare `a.js` with a top-level a.js; the longest match wins.
function resolver(known, ws) {
  const w = ws ? norm(ws).replace(/\/+$/, '') : '', list = [...known];
  return (raw, sources = []) => {
    const cands = [norm(raw), ...sources.map((s) => `${norm(s).replace(/\/+$/, '')}/${norm(raw)}`)].map((c) => (w && c.startsWith(`${w}/`) ? c.slice(w.length + 1) : c));
    for (const c of cands) if (known.has(c)) return c;
    let best = null;
    for (const c of cands) for (const f of list) if (c.endsWith(`/${f}`) && (!best || f.length > best.length)) best = f;
    if (best) return best;
    const short = list.filter((f) => cands.some((c) => f.endsWith(`/${c}`)));
    return short.length === 1 ? short[0] : null;
  };
}

// [5,6,7,9] -> [[5,7],[9,9]]
const ranges = (nums) => { const out = []; for (const n of [...nums].sort((a, b) => a - b)) { const l = out[out.length - 1]; if (l && n === l[1] + 1) l[1] = n; else if (!l || n > l[1]) out.push([n, n]); } return out; };
const show = (rs, max) => rs.slice(0, max).map(([a, b]) => (a === b ? `L${a}` : `L${a}-L${b}`)).join(', ') + (rs.length > max ? `, +${rs.length - max} more` : '');

// files: changed paths (files.txt); reports: [{ name, text }]; headTime: epoch ms of the head commit or undefined.
// mode 'all' (scan): files = every tracked path; every instrumented line of every non-test file is reported (never = lines no test ran, ran = lines that did), not only added lines.
function analyze({ patch = '', files, reports, ws, headTime, mode = 'diff' }) {
  const all = mode === 'all', known = new Set(files.filter((f) => !isTestPath(f))), resolve = resolver(known, ws), added = all ? null : parseDiff(patch);
  const agg = new Map(), notes = [];
  let used = 0;
  for (const r of reports) {
    let p;
    try { p = parse(r.text); } catch (e) { notes.push(`${r.name}: ${e.message}`); continue; }
    if (p.ts && headTime && p.ts < headTime) { notes.push(`${r.name} is older than the head commit; not used`); continue; }
    used++;
    for (const [raw, lines] of p.files) {
      const to = resolve(raw, p.sources);
      if (!to) continue;
      const m = entry(agg, to);
      for (const [l, h] of lines) m.set(l, (m.get(l) || 0) + h);
    }
  }
  const out = { v: 2, ...(all && { mode: 'all' }), reports: used, total: { instrumented: 0, executed: 0 }, files: {}, unreported: [], notes };
  if (!used) return { json: out, txt: '' };
  const entries = [...agg];
  if (all) { // the files with the most never-run lines survive the cap
    const zero = (m) => { let n = 0; for (const h of m.values()) if (!h) n++; return n; };
    entries.sort((a, b) => zero(b[1]) - zero(a[1]));
    if (entries.length > MAX_FILES_JSON) out.truncated = true;
  }
  for (const [p, hits] of entries.slice(0, MAX_FILES_JSON)) {
    const inst = [], exec = [], never = [], miss = [];
    for (const [l, h] of hits) if (!h) miss.push(l);
    for (const l of all ? hits.keys() : added.get(p)?.changed.RIGHT.keys() || []) { const h = hits.get(l); if (h === undefined) continue; inst.push(l); (h ? exec : never).push(l); }
    const rn = ranges(never), rr = ranges(exec), rm = ranges(miss);
    if (Math.max(rn.length, rr.length, rm.length) > MAX_RANGES) out.truncated = true;
    out.files[p] = { inst: inst.length, exec: exec.length, never: rn.slice(0, MAX_RANGES), ran: rr.slice(0, MAX_RANGES), miss: rm.slice(0, MAX_RANGES) };
    out.total.instrumented += inst.length;
    out.total.executed += exec.length;
  }
  out.unreported = [...known].filter((f) => !agg.has(f) && CODE.test(f)).slice(0, 30);
  if (all) return { json: out, txt: '' }; // the scan prompt has no coverage block
  const rows = Object.entries(out.files).filter(([, f]) => f.inst).sort((a, b) => (b[1].inst - b[1].exec) - (a[1].inst - a[1].exec));
  let txt = `Coverage evidence from the repository's own test run (SpecGuard did not run tests). Changed lines executed by tests: ${out.total.executed} of ${out.total.instrumented} instrumented.\n`;
  for (const [p, f] of rows) {
    const line = `${p} ${f.exec}/${f.inst}${f.never.length ? `; never executed: ${show(f.never, TXT_RANGES)}` : ''}\n`;
    if (Buffer.byteLength(txt + line) > TXT_MAX - 100) { txt += `+${rows.length - txt.split('\n').length + 2} more files not shown\n`; break; }
    txt += line;
  }
  if (out.unreported.length) txt += `No coverage data for: ${out.unreported.slice(0, 8).join(', ')}${out.unreported.length > 8 ? `, +${out.unreported.length - 8} more` : ''}\n`;
  return { json: out, txt };
}

// Files matching newline globs ("!" excludes), relative to ws; walks only below each glob's literal directory prefix; never follows symlinks.
function expand(globs, ws) {
  const pos = globs.filter((g) => !g.startsWith('!')), neg = globs.filter((g) => g.startsWith('!')).map((g) => norm(g.slice(1)));
  const out = new Set();
  for (const g of pos.map(norm)) {
    if (path.isAbsolute(g) || /^[A-Za-z]:/.test(g) || g.split('/').includes('..')) continue;
    const lit = g.split('/'), i = lit.findIndex((s) => /[*?{[]/.test(s)), base = (i < 0 ? lit.slice(0, -1) : lit.slice(0, i)).join('/');
    let seen = 0;
    const stack = [base];
    while (stack.length && seen < MAX_WALK) {
      const rel = stack.pop();
      let ents = [];
      try { ents = fs.readdirSync(path.join(ws, rel), { withFileTypes: true }); } catch { /* missing */ }
      for (const e of ents) {
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) { if (e.name !== '.git' && (e.name !== 'node_modules' || g.includes('node_modules'))) stack.push(r); }
        else if (e.isFile() && ++seen && matches([g], r)) out.add(r);
      }
    }
  }
  return [...out].filter((r) => !neg.length || !matches(neg, r)).sort().slice(0, MAX_REPORTS);
}

function main(env = process.env) {
  const ctx = env.CTX, ws = env.GITHUB_WORKSPACE || process.cwd();
  const write = (json, txt) => {
    fs.writeFileSync(path.join(ctx, 'coverage.json'), JSON.stringify(json) + '\n');
    if (txt) fs.writeFileSync(path.join(ctx, 'coverage.txt'), txt);
  };
  try {
    const globs = String(env.COVERAGE_FILES || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    if (!globs.length) return;
    const found = expand(globs, ws);
    const reports = [], pre = [];
    for (const name of found) {
      try {
        if (fs.statSync(path.join(ws, name)).size > MAX_REPORT) throw new Error('over 40 MB');
        reports.push({ name, text: fs.readFileSync(path.join(ws, name), 'utf8') });
      } catch (e) { pre.push(`${name}: ${e.message}`); }
    }
    if (!found.length) return write({ v: 1, reports: 0, total: {}, files: {}, unreported: [], notes: ['no file matched coverage_files; the target workflow must run its tests with coverage before SpecGuard'] }, '');
    const rd = (n) => { try { return fs.readFileSync(path.join(ctx, n), 'utf8'); } catch { return ''; } };
    let headTime;
    for (const ref of [env.HEAD_SHA, 'HEAD']) {
      if (!ref || headTime) continue;
      try { const s = Number(execFileSync('git', ['-C', ws, 'log', '-1', '--format=%ct', ref], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()); if (s > 0) headTime = s * 1000; } catch { /* shallow or absent: no staleness check */ }
    }
    const all = env.COVERAGE_MODE === 'all'; // scan: every tracked source file, not the changed lines
    let tracked = [];
    if (all) try { tracked = execFileSync('git', ['-C', ws, 'ls-files', '-z'], { encoding: 'utf8', maxBuffer: 256 << 20, stdio: ['ignore', 'pipe', 'ignore'] }).split('\0').filter((f) => f && CODE.test(f)); } catch { /* not a git checkout: nothing to resolve against */ }
    const r = analyze({ patch: rd('diff.patch'), files: all ? tracked : rd('files.txt').split('\n').filter(Boolean), reports, ws, headTime, mode: all ? 'all' : 'diff' });
    r.json.notes.unshift(...pre);
    if (!r.json.reports && !r.json.notes.length) r.json.notes.push('no usable coverage report');
    write(r.json, r.txt);
    console.log(`SpecGuard coverage: ${r.json.reports} report(s), ${r.json.total.executed ?? 0} of ${r.json.total.instrumented ?? 0} instrumented ${all ? '' : 'changed '}lines executed${r.json.notes.length ? `; ${r.json.notes.join('; ')}` : ''}`);
  } catch (e) {
    console.log(`::notice::SpecGuard coverage evidence skipped: ${String(e.message).split('\n')[0]}`);
    try { write({ v: 1, reports: 0, total: {}, files: {}, unreported: [], notes: ['coverage evidence could not be read'] }, ''); } catch { /* ctx missing */ }
  }
}

if (require.main === module) main();
module.exports = { CODE, parse, lcov, xml, istanbul, resolver, ranges, analyze, expand, main };
