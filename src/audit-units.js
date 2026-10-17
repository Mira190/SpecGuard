// Code-first inventory for the unit test gap scan (mode scan), no model, no repo code executed: which source files ("units") are most at risk and least protected by unit tests.
// Used by audit-collect.js. Pure functions over the tracked tree at HEAD plus ONE `git log` pass for churn and fix commits.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { fileCap } = require('./pack-cap');
const { isTestPath, testScope, lsTree, catBatch, makeClock } = require('./trace');
const { weakCandidates, TEST_START } = require('./leads');
const { ASSERTION, SKIPPED } = require('./post');
const { mapTests, indexTests, noExt, publicDefs, GENERIC } = require('./test-map');

const DAYS = 180, FIX = /\b(fix|bug|hotfix|regression|revert)\b/i, MIN_LOC = 3;
const MAX_FILE = 512 * 1024, MAX_UNITS_READ = 6000, MAX_TESTS_READ = 4000, TEST_FILE = 512 * 1024, TEST_TOTAL = 48 * 1024 * 1024, BUDGET_MS = 40000;
const PER_UNIT_TESTS = 20, ROWS_KEPT = 100, LEADS = 3;
const CODE = /\.(?:[cm]?[jt]sx?|py|go|java|kt|cs|rb|php|rs|swift|scala)$/i;
// Not product code: examples, benchmarks, docs, generated or build output, config files, type declarations. ponytail: a name list; a repo that keeps product code in `examples/` narrows with scan_paths.
const NOT_UNIT = /(^|\/)(?:examples?|samples?|demos?|benchmarks?|bench|docs?|dist|build|out|coverage|migrations?|node_modules|vendor|third_party|generated)\/|\.d\.[cm]?ts$|(^|\/)(?:[\w.-]*\.config|\.[\w-]*rc|gulpfile|Gruntfile|Rakefile|setup|conftest|__init__)\.[a-z]+$|\.(?:min|bundle)\./i;
// Test infrastructure by name: a basename with a smoke/e2e/harness/runner/fixture/playwright/cypress token (runner-utils.js counts, testrunner.js does not), or a support/helpers dir under a test dir.
const TEST_INFRA = /(^|\/)[^/]*(?<![a-z0-9])(?:smoke|e2e|harness|runners?|fixtures?|playwright|cypress)(?![a-z0-9])[^/]*$|(^|\/)(?:tests?|specs?|__tests__|e2e)\/(?:[^/]+\/)*(?:support|helpers)\//i;
// First-level relative imports of a source text (JS/TS require, import, export-from, dynamic import), resolved against the tracked files -> blob shas.
// ponytail: one level only (a change two imports deep is not tracked), relative specifiers only (bare packages, Python and Go imports are ignored); the extension/index list is the Node/TS one.
const REL = /(?:\brequire\s*\(|\bfrom\s*|\bimport\s*\(?)\s*['"](\.\.?(?:\/[^'"\n]*)?)['"]/g, EXTS = ['', '.js', '.cjs', '.mjs', '.ts', '.tsx', '.jsx', '.json'];
function importShas(from, src, shaOf) {
  const out = new Set();
  for (const m of src.matchAll(REL)) {
    const base = path.posix.join(path.posix.dirname(from), m[1]), stem = base.replace(/\.[cm]?jsx?$/, ''); // ./x.js in TS means x.ts
    const hit = [base, stem !== base && stem].filter((b) => b !== false).flatMap((b) => [...EXTS.map((e) => b + e), ...EXTS.slice(1).map((e) => path.posix.join(b, 'index' + e))]).find((p) => shaOf.has(p));
    if (hit) out.add(`${hit}:${shaOf.get(hit)}`);
  }
  return [...out];
}
const sha8 = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 8);
const comment = (l) => /^\s*(?:\/\/|#|\*|\/\*|--)/.test(l);
const loc = (ls) => ls.filter((l) => l.trim() && !comment(l)).length;
const START = new RegExp(`${TEST_START.source}|(?<![.\\w$])x(?:it|test)\\s*\\(`); // leads.js's test start, plus xit/xtest (a disabled test is still a test)

const publicCount = (file, ls) => publicDefs(file, ls).count;

// Signals of one test file: tests, tests without an assertion, skipped or disabled tests, assertion lines, weak assertion lines (leads.js).
// ponytail: a test is a block from one test declaration to the next, an assertion is any line post.js's ASSERTION matches; an assertion inside a helper the test calls reads as no assertion.
function testSignals(src) {
  const ls = src.split('\n').slice(0, 6000).map((l) => l.replace(/\r$/, '')), starts = [];
  ls.forEach((l, i) => { if (l.length <= 400 && START.test(l)) starts.push(i); });
  const noAssert = starts.filter((s, k) => !ls.slice(s, starts[k + 1] ?? ls.length).some((l) => !comment(l) && ASSERTION.test(l))).length;
  return { tests: starts.length, noAssert, skipped: ls.filter((l) => SKIPPED.test(l)).length, asserts: ls.filter((l) => !comment(l) && ASSERTION.test(l)).length, weak: weakCandidates(src).map((w) => ({ line: w.line, what: w.what })) };
}

// ONE git log pass: path -> { churn: commits touching it in the last DAYS days, fixes: of those, commits whose subject says fix/bug/hotfix/regression/revert }. A shallow clone has no history: null.
function history(cwd, now = Date.now()) {
  const git = (...a) => execFileSync('git', ['-c', 'core.quotepath=off', ...a], { cwd, encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'ignore'] });
  try { if (git('rev-parse', '--is-shallow-repository').trim() === 'true') return null; } catch { return null; }
  const out = new Map();
  let log = '';
  try { log = git('log', '--no-merges', '--no-renames', `--since=${new Date(now - DAYS * 864e5).toISOString()}`, '--name-only', '--format=%x00%s'); } catch { return null; }
  for (const c of log.split('\0').slice(1)) {
    const nl = c.indexOf('\n'), fix = FIX.test(nl < 0 ? c : c.slice(0, nl));
    for (const f of nl < 0 ? [] : c.slice(nl + 1).split('\n').filter(Boolean)) { const o = out.get(f) || { churn: 0, fixes: 0 }; o.churn++; if (fix) o.fixes++; out.set(f, o); }
  }
  return out;
}

// Risk = (1 + public) * log2(2 + loc / 50) * (1 + churn / 5 + fixes) * testFactor, rounded to 0.1. testFactor: 1.0 no matched test, 0.6 tests that cannot protect it (no assertion, all skipped,
// or at least half of the assertions weak), 0.3 tested. Public definitions are what a unit test can reach, size and churn say how likely a change is to break it, every fix commit is a bug that escaped once.
// ponytail: a heuristic ranking tuned by eye, not a defect predictor: it orders the work of one scan, it is never shown as a probability. Ceiling: no coupling, ownership or complexity; a generated file that escaped the name list ranks high.
const risk = ({ pub, loc: n, churn, fixes, factor }) => Math.round((1 + pub) * Math.log2(2 + n / 50) * (1 + churn / 5 + fixes) * factor * 10) / 10;
const factorOf = (tests, s) => (!tests.length ? 1 : s.asserts === 0 || (s.tests > 0 && s.skipped >= s.tests) || s.weak.length * 2 >= s.asserts ? 0.6 : 0.3);

// Which units this run reviews (at most cap). rows: sorted by risk, highest first. prior = the scan issue's state { head, blocks: [{ cid, status, runs, at: { date } }] } (unit id = cid); null = the riskiest first.
//   c confirming: a unit whose findings were seen in one run only; s stale: the unit or its matched tests changed since it was reviewed (the state's version differs);
//   n never reviewed (riskiest first); o everything else, least recently reviewed first (ties: riskiest first).
// ponytail: verLegacy (ver before first-level imports were folded in) is a temporary migration: a stored legacy ver is not a change. Drop it after one full rotation has re-reviewed every unit.
const sameVer = (v, r) => v === r.ver || v === r.verLegacy;
const staleUnit = (r, prior) => { const v = prior && prior.versions && prior.versions.uv[r.id]; return !!v && !sameVer(v, r); };
// A unit too large for one model call is reviewed in parts (review F07): fixed line windows of about PART_BYTES, one per run, the cursor in the state (uc: [next part, part count]).
// -> { k, n, a, b } (part k of n, 0-based, lines a-b) or null when the file fits whole. A unit in progress is picked again until its last part.
const PART_BYTES = 40 * 1024;
// Claude api engine only (the one engine with a context pack; the others read files themselves): a part, as shown line-numbered (6 bytes a line), must fit the per-file cap and a 1/N share of the pack
// (claude-api.js contextPack adds every unit file before any test); 5/6 leaves slack for the block markup and rule files.
// shortcut: the collector assumes the default 250000-byte pack (the action has no input for CONTEXT_PACK_BYTES); wire it through if one is added.
// shortcut: parts are equal line counts, so a part of unusually long lines can exceed the average; the pack then lists it as cut.
const partBytes = (packBytes, units) => (packBytes ? { max: Math.min(PART_BYTES, Math.max(4096, Math.floor(Math.min(fileCap(packBytes), packBytes / units) * 5 / 6))), pre: 4 } : { max: PART_BYTES, pre: 0 }); // pre: minimum width of the line number in the pack's prefix (0 = no prefix)
const shownOf = (r, bytes) => r.size + (bytes.pre && Math.max(bytes.pre, String(r.lines).length) + 2) * r.lines; // prefix: the number, padded, plus 2
const partOf = (r, prior, bytes = partBytes(0)) => {
  const shown = shownOf(r, bytes);
  if (!(shown > bytes.max)) return null;
  const n = Math.ceil(shown / bytes.max), per = Math.ceil(r.lines / n), v = prior && prior.versions, at = v && v.uc && v.uv && sameVer(v.uv[r.id], r) ? v.uc[r.id] : null, k = Array.isArray(at) && at[1] === n && at[0] > 0 && at[0] < n ? at[0] : 0; // the cursor [next part, part count] counts only for the same content version and the same layout; otherwise the unit restarts at part 0
  return { k, n, a: k * per + 1, b: Math.min(r.lines, (k + 1) * per) };
};
const inProgress = (r, prior, bytes) => { const p = partOf(r, prior, bytes); return !!p && p.k > 0; };
// room (claude api engine): { total, cost(r) }: a unit is taken only while its whole context (part, matched tests) still fits in what is left of a call's pack, so every call finishes at least one unit's context (review F23).
// rooms = how many calls (packs) the run makes, each holding at most cap units: a unit goes into the first room it fits. A unit whose tests do not fit a whole pack ("trimmed") keeps the tests that fit in half a room (room.trim: r.packTests),
// so it cannot starve the rest. over = the units whose own part never fits.
function pick(rows, cap, prior, bytes, room = null, rooms = 1) {
  const kind = new Map(), picked = [], over = [], trimmed = [], slots = [], roomOf = new Map(), max = cap * rooms;
  const open = (c) => slots.find((s) => s.n < cap && c <= s.left), fresh = (left) => { const s = { left, n: 0 }; slots.push(s); return s; };
  const afford = (r) => {
    if (!room) return true;
    let c = room.cost(r), t = null;
    if (c > room.total) { // the tests do not fit a whole pack: the unit is reviewed with the tests that fit in half a room and recorded unsure (the pack lists the rest as cut)
      if (room.cost(r, false) > room.total) { if (!over.includes(r)) over.push(r); return false; }
      t = room.trim(r); c = t.cost;
    }
    const s = open(c) || (slots.length < rooms && fresh(room.total));
    if (!s) return false;
    if (t) { r.packTests = t.tests; trimmed.push(r); }
    s.left -= c; s.n++; roomOf.set(r.id, slots.indexOf(s));
    return true;
  };
  const out = (tally) => ({ picked, kind, over, trimmed, tally, roomOf });
  if (!prior) { for (const r of rows) if (picked.length < max && afford(r)) { kind.set(r.id, 'n'); picked.push(r); } return out({ c: 0, s: 0, n: picked.length, o: 0 }); }
  const st = new Map(prior.blocks.map((b) => [b.cid, b])), when = (r) => (st.get(r.id).at || {}).date || '';
  const take = (list, k) => { for (const r of list) if (picked.length < max && !kind.has(r.id) && afford(r)) { kind.set(r.id, k); picked.push(r); } };
  take(rows.filter((r) => st.has(r.id) && ((st.get(r.id).status === 'gap' && st.get(r.id).runs === 1) || inProgress(r, prior, bytes))), 'c'); // confirming, or continuing a unit reviewed in parts
  take(rows.filter((r) => st.has(r.id) && staleUnit(r, prior)), 's');
  take(rows.filter((r) => !st.has(r.id)), 'n');
  take(rows.filter((r) => st.has(r.id)).sort((a, b) => (when(a) < when(b) ? -1 : when(a) > when(b) ? 1 : 0)), 'o'); // stable: ties keep the risk order
  const tally = { c: 0, s: 0, n: 0, o: 0 };
  for (const k of kind.values()) tally[k]++;
  return out(tally);
}

// files: lsTree entries at head; skip(path): not evidence (documents, data, vendored, rule files); scope: scan_paths predicate or null; testPaths: test_paths. -> { rows, picked, ... } (rows by risk).
function inventory({ cwd, head, files = lsTree(cwd, head), skip = () => false, scope = null, testPaths = '', maxUnits = 12, rooms = 1, prior = null, now = Date.now(), budgetMs = BUDGET_MS, packBytes = 0, maxRead = MAX_UNITS_READ }) {
  const dl = makeClock(budgetMs), limits = [], tscope = testScope(testPaths);
  const inScope = files.filter((e) => !skip(e.path)); // read repo-wide: scope only picks the units, their tests may live outside it
  const isTest = (p) => (tscope ? tscope(p) : isTestPath(p));
  const testEntries = inScope.filter((e) => isTest(e.path)), tests = testEntries.map((e) => e.path).sort();
  let cand = inScope.filter((e) => (!scope || scope(e.path)) && !isTest(e.path) && !isTestPath(e.path) && CODE.test(e.path) && !NOT_UNIT.test(e.path) && !TEST_INFRA.test(e.path)).sort((a, b) => (a.path < b.path ? -1 : 1));
  const big = cand.filter((e) => e.size > MAX_FILE); // the largest files are often the most complex: say so, never drop them silently
  if (big.length) limits.push(`${big.length} source file(s) over 512 KiB were not inventoried: ${big.slice(0, 3).map((e) => e.path).join(', ')}${big.length > 3 ? ', ...' : ''}`);
  cand = cand.filter((e) => e.size <= MAX_FILE);
  const capped = Math.max(0, cand.length - maxRead); // files past the read cap, never reached
  if (cand.length > maxRead) { limits.push(`only the first ${maxRead} of ${cand.length} source files were inventoried (narrow with scan_paths)`); cand = cand.slice(0, maxRead); }
  const units = [], srcImports = new Map(); // path -> the relative imports of its text (units and read tests)
  const shaOf = new Map(files.map((e) => [e.path, e.sha]));
  let reached = 0; // reached: files whose chunk was read before the time budget ended
  for (let i = 0; i < cand.length && !dl.over(); i += 300) {
    const part = cand.slice(i, i + 300), bufs = catBatch(cwd, part.map((e) => e.sha));
    reached = Math.min(cand.length, i + 300);
    part.forEach((e, k) => {
      if (!bufs[k] || bufs[k].subarray(0, 8192).includes(0)) return;
      const ls = bufs[k].toString('utf8').split('\n').map((l) => l.replace(/\r$/, ''));
      const n = loc(ls);
      if (n >= MIN_LOC) { srcImports.set(e.path, importShas(e.path, ls.join('\n'), shaOf)); const d = publicDefs(e.path, ls); units.push({ id: sha8(e.path), path: e.path, loc: n, pub: d.count, names: d.names, size: bufs[k].length, lines: ls.length - (ls[ls.length - 1] === '' ? 1 : 0) }); }
    });
  }
  if (dl.over() && units.length < cand.length) limits.push(`the inventory time budget ended after ${units.length} of ${cand.length} source files`);
  // tests: text read once (capped); words that are a unit's file stem indexed for the "mentions" tier, calls of a unit's public names for the "calls" tier
  const stems = new Set(units.map((u) => noExt(u.path)).filter((s) => s.length >= 3 && !GENERIC.has(s.toLowerCase()) && /^[\w$]+$/.test(s)));
  const names = new Set(units.flatMap((u) => u.names)), sig = new Map(), mention = new Map(), called = new Map();
  let bytes = 0, readN = 0;
  const readable = testEntries.filter((e) => e.size <= TEST_FILE).sort((a, b) => (a.path < b.path ? -1 : 1));
  for (let i = 0; i < readable.length && readN < MAX_TESTS_READ && bytes < TEST_TOTAL && !dl.over(); i += 300) {
    const part = readable.slice(i, i + 300), bufs = catBatch(cwd, part.map((e) => e.sha));
    part.forEach((e, k) => {
      if (!bufs[k] || readN >= MAX_TESTS_READ || bufs[k].subarray(0, 8192).includes(0)) return;
      readN++; bytes += bufs[k].length;
      const src = bufs[k].toString('utf8');
      sig.set(e.path, testSignals(src)); srcImports.set(e.path, importShas(e.path, src, shaOf));
      for (const w of new Set(src.match(/[A-Za-z_$][\w$]*/g) || [])) if (stems.has(w)) { if (!mention.has(w)) mention.set(w, []); mention.get(w).push(e.path); }
      for (const w of new Set(src.match(/[A-Za-z_$][\w$]*(?=\s*\()/g) || [])) if (names.has(w)) { if (!called.has(w)) called.set(w, []); called.get(w).push(e.path); }
    });
  }
  const unread = tests.length - sig.size;
  if (unread > 0) limits.push(`${unread} of ${tests.length} test files were not read (over the size, count or time limit): their assertions are unknown, and a unit they alone cover may be missed`);
  const hist = history(cwd, now);
  if (!hist) limits.push('no git history (shallow clone? use fetch-depth: 0): churn and fix commits are not used in the ranking');
  const notReachedTime = cand.length - reached;
  const none = { tests: 0, noAssert: 0, skipped: 0, asserts: 0, weak: [] };
  const index = indexTests(tests);
  const rows = units.map((u) => {
    const got = [...mapTests(u.path, { tests, index, names: u.names, calls: (n) => called.get(n) || [], mentions: (s) => mention.get(s) || [], per: PER_UNIT_TESTS }).keys()];
    const ss = got.map((t) => sig.get(t) || none), sum = (f) => ss.reduce((a, s) => a + f(s), 0);
    const s = { tests: sum((x) => x.tests), noAssert: sum((x) => x.noAssert), skipped: sum((x) => x.skipped), asserts: sum((x) => x.asserts), weak: got.flatMap((t) => (sig.get(t) || none).weak.map((w) => ({ ...w, path: t }))), unread: got.filter((t) => !sig.has(t)).length };
    const h = (hist && hist.get(u.path)) || { churn: 0, fixes: 0 }, factor = factorOf(got, got.some((t) => !sig.has(t)) ? { ...s, asserts: Math.max(s.asserts, 1) } : s); // a test file that was not read is assumed to assert
    const why = [!got.length && 'no test', s.skipped && `${s.skipped} skipped test${s.skipped === 1 ? '' : 's'}`, s.noAssert && `${s.noAssert} test${s.noAssert === 1 ? '' : 's'} without an assertion`, s.weak.length && `${s.weak.length} weak assertion${s.weak.length === 1 ? '' : 's'}`,
      h.fixes && `${h.fixes} fix commit${h.fixes === 1 ? '' : 's'} in ${DAYS} days`, !h.fixes && h.churn >= 3 && `${h.churn} commits in ${DAYS} days`].filter(Boolean).join(', ') || `${u.pub} public definition${u.pub === 1 ? '' : 's'}`;
    const seen = [u.path, ...got].map((p) => `${p}:${shaOf.get(p) || ''}`).join('\n'), deps = [...new Set([u.path, ...got].flatMap((p) => srcImports.get(p) || []))].sort().join('\n');
    const verLegacy = sha8(seen), ver = deps ? sha8(`${seen}\n${deps}`) : verLegacy; // what a review of this unit saw: its blob, its matched tests' blobs, and the blobs they import (helpers, fixtures, the unit's own dependencies)
    return { ...u, churn: h.churn, fixes: h.fixes, tests: got, factor, signals: s, why, ver, verLegacy, score: risk({ ...u, ...h, factor }) };
  }).sort((a, b) => b.score - a.score || (a.path < b.path ? -1 : 1));
  const size = partBytes(packBytes, maxUnits), tsize = new Map(testEntries.map((e) => [e.path, e.size]));
  const tcost = (t) => Math.ceil(Math.min(tsize.get(t) || 0, fileCap(packBytes)) * 1.15) + 300;
  // what a unit costs in the pack: its part (or whole file) and its matched tests, line-numbered (about 15% more) plus a block header each; 90% of the pack, the rest is markup and neighbours
  const room = packBytes ? { total: Math.floor(packBytes * 0.9), cost: (r, withTests = true) => { const p = partOf(r, prior, size); return Math.ceil(shownOf(r, size) / (p ? p.n : 1)) + 300 + (withTests ? r.tests : []).reduce((n, t) => n + tcost(t), 0); } } : null;
  if (room) room.trim = (r) => { let left = Math.min(Math.floor(room.total / 2), room.total - room.cost(r, false)); const tests = r.tests.filter((t) => tcost(t) <= left && (left -= tcost(t), true)); return { tests, cost: room.cost(r, false) + tests.reduce((n, t) => n + tcost(t), 0) }; }; // a trimmed unit's tests get at most half a room, in priority order
  const calls = room ? Math.max(1, rooms) : 1; // rooms: the run's unit calls (claude api engine); maxUnits applies to each
  let sel = pick(rows, maxUnits, prior, size, room, calls);
  let forced = []; // nothing fits: the fallback ignores the part cursors, so a unit unfinished in parts does not take the single place again
  if (room && !sel.picked.length && rows.length) { sel = pick(rows, 1, prior && { ...prior, versions: { ...prior.versions, uc: {} } }, size); forced = sel.picked.map((r) => r.id); limits.push('no unit fits the context pack with its matched tests; the scan reviews the first one and its tests may be cut; it is recorded as reviewed in part (unsure), so the next run moves on'); }
  if (sel.over.length) limits.push(`${sel.over.length} unit${sel.over.length === 1 ? '' : 's'} (${sel.over.slice(0, 3).map((r) => r.path).join(', ')}${sel.over.length > 3 ? ', ...' : ''}) cannot fit the context pack with their matched tests and ${sel.over.length === 1 ? 'is' : 'are'} not reviewed`);
  const trimmed = sel.trimmed.filter((r) => sel.picked.includes(r));
  if (trimmed.length) limits.push(`${trimmed.length} unit${trimmed.length === 1 ? '' : 's'} (${trimmed.slice(0, 3).map((r) => r.path).join(', ')}${trimmed.length > 3 ? ', ...' : ''}) ${trimmed.length === 1 ? "has" : "have"} matched tests that cannot fit the context pack whole: reviewed with the tests that fit, recorded unsure`);
  const chosen = new Set(sel.picked.map((r) => r.id));
  const distinct = (rs) => [...new Set(rs.flatMap((r) => r.tests))].map((t) => sig.get(t) || none);
  const tot = (ss) => ({ skipped_tests: ss.reduce((a, s) => a + s.skipped, 0), tests_without_assertion: ss.reduce((a, s) => a + s.noAssert, 0), weak_assertions: ss.reduce((a, s) => a + s.weak.length, 0) });
  const known = new Set(prior ? prior.blocks.map((b) => b.cid) : []), reviewed = new Set([...rows.filter((r) => known.has(r.id)).map((r) => r.id), ...chosen]);
  const rotation = { rotate: !!prior, picked: sel.picked.length, confirming: sel.tally.c, changed: sel.tally.s, new: sel.tally.n, oldest: sel.tally.o, reviewed: reviewed.size, total: rows.length, run: Math.max(1, Math.ceil(reviewed.size / (maxUnits * calls))), runs: Math.max(1, Math.ceil(rows.length / (maxUnits * calls))) };
  const date = (r) => (prior && (prior.blocks.find((b) => b.cid === r.id) || {}).at || {}).date;
  for (const r of sel.picked) { const p = partOf(r, prior, size); if (p) r.part = p; }
  const unitRooms = []; // the picked unit ids per call, in risk order
  for (const r of sel.picked) (unitRooms[(sel.roomOf && sel.roomOf.get(r.id)) || 0] ||= []).push(r.id);
  return { rows, picked: sel.picked, unitRooms: unitRooms.filter(Boolean), unitCalls: calls, forced, carried: rows.filter((r) => known.has(r.id) && !chosen.has(r.id)), limitations: limits, shallow: !hist, rotation,
    totals: { eligible: rows.length + big.length + capped + notReachedTime, not_reached: capped + notReachedTime, not_reached_cap: capped, not_reached_time: notReachedTime, units: rows.length, not_inventoried: big.length, with_tests: rows.filter((r) => r.tests.length).length, without_tests: rows.filter((r) => !r.tests.length).length, ...tot(distinct(rows)), selected: { units: sel.picked.length, without_tests: sel.picked.filter((r) => !r.tests.length).length, ...tot(distinct(sel.picked)) } },
    stale: rows.filter((r) => known.has(r.id) && !chosen.has(r.id) && staleUnit(r, prior)).map((r) => r.id),
    review: (r) => (chosen.has(r.id) ? 'this run' : known.has(r.id) ? `reviewed ${date(r) || 'earlier'}${staleUnit(r, prior) ? '; changed since, due again' : ''}` : 'not yet reviewed') };
}

// audit-units.txt (id, path, risk, why, matched tests, leads: tab separated), audit-units-carried.txt (id, path: units the state knows that this run does not review), audit-inventory.json.
function write(ctx, head, maxUnits, inv) {
  const w = (n, s) => fs.writeFileSync(path.join(ctx, n), s), flat = (s) => String(s).replace(/[\t\r\n]+/g, ' ');
  w('audit-units.txt', inv.picked.map((r) => [r.id, r.path, r.score, r.why, r.tests.join(', ') || 'none', r.signals.weak.slice(0, LEADS).map((x) => `weak? ${x.path}:${x.line}`).join('; ') || '-', r.ver, r.part ? `part ${r.part.k + 1}/${r.part.n} lines ${r.part.a}-${r.part.b}` : '-', ...(r.packTests ? [r.packTests.join(', ') || '-'] : [])].map(flat).join('\t') + '\n').join(''));
  if (inv.unitRooms && inv.unitRooms.length > 1) w('audit-unit-rooms.json', JSON.stringify(inv.unitRooms)); // more than one call: scan-parts.js makes one unit part per room
  w('audit-units-carried.txt', inv.carried.map((r) => `${r.id}\t${flat(r.path)}\n`).join(''));
  w('audit-inventory.json', JSON.stringify({ head, max_units: maxUnits, ...(inv.unitCalls > 1 && { unit_calls: inv.unitCalls }), ...inv.totals, rotation: inv.rotation, shallow: inv.shallow, limitations: inv.limitations,
    rows: inv.rows.slice(0, ROWS_KEPT).map((r) => ({ id: r.id, path: r.path, score: r.score, why: r.why, tests: r.tests, loc: r.loc, public: r.pub, churn: r.churn, fixes: r.fixes, review: inv.review(r), signals: { tests: r.signals.tests, noAssert: r.signals.noAssert, skipped: r.signals.skipped, asserts: r.signals.asserts, weak: r.signals.weak.length, unread: r.signals.unread } })),
    forced: inv.forced, // picked although it cannot fit the pack: the publisher records it as unsure even when its tests were cut, so the rotation moves on
    unreviewed: inv.rows.filter((r) => inv.review(r) === 'not yet reviewed').slice(0, 30).map((r) => ({ id: r.id, path: r.path, score: r.score })) }) + '\n');
}

// Rule-based leads from the per-unit signals (rows of inventory() or of audit-inventory.json; a row without `signals` is skipped): at most one per row, never a model claim.
// test_evidence_not_found = the test SEARCH found nothing (not a confirmed missing test); weak_test_signal = matched tests that cannot protect much. A test file that was not read is assumed to assert (as inventory() does for the factor).
function staticFindings(rows) {
  const out = [], n = (k, one, many = `${one}s`) => `${k} ${k === 1 ? one : many}`;
  for (const r of rows || []) {
    const s = r && r.signals;
    if (!s) continue;
    const base = { unit: r.id, path: r.path };
    if (!(r.tests || []).length) { out.push({ ...base, kind: 'test_evidence_not_found', why: 'the test search found no matching test file (not a confirmed missing test)' }); continue; }
    const weak = Array.isArray(s.weak) ? s.weak.length : s.weak || 0, asserts = s.unread ? Math.max(s.asserts, 1) : s.asserts;
    if (s.noAssert > 0 || s.skipped > 0 || weak * 2 >= asserts) out.push({ ...base, kind: 'weak_test_signal', why: [s.noAssert && `${n(s.noAssert, 'test')} without an assertion`, s.skipped && `${s.skipped} skipped`, weak && n(weak, 'weak assertion'), asserts === 0 && 'no assertions'].filter(Boolean).join(', ') });
  }
  return out;
}

module.exports = { staticFindings, inventory, write, pick, risk, factorOf, publicCount, testSignals, history, sha8, DAYS };
