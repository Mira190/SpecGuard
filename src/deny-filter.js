// stdin: one path per line. stdout: those matching the claude-api DENY list (secret-like files). Single source of truth for collect.sh.
const { DENY } = require('./deny.js');
const out = require('node:fs').readFileSync(0, 'utf8').split('\n').filter((p) => p && DENY.test(p));
if (out.length) process.stdout.write(out.join('\n') + '\n');
