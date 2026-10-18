#!/usr/bin/env node
// Offline paired arms for a replay: re-run the REAL src/post.js on the SAME raw model answers (ctx/findings.json) once per arm. Arm A = no env (main publisher); each --arm NAME=ENV=VALUE adds an arm that sets ENV=VALUE while post.js runs. No model call, no variance between arms. Per PR-run it rebuilds what finishRealOne needs: collect.sh output (the
// ctx and the head checkout, from --repos clones, used read-only through 'git clone --shared'), then overlays the downloaded engine outputs (findings.json,
// engine-notes, engine-model.json, ...). A run without ctx/findings.json cannot be re-run and is reported unusable (never scored as a miss).
// Layout of --dl: <dl>/<run>/<id>/{result.json,summary.md,ctx/...} (a downloaded artifact per workflow run), or <dl>/<id>/... for one run.
const fs = require('node:fs');
const path = require('node:path');
const { prepareReal, finishRealOne, entries } = require('./replay.js');
const { parseSummary } = require('./grade.js');
const api = require('../src/engines/claude-api.js');

const readJson = (p, d = null) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return d; } };
const subdirs = (d) => fs.readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);

// [{ run, id, dir }] for every PR-run under dl
function discover(dl) {
  const out = [];
  for (const a of subdirs(dl)) {
    if (fs.existsSync(path.join(dl, a, 'result.json'))) out.push({ run: '0', id: a.replace(/^replay-/, ''), dir: path.join(dl, a) });
    else for (const b of subdirs(path.join(dl, a))) if (fs.existsSync(path.join(dl, a, b, 'result.json'))) out.push({ run: a, id: b.replace(/^replay-/, ''), dir: path.join(dl, a, b) });
  }
  return out;
}

// '<details>' starts the collapsed part; counts are finding items the grader's parser recognises (labelled bullets under a kind heading or "**Kind:** title `path:line`").
// ['V1=EXP_X=1', ...] -> [{ name, env, value }]; names unique and not 'A'
function parseArms(list = []) {
  const arms = list.map((a) => { const m = /^([\w-]+)=([A-Za-z_]\w*)=(.*)$/.exec(a); if (!m) throw new Error(`bad --arm ${a} (want NAME=ENV=VALUE)`); return { name: m[1], env: m[2], value: m[3] }; });
  if (new Set(['A', ...arms.map((a) => a.name)]).size !== arms.length + 1) throw new Error('--arm names must be unique and not A');
  return arms;
}

const split = (s) => { const i = s.indexOf('<details>'); return i < 0 ? [s, ''] : [s.slice(0, i), s.slice(i)]; };
const visibleMd = (comments, summary) => `${comments.map((c) => `### inline ${c.path}:${c.line ?? ''}\n\n${c.body}\n`).join('\n')}\n---\n\n${split(summary)[0]}`;

// The REAL src/engines/claude-api.js on the prepared ctx and checkout, only HTTP mocked: the Messages API answers with the saved model answer (ctx/findings.json) and the saved usage,
// so the engine itself writes pack-cut.txt, pack-shown.txt, engine-notes, engine-model.json, usage.json. Same env as replay.js runEngine. Returns the number of API calls made.
async function mockEngine({ pr, prep, ctx, res }) {
  const answer = fs.readFileSync(path.join(pr.dir, 'ctx', 'findings.json'), 'utf8'), m = Object.values(res.usage?.metrics || {})[0]?.usage || {};
  let calls = 0;
  const fetchFn = async () => {
    calls++;
    const body = { type: 'message', model: res.model || 'claude-haiku-5-5', stop_reason: 'end_turn', content: [{ type: 'text', text: answer }],
      usage: { input_tokens: Math.max(0, (m.inputTokens || 0) - (m.cacheReadTokens || 0) - (m.cacheWriteTokens || 0)), cache_read_input_tokens: m.cacheReadTokens || 0, cache_creation_input_tokens: m.cacheWriteTokens || 0, output_tokens: m.outputTokens || 0 } };
    return { status: 200, ok: true, headers: { get: () => null }, text: async () => JSON.stringify(body) };
  };
  const log = console.log; console.log = () => {};
  try {
    await api.run({ GITHUB_WORKSPACE: path.join(prep, 'repo'), CTX: ctx, PROMPT_FILE: path.join(prep, 'prompt.md'), ANTHROPIC_API_KEY: 'sk-ant-offline-mock', MODEL: res.model || 'claude-haiku-5-5', MAX_BUDGET_USD: '1.00', MAX_OUTPUT_TOKENS: '32000', TIMEOUT: '12' }, { fetchFn, sleep: async () => {} });
  } finally { console.log = log; }
  return calls;
}

// One arm of one PR-run -> row. `prep` is the shared collect output for this PR (meta.json, ctx, repo).
async function runArm({ pr, prep, arm: spec, out, engine = 'saved', log = console.log }) {
  const arm = spec.name, dir =path.join(out, `run${pr.run}-${arm}`, pr.id), ctx = path.join(dir, 'ctx');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  fs.cpSync(path.join(prep, 'ctx'), ctx, { recursive: true });
  const res = readJson(path.join(pr.dir, 'result.json'), {});
  if (engine === 'mock-replay') { // the engine runs once per PR-run (arm A); the other arms start from its ctx
    if (arm !== 'A') fs.cpSync(path.join(out, `run${pr.run}-A`, pr.id, 'ctx'), ctx, { recursive: true });
    else if ((await mockEngine({ pr, prep, ctx, res })) !== 1) log(`note: ${pr.id} run ${pr.run}: the engine made a call count other than 1 (repair or failure)`);
  } else for (const f of fs.readdirSync(path.join(pr.dir, 'ctx'))) if (f !== 'counts.json') fs.cpSync(path.join(pr.dir, 'ctx', f), path.join(ctx, f), { recursive: true });
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ ...readJson(path.join(prep, 'meta.json')), ctx }, null, 2));
  const saved = spec.env && process.env[spec.env];
  if (spec.env) process.env[spec.env] = spec.value;
  try { await finishRealOne(pr.id, path.join(out, `run${pr.run}-${arm}`), { engine: 'claude', model: res.model || '' }); }
  finally { if (spec.env) { if (saved === undefined) delete process.env[spec.env]; else process.env[spec.env] = saved; } }
  const posted = readJson(path.join(dir, 'posted.json'), { comments: [] }), summary = fs.readFileSync(path.join(dir, 'summary.md'), 'utf8');
  fs.writeFileSync(path.join(dir, 'visible.md'), visibleMd(posted.comments, summary));
  const [vis, det] = split(summary);
  const row = { id: pr.id, run: pr.run, arm, inline_n: posted.comments.length, visible_n: parseSummary(vis).items.length, details_n: parseSummary(det).items.length };
  fs.writeFileSync(path.join(dir, 'row.json'), JSON.stringify(row) + '\n');
  return row;
}

async function score({ dl, repos, out, manifests = [], ids, engine = 'saved', arms = [], log = console.log }) {
  const meta = new Map(manifests.flatMap((m) => entries(m)).map((e) => [e.id, e])), rows = [], unusable = [];
  for (const pr of discover(dl).filter((p) => !ids || ids.includes(p.id))) {
    const res = readJson(path.join(pr.dir, 'result.json'), {});
    const why = !fs.existsSync(path.join(pr.dir, 'ctx', 'findings.json')) ? 'no ctx/findings.json (raw answer not kept; cannot re-run post.js)' : res.valid === false || res.invalid_reason ? `invalid replay: ${res.invalid_reason}` : null;
    if (why) { unusable.push({ id: pr.id, run: pr.run, reason: why }); continue; }
    const e = meta.get(pr.id), repoDir = path.join(repos, path.basename(res.repo || ''));
    if (!e) log(`warning: ${pr.id}: no manifest entry; PR title/body empty, requirement discovery may differ from the real run`);
    if (!fs.existsSync(repoDir)) { unusable.push({ id: pr.id, run: pr.run, reason: `no clone at ${repoDir}` }); continue; }
    const prep = path.join(out, '_prep', pr.id);
    if (readJson(path.join(prep, 'meta.json'))?.head !== res.head) prepareReal({ repoDir, base: res.base, head: res.head, prTitle: e?.title || '', prBody: e?.body || '', out: path.join(out, '_prep'), id: pr.id, trace: res.trace || 'auto', shared: true });
    for (const arm of [{ name: 'A' }, ...arms]) rows.push(await runArm({ pr, prep, arm, out, engine, log }));
  }
  fs.writeFileSync(path.join(out, 'rows.json'), JSON.stringify({ rows, unusable }, null, 2) + '\n');
  log(`${rows.length / (arms.length + 1)} PR-runs scored, ${unusable.length} unusable`);
  for (const u of unusable) log(`unusable: run ${u.run} ${u.id}: ${u.reason}`);
  return { rows, unusable };
}

const USAGE = `Usage: node eval/replay-arms.js --dl DIR --repos DIR --out DIR [--manifest FILE[,FILE]] [--ids a,b] [--arm NAME=ENV=VALUE]...
  --arm N=E=V     extra arm N: env E=V is set while post.js runs (repeatable; arm A, no env, always runs first)
  --dl DIR        downloaded replay artifacts: <dl>/<run>/<id>/{result.json,ctx/findings.json,...}
  --repos DIR     clones named like the repo (go-gitea/gitea -> DIR/gitea); used read-only (git clone --shared, checkout in the copy)
  --manifest      holdout json(s) giving each PR's title/body (collect's requirement discovery reads them)
  --engine MODE   saved (default: overlay the downloaded engine outputs) | mock-replay (run the real claude-api.js, HTTP mocked with the saved answer; writes pack-cut/pack-shown itself)
  --out DIR       (keep it short on Windows) <out>/run<R>-<NAME>/<id>/{visible.md,summary.md,posted.json,row.json}, <out>/rows.json = {rows:[{id,run,arm,inline_n,visible_n,details_n}], unusable}`;

if (require.main === module) {
  const { values: o } = require('node:util').parseArgs({ options: { dl: { type: 'string' }, repos: { type: 'string' }, out: { type: 'string' }, manifest: { type: 'string', default: '' }, ids: { type: 'string' }, arm: { type: 'string', multiple: true, default: [] }, engine: { type: 'string', default: 'saved' }, help: { type: 'boolean' } } });
  if (o.help || !o.dl || !o.repos || !o.out) { console.log(USAGE); process.exit(o.help ? 0 : 2); }
  fs.mkdirSync(o.out, { recursive: true });
  score({ dl: o.dl, repos: o.repos, out: o.out, manifests: o.manifest.split(',').filter(Boolean), ids: o.ids && o.ids.split(','), engine: o.engine, arms: parseArms(o.arm) }).catch((e) => { console.error(e.message); process.exit(1); });
}
module.exports = { parseArms, discover, score, runArm, split, visibleMd };
