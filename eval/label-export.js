#!/usr/bin/env node
// Blind labelling of review findings (docs/validation-plan.md). Tool names are hidden and rows are shuffled with a seed, so the
// labeller judges the text, not the tool. ids are hashes of (tool, repo, pr, fingerprint) for SpecGuard, (tool, repo, pr, path, line, comment id) otherwise: the importer rebuilds them from the
// same window, so no key file has to be kept.
//   node eval/label-export.js --repo OWNER/REPO --since YYYY-MM-DD [--until D] [--sample 30] [--seed N] [--out labels.csv]
//   node eval/label-export.js --repo ... --since ... --import labels.csv        (precision per tool; feed the file to weekly-report --labels)
// Two independent labellers: add columns label_a and label_b. Import prints Krippendorff's alpha (nominal, valid|invalid; unsure and blank =
// missing) overall and PER TOOL, each with a bootstrap 95% interval, plus each labeller's unsure rate and the share labelled valid.
// Gate: alpha >= 0.800 and interval lower bound >= 0.667 (every scope) = decision grade; 0.667 <= alpha < 0.800 or a lower bound below
// 0.667 = "tentative, no decision"; alpha < 0.667 or an unsure rate above 20% for either labeller = refused (exit 1, no precision).
// Then reconcile into the `label` column (required) and import again.
// Blinding: optional columns guess_tool_a / guess_tool_b (specguard | copilot | blank = don't know); import reports the share of correct guesses
// against 50% and a Bang blinding index. Text is normalised, but SpecGuard's wording stays recognisable: residual risk, see the plan.
// Offline: replace --repo/--since with --fixture FILE (the dataset format of eval/weekly-report.js).
const crypto = require('node:crypto');
const fs = require('node:fs');
const { wilson } = require('./aggregate-counts');
const { mulberry32 } = require('./szz');

const COLUMNS = ['id', 'repo', 'pr', 'path', 'line', 'text', 'link', 'label', 'notes', 'guess_tool_a', 'guess_tool_b'];
const LABELS = ['valid', 'invalid', 'unsure'];

// A SpecGuard finding is its fingerprint (16-hex prefix: summary refs are 16, inline 40); path, line and channel change on promotion. Other tools keep the comment-id key.
const findingId = (f) => `F${crypto.createHash('sha1').update((f.tool === 'specguard' && f.ref ? [f.tool, f.repo, f.pr, String(f.ref).slice(0, 16)] : [f.tool, f.repo, f.pr, f.path, f.line ?? '', f.ref ?? '']).join('\0')).digest('hex').slice(0, 9)}`;

function shuffle(a, seed) { // Fisher-Yates, deterministic for a seed
  const r = mulberry32(seed), x = [...a];
  for (let i = x.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [x[i], x[j]] = [x[j], x[i]]; }
  return x;
}

// The labeller sees plain text: HTML comments, markdown headers/bold, links, tool names and tool-specific leading labels are removed.
const clean = (t) => String(t || '').replace(/<!--[\s\S]*?-->/g, ' ').replace(/^\s*#{1,6}\s+/gm, '').replace(/(\*\*|__)/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/https?:\/\/\S+/g, ' ')
  .replace(/\[?\b(spec\s?guard|copilot|github-actions)\b(\[bot\])?\]?/gi, '[tool]').replace(/\s+/g, ' ').trim()
  .replace(/^[\p{Extended_Pictographic}\s]+/u, '').replace(/^(?:(?:\[[^\]]{1,30}\]|(?:gap|suggestion|nit|issue|warning|note|spec[_ ]mismatch|missing test)\s*:)\s*)+/i, '').slice(0, 700);

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
    link: `https://github.com/${f.repo}/pull/${f.pr}/files`, label: '', notes: '', guess_tool_a: '', guess_tool_b: '' }));
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
  if (!h.includes('id') || !(h.includes('label') || h.includes('label_a'))) throw new Error('labels CSV needs the id and label columns (or label_a and label_b)');
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

// Krippendorff's alpha, nominal: units = arrays of values (null = missing); units with fewer than 2 values do not pair. null when there is no variation.
function alpha(units) {
  const o = {}, n = {}; let N = 0;
  for (const u of units) {
    const v = u.filter((x) => x != null), m = v.length;
    if (m < 2) continue;
    for (let i = 0; i < m; i++) { n[v[i]] = (n[v[i]] || 0) + 1; N++; for (let j = 0; j < m; j++) if (i !== j && v[i] !== v[j]) o[v[i] + '|' + v[j]] = (o[v[i] + '|' + v[j]] || 0) + 1 / (m - 1); }
  }
  const Do = Object.values(o).reduce((a, b) => a + b, 0), cs = Object.keys(n);
  let De = 0; for (const c of cs) for (const k of cs) if (c !== k) De += n[c] * n[k] / (N - 1);
  return De ? 1 - Do / De : null;
}
const ALPHA_MIN = 0.667, ALPHA_DECIDE = 0.8, UNSURE_MAX = 0.2;
// Bootstrap 95% interval of alpha: resample the paired findings with replacement, 1000 draws, fixed seed; draws without variation are dropped.
function alphaInterval(units, seed = 1, draws = 1000) {
  const r = mulberry32(seed), u = units.filter((x) => x.filter((y) => y != null).length > 1), out = [];
  for (let d = 0; d < draws && u.length; d++) { const a = alpha(u.map(() => u[Math.floor(r() * u.length)])); if (a != null) out.push(a); }
  out.sort((a, b) => a - b);
  return out.length ? [out[Math.floor(0.025 * out.length)], out[Math.min(out.length - 1, Math.floor(0.975 * out.length))]] : null;
}
// Agreement of label_a and label_b over valid|invalid, overall and per tool (toolOf: id -> tool); null when the sheet has no two label columns
// (old single `label` file: no check). status per scope: fail (alpha < 0.667 or undefined), tentative, reliable (alpha >= 0.8 and bootstrap lower >= 0.667).
// ok = no scope failed and both unsure rates <= 20%; decision = ok and every scope reliable.
function agreement(rows, toolOf = () => null) {
  if (!rows.length || !('label_a' in rows[0]) || !('label_b' in rows[0])) return null;
  const raw = (x) => { const l = String(x || '').trim().toLowerCase(); if (l && !LABELS.includes(l)) throw new Error(`label "${x}" is not one of ${LABELS.join('|')}`); return l; };
  const v = (x) => { const l = raw(x); return l === 'valid' || l === 'invalid' ? l : null; };
  const unsure = {};
  for (const k of ['a', 'b']) { const got = rows.map((r) => raw(r[`label_${k}`])).filter(Boolean); unsure[k] = got.length ? got.filter((l) => l === 'unsure').length / got.length : 0; }
  const scope = (us) => {
    const a = alpha(us), ci = alphaInterval(us), vals = us.flat().filter(Boolean);
    return { n: us.filter((u) => u[0] && u[1]).length, alpha: a, lower: ci && ci[0], upper: ci && ci[1], prevalence: vals.length ? vals.filter((x) => x === 'valid').length / vals.length : null,
      status: a == null || a < ALPHA_MIN ? 'fail' : a >= ALPHA_DECIDE && ci && ci[0] >= ALPHA_MIN ? 'reliable' : 'tentative' };
  };
  const units = (pick) => rows.filter(pick).map((r) => [v(r.label_a), v(r.label_b)]);
  const scopes = { overall: scope(units(() => true)) };
  for (const t of [...new Set(rows.map((r) => toolOf(r.id)).filter(Boolean))].sort()) { const s = scope(units((r) => toolOf(r.id) === t)); if (s.n) scopes[t] = s; }
  const ok = Object.values(scopes).every((s) => s.status !== 'fail') && unsure.a <= UNSURE_MAX && unsure.b <= UNSURE_MAX;
  return { alpha: scopes.overall.alpha, n: scopes.overall.n, scopes, unsure, ok, decision: ok && Object.values(scopes).every((s) => s.status === 'reliable') };
}
// Blinding check per labeller: correct vs wrong tool guesses (blank or anything else = don't know). share = correct / (correct + wrong), 0.5 when blind;
// bi = (correct - wrong) / all rows (Bang's blinding index: 0 = blind, 1 = fully unblinded).
function blinding(rows, toolOf) {
  const out = {};
  for (const k of ['a', 'b']) {
    if (!rows.length || !(`guess_tool_${k}` in rows[0])) continue;
    let c = 0, w = 0, dk = 0;
    for (const r of rows) { const g = String(r[`guess_tool_${k}`] || '').trim().toLowerCase(), t = toolOf(r.id); if (!t) continue; if (g !== 'specguard' && g !== 'copilot') dk++; else if (g === t) c++; else w++; }
    if (c + w + dk) out[k] = { correct: c, wrong: w, dont_know: dk, share: c + w ? c / (c + w) : null, wilson95: wilson(c, c + w), bi: (c - w) / (c + w + dk) };
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
  if (o.import) {
    const rows = parseCsv(fs.readFileSync(o.import, 'utf8')), tools = new Map(findings.map((f) => [findingId(f), f.tool])), toolOf = (id) => tools.get(id) || null;
    const ag = agreement(rows, toolOf), fmt = (x, d = 3) => (x == null ? 'n/a' : x.toFixed(d));
    for (const [k, b] of Object.entries(blinding(rows, toolOf))) console.error(`blinding, labeller ${k}: ${b.correct}/${b.correct + b.wrong} correct tool guesses (share ${fmt(b.share, 2)}, 95% ${b.wilson95 ? b.wilson95.map((x) => fmt(x, 2)).join('-') : 'n/a'}; 0.50 = blind), ${b.dont_know} don't know, Bang BI ${fmt(b.bi, 2)}${b.wilson95 && b.wilson95[0] > 0.5 ? ': NOT BLIND, say so when you quote precision' : ''}`);
    if (ag) {
      for (const [name, s] of Object.entries(ag.scopes)) console.error(`Krippendorff alpha [${name}] (valid|invalid, unsure and blank = missing) = ${s.alpha == null ? 'undefined (no variation)' : fmt(s.alpha)} (bootstrap 95% ${fmt(s.lower)}-${fmt(s.upper)}) over ${s.n} doubly labelled findings, share labelled valid ${fmt(s.prevalence, 2)}: ${s.status}`);
      console.error(`unsure rate: labeller a ${fmt(ag.unsure.a, 2)}, labeller b ${fmt(ag.unsure.b, 2)} (cap ${UNSURE_MAX})`);
      for (const [name, s] of Object.entries(ag.scopes)) if (s.status === 'fail') console.error(`labels not reliable: alpha=${s.alpha == null ? 'undefined' : fmt(s.alpha)} < ${ALPHA_MIN}, revise the labelling guide and relabel [${name}]`);
      for (const k of ['a', 'b']) if (ag.unsure[k] > UNSURE_MAX) console.error(`labeller ${k} marked ${fmt(ag.unsure[k] * 100, 0)}% of findings unsure (cap ${UNSURE_MAX * 100}%): the guide is too vague, revise it and relabel`);
      if (!ag.ok) process.exit(1);
      if (!ag.decision) console.error(`TENTATIVE, NO DECISION: a scope has alpha below ${ALPHA_DECIDE} or a bootstrap lower bound below ${ALPHA_MIN}; the precision below is not evidence for Step 6.`);
      if (!rows.some((r) => String(r.label || '').trim())) throw new Error('alpha passed: reconcile the two labels into the label column, then import again');
    }
    console.log(JSON.stringify(labelPrecision(findings, readLabels(rows)), null, 2)); return;
  }
  const csv = toCsv(exportRows(findings, { sample: +o.sample, seed: +o.seed || 1 }));
  if (claimless(findings)) console.error(`${claimless(findings)} summary-only findings have no claim text (counts written before titles were recorded): left out of the sheet and the precision sample.`);
  if (o.out) { fs.writeFileSync(o.out, csv); console.error(`wrote ${o.out}: ${csv.split('\n').length - 2} findings. Send it to the labellers; keep the tool column out of their view.`); } else process.stdout.write(csv);
}
module.exports = { findingId, shuffle, exportRows, claimless, toCsv, parseCsv, readLabels, labelPrecision, alpha, alphaInterval, agreement, blinding, ALPHA_MIN, COLUMNS };
if (require.main === module) try { main(); } catch (e) { console.error(e.message); process.exit(1); }
