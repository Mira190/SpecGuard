// Pulls the findings object out of Copilot's text output. Usage: node extract-json.js <in> <out>
const fs = require('fs');

const object = (t) => { try { const v = JSON.parse(t); if (v && typeof v === 'object' && !Array.isArray(v)) return t; } catch {} };

// The two syntax slips weak models make: a trailing comma before } or ], and a raw newline or tab inside a string. Nothing else is repaired
// (a truncated or otherwise broken output still fails), and the result is still schema-, citation- and anchor-verified by post.js.
function lenient(s) {
  const close = /\s*[}\]]/y;
  let out = '', str = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (str) {
      if (c === '\\') { out += c + (s[++i] ?? ''); continue; }
      if (c === '"') str = false;
      else if (c === '\n' || c === '\t') { out += c === '\n' ? '\\n' : '\\t'; continue; }
      else if (c === '\r') continue;
    } else if (c === '"') str = true;
    else if (c === ',' && (close.lastIndex = i + 1, close.test(s))) continue;
    out += c;
  }
  return out;
}
const parse = (t) => object(t) || object(lenient(t));

// Whole output, then every balanced top-level {...} span (JSON strings respected); the last findings-like object wins.
// Repairs only trailing commas and raw newlines in strings (see lenient); a span that still fails to parse is skipped whole, not mined for inner objects.
function extract(s) {
  s = String(s).replace(/^﻿/, '').trim();
  const whole = parse(s);
  if (whole) return whole;
  const found = []; let bad = false;
  for (let i = s.indexOf('{'); i >= 0; i = s.indexOf('{', i + 1)) {
    let depth = 0, str = false, end = -1;
    for (let j = i; j < s.length && end < 0; j++) {
      const c = s[j];
      if (str) { if (c === '\\') j++; else if (c === '"') str = false; }
      else if (c === '"') str = true;
      else if (c === '{') depth++;
      else if (c === '}' && !--depth) end = j;
    }
    if (end < 0) continue;
    const t = parse(s.slice(i, end + 1));
    if (t) found.push(t); else bad = true;
    i = end;
  }
  found.reverse();
  return found.find((t) => { const o = JSON.parse(t); return 'findings' in o || 'coverage' in o || 'docs_reviewed' in o; }) || (bad ? undefined : found[0]); // a corrupt span means the rest is not trustworthy
}

// CLI: node extract-json.js <in> <out> [--check]. --check also runs post.js's validator (audit-post.js's with CHECK=audit) and exits 1 when the output is unusable (the repair turn's trigger).
if (require.main === module) {
  const [inp, outp, flag] = process.argv.slice(2);
  const j = extract(fs.readFileSync(inp, 'utf8'));
  let why = j ? '' : 'no JSON found in the engine output';
  if (j) {
    fs.writeFileSync(outp, j);
    if (flag === '--check') {
      try { const v = require(process.env.CHECK === 'audit' ? './audit-post' : './post').validate(JSON.parse(j)); if (!v.ok) why = `output failed validation: ${v.error}`; } catch (e) { why = `output failed validation: ${e.message}`; }
    }
  }
  if (why) console.log(`::warning::${why}`);
  if (why && flag === '--check') process.exitCode = 1;
}
module.exports = { extract };
