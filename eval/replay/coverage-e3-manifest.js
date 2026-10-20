#!/usr/bin/env node
// Builds eval/replay/coverage-e3-manifest.json (the `bugs` format eval/replay.js entries() reads) from the 40 `kind: bug` rows of coverage-e1-confirm.json, in file order. Read-only gh calls only.
//   node eval/replay/coverage-e3-manifest.js --repos <clones dir> [--text eval/replay/coverage-e3-pr-text.json] [--out eval/replay/coverage-e3-manifest.json]
// PR text mirrors prText in testgap-confirm-build.js: the introducing PR's own GitHub title and body (cache key `${repo}#${pr}`, fetched via `gh api repos/<repo>/pulls/<n>`); on a failed fetch the
// commit subject of the introducing head and an empty body (pr_text 'commit', counted in pr_text_fallback).
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i < 0 ? d : process.argv[i + 1]; };
const here = (f) => path.join(__dirname, f);

// rows: confirm rows; cache: { "repo#pr": { title, body } | { failed: true } }; subject(clone, head): commit subject fallback
function build(rows, cache, subject) {
  let fallback = 0;
  const bugs = rows.filter((x) => x.kind === 'bug').map((r) => {
    const clone = r.repo.split('/')[1], i = r.introducing, t = cache[`${r.repo}#${i.number}`] || { failed: true }, e = { clone, pr: i.number, repo: r.repo, introducing: i.head, base: i.base };
    if (t.failed) { fallback++; return { ...e, title: subject(clone, i.head), body: '', pr_text: 'commit' }; }
    return { ...e, title: t.title || '', body: t.body || '', pr_text: 'github' };
  });
  return { bugs, pr_text_fallback: fallback };
}
function main() {
  const rows = JSON.parse(fs.readFileSync(here('coverage-e1-confirm.json'), 'utf8')).rows, textFile = arg('text', here('coverage-e3-pr-text.json'));
  let cache = {}; try { cache = JSON.parse(fs.readFileSync(textFile, 'utf8')); } catch { /* none yet */ }
  for (const r of rows.filter((x) => x.kind === 'bug')) {
    const key = `${r.repo}#${r.introducing.number}`;
    if (cache[key]) continue;
    try { cache[key] = JSON.parse(execFileSync('gh', ['api', `repos/${r.repo}/pulls/${r.introducing.number}`, '--jq', '{title,body}'], { encoding: 'utf8', maxBuffer: 1 << 26 })); } // read-only
    catch { cache[key] = { failed: true }; }
  }
  fs.writeFileSync(textFile, JSON.stringify(cache, null, 1) + '\n');
  const subject = (clone, head) => execFileSync('git', ['-C', path.join(arg('repos'), clone), 'log', '-1', '--format=%s', head], { encoding: 'utf8' }).trim();
  const { bugs, pr_text_fallback } = build(rows, cache, subject);
  console.log(JSON.stringify({ bugs: bugs.length, pr_text_fallback }));
  fs.writeFileSync(arg('out', here('coverage-e3-manifest.json')), JSON.stringify({ bugs, controls: [], pr_text_fallback }, null, 1) + '\n');
}
if (require.main === module) main();
module.exports = { build };
