#!/usr/bin/env node
// Deterministic leads for the two most valuable unit-test findings, so a weak model starts from facts instead of free exploration.
// Writes $CTX/leads.txt (nothing when there is nothing to say). Leads are hints the reviewer must verify; they are never findings.
//   1. Changed symbols (enclosing symbol of each hunk + symbols defined on added lines) with / without a word-bounded test reference.
//   2. Possible mirror assertions: an assertion whose EXPECTED argument is a constant taken from production code.
// ponytail: regexes per common language form, no parser. Ceiling: multi-line assertions, dynamic or aliased references, symbols whose
// definition spans lines are missed or mislabelled; a hit is "worth a look", not proof. Upgrade path: tree-sitter queries per language.
// Usage: node src/leads.js <ctx dir>   (cwd = repository at the PR head; env TEST_PATHS as for collect.sh)
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { isTestPath, testScope } = require('./trace.js');

const CAP = 5.5 * 1024, BUDGET_MS = 10000, MAX_SYMS = 40, PER_FILE = 8, MAX_TEST_FILES = 25, MAX_BYTES = 300 * 1024;
const NOT_CODE = /\.(md|mdx|markdown|rst|adoc|txt|feature|json|ya?ml|toml|lock|css|scss|less|html?|svg|xml|csv)$/i;
const GENERIC = new Set(('main init run get set handle handler render constructor tostring tojson valueof equals hashcode setup teardown start stop dispose destroy create update remove delete add apply call execute callback default index new open close load save read write build test describe it before after done').split(' '));
const KW = new Set('if else for while switch catch function return with synchronized do try finally typeof new await yield sizeof elif except lambda case default throw assert super this using lock foreach'.split(' '));

// Name declared on one source line, or null. Order matters: keyword forms, const arrow/function, modifier methods, bare `name(...) {`.
const TYPE = '[\\w$<>\\[\\],.?*&]+';
const DECLS = [
  /\b(?:function\*?|def|func|fn|fun|class|interface|struct|enum|trait|object|record|sub)\s+(?:\([^)]*\)\s*)?([A-Za-z_$][\w$]*)/,
  /\b(?:const|let|var|val)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s+)?(?:function\b|[A-Za-z_$][\w$]*\s*=>|\((?:[^()]*\)\s*(?::[^=]+)?=>|[^()]*$))/,
  new RegExp(`^\\s*(?:(?:public|private|protected|internal|static|final|abstract|async|override|virtual|export|default|synchronized|readonly|open|suspend|inline|extern)\\s+)+(?:${TYPE}\\s+)*?([A-Za-z_$][\\w$]*)\\s*\\(`),
  new RegExp(`^\\s*(?:${TYPE}\\s+)*([A-Za-z_$][\\w$]*)\\s*\\([^)]*\\)\\s*(?::\\s*[\\w$<>\\[\\]|,. ?]+\\s*)?\\{\\s*$`),
];
function declName(line) {
  if (line.length > 300 || /^\s*(\/\/|#|\*|\/\*|--)/.test(line)) return null;
  for (const re of DECLS) { const m = re.exec(line); if (m && !KW.has(m[1])) return m[1]; }
  return null;
}
const usable = (n) => n.length >= 3 && !GENERIC.has(n.toLowerCase());

// Changed hunks per file: [{ changes: [{line, text}] (added lines and removed ones, at their new-side position), added: [{line, text}], head (git funcname header) }].
function hunks(diff) {
  const out = new Map(); let file = null, h = null, n = 0, body = false;
  for (const l of diff.split('\n')) {
    if (l.startsWith('diff --git ')) { body = false; file = null; h = null; continue; }
    if (!body) {
      if (l.startsWith('+++ ')) file = l === '+++ /dev/null' ? null : l.slice(4).replace(/^b\//, '').replace(/^"|"$/g, '');
      const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@ ?(.*)$/.exec(l);
      if (m && file) { body = true; n = +m[1]; h = { changes: [], added: [], head: m[2] }; if (!out.has(file)) out.set(file, []); out.get(file).push(h); }
      continue;
    }
    const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@ ?(.*)$/.exec(l);
    if (m) { n = +m[1]; h = { changes: [], added: [], head: m[2] }; out.get(file).push(h); }
    else if (l[0] === '+') { h.added.push({ line: n, text: l.slice(1) }); h.changes.push({ line: n, text: l.slice(1) }); n++; }
    else if (l[0] === '-') h.changes.push({ line: n, text: l.slice(1) });
    else if (l[0] === ' ') n++;
  }
  return out;
}

// Symbols of one changed file: [{name, line}]. Declarations on added lines, plus the nearest declaration above each other changed line
// (code lines only: a changed comment or blank says nothing), else git's header.
const quiet = (t) => !t.trim() || /^\s*(\/\/|#|\*|\/\*|--)/.test(t);
function symbolsOf(file, hs, cwd = '.') {
  const seen = new Map(), add = (name, line) => { if (name && usable(name) && !seen.has(name)) seen.set(name, line); };
  let src = null;
  for (const h of hs) {
    for (const a of h.added) add(declName(a.text), a.line);
    let scanned = 0, any = false;
    for (const c of h.changes) {
      if (quiet(c.text) || declName(c.text) || scanned >= 40) continue;
      scanned++; any = true;
      if (src === null) { try { src = fs.statSync(path.join(cwd, file)).size <= MAX_BYTES ? fs.readFileSync(path.join(cwd, file), 'utf8').split('\n') : []; } catch { src = []; } }
      let found = null;
      for (let i = c.line - 2; i >= 0 && !found; i--) found = declName(src[i] || '') && { nm: declName(src[i]), line: i + 1 };
      if (found) add(found.nm, found.line);
    }
    if (!any && !h.added.some((a) => declName(a.text))) add(declName(h.head), h.changes[0]?.line);
  }
  return [...seen].slice(0, PER_FILE).map(([name, line]) => ({ name, line }));
}

// ---- mirror assertions ----
const UPPER = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$|^[A-Z]{3,}[0-9]*$/;
const REF = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/;
// kind: second = node/chai assert(actual, expected); first = JUnit/xunit/testify (expected first, after a leading t); either = unittest/rust; matcher = expect(x).toBe(expected)
const CALLS = [
  [/\bassert\.(?:equal|strictEqual|deepEqual|deepStrictEqual|equals|eq)\s*\(/g, 'second'],
  [/\b(?:[Aa]ssert|require)\.(?:Equal|EqualValues|Exactly|Same|Equals)\s*\(/g, 'first'],
  [/\b(?:assertEqual|assert_equal|assert_eq!)\s*\(/g, 'either'],
  [/\bassert(?:Equals|Same|ArrayEquals)\s*\(/g, 'first'],
  [/\)\s*\.(?:(?:to|be|been|is|that|not|deep)\.)*(?:toBe|toEqual|toStrictEqual|toBeCloseTo|equal|eql|isEqualTo|isSameAs)\s*\(/g, 'matcher'],
];
function args(s, open) { // top-level arguments of the call whose '(' is at s[open]; stops at the closing paren or the end of the line
  const out = []; let d = 0, q = null, cur = '';
  for (let i = open + 1; i < s.length; i++) {
    const c = s[i];
    if (q) { cur += c; if (c === '\\') cur += s[++i] ?? ''; else if (c === q) q = null; continue; }
    if (c === '"' || c === "'" || c === '`') { q = c; cur += c; continue; }
    if ('([{'.includes(c)) d++;
    else if (')]}'.includes(c)) { if (d === 0) break; d--; }
    if (c === ',' && d === 0) { out.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
function expectedArgs(line) {
  for (const [re, kind] of CALLS) {
    re.lastIndex = 0;
    const m = re.exec(line);
    if (!m) continue;
    let a = args(line, m.index + m[0].length - 1);
    if (kind === 'first' && /^(t|b|tb)$/.test(a[0] || '')) a = a.slice(1);
    return kind === 'second' ? a.slice(1, 2) : kind === 'either' ? a.slice(0, 2) : a.slice(0, 1);
  }
  const m = /^\s*assert\s+.*?==\s*([^=,]+?)\s*(?:,.*)?$/.exec(line); // pytest: assert f(x) == CONST
  return m ? [m[1]] : [];
}
// Names the test file brings in from elsewhere (JS import/require, Python from-import, Go packages) and names it defines itself.
function imports(src) {
  const names = new Set();
  for (const m of src.matchAll(/\bimport\s*(?:type\s+)?\{([^}]*)\}\s*from|\b(?:const|let|var)\s*\{([^}]*)\}\s*=\s*require|\bfrom\s+[\w.]+\s+import\s+\(?([^\n)]*)/g))
    for (const part of (m[1] || m[2] || m[3]).split(',')) { const n = part.trim().split(/\s+as\s+|\s*:\s*/).pop(); if (/^[A-Za-z_$][\w$]*$/.test(n)) names.add(n); }
  for (const m of src.matchAll(/\bimport\s+\*\s+as\s+(\w+)|\bimport\s+(\w+)\s+from|^\s*(?:import\s+)?(?:(\w+)\s+)?"([\w./@-]+)"\s*$/gm)) names.add(m[1] || m[2] || m[3] || m[4].split('/').pop());
  return names;
}
const definedLocally = (src, n) => new RegExp(`(?:\\b(?:const|let|var|val|final|static|int|long|double|float|String)\\b[^;=\\n]*\\b|^\\s*|#define\\s+)${n.replace(/\$/g, '\\$')}\\s*(?::[^=\\n]+)?=(?!=)`, 'm').test(src);

// -> [{line, name}] candidates in one test file; `later` checks each name against production code.
function mirrorCandidates(src) {
  const imp = imports(src), out = [];
  src.split('\n').slice(0, 4000).forEach((text, i) => {
    if (text.length > 400) return;
    for (const e of expectedArgs(text)) {
      if (!REF.test(e)) continue;
      const parts = e.split('.'), tail = parts[parts.length - 1];
      const ok = parts.length === 1 ? (UPPER.test(e) || imp.has(e)) && !definedLocally(src, e) : UPPER.test(tail) || (imp.has(parts[0]) && /^[A-Z]/.test(tail) && parts.length === 2);
      if (ok) out.push({ line: i + 1, name: e, tail });
    }
  });
  return out;
}

function run(ctx, { cwd = process.cwd(), env = process.env, now = Date.now } = {}) {
  const t0 = now(), left = () => Math.max(1000, BUDGET_MS - (now() - t0));
  const lines = (f) => { try { return fs.readFileSync(path.join(ctx, f), 'utf8').split('\n').map((l) => l.replace(/\r$/, '')).filter(Boolean); } catch { return []; } };
  const git = (a) => execFileSync('git', a, { cwd, encoding: 'utf8', timeout: left(), maxBuffer: 1 << 27, stdio: ['ignore', 'pipe', 'ignore'] });
  const tracked = git(['ls-files', '-z']).split('\0').filter((p) => p && !/[\x00-\x1F]/.test(p));
  const scope = testScope(env.TEST_PATHS);
  const isTest = scope ? (p) => scope(p) && !/\.(md|mdx|markdown|rst|adoc|txt)$/i.test(p) : isTestPath;
  const testSet = new Set(tracked.filter(isTest));
  const grep = (names) => { // name -> Set(path) of tracked files naming it as a whole word; null when the search failed
    const hit = new Map(names.map((n) => [n, new Set()]));
    if (!names.length) return hit;
    let o;
    try { o = git(['grep', '-I', '-w', '-F', '-o', '--no-color', ...names.flatMap((n) => ['-e', n])]); } catch (e) { if (e.status === 1) return hit; return null; }
    for (const l of o.split('\n')) { const k = l.lastIndexOf(':'); if (k > 0 && hit.has(l.slice(k + 1))) hit.get(l.slice(k + 1)).add(l.slice(0, k)); }
    return hit;
  };
  const focus = new Set(lines('focus.txt').map((l) => l.split('\t')[0]));
  const changed = lines('files.txt').filter((f) => (!focus.size || focus.has(f)));
  const sections = [];

  // 1. changed symbols
  let diff = ''; try { diff = fs.readFileSync(path.join(ctx, 'diff.patch'), 'utf8'); } catch { /* none */ }
  const all = hunks(diff), syms = [];
  for (const [f, hs] of all) if (changed.includes(f) && !isTest(f) && !isTestPath(f) && !NOT_CODE.test(f)) for (const s of symbolsOf(f, hs, cwd)) syms.push({ ...s, file: f });
  const picked = syms.slice(0, MAX_SYMS), names = [...new Set(picked.map((s) => s.name))];
  const refs = grep(names);
  if (refs) {
    const cands = new Set(lines('test-candidates.txt').filter((l) => /^ /.test(l)).map((l) => l.trim().split(/\s{2}/)[0]));
    const tests = (n) => [...refs.get(n)].filter((p) => testSet.has(p)).sort((a, b) => (cands.has(b) - cands.has(a)) || (a < b ? -1 : 1));
    const none = picked.filter((s) => !tests(s.name).length), some = [...new Map(picked.filter((s) => tests(s.name).length).map((s) => [s.name, s])).values()];
    sections.push(['Changed symbols with no test reference', none.slice(0, 25).map((s) => `${s.file}:${s.line} ${s.name}`), Math.max(0, none.length - 25) + Math.max(0, syms.length - picked.length)]);
    sections.push(['Changed symbols referenced by tests', some.slice(0, 15).map((s) => `${s.name} -> ${tests(s.name).slice(0, 2).join(', ')}`), Math.max(0, some.length - 15)]);
  }

  // 2. mirror assertions, in changed tests and candidate tests
  const files = [...new Set([...lines('files.txt').filter(isTest), ...lines('test-candidates.txt').filter((l) => /^ /.test(l)).map((l) => l.trim().split(/\s{2}/)[0])])]
    .filter((f) => testSet.has(f)).slice(0, MAX_TEST_FILES);
  const found = [];
  for (const f of files) {
    let src; try { if (fs.statSync(path.join(cwd, f)).size > MAX_BYTES) continue; src = fs.readFileSync(path.join(cwd, f), 'utf8'); } catch { continue; }
    for (const c of mirrorCandidates(src)) found.push({ ...c, file: f });
  }
  const fromCode = grep([...new Set(found.map((c) => c.tail))].slice(0, 60));
  if (fromCode) {
    const real = found.filter((c) => fromCode.has(c.tail) && [...fromCode.get(c.tail)].some((p) => !testSet.has(p) && !isTestPath(p)));
    sections.push(['Possible mirror assertions (expected value taken from production code)', real.slice(0, 15).map((c) => `${c.file}:${c.line} ${c.name}`), Math.max(0, real.length - 15)]);
  }

  // render within the cap, dropping whole lines
  let out = '';
  for (const [title, items, more] of sections) {
    if (!items.length) continue;
    let block = `${title}:\n`, dropped = more;
    for (const it of items) { if (Buffer.byteLength(out + block + `  ${it}\n`) > CAP - 80) { dropped++; continue; } block += `  ${it}\n`; }
    if (dropped) block += `  (${dropped} more not listed)\n`;
    out += (out ? '\n' : '') + block;
  }
  return out;
}

if (require.main === module) {
  const ctx = process.argv[2];
  if (!ctx) { console.error('Usage: node src/leads.js <ctx dir>'); process.exit(2); }
  const out = run(ctx);
  const f = path.join(ctx, 'leads.txt');
  if (out) fs.writeFileSync(f, out); else fs.rmSync(f, { force: true });
}
module.exports = { run, declName, hunks, symbolsOf, expectedArgs, mirrorCandidates, args };
