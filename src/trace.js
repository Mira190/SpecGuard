// Requirement <-> code trace candidates (docs/traceability-plan.md section 4.1). No AI, no language knowledge,
// Node built-ins only. Everything is read from git objects at BASE/HEAD, never from PR-controlled symlinks.
// Usage: node trace.js classify <paths...>   (prints the subset that are requirement docs)
//        node trace.js                       (full run; stdout = number of changed normative items)
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { parseDiff } = require('./post');
const { DENY } = require('./deny.js');

const DOC_EXT = /\.(md|mdx|markdown|rst|adoc|txt|feature)$/i;
const docLike = (p) => DOC_EXT.test(p) && (!/\.txt$/i.test(p) || UNREADABLE_NAME.test(path.basename(p))); // a .txt is a document only when named like one (not CMakeLists.txt, licences, test data)
const SKIP_NAME = /(^|\/)(CHANGELOG|LICENSE|CODE_OF_CONDUCT|SECURITY)[^/]*$/i;
const UNREADABLE = /\.(docx|pdf|xlsx)$/i, UNREADABLE_NAME = /(requirement|spec|prd|acceptance)/i;
const HINTS = [/(^|\/)(docs?|spec|specs|requirements)\//i, /\.feature$/i, /(^|\/)adrs?\//i, /^\.kiro\/specs\//, /^openspec\//];
const MAX_FILE = 256 * 1024, MAX_CANDIDATES = 2000, MAX_DOCS = 500, INDEX_CAP = 60 * 1024;
const MAX_CRITERIA = 200, MAX_CHANGED_DOCS = 100, MAX_PATCH = 16 << 20, MAX_LINE = 300, MAX_DOC_BYTES = 48 << 20;
const CONTROL = /[\x00-\x1F\x7F]/; // git allows these in paths; every list we write is newline-delimited
const WIN = 40, STEP = 20;
const MAX_BIG = 2 << 20; // a requirement doc over MAX_FILE is read (only when changed) up to this size
const SIMILAR = 0.3; // token overlap (Jaccard) at which an edited block pairs with its old version
const MAX_REJECTED = 20; // spec-rejected.txt lines
const BUDGET_MS = 40000, MAX_DEEP = 25, MAX_DELTAS = 20, MAX_LITS = 200, MAX_VALUES = 40; // time budget; S items traced to code; per-item / per-run search breadth
const MAX_HUNKS = 60, CAND_CAP = 60 * 1024, PER_HUNK = 5, FLOOR = 0.3, SURE = 3, TOP_CAND = 3; // trace-candidates.json caps; a BM25 floor (share of the hunk best) applies after the first SURE candidates
const MAX_MORE = 5, BLOCK_PER_HUNK = 3, BLOCK_TOTAL = 20, BLOCK_MIN = 2; // descriptive-block candidates: per hunk, overall, and the BM25 score a block must exceed, in units of the idf of a term seen in one block (about two rare terms' worth; idf grows with the corpus)
// Words that match every doc and every program: dropped from the hunk query when ranking descriptive blocks. ponytail: English and JS-flavoured, extend when another language floods the candidates.
const GOVERN_MIN = 8, GOVERN_GAP = 0.95, MAX_GOVERNING = 3; // D criteria: BM25 score from 8 (live: 15.5 for the governing sentence, other normative items <= 2.6; the 2-term floor of a 40-block corpus is ~6.6); no second block within 5% of the best
const BLOCK_STOP = new Set('the is it an of to in and or as are be for from with that this on by at not no use src ts tsx js cjs return const let var function async await export import true false null undefined string number boolean type interface class void if else'.split(' '));
// Sample and vendored trees are never requirement-document candidates (a requirements_paths entry or a PR-named document still admits one).
const FIXTURE_PATH = /(^|\/)(fixtures|__fixtures__|testdata|test-data|vendor|node_modules|third_party)\/|^eval\/cases\/|(^|\/)(tests?|__tests__|spec)\/(?:.*\/)?examples\//i;
const NOT_CODE_DIR =/(^|\/)(testdata|fixtures?|__fixtures__|__snapshots__|vendor|third_party|generated)\//i; // hunks there rarely trace to a requirement
// A wall-clock budget shared by the expensive loops; they stop early and the run records a limitation instead of being killed.
const makeClock = (ms) => { const end = Date.now() + ms; return { left: () => end - Date.now(), over: () => Date.now() >= end }; };
// Mirrors the globs in collect.sh. ponytail: duplicated, keep in sync (collect.sh could export them later).
const EXT5 = ['md', 'mdx', 'rst', 'txt', 'adoc'];
const RULE_GLOBS = [
  '.github/copilot-instructions.md', '.github/instructions/**', '**/AGENTS.md', '**/AGENT.md', '**/CLAUDE.md', '**/GEMINI.md',
  'REVIEW.md', 'CONTRIBUTING.md', 'CODING_STANDARDS.md', '.editorconfig', ...EXT5.flatMap((e) => [`docs/*standards*.${e}`, `docs/*conventions*.${e}`]),
  '.claude/rules/**', '.github/skills/**', '.claude/skills/**', '.agents/skills/**', '.cursorrules', '.cursor/rules/**', '.windsurfrules', '.clinerules/**',
  '.cursor/BUGBOT.md', '**/BUGBOT.md', '.gemini/styleguide.md', '.greptile/rules.md',
  '.claude/**', '.mcp.json', '.claude.json', 'CLAUDE.local.md', '.gitmodules', '.ripgreprc', '.husky/**', '.github/hooks/**', '.github/copilot/**', '.github/mcp.json',
  'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'Cargo.lock', 'poetry.lock', 'go.sum', 'composer.lock', 'Gemfile.lock', '*.lock',
  '.specguard-ctx/', 'dist/', 'build/', 'vendor/', 'node_modules/', '*.min.*', '__snapshots__/', '*.snap',
  '**/skills/test-review/**', '.github/instructions/test-review.instructions.md',
];
const LOCK_EXCLUDES = ['**/node_modules/**', '**/vendor/**', '**/dist/**', '**/*.lock', '**/package-lock.json', '**/pnpm-lock.yaml', '**/go.sum'];

// collect.sh `match`: '*' crosses '/', a leading '**/' is optional, a trailing '/' means a directory prefix, a leading '/' anchors at the repository root (`/docs/**` is not `eval-sandbox/x/docs/`).
function matchGlob(file, pattern) {
  const root = pattern.startsWith('/'), p = pattern.replace(/^\/|^\*\*\//, '');
  const re = p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*+/g, '.*').replace(/\?/g, '[^/]');
  return new RegExp(`^${root ? '' : '(?:.*/)?'}${re}${p.endsWith('/') ? '.*' : ''}$`).test(file);
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
    size: i, idf, df: (t) => post.get(t)?.d.length || 0,
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
const ID = String.raw`(?:AC\s?\d+|[A-Z][A-Z0-9]*(?:[-_.][A-Z0-9]+)*(?<=\d))`; // linear: quantifiers are separated by distinct delimiters; the last char must be a digit
const ID_LINE = new RegExp(String.raw`^\s*(?:[-*+]\s+|\d+[.)]\s+)?(#{1,6}\s+)?[*_\[]*(${ID})[*_\]\`]*\s*(?:[:：)\-—–]|\.(?!\w))`); // not a backtick opener (`ENABLE_IPV6` - text) nor a file name or version ([CHANGELOG-1.38.md])
// A Markdown link reference definition ('[KEP-1]: https://...') is a label for a URL, not an item.
const LINKDEF = /^\s*(?:[-*+]\s+|\d+[.)]\s+)?\[[^\]]+\]:\s*(?:(?:[a-z][a-z0-9+.-]*:\/\/|\/|\.{1,2}\/|#|<|mailto:)\S*(?:\s+["'(].*)?|\S+(?:\s+\S+){0,3})\s*$/i; // or a 1-4 word title: '[KEP-4671]: Gang Scheduling.'
const INLINE_LINK = /^\s*(?:[-*+]\s+|\d+[.)]\s+)?\[[^\]]*\](?:\(|\[)/; // '[KEP-5972: Dynamic Containers](https://...) permits...' is a sentence, not an ID
const idLine = (l) => { // an ID label sits in the first MAX_LINE chars
  const c = l.length > MAX_LINE ? l.slice(0, MAX_LINE) : l, m = LINKDEF.test(c) || INLINE_LINK.test(c) ? null : ID_LINE.exec(c);
  if (!m) return null;
  if (/_/.test(m[2]) && !/[-.]/.test(m[2]) && !/[:：]$/.test(m[0])) return null; // CURLOPT_FOO - text, MACRO_NAME): a code name, not a requirement ID
  if (!m[1] && !c.slice(m[0].length).trim()) return null; // 'VS2013.' : an ID needs text after it unless it is a heading
  return m;
};
const AC_HEAD = /^(acceptance criteria|acceptance tests|验收标准|验收条件|AC)\s*[:：]?$/i;
const LIST_ITEM = /^\s*(?:[-*+]\s+(?:\[[ xX]\]\s*)?|\d+[.)]\s+)(.+)$/;
// Gherkin keywords count in .feature files and in fenced gherkin/feature blocks, or in a document that also has Given/When/Then steps.
// A bare 'Example:' (prose, YAML front matter) is a scenario only in a .feature file.
// Also OpenSpec's '#### Scenario: name' headings and a bold keyword ('**Scenario:** name').
const GHERKIN = /^\s*(?:#{1,6}\s+)?(?:\*\*)?(Feature|Rule|Scenario Outline|Scenario Template|Scenario|Background)(?:\*\*)?\s*:(?:\*\*)?\s*(.*)$/;
const GHERKIN_EXAMPLE = /^\s*(Example)\s*:\s*(.*)$/;
// Steps are case-insensitive and may carry a bullet or number and bold: '- **WHEN** x', '1. **Given** x', 'then x'. ponytail: a prose line starting with 'When' also counts; harmless without a Scenario: line.
const GHERKIN_STEP = /^\s*(?:(?:[-*+]|\d+[.)])\s+)?(?:\*\*)?(Given|When|Then)\b/i;
// Spec Kit specs/<feature>/tasks.md, Kiro .kiro/specs/<feature>/tasks.md, OpenSpec openspec/changes/<change>/tasks.md.
const TASKS_FILE = /(?:^|\/)(?:specs|openspec\/changes)\/(?:[^/]+\/)*tasks\.md$/i;
const FENCE =/^ {0,3}(`{3,}|~{3,})(.*)$/;
const ID_MAX_LINES = 60, ID_MAX_CHARS = 3000; // an ID'd item is a requirement, not a chapter
const NORMATIVE = /(?<![\w-])(shall|must|required to)(?![\w-])|必须|应当|不得/i; // not inside an identifier like triage-must-have
const TABLE_ROW = /^\s*\|.*\|\s*$/, TABLE_RULE = /^\s*\|[\s:|-]+\|\s*$/; // a Markdown table row pairs by its first cell
const SECOND_PERSON = /\b(you|your|you're|please)\b/i;
const IMPERATIVE = /^(run|use|install|make|ensure|add|check|create|open|build|push|commit|update|write|set|do|don't|never|always|avoid|keep|remember|read|see|follow|try|test)\b/i;
const strip = (l) => l.replace(/^\s*(?:[-*+]\s+(?:\[[ xX]\]\s*)?|\d+[.)]\s+)?(?:#{1,6}\s+)?/, '').trim();

// Fence state per line. CommonMark: an opener has at most 3 spaces of indent and, for backticks, no backtick in its info string;
// a closer is the same character, at least as long, with nothing after it. An unclosed fence makes the result one entry longer.
function scanFences(lines, mode) {
  const fenced = new Array(lines.length).fill(false), info = new Array(lines.length).fill('');
  let o = null;
  if (mode === 'marks') lines.forEach((l, i) => { if (FENCE.test(l)) fenced[i] = true; }); // fence-free re-parse still skips the marker lines themselves
  else if (mode === 'on') lines.forEach((l, i) => {
    const m = FENCE.exec(l);
    if (o) { fenced[i] = true; info[i] = o.info; if (m && m[1][0] === o.ch && m[1].length >= o.len && !m[2].trim()) o = null; }
    else if (m && !(m[1][0] === '`' && m[2].includes('`'))) { o = { ch: m[1][0], len: m[1].length, info: m[2].trim().toLowerCase() }; fenced[i] = true; info[i] = o.info; }
  });
  if (o) fenced.push(true);
  return { fenced, info };
}

// Item records: { path, ref, line, end, heading, text (<=600), raw, kind: id|ac|gherkin|normative|changed, normative: true }.
// touch (optional, anything with .has(line)): the diff's changed lines of this side. Every paragraph, list item or table row that is not already
// an ID/AC/Gherkin item and holds a touched line becomes one `changed` item (descriptive text counts, no normative word needed); it replaces that block's normative sentences.
function parseItems(file, text, touch = null) {
  const lines = lf(clean(text)).split('\n'), n = lines.length;
  const feature = /\.feature$/i.test(file);
  const head = new Array(n).fill(null);
  let { fenced, info } = scanFences(lines, feature ? 'none' : 'on');
  if (fenced.length > n) ({ fenced, info } = scanFences(lines, 'marks')); // an unclosed fence is a stray marker: parse without fences
  if (!feature && lines[0].trim() === '---' && /^[\w.-]+\s*:/.test(lines[1] || '')) { // YAML front matter is metadata, not requirements
    const e = lines.findIndex((l, i) => i > 0 && i < 200 && /^(---|\.\.\.)\s*$/.test(l));
    for (let k = 0; k <= e; k++) fenced[k] = true;
  }
  if (!feature) { // HTML comments are template instructions, not rendered text
    let cm = false;
    lines.forEach((l, i) => {
      if (fenced[i]) return;
      if (cm || /^\s*<!--/.test(l)) fenced[i] = true;
      if (l.lastIndexOf('<!--') > l.lastIndexOf('-->')) cm = true; else if (l.includes('-->')) cm = false;
    });
  }
  let cur = null;
  lines.forEach((l, i) => {
    const h = !fenced[i] && !feature && /^(#{1,6})\s+(.+)$/.exec(l);
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
  // 0. tasks.md: one item per checkbox line. The [ ] / [x] state is part of the item, so ticking a task is a change.
  if (TASKS_FILE.test(file)) for (let i = 0; i < n; i++) {
    const m = !fenced[i] && /^\s*[-*+]\s+\[([ xX])\]\s+(\S.*)$/.exec(lines[i]);
    if (!m) continue;
    const id = /^\**(T\d+|\d+(?:\.\d+)*)\b/.exec(m[2]), raw = `[${m[1] === ' ' ? ' ' : 'x'}] ${m[2].trim()}`;
    items.push({ path: file, ref: `task#${id ? id[1] : slug(m[2]).slice(0, 40)}`, line: i + 1, end: i + 1, heading: head[i]?.text || '', text: raw.slice(0, 600), raw, kind: 'task', normative: true });
    covered.add(i);
  }
  // 1. ID'd items
  for (let i = 0; i < n; i++) {
    if (fenced[i] || covered.has(i)) continue;
    const m = idLine(lines[i]);
    if (!m) continue;
    const level = m[1] ? m[1].trim().length : 0;
    const stop = (j, deep) => { for (; j < n; j++) {
      if (!fenced[j] && idLine(lines[j])) break;
      const h = !feature && !fenced[j] && /^(#{1,6})\s/.exec(lines[j]);
      if (h && (!level || deep || h[1].length <= level)) break;
      if (!level && !lines[j].trim()) break;
    } return j; };
    let j = stop(i + 1, false);
    if (j - i > ID_MAX_LINES || lines.slice(i, j).join('\n').length > ID_MAX_CHARS) {
      if (level === 1) continue; // a document title (# KEP-1: Title) is not one requirement
      j = Math.min(stop(i + 1, true), i + ID_MAX_LINES); // the heading and its own text; sub-headings become their own items
      while (j > i + 1 && lines.slice(i, j).join('\n').length > ID_MAX_CHARS) j--;
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
  const starts = [], gfence = (i) => /^(gherkin|feature)\b/.test(info[i]);
  const hasSteps = feature || lines.some((l, i) => (!fenced[i] || gfence(i)) && GHERKIN_STEP.test(l));
  let doc = null; // inside a """ or ``` docstring (.feature only): nested 'Scenario:' lines are text
  for (let i = 0; i < n && hasSteps; i++) {
    if (fenced[i] && !gfence(i)) continue;
    if (feature) { const d = /^\s*(""")|^\s*(```)/.exec(lines[i]); if (d) { const k = d[1] || d[2]; if (!doc) doc = k; else if (doc === k) doc = null; continue; } if (doc) continue; }
    else if (fenced[i] && FENCE.test(lines[i])) continue;
    const g = GHERKIN.exec(lines[i]) || (feature && GHERKIN_EXAMPLE.exec(lines[i]));
    if (!g) continue;
    let t = i; while (t > 0 && /^\s*@\S/.test(lines[t - 1])) t--;
    starts.push({ i, t, kind: g[1], name: g[2].trim() });
  }
  // Background steps are preconditions of every scenario below them (Feature-level, plus the Rule-level one inside a Rule): carried on the item as ctx
  // (text) and ctxAt (line ranges), outside raw so the block's cid, which hashes its own text, does not change.
  let featBg = null, ruleBg = null, inRule = false;
  starts.forEach((s, k) => {
    if (s.kind === 'Feature') { featBg = ruleBg = null; inRule = false; return; }
    if (s.kind === 'Rule') { ruleBg = null; inRule = true; return; }
    let z = (starts[k + 1] ? starts[k + 1].t : n) - 1;
    if (!feature) for (let q = s.i + 1; q <= z; q++) if (/^ {0,3}(```|~~~)\s*$/.test(lines[q]) || (!fenced[q] && /^#{1,6}\s/.test(lines[q]))) { z = q - 1; break; } // a prose scenario ends at its fence or next heading
    if (s.kind === 'Background') {
      while (z > s.i && !lines[z].trim()) z--;
      const bg = { text: lines.slice(s.i, z + 1).map((l, q) => (q === 0 ? strip(l) : l.trim())).join('\n'), at: [s.i + 1, z + 1] };
      if (inRule) ruleBg = bg; else featBg = bg;
      return;
    }
    const tags = lines.slice(s.t, s.i).join(' ').split(/\s+/).filter((x) => x.startsWith('@'));
    const before = items.length;
    push('gherkin', tags.find((x) => /\d/.test(x)) || `Scenario: ${s.name}`, s.t, z, '');
    const bgs = [featBg, ruleBg].filter(Boolean);
    if (bgs.length && items.length > before) Object.assign(items[before], { ctx: bgs.map((x) => x.text).join('\n'), ctxAt: bgs.map((x) => x.at) });
  });
  // 4. normative fallback on uncovered prose
  const ord = new Map();
  for (let i = 0; i < n; i++) {
    if (fenced[i] || covered.has(i) || !lines[i].trim() || (!feature && /^#{1,6}\s/.test(lines[i]))) continue;
    const row = TABLE_ROW.test(lines[i]);
    if (row && TABLE_RULE.test(lines[i])) continue;
    let j = i; // paragraph: consecutive prose lines, a new list item starts a new paragraph; a table row is its own paragraph
    while (!row && j + 1 < n && !fenced[j + 1] && !covered.has(j + 1) && lines[j + 1].trim() && !LIST_ITEM.test(lines[j + 1]) && !TABLE_ROW.test(lines[j + 1]) && !/^#{1,6}\s/.test(lines[j + 1])) j++;
    const cell = row ? slug(lines[i].replace(/^\s*\|/, '').split('|')[0].replace(/[*_`]/g, '')) : '';
    const listItem = LIST_ITEM.test(lines[i]);
    const para = lines.slice(i, j + 1).map((l, k) => (k === 0 ? strip(l) : l.trim())).join('\n');
    if (touch && !feature) {
      let hit = false;
      for (let l = i + 1; l <= j + 1 && !hit; l++) hit = touch.has(l);
      if (hit && !(row && TABLE_RULE.test(lines[i + 1] || ''))) { // a table header row is not a block. ref = heading + first words: an inserted neighbour does not shift the pairing; an edited opening pairs by similarity in pairItems
        const heading = head[i]?.text || '';
        items.push({ path: file, ref: `${slug(heading) || 'doc'}#${slug(strip(lines[i])).slice(0, 40) || 'p'}`, line: i + 1, end: j + 1, heading, text: para.slice(0, 600), raw: para, kind: 'changed', normative: true });
        i = j; continue;
      }
    }
    for (const s of para.matchAll(/\S[\s\S]*?(?:[.!?。！？](?=\s|$)|$)/g)) {
      const sentence = s[0].trim();
      if (!NORMATIVE.test(sentence.replace(/`[^`]*`/g, ' ')) || SECOND_PERSON.test(sentence) || (listItem && IMPERATIVE.test(sentence))) continue;
      const a = i + (para.slice(0, s.index).match(/\n/g) || []).length;
      const z = a + (sentence.match(/\n/g) || []).length;
      const heading = head[i]?.text || '', key = slug(heading) || 'doc';
      const k = (ord.get(key) || 0) + 1; ord.set(key, k);
      items.push({ path: file, ref: `${key}#${cell || k}`, line: a + 1, end: z + 1, heading, text: sentence.slice(0, 600), raw: sentence, kind: 'normative', normative: true });
    }
    i = j;
  }
  return items.sort((x, y) => x.line - y.line);
}

// Block universe (shared by audit mode and the PR trace): every requirement-bearing block (paragraph, list item, table row, ID/AC/Gherkin item) of a
// document, in document order (parseItems with every line "touched"), minus headings, table headers, link refs, tiny blocks and Changelog/History/References sections.
const ALL = { has: () => true };
const MIN_BLOCK = 20; // characters of text a block needs to be a candidate
const SKIP_HEAD = /^(?:change ?logs?|(?:revision |version |document |release )?history|release notes|references?)$/i; // blocks under these are not requirements
const LINKREF = /^\s*(?:[-*+]\s+)?\[[^\]]+\]:\s*\S+/;
const NORM_WORD = /\b(?:shall|must|should|will)\b/i;

// Lines under a Changelog/History/References heading, until the next heading of the same or a higher level.
function skippedLines(ls) {
  const skip = new Array(ls.length).fill(false);
  let fence = false, level = 0;
  ls.forEach((l, i) => {
    if (FENCE.test(l)) fence = !fence;
    const h = !fence && /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(l);
    if (h) {
      if (level && h[1].length <= level) level = 0;
      if (!level && SKIP_HEAD.test(h[2].replace(/^[\d.\s§]+/, '').replace(/[*_`]/g, '').trim())) level = h[1].length;
    }
    skip[i] = level > 0;
  });
  return skip;
}

// Deterministic prefilter: blocks that are data or status, not behavioural requirements, never reach the model (scan) or the candidate list (PR mode).
// ponytail: English-only word lists and a numeric-cell share; a miss only costs a model call, so every rule leans to "keep the block". Tune by eye on real design docs.
const RESULT_WORD = String.raw`results?|evaluation|status|change ?logs?|history|metrics|benchmarks?|measurements?`;
const RESULT_ROW_HEAD = new RegExp(String.raw`\b(?:${RESULT_WORD})\b`, 'i'); // a table row under any heading that names one of these is a data row
const RESULT_PROSE_HEAD = new RegExp(String.raw`^(?:live |current |latest |pilot )?(?:${RESULT_WORD}|sources?|bibliography)$`, 'i'); // prose only under a bare "Status (2026-10-07)" / "Results" heading
const NUM_ROW = 0.6, NUM_SOME = 0.34; // share of non-empty cells that must be numeric-ish for a row to be data; and for a row under a results/status heading (a mutation-benchmark table of expectations has none)
const MONTH = String.raw`(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*`;
const DATE_CELL = new RegExp(String.raw`^(?:\d{4}-\d\d(?:-\d\d)?|\d{1,2}[/.]\d{1,2}[/.]\d{2,4}|${MONTH}\.?\s+\d{1,2}(?:,?\s+\d{4})?|\d{1,2}\s+${MONTH}(?:\s+\d{4})?)$`, 'i');
const NUM_CELL = /^[~≈<>≥≤±+$€£\s-]*\d[\d.,]*\s*(?:%|x|×|ms|s|sec|min|h|d|k|m|b|kb|mb|gb|tb|pp|pts?|\/\d[\d.,]*)?$|^\d[\d.,]*\s*\/\s*\d[\d.,]*$|^[0-9a-f]{7,40}$/i;
const CHECK_CELL = /^(?:[✓✔✅❌✗✘×☐☑☒⬜🟢🔴🟡]+|n\/a|na|-+|—|–|\?|tbd)$/i; // not yes/no/none: those are values of a behaviour table
const cellsOf = (l) => l.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((c) => c.replace(/[*_]/g, '').trim());
function dataShare(l) { // share of the row's non-empty cells that are numeric-ish
  const cs = cellsOf(l).filter(Boolean);
  if (cs.length < 2) return 0;
  const numeric = (c) => {
    const bare = c.replace(/^`|`$/g, '').trim();
    const flat = bare.replace(/[\s\p{P}\p{S}]/gu, '');
    const digits = (flat.match(/\d/g) || []).length; // 3+ digits, half the cell: "9, 6, 8 (mean 7.7)" yes, an id like "Q7" or "R12" no
    return NUM_CELL.test(bare) || (digits >= 3 && digits / flat.length >= 0.5) || DATE_CELL.test(bare) || CHECK_CELL.test(bare) || !c.replace(/\[[^\]]*\]\([^)]*\)|<?https?:\/\/\S+>?/g, '').trim(); // number, date, mark, or a cell that is only a link
  };
  return cs.filter(numeric).length / cs.length;
}
const linkOnly = (t) => !/\p{L}{3,}/u.test(t.replace(/\[[^\]]*\]\([^)]*\)|\[[^\]]*\]\[[^\]]*\]|<?https?:\/\/\S+>?/g, ' ').replace(/\b(?:see|also|and|or)\b/gi, ' ')) && /\[[^\]]*\]\(|https?:\/\//.test(t);
// A block with no verb-like token is a label or a caption. Verb-like (keep): a modal/auxiliary, a common behaviour verb, an -ed/-ing/-ize word, a plural/3rd-person -s word of 4+ letters, or a call like `f()`.
const VERBISH = new RegExp(String.raw`\b(?:at least|at most|up to|no more|no less|below|above|within|between|only|exactly|each|every|per|before|after|without|instead|except|maximum|minimum|is|are|was|were|be|been|am|has|have|had|do|does|did|will|would|shall|should|can|could|may|might|must|cannot|can't|won't|don't|doesn't|never|always|not|no|if|when|unless|until|else|then|use|run|set|add|create|write|return|send|read|show|display|reject|accept|validate|ensure|keep|store|log|emit|call|fail|skip|retry|pass|check|require|allow|prevent|block|support|open|close|get|put|make|take|give|let|stop|start|drop|find|match|apply|treat|mark|move|copy|load|save|post|fire|wait|hold|end|go|see|try|need|want|show|hide|click|press|tap|enter|choose|select|replace|remove|delete|update|build|ship|scale|fit|sort|split|join|merge|count|cap|limit|reset|clear)\b`, 'i');
function verbless(t) {
  const s = t.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
  if (/[^\p{Script=Latin}\P{L}]/u.test(s) || !/\b(?:the|a|an|of|to|in|on|for|with|and|or|by|at|from|vs)\b/i.test(s)) return false; // not English (another script, or no English function word): unknown, keep
  if (/\w\(\)|`[^`]*\([^`]*\)`/.test(s) || /[≥≤<>=]/.test(s) || VERBISH.test(s)) return false; // a threshold (>= 70%, at most 10) is a constraint
  return !(s.match(/\p{L}+/gu) || []).some((w) => (w.length >= 5 && /(?:ed|ing|ize|ise|ify)$/i.test(w)) || (w.length >= 4 && /s$/i.test(w) && !/(?:ss|us|is|ics)$/i.test(w)));
}
function ruleOut(i, l, row) {
  const share = row ? dataShare(l) : 0;
  if (share >= NUM_ROW) return 'results/data table row';
  if (row ? share >= NUM_SOME && RESULT_ROW_HEAD.test(i.heading) : RESULT_PROSE_HEAD.test(i.heading.replace(/^[\d.\s§]+/, '').replace(/\s*\([^)]*\)\s*$/, '').replace(/[*_`:]/g, '').trim())) return 'under a results/status/sources heading';
  if (linkOnly(i.text)) return 'link list';
  if (!row && verbless(i.text)) return 'no verb, a label rather than behaviour';
  return '';
}

// All candidate blocks of one document: { path, line, heading, text, raw }. ruled (optional array) receives the blocks the prefilter dropped, each with a `reason`.
function blocksOf(p, text, ruled = null) {
  const ls = String(text).replace(/\r\n/g, '\n').replace(/\r/g, ' ').split('\n'), skip = skippedLines(ls);
  return parseItems(p, text, ALL).filter((i) => {
    const l = ls[i.line - 1] || '';
    if (skip[i.line - 1] || LINKREF.test(l) || i.text.replace(/[|\s]+/g, ' ').trim().length < MIN_BLOCK) return false;
    const row = TABLE_ROW.test(l);
    if (row && TABLE_RULE.test(ls[i.line] || '')) return false; // a table header row
    if (i.end === i.line && /^\s*#/.test(l) && !NORM_WORD.test(l)) return false; // a bare heading
    const reason = ruleOut(i, l, row);
    if (reason && NORM_WORD.test(i.text)) return true; // an RFC 2119 word always keeps the block (a "Status" table row saying "must" stays)
    if (reason && ruled) ruled.push({ ...i, reason });
    return !reason;
  });
}

// Removed-literal anchor: a literal on a hunk's removed lines (not re-added) that an unchanged requirement block states as a whole value, with a term shared between block and hunk.
// Returns [{ block, removed, hunks }]. Trivially common literals need two shared terms.
const TRIVIAL_LIT = /^([01]|true|false|id|[a-z])$/i;
function removedLiteralAnchors(hunks, blocks) {
  const stop = (w) => w.length > 1 && !BLOCK_STOP.has(w) && !/^\d+$/.test(w);
  const found = new Map();
  for (const h of hunks) {
    const gone = h.literals.removed.filter((l) => !h.literals.added.includes(l) && (/^\d+(?:\.\d+)?$/.test(l) || [...l].length >= 2));
    if (!gone.length) continue;
    const terms = new Set([...h.identifiers, ...tokenize(h.path.replace(/^.*\//, '').replace(/\.[^.]*$/, ''))].filter(stop));
    for (const b of blocks) {
      const bt = new Set(tokenize(b.text));
      const shared = [...terms].filter((t) => bt.has(t)).length;
      for (const l of gone) {
        const num = /^\d+(?:\.\d+)?$/.test(l);
        if (!(num ? new RegExp(String.raw`(?<![\p{L}\d])(?<!\d[.,])${l.replace('.', String.raw`\.`)}(?![.,]?\d)`, 'u').test(b.text) : b.text.includes(l))) continue;
        if (shared < (TRIVIAL_LIT.test(l) || l === '' ? 2 : CJK_ONLY.test(l) ? 0 : 1)) continue;
        const k = `${b.path}:${b.ref}`, was = found.get(k) || { block: b, removed: l, hunks: [] };
        was.hunks.push({ path: h.path, start: h.line, end: h.end ?? h.line });
        found.set(k, was);
        break;
      }
    }
  }
  return [...found.values()];
}

const isRequirementDoc = (items) => items.some((i) => i.kind !== 'normative') || items.length >= 2;
// Stricter than isRequirementDoc, used to admit a document: prose alone needs 2+ items and either an RFC 2119 capital (MUST/SHALL/REQUIRED)
// or a dense run of them (long documents need more); structured items (ID, acceptance criteria, Gherkin) always admit. Spec directories keep the loose rule.
const STRONG_DIR = /(^|\/)(specs?|requirements|design|rfcs?|proposals)\/|(^|\/)adrs?\/|^\.kiro\/specs\/|^openspec\//i
// A file whose basename names itself a spec is as strong as a spec directory, in any directory: design.md, spec.md, api-spec.md, design_doc.md, product-requirements.md, prd.md, srs.txt, acceptance-criteria.md.
// Not: README, architecture, CONTRIBUTING, CHANGELOG, designer-notes, respect.md (the stem must be a whole word between -/_/. separators).
const STRONG_FILE = /(^|\/)([^/]*[-_.])?(design|specs?|specification|requirements?|prd|srs|acceptance(-criteria)?)([-_.](doc|docs|document|specs?|specification|requirements?|v?\d+))*(\.[^/.]+)?$/i; // after the spec word only doc/spec/version words: design-tokens.md, design-system.md are not specs
const DENSITY = 300, DENSITY_CAPS = 7000; // prose-only: one normative sentence per 300 bytes, or per 7 KB when one has an RFC 2119 capital: a long tutorial with a few stray "must" lines is not a spec
const SPEC_DIR = /(^|\/)(specs?|requirements)\/|^openspec\//i; // one normative sentence is enough for a file that lives in a spec directory
const isSpecDoc = (items, file = '', size = 0) => (isRequirementDoc(items) || (items.length === 1 && SPEC_DIR.test(file))) && (items.some((i) => i.kind !== 'normative') || STRONG_DIR.test(file) || STRONG_FILE.test(file) || items.length * DENSITY >= size || (items.length * DENSITY_CAPS >= size && items.some((i) => /\b(MUST|SHALL|REQUIRED)\b/.test(i.raw))));
// Directories of LLM prompts, command/workflow definitions and templates are instructions to a tool, not product requirements.
const NON_SPEC_DIR = /(^|\/)(templates?|prompts?|commands|workflows|agents|skills)\/|-template\.md$/i;
const specLike = (p) => docLike(p) && !NON_SPEC_DIR.test(p);

// Pair BASE and HEAD items by ref (k-th duplicate with k-th), then leftovers by heading + ordinal.
function pairItems(baseItems, headItems) {
  const pairs = [], bl = new Set(baseItems), byRef = new Map();
  for (const b of baseItems) { const k = b.ref; if (!byRef.has(k)) byRef.set(k, []); byRef.get(k).push(b); }
  const left = [];
  for (const h of headItems) {
    const b = byRef.get(h.ref)?.shift();
    if (b) { bl.delete(b); pairs.push({ base: b, head: h }); } else left.push(h);
  }
  // A changed block pairs only with a changed block of the same heading, the most similar one (an edited paragraph keeps most of its words); the rest are additions and removals.
  const byHeading = new Map(), hk = (x) => (x.kind === 'changed' ? `changed | ${x.heading}` : x.heading);
  for (const b of baseItems) if (bl.has(b)) { if (!byHeading.has(hk(b))) byHeading.set(hk(b), []); byHeading.get(hk(b)).push(b); }
  const sim = (a, b) => { const x = new Set(tokenize(a.raw)), y = new Set(tokenize(b.raw)); let n = 0; for (const t of x) if (y.has(t)) n++; return n / (x.size + y.size - n || 1); };
  const alone = new Map(); for (const h of left) alone.set(hk(h), (alone.get(hk(h)) || 0) + 1);
  for (const h of left) {
    const list = byHeading.get(hk(h)) || [];
    let at = 0;
    if (h.kind === 'changed' && list.length === 1 && alone.get(hk(h)) === 1) at = 0; // one removed and one added block under a heading are the same block, edited past recognition
    else if (h.kind === 'changed') { const best = list.map((b) => sim(b, h)); at = best.length && Math.max(...best) >= SIMILAR ? best.indexOf(Math.max(...best)) : -1; }
    const b = at >= 0 ? list.splice(at, 1)[0] : undefined;
    if (b) { bl.delete(b); pairs.push({ base: b, head: h }); } else pairs.push({ base: null, head: h });
  }
  for (const b of baseItems) if (bl.has(b)) pairs.push({ base: b, head: null });
  return pairs;
}

const UNIT = String.raw`days?|hours?|minutes?|mins?|seconds?|secs?|ms|weeks?|months?|years?|percent|[KMGT]i?B|bytes?|times|%`;
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

const SIZE = { byte: 1, kb: 1024, kib: 1024, mb: 1024 ** 2, mib: 1024 ** 2, gb: 1024 ** 3, gib: 1024 ** 3 };
// Other forms of a size: the byte count, `a * 1024 * 1024` products as code writes them, and KiB/MiB/GiB text. A bare number counts only when it is a whole multiple of 1024 (30 and 5000 are not sizes).
function sizeVariants(value) {
  // thousands separators (1,048,576 / 1_048_576 / thin or narrow space) only as 3-digit groups, so "1,5" is not 15; it stays unparsed
  const m = /^(\d+(?:\.\d+)?)\s*(bytes?|[KMG]i?B)?$/i.exec(String(value).trim().replace(/\s*\([^)]*\)$/, '').replace(/^\d{1,3}(?:[,_  ]\d{3})+(?=\D|$)/, (g) => g.replace(/\D/g, ''))); // a quoted "1048576 (1MiB)" is one value
  if (!m) return [];
  const bytes = +m[1] * (m[2] ? SIZE[m[2].toLowerCase().replace(/s$/, '')] : 1);
  if (!Number.isSafeInteger(bytes) || bytes === 0 || (!m[2] && (bytes < 1024 || bytes % 1024))) return [];
  const out = [String(bytes)];
  for (let j = 1, u = 1024; j <= 3 && bytes % u === 0; j++, u *= 1024) {
    const k = bytes / u;
    if (k === 1 && j === 1) continue;
    const parts = [...(k === 1 ? [] : [k]), ...Array(j).fill(1024)];
    out.push(parts.join(' * '), parts.join('*'));
  }
  for (const [n, u] of [['KiB', 1024], ['KB', 1024], ['MiB', 1024 ** 2], ['MB', 1024 ** 2], ['GiB', 1024 ** 3], ['GB', 1024 ** 3]]) if (bytes % u === 0 && bytes / u < 1024) out.push(`${bytes / u} ${n}`);
  return [...new Set(out)];
}

const isTestPath = (p) => !/\.(md|mdx|markdown|rst|adoc)$/i.test(p) && (/(^|\/)([^/]*[._-])?(tests?|spec|__tests__)\//i.test(p) || /[._-](tests?|spec)(\.[^/]*)?$/i.test(p) || /(^|\/)(test_[^/]*|tests?\.[^/]*)$/i.test(p) || /[a-z0-9](Tests?|Spec)\.[^/]*$/.test(p)); // a test DIRECTORY (Foo.Tests/, Tests/), a basename SUFFIX (a.test.ts, a_spec.rb, foo-test.go) or the test_ prefix; a leading word is not (src/test-map.js, spec-loader.js), nor is a bare spec.js; words are case-insensitive;the PascalCase suffix (AppTests.swift, FooSpec.scala) is case-sensitive so latest.ts is not a test; docs are never tests (SPEC.md)
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
// Entries whose path holds a control character (newline, CR...) are dropped and counted in skipped.n.
function lsTree(cwd, rev, skipped = { n: 0 }) {
  const out = [];
  for (const r of git(cwd, ['ls-tree', '-r', '-z', '-l', rev], { encoding: 'utf8' }).split('\0')) {
    const m = /^(\d{6}) (\w+) ([0-9a-f]+) +(\d+|-)\t([\s\S]*)$/.exec(r);
    if (!m || m[2] !== 'blob' || m[1] === '120000') continue;
    if (DENY.test(m[5])) { (skipped.denied = skipped.denied || []).push(m[5]); continue; } // secret-like: no doc, code or test text from it reaches the model
    if (CONTROL.test(m[5])) skipped.n++; else out.push({ path: m[5], sha: m[3], size: +m[4] });
  }
  return out;
}
// git cat-file --batch for blob shas or `rev:path` specs; null where missing.
function catBatch(cwd, specs) {
  const out = [];
  for (let s = 0; s < specs.length; s += 300) {
    const part = specs.slice(s, s + 300).map((x) => (CONTROL.test(x) ? '0'.repeat(40) : x)); // a newline would desync the batch protocol; this object is missing
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
const gitGrep = (cwd, args, timeout) => {
  try { return git(cwd, args, { encoding: 'utf8', timeout }); } catch (e) { if (e.status === 1) return ''; throw e; }
};

function parseReqPaths(s) {
  const inc = [], exc = [];
  for (const l of String(s || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean)) (l.startsWith('!') ? exc : inc).push(l.replace(/^!/, ''));
  return { inc, exc };
}
// test_paths: same list syntax as requirements_paths. An entry without a glob character is a file or a folder (everything under it). Returns null when nothing is configured.
function testScope(spec) {
  const { inc, exc } = parseReqPaths(spec);
  const hit = (list, f) => list.some((g) => matchGlob(f, g) || (!/[*?[]/.test(g) && matchGlob(f, g.replace(/\/*$/, '/'))));
  return inc.length ? (f) => hit(inc, f) && !hit(exc, f) : exc.length ? (f) => isTestPath(f) && !hit(exc, f) : null; // exclusions only: the default discovery minus them
}
// Tracked doc paths that PR or issue text names: path-like tokens ending in a doc extension (also inside markdown links and blob URLs), resolved by
// exact path or, for a slash-free token, a unique basename. Not a README, changelog or pip requirements.txt: a mention of those is not a spec.
const DOC_MENTION = /[\w@+.\/-]*[\w@+-]\.(?:md|mdx|rst|adoc|txt)(?![\w-])/gi, NAME_SKIP = /(^|\/)(readme[^/]*|(requirements|constraints)[^/]*\.txt)$/i;
function namedDocs(texts, paths) {
  const known = new Set(paths), byBase = new Map(), out = new Set();
  for (const p of paths) if (docLike(p)) { const b = path.basename(p).toLowerCase(); byBase.set(b, byBase.has(b) ? null : p); }
  for (const text of texts) {
    const t = String(text).replace(/https?:\/\/\S+/g, (u) => ` ${(/\/blob\/[^/\s]+\/([^\s)#?]+)/.exec(u) || [])[1] || ''} `);
    for (const [m] of t.matchAll(DOC_MENTION)) {
      const tok = m.replace(/^\.?\/+/, '');
      const hit = known.has(tok) ? tok : tok.includes('/') ? null : byBase.get(tok.toLowerCase());
      if (hit && docLike(hit) && !NAME_SKIP.test(hit) && !SKIP_NAME.test(hit) && !NON_SPEC_DIR.test(hit)) out.add(hit);
    }
  }
  return out;
}
const prTexts = (st) => ((st && st.documents) || []).filter((x) => x && !x.untrusted && typeof x.text === 'string').map((x) => x.text); // the PR body and linked issues, never history
// The spec folder a branch is named after: 'feat/003-photo-albums' -> specs/003-photo-albums/, .kiro/specs/<name>/, openspec/changes/<name>/.
// The last path segment of the branch equals the folder name, or both are equal once a leading number is dropped ('photo-albums' <-> '003-photo-albums').
// A leading zero is fine here: this is a folder name, not an issue number. ponytail: exact names only, no fuzzy match.
const SPEC_FOLDER = /(?:^|\/)(?:specs|openspec\/changes)\/([^/]+)\//i, GENERIC_BRANCH = /^(?:main|master|develop|dev|trunk|staging|release|hotfix)$/i;
function branchDocs(branch, paths) {
  const name = String(branch || '').split('/').pop().toLowerCase();
  if (name.length < 3 || GENERIC_BRANCH.test(name)) return [];
  const bare = (x) => x.replace(/^\d+-/, '');
  return paths.filter((p) => { const m = SPEC_FOLDER.exec(p), f = m && m[1].toLowerCase(); return f && docLike(p) && !NAME_SKIP.test(p) && !SKIP_NAME.test(p) && (f === name || (bare(f) === bare(name) && bare(name).includes('-'))); });
}
const namedSet = ({ cwd, base, head, texts, ruled, excluded, branch }) => {
  if (!texts.length && !branch) return new Set();
  try {
    const paths = new Set(lsTree(cwd, head).map((e) => e.path));
    if (base) try { for (const e of lsTree(cwd, base)) paths.add(e.path); } catch { /* no base tree: head paths only */ }
    return new Set([...namedDocs(texts, [...paths]), ...branchDocs(branch, [...paths])].filter((p) => !ruled(p) && !excluded(p)));
  } catch { return new Set(); }
};
const kb = (n) => (n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`);
// Why a parsed doc with at least one item was not admitted (the isSpecDoc rules, in order).
function rejectReason(items, file, size) {
  const n = items.length;
  if (!isRequirementDoc(items) && !(n === 1 && SPEC_DIR.test(file))) return `only ${n} normative item`;
  const caps = items.some((i) => /\b(MUST|SHALL|REQUIRED)\b/.test(i.raw));
  return `density 1 per ${kb(Math.round(size / n))} below 1 per ${caps ? '7 KB' : '300 B'}`;
}
const rank = (p) =>{ const i = HINTS.findIndex((h) => h.test(p)); return i < 0 ? 99 : i; };
const byRank = (a, b) => rank(a.path) - rank(b.path) || (a.path < b.path ? -1 : 1);

// Which tracked files are requirement docs at `head` (content-based; globs only rank, includes/excludes adjust).
// scope (optional predicate on a path): files outside it do not exist for discovery, so a monorepo package is scanned without the caps counting the rest.
function discover({ cwd, base, head, reqPaths, ignoreExtra = '', texts = [], branch = '', scope = null }) {
  const { inc, exc } = parseReqPaths(reqPaths), limitations = [];
  const extra = String(ignoreExtra).split(/\r?\n/).filter(Boolean);
  const skipped = { n: 0, denied: [] }, entries = lsTree(cwd, head, skipped).filter((e) => !scope || scope(e.path));
  if (skipped.n) limitations.push(`${skipped.n} tracked path(s) containing a control character were ignored.`);
  const ruled = (p) => RULE_GLOBS.concat(extra).some((g) => matchGlob(p, g));
  const excluded = (p) => exc.some((g) => matchGlob(p, g)), named = namedSet({ cwd, base, head, texts, ruled, excluded, branch });
  const forced = (p) => inc.some((g) => matchGlob(p, g)) || named.has(p); // a doc the PR or a linked issue names is admitted like a requirements_paths entry
  for (const e of entries) if (UNREADABLE.test(e.path) && UNREADABLE_NAME.test(path.basename(e.path)) && !excluded(e.path)) limitations.push(`requirement-like file not readable: ${e.path}`);
  const denied = skipped.denied.filter((p) => !CONTROL.test(p) && (forced(p) || (specLike(p) && !SKIP_NAME.test(p) && !ruled(p)))); // secret-like docs, named so the summary can say they were not read
  const sample = (p) => FIXTURE_PATH.test(p) && !forced(p);
  let cands = entries.filter((e) => e.size <= MAX_FILE && !excluded(e.path) && !UNREADABLE.test(e.path) && !sample(e.path)
    &&((specLike(e.path) && !SKIP_NAME.test(e.path) && !ruled(e.path)) || forced(e.path))).sort(byRank);
  // Documents over MAX_FILE are not indexed. Those that read like a spec (RFC 2119 capitals) are listed so the skip is visible,
  // and run() still parses one when the PR changes it.
  const bigAll = entries.filter((e) => e.size > MAX_FILE && !excluded(e.path) && !UNREADABLE.test(e.path) && !sample(e.path)
    && ((specLike(e.path) && !SKIP_NAME.test(e.path) && !ruled(e.path)) || forced(e.path))).slice(0, 60);
  const bigBufs = catBatch(cwd, bigAll.map((e) => (e.size <= MAX_BIG ? e.sha : '0'.repeat(40))));
  const must = bigAll.map((e, k) => (bigBufs[k] ? (bigBufs[k].toString('utf8').match(/\b(MUST|SHALL)\b/g) || []).length : 0));
  const oversize = bigAll.filter((e, k) => base === head || forced(e.path) || UNREADABLE_NAME.test(path.basename(e.path)) || must[k] >= 5); // a scan (base = head) has no diff to pick the changed ones: every oversize candidate is listed, none is dropped silently
  const rejected = oversize.map((e) => ({ path: e.path, n: must[bigAll.indexOf(e)], reason: `over size cap (${kb(e.size)} > ${kb(MAX_FILE)})` })); // run() drops those it parses because the PR changes them
  if (cands.length > MAX_CANDIDATES) { limitations.push(`${cands.length - MAX_CANDIDATES} candidate documents skipped by the ${MAX_CANDIDATES}-file limit.`); cands = cands.slice(0, MAX_CANDIDATES); }
  let budget = MAX_DOC_BYTES, over = false;
  const docs = new Map(), bufs = catBatch(cwd, cands.map((c) => c.sha));
  cands.forEach((c, k) => {
    const buf = bufs[k];
    if (!buf || buf.includes(0)) return;
    if ((budget -= buf.length) < 0) { over = true; return; }
    const text = lf(buf.toString('utf8')), items = parseItems(c.path, text);
    if (isSpecDoc(items, c.path, text.length) || forced(c.path)) docs.set(c.path, { path: c.path, text, items, forced: forced(c.path) });
    else if (items.length) rejected.push({ path: c.path, n: items.length, reason: rejectReason(items, c.path, text.length) });
  });
  if (over) limitations.push(`Document parsing stopped at the ${MAX_DOC_BYTES >> 20} MB byte budget; later candidate documents were skipped.`);
  let list = [...docs.values()].sort(byRank);
  if (list.length > MAX_DOCS) { limitations.push(`${list.length - MAX_DOCS} requirement documents skipped by the ${MAX_DOCS}-file limit.`); list = list.slice(0, MAX_DOCS); }
  return { entries, docs: new Map(list.map((d) => [d.path, d])), limitations, ruled, forced, excluded, oversize, rejected, denied };
}

// `node trace.js classify <paths>`: the subset of (changed) paths that are requirement docs at head, or at base when deleted.
function classify({ cwd = '.', base, head, paths, reqPaths = '', ignoreExtra = '', ctx = '' }) {
  const { inc, exc } = parseReqPaths(reqPaths), extra = String(ignoreExtra).split(/\r?\n/).filter(Boolean);
  const ruled = (p) => RULE_GLOBS.concat(extra).some((g) => matchGlob(p, g)), excluded = (p) => exc.some((g) => matchGlob(p, g));
  let st = null;
  try { st = JSON.parse(fs.readFileSync(path.join(ctx, 'requirements-status.json'), 'utf8')); } catch { /* collect.sh classifies before the requirements step (nothing named yet) and again after it */ }
  const named = namedSet({ cwd, base, head, texts: prTexts(st), ruled, excluded, branch: st && st.branch });
  const eligible = (p) => !excluded(p) && (inc.some((g) => matchGlob(p, g)) || named.has(p) || (specLike(p) && !SKIP_NAME.test(p) && !ruled(p)));
  const todo = paths.filter((p) => !CONTROL.test(p) && !DENY.test(p) && eligible(p));
  const read = (rev) => catBatch(cwd, todo.map((p) => `${rev}:${p}`));
  const heads = todo.length ? read(head) : [], bases = todo.length && base ? read(base) : [];
  const ok = new Set(todo.filter((p, k) => {
    const buf = heads[k] || bases[k];
    if (!buf || buf.includes(0) || buf.length > MAX_BIG) return false;
    return inc.some((g) => matchGlob(p, g)) || named.has(p) || isSpecDoc(parseItems(p, buf.toString('utf8')), p, buf.length);
  }));
  return paths.filter((p) => ok.has(p));
}

// ---- the full run -------------------------------------------------------------------------------------------
const hitsLine = (item, map) => { for (let l = item.line; l <= item.end; l++) if (map.has(l)) return true; return (item.ctxAt || []).some(([a, z]) => { for (let l = a; l <= z; l++) if (map.has(l)) return true; return false; }); }; // an inherited Background line counts as the scenario's own
const withCtx = (i) => (i.ctx ? `${i.ctx}\n${i.raw}` : i.raw); // the scenario as the model must read it: inherited Background first
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
        if (!(hitsLine(head, m.changed.RIGHT) || hitsLine(base, m.changed.LEFT)) || norm(withCtx(head)) === norm(withCtx(base))) continue;
        out.push({ path: p, heading: head.heading, ref: head.ref, line: head.line, quote: head.text, ...(head.ctx ? { context: head.ctx } : {}), previous: base.text, ...(base.ctx && base.ctx !== head.ctx ? { previous_context: base.ctx } : {}), change: 'modified', deltas: valueDeltas(body(withCtx(base)), body(withCtx(head))) });
      } else if (head) {
        if (!hitsLine(head, m.changed.RIGHT)) continue;
        out.push({ path: p, heading: head.heading, ref: head.ref, line: head.line, quote: head.text, ...(head.ctx ? { context: head.ctx } : {}), change: 'added', deltas: valueDeltas('', body(withCtx(head))) });
      } else if (hitsLine(base, m.changed.LEFT)) {
        out.push({ path: p, heading: base.heading, ref: base.ref, line: base.line, quote: base.text, previous: base.text, change: 'removed', deltas: valueDeltas(body(withCtx(base)), ''), removedRaw: withCtx(base) });
      }
    }
  }
  return out.map((o) => ({ ...o, deltas: { removed: o.deltas.removed.slice(0, MAX_DELTAS), added: o.deltas.added.slice(0, MAX_DELTAS) } })); // a huge rewrite must not fan out into hundreds of repo searches
}

// Ranks requirement items for every code hunk: the best SURE candidates always stay, later ones must reach FLOOR of the hunk best score;
// at most MAX_HUNKS hunks (best scores first) are kept. info.dropped counts the hunks left out.
function codeToRequirement(hunks, items, info = {}, { per: perHunk = PER_HUNK, total = 15, min = 0, stop = null } = {}) {
  const index = buildIndex(items.map((i) => tokenize(`${i.path} ${i.heading} ${i.ref} ${i.text}`)));
  const per = hunks.map((h) => {
    const s = index.search(tokenize([h.context, h.identifiers.join(' '), h.literals.added.join(' '), h.literals.removed.join(' '), h.path].join(' ')).filter((w) => !stop || (w.length > 1 && !stop.has(w))));
    const top = [...s.keys()].filter((k) => s[k] > min).sort((a, b) => s[b] - s[a]).slice(0, perHunk);
    return top.filter((k, r) => r < SURE || s[k] >= FLOOR * s[top[0]]).map((k) => ({ path: items[k].path, ref: items[k].ref, line: items[k].line, score: round(s[k]), kind: items[k].kind === 'block' ? 'block' : undefined, k }));
  });
  const keep = new Set();
  for (const e of per.flat().sort((a, b) => b.score - a.score)) if (keep.size < total || keep.has(e.k)) keep.add(e.k);
  let out = hunks.map((h, i) => ({ path: h.path, line: h.line, end: h.end, context: h.context,
    candidates: per[i].filter((e) => keep.has(e.k)).map(({ k, ...e }) => e) })).filter((h) => h.candidates.length);
  info.dropped = Math.max(0, out.length - MAX_HUNKS);
  if (info.dropped) { const top = new Set([...out].sort((a, b) => b.candidates[0].score - a.candidates[0].score).slice(0, MAX_HUNKS)); out = out.filter((h) => top.has(h)); }
  return out;
}

const numeric = (v) => /^\d+(?:[.,]\d+)*(?:\s*\S+)?$/.test(v) ? v.replace(/^(\d+(?:[.,]\d+)*).*$/, '$1') : null;

// Removed or weakened test assertions (leads.js assertionDelta: the one heuristic) as queries: the literals and subject identifiers of the removed line.
// A line without a literal makes no query: identifiers alone would point at unrelated code. ponytail: same-file single-line assertions as in leads.js; at most MAX_TEST_Q queries.
// LIT_SHARE: a literal held by over 1% of the code windows or requirement items (3 at least) is no anchor (200, 'GET'). ponytail: trace.js had no document-frequency cutoff to reuse; this is share-of-corpus, tune with eval/trace-recall noise cases.
const LIT_SHARE = 0.01, MAX_TEST_Q = 5, TEST_NOTE = 'from a removed or weakened test assertion', ASSERT_WORD = new Set('assert strict equal deep ok not to be eq throw match true false expect should is await'.split(' '));
function weakenedQueries(patch) {
  const seen = new Set(), out = [];
  for (const a of require('./leads.js').assertionDelta(patch, isTestPath)) { // lazy: leads.js requires this module
    if (seen.has(a.old) || out.length >= MAX_TEST_Q) continue;
    seen.add(a.old);
    const lits = [...new Set([...a.old.matchAll(/(?<![\w$.])\d+(?:\.\d+)?(?![\w$])|"([^"\n]*)"|'([^'\n]*)'/g)].map((m) => m[1] ?? m[2] ?? m[0]).filter((x) => x.length >= 2))].slice(0, 5);
    if (!lits.length) continue;
    const ids = [...new Set(tokenize(a.old.replace(/"[^"\n]*"|'[^'\n]*'|`[^`\n]*`/g, ' ').replace(/\d+(?:\.\d+)?/g, ' ')).filter((w) => w.length > 1 && !ASSERT_WORD.has(w)))];
    out.push({ file: a.file, line: a.line, ids, lits: [...new Set(lits.flatMap((v) => [numeric(v) ?? v, ...sizeVariants(v)]))] });
  }
  return out;
}

// info.cut is set when the time budget stopped a search early.
function requirementToCode({ cwd, head, entries, skip, crits, dl, info = {}, stop = null, cover = false, maxLitShare = 1 }) {
  const eligible = entries.filter((e) => e.size <= MAX_FILE && !skip(e.path));
  const lits = [...new Set(crits.flatMap((c) => c.lits))].slice(0, MAX_LITS);
  const litRe = lits.map((l) => new RegExp(`(?<![\\w])${esc(l)}(?![\\w])`));
  const queries = crits.map((c) => tokenize(`${c.heading || ''} ${c.quote} ${c.previous || ''}`).filter((w) => !stop || (w.length > 1 && !stop.has(w))));
  const meta = [], litHits = new Map();
  function* windows() {
    for (let s = 0; s < eligible.length; s += 300) {
      if (dl.over()) { info.cut = true; return; }
      const part = eligible.slice(s, s + 300), bufs = catBatch(cwd, part.map((e) => e.sha));
      for (let f = 0; f < part.length; f++) {
        if (dl.over()) { info.cut = true; return; }
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
  if (maxLitShare < 1) { // a literal in more than this share of the windows (200, "GET", true) is no anchor: it is dropped from every hit
    const n = new Map(); for (const hs of litHits.values()) for (const x of hs) n.set(x, (n.get(x) || 0) + 1);
    for (const [x, c] of n) if (c > Math.max(3, maxLitShare * meta.length)) { (info.common ||= new Set()).add(lits[x]); for (const hs of litHits.values()) hs.delete(x); }
  }
  const shaOf = new Map(entries.map((e) => [e.path, e.sha]));
  const rows = crits.map((c, qi) => {
    const s = index.search(queries[qi]);
    const mine = c.lits.map((l) => lits.indexOf(l));
    for (const [i, hs] of litHits) if (mine.some((x) => hs.has(x))) s[i] += 2;
    const order = [...s.keys()].filter((i) => s[i] > 0).sort((a, b) => s[b] - s[a]);
    const terms = [...new Set(queries[qi])], weigh = (ts) => ts.reduce((a, t) => a + index.idf(t), 0), known = cover ? weigh(terms.filter((t) => index.df(t) > 0)) : 0;
    const nlits = (i) => { const lh = litHits.get(i); return lh ? mine.filter((x) => x >= 0 && lh.has(x)).length : 0; };
    const ranked = cover ? [...order.filter((i) => nlits(i) >= 2), ...order.filter((i) => nlits(i) < 2)] : order; // cover: windows holding >= 2 distinct literals of the criterion come before the score order (many windows share the row's words)
    const pick = (isTest, n) => {
      const out = [];
      for (const i of ranked) {
        const [p, a, z] = meta[i];
        if (isTestPath(p) !== isTest || out.some((o) => o.path === p && Math.abs(o.line - a) < WIN)) continue;
        const hits = [...new Set(queries[qi])].filter((t) => index.has(t, i)).sort((x, y) => index.idf(y) - index.idf(x)).slice(0, 5);
        const nl = nlits(i); // distinct literals of this criterion in the window
        out.push({ path: p, line: a, end: z, score: round(s[i]), hits, ...(cover && nl && { lits: nl }), ...(cover && { cover: known ? round(weigh(terms.filter((t) => index.has(t, i))) / known) : 0 }) }); // cover: the share of the query's weight (idf of the terms the corpus knows) that this window holds
        if (out.length === n) break;
      }
      return out;
    };
    return { criterion: c.id, code: pick(false, 8), tests: pick(true, 5) };
  });
  if (!dl.over()) {
    const extra = transitiveTests({ cwd, entries, rows, shaOf, total: eligible.length, dl, info });
    rows.forEach((r, k) => { for (const t of extra[k]) { const dup = r.tests.find((x) => x.path === t.path); if (dup) dup.via = t.via; else r.tests.push(t); } });
  } else info.cut = true;
  if (info.cut && !meta.length) return []; // the budget ran out before any code was read: no rows rather than empty ones
  return rows.map((r) => ({ criterion: r.criterion, code: r.code, tests: r.tests.slice(0, 8) }));
}

// File and test-file hits per identifier, in one pass over the tracked blobs (batched cat-file, one process per 300 files; many
// `git grep` patterns over a big tree cost seconds each). Binary files and files over MAX_BIG are skipped.
function grepIdentifiers(cwd, ids, entries, dl, info) {
  const stats = new Map(ids.map((id) => [id, { files: new Set(), tests: new Map() }]));
  const files = entries.filter((e) => e.size <= MAX_BIG);
  for (let s = 0; s < files.length && stats.size; s += 300) {
    if (dl.over()) { info.cut = true; break; }
    const part = files.slice(s, s + 300), bufs = catBatch(cwd, part.map((e) => e.sha));
    part.forEach((e, k) => {
      if (!bufs[k] || bufs[k].includes(0)) return;
      const test = isTestPath(e.path);
      bufs[k].toString('utf8').split('\n').forEach((line, i) => {
        for (const t of new Set(line.length > 2000 ? [] : line.match(/[A-Za-z_$][\w$]*/g))) {
          const st = stats.get(t);
          if (!st) continue;
          st.files.add(e.path);
          if (test && !st.tests.has(e.path)) st.tests.set(e.path, i + 1);
        }
      });
    });
  }
  return stats;
}

// Test-transitive step: the rarest identifiers of each top production window, grepped in test paths. Returns one test list per row.
function transitiveTests({ cwd, entries, rows, shaOf, total, dl, info }) {
  const paths = [...new Set(rows.flatMap((r) => r.code.map((w) => w.path)))];
  const got = paths.length ? catBatch(cwd, paths.map((p) => shaOf.get(p))) : [];
  const text = new Map(paths.map((p, k) => [p, got[k] ? got[k].toString('utf8').split(/\r?\n/) : null]));
  const idsOf = new Map(), all = new Set();
  for (const r of rows) for (const w of r.code) {
    const key = `${w.path}:${w.line}`;
    if (idsOf.has(key) || !text.get(w.path)) continue;
    const cands = [...new Set(text.get(w.path).slice(w.line - 1, w.end).join('\n').match(/[A-Za-z_$][\w$]{3,}/g) || [])]
      .map((id) => [id, (/[a-z][A-Z]|_|^[A-Z0-9_]+$/.test(id) ? 10 : 0) + Math.min(id.length, 12)]).sort((a, b) => b[1] - a[1]).slice(0, 12).map((x) => x[0]);
    idsOf.set(key, cands); cands.forEach((c) => all.add(c));
  }
  const stats = grepIdentifiers(cwd, [...all], entries, dl, info);
  return rows.map((r) => {
    const out = [];
    for (const w of r.code) {
      const cands = idsOf.get(`${w.path}:${w.line}`) || [];
      cands.map((id) => [id, stats.get(id)]).filter(([, e]) => e.tests.size).sort((a, b) => a[1].files.size - b[1].files.size).slice(0, 3).forEach(([id, e]) => {
        for (const [p, l] of [...e.tests].slice(0, 3)) out.push({ path: p, line: Math.max(1, l - 10), end: Math.max(1, l - 10) + 39, score: round(Math.log(total / e.files.size)), via: id });
      });
    }
    const seen = new Set();
    return out.filter((t) => !seen.has(t.path) && seen.add(t.path));
  });
}

function occurrences({ cwd, head, crits, maps, dl, info = {} }) {
  const out = [], cache = new Map();
  const pathspec = ['.', ...LOCK_EXCLUDES.map((g) => `:(exclude,glob)${g}`)];
  let n = 0;
  for (const c of crits) for (const value of c.deltas.removed) {
    if (dl.over()) { info.cut = true; return out; }
    if (++n > MAX_VALUES) { info.valuesCapped = true; return out; }
    const variants = [...new Set([...durationVariants(value), ...sizeVariants(value)])], pats = [...new Set([...variants, value])].filter((v) => v.length > 1 || /\d/.test(v));
    const key = pats.join('\0');
    let res = cache.get(key); // the same value in two criteria is searched once
    if (res === undefined) {
      try { res = gitGrep(cwd, ['grep', '-n', '-I', '-w', '-F', ...pats.flatMap((p) => ['-e', p]), head, '--', ...pathspec], Math.max(dl.left(), 1000)); } catch { info.cut = true; return out; }
      cache.set(key, res);
    }
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

// Keeps trace-candidates.json within CAND_CAP: fewer occurrence hits, fewer code/test windows, then the weakest hunks. Returns a note or ''.
function fitCandidates(cand) {
  const size = () => Buffer.byteLength(JSON.stringify(cand, null, 2));
  // ponytail: each step re-serialises; fine for a few hundred KB, switch to estimated sizes if candidates ever reach MBs
  const before = size();
  if (before <= CAND_CAP) return '';
  for (const o of cand.occurrences) o.hits = o.hits.slice(0, 10);
  if (size() > CAND_CAP) for (const r of cand.requirement_to_code) { r.code = r.code.slice(0, 5); r.tests = r.tests.slice(0, 4); }
  if (size() > CAND_CAP) cand.occurrences = cand.occurrences.slice(0, 15);
  const top = (h) => h.candidates[0]?.score || 0;
  while (size() > CAND_CAP && cand.code_to_requirement.length > 1) {
    const keep = new Set([...cand.code_to_requirement].sort((a, b) => top(b) - top(a)).slice(0, Math.floor(cand.code_to_requirement.length * 0.8)));
    cand.code_to_requirement = cand.code_to_requirement.filter((h) => keep.has(h));
  }
  for (const o of cand.occurrences) if (size() > CAND_CAP - 512) o.hits = o.hits.slice(0, 3);
  while (size() > CAND_CAP - 512 && cand.occurrences.length) cand.occurrences.pop();
  while (size() > CAND_CAP - 512 && cand.requirement_to_code.length) cand.requirement_to_code.pop();
  return `trace-candidates.json was ${Math.round(before / 1024)} KB; it was trimmed to ${CAND_CAP / 1024} KB (weakest hunks and extra occurrence hits dropped).`;
}

// `base` is the diff base (the PR's merge-base; the CLI passes DIFF_BASE_SHA): the range is three-dot and spec items are paired against it.
// Writes spec-files.txt, requirements-index.md, trace-candidates.json and extends requirements-status.json.
// Returns the number of changed normative items. budgetMs bounds the expensive searches: they stop early and say so in limitations.
function run({ cwd = '.', base, head, ctx, reqPaths = '', trace = '', ignoreExtra = '', maxCriteria = MAX_CRITERIA, maxPatch = MAX_PATCH, budgetMs = BUDGET_MS, scope = null }) {
  const dl = makeClock(budgetMs);
  const cand = { requirement_to_code: [], code_to_requirement: [], occurrences: [], limitations: [] };
  const write = (name, s) => fs.writeFileSync(path.join(ctx, name), s);
  const statusFile = path.join(ctx, 'requirements-status.json');
  let status = {};
  try { status = JSON.parse(fs.readFileSync(statusFile, 'utf8')); } catch { /* requirements.js did not run */ }
  const spec = { files: 0, items: 0, added: [], limitations: cand.limitations };
  let rejected = []; // candidate docs that were not admitted, with the reason (spec-rejected.txt)
  const finish = (n, specFiles = [], index = '') => {
    write('spec-files.txt', specFiles.filter((f) => !CONTROL.test(f)).map((f) => f + '\n').join(''));
    write('requirements-index.md', index);
    write('spec-rejected.txt', rejected.slice().sort((a, b) => b.n - a.n || (a.path < b.path ? -1 : 1)).slice(0, MAX_REJECTED).map((r) => `${r.path}\t${r.reason}\n`).join(''));
    write('trace-candidates.json', JSON.stringify(cand, null, 2) + '\n');
    write('requirements-status.json', JSON.stringify({ ...status, spec }, null, 2) + '\n');
    return n;
  };
  if (String(trace).toLowerCase() === 'off') return finish(0);
  const lim = (what, e) => cand.limitations.push(`${what} failed (${String(e && e.message || e).split('\n')[0].slice(0, 120)}); continuing without it.`);
  const d = discover({ cwd, base, head, reqPaths, ignoreExtra, texts: prTexts(status), branch: status.branch, scope });
  rejected = d.rejected;
  cand.limitations.push(...d.limitations);
  if (d.denied.length) { // secret-like requirement docs: not read, listed with collect.sh's denied paths (post.js: "Not reviewed: secret-like") and in the limitations
    cand.limitations.push(`${d.denied.length} secret-like requirement document(s) were not read: ${d.denied.slice(0, 5).join(', ')}`);
    const f = path.join(ctx, 'denied.txt'), have = (() => { try { return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean); } catch { return []; } })();
    fs.writeFileSync(f, [...new Set([...have, ...d.denied])].map((x) => x + '\n').join(''));
  }
  const docs = [...d.docs.values()], allItems = docs.flatMap((x) => x.items);
  spec.files = docs.length; spec.items = allItems.length;

  // -M: a pure move is not a change, a move plus an edit is only the edit (items pair against the old path).
  const range = `${base}...${head}`, renames = new Map();
  let patch;
  try { patch = git(cwd, ['diff', '--no-color', '--no-ext-diff', '-M', range], { encoding: 'utf8', maxBuffer: maxPatch }); }
  catch (e) { // an oversized diff: requirement tracing is skipped for this PR
    if (e.code !== 'ENOBUFS') throw e;
    cand.limitations.push(`The diff exceeded ${maxPatch >> 10} KB; requirement tracing was skipped for this PR.`);
    return finish(0, docs.map((x) => x.path));
  }
  try {
    const t = git(cwd, ['diff', '--name-status', '-z', '-M', '--no-color', '--no-ext-diff', range], { encoding: 'utf8', maxBuffer: maxPatch }).split('\0');
    for (let k = 0; k < t.length && t[k];) { const st = t[k++]; if (st[0] === 'R') { const from = t[k++]; renames.set(t[k++], from); } else k++; }
  } catch { /* no rename map: every move reads as remove + add, as before */ }
  patch = patch.split(/^(?=diff --git )/m).filter((c) => { const m = /^diff --git a\/(.*?) b\/(.*)$/m.exec(c); return !(m && (DENY.test(m[1]) || DENY.test(m[2]))); }).join(''); // a secret-like file's hunks are not trace input either
  const maps = parseDiff(patch);
  // changed requirement items (head docs, plus docs that were requirement docs at base: deleted or emptied)
  let specCand = [...maps.keys()].filter((p) => !CONTROL.test(p) && !d.excluded(p) && (d.docs.has(p) || (!d.ruled(p) && specLike(p) && !SKIP_NAME.test(p)) || d.forced(p)));
  if (specCand.length > MAX_CHANGED_DOCS) { cand.limitations.push(`${specCand.length - MAX_CHANGED_DOCS} changed requirement document(s) skipped by the ${MAX_CHANGED_DOCS}-document limit.`); specCand = specCand.slice(0, MAX_CHANGED_DOCS); }
  const baseBufs = specCand.length ? catBatch(cwd, specCand.map((p) => `${base}:${renames.get(p) || p}`)) : [];
  // A changed spec over 256 KB is parsed whole (cheap); only items around its changed lines can become criteria.
  const bigs = new Map(d.oversize.filter((e) => e.size <= MAX_BIG).map((e) => [e.path, e]));
  const bigPaths = specCand.filter((p) => !d.docs.has(p) && bigs.has(p));
  const bigBufs = bigPaths.length ? catBatch(cwd, bigPaths.map((p) => bigs.get(p).sha)) : [];
  const big = new Map();
  bigPaths.forEach((p, k) => {
    if (!bigBufs[k] || bigBufs[k].includes(0)) return;
    const text = lf(bigBufs[k].toString('utf8')), items = parseItems(p, text);
    if (isSpecDoc(items, p, text.length) || d.forced(p)) big.set(p, { text, items });
  });
  const oversize = d.oversize.filter((e) => !big.has(e.path));
  rejected = d.rejected.filter((r) => !big.has(r.path));
  oversize.slice(0, 10).forEach((e) => cand.limitations.push(`oversize doc skipped: ${e.path} (${Math.round(e.size / 1024)} KB)`));
  if (oversize.length > 10) cand.limitations.push(`${oversize.length - 10} more oversize document(s) skipped.`);
  const files = [];
  specCand.forEach((p, k) => {
    const hd = d.docs.get(p) || big.get(p), b = baseBufs[k], m = maps.get(p);
    const baseText = b && !b.includes(0) && b.length <= MAX_BIG ? b.toString('utf8') : null;
    if (!hd && !d.forced(p) && !isSpecDoc(baseText === null ? [] : parseItems(p, baseText), p, b ? b.length : 0)) return; // admission reads the plain items
    if (hd && !b) spec.added.push(p); // authored in this PR: no BASE version to compare with
    // an admitted doc: every changed block, not only the normative sentences, is an item to pair and trace
    files.push({ path: p, headItems: hd ? parseItems(p, hd.text, m.changed.RIGHT) : [], baseItems: baseText === null ? [] : parseItems(p, baseText, m.changed.LEFT), text: hd ? hd.text : null });
  });
  let changed = changedItems(files, maps);
  if (changed.length > maxCriteria) { cand.limitations.push(`${changed.length - maxCriteria} changed requirement item(s) beyond the ${maxCriteria}-criteria limit were not traced; the criteria shown are only the first ${maxCriteria}.`); changed = changed.slice(0, maxCriteria); }
  const documents = [], criteria = [];
  changed.forEach((c, i) => {
    const { path: p, removedRaw, ...rest } = c;
    criteria.push({ id: `S${i + 1}`, source: p, ...rest });
    if (c.change === 'removed') documents.push({ source: `${p} (removed)`, text: removedRaw });
  });
  for (const f of files) if (f.text !== null && changed.some((c) => c.path === f.path)) documents.unshift({ source: f.path, text: f.text });
  status.criteria = (status.criteria || []).concat(criteria);
  status.documents = (status.documents || []).concat(documents);

  const info = { cut: false };
  // A: code hunks -> requirement items
  const blockItems = [], allBlocks = [];
  let codeH = [];
  try {
    const hunks = codeH = codeHunks(patch).filter((h) => !h.is_test && !d.docs.has(h.path) && !d.ruled(h.path) && !docLike(h.path) && !NOT_CODE_DIR.test(h.path));
    if (allItems.length && hunks.length) {
      const c2r = {};
      cand.code_to_requirement = codeToRequirement(hunks, allItems, c2r);
      if (c2r.dropped) cand.limitations.push(`${c2r.dropped} weaker code hunk(s) beyond the ${MAX_HUNKS}-hunk limit were left out of code_to_requirement.`);
    }
    // Descriptive blocks (no normative word) of the admitted documents that match a hunk join as 'block' candidates; the model does not have to find them by reading.
    if (docs.length && hunks.length) {
      const taken = new Set(allItems.map((i) => `${i.path}:${i.line}`));
      for (const x of docs) {
        if (dl.over()) { cand.limitations.push('The time budget was reached before every document was searched for descriptive requirement blocks.'); break; }
        for (const b of blocksOf(x.path, x.text)) if (!taken.has(`${b.path}:${b.line}`)) blockItems.push({ ...b, kind: 'block' });
      }
      allBlocks.push(...blockItems);
      if (blockItems.length) {
        const bl = codeToRequirement(hunks, blockItems, {}, { per: BLOCK_PER_HUNK, total: BLOCK_TOTAL, min: BLOCK_MIN * Math.log(1 + (blockItems.length - 0.5) / 1.5), stop: BLOCK_STOP });
        const seen = new Set();
        for (const h of bl) {
          for (const c of h.candidates) seen.add(`${c.path}:${c.line}`);
          const mine = cand.code_to_requirement.find((o) => o.path === h.path && o.line === h.line);
          if (mine) mine.candidates.push(...h.candidates); else cand.code_to_requirement.push(h);
        }
        blockItems.splice(0, blockItems.length, ...blockItems.filter((b) => seen.has(`${b.path}:${b.line}`)));
      }
    }
  } catch (e) { lim('code-to-requirement ranking', e); }
  // B: changed requirement items -> code and tests; occurrence table. Only the MAX_DEEP largest changes are traced in depth.
  const all = criteria.map((c) => ({ id: c.id, heading: c.heading, quote: c.quote, previous: c.previous, deltas: c.deltas,
    lits: [...new Set([...c.deltas.removed, ...c.deltas.added].flatMap((v) => [numeric(v) ?? v, ...sizeVariants(v)]))] }));
  const weight = (c) => (c.deltas.removed.length + c.deltas.added.length) * 1000 + c.quote.length + (c.previous || '').length;
  const deep = all.length <= MAX_DEEP ? all : all.map((c, i) => [c, i]).sort((a, b) => weight(b[0]) - weight(a[0]) || a[1] - b[1]).slice(0, MAX_DEEP).sort((a, b) => a[1] - b[1]).map((x) => x[0]);
  if (deep.length < all.length) {
    const left = all.filter((c) => !deep.includes(c)).map((c) => c.id);
    cand.limitations.push(`deferred: ${left.length} changed requirement item(s) were not traced to code in depth (only the ${MAX_DEEP} largest changes were): ${left.slice(0, 10).join(', ')}${left.length > 10 ? ', ...' : ''}.`);
  }
  if (deep.length) {
    try { cand.requirement_to_code = requirementToCode({ cwd, head, entries: d.entries, crits: deep, dl, info, skip: (p) => d.docs.has(p) || d.ruled(p) || (docLike(p) && !/\.feature$/i.test(p)) }); } catch (e) { lim('requirement-to-code ranking', e); }
    try { cand.occurrences = occurrences({ cwd, head, crits: deep.filter((c) => c.deltas.removed.length), maps, dl, info }); } catch (e) { lim('occurrence search', e); }
  }
  // T: a removed or weakened test assertion points at the behaviour it protected: its literals and subject find requirement items (test -> req) and code windows (test -> code).
  // Real code hunks and S* criteria keep priority; these come after them, under the same hunk limit and time budget. Marked via: "test".
  try {
    const tq = dl.over() ? [] : weakenedQueries(patch);
    if (tq.length) {
      const t2c = requirementToCode({ cwd, head, entries: d.entries, dl, info, cover: true, maxLitShare: LIT_SHARE, skip: (p) => d.docs.has(p) || d.ruled(p) || (docLike(p) && !/\.feature$/i.test(p)),
        crits: tq.map((q, i) => ({ id: `T${i + 1}`, heading: '', quote: q.ids.join(' '), previous: '', lits: q.lits })) });
      for (const r of t2c) { const code = r.code.filter((w) => w.lits >= 1); if (code.length) cand.requirement_to_code.push({ criterion: r.criterion, via: 'test', note: TEST_NOTE, code, tests: [] }); } // a code window must hold a literal of the removed line
      const word = (x) => new RegExp(`(?<![\\w])${esc(x)}(?![\\w])`); // a literal the code scan found common is common here too
      const rows = []; // each query ranks only the requirement items and descriptive blocks (a default stated in prose) that hold a literal of its removed line
      let blocks = allBlocks;
      if (!blocks.length) { const taken = new Set(allItems.map((i) => `${i.path}:${i.line}`)); blocks = docs.flatMap((x) => blocksOf(x.path, x.text)).filter((b) => !taken.has(`${b.path}:${b.line}`)).map((b) => ({ ...b, kind: 'block' })); }
      for (const q of tq) {
        const every = allItems.concat(blocks), hit = (l) => every.filter((i) => word(l).test(i.text)).length;
        const res = q.lits.filter((l) => !(info.common && info.common.has(l)) && hit(l) <= Math.max(3, LIT_SHARE * every.length)).map(word), pool = every.filter((i) => res.some((re) => re.test(i.text))); // a literal in many items is no anchor
        if (pool.length) rows.push(...codeToRequirement([{ path: q.file, line: q.line, end: q.line, context: '', identifiers: q.ids, literals: { added: [], removed: q.lits } }], pool));
      }
      const room = Math.max(0, MAX_HUNKS - cand.code_to_requirement.length);
      cand.code_to_requirement.push(...rows.slice(0, room).map((h) => ({ ...h, via: 'test', note: TEST_NOTE })));
      if (rows.length > room) cand.limitations.push(`${rows.length - room} requirement match(es) for removed or weakened test assertions beyond the ${MAX_HUNKS}-hunk limit were left out of code_to_requirement.`);
    }
  } catch (e) { lim('removed-assertion search', e); }
  if (info.cut) cand.limitations.push(`The ${Math.round(budgetMs / 1000)} s time budget was reached; code, test and occurrence search for the changed requirements is partial.`);
  if (info.valuesCapped) cand.limitations.push(`Occurrence search covers only the first ${MAX_VALUES} changed values.`);
  // Weak models drown in long lists (pilot: 33.7 KB, truncated in the prompt): keep the top TOP_CAND ranked code and test windows per criterion. Ranking is unchanged.
  for (const r of cand.requirement_to_code) {
    const dropped = [...r.code.slice(TOP_CAND), ...r.tests.slice(TOP_CAND)];
    r.code = r.code.slice(0, TOP_CAND); r.tests = r.tests.slice(0, TOP_CAND);
    const shown = new Set([...r.code, ...r.tests].map((w) => w.path)), more = [...new Set(dropped.map((w) => w.path))].filter((p) => !shown.has(p)).slice(0, MAX_MORE);
    if (dropped.length) { if (more.length) r.more = more; cand.limitations.push(`${dropped.length} more code/test candidate(s) for ${r.criterion} not shown (top ${TOP_CAND} kept)${more.length ? ': ' + more.join(', ') : ''}.`); } // the cut is visible, not silent
  }
  const note = fitCandidates(cand);
  if (note) cand.limitations.push(note);

  // D*: an unchanged block of an admitted document that the trace links strongly to changed code governs it (code and tests changed, requirement unchanged).
  // One per hunk: its best block, unless a second block is within GOVERN_GAP of it. Added after step B, so it is not traced in depth like an S* change.
  try {
    const have = new Set(criteria.map((c) => `${c.source}:${c.ref}`)), byKey = new Map(blockItems.map((b) => [`${b.path}:${b.ref}`, b])), pick = new Map();
    for (const h of cand.code_to_requirement) {
      const bs = h.candidates.filter((c) => c.kind === 'block').sort((a, b) => b.score - a.score);
      if (!bs.length || bs[0].score < GOVERN_MIN || (bs[1] && bs[1].score >= GOVERN_GAP * bs[0].score)) continue;
      const k = `${bs[0].path}:${bs[0].ref}`;
      if (have.has(k) || !byKey.has(k)) continue;
      const hk = { path: h.path, start: h.line, end: h.end ?? h.line }, was = pick.get(k);
      if (!was || bs[0].score > was.score) pick.set(k, { score: bs[0].score, hunks: [...(was ? was.hunks : []), hk] }); else was.hunks.push(hk); // the hunks that picked it: post.js links the obligations inside them
    }
    // Removed-literal anchors come first and bypass the runner-up rule; the block joins the index if the BM25 pass did not keep it.
    const anchors = removedLiteralAnchors(codeH, allBlocks).filter((a) => !have.has(`${a.block.path}:${a.block.ref}`));
    const order = [];
    for (const a of anchors) {
      const k = `${a.block.path}:${a.block.ref}`;
      if (!byKey.has(k)) { byKey.set(k, a.block); blockItems.push(a.block); }
      const was = pick.get(k);
      pick.set(k, { score: was?.score ?? 0, hunks: [...(was?.hunks || []), ...a.hunks], anchor: { removed: a.removed } });
      order.push(k);
    }
    const rank = [...order, ...[...pick.keys()].filter((k) => !order.includes(k)).sort((a, b) => pick.get(b).score - pick.get(a).score)];
    const gov = rank.slice(0, MAX_GOVERNING).map((k, i) => { const b = byKey.get(k), v = pick.get(k); return { id: `D${i + 1}`, source: b.path, ref: b.ref, line: b.line, quote: b.text, hunks: v.hunks, ...(v.anchor ? { anchor: v.anchor } : {}) }; });
    criteria.push(...gov);
    status.criteria = (status.criteria || []).concat(gov);
  } catch (e) { lim('governing-block criteria', e); }

  // index: path:line [ref] text, hinted docs first, capped; over the cap only candidate and changed items remain
  const line = (i) => `${i.path}:${i.line} [${i.ref}] ${flat(i.text).slice(0, 160)}\n`;
  let index = allItems.concat(blockItems).map(line).join('');
  if (Buffer.byteLength(index) > INDEX_CAP) {
    const full = Buffer.byteLength(index);
    const want = new Set([...cand.code_to_requirement.flatMap((h) => h.candidates.map((c) => `${c.path}:${c.ref}`)), ...criteria.map((c) => `${c.source}:${c.ref}`)]);
    index = allItems.concat(blockItems).filter((i) => want.has(`${i.path}:${i.ref}`)).map(line).join('');
    while (Buffer.byteLength(index) > INDEX_CAP) index = index.slice(0, index.lastIndexOf('\n', index.length - 2) + 1);
    cand.limitations.push(`requirements-index.md exceeded ${INDEX_CAP / 1024} KB (full index ${Math.round(full / 1024)} KB); it lists only candidate and changed items.`);
  }
  return finish(criteria.length, docs.map((x) => x.path), index);
}

if (require.main === module) {
  const env = process.env, [cmd, ...args] = process.argv.slice(2);
  const off = String(env.TRACE || '').toLowerCase() === 'off';
  const ignoreExtra = [env.IGNORE_EXTRA, ...parseReqPaths(env.STANDARDS_PATHS).inc].filter(Boolean).join('\n'); // STANDARDS_PATHS docs are rule files, not requirement docs
  if (cmd === 'classify') {
    const out = off ? [] : classify({ base: env.DIFF_BASE_SHA || env.BASE_SHA, head: env.HEAD_SHA || 'HEAD', paths: args, reqPaths: env.REQ_PATHS, ignoreExtra, ctx: env.CTX });
    process.stdout.write(out.map((p) => p + '\n').join(''));
  } else {
    process.stdout.write(`${run({ base: env.DIFF_BASE_SHA || env.BASE_SHA, head: env.HEAD_SHA, ctx: env.CTX, reqPaths: env.REQ_PATHS, trace: env.TRACE, ignoreExtra, budgetMs: +env.TRACE_BUDGET_MS || undefined })}\n`);
  }
}

module.exports = { FIXTURE_PATH, tokenize, buildIndex, parseItems, isRequirementDoc, isSpecDoc, pairItems, valueDeltas, durationVariants, sizeVariants, isTestPath, pathKind,
  codeHunks, matchGlob, testScope, classify, namedDocs, blocksOf, run, requirementToCode, lsTree, catBatch, makeClock, RULE_GLOBS, BLOCK_STOP };
