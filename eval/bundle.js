#!/usr/bin/env node
// Anonymised adjudication bundles from an A/B dir (<ab>/<variant>/<id>/{posted.json,summary.md,ctx/findings.json}).
//   node eval/bundle.js build --ab AB --out DIR [--seed S] [--pairs F] [--clean F]
//   node eval/bundle.js join  --ab AB --out DIR --verdicts F.json [--pairs F] [--clean F]
// build writes DIR/<id>.json (no variant names) and DIR/_mapping.json (SECRET: fid -> [{id, variant, class}]).
// verdicts.json: {fid: {verdict, useful}} or {id: {fid: {...}}}.
const fs = require('node:fs');
const path = require('node:path');

const REPLAY = path.join(__dirname, 'replay');
const CLASS_RANK = { inline: 0, summary: 1, dropped: 2 };
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const tryRead = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };
const tryJson = (p) => { try { return JSON.parse(tryRead(p)); } catch { return null; } };

// ---- parsing the three outputs -------------------------------------------------------------------------------------
// Current comments end with a hidden `<!--\nkind: X, confidence: Y[, rule: Z]\n-->` block; stored historical ones with a "Why this was flagged" <details>.
const TRAILERS = ['\n\n<!--\nkind: ', '\n\n<details><summary>Why this was flagged</summary>'];
function parseInline(posted) {
  const out = [];
  for (const c of (posted && posted.comments) || []) {
    const b = String(c.body || '');
    const k = Math.max(...TRAILERS.map((t) => b.lastIndexOf(t)));
    const main = k < 0 ? b : b.slice(0, k);
    const why = k < 0 ? '' : b.slice(k);
    const t = /^\*\*(.*?)\*\*\n\n([\s\S]*)$/.exec(main);
    const sug = /(?:```suggestion\n([\s\S]*?)\n```|Suggested fix \(not applied automatically\):\n\n```[^\n]*\n([\s\S]*?)\n```)/.exec(main);
    out.push({
      kind: (/kind: (\w+)/.exec(why) || [])[1] || '?', confidence: (/confidence: (\w+)/.exec(why) || [])[1] || '?',
      class: 'inline', path: c.path || null, line: c.line ?? c.original_line ?? null,
      title: t ? t[1] : main.split('\n')[0], body: (t ? t[2] : main).trim(), ...(sug ? { suggestion: sug[1] ?? sug[2] } : {}),
    });
  }
  return out;
}

function parseSummary(md) {
  const out = [];
  const m = /<details><summary>\d+ more item\(s\)[^<]*<\/summary>\n\n([\s\S]*?)\n<\/details>/.exec(md || '');
  if (m) {
    for (const chunk of m[1].split(/^(?=- \*\*)/m).filter((x) => x.startsWith('- **'))) {
      const h = /^- \*\*([\s\S]*?)\*\* \(`(.*?)`, (\w+)(?:, ([^\n]*?))?\)\n\n([\s\S]*)$/.exec(chunk);
      if (!h) continue;
      const i = h[2].lastIndexOf(':');
      const body = h[5].replace(/^ {2}/gm, '').trim();
      const sug = /Suggested fix \(not applied automatically\):\n\n```[^\n]*\n([\s\S]*?)\n```/.exec(body);
      out.push({
        kind: h[3], confidence: (/(high|medium|low) confidence/.exec(h[4] || '') || [])[1] || null, class: 'summary',
        path: i < 0 ? h[2] : h[2].slice(0, i), line: i < 0 ? null : Number(h[2].slice(i + 1)) || null, title: h[1], body,
        ...(sug ? { suggestion: sug[1] } : {}),
      });
    }
  }
  return out;
}

function parseDropped(md, raw) {
  const out = [];
  const list = (raw && raw.findings) || [];
  for (const m of String(md || '').matchAll(/^- Dropped findings\[(\d+)\] (\w+) (\S+) ([^\n]*?): ([^\n:]*)\.$/gm)) {
    const r = list[Number(m[1])];
    const same = r && r.title && m[4].startsWith(r.title);
    out.push(same
      ? { kind: r.kind, confidence: r.confidence || null, class: 'dropped', path: r.path, line: r.line ?? null, title: r.title, body: String(r.body || '').trim(), drop_reason: m[5], ...(r.suggestion ? { suggestion: r.suggestion } : {}) }
      : { kind: m[2], confidence: null, class: 'dropped', path: m[3], line: null, title: m[4], body: '', drop_reason: m[5] });
  }
  return out;
}

// ---- dedup ---------------------------------------------------------------------------------------------------------
const idents = (s) => new Set((String(s).match(/`[^`]+`|\b[A-Za-z_][\w.]*(?:_\w+|[a-z][A-Z]\w*)\w*\b/g) || []).map((x) => x.replace(/`/g, '').toLowerCase()).filter((x) => x.length >= 5));
function same(a, b) {
  if (a.kind !== b.kind || a.path !== b.path) return false;
  if (a.line != null && b.line != null && Math.abs(a.line - b.line) <= 6) return true;
  const ia = idents(a.title); // conservative: a distinctive identifier shared by the two titles
  for (const x of idents(b.title)) if (ia.has(x)) return true;
  return false;
}

// ---- seeded rng ----------------------------------------------------------------------------------------------------
function rng(seed) {
  let h = 1779033703 ^ String(seed).length;
  for (const ch of String(seed)) { h = Math.imul(h ^ ch.charCodeAt(0), 3432918353); h = (h << 13) | (h >>> 19); }
  let a = h >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function shuffle(arr, r) { const a = arr.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

// ---- ab dir --------------------------------------------------------------------------------------------------------
const subdirs = (d) => fs.readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
function variantsOf(ab) { return subdirs(ab).filter((v) => subdirs(path.join(ab, v)).some((i) => fs.existsSync(path.join(ab, v, i, 'meta.json')))); }

function cards(opts) {
  const pairs = readJson(opts.pairs || path.join(REPLAY, 'holdout-pairs.json')).pairs || [];
  const clean = readJson(opts.clean || path.join(REPLAY, 'holdout-clean.json')).clean || [];
  const info = {};
  for (const p of pairs.filter((x) => x.bug_card)) info[p.replay_id] = { bug: true, pr_title: p.introducing.pr_title, pr_body: p.introducing.pr_body, size: p.size_changed_lines, bug_card: { behaviour: p.bug_card.behaviour, trigger: p.bug_card.trigger, region: p.bug_card.region, test_gap: p.bug_card.test_gap }, fix_pr: p.fix.number };
  for (const c of clean) info[c.id] = { bug: false, pr_title: c.pr_title, pr_body: c.pr_body, size: c.size };
  return info;
}

// Raw findings of one variant/id, each tagged with its variant. Deduplicated across variants into clusters.
function collect(ab, id, variants) {
  const found = [];
  for (const v of variants) {
    const d = path.join(ab, v, id);
    if (!fs.existsSync(d)) continue;
    const mine = [
      ...parseInline(tryJson(path.join(d, 'posted.json'))),
      ...parseSummary(tryRead(path.join(d, 'summary.md'))),
      ...parseDropped(tryRead(path.join(d, 'summary.md')), tryJson(path.join(d, 'ctx', 'findings.json'))),
    ];
    for (const f of mine) found.push({ ...f, variant: v });
  }
  found.sort((a, b) => CLASS_RANK[a.class] - CLASS_RANK[b.class] || String(a.path).localeCompare(String(b.path)) || (a.line ?? 0) - (b.line ?? 0));
  const clusters = [];
  for (const f of found) {
    const c = clusters.find((x) => same(x.rep, f)); // compared with the representative only: no chaining
    if (c) { c.members.push(f); if (CLASS_RANK[f.class] === CLASS_RANK[c.rep.class] && f.body.length > c.rep.body.length) c.rep = f; } else clusters.push({ rep: f, members: [f] });
  }
  return clusters;
}

const LEAK = /ab-hold|\b(?:v1|v2|lean)[\\/]/gi;
const scrub = (s) => (typeof s === 'string' ? s.replace(LEAK, '') : s);

function build(ab, out, opts = {}) {
  const variants = variantsOf(ab);
  const ids = [...new Set(variants.flatMap((v) => subdirs(path.join(ab, v))))].sort();
  const info = cards(opts);
  const seed = opts.seed || 'adjud-1';
  const per = ids.map((id) => ({ id, clusters: collect(ab, id, variants) }));
  const total = per.reduce((n, p) => n + p.clusters.length, 0);
  const nums = shuffle(Array.from({ length: total }, (_, i) => i + 1), rng(`${seed}:fid`));
  const width = Math.max(3, String(total).length);
  fs.mkdirSync(out, { recursive: true });
  const mapping = {}, stats = [];
  let k = 0;
  for (const { id, clusters } of per) {
    const card = info[id] || { bug: false, pr_title: null, pr_body: null, size: null };
    const fs_ = clusters.map((c) => {
      const fid = `F${String(nums[k++]).padStart(width, '0')}`;
      const best = (v) => c.members.filter((m) => m.variant === v).sort((a, b) => CLASS_RANK[a.class] - CLASS_RANK[b.class])[0].class;
      mapping[fid] = [...new Set(c.members.map((m) => m.variant))].sort().map((variant) => ({ id, variant, class: best(variant) }));
      const r = c.rep;
      return { fid, kind: r.kind, confidence: r.confidence || c.members.map((m) => m.confidence).find(Boolean) || null, class: c.members.map((m) => m.class).sort((a, b) => CLASS_RANK[a] - CLASS_RANK[b])[0], path: r.path, line: r.line, title: scrub(r.title), body: scrub(r.body), ...(r.suggestion ? { suggestion: scrub(r.suggestion) } : {}), ...(r.drop_reason && c.members.every((m) => m.class === 'dropped') ? { drop_reason: r.drop_reason } : {}) };
    });
    const bundle = { id, type: card.bug ? 'bug' : 'clean', pr_title: card.pr_title, pr_body: card.pr_body, size: card.size, ...(card.bug ? { bug_card: card.bug_card, bug_fix_pr: card.fix_pr } : {}), findings: shuffle(fs_, rng(`${seed}:${id}`)) };
    const file = path.join(out, `${id}.json`);
    fs.writeFileSync(file, `${JSON.stringify(bundle, null, 2)}\n`);
    stats.push({ id, unique: fs_.length, bytes: fs.statSync(file).size });
  }
  fs.writeFileSync(path.join(out, '_mapping.json'), `${JSON.stringify(mapping, null, 2)}\n`);
  const by = { 1: 0, 2: 0, 3: 0 };
  for (const m of Object.values(mapping)) by[Math.min(m.length, 3)]++;
  return { variants, stats, total, by };
}

// ---- join ----------------------------------------------------------------------------------------------------------
const GOOD_V = new Set(['true_gap', 'hit_direct', 'hit_near']);
function join(ab, out, verdictsFile, opts = {}) {
  const info = cards(opts);
  const mapping = readJson(path.join(out, '_mapping.json'));
  const raw = readJson(verdictsFile);
  const verdicts = {}; // flatten {id: {fid: v}}
  for (const [k, v] of Object.entries(raw)) { if (v && typeof v === 'object' && !('verdict' in v) && !('useful' in v)) Object.assign(verdicts, v); else verdicts[k] = v; }
  const res = {};
  const mk = () => ({ bug: {}, clean: {}, inline: { n: 0, good: 0 }, dropped: 0, m: { perPr: {}, judged: { inline: 0, all: 0 }, falseGap: { inline: 0, all: 0 }, wouldFix: 0, noise: 0 } });
  for (const v of variantsOf(ab)) res[v] = mk();
  const V = (v) => (res[v] ||= mk());
  for (const [fid, prod] of Object.entries(mapping)) {
    const v = verdicts[fid] || {};
    const good = v.useful === 'would_fix' || GOOD_V.has(v.verdict);
    for (const { id, variant, class: cls } of prod) {
      const r = V(variant);
      if (cls === 'dropped') { r.dropped++; continue; }
      if (cls === 'inline') { r.inline.n++; if (good) r.inline.good++; }
      const m = r.m, pp = (m.perPr[id] ||= { inline: 0, summary: 0 });
      pp[cls]++;
      const bad = v.verdict === 'wrong' || v.verdict === 'unverifiable';
      for (const c of cls === 'inline' ? ['inline', 'all'] : ['all']) { if (v.verdict) m.judged[c]++; if (bad) m.falseGap[c]++; }
      if (cls === 'inline') { if (v.useful === 'would_fix') m.wouldFix++; if (v.verdict === 'trivial' || v.verdict === 'wrong') m.noise++; }
      if (info[id] && info[id].bug) {
        const b = (r.bug[id] ||= { inline: 'miss', summary: 'miss' });
        const rank = { miss: 0, near: 1, direct: 2 };
        const got = v.hit === 'direct' || v.hit === 'near' ? v.hit : v.verdict === 'hit_direct' ? 'direct' : v.verdict === 'hit_near' ? 'near' : 'miss'; // `hit` wins over legacy hit_* verdicts
        if (rank[got] > rank[b[cls]]) b[cls] = got;
      } else {
        const c = (r.clean[id] ||= { n: 0, would_fix: 0, byVerdict: {} });
        c.n++; if (v.useful === 'would_fix') c.would_fix++;
        c.byVerdict[v.verdict || 'unjudged'] = (c.byVerdict[v.verdict || 'unjudged'] || 0) + 1;
      }
    }
  }
  const bugIds = Object.keys(info).filter((i) => info[i].bug);
  const cleanIds = Object.keys(info).filter((i) => !info[i].bug);
  const table = {};
  for (const [variant, r] of Object.entries(res)) {
    const cnt = (cls) => { const t = { direct: 0, near: 0, miss: 0 }; for (const id of bugIds) t[(r.bug[id] || { [cls]: 'miss' })[cls]]++; return t; };
    const any = { direct: 0, near: 0, miss: 0 };
    for (const id of bugIds) { const b = r.bug[id] || {}; const s = [b.inline, b.summary]; any[s.includes('direct') ? 'direct' : s.includes('near') ? 'near' : 'miss']++; }
    const cl = { findings: 0, would_fix: 0, prs_with_would_fix: 0, byVerdict: {} };
    for (const id of cleanIds) { const c = r.clean[id]; if (!c) continue; cl.findings += c.n; cl.would_fix += c.would_fix; if (c.would_fix) cl.prs_with_would_fix++; for (const [k, n] of Object.entries(c.byVerdict)) cl.byVerdict[k] = (cl.byVerdict[k] || 0) + n; }
    const ratio = (a, b) => (b ? a / b : null);
    const prs = Math.max(subdirs(path.join(ab, variant)).length, Object.keys(r.m.perPr).length);
    const pp = Object.values(r.m.perPr), sum = (k) => pp.reduce((n, x) => n + x[k], 0);
    const metrics = {
      false_gap_inline: ratio(r.m.falseGap.inline, r.m.judged.inline), false_gap_all: ratio(r.m.falseGap.all, r.m.judged.all),
      inline_per_pr_mean: ratio(sum('inline'), prs), inline_per_pr_max: pp.reduce((n, x) => Math.max(n, x.inline), 0), summary_per_pr_mean: ratio(sum('summary'), prs),
      actionable_share: ratio(r.m.wouldFix, r.inline.n), noise_share: ratio(r.m.noise, r.inline.n), prs,
    };
    table[variant] = { metrics, bug: { inline: cnt('inline'), summary: cnt('summary'), any }, clean: cl, inline_precision: r.inline.n ? r.inline.good / r.inline.n : null, inline_n: r.inline.n, dropped: r.dropped };
  }
  return table;
}

function printTables(table) {
  const pct = (x) => (x == null ? '-' : `${(x * 100).toFixed(0)}%`), num = (x) => (x == null ? '-' : x.toFixed(1));
  const t = (rows) => rows.map((r) => `| ${r.join(' | ')} |`).join('\n');
  const vs = Object.keys(table);
  console.log('Bug PRs (hit = a finding with hit_direct; near = hit_near only)\n');
  console.log(t([['variant', 'inline d/n/m', 'summary d/n/m', 'either d/n/m'], ['---', '---', '---', '---'],
    ...vs.map((v) => [v, ...['inline', 'summary', 'any'].map((c) => { const x = table[v].bug[c]; return `${x.direct}/${x.near}/${x.miss}`; })])]));
  console.log('\nClean PRs (shown findings = inline + summary)\n');
  console.log(t([['variant', 'findings', 'would_fix', 'PRs with would_fix', 'by verdict'], ['---', '---', '---', '---', '---'],
    ...vs.map((v) => { const c = table[v].clean; return [v, c.findings, c.would_fix, c.prs_with_would_fix, JSON.stringify(c.byVerdict)]; })]));
  console.log('\nInline precision (would_fix, true_gap or hit_*) and dropped findings\n');
  console.log(t([['variant', 'inline n', 'precision', 'dropped'], ['---', '---', '---', '---'],
    ...vs.map((v) => [v, table[v].inline_n, table[v].inline_precision == null ? 'n/a' : table[v].inline_precision.toFixed(2), table[v].dropped])]));
  console.log('\nFinding quality and volume (false gap = wrong or unverifiable / judged; shares are over inline findings)\n');
  console.log(t([['variant', 'false-gap inline', 'false-gap all', 'inline/PR mean', 'inline/PR max', 'summary/PR', 'actionable', 'noise'], ['---', '---', '---', '---', '---', '---', '---', '---'],
    ...vs.map((v) => { const m = table[v].metrics; return [v, pct(m.false_gap_inline), pct(m.false_gap_all), num(m.inline_per_pr_mean), m.inline_per_pr_max, num(m.summary_per_pr_mean), pct(m.actionable_share), pct(m.noise_share)]; })]));
}

function main(argv) {
  const [cmd, ...rest] = argv;
  const a = {};
  for (let i = 0; i < rest.length; i += 2) a[rest[i].replace(/^--/, '')] = rest[i + 1];
  if (!a.ab || !a.out || !['build', 'join'].includes(cmd)) { console.error('usage: bundle.js build|join --ab AB --out DIR [--verdicts F] [--seed S]'); process.exit(2); }
  if (cmd === 'build') {
    const r = build(a.ab, a.out, a);
    for (const s of r.stats) console.log(`${s.id}\t${s.unique} unique\t${s.bytes} bytes`);
    console.log(`variants: ${r.variants.join(',')}; total unique: ${r.total}; produced by 1/2/3+ variants: ${r.by[1]}/${r.by[2]}/${r.by[3]}`);
  } else {
    if (!a.verdicts) { console.error('--verdicts required'); process.exit(2); }
    printTables(join(a.ab, a.out, a.verdicts, a));
  }
}

if (require.main === module) main(process.argv.slice(2));
module.exports = { parseInline, parseSummary, parseDropped, same, build, join, rng, shuffle };
