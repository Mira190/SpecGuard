# SpecGuard Comprehensive Technical Assessment: Shift Left, Goal Completion, Net Benefit of Recent Optimizations, and Unknown Unknowns

> Historical snapshot note (updated 2026-10-18): this document is based on main `08d2c5b` and the PR #345 draft at that time. The deterministic downgrade rules for same-test / anchored-regex in that draft have been withdrawn; the revised #345 has been merged and now uses prompt constraints with counterexample tests retained. The risk analysis of the old design in this document is a historical record and does not mean the current main still contains that rule. Later, #351 added a requirement-version release check, same-call gating, and base-retarget test behavior; this report does not replace the latest acceptance of those commits.

> **Review cut-off: 2026-10-18 (Australia/Sydney).** Repository [`Mira190/SpecGuard`](https://github.com/Mira190/SpecGuard); default branch `main`; the actual mainline SHA reviewed is [`08d2c5b87bb8ffc144f4ca3135e8aa4ec79f327c`](https://github.com/Mira190/SpecGuard/tree/08d2c5b87bb8ffc144f4ca3135e8aa4ec79f327c). PR #345 was still OPEN at the cut-off and **cannot be counted as part of main**; #334 was also still open. The latest mainline [CI #39085373622](https://github.com/Mira190/SpecGuard/actions/runs/39085373622) succeeded. This document only reads the remote repo, PRs, Actions/jobs/logs, and the in-repo evaluations and code; **it did not re-launch model calls or independently replicate third-party repository experiments, and did not modify product code during the analysis phase; this document was subsequently submitted as a separate docs-only commit, which does not change the review cut-off**. Below, "directly checked this round", "maintainer experiment records", and "inference / to be falsified" are clearly distinguished.

## 0. Executive Summary and Decisions

**Conclusion: SpecGuard already has a real Shift-Left *mechanism*, but cannot yet claim to have proven a real Shift-Left *organizational effect*.** Early PR feedback, requirement-code-test traceability, test-level suggestions, manual cross-repo scanning, cost constraints, finding status, and a coverage-gap ledger are all implemented. However, the project's biggest risk has shifted from "can't do it, can't run it" to "**looking as if the review is complete, while interpreting a lack of evidence as no gaps; or conversely, interpreting failure to find a test as the test not existing**".

Five core judgements:

1. **PR mode: valid on controlled samples; real-world generalization not confirmed.** Kite 10 seeded PRs first-screen 10/10 (from existing project records, not re-run this round); in addition, an independent re-review of 10 zero-finding dogfood PRs found that 4/10 had real misses. The two numbers correspond to different, non-random samples; they cannot offset each other, and certainly cannot be extrapolated into production recall. See [`goal-assessment`](https://github.com/Mira190/SpecGuard/blob/main/docs/goal-assessment-2026-10-17.md) for details.
2. **Full-repo scan: usability greatly improved; finding quality remains the main bottleneck.** In the original 5-repo third-party scan on October 17, 8 model findings were counted and human labelling found 0 valuable; after multiple fixes were merged the same day, a single full run on the five repos reached all unit parts/blocks in their inventories. Spot checks on Cobra showed that the statement "no direct test reference found" was true for 7/7, **but "true" does not mean a standalone unit test should be added**; the new findings from the other four repos have not been systematically blind-labelled.
3. **#343 is a positive engineering optimization supported by measurements, but the gain is mainly fewer misclassifications as `unsure`, not an improvement in recall/accuracy.** The latest PR provides an offline comparison + branch-pinned real runs; a reduction in "forced" cannot be directly recorded as "more real gaps found".
4. **A green status is currently decoupled from review sufficiency by design, but the usability risk is significant.** The latest mainline test job: 1480 tests / 1476 pass / 0 fail / 3 skipped / 1 TODO; however, some dogfood reviews are still `incomplete`. Manual run [`39035605423`](https://github.com/Mira190/SpecGuard/actions/runs/39035605423) is green, and the job log explicitly states `STATUS: incomplete`, because for 20 units only part of the tests were seen; this matches the current definition of `fail_on_error`, but a user who only looks at Actions green will misread it.
5. **#345 should not be merged on the strength of a local sample of reduced false positives alone.** It treats "another exact assertion in the same test block" as the basis for downgrading a weak-test finding; this does not prove that **the specific output/branch that was pointed out** is constrained by those assertions. Both true negatives and false negatives need to be tested, especially counterexamples with different assertion subjects.

**Recommended positioning**: for now it can serve as a "pre-PR validation-evidence review assistant + experimental repository test-debt radar"; it should not be packaged as "reliably proves there are no missing unit tests", "whole-repo behavior has been verified", or "an enterprise-grade automated QA gate". The next milestone is not to add more features, but to prove that **delivered precision / recall, completeness, and real author fix rate** improve stably across different languages, repositories, and change types.

---

## 1. First Principles: What Should SpecGuard Actually Optimize

The original requirements are in [`goal-first-principles`](https://github.com/Mira190/SpecGuard/blob/main/docs/goal-first-principles.md):

> Create a unit test review AI GitHub Workflow. Must review requirements and the tests, and identify missing unit tests. Must check coding standard has been confirmed too. If possible, review component/integration testing and determine what can and should move down to unit testing.

The quality problem should be split into four objects: **R requirement intent, C code behavior, T tests and their oracle, S engineering standards**, plus the time **t** at which things happen. What really needs answering before QA is not "does the code have a test file", but:

- `R → C`: is the requirement implemented, and is it consistent; are old and new requirements confused?
- `R → T`: does every key behavior, failure path, boundary, and invariant have a correct oracle?
- `C → T`: is the added/changed behavior actually constrained by assertions, rather than merely executed or covered?
- `S → C`: have the applicable coding standards been found, and have the actual lint/format/check been executed and confirmed?
- `T_high → T_unit`: can stable, deterministic, low-environment-dependency verification be pushed down to unit level while keeping the genuine integration contract tests?
- `t_before_QA`: were these suggestions delivered and adopted before QA took over, ultimately reducing downstream defects/rework?

A formal but practical goal:

`Expected early QA value = P(true actionable gap) × P(delivered) × P(author fixes before QA) × expected downstream cost avoided − review/triage/compute/false-alarm cost`

This formula is a reminder: **even if precision rises, the value may be negative if many real problems are silently downgraded (recall falls); even if 100% of whole-repo calls succeed, if the report is not seen or not fixed, it does not amount to Shift Left.**

We recommend five state variables that do not get mixed up: `execution` (engine and delivery execution); `scope` (whether objects/documents were inventoried); `evidence` (whether candidate tests/code/references are completely visible); `judgement` (how reliable the model's determination is); `delivery` (what kind of findings the author saw). The failure of any one of them cannot be replaced by a single "no gaps found".

## 2. Goal Completion Matrix (functional acceptance and effect acceptance kept separate)

| Original / evolved goal | Implementation maturity (per main) | Evidence of actual benefit | Unmet acceptance conditions |
|---|---|---|---|
| PR trigger, earlier review with each push | **Implemented**. CI `pull_request` and reusable Action | Kite seeded samples, real dogfood comments | Real teams, FN on no-alarm samples, author handling rate, cross-repo stability |
| Requirement extraction and R↔C↔T traceability | **Partial to fairly complete**: PR/issue + repo docs + trace | Existing retrieval-set metrics R→C MRR 0.444→0.750, C→T Hit@3 4/24→20/24 (Fastify controlled set) | Different languages/monorepos, historical requirement conflicts, PRs that only change the spec, dynamic dependencies/cross-service |
| Finding missing unit tests | **Implemented but highly uncertain** | PR seeds 10/10; full-repo old-version third-party 0/8 valuable; the new version needs a large-sample blind labelling | Distinguish no matching test, no assertion, no effective oracle, genuine new requirement gap |
| Finding weak tests, value assertions and boundaries | **Basic rules + model implemented** | Three-party 40 static seeds old baseline delivered 11/40, raw 21/40, boundary 0/10; later reinforced but no comprehensive re-test on the same basis | Semantic data flow, properties/invariants, cross-test helper functions, mutation-survival verification |
| Confirming coding standards | **Functionally wired in**: instruction/CLAUDE/CONTRIBUTING and `standards_checks`, `standards_paths` | No independent, complete, real "violation + lint check" closed-loop acceptance seen this round | Source/version/scope of applicable rules, checks actually passed, missing config explicitly UNKNOWN |
| integration/component→unit suggestions | **Semantic classification exists**: `higher_level_only`, `pushdown` | Real report output exists, but there is no systematic human value labelling | When the integration test must be kept, the replacement cost of unit tests, design review without wrong downgrades |
| Manual input of target repo/PR/folder scan | **Implemented for GitHub-internal resources**; `scan_paths` + scope anchor, `scan_scope=all` | Real full-repo runs on 5 external open-source repos | Non-GitHub document URLs cannot be read directly; enterprise-internal GitHub repo/App permissions and end-to-end acceptance; scan `all` supports only the Claude API engine |
| Reusable workflow / standalone action | **Implemented**, callable from other target repos | Interface-forwarding checks in CI, README description | Security policies of different enterprise orgs, Copilot org quota, real canary for private/internal network/permissions |
| Local Shift Left | **A CLI exists** `bin/specguard-local.js` and Windows bash fix | Unit tests, platform simulation | IDE development-loop UX, consistency with cloud configuration, real user experience of cancellation/cache/exception convergence |
| Whole-repo full scan | **Technically implemented** `scan_scope=all`, segments and admits by budget | In round 2 of the five repos there were no unreviewed segments/doc blocks | "All segments included in the inventory" does not equal "all behavior of the repo"; there are also tests that were sliced (unsure) |
| Actually reducing QA rework | **Not proven** | Only agent-written seed PRs / closed-loop instances, no human author cohort | Real author time, defect escape rate before/after intervention, QA rework duration, intervention/control comparison |

The gap between "functionally present" and "goal achieved" is the most important conclusion of this assessment. Do not give an "overall completion of 85%" that has no reproducible definition. If staging is required, the current stage is **technical-capability MVP → controlled pilot**; it has not reached verified organization-level Shift Left.

## 3. This Round's GitHub Snapshot: Mainline, PRs, Actions

### 3.1 Git/PR Freeze Points

- Mainline [`08d2c5b`](https://github.com/Mira190/SpecGuard/commit/08d2c5b87bb8ffc144f4ca3135e8aa4ec79f327c) is the commit that merged [#343](https://github.com/Mira190/SpecGuard/pull/343); GitHub time 2026-10-18 01:08 UTC (Sydney 12:08).
- [#344](https://github.com/Mira190/SpecGuard/pull/344) was merged at 2026-10-18 00:21 UTC: unit provenance, directory scope anchoring, CommonJS export names, repair reserve, Windows Git Bash.
- [#343](https://github.com/Mira190/SpecGuard/pull/343) is merged: per-model-call cut attribution, ordering by test content size, full slice pricing.
- [#345](https://github.com/Mira190/SpecGuard/pull/345) **is still open**: same-test-block pin-value gating + `NO_GAP` regex revision; its [CI #39084816569](https://github.com/Mira190/SpecGuard/actions/runs/39084816569) passed, but that does not mean the mainline contains this feature.
- [#334](https://github.com/Mira190/SpecGuard/pull/334) is still open, its content being cleanup of docs / sensitive local evidence; not a fact landed on the mainline.
- Key recently merged: [#329](https://github.com/Mira190/SpecGuard/pull/329) whole-repo single run, [#333](https://github.com/Mira190/SpecGuard/pull/333) eval construction/scoring fixes, [#335](https://github.com/Mira190/SpecGuard/pull/335) call-level evidence and conservative usage, [#336](https://github.com/Mira190/SpecGuard/pull/336) eval scope, [#340](https://github.com/Mira190/SpecGuard/pull/340) report completeness, [#341](https://github.com/Mira190/SpecGuard/pull/341) matching and slice forced fixes, [#342](https://github.com/Mira190/SpecGuard/pull/342) manual-form scope.

### 3.2 The Actual Difference Between CI and Review Status

| Evidence | Observation | What can / cannot be inferred |
|---|---|---|
| [main CI #39085373622](https://github.com/Mira190/SpecGuard/actions/runs/39085373622) | test success, dogfood skipped (push, not a PR) | `node --test` 1480 tests, 1476 pass, 0 fail, 3 skipped, 1 TODO; **there was no dogfood review for this mainline push** |
| [#343 CI #39083902859](https://github.com/Mira190/SpecGuard/actions/runs/39083902859) | PR test/dogfood executed successfully | but the [#343 summary](https://github.com/Mira190/SpecGuard/pull/343#issuecomment-6243528183) explicitly says `incomplete`: 7 test files partially visible; cannot be taken as "the PR was reviewed completely" |
| [#345 CI #39084816569](https://github.com/Mira190/SpecGuard/actions/runs/39084816569) | test 1478/1474 pass/0 fail/3 skipped/1 TODO; dogfood success | [#345 summary](https://github.com/Mira190/SpecGuard/pull/345#issuecomment-6243678817) `complete=false`, summary-only finding 1, several historical findings `not_observed`; cannot prove that these old findings are all fixed |
| [manual #39035605423](https://github.com/Mira190/SpecGuard/actions/runs/39035605423) | job success, `scan` 23/23 units (25 parts) | log `STATUS: incomplete; REASON: 20 units were reviewed with only part of their tests`; `fail_on_error:true` turns red only for genuinely failed; part-of-tests is an unsure/warning. A concrete counterexample of **successful execution but incomplete verification** |

The `fail_on_error` wording in the current [`action.yml`](https://github.com/Mira190/SpecGuard/blob/08d2c5b87bb8ffc144f4ca3135e8aa4ec79f327c/action.yml) already says that incomplete only warns. The logic is not necessarily a bug, but there is risk for the dashboard / branch protection / user mental model. We recommend delivering two independent checks, `execution_status` and `verification_assurance`, and making the required-check policy explicit: **an execution failure blocks; insufficient evidence should by default not be shown by the UI as "safely passed"**.

### 3.3 One More Security / Product Boundary

The manual workflow uses the environment `specguard`; the comments in the file itself explicitly require **restricting it to the protected main** in the GitHub repository settings; the YAML itself cannot substitute for this organization-level configuration. It guards against publicly exposing private-target results in a fail-closed way; `ctx_retention_days:0` turns off the sensitive-context artifact in manual results. In contrast, the [`ci.yml`](https://github.com/Mira190/SpecGuard/blob/main/.github/workflows/ci.yml) dogfood still uploads a `specguard-ctx` artifact for 7 days. For future rollout to internal/private repositories, **permissions, artifact visibility scope, the fork/PR trust boundary, and prompt-injection tests must be done separately**. The above are trust boundaries that need acceptance, not a finding that data leakage has occurred.

## 4. The Most Important Measurements: Full-Repo Scope and Model/Static Finding Quality

### 4.1 Pre-Fix Baseline: Do Not Forget the Negative Data

The [`third-party-scan-eval-2026-10-17.md`](https://github.com/Mira190/SpecGuard/blob/main/docs/third-party-scan-eval-2026-10-17.md) published in the project repository records the first batch of real scans of Nest / Fastify / Flask / Cobra / Hono on October 17:

- The model counted 8 findings, and human assessment found **0/8 genuinely valuable**. Of these, 6 already had tests (the candidate retrieval just did not match them); in addition, a non-product performance script was treated as a gap.
- 40 offline static seeds: **raw 21/40, delivered 11/40**; with boundary cases removed **0/10**. This is an early version and cannot be passed off as a score after #343.
- Weak-lead sampling has a lot of noise; unreferenced exports are fairly useful on direct test entry points such as Go, but are often wrong in JS/Python repos that are tested indirectly through a public API/DI.
- This reflects open-world logic: `test lookup returns empty` **does not imply** `no test exists`; `export not lexically mentioned` **does not imply** `behavior untested`.

### 4.2 Real Full-Repo Runs After the October 17 Fixes

Round 2 was on main `b30696a`, with the five repos run through `scan_scope: all`; **every unit part and doc block included in the inventory had call coverage, with none left uncalled because of budget/time**. The data are taken from §8 of the same document:

| Repository | inventory units | units considered to have only part of their tests (round 2) | model calls | cost | reported gap count (not uniformly labelled) |
|---|---:|---:|---:|---:|---|
| Nest | 489 | 262 | 108 | $0.77 | 16 + 1 pushdown |
| Fastify | 33 | 19 | 24 | $0.36 | 10 + 1 pushdown |
| Flask | 21 | 11 | 9 | $0.06 | 4 + 2 |
| Cobra | 18 | 7 | 14 | $0.19 | 6 |
| Hono | 172 | 133 | 81 | $0.77 | 17 |

Spot checks in round 1 on Cobra found 7 cases of "no direct reference found in `_test.go`" were all factual; but this is only an **exact static observation**, not 7 obligations verified as needing new unit tests. The findings of the other four repos in this round lack blind labelling: **the latest full-repo precision cannot be given**.

Kite 8 seeds: at the time of the #329 full run (`130/130` unit parts + `131/131` docs blocks), model 3/8, statically visible 6/8; after #341/#340 the full-run model was 2/8, statically visible 7/8. Full coverage did not rescue the seeds of the deleted-test type (1–3): this shows that what is lacking is not only retrieval/budget, but that gap inference and model behavior are an independent bottleneck. Note: this is a set of seeds specially designed and touched by the model over multiple rounds, and cannot be treated as a production generalization score.

### 4.3 #343: Which Part Can Be Judged Positive, and Which Part Cannot Yet

The offline before/after provided by the [#343 PR](https://github.com/Mira190/SpecGuard/pull/343) (collector + real pack, not equivalent to a fresh end-to-end blinded eval):

| Repository | forced before → after | change | unit calls before → after |
|---|---:|---:|---:|
| Nest | 263 → 78 | -70.3% | 108 → 104 |
| Hono | 133 → 82 | -38.3% | 81 → 78 |
| Fastify | 19 → 12 | -36.8% | 22 → 21 |
| Flask | 11 → 5 | -54.5% | 9 → 9 |
| Cobra | 11 → 7 | -36.4% | 14 → 13 |

The same PR's branch-pinned **real runs** (new runs, not runs after merging into main) are in the [#343 description](https://github.com/Mira190/SpecGuard/pull/343):

- Nest [#39083946253](https://github.com/Mira190/SpecGuard/actions/runs/39083946253): forced 262→79, 104 calls, $1.46;
- Hono [#39083944276](https://github.com/Mira190/SpecGuard/actions/runs/39083944276): 133→81, 78 calls, $1.14;
- Kite seeded [#39083942363](https://github.com/Mira190/SpecGuard/actions/runs/39083942363): 13→0, tests considered complete for 43/43 units; reported 6 missing + 3 weak, which is **not** "8/8 seed recall" (the number of findings cannot be treated as seed recall).

**Why it is a positive engineering gain:** it fixed the misattribution in which all calls shared a global `pack-cut` (a shared test cut in call B made the units of call A unsure as well); after that, small test packs take priority and over-long tests are priced by full slices, reducing misclassification of partial-test visibility. The PR checked some units that went from forced to non-forced on the actual packs, and found no violating instance of "should have been truncated but was mistaken as complete".

**What still cannot be said:** it cannot be said that model precision/recall is better than #341; it cannot be said that every 80-line test block is visible; it cannot be said that #343 has run a new round of five-repo blind labelling on the latest `main`; $1.46/$1.14 cannot be used to prove that the default $1 can achieve the same (the budget inputs of the real runs need to be checked separately). Keep #343 first and do not roll it back; but add reconciliation regressions for forced, `cut attribution`, and the actual visible-span, so that they are not swallowed by future optimizations.

### 4.4 Is Each Recent Fix a "Positive Optimization" (Net Benefit Judgement)

| PR | Positive evidence | Main counter-risk / insufficient evidence | Conclusion |
|---|---|---|---|
| #329 full-repo all | 5 repos, all parts in one run; Kite seeds 130/130 parts | Depends on Claude API rather than Copilot; cost, very large repos and completeness semantics | **Keep it; functionally positive; quality not proven** |
| #333/#336 eval credibility | Fixed zero diff, error-excluded docs, double counting, etc., lowering the risk of "testing the wrong object" | Historical scores cannot be compared directly across versions | **High-value positive; baseline needs versioned rebuilding** |
| #335/#344 provenance | Restricts findings from citing sources that do not exist in their own call/unit | An overly strong "own file" gate may silently suppress real cross-unit gaps | **Largely positive; needs negative-example recall tests** |
| #340 report honesty | Unassessed items no longer masquerade as non-requirements, all output is complete with static leads, ledger | More all output increases information overload | **Positive; change to tiered UX** |
| #341 test-matching convergence | Eliminates cross-directory contamination of same-named index/handler tests, inflated weak-match cuts | May exclude real cross-package integration candidates | **Leaning positive; needs retrieval Recall@k guard** |
| #342 manual scope | Directory URLs anchor the scan scope, reducing review of the wrong scope | Non-GitHub URLs and private-repo permissions still limit it | **Positive UX/security** |
| #343 per-call cut/slice | Offline + branch experiments greatly reduce forced; fewer calls | "Partial test visibility" does not equal finding quality | **Clearly a positive engineering optimization, with benefit limited in scope** |
| #345 same-test pin (not merged) | Hono/Flask instances have genuinely redundant weak assertions | Assertions on other subjects cannot prove the current subject, branch/parameter/path | **No judgement yet; require FN regression** |

---

## 5. The Real Bottleneck of PR Mode Today: From Finding to Being Usable by the Author

The present PR pipeline can be broken down as `Changed behavior → obligation → evidence candidates → context pack → model → evidence verifier → confidence gate → inline/summary → author action`. Every step can lose true positives, and "all CI green" does not expose this fact.

1. **Retrieval**: hunk identifiers improved the C→T search in Fastify, Hit@3 4/24→20/24; however, the baseline set had one high-contributing file, and after removing it there was still progress to 14/24, but it is still not a guarantee across all languages/cross-service. Improving candidate recall should rank ahead of expanding model calls.
2. **Packing**: [#343 dogfood](https://github.com/Mira190/SpecGuard/pull/343#issuecomment-6243528183) lists multiple test files where only part of the text was seen; the report has `execution_complete=false`. The root cause here is evidence transport/budget — not reasoning; marking context loss as `unknown` is right, but the proportion in which loss occurs and the top-risk priority should be measured.
3. **Verification**: a plausible story generated by the model may cite lines "not actually seen by the call". #335/#344 have strengthened provenance, but beware of changing the verification rule into "accept only single-file local defects", which would make cross-module/indirect-call classes easier to miss.
4. **Publishing**: the fast tier has at most 3 inline comments, the rest are summarized; the combined large-PR delivered 10/24 (14/24 in isolation, repo records), which shows that "the model found it" and "the user saw it on the first screen" are not the same event. Optimizing the delivery layer is more direct than blindly splitting more model calls.
5. **Lifecycle**: an old finding being `not_observed` does not equal fixed; the latest summary of PR #345 has several previously recorded items that are no longer observable. `addressed-by-validated-test`, `code-touched`, `still-present`, `unobserved`, `dismissed` must be separated, and no fix rate may automatically count the latter classes as addressed.

**Mandatory UX principle**: if any of `input/source/candidate/pack` is incomplete, the top bar must clearly state `Reviewed X/Y behavior obligations; evidence cut for Z; verdict for affected criteria: UNKNOWN`. `No findings` should only mean "no publishable findings for now within the scope that was actually reviewed", and must not be misread as "the tests are sufficient".

## 6. Unknown Unknowns: New High-Risk Hypotheses Raised from First Principles

These are **candidate failure modes that need to be actively falsified**, not confirmed bugs. P0 means that, if true, they would directly damage the core shift-left judgement.

| Priority | Unknown / risk hypothesis | Why it might fool the existing tests | Minimal falsification experiment and success threshold |
|---|---|---|---|
| **P0** | **Correlation fallacy: another value assertion in the same block in #345 causes the target weak assertion to be downgraded** | `expect(a.ok).toBeTruthy()` and `expect(text).toBe('Hello')` can be independent of each other; "same block" does not constitute causal protection | Controls with three kinds of real gaps (same block but different subject, different parameter, different branch) + a real false-positive control; delivered recall must not fall for the former, false positives must fall for the latter; otherwise only the wording is lowered and delivery is not suppressed |
| **P0** | **Wrong completeness quantification: inventory=100% yet it does not include generated code/config/SQL/schema/external contracts/dynamic behavior** | The denominator is defined by the heuristic inventory itself, so `100% of inventoried` may hide objects that were not included | For each repo, manually sample 50 actual changed behaviors; compare the four denominators `discoverable / inventoried / reviewed / delivered`; show unrecognized categories as excluded/unknown |
| **P0** | **Provenance of cross-call findings is too strong or too weak** | The same behavior spans multiple units, a shared test, or a call chain; a strict own-file gate may delete correct findings, while a lax one lets hallucinations through | Two-way mutation: a genuine cross-unit gap, and a forged other-call citation; measure FP/FN separately, rejection reasons must be auditable |
| **P0** | **An actually complete snippet ≠ semantically complete tests** | An 80-line window may cover the assertion but miss the setup, helper, fixture, beforeEach, parameter table | Construct samples where the assertion is inside the window but the setup/fixture preceding the assertion is outside it; must be downgraded to UNKNOWN or the context expanded; "fully verified" is forbidden |
| **P0** | **Same green CI but the review is actually incomplete** | `fail_on_error` does not block on unsure, and users may only look at the badge | From the Actions consumer's view, sample 20 successful runs and count complete/unsure/failed; two clearly independent checks + a real UI canary |
| **P0** | **Requirement oracle contamination (C=T≠R)** | The requirement did not change, code and tests were changed wrongly together; a traditional code+test reviewer may be misled by tests that agree with the code | Lock the old requirement value, change code/tests in sync to a wrong new value so all units are green; a requirement contradiction must be reported |
| **P0** | **Requirement is only changed, or the requirement is dropped when the PR issue is not linked** | Docs-only PRs or external requirement links across repos; if PR mode only looks at source changes, the default is "nothing to review" | Requirement-only PR + linked issue + GitHub doc only + non-GitHub doc URL; accept the model input and unread-source warnings item by item |
| **P1** | **Coverage/mutation-test data is wrongly bound to a commit** | The coverage_file is generated in the same job but is not for the target HEAD, and the merge commit differs from the PR head; "covered" may be mistaken | Attach the source SHA/hash to the coverage file; run `head`/`merge` for two-version comparison; SHA mismatch is downgraded to unavailable |
| **P1** | **Historical requirement deviation misattributed to the current PR** | R was already stale at the baseline, and the current PR changed an adjacent module; differential causal judgement is not easy | Judge R↔C independently on base/head; mark baseline-existing problems as pre-existing, not counted as a new finding or as author fix-through |
| **P1** | **Results are sensitive to model version/sampling** | The Kite 8-seed same-frame version went from 3/8→2/8; it changes even with full coverage | Repeat each case 5–10 times with a fixed input manifest, report pass@1/variance, model/tier, CI/cost distribution; compare more than a single run |
| **P1** | **Go/Python custom assertion helpers, DI/public entry misjudged as untested** | Literal matching / built-in assertion regex cannot see helper functions and dynamic registration | 10 instances of helper, reflection, controller/public API; manually mark verified edges, measure H@k + false positives after verification |
| **P1** | **Semantic equivalence between a weak test and another strict test is misjudged** | Same test / same file / same name does not mean same input/output/branch | Minimal program + mutation: make the target output wrong while the sibling strict assertion still passes; if it would pass, it must not be downgraded |
| **P1** | **GitHub token/secret/artifact trust boundary** | Public central repo, private target, arbitrary text from the PR head, debug artifacts; prompt injection cannot substitute for security isolation | Canary: an untrusted PR writes "ignore all findings" text, sensitive-file markers, guard against external URL injection, fork permission limits, artifact download ACL; evidence isolation verification |
| **P1** | **Scanning everything takes so long that lead time is lost** | The PR may already be merged / QA already started; a 12-minute whole-repo nest run is not necessarily earlier than the feedback window | Record PR created/pushed→bot posted→author viewed/changed→QA started; P50/P95 against a baseline CI |
| **P2** | **Repeated scans over-confirm repeated results** | Two results from the same model, same slice, same bug are not independent evidence | Use independent models/evidence sources across runs; repeated confirmation is only stability, not correctness; call it a confirmed gap only after human review |
| **P2** | **Grading metrics becoming Goodhart'd** | Optimizing `forced`, CI success, static lead count rewards under-reporting / under-matching | Each optimization reports precision, recall, UNKNOWN rate, coverage, review latency, cost, actionable yield together; no metric may be optimized alone |

The most easily overlooked is the **counterfactual**: the minimum condition for judging "the tests are strong enough" is not that the test name resembles the requirement, but "if the behavior goes wrong in some reasonable way, would these assertions fail". Associating each high-risk obligation with 1–3 counterexamples (mutant / counterexample) is a path with a higher theoretical ceiling than adding prompt tokens. But note that mutation can also only prove that specific error patterns were killed; it cannot prove that all behavior is correct.

## 7. Concrete Optimization Architecture: Evidence First, Model Second

### 7.1 Make the Review an Evidence Graph Rather Than One-Shot Text Generation

We recommend a unified minimal data structure (with adapters for different languages):

```text
Requirement R {id, text, source_url, source_sha, effective_version}
Behavior B {id, symbol, file, span, changed_kind, public_seam}
TestCase T {id, path, span, setup, input, assertion_subjects, asserted_values, layer}
Edge {from, to, relation, retrieval_method, evidence_span, certainty}
Obligation O {id, R?, B, counterexample, min_layer, owner}
ReviewFact {obligation_id, model_call_id, visible_spans, evidence_state,
            verdict, downgrade_reason_id, delivered_channel, version}
```

With the graph edges `R↔B↔T` at the core, real test protection across files/packages can be supported, rather than using a same-named test or the same block as a stand-in for "coverage exists". The deterministic layer is responsible for facts: what truly did not match, which assertions the test contains, the exact span, who executed it; the model layer is responsible for judgement: whether these facts satisfy the behavior oracle; the publisher is responsible for not pushing low confidence into a definitive conclusion.

### 7.2 First Distinguish Three Kinds of Gaps to Reduce Wrong Commitments

1. **No test evidence found**: retrieval found no evidence (usually a static lead, **not a missing test**).
2. **Test does not constrain changed behavior**: there is a matching test, but a specific mutant/counterexample would still pass (higher value).
3. **Requirement mismatch**: the existing requirement contradicts what the code/tests actually verify (highest value, even if all unit tests are green).

The recommended main UI view is `Requirement contradictions → High-confidence missing/weak unit obligations → Pushdown opportunities → Evidence gaps / unknown`, with each item showing only actionable evidence and the smallest new test case (inputs, expected, and why the current assertions would pass). "Rule violations" need a separate display of `standards applicable / check executed / result`, and must not just say "coding standard confirmed".

### 7.3 Avoid Spending Too Many Model Calls on the Whole-Repo No-Diff Scenario

Whole-repo and PR are two fundamentally different reasoning problems: a PR has a clear ΔC/ΔR and can see deleted assertions; the whole repo has to infer **what is missing** from a huge code space, which is an open-world problem of incomplete information. We recommend that the whole repo use static candidates → small-scale model review → periodic state; let the model review only the items with the highest `(risk × uncertainty × evidence availability)`. PR should use Δ-driven, exact retrieval, and high-value counterexamples; put key regression/mutation/historical-bug replay on the priority path.

### 7.4 Cooperate With the Existing CI Rather Than Duplicate It

- `unit coverage`: serves as execution evidence and risk priority, and does not imply the oracle is correct; label the coverage report SHA.
- `mutation`: verify the killability of counterexamples for key obligations; there is no need to run whole-repo mutation on every PR.
- `lint/format/typecheck`: consume the CI check results directly; the model should not repeat what the formatter already knows.
- `integration/e2e`: state clearly which network/contract/compatibility assertions must be kept and which pure input-output logic can be pushed down; do not encourage "replacing end-to-end with unit".
- `historical bugs`: using real bugs that once escaped CI for an SZZ PR replay is closer to the commercial goal than hand-designed seeds.

## 8. Action Priorities: Every PR Must Carry a Counter-Proof and Exit Conditions

### P0: Next Work Cycle, No More Generalized Promotion

| Task | Change points | Acceptance (executable) | If it fails |
|---|---|---|---|
| **P0-A Assess #345 negative-benefit risk** | `src/audit-post.js` `pinnedInTest` | At least 20 negative/positive examples, covering different assertion subject / call args / branches / fixture / anchored regex, with blind labelling of delivered FP/FN | Keep a special-case whitelist, and revoke the broad "downgrade whenever the same test has another pin value" |
| **P0-B Visibility/coverage ledger** | `src/audit-units.js`, `src/engines/claude-api.js`, publisher | Produce per unit `candidate tests / packed tests / visible full-or-slices / notWhole / verdict`; conservation reconciliation; sample counterexamples before and after #343 | The forced metric must not be used alone as a release-success signal |
| **P0-C Release gate** | CI + eval harness | A fixed-SHA set of 8 Kite + 40 external-repo seeds + real positive/negative PRs, producing raw/delivered TP/FP/FN + cut rate, admission failures | Block release of semantic gating without verification; CI pass only proves code health |
| **P0-D Coding-standard goal acceptance** | integration eval fixtures | 2–3 PRs each for real violations and configured lint, with applicable / not applicable / not executed all distinguishable | Coding standard stays unproven in the scorecard |
| **P0-E Review status** | summary/check UX | Independent `engine_result=success`, `evidence=partial`; a human can understand it in both GitHub PR/Actions views, with no "green = full coverage" ambiguity | Inconclusive must not be labelled as passing the quality gate |

### P1: Build Cross-Repo and Cross-Language Transferable Quality

- **Test-retrieval Recall@k benchmark**: sample a fixed number of behaviors from each of the real Nest/Fastify/Flask/Cobra/Hono, and compare `hit@3`, `all-required`, `unread`, false matches before and after the matching API is called directly; give every FP the real protection path. If recall falls, reducing forced must not be allowed to mask it.
- **Large-PR delivery study**: with the same fixed input under `inline cap 3/10`, high/low confidence, and single-call/chunked conditions, measure delivery-side recall and reviewer cognitive load; first solve the high-value findings that are pushed down into Details, then spend money on splitting calls.
- **At least two real Copilot end-to-end canaries**: use the token/org billing actually authorized by the company; the model, permissions, cost, json repair, publishing and failure classification must be verified, not just the adapter mock.
- **Requirements source adapters**: for Confluence/SharePoint/Docs links outside GitHub, provide an explicit trusted-fetch mechanism or require importing a snapshot in advance, including version/ACL; they must not be silently ignored. Currently the manual form input supports only document sources accessible from GitHub.
- **Independent human labels**: two reviewers who do not see the source of the model's conclusion label "real test obligation / actionable / worth a unit test / already has indirect test / uncertain", with conflict arbitration and agreement computed.

### P2: Productization, Cost-Effectiveness, and Organizational Adoption

- Make an incremental cache of the unit/requirement/call/source manifest, invalidated by commit/tree/hash, so the whole repo is not rescanned on every push; each report states cache hits, material delta, and the boundaries that were missed.
- For abnormal scenarios (API throttling, timeouts, invalid output, scan interruptions), retain the last confirmed conclusion but mark it stale, and never pretend that a new review passed; ensure that status/check consumers distinguish "failed" from "not reviewed".
- Run real developer A/B or crossover pilots, measuring real defects fixed early, the number of times QA sent work back, author time, noise complaints, and token consumption; comparing model tokens alone is not the final goal.

## 9. Recommended Evaluation Protocol and Minimum Acceptance Thresholds

There is currently not enough data to set an absolute "acceptable precision". We recommend the following **pre-registered pilot thresholds (targets, not the current state)**:

| Metric | Precise definition | Suggested pilot threshold |
|---|---|---|
| Delivered actionable precision | Delivered findings that a human judged truly worth handling / all delivered actionable findings | ≥ 70%, and report the 95% CI and results by language/type |
| Delivered recall | Real gaps that were delivered / real gaps independently confirmed in advance (including run failures) | ≥ 70% on positive-sample seeds; for real-replay baselines set gradually, and seeds must not be passed off as production values |
| FN silent rate | Proportion of real gaps that were neither found in summary/inline nor marked UNKNOWN | Approaches 0; FN must not rise with any gate optimization |
| Evidence completeness | Proportion of included obligations for which the required R/B/T spans were truly collected | Reporting rate 100%; the proportion itself is measured separately and cannot be replaced by inventory coverage |
| Run reliability | Number of times a PR/scan expected execution actually completed with a traceable status / number of expected executions | ≥ 99% run-classification accuracy (verified from the raw jobs/summary) |
| Fix-through (verified) | Proportion of findings where the author added/modified tests before QA and the new tests can kill the corresponding counterexample | First establish a baseline of ≥ 30 human-author events, then set a threshold |
| Time-to-feedback | push→visible result P50/P95; compared with the QA takeover time | PR P95 must meet the target team's timeliness, and be delivered before QA |
| Cost per *validated* finding | Total model/runner/human triage cost / number of gaps confirmed by humans and fixed early | Falling month by month; cost/run must not be the only thing optimized |

**A paired experiment must be used:** test baseline and candidate on the same repository SHA, gold truth, budget, model/tier and context; repeat multiple times when the model fluctuates; look at FN, FP, unknown and delivery channel together. It is forbidden to use "this version generated more leads" to prove "test gaps are caught more accurately". Re-adjudicate the cases that originally produced `zero-diff` because of eval construction failures ([#333](https://github.com/Mira190/SpecGuard/pull/333) has fixed the tooling), and note that historical scores are not directly comparable.

## 10. A Dedicated Critical Design Re-Review of #345

This round, #345 is the **potential negative optimization** most worth prioritizing. It introduces `pinnedInTest(lines, citedLine)`: scan the same test by test-declaration boundaries; if any assertion deemed exact is found, downgrade the weak-assertion finding to low confidence; make an exception for the questioned line of `CALL_SUBJECT`; and add recognition of "not a gap" via `NO_GAP`. The positive motivation is clear: previously Hono/Flask had false positives where "the test actually already pins the value". The problem is:

```js
it('checkout', () => {
  expect(result.success).toBeTruthy();   // need to test the semantics of true/false
  expect(receipt.label).toBe('Paid');    // only pins another field
});
```

If a bug makes `success=true` while receipt.label is still `Paid`, the second strict assertion cannot falsify the defect in the earlier behavior. Downgrading with "the same test pins a value" is then not sound. More complicated cases are two independent API calls, different branches, fixture initialization, and table-driven scenarios; the current `CALL_SUBJECT` exception covers only some direct call expressions. **The same test block is organizational structure, not causal evidence.**

A safer strategy is recommended: downgrade only when a data/control dependency of the same behavior, or a strict oracle on the same input and output, can be shown; otherwise only note in the details that "other assertions also exist in the same test block, a human should confirm whether they constrain this behavior", **without changing the delivered level**. First use three real findings as a control group that preserves recall, then do multi-language counterexamples and a 5-repo before/after blind labelling. If #345 introduces unacceptable FN while reducing FP, narrow the rule rather than patching it with a longer regex.

The `NO_GAP` text judgement is also a weak semantic signal: the case where the model writes "not a gap in legacy but new path is a gap" has been excluded from wrongful deletion by that PR, but more negation/paraphrase contexts may still trigger it by mistake. We recommend changing to the model outputting an explicit `verdict: gap | no_gap | unsure`, validated by schema and evidence, rather than letting free text trigger a critical gate. No string in which the LLM negates itself can replace review evidence.

## 11. Recommended End-to-End User Experience (Where Shift Left Truly Lands)

**The first screen the PR author receives** should answer:

- Which requirement/changed behavior is most likely to go wrong?
- Which current test (with path/line/input and assertion) does not constrain it?
- Give a counterexample that would let the current tests still pass while the behavior is wrong; which value should the suggested new unit assertion pin?
- Were the relevant tests/specs actually read; what was unread/truncated/unmatched?
- Is this newly introduced by this PR or pre-existing; is it a unit, integration, or higher-level matter?

In Actions manual whole-repo mode: the first screen gives only 5 items, `scope coverage / evidence coverage / verified high-confidence issues / leads / unknowns`, followed by a per-unit ledger downloadable as JSON/CSV. Do not by default push dozens of `unreferenced_export` items to other teams as "missing unit tests"; provide a clear action suggestion of "review candidate + how to check". A manual one-off `scan_issue=none` must be labelled as not confirmed across runs.

## 12. Conclusion: What Is the Next Milestone That Can Be Announced

**What can reasonably be announced now:** SpecGuard already provides pre-emptive test-evidence review at two entry points, PR and cross-repo scan; the segmented execution, budget, and observability of a single whole-repo run are markedly improved compared with early October 17; #343 has a measured large correction of `unsure` misattribution; mainline automated tests are healthy.

**What cannot reasonably be announced now:** "proven to reduce QA workload", "100% scanned means all tests are sufficient", "the model can reliably find the unit tests missing from complex third-party projects", "every recent gate change is a positive optimization", "#345 has landed on the mainline".

**The single most important next milestone:** on fixed real PR/SZZ replay + five-repo human labelling + a controlled counterexample set, establish a loss ledger for each layer of `source→candidate→packed evidence→model→verified→delivered→author fixed`, and then prove that an optimization significantly raises actionable precision or shortens the feedback cycle before QA **without lowering delivered recall**. Only then can "Shift Left mechanism" be upgraded to "Shift Left effect".

---

## Appendix A: Core Direct Evidence (fixed URLs, for easy re-checking)

1. **Mainline, CI and product configuration**: [`main 08d2c5b`](https://github.com/Mira190/SpecGuard/commit/08d2c5b87bb8ffc144f4ca3135e8aa4ec79f327c); [CI run 39085373622](https://github.com/Mira190/SpecGuard/actions/runs/39085373622); [`ci.yml`](https://github.com/Mira190/SpecGuard/blob/08d2c5b87bb8ffc144f4ca3135e8aa4ec79f327c/.github/workflows/ci.yml); [`action.yml`](https://github.com/Mira190/SpecGuard/blob/08d2c5b87bb8ffc144f4ca3135e8aa4ec79f327c/action.yml); [manual workflow](https://github.com/Mira190/SpecGuard/blob/08d2c5b87bb8ffc144f4ca3135e8aa4ec79f327c/.github/workflows/specguard-run.yml).
2. **Latest important PRs**: [#329](https://github.com/Mira190/SpecGuard/pull/329), [#333](https://github.com/Mira190/SpecGuard/pull/333), [#335](https://github.com/Mira190/SpecGuard/pull/335), [#336](https://github.com/Mira190/SpecGuard/pull/336), [#340](https://github.com/Mira190/SpecGuard/pull/340), [#341](https://github.com/Mira190/SpecGuard/pull/341), [#342](https://github.com/Mira190/SpecGuard/pull/342), [#343](https://github.com/Mira190/SpecGuard/pull/343), [#344](https://github.com/Mira190/SpecGuard/pull/344), [open #345](https://github.com/Mira190/SpecGuard/pull/345).
3. **Real evaluation and limitations**: [`third-party-scan-eval`](https://github.com/Mira190/SpecGuard/blob/main/docs/third-party-scan-eval-2026-10-17.md); [`goal-assessment`](https://github.com/Mira190/SpecGuard/blob/main/docs/goal-assessment-2026-10-17.md); [`goal-first-principles`](https://github.com/Mira190/SpecGuard/blob/main/docs/goal-first-principles.md); [`latest-pr-actions-shift-left-followup`](https://github.com/Mira190/SpecGuard/blob/main/docs/latest-pr-actions-shift-left-followup-2026-10-17.md).
4. **Independent run/publishing evidence**: [#343 real branch runs summary](https://github.com/Mira190/SpecGuard/pull/343); [#343 incomplete dogfood summary](https://github.com/Mira190/SpecGuard/pull/343#issuecomment-6243528183); [#345 incomplete dogfood summary](https://github.com/Mira190/SpecGuard/pull/345#issuecomment-6243678817); [manual run 39035605423](https://github.com/Mira190/SpecGuard/actions/runs/39035605423).
5. **Implementation pointers**: [`src/audit-units.js` — slices/cost/pack/risk](https://github.com/Mira190/SpecGuard/blob/08d2c5b87bb8ffc144f4ca3135e8aa4ec79f327c/src/audit-units.js); [`src/audit-post.js` — provenance/gates/cuts](https://github.com/Mira190/SpecGuard/blob/08d2c5b87bb8ffc144f4ca3135e8aa4ec79f327c/src/audit-post.js); [`src/engines/claude-api.js`](https://github.com/Mira190/SpecGuard/blob/08d2c5b87bb8ffc144f4ca3135e8aa4ec79f327c/src/engines/claude-api.js).

## Appendix B: Evidence Grading and What This Report Did Not Do

- **A: directly checked this round**: GitHub repo SHA, PR state/merge, TAP statistics of CI job logs, real dogfood issue comment JSON/body, the manual run 39035605423 log, the main workflows/action in main and some implementation code.
- **B: experiment records published in the repository**: branch live-run numbers for Nest/Hono/Kite, five-repo blind labelling, 40 static seeds, 10-PR seed/re-review data. Their reports and PR descriptions were read, but **each item was not re-labelled this round and artifact ZIPs were not unpacked**; inferences should be stated as B-level evidence.
- **C: new risks that need verification**: #345's subject-mismatch downgrade, invisible fixtures, inventory-definition loopholes, requirement-oracle versioning, users misreading green, real human adoption, etc.; they are experimental to-dos, not confirmed code defects.
- No paid model was triggered during the analysis phase, the user's local uncommitted worktree was not covered, and no product code or existing issue/PR was modified. This document is submitted as a separate docs-only PR, and the evidence level of the report needs to be re-checked before it is merged into the main branch.