const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const T = require('./trace');

// ---- helpers: a throwaway git repo from { path: text } maps, or from a fixture dir with base/ and head/ ----
const tmp = (t) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'specguard-trace-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };
function repo(t, baseFiles, headFiles) {
  const dir = tmp(t);
  const git = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'core.autocrlf=false', '-c', 'commit.gpgsign=false', ...a], { cwd: dir, encoding: 'utf8' }).trim();
  const put = (files) => { for (const [f, text] of Object.entries(files)) {
    const p = path.join(dir, f);
    if (text === null) { fs.rmSync(p, { force: true }); continue; }
    fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text);
  } };
  git('init', '-q'); put(baseFiles); git('add', '-A'); git('commit', '-qm', 'base');
  const base = git('rev-parse', 'HEAD');
  put(headFiles); git('add', '-A'); git('commit', '-qm', 'head', '--allow-empty');
  const ctx = path.join(dir, '..', path.basename(dir) + '-ctx'); fs.mkdirSync(ctx); t.after(() => fs.rmSync(ctx, { recursive: true, force: true }));
  return { dir, base, head: git('rev-parse', 'HEAD'), ctx };
}
const readTree = (root) => { const out = {}; (function walk(d, rel) { for (const e of fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }) : []) {
  const p = path.join(d, e.name), r = rel ? `${rel}/${e.name}` : e.name;
  if (e.isDirectory()) walk(p, r); else out[r] = fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n'); // the checkout's line endings (autocrlf) must not matter
} })(root, ''); return out; };
const FIX = path.join(__dirname, 'fixtures');
const fixture = (t, id) => { const dir = path.join(FIX, `trace-${id}`); return { ...repo(t, readTree(path.join(dir, 'base')), readTree(path.join(dir, 'head'))), expect: JSON.parse(fs.readFileSync(path.join(dir, 'expect.json'), 'utf8')) }; };
const out = (r, name) => fs.readFileSync(path.join(r.ctx, name), 'utf8');
const cands = (r) => JSON.parse(out(r, 'trace-candidates.json'));
const status = (r) => JSON.parse(out(r, 'requirements-status.json'));

// ---- tokenize ----
test('tokenize splits camelCase, snake_case, digits, drops plural s and bigrams CJK', () => {
  assert.deepEqual(T.tokenize('FILING_WINDOW_DAYS = 30'), ['filing', 'window', 'day', '30']);
  assert.deepEqual(T.tokenize('calcPremium HTTPServer v2beta'), ['calc', 'premium', 'http', 'server', 'v', '2', 'beta']);
  assert.deepEqual(T.tokenize('claims status class'), ['claim', 'status', 'class']);
  assert.deepEqual(T.tokenize('验收标准 a'), ['验收', '收标', '标准', 'a']);
  assert.deepEqual(T.tokenize('的'), ['的']);
});

// ---- BM25 ----
test('buildIndex ranks the rarer-term document first and has() reports term membership', () => {
  const docs = [['claim', 'limit', 'thirty'], ['claim', 'claim', 'claim', 'form'], ['form', 'color']];
  const ix = T.buildIndex(docs);
  const s = ix.search(['thirty', 'claim']);
  assert.ok(s[0] > s[1] && s[1] > 0 && s[2] === 0);
  assert.equal(ix.size, 3);
  assert.ok(ix.idf('thirty') > ix.idf('claim'));
  assert.equal(ix.has('claim', 1), true);
  assert.equal(ix.has('claim', 2), false);
});

test('buildIndex with a term filter streams a generator and keeps only those postings', () => {
  function* gen() { yield ['a', 'b']; yield ['b', 'c']; yield ['c']; }
  const ix = T.buildIndex(gen(), new Set(['b']));
  assert.equal(ix.size, 3);
  assert.deepEqual([...ix.search(['a', 'b'])].map((x) => x > 0), [true, true, false]);
  assert.equal(ix.has('a', 0), false);
});

// ---- item parser ----
test('parseItems reads ID items, spans and heading items, wrapped or marked IDs', () => {
  const text = ['# Spec', '', '## Rules', '', 'R1: First rule.', 'continues here.', '', '- **R2**: A list rule.', '',
    '### R3 — Premium cap', 'The premium is capped.', '', 'More detail.', '### Other', 'Plain prose.', '', 'AC 4: Labelled.', 'FR-1.2) Dotted.'].join('\n');
  const items = T.parseItems('docs/s.md', text);
  assert.deepEqual(items.map((i) => [i.ref, i.line, i.end, i.kind]), [['R1', 5, 6, 'id'], ['R2', 8, 8, 'id'], ['R3', 10, 13, 'id'], ['AC4', 17, 17, 'id'], ['FR-1.2', 18, 18, 'id']]);
  assert.equal(items[0].text, 'R1: First rule.\ncontinues here.');
  assert.equal(items[0].heading, 'Rules');
  assert.equal(items[2].text.startsWith('R3 — Premium cap'), true);
  assert.equal(items[0].normative, true);
});

test('parseItems reads list items under an acceptance-criteria heading and CJK headings', () => {
  const items = T.parseItems('d.md', '# T\n\n## Acceptance criteria\n\n- Reject zero.\n- [ ] Accept positive values.\n  Keep precision.\n\n## Notes\n\n- not a criterion\n\n## 验收标准\n1. 返回明确错误。\n');
  assert.deepEqual(items.map((i) => [i.ref, i.text, i.kind]), [['acceptance-criteria#1', 'Reject zero.', 'ac'],
    ['acceptance-criteria#2', 'Accept positive values.\nKeep precision.', 'ac'], ['验收标准#1', '返回明确错误。', 'ac']]);
});

test('parseItems reads Gherkin scenarios and refs them by the first digit tag or the scenario name', () => {
  const text = 'Feature: F\n\n  @smoke @AC-4\n  Scenario Outline: Late\n    Given <d>\n    Examples:\n      | d |\n      | 30 |\n\n  Scenario: Plain\n    Then ok\n';
  const items = T.parseItems('features/c.feature', text);
  assert.deepEqual(items.map((i) => [i.ref, i.line, i.end, i.kind]), [['@AC-4', 3, 8, 'gherkin'], ['Scenario: Plain', 10, 11, 'gherkin']]);
  assert.match(items[0].text, /\| 30 \|/);
});

test('parseItems finds normative sentences with heading#n refs and skips second-person and imperative process text', () => {
  const text = ['# Guide', '', '## Pricing rules', '', 'The premium must never exceed twice the base rate. Uploads shall be under 10 MB.',
    'You must run npm test before pushing.', '', '- Run npm ci, it is required to work.', '- Prices must be integers', '- Please keep commits small, they must be atomic.',
    '', '```', 'The code must be ignored.', '```', '', 'WHEN a claim is late THE system SHALL refuse it.', '', 'Nothing normative here.', '上传必须小于十兆。'].join('\n');
  const items = T.parseItems('README.md', text);
  assert.deepEqual(items.map((i) => [i.ref, i.line, i.text]), [
    ['pricing-rules#1', 5, 'The premium must never exceed twice the base rate.'], ['pricing-rules#2', 5, 'Uploads shall be under 10 MB.'],
    ['pricing-rules#3', 9, 'Prices must be integers'], ['pricing-rules#4', 16, 'WHEN a claim is late THE system SHALL refuse it.'], ['pricing-rules#5', 19, '上传必须小于十兆。']]);
});

test('parseItems follows multi-line sentences and strips invisible characters', () => {
  const items = T.parseItems('a.md', '# H\nThe system must\nrefuse late​ claims.\n');
  assert.deepEqual(items.map((i) => [i.line, i.end, i.text]), [[2, 3, 'The system must\nrefuse late claims.']]);
});

test('parseItems leaves plain prose and an empty file without items', () => {
  assert.deepEqual(T.parseItems('a.md', '# Title\n\nJust a story about claims.\n'), []);
  assert.deepEqual(T.parseItems('a.md', ''), []);
});

test('isRequirementDoc needs one structured item or two normative sentences', () => {
  const n = { kind: 'normative' };
  assert.equal(T.isRequirementDoc([]), false);
  assert.equal(T.isRequirementDoc([n]), false);
  assert.equal(T.isRequirementDoc([n, n]), true);
  assert.equal(T.isRequirementDoc([{ kind: 'id' }]), true);
  assert.equal(T.isRequirementDoc([{ kind: 'gherkin' }]), true);
});

// ---- changed-item pairing and deltas ----
test('pairItems pairs by ref, falls back to heading and ordinal, and reports added and removed items', () => {
  const it = (ref, heading) => ({ ref, heading });
  const b = [it('R1', 'A'), it('x#1', 'Old heading'), it('R9', 'Z')];
  const h = [it('R1', 'A'), it('y#1', 'Old heading'), it('R2', 'A')];
  const pairs = T.pairItems(b, h);
  assert.deepEqual(pairs.map((p) => [p.base?.ref ?? null, p.head?.ref ?? null]), [['R1', 'R1'], ['x#1', 'y#1'], [null, 'R2'], ['R9', null]]);
});

test('valueDeltas lists numbers with units and quoted strings that differ', () => {
  assert.deepEqual(T.valueDeltas('AC-4: filed within 30 days; status "open"', 'AC-4: filed within 45 days; status "closed"'),
    { removed: ['30 days', 'open'], added: ['45 days', 'closed'] });
  assert.deepEqual(T.valueDeltas('same 30 days', 'same 30 days'), { removed: [], added: [] });
  assert.deepEqual(T.valueDeltas('', 'at most 5 % or 10 MB'), { removed: [], added: ['5 %', '10 mb'] });
  assert.deepEqual(T.valueDeltas('| 30 | 31 |', '| 45 | 31 |'), { removed: ['30'], added: ['45'] });
});

test('durationVariants expands durations and leaves other values bare', () => {
  assert.deepEqual(T.durationVariants('30 days'), ['30', '720', '2592000', '2592000000', 'P30D']);
  assert.deepEqual(T.durationVariants('2 hours'), ['2', '7200', '7200000', 'PT2H']);
  assert.deepEqual(T.durationVariants('45'), ['45']);
  assert.deepEqual(T.durationVariants('open'), ['open']);
});

// ---- path rules ----
test('isTestPath matches test directories and file suffixes only', () => {
  for (const p of ['src/a.test.ts', 'test/a.js', 'src/__tests__/a.js', 'a_spec.rb', 'pkg/tests/x.py', 'foo-test.go']) assert.equal(T.isTestPath(p), true, p);
  for (const p of ['src/contest.js', 'src/latest.js', 'src/premium.ts', 'docs/specs/a.md']) assert.equal(T.isTestPath(p), false, p);
});

test('pathKind classifies snapshot, test, doc, config and src by path', () => {
  assert.deepEqual(['web/__snapshots__/a.snap', 'a/b.snap', 'src/a.test.js', 'docs/a.md', 'web/i18n/en.json', 'cfg/app.yaml', 'src/a.ts', 'cron/.env.prod'].map(T.pathKind),
    ['snapshot', 'snapshot', 'test', 'doc', 'config', 'config', 'src', 'config']);
});

test('matchGlob follows collect.sh: star crosses slashes, leading **/ optional, trailing slash is a prefix', () => {
  assert.equal(T.matchGlob('docs/specs/a.md', 'docs/**'), true);
  assert.equal(T.matchGlob('pkg/docs/a.md', 'docs/**'), true);
  assert.equal(T.matchGlob('a/AGENTS.md', '**/AGENTS.md'), true);
  assert.equal(T.matchGlob('AGENTS.md', '**/AGENTS.md'), true);
  assert.equal(T.matchGlob('src/x.min.js', '*.min.*'), true);
  assert.equal(T.matchGlob('a/node_modules/b/c.md', 'node_modules/'), true);
  assert.equal(T.matchGlob('README.md', 'docs/**'), false);
  assert.equal(T.matchGlob('docs/a.md', 'docs/b?.md'), false);
});

// ---- code hunks ----
test('codeHunks reports line range, git function context, split identifiers and literals per hunk', () => {
  const patch = ['diff --git a/src/premium.ts b/src/premium.ts', '--- a/src/premium.ts', '+++ b/src/premium.ts', '@@ -8,5 +8,5 @@ export function calcPremium(product: string) {',
    '   const base = baseRate(product);', '-  return Math.min(loaded, base * 2);', '+  return Math.min(loaded, base * 3);', '   // end', '   return x;',
    'diff --git a/src/a.test.ts b/src/a.test.ts', '--- a/src/a.test.ts', '+++ b/src/a.test.ts', '@@ -1,1 +1,1 @@', '-expect(x).toBe("old");', '+expect(x).toBe("new");', ''].join('\n');
  const [h, t] = T.codeHunks(patch);
  assert.equal(h.path, 'src/premium.ts');
  assert.deepEqual([h.line, h.end, h.context, h.is_test], [9, 9, 'export function calcPremium(product: string) {', false]);
  assert.deepEqual(h.literals, { added: ['3'], removed: ['2'] });
  assert.ok(h.identifiers.includes('premium') && h.identifiers.includes('math') && h.identifiers.includes('min'));
  assert.deepEqual([t.path, t.is_test, t.literals], ['src/a.test.ts', true, { added: ['new'], removed: ['old'] }]);
  assert.deepEqual(T.codeHunks(''), []);
});

test('codeHunks anchors a pure deletion at the hunk start', () => {
  const patch = 'diff --git a/a.js b/a.js\n--- a/a.js\n+++ b/a.js\n@@ -4,2 +3,0 @@ function f() {\n-gone();\n-also();\n';
  const [h] = T.codeHunks(patch);
  assert.deepEqual([h.line, h.end, h.literals.removed], [3, 3, []]);
});

// ---- classify ----
test('classify keeps requirement docs and drops prose docs, process docs, standards and non-doc files', (t) => {
  const r = repo(t, { 'a.txt': 'x\n' }, {
    'docs/specs/c.md': '# C\n\nAC-1: Claims must be filed.\n', 'docs/guide.md': '# Guide\n\nHow to file a claim.\n',
    'docs/development.md': '# Dev\n\nYou must run npm test.\nBuilds must use Node 22.\n', 'CONTRIBUTING.md': 'R1: contributors must sign.\n',
    'CHANGELOG.md': 'R1: must.\n', 'src/a.js': 'AC-1: must\n' });
  const paths = ['docs/specs/c.md', 'docs/guide.md', 'docs/development.md', 'CONTRIBUTING.md', 'CHANGELOG.md', 'src/a.js'];
  assert.deepEqual(T.classify({ cwd: r.dir, base: r.base, head: r.head, paths }), ['docs/specs/c.md']);
});

test('classify honours requirements_paths include and exclude globs and reads deleted docs from base', (t) => {
  const r = repo(t, { 'docs/specs/old.md': '# O\n\nR1: Gone must stay gone.\n' }, {
    'docs/specs/old.md': null, 'docs/specs/c.md': '# C\n\nAC-1: x\n', 'notes/idea.md': 'Just prose.\n', 'src/a.js': 'x\n' });
  const paths = ['docs/specs/old.md', 'docs/specs/c.md', 'notes/idea.md'];
  assert.deepEqual(T.classify({ cwd: r.dir, base: r.base, head: r.head, paths }), ['docs/specs/old.md', 'docs/specs/c.md']);
  assert.deepEqual(T.classify({ cwd: r.dir, base: r.base, head: r.head, paths, reqPaths: 'notes/**\n!docs/specs/c.md' }), ['docs/specs/old.md', 'notes/idea.md']);
  assert.deepEqual(T.classify({ cwd: r.dir, base: r.base, head: r.head, paths: [] }), []);
});

// ---- run: fixtures, recall@8 ----
const found = (list, pred) => list.some(pred);
const RECALL = [];
for (const id of ['tr1', 'tr3', 'tr5', 'tr6', 'tr9', 'tr12', 'tr14', 'tr16', 'tr17']) {
  test(`run on fixture ${id} finds the expected location among the candidates`, (t) => {
    const r = fixture(t, id), e = r.expect;
    const count = T.run({ cwd: r.dir, base: r.base, head: r.head, ctx: r.ctx });
    const c = cands(r);
    assert.equal(count, e.count);
    assert.deepEqual(out(r, 'spec-files.txt').split('\n').filter(Boolean), e.specFiles);
    for (const a of e.a || []) {
      const hit = c.code_to_requirement.find((h) => h.path === a.path);
      const rank = hit ? hit.candidates.findIndex((x) => x.path === a.spec && (a.ref ? x.ref === a.ref : x.line === a.specLine)) : -1;
      RECALL.push([id, 'A', rank >= 0 && rank < 8]);
      assert.ok(rank >= 0 && rank < 8, `${a.path} -> ${a.spec} ${a.ref || a.specLine} rank ${rank}`);
    }
    if (e.aEmpty) assert.deepEqual(c.code_to_requirement, []);
    if (e.b) {
      const row = c.requirement_to_code.find((x) => x.criterion === e.b.criterion);
      for (const p of e.b.code) { const k = row.code.findIndex((x) => x.path === p); RECALL.push([id, 'B-code', k >= 0 && k < 8]); assert.ok(k >= 0 && k < 8, `code ${p} rank ${k}`); }
      for (const p of e.b.tests) { const k = row.tests.findIndex((x) => x.path === p); RECALL.push([id, 'B-test', k >= 0]); assert.ok(k >= 0, `test ${p}`); }
    }
    const occ = c.occurrences.flatMap((o) => o.hits);
    for (const p of e.occ || []) assert.ok(found(occ, (h) => h.path === p), `occurrence ${p}`);
    for (const p of e.notOcc || []) assert.ok(!found(occ, (h) => h.path === p), `no occurrence ${p}`);
    if (e.variants) assert.deepEqual(c.occurrences[0].variants, e.variants);
    if (e.deltas) assert.deepEqual(status(r).criteria[0].deltas, e.deltas);
    if (e.ref) assert.equal(status(r).criteria[0].ref, e.ref);
    if (e.classify) assert.deepEqual(T.classify({ cwd: r.dir, base: r.base, head: r.head, paths: e.classify.paths }), e.classify.expect);
  });
}
test('candidate recall@8 over the trace fixtures is 100%', () => {
  assert.ok(RECALL.length >= 10);
  assert.deepEqual(RECALL.filter((x) => !x[2]), []);
});

test('run writes the contract: S criterion, changed document, spec summary, stdout-count and exact candidate shape (tr3)', (t) => {
  const r = fixture(t, 'tr3');
  fs.writeFileSync(path.join(r.ctx, 'requirements-status.json'), JSON.stringify({ status: 'available', sources: ['PR body'], limitations: [], documents: [{ source: 'PR body', text: 'x' }], criteria: [{ id: 'R1', source: 'PR body', quote: 'q' }] }));
  assert.equal(T.run({ cwd: r.dir, base: r.base, head: r.head, ctx: r.ctx }), 1);
  const s = status(r), c = cands(r);
  assert.deepEqual(s.criteria.map((x) => x.id), ['R1', 'S1']);
  const s1 = s.criteria[1];
  assert.deepEqual([s1.source, s1.ref, s1.line, s1.change, s1.deltas], ['docs/specs/claims.md', 'AC-4', 8, 'modified', { removed: ['30 days'], added: ['45 days'] }]);
  assert.match(s1.previous, /30 days/); assert.match(s1.quote, /45 days/);
  assert.deepEqual(s.documents.map((d) => d.source), ['PR body', 'docs/specs/claims.md']);
  assert.match(s.documents[1].text, /45 days/);
  assert.deepEqual(s.spec, { files: 1, items: 5, limitations: [] });
  assert.deepEqual(Object.keys(c), ['requirement_to_code', 'code_to_requirement', 'occurrences', 'limitations']);
  assert.deepEqual(Object.keys(c.requirement_to_code[0]), ['criterion', 'code', 'tests']);
  assert.deepEqual(Object.keys(c.requirement_to_code[0].code[0]), ['path', 'line', 'end', 'score', 'hits']);
  assert.deepEqual(Object.keys(c.requirement_to_code[0].tests[0]).sort(), ['end', 'hits', 'line', 'path', 'score', 'via']);
  assert.deepEqual(Object.keys(c.occurrences[0]), ['criterion', 'value', 'variants', 'hits']);
  assert.deepEqual(Object.keys(c.occurrences[0].hits[0]), ['path', 'line', 'text', 'kind', 'touched_in_pr']);
  assert.equal(c.occurrences[0].hits.find((h) => h.path === 'src/claims/deadline.ts').text, 'export const FILING_WINDOW_DAYS = 30;');
  assert.match(out(r, 'requirements-index.md'), /^docs\/specs\/claims\.md:8 \[AC-4\] AC-4: A claim filed more than 45 days/m);
});

test('run marks touched occurrence lines, ranks test above src above config above snapshot above doc', (t) => {
  const r = repo(t, { 'docs/specs/c.md': 'AC-4: filed within 30 days.\n', 'src/a.js': 'const D = 30;\n', 'src/b.js': 'const E = 30;\n', 'src/a.test.js': 'expect(30);\n',
    'conf/app.yaml': 'days: 30\n', 'x/__snapshots__/a.snap': 'days 30\n', 'docs/note.md': 'We wait 30 days.\n', 'package-lock.json': '{"v":30}\n' },
  { 'docs/specs/c.md': 'AC-4: filed within 45 days.\n', 'src/b.js': 'const E = 30; // touched\n' });
  assert.equal(T.run({ cwd: r.dir, base: r.base, head: r.head, ctx: r.ctx }), 1);
  const hits = cands(r).occurrences[0].hits;
  assert.deepEqual(hits.map((h) => [h.kind, h.path, h.touched_in_pr]), [['test', 'src/a.test.js', false], ['src', 'src/a.js', false], ['src', 'src/b.js', true],
    ['config', 'conf/app.yaml', false], ['snapshot', 'x/__snapshots__/a.snap', false], ['doc', 'docs/note.md', false]]);
});

test('run records a removed item as a criterion and a (removed) document, and a deleted spec file', (t) => {
  const r = repo(t, { 'docs/specs/c.md': '# C\n\nR1: Keep this one.\nR2: Claims are filed within 30 days.\n', 'docs/specs/gone.md': 'R1: A removed file must be flagged.\n', 'src/a.js': 'const d = 30;\n' },
    { 'docs/specs/c.md': '# C\n\nR1: Keep this one.\n', 'docs/specs/gone.md': null });
  assert.equal(T.run({ cwd: r.dir, base: r.base, head: r.head, ctx: r.ctx }), 2);
  const s = status(r);
  assert.deepEqual(s.criteria.map((c) => [c.id, c.source, c.ref, c.change, c.line]), [['S1', 'docs/specs/c.md', 'R2', 'removed', 4], ['S2', 'docs/specs/gone.md', 'R1', 'removed', 1]]);
  assert.deepEqual(s.documents.map((d) => d.source), ['docs/specs/c.md', 'docs/specs/c.md (removed)', 'docs/specs/gone.md (removed)']);
  assert.equal(s.documents[1].text, 'R2: Claims are filed within 30 days.');
  assert.deepEqual(s.criteria[0].deltas, { removed: ['30 days'], added: [] });
  assert.equal(s.criteria[0].quote, s.documents[1].text);
  assert.ok(cands(r).occurrences[0].hits.some((h) => h.path === 'src/a.js'));
});

test('run counts added items and ignores whitespace-only and non-normative edits', (t) => {
  const r = repo(t, { 'docs/specs/c.md': '# C\n\nR1: Keep   this one.\n\nSome intro text.\n' }, { 'docs/specs/c.md': '# C\n\nR1: Keep this one.\nR2: New rule added.\n\nSome intro text, edited.\n' });
  assert.equal(T.run({ cwd: r.dir, base: r.base, head: r.head, ctx: r.ctx }), 1);
  const c = status(r).criteria[0];
  assert.deepEqual([c.ref, c.change, 'previous' in c], ['R2', 'added', false]);
});

test('run with trace off writes empty outputs and returns 0', (t) => {
  const r = fixture(t, 'tr3');
  assert.equal(T.run({ cwd: r.dir, base: r.base, head: r.head, ctx: r.ctx, trace: 'off' }), 0);
  assert.equal(out(r, 'spec-files.txt'), '');
  assert.deepEqual(cands(r), { requirement_to_code: [], code_to_requirement: [], occurrences: [], limitations: [] });
});

test('run applies requirements_paths: include forces prose docs, exclude removes noisy docs, unreadable office files are limitations', (t) => {
  const r = repo(t, { 'docs/specs/a.md': 'R1: A must hold.\n', 'docs/specs/noisy.md': 'R2: Noise must be ignored.\n', 'notes/idea.md': 'Plain prose only.\n',
    'docs/Requirements-v2.docx': 'binary', 'docs/budget.xlsx': 'binary', 'src/a.js': 'x\n' }, { 'src/a.js': 'y\n' });
  T.run({ cwd: r.dir, base: r.base, head: r.head, ctx: r.ctx, reqPaths: 'notes/**\n!docs/specs/noisy.md' });
  assert.deepEqual(out(r, 'spec-files.txt').split('\n').filter(Boolean), ['docs/specs/a.md', 'notes/idea.md']);
  assert.deepEqual(status(r).spec.limitations, ['requirement-like file not readable: docs/Requirements-v2.docx']);
});

test('run keeps only candidate and changed items in the index when it exceeds 60 KB, and records a limitation', (t) => {
  const many = Array.from({ length: 700 }, (_, i) => `R${i + 1}: ${'The widget number '.repeat(8)}${i} must stay valid.`).join('\n') + '\n';
  const r = repo(t, { 'docs/specs/big.md': many, 'src/widget.js': 'export function widget() {\n  return 1;\n}\n', 'src/pad.js': '\n'.repeat(5) },
    { 'src/widget.js': 'export function widget() {\n  return 2;\n}\n' });
  T.run({ cwd: r.dir, base: r.base, head: r.head, ctx: r.ctx });
  const index = out(r, 'requirements-index.md');
  assert.ok(Buffer.byteLength(index) <= 60 * 1024);
  assert.ok(index.split('\n').filter(Boolean).length < 700);
  assert.match(cands(r).limitations.join('\n'), /requirements-index\.md exceeded 60 KB/);
});

// ---- CLI ----
test('CLI classify and full run use the env contract and print the count', (t) => {
  const r = fixture(t, 'tr3');
  const env = { ...process.env, BASE_SHA: r.base, HEAD_SHA: r.head, CTX: r.ctx, REQ_PATHS: '' };
  const run = (...a) => execFileSync(process.execPath, [path.join(__dirname, 'trace.js'), ...a], { cwd: r.dir, env, encoding: 'utf8' });
  assert.equal(run('classify', 'docs/specs/claims.md', 'src/premium.ts').trim(), 'docs/specs/claims.md');
  assert.equal(run('classify', 'docs/specs/claims.md', 'src/premium.ts').trim().split('\n').length, 1);
  assert.equal(run().trim(), '1');
  assert.equal(run('classify', 'docs/specs/claims.md').trim(), 'docs/specs/claims.md');
  assert.equal(execFileSync(process.execPath, [path.join(__dirname, 'trace.js'), 'classify', 'docs/specs/claims.md'], { cwd: r.dir, env: { ...env, TRACE: 'off' }, encoding: 'utf8' }), '');
  assert.ok(fs.existsSync(path.join(r.ctx, 'trace-candidates.json')));
});

// ---- CRLF / lone CR: behaviour must be identical to LF ----
const post = require('./post');
const CRLF = (files) => Object.fromEntries(Object.entries(files).map(([k, v]) => [k, v === null ? null : v.replace(/\n/g, '\r\n')]));
const CLAIMS = (days) => `# Claims\n\n## Acceptance criteria\n\nAC-1: A claim must include the policy number.\nAC-4: A claim filed more than ${days} days after the incident is rejected as late.\n`;
const TS = (extra = '') => `export const FILING_WINDOW_DAYS = 30;\n${extra}export const OTHER = 1;\n`;
const claimsRepo = (t, conv) => repo(t, conv({ 'docs/specs/claims.md': CLAIMS(30), 'src/claims/deadline.ts': TS() }),
  conv({ 'docs/specs/claims.md': CLAIMS(45), 'src/claims/deadline.ts': TS('export const NEW = 2;\n') }));

test('CRLF checkout: the occurrence table keeps hits whose source line ends in CR (the original bug)', (t) => {
  const lf = claimsRepo(t, (x) => x), cr = claimsRepo(t, CRLF);
  T.run({ cwd: lf.dir, base: lf.base, head: lf.head, ctx: lf.ctx }); T.run({ cwd: cr.dir, base: cr.base, head: cr.head, ctx: cr.ctx });
  const hit = cands(cr).occurrences[0].hits.find((h) => h.path === 'src/claims/deadline.ts');
  assert.deepEqual([hit.line, hit.text, hit.kind], [1, 'export const FILING_WINDOW_DAYS = 30;', 'src']);
  assert.deepEqual(cands(cr), cands(lf));
  assert.deepEqual(status(cr), status(lf));
  assert.equal(out(cr, 'requirements-index.md'), out(lf, 'requirements-index.md'));
});

test('CRLF, mixed endings and a lone CR give the same criteria, quotes and candidates as LF', (t) => {
  const spec = 'docs/specs/claims.md', lfFiles = { [spec]: CLAIMS(30), 'src/claims/deadline.ts': TS() };
  const head = { [spec]: CLAIMS(45), 'src/claims/deadline.ts': TS('export const NEW = 2;\n') };
  const lf = repo(t, lfFiles, head), ref = (r) => ({ s: status(r), c: cands(r), i: out(r, 'requirements-index.md') });
  T.run({ cwd: lf.dir, base: lf.base, head: lf.head, ctx: lf.ctx });
  const want = ref(lf);
  const mixed = (f) => Object.fromEntries(Object.entries(f).map(([k, v]) => [k, v.split('\n').map((l, i, all) => (i < all.length - 1 && l.length % 2 === 0 ? l + '\r' : l)).join('\n')]));
  for (const conv of [CRLF, mixed]) {
    const r = repo(t, conv(lfFiles), conv(head));
    T.run({ cwd: r.dir, base: r.base, head: r.head, ctx: r.ctx });
    assert.deepEqual(ref(r), want);
    for (const c of status(r).criteria) assert.doesNotMatch(JSON.stringify(c), /\\r/);
  }
  // a lone CR inside a sentence: the criterion reads as one sentence; line numbers stay git's (LF only)
  const lone = { [spec]: CLAIMS(30).replace('late.', 'late.\rIt is final.'), 'src/a.ts': 'x\n' };
  const r = repo(t, lone, { ...lone, [spec]: lone[spec].replace('30 days', '45 days') });
  T.run({ cwd: r.dir, base: r.base, head: r.head, ctx: r.ctx });
  const c = status(r).criteria[0];
  assert.deepEqual([c.ref, c.line, c.deltas.added], ['AC-4', 6, ['45 days']]);
  assert.doesNotMatch(c.quote + c.previous, /\r/);
  assert.match(c.quote, /rejected as late\. It is final\./);
});

for (const id of ['tr1', 'tr3', 'tr5', 'tr6', 'tr9', 'tr12', 'tr14', 'tr16', 'tr17']) {
  test(`fixture ${id} in CRLF produces the same candidates and criteria as LF`, (t) => {
    const dir = path.join(FIX, `trace-${id}`);
    const lf = repo(t, readTree(path.join(dir, 'base')), readTree(path.join(dir, 'head')));
    const cr = repo(t, CRLF(readTree(path.join(dir, 'base'))), CRLF(readTree(path.join(dir, 'head'))));
    const n1 = T.run({ cwd: lf.dir, base: lf.base, head: lf.head, ctx: lf.ctx }), n2 = T.run({ cwd: cr.dir, base: cr.base, head: cr.head, ctx: cr.ctx });
    assert.equal(n2, n1);
    assert.deepEqual(cands(cr), cands(lf));
    assert.deepEqual(status(cr), status(lf));
    assert.equal(out(cr, 'spec-files.txt'), out(lf, 'spec-files.txt'));
  });
}

test('parseItems, classify and codeHunks are CRLF-neutral; a CR in a hunk context line still yields the hunk', (t) => {
  const text = '# T\n\n## Acceptance criteria\n\n- Reject zero.\n- Accept positive values.\n\nR1: Orders must ship.\nSecond line.\n\nThe system shall log. It must not crash.\n';
  assert.deepEqual(T.parseItems('d.md', text.replace(/\n/g, '\r\n')), T.parseItems('d.md', text));
  const r = claimsRepo(t, CRLF);
  assert.deepEqual(T.classify({ cwd: r.dir, base: r.base, head: r.head, paths: ['docs/specs/claims.md', 'src/claims/deadline.ts'] }), ['docs/specs/claims.md']);
  const patch = ['diff --git a/a.ts b/a.ts', '--- a/a.ts', '+++ b/a.ts', '@@ -1,2 +1,3 @@ export function filingWindow() {', ' export const A = 1;', '+export const FILING = 45;', ' export const B = 2;', ''].join('\r\n');
  const [h] = T.codeHunks(patch);
  assert.deepEqual([h.path, h.line, h.context], ['a.ts', 2, 'export function filingWindow() {']);
  assert.ok(h.literals.added.includes('45'));
});

test('end to end on a CRLF repo: trace output verifies against CRLF files with LF model quotes, and the spec_mismatch is accepted inline', (t) => {
  const r = claimsRepo(t, CRLF);
  T.run({ cwd: r.dir, base: r.base, head: r.head, ctx: r.ctx });
  const s = status(r), s1 = s.criteria[0];
  const patch = execFileSync('git', ['diff', '--no-color', '--no-renames', `${r.base}...${r.head}`], { cwd: r.dir, encoding: 'utf8' });
  assert.match(patch, /\r\n/);
  const maps = post.parseDiff(patch), old = process.env.GITHUB_WORKSPACE;
  process.env.GITHUB_WORKSPACE = r.dir; t.after(() => { if (old === undefined) delete process.env.GITHUB_WORKSPACE; else process.env.GITHUB_WORKSPACE = old; });
  const quote = 'export const FILING_WINDOW_DAYS = 30;', spec = 'AC-4: A claim filed more than 45 days after the incident is rejected as late.';
  const cit = (p, line, q) => ({ path: p, line, quote: q });
  const mk = () => ({
    requirements: [{ id: 'Q1', source: 'docs/specs/claims.md', quote: spec, ref: 'AC-4', obligation_ids: ['O1'], reason: 'r' }],
    coverage: [{ id: 'O1', obligation: 'o', source: 'docs/specs/claims.md AC-4', behaviour: cit('src/claims/deadline.ts', 1, quote), change: cit('docs/specs/claims.md', s1.line, spec),
      evidence: [], status: 'needs_human', reason: 'r', alignment: { status: 'mismatch', since: 'introduced', reason: 'code still 30' } }],
    findings: [{ kind: 'spec_mismatch', path: 'src/claims/deadline.ts', line: 1, quote, title: 't', body: 'b', confidence: 'high', obligation_ids: ['O1'] }],
    standards: { status: 'not_reviewed', sources: [], reason: 'x' }, layering: { status: 'not_reviewed', reason: 'x' }, validation_notes: [], not_reviewed: '',
  });
  const d = mk();
  assert.doesNotMatch(s1.quote, /\r/);
  assert.equal(post.validate(d).ok, true);
  post.verifyEvidence(d, new Set(['docs/specs/claims.md', 'src/claims/deadline.ts']), new Set(), post.readFile, maps);
  post.verifyRequirements(d, { ...s, specFiles: out(r, 'spec-files.txt').split('\n').filter(Boolean) }, post.readFile);
  assert.deepEqual([d.coverage[0].alignment.status, d.findings.length, d.requirements[0].obligation_ids], ['mismatch', 1, ['O1']]);
  assert.equal(d.requirements[0].line, 6); // re-derived from the CRLF spec file
  assert.equal(post.snap(d.findings[0], post.readFile('src/claims/deadline.ts')), 0);
  assert.deepEqual(post.plan(d.findings, maps).inline.map((f) => f.line), [1]);
  // the same quote verifies against collected CRLF document text, whether the model quote is LF or CRLF
  const crDoc = { documents: [{ source: 'docs/specs/claims.md', text: CLAIMS(45).replace(/\n/g, '\r\n') }], specFiles: ['docs/specs/claims.md'] };
  for (const q of [spec, spec.replace(/ /g, '\r\n')]) {
    const e = mk(); e.requirements[0].quote = q; post.verifyRequirements(e, crDoc, () => null);
    assert.deepEqual(e.requirements[0].obligation_ids, ['O1']);
  }
});
