# SpecGuard: second-round blind-spot review and detailed optimization recommendations

Date: 2026-10-11 (Australia/Sydney). Review baseline: `experiment/trace-local-eval`, `eaa60cedaf3a523751443e5a448e9559d3a1ad0d`.

**What this repository does:** SpecGuard statically checks requirements, behavior, and test evidence on a PR, and publishes missing-test, weak-test, and standards issues. It does not execute the code under review and does not block merges. This round reviews the ordinary adoption scenario of "several PRs in the same repository, several pushes per PR, CI and review finishing asynchronously, occasional API failures", and does not assume very large scale.

**Conclusion: first fix the credibility and lifecycle of review results, then widen the detection scope.** The biggest new risks at present are: things not known may be treated as review completed, problems that still exist may be closed automatically, and a model that obeys the prompt may instead trigger validation downgrades. Adding retrieval, model rounds, or evaluation samples cannot fix these.

This round only adds analysis and evidence files, did not modify runtime code, and did not publish anything to GitHub. The "fixes" below are all implementation recommendations.

## 1. Evidence this round and corrections to the previous round's conclusions

The main flow of collect → requirements/trace → prompt → post was checked, along with preflight, check-result collection, Action wiring, CI, and the evaluator. Running the existing tests: **395 passed / 0 failed / 0 skipped**, about 66 seconds. The tests were first limited by sandbox process launching, and then completed in a local environment that allows spawning child processes; this is not acceptance on a production Linux runner.

Another **13 targeted probes** were made: reusing test fixtures, simulating the GitHub API, and reproducing historical-coordinate problems with temporary Git repositories. The raw results are in [audit-evidence-2026-10-11.json](audit-evidence-2026-10-11.json). The probe results prove deterministic behavior under specific inputs, and do not prove the production frequency or model accuracy; no paid model calls were made.

The first two analyses need the following corrections:

| Old judgment | Correction this round | Impact |
|---|---|---|
| A vanished fingerprint or a changed anchor is enough to determine did-fix | It can only be determined that "the finding did not appear this round, and nearby code changed"; omission, renaming, downgrade, and ignore configuration can all produce the same observation | N18 cannot be used directly as a fix-rate metric, see M14 |
| Two orpc merge rules might be lost by the `.md` filter | The saved PR bodies of #1705 and #1718 both contain the merge rule; fed directly into `collectRequirements`, the rule is still there, but the structured criteria count is 0 in both | Prioritize studying the recognition and contract of prose requirements; misses cannot be attributed to document filtering |
| Without a spec document, alignment does not apply | The PR or issue can still be a requirement source; the current prompt and the validator contradict each other on this | See M5; it can be improved without expanding document retrieval |
| All configuration, performance, and cross-service contract problems are statically invisible | They should be decomposed by specific problem: configuration defaults, timeout units, and request schema mismatches may be statically visible; deployment environment, real races, and capacity conclusions may need runtime evidence | The defect classification table adds "what evidence was available at the time"; do not exclude by category name alone |
| The proportions among 50 defects can directly decide whether to turn off tracing | It can be used to form a prior and choose experiments, but cannot alone prove a feature worthless; small samples, repeated identical mechanisms, and severity all affect the conclusion | Add controls and uncertainty first, then decide defaults |

For the file locations of the schema/handler of the third old sample `orpc-2057<-1721`, there was no original checkout this round, so **they are not yet verified**. The conclusions of the first two samples are not generalized to it.

## 2. Must fix: gaps that ordinary adoption scenarios already trigger

Priority P1 means to be fixed before expanding the pilot; no production incident was found that this round's evidence would justify classifying as an urgent P0. The M numbers are new in this round and are not to be mixed with the old report's U1–U20 and N1–N18.

### M1 · P1: `resolve_stale: false` has no effect in the Action

- **What it is:** Users can choose whether to automatically close old review threads. Evidence: `action.yml:25`, the publishing step environment `action.yml:148`, `src/post.js:929`.
- **Problem:** The input is defined, but the publishing step does not pass in `RESOLVE_STALE`. Normally that environment variable is empty, and `env.RESOLVE_STALE !== 'false'` is still true; the existing test sets the environment variable directly, bypassing the missing Action wiring.
- **Minimal fix:** Map `RESOLVE_STALE: ${{ inputs.resolve_stale }}` in the publishing step; add a contract check from input to runtime environment.
- **Consequence of not fixing:** Even if the user turns off automatic handling, the tool still changes thread state, undermining trust in the configuration.

**Acceptance:** Construct the `false` scenario starting from the Action input configuration; the number of GraphQL resolve calls must be 0; it is not enough to re-run the old test case that sets the environment variable directly.

### M2 · P1: A finding downgraded or moved to the summary is also treated as "problem gone"

- **What it is:** The publisher closes old threads according to this round's fingerprint set. Evidence: `src/post.js:702`, `src/post.js:827`, `src/post.js:929`.
- **Problem:** The set currently comes only from `merged` and does not include partial summary findings; the closing condition only checks whether the diff was truncated. Two probes reproduce this: after a citation failure turned a finding into `unknown`, the old thread was closed; when the same finding was still in the "asserted outside the diff" summary, the original thread was also closed.
- **Minimal fix:** Immediately forbid downgraded or incomplete runs from automatically closing threads, and make the live set cover all findings still present after validation. For old items that were "not reported this round", an explicit re-assessment result is needed; when this evidence cannot be obtained, keep the thread, and in the near term default automatic resolution can be temporarily turned off.
- **Consequence of not fixing:** The defect is not fixed, yet the UI shows resolved; when it appears again later, historical comment deduplication may also suppress the re-alert.

**Acceptance:** Cover unknown, source read failure, trace truncation, summary migration, deleted tests, and the same problem reappearing; these states cannot be auto-resolved merely because the current inline fingerprint is missing. Fix determination and comment deduplication are tested separately.

### M3 · P1: Trace limitations are recorded but do not affect final completeness

- **What it is:** `trace.js` records limitations such as candidate documents, time, and item caps. Evidence: `src/trace.js:653`, `src/trace.js:663`, `src/trace.js:741`; consumer side `src/post.js:808`.
- **Problem:** Limitations are written to `requirements-status.json.spec.limitations`, while post mainly looks at the top-level `status/limitations`. A probe constructed a result with "500 candidate documents unreviewed" and top level still available; the summary still showed `No test gaps found`, with no limitation notice, and wrote the completion marker.
- **Minimal fix:** Merge the relevant `spec.limitations` into the deterministic run-completeness status; clearly distinguish "only the inline prompt was truncated, the file is still readable" from "the collector did not actually collect". The final summary, preflight cache, and auto-resolve share this status.
- **Consequence of not fixing:** If the model does not restate the limitation, the user cannot see the omission; a green job and a clean summary together create excessive reassurance.

**Acceptance:** Without relying on model output, after injecting a real collection gap into the collector state, the summary must show the scope and reason, and must not give an unqualified clean conclusion or close old items.

### M4 · P1: A timeout that leaves valid JSON is treated as normal completion

- **What it is:** The engine writes `engine-status`, and post reads findings. Evidence: `action.yml:144`, `src/post.js:763`.
- **Problem:** `engine-status` is checked only when JSON reading/parsing fails. A probe put valid findings and `timeout` together; the result published the review normally, closed old threads, wrote the completion marker, and the summary did not show the timeout.
- **Minimal fix:** Read and evaluate the engine exit status independently, and then decide whether to use partial results. Keeping verifiable findings can be valuable, but they must be marked incomplete, with automatic resolution and success caching forbidden.
- **Consequence of not fixing:** A model exiting with failure cannot be reliably distinguished from success, and the next run on the same HEAD may also be skipped by preflight.

**Acceptance:** Test four combinations: `timeout + valid JSON`, `failed + valid JSON`, success but invalid JSON, and normal completion; check the summary, cache marker, and thread side effects for each.

### M5 · P1: With only PR/issue requirements, the prompt and the validator conflict

- **What it is:** Document tracing is added to the prompt on demand, while the basic requirement sources always include the PR/issue. Evidence: `src/prompt.js:32`, `src/prompt.js:98`, `skills/test-review/SKILL.md:32`, `src/post.js:83`.
- **Problem:** When there is no repository spec, the prompt requires `alignment=not_applicable`; the validator in turn forbids rows with a linked requirement from using that value. In the probe, after the PR body R1 was linked normally, the alignment generated per the prompt was downgraded to unknown.
- **Minimal fix:** Separate "whether to do repository document retrieval" from "whether there is a requirement against which consistency can be judged". Use not_applicable only for behavior with no linked requirement at all; keep the basic PR/issue consistency rule always, and sync the two skills.
- **Consequence of not fixing:** In the most common scenario of "no dedicated spec, but the PR has acceptance notes", artificial uncertainty appears, making it hard to verify the core value of being requirement-aware.

**Acceptance:** For five inputs — PR-only, issue-only, spec-only, no requirement, and `trace: off + PR requirement` — the status semantics of prompt, schema, and validator are consistent. `trace: off` should not automatically cancel PR requirement review.

### M6 · P1: HEAD is not the full version of the review input

- **What it is:** preflight uses the HEAD marker in the summary to avoid repeated spend. Evidence: `src/preflight.js:8`, `src/preflight.js:16`, `src/post.js:431`, the README workflow event configuration.
- **Problem:** Under the same HEAD, the PR body, linked issue, baseline specification, tool configuration, and checks can all change; looking only at HEAD skips re-review. Also, valid partial/unknown reports write the same marker, and the default event list does not include PR body edited.
- **Minimal fix:** Define the cache key as a digest of the actual review inputs: HEAD, diff base, specification baseline, requirement text digest, Action/skill/schema versions, and relevant configuration. In the near term, first allow incomplete results to be retried and let PR body edits trigger; check-result refresh should be separate from model re-runs, to avoid paying for another model run when lint goes from pending to passed.
- **Consequence of not fixing:** The user updates the requirement but the conclusion does not update; re-running after an issue was temporarily unreadable or the budget was raised may also keep reusing the old result.

**Acceptance:** Same HEAD + same inputs can skip; same HEAD + modified PR body/issue/configuration must not hit by mistake. When an issue update has no event channel, show the dependency version and provide an explicit refresh entry point, without claiming real time.

### M7 · P1: Preflight, deduplication, and auto-resolve do not uniformly verify the bot identity

- **What it is:** The marker is used to identify SpecGuard comments. Evidence: `src/preflight.js:8`, `src/post.js:714`, `src/post.js:827`; compare the identity check of the sticky update `src/post.js:748`.
- **Problem:** The three places only require that the author is a Bot and the marker matches, without checking whether it is this tool's publisher. Probes reproduce another bot's marked summary triggering a skip, and another bot's fingerprinted thread being resolved; this does not need malicious behavior to be assumed, since forwarding or copying can also trigger it.
- **Minimal fix:** All paths reuse the same publisher/App identity and tool namespace rules; when the identity cannot be determined, do not auto-resolve threads of unclear ownership.
- **Consequence of not fixing:** Different bots affect each other, causing missed reviews, wrong deduplication, or operating on threads published by others.

**Acceptance:** Same marker + different bot should not hit preflight, deduplication, or resolve; this tool's historical legitimate comments can still be recognized. Verify the actual identity of the job token and of a custom token separately, without assuming the two are the same.

### M8 · P1: When reconfirming HEAD fails, publishing continues instead

- **What it is:** Before publishing, check whether the PR has been superseded by a new commit. Evidence: `src/post.js:733`, `src/post.js:743`, `src/post.js:903`.
- **Problem:** When `pulls.get` throws, `current()` returns true. A probe made all three reads fail, and the review and sticky summary were still published; so the guarantee that "an old HEAD does not overwrite the current report" has a clear exception.
- **Minimal fix:** When the latest state cannot be confirmed, keep the job summary/this run's artifacts, and postpone modifying the PR summary and threads; before publishing, also check whether the PR is still in a state that allows publishing, and carry the input version. For the very short race that can still happen after the check succeeds, mitigate with run concurrency control and versioned results, rather than claiming atomic update.
- **Consequence of not fixing:** On network errors it is easier to overwrite newer conclusions, or to modify review status only after the merge.

**Acceptance:** In the three scenarios of read failure, HEAD change, and PR already closed, the current sticky is not overwritten; local results can still be viewed. Tests can only prove the sequences they cover, and should not claim the concurrency race is completely eliminated.

### M9 · P1: A failure of a non-core comment list drops the whole review delivery

- **What it is:** Before publishing, historical review comments are read for deduplication. Evidence: `src/post.js:827`, `src/post.js:936`.
- **Problem:** That read has no local error handling, and the exception is turned into a warning by the outermost layer and the process exits. A probe simulating 503 got 0 reviews and 0 sticky summaries; the completed analysis did not enter the delivery path normally.
- **Minimal fix:** Handle the dedup-read failure separately: record the delivery degradation, and at least write the job summary and downloadable results; when safe deduplication is impossible, update only the summary and do not continue to generate inline comments that may be duplicates. When retries still fail, there should also be a clear result status.
- **Consequence of not fixing:** The model cost has been paid, but the user sees only a green job or one log line, and it is hard to tell "no problem" from "not delivered".

**Acceptance:** Inject listReviewComments 503/403 faults; in the end there is still a readable result and a `delivery_degraded` status, rather than merely catching the exception and ending.

### M10 · P1: A successful result with the same check name can mask a failure from another source

- **What it is:** The user configures `check:lint` to confirm the execution result of standards tools. Evidence: `src/checks.js:13`.
- **Problem:** Matching looks only at the name and then picks the largest id; the producer is used only for display. A probe gave a failure from trusted-ci and a newer same-named success from other-app, and the aggregate result was passed.
- **Minimal fix:** When same-named results come from multiple producers, return an explicit ambiguity status, which cannot directly be passed; allow specifying the App/workflow identity when needed. For a legitimate re-run from the same source, apply the "latest" rule.
- **Consequence of not fixing:** "coding standards confirmed" may be confirming a check not specified by the team, and the tool evidence becomes a wrong endorsement.

**Acceptance:** With two sources of the same name, one failing and one succeeding, it must not be passed; a successful re-run from the same source can pass according to the documented rule. The source and check id should be kept for auditing.

### M11 · P1: Old line numbers of a three-dot diff are blamed on a different commit

- **What it is:** The collector's PR diff is from merge-base to HEAD, while historical intent uses BASE_SHA for blame. Evidence: `src/collect.sh:41`, `src/requirements.js:162`; tracing also uses two baselines at `src/trace.js:668` and `src/trace.js:684`.
- **Problem:** When the target branch moves forward and inserts lines at the top of a file, the left-side line numbers of the diff belong to the common ancestor and no longer correspond to the latest BASE. Reproduced in a temporary repository: the diff points to old file lines 7–13 `L7…L13`, while the same coordinates in the actual BASE are `INSERT7…INSERT10,L1…L3`.
- **Minimal fix:** Explicitly record `diff_base_sha = git merge-base BASE HEAD`, used for old-side references of the diff, historical blame, and requirement change comparison; keep `policy_base_sha` separately as the trusted specification source, and do not mechanically merge the two.
- **Consequence of not fixing:** Linking to unrelated historical intent, or wrongly judging whether a requirement was changed by this PR; long-lived branches and parallel development are especially prone to this.

**Acceptance:** With the target branch independently inserting lines, changing the spec, and changing the specification, while the PR itself stays the same, the three cases hold; history aligns with the diff, and the specification is still taken from the chosen trusted baseline. Complex multi-merge-base cases should have an explicit strategy or degrade.

## 3. Should fix: blind spots affecting evaluation and optimization direction

### M12 · P2: A case pass does not mean no false positives

- **What it is:** The evaluator counts both `fp` and `pass`. Evidence: `eval/grade.js:100`, `eval/grade.js:144`.
- **Problem:** `pass` does not require `falsePositives.length === 0`. A probe gave 1 correct hit and 1 extra false positive, and still returned `pass: true`; in addition, allow_summary matches only by kind/path, and multiple expectations may also share the same summary hit.
- **Minimal fix:** Clearly distinguish "expected hit passed" from "quality gate passed", and add an explicit false-positive budget to the quality gate; summary matching adopts the same one-to-one accounting as inline, and checks behavior identity.
- **Consequence of not fixing:** `12/12 passed` is easily read as all 12 being correct; moving to summary changes the score without necessarily improving detection.

**Acceptance:** Adding a known false positive to an existing hit result should make the zero-false-positive gate fail; one summary entry cannot satisfy two different obligations at once. `fp` is not currently uncounted; the problem is in the metric definition and usage.

### M13 · P2: A discovered file does not mean the model read it, much less reviewed it

- **What it is:** The summary's `Sources read` comes from the collector's manifest. Evidence: `src/post.js:423`, `src/post.js:933`; the prompt inline limit `src/prompt.js:7`.
- **Problem:** There is currently no record of actual tool reads proving that the model read all the listed files; the diff after 40 KiB is only asked to be read in a follow-up through the prompt, which cannot guarantee a complete analysis either. A file can be discovered, unread, and have no obligations, while the report still lacks a clear marker for that stage.
- **Minimal fix:** Immediately rename the title to `Sources available / collected`. Add a limited scope ledger: candidate, collected, provided to the model, evaluated as declared by the model, citation validated, delivered; when tool logs are unavailable, mark actual reads as unknown, and do not substitute model self-reports for runtime evidence.
- **Consequence of not fixing:** Users and evaluators overestimate the coverage of a "complete report", and when locating misses will only keep adjusting the model prompt.

**Acceptance:** Files that were discovered but have no proof of being read must not be written as read; a missing obligation also cannot be automatically interpreted as no behavior change. Model declarations and deterministic validation are listed separately.

### M14 · P1 (metric): An automatically computed "fixed" is not an actual fix

- **What it is:** The old handoff N18 suggested computing fix-through from fingerprint disappearance and anchor change. The two probes of M2 provide counterexamples.
- **Problem:** The same observation can also come from citation failure, output omission, a model version change, renaming, a deleted obligation, or wrongful closing. Even if the developer really added tests, it cannot be used to prove that the tests can stop the original defect, or that the change was caused by SpecGuard.
- **Minimal fix:** Split the metric into `still_observed`, `not_observed`, `reassessed_resolved`, `human_confirmed`; first measure observation persistence, then manually check independent expectations and valid assertions on sampled patches. Causal benefit is estimated separately through controlled experiments.
- **Consequence of not fixing:** The more easily the model misses, the better the fix rate may look, which directly pulls the optimization direction off course.

**Acceptance:** The unknown/summary-migration scenarios of M2 must not increase the confirmed-fix count; old items without re-verification can only be not observed. The artifact saves the conversion reason and evidence, and does not save a semantically ambiguous `fixed: true`.

### M15 · P2: Repeated mechanisms, repeated tuning, and run failures distort the benefit estimate

- **What it is:** The existing replay and seeded evaluations are used to decide retrieval, prompt, and the default trace strategy. Evidence: `docs/competitors/head-to-head.md:41`, `eval/replay/holdout-pairs.json`, `eval/grade.js:158`.
- **Problem:** The two orpc samples share the same defect mechanism, and the old holdout has already been used to choose lean; the evaluation summary excludes infrastructure errors and thus obtains metrics "conditional on successful runs". If samples of the same mechanism are treated as independent generalization evidence, or only the successful denominator is shown, the actual benefit is overestimated.
- **Minimal fix:** Hold out a new set grouped by repository/defect mechanism/time, and separately report model detection, end-to-end delivery, and the effective-alert rate over all eligible PRs; at the same time keep the denominators of failures, skips, and timeouts.
- **Consequence of not fixing:** Offline numbers improve but there is no benefit in production adoption; continuing to optimize on the old holdout only proves better fit to the old samples.

**Acceptance:** Freeze a new set that did not take part in prompt tuning; the same mechanism cannot span the training/validation groups. The report must list the total number of PRs, runs, completed runs, effectively delivered, and confirmed valuable.

## 4. Blind spots not yet confirmed but worth digging into by experiment

The following three items are **research hypotheses, not discovered production defects**. They supplement the old N list and must not be mixed with the deterministic reproductions above.

### M16 · Choosing "fewer alerts" may just push hard cases into unknown

- **What it is:** Output-validation downgrades can reduce wrong comments, but may also remove correct findings.
- **Specific hypothesis:** On the same set of defective PRs, the new prompt reports fewer and raises precision, while more obligations become unknown or unlisted, and the number of effective alerts actually falls.
- **Cheapest experiment:** For a fixed sample grouped by mechanism, record the item-by-item flow of raw finding → after validation → inline/summary; have a blind review mark the true positives that were filtered out. When comparing precision, also show the detection count, the proportion of refused judgments, and the proportion not assessed.
- **Cost of skipping:** The team may take silence for a quality improvement. Adopt a new threshold only after confirming that real false positives dropped and effective detections did not suffer unacceptable loss.

### M17 · File order and irrelevant context may change detection

- **What it is:** The collector has global byte, time, and count budgets, and the prompt also has an inline limit.
- **Specific hypothesis:** Placing the same defective file at the tail of the diff, or adding irrelevant documents in front, lowers the hit rate; even if neither version exceeds the collector's 300 KiB cap, the model may still stop during the follow-up reading stage.
- **Cheapest experiment:** Create three groups of views that keep the same semantics: changing context order, adding irrelevant content, and splitting code into different files; compare the hit and the stage of loss for the same defect, and record the budget.
- **Cost of skipping:** The accuracy of small PRs cannot explain a real monorepo. First use experiments to locate whether it is collection loss or a model attention problem, and then decide on batching by module; multi-model voting cannot be applied directly.

### M18 · Historical replay may have used requirement text that did not exist at the time

- **What it is:** replay requires using the PR's title/body at that time, but the current text in the metadata is not automatically the version at that time. Evidence: the time-point requirement in `eval/replay/README.md`, and the prBody input of `eval/replay.js`.
- **Specific hypothesis:** The author updated the PR body after QA found the problem, while replay handed the updated explicit rules to the reviewer, so it appears able to detect early. This round did not prove that any existing sample has this issue.
- **Cheapest experiment:** For new replays, record the requirement snapshot time, collection time, and how confirmable the version is; when the historical body cannot be restored, run two groups, "code and the repository contents at the time" and "assisted by the existing body", with the latter marked separately as an upper-bound estimate.
- **Cost of skipping:** Taking the effect of knowing the answer after the fact for shift-left capability. External retrieval must be turned off or bounded by a time range; the adjudicator may see the later fix, but the reviewer under test must not.

## 5. Minimal implementation plan: four work packages

The following is a specification, not a feature that has already landed; no new database, server side, dashboard, or model orchestration framework is added.

| Work package | Scope | Minimal deliverable | Acceptance gate | Dependency |
|---|---|---|---|---|
| WP-A: result status and threads | M1–M4, M7–M9 | Configuration wiring, explicit completeness, conservative thread status updates, publishing-failure fallback | All related fault probes turn into safe expectations, and existing tests pass | No organizational information dependency |
| WP-B: requirements and versions | M5, M6, M11 | Fix the alignment contract, distinguish the diff/specification baselines, define input versions and refresh method | The five PR-only contract groups pass, baseline advance still aligns, and a changed requirement does not wrongly use the cache | Run status from WP-A |
| WP-C: verifiable metrics | M10, M12–M15 | Source-ambiguity handling, explicit scoring gate, stage ledger, minimal JSON artifact | Can explain where each finding was lost; not observed does not equal fixed | WP-A, WP-B |
| WP-D: real adoption experiment | M16–M18, the old N's production engine/arrival time/comment noise | Frozen sample, blind review, controlled observation of fresh real PRs | Can answer effective alerts, developer handling cost, and run reliability | The first three packages, real repository access |

**Execution order:** WP-A first; WP-B first fixes the prompt conflict and baseline coordinates, then does caching. Do not introduce a whole requirements-sync service first for the sake of caching. WP-C's observability can start from local files; WP-D needs the user to provide real samples and adoption scenarios, and offline simulation cannot pass for completion.

### 5.1 Run status recommendation

Record the following three dimensions separately, to avoid one `success` carrying three meanings:

| Dimension | Minimal value examples | Rule |
|---|---|---|
| Analysis execution | complete / partial / failed | JSON parsing does not mean successful execution; engine status and collector limitations both take part in the judgment |
| Evidence conclusion | covered / gap / unknown / needs_human | The conclusion for a single obligation; does not replace the overall completion status |
| Delivery | delivered / summary_only / failed / superseded | The result of GitHub publishing; separate from whether the analysis completed |

These fields are preferably placed in the run metadata, without needing to change all model output schemas at once. First reuse the existing status and limitation records and consume them uniformly; add fields only for information that is actually missing.

Invariants: unknown cannot prove fixed; an unconfirmed current version cannot overwrite an existing report; a requirement omitted by the model cannot vanish from the list; a publishing failure cannot erase a valid analysis; every "confirmed" statement has a corresponding evidence type.

### 5.2 Minimal artifact specification

One filtered JSON per run, recommended to contain:

- `schema_version`, `run_id`, PR number, HEAD, diff base, specification base, Action/skill versions, and a configuration digest.
- The engine and requested model; write null when the actually routed model is unknown, and do not treat `auto` as a concrete model version.
- Source digest and collection time, collection limitations, analysis/delivery status, start/end times.
- Counts per stage: candidates, collected, evaluated obligations, unknown, raw findings, kept after validation, filter reasons, published, and summary-only.
- Stable identifiers of findings, before/after states, reasons for change, evidence paths; "fix confirmer" and the basis of confirmation may be empty.
- Fill Token/spend only when observed; fill null when data is missing, not 0. Cached tokens and billed tokens are not conflated.

**Do not directly upload the whole `.specguard-ctx` as general product data.** The current dogfood uploads it, but it contains raw PR/issue text and engine output; general run statistics need only the minimal fields above. When the raw text is needed for troubleshooting, use an explicit diagnostic artifact, with the storage location, permissions, and retention period stated clearly; no external telemetry service is added.

## 6. Acceptance and pilot: how to prove the optimization has value

### 6.1 First do low-cost deterministic acceptance

| Scenario | Correct result |
|---|---|
| input `resolve_stale=false` | 0 automatic resolves |
| Evidence citation invalid / requirement unreadable | unknown/partial visible; old items kept |
| Internal trace cap triggered | Does not rely on the model restating it; the summary still shows the limitation |
| Engine timeout but JSON complete | Partial results usable, run not complete |
| PR has AC, repository has no spec | requirement alignment is evaluated normally |
| Requirement changes under the same HEAD | Does not hit the old requirement result cache |
| A different bot copies the marker | Does not trigger a skip or thread operations |
| HEAD cannot be reconfirmed | Keep this result, do not overwrite the current PR report |
| Dedup list API fails | Degraded delivery, not silent loss |
| Two sources with the same check name | Ambiguity is explicitly visible, and cannot default to passed |
| Base advance causes line insertions | blame and requirement comparison use the correct diff baseline |
| One hit plus one false positive | The zero-false-positive quality gate fails |

### 6.2 A model experiment answers only one variable

Group one: before and after fixing M5, compare using the same batch of PR-only/issue-only cases, keeping the model, budget, and other prompts the same. Group two: make `trace off` and the proposed "strong-signal on" strategy into a paired comparison; report the three layers separately — no spec, specification prose, and explicit AC/spec.

One cannot submit prompt fixes, a model change, a budget increase, and a trace default change all at once and then attribute all the gains to tracing. Diagnostic variants are used to find the mechanism, and the final effect must be rechecked on new samples that did not take part in tuning.

### 6.3 The production pilot counts by PR and defect mechanism

It is recommended to first pick a real repository willing to give feedback, observe reliability with a small-scale shadow run, and then choose a controlled visible-comment pilot. 2–4 weeks is a suggested starting observation window, not a point at which a conclusion can be drawn when it expires; when the sample is insufficient, extend or report insufficient evidence.

| Metric | Denominator/definition | Guard against misreading |
|---|---|---|
| Usable-run rate | PRs whose analysis completed and whose results are accessible / eligible PRs | Counts run failures, permission problems, and timeouts |
| Effective-alert rate | PRs with a human-confirmed valuable and timely delivered alert / eligible PRs | Do not substitute precision computed only over successful runs |
| Detections and false positives | Counted by defect mechanism, with inline and summary listed separately | Repeats of the same mechanism are not treated as independent generalization samples |
| Fix confirmation | Findings with explicit change and recheck evidence / assessed findings | Not observed and auto-resolved do not count as confirmation |
| Feedback time | From reviewable input being ready to a valid result being visible | Also record the merge/QA start time, to distinguish early from late arrival |
| Developer cost | Time needed to read comments, verify, and reject | The comment count is only a proxy metric |
| Push cost | Runs, elapsed time, and obtainable billing data per PR | Rate limiting/concurrency cancellation must also be counted |

To judge the causal benefit of shift-left, visible suggestions and a shadow control can be assigned by PR within similar risk strata, or enabled in phases by team; record whether existing CI, CCR, and human review also found the issue. "Fixed later" cannot be automatically attributed to SpecGuard, and changes in PR merge time cannot all be attributed to it either.

The effectiveness threshold should be decided by the team's acceptance of the costs of misses and false positives. The 80%/90% and 10%/40% in the old report are proposed decision values, not universal proof; sample counts, grouping, and uncertainty must be shown at the same time.

## 7. Deferred optimizations, and avoiding turning optimizations into new defects

- **Incremental review:** It can reduce repeated cost, but "review only the diff since last time" would miss unmodified behavior affected by new specifications, new requirements, shared helpers, or deleted tests. First determine the invalidating dependencies; unchanged code cannot be equated with unchanged review inputs.
- **Raising max_comments:** The current skill requires a full analysis first and then limiting delivery. If detection improves only when the comment count is raised, the model is still affected by the display budget; first test whether analysis and delivery are truly decoupled.
- **Multi-model voting:** Under a contract conflict like M5, multiple calls only repeat the same problem; fix the deterministic path first, then decide by disagreement samples whether a recheck is worthwhile.
- **Vector retrieval, whole-repository indexing, and dashboards:** There is no evidence yet that they are the bottleneck of the failures above. First save the reasons for stage losses, then decide according to the actual failure distribution.
- **Hard merge gate:** Currently the incomplete, identity, and delivery semantics are not yet closed, so stay advisory. Improving credibility does not require adding blocking capability immediately.

## 8. Not checked and remaining unknowns

Not performed: real Copilot/Claude new-version production flows, organizational billing, real GitHub permissions/retries/thread operations, a full checkout of external repositories, Jira/ADO data, actual model read logs, real fixes and developer time. No new online verification was done of external research numbers or the current versions of software, and this report does not rely on them for conclusions.

The high-cost main path, the evaluation entry points, and related tests were read closely; not all fixtures, all research material, or all evaluation generators were re-read one by one. There is no deleted-line count or dependency-removal estimate that this round can support, so slimming benefits are not overstated.

Deciding the pilot strategy still needs three kinds of information: where the requirements mainly live; whether QA intervenes at PR preview or after merge; and which real repository and production engine can be used. These unknowns do not prevent implementing the deterministic fixes of WP-A and WP-B first.

**Verdict: first make every conclusion correctly express "what is known, what was not seen, and whether it is still valid", and only then pursue finding more problems. WP-A and M5/M11 are the parts most worth implementing first.**
