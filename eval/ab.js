#!/usr/bin/env node
// A/B harness for reviewer PROMPT VARIANTS on identical inputs: quality (real post.run + grading) and token cost (sub-agent transcripts).
//   setup  : per variant x id, copy ctx (no findings), build the variant's prompt against that ctx, write task.md + manifest.json
//   finish : post each findings.json through the real post.run, grade seeded cases / count findings on real PRs, print a table
//   tokens : match sub-agent transcripts to variant/id and compare turns and input tokens (paired across ids)
// The model step is external: an orchestrator spawns one simulated reviewer per task.md. See eval/ab/README.md.
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const MAIN = path.join(__dirname, '..');
const USAGE = `Usage:
  node eval/ab.js setup  --src OUTDIR --ids a,b,c --ab ABDIR --variant name=WORKTREE [--variant ...]
  node eval/ab.js finish --ab ABDIR [--post-root MAINREPO]
  node eval/ab.js tokens --ab ABDIR [--transcripts f1.jsonl,f2.jsonl]`;

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const fwd = (p) => path.resolve(p).replace(/\\/g, '/').toLowerCase();
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const median = (a) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const pad = (rows) => { const w = rows[0].map((_, i) => Math.max(...rows.map((r) => String(r[i]).length))); return rows.map((r) => r.map((x, i) => String(x).padEnd(w[i])).join('  ').trimEnd()).join('\n'); };

// ---- variants -------------------------------------------------------------------------------------------------------------

// Worktree with src/prompt.js: assemble() with local-eval (copilot) wording and schema. Otherwise eval/local.js buildPrompt(ctx).
function promptBuilder(worktree) {
  const wt = path.resolve(worktree), pj = path.join(wt, 'src', 'prompt.js'), lj = path.join(wt, 'eval', 'local.js');
  if (fs.existsSync(pj)) {
    const { assemble } = require(pj);
    return (ctxDir) => assemble({ skillDir: path.join(wt, 'skills', 'test-review'), ctxDir, schemaPath: path.join(wt, 'src', 'findings.schema.json'), engine: 'copilot' });
  }
  if (fs.existsSync(lj)) return require(lj).buildPrompt;
  throw new Error(`${wt}: neither src/prompt.js nor eval/local.js found`);
}

function parseVariants(list) {
  const out = (list || []).map((s) => {
    const i = s.indexOf('=');
    if (i < 1) throw new Error(`--variant takes name=dir, got "${s}"`);
    return { name: s.slice(0, i), dir: path.resolve(s.slice(i + 1)) };
  });
  if (!out.length) throw new Error('at least one --variant is required');
  if (new Set(out.map((v) => v.name)).size !== out.length) throw new Error('duplicate variant name');
  return out;
}

// ---- setup ----------------------------------------------------------------------------------------------------------------

// The wrapper the simulated reviewer receives. The first sentence is what eval/token/anatomy.js recognises transcripts by.
function taskText({ promptPath, ctxDir, repo, findingsPath }) {
  return `You are acting as the review model inside a CI code-review Action, run locally and offline.

1. Read the prompt file: ${promptPath}
   Follow it exactly. It is your whole instruction set.
2. Context directory (the prompt's context): ${ctxDir}
3. Checkout of the code under review, shared and read-only: ${repo}
   You may Read, Grep and Glob inside it.

Allowed reads: ONLY the prompt file, files under the context directory, and files under the checkout. Read nothing else on this machine
(no other prompts, results, transcripts, other cases or variants). Do not modify the checkout. Do not run commands that change anything.

Budget: at most 30 turns.

Deliverable: use the Write tool to write the JSON your prompt asks for (JSON only, matching the schema) to:
${findingsPath}
Then reply with one short line.
`;
}

function setup({ src, ids, ab, variants, log = console.log }) {
  if (!src || !ab || !ids?.length) throw new Error('--src, --ids and --ab are required');
  const abDir = path.resolve(ab), manifest = [];
  for (const v of variants) {
    const build = promptBuilder(v.dir);
    for (const id of ids) {
      const sdir = path.resolve(src, id), smeta = path.join(sdir, 'meta.json');
      if (!fs.existsSync(smeta)) throw new Error(`${id}: no ${smeta}`);
      const meta = readJson(smeta), srcCtx = path.join(sdir, 'ctx'), dir = path.join(abDir, v.name, id), ctx = path.join(dir, 'ctx');
      fs.rmSync(ctx, { recursive: true, force: true });
      fs.mkdirSync(dir, { recursive: true });
      fs.cpSync(srcCtx, ctx, { recursive: true, filter: (p) => !/^(findings\.json|engine-status.*)$/.test(path.basename(p)) });
      fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ ...meta, ctx, variant: v.name }, null, 2) + '\n');
      const prompt = build(ctx), promptPath = path.join(dir, 'prompt.md');
      const np = prompt.replace(/\\/g, '/').toLowerCase(); // prompt.js prints forward slashes, local.js native ones
      if (!np.includes(fwd(ctx))) throw new Error(`${v.name}/${id}: prompt does not reference the variant ctx path ${ctx}`);
      for (const stale of [srcCtx, meta.ctx].filter(Boolean)) if (fwd(stale) !== fwd(ctx) && np.includes(fwd(stale))) throw new Error(`${v.name}/${id}: prompt references foreign ctx ${stale}`);
      fs.writeFileSync(promptPath, prompt);
      const taskPath = path.join(dir, 'task.md');
      fs.writeFileSync(taskPath, taskText({ promptPath, ctxDir: ctx, repo: meta.repo, findingsPath: path.join(ctx, 'findings.json') }));
      manifest.push({ variant: v.name, id, promptBytes: Buffer.byteLength(prompt), taskPath, src: sdir });
      log(`${v.name}/${id}: prompt ${Buffer.byteLength(prompt)} bytes`);
    }
  }
  fs.writeFileSync(path.join(abDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}

// ---- finish ---------------------------------------------------------------------------------------------------------------

function loadManifest(ab) {
  const p = path.join(path.resolve(ab), 'manifest.json');
  if (!fs.existsSync(p)) throw new Error(`no manifest.json in ${ab}; run setup first`);
  return readJson(p);
}

async function finishRun(entry, abDir, postRoot) {
  const out = path.join(abDir, entry.variant), dir = path.join(out, entry.id);
  const base = { variant: entry.variant, id: entry.id };
  if (!fs.existsSync(path.join(dir, 'ctx', 'findings.json'))) return { ...base, engine_failed: true };
  const local = require(path.join(postRoot, 'eval', 'local.js')), replay = require(path.join(postRoot, 'eval', 'replay.js'));
  if (fs.existsSync(path.join(postRoot, 'eval', 'cases', entry.id, 'case.json'))) {
    const g = await local.finishOne(entry.id, out);
    const posted = readJson(path.join(dir, 'posted.json')), summary = fs.readFileSync(path.join(dir, 'summary.md'), 'utf8');
    const c = replay.countFindings(posted.comments, summary);
    return { ...base, kind: 'seeded', engine_failed: !!g.engine_failed, pass: g.pass, tp: g.tp, fp: g.fp, fn: g.fn, text: g.text_misses.length, summary: g.summary_misses.length,
      must_not: g.must_not_violations.length, inline: c.inline.total, summary_only: c.summary_only, notes: [...g.missed.map((m) => `FN ${[].concat(m.kind).join('|')}`), ...g.false_positives.map((f) => `FP ${f.kind}`)].join('; ') };
  }
  const r = await replay.finishRealOne(entry.id, out);
  return { ...base, kind: 'real', engine_failed: false, inline: r.inline.total, high: r.inline.byConfidence.high, low: r.inline.byConfidence.low, byKind: r.inline.byKind, summary_only: r.summary_only, pre_existing: r.pre_existing };
}

const cell = (r) => (!r ? '-' : r.error ? 'ERROR' : r.engine_failed ? 'engine failed'
  : r.kind === 'seeded' ? `${r.pass ? 'PASS' : 'FAIL'} tp${r.tp} fp${r.fp} fn${r.fn} t${r.text} s${r.summary} m${r.must_not} | in${r.inline} sum${r.summary_only}`
    : `in${r.inline} (hi${r.high}/lo${r.low}) sum${r.summary_only} pre${r.pre_existing}`);

function totals(results, variants) {
  return variants.map((name) => {
    const rs = results.filter((r) => r.variant === name), ok = rs.filter((r) => !r.error && !r.engine_failed), s = ok.filter((r) => r.kind === 'seeded');
    const sum = (k, a = ok) => a.reduce((t, r) => t + (r[k] || 0), 0);
    return { variant: name, runs: rs.length, engine_failed: rs.filter((r) => r.engine_failed).length, errors: rs.filter((r) => r.error).length,
      seeded: s.length, pass: s.filter((r) => r.pass).length, tp: sum('tp', s), fp: sum('fp', s), fn: sum('fn', s), inline: sum('inline'), summary_only: sum('summary_only') };
  });
}

function report(results, variants) {
  const ids = [...new Set(results.map((r) => r.id))];
  const t1 = pad([['id', ...variants], ...ids.map((id) => [id, ...variants.map((v) => cell(results.find((r) => r.id === id && r.variant === v)))])]);
  const t = totals(results, variants);
  const t2 = pad([['variant', 'seeded pass', 'TP', 'FP', 'FN', 'inline', 'summary', 'engine failed', 'errors'],
    ...t.map((x) => [x.variant, `${x.pass}/${x.seeded}`, x.tp, x.fp, x.fn, x.inline, x.summary_only, x.engine_failed, x.errors])]);
  return { text: `${t1}\n\n${t2}`, totals: t };
}

async function finish({ ab, postRoot = MAIN, log = console.log }) {
  const abDir = path.resolve(ab), manifest = loadManifest(abDir), results = [];
  for (const e of manifest) {
    try { results.push(await finishRun(e, abDir, path.resolve(postRoot))); } catch (err) { results.push({ variant: e.variant, id: e.id, error: String(err.message || err).split('\n')[0] }); }
  }
  const variants = [...new Set(manifest.map((e) => e.variant))], rep = report(results, variants);
  log(rep.text);
  fs.writeFileSync(path.join(abDir, 'results.json'), JSON.stringify({ results, totals: rep.totals }, null, 2) + '\n');
  return { results, totals: rep.totals };
}

// ---- tokens ---------------------------------------------------------------------------------------------------------------

// eval/token/anatomy.js runs its report on load and exports nothing: load everything before its final IIFE as a module.
function loadAnatomy() {
  const file = path.join(__dirname, 'token', 'anatomy.js'), src = fs.readFileSync(file, 'utf8'), cut = src.lastIndexOf('(async () => {');
  if (cut < 0) throw new Error('anatomy.js layout changed: report IIFE not found');
  const m = new Module(file, module);
  m.filename = file; m.paths = Module._nodeModulePaths(path.dirname(file));
  m._compile(`${src.slice(0, cut)}\nmodule.exports = { parse, files };`, file);
  return m.exports;
}

const METRICS = [['turns', 'turns'], ['cum', 'cum input (no cache)'], ['cachedStatic', 'cum input (static-prefix cache)'], ['ctx1', 'first-turn ctx'], ['outTok', 'output tok']];

async function tokens({ ab, transcripts, log = console.log }) {
  const abDir = path.resolve(ab), manifest = loadManifest(abDir), anatomy = loadAnatomy();
  const want = new Map(manifest.map((e) => [fwd(path.join(abDir, e.variant, e.id)), e]));
  const runs = new Map(); // variant/id -> newest matching run
  const list = (transcripts || anatomy.files()).map((f) => ({ f, t: fs.statSync(f).mtimeMs })).sort((a, b) => a.t - b.t);
  for (const { f } of list) {
    let r; try { r = await anatomy.parse(f); } catch { continue; }
    const e = r && want.get(fwd(r.dir));
    if (e) runs.set(`${e.variant}/${e.id}`, { variant: e.variant, id: e.id, ...Object.fromEntries(METRICS.map(([k]) => [k, r[k]])) });
  }
  const variants = [...new Set(manifest.map((e) => e.variant))], all = [...runs.values()];
  const per = variants.map((name) => {
    const rs = all.filter((r) => r.variant === name), o = { variant: name, runs: rs.length };
    for (const [k] of METRICS) { o[`${k}_median`] = median(rs.map((r) => r[k])); o[`${k}_mean`] = Math.round(mean(rs.map((r) => r[k])) * 10) / 10; }
    return o;
  });
  log(pad([['variant', 'runs', ...METRICS.flatMap(([, l]) => [`${l} med`, 'mean'])],
    ...per.map((o) => [o.variant, o.runs, ...METRICS.flatMap(([k]) => [Math.round(o[`${k}_median`]), Math.round(o[`${k}_mean`])])])]));
  // paired: ids completed by both the baseline (first variant) and each other variant
  const paired = [];
  for (const name of variants.slice(1)) {
    const ids = manifest.filter((e) => e.variant === name).map((e) => e.id).filter((id) => runs.has(`${variants[0]}/${id}`) && runs.has(`${name}/${id}`));
    const p = { baseline: variants[0], variant: name, n: ids.length, ids, metrics: {} };
    for (const [k, label] of METRICS) {
      const d = ids.map((id) => runs.get(`${name}/${id}`)[k] - runs.get(`${variants[0]}/${id}`)[k]);
      p.metrics[k] = { mean_delta: Math.round(mean(d) * 10) / 10, deltas: d };
      log(`paired ${name} - ${variants[0]} (n=${ids.length}) ${label}: mean delta ${p.metrics[k].mean_delta}; per id ${ids.map((id, i) => `${id}:${d[i]}`).join(' ')}`);
    }
    paired.push(p);
  }
  const missing = manifest.filter((e) => !runs.has(`${e.variant}/${e.id}`)).map((e) => `${e.variant}/${e.id}`);
  if (missing.length) log(`no transcript (or <2 turns): ${missing.join(', ')}`);
  log('Constant across variants: system prompt, tool schemas, hook context and the task.md wrapper. They are inside the first-turn ctx and re-sent every turn, so'
    + ' differences in cum input come from prompt size and from the turns/tool results the prompt induces. The Read-prompt turn is paid by both. n is small: treat means as hints.');
  const res = { per, paired, missing, runs: all };
  fs.writeFileSync(path.join(abDir, 'tokens.json'), JSON.stringify(res, null, 2) + '\n');
  return res;
}

// ---- cli ------------------------------------------------------------------------------------------------------------------

async function main() {
  const { values: o, positionals } = require('node:util').parseArgs({ allowPositionals: true, options: {
    src: { type: 'string' }, ids: { type: 'string' }, ab: { type: 'string' }, variant: { type: 'string', multiple: true }, 'post-root': { type: 'string' },
    transcripts: { type: 'string' }, help: { type: 'boolean' } } });
  const [cmd] = positionals;
  if (o.help || !['setup', 'finish', 'tokens'].includes(cmd) || !o.ab) { console.log(USAGE); process.exit(o.help ? 0 : 2); }
  if (cmd === 'setup') setup({ src: o.src, ids: (o.ids || '').split(',').map((s) => s.trim()).filter(Boolean), ab: o.ab, variants: parseVariants(o.variant) });
  else if (cmd === 'finish') await finish({ ab: o.ab, postRoot: o['post-root'] || MAIN });
  else await tokens({ ab: o.ab, transcripts: o.transcripts?.split(',') });
}

if (require.main === module) main().catch((e) => { console.error(e.message); process.exit(1); });
module.exports = { promptBuilder, parseVariants, taskText, setup, loadManifest, finishRun, totals, report, finish, loadAnatomy, tokens };
