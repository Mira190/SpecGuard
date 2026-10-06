// Requirement text is data. Preserve unavailable references instead of silently omitting them.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const sanitize = (s) => String(s || '').replace(/<!--[\s\S]*?-->/g, '')
  .replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g, '')
  .replace(/[\x00-\x08\x0B-\x1F\x7F]/g, '');

// Deliberately narrow: structured AC sections only. Narrative still needs model
// interpretation; this inventory is a lower bound, never a completeness claim.
function extractCriteria(documents) {
  const criteria = [];
  for (const { source, text } of documents) {
    let depth = 0, active = null, fenced = false;
    for (const line of text.split(/\r?\n/)) {
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
      const item = depth && /^\s*(?:[-*+]\s+(?:\[[ xX]\]\s*)?|\d+[.)]\s+)(.+)$/.exec(line);
      if (labelled || item) {
        active = { id: `R${criteria.length + 1}`, source, quote: (labelled || item)[1].trim() };
        criteria.push(active);
      } else if (active && /^\s+\S/.test(line)) active.quote += '\n' + line.trim();
      else if (line.trim()) active = null;
    }
  }
  return criteria;
}

function collectRequirements({ pr, repo, commits = '', loadIssue }) {
  const refs = new Map();
  const add = (r, n) => { if (!(r.toLowerCase() === repo.toLowerCase() && +n === pr.number)) refs.set(`${r.toLowerCase()}#${+n}`, { repo: r, number: +n }); };
  const url = /https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/issues\/(\d+)/g;
  for (const issue of pr.closingIssuesReferences || []) {
    const m = [...String(issue.url || '').matchAll(url)][0];
    if (m) add(m[1], m[2]);
    else if (issue.number) add(repo, issue.number);
  }
  const text = sanitize(`${pr.body || ''}\n${commits}`);
  for (const m of text.matchAll(url)) add(m[1], m[2]);
  const withoutUrls = text.replace(/https?:\/\/\S+/g, '');
  for (const m of withoutUrls.matchAll(/(?:\b([\w.-]+\/[\w.-]+))?#(\d+)\b/g)) add(m[1] || repo, m[2]);
  const limitations = [];
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
  return { text: parts.join('\n\n'), status: limitations.length ? 'partial' : 'available', sources, limitations, documents, criteria: extractCriteria(documents) };
}

if (require.main === module) {
  const env = process.env;
  const gh = (args) => JSON.parse(execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  let result;
  try {
    const pr = gh(['pr', 'view', env.PR_NUMBER, '--repo', env.GH_REPO, '--json', 'number,title,body,closingIssuesReferences']);
    const commits = execFileSync('git', ['log', `${env.BASE_SHA}..${env.HEAD_SHA}`, '--format=%B'], { encoding: 'utf8' });
    result = collectRequirements({ pr, repo: env.GH_REPO, commits,
      loadIssue: (repo, n) => gh(['issue', 'view', String(n), '--repo', repo, '--json', 'title,body']) });
  } catch {
    result = { text: 'none', status: 'unavailable', sources: [], limitations: ['PR requirements could not be loaded; review is limited to changed behaviour.'], documents: [], criteria: [] };
  }
  fs.writeFileSync(path.join(env.CTX, 'requirements.md'), result.text + '\n');
  const { text, ...status } = result;
  fs.writeFileSync(path.join(env.CTX, 'requirements-status.json'), JSON.stringify(status, null, 2) + '\n');
}

module.exports = { collectRequirements, extractCriteria };
