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
const SHARED_RULE = "primary excludes every M1/M2 item whose Y shares X's fix PR (rqlite 2706, sqlglot 8474) together with its real partner";
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

// M2 (content swap): X's own findings keep path and line; kind, confidence, title and why come from Y's findings, cycling through Y's list when it is shorter.
// X has no findings: none. Y has no findings: X's findings keep their location with an empty title, kind "none", no confidence and no why.
function swapContent(xf, yf) {
  return xf.map((f, i) => {
    const g = yf.length ? yf[i % yf.length] : { kind: 'none', confidence: null, title: '', why: null };
    return { where: f.where, path: f.path, line: f.line, kind: g.kind, confidence: g.confidence, title: g.title, why: g.why };
  });
}

// crude tell: a title names a code-like identifier (backticked, or snake_case / camelCase / followed by "()") that appears nowhere in X's fix diff or introducing diff (whole-word check)
function tokensOf(title) {
  const t = String(title ?? ''), out = new Set();
  for (const m of t.matchAll(/`([^`]+)`/g)) out.add(m[1].trim());
  for (const m of t.matchAll(/\b[A-Za-z_][A-Za-z0-9_]*(?:_[A-Za-z0-9_]+|[a-z][A-Z][A-Za-z0-9_]*|(?=\(\)))/g)) out.add(m[0]);
  return [...out].filter(Boolean);
}
const hasWord = (text, tok) => new RegExp(`(?<![A-Za-z0-9_])${tok.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9_])`).test(text);
const tells = (findings, ...texts) => findings.filter((f) => tokensOf(f.title).some((tok) => !texts.some((x) => hasWord(x, tok)))).length;

function introDiff(o, pair) {
  try { return execFileSync('git', ['-C', path.join(o.repos, pair.repo.split('/')[1]), 'diff', pair.introducing.base, pair.introducing.head], { encoding: 'utf8', maxBuffer: 1 << 28 }); } catch { return null; }
}

function build(o) {
  const pairsAll = JSON.parse(fs.readFileSync(o.pairs, 'utf8')).pairs.filter((p) => p.replay_eligible);
  const fixshas = fs.existsSync(o.fixshas) ? JSON.parse(fs.readFileSync(o.fixshas, 'utf8')) : {};
  for (const p of pairsAll) if (fixshas[p.id]) p.fix.sha = fixshas[p.id];
  const template = fs.readFileSync(o.template, 'utf8').replace(/\r\n/g, '\n'), runs = o.runs.split(','), r = rng(SEED);
  const byRepo = {};
  for (const p of pairsAll) (byRepo[p.repo] ||= []).push(p);
  const dropped = { repos: [], pairs: 0, items: 0, same_fix_relaxed: [] }, pairs = [], Y = {};
  for (const [repo, g] of Object.entries(byRepo).sort()) {
    const d = g.length > 1 ? derange(g, r) : null;
    if (!d) { dropped.repos.push(repo); dropped.pairs += g.length; dropped.items += g.length * runs.length * 3; continue; }
    Object.assign(Y, d.map); pairs.push(...g); if (d.relaxed) dropped.same_fix_relaxed.push(repo);
  }
  const raw = [];
  for (const p of pairs) runs.forEach((run, i) => {
    for (const arm of ['real', 'M1', 'M2']) raw.push({ arm, pair: p, y: arm === 'real' ? p : Y[p.id], rep: i + 1, run });
  });
  const shuffled = shuffle(raw, r), items = [], prompts = {}, m2tell = { m2_findings: 0, with_foreign_identifier: 0, introducing_diff_missing: 0 }, idiff = {};
  shuffled.forEach((x, i) => {
    const id = `item-${String(i + 1).padStart(3, '0')}`, fixDiff = loadDiff(o, x.pair), xf = loadFindings(o.raw, x.run, x.pair);
    const findings = x.arm === 'real' ? xf : x.arm === 'M1' ? loadFindings(o.raw, x.run, x.y) : swapContent(xf, loadFindings(o.raw, x.run, x.y));
    const prompt = render(template, x.pair.bug_card, fixDiff, findings);
    const bad = leaks(prompt, pairsAll);
    if (bad.length) throw new Error(`${id} leaks ${bad.join(', ')}`);
    prompts[id] = prompt;
    const it = { id, arm: x.arm, pair: x.pair.id, replay_id: x.pair.replay_id, repo: x.pair.repo, rep: x.rep, findings_from: x.y.id, shares_fix: x.arm !== 'real' && x.y.fix.number === x.pair.fix.number };
    if (x.arm === 'M2') {
      if (!(x.pair.id in idiff)) idiff[x.pair.id] = introDiff(o, x.pair);
      if (idiff[x.pair.id] === null) m2tell.introducing_diff_missing++;
      it.tell = tells(findings, fixDiff, idiff[x.pair.id] || '');
      m2tell.m2_findings += findings.length; m2tell.with_foreign_identifier += it.tell;
    }
    items.push(it);
  });
  m2tell.method = 'a title token is a backticked span, or an identifier with an underscore, an inner capital (camelCase) or a following "()"; it is foreign when it does not occur as a whole word in the fix diff nor in the introducing diff (git diff base head, read-only) of X';
  return { items, prompts, dropped, template, m2tell };
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
  // no temperature: claude-sonnet-5-5 rejects it (HTTP 400 "`temperature` is deprecated for this model"); src/engines/claude-api.js sends none either
  const res = await fetchFn('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, body: JSON.stringify({ model, max_tokens: MAX_TOKENS, messages: [{ role: 'user', content: prompt }] }) });
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
// compare real against one control arm (M1 or M2) over the pairs where both items were graded; excl drops pairs whose Y shares X's fix
function compare(items, grade, arm, excl) {
  const by = {};
  for (const it of items) { const k = `${it.pair}|${it.rep}`; (by[k] ||= {})[it.arm] = it; }
  const full = Object.values(by).filter((x) => x.real && x[arm] && grade[x.real.id] && grade[x[arm].id] && !(excl && x[arm].shares_fix));
  const R = full.map((x) => caught(grade[x.real.id])), M = full.map((x) => caught(grade[x[arm].id])), n = full.length;
  const re = n ? R.filter(Boolean).length / n : null, mi = n ? M.filter(Boolean).length / n : null, obs = re - mi;
  const rg = {}, repos = {};
  full.forEach((x, i) => {
    (rg[x.real.repo] ||= []).push(R[i], M[i]);
    const g = (repos[x.real.repo] ||= { n: 0, real: 0, control: 0 }); g.n++; g.real += R[i] ? 1 : 0; g.control += M[i] ? 1 : 0;
  });
  const r = rng(SEED); let ge = 0;
  for (let t = 0; t < PERMS; t++) { // within each repo, permute the real/control labels across that repo's graded items
    let a = 0, c = 0;
    for (const v of Object.values(rg)) { const s = shuffle(v, r), h = v.length / 2; for (let i = 0; i < v.length; i++) if (s[i]) { if (i < h) a++; else c++; } }
    if ((a - c) / n >= obs - 1e-12) ge++;
  }
  return { pairs_used: n, real_catch_rate: re, control_catch_rate: mi, difference: obs, p_one_sided: (ge + 1) / (PERMS + 1), permutations: PERMS, per_repo: repos };
}

function analyse(items, rows, audit) {
  const grade = Object.fromEntries(rows.map((r) => [r.id, r.grade]));
  const cmp = (excl) => ({ real_vs_M2: compare(items, grade, 'M2', excl), real_vs_M1: compare(items, grade, 'M1', excl) });
  // descriptive: blind real grade vs audit.json grade (audit rows keyed by replay id and rep)
  let agree = 0, nA = 0;
  for (const x of items.filter((i) => i.arm === 'real' && grade[i.id])) {
    const a = audit.find((e) => e.id === x.replay_id && e.rep === x.rep);
    if (a) { nA++; if (caught(a.new_grade) === caught(grade[x.id])) agree++; }
  }
  return {
    primary: { rule: SHARED_RULE, ...cmp(true) },
    sensitivity_all_items: { rule: 'all items, shared-fix pairs included', ...cmp(false) },
    audit_agreement: nA ? { n: nA, agree, share: agree / nA } : null, ungradable: rows.filter((r) => r.grade === 'ungradable').length,
  };
}

async function main() {
  const { values: v } = require('node:util').parseArgs({ options: { pairs: { type: 'string' }, raw: { type: 'string' }, runs: { type: 'string' }, audit: { type: 'string' }, fixdiff: { type: 'string' }, fixshas: { type: 'string' }, repos: { type: 'string' }, out: { type: 'string' }, template: { type: 'string', default: path.join(__dirname, 'blind-grade-prompt.md') }, run: { type: 'boolean', default: false }, 'dry-run': { type: 'boolean', default: true }, budget: { type: 'string', default: '5' } } });
  const o = { ...v, budget: parseFloat(v.budget) };
  for (const k of ['pairs', 'raw', 'runs', 'audit', 'fixdiff', 'fixshas', 'out']) if (!o[k]) { console.error(`missing --${k}; see the header of this file`); process.exit(2); }
  const b = build(o), est = estimate(b.prompts, b.items), counts = Object.fromEntries(['real', 'M1', 'M2'].map((a) => [a, b.items.filter((i) => i.arm === a).length]));
  fs.mkdirSync(path.join(o.out, 'prompts'), { recursive: true });
  fs.writeFileSync(path.join(o.out, 'items.json'), JSON.stringify({ seed: SEED, counts, dropped: b.dropped, m2_tell: b.m2tell, items: b.items }, null, 1));
  for (const [id, p] of Object.entries(b.prompts)) fs.writeFileSync(path.join(o.out, 'prompts', `${id}.txt`), p);
  fs.writeFileSync(path.join(o.out, 'estimate.json'), JSON.stringify({ ...est, counts, dropped: b.dropped, m2_tell: b.m2tell }, null, 1));
  console.log(`# blind-grade: model ${est.model} (${est.reason}); items real ${counts.real}, M1 (whole-PR mismatch) ${counts.M1}, M2 (content swap) ${counts.M2}; dropped repos ${b.dropped.repos.length} (${b.dropped.items} items)`);
  console.log(`# ${SHARED_RULE}; the all-items figure is reported as a sensitivity`);
  console.log(`# M2 tell: ${b.m2tell.with_foreign_identifier} of ${b.m2tell.m2_findings} M2 findings name an identifier absent from X's diffs`);
  console.log(`# estimate (${est.method}): input ${est.input_tokens} tokens, output ${est.output_tokens}; sonnet $${est.usd_sonnet.toFixed(3)}, haiku $${est.usd_haiku.toFixed(3)}; cap $${o.budget}`);
  if (!o.run) { console.log('# dry run: no API call. Add --run to pay.'); return; }
  const res = await runAll(o, b, est);
  const stats = analyse(b.items, res.rows, JSON.parse(fs.readFileSync(o.audit, 'utf8')));
  const out = { model: est.model, spent_usd: res.spent, stopped_before: res.stopped, ungraded: res.ungraded, dropped: b.dropped, m2_tell: b.m2tell, ...stats };
  fs.writeFileSync(path.join(o.out, 'analysis.json'), JSON.stringify(out, null, 1));
  console.log(JSON.stringify(out, null, 1));
}

module.exports = { swapContent, tokensOf, tells, strip, derange, rng, shuffle, render, leaks, build, estimate, parseGrade, runAll, analyse, cutDiff, DIFF_CAP };
if (require.main === module) main().catch((e) => { console.error(e.message); process.exit(1); });
