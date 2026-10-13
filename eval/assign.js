#!/usr/bin/env node
// Single source of truth for the validation arms (docs/validation-plan.md). The example workflow repeats this mapping in bash
// ($((N % 3))); eval/assign.test.js runs that snippet and compares it with this function.
//   arm 0 = SpecGuard only, arm 1 = native Copilot review only, arm 2 = both.
//   node eval/assign.js 17   ->  {"arm":2,"specguard":true,"copilot":true}
function assign(prNumber) {
  if (!Number.isInteger(prNumber) || prNumber < 1) throw new Error(`PR number must be a positive integer, got ${prNumber}`);
  const arm = prNumber % 3;
  return { arm, specguard: arm !== 1, copilot: arm !== 0 };
}
const LABEL = /^review-arm:([012])$/;
const armOf = (labels = []) => { for (const l of labels) { const m = LABEL.exec(typeof l === 'string' ? l : l && l.name); if (m) return +m[1]; } return null; };

if (require.main === module) {
  try { console.log(JSON.stringify(assign(+process.argv[2]))); } catch (e) { console.error(e.message); process.exit(2); }
}
module.exports = { assign, armOf };
