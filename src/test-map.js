// Source file -> the existing test files most likely to cover it. One mapping for the PR review (collect.sh, test-candidates.txt) and the code-first scan (audit-units.js).
// Up to `per` tests, in tiers: same basename stem with test/spec affixes (any directory) > a test file name that contains one of the unit's public names as a token (test/res.status.js for
// `res.status = function`) > tests that call two or more of those names > tests that mention the stem as a whole word (imports, references) > tests in the same directory (at most 5).
// ponytail: names and word searches only, no per-language import parsing; a test that reaches the code through an index or a differently named module is missed (the unit then reads as untested).
// Also here: the literal guard for missing_test claims (makeCoverGuard): a test file that already contains the claim's error message is a reason to doubt it.
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { declName, GENERIC: NAME_GENERIC } = require('./leads');

const key = (s) => s.toLowerCase().replace(/[-_.]/g, '');
const noExt = (p) => path.posix.basename(p).replace(/\.[^.]*$/, '');
// FooTest -> foo, foo_test -> foo, foo.spec -> foo, test_foo -> foo, FooTests -> foo; a stem without affix stays (tests/foo.py, test/foo.js)
const testStem = (p) => key(noExt(p).replace(/^tests?[_-]/i, '').replace(/[._-]?(tests?|spec)$/i, ''));
const near = (a, b) => { const x = path.posix.dirname(a).split('/'), y = path.posix.dirname(b).split('/'); let i = 0; while (i < x.length && x[i] === y[i]) i++; return i; };
// the reason text of a hunk-tier candidate in test-candidates.txt; focus.js parseCandidates({ skipHunk }) matches on it
const HUNK_REASON = 'mentions changed ';
const GENERIC = new Set(['index', 'main', 'mod', 'init', '__init__', 'lib', 'app', 'utils', 'util', 'types']);
const dirKey = (t) => path.posix.dirname(t).replace(/\/__tests__$/, '');
const comment = (l) => /^\s*(?:\/\/|#|\*|\/\*|--)/.test(l);
const usableName = (n) => n.length >= 4 && /^[A-Za-z_$][\w$]*$/.test(n) && !NAME_GENERIC.has(n.toLowerCase());
// a property defined by name: `defineGetter(req, 'fresh', function`, `Object.defineProperty(exports, 'name', {`
const DEFINE = /^\s*(?:Object\.)?define\w*\(\s*[\w$.]+\s*,\s*['"]([A-Za-z_$][\w$]*)['"]/;

// Public top-level definitions per language, one regex list per family: pub = what the language calls public, top = the fallback (top-level functions) when nothing is public.
// ponytail: line regexes, no parser. A JS `module.exports = { a, b }` counts as one, a Ruby `private` section or a Python `__all__` is not seen; the count only weights the risk (log-free, so a very large file dominates: cap it with scan_paths).
const FAMILY = {
  js: { pub: [DEFINE, /^\s*export\s+(?!\*)/, /^\s*(?:module\.)?exports\.\w+\s*=/, /^\s*module\.exports\s*=/, /^\w+(?:\.\w+)+\s*=\s*(?:\w+(?:\.\w+)+\s*=\s*)*(?:async\s+)?function\b/], top: [/^(?:async\s+)?function\b/, /^(?:const|let|var)\s+\w+\s*=\s*(?:async\s*)?(?:function\b|\(.*\)\s*=>|\w+\s*=>)/] },
  py: { pub: [/^(?:async\s+def|def|class)\s+(?!_)\w/], top: [/^(?:async\s+)?def\s/] },
  go: { pub: [/^func\s+(?:\([^)]*\)\s*)?[A-Z]/, /^type\s+[A-Z]/], top: [/^func\s/] },
  java: { pub: [/^\s*public\s/], top: [/^\s*(?:static\s+|private\s+|protected\s+|internal\s+)+[\w<>\[\],?]+\s+\w+\s*\(/] },
  kt: { pub: [/^\s*(?!.*\b(?:private|internal|protected)\b)(?:(?:open|data|suspend|override|abstract|sealed|inline|enum)\s+)*(?:fun|class|object|interface)\s/], top: [/^\s*(?:private\s+|internal\s+)?fun\s/] },
  scala: { pub: [/^\s*(?!.*\b(?:private|protected)\b)(?:(?:case|abstract|sealed|final|override|implicit)\s+)*(?:def|class|object|trait)\s/], top: [/^\s*def\s/] },
  rs: { pub: [/^\s*pub(?:\([^)]*\))?\s+(?:async\s+|unsafe\s+|const\s+)*(?:fn|struct|enum|trait|type|mod)\b/], top: [/^\s*(?:async\s+)?fn\s/] },
  rb: { pub: [/^\s*def\s+(?!_)\S/], top: [/^\s*def\s/] },
  swift: { pub: [/^\s*(?:public|open)\s/], top: [/^\s*(?:private\s+|fileprivate\s+)?func\s/] },
};
const EXT = { js: 'js', jsx: 'js', mjs: 'js', cjs: 'js', ts: 'js', tsx: 'js', mts: 'js', cts: 'js', py: 'py', go: 'go', java: 'java', cs: 'java', php: 'java', kt: 'kt', scala: 'scala', rs: 'rs', rb: 'rb', swift: 'swift' };
// `res.status = function`, `req.get = req.header = function`: every name assigned; `exports.x =`; else the declared name of the line
const ASSIGN = /^((?:\w+(?:\.\w+)+\s*=\s*)+)(?:async\s+)?(?:function\b|\(.*\)\s*=>|\w+\s*=>)/;
const namesOf = (l) => {
  const g = DEFINE.exec(l); if (g) return [g[1]];
  const m = ASSIGN.exec(l), e =/^\s*(?:module\.)?exports\.(\w+)\s*=/.exec(l), d = !m && !e && declName(l);
  return m ? [...m[1].matchAll(/(\w+)\s*=/g)].map((x) => x[1]) : e ? [e[1]] : d ? [d] : [];
};
// ls: the file's lines -> { count: public definitions (or top-level functions when none is public), names: their names }
function publicDefs(file, ls) {
  const fam = FAMILY[EXT[path.extname(file).slice(1).toLowerCase()]];
  if (!fam) return { count: 0, names: [] };
  const body = ls.filter((l) => !comment(l)), hit = (res) => body.filter((l) => res.some((re) => re.test(l)));
  const pub = hit(fam.pub), use = pub.length ? pub : hit(fam.top);
  return { count: use.length, names: [...new Set(use.flatMap(namesOf))] };
}

// tests by stem, by folder and by file-name token: built once when many files are mapped (the scan maps thousands against thousands of tests)
function indexTests(tests) {
  const byStem = new Map(), byDir = new Map(), byToken = new Map(), put = (m, k, t) => { if (!m.has(k)) m.set(k, []); m.get(k).push(t); };
  for (const t of tests) {
    put(byStem, testStem(t), t); put(byDir, dirKey(t), t);
    for (const tok of new Set(noExt(t).toLowerCase().split(/[._-]+/))) if (tok) put(byToken, tok, t);
  }
  return { byStem, byDir, byToken };
}

// ---- tokens of the changed hunks ----
// Tests name the option or literal a diff changes (`bodyLimit`), not the file stem. Identifier-like tokens (camelCase, snake_case, numbers of >= 5 digits) of a file's added and removed lines are searched in
// the test files with one batched git grep; a token in more than MAX_DF test files says nothing and is dropped. A test scores idf * (1 + log count) per token, +100 when its stem is the token.
// ponytail: whole-word, case-sensitive text matches; no scope check, so a test that only shares a literal can rank (3 per file at most, after the name tiers).
const MAX_DF = 25, TOKENS_PER_FILE = 40, TOKENS_PER_PR = 200, HUNK_TOP = 3;
// unified diff (-U0) text -> Map(file -> tokens, in order of appearance)
function hunkTokens(diff) {
  const out = new Map(); let cur = null;
  for (const l of diff.split('\n')) {
    const h = /^\+\+\+ b\/(.+)$/.exec(l);
    if (h) { cur = new Set(); out.set(h[1], cur); continue; }
    if (/^(diff --git |\+\+\+ \/dev\/null$)/.test(l)) { cur = null; continue; } // a deleted file's `+++ /dev/null` names no file: its removed lines are dropped, not attributed to the previous file
    if (!cur || !/^[+-]/.test(l) || /^(\+\+\+|---) /.test(l)) continue;
    for (const m of l.slice(1).matchAll(/[A-Za-z_$][\w$]{5,}|\b\d{5,}\b/g)) if (/^\d+$/.test(m[0]) || /[a-z][A-Z]|_/.test(m[0])) cur.add(m[0]);
  }
  return new Map([...out].map(([f, s]) => [f, [...s]]));
}
// files: the changed files to map; diff: their -U0 diff; grepOut(tokens) -> `git grep -o -w -F` output (path:match lines; throws on a timeout); tests: Set of test paths
// -> { byFile: Map(file -> [[test, [tokens]], ...] best first), limits: [text] }
function hunkTests(files, diff, grepOut, tests) {
  const all = hunkTokens(diff), limits = [], pick = new Map(); let total = 0, cutFile = 0, cutPr = 0;
  for (const f of files) {
    let toks = all.get(f) || [];
    if (toks.length > TOKENS_PER_FILE) { cutFile++; toks = toks.slice(0, TOKENS_PER_FILE); }
    if (total + toks.length > TOKENS_PER_PR) { cutPr++; toks = toks.slice(0, Math.max(0, TOKENS_PER_PR - total)); }
    total += toks.length; if (toks.length) pick.set(f, toks);
  }
  if (cutFile) limits.push(`${cutFile} changed file(s) have more than ${TOKENS_PER_FILE} identifiers in their hunks: only the first ${TOKENS_PER_FILE} were searched in the tests.`);
  if (cutPr) limits.push(`More than ${TOKENS_PER_PR} changed identifiers in this PR: the rest were not searched in the tests.`);
  const byFile = new Map(), uniq = [...new Set([...pick.values()].flat())];
  if (!uniq.length) return { byFile, limits };
  const count = new Map(); // token -> Map(test -> hits)
  try {
    for (const l of grepOut(uniq).split('\n')) {
      const i = l.lastIndexOf(':'), p = l.slice(0, i), tok = l.slice(i + 1);
      if (i < 0 || !tests.has(p)) continue;
      if (!count.has(tok)) count.set(tok, new Map());
      count.get(tok).set(p, (count.get(tok).get(p) || 0) + 1);
    }
  } catch (e) {
    if (e.status !== 1) limits.push(`The search for changed identifiers in the tests failed or timed out (${e.code || 'exit ' + e.status}): tests were not ranked by what the diff changes.`); // status 1: no match at all
    return { byFile, limits };
  }
  const stems = new Map([...tests].map((t) => [t, testStem(t)]));
  for (const [f, toks] of pick) {
    const score = new Map(), why = new Map();
    for (const tok of toks) {
      const hits = count.get(tok); if (!hits || hits.size > MAX_DF) continue;
      const idf = Math.log(1 + tests.size / hits.size);
      for (const [t, c] of hits) {
        score.set(t, (score.get(t) || 0) + idf * (1 + Math.log(c)) + (stems.get(t) === key(tok) && !/^\d+$/.test(tok) ? 100 : 0));
        if (!why.has(t)) why.set(t, []); why.get(t).push(tok);
      }
    }
    const top = [...score].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, HUNK_TOP).map(([t]) => [t, why.get(t)]);
    if (top.length) byFile.set(f, top);
  }
  return { byFile, limits };
}

// tests: every test path; changed: [[test, [changed identifiers]]] best first (hunkTests; optional); mentions(stem) -> test paths that name the stem as a whole word (the caller's search: git grep, or an index); names: the unit's public names (publicDefs);
// calls(name) -> test paths that call that name (optional) -> Map(test path -> why), at most `per`.
function mapTests(f, { tests, mentions, changed = [], names = [], calls = null, per = 5, index = indexTests(tests) }) {
  const stem = noExt(f), want = key(stem), dir = path.posix.dirname(f), got = new Map();
  const add = (list, why, limit = per) => { for (const t of list.slice().sort((a, b) => near(f, b) - near(f, a) || (a < b ? -1 : 1))) if (got.size < limit && !got.has(t)) got.set(t, typeof why === 'function' ? why(t) : why); };
  // more names first, then a file name that also starts like the unit (res.status.js for response.js), then a shallower path
  const kin = (t) => noExt(t).toLowerCase().split(/[._-]+/).filter((k) => k.length >= 2 && stem.toLowerCase().startsWith(k)).length;
  const ranked = (hits) => [...hits.keys()].sort((a, b) => hits.get(b).size - hits.get(a).size || kin(b) - kin(a) || a.split('/').length - b.split('/').length || near(f, b) - near(f, a) || (a < b ? -1 : 1));
  const pub = [...new Set(names.filter(usableName))];
  add(index.byStem.get(want) || [], 'same name');
  const inName = new Map(), called = new Map(); // test -> the public names in its file name / that it calls
  for (const n of pub) for (const t of index.byToken.get(n.toLowerCase()) || []) { if (!inName.has(t)) inName.set(t, new Set()); inName.get(t).add(n); }
  const label = (verb, hits) => (t) => `${verb} ${[...hits.get(t)].slice(0, 3).join(', ')}`;
  for (const t of ranked(inName)) add([t], label('file name has', inName));
  if (calls) {
    for (const n of pub) for (const t of calls(n)) { if (!called.has(t)) called.set(t, new Set()); called.get(t).add(n); }
    for (const t of ranked(called)) if (called.get(t).size >= 2) add([t], label('calls', called));
  }
  for (const [t, toks] of changed) add([t], `${HUNK_REASON}${toks.slice(0, 3).map((x) => '`' + x + '`').join(', ')}`);
  // a stem that most tests name (route, fastify) says nothing and would fill a capped list in path order; an uncapped caller (the scan) keeps them all
  if (got.size < per && stem.length >= 3 && !GENERIC.has(stem.toLowerCase())) { const m = mentions(stem); if (per === Infinity || m.length <= MAX_DF) add(m, `mentions ${stem}`); }
  add(index.byDir.get(dir) || [], 'same directory', Math.min(per, 5));
  return got;
}

// ---- literal guard for missing_test claims ----
// Strings of >= 10 characters with letters on the cited line and 2 lines each way: template holes (${x}, {}, %s) split them into static runs; each run and each 3-word window of it (>= 14 characters)
// is a needle. A tracked test file that contains one (fixed string, case-insensitive) may already cover the claim, so does a test line with the thrown error class and the enclosing method name.
// ponytail: a text search, not a proof: a message that is also a common phrase can downgrade a real gap to low confidence (never the reverse); the finding stays in Details with the test it found.
const STR = /'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g;
const HOLE = /\$\{[^}]*\}|#\{[^}]*\}|\{\{[^}]*\}\}|\{[\w.]*\}|%\([^)]*\)[a-z]|%[-+ 0#]*\d*(?:\.\d+)?[a-zA-Z]/g;
const THROWN = /\b(?:throw\s+new|raise|throw)\s+([A-Z]\w*)/;
const trimEnds = (s) => s.replace(/^[^\w]+|[^\w]+$/g, '');
function needlesOf(lines, line) {
  const out = new Set();
  for (const l of lines.slice(Math.max(0, line - 3), line + 2)) {
    if (comment(l)) continue;
    for (const m of l.matchAll(STR)) {
      for (const run of (m[1] ?? m[2] ?? m[3]).split(HOLE).map((r) => r.replace(/\\(.)/g, '$1').trim())) {
        if (run.length < 10 || !/[A-Za-z]{3}/.test(run)) continue;
        const words = run.split(/\s+/);
        if (words.length <= 3) out.add(trimEnds(run));
        for (let i = 0; i + 3 <= words.length; i++) { const w = trimEnds(words.slice(i, i + 3).join(' ')); if (w.length >= 14 && /[A-Za-z]{3}/.test(w)) out.add(w); }
      }
    }
  }
  return [...out].filter((n) => n.length >= 10).sort((a, b) => b.length - a.length).slice(0, 24);
}
// the name of the definition enclosing the 1-based line (that line, then up to 60 lines up), or null; `defineGetter(req, 'fresh', function` names `fresh`
// a generator method (`public *gen(`) and an exported constant table (`export const X = {`) are definitions too; declName sees neither
const GEN = /^\s*(?:(?:public|private|protected|static|async|override|export)\s+)*\*\s*([A-Za-z_$][\w$]*)\s*[(<]/, EXPORT_CONST = /^\s*export\s+(?:declare\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)/;
function enclosingName(lines, line) {
  for (let i = Math.min(line - 1, lines.length - 1); i >= Math.max(0, line - 61); i--) { const n = (comment(lines[i]) ? [] : GEN.exec(lines[i]) || EXPORT_CONST.exec(lines[i]) || [])[1] || namesOf(lines[i].trim())[0] || declName(lines[i]); if (n && usableName(n)) return n; }
  return null;
}
// the thrown error class on the cited line (+-2) and the name of the enclosing definition (up to 60 lines up)
function classAndMethod(lines, line) {
  const cls = lines.slice(Math.max(0, line - 3), line + 2).map((l) => THROWN.exec(l)).find(Boolean);
  if (!cls) return null;
  const method = enclosingName(lines, line);
  return method ? { cls: cls[1], method } : null;
}
// Functions called on the cited line and 2 lines each way (`name(`, `obj.name(`): the claim may be about a wrapper whose delegate is tested. Names of >= 6 characters or camelCase with 2 humps, minus the enclosing definition and builtins.
// ponytail: a name list of common builtins, not a resolver; a project function named like one is missed (no hit), never invented.
const BUILTIN = new Set('assert expect require import console error debug test describe match exec split slice splice concat includes indexof startswith endswith replace replaceall tostring tolowercase touppercase padstart padend unshift foreach findindex flatmap entries values assign freeze parse stringify isarray isinteger isfinite parseint parsefloat number string boolean object array promise resolve reject settimeout setinterval cleartimeout error typeerror rangeerror symbol format normalize relative basename dirname extname existssync readfilesync writefilesync readdirsync mkdirsync unlinksync statsync lstatsync realpathsync callback emit listen handle toisostring tofixed typeof sprintf printf println errorf strlen strcmp function return catch while switch'.split(' '));
function calledNames(lines, line) {
  const own = enclosingName(lines, line), out = new Set();
  for (const l of lines.slice(Math.max(0, line - 3), line + 2)) {
    if (comment(l)) continue;
    for (const m of l.replace(STR, '""').matchAll(/(?<![\w$])(?:[\w$]+\??\.)*([A-Za-z_$][\w$]*)\s*\(/g)) {
      const n = m[1];
      if (n !== own && (n.length >= 6 || /^[a-z]+[A-Z][a-z0-9]*[A-Z]/.test(n)) && usableName(n) && !BUILTIN.has(n.toLowerCase())) out.add(n);
    }
  }
  return [...out].slice(0, 12);
}
// testPaths: test_paths text (or empty) -> (lines, line, path, eligible) => "path:line" of a tracked test file that may already cover the claim at that 1-based line of the file `lines`, or null.
// A search that fails or times out finds nothing. trace.js is required lazily: it requires post.js, which uses this guard.
function makeCoverGuard({ cwd, testPaths = '', timeout = 15000 }) {
  const { isTestPath, testScope } = require('./trace'), scope = testScope(testPaths), DOC = /\.(md|mdx|markdown|rst|adoc|txt)$/i;
  const isTest = (p) => !DOC.test(p) && (scope ? scope(p) : isTestPath(p));
  const grep = (args, only = null) => {
    try {
      const out = execFileSync('git', ['grep', '-n', '-I', '-i', '-F', ...args], { cwd, encoding: 'utf8', timeout, maxBuffer: 1 << 26, stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, GIT_LITERAL_PATHSPECS: '1' } });
      for (const l of out.split('\n')) { const m = /^(.*?):(\d+):/.exec(l); if (m && isTest(m[1]) && (!only || only.has(m[1]))) return `${m[1]}:${m[2]}`; }
    } catch {}
    return null;
  };
  // only a function this repository defines in a non-test file is a delegate (isDirectChild in src/engine/filename.ts); library and builtin methods (deepEqual, filter) are not
  const definedHere = (name) => {
    try {
      const out = execFileSync('git', ['grep', '-n', '-I', '-E', '-e', `(function|def|func|fn)[[:space:]]+${name}\\b`, '-e', `\\b${name}[[:space:]]*[:=][[:space:]]*(async[[:space:]]+)?(function\\b|\\()`,
        '-e', `export[[:space:]]+(async[[:space:]]+)?(function|const|let|class)[[:space:]]+${name}\\b`], { cwd, encoding: 'utf8', timeout, maxBuffer: 1 << 26, stdio: ['ignore', 'pipe', 'ignore'] });
      return out.split('\n').some((l) => { const m = /^(.*?):\d+:/.exec(l); return m && !isTest(m[1]) && !DOC.test(m[1]); });
    } catch { return false; }
  };
  // the first tracked test file that names `name` as a whole word (case-sensitive), "path:line", or null
  // A method that a non-test file other than `own` also defines (every Go transformer has TransformSourceFile) says nothing about this unit: no hit. A search that fails or times out is no hit either.
  const symbol = (name, own = '') => {
    try {
      const defs = execFileSync('git', ['grep', '-n', '-I', '-E', '-e', `func[[:space:]]*\\([^)]*\\)[[:space:]]*${name}\\b`, '-e', `^[[:space:]]*((public|private|protected|static|async|override)[[:space:]]+)*\\*?${name}[[:space:]]*(<[^>]*>)?\\([^;]*\\{[[:space:]]*$`], { cwd, encoding: 'utf8', timeout, maxBuffer: 1 << 26, stdio: ['ignore', 'pipe', 'ignore'] }).split('\n');
      if (defs.some((l) => { const m = /^(.*?):\d+:/.exec(l); return m && m[1] !== own && !isTest(m[1]) && !DOC.test(m[1]); })) return null;
    } catch (e) { if (e.status !== 1) return null; }
    try {
      const out = execFileSync('git', ['grep', '-n', '-I', '-w', '-F', '-e', name], { cwd, encoding: 'utf8', timeout, maxBuffer: 1 << 26, stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, GIT_LITERAL_PATHSPECS: '1' } });
      for (const l of out.split('\n')) { const m = /^(.*?):(\d+):/.exec(l); if (m && isTest(m[1])) return `${m[1]}:${m[2]}`; }
    } catch {}
    return null;
  };
  // eligible (optional): the test files that can cover this source file (its candidate tests); a hit elsewhere is an unrelated test. Empty: no candidate test, so no literal demotion (that gap is more likely real). Not passed: any tracked test counts. A delegated helper's test lives with the helper, so it is not limited by the set.
  return Object.assign((lines, line, p = '', eligible = null) => {
    if (!Array.isArray(lines) || !Number.isInteger(line)) return null;
    const only = eligible ? new Set(eligible) : null;
    const needles = needlesOf(lines, line), hit = needles.length && !(only && !only.size) ? grep(needles.flatMap((n) => ['-e', n]), only) : null, cm = hit || (only && !only.size) ? null : classAndMethod(lines, line);
    const lit = hit || (cm ? grep(['-e', cm.method, '--and', '-e', cm.cls], only) : null);
    if (lit) return lit;
    if (p && isTest(p)) return null; // a claim about a test file has no delegate to follow
    for (const name of calledNames(lines, line)) { if (!definedHere(name)) continue; const h = grep(['-w', '-e', name]); if (h) return `a delegated helper is tested: ${name} at ${h}`; }
    return null;
  }, { symbol });
}

module.exports = { mapTests, hunkTests, hunkTokens, indexTests, testStem, near, key, noExt, GENERIC, publicDefs, needlesOf, classAndMethod, enclosingName, makeCoverGuard, HUNK_REASON };
