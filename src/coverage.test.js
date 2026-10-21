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
  const rows = src.split('\n');
  const maps = new Map([['a.js', { RIGHT: new Map(rows.map((_, i) => [i + 1, 1])) }]]);
  const cv = { v: 2, reports: 1, files: { 'a.js': { never, ran: [], miss: never } } };
  return postV2.coverageGaps({ cov: cv, paths: ['a.js'], readLines: () => rows, maps, ...opts });
};
const def = (name, body) => [`function ${name}(x) {`, ...body, '}'];

test('V2 filter patterns: the exported array pins what is not worth a unit test', () => {
  assert.deepEqual(postV2.NOT_WORTH_TESTING.map((r) => r.id), ['logging', 'constant-or-type', 'forwarding-one-liner', 'structural-punctuation', 'generated-file']);
  const worthless = (l) => postV2.NOT_WORTH_TESTING.some((r) => r.line && r.line.test(l));
  for (const l of ["  console.log('x');", '  logger.warn(m);', '  log.info(m)', '    print(x)', '  logging.debug("a")', '  const MAX_RETRIES = 3;', '  MAX_ITEMS: int = 5', 'export type Id = string;', 'interface Opts {', '  return x;', '  return wrap(a, b);', 'const f = (a) => g(a);', '}']) assert.ok(worthless(l), l);
  for (const l of ['  if (x) {', '  throw new Error(m);', '  return a + b;', '  save(a, b);', '  const total = compute(a);', '  return cache.get(a) || load(a);', '  } else {']) assert.ok(!worthless(l), l);
  assert.ok(postV2.NOT_WORTH_TESTING.find((r) => r.id === 'generated-file').path.test('src/generated/api.js'));
});

test('V2 groups: never-run lines are grouped by enclosing definition; a mixed group (logging plus a branch) is kept, a generated file is dropped', () => {
  const src = [...def('keep', ["  console.log('a');", '  if (x) {', '    return 1;', '  }']), ...def('quiet', ["  console.log('b');", "  console.log('c');"])].join('\n');
  const g = gapsFor(src, [[2, 3], [8, 9]]);
  assert.deepEqual(g.emit.map((x) => [x.name, x.lines]), [['keep', [2, 3]]]);
  assert.equal(g.filtered, 1);
  assert.equal(gapsFor(src, [[2, 3]], { paths: ['dist/a.js'], maps: new Map([['dist/a.js', { RIGHT: new Map([[2, 1], [3, 1]]) }]]), cov: { v: 2, reports: 1, files: { 'dist/a.js': { never: [[2, 3]], ran: [], miss: [] } } } }).filtered, 1);
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
  const risk = new Map([['a.js', 5]]);
  const sizes = [...def('bigGap', ['  a(x);', '  b(x);', '  c(x);']), ...def('smallGap', ['  d(x);'])].join('\n');
  assert.deepEqual(gapsFor(sizes, [[2, 4], [7, 7]], { risk }).emit.map((x) => x.name), ['bigGap', 'smallGap'], 'larger gap first');
});

test('V2 cap: at most three groups are emitted; the rest are rolled up per file', () => {
  const src = ['one', 'two', 'three', 'four', 'five'].map((n) => def(`gap_${n}`, ['  if (x) {', '    throw e;', '  }']).join('\n')).join('\n');
  const never = [0, 1, 2, 3, 4].map((i) => [i * 5 + 2, i * 5 + 3]);
  const g = gapsFor(src, never);
  assert.equal(g.emit.length, 3);
  assert.deepEqual(g.roll, [{ path: 'a.js', names: ['gap_four', 'gap_five'] }]);
});

test('V2 no report: coverageGaps finds nothing without a usable report', () => {
  assert.deepEqual(postV2.coverageGaps({ cov: null, paths: ['a.js'] }).emit, []);
  assert.deepEqual(postV2.coverageGaps({ cov: { v: 2, reports: 0, files: {} }, paths: ['a.js'] }).emit, []);
});
