#!/usr/bin/env node
// Manual run (.github/workflows/specguard-run.yml), step 1: turn the dispatch inputs into what the review needs.
// Env: TARGET (a PR link -> PR review; a repo link, owner/name or a branch/tree link -> unit test gap scan of that branch, default branch when none),
// DESIGN_DOCS, RULES_DOCS, TEST_DIRS (newline separated: repository paths, globs, or github.com blob/tree URLs of the SAME repository; a leading ! excludes),
// GH_TOKEN (the run's token: used only to read the PR, to find which part of a link is the branch name, and to tell a folder from a file; without it, or when it cannot read the repo, links are read literally).
// Writes repo, pr, ref, mode, head_sha, base_sha, scan_paths (the verified path of a branch link), design, rules, tests to $GITHUB_OUTPUT and fails with ::error:: on anything it cannot honour.
// A URL of another repository is rejected (simple choice: fetching it would need a second token scope and checkout).
const fs = require('node:fs');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const NOT_READABLE = 'is not readable from GitHub Actions; add the document to the repository or paste it';
const HOST = /^(www\.)?github\.com$/i;
const REF_OK = /^[A-Za-z0-9._][A-Za-z0-9._/-]{0,199}$/;
const SHA = /^[0-9a-f]{40}$/i;

// gh api with the run's token: the text of the answer (--jq applied), or null when it fails or there is no token (offline tests, a repository the token cannot read).
function ghApi(path, jq) {
  if (!process.env.GH_TOKEN) return null;
  try {
    return execFileSync('gh', ['api', '--paginate', path, ...(jq ? ['--jq', jq] : [])], { encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch { return null; }
}

function parseTarget(input) {
  const s = String(input || '').trim();
  if (!s) throw new Error('target is required: a PR link, a repo or branch link, or owner/name');
  let owner, name, tail = '';
  const plain = /^([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9._-]+)$/.exec(s);
  if (plain) [, owner, name] = plain;
  else {
    let u;
    try { u = new URL(s); } catch { throw new Error(`target must be a github.com link or owner/name, got: ${s.slice(0, 100)}`); }
    if (!/^https?:$/.test(u.protocol) || !HOST.test(u.hostname)) throw new Error(`target must be on github.com, got: ${u.hostname}`);
    const m = /^\/([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9._-]+?)(?:\.git)?(?:\/(.*))?$/.exec(u.pathname);
    if (!m) throw new Error(`target link has no owner/name: ${s.slice(0, 100)}`);
    [, owner, name, tail = ''] = m;
  }
  name = name.replace(/\.git$/, '');
  if (!name || name === '.' || name === '..') throw new Error(`invalid repository name: ${name}`);
  const repo = `${owner}/${name}`, pull = /^pull\/(\d+)(?:\/|$)/.exec(tail), tree = /^tree\/(.+)$/.exec(tail);
  if (pull) { if (!/^[1-9]\d{0,8}$/.test(pull[1])) throw new Error(`not a pull request number: ${pull[1].slice(0, 40)}`); return { repo, pr: pull[1], rest: '' }; }
  if (tree) return { repo, pr: '', rest: decodeURIComponent(tree[1]).replace(/\/+$/, '') };
  if (!tail.replace(/\/+$/, '')) return { repo, pr: '', rest: '' };
  throw new Error(`${s.slice(0, 120)} is not a PR, repo or branch link (paste github.com/OWNER/NAME/pull/N to review a PR, or github.com/OWNER/NAME[/tree/BRANCH] to scan)`);
}

// Branch and tag names that start with the first path segment (one cached call each for heads and tags); null when the API cannot be read.
function refNames(ctx, first) {
  if (!ctx.cache.has(first)) {
    const out = new Set();
    let any = false;
    for (const kind of ['heads', 'tags']) {
      const t = ctx.api(`repos/${ctx.repo}/git/matching-refs/${kind}/${encodeURIComponent(first)}`, '.[].ref');
      if (t === null) continue;
      any = true;
      for (const l of t.split('\n')) if (l.trim()) out.add(l.trim().replace(/^refs\/(heads|tags)\//, ''));
    }
    ctx.cache.set(first, any ? out : null);
  }
  return ctx.cache.get(first);
}

// "BRANCH/PATH" of a tree or blob URL -> { ref, path, verified }. A branch name may contain slashes, so the LONGEST existing ref that is a prefix wins
// (branches `feat` and `feat/x` cannot both exist, so this is unambiguous). Without API access the first segment is the ref, verified: false.
function splitRef(rest, ctx) {
  const seg = rest.split('/');
  if (SHA.test(seg[0])) return { ref: seg[0], path: seg.slice(1).join('/'), verified: true };
  if (ctx.ref && (rest === ctx.ref || rest.startsWith(`${ctx.ref}/`))) return { ref: ctx.ref, path: rest.slice(ctx.ref.length + 1), verified: true };
  let best = '';
  for (const n of refNames(ctx, seg[0]) || []) if ((rest === n || rest.startsWith(`${n}/`)) && n.length > best.length) best = n;
  if (best) return { ref: best, path: rest.slice(best.length + 1), verified: true };
  return { ref: seg[0], path: seg.slice(1).join('/'), verified: false };
}

// Is this repository path a folder? Asked of the API (at the PR head or the scanned branch); null/false answers mean "keep it as given".
function isDir(ctx, p) {
  const q = ctx.at ? `?ref=${encodeURIComponent(ctx.at)}` : '';
  const t = ctx.api(`repos/${ctx.repo}/contents/${p.split('/').map(encodeURIComponent).join('/')}${q}`, 'if type == "array" then "dir" else .type end');
  return !!t && t.split('\n')[0].trim() === 'dir';
}

// One entry of a path list -> a repository-relative path or glob. A tree URL becomes `dir/` and a blob URL a file (never a folder, whatever its name).
// A plain path with no glob character, no trailing slash and no file extension (`Makefile`, `docs/specs`) is looked up in the API tree: a folder gets `/`,
// a file stays a file; when the API cannot answer the path is kept as given (test_paths reads a bare name as a file or a folder).
function resolveEntry(line, ctx) {
  let l = line.trim();
  const neg = l.startsWith('!') ? '!' : '';
  l = l.replace(/^!\s*/, '');
  if (/[\x00-\x1F\x7F]/.test(l)) throw new Error('a path contains a control character');
  let blob = false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(l)) {
    let u;
    try { u = new URL(l); } catch { throw new Error(`not a valid URL: ${l.slice(0, 100)}`); }
    if (!/^https?:$/.test(u.protocol) || !(HOST.test(u.hostname) || u.hostname === 'raw.githubusercontent.com')) throw new Error(`${l.slice(0, 120)} ${NOT_READABLE}`);
    const raw = u.hostname === 'raw.githubusercontent.com';
    const m = (raw ? /^\/([^/]+)\/([^/]+)\/(.+)$/ : /^\/([^/]+)\/([^/]+)\/(blob|tree)\/(.+)$/).exec(u.pathname);
    if (!m) throw new Error(`${l.slice(0, 120)} is a GitHub URL but not a file or folder link (expected github.com/OWNER/NAME/blob|tree/REF/PATH)`);
    const [owner, name] = [m[1], m[2].replace(/\.git$/, '')], kind = raw ? 'blob' : m[3], rest = decodeURIComponent(raw ? m[3] : m[4]);
    if (`${owner}/${name}`.toLowerCase() !== ctx.repo.toLowerCase()) throw new Error(`${l.slice(0, 120)} points into ${owner}/${name}, not the target repository ${ctx.repo}; other repositories are not supported yet (copy the document into ${ctx.repo})`);
    const { path: p } = splitRef(rest, ctx); // the URL's ref is not used for checkout
    if (!p) throw new Error(`${l.slice(0, 120)} points at the repository root; name a file or folder`);
    blob = kind === 'blob';
    l = blob ? p : p.replace(/\/*$/, '/');
  }
  l = l.replace(/\\/g, '/').replace(/^(\.\/)+/, '').replace(/^\/+/, '');
  if (!l || l.split('/').some((p) => p === '..')) throw new Error(`invalid path: ${line.trim().slice(0, 100)}`);
  if (!blob && !/[*?[]/.test(l) && !l.endsWith('/') && !/\.[A-Za-z0-9]{1,8}$/.test(l.split('/').pop()) && isDir(ctx, l)) l += '/';
  return neg + l;
}

function resolveList(text, ctx) {
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    const e = resolveEntry(line, ctx);
    if (!out.includes(e)) out.push(e);
  }
  return out.join('\n');
}

function resolve(env, api = ghApi, log = () => {}) {
  const t = parseTarget(env.TARGET);
  const ctx = { repo: t.repo, api, cache: new Map(), ref: '', at: '' };
  const out = { repo: t.repo, pr: t.pr, ref: '', mode: t.pr ? 'pr' : 'scan', head_sha: '', base_sha: '', scan_paths: '' };
  if (t.pr) {
    const row = api(`repos/${t.repo}/pulls/${t.pr}`, '[.head.sha, .base.sha, .state] | @tsv');
    if (row === null) throw new Error(`could not read ${t.repo}#${t.pr} (does SPECGUARD_PAT have Pull requests: read on it?)`);
    const [head, base, state] = row.trim().split('\t');
    if (!SHA.test(head || '') || !SHA.test(base || '')) throw new Error(`unexpected answer for ${t.repo}#${t.pr}`);
    if (state !== 'open') throw new Error(`${t.repo}#${t.pr} is ${state}; SpecGuard reviews open PRs (paste the branch link to scan the code instead)`);
    Object.assign(out, { head_sha: head, base_sha: base });
    ctx.at = head;
  } else if (t.rest) {
    const s = splitRef(t.rest, ctx);
    if (!REF_OK.test(s.ref)) throw new Error('the branch in the link must be a branch, tag or commit SHA (letters, digits and . _ / -)');
    out.ref = ctx.ref = ctx.at = s.ref;
    if (!s.verified && t.rest.includes('/')) throw new Error(`could not tell the branch from the path in the link: the token cannot read the branches of ${t.repo}. Use a token that can read the repository, or link the branch root (github.com/${t.repo}/tree/BRANCH) and narrow with scan_paths`);
    else if (s.path) { // a plain path: scan_paths reads it as a file or a folder
      if (/[\x00-\x1F\x7F]/.test(s.path) || s.path.split('/').some((p) => p === '..' || !p)) throw new Error('the path in the link is not valid');
      out.scan_paths = `/${s.path}`; // anchored at the repository root: `legacy/packages/payments` is not `packages/payments`
      log(`::notice::the scan covers the source files under ${s.path} on ${s.ref}; documents and tests still come from the whole repository (narrow them with design_docs and test_dirs).`);
    }
  }
  return { ...out, design: resolveList(env.DESIGN_DOCS, ctx), rules: resolveList(env.RULES_DOCS, ctx), tests: resolveList(env.TEST_DIRS, ctx) };
}

if (require.main === module) {
  try {
    const r = resolve(process.env, ghApi, console.log);
    const lines = Object.entries(r).map(([k, v]) => { const d = `sg_${crypto.randomBytes(8).toString('hex')}`; return `${k}<<${d}\n${v}\n${d}\n`; });
    if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, lines.join(''));
    console.log(`SpecGuard manual run: ${r.repo}, ${r.mode === 'pr' ? `PR review #${r.pr}` : `unit test gap scan${r.ref ? `, ref ${r.ref}` : ', default branch'}`}`);
  } catch (e) {
    console.log(`::error::${String(e.message).replace(/[\r\n]+/g, ' ')}`);
    process.exit(1);
  }
}
module.exports = { parseTarget, splitRef, resolveEntry, resolveList, resolve };
