#!/usr/bin/env node
'use strict';
// Detects (never prevents once pushed; run it from .githooks/pre-push to stop a push) in tracked files:
//  - a honey marker (planted in the owner's pilot repo, so seeing one here means private content leaked; 17+ hex still counts, a longer run starts with a full marker)
//  - a local absolute user path
//  - any token whose lower-cased sha256 is in SPECGUARD_DENY_SHA256 (comma/newline list; hashes of private repo/project names). Output is file:line and the hash, never the token.
// Usage: node bin/leak-check.js [file...]   (no args: every tracked file). Exit 1 on any hit.
const fs = require('fs');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const RULES = [
  ['honey marker', /SPECGUARD-HONEY-[0-9a-f]{16}/],
  ['local user path', /(?:[A-Za-z]:[\\/]+Users[\\/]+|\/Users\/|\/home\/)(?!(?:Public|Default|runner|user|name|you|me)[\\/])[\w.-]+[\\/]/],
];
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

function scan(files, deny = process.env.SPECGUARD_DENY_SHA256) {
  const denied = new Set((deny || '').split(/[\s,]+/).map((h) => h.trim().toLowerCase()).filter(Boolean));
  const hits = [];
  for (const f of files) {
    let text;
    try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }
    text.split('\n').forEach((line, i) => {
      for (const [name, re] of RULES) if (re.test(line)) hits.push(`${f}:${i + 1}: ${name}`);
      if (denied.size) for (const t of line.split(/[^A-Za-z0-9._/-]+/)) {
        // ponytail: whole tokens only (plus edge punctuation trimmed); a name embedded in a longer token is missed
        for (const h of new Set([sha(t.toLowerCase()), sha(t.replace(/^[._/-]+|[._/-]+$/g, '').toLowerCase())])) if (denied.has(h)) hits.push(`${f}:${i + 1}: denylisted token sha256=${h}`);
      }
    });
  }
  return hits;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const files = args.length ? args : execFileSync('git', ['ls-files', '-z'], { maxBuffer: 1 << 28 }).toString().split('\0').filter(Boolean);
  const hits = scan(files);
  hits.forEach((h) => console.error(h));
  process.exit(hits.length ? 1 : 0);
}
module.exports = { scan };
