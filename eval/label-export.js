#!/usr/bin/env node
// Blind labelling of review findings (docs/validation-plan.md). Tool names are hidden and rows are shuffled with a seed, so the
// labeller judges the text, not the tool. ids are hashes of (tool, repo, pr, path, line, ref): the importer rebuilds them from the
// same window, so no key file has to be kept.
//   node eval/label-export.js --repo OWNER/REPO --since YYYY-MM-DD [--until D] [--sample 30] [--seed N] [--out labels.csv]
//   node eval/label-export.js --repo ... --since ... --import labels.csv        (precision per tool; feed the file to weekly-report --labels)
// Offline: replace --repo/--since with --fixture FILE (the dataset format of eval/weekly-report.js).
const crypto = require('node:crypto');
const fs = require('node:fs');
const { wilson } = require('./aggregate-counts');
const { mulberry32 } = require('./szz');

const COLUMNS = ['id', 'repo', 'pr', 'path', 'line', 'text', 'link', 'label', 'notes'];
const LABELS = ['valid', 'invalid', 'unsure'];

const findingId = (f) => `F${crypto.createHash('sha1').update([f.tool, f.repo, f.pr, f.path, f.line ?? '', f.ref ?? ''].join('\0')).digest('hex').slice(0, 9)}`;

function shuffle(a, seed) { // Fisher-Yates, deterministic for a seed
  const r = mulberry32(seed), x = [...a];
  for (let i = x.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [x[i], x[j]] = [x[j], x[i]]; }
  return x;
}

// The labeller sees plain text: hidden markers, tool names and suggestion fences' tool boilerplate are removed.
const clean = (t) => String(t || '').replace(/<!--[\s\S]*?-->/g, ' ').replace(/\b(spec\s?guard|copilot|github-actions)\b(\[bot\])?/gi, '[tool]').replace(/\s+/g, ' ').trim().slice(0, 700);

// A summary-only finding from older counts has no claim text, so a labeller cannot judge it: it is left out of the sheet (and the sample) and counted.
// The sheet never says how a finding was delivered (that would unblind SpecGuard): `delivery` stays on the findings the importer rebuilds from the same window.
const claimless = (findings) => findings.filter((f) => f.no_claim).length;
function exportRows(all, { sample = 30, seed = 1 } = {}) {
  const findings = all.filter((f) => !f.no_claim), picked = [];
  for (const tool of [...new Set(findings.map((f) => f.tool))].sort()) {
    const mine = shuffle(findings.filter((f) => f.tool === tool).sort((a, b) => findingId(a).localeCompare(findingId(b))), seed);
    picked.push(...(sample > 0 ? mine.slice(0, sample) : mine));
  }
  return shuffle(picked.sort((a, b) => findingId(a).localeCompare(findingId(b))), seed + 1).map((f) => ({
    id: findingId(f), repo: f.repo, pr: f.pr, path: f.path || '', line: f.line ?? '', text: clean(f.text),
    link: `https://github.com/${f.repo}/pull/${f.pr}/files`, label: '', notes: '' }));
}

// CSV (RFC 4180). Cells that start like a spreadsheet formula get a leading apostrophe on export.
const cell = (v) => { let s = String(v ?? ''); if (/^[=+\-@]/.test(s)) s = `'${s}`; return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const toCsv = (rows) => `${COLUMNS.join(',')}\n${rows.map((r) => COLUMNS.map((c) => cell(r[c])).join(',')).join('\n')}\n`;
function parseCsv(text) {
  const rows = [];
  let row = [], v = '', q = false;
  const s = String(text).replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) { if (ch === '"') { if (s[i + 1] === '"') { v += '"'; i++; } else q = false; } else v += ch; }
    else if (ch === '"') q = true;
    else if (ch === ',') { row.push(v); v = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && s[i + 1] === '\n') i++; row.push(v); v = ''; if (row.some((x) => x !== '')) rows.push(row); row = []; }
    else v += ch;
  }
  row.push(v); if (row.some((x) => x !== '')) rows.push(row);
  const [head, ...body] = rows;
  if (!head) return [];
  const h = head.map((x) => x.trim().toLowerCase());
  if (!h.includes('id') || !h.includes('label')) throw new Error('labels CSV needs the id and label columns');
  return body.map((r) => Object.fromEntries(h.map((c, i) => [c, r[i] ?? ''])));
}

// id -> label for every labelled row; rejects values outside valid|invalid|unsure and duplicate ids.
function readLabels(rows) {
  const out = new Map();
  for (const r of rows) {
    const label = String(r.label || '').trim().toLowerCase();
    if (!label) continue; // not labelled yet
    if (!LABELS.includes(label)) throw new Error(`row ${r.id}: label "${r.label}" is not one of ${LABELS.join('|')}`);
    if (out.has(r.id)) throw new Error(`duplicate id ${r.id}`);
    out.set(r.id, label);
  }
  return out;
}

// Precision = valid / (valid + invalid); unsure rows are reported, not counted. Wilson interval, findings treated as independent.
function labelPrecision(findings, labels) {
  const by = new Map(findings.map((f) => [findingId(f), f]));
  const out = {};
  for (const [id, label] of labels) {
    const f = by.get(id);
    if (!f) { (out.unmatched ||= []).push(id); continue; }
    const t = (out[f.tool] ||= { valid: 0, invalid: 0, unsure: 0 });
    t[label]++;
  }
  for (const t of Object.values(out)) {
    if (Array.isArray(t)) continue;
    const n = t.valid + t.invalid;
    Object.assign(t, { n, precision: n ? t.valid / n : null, wilson: wilson(t.valid, n) });
  }
  return out;
}

function main() {
  const { values: o } = require('node:util').parseArgs({ options: { repo: { type: 'string' }, since: { type: 'string' }, until: { type: 'string' }, fixture: { type: 'string' },
    sample: { type: 'string', default: '30' }, seed: { type: 'string', default: '1' }, out: { type: 'string' }, import: { type: 'string' } } });
  if (!o.fixture && !(o.repo && o.since)) { console.error('Usage: node eval/label-export.js (--repo OWNER/REPO --since YYYY-MM-DD [--until D] | --fixture FILE) [--sample 30] [--seed N] [--out labels.csv] [--import labels.csv]'); process.exit(2); }
  const { load, findingsOf } = require('./weekly-report'); // lazy: weekly-report requires this file
  const findings = findingsOf(load(o));
  if (o.import) { console.log(JSON.stringify(labelPrecision(findings, readLabels(parseCsv(fs.readFileSync(o.import, 'utf8')))), null, 2)); return; }
  const csv = toCsv(exportRows(findings, { sample: +o.sample, seed: +o.seed || 1 }));
  if (claimless(findings)) console.error(`${claimless(findings)} summary-only findings have no claim text (counts written before titles were recorded): left out of the sheet and the precision sample.`);
  if (o.out) { fs.writeFileSync(o.out, csv); console.error(`wrote ${o.out}: ${csv.split('\n').length - 2} findings. Send it to the labellers; keep the tool column out of their view.`); } else process.stdout.write(csv);
}
module.exports = { findingId, shuffle, exportRows, claimless, toCsv, parseCsv, readLabels, labelPrecision, COLUMNS };
if (require.main === module) try { main(); } catch (e) { console.error(e.message); process.exit(1); }
