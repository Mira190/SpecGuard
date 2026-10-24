# Full-repo shift-left audit: latest main, in-review fixes and new counterexamples

What this repo does: at the PR stage SpecGuard links requirements, code, tests and repository rules, flags missing or weak unit tests, and also provides a whole-repo rotating scan. The goal is to find actionable gaps before QA; static review itself does not execute tests and cannot prove behavior is correct. This review looks at actual usage with the default scan limits, a 250,000-byte API pack, large source/test files, continuous commits and scan results saved across repositories.

Date: 2026-10-16, Australia/Sydney. Nature: whole-repo risk audit; only a report is committed, and no product code is changed.

## 1. Version and conclusions

**The formal baseline this time is the latest `origin/main` after a fresh fetch, not the branch snapshot of the previous report.** Fetched again at 18:06 AEDT on 2026-10-16; neither main nor the heads of the two fixes below have changed.

| Object | Pinned commit | Verification method this time |
|---|---|---|
| main | `ee1c15812bae4315f39ce7d5bf1bf7511ac58553` | First run of the full offline test suite, re-test of the failures, 10 deterministic counterexamples |
| [PR #197](https://github.com/Mira190/SpecGuard/pull/197), raise low confidence after an assertion is deleted | `b1aaf113aae3ca69fcc70e7b9026130affa6c30f` | The whole diff against main; it was not treated as merged code, and it is not claimed that its full test set was run |
| [PR #198](https://github.com/Mira190/SpecGuard/pull/198), sharding by pack budget | `c77841d638a7ce1e3de8280fdad6539a05653d1c` | Source of this commit exported independently; re-ran 5 new counterexamples and 7 earlier ones |

The `a90608c` used by the previous [re-review report](https://github.com/Mira190/SpecGuard/blob/60a3028e265b40f7c016129f87f2593d15c1f369/docs/shift-left-rereview-2026-10-16.md) is an earlier commit of #198 and **is not the latest main**. This document corrects the version attribution and re-verifies its conclusions, and does not carry the old test numbers over as verification results for the new baseline.

**Conclusion: it cannot currently be concluded that the key quality constraints of shift-left have closed.** This time 11 problems are confirmed: 6 earlier ones, F19–F24, still have a reproduction basis; plus 5 new counterexamples F25–F29. "New" here is relative to the previous re-review; it is not a claim that nobody ever raised them before, nor a proof that all unknown unknowns have been found.

What needs to be plugged first: when evidence is lost, output validation fails, requirement identity is mismatched, or historical state is stale, a "complete/covered" conclusion can still be left behind. Next is making sure the scan really advances, that the test-path configuration is consistent along the whole chain, and that the evaluation does not count the same finding twice. Expanding the prompt, increasing the model budget or continuing to pile up the number of tests cannot substitute for these constraints.

## 2. First principles and the whole-repo coverage scope

The repository's original goal is: review requirements and tests, find missing unit tests, confirm the coding standards, and identify high-level tests that can be pushed down to the unit layer. The corresponding necessary conditions are:

1. **Requirement identity is correct.** The test evidence for one requirement cannot pass for another requirement; changing an operator, letter case or value may also change the contract.
2. **Evidence is sufficient and belongs to the current version.** "Not found" must distinguish no gap, not seen, not answered, and not verified successfully.
3. **A negative conclusion needs stronger evidence than a positive one.** Finding one real assertion proves only that this one assertion exists; "no test" requires searching for the related tests, and a cut cannot automatically turn into non-existence.
4. **Incremental scanning covers the current version.** A cursor is meaningful only when bound to the content version and the shard layout; repeated runs must be able to widen the reviewed scope.
5. **Feedback happens at an actionable moment, and effectiveness metrics keep identity.** Moving the same finding into the summary or showing it one more time should not change recall; modifying a related line also does not mean the defect has been fixed.

These are the invariants used by this audit, not a new product framework. Trying to break them with the smallest input changes finds system-boundary problems more easily than repeating existing happy-path cases.

| Whole-repo path | Boundary and evidence checked | Conclusion this time |
|---|---|---|
| README, package, `action.yml`, `.github/workflows/ci.yml`, `specguard-run.yml` | Entry points, input passing, event/branch restrictions, permissions, CI and the local run environment | main and the in-review fixes are kept apart; the test paths and cross-repo state reading are not consistent along the whole chain |
| `collect.sh`, `requirements.js`, `trace.js`, `test-map.js`, `leads.js` | Document discovery, requirement identity, candidate tests, assertion leads, explicit budgets and heuristic boundaries | A declared heuristic limitation alone is not counted as a new bug; a semantic change erased by identity normalization is an empirical problem |
| `audit-collect.js`, `audit-units.js`, `scan-parts.js` | Requirement rotation, source sharding, versions, evidence retrieval, cross-round state | F22–F28; includes both the documented and the undocumented code-first paths |
| `prompt.js`, the two product skills, `engines/claude-api.js` and the engine shells | The API no-file-tool constraint, context packing, batching, budget/failure propagation, read-only tool arguments | The current sharding and the test slicing are out of sync; the single-batch / multi-batch evidence conventions are inconsistent; the read-only arguments were checked, but no real model attack test was done |
| `post.js`, `audit-post.js`, schema, `preflight.js` | Output validation, citations, publishing, complete/unknown, cache and issue state | F19–F21; the counterexamples go through the real publisher, with the GitHub API as a local mock |
| `bin/specguard-local.js`, `coverage.js` | Local early feedback, reuse of CI's input/post-processing, coverage input boundaries | Read the key chain and ran the related tests; speculation such as injecting an old coverage report, whose argument was not completed, is not listed as a vulnerability |
| `eval/grade.js`, `weekly-report.js`, `label-export.js`, replay/seeded tests and validation docs | Metric identity, summary/inline presentation, real fixes versus proxy metrics | F29; the weekly inline sample boundary is already documented, and cannot be extrapolated to the validity of all summary feedback |

"Whole repo" means an end-to-end review across entry, collection, inference context, validation, state, publishing, local use and evaluation. It is not a claim that every fixture, historical research document and shell branch was read line by line; the chains that could cause false reassurance, missed detection or scan stalls were read deeply. The latest behavior of external SDKs was not verified online; this document states only the repository configuration about them and cites no external product guarantees.

## 3. Must fix

### 1. [P1] F19: PR evidence is cut, yet complete is still published and a clean conclusion is cached

- **What this is:** `src/post.js:1469–1476` reads `pack-cut.txt`, but mainly uses it to suppress existing missing/weak findings; `1710–1729` decides completeness and the head marker.
- **Problem:** With the source and the tests both in pack-cut, and a covered output whose citations can be verified on disk, the real publisher still returns `complete=true`, `execution_complete=true`, shows `No unit test gaps found` and writes the head marker; the real preflight then skips the same head. That a citation exists on disk cannot prove the model saw the context it needed.
- **Fix:** Feed the loss of context that affects this round's obligations into the completion and obligation state; stop this kind of result from entering the complete head cache. Keep verifiable local findings, but do not give the whole review a complete endorsement on that basis.
- **If we skip it:** The user sees a reassuring signal, re-running the same commit is skipped, and the chance of finding a defect before QA is shut off directly. Reproduced on both main and #198; the #197 diff does not change this completion/cache constraint.

Evidence: Appendix B `P6_PR_pack_cut`, `status=complete`, `cleanVerdict=true`, `headMarker=true`, `nextRunSkip=true`.

### 2. [P1] F20: After an invalid finding is deleted, the unit is written as covered

- **What this is:** `src/audit-post.js:150–169` validates the unit finding; `383–386` derives the unit state from the retained findings; `752–760` publishes and persists.
- **Problem:** The only missing_test of a selected unit lacks a title; the validator correctly deletes it and leaves a note; the publisher, however, treats "no valid finding" as "no gap", returns complete, and writes covered into the issue state.
- **Fix:** Link the validation failure back to the specific unit so that it stays unknown/incomplete, and does not advance covered or the confirmation count; add a case that goes through validate → verify → publish → readState.
- **If we skip it:** A single structural error by the model can wash a gap out of the scan's to-do list, and later rotation will treat it as reviewed. Reproduced on both main and #198.

Evidence: Appendix B `P5_invalid_finding`; the note is indeed visible, but the output is `complete` and the persisted state is `covered`. So merely adding a visible warning is not enough to fix it.

### 3. [P1] F21: A requirement cid is not bound to its own source block

- **What this is:** `src/audit-post.js:228–238` validates that the source is in an approved document and the citation exists, and then uses the cid to find the heading.
- **Problem:** A requires rejecting negative numbers, B requires accepting positive numbers; both legal cids cite B and the same positive-number assertion, and after validation both are covered, with no warning. A real source does not mean the source belongs to this requirement.
- **Fix:** Bind the source to the candidate's document and block range; for the `.N` sub-items of a bundled block, use the boundary of the same parent block. A mismatched row goes back to the unknown of its own cid, and must not be filled in with another requirement.
- **If we skip it:** A positive happy path can pass for the test of a negative boundary; R→T traceability looks complete, while the core goal is actually missed. Reproduced on both main and #198.

Evidence: Appendix B `P4_requirement_identity`; `aaaaaaaa` and `bbbbbbbb` both point to `B.md`, both rows are `covered`, and warnings are empty.

### 4. [P1] F22: The shard cursor is still used after the content or the layout changes

- **What this is:** partOf in `src/audit-units.js:63–68` uses an integer cursor; although the state contains `uv`, it does not invalidate the old cursor here.
- **Problem:** In main, a 600-line sample first reads 1–300, then after line 1 is modified continues with 301–600, ends up covered, and never re-reads the modified line. On #198 the same content becomes three parts and still reproduces; furthermore, changing `max_units` from 12 to 1 changes the interpretation of the same cursor from "the next part starts at 121" to "starts at 201", and 121–200 are never read.
- **Fix:** Clear the progress when the content version changes; reset also when a budget change alters the layout, or persist a verifiable layout/range. The minimal fix prefers reset, with no need to build a complex coverage ledger first.
- **If we skip it:** "Finished reading the file" over multiple scan rounds holds only in the sense of splicing together different versions and different layouts; the current version can miss a segment and still show covered. The layout-change counterexample belongs to #198 and must not be mistaken for main's adaptive sharding behavior.

Evidence: Appendix B `P1_cursor_after_edit`; the original counterexample of #198 `P2_cursor_after_budget_change`: `1–120 → 201–400`, with unread range `[121,200]`.

### 5. [P1] F25 (new): A requirement operator change is treated as the same already-covered requirement

- **What this is:** `src/audit-collect.js:69,91` lowercases the block text and then turns all non-alphanumeric characters into spaces as the hash input of the cid; `113` uses the cid to decide on newly changed requirements.
- **Problem:** `Service must accept amounts >= 10.` changed to `> 10.` still has cid `090622e0`. In a sample with one old gap awaiting confirmation and only 1 selected per round, collect picks the old gap and carries the changed boundary requirement; stateOf still keeps its covered. The code and the tests are unchanged, so evidence-version detection cannot replace requirement-version detection either.
- **Fix:** The content normalization of the cid ignores only semantically meaningless formatting, and does not discard operators, symbols and case-sensitive literals; on migration, make the existing coverage state go through review again. Add state-level cases for `>= → >`, `-1 → 1` and case-sensitive values, rather than testing only the hash function.
- **If we skip it:** A boundary error where "only the requirement changed and CI stays green" does not get changed priority and also carries the old reassuring state. This is exactly the kind of change shift-left should find first; later ordinary rotation might find it, which cannot be described as never being scanned again.

Evidence: Appendix A `N1-semantic-requirement-change`. The comparison-operator counterexample executed and passed on both main and #198; the other symbol changes are suggested acceptance vectors, and do not pass for evidence run this time.

### 6. [P1] F27 (new): Reads the later half of the code but packs the tests of only the first 40 symbols

- **What this is:** unitSymbols at `src/engines/claude-api.js:222–224` takes up to 40 symbols from the start of the whole file; source packing obeys unitPart separately, while the test slicing still uses the whole-file symbols.
- **Problem:** For a file with 200 functions, the real inventory selects source range 101–200 this round. The pack has the implementation of `unit170` but not the `assert.equal(unit170(...))` that actually exists; it loads the first half of the tests, and `notWhole=[]`. The slices' "complete" only proves that the tests of the symbols it selected were read completely; it does not prove that the tests of this round's source were read completely.
- **Fix:** Extract the symbols from the current part first, and then choose the test windows; when the symbol cap, aliases or slices cannot cover the current range, propagate unknown/cut. Verify with a large test file that has real second-half assertions; it is not enough to assert only that the source window fits.
- **If we skip it:** Existing tests may be reported as missing, or a no-gap conclusion lacking the relevant context may be accepted. What was measured proves loss of evidence and a wrong completeness marker; no real model was called to claim that some false positive is certain to be generated.

Evidence: Appendix A `N3-current-part-test-slices`; main and #198 both have `currentSourceVisible=true`, `currentAssertionVisible=false`, `notWhole=[]`.

### 7. [P1] F28 (new): With 20 requirements the evidence body is dropped, while with 21 it can be read

- **What this is:** `src/scan-parts.js:15` returns null when the candidates do not exceed the batch; the regular contextPack in `claude-api.js:179–249` does not load the requirement evidence files according to `audit-evidence.txt`. The multi-batch path explicitly loads them with windowPack.
- **Problem:** In a hand-constructed sample with `audit-evidence.txt` citing `config/policy.yaml` and with no corresponding selected code unit, at 20 candidates the body does not enter the pack, and `notWhole=[]`; at 21 the same evidence is correctly loaded by the block-part path. This sample isolates and verifies the consumer's packing difference; it does not prove the automatic collector would detect that YAML. The short digest in the evidence candidates cannot substitute for the context, and the API model has no file tool to read it again.
- **Fix:** Single-batch and multi-batch share the loading/missing records of block evidence; when there is only one batch, the same context rule is also applied. Test batch−1, batch and batch+1, requiring that the visibility of the evidence needed by the same obligation is not affected by this threshold.
- **If we skip it:** Small documents are in fact more likely to lack verification material. If the model obeys the prompt, the detection rate drops; if the model judges directly, post-processing also lacks blockCuts to force convergence to unknown.

Evidence: Appendix A `N4-evidence-at-batch-boundary`. Both main and #198 reproduce the packing difference of the hand-built input above. **Correction 2026-10-16:** the original statement that "evidence search has clearly found it" was inaccurate; the collector's `NOT_EVIDENCE` excludes YAML/JSON. The later [research report section 6 and Q8](research-repo-audit-requirements-chunking-2026-10-16.md#6-evidence-correction-and-reinforcement-for-f28-in-the-previous-report) uses JavaScript evidence produced by the real collector, reproduces on main that the default single-batch pack lacks the body with `notWhole=[]`, and reinforces the core problem of F28; that new experiment is not described as having re-verified #198.

### 8. [P1] F23: The source packing guarantee of #198 does not guarantee scan progress

- **What this is:** #198 `c77841d` lets the source fragments of multiple units enter the pack first; `src/audit-post.js:739,759–760` does not advance the corresponding unit when any matched test is cut.
- **Problem:** In a fixed sample of 8 units, each with about 23 KB of tests plus a rules document, and a 250,000-byte pack: source cut 0, test cut 8, unseen units 8, written state 0. The next inventory selects exactly the same units and parts.
- **Fix:** Allocate the budget by the "source range + related tests + rules" that can complete one unit, reduce the number selected this round, or advance the full context in batches; for the same input, endless retry of the same piece without any notice is not acceptable. Do not ignore unread tests in order to advance the cursor.
- **If we skip it:** The source-pack test is all green, while the scheduled scan repeatedly spends budget without widening the review scope. This item reports the fix boundary of the latest #198, and does not claim main has adopted that source-first algorithm.

Evidence: running the complete script of the previous report on the exported source of #198, `P7_scan_stall={sourceFilesCut:0,testFilesCut:8,unseenUnits:8,stateBlocks:0,samePartsNextRun:true}`.

## 4. Should fix

### 9. [P2] F26 (new): A configured test location is not counted as a test again by the validator

- **What this is:** `audit-collect.js:44–60` and `audit-units.js:85–89` accept the authoritative `test_paths`; `audit-post.js:36,231–232,283` judges only by a file-name heuristic.
- **Problem:** With `qa/checks/**` configured, collect recognizes and matches `qa/checks/amount.js` as a test; the genuinely valid `assert.equal(amount(10), true)` is deleted at verify, and covered drops to unknown. weak_test/pushdown references to similar paths face the same classification boundary.
- **Fix:** Pass the same testScope to verify/verifyUnits and the cover guard; when a configuration exists, uniformly adopt the owner's scope and exclusion rules. Add a non-standard-directory case that goes from the action configuration all the way to the final verdict.
- **If we skip it:** The user has explicitly told the system where the tests are, and the system still cannot recognize that evidence; missed weak-test feedback, long-term unknown and repeated manual explanations will hurt adoption. What is reproduced is covered→unknown, and it is not exaggerated into a false covered.

Evidence: Appendix A `N2-authoritative-test-paths`; main and #198 both have `collectorMatchedTest=true`, `verifiedTests=0`.

### 10. [P2] F29 (new): The summary and the evidence table each count one TP for the same finding

- **What this is:** `eval/grade.js:97–104` makes a candidate of each of the summary item and the coverage row; `usedHits` only limits how many times a candidate is used and does not link the two presentations of the same finding.
- **Problem:** Using the real `post.buildSummary` to generate one missing_test, it naturally shows up in both the body and the obligation table. When two gaps A and B are expected, grade gets `tp=2,fn=0,pass=true`; remove the mirrored table of the same finding and it becomes `tp=1,fn=1`. The summary allows matching by path/kind and does not apply the same line-distance constraint, so B can eat A's mirror.
- **Fix:** One logical finding has only one matching identity; when the body already represents the obligation, the table can no longer be an independent hit. Keep the summary landing-position tolerance, but require identity/behavior matching, not just the same path and type; inline and summary also need a check for duplicate presentation.
- **If we skip it:** A change in UI presentation can inflate recall/pass, and a team claiming shift-left has improved on that basis is not credible. This is an evaluator bug, not a statement that a real business metric was observed to be raised.

Evidence: Appendix A `N5-mirrored-summary-double-count`. Reproduced on both main and #198; it is not a hand-written output format that does not exist.

### 11. [P2] F24: Cross-repo issue publishing and the previous round's state reading point to different repositories

- **What this is:** The action's scan publisher supports `scan_issue_repo` / a separate token; loadPrior at `src/audit-collect.js:292–308` looks up only by the source repository and the default scope.
- **Problem:** With source repo `org/source` and target `org/reports`, and the prior state stored in the target issue, the actual loader requests only `/repos/org/source/issues` and returns null. Even supplying `ISSUE_REPO` directly to the loader does not use it; the action's collection step also does not pass in that target and token.
- **Fix:** Collection and publishing share the target resolution, scope/title and the target read credentials; verify the complete closed loop from source repo to target repo, keeping the existing visibility guard.
- **If we skip it:** The published report looks successful, yet the next round again starts from the front; the lower-risk tail gets no review for a long time, and when multiple source repos share one report repo the source identity also has to be told apart correctly.

Evidence: Appendix B `P3_external_state`. All HTTP is mocked, and no issue was written to any real repository. Reproduced on both main and #198.

## 5. From findings to acceptable fixes

The whole system need not be refactored first. It is suggested to submit small fixes in the dependency order below, each step keeping the counterexample that proves the wrong behavior:

| Order | Acceptance condition that must hold | Corresponding findings |
|---|---|---|
| 1: trustworthy conclusion | When there is unread evidence / invalid output related to an obligation, no complete cache or covered is written; valid local findings are still kept | F19, F20 |
| 2: identity and version | A cannot be covered by borrowing B's source; a changed requirement contract must be reviewed again; a content or layout change cannot reuse old progress | F21, F22, F25 |
| 3: can see it and can advance | The actual tests of the current source fragment are read; the evidence rule is the same before and after the batch threshold; under the default pack multiple rounds can widen the review scope | F23, F27, F28 |
| 4: configuration closed loop | The configuration of a non-standard test directory still takes effect in the final validation; state is read and written for the same target and the same source identity | F24, F26 |
| 5: trustworthy metrics | A mirror of the same finding, or a summary/inline conversion, does not change TP/FP/FN; a missing B cannot be filled in with A's second presentation | F29 |

Combinations for continuing to dig for unknown unknowns, not just filling in each happy path:

- **Separate semantic changes from irrelevant ones:** whitespace changes may keep the identity; changes to operators / negation / case-sensitive literals must trigger review. The state where the code and the tests are unchanged also must be tested.
- **Monotonicity:** shrinking the budget / deleting evidence can only make the conclusion more uncertain and cannot raise complete; adding display copies cannot raise TP; completing the next round should be able to point to the newly added review scope.
- **Identity swap:** swap the sources of two legal cids, swap two test paths, move to a directory explicitly configured by the owner, and verify respectively that the wrong citation is rejected and the equivalent configuration is accepted.
- **Boundary combinations:** the 40th/41st symbol, 20/21 blocks, the last part, a new commit, a budget change, partially broken output; combinations matter more than testing a single limit.
- **Timing:** publishing succeeds but the next round cannot read the state, the original issue is closed/reopened, an old version is superseded. The existing guards cannot replace checking each cross-step contract one by one.

After these fixes are complete, the actual goal still has to be verified, rather than equating all tests passing with shift-left being effective: pin representative historical QA/production defects, use only the R/C/T/S available at the time of the introducing PR, and blind-grade whether an actionable defect is hit; separately measure the noise on normal PRs, the real developer adoption/fix ratio, the feedback timing, latency and cost. Record "related line changed" and "behavior counterexample is now blocked by a test" separately. Offline seeded/replay results and real adopter results must be reported separately.

This part is an acceptance plan, not a pilot that has been run, and it is not recommended to call a paid model directly or post comments in an adopter's repository just to verify the report.

## 6. Actual verification and limits

- Baseline environment: Windows, Node `v26.11.1`; the repository CI uses Ubuntu, Node 22. First execution of `node --test --test-reporter=tap --test-concurrency=3 src/*.test.js bin/*.test.js eval/*.test.js`: **1085 tests, 1061 pass, 21 fail, 2 skipped, 1 todo**.
- The default `bash` points to `C:\Windows\System32\bash.exe`. Several shell tests fail explicitly with `/bin/bash: C:/.../src/collect.sh: No such file or directory`; these environment failures were not written up as product vulnerabilities.
- After putting Git for Windows's `bin` and `usr/bin` in front of this process's PATH and re-running the related files: the first group **62/62 pass**; the second group **25 tests, 24 pass, 0 fail, 1 todo**. Re-running the `fixture tr14 in CRLF` that failed in the first round on its own: **1/1 pass**; in the first round this case took about 122 seconds, and re-run alone about 7 seconds; the evidence supports load/time-limit relatedness, and it is not asserted that the root cause has been proven.
- Finally `eval/local.test.js` was added: **10/10 pass**. The four re-test groups total **98 tests, 97 pass, 0 fail, 1 todo**; this includes control tests and is not 98 first-round failures.
- Comparing the first-round failing test names one by one: all 21 unexpected failures passed in the re-tests above; skipped or TODO items are not counted in these 21.
- The TODO is the repository's existing `k2 toolbox (wanted): the has() claim is not posted as a weak test`, noting there is no deterministic weak_test guard and that it depends on the model; it cannot be counted as fixed, nor as an unexpected failure.
- main: the **5/5** new counterexamples of Appendix A and the **5/5** old counterexamples of Appendix B all reproduce. #198 pinned export: the same **5/5** new counterexamples and the **7/7** counterexamples of the previous report's complete script all reproduce. A counterexample passing means it successfully proves the current wrong behavior; **it is not the product's tests passing or a fix passing**.
- The full Ubuntu/Node 22 CI was not re-run; the re-test results were not spliced together to pose as one all-green full-suite run. No real Claude/Copilot model, paid evaluation, real PR comment or cross-repo issue publishing was executed. Not every historical fixture/research document was reviewed in depth one by one, and it is not proven that all security boundaries are free of holes.

Below are the scripts actually executed and a summary of their output, so that after a modification the expectations can be reversed to build tests that truly prevent regression. The scripts construct data in temporary Git repositories and mock GitHub; the temporary-directory boundary is checked before cleanup, and the user's working branch is not touched.

## 7. Executable reproduction

Save the appendix script as the named `.cjs` file at the root of the pinned main checkout above, then run `node filename.cjs`. The new-counterexample script can be used directly on the pinned #198 source; Appendix B is the version adjusted for main's two-part layout. The full seven-item script for #198 can be extracted verbatim from the appendix of the previous pinned-commit report and run; main's two-part expectations must not be forced onto #198's three-part layout.

### Appendix A: New counterexamples (save as audit-new.cjs)

<details>
<summary>Expand script or results</summary>

```javascript
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const root = __dirname;
const ac = require('./src/audit-collect');
const ap = require('./src/audit-post');
const packer = require('./src/engines/claude-api');
const { plan } = require('./src/scan-parts');
const { grade, parseSummary } = require('./eval/grade');
const results = [];
function write(dir, file, content) { const p = path.join(dir, file); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, content); }
function git(dir, ...args) { return execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
function commit(dir) { git(dir, 'add', '.'); git(dir, '-c', 'user.name=Audit Fixture', '-c', 'user.email=audit@example.invalid', 'commit', '-qm', 'fixture'); return git(dir, 'rev-parse', 'HEAD'); }
function fixture(files, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'specguard-full-audit-'));
  try { git(dir, 'init', '-q'); for (const [p, s] of Object.entries(files)) write(dir, p, s); commit(dir); return fn(dir); }
  finally { const p = fs.realpathSync(dir), base = fs.realpathSync(os.tmpdir()); assert(p.startsWith(base + path.sep) && path.basename(p).startsWith('specguard-full-audit-')); fs.rmSync(p, { recursive: true, force: true }); }
}
function probe(id, fn) { try { const detail = fn(); results.push({ id, reproduced: true, ...detail }); } catch (e) { results.push({ id, reproduced: false, error: e.stack }); process.exitCode = 1; } }
probe('N1-semantic-requirement-change', () => fixture({
  'docs/design.md': '# Design\n\n## Amount\nService must accept amounts >= 10.\n\n## Name\nService must reject blank names.\n',
  'src/amount.js': 'function amount(value) { return value >= 10; }\n',
  'tests/amount.test.js': 'test("inclusive minimum", () => { assert.equal(amount(10), true); });\n',
}, dir => {
  const oldHead = git(dir, 'rev-parse', 'HEAD'), before = ac.allBlocks(dir, oldHead, ['docs/design.md']);
  assert.equal(before.length, 2);
  const a = before.find(b => b.text.includes('amounts')), b = before.find(b => b.text.includes('blank'));
  write(dir, 'docs/design.md', fs.readFileSync(path.join(dir, 'docs/design.md'), 'utf8').replace('>= 10', '> 10'));
  const head = commit(dir), after = ac.allBlocks(dir, head, ['docs/design.md']);
  const changed = after.find(x => x.text.includes('amounts'));
  assert.equal(changed.cid, a.cid);
  const prior = { head: oldHead, blocks: [{ cid: a.cid, status: 'covered', runs: 2, since: oldHead.slice(0, 7), at: { head: oldHead.slice(0, 7), date: '2026-10-15' } }, { cid: b.cid, status: 'gap', runs: 1, since: oldHead.slice(0, 7), at: { head: oldHead.slice(0, 7), date: '2026-10-15' } }], versions: { ev: {}, uv: {} } };
  prior.versions.ev[a.cid] = ['src/amount.js', 'tests/amount.test.js'].map(p => require('node:crypto').createHash('sha1').update(p).digest('hex').slice(0, 8));
  const ctx = path.join(dir, '.ctx');
  ac.collect({ cwd: dir, ctx, reqPaths: 'docs/design.md', maxRequirements: 1, maxUnits: 1, prior, rotate: true });
  const selected = fs.readFileSync(path.join(ctx, 'audit-candidates.txt'), 'utf8');
  const carried = fs.readFileSync(path.join(ctx, 'audit-carried.txt'), 'utf8');
  assert(selected.includes(b.cid)); assert(!selected.includes(a.cid)); assert(carried.includes(a.cid));
  const state = ap.readState(ap.stateOf(head, { requirements: [], not_requirements: [] }, prior, { carried: [prior.blocks[0]] }).raw);
  assert.equal(state.blocks[0].status, 'covered');
  return { sameCid: a.cid, selectedChanged: false, carriedStatus: state.blocks[0].status };
}));
probe('N2-authoritative-test-paths', () => fixture({
  'docs/design.md': '# Design\n\nService must reject invalid amounts.\n',
  'src/amount.js': 'function amount(value) {\n  return value >= 10;\n}\nmodule.exports = { amount };\n',
  'qa/checks/amount.js': 'const { amount } = require("../../src/amount");\ntest("amount boundary", () => {\n  assert.equal(amount(10), true);\n});\n',
}, dir => {
  const ctx = path.join(dir, '.ctx');
  ac.collect({ cwd: dir, ctx, reqPaths: 'docs/design.md', testPaths: 'qa/checks/**', maxUnits: 1 });
  const layout = fs.readFileSync(path.join(ctx, 'test-layout.txt'), 'utf8');
  const units = fs.readFileSync(path.join(ctx, 'audit-units.txt'), 'utf8');
  assert(layout.includes('qa/checks (1)')); assert(units.includes('qa/checks/amount.js'));
  const read = p => { try { return fs.readFileSync(path.join(dir, p), 'utf8').split('\n'); } catch { return null; } };
  const cite = (p, n) => ({ path: p, line: n, quote: read(p)[n - 1] });
  const req = { id: '1111111a', source: cite('docs/design.md', 3), text: 'Reject invalid amounts', class: 'unit', status: 'covered', code: [cite('src/amount.js', 2)], tests: [{ ...cite('qa/checks/amount.js', 3), layer: 'unit' }], note: '' };
  const verified = ap.verify({ requirements: [req], not_reviewed: [], not_requirements: [], unit_findings: [] }, { read });
  assert.equal(verified.requirements[0].status, 'unknown'); assert.equal(verified.requirements[0].tests.length, 0);
  return { collectorMatchedTest: true, verifiedStatus: verified.requirements[0].status, verifiedTests: 0 };
}));
probe('N3-current-part-test-slices', () => fixture({
  'src/units.js': Array.from({ length: 200 }, (_, i) => `function unit${String(i).padStart(3, '0')}(value) { return value + ${i}; } // ${'x'.repeat(200)}`).join('\n') + '\n',
  'tests/units.test.js': Array.from({ length: 200 }, (_, i) => `test('unit ${i}', () => { assert.equal(unit${String(i).padStart(3, '0')}(1), ${i + 1}); }); // ${'x'.repeat(600)}`).join('\n') + '\n',
}, dir => {
  const ctx = path.join(dir, '.ctx');
  const au = require('./src/audit-units'), head = git(dir, 'rev-parse', 'HEAD');
  const first = au.inventory({ cwd: dir, head, maxUnits: 1, packBytes: 250000 }).picked[0];
  const prior = { blocks: [{ cid: first.id, status: 'unsure', runs: 1 }], versions: { uv: { [first.id]: first.ver }, ev: {}, uc: { [first.id]: 1 } } };
  const next = au.inventory({ cwd: dir, head, maxUnits: 1, packBytes: 250000, prior });
  assert.equal(next.picked[0].part.a, 101); assert.equal(next.picked[0].part.b, 200);
  fs.mkdirSync(ctx); au.write(ctx, head, 1, next);
  const p = packer.contextPack(ctx, dir, 250000);
  assert(p.text.includes('function unit170')); assert(!p.text.includes('assert.equal(unit170'));
  assert(p.text.includes('assert.equal(unit000')); assert.deepEqual(p.notWhole, []);
  return { currentSourceVisible: true, currentAssertionVisible: false, irrelevantEarlyTestsVisible: true, notWhole: p.notWhole };
}));
probe('N4-evidence-at-batch-boundary', () => fixture({
  'config/policy.yaml': 'amount_minimum: 10\n',
  'tests/policy.test.js': 'test("minimum", () => { assert.equal(policy.amount_minimum, 10); });\n',
}, dir => {
  const ctx = path.join(dir, '.ctx');
  const cid = i => i.toString(16).padStart(8, '0');
  function setup(n) {
    write(ctx, 'audit-candidates.txt', Array.from({ length: n }, (_, i) => `${cid(i)}\tdocs/design.md:${i + 1}\tPolicy\tMinimum must be 10.`).join('\n') + '\n');
    write(ctx, 'audit-evidence.txt', Array.from({ length: n }, (_, i) => `${cid(i)}\tcode\tconfig/policy.yaml:1\tamount_minimum: 10\n${cid(i)}\ttest\ttests/policy.test.js:1\tassert.equal(policy.amount_minimum, 10)`).join('\n') + '\n');
  }
  const opts = { ctx, root: dir, batch: 20, limit: 250000, schemaFile: path.join(root, 'src/audit.schema.json'), contextPack: packer.contextPack, windowPack: packer.windowPack, assembleAudit: require('./src/prompt').assembleAudit };
  setup(20); assert.equal(plan(opts), null); const one = packer.contextPack(ctx, dir, 250000);
  assert(!one.text.includes('amount_minimum: 10')); assert.deepEqual(one.notWhole, []);
  setup(21); const split = plan(opts); assert(split.parts[0].pack.text.includes('amount_minimum: 10'));
  return { at20: { evidencePacked: false, notWhole: one.notWhole }, at21: { evidencePacked: true } };
}));
probe('N5-mirrored-summary-double-count', () => {
  const f = { kind: 'missing_test', path: 'a.js', line: 10, title: 'Boundary A', body: 'Missing assertion', confidence: 'high', obligation_id: 'O1' };
  const b = { path: 'a.js', line: 10, quote: 'return boundary(value);' };
  const data = { requirements: [], requirements_source: 'none', not_reviewed: '', coverage: [{ id: 'O1', obligation: 'Boundary A', source: 'from behaviour', behaviour: b, change: b, evidence: [], status: 'missing_test', reason: 'No test', alignment: { status: 'not_applicable', reason: 'No explicit requirement' } }], findings: [f], standards: { status: 'no_rules', sources: [], reason: 'None' }, layering: { status: 'checked', reason: 'No higher layer tests' } };
  const summary = require('./src/post').buildSummary({ cov: { reports: 0 }, data, items: [{ f, why: 'not on diff' }], notes: [], blob: 'https://github.com/example/repo/blob/abc/' });
  const one = { kind: 'missing_test', path: 'a.js', line: 10, allow_summary: true };
  const parsed = parseSummary(summary); assert.equal(parsed.items.length, 1); assert.equal(parsed.rows.length, 1);
  const g = grade({ id: 'mirror', goal: 'requirements', expected: { findings: [one, { ...one, line: 30 }] } }, { comments: [], reviews: [], summary });
  assert.equal(g.tp, 2); assert.equal(g.fn, 0); assert.equal(g.pass, true);
  const control = grade({ id: 'mirror', goal: 'requirements', expected: { findings: [one, { ...one, line: 30 }] } }, { comments: [], reviews: [], summary: summary.split('\n').filter(l => !l.startsWith('| O1:')).join('\n') });
  assert.equal(control.tp, 1); assert.equal(control.fn, 1);
  return { distinctFindings: 1, tp: g.tp, fn: g.fn, pass: g.pass, withoutMirrorTP: control.tp };
});
console.log(JSON.stringify(results, null, 2));
```

</details>

### Appendix A actual results (main)

<details>
<summary>Expand script or results</summary>

```json
[
  {
    "id": "N1-semantic-requirement-change",
    "reproduced": true,
    "sameCid": "090622e0",
    "selectedChanged": false,
    "carriedStatus": "covered"
  },
  {
    "id": "N2-authoritative-test-paths",
    "reproduced": true,
    "collectorMatchedTest": true,
    "verifiedStatus": "unknown",
    "verifiedTests": 0
  },
  {
    "id": "N3-current-part-test-slices",
    "reproduced": true,
    "currentSourceVisible": true,
    "currentAssertionVisible": false,
    "irrelevantEarlyTestsVisible": true,
    "notWhole": []
  },
  {
    "id": "N4-evidence-at-batch-boundary",
    "reproduced": true,
    "at20": {
      "evidencePacked": false,
      "notWhole": []
    },
    "at21": {
      "evidencePacked": true
    }
  },
  {
    "id": "N5-mirrored-summary-double-count",
    "reproduced": true,
    "distinctFindings": 1,
    "tp": 2,
    "fn": 0,
    "pass": true,
    "withoutMirrorTP": 1
  }
]
```

</details>

### Appendix B: re-verification of old main problems (save as audit-main.cjs)

<details>
<summary>Expand script or results</summary>

```javascript
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const audit = require('./src/audit-post');
const au = require('./src/audit-units');
const collector = require('./src/audit-collect');
const post = require('./src/post');
const preflight = require('./src/preflight');
const results = {};
const roots = [];
const empty = () => ({ requirements: [], not_requirements: [], not_reviewed: [], docs_reviewed: [], unit_findings: [] });
function fixture(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-new-review-'));
  roots.push(root);
  const git = (...args) => execFileSync('git', ['-c', 'core.autocrlf=false', ...args], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-q');
  for (const [name, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), body);
  }
  const commit = () => { git('add', '.'); git('-c', 'user.name=Review', '-c', 'user.email=review@example.invalid', 'commit', '-qm', 'synthetic review fixture'); return git('rev-parse', 'HEAD'); };
  const head = commit();
  const ctx = path.join(root, '.specguard-ctx'); fs.mkdirSync(ctx);
  const put = (name, value) => fs.writeFileSync(path.join(ctx, name), typeof value === 'string' ? value : JSON.stringify(value));
  return { root, ctx, git, head, commit, put };
}
function trackedState(row, head, prior = null, findings = []) {
  return audit.readState(audit.stateOf(head, empty(), prior, { date: '2026-10-15', code: {
    picked: [row.id], findings, carried: [], versions: new Map([[row.id, row.ver]]), parts: new Map(row.part ? [[row.id, row.part]] : [])
  } }).raw);
}
async function withEnv(values, fn) {
  const before = { ...process.env };
  try { Object.assign(process.env, values); return await fn(); }
  finally { for (const k of Object.keys(process.env)) if (!(k in before)) delete process.env[k]; Object.assign(process.env, before); }
}
async function run() {
  // P1: the cursor remains valid syntactically after its content version changes.
  const big = Array.from({ length: 600 }, (_, i) => `exports.function${i} = () => '${'x'.repeat(80)}';`).join('\n') + '\n';
  const f = fixture({ 'src/big.js': big });
  const inv = (head, prior, maxUnits = 1) => au.inventory({ cwd: f.root, head, prior, maxUnits, packBytes: 250000 });
  const first = inv(f.head).picked[0];
  const prior = trackedState(first, f.head);
  fs.writeFileSync(path.join(f.root, 'src/big.js'), big.replace('xxxxxxxx', 'yyyyyyyy'));
  const nextHead = f.commit(), nextInv = inv(nextHead, prior), next = nextInv.picked[0];
  const after = trackedState(next, nextHead, prior);
  assert.notEqual(next.ver, first.ver); assert.equal(next.part.k, 1);
  const finalRow = next, finalState = after;
  assert.equal(finalState.blocks[0].status, 'covered');
  results.P1_cursor_after_edit = { first: first.part, next: next.part, final: finalRow.part, versionChanged: first.ver !== next.ver, selectedStaleIds: nextInv.stale, finalState: finalState.blocks[0].status, changedLineRevisited: false };
  // P3: the public state loader queries the source despite an external issue destination.
  const requests = [];
  const external = { number: 7, state: 'open', user: { type: 'Bot', login: 'github-actions[bot]' }, title: audit.scopeOf('', 'org/source').title, body: audit.MARK + '\n' + audit.stateOf('abc1234', empty()).raw };
  const fetchFn = async (url) => {
    requests.push(url);
    const data = url.endsWith('/user') ? null : url.includes('/repos/org/reports/issues?') ? [external] : [];
    return { ok: !url.endsWith('/user'), status: url.endsWith('/user') ? 403 : 200, json: async () => data };
  };
  const loaded = await collector.loadPrior({ GH_REPO: 'org/source', GH_TOKEN: 'synthetic', ISSUE_REPO: 'org/reports' }, fetchFn);
  assert.equal(loaded, null);
  results.P3_external_state = { requests, foundPrior: !!loaded, expectedDestination: 'org/reports' };
  // P4: a valid candidate id may cite a different admitted requirement entirely.
  const docFiles = { 'A.md': ['Negative amounts must be rejected.'], 'B.md': ['Positive amounts must be accepted.'], 'src/amount.js': ['exports.validAmount = amount => amount > 0;'], 'test/amount.test.js': ['assert.equal(validAmount(10), true);'] };
  const cite = (p) => ({ path: p, line: 1, quote: docFiles[p][0] });
  const candidates = audit.readCandidates('aaaaaaaa\tA.md:1\tNegative\tNegative amounts must be rejected.\nbbbbbbbb\tB.md:1\tPositive\tPositive amounts must be accepted.\n');
  const row = (id) => ({ id, text: docFiles['B.md'][0], source: cite('B.md'), class: 'unit', status: 'covered', code: [cite('src/amount.js')], tests: [{ ...cite('test/amount.test.js'), layer: 'unit' }], note: '' });
  const data = { ...empty(), docs_reviewed: ['A.md', 'B.md'], requirements: [row('aaaaaaaa'), row('bbbbbbbb')] };
  assert.equal(audit.validate(data, candidates, new Map()).ok, true);
  const verified = audit.verify(data, { read: p => docFiles[p] || null, cands: candidates, docs: new Set(['A.md', 'B.md']), tracked: new Set(Object.keys(docFiles)) });
  assert.equal(verified.requirements[0].status, 'covered');
  results.P4_requirement_identity = { rows: verified.requirements.map(r => ({ id: r.id, source: r.source.path, status: r.status })), warnings: verified.not_reviewed };
  // P5: malformed findings are dropped, then the production publisher records every unit as covered.
  const s = fixture({ 'src/amount.js': 'exports.positive = v => v > 0;\nexports.negative = v => v < 0;\nexports.zero = v => v === 0;\n' });
  const id = au.sha8('src/amount.js');
  s.put('audit-meta.json', { head: s.head, max_requirements: 80, units: { total: 1, picked: 1 }, docs: 0, candidates: 0, rotation: { rotate: true, picked: 0 }, limitations: [] });
  s.put('audit-units.txt', `${id}\tsrc/amount.js\t10\tno test\tnone\t-\tabcdef12\t-\n`);
  s.put('audit-inventory.json', { units: 1, max_units: 1, selected: { units: 1, without_tests: 1 }, rotation: { picked: 1, total: 1, reviewed: 1 }, rows: [{ id, path: 'src/amount.js', score: 10, tests: [], why: 'no test' }], unreviewed: [] });
  s.put('engine-status', 'success'); s.put('pack-cut.txt', '');
  s.put('findings.json', { ...empty(), unit_findings: [{ unit: id, kind: 'missing_test', path: 'src/amount.js', line: 1, quote: 'exports.positive = v => v > 0;' }] });
  let issueBody = '', summary = ''; const outputs = {}, warnings = [];
  const github = { paginate: async fn => fn(), rest: { users: { getAuthenticated: async () => { throw Error('job token'); } }, issues: { listForRepo: async () => [], create: async a => { issueBody = a.body; } } } };
  const core = { setOutput: (k,v) => { outputs[k] = v; }, warning: s => warnings.push(s), summary: { addRaw(s) { summary = s; return this; }, async write() {} } };
  await withEnv({ CTX: s.ctx, GITHUB_WORKSPACE: s.root, SCAN_ISSUE: 'true', ISSUE_REPO: '', SKIP: 'false', ENGINE: 'claude' }, () => audit({ github, core, context: { repo: { owner: 'org', repo: 'source' }, sha: s.head } }));
  const publishedState = audit.readState(issueBody);
  assert.equal(outputs.status, 'complete'); assert.equal(publishedState.blocks[0].status, 'covered');
  results.P5_invalid_finding = { outputs, state: publishedState.blocks[0].status, validationVisible: summary.includes('path, line, quote and title are required'), warnings };
  // P6: PR context omissions do not affect a clean report's completeness or the cache marker.
  const p = fixture({ 'src.js': 'exports.total = x => x + 1;\n', 'test.js': 'assert.equal(total(1), 2);\n' });
  const b = { path: 'src.js', line: 1, quote: 'exports.total = x => x + 1;' };
  p.put('files.txt', 'src.js\n');
  p.put('diff.patch', 'diff --git a/src.js b/src.js\n--- a/src.js\n+++ b/src.js\n@@ -1 +1 @@\n-exports.total = x => x;\n+exports.total = x => x + 1;\n');
  p.put('test-candidates.txt', 'src.js\ttest.js\n');
  p.put('pack-cut.txt', 'src.js\ntest.js\n'); p.put('engine-status', 'success');
  p.put('requirements-status.json', { status: 'available', sources: ['PR body'], limitations: [], criteria: [] });
  p.put('findings.json', { requirements: [], requirements_source: 'PR body', not_reviewed: '', coverage: [{ id: 'O1', obligation: 'Increment the input', source: 'from behaviour', behaviour: b, change: b, evidence: [{ path: 'test.js', line: 1, quote: 'assert.equal(total(1), 2);', layer: 'unit', kind: 'assertion', proves: 'Increments one.' }], status: 'covered', reason: 'The assertion checks the increment.', alignment: { status: 'not_applicable', reason: 'No explicit requirement.' } }], findings: [], standards: { status: 'no_rules', sources: [], reason: 'No rule files.' }, layering: { status: 'checked', reason: 'No higher-layer tests.' } });
  let prSummary = ''; const prOutputs = {}, prWarnings = [];
  const pr = { state: 'open', title: 'Increment input', body: '', head: { sha: p.head }, user: { login: 'dev', type: 'User' } };
  const gh = { paginate: async (fn, args) => (await fn(args)).data, graphql: async () => ({ repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [] } } } }), rest: { users: { getAuthenticated: async () => { throw Error('job token'); } }, pulls: { get: async () => ({ data: pr }), listReviewComments: async () => ({ data: [] }), listFiles: async () => ({ data: [] }) }, issues: { listComments: async () => ({ data: [] }), createComment: async a => { prSummary = a.body; return {}; } } } };
  const pc = { setOutput: (k,v) => { prOutputs[k] = v; }, warning: s => prWarnings.push(s), summary: { addRaw(s) { prSummary = s; return this; }, async write() {} } };
  await withEnv({ CTX: p.ctx, GITHUB_WORKSPACE: p.root, HEAD_SHA: p.head, ENGINE: 'claude', MODEL: 'claude-sonnet-4-6', SKIP: 'false', PARTIAL: 'false', DELIVERY: '', STANDARDS_CHECKS: '', STANDARDS_REF: 'head', RESOLVE_STALE: 'false' }, () => post({ github: gh, core: pc, context: { repo: { owner: 'o', repo: 'r' }, serverUrl: 'https://github.com', payload: { pull_request: { ...pr, number: 1 } } } }));
  const counts = JSON.parse(fs.readFileSync(path.join(p.ctx, 'counts.json'), 'utf8'));
  const skip = preflight.decide({ pr, headSha: p.head, comments: [{ user: { type: 'Bot', login: 'github-actions[bot]' }, body: prSummary }] });
  results.P6_PR_pack_cut = { outputs: prOutputs, complete: counts.complete, execution_complete: counts.execution_complete, cleanVerdict: prSummary.includes('No unit test gaps found'), headMarker: prSummary.includes(`<!-- specguard:head=${p.head} -->`), nextRunSkip: !!skip, warnings: prWarnings };
  assert.equal(prOutputs.status, 'complete'); assert.equal(counts.execution_complete, true); assert.ok(skip);
  console.log(JSON.stringify(results, null, 2));
}
run().catch(e => { console.error(e.stack); process.exitCode = 1; }).finally(() => {
  for (const root of roots) {
    const resolved = path.resolve(root), temp = path.resolve(os.tmpdir()) + path.sep;
    if (!resolved.startsWith(temp) || !path.basename(resolved).startsWith('sg-new-review-')) throw Error('unsafe cleanup path');
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});
```

</details>

### Appendix B actual results (main)

<details>
<summary>Expand script or results</summary>

```json
{
  "P1_cursor_after_edit": {
    "first": {
      "k": 0,
      "n": 2,
      "a": 1,
      "b": 300
    },
    "next": {
      "k": 1,
      "n": 2,
      "a": 301,
      "b": 600
    },
    "final": {
      "k": 1,
      "n": 2,
      "a": 301,
      "b": 600
    },
    "versionChanged": true,
    "selectedStaleIds": [],
    "finalState": "covered",
    "changedLineRevisited": false
  },
  "P3_external_state": {
    "requests": [
      "https://api.github.com/user",
      "https://api.github.com/repos/org/source/issues?state=all&per_page=100&page=1"
    ],
    "foundPrior": false,
    "expectedDestination": "org/reports"
  },
  "P4_requirement_identity": {
    "rows": [
      {
        "id": "aaaaaaaa",
        "source": "B.md",
        "status": "covered"
      },
      {
        "id": "bbbbbbbb",
        "source": "B.md",
        "status": "covered"
      }
    ],
    "warnings": []
  },
  "P5_invalid_finding": {
    "outputs": {
      "status": "complete"
    },
    "state": "covered",
    "validationVisible": true,
    "warnings": []
  },
  "P6_PR_pack_cut": {
    "outputs": {
      "status": "complete"
    },
    "complete": true,
    "execution_complete": true,
    "cleanVerdict": true,
    "headMarker": true,
    "nextRunSkip": true,
    "warnings": []
  }
}
```

</details>

### Appendix C: actual results of the full #198 re-verification

<details>
<summary>Expand script or results</summary>

```json
{
  "P1_cursor_after_edit": {
    "first": {
      "k": 0,
      "n": 3,
      "a": 1,
      "b": 200
    },
    "next": {
      "k": 1,
      "n": 3,
      "a": 201,
      "b": 400
    },
    "final": {
      "k": 2,
      "n": 3,
      "a": 401,
      "b": 600
    },
    "versionChanged": true,
    "selectedStaleIds": [],
    "finalState": "covered",
    "changedLineRevisited": false
  },
  "P2_cursor_after_budget_change": {
    "first": {
      "k": 0,
      "n": 5,
      "a": 1,
      "b": 120
    },
    "next": {
      "k": 1,
      "n": 3,
      "a": 201,
      "b": 400
    },
    "neverRead": [
      121,
      200
    ]
  },
  "P3_external_state": {
    "requests": [
      "https://api.github.com/user",
      "https://api.github.com/repos/org/source/issues?state=all&per_page=100&page=1"
    ],
    "foundPrior": false,
    "expectedDestination": "org/reports"
  },
  "P4_requirement_identity": {
    "rows": [
      {
        "id": "aaaaaaaa",
        "source": "B.md",
        "status": "covered"
      },
      {
        "id": "bbbbbbbb",
        "source": "B.md",
        "status": "covered"
      }
    ],
    "warnings": []
  },
  "P5_invalid_finding": {
    "outputs": {
      "status": "complete"
    },
    "state": "covered",
    "validationVisible": true,
    "warnings": []
  },
  "P6_PR_pack_cut": {
    "outputs": {
      "status": "complete"
    },
    "complete": true,
    "execution_complete": true,
    "cleanVerdict": true,
    "headMarker": true,
    "nextRunSkip": true,
    "warnings": []
  },
  "P7_scan_stall": {
    "sourceFilesCut": 0,
    "testFilesCut": 8,
    "unseenUnits": 8,
    "stateBlocks": 0,
    "samePartsNextRun": true
  }
}
```

</details>


## 8. Verdict

**Verdict:** First fix false reassurance and state distortion, then evidence completeness, scan progress and metric identity. The current implementation already has several layers of protection, but "many tests, a complete report, source that fits" cannot yet be used to confirm the goal is achieved. This document delivers a reproducible audit and the basis for acceptance; the 11 product problems are still to be fixed.

**Not checked:** a real adopter pilot, online model behavior, a full re-run on Ubuntu/Node 22, and a line-by-line audit of every historical fixture. There is no suggestion to delete/merge code, so no made-up line counts or dependency savings are reported.
