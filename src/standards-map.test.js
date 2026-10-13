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

test('braces: {a,b} expands in a glob, commas inside braces do not split the list', () => {
  assert.ok(matches(['**/*.{ts,tsx}'], 'src/a/b.tsx') && matches(['**/*.{ts,tsx}'], 'x.ts') && !matches(['**/*.{ts,tsx}'], 'src/b.js'));
  assert.ok(matches(['src/**/*.{ts,tsx}'], 'src/a/b.ts') && !matches(['src/**/*.{ts,tsx}'], 'lib/b.ts'));
  assert.ok(matches(['*.{py,pyi}'], 'pkg/m.pyi')); // slash-free: basename at any depth
  assert.ok(matches(['{src,lib}/**'], 'lib/a.js') && !matches(['{src,lib}/**'], 'test/a.js'));
  assert.ok(matches(['a/{b,c{d,e}}.js'], 'a/ce.js')); // nested works too
  assert.ok(matches(['a{.js'], 'a{.js')); // an unmatched brace stays literal
  const cop = '.github/instructions/ts.instructions.md';
  assert.deepEqual(scopeOf(cop, '---\napplyTo: "**/*.{ts,tsx}"\n---\n'), ['**/*.{ts,tsx}']);
  assert.deepEqual(scopeOf(cop, '---\napplyTo: "src/**/*.{js,jsx},test/**"\n---\n'), ['src/**/*.{js,jsx}', 'test/**']);
  assert.deepEqual(scopeOf('.claude/rules/a.md', '---\npaths: ["src/**/*.{ts,tsx}", lib/**]\n---\n'), ['src/**/*.{ts,tsx}', 'lib/**']);
  assert.deepEqual(scopeOf('.claude/rules/a.md', '---\npaths:\n  - "src/**/*.{ts,tsx}"\n---\n'), ['src/**/*.{ts,tsx}']);
});

test('directory scope ignores the tool folder: .claude/CLAUDE.md is repo-wide, x/.claude/CLAUDE.md and x/.cursor/BUGBOT.md govern x/', () => {
  assert.deepEqual(scopeOf('.claude/CLAUDE.md', 'x'), ['**']);
  assert.deepEqual(scopeOf('services/api/.claude/CLAUDE.md', 'x'), ['services/api/**']);
  assert.deepEqual(scopeOf('.cursor/BUGBOT.md', 'x'), ['**']);
  assert.deepEqual(scopeOf('services/api/.cursor/BUGBOT.md', 'x'), ['services/api/**']);
  assert.deepEqual(scopeOf('pkg/BUGBOT.md', 'x'), ['pkg/**']);
  assert.deepEqual(scopeOf('pkg/.cursor/AGENTS.md', 'x'), ['pkg/**']);
  assert.deepEqual(scopeOf('pkg/.claudex/CLAUDE.md', 'x'), ['pkg/.claudex/**']); // only the exact folder names
  assert.ok(matches(scopeOf('.claude/CLAUDE.md', 'x'), 'src/a.js'));
});

test('Cursor rules: globs (comma, list, braces) scope, alwaysApply is repo-wide, neither is repo-wide with unknown scope', () => {
  const r = '.cursor/rules/ts.mdc';
  assert.deepEqual(scopeOf(r, '---\ndescription: x\nglobs: src/**/*.ts, lib/*.{js,jsx}\nalwaysApply: false\n---\n'), ['src/**/*.ts', 'lib/*.{js,jsx}']);
  assert.deepEqual(scopeOf(r, '---\nglobs:\n  - "a/**"\n  - b/**\n---\n'), ['a/**', 'b/**']);
  assert.deepEqual(scopeOf(r, '---\nglobs: ["a/**", b/**]\n---\n'), ['a/**', 'b/**']);
  assert.deepEqual(scopeOf(r, '---\nalwaysApply: true\n---\n'), ['**']);
  assert.deepEqual(scopeOf(r, '---\nglobs: src/**\nalwaysApply: true\n---\n'), ['**']); // alwaysApply wins
  assert.deepEqual(scopeOf(r, '---\ndescription: only when asked\n---\n'), ['**']);
  assert.deepEqual(scopeOf('.cursor/rules/plain.md', 'no frontmatter'), ['**']);
  const mk = (text) => build([r], () => text)[0];
  assert.deepEqual(mk('---\nglobs: src/**\n---\n'), { path: r, scope: ['src/**'], kind: 'cursor-rule' });
  assert.deepEqual(mk('---\nalwaysApply: true\n---\n'), { path: r, scope: ['**'], kind: 'cursor-rule' });
  assert.deepEqual(mk('---\nalwaysApply: false\n---\n'), { path: r, scope: ['**'], kind: 'cursor-rule', unknown: true });
  assert.equal(build(['.cursorrules'], () => 'x')[0].unknown, undefined); // legacy file: ordinary repo-wide rule
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

test('F4: root BUGBOT.md, styleguide and STANDARDS_PATHS docs apply repo-wide unless they carry their own applyTo', () => {
  for (const p of ['.cursor/BUGBOT.md', '.gemini/styleguide.md', '.greptile/rules.md', 'docs/team-style.md']) {
    assert.deepEqual(scopeOf(p, 'Always check tests.'), ['**'], p);
    assert.equal(build([p], () => 'x')[0].kind, 'repo');
  }
  assert.deepEqual(scopeOf('.gemini/styleguide.md', '---\napplyTo: "src/**/*.ts"\n---\nbody'), ['src/**/*.ts']);
  assert.deepEqual(scopeOf('docs/team-style.md', '---\r\napplyTo: "**/*.py, tools/**"\r\n---\r\n'), ['**/*.py', 'tools/**']);
});
