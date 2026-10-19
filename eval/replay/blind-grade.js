#!/usr/bin/env node
// Blind semantic grade of holdout 2: how often does a blind grader call "caught" when the findings come from a DIFFERENT PR of the same repo?
// usage: node blind-grade.js --pairs F --raw DIR --runs a,b,c --audit F --fixdiff DIR --fixshas F --repos DIR --out DIR [--run] [--budget 5]
//   --raw DIR holds <run>/replay-<replay_id>/result.json; --runs lists the run ids for reps 1..n in order; --fixdiff DIR holds <replay_id>.diff
//   (a missing one is rebuilt with read-only `git diff <fix>^1 <fix>` in --repos/<name>, shas from --fixshas). --out gets items.json, prompts/<item>.txt, estimate.json.
//   Default is a DRY RUN: renders every prompt and prints the cost estimate, no API call. --run makes paid calls (needs ANTHROPIC_API_KEY in the environment; the key is never printed or written).
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const SEED = 20261020, DIFF_CAP = 20000, OUT_EST = 150, MAX_TOKENS = 400, SONNET = 'claude-sonnet-5-5', HAIKU = 'claude-haiku-5-5', SONNET_LIMIT = 3.5;
const PERMS = 10000;
const API = () => require(path.join(__dirname, '..', '..', 'src', 'engines', 'claude-api.js')); // cost() and PRICES: the same card SpecGuard bills with

// mulberry32 seeded rng
const rng = (seed) => { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };
const shuffle = (a, r) => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

// blinding: no PR/issue references, no GitHub URLs; file paths and lines stay
const strip = (s) => String(s ?? '').replace(/https?:\/\/(?:www\.)?github\.com\/\S+/gi, '[link]').replace(/\b(?:PR|pull request|issue)s?\s*#?\d+/gi, '[ref]').replace(/#\d+/g, '[ref]');

// the diff is code, so only explicit references go (a bare #123 may be a colour or a macro)
const stripDiff = (s) => String(s).replace(/https?:\/\/(?:www\.)?github\.com\/\S+/gi, '[link]').replace(/\b(?:PR|pull request|issue)s?\s*#?\d+/gi, '[ref]').replace(/\(#\d+\)/g, '([ref])');

// Y for each pair of one repo: seeded derangement, never itself; prefers a Y with another fix PR, and relaxes that (reported) when no such derangement exists
function derange(group, r) {
  for (const strict of [true, false]) for (let t = 0; t < 10000; t++) {
    const p = shuffle(group, r);
    if (group.every((x, i) => x.id !== p[i].id && (!strict || x.fix.number !== p[i].fix.number))) return { map: Object.fromEntries(group.map((x, i) => [x.id, p[i]])), relaxed: !strict };
  }
  return null;
}

function loadFindings(raw, run, pair) {
  const j = JSON.parse(fs.readFileSync(path.join(raw, run, `replay-${pair.replay_id}`, 'result.json'), 'utf8'));
  return j.findings || [];
}

function loadDiff(o, pair) {
  const f = path.join(o.fixdiff, `${pair.replay_id}.diff`);
  if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8');
  const sha = JSON.parse(fs.readFileSync(o.fixshas, 'utf8'))[pair.id];
  return execFileSync('git', ['-C', path.join(o.repos, pair.repo.split('/')[1]), 'diff', `${sha}^1`, sha], { encoding: 'utf8', maxBuffer: 1 << 28 });
}

const cutDiff = (d) => {
  d = stripDiff(d.replace(/\r\n/g, '\n'));
  if (d.length <= DIFF_CAP) return { text: d, note: `The complete fix diff (${d.length} characters).` };
  const c = d.slice(0, d.lastIndexOf('\n', DIFF_CAP) + 1 || DIFF_CAP);
  return { text: c, note: `The fix diff, cut to its first ${c.length} of ${d.length} characters at a line boundary (same cap of ${DIFF_CAP} for every item); the rest is not shown.` };
};

const bugText = (card) => ['behaviour', 'trigger', 'region', 'test_gap'].filter((k) => card[k]).map((k) => `${k}: ${strip(card[k])}`).join('\n'); // bug_fix_pr is not shown
const findingsText = (fs_) => (fs_.length ? fs_.map((f, i) => `${i + 1}. ${f.path}:${f.line ?? '?'} | ${f.kind} | confidence: ${f.confidence ?? 'none'} | ${strip(f.title)}${f.why ? `\n   ${strip(f.why)}` : ''}`).join('\n') : '(no findings)');

function render(template, card, diffRaw, findings) {
  const d = cutDiff(diffRaw);
  return template.replace('{{BUG}}', () => bugText(card)).replace('{{DIFF_NOTE}}', () => d.note).replace('{{DIFF}}', () => d.text).replace('{{FINDINGS}}', () => findingsText(findings));
}

// what must not appear in a prompt: pair ids, PR references to the introducing or fix PR, commit shas
function leaks(prompt, pairs) {
  const bad = [];
  for (const p of pairs) {
    if (prompt.includes(p.id)) bad.push(p.id);
    for (const n of [p.fix.number, p.introducing.number]) if (new RegExp(`(?:#|pull/|\\b(?:PR|pull request|issue)\\s*#?)${n}\\b`, 'i').test(prompt)) bad.push(`ref ${n}`);
    for (const s of [p.introducing.merge_commit, p.introducing.base, p.introducing.head]) if (s && prompt.includes(s.slice(0, 7))) bad.push(`sha ${s.slice(0, 7)}`);
  }
  return bad;
}

function build(o) {
  const pairsAll = JSON.parse(fs.readFileSync(o.pairs, 'utf8')).pairs.filter((p) => p.replay_eligible);
  const fixshas = fs.existsSync(o.fixshas) ? JSON.parse(fs.readFileSync(o.fixshas, 'utf8')) : {};
  for (const p of pairsAll) if (fixshas[p.id]) p.fix.sha = fixshas[p.id];
  const template = fs.readFileSync(o.template, 'utf8'), runs = o.runs.split(','), r = rng(SEED);
  const byRepo = {};
  for (const p of pairsAll) (byRepo[p.repo] ||= []).push(p);
  const dropped = { repos: [], pairs: 0, items: 0, same_fix_relaxed: [] }, pairs = [], Y = {};
  for (const [repo, g] of Object.entries(byRepo).sort()) {
    const d = g.length > 1 ? derange(g, r) : null;
    if (!d) { dropped.repos.push(repo); dropped.pairs += g.length; dropped.items += g.length * runs.length * 2; continue; }
    Object.assign(Y, d.map); pairs.push(...g); if (d.relaxed) dropped.same_fix_relaxed.push(repo);
  }
  const raw = [];
  for (const p of pairs) runs.forEach((run, i) => {
    raw.push({ kind: 'real', pair: p, y: p, rep: i + 1, run }, { kind: 'mismatched', pair: p, y: Y[p.id], rep: i + 1, run });
  });
  const shuffled = shuffle(raw, r), items = [], prompts = {};
  shuffled.forEach((x, i) => {
    const id = `item-${String(i + 1).padStart(3, '0')}`;
    const prompt = render(template, x.pair.bug_card, loadDiff(o, x.pair), loadFindings(o.raw, x.run, x.y));
    const bad = leaks(prompt, pairsAll);
    if (bad.length) throw new Error(`${id} leaks ${bad.join(', ')}`);
    prompts[id] = prompt;
    items.push({ id, arm: x.kind, pair: x.pair.id, replay_id: x.pair.replay_id, repo: x.pair.repo, rep: x.rep, findings_from: x.y.id });
  });
  return { items, prompts, dropped, template };
}

const tokens = (s) => Math.ceil(s.length / 4); // chars/4
function estimate(prompts, items) {
  const { PRICES } = API(), tin = Object.values(prompts).reduce((a, p) => a + tokens(p), 0), tout = OUT_EST * items.length;
  const usd = (m) => (tin * PRICES[m].in + tout * PRICES[m].out) / 1e6;
  const per = Object.fromEntries(items.map((it) => [it.id, tokens(prompts[it.id])]));
  const sonnet = usd(SONNET), haiku = usd(HAIKU), model = sonnet <= SONNET_LIMIT ? SONNET : HAIKU;
  return { method: 'chars/4 for input; output assumed 150 tokens per call; list prices from PRICES in src/engines/claude-api.js', input_tokens: tin, output_tokens: tout, usd_sonnet: sonnet, usd_haiku: haiku, model, reason: `${SONNET} estimate $${sonnet.toFixed(3)} ${sonnet <= SONNET_LIMIT ? '<=' : '>'} $${SONNET_LIMIT.toFixed(2)} limit${sonnet <= SONNET_LIMIT ? '' : `, so ${HAIKU} ($${haiku.toFixed(3)})`}`, per_item_tokens: per };
}

const parseGrade = (t) => {
  try {
    const m = /\{[\s\S]*\}/.exec(t), j = JSON.parse(m ? m[0] : t);
    if (['direct', 'indirect', 'miss'].includes(j.grade) && typeof j.why === 'string' && (j.finding === null || Number.isInteger(j.finding))) return j;
  } catch { /* invalid */ }
  return null;
};

async function callModel(model, prompt, key, fetchFn = fetch) {
  const res = await fetchFn('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, body: JSON.stringify({ model, max_tokens: MAX_TOKENS, temperature: 0, messages: [{ role: 'user', content: prompt }] }) });
  const j = await res.json();
  if (!res.ok) throw new Error(`HTTP ${res.status} ${j.error?.type || ''}`); // body not echoed: nothing from the request is logged
  return { text: (j.content || []).filter((b) => b.type === 'text').map((b) => b.text).join(''), usage: j.usage || {} };
}

async function runAll(o, b, est, deps = {}) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key && !deps.call) throw new Error('ANTHROPIC_API_KEY is not set');
  const call = deps.call || ((p) => callModel(est.model, p, key)), { cost, PRICES } = API(), cap = o.budget;
  const dir = path.join(o.out, 'results');
  fs.mkdirSync(dir, { recursive: true });
  const rows = [];
  let spent = 0, stopped = null;
  for (const it of b.items) {
    const f = path.join(dir, `${it.id}.json`);
    if (fs.existsSync(f)) { const x = JSON.parse(fs.readFileSync(f, 'utf8')); spent += x.usd; rows.push(x); continue; } // resume
    const p = b.prompts[it.id], at = (tokens(p) * PRICES[est.model].in + OUT_EST * PRICES[est.model].out) / 1e6;
    let res = null, usd = 0, tries = 0, used = est.model, text = '';
    while (tries < 2 && !res) {
      if (spent + usd + at > cap) { stopped = it.id; break; }
      const r = await call(p); tries++;
      usd += cost(est.model, r.usage); text = r.text; res = parseGrade(r.text);
    }
    if (stopped) break;
    spent += usd;
    const row = { id: it.id, grade: res ? res.grade : 'ungradable', finding: res?.finding ?? null, why: res?.why ?? null, tries, usd, model: used, raw: res ? undefined : text.slice(0, 2000) };
    fs.writeFileSync(f, JSON.stringify(row, null, 1));
    rows.push(row);
  }
  return { rows, spent, stopped, ungraded: b.items.filter((it) => !rows.some((r) => r.id === it.id)).map((it) => it.id) };
}

const caught = (g) => g === 'direct' || g === 'indirect';
function analyse(items, rows, audit, runs) {
  const grade = Object.fromEntries(rows.map((r) => [r.id, r.grade]));
  const by = {};
  for (const it of items) { const k = `${it.pair}|${it.rep}`; (by[k] ||= {})[it.arm] = it; }
  const full = Object.values(by).filter((x) => x.real && x.mismatched && grade[x.real.id] && grade[x.mismatched.id]); // both arms graded
  const rate = (a) => (a.length ? a.filter(caught).length / a.length : null);
  const R = full.map((x) => caught(grade[x.real.id])), M = full.map((x) => caught(grade[x.mismatched.id]));
  const re = rate(R.map((c) => (c ? 'direct' : 'miss'))), mi = rate(M.map((c) => (c ? 'direct' : 'miss')));
  // permutation: within each repo swap real/mismatched labels across that repo's graded items
  const rg = {};
  full.forEach((x, i) => (rg[x.real.repo] ||= []).push(R[i], M[i]));
  const r = rng(SEED), obs = re - mi; let ge = 0;
  for (let t = 0; t < PERMS; t++) {
    let a = 0, c = 0, n = 0;
    for (const v of Object.values(rg)) { const s = shuffle(v, r), h = v.length / 2; for (let i = 0; i < v.length; i++) { if (i < h) { if (s[i]) a++; } else if (s[i]) c++; } n += h; }
    if ((a - c) / n >= obs - 1e-12) ge++;
  }
  const repos = {};
  full.forEach((x, i) => { const g = (repos[x.real.repo] ||= { n: 0, real: 0, mismatched: 0 }); g.n++; g.real += R[i] ? 1 : 0; g.mismatched += M[i] ? 1 : 0; });
  // descriptive: blind real grade vs audit.json grade (audit rows keyed by replay id and rep)
  let agree = 0, nA = 0;
  for (const x of full) {
    const a = audit.find((e) => e.id === x.real.replay_id && e.rep === x.real.rep);
    if (a) { nA++; if (caught(a.new_grade) === caught(grade[x.real.id])) agree++; }
  }
  return { pairs_used: full.length, real_catch_rate: re, false_catch_rate: mi, difference: obs, p_one_sided: (ge + 1) / (PERMS + 1), permutations: PERMS, per_repo: repos, audit_agreement: nA ? { n: nA, agree, share: agree / nA } : null, ungradable: rows.filter((r) => r.grade === 'ungradable').length };
}

async function main() {
  const { values: v } = require('node:util').parseArgs({ options: { pairs: { type: 'string' }, raw: { type: 'string' }, runs: { type: 'string' }, audit: { type: 'string' }, fixdiff: { type: 'string' }, fixshas: { type: 'string' }, repos: { type: 'string' }, out: { type: 'string' }, template: { type: 'string', default: path.join(__dirname, 'blind-grade-prompt.md') }, run: { type: 'boolean', default: false }, 'dry-run': { type: 'boolean', default: true }, budget: { type: 'string', default: '5' } } });
  const o = { ...v, budget: parseFloat(v.budget) };
  for (const k of ['pairs', 'raw', 'runs', 'audit', 'fixdiff', 'fixshas', 'out']) if (!o[k]) { console.error(`missing --${k}; see the header of this file`); process.exit(2); }
  const b = build(o), est = estimate(b.prompts, b.items), counts = { real: b.items.filter((i) => i.arm === 'real').length, mismatched: b.items.filter((i) => i.arm === 'mismatched').length };
  fs.mkdirSync(path.join(o.out, 'prompts'), { recursive: true });
  fs.writeFileSync(path.join(o.out, 'items.json'), JSON.stringify({ seed: SEED, counts, dropped: b.dropped, items: b.items }, null, 1));
  for (const [id, p] of Object.entries(b.prompts)) fs.writeFileSync(path.join(o.out, 'prompts', `${id}.txt`), p);
  fs.writeFileSync(path.join(o.out, 'estimate.json'), JSON.stringify({ ...est, counts, dropped: b.dropped }, null, 1));
  console.log(`# blind-grade: model ${est.model} (${est.reason}); items real ${counts.real}, mismatched ${counts.mismatched}; dropped repos ${b.dropped.repos.length} (${b.dropped.items} items)`);
  console.log(`# estimate (${est.method}): input ${est.input_tokens} tokens, output ${est.output_tokens}; sonnet $${est.usd_sonnet.toFixed(3)}, haiku $${est.usd_haiku.toFixed(3)}; cap $${o.budget}`);
  if (!o.run) { console.log('# dry run: no API call. Add --run to pay.'); return; }
  const res = await runAll(o, b, est);
  const stats = analyse(b.items, res.rows, JSON.parse(fs.readFileSync(o.audit, 'utf8')), o.runs.split(','));
  const out = { model: est.model, spent_usd: res.spent, stopped_before: res.stopped, ungraded: res.ungraded, dropped: b.dropped, ...stats };
  fs.writeFileSync(path.join(o.out, 'analysis.json'), JSON.stringify(out, null, 1));
  console.log(JSON.stringify(out, null, 1));
}

module.exports = { strip, derange, rng, shuffle, render, leaks, build, estimate, parseGrade, runAll, analyse, cutDiff, DIFF_CAP };
if (require.main === module) main().catch((e) => { console.error(e.message); process.exit(1); });
