#!/usr/bin/env node
// Last step of the action (fail_on_error: true): a manual run that could not complete goes red; an incomplete one only warns.
// Reads STATUS (complete | incomplete | failed | empty) and REASON from the environment; exits 1 on failed. An incomplete status whose counts.json (in CTX, written by post.js) says reduced is a fast-tier review, not a broken one.
const fs = require('node:fs');
const path = require('node:path');
const esc = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const { STATUS = '', REASON = '', CTX = '' } = process.env;
const reduced = () => { try { return JSON.parse(fs.readFileSync(path.join(CTX, 'counts.json'), 'utf8')).reduced === true; } catch { return false; } };
if (STATUS === 'failed') {
  console.log(`::error::SpecGuard could not complete: ${esc(REASON || 'see the job summary')}`);
  process.exit(1);
}
if (STATUS === 'incomplete' && CTX && reduced()) console.log('::warning::SpecGuard ran a reduced review (fast-tier model): only high-confidence findings are shown (see the job summary)');
else if (STATUS === 'incomplete') console.log(`::warning::SpecGuard result is incomplete${REASON ? `: ${esc(REASON)}` : ' (see the job summary)'}`);
