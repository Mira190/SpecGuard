#!/usr/bin/env node
// SZZ mining (docs/traceability-plan.md 7.4.3). Deterministic given a git repo (plus optional `gh` lookups, injectable).
// mine(): fix candidates by independent signals (none needs an issue link) -> deleted/modified production lines -> git blame -w -M -C
// at the fix's parent -> filters -> introducing commits mapped to PRs -> manifest with the human fields left null.
// cleanSample(): seeded random non-fix, PR-sized commits from the same window (noise baseline).
// Usage: node eval/szz.js --help
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const MASS = 50; // commits touching more files than this are mass changes (formatting, renames, vendoring)
const SHA = /^[0-9a-f]{40}$/;
const DOCS = /(\.(md|mdx|markdown|rst|adoc|txt)$|(^|\/)(docs?|documentation|examples?)\/|(^|\/)(CHANGELOG|LICENSE|README)[^/]*$|(^|\/)package-lock\.json$|(^|\/)(yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|go\.sum)$)/i;
const TESTS = /((^|\/)(tests?|__tests__|specs?|testdata|fixtures|__snapshots__)\/|\.(test|spec)\.[\w]+$|(^|\/)test_[^/]*\.py$|_test\.(go|py|rs|rb)$|Tests?\.(java|kt|cs|swift)$|(^|\/)conftest\.py$)/i;
const isProd = (p) => !DOCS.test(p) && !TESTS.test(p);
const isCommentLine = (l) => /^\s*(\/\/|#|\*|\/\*|--|<!--|""")/.test(l);
const FIX_PREFIX = /^(fix|bugfix|hotfix|bug|regression)(\([^)]*\))?!?(:|\s|$)/i;
const KEYWORD = /\b(fix(es|ed)?|bug|regression|broken|incorrect)\b/i;
const FEATURE = /\b(add|adds|added|support|implement|introduce|feature|refactor|bump|update|upgrade)\b/i;
const BRANCH = /\b(?:fix|bugfix|hotfix)\//i;
const DEFAULT_LABELS = ['bug', 'fix', 'hotfix', 'regression'];

const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 28 });
const tryGit = (cwd, ...a) => { try { return git(cwd, ...a); } catch { return ''; } };

function defaultGh(args) { return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }

// ---- commits -------------------------------------------------------------------------------------------------
function listCommits(repoDir, since, until) {
  const range = ['--since', since, ...(until ? ['--until', until] : [])];
  const raw = git(repoDir, 'log', ...range, '--format=%H%x1f%P%x1f%cI%x1f%s%x1f%b%x1e');
  return raw.split('\x1e').map((r) => r.replace(/^\n/, '')).filter(Boolean).map((r) => {
    const [sha, parents, date, subject, body] = r.split('\x1f');
    return { sha, parents: parents ? parents.split(' ') : [], date, subject, body: (body || '').trim() };
  });
}

const commitInfo = (repoDir, sha) => {
  const [date, subject] = tryGit(repoDir, 'log', '-1', '--format=%cI%x1f%s', sha).trim().split('\x1f');
  return { sha, date, subject: subject || '' };
};

// PR number from the message alone: squash "(#N)" or "Merge pull request #N". Null when absent.
function prFromMessage(subject) {
  const m = /\(#(\d+)\)\s*$/.exec(subject) || /^Merge pull request #(\d+)\b/.exec(subject);
  return m ? +m[1] : null;
}

// ---- signals -------------------------------------------------------------------------------------------------
// Returns { signals: [{signal, strength, ...}], revertOf }. Issue-label signals are added later (they need gh).
function messageSignals(c) {
  const signals = [];
  let revertOf = null;
  const rv = /This reverts commit ([0-9a-f]{40})/.exec(c.body);
  if (/^Revert "/.test(c.subject) || rv) {
    signals.push({ signal: 'revert', strength: 'strongest' });
    revertOf = rv ? rv[1] : null;
  }
  if (FIX_PREFIX.test(c.subject)) signals.push({ signal: 'title_prefix', strength: 'medium' });
  if (BRANCH.test(c.subject) || BRANCH.test(c.body.split('\n')[0] || '')) signals.push({ signal: 'branch', strength: 'medium' });
  if (!signals.length && KEYWORD.test(c.subject) && !FEATURE.test(c.subject)) signals.push({ signal: 'keyword', strength: 'weak' });
  return { signals, revertOf };
}

// Linked issues/PRs named in the message that carry a bug label (gh required). Returns { signals, issue } where issue is the earliest report.
function labelSignals(c, { gh, repo, labels }) {
  const out = { signals: [], issue: null };
  if (!gh || !repo) return out;
  const nums = [...new Set([...`${c.subject}\n${c.body}`.matchAll(/(?<![\w/])#(\d+)\b/g)].map((m) => +m[1]))].slice(0, 5);
  for (const n of nums) {
    let j;
    try { j = JSON.parse(gh(['api', `repos/${repo}/issues/${n}`])); } catch { continue; }
    const names = (j.labels || []).map((l) => String(l.name || l).toLowerCase());
    const hit = labels.filter((l) => names.some((x) => x === l || x.includes(l)));
    if (!hit.length) continue;
    const isPr = !!j.pull_request;
    out.signals.push({ signal: isPr ? 'pr_label' : 'issue_label', strength: isPr ? 'medium' : 'strong', number: n, labels: hit });
    if (!isPr && j.created_at && (!out.issue || j.created_at < out.issue.created_at)) out.issue = { number: n, created_at: j.created_at, labels: names };
  }
  return out;
}

// ---- diff + blame --------------------------------------------------------------------------------------------
// Per production file: old-side line numbers deleted or modified (whitespace-only changes ignored by -w, comment/blank lines dropped).
function fixLines(repoDir, parent, sha) {
  const raw = git(repoDir, 'diff', '-U0', '-w', '-M', '--no-color', parent, sha);
  const files = [];
  let cur = null, old = 0;
  for (const l of raw.split('\n')) {
    if (l.startsWith('diff --git ')) { cur = null; continue; }
    if (l.startsWith('--- ')) { const p = l.slice(4).replace(/^a\//, ''); cur = p === '/dev/null' ? null : { path: p, lines: [], addOnly: true }; continue; }
    if (l.startsWith('+++ ')) { if (cur) { const np = l.slice(4).replace(/^b\//, ''); cur.newPath = np === '/dev/null' ? cur.path : np; if (isProd(cur.path) && isProd(cur.newPath)) files.push(cur); else cur = null; } continue; }
    const h = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(l);
    if (h) { old = +h[1]; continue; }
    if (cur && l.startsWith('-')) {
      if (l.trim() !== '-' && !isCommentLine(l.slice(1))) { cur.lines.push(old); cur.addOnly = false; }
      old++;
    }
  }
  return files.map(({ path: p, lines, addOnly }) => ({ path: p, lines, addOnly }));
}

// Contiguous ranges [a,b] from sorted line numbers.
const ranges = (ls) => ls.reduce((r, n) => { const t = r[r.length - 1]; if (t && n === t[1] + 1) t[1] = n; else r.push([n, n]); return r; }, []);

// { sha: lineCount } of the commits that last touched the given lines at `parent`. `spots` (optional) is filled with { sha: [{ path, line }] }:
// each blamed line's path and line number in the introducing commit, for matching a PR-time finding to the buggy lines (eval/escapes.js).
// ponytail: porcelain names the file once per commit, so a commit that also contributed lines from a copied file is attributed to the first one.
function blame(repoDir, parent, file, spots) {
  if (!file.lines.length) return {};
  const args = ['blame', '-w', '-M', '-C', '--porcelain', ...ranges(file.lines).flatMap(([a, b]) => ['-L', `${a},${b}`]), parent, '--', file.path];
  const raw = tryGit(repoDir, ...args), out = {};
  let at = null;
  for (const l of raw.split('\n')) {
    const m = /^([0-9a-f]{40}) (\d+) \d+/.exec(l);
    if (m) { out[m[1]] = (out[m[1]] || 0) + 1; at = m[1]; if (spots) (spots[at] ||= []).push({ path: file.path, line: +m[2], named: false }); }
    else if (at && spots && l.startsWith('filename ')) for (const x of spots[at]) if (!x.named) Object.assign(x, { path: l.slice(9), named: true });
  }
  return out;
}

const filesTouched = (repoDir, sha) => tryGit(repoDir, 'show', '--name-only', '--format=', sha).split('\n').filter(Boolean);

// ---- mine ------------------------------------------------------------------------------------------------------
const CONTAMINATION = 'Public repo: the model may have seen the later fix in its training data. Report public and private pilots separately; prefer fixes from the last ~4 months.';

function mine({ repoDir, since, until, labels = DEFAULT_LABELS, repo = null, gh = null, labelScan = false, max = Infinity, now = new Date() }) {
  if (!repoDir || !since) throw new Error('repoDir and since are required');
  const commits = listCommits(repoDir, since, until);
  const bySha = new Map(commits.map((c) => [c.sha, c]));
  const claimed = new Set(); // commits already covered by a candidate merge commit
  const stats = { commits: commits.length, candidates: 0, signals: {}, excluded_docs_tests: 0, located: 0, unlocatable: 0, no_introducing: 0, revert_direct: 0, introducing_pairs: 0, pairs_with_pr: 0 };
  const resolvePr = (sha, subject) => {
    const n = prFromMessage(subject);
    if (n) return n;
    if (!gh || !repo) return null;
    try { const j = JSON.parse(gh(['api', `repos/${repo}/commits/${sha}/pulls`])); return j[0]?.number ?? null; } catch { return null; }
  };
  const candidates = [];
  for (const c of commits) { // newest first
    if (candidates.length >= max) break;
    if (claimed.has(c.sha) || !c.parents.length) continue;
    let { signals, revertOf } = messageSignals(c);
    let issue = null;
    if (gh && repo && (signals.length || labelScan)) {
      const ls = labelSignals(c, { gh, repo, labels });
      signals = signals.concat(ls.signals); issue = ls.issue;
    }
    if (!signals.length) continue;
    const parent = c.parents[0];
    if (c.parents.length > 1) for (const s of tryGit(repoDir, 'rev-list', `${parent}..${c.parents[1]}`).split('\n').filter(Boolean)) claimed.add(s);
    const changed = tryGit(repoDir, 'diff', '--name-only', parent, c.sha).split('\n').filter(Boolean);
    if (!changed.some(isProd)) { stats.excluded_docs_tests++; continue; }
    const cand = { fix: { sha: c.sha, parent, title: c.subject, date: c.date, pr: resolvePr(c.sha, c.subject) }, signals, issue: issue && { number: issue.number, created_at: issue.created_at },
      report_date: issue?.created_at || c.date, report_date_source: issue ? 'issue' : 'fix_commit_upper_bound', status: 'located', introducing: [] };
    stats.candidates++;
    for (const s of new Set(signals.map((x) => x.signal))) stats.signals[s] = (stats.signals[s] || 0) + 1;

    const reportMs = Date.parse(cand.report_date);
    const add = (sha, lines, via, spots) => {
      const info = commitInfo(repoDir, sha);
      if (Date.parse(info.date) > reportMs) return 'after_report';
      if (filesTouched(repoDir, sha).length > MASS) return 'mass_change';
      cand.introducing.push({ sha, title: info.subject, date: info.date, pr: resolvePr(sha, info.subject), lines, via, ...(spots && { spots: spots.slice(0, 50).map(({ path: p, line }) => ({ path: p, line })) }), confirmed: null, scope: null, grade: null, note: null });
      return '';
    };
    const dropped = {};
    if (revertOf && SHA.test(revertOf)) {
      const why = add(revertOf, null, 'revert');
      if (why) dropped[why] = 1; else stats.revert_direct++;
    } else {
      const tally = {}, spots = {};
      let any = false;
      for (const f of fixLines(repoDir, parent, c.sha)) {
        if (f.lines.length) any = true;
        for (const [sha, n] of Object.entries(blame(repoDir, parent, f, spots))) tally[sha] = (tally[sha] || 0) + n;
      }
      if (!any) cand.status = 'unlocatable';
      for (const [sha, n] of Object.entries(tally).sort((a, b) => b[1] - a[1]).slice(0, 5)) {
        if (sha === c.sha) continue;
        const why = add(sha, n, 'blame', spots[sha]);
        if (why) dropped[why] = (dropped[why] || 0) + 1;
      }
    }
    if (Object.keys(dropped).length) cand.dropped = dropped;
    if (cand.status === 'located' && !cand.introducing.length) { cand.status = 'no_introducing'; }
    if (cand.status === 'unlocatable') stats.unlocatable++;
    else if (cand.status === 'no_introducing') stats.no_introducing++;
    else stats.located++;
    for (const i of cand.introducing) { stats.introducing_pairs++; if (i.pr) stats.pairs_with_pr++; }
    cand.confirmed = null; cand.scope = null; cand.grade = null; // fix-level human fields; pair-level ones live on each introducing entry
    candidates.push(cand);
  }
  return { repo: repo || path.basename(path.resolve(repoDir)), window: { since, until: until || null }, generated: now.toISOString(), contamination: CONTAMINATION, stats, candidates };
}

// ---- clean sample ----------------------------------------------------------------------------------------------
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// n random non-fix, PR-sized commits (1-20 files incl. production, 5-500 changed lines) from the window. `exclude` = shas to skip (fixes, introducing).
function cleanSample({ repoDir, n, seed = 1, window, exclude = [] }) {
  const skip = new Set(exclude), rand = mulberry32(seed);
  const pool = listCommits(repoDir, window.since, window.until).filter((c) => c.parents.length === 1 && !skip.has(c.sha) && !messageSignals(c).signals.length);
  for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
  const out = [];
  for (const c of pool) {
    if (out.length >= n) break;
    const stat = git(repoDir, 'show', '--numstat', '--format=', c.sha).split('\n').filter(Boolean).map((l) => l.split('\t'));
    const files = stat.map((s) => s[2]), lines = stat.reduce((t, s) => t + (+s[0] || 0) + (+s[1] || 0), 0);
    if (files.length < 1 || files.length > 20 || lines < 5 || lines > 500 || !files.some(isProd)) continue;
    out.push({ sha: c.sha, parent: c.parents[0], title: c.subject, date: c.date, pr: prFromMessage(c.subject), files: files.length, lines });
  }
  return out;
}

// ---- CLI -------------------------------------------------------------------------------------------------------
const USAGE = `Usage:
  node eval/szz.js mine  --repo DIR --since DATE [--until DATE] [--gh-repo owner/name] [--label-scan] [--max N] --out FILE.json
  node eval/szz.js clean --repo DIR --since DATE [--until DATE] --n N [--seed S] [--manifest FILE.json] --out FILE.json
mine needs no issue link; --gh-repo enables bug-label signals and commit->PR lookup through gh.`;

function main() {
  const { values: o, positionals } = require('node:util').parseArgs({ allowPositionals: true, options: {
    repo: { type: 'string' }, since: { type: 'string' }, until: { type: 'string' }, 'gh-repo': { type: 'string' }, 'label-scan': { type: 'boolean' },
    max: { type: 'string' }, n: { type: 'string' }, seed: { type: 'string', default: '1' }, manifest: { type: 'string' }, out: { type: 'string' }, help: { type: 'boolean' } } });
  const [cmd] = positionals;
  if (o.help || !['mine', 'clean'].includes(cmd) || !o.repo || !o.since || !o.out) { console.log(USAGE); process.exit(o.help ? 0 : 2); }
  let result;
  if (cmd === 'mine') {
    result = mine({ repoDir: o.repo, since: o.since, until: o.until, repo: o['gh-repo'], gh: o['gh-repo'] ? defaultGh : null, labelScan: !!o['label-scan'], max: o.max ? +o.max : Infinity });
    console.log(JSON.stringify(result.stats, null, 2));
  } else {
    const exclude = o.manifest ? JSON.parse(fs.readFileSync(o.manifest, 'utf8')).candidates.flatMap((c) => [c.fix.sha, ...c.introducing.map((i) => i.sha)]) : [];
    result = cleanSample({ repoDir: o.repo, n: +o.n, seed: +o.seed, window: { since: o.since, until: o.until }, exclude });
    console.log(`${result.length} clean commits`);
  }
  fs.writeFileSync(o.out, JSON.stringify(result, null, 2) + '\n');
}

if (require.main === module) main();
module.exports = { isProd, isCommentLine, prFromMessage, messageSignals, labelSignals, fixLines, ranges, blame, listCommits, mine, mulberry32, cleanSample, MASS, CONTAMINATION };
