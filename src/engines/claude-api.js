#!/usr/bin/env node
// The claude adapter's default mode (claude_mode: api): ONE Anthropic Messages API call, no agent loop and no CLI. SpecGuard already inlines the diff, test candidates, leads, requirements and rule files
// into the prompt (src/prompt.js), so the model needs no tools: the agent loop re-sends the whole context every turn and its cost cannot be bounded up front (two live runs: $3.58 and $3.44 against a $1 budget).
// Env: CTX PROMPT_FILE (or PROMPT) ANTHROPIC_API_KEY (environment only) MODEL (empty = claude-haiku-5-5) MAX_BUDGET_USD (default 1.00; a HARD bound: checked before the call) MAX_OUTPUT_TOKENS (default 32000) CONTEXT_PACK_BYTES (repository files appended to the prompt, an upper bound, default 250000, 0 = off; shrunk to keep the prompt under 90% of a model's long-context price step; read from GITHUB_WORKSPACE or the cwd) EFFORT (ignored, noted) TIMEOUT (minutes) CHECK (audit = scan schema) FAST_MODELS SCAN_BATCH_BLOCKS (scan: document blocks per call, default 20; more blocks split the scan into parts, src/scan-parts.js).
// Files in CTX as in src/engines/README.md: findings.json usage.json engine-status engine-notes engine-error engine-model.json. Never throws, never prints the key.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { block, cut, LIMITS } = require('../prompt.js');
const { parseCandidates } = require('../focus.js');

const ENDPOINT = 'https://api.anthropic.com/v1/messages', API_VERSION = '2023-06-01';
// ponytail: USD per million tokens, one row per model worth pricing (https://platform.claude.com/docs/en/about-claude/pricing, checked 2026-10-14). Haiku 5.5 has a second card above 100K prompt tokens.
// Cache read = 0.1x input, 5-minute cache write = 1.25x. A model that is not here is priced at DEFAULT_PRICE (a high card, so the pre-flight stays conservative) and the cost is noted as an estimate. Add a row when a model needs exact cost.
const PRICES = {
  'claude-haiku-5-5': { in: 0.1, out: 0.5, longFrom: 100000, longIn: 0.5, longOut: 2.5 },
  'claude-haiku-4-5': { in: 1, out: 5 },
  'claude-sonnet-5-5': { in: 2, out: 10 },
  'claude-sonnet-5': { in: 2, out: 10 },
  'claude-opus-5-5': { in: 4, out: 20 },
  'claude-opus-5': { in: 5, out: 25 },
};
// A reply whose usage lacks input_tokens or output_tokens (or no reply at all: timeout, HTTP failure) may still have been billed: the scan budget charges its part's worst case instead of 0.
const known = (u) => !!u && typeof u.input_tokens === 'number' && typeof u.output_tokens === 'number', charge = (x) => (known(x.u) ? cost(x.used, x.u) : x.usd || 0);
const DEFAULT_PRICE = { in: 5, out: 25 };
const priceOf = (model, promptTokens) => { const p = PRICES[model] || DEFAULT_PRICE; return p.longFrom && promptTokens > p.longFrom ? { in: p.longIn, out: p.longOut } : { in: p.in, out: p.out }; };
const cost = (model, u) => { // u = the API usage object
  const i = u.input_tokens || 0, cr = u.cache_read_input_tokens || 0, cw = u.cache_creation_input_tokens || 0, o = u.output_tokens || 0, p = priceOf(model, i + cr + cw);
  return (i * p.in + cr * p.in * 0.1 + cw * p.in * 1.25 + o * p.out) / 1e6;
};
// Bytes per token. PRE_FLIGHT is deliberately low so the estimate over-counts: line-numbered code measured 1.7-2 bytes/token live (168.6k tokens for 293 KB), English is about 4.
const PRE_FLIGHT_BPT = 1.5;
// Worst case before the call: the whole prompt as cache WRITE for the static part (1.25x) and plain input for the rest, and every allowed output token.
const worstCase = (model, sysBytes, userBytes, maxTokens) => {
  const s = Math.ceil(sysBytes / PRE_FLIGHT_BPT), u = Math.ceil(userBytes / PRE_FLIGHT_BPT), p = priceOf(model, s + u);
  return { tokens: s + u, usd: (s * 1.25 * p.in + u * p.in + maxTokens * p.out) / 1e6 };
};

// Scan: how many full-pack unit calls max_budget_usd covers by the worst case above (1-8). The collector asks before it picks the units (the system prompt is about 15 KB, the rest of a unit part's prompt well under 32 KB).
const MAX_UNIT_CALLS = 8, callUsd = ({ model, maxTokens, packBytes }) => worstCase(model, 16 * 1024, packBytes + 32 * 1024, maxTokens).usd; // callUsd: the worst case of one full unit call
const unitCalls = ({ model, budget, maxTokens, packBytes }) => Math.max(1, Math.min(MAX_UNIT_CALLS, Math.floor(budget / callUsd({ model, maxTokens, packBytes })) || 1));

// Structured outputs accept a subset of JSON Schema: every object closed (additionalProperties:false), no string/number bounds, no uniqueItems/maxItems, no if/then/else, minItems only 0 or 1.
// post.js validates the answer against the full schema anyway.
const DROP = new Set(['$schema', 'minLength', 'maxLength', 'minimum', 'maximum', 'multipleOf', 'uniqueItems', 'maxItems', 'if', 'then', 'else']);
function strict(s) {
  if (Array.isArray(s)) return s.map(strict);
  if (!s || typeof s !== 'object') return s;
  const o = {};
  for (const [k, v] of Object.entries(s)) {
    if (DROP.has(k) || (k === 'minItems' && v > 1)) continue;
    o[k] = k === 'properties' ? Object.fromEntries(Object.entries(v).map(([n, p]) => [n, strict(p)])) : strict(v);
  }
  if (o.type === 'object' || o.properties) o.additionalProperties = false;
  return o;
}

// The prompt is "static prefix (skill, references, schema) + --- + per-PR context" (src/prompt.js): the prefix becomes the cached system block, the rest the user message.
const SPLIT = '\n\n---\n\nContext directory (absolute path):';
const NO_TOOLS = 'This run has no file tools: you cannot Read, Grep or Glob. Ignore every instruction above to read files or to stay within a tool budget. Use only the context inlined below; where the answer would need a file you cannot see, mark it unknown and say so. Output only the JSON object.\n\n';
const NO_TOOLS_PACK = 'This run has no file tools: you cannot Read, Grep or Glob. Ignore every instruction above to read files or to stay within a tool budget. Instead, the blocks after "Repository files" at the end hold files read from the repository: each is the full current text of the file it names (line-numbered where its note says so), unless its note says where it was cut. A block noted "relevant slices" shows bounded windows around the changed lines of the diff and textual references to the changed symbols (real line numbers; "…| (lines a-b omitted)" marks the gaps). Its note says when matching tests were truncated or did not fit; omitted code may contain assertions or indirect coverage. Anything that is neither inlined nor in those blocks was not read: where the answer would need it, mark it unknown and say so. Do not report a missing or weak test when a candidate test file for that code was cut or not included: mark the obligation unknown and say which file was not fully visible. Output only the JSON object.\n\n';
function messages(prompt, pack = '') {
  const at = prompt.indexOf(SPLIT);
  const system = at > 0 ? prompt.slice(0, at) : '', user = at > 0 ? prompt.slice(at + 2) : prompt; // keep "---" at the head of the user part
  return { system, user: (pack ? NO_TOOLS_PACK : NO_TOOLS) + user + (pack ? `\n${pack}\n\nReminder: output only the JSON object matching the schema.\n` : '') };
}

// The context pack: repository files appended to the user message, in priority order, until CONTEXT_PACK_BYTES is spent. The prompt was written for an agent that Reads files; here nobody can.
// Trust boundary: every path comes from the (PR-influenced) context files, so it is resolved against the repo root after realpath and anything outside, secret-like or binary is skipped. Nothing read here is ever logged.
const { PER_FILE, fileCap, packLimit } = require('../pack-cap');
const MAX_FILE = 2 * 1024 * 1024, OVERHEAD = 300; // OVERHEAD: the block markup around a body
const { DENY } = require('../deny.js');
function packRead(root, rel) { // text of a regular, small, non-binary file inside the repo, else null
  if (!rel || /["<>\x00-\x1f]/.test(rel) || path.isAbsolute(rel)) return null; // quotes and angle brackets would break the block label
  try {
    const real = fs.realpathSync(path.resolve(root, rel)), r = path.relative(root, real).split(path.sep).join('/');
    if (!r || r === '..' || r.startsWith('../') || path.isAbsolute(r) || DENY.test(rel.replace(/\\/g, '/')) || DENY.test(r)) return null;
    const st = fs.statSync(real);
    if (!st.isFile() || st.size > MAX_FILE) return null;
    const buf = fs.readFileSync(real);
    return buf.subarray(0, 8192).includes(0) ? null : buf.toString('utf8').replace(/\r\n/g, '\n');
  } catch { return null; }
}
// Tiers after the review files: files the requirements name, and small neighbours of review files. Source files only (docs, data and tests are not candidates here).
const NOT_CODE = /\.(md|mdx|markdown|rst|txt|json|ya?ml|toml|lock|svg|png|jpe?g|gif|snap)$/i, TESTISH = /(^|[/._-])(test|tests|spec|__tests__)([/._-]|$)/i, SIBLING = 16 * 1024, NAMED_MAX = 8, NAMED_GENERIC = 3, PER_DIR = 3;
const dirOf = (p) => path.posix.dirname(p), stemOf = (p) => path.posix.basename(p).replace(/\.[^.]*$/, '');
function tracked(root) { try { return execFileSync('git', ['ls-files', '-z'], { cwd: root, maxBuffer: 1 << 28, timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'] }).toString().split('\0').filter(Boolean); } catch { return []; } }
function mentioned(text) { // identifiers and path-like tokens (length >= 5, extension dropped) that a requirement text names
  const out = new Set(), add = (s) => { const t = s.replace(/\.[A-Za-z0-9]{1,5}$/, ''); if (t.length >= 5) out.add(t); };
  for (const m of text.matchAll(/`([^`\n]{3,200})`/g)) for (const p of m[1].match(/[\w.\/-]+/g) || []) add(p.split('/').pop());
  for (const m of text.matchAll(/[\w.-]+(?:\/[\w.-]+)+/g)) add(m[0].split('/').pop());
  for (const m of text.matchAll(/\b[A-Za-z][A-Za-z0-9]*(?:[a-z0-9][A-Z]|_)[A-Za-z0-9_]*\b/g)) add(m[0]);
  return [...out];
}
const criteriaText = (raw) => { try { return (JSON.parse(raw).criteria || []).map((c) => `${c?.quote ?? ''} ${c?.text ?? ''}`).join('\n'); } catch { return ''; } };
// Relevant slices of a test file that is larger than its cap: the head (imports, helpers) plus every test block that mentions a symbol the diff introduced or touched, with real line numbers,
// instead of the first N lines (the tests of the changed code sit anywhere in a 3000-line file). ponytail: regex per common language form, no parser; a symbol is found by word, not by use.
const SYM_KW = new Set('this else while switch catch function return constructor await describe test each async static default export import require super throw'.split(' '));
const SYM_DECLS = [
  /\b(?:function\*?|def|func|fn|class|interface|enum)\s+(?:\([^)]*\)\s*)?([A-Za-z_$][\w$]*)/,
  /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=/,
  /\bexports\.([A-Za-z_$][\w$]*)\s*=/,
  /^\s*(?:(?:export|default|public|private|protected|static|async)\s+)*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::[^{]+)?\{\s*$/, // method
];
function symbolsIn(line, add) {
  if (line.length > 300) return;
  for (const re of SYM_DECLS) { const m = re.exec(line); if (m) return void add(m[1]); }
  const ex = /\b(?:module\.exports\s*=|export)\s*\{([^}]*)\}/.exec(line); // module.exports = { a, b } / export { a, b }
  if (ex) for (const n of ex[1].match(/[A-Za-z_$][\w$]*/g) || []) add(n);
}
function diffSymbols(diff, file, leads) { // names on added lines of file (and in the git hunk headers), then the leads.txt symbols of file; length >= 4, at most 40
  const out = new Set(), add = (n) => { if (n && n.length >= 4 && !SYM_KW.has(n) && out.size < 40) out.add(n); };
  let cur = null, inHunk = false;
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('diff --git ')) { cur = null; inHunk = false; continue; }
    const l = raw.replace(/^\s*\d+ \| /, ''); // diff.numbered.txt: "  41 | +code"
    if (!inHunk && l.startsWith('+++ ')) { cur = l === '+++ /dev/null' ? null : l.slice(4).replace(/^"|"$/g, '').replace(/^b\//, ''); continue; }
    const h = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@ ?(.*)$/.exec(l);
    if (h) { inHunk = true; if (cur === file) symbolsIn(h[1], add); } else if (inHunk && cur === file && l[0] === '+') symbolsIn(l.slice(1), add);
  }
  for (const l of leads.split('\n')) { const m = /^\s+(\S+):\d+ (\S+)$/.exec(l); if (m && m[1] === file) add(m[2]); } // "path:line name" rows of leads.txt
  return [...out];
}
function diffSeeds(diff, file) { // 0-based new-file line numbers of the added lines of file (a pure deletion seeds the line after it): the hunks of the diff itself
  const out = new Set();
  let cur = null, c = 0, inHunk = false;
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('diff --git ')) { cur = null; inHunk = false; continue; }
    const l = raw.replace(/^\s*\d+ \| /, '');
    if (!inHunk && l.startsWith('+++ ')) { cur = l === '+++ /dev/null' ? null : l.slice(4).replace(/^"|"$/g, '').replace(/^b\//, ''); continue; }
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
    if (h) { inHunk = true; c = +h[1]; continue; }
    if (!inHunk || cur !== file) continue;
    if (l[0] === '+') out.add(c++ - 1); else if (l[0] === '-') out.add(Math.max(0, c - 1)); else if (l[0] !== '\\') c++;
  }
  return [...out].sort((a, b) => a - b);
}
const TEST_START = /^\s*(?:(?:test|it|describe)\b|def test_|func Test|@Test\b)/, indentOf = (l) => /^\s*/.exec(l)[0].length;
// seeds: 0-based lines of the diff's own hunks, treated like a symbol hit. Priority when room runs out: seed windows, then symbol windows, then the head; position order within a class.
// -> { text, note, complete, coveredTo } or null (no seed or symbol appears in the file, or no matching block fits). complete: every block that mentions a symbol or seed is shown. coveredTo: every seed on lines 1..coveredTo is shown.
function slices(src, syms, room, seeds = [], [back, span] = [30, 80]) { // back, span: the most lines of a window above a hit and in all (a source file needs less than a test block)
  const n = src.length, re = syms.length ? new RegExp(`(?<![\\w$])(?:${syms.map((x) => x.replace(/\$/g, '\\$')).join('|')})(?![\\w$])`, 'g') : null, found = new Set(), wins = [], seedAt = new Set(seeds);
  let truncated = false;
  src.forEach((l, i) => {
    const m = re ? [...l.matchAll(re)].map((x) => x[0]) : [], sd = seedAt.has(i);
    if (!m.length && !sd) return;
    m.forEach((x) => found.add(x));
    let s = i; while (s > 0 && i - s < back && !TEST_START.test(src[s])) s--; // up to the enclosing test start, or 30 lines
    let e = i; while (e + 1 < n && e + 1 - s < span && !(TEST_START.test(src[e + 1]) && indentOf(src[e + 1]) <= indentOf(src[s]))) e++; // down to the next test at the same or lower indentation, 80 lines at most
    if (!TEST_START.test(src[s]) || (e + 1 < n && !(TEST_START.test(src[e + 1]) && indentOf(src[e + 1]) <= indentOf(src[s])))) truncated = true;
    wins.push({ s, e, m: true, k: sd ? 2 : 1 });
  });
  if (!wins.length) return null;
  wins.push({ s: 0, e: Math.min(30, n) - 1, m: false, k: 0 }); // imports and helpers
  wins.sort((a, b) => a.s - b.s || b.e - a.e);
  const merged = [];
  for (const w of wins) { const p = merged[merged.length - 1]; if (p && w.s <= p.e + 1) { p.e = Math.max(p.e, w.e); p.m = p.m || w.m; p.k = Math.max(p.k, w.k); } else merged.push({ ...w }); }
  merged.forEach((w) => { w.s0 = w.e; });
  const body = (w) => Array.from({ length: w.e - w.s + 1 }, (_, k) => `${String(w.s + k + 1).padStart(4)}| ${src[w.s + k]}`).join('\n'), MARK = 40; // MARK: room for an omission marker
  let used = 0, dropped = false;
  const keep = new Set();
  for (const w of [...merged].sort((a, b) => b.k - a.k || a.s - b.s)) { // a window too big for what is left is cut to its first lines (ponytail: a long run of added lines is shown from its top)
    let c = Buffer.byteLength(body(w)) + 1 + MARK;
    if (used + c > room && w.k === 2 && room - used > 400) while (w.e > w.s && used + c > room) { w.e = w.s + Math.floor((w.e - w.s) / 2); c = Buffer.byteLength(body(w)) + 1 + MARK; }
    if (used + c <= room) { used += c; keep.add(w); } else if (w.m) dropped = true;
  }
  const kept = merged.filter((w) => keep.has(w));
  if (!kept.some((w) => w.m)) return null;
  dropped = dropped || kept.some((w) => w.m && w.e < w.s0);
  const cover = (i) => kept.some((w) => w.m && i >= w.s && i <= w.e), miss = seeds.find((i) => !cover(i)), coveredTo = miss === undefined ? n : miss;
  const out = [], gap = (a, b) => out.push(`   …| (lines ${a + 1}-${b} omitted)`);
  let at = 0;
  for (const w of kept) { if (w.s > at) gap(at, w.s); out.push(body(w)); at = w.e + 1; }
  if (at < n) gap(at, n);
  const shown = [...found], names = shown.slice(0, 8).join(', ') + (shown.length > 8 ? ', …' : ''), what = [seeds.length && "the diff's changed lines", shown.length && `tests referencing ${names}`].filter(Boolean).join('; '), ranges = kept.map((w) => `${w.s + 1}-${w.e + 1}`).join(', ');
  return { text: out.join('\n') + '\n', complete: !dropped && !truncated, coveredTo, note: `relevant slices: lines ${ranges} of ${n} (${what})${dropped ? '; some matching tests did not fit' : ''}${truncated ? '; matching tests were truncated at the search window' : ''}, line-numbered` };
}
// A block part's pack (src/scan-parts.js): the files its evidence rows cite, each as line-numbered windows of WIN lines either side of every cited line plus its first HEAD lines (imports), merged when they touch;
// a file that fits the per-file cap is shown whole. locs: Map path -> cited line numbers, in priority order. Partial or omitted files are returned in notWhole for per-block verification (separate from the unit pack-cut.txt). ponytail: no per-file fairness, first files first.
const MIN_CAND = 8 * 1024; // a candidate test's least room, so one early candidate cannot starve the later ones (the total budget still bounds it)
// ponytail: SHARE_AT/SHARE_X were tuned on 9 SpecGuard PRs only (1.5x lost #255 audit-units.js lines); re-tune on a second repo's PRs
const SHARE_AT = 0.5, SHARE_X = 2; // review files together over SHARE_AT of the pack: each is given SHARE_X times a fair share of what is left (its hunks need more than its tests)
const WIN = 40, HEAD = 15, UNIT_SYMS = 150; // UNIT_SYMS: names of a unit part searched for in its tests
function windowPack(root, locs, limit) {
  const cap = fileCap(limit), parts = [], notWhole = [];
  let used = 0;
  for (const [rel, at] of locs) {
    const text = packRead(root, rel), room = Math.min(cap, limit - used - OVERHEAD);
    if (text === null || room < 200) { notWhole.push(rel); continue; }
    if (!text.trim()) continue;
    const src = text.replace(/\n$/, '').split('\n'), n = src.length, row = (i) => `${String(i + 1).padStart(4)}| ${src[i]}`;
    const whole = src.map((_, i) => row(i)).join('\n') + '\n';
    let body, note;
    if (Buffer.byteLength(whole) <= room) { body = whole; note = 'full file, line-numbered'; } else {
      notWhole.push(rel);
      const wins = [[0, Math.min(HEAD, n) - 1], ...at.map((l) => [Math.max(0, l - 1 - WIN), Math.min(n - 1, l - 1 + WIN)])].sort((a, b) => a[0] - b[0]), merged = [];
      for (const w of wins) { const p = merged[merged.length - 1]; if (p && w[0] <= p[1] + 1) p[1] = Math.max(p[1], w[1]); else merged.push([...w]); }
      const out = []; let next = 0, size = 0;
      for (const [a, z] of merged) {
        const c = Array.from({ length: z - a + 1 }, (_, k) => row(a + k)).join('\n'), cost = Buffer.byteLength(c) + 50;
        if (size + cost > room) break;
        size += cost; if (a > next) out.push(`   …| (lines ${next + 1}-${a} omitted)`); out.push(c); next = z + 1;
      }
      if (!out.length) continue;
      if (next < n) out.push(`   …| (lines ${next + 1}-${n} omitted)`);
      body = out.join('\n') + '\n'; note = `relevant windows around the cited lines (${at.join(', ')}) of ${n}, line-numbered; "…| (lines a-b omitted)" marks the gaps`;
    }
    const b = block(rel, body, note); parts.push(b); used += Buffer.byteLength(b);
  }
  return { text: parts.length ? `Repository files (the code and tests cited by the candidate blocks' evidence rows; a file noted "relevant windows" shows the lines around each cited line):\n\n${parts.join('\n\n')}` : '', note: '', notWhole };
}

// The evidence of candidate blocks (audit-evidence.txt rows: cid, kind, path:line, text) as windows around the cited lines, code first, then tests. One path for the single call (contextPack) and the block parts (src/scan-parts.js). skip: files already shown whole. blockCuts: cid -> its cited files that are not shown whole (post-processing turns a missing/absent claim of that block into unknown).
function evidencePack(root, rows, limit, skip = new Set()) {
  const locs = new Map(), cited = new Map();
  for (const kind of ['code', 'test']) for (const l of rows) {
    const c = l.split('\t'), x = c[2] || '', k = x.lastIndexOf(':'), file = x.slice(0, k);
    if (k <= 0) continue;
    if (c[1] === kind && !skip.has(file)) locs.set(file, [...(locs.get(file) || []), parseInt(x.slice(k + 1), 10) || 1]);
    if (kind === 'code') cited.set(c[0], new Set([...(cited.get(c[0]) || []), file]));
  }
  if (limit <= 0) return { text: '', note: '', notWhole: [], blockCuts: {} };
  const p = windowPack(root, locs, limit), cut = new Set(p.notWhole), blockCuts = {};
  for (const [cid, files] of cited) { const missing = [...files].filter((f) => cut.has(f)); if (missing.length) blockCuts[cid] = missing; }
  return { ...p, blockCuts };
}

// What a pack that threw would have carried: the review files and their candidate tests (scan: the unit files and their matched tests). Written as pack-cut.txt so post.js treats them as unseen, not as fully seen.
function packFiles(ctx) {
  const list = (n) => { try { return fs.readFileSync(path.join(ctx, n), 'utf8').replace(/\r\n/g, '\n').split('\n').filter(Boolean); } catch { return []; } };
  const units = list('audit-units.txt').map((l) => l.split('\t')).filter((u) => u[1]);
  if (units.length) return [...new Set(units.flatMap((u) => [u[1], ...(u[4] && u[4] !== 'none' ? u[4].split(', ') : [])]))];
  const cands = parseCandidates(list('test-candidates.txt').join('\n')), focus = list('focus.txt').map((l) => l.split('\t')[0]), review = focus.length ? focus : list('files.txt');
  return [...new Set(review.flatMap((p) => [p, ...(cands.get(p) || [])]))];
}

function contextPack(ctx, root, limit) {
  const rd = (n) => { try { return fs.readFileSync(path.join(ctx, n), 'utf8').replace(/\r\n/g, '\n'); } catch { return ''; } };
  const list = (n) => rd(n).split('\n').filter(Boolean);
  const parts = [], seen = new Set(), whole = new Set(), omitted = [], partial = [], shown = new Map(); // partial: cut at the budget; shown: path -> lines shown, for a file cut from the top (post.js checks the changed lines against it)
  let used = 0, files = 0;
  const cap = fileCap(limit);
  const addFile = (p, num, quiet, syms, top = limit, part = null, incomplete = false, seeds = null, win) => { // part: { k, n, a, b } a scan unit reviewed in parts (audit-units.txt): only lines a-b are shown // num: line-numbered; syms: changed symbols, for a candidate test of a review file (shown as relevant slices when over its cap); quiet: a file of the extra tiers, never listed as cut or omitted and kept within 60% of the budget so the diff rest and requirement documents still fit
    const rel = path.posix.normalize(p.replace(/\\/g, '/'));
    if (seen.has(rel)) return;
    seen.add(rel);
    const text = packRead(root, rel);
    if (text === null) return void (quiet || omitted.push(rel));
    if (!text.trim()) return;
    const cand = syms && !quiet && !seeds, room = Math.min(num ? cap : PER_FILE, cand ? Math.max(top - used, MIN_CAND) - OVERHEAD : (quiet ? limit * 0.6 : top) - used - OVERHEAD, limit - used - OVERHEAD), src = text.replace(/\n$/, '').split('\n');
    if (room < 200) return void (quiet || omitted.push(rel));
    if (part) { // this run's window of a unit too large for one call (review F07); its other parts are reviewed in other runs, so it is not listed as cut
      const c = cut(src.slice(part.a - 1, part.b).map((l, i) => `${String(part.a + i).padStart(4)}| ${l}`).join('\n') + '\n', room);
      if (c.cut && c.lines < 1) return void (quiet || omitted.push(rel));
      if (c.cut && !quiet) partial.push(rel);
      const b = block(rel, c.text, `part ${part.k + 1} of ${part.n}: lines ${part.a}-${c.cut ? part.a + c.lines - 1 : part.b} of ${src.length}, line-numbered; the other parts are reviewed in other runs`);
      parts.push(b); used += Buffer.byteLength(b); files++;
      return;
    }
    const full = num ? src.map((l, i) => `${String(i + 1).padStart(4)}| ${l}`).join('\n') + '\n' : text;
    const over = Buffer.byteLength(full) > room, sl = over && ((syms && syms.length) || (seeds && seeds.length)) ? slices(src, syms || [], room, seeds || [], win) : null;
    if (over && cand && !sl) return void omitted.push(rel); // a candidate test over its room with no hit that fits: unseen, never a head that only looks like evidence
    if (sl) {
      if (seeds) { partial.push(rel); shown.set(rel, sl.coveredTo); } else // pack-cut.txt: not listed when every test that mentions the changed symbols is shown (its relevant tests were visible); listed when some matching block did not fit
      if ((!sl.complete || incomplete) && !quiet) partial.push(rel); // incomplete: more symbols than were searched for
      const b = block(rel, sl.text, sl.note);
      parts.push(b); used += Buffer.byteLength(b); files++;
      return;
    }
    const c = cut(full, room);
    if (c.cut && c.lines < 1) return void (quiet || omitted.push(rel));
    if (c.cut && !quiet) { partial.push(rel); shown.set(rel, c.lines); }
    if (!c.cut && num) whole.add(rel);
    const b = block(rel, c.text, `${c.cut ? `first ${c.lines} of ${src.length} lines` : 'full file'}${num ? ', line-numbered' : ''}`);
    parts.push(b); used += Buffer.byteLength(b); files++;
  };
  for (const p of list('standards.txt')) addFile(p, false);
  const focus = list('focus.txt').map((l) => l.split('\t')[0]);
  // scan mode (audit-units.txt: id, path, risk, why, matched tests, leads): the selected units are the review set and their matched tests their candidate tests
  const units = new Map(list('audit-units.txt').map((l) => l.split('\t')).filter((u) => u[1]).map((u) => [u[1], u[4] && u[4] !== 'none' ? u[4].split(', ') : []])), review = units.size ? [...units.keys()] : focus.length ? focus : list('files.txt');
  const cands = parseCandidates(rd('test-candidates.txt'));
  const numbered = rd('diff.numbered.txt'), dname = numbered.trim() ? 'diff.numbered.txt' : 'diff.patch', diff = numbered.trim() ? numbered : rd('diff.patch'), leads = rd('leads.txt');
  const unitSymbols = (p) => { const out = new Set(), part = unitPart.get(p); let capped = false; const add = (n) => { if (n && n.length >= 4 && !SYM_KW.has(n)) { if (out.size < UNIT_SYMS) out.add(n); else if (!out.has(n)) capped = true; } }; for (const l of (packRead(root, p) || '').split('\n').slice(part ? part.a - 1 : 0, part ? part.b : undefined)) symbolsIn(l, add); const syms = [...out]; syms.capped = capped; return syms; }; // names the unit defines in this run's part (all of the file when it is not in parts): a big test file is shown as the tests that mention them; capped: more names than UNIT_SYMS, so the file is listed as cut
  const packTests = new Map(list('audit-units.txt').map((l) => l.split('\t')).filter((u) => u[1] && u[8]).map((u) => [u[1], u[8] === '-' ? [] : u[8].split(', ')])); // a unit with more tests than its share of the pack: the collector's list of the ones to load (audit-units.js room.trim)
  const unitPart = new Map(list('audit-units.txt').map((l) => l.split('\t')).map((u) => [u[1], /^part (\d+)\/(\d+) lines (\d+)-(\d+)$/.exec(u[7] || '')]).filter((x) => x[1]).map(([p, w]) => [p, { k: +w[1] - 1, n: +w[2], a: +w[3], b: +w[4] }]));
  if (units.size) for (const p of review) addFile(p, true, false, null, limit, unitPart.get(p)); // scan: every unit file first, so no test starves a later unit (addFile skips a file already added)
  const symsOf = new Map(review.map((p) => [p, units.size ? unitSymbols(p) : diffSymbols(diff, path.posix.normalize(p.replace(/\\/g, '/')), leads)])), testsOf = (p) => (units.size ? packTests.get(p) || units.get(p) : cands.get(p)) || [], shared = new Map(), hunk = units.size ? new Map() : require('../test-map.js').hunkTokens(rd('diff.patch')); // hunk: file -> identifiers on its changed lines (the collector ranks candidate tests by them); shared: a test -> the union of the symbols of every review file that lists it (it is added once, for the first of them, so it must be sliced for all)
  for (const p of review) for (const t of testsOf(p)) { const u = shared.get(t) || Object.assign(new Set(), { capped: false }); symsOf.get(p).forEach((n) => u.add(n)); (hunk.get(path.posix.normalize(p.replace(/\\/g, '/'))) || []).forEach((n) => u.add(n)); u.capped ||= !!symsOf.get(p).capped; shared.set(t, u); }
  const tight = !units.size && review.reduce((n, p) => n + Math.min(cap, Buffer.byteLength(packRead(root, p) || '')), 0) > limit * SHARE_AT; // the review files together would fill the pack: each gets a fair share too (shown as slices around its hunks when over it), else the early ones starve the later files and their tests
  review.forEach((p, i) => { const sd = units.size ? null : diffSeeds(diff, path.posix.normalize(p.replace(/\\/g, '/'))), share = tight && sd && sd.length, hunks = share && !TESTISH.test(p); // share: a file with changed lines is cut to its share; hunks: a source file is then shown as its hunks with a little context (a test file keeps its symbol windows)
    addFile(p, true, false, units.size ? null : hunks ? [] : symsOf.get(p), share ? used + SHARE_X * (limit - used) / (review.length - i) : limit, unitPart.get(p), false, sd, hunks ? [10, 30] : undefined); const top = Math.min(limit, used + (limit - used) / (review.length - i)); for (const t of testsOf(p)) { const u = shared.get(t), own = !units.size && review.includes(t); addFile(t, true, false, own ? symsOf.get(t) : [...u], own ? Math.max(top, used + MIN_CAND) : top, null, !own && u.capped, own ? diffSeeds(diff, path.posix.normalize(t.replace(/\\/g, '/'))) : null); } }); // own: a changed test file reached first as a candidate is added as the review loop adds it (its own symbols and diff hunks), else its hunks would never be seeded // each file, then its tests (a big test as slices around the changed symbols), together within a fair share of what is left so the later review files still fit
  for (const [p, keep] of packTests) for (const t of units.get(p) || []) if (!keep.includes(t) && !partial.includes(t)) partial.push(t); // counted out by the collector: not shown, so listed as cut
  const ls = tracked(root), code = ls.filter((p) => !NOT_CODE.test(p) && !TESTISH.test(p)); // a: files the requirements name (by file name or by folder name), at most NAMED_MAX, with their tests; tokens that match too many files are generic
  if (ls.length) {
    const named = [], crit = criteriaText(rd('requirements-status.json'));
    for (const t of mentioned(`${rd('requirements.md')}\n${crit}`)) {
      const m = code.filter((p) => stemOf(p) === t || path.posix.basename(dirOf(p)) === t);
      if (m.length && m.length <= NAMED_GENERIC) for (const p of m) if (!named.includes(p) && named.length < NAMED_MAX) named.push(p);
    }
    for (const p of named) { addFile(p, true, true); const own = cands.get(p) || ls.filter((q) => dirOf(q) === dirOf(p) && !NOT_CODE.test(q) && /(^|\/)(test\.[^/]*|[^/]*\.(test|spec)\.[^/]*)$/.test(q)); for (const t of own) addFile(t, true, true); }
    for (const d of new Set(review.map((p) => dirOf(path.posix.normalize(p.replace(/\\/g, '/')))))) { // b: the smallest other source files beside a review file
      const sib = code.filter((p) => dirOf(p) === d && !seen.has(p)).map((p) => { try { return [p, fs.statSync(path.join(root, p)).size]; } catch { return [p, Infinity]; } }).filter((x) => x[1] <= SIBLING).sort((x, y) => x[1] - y[1]);
      for (const [p] of sib.slice(0, PER_DIR)) addFile(p, true, true);
    }
  }
  const head = cut(diff, LIMITS.diff);
  if (head.cut && limit - used - OVERHEAD >= 200) { // the part of the diff prompt.js cut ("Read ... for the rest")
    const dl = diff.replace(/\n$/, '').split('\n'), c = cut(dl.slice(head.lines).join('\n'), limit - used - OVERHEAD), all = dl.length;
    if (c.lines > 0) { const b = block(`${dname} (rest)`, c.text, `lines ${head.lines + 1} to ${head.lines + c.lines} of ${all}; continues the diff block above${c.cut ? '; cut at the context budget' : ''}`); parts.push(b); used += Buffer.byteLength(b); }
  }
  const ev = evidencePack(root, list('audit-evidence.txt'), Math.max(limit - used, 1), whole); // single-call scan: the evidence files of the candidate blocks, as the block parts load them (a file shown only as slices or a head is windowed again)
  if (ev.text) { parts.push(ev.text); used += Buffer.byteLength(ev.text); files++; }
  for (const p of ev.notWhole) if (!partial.includes(p)) partial.push(p);
  for (const p of list('spec-files.txt')) addFile(p, false);
  const text = parts.length ? `Repository files (read from the checked-out repository; rule files, each file under review followed by its candidate tests, files the requirements name and small neighbours of reviewed files, the rest of a cut diff, requirement documents):\n\n${parts.join('\n\n')}` : '';
  const note = files || omitted.length ? `context pack: ${files} files, ${Math.round(used / 1024)} KB${omitted.length ? `; not included: ${omitted.slice(0, 4).join(', ')}${omitted.length > 4 ? ` (+${omitted.length - 4} more)` : ''}` : ''}` : '';
  return { text, note, notWhole: [...partial, ...omitted], blockCuts: ev.blockCuts, shown };
}

const tokenRe = /github_pat_[A-Za-z0-9_]+|gh[pousr]_[A-Za-z0-9]+|sk-ant-[A-Za-z0-9_-]+|Bearer [^\s]+/g;
const plural = (n, one) => `${n} ${one}${n === 1 ? '' : 's'}`;
const fmt = (x) => x.toFixed(x < 0.1 ? 4 : 2);

// ponytail: substring table over the API's error type and message; first match wins. Same reasons as claude.sh (budget, quota, auth, rate, model).
function classify(status, type = '', message = '') {
  const t = `${type} ${message}`;
  if (status === 402 || /billing_error|credit balance/i.test(t)) return ['quota', 'The Anthropic account has no credit left or hit its quota (add credits to the API account; this is not the per-run budget)'];
  if (status === 403 || /permission_error/i.test(t)) return ['auth', 'The Anthropic API key lacks permission for this model or workspace (check the llm_token secret and the model input)'];
  if (status === 401 || /authentication_error|invalid x-api-key/i.test(t)) return ['auth', 'The Anthropic API key was rejected (check the llm_token secret)'];
  if (status === 429 || status === 529 || /rate_limit|overloaded/i.test(t)) return ['rate', 'Anthropic rate limit or overload; the next push retries'];
  if (status === 404 || /model.*(not found|not available|does not exist)|invalid model|issue with the selected model/i.test(message)) return ['model', null]; // text needs the model name
  return ['', null];
}

async function run(env = process.env, { fetchFn = globalThis.fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const ctx = env.CTX, key = env.ANTHROPIC_API_KEY || '';
  const scrub = (s) => { let x = String(s); if (key) x = x.split(key).join('***'); return x.replace(tokenRe, '***'); };
  const w = (n, s) => fs.writeFileSync(path.join(ctx, n), s);
  fs.mkdirSync(ctx, { recursive: true });
  const notes = [];
  if (env.EFFORT) notes.push('effort ignored: claude engine');
  const end = (status, reason, why, raw) => { // status: failed | timeout | success
    if (status !== 'success') w('engine-status', status);
    if (reason) w('engine-error', `${reason}\n${why}\n`);
    if (why) notes.unshift(`${why}${raw ? `: ${scrub(raw).slice(0, 200)}` : ''}`);
    w('engine-notes', notes.map((n) => scrub(n).slice(0, 300)).join('\n') + (notes.length ? '\n' : ''));
    if (status === 'timeout') console.log('::warning::Claude review timed out');
    else if (status === 'failed') { // the class and the HTTP status, never the response body
      const http = /^HTTP (\d+)/.exec(raw || '')?.[1], tag = [reason, http && `HTTP ${http}`].filter(Boolean).join(', ');
      console.log(`::warning::Claude review failed${tag ? ` (${tag})` : ''}${why ? `: ${scrub(why)}` : ''}`);
    }
  };
  try {
    if (!key) return end('failed', 'auth', 'No API key was provided (set llm_token)', 'no ANTHROPIC_API_KEY in the environment');
    const prompt = env.PROMPT_FILE ? fs.readFileSync(env.PROMPT_FILE, 'utf8') : env.PROMPT || '';
    const model = env.MODEL || 'claude-haiku-5-5';
    const maxTokens = parseInt(env.MAX_OUTPUT_TOKENS, 10) || 32000, budget = parseFloat(env.MAX_BUDGET_USD || '1.00');
    const schemaFile = path.join(__dirname, '..', env.CHECK === 'audit' ? 'audit.schema.json' : 'findings.schema.json');
    const schema = strict(JSON.parse(fs.readFileSync(schemaFile, 'utf8')));
    let packBytes;
    try { packBytes = packLimit(env); } catch (e) { return end('failed', 'config', e.message); }
    if (env.CHECK === 'audit' && packBytes === 0) return end('failed', 'config', 'context_pack_bytes=0 sends the model no repository files, so a scan would publish without any source reviewed; use a positive value'); // PR mode keeps 0 = diff only
    const root = () => fs.realpathSync(env.GITHUB_WORKSPACE || process.cwd());
    const deadline = Date.now() + (parseInt(env.TIMEOUT, 10) || 12) * 60000, t0 = Date.now();
    // One API call with its retries: { timeout } or { res }. Each call asks for plain JSON at most once and retries a transient failure once.
    const send = async (body) => {
      let res, retried = false, plain = false;
      for (;;) {
        const left = deadline - Date.now();
        if (left < 1000) return { timeout: true };
        try {
          const r = await fetchFn(ENDPOINT, { method: 'POST', headers: { 'x-api-key': key, 'anthropic-version': API_VERSION, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(left) });
          const text = await r.text();
          let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
          res = { status: r.status, ok: r.ok, json, text, retryAfter: parseFloat(r.headers?.get?.('retry-after')) };
        } catch (e) {
          if (e?.name === 'TimeoutError' || e?.name === 'AbortError') return { timeout: true };
          res = { status: 0, ok: false, json: null, text: `network error: ${e?.cause?.code || e?.message || e}` };
        }
        if (res.ok) return { res };
        const m = String(res.json?.error?.message || '');
        if (res.status === 400 && !plain && /schema|output_config|output_format|too complex/i.test(m) && !/credit balance/i.test(m)) { // the structured-output grammar was refused: ask for plain JSON once (post.js validates it)
          plain = true; delete body.output_config; console.error(`claude-api: structured output unavailable (${scrub(m).replace(/\s+/g, ' ').slice(0, 300)}); plain JSON requested`); continue;
        }
        const wait = Number.isFinite(res.retryAfter) ? res.retryAfter : 2;
        if (!retried && (res.status === 0 || res.status === 429 || res.status >= 500) && wait <= 30 && deadline - Date.now() > wait * 1000 + 1000) { retried = true; await sleep(wait * 1000); continue; }
        return { res };
      }
    };
    // One call -> { ok: true, found, u, used } or { ok: false, status, reason, why, raw, u? }; u = the API usage object once a reply arrived (paid for even when the answer is unusable).
    const call = async (system, user, maxTok) => {
      const s = await send({
        model, max_tokens: maxTok,
        ...(system && { system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }] }),
        messages: [{ role: 'user', content: user }],
        output_config: { format: { type: 'json_schema', schema } },
      });
      if (s.timeout) return { ok: false, status: 'timeout' };
      const res = s.res;
      if (!res.ok) {
        const e = res.json?.error || {}, raw = `HTTP ${res.status || 'none'}${e.type ? ` ${e.type}` : ''}: ${e.message || res.text}`.replace(/\s+/g, ' ');
        const [reason, why] = classify(res.status, e.type, e.message);
        return { ok: false, status: 'failed', reason, why: reason === 'model' ? `The model '${model}' is not available to this API key (check the model input)` : why || `Anthropic API request failed`, raw };
      }
      const j = res.json || {}, r = { u: j.usage || {}, used: typeof j.model === 'string' && j.model ? j.model : model };
      if (j.stop_reason === 'refusal') return { ...r, ok: false, status: 'failed', reason: 'policy', why: 'The model declined to answer (safety refusal)' };
      if (j.stop_reason === 'max_tokens') return { ...r, ok: false, status: 'failed', reason: 'length', why: `The reply hit max_output_tokens (${maxTok}) before the JSON was complete (raise max_output_tokens)` };
      const answer = (Array.isArray(j.content) ? j.content : []).filter((b) => b?.type === 'text').map((b) => b.text).join('');
      let found; try { found = JSON.stringify(JSON.parse(answer)); } catch { found = require('../extract-json.js').extract(answer); }
      if (!found) { try { w('engine-raw-answer.txt', scrub(answer).slice(0, 200000)); notes.push('raw answer kept in engine-raw-answer.txt'); } catch { /* ctx unwritable */ } } // diagnosis only; the failure below is unchanged
      return found ? { ...r, ok: true, found } : { ...r, ok: false, status: 'failed', reason: '', why: 'no JSON found in the engine output' };
    };
    // usage.json: cost and tokens of every reply received, summed (each priced on its own card)
    const writeUsage = (rs) => {
      const got = rs.filter((x) => x.u);
      if (!got.length) return;
      const guessed = rs.filter((x) => !known(x.u));
      const sum = { i: 0, cr: 0, cw: 0, o: 0 }, by = {};
      let usd = 0;
      for (const r of got) {
        const i = r.u.input_tokens || 0, cr = r.u.cache_read_input_tokens || 0, cw = r.u.cache_creation_input_tokens || 0, o = r.u.output_tokens || 0, m = (by[r.used] ||= { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 });
        usd += charge(r); sum.i += i; sum.cr += cr; sum.cw += cw; sum.o += o;
        m.inputTokens += i + cr + cw; m.cacheReadTokens += cr; m.cacheWriteTokens += cw; m.outputTokens += o; // the copilot shape: inputTokens include the cache tokens
      }
      usd += guessed.filter((x) => !x.u).reduce((a, x) => a + charge(x), 0); // no reply at all
      if (guessed.length) notes.push(`usage unknown for ${guessed.length} call(s): charged their worst-case reserve`);
      w('usage.json', JSON.stringify({
        currentModel: got[0].used, totalCostUsd: usd, ...(guessed.length && { costEstimated: true }), totalApiDurationMs: Date.now() - t0,
        tokenDetails: { input: { tokenCount: sum.i }, cache_read: { tokenCount: sum.cr }, cache_write: { tokenCount: sum.cw }, output: { tokenCount: sum.o } },
        modelMetrics: Object.fromEntries(Object.entries(by).map(([m, usage]) => [m, { usage }])),
      }));
      try { require('../engine-model.js').run({ ctx, requested: model, turn: 'main', usage: path.join(ctx, 'usage.json'), fast: env.FAST_MODELS || '' }); } catch { /* never fails the step */ }
    };
    const failEnd = (r) => (r.status === 'timeout' ? end('timeout') : end('failed', r.reason, r.why, r.raw));
    if (!PRICES[model]) notes.push(`cost estimated at default rates: ${model} is not in the price table`);

    // A scan with more document blocks than SCAN_BATCH_BLOCKS (default 20) is split into budgeted parts (src/scan-parts.js): one unit call and block calls, answers merged here. Fewer blocks: one call, below.
    const batch = Math.max(1, parseInt(env.SCAN_BATCH_BLOCKS, 10) || 20), split = env.CHECK === 'audit' ? require('../scan-parts.js').plan({ ctx, root: root(), batch, limit: packBytes, schemaFile, contextPack, evidencePack, assembleAudit: require('../prompt.js').assembleAudit }) : null;
    if (split) {
      const priced = (p) => pricePart(model, maxTokens, p);
      const { plans, dropped, droppedKeys } = fit(split.parts.filter((p) => !p.extra).map(priced), budget), total = () => plans.reduce((a, p) => a + p.usd, 0), firstUsd = plans[0].usd;
      // extras: unit calls the worst case did not plan (the collector's breadth-first queue). Admitted one by one after the planned calls, only while actual spend + the part's worst case fits the budget; ponytail: none when the plan itself had to drop a part
      const extras = droppedKeys.length || dropped.length ? [] : split.parts.filter((p) => p.extra).map(priced), skippedEx = droppedKeys.length || dropped.length ? split.parts.filter((p) => p.extra) : [];
      if (total() > budget) return end('failed', 'budget', `estimated worst-case cost $${fmt(firstUsd)} for the first part of the scan exceeds max_budget_usd $${fmt(budget)} (raise max_budget_usd or scan_batch_blocks smaller, lower max_output_tokens or use a cheaper model)`);
      const rs = [], failed = [], merged = { docs_reviewed: [], requirements: [], not_requirements: [], unit_findings: [], not_reviewed: [] };
      let first = null, ok = 0, splits = 0, cfg = null; // cfg: the first part that failed on a configuration class
      const blockCuts = {};
      const queue = [...plans], retried = [], spent = () => rs.reduce((a, x) => a + charge(x), 0), fail = (p, reason, cids = p.cids) => failed.push({ part: p.cids ? 'blocks' : 'units', ...(p.cids ? { blocks: cids } : { units: p.units, ...(p.keys && { keys: p.keys }) }), reason });
      for (;;) {
        while (!queue.length && extras.length) { const x = extras.shift(); if (spent() + x.usd <= budget) { plans.push(x); queue.push(x); } else skippedEx.push(x); }
        if (!queue.length) break;
        const p = queue.shift();
        const r = await call(p.system, p.user, p.tokens);
        r.usd = p.usd; // the worst case of this part: what an attempt with unknown usage is charged
        rs.push(r);
        if (!r.ok && r.reason === 'length' && p.cids && p.cids.length > 1) { // the reply overflowed: run the two halves as parts of their own, if the budget still covers them
          const h = Math.ceil(p.cids.length / 2), halves = [p.cids.slice(0, h), p.cids.slice(h)].map((c) => priced({ ...split.sub(c), retry: p.retry })), spent = rs.reduce((a, x) => a + charge(x), 0);
          if (spent + queue.reduce((a, x) => a + x.usd, 0) + halves.reduce((a, x) => a + x.usd, 0) <= budget) { splits++; queue.unshift(...halves); continue; }
          fail(p, `${r.why}; not split: the halves would exceed max_budget_usd`); first ||= r; continue;
        }
        let obj = null, why = r.ok ? '' : r.why || r.status;
        if (r.ok) { try { obj = JSON.parse(r.found); } catch { /* extract-json gave text that is not an object */ } if (!obj || typeof obj !== 'object' || Array.isArray(obj)) { obj = null; why = 'the answer was not a JSON object'; } }
        const arr = (k) => (obj && Array.isArray(obj[k]) ? obj[k] : []);
        let unanswered = [];
        if (obj && p.cids) { // a block call that left more than 20% of its blocks unanswered (any, in a retry part): its answers are kept, the unanswered ones go back on the queue once as a part of their own
          const got = new Set([...arr('requirements').map((x) => /^[0-9a-f]{8}/.exec(String(x?.id))?.[0]), ...arr('not_requirements').map((x) => x?.cid)]);
          unanswered = p.cids.filter((c) => !got.has(c));
          if (unanswered.length <= (p.retry ? 0 : p.cids.length * 0.2)) unanswered = [];
        }
        if (!obj) { fail(p, why); if (['auth', 'quota', 'model', 'policy'].includes(r.reason)) cfg ||= r; first ||= r.ok ? { status: 'failed', reason: '', why } : r; if (r.status === 'timeout') break; continue; }
        ok++;
        if (p.cids) Object.assign(blockCuts, p.blockCuts);
        if (p.cids) merged.requirements.push(...arr('requirements')), merged.not_requirements.push(...arr('not_requirements'));
        else merged.unit_findings.push(...arr('unit_findings'));
        merged.docs_reviewed.push(...arr('docs_reviewed').filter((d) => !merged.docs_reviewed.includes(d)));
        merged.not_reviewed.push(...arr('not_reviewed'));
        if (unanswered.length) {
          const why = `${unanswered.length} of ${p.cids.length} blocks were not answered`;
          if (p.retry) { fail(p, `${why} in two attempts`, unanswered); continue; }
          const again = priced({ ...split.sub(unanswered), retry: true }), spent = rs.reduce((a, x) => a + charge(x), 0);
          if (spent + queue.reduce((a, x) => a + x.usd, 0) + again.usd > budget) { fail(p, `${why}; not retried: the retry would exceed max_budget_usd`, unanswered); continue; }
          retried.push(unanswered); queue.push(again);
        }
      }
      writeUsage(rs);
      skippedEx.push(...extras); // a timeout leaves the rest unadmitted
      const dropKeys = [...droppedKeys, ...skippedEx.flatMap((q) => q.keys || [])], seen = new Set(plans.flatMap((q) => q.units || [])), idOf = (k) => k.split(':')[0], droppedUnits = [...new Set(dropKeys.map(idOf).filter((u) => !seen.has(u)))], droppedParts = dropKeys.filter((k) => seen.has(idOf(k))); // a unit with a part in a call that ran or was admitted was reached: its dropped parts are named on their own
      for (const p of queue) fail(p, 'not started: the review timed out'); // a timeout stops the run: the parts not started are not audited either
      if (!ok) return failEnd(first); // nothing usable at all: the run fails as one call would
      w('findings.json', JSON.stringify(merged));
      w('scan-parts.json', JSON.stringify({ calls: rs.length, ...(splits && { splits }), ...(retried.length && { retried }), failed, dropped, ...(droppedUnits.length && { droppedUnits }), ...(droppedParts.length && { droppedParts }), ...(Object.keys(blockCuts).length ? { blockCuts } : {}) }));
      const seenParts = plans.filter((p) => p.units && !failed.some((x) => x.part === 'units' && x.units === p.units)); // the unit parts that answered: their packs are what the unit findings may rely on
      if (seenParts.length) w('pack-cut.txt', [...new Set(seenParts.flatMap((p) => p.pack.notWhole))].map((x) => `${x}\n`).join(''));
      notes.push(`scan in ${rs.length} calls${splits ? ` (${plural(splits, 'part')} split after max_output_tokens)` : ''}${retried.length ? `; ${plural(retried.reduce((a, c) => a + c.length, 0), 'unanswered block')} sent again once` : ''}${failed.length ? `; ${plural(failed.length, 'part')} failed` : ''}${dropped.length ? `; ${plural(dropped.length, 'block')} left for the next run (max_budget_usd)` : ''}${droppedUnits.length ? `; ${plural(droppedUnits.length, 'unit')} not reached (max_budget_usd), due again` : ''}${droppedParts.length ? `; ${plural(droppedParts.length, 'unit part')} not reached (max_budget_usd)` : ''}`);
      for (const f of failed) notes.push(`${f.part === 'units' ? 'unit part' : plural(f.blocks.length, 'block')} not audited: ${f.reason}`);
      if (cfg) w('engine-error', `${cfg.reason}\n${cfg.why}; ${ok} of ${ok + failed.length} parts were reviewed\n`); // still a partial success, but the account problem must reach the job gate (src/fail-on-error.js)
      return end('success');
    }

    let pack = { text: '', note: '' };
    if (packBytes > 0) try { pack = contextPack(ctx, root(), packBytes); w('pack-cut.txt', pack.notWhole.map((x) => `${x}
`).join('')); w('pack-shown.txt', [...pack.shown].map(([x, n]) => `${x}	${n}
`).join('')); if (Object.keys(pack.blockCuts || {}).length) w('scan-parts.json', JSON.stringify({ blockCuts: pack.blockCuts })); } catch (e) { console.log(`::warning::Context pack failed (${scrub(String(e?.message ?? e).split('\n')[0])}); the files it would have carried are listed as cut`); try { w('pack-cut.txt', packFiles(ctx).map((x) => `${x}\n`).join('')); } catch { /* ctx unwritable */ } } // pack-cut.txt: files the model did not see whole; post.js distrusts missing/weak-test claims about them
    const { system, user } = messages(prompt, pack.text); // the pre-flight below sees the pack
    const est = worstCase(model, Buffer.byteLength(system), Buffer.byteLength(user), maxTokens);
    if (est.usd > budget) { // the budget is hard here: nothing is sent
      const why = `estimated worst-case cost $${fmt(est.usd)} exceeds max_budget_usd $${fmt(budget)} (about ${Math.round(est.tokens / 1000)}k input tokens and up to ${maxTokens} output tokens on ${model}; raise max_budget_usd, lower max_output_tokens or use a cheaper model)`;
      return end('failed', 'budget', why);
    }
    if (pack.note) notes.push(pack.note);
    const r = await call(system, user, maxTokens);
    writeUsage([r]);
    if (!r.ok) return failEnd(r);
    w('findings.json', r.found);
    end('success');
  } catch (e) {
    end('failed', 'internal', 'Claude API adapter error', e?.message || String(e)); // our own code threw: a class of its own, so the last step goes red
  }
}

// A scan part with its worst-case price. A batch of n blocks needs about 1500 tokens each (20 blocks overflowed 22000 live).
const pricePart = (model, maxTokens, p) => {
  const { system: s, user: x } = messages(p.prompt, p.pack.text), tokens = p.cids ? Math.min(maxTokens, 1500 * p.cids.length + 2000) : maxTokens;
  return { ...p, system: s, user: x, tokens, usd: worstCase(model, Buffer.byteLength(s), Buffer.byteLength(x), tokens).usd };
};
// The budget is hard: the last part goes first (the extra unit parts, then the block batches in reverse candidate order = rotation priority), the first part last. -> the parts that stay, the dropped block cids and the dropped unit keys (id or id:part).
function fit(all, budget) {
  const plans = all.slice(), dropped = [], droppedKeys = [], total = () => plans.reduce((a, p) => a + p.usd, 0);
  while (plans.length > 1 && total() > budget) { const q = plans.pop(); dropped.unshift(...q.cids || []); droppedKeys.unshift(...q.keys || []); }
  return { plans, dropped, droppedKeys };
}
// What the pre-flight of a scan over this ctx keeps (the collector calls it, so the units it picks are the units the engine will afford): { rooms: unit calls kept, blockUsd: what the block calls cost } or null (one call, or no way to tell).
function keptRooms({ ctx, root, batch, model, maxTokens, budget, packBytes }) {
  try {
    const split = require('../scan-parts.js').plan({ ctx, root, batch, limit: packBytes, schemaFile: path.join(__dirname, '..', 'audit.schema.json'), contextPack, evidencePack, assembleAudit: require('../prompt.js').assembleAudit });
    if (!split) return null;
    const all = split.parts.filter((p) => !p.extra).map((p) => pricePart(model, maxTokens, p)); // the extras are admitted at run time, never planned
    return { rooms: fit(all, budget).plans.filter((p) => p.units).length, blockUsd: all.filter((p) => p.cids).reduce((a, p) => a + p.usd, 0) };
  } catch { return null; }
}

module.exports = { DENY, run, strict, messages, classify, cost, worstCase, unitCalls, callUsd, MAX_UNIT_CALLS, fit, keptRooms, PRICES, contextPack, windowPack, evidencePack, packFiles };

if (require.main === module) run().catch(() => {}).then(() => process.exit(0)); // last: everything above is initialised before run() starts
