const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { matches, scopeOf, build } = require('./standards-map');

test('glob: * stays inside a directory, ** crosses them, ? is one non-slash character', () => {
  assert.ok(matches(['src/*.js'], 'src/a.js'));
  assert.ok(!matches(['src/*.js'], 'src/lib/a.js'));
  assert.ok(matches(['src/**'], 'src/lib/deep/a.js'));
  assert.ok(!matches(['src/**'], 'other/a.js'));
  assert.ok(matches(['**/*.ts'], 'a.ts') && matches(['**/*.ts'], 'x/y/a.ts')); // leading **/ also matches zero directories
  assert.ok(matches(['src/**/a.js'], 'src/a.js') && matches(['src/**/a.js'], 'src/x/y/a.js'));
  assert.ok(matches(['a?.js'], 'ab.js') && !matches(['a?.js'], 'a/.js') && !matches(['a?.js'], 'a.js'));
  assert.ok(matches(['**'], 'anything/at/all.md'));
});

test('glob: dots and regex characters are literal; a slash-free glob also matches the basename at any depth', () => {
  assert.ok(!matches(['a.js'], 'abjs'));
  assert.ok(matches(['(x)+.js'], '(x)+.js'));
  assert.ok(matches(['*.py'], 'pkg/sub/mod.py'));
  assert.ok(!matches(['pkg/*.py'], 'other/pkg/mod.py'));
  assert.ok(matches(['./src/**'], 'src/a.js')); // leading ./ is ignored
  assert.ok(!matches([], 'src/a.js')); // an empty scope applies nowhere
});

test('scope: Copilot applyTo (comma separated, quoted), Claude paths (list, inline, scalar), directory-scoped AGENTS.md, others everywhere', () => {
  const cop = '.github/instructions/ts.instructions.md';
  assert.deepEqual(scopeOf(cop, '---\napplyTo: "**/*.ts, src/**/*.tsx"\n---\nbody'), ['**/*.ts', 'src/**/*.tsx']);
  assert.deepEqual(scopeOf(cop, "---\r\napplyTo: '**'\r\n---\r\nbody"), ['**']);
  assert.deepEqual(scopeOf(cop, 'no frontmatter'), ['**']);
  assert.deepEqual(scopeOf('.github/instructions/a/b.instructions.md', '---\ndescription: x\n---\n'), ['**']);
  const rule = '.claude/rules/api.md';
  assert.deepEqual(scopeOf(rule, '---\npaths:\n  - "src/api/**"\n  - lib/*.js\n---\n'), ['src/api/**', 'lib/*.js']);
  assert.deepEqual(scopeOf(rule, '---\npaths: ["a/**", b/**]\n---\n'), ['a/**', 'b/**']);
  assert.deepEqual(scopeOf(rule, '---\npaths: src/**\n---\n'), ['src/**']);
  assert.deepEqual(scopeOf(rule, '# no frontmatter'), ['**']);
  assert.deepEqual(scopeOf('AGENTS.md', 'x'), ['**']);
  assert.deepEqual(scopeOf('pkg/web/AGENTS.md', 'x'), ['pkg/web/**']);
  assert.deepEqual(scopeOf('pkg/CLAUDE.md', 'x'), ['pkg/**']);
  assert.deepEqual(scopeOf('docs/testing-standards.md', 'x'), ['**']);
});

test('build reads each listed rule file and labels its kind', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-map-'));
  try {
    const put = (p, t) => { fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true }); fs.writeFileSync(path.join(dir, p), t); };
    put('.github/instructions/py.instructions.md', '---\napplyTo: "**/*.py"\n---\n');
    put('.claude/rules/web.md', '---\npaths:\n  - web/**\n---\n');
    put('svc/AGENTS.md', 'x');
    put('CONTRIBUTING.md', 'x');
    const map = build(['.github/instructions/py.instructions.md', '.claude/rules/web.md', 'svc/AGENTS.md', 'CONTRIBUTING.md', 'missing.md'], (p) => fs.readFileSync(path.join(dir, p), 'utf8'));
    assert.deepEqual(map, [
      { path: '.github/instructions/py.instructions.md', scope: ['**/*.py'], kind: 'copilot' },
      { path: '.claude/rules/web.md', scope: ['web/**'], kind: 'claude-rule' },
      { path: 'svc/AGENTS.md', scope: ['svc/**'], kind: 'agents' },
      { path: 'CONTRIBUTING.md', scope: ['**'], kind: 'repo' },
      { path: 'missing.md', scope: ['**'], kind: 'repo' }, // unreadable: claim nothing about where it does not apply
    ]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
