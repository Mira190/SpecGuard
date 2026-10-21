#!/usr/bin/env node
'use strict';
// Detects (never prevents once pushed; run it from .githooks/pre-push to stop a push) in tracked files:
//  - a honey marker (planted in the owner's pilot repo, so seeing one here means private content leaked; 17+ hex still counts, a longer run starts with a full marker)
//  - a local absolute user path
//  - any token whose lower-cased sha256 is in SPECGUARD_DENY_SHA256 (comma/newline list; hashes of private repo/project names). Output is file:line and the hash, never the token.
//   The denylist also reads the untracked per-clone file <git-common-dir>/specguard-deny (one sha256 per line; the main .git, also from linked worktrees). A name is matched whole and inside paths/URLs/kebab/snake/camelCase names (1-3 adjacent parts).
// Usage: node bin/leak-check.js [file...]   (no args: every tracked file) | git log -p -U0 <range> | node bin/leak-check.js --stdin (added lines only). Exit 1 on any hit.
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const { execFileSync } = require('child_process');

const RULES = [
  ['honey marker', /SPECGUARD-HONEY-[0-9a-f]{16}/],
  ['local user path', /(?:[A-Za-z]:[\\/]+Users[\\/]+|\/Users\/|\/home\/)(?!(?:Public|Default|runner|ci|user|name|you|me)[\\/])[\w.-]+[\\/]/],
];
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

// every hash a line can match: each token whole / edge-trimmed, plus each run of 1-3 parts of its /._- split joined with - and _ (paths, URLs, snake/kebab names)
function* hashes(line) {
  for (const t of line.split(/[^A-Za-z0-9._/-]+/)) {
    const c = new Set([t, t.replace(/^[._/-]+|[._/-]+$/g, '')]);
    const parts = t.split(/[/._-]+/).filter(Boolean);
    const runs = (a, js) => { for (let i = 0; i < a.length; i++) for (let n = 1; n <= 3 && i + n <= a.length; n++) for (const j of js) c.add(a.slice(i, i + n).join(j)); };
    const camel = (p) => p.split(/(?<=[a-z0-9])(?=[A-Z])/); // secretProjApi -> secret, Proj, Api
    runs(parts.flatMap(camel), ['-', '_']);
    for (const p of parts) runs(camel(p), ['']); // glued only inside one camelCase word, so my-secret-proj stays clean
    for (const x of c) yield sha(x.toLowerCase());
  }
}

// deny list = env var + the untracked per-clone file <git-common-dir>/specguard-deny (the main .git, shared by linked worktrees; --git-path would give the per-worktree dir)
function denyList(env = process.env, gitPath = () => path.resolve(execFileSync('git', ['rev-parse', '--git-common-dir'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(), 'specguard-deny')) {
  let f = '';
  try { f = fs.readFileSync(gitPath(), 'utf8'); } catch { /* no repo or no file */ }
  return new Set(((env.SPECGUARD_DENY_SHA256 || '') + '\n' + f).split(/[\s,]+/).map((h) => h.trim().toLowerCase()).filter(Boolean));
}

function scanLine(name, line, at, denied, hits) {
  for (const [rule, re] of RULES) if (re.test(line)) hits.push(`${name}:${at}: ${rule}`);
  if (denied.size) for (const h of new Set(hashes(line))) if (denied.has(h)) hits.push(`${name}:${at}: denylisted token sha256=${h}`);
}

function scan(files, denied = denyList()) {
  const hits = [];
  for (const f of files) {
    let text;
    try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }
    text.split('\n').forEach((line, i) => scanLine(f, line, i + 1, denied, hits));
  }
  return hits;
}

// --stdin: a unified diff (git log -p -U0); scans only the added lines, reported as path:newLine
function scanDiff(diff, denied = denyList()) {
  const hits = [];
  let file = '?', n = 0, hdr = true, w = 1, m; // hdr: between 'diff --git|--cc' and the first @@, where '+++ path' is a header; after @@ every line starting with w '+' is content (w = parents: 2 in a merge)
  for (const line of diff.split('\n')) {
    if (/^diff --(git|cc) /.test(line)) hdr = true;
    else if (hdr && (m = /^\+\+\+ (?:b\/)?(.*)/.exec(line))) file = m[1];
    else if ((m = /^(@@+) -\S+(?: -\S+)* \+(\d+)/.exec(line))) { w = m[1].length - 1; n = +m[2]; hdr = false; }
    else if (!hdr && line.startsWith('+'.repeat(w))) scanLine(file, line.slice(w), n++, denied, hits);
  }
  return hits;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const denied = denyList();
  if (args[0] === '--stdin' && !denied.size) console.error('denylist empty: private-name check skipped (set SPECGUARD_DENY_SHA256 or <common-dir>/specguard-deny)');
  const hits = args[0] === '--stdin' ? scanDiff(fs.readFileSync(0, 'utf8'), denied)
    : scan(args.length ? args : execFileSync('git', ['ls-files', '-z'], { maxBuffer: 1 << 28 }).toString().split('\0').filter(Boolean), denied);
  hits.forEach((h) => console.error(h));
  process.exit(hits.length ? 1 : 0);
}
module.exports = { scan, scanDiff, denyList };
