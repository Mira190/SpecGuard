// Source file -> the existing test files most likely to cover it. One mapping for the PR review (collect.sh, test-candidates.txt) and the code-first scan (audit-units.js).
// Up to `per` tests: same basename stem with test/spec affixes (any directory), tests that mention the stem as a whole word (imports, references), then tests in the same directory.
// ponytail: names and a word search only, no per-language import parsing; a test that reaches the code through an index or a differently named module is missed (the unit then reads as untested).
const path = require('node:path');

const key = (s) => s.toLowerCase().replace(/[-_.]/g, '');
const noExt = (p) => path.posix.basename(p).replace(/\.[^.]*$/, '');
// FooTest -> foo, foo_test -> foo, foo.spec -> foo, test_foo -> foo, FooTests -> foo; a stem without affix stays (tests/foo.py, test/foo.js)
const testStem = (p) => key(noExt(p).replace(/^tests?[_-]/i, '').replace(/[._-]?(tests?|spec)$/i, ''));
const near = (a, b) => { const x = path.posix.dirname(a).split('/'), y = path.posix.dirname(b).split('/'); let i = 0; while (i < x.length && x[i] === y[i]) i++; return i; };
const GENERIC = new Set(['index', 'main', 'mod', 'init', '__init__', 'lib', 'app', 'utils', 'util', 'types']);
const dirKey = (t) => path.posix.dirname(t).replace(/\/__tests__$/, '');

// tests by stem and by folder: built once when many files are mapped (the scan maps thousands against thousands of tests)
function indexTests(tests) {
  const byStem = new Map(), byDir = new Map(), put = (m, k, t) => { if (!m.has(k)) m.set(k, []); m.get(k).push(t); };
  for (const t of tests) { put(byStem, testStem(t), t); put(byDir, dirKey(t), t); }
  return { byStem, byDir };
}

// tests: every test path; mentions(stem) -> test paths that name the stem as a whole word (the caller's search: git grep, or an index); -> Map(test path -> why), at most `per`.
function mapTests(f, { tests, mentions, per = 5, index = indexTests(tests) }) {
  const stem = noExt(f), want = key(stem), dir = path.posix.dirname(f), got = new Map();
  const add = (list, why) => { for (const t of list.slice().sort((a, b) => near(f, b) - near(f, a) || (a < b ? -1 : 1))) if (got.size < per && !got.has(t)) got.set(t, why); };
  add(index.byStem.get(want) || [], 'same name');
  if (got.size < per && stem.length >= 3 && !GENERIC.has(stem.toLowerCase())) add(mentions(stem), `mentions ${stem}`);
  add(index.byDir.get(dir) || [], 'same directory');
  return got;
}

module.exports = { mapTests, indexTests, testStem, near, key, noExt, GENERIC };
