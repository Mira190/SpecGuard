#!/usr/bin/env node
// Last step of the action (fail_on_error: true): a manual run that could not complete goes red; an incomplete one only warns.
// Reads STATUS (complete | incomplete | failed | empty) and REASON from the environment; exits 1 on failed.
const esc = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const { STATUS = '', REASON = '' } = process.env;
if (STATUS === 'failed') {
  console.log(`::error::SpecGuard could not complete: ${esc(REASON || 'see the job summary')}`);
  process.exit(1);
}
if (STATUS === 'incomplete') console.log(`::warning::SpecGuard result is incomplete${REASON ? `: ${esc(REASON)}` : ' (see the job summary)'}`);
