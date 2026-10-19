#!/usr/bin/env node
// Last step of the action, on every non-cancelled run. A configuration failure (auth, quota, model, budget: only the owner can fix it, a retry or a new push cannot) always goes red.
// Any other failed run goes red only with FAIL_ON_ERROR=true (manual runs); otherwise it warns. An incomplete one only warns.
// Reads STATUS (complete | incomplete | failed | empty), REASON and FAIL_ON_ERROR from the environment, and the failure class (first line of engine-error, written by the engine) from CTX. An incomplete status whose counts.json (in CTX, written by post.js) says reduced is a fast-tier review, not a broken one.
const fs = require('node:fs');
const path = require('node:path');
const esc = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const { STATUS = '', REASON = '', CTX = '', FAIL_ON_ERROR = '' } = process.env;
const ctxFile = (n) => { try { return fs.readFileSync(path.join(CTX, n), 'utf8'); } catch { return ''; } };
const reduced = () => { try { return JSON.parse(ctxFile('counts.json')).reduced === true; } catch { return false; } };
// CTX is fresh per run (.specguard-ctx in the workspace), so engine-error is never stale. policy: Copilot disabled by the org, only an admin can fix it.
const CONFIG = ['auth', 'quota', 'model', 'policy', 'internal', 'config', 'budget']; // budget: the engine refused a call whose worst case exceeds max_budget_usd, same inputs every PR; internal: the adapter itself threw, deterministic, never a retry
const [cls = '', why = ''] = ctxFile('engine-error').split('\n').map((l) => l.trim());
if (STATUS === 'incomplete' && CONFIG.includes(cls)) { // a multi-part scan where a part hit a configuration failure: the partial result is kept, the job still goes red
  console.log(`::error::SpecGuard could not finish the scan (${cls}): ${esc(why || REASON || 'see the job summary')}; the partial result was kept`);
  process.exit(1);
}
const json = (n) => { try { return JSON.parse(ctxFile(n)) || {}; } catch { return {}; } };
// scan_scope all (the collector says so in audit-meta.json): red only when something was NOT reviewed, i.e. parts or blocks not reached (budget, deadline), a failed call (scan-parts.json) or blocks the model was sent and did not answer (possibly after one retry) (audit-unanswered.json, audit-post.js) or eligible source files the inventory never reached (audit-inventory.json: over 512 KiB, past the cap, time budget);
// unsure verdicts on reviewed code (part of the tests, forced units, pack cuts) stay warnings
const unreviewed = () => {
  if (json('audit-meta.json').scan_scope !== 'all') return '';
  const sp = json('scan-parts.json'), nr = sp.notReached || {}, n = (k, f) => (nr[k] && nr[k][f]) || 0, failed = Array.isArray(sp.failed) ? sp.failed.length : 0, ua = json('audit-unanswered.json'), un = ua.blocks || 0, nu = ua.units || 0, inv = json('audit-inventory.json'), md = json('audit-meta.json'), od = md.docs_over_cap, pos = (k) => (Number.isInteger(md[k]) && md[k] > 0 ? md[k] : 0), iv = (k) => (Number.isInteger(inv[k]) && inv[k] > 0 ? inv[k] : 0), files = (n, what) => (n ? `${n} source file${n === 1 ? '' : 's'} ${what}` : '');
  return ['budget', 'deadline'].map((k) => (n(k, 'parts') || n(k, 'blocks') ? `${n(k, 'parts')} unit parts / ${n(k, 'blocks')} document blocks not reached (${k})` : '')).concat(failed ? `${failed} call${failed === 1 ? '' : 's'} failed` : '', un ? `${un} document block${un === 1 ? '' : 's'} not answered by the model` : '', nu ? `${nu} unit${nu === 1 ? '' : 's'} with no usable answer from the model` : '', Number.isInteger(od) && od > 0 ? `${od} requirement document${od === 1 ? '' : 's'} over the 60-document limit not reviewed` : '', pos('docs_over_size') ? `${pos('docs_over_size')} requirement document${pos('docs_over_size') === 1 ? '' : 's'} over 256 KiB not admitted` : '', files(pos('not_unit'), 'in scan_paths dropped by the default non-unit paths'), files(iv('not_inventoried'), 'over 512 KiB not inventoried'), files(iv('not_reached_cap'), 'past the inventory cap'), files(iv('not_reached_time'), 'unread when the inventory time budget ran out')).filter(Boolean).join('; ');
};
const missed = STATUS === 'incomplete' && FAIL_ON_ERROR === 'true' ? unreviewed() : '';
if (missed) {
  console.log(`::error::SpecGuard did not review the whole repository (scan_scope: all): ${esc(missed)}`);
  process.exit(1);
}
if (STATUS === 'failed') {
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
else if (STATUS === 'complete' && CTX && reduced()) console.log('::notice::SpecGuard ran a fast-tier review: only high-confidence findings are shown (see the job summary)');
else if (STATUS === 'incomplete' && CTX && reduced()) console.log('::warning::SpecGuard ran a reduced review (fast-tier model): only high-confidence findings are shown (see the job summary)');
else if (STATUS === 'incomplete') console.log(`::warning::SpecGuard result is incomplete${REASON ? `: ${esc(REASON)}` : ' (see the job summary)'}`);
