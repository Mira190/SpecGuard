const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { pin, LINE } = require('../bin/pin-reusable.js');

const root = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8').replace(/\r\n/g, '\n');
const reusable = () => read('.github', 'workflows', 'specguard.yml');
const central = () => read('.github', 'workflows', 'specguard-run.yml');

test('specguard.yml: on workflow_call with the action inputs (src/audit-action.test.js checks the full set), and no other trigger', () => {
  const y = reusable();
  assert.match(y, /^on:\n {2}workflow_call:\n {4}inputs:\n/m);
  assert.doesNotMatch(y, /^ {2}(pull_request|pull_request_target|workflow_dispatch|schedule|push):/m);
  const form = /^ {4}inputs:\n((?: {6}.*\n)+)/m.exec(y)[1];
  const names = [...form.matchAll(/^ {6}(\w+): \{/gm)].map((m) => m[1]);
  for (const k of ['mode', 'requirements_paths', 'standards_paths', 'test_paths', 'scan_issue', 'model', 'effort']) assert.ok(names.includes(k), k);
  assert.match(y, /^ {6}mode: \{[^}]*default: pr \}/m);
  assert.match(y, /^ {6}scan_issue: \{[^}]*type: boolean, default: false \}/m);
  assert.match(y, /^ {4}secrets:\n {6}llm_token: \{[^}]*required: false \}\n {6}copilot_token: \{[^}]*required: false \}\n {6}scan_issue_token: \{[^}]*required: false \}\n/m, 'the only secrets are the optional tokens: LLM, its Copilot alias, the scan issue');
});

test('specguard.yml: repository access is the caller job token; the only secret read is the optional Copilot PAT, forwarded to the action', () => {
  const y = reusable();
  assert.match(y, /github_token: \$\{\{ github\.token \}\}/);
  assert.deepEqual([...y.matchAll(/secrets\.(\w+)/g)].map((m) => m[1]).filter((v, i, a) => a.indexOf(v) === i).sort(), ['SPECGUARD_COPILOT_TOKEN', 'SPECGUARD_LLM_TOKEN', 'copilot_token', 'llm_token', 'scan_issue_token']);
  assert.match(y, /^ {10}copilot_token: \$\{\{ secrets\.copilot_token \|\| secrets\.SPECGUARD_COPILOT_TOKEN \}\}/m, 'explicit secrets: { copilot_token } or secrets: inherit');
  assert.doesNotMatch(y, /SPECGUARD_PAT|create-github-app-token|pull_request_target/);
  assert.doesNotMatch(y, /^ *permissions: *write-all/m);
  assert.doesNotMatch(y, /^ *(contents|pull-requests|issues|actions|checks|statuses|id-token): write/m, 'it can only keep or reduce the caller\'s permissions, so it asks for none');
  assert.equal((y.match(/persist-credentials: false/g) || []).length, 1, 'the only checkout does not persist the token');
});

test('specguard.yml: checks out the caller repository (no repository: input) and uses the action by one literal full-SHA pin, outside the workspace', () => {
  const y = reusable();
  assert.doesNotMatch(y, /^ +repository:/m, 'no checkout of another repository');
  assert.doesNotMatch(y, /uses: \.\/|\.specguard-src/, 'uses: ./ would be the caller workspace; the action is downloaded by the runner, outside the workspace');
  const uses = [...y.matchAll(/^ +- uses: (\S+)@(\S+)/gm)];
  assert.deepEqual(uses.map((m) => m[1]), ['actions/checkout', 'Mira190/SpecGuard']);
  for (const m of uses) assert.match(m[2], /^[0-9a-f]{40}$/, m[1] + ' is pinned to a full commit sha');
  assert.match(y, /^ +- uses: [\w.-]+\/[\w.-]+@[0-9a-f]{40} # specguard-pin$/m);
});

test('specguard.yml: the pin is a commit of this repository (skipped when the object is absent from the clone)', (t) => {
  const sha = LINE.exec(reusable())[3];
  try { execFileSync('git', ['cat-file', '-e', sha + '^{commit}'], { cwd: root, stdio: 'ignore' }); } catch { return t.skip('pinned commit not in this clone (shallow checkout)'); }
  execFileSync('git', ['merge-base', '--is-ancestor', sha, 'HEAD'], { cwd: root, stdio: 'ignore' });
});

test('specguard.yml: forks and drafts are skipped in pr mode only; the action gets every core input from the caller', () => {
  const y = reusable();
  assert.match(y, /if: \$\{\{ inputs\.mode != 'pr' \|\| \(!github\.event\.pull_request\.draft && github\.event\.pull_request\.head\.repo\.full_name == github\.repository\) \}\}/);
  for (const k of ['mode', 'requirements_paths', 'standards_paths', 'test_paths', 'scan_issue', 'model', 'effort']) assert.match(y, new RegExp(`^ {10}${k}: \\$\\{\\{ inputs\\.${k} \\}\\}`, 'm'), k);
  assert.match(y, /fetch-depth: 0/, 'blame and the diff need history');
  assert.match(y, /review_timeout_minutes: \$\{\{ inputs\.review_timeout_minutes \|\| \(inputs\.mode == 'scan' && '25' \|\| '12'\) \}\}/);
  assert.ok(+/timeout-minutes: (\d+)/.exec(y)[1] >= 25 + 3, 'job timeout is at least 3 above the engine limit');
});

test('pin-reusable: rewrites only the specguard-pin line, can rename the repository, rejects a short sha', () => {
  const y = reusable(), sha = 'a'.repeat(40);
  const out = pin(y, sha);
  assert.equal(LINE.exec(out)[3], sha);
  assert.equal(LINE.exec(out)[2], 'Mira190/SpecGuard');
  assert.match(out, /actions\/checkout@d23441a48e516b6c34aea4fa41551a30e30af803/, 'other pins untouched');
  assert.match(pin(y, sha, 'acme/SpecGuard'), /acme\/SpecGuard@a{40} # specguard-pin/);
  assert.ok(pin(y.replace(/\n/g, '\r\n'), 'b'.repeat(40)).includes('@' + 'b'.repeat(40) + ' # specguard-pin\r\n'), 'CRLF checkouts');
  assert.throws(() => pin(y, 'abc123'), /full commit sha/);
  assert.throws(() => pin(y, sha, 'nope'), /owner\/repo/);
  assert.throws(() => pin('uses: x/y@' + sha, sha), /specguard-pin/);
});

test('specguard-run.yml: the App token is minted only when both environment secrets exist, is scoped to the target repository and read-only except post_to_pr', () => {
  const y = central(), jobs = y.slice(y.indexOf('\njobs:'));
  const blocks = jobs.split(/^ {2}(?=\w+:\n)/m).slice(1);
  assert.equal(blocks.length, 2);
  for (const b of blocks) {
    assert.match(b, /HAVE_APP: \$\{\{ secrets\.SPECGUARD_APP_ID != '' && secrets\.SPECGUARD_APP_PRIVATE_KEY != '' \}\}/);
    assert.match(b, /- id: app\n {8}if: env\.HAVE_APP == 'true'\n {8}uses: actions\/create-github-app-token@[0-9a-f]{40} # v3\.2\.0/);
    assert.match(b, /client-id: \$\{\{ secrets\.SPECGUARD_APP_ID \}\}\n {10}private-key: \$\{\{ secrets\.SPECGUARD_APP_PRIVATE_KEY \}\}/);
    assert.match(b, /owner: \$\{\{ steps\.scope\.outputs\.owner \}\}\n {10}repositories: \$\{\{ steps\.scope\.outputs\.name \}\}/, 'one repository, never the whole installation');
    assert.match(b, /permission-contents: read\n/);
  }
  assert.doesNotMatch(y, /permission-(contents|issues|actions|checks): write/);
  assert.match(blocks[0], /permission-pull-requests: read\n/);
  assert.match(blocks[1], /permission-pull-requests: \$\{\{ inputs\.post_to_pr && needs\.resolve\.outputs\.mode == 'pr' && 'write' \|\| 'read' \}\}/);
  assert.match(blocks[1], /permission-issues: \$\{\{ [^}]*'read' \}\}/);
  // App first, else PAT, else the job token: every use of the token goes through the same expression
  const tokens = [...y.matchAll(/(?:GH_TOKEN|token|github_token): (\$\{\{[^}]*SPECGUARD_PAT[^}]*\}\})/g)].map((m) => m[1]);
  assert.equal(tokens.length, 3, 'resolve, checkout, action');
  for (const t of tokens) assert.equal(t, '${{ steps.app.outputs.token || secrets.SPECGUARD_PAT || github.token }}');
  assert.doesNotMatch(y, /^ +(SPECGUARD_APP_PRIVATE_KEY|PRIVATE_KEY): /m, 'the key reaches only the token action');
});

test('specguard-run.yml: Copilot runs on its own user-owned PAT from the environment (SPECGUARD_COPILOT_TOKEN), never on the repository-read token; org billing stays as the empty-secret fallback', () => {
  const y = central(), jobs = y.slice(y.indexOf('\njobs:'));
  const review = jobs.slice(jobs.indexOf('\n  review:'));
  assert.equal((y.match(/copilot_token:/g) || []).length, 1);
  assert.match(review, /^ {10}copilot_token: \$\{\{ secrets\.SPECGUARD_COPILOT_TOKEN \}\}/m, 'review job, action step');
  assert.doesNotMatch(y, /copilot_token:[^\n]*SPECGUARD_PAT/, 'a repository-read PAT is org-owned and cannot carry Copilot Requests');
  assert.match(review, /environment: specguard/);
  assert.match(review, /copilot-requests: write/, 'org billing still works when no Copilot token is set');
});

test('specguard-run.yml and specguard.yml parse as YAML', () => {
  const py = 'import sys,yaml\nfor f in sys.argv[1:]: yaml.safe_load(open(f,encoding="utf8"))\n';
  const files = ['specguard-run.yml', 'specguard.yml'].map((f) => path.join(root, '.github', 'workflows', f));
  try { execFileSync('python', ['-c', py, ...files], { stdio: 'pipe' }); } catch (e) { if (/No module named yaml|ENOENT/.test(String(e.stderr) + e.message)) return; throw e; }
});

test('specguard-run.yml: the scope step turns every accepted target spelling into owner and name', () => {
  const script = /run: \|\n {10}(spec=[^\n]*\n {10}\[\[[^\n]*\n)/.exec(central())[1].trim();
  const probe = script + '\n[[ "$owner" =~ ^[A-Za-z0-9._-]+$ && "$name" =~ ^[A-Za-z0-9._-]+$ ]] && echo "$owner $name"\n';
  const bash = (spec) => {
    try { return execFileSync('bash', ['-c', probe], { env: { ...process.env, SPEC: spec }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; }
  };
  for (const t of ['https://github.com/acme/shop/pull/3', 'acme/shop', ' https://github.com/acme/shop.git ', 'acme/shop/tree/feat/x/docs', 'https://ghe.corp.example/acme/shop/blob/main/a.md']) assert.equal(bash(t), 'acme shop', t);
  assert.equal(bash('shop'), null, 'a bare name has no owner');
});

test('specguard-run.yml: scan_issue chooses where a scan keeps its state: this repository (default), the target, or nowhere', () => {
  const y = central();
  assert.match(y, /^ {6}scan_issue: \{[^}]*type: choice, default: specguard, options: \[specguard, target, none\]/m);
  assert.match(y, /scan_issue: \$\{\{ needs\.resolve\.outputs\.mode == 'scan' && inputs\.scan_issue != 'none' && 'true' \|\| 'false' \}\}/);
  assert.match(y, /scan_issue_repo: \$\{\{ needs\.resolve\.outputs\.mode == 'scan' && inputs\.scan_issue == 'specguard' && github\.repository \|\| '' \}\}/);
  assert.match(y, /scan_issue_token: \$\{\{ needs\.resolve\.outputs\.mode == 'scan' && inputs\.scan_issue == 'specguard' && github\.token \|\| '' \}\}/);
  assert.match(y, /permission-issues: \$\{\{ needs\.resolve\.outputs\.mode == 'scan' && inputs\.scan_issue == 'target' && 'write' \|\| 'read' \}\}/, 'issues write on the target only for the target choice');
  assert.match(y, /permissions: \{ contents: read, pull-requests: read, issues: write, copilot-requests: write \}/, 'the job token writes this repository only');
  assert.match(y, /inputs\.scan_issue == 'none'/, 'the one-off notice only without an issue');
});

test('audit-post: with ISSUE_REPO the scan issue lives in that repository under its own client, titled with the scanned repository', async () => {
  const audit = require('./audit-post.js'), os = require('node:os');
  const ctx = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-issue-'));
  fs.writeFileSync(path.join(ctx, 'audit-meta.json'), JSON.stringify({ head: 'abc123', max_requirements: 80, docs: 0, limitations: [] }));
  const BOT = { type: 'Bot', login: 'github-actions[bot]' }, calls = [];
  const client = (name, issues) => ({ rest: { users: { getAuthenticated: async () => { throw new Error('no /user'); } }, repos: { get: async () => ({ data: { visibility: 'private' } }) },
    issues: { listForRepo: (a) => { calls.push([name, 'list', a.owner, a.repo]); return issues; }, update: async (a) => { calls.push([name, 'update', a.owner, a.repo, a.issue_number, a.title]); }, create: async (a) => { calls.push([name, 'create']); } } },
    paginate: async (fn, a) => fn(a) });
  const body = '<!-- specguard:audit -->\n## old';
  const mine = { number: 5, title: 'SpecGuard: unit test gap scan: acme/shop', body, user: BOT, state: 'open' };
  const other = { number: 6, title: 'SpecGuard: unit test gap scan: acme/other', body, user: BOT, state: 'open' };
  const env = { CTX: ctx, SKIP: 'true', SCAN_ISSUE: 'true', ISSUE_REPO: 'corp/specguard', ENGINE: '', MODEL: '' }, saved = { ...process.env };
  const core = { warning: (m) => calls.push(['warn', m]), summary: { addRaw() { return this; }, async write() {} } };
  try {
    Object.assign(process.env, env);
    await audit({ github: client('read', []), issueGithub: client('issue', [other, mine]), context: { repo: { owner: 'acme', repo: 'shop' }, sha: 'abc123' }, core });
  } finally { for (const k of Object.keys(env)) if (k in saved) process.env[k] = saved[k]; else delete process.env[k]; fs.rmSync(ctx, { recursive: true, force: true }); }
  assert.deepEqual(calls.filter((c) => c[0] === 'read'), [], 'the read client never touches the issue');
  assert.deepEqual(calls, [['issue', 'list', 'corp', 'specguard'], ['issue', 'update', 'corp', 'specguard', 5, 'SpecGuard: unit test gap scan: acme/shop']], 'only the issue of the scanned repository is updated');
});

test('audit-post: a scan issue in another repository is written only when that audience is no wider than the scanned one; unknown visibility writes nothing (review F18)', async () => {
  const audit = require('./audit-post.js'), os = require('node:os');
  const run = async (src, dest) => {
    const ctx = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-issue-'));
    fs.writeFileSync(path.join(ctx, 'audit-meta.json'), JSON.stringify({ head: 'abc123', max_requirements: 80, docs: 0, limitations: [] }));
    const calls = [], outputs = {};
    const client = (name, v) => ({ rest: { users: { getAuthenticated: async () => { throw new Error('no /user'); } }, repos: { get: async () => { if (v === null) throw new Error('404'); return { data: { visibility: v } }; } },
      issues: { listForRepo: () => { calls.push([name, 'list']); return []; }, update: async () => calls.push([name, 'update']), create: async () => calls.push([name, 'create']) } }, paginate: async (fn, a) => fn(a) });
    const env = { CTX: ctx, SKIP: 'true', SCAN_ISSUE: 'true', ISSUE_REPO: 'corp/reports', ENGINE: '', MODEL: '' }, saved = { ...process.env };
    const core = { warning: (m) => calls.push(['warn', m]), setOutput: (k, v) => { outputs[k] = v; }, summary: { addRaw() { return this; }, async write() {} } };
    try { Object.assign(process.env, env); await audit({ github: client('read', src), issueGithub: client('issue', dest), context: { repo: { owner: 'org', repo: 'private-source' }, sha: 'abc123' }, core }); }
    finally { for (const k of Object.keys(env)) if (k in saved) process.env[k] = saved[k]; else delete process.env[k]; fs.rmSync(ctx, { recursive: true, force: true }); }
    return { wrote: calls.some((c) => c[0] === 'issue'), calls, outputs };
  };
  const leak = await run('private', 'public');
  assert.equal(leak.wrote, false, 'private -> public: no issue call at all');
  assert.equal(leak.outputs.status, 'failed');
  assert.match(leak.calls.find((c) => c[0] === 'warn')[1], /scan issue not written to corp\/reports: the target repository is not public but this control repository is public/);
  assert.equal((await run('private', null)).wrote, false, 'destination visibility unreadable: fail closed');
  assert.equal((await run(null, 'private')).wrote, false, 'source visibility unreadable: fail closed');
  for (const [src, dest] of [['private', 'private'], ['internal', 'private'], ['public', 'public']]) {
    const ok = await run(src, dest);
    assert.deepEqual([ok.wrote, ok.outputs.status], [true, 'complete'], `${src} -> ${dest}`);
  }
});

test('audit-post: scan_issue_repo together with scan_paths titles "...: owner/name (scope)" and keeps the scope marker; unscoped keeps the original marker', async () => {
  const audit = require('./audit-post.js'), os = require('node:os');
  assert.equal(audit.scopeOf('', 'acme/shop').title, 'SpecGuard: unit test gap scan: acme/shop');
  assert.equal(audit.scopeOf('', 'acme/shop').mark, audit.MARK, 'an unscoped scan keeps the original marker');
  const sc = audit.scopeOf('packages/a/**', 'acme/shop');
  assert.equal(sc.title, 'SpecGuard: unit test gap scan: acme/shop (packages/a/**)');
  assert.equal(sc.mark, audit.scopeOf('packages/a/**').mark, 'the marker does not depend on the target repository');
  const ctx = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-issue-'));
  fs.writeFileSync(path.join(ctx, 'audit-meta.json'), JSON.stringify({ head: 'abc123', max_requirements: 80, docs: 0, limitations: [] }));
  const BOT = { type: 'Bot', login: 'github-actions[bot]' }, calls = [];
  const client = { rest: { users: { getAuthenticated: async () => { throw new Error('no /user'); } }, repos: { get: async () => ({ data: { visibility: 'private' } }) },
    issues: { listForRepo: (a) => a, update: async (a) => { calls.push(['update', a.owner, a.repo, a.issue_number, a.title]); }, create: async (a) => { calls.push(['create', a.owner, a.repo, a.title]); } } },
    paginate: async (fn, a) => fn(a) };
  const body = `${sc.mark}\n## old`;
  const issues = [
    { number: 1, title: 'SpecGuard: unit test gap scan: acme/shop', body: `${audit.MARK}\n## old`, user: BOT, state: 'open' }, // unscoped
    { number: 2, title: 'SpecGuard: unit test gap scan: acme/other (packages/a/**)', body, user: BOT, state: 'open' }, // another target
    { number: 3, title: sc.title, body, user: BOT, state: 'open' },
  ];
  client.rest.issues.listForRepo = () => issues;
  const env = { CTX: ctx, SKIP: 'true', SCAN_ISSUE: 'true', SCAN_PATHS: 'packages/a/**', ISSUE_REPO: 'corp/specguard', ENGINE: '', MODEL: '' }, saved = { ...process.env };
  const core = { warning: (m) => calls.push(['warn', m]), summary: { addRaw() { return this; }, async write() {} } };
  try {
    Object.assign(process.env, env);
    await audit({ github: client, issueGithub: client, context: { repo: { owner: 'acme', repo: 'shop' }, sha: 'abc123' }, core });
  } finally { for (const k of Object.keys(env)) if (k in saved) process.env[k] = saved[k]; else delete process.env[k]; fs.rmSync(ctx, { recursive: true, force: true }); }
  assert.deepEqual(calls, [['update', 'corp', 'specguard', 3, sc.title]], 'only the issue of this target and scope is updated');
});

test('specguard-run.yml: the results artifact uploads only the named result files, from a pinned action, even when the run failed; never the ctx dir', () => {
  const y = central(), at = y.indexOf('uses: actions/upload-artifact@'), step = y.slice(y.lastIndexOf('\n      - ', at), y.indexOf('\n\n', at) < 0 ? undefined : y.indexOf('\n\n', at));
  assert.ok(at > y.indexOf('uses: ./.specguard-src'), 'after the SpecGuard step');
  assert.equal(y.split('actions/upload-artifact@').length, 2);
  assert.match(step, /^\n {6}- if: always\(\)\n {8}uses: actions\/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7\.0\.1\n/);
  assert.match(step, /name: specguard-result-\$\{\{ github\.run_id \}\}/);
  assert.match(step, /retention-days: 14\n/);
  assert.match(step, /if-no-files-found: ignore\n/);
  const paths = /path: \|\n((?: {12}.*\n)+)/.exec(step)[1].trim().split('\n').map((l) => l.trim());
  assert.deepEqual(paths.map((p) => p.replace('${{ github.workspace }}/.specguard-ctx/', '')).sort(), ['audit.json', 'findings.json', 'requirements-status.json', 'summary.md', 'usage.json']);
  assert.ok(paths.every((p) => /\.(md|json)$/.test(p)), 'files, not the directory');
  assert.match(y, /quote the target repository, so this repository must stay private/);
});
