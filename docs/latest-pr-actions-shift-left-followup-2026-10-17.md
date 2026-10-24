# SpecGuard Latest PRs, Actions and In-Depth Shift-Left Re-Review (2026-10-17)

Conclusion of this round: requirement, code and test retrieval at PR time has made substantive progress, but the chain "find candidates → see complete evidence → judge the gap → author fixes → measure correctly" still has losses. The items most worth handling first are candidates being mistaken for coverage evidence, retrieval failures going undisclosed, and findings disappearing from the evaluation sample after they are fixed. Running more scans cannot, for now, replace fixing these links.

This document continues the earlier analysis and focuses on the newly merged #243–#250, plus #251/#252 which are in progress. Product code was not modified; no GitHub comments were posted, no paid models or Actions were triggered, and no branches were merged or cleaned up.

## 1. Versions and Evidence Boundaries

### 1.1 Versions Actually Reviewed This Round

| Object | Version | Handling this round |
|---|---|---|
| GitHub main | ab2cfc0aafe098d5e47704ebe36df85d687847e5, after #250 merged | Main review baseline; the deterministic reproductions load this Git tree |
| Mid-round baseline of the previous round | 94196844df85cb0525fe68e84a698e6025df1454 | Used for comparison with the newly added #246/#248/#249/#250, to avoid continuing to report already-fixed problems as defects |
| Current root-directory checkout | b1aaf113aae3ca69fcc70e7b9026130affa6c30f | Older, with README changes and several reports; it was not mistaken for the latest product code |
| #251 first actual review | 1c17ee36739eb5d5bcef1e00d27f59f15000e468 | Corresponds to the dogfood run and bot summary that were read |
| #251 new fixes | 5cd5293 → 9bb42c4 → 34709585be3f7b787a74671ca54183f94c3d876c | Read the added tests, the shared prefix, and the subsequent lazy require fix; the deterministic reproduction was re-run and passed on 3470958; test/dogfood for that head have passed |
| #252 | 5343879 → 494a9fa9b3ca860b857508bf795f4ff69ea5ca99 | Seen both locally and remotely; reviewed the stateless change and the direct branchGuard tests added; the latest test/dogfood have passed |
| Kite Actions | The latest returned runs are still the 2026-10-15 batch | The effect of the new SpecGuard code was not back-inferred as Kite having been re-verified |

Main evidence window: 2026-10-17 02:38–02:44 UTC, i.e. Sydney 13:38–13:44; the refresh at hand-in extended to about 02:49 UTC, taking in the #251 circular-dependency failure and the follow-up fix. Versions will keep moving; "to be verified" in the table means the state of a definite snapshot, and does not pre-judge later runs.

HEAD, status and diffs were checked for the relevant active worktrees. During this period the uncommitted src/test-map.js change in #251 became 9bb42c4; the src/leads.js state of the old worktree produced no semantic diff. The many deletion states of the historical scratch checkout cannot be directly interpreted as product changes awaiting merge, and should not be cleaned up automatically.

[main pinned version](https://github.com/Mira190/SpecGuard/tree/ab2cfc0aafe098d5e47704ebe36df85d687847e5), [PR #251](https://github.com/Mira190/SpecGuard/pull/251), [PR #252](https://github.com/Mira190/SpecGuard/pull/252).

### 1.2 Evidence Grading

- **Actual run evidence**: GitHub jobs, decoded logs, real PR summaries and review comments.
- **Deterministic reproduction this round**: load real modules from a pinned SHA, supply synthetic input, and assert the actual return values; no model is called. 8 boundary cases and 1 fixed control in total; each executed once on main and on the new #251 commit.
- **Existing experiments in the repository**: baseline.json, goal-assessment, the maintainer's review notes. This document checks the files and the definitions, but did not re-fetch Fastify and run the full 36 variants, nor independently re-label all of their findings.
- **Improvement suggestions**: state the goal and the acceptance method, and are not written as effects already measured.

This round did not read the prompt/pack inside the artifact ZIPs. Therefore when a PR summary says "a certain test was not inlined", that is the model's report about this run's context, and cannot be directly equated with an independently confirmed packing defect; the artifact upload success and ID have log evidence.

## 2. The Latest Actions: What Does Green Actually Prove

### 2.1 Run Window Overview

The first refresh returned the 35 most recent runs: 30 success, 3 failure, 2 cancelled. This is a time window containing reruns and different workflows, **not 35 independent PRs, and not the product review success rate**.

Later refreshes saw new #251 pushes and new #252 runs, so this window's statistics are not described as an ever-updating "current whole". The attached JSON files save the first and later snapshots respectively.

| Run | What actually happened | Interpretation for shift-left |
|---|---|---|
| [main CI 38995641146](https://github.com/Mira190/SpecGuard/actions/runs/38995641146) | test success; dogfood skipped per the push condition | Proves the test suite passes on that version; does not mean the mainline underwent another model review |
| [#251 CI 38995709971](https://github.com/Mira190/SpecGuard/actions/runs/38995709971) | test and dogfood success; product STATUS=incomplete | The workflow executed successfully while the review scope is still incomplete; both can hold at once in the current advisory design |
| [#251 added-tests CI 38995834823](https://github.com/Mira190/SpecGuard/actions/runs/38995834823) | 5cd5293 run success | Confirms that this round's run passed; it is not passed off as the result of the later 9bb42c4 run |
| [Kite scan 38994519895](https://github.com/Mira190/SpecGuard/actions/runs/38994519895) | resolve failed; review skipped | Did not produce a new scan-quality sample |
| [Kite scan 38994550844](https://github.com/Mira190/SpecGuard/actions/runs/38994550844) | resolve failed; review skipped | Same as above; cannot be taken as a 0-finding negative sample |
| [#251 38996053676](https://github.com/Mira190/SpecGuard/actions/runs/38996053676) | 9bb42c4 test failure, dogfood success | The shared prefix introduced a circular-load regression; a green model run cannot replace integration tests |
| [#251 fix run 38996261102](https://github.com/Mira190/SpecGuard/actions/runs/38996261102) | 3470958 test/dogfood success | The latest lazy require fix has passed the checks; the old green of 5cd5293 must not be applied |
| [#252 latest run 38996181974](https://github.com/Mira190/SpecGuard/actions/runs/38996181974) | 494a9fa test/dogfood success | Branch logic and added tests pass; it does not yet mean Kite access and the seeded scan have run through |

The end of the main test log is 1332 tests, 1328 pass, 0 fail, 3 skipped, 1 TODO. A not ok carrying TODO in the raw TAP should not be counted as a real CI failure; likewise, the total number of tests cannot be used as model recall. Source: [main test job](https://github.com/Mira190/SpecGuard/actions/runs/38995641146/job/117287476804).

The #251 dogfood log explicitly prints STATUS: incomplete, and successfully uploads two context artifacts of the same 41230 bytes; fail_on_error is false. We suggest the dashboard display execution, review completeness, grade, and delivery side by side, and stop inferring "reviewed, reviewed completely, no problems" from the single GitHub conclusion field. This does not require upgrading every context truncation to merge-blocking.

### 2.2 Why the New Kite Scans Failed

Both failures happened before the review:

1. The log says the specguard environment has no usable App secrets or SPECGUARD_PAT configured, falling back to the job token.
2. The scan targets were Kite's seeded branch and master respectively.
3. The visibility guard could not determine the target repository's visibility, reporting "cannot determine the visibility … token may not reach it".
4. The review job was skipped.

The seeded-branch run also showed an extra warning: it could not parse the full branch name containing a slash and fell back to eval, rather than eval/seeded-scan-gaps-1017. Even if only the later access check were fixed, the input parsing would still need rechecking, and it cannot be used to confirm that the scan target is correct.

This is evidence that **target access/resolution was not completed**, not evidence that the target has been proven to be of any particular visibility. We suggest keeping the current fail-closed behavior and recording stage=resolve, target_access=unknown, review_started=false in the failure output; scan throughput, precision and recall do not admit these two runs.

If the target really is a private repository, giving the token read permission cannot replace the check of where the results are stored. A controlled non-public execution/result location should be used, and then the full chain verified; do not obtain a green by bypassing the visibility guard. Related implementation: [manual workflow](https://github.com/Mira190/SpecGuard/blob/ab2cfc0aafe098d5e47704ebe36df85d687847e5/.github/workflows/specguard-run.yml).

### 2.3 Which Layer #252 Solves and Which It Does Not Yet

#252 lets runs where scan_issue is off and which neither read nor write scan state scan a non-default branch, and records the ref and SHA in the summary; stateful scans remain bound to the default branch. This helps isolate seeded experiments and prevents a seeded branch from polluting the scan state of the default branch.

It does not change the permission preconditions of the target access, the visibility guard, or the slash-containing branch parsing described above. So even if the #252 tests pass, one should separately confirm that resolve succeeded, the actual target SHA is correct, and the review started, and only then measure seed recall.

Suggested acceptance: for the same seeded SHA, the stateless run succeeds and outputs the ref; the stateful non-default branch is still blocked; the existing issue/state of the default branch is unchanged. This document only reviewed the code and existing tests, and did not execute this remote experiment. [#252 diff](https://github.com/Mira190/SpecGuard/pull/252/files).

## 3. Actual Reviews of the New PRs: What Has Already Produced Value

### 3.1 #243 / #248: State and Fast Tier Split, Fixed

#243 separated whether execution completed from the fast-tier grade; #248 then changed the key judgement from the human-readable reason wording to a reason id. The earlier risk that "changing one sentence of prompt text changes the state semantics" should no longer be reported as an unfixed problem.

But the real summaries of #248/#249/#251 still show execution_complete=false, for reasons including context truncation and citation-verification downgrades. This shows that "fixing the fast tier always being incomplete" does not equal "all reviews are now complete". The actual summary needs to be judged by its specific loss reasons. [#248 actual summary](https://github.com/Mira190/SpecGuard/pull/248#issuecomment-6228484039).

### 3.2 #245: Delivered Recall and Strict Acceptance Added, Same-Basis Precision Still Missing

There are now tp_delivered, fn_delivered, recall_delivered, recall_delivered_e2e and strict_pass. The current runner writes expected_findings on the error path, so failed samples enter the end-to-end denominator; this resolves an important earlier bias.

The old precision is still computed with raw TP. Keeping the historical numbers has compatibility value, but it cannot be paired directly with delivered recall to claim the two use the same exposure set; see F5/F6 in Section 4. [#245](https://github.com/Mira190/SpecGuard/pull/245).

### 3.3 #246: Summary Entering Blind Labelling Is Progress; Lifecycle Not Yet Closed

The new version does three things right:

- Summary-only titles enter the blind-labelling candidates; entries from old data that have no claim are excluded and disclosed.
- The delivery column is not exported, and consistent links are used, reducing leakage of tool identity through the table format.
- P×A is explicitly called an economic hypothesis; only labels and outcomes with the same ID are computed as a measured joint, and insufficient samples show insufficient data.

But export/import depends on "rebuilding the finding list from the latest sticky summary", so labels can still be lost after a finding disappears or the channel is upgraded. F1/F2 are the remaining problems newly reproduced this round, and do not deny that #246 has fixed the static same-batch scenario.

The actual bot raised comments in #246 such as "table row not asserted" and "tracing-start note not asserted"; the latest summary records them as addressed. But in this round's main, weekly-report.test.js does not show the two exact output assertions corresponding to those suggestions. So addressed here at most shows that the disposition heuristic fired, and cannot independently prove that the suggested regression tests were added. [#246 review](https://github.com/Mira190/SpecGuard/pull/246#pullrequestreview-5555502361), [actual follow-up summary](https://github.com/Mira190/SpecGuard/pull/246#issuecomment-6228253867).

### 3.4 #247 / #249: Retrieval Optimization Starts to Be Driven by Measurement

#247 introduces 12 behaviors on a pinned Fastify SHA, with three variants R/C/RC each. #249, based on the code→test weakness that this evaluation exposed, adds changed-hunk identifier retrieval and suppresses generic stems from filling up the candidates.

Code→test data in baseline.json:

| Metric | after_239 | after_hunk_tokens | Meaning |
|---|---:|---:|---|
| Hit@3 | 4/24 | 20/24 | Number of queries in which at least one relevant test was found |
| Recall@3 | about 7% | 28/54, 51.9% | How many of the required test entries were actually found |
| MRR@10 | 0.167 | 0.8125 | Position at which the first relevant test appears |
| All-required@3 | 2/24, 8.3% | 6/24, 25% | Number of queries in which all relevant tests are in the top three candidates |

24 is the number of queries from 12 behaviors on two relevant variants, not 24 independent behaviors. 20/24 Hit@3 is very good, but it still cannot be said that 83% of behaviors already have complete test evidence; All-required is only 25%, and many multi-entry omissions remain.

In the same latest baseline, the exact-location Recall@3 of req→code is 26/58 (44.8%), All-required@3 is 6/24 (25%); code→requirement Hit@3 is 15/24 (62.5%). This shows that #249 mainly improves code→test, and the gain should not be extended to all directions.

The maintainer also recorded a sensitivity analysis with initial-config removed, and a candidate comparison on SpecGuard's own most recent 10 PRs. This helps check whether a single concentrated test file contributes too much, but a second external repository is still needed as a held-out set; "the PR's own tests are in the top three" is only a localization proxy metric and cannot prove the assertions are sufficient. [Baseline file](https://github.com/Mira190/SpecGuard/blob/ab2cfc0aafe098d5e47704ebe36df85d687847e5/eval/trace-recall/baseline.json), [#249 actual human review](https://github.com/Mira190/SpecGuard/pull/249#pullrequestreview-5555591206).

### 3.5 #249 → #251: A Linked Fix That Directly Serves the Goal

The human review of #249 explicitly pointed out: it is allowed for an unrelated test sharing a literal to become a candidate, but if the cover guard treats such a candidate as a reason for coverage, it will suppress a real missing_test. #251 has provided a minimal fix:

- hunk-tier tests continue to enter the retrieval context;
- the cover guard's candidate scope excludes this tier;
- the real post-flow test asserts: a hunk-tier shared literal does not downgrade; the same-stem control is still downgraded as designed;
- 5cd5293 adds direct return-value assertions for parseCandidates default retention / skipHunk exclusion;
- 9bb42c4 shares HUNK_REASON so that the producer/parser do not each keep their own copy of the type prefix; 3470958 then switched to a lazy require to handle the circular dependency introduced by that sharing.

This protects real-gap recall more directly than "adding a missing-test comment". At the time of checking, #251 had not been merged into main, so the mainline risk still needs this PR to be completed; do not open another identical fix. [#249 risk note](https://github.com/Mira190/SpecGuard/pull/249#discussion_r4300935274), [#251 first-round bot comment](https://github.com/Mira190/SpecGuard/pull/251#discussion_r4300946398), [#251 added-tests commit](https://github.com/Mira190/SpecGuard/commit/5cd5293a666d9f3fcd2785ff0eb75e4c4f1299cb).

The new evidence at hand-in time is crucial: the CI of 9bb42c4 showed a circular-dependency warning, 20 real failures out of 1334 tests, while the dogfood job was still success. 3470958 changed focus's reading of test-map to lazy, and the subsequent test/dogfood have all passed. A "shared constant" cannot be regarded across the board as a lower-risk tidy-up; module load order is the real behavior it changed. This round's module-level reproduction had passed on 9bb42c4 and did not cover this cold-start order, which further shows that the proof scope of this document's reproductions is specific counterexamples and cannot replace the full test suite.

### 3.6 The Current Review Still Has Obvious Evidence-Reading Losses

The real summary of #249 reports:

- 11 obligations, unit evidence 0/11;
- several large test files were truncated;
- src/test-map.test.js was not inlined, so whether the relevant unit tests exist is listed as unknown;
- the citation verification of 3 obligations was downgraded;
- no tests were executed.

This does not prove the code has no tests: the repository does have return-value assertions for hunkTokens/hunkTests. It shows that there is still a gap between "the repository has tests" and "this time the model could see and verify the tests".

First inspect the four stages source→candidate→pack→model on the saved artifact, then decide where to fix. Prefer keeping the changed source's own direct unit tests and related test blocks, and then allocate budget to distant generic candidates; do not merely raise the total token limit. For entries with invalid citations, keep unknown and separately count the loss rate; they must not be automatically converted into missing_test. [#249 actual summary](https://github.com/Mira190/SpecGuard/pull/249#issuecomment-6228562297).

## 4. Problems Confirmed This Round and Minimal Optimizations

Priority indicates the impact on this project's goal. All of the following have real code locations and deterministic counterexamples; it is not claimed that every counterexample has already occurred in production runs.

### F1 · P1: Summary-only findings disappear from the label pool after being fixed

**Current state.** findingsOf reads all historical inline comments, but reads only the sum of the latest sticky summary; the producer's sum explicitly stores only this round's summary/unanchored findings. A resolved finding may remain only in outcomes and not in the current sum.

**Reproduction.** The first-round summary has 1 finding, exported and labelled valid; in the second round sum=[], and the outcome for the same fp is addressed. Result: fix-through findings=1, A=100%, but the blind-labelling pool=0, joint.with_outcome=0, and the original label is unmatched.

**Impact on the goal.** The weekly report exactly loses the summary samples that have already been dispositioned; inline history is retained, creating an asymmetry in channel lifecycle. The direction of the bias depends on which findings disappear faster, and it cannot be assumed to be merely an underestimate or overestimate of precision.

**Minimal fix.** Once the sampling cohort is established, it must not be redefined from the current summary. Use the existing per-run artifacts to save a small finding manifest (canonical ID, original claim, first exposure, original channel); the weekly report joins the latest outcome against the fixed cohort; when exporting labels, save that cohort list. Saving only the export list is not enough to recover findings that were already resolved before export, so the run-level manifest should cover the findings exposed within the window. There is no need to introduce a new database first.

**Acceptance.** After export→fix→rerun→import, the same label still matches, and valid_addressed goes from 0 to 1; even if the first export happens after the fix, the original claim can be read.

Code: [weekly-report.js:135](https://github.com/Mira190/SpecGuard/blob/ab2cfc0aafe098d5e47704ebe36df85d687847e5/eval/weekly-report.js#L135), [post.js:1828](https://github.com/Mira190/SpecGuard/blob/ab2cfc0aafe098d5e47704ebe36df85d687847e5/src/post.js#L1828). Reproduction ID F1.

### F2 · P1: Upgrading a summary to inline changes the blind-labelling ID

**Current state.** The summary ref is a 16-character fp, the inline ref is the full 40-character fp; findingId hashes the full ref plus fields such as path and line. Deduplication prefers inline, so a channel upgrade changes the ID.

**Reproduction.** With the same repo, PR, path, line, and fp prefix, going from summary to inline: F9a5e30c2e → F420a685ac; there is still only one entry, but the old label is unmatched. It is not a duplicate-counting problem, it is identity drift.

**Minimal fix.** SpecGuard's canonical ID uses a unified fp representation plus repo/PR; treat position and channel as mutable attributes. Reusing the existing 16-character tracking key reduces changes, but a collision check must be done and the full fp retained; Copilot comment IDs continue to use their own namespace. Old labels need a compatibility mapping and must not simply all be invalidated.

**Acceptance.** In the cases summary→inline, inline moving in a new diff, and original line number falling back, the label still belongs to the same finding; different PRs are not linked together.

Code: [label-export.js:16](https://github.com/Mira190/SpecGuard/blob/ab2cfc0aafe098d5e47704ebe36df85d687847e5/eval/label-export.js#L16). Reproduction ID F2.

### F8 · P1: A changed-hunk diff failure is silently swallowed

**Current state.** collect.sh runs a git diff with a 20-second timeout inside an outer try; a grep failure inside hunkTests produces a limitation, but the outer catch only returns an empty Map. The comments and the acceptance description of #249 promise that failures enter collect-limits, and this path does not do that.

**Reproduction.** Execute the candidates heredoc extracted from the real collect.sh, replacing only the filesystem and git calls: ls-files succeeds, git diff throws status=124; a.test.js candidates are still generated normally afterwards, and collect-limits is empty. This reproduction did not create a timeout in a real repository or modify Git.

**Impact on the goal.** When the hunk retrieval that big PRs need most fails, downstream does not know why it fell back to weaker matching, and may continue to judge on insufficient test evidence; run-level error monitoring cannot see this kind of loss.

**Minimal fix.** Have the outer catch append a short limitation, distinguishing a diff acquisition failure from a normal zero match; reuse the existing collect-limits propagation path. Do not report an infrastructure error for a normal "no relevant test".

**Acceptance.** diff timeout/nonzero → limitation non-empty; grep timeout → limitation non-empty; normal no-token/no-hit → may legitimately return an empty list. The tests should cover the outer wiring of the real heredoc, and not only test hunkTests.

Code: [collect.sh:291–299](https://github.com/Mira190/SpecGuard/blob/ab2cfc0aafe098d5e47704ebe36df85d687847e5/src/collect.sh#L291). Reproduction ID F8; it also exists on the latest #251 commit.

### F3 · P2: A trace failure degrades into an ordinary retrieval zero in the analysis report

**Current state.** runVariant records trace failed, but analyze does not read status; a failure and a normal empty result use the same scoring path. Missing elapsed time is also treated as zero via ||0.

**Reproduction.** A C variant with a trace timeout is analyzed as requirement Hit@3=0, and the formatted report has no failed/error/timeout; changing the status to ok yields identical output. When a synthetic record lacks trace_ms, the runtime is left with only cand_ms.

The current runner usually writes the actual elapsed time, so "missing runtime treated as zero" is mainly an input-validation issue; the core defect is that even with a failure status, the final analysis does not disclose it.

**Minimal fix.** Print the planned/completed/failed counts, the failing stage, and conditional retrieval versus end-to-end retrieval together; failures stay in the end-to-end denominator, but must not be attributed as failures of the algorithm's lexical recall. Use unknown for missing elapsed time, and do not pass it off as a performance improvement.

**Acceptance.** With the same zero score, a normal no-match and a trace-failed report are clearly different; failed samples are not quietly deleted, which would inflate the overall score.

Code: [run.js:91](https://github.com/Mira190/SpecGuard/blob/ab2cfc0aafe098d5e47704ebe36df85d687847e5/eval/trace-recall/run.js#L91), [analyze.js:65](https://github.com/Mira190/SpecGuard/blob/ab2cfc0aafe098d5e47704ebe36df85d687847e5/eval/trace-recall/analyze.js#L65). Reproduction ID F3.

### F4 / F7 · P2: Evaluation input identity and effective configuration are not fixed enough

**Counterexample one.** results.target.sha and cases.target.sha disagree, yet analyze still gives exactly the same successful score as with the correct SHA. There is no protection when old results are paired with a new cases file; this does not mean the current baseline has already mixed versions.

**Counterexample two.** The harness inherits process.env and deletes only TEST_PATHS, without pinning TRACE, IGNORE_EXTRA, STANDARDS_PATHS, TRACE_BUDGET_MS. A real trace.run(trace='off') returns a legitimate empty result with limitations=[]; if the working environment leaves TRACE=off behind, the harness can record disabled retrieval as normal low recall.

**Minimal fix.** Output and verify the target SHA, cases hash, actual source file hash, and effective retrieval configuration; the evaluation should explicitly pin these environment variables by default, and any override must be recorded. The source Git HEAD is not enough to identify a dirty file pointed to by --src. The analyzer validates legal variants and duplicate case×variant; a partial --only run declares the selected set, and a full run is not forced every time.

**Acceptance.** A wrong target / wrong cases is explicitly rejected; repeated runs with the same source and pinned configuration give the same ranking; TRACE=off must be declared explicitly rather than inherited implicitly.

Code: [run.js:81](https://github.com/Mira190/SpecGuard/blob/ab2cfc0aafe098d5e47704ebe36df85d687847e5/eval/trace-recall/run.js#L81), [analyze.js:57](https://github.com/Mira190/SpecGuard/blob/ab2cfc0aafe098d5e47704ebe36df85d687847e5/eval/trace-recall/analyze.js#L57). Reproduction IDs F4, F7.

### F5 · P2: Precision does not yet have a delivered version

**Reproduction.** A correct finding hidden only in low-confidence Details: raw TP=1, delivered TP=0; another clean case has an actionable false positive FP=1. The aggregate outputs precision=0.5, while the same-basis delivered precision should be 0/(0+1)=0.

**Judgement.** The old raw precision can continue to be saved; the problem is the lack of a clearly named new field, not a requirement to rewrite historical results.

**Minimal fix.** Add precision_delivered together with an explanation of the corresponding TP/FP basis; show raw and delivered as a pair in reports. Keep null for unknown/no-data, and do not fabricate zero.

Code: [grade.js:217](https://github.com/Mira190/SpecGuard/blob/ab2cfc0aafe098d5e47704ebe36df85d687847e5/eval/grade.js#L217). Reproduction ID F5.

### F6 · P2: The unknown expected count of an old error row is treated as zero

**Reproduction.** A new successful sample detects 1 expected finding, mixed with an old error row that has no expected_findings: E2E recall=1; after filling the same error with expected_findings=1, E2E recall=0.5.

**Boundary.** The errors newly generated by the current runner already carry this field, so it is not the case that the new runner keeps under-counting; the risk lies in reading/mixing historical evaluation files.

**Minimal fix.** Detect an unknown expected denominator, and return recall_delivered_e2e=null with the count, or require a verifiable fixture manifest to fill it in. Do not treat unknown as "this failed sample has no positive example".

Code: [grade.js:210–218](https://github.com/Mira190/SpecGuard/blob/ab2cfc0aafe098d5e47704ebe36df85d687847e5/eval/grade.js#L210). Reproduction ID F6.

### Fixed Control: Do Not Re-Report

A non-zero exit or spawn error in the candidates sub-step now throws; a normal empty list is allowed to score zero. The old "heredoc not found yet silently continues" and "candidate subprocess fails silently" should no longer be reported as unfixed problems. Reproduction C1 verified this.

F3 targets the trace-failure attribution that remains, and F8 targets exceptions swallowed inside the real collect heredoc; they are remaining problems at different layers. [candidates.js](https://github.com/Mira190/SpecGuard/blob/ab2cfc0aafe098d5e47704ebe36df85d687847e5/eval/trace-recall/candidates.js).

## 5. Does It Satisfy Shift-Left: Judged Along the Result Chain

| Layer | Current evidence | Judgement and next step |
|---|---|---|
| Runs before merge | PR dogfood, inline/summary all have instances | In place |
| Input is the current PR / current implementation | The summary carries head, base, build; local and remote must be looked at separately | A foundation exists; run head, reviewed head, and action source ref must be listed separately |
| A requirement change finds multiple implementations | Fastify req→code Recall@3 44.8%, All-required 25% | Not yet enough to claim comprehensive impact analysis |
| A code change finds requirements and tests | code→test improved markedly; code→req Hit@3 62.5% | Effective, but omissions and multiple entry points remain |
| Complete evidence enters the judgement | #249's own direct unit tests were reported as not visible, citations were downgraded | The evidence retention rate after packing needs to be measured |
| Findings are real and actionable | The seed set has successes; the quality sample of whole-repo audits is weak | Must be reported separately by PR/scan, inline/summary, repo/language |
| Findings promote fixes | There are real addressed records and the #251 added tests | A weak behavioral proxy; not equal to a verified fix |
| Fixes reduce later defects | No independent follow-up outcome comparison | Not proven |
| Value can be measured stably | New fields and blind labelling are improved, but F1/F2/F5/F6 remain | Cannot say "only samples are missing, the measurement is fully closed" |

Two suggestions for the new goal-assessment:

1. The qualifier "controlled seeded PRs prove effectiveness" should be kept, placed right next to the 10/10 figure; do not extend it to the real recall of ordinary PRs.
2. Change "all that is missing is samples" to "real samples are needed, while also completing the label lifecycle and the delivered-basis checks". F1/F2 in this document have already shown that even when new samples arrive, the current import may still lose track of them.

The disclosures in the [existing goal assessment](https://github.com/Mira190/SpecGuard/blob/ab2cfc0aafe098d5e47704ebe36df85d687847e5/docs/goal-assessment-2026-10-17.md) about limitations such as human authors, real FN, two-person labelling, and model fluctuation should continue to be kept.

## 6. Complex External Repositories: What Really Needs Observing Is How Evidence Is Lost

### 6.1 Minimal Usable Trace, Without First Building a Separate Platform

We suggest adding structured JSONL to the existing context artifact; first be able to connect one chain offline, then decide whether to hook up an external observability backend:

resolve → inventory → requirement discovery → impact retrieval → test retrieval → pack → model → validation → delivery → outcome → label join

At each stage record run_id, attempt, target_repo, target/base/action SHA, case/requirement/obligation/finding ID, elapsed time, input/output counts, budget and truncation reason. Do not write tokens or private code bodies into global logs.

| Stage | Most useful new fields | Questions it can answer |
|---|---|---|
| resolve | resolved_ref, resolved_sha, access_check, review_started | Did it scan the seeded branch, or was it misparsed as eval? Did the review not start at all? |
| inventory | eligible/inventoried/oversized/unreached | How much did the "whole repo" actually see? |
| retrieval | query_id, direction, candidate IDs, rank, why, cut | Not found, or found but fell outside the cap? |
| pack | candidate→included, line ranges, bytes, reason | Why did its own unit tests not enter the context? |
| validation | supported/unknown/rejected, citation reason | Did the model not find it, or was the finding downgraded by citation verification? |
| delivery | inline/summary/Details/unanchored, canonical ID | Did the TP really reach the area where the author can act? |
| outcome | still_reported, touched/tests_changed, observed_at | Is it a disposition proxy, or independently confirmed fixed? |
| labels | cohort_id, canonical ID, matched/unmatched, reason | Will resolution and channel conversion lose samples? |

The first things to implement are F8's limitation and F1/F2's lost-track counts. These help troubleshooting more than a standalone "average model latency" dashboard. The current counts already have ms, head, build, outcomes; reuse them and avoid creating a parallel set of synonymous fields.

### 6.2 Acceptance Focus for Thousand-Line Files and Multi-File Behavior

Long code should not be accepted solely on whether the whole file fits in the prompt. We suggest fixing a set of real multi-entry behaviors and checking layer by layer:

- Document change: find all affected implementation locations, not merely get the file name right;
- Implementation change: link back to the related requirement, and distinguish explicit requirements, implicit behavior, and unknown sources;
- Test localization: find the input, call, and assertion of the corresponding test block, avoiding having only the file header or test name;
- Cross-file delegation: distinguish "the helper was called" from "the current boundary/failure path is asserted";
- Multi-entry modification: All-required counts all required locations, rather than only looking at the first correct result;
- Does not fit: list specifically which obligations lack evidence, avoiding using a global "partially truncated" to mask the credibility boundary of each conclusion.

Under a fixed budget, compare "candidate ranking" with "the ranking that actually enters the pack". More than 1000 lines of code is a stratification condition; it cannot be assumed from this that the behavior is necessarily complex, nor that splitting into more chunks already covers the call relationships.

## 7. Metrics and Experiments: What Is Most Valuable Next

### 7.1 Product Decisions Should Look at These First

| Metric | Recommended basis | Where it is currently easy to confuse |
|---|---|---|
| delivered precision | valid / (valid+invalid) among actionable exposures, unsure listed separately | grade currently still has only raw precision |
| delivered E2E recall | delivered known positives / all planned positives, with failures and truncations keeping attribution | When historical error expected is unknown, a complete rate cannot be given |
| unknown rate | non-assessable obligations / all obligations, stratified by reason | unknown is neither the ground truth of FN nor a pass |
| All-required@K | whether all locations required by one behavior were found | A high MRR/Hit may hit only one entry point |
| pack evidence retention | how much of the required evidence found ends up in the model-visible scope | The retrieval score cannot replace packing quality |
| verified-fix rate | independently confirmed fixed valid findings / valid findings with a sufficient observation period | addressed only means the touch rule fired |
| escaped visible defect rate | among post-merge defects, the proportion where the information at the time was sufficient to find them but was not delivered | Needs after-the-fact ground truth and complete historical input |
| cost per valid actionable finding | total run cost / valid actionable findings | A low single-run cost does not guarantee a low false-positive handling cost |

The sample costs in the summaries of #248/#249/#251 are about $0.12, $0.02, $0.02, and the model durations about 78, 115, 55 seconds. They are not random samples and cannot replace the overall cost and latency distributions; but they are enough to show that the early seed figure of about $0.005/PR should not be carried over as a cost commitment for all current PRs.

### 7.2 Where MRR, MSE and Error Functions Fit

MRR is a ranking metric, already implemented in this project, and suited to judging how quickly the author sees the first correct location. MSE is the squared error of numeric prediction, and should not be the main score for "whether a requirement/test gap was detected".

This project is currently better served by precision/recall, strict pass, All-required, and stage-wise unknown, and where necessary giving the decision a transparent weighted loss:

L = cost of missing a high-impact defect + false-positive handling cost + review latency cost + run cost.

The weights need to be calibrated against actual author handling time and defect impact; this document has not measured these costs. If numeric probabilities are output later, then evaluate probability calibration; the current high/low confidence labels should not be used directly as calibrated 0–1 probabilities.

### 7.3 Two Kinds of Recall Experiments Must Be Kept Separate

**Retrieval recall.** Keep the current Fastify fixed set as the development set, and add an external held-out set of a different language/organization structure; include thousand-line files, multiple entry points, cross-file delegation, different naming, and dynamic registration. Split R/C/RC variants together by group, to avoid putting variants of the same behavior separately into the development and held-out sets.

**Product recall.** Independently re-review ordinary no-alarm PRs to find real FN; for scans, use a paired experiment of known gaps and clean controls. Freeze the ground truth first and then run the tool; the positive examples must not be defined backwards from the tool's output.

The seeds themselves also need two-person confirmation: that it is a real gap, was originally not asserted by existing tests, and the executable behavior before and after the change is clear. Looking only at "3 extra findings, of which 0 valid" cannot imply that the whole-repo tool's precision is always zero; nor may the small sample be used as a reason to ignore quality risk.

## 8. Suggested Execution Order and Acceptance

| Order | Work | Minimal acceptance | Relation to the goal |
|---|---|---|---|
| 1 | Complete #251, wait for the required checks on the latest head | hunk candidates stay in context but do not trigger a literal cover downgrade; both the direct parser and the real post regressions pass | First protect real-gap recall |
| 2 | Fix F8's outer-exception disclosure | After injecting a git diff timeout, collect-limits is non-empty; a normal zero hit does not report a fault | Losses in complex PRs are no longer silent |
| 3 | Fix F1/F2 label cohort and canonical ID | The export→fix→rerun→promote→import full chain still associates | Obtain a credible value conclusion |
| 4 | Add evaluation identity and failure attribution for F3/F4/F7 | A wrong SHA is rejected; trace failure is explicitly disclosed; the effective config is reproducible | Avoid optimizing the algorithm against pseudo-regressions |
| 5 | Add delivered precision; fix the old error denominator | F5's 0.5 and 0 are named separately; F6's unknown denominator does not output 100% | Unify the product score basis |
| 6 | After #252, get the seeded scan preconditions running | Access, full ref, target SHA, stateless all confirmed, then compute recall | Truly test the scan, instead of counting resolve failures |
| 7 | Analyze the pack loss of the #249 artifact | Locate at which stage src/test-map.test.js was lost or not read | Reduce wrong test-adding suggestions |
| 8 | Held-out repository, no-alarm PR sampling, two-person blind labelling | Fixed cohort, pre-registered denominator, report unknown and intervals | Test real generalization and misses |

There is no need for now to first build a vector database, a cross-repo whole AST graph, or a standalone observability platform. Whether these are worthwhile should be decided by measurement of "which kind of omission accounts for the main FN, and whether existing candidate/pack changes have stopped being effective".

Branch handling is advice only: #251/#252 are the currently relevant work awaiting merge, and should each complete their checks, with a newer commit time not standing in for compatibility verification; the already merged #243–#250 are not merged again. This round does not delete historical worktrees, and in particular does not touch directories that still have uncommitted content or are locked by other agents.

## 9. Reproduction, Attachments, and Unchecked Items

Mainline reproduction command:

    node docs/review-probes/actions-followup-2026-10-17/probe.cjs

Comparison against the latest reviewed #251:

    node docs/review-probes/actions-followup-2026-10-17/probe.cjs 34709585be3f7b787a74671ca54183f94c3d876c docs/latest-pr-actions-pr251-probe-results-2026-10-17.json

The script loads the real CommonJS modules of the pinned Git tree and records the source hash. F8 uses the real heredoc plus an injected in-memory filesystem and git timeout; the other cases are module-level deterministic inputs. Both rounds completed all assertions. The temporary trace-off files are cleaned up file by file inside the directory newly created by the script itself, and the product code and Git state were not changed.

Attachments:

- [Raw evidence of this round's runs and PRs](/C:/Files/Projects/SpecGuard/docs/latest-pr-actions-followup-evidence-2026-10-17.json)
- [Later version refresh record](/C:/Files/Projects/SpecGuard/docs/latest-pr-actions-refresh-2026-10-17.json)
- [Hand-in cut-off PR/CI and circular-dependency failure evidence](/C:/Files/Projects/SpecGuard/docs/latest-pr-actions-final-cutoff-2026-10-17.json)
- [main deterministic reproduction results](/C:/Files/Projects/SpecGuard/docs/latest-pr-actions-probe-results-2026-10-17.json)
- [#251 new-commit reproduction results](/C:/Files/Projects/SpecGuard/docs/latest-pr-actions-pr251-probe-results-2026-10-17.json)
- [Reproduction script](/C:/Files/Projects/SpecGuard/docs/review-probes/actions-followup-2026-10-17/probe.cjs)
- [Previous round's metrics and definitions analysis](/C:/Files/Projects/SpecGuard/docs/shift-left-metrics-and-latest-review-2026-10-17.md)
- [Research on bidirectional traceability for complex repositories](/C:/Files/Projects/SpecGuard/docs/complex-repository-bidirectional-traceability-research-2026-10-17.md)

Not checked: the raw pack inside the artifact ZIPs, a re-run of the full Fastify retrieval, the Kite seeded-scan ground-truth experiment, real human-author adoption and post-merge defect data. The test/dogfood conclusions for the latest heads of #251/#252 were checked, but not every model output was reviewed. The corresponding conclusions are all kept as pending acceptance, and CI green or synthetic reproduction is not used as a substitute.

