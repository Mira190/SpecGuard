# SpecGuard and Kite: A Shift-Left Re-check Based on Actual Actions, PR Reviews, and Scans

> **Disposition status (2026-10-17, main 45713a2):** The findings in this document have been re-checked. Fixed: 6.1/6.2 source and layer protocol noise (#229); 6.3 spec conflict direction (#227); failed re-run overwriting results (#228); requirement link recall (#232); fix-through metering (#233); large test context truncation (#234); scan throughput (#230, #231, #235, measured nest 7→32 units per run). Unfixed / to do: the Kite seeded re-test is blocked by Kite's expired Anthropic secret; the "reduced=incomplete" status semantics are to be decided. Line numbers and SHAs are as of when this document was written.

Date: 2026-10-17, Australia/Sydney. Final online snapshot: 2026-10-16 23:43 UTC (Sydney 10:43); local reading continued until about 10:45. This document continues the [strategy report](/C:/Files/Projects/SpecGuard/docs/shift-left-value-strategy-2026-10-16.md) and the [previous unknown-risk re-check](/C:/Files/Projects/SpecGuard/docs/unknown-unknown-review-2026-10-17.md).

**Judgment: it has been proven able to find valuable test and requirement problems before merge, and an actual fix loop has appeared; it is not yet enough to prove that it satisfies shift left stably and comprehensively, and certainly cannot be used to claim that real teams' QA rework or defect escapes have been reduced.** The current priority should be to make existing evidence correctly recognized, make scope and failure states explainable, and make findings correspond to fixes, before expanding the scan volume.

This round read the two repositories' run metadata, the raw logs of selected jobs, the latest PR summaries and review discussions, change patches, workflows, scan issues, and artifact lists through the GitHub plugin; the state of the new local fixes was also checked. No paid model was re-run, and nothing on GitHub was modified, merged, or cleaned. For detailed samples see the [18-PR ledger](/C:/Files/Projects/SpecGuard/docs/shift-left-live-review-ledger-2026-10-17.csv) and the [raw evidence snapshot](/C:/Files/Projects/SpecGuard/docs/shift-left-live-review-evidence-2026-10-17.json).

## 1. Judgment criteria and version boundaries

Shift left here means: while the author can still modify and before merge, based on the requirements and code available at the time, point out credible and actionable verification gaps; after that there are corrections and verification, and traceable evidence is kept. An advisory review can also satisfy the goal, and it is not required to turn all AI findings into mandatory blockers.

| Boundary | Actual reading result | Impact on the conclusion |
|---|---|---|
| SpecGuard initial main branch | 8415eae, #223 merged | The previous round's defects must be reclassified according to later fixes |
| SpecGuard final main branch | 9cdc780c55e1352fffab6397698c87edc388175d, #224 and #225 both merged | The corresponding problems can no longer be described as "not yet fixed on the current main branch" |
| Kite target main branch | master: 8583c5000c360ab437e07f60ada03f895a87c0b7 | Not main; the baseline of the scan and the seeded PRs is explicit |
| Kite latest Action that has run | 242507f176a296e1c1a65a4acd42c870aefccb76, build ac93c6d8e3f4 | Not this round's latest SpecGuard main branch, cannot be taken as acceptance of the new fixes |
| Kite previous scan Action | aa183c7c09dc8cde1fac2a3c2607520c72be2c80 | Two results for the same target commit, with different tool versions |
| Local DENY fix | fix/deny-all-inputs: e367359; includes 0cc092c and merged the latest main; the working tree was clean when read | The new fix is now a local commit; there is no evidence yet that it has gone live and been re-accepted |

Version basis: [SpecGuard final main branch](https://github.com/Mira190/SpecGuard/commit/9cdc780c55e1352fffab6397698c87edc388175d), [Kite latest scan log entry](https://github.com/Mira190/Kite/actions/runs/38713252604), [previous scan](https://github.com/Mira190/Kite/actions/runs/38704392965). The local fix worktree is still used by other tasks and was only observed in this round.

## 2. Run success and review validity are two sets of numbers

Latest 50 runs at the final snapshot: SpecGuard 47 success, 2 failure, 1 cancelled; Kite 50 success. They are GitHub execution conclusions, and cannot be converted directly into finding accuracy, test sufficiency, or complete review rate. The window moves with new runs and cannot be compared directly with the window of the previous report.

The PR summaries reviewed one by one this round are fixed as SpecGuard #218–#225 (8 in total) and Kite #10–#19 (10 in total), taking only the latest sticky summary at snapshot time for each PR:

| Metric | SpecGuard: 8 | Kite: 10 | Correct interpretation |
|---|---:|---:|---|
| Summary head aligned with the current PR head | 8/8 | 10/10 | Directly using an old-head summary to evaluate new code has been excluded |
| reduced=true | 8/8 | 10/10 | All are fast-tier reviews, which does not mean model calls failed |
| complete=true | 0/8 | 0/10 | Cannot claim a complete check passed |
| execution_complete=true | 1/8 | 10/10 | PR execution status; not equal to whole-repository coverage |
| Summary ms median | 48.33 seconds | 20.86 seconds | Summary timing, not a single API or pure model latency |
| Run creation to summary update median | 64.5 seconds | 40 seconds | Approximately correlated via the same head and latest event, not an exact trace |
| Total cost of latest summaries | $0.53 | $0.0491 | Excludes old pushes, early retries, runner, or other tool costs |
| Final PR status | all 8 merged | all 10 open, not merged | Fix benefit cannot be judged merely from merge or comment counts |

SpecGuard final main branch [CI 38982638077](https://github.com/Mira190/SpecGuard/actions/runs/38982638077) actual log is **1218 tests, 1214 pass, 0 fail, 3 skipped, 1 TODO**; the dogfood job of the push event was skipped. The earlier main run for 8415eae was 1208 tests, 1204 pass; the report uses the updated result to avoid confusion.

This shows the project has fast pre-merge feedback and a normal testing foundation. But "CI green + no high-confidence findings in the summary" is still not enough to prove that a change is adequately protected.

## 3. Cases of effective shift-left that have already happened

### 3.1 #224: bot review → new regression test → CI → merge

This is the most direct positive evidence this round:

| UTC time | Event |
|---|---|
| 23:36:42 | The review pointed out: when handling -w, the numbers of deleted/added lines differ, so even if one pair differs only in whitespace, that hunk must be kept |
| 23:37:14 | f6204b8 added the corresponding boundary test, 32 seconds after the comment |
| about 23:38:29 | Tests on the new head completed: 1213 tests, 1209 pass, 0 fail, 3 skipped, 1 TODO |
| 23:40:06 | #224 merged into main |
| about 23:41:00 | Main-branch CI after the two fixes were merged: 1218 tests, 1214 pass, 0 fail |

The new test asserts both "still kept when line counts differ" and "ignored when line counts are the same and the difference is whitespace only"; it is a regression test that constrains specific wrong behavior, and has real value. [Original review text](https://github.com/Mira190/SpecGuard/pull/224#discussion_r4300257588), [new test commit](https://github.com/Mira190/SpecGuard/commit/f6204b8a2e7e7063cd9c38a87cca548f79854e7b), [PR CI](https://github.com/Mira190/SpecGuard/actions/runs/38982400348).

However, the latest machine counts are still prior_total=1, outcomes=[], and do not fully express this fix. **The actual closed loop exists, while the existing aggregate metrics did not capture it; addressed=0 must not be read as no value.** This example also cannot prove human adoption: changes under the account may come from an agent.

### 3.2 #215: review avoided turning uncertainty into a re-run loop

The earlier actual discussion at 11:49:52 UTC pointed out that weak-only Unknown should not automatically require a re-run; debb50a at 11:52:43 changed the prompt and related tests, a reply at 11:54:14 confirmed this loop risk, and it merged at 12:12:37. Afterwards #221 further strengthened the structured reduced reasons.

This is a case of identifying a product feedback loop before merge; the contribution comes from the review chain as a whole and cannot all be attributed to the model. [PR #215](https://github.com/Mira190/SpecGuard/pull/215), [fix commit](https://github.com/Mira190/SpecGuard/commit/debb50a66d933bee825457a90e254d3775d5a0d6).

### 3.3 Kite: "code and tests deviating from the requirement together", which ordinary tests easily let through

In Kite #15–#19 the code and tests accept the new behavior together, but the design document was not changed: duration, the pre-check for writability, the shortcut default, the button copy, and the allowed range all drifted. The review can point out the specific differences on both sides, a capability complementary to ordinary test execution.

So the focus should continue to be "is behavior consistent with the requirement, and do the assertions protect the behavior", rather than making comment counts and file scan counts the value target.

## 4. Kite's ten seeded PRs: effective detection, but not to be taken as real team benefit

These PRs are agent-written seeded experiments explicitly recorded in the project's validation plan, each PR having one pre-planted problem, and all being positive samples. This round checked the patches, the latest summaries, related tests, and the design document, following the original plan's definition "the specific difference is visible on the first screen"; low-confidence mirrors in Details were not counted as first-screen success.

| PR / seed | Actual preset problem | Latest summary presentation | This round's judgment |
|---|---|---|---|
| [#10 / U1](https://github.com/Mira190/Kite/pull/10#issuecomment-6163634111) | Deleted the assertion for the case-insensitive duplicate name BIG | First screen says no high-confidence gap; Details has low-confidence content, history has inline | Did not meet the first-screen standard |
| [#11 / U2](https://github.com/Mira190/Kite/pull/11#issuecomment-6163639256) | Exact clamp-value assertion weakened to assert.ok | First-screen weak test, plus an extra finding | Detected the preset problem |
| [#12 / U3](https://github.com/Mira190/Kite/pull/12#issuecomment-6163642313) | Deleted the "exactly the current moment" scheduling boundary case | Explicitly points out the missing boundary case | Detected |
| [#13 / U4](https://github.com/Mira190/Kite/pull/13#issuecomment-6163641119) | Added mouse button 4/5 branches, only added an unrelated keyName test | Explicitly points out the new branch has no test | Detected |
| [#14 / U5](https://github.com/Mira190/Kite/pull/14#issuecomment-6163639462) | Abort-space threshold 100→128 MiB, new boundary unprotected | summary-only explicitly points out the threshold boundary | Detected, inline need not be insisted on |
| [#15 / R1](https://github.com/Mira190/Kite/pull/15#issuecomment-6163638242) | Silence duration 10→15 seconds, document still says 10 seconds | Explicit spec mismatch | Detected |
| [#16 / R2](https://github.com/Mira190/Kite/pull/16#issuecomment-6163641048) | Removed the output-directory writability pre-check, the test was changed in sync to allow it | Cites the document requirement of writability | Detected |
| [#17 / R3](https://github.com/Mira190/Kite/pull/17#issuecomment-6163643321) | Camera shortcut default unbound→Ctrl+F4 | Explicit default-value conflict | Detected |
| [#18 / R4](https://github.com/Mira190/Kite/pull/18#issuecomment-6163640934) | "Stop recording"→"End recording", document copy not changed | Explicit copy conflict | Detected |
| [#19 / R5](https://github.com/Mira190/Kite/pull/19#issuecomment-6163642034) | Countdown range 0–9→0–5, document still 0–9 | Explicit range conflict | Detected |

Values observed this round: **first-screen presentation 9/10; unit-test seeds 4/5, requirement seeds 5/5.** This is the result of the old Action version on this fixed positive-sample set, and cannot be written as "the latest SpecGuard's overall recall is 90%", nor can blind precision be computed. The extra finding of #11 does not increase the denominator of preset problems or the hit count.

#14 should add the expectations on both sides with independent values 127 MiB and 128 MiB; if the test only references the same production constant, production and test may pass together when the constant is wrong. The behavior prescribed by the requirement should be protected.

All ten PRs are unmerged; no maintainer disposition comments were observed in the sample discussions, and there are no review-arm labels. There is currently no evidence that the ten pieces of feedback completed any fix, let alone human fix-through. The Kite summary's addressed=0, open=9, not_observed=3 are thread observations that may include historical duplicates, and cannot be converted into a miss rate or false-positive rate.

For the definition of the experiment see the [seeded experiment description in the validation plan](https://github.com/Mira190/SpecGuard/blob/9cdc780c55e1352fffab6397698c87edc388175d/docs/validation-plan.md); the requirement check comes from the pinned-version [Kite design.md](https://github.com/Mira190/Kite/blob/8583c5000c360ab437e07f60ada03f895a87c0b7/docs/design.md).

## 5. Kite whole-repo scan: it can find existing-stock issues, but has not yet formed comprehensive assurance

The actual scope of [scan run 38713252604](https://github.com/Mira190/Kite/actions/runs/38713252604) and [issue #3](https://github.com/Mira190/Kite/issues/3) is as follows. The issue is a mutable latest state, not an immutable archive of every run.

| Layer | Actual evidence | Conclusion that should not be drawn |
|---|---|---|
| Unit discovery | 43 units; 26 with matching tests, 17 unmatched | Matching a file does not mean the test is effective; unmatched does not mean there is no test at all |
| Collection / actual review | 12 selected, actually reviewed 9/43 | Cannot say this run fully scanned 43 |
| Not loaded into context | engine.cjs, scene.ts, settings.ts: three units not reviewed | This round should keep them as to be checked |
| Large file | app.cjs this round only part 1/2, lines 1–481 | The whole file cannot be counted as done |
| Requirement documents | 1 document; 131 blocks reviewed historically, 80 reviewed this round, 51 carried over | Historically reviewed does not mean the current version was fully re-checked |
| Evidence candidates | Of 80 blocks, 66 have code candidates, 65 have test candidates | Candidate paths cannot be taken as proof that the requirement is satisfied |
| Document results | Visible groups: 11 gaps reported in both rounds, 88 unsure, 26 covered | Agreement in two rounds does not mean the problem was independently verified |
| State changes | 38 blocks changed state for the same target commit | The two Action SHAs differ, so it cannot be counted directly as model random variation |
| Execution mode | Static review, explicitly no tests executed | covered cannot be interpreted as the tests having been run and passed |

In addition, the risk table marks scene/settings as "this run" while the scope list says they did not fit. What this round can confirm is that this old run report presents an inconsistency; it needs replay verification on the latest version, and it cannot be directly assumed to still exist after the new fixes.

The issue has verifiable document drift, for example the window height: code 800 and document 740 disagree. The existing open [PR #4](https://github.com/Mira190/Kite/pull/4) involves similar window and default-selection problems, but is not merged, and one cannot assert that it was triggered by this scan merely because the topic is the same.

The report is about 62.9K characters, close to the GitHub issue capacity; it explicitly omits 4 rows and points to audit.json. Yet this round found the artifact lists of the latest scan, the previous scan, and the sampled PRs all empty, so the omitted evidence cannot be retrieved. **What can be confirmed is "currently cannot be obtained from the list"; it must not be attributed on one's own to expiry, deletion, or never having been uploaded.**

The latest scan's footer is about $0.52, 772.9k input, 34.6k cache, 60.2k output, 4m03s, 6 API calls, 19 unanswered blocks retried once. It shows the scan's cost and latency are significantly higher than a single PR review; it should prioritize incremental review by changes and high-risk gaps, rather than unconditionally and repeatedly widening the whole-repo context.

The reasonable positioning of a whole-repo scan is to cover stock debt, find requirement drift outside PR diffs, and bring the related obligations back to later PRs; a standalone periodic repo scan cannot prove that problems have been shifted left to the PR that introduced them.

## 6. Priority problems exposed by the actual reviews after the new fixes

### 6.1 High priority: inconsistent requirement-source protocol causes "asked to find a test even though a test exists"

In the latest #224 summary all 7/7 obligations were downgraded to Unconfirmed: the model used "PR body U1/U2/U3/U4", the validator accepts the canonical source "PR body" and forms where an AC numeric suffix can be stripped; U1 was treated as a document source not in the collected set.

O1–O6 already list the concrete assertions of eval/weekly-report.test.js, including missing patch returning null, paths before and after rename, real Git comparison, and the new -w boundary. Because the linked requirement source is invalid, the UI still gives 4 items of "Point to the unit test or add one". [Actual summary](https://github.com/Mira190/SpecGuard/pull/224#issuecomment-6226700210), [source validation implementation](https://github.com/Mira190/SpecGuard/blob/9cdc780c55e1352fffab6397698c87edc388175d/src/post.js#L1102).

**The cause is that the model output and the validator's source protocol are not aligned, and it cannot be directly asserted that the tests do not exist.** Keep the principle of rejecting illegal sources; have the collector provide a canonical source ID so that the model can only reference existing IDs, with display titles such as U1 stored separately. A source error should get a limited number of correction chances, and if still unverifiable, honestly Unknown. Do not restore green by loosening arbitrary file references or by directly turning Unknown into covered.

The next step for the author should also distinguish: source to be confirmed, test evidence really missing, context not collected; source-format problems should be corrected by the tool itself first.

### 6.2 High priority: the test-layer field is missing, and cannot be translated into "please add another unit test"

In #225, 4 of 6 obligations were downgraded for "layer not stated / path not clearly unit", and several engine and test files were truncated. The latest summary itself admits there are chain tests of planner→adapter→audit-post→gate, yet still feeds back the related obligations as unconfirmed. [Actual summary](https://github.com/Mira190/SpecGuard/pull/225#issuecomment-6226704295).

The minimal improvement is to make the evidence layer mandatory, have the collector provide verifiable identifiers for path classification, allow limited retries for structural errors; and separate "has integration protection but does not prove independent unit behavior", "no evidence seen", and "evidence format invalid". When unit evidence is really needed, say specifically which independently constrainable behavior still lacks protection. Do not split a chain test that is appropriate into tests that only verify implementation details just to obtain a unit-coverage label.

### 6.3 High priority: correctly finding a document conflict does not mean the fix direction the model suggests is correct

The #222 review correctly found the conflict between the PR body's "policy advisory" and the code CONFIG including policy, but suggested removing policy to obey the old PR body. The maintainer's actual intent is that configuration errors such as organization-disabled should be red, while security rejections may share the policy classification. [Original review text](https://github.com/Mira190/SpecGuard/pull/222#discussion_r4299937890), [PR #222](https://github.com/Mira190/SpecGuard/pull/222).

Here the requirement should be to confirm the error classification and acceptance intent and to sync the PR body/documents, rather than defaulting to changing the code back to the old copy. The quota/policy classification fix commit is even earlier than the later review reply, so it must not be recorded as a fix prompted by that comment.

A requirement conflict is valuable, but suggestions need to distinguish "confirmed violation" from "intent to be confirmed". In particular, one must not default to natural language being forever superior to an explicit product decision just because it existed earlier.

### 6.4 Medium priority: the context budget should revolve around behavior obligations, not stuff in files evenly

Many SpecGuard summaries are affected by truncation of large test files and related test snippets; #223 also involves the appropriate test level of collect.sh. Blindly raising the global character count or adding neighboring files may raise cost while still not seeing the real assertions and call chain.

It is suggested to load first "changed behavior → callers / key guards → corresponding assertion snippets → necessary requirement original text"; for each obligation record which edge is missing. If a file is locally complete but globally incomplete, the status should also be computed per obligation, so that one truncation does not turn all unrelated conclusions into Unknown.

### 6.5 Previous round problems already advanced: accept by real status, avoid reopening defects

| Previous item | Latest status | Acceptance still needed |
|---|---|---|
| API diff missing patch, rename, -w semantics | #224 merged, with new boundary regressions | Observe the touched/fixed judgments of real later PRs, avoiding historical data being wrongly rewritten |
| Scoring definition of coverage rows vs low-confidence mirrors | #224 made explicit through tests: rows with a low-confidence / Details mirror are not counted as an additional FP; rows with no finding are still counted | This is a contract clarification, and can no longer be directly listed as a confirmed algorithm bug; first-screen detection and the FP metric need to be explained separately |
| Configuration failure after partial success of a split scan masked by green | #225 merged, chain regression and CI pass | Verify configuration failure, transient failure, and budget stop separately; partial valid results should still be kept |
| DENY document/trace entry points | Local 0cc092c fix committed, e367359 merged the new main; clean when read | Confirm the release status, and run regressions for all input entry points; no Kite latest-run acceptance yet |

This round did not mistake the new local commits that already exist for "not yet fixed", nor treat local candidate fixes directly as live protection.

## 7. Observability and trace: first make every conclusion re-checkable

There are already head, build, model, ms, cost, reduced, and outcomes, a good foundation. The main gaps are cross-run correlation, reasons for partial results, artifact reachability, and fix events. There is no need to introduce a large tracing platform first.

| Minimum record | Actual problem to solve |
|---|---|
| repo, PR, target/base/head SHA, full Action SHA, run_id, run_attempt, job_id | Kite uses a floating main, two versions were mixed as stability verification; the build fragment is not enough to locate source code directly |
| model, fingerprint of prompt/configuration summary, budget, timeout, shard ID, fingerprint of the input set | Distinguish code changed, tool changed, input truncated, and model variation |
| Duration and result of each stage collector→pack→provider→validator→render→post | Distinguish waiting, inference, evidence validation, and delivery latency |
| Per-obligation source ID, code/test ref+path+range, evidence level, enum of degradation reasons | The protocol problems of #224/#225 should not be counted as missing tests |
| Shard success/failure classification, retries, retained results, final gate decision and reason | After partial success, quota/auth errors must not be masked by execution success |
| Schema version, SHA digest, storage location, and validity period of result.json / audit.json | Content omitted by the issue must still be retrievable; an empty artifact list must clearly indicate evidence unavailable |
| Stable finding ID, linked fix commit, subsequent CI, final disposition | The valid fix of #224 must not be left outside addressed=0 |

It is suggested to add the above fields to the existing JSON; stage names can use the span concept, but first implement as downloadable structured records. Logs and summaries reference the same trace ID; each shard is a child record. Coverage is based on the current target SHA, current input, and evidence, with historical states carrying their source time and version.

Raw prompt/context can be kept short-term; small, processed results, versions, decisions, and fix links should be kept long enough for pilot evaluation. The specific retention days follow the project's data policy, and there is no need to keep all private source code permanently for the sake of trace.

## 8. Item-by-item judgment on whether shift-left is satisfied

| Requirement | SpecGuard actual performance | Kite actual performance | Verdict |
|---|---|---|---|
| Delivered to the author before merge | Runs on PR events, about one minute; #224 clearly delivered before merge | Runs on PR events, about 40 seconds; seeded PRs still open | Proven |
| Find behavior risks that ordinary tests let through | #224 boundary test, #215 feedback loop | Weak assertions, deleted boundaries, code and tests deviating from the requirement together | Value proven to exist |
| Conclusions constrained by verifiable evidence | Validation failures degrade, avoiding false covered | Cites requirements and code, low-confidence content presented separately | Partly satisfied; source/layer protocol hinders usability |
| Current scope clear, no false full coverage | reduced and truncation presented explicitly | 9/43, shards, carried-over history presented explicitly; the table has inconsistencies | Partly satisfied |
| Suggestions specific and fix direction reliable | #224 specific; #222 direction needs human confirmation | Most seeded feedback specific | Partly satisfied |
| Verified after fix and merged | #224 has a direct closed loop; #215 has a historical closed loop | The ten seeded PRs have no closed loop | SpecGuard has cases, Kite not proven |
| Failure and incomplete states trustworthy | #222/#225 improve configuration failure handling | The latest actual execution is still the old Action | New code verified, cross-repo go-live not proven |
| End-to-end traceability | Versions and counts exist, fix linkage insufficient | Artifacts currently unavailable, issue mutable, version drift | Partly satisfied |
| Real team incremental benefit over existing review | No qualified human-controlled sample yet | Seeded positive samples do not answer this question | Not proven |
| Required merge gate configuration | protection API 403 | protection API 403 | Cannot be verified; the advisory design does not automatically fail because of this |

**Product-stage judgment: suitable to continue with a controlled PR advisory pilot and targeted scans; there is no evidence to support externally claiming "comprehensive shift-left assurance" or "real defect rate has been reduced".**

## 9. Work order most beneficial to the goal in the next round

### P0: first eliminate the evidence loss in this real run

1. Unify the source ID and test-layer protocols; keep replay samples for the U labels of #224 and the missing layers of #225. Acceptance: after normalization existing valid evidence can be cited, and illegal sources are still rejected; if correction fails, specifically explain the unknown cause, without automatically changing to pass.
2. Record the merged #224/#225 and the local DENY fix separately as "merged / local candidate / verified cross-repo". DENY acceptance covers all entry points such as requirement documents, trace index, and linked files, not just the diff.
3. For the success + configuration-failure path of a partial scan, keep the existing chain regression; at the same time ensure ordinary rate/network/budget cases are presented per the established advisory contract, avoiding turning everything red.

### P1: do one version-controlled cross-repo acceptance, then widen the scope

Pin the full SpecGuard SHA, Kite target/head, model, and configuration, use the existing ten seeds, and add normal-change controls with no planted problems. When a real-model re-test is needed, first limit the budget and count; this round triggered none of these runs.

Acceptance should at least answer: whether the first-screen omission of #10 is resolved; whether the summary-only of #14 is correctly counted as an actionable finding; whether requirement drift continues to get specific evidence; whether normal controls produce wrong gaps; whether the protocol errors of #224/#225 disappear; whether the scope table of the scan under the new version is self-consistent. Small-scale repeats on fixed input are used to observe variation, and agreement between two rounds of different Action versions is not taken as a stability conclusion.

Also ensure that the complete audit.json is obtainable, or give a clear "evidence unavailable" status. Keep the result JSON and the short human summary separate, so that the 64K character limit does not force key evidence to disappear.

### P2: move from finding counts to verifiable incremental benefit

First record the finding → test commit → CI → merge chain as in #224; distinguish automatic matching of "touched the file", the author acknowledging validity, human verification of the fix, and the test really being able to catch the error. Keep not_observed as unknown, and do not automatically treat it as fixed or a false positive.

The human pilot continues to follow the existing validation-plan: at least 30 blind-labelled items per tool, a fix-through target sample of 40 PRs / 100 findings, at least 30 relevant merged PRs for merge time; when short, only counts are reported. The existing continuation conditions include precision ≥65%, fix-through ≥25% with PR-clustered lower bound >15%, merge time increase ≤15%, and unique valid findings in the control ≥40%. These are acceptance criteria the project wrote down in advance, and the current samples do not yet meet them.

Agent-written seeds and self-reviewed PRs are reported separately; a personal account name cannot replace verification of author type. Long-term defect escape and QA rework need later observation, and the current latest run cannot give such causal conclusions.

## 10. Boundaries and deliverables of this round

- This is a real-run re-check, not a complete re-judgment of all historical PRs, every test, and every finding of the whole repository. The per-PR samples number 18; in addition two scans, selected job logs, and the historical closed loop of #215 were read.
- The workflow's same-repo, non-draft condition means forks/drafts are outside this automatic path; the scope should be written into the adoption documentation. The two SpecGuard workflows of Kite read this round have no test-execution step, and it cannot be inferred from this that the whole Kite repository has no other tests or checks.
- The branch protection API had no permission; the artifact list had no entries; the missing complete audit.json was not obtained; the Kite application or a new model replay was not run. These boundaries are not filled in by guessing.
- The local root directory is still an earlier fix branch, with the remote main and other worktrees newer; this round compared by SHA and actual file state, and did not simply equate directory location or commit date with "the latest of all code".

Deliverables: [18-PR CSV](/C:/Files/Projects/SpecGuard/docs/shift-left-live-review-ledger-2026-10-17.csv), [evidence JSON](/C:/Files/Projects/SpecGuard/docs/shift-left-live-review-evidence-2026-10-17.json). They keep the summary text, related discussions, versions, latest run window, and selected logs, supporting a re-check of this round's judgments after the sticky summary or issue changes later.
