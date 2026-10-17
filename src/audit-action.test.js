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

test('action.yml: mode, scan_max_blocks and scan_issue inputs; the audit_* names stay as deprecated aliases; unset means the documented defaults', () => {
  assert.match(input('mode'), /default: pr \}$/);
  assert.match(input('mode'), /scan \(unit test gap scan/);
  assert.match(input('scan_max_blocks'), /empty = 80/);
  assert.match(input('scan_issue'), /empty = false/);
  assert.match(input('scan_issue'), /SpecGuard: unit test gap scan/);
  for (const n of ['scan_max_blocks', 'scan_issue', 'audit_max_requirements', 'audit_issue']) assert.match(input(n), /default: "" \}$/, n);
  for (const [old, now] of [['audit_max_requirements', 'scan_max_blocks'], ['audit_issue', 'scan_issue']]) assert.match(input(old), new RegExp(`Deprecated alias of ${now}`));
});

test('action.yml: the mode is validated first, and the refuse-env guard stays unconditional', () => {
  assert.ok(steps[0].includes('COPILOT_ALLOW_ALL') && !cond(steps[0]));
  assert.match(steps[1], /name: Check mode\nid: mode[\s\S]*MODE: \$\{\{ inputs\.mode \}\}[\s\S]*scan\|audit\) m=scan ;; \*\) echo "::error::mode must be pr or scan/);
  assert.equal(cond(steps[1]), '');
});

test('action.yml: the Check mode step accepts pr, scan and the alias audit, and outputs the canonical name; scan never runs on a pull_request', (t) => {
  const script = steps[1].split('run: |\n')[1].replace(/^ {2}/gm, '');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'specguard-mode-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const run = (MODE, EVENT = 'workflow_dispatch') => {
    const out = path.join(dir, 'out.txt');
    fs.writeFileSync(out, '');
    const r = spawnSync('bash', ['-c', script], { encoding: 'utf8', env: { ...process.env, MODE, EVENT, GITHUB_OUTPUT: out } });
    return { status: r.status, out: fs.readFileSync(out, 'utf8').trim(), stdout: r.stdout };
  };
  assert.deepEqual(run('pr', 'pull_request'), { status: 0, out: 'mode=pr', stdout: '' });
  assert.deepEqual(run('scan', 'schedule'), { status: 0, out: 'mode=scan', stdout: '' });
  assert.deepEqual(run('audit', 'workflow_dispatch'), { status: 0, out: 'mode=scan', stdout: '' }, 'audit is an alias of scan');
  for (const m of ['scan', 'audit']) {
    const r = run(m, 'pull_request');
    assert.equal(r.status, 1, m);
    assert.match(r.stdout, /::error::mode scan runs on workflow_dispatch or schedule, not on pull_request/);
  }
  const bad = run('both');
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /::error::mode must be pr or scan \(audit is an alias of scan\)/);
});

test('action.yml contract: every PR step is guarded by mode pr, audit steps by mode audit, shared steps by both', () => {
  const pr = /inputs\.mode == 'pr'/, au = /steps\.mode\.outputs\.mode == 'scan'/; // scan is the canonical name; audit is normalised to it by the Check mode step
  const kinds = { pr: [], audit: [], both: [], none: [] };
  for (const s of steps) {
    const c = cond(s);
    kinds[pr.test(c) && au.test(c) ? 'both' : pr.test(c) ? 'pr' : au.test(c) ? 'audit' : 'none'].push(s);
  }
  assert.equal(kinds.none.length, 3, 'only the refuse-env, mode-check and fail_on_error steps are unguarded');
  const touches = (list, re) => list.filter((s) => re.test(s)).length;
  // PR-only: preflight, collect, the superseded check, the optional coverage evidence, the PR post step and its artifact
  assert.equal(kinds.pr.length, 6);
  for (const re of [/src\/preflight\.js/, /src\/collect\.sh/, /src\/superseded\.js/, /src\/coverage\.js/, /src\/post\.js'/, /name: specguard-ctx-\$\{\{ github\.event\.pull_request\.number \}\}/]) assert.equal(touches(kinds.pr, re), 1, String(re));
  // audit-only: audit_collect, the audit post step and its artifact
  assert.equal(kinds.audit.length, 3);
  for (const re of [/src\/audit-collect\.js/, /src\/audit-post\.js'/, /name: specguard-audit-\$\{\{ github\.run_attempt \}\}/]) assert.equal(touches(kinds.audit, re), 1, String(re));
  // shared: setup-node, credential detection, engine selection, the engine run
  assert.equal(kinds.both.length, 4);
  for (const re of [/actions\/setup-node/, /^id: credential/m, /^id: engine/m, /Run the review engine/]) assert.equal(touches(kinds.both, re), 1, String(re));
  for (const s of kinds.pr) assert.doesNotMatch(cond(s), /audit/);
  for (const s of kinds.audit) assert.doesNotMatch(cond(s), /preflight|steps\.collect/);
  for (const s of kinds.both) {
    assert.match(cond(s), /inputs\.mode == 'pr' && steps\.preflight\.outputs\.skip != 'true' && steps\.collect\.outputs\.skip != 'true'/, 'the PR condition is the old one');
    assert.match(cond(s), /steps\.mode\.outputs\.mode == 'scan' && steps\.audit_collect\.outputs\.skip != 'true'/);
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
  assert.ok(read.has('SCAN_ISSUE') && read.has('AUDIT_ISSUE') && read.has('SKIP') && read.has('ENGINE'));
  assert.deepEqual([...read].filter((k) => !mapped.has(k) && !runner.has(k)), []);
  assert.match(s, /SCAN_ISSUE: \$\{\{ inputs\.scan_issue \}\}/);
  assert.match(s, /AUDIT_ISSUE: \$\{\{ inputs\.audit_issue \}\}/);
  assert.match(s, /SKIP: \$\{\{ steps\.audit_collect\.outputs\.skip \}\}/);
});

test('action.yml: audit collect gets the globs and the cap; the Copilot step switches skill, schema and prompt mode on MODE; Copilot validates with CHECK=audit', () => {
  const c = find(/id: audit_collect/);
  for (const m of [/REQ_PATHS: \$\{\{ inputs\.requirements_paths \}\}/, /IGNORE_EXTRA: \$\{\{ inputs\.ignore \}\}/, /SCAN_MAX_BLOCKS: \$\{\{ inputs\.scan_max_blocks \}\}/, /MAX_REQUIREMENTS: \$\{\{ inputs\.audit_max_requirements \}\}/,/CTX: \$\{\{ github\.workspace \}\}\/\.specguard-ctx/]) assert.match(c, m);
  const copilot = find(/Run the review engine/);
  assert.match(copilot, /MODE: \$\{\{ steps\.mode\.outputs\.mode \}\}/);
  assert.match(copilot, /if \[ "\$MODE" = scan \]; then skill=/);
  assert.match(copilot, /skills\/spec-audit/);
  assert.match(copilot, /src\/audit\.schema\.json/);
  assert.match(copilot, /skills\/test-review/);
  assert.match(copilot, /src\/findings\.schema\.json/);
  assert.match(copilot, /--mode "\$MODE"/);
  assert.match(copilot, /CHECK: \$\{\{ steps\.mode\.outputs\.mode == 'scan' && 'audit' \|\| '' \}\}/);
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

test('action.yml: the superseded check sits between collect and the engine; engine and post skip when it says so', () => {
  const idx = (re) => steps.findIndex((x) => re.test(x));
  const sup = idx(/src\/superseded\.js/);
  assert.ok(idx(/src\/collect\.sh/) < sup && sup < idx(/^id: engine/m) && sup < idx(/Run the review engine/));
  assert.match(steps[sup], /^id: superseded/m);
  assert.match(cond(steps[sup]), /steps\.collect\.outputs\.skip != 'true'/);
  for (const re of [/^id: engine/m, /Run the review engine/, /src\/post\.js'/]) assert.match(cond(find(re)), /steps\.superseded\.outputs\.superseded != 'true'/, String(re));
  assert.match(yml, /^ {2}superseded: \{[^}]*steps\.superseded\.outputs\.superseded/m);
});

test('action.yml: scan_paths scopes the scan and reaches both scan steps; the collector may read the scan issue (token and repository) only through its own env', () => {
  assert.match(input('scan_paths'), /default: "" \}$/);
  assert.match(input('scan_paths'), /select which source files \(units\) are reviewed.*still read from the whole repository.*requirements_paths/);
  assert.match(input('scan_issue'), /rotate through all blocks/);
  assert.match(input('scan_max_blocks'), /rotate through all blocks/);
  const collect = find(/id: audit_collect/), post = find(/audit-post\.js/);
  for (const s of [collect, post]) assert.match(s, /SCAN_PATHS: \$\{\{ inputs\.scan_paths \}\}/);
  for (const m of [/SCAN_ISSUE: \$\{\{ inputs\.scan_issue \}\}/, /AUDIT_ISSUE: \$\{\{ inputs\.audit_issue \}\}/, /GH_TOKEN: \$\{\{ inputs\.github_token \}\}/, /GH_REPO: \$\{\{ inputs\.repository \|\| github\.repository \}\}/]) assert.match(collect, m);
  const src = fs.readFileSync(path.join(__dirname, 'audit-collect.js'), 'utf8');
  const read = new Set([...src.matchAll(/\benv\.([A-Z][A-Z_]+)/g)].map((m) => m[1]));
  const mapped = new Set([...collect.slice(collect.indexOf('env:'), collect.indexOf('run:')).matchAll(/^\s+([A-Z_]+): /gm)].map((m) => m[1]));
  const runner = new Set(['GITHUB_REF_NAME', 'GITHUB_EVENT_PATH', 'GITHUB_OUTPUT', 'GITHUB_API_URL', 'GITHUB_REPOSITORY']);
  assert.deepEqual([...read].filter((k) => !mapped.has(k) && !runner.has(k)), [], 'every variable the collector reads is mapped');
});

test('action.yml: coverage_files is off by default; its step runs between setup-node and the engine, only for a PR review that was not superseded, and never fails the job', () => {
  assert.match(input('coverage_files'), /default: "" \}$/);
  assert.match(input('coverage_files'), /SpecGuard never runs tests/);
  const idx = (re) => steps.findIndex((x) => re.test(x));
  const RUN = /node "\$GITHUB_ACTION_PATH\/src\/coverage\.js"/, c = find(RUN);
  assert.ok(idx(/actions\/setup-node/) < idx(RUN) && idx(RUN) < idx(/^id: engine/m));
  assert.match(cond(c), /inputs\.mode == 'pr' && inputs\.coverage_files != ''/);
  assert.match(cond(c), /steps\.collect\.outputs\.skip != 'true'.*steps\.superseded\.outputs\.superseded != 'true'/);
  assert.match(c, /continue-on-error: true/);
  for (const m of [/COVERAGE_FILES: \$\{\{ inputs\.coverage_files \}\}/, /CTX: \$\{\{ github\.workspace \}\}\/\.specguard-ctx/, /HEAD_SHA: /]) assert.match(c, m);
  const src = fs.readFileSync(path.join(__dirname, 'coverage.js'), 'utf8');
  const mapped = new Set([...c.slice(c.indexOf('env:'), c.indexOf('run:')).matchAll(/^\s+([A-Z_]+): /gm)].map((m) => m[1]));
  assert.deepEqual([...src.matchAll(/env\.([A-Z][A-Z_]+)/g)].map((m) => m[1]).filter((k) => !mapped.has(k) && k !== 'GITHUB_WORKSPACE'), []);
});

// ---- fail_on_error: a manual run that could not complete goes red; PR checks stay advisory ----

test('action.yml: the status output covers both post steps (PR and scan) and fail_on_error is off by default', () => {
  assert.match(input('fail_on_error'), /default: "false" \}$/);
  assert.match(yml, /^  status: \{[^}]*value: "\$\{\{ steps\.post\.outputs\.status \|\| steps\.scan_post\.outputs\.status \}\}"/m);
  assert.match(find(/audit-post\.js/), /^id: scan_post$/m);
  assert.match(find(/src\/post\.js'/), /^id: post$/m);
});

test('action.yml: the last step runs fail-on-error.js on every non-cancelled run (configuration failures always fail), passes fail_on_error through, with the status and reason of whichever post step ran', () => {
  const s = steps[steps.length - 1];
  assert.match(cond(s), /^\$\{\{ !cancelled\(\) \}\}$/);
  assert.match(s, /FAIL_ON_ERROR: \$\{\{ inputs\.fail_on_error \}\}/);
  assert.match(s, /STATUS: \$\{\{ steps\.post\.outputs\.status \|\| steps\.scan_post\.outputs\.status \}\}/);
  assert.match(s, /REASON: \$\{\{ steps\.post\.outputs\.reason \|\| steps\.scan_post\.outputs\.reason \}\}/);
  assert.match(s, /node "\$GITHUB_ACTION_PATH\/src\/fail-on-error\.js"/);
});

test('fail-on-error.js: failed exits 1 with ::error::, incomplete only warns, complete or empty is silent; the reason cannot inject a command', () => {
  const run = (STATUS, REASON = '') => spawnSync(process.execPath, [path.join(__dirname, 'fail-on-error.js')], { encoding: 'utf8', env: { ...process.env, STATUS, REASON, FAIL_ON_ERROR: 'true' } });
  const f = run('failed', 'You have exceeded your monthly quota');
  assert.equal(f.status, 1);
  assert.equal(f.stdout.trim(), '::error::SpecGuard could not complete: You have exceeded your monthly quota');
  assert.match(run('failed').stdout, /::error::SpecGuard could not complete: see the job summary/);
  assert.match(run('failed', 'a\n::error::fake').stdout.trim(), /^::error::SpecGuard could not complete: a%0A::error::fake$/);
  const w = run('incomplete', 'engine timeout');
  assert.equal(w.status, 0);
  assert.match(w.stdout, /^::warning::SpecGuard result is incomplete: engine timeout/);
  for (const s of ['complete', '']) assert.deepEqual([run(s).status, run(s).stdout], [0, '']);
});

test('fail-on-error.js: an incomplete status whose counts.json says reduced prints the reduced wording; real incomplete keeps its wording; the exit code is unchanged', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'specguard-foe-'));
  try {
    const run = (STATUS, REASON = '', CTX = dir) => spawnSync(process.execPath, [path.join(__dirname, 'fail-on-error.js')], { encoding: 'utf8', env: { ...process.env, STATUS, REASON, CTX, FAIL_ON_ERROR: "true" } });
    assert.match(run('incomplete').stdout, /^::warning::SpecGuard result is incomplete \(see the job summary\)/, 'no counts.json');
    fs.writeFileSync(path.join(dir, 'counts.json'), JSON.stringify({ v: 1, complete: false, reduced: true }));
    const r = run('incomplete');
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), '::warning::SpecGuard ran a reduced review (fast-tier model): only high-confidence findings are shown (see the job summary)');
    assert.equal(run('failed', 'quota').status, 1, 'failed stays red');
    assert.match(run('failed', 'quota').stdout, /could not complete: quota/);
    const c = run('complete'); // a finished fast-tier review is not incomplete: at most a notice
    assert.equal(c.status, 0); assert.match(c.stdout, /^::notice::SpecGuard ran a fast-tier review/); assert.doesNotMatch(c.stdout, /incomplete|::warning/);
    fs.writeFileSync(path.join(dir, 'counts.json'), JSON.stringify({ v: 1, complete: true }));
    assert.equal(run('complete').stdout, '', 'control: a full-strength complete run prints nothing');
    fs.writeFileSync(path.join(dir, 'counts.json'), JSON.stringify({ v: 1, complete: false, reduced: true }));
    fs.writeFileSync(path.join(dir, 'counts.json'), JSON.stringify({ v: 1, complete: false }));
    assert.match(run('incomplete', 'diff truncated').stdout, /is incomplete: diff truncated/, 'not reduced: the old wording');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('tee-summary.js: the summary markdown also lands in CTX/summary.md while the real summary still gets it; both post steps use it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'specguard-tee-'));
  try {
    const got = [], core = { warning() {}, summary: { addRaw(t) { got.push(t); return { write: async () => 'written' }; } } };
    const tee = require('./tee-summary.js')(core, path.join(dir, 'ctx', 'summary.md'));
    assert.equal(typeof tee.warning, 'function', 'the rest of core is inherited');
    tee.summary.addRaw('## SpecGuard');
    assert.deepEqual(got, ['## SpecGuard']);
    assert.equal(fs.readFileSync(path.join(dir, 'ctx', 'summary.md'), 'utf8'), '## SpecGuard');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  assert.equal(yml.split("src/tee-summary.js')(core, env.CTX + '/summary.md')").length, 3);
});

test('the manual-run workflow turns fail_on_error on; the PR workflow examples leave it off', () => {
  const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
  assert.match(read('.github', 'workflows', 'specguard-run.yml'), /^ +fail_on_error: "true"/m);
  assert.match(read('.github', 'workflows', 'specguard.yml'), /fail_on_error: \{[^}]*type: boolean, default: false \}/, 'forwarded, off unless the caller turns it on');
  assert.doesNotMatch(read('README.md'), /fail_on_error: ?["']?true/);
});

test('action.yml: test_paths reaches the collector and the scan post step as TEST_PATHS, so collect and verify use one test scope (F26)', () => {
  for (const s of [find(/id: audit_collect/), find(/audit-post\.js/)]) assert.match(s, /TEST_PATHS: \$\{\{ inputs\.test_paths \}\}/);
});

test('S13: the preflight step and the post step build CFG from the identical expression, and it includes the base SHA', () => {
  const exprs = [...yml.matchAll(/^ +CFG: (\$\{\{ .* \}\})/gm)].map((m) => m[1]);
  assert.equal(exprs.length, 2, 'one CFG in preflight, one in post');
  assert.equal(exprs[0], exprs[1]);
  assert.match(exprs[0], /github\.event\.pull_request\.base\.sha/);
});

test('S12: the reusable workflow forwards every action input; the rest are documented exclusions, so a new input cannot be forgotten', () => {
  const wf = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'specguard.yml'), 'utf8').replace(/\r\n/g, '\n');
  const block = yml.slice(yml.indexOf('\ninputs:\n'), yml.indexOf('\noutputs:\n'));
  const actionInputs = [...block.matchAll(/^ {2}(\w+): \{/gm)].map((m) => m[1]);
  assert.ok(actionInputs.length >= 47, `parsed ${actionInputs.length} action inputs`);
  const withBlock = /uses: Mira190\/SpecGuard@\w+ # specguard-pin\n {8}with:\n((?: {10}.*\n)+)/.exec(wf)[1];
  const forwarded = [...withBlock.matchAll(/^ {10}(\w+): /gm)].map((m) => m[1]);
  // the "Deliberately NOT forwarded" comment: "#   name[, name]  reason" lines
  const excluded = [...wf.slice(wf.indexOf('Deliberately NOT forwarded')).split('\non:')[0].matchAll(/^# {3}(\w+(?:, \w+)*) {2}\S/gm)].flatMap((m) => m[1].split(', '));
  assert.ok(excluded.length >= 5, 'the exclusions are documented in a comment');
  assert.deepEqual([...new Set([...forwarded, ...excluded])].sort(), [...actionInputs].sort());
  assert.deepEqual(forwarded.filter((k) => excluded.includes(k) && k !== 'github_token'), [], 'a documented exclusion is not forwarded');
  // each non-secret input is declared with the action's own default, so an omitted input behaves as the action does
  const norm = (v) => v.replace(/"/g, '') || 'false'; // a boolean input's empty default means false
  const declared = Object.fromEntries([...wf.matchAll(/^ {6}(\w+): \{[^\n]*default: ([^}]*?) \}$/gm)].map((m) => [m[1], m[2]]));
  for (const k of actionInputs.filter((n) => declared[n] !== undefined && !/^review_timeout_minutes|copilot_max_ai_credits$/.test(n))) assert.equal(norm(declared[k]), norm(new RegExp(`^ {2}${k}: \\{[^\\n]*default: ([^}]*?) \\}$`, 'm').exec(block)[1]), k);
});

test('fail-on-error.js: a configuration failure (auth, quota, model) fails the job without fail_on_error; transient and budget failures stay advisory unless it is true', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'specguard-cfg-'));
  try {
    const run = (STATUS, cls, FAIL_ON_ERROR = '') => {
      fs.writeFileSync(path.join(dir, 'engine-error'), cls ? `${cls}\nwhy\n` : '');
      const env = { ...process.env, STATUS, REASON: 'The Anthropic API key was rejected', CTX: dir };
      delete env.FAIL_ON_ERROR; if (FAIL_ON_ERROR) env.FAIL_ON_ERROR = FAIL_ON_ERROR;
      return spawnSync(process.execPath, [path.join(__dirname, 'fail-on-error.js')], { encoding: 'utf8', env });
    };
    for (const c of ['auth', 'quota', 'model', 'policy', 'config']) {
      const r = run('failed', c);
      assert.equal(r.status, 1, c);
      assert.equal(r.stdout.trim(), `::error::SpecGuard could not run the model (${c}): The Anthropic API key was rejected`);
    }
    for (const c of ['rate', 'budget', 'timeout', '']) {
      const r = run('failed', c);
      assert.equal(r.status, 0, `${c || 'unclassified'} stays advisory`);
      assert.match(r.stdout, /^::warning::SpecGuard could not complete/);
      if (c) assert.match(r.stdout, new RegExp(`\\(${c}\\)`), 'the warning names the class');
      assert.equal(run('failed', c, 'true').status, 1, `${c || 'unclassified'} with fail_on_error true`);
    }
    for (const s of ['complete', 'skip', '']) assert.equal(run(s, 'auth').status, 0, `${s || 'empty'} is not a failure`);
    assert.equal(run('incomplete', 'auth').status, 1, 'incomplete with a configuration class (a part of a split scan hit it) fails too');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('fail-on-error.js: an adapter exception (engine-error class internal) always goes red and names the class, without FAIL_ON_ERROR; a 529 (rate) stays advisory', () => {
  const run = (cls) => { const ctx = fs.mkdtempSync(path.join(os.tmpdir(), 'specguard-foe-')); fs.writeFileSync(path.join(ctx, 'engine-error'), `${cls}\nwhy\n`); const r = spawnSync(process.execPath, [path.join(__dirname, 'fail-on-error.js')], { encoding: 'utf8', env: { ...process.env, STATUS: 'failed', REASON: 'Claude API adapter error', CTX: ctx, FAIL_ON_ERROR: '' } }); fs.rmSync(ctx, { recursive: true, force: true }); return r; };
  const bad = run('internal');
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /^::error::SpecGuard could not run the model \(internal\): Claude API adapter error/);
  const ok = run('rate');
  assert.equal(ok.status, 0);
  assert.match(ok.stdout, /^::warning::/);
});

test('action.yml: context_pack_bytes (empty = the 250000 default) reaches the scan collect step and the engine steps as CONTEXT_PACK_BYTES, parsed by the one packLimit', () => {
  assert.match(input('context_pack_bytes'), /default: "" \}$/);
  const map = /CONTEXT_PACK_BYTES: \$\{\{ inputs\.context_pack_bytes \}\}/;
  assert.match(find(/id: audit_collect/), map);
  for (const s of steps.filter((x) => /CLAUDE_MODE: /.test(x))) assert.match(s, map, 'every engine step');
  const { packLimit } = require('./pack-cap');
  assert.deepEqual([{}, { CONTEXT_PACK_BYTES: '' }, { CONTEXT_PACK_BYTES: '120000' }, { CONTEXT_PACK_BYTES: '0' }].map(packLimit), [250000, 250000, 120000, 0]);
  for (const bad of ['x', '-5', '1.5', '12k']) assert.throws(() => packLimit({ CONTEXT_PACK_BYTES: bad }), /context_pack_bytes/, bad);
});
