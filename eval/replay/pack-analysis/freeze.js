#!/usr/bin/env node
// Writes the fresh-corpus list of a step BEFORE any arm is computed on it (prereg amendment 1).
// usage: node freeze.js <evidence-dir> <step 1|2|3> <out.txt>
//   step 1: up to 30 latest first-parent commits per repo whose rule files at the commit's first parent total over one file cap (approximated here with the collector's STANDARDS globs)
//   step 2: commits 31-60 of the same qualifying list, same repos
//   step 3: the repos not in step 1, whatever the size of their rule files: latest 60 first-parent commits
// holdout-2 PRs (by number in the subject, by head sha) are excluded. Each line: repo, commit, first parent, subject.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { fileCap } = require('../../../src/pack-cap.js');
const [ev, stepArg, outFile] = process.argv.slice(2), step = +stepArg;
const git = (repo, args) => execFileSync('git', ['-C', repo, ...args], { maxBuffer: 1 << 29, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
const STANDARDS = ['.github/copilot-instructions.md', '.github/instructions/**', 'AGENTS.md', 'AGENT.md', 'CLAUDE.md', 'GEMINI.md', 'REVIEW.md', 'CONTRIBUTING.md', 'CODING_STANDARDS.md', '.editorconfig',
  ...['md', 'mdx', 'rst', 'txt', 'adoc'].flatMap((e) => [`docs/*standards*.${e}`, `docs/*conventions*.${e}`]), '.claude/rules/**', '.github/skills/**', '.claude/skills/**', '.agents/skills/**',
  '.cursorrules', '.cursor/rules/**', '.windsurfrules', '.clinerules/**', '.cursor/BUGBOT.md', 'BUGBOT.md', '.gemini/styleguide.md', '.greptile/rules.md'];
const IGN = /(^|\/)(node_modules|vendor|dist|build)\//;
// like collect.sh match(): * crosses '/', a pattern matches the whole path or any path suffix after a '/'
const re = (p) => new RegExp('(^|/)' + p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*+/g, '.*') + '$');
const pats = STANDARDS.map(re), isRule = (f) => pats.some((r) => r.test(f)) && !IGN.test(f);
const ruleBytes = (repo, sha) => git(repo, ['ls-tree', '-r', '-l', '-z', sha]).split('\0').filter(Boolean).reduce((n, l) => { const m = /^(\d+) blob \S+\s+(\d+)\t(.*)$/.exec(l); return m && m[1] !== '120000' && isRule(m[3]) ? n + +m[2] : n; }, 0);
const ex = new Map(), raw = path.join(ev, 'holdout2-raw');
for (const run of fs.readdirSync(raw)) for (const d of fs.readdirSync(path.join(raw, run))) {
  try { const r = JSON.parse(fs.readFileSync(path.join(raw, run, d, 'result.json'), 'utf8')), k = path.basename(r.repo); (ex.get(k) || ex.set(k, { pr: new Set(), sha: new Set() }).get(k)).pr.add(String(r.pr)); ex.get(k).sha.add(r.head); } catch { /* not a replay dir */ }
}
const repos = fs.readdirSync(path.join(ev, 'repos')).sort(), cap = fileCap(250000), repoDir = (r) => path.join(ev, 'repos', r), lines = [];
const recent = (repo, n, qualify) => {
  const out = [], e = ex.get(repo) || { pr: new Set(), sha: new Set() };
  for (const l of git(repoDir(repo), ['log', '--first-parent', '--format=%H %P|%s', '-n', '3000']).split('\n').filter(Boolean)) {
    const h = l.slice(0, 40), [parents, subj] = l.slice(41).split('|'), p1 = parents.split(' ')[0];
    if (!p1 || e.sha.has(h) || [...subj.matchAll(/#(\d+)/g)].some((m) => e.pr.has(m[1]))) continue;
    if (qualify && ruleBytes(repoDir(repo), p1) <= cap) continue;
    out.push([repo, h, p1, subj.replace(/\t/g, ' ')]);
    if (out.length >= n) break;
  }
  return out;
};
const q = new Set(repos.filter((r) => recent(r, 1, true).length));
if (step === 1) for (const r of q) lines.push(...recent(r, 30, true));
if (step === 2) for (const r of q) lines.push(...recent(r, 60, true).slice(30));
if (step === 3) for (const r of repos) if (!q.has(r)) lines.push(...recent(r, 60, false));
fs.writeFileSync(outFile, `# fresh corpus step ${step}; repo, commit, first parent, subject. Frozen before any arm was computed on it.\n` + lines.map((l) => l.join('\t')).join('\n') + '\n');
console.log(`step ${step}: ${lines.length} commits in ${new Set(lines.map((l) => l[0])).size} repos; qualifying repos: ${[...q].join(',')}`);
