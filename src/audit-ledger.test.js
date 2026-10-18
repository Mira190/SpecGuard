const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { collect } = require('./audit-collect');

// scan_scope all: everything not reviewed is counted and named (not_unit: scan_paths files the default non-unit rule drops; docs_over_size: requirement documents over 256 KiB)
function repo(t, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'specguard-ledger-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const git = (...a) => execFileSync('git', ['-c', 'core.autocrlf=false', ...a], { cwd: root, stdio: 'pipe' });
  git('init'); git('config', 'user.name', 'SpecGuard test'); git('config', 'user.email', 'test@example.invalid');
  for (const [f, s] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true }); fs.writeFileSync(path.join(root, f), s); }
  git('add', '.'); git('commit', '-m', 'init');
  const ctx = path.join(root, '.specguard-ctx'); fs.mkdirSync(ctx);
  return { root, ctx };
}
const BODY = (n) => Array.from({ length: 12 }, (_, i) => `exports.${n}${i} = (a, b) => { if (a > b) return a - b; return b + ${i}; };`).join('\n') + '\n';
const metaOf = (ctx) => JSON.parse(fs.readFileSync(path.join(ctx, 'audit-meta.json'), 'utf8'));

test('collect: source files in scan_paths that the default non-unit rule drops (scripts/, migrations/, examples/) are counted and named; they stay non-units; src/ is unaffected', (t) => {
  for (const d of ['scripts', 'migrations', 'examples', 'src']) for (const all of [true, false]) {
    const { root, ctx } = repo(t, { [`${d}/a.js`]: BODY('a'), [`${d}/b.js`]: BODY('b'), 'README.md': '# x\n' });
    const r = collect({ cwd: root, ctx, scopeAll: all, scanPaths: `${d}/**` }), meta = metaOf(ctx), dropped = d !== 'src';
    assert.equal(r.units.total, dropped ? 0 : 2, `${d} units`);
    assert.equal(meta.not_unit, dropped && all ? 2 : undefined, `${d} all ${all}`);
    assert.equal(meta.limitations.some((l) => /^2 source file\(s\) in scan_paths were not reviewed .*: \w+\/a\.js, \w+\/b\.js$/.test(l)), dropped, `${d} limitation`);
  }
  const { root, ctx } = repo(t, { 'scripts/a.js': BODY('a') });
  collect({ cwd: root, ctx, scopeAll: true });
  assert.equal(metaOf(ctx).not_unit, undefined, 'no scan_paths: the default exclusion is the documented convention, nothing is counted');
});

test('collect: a requirement document over 256 KiB with fewer than 5 MUST lines is rejected and in limitations in a scan; scan_scope all counts it as docs_over_size', (t) => {
  const big = (musts) => '# Design\n\n' + 'Some narrative text about the system that goes on. '.repeat(6000) + '\n\n' + Array.from({ length: musts }, (_, i) => `The system MUST do thing ${i}.\n\n`).join('');
  for (const [musts, all] of [[2, true], [2, false], [6, true]]) {
    const { root, ctx } = repo(t, { 'docs/design.md': big(musts), 'src/a.js': BODY('a') });
    collect({ cwd: root, ctx, scopeAll: all });
    const meta = metaOf(ctx), rej = fs.readFileSync(path.join(ctx, 'audit-rejected.txt'), 'utf8');
    assert.match(rej, /^docs\/design\.md\tover size cap/m, `${musts} MUST`);
    assert.ok(meta.limitations.some((l) => /^oversize doc skipped: docs\/design\.md/.test(l)), `${musts} MUST limitation`);
    assert.equal(meta.docs_over_size, all ? 1 : undefined, `${musts} MUST scopeAll ${all}`);
  }
});
