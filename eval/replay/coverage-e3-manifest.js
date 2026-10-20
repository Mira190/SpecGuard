#!/usr/bin/env node
// Builds eval/replay/coverage-e3-manifest.json (the `bugs` format eval/replay.js entries() reads) from the 40 `kind: bug` rows of coverage-e1-confirm.json, in file order. Offline except --fetch.
//   node eval/replay/coverage-e3-manifest.js --mine-dir <evidence>/testgap-confirm/per-repo-ext --text eval/replay/coverage-e3-pr-text.json [--fetch] [--out eval/replay/coverage-e3-manifest.json]
// Titles: the mining output (introducing[].title of the candidate that names the row's introducing sha). Bodies are not in the mining output: --text is a { id: { title, body } } cache that --fetch fills with
// `gh pr view <n> -R <repo> --json title,body` for the ids it lacks (read-only); a body missing from the cache is an error, never invented.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i < 0 ? d : process.argv[i + 1]; };
const here = (f) => path.join(__dirname, f);

// mine: { clone: parsed mine-<clone>.json } -> Map("clone#sha" -> mined PR title)
function titleIndex(mine) {
  const m = new Map();
  for (const [clone, j] of Object.entries(mine)) for (const c of j.candidates) for (const i of c.introducing || []) if (i.title && !m.has(`${clone}#${i.sha}`)) m.set(`${clone}#${i.sha}`, i.title);
  return m;
}
// rows: confirm rows; returns { bugs, missing: { titles: ids, bodies: ids } }. text: cache { id: { title, body } }
function build(rows, titles, text) {
  const bugs = [], missing = { titles: [], bodies: [] };
  for (const r of rows.filter((x) => x.kind === 'bug')) {
    const clone = r.repo.split('/')[1], i = r.introducing, t = titles.get(`${clone}#${i.head}`), tx = text[r.id];
    if (t == null) missing.titles.push(r.id);
    if (!tx || typeof tx.body !== 'string') missing.bodies.push(r.id);
    bugs.push({ clone, pr: i.number, repo: r.repo, introducing: i.head, base: i.base, title: t ?? '', body: tx && typeof tx.body === 'string' ? tx.body : '' });
  }
  return { bugs, missing };
}
function main() {
  const rows = JSON.parse(fs.readFileSync(here('coverage-e1-confirm.json'), 'utf8')).rows, textFile = arg('text', here('coverage-e3-pr-text.json'));
  let text = {}; try { text = JSON.parse(fs.readFileSync(textFile, 'utf8')); } catch { /* none yet */ }
  const mine = {};
  for (const clone of new Set(rows.filter((r) => r.kind === 'bug').map((r) => r.repo.split('/')[1]))) mine[clone] = JSON.parse(fs.readFileSync(path.join(arg('mine-dir'), clone, `mine-${clone}.json`), 'utf8'));
  const titles = titleIndex(mine);
  if (process.argv.includes('--fetch')) {
    for (const r of rows.filter((x) => x.kind === 'bug' && !(text[x.id] && typeof text[x.id].body === 'string'))) {
      text[r.id] = JSON.parse(execFileSync('gh', ['pr', 'view', String(r.introducing.number), '-R', r.repo, '--json', 'title,body'], { encoding: 'utf8' }));
      console.error('fetched', r.id);
    }
    fs.writeFileSync(textFile, JSON.stringify(text, null, 1) + '\n');
  }
  const { bugs, missing } = build(rows, titles, text);
  console.log(JSON.stringify({ bugs: bugs.length, missing }));
  if (missing.titles.length || missing.bodies.length) throw new Error('titles/bodies missing, nothing written (use --fetch for bodies)');
  fs.writeFileSync(arg('out', here('coverage-e3-manifest.json')), JSON.stringify({ bugs, controls: [] }, null, 1) + '\n');
}
if (require.main === module) main();
module.exports = { titleIndex, build };
