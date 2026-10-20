const test = require('node:test');
const assert = require('node:assert');
const { buildUnits, makeB, isCatch } = require('./testgap-score');

const src = ['function alpha(x) {', '  return x + 1;', '}', '', 'function beta(y) {', '  const z = y * 2;', '  return z;', '}'];

test('unit builder: maximal runs of one enclosing name', () => {
  const u = buildUnits(src).filter((x) => x.name);
  assert.deepStrictEqual(u.map((x) => x.name), ['alpha', 'beta']);
  assert.ok(u[0].start === 1 && u[1].end === 8);
});

test('B: named unit contributes its span, null-name line only +-3', () => {
  const units = { 'a.js': buildUnits(src) };
  const B = makeB([{ path: 'a.js', line: 6 }], units);
  assert.ok(B.has('a.js', 5) && B.has('a.js', 8)); // whole beta span
  assert.ok(!B.has('a.js', 1) && !B.has('b.js', 6));
  const B2 = makeB([{ path: 'a.js', line: 20 }], { 'a.js': buildUnits(Array(30).fill('x = 1;')) });
  assert.ok(B2.has('a.js', 23) && !B2.has('a.js', 24) && !B2.has('a.js', 16));
});

test('low confidence or non-test kind is never a catch', () => {
  const B = makeB([{ path: 'a.js', line: 6 }], { 'a.js': buildUnits(src) });
  const f = { where: 'inline', kind: 'missing_test', path: 'a.js', line: 6, confidence: 'high' };
  assert.ok(isCatch(f, B));
  assert.ok(!isCatch({ ...f, confidence: 'low' }, B));
  assert.ok(!isCatch({ ...f, confidence: null, why: 'reduced review; low confidence' }, B));
  assert.ok(!isCatch({ ...f, kind: 'spec_mismatch' }, B));
  assert.ok(!isCatch({ ...f, line: null }, B));
});

test('testsName: whole-word match in test files at head (git grep -l, not -q)', () => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), cp = require('node:child_process');
  const { testsName } = require('./testgap-score');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tn-'));
  try {
    const g = (...a) => cp.execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: dir, stdio: 'pipe' });
    g('init', '-q');
    fs.writeFileSync(path.join(dir, 'a.test.js'), 'fooBar();\n');
    fs.writeFileSync(path.join(dir, 'b.test.js'), 'other();\n');
    g('add', '.'); g('commit', '-q', '-m', 'x');
    const files = ['a.test.js', 'b.test.js'];
    assert.strictEqual(testsName(dir, 'HEAD', files, 'fooBar'), true);
    assert.strictEqual(testsName(dir, 'HEAD', files, 'bazQux'), false);
    assert.strictEqual(testsName(dir, 'HEAD', files, 'fooBa'), false);
    assert.strictEqual(testsName(dir, 'HEAD', [], 'fooBar'), false);
    assert.throws(() => testsName(dir, 'no-such-rev', files, 'fooBar')); // exit 128 is an error, not 'no match'
    const many = Array.from({ length: 120 }, (_, i) => 'x' + i + '.test.js'); // spans 3 batches, the match is in the last
    assert.strictEqual(testsName(dir, 'HEAD', [...many, 'a.test.js'], 'fooBar'), true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('isCode: code files only, no lockfiles, manifests or .github scripts', () => {
  const { isCode } = require('./testgap-score');
  for (const f of ['libs/core/uv.lock', 'package.json', 'pyproject.toml', 'jsr.json', '.github/scripts/check_diff.py', 'libs/core/tests/test_a.py', 'README.md']) assert.strictEqual(isCode(f), false, f);
  for (const f of ['src/a.ts', 'libs/core/langchain_core/x.py', 'sqlglot/parser.py']) assert.strictEqual(isCode(f), true, f);
});

test('qualifies: only code files count as source; package.json, lockfiles and .github scripts do not', () => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), cp = require('node:child_process');
  const { qualifies } = require('./testgap-score');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ql-'));
  try {
    const g = (...a) => cp.execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: dir, stdio: 'pipe', encoding: 'utf8' }).trim();
    const w = (f, t) => { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), t); };
    g('init', '-q');
    const body = (v) => `function computeTotals() {\n  return ${v};\n}\n`;
    w('package.json', '{"name": "computeTotals", "v": 1}\n'); w('uv.lock', 'computeTotals = 1\n'); w('.github/scripts/x.py', 'def computeTotals():\n    return 1\n'); w('src/a.ts', body(1)); w('test/a.test.ts', 'x();\n');
    g('add', '-A'); g('commit', '-q', '-m', 'base'); const base = g('rev-parse', 'HEAD');
    // fix 1: only non-code files change, and the added test names the definition
    w('package.json', '{"name": "computeTotals", "v": 2}\n'); w('uv.lock', 'computeTotals = 2\n'); w('.github/scripts/x.py', 'def computeTotals():\n    return 2\n'); w('test/a.test.ts', 'computeTotals();\n');
    g('add', '-A'); g('commit', '-q', '-m', 'noncode'); const f1 = g('rev-parse', 'HEAD');
    const q1 = qualifies(dir, f1);
    assert.strictEqual(q1.src, false); assert.strictEqual(q1.ok, false);
    // fix 2: a real .ts change plus a test naming it
    w('src/a.ts', body(2)); w('test/a.test.ts', 'computeTotals();\ncomputeTotals();\n');
    g('add', '-A'); g('commit', '-q', '-m', 'code'); const f2 = g('rev-parse', 'HEAD');
    const q2 = qualifies(dir, f2);
    assert.strictEqual(q2.src, true); assert.strictEqual(q2.ok, true);
    assert.ok(base);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
