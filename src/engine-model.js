#!/usr/bin/env node
// Records which model(s) Copilot actually used: node engine-model.js --turn main|repair|fallback [--usage <usage file>]
// Env: CTX SID (session id) MODEL (requested) FAST_MODELS COPILOT_HOME (state dir, default ~/.copilot). Appends to $CTX/engine-model.json:
// { requested, turns: [{turn, chosen, candidates, available, routing, scores?, fallback?, source?}], used: [...], tier: 'fast'|'normal', events }
// Source: `session.auto_mode_resolved` events in <COPILOT_HOME>/session-state/<SID>/events.jsonl (one per turn, shared by all turns of the session),
// else `currentModel` / `modelMetrics` keys of the turn's usage file. Never throws: missing or garbled files record what is known.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// ponytail: tiers are guessed from the model NAME because Copilot publishes no machine-readable tier and names change every few weeks.
// First match wins; unknown names are 'normal' (never penalised). Ceiling: a mis-tiered new name. Override with the `fast_models` input
// (exact names or /regex/, newline or comma separated) and add the name here once an eval run shows it behaves like a small model.
const TABLE = [{ re: /(^|[-_.\s])(flash|mini|haiku|nano|lite|small)([-_.\s]|$)/i, tier: 'fast' }, { re: /./, tier: 'normal' }];

function overrides(spec = '') { // fast_models -> [{re, tier:'fast'}]; a bad /regex/ is skipped
  const out = [];
  for (const line of String(spec).split(/\r?\n/)) {
    const l = line.trim();
    if (!l) continue;
    const parts = /^\/.+\/[a-z]*$/.test(l) ? [l] : l.split(',').map((s) => s.trim()).filter(Boolean);
    for (const p of parts) {
      const m = /^\/(.+)\/([a-z]*)$/.exec(p);
      try { out.push({ re: m ? new RegExp(m[1], m[2].includes('i') ? m[2] : m[2] + 'i') : new RegExp(`^${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'), tier: 'fast' }); } catch { /* invalid regex: ignored */ }
    }
  }
  return out;
}
const tierOf = (name, fast = '') => ([...overrides(fast), ...TABLE].find((e) => e.re.test(String(name))) || { tier: 'normal' }).tier;

const strs = (a) => (Array.isArray(a) ? a.filter((x) => typeof x === 'string') : []);
function parseEvents(text) { // the auto_mode_resolved events, in order; garbled lines are skipped
  const out = [];
  for (const line of String(text || '').split('\n')) {
    if (!line.includes('auto_mode_resolved')) continue;
    try {
      const e = JSON.parse(line);
      if (e?.type !== 'session.auto_mode_resolved' || typeof e.data?.chosenModel !== 'string') continue;
      const d = e.data;
      out.push({ chosen: d.chosenModel, candidates: strs(d.candidateModels), available: strs(d.availableModels), routing: typeof d.routingMethod === 'string' ? d.routingMethod : null,
        ...(d.categoryScores && typeof d.categoryScores === 'object' ? { scores: d.categoryScores } : {}), ...(d.fallback === true ? { fallback: true } : {}) });
    } catch { /* skip */ }
  }
  return out;
}
const readJson = (f) => { try { const j = JSON.parse(fs.readFileSync(f, 'utf8')); return j && typeof j === 'object' ? j : null; } catch { return null; } };
const readText = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };

function run({ ctx, sid, requested = '', turn = 'main', usage, fast = '', home }) {
  const prev = readJson(path.join(ctx, 'engine-model.json'));
  const turns = Array.isArray(prev?.turns) ? prev.turns : [];
  const seen = Number.isInteger(prev?.events) ? prev.events : 0;
  const root = home || process.env.COPILOT_HOME || path.join(os.homedir(), '.copilot');
  const events = sid ? parseEvents(readText(path.join(root, 'session-state', sid, 'events.jsonl'))) : [];
  const fresh = events.slice(seen); // earlier turns of this session are already recorded
  for (const e of fresh) turns.push({ turn, ...e });
  if (!fresh.length && usage) { // no event: the usage file still names the model(s)
    const u = readJson(usage);
    const names = [...new Set([u?.currentModel, ...Object.keys(u?.modelMetrics && typeof u.modelMetrics === 'object' ? u.modelMetrics : {})].filter((x) => typeof x === 'string' && x))];
    for (const chosen of names) turns.push({ turn, chosen, candidates: [], available: [], routing: null, source: 'usage' });
  }
  let used = [...new Set(turns.map((t) => t.chosen))];
  if (!used.length && requested && requested !== 'auto') used = [requested]; // an explicit model needs no router
  const doc = { requested, turns, used, tier: used.some((m) => tierOf(m, fast) === 'fast') ? 'fast' : 'normal', events: Math.max(seen, events.length) };
  try { fs.writeFileSync(path.join(ctx, 'engine-model.json'), JSON.stringify(doc, null, 2) + '\n'); } catch { /* ctx not writable: nothing to record into */ }
  return doc;
}

if (require.main === module) {
  try {
    const a = process.argv.slice(2), arg = (f) => (a.includes(f) ? a[a.indexOf(f) + 1] : undefined);
    if (process.env.CTX) run({ ctx: process.env.CTX, sid: process.env.SID, requested: process.env.MODEL || '', turn: arg('--turn') || 'main', usage: arg('--usage'), fast: process.env.FAST_MODELS || '' });
  } catch { /* never fails the step */ }
}
module.exports = { run, parseEvents, tierOf, overrides, TABLE };
