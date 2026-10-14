#!/usr/bin/env node
// The claude adapter's default mode (claude_mode: api): ONE Anthropic Messages API call, no agent loop and no CLI. SpecGuard already inlines the diff, test candidates, leads, requirements and rule files
// into the prompt (src/prompt.js), so the model needs no tools: the agent loop re-sends the whole context every turn and its cost cannot be bounded up front (two live runs: $3.58 and $3.44 against a $1 budget).
// Env: CTX PROMPT_FILE (or PROMPT) ANTHROPIC_API_KEY (environment only) MODEL (empty = claude-haiku-5-5) MAX_BUDGET_USD (default 1.00; a HARD bound: checked before the call) MAX_OUTPUT_TOKENS (default 32000) CONTEXT_PACK_BYTES (repository files appended to the prompt, an upper bound, default 150000, 0 = off; shrunk to keep the prompt under 90% of a model's long-context price step; read from GITHUB_WORKSPACE or the cwd) EFFORT (ignored, noted) TIMEOUT (minutes) CHECK (audit = scan schema) FAST_MODELS SCAN_BATCH_BLOCKS (scan: document blocks per call, default 20; more blocks split the scan into parts, src/scan-parts.js).
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
const NO_TOOLS_PACK = 'This run has no file tools: you cannot Read, Grep or Glob. Ignore every instruction above to read files or to stay within a tool budget. Instead, the blocks after "Repository files" at the end hold files read from the repository: each is the full current text of the file it names (line-numbered where its note says so), unless its note says where it was cut. A block noted "relevant slices" shows every test of that file that references the changed symbols (real line numbers; "…| (lines a-b omitted)" marks the gaps): tests not shown do not mention them. Anything that is neither inlined nor in those blocks was not read: where the answer would need it, mark it unknown and say so. Do not report a missing or weak test when a candidate test file for that code was cut or not included: mark the obligation unknown and say which file was not fully visible. Output only the JSON object.\n\n';
function messages(prompt, pack = '') {
  const at = prompt.indexOf(SPLIT);
  const system = at > 0 ? prompt.slice(0, at) : '', user = at > 0 ? prompt.slice(at + 2) : prompt; // keep "---" at the head of the user part
  return { system, user: (pack ? NO_TOOLS_PACK : NO_TOOLS) + user + (pack ? `\n${pack}\n\nReminder: output only the JSON object matching the schema.\n` : '') };
}

// The context pack: repository files appended to the user message, in priority order, until CONTEXT_PACK_BYTES is spent. The prompt was written for an agent that Reads files; here nobody can.
// Trust boundary: every path comes from the (PR-influenced) context files, so it is resolved against the repo root after realpath and anything outside, secret-like or binary is skipped. Nothing read here is ever logged.
const PER_FILE = 48 * 1024, MAX_FILE = 2 * 1024 * 1024, OVERHEAD = 300; // OVERHEAD: the block markup around a body
const DENY = /(^|\/)(\.git|\.specguard-(ctx|src))(\/|$)|(^|\/)(\.env(\.[^/]*)?|[^/]*\.env|[^/]*\.pem|[^/]*\.key|id_rsa[^/]*)$/i;
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
const TEST_START = /^\s*(?:(?:test|it|describe)\b|def test_|func Test|@Test\b)/, indentOf = (l) => /^\s*/.exec(l)[0].length;
// -> { text, note, complete } or null (no symbol appears in the file, or no matching block fits). complete: every block that mentions a symbol is shown.
function slices(src, syms, room) {
  const n = src.length, re = new RegExp(`(?<![\w$])(?:${syms.map((x) => x.replace(/\$/g, '\$')).join('|')})(?![\w$])`, 'g'), found = new Set(), wins = [];
  src.forEach((l, i) => {
    const m = [...l.matchAll(re)].map((x) => x[0]);
    if (!m.length) return;
    m.forEach((x) => found.add(x));
    let s = i; while (s > 0 && i - s < 30 && !TEST_START.test(src[s])) s--; // up to the enclosing test start, or 30 lines
    let e = i; while (e + 1 < n && e + 1 - s < 80 && !(TEST_START.test(src[e + 1]) && indentOf(src[e + 1]) <= indentOf(src[s]))) e++; // down to the next test at the same or lower indentation, 80 lines at most
    wins.push({ s, e, m: true });
  });
  if (!wins.length) return null;
  wins.push({ s: 0, e: Math.min(30, n) - 1, m: false }); // imports and helpers
  wins.sort((a, b) => a.s - b.s || b.e - a.e);
  const merged = [];
  for (const w of wins) { const p = merged[merged.length - 1]; if (p && w.s <= p.e + 1) { p.e = Math.max(p.e, w.e); p.m = p.m || w.m; } else merged.push({ ...w }); }
  const body = (w) => Array.from({ length: w.e - w.s + 1 }, (_, k) => `${String(w.s + k + 1).padStart(4)}| ${src[w.s + k]}`).join('\n'), MARK = 40; // MARK: room for an omission marker
  let used = 0, dropped = false;
  const kept = merged.filter((w) => { const c = Buffer.byteLength(body(w)) + 1 + MARK; if (used + c <= room) { used += c; return true; } if (w.m) dropped = true; return false; });
  if (!kept.some((w) => w.m)) return null;
  const out = [], gap = (a, b) => out.push(`   …| (lines ${a + 1}-${b} omitted)`);
  let at = 0;
  for (const w of kept) { if (w.s > at) gap(at, w.s); out.push(body(w)); at = w.e + 1; }
  if (at < n) gap(at, n);
  const shown = [...found], names = shown.slice(0, 8).join(', ') + (shown.length > 8 ? ', …' : ''), ranges = kept.map((w) => `${w.s + 1}-${w.e + 1}`).join(', ');
  return { text: out.join('\n') + '\n', complete: !dropped, note: `relevant slices: lines ${ranges} of ${n} (tests referencing ${names})${dropped ? '; some matching tests did not fit' : ''}, line-numbered` };
}
// A block part's pack (src/scan-parts.js): the files its evidence rows cite, each as line-numbered windows of WIN lines either side of every cited line plus its first HEAD lines (imports), merged when they touch;
// a file that fits the per-file cap is shown whole. locs: Map path -> cited line numbers, in priority order. Nothing is listed as cut (a block part never writes pack-cut.txt). ponytail: no per-file fairness, first files first.
const WIN = 40, HEAD = 15;
function windowPack(root, locs, limit) {
  const cap = Math.min(PER_FILE, Math.max(8 * 1024, limit / 6)), parts = [];
  let used = 0;
  for (const [rel, at] of locs) {
    const text = packRead(root, rel), room = Math.min(cap, limit - used - OVERHEAD);
    if (!text || !text.trim() || room < 200) continue;
    const src = text.replace(/\n$/, '').split('\n'), n = src.length, row = (i) => `${String(i + 1).padStart(4)}| ${src[i]}`;
    const whole = src.map((_, i) => row(i)).join('\n') + '\n';
    let body, note;
    if (Buffer.byteLength(whole) <= room) { body = whole; note = 'full file, line-numbered'; } else {
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
  return { text: parts.length ? `Repository files (the code and tests cited by the candidate blocks' evidence rows; a file noted "relevant windows" shows the lines around each cited line):\n\n${parts.join('\n\n')}` : '', note: '', notWhole: [] };
}

function contextPack(ctx, root, limit) {
  const rd = (n) => { try { return fs.readFileSync(path.join(ctx, n), 'utf8').replace(/\r\n/g, '\n'); } catch { return ''; } };
  const list = (n) => rd(n).split('\n').filter(Boolean);
  const parts = [], seen = new Set(), omitted = [], partial = []; // partial: cut at the budget
  let used = 0, files = 0;
  const cap = Math.min(PER_FILE, Math.max(8 * 1024, limit / 6)); // a smaller cap on source/test files when the pack is tight, so each file and its test fit
  const addFile = (p, num, quiet, syms, top = limit) => { // num: line-numbered; syms: changed symbols, for a candidate test of a review file (shown as relevant slices when over its cap); quiet: a file of the extra tiers, never listed as cut or omitted and kept within 60% of the budget so the diff rest and requirement documents still fit
    const rel = path.posix.normalize(p.replace(/\\/g, '/'));
    if (seen.has(rel)) return;
    seen.add(rel);
    const text = packRead(root, rel);
    if (!text || !text.trim()) return;
    const room = Math.min(num ? cap : PER_FILE, (quiet ? limit * 0.6 : top) - used - OVERHEAD), src = text.replace(/\n$/, '').split('\n');
    if (room < 200) return void (quiet || omitted.push(rel));
    const full = num ? src.map((l, i) => `${String(i + 1).padStart(4)}| ${l}`).join('\n') + '\n' : text;
    const sl = syms && syms.length && Buffer.byteLength(full) > room ? slices(src, syms, room) : null;
    if (sl) { // pack-cut.txt: not listed when every test that mentions the changed symbols is shown (its relevant tests were visible); listed when some matching block did not fit
      if (!sl.complete && !quiet) partial.push(rel);
      const b = block(rel, sl.text, sl.note);
      parts.push(b); used += Buffer.byteLength(b); files++;
      return;
    }
    const c = cut(full, room);
    if (c.cut && c.lines < 1) return void (quiet || omitted.push(rel));
    if (c.cut && !quiet) partial.push(rel);
    const b = block(rel, c.text, `${c.cut ? `first ${c.lines} of ${src.length} lines` : 'full file'}${num ? ', line-numbered' : ''}`);
    parts.push(b); used += Buffer.byteLength(b); files++;
  };
  for (const p of list('standards.txt')) addFile(p, false);
  const focus = list('focus.txt').map((l) => l.split('\t')[0]);
  // scan mode (audit-units.txt: id, path, risk, why, matched tests, leads): the selected units are the review set and their matched tests their candidate tests
  const units = new Map(list('audit-units.txt').map((l) => l.split('\t')).filter((u) => u[1]).map((u) => [u[1], u[4] && u[4] !== 'none' ? u[4].split(', ') : []])), review = units.size ? [...units.keys()] : focus.length ? focus : list('files.txt');
  const cands = parseCandidates(rd('test-candidates.txt'));
  const numbered = rd('diff.numbered.txt'), dname = numbered.trim() ? 'diff.numbered.txt' : 'diff.patch', diff = numbered.trim() ? numbered : rd('diff.patch'), leads = rd('leads.txt');
  const unitSymbols = (p) => { const out = new Set(), add = (n) => { if (n && n.length >= 4 && !SYM_KW.has(n) && out.size < 40) out.add(n); }; for (const l of (packRead(root, p) || '').split('\n')) symbolsIn(l, add); return [...out]; }; // names the unit defines: a big test file is shown as the tests that mention them
  review.forEach((p, i) => { addFile(p, true); const top = Math.min(limit, used + (limit - used) / (review.length - i)); const syms = units.size ? unitSymbols(p) : diffSymbols(diff, path.posix.normalize(p.replace(/\\/g, '/')), leads); for (const t of (units.size ? units.get(p) : cands.get(p)) || []) addFile(t, true, false, syms, top); }); // each file, then its tests (a big test as slices around the changed symbols), together within a fair share of what is left so the later review files still fit
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
  for (const p of list('spec-files.txt')) addFile(p, false);
  const text = parts.length ? `Repository files (read from the checked-out repository; rule files, each file under review followed by its candidate tests, files the requirements name and small neighbours of reviewed files, the rest of a cut diff, requirement documents):\n\n${parts.join('\n\n')}` : '';
  const note = files || omitted.length ? `context pack: ${files} files, ${Math.round(used / 1024)} KB${omitted.length ? `; not included: ${omitted.slice(0, 4).join(', ')}${omitted.length > 4 ? ` (+${omitted.length - 4} more)` : ''}` : ''}` : '';
  return { text, note, notWhole: [...partial, ...omitted] };
}

const tokenRe = /github_pat_[A-Za-z0-9_]+|gh[pousr]_[A-Za-z0-9]+|sk-ant-[A-Za-z0-9_-]+|Bearer [^\s]+/g;
const plural = (n, one) => `${n} ${one}${n === 1 ? '' : 's'}`;
const fmt = (x) => x.toFixed(x < 0.1 ? 4 : 2);

// ponytail: substring table over the API's error type and message; first match wins. Same reasons as claude.sh (budget, quota, auth, rate, model).
function classify(status, type = '', message = '') {
  const t = `${type} ${message}`;
  if (status === 402 || /billing_error|credit balance/i.test(t)) return ['quota', 'The Anthropic account has no credit left or hit its quota (add credits to the API account; this is not the per-run budget)'];
  if (status === 401 || status === 403 || /authentication_error|permission_error|invalid x-api-key/i.test(t)) return ['auth', 'The Anthropic API key was rejected (check the llm_token secret)'];
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
    else if (status === 'failed') console.log(`::warning::Claude review failed${why ? `: ${scrub(why)}` : ''}`);
  };
  try {
    if (!key) return end('failed', 'auth', 'The Anthropic API key was rejected (check the llm_token secret)', 'no ANTHROPIC_API_KEY in the environment');
    const prompt = env.PROMPT_FILE ? fs.readFileSync(env.PROMPT_FILE, 'utf8') : env.PROMPT || '';
    const model = env.MODEL || 'claude-haiku-5-5';
    const maxTokens = parseInt(env.MAX_OUTPUT_TOKENS, 10) || 32000, budget = parseFloat(env.MAX_BUDGET_USD || '1.00');
    const schemaFile = path.join(__dirname, '..', env.CHECK === 'audit' ? 'audit.schema.json' : 'findings.schema.json');
    const schema = strict(JSON.parse(fs.readFileSync(schemaFile, 'utf8')));
    const packBytes = env.CONTEXT_PACK_BYTES === undefined || env.CONTEXT_PACK_BYTES === '' ? 250000 : Math.max(0, parseInt(env.CONTEXT_PACK_BYTES, 10) || 0);
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
          plain = true; delete body.output_config; console.error('claude-api: structured output unavailable for this schema; plain JSON requested'); continue;
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
      return found ? { ...r, ok: true, found } : { ...r, ok: false, status: 'failed', reason: '', why: 'no JSON found in the engine output' };
    };
    // usage.json: cost and tokens of every reply received, summed (each priced on its own card)
    const writeUsage = (rs) => {
      const got = rs.filter((x) => x.u);
      if (!got.length) return;
      const sum = { i: 0, cr: 0, cw: 0, o: 0 }, by = {};
      let usd = 0;
      for (const r of got) {
        const i = r.u.input_tokens || 0, cr = r.u.cache_read_input_tokens || 0, cw = r.u.cache_creation_input_tokens || 0, o = r.u.output_tokens || 0, m = (by[r.used] ||= { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 });
        usd += cost(r.used, r.u); sum.i += i; sum.cr += cr; sum.cw += cw; sum.o += o;
        m.inputTokens += i + cr + cw; m.cacheReadTokens += cr; m.cacheWriteTokens += cw; m.outputTokens += o; // the copilot shape: inputTokens include the cache tokens
      }
      w('usage.json', JSON.stringify({
        currentModel: got[0].used, totalCostUsd: usd, totalApiDurationMs: Date.now() - t0,
        tokenDetails: { input: { tokenCount: sum.i }, cache_read: { tokenCount: sum.cr }, cache_write: { tokenCount: sum.cw }, output: { tokenCount: sum.o } },
        modelMetrics: Object.fromEntries(Object.entries(by).map(([m, usage]) => [m, { usage }])),
      }));
      try { require('../engine-model.js').run({ ctx, requested: model, turn: 'main', usage: path.join(ctx, 'usage.json'), fast: env.FAST_MODELS || '' }); } catch { /* never fails the step */ }
    };
    const failEnd = (r) => (r.status === 'timeout' ? end('timeout') : end('failed', r.reason, r.why, r.raw));
    if (!PRICES[model]) notes.push(`cost estimated at default rates: ${model} is not in the price table`);

    // A scan with more document blocks than SCAN_BATCH_BLOCKS (default 20) is split into budgeted parts (src/scan-parts.js): one unit call and block calls, answers merged here. Fewer blocks: one call, below.
    const batch = Math.max(1, parseInt(env.SCAN_BATCH_BLOCKS, 10) || 20), split = env.CHECK === 'audit' ? require('../scan-parts.js').plan({ ctx, root: root(), batch, limit: packBytes, schemaFile, contextPack, windowPack, assembleAudit: require('../prompt.js').assembleAudit }) : null;
    if (split) {
      const priced = (p) => {
        const { system: s, user: x } = messages(p.prompt, p.pack.text), tokens = p.cids ? Math.min(maxTokens, 1500 * p.cids.length + 2000) : maxTokens; // a batch of n blocks needs about 1500 tokens each (20 blocks overflowed 22000 live)
        return { ...p, system: s, user: x, tokens, usd: worstCase(model, Buffer.byteLength(s), Buffer.byteLength(x), tokens).usd };
      };
      const plans = split.parts.map(priced);
      const total = () => plans.reduce((a, p) => a + p.usd, 0), firstUsd = plans[0].usd, dropped = [];
      while (plans.length > 1 && total() > budget) dropped.unshift(...plans.pop().cids || []); // the budget is hard: trailing block batches go first (candidate order = rotation priority), the first part (units) last
      if (total() > budget) return end('failed', 'budget', `estimated worst-case cost $${fmt(firstUsd)} for the first part of the scan exceeds max_budget_usd $${fmt(budget)} (raise max_budget_usd or scan_batch_blocks smaller, lower max_output_tokens or use a cheaper model)`);
      const rs = [], failed = [], merged = { docs_reviewed: [], requirements: [], not_requirements: [], unit_findings: [], not_reviewed: [] };
      let first = null, ok = 0, splits = 0;
      const queue = [...plans], fail = (p, reason) => failed.push({ part: p.cids ? 'blocks' : 'units', ...(p.cids && { blocks: p.cids }), reason });
      while (queue.length) {
        const p = queue.shift();
        const r = await call(p.system, p.user, p.tokens);
        rs.push(r);
        if (!r.ok && r.reason === 'length' && p.cids && p.cids.length > 1) { // the reply overflowed: run the two halves as parts of their own, if the budget still covers them
          const h = Math.ceil(p.cids.length / 2), halves = [p.cids.slice(0, h), p.cids.slice(h)].map((c) => priced({ ...split.sub(c) })), spent = rs.reduce((a, x) => a + (x.u ? cost(x.used, x.u) : 0), 0);
          if (spent + queue.reduce((a, x) => a + x.usd, 0) + halves.reduce((a, x) => a + x.usd, 0) <= budget) { splits++; queue.unshift(...halves); continue; }
          fail(p, `${r.why}; not split: the halves would exceed max_budget_usd`); first ||= r; continue;
        }
        let obj = null, why = r.ok ? '' : r.why || r.status;
        if (r.ok) { try { obj = JSON.parse(r.found); } catch { /* extract-json gave text that is not an object */ } if (!obj || typeof obj !== 'object' || Array.isArray(obj)) { obj = null; why = 'the answer was not a JSON object'; } }
        const arr = (k) => (obj && Array.isArray(obj[k]) ? obj[k] : []);
        if (obj && p.cids) { // a block call that left more than 20% of its blocks unanswered is not trusted (audit-post rejects such a whole result)
          const got = new Set([...arr('requirements').map((x) => /^[0-9a-f]{8}/.exec(String(x?.id))?.[0]), ...arr('not_requirements').map((x) => x?.cid)]), missing = p.cids.filter((c) => !got.has(c)).length;
          if (missing > p.cids.length * 0.2) { obj = null; why = `${missing} of ${p.cids.length} blocks were not answered`; }
        }
        if (!obj) { fail(p, why); first ||= r.ok ? { status: 'failed', reason: '', why } : r; if (r.status === 'timeout') break; continue; }
        ok++;
        if (p.cids) merged.requirements.push(...arr('requirements')), merged.not_requirements.push(...arr('not_requirements'));
        else merged.unit_findings.push(...arr('unit_findings'));
        merged.docs_reviewed.push(...arr('docs_reviewed').filter((d) => !merged.docs_reviewed.includes(d)));
        merged.not_reviewed.push(...arr('not_reviewed'));
      }
      writeUsage(rs);
      for (const p of queue) fail(p, 'not started: the review timed out'); // a timeout stops the run: the parts not started are not audited either
      if (!ok) return failEnd(first); // nothing usable at all: the run fails as one call would
      w('findings.json', JSON.stringify(merged));
      w('scan-parts.json', JSON.stringify({ calls: rs.length, ...(splits && { splits }), failed, dropped }));
      if (!failed.some((f) => f.part === 'units')) w('pack-cut.txt', split.packCut.map((x) => `${x}\n`).join('')); // the unit part's pack (what the unit findings may rely on)
      notes.push(`scan in ${rs.length} calls${splits ? ` (${plural(splits, 'part')} split after max_output_tokens)` : ''}${failed.length ? `; ${plural(failed.length, 'part')} failed` : ''}${dropped.length ? `; ${plural(dropped.length, 'block')} left for the next run (max_budget_usd)` : ''}`);
      for (const f of failed) notes.push(`${f.part === 'units' ? 'unit part' : plural(f.blocks.length, 'block')} not audited: ${f.reason}`);
      return end('success');
    }

    let pack = { text: '', note: '' };
    if (packBytes > 0) try { pack = contextPack(ctx, root(), packBytes); w('pack-cut.txt', pack.notWhole.map((x) => `${x}\n`).join('')); } catch { /* the pack is optional */ } // pack-cut.txt: files the model did not see whole; post.js distrusts missing/weak-test claims about them
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
    end('failed', '', 'Claude API adapter error', e?.message || String(e));
  }
}

if (require.main === module) run().catch(() => {}).then(() => process.exit(0));
module.exports = { run, strict, messages, classify, cost, worstCase, PRICES, contextPack, windowPack };
