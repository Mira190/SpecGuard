// Pulls the findings object out of Copilot's text output. Usage: node extract-json.js <in> <out>
const fs = require('fs');

const parse = (t) => { try { const v = JSON.parse(t); if (v && typeof v === 'object' && !Array.isArray(v)) return t; } catch {} };

// Whole output, then every balanced top-level {...} span (JSON strings respected); the last findings-like object wins.
// Never repairs invalid JSON; a span that fails to parse is skipped whole, not mined for inner objects.
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
  return found.find((t) => { const o = JSON.parse(t); return 'findings' in o || 'coverage' in o; }) || (bad ? undefined : found[0]); // a corrupt span means the rest is not trustworthy
}

// CLI: node extract-json.js <in> <out> [--check]. --check also runs post.js's validator and exits 1 when the output is unusable (the repair turn's trigger).
if (require.main === module) {
  const [inp, outp, flag] = process.argv.slice(2);
  const j = extract(fs.readFileSync(inp, 'utf8'));
  let why = j ? '' : 'no JSON found in Copilot output';
  if (j) {
    fs.writeFileSync(outp, j);
    if (flag === '--check') {
      try { const v = require('./post').validate(JSON.parse(j)); if (!v.ok) why = `output failed validation: ${v.error}`; } catch (e) { why = `output failed validation: ${e.message}`; }
    }
  }
  if (why) console.log(`::warning::${why}`);
  if (why && flag === '--check') process.exitCode = 1;
}
module.exports = { extract };
