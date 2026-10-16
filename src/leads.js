#!/usr/bin/env node
// Deterministic leads for the most valuable unit-test findings, so a weak model starts from facts instead of free exploration.
// Writes $CTX/leads.txt (nothing when there is nothing to say). Leads are hints the reviewer must verify; they are never findings.
//   1. Changed symbols (enclosing symbol of each hunk + symbols defined on added lines) with / without a word-bounded test reference.
//   2. Possible mirror assertions: an assertion whose EXPECTED argument is a constant taken from production code.
//   3. Weak assertions: an assertion that only checks existence, truthiness or type of a result (assert.ok(x), toBeDefined(), assertNotNull(x)...),
//      unless the same test block also pins a value of the same expression.
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

// ---- weak assertions ----
const TEST_START = /(?<![.\w$])(?:it|test|specify)(?:\s*\(\s*['"`]|(?:\.(?:only|skip|todo|each|concurrent|failing|serial|fails|cb|sequential|fixme))+\s*\()|^\s*(?:async\s+)?def\s+test|^\s*func\s+Test|@Test\b|\[(?:Test|Fact|Theory|TestMethod)\b|#\[test\]|^\s*(?:public\s+)?(?:void|fun)\s+test/;
const VALUE = /\bassert\.(?:equal|strictEqual|deepEqual|deepStrictEqual|equals|eq)\s*\(|\b(?:assertEquals?|assert_equal|assertSame|assertArrayEquals|assert_eq!)\s*\(|[Aa]ssert\.(?:Equal\w*|AreEqual|Same|Exactly)\s*\(|\brequire\.Equal\w*\s*\(|\.(?:toBe|toEqual|toStrictEqual|toBeCloseTo|toMatchObject|toHaveLength|toContain|isEqualTo)\s*\(|^\s*assert\s.*==/;
const WHAT = { truthy: 'is truthy', exists: 'is not null/undefined', type: 'has the expected type' };
const truthyArg = (x) => { // the argument of assert/assertTrue: a bare reference, a not-null check or a typeof check
  let m; const bare = x.replace(/^!!/, '');
  if (REF.test(bare) && !/^(?:true|false|null|undefined|None|True|False|NaN)$/.test(bare)) return { x: bare, what: 'truthy' };
  if ((m = /^(.+?)\s*(?:!==?|is\s+not)\s*(?:null|undefined|None)$/.exec(x))) return { x: m[1], what: 'exists' };
  if ((m = /^typeof\s+(.+?)\s*===?\s*['"]\w+['"]$/.exec(x))) return { x: m[1], what: 'type' };
  return null;
};
const lastArg = (a) => (a.length > 1 && /^['"`]/.test(a[0]) ? a[1] : a[0]) || ''; // JUnit4 puts the message first
function weakOf(text, next) { // -> {x, what} | null
  let m, a;
  const at = (re) => { m = re.exec(text); return m && args(text, m.index + m[0].length - 1); };
  if ((a = at(/(?<![.\w$])assert(?:\.ok)?\s*\(/)) && (a.length === 1 || (a.length === 2 && /^['"`]/.test(a[1])))) return truthyArg(a[0]);
  if ((a = at(/\bassert\.not(?:Strict)?Equal\s*\(/)) && a.length === 2 && /^(?:null|undefined)$/.test(a[1])) return { x: a[0], what: 'exists' };
  if ((m = /\bexpect\s*\((.+)\)\s*\.(not\.)?(toBeDefined|toBeTruthy|toBeNull|toBeUndefined|toBeInstanceOf|toBeTypeOf)\s*\(/.exec(text))) {
    const nil = /Null$|Undefined$/.test(m[3]); // toBeNull() alone is a value check; only its negation is weak
    return nil !== !!m[2] ? null : { x: m[1], what: m[3] === 'toBeTruthy' ? 'truthy' : nil || m[3] === 'toBeDefined' ? 'exists' : 'type' };
  }
  if ((a = at(/\b(?:self\.)?assertTrue\s*\(|\bAssert\.IsTrue\s*\(/))) return truthyArg(lastArg(a));
  if ((a = at(/\b(?:self\.)?(?:assertIsNotNone|assertNotNull|assertIsNotNull)\s*\(|\bAssert\.(?:IsNotNull|NotNull)\s*\(|\b(?:assert|require)\.NotNil\s*\(/))) {
    if (/NotNil/.test(m[0]) && /^(?:t|b|tb)$/.test(a[0])) a = a.slice(1);
    const x = lastArg(a);
    return x ? { x, what: 'exists' } : null;
  }
  if ((m = /^\s*assert\s+(?!\()(.+?)(?:\s*,\s*['"].*)?$/.exec(text))) return truthyArg(m[1]);
  // ponytail: `if err == nil { t.Fatal }` is skipped (an expected-error check); other nil checks followed by t.Fatal/t.Error are leads
  if ((m = /^\s*if\s+([A-Za-z_][\w.]*)\s*==\s*nil\s*\{/.exec(text)) && !/^err/i.test(m[1]) && next.some((l) => /\bt\.(?:Fatal|Error)/.test(l))) return { x: m[1], what: 'exists' };
  return null;
}
// -> [{line, text, x, what}] weak assertions in one test file, minus those whose test block also pins a value of the same expression.
function weakCandidates(src) {
  const ls = src.split('\n').slice(0, 4000).map((l) => l.replace(/\r$/, '')), starts = [];
  ls.forEach((t, i) => { if (t.length <= 400 && TEST_START.test(t)) starts.push(i); });
  const out = [];
  ls.forEach((text, i) => {
    if (text.length > 400 || quiet(text)) return;
    const w = weakOf(text, ls.slice(i + 1, i + 3));
    if (!w || !w.x) return;
    const lo = starts.filter((s) => s <= i).pop() ?? 0, hi = starts.find((s) => s > i) ?? ls.length;
    const same = REF.test(w.x) ? new RegExp(`(?<![\\w$])${w.x.replace(/[$.]/g, '\\$&')}(?![\\w$])`) : { test: (l) => l.includes(w.x) };
    if (ls.slice(lo, hi).some((l) => VALUE.test(l) && same.test(l))) return;
    out.push({ line: i + 1, text: text.trim(), ...w });
  });
  return out;
}

// ---- removed / weakened assertions (diff only) ----
// value assertions VALUE does not list (kept out of VALUE: it also decides which weak assertions are "pinned")
const EXTRA = /\bassert\.(?:match|doesNotMatch|notEqual|notStrictEqual|notDeepEqual|notDeepStrictEqual|throws|doesNotThrow|rejects|doesNotReject|ifError)\s*\(|\.(?:toMatch|toThrow|toThrowError|toHaveBeenCalledWith|toBeGreaterThan|toBeLessThan)\s*\(|\.rejects\./;
const EXACT = /\.(?:toBe|toEqual|toStrictEqual)\s*\(|\b(?:equal|deepEqual|strictEqual|deepStrictEqual)\s*\(/;
const RANGE = /\.(?:toBeGreaterThan|toBeGreaterThanOrEqual|toBeLessThan|toBeLessThanOrEqual|toBeCloseTo)\s*\(/;
const LIT =/'((?:\\.|[^'\\])*)'|"((?:\\.|[^"\\])*)"|`((?:\\.|[^`\\])*)`|(?<![\w$.])(\d+(?:\.\d+)?)(?![\w$])/g; // quoted strings and numbers
const literalsOf = (text, min = 2) => new Set([...text.matchAll(LIT)].map((m) => m[1] ?? m[2] ?? m[3] ?? m[4]).filter((x) => x.length >= min));
const subjectOf = (text) => { // the expression under test on one assertion line, whitespace and quote style normalised; null when it is no assertion
  let m, x = null;
  let w = weakOf(text, []);
  if (!w && (m = /(?<![.\w$])assert(?:\.ok)?\s*\(/.exec(text))) { const a = args(text, m.index + m[0].length - 1); if (a.length === 1 && /^[\w$.]+\(.*\)$/.test(a[0])) w = { x: a[0] }; } // assert.ok(f(x)): a bare call result
  if (w) x = w.x;
  else if (VALUE.test(text) || EXTRA.test(text)) {
    if ((m = /\bexpect\s*\(/.exec(text))) x = args(text, m.index + m[0].length - 1)[0];
    else if ((m = /^\s*assert\s+(.+?)\s*==/.exec(text))) x = m[1];
    else if ((m = /(?<![\w$])(?:[Aa]ssert|require)\.\w+\s*\(|(?<![\w$.])(?:assert\w*|assert_\w+|assert_eq!)\s*\(/.exec(text))) x = args(text, m.index + m[0].length - 1)[0];
  }
  return x ? { x: x.replace(/\s+/g, '').replace(/["'`]/g, "'"), weak: !!w } : null;
};
// -> [{file, kind: 'removed'|'weakened', line (old side), old, new}] per changed test file
// ponytail: same-file, single-line assertions, subject = first argument / expect() operand. Ceiling: multi-line assertions, renamed subjects.
function assertionDelta(diff, isTest) {
  const per = new Map(); let file = null, old = null, body = false, o = 0, hk = 0;
  for (const l of diff.split('\n')) {
    if (l.startsWith('diff --git ')) { body = false; file = null; continue; }
    if (!body) {
      if (l.startsWith('--- ')) old = l === '--- /dev/null' ? null : l.slice(4).replace(/^a\//, '').replace(/^"|"$/g, '');
      if (l.startsWith('+++ ')) file = l === '+++ /dev/null' ? old : l.slice(4).replace(/^b\//, '').replace(/^"|"$/g, ''); // a deleted file keeps its old path
      const m = /^@@ -(\d+)/.exec(l);
      if (m) { body = true; hk++; o = +m[1]; if (file && isTest(file) && !per.has(file)) per.set(file, { rm: [], add: [], lines: [] }); }
      continue;
    }
    const m = /^@@ -(\d+)/.exec(l);
    if (m) { o = +m[1]; hk++; continue; }
    const e = file && per.get(file), t = l.slice(1).replace(/\r$/, '');
    if (l[0] === '-') { if (e && t.length <= 400 && !quiet(t)) { const s = subjectOf(t); if (s) e.rm.push({ hk, line: o, text: t.trim(), ...s }); } o++; }
    else if (l[0] === '+') { if (e && !quiet(t)) { const u = t.slice(0, 400); e.lines.push(u); const s = subjectOf(u); if (s) e.add.push({ hk, text: u.trim(), at: e.lines.length - 1, ...s }); } } // a long added line still re-pins: its subject comes first
    else if (l[0] === ' ') o++;
  }
  const out = [];
  const callee = (x) => (/^([\w$.]+)\(/.exec(x) || [])[1];
  // top-level elements of the array literal that opens at text[at], as text (nested calls and arrays stay inside their element); strings kept whole, // comments skipped
  const rowsOf = (text, at) => {
    if (text[at] !== '[') return [];
    const rows = [];
    let depth = 0, cur = '';
    for (let i = at; i < text.length; i++) {
      const c = text[i];
      if (c === '/' && text[i + 1] === '/') { while (i + 1 < text.length && text[i + 1] !== '\n') i++; continue; }
      if (c === '"' || c === "'" || c === '`') { let j = i + 1; while (j < text.length && text[j] !== c) j += text[j] === '\\' ? 2 : 1; cur += text.slice(i, j + 1); i = j; continue; }
      if ('([{'.includes(c) && ++depth === 1) continue;
      if (')]}'.includes(c) && --depth === 0) { if (cur.trim()) rows.push(cur); return rows; }
      if (c === ',' && depth === 1) { if (cur.trim()) rows.push(cur); cur = ''; continue; }
      cur += c;
    }
    return rows; // unclosed within the lines read: what was seen
  };
  // the rows of the table a loop feeds into the assertion at index ia of the added lines: for (... of TABLE), TABLE.forEach(, .each(TABLE; inline, or a variable
  // declared in the added lines (a TypeScript type annotation is fine); [] when no such loop sits in the 5 lines above
  const tableOf = (ls, ia) => {
    for (let h = ia; h >= Math.max(0, ia - 5); h--) {
      const m = /\bfor\s*\(.*?\bof\s+([\w$.]+|\[)|\b([\w$.]+)\s*\.\s*forEach\s*\(|\.each\s*\(\s*([\w$.]+|\[)/.exec(ls[h]);
      if (!m) continue;
      const it = m[1] || m[2] || m[3];
      if (it === '[') return rowsOf(ls.slice(h, ia + 1).join('\n'), m.index + m[0].length - 1);
      const d = ls.findIndex((l) => new RegExp(`\\b(?:const|let|var)\\s+${esc(it)}(?![\\w$])`).test(l));
      if (d < 0) return [];
      const text = ls.slice(d, d + 50).join('\n'), name = new RegExp(`\\b(?:const|let|var)\\s+${esc(it)}(?![\\w$])`).exec(text);
      const eq = /=(?![=>])/g; eq.lastIndex = name.index + name[0].length; // past a type annotation, which may hold brackets
      const e = eq.exec(text);
      return e ? rowsOf(text, text.indexOf('[', e.index)) : [];
    }
    return [];
  };
  const litList = (t) => [...String(t).replace(/\s\/\/[^'"`\n]*$/gm, '').matchAll(LIT)].map((m) => m[1] ?? m[2] ?? m[3] ?? m[4]); // every literal in order, duplicates kept; a trailing comment is not part of it
  const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const [f, { rm, add, lines }] of per) for (const r of rm) {
    const same = add.filter((a) => a.x === r.x && a.hk === r.hk); // only the same hunk re-pins: an assertion elsewhere in the file may pin something else
    const exact = !r.weak && EXACT.test(r.text) && literalsOf(r.text, 1).size > 0; // an exact value replaced by a range matcher is weakened
    if (same.some((a) => !a.weak && !(exact && RANGE.test(a.text))) || (r.weak && same.length)) continue; // still pinned: moved, reformatted or strengthened
    // re-pinned through a helper or alias: an added assertion holds every distinctive literal of the removed one (literals most assertion lines share, like '.mp4', say nothing)
    const all = [...rm, ...add], has = (a, x) => literalsOf(a.text, 1).has(x);
    const distinct = (min) => [...literalsOf(r.text, min)].filter((x) => { const n = all.filter((a) => has(a, x)).length; return n <= 2 || n * 3 <= all.length; }); // single characters only when nothing longer is distinctive
    const lits = distinct(2).length ? distinct(2) : distinct(1);
    if (lits.length && add.some((a) => !a.weak && lits.every((x) => has(a, x)))) continue;
    // table-driven: a parameterised added assertion on the same function (no literal in its subject) inside a loop over a table with one row whose literals are
    // exactly the removed assertion's, in order ([1, 2], { input: 1, expected: 2 }, [at(10, 0, 0), [10, 30, 15], at(10, 30, 15)]). A row dropped in the move, an
    // array the loop does not read or a literal assertion keeps the lead.
    const want = litList(r.text).join('\u0000'), fn = callee(r.x);
    if (want && fn && add.some((a) => !a.weak && callee(a.x) === fn && !literalsOf(a.x, 1).size && tableOf(lines, a.at).some((row) => litList(row).join('\u0000') === want))) continue;
    out.push(same.length ? { file: f, kind: 'weakened', line: r.line, old: r.text, new: same[0].text } : { file: f, kind: 'removed', line: r.line, old: r.text });
  }
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
  const found = [], weak = [];
  for (const f of files) {
    let src; try { if (fs.statSync(path.join(cwd, f)).size > MAX_BYTES) continue; src = fs.readFileSync(path.join(cwd, f), 'utf8'); } catch { continue; }
    for (const c of mirrorCandidates(src)) found.push({ ...c, file: f });
    for (const c of weakCandidates(src)) weak.push({ ...c, file: f });
  }
  const fromCode = grep([...new Set(found.map((c) => c.tail))].slice(0, 60));
  if (fromCode) {
    const real = found.filter((c) => fromCode.has(c.tail) && [...fromCode.get(c.tail)].some((p) => !testSet.has(p) && !isTestPath(p)));
    sections.push(['Possible mirror assertions (expected value taken from production code)', real.slice(0, 15).map((c) => `${c.file}:${c.line} ${c.name}`), Math.max(0, real.length - 15)]);
  }

  // 3. weak assertions, same files
  const short = (t, n) => (t.length > n ? t.slice(0, n - 3) + '...' : t);
  sections.push(['Weak assertions (only existence, truthiness or type is checked)',
    weak.slice(0, 15).map((c) => `weak? ${c.file}:${c.line} — ${short(c.text, 80)} only checks that ${short(c.x, 40)} ${WHAT[c.what]}; nothing pins its value`), Math.max(0, weak.length - 15)]);

  // 4. removed or weakened assertions, from the diff
  const delta = assertionDelta(diff, isTest);
  sections.push(['Removed or weakened assertions (answer each: a weak_test or missing_test finding citing the test file, or where the behaviour is still pinned)',
    delta.slice(0, 15).map((d) => (d.kind === 'removed' ? `assertion removed: ${short(d.old, 100)} (${d.file}:${d.line})` : `assertion weakened: ${short(d.old, 80)} → ${short(d.new, 80)} (${d.file}:${d.line})`)), Math.max(0, delta.length - 15)]);

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
module.exports = { run, assertionDelta, declName, hunks, symbolsOf, expectedArgs, mirrorCandidates, weakCandidates, args, TEST_START, GENERIC };
