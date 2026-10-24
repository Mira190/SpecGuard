# One review, batched execution, one GitHub Actions Summary: research and implementation plan

Date: 2026-10-17 (Australia/Sydney). Code baseline: local `7c131b5f6ad78d46279ca038518b2818fc757f1f`; it is not claimed to be the latest remote version.

For this work the main agent plus two workers separately researched the PR pipeline, scan batching, and aggregation, and then cross-checked. The scope of work is research and planning; no runtime code was modified, no Actions were triggered, and no paid models were called.

## 1. Conclusion and goals

**It is feasible. We recommend keeping one review job in a single workflow run, batching inside the job with limited concurrency, and having one publisher write one Summary at the end.** For the user it is still one review of the same code snapshot; the number of workers and model calls are execution details.

The current scan + Claude API already has the main path of "multiple calls → aggregation → one Summary". Scope, part, evidence-visibility, and status need to be recorded uniformly first, and only then concurrency added. The PR path needs chunking moved ahead of diff truncation.

Suggested acceptance goals:

1. One review pins the repository, PR/ref, head, policy base, diff base, requirement version, and effective configuration.
2. All targets enter the manifest first; batching must not make unselected, unexecuted, or failed scope disappear.
3. Workers only produce structured results; after unified validation, merging, and deduplication, the Summary is published only once.
4. Partial failure still keeps the valid findings of successful batches, and clearly marks incomplete.
5. The budget and deadline belong to the whole review, and must not turn into each worker getting its own budget.
6. "All complete" means the necessary review tasks within the declared scope are complete; it must not be interpreted as proving the code has no defects or exhausting all behaviors.

## 2. Evidence from the current implementation

All paths and line numbers below are based on the local code baseline.

| Stage | Current implementation | Impact on the plan |
|---|---|---|
| Action entry | `action.yml:184–242` selects one engine, generates the prompt, and calls the adapter once | Batched execution can be added internally, keeping the Action's external invocation |
| scan planner | `src/scan-parts.js:13` `plan()` generates unit parts and document block batches, reusing the existing prompt builder | Should be reused, to avoid writing another prompt system |
| scan executor | `src/engines/claude-api.js:425–479` allocates budget, calls batch by batch, handles partial failure, and merges answers and usage | Multi-call capability already exists; `await call()` inside the `while` is currently strictly serial |
| scan scope selection | `src/audit-collect.js:374–376`, `src/engines/claude-api.js:38–39`; by default 12 units per call, at most 80 document blocks per run by default, and at most 8 unit calls | A run currently cannot promise to scan the whole repository; 8 is the cap on unit calls, not the cap on the total number of API calls in a run |
| Large-unit sharding | `src/audit-units.js:109,242–270` already has `id:part`, `parts_left`, unit rooms | The sharding identity has a basis, but not every later layer keeps part granularity |
| scan completeness | `src/audit-post.js:834–889` consumes information such as failures, budget not executed, and unanswered | The `incomplete` expression does not directly consume the collector's `inv.parts_left`; looking only at the engine's droppedParts is not enough to prove all parts are complete |
| scan failure identity | `src/scan-parts.js` keeps both `units` and `keys`; the engine's failure records mainly write `units`, and post uses unit IDs to judge unseen | When one unit has multiple parts, a stable part ID is needed to record success and failure, so the per-part differences are not lost after merging |
| PR diff | `src/collect.sh:232–263` trims `diff.patch` by default when it exceeds 300 KiB | Dispatching workers after this point can no longer recover the trimmed scope from that file |
| PR focus | `src/focus.js:133–190`; by default beyond 600 lines or 25 files, pick the 12 highest-risk files | In full-scope mode, risk should serve as execution order, and the remaining files must no longer be moved out of the review |
| PR test candidates | `src/collect.sh:276–318` has limits such as the first 60 source files, 16 KiB total, and 5 candidates per file | Applicable candidates must be generated for every chunk, and the limits of candidate retrieval recorded |
| Prompt/context | `src/prompt.js:9`: diff 40 KiB, requirements 8 KiB, criteria 6 KiB; `src/pack-cap.js`: default pack 250000 bytes, 48 KiB per file | Chunking should be planned by the actual combined size of source, tests, rules, and requirements, not just by file count |
| PR result contract | `src/post.js:245,274,296–333` requires unique obligation IDs, valid requirement references, and finding consistent with coverage status | JSON arrays from multiple workers cannot be concatenated directly |
| PR evidence visibility | `src/post.js:1552–1570` and elsewhere consume the path-granularity `pack-cut.txt` | In the multi-worker case, evidence visibility must first be validated by result source |
| Single publishing point | `action.yml:243–271,283–307`, `src/post.js:1476`, `src/audit-post.js:789` | A unified publisher already exists and can be kept |
| Summary copy | `src/tee-summary.js` saves `.specguard-ctx/summary.md` | The final report and the downloadable copy can be generated from the same rendered content |
| Display limits | PR `src/post.js:14,727,937–959` shares a comment budget of about 65000 characters; scan `src/audit-post.js:31,678–719` has 1000000 bytes and per-table row limits | One Summary already exists, but that does not mean all results are shown in full |
| Final job status | `src/fail-on-error.js`: configuration-class failures force a red light; ordinary incomplete is only a warning | `fail_on_error: true` currently does not automatically turn incomplete into a failure either; the compatibility semantics must be made explicit during implementation |

Inventory discovery must also be distinguished from execution scope: `src/audit-units.js:14` has limits such as the number of source/test files, file size, and retrieval time. Even if all discovered units are executed in batches, omissions in the inventory itself cannot be hidden.

## 3. What the GitHub platform allows, and its limits

GitHub's `GITHUB_STEP_SUMMARY` is a separate file for each step; the contents of the steps in the same job are attached to that job's Summary after the job completes. Multiple jobs writing a Summary appear as multiple job reports, and they cannot be merged automatically by sharing an environment variable. The content of a step that has finished cannot be modified by later steps. Therefore workers should write JSON, and the last publishing step should write the Markdown uniformly. [GitHub job summary documentation](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-commands#adding-a-job-summary).

The platform limits each step's Summary to **1 MiB**, and each job displays at most 20 step summaries; a failed upload from exceeding the limit does not necessarily fail the job. Therefore "put all raw details at any scale into one Summary" cannot be guaranteed unconditionally. Space needs to be computed in UTF-8 bytes, and report display truncation recorded separately from the review scope being incomplete. [GitHub Summary limits](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-commands#step-isolation-and-limits).

If cross-runner execution is needed later, GitHub supports a job defining a matrix, worker jobs producing different artifacts, and a downstream job collecting them. A matrix is fail-fast by default; to keep other workers when one fails partially, turn it off and limit max-parallel. [GitHub matrix documentation](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/run-job-variations).

The same-named output of a matrix reusable workflow cannot be used as a result array: which output is selected depends on the last call that completed successfully and set that value. Across jobs, results should be collected as structured artifacts with stable names, and then checked against the full manifest. [GitHub reusable workflow outputs](https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows#using-outputs-from-a-reusable-workflow).

The platform constraints above support the design of "parallel inside, one publisher"; they do not require using a matrix in the first version.

## 4. Recommended architecture

```text
One review / one pinned snapshot / one review job
  │
  ├─ collect + inventory: keep the full targets and the collection limits
  ├─ plan: assign each chunk a primary scope and shared evidence
  │
  ├─ queue ── worker 1 ── independent result, usage, visibility
  │         ├ worker 2 ── independent result, usage, visibility
  │         └ worker 3 ── independent result, usage, visibility
  │                       (serial by default first, then a low-concurrency trial run)
  │
  ├─ validate + merge: check ownership, references, IDs, conflicts, coverage, cost
  ├─ when needed, re-review targeted cross-chunk relations or evidence conflicts, then return to validate
  └─ one publisher → one GitHub Actions Summary
                     + a same-content summary.md + the full structured results
```

A chunk is a task, and a worker is an execution slot that consumes the queue: for example, 30 chunks can be handled by 3 workers. Do not implement "dispatch three workers" as merely producing three huge contexts.

| Option | When it applies | Recommendation for now |
|---|---|---|
| One job, serial chunks | First solve scope truncation and the correctness of validation and merging | Adopt in the first phase |
| One job, limited-concurrency worker pool | Reduce model waiting time, with unified budget and publishing | Recommended target shape |
| Multiple matrix jobs + aggregate job | Single-runner time or resources have become a measured bottleneck | Deferred; it adds snapshot distribution, artifacts, security, and cross-job budget coordination |
| The model decides by itself to dispatch agents and explore freely | Experiments that need extra exploration capability | Not the default execution protocol for now; hard to prove coverage with a manifest and to bound total cost |

The first version prioritizes the Claude API, which already has batching, usage, and cost pre-checks. Copilot / Claude agent keep their existing paths; when they are later connected to the same task manifest, independent sessions, installation reuse, and soft-budget semantics will be handled then. The CLI soft limit must not be described as a hard budget for the whole review just because workers were added.

## 5. Scope and chunking rules

**scan:** The targets are the source units, unit parts, and requirement blocks within the current snapshot selected by the user's path configuration. In full-scope execution, do not carry over the logic of "select only this round's 80 blocks and take the next on the following run". `max_units` continues to mean per-call capacity, and `scan_batch_blocks` means per-call document batch size; the historical rotation serves only incremental/selected mode.

**PR:** The targets are the hunks in the complete reviewable diff, the related test changes, the requirement criteria, and the necessary cross-file relations. Keep the complete diff, build the manifest first, and then chunk; in the new mode `max_diff_kb` serves as the per-chunk size bound rather than the drop boundary of the whole review. The old mode keeps its original semantics, and the input description must clearly distinguish the two.

Each chunk uses "the source where the behavior lives + candidate tests + related requirements + applicable rules". Files that are directly coupled and both changed should go in the same chunk as far as possible; very large files are split by complete hunk, function, or relevant window, keeping the global file path and the original LEFT/RIGHT line numbers. Pure byte-equal splitting breaks diffs and references and should be avoided.

Each task scope has one and only one primary owner. Direct dependencies, callers, shared tests, rules, and requirements may enter multiple chunks as evidence, but appearing repeatedly does not mean two reviews were completed.

Explicit tasks are arranged for cross-chunk relations: a caller and callee both changing, shared configuration contracts, multi-file implementations of one requirement, cross-file test migration, and so on. Build a bounded relation list first from existing imports, test map, trace, and leads; it must not be claimed to be a complete call graph. When a necessary cross-chunk task is not completed, it likewise enters the incomplete list.

A full-scope review cannot be achieved by turning off `focus_threshold`, raising `max_units`, or enlarging the prompt limit; that merely moves the omission to the next layer.

## 6. One plan and execution ledger

We suggest first adding a small `review-manifest.json`, keeping compatible consumption of the existing `audit-inventory.json` and `scan-parts.json`. The planner, executor, and publisher consume the same scope/part identities, avoiding each layer recomputing "who has been reviewed". There is no need to build a general task platform for this.

| Level | Minimum record |
|---|---|
| snapshot | repository, PR/ref, head, policy base, diff base, requirement/linked issue version, effective configuration hash, SpecGuard build, planner version |
| inventory | declared targets, discovered targets, explicit exclusions, scope that could not be enumerated/read and the reasons |
| chunk | stable chunk ID, owned unit-part/hunk/block IDs, shared evidence references, prompt/pack hash, estimated cost |
| attempt | chunk ID, attempt ID, start/end, API request ID (when available), status, actual model, usage, whether the cost is known |
| visibility | files and line ranges actually sent into that call, full/partial evidence, evidence not sent and the reasons |
| result | raw result location, validation result, normalized IDs, finding provenance, unanswered tasks |

The chunk ID is generated from the snapshot and the content of the owned scope, not from the worker number or completion order. After a parent chunk is bisected, the child chunks replace the parent's target assignment; the parent and children must not both be counted in the denominator.

Task state distinguishes at least: pending, in progress, answered successfully, unanswered/invalid result, failed, budget not started, timed out not started. Evidence completeness is another dimension: a successful request does not mean the context is complete, much less that the conclusion is covered.

Suggested overall status:

- `complete`: all necessary tasks within the declared scope are validated, and important evidence gaps, collection omissions, and unexecuted items are all zero; findings may be non-zero.
- `incomplete`: usable results exist, but there are failures, unexecuted items, unanswered items, materially incomplete evidence, or an inventory that cannot be closed. Findings from the successful scope continue to be published.
- `failed`: there is no usable review result, or a key stage such as identity validation/collection/aggregation/publishing failed. If only reliable deterministic results exist, the report must clearly state their source as distinct from model results.

The Summary shows both whether the scope is complete and whether the conclusion has gaps; "no finding", "all files touched", "selected scope complete", and "whole repository complete" must not be mixed into one thing.

For example: all 43 units were touched, but only 70/74 parts were answered and the test evidence of 13 units is incomplete; this should show incomplete, and must not be written as "43/43, all reviewed".

## 7. Worker scheduling, budget, and failure handling

Fix the queue and the serial behavior first, then trial with 2 workers; evaluate 3–4 only after there is data on quality, rate limiting, and cost. The first version does no adaptive scaling.

Before sending each request, the coordinator checks:

```text
confirmed spend + cost upper bound still held for requests with unknown outcome
           + reservations for all in-flight requests + reservation for this request/re-review
    <= the budget of the whole review
```

Reservation and enqueueing must be done by the same coordinator. It must not happen that several workers each read the remaining budget and then simultaneously decide "we can still spend". Settlement happens only once the true usage is known; a call that timed out or whose network dropped and that may already have been billed cannot be treated as zero spend and have its reservation released.

Keep the existing worst-case pre-check, but separately audit each request of retries, schema fallback, overflow splitting, and re-answering of omissions. The price table, token upper bounds, caching strategy, and billing assumptions must be traceable; when the model price or consumption is unknown, an estimate cannot be described as an absolute guarantee about the provider's bill.

The deadline belongs to the entire review. Stopping dispatch must come earlier than the job timeout, leaving a measured safety margin for collecting results, validating, rendering, and uploading. Each request has its own remaining-time limit, 429/5xx use bounded backoff; account/permission/model configuration errors should stop further dispatch.

Workers write to their own chunk/attempt paths, committing results atomically on completion. Competing writes to the shared `findings.json`, `usage.json`, `engine-status`, `scan-parts.json`, or the Summary are forbidden. The aggregator handles files a worker did not write, abnormal exits, and corrupted output.

After a partial failure, complete the still-executable independent tasks as far as possible; once a configuration error is confirmed, stop making new calls. The scan issue is updated once at the end by the publisher, and failed parts do not advance review progress. **Two workers, retries, or duplicate findings in the same run do not count as two cross-run confirmations.**

Cancellation and forced runner termination are platform boundaries: keep the existing constraint that superseded/cancelled runs do not publish stale results to the PR. A normal timeout can reserve a publishing window; when the whole runner is killed or the workflow is cancelled, there is no guarantee that a final Summary still exists.

## 8. Correctness requirements for aggregation

1. **Validate by source first, then merge.** Each result may only judge its owned scope; it may cite approved shared evidence. File paths must be inside the snapshot, line numbers and quotes must match the corresponding commit, and rule sources continue to trust the policy base.
2. **Rewrite local IDs and all references.** `O1` becomes something like `chunkA:O1`, and the `obligation_ids` of findings/requirements are rewritten in step. The `R/S/H/D` IDs assigned by the collector remain global, and the valid reference sets of the same criterion are merged; requirement IDs discovered by the model itself are namespaced again.
3. **Visibility is kept with the conclusion.** If A did not see some test in full and B did, the `pack-cut.txt` of the two workers cannot simply be unioned. Validate each conclusion first, keep provenance after merging; B's complete context also cannot fill in out of thin air for A's unrelated conclusions.
4. **Coverage merging is conservative and traceable.** When one requirement corresponds to multiple obligations, one row being covered cannot override the verified gap or unknown of other rows. Contradictory evidence goes to a targeted re-review or needs_human; it cannot be settled by model majority vote or higher confidence.
5. **Deduplication and conflicts are handled separately.** Duplicate findings are merged by kind, behavior/location, quote, and requirement source, keeping the set of sources; independent problems with different obligations, different LEFT/RIGHT, or the same location must not be deleted by mistake. The existing publication fingerprint can be reused, but is not enough to carry all semantic conflict handling.
6. **Merge in planned order.** Results are unaffected by worker completion order. The final ordering, counts, and status should be stable; dynamic elapsed time and request IDs may differ.
7. **Apply global limits last.** Inline comments, comment count per file, and displayed row counts are applied only once, after all results are aggregated. Workers do not publish PR comments or reviews.
8. **Completion markers and clearing of old threads depend on global completion.** An incomplete review does not write a complete HEAD marker, does not treat old findings that were not reviewed as resolved, and does not perform stale-thread resolution that presupposes a complete review.
9. **Full identity validation.** Files with different heads, diff bases, requirement versions, or effective configurations must not be mixed. Check the live head again before publishing a PR; changes in review configuration are synced into the CFG of preflight/post.

The end still produces aggregated results and usage that the existing publisher can consume. PR support for worker-local validation and visibility needs targeted changes; one cannot just produce one big `findings.json` and assume all the original single-call validation applies.

## 9. Content of the final Summary

The user first sees the conclusion and the findings they can act on, and the batch details go in the Details of the same report. The following is a suggested sketch; the numbers are just display examples:

```text
SpecGuard review · repo@head
Incomplete: 7 gaps found, and another 4 tasks not completed.

Scope: 43 units; full evidence 30, evidence partly visible 13.
Execution: 70/74 parts validly answered; 2 failed, 2 budget-not-started.
Requirements: X/Y blocks answered; unknown and gap-containing counted separately.

Findings: concise conclusions of all deduplicated findings, with file/line links and test suggestions.
Not completed: specific scope, reason, and next step, not just a percentage.

Details: per-file evidence, task results, actual model, number of calls, cost.
Artifacts: full structured results and a copy of the report (link provided only when generated).
```

Presentation order: overall status → findings → incomplete scope → scope/evidence → collapsed execution details. Independent units, parts, hunks, blocks, and API attempts each use their own denominators, and mixtures like "71 of 43 units" no longer appear.

The Actions Summary and the PR comment have separate size budgets: the Actions Summary is recommended to stay under 900 KiB, and the PR comment continues to observe its smaller limit. The existing scan top-N lists should change to "concise conclusions first, detailed skeletons/evidence collapsed", so that as far as possible the concise entries of all findings enter the same Summary.

If it still exceeds the limit, keep the overall status, totals, incomplete scope, priority findings, and a clear count of omitted items, and provide a truly downloadable full result. The full JSON does not drop entries because of the display cap. The report marks `execution_complete` and `report_truncated` separately; display omission does not by itself mean the corresponding code was not reviewed, and conversely one cannot write unreviewed items as complete just because the JSON exists.

When the artifact does not exist or the user turned off uploading, it must not prompt the user to download a non-existent file. The results reference content from the target repository, and continue to follow the existing cross-repository visibility check, retention period, and access restrictions; workers do not write raw prompts, secrets, or source directly into logs.

## 10. Suggested new configuration and compatibility

We suggest adding only two public inputs; the exact naming can be unified with existing conventions in the implementation PR:

| Input | Suggested value | Behavior |
|---|---|---|
| `review_scope` | `selected` (compatible default) / `all` | selected keeps the current selection/rotation; all builds tasks for all targets within the declared paths, and when the budget is insufficient still clearly reports incomplete, without silently falling back to sampling |
| `review_workers` | integer 1–4, default 1 | First ensure serial batching is correct, then use 2 for a concurrency canary; does not change the total budget |

The manual workflow can explicitly choose all, matching the use case of "one review looks at the full scope". Do not rely on the user turning off the scan issue to trigger some full-scope behavior by accident; scan state and this round's review scope are two independent concepts.

Under all mode, the semantics of `max_units`, `scan_max_blocks`, `max_diff_kb`, and `focus_*` must be written clearly and verified; in particular scan_max_blocks must not continue to quietly limit the full scope. Existing ignore, secret deny, user scope, and security boundaries are not canceled by all; all also does not mean reading the whole disk.

When the first version supports all only on the Claude API, other engines give a clear configuration error for that combination and go through the single failure report as usual; do not silently fall back to selected. Expand the support matrix after other engines are connected.

Keep `complete / incomplete / failed`. For manual runs in all mode, it is suggested that after the Summary is published, incomplete be returned as a non-zero exit as a goal not achieved; the selected advisory path keeps its current behavior. This change needs to land in `fail-on-error.js` and the input descriptions, and one cannot just turn on the existing `fail_on_error` and assume it is already implemented.

## 11. Implementation plan ordered by dependency

| Stage | Modification scope | Delivery and acceptance gate |
|---|---|---|
| P0: unify scope and part identity | `audit-units.js`, `audit-collect.js`, `scan-parts.js`, `claude-api.js`, `audit-post.js` | Minimal manifest; parts not planned by the collector, parts not executed by the engine, and failed/unanswered parts are all traceable; fix parts_left not taking part in the global completion judgment; one Summary |
| P1: scan full scope in one run, serial batches | the files above, `action.yml`, `validate-inputs.sh`, related tests | All targets of all enter the manifest first; execute per budget each time, and report incomplete honestly when the budget is exceeded; the fixed eight unit calls are not taken as full-scope proof; the scan issue is updated once at the end |
| P2: PR full scope in one run, serial batches | `collect.sh`, `focus.js`, `prompt.js`, a small `pr-parts.js`, engine, `post.js` | The full snapshot is saved before truncation; risk is used for ordering; candidates and evidence are built chunk by chunk; ID rewriting, visibility, necessary cross-chunk tasks, and aggregation validation pass; small PRs still use one call |
| P3: limited concurrency | engine scheduling, attempt/usage recording, concurrency tests | From 1 to 2 workers; in-flight budget, deadline, retries, and out-of-order output are provably correct; all public outputs are written only by the coordinator |
| P4: delivery and trial run | two publishers, `tee-summary.js`, `fail-on-error.js`, manual/reusable workflows, README, engine docs | Summary/comment sizes separated; global findings and scope information complete; new input forwarding, CFG, result artifacts, bootstrap pin, and docs are consistent; real small-scale Actions verification |

The basic findings, status, and Summary acceptance of each stage must be done when that stage is completed; it cannot be left until P4 to find out whether intermediate results were dropped. P4 does the full display, compatibility, and real-environment acceptance.

We suggest splitting it into four reviewable PRs: (1) ledger and scan correctness; (2) scan all + single-report refinement; (3) PR chunking + aggregation; (4) limited concurrency. Real trial runs run through the subsequent PRs. Finish correctness first, then use performance data to decide whether cross-runner execution is needed.

`.github/workflows/specguard.yml` forwards the Action inputs and references the Action by a fixed SHA; after adding configuration, the forwarding and contract tests must be synced, and the pin updated according to the repository's existing `bin/pin-reusable.js` flow. The result artifact of the manual workflow needs to include the manifest and aggregated status, and cannot upload only the workers' local files.

## 12. Verification and measuring effect

The tests below are target-behavior tests, not just a replica of implementation details:

| Scenario | Result that must be verified |
|---|---|
| PR >300 KiB, >60 source files, a gap buried outside the risk top 12 | That scope enters the tasks, is actually seen by the corresponding worker, and the valid finding appears in the final single Summary |
| Second half of a large file, deleted tests, cross-file rename or contract change | Sharding has no omission/duplication; LEFT/RIGHT quotes and original line numbers are correct; cross-chunk gaps can be detected |
| In scan, the first part of a unit succeeds and later parts are not selected or fail | unit touched does not equal fully reviewed; final is incomplete, and the specific parts stay in the incomplete list |
| Two chunks both return O1; the same R1 corresponds to different obligations | IDs and references are lossless, requirements are not wrongly removed by deduplication, and covered does not override gap |
| A's test evidence is cut, B sees the complete test | Each one's visibility takes effect correctly, with no cross-contamination or evidence-free upgrade |
| One chunk with invalid JSON, timeout, 529, omitted answers, insufficient budget | Other successful findings are kept; the incomplete scope is explicit; no complete marker, no wrongful clearing of old threads |
| Concurrent out-of-order, dynamic bisection, retries, unknown cost | Every task has a unique owner; maximum concurrency is controlled; reservations do not overdraw; normalized results are stable |
| A new head/requirement version arrives, or files from another snapshot are mixed in | Mixing is rejected, and the PR does not publish stale results |
| Duplicate findings from multiple workers in the same run | Findings are deduplicated; "confirmed in two runs" is not triggered |
| Very many findings, multibyte Chinese text, large skeletons | The Summary observes the limit in UTF-8 bytes; the omission count is accurate; full results are not lost because of the display cap |
| `delivery: summary` | Writes only one report, no PR writes at all; the failure path also has a single report |
| New inputs, CFG, reusable pin, unsupported engine | Forwarding is consistent; a configuration change triggers re-review; no silent degradation |

The offline stage uses existing eval/seeded cases, plus planted gaps across chunks and in the second half of files. Compare single call, serial chunks, and 2-worker chunks under a fixed snapshot, model, and prompt/pack configuration. Separately record verified findings, misses, false positives, evidence retention rate, scope completion rate, actual tokens/cost, paid failures, and p50/p95 elapsed time.

The benefit of concurrency is determined by measurement: it mainly reduces waiting time, and cannot first be promised to raise recall or lower cost. Finer chunks may improve local context, but also duplicate shared information and add cross-chunk relation cost.

Launch gate: the key coverage/aggregation/failure tests pass; serial and parallel results on the same fixtures agree; budget/rate limiting match expectations; there is only one final review Summary in real Actions; old small PRs and selected scan have no behavioral regression. Keep the path to fall back to 1 worker and selected through configuration.

## 13. Verification scope of this work and remaining uncertainty

This work read the Action, manual/reusable workflows, the PR collector/focus/prompt/post, scan planner/collector/post, the Claude API engine, schemas, preflight, and related tests, and checked GitHub's official Summary/matrix documentation. Existing local historical research is used only as leads; conclusions about the current state are based on this round's code.

An attempt was made to run the relevant offline tests. The main agent ran `node --test --test-reporter=dot src/claude-api.test.js src/audit-post.test.js src/prompt.test.js src/focus.test.js src/audit-action.test.js`; the scan worker also ran related tests. Overall they did not pass: under the Windows sandbox the temporary Git fixtures could not write `.git/config`, Bash startup showed Access denied/`0xC0000142`, and some context-pack assertions also failed. The worker observed that the core tests of scan-parts, unit-rooms, and keptRooms passed, but this cannot replace full-suite green verification.

After implementation, verification is needed on the Linux/Node 22 CI the project actually uses. The best chunk size, cross-file recall, concurrency rate limiting, total cost, and elapsed time have not been measured through real model experiments; therefore this plan gives no unsupported prices, performance improvement ratios, or completion schedule.

This work only adds this research document, did not change runtime logic, and did not publish any GitHub content. The suggested next step is P0: first make the same part identity run through planning, execution, and reporting, then extend one review to all targets.
