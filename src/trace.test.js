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

test('parseItems: a bare Example: is a scenario only in a .feature file, never in prose or YAML front matter', () => {
  assert.deepEqual(T.parseItems('docs/opt.md', '---\nExample:\n- --foo $URL\n---\n# --foo\nDo foo.\n\nExample: run it twice.\n'), []);
  assert.deepEqual(T.parseItems('f.feature', 'Feature: F\n  Example: Plain\n    Given x\n').map((i) => [i.ref, i.kind]), [['Scenario: Plain', 'gherkin']]);
});

test('parseItems: Gherkin in Markdown needs Given/When/Then steps or a fenced gherkin block', () => {
  assert.deepEqual(T.parseItems('r.md', '# T\n\nScenario: a title only\n\nSome text.\n'), []);
  const prose = T.parseItems('r.md', 'Scenario: Late\n  Given a claim\n  When it is late\n  Then it is refused\n\n# Next\n');
  assert.deepEqual(prose.map((i) => [i.ref, i.line, i.end]), [['Scenario: Late', 1, 4]]);
  const fenced = T.parseItems('r.md', '# T\n\n```gherkin\nScenario: Fenced\n  Given a\n  Then b\n```\n\nAfter.\n');
  assert.deepEqual(fenced.map((i) => [i.ref, i.line, i.end]), [['Scenario: Fenced', 4, 6]]);
  assert.deepEqual(T.parseItems('r.md', '```bash\nScenario: x\n  Given a\n```\n'), []);
});

test('parseItems: a Scenario: inside a docstring does not start an item', () => {
  const text = 'Feature: F\n  Scenario: Outer\n    Given a file\n    """\n    Scenario: Nested\n      Given b\n    """\n    Then ok\n';
  assert.deepEqual(T.parseItems('d.feature', text).map((i) => [i.ref, i.line, i.end]), [['Scenario: Outer', 2, 8]]);
});

test('parseItems: a title ID (# KEP-1: Title) over a long document is not one item; its sections still are', () => {
  const body = Array.from({ length: 80 }, (_, i) => `Line ${i}.`).join('\n');
  const doc = `# KEP-7: Swap support\n\n${body}\n\n## Requirements\n\nThe node must reserve swap. It shall be off by default.\n`;
  const items = T.parseItems('keps/7/README.md', doc);
  assert.ok(!items.some((i) => i.kind === 'id'));
  assert.deepEqual(items.map((i) => i.kind), ['normative', 'normative']);
  assert.equal(T.parseItems('s.md', '# REQ-7: Short title\n\nOne rule.\n')[0].ref, 'REQ-7'); // a small document may be one requirement
});

test('parseItems: an ID heading spanning many lines stops at its first sub-heading and is capped', () => {
  const doc = ['## REQ-1: Big', 'Intro.', '### Detail', ...Array.from({ length: 100 }, (_, i) => `Detail ${i}.`)].join('\n');
  const [it] = T.parseItems('s.md', doc);
  assert.deepEqual([it.ref, it.line, it.end], ['REQ-1', 1, 2]);
  const flat = ['## REQ-2: Long', ...Array.from({ length: 100 }, () => 'Text.')].join('\n');
  assert.equal(T.parseItems('s.md', flat)[0].end, 60);
});

test('parseItems: link reference definitions are not ID items, a bracketed ID with prose still is', () => {
  const doc = '[KEP-4671]: https://kep.k8s.io/4671\n[RFC-2119]: ./rfc.md "title"\n[KEP-5732]: Topology-aware workload scheduling.\n- [KEP-4671]: Gang Scheduling.\n[KEP-1287: In-Place Scaling][kep-1287]. It goes on.\n- [KEP-5972: Dynamic Containers](https://x.io/5972) permits it.\n[REQ-1]: The system must refuse zero.\n';
  assert.deepEqual(T.parseItems('s.md', doc).map((i) => i.ref), ['REQ-1']);
});

test('parseItems: HTML comments (template instructions) are skipped', () => {
  const doc = '<!--\n**ACTION REQUIRED:** a PR must be merged.\n-->\n\n<!-- one liner: it must go -->\nThe node must reserve swap. It shall be off. <!-- tail -->\n';
  assert.deepEqual(T.parseItems('k.md', doc).map((i) => i.text), ['The node must reserve swap.', 'It shall be off.']);
});

test('parseItems: a stray triple-backtick line does not invert fencing for the rest of the file', () => {
  const doc = ['# KEP', '``` <<[UNRESOLVED stuff ]>> notes ```', '', 'The node must reserve swap.', '', '```', 'code must stay out.', '```', '', 'It shall be off.'].join('\n');
  assert.deepEqual(T.parseItems('k.md', doc).map((i) => i.text), ['The node must reserve swap.', 'It shall be off.']);
  // an opener that never closes: re-parse without fences instead of dropping the rest of the file
  assert.deepEqual(T.parseItems('k.md', '```\nThe node must reserve swap.\nIt shall be off.\n').map((i) => i.text), ['The node must reserve swap.', 'It shall be off.']);
  // a closer needs the same character, no info string, at least the opening length
  assert.deepEqual(T.parseItems('k.md', '````\n```js\nIt must stay out.\n````\nIt shall count.\n').map((i) => i.text), ['It shall count.']);
});

test('parseItems: must/shall inside identifiers or code spans is not normative; table rows pair by their first cell', () => {
  assert.deepEqual(T.parseItems('a.md', 'Label `must-have` is set. Branch triage-must-have is used. The `must` word.\n'), []);
  const row = (k, v) => `| ${k} | The value MUST be ${v}. |`;
  const head = ['| Field | Rule |', '|---|---|', row('alpha', 'a'), row('beta', 'b')].join('\n');
  const refs = (t) => T.parseItems('a.md', t).map((i) => i.ref);
  assert.deepEqual(refs(head), ['doc#alpha', 'doc#beta']);
  assert.deepEqual(refs([head.split('\n')[0], '|---|---|', row('zero', 'z'), row('alpha', 'a'), row('beta', 'b')].join('\n')), ['doc#zero', 'doc#alpha', 'doc#beta']);
});

test('isSpecDoc admits structured items, RFC capitals, dense prose and spec directories, not sparse lowercase prose', () => {
  const n = (raw) => ({ kind: 'normative', raw });
  assert.equal(T.isSpecDoc([n('a must b.')], 'a.md', 10), false);
  assert.equal(T.isSpecDoc([n('a must b.'), n('c shall d.')], 'a.md', 300), true);
  assert.equal(T.isSpecDoc([n('a must b.'), n('c shall d.')], 'a.md', 90000), false);
  assert.equal(T.isSpecDoc([n('a must b.'), n('c SHALL d.')], 'a.md', 9000), true);
  assert.equal(T.isSpecDoc([n('a must b.'), n('c SHALL d.')], 'a.md', 90000), false);
  assert.equal(T.isSpecDoc([n('a must b.'), n('c shall d.')], 'design/a.md', 90000), true);
  assert.equal(T.isSpecDoc([n('a must b.'), n('c shall d.')], 'docs/specs/a.md', 90000), true);
  assert.equal(T.isSpecDoc([{ kind: 'id', raw: 'R1: x' }], 'a.md', 90000), true);
  assert.equal(T.isSpecDoc([n('a must b.')], 'openspec/specs/x/spec.md', 300), true); // a single requirement in a spec directory
  assert.equal(T.isSpecDoc([n('a must b.')], 'docs/x.md', 300), false);
  // a file named like a spec is as strong as a spec directory, in any directory (long English design doc, sparse "must")
  const two = [n('a must b.'), n('c should d.')];
  for (const f of ['docs/design.md', 'design.md', 'api-spec.md', 'docs/design_doc.md', 'product-requirements.md', 'docs/PRD.md', 'acceptance-criteria.md']) assert.equal(T.isSpecDoc(two, f, 27600), true, f);
  for (const f of ['design-doc.md', 'docs/design-v2.md']) assert.equal(T.isSpecDoc(two, f, 27600), true, f);
  for (const f of ['docs/guide.md', 'README.md', 'docs/architecture.md', 'CONTRIBUTING.md', 'CHANGELOG.md', 'designer-notes.md', 'design-tokens.md', 'docs/design-system.md']) assert.equal(T.isSpecDoc(two, f, 27600), false, f);
  assert.equal(T.isSpecDoc([n('a must b.')], 'docs/design.md', 27600), false); // the requirement-doc gate still applies
});

test('classify: .txt files are documents only when named like requirements', (t) => {
  const spec = 'AC-1: The thing must work.\nAC-2: It shall be fast.\n';
  const r = repo(t, { 'a.js': 'x\n' }, { 'CMakeLists.txt': spec, 'docs/requirements.txt': spec, 'LICENSES/MIT.txt': spec, 'a.js': 'y\n' });
  const paths = ['CMakeLists.txt', 'docs/requirements.txt', 'LICENSES/MIT.txt'];
  assert.deepEqual(T.classify({ cwd: r.dir, base: r.base, head: r.head, paths }), ['docs/requirements.txt']);
});

test('classify: LLM prompt and template directories are not requirement docs; code-name and file-name lines are not IDs', (t) => {
  const spec = 'AC-1: The thing must work.\nAC-2: It shall be fast.\n';
  const r = repo(t, { 'a.js': 'x\n' }, { 'templates/commands/run.md': spec, 'docs/foo-template.md': spec, 'docs/real.md': spec, 'a.js': 'y\n' });
  assert.deepEqual(T.classify({ cwd: r.dir, base: r.base, head: r.head, paths: ['templates/commands/run.md', 'docs/foo-template.md', 'docs/real.md'] }), ['docs/real.md']);
  assert.deepEqual(T.parseItems('m.md', 'CURLOPT_AWS_SIGV4 - V4 signature\n`ENABLE_IPV6`: Enable IPv6.\n- [CHANGELOG-1.38.md](./CHANGELOG-1.38.md)\nVS2013.\nFR_1: A real one.\n').map((i) => i.ref), ['FR_1']);
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

test('isTestPath per stack: .NET, Swift, Java, Go, Python, Scala, JS; case-insensitive words, no false positives', () => {
  for (const p of ['Foo.Tests/Bar.cs', 'Foo.Tests/FooTests.cs', 'src/Tests/Bar.cs', 'AppTests.swift', 'src/main/java/FooTest.java', 'pkg/foo_test.go', 'test_foo.py', 'src/FooSpec.scala', 'src/foo.spec.ts']) assert.equal(T.isTestPath(p), true, p);
  for (const p of ['src/contest/x.ts', 'latest.ts', 'attestation.go', 'src/Latest.cs', 'docs/Spec.md', 'SPEC.md']) assert.equal(T.isTestPath(p), false, p);
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
  assert.deepEqual(s.spec, { files: 1, items: 5, added: [], limitations: [] });
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

test('run counts added items, ignores whitespace-only edits and reads an edited descriptive paragraph as a changed item (F1)', (t) => {
  const r = repo(t, { 'docs/specs/c.md': '# C\n\nR1: Keep   this one.\n\nSome intro text.\n' }, { 'docs/specs/c.md': '# C\n\nR1: Keep this one.\nR2: New rule added.\n\nSome intro text, edited.\n' });
  assert.equal(T.run({ cwd: r.dir, base: r.base, head: r.head, ctx: r.ctx }), 2);
  const [c, e] = status(r).criteria;
  assert.deepEqual([c.ref, c.change, 'previous' in c], ['R2', 'added', false]);
  assert.deepEqual([e.quote, e.previous, e.change], ['Some intro text, edited.', 'Some intro text.', 'modified']);
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

// ---- hardening: control-character paths, ReDoS, caps, change flags ----
// A repo whose tree is built with `git update-index -z`, so it can hold paths (newlines) a Windows checkout cannot.
function rawRepo(t, files) {
  const dir = tmp(t);
  const g = (input, ...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...a], { cwd: dir, input, encoding: 'utf8' }).trim();
  g(undefined, 'init', '-q');
  const tree = (m) => { // nested `git mktree -z` (git update-index refuses newline paths)
    const level = (entries) => {
      const kids = new Map(), leaves = [];
      for (const [p, text] of entries) {
        const i = p.indexOf('/');
        if (i < 0) leaves.push(`100644 blob ${g(text, 'hash-object', '-w', '--stdin')}\t${p}\0`);
        else kids.set(p.slice(0, i), [...(kids.get(p.slice(0, i)) || []), [p.slice(i + 1), text]]);
      }
      for (const [name, sub] of kids) leaves.push(`040000 tree ${level(sub)}\t${name}\0`);
      return g(leaves.join(''), 'mktree', '-z');
    };
    return level(Object.entries(m));
  };
  const commit = (m, parent) => g(undefined, 'commit-tree', tree(m), ...(parent ? ['-p', parent] : []), '-m', 'c');
  return { dir, commit };
}
const SPEC_TEXT = '# Claims\n\nAC-1: file within 30 days\nAC-2: pay within 5 days\n';

test('F2/F9: a tracked path containing a newline is ignored by discover and classify, and never reaches spec-files.txt', (t) => {
  const r = rawRepo(t, {});
  const base = r.commit({ 'docs/spec.md': SPEC_TEXT });
  const head = r.commit({ 'docs/spec.md': SPEC_TEXT.replace('30 days', '45 days'), 'zz\n.md': SPEC_TEXT, 'evil\n.git/config\n.md': SPEC_TEXT }, base);
  const ctx = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-ctx-')); t.after(() => fs.rmSync(ctx, { recursive: true, force: true }));
  T.run({ cwd: r.dir, base, head, ctx });
  assert.equal(out({ ctx }, 'spec-files.txt'), 'docs/spec.md\n');
  assert.match(JSON.parse(out({ ctx }, 'requirements-status.json')).spec.limitations.join(' '), /control character/);
  assert.deepEqual(T.classify({ cwd: r.dir, base, head, paths: ['zz\n.md', 'docs/spec.md'] }), ['docs/spec.md']);
  assert.deepEqual(T.classify({ cwd: r.dir, base, head, paths: ['docs/spec.md', 'zz\n.md'] }), ['docs/spec.md']);
});

test('F3a: ID_LINE is linear on the red team ReDoS inputs', () => {
  const cases = ['A' + '1'.repeat(262144) + 'x', 'A1'.repeat(131072) + 'x', 'A' + '.1'.repeat(131072) + 'x', 'A' + '-1'.repeat(131072) + 'x', 'It must. '.repeat(29000)];
  const t0 = Date.now();
  for (const c of cases) T.parseItems('d.md', c);
  assert.ok(Date.now() - t0 < 3000, `took ${Date.now() - t0} ms`);
  // behaviour preserved
  assert.deepEqual(T.parseItems('d.md', 'REQ-12.3: must do x\nAB-: no\nNOTE: no\n').map((i) => i.ref), ['REQ-12.3']);
});

test('F3c: criteria are capped with a limitation, and the diff input is capped', (t) => {
  const many = (n) => Array.from({ length: n }, (_, i) => `AC-${i + 1}: file within ${i + 1} days`).join('\n') + '\n';
  const r = repo(t, { 'docs/spec.md': many(30).replace(/within \d+/g, 'within 1') }, { 'docs/spec.md': many(30) });
  T.run({ cwd: r.dir, base: r.base, head: r.head, ctx: r.ctx, maxCriteria: 5 });
  const s = status(r);
  assert.equal(s.criteria.length, 5);
  assert.match(s.spec.limitations.join(' '), /criteria.*5/);
  const r2 = repo(t, { 'docs/spec.md': SPEC_TEXT }, { 'docs/spec.md': SPEC_TEXT.replace('30 days', '45 days') });
  assert.equal(T.run({ cwd: r2.dir, base: r2.base, head: r2.head, ctx: r2.ctx, maxPatch: 10 }), 0);
  assert.match(status(r2).spec.limitations.join(' '), /diff.*exceeded/);
});

test('F4: spec.added lists requirement documents that did not exist at BASE', (t) => {
  const r = repo(t, { 'src.js': 'x\n' }, { 'docs/new.md': SPEC_TEXT });
  T.run({ cwd: r.dir, base: r.base, head: r.head, ctx: r.ctx });
  assert.deepEqual(status(r).spec.added, ['docs/new.md']);
});

// ---- discovery cost and precision fixes (field study) ----
const lim = (r) => status(r).spec.limitations.join('\n');

test('a doc move is not a change; a move plus an edit is only the edit', (t) => {
  const r = repo(t, { 'docs/specs/a.md': SPEC_TEXT, 'src/a.js': 'x\n' }, { 'docs/specs/a.md': null, 'docs/specs/old/a.md': SPEC_TEXT, 'src/a.js': 'x\n' });
  assert.equal(T.run({ cwd: r.dir, base: r.base, head: r.head, ctx: r.ctx }), 0);
  const r2 = repo(t, { 'docs/specs/a.md': SPEC_TEXT }, { 'docs/specs/a.md': null, 'docs/specs/old/a.md': SPEC_TEXT.replace('30 days', '45 days') });
  assert.equal(T.run({ cwd: r2.dir, base: r2.base, head: r2.head, ctx: r2.ctx }), 1);
  const [c] = status(r2).criteria;
  assert.deepEqual([c.ref, c.change, c.source], ['AC-1', 'modified', 'docs/specs/old/a.md']);
  assert.deepEqual(c.deltas, { removed: ['30 days'], added: ['45 days'] });
});

const BIG_SPEC = Array.from({ length: 3000 }, (_, i) => `R${i + 1}: The system MUST keep value ${i + 1} under 30 days. ${'padding '.repeat(8)}`).join('\n') + '\n';

test('a spec over 256 KB is reported when skipped and parsed around its changed lines when the PR edits it', (t) => {
  assert.ok(BIG_SPEC.length > 256 * 1024);
  const r = repo(t, { 'docs/big.md': BIG_SPEC, 'src/a.js': 'x\n' }, { 'src/a.js': 'y\n' });
  assert.equal(T.run({ cwd: r.dir, base: r.base, head: r.head, ctx: r.ctx }), 0);
  assert.match(lim(r), /oversize doc skipped: docs\/big\.md \(\d+ KB\)/);
  const r2 = repo(t, { 'docs/big.md': BIG_SPEC }, { 'docs/big.md': BIG_SPEC.replace('R1500: The system MUST keep value 1500 under 30 days', 'R1500: The system MUST keep value 1500 under 45 days') });
  assert.equal(T.run({ cwd: r2.dir, base: r2.base, head: r2.head, ctx: r2.ctx }), 1);
  const [c] = status(r2).criteria;
  assert.deepEqual([c.ref, c.change, c.deltas.added], ['R1500', 'modified', ['45 days']]);
  assert.doesNotMatch(lim(r2), /oversize/);
  assert.deepEqual(T.classify({ cwd: r2.dir, base: r2.base, head: r2.head, paths: ['docs/big.md'] }), ['docs/big.md']);
});

test('only the largest MAX_DEEP changes are traced in depth; the rest are deferred in limitations', (t) => {
  const many = (days) => Array.from({ length: 30 }, (_, i) => `AC-${i + 1}: file within ${days + i} days`).join('\n') + '\n';
  const r = repo(t, { 'docs/spec.md': many(1), 'src/filing.js': 'export const filing = 1;\n' }, { 'docs/spec.md': many(100) });
  assert.equal(T.run({ cwd: r.dir, base: r.base, head: r.head, ctx: r.ctx }), 30);
  assert.equal(status(r).criteria.length, 30);
  assert.equal(cands(r).requirement_to_code.length, 25);
  assert.match(lim(r), /deferred: 5 changed requirement item\(s\)/);
});

test('an expired time budget keeps the criteria and writes a limitation instead of failing', (t) => {
  const r = repo(t, { 'docs/spec.md': SPEC_TEXT, 'src/a.js': 'x\n' }, { 'docs/spec.md': SPEC_TEXT.replace('30 days', '45 days') });
  assert.equal(T.run({ cwd: r.dir, base: r.base, head: r.head, ctx: r.ctx, budgetMs: -1 }), 1);
  assert.equal(status(r).criteria.length, 1);
  assert.deepEqual(cands(r).requirement_to_code, []);
  assert.match(lim(r), /time budget was reached/);
  const env = { ...process.env, BASE_SHA: r.base, HEAD_SHA: r.head, CTX: r.ctx, TRACE_BUDGET_MS: '60000' };
  assert.equal(execFileSync('node', [path.join(__dirname, 'trace.js')], { cwd: r.dir, env, encoding: 'utf8' }).trim(), '1');
  assert.doesNotMatch(lim(r), /time budget/);
});

test('trace-candidates.json is capped by hunk count and size, with a limitation; fixture and testdata hunks are not traced', (t) => {
  const doc = Array.from({ length: 80 }, (_, i) => `R${i + 1}: The widget number ${i + 1} must stay valid.`).join('\n') + '\n';
  const code = (v) => Object.fromEntries(Array.from({ length: 70 }, (_, i) => [`src/widget${i}.js`, `export function widget${i}() {\n  return ${v};\n}\n`]));
  const r = repo(t, { 'docs/specs/w.md': doc, ...code(1), 'testdata/widget.js': 'a\n' }, { ...code(2), 'testdata/widget.js': 'b\n' });
  T.run({ cwd: r.dir, base: r.base, head: r.head, ctx: r.ctx });
  const c = cands(r);
  assert.equal(c.code_to_requirement.length, 60);
  assert.ok(!c.code_to_requirement.some((h) => h.path.startsWith('testdata/')));
  assert.ok(c.code_to_requirement.every((h) => h.candidates.length <= 5));
  assert.match(c.limitations.join('\n'), /70?\d* weaker code hunk|10 weaker code hunk/);
  assert.ok(fs.statSync(path.join(r.ctx, 'trace-candidates.json')).size <= 60 * 1024);
});

test('the candidate cap trims occurrence hits when the file is too big, and says so', (t) => {
  const spec = (d) => Array.from({ length: 20 }, (_, i) => `AC-${i + 1}: file within ${d + i} days`).join('\n') + '\n';
  const hits = Array.from({ length: 20 }, (_, i) => Array.from({ length: 60 }, (_, k) => `const l${i}_${k} = ${100 + i}; // within ${100 + i} days ${'x'.repeat(100)}`).join('\n')).join('\n') + '\n';
  const r = repo(t, { 'docs/spec.md': spec(100), 'src/a.js': hits }, { 'docs/spec.md': spec(300) });
  T.run({ cwd: r.dir, base: r.base, head: r.head, ctx: r.ctx });
  assert.ok(cands(r).occurrences.length > 0 && cands(r).occurrences.every((o) => o.hits.length <= 10));
  assert.match(lim(r), /trimmed to 60 KB/);
  assert.ok(fs.statSync(path.join(r.ctx, 'trace-candidates.json')).size <= 60 * 1024);
});

// ---- M11: the diff base is the merge-base, not the advanced target tip ----
test('M11: the CLI pairs changed spec items against DIFF_BASE_SHA, so a target branch that moved on does not rewrite the previous text', (t) => {
  const r = fixture(t, 'tr3');
  const git = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'core.autocrlf=false', '-c', 'commit.gpgsign=false', ...a], { cwd: r.dir, encoding: 'utf8' }).trim();
  git('checkout', '-q', '-b', 'target', r.base); // the target branch advances after the PR branched: AC-4 now says 60 days there
  const spec = path.join(r.dir, 'docs/specs/claims.md');
  fs.writeFileSync(spec, fs.readFileSync(spec, 'utf8').replace('30 days', '60 days'));
  git('commit', '-qam', 'target moves on');
  const tip = git('rev-parse', 'HEAD');
  assert.notEqual(tip, r.base);
  const cli = (extra) => { fs.rmSync(path.join(r.ctx, 'requirements-status.json'), { force: true }); execFileSync(process.execPath, [path.join(__dirname, 'trace.js')], { cwd: r.dir, env: { ...process.env, BASE_SHA: tip, HEAD_SHA: r.head, CTX: r.ctx, REQ_PATHS: '', ...extra } }); return status(r).criteria[0]; };
  const good = cli({ DIFF_BASE_SHA: r.base });
  assert.deepEqual([good.ref, good.deltas], ['AC-4', { removed: ['30 days'], added: ['45 days'] }]);
  assert.match(good.previous, /30 days/);
  const stale = cli({}); // no DIFF_BASE_SHA: falls back to BASE_SHA, the old behaviour this fix replaces
  assert.match(stale.previous, /60 days/);
});

// ---- F1-F3: changed blocks, docs named by the PR, rejected candidates ----
const DESIGN = (extra = []) => ['# Design', '', 'The app records the screen and writes a file.', '', 'The recorder must keep running while the window is hidden.', '', 'Files are saved under the movies folder.', '',
  'The tray icon must show the state.', '', 'The settings dialog has three tabs.', '', 'Exports must never block the UI.', '', ...extra].join('\n');
const SECTION = ['## 4.5 Scheduled recording', '', 'A repeating plan stays on after it fires.', '', 'If a recording is already running, that occurrence is skipped.', '', '- the plan can be paused', '- a paused plan never fires', '',
  '| Field | Meaning |', '|---|---|', '| repeat | daily or weekly |', ''];
const lineOf = (text, s) => text.split('\n').findIndex((l) => l.includes(s)) + 1;

test('F1: every block the PR adds or edits in an admitted descriptive doc is an S criterion, unchanged blocks are not', (t) => {
  const r = repo(t, { 'docs/design.md': DESIGN() + '\n', 'src/a.js': 'x\n' }, { 'docs/design.md': DESIGN(SECTION).replace('has three tabs', 'has four tabs') + '\n', 'src/a.js': 'y\n' });
  T.run({ cwd: r.dir, base: r.base, head: r.head, ctx: r.ctx });
  const head = DESIGN(SECTION).replace('has three tabs', 'has four tabs');
  const crit = status(r).criteria;
  assert.deepEqual(crit.map((c) => [c.line, c.change, c.quote]), [
    [lineOf(head, 'four tabs'), 'modified', 'The settings dialog has four tabs.'],
    [lineOf(head, 'repeating plan'), 'added', 'A repeating plan stays on after it fires.'],
    [lineOf(head, 'already running'), 'added', 'If a recording is already running, that occurrence is skipped.'],
    [lineOf(head, 'can be paused'), 'added', 'the plan can be paused'],
    [lineOf(head, 'never fires'), 'added', 'a paused plan never fires'],
    [lineOf(head, '| repeat'), 'added', '| repeat | daily or weekly |'],
  ]);
  assert.equal(crit.find((c) => /four tabs/.test(c.quote)).previous, 'The settings dialog has three tabs.');
  assert.deepEqual(crit.map((c) => c.id), ['S1', 'S2', 'S3', 'S4', 'S5', 'S6']);
  assert.ok(!crit.some((c) => /records the screen|Files are saved|must keep running/.test(c.quote)));
});

test('F1: a removed block pairs as a removal and an edited normative sentence stays one criterion', (t) => {
  const r = repo(t, { 'docs/design.md': DESIGN() + '\n' }, { 'docs/design.md': DESIGN().replace('Files are saved under the movies folder.\n\n', '').replace('must show the state', 'must show the recording state') + '\n' });
  T.run({ cwd: r.dir, base: r.base, head: r.head, ctx: r.ctx });
  assert.deepEqual(status(r).criteria.map((c) => [c.change, c.quote]), [['modified', 'The tray icon must show the recording state.'], ['removed', 'Files are saved under the movies folder.']]);
});

test('F1: a descriptive doc that no rule admits yields no criteria; the criteria cap still applies', (t) => {
  const prose = ['# Notes', '', 'Plain prose.', ''].join('\n');
  const r = repo(t, { 'notes/n.md': prose, 'src/a.js': 'x\n' }, { 'notes/n.md': prose + 'More prose added.\n', 'src/a.js': 'y\n' });
  T.run({ cwd: r.dir, base: r.base, head: r.head, ctx: r.ctx });
  assert.deepEqual(status(r).criteria || [], []);
  const many = Array.from({ length: 30 }, (_, i) => `Added paragraph ${i}.`).join('\n\n');
  const r2 = repo(t, { 'docs/design.md': DESIGN() + '\n' }, { 'docs/design.md': DESIGN() + '\n\n' + many + '\n' });
  T.run({ cwd: r2.dir, base: r2.base, head: r2.head, ctx: r2.ctx, maxCriteria: 10 });
  assert.equal(status(r2).criteria.length, 10);
  assert.match(status(r2).spec.limitations.join('\n'), /20 changed requirement item\(s\) beyond the 10-criteria limit/);
});

const named = (r, ...texts) => fs.writeFileSync(path.join(r.ctx, 'requirements-status.json'), JSON.stringify({ status: 'available', sources: ['PR body'], limitations: [], criteria: [],
  documents: texts.map((text, i) => ({ source: i ? `issue #${i}` : 'PR body', text })) }));

test('F2: a doc the PR body names is admitted although the heuristics reject it; a path that does not exist admits nothing', (t) => {
  const base = { 'docs/notes/overview.md': '# Overview\n\nThe app records.\n\nIt saves files.\n', 'docs/notes/other.md': '# Other\n\nText.\n', 'src/a.js': 'x\n' };
  const head = { ...base, 'docs/notes/overview.md': '# Overview\n\nThe app records.\n\nIt saves files.\n\nA new paragraph about scheduling.\n', 'docs/notes/other.md': '# Other\n\nText, edited.\n' };
  const r = repo(t, base, head);
  named(r, 'Implements the plan in docs/notes/overview.md section 2, see also docs/notes/gone.md and docs/missing/other.md');
  T.run({ cwd: r.dir, base: r.base, head: r.head, ctx: r.ctx });
  assert.deepEqual(out(r, 'spec-files.txt').split('\n').filter(Boolean), ['docs/notes/overview.md']);
  assert.deepEqual(status(r).criteria.map((c) => [c.source, c.change, c.quote]), [['docs/notes/overview.md', 'added', 'A new paragraph about scheduling.']]);
  const r2 = repo(t, base, head);
  named(r2, 'Implements docs/notes/gone.md and docs/missing/other.md');
  T.run({ cwd: r2.dir, base: r2.base, head: r2.head, ctx: r2.ctx });
  assert.equal(out(r2, 'spec-files.txt'), '');
  assert.deepEqual(status(r2).criteria || [], []);
  const r3 = repo(t, base, head); // without any PR text the heuristics reject it, as before
  T.run({ cwd: r3.dir, base: r3.base, head: r3.head, ctx: r3.ctx });
  assert.equal(out(r3, 'spec-files.txt'), '');
});

test('F2: a linked issue names a doc by unique basename; classify admits it so its diff is kept; requirements_paths exclude wins', (t) => {
  const base = { 'docs/notes/overview.md': '# Overview\n\nThe app records.\n', 'src/a.js': 'x\n' };
  const r = repo(t, base, { ...base, 'docs/notes/overview.md': '# Overview\n\nThe app records.\n\nNew.\n' });
  named(r, 'Fixes #1', 'Update `overview.md` (section 4.5)');
  assert.deepEqual(T.classify({ cwd: r.dir, base: r.base, head: r.head, paths: ['docs/notes/overview.md'], ctx: r.ctx }), ['docs/notes/overview.md']);
  assert.deepEqual(T.classify({ cwd: r.dir, base: r.base, head: r.head, paths: ['docs/notes/overview.md'], ctx: r.ctx, reqPaths: '!docs/notes/**' }), []);
  assert.deepEqual(T.classify({ cwd: r.dir, base: r.base, head: r.head, paths: ['docs/notes/overview.md'], ctx: path.join(r.ctx, 'none') }), []);
  const rule = repo(t, { 'CLAUDE.md': 'a\n', 'docs/testing-standards.md': 'a\n' }, { 'CLAUDE.md': 'b\n', 'docs/testing-standards.md': 'b\n' }); // a rule file named in the PR is still a rule file
  named(rule, 'Update CLAUDE.md and docs/testing-standards.md');
  assert.deepEqual(T.classify({ cwd: rule.dir, base: rule.base, head: rule.head, paths: ['CLAUDE.md', 'docs/testing-standards.md'], ctx: rule.ctx }), []);
  const hist = repo(t, base, { ...base, 'docs/notes/overview.md': '# Overview\n\nThe app records.\n\nNew.\n' });
  fs.writeFileSync(path.join(hist.ctx, 'requirements-status.json'), JSON.stringify({ documents: [{ source: 'history PR #3', untrusted: true, text: 'docs/notes/overview.md' }] }));
  assert.deepEqual(T.classify({ cwd: hist.dir, base: hist.base, head: hist.head, paths: ['docs/notes/overview.md'], ctx: hist.ctx }), []); // history text never admits a doc
});

test('F2: namedDocs matches exact paths, markdown links, blob URLs and unique basenames only; README, changelog, rule and pip files are not specs', () => {
  const paths = ['docs/design.md', 'docs/a/guide.md', 'docs/b/guide.md', 'README.md', 'CHANGELOG.md', 'requirements.txt', 'docs/spec.rst', 'src/design.md.js', 'docs/prompts/p.md'];
  const t = (text) => [...T.namedDocs([text], paths)].sort();
  assert.deepEqual(t('design.md §4.5'), ['docs/design.md']);
  assert.deepEqual(t('see [the design](docs/design.md#scheduling) and `docs/spec.rst`'), ['docs/design.md', 'docs/spec.rst']);
  assert.deepEqual(t('https://github.com/o/r/blob/main/docs/design.md#L10'), ['docs/design.md']);
  assert.deepEqual(t('./docs/design.md, /docs/spec.rst'), ['docs/design.md', 'docs/spec.rst']);
  assert.deepEqual(t('guide.md is ambiguous; docs/a/guide.md is not'), ['docs/a/guide.md']);
  assert.deepEqual(t('docs/other/design.md and elsewhere/design.md and mydesign.md and design.mdx'), []); // a path that is not tracked, whatever its basename
  assert.deepEqual(t('Updated README.md, CHANGELOG.md, requirements.txt and docs/prompts/p.md'), []);
});

test('F3: spec-rejected.txt lists the strongest rejected candidates (most items first, at most 20) with the reason; admitted docs are absent', (t) => {
  const sentences = (n) => Array.from({ length: n }, (_, i) => `Item ${i} must hold.`).join(' ');
  const filler = (kbs) => ('lorem ipsum dolor sit amet '.repeat(40) + '\n\n').repeat(kbs); // about 1.1 KB each
  const files = { 'notes/one.md': `# One\n\n${sentences(1)}\n\n${filler(2)}`, 'notes/many.md': `# Many\n\n${sentences(5)}\n\n${filler(9)}`, 'docs/specs/ok.md': 'R1: A must hold.\nR2: B must hold.\n' };
  for (let i = 0; i < 25; i++) files[`notes/n${String(i).padStart(2, '0')}.md`] = `# N\n\n${sentences(2)}\n\n${filler(3)}`;
  const r = repo(t, { 'src/a.js': 'x\n' }, { ...files, 'src/a.js': 'y\n' });
  T.run({ cwd: r.dir, base: r.base, head: r.head, ctx: r.ctx });
  const lines = out(r, 'spec-rejected.txt').split('\n').filter(Boolean);
  assert.equal(lines.length, 20);
  assert.match(lines[0], /^notes\/many\.md\tdensity 1 per \d+ KB below 1 per 300 B$/);
  assert.match(lines[1], /^notes\/n00\.md\tdensity 1 per \d+ KB below 1 per 300 B$/);
  assert.ok(lines.every((l) => /^[^\t]+\t[^\t]+$/.test(l)) && !lines.some((l) => /one\.md|ok\.md/.test(l)));
  const r2 = repo(t, { 'src/a.js': 'x\n' }, { 'notes/one.md': `# One\n\n${sentences(1)}\n`, 'src/a.js': 'y\n' });
  T.run({ cwd: r2.dir, base: r2.base, head: r2.head, ctx: r2.ctx });
  assert.equal(out(r2, 'spec-rejected.txt'), 'notes/one.md\tonly 1 normative item\n');
  const r3 = repo(t, { 'src/a.js': 'x\n' }, { 'notes/one.md': `# One\n\n${sentences(1)}\n`, 'src/a.js': 'y\n' });
  T.run({ cwd: r3.dir, base: r3.base, head: r3.head, ctx: r3.ctx, trace: 'off' });
  assert.equal(out(r3, 'spec-rejected.txt'), '');
});

test('requirement_to_code keeps the top 3 code and top 3 test windows per criterion, in ranking order', (t) => {
  const doc = 'AC-1: the gizmo quota resets after 30 days\n';
  const src = (v) => Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`src/gizmo${i}.js`, `// gizmo quota resets after ${v} days\nexport const gizmoQuota${i} = ${v};\n`]));
  const tst = (v) => Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`test/gizmo${i}.test.js`, `// gizmo quota resets after ${v} days\ntest('gizmo quota ${i}', () => {});\n`]));
  const r = repo(t, { 'docs/spec.md': doc, ...src(30), ...tst(30) }, { 'docs/spec.md': doc.replace('30', '45') });
  T.run({ cwd: r.dir, base: r.base, head: r.head, ctx: r.ctx });
  const rows = cands(r).requirement_to_code;
  assert.ok(rows.length >= 1);
  for (const row of rows) {
    assert.deepEqual([row.code.length, row.tests.length], [3, 3]);
    assert.deepEqual(row.code.map((c) => c.score), row.code.map((c) => c.score).sort((a, b) => b - a));
  }
});

// ---- descriptive blocks as governing candidates ----
const BLOCK_DOC = ['# List design', '', 'The first row of the recording list carries a New badge and is selected by default.', '',
  '| Window | Regular window, 1000x740 |', '|---|---|', '| Ball | A round 52 px floating button on the desktop |', '',
  'The toolbar icons must be at least 32 px wide.', '', '## Changelog', '', 'The first row of the recording list was selected by default in an older release.', ''].join('\n');
const PAGE_BASE = 'export function ListPage({ rows }) {\n  const [sel, setSel] = useState(undefined)\n  return sel\n}\n';
const PAGE_HEAD = 'export function ListPage({ rows }) {\n  const [sel, setSel] = useState(defaultSelection(rows))\n  return sel\n}\n';
test('a descriptive block that matches a changed hunk becomes a block candidate; unrelated and changelog blocks do not', (t) => {
  const r = repo(t, { 'specs/design.md': BLOCK_DOC, 'src/ListPage.tsx': PAGE_BASE, 'src/other.ts': 'export const a = 1\n' }, { 'specs/design.md': BLOCK_DOC, 'src/ListPage.tsx': PAGE_HEAD, 'src/other.ts': 'export const a = 2\n' });
  T.run({ cwd: r.dir, base: r.base, head: r.head, ctx: r.ctx });
  const hunk = cands(r).code_to_requirement.find((h) => h.path === 'src/ListPage.tsx');
  assert.deepEqual(hunk.candidates.filter((c) => c.kind === 'block').map((c) => [c.path, c.line]), [['specs/design.md', 3]]);
  const index = out(r, 'requirements-index.md');
  assert.ok(index.includes('specs/design.md:3 '));
  assert.ok(!index.includes('specs/design.md:7 ') && !index.includes('specs/design.md:13 ')); // the unrelated table row and the changelog entry are not listed
  assert.ok(!cands(r).code_to_requirement.some((h) => h.path === 'src/other.ts' && h.candidates.some((c) => c.kind === 'block')));
});
test('block candidates are capped per hunk and overall', (t) => {
  const W = Array.from({ length: 40 }, (_, i) => String.fromCharCode(97 + (i % 26), 97 + Math.floor(i / 26)) + 'qx'); // unique letter-only words
  const doc = '# D\n\nA row MUST exist.\n\n' + W.map((_, i) => `The ${[0, 1, 2, 3].map((j) => W[(i + j) % 40]).join(" ")} panel shows a recording list with rows selected by default.\n`).join('\n');
  const code = (v, k) => `export function f${'abcdefghijklmnopqrstuvwxyzABCD'[k]}() {\n  return ${v} + [${[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((j) => W[(k + j) % 40]).map((w) => `'${w}'`).join(', ')}].length\n}\n`;
  const files = (v) => ({ 'specs/d.md': doc, ...Object.fromEntries(Array.from({ length: 30 }, (_, k) => [`src/f${k}.ts`, code(v, k)])) });
  const r = repo(t, files(1), files(2));
  T.run({ cwd: r.dir, base: r.base, head: r.head, ctx: r.ctx });
  const hs = cands(r).code_to_requirement, per = hs.map((h) => h.candidates.filter((c) => c.kind === 'block').length);
  assert.equal(Math.max(...per), 3);
  assert.ok(new Set(hs.flatMap((h) => h.candidates.filter((c) => c.kind === 'block').map((c) => c.line))).size <= 20);
});

// ---- spec-driven layouts: branch -> spec folder, tasks.md, Gherkin variants ----
test('branch name selects its spec folder: force-admitted even when the heuristics would reject it; others stay out', (t) => {
  const plan = (x) => `# Plan\n\nAlbums group photos by date.\n${x}`;
  const base = { 'specs/003-photo-albums/plan.md': plan(''), 'specs/004-other/plan.md': plan(''), 'src/a.js': 'x\n' };
  const head = { ...base, 'specs/003-photo-albums/plan.md': plan('\nAn album shows its newest photo first.\n'), 'specs/004-other/plan.md': plan('\nSomething else entirely.\n') };
  const run = (t, branch) => { const r = repo(t, base, head); fs.writeFileSync(path.join(r.ctx, 'requirements-status.json'), JSON.stringify({ branch })); T.run({ cwd: r.dir, base: r.base, head: r.head, ctx: r.ctx }); return r; };
  assert.equal(out(run(t, 'main'), 'spec-files.txt'), '', 'no branch match, nothing admitted');
  for (const branch of ['feat/003-photo-albums', '003-photo-albums', 'user/Fix/003-Photo-Albums', 'feat/photo-albums']) {
    const r = run(t, branch);
    assert.deepEqual(out(r, 'spec-files.txt').split('\n').filter(Boolean), ['specs/003-photo-albums/plan.md'], branch);
    assert.deepEqual(status(r).criteria.map((c) => [c.source, c.change, c.quote]), [['specs/003-photo-albums/plan.md', 'added', 'An album shows its newest photo first.']], branch);
  }
  const r = run(t, 'feat/photo');
  assert.equal(out(r, 'spec-files.txt'), '', 'a partial name is not a match');
  const c = repo(t, base, head); // classify (collect.sh) agrees with discover
  fs.writeFileSync(path.join(c.ctx, 'requirements-status.json'), JSON.stringify({ branch: 'feat/003-photo-albums' }));
  assert.deepEqual(T.classify({ cwd: c.dir, base: c.base, head: c.head, paths: ['specs/003-photo-albums/plan.md', 'specs/004-other/plan.md'], ctx: c.ctx }), ['specs/003-photo-albums/plan.md']);
  // the .kiro and openspec layouts, and a single-word folder
  const k = { '.kiro/specs/albums/requirements.md': '# R\n\nAlbums exist.\n', 'openspec/changes/add-albums/proposal.md': '# P\n\nWhy albums.\n', 'src/a.js': 'x\n' };
  const kr = repo(t, k, { ...k, '.kiro/specs/albums/requirements.md': '# R\n\nAlbums exist.\n\nThey sort by date.\n', 'openspec/changes/add-albums/proposal.md': '# P\n\nWhy albums.\n\nUsers asked.\n' });
  fs.writeFileSync(path.join(kr.ctx, 'requirements-status.json'), JSON.stringify({ branch: 'feat/albums' }));
  assert.deepEqual(T.classify({ cwd: kr.dir, base: kr.base, head: kr.head, paths: ['.kiro/specs/albums/requirements.md', 'openspec/changes/add-albums/proposal.md'], ctx: kr.ctx }), ['.kiro/specs/albums/requirements.md']);
  fs.writeFileSync(path.join(kr.ctx, 'requirements-status.json'), JSON.stringify({ branch: 'add-albums' }));
  assert.deepEqual(T.classify({ cwd: kr.dir, base: kr.base, head: kr.head, paths: ['.kiro/specs/albums/requirements.md', 'openspec/changes/add-albums/proposal.md'], ctx: kr.ctx }), ['openspec/changes/add-albums/proposal.md']);
});

test('tasks.md of Spec Kit, Kiro and OpenSpec: each checkbox is an item and ticking one is a changed requirement', (t) => {
  const tasks = (a, b) => `# Tasks\n\n## Phase 1\n\n- [${a}] T006 [P] Create the album model in src/album.js\n- [ ] T007 Add the album list endpoint\n\n- [${b}] 1.2 Write migration\n`;
  for (const file of ['specs/003-photo-albums/tasks.md', '.kiro/specs/albums/tasks.md', 'openspec/changes/add-albums/tasks.md']) {
    const items = T.parseItems(file, tasks(' ', ' '));
    assert.deepEqual(items.map((i) => [i.kind, i.ref, i.raw]), [['task', 'task#T006', '[ ] T006 [P] Create the album model in src/album.js'], ['task', 'task#T007', '[ ] T007 Add the album list endpoint'], ['task', 'task#1.2', '[ ] 1.2 Write migration']], file);
    assert.equal(T.isSpecDoc(items, file, 200), true, file);
    const r = repo(t, { [file]: tasks(' ', ' '), 'src/album.js': 'a\n' }, { [file]: tasks('x', ' '), 'src/album.js': 'a\n' });
    T.run({ cwd: r.dir, base: r.base, head: r.head, ctx: r.ctx });
    assert.deepEqual(status(r).criteria.map((c) => [c.source, c.change, c.quote, c.previous]), [[file, 'modified', '[x] T006 [P] Create the album model in src/album.js', '[ ] T006 [P] Create the album model in src/album.js']], file);
  }
  assert.deepEqual(T.parseItems('docs/tasks.md', tasks(' ', ' ')), [], 'not in a spec folder: an ordinary checklist');
  assert.equal(T.parseItems('specs/a/tasks.md', '```\n- [ ] T1 in a fence\n```\n').length, 0);
});

test('Gherkin steps: case-insensitive, numbered, bold; OpenSpec scenario headings are one item each', () => {
  const kinds = (text, file = 'specs/a/spec.md') => T.parseItems(file, text).map((i) => [i.kind, i.ref, i.text]);
  const open = '### Requirement: Albums\nThe system SHALL list albums.\n\n#### Scenario: Empty list\n- **WHEN** the user has no albums\n- **THEN** an empty state is shown\n\n#### Scenario: Sorted\n- **WHEN** albums exist\n- **THEN** newest first\n';
  assert.deepEqual(kinds(open).filter((k) => k[0] === 'gherkin').map((k) => k[1]), ['Scenario: Empty list', 'Scenario: Sorted']);
  assert.match(T.parseItems('specs/a/spec.md', open).find((i) => i.ref === 'Scenario: Sorted').raw, /THEN\*\* newest first/);
  for (const step of ['1. **Given** an album, **When** opened, **Then** shown', '- **WHEN** a', '2) Given a', 'then x', 'WHEN y']) {
    assert.deepEqual(kinds(`Scenario: S\n${step}\n`).map((k) => k[0]), ['gherkin'], step);
  }
  assert.deepEqual(kinds('**Scenario:** Bold\n- **GIVEN** a\n').map((k) => k[1]), ['Scenario: Bold']);
  assert.deepEqual(kinds('Scenario: S\nSomething else\n').map((k) => k[0]), [], 'a Scenario: line with no step in the document is prose');
});

// ---- scan support: a scope for discovery, and the requirement-to-code scorer reused for a whole-repo scan ----
const DOC_A = '# A\n\nThe alpha service MUST retry failed uploads three times.\n\nThe alpha service MUST log every rejected upload.\n';
test('run with a scope: documents outside it do not exist for discovery (and so do not count against the candidate caps)', (t) => {
  const r = repo(t, { 'packages/a/docs/design.md': DOC_A, 'packages/b/docs/design.md': DOC_A.replace(/alpha/g, 'beta') }, {});
  T.run({ cwd: r.dir, base: r.head, head: r.head, ctx: r.ctx });
  assert.deepEqual(out(r, 'spec-files.txt').split('\n').filter(Boolean).sort(), ['packages/a/docs/design.md', 'packages/b/docs/design.md']);
  T.run({ cwd: r.dir, base: r.head, head: r.head, ctx: r.ctx, scope: (p) => p.startsWith('packages/a/') });
  assert.deepEqual(out(r, 'spec-files.txt').split('\n').filter(Boolean), ['packages/a/docs/design.md']);
});

test('requirementToCode: stop words leave the query, and cover is the share of the block\'s weighted terms a window holds (only when asked for)', (t) => {
  const r = repo(t, {
    'src/upload.js': '// retry failed uploads three times\nfunction retryFailedUpload(upload) { return upload; }\n',
    'src/other.js': '// the quick brown fox\nfunction fox() {}\n',
  }, {});
  const entries = T.lsTree(r.dir, r.head);
  const crit = { id: 'c', quote: 'The upload service must retry failed uploads three times.', previous: '', lits: [] };
  const run = (extra) => T.requirementToCode({ cwd: r.dir, head: r.head, entries, skip: () => false, crits: [crit], dl: T.makeClock(5000), info: {}, ...extra })[0].code;
  const plain = run({});
  assert.equal(plain[0].path, 'src/upload.js');
  assert.ok(!('cover' in plain[0]), 'PR mode output is unchanged');
  const withCover = run({ cover: true, stop: T.BLOCK_STOP });
  assert.equal(withCover[0].path, 'src/upload.js');
  assert.ok(withCover[0].cover > 0.5 && withCover[0].cover <= 1, String(withCover[0].cover));
  assert.ok(!withCover[0].hits.includes('the'), 'a stop word is not a query term');
  assert.ok(withCover.every((w) => w.path !== 'src/other.js' || w.cover < withCover[0].cover));
});

// ---- blocksOf prefilter: data and status blocks are marked up front (with a reason), real behaviour is kept ----
const ruling = (md) => { const ruled = [], kept = T.blocksOf('docs/design.md', md, ruled); return { kept: kept.map((b) => b.text), ruled: ruled.map((b) => [b.text, b.reason]) }; };

test('blocksOf prefilter: table rows that are mostly numbers, percentages, dates, links or checkmarks are data; a behaviour table row is kept', () => {
  const r = ruling([
    '# Design', '', '## Behaviour', '',
    '| Case | Expected | Note |', '|---|---|---|',
    '| Pilot run on Kite | 88% | 2026-10-07 |',
    '| `abc1234` | 100% | [run](https://example.com/run/1) |',
    '| Retry the failed upload | ✓ | 12/14 |',
    '| Off | Off | No audio is recorded when both switches are off |',
    '| Yes | No | The save button is disabled while a recording runs |',
    '| Q7 | Does the team review agent PRs, and who decides? | N1 |', '',
  ].join('\n'));
  assert.deepEqual(r.ruled.map((x) => x[1]), ['results/data table row', 'results/data table row', 'results/data table row']);
  assert.equal(r.kept.length, 3, r.kept.join(' // '));
  assert.ok(r.kept.some((k) => /No audio is recorded/.test(k)) && r.kept.some((k) => /save button/.test(k)) && r.kept.some((k) => /Q7/.test(k)), 'yes/no and id cells are values, not data');
});

test('blocksOf prefilter: under a results/status heading a row goes only when it carries numbers, prose only under a bare status heading; a sub-heading keeps its blocks', () => {
  const r = ruling([
    '# Design', '', '## Status (2026-10-07)', '', 'The refactor below supersedes the v1 report contract and nothing else.', '', '### Evidence contract', '', 'The poster verifies every citation against the workspace files.', '',
    '## Evaluation findings and decisions', '', '| Case | Expectation | Rows |', '|---|---|---|', '| mutation | The validator rejects a changed value with no test | 3 |', '| runs of the pilot | 12 | 340 ms |', '',
    '## Notes on the evaluation', '', 'The harness retries a failed case twice before it grades.', '',
  ].join('\n'));
  assert.deepEqual(r.ruled.map((x) => [x[0].slice(0, 22), x[1]]), [['The refactor below sup', 'under a results/status/sources heading'], ['| runs of the pilot | ', 'results/data table row']]);
  assert.ok(r.kept.some((k) => /poster verifies/.test(k)), 'the sub-heading of Status keeps its blocks');
  assert.ok(r.kept.some((k) => /validator rejects/.test(k)), 'a row of expectations under an Evaluation heading stays');
  assert.ok(r.kept.some((k) => /harness retries/.test(k)), 'a heading that merely mentions evaluation is not a status heading');
});

test('blocksOf prefilter: link-only items and verbless English labels go; an RFC 2119 word, a threshold, another script or any verb keeps the block', () => {
  const r = ruling([
    '# Design', '', '## Results', '', '| Latency | 120 ms | 130 ms | The service must stay below 200 ms |', '',
    '## Links', '', '- [Design notes](notes/design.md)', '- [Spec](https://example.com/spec) and [API](https://example.com/api)', '- [Retry policy](retry.md): the client retries a failed call twice', '',
    '## Misc', '', 'Node 20 locally vs 22 in CI.', '', 'Pilot repo: Kite (private), engine on a personal repo.', '', 'The client retries a failed call twice.', '', 'A/B detection >= 70% on the pilot set.',
    '', '这是一个没有英文动词的中文说明段落，必须保留下来。', '', 'Retry policy and timeouts', '',
  ].join('\n'));
  assert.deepEqual(r.ruled.map((x) => x[1]), ['link list', 'link list', 'no verb, a label rather than behaviour', 'no verb, a label rather than behaviour']);
  for (const k of ['must stay below 200 ms', 'the client retries', 'The client retries', 'A/B detection', '这是一个', 'Retry policy and timeouts']) assert.ok(r.kept.some((x) => x.includes(k)), `kept: ${k}`);
});

test('blocksOf without the ruled argument returns the kept blocks only', () => {
  const md = '# Design\n\n| Pilot run on Kite | 88% | 2026-10-07 | 12/14 |\n\nThe tool must validate the input before it saves.\n';
  assert.deepEqual(T.blocksOf('d.md', md).map((b) => b.text), ['The tool must validate the input before it saves.']);
});
