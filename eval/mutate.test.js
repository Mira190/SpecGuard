const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const M = require('./mutate');
const { validateManifest } = require('./run');

const SPEC = `# Claims

## Acceptance criteria

AC-1: A claim must include the policy number.
AC-4: A claim filed more than 30 days after the incident is rejected as late.
AC-6: Archived claims are purged after 30 days.
`;
const FILES = {
  'docs/specs/claims.md': SPEC,
  'src/deadline.js': `// Claim filing deadline.
const FILING_WINDOW_DAYS = 30;
function isLate(ageDays) {
  return ageDays > FILING_WINDOW_DAYS;
}
module.exports = { isLate, FILING_WINDOW_DAYS };
`,
  'src/archive.js': `const ARCHIVE_AFTER_DAYS = 30;
module.exports = { ARCHIVE_AFTER_DAYS };
`,
  'src/deadline.test.js': `const test = require('node:test');
const assert = require('node:assert/strict');
const { isLate } = require('./deadline');

test('late claims are rejected', () => {
  assert.equal(isLate(31), true);
  assert.equal(isLate(29), false);
});
`,
  'src/pause.py': 'import time\n\ndef wait():\n    return 30\n',
};
const triple = (over = {}) => ({
  id: 'claims-AC-4-30', value: '30', confirmed: true,
  spec: { path: 'docs/specs/claims.md', ref: 'AC-4', line: 6 },
  sites: [{ path: 'src/deadline.js', line: 2 }, { path: 'src/archive.js', line: 1 }],
  tests: [{ path: 'src/deadline.test.js', line: 6 }, { path: 'src/deadline.test.js', line: 7 }],
  ...over,
});
const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `mutate-${name}-`));
const write = (dir, files) => { for (const [p, t] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true }); fs.writeFileSync(path.join(dir, p), t); } };
const lineOf = (files, p, l) => files[p].split('\n')[l - 1];
const headOf = (op, files = FILES) => M.applyEdits(M.applyEdits(files, op.edits.base), op.edits.head);

test('nPrime is never equal to n and is x1.5 rounded', () => {
  for (let n = 2; n < 500; n++) assert.notEqual(M.nPrime(n), n);
  assert.equal(M.nPrime(30), 45);
  assert.equal(M.nPrime(2), 3);
});

test('walk skips .git, node_modules and binaries', () => {
  const d = tmp('walk');
  write(d, { 'a.js': 'x', 'node_modules/b.js': 'y', '.git/c': 'z' });
  fs.writeFileSync(path.join(d, 'bin.dat'), Buffer.from([1, 0, 2]));
  assert.deepEqual(Object.keys(M.walk(d)), ['a.js']);
});

test('proposeTriples finds the AC-4 triple, unconfirmed, with sites ranked in the top 8', () => {
  const d = tmp('propose');
  write(d, FILES);
  const p = M.proposeTriples({ dir: d });
  assert.equal(p.schema, 'specguard-bench-proposals/1');
  assert.deepEqual(M.validateProposals(p), []);
  const t = p.triples.find((x) => x.spec.ref === 'AC-4' && x.value === '30');
  assert.ok(t, JSON.stringify(p.triples.map((x) => x.id)));
  assert.equal(t.confirmed, null);
  assert.equal(t.spec.line, 6);
  assert.ok(t.sites.some((s) => s.path === 'src/deadline.js' && s.line === 2));
  assert.ok(t.sites.every((s) => s.rank >= 1 && s.rank <= 8) && t.sites.length <= 3);
  assert.ok(!t.sites.some((s) => s.path.endsWith('.test.js')));
  assert.ok(t.tests.some((x) => x.path === 'src/deadline.test.js' && [6, 7].includes(x.line)));
  assert.deepEqual(p.triples.map((x) => x.id), [...new Set(p.triples.map((x) => x.id))]);
});

test('proposeTriples honours top: a site outside the top-k windows is not proposed', () => {
  const d = tmp('top');
  write(d, { ...FILES, 'src/far.js': 'const unrelated = 30;\n' });
  const at = (top) => M.proposeTriples({ dir: d, top, max: 100 }).triples.find((x) => x.spec.ref === 'AC-4');
  assert.ok(at(8).sites.some((s) => s.path === 'src/far.js'));
  const t = at(1);
  assert.ok(t.sites.every((s) => s.rank === 1));
  assert.ok(!t.sites.some((s) => s.path === 'src/far.js'));
});

test('validateTriple: shape, value tokens and file kinds', () => {
  assert.deepEqual(M.validateTriple(triple(), FILES), []);
  assert.match(M.validateTriple(triple({ value: '1' }))[0], /integer >= 2/);
  assert.match(M.validateTriple(triple({ sites: [] }))[0], /1-3 production sites/);
  assert.match(M.validateTriple(triple({ tests: [] }))[0], /at least 1 test/);
  assert.match(M.validateTriple(triple({ confirmed: 'yes' }))[0], /confirmed must be/);
  assert.match(M.validateTriple(triple({ sites: [{ path: 'src/deadline.test.js', line: 6 }] }))[0], /not a production file/);
  assert.match(M.validateTriple(triple({ sites: [{ path: 'src/deadline.js', line: 1 }] }), FILES)[0], /does not contain 30/);
  assert.match(M.validateTriple(null)[0], /object/);
});

test('validateProposals rejects a wrong schema and duplicate ids', () => {
  assert.match(M.validateProposals({})[0], /proposals must be/);
  const t = triple();
  assert.ok(M.validateProposals({ schema: 'specguard-bench-proposals/1', triples: [t, t] }).some((e) => /duplicate id/.test(e)));
});

test('requireConfirmed and every operator refuse an unconfirmed triple', () => {
  assert.throws(() => M.requireConfirmed(triple({ confirmed: null })), /not confirmed/);
  for (const op of Object.keys(M.OPERATORS)) assert.throws(() => M.mutate(op, triple({ confirmed: null }), FILES), /refusing to emit a case/, op);
  assert.throws(() => M.mutate('B-value', triple({ confirmed: false }), FILES), /not confirmed/);
  assert.throws(() => M.mutate('Nope', triple(), FILES), /unknown operator/);
});

test('mutateAll skips unconfirmed triples and reports inapplicable operators', () => {
  const r = M.mutateAll({ triples: [triple(), triple({ id: 'x', confirmed: null }), triple({ id: 'one', sites: [triple().sites[0]] })], files: FILES });
  assert.equal(r.unconfirmed, 1);
  assert.ok(!r.ops.some((o) => o.id.startsWith('x-')));
  assert.ok(r.skipped.some((s) => s.triple === 'one' && s.operator === 'Partial'));
  assert.equal(r.ops.filter((o) => o.triple.id === 'claims-AC-4-30').length, 8);
});

test('B-value: spec 30 -> 45 only, expected names every confirmed site', () => {
  const op = M.mutate('B-value', triple(), FILES), h = headOf(op);
  assert.equal(op.id, 'claims-AC-4-30-bv');
  assert.deepEqual(op.edits.base, []);
  assert.equal(op.edits.head.length, 1);
  assert.match(lineOf(h, 'docs/specs/claims.md', 6), /more than 45 days/);
  assert.equal(h['src/deadline.js'], FILES['src/deadline.js']);
  const f = op.expected.findings[0];
  assert.equal(f.kind, 'spec_mismatch');
  assert.equal(f.line, 6);
  assert.ok(lineOf(h, f.path, f.line).includes(f.quote));
  assert.deepEqual(f.sites, ['deadline.js:2', 'archive.js:1']);
  assert.ok(new RegExp(f.text, 'i').test('see deadline.js:2'));
  assert.ok(new RegExp(f.text, 'i').test('see archive.js:1'));
  assert.ok(op.expected.acceptable.every((a) => a.kind.includes('weak_test')));
});

test('B-boundary swaps the comparison phrase; fails without one', () => {
  const op = M.mutate('B-boundary', triple(), FILES);
  assert.match(lineOf(headOf(op), 'docs/specs/claims.md', 6), /at least 30 days/);
  assert.deepEqual(op.expected.findings[0].kind, ['spec_mismatch', 'weak_test']);
  const f2 = { ...FILES, 'docs/specs/claims.md': SPEC.replace('more than 30', 'at least 30') };
  assert.match(lineOf(headOf(M.mutate('B-boundary', triple(), f2), f2), 'docs/specs/claims.md', 6), /more than 30 days/);
  assert.throws(() => M.mutate('B-boundary', triple({ spec: { path: 'docs/specs/claims.md', ref: 'AC-6', line: 7 } }), FILES), /no "more than"/);
  const f3 = { ...FILES, 'docs/specs/claims.md': SPEC.replace('more than 30', 'no more than 30') };
  assert.throws(() => M.mutate('B-boundary', triple(), f3), /no "more than"/);
});

test('A-value changes the first production literal only; expected names the spec item', () => {
  const op = M.mutate('A-value', triple(), FILES), h = headOf(op);
  assert.match(lineOf(h, 'src/deadline.js', 2), /= 45;/);
  assert.equal(h['src/archive.js'], FILES['src/archive.js']);
  assert.equal(h['docs/specs/claims.md'], SPEC);
  const f = op.expected.findings[0];
  assert.deepEqual([f.path, f.line], ['src/deadline.js', 2]);
  assert.ok(lineOf(h, f.path, f.line).includes(f.quote));
  assert.ok(new RegExp(f.text, 'i').test('AC-4'));
});

test('A-operator flips the comparison near the site; fails when there is none', () => {
  const op = M.mutate('A-operator', triple(), FILES), h = headOf(op);
  assert.match(lineOf(h, 'src/deadline.js', 4), /ageDays >= FILING_WINDOW_DAYS/);
  const f = op.expected.findings[0];
  assert.equal(f.line, 4);
  assert.ok(f.path.includes('src/deadline.test.js'));
  assert.ok(lineOf(h, f.path[0], f.line).includes(f.quote));
  const f2 = { ...FILES, 'src/deadline.js': FILES['src/deadline.js'].replace('>', '<=') };
  assert.match(lineOf(headOf(M.mutate('A-operator', triple(), f2), f2), 'src/deadline.js', 4), / < /);
  assert.throws(() => M.mutate('A-operator', triple({ sites: [{ path: 'src/archive.js', line: 1 }] }), FILES), /no comparison/);
});

test('Partial updates the spec, the first site and its test only; expected names the other sites', () => {
  const op = M.mutate('Partial', triple(), FILES), h = headOf(op);
  assert.match(lineOf(h, 'docs/specs/claims.md', 6), /45 days/);
  assert.match(lineOf(h, 'src/deadline.js', 2), /= 45;/);
  assert.match(lineOf(h, 'src/deadline.test.js', 6), /isLate\(46\)/);
  assert.match(lineOf(h, 'src/deadline.test.js', 7), /isLate\(44\)/);
  assert.equal(h['src/archive.js'], FILES['src/archive.js']);
  const f = op.expected.findings[0];
  assert.deepEqual(f.sites, ['archive.js:1']);
  assert.ok(new RegExp(f.text).test('archive.js:1') && !new RegExp(f.text).test('deadline.js:2'));
  assert.throws(() => M.mutate('Partial', triple({ sites: [triple().sites[0]] }), FILES), /at least 2/);
});

test('Control consistent changes spec, every site and the tests together', () => {
  const op = M.mutate('Control-consistent', triple(), FILES), h = headOf(op);
  assert.match(lineOf(h, 'src/archive.js', 1), /= 45;/);
  assert.match(lineOf(h, 'src/deadline.js', 2), /= 45;/);
  assert.match(lineOf(h, 'src/deadline.test.js', 6), /46/);
  assert.deepEqual(op.expected.findings, []);
  assert.deepEqual(op.expected.must_not, [{ kind: 'spec_mismatch' }]);
});

test('Control pre-existing: drift in base, head only adds a log line', () => {
  const op = M.mutate('Control-pre-existing', triple(), FILES);
  const b = M.applyEdits(FILES, op.edits.base), h = M.applyEdits(b, op.edits.head);
  assert.match(lineOf(b, 'src/deadline.js', 2), /= 45;/);
  assert.equal(b['docs/specs/claims.md'], SPEC);
  assert.equal(h['src/deadline.js'].replace(/^\s*console\.log\('specguard-bench[^\n]*\n/m, ''), b['src/deadline.js']);
  assert.deepEqual(Object.keys(M.trees(op, FILES).head), ['src/deadline.js']);
  assert.equal(op.expected.pre_existing, true);
  assert.deepEqual(op.expected.findings, []);
  assert.throws(() => M.mutate('Control-pre-existing', triple({ sites: [{ path: 'src/pause.py', line: 4 }] }), { ...FILES, 'src/pause.py': 'def wait():\n    x = 1\n    y = 2\n    return 30:\n' }), /whole statement/);
  const py = M.mutate('Control-pre-existing', triple({ sites: [{ path: 'src/pause.py', line: 4 }] }), FILES);
  assert.match(py.edits.head[0].after, /\n    print\(/);
});

test('Control no-op is behaviour preserving: the fixture test passes before and after, exports are identical', () => {
  const op = M.mutate('Control-noop', triple(), FILES), h = headOf(op);
  assert.match(h['src/deadline.js'], /const SG_BENCH_VALUE = 30;\nconst FILING_WINDOW_DAYS = SG_BENCH_VALUE;/);
  assert.deepEqual(op.expected.findings, []);
  assert.deepEqual(op.expected.must_not, [{ kind: 'spec_mismatch' }]);
  assert.equal(op.expected.trace[0].alignment, 'consistent');
  const runIn = (files) => {
    const d = tmp('noop');
    write(d, files);
    execFileSync(process.execPath, ['--test', d], { stdio: 'pipe' }); // throws on a failing test
    return execFileSync(process.execPath, ['-e', "const d=require('./src/deadline');console.log(JSON.stringify([d.FILING_WINDOW_DAYS,d.isLate(30),d.isLate(31)]))"], { cwd: d, encoding: 'utf8' });
  };
  assert.equal(runIn(h), runIn(FILES));
  assert.equal(runIn(FILES).trim(), '[30,false,true]');
  // python and go statements; a mid-expression or unsupported site is refused
  const py = M.mutate('Control-noop', triple({ sites: [{ path: 'src/pause.py', line: 4 }] }), FILES);
  assert.match(py.edits.head[0].after, /^    SG_BENCH_VALUE = 30\n    return SG_BENCH_VALUE$/);
  assert.throws(() => M.mutate('Control-noop', triple({ sites: [{ path: 'docs/specs/claims.md', line: 6 }] }), FILES), /validateTriple|not a production file/);
  const go = { 'src/a.go': 'package a\n\nconst Limit = 30\n' };
  assert.match(M.mutate('Control-noop', triple({ sites: [{ path: 'src/a.go', line: 3 }] }), { ...FILES, ...go }).edits.head[0].after, /^const sgBenchValue = 30\nconst Limit = sgBenchValue$/);
  const mid = { ...FILES, 'src/mid.js': 'foo(\n  30,\n);\n' };
  assert.throws(() => M.mutate('Control-noop', triple({ sites: [{ path: 'src/mid.js', line: 2 }] }), mid), /not applicable/);
});

test('applyEdits and editLine reject stale or empty edits', () => {
  assert.throws(() => M.editLine(FILES, 'src/deadline.js', 99, (l) => l), /no such line/);
  assert.throws(() => M.editLine(FILES, 'src/deadline.js', 2, (l) => l), /changes nothing/);
  assert.throws(() => M.applyEdits(FILES, [{ path: 'src/deadline.js', line: 2, before: 'nope', after: 'x' }]), /does not match/);
  assert.throws(() => M.applyEdits(FILES, [{ path: 'missing.js', line: 1, before: '', after: 'x' }]), /no such file/);
});

test('toCase / writeCase: case.json schema, quotes found in the written trees, sandbox prefix', () => {
  const d = tmp('cases');
  for (const name of Object.keys(M.OPERATORS)) {
    const op = M.mutate(name, triple(), FILES), root = M.writeCase(d, op, FILES, { sandbox: true });
    const c = JSON.parse(fs.readFileSync(path.join(root, 'case.json'), 'utf8')), pre = `eval-sandbox/${op.id}/`;
    assert.equal(c.id, op.id);
    assert.equal(c.goal, 'traceability');
    assert.ok(c.description && c.pr_title && c.pr_body && Array.isArray(c.delete));
    assert.ok(!/claude|generated with|co-authored/i.test(`${c.pr_title}${c.pr_body}`));
    assert.ok(Array.isArray(c.expected.findings) && Array.isArray(c.expected.must_not));
    assert.ok(fs.readdirSync(path.join(root, 'head')).length, name);
    for (const f of c.expected.findings) {
      const p = [].concat(f.path)[0];
      assert.ok(p.startsWith(pre));
      if (f.quote) {
        const src = fs.existsSync(path.join(root, 'head', p.slice(pre.length))) ? 'head' : 'base';
        assert.ok(fs.readFileSync(path.join(root, src, p.slice(pre.length)), 'utf8').split('\n')[f.line - 1].includes(f.quote), `${name} ${p}:${f.line}`);
      }
    }
  }
  assert.equal(M.toCase(M.mutate('B-value', triple(), FILES)).expected.findings[0].path, 'docs/specs/claims.md');
});

test('manifestEntry passes eval/run.js validateManifest; validateBenchManifest adds the mutation checks', () => {
  const source = { url: 'https://example.invalid/owner/repo', sha: 'a'.repeat(40) };
  const entries = M.mutateAll({ triples: [triple()], files: FILES }).ops.map((op) => M.manifestEntry(op, { source }));
  assert.equal(entries.length, 8);
  assert.deepEqual(validateManifest(entries), []);
  assert.deepEqual(M.validateBenchManifest(entries), []);
  const bad = JSON.parse(JSON.stringify(entries));
  bad[0].mutation.operator = 'nope';
  bad[1].mutation.triple.confirmed = null;
  bad[2].mutation.edits.head = [];
  bad[3].mutation.edits.base = 'x';
  bad[4].pr_title = '';
  const errs = M.validateBenchManifest(bad);
  for (const re of [/mutation\.operator/, /confirmed triple/, /head must not be empty/, /edits\.base/, /pr_title/]) assert.ok(errs.some((e) => re.test(e)), String(re));
  assert.ok(M.validateBenchManifest('x').length);
});

const git = (d, ...a) => execFileSync('git', ['-C', d, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...a], { encoding: 'utf8' }).trim();

test('materialize creates base/head branches in a temp clone and refuses to run inside this repo', () => {
  const d = tmp('mat');
  git(d, 'init', '-q');
  write(d, FILES);
  git(d, 'add', '.');
  git(d, 'commit', '-q', '-m', 'init');
  const sha = git(d, 'rev-parse', 'HEAD');
  const entry = M.manifestEntry(M.mutate('Control-pre-existing', triple(), FILES), { source: { url: 'https://example.invalid/o/r', sha } });
  const { baseSha, headSha } = M.materialize({ dir: d, entry });
  assert.notEqual(baseSha, sha);
  assert.notEqual(baseSha, headSha);
  assert.match(git(d, 'show', `${baseSha}:src/deadline.js`), /= 45;/);
  assert.match(git(d, 'show', `${headSha}:src/deadline.js`), /specguard-bench/);
  assert.throws(() => M.materialize({ dir: __dirname, entry }), /refuses to run inside this repository/);
});

test('--mine: commits changing a spec item and a production file with the same number', () => {
  const d = tmp('mine');
  git(d, 'init', '-q');
  write(d, { 'docs/specs/claims.md': SPEC, 'src/deadline.js': FILES['src/deadline.js'], 'src/deadline.test.js': FILES['src/deadline.test.js'] });
  git(d, 'add', '.');
  git(d, 'commit', '-q', '-m', 'init');
  // spec only: not mined
  write(d, { 'docs/specs/claims.md': SPEC.replace('AC-1: A claim must include', 'AC-1: A claim shall include') });
  git(d, 'commit', '-q', '-am', 'wording');
  // code only: not mined
  write(d, { 'src/deadline.js': FILES['src/deadline.js'].replace('// Claim filing deadline.', '// Deadline.') });
  git(d, 'commit', '-q', '-am', 'code only');
  // spec + code + test, same number: mined
  write(d, { 'docs/specs/claims.md': SPEC.replace('AC-1: A claim must include', 'AC-1: A claim shall include').replace('more than 30 days', 'more than 45 days'),
    'src/deadline.js': FILES['src/deadline.js'].replace('// Claim filing deadline.', '// Deadline.').replace('= 30', '= 45'), 'src/deadline.test.js': FILES['src/deadline.test.js'].replace('isLate(31)', 'isLate(46)') });
  git(d, 'commit', '-q', '-am', 'extend window to 45');
  // spec 30 -> 60 and code 7 -> 9: different numbers, not mined
  write(d, { 'docs/specs/claims.md': SPEC.replace('purged after 30', 'purged after 60').replace('AC-1: A claim must include', 'AC-1: A claim shall include').replace('more than 30 days', 'more than 45 days'), 'src/archive.js': 'const a = 7;\n' });
  git(d, 'add', '.');
  git(d, 'commit', '-q', '-m', 'mismatched numbers');
  write(d, { 'src/archive.js': 'const a = 9;\n' });
  git(d, 'commit', '-q', '-am', 'second half');
  const p = M.mineHistory({ dir: d });
  assert.deepEqual(M.validateProposals(p), []);
  assert.throws(() => M.mutate('B-value', { ...p.triples[0], confirmed: true }, FILES), /mined triples/);
  assert.equal(p.triples.length, 1, JSON.stringify(p.triples));
  const t = p.triples[0];
  assert.equal(t.kind, 'mined');
  assert.equal(t.confirmed, null);
  assert.equal(t.subject, 'extend window to 45');
  assert.deepEqual([t.value, t.new_value], ['30', '45']);
  assert.equal(t.spec.path, 'docs/specs/claims.md');
  assert.equal(t.spec.ref, 'AC-4');
  assert.deepEqual(t.sites.map((s) => [s.path, s.line]), [['src/deadline.js', 2]]);
  assert.deepEqual(t.tests.map((s) => s.path), []);
  assert.equal(t.commit, git(d, 'log', '--format=%H', '--grep=extend window'));
  assert.deepEqual(M.mineHistory({ dir: d, commits: 1 }).triples, []);
});

test('numericChanges pairs one changed integer per hunk and ignores ambiguous hunks', () => {
  const diff = `diff --git a/a.js b/a.js
--- a/a.js
+++ b/a.js
@@ -3 +3 @@
-const A = 30;
+const A = 45;
@@ -9,2 +9,2 @@
-const B = 5, C = 6;
+const B = 7, C = 8;
`;
  assert.deepEqual([...M.numericChanges(diff)], [['a.js', [{ line: 3, from: '30', to: '45', text: 'const A = 45;' }]]]);
});

test('CLI: propose, emit (confirmed only), and refusal of an unconfirmed --triple', () => {
  const d = tmp('cli'), out = tmp('cliout'), cli = path.join(__dirname, 'mutate.js');
  write(d, FILES);
  const run = (...a) => execFileSync(process.execPath, [cli, ...a], { encoding: 'utf8', stdio: 'pipe' });
  const pf = path.join(out, 'p.json');
  run('--propose', d, '--out', pf);
  const props = JSON.parse(fs.readFileSync(pf, 'utf8'));
  assert.ok(props.triples.length && props.triples.every((t) => t.confirmed === null));
  const emit = ['--emit', pf, '--dir', d, '--source-url', 'https://example.invalid/o/r', '--source-sha', 'b'.repeat(40), '--manifest', path.join(out, 'm.json')];
  assert.throws(() => run(...emit), (e) => /no cases: .* unconfirmed/.test(e.stderr));
  assert.throws(() => run(...emit, '--triple', props.triples[0].id), (e) => /not confirmed/.test(e.stderr));
  assert.ok(!fs.existsSync(path.join(out, 'm.json')));
  props.triples[0].confirmed = true;
  fs.writeFileSync(pf, JSON.stringify(props));
  const msg = run(...emit, '--ops', 'B-value,A-value', '--cases-dir', path.join(out, 'cases'));
  assert.match(msg, /cases; \d+ unconfirmed/);
  const m = JSON.parse(fs.readFileSync(path.join(out, 'm.json'), 'utf8'));
  assert.deepEqual(m.map((e) => e.mutation.operator), ['B-value', 'A-value']);
  assert.deepEqual(M.validateBenchManifest(m), []);
  assert.ok(fs.existsSync(path.join(out, 'cases', m[0].id, 'case.json')));
  assert.match(run(), /Usage/);
});
