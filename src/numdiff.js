#!/usr/bin/env node
// Renders a unified diff with explicit line numbers so a model copies a number instead of counting hunk offsets:
//   `  41 | +    if (x > 30)`   new-side number on '+' and context lines, old-side number on '-' lines.
// File headers and `@@` lines are kept verbatim; `\ No newline at end of file` stays unnumbered. CRs are dropped.
// ponytail: own small parser, not post.js parsePatch (that one maps line -> hunk and keeps no text, and importing post.js is heavy). Language-agnostic.
const fs = require('node:fs');

function numberDiff(patch) {
  const out = [];
  let o = 0, n = 0, ro = 0, rn = 0; // next old/new line number, lines still owed by the current hunk
  const pad = (v) => String(v).padStart(4);
  for (const raw of String(patch).split('\n')) {
    const ln = raw.replace(/\r$/, '');
    if ((ro > 0 || rn > 0) && /^diff --git /.test(ln)) ro = rn = 0; // a truncated hunk must not swallow the next file
    if (ro > 0 || rn > 0) {
      const c = ln[0];
      if (c === '\\') { out.push(ln); continue; }
      if (c === '+' && rn > 0) { out.push(`${pad(n)} | ${ln}`); n++; rn--; continue; }
      if (c === '-' && ro > 0) { out.push(`${pad(o)} | ${ln}`); o++; ro--; continue; }
      if ((c === ' ' || ln === '') && ro > 0 && rn > 0) { out.push(`${pad(n)} | ${ln || ' '}`); o++; n++; ro--; rn--; continue; }
      ro = rn = 0; // counts disagree with the text: fall through and treat as a header line
    }
    const h = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(ln);
    if (h) { o = +h[1]; n = +h[3]; ro = h[2] === undefined ? 1 : +h[2]; rn = h[4] === undefined ? 1 : +h[4]; }
    out.push(ln);
  }
  return out.join('\n');
}

if (require.main === module) {
  const [src, dst] = process.argv.slice(2);
  if (!src || !dst) { console.error('Usage: node src/numdiff.js <diff.patch> <diff.numbered.txt>'); process.exit(2); }
  fs.writeFileSync(dst, numberDiff(fs.readFileSync(src, 'utf8')));
}
module.exports = { numberDiff };
