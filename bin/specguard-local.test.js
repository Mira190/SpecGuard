const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { parse, resolveBase, run, format, main } = require('./specguard-local.js');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'specguard-local-bin-test-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const quiet = () => {};

function makeRepo(name) {
  const repo = path.join(tmp, name);
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  for (const [k, v] of [['user.name', 't'], ['user.email', 't@example.invalid'], ['commit.gpgsign', 'false'], ['core.autocrlf', 'false']]) git(repo, 'config', k, v);
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

test('parse: flags, defaults, rejects unknown flags', () => {
  assert.deepStrictEqual(parse([]), {});
  const o = parse(['--base', 'origin/dev', '--model', 'gpt-5', '--effort', 'high', '--auto-tier', 'balance', '--json', '--fail-on-gaps', '--body', 'b.md']);
  assert.deepStrictEqual(o, { base: 'origin/dev', model: 'gpt-5', effort: 'high', 'auto-tier': 'balance', json: true, 'fail-on-gaps': true, body: 'b.md' });
  assert.throws(() => parse(['--engine', 'claude']));
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
  assert.throws(() => resolveBase(repo, 'nope'), /unknown base ref/);
  git(repo, 'branch', '-m', 'main', 'master');
  assert.strictEqual(resolveBase(repo).ref, 'master');
  git(repo, 'branch', '-m', 'master', 'trunk');
  assert.throws(() => resolveBase(repo), /no base branch/);
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
