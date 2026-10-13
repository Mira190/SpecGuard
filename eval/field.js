#!/usr/bin/env node
// Field study: runs src/trace.js and src/collect.sh, deterministically (no LLM, no network at run time), over real
// open-source clones to find noise, scale and parsing problems. Clones live outside the repo (default: --dir).
//   node eval/field.js clone    --dir D [--only a,b]
//   node eval/field.js discover --dir D --out F.json [--only a,b]      which tracked docs are classified requirement docs
//   node eval/field.js measure  --dir D --out F.json [--only a,b] [-n 15]   collect.sh + trace.js on recent commits
//   node eval/field.js big      --dir D --repo NAME --out F.json        largest commit's full diff, trace.js timing
//   node eval/field.js summary  --out F.json [--discover F2.json]        markdown tables
//   node eval/field.js adjudicate --out DISCOVER.json                     doc-level precision from the hand-made path rules
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const trace = require('../src/trace.js');

const ROOT = path.join(__dirname, '..');
const DOC_EXT = /\.(md|mdx|markdown|rst|adoc|txt|feature)$/i; // mirrors trace.js
const NOT_CODE = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|go\.sum|poetry\.lock|composer\.lock|Gemfile\.lock)$|\.lock$|\.(png|jpe?g|gif|svg|ico|pdf|zip|snap)$/i;
const fwd = (p) => path.resolve(p).replace(/\\/g, '/');

// name, url, lang, requirement docs expected (for the sampling design only; adjudication is done on the output), why
const REPOS = [
  ['OpenSpec', 'Fission-AI/OpenSpec', 'TypeScript', true, 'MIT. openspec/specs/**/spec.md use SHALL requirements and Scenario blocks (the format the tool targets).'],
  ['spec-kit', 'github/spec-kit', 'Python', true, 'MIT. Spec-driven-development docs and templates with requirement-like text.'],
  ['OpenAPI-Specification', 'OAI/OpenAPI-Specification', 'Markdown/JS', true, 'Apache-2.0. RFC 2119 MUST/SHALL prose, big markdown tables, many versioned copies of the same spec.'],
  ['enhancements', 'kubernetes/enhancements', 'Go/YAML', true, 'Apache-2.0. Thousands of KEPs (design docs with goals, requirements, graduation criteria).'],
  ['cucumber-ruby', 'cucumber/cucumber-ruby', 'Ruby', true, 'MIT. Gherkin .feature files, Rule/Scenario blocks.'],
  ['fastapi', 'fastapi/fastapi', 'Python', false, 'MIT. Tutorial-style docs, ~20 translations (non-English, over 2000 md files). A discovery false-positive trap.'],
  ['express', 'expressjs/express', 'JavaScript', false, 'MIT. Small repo; History.md, Readme.md, no spec docs.'],
  ['ripgrep', 'BurntSushi/ripgrep', 'Rust', false, 'MIT/Unlicense. GUIDE.md, FAQ.md, CHANGELOG; no requirements.'],
  ['guava', 'google/guava', 'Java', false, 'Apache-2.0. Large Java tree (~3k files), few docs.'],
  ['curl', 'curl/curl', 'C', false, 'curl licence (MIT-like). C, hundreds of man-page style .md docs, tests as text files.'],
  ['laravel-framework', 'laravel/framework', 'PHP', false, 'MIT. PHP, ~3k files, only README/CHANGELOG-type docs.'],
  ['kubernetes', 'kubernetes/kubernetes', 'Go', false, 'Apache-2.0. The biggest repo (~28k tracked files, scale test). Mostly code, vendored docs.'],
].map(([name, repo, lang, reqDocs, why]) => ({ name, repo, url: `https://github.com/${repo}.git`, lang, reqDocs, why }));

// ---- small pure helpers -------------------------------------------------------------------------------------
const isDoc = (p) => DOC_EXT.test(p);
const isCode = (p) => !isDoc(p) && !NOT_CODE.test(p);

// log: [{sha, files:[paths], parents}] newest first. mixed = touches a doc and a code file; code = code files only (no doc).
// Commits with no parent (shallow boundary, root) or more than maxFiles files (bulk moves/vendoring) are skipped.
function pickCommits(log, n = 15, maxFiles = 200) {
  const ok = log.filter((c) => c.parents >= 1 && c.parents <= 1 && c.files.length && c.files.length <= maxFiles);
  return {
    mixed: ok.filter((c) => c.files.some(isDoc) && c.files.some(isCode)).slice(0, n),
    code: ok.filter((c) => !c.files.some(isDoc) && c.files.some(isCode)).slice(0, n),
  };
}

function quantile(xs, q) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b), i = (s.length - 1) * q, lo = Math.floor(i), hi = Math.ceil(i);
  return s[lo] + (s[hi] - s[lo]) * (i - lo);
}
const r1 = (x) => (x == null ? null : Math.round(x * 10) / 10);
const r2 = (x) => (x == null ? null : Math.round(x * 100) / 100);

// rows: measurement records. Crashed/timed-out rows count toward `crashed`/`timedOut` and are excluded from distributions only for sizes.
function aggregate(rows) {
  const ok = rows.filter((r) => !r.crashed);
  const col = (f) => ok.map(f).filter((x) => typeof x === 'number');
  const dist = (f) => { const v = col(f); return { p50: r1(quantile(v, 0.5)), p95: r1(quantile(v, 0.95)), max: v.length ? Math.max(...v) : null }; };
  return {
    n: rows.length, crashed: rows.filter((r) => r.crashed && !r.trace_timed_out).length, timedOut: rows.filter((r) => r.timed_out).length,
    trace_timeouts: rows.filter((r) => r.trace_timed_out || (r.warnings || []).some((w) => /tracing failed/.test(w) && r.wall_s >= 60)).length,
    wall_s: dist((r) => r.wall_s), trace_s: dist((r) => r.trace_s), s_items: dist((r) => r.s_items),
    cand_per_hunk: dist((r) => r.cand_per_hunk_mean), hunks: dist((r) => r.hunks), occurrences: dist((r) => r.occurrences),
    index_bytes: dist((r) => r.index_bytes), cand_bytes: dist((r) => r.cand_bytes), tokens: dist((r) => r.tokens),
    with_limitations: rows.filter((r) => r.limitations && r.limitations.length).length,
  };
}

function renderTable(head, rows) {
  const cell = (x) => String(x ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
  return [`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`, ...rows.map((r) => `| ${r.map(cell).join(' | ')} |`)].join('\n');
}

// ---- git ------------------------------------------------------------------------------------------------------
const git = (cwd, args, o = {}) => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 1 << 30, stdio: ['ignore', 'pipe', 'pipe'], ...o });

function listCommits(cwd, max = 3000) {
  const out = git(cwd, ['log', '--no-merges', '-z', '--name-only', '--no-renames', '--format=%x01%H %P', '-n', String(max)]);
  const log = [];
  for (const chunk of out.split('\x01').slice(1)) {
    const [h, ...rest] = chunk.split('\0');
    const [sha, ...parents] = h.trim().split(' ');
    // shallow boundary commits list their (absent) parent in %P only for grafted history; check existence below
    log.push({ sha, parents: parents.filter(Boolean).length, files: rest.map((s) => s.replace(/^\n/, '')).filter(Boolean) });
  }
  // a shallow boundary commit has a parent line but no parent object: drop it
  const shallow = new Set(fs.existsSync(path.join(cwd, '.git', 'shallow')) ? fs.readFileSync(path.join(cwd, '.git', 'shallow'), 'utf8').split('\n').filter(Boolean) : []);
  return log.map((c) => (shallow.has(c.sha) ? { ...c, parents: 0 } : c));
}

// blobs by path via one cat-file --batch
function catBlobs(cwd, entries) {
  const buf = execFileSync('git', ['cat-file', '--batch'], { cwd, input: entries.map((e) => e.sha).join('\n') + '\n', maxBuffer: 1 << 30, stdio: ['pipe', 'pipe', 'pipe'] });
  const out = new Map();
  let pos = 0;
  for (const e of entries) {
    const nl = buf.indexOf(10, pos), m = /^[0-9a-f]+ \w+ (\d+)$/.exec(buf.toString('utf8', pos, nl));
    if (!m) { pos = nl + 1; continue; }
    out.set(e.path, buf.subarray(nl + 1, nl + 1 + +m[1])); pos = nl + 1 + +m[1] + 1;
  }
  return out;
}

// ---- discovery --------------------------------------------------------------------------------------------------
// Which tracked docs does trace.classify admit at HEAD, with their items; plus the file-shape hazards the study looks for.
const BY_DESIGN_SKIP = /(^|\/)(vendor|node_modules|dist|build)\/|(^|\/)(CHANGELOG|LICENSE|COPYING|CODE_OF_CONDUCT|SECURITY|CONTRIBUTING|README_OLD)[^/]*$/i;
// Item flavour heuristics for the noise estimate (adjudication of docs is done separately, by path rules below).
const SECOND_PERSON = /\b(you|your|you're|we|our|let's|please)\b|你|您|我们/i;
const PROCESS = /\b(PRs?|pull requests?|commits?|issues?|maintainers?|contribut\w+|reviewers?|release|merge[sd]?|changelog|checklist|CI)\b/i;
const MARKETING = /\b(easy|easily|simple|simply|powerful|blazing|beautiful|modern|robust|seamless|best|production-ready|awesome|zero)\b/i;
// Template text repeated verbatim across docs (KEP template, license text, YAML front-matter 'Example:' lines).
const BOILERPLATE = /^(\*\*Note:\*\* Any PRs to move a KEP|\*\*ACTION REQUIRED|Example: -|IN NO EVENT SHALL)/;
const flavour = (t) => (SECOND_PERSON.test(t) ? 'second_person' : PROCESS.test(t) ? 'process' : MARKETING.test(t) ? 'marketing' : 'other');

// rev defaults to the clone's remote default branch so later measure runs (which move HEAD) do not matter.
function defaultRev(cwd) { try { return git(cwd, ['rev-parse', '--verify', '-q', 'refs/remotes/origin/HEAD']).trim(); } catch { return 'HEAD'; } }

function discoverRepo(cwd, { sample = 8, rev = defaultRev(cwd) } = {}) {
  const ls = git(cwd, ['ls-tree', '-r', '-z', rev]).split('\0').filter(Boolean).map((l) => /^(\d+) (\w+) (\w+)\t([\s\S]*)$/.exec(l)).filter(Boolean).map((m) => ({ mode: m[1], sha: m[3], path: m[4] }));
  const tracked = ls.length, symlinks = ls.filter((e) => e.mode === '120000').length, submodules = ls.filter((e) => e.mode === '160000').length;
  const docs = ls.filter((e) => e.mode !== '120000' && e.mode !== '160000' && isDoc(e.path)).map((e) => e.path);
  const docSet = new Set(docs), t0 = process.hrtime.bigint();
  const classified = trace.classify({ cwd, base: null, head: rev, paths: docs });
  const classify_s = Number(process.hrtime.bigint() - t0) / 1e9;
  const isClass = new Set(classified);
  const blobs = catBlobs(cwd, ls.filter((e) => docSet.has(e.path)));
  const shape = { crlf: 0, bom: 0, non_utf8: 0, huge: 0, binary: 0 };
  const docsOut = [], missedCand = [], items = [];
  const dec = new TextDecoder('utf-8', { fatal: true });
  for (const p of docs) {
    const buf = blobs.get(p); if (!buf) continue;
    if (buf.includes(0)) { shape.binary++; continue; }
    if (buf.length > 256 * 1024) shape.huge++;
    if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) shape.bom++;
    let text;
    try { text = dec.decode(buf); } catch { shape.non_utf8++; text = buf.toString('utf8'); }
    if (text.includes('\r\n')) shape.crlf++;
    if (isClass.has(p)) {
      const its = trace.parseItems(p, text);
      const nlines = text.split('\n').length, whole = (i) => nlines > 40 && i.end - i.line + 1 >= nlines * 0.5;
      for (const i of its) items.push({ path: p, kind: i.kind, line: i.line, text: i.text, span: i.end - i.line + 1, whole: whole(i) });
      const kinds = {}; for (const i of its) kinds[i.kind] = (kinds[i.kind] || 0) + 1;
      docsOut.push({ path: p, bytes: buf.length, lines: nlines, items: its.length, kinds, whole_doc_items: its.filter(whole).length, noise_items: its.filter((i) => whole(i) || BOILERPLATE.test(i.text)).length, sample: its.slice(0, 3).map((i) => `${i.line}: ${i.text.replace(/\s+/g, ' ').slice(0, 140)}`) });
    } else if (buf.length <= 256 * 1024) {
      // not classified: does it still look like it has RFC 2119 or Gherkin rules?
      if (BY_DESIGN_SKIP.test(p)) continue;
      const rfc = (text.match(/\b(MUST|SHALL|MUST NOT|SHALL NOT)\b/g) || []).length;
      const lc = (text.match(/\b(shall|must)\b/gi) || []).length;
      const gh = (text.match(/^\s*(Feature|Scenario|Scenario Outline|Rule):/gm) || []).length;
      if (rfc >= 2 || gh || lc >= 3) missedCand.push({ path: p, rfc, lc, gherkin: gh, bytes: buf.length });
    }
  }
  missedCand.sort((a, b) => b.rfc + b.gherkin * 5 - (a.rfc + a.gherkin * 5) || b.lc - a.lc);
  const pick = (arr, k) => { const step = Math.max(1, Math.floor(arr.length / k)); return arr.filter((_, i) => i % step === 0).slice(0, k); };
  return { tracked, docs: docs.length, classified: classified.length, items: items.length, classify_s: r2(classify_s),
    flavour: items.reduce((a, i) => { const f = flavour(i.text); a[f] = (a[f] || 0) + 1; return a; }, {}),
    whole_doc_items: items.filter((i) => i.whole).length, max_span: items.reduce((m, i) => Math.max(m, i.span), 0),
    nondoc_spec_like: ls.filter((e) => /(openapi|swagger)[^/]*\.(json|ya?ml)$|\.schema\.json$|\.(feature|rst|adoc|html?)$/i.test(e.path) && !isDoc(e.path)).length,
    shape, symlinks, submodules, doc_list: docsOut, item_sample: pick(items, sample).map((i) => `${i.path}:${i.line} ${i.text.replace(/\s+/g, ' ').slice(0, 140)}`),
    missed_candidates: missedCand.slice(0, 25), missed_total: missedCand.length };
}

// ---- adjudication ------------------------------------------------------------------------------------------------
// Hand-made verdicts per classified doc, by path rule (first match wins), written after reading the samples in discover.json.
// TP = states testable product/system rules (spec, RFC 2119 prose, Gherkin, architecture constraints).
// BORDER = design/plan/proposal prose that does contain rules but mixes them with rationale (counted as TP only in the lenient figure).
// FP = process text, changelog-like, API/CLI reference, tutorial, LLM prompt, template placeholder, test data, license text.
const RULES = [
  ['OpenSpec', /^openspec\/(specs\/|changes\/.*\/specs\/|work\/.*\/spec\.md)/, 'TP', 'spec file'],
  ['OpenSpec', /^openspec\/(changes|work|explorations|initiatives)\//, 'BORDER', 'design/plan prose'],
  ['OpenSpec', /./, 'FP', 'user docs, CLI reference or LLM skill prompt'],
  ['spec-kit', /^(\.specify\/memory\/constitution|design\/|extensions\/RFC-)/, 'TP', 'governance/architecture rules'],
  ['spec-kit', /template\.md$/, 'FP', 'template placeholders'],
  ['spec-kit', /^spec-driven\.md$/, 'BORDER', 'methodology essay'],
  ['spec-kit', /./, 'FP', 'LLM prompt, CLI reference, how-to or workflow text'],
  ['OpenAPI-Specification', /^(versions|proposals)\//, 'TP', 'RFC 2119 spec or spec proposal'],
  ['OpenAPI-Specification', /./, 'FP', 'governance/process'],
  ['enhancements', /NNNN-kep-template|testdata|^docs\//, 'FP', 'template, test fixture or process doc'],
  ['enhancements', /specification\.md$|design\.md$/, 'TP', 'design/spec doc'],
  ['enhancements', /README\.md$/, 'BORDER', 'KEP design doc (hits are mostly title/template boilerplate)'],
  ['cucumber-ruby', /^features\/docs\//, 'TP', 'executable behaviour spec'],
  ['cucumber-ruby', /^(examples|spec)\//, 'BORDER', 'example/test scenarios'],
  ['cucumber-ruby', /./, 'FP', 'upgrade notes ("Example:" prose)'],
  ['curl', /^docs\/internals\/(?!LLIST|UINT)/, 'BORDER', 'developer design notes with must/shall'],
  ['curl', /./, 'FP', 'man-page option reference, API reference, license text or "Example:" front matter'],
  ['kubernetes', /pluginwatcher\/README|cri-api\/README/, 'BORDER', 'component protocol/design notes'],
  ['kubernetes', /./, 'FP', 'process, changelog index, README or reference'],
  ['fastapi', /./, 'FP', 'tutorial, LLM translation prompt or llm test page'],
  ['express', /./, 'FP', 'release history'],
  ['ripgrep', /./, 'FP', 'user guide / README'],
  ['guava', /./, 'FP', 'literary test data (.txt)'],
];
const verdictOf = (repo, p) => { const r = RULES.find(([n, re]) => n === repo && re.test(p)); return r ? { verdict: r[2], reason: r[3] } : { verdict: 'UNREVIEWED', reason: 'no rule' }; };

// disc: { repo: discoverRepo result }. Returns per repo and total counts, doc-level precision (strict TP only, lenient TP+BORDER) and
// the share of items sitting in FP docs or flagged as noise (whole-doc/boilerplate).
function adjudicate(disc) {
  const per = {}, tot = { docs: 0, TP: 0, BORDER: 0, FP: 0, UNREVIEWED: 0, items: 0, fpItems: 0, noiseItems: 0 };
  for (const [repo, d] of Object.entries(disc)) {
    const c = { docs: 0, TP: 0, BORDER: 0, FP: 0, UNREVIEWED: 0, items: 0, fpItems: 0, noiseItems: 0, reasons: {} };
    for (const x of d.doc_list) {
      const v = verdictOf(repo, x.path);
      c.docs++; c[v.verdict]++; c.items += x.items; c.noiseItems += x.noise_items || 0;
      if (v.verdict === 'FP') { c.fpItems += x.items; c.reasons[v.reason] = (c.reasons[v.reason] || 0) + 1; }
    }
    per[repo] = c;
    for (const k of Object.keys(tot)) tot[k] += c[k];
  }
  const pr = (c) => ({ strict: c.docs ? c.TP / c.docs : null, lenient: c.docs ? (c.TP + c.BORDER) / c.docs : null });
  return { per: Object.fromEntries(Object.entries(per).map(([k, c]) => [k, { ...c, ...pr(c) }])), total: { ...tot, ...pr(tot) } };
}

// ---- measurement ------------------------------------------------------------------------------------------------
// requirements.js calls `gh`; serve an empty PR so collection is offline and deterministic (same idea as eval/local.js).
const SHIM = `const cp = require('node:child_process'), orig = cp.execFileSync;
cp.execFileSync = function (file, args) {
  if (file !== 'gh') return orig.apply(this, arguments);
  if (args[0] === 'pr' && args[1] === 'view') return JSON.stringify({ number: 1, title: 'field study', body: '', closingIssuesReferences: [] });
  if (args[0] === 'api') return '[]';
  throw new Error('gh is offline');
};
`;
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
const sizeOf = (p) => { try { return fs.statSync(p).size; } catch { return null; } };

// Metrics from a ctx dir after collect.sh / trace.js ran.
function readCtx(ctx) {
  const st = readJson(path.join(ctx, 'requirements-status.json')) || {}, c = readJson(path.join(ctx, 'trace-candidates.json')) || {};
  const per = (c.code_to_requirement || []).map((h) => (h.candidates || []).length);
  const index_bytes = sizeOf(path.join(ctx, 'requirements-index.md')), cand_bytes = sizeOf(path.join(ctx, 'trace-candidates.json'));
  return {
    s_items: (st.criteria || []).filter((x) => /^S\d+$/.test(x.id)).length, spec_files: st.spec?.files ?? null, spec_items: st.spec?.items ?? null,
    hunks: per.length, cand_per_hunk_mean: per.length ? r1(per.reduce((a, b) => a + b, 0) / per.length) : null, cand_per_hunk_max: per.length ? Math.max(...per) : null,
    req_to_code: (c.requirement_to_code || []).length, occurrences: (c.occurrences || []).length, limitations: c.limitations || [],
    index_bytes, cand_bytes, tokens: index_bytes != null && cand_bytes != null ? Math.round((index_bytes + cand_bytes) / 4) : null,
  };
}

function measureCommit(cwd, sha, work, { timeoutMs = 120000 } = {}) {
  const base = git(cwd, ['rev-parse', `${sha}^`]).trim();
  try { git(cwd, ['reset', '-q', '--hard']); git(cwd, ['clean', '-fdq']); } catch { /* clone is scratch */ }
  fs.rmSync(work, { recursive: true, force: true }); fs.mkdirSync(work, { recursive: true });
  const shim = path.join(work, 'gh-shim.js'), ctx = path.join(work, 'ctx'), outputs = path.join(work, 'gh-output.txt');
  fs.writeFileSync(shim, SHIM); fs.writeFileSync(outputs, '');
  const env = { ...process.env, BASE_SHA: base, HEAD_SHA: sha, CTX: fwd(ctx), TRACE: 'auto', REQ_PATHS: '', IGNORE_EXTRA: '', PR_NUMBER: '1', GH_REPO: 'local/field', GH_TOKEN: 'offline',
    GITHUB_OUTPUT: fwd(outputs), NODE_OPTIONS: `--require "${fwd(shim)}"` };
  const t0 = process.hrtime.bigint();
  const r = spawnSync('bash', [fwd(path.join(ROOT, 'src', 'collect.sh'))], { cwd, env, encoding: 'utf8', maxBuffer: 1 << 28, timeout: timeoutMs });
  const wall_s = Number(process.hrtime.bigint() - t0) / 1e9;
  const log = `${r.stdout || ''}${r.stderr || ''}`;
  const rec = { sha: sha.slice(0, 10), base: base.slice(0, 10), wall_s: r2(wall_s), exit: r.status, timed_out: wall_s >= 60 || r.error?.code === 'ETIMEDOUT',
    crashed: r.status !== 0 || !!r.error, warnings: log.split('\n').filter((l) => l.startsWith('::warning::')).map((l) => l.slice(0, 160)),
    skipped: (fs.readFileSync(outputs, 'utf8')).includes('skip=true'), files: git(cwd, ['diff', '--name-only', '--no-renames', `${base}...${sha}`]).split('\n').filter(Boolean).length };
  if (rec.warnings.length) rec.log_head = log.slice(0, 500);
  if (rec.crashed) rec.error = (r.error ? String(r.error.message) : log.split('\n').filter(Boolean).slice(-4).join(' | ')).slice(0, 300);
  Object.assign(rec, readCtx(ctx));
  // trace.js alone, on a copy of the ctx, for its own wall time and exit
  if (!rec.skipped && fs.existsSync(ctx)) {
    const ctx2 = path.join(work, 'ctx2'); fs.cpSync(ctx, ctx2, { recursive: true });
    const t1 = process.hrtime.bigint();
    const tr = spawnSync('node', [path.join(ROOT, 'src', 'trace.js')], { cwd, env: { ...env, CTX: fwd(ctx2) }, encoding: 'utf8', maxBuffer: 1 << 28, timeout: timeoutMs });
    rec.trace_s = r2(Number(process.hrtime.bigint() - t1) / 1e9);
    rec.trace_exit = tr.status;
    if (tr.error?.code === 'ETIMEDOUT') { rec.trace_timed_out = true; rec.trace_s = timeoutMs / 1000; }
    else if (tr.status !== 0) { rec.trace_error = String(tr.stderr || tr.error || '').split('\n').filter(Boolean).slice(0, 4).join(' | ').slice(0, 400); rec.crashed = true; }
  }
  return rec;
}

function measureRepo(cwd, work, n, log = () => {}) {
  const picks = pickCommits(listCommits(cwd), n), rows = [];
  for (const [kind, list] of Object.entries(picks)) {
    for (const c of list) {
      let rec; try { rec = measureCommit(cwd, c.sha, path.join(work, c.sha.slice(0, 10))); } catch (e) { rec = { sha: c.sha.slice(0, 10), crashed: true, error: String(e.message).split('\n')[0] }; }
      rows.push({ kind, ...rec }); log(`  ${kind} ${rec.sha} ${rec.wall_s ?? '?'}s${rec.crashed ? ' CRASH ' + (rec.error || rec.trace_error) : ''}`);
    }
  }
  return rows;
}

// Largest commit by changed-file count among the last `max` commits; times trace.js for it. Returns null on a repo without parents.
function bigCommit(cwd, work, max = 3000) {
  const best = listCommits(cwd, max).filter((c) => c.parents >= 1).sort((a, b) => b.files.length - a.files.length)[0];
  if (!best) return null;
  const rec = measureCommit(cwd, best.sha, work);
  const bytes = Number(git(cwd, ['diff', '--no-renames', `${best.sha}^...${best.sha}`], { maxBuffer: 1 << 30 }).length);
  return { ...rec, changed_files: best.files.length, diff_bytes: bytes };
}

// ---- summary ----------------------------------------------------------------------------------------------------
function summarize(measure, discover) {
  const out = [];
  if (discover) {
    out.push(renderTable(['repo', 'tracked', 'docs', 'classified', 'items', 'classify s', 'symlinks', 'submod', 'CRLF', 'BOM', 'non-UTF8', '>256KB'],
      Object.entries(discover).map(([k, d]) => [k, d.tracked, d.docs, d.classified, d.items, d.classify_s, d.symlinks, d.submodules, d.shape.crlf, d.shape.bom, d.shape.non_utf8, d.shape.huge])));
  }
  if (measure) {
    const rowsBy = (kind) => Object.entries(measure).map(([k, rows]) => [k, aggregate(rows.filter((r) => r.kind === kind))]);
    for (const kind of ['mixed', 'code']) {
      out.push(`\n${kind} commits\n`);
      out.push(renderTable(['repo', 'n', 'crash', 'timeout', 'wall p50', 'wall p95', 'trace p50', 'trace p95', 'S p50/max', 'cand/hunk p50', 'occ max', 'index p95 B', 'cand p95 B', 'tokens p95'],
        rowsBy(kind).map(([k, a]) => [k, a.n, a.crashed, a.timedOut, a.wall_s.p50, a.wall_s.p95, a.trace_s.p50, a.trace_s.p95, `${a.s_items.p50}/${a.s_items.max}`, a.cand_per_hunk.p50, a.occurrences.max, a.index_bytes.p95, a.cand_bytes.p95, a.tokens.p95])));
    }
    const all = aggregate(Object.values(measure).flat());
    out.push(`\nall: ${JSON.stringify(all)}`);
  }
  return out.join('\n');
}

// ---- CLI ----------------------------------------------------------------------------------------------------------
function main() {
  const { values: o, positionals: [cmd] } = require('node:util').parseArgs({ allowPositionals: true, options: {
    dir: { type: 'string' }, out: { type: 'string' }, only: { type: 'string' }, n: { type: 'string', short: 'n', default: '15' }, repo: { type: 'string' }, discover: { type: 'string' } } });
  const pick = REPOS.filter((r) => !o.only || o.only.split(',').includes(r.name));
  const save = (data) => { fs.writeFileSync(o.out, JSON.stringify(data, null, 2) + '\n'); };
  if (cmd === 'clone') {
    for (const r of pick) {
      const dest = path.join(o.dir, r.name);
      if (fs.existsSync(dest)) continue;
      execFileSync('git', ['clone', '-q', '-c', 'core.autocrlf=false', '-c', 'core.longpaths=true', '--depth', r.name === 'kubernetes' ? '120' : '200', '--no-tags', r.url, dest], { stdio: 'inherit' });
    }
  } else if (cmd === 'discover') {
    const res = {}; for (const r of pick) { console.log(r.name); res[r.name] = discoverRepo(path.join(o.dir, r.name)); save(res); }
  } else if (cmd === 'measure') {
    const res = fs.existsSync(o.out) ? JSON.parse(fs.readFileSync(o.out, 'utf8')) : {};
    for (const r of pick) { console.log(r.name); res[r.name] = measureRepo(path.join(o.dir, r.name), path.join(o.dir, '_work', r.name), +o.n, console.log); save(res); }
  } else if (cmd === 'big') {
    const res = bigCommit(path.join(o.dir, o.repo), path.join(o.dir, '_work', `${o.repo}-big`)); save(res); console.log(res);
  } else if (cmd === 'adjudicate') {
    console.log(JSON.stringify(adjudicate(readJson(o.out)), null, 1));
  } else if (cmd === 'summary') {
    console.log(summarize(readJson(o.out), o.discover && readJson(o.discover)));
  } else { console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(2, 9).join('\n')); process.exit(2); }
}

if (require.main === module) main();
module.exports = { REPOS, isDoc, isCode, pickCommits, quantile, aggregate, renderTable, listCommits, discoverRepo, readCtx, summarize, adjudicate, verdictOf, measureCommit, measureRepo, bigCommit, discoverRepo };
