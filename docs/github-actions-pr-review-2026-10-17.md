# Re-check of SpecGuard's Latest GitHub Actions and Actual PR Evidence

> **Disposition status (2026-10-17, main 45713a2):** The findings in this document have been re-checked. Fixed: dogfood still green under auth failure (#222, #225); reducedReasons depending on wording (#221); PR-mode real guard end-to-end (#221). Unfixed / to do: the k2 TODO; the skipped real audit replay. Line numbers and SHAs are as of when this document was written.

> This document keeps an earlier run snapshot. #218–#223 were merged afterwards, and the new dogfood can already run the model; for the latest status and new findings see the [unknown unknown re-check](C:/Files/Projects/SpecGuard/docs/unknown-unknown-review-2026-10-17.md). The 19 authentication-failure summaries below are not the latest run status.

This report supplements the [branch cleanup report](C:/Files/Projects/SpecGuard/docs/repository-branch-review-2026-10-17.md) with remote run evidence. It was read through the GitHub plugin specified by the user, without re-running workflows, calling models, modifying configuration, or writing comments to GitHub.

Re-check snapshot: 2026-10-16 21:54 UTC, Sydney 2026-10-17 08:54. main is still `bcddf784f70d4f5b5a854d2c75789bd33f1591aa`, 83 remote branches; the open PRs are still #218, #199, #9, #8.

**Core conclusion: the recent code fixes are supported by remote automated tests and human review, but the recent dogfood model-review chain has no evidence of success. Real runs should be restored and verified first, before expanding scans and statistical quality.**

## 1. What was actually read this time

- Metadata of the latest 50 Actions runs: created 2026-10-16 09:48:24–12:28:06 UTC, including 35 PR events and 15 main pushes.
- The latest SpecGuard bot summaries of 22 PRs, #197–#218; the review discussions of #199, #215, #217, and #218 were also read.
- The job/step status of 9 key runs, and the raw logs of 10 jobs among them. Including the latest main, #218, the dogfood of #215/#217, two failed tests, #199, and the two most recent manual runs.
- The CI workflow of current main and the related locally cached code; the currently cached main matches the live SHA.
- Artifact metadata of 4 runs; a download reference for the #218 ZIP was obtained, but the local download failed due to DNS resolution, **so the ZIP contents were not read**.

The full metadata, selected log lines, and summary text are saved in the [evidence JSON](C:/Files/Projects/SpecGuard/docs/github-actions-pr-evidence-2026-10-17.json). Temporary signed download URLs, secrets, or the entire raw context were not saved.

## 2. Three conclusions that must be separated

| Observation layer | Actual result | Correct interpretation |
|---|---|---|
| workflow success rate | Last 50: 47 success, 2 failure, 1 cancelled, i.e. 94% success | Represents only the check results of the runs, not the model completion rate or defect recall |
| main automated tests | 1186 items: 1182 pass, 0 fail, 3 skipped, 1 TODO | Current deterministic tests pass; no coverage of the skipped/TODO capabilities |
| PR latest model summary | Of 22, 19 auth_failed, 3 did not call the model because all files were ignored | In this batch of latest summaries, none of the 19 attempts has evidence of a successful model review |

The third row is counted by **each PR's latest summary**, not by workflow attempts. Bot comments get updated, so all historical calls cannot be reconstructed from them, and 19/22 must not be taken as a long-term authentication failure rate of the whole service. The 3 ignored must not be counted as successful model reviews either.

## 3. [P1] The authentication problem of dogfood is a persistent chain fault

The [#218 dogfood raw log](https://github.com/Mira190/SpecGuard/actions/runs/38900709026/job/116971973269) records authentication being rejected at 12:28:20 UTC; afterwards the engine step and the job were both success. The same phenomenon appears in the final run logs of [#215](https://github.com/Mira190/SpecGuard/actions/runs/38898412110/job/116964379407) and [#217](https://github.com/Mira190/SpecGuard/actions/runs/38897355440/job/116960930096).

This is consistent with the existing design: the Action defaults to `fail_on_error: false`, providing advisory results to the PR; the failure is already displayed explicitly in the bot summary. So the problem is not "no failure state at all", but that **there is no gate correspondence between a green CI and the model review the user expects being completed**.

The current [CI workflow](https://github.com/Mira190/SpecGuard/blob/bcddf784f70d4f5b5a854d2c75789bd33f1591aa/.github/workflows/ci.yml) uses a temporary token fallback and a fixed `haiku-5.5`, with `fail_on_error: true` not set. The log can only prove that the provider rejected the credential; it cannot tell which secret was selected, or whether it expired, was entered wrongly, or lacks permissions; the cause should not be guessed from variable names.

Suggested handling with minimal changes:

1. Check the actual provider, credential source, and model configuration; after fixing, re-run only one representative PR to verify. Record only the provider and source name, and do not print secrets.
2. This repository's dogfood should use the existing `fail_on_error: true`, so that run failures such as authentication/quota/unusable output become visible; whether to make it a required check is decided together with service stability. There is no need to change the advisory default for all downstream users.
3. Reference the Action's existing `status`, `skip`, `partial`, `superseded` outputs, and count "all ignored" separately from "model completed", no longer reading only the job conclusion.
4. Acceptance must satisfy all of: a successful provider response, usable structured output, completed post validation, a summary pointing to the correct head, and a traceable terminal state. A green result after a re-run alone is not enough.

It is not recommended to bulk re-run all PRs with `force` during the failure; authentication errors cannot be solved by adding more calls. Historical fixes can still be judged by deterministic tests and human review, and a dogfood failure must not be used to infer that all fixes are ineffective.

## 4. [P1] The latest main does pass tests, but there are still clear quality blind spots

The [main test log](https://github.com/Mira190/SpecGuard/actions/runs/38898934737/job/116966103621) shows 1182 pass / 0 fail, about 54 seconds; the dogfood of the main push was skipped and cannot be called a passed model scan of main.

The [#218 test log](https://github.com/Mira190/SpecGuard/actions/runs/38900709026/job/116971973683) shows 1187 items: 1183 pass, 0 fail, 3 skipped, 1 TODO, about 48.9 seconds. This supplies the remote evidence for the previous report's "full local tests blocked by temporary Git permissions", but does not replace model quality evaluation.

Exceptions on main:

| Exception | Impact | Suggestion |
|---|---|---|
| The weak_test false-positive expectation for k2 toolbox has() is a TODO, and the actual assertion still fails | CI fail=0 does not mean that false positive is resolved | Keep it as a known limitation, list it separately as a release quality metric; when fixing, bring a real-model recall comparison |
| The two-real-audits replay is skipped | This CI did not prove that the confirmation chain of two real scans is still valid | Save the obtainable redacted fixtures, and schedule the replay to run in an environment with the data and record the result |
| Pinned commit verification skipped due to shallow checkout | This run did not complete that source verification | Fetch the needed objects for this check, avoiding unconditionally fetching the entire history for a single check |
| The competitor prompt check was skipped | That constraint was not accepted this time | Verify the skip condition and usage scenario; do not count it as a passed capability |

[kite-fp.test.js](https://github.com/Mira190/SpecGuard/blob/bcddf784f70d4f5b5a854d2c75789bd33f1591aa/eval/kite-fp.test.js) states explicitly: the k2 regression uses a canned model answer, verified through the real collect/post/fake GitHub; one of the tests deliberately pins "the current false positive is still published", and another TODO describes the expected behavior. It can verify post-processing boundaries, but cannot measure the precision/recall of the latest model. Do not raise the apparent pass rate by merely changing assertions or closing the TODO.

## 5. The latest two test failures have specific causes, and must not be generalized to current main still failing

| Run | Failure at the time | Later evidence and judgment |
|---|---|---|
| [38896210918, early head of #217](https://github.com/Mira190/SpecGuard/actions/runs/38896210918/job/116957180120) | 3 actual failures: the ownFile delegated-helper false positive, the delegated control of the scan real guard, the TEST_PATHS scenario; plus a separate TODO | The later #217 head was replaced, the final CI is success, and the full main suite passes. Human review explained: the candidate test scope must not wrongly restrict the delegated-helper search |
| [38895860994, early head of #215](https://github.com/Mira190/SpecGuard/actions/runs/38895860994/job/116956040137) | 2 actual failures: a document/unit combination previously expected to be "clean" now shows it needs manual inspection; the incomplete-scan title also gained an unknown-block explanation | Related to the new weak-evidence semantics, and the test scenarios were adjusted afterwards; main finally passes. One should not read only the old red light and conclude the new head cannot be merged |

This reflects the existing value of shift left: deterministic regressions with positive and negative examples can intercept real compatibility problems before merge; human review can also explain why a scope-restricting fix affects delegated tests. These regressions should be kept, rather than merely pursuing fewer red CI lights.

## 6. How the PR review records change priorities

### #215: the WIP for structured degradation reasons should be kept, the original loop problem has been fixed

[#215's review and replies](https://github.com/Mira190/SpecGuard/pull/215#discussion_r4294373791) confirmed a real problem: explanatory text was treated by the `reducedReasons` regex as a citation failure, leading to incomplete, no head marker, and repeated paid reviews. That loop was fixed in `debb50a` by adjusting the wording and adding an end-to-end assertion, and can no longer be reported as still reproducible.

However, the [later review](https://github.com/Mira190/SpecGuard/pull/215#discussion_r4294380962) pointed out that the root cause still depends on text parsing and suggested structured fields. This matches the direction of the uncommitted fix on local `fix/structured-reduced-reasons`; it is recommended to finish that WIP rather than open another duplicate fix.

Acceptance includes: all weak → unknown, no false clean headline, while complete=true and the head marker exists; a real citation failure can still degrade. **Run completion does not equal evidence supporting covered**; unknown must not be promoted to covered just to avoid a re-run.

### #217: the real-guard reverse control for PR mode is worth filling in

[#217's later review](https://github.com/Mira190/SpecGuard/pull/217#discussion_r4294378210) pointed out that PR mode mainly verifies parameters through a mock guard, and suggested adding a real post-level reverse test: when an unrelated test happens to contain the same literal, a real gap should still be published. The old report had found this direction, and the local structured-reasons WIP also adds a related cover-guard scenario; later one should check whether it fully satisfies this control, to avoid adding more tests of the same kind.

The review also explained that safety when candidate information is missing depends on the degradation order of candidates-cut. This is a cross-stage contract, suitable for pinning with one real combined regression, rather than adding a set of mocks for each function.

### #199: the old finding has been turned into implementation by later PRs, and the document status should be updated

The evidence levels, static rebuttal, dependency freshness, and candidate scope raised in the [#199 review](https://github.com/Mira190/SpecGuard/pull/199#pullrequestreview-5547200106) are already covered by #215/#217; the funnel was implemented by #216 and the reason breakdown continued by #218. Keep the research chain, but explicitly cite the date, source SHA, and resolving PR; otherwise the old report will keep creating duplicate development.

## 7. Real cross-repository scans: old runs exist, the latest version cannot yet be accepted

The SpecGuard repository API returns 19 workflow_dispatch and 0 schedule; this time the metadata of the 10 most recent dispatches was read, and the latest two examined in depth. This conclusion covers only this repository and does not mean other repositories have no scheduled scans.

The most recent [manual run 38515041761](https://github.com/Mira190/SpecGuard/actions/runs/38515041761/job/115691893065) scanned expressjs/express on 2026-10-14: target SHA `a419aa7350389a275ab45fde2e849ed1f02449ef`; the log shows 6/6 units, 0 design documents, 1 not admitted, scan_issue=false, ending with STATUS=complete. The dispatch commit was the old `eb324296c8ee5c17ddd5aa10846d4dd35de2d611`, earlier than this round's latest fixes.

This can prove that an old version ran the static unit scan flow; it cannot prove the latest main's cross-repository capability, design-document alignment capability, two-run confirmation capability, or finding accuracy. That run's result artifact metadata exists but its body was not read, so its actual findings are not evaluated. `6/6 units` also does not mean the test protection of the 6 units is sufficient.

The adjacent [failed run](https://github.com/Mira190/SpecGuard/actions/runs/38515025925/job/115691779809) refused to continue at the resolve stage because it could not determine the target repository's visibility, and the review was skipped. Such failures should be classified as target_access/resolve_error, and not mixed into "the model found no defects".

For the next execution validation, it is suggested to pin the Action SHA and target SHA to the latest main, and pick a representative repository "with requirement documents and with positive and negative examples": first verify the read-only scan, then verify state rotation and second-run confirmation; state the scope, unreviewed parts, and output for each run. Do not use the old Express success record to replace the latest acceptance. This round only read records and started no new paid runs.

## 8. observability and trace: a minimal closed loop from existing data

The Action already has artifacts such as summary, status outputs, counts/usage, and scan-parts; a stable linkage should be established first, without rushing to introduce a new tracing platform. The suggested fields are all contracts to be implemented / specified, and do not mean they all currently exist.

| Layer | Minimum to record | Main use |
|---|---|---|
| run | repository, run_id, run_attempt, PR, target/base/head SHA, Action SHA, configuration summary | Distinguish the code reviewed, the reviewer version, and the workflow version |
| collect | eligible/inventoried/selected counts, exclusion and truncation reasons | Prove the scan scope; connect to the reason breakdown of #216/#218 |
| pack | selected paths, full/partial/not transmitted, budget, part id | Answer what the model actually saw; do not treat the candidate list as actual input |
| provider | provider, requested/actual model, attempt, duration, error category, request id when available, usage | Distinguish authentication/quota/timeout/bad output; unknown cost stays unknown on failure |
| validate/post | valid/degraded/dropped reasons, unknown, published count, terminal state | Explain how model proposals become trusted findings |
| outcome | fix PR, human confirmation/false positive/rejection, detection and fix times | Measure whether the problem was resolved before merge |

A run trace can contain resolve → collect → pack → provider → validate → post; multiple parts use parent run + part/attempt id. SHAs, paths, and request ids go into trace/event attributes, not into high-cardinality metric labels; raw diffs, prompts, and credentials must not enter regular metrics and logs.

The first metrics to build are: the effective model-review completion rate of eligible PRs, failure rates such as auth/target access, share of unknown/truncated, latency from input to visible result, human-confirmed actionable precision, and whether the fix happened before merge. For categories with small samples show numerator/denominator together; do not fill in precision without human labels, and do not claim zero cost without usage.

It is suggested that the summary display combinations such as workflow=success, review=failed, reason=auth_failed; keep independent dimensions such as unknown and scope_partial. Authentication failures, visibility failures, and known TODOs must be traceable to the original run, head, and responsible configuration, so users do not have to dig through logs.

## 9. Updated action order

| Priority | Suggestion | Acceptance |
|---|---|---|
| P1 | Restore the dogfood credentials and use the existing fail_on_error configuration, add terminal-state linkage | A real review of one representative PR succeeds, and authentication failure fails explicitly |
| P1 | Continue reviewing #218, without ignoring the remote test evidence just because of the lack of model review | The evidence of 1183 pass is traceable; human review of the cap/time changes |
| P1 | Keep and finish the structured-reasons and eval-integrity WIP; extract the DENY residue | The corresponding real failure modes have positive and negative examples, not just a changed pass rate |
| P2 | Handle the k2 known false positive, the skipped real-audit replay, the PR real guard control | Keep true-positive controls at the same time; run a separate real-model recall evaluation |
| P2 | Cross-repository scan acceptance and minimal trace on the latest main | Pinned versions, computable scope, linkable states; failures and unknown explainable |
| P2 | After updating #199 and the duplicate reports, tidy branches by the checklist | finding → fix PR → verification evidence → cleanup record traceable |

The 76 remote branches, 95 local branches, and 35 worktree candidates in the original branch report did not become "directly deletable" because of this reading; all conditions on data preservation, locks, ignored files, and external Action references still apply.

## 10. Item-by-item record of the latest summaries of the 22 PRs

The following is a snapshot of mutable comments at the time of reading; it is not a mapping of every CI attempt. #202/#205/#207 were first merged into other branches, and eventually entered main.

| PR | Status | Latest SpecGuard summary | Evidence |
|---|---|---|---|
| [#218](https://github.com/Mira190/SpecGuard/pull/218) | Open | failed / auth_failed | [Latest summary](https://github.com/Mira190/SpecGuard/pull/218#issuecomment-6215503834) |
| [#217](https://github.com/Mira190/SpecGuard/pull/217) | Merged | failed / auth_failed | [Latest summary](https://github.com/Mira190/SpecGuard/pull/217#issuecomment-6214838288) |
| [#216](https://github.com/Mira190/SpecGuard/pull/216) | Merged | failed / auth_failed | [Latest summary](https://github.com/Mira190/SpecGuard/pull/216#issuecomment-6214800701) |
| [#215](https://github.com/Mira190/SpecGuard/pull/215) | Merged | failed / auth_failed | [Latest summary](https://github.com/Mira190/SpecGuard/pull/215#issuecomment-6214784943) |
| [#214](https://github.com/Mira190/SpecGuard/pull/214) | Merged | failed / auth_failed | [Latest summary](https://github.com/Mira190/SpecGuard/pull/214#issuecomment-6213523088) |
| [#213](https://github.com/Mira190/SpecGuard/pull/213) | Merged | failed / auth_failed | [Latest summary](https://github.com/Mira190/SpecGuard/pull/213#issuecomment-6213474983) |
| [#212](https://github.com/Mira190/SpecGuard/pull/212) | Merged | failed / auth_failed | [Latest summary](https://github.com/Mira190/SpecGuard/pull/212#issuecomment-6213433756) |
| [#211](https://github.com/Mira190/SpecGuard/pull/211) | Merged | failed / auth_failed | [Latest summary](https://github.com/Mira190/SpecGuard/pull/211#issuecomment-6213420984) |
| [#210](https://github.com/Mira190/SpecGuard/pull/210) | Merged | failed / auth_failed | [Latest summary](https://github.com/Mira190/SpecGuard/pull/210#issuecomment-6212783229) |
| [#209](https://github.com/Mira190/SpecGuard/pull/209) | Merged | failed / auth_failed | [Latest summary](https://github.com/Mira190/SpecGuard/pull/209#issuecomment-6212747167) |
| [#208](https://github.com/Mira190/SpecGuard/pull/208) | Merged | failed / auth_failed | [Latest summary](https://github.com/Mira190/SpecGuard/pull/208#issuecomment-6212669416) |
| [#207](https://github.com/Mira190/SpecGuard/pull/207) | Merged | complete / ignored, no model review | [Latest summary](https://github.com/Mira190/SpecGuard/pull/207#issuecomment-6212546041) |
| [#206](https://github.com/Mira190/SpecGuard/pull/206) | Merged | complete / ignored, no model review | [Latest summary](https://github.com/Mira190/SpecGuard/pull/206#issuecomment-6212340326) |
| [#205](https://github.com/Mira190/SpecGuard/pull/205) | Merged | failed / auth_failed | [Latest summary](https://github.com/Mira190/SpecGuard/pull/205#issuecomment-6212304807) |
| [#204](https://github.com/Mira190/SpecGuard/pull/204) | Merged | failed / auth_failed | [Latest summary](https://github.com/Mira190/SpecGuard/pull/204#issuecomment-6212297188) |
| [#203](https://github.com/Mira190/SpecGuard/pull/203) | Merged | failed / auth_failed | [Latest summary](https://github.com/Mira190/SpecGuard/pull/203#issuecomment-6212287077) |
| [#202](https://github.com/Mira190/SpecGuard/pull/202) | Merged | failed / auth_failed | [Latest summary](https://github.com/Mira190/SpecGuard/pull/202#issuecomment-6212282822) |
| [#201](https://github.com/Mira190/SpecGuard/pull/201) | Merged | failed / auth_failed | [Latest summary](https://github.com/Mira190/SpecGuard/pull/201#issuecomment-6212282012) |
| [#200](https://github.com/Mira190/SpecGuard/pull/200) | Merged | failed / auth_failed | [Latest summary](https://github.com/Mira190/SpecGuard/pull/200#issuecomment-6212060723) |
| [#199](https://github.com/Mira190/SpecGuard/pull/199) | Open | complete / ignored, no model review | [Latest summary](https://github.com/Mira190/SpecGuard/pull/199#issuecomment-6205647388) |
| [#198](https://github.com/Mira190/SpecGuard/pull/198) | Merged | failed / auth_failed | [Latest summary](https://github.com/Mira190/SpecGuard/pull/198#issuecomment-6202263329) |
| [#197](https://github.com/Mira190/SpecGuard/pull/197) | Merged | failed / auth_failed | [Latest summary](https://github.com/Mira190/SpecGuard/pull/197#issuecomment-6202263053) |

## 11. Scope not accepted

The artifact ZIP contents and the step-summary HTML on the GitHub web page were not read; the summary conclusions come from the actual PR bot summaries and job logs. All 382 runs and all 19 dispatches were not audited, models were not re-run, production recall was not measured, and the specific cause of the secret error was not determined. The authentication-failure statistics correspond only to the latest summaries of this batch of PRs and cannot be extrapolated to all consumers.

Verdict: the remote evidence reinforces the decisions to "keep tests and human review, fix run health, protect WIP, and migrate old branches selectively". The biggest value gap now is that the model-review chain is persistently unavailable, and that a green CI is easily mistaken for an effective review; before expanding scans, one real review should first be made completable, explainable, and replayable.
