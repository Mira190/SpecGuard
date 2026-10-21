const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cov = require('./coverage.js');

const diff = (file, n) => `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -0,0 +1,${n} @@\n${Array.from({ length: n }, (_, i) => `+l${i + 1}`).join('\n')}\n`;
const lines = (r, f) => Object.fromEntries([...r.files.get(f)]);

test('lcov: SF/DA, hits per line, records ended by end_of_record', () => {
  const r = cov.parse('TN:\nSF:/ci/src/a.js\nFN:1,f\nDA:1,1\nDA:2,0\nDA:3,5,abc\nend_of_record\nSF:b.js\nDA:7,0\nend_of_record\n');
  assert.equal(r.format, 'lcov');
  assert.deepEqual(lines(r, '/ci/src/a.js'), { 1: 1, 2: 0, 3: 5 });
  assert.deepEqual(lines(r, 'b.js'), { 7: 0 });
});

test('cobertura: <class filename> lines, <source> roots, the <package> layout and the timestamp', () => {
  const x = `<?xml version="1.0"?><coverage timestamp="1700000000000" version="7"><sources><source>/home/runner/work/r/r</source></sources>
    <packages><package name="pkg"><classes>
      <class name="a" filename="pkg/a.py" line-rate="0.5"><methods><method name="f"><lines><line number="2" hits="1"/></lines></method></methods><lines><line number="2" hits="1"/><line number="3" hits="0"/></lines></class>
      <class name="empty" filename="pkg/e.py"/>
    </classes></package></packages></coverage>`;
  const r = cov.parse(x);
  assert.equal(r.format, 'cobertura');
  assert.deepEqual(r.sources, ['/home/runner/work/r/r']);
  assert.equal(r.ts, 1700000000000);
  assert.equal(r.files.size, 1);
  assert.deepEqual(Object.entries(lines(r, 'pkg/a.py')).map(([l, h]) => [+l, h > 0]), [[2, true], [3, false]]);
  assert.equal(cov.parse('<coverage timestamp="1700000000"><packages/></coverage>').ts, 1700000000000, 'seconds are accepted too');
  const flat = cov.parse('<coverage><package name=""><class filename="x.js"><lines><line number="1" hits="2"/></lines></class></package></coverage>');
  assert.deepEqual(lines(flat, 'x.js'), { 1: 2 });
});

test('jacoco: package path + sourcefile name; only lines with instructions; ci is the executed part; session dump is the timestamp', () => {
  const r = cov.parse(`<report name="x"><sessioninfo id="s" start="1700000000000" dump="1700000005000"/><package name="com/foo"><class name="com/foo/A" sourcefilename="A.java"><method name="m"><counter type="LINE" missed="1" covered="1"/></method></class>
    <sourcefile name="A.java"><line nr="3" mi="0" ci="2" mb="0" cb="0"/><line nr="4" mi="3" ci="0"/><line nr="5" mi="0" ci="0"/></sourcefile></package></report>`);
  assert.equal(r.format, 'jacoco');
  assert.equal(r.ts, 1700000005000);
  assert.deepEqual(lines(r, 'com/foo/A.java'), { 3: 2, 4: 0 });
});

test('go cover profile: every line of a block gets its count', () => {
  const r = cov.parse('mode: set\ngithub.com/o/r/pkg/f.go:3.10,5.2 1 0\ngithub.com/o/r/pkg/f.go:5.5,6.2 1 1\ngithub.com/o/r/pkg/f.go:9.1,9.20 1 1\n');
  assert.equal(r.format, 'go');
  assert.deepEqual(lines(r, 'github.com/o/r/pkg/f.go'), { 3: 0, 4: 0, 5: 1, 6: 1, 9: 1 });
});

test('istanbul coverage-final.json: statements by start line', () => {
  const j = { '/ci/src/a.js': { path: '/ci/src/a.js', statementMap: { 0: { start: { line: 1 }, end: { line: 1 } }, 1: { start: { line: 4 }, end: { line: 6 } }, 2: { start: { line: 5 } } }, s: { 0: 3, 1: 0, 2: 0 }, fnMap: {}, f: {} }, '/ci/bad.js': { nope: 1 } };
  const r = cov.parse(JSON.stringify(j));
  assert.equal(r.format, 'istanbul');
  assert.deepEqual(lines(r, '/ci/src/a.js'), { 1: 3, 4: 0, 5: 0 });
  assert.equal(r.files.size, 1);
  assert.throws(() => cov.parse('hello'), /unrecognised/);
  assert.throws(() => cov.parse('{nope'));
});

test('paths: workspace prefixes, a foreign absolute CI path, windows paths, source roots, package and import paths all land on the changed file', () => {
  const known = new Set(['src/a.js', 'app/src/main/java/com/foo/A.java', 'pkg/f.go', 'b.js', 'lib/b.js']);
  const res = cov.resolver(known, '/home/runner/work/r/r');
  assert.equal(res('/home/runner/work/r/r/src/a.js'), 'src/a.js');
  assert.equal(res('./src/a.js'), 'src/a.js');
  assert.equal(res('/somewhere/else/src/a.js'), 'src/a.js');
  assert.equal(res('/workspace/lib/b.js'), 'lib/b.js', 'the longest changed path wins over a bare b.js');
  assert.equal(res('com/foo/A.java'), 'app/src/main/java/com/foo/A.java');
  assert.equal(res('github.com/o/r/pkg/f.go'), 'pkg/f.go');
  assert.equal(res('a.py', ['/home/runner/work/r/r/src']), null);
  assert.equal(res('f.go', ['/home/runner/work/r/r/pkg']), 'pkg/f.go');
  assert.equal(res('/x/unrelated.js'), null);
  assert.equal(cov.resolver(known, 'C:\\ws\\r')('C:\\ws\\r\\src\\a.js'), 'src/a.js');
  assert.equal(cov.resolver(new Set(['x/a.js', 'y/a.js']), '')('a.js'), null, 'an ambiguous short path is not guessed');
});

test('analyze: added instrumented lines are executed or never executed; counts, ranges and whole-file misses', () => {
  const lcov = 'SF:/home/runner/work/r/r/src/a.js\nDA:1,4\nDA:2,0\nDA:3,0\nDA:4,0\nDA:6,1\nDA:7,0\nend_of_record\nSF:/home/runner/work/r/r/src/unchanged.js\nDA:1,0\nend_of_record\n';
  const r = cov.analyze({ patch: diff('src/a.js', 5), files: ['src/a.js', 'src/b.js', 'README.md', 'src/a.test.js'], reports: [{ name: 'lcov.info', text: lcov }], ws: '/home/runner/work/r/r' });
  assert.deepEqual(r.json.total, { instrumented: 4, executed: 1 }); // lines 1-5 added; 5 is not instrumented
  assert.deepEqual(r.json.files['src/a.js'], { inst: 4, exec: 1, never: [[2, 4]], ran: [[1, 1]], miss: [[2, 4], [7, 7]] });
  assert.equal(r.json.v, 2, 'v2 adds ran');
  assert.deepEqual(Object.keys(r.json.files), ['src/a.js'], 'unchanged files and test files carry no entry');
  assert.deepEqual(r.json.unreported, ['src/b.js'], 'only code files with no report entry; docs are not listed');
  assert.match(r.txt, /Changed lines executed by tests: 1 of 4 instrumented\./);
  assert.match(r.txt, /^src\/a\.js 1\/4; never executed: L2-L4$/m);
  assert.match(r.txt, /No coverage data for: src\/b\.js/);
  assert.ok(Buffer.byteLength(r.txt) < 4096);
});

test('analyze: several reports merge (executed in any one counts); a stale or unreadable report is skipped with a note; nothing usable means no txt', () => {
  const a = 'SF:src/a.js\nDA:1,0\nDA:2,0\nend_of_record\n', b = 'SF:src/a.js\nDA:1,1\nend_of_record\n';
  const m = cov.analyze({ patch: diff('src/a.js', 2), files: ['src/a.js'], reports: [{ name: 'a', text: a }, { name: 'b', text: b }] });
  assert.deepEqual(m.json.files['src/a.js'], { inst: 2, exec: 1, never: [[2, 2]], ran: [[1, 1]], miss: [[2, 2]] });
  const old = '<coverage timestamp="1000000000"><packages><package name=""><classes><class filename="src/a.js"><lines><line number="1" hits="1"/></lines></class></classes></package></packages></coverage>';
  const s = cov.analyze({ patch: diff('src/a.js', 2), files: ['src/a.js'], reports: [{ name: 'cob.xml', text: old }, { name: 'bad.txt', text: 'junk' }], headTime: 2e12 });
  assert.equal(s.json.reports, 0);
  assert.equal(s.txt, '');
  assert.deepEqual(s.json.notes, ['cob.xml is older than the head commit; not used', 'bad.txt: unrecognised format']);
  const fresh = cov.analyze({ patch: diff('src/a.js', 2), files: ['src/a.js'], reports: [{ name: 'cob.xml', text: old }], headTime: 1 });
  assert.equal(fresh.json.reports, 1);
  const none = cov.analyze({ patch: diff('src/a.js', 2), files: ['src/a.js'], reports: [{ name: 'a', text: 'SF:other/x.js\nDA:1,1\nend_of_record\n' }] });
  assert.deepEqual([none.json.reports, none.json.total, none.json.unreported], [1, { instrumented: 0, executed: 0 }, ['src/a.js']]);
});

test('analyze: the text is capped for the prompt and lists the files with the most never-executed lines first', () => {
  const files = Array.from({ length: 120 }, (_, i) => `src/f${i}.js`);
  const patch = files.map((f) => diff(f, 3)).join('');
  const lcov = files.map((f, i) => `SF:${f}\nDA:1,${i % 2}\nDA:2,0\nDA:3,0\nend_of_record\n`).join('');
  const r = cov.analyze({ patch, files, reports: [{ name: 'l', text: lcov }] });
  assert.ok(Buffer.byteLength(r.txt) < 3600, String(Buffer.byteLength(r.txt)));
  assert.match(r.txt, /more files not shown/);
  assert.match(r.txt.split('\n')[1], /^src\/f\d*[02468]\.js 0\/3; never executed: L1-L3$/);
  assert.equal(cov.ranges([5, 1, 2, 3, 3, 9]).map((x) => x.join('-')).join(), '1-3,5-5,9-9');
});

const tmp = (t) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-cov-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };
const put = (d, f, text) => { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), text); };

test('expand: globs relative to the workspace, ** and basename globs, ! excludes, no escape upward, node_modules skipped', (t) => {
  const d = tmp(t);
  for (const f of ['coverage/lcov.info', 'pkg/a/coverage/lcov.info', 'pkg/b/coverage.xml', 'node_modules/x/lcov.info', 'cover.out', 'build/reports/jacoco/test/jacocoTestReport.xml']) put(d, f, 'x');
  assert.deepEqual(cov.expand(['coverage/lcov.info'], d), ['coverage/lcov.info']);
  assert.deepEqual(cov.expand(['**/lcov.info'], d), ['coverage/lcov.info', 'pkg/a/coverage/lcov.info']);
  assert.deepEqual(cov.expand(['cover.out', 'build/reports/jacoco/*/*.xml', 'pkg/*/coverage.xml'], d), ['build/reports/jacoco/test/jacocoTestReport.xml', 'cover.out', 'pkg/b/coverage.xml']);
  assert.deepEqual(cov.expand(['**/lcov.info', '!pkg/**'], d), ['coverage/lcov.info']);
  assert.deepEqual(cov.expand(['../x/lcov.info', '/etc/passwd', 'C:/x/lcov.info'], d), []);
  assert.deepEqual(cov.expand(['missing/*.info'], d), []);
});

test('main: writes coverage.txt and coverage.json from the workspace; no globs writes nothing; no match, junk or an unwritable context is a note and never throws', (t) => {
  const d = tmp(t), ctx = path.join(d, '.specguard-ctx');
  put(d, '.specguard-ctx/diff.patch', diff('src/a.js', 3));
  put(d, '.specguard-ctx/files.txt', 'src/a.js\n');
  put(d, 'coverage/lcov.info', `SF:${d.replace(/\\/g, '/')}/src/a.js\nDA:1,1\nDA:2,0\nDA:3,1\nend_of_record\n`);
  const out = (n) => { try { return fs.readFileSync(path.join(ctx, n), 'utf8'); } catch { return null; } };
  const run = (env) => {
    for (const n of ['coverage.txt', 'coverage.json']) fs.rmSync(path.join(ctx, n), { force: true });
    const log = console.log;
    console.log = () => {};
    try { cov.main({ CTX: ctx, GITHUB_WORKSPACE: d, ...env }); } finally { console.log = log; }
  };
  run({ COVERAGE_FILES: '' });
  assert.equal(out('coverage.json'), null);
  run({ COVERAGE_FILES: 'coverage/lcov.info\n' });
  assert.deepEqual(JSON.parse(out('coverage.json')).files['src/a.js'], { inst: 3, exec: 2, never: [[2, 2]], ran: [[1, 1], [3, 3]], miss: [[2, 2]] });
  assert.match(out('coverage.txt'), /^src\/a\.js 2\/3; never executed: L2$/m);
  run({ COVERAGE_FILES: 'nothing/here.info' });
  assert.match(JSON.parse(out('coverage.json')).notes[0], /no file matched coverage_files/);
  assert.equal(out('coverage.txt'), null);
  put(d, 'junk/report.xml', 'not a report');
  run({ COVERAGE_FILES: 'junk/*.xml' });
  assert.deepEqual(JSON.parse(out('coverage.json')).notes, ['junk/report.xml: unrecognised format']);
  run({ COVERAGE_FILES: 'coverage/lcov.info', CTX: path.join(d, 'no-such-ctx') });
});

// ---- V2 coverage gaps: the grouping, filter and ranking in src/post.js ----
const postV2 = require('./post.js');
const gapsFor = (src, never, opts = {}) => {
  const rows = src.split('\n'), p = opts.path || 'a.js';
  const maps = new Map([[p, { RIGHT: new Map(rows.map((_, i) => [i + 1, 1])) }]]);
  const cv = { v: 2, reports: 1, files: { [p]: { never, ran: [], miss: never } } };
  return postV2.coverageGaps({ cov: cv, paths: [p], readLines: () => rows, maps, ...opts });
};
const def = (name, body) => [`function ${name}(x) {`, ...body, '}'];
const keys = (g) => g.emit.map((x) => [x.decl, x.lines]);

test('V2 filter patterns: the exported array pins what is not worth a unit test', () => {
  assert.deepEqual(postV2.NOT_WORTH_TESTING.map((r) => r.id), ['logging', 'constant-or-type', 'forwarding-one-liner', 'forwarding-body', 'structural-punctuation', 'generated-file']);
  const worthless = (l) => postV2.NOT_WORTH_TESTING.some((r) => r.line && r.line.test(l));
  for (const l of ["  console.log('x');", '  logger.warn(m);', '  log.info(m)', '    print(x)', '  logging.debug("a")', 'const MAX_RETRIES = 3;', 'MAX_ITEMS: int = 5', 'export type Id = string;', 'interface Opts {', 'const f = (a) => g(a);', '}']) assert.ok(worthless(l), l);
  // guards, error returns, a one-letter module name, a callback in a chain and a fatal log are NOT noise
  for (const l of ['  if (x) {', '  throw new Error(m);', '  return a + b;', '  return null;', '  return err', '  return 0;', '  save(a, b);', '  const total = compute(a);', '  return cache.get(a) || load(a);', '  } else {', '  log.Fatal(err)', '  X = df[cols]', '  MAX_RETRIES = 3', '    .map((x) => applyDiscount(x))', '  panic(err)', '  sys.exit(1)', '  process.exit(1)']) assert.ok(!worthless(l), l);
  assert.ok(postV2.NOT_WORTH_TESTING.find((r) => r.id === 'generated-file').path.test('src/generated/api.js'));
});

test('V2 filter: guards and error branches are emitted; a pure logging group is still dropped', () => {
  const cases = {
    'JS null guard': [['function load(u) {', '  if (!u) {', '    return null;', '  }', '  return u.id + 1;', '}'], [[3, 3]]],
    'Go error return': [['func load(u int) error {', '\tif err != nil {', '\t\treturn err', '\t}', '\treturn nil', '}'], [[3, 3]]],
    'one-line guard': [['function clamp(x) {', '  if (x<0) { return 0; }', '  return x + 1;', '}'], [[2, 2]]],
    'Python constant and return': [['def train(df, cols):', '    X = df[cols]', '    return model.fit(X)'], [[2, 3]]],
    'callback in a chain': [['function price(items) {', '  const out = items', '    .map((x) => applyDiscount(x));', '  return out.length + 1;', '}'], [[3, 3]]],
    'Go fatal log': [['func main() {', '\tlog.Fatal(err)', '\tstart()', '}'], [[2, 2]]],
  };
  for (const [name, [src, never]] of Object.entries(cases)) assert.equal(gapsFor(src.join('\n'), never).emit.length, 1, name);
  const quiet = gapsFor(def('quiet', ["  console.log('b');", "  console.log('c');"]).join('\n'), [[2, 3]]);
  assert.deepEqual([quiet.emit.length, quiet.filtered], [0, 1]);
});

test('V2 filter: forwarding counts only as the whole body of a one-statement definition', () => {
  const only = gapsFor(['function get() {', '  return this.x;', '}'].join('\n'), [[2, 2]]);
  assert.deepEqual([only.emit.length, only.filtered], [0, 1], 'a getter');
  const wrap = gapsFor(['function send(a, b) {', '  return deliver(a, b);', '}'].join('\n'), [[2, 2]]);
  assert.equal(wrap.emit.length, 0, 'a forwarder');
  const more = gapsFor(['function send(a, b) {', '  prepare(a);', '  return deliver(a, b);', '}'].join('\n'), [[3, 3]]);
  assert.equal(more.emit.length, 1, 'one of several statements is not a forwarder');
  const arrow = gapsFor("const send = (a) => deliver(a);\nfunction other(x) {\n  if (x) {\n    throw e;\n  }\n}", [[1, 1]]);
  assert.equal(arrow.emit.length, 0, 'a const arrow that only forwards');
});

test('V2 groups: the key is the declaration line of the innermost definition, never the name', () => {
  // render() vs mount(): a generic, unusable name no longer climbs to the previous method
  const cls = ['class Widget {', '  mount() {', '    save(a + 1);', '  }', '  render() {', '    if (x) {', '      throw new Error(m);', '    }', '  }', '}'].join('\n');
  assert.deepEqual(keys(gapsFor(cls, [[3, 3], [6, 7]])).sort(), [[2, [3]], [5, [6, 7]]]);
  assert.equal(gapsFor(cls, [[6, 7]]).emit[0].name, 'render');
  assert.match(postV2.gapFinding(gapsFor(cls, [[6, 7]]).emit[0], cls.split('\n')).title, /^definition at L5: 2 added lines never executed by any unit test \(L6-L7\)$/);
  // two classes, one process() each
  const two = ['class A {', '  process(x) {', '    if (x) {', '      throw e;', '    }', '  }', '}', 'class B {', '  process(x) {', '    if (x) {', '      throw e;', '    }', '  }', '}'].join('\n');
  assert.deepEqual(keys(gapsFor(two, [[3, 4], [10, 11]])).sort(), [[2, [3, 4]], [9, [10, 11]]]);
  // code after a function ends is not that function's
  const after = ['function helper(x) {', '  return x;', '}', 'if (flag) {', '  boot();', '}'].join('\n');
  assert.deepEqual(keys(gapsFor(after, [[5, 5]])), [[0, [5]]]);
  assert.equal(postV2.gapFinding(gapsFor(after, [[5, 5]]).emit[0], after.split('\n')).title, 'a.js: 1 added line never executed by any unit test (L5)');
  // a definition longer than 60 lines
  const long = ['function big(x) {', ...Array.from({ length: 80 }, (_, i) => `  a${i}();`), '  if (x) {', '    throw e;', '  }', '}'].join('\n');
  assert.deepEqual(keys(gapsFor(long, [[83, 83]])), [[1, [83]]]);
  // Python __init__ in two classes
  const py = ['class A:', '    def __init__(self, x):', '        if x:', '            raise ValueError(x)', '', 'class B:', '    def __init__(self, x):', '        if x:', '            raise ValueError(x)'].join('\n');
  assert.deepEqual(keys(gapsFor(py, [[4, 4], [9, 9]], { path: 'm.py' })).sort(), [[2, [4]], [7, [9]]]);
  // nested: the inner function wins; the outer keeps its own lines
  const nested = ['function outer(x) {', '  function inner(y) {', '    if (y) {', '      throw e;', '    }', '  }', '  if (x) {', '    throw f;', '  }', '}'].join('\n');
  assert.deepEqual(keys(gapsFor(nested, [[4, 4], [8, 8]])).sort(), [[1, [8]], [2, [4]]]);
});

test('V2 test-map enclosingDef: declaration, name and end', () => {
  const { enclosingDef } = require('./test-map');
  const src = ['class A {', '  render() {', '    return 1;', '  }', '}', 'run();'];
  assert.deepEqual(enclosingDef(src, 3), { line: 2, name: 'render', end: 4 });
  assert.equal(enclosingDef(src, 6), null);
});

test('V2 ranking: branching lines, then size, then focus risk, then a PR-text mention; ties keep file order', () => {
  const body = ['  if (x) {', '    throw new Error(m);', '  }'];
  const plain = ['  a(x);', '  b(x);', '  c(x);'];
  const src = [...def('plainBig', plain), ...def('branchSmall', ['  if (x) {']), ...def('branchBig', body)].join('\n');
  const never = [[2, 4], [7, 7], [10, 12]];
  assert.deepEqual(gapsFor(src, never).emit.map((x) => x.name), ['branchBig', 'branchSmall', 'plainBig']);
  const two = [...def('first', ['  a(x);', '  b(x);']), ...def('second', ['  c(x);', '  d(x);'])].join('\n'), n2 = [[2, 3], [6, 7]];
  assert.deepEqual(gapsFor(two, n2).emit.map((x) => x.name), ['first', 'second'], 'tie keeps file order');
  assert.deepEqual(gapsFor(two, n2, { text: 'covers second here' }).emit.map((x) => x.name), ['second', 'first'], 'the PR text names the definition');
  const sizes = [...def('bigGap', ['  a(x);', '  b(x);', '  c(x);']), ...def('smallGap', ['  d(x + 1);'])].join('\n');
  assert.deepEqual(gapsFor(sizes, [[2, 4], [7, 7]]).emit.map((x) => x.name), ['bigGap', 'smallGap'], 'larger gap first');
  // risk: two equal gaps in two files; the second file is the riskier, so it wins over file order
  const one = def('alphaGap', ['  a(x + 1);']).join('\n'), rows = one.split('\n');
  const maps = new Map(['a.js', 'b.js'].map((p) => [p, { RIGHT: new Map(rows.map((_, i) => [i + 1, 1])) }]));
  const cv = { v: 2, reports: 1, files: { 'a.js': { never: [[2, 2]], ran: [], miss: [] }, 'b.js': { never: [[2, 2]], ran: [], miss: [] } } };
  const rank = (risk) => postV2.coverageGaps({ cov: cv, paths: ['a.js', 'b.js'], readLines: () => rows, maps, risk }).emit.map((x) => x.path);
  assert.deepEqual(rank(new Map()), ['a.js', 'b.js']);
  assert.deepEqual(rank(new Map([['b.js', 4]])), ['b.js', 'a.js']);
});

test('V2 branching: strings, comments, optional chaining and a TypeScript optional are not branches', () => {
  const src = def('check', ['  log("if or && here");', '  const a = obj?.value;', '  const b = c ?? d; // else maybe', '  const e = f ? g : h;', '  if (a) {']).join('\n');
  assert.equal(gapsFor(src, [[2, 6]]).emit[0].branch, 2, 'only the ternary and the if');
  assert.equal(postV2.BRANCHING.test('x ? y : z'), true);
});

test('V2 cap: at most three groups are emitted; the rest are rolled up per file', () => {
  const src = ['one', 'two', 'three', 'four', 'five'].map((n) => def(`gap_${n}`, ['  if (x) {', '    throw e;', '  }']).join('\n')).join('\n');
  const never = [0, 1, 2, 3, 4].map((i) => [i * 5 + 2, i * 5 + 3]);
  const g = gapsFor(src, never);
  assert.equal(g.emit.length, 3);
  assert.deepEqual(g.roll.map((r) => [r.path, r.names]), [['a.js', ['gap_four', 'gap_five']]]);
});

test('V2 rollup line: the path is escaped like every other cited path', () => {
  const g = { decl: 2, name: 'alphaGap', path: 'a`b<!--x.js', absorbed: [] };
  const line = postV2.rollupLine({ path: g.path, groups: [g] });
  assert.doesNotMatch(line, /<!--/);
  assert.equal((line.match(/`/g) || []).length, 2, line);
});

test('V2 gapEvidence: a null file entry in coverage.json does not throw', () => {
  assert.equal(postV2.gapEvidence({ reports: 1, files: { 'a.js': null } }, 'a.js', 3), 'unknown');
  assert.equal(postV2.gapEvidence({ reports: 1, files: { 'a.js': { ran: [[3, 3]], miss: [] } } }, 'a.js', 3), 'ran');
});

test('V2 no report: coverageGaps finds nothing without a usable report', () => {
  assert.deepEqual(postV2.coverageGaps({ cov: null, paths: ['a.js'] }).emit, []);
  assert.deepEqual(postV2.coverageGaps({ cov: { v: 2, reports: 0, files: {} }, paths: ['a.js'] }).emit, []);
});

test('V2 N1: a multi-line signature does not cut the definition (TypeScript, Black-style Python, multi-line arrow)', () => {
  const { enclosingDef } = require('./test-map');
  const ts = ['export function computeTotal(', '  items,', '  discount,', '  tax,', '): number {', '  const a = 1;', '  return a;', '}', 'run();'];
  assert.deepEqual(enclosingDef(ts, 6), { line: 1, name: 'computeTotal', end: 8 });
  assert.equal(enclosingDef(ts, 9), null);
  const py = ['class Svc:', '    def load(', '        self,', '        key,', '    ):', '        return 1', '', '    def save(self, k):', '        return k + 2'];
  assert.equal(enclosingDef(py, 6).line, 2, 'load, not the class');
  assert.equal(enclosingDef(py, 9).line, 8, 'save is its own group');
  const g = gapsFor(py.join('\n'), [[6, 6], [9, 9]], { path: 'm.py' });
  assert.deepEqual(keys(g).sort(), [[2, [6]], [8, [9]]]);
  const arrow = ['const f = (', '  a,', '  b,', ') => {', '  return a;', '};'];
  assert.deepEqual(enclosingDef(arrow, 5), { line: 1, name: 'f', end: 6 });
  assert.equal(enclosingDef(['function f(a = {}) {', '  x();', '}'], 2).end, 3, 'braces inside the parameter list are not the body');
});

test('V2 N3: a one-line block comment holding a brace does not unbalance the span', () => {
  const { enclosingDef } = require('./test-map');
  assert.equal(enclosingDef(['function f(x) { /* } */', '  y();', '}', 'z();'], 2).end, 3);
});

test('V2 S5: the R-a fingerprint follows the definition name, not its line; Rakefile-like paths and same-named definitions are handled', () => {
  const fpOf = (src, path = 'a.js', never = [[3, 3]]) => { const g = gapsFor(src, never, { path }), f = postV2.gapFinding(g.emit[0], src.split('\n')); return { f, fp: postV2.merge([f])[0].fp }; };
  const body = ['function priceItems(x) {', '  if (x) {', '    throw e;', '  }', '}'];
  const a = fpOf(body.join('\n')), b = fpOf(['// new', '// lines', ...body].join('\n'), 'a.js', [[5, 5]]);
  assert.notEqual(a.f.line, b.f.line);
  assert.equal(a.fp, b.fp, 'lines added above the function do not repost it');
  assert.notEqual(fpOf(body.join('\n').replace('priceItems', 'otherItems')).fp, a.fp);
  const rake = fpOf(body.join('\n'), 'Rakefile');
  assert.notEqual(rake.fp, fpOf(body.join('\n').replace('priceItems', 'otherItems'), 'Rakefile').fp, 'a path without dot or slash still keys on the definition');
  const noQuote = fpOf(body.join('\n').replace('throw e;', 'throw f;'), 'Rakefile');
  assert.equal(noQuote.fp, rake.fp, 'a Rakefile finding is not keyed on its quote');
  const dup = ['class A {', '  process(x) {', '    if (x) {', '      throw e;', '    }', '  }', '}', 'class B {', '  process(x) {', '    if (x) {', '      throw e;', '    }', '  }', '}'].join('\n');
  const g = gapsFor(dup, [[3, 4], [10, 11]]);
  const fps = g.emit.map((x) => postV2.merge([postV2.gapFinding(x, dup.split('\n'))])[0].fp);
  assert.equal(new Set(fps).size, 2, 'two methods of one name keep distinct fingerprints');
});

test('V2 gapEvidence: none without a report, never for a never-run line, ran for an executed changed line, unknown otherwise', () => {
  assert.equal(postV2.gapEvidence(null, 'src.js', 3), 'none');
  assert.equal(postV2.gapEvidence({ reports: 0, files: {} }, 'src.js', 3), 'none');
  const never = { reports: 1, files: { 'src.js': { never: [[3, 3]], miss: [[3, 3]], ran: [] } } };
  assert.equal(postV2.gapEvidence(never, 'src.js', 3), 'never');
  const ran = { reports: 1, files: { 'src.js': { ran: [[1, 2]], miss: [] } } };
  assert.equal(postV2.gapEvidence(ran, 'src.js', 1), 'ran');
  assert.equal(postV2.gapEvidence(ran, 'src.js', 5), 'unknown', 'a line the report does not mention');
  assert.equal(postV2.gapEvidence(ran, 'other.js', 1), 'unknown', 'a file outside the changed set');
});

test("analyze mode 'all' (scan): every instrumented line of every non-test file is reported as never or ran, with no diff; mode: all is stamped", () => {
  const lcov = 'SF:/ci/src/a.js\nDA:1,3\nDA:2,0\nDA:3,0\nDA:5,1\nend_of_record\nSF:/ci/src/a.test.js\nDA:1,1\nend_of_record\nSF:/ci/src/b.js\nDA:1,0\nend_of_record\n';
  const run = (mode) => cov.analyze({ files: ['src/a.js', 'src/b.js', 'src/a.test.js'], reports: [{ name: 'lcov.info', text: lcov }], ws: '/ci', mode });
  const r = run('all').json;
  assert.equal(r.v, 2);
  assert.equal(r.mode, 'all');
  assert.deepEqual(r.files['src/a.js'].never, [[2, 3]]);
  assert.deepEqual(r.files['src/a.js'].ran, [[1, 1], [5, 5]]);
  assert.deepEqual(r.files['src/b.js'].never, [[1, 1]]);
  assert.equal(r.files['src/a.test.js'], undefined, 'a test file is not source');
  assert.deepEqual(r.total, { instrumented: 5, executed: 2 });
  assert.equal(run('all').txt, '');
  assert.deepEqual(run('diff').json.files['src/a.js'].never, [], 'diff mode with no added lines reports nothing');
  assert.equal(run('diff').json.mode, undefined);
});

test("analyze mode 'all': the file and range caps still apply and set truncated; the files with the most never-run lines survive", () => {
  const many = Array.from({ length: 405 }, (_, i) => `SF:/ci/f${i}.js\nDA:1,${i === 404 ? 0 : 1}\nend_of_record\n`).join('');
  const files = Array.from({ length: 405 }, (_, i) => `f${i}.js`);
  const r = cov.analyze({ files, reports: [{ name: 'l', text: many }], ws: '/ci', mode: 'all' }).json;
  assert.equal(Object.keys(r.files).length, 400);
  assert.equal(r.truncated, true);
  assert.ok(r.files['f404.js'], 'the file with a never-run line is kept');
  const odd = Array.from({ length: 700 }, (_, i) => `DA:${i * 2 + 1},${i % 2}`).join('\n');
  const r2 = cov.analyze({ files: ['a.js'], reports: [{ name: 'l', text: `SF:a.js\n${odd}\nend_of_record\n` }], mode: 'all' }).json;
  assert.equal(r2.files['a.js'].never.length, 300);
  assert.equal(r2.truncated, true);
  assert.equal(cov.analyze({ files: ['a.js'], reports: [{ name: 'l', text: 'SF:a.js\nDA:1,1\nend_of_record\n' }], mode: 'all' }).json.truncated, undefined);
});
