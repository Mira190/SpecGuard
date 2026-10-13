#!/usr/bin/env node
// Engine A/B: the same prepared eval cases through the Copilot CLI engine (src/copilot-run.sh: JSON in prose + repair turn) and the Copilot SDK engine
// (src/copilot-sdk-run.js: submit_review tool call), then graded with eval/local.js's finish logic (the real post.js on a fake GitHub).
// Uses the local Copilot login; each engine run costs real AI credits, so the default is 5 cases x 2 engines x 1 run.
//   node eval/engine-ab.js --out DIR [--case l1,t3,r1,s1,tr1] [--model auto] [--timeout 10] [--engines cli,sdk] [--cli-bin DIR] [--sdk-modules DIR] [--json]
// --cli-bin: directory holding a real `copilot` (e.g. <npm prefix>/node_modules/.bin); --sdk-modules: node_modules dir that holds @github/copilot-sdk.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { prepare, finishOne } = require('./local.js');

const ROOT = path.join(__dirname, '..');
const fwd = (p) => path.resolve(p).replace(/\\/g, '/');
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const readText = (f) => { try { return fs.readFileSync(f, 'utf8').trim(); } catch { return ''; } };

// What one engine run left in its ctx, reduced to the comparison columns. `usable` = findings.json parses and passes post.js's validator.
function summarize(ctx, engine, ms) {
  const { validate } = require('../src/post.js');
  const findings = readJson(path.join(ctx, 'findings.json'));
  let usable = false;
  if (findings && typeof findings === 'object') try { usable = !!validate(findings).ok; } catch { /* not usable */ }
  const credits = ['usage.json', 'usage-repair.json'].reduce((s, f) => s + ((readJson(path.join(ctx, f))?.totalNanoAiu || 0) / 1e9), 0);
  const status = readText(path.join(ctx, 'engine-status')), repair = readText(path.join(ctx, 'engine-repair'));
  let firstTry;
  if (engine === 'sdk') { const l = readJson(path.join(ctx, 'sdk-run.json')); firstTry = !!l && l.followups === 0 && l.submits?.[0]?.ok === true; }
  else firstTry = usable && !repair && !status; // the CLI wrote no repair note: its first answer was already usable
  const model = readJson(path.join(ctx, 'engine-model.json'))?.used?.join(',') || readJson(path.join(ctx, 'usage.json'))?.currentModel || '';
  return { engine, ms, first_try: firstTry, usable, repair: repair || null, status: status || null, credits: Math.round(credits * 1000) / 1000, model };
}

// Windows cannot pass a prompt over ~32k chars as one process argument (copilot -p fails with "Argument list too long"). This PATH shim hands a long
// -p text to the real CLI on stdin instead (same non-interactive run and same prompt text, so auto-routing sees the same input). Linux (Actions) needs
// no shim. Short prompts (the repair turn) pass through unchanged.
const SHIM = (real) => `#!/usr/bin/env bash
REAL="${real}"
args=(); p=''; have=0
while [ $# -gt 0 ]; do if [ "$1" = -p ]; then p="$2"; have=1; shift 2; else args+=("$1"); shift; fi; done
if [ $have = 1 ] && [ \${#p} -gt 30000 ]; then printf '%s' "$p" | "$REAL" "\${args[@]}"; else "$REAL" -p "$p" "\${args[@]}"; fi
`;
function shim(outDir, cliBin) {
  const dir = path.join(outDir, 'shim');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'copilot'), SHIM(fwd(path.join(cliBin, 'copilot'))), { mode: 0o755 });
  return fwd(dir);
}

function runEngine({ engine, dir, id, model, timeout, cliBin, sdkModules }) {
  const repo = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')).repo, ctx = path.join(dir, 'ctx');
  const prompt = fs.readFileSync(path.join(dir, 'prompt.md'), 'utf8');
  const env = { ...process.env, CTX: fwd(ctx), PROMPT: prompt, MODEL: model, EFFORT: '', MAX_CREDITS: '60', TIMEOUT: String(timeout), FAST_MODELS: '', MSYS2_ENV_CONV_EXCL: 'PROMPT' };
  if (cliBin) env.PATH = shim(path.dirname(dir), cliBin) + path.delimiter + cliBin + path.delimiter + env.PATH;
  if (sdkModules) env.NODE_PATH = sdkModules + (process.env.NODE_PATH ? path.delimiter + process.env.NODE_PATH : '');
  const [cmd, args] = engine === 'sdk' ? ['node', [fwd(path.join(ROOT, 'src', 'copilot-sdk-run.js'))]] : ['bash', [fwd(path.join(ROOT, 'src', 'copilot-run.sh'))]];
  const t0 = Date.now();
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '';
    p.stdout.on('data', (d) => { log += d; }); p.stderr.on('data', (d) => { log += d; });
    p.on('error', (e) => { log += String(e); });
    p.on('close', () => { fs.writeFileSync(path.join(dir, `${engine}.log`), log); resolve(Date.now() - t0); });
    setTimeout(() => p.kill(), (timeout + 2) * 60000).unref(); // the engines own their limits; this only keeps a wedged child from hanging the harness
  }).then((ms) => ({ id, ...summarize(ctx, engine, ms) }));
}

function table(rows) {
  const head = ['case', 'engine', 'first-try', 'usable', 'TP', 'FP', 'FN', 'pass', 'secs', 'credits', 'notes'];
  const body = rows.map((r) => [r.id, r.engine, r.first_try ? 'yes' : 'no', r.usable ? 'yes' : 'no', r.tp ?? '', r.fp ?? '', r.fn ?? '', r.pass === undefined ? '' : r.pass ? 'PASS' : 'FAIL', Math.round(r.ms / 1000), r.credits.toFixed(3),
    [r.repair && `repair:${r.repair}`, r.status, r.error, r.model].filter(Boolean).join(' ')]);
  const w = head.map((h, i) => Math.max(h.length, ...body.map((b) => String(b[i]).length)));
  const fmt = (r) => r.map((x, i) => String(x).padEnd(w[i])).join('  ').trimEnd();
  const out = [fmt(head), ...body.map(fmt), ''];
  for (const e of [...new Set(rows.map((r) => r.engine))]) {
    const rs = rows.filter((r) => r.engine === e), n = rs.length, sum = (k) => rs.reduce((s, r) => s + (r[k] || 0), 0);
    out.push(`${e}: first-try ${rs.filter((r) => r.first_try).length}/${n}, usable ${rs.filter((r) => r.usable).length}/${n}, pass ${rs.filter((r) => r.pass).length}/${n}, TP ${sum('tp')} FP ${sum('fp')} FN ${sum('fn')}, ${Math.round(sum('ms') / 1000 / n)}s avg, ${(sum('credits') / n).toFixed(3)} credits avg`);
  }
  return out.join('\n');
}

async function main() {
  const { values: o } = require('node:util').parseArgs({ options: {
    case: { type: 'string', default: 'l1,t3,r1,s1,tr1' }, out: { type: 'string' }, model: { type: 'string', default: 'auto' }, timeout: { type: 'string', default: '10' },
    engines: { type: 'string', default: 'cli,sdk' }, 'cli-bin': { type: 'string' }, 'sdk-modules': { type: 'string' }, json: { type: 'boolean' } } });
  if (!o.out) { console.error('Usage: node eval/engine-ab.js --out DIR [--case ids] [--model auto] [--timeout 10] [--engines cli,sdk] [--cli-bin DIR] [--sdk-modules DIR] [--json]'); process.exit(2); }
  const out = path.resolve(o.out), engines = o.engines.split(','), ids = o.case.split(',');
  prepare({ cases: o.case, out: path.join(out, 'prep') });
  const rows = [];
  for (const id of ids) {
    const runs = engines.map((engine) => {
      const dir = path.join(out, engine, id);
      fs.rmSync(dir, { recursive: true, force: true });
      fs.cpSync(path.join(out, 'prep', id), dir, { recursive: true, filter: (s) => path.basename(s) !== 'repo' }); // the repo stays shared (read-only for the model)
      return runEngine({ engine, dir, id, model: o.model, timeout: Number(o.timeout), cliBin: o['cli-bin'], sdkModules: o['sdk-modules'] });
    });
    for (const r of await Promise.all(runs)) { // both engines of a case run at once; grading is sequential (post.js reads process.env)
      try {
        const g = await finishOne(id, path.join(out, r.engine));
        Object.assign(r, { tp: g.tp, fp: g.fp, fn: g.fn, pass: g.pass });
      } catch (e) { r.error = String(e.message || e).split('\n')[0].slice(0, 60); }
      rows.push(r);
      console.error(`${id} ${r.engine}: ${r.usable ? 'usable' : 'unusable'} ${Math.round(r.ms / 1000)}s`);
    }
  }
  console.log(table(rows));
  if (o.json) fs.writeFileSync(path.join(out, 'engine-ab.json'), JSON.stringify(rows, null, 2) + '\n');
}

if (require.main === module) main().catch((e) => { console.error(e.message); process.exit(1); });
module.exports = { summarize, table };
