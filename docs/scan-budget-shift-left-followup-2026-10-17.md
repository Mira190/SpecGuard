# SpecGuard Latest Incremental Re-review: Seeded Scan, Segment Budget, and Shift-Left (2026-10-17)

Conclusion of this round: #251–#258 have gotten the seeded scan running and fixed the segmentation and budget problems exposed by real runs; but "reaching all units" still does not equal "having reviewed all code and tests". The new reproductions found that there are still gaps among the status, the segment execution record, and the static clue output. These gaps should be closed first, before expanding the scan scale.

The main change is that there is now a real seeded scan, so recall can be discussed, and there is no need to stay at "scan entry blocked". However, the static clues' 6/8 and the model findings' 3/8 cannot be directly merged and interpreted as "model review accuracy 75%".

## 1. Versions and method of this round

| Object | Pinned version / state |
|---|---|
| Latest remote main | 2fb6f911b262a239bc8e21d84b7ff92a6bbfa8b7, after #258 was merged; checked again before hand-in and consistent |
| Newly merged PRs | #251, #252, #253, #254, #255, #256, #257, #258 |
| Latest local implementation | The relevant worktrees contain the final commits of #255/#256/#258; no product-semantic diff at check time |
| Root directory checkout | Older when work started, switched by another process in the meantime, finally consistent with main 2fb6f91 |
| GitHub reading window | 2026-10-17 about 06:36–06:45 UTC, Sydney 17:36–17:45 |
| Code review method | Read from the fixed Git tree, checking implementation, callers, tests, and real PR reviews |
| New reproductions | 5 deterministic scenarios; real modules, temp files, controlled Git reads, mock API / GitHub, no network calls |
| Re-check of old problems | F1/F2 reproduced again on the latest SHA; other old problems graded by whether the source file changed |

This round only added reports, evidence, and reproduction scripts; it did not modify product code, switch branches, clean worktrees, post GitHub comments, or re-run paid models.

On one occasion another process's operation moved away an untracked directory; this round's probes were rebuilt afterwards and the final files were checked. The "latest implementation" was not inferred from the root directory's transient HEAD, and all results are bound to pinned SHAs.

[Pinned main](https://github.com/Mira190/SpecGuard/tree/2fb6f911b262a239bc8e21d84b7ff92a6bbfa8b7).

## 2. Latest real runs: progress made and conclusions that still need to be limited

### 2.1 SpecGuard mainline CI

[main CI 39003157050](https://github.com/Mira190/SpecGuard/actions/runs/39003157050):

- test success: 1362 tests, 1358 pass, 0 fail, 3 skipped, 1 TODO.
- dogfood skipped: a push to main does not run the model review per the workflow conditions.
- This proves the current test suite passes; it cannot prove that all segment states or real gaps are covered.

The real failure of [#258's early run 39002444159](https://github.com/Mira190/SpecGuard/actions/runs/39002444159) was the fixed manual form input contract: a new input made the test fail, and in the end it was chosen not to add that item to the specguard-run form. The current final version passes, and it cannot continue to be listed as an unfixed product fault.

### 2.2 Kite run sequence

| Run | Facts directly verified this round | How to interpret |
|---|---|---|
| [39001043636](https://github.com/Mira190/Kite/actions/runs/39001043636) | audit job success, STATUS=failed at the end; the process lasted only seconds | At that time there really was the distortion "engine failed but job green"; not a normal no-findings result |
| [39001362367](https://github.com/Mira190/Kite/actions/runs/39001362367) | audit success, STATUS=incomplete; log 58 of 43 units | The subsequent scan actually started and completed multiple rounds of calls, but the log denominator mixes parts and units |
| [39002428421](https://github.com/Mira190/Kite/actions/runs/39002428421) | audit success, STATUS=incomplete; CONTEXT_PACK_BYTES=150000; log 71 of 43 units | The new pack configuration reached both collection and the engine; 71 still cannot be taken as 71 independent units |

#256's review notes and patch attribute the first failure to the declaration initialization order at the engine script entry, and add a script-entry regression and the internal error category. What this round's log directly confirms is the conflict between STATUS=failed and job success; unread engine-notes content was not passed off as the full log.

After the fix internal was added to the forced-failure categories, which is substantive progress. A launch-entry test should still be kept, because a normal module import does not guarantee the correct initialization order when the script is run directly. [#256 review](https://github.com/Mira190/SpecGuard/pull/256#pullrequestreview-5556083187).

### 2.3 About 43/43, 30 whole + 13 forced

The maintainer reviews of #256/#258 record: all 43 independent units were reached, 30 whole and 13 forced, the latter having only part of their tests loaded and recorded as unsure. #258 also records that later parts of SceneEditor were not covered.

These numbers say "no unit was left entirely without a turn", and do not mean:

- all source parts have been reviewed;
- all matching tests entered the model context;
- every obligation has been answered;
- all 43 units received a complete, verifiable coverage conclusion.

This round obtained the latest artifact file reference, and the upload log also confirmed the artifact exists; but the terminal could not resolve the download host DNS, so audit-inventory, usage, and the raw pack inside the ZIP could not be read. So the 30/13, call counts, and cost here are **the maintainer's actual experiment records**, with the fields independently confirmable from logs listed separately, not mixed into the same evidence level. [#258 review](https://github.com/Mira190/SpecGuard/pull/258#pullrequestreview-5556216391).

### 2.4 Benefit of lowering the pack from 250000 to 150000

The maintainer recorded that the same batch of seeded scans changed from 7 calls / $0.42 to 10 calls / $0.09. More small calls may still be cheaper, which is worth further experiments, rather than defaulting to "a large pack saves calls and so saves cost".

This round also used GitHub compare to check the two Kite HEADs: only .github/workflows/specguard-audit.yml changed, with no application code change. This eliminates the confound of target application code changing; the Action ref, packing implementation, and effective configuration still need to be pinned, and two single runs are not enough to prove a general cost rule.

The next step suggested is to record, for each call, the actual input/output/cache tokens, the worst-case reserve, the unit-part count, the evidence retention rate, and the detection result. Keep the hard budget, and do not replace the worst-case ceiling with an average spend. [#258 usage note](https://github.com/Mira190/SpecGuard/pull/258#discussion_r4301394677), [Kite HEAD comparison](https://github.com/Mira190/Kite/compare/11e80a98139ac83af59d9d013a85d1db31b591b6...b90f22c7906e2197afb1d7935b1622e439142d97).

## 3. Contribution of the new PRs to the goal

| PR | Improvement completed | This round's judgment |
|---|---|---|
| #251 | hunk-tier candidates continue to be used for retrieval, excluded from the literal cover guard; added direct parser assertions; fixed a circular dependency | Merged, closing that item's to-be-merged status from the previous round |
| #252 | Allow non-default branches when scan state is not read or written | The seeded scan has run in Kite's own workflow; does not mean the cross-repo manual token path is also fixed |
| #253 | Unified weak-assertion classification; added static facts such as truthiness and unreferenced export | Valuable, but must be metered separately from confirmed gaps |
| #255 | stateless plans by multiple parts, prioritizing the first segment of each unit; budget hints | Right direction; after unit tests and offline passes, real runs still exposed budget inconsistency |
| #256 | The collector re-plans using the engine pre-flight; budget drops recorded per part; internal red | Fixes the real coverage degradation; records of failed parts are not yet fully unified |
| #258 | collector and engine share packLimit, and the new input reaches both ends | Fixes diverging again on override; 0 and invalid values still need a visibility contract |
| #254/#257 | Updated target assessment and seeded results | Improves transparency, but some existing conclusions and to-dos were not updated with the final implementation |

The important lesson of #255→#256→#258 is not "more abstraction is needed", but that the planner, the executor, and the report must consume the same actual plan and execution result. Currently "which parts were reviewed" is still rebuilt at different layers, and the new problems N1–N3 come from there.

## 4. Newly confirmed problems this round

The following are real-module counterexamples at the pinned 2fb6f91, and it is not claimed that every boundary occurred in the latest Kite run. Priority is ordered by impact on shift-left trustworthiness and expected scale.

### N1 · P1: later parts not selected by the collector did not make the status incomplete

**What it did.** inventory has recorded parts_left and a limitation; render also writes "part 2 not reached".

**Problem.** The final incomplete decision includes the engine's droppedParts but does not include the collector's parts_left. So the same report can state "the second segment was not reviewed" while outputting status=complete.

**Reproduction.** A single unit, two segments; the first succeeded, and the second was not selected because of the collection budget. No other interfering factors. Actual output:

- status: complete;
- Reviewed in parts: part 1 of 2;
- part 2 not reached (budget).

This is a contradiction between the status contract and a known coverage loss, and does not demand that a coverage-gap alert must make CI fail.

**Minimal fix.** Include the "collector's deferred parts" in the structured completeness decision, keeping the reason budget / max_units. Define whether complete means the selected scope of this round is done or the target scan scope is done; the engine's droppedParts already count as incomplete, and the same standard should apply to collector omissions.

**Acceptance.** The completeness result is the same when the collector drops a later part and when the engine drops the same part; the control where all parts succeed is still complete. A single scan segment rotated by design in stateful mode should have its scope stated separately, to avoid forcing it to be incomplete forever.

Code: [audit-units.js:242](https://github.com/Mira190/SpecGuard/blob/2fb6f911b262a239bc8e21d84b7ff92a6bbfa8b7/src/audit-units.js#L242), [audit-post.js:878](https://github.com/Mira190/SpecGuard/blob/2fb6f911b262a239bc8e21d84b7ff92a6bbfa8b7/src/audit-post.js#L878).

### N5 · P1: beyond the first 100 inventory rows, the static clues of selected units disappear

**What it did.** To limit the size of the inventory display, write keeps only the first 100 rows by risk ranking; the publisher of the new static facts takes leads from these rows and then filters for the units selected this run.

**Problem.** Once rotation selects a unit outside the first 100, its source code may already have been reviewed and its static signals already computed, yet it is not in the persisted rows. The publisher's corresponding leads become empty, without disclosing that this is inventory serialization truncation.

**Reproduction.** 101 units, each with one unreferenced export fact; this round selected the 101st. Before serialization that unit has 1 lead; the written inventory has only 100 rows; after the publisher's filtering the usable lead=0.

It does not trigger on Kite's 43 units; it crosses the threshold only in repositories with thousands of units or with stateful rotation. It directly limits the scalability of "static facts as the whole-repo mainstay".

**Minimal fix.** Persist the facts of the units selected this run separately, or guarantee that selected rows are not subject to the "first 100 rows display" limit. The display can be trimmed, but the detection input must not be lost with it. Continue reporting the searched/available/delivered counts at the fact layer.

**Acceptance.** For 101+ units, selecting the 101st and later units, the lead is kept in the publisher; also verify deduplication of repeated test leads within the window and the report size limit.

Code: [audit-units.js:271](https://github.com/Mira190/SpecGuard/blob/2fb6f911b262a239bc8e21d84b7ff92a6bbfa8b7/src/audit-units.js#L271), [audit-post.js:525](https://github.com/Mira190/SpecGuard/blob/2fb6f911b262a239bc8e21d84b7ff92a6bbfa8b7/src/audit-post.js#L525).

### N4 · P1: context_pack_bytes=0 can yield complete without any source code

**What it did.** The newly public input explicitly allows 0, meaning no repository files are attached; the shared packLimit makes both ends read the same value.

**Problem.** The API single-call path skips the pack when packBytes=0, and does not write pack-cut for the omitted files either. The publisher cannot distinguish "no truncation" from "no source code was sent at all", and can output complete normally.

**Reproduction.** Real api.run + audit publisher, with the provider returning valid empty-findings JSON; checking that the request indeed does not contain the fixture's key source identifiers; engine_status=success, pack-cut absent, status=complete. Both the provider and GitHub are local mocks, and no request was actually sent.

**Minimal fix.** If 0 remains legal, record pack disabled, and mark obligations that depend on the missing source as unknown; or explicitly reject 0 on API review paths that need source. Do not assume the input semantics are consistent merely because the two parsers' values agree. Non-numeric configuration may also currently fall to 0, and it is suggested to report a configuration error explicitly.

**Acceptance.** Verify 0, the empty-string default, a legal small pack, and an illegal string separately; forbid deriving a complete review from "empty JSON without attached source". Other engines that read code must judge by the tool-reading evidence of their own, and not apply the API-mode conclusion.

Code: [pack-cap.js](https://github.com/Mira190/SpecGuard/blob/2fb6f911b262a239bc8e21d84b7ff92a6bbfa8b7/src/pack-cap.js), [claude-api.js:483](https://github.com/Mira190/SpecGuard/blob/2fb6f911b262a239bc8e21d84b7ff92a6bbfa8b7/src/engines/claude-api.js#L483).

### N2 · P2: parts dropped by the budget are also listed as reviewed parts

**What it did.** #256 outputs droppedParts separately and makes the status incomplete. This part of the fix works.

**Problem.** readUnits merges the original planned rows; Reviewed in parts uses this merged list directly, without subtracting the parts dropped by the executor.

**Reproduction.** Plan parts 1 and 2, with the budget dropping part 2. The same actual summary first shows "parts 1, 2 of 2 reviewed", then shows "part 2 not reached".

**Minimal fix.** Reviewed in parts should come from the succeeded part keys, with the planned total and the unexecuted list shown separately. Do not use the max/min line numbers of the source window to merge results in place of the real visible range.

**Acceptance.** None of the combinations of non-contiguous successful parts, budget-dropped, not started, and failed should appear in the reviewed list. This problem is currently a conflict in the coverage description, not the global status staying green.

Code: [audit-post.js:62](https://github.com/Mira190/SpecGuard/blob/2fb6f911b262a239bc8e21d84b7ff92a6bbfa8b7/src/audit-post.js#L62), [audit-post.js:616](https://github.com/Mira190/SpecGuard/blob/2fb6f911b262a239bc8e21d84b7ff92a6bbfa8b7/src/audit-post.js#L616).

### N3 · P2: failures are still recorded only by unit ID, and the coverage attribution of successful segments is lost

**What it did.** The engine uses id:part for budget drops, but for a failed call writes only units, not part keys.

**Problem.** As soon as the publisher sees a unit in failed, it puts that whole unit into notSeen. With multi-segment scans newly added, a later segment's failure swallows the coverage fact that "the earlier segment was reviewed successfully".

**Reproduction.** The same unit with two segments, the second failed and the first has a successful result: the summary becomes "could not review any unit" and "1 unit were not reviewed"; the funnel also counts it as did not fit, confusing run failure with insufficient capacity.

This round did not prove that all successful findings are thereby deleted; the source still keeps some validated findings. What is confirmed is that the attribution granularity of execution and coverage is insufficient.

**Minimal fix.** failed, like dropped, carries part keys; the execution ledger lists succeeded / failed / not_started / dropped, and the unit layer aggregates reached_any, source_complete, tests_complete from the ledger. A conservative fallback for compatibility with old artifacts that lack part keys.

**Acceptance.** When the first segment of a unit succeeds and the second times out, it should display "partly succeeded, partly failed", not claim it was not reached at all; nor should it claim that unit as fully covered.

Code: [claude-api.js:435](https://github.com/Mira190/SpecGuard/blob/2fb6f911b262a239bc8e21d84b7ff92a6bbfa8b7/src/engines/claude-api.js#L435), [audit-post.js:838](https://github.com/Mira190/SpecGuard/blob/2fb6f911b262a239bc8e21d84b7ff92a6bbfa8b7/src/audit-post.js#L838).

### N6 · P2: the run log writes the part count as the unit count

Real logs show 58 of 43 units and 71 of 43 units. The main function returns units.picked as the unit ID of each selected part, stdout uses picked.length; the denominator total is the independent unit count, so the counting units differ.

Minimal fix: display unique units reached / inventory units, and separately display selected parts. The existing inventory.rotation.picked is based on a deduplicated set and can be reused. Do not mask part duplication by widening the denominator.

No separate test was written for this problem to mirror the string; the real logs and the direct-call path already constitute sufficient evidence. [audit-collect.js:378](https://github.com/Mira190/SpecGuard/blob/2fb6f911b262a239bc8e21d84b7ff92a6bbfa8b7/src/audit-collect.js#L378).

## 5. Whether the old findings are resolved

| Previous item | Latest status | Evidence |
|---|---|---|
| hunk candidates caused the cover guard to wrongly downgrade gaps | #251 merged | No longer listed as to fix; the circular dependency also has a fix |
| stateless non-default branch rejected | #252 merged, Kite's own workflow has run | The cross-repo manual permission precondition continues to be listed separately |
| summary disappears from the label pool after resolution | Still exists | Reproduced on the latest SHA: A=1, but the blind pool goes from 1 to 0, old label unmatched |
| summary→inline label ID changes | Still exists | Reproduced on the latest SHA: F9a5e30c2e → F420a685ac |
| changed-hunk diff timeout swallowed silently | The related collect.sh unchanged | The previous round's counterexample still applies; this round did not re-inject a timeout |
| delivered precision missing, old error denominator unknown | eval/grade.js unchanged | The #258 scan budget fix must not be described as having also fixed the evaluation definitions |
| retrieval failure and configuration identity disclosure insufficient | trace-recall related implementation unchanged | Still to do later; this round focused on the new scan execution chain |

The latest goal-assessment still says "definitions are ready" and "all that is lacking is samples". The reproduction of F1/F2 shows that this sentence needs narrowing: before samples grow, one must also guarantee that resolved findings and channel conversions do not make labels lose their link.

## 6. Quality of actual PR reviews: which kind of false positive to optimize

The #256 bot marked two deleted assertions of audit-post.test.js as "Assertion removed with no replacement". The maintainer explicitly judged this a false positive; this round checked the diff, and the old cap-of-10 assertion was indeed replaced by a new full-visibility assertion:

- previously it checked that of 12 signals only 10 were visible and 2 were in Details;
- the new version checks that all 12 are visible, and confirms that More static signals no longer exists;
- a lead cap=20 regression was also added.

This PR changes the output contract, so the old assertion becoming invalid is a reasonable change. Two independent gaps should not be produced merely from "some assert line was deleted"; one should first check whether the new assertion covers the corresponding new obligation. Two deletions on the same topic should also be merged.

Minimal optimization: attach to the removed-assertion lead the original contract, the new contract, and candidate replacement assertions; form an actionable gap only when replacement evidence cannot be verified. Keep the positive examples of really weakened assertions and the negative examples of "contract changed and a replacement assertion added", and do not suppress deletion detection across the board. [#256 actual summary](https://github.com/Mira190/SpecGuard/pull/256#issuecomment-6229335004), [#256 human review](https://github.com/Mira190/SpecGuard/pull/256#pullrequestreview-5556083187).

#258 also produced a low-confidence standard: the packLimit test is not in pack-cap.test.js. The current rules do write a same-name test file convention, so one cannot simply declare the bot wrong. But compared with the direct comparison test of unitCalls placed in claude-api.test.js, its marginal target value is very low. It is suggested to display and measure "behavior unverified" and "file placement convention" separately, to avoid convention opinions crowding out real QA gaps. [#258 actual summary](https://github.com/Mira190/SpecGuard/pull/258#issuecomment-6229607959).

The summaries of multiple latest PRs still report large test file truncation and obligation unknown. "CI has tests", "the repository has tests", and "this run's model saw and verified the tests" are three different facts; unknown should continue to be kept, rather than automatically judged covered to reduce warnings.

## 7. How to correctly interpret the new seeded results

The current goal-assessment records:

| Experiment path | Repository record | Interpretation to adopt this round |
|---|---|---|
| Early haiku | 0/8 | Model recall under early specific coverage and configuration |
| normal tier | 2/8, about $1.91 | Result of a stronger model in that run; not a general upper bound |
| #253 static signals | 6/8 for the seed locations | Lead-location recall on known gaps |
| Later default configuration | Model 3/8, static 6/8, total 6/8 | The model improved, but its incremental unique detections on these seeds are not yet apparent |
| Boundary seeds | Two still undetected | Whether the evidence was delivered completely and the semantic reasoning ability need to be diagnosed separately |

[Goal assessment file](https://github.com/Mira190/SpecGuard/blob/2fb6f911b262a239bc8e21d84b7ff92a6bbfa8b7/docs/goal-assessment-2026-10-17.md).

"Only asserts truthiness" and "no test file mentions an export name" can be accurate facts, but an accurate fact does not mean the product opinion is correct:

- a test may cover a function indirectly via an alias or a public entry point;
- truthiness may be exactly the legal contract;
- a UI export without a unit test should not necessarily be changed to a unit test;
- failing to find a function name is a different strength of conclusion from confirming there is no test.

So at least three layers should be reported: fact precision, human-confirmed gap precision, and author-actionable finding precision. The 9 facts sampled against master were all true, and should not be rewritten as product precision=100%.

The static detection's "$0" should be interpreted as incremental cost requiring no extra model call, and one cannot say the whole Action spend including the model scan is zero. Currently the same run still spends $0.09 or $0.42; the standalone static mode cannot yet derive a verified full experience from these run numbers.

"The model is almost useless without a diff" should also be limited to the experimental result of the current Kite seeds and configuration; the model going from the early 0/8 to the later 3/8 already shows that results change with input scope and planning. First prove the evidence arrived, and only then attribute the remaining FN to model capability.

## 8. Minimal route for the next round, aimed at the goal

### 8.1 Unify the execution ledger first

Reuse the existing scan-parts.json, without first building a new platform. The following minimal fields are suggested:

| Field | Purpose |
|---|---|
| target_sha, action_sha, effective_config_hash | Pin the code reviewed, the tool implementation, and the configuration |
| unit_id, part_key, planned_source_spans | State clearly which segment is planned for review |
| execution_state | selected / succeeded / failed / dropped / not_started |
| source_spans_shown, test_blocks_shown | What was actually sent, not just the file names |
| selected_units, reached_any_units, source_complete_units, tests_complete_units | Prevent mixing unit and part counts |
| static_facts_computed, persisted, delivered | Reveal serialization loss such as N5 |
| failure_stage, reason, reserved_usd, actual_usd | Align coverage, failure, and budget |

The publisher consumes the ledger directly; do not again subtract a partial dropped list from planned rows and guess the execution result. The part's own range, test range, and failure result can reuse existing objects, and there is no need to add a complex hierarchy for each piece of data.

### 8.2 Fix and acceptance order

| Order | Work | Minimal acceptance |
|---|---|---|
| 1 | N1 / N4 completeness contract | A known unreviewed part or a disabled pack cannot produce an unreserved complete conclusion |
| 2 | N5 static fact persistence | 101+ units, a unit outside the first 100 selected, the clue can still be delivered |
| 3 | N2 / N3 part execution ledger | dropped / failed parts do not enter the reviewed set; a successful part does not disappear because of other failures of the same unit |
| 4 | N6 log metering | numerator and denominator are both unique units, part count listed separately |
| 5 | F1 / F2 cohort identity | export→fix→rerun→promote→import, labels can still be aligned |
| 6 | removed-assertion negative example | When the output contract changes and a replacement assertion is added, it is not misreported as weakened tests |
| 7 | Fixed hold-out re-test | At least one repository beyond JS/TS, covering long files, multiple entry points, cross-file delegation |

### 8.3 A constrained experiment on the boundary seeds

Do not immediately write "the constant appears on one side in the test" as a confirmed gap: the test may cover the boundary through parameterization, fixtures, or a wrapper. First treat it as a lead, annotating the predicate under test, the threshold, the related test blocks, and the dynamic sources that cannot be determined.

For each FN first record: is the ground truth reliable → did the key source segment arrive → did the related test arrive → did the model raise it → did validation retain it → was it delivered. Only then choose to strengthen retrieval, packing, the model, or gating. This is optimizing around the actual loss, rather than hard-coding new rules for 8 seeds.

### 8.4 Keep the budget ceiling, calibrate planning efficiency

After recording the actual usage of multiple packs, models, and file structures, then optimize the conservative reserve. First distinguish:

- parts not selected because of the worst-case reserve;
- budget actually remaining after execution but not further used;
- losses caused by timeouts, output length, and validation failures;
- evidence missing and duplicated context caused by a smaller pack.

The optimization goal is complete valid findings under a fixed cost, not that fewer calls is better, nor that spend closer to the budget is better.

## 9. Evaluation documents that should be updated

The latest goal-assessment has several places that are outdated or whose definitions are too broad:

1. "hunk candidate fix in progress" should be updated to #251 merged.
2. "context_pack_bytes inconsistent between both ends needs unifying" has been resolved by #258; the new to-dos are N4 input semantics and consistency of N1–N3 execution results.
3. "Another two seeds are in the second segment and a single stateless run can never read them" should note that this belongs to the old implementation; #255 already plans multiple segments, and the remaining limits should concretely state the actual deferred/failed parts.
4. The haiku 0/8 at the top and the default-model 3/8 later should be separated by run version, so readers do not think the same condition contradicts itself.
5. "Coverage and cost achieved" is suggested to be changed to "reach and budget control have empirical support, complete evidence coverage is still limited".
6. "All that is lacking is samples" should add the remaining implementation problems of the label lifecycle and execution-coverage contract.

All these changes can reuse existing experiment data, with no need to run another paid scan for the documents.

## 10. Reproduction and evidence attachments

Run the 5 new scenarios of this round:

    node docs/review-probes/scan-budget-followup-2026-10-17/probe.cjs

Re-check the old F1/F2:

    node docs/review-probes/scan-budget-followup-2026-10-17/previous-findings.cjs

The probes load modules from the fixed Git tree and record source hashes. They use local temp files and controlled Git return values; they do not modify .git, do not execute the reviewed repository's code, and do not actually call the provider or GitHub. Temp directories are cleaned up within verified absolute-path boundaries. Module-level counterexamples do not replace full product tests or real-model experiments.

Attachments:

- [This round's new scenario results](C:/Files/Projects/SpecGuard/docs/scan-budget-followup-probe-results-2026-10-17.json)
- [Latest F1/F2 re-check](C:/Files/Projects/SpecGuard/docs/scan-budget-followup-previous-findings-2026-10-17.json)
- [PR, Actions, and log evidence](C:/Files/Projects/SpecGuard/docs/scan-budget-followup-evidence-2026-10-17.json)
- [Version switch and Kite comparison snapshot](C:/Files/Projects/SpecGuard/docs/scan-budget-followup-snapshot-2026-10-17.json)
- [New scenario script](C:/Files/Projects/SpecGuard/docs/review-probes/scan-budget-followup-2026-10-17/probe.cjs)
- [Pinned-version module loader](C:/Files/Projects/SpecGuard/docs/review-probes/scan-budget-followup-2026-10-17/loader.cjs)

Not yet verified: the raw contents of the Kite artifact ZIP, independent per-seed re-labelling, human author adoption, real FN on ordinary no-alert PRs, the latest real Copilot path, the cross-repo private manual entry. This document keeps limitations on these items, and has not used a green job or the maintainer's descriptions to replace all the empirical evidence.

