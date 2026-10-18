const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { score, discover, parseArms } = require('./replay-arms.js');

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

test('parseArms: default A, NAME=ENV=VAL arms, A first and unique', () => {
  assert.deepStrictEqual(parseArms(), [{ name: 'A' }]);
  assert.deepStrictEqual(parseArms('A,H3=EXP_X=1,H4=EXP_Y=a=b'), [{ name: 'A' }, { name: 'H3', key: 'EXP_X', val: '1' }, { name: 'H4', key: 'EXP_Y', val: 'a=b' }]);
  for (const bad of ['', 'H3=EXP_X=1', 'A,A', 'A,b-c=X=1']) assert.throws(() => parseArms(bad), /bad --arms/);
});

test('a usable run is re-posted once per arm from the same raw answer; an arm sets its env only for its own post.js run', async () => {
  const { base, head } = mkRepo(), dl = path.join(tmp, 'dl-new'), out = path.join(tmp, 'out-new');
  const dir = path.join(dl, '222', 'p-1');
  w(path.join(dir, 'result.json'), JSON.stringify({ id: 'p-1', repo: 'o/proj', base, head, trace: 'auto', model: 'claude-haiku-5-5', valid: true }));
  w(path.join(dir, 'ctx', 'findings.json'), JSON.stringify(findings()));
  w(path.join(dir, 'ctx', 'engine-notes'), 'context pack: 3 files, 1 KB' + String.fromCharCode(10));
  fs.mkdirSync(out, { recursive: true });
  const r = await score({ dl, repos: path.join(tmp, 'repos'), out, arms: parseArms('A,X=SG_ARMS_TEST=1'), log: () => {} });
  assert.deepStrictEqual(r.unusable, []);
  const [a, x] = r.rows;
  assert.deepStrictEqual([a.arm, x.arm, a.id, a.run], ['A', 'X', 'p-1', '222']);
  assert.deepStrictEqual([a.visible_n, a.details_n, x.visible_n, x.details_n, x.inline_n], [0, 1, 0, 1, a.inline_n]);
  for (const arm of ['A', 'X']) assert.ok(fs.existsSync(path.join(out, 'run222-' + arm, 'p-1', 'visible.md')));
  assert.strictEqual(process.env.SG_ARMS_TEST, undefined, 'the variable is restored');
});

test('--engine mock-replay runs the real claude-api engine once on the saved answer; a file cut by a small pack budget lands in the arm ctx and the arm summary says the context was cut', async () => {
  const d = path.join(tmp, 'repos', 'big'), body = (n) => Array.from({ length: 1200 }, (_, i) => `const value${i} = ${i};`).join('\n') + `\nexports.limit = (n) => n > ${n};\n`;
  fs.mkdirSync(d, { recursive: true });
  git(d, 'init', '-q');
  for (const [k, v] of [['user.name', 't'], ['user.email', 't@example.invalid'], ['commit.gpgsign', 'false']]) git(d, 'config', k, v);
  w(path.join(d, 'src', 'a.js'), body(3));
  git(d, 'add', '-A'); git(d, 'commit', '-q', '-m', 'base');
  const base = git(d, 'rev-parse', 'HEAD');
  w(path.join(d, 'src', 'a.js'), body(5));
  w(path.join(d, 'src', 'a.test.js'), 'assert.ok(limit(6));\n');
  git(d, 'add', '-A'); git(d, 'commit', '-q', '-m', 'head');
  const head = git(d, 'rev-parse', 'HEAD'), at = { path: 'src/a.js', line: 1201, quote: 'exports.limit = (n) => n > 5;' };
  const f = findings();
  f.coverage[0].behaviour = f.coverage[0].change = at; Object.assign(f.findings[0], at);
  const dl = path.join(tmp, 'dl-mock'), out = path.join(tmp, 'out-mock'), dir = path.join(dl, '333', 'm-1'), logs = [];
  w(path.join(dir, 'result.json'), JSON.stringify({ id: 'm-1', repo: 'o/big', base, head, trace: 'auto', model: 'claude-haiku-5-5', valid: true }));
  w(path.join(dir, 'ctx', 'findings.json'), JSON.stringify(f));
  fs.mkdirSync(out, { recursive: true });
  const saved = process.env.CONTEXT_PACK_BYTES;
  process.env.CONTEXT_PACK_BYTES = '1000'; // too small for any file: the candidate test is cut
  try { await score({ dl, repos: path.join(tmp, 'repos'), out, engine: 'mock-replay', log: (m) => logs.push(m) }); }
  finally { if (saved === undefined) delete process.env.CONTEXT_PACK_BYTES; else process.env.CONTEXT_PACK_BYTES = saved; }
  assert.ok(!logs.some((m) => /^note:/.test(m)), `exactly one mocked API call (no repair or failure): ${logs.join(' | ')}`);
  const ctx = path.join(out, 'run333-A', 'm-1', 'ctx'); // the saved dir has no pack-cut.txt: only the engine can have written these
  assert.ok(fs.readFileSync(path.join(ctx, 'pack-cut.txt'), 'utf8').split('\n').includes('src/a.test.js'));
  assert.ok(fs.existsSync(path.join(ctx, 'pack-shown.txt')));
  assert.match(fs.readFileSync(path.join(out, 'run333-A', 'm-1', 'summary.md'), 'utf8'), /Review context was cut: the model saw only part of `src\/a\.test\.js`/);
});
