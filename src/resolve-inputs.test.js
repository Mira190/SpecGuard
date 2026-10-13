const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { parseTarget, splitRef, resolveEntry, resolveList, resolve } = require('./resolve-inputs.js');

const err = (fn, re) => assert.throws(fn, re);

// A fake `gh api`: refs = branch and tag names (a name starting with v is a tag), tree = { path: 'dir' | 'file' }, pulls = { N: [head, base, state] };
// anything else is unreadable (null). calls records every path asked.
const H = 'a'.repeat(40), B = 'b'.repeat(40);
function fake({ refs, tree = {}, pulls = {} } = {}) {
  const calls = [];
  const api = (p) => {
    calls.push(p);
    let m;
    if ((m = /^repos\/[^/]+\/[^/]+\/git\/matching-refs\/(heads|tags)\/(.+)$/.exec(p))) {
      if (!refs) return null;
      const pre = decodeURIComponent(m[2]);
      return refs.filter((r) => r.startsWith(pre) && (m[1] === 'heads') === !r.startsWith('v')).map((r) => `refs/${m[1]}/${r}`).join('\n');
    }
    if ((m = /^repos\/[^/]+\/[^/]+\/contents\/([^?]+)/.exec(p))) { const t = tree[decodeURIComponent(m[1])]; return t ? `${t}\n` : null; }
    if ((m = /^repos\/[^/]+\/[^/]+\/pulls\/(\d+)$/.exec(p))) return pulls[m[1]] ? `${pulls[m[1]].join('\t')}\n` : null;
    return null;
  };
  api.calls = calls;
  return api;
}
const ctxOf = (api = fake(), extra = {}) => ({ repo: 'acme/shop', api, cache: new Map(), ref: '', at: '', ...extra });
const R = ctxOf();

test('target: owner/name, repo and tree links, a /pull/N link (also /files) is a PR; anything else is an error', () => {
  assert.deepEqual(parseTarget('acme/shop'), { repo: 'acme/shop', pr: '', rest: '' });
  assert.deepEqual(parseTarget('https://github.com/acme/shop'), { repo: 'acme/shop', pr: '', rest: '' });
  assert.deepEqual(parseTarget('https://github.com/acme/shop/'), { repo: 'acme/shop', pr: '', rest: '' });
  assert.deepEqual(parseTarget('https://github.com/acme/shop.git'), { repo: 'acme/shop', pr: '', rest: '' });
  assert.deepEqual(parseTarget('  https://www.github.com/Acme/Shop/tree/release/1.0/  '), { repo: 'Acme/Shop', pr: '', rest: 'release/1.0' });
  assert.deepEqual(parseTarget('https://github.com/acme/shop/tree/feat%2Fx'), { repo: 'acme/shop', pr: '', rest: 'feat/x' });
  assert.deepEqual(parseTarget('https://github.com/acme/shop/pull/42'), { repo: 'acme/shop', pr: '42', rest: '' });
  assert.deepEqual(parseTarget('https://github.com/acme/shop/pull/42/files'), { repo: 'acme/shop', pr: '42', rest: '' });
  err(() => parseTarget(''), /target is required/);
  err(() => parseTarget('shop'), /owner\/name/);
  err(() => parseTarget('https://gitlab.com/acme/shop'), /must be on github\.com/);
  err(() => parseTarget('https://github.com/acme'), /no owner\/name/);
  err(() => parseTarget('acme/shop/extra'), /owner\/name/);
  err(() => parseTarget('acme/..'), /invalid repository name/);
  err(() => parseTarget('https://github.com/acme/shop/pull/0'), /pull request number/);
  err(() => parseTarget('https://github.com/acme/shop/issues/3'), /not a PR, repo or branch link/);
  err(() => parseTarget('https://github.com/acme/shop/blob/main/a.md'), /not a PR, repo or branch link/);
});

test('slash branches: the longest existing ref wins; SHAs and the known target ref need no API; without API the first segment is the ref, unverified', () => {
  const api = fake({ refs: ['main', 'feat/x', 'feat/x/y-z', 'release/1.0', 'v1.2.3'] });
  assert.deepEqual(splitRef('main/docs/a.md', ctxOf(api)), { ref: 'main', path: 'docs/a.md', verified: true });
  assert.deepEqual(splitRef('feat/x/docs/a.md', ctxOf(api)), { ref: 'feat/x', path: 'docs/a.md', verified: true });
  assert.deepEqual(splitRef('feat/x/y-z/docs/a.md', ctxOf(api)), { ref: 'feat/x/y-z', path: 'docs/a.md', verified: true }, 'the longest match');
  assert.deepEqual(splitRef('feat/x', ctxOf(api)), { ref: 'feat/x', path: '', verified: true });
  assert.deepEqual(splitRef('v1.2.3/spec', ctxOf(api)), { ref: 'v1.2.3', path: 'spec', verified: true }, 'tags too');
  assert.deepEqual(splitRef('feat/xylophone/docs', ctxOf(api)), { ref: 'feat', path: 'xylophone/docs', verified: false }, 'a prefix of a segment is not a ref');
  const sha = 'c'.repeat(40);
  assert.deepEqual(splitRef(`${sha}/docs`, ctxOf(fake())), { ref: sha, path: 'docs', verified: true });
  const known = fake({ refs: [] });
  assert.deepEqual(splitRef('feat/x/docs', ctxOf(known, { ref: 'feat/x' })), { ref: 'feat/x', path: 'docs', verified: true });
  assert.equal(known.calls.length, 0, 'the target branch is already known');
  assert.deepEqual(splitRef('feat/x/docs/a.md', ctxOf(fake())), { ref: 'feat', path: 'x/docs/a.md', verified: false }, 'API unreadable');
  const cached = fake({ refs: ['feat/x'] }), c = ctxOf(cached);
  splitRef('feat/x/a', c); splitRef('feat/x/b', c);
  assert.equal(cached.calls.length, 2, 'one lookup for heads and one for tags, then cached');
});

test('paths: plain paths and globs are normalised, ! excludes survive, .. and absolute escapes cannot leave the repo', () => {
  assert.equal(resolveEntry('docs/design.md', R), 'docs/design.md');
  assert.equal(resolveEntry('./docs\\design.md', R), 'docs/design.md');
  assert.equal(resolveEntry('/docs/design.md', R), 'docs/design.md');
  assert.equal(resolveEntry('docs/specs/**', R), 'docs/specs/**');
  assert.equal(resolveEntry('tests/', R), 'tests/');
  assert.equal(resolveEntry('! docs/old/*.md', R), '!docs/old/*.md');
  err(() => resolveEntry('../secrets.md', R), /invalid path/);
  err(() => resolveEntry('docs/../../x.md', R), /invalid path/);
  err(() => resolveEntry('a\u0007b.md', R), /control character/);
  assert.equal(resolveList('a.md\n\n a.md \r\nb/\n', R), 'a.md\nb/');
  assert.equal(resolveList('', R), '');
});

test('extension-less paths: the API tree decides folder or file (Makefile stays a file); an unreadable API keeps the path as given, never adds a slash', () => {
  const api = fake({ tree: { 'docs/specs': 'dir', Makefile: 'file', 'ci/Dockerfile': 'file', qa: 'dir' } });
  const c = ctxOf(api, { at: 'main' });
  assert.equal(resolveEntry('docs/specs', c), 'docs/specs/');
  assert.equal(resolveEntry('!qa', c), '!qa/');
  assert.equal(resolveEntry('Makefile', c), 'Makefile');
  assert.equal(resolveEntry('ci/Dockerfile', c), 'ci/Dockerfile');
  assert.equal(resolveEntry('nowhere/at-all', c), 'nowhere/at-all', 'not found: as given');
  assert.match(api.calls.find((p) => p.includes('docs/specs')), /\/contents\/docs\/specs\?ref=main$/);
  const none = fake();
  assert.equal(resolveEntry('docs/specs', ctxOf(none)), 'docs/specs');
  assert.equal(resolveEntry('Makefile', ctxOf(none)), 'Makefile');
  none.calls.length = 0;
  resolveEntry('docs/a.md', ctxOf(none)); resolveEntry('src/**', ctxOf(none)); resolveEntry('tests/', ctxOf(none));
  assert.equal(none.calls.length, 0, 'a file extension, a glob or a trailing slash needs no lookup');
});

test('URLs of the same repository become repo-relative paths: blob = file (even extension-less), tree = folder, query and fragment dropped, case-insensitive owner/name', () => {
  assert.equal(resolveEntry('https://github.com/acme/shop/blob/main/docs/design/pay.md', R), 'docs/design/pay.md');
  assert.equal(resolveEntry('https://github.com/ACME/Shop/blob/main/docs/design/pay.md?plain=1#L10-L20', R), 'docs/design/pay.md');
  assert.equal(resolveEntry('https://github.com/acme/shop/tree/main/spec/unit', R), 'spec/unit/');
  assert.equal(resolveEntry('https://github.com/acme/shop/tree/v1.2.3/spec/unit/', R), 'spec/unit/');
  assert.equal(resolveEntry('!https://github.com/acme/shop/tree/main/docs/old', R), '!docs/old/');
  assert.equal(resolveEntry('https://github.com/acme/shop/blob/main/docs/a%20b.md', R), 'docs/a b.md');
  assert.equal(resolveEntry('https://raw.githubusercontent.com/acme/shop/main/docs/design.md', R), 'docs/design.md');
  assert.equal(resolveEntry('https://github.com/acme/shop/blob/main/Makefile', ctxOf(fake({ tree: { Makefile: 'dir' } }))), 'Makefile', 'a blob link is a file whatever the tree says or its name');
  assert.equal(resolveEntry('https://github.com/acme/shop/blob/main/ci/Dockerfile', R), 'ci/Dockerfile');
  err(() => resolveEntry('https://github.com/acme/shop/tree/main', R), /repository root/);
  err(() => resolveEntry('https://github.com/acme/shop', R), /not a file or folder link/);
  err(() => resolveEntry('https://github.com/acme/shop/issues/3', R), /not a file or folder link/);
});

test('a branch with a slash in a document URL is split by the API, or by the target ref; without either the first segment is the ref (V14)', () => {
  const api = fake({ refs: ['feat/x'] });
  assert.equal(resolveEntry('https://github.com/acme/shop/blob/feat/x/docs/design.md', ctxOf(api)), 'docs/design.md');
  assert.equal(resolveEntry('https://github.com/acme/shop/tree/feat/x/spec', ctxOf(api)), 'spec/');
  assert.equal(resolveEntry('https://github.com/acme/shop/blob/feat/x/docs/design.md', ctxOf(fake(), { ref: 'feat/x' })), 'docs/design.md');
  assert.equal(resolveEntry('https://github.com/acme/shop/blob/feat/x/docs/design.md', ctxOf(fake())), 'x/docs/design.md');
});

test('URLs of another repository are rejected with the reason; non-GitHub URLs say they are not readable from GitHub Actions', () => {
  err(() => resolveEntry('https://github.com/other/repo/blob/main/docs/a.md', R), /points into other\/repo, not the target repository acme\/shop; other repositories are not supported yet/);
  err(() => resolveEntry('https://raw.githubusercontent.com/other/repo/main/a.md', R), /points into other\/repo/);
  for (const u of ['https://acme.atlassian.net/wiki/spaces/X/pages/1', 'https://docs.google.com/document/d/abc/edit', 'https://notion.so/page', 'http://example.com/a.md', 'https://gitlab.com/acme/shop/-/blob/main/a.md']) {
    err(() => resolveEntry(u, R), /is not readable from GitHub Actions; add the document to the repository or paste it/);
  }
});

test('resolve: a PR link reviews the PR (head and base from the API, open only); a repo link or owner/name scans the default branch; a tree link scans that branch', () => {
  const pulls = { 9: [H, B, 'open'], 10: [H, B, 'closed'] }, api = fake({ refs: ['main', 'feat/x'], tree: { 'docs/specs': 'dir' }, pulls });
  assert.deepEqual(resolve({ TARGET: 'https://github.com/acme/shop/pull/9' }, api), { repo: 'acme/shop', pr: '9', ref: '', mode: 'pr', head_sha: H, base_sha: B, design: '', rules: '', tests: '' });
  const scan = { repo: 'acme/shop', pr: '', ref: '', mode: 'scan', head_sha: '', base_sha: '', design: '', rules: '', tests: '' };
  assert.deepEqual(resolve({ TARGET: 'acme/shop' }, api), scan);
  assert.deepEqual(resolve({ TARGET: 'https://github.com/acme/shop' }, api), scan);
  assert.deepEqual(resolve({ TARGET: 'https://github.com/acme/shop/tree/main' }, api), { ...scan, ref: 'main' });
  const logs = [];
  assert.deepEqual(resolve({ TARGET: 'https://github.com/acme/shop/tree/feat/x/docs' }, api, (m) => logs.push(m)), { ...scan, ref: 'feat/x' });
  assert.match(logs.join('\n'), /^::notice::the scan covers the whole branch feat\/x; the part of the link after it \(docs\) is ignored/);
  assert.equal(resolve({ TARGET: `https://github.com/acme/shop/tree/${'d'.repeat(40)}` }, api).ref, 'd'.repeat(40));
  err(() => resolve({ TARGET: 'https://github.com/acme/shop/pull/10' }, api), /is closed; SpecGuard reviews open PRs/);
  err(() => resolve({ TARGET: 'https://github.com/acme/shop/pull/11' }, api), /could not read acme\/shop#11/);
  err(() => resolve({ TARGET: 'https://github.com/acme/shop/pull/9' }, () => 'not-a-sha\tb\topen'), /unexpected answer/);
  err(() => resolve({ TARGET: 'https://github.com/acme/shop/tree/--upload-pack=x' }, api), /branch in the link must be/);
  err(() => resolve({}, api), /target is required/);
  const warn = [];
  assert.equal(resolve({ TARGET: 'https://github.com/acme/shop/tree/feat/x' }, fake(), (m) => warn.push(m)).ref, 'feat');
  assert.match(warn.join(''), /::warning::could not check which part of the link is the branch name/);
  const quiet = [];
  resolve({ TARGET: 'https://github.com/acme/shop/tree/main' }, fake(), (m) => quiet.push(m));
  assert.deepEqual(quiet, [], 'a plain branch name needs no warning');
});

test('resolve: the three lists resolve together against the PR head or the scanned branch', () => {
  const api = fake({ refs: ['main'], tree: { 'docs/specs': 'dir' }, pulls: { 9: [H, B, 'open'] } });
  const r = resolve({ TARGET: 'acme/shop', DESIGN_DOCS: 'https://github.com/acme/shop/blob/main/docs/pay.md\ndocs/specs', RULES_DOCS: 'CONTRIBUTING.md', TEST_DIRS: 'https://github.com/acme/shop/tree/main/spec' }, api);
  assert.deepEqual([r.design, r.rules, r.tests], ['docs/pay.md\ndocs/specs/', 'CONTRIBUTING.md', 'spec/']);
  resolve({ TARGET: 'https://github.com/acme/shop/pull/9', DESIGN_DOCS: 'docs/specs' }, api);
  assert.ok(api.calls.some((p) => p.endsWith(`/contents/docs/specs?ref=${H}`)), 'a PR looks the folder up at the head commit');
  resolve({ TARGET: 'https://github.com/acme/shop/tree/main', DESIGN_DOCS: 'docs/specs' }, api);
  assert.ok(api.calls.some((p) => p.endsWith('/contents/docs/specs?ref=main')));
  err(() => resolve({ TARGET: 'acme/shop', DESIGN_DOCS: 'https://acme.atlassian.net/wiki/x' }, api), /is not readable from GitHub Actions/);
});

test('as a script (no token: nothing is looked up): writes multi-line outputs (random delimiter) and fails with ::error:: on a rejected input', () => {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'specguard-resolve-')), 'out.txt');
  const script = path.join(__dirname, 'resolve-inputs.js');
  const env = { ...process.env, GITHUB_OUTPUT: out };
  delete env.GH_TOKEN;
  const ok = spawnSync(process.execPath, [script], { encoding: 'utf8', env: { ...env, TARGET: 'https://github.com/acme/shop/tree/main', DESIGN_DOCS: 'a.md\nb.md' } });
  assert.equal(ok.status, 0, ok.stderr);
  const text = fs.readFileSync(out, 'utf8');
  assert.match(text, /^repo<<(sg_[0-9a-f]{16})\nacme\/shop\n\1\n/m);
  assert.match(text, /^design<<(sg_[0-9a-f]{16})\na\.md\nb\.md\n\1\n/m);
  assert.match(text, /^mode<<(sg_[0-9a-f]{16})\nscan\n\1\n/m);
  assert.match(text, /^ref<<(sg_[0-9a-f]{16})\nmain\n\1\n/m);
  assert.match(ok.stdout, /unit test gap scan, ref main/);
  const noPr = spawnSync(process.execPath, [script], { encoding: 'utf8', env: { ...env, TARGET: 'https://github.com/acme/shop/pull/3' } });
  assert.equal(noPr.status, 1);
  assert.match(noPr.stdout, /^::error::could not read acme\/shop#3 \(does SPECGUARD_PAT have Pull requests: read on it\?\)/m);
  const bad = spawnSync(process.execPath, [script], { encoding: 'utf8', env: { ...env, TARGET: 'acme/shop', DESIGN_DOCS: 'https://acme.atlassian.net/wiki/x' } });
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /^::error::https:\/\/acme\.atlassian\.net\/wiki\/x is not readable from GitHub Actions/m);
  fs.rmSync(path.dirname(out), { recursive: true, force: true });
});

const workflow = () => fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'specguard-run.yml'), 'utf8').replace(/\r\n/g, '\n');

test('specguard-run.yml: one required target plus four optional inputs, nothing else on the form', () => {
  const y = workflow(), form = /^ {4}inputs:\n((?: {6}.*\n)+)/m.exec(y)[1];
  assert.deepEqual([...form.matchAll(/^ {6}(\w+): \{/gm)].map((m) => m[1]), ['target', 'design_docs', 'rules_docs', 'test_dirs', 'post_to_pr']);
  assert.match(y, /^ {6}target: \{[^}]*required: true/m);
  for (const k of ['design_docs', 'rules_docs', 'test_dirs', 'post_to_pr']) assert.match(y, new RegExp(`^ {6}${k}: \\{[^}]*required: false`, 'm'), k);
  assert.match(y, /^ {6}post_to_pr: \{[^}]*type: boolean, default: false/m);
  assert.doesNotMatch(form, /\b(repo|pr|ref|mode|model|effort):/);
  assert.doesNotMatch(y, /inputs\.(repo|pr|ref|mode|model|effort)\b/);
  assert.match(y, /target: \{ description: "Paste a PR link to review it, or a repo or branch link to scan it\."/);
  assert.match(y, /mode: \$\{\{ needs\.resolve\.outputs\.mode \}\}/, 'the mode comes from the target');
});

test('specguard-run.yml: both jobs run in the specguard environment and the PAT is read nowhere else (V2)', () => {
  const y = workflow(), jobs = y.slice(y.indexOf('\njobs:'));
  const blocks = jobs.split(/^ {2}(?=\w+:\n)/m).slice(1);
  assert.equal(blocks.length, 2, 'resolve and review');
  for (const b of blocks) assert.match(b, /^ {4}environment: specguard\b/m, b.slice(0, 20));
  // every use of the secret sits inside a job that has the environment, and the PAT never reaches a step env under a plain name
  assert.equal(y.slice(0, y.indexOf('\njobs:')).includes('secrets.'), false, 'no secret above the jobs');
  assert.doesNotMatch(y, /^ +PAT: /m);
  assert.match(y, /HAVE_PAT: \$\{\{ secrets\.SPECGUARD_PAT != '' \}\}/);
  assert.match(y, /GH_TOKEN: \$\{\{ secrets\.SPECGUARD_PAT \|\| github\.token \}\}/);
});

test('specguard-run.yml: minimal permissions, PAT checkout without persisted credentials, no input interpolated into shell text, nothing uploaded', () => {
  const y = workflow();
  assert.match(y, /^permissions: \{\}$/m);
  assert.match(y, /permissions: \{ contents: read, pull-requests: read \}/); // read-only: the job token is the fallback when SPECGUARD_PAT is unset
  assert.match(y, /permissions: \{ contents: read, pull-requests: read, issues: read, copilot-requests: write \}/);
  assert.doesNotMatch(y, /(contents|pull-requests|issues|actions|checks|statuses|id-token): write/);
  assert.match(y, /repository: \$\{\{ needs\.resolve\.outputs\.repo \}\}\n {10}token: \$\{\{ secrets\.SPECGUARD_PAT \|\| github\.token \}\}/);
  assert.equal((y.match(/persist-credentials: false/g) || []).length, 3, 'every checkout');
  assert.match(y, /fetch-depth: 0/);
  assert.match(y, /delivery: \$\{\{ inputs\.post_to_pr && needs\.resolve\.outputs\.mode == 'pr' && 'pr' \|\| 'summary' \}\}/, 'post_to_pr only counts for PR targets');
  assert.match(y, /github_token: \$\{\{ secrets\.SPECGUARD_PAT \|\| github\.token \}\}/);
  assert.match(y, /ctx_retention_days: "0"/);
  assert.match(y, /requirements_paths: \$\{\{ needs\.resolve\.outputs\.design \}\}/);
  assert.match(y, /standards_paths: \$\{\{ needs\.resolve\.outputs\.rules \}\}/);
  assert.match(y, /test_paths: \$\{\{ needs\.resolve\.outputs\.tests \}\}/);
  assert.doesNotMatch(y, /resolve_stale/, 'the action default (false) applies: the manual PAT is not known to resolve threads');
  assert.doesNotMatch(y, /^ +(model|effort): /m, 'Copilot Auto with the action defaults');
  assert.doesNotMatch(y, /upload-artifact/);
  // a ${{ }} inside a run: block is shell-injectable; inputs go through env: only
  for (const m of y.matchAll(/^ +run: \|\n((?: {10,}.*\n?)+)/gm)) assert.doesNotMatch(m[1], /\$\{\{/, m[1]);
  for (const m of y.matchAll(/^ +run: (.+)$/gm)) assert.doesNotMatch(m[1], /\$\{\{/);
});

test('specguard-run.yml: SpecGuard is checked out AFTER the target into a path that must not exist, and its review ignores that path (V11)', () => {
  const y = workflow();
  const target = y.indexOf('repository: ${{ needs.resolve.outputs.repo }}'), guard = y.indexOf('Refuse a target that already has .specguard-src'), own = y.indexOf('path: .specguard-src'), run = y.indexOf('uses: ./.specguard-src');
  assert.ok(target > 0 && target < guard && guard < own && own < run, 'target, guard, SpecGuard checkout, action');
  assert.match(y, /if \[ -e \.specguard-src \] \|\| \[ -L \.specguard-src \]; then echo "::error::[^"]*"; exit 1; fi/, 'a symlink counts too');
  assert.match(y, /^ {10}ignore: \.specguard-src\/$/m);
});

test('specguard-run.yml: a manual scan summary starts with the one-off notice (V9)', () => {
  const y = workflow(), note = y.indexOf("**One-off scan: gaps are unconfirmed; schedule the scan in the target repo to confirm across runs.**");
  assert.ok(note > 0 && note < y.indexOf('uses: ./.specguard-src'), 'written before the action so it is the first line');
  assert.match(y, /- if: needs\.resolve\.outputs\.mode == 'scan'\n {8}shell: bash\n {8}run: \|\n {10}echo '\*\*One-off scan[^\n]*>> "\$GITHUB_STEP_SUMMARY"/);
});
