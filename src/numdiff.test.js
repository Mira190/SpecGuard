const test = require('node:test');
const assert = require('node:assert/strict');
const { numberDiff } = require('./numdiff.js');

const patch = [
  'diff --git a/a.js b/a.js', 'index 1..2 100644', '--- a/a.js', '+++ b/a.js',
  '@@ -3,4 +3,4 @@ fn', ' keep1', '-old', '+new1', '+new2', ' keep2',
  '@@ -20,2 +21,2 @@', ' x', '-y', '+z', '\ No newline at end of file',
  'diff --git a/n.js b/n.js', 'new file mode 100644', '--- /dev/null', '+++ b/n.js',
  '@@ -0,0 +1,2 @@', '+one', '++ looks like a header', '',
].join('\n');

test('numberDiff: adds and context carry new-side numbers, deletes old-side, multiple hunks and files', () => {
  assert.deepEqual(numberDiff(patch).split('\n'), [
    'diff --git a/a.js b/a.js', 'index 1..2 100644', '--- a/a.js', '+++ b/a.js',
    '@@ -3,4 +3,4 @@ fn', '   3 |  keep1', '   4 | -old', '   4 | +new1', '   5 | +new2', '   6 |  keep2',
    '@@ -20,2 +21,2 @@', '  21 |  x', '  21 | -y', '  22 | +z', '\ No newline at end of file',
    'diff --git a/n.js b/n.js', 'new file mode 100644', '--- /dev/null', '+++ b/n.js',
    '@@ -0,0 +1,2 @@', '   1 | +one', '   2 | ++ looks like a header', '',
  ]);
});

test('numberDiff: CRLF is dropped and gives the same numbers; a blank context line counts', () => {
  assert.equal(numberDiff(patch.replace(/\n/g, '\r\n')), numberDiff(patch));
  assert.equal(numberDiff('@@ -1,2 +1,3 @@\n a\n\n+b\n'), '@@ -1,2 +1,3 @@\n   1 |  a\n   2 |  \n   3 | +b\n');
});

test('numberDiff: a hunk cut short does not swallow the next file, and a single-line hunk header works', () => {
  const t = numberDiff(['diff --git a/x b/x', '@@ -1,5 +1,5 @@', ' a', 'diff --git a/y b/y', '@@ -7 +7 @@', '-p', '+q'].join('\n')).split('\n');
  assert.deepEqual(t, ['diff --git a/x b/x', '@@ -1,5 +1,5 @@', '   1 |  a', 'diff --git a/y b/y', '@@ -7 +7 @@', '   7 | -p', '   7 | +q']);
});
