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
// {a,b} expands to several globs first (innermost braces first, so nesting works too); an unmatched brace stays literal.
const expand = (g) => { const m = /\{([^{}]*)\}/.exec(g); return m ? m[1].split(',').flatMap((a) => expand(g.slice(0, m.index) + a + g.slice(m.index + m[0].length))) : [g]; };
// ponytail: no negation. A slash-free glob (*.py) also matches the basename at any depth, like gitignore, so the check errs toward keeping a finding.
function matches(scope, p) {
  const base = p.slice(p.lastIndexOf('/') + 1);
  return scope.some((g0) => expand(g0.replace(/^\.\//, '')).some((g) => { const r = reOf(g); return r.test(p) || (!g.includes('/') && r.test(base)); }));
}

// split on commas outside {braces}: "src/**/*.{js,jsx},test/**" is two globs
const splitTop = (s) => { const out = []; let d = 0, cur = ''; for (const c of s) { if (c === '{') d++; else if (c === '}' && d) d--; if (c === ',' && !d) { out.push(cur); cur = ''; } else cur += c; } return [...out, cur]; };
const unq = (s) => s.trim().replace(/^(['"])(.*)\1$/, '$2');
const frontmatter = (text) => /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1].split(/\r?\n/) || [];
// Copilot applyTo: "a, b". Claude paths: a block list, an inline [a, b] or a scalar. Absent = unconditional.
function field(text, key) {
  const fm = frontmatter(text), i = fm.findIndex((l) => l.startsWith(`${key}:`));
  if (i < 0) return [];
  const v = fm[i].slice(key.length + 1).trim();
  if (v) return splitTop(unq(v).replace(/^\[|\]$/g, '')).map(unq).filter(Boolean);
  const out = [];
  for (const l of fm.slice(i + 1)) { const m = /^\s+-\s*(.+)$/.exec(l); if (!m) break; out.push(unq(m[1])); }
  return out;
}

const AGENTS = /(?:^|\/)(?:AGENTS|AGENT|CLAUDE|GEMINI)\.md$/;
const kindOf = (p) => (/^\.github\/instructions\/.*\.instructions\.md$/.test(p) ? 'copilot' : /^\.claude\/rules\/.*\.md$/.test(p) ? 'claude-rule' : /(?:^|\/)\.cursor\/rules\//.test(p) ? 'cursor-rule' : AGENTS.test(p) ? 'agents' : 'repo');
// Cursor rule with neither alwaysApply: true nor globs: when it applies is the model's call (description), so the scope is unknown, not "everywhere".
const always = (text) => /^alwaysApply:\s*["']?true["']?\s*$/im.test(frontmatter(text).join('\n'));
const cursorUnknown = (text) => !always(text) && !field(text, 'globs').length;
function scopeOf(p, text) {
  const k = kindOf(p);
  if (k === 'cursor-rule' && always(text)) return ['**'];
  // other rule files (.gemini/styleguide.md, .greptile/rules.md, STANDARDS_PATHS docs) apply everywhere unless they carry their own applyTo
  const g = k === 'copilot' || k === 'repo' ? field(text, 'applyTo') : k === 'claude-rule' ? field(text, 'paths') : k === 'cursor-rule' ? field(text, 'globs') : [];
  if (g.length) return g;
  // AGENTS/CLAUDE/GEMINI/BUGBOT.md govern their directory; a .claude/ or .cursor/ segment is the tool's own folder, not part of the scope
  const dir = p.slice(0, Math.max(p.lastIndexOf('/'), 0)).replace(/(?:^|\/)\.(?:claude|cursor)$/, '');
  return (k === 'agents' || /(?:^|\/)BUGBOT\.md$/.test(p)) && dir ? [`${dir}/**`] : ['**'];
}

const build = (paths, read) => paths.map((p) => {
  let text = '';
  try { text = read(p); } catch { /* unreadable: scope stays everywhere */ }
  const k = kindOf(p);
  return { path: p, scope: scopeOf(p, text), kind: k, ...(k === 'cursor-rule' && cursorUnknown(text) && { unknown: true }) };
});

if (require.main === module) {
  const ctx = process.env.CTX;
  const listed = fs.readFileSync(path.join(ctx, 'standards.txt'), 'utf8').split('\n').filter(Boolean);
  // bytes and lines of each rule file as the model can read it, for the "Sources read" details
  const size = (e) => { try { const t = fs.readFileSync(e.path, 'utf8'); return { ...e, bytes: Buffer.byteLength(t), lines: t.split('\n').length - (t.endsWith('\n') ? 1 : 0) }; } catch { return e; } };
  fs.writeFileSync(path.join(ctx, 'standards-map.json'), JSON.stringify(build(listed, (p) => fs.readFileSync(p, 'utf8')).map(size), null, 2) + '\n');
}
module.exports = { matches, scopeOf, build };
