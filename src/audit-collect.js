#!/usr/bin/env node
// Unit test gap scan (mode scan; audit is an alias), step 1: deterministic context for the checked-out HEAD (no diff, no AI, no repo code executed).
// Env: CTX REQ_PATHS STANDARDS_PATHS TEST_PATHS IGNORE_EXTRA SCAN_MAX_BLOCKS (deprecated alias MAX_REQUIREMENTS; the new name wins) MAX_UNITS (+ GITHUB_REF_NAME, GITHUB_EVENT_PATH for the default-branch guard).
// Also SCAN_PATHS (scope globs), SCAN_ISSUE (rotate through the blocks), GH_TOKEN + GH_REPO (to read the scan issue's state when SCAN_ISSUE is true).
// Writes audit-docs.txt, audit-candidates.txt (cid, path:line, heading, text: the blocks the model must assess this run), audit-evidence.txt (per block: up to 3 code and 3 test
// locations found deterministically), audit-carried.txt (the blocks not audited this run), audit-ruled.txt (blocks the trace.js prefilter dropped: cid, path:line, heading, text, reason), audit-rejected.txt, standards.txt, test-layout.txt, audit-meta.json.
// Code-first (always, with or without design documents): audit-units.txt, audit-units-carried.txt and audit-inventory.json for the max_units riskiest source files (src/audit-units.js).
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { inventory, write: writeUnits } = require('./audit-units');
const UNBOUNDED = 'ffffffff'; // audit-post.js: the state's ev marker for a block that cited more files than it keeps
const { PER_FILE } = require('./pack-cap');
const { run, matchGlob, isTestPath, blocksOf, testScope, tokenize, requirementToCode, lsTree, catBatch, makeClock, RULE_GLOBS, BLOCK_STOP } = require('./trace');

const MAX_AUDIT_DOCS = 60; // the model reads every admitted document in full
const CAND_CAP = 60 * 1024, CAND_TEXT = 240, BLOCK_CAP = 4000; // audit-candidates.txt bytes (the cap is lowered, never a row cut); characters of block text per line
const EV_BUDGET_MS = 40000, EV_CAP = 64 * 1024, EV_PER = 3, EV_SNIP = 90, EV_TEXT = 600, COVER_MIN = 0.4; // ponytail: a heuristic floor, tuned by eye on this repo's design.md; table rows of results still match prose-heavy code // evidence search time budget (as in PR mode); audit-evidence.txt bytes; locations per kind and block; snippet characters; block text used as the query
// Words that say nothing about code: BLOCK_STOP (PR mode's list) plus common English function words. ponytail: English only, extend when another language floods the candidates.
const STOP = new Set([...BLOCK_STOP, ...'when then will must should shall can may each all any has have had was were been being which what who how its their there these those into over under than also but only one two more most such per via using used does did'.split(' ')]);
const CONTROL = /[\x00-\x1F\x7F]/;
// Same list as STANDARDS and OWN in collect.sh. ponytail: duplicated, keep in sync (trace.js RULE_GLOBS is a third copy).
const E5 = ['md', 'mdx', 'rst', 'txt', 'adoc'];
const STANDARDS = ['.github/copilot-instructions.md', '.github/instructions/**', '**/AGENTS.md', '**/AGENT.md', '**/CLAUDE.md', '**/GEMINI.md', 'REVIEW.md', 'CONTRIBUTING.md', 'CODING_STANDARDS.md', '.editorconfig',
  ...E5.flatMap((e) => [`docs/*standards*.${e}`, `docs/*conventions*.${e}`]), '.claude/rules/**', '.github/skills/**', '.claude/skills/**', '.agents/skills/**',
  '.cursorrules', '.cursor/rules/**', '.windsurfrules', '.clinerules/**', '.cursor/BUGBOT.md', '**/BUGBOT.md', '.gemini/styleguide.md', '.greptile/rules.md'];
const OWN = ['**/skills/test-review/**', '.github/instructions/test-review.instructions.md'];
const TEST_NAMES = [['*.test.*', /\.test\.[^.]+$/], ['*.spec.*', /\.spec\.[^.]+$/], ['test_*', /^test_/], ['*_test.*', /_test\.[^.]+$/], ['*Test.*, *Tests.*', /Tests?\.[^.]+$/]];
const TEST_CONFIG = /^(package\.json|pytest\.ini|tox\.ini|setup\.cfg|pyproject\.toml|go\.mod|Cargo\.toml|pom\.xml|build\.gradle(\.kts)?|Gemfile|phpunit\.xml(\.dist)?|jest\.config\.[cm]?[jt]s|vitest\.config\.[cm]?[jt]s|playwright\.config\.[jt]s|cypress\.config\.[jt]s|.*\.csproj)$/;
const DOC = /\.(md|mdx|markdown|rst|adoc|txt|feature)$/i;
// Data is neither code nor a test: recorded results, fixtures, lock files, snapshots, vendored or generated trees never carry evidence.
const NOT_EVIDENCE = /\.(jsonl?|csv|tsv|svg|lock|snap|map|ya?ml)$|\.min\.|(^|\/)(results?|fixtures?|testdata|__fixtures__|__snapshots__|snapshots?|vendor|third_party|generated|node_modules)\//i;

const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'pipe'] });
const lines = (s) => String(s).split('\n').filter(Boolean);

// Tracked regular files (symlinks excluded) at HEAD.
function tracked(cwd) {
  return git(cwd, ['ls-files', '-z', '-s']).split('\0').flatMap((r) => {
    const m = /^(\d{6}) \w+ \d\t([\s\S]+)$/.exec(r);
    return m && m[1] !== '120000' && !CONTROL.test(m[2]) ? [m[2]] : [];
  });
}

// testPaths (test_paths): the owner's authoritative test locations; every non-document file there is a test, whatever its name. Empty = discovery by name.
function testLayout(files, testPaths = '') {
  const dirs = new Map(), names = new Map(), cfg = new Set(), scope = testScope(testPaths);
  for (const f of files) {
    const base = path.posix.basename(f);
    if (TEST_CONFIG.test(base) && f.split('/').length <= 3) cfg.add(f);
    if (DOC.test(f) || !(scope ? scope(f) : isTestPath(f) || /Tests?\.(java|kt|cs|swift|scala)$/.test(f))) continue;
    const d = path.posix.dirname(f);
    dirs.set(d, (dirs.get(d) || 0) + 1);
    for (const [n, re] of TEST_NAMES) if (re.test(base)) names.set(n, (names.get(n) || 0) + 1);
  }
  const top = (m, n) => [...m].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, n).map(([k, v]) => `${k} (${v})`).join(', ') || 'none found';
  const set = String(testPaths || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return `${scope ? `configured test locations (authoritative, set by the repository owner; a ! line is excluded): ${set.join(', ')}\n` : ''}test directories: ${top(dirs, 15)}\ntest file names: ${top(names, 6)}\ntest config files: ${[...cfg].sort().slice(0, 15).join(', ') || 'none found'}\n`;
}

// Same syntax as REQ_PATHS: newline-separated globs, '!glob' excludes.
const globs = (s) => {
  const inc = [], exc = [];
  for (const l of String(s || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean)) (l.startsWith('!') ? exc : inc).push(l.replace(/^!/, ''));
  return { inc, exc };
};

// Block ids: a stable hash of the block (blocksOf, the block universe, lives in trace.js).
const normText = (s) => String(s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
// The text version of a block (stored in the scan state as versions.tv): whitespace and markdown emphasis/code marks are ignored, symbols and case are kept (the cid ignores them: `>= 10` and `> 10` share one).
const textVer = (t) => crypto.createHash('sha1').update(String(t).replace(/\*\*|__|`/g, '').replace(/\s+/g, ' ').trim()).digest('hex').slice(0, 8);
const sha8 = (...parts) => crypto.createHash('sha1').update(parts.join('\n')).digest('hex').slice(0, 8);

// Scope predicate for scan_paths (same syntax as requirements_paths: newline globs, '!' excludes; a plain path is a file or a folder). null = the whole repository.
function scopeFn(spec) {
  const { inc, exc } = globs(spec);
  if (!inc.length && !exc.length) return null;
  const hit = (list, f) => list.some((g) => matchGlob(f, g) || (!/[*?[]/.test(g) && matchGlob(f, g.replace(/\/*$/, '/'))));
  return (f) => (!inc.length || hit(inc, f)) && !hit(exc, f);
}

// The whole block text for audit-blocks.txt: one row per block (backslash and newline escaped), cut at BLOCK_CAP characters with a visible marker.
const blockBody = (raw) => { const t = String(raw).replace(/\r\n?/g, '\n').trim().replace(/\\/g, '\\\\').replace(/\t/g, ' ').replace(/\n/g, '\\n'); return t.length > BLOCK_CAP ? `${t.slice(0, BLOCK_CAP)} [truncated]` : t; };

// Every block of the admitted documents, in document order. cid = sha1(path, heading, normalised block text)[0..8]: stable while the block is unchanged, wherever it moves. A repeated block gets its own cid.
function allBlocks(cwd, head, docs, ruled = null) { // ruled (optional array) receives the blocks trace.js's prefilter dropped, with a `reason`: never audited, never counted against the cap
  const all = [], seen = new Set(), flat = (s) => s.replace(/\s+/g, ' ').trim();
  for (const p of docs) {
    let items = [];
    const dropped = [];
    try { items = blocksOf(p, git(cwd, ['show', `${head}:${p}`]), dropped); } catch { /* unreadable: the model still reads the document */ }
    for (const i of [...items, ...dropped].sort((a, b) => a.line - b.line)) {
      const h = i.heading || '', t = normText(i.raw), full = i.ctx ? `${i.ctx}\n${i.raw}` : i.raw; // cid: the block's own text; tv and body also carry the inherited Gherkin Background
      let cid = sha8(p, h, t);
      for (let k = 2; seen.has(cid); k++) cid = sha8(p, h, t, `#${k}`);
      seen.add(cid);
      if (i.reason) { if (ruled) ruled.push({ cid, path: p, line: i.line, heading: flat(h), text: flat(i.text).slice(0, CAND_TEXT), reason: i.reason }); continue; }
      all.push({ cid, path: p, line: i.line, heading: flat(h), text: flat(i.text).slice(0, CAND_TEXT), full: flat(i.text).slice(0, EV_TEXT), end: i.end, tv: textVer(full), tvLegacy: textVer(i.raw), body: blockBody(full) });
    }
  }
  return all;
}

// Which blocks this run audits (at most cap), in priority order. prior = the scan issue's state { head, blocks: [{ cid, status, runs, at: { date } }] } (null: document order).
//   d changed: blocks that are new or edited since the last scanned head (changedDocs: path -> cids the document had then; the cid is not in the state either),
//     and covered blocks whose cited code or test files changed since their audit (stale, review F06);
//   c confirming: a gap seen once, or a resolved gap awaiting its second covered run;
//   n new: blocks never audited, in document order; o oldest: everything else, least recently audited first.
function select(all, cap, prior, changedDocs = null, stale = new Set()) {
  if (!prior) { const picked = all.slice(0, cap); return { picked, tally: { d: 0, c: 0, n: picked.length, o: 0 }, kind: new Map() }; }
  const st = new Map(prior.blocks.map((b) => [b.cid, b])), kind = new Map(), picked = [];
  const when = (b) => (st.get(b.cid).at || {}).date || ''; // unknown (a v3 state) sorts first
  const take = (list, k) => { for (const b of list) if (picked.length < cap && !kind.has(b.cid)) { kind.set(b.cid, k); picked.push(b); } };
  const asc = (a, b) => (when(a) < when(b) ? -1 : when(a) > when(b) ? 1 : 0); // Array.sort is stable: ties keep document order
  take(all.filter((b) => !st.has(b.cid) && changedDocs && changedDocs.has(b.path) && !changedDocs.get(b.path).has(b.cid)), 'd');
  take(all.filter((b) => stale.has(b.cid)).sort(asc), 'd');
  const retry = new Set((prior.versions && prior.versions.un) || []); // not answered by the model last run: one more try, first (review S6)
  take(all.filter((b) => st.has(b.cid) && ((st.get(b.cid).status === 'gap' && st.get(b.cid).runs === 1) || st.get(b.cid).status === 'recheck' || retry.has(b.cid))).sort(asc), 'c');
  take(all.filter((b) => !st.has(b.cid)), 'n');
  take(all.filter((b) => st.has(b.cid)).sort(asc), 'o');
  const tally = { d: 0, c: 0, n: 0, o: 0 };
  for (const k of kind.values()) tally[k]++;
  return { picked, tally, kind };
}

// Per block: up to EV_PER code and EV_PER test locations (path:line + the best line) by the PR-mode requirement-to-code scorer, over the files in scope.
// A location needs two matched terms and a fair share of the best score: a block that merely shares a word with the code gets nothing. cut: the time budget ended the search.
// ponytail: BM25 over 40-line windows of the whole tree; per-package scoping (scan_paths) is what keeps it affordable on a monorepo.
// the block's concrete values for the search: numbers of two or more digits (sizes, limits, timeouts). ponytail: numbers only; quoted names and units are left to the words
const litsOf = (t) => [...new Set(String(t).match(/(?<![\w.])\d{2,}(?![\w.])/g) || [])].slice(0, 8);
function evidence({ cwd, head, blocks, scope = null, docs = [], ignoreExtra = '', budgetMs = EV_BUDGET_MS }) {
  const info = { cut: false }, dl = makeClock(budgetMs);
  const entries = lsTree(cwd, head).filter((e) => !scope || scope(e.path)), docSet = new Set(docs);
  const rules = RULE_GLOBS.concat(lines(ignoreExtra));
  const skip = (p) => docSet.has(p) || DOC.test(p) || NOT_EVIDENCE.test(p) || rules.some((g) => matchGlob(p, g));
  const rows = blocks.length ? requirementToCode({ cwd, head, entries, skip, dl, info, stop: STOP, cover: true, crits: blocks.map((b) => ({ id: b.cid, quote: b.full, previous: '', lits: litsOf(b.full) })) }) : [];
  // a window counts when it holds a good share of the block's weighted terms (cover) and three of them (two when it holds nearly all of a short block's)
  // a window qualifies by the block's words (cover), or by two of the block's concrete values (a long table row whose sizes sit in one config line: `width: 1000, height: 800`)
  const good = (l) => { const s = l.filter((w) => (w.lits || 0) >= 2 || (w.cover >= COVER_MIN && ((w.hits || []).length >= 3 || (w.hits.length === 2 && w.cover >= 0.8)))); const byLit = (w) => (w.lits || 0) >= 2; return [...s.filter(byLit), ...s.filter((w) => !byLit(w) && w.score >= 0.3 * s[0].score)]; }; // two matching values first: stronger than shared words
  const picks = new Map(rows.map((r) => {
    const code = good(r.code).slice(0, EV_PER);
    return [r.criterion, { code, test: code.length ? [...good(r.tests.filter((w) => !w.via)), ...r.tests.filter((w) => w.via)].slice(0, EV_PER) : [] }]; // a transitive test hangs off a code window: no code, no test
  }));
  const shaOf = new Map(entries.map((e) => [e.path, e.sha])), paths = [...new Set([...picks.values()].flatMap((p) => [...p.code, ...p.test].map((w) => w.path)))];
  const bufs = paths.length ? catBatch(cwd, paths.map((p) => shaOf.get(p))) : [], text = new Map(paths.map((p, k) => [p, bufs[k] ? bufs[k].toString('utf8').split(/\r?\n/) : []]));
  const best = (w) => { // the line of the window that holds most of the matched terms
    const ls = text.get(w.path), terms = new Set(w.hits && w.hits.length ? w.hits : tokenize(w.via || ''));
    let at = -1, n = 0;
    for (let i = w.line - 1; i < Math.min(w.end, ls.length); i++) { const k = new Set(tokenize(ls[i].slice(0, 400)).filter((t) => terms.has(t))).size; if (k > n) { n = k; at = i; } }
    if (at < 0) at = Math.max(0, ls.findIndex((l, i) => i >= w.line - 1 && l.trim()));
    return { line: at + 1, snip: String(ls[at] || '').replace(CONTROL, ' ').replace(/\s+/g, ' ').trim().slice(0, EV_SNIP) };
  };
  const by = new Map();
  for (const b of blocks) {
    const p = picks.get(b.cid) || { code: [], test: [] };
    by.set(b.cid, ['code', 'test'].flatMap((k) => p[k].map((w) => { const x = best(w); return `${b.cid}\t${k}\t${w.path}:${x.line}\t${x.snip}\n`; })));
  }
  return { by, cut: info.cut, files: entries.length, rows };
}

// audit-evidence.txt: whole blocks while they fit EV_CAP; a block without a location says `none`.
function evidenceText(blocks, by) {
  let text = '', withCode = 0, withTests = 0, left = 0;
  for (const b of blocks) {
    const ls = by.get(b.cid) || [], chunk = ls.length ? ls.join('') : `${b.cid}\tnone\n`;
    if (Buffer.byteLength(text) + Buffer.byteLength(chunk) > EV_CAP) { left++; continue; }
    text += chunk;
    if (ls.some((l) => l.split('\t')[1] === 'code')) withCode++;
    if (ls.some((l) => l.split('\t')[1] === 'test')) withTests++;
  }
  return { text, withCode, withTests, left };
}

// The blocks to audit, in document order, after the priority pick and the CAND_CAP byte cap (never a cut row). carried: the others the state already knows.
function candidates(all, cap, prior, changedDocs, stale) {
  const sel = select(all, cap, prior, changedDocs, stale), at = new Map(all.map((c, i) => [c.cid, i])), row = (c) => `${c.cid}\t${c.path}:${c.line}${c.end ? `-${c.end}` : ''}\t${c.heading}\t${c.text}\n`;
  let used = 0;
  const fit = [];
  for (const c of sel.picked) {
    const n = Buffer.byteLength(row(c));
    if (used + n > CAND_CAP) break;
    used += n; fit.push(c);
  }
  fit.sort((a, b) => at.get(a.cid) - at.get(b.cid));
  const tally = { d: 0, c: 0, n: 0, o: 0 };
  for (const c of fit) tally[prior ? sel.kind.get(c.cid) : 'n']++;
  const chosen = new Set(fit.map((c) => c.cid)), rest = all.filter((c) => !chosen.has(c.cid));
  const known = new Set(prior ? prior.blocks.map((b) => b.cid) : []), carried = rest.filter((c) => known.has(c.cid));
  const left = [];
  if (!prior) {
    const notAudited = [];
    for (const c of rest) {
      const where = c.heading ? `${c.path} § ${c.heading}` : `${c.path} (before the first heading)`, last = notAudited[notAudited.length - 1];
      if (last && last.where === where) last.n++; else notAudited.push({ where, n: 1 });
    }
    left.push(...notAudited.map(({ where, n: k }) => `${where}: ${k} block${k === 1 ? '' : 's'} not scanned (cap)`));
  } else if (rest.length) left.push(`${rest.length} of ${all.length} blocks were not audited this run (scan_max_blocks ${cap}); ${carried.length} keep the status of their last audit, ${rest.length - carried.length} have never been audited`);
  if (fit.length < Math.min(cap, all.length)) left.unshift(`audit-candidates.txt would pass ${CAND_CAP / 1024} KB: the cap was lowered to ${fit.length} blocks`);
  return { text: fit.map(row).join(''), fit, tally, carried, total: all.length, left };
}

// The scan reads the default branch only: another ref's documents would overwrite the one scan issue. Returns { error } or { warn } or {}.
function branchGuard({ refName = '', eventPath = '' } = {}) {
  let def = '';
  try { def = JSON.parse(fs.readFileSync(eventPath, 'utf8')).repository.default_branch || ''; } catch { /* no event file */ }
  if (!refName || !def) return { warn: 'could not tell whether this ref is the default branch (GITHUB_REF_NAME or the event payload is missing); scanning the checked-out ref' };
  return refName === def ? {} : { error: `mode scan reads the default branch (${def}); this run is on ${refName}. Run it from the default branch (a schedule or workflow_dispatch there).` };
}

// scanPaths: the scope (docs and evidence); rotate: scan_issue is on, so the run is one of a rotation; prior: that issue's state (null on the first run or without an issue).
function collect({ cwd = '.', ctx, reqPaths = '', standardsPaths = '', testPaths = '', ignoreExtra = '', maxRequirements = 80, maxUnits = 12, scanPaths = '', rotate = false, prior = null, evidenceBudgetMs = EV_BUDGET_MS, now = Date.now(), packBytes = 0 }) { // packBytes: the claude api engine's context pack (0 = another engine: units split at 40 KB)
  const head = git(cwd, ['rev-parse', 'HEAD']).trim();
  fs.rmSync(ctx, { recursive: true, force: true });
  fs.mkdirSync(ctx, { recursive: true });
  // trace.js with base = head: no diff, so it only discovers the requirement documents (same rules, caps and ignores as the PR review)
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'specguard-audit-'));
  let found, rejected, limitations = [];
  const std = globs(standardsPaths), scope = scopeFn(scanPaths);
  try {
    // STANDARDS_PATHS documents are rule files, not requirement documents (trace.js does the same in PR mode)
    run({ cwd, base: head, head, ctx: scratch, reqPaths, ignoreExtra: [ignoreExtra, ...std.inc].filter(Boolean).join('\n'), scope });
    const read = (n) => { try { return fs.readFileSync(path.join(scratch, n), 'utf8'); } catch { return ''; } };
    found = lines(read('spec-files.txt'));
    rejected = lines(read('spec-rejected.txt')).map((l) => l.split('\t'));
    try { limitations = JSON.parse(read('trace-candidates.json')).limitations || []; } catch { /* none */ }
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }

  const inc = lines(reqPaths).map((l) => l.trim()).filter((l) => l && !l.startsWith('!'));
  const forced = (p) => inc.some((g) => matchGlob(p, g));
  const ordered = [...found.filter(forced), ...found.filter((p) => !forced(p))];
  const docs = ordered.slice(0, MAX_AUDIT_DOCS);
  for (const p of ordered.slice(MAX_AUDIT_DOCS)) rejected.push([p, `over the ${MAX_AUDIT_DOCS}-document audit limit`]);

  const files = tracked(cwd), inScope = scope ? files.filter((f) => scope(f) || !f.includes('/')) : files; // the layout hint describes the scope (plus root manifests)
  const listed = STANDARDS.concat(std.inc);
  const standards = files.filter((f) => listed.some((g) => matchGlob(f, g)) && !std.exc.some((g) => matchGlob(f, g)) && !OWN.some((g) => matchGlob(f, g)));
  const w = (n, s) => fs.writeFileSync(path.join(ctx, n), s);
  w('audit-docs.txt', docs.map((p) => `${p}\t${forced(p) ? 'requirements_paths' : 'discovered'}\n`).join(''));
  const ruled = [], all = allBlocks(cwd, head, docs, ruled), notes = [];
  let changedDocs = null; // changed document -> the block cids it had at the last scanned head; null = unknown (no state, or the old head is not in this clone)
  if (prior && prior.head) {
    try {
      const names = new Set(git(cwd, ['diff', '--name-only', '-z', prior.head, head]).split('\0').filter(Boolean));
      changedDocs = new Map(docs.filter((p) => names.has(p)).map((p) => [p, new Set(allBlocks(cwd, prior.head, [p]).map((b) => b.cid))]));
    }
    catch { notes.push(`could not diff against the last scanned commit ${prior.head.slice(0, 7)} (shallow clone? use fetch-depth: 0): changed documents are not prioritised`); }
  }
  // covered blocks whose cited files changed since their audit (the state's ev: path hashes per block); an audit commit missing from this clone counts as changed
  const stale = new Set(), diffs = new Map(), hashOf = (p) => crypto.createHash('sha1').update(p).digest('hex').slice(0, 8);
  if (prior && prior.versions) {
    let unbounded = 0;
    const auditedAt = new Map(prior.blocks.map((b) => [b.cid, b.at && b.at.head]));
    for (const [cid, hs] of Object.entries(prior.versions.ev)) {
      const h = auditedAt.get(cid);
      if (h && !diffs.has(h)) { try { diffs.set(h, new Set(git(cwd, ['diff', '--name-only', '--no-renames', '-z', h, head]).split('\0').filter(Boolean).map(hashOf))); } catch { diffs.set(h, null); } }
      const d = h ? diffs.get(h) : null;
      if (!d || (hs.includes(UNBOUNDED) ? d.size > 0 : hs.some((x) => d.has(x)))) stale.add(cid); // UNBOUNDED: it cited more files than the state keeps, so any change counts (review S4)
      if (d && d.size > 0 && hs.includes(UNBOUNDED)) unbounded++;
    }
    // requirement text changed under an unchanged cid; a block with no recorded version (an older state) is left alone, not reset
    const tvNow = new Map(all.map((b) => [b.cid, b.tv])), tvOld = new Map(all.map((b) => [b.cid, b.tvLegacy])); // ponytail: temporary migration. A state written before Background context holds the legacy tv: not a change (the new tv replaces it when the block is next audited). Drop tvLegacy after one full rotation has re-audited every block.
    for (const [cid, v] of Object.entries(prior.versions.tv || {})) if (tvNow.has(cid) && tvNow.get(cid) !== v && tvOld.get(cid) !== v) stale.add(cid);
    if (unbounded) notes.push(`${unbounded} block(s) cite more than 8 files; their freshness cannot be tracked, so they are rechecked each run`);
    if ([...diffs.values()].includes(null)) notes.push('could not diff against an earlier audit commit (shallow clone? use fetch-depth: 0): its covered blocks are treated as changed and rechecked first');
  }
  const cand = candidates(all, maxRequirements, prior, changedDocs, stale);
  let ev = { by: new Map(), cut: false, files: 0 };
  try { ev = evidence({ cwd, head, blocks: cand.fit, scope, docs: found, ignoreExtra, budgetMs: evidenceBudgetMs }); }
  catch (e) { notes.push(`evidence search failed (${String(e && e.message || e).split('\n')[0].slice(0, 120)}); the model searches by itself`); }
  const et = evidenceText(cand.fit, ev.by);
  if (ev.cut) notes.push(`the ${Math.round(evidenceBudgetMs / 1000)} s time budget ended the evidence search: blocks marked none may still have code and tests`);
  if (et.left) notes.push(`audit-evidence.txt would pass ${EV_CAP / 1024} KB: ${et.left} block(s) have no candidate locations`);
  if (cand.fit.length) notes.push(`evidence candidates are capped at ${EV_PER} code and ${EV_PER} test locations per block`);
  w('audit-candidates.txt', cand.text);
  w('audit-textver.txt', cand.fit.map((c) => `${c.cid}\t${c.tv}\n`).join('')); // text version per audited block, for the scan state
  w('audit-blocks.txt', cand.fit.map((c) => `${c.cid}\t${c.body}\n`).join('')); // the full block text (audit-candidates.txt rows are cut at CAND_TEXT)
  const cutBlocks = cand.fit.filter((c) => c.body.endsWith(' [truncated]'));
  if (cutBlocks.length) notes.push(`${cutBlocks.length} block(s) are longer than ${BLOCK_CAP} characters and were shown to the model cut (marked [truncated]), so not fully read: ${cutBlocks.slice(0, 5).map((c) => `${c.path}:${c.line}`).join(', ')}${cutBlocks.length > 5 ? ', ...' : ''}`);
  w('audit-evidence.txt', et.text);
  w('audit-ruled.txt', ruled.map((c) => `${c.cid}\t${c.path}:${c.line}\t${c.heading}\t${c.text}\t${c.reason}\n`).join('')); // skipped by rule: listed in the report, not sent to the model
  w('audit-carried.txt', cand.carried.map((c) => `${c.cid}\t${c.path}:${c.line}\t${c.heading}\t${c.text}\n`).join(''));
  w('audit-rejected.txt', rejected.map(([p, why]) => `${p}\t${why}\n`).join(''));
  w('standards.txt', standards.map((f) => `${f}\n`).join(''));
  w('test-layout.txt', testLayout(inScope, testPaths));
  // code-first: the riskiest source files, with or without design documents (a repository with none is the common case)
  let units = null;
  try {
    const rules = RULE_GLOBS.concat(lines(ignoreExtra)), docSet = new Set(found);
    // the pack carries the rule files first (each cut at the per-file cap, plus a header): units share what is left
    const left = packBytes && Math.max(1, packBytes - standards.reduce((n, f) => { try { return n + Math.min(fs.statSync(path.join(cwd, f)).size, PER_FILE) + 300; } catch { return n; } }, 0));
    units = inventory({ cwd, head, skip: (p) => docSet.has(p) || DOC.test(p) || NOT_EVIDENCE.test(p) || rules.some((g) => matchGlob(p, g)), scope, testPaths, maxUnits, prior, now, packBytes: left });
    if (units.rows.length) writeUnits(ctx, head, maxUnits, units);
    notes.push(...units.limitations);
  } catch (e) { notes.push(`the unit inventory failed (${String(e && e.message || e).split('\n')[0].slice(0, 120)}); the scan covers the design documents only`); units = null; }
  w('audit-stale.txt', [...[...stale].filter((c) => all.some((b) => b.cid === c)), ...((units && units.stale) || [])].map((c) => `${c}\n`).join('')); // block cids and unit ids changed since their review
  const rotation = { rotate, state: !!prior, picked: cand.fit.length, changed: cand.tally.d, confirming: cand.tally.c, new: cand.tally.n, oldest: cand.tally.o, carried: cand.carried.length };
  const evid = { blocks: cand.fit.length, with_code: et.withCode, with_tests: et.withTests, cut: ev.cut, files: ev.files };
  w('audit-meta.json', JSON.stringify({ head, max_requirements: maxRequirements, max_units: maxUnits, units: units && units.rows.length ? { total: units.rows.length, picked: units.picked.length } : null, docs: docs.length, candidates: cand.total, candidates_listed: cand.fit.length, ruled: ruled.length, cap_left: cand.left, limitations: [...limitations, ...notes],
    scope: lines(scanPaths).map((l) => l.trim()).filter(Boolean), rotation, evidence: evid }) + '\n');
  return { docs, rejected, standards, head, candidates: cand.total, picked: cand.fit.map((c) => c.cid), rotation, evidence: evid, units: units && { total: units.rows.length, picked: units.picked.map((r) => r.id), rotation: units.rotation, totals: units.totals } };
}

// The scan issue's state for this scope ({ head, blocks } or null: no issue, no state, no access). Read over the REST API with GH_TOKEN/GH_REPO, as this step runs before any github-script step.
async function loadPrior(env, fetchFn = globalThis.fetch) {
  try {
    const { findIssue, readState, resolveIssueTarget, guardIssueTarget, visibilityOf } = require('./audit-post');
    const api = env.GITHUB_API_URL || 'https://api.github.com', [owner, repo] = String(env.GH_REPO || env.GITHUB_REPOSITORY || '').split('/');
    // the publisher's target, scope and guard (audit-post), so the state is read from where it is written
    const rt = resolveIssueTarget(env, owner, repo);
    if (rt.error) { console.log(`::warning::SpecGuard: ${rt.error}; the previous scan state is not read (this run starts from the first block)`); return null; }
    const { target, scope: sc } = rt, token = (rt.away && env.ISSUE_TOKEN) || env.GH_TOKEN;
    const get = async (u, tok = token) => {
      const r = await fetchFn(`${api}${u}`, { headers: { authorization: `Bearer ${tok}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' } });
      if (!r.ok) throw new Error(`${r.status} ${u}`);
      return r.json();
    };
    const vis = async (o, r, tok) => { try { return visibilityOf(await get(`/repos/${o}/${r}`, tok)); } catch { return ''; } };
    const g = await guardIssueTarget(rt, () => vis(target.owner, target.repo, token), () => vis(owner, repo, env.GH_TOKEN));
    if (!g.ok) { console.log(`::warning::SpecGuard: scan issue not read from ${target.owner}/${target.repo}: ${g.reason}`); return null; }
    // the two calls audit-post's findIssue makes, over REST
    const github = {
      paginate: async (_f, o) => { const all = []; for (let p = 1; ; p++) { const page = await get(`/repos/${o.owner}/${o.repo}/issues?state=all&per_page=100&page=${p}`); all.push(...page); if (page.length < 100) return all; } },
      rest: { issues: { listForRepo: null } },
    };
    const me = await get('/user').then((u) => u.login, () => null); // an app or job token cannot: the issue is then ours when a github-actions bot opened it
    const issue = await findIssue({ github, ...target, me, mark: sc.mark, title: rt.away ? sc.title : '' });
    return (issue && readState(issue.body)) || null;
  } catch (e) {
    console.log(`::warning::SpecGuard: could not read the previous scan state (this run starts from the first block): ${e.message}`);
    return null;
  }
}

async function main(env) {
  const raw = env.SCAN_MAX_BLOCKS || env.MAX_REQUIREMENTS || '80', input = env.SCAN_MAX_BLOCKS ? 'scan_max_blocks' : 'audit_max_requirements';
  const max = /^\d{1,3}$/.test(raw) ? +raw : 0;
  if (max < 1 || max > 500) { console.log(`::error::${input} must be an integer from 1 to 500`); process.exit(1); }
  const mu = env.MAX_UNITS || '12', maxUnits = /^\d{1,3}$/.test(mu) ? +mu : 0;
  if (maxUnits < 1 || maxUnits > 100) { console.log('::error::max_units must be an integer from 1 to 100'); process.exit(1); }
  if (!env.CTX) { console.error('CTX is required'); process.exit(2); }
  const g = env.AUDIT_BRANCH_GUARD === 'off' ? {} : branchGuard({ refName: env.GITHUB_REF_NAME, eventPath: env.GITHUB_EVENT_PATH }); // off: manual run on another repository
  if (g.error) { console.log(`::error::${g.error}`); process.exit(1); }
  if (g.warn) console.log(`::warning::${g.warn}`);
  const rotate = String(env.SCAN_ISSUE || env.AUDIT_ISSUE).toLowerCase() === 'true'; // scan_issue wins; audit_issue is the deprecated alias
  const prior = rotate ? await loadPrior(env) : null;
  const r = collect({ ctx: env.CTX, reqPaths: env.REQ_PATHS, standardsPaths: env.STANDARDS_PATHS, testPaths: env.TEST_PATHS, ignoreExtra: env.IGNORE_EXTRA, maxRequirements: max, maxUnits, scanPaths: env.SCAN_PATHS, rotate, prior, packBytes: env.PACK_SPLIT === 'true' ? 250000 : 0 });
  console.log(`SpecGuard unit test gap scan: ${r.units ? `${r.units.picked.length} of ${r.units.total} units` : 'no units'}, ${r.docs.length} design document(s), ${r.rejected.length} not admitted${prior ? `; ${r.rotation.picked} of ${r.candidates} blocks chosen from the previous state` : ''}`);
  if (env.GITHUB_OUTPUT) fs.appendFileSync(env.GITHUB_OUTPUT, `skip=${r.docs.length || (r.units && r.units.total) ? 'false' : 'true'}\n`);
}

if (require.main === module) main(process.env);
module.exports = { collect, testLayout, branchGuard, blocksOf, STANDARDS, select, evidence, scopeFn, allBlocks, loadPrior };
