const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { parseRepo, resolveEntry, resolveList, resolve } = require('./resolve-inputs.js');

const R = 'acme/shop';
const err = (fn, re) => assert.throws(fn, re);

test('repo: owner/name, URLs (.git, trailing parts), a /pull/N URL also gives the PR; anything else is an error', () => {
  assert.deepEqual(parseRepo('acme/shop'), { repo: 'acme/shop', pr: '' });
  assert.deepEqual(parseRepo('https://github.com/acme/shop'), { repo: 'acme/shop', pr: '' });
  assert.deepEqual(parseRepo('https://github.com/acme/shop.git'), { repo: 'acme/shop', pr: '' });
  assert.deepEqual(parseRepo('  https://www.github.com/Acme/Shop/tree/main/docs  '), { repo: 'Acme/Shop', pr: '' });
  assert.deepEqual(parseRepo('https://github.com/acme/shop/pull/42/files'), { repo: 'acme/shop', pr: '42' });
  err(() => parseRepo(''), /repo is required/);
  err(() => parseRepo('shop'), /owner\/name/);
  err(() => parseRepo('https://gitlab.com/acme/shop'), /must be on github\.com/);
  err(() => parseRepo('https://github.com/acme'), /no owner\/name/);
  err(() => parseRepo('acme/shop/extra'), /owner\/name/);
  err(() => parseRepo('acme/..'), /owner\/name|invalid repository name/);
});

test('paths: plain paths and globs are normalised, a folder gets a trailing slash, ! excludes survive, .. and absolute escapes cannot leave the repo', () => {
  assert.equal(resolveEntry('docs/design.md', R), 'docs/design.md');
  assert.equal(resolveEntry('./docs\\design.md', R), 'docs/design.md');
  assert.equal(resolveEntry('/docs/design.md', R), 'docs/design.md');
  assert.equal(resolveEntry('docs/specs/**', R), 'docs/specs/**');
  assert.equal(resolveEntry('docs/specs', R), 'docs/specs/');
  assert.equal(resolveEntry('tests/', R), 'tests/');
  assert.equal(resolveEntry('!docs/old', R), '!docs/old/');
  assert.equal(resolveEntry('! docs/old/*.md', R), '!docs/old/*.md');
  err(() => resolveEntry('../secrets.md', R), /invalid path/);
  err(() => resolveEntry('docs/../../x.md', R), /invalid path/);
  err(() => resolveEntry('a\u0007b.md', R), /control character/);
  assert.equal(resolveList('a.md\n\n a.md \r\nb/\n', R), 'a.md\nb/');
  assert.equal(resolveList('', R), '');
});

test('URLs of the same repository become repo-relative paths: blob = file, tree = folder, query and fragment dropped, case-insensitive owner/name', () => {
  assert.equal(resolveEntry('https://github.com/acme/shop/blob/main/docs/design/pay.md', R), 'docs/design/pay.md');
  assert.equal(resolveEntry('https://github.com/ACME/Shop/blob/main/docs/design/pay.md?plain=1#L10-L20', R), 'docs/design/pay.md');
  assert.equal(resolveEntry('https://github.com/acme/shop/tree/main/spec/unit', R), 'spec/unit/');
  assert.equal(resolveEntry('https://github.com/acme/shop/tree/v1.2.3/spec/unit/', R), 'spec/unit/');
  assert.equal(resolveEntry('!https://github.com/acme/shop/tree/main/docs/old', R), '!docs/old/');
  assert.equal(resolveEntry('https://github.com/acme/shop/blob/main/docs/a%20b.md', R), 'docs/a b.md');
  assert.equal(resolveEntry('https://raw.githubusercontent.com/acme/shop/main/docs/design.md', R), 'docs/design.md');
  // a branch name with a slash is split correctly when the ref input names it; otherwise the first segment is the ref
  assert.equal(resolveEntry('https://github.com/acme/shop/blob/feat/x/docs/design.md', R, 'feat/x'), 'docs/design.md');
  assert.equal(resolveEntry('https://github.com/acme/shop/blob/feat/x/docs/design.md', R), 'x/docs/design.md');
  err(() => resolveEntry('https://github.com/acme/shop/tree/main', R), /repository root/);
  err(() => resolveEntry('https://github.com/acme/shop', R), /not a file or folder link/);
  err(() => resolveEntry('https://github.com/acme/shop/issues/3', R), /not a file or folder link/);
});

test('URLs of another repository are rejected with the reason; non-GitHub URLs say they are not readable from GitHub Actions', () => {
  err(() => resolveEntry('https://github.com/other/repo/blob/main/docs/a.md', R), /points into other\/repo, not the target repository acme\/shop; other repositories are not supported yet/);
  err(() => resolveEntry('https://raw.githubusercontent.com/other/repo/main/a.md', R), /points into other\/repo/);
  for (const u of ['https://acme.atlassian.net/wiki/spaces/X/pages/1', 'https://docs.google.com/document/d/abc/edit', 'https://notion.so/page', 'http://example.com/a.md', 'https://gitlab.com/acme/shop/-/blob/main/a.md']) {
    err(() => resolveEntry(u, R), /is not readable from GitHub Actions; add the document to the repository or paste it/);
  }
});

test('mode and PR: auto = pr when a PR is given else scan (audit is an alias of scan); pr mode needs a PR; bad numbers and refs are rejected; the three lists resolve together', () => {
  const base = { REPO: 'acme/shop' };
  assert.equal(resolve(base).mode, 'scan');
  assert.equal(resolve({ ...base, MODE: 'scan' }).mode, 'scan');
  assert.equal(resolve({ ...base, MODE: 'audit' }).mode, 'scan', 'audit is accepted and normalised to scan');
  assert.deepEqual(resolve({ ...base, PR: '12' }), { repo: 'acme/shop', pr: '12', ref: '', mode: 'pr', design: '', rules: '', tests: '' });
  assert.equal(resolve({ REPO: 'https://github.com/acme/shop/pull/9' }).pr, '9');
  assert.equal(resolve({ ...base, PR: '5', REPO: 'https://github.com/acme/shop/pull/9' }).pr, '5', 'the pr input wins over the URL');
  assert.equal(resolve({ ...base, MODE: 'scan', PR: '12' }).pr, '', 'scan ignores the PR');
  assert.equal(resolve({ ...base, MODE: 'audit', PR: '12' }).pr, '', 'the alias ignores it too');
  assert.equal(resolve({ ...base, MODE: 'scan', REF: 'release/1.0' }).ref, 'release/1.0');
  err(() => resolve({ ...base, MODE: 'pr' }), /needs a PR number/);
  err(() => resolve({ ...base, PR: 'abc' }), /pull request number/);
  err(() => resolve({ ...base, PR: '0' }), /pull request number/);
  err(() => resolve({ ...base, REF: '--upload-pack=x' }), /ref must be/);
  err(() => resolve({ ...base, MODE: 'both' }), /mode must be/);
  err(() => resolve({}), /repo is required/);
  const r = resolve({ ...base, DESIGN_DOCS: 'https://github.com/acme/shop/blob/main/docs/pay.md\ndocs/specs', RULES_DOCS: 'CONTRIBUTING.md', TEST_DIRS: 'https://github.com/acme/shop/tree/main/spec' });
  assert.deepEqual([r.design, r.rules, r.tests], ['docs/pay.md\ndocs/specs/', 'CONTRIBUTING.md', 'spec/']);
});

test('as a script: writes multi-line outputs (random delimiter) and fails with ::error:: on a rejected input', () => {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'specguard-resolve-')), 'out.txt');
  const script = path.join(__dirname, 'resolve-inputs.js');
  const ok = spawnSync(process.execPath, [script], { encoding: 'utf8', env: { ...process.env, GITHUB_OUTPUT: out, REPO: 'acme/shop', PR: '3', DESIGN_DOCS: 'a.md\nb.md' } });
  assert.equal(ok.status, 0, ok.stderr);
  const text = fs.readFileSync(out, 'utf8');
  assert.match(text, /^repo<<(sg_[0-9a-f]{16})\nacme\/shop\n\1\n/m);
  assert.match(text, /^design<<(sg_[0-9a-f]{16})\na\.md\nb\.md\n\1\n/m);
  assert.match(text, /^mode<<(sg_[0-9a-f]{16})\npr\n\1\n/m);
  const bad = spawnSync(process.execPath, [script], { encoding: 'utf8', env: { ...process.env, GITHUB_OUTPUT: out, REPO: 'acme/shop', DESIGN_DOCS: 'https://acme.atlassian.net/wiki/x' } });
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /^::error::https:\/\/acme\.atlassian\.net\/wiki\/x is not readable from GitHub Actions/m);
  fs.rmSync(path.dirname(out), { recursive: true, force: true });
});

test('specguard-run.yml: dispatch inputs, minimal permissions, PAT checkout without persisted credentials, no input interpolated into shell text, nothing uploaded', () => {
  const y = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'specguard-run.yml'), 'utf8').replace(/\r\n/g, '\n');
  for (const k of ['repo', 'pr', 'ref', 'design_docs', 'rules_docs', 'test_dirs', 'mode', 'post_to_pr', 'model', 'effort']) assert.match(y, new RegExp(`^ {6}${k}: \\{`, 'm'), k);
  assert.match(y, /^ {6}repo: \{[^}]*required: true/m);
  assert.match(y, /^ {6}post_to_pr: \{[^}]*type: boolean, default: false/m);
  assert.match(y, /^ {6}mode: \{[^}]*options: \[auto, pr, scan\]/m);
  assert.match(y, /^permissions: \{\}$/m);
  assert.match(y, /permissions: \{ contents: read, pull-requests: read \}/); // read-only: the job token is the fallback when SPECGUARD_PAT is unset
  assert.match(y, /permissions: \{ contents: read, pull-requests: read, issues: read, copilot-requests: write \}/);
  assert.doesNotMatch(y, /(contents|pull-requests|issues|actions|checks|statuses|id-token): write/);
  assert.match(y, /repository: \$\{\{ needs\.resolve\.outputs\.repo \}\}\n {10}token: \$\{\{ secrets\.SPECGUARD_PAT \|\| github\.token \}\}/);
  assert.equal((y.match(/persist-credentials: false/g) || []).length, 3, 'every checkout');
  assert.match(y, /fetch-depth: 0/);
  assert.match(y, /uses: \.\/\.specguard-src/);
  assert.match(y, /delivery: \$\{\{ inputs\.post_to_pr && 'pr' \|\| 'summary' \}\}/);
  assert.match(y, /github_token: \$\{\{ secrets\.SPECGUARD_PAT \|\| github\.token \}\}/);
  assert.match(y, /ctx_retention_days: "0"/);
  assert.match(y, /requirements_paths: \$\{\{ needs\.resolve\.outputs\.design \}\}/);
  assert.match(y, /standards_paths: \$\{\{ needs\.resolve\.outputs\.rules \}\}/);
  assert.match(y, /test_paths: \$\{\{ needs\.resolve\.outputs\.tests \}\}/);
  assert.doesNotMatch(y, /upload-artifact/);
  // a ${{ }} inside a run: block is shell-injectable; inputs go through env: only
  for (const m of y.matchAll(/^ +run: \|\n((?: {10,}.*\n?)+)/gm)) assert.doesNotMatch(m[1], /\$\{\{/, m[1]);
  for (const m of y.matchAll(/^ +run: (.+)$/gm)) assert.doesNotMatch(m[1], /\$\{\{/);
});
