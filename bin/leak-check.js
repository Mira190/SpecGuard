#!/usr/bin/env node
'use strict';
// Fails (exit 1) when tracked files hold a honey marker (planted in private repos, so seeing one here means private content leaked) or a local absolute user path.
// Usage: node bin/leak-check.js [file...]   (no args: every tracked file)
const fs = require('fs');
const { execFileSync } = require('child_process');

const RULES = [
  ['honey marker', /SPECGUARD-HONEY-[0-9a-f]{16}/],
  ['local user path', /(?:[A-Za-z]:[\\/]+Users[\\/]+|\/Users\/|\/home\/)(?!(?:Public|Default|runner|user|name|you|me)[\\/])[\w.-]+[\\/]/],
];

function scan(files) {
  const hits = [];
  for (const f of files) {
    let text;
    try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }
    text.split('\n').forEach((line, i) => {
      for (const [name, re] of RULES) if (re.test(line)) hits.push(`${f}:${i + 1}: ${name}`);
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
