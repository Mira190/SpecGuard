#!/usr/bin/env node
// Last step of the action, on every non-cancelled run. A configuration failure (auth, quota, model: only the owner can fix it, a retry or a new push cannot) always goes red.
// Any other failed run goes red only with FAIL_ON_ERROR=true (manual runs); otherwise it warns. An incomplete one only warns.
// Reads STATUS (complete | incomplete | failed | empty), REASON and FAIL_ON_ERROR from the environment, and the failure class (first line of engine-error, written by the engine) from CTX. An incomplete status whose counts.json (in CTX, written by post.js) says reduced is a fast-tier review, not a broken one.
const fs = require('node:fs');
const path = require('node:path');
const esc = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const { STATUS = '', REASON = '', CTX = '', FAIL_ON_ERROR = '' } = process.env;
const ctxFile = (n) => { try { return fs.readFileSync(path.join(CTX, n), 'utf8'); } catch { return ''; } };
const reduced = () => { try { return JSON.parse(ctxFile('counts.json')).reduced === true; } catch { return false; } };
const CONFIG = ['auth', 'quota', 'model'];
if (STATUS === 'failed') {
  const cls = ctxFile('engine-error').split('\n')[0].trim();
  if (CONFIG.includes(cls)) {
    console.log(`::error::SpecGuard could not run the model (${cls}): ${esc(REASON || 'see the job summary')}`);
    process.exit(1);
  }
  if (FAIL_ON_ERROR === 'true') {
    console.log(`::error::SpecGuard could not complete: ${esc(REASON || 'see the job summary')}`);
    process.exit(1);
  }
  console.log(`::warning::SpecGuard could not complete${cls ? ` (${esc(cls)})` : ''}: ${esc(REASON || 'see the job summary')}`);
}
else if (STATUS === 'incomplete' && CTX && reduced()) console.log('::warning::SpecGuard ran a reduced review (fast-tier model): only high-confidence findings are shown (see the job summary)');
else if (STATUS === 'incomplete') console.log(`::warning::SpecGuard result is incomplete${REASON ? `: ${esc(REASON)}` : ' (see the job summary)'}`);
