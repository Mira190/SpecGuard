const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { stage, loadCase, validateManifest, rewriteIssueRefs, externalBody, injectWorkflow, runExternal } = require('./run.js');

const git = (dir, ...a) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'core.autocrlf=false', '-c', 'commit.gpgsign=false', ...a], { encoding: 'utf8' }).trim();
const put = (dir, f, text) => { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), text); };

// Source repo: c0 -> base (b) -> head (h); `diverged` adds a commit on main after base so base is not an ancestor of head.
function sourceRepo(diverged) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'specguard-src-'));
  git(dir, 'init', '-q', '-b', 'main');
  put(dir, 'src/a.js', 'exports.a = () => 1;\n'); put(dir, 'docs/spec.md', '- R1: a returns 1\n');
  git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'c0');
  const mb = git(dir, 'rev-parse', 'HEAD');
  if (diverged) { put(dir, 'src/other.js', 'exports.o = 1;\n'); git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'base only'); }
  const base = git(dir, 'rev-parse', 'HEAD');
  git(dir, 'checkout', '-q', '-b', 'feature', mb);
  put(dir, 'src/a.js', 'exports.a = () => 2;\n'); put(dir, 'src/b.js', 'exports.b = 3;\n');
  git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'change');
  return { dir, base, head: git(dir, 'rev-parse', 'HEAD') };
}
const cloneLocal = (src) => (_url, dest) => execFileSync('git', ['clone', '-q', '--no-checkout', src, dest]);
const entry = (s, over = {}) => ({ id: 'e1', source: { url: 'https://github.com/acme/widget.git', sha: s.head }, base: s.base, head: s.head, pr_title: 'Change a', pr_body: 'Fixes #12. See acme/other#3.', expected: { findings: [{ kind: 'spec_mismatch', path: 'src/a.js', line: 1 }], must_not: [] }, ...over });

test('accepts a well-formed manifest', () => {
  assert.deepEqual(validateManifest([entry({ base: 'v1', head: 'a'.repeat(40) })]), []);
});

test('rejects malformed manifests with one message per problem', () => {
  const ok = entry({ base: 'v1', head: 'a'.repeat(40) });
  assert.match(validateManifest({})[0], /non-empty array/);
  assert.match(validateManifest([])[0], /non-empty array/);
  const msgs = validateManifest([{ ...ok, id: 'bad id', source: { url: 'http://x', sha: 'abc' }, base: '', pr_body: 5, expected: {} }]);
  for (const re of [/id must match/, /source\.url/, /source\.sha/, /base must be/, /pr_body must be/, /expected\.findings/]) assert.ok(msgs.some((m) => re.test(m)), String(re));
  assert.ok(validateManifest([ok, ok]).some((m) => /duplicate id/.test(m)));
  assert.ok(validateManifest([{ ...ok, pr_title: 'Generated with Claude' }]).some((m) => /attribution/.test(m)));
  assert.ok(validateManifest([{ ...ok, linked_issues: [{ number: 'x' }] }]).some((m) => /linked_issues/.test(m)));
  assert.ok(validateManifest([{ ...ok, expected: { findings: [{ kind: 'k', line: 1 }], must_not: [] } }]).some((m) => /finding needs/.test(m)));
});

test('rewrites bare issue numbers to full source URLs and leaves qualified refs alone', () => {
  const u = 'https://github.com/acme/widget.git';
  assert.equal(rewriteIssueRefs('Fixes #12, closes #3.\n#7 too', u), 'Fixes https://github.com/acme/widget/issues/12, closes https://github.com/acme/widget/issues/3.\nhttps://github.com/acme/widget/issues/7 too');
  assert.equal(rewriteIssueRefs('see acme/other#3 and https://x.test/a#4 and C#5', u), 'see acme/other#3 and https://x.test/a#4 and C#5');
});

test('inlines copied linked issues under their own heading with refs rewritten and comments dropped', () => {
  const s = { base: 'b', head: 'h' };
  const e = entry(s, { linked_issues: [{ number: 12, title: 'Cap total', body: 'Total must not exceed 2x.<!-- secret -->\nDepends on #9.' }] });
  const body = externalBody(e);
  assert.match(body, /^Fixes https:\/\/github\.com\/acme\/widget\/issues\/12\. See acme\/other#3\./);
  assert.match(body, /\n\n## Linked issue \(copied\)\n\nhttps:\/\/github\.com\/acme\/widget\/issues\/12 Cap total\n\nTotal must not exceed 2x\.\nDepends on https:\/\/github\.com\/acme\/widget\/issues\/9\.\n$/);
  assert.doesNotMatch(body, /secret/);
  assert.doesNotMatch(externalBody(entry(s)), /Linked issue/);
});

for (const diverged of [false, true]) {
  test(`git diff base'...head' equals git diff base...head (${diverged ? 'base not an ancestor of head' : 'base is an ancestor of head'})`, () => {
    const s = sourceRepo(diverged), work = fs.mkdtempSync(path.join(os.tmpdir(), 'specguard-work-'));
    try {
      execFileSync('git', ['clone', '-q', '--no-checkout', s.dir, work]);
      const original = git(work, 'diff', `${s.base}...${s.head}`);
      assert.match(original, /a\.js/);
      const inj = injectWorkflow({ dir: work, base: s.base, head: s.head, workflow: 'name: wf\n', tag: 'eval/t-e1' });
      assert.equal(git(work, 'diff', `${inj.baseBr}...${inj.headBr}`), original);
      assert.equal(git(work, 'show', `${inj.baseBr}:.github/workflows/specguard-eval.yml`), 'name: wf');
      assert.equal(git(work, 'diff', '--name-only', s.base, inj.baseBr), '.github/workflows/specguard-eval.yml');
      assert.equal(git(work, 'rev-parse', inj.headBr), inj.headSha);
      assert.equal(git(work, 'rev-parse', inj.baseBr), inj.baseSha);
    } finally { fs.rmSync(s.dir, { recursive: true, force: true }); fs.rmSync(work, { recursive: true, force: true }); }
  });
}

test('dry run stages the entry, pins nothing remote and runs no gh or push', async () => {
  const s = sourceRepo(false), calls = [];
  const exec = (cmd, args) => { calls.push([cmd, ...args]); return execFileSync(cmd, args, { encoding: 'utf8' }).trim(); };
  try {
    const out = await runExternal({ entries: [entry(s)], repo: 'me/mirror', modes: ['off', 'auto'], runId: 'r', dryRun: true, clone: cloneLocal(s.dir), exec, observe: () => assert.fail('must not observe'), setTrace: () => assert.fail('must not set variables') });
    assert.deepEqual(out.results, []);
    assert.equal(out.staged.length, 1);
    assert.equal(out.staged[0].baseBr, 'eval/r-e1-base');
    assert.match(out.staged[0].body, /issues\/12/);
    assert.ok(calls.every(([cmd, ...a]) => cmd === 'git' && !a.includes('push')));
  } finally { fs.rmSync(s.dir, { recursive: true, force: true }); }
});

test('a live run needs --action and a missing commit becomes an error row per trace mode', async () => {
  const s = sourceRepo(false);
  try {
    await assert.rejects(runExternal({ entries: [entry(s)], repo: 'me/mirror', modes: ['off'], runId: 'r' }), /--action OWNER\/specguard@SHA is required/);
    const out = await runExternal({ entries: [entry(s, { base: 'f'.repeat(40) })], repo: 'me/mirror', modes: ['off', 'auto'], runId: 'r', dryRun: true, clone: cloneLocal(s.dir) });
    assert.deepEqual(out.results.map((r) => [r.id, r.trace, !!r.error]), [['e1 [trace off]', 'off', true], ['e1 [trace auto]', 'auto', true]]);
  } finally { fs.rmSync(s.dir, { recursive: true, force: true }); }
});

test('an errored external run keeps its expected finding count, so end-to-end recall counts it as missed', async () => {
  const s = sourceRepo(false);
  try {
    const two = [{ kind: 'spec_mismatch', path: 'src/a.js', line: 1 }, { kind: 'missing_test', path: 'src/a.js', line: 5 }];
    const out = await runExternal({ entries: [entry(s, { base: 'f'.repeat(40), expected: { findings: two, must_not: [] } })], repo: 'me/mirror', modes: ['off'], runId: 'r', dryRun: true, clone: cloneLocal(s.dir) });
    assert.equal(out.results[0].expected_findings, 2);
    const a = require('./grade.js').aggregate(out.results);
    assert.deepEqual([a.recall_delivered_e2e, a.errors_expected_findings, a.errors], [0, 2, 1]);
  } finally { fs.rmSync(s.dir, { recursive: true, force: true }); }
});

test('a live run sets the trace variable before each PR, grades each observation and cleans up', async () => {
  const s = sourceRepo(false), log = [];
  const exec = (cmd, args) => {
    if (cmd === 'git' && args.includes('push')) { log.push(`push ${args.at(-1)}`); return ''; }
    if (cmd === 'gh') { log.push(`gh ${args.slice(0, 2).join(' ')}`); return args[1] === 'create' ? 'https://github.com/me/mirror/pull/7' : ''; }
    return execFileSync(cmd, args, { encoding: 'utf8' }).trim();
  };
  const observe = async () => ({ observed: { comments: [], reviews: [], summary: 'Nothing found', latency_s: 3, job_conclusion: 'success' }, run: { url: 'run-url', conclusion: 'success' } });
  try {
    const out = await runExternal({ entries: [entry(s)], repo: 'me/mirror', modes: ['off', 'auto'], runId: 'r', action: 'me/specguard@' + 'c'.repeat(40), clone: cloneLocal(s.dir), exec, observe, setTrace: (v) => log.push(`trace ${v}`) });
    assert.deepEqual(log.filter((l) => !l.startsWith('push')), ['trace off', 'gh pr create', 'trace auto', 'gh pr create', 'gh pr close', 'gh pr close', 'gh api -X', 'gh api -X']);
    assert.equal(log.filter((l) => l.startsWith('push')).length, 2);
    assert.deepEqual(out.results.map((r) => [r.id, r.trace, r.fn, r.pr_url]), [['e1 [trace off]', 'off', 1, 'https://github.com/me/mirror/pull/7'], ['e1 [trace auto]', 'auto', 1, 'https://github.com/me/mirror/pull/7']]);
  } finally { fs.rmSync(s.dir, { recursive: true, force: true }); }
});

test('stage: a head file with the same size and mtime as its base file is still staged (stale stat cache)', () => {
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'stage-')), cp = fs.cpSync, T = new Date('2020-01-01T00:00:00Z');
  // Windows cpSync keeps the source mtime; pin every copied file to one so the stale-stat case reproduces on any platform.
  fs.cpSync = (s, d, o) => { cp(s, d, o); for (const f of fs.readdirSync(d, { recursive: true })) if (fs.statSync(path.join(d, f)).isFile()) fs.utimesSync(path.join(d, f), T, T); };
  try {
    git(wt, 'init', '-q'); git(wt, 'config', 'commit.gpgsign', 'false'); git(wt, 'config', 'user.name', 't'); git(wt, 'config', 'user.email', 't@example.invalid');
    const c = loadCase('tr11');
    stage(wt, [c], 'base', 'base');
    stage(wt, [c], 'head', 'head');
    assert.match(git(wt, 'diff', '--name-only', 'HEAD~1', 'HEAD'), /eval-sandbox\/tr11\/src\/premium\.js/);
  } finally { fs.cpSync = cp; fs.rmSync(wt, { recursive: true, force: true }); }
});

test('the mirror workflow template matches what run.js expects', () => {
  const wf = fs.readFileSync(path.join(__dirname, 'mirror-workflow.yml'), 'utf8');
  for (const re of [/^ {2}dogfood:/m, /uses: OWNER\/specguard@SHA/, /vars\.SPECGUARD_EVAL_MODEL/, /trace: .*vars\.SPECGUARD_EVAL_TRACE/, /name: specguard-ctx/, /^name: specguard-eval$/m]) assert.match(wf, re);
});
