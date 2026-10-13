#!/usr/bin/env node
// Manual run (.github/workflows/specguard-run.yml), step 1: turn the dispatch inputs into what the review needs. No network, no repo access.
// Env: REPO (owner/name or a github.com URL; a /pull/N URL also sets the PR), PR, REF, MODE (auto|pr|audit), DESIGN_DOCS, RULES_DOCS, TEST_DIRS (newline separated:
// repository paths, globs, or github.com blob/tree URLs of the SAME repository; a leading ! excludes). Writes repo, pr, ref, mode, design, rules, tests to $GITHUB_OUTPUT
// and fails with ::error:: on anything it cannot honour. A URL of another repository is rejected (simple choice: fetching it would need a second token scope and checkout).
const fs = require('node:fs');
const crypto = require('node:crypto');

const NOT_READABLE = 'is not readable from GitHub Actions; add the document to the repository or paste it';
const HOST = /^(www\.)?github\.com$/i;

function parseRepo(input) {
  const s = String(input || '').trim();
  if (!s) throw new Error('repo is required (owner/name or a github.com URL)');
  let owner, name, pr = '';
  const plain = /^([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9._-]+)$/.exec(s);
  if (plain) [, owner, name] = plain;
  else {
    let u;
    try { u = new URL(s); } catch { throw new Error(`repo must be owner/name or a github.com URL, got: ${s.slice(0, 100)}`); }
    if (!/^https?:$/.test(u.protocol) || !HOST.test(u.hostname)) throw new Error(`repo must be on github.com, got: ${u.hostname}`);
    const m = /^\/([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9._-]+?)(?:\.git)?(?:\/(.*))?$/.exec(u.pathname);
    if (!m) throw new Error(`repo URL has no owner/name: ${s.slice(0, 100)}`);
    [, owner, name] = m;
    pr = (/^pull\/(\d+)(?:\/|$)/.exec(m[3] || '') || [])[1] || '';
  }
  name = name.replace(/\.git$/, '');
  if (!name || name === '.' || name === '..') throw new Error(`invalid repository name: ${name}`);
  return { repo: `${owner}/${name}`, pr };
}

// One entry of a path list -> a repository-relative path or glob. A folder (no glob character, no file extension) or a tree URL becomes `dir/`, which the
// collectors read as "everything under it". `ref` (optional) lets a blob/tree URL whose branch name contains a slash be split correctly.
function resolveEntry(line, repo, ref = '') {
  let l = line.trim();
  const neg = l.startsWith('!') ? '!' : '';
  l = l.replace(/^!\s*/, '');
  if (/[\x00-\x1F\x7F]/.test(l)) throw new Error('a path contains a control character');
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(l)) {
    let u;
    try { u = new URL(l); } catch { throw new Error(`not a valid URL: ${l.slice(0, 100)}`); }
    if (!/^https?:$/.test(u.protocol) || !(HOST.test(u.hostname) || u.hostname === 'raw.githubusercontent.com')) throw new Error(`${l.slice(0, 120)} ${NOT_READABLE}`);
    const raw = u.hostname === 'raw.githubusercontent.com';
    const m = (raw ? /^\/([^/]+)\/([^/]+)\/(.+)$/ : /^\/([^/]+)\/([^/]+)\/(blob|tree)\/(.+)$/).exec(u.pathname);
    if (!m) throw new Error(`${l.slice(0, 120)} is a GitHub URL but not a file or folder link (expected github.com/OWNER/NAME/blob|tree/REF/PATH)`);
    const [owner, name] = [m[1], m[2].replace(/\.git$/, '')], kind = raw ? 'blob' : m[3], rest = decodeURIComponent(raw ? m[3] : m[4]);
    if (`${owner}/${name}`.toLowerCase() !== repo.toLowerCase()) throw new Error(`${l.slice(0, 120)} points into ${owner}/${name}, not the target repository ${repo}; other repositories are not supported yet (copy the document into ${repo})`);
    // the first segment is the branch, tag or SHA (the ref input lets a branch name containing a slash be split correctly); the URL's ref is not used for checkout
    const p = ref && (rest === ref || rest.startsWith(`${ref}/`)) ? rest.slice(ref.length + 1) : rest.includes('/') ? rest.slice(rest.indexOf('/') + 1) : '';
    if (!p) throw new Error(`${l.slice(0, 120)} points at the repository root; name a file or folder`);
    l = kind === 'tree' ? p.replace(/\/*$/, '/') : p;
  }
  l = l.replace(/\\/g, '/').replace(/^(\.\/)+/, '').replace(/^\/+/, '');
  if (!l || l.split('/').some((p) => p === '..')) throw new Error(`invalid path: ${line.trim().slice(0, 100)}`);
  if (!/[*?[]/.test(l) && !l.endsWith('/') && !/\.[A-Za-z0-9]{1,8}$/.test(l.split('/').pop())) l += '/'; // a folder
  return neg + l;
}

function resolveList(text, repo, ref) {
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    const e = resolveEntry(line, repo, ref);
    if (!out.includes(e)) out.push(e);
  }
  return out.join('\n');
}

function resolve(env) {
  const { repo, pr: urlPr } = parseRepo(env.REPO);
  const pr = String(env.PR || '').trim() || urlPr;
  if (pr && !/^[1-9]\d{0,8}$/.test(pr)) throw new Error(`pr must be a pull request number, got: ${pr.slice(0, 40)}`);
  const ref = String(env.REF || '').trim();
  if (ref && !/^[A-Za-z0-9._][A-Za-z0-9._/-]{0,199}$/.test(ref)) throw new Error('ref must be a branch, tag or commit SHA (letters, digits and . _ / -)');
  const want = String(env.MODE || 'auto').trim() || 'auto';
  if (!['auto', 'pr', 'audit'].includes(want)) throw new Error('mode must be auto, pr or audit');
  const mode = want === 'auto' ? (pr ? 'pr' : 'audit') : want;
  if (mode === 'pr' && !pr) throw new Error('mode pr needs a PR number (pr)');
  return {
    repo, pr: mode === 'pr' ? pr : '', ref, mode,
    design: resolveList(env.DESIGN_DOCS, repo, ref), rules: resolveList(env.RULES_DOCS, repo, ref), tests: resolveList(env.TEST_DIRS, repo, ref),
  };
}

if (require.main === module) {
  try {
    const r = resolve(process.env);
    const lines = Object.entries(r).map(([k, v]) => { const d = `sg_${crypto.randomBytes(8).toString('hex')}`; return `${k}<<${d}\n${v}\n${d}\n`; });
    if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, lines.join(''));
    console.log(`SpecGuard manual run: ${r.repo}, mode ${r.mode}${r.pr ? ` #${r.pr}` : ''}${r.ref ? `, ref ${r.ref}` : ''}`);
  } catch (e) {
    console.log(`::error::${String(e.message).replace(/[\r\n]+/g, ' ')}`);
    process.exit(1);
  }
}
module.exports = { parseRepo, resolveEntry, resolveList, resolve };
