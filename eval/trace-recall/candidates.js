// The collect.sh `candidates()` step as the harness runs it, and the checks that make a silent failure loud. No network; unit-tested.
'use strict';

// collect.sh's `candidates()` is an inline node heredoc; run that very text so the harness cannot drift from it.
function extractCandidates(sh) {
  const m = /candidates\(\) \{[^\n]*<<'JS'\n([\s\S]*?)\nJS\n/.exec(sh.replace(/\r\n/g, '\n'));
  if (!m) throw new Error('cannot find the candidates() heredoc in collect.sh');
  return m[1] + '\n';
}

// `run` is the spawnSync result; `written` the text of test-candidates.txt ('' when absent); `expectCode`: the variant changed non-test code, so the step must list it.
function checkCandidates(id, run, written, expectCode) {
  if (run.error || run.status !== 0) throw new Error(`candidates step failed for ${id}: ${run.error || `exit ${run.status}`} ${(run.stderr || '').split('\n')[0]}`.trim());
  if (expectCode && !written.trim()) throw new Error(`candidates step wrote no test-candidates.txt for ${id}, which changes code`);
}

module.exports = { extractCandidates, checkCandidates };
