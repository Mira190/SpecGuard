// Deterministic test-gap signals for a finding anchored at path:line in a checkout (no model confidence involved).
// signals({repoDir, finding:{path,line}, base?}) -> {fn, ids, testRefsFn, testRefsLine, unseenTests, testOnlyTarget, newSymbol}
// testRefsFn: test files referencing the enclosing function name; testRefsLine: test files referencing the MOST SPECIFIC
// (rarest, still test-referenced or not) identifier on the cited line, i.e. min over ids that occur anywhere in the repo.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const TEST = /((^|\/)(tests?|__tests__|specs?|e2e|integration[-_]tests?)\/|(^|[/._-])(test|tests|spec)\.[\w]+$|\.(test|spec)\.[\w]+$|(^|\/)test_[^/]*\.py$|_test\.(go|py|rs|rb)$|(^|\/)conftest\.py$)/i;
const STOP = new Set('if else for while return func def function const let var self this true false nil null none not and or in is err error len str int bool string import from class new await async range print raise throw try catch with elif switch case default break continue type interface struct package'.split(' '));
const FN = [/^\s*func\s+(?:\([^)]*\)\s*)?(\w+)/, /^\s*(?:async\s+)?def\s+(\w+)/, /^\s*(?:export\s+)?(?:async\s+)?function\s*\*?\s*(\w+)/,
  /^\s*(?:export\s+)?(?:const|let)\s+(\w+)\s*=\s*(?:async\s*)?(?:\([^)]*\)|\w+)\s*=>/, /^\s*(?:public|private|protected|static|async|\s)*(\w+)\s*\([^)]*\)\s*(?::[^{]+)?\{\s*$/];
const TEST_ONLY_DOC = /exists for tests?|exists for testing|test[- ]only|only (used )?(in|for) tests?|for use in tests/i;
const git = (cwd, a) => { try { return execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1 << 28 }); } catch (e) { return e.stdout || ''; } };
const lines = (s) => s.split('\n').filter(Boolean);

function enclosingFn(src, line) {
  for (let i = Math.min(line, src.length) - 1; i >= 0; i--) for (const re of FN) { const m = re.exec(src[i]); if (m && !STOP.has(m[1])) return { name: m[1], line: i + 1 }; }
  return null;
}

// files (repo-relative) containing word `id`, tracked + untracked-not-ignored
const filesWith = (repoDir, id) => lines(git(repoDir, ['grep', '-l', '-w', '--untracked', '-e', id]));

function unseenTests(repoDir) {
  const gm = path.join(repoDir, '.gitmodules');
  if (!fs.existsSync(gm)) return false;
  const paths = [...fs.readFileSync(gm, 'utf8').matchAll(/^\s*path\s*=\s*(.+?)\s*$/gm)].map((m) => m[1]);
  return paths.some((p) => { try { return fs.readdirSync(path.join(repoDir, p)).length === 0; } catch { return true; } });
}

function signals({ repoDir, finding, base }) {
  const file = finding.path, line = finding.line;
  let src = [];
  try { src = fs.readFileSync(path.join(repoDir, file), 'utf8').split('\n'); } catch {}
  const fn = enclosingFn(src, line);
  const ids = [...new Set((src[line - 1] || '').match(/[A-Za-z_]\w{3,}/g) || [])].filter((w) => !STOP.has(w.toLowerCase()));
  const count = (id) => { const f = filesWith(repoDir, id); return { tests: f.filter((x) => TEST.test(x)).length, prod: f.filter((x) => !TEST.test(x) && x !== file).length }; };
  const fnC = fn ? count(fn.name) : null;
  const idC = ids.map(count).filter((c) => c.tests + c.prod > 0);
  const out = {
    fn: fn && fn.name, ids,
    testRefsFn: fnC ? fnC.tests : null,
    testRefsLine: idC.length ? Math.min(...idC.map((c) => c.tests)) : null,
    unseenTests: unseenTests(repoDir),
    testOnlyTarget: !TEST.test(file) && !!fn && (TEST_ONLY_DOC.test(src.slice(Math.max(0, fn.line - 9), fn.line - 1).join('\n')) || (fnC.prod === 0 && fnC.tests > 0)),
    lintGuard: false,
    newSymbol: null,
  };
  if (base && fn) { // all lines of the function's signature line are additions in the diff
    const d = git(repoDir, ['diff', '-U0', base, '--', file]);
    for (const m of d.matchAll(/^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)) {
      const s = +m[2], n = m[3] === undefined ? 1 : +m[3];
      if (fn.line >= s && fn.line < s + n) out.newSymbol = m[1] === "0"; // pure-addition hunk
    }
    if (out.newSymbol === null) out.newSymbol = false;
  }
  if (base) out.lintGuard = lines(git(repoDir, ['diff', '-U0', base, '--', ':(glob)**/*lint*', ':(glob)**/ruff*', ':(glob)**/.golangci*', ':(glob)**/biome*', ':(glob)**/.flake8'])).some((l) => /^\+(?!\+\+)/.test(l));
  return out;
}

// Gate: demote to summary when tests may live elsewhere (unseenTests), the target is test-only, or a lint rule guards it.
// Test-ref counts are reported but NOT gated on: on real replays they did not separate true gaps from trivial ones.
const decide = (s) => (s.unseenTests || s.testOnlyTarget || s.lintGuard ? 'summary' : 'inline');

module.exports = { signals, decide, enclosingFn, TEST };
