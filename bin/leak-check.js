#!/usr/bin/env node
'use strict';
// Detects (never prevents once pushed; run it from .githooks/pre-push to stop a push) in tracked files:
//  - a honey marker (planted in the owner's pilot repo, so seeing one here means private content leaked; 17+ hex still counts, a longer run starts with a full marker)
//  - a local absolute user path
//  - any token whose lower-cased sha256 is in SPECGUARD_DENY_SHA256 (comma/newline list; hashes of private repo/project names). Output is file:line and the hash, never the token.
//   The denylist also reads the untracked per-clone file .git/specguard-deny (one sha256 per line). A name is matched whole and inside paths/URLs/kebab/snake names (1-3 adjacent parts).
// Usage: node bin/leak-check.js [file...]   (no args: every tracked file) | git log -p -U0 <range> | node bin/leak-check.js --stdin (added lines only). Exit 1 on any hit.
const fs = require('fs');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const RULES = [
  ['honey marker', /SPECGUARD-HONEY-[0-9a-f]{16}/],
  ['local user path', /(?:[A-Za-z]:[\\/]+Users[\\/]+|\/Users\/|\/home\/)(?!(?:Public|Default|runner|user|name|you|me)[\\/])[\w.-]+[\\/]/],
];
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

// every hash a line can match: each token whole / edge-trimmed, plus each run of 1-3 parts of its /._- split joined with - and _ (paths, URLs, snake/kebab names)
function* hashes(line) {
  for (const t of line.split(/[^A-Za-z0-9._/-]+/)) {
    const c = new Set([t, t.replace(/^[._/-]+|[._/-]+$/g, '')]);
    const parts = t.split(/[/._-]+/).filter(Boolean);
    for (let i = 0; i < parts.length; i++) for (let n = 1; n <= 3 && i + n <= parts.length; n++) for (const j of ['-', '_']) c.add(parts.slice(i, i + n).join(j));
    for (const x of c) yield sha(x.toLowerCase());
  }
}

// deny list = env var + the untracked per-clone file .git/specguard-deny (worktree-safe via git-path)
function denyList(env = process.env, gitPath = () => execFileSync('git', ['rev-parse', '--git-path', 'specguard-deny'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()) {
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
  let file = '?', n = 0, hdr = true, m; // hdr: between 'diff --git' and the first @@, where '+++ path' is a header; after @@ every '+' line is content
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) hdr = true;
    else if (hdr && (m = /^\+\+\+ (?:b\/)?(.*)/.exec(line))) file = m[1];
    else if ((m = /^@@ -\S+ \+(\d+)/.exec(line))) { n = +m[1]; hdr = false; }
    else if (!hdr && line[0] === '+') scanLine(file, line.slice(1), n++, denied, hits);
  }
  return hits;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const hits = args[0] === '--stdin' ? scanDiff(fs.readFileSync(0, 'utf8'))
    : scan(args.length ? args : execFileSync('git', ['ls-files', '-z'], { maxBuffer: 1 << 28 }).toString().split('\0').filter(Boolean));
  hits.forEach((h) => console.error(h));
  process.exit(hits.length ? 1 : 0);
}
module.exports = { scan, scanDiff, denyList };
