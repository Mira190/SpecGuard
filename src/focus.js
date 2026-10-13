#!/usr/bin/env node
// Focused review of a large PR: bound what the model reads before it runs. Deterministic, no AI, language-agnostic.
// Gate: more than FOCUS_THRESHOLD "lines,files" changed (defaults 600,25; "off" disables) -> rank the changed files by risk, keep the top
// FOCUS_FILES (default 12) whose diff fits ~60% of the prompt diff budget, plus the changed tests of those files in the rest of the budget.
// Writes focus.txt (path TAB score TAB reasons), focus-skipped.txt (path TAB changed lines, riskiest first) and rewrites diff.numbered.txt
// to the chosen files only; diff.patch stays whole. Nothing is written for a PR below the gate.
const fs = require('node:fs');
const path = require('node:path');
const { numberDiff } = require('./numdiff.js');
const trace = () => require('./trace.js'); // lazy: trace.js loads post.js, which loads prompt.js, which loads this file

const DIFF_BUDGET = 40 * 1024; // = LIMITS.diff in prompt.js (a test keeps them equal)
const SHARE = 0.6;
const LOGIC = /\.(js|jsx|mjs|cjs|ts|tsx|py|rb|go|rs|java|kt|kts|scala|cs|fs|swift|m|mm|c|h|cc|cpp|hpp|php|sh|bash|ps1|lua|dart|exs?|erl|hs|clj|sql|vue|svelte|pl|r)$/i;
const GENERATED = /(^|\/)(dist|build|vendor|generated|gen|__generated__)\/|\.(lock|min\.\w+|snap|svg|map)$/i;
const SIDE = /(^|\/)(docs?|examples?|samples?|fixtures?|testdata|scripts?)\//i;
const BRANCHY = /\b(if|else|catch|throw|return|raise|except|switch|case|guard)\b/;

// diff.patch -> [{path, text}] one per file, in order
function splitDiff(patch) {
  const out = [];
  for (const part of String(patch).split(/^(?=diff --git )/m)) {
    if (!part.startsWith('diff --git ')) continue;
    const head = part.split('\n', 1)[0];
    const m = /^diff --git "?a\/(.*?)"? "?b\/(.*?)"?$/.exec(head);
    out.push({ path: m ? m[2] : head.slice(11), text: part });
  }
  return out;
}

function stats(text) {
  let add = 0, del = 0, risky = 0, hunk = false;
  for (const l of text.split('\n')) {
    if (l.startsWith('@@')) hunk = true; // before the first hunk, +++ and --- are file headers
    else if (!hunk) continue;
    else if (l.startsWith('+')) add++;
    else if (l.startsWith('-')) { del++; if (BRANCHY.test(l)) risky++; }
  }
  return { lines: add + del, risky, deleted: /^deleted file mode /m.test(text) };
}

function thresholds(env) {
  const raw = String(env.FOCUS_THRESHOLD ?? '').trim().toLowerCase();
  if (raw === 'off') return null;
  const m = /^(\d+)\s*,\s*(\d+)$/.exec(raw);
  const files = parseInt(env.FOCUS_FILES, 10);
  return { lines: m ? +m[1] : 600, files: m ? +m[2] : 25, k: files > 0 ? files : 12 };
}

// test-candidates.txt -> Map(source path -> [test paths]); a source with "(no candidate test file found)" maps to []
function parseCandidates(text) {
  const m = new Map();
  let cur = null;
  for (const l of String(text).split('\n')) {
    if (!l.trim()) continue;
    if (!l.startsWith(' ')) { if (!l.startsWith('(')) m.set((cur = l), []); continue; }
    const t = /^\s+(\S.*?)\s{2}\(/.exec(l);
    if (cur && t && !l.includes('no candidate test')) m.get(cur).push(t[1]);
  }
  return m;
}

function score(f, { cands, named, spec }) {
  const why = [];
  const kind = spec ? 'spec' : trace().pathKind(f.path);
  let s = 0;
  if (GENERATED.test(f.path) || kind === 'snapshot') return { s: 0, why: ['generated'] };
  if (spec) { s += 3; why.push('requirement document'); }
  else if (LOGIC.test(f.path)) { s += 3; why.push('logic'); }
  else if (kind === 'config') { s += 0.5; why.push('config'); }
  else if (kind === 'doc') { s += 0.3; why.push('docs'); }
  else { s += 1.5; }
  if (SIDE.test(f.path) && !spec) s -= 1;
  s += 0.7 * Math.log2(1 + f.lines);
  if (LOGIC.test(f.path) && cands.has(f.path) && !cands.get(f.path).length) { s += 2; why.push('no test found'); }
  if (named.has(f.path)) { s += 3; why.push('named by a requirement'); }
  if (f.risky && !f.deleted) { s += Math.min(3, f.risky * 0.5); why.push(`${f.risky} removed branch/error line(s)`); }
  if (f.deleted) { s *= 0.3; why.push('deleted file'); } // nothing new to test; its diff is large and cheap to skip
  return { s: Math.max(0, s), why };
}

// ctx directory -> { focused:false } or { focused:true, chosen, skipped, patch, numbered }; pure apart from reading ctx
function plan(ctx, env = process.env) {
  const rd = (n) => { try { return fs.readFileSync(path.join(ctx, n), 'utf8'); } catch { return ''; } };
  const th = thresholds(env);
  const files = splitDiff(rd('diff.patch')).map((f) => ({ ...f, ...stats(f.text) }));
  const total = files.reduce((a, f) => a + f.lines, 0);
  if (!th || (total <= th.lines && files.length <= th.files)) return { focused: false };

  const cands = parseCandidates(rd('test-candidates.txt'));
  const spec = new Set(rd('spec-files.txt').split('\n').filter(Boolean));
  const named = new Set();
  try {
    const c = JSON.parse(rd('trace-candidates.json'));
    for (const h of c.code_to_requirement || []) if (h.path) named.add(h.path);
    for (const r of c.requirement_to_code || []) for (const x of r.code || []) named.add(typeof x === 'string' ? x : x?.path);
  } catch { /* no trace data */ }
  const reqText = rd('requirements.md') + rd('requirements-status.json');
  for (const f of files) if (reqText.includes(f.path)) named.add(f.path);

  const isTest = (p) => trace().isTestPath(p) && !spec.has(p);
  const size = new Map(files.map((f) => [f.path, Buffer.byteLength(numberDiff(f.text))]));
  const ranked = files.filter((f) => !isTest(f.path)).map((f) => { const r = score(f, { cands, named, spec: spec.has(f.path) }); return { ...f, score: r.s, why: r.why }; })
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  const chosen = [];
  let used = 0;
  for (const f of ranked) {
    if (chosen.length >= th.k) break;
    const sz = size.get(f.path);
    if (chosen.length && used + sz > DIFF_BUDGET * SHARE) continue; // the riskiest file is always kept; the prompt cuts it at its own limit
    chosen.push(f); used += sz;
  }
  // changed tests of the chosen files are the evidence the PR adds: they fill the rest of the budget, they do not count toward K
  const byPath = new Map(files.map((f) => [f.path, f]));
  for (const f of [...chosen]) {
    for (const t of cands.get(f.path) || []) {
      const tf = byPath.get(t);
      if (!tf || chosen.includes(tf) || used + size.get(t) > DIFF_BUDGET) continue;
      chosen.push({ ...tf, score: 0, why: [`changed test of ${f.path}`] }); used += size.get(t);
    }
  }
  const picked = new Set(chosen.map((f) => f.path));
  const skipped = [...ranked.filter((f) => !picked.has(f.path)), ...files.filter((f) => isTest(f.path) && !picked.has(f.path))];
  const order = new Map(files.map((f, i) => [f.path, i]));
  const body = chosen.slice().sort((a, b) => order.get(a.path) - order.get(b.path));
  return { focused: true, chosen, skipped, total, patch: body.map((f) => f.text).join(''), numbered: numberDiff(body.map((f) => f.text).join('')) };
}

function main(ctx, env = process.env) {
  const r = plan(ctx, env);
  if (!r.focused) return r;
  const out = (n, s) => fs.writeFileSync(path.join(ctx, n), s);
  out('focus-skipped.txt', r.skipped.map((f) => `${f.path}\t${f.lines}\n`).join(''));
  out('diff.numbered.txt', r.numbered); // before focus.txt: its presence is what says the prompt is focused
  out('focus.txt', r.chosen.map((f) => `${f.path}\t${f.score.toFixed(1)}\t${f.why.join(', ') || 'size'}\n`).join(''));
  return r;
}

module.exports = { splitDiff, stats, thresholds, parseCandidates, score, plan, main, DIFF_BUDGET };

if (require.main === module) {
  if (!process.argv[2]) { console.error('Usage: node src/focus.js <ctx>'); process.exit(2); }
  const r = main(process.argv[2]);
  console.log(r.focused ? `focused review: ${r.chosen.length} of ${r.chosen.length + r.skipped.length} files` : 'focus: not needed');
}
