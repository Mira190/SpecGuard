// Requirement text is data. Preserve unavailable references instead of silently omitting them.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const sanitize = (s) => String(s || '').replace(/\r\n?/g, '\n').replace(/<!--[\s\S]*?-->/g, '')
  .replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g, '')
  .replace(/[\x00-\x08\x0B-\x1F\x7F]/g, '');

// Deliberately narrow: structured AC sections only. Narrative still needs model
// interpretation; this inventory is a lower bound, never a completeness claim.
function extractCriteria(documents) {
  const criteria = [];
  for (const { source, text } of documents) {
    let depth = 0, active = null, fenced = false, top = 0;
    for (const line of text.split(/\r\n?|\n/)) {
      if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; continue; }
      if (fenced) continue;
      const heading = /^(#{1,6})\s+(.+)$/.exec(line);
      if (heading) {
        if (/^(acceptance criteria|acceptance tests|验收标准|验收条件|AC)\s*[:：]?$/i.test(heading[2].trim())) depth = heading[1].length;
        else if (heading[1].length <= depth) depth = 0;
        active = null;
        continue;
      }
      const labelled = /^\s*AC\s*\d+\s*[:：]\s*(.+)$/i.exec(line);
      const indent = /^\s*/.exec(line)[0].length;
      // an item indented deeper than the current criterion is a sub-point of it (continuation below)
      const item = depth && !(active && indent > top) && /^\s*(?:[-*+]\s+(?:\[[ xX]\]\s*)?|\d+[.)]\s+)(.+)$/.exec(line);
      if (labelled || item) {
        top = indent;
        active = { id: `R${criteria.length + 1}`, source, quote: (labelled || item)[1].trim() };
        criteria.push(active);
      } else if (active && /^\s+\S/.test(line)) active.quote += '\n' + line.trim();
      else if (line.trim()) active = null;
    }
  }
  return criteria;
}

const DOC_EXT = /\.(md|mdx|markdown|rst|adoc|txt|feature)$/i;
const TEST_PATH = /(^|[/._-])(test|tests|spec|__tests__)([/._-]|$)/i;

const MAX_HUNKS = 50, MAX_SHAS = 20, MAX_HISTORY_DOCS = 3;

// LEFT line ranges of production hunks in a unified diff: [{path, a, b}] (inclusive). Pure insertions have no history.
// The (old) path comes from the "--- a/path" line, so a path containing " b/" or spaces parses correctly; quoted
// (C-escaped) paths are skipped. At most MAX_HUNKS ranges are returned.
function leftRanges(diff) {
  const out = [];
  let file = null, inHunk = false;
  for (const line of String(diff).split(/\r?\n/)) {
    if (out.length >= MAX_HUNKS) break;
    if (line.startsWith('diff --git ')) { file = null; inHunk = false; continue; }
    const f = !inHunk && /^--- (?:a\/)?(.*?)\t?$/.exec(line);
    if (f) { file = f[1] === '/dev/null' || f[1].startsWith('"') || DOC_EXT.test(f[1]) || TEST_PATH.test(f[1]) ? null : f[1]; continue; }
    const h = /^@@ -(\d+)(?:,(\d+))? \+/.exec(line);
    if (h) { inHunk = true; if (file) { const n = h[2] === undefined ? 1 : +h[2]; if (n > 0) out.push({ path: file, a: +h[1], b: +h[1] + n - 1 }); } }
  }
  return out;
}

// Top 3 blamed commits per hunk (by line count), merged by total lines. `blame(path, a, b)` returns porcelain text.
// opts.stats (optional) receives { failed, skipped }: hunks whose blame threw, and hunks not tried after opts.deadline (ms epoch).
function blameShas(diff, blame, opts = {}) {
  const total = new Map(), stats = opts.stats || {};
  stats.failed = 0; stats.skipped = 0;
  for (const { path: p, a, b } of leftRanges(diff)) {
    if (opts.deadline && Date.now() > opts.deadline) { stats.skipped++; continue; }
    const n = new Map();
    try { for (const m of String(blame(p, a, b)).matchAll(/^([0-9a-f]{40}) \d+ \d+/gm)) n.set(m[1], (n.get(m[1]) || 0) + 1); }
    catch { stats.failed++; continue; }
    for (const [sha, c] of [...n].sort((x, y) => y[1] - x[1]).slice(0, 3)) total.set(sha, (total.get(sha) || 0) + c);
  }
  return [...total].sort((x, y) => y[1] - x[1]).slice(0, MAX_SHAS).map(([sha]) => sha);
}

// Optional historical intent: blamed commit -> PR -> closing issues, at most 3 documents. Failures become limitations.
function collectHistory({ history, repo, mainPr, seen, loadIssue }) {
  const documents = [], limitations = [];
  if (!history) return { documents, limitations };
  if (history.error) return { documents, limitations: ['Historical intent unavailable: git blame failed.'] };
  if (history.partial) limitations.push(history.partial);
  const done = new Set();
  // history text is whatever a past author wrote: flagged low-trust so nothing downstream treats it as the approved requirement
  const add = (source, title, body) => { if (documents.length < MAX_HISTORY_DOCS) documents.push({ source, untrusted: true, text: sanitize(`${title || ''}\n${body || ''}`) }); };
  const sameRepo = (p) => String(p && p.base && p.base.repo && p.base.repo.full_name || '').toLowerCase() === repo.toLowerCase();
  for (const sha of (history.shas || []).slice(0, MAX_SHAS)) {
    if (documents.length >= MAX_HISTORY_DOCS) break;
    try {
      const pull = (history.pulls(sha) || []).find((p) => p && p.merged_at && sameRepo(p)); // merged, targeting this repository
      if (!pull || !pull.number || pull.number === mainPr || done.has(pull.number)) continue; // direct push, or already known
      done.add(pull.number);
      const pr = history.pr(pull.number);
      add(`history PR #${pull.number}`, pr.title, pr.body);
      for (const issue of pr.closingIssuesReferences || []) {
        const m = /github\.com\/([\w.-]+\/[\w.-]+)\/issues\/(\d+)/.exec(issue.url || '');
        const r = m ? m[1] : repo, n = m ? +m[2] : issue.number;
        if (r.toLowerCase() !== repo.toLowerCase()) continue; // history never reads another repository's issues
        const key = `${r.toLowerCase()}#${n}`;
        if (!n || done.has(key) || seen.has(key) || documents.length >= MAX_HISTORY_DOCS) continue;
        done.add(key);
        try { const i = loadIssue(r, n); add(r.toLowerCase() === repo.toLowerCase() ? `history issue #${n}` : `history issue ${r}#${n}`, i.title, i.body); }
        catch { limitations.push(`Could not read history issue ${key}.`); }
      }
    } catch { limitations.push(`Could not map commit ${String(sha).slice(0, 7)} to its pull request.`); }
  }
  return { documents, limitations };
}

function collectRequirements({ pr, repo, commits = '', loadIssue, history }) {
  const refs = new Map();
  const add = (r, n) => { if (!(r.toLowerCase() === repo.toLowerCase() && +n === pr.number)) refs.set(`${r.toLowerCase()}#${+n}`, { repo: r, number: +n }); };
  const url = /https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/issues\/(\d+)/g;
  for (const issue of pr.closingIssuesReferences || []) {
    const m = [...String(issue.url || '').matchAll(url)][0];
    if (m) add(m[1], m[2]);
    else if (issue.number) add(repo, issue.number);
  }
  const text = sanitize(`${pr.body || ''}\n${String(commits).split(/\r?\n/).filter((l) => !/^Merge (pull request #|branch)/.test(l)).join('\n')}`);
  for (const m of text.matchAll(url)) add(m[1], m[2]);
  const withoutUrls = text.replace(/https?:\/\/\S+/g, '');
  for (const m of withoutUrls.matchAll(/(?:\b([\w.-]+\/[\w.-]+)#|(?<![&\w])#)(\d+)\b/g)) add(m[1] || repo, m[2]);
  const limitations = [];
  const seen = new Set(refs.keys());
  const parts = [`# PR: ${sanitize(pr.title)}\n\n${sanitize(pr.body)}`];
  const sources = ['PR body'];
  const documents = [{ source: 'PR body', text: sanitize(`${pr.title || ''}\n${pr.body || ''}`) }];
  if (refs.size > 5) limitations.push(`${refs.size - 5} linked issue(s) omitted by the five-issue limit.`);
  for (const { repo: r, number } of [...refs.values()].slice(0, 5)) {
    const label = r.toLowerCase() === repo.toLowerCase() ? `issue #${number}` : `issue ${r}#${number}`;
    try {
      const issue = loadIssue(r, number);
      parts.push(`# ${label}: ${sanitize(issue.title)}\n\n${sanitize(issue.body)}`);
      sources.push(label);
      documents.push({ source: label, text: sanitize(`${issue.title || ''}\n${issue.body || ''}`) });
    } catch { limitations.push(`Could not read ${label}.`); }
  }
  if (!String(pr.body || '').trim() && sources.length === 1) limitations.push('No requirement text available; only changed behaviour can be assessed.');
  const criteria = extractCriteria(documents);
  const past = collectHistory({ history, repo, mainPr: pr.number, seen, loadIssue });
  limitations.push(...past.limitations);
  for (const { source, text: t } of past.documents) {
    documents.push({ source, text: t, untrusted: true });
    sources.push(source);
    for (const c of extractCriteria([{ source, text: t }])) criteria.push({ id: `H${criteria.filter((x) => x.optional).length + 1}`, source, quote: c.quote, optional: true });
  }
  return { text: parts.join('\n\n'), status: limitations.length ? 'partial' : 'available', sources, limitations, documents, criteria };
}

if (require.main === module) {
  const env = process.env;
  const gh = (args) => JSON.parse(execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000 }));
  let result;
  try {
    const pr = gh(['pr', 'view', env.PR_NUMBER, '--repo', env.GH_REPO, '--json', 'number,title,body,closingIssuesReferences']);
    const commits = execFileSync('git', ['log', `${env.BASE_SHA}..${env.HEAD_SHA}`, '--format=%B'], { encoding: 'utf8' });
    let history;
    try {
      const diff = fs.readFileSync(path.join(env.CTX, 'diff.patch'), 'utf8');
      const stats = {};
      const shas = blameShas(diff, (p, a, b) => execFileSync('git', ['blame', '-w', '-M', '-C', '--porcelain', env.BASE_SHA, '-L', `${a},${b}`, '--', p], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 << 20, timeout: 10000 }),
        { stats, deadline: Date.now() + 25000 });
      if (stats.failed && !shas.length) throw new Error('git blame failed for every hunk');
      history = { shas, partial: stats.failed || stats.skipped ? `Historical intent is partial: git blame failed for ${stats.failed} and was skipped for ${stats.skipped} hunk(s).` : '', pulls: (sha) => gh(['api', `repos/${env.GH_REPO}/commits/${sha}/pulls`]),
        pr: (n) => gh(['pr', 'view', String(n), '--repo', env.GH_REPO, '--json', 'number,title,body,closingIssuesReferences']) };
    } catch { history = { error: true }; }
    result = collectRequirements({ pr, repo: env.GH_REPO, commits, history,
      loadIssue: (repo, n) => gh(['issue', 'view', String(n), '--repo', repo, '--json', 'title,body']) });
  } catch {
    result = { text: 'none', status: 'unavailable', sources: [], limitations: ['PR requirements could not be loaded; review is limited to changed behaviour.'], documents: [], criteria: [] };
  }
  fs.writeFileSync(path.join(env.CTX, 'requirements.md'), result.text + '\n');
  const { text, ...status } = result;
  fs.writeFileSync(path.join(env.CTX, 'requirements-status.json'), JSON.stringify(status, null, 2) + '\n');
}

module.exports = { collectRequirements, extractCriteria, leftRanges, blameShas };
