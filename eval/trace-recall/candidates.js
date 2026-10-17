// The collect.sh `candidates()` step as the harness runs it, and the checks that make a silent failure loud. No network; unit-tested.
'use strict';

// collect.sh's `candidates()` is an inline node heredoc; run that very text so the harness cannot drift from it.
function extractCandidates(sh) {
  const m = /candidates\(\) \{[^\n]*<<'JS'\n([\s\S]*?)\nJS\n/.exec(sh.replace(/\r\n/g, '\n'));
  if (!m) throw new Error('cannot find the candidates() heredoc in collect.sh');
  return m[1] + '\n';
}

// `run` is the spawnSync result. An empty list is a measured result (Hit = 0), not a failure; only the step itself failing throws.
function checkCandidates(id, run) {
  if (run.error || run.status !== 0) throw new Error(`candidates step failed for ${id}: ${run.error || `exit ${run.status}`} ${(run.stderr || '').split('\n')[0]}`.trim());
}

// `codeVariants`: [{ id, text }] for the variants that change code. All of them empty means the extraction broke, not that retrieval missed.
function checkNotAllEmpty(codeVariants) {
  if (codeVariants.length && codeVariants.every((v) => !v.text.trim())) throw new Error(`candidates step wrote no test-candidates.txt for any of the ${codeVariants.length} code variants`);
}

module.exports = { extractCandidates, checkCandidates, checkNotAllEmpty };
