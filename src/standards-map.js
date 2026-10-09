#!/usr/bin/env node
// Where each trusted rule file applies, from the files restored from base (never the PR's). Deterministic, no model.
// Output standards-map.json: [{ path, scope: [glob], kind }]. post.js drops a standards finding whose rule does not cover the cited path.
const fs = require('node:fs');
const path = require('node:path');

const reOf = (g) => {
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] !== '*') re += '[^/]*';
      else if (g[(i += 1) + 1] === '/') { i++; re += '(?:.*/)?'; } // **/ also matches zero directories
      else re += '.*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
};
// ponytail: no braces or negation. A slash-free glob (*.py) also matches the basename at any depth, like gitignore, so the check errs toward keeping a finding.
function matches(scope, p) {
  const base = p.slice(p.lastIndexOf('/') + 1);
  return scope.some((g) => { g = g.replace(/^\.\//, ''); const r = reOf(g); return r.test(p) || (!g.includes('/') && r.test(base)); });
}

const unq = (s) => s.trim().replace(/^(['"])(.*)\1$/, '$2');
const frontmatter = (text) => /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1].split(/\r?\n/) || [];
// Copilot applyTo: "a, b". Claude paths: a block list, an inline [a, b] or a scalar. Absent = unconditional.
function field(text, key) {
  const fm = frontmatter(text), i = fm.findIndex((l) => l.startsWith(`${key}:`));
  if (i < 0) return [];
  const v = fm[i].slice(key.length + 1).trim();
  if (v) return unq(v).replace(/^\[|\]$/g, '').split(',').map(unq).filter(Boolean);
  const out = [];
  for (const l of fm.slice(i + 1)) { const m = /^\s+-\s*(.+)$/.exec(l); if (!m) break; out.push(unq(m[1])); }
  return out;
}

const AGENTS = /(?:^|\/)(?:AGENTS|AGENT|CLAUDE|GEMINI)\.md$/;
const kindOf = (p) => (/^\.github\/instructions\/.*\.instructions\.md$/.test(p) ? 'copilot' : /^\.claude\/rules\/.*\.md$/.test(p) ? 'claude-rule' : AGENTS.test(p) ? 'agents' : 'repo');
function scopeOf(p, text) {
  const k = kindOf(p);
  const g = k === 'copilot' ? field(text, 'applyTo') : k === 'claude-rule' ? field(text, 'paths') : [];
  if (g.length) return g;
  return k === 'agents' && p.includes('/') ? [`${p.slice(0, p.lastIndexOf('/'))}/**`] : ['**'];
}

const build = (paths, read) => paths.map((p) => {
  let text = '';
  try { text = read(p); } catch { /* unreadable: scope stays everywhere */ }
  return { path: p, scope: scopeOf(p, text), kind: kindOf(p) };
});

if (require.main === module) {
  const ctx = process.env.CTX;
  const listed = fs.readFileSync(path.join(ctx, 'standards.txt'), 'utf8').split('\n').filter(Boolean);
  fs.writeFileSync(path.join(ctx, 'standards-map.json'), JSON.stringify(build(listed, (p) => fs.readFileSync(p, 'utf8')), null, 2) + '\n');
}
module.exports = { matches, scopeOf, build };
