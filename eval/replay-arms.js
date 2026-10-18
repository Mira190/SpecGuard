#!/usr/bin/env node
// Offline paired arms for a replay: re-run the REAL src/post.js on the SAME raw model answers (ctx/findings.json) three times, A = EXP_LOWCONF_VISIBLE unset
// (main publisher), V1 = 1, V2 = 2. No model call, no variance between arms. Per PR-run it rebuilds what finishRealOne needs: collect.sh output (the
// ctx and the head checkout, from --repos clones, used read-only through 'git clone --shared'), then overlays the downloaded engine outputs (findings.json,
// engine-notes, engine-model.json, ...). A run without ctx/findings.json cannot be re-run and is reported unusable (never scored as a miss).
// Layout of --dl: <dl>/<run>/<id>/{result.json,summary.md,ctx/...} (a downloaded artifact per workflow run), or <dl>/<id>/... for one run.
const fs = require('node:fs');
const path = require('node:path');
const { prepareReal, finishRealOne, entries } = require('./replay.js');
const { parseSummary } = require('./grade.js');

const readJson = (p, d = null) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return d; } };
const subdirs = (d) => fs.readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);

// [{ run, id, dir }] for every PR-run under dl
function discover(dl) {
  const out = [];
  for (const a of subdirs(dl)) {
    if (fs.existsSync(path.join(dl, a, 'result.json'))) out.push({ run: '0', id: a, dir: path.join(dl, a) });
    else for (const b of subdirs(path.join(dl, a))) if (fs.existsSync(path.join(dl, a, b, 'result.json'))) out.push({ run: a, id: b, dir: path.join(dl, a, b) });
  }
  return out;
}

// '<details>' starts the collapsed part; counts are finding items the grader's parser recognises (labelled bullets under a kind heading or "**Kind:** title `path:line`").
const split = (s) => { const i = s.indexOf('<details>'); return i < 0 ? [s, ''] : [s.slice(0, i), s.slice(i)]; };
const visibleMd = (comments, summary) => `${comments.map((c) => `### inline ${c.path}:${c.line ?? ''}\n\n${c.body}\n`).join('\n')}\n---\n\n${split(summary)[0]}`;

// One arm of one PR-run -> row. `prep` is the shared collect output for this PR (meta.json, ctx, repo).
async function runArm({ pr, prep, arm, out }) {
  const dir = path.join(out, `run${pr.run}-${arm}`, pr.id), ctx = path.join(dir, 'ctx');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  fs.cpSync(path.join(prep, 'ctx'), ctx, { recursive: true });
  for (const f of fs.readdirSync(path.join(pr.dir, 'ctx'))) if (f !== 'counts.json') fs.cpSync(path.join(pr.dir, 'ctx', f), path.join(ctx, f), { recursive: true });
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ ...readJson(path.join(prep, 'meta.json')), ctx }, null, 2));
  const res = readJson(path.join(pr.dir, 'result.json'), {}), saved = process.env.EXP_LOWCONF_VISIBLE;
  if (arm !== 'A') process.env.EXP_LOWCONF_VISIBLE = arm.slice(1); else delete process.env.EXP_LOWCONF_VISIBLE;
  try { await finishRealOne(pr.id, path.join(out, `run${pr.run}-${arm}`), { engine: 'claude', model: res.model || '' }); }
  finally { if (saved === undefined) delete process.env.EXP_LOWCONF_VISIBLE; else process.env.EXP_LOWCONF_VISIBLE = saved; }
  const posted = readJson(path.join(dir, 'posted.json'), { comments: [] }), summary = fs.readFileSync(path.join(dir, 'summary.md'), 'utf8');
  fs.writeFileSync(path.join(dir, 'visible.md'), visibleMd(posted.comments, summary));
  const [vis, det] = split(summary);
  const row = { id: pr.id, run: pr.run, arm, inline_n: posted.comments.length, visible_n: parseSummary(vis).items.length, details_n: parseSummary(det).items.length };
  fs.writeFileSync(path.join(dir, 'row.json'), JSON.stringify(row) + '\n');
  return row;
}

async function score({ dl, repos, out, manifests = [], ids, log = console.log }) {
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
    for (const arm of ['A', 'V1', 'V2']) rows.push(await runArm({ pr, prep, arm, out }));
  }
  fs.writeFileSync(path.join(out, 'rows.json'), JSON.stringify({ rows, unusable }, null, 2) + '\n');
  log(`${rows.length / 2} PR-runs scored, ${unusable.length} unusable`);
  for (const u of unusable) log(`unusable: run ${u.run} ${u.id}: ${u.reason}`);
  return { rows, unusable };
}

const USAGE = `Usage: node eval/replay-arms.js --dl DIR --repos DIR --out DIR [--manifest FILE[,FILE]] [--ids a,b]
  --dl DIR        downloaded replay artifacts: <dl>/<run>/<id>/{result.json,ctx/findings.json,...}
  --repos DIR     clones named like the repo (go-gitea/gitea -> DIR/gitea); used read-only (git clone --shared, checkout in the copy)
  --manifest      holdout json(s) giving each PR's title/body (collect's requirement discovery reads them)
  --out DIR       <out>/run<R>-<A|V1|V2>/<id>/{visible.md,summary.md,posted.json,row.json}, <out>/rows.json = {rows:[{id,run,arm,inline_n,visible_n,details_n}], unusable}`;

if (require.main === module) {
  const { values: o } = require('node:util').parseArgs({ options: { dl: { type: 'string' }, repos: { type: 'string' }, out: { type: 'string' }, manifest: { type: 'string', default: '' }, ids: { type: 'string' }, help: { type: 'boolean' } } });
  if (o.help || !o.dl || !o.repos || !o.out) { console.log(USAGE); process.exit(o.help ? 0 : 2); }
  fs.mkdirSync(o.out, { recursive: true });
  score({ dl: o.dl, repos: o.repos, out: o.out, manifests: o.manifest.split(',').filter(Boolean), ids: o.ids && o.ids.split(',') }).catch((e) => { console.error(e.message); process.exit(1); });
}
module.exports = { discover, score, runArm, split, visibleMd };
