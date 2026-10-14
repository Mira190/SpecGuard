const test = require('node:test');
const assert = require('node:assert');
const { pin, LINE } = require('./pin-reusable.js');

const SHA = 'a'.repeat(40), SHA2 = 'b'.repeat(40);
const yml = (ref = SHA) => `jobs:\n  review:\n    steps:\n      - uses: Mira190/SpecGuard@${ref} # specguard-pin\n`;

test('pin: rewrites the sha, keeping the repo, prefix and marker; other lines untouched', () => {
  const out = pin(`before\n${yml()}after\n`, SHA2);
  assert.match(out, new RegExp(`- uses: Mira190/SpecGuard@${SHA2} # specguard-pin`));
  assert.ok(out.startsWith('before\n') && out.endsWith('after\n'));
  assert.doesNotMatch(out, new RegExp(SHA)); // old sha gone
});

test('pin: repo argument replaces owner/repo on the pinned line', () => {
  const out = pin(yml(), SHA2, 'Fork/Copy');
  assert.match(out, new RegExp(`- uses: Fork/Copy@${SHA2} # specguard-pin`));
});

test('pin: only the # specguard-pin line is rewritten, not other pinned actions', () => {
  const text = `      - uses: actions/checkout@${SHA} # v6.1.0\n${yml()}`;
  const out = pin(text, SHA2);
  assert.match(out, new RegExp(`actions/checkout@${SHA} # v6.1.0`)); // untouched
  assert.match(out, new RegExp(`Mira190/SpecGuard@${SHA2} # specguard-pin`));
});

test('pin: rejects a non-full sha, a malformed repo, and a file without the marker', () => {
  assert.throws(() => pin(yml(), 'abc123'), /not a full commit sha/);
  assert.throws(() => pin(yml(), SHA2, 'noslash'), /not owner\/repo/);
  assert.throws(() => pin('nothing here\n', SHA2), /no "# specguard-pin" line found/);
});
