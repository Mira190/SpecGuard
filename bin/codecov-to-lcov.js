#!/usr/bin/env node
'use strict';
// Codecov API v2 report JSON ({files:[{name, line_coverage:[[line, status]]}]}) -> LCOV.
// status 0 = hit, 1 = miss, 2 = partial. Hit and partial -> DA:<line>,1; miss -> DA:<line>,0.
// Usage: node codecov-to-lcov.js <report.json> <out.lcov>   (counts go to stderr as JSON)
// The input is untrusted data: shape is validated, paths are checked, size is capped. Node built-ins only.
const fs = require('node:fs');

const MAX_BYTES = 50 * 1024 * 1024;

const badPath = (p) => typeof p !== 'string' || p === '' || p.includes('\0') || /^([\\/]|[A-Za-z]:)/.test(p) || p.split(/[\\/]/).includes('..') || /[\r\n]/.test(p);

function convert(report) {
  if (!report || typeof report !== 'object' || !Array.isArray(report.files)) throw new Error('not a Codecov report: "files" array missing');
  const counts = { files: 0, hit: 0, miss: 0, partial: 0 };
  const out = [];
  for (const f of report.files) {
    if (!f || typeof f !== 'object' || !Array.isArray(f.line_coverage)) throw new Error('not a Codecov report: a file entry has no line_coverage array');
    if (badPath(f.name)) throw new Error('refused file path (empty, absolute, contains .. or NUL/newline)');
    if (!f.line_coverage.length) continue;
    const rows = [];
    for (const e of f.line_coverage) {
      if (!Array.isArray(e) || e.length < 2 || !Number.isInteger(e[0]) || e[0] < 1 || ![0, 1, 2].includes(e[1])) throw new Error('not a Codecov report: bad line_coverage entry');
      rows.push(`DA:${e[0]},${e[1] === 1 ? 0 : 1}`);
      counts[e[1] === 0 ? 'hit' : e[1] === 1 ? 'miss' : 'partial']++;
    }
    counts.files++;
    out.push(`SF:${f.name}`, ...rows, 'end_of_record');
  }
  return { lcov: out.length ? out.join('\n') + '\n' : '', counts };
}

function convertText(text) {
  if (Buffer.byteLength(text) > MAX_BYTES) throw new Error('report larger than 50 MB refused');
  let report;
  try { report = JSON.parse(text); } catch { throw new Error('report is not valid JSON'); }
  return convert(report);
}

if (require.main === module) {
  const [inp, out] = process.argv.slice(2);
  try {
    if (!inp || !out) throw new Error('usage: codecov-to-lcov.js report.json out.lcov');
    if (fs.statSync(inp).size > MAX_BYTES) throw new Error('report larger than 50 MB refused');
    const { lcov, counts } = convertText(fs.readFileSync(inp, 'utf8'));
    fs.writeFileSync(out, lcov);
    console.error(JSON.stringify(counts));
  } catch (e) { console.error(`codecov-to-lcov: ${e.message}`); process.exit(1); }
}

module.exports = { convert, convertText, MAX_BYTES };
