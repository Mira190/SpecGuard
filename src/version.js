// Which SpecGuard produced a report (review F12): the ref the workflow used (a branch like main says little) and a build id, the hash of the files that
// decide the result (the non-test src code, the schemas, the skills), so two reports from the same build are comparable whatever the ref was.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.join(__dirname, '..');
function files(dir) {
  let out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out = out.concat(files(p));
    else if (!/\.test\.js$/.test(e.name) && !p.includes(`${path.sep}fixtures${path.sep}`)) out.push(p);
  }
  return out;
}
let cached = null;
// -> { ref, build }: ref from SPECGUARD_REF (action.yml: github.action_ref), '' when unknown; build = sha1 over the relative paths and LF-normalised contents, 12 hex
function version(env = process.env) {
  if (!cached) {
    const h = crypto.createHash('sha1');
    try {
      for (const p of ['src', 'skills'].flatMap((d) => files(path.join(ROOT, d))).sort()) h.update(`${path.relative(ROOT, p).split(path.sep).join('/')}\0${fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n')}\0`);
      cached = h.digest('hex').slice(0, 12);
    } catch { cached = ''; }
  }
  return { ref: /^[\w./-]{1,100}$/.test(env.SPECGUARD_REF || '') ? env.SPECGUARD_REF : '', build: cached };
}
const versionLine = (v = version()) => `SpecGuard build ${v.build || 'n/a'}${v.ref ? ` (ref ${v.ref})` : ''}`;

module.exports = { version, versionLine };
