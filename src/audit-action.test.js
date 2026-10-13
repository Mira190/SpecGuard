const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { extract } = require('./extract-json');

const yml = fs.readFileSync(path.join(__dirname, '..', 'action.yml'), 'utf8').replace(/\r\n/g, '\n');
const steps = yml.slice(yml.indexOf('\n  steps:\n') + 9).split(/\n    - /).filter(Boolean).map((s) => s.replace(/^ {6}/, '').replace(/\n {6}/g, '\n'));
const cond = (s) => (/^(?:- )?if: (.*)$/m.exec(s) || [])[1] || '';
const find = (re) => { const m = steps.filter((s) => re.test(s)); assert.equal(m.length, 1, `exactly one step matches ${re}`); return m[0]; };
const input = (name) => new RegExp(`^  ${name}: \\{[^}]*\\}`, 'm').exec(yml)[0];

test('action.yml: mode, audit_max_requirements and audit_issue inputs with the documented defaults', () => {
  assert.match(input('mode'), /default: pr \}$/);
  assert.match(input('audit_max_requirements'), /default: "80"/);
  assert.match(input('audit_issue'), /default: "false"/);
});

test('action.yml: the mode is validated first, and the refuse-env guard stays unconditional', () => {
  assert.ok(steps[0].includes('COPILOT_ALLOW_ALL') && !cond(steps[0]));
  assert.match(steps[1], /name: Check mode[\s\S]*MODE: \$\{\{ inputs\.mode \}\}[\s\S]*pr\|audit\) ;; \*\) echo "::error::mode must be pr or audit"; exit 1/);
  assert.equal(cond(steps[1]), '');
});

test('action.yml contract: every PR step is guarded by mode pr, audit steps by mode audit, shared steps by both', () => {
  const pr = /inputs\.mode == 'pr'/, au = /inputs\.mode == 'audit'/;
  const kinds = { pr: [], audit: [], both: [], none: [] };
  for (const s of steps) {
    const c = cond(s);
    kinds[pr.test(c) && au.test(c) ? 'both' : pr.test(c) ? 'pr' : au.test(c) ? 'audit' : 'none'].push(s);
  }
  assert.equal(kinds.none.length, 2, 'only the refuse-env and mode-check steps are unguarded');
  const touches = (list, re) => list.filter((s) => re.test(s)).length;
  // PR-only: preflight, collect, the PR post step and its artifact
  assert.equal(kinds.pr.length, 4);
  for (const re of [/src\/preflight\.js/, /src\/collect\.sh/, /src\/post\.js'/, /name: specguard-ctx-\$\{\{ github\.event\.pull_request\.number \}\}/]) assert.equal(touches(kinds.pr, re), 1, String(re));
  // audit-only: audit_collect, the audit post step and its artifact
  assert.equal(kinds.audit.length, 3);
  for (const re of [/src\/audit-collect\.js/, /src\/audit-post\.js'/, /name: specguard-audit-\$\{\{ github\.run_attempt \}\}/]) assert.equal(touches(kinds.audit, re), 1, String(re));
  // shared: setup-node, engine selection, the Copilot run
  assert.equal(kinds.both.length, 3);
  for (const re of [/actions\/setup-node/, /^id: engine/m, /Review with Copilot CLI/]) assert.equal(touches(kinds.both, re), 1, String(re));
  for (const s of kinds.pr) assert.doesNotMatch(cond(s), /audit/);
  for (const s of kinds.audit) assert.doesNotMatch(cond(s), /preflight|steps\.collect/);
  for (const s of kinds.both) {
    assert.match(cond(s), /inputs\.mode == 'pr' && steps\.preflight\.outputs\.skip != 'true' && steps\.collect\.outputs\.skip != 'true'/, 'the PR condition is the old one');
    assert.match(cond(s), /inputs\.mode == 'audit' && steps\.audit_collect\.outputs\.skip != 'true'/);
  }
});

test('action.yml: the PR post step stays the first github-script step (the M1 env scan reads it); the audit one maps every env it reads', () => {
  const uses = [...yml.matchAll(/uses: actions\/github-script/g)].map((m) => m.index);
  assert.equal(uses.length, 2);
  assert.ok(yml.indexOf("/src/post.js'") < uses[1] && yml.indexOf("/src/post.js'") > uses[0]);
  const s = find(/audit-post\.js/);
  const mapped = new Set([...s.slice(s.indexOf('env:'), s.indexOf('with:')).matchAll(/^\s+([A-Z_]+): /gm)].map((m) => m[1]));
  const src = fs.readFileSync(path.join(__dirname, 'audit-post.js'), 'utf8');
  const read = new Set([...src.matchAll(/\benv\.([A-Z][A-Z_]+)/g)].map((m) => m[1]));
  const runner = new Set(['GITHUB_WORKSPACE', 'GITHUB_SERVER_URL', 'GITHUB_SHA']);
  assert.ok(read.has('AUDIT_ISSUE') && read.has('SKIP') && read.has('ENGINE'));
  assert.deepEqual([...read].filter((k) => !mapped.has(k) && !runner.has(k)), []);
  assert.match(s, /AUDIT_ISSUE: \$\{\{ inputs\.audit_issue \}\}/);
  assert.match(s, /SKIP: \$\{\{ steps\.audit_collect\.outputs\.skip \}\}/);
});

test('action.yml: audit collect gets the globs and the cap; the Copilot step switches skill, schema and prompt mode on MODE; Copilot validates with CHECK=audit', () => {
  const c = find(/id: audit_collect/);
  for (const m of [/REQ_PATHS: \$\{\{ inputs\.requirements_paths \}\}/, /IGNORE_EXTRA: \$\{\{ inputs\.ignore \}\}/, /MAX_REQUIREMENTS: \$\{\{ inputs\.audit_max_requirements \}\}/, /CTX: \$\{\{ github\.workspace \}\}\/\.specguard-ctx/]) assert.match(c, m);
  const copilot = find(/Review with Copilot CLI/);
  assert.match(copilot, /MODE: \$\{\{ inputs\.mode \}\}/);
  assert.match(copilot, /skills\/spec-audit/);
  assert.match(copilot, /src\/audit\.schema\.json/);
  assert.match(copilot, /skills\/test-review/);
  assert.match(copilot, /src\/findings\.schema\.json/);
  assert.match(copilot, /--mode "\$MODE"/);
  assert.match(copilot, /CHECK: \$\{\{ inputs\.mode == 'audit' && 'audit' \|\| '' \}\}/);
});

// ---- extract-json --check with CHECK=audit ----
const AUDIT = { docs_reviewed: ['d.md'], requirements_found: 1, not_reviewed: [], requirements: [{ id: 'R1', source: { path: 'd.md', line: 1, quote: 'q' }, text: 't', class: 'unit', status: 'unknown', code: [], tests: [], note: '' }] };

function check(t, text, env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'specguard-extract-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'in.txt'), text);
  const r = spawnSync(process.execPath, [path.join(__dirname, 'extract-json.js'), path.join(dir, 'in.txt'), path.join(dir, 'out.json'), '--check'], { encoding: 'utf8', env: { ...process.env, CHECK: '', ...env } });
  return { status: r.status, out: r.stdout.trim(), saved: fs.existsSync(path.join(dir, 'out.json')) ? fs.readFileSync(path.join(dir, 'out.json'), 'utf8') : null };
}

test('extract-json --check with CHECK=audit uses the audit validator; without it the PR validator rejects an audit result', (t) => {
  const text = `Here you go:\n\`\`\`json\n${JSON.stringify(AUDIT)}\n\`\`\`\n`;
  const ok = check(t, text, { CHECK: 'audit' });
  assert.equal(ok.status, 0);
  assert.equal(ok.out, '');
  assert.deepEqual(JSON.parse(ok.saved), AUDIT);
  const pr = check(t, text);
  assert.equal(pr.status, 1);
  assert.match(pr.out, /::warning::output failed validation: coverage must be an array/);
  const bad = check(t, JSON.stringify({ ...AUDIT, requirements: [{ ...AUDIT.requirements[0], status: 'great' }] }), { CHECK: 'audit' });
  assert.equal(bad.status, 1);
  assert.match(bad.out, /::warning::output failed validation: requirements\[0\]: status must be one of/);
  assert.equal(check(t, 'no json here', { CHECK: 'audit' }).status, 1);
});

test('extract: an audit object is preferred over a later unrelated object', () => {
  const s = `${JSON.stringify(AUDIT)}\ntrailing {"n":1}`;
  assert.deepEqual(JSON.parse(extract(s)), AUDIT);
});
