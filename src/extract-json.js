// Pulls the findings object out of Copilot's text output. Usage: node extract-json.js <in> <out>
const fs = require('fs');

const parse = (t) => { try { const v = JSON.parse(t); if (v && typeof v === 'object' && !Array.isArray(v)) return t; } catch {} };

// Whole output, then fenced blocks last to first, then the outermost balanced {...} span. Never repairs invalid JSON.
function extract(s) {
  s = String(s).replace(/^﻿/, '').trim();
  const blocks = [...s.matchAll(/```[\w-]*[ \t]*\r?\n([\s\S]*?)```/g)].map((m) => m[1]).reverse();
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  return [s, ...blocks, a >= 0 && b > a ? s.slice(a, b + 1) : ''].map(parse).find(Boolean);
}

if (require.main === module) {
  const j = extract(fs.readFileSync(process.argv[2], 'utf8'));
  if (j) fs.writeFileSync(process.argv[3], j); else console.log('::warning::no JSON found in Copilot output');
}
module.exports = { extract };
