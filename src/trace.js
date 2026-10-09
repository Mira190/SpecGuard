// Requirement <-> code trace candidates (docs/traceability-plan.md section 4.1). No AI, no language knowledge,
// Node built-ins only. Everything is read from git objects at BASE/HEAD, never from PR-controlled symlinks.
// Usage: node trace.js classify <paths...>   (prints the subset that are requirement docs)
//        node trace.js                       (full run; stdout = number of changed normative items)
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { parseDiff } = require('./post');

const DOC_EXT = /\.(md|mdx|markdown|rst|adoc|txt|feature)$/i;
const SKIP_NAME = /(^|\/)(CHANGELOG|LICENSE|CODE_OF_CONDUCT|SECURITY)[^/]*$/i;
const UNREADABLE = /\.(docx|pdf|xlsx)$/i, UNREADABLE_NAME = /(requirement|spec|prd|acceptance)/i;
const HINTS = [/(^|\/)(docs?|spec|specs|requirements)\//i, /\.feature$/i, /(^|\/)adrs?\//i, /^\.kiro\/specs\//, /^openspec\//];
const MAX_FILE = 256 * 1024, MAX_CANDIDATES = 2000, MAX_DOCS = 500, INDEX_CAP = 60 * 1024;
const WIN = 40, STEP = 20;
// Mirrors the globs in collect.sh. ponytail: duplicated, keep in sync (collect.sh could export them later).
const EXT5 = ['md', 'mdx', 'rst', 'txt', 'adoc'];
const RULE_GLOBS = [
  '.github/copilot-instructions.md', '.github/instructions/**', '**/AGENTS.md', '**/AGENT.md', '**/CLAUDE.md', '**/GEMINI.md',
  'REVIEW.md', 'CONTRIBUTING.md', 'CODING_STANDARDS.md', '.editorconfig', ...EXT5.flatMap((e) => [`docs/*standards*.${e}`, `docs/*conventions*.${e}`]),
  '.claude/rules/**', '.github/skills/**', '.claude/skills/**', '.agents/skills/**', '.cursorrules', '.cursor/rules/**', '.windsurfrules', '.clinerules/**',
  '.claude/**', '.mcp.json', '.claude.json', 'CLAUDE.local.md', '.gitmodules', '.ripgreprc', '.husky/**', '.github/hooks/**', '.github/copilot/**', '.github/mcp.json',
  'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'Cargo.lock', 'poetry.lock', 'go.sum', 'composer.lock', 'Gemfile.lock', '*.lock',
  '.specguard-ctx/', 'dist/', 'build/', 'vendor/', 'node_modules/', '*.min.*', '__snapshots__/', '*.snap',
  '**/skills/test-review/**', '.github/instructions/test-review.instructions.md',
];
const LOCK_EXCLUDES = ['**/node_modules/**', '**/vendor/**', '**/dist/**', '**/*.lock', '**/package-lock.json', '**/pnpm-lock.yaml', '**/go.sum'];

// collect.sh `match`: '*' crosses '/', a leading '**/' is optional, a trailing '/' means a directory prefix.
function matchGlob(file, pattern) {
  const p = pattern.replace(/^\*\*\//, '');
  const re = p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*+/g, '.*').replace(/\?/g, '[^/]');
  return new RegExp(`^(?:.*/)?${re}${p.endsWith('/') ? '.*' : ''}$`).test(file);
}

const CJK = String.raw`\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}`;
const WORD = new RegExp(`[${CJK}]+|(?:(?![${CJK}])[\\p{L}\\p{N}])+`, 'gu');
const CJK_ONLY = new RegExp(`^[${CJK}]`, 'u');
// camelCase / snake_case / digit boundaries, lowercase, trailing plural s dropped, CJK runs become bigrams.
function tokenize(text) {
  const out = [];
  for (const [w] of String(text).matchAll(WORD)) {
    if (CJK_ONLY.test(w)) {
      if ([...w].length === 1) out.push(w); else { const c = [...w]; for (let i = 0; i < c.length - 1; i++) out.push(c[i] + c[i + 1]); }
      continue;
    }
    for (let t of w.replace(/([a-z\d])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
      .replace(/(\p{L})(\d)/gu, '$1 $2').replace(/(\d)(\p{L})/gu, '$1 $2').split(' ')) {
      t = t.toLowerCase();
      out.push(t.length > 3 && /[^su]s$/.test(t) ? t.slice(0, -1) : t);
    }
  }
  return out;
}

// BM25 over an iterable of token arrays. `terms` (optional Set) keeps postings for those terms only, so a huge
// corpus can be streamed without being held in memory. Returns { search(queryTokens) -> Float64Array, idf, has, size }.
function buildIndex(docs, terms, k1 = 1.2, b = 0.75) {
  const post = new Map(), len = [];
  let i = 0, total = 0;
  for (const d of docs) {
    len.push(d.length); total += d.length;
    const tf = new Map();
    for (const t of d) if (!terms || terms.has(t)) tf.set(t, (tf.get(t) || 0) + 1);
    for (const [t, c] of tf) { let p = post.get(t); if (!p) post.set(t, p = { d: [], c: [] }); p.d.push(i); p.c.push(c); }
    i++;
  }
  const avg = total / (i || 1) || 1;
  const idf = (t) => { const n = post.get(t)?.d.length || 0; return Math.log(1 + (i - n + 0.5) / (n + 0.5)); };
  const find = (t, doc) => { const p = post.get(t); if (!p) return -1; let lo = 0, hi = p.d.length - 1; while (lo <= hi) { const m = (lo + hi) >> 1; if (p.d[m] === doc) return m; if (p.d[m] < doc) lo = m + 1; else hi = m - 1; } return -1; };
  return {
    size: i, idf,
    has: (t, doc) => find(t, doc) >= 0,
    search(q) {
      const s = new Float64Array(i);
      for (const t of new Set(q)) {
        const p = post.get(t); if (!p) continue;
        const w = idf(t);
        for (let k = 0; k < p.d.length; k++) s[p.d[k]] += w * p.c[k] * (k1 + 1) / (p.c[k] + k1 * (1 - b + b * len[p.d[k]] / avg));
      }
      return s;
    },
  };
}

const slug = (s) => String(s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '');
// git's lines are LF-separated: CRLF becomes LF and a lone CR a space, so line numbers match the diff and no CR reaches a quote.
const lf = (s) => String(s).replace(/\r\n/g, '\n').replace(/\r/g, ' ');
const clean = (s) => String(s).replace(/[​-‏‪-‮⁠-⁤﻿]/g, '').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
const ID = String.raw`(?:AC\s?\d+|[A-Z][A-Z0-9]*(?:[-_.][A-Z0-9]+)*-?\d+(?:\.\d+)*)`;
const ID_LINE = new RegExp(String.raw`^\s*(?:[-*+]\s+|\d+[.)]\s+)?(#{1,6}\s+)?[*_\[\`]*(${ID})[*_\]\`]*\s*[:：.)\-—–]`);
const AC_HEAD = /^(acceptance criteria|acceptance tests|验收标准|验收条件|AC)\s*[:：]?$/i;
const LIST_ITEM = /^\s*(?:[-*+]\s+(?:\[[ xX]\]\s*)?|\d+[.)]\s+)(.+)$/;
const GHERKIN = /^\s*(Feature|Rule|Scenario Outline|Scenario Template|Scenario|Example(?!s))\s*:\s*(.*)$/;
const NORMATIVE = /\b(shall|must|required to)\b|必须|应当|不得/i;
const SECOND_PERSON = /\b(you|your|you're|please)\b/i;
const IMPERATIVE = /^(run|use|install|make|ensure|add|check|create|open|build|push|commit|update|write|set|do|don't|never|always|avoid|keep|remember|read|see|follow|try|test)\b/i;
const strip = (l) => l.replace(/^\s*(?:[-*+]\s+(?:\[[ xX]\]\s*)?|\d+[.)]\s+)?(?:#{1,6}\s+)?/, '').trim();

// Item records: { path, ref, line, end, heading, text (<=600), raw, kind: id|ac|gherkin|normative, normative: true }.
function parseItems(file, text) {
  const lines = lf(clean(text)).split('\n'), n = lines.length;
  const feature = /\.feature$/i.test(file);
  const fenced = new Array(n).fill(false), head = new Array(n).fill(null);
  let f = false, cur = null;
  lines.forEach((l, i) => {
    if (!feature && /^\s*(```|~~~)/.test(l)) { fenced[i] = true; f = !f; return; }
    fenced[i] = f;
    const h = !f && !feature && /^(#{1,6})\s+(.+)$/.exec(l);
    if (h) cur = { level: h[1].length, text: h[2].trim(), at: i };
    head[i] = cur;
  });
  const parentHeading = (i) => { // nearest heading above line i, skipping the line's own heading
    for (let k = i - (head[i]?.at === i ? 1 : 0); k >= 0; k--) if (head[k] && head[k].at !== i) return head[k].text;
    return '';
  };
  const items = [], covered = new Set();
  const push = (kind, ref, a, z, heading) => {
    while (z > a && !lines[z].trim()) z--;
    const raw = lines.slice(a, z + 1).map((l, k) => (k === 0 ? strip(l) : l.trim())).join('\n');
    items.push({ path: file, ref, line: a + 1, end: z + 1, heading, text: raw.slice(0, 600), raw, kind, normative: true });
    for (let k = a; k <= z; k++) covered.add(k);
  };
  // 1. ID'd items
  for (let i = 0; i < n; i++) {
    if (fenced[i] || covered.has(i)) continue;
    const m = ID_LINE.exec(lines[i]);
    if (!m) continue;
    const level = m[1] ? m[1].trim().length : 0;
    let j = i + 1;
    for (; j < n; j++) {
      if (!fenced[j] && ID_LINE.test(lines[j])) break;
      const h = !feature && !fenced[j] && /^(#{1,6})\s/.exec(lines[j]);
      if (h && (!level || h[1].length <= level)) break;
      if (!level && !lines[j].trim()) break;
    }
    push('id', m[2].replace(/\s/g, ''), i, j - 1, parentHeading(i));
  }
  // 2. list items under acceptance-criteria headings (same continuation rule as requirements.js)
  let depth = 0, active = null, top = 0, count = 0, headKey = null;
  for (let i = 0; i < n && !feature; i++) {
    if (fenced[i]) continue;
    const h = /^(#{1,6})\s+(.+)$/.exec(lines[i]);
    if (h) {
      if (AC_HEAD.test(h[2].trim())) { depth = h[1].length; count = 0; headKey = slug(h[2]); } else if (h[1].length <= depth) depth = 0;
      active = null; continue;
    }
    if (covered.has(i)) { active = null; continue; }
    const indent = /^\s*/.exec(lines[i])[0].length;
    const it = depth && !(active && indent > top) && LIST_ITEM.exec(lines[i]);
    if (it) {
      top = indent; count++;
      let z = i;
      while (z + 1 < n && !fenced[z + 1] && !covered.has(z + 1) && /^\s+\S/.test(lines[z + 1]) && /^\s*/.exec(lines[z + 1])[0].length > top) z++;
      push('ac', `${headKey}#${count}`, i, z, (head[i]?.text) || '');
      active = true; i = z;
    } else if (!lines[i].trim()) continue; else active = null;
  }
  // 3. Gherkin scenarios (with the tag lines above them)
  const starts = [];
  for (let i = 0; i < n; i++) {
    if (fenced[i]) continue;
    const g = GHERKIN.exec(lines[i]);
    if (!g) continue;
    let t = i; while (t > 0 && /^\s*@\S/.test(lines[t - 1])) t--;
    starts.push({ i, t, kind: g[1], name: g[2].trim() });
  }
  starts.forEach((s, k) => {
    if (/^(Feature|Rule)$/.test(s.kind)) return;
    const z = (starts[k + 1] ? starts[k + 1].t : n) - 1;
    const tags = lines.slice(s.t, s.i).join(' ').split(/\s+/).filter((x) => x.startsWith('@'));
    push('gherkin', tags.find((x) => /\d/.test(x)) || `Scenario: ${s.name}`, s.t, z, '');
  });
  // 4. normative fallback on uncovered prose
  const ord = new Map();
  for (let i = 0; i < n; i++) {
    if (fenced[i] || covered.has(i) || !lines[i].trim() || (!feature && /^#{1,6}\s/.test(lines[i]))) continue;
    let j = i; // paragraph: consecutive prose lines, a new list item starts a new paragraph
    while (j + 1 < n && !fenced[j + 1] && !covered.has(j + 1) && lines[j + 1].trim() && !LIST_ITEM.test(lines[j + 1]) && !/^#{1,6}\s/.test(lines[j + 1])) j++;
    const listItem = LIST_ITEM.test(lines[i]);
    const para = lines.slice(i, j + 1).map((l, k) => (k === 0 ? strip(l) : l.trim())).join('\n');
    for (const s of para.matchAll(/\S[\s\S]*?(?:[.!?。！？](?=\s|$)|$)/g)) {
      const sentence = s[0].trim();
      if (!NORMATIVE.test(sentence) || SECOND_PERSON.test(sentence) || (listItem && IMPERATIVE.test(sentence))) continue;
      const a = i + (para.slice(0, s.index).match(/\n/g) || []).length;
      const z = a + (sentence.match(/\n/g) || []).length;
      const heading = head[i]?.text || '', key = slug(heading) || 'doc';
      const k = (ord.get(key) || 0) + 1; ord.set(key, k);
      items.push({ path: file, ref: `${key}#${k}`, line: a + 1, end: z + 1, heading, text: sentence.slice(0, 600), raw: sentence, kind: 'normative', normative: true });
    }
    i = j;
  }
  return items.sort((x, y) => x.line - y.line);
}

const isRequirementDoc = (items) => items.some((i) => i.kind !== 'normative') || items.length >= 2;

// Pair BASE and HEAD items by ref (k-th duplicate with k-th), then leftovers by heading + ordinal.
function pairItems(baseItems, headItems) {
  const pairs = [], bl = new Set(baseItems), byRef = new Map();
  for (const b of baseItems) { const k = b.ref; if (!byRef.has(k)) byRef.set(k, []); byRef.get(k).push(b); }
  const left = [];
  for (const h of headItems) {
    const b = byRef.get(h.ref)?.shift();
    if (b) { bl.delete(b); pairs.push({ base: b, head: h }); } else left.push(h);
  }
  const byHeading = new Map();
  for (const b of baseItems) if (bl.has(b)) { if (!byHeading.has(b.heading)) byHeading.set(b.heading, []); byHeading.get(b.heading).push(b); }
  for (const h of left) {
    const b = byHeading.get(h.heading)?.shift();
    if (b) { bl.delete(b); pairs.push({ base: b, head: h }); } else pairs.push({ base: null, head: h });
  }
  for (const b of baseItems) if (bl.has(b)) pairs.push({ base: b, head: null });
  return pairs;
}

const UNIT = String.raw`days?|hours?|minutes?|mins?|seconds?|secs?|ms|weeks?|months?|years?|percent|[KMGT]B|times|%`;
const VALUE = new RegExp(String.raw`(\d+(?:[.,]\d+)*)(?:\s*(${UNIT})(?![\p{L}]))?|"([^"\n]+)"|\x60([^\x60\n]+)\x60`, 'giu');
function values(text) {
  return [...String(text).matchAll(VALUE)].map((m) => (m[1] ? (m[2] ? `${m[1]} ${m[2].toLowerCase()}` : m[1]) : (m[3] || m[4]).trim()));
}
// Number tokens (with an adjacent unit) and quoted strings that differ between previous and current text.
function valueDeltas(previous, current) {
  const diff = (a, b) => { const c = new Map(); for (const v of b) c.set(v, (c.get(v) || 0) + 1); return [...new Set(a.filter((v) => { const k = c.get(v) || 0; if (k) c.set(v, k - 1); return !k; }))]; };
  const p = values(previous), c = values(current);
  return { removed: diff(p, c), added: diff(c, p) };
}

const DUR = { day: [86400, 'P%D'], hour: [3600, 'PT%H'], minute: [60, 'PT%M'], second: [1, 'PT%S'], week: [604800, 'P%W'] };
// Unit variants of a duration (ponytail: time units only; add percent/currency when a case needs it).
function durationVariants(value) {
  const m = /^(\d+(?:\.\d+)?)\s*(day|hour|minute|min|second|sec|week)s?$/i.exec(String(value).trim());
  if (!m) return [String(value).trim()];
  const v = +m[1], u = { min: 'minute', sec: 'second' }[m[2].toLowerCase()] || m[2].toLowerCase(), [f, iso] = DUR[u];
  const num = (x) => String(+x.toFixed(6));
  const out = [num(v)];
  if (u === 'day') out.push(num(v * 24));
  if (u === 'week') out.push(num(v * 7));
  if (u !== 'second') out.push(num(v * f));
  out.push(num(v * f * 1000), iso.replace('%', num(v)));
  return [...new Set(out)];
}

const isTestPath = (p) => /(^|[/._-])(test|tests|spec|__tests__)([/._-]|$)/.test(p);
function pathKind(p) {
  if (/(^|\/)__snapshots__\/|\.snap$/.test(p)) return 'snapshot';
  if (isTestPath(p)) return 'test';
  if (DOC_EXT.test(p)) return 'doc';
  if (/\.(json|ya?ml|toml|ini|env|properties|cfg|conf|xml|plist)$/i.test(p) || /(^|\/)(i18n|l10n|locales?|translations)\//i.test(p) || /(^|\/)\.env[^/]*$/.test(p)) return 'config';
  return 'src';
}

// Hunks of non-spec code: git's own `@@ ... @@ <context>` supplies the function context.
function codeHunks(patch) {
  const out = [];
  for (const chunk of String(patch || '').split(/^diff --git /m).slice(1)) {
    const one = [...parseDiff('diff --git ' + chunk)][0];
    if (!one) continue;
    const [file, map] = one;
    const headers = [...chunk.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@ ?([^\n]*)/gm)]; // not '.': it skips a CR
    headers.forEach((h, idx) => {
      const right = [...map.changed.RIGHT].filter(([l]) => map.RIGHT.get(l) === idx);
      const left = [...map.changed.LEFT].filter(([l]) => map.LEFT.get(l) === idx);
      const lines = right.map(([l]) => l);
      const lits = (arr) => [...new Set(arr.flatMap(([, t]) => [...t.matchAll(/\b\d+(?:\.\d+)?\b|"([^"\n]*)"|'([^'\n]*)'/g)].map((m) => m[1] ?? m[2] ?? m[0])).filter(Boolean))].slice(0, 20);
      const ids = [...new Set([...right, ...left].flatMap(([, t]) => t.match(/[A-Za-z_$][\w$]*/g) || []).concat(h[2].match(/[A-Za-z_$][\w$]*/g) || []))];
      const line = lines.length ? Math.min(...lines) : +h[1];
      out.push({ path: file, line, end: lines.length ? Math.max(...lines) : line, context: h[2].trim(), identifiers: [...new Set(ids.flatMap(tokenize))].slice(0, 60),
        literals: { added: lits(right), removed: lits(left) }, is_test: isTestPath(file) });
    });
  }
  return out;
}

// ---- git plumbing -------------------------------------------------------------------------------------------
const git = (cwd, args, o = {}) => execFileSync('git', args, { cwd, maxBuffer: 1 << 30, stdio: ['pipe', 'pipe', 'pipe'], ...o });
function lsTree(cwd, rev) {
  const out = [];
  for (const r of git(cwd, ['ls-tree', '-r', '-z', '-l', rev], { encoding: 'utf8' }).split('\0')) {
    const m = /^(\d{6}) (\w+) ([0-9a-f]+) +(\d+|-)\t([\s\S]*)$/.exec(r);
    if (m && m[2] === 'blob' && m[1] !== '120000') out.push({ path: m[5], sha: m[3], size: +m[4] });
  }
  return out;
}
// git cat-file --batch for blob shas or `rev:path` specs; null where missing.
function catBatch(cwd, specs) {
  const out = [];
  for (let s = 0; s < specs.length; s += 300) {
    const part = specs.slice(s, s + 300);
    const buf = git(cwd, ['cat-file', '--batch'], { input: part.join('\n') + '\n' });
    let pos = 0;
    for (let k = 0; k < part.length; k++) {
      const nl = buf.indexOf(10, pos), m = /^[0-9a-f]+ \w+ (\d+)$/.exec(buf.toString('utf8', pos, nl));
      if (!m) { out.push(null); pos = nl + 1; continue; }
      out.push(buf.subarray(nl + 1, nl + 1 + +m[1])); pos = nl + 1 + +m[1] + 1;
    }
  }
  return out;
}
const GREP_HIT = /^[^:]*:(.*?):(\d+):(.*)$/s; // 's': the hit line may end in (or hold) a CR, which '.' does not match
const gitGrep = (cwd, args) => {
  try { return git(cwd, args, { encoding: 'utf8' }); } catch (e) { if (e.status === 1) return ''; throw e; }
};

function parseReqPaths(s) {
  const inc = [], exc = [];
  for (const l of String(s || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean)) (l.startsWith('!') ? exc : inc).push(l.replace(/^!/, ''));
  return { inc, exc };
}
const rank = (p) => { const i = HINTS.findIndex((h) => h.test(p)); return i < 0 ? 99 : i; };
const byRank = (a, b) => rank(a.path) - rank(b.path) || (a.path < b.path ? -1 : 1);

// Which tracked files are requirement docs at `head` (content-based; globs only rank, includes/excludes adjust).
function discover({ cwd, head, reqPaths, ignoreExtra = '' }) {
  const { inc, exc } = parseReqPaths(reqPaths), limitations = [];
  const extra = String(ignoreExtra).split(/\r?\n/).filter(Boolean);
  const entries = lsTree(cwd, head);
  const ruled = (p) => RULE_GLOBS.concat(extra).some((g) => matchGlob(p, g));
  const forced = (p) => inc.some((g) => matchGlob(p, g)), excluded = (p) => exc.some((g) => matchGlob(p, g));
  for (const e of entries) if (UNREADABLE.test(e.path) && UNREADABLE_NAME.test(path.basename(e.path)) && !excluded(e.path)) limitations.push(`requirement-like file not readable: ${e.path}`);
  let cands = entries.filter((e) => e.size <= MAX_FILE && !excluded(e.path) && !UNREADABLE.test(e.path)
    && ((DOC_EXT.test(e.path) && !SKIP_NAME.test(e.path) && !ruled(e.path)) || forced(e.path))).sort(byRank);
  if (cands.length > MAX_CANDIDATES) { limitations.push(`${cands.length - MAX_CANDIDATES} candidate documents skipped by the ${MAX_CANDIDATES}-file limit.`); cands = cands.slice(0, MAX_CANDIDATES); }
  const docs = new Map(), bufs = catBatch(cwd, cands.map((c) => c.sha));
  cands.forEach((c, k) => {
    const buf = bufs[k];
    if (!buf || buf.includes(0)) return;
    const text = lf(buf.toString('utf8')), items = parseItems(c.path, text);
    if (isRequirementDoc(items) || forced(c.path)) docs.set(c.path, { path: c.path, text, items, forced: forced(c.path) });
  });
  let list = [...docs.values()].sort(byRank);
  if (list.length > MAX_DOCS) { limitations.push(`${list.length - MAX_DOCS} requirement documents skipped by the ${MAX_DOCS}-file limit.`); list = list.slice(0, MAX_DOCS); }
  return { entries, docs: new Map(list.map((d) => [d.path, d])), limitations, ruled, forced, excluded };
}

// `node trace.js classify <paths>`: the subset of (changed) paths that are requirement docs at head, or at base when deleted.
function classify({ cwd = '.', base, head, paths, reqPaths = '', ignoreExtra = '' }) {
  const { inc, exc } = parseReqPaths(reqPaths), extra = String(ignoreExtra).split(/\r?\n/).filter(Boolean);
  const eligible = (p) => !exc.some((g) => matchGlob(p, g)) && (inc.some((g) => matchGlob(p, g))
    || (DOC_EXT.test(p) && !SKIP_NAME.test(p) && !RULE_GLOBS.concat(extra).some((g) => matchGlob(p, g))));
  const todo = paths.filter(eligible);
  const read = (rev) => catBatch(cwd, todo.map((p) => `${rev}:${p}`));
  const heads = todo.length ? read(head) : [], bases = todo.length && base ? read(base) : [];
  const ok = new Set(todo.filter((p, k) => {
    const buf = heads[k] || bases[k];
    if (!buf || buf.includes(0) || buf.length > MAX_FILE) return false;
    return inc.some((g) => matchGlob(p, g)) || isRequirementDoc(parseItems(p, buf.toString('utf8')));
  }));
  return paths.filter((p) => ok.has(p));
}

// ---- the full run -------------------------------------------------------------------------------------------
const hitsLine = (item, map) => { for (let l = item.line; l <= item.end; l++) if (map.has(l)) return true; return false; };
const flat = (s) => s.replace(/\s+/g, ' ').trim();
const norm = (s) => s.replace(/\s+/g, ' ').trim();
const body = (raw) => raw.replace(ID_LINE, '').replace(/^@\S.*$/gm, ''); // ids and tags are labels, not values
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const round = (x) => Math.round(x * 100) / 100;

function changedItems(files, maps) { // files: [{path, headItems, baseItems}] -> [{item fields}] in order
  const out = [];
  for (const { path: p, headItems, baseItems } of files) {
    const m = maps.get(p);
    if (!m) continue;
    for (const { base, head } of pairItems(baseItems, headItems)) {
      if (head && base) {
        if (!(hitsLine(head, m.changed.RIGHT) || hitsLine(base, m.changed.LEFT)) || norm(head.raw) === norm(base.raw)) continue;
        out.push({ path: p, ref: head.ref, line: head.line, quote: head.text, previous: base.text, change: 'modified', deltas: valueDeltas(body(base.raw), body(head.raw)) });
      } else if (head) {
        if (!hitsLine(head, m.changed.RIGHT)) continue;
        out.push({ path: p, ref: head.ref, line: head.line, quote: head.text, change: 'added', deltas: valueDeltas('', body(head.raw)) });
      } else if (hitsLine(base, m.changed.LEFT)) {
        out.push({ path: p, ref: base.ref, line: base.line, quote: base.text, previous: base.text, change: 'removed', deltas: valueDeltas(body(base.raw), ''), removedRaw: base.raw });
      }
    }
  }
  return out;
}

function codeToRequirement(hunks, items) {
  const index = buildIndex(items.map((i) => tokenize(`${i.path} ${i.heading} ${i.ref} ${i.text}`)));
  const per = hunks.map((h) => {
    const s = index.search(tokenize([h.context, h.identifiers.join(' '), h.literals.added.join(' '), h.literals.removed.join(' '), h.path].join(' ')));
    const top = [...s.keys()].filter((k) => s[k] > 0).sort((a, b) => s[b] - s[a]).slice(0, 5);
    return top.map((k) => ({ path: items[k].path, ref: items[k].ref, line: items[k].line, score: round(s[k]), k }));
  });
  const keep = new Set();
  for (const e of per.flat().sort((a, b) => b.score - a.score)) if (keep.size < 15 || keep.has(e.k)) keep.add(e.k);
  return hunks.map((h, i) => ({ path: h.path, line: h.line, context: h.context,
    candidates: per[i].filter((e) => keep.has(e.k)).map(({ k, ...e }) => e) })).filter((h) => h.candidates.length);
}

const numeric = (v) => /^\d+(?:[.,]\d+)*(?:\s*\S+)?$/.test(v) ? v.replace(/^(\d+(?:[.,]\d+)*).*$/, '$1') : null;

function requirementToCode({ cwd, head, entries, skip, crits, maps }) {
  const eligible = entries.filter((e) => e.size <= MAX_FILE && !skip(e.path));
  const lits = [...new Set(crits.flatMap((c) => c.lits))];
  const litRe = lits.map((l) => new RegExp(`(?<![\\w])${esc(l)}(?![\\w])`));
  const queries = crits.map((c) => tokenize(`${c.quote} ${c.previous || ''}`));
  const meta = [], litHits = new Map();
  function* windows() {
    for (let s = 0; s < eligible.length; s += 300) {
      const part = eligible.slice(s, s + 300), bufs = catBatch(cwd, part.map((e) => e.sha));
      for (let f = 0; f < part.length; f++) {
        if (!bufs[f] || bufs[f].includes(0)) continue;
        const lines = bufs[f].toString('utf8').split(/\r?\n/), pt = tokenize(part[f].path);
        const lt = lines.map((l) => tokenize(l.slice(0, 400))), lh = lines.map((l) => lits.flatMap((x, i) => (l.includes(x) && litRe[i].test(l) ? [i] : [])));
        for (let a = 0; a < lines.length; a += STEP) {
          const z = Math.min(a + WIN, lines.length), toks = pt.slice(), hit = new Set();
          for (let i = a; i < z; i++) { for (const t of lt[i]) toks.push(t); for (const h of lh[i]) hit.add(h); }
          meta.push([part[f].path, a + 1, z]);
          if (hit.size) litHits.set(meta.length - 1, hit);
          yield toks;
          if (z >= lines.length) break;
        }
      }
    }
  }
  const index = buildIndex(windows(), new Set(queries.flat()));
  const shaOf = new Map(entries.map((e) => [e.path, e.sha]));
  return crits.map((c, qi) => {
    const s = index.search(queries[qi]);
    const mine = c.lits.map((l) => lits.indexOf(l));
    for (const [i, hs] of litHits) if (mine.some((x) => hs.has(x))) s[i] += 2;
    const order = [...s.keys()].filter((i) => s[i] > 0).sort((a, b) => s[b] - s[a]);
    const pick = (isTest, n) => {
      const out = [];
      for (const i of order) {
        const [p, a, z] = meta[i];
        if (isTestPath(p) !== isTest || out.some((o) => o.path === p && Math.abs(o.line - a) < WIN)) continue;
        const hits = [...new Set(queries[qi])].filter((t) => index.has(t, i)).sort((x, y) => index.idf(y) - index.idf(x)).slice(0, 5);
        out.push({ path: p, line: a, end: z, score: round(s[i]), hits });
        if (out.length === n) break;
      }
      return out;
    };
    const code = pick(false, 8), tests = pick(true, 5);
    for (const t of transitiveTests({ cwd, head, code, shaOf, total: eligible.length })) {
      const dup = tests.find((x) => x.path === t.path);
      if (dup) dup.via = t.via; else tests.push(t);
    }
    return { criterion: c.id, code, tests: tests.slice(0, 8) };
  });
}

// Test-transitive step: the rarest identifiers of each top production window, grepped in test paths.
function transitiveTests({ cwd, head, code, shaOf, total }) {
  const out = [];
  for (const w of code) {
    const buf = catBatch(cwd, [shaOf.get(w.path)])[0];
    if (!buf) continue;
    const text = buf.toString('utf8').split(/\r?\n/).slice(w.line - 1, w.end).join('\n');
    const cands = [...new Set(text.match(/[A-Za-z_$][\w$]{3,}/g) || [])]
      .map((id) => [id, (/[a-z][A-Z]|_|^[A-Z0-9_]+$/.test(id) ? 10 : 0) + Math.min(id.length, 12)]).sort((a, b) => b[1] - a[1]).slice(0, 12).map((x) => x[0]);
    if (!cands.length) continue;
    let res;
    try { res = gitGrep(cwd, ['grep', '-n', '-I', '-w', '-F', ...cands.flatMap((c) => ['-e', c]), head, '--']); } catch { continue; }
    const per = new Map(cands.map((c) => [c, { files: new Set(), tests: new Map() }]));
    for (const l of res.split('\n').slice(0, 20000)) {
      const m = GREP_HIT.exec(l);
      if (!m) continue;
      for (const c of cands) if (new RegExp(`(?<![\\w$])${esc(c)}(?![\\w$])`).test(m[3])) {
        const e = per.get(c); e.files.add(m[1]);
        if (isTestPath(m[1]) && !e.tests.has(m[1])) e.tests.set(m[1], +m[2]);
      }
    }
    [...per].filter(([, e]) => e.tests.size).sort((a, b) => a[1].files.size - b[1].files.size).slice(0, 3).forEach(([id, e]) => {
      for (const [p, l] of [...e.tests].slice(0, 3)) out.push({ path: p, line: Math.max(1, l - 10), end: Math.max(1, l - 10) + 39, score: round(Math.log(total / e.files.size)), via: id });
    });
  }
  const seen = new Set();
  return out.filter((t) => !seen.has(t.path) && seen.add(t.path));
}

function occurrences({ cwd, head, crits, maps }) {
  const out = [];
  const pathspec = ['.', ...LOCK_EXCLUDES.map((g) => `:(exclude,glob)${g}`)];
  for (const c of crits) for (const value of c.deltas.removed) {
    const variants = durationVariants(value), pats = [...new Set([...variants, value])].filter((v) => v.length > 1 || /\d/.test(v));
    const res = gitGrep(cwd, ['grep', '-n', '-I', '-w', '-F', ...pats.flatMap((p) => ['-e', p]), head, '--', ...pathspec]);
    const words = new Set(tokenize(c.quote + ' ' + (c.previous || '')));
    const hits = [];
    for (const l of res.split('\n')) {
      const m = GREP_HIT.exec(l);
      if (!m) continue;
      hits.push({ path: m[1], line: +m[2], text: m[3].replace(/\r/g, ' ').trim().slice(0, 200), kind: pathKind(m[1]), touched_in_pr: !!maps.get(m[1])?.changed.RIGHT.has(+m[2]),
        o: tokenize(m[3] + ' ' + m[1]).filter((t) => words.has(t)).length });
    }
    const order = ['test', 'src', 'config', 'snapshot', 'doc'];
    hits.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || b.o - a.o || (a.path < b.path ? -1 : a.path > b.path ? 1 : a.line - b.line));
    out.push({ criterion: c.id, value, variants, hits: hits.slice(0, 50).map(({ o, ...h }) => h) });
  }
  return out;
}

// Writes spec-files.txt, requirements-index.md, trace-candidates.json and extends requirements-status.json.
// Returns the number of changed normative items.
function run({ cwd = '.', base, head, ctx, reqPaths = '', trace = '', ignoreExtra = '' }) {
  const cand = { requirement_to_code: [], code_to_requirement: [], occurrences: [], limitations: [] };
  const write = (name, s) => fs.writeFileSync(path.join(ctx, name), s);
  const statusFile = path.join(ctx, 'requirements-status.json');
  let status = {};
  try { status = JSON.parse(fs.readFileSync(statusFile, 'utf8')); } catch { /* requirements.js did not run */ }
  const spec = { files: 0, items: 0, limitations: cand.limitations };
  const finish = (n, specFiles = [], index = '') => {
    write('spec-files.txt', specFiles.map((f) => f + '\n').join(''));
    write('requirements-index.md', index);
    write('trace-candidates.json', JSON.stringify(cand, null, 2) + '\n');
    write('requirements-status.json', JSON.stringify({ ...status, spec }, null, 2) + '\n');
    return n;
  };
  if (String(trace).toLowerCase() === 'off') return finish(0);
  const lim = (what, e) => cand.limitations.push(`${what} failed (${String(e && e.message || e).split('\n')[0].slice(0, 120)}); continuing without it.`);
  const d = discover({ cwd, head, reqPaths, ignoreExtra });
  cand.limitations.push(...d.limitations);
  const docs = [...d.docs.values()], allItems = docs.flatMap((x) => x.items);
  spec.files = docs.length; spec.items = allItems.length;

  const patch = git(cwd, ['diff', '--no-color', '--no-ext-diff', '--no-renames', `${base}...${head}`], { encoding: 'utf8' });
  const maps = parseDiff(patch);
  // changed requirement items (head docs, plus docs that were requirement docs at base: deleted or emptied)
  const specCand = [...maps.keys()].filter((p) => !d.excluded(p) && (d.docs.has(p) || (!d.ruled(p) && DOC_EXT.test(p) && !SKIP_NAME.test(p)) || d.forced(p)));
  const baseBufs = specCand.length ? catBatch(cwd, specCand.map((p) => `${base}:${p}`)) : [];
  const files = [];
  specCand.forEach((p, k) => {
    const hd = d.docs.get(p), b = baseBufs[k];
    const baseItems = b && !b.includes(0) && b.length <= MAX_FILE ? parseItems(p, b.toString('utf8')) : [];
    if (!hd && !isRequirementDoc(baseItems)) return;
    files.push({ path: p, headItems: hd ? hd.items : [], baseItems, text: hd ? hd.text : null });
  });
  const changed = changedItems(files, maps);
  const documents = [], criteria = [];
  changed.forEach((c, i) => {
    const { path: p, removedRaw, ...rest } = c;
    criteria.push({ id: `S${i + 1}`, source: p, ...rest });
    if (c.change === 'removed') documents.push({ source: `${p} (removed)`, text: removedRaw });
  });
  for (const f of files) if (f.text !== null && changed.some((c) => c.path === f.path)) documents.unshift({ source: f.path, text: f.text });
  status.criteria = (status.criteria || []).concat(criteria);
  status.documents = (status.documents || []).concat(documents);

  // A: code hunks -> requirement items
  try {
    const hunks = codeHunks(patch).filter((h) => !h.is_test && !d.docs.has(h.path) && !d.ruled(h.path) && !DOC_EXT.test(h.path));
    if (allItems.length && hunks.length) cand.code_to_requirement = codeToRequirement(hunks, allItems);
  } catch (e) { lim('code-to-requirement ranking', e); }
  // B: changed requirement items -> code and tests; occurrence table
  const crits = criteria.map((c) => ({ id: c.id, quote: c.quote, previous: c.previous, deltas: c.deltas,
    lits: [...new Set([...c.deltas.removed, ...c.deltas.added].map((v) => numeric(v) ?? v))] }));
  if (crits.length) {
    try { cand.requirement_to_code = requirementToCode({ cwd, head, entries: d.entries, maps, crits, skip: (p) => d.docs.has(p) || d.ruled(p) }); } catch (e) { lim('requirement-to-code ranking', e); }
    try { cand.occurrences = occurrences({ cwd, head, crits: crits.filter((c) => c.deltas.removed.length), maps }); } catch (e) { lim('occurrence search', e); }
  }

  // index: path:line [ref] text, hinted docs first, capped; over the cap only candidate and changed items remain
  const line = (i) => `${i.path}:${i.line} [${i.ref}] ${flat(i.text).slice(0, 160)}\n`;
  let index = allItems.map(line).join('');
  if (Buffer.byteLength(index) > INDEX_CAP) {
    const want = new Set([...cand.code_to_requirement.flatMap((h) => h.candidates.map((c) => `${c.path}:${c.ref}`)), ...criteria.map((c) => `${c.source}:${c.ref}`)]);
    index = allItems.filter((i) => want.has(`${i.path}:${i.ref}`)).map(line).join('');
    while (Buffer.byteLength(index) > INDEX_CAP) index = index.slice(0, index.lastIndexOf('\n', index.length - 2) + 1);
    cand.limitations.push(`requirements-index.md exceeded ${INDEX_CAP / 1024} KB; it lists only candidate and changed items.`);
  }
  return finish(criteria.length, docs.map((x) => x.path), index);
}

if (require.main === module) {
  const env = process.env, [cmd, ...args] = process.argv.slice(2);
  const off = String(env.TRACE || '').toLowerCase() === 'off';
  if (cmd === 'classify') {
    const out = off ? [] : classify({ base: env.BASE_SHA, head: env.HEAD_SHA || 'HEAD', paths: args, reqPaths: env.REQ_PATHS, ignoreExtra: env.IGNORE_EXTRA });
    process.stdout.write(out.map((p) => p + '\n').join(''));
  } else {
    process.stdout.write(`${run({ base: env.BASE_SHA, head: env.HEAD_SHA, ctx: env.CTX, reqPaths: env.REQ_PATHS, trace: env.TRACE, ignoreExtra: env.IGNORE_EXTRA })}\n`);
  }
}

module.exports = { tokenize, buildIndex, parseItems, isRequirementDoc, pairItems, valueDeltas, durationVariants, isTestPath, pathKind,
  codeHunks, matchGlob, classify, run };
