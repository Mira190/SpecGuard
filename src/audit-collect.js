#!/usr/bin/env node
// Audit mode, step 1: deterministic context for the checked-out HEAD (no diff, no AI, no repo code executed).
// Env: CTX REQ_PATHS IGNORE_EXTRA MAX_REQUIREMENTS. Writes audit-docs.txt, audit-rejected.txt, standards.txt, test-layout.txt, audit-meta.json.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { run, matchGlob, isTestPath } = require('./trace');

const MAX_AUDIT_DOCS = 60; // the model reads every admitted document in full
const CONTROL = /[\x00-\x1F\x7F]/;
// Same list as STANDARDS and OWN in collect.sh. ponytail: duplicated, keep in sync (trace.js RULE_GLOBS is a third copy).
const E5 = ['md', 'mdx', 'rst', 'txt', 'adoc'];
const STANDARDS = ['.github/copilot-instructions.md', '.github/instructions/**', '**/AGENTS.md', '**/AGENT.md', '**/CLAUDE.md', '**/GEMINI.md', 'REVIEW.md', 'CONTRIBUTING.md', 'CODING_STANDARDS.md', '.editorconfig',
  ...E5.flatMap((e) => [`docs/*standards*.${e}`, `docs/*conventions*.${e}`]), '.claude/rules/**', '.github/skills/**', '.claude/skills/**', '.agents/skills/**',
  '.cursorrules', '.cursor/rules/**', '.windsurfrules', '.clinerules/**'];
const OWN = ['**/skills/test-review/**', '.github/instructions/test-review.instructions.md'];
const TEST_NAMES = [['*.test.*', /\.test\.[^.]+$/], ['*.spec.*', /\.spec\.[^.]+$/], ['test_*', /^test_/], ['*_test.*', /_test\.[^.]+$/], ['*Test.*, *Tests.*', /Tests?\.[^.]+$/]];
const TEST_CONFIG = /^(package\.json|pytest\.ini|tox\.ini|setup\.cfg|pyproject\.toml|go\.mod|Cargo\.toml|pom\.xml|build\.gradle(\.kts)?|Gemfile|phpunit\.xml(\.dist)?|jest\.config\.[cm]?[jt]s|vitest\.config\.[cm]?[jt]s|playwright\.config\.[jt]s|cypress\.config\.[jt]s|.*\.csproj)$/;
const DOC = /\.(md|mdx|markdown|rst|adoc|txt|feature)$/i;

const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'pipe'] });
const lines = (s) => String(s).split('\n').filter(Boolean);

// Tracked regular files (symlinks excluded) at HEAD.
function tracked(cwd) {
  return git(cwd, ['ls-files', '-z', '-s']).split('\0').flatMap((r) => {
    const m = /^(\d{6}) \w+ \d\t([\s\S]+)$/.exec(r);
    return m && m[1] !== '120000' && !CONTROL.test(m[2]) ? [m[2]] : [];
  });
}

function testLayout(files) {
  const dirs = new Map(), names = new Map(), cfg = new Set();
  for (const f of files) {
    const base = path.posix.basename(f);
    if (TEST_CONFIG.test(base) && f.split('/').length <= 3) cfg.add(f);
    if (DOC.test(f) || !(isTestPath(f) || /Tests?\.(java|kt|cs|swift|scala)$/.test(f))) continue;
    const d = path.posix.dirname(f);
    dirs.set(d, (dirs.get(d) || 0) + 1);
    for (const [n, re] of TEST_NAMES) if (re.test(base)) names.set(n, (names.get(n) || 0) + 1);
  }
  const top = (m, n) => [...m].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, n).map(([k, v]) => `${k} (${v})`).join(', ') || 'none found';
  return `test directories: ${top(dirs, 15)}\ntest file names: ${top(names, 6)}\ntest config files: ${[...cfg].sort().slice(0, 15).join(', ') || 'none found'}\n`;
}

function collect({ cwd = '.', ctx, reqPaths = '', ignoreExtra = '', maxRequirements = 80 }) {
  const head = git(cwd, ['rev-parse', 'HEAD']).trim();
  fs.rmSync(ctx, { recursive: true, force: true });
  fs.mkdirSync(ctx, { recursive: true });
  // trace.js with base = head: no diff, so it only discovers the requirement documents (same rules, caps and ignores as the PR review)
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'specguard-audit-'));
  let found, rejected, limitations = [];
  try {
    run({ cwd, base: head, head, ctx: scratch, reqPaths, ignoreExtra });
    const read = (n) => { try { return fs.readFileSync(path.join(scratch, n), 'utf8'); } catch { return ''; } };
    found = lines(read('spec-files.txt'));
    rejected = lines(read('spec-rejected.txt')).map((l) => l.split('\t'));
    try { limitations = JSON.parse(read('trace-candidates.json')).limitations || []; } catch { /* none */ }
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }

  const inc = lines(reqPaths).map((l) => l.trim()).filter((l) => l && !l.startsWith('!'));
  const forced = (p) => inc.some((g) => matchGlob(p, g));
  const ordered = [...found.filter(forced), ...found.filter((p) => !forced(p))];
  const docs = ordered.slice(0, MAX_AUDIT_DOCS);
  for (const p of ordered.slice(MAX_AUDIT_DOCS)) rejected.push([p, `over the ${MAX_AUDIT_DOCS}-document audit limit`]);

  const files = tracked(cwd);
  const standards = files.filter((f) => STANDARDS.some((g) => matchGlob(f, g)) && !OWN.some((g) => matchGlob(f, g)));
  const w = (n, s) => fs.writeFileSync(path.join(ctx, n), s);
  w('audit-docs.txt', docs.map((p) => `${p}\t${forced(p) ? 'requirements_paths' : 'discovered'}\n`).join(''));
  w('audit-rejected.txt', rejected.map(([p, why]) => `${p}\t${why}\n`).join(''));
  w('standards.txt', standards.map((f) => `${f}\n`).join(''));
  w('test-layout.txt', testLayout(files));
  w('audit-meta.json', JSON.stringify({ head, max_requirements: maxRequirements, docs: docs.length, limitations }) + '\n');
  return { docs, rejected, standards, head };
}

if (require.main === module) {
  const env = process.env;
  const max = /^\d{1,3}$/.test(env.MAX_REQUIREMENTS || '80') ? +(env.MAX_REQUIREMENTS || 80) : 0;
  if (max < 1 || max > 500) { console.log('::error::audit_max_requirements must be an integer from 1 to 500'); process.exit(1); }
  if (!env.CTX) { console.error('CTX is required'); process.exit(2); }
  const r = collect({ ctx: env.CTX, reqPaths: env.REQ_PATHS, ignoreExtra: env.IGNORE_EXTRA, maxRequirements: max });
  console.log(`SpecGuard audit: ${r.docs.length} requirement document(s), ${r.rejected.length} not admitted`);
  if (env.GITHUB_OUTPUT) fs.appendFileSync(env.GITHUB_OUTPUT, `skip=${r.docs.length ? 'false' : 'true'}\n`);
}
module.exports = { collect, testLayout, STANDARDS };
