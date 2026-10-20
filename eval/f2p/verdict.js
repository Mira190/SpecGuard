// Verdict logic of the F2P oracle (README "Verdicts", "Amendments"). Pure functions over synthetic or real run outcomes.
// A run is { outcome: 'pass' | 'assert_fail' | 'throw' | 'error', origin?, frame?, msg? }. throw = collected, ran, threw a non-assertion error; error = compile, import, collection error or timeout.

// Frames that belong to the framework, runtime or dependencies, never to the code under test.
// Go GOROOT, toolchain and module-cache frames and the Python interpreter's stdlib (Lib\, lib/python3.x) are runtime; trimpath Go frames are filtered by the Go parser, which knows the mode.
const FRAMEWORK = /node_modules|node:|site-packages|dist-packages|<frozen|[\\/]go[\\/]pkg[\\/]mod|[\\/]go[\\/]src[\\/]|golang\.org[\\/]toolchain|@v\d|[\\/]GOROOT|[\\/]usr[\\/]lib|[\\/]pytest|[\\/]vitest|[\\/]lib[\\/]python3/i;
const WIN_PYSTD = /(^|[\\/])Lib[\\/]/; // case-sensitive: a repo's own lib/ directory is production code
// Test code: test files, helpers, fixtures.
const TESTISH = /(^|[\\/])(tests?|__tests__|testdata|testutils?|fixtures?|helpers?)[\\/]|\.(test|spec)\.[cm]?[jt]sx?$|_test\.go$|(^|[\\/])test_[^\\/]*\.py$|_test\.py$|conftest\.py$|(^|[\\/])setup[^\\/]*\.[jt]s$/i;
// A bad call or import: the test is wrong, not the code under test.
const BADCALL = /is not a function|is not a constructor|is not defined|has no attribute|takes \d+ positional|required positional|unexpected keyword|Cannot find module|ImportError|ModuleNotFoundError|not enough arguments|too many arguments|undefined variable|undeclared name/i;

// Origin of a throw from its stack (innermost frame first, 'path:line' or 'path:line fn') and message.
// production: the first non-framework frame is not test code (that frame is recorded); test: it is test code, setup or fixture; bad_call: the message says the call itself was wrong; unknown: no usable frame.
function throwOrigin(frames, msg = '') {
  if (BADCALL.test(msg)) return { origin: 'bad_call', frame: null };
  const top = (frames || []).find((f) => !FRAMEWORK.test(f) && !WIN_PYSTD.test(f));
  if (!top) return { origin: 'unknown', frame: null };
  return TESTISH.test(top.replace(/:\d+(:\d+)?(\s.*)?$/, '')) ? { origin: 'test', frame: top } : { origin: 'production', frame: top };
}

// Did the fix change the declaration of one of the named functions? diff = unified diff text; a +/- line that declares the name counts.
function signatureChanged(diff, names) {
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return names.filter(Boolean).some((n) => {
    const e = esc(n);
    const decl = new RegExp(`\\b(def|function\\*?|func|fn)\\s+(\\([^)]*\\)\\s*)?${e}\\b|^\\s*(export\\s+)?(async\\s+)?(public\\s+|private\\s+|protected\\s+|static\\s+)*${e}\\s*(<[^>]*>)?\\s*\\([^)]*\\)\\s*(:\\s*[^{=]+)?(\\{|=>)|\\b(const|let|var)\\s+${e}\\s*=\\s*(async\\s*)?(\\([^)]*\\)|\\w+)\\s*(:\\s*[^=]+)?=>`);
    return diff.split('\n').some((l) => /^[+-](?![+-])/.test(l) && decl.test(l.slice(1)));
  });
}

const tree = (runs) => (runs.every((r) => r.outcome === runs[0].outcome) ? runs[0].outcome : 'mixed');

// buggy / fixed: arrays of runs (3 each). ctx.apiShift: signatureChanged() held for the top production frame's function or a function the test calls.
// Order: error -> invalid; throw on fixed -> invalid; buggy throws -> invalid unless all production-origin (then verified_throw / api_shift); mixed -> flaky; then the assertion-only table.
function verdict(buggy, fixed, ctx = {}) {
  const err = [...buggy, ...fixed].find((r) => r.outcome === 'error');
  if (err) return { verdict: 'invalid', subtype: 'compile', reason: err.msg || 'compile, import or collection error' };
  if (fixed.some((r) => r.outcome === 'throw')) return { verdict: 'invalid', subtype: 'throw_on_fixed', reason: 'non-assertion throw on fixed tree' };
  const th = buggy.filter((r) => r.outcome === 'throw');
  if (th.length) {
    const bad = th.find((r) => r.origin !== 'production');
    if (bad) return { verdict: 'invalid', subtype: bad.origin === 'bad_call' ? 'bad_call' : 'test_setup', reason: `throw not from code under test (${bad.origin || 'unknown'})` };
    if (tree(buggy) !== 'throw' || tree(fixed) === 'mixed') return { verdict: 'flaky', reason: 'mixed results across repeats' };
    if (tree(fixed) !== 'pass') return { verdict: 'not_discriminating', reason: 'throws on buggy, fails by assertion on fixed' };
    return { verdict: ctx.apiShift ? 'api_shift' : 'verified_throw', reason: 'throw in production code on buggy, pass on fixed', frame: th[0].frame };
  }
  const b = tree(buggy), f = tree(fixed);
  if (b === 'mixed' || f === 'mixed') return { verdict: 'flaky', reason: 'mixed results across repeats' };
  if (b === 'assert_fail' && f === 'pass') return { verdict: 'verified', reason: 'assertion fails on buggy, passes on fixed' };
  if (b === 'pass' && f === 'assert_fail') return { verdict: 'reversed', reason: 'passes on buggy, fails by assertion on fixed' };
  return { verdict: 'not_discriminating', reason: b === f ? `${b} on both trees` : `${b} on buggy, ${f} on fixed` };
}

module.exports = { throwOrigin, signatureChanged, verdict, tree };
