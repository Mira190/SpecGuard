#!/usr/bin/env node
// Single source of truth for the validation arms (docs/validation-plan.md). The example workflow repeats this mapping in bash
// (openssl); eval/assign.test.js runs that snippet and compares it with this function.
//   With a salt (env SPECGUARD_ARM_SALT, a secret): arm = first 4 bytes of HMAC-SHA256(salt, PR number) as an unsigned int, mod 3, so an
//   author cannot pick an arm by choosing the PR number. Without a salt: PR number % 3 (predictable; the workflow warns).
//   arm 0 = SpecGuard only, arm 1 = native Copilot review only, arm 2 = both.
//   node eval/assign.js 17   ->  {"arm":2,"specguard":true,"copilot":true}
const crypto = require('node:crypto');
function assign(prNumber, salt = process.env.SPECGUARD_ARM_SALT) {
  if (!Number.isInteger(prNumber) || prNumber < 1) throw new Error(`PR number must be a positive integer, got ${prNumber}`);
  const arm = salt ? crypto.createHmac('sha256', salt).update(String(prNumber)).digest().readUInt32BE(0) % 3 : prNumber % 3;
  return { arm, specguard: arm !== 1, copilot: arm !== 0 };
}
const LABEL = /^review-arm:([012])$/;
const armOf = (labels = []) => { for (const l of labels) { const m = LABEL.exec(typeof l === 'string' ? l : l && l.name); if (m) return +m[1]; } return null; };

if (require.main === module) {
  try { console.log(JSON.stringify(assign(+process.argv[2]))); } catch (e) { console.error(e.message); process.exit(2); }
}
module.exports = { assign, armOf };
