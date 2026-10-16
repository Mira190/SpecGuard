// Requirement text is data. Preserve unavailable references instead of silently omitting them.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// Same invisible-character set as post.js neutralize (kept in sync by a test; not imported: post.js drags the whole posting pipeline into a collection step).
const INVISIBLE = /[\u0000-\u0008\u000B-\u001F\u007F\u00AD\u034F\u115F\u1160\u17B4\u17B5\u180B-\u180F\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\u2800\u3164\uFE00-\uFE0F\uFEFF\uFFA0\u{E0000}-\u{E007F}\u{E0100}-\u{E01EF}]/gu;
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
// Entities are decoded first, so text hidden as '&#8203;' or '&lt;!-- x --&gt;' is stripped like its plain form (one pass: '&amp;lt;' stays a literal '&lt;').
const decode = (s) => s.replace(/&(?:#(\d{1,7})|#x([0-9a-f]{1,6})|(amp|lt|gt|quot|apos|nbsp));/gi, (m, d, h, n) => {
  if (n) return ENTITIES[n.toLowerCase()];
  const c = d ? +d : parseInt(h, 16);
  return c <= 0x10FFFF ? String.fromCodePoint(c) : '';
});
const HIDING = String.raw`display\s*:\s*none|visibility\s*:\s*hidden`;
const HIDDEN_EL = new RegExp(String.raw`<([a-z][a-z0-9]*)\b[^>]*?(?:\shidden\b|\sstyle\s*=\s*(?:"[^"]*(?:${HIDING})[^"]*"|'[^']*(?:${HIDING})[^']*'))[^>]*>[\s\S]*?</\1\s*>`, 'gi'); // ponytail: not nested-aware
const HIDDEN_ATTR = /(<[a-z][^>]*?)\s+(?:alt|title|aria-[\w-]+|data-[\w-]+|placeholder)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi;
const sanitize = (s) => {
  let t = decode(String(s || '').replace(/\r\n?/g, '\n')).replace(INVISIBLE, '');
  for (let prev; prev !== t;) { prev = t; t = t.replace(/<!--[\s\S]*?-->/g, '').replace(HIDDEN_EL, '').replace(HIDDEN_ATTR, '$1'); }
  return t.replace(/<!--[\s\S]*$/, '')
    .replace(/!\[[^\]]*\](?=[(\[])/g, '![]') // image alt text
    .replace(/(\]\(\s*<?[^\s)]+>?)\s+(?:"[^"]*"|'[^']*')\s*\)/g, '$1)'); // link and image titles
};

// A labelled criterion line: "AC 1:", "AC1:", "AC-1:", "AC.1:", "AC_1:" (never "ACME-1:"). One regex for the inventory and the body cut.
const AC_LINE = /^\s*AC[\s._-]*\d+\s*[:：]/i;
const AC_HEAD = /^(acceptance criteria|acceptance tests|验收标准|验收条件|AC)\s*[:：]?$/i;
// The same words (plus "definition of done" and "requirements") as a plain line: "Acceptance criteria:", "**Acceptance criteria**", "AC:".
const PLAIN_HEAD = /^\s{0,3}(?:\*\*|__|\*|_)?\s*(?:acceptance criteria|acceptance tests|验收标准|验收条件|AC|definition of done|requirements)\s*[:：]?\s*(?:\*\*|__|\*|_)?\s*[:：]?\s*$/i;
const LIST_ITEM = /^\s*(?:[-*+]\s+(?:\[[ xX]\]\s*)?|\d+[.)]\s+)(.+)$/;
// Per line: is it inside an acceptance-criteria section (the header line included)? A section starts at an AC heading (it runs until a heading of the same or
// a higher level) or at a plain AC line (it runs until a heading, or a blank line followed by a line that is not a list item). Fenced code never changes it.
function acMask(lines) {
  let depth = 0, plain = false, blank = false, fenced = false;
  return lines.map((line) => {
    if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; return depth > 0 || plain; }
    if (fenced) return depth > 0 || plain;
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) {
      plain = false; blank = false;
      if (AC_HEAD.test(heading[2].trim())) depth = heading[1].length;
      else if (heading[1].length <= depth) depth = 0;
      return depth > 0;
    }
    if (!line.trim()) { blank = true; return depth > 0 || plain; }
    if (PLAIN_HEAD.test(line)) { plain = true; blank = false; return true; }
    if (plain && blank && !LIST_ITEM.test(line)) plain = false;
    blank = false;
    return depth > 0 || plain;
  });
}
// Deliberately narrow: structured AC sections only. Narrative still needs model
// interpretation; this inventory is a lower bound, never a completeness claim.
function extractCriteria(documents) {
  const criteria = [];
  for (const { source, text } of documents) {
    let active = null, fenced = false, top = 0;
    const lines = text.split(/\r\n?|\n/), inAc = acMask(lines);
    lines.forEach((line, i) => {
      if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; return; }
      if (fenced) return;
      if (/^#{1,6}\s+\S/.test(line) || PLAIN_HEAD.test(line)) { active = null; return; }
      const labelled = new RegExp(`${AC_LINE.source}\\s*(.+)$`, 'i').exec(line);
      const indent = /^\s*/.exec(line)[0].length;
      // an item indented deeper than the current criterion is a sub-point of it (continuation below)
      const item = inAc[i] && !(active && indent > top) && LIST_ITEM.exec(line);
      if (labelled || item) {
        top = indent;
        active = { id: `R${criteria.length + 1}`, source, quote: (labelled || item)[1].trim() };
        criteria.push(active);
      } else if (active && /^\s+\S/.test(line)) active.quote += '\n' + line.trim();
      else if (line.trim()) active = null;
    });
  }
  return criteria;
}

const DOC_EXT = /\.(md|mdx|markdown|rst|adoc|txt|feature)$/i;
const TEST_PATH = { test: (p) => /(^|[/._-])(test|tests|spec|__tests__)([/._-]|$)/i.test(p) || /[a-z0-9](Tests?|Spec)\.[^/]*$/.test(p) }; // same rule as trace.isTestPath (not imported: trace pulls in post.js)

// Limitation kinds live in limitations.js (a FACT is a note, a GAP makes the run incomplete); every limitation emitted below goes through fact() or gap().
// A test scans this file for a bare push. Kept out of post.js's import chain: the collector stubs this file in tests.
const { isFactLimitation } = require('./limitations');
const fact = (s) => s, gap = (s) => s; // ponytail: markers only; the kind lives in limitations.js (strings must stay plain text in requirements-status.json)

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

// Diff hunks are three-dot, so their left line numbers belong to the merge-base (DIFF_BASE_SHA), never to a later BASE_SHA tip.
const blameAt = (rev, cwd = '.') => (p, a, b) => execFileSync('git', ['blame', '-w', '-M', '-C', '--porcelain', rev, '-L', `${a},${b}`, '--', p], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 << 20, timeout: 10000 });

const otherRepo = (r, n) => `Not read: other-repo reference ${r}#${n} (only issues of this repository are read)`;

// Optional historical intent: blamed commit -> PR -> closing issues, at most 3 documents. Failures become limitations.
function collectHistory({ history, repo, mainPr, seen, loadIssue }) {
  const documents = [], limitations = [];
  if (!history) return { documents, limitations };
  if (history.error) return { documents, limitations: [gap('Historical intent unavailable: git blame failed.')] };
  if (history.partial) limitations.push(gap(history.partial));
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
        if (r.toLowerCase() !== repo.toLowerCase()) { if (n) limitations.push(fact(otherRepo(r, n))); continue; } // history never reads another repository's issues
        const key = `${r.toLowerCase()}#${n}`;
        if (!n || done.has(key) || seen.has(key) || documents.length >= MAX_HISTORY_DOCS) continue;
        done.add(key);
        try { const i = loadIssue(r, n); add(r.toLowerCase() === repo.toLowerCase() ? `history issue #${n}` : `history issue ${r}#${n}`, i.title, i.body); }
        catch { limitations.push(fact(`Could not read history issue ${key}.`)); }
      }
    } catch { limitations.push(gap(`Could not map commit ${String(sha).slice(0, 7)} to its pull request.`)); }
  }
  return { documents, limitations };
}

// Same-repo issue numbers in a head branch name, from explicit markers only: issue-N, issues/N, gh-N anywhere, or N- at the very start (123-fix-bug).
// Never a bare number after a slash (feat/3-column-layout, fix/404-page, release/2024-summer), dates or versions (2024-01-x, 1-2-x), Jira keys (PROJ-123-x).
function branchIssues(ref) {
  const out = new Set();
  for (const m of String(ref || '').matchAll(/(?:^(?=[1-9]\d{0,5}-)|(?<![a-z0-9])(?:issues?[-_/]|gh[-_]))([1-9]\d{0,5})(?![a-z0-9])(?![-_]\d)/gi)) out.add(+m[1]);
  return [...out];
}

// ---- external trackers: named in a limitation, never fetched (no secrets, no network beyond gh)
// First segment of a would-be key that is really a standard, format or branch word: SHA-256, UTF-8, ISO-8601, CVE-2024-1, issue-45, fix-12.
const NOT_TRACKER_KEY = /^(?:UTF|UCS|SHA|MD|ISO|RFC|CVE|CWE|CVSS|HTTP|HTTPS|IPV|TLS|SSL|AES|RSA|HS|RS|ES|ECMA|CRC|PEP|HTML|CSS|XML|MP|SQL|GPT|COVID|JSON|WPA|IEEE|ANSI|WCAG|ASCII|BASE|POSIX|OAUTH|PDF|ISSUE|ISSUES|GH|PR|PRS|BUG|FIX|FEAT|FEATURE|HOTFIX|RELEASE|VERSION|STEP|PHASE|PART|TASK|TODO|WIP|TEST|CHORE|DOCS|SPRINT|WEEK|DAY)$/i;
const TAIL = String.raw`[^\s)>\]"'<]*`;
// [pattern, tracker, group 1 is the ticket key]
const TRACKER_URLS = [
  [/https?:\/\/[\w.-]+\.atlassian\.net\/browse\/([A-Z][A-Z0-9]+-\d+)/gi, 'Jira', true],
  [new RegExp(String.raw`https?://[\w.-]+\.atlassian\.net/wiki/${TAIL}`, 'gi'), 'Confluence'],
  [/https?:\/\/linear\.app\/[\w.-]+\/issue\/([A-Z][A-Z0-9]+-\d+)/gi, 'Linear', true],
  [new RegExp(String.raw`https?://(?:dev\.azure\.com|[\w.-]+\.visualstudio\.com)/${TAIL}/_workitems${TAIL}`, 'gi'), 'Azure Boards'],
  [new RegExp(String.raw`https?://(?:[\w-]+\.)?notion\.(?:so|site)/${TAIL}`, 'gi'), 'Notion'],
  [new RegExp(String.raw`https?://(?:www\.)?figma\.com/(?:file|design|proto|board|make)/${TAIL}`, 'gi'), 'Figma'],
  [new RegExp(String.raw`https?://docs\.google\.com/(?:document|spreadsheets|presentation|forms)/d/${TAIL}`, 'gi'), 'Google Docs'],
];
const MAX_TRACKER_REFS = 10;
// Distinct external references as "KEY-1 (Jira)" strings. URLs are searched in every text; a bare KEY-N only in the PR title (upper case) and the head
// branch (start of a path segment), where a hash, charset or version cannot be mistaken for a ticket. ponytail: a Linear key is also reported as Jira-style.
function trackerRefs({ title = '', branch = '', texts = [] }) {
  const out = new Map();
  const add = (id, tracker) => { if (!out.has(id.toLowerCase())) out.set(id.toLowerCase(), `${id} (${tracker})`); };
  for (const t of [title, ...texts]) for (const [re, tracker, key] of TRACKER_URLS) for (const m of String(t).matchAll(re)) add(key ? m[1].toUpperCase() : m[0].replace(/[?#].*$/, '').replace(/[.,;:!]+$/, '').slice(0, 100), tracker);
  const keys = [...String(title).matchAll(/(?<![\w/.-])([A-Z]{2}[A-Z0-9]{0,8}-[1-9]\d{0,6})(?!\w|\.\d)/g)].map((m) => m[1]);
  if (!/^(?:dependabot|renovate)\//i.test(branch)) keys.push(...[...String(branch).matchAll(/(?:^|\/)([a-z]{2}[a-z0-9]{0,8}-[1-9]\d{0,6})(?![a-z0-9]|\.\d)/gi)].map((m) => m[1]));
  for (const k of keys) if (!NOT_TRACKER_KEY.test(k.split('-')[0])) add(k.toUpperCase(), 'Jira-style key');
  const all = [...out.values()];
  return all.length > MAX_TRACKER_REFS ? [...all.slice(0, MAX_TRACKER_REFS), `${all.length - MAX_TRACKER_REFS} more`] : all;
}

const labelNames = (ls) => (ls || []).map((l) => sanitize(typeof l === 'string' ? l : l && l.name).replace(/\s+/g, ' ').trim().slice(0, 40)).filter(Boolean).slice(0, 10);

// Issue comments by people with write access (OWNER, COLLABORATOR), not minimised: the last five, newest kept when the cap bites.
// MEMBER is any organisation member, not write access, so it is not trusted here.
// `gh issue view --json comments` rows carry: author, authorAssociation, body, createdAt, id, isMinimized, minimizedReason, url (oldest first).
const TRUSTED = new Set(['OWNER', 'COLLABORATOR']);
const COMMENT_CAP = 1500, ISSUE_CAP = 3000;
function trustedComments(comments, cap = COMMENT_CAP) {
  const out = [];
  let room = cap;
  for (const c of (comments || []).filter((x) => x && TRUSTED.has(x.authorAssociation) && !x.isMinimized && typeof x.body === 'string').slice(-5).reverse()) {
    const t = sanitize(c.body).trim();
    if (!t || room <= 0) continue;
    const piece = t.length > room ? `${t.slice(0, room)}…` : t;
    out.unshift(piece); room -= piece.length;
  }
  return out.join('\n\n---\n\n');
}

// An issue body over `cap` keeps its acceptance-criteria sections and `AC n:` lines whole and fills the rest with the other lines in order.
function fitBody(body, cap = ISSUE_CAP) {
  if (body.length <= cap) return { text: body, cut: false };
  const lines = body.split('\n'), inAc = acMask(lines);
  const keep = lines.map((l, i) => inAc[i] || AC_LINE.test(l));
  let room = cap - lines.reduce((n, l, i) => n + (keep[i] ? l.length + 1 : 0), 0), cut = false;
  const out = [];
  lines.forEach((l, i) => {
    if (keep[i]) out.push(l);
    else if (room >= l.length + 1) { room -= l.length + 1; out.push(l); }
    else { if (!cut) out.push('[... cut]'); cut = true; room = -1; }
  });
  return { text: out.join('\n'), cut };
}

// GitHub closing keywords (close/fix/resolve + their -s/-d forms, optional colon) directly before an issue reference or URL.
const CLOSING = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b\s*:?\s+(?:https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/issues\/(\d+)|(?:([\w.-]+\/[\w.-]+)#|#)([1-9]\d{0,5})(?!\w))/gi;
const MAX_ISSUES = 5, MAX_OTHER_REPO_NOTES = 5;

function collectRequirements({ pr, repo, commits = '', loadIssue, history }) {
  const refs = new Map(), foreign = new Map(); // refs: issues of this repository, { closing }; foreign: other-repository references, named and never read
  const add = (r, n, closing = false) => {
    if (r.toLowerCase() === repo.toLowerCase() && +n === pr.number) return;
    const k = `${r.toLowerCase()}#${+n}`;
    if (r.toLowerCase() !== repo.toLowerCase()) { foreign.set(k, otherRepo(r, +n)); return; } // a PR author can name any repository: only this one is read
    refs.set(k, { repo: r, number: +n, closing: closing || !!refs.get(k)?.closing });
  };
  const url = /https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/issues\/(\d+)/g;
  for (const issue of pr.closingIssuesReferences || []) {
    const m = [...String(issue.url || '').matchAll(url)][0];
    if (m) add(m[1], m[2], true);
    else if (issue.number) add(repo, issue.number, true);
  }
  const text = sanitize(`${pr.title || ''}\n${pr.body || ''}\n${String(commits).split(/\r?\n/).filter((l) => !/^Merge (pull request #|branch)/.test(l)).join('\n')}`);
  for (const m of text.matchAll(CLOSING)) add(m[1] || m[3] || repo, m[2] || m[4], true); // only these give acceptance criteria; any other mention is context
  for (const m of text.matchAll(url)) add(m[1], m[2]);
  const withoutUrls = text.replace(/https?:\/\/\S+/g, '');
  // a plain integer, no leading zero, at most 6 digits, not followed by a word character: not #000000, #fff, #L12, #007, #12ab
  for (const m of withoutUrls.matchAll(/(?:\b([\w.-]+\/[\w.-]+)#|(?<![&\w])#)([1-9]\d{0,5})(?!\w)/g)) add(m[1] || repo, m[2]);
  const fromBranch = new Set();
  for (const n of branchIssues(pr.headRefName)) { if (n === pr.number) continue; const k = `${repo.toLowerCase()}#${n}`; if (!refs.has(k)) fromBranch.add(k); add(repo, n, true); }
  const limitations = [];
  const seen = new Set(refs.keys());
  const labels = {}, comments = [], scan = [sanitize(pr.title), sanitize(pr.body)];
  const prLabels = labelNames(pr.labels);
  if (prLabels.length) labels.PR = prLabels;
  const parts = [`# PR: ${sanitize(pr.title)}\n\n${sanitize(pr.body)}`];
  const sources = ['PR body'];
  const documents = [{ source: 'PR body', text: sanitize(`${pr.title || ''}\n${pr.body || ''}`) }];
  const context = []; // loaded but not closing: read as context, no criteria
  const all = [...refs.values()].sort((a, b) => b.closing - a.closing); // closing first, so the cap never cuts a closing issue for a mention (the sort is stable)
  const cutClosing = all.slice(MAX_ISSUES).filter((x) => x.closing).length, cutOther = all.length - MAX_ISSUES - cutClosing;
  if (cutClosing) limitations.push(gap(`${cutClosing} linked issue(s) omitted by the five-issue limit.`));
  if (cutOther > 0) limitations.push(fact(`Context trimmed: ${cutOther} mentioned issue(s) omitted by the five-issue limit (context only, not acceptance criteria).`));
  const fore = [...foreign.values()];
  for (const f of fore.slice(0, MAX_OTHER_REPO_NOTES)) limitations.push(fact(f));
  if (fore.length > MAX_OTHER_REPO_NOTES) limitations.push(fact(`Not read: other-repo reference ${fore.length - MAX_OTHER_REPO_NOTES} more (only issues of this repository are read)`));
  for (const { repo: r, number, closing } of all.slice(0, MAX_ISSUES)) {
    const label = `issue #${number}`, key = `${r.toLowerCase()}#${number}`;
    try {
      const issue = loadIssue(r, number);
      if (fromBranch.has(key) && issue.url && !issue.url.toLowerCase().startsWith(`https://github.com/${r.toLowerCase()}/issues/`)) throw new Error('not an issue of this repository'); // a branch-name guess is never a pull request
      const body = sanitize(issue.body), fit = fitBody(body); // criteria come from the whole body; only the prompt text is cut
      parts.push(`# ${label}${closing ? '' : ' (context only, not acceptance criteria)'}: ${sanitize(issue.title)}\n\n${fit.text}`);
      if (fit.cut) limitations.push(fact(`Context trimmed: ${label} body cut to about ${ISSUE_CAP / 1000} KB in requirements.md (acceptance criteria kept).`));
      const il = labelNames(issue.labels);
      if (il.length) labels[label] = il;
      scan.push(sanitize(issue.title), body);
      const cm = trustedComments(issue.comments);
      if (cm) { comments.push({ label, text: cm }); parts.push(`# ${label}: comments by maintainers (context only, not acceptance criteria)\n\n${cm}`); }
      sources.push(closing ? (fromBranch.has(key) ? `${label} (branch name)` : label) : `${label} (context)`);
      const doc = { source: closing ? label : `${label} (context)`, text: sanitize(`${issue.title || ''}\n${issue.body || ''}`) };
      if (closing) documents.push(doc); else context.push({ ...doc, untrusted: true });
    } catch { if (!fromBranch.has(key)) limitations.push(closing ? gap(`Could not read closing ${label}; its acceptance criteria were not reviewed.`) : fact(`Could not read ${label}.`)); } // a number guessed from the branch name may not be an issue; an unreadable closing issue lost requirement text (a gap, like the cap), a mention is only context (a fact)
  }
  for (const r of trackerRefs({ title: scan[0], branch: String(pr.headRefName || ''), texts: scan })) limitations.push(fact(`Referenced but not readable: ${r}. Paste the acceptance criteria into the PR body to have them reviewed.`));
  if (Object.keys(labels).length) parts.splice(1, 0, `Labels: ${Object.entries(labels).map(([k, v]) => `${k}: ${v.join(', ')}`).join('; ')}`);
  if (!String(pr.body || '').trim() && sources.length === 1) limitations.push(fact('No requirement text available; only changed behaviour can be assessed.'));
  const criteria = extractCriteria(documents);
  documents.push(...context); // context issues and maintainer comments are read, like history: no criteria are taken from them
  for (const { label, text: t } of comments) {
    documents.push({ source: `${label} comments`, text: t, untrusted: true });
    sources.push(`${label} comments`);
  }
  const past = collectHistory({ history, repo, mainPr: pr.number, seen, loadIssue });
  limitations.push(...past.limitations);
  for (const { source, text: t } of past.documents) {
    documents.push({ source, text: t, untrusted: true });
    sources.push(source);
    for (const c of extractCriteria([{ source, text: t }])) criteria.push({ id: `H${criteria.filter((x) => x.optional).length + 1}`, source, quote: c.quote, optional: true });
  }
  const lims = [...new Set(limitations)];
  return { text: parts.join('\n\n'), status: lims.length ? 'partial' : 'available', sources, limitations: lims, documents, criteria, branch: String(pr.headRefName || ''), labels };
}

if (require.main === module) {
  const env = process.env;
  const gh = (args) => JSON.parse(execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000, maxBuffer: 32 << 20 })); // a long thread's comments are large
  let result;
  try {
    const pr = gh(['pr', 'view', env.PR_NUMBER, '--repo', env.GH_REPO, '--json', 'number,title,body,closingIssuesReferences,headRefName,labels']);
    const commits = execFileSync('git', ['log', `${env.BASE_SHA}..${env.HEAD_SHA}`, '--format=%B'], { encoding: 'utf8' });
    let history;
    try {
      const diff = fs.readFileSync(path.join(env.CTX, 'diff.patch'), 'utf8');
      const stats = {};
      const shas = blameShas(diff, blameAt(env.DIFF_BASE_SHA || env.BASE_SHA), { stats, deadline: Date.now() + 25000 });
      if (stats.failed && !shas.length) throw new Error('git blame failed for every hunk');
      history = { shas, partial: stats.failed || stats.skipped ? `Historical intent is partial: git blame failed for ${stats.failed} and was skipped for ${stats.skipped} hunk(s).` : '', pulls: (sha) => gh(['api', `repos/${env.GH_REPO}/commits/${sha}/pulls`]),
        pr: (n) => gh(['pr', 'view', String(n), '--repo', env.GH_REPO, '--json', 'number,title,body,closingIssuesReferences']) };
    } catch { history = { error: true }; }
    const read = []; // every issue the model will read, with its version: preflight re-reviews when one of them changes (an edit or a new comment moves updatedAt)
    result = collectRequirements({ pr, repo: env.GH_REPO, commits, history,
      loadIssue: (repo, n) => {
        const view = (fields) => gh(['issue', 'view', String(n), '--repo', repo, '--json', fields]);
        let i; try { i = view('title,body,url,labels,comments,updatedAt'); } catch { i = view('title,body,url,updatedAt'); } // labels and comments are extras: never the reason an issue is unreadable
        if (i && i.updatedAt) read.push(`${repo}#${n} ${i.updatedAt}`);
        return i;
      } });
    try { fs.writeFileSync(path.join(env.CTX, 'pr-issues.txt'), [...new Set(read)].map((l) => `${l}\n`).join('')); } catch {}
    // the PR text the model reads, keyed only once collection succeeded: post records this key, not the (possibly stale) event payload; a failed write only falls back
    try { fs.writeFileSync(path.join(env.CTX, 'pr-req-key.txt'), require('./preflight').reqKey(pr)); } catch {}
  } catch {
    result = { text: 'none', status: 'unavailable', sources: [], limitations: [gap('PR requirements could not be loaded; review is limited to changed behaviour.')], documents: [], criteria: [] };
  }
  fs.writeFileSync(path.join(env.CTX, 'requirements.md'), result.text + '\n');
  const { text, ...status } = result;
  fs.writeFileSync(path.join(env.CTX, 'requirements-status.json'), JSON.stringify(status, null, 2) + '\n');
}

module.exports = { isFactLimitation, sanitize, trackerRefs, trustedComments, fitBody, branchIssues, collectRequirements, extractCriteria, leftRanges, blameShas, blameAt };
