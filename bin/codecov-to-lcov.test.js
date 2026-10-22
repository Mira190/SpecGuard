'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { convert, convertText, MAX_BYTES } = require('./codecov-to-lcov.js');

const rep = (name, lc) => ({ totals: {}, files: [{ name, line_coverage: lc }] });

test('hit and partial become DA:n,1, miss becomes DA:n,0, with counts', () => {
  const { lcov, counts } = convert(rep('src/a.js', [[1, 0], [2, 1], [3, 2]]));
  assert.equal(lcov, 'SF:src/a.js\nDA:1,1\nDA:2,0\nDA:3,1\nend_of_record\n');
  assert.deepEqual(counts, { files: 1, hit: 1, miss: 1, partial: 1 });
});

test('files without line data are skipped; an empty report gives empty LCOV', () => {
  const { lcov, counts } = convert(rep('src/a.js', []));
  assert.equal(lcov, '');
  assert.equal(counts.files, 0);
});

test('unsafe paths are refused: absolute, .., NUL, drive letter, empty, newline', () => {
  for (const p of ['/etc/passwd', '../x.js', 'a/../../x.js', 'a\\..\\x.js', 'a\0b.js', 'C:\\x.js', '', 'a\nSF:b']) {
    assert.throws(() => convert(rep(p, [[1, 0]])), /refused file path/, JSON.stringify(p));
  }
});

test('other shapes are refused with a clear error', () => {
  for (const bad of [null, [], {}, { files: 'x' }, { files: [null] }, { files: [{ name: 'a' }] }, rep('a', [[0, 0]]), rep('a', [[1, 7]]), rep('a', ['x'])]) {
    assert.throws(() => convert(bad), /not a Codecov report/, JSON.stringify(bad));
  }
  assert.throws(() => convertText('not json'), /not valid JSON/);
});

test('input over 50 MB is refused (text and CLI)', () => {
  assert.throws(() => convertText(' '.repeat(MAX_BYTES + 1)), /50 MB/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c2l-'));
  const f = path.join(dir, 'big.json');
  fs.writeFileSync(f, ' '.repeat(MAX_BYTES + 1));
  const r = spawnSync(process.execPath, [path.join(__dirname, 'codecov-to-lcov.js'), f, path.join(dir, 'o.lcov')], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /50 MB/);
  assert.ok(!fs.existsSync(path.join(dir, 'o.lcov')));
});

test('CLI writes the LCOV and prints counts to stderr', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c2l-'));
  const f = path.join(dir, 'r.json');
  fs.writeFileSync(f, JSON.stringify(rep('src/a.js', [[1, 0], [2, 1]])));
  const r = spawnSync(process.execPath, [path.join(__dirname, 'codecov-to-lcov.js'), f, path.join(dir, 'o.lcov')], { encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.deepEqual(JSON.parse(r.stderr), { files: 1, hit: 1, miss: 1, partial: 0 });
  assert.equal(fs.readFileSync(path.join(dir, 'o.lcov'), 'utf8'), 'SF:src/a.js\nDA:1,1\nDA:2,0\nend_of_record\n');
});
