#!/usr/bin/env node
// Focused review of a large PR: bound what the model reads before it runs. Deterministic, no AI, language-agnostic.
// Gate: more than FOCUS_THRESHOLD "lines,files" changed (defaults 600,25; "off" disables) -> rank the changed files by risk and keep the top
// FOCUS_FILES (default 12), product code before tooling/docs, plus the changed tests of those files. The prompt diff budget is split between the
// chosen files (each keeps its first hunks up to its allowance, the rest is a one-line marker): a chosen file is never dropped for size.
// Changed requirement documents are not review files (their changed blocks are criteria); they are listed in focus-requirements.txt.
// Writes focus.txt (path TAB score TAB score components), focus-skipped.txt (path TAB changed lines, riskiest first), focus-requirements.txt
// and rewrites diff.numbered.txt to the chosen files only; diff.patch stays whole. Nothing is written for a PR below the gate.
const fs = require('node:fs');
const path = require('node:path');
const { numberDiff } = require('./numdiff.js');
const trace = () => require('./trace.js'); // lazy: trace.js loads post.js, which loads prompt.js, which loads this file

const DIFF_BUDGET = 40 * 1024; // = LIMITS.diff in prompt.js (a test keeps them equal)
const MIN_ALLOW = 2 * 1024, MARKER_RESERVE = 128;
const LOGIC = /\.(js|jsx|mjs|cjs|ts|tsx|py|rb|go|rs|java|kt|kts|scala|cs|fs|swift|m|mm|c|h|cc|cpp|hpp|php|sh|bash|ps1|lua|dart|exs?|erl|hs|clj|sql|vue|svelte|pl|r)$/i;
const GENERATED = /(^|\/)(dist|build|vendor|generated|gen|__generated__)\/|\.(lock|min\.\w+|snap|svg|map)$/i;
const TOOLING = /(^|\/)(eval|evals|bench|benchmarks?|scripts?|tools?|examples?|samples?|docs?|fixtures?|testdata|\.github)\/|\.(md|mdx|markdown|rst|adoc)$/i;
const BRANCHY = /\b(if|else|catch|throw|return|raise|except|switch|case|guard)\b/;
const ACTION = /(^|\/)action\.ya?ml$/;
// names a file mentions: "stem.ext", a stem after a quote or slash, or the target of import/require/from/include/source/use
const REFS = /(?<=['"`\/ ])([\w-]{3,})(?=\.[A-Za-z]{1,5}\b)|\b(?:from|import|require|include|source|use)\s+['"(]?[\w./-]*?([\w-]{3,})(?=['")\s;,]|$)/gm;

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
  let add = 0, del = 0, risky = 0, branch = 0, hunk = false;
  for (const l of text.split('\n')) {
    if (l.startsWith('@@')) hunk = true; // before the first hunk, +++ and --- are file headers
    else if (!hunk) continue;
    else if (l.startsWith('+')) { add++; if (BRANCHY.test(l)) branch++; }
    else if (l.startsWith('-')) { del++; if (BRANCHY.test(l)) { risky++; branch++; } }
  }
  return { lines: add + del, risky, branch, deleted: /^deleted file mode /m.test(text) };
}

function thresholds(env) {
  const raw = String(env.FOCUS_THRESHOLD ?? '').trim().toLowerCase();
  if (raw === 'off') return null;
  const m = /^(\d+)\s*,\s*(\d+)$/.exec(raw);
  const files = parseInt(env.FOCUS_FILES, 10);
  return { lines: m ? +m[1] : 600, files: m ? +m[2] : 25, k: files > 0 ? files : 12 };
}

// test-candidates.txt -> Map(source path -> [test paths]); a source with "(no candidate test file found)" maps to []
// skipHunk: leave out the hunk tier ("mentions changed `x`"): such a test only shares an identifier with the diff, it is not the file's own test
function parseCandidates(text, { skipHunk = false } = {}) {
  const m = new Map();
  let cur = null;
  for (const l of String(text).split('\n')) {
    if (!l.trim()) continue;
    if (!l.startsWith(' ')) { if (!l.startsWith('(')) m.set((cur = l), []); continue; }
    const t = /^\s+(\S.*?)\s{2}\(/.exec(l);
    if (cur && t && !l.includes('no candidate test') && !(skipHunk && /\(mentions changed /.test(l))) m.get(cur).push(t[1]);
  }
  return m;
}

const stemOf = (p) => { const parts = p.split('/'), b = parts.pop().replace(/\.[^.]*$/, ''); return b === 'index' && parts.length ? parts.pop() : b; };
const mentioned = (text) => { const out = new Set(); for (const m of String(text).matchAll(REFS)) out.add(m[1] || m[2]); return out; };

// Risk of one changed file as the sum of named components. Product code (entry points, widely referenced files, logic that touches branches)
// outranks tooling, docs and fixtures; "no test found" only breaks ties.
// "named by a requirement" only discriminates while few files are named: when more than half of the changed source files are (a PR body that lists every
// file, PR #111), the bonus shrinks to 3 x (1 - named/total), so it is 0 when all are named. share = { named, total } over the changed source files.
function score(f, { cands = new Map(), named = new Set(), share = { named: 0, total: 0 }, fan = 0, entry = false, product = false } = {}) {
  const kind = trace().pathKind(f.path);
  if (GENERATED.test(f.path) || kind === 'snapshot') return { s: 0, why: ['generated'] };
  const parts = [], add = (label, value) => parts.push({ label, value });
  if (LOGIC.test(f.path)) add('logic', 3);
  else if (kind === 'config') add('config', 0.5);
  else if (kind === 'doc') add('docs', 0.3);
  else add('other', 1.5);
  add('size', Math.min(2.5, 0.5 * Math.log2(1 + f.lines)));
  if (fan) add(`fan-in ${fan}`, Math.min(3, fan));
  if (entry) add('entry point', 3);
  if (f.branch) add(`${f.branch} branch/error line(s) changed`, Math.min(2, 0.2 * f.branch));
  if (f.risky && !f.deleted) add(`${f.risky} of them removed`, Math.min(2, 0.5 * f.risky));
  if (LOGIC.test(f.path) && cands.has(f.path) && !cands.get(f.path).length) add('no test found', 0.5);
  if (named.has(f.path)) {
    const k = share.total && share.named * 2 > share.total ? Math.max(0, 1 - share.named / share.total) : 1;
    add(k < 1 ? `named by a requirement (${share.named} of ${share.total} changed files are named: bonus x${k.toFixed(2)})` : 'named by a requirement', 3 * k);
  }
  let s = parts.reduce((a, p) => a + p.value, 0);
  const why = parts.map((p) => `${p.label} +${p.value.toFixed(1)}`);
  if (f.deleted) { s *= 0.3; why.push('deleted file x0.3'); } // nothing new to test; its diff is large and cheap to skip
  if (TOOLING.test(f.path) && !product && !entry) { s *= 0.35; why.push('tooling/docs path x0.35'); }
  return { s: Math.max(0, s), why };
}

// A file's numbered diff cut to `allow` bytes: the header and the first whole hunks that fit (when not even the first fits, its leading lines),
// then a one-line marker for the changed lines left out.
function trim(numbered, allow) {
  if (Buffer.byteLength(numbered) <= allow) return numbered;
  const lines = numbered.replace(/\n$/, '').split('\n');
  const first = lines.findIndex((l) => l.startsWith('@@'));
  if (first < 0) return numbered;
  const len = (a, b) => Buffer.byteLength(lines.slice(a, b).join('\n')) + 1;
  let used = len(0, first), end = first, start = first;
  for (let i = first + 1; i <= lines.length; i++) {
    if (i < lines.length && !lines[i].startsWith('@@')) continue;
    if (used + len(start, i) > allow) break;
    used += len(start, i); end = start = i;
  }
  if (end === first) { // not even the first hunk fits
    end = first + 1;
    while (end < lines.length && used + Buffer.byteLength(lines[end]) + 1 <= allow) { used += Buffer.byteLength(lines[end]) + 1; end++; }
  }
  const left = lines.slice(end).filter((l) => /^\s*\d+ \| [+-]/.test(l)).length;
  return `${lines.slice(0, end).join('\n')}\n… ${left} more changed lines in this file not shown (read the file for them)\n`;
}

// Split `budget` bytes between pieces ([key, size]): small ones keep all they need, the big ones share the rest (never below MIN_ALLOW).
function allowances(sizes, budget) {
  const out = new Map(), order = [...sizes].sort((a, b) => a[1] - b[1]);
  let left = budget - MARKER_RESERVE * order.length;
  order.forEach(([k, sz], i) => { const a = Math.max(MIN_ALLOW, Math.min(sz, Math.floor(left / (order.length - i)))); out.set(k, a); left -= a; });
  return out;
}

// ctx directory -> { focused:false } or { focused:true, chosen, skipped, requirements, total, patch, numbered }; pure apart from reading ctx and the checked-out files
function plan(ctx, env = process.env) {
  const rd = (n) => { try { return fs.readFileSync(path.join(ctx, n), 'utf8'); } catch { return ''; } };
  const th = thresholds(env);
  const files = splitDiff(rd('diff.patch')).map((f) => ({ ...f, ...stats(f.text) }));
  const total = files.reduce((a, f) => a + f.lines, 0);
  if (!th || (total <= th.lines && files.length <= th.files)) return { focused: false };

  const root = env.FOCUS_ROOT || process.cwd();
  const disk = (p) => { try { const fp = path.join(root, p); return fs.lstatSync(fp).isFile() && fs.statSync(fp).size < 256 * 1024 ? fs.readFileSync(fp, 'utf8') : ''; } catch { return ''; } };
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
  const code = files.filter((f) => !isTest(f.path) && !spec.has(f.path));
  // who refers to whom: names mentioned by each changed non-doc, non-test file (its diff and its checked-out content); entry points named by action.yml / package.json
  const body = new Map(code.map((f) => [f.path, `${f.text}\n${disk(f.path)}`]));
  const mentions = new Map(code.filter((f) => !/\.(md|mdx|markdown|rst|adoc)$/i.test(f.path)).map((f) => [f.path, mentioned(body.get(f.path))]));
  const entryText = ['action.yml', 'action.yaml', ...code.map((f) => f.path).filter((p) => ACTION.test(p))].map((p) => body.get(p) || disk(p)).join('\n');
  const entries = new Set();
  try { const j = JSON.parse(body.get('package.json') || disk('package.json')); for (const v of [j.main, ...(typeof j.bin === 'string' ? [j.bin] : Object.values(j.bin || {}))]) if (typeof v === 'string') entries.add(v.replace(/^\.\//, '')); } catch { /* no package.json */ }
  const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const isEntry = (p) => ACTION.test(p) || entries.has(p) || (entryText.trim() !== '' && new RegExp(`(?<![\\w.-])${esc(p)}(?![\\w-])|(?<![\\w./-])${esc(p.split('/').pop())}(?![\\w-])`).test(entryText));
  const fanIn = (p) => { const st = stemOf(p); if (st.length < 3) return 0; let n = 0; for (const [q, set] of mentions) if (q !== p && set.has(st)) n++; return n; };
  const isProduct = (f) => /\.github\/workflows\//.test(f.path) && /\bworkflow_call\b/.test(body.get(f.path));

  const size = new Map(files.map((f) => [f.path, Buffer.byteLength(numberDiff(f.text))]));
  const share = { named: code.filter((f) => named.has(f.path)).length, total: code.length };
  const ranked = code.map((f) => { const r = score(f, { cands, named, share, fan: fanIn(f.path), entry: isEntry(f.path), product: isProduct(f) }); return { ...f, score: r.s, why: r.why }; })
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  const chosen = ranked.slice(0, th.k);
  // changed tests of the chosen files are the evidence the PR adds: they ride along (not counted toward K) while every piece keeps MIN_ALLOW
  const byPath = new Map(files.map((f) => [f.path, f]));
  const maxPieces = Math.floor(DIFF_BUDGET / MIN_ALLOW);
  for (const f of ranked.slice(0, th.k)) {
    for (const t of cands.get(f.path) || []) {
      const tf = byPath.get(t);
      if (!tf || chosen.some((c) => c.path === t) || chosen.length >= maxPieces) continue;
      chosen.push({ ...tf, score: 0, why: [`changed test of ${f.path}`] });
    }
  }
  const picked = new Set(chosen.map((f) => f.path));
  const skipped = [...ranked.filter((f) => !picked.has(f.path)), ...files.filter((f) => isTest(f.path) && !picked.has(f.path))];
  const requirements = files.filter((f) => spec.has(f.path));
  const order = new Map(files.map((f, i) => [f.path, i]));
  const sorted = chosen.slice().sort((a, b) => order.get(a.path) - order.get(b.path));
  const allow = allowances(sorted.map((f) => [f.path, size.get(f.path)]), DIFF_BUDGET);
  return { focused: true, chosen, skipped, requirements, total, patch: sorted.map((f) => f.text).join(''), numbered: sorted.map((f) => trim(numberDiff(f.text), allow.get(f.path))).join('') };
}

function main(ctx, env = process.env) {
  const r = plan(ctx, env);
  if (!r.focused) return r;
  const out = (n, s) => fs.writeFileSync(path.join(ctx, n), s);
  out('focus-skipped.txt', r.skipped.map((f) => `${f.path}\t${f.lines}\n`).join(''));
  out('focus-requirements.txt', r.requirements.map((f) => `${f.path}\t${f.lines}\n`).join(''));
  out('diff.numbered.txt', r.numbered); // before focus.txt: its presence is what says the prompt is focused
  out('focus.txt', r.chosen.map((f) => `${f.path}\t${f.score.toFixed(1)}\t${f.why.join(', ')}\n`).join(''));
  return r;
}

module.exports = { splitDiff, stats, trim, thresholds, parseCandidates, score, plan, main, DIFF_BUDGET };

if (require.main === module) {
  if (!process.argv[2]) { console.error('Usage: node src/focus.js <ctx>'); process.exit(2); }
  const r = main(process.argv[2]);
  console.log(r.focused ? `focused review: ${r.chosen.length} of ${r.chosen.length + r.skipped.length} files` : 'focus: not needed');
}
