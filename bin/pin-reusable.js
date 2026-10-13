#!/usr/bin/env node
// Rewrites the `# specguard-pin` line of .github/workflows/specguard.yml: node bin/pin-reusable.js [sha|ref] [owner/repo]
// sha defaults to HEAD (the commit before the one that carries the new pin), repo to the one already in the file (pass owner/repo when this repository was copied under another name).
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const LINE = /^( *- uses: )([\w.-]+\/[\w.-]+)@([0-9a-f]{40})( # specguard-pin)/m;

function pin(text, sha, repo) {
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error('not a full commit sha: ' + sha);
  if (repo && !/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('not owner/repo: ' + repo);
  if (!LINE.test(text)) throw new Error('no "# specguard-pin" line found');
  return text.replace(LINE, (_, a, r, _s, c) => `${a}${repo || r}@${sha}${c}`);
}

if (require.main === module) {
  const file = path.join(__dirname, '..', '.github', 'workflows', 'specguard.yml');
  const sha = execFileSync('git', ['rev-parse', process.argv[2] || 'HEAD'], { cwd: path.dirname(file), encoding: 'utf8' }).trim();
  const out = pin(fs.readFileSync(file, 'utf8'), sha, process.argv[3]);
  fs.writeFileSync(file, out);
  console.log('pinned ' + LINE.exec(out).slice(2, 4).join('@'));
}

module.exports = { pin, LINE };
