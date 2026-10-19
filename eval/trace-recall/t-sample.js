#!/usr/bin/env node
// Seeded random sample of single-line test assertions of the pinned target, each as a T variant (the assertion weakened to a truthiness check).
// usage: node run.js --only none   (fetches + checks out the pinned SHA into the work dir)
//        node t-sample.js [--work <dir>] [--n 50] [--seed 20261019]   writes t-sample.json (sample) and t-cases.json (cases.json shape, for run.js --cases)
//        node run.js --cases eval/trace-recall/t-cases.json --variants T --out t-results.json
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { assertionDelta, args } = require('../../src/leads.js');

const CALL = /^(\s*)t\.assert\.(strictEqual|equal|deepStrictEqual|deepEqual|notStrictEqual|notEqual|notDeepStrictEqual|match)\(/;
const HAS_LIT = /'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`[^`]*`|(?<![\w$.])\d/;

// one whole statement on one line: balanced parentheses, ends with ");" -> {old, new} (new = ok(<the argument without a literal, else the first>)) or null
function weaken(line) {
  const m = CALL.exec(line);
  if (!m || !/\)\s*;?\s*$/.test(line)) return null;
  const a = args(line, m[0].length - 1);
  if (a.length < 1 || !a[0].trim()) return null;
  let d = 0, q = null;
  for (let i = m[0].length - 1; i < line.length; i++) { // the first ( must close at the very end
    const c = line[i];
    if (q) { if (c === '\\') i++; else if (c === q) q = null; continue; }
    if (c === '"' || c === "'" || c === '`') q = c;
    else if (c === '(') d++;
    else if (c === ')' && --d === 0) { if (!/^\s*;?\s*$/.test(line.slice(i + 1))) return null; break; }
  }
  if (d !== 0 || q) return null;
  const actual = (a.find((x) => !HAS_LIT.test(x)) ?? a[0]).trim();
  return { old: line.trim(), new: `t.assert.ok(${actual});`, indent: m[1] };
}

const diffOf = (file, n, old, neu) => `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -${n},1 +${n},1 @@\n-${old}\n+${neu}\n`;

// every line of files {path: text} that assertionDelta flags once weakened, in (file, line) order
function candidates(files) {
  const out = [];
  for (const file of Object.keys(files).sort()) {
    files[file].split(/\r?\n/).forEach((text, i) => {
      const w = weaken(text);
      if (w && assertionDelta(diffOf(file, i + 1, text, w.indent + w.new), () => true).length) out.push({ file, line: i + 1, old: w.old, new: w.new });
    });
  }
  return out;
}

// mulberry32; partial Fisher-Yates over the ordered candidates; result back in (file, line) order
function draw(cands, n, seed) {
  let s = seed >>> 0;
  const rnd = () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const a = cands.slice();
  for (let i = 0; i < Math.min(n, a.length); i++) { const j = i + Math.floor(rnd() * (a.length - i)); [a[i], a[j]] = [a[j], a[i]]; }
  return a.slice(0, n).sort((x, y) => (x.file < y.file ? -1 : x.file > y.file ? 1 : x.line - y.line));
}

module.exports = { weaken, candidates, draw };

// the k/n table from the labelled t-sample.json
function report(j) {
  const rows = j.sample.flatMap((s) => s.rows.map((r) => ({ ...r, id: s.id }))), n = j.sample.length, k = (a, b) => `${a}/${b}`;
  const by = (d) => rows.filter((r) => r.dir === d), n_ = (rs, ...ls) => rs.filter((r) => ls.includes(r.label)).length;
  const b = j.sample.map((s) => s.bytes_added).sort((x, y) => x - y), no = {};
  for (const s of j.sample) if (s.no_row) no[s.no_row] = (no[s.no_row] || 0) + 1;
  const out = { variants: n, emitting: k(j.sample.filter((s) => s.rows.length).length, n), with_right_row: k(j.sample.filter((s) => s.rows.some((r) => r.label === 'right')).length, n), bytes_added_p50: b[Math.ceil(n / 2) - 1], bytes_added_max: b[n - 1], no_row: no, distinct_files_sampled: new Set(j.sample.map((s) => s.file)).size };
  for (const d of ['test->code', 'test->req']) out[d] = { rows: by(d).length, right: k(n_(by(d), 'right'), by(d).length), right_or_related: k(n_(by(d), 'right', 'related'), by(d).length), wrong: k(n_(by(d), 'wrong'), by(d).length) };
  return out;
}
module.exports.report = report;

if (require.main === module) {
  if (process.argv.includes('--report')) { console.log(JSON.stringify(report(JSON.parse(fs.readFileSync(path.join(__dirname, 't-sample.json'), 'utf8'))), null, 1)); process.exit(0); }
  if (fs.existsSync(path.join(__dirname, 't-sample.json')) && !process.argv.includes('--force')) { console.error('t-sample.json holds labels: pass --force to redraw (labels are lost)'); process.exit(1); }
  const argv = process.argv.slice(2), opt = (k, d) => { const i = argv.indexOf(k); return i < 0 ? d : argv[i + 1]; };
  const cases = JSON.parse(fs.readFileSync(path.join(__dirname, 'cases.json'), 'utf8'));
  const work = opt('--work', path.join(os.tmpdir(), 'specguard-trace-recall-' + cases.target.sha.slice(0, 8)));
  const n = +opt('--n', 50), seed = +opt('--seed', 20261019), dir = path.join(work, 'target');
  const files = {};
  (function walk(d) { for (const e of fs.readdirSync(path.join(dir, d), { withFileTypes: true })) { const p = d + '/' + e.name; if (e.isDirectory()) walk(p); else if (/\.(js|ts|mjs|cjs)$/.test(e.name)) files[p] = fs.readFileSync(path.join(dir, p), 'utf8'); } })('test');
  const cands = candidates(files), picked = draw(cands, n, seed);
  const sample = picked.map((p, i) => ({ id: `t${String(i + 1).padStart(2, '0')}`, ...p }));
  const meta = { target: cases.target.sha, seed, n, candidate_lines: cands.length, candidate_files: new Set(cands.map((c) => c.file)).size, sampled_files: new Set(sample.map((s) => s.file)).size };
  fs.writeFileSync(path.join(__dirname, 't-sample.json'), JSON.stringify({ meta, sample }, null, 1) + '\n');
  fs.writeFileSync(path.join(__dirname, 't-cases.json'), JSON.stringify({ target: cases.target, cases: sample.map((s) => ({ id: s.id, edits: { R: [], C: [], T: [{ file: s.file, line: s.line, old: s.old, new: s.new }] } })) }, null, 1) + '\n');
  console.log(JSON.stringify(meta));
}
