const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { execFileSync } = require('node:child_process');
const { parse, baseRef, fetchBase, resolveBase, validatedGaps, run, format, main } = require('./specguard-local.js');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'specguard-local-bin-test-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const quiet = () => {};
const config = (repo) => { for (const [k, v] of [['user.name', 't'], ['user.email', 't@example.invalid'], ['commit.gpgsign', 'false'], ['core.autocrlf', 'false']]) git(repo, 'config', k, v); };

function makeRepo(name) {
  const repo = path.join(tmp, name);
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  config(repo);
  fs.writeFileSync(path.join(repo, 'src', 'price.js'), 'function total(x) {\n  return x;\n}\nmodule.exports = { total };\n');
  git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'base');
  const mainSha = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'checkout', '-q', '-b', 'feature');
  fs.writeFileSync(path.join(repo, 'src', 'price.js'), 'function total(x) {\n  if (x > 100) return 100;\n  return x;\n}\nmodule.exports = { total };\n');
  git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'cap the total at 100');
  return { repo, mainSha };
}

const behaviour = { path: 'src/price.js', line: 2, quote: 'if (x > 100) return 100;' };
const findings = (extra = {}) => ({
  requirements: [], requirements_source: 'commit messages', not_reviewed: '',
  coverage: [{ id: 'O1', obligation: 'The total is capped at 100', source: 'commit message', behaviour, change: { ...behaviour }, evidence: [], status: 'missing_test', reason: 'No unit test calls total().', alignment: { status: 'not_applicable', reason: 'No requirement governs this.' } }],
  findings: [{ kind: 'missing_test', obligation_ids: ['O1'], ...behaviour, title: 'Test the cap at 100', body: 'The cap has no assertion. Add assert.equal(total(101), 100).', confidence: 'high' }],
  standards: { status: 'no_rules', sources: [], reason: 'No rule files in the repository.' },
  layering: { status: 'checked', reason: 'No tests exist at any layer.' }, ...extra,
});
const canned = (name, data) => { const p = path.join(tmp, `${name}.json`); fs.writeFileSync(p, JSON.stringify(data)); return p; };
async function review(repo, name, data, opts = { base: 'main' }, extra = {}) {
  process.env.SPECGUARD_LOCAL_FINDINGS = canned(name, data);
  try { return await run({ cwd: repo, opts, log: quiet, ...extra }); } finally { delete process.env.SPECGUARD_LOCAL_FINDINGS; }
}

test('parse: flags, defaults, rejects unknown flags; the CI path inputs are repeatable flags', () => {
  assert.deepStrictEqual(parse([]), {});
  const o = parse(['--base', 'origin/dev', '--model', 'gpt-5', '--effort', 'high', '--auto-tier', 'balance', '--json', '--fail-on-gaps', '--body', 'b.md']);
  assert.deepStrictEqual(o, { base: 'origin/dev', model: 'gpt-5', effort: 'high', 'auto-tier': 'balance', json: true, 'fail-on-gaps': true, body: 'b.md' });
  assert.deepStrictEqual(parse(['--requirements-paths', 'docs/**', '--requirements-paths', '!docs/old/**', '--standards-paths', 'RULES.md', '--test-paths', 'qa/', '--ignore', 'gen/']),
    { 'requirements-paths': ['docs/**', '!docs/old/**'], 'standards-paths': ['RULES.md'], 'test-paths': ['qa/'], ignore: ['gen/'] });
  assert.throws(() => parse(['--engine', 'copilot']));
  assert.throws(() => parse(['--base']));
});

test('resolveBase: merge-base, default branch fallback, errors', () => {
  const { repo, mainSha } = makeRepo('resolve');
  git(repo, 'checkout', '-q', 'main');
  fs.writeFileSync(path.join(repo, 'other.txt'), 'x'); git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'main moves on');
  git(repo, 'checkout', '-q', 'feature');
  const head = git(repo, 'rev-parse', 'HEAD');
  assert.deepStrictEqual(resolveBase(repo, 'main'), { ref: 'main', base: mainSha, head }); // merge-base, not main's tip
  assert.strictEqual(resolveBase(repo).ref, 'main'); // no origin: falls back to main
  assert.strictEqual(baseRef(repo, 'origin/dev'), 'origin/dev');
  assert.throws(() => resolveBase(repo, 'nope'), /unknown base ref/);
  git(repo, 'branch', '-m', 'main', 'master');
  assert.strictEqual(resolveBase(repo).ref, 'master');
  git(repo, 'branch', '-m', 'master', 'trunk');
  assert.throws(() => resolveBase(repo), /no base branch/);
});

test('fetchBase (V5): a stale origin/main is refreshed before the merge-base; a local branch is left alone; offline = a warning, not a failure', () => {
  const { repo } = makeRepo('fetch');
  const bare = path.join(tmp, 'fetch-remote.git');
  git(tmp, 'init', '-q', '--bare', bare);
  git(repo, 'remote', 'add', 'origin', bare);
  git(repo, 'push', '-q', 'origin', 'main');
  git(repo, 'fetch', '-q', 'origin');
  const stale = git(repo, 'rev-parse', 'origin/main');
  const other = path.join(tmp, 'fetch-other');
  git(tmp, 'clone', '-q', '-b', 'main', bare, other);
  config(other);
  fs.writeFileSync(path.join(other, 'newer.txt'), 'x'); git(other, 'add', '-A'); git(other, 'commit', '-q', '-m', 'someone merges to main'); git(other, 'push', '-q', 'origin', 'main');
  const logs = [];
  assert.strictEqual(fetchBase(repo, 'main', (m) => logs.push(m)), false, 'a local branch is not fetched');
  assert.strictEqual(git(repo, 'rev-parse', 'origin/main'), stale);
  assert.strictEqual(fetchBase(repo, 'origin/main', (m) => logs.push(m)), true);
  assert.notStrictEqual(git(repo, 'rev-parse', 'origin/main'), stale, 'origin/main moved');
  assert.deepStrictEqual(logs, []);
  git(repo, 'remote', 'set-url', 'origin', path.join(tmp, 'nowhere.git'));
  const before = git(repo, 'rev-parse', 'origin/main');
  assert.strictEqual(fetchBase(repo, 'origin/main', (m) => logs.push(m)), false);
  assert.match(logs.join('\n'), /warning: could not fetch origin\/main \(offline\?\)/);
  assert.strictEqual(git(repo, 'rev-parse', 'origin/main'), before);
  assert.strictEqual(fetchBase(repo, 'upstream/main', quiet), false, 'an unknown remote is not a fetch');
});

test('run: fake GitHub captures the summary post.js publishes and the inline comment; repo is left untouched', async () => {
  const { repo } = makeRepo('run');
  fs.writeFileSync(path.join(repo, 'dirty.txt'), 'uncommitted');
  process.env.SPECGUARD_LOCAL_FINDINGS = canned('run', findings());
  const logs = [];
  let r;
  try { r = await run({ cwd: repo, opts: { base: 'main' }, log: (m) => logs.push(m) }); } finally { delete process.env.SPECGUARD_LOCAL_FINDINGS; }
  assert.ok(logs.some((l) => /uncommitted changes are not reviewed/.test(l)));
  assert.ok(r.summary.startsWith('<!-- specguard:summary -->'), r.summary.slice(0, 200));
  assert.match(r.summary, /Test the cap at 100|missing/i);
  assert.strictEqual(r.comments.length, 1);
  assert.strictEqual(`${r.comments[0].path}:${r.comments[0].line}`, 'src/price.js:2');
  assert.strictEqual(r.comments[0].title, 'Test the cap at 100');
  assert.ok(!r.comments[0].body.includes('<!--'));
  assert.strictEqual(r.gaps, true);
  const text = format(r);
  assert.ok(text.startsWith(r.summary) && text.includes('src/price.js:2 — Test the cap at 100'));
  assert.strictEqual(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD'), 'feature'); // collect.sh ran in a worktree
  assert.strictEqual(git(repo, 'worktree', 'list').split('\n').length, 1);
});

test('run: the CI path inputs reach collect.sh (--ignore removes the file from the review) and the stale remote base is fetched first', async () => {
  const { repo } = makeRepo('flags');
  const logs = [];
  const r = await review(repo, 'flags', findings(), { base: 'main', ignore: ['src/price.js'] }, { log: (m) => logs.push(m) });
  assert.ok(logs.includes('nothing reviewable in the diff'), logs.join('\n'));
  assert.strictEqual(r.gaps, false);
  const again = await review(repo, 'flags2', findings(), { base: 'main', 'test-paths': ['qa/'], 'requirements-paths': ['docs/**'], 'standards-paths': ['RULES.md'] });
  assert.strictEqual(again.gaps, true, 'unrelated globs change nothing');
  git(repo, 'remote', 'add', 'origin', path.join(tmp, 'flags-nowhere.git'));
  git(repo, 'update-ref', 'refs/remotes/origin/main', git(repo, 'rev-parse', 'main'));
  const warn = [];
  await review(repo, 'flags3', findings(), { base: 'origin/main' }, { log: (m) => warn.push(m) });
  assert.ok(warn.some((l) => /could not fetch origin\/main/.test(l)), warn.join('\n'));
});

test('--fail-on-gaps gates on the VALIDATED review (V5): a low-confidence finding and a finding whose citation does not verify do not block', async () => {
  const { repo } = makeRepo('gate');
  const low = await review(repo, 'low', findings({ findings: [{ ...findings().findings[0], confidence: 'low' }] }));
  assert.strictEqual(low.comments.length, 0);
  assert.match(low.summary, /low confidence/);
  assert.strictEqual(low.gaps, false);
  const dropped = findings();
  dropped.findings[0].quote = 'this line is not in the file';
  const bad = await review(repo, 'dropped', dropped);
  assert.strictEqual(bad.comments.length, 0);
  assert.strictEqual(bad.gaps, false, 'the raw findings.json holds a missing_test, the validated review does not');
  assert.strictEqual((await review(repo, 'high', findings())).gaps, true);
});

test('validatedGaps: inline comments need high confidence; summary items count unless post.js marked them low confidence', () => {
  const comment = (kind, confidence) => ({ path: 'a.js', line: 1, body: `**T**\n\nb\n\n<!-- specguard kind: ${kind}, confidence: ${confidence} -->` });
  assert.strictEqual(validatedGaps({ comments: [comment('missing_test', 'high')], summary: '' }), true);
  assert.strictEqual(validatedGaps({ comments: [comment('weak_test', 'high')], summary: '' }), true);
  assert.strictEqual(validatedGaps({ comments: [comment('missing_test', 'low')], summary: '' }), false);
  assert.strictEqual(validatedGaps({ comments: [comment('standards_violation', 'high')], summary: '' }), false);
  assert.strictEqual(validatedGaps({ comments: [], summary: '- ❌ **Missing test:** Test it `src/a.js:3` (inline limit reached) — x\n' }), true);
  assert.strictEqual(validatedGaps({ comments: [], summary: '- ❌ **Weak test:** Test it `src/a.js:3` — x\n' }), true);
  assert.strictEqual(validatedGaps({ comments: [], summary: '- ❌ **Missing test:** Test it `src/a.js:3` (low confidence) — x\n' }), false);
  assert.strictEqual(validatedGaps({ comments: [], summary: '- ❌ **Violation:** Style `src/a.js:3` — rule: `R.md`\n' }), false);
  assert.strictEqual(validatedGaps({ comments: [], summary: '### ❌ Missing unit tests (1)\n\n- Test it `src/a.js:3` (inline limit reached) — x\n' }), true);
  assert.strictEqual(validatedGaps({ comments: [], summary: '### ❌ Weak unit tests (1)\n\n- Test it `src/a.js:3` (low confidence) — x\n' }), false);
  assert.strictEqual(validatedGaps({ comments: [], summary: '### ❌ Coding standard violations (1)\n\n- Style `src/a.js:3` — rule: `R.md`\n' }), false);
  assert.strictEqual(validatedGaps({}), false);
});

test('SIGINT while the engine runs: the child is stopped, the worktree and temp dir are removed, exit code 130', async () => {
  const { repo } = makeRepo('signal');
  const bin = path.join(tmp, 'signal-bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'copilot'), '#!/usr/bin/env bash\n[ "$1" = --version ] && { echo "GitHub Copilot CLI 1.0.92."; exit 0; }\nsleep 3\n', { mode: 0o755 });
  const before = new Set(fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('specguard-local-') && !n.startsWith('specguard-local-bin-test-')));
  const proc = new EventEmitter(), codes = [];
  proc.exit = (c) => codes.push(c);
  const oldPath = process.env.PATH;
  process.env.PATH = bin + path.delimiter + oldPath;
  const logs = [];
  try {
    await assert.rejects(run({ cwd: repo, opts: { base: 'main' }, proc, log: (m) => { logs.push(m); if (/running Copilot/.test(m)) setTimeout(() => proc.emit('SIGINT'), 500); } }), /interrupted/);
  } finally { process.env.PATH = oldPath; }
  assert.deepStrictEqual(codes, [130]);
  assert.ok(logs.some((l) => /interrupted \(SIGINT\)/.test(l)));
  assert.strictEqual(git(repo, 'worktree', 'list').split('\n').length, 1, 'no registered worktree is left');
  const left = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('specguard-local-') && !n.startsWith('specguard-local-bin-test-') && !before.has(n));
  assert.deepStrictEqual(left, [], 'no temp dir is left');
  assert.strictEqual(proc.listenerCount('SIGINT') + proc.listenerCount('SIGTERM'), 0, 'the handlers are removed when the run ends');
});

test('a stub copilot (VS Code prints "Cannot find GitHub Copilot CLI", exit 0) fails up front: clear message, no worktree', async () => {
  const { repo } = makeRepo('stub');
  const bin = path.join(tmp, 'stub-bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'copilot'), '#!/usr/bin/env bash\necho "Cannot find GitHub Copilot CLI (https://docs.github.com/copilot)"\n', { mode: 0o755 });
  const oldPath = process.env.PATH;
  process.env.PATH = bin + path.delimiter + oldPath;
  try { await assert.rejects(run({ cwd: repo, opts: { base: 'main' }, log: quiet }), /Copilot CLI not found or not runnable \(Cannot find GitHub Copilot CLI.*; install @github\/copilot .*first on PATH/); } finally { process.env.PATH = oldPath; }
  assert.strictEqual(git(repo, 'worktree', 'list').split('\n').length, 1, 'no worktree was created');
});

test('main: exit code is 0 (advisory) unless --fail-on-gaps and gaps exist; --json is parseable', async () => {
  const { repo } = makeRepo('exit');
  const cwd = process.cwd(), log = console.log, err = console.error, lines = [];
  process.chdir(repo); console.log = (m) => lines.push(m); console.error = quiet;
  try {
    process.env.SPECGUARD_LOCAL_FINDINGS = canned('gap', findings());
    assert.strictEqual(await main(['--base', 'main']), 0);
    assert.strictEqual(await main(['--base', 'main', '--fail-on-gaps']), 1);
    lines.length = 0;
    assert.strictEqual(await main(['--base', 'main', '--json']), 0);
    const j = JSON.parse(lines.join('\n'));
    assert.strictEqual(j.gaps, true); assert.strictEqual(j.comments.length, 1); assert.ok(j.summary);
    process.env.SPECGUARD_LOCAL_FINDINGS = canned('clean', findings({ findings: [], coverage: [{ ...findings().coverage[0], status: 'covered', evidence: [{ path: 'src/price.js', line: 2, quote: behaviour.quote, layer: 'unit', kind: 'assertion', proves: 'The cap is asserted.' }] }] }));
    assert.strictEqual(await main(['--base', 'main', '--fail-on-gaps']), 0);
  } finally { process.chdir(cwd); console.log = log; console.error = err; delete process.env.SPECGUARD_LOCAL_FINDINGS; }
});
