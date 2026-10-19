// Token anatomy of simulated-reviewer sub-agent transcripts. Streams JSONL, prints aggregates only.
// usage: node eval/token/anatomy.js [--json out.json]
const fs = require('fs'), path = require('path'), readline = require('readline');
const ROOT = path.join(require('os').homedir(), '.claude/projects/C--Files-Projects-SpecGuard');
const REAL = 'a80fb590dff54a5a7 aab25b62e44f4ed2a aedb647b21c11c89a ab23ba140433c65ca a4238c23104343ea3 ae5f28a7a25b06c24'.split(' ');
const HIT = { a80fb590dff54a5a7: 'miss', aab25b62e44f4ed2a: 'hit', aedb647b21c11c89a: 'miss', ab23ba140433c65ca: 'miss', a4238c23104343ea3: 'hit', ae5f28a7a25b06c24: 'hit' };
const T = s => Math.ceil((s || '').length / 4);
const med = a => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.floor((s.length - 1) / 2)]; };
const p90 = a => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.ceil(0.9 * s.length) - 1)]; };
const txt = c => typeof c === 'string' ? c : Array.isArray(c) ? c.map(b => b.text || '').join('') : '';

function files() {
  const out = [];
  for (const d of fs.readdirSync(ROOT)) {
    const sd = path.join(ROOT, d, 'subagents');
    if (fs.existsSync(sd)) for (const f of fs.readdirSync(sd)) if (f.endsWith('.jsonl')) out.push(path.join(sd, f));
  }
  return out;
}
function kind(p) {
  const b = p.replace(/\\/g, '/');
  if (/\/prompt\.md$/.test(b)) return 'prompt';
  if (/\/ctx\/diff\.patch$/.test(b)) return 'ctx_diff';
  if (/\/ctx\/files\.txt$/.test(b)) return 'ctx_files';
  if (/\/ctx\/requirements[^/]*$/.test(b)) return 'ctx_req';
  if (/\/ctx\/trace-candidates[^/]*$/.test(b)) return 'ctx_trace';
  if (/\/ctx\/standards[^/]*$/.test(b)) return 'ctx_std';
  if (/\/ctx\//.test(b)) return 'ctx_other';
  return 'repo';
}
function walk(o, key, acc) {
  if (Array.isArray(o)) { if (!o.length) acc.empty++; o.forEach(x => walk(x, key, acc)); }
  else if (o && typeof o === 'object') for (const k in o) { acc.keys[k] = (acc.keys[k] || 0) + k.length + 4; walk(o[k], k, acc); }
  else if (o != null) acc.keys[key] = (acc.keys[key] || 0) + String(o).length;
}

async function parse(file) {
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  let first = null, id = null; const calls = new Map(); const order = []; const results = new Map();
  for await (const line of rl) {
    if (!line) continue; let o; try { o = JSON.parse(line); } catch { continue; }
    id = id || o.agentId;
    if (!first && o.type === 'user') first = txt(o.message && o.message.content);
    const m = o.message; if (!m) continue;
    if (o.type === 'assistant') {
      const mid = m.id || o.uuid; let c = calls.get(mid);
      if (!c) { c = { usage: null, text: 0, tools: [] }; calls.set(mid, c); order.push(mid); }
      if (m.usage) c.usage = m.usage;
      for (const b of m.content || []) {
        if (b.type === 'text') c.text += (b.text || '').length;
        else if (b.type === 'tool_use') c.tools.push({ id: b.id, name: b.name, input: b.input });
      }
    } else if (o.type === 'user' && Array.isArray(m.content)) {
      for (const b of m.content) if (b.type === 'tool_result') results.set(b.tool_use_id, txt(b.content));
    }
  }
  if (!first || !/review model inside a CI code-review Action/.test(first)) return null;
  const pm = first.match(/(?:^|[\s`'"(])([A-Za-z]:[^\s`'"]*?|[\\/][^\s`'"]*?)[\\/](?:prompt|task)\.md/); // Windows (C:\ or C:/) or POSIX absolute; \ or / separators
  const dir = pm ? pm[1] : ''; const caseName = dir.split(/[\\/]/).pop();
  const turns = order.map(k => calls.get(k)).filter(c => c.usage);
  if (turns.length < 2) return null;
  const ctx = turns.map(c => (c.usage.input_tokens || 0) + (c.usage.cache_read_input_tokens || 0) + (c.usage.cache_creation_input_tokens || 0));
  const outTok = turns.map(c => c.usage.output_tokens || 0);
  const cost = turns.map(c => (c.usage.input_tokens || 0) + 0.1 * (c.usage.cache_read_input_tokens || 0) + 1.25 * (c.usage.cache_creation_input_tokens || 0));
  const tc = {}; const par = []; const reads = []; let write = null; const seen = new Map();
  const items = turns.map(() => []);
  turns.forEach((c, i) => {
    par.push(c.tools.length);
    items[i].push({ src: 'model_own', tok: Math.ceil(c.text / 4) });
    for (const t of c.tools) {
      tc[t.name] = (tc[t.name] || 0) + 1;
      const r = results.get(t.id) || ''; const inp = t.input || {};
      let src;
      if (t.name === 'Read') {
        const p = inp.file_path || ''; const k = kind(p);
        const key = p + '|' + (inp.offset || 0) + '|' + (inp.limit || 0);
        const dup = seen.has(p);
        const exact = !!(seen.get(p) && seen.get(p).has(key));
        if (!seen.has(p)) seen.set(p, new Set()); seen.get(p).add(key);
        reads.push({ turn: i, path: p, k, tok: T(r), dup, exact });
        src = k === 'prompt' ? 'prompt' : k.startsWith('ctx') ? k : 'repo_read';
      } else if (t.name === 'Grep') src = 'grep';
      else if (t.name === 'Glob') { src = 'glob'; reads.push({ turn: i, path: 'GLOB ' + (inp.pattern || ''), k: 'glob', tok: T(r), dup: false }); }
      else if (t.name === 'Write') { src = 'final_json'; write = { tok: T(inp.content), content: inp.content || '', turn: i }; }
      else src = 'other_tool';
      items[i].push({ src: 'model_own', tok: T(JSON.stringify(inp)) - (t.name === 'Write' ? T(inp.content) : 0) });
      if (t.name === 'Write') items[i].push({ src: 'final_json', tok: T(inp.content) });
      else items[i].push({ src, tok: T(r) });
    }
  });
  const N = turns.length; const srcCum = {}; const srcTok = {}; const srcCum4 = {};
  srcCum.base = ctx[0] * N;
  for (let i = 0; i < N - 1; i++) {
    const est = items[i].reduce((a, x) => a + x.tok, 0); const real = ctx[i + 1] - ctx[i];
    const sc = est > 0 && real > 0 ? real / est : 1;
    for (const x of items[i]) { srcCum4[x.src] = (srcCum4[x.src] || 0) + x.tok * (N - 1 - i); const t = x.tok * sc; srcCum[x.src] = (srcCum[x.src] || 0) + t * (N - 1 - i); srcTok[x.src] = (srcTok[x.src] || 0) + t; }
  }
  let fj = null;
  if (write) { try { const j = JSON.parse(write.content); const acc = { keys: {}, empty: 0 }; walk(j, '', acc); fj = { tok: write.tok, keys: acc.keys, empty: acc.empty, raw: write.content }; } catch { fj = { tok: write.tok, keys: {}, empty: 0, raw: write.content }; } }
  const cited = fj ? fj.raw : '';
  const repoReads = reads.filter(r => r.k === 'repo');
  const uncited = repoReads.filter(r => { const b = r.path.replace(/\\/g, '/').split('/').pop(); return !cited.includes(b); });
  const dupR = reads.filter(r => r.dup && r.k !== 'glob');
  const dupCum = dupR.reduce((a, r) => a + r.tok * (N - 1 - r.turn), 0);
  const ctxEmpty = reads.filter(r => r.k.startsWith('ctx_') && r.k !== 'ctx_diff' && r.tok <= 40);
  const firstUseful = reads.find(r => r.k === 'ctx_diff' || r.k === 'repo');
  const globTok = reads.filter(r => r.k === 'glob').reduce((a, r) => a + r.tok, 0);
  const promptRead = reads.find(r => r.k === 'prompt');
  const cum = ctx.reduce((a, b) => a + b, 0);
  const cachedStatic = ctx[0] + ctx.slice(1).reduce((a, c) => a + 0.1 * ctx[0] + (c - ctx[0]), 0);
  return {
    id, caseName, dir, turns: N, tc, par, parMax: Math.max(...par), ctx, ctx1: ctx[0], ctxLast: ctx[N - 1], cum, cachedStatic,
    srcCum4, cost: cost.reduce((a, b) => a + b, 0), outTok: outTok.reduce((a, b) => a + b, 0), srcCum, srcTok,
    fj, nDup: dupR.length, dupCum, nExact: reads.filter(r => r.exact).length,
    uncitedN: uncited.length, uncitedTok: uncited.reduce((a, r) => a + r.tok, 0), repoReadN: repoReads.length, repoReadTok: repoReads.reduce((a, r) => a + r.tok, 0),
    globN: reads.filter(r => r.k === 'glob').length, globTok, ctxEmptyN: ctxEmpty.length, ctxEmpty: ctxEmpty.map(r => r.k),
    turnsBeforeUseful: firstUseful ? firstUseful.turn : N, promptTok: promptRead ? promptRead.tok : 0,
  };
}

(async () => {
  const runs = [];
  for (const f of files()) { try { const r = await parse(f); if (r) runs.push(r); } catch (e) { /* skip */ } }
  const group = r => REAL.includes(r.id) ? 'real' : /^tr\d+/.test(r.caseName) ? 'seeded' : /^(pr|clean|c\d)/i.test(r.caseName) ? 'clean' : 'other';
  runs.forEach(r => r.group = group(r));
  const pct = (x, tot) => (100 * x / tot).toFixed(1) + '%';
  const rows = g => runs.filter(r => g === 'all' || r.group === g);
  console.log('runs parsed:', runs.length, ['real', 'seeded', 'clean', 'other'].map(g => g + '=' + rows(g).length).join(' '));
  console.log('\nper run: id case group turns ctx1 ctxLast cum(k) cachedStatic(k) cost(k) out calls');
  runs.sort((a, b) => a.group.localeCompare(b.group)).forEach(r => console.log(r.id, r.caseName.padEnd(14), r.group.padEnd(6), String(r.turns).padStart(3), String(r.ctx1).padStart(6), String(r.ctxLast).padStart(6), (r.cum / 1e3).toFixed(0).padStart(5), (r.cachedStatic / 1e3).toFixed(0).padStart(5), (r.cost / 1e3).toFixed(0).padStart(5), String(r.outTok).padStart(5), JSON.stringify(r.tc), 'parMax' + r.parMax, 'fj' + (r.fj ? r.fj.tok : '-'), HIT[r.id] || ''));
  for (const g of ['all', 'real', 'seeded', 'clean', 'other']) {
    const R = rows(g); if (!R.length) continue;
    const S = {}; let totCum = 0, totExBase = 0;
    R.forEach(r => { totCum += r.cum; for (const k in r.srcCum) { S[k] = (S[k] || 0) + r.srcCum[k]; if (k !== 'base') totExBase += r.srcCum[k]; } });
    const f = k => med(R.map(r => r[k])), q = k => p90(R.map(r => r[k]));
    console.log(`\n== ${g} (n=${R.length})`);
    console.log(' turns med/p90', f('turns'), q('turns'), '| ctx1 med', f('ctx1'), '| ctxLast med/p90', f('ctxLast'), q('ctxLast'));
    console.log(' cum input tok (no cache) med/p90', f('cum'), q('cum'), '| static-prefix-cached med', Math.round(f('cachedStatic')), '| full-cache cost-equiv med', Math.round(f('cost')));
    console.log(' output tok med', f('outTok'), '| finalJSON tok med/p90', med(R.map(r => r.fj ? r.fj.tok : 0)), p90(R.map(r => r.fj ? r.fj.tok : 0)));
    const tcs = {}; R.forEach(r => { for (const k in r.tc) (tcs[k] = tcs[k] || []).push(r.tc[k]); });
    const nT = R.reduce((a, r) => a + r.turns, 0);
    console.log(' tool calls median per run:', Object.entries(tcs).map(([k, v]) => k + '=' + med(v)).join(' '), '| mean calls/turn', (R.reduce((a, r) => a + r.par.reduce((x, y) => x + y, 0), 0) / nT).toFixed(2), '| share turns w/ >1 call', pct(R.reduce((a, r) => a + r.par.filter(x => x > 1).length, 0), nT));
    console.log(' share of cumulative input (incl. harness base):', Object.entries(S).sort((a, b) => b[1] - a[1]).map(([k, v]) => k + ' ' + pct(v, totCum)).join(', '));
    console.log(' share excluding turn-1 base:', Object.entries(S).filter(([k]) => k !== 'base').sort((a, b) => b[1] - a[1]).map(([k, v]) => k + ' ' + pct(v, totExBase)).join(', '));
    const S4 = {}; let t4 = 0; R.forEach(r => { for (const k in r.srcCum4) { S4[k] = (S4[k] || 0) + r.srcCum4[k]; t4 += r.srcCum4[k]; } });
    console.log(' chars/4 model (no harness base), share of cumulative:', Object.entries(S4).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => k + ' ' + pct(v, t4)).join(', '));
    const byTurn = []; R.forEach(r => r.ctx.forEach((c, i) => (byTurn[i] = byTurn[i] || []).push(c))); console.log(' median ctx by turn:', byTurn.slice(0, 9).map(a => med(a)).join(' '));
    const rd = ['repo_read', 'ctx_diff', 'ctx_files', 'ctx_req', 'ctx_trace', 'ctx_std', 'ctx_other', 'grep', 'glob'].reduce((a, k) => a + (S[k] || 0), 0);
    console.log(' prompt+base share', pct((S.prompt || 0) + (S.base || 0), totCum), '| prompt.md only', pct(S.prompt || 0, totCum), '| all file/grep/glob reads', pct(rd, totCum), '| prompt.md tok med', f('promptTok'));
    const dc = R.reduce((a, r) => a + r.dupCum, 0);
    console.log(' duplicated reads: cum share', pct(dc, totCum), '| runs w/ dup', R.filter(r => r.nDup).length, '| median dup count', med(R.map(r => r.nDup)), '| exact-dup median', med(R.map(r => r.nExact)));
    console.log(' uncited repo reads: median n', med(R.map(r => r.uncitedN)), 'of', med(R.map(r => r.repoReadN)), '| tok share of repo-read tok', pct(R.reduce((a, r) => a + r.uncitedTok, 0), R.reduce((a, r) => a + r.repoReadTok, 0) || 1));
    console.log(' glob calls median', f('globN'), 'glob tok total', R.reduce((a, r) => a + r.globTok, 0), '| runs reading empty ctx files', R.filter(r => r.ctxEmptyN).length, '| turns before first useful read med', f('turnsBeforeUseful'));
    const keys = {}; let kt = 0; const emp = []; R.forEach(r => { if (r.fj) { emp.push(r.fj.empty); for (const k in r.fj.keys) { keys[k] = (keys[k] || 0) + r.fj.keys[k]; kt += r.fj.keys[k]; } } });
    console.log(' final-JSON chars by key:', Object.entries(keys).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, v]) => k + ' ' + pct(v, kt)).join(', '), '| empty arrays med', med(emp));
  }
  const rr = rows('real');
  console.log('\n== real-repo hits vs misses');
  for (const lab of ['hit', 'miss']) {
    const R = rr.filter(r => HIT[r.id] === lab); if (!R.length) continue;
    console.log(lab, R.map(r => `${r.caseName}:turns${r.turns},cum${Math.round(r.cum / 1e3)}k,repoReads${r.repoReadN},out${r.outTok}`).join(' | '));
    console.log('   mean turns', (R.reduce((a, r) => a + r.turns, 0) / R.length).toFixed(1), 'mean cum', Math.round(R.reduce((a, r) => a + r.cum, 0) / R.length / 1e3) + 'k', 'mean repo reads', (R.reduce((a, r) => a + r.repoReadN, 0) / R.length).toFixed(1));
  }
  const ai = process.argv.indexOf('--json');
  if (ai > 0) fs.writeFileSync(process.argv[ai + 1], JSON.stringify(runs.map(r => ({ ...r, fj: r.fj && { tok: r.fj.tok, keys: r.fj.keys, empty: r.fj.empty } })), null, 1));
})();
