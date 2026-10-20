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
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
