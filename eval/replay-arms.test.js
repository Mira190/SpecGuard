const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { score, discover } = require('./replay-arms.js');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'specguard-arms-test-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();
const w = (p, s) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); };

function mkRepo() {
  const d = path.join(tmp, 'repos', 'proj');
  fs.mkdirSync(d, { recursive: true });
  git(d, 'init', '-q');
  for (const [k, v] of [['user.name', 't'], ['user.email', 't@example.invalid'], ['commit.gpgsign', 'false']]) git(d, 'config', k, v);
  w(path.join(d, 'src', 'a.js'), 'exports.limit = (n) => n > 3;\n');
  git(d, 'add', '-A'); git(d, 'commit', '-q', '-m', 'base');
  const base = git(d, 'rev-parse', 'HEAD');
  w(path.join(d, 'src', 'a.js'), 'exports.limit = (n) => n > 5;\n');
  w(path.join(d, 'src', 'a.test.js'), "assert.ok(limit(6));\n");
  git(d, 'add', '-A'); git(d, 'commit', '-q', '-m', 'head');
  return { base, head: git(d, 'rev-parse', 'HEAD') };
}

const behaviour = { path: 'src/a.js', line: 1, quote: 'exports.limit = (n) => n > 5;' };
const findings = () => ({
  requirements: [], requirements_source: 'PR body', not_reviewed: '',
  coverage: [{ id: 'O1', obligation: 'limit is 5', source: 'PR body AC 1', behaviour, change: behaviour, status: 'weak_test', reason: 'Searched the unit suites for limit.', alignment: { status: 'not_applicable', reason: 'No requirement governs this obligation.' },
    evidence: [{ path: 'src/a.test.js', line: 1, quote: 'assert.ok(limit(6));', layer: 'unit', kind: 'assertion', proves: 'Returns a truthy value above the limit.' }] }],
  findings: [{ kind: 'weak_test', obligation_ids: ['O1'], ...behaviour, title: 'Limit test accepts a wrong threshold', body: 'The assertion only checks one value.', confidence: 'low', counterexample: 'limit(4) returns true -> assert.ok(limit(6)) still passes' }],
  standards: { status: 'checked', sources: [], reason: 'No standards.' }, layering: { status: 'checked', reason: 'Nothing to move.' },
});

test('discover reads both layouts; runs without ctx/findings.json are reported unusable and nothing is scored', async () => {
  const dl = path.join(tmp, 'dl-old'), out = path.join(tmp, 'out-old');
  w(path.join(dl, '111', 'x-1', 'result.json'), '{"id":"x-1"}'); w(path.join(dl, '111', 'x-1', 'ctx', 'counts.json'), '{}');
  w(path.join(dl, 'x-2', 'result.json'), '{"id":"x-2"}');
  assert.deepStrictEqual(discover(dl).map((p) => `${p.run}/${p.id}`).sort(), ['0/x-2', '111/x-1']);
  fs.mkdirSync(path.join(dl, 'x-2', 'ctx'));
  fs.mkdirSync(out, { recursive: true });
  const r = await score({ dl, repos: path.join(tmp, 'repos'), out, log: () => {} });
  assert.strictEqual(r.rows.length, 0);
  assert.strictEqual(r.unusable.length, 2);
  assert.match(r.unusable[0].reason, /no ctx\/findings\.json/);
});

test('a usable run is re-posted twice from the same raw answer: V moves the low defect claim from Details to the visible body, inline is unchanged', async () => {
  const { base, head } = mkRepo(), dl = path.join(tmp, 'dl-new'), out = path.join(tmp, 'out-new');
  const dir = path.join(dl, '222', 'p-1');
  w(path.join(dir, 'result.json'), JSON.stringify({ id: 'p-1', repo: 'o/proj', base, head, trace: 'auto', model: 'claude-haiku-5-5', valid: true }));
  w(path.join(dir, 'ctx', 'findings.json'), JSON.stringify(findings()));
  w(path.join(dir, 'ctx', 'engine-notes'), 'context pack: 3 files, 1 KB\n');
  fs.mkdirSync(out, { recursive: true });
  const r = await score({ dl, repos: path.join(tmp, 'repos'), out, log: () => {} });
  assert.deepStrictEqual(r.unusable, []);
  const [a, v, v2] = r.rows;
  assert.deepStrictEqual([a.arm, v.arm, v2.arm, a.id, a.run], ['A', 'V1', 'V2', 'p-1', '222']);
  assert.deepStrictEqual([a.visible_n, a.details_n, v.visible_n, v.details_n, v2.visible_n], [0, 1, 1, 0, 1]);
  assert.strictEqual(v.inline_n, a.inline_n);
  const vis = (arm) => fs.readFileSync(path.join(out, `run222-${arm}`, 'p-1', 'visible.md'), 'utf8').replace(/<!--[^]*?-->/g, '');
  assert.match(vis('V1'), /Unconfirmed findings \(low confidence, check before acting\)/);
  assert.doesNotMatch(vis('A'), /Unconfirmed findings|Limit test accepts/);
  assert.ok(fs.existsSync(path.join(out, 'run222-V1', 'p-1', 'summary.md')));
  assert.strictEqual(process.env.EXP_LOWCONF_VISIBLE, undefined, 'the variable is restored');
});
