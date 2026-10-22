# SpecGuard: how to ensure shift-left and deliver the most value

Date: 2026-10-16 (Australia/Sydney). Local code baseline: `b1aaf113aae3ca69fcc70e7b9026130affa6c30f`.

This document follows on from the [October 15 handoff](handoff-2026-10-15.md) and the [critical follow-up review](critical-shift-left-followup-2026-10-15.md), and analyzes the product and validation strategy for the next phase. It is based on local code and existing evaluation and research documents; it did not re-read live state, run paid models, or run a human pilot. "Already in place" below means the corresponding path exists in the code; historical results are still limited by the version and sample at the time. Suggestions and goals do not represent the current implementation or measured benefits.

## 1. Core judgment

**To ensure shift-left, "finding earlier" must be connected to "taking effective action earlier", and then it must be verified that the change handed to QA really received additional protection.** Merely putting a bot on the PR, adding comments, or raising the proportion of static coverage is not enough to show this.

What can be guaranteed is process execution, evidence boundaries, and traceable results; static AI review cannot guarantee finding all defects. Whether it really reduces QA rework needs to be verified by later observation.

The direction most worth investing in for SpecGuard is to find, beyond normal CI and human review, verification gaps related to requirements and observable behavior, and to let the author complete verifiable corrections before delivery. In particular, attention should go to: code and tests deviating from the requirement together, boundary assertions being deleted, error paths left unprotected, and tests that look present but do not constrain wrong behavior.

The next phase is recommended to proceed in this order:

1. Protect the credibility of conclusions: insufficient input must not become "covered", and syntactic clues must not become semantic proof.
2. Turn the existing per-push PR review into actionable author feedback; keep an optional local entry point so people who want to check earlier get results earlier.
3. For a small number of high-value findings, verify that "after the fix, the corresponding error is really caught", proving the benefit of a single finding first.
4. Use real defect replay and a controlled pilot on human-authored PRs to verify the incremental value, and then decide which capabilities to extend.

The project's existing decision is "PR Action on every push, advisory only" (see [design.md](design.md)). This document keeps that decision; the local check is a supplementary entry point, and the thresholds below do not authorize automatically blocking merges.

## 2. Write the goal as a checkable end-to-end chain

```text
Requirements and changes available at PR time
  → Observable behavior and test obligations related to the change
  → Credible findings delivered while the author can still modify
  → Author confirms intent and adds tests, changes the implementation, or corrects the spec
  → Verify the new protection can distinguish correct from wrong behavior
  → The version handed to QA retains this protection
  → Defects escaping QA flow back and form the next round of evaluation samples
```

If any link breaks, the work before it may not have delivered value.

| Link | Question that must be answered | Failure signal |
|---|---|---|
| Intent | What should have been implemented at the time? Is the source conflicting, outdated, or only inferred? | Inferring the requirement from the implementation, then using the same implementation to prove itself correct |
| Search | Did the relevant implementation, tests, and specs enter the visible range? | Declaring missing tests when no candidate was found; still declaring full coverage after truncation |
| Judgment | Which input, boundary, or error path is not protected? | Only saying "suggest adding tests", with no specific acceptable error |
| Delivery | Did the author see it within a useful time and can they handle it? | The result appears only after handoff to QA, or the key finding is only in collapsed details |
| Action | Did a person confirm the intent and complete the relevant fix? | Any modification to a test file is recorded as a fix |
| Verification | Did the fix add the ability to distinguish the target error? | The new test shares the same wrong expectation as the implementation, or is never executed by CI at all |
| Outcome | Compared with the existing process, were escapes or rework reduced? | Calling comment adoption rate or seeded recall directly a decrease in QA defects |

The expected value of a single finding can be broken down as:

> Potential loss from the corresponding error × joint probability that the finding is valid, delivered in time, the author acts, and the action is effective − the cost of model, compute, and human handling.

This is a decision framework, not a score that can be computed precisely today. If it is decomposed into a product of probabilities, stepwise conditional probabilities must be used; interdependent observed proportions cannot be multiplied directly. Parameters that are currently unknown should be marked unknown, to avoid dressing them up as ROI with arbitrary weights.

## 3. Current capabilities and what is truly unfinished

| Capability | Local evidence and current state | Meaning for the next step |
|---|---|---|
| Pre-PR review | The [local entry point](../bin/specguard-local.js) reuses collect, prompt, Copilot, and post; it reviews only committed changes, advisory by default | An entry point already exists; no need to build an IDE platform first. It does not cover uncommitted edits; linked issues are unavailable offline, and the default body comes from commit messages |
| Continuous PR feedback | [collect](../src/collect.sh), [post](../src/post.js), and the Action already have collection, validation, delivery, and freshness paths | The process position has moved earlier; what needs measuring is whether feedback is timely and useful, rather than continuing to count runs |
| Static evidence and obligations | The [review contract](../skills/test-review/SKILL.md) requires requirement, behavior, assertion, layer, and limits; private helpers alone do not create obligations | Judge by behavior protection; do not turn internal function splitting into new test debt |
| Deleted-assertion clue | In this baseline `post.js` can already raise nearby low-confidence findings when the diff confirms a deletion, while keeping deterministic downgrades and the weak-test counterexample threshold | The open item in the handoff has code progress. A confirmed deletion still does not prove that no equivalent test exists in the whole repository, so cross-file migration controls should be kept |
| weak-test counterexample | `counterexampleOk` checks the concrete text form; the [prove harness](../eval/prove/README.md) can do execution verification within a limited Node test scope | A form check exists, but it still does not prove the counterexample is semantically correct; the execution-verification tool is also not a default Action capability |
| Large-file scan | [audit-units](../src/audit-units.js) shards at about 40 KB and saves a cursor; [contextPack](../src/engines/claude-api.js) is additionally limited by per-file and shared budgets | There is an honest incomplete status, but it cannot guarantee that every shard is eventually read; sustained progress needs to be measured |
| Standards confirmation | [checks](../src/checks.js) reads configured check/status; rule review is kept separate from execution status | The mechanism exists, but the standards positive/negative canary from the handoff and real pushdown benefits still need field evidence |
| Existing evaluations | The handoff records that Kite's latest round had 9/10 seeded targets visible; [field study](field-study.md) records 12 repositories and 333 deterministic collections | The former is single-round regression evidence on a specific old baseline, and the latter did not run a model; neither can prove this version's precision on humans or QA benefits |
| Value measurement tools | [replay](../eval/replay/README.md), [validation plan](validation-plan.md), label-export, and weekly-report already exist | Reuse first; fill in semantic adjudication and fix evidence, rather than building a new metrics platform first |

In particular, avoid using "F01–F18 all have fixes" in place of goal acceptance. The fixes make the system more credible, but the benefit also depends on requirement visibility, author action, and the tests' actual protective power.

## 4. How to really move checking earlier

### 4.1 When a requirement enters development, provide the minimum but sufficient intent

It is not required that every repository first build a complete spec library. For high-risk changes, the PR body or an existing issue should at least be able to answer:

- Which externally observable behavior changed, and who is affected?
- For a set of normal, boundary, and failing inputs, what is expected for each?
- How do the old and new rules switch, and does it depend on a version, a flag, or a later PR?
- Which requirement do the expected values come from, and who decides conflicts?

For example, "refund period changes from 30 days to 45 days" is still not enough to write correct boundary tests: whether day 45 is allowed, whether it counts from payment or from receipt, and whether it uses calendar days all need to be explicit. SpecGuard can point out these information gaps; the final intent is confirmed by the requirement owner.

**Without an independent requirement, one can only check the behavior the implementation exposes and the verification gaps; one cannot claim conformance to business intent on that basis.** The benefit of unclear requirements is earlier clarification, and it should be counted separately from confirmed defects.

### 4.2 After the author finishes a commit, provide optional local feedback

First promote the existing entry point; the documentation example is below, with the path replaced according to the actual clone:

```powershell
node C:/path/to/SpecGuard/bin/specguard-local.js --base origin/main --body C:/path/to/intent.md
```

This is a usage example and was not executed for this document. It calls Copilot and consumes quota; what it calls is a comparison of the committed branch against base, and `--body` supplies the requirement text at that time. `requirements_paths`, `standards_paths`, `test_paths`, and `ignore` in the workflow should be synced to the corresponding local parameters to reduce differences between the entry points.

The external context and check status differ somewhat between local and PR, so consistent output on both sides cannot be promised. To measure whether promotion is worthwhile, look at "how much earlier the first discovery of the same class of problem comes" and "how many PR round trips are avoided", and count local invocation cost in the total cost. There is currently no need to force an AI check into everyone's pre-commit.

### 4.3 The main path of PR on every push should let the author decide quickly

Keep the existing run decision, and first improve the effectiveness of feedback:

1. The first screen states the highest-value behavior gap, the related requirement, and the uncertainty.
2. Each suggestion provides the minimal input, the expected result, and the public behavior to protect; code skeletons follow the repository's existing test framework.
3. For the same behavior, implementation deviation, weak test, and missing test are explained together, so the author does not have to handle several duplicate tasks.
4. When context is missing, say what is missing and how to check next; do not write "cannot prove a test exists" as "proved no test exists".
5. After another push, distinguish still present, changed later, no longer observed, and verified fixed; the current proxy statuses keep their original meaning.

"Time to first actionable feedback p95 ≤ 5 minutes for ordinary small PRs" can first be taken as an experience goal to be calibrated; it is not a current performance result. Large PRs, model queueing, and incomplete reviews are reported separately, and slow samples cannot be dropped to meet the target.

### 4.4 At QA handoff, retain the known risks

The author carries, in the existing handoff process: confirmed but unhandled behavior risks, requirement ambiguities, unreviewed scope, and newly added regression tests. SpecGuard's static results guide QA's attention, while normal unit, integration, and end-to-end CI continue to provide execution evidence.

SpecGuard is not required here to build a new release gate. First confirm manually whether this information is useful; if nobody uses it, adding a report page will not automatically bring value.

## 5. Put resources where the marginal return is highest

### 5.1 Rank by error consequence and actionability

| Scenario | Potential incremental value | Conditions for it to hold | Priority |
|---|---|---|---|
| CI is green, but the code and tests deviate from a clear requirement together | Introduces an independent oracle that may find errors existing tests cannot | The requirement really applies to the current version, and source conflicts are resolved | High |
| Boundary, rejection, or error-path assertions are deleted | Preserves the original protection during test refactoring | Look for equivalent replacements; distinguish migration from true deletion | High |
| A new business branch has no behavior assertion | Proposes a concrete regression scenario before QA first finds it | Relevant candidate tests were seen, and the actual error can be described | High |
| A weak assertion still accepts a specific error | Makes the new assertion really constrain wrong behavior | The counterexample is correct; a test cannot be judged weak merely from forms like `assert.ok` | High, but needs stronger verification |
| Only a high-level test protects a business rule that can be judged independently | May shorten localization and feedback time | The same fault set can be preserved, and necessary integration checks are kept | Advance conditionally |
| The same problem is already clearly reported by lint/test CI | The increment is usually in explanation and localization | Provides more actionable information than the existing error message | Lower |
| Style suggestions without behavior risk, direct tests of private helpers | Easily consumes reading and maintenance time | Worth reporting only with a clear repository rule or provable behavior risk | Lowest |

"CI green" does not mean no value, and "CI red" does not mean the review can be skipped; what is decided here is the priority of the limited reading and verification budget.

### 5.2 Use two axes to judge requirements and tests, to prevent false reassurance

| Requirement alignment | Test protection | Conclusion to convey |
|---|---|---|
| Aligned | Valid behavior assertions exist | There is static support; whether it runs and passes depends on the corresponding CI |
| Not aligned | Tests and implementation agree with each other | First clarify or correct the requirement deviation; do not be reassured because tests pass |
| Aligned | No assertion, or the assertion does not constrain the target error | Add protection for the target behavior |
| Unknown or conflicting | Any | State clearly that the intent awaits confirmation; do not rule in place of the owner |

This is an analysis model and does not require adding a schema now. The key is that the existing `covered`, alignment, and report wording stay consistent.

For example, if the requirement clearly says "a refund is allowed on day 45", the implementation is written as `< 45`, and the test also asserts that day 45 is rejected: CI can be entirely green. The effective handling is to add independent expectations for `44/45/46` according to the requirement and fix the implementation, rather than adding just one more test that follows the current implementation.

### 5.3 Accept the three original goals separately

- **Missing or weak unit tests:** Verify that the new tests can protect the target behavior, rather than just increasing the number of tests.
- **coding standard confirmed:** Report separately the applicable rules, whether the AI reviewed them, the configured execution checks, and their corresponding SHAs. `not_configured`, `pending`, unreadable, and same-name producer conflicts must not become a pass. First add the standards-violation positive example and clean negative example still missing from the handoff.
- **Pushing high-level tests down:** Choose one pure business rule already protected by a slow high-level test, and compare using the same inputs and fault set. Record detection ability, elapsed time, and maintenance burden; keep the checks that originally protected network, database, or integration wiring. "The number of unit tests increased" alone does not count as a benefit.

## 6. Treat credibility as a standing invariant

The following principles apply to local, PR, scan, reports, and the grader, and cannot hold at only one entry point:

| Invariant | How to verify |
|---|---|
| Less information does not raise confidence | After deleting relevant test context, truncating source, or corrupting a reference, it must not upgrade from unknown to covered, and must not silently shrink the obligation set |
| Irrelevant information does not erase real risk | Adding unused arrays, comments, imports, and dead code should not wipe out the behavior protection that was truly deleted |
| Equivalent organization does not add test debt | For behavior-equivalent controls such as helper inlining/extraction, test parameterization, renaming, and cross-file migration, the conclusion should be stable |
| Static evidence is separate from execution proof | Reference exists, assertion form is reasonable, test is executed, and test can find the target error are recorded separately and cannot substitute for each other |
| Stale evidence does not inherit credit for a new version | If the requirement, source, test, base/head, or available external intent changed, the original conclusion must be invalidated by relevance or rechecked |
| Output identity and status do not drift | The same behavior is counted once across inline/summary; execution, scope, and reduced are each reported with a clear definition |
| Incomplete scans make progress or clearly stall | Repeated runs on the same tree with the same budget gradually consume the to-be-reviewed scope; if it can never fit, report the reason, and do not feign progress through repeated scheduling |

Recent code should prioritize two points:

1. **Budget coordination:** Scan's shards of about 40 KB do not necessarily satisfy the context pack's actual per-file quota. Shard size or per-batch count should be decided from the actual budget, and it should be verified that the cursor advances only after the content has really been reviewed. This is a real gap the handoff still points out.
2. **Semantic calibration:** `counterexampleOk` only proves the counterexample is written concretely, not that the counterexample holds. For weak-test samples judged useful, calibrate with human checking or limited execution proof; there is no need to immediately make every finding run an expensive second model or mutation testing.

"Deletion confirmed by diff" is likewise only a local fact: another file may already have equivalent protection. Adding positive and negative controls for this point is more meaningful than continuing to raise the confidence of all deletion clues.

## 7. Build the minimal effective fix loop

### 7.1 Distinguish states with evidence

The following is the wording for pilot adjudication; it does not mean the code already has corresponding fields:

| State | Minimum evidence | What it shows |
|---|---|---|
| Delivered | An inline comment or first-screen summary the author can actually see | The feedback can be used |
| Confirmed valid | A person confirmed the target behavior, the requirement, and the original protection gap | The finding is worth handling |
| Later changes | Relevant lines or test files changed | Only a proxy signal of action |
| Verified protection strengthened | The relevant new test runs and can distinguish the target error; intent is verified | The action added targeted protection |
| Defect exposed and fixed | A requirement-driven new test fails on the wrong implementation and passes after the fix | A specific defect was found and fixed before delivery |
| No longer observed | A later report does not have the same item | May be fixed, missed, or scope change; needs continued checking |

When a test is missing, the current implementation may already have been correct, so it cannot be uniformly required that the new test fail on the old HEAD. In that case, one can verify that it kills a reasonable target fault variant; if a newly added requirement test fails directly on HEAD, take the red-then-green defect-fix path.

The existing [prove harness](../eval/prove/README.md) can serve as a starting point for controlled-sample verification, but it supports only limited frameworks and fault variants, and killing all variants must not be taken as proof the test is sufficient. If the oracle is a mirror test derived from the implementation, independent requirement judgment is still needed.

### 7.2 First fill in the evidence with a manual table

Reuse the existing comments and export tools, and add the following fields by hand:

`repo/PR/head + behavior identifier + requirement source + first delivery time + manual validity + handler/decision + fix commit + verification command and result + corresponding fault or counterexample + whether completed before QA handoff`.

The behavior identifier is normalized by requirement and external behavior, and cannot use only line numbers; a change in display position or fingerprint does not mean a new independent benefit. The report on every push also must not count the same fix repeatedly.

The author handles implementation and tests; the requirement owner decides ambiguities and source conflicts; the QA lead adjudicates whether an escaped defect belongs to the same behavior; the pilot lead consolidates the definitions. One person can hold multiple roles, but every item needs someone responsible, and "needs a human" must not be treated as an endpoint with no owner.

Verification that executes PR code reuses the repository's existing isolated CI, and is not placed in the model review process that holds release credentials. A loop is proposed here, which does not change the Action's current static, read-only responsibility.

## 8. Which metrics show that the value has been delivered

### 8.1 Separate primary metrics from diagnostic metrics

| Metric | Definition and denominator | What cannot be claimed from it |
|---|---|---|
| Effective early interventions per 100 eligible PRs | Number of independent behaviors, completed before QA handoff, confirmed valid by a human and with target protection/defect-fix evidence / number of eligible PRs × 100 | Does not mean those PRs would certainly have had production defects |
| Historical early-detectability rate | In replay, direct and indirect hits / confirmed, in-scope historical defects that were visible at the time; the two classes listed separately | Cannot be taken directly as an on-site avoidance rate |
| Incremental valid findings | For the same PR, valid findings for which a human judges that existing CI/review gave no equivalent behavior hint | Non-overlapping line numbers do not prove semantic uniqueness |
| Lead time | The interval between the first actionable hint for the same behavior and the time the original QA found it; on site, also record whether the hint came before the actual handoff | Replay can only prove it could have been earlier, not that the author would have fixed it then |
| Escape trend | Within a consistent observation window, QA/production-confirmed defects stratified by change risk, against eligible PR count and behavior opportunity count | A simple before/after decrease cannot prove causation |

Eligible PRs are the target PR population that was agreed in advance to be considered for using the tool, defined before the output; failed, skipped, reduced, focused, and incomplete are kept as strata, and only successful runs must not be counted. AI-generated, human-written, and bot PRs are stratified, and seeded PRs without a human handler cannot be included in the human adoption rate.

"Behavior opportunity count" is defined by an independent manual list or fixed sampling, and the total number of obligations generated by the model this round is not used as the cross-version quality denominator; otherwise a model that lists fewer obligations would look better.

Also record guardrails:

- The manual precision, and the numbers of invalid and unsure; both inline and the first-screen summary count toward the user's reading burden, and collapsed information is listed separately.
- The p50/p95 of time to first actionable feedback, and the proportion that occurs within the author's effective modification window.
- Human reading and handling time per PR, review round trips, time-to-merge, and whether QA rework is reduced.
- All local invocations per PR, per push, fix retries, and amortized scan cost, not just the last run.
- The proportions of failed runs, unreviewed scope, duplicate findings, stale evidence, and long-term stalls on large files.

`addressed` or "with later changes" continue to serve as diagnostic signals. The existing [weekly report](../eval/weekly-report.js) mainly relies on these proxies, and the existing plan notes that some metrics include only inline and that cost takes only the last run; therefore it cannot be directly renamed as an effective fix rate or full-cycle cost.

### 8.2 Thresholds must distinguish their purposes

The existing documents have different contexts: the [validation plan](validation-plan.md) uses conditions such as 65% blind-test precision to decide whether the pilot is worth continuing; [design](design.md) mentions that only ≥80% would justify discussing blocking; the [traceability plan](traceability-plan.md) sets a stricter goal for requirement-type findings. They are not one and the same pass standard.

This document recommends:

1. Keep the original pilot pre-registered conditions, and report the new metrics separately, without changing the pass line after seeing the data.
2. For high-confidence first-screen findings, take manual precision ≥80% as the pilot optimization goal, and ≥90% for requirement contradictions as the stricter goal; report sample sizes and intervals. These are recommended goals, and missing them does not mean blocking CI; it means delivery should be narrowed or the judgment corrected.
3. Expanding to more repositories requires seeing more than isolated examples of effective early intervention, and meeting pre-agreed budgets for reading time, latency, and cost. When the sample is insufficient, record "not established".
4. Whether to block is an independent product decision. Reaching some precision does not automatically satisfy requirements such as execution proof, recoverability, and user authorization; for now it stays advisory.

## 9. Validation design: prove the mechanism first, then the increment, and finally look at outcomes

### 9.1 Historical replay must prevent future-information leakage

Reuse [SZZ and replay](../eval/replay/README.md): first confirm by hand the relationship between the defect and the introducing PR, then determine the scope before seeing the output. SZZ is candidate localization, and newly added omissions, refactors, and cross-commit behavior can all make it find the wrong thing.

The key constraint is to reconstruct the information **at the time of the PR**: the original base/head, the requirement version at the time, the body, and visible discussion. The later fix diff, issue updates that explain the cause, and future commits and their historical associations are shown only to the adjudicator, not to the reviewer. If the issue's content at that time cannot be restored, record it explicitly as missing or potentially contaminated; today's description must not be used silently.

Pair with clean PRs from the same window, and replay with the same version, model, budget, schema/skill, and available context. Report both how many of all confirmed defects are within the tool's scope, and the direct, indirect, and miss counts within scope; do not mix cross-service or runtime-environment defects into the recall denominator, and do not hide them to exaggerate overall coverage.

Report proportions and intervals per the existing rubric only once there are at least 30 in-scope defects; with fewer, report counts first. Public repositories may have training contamination, so internal samples are listed separately; replay results can only prove potential detection ability.

### 9.2 A human pilot measures "what it adds on top of the existing process"

Prefer repositories with real requirements, stable test CI, locatable QA defects, and people willing to adjudicate findings. Verify one suitable repository first, then extend to different languages and test shapes per the original S6 goal.

The existing [three-arm plan](validation-plan.md) can continue to be used, but `PR number mod 3` is a deterministic grouping and cannot be called a randomized trial directly. Check whether time, authors, teams, and risk are balanced. When using a historical no-AI baseline, confounding from people, business, and seasons must be kept in the conclusion.

If the question is "does SpecGuard add an increment beyond existing review tools", the existing process can be kept on all PRs, and a pre-fixed allocation can randomly decide whether to add SpecGuard; stratify by repository/risk, and record contamination from authors learning from each other. When the pilot design needs to change, fix the new plan first, and do not stitch the results of different plans into one causal estimate.

Human adjudication blind-labels valid/invalid/unsure by behavior semantics, looking at more context where needed. Compare semantically unique findings and effective early interventions, and estimate uncertainty clustered by PR; ten comments on one PR cannot be treated as ten independent samples.

In addition to the reported findings, independently sample and recheck PRs with zero findings, failures, and incomplete reviews, and look for omissions against the manual behavior list. Checking only what the bot said measures precision but cannot see silent omissions or a shrunken obligation denominator.

### 9.3 QA benefit needs lagged observation

2–4 weeks can verify the timeliness and validity of feedback and part of the fix loop, and is usually not enough to prove a decrease in escaped defects. Following the existing plan, recheck QA/production defects of the relevant PRs at 8–12 weeks; each PR uses the same maturity observation window, recording cases not yet released, not yet in QA, or with the observation unfinished.

Historical findings are added to the regression set afterwards; the evaluation set is kept separate from the tuning set. Real misses used to fix the prompt cannot at the same time continue to serve as benefit evidence from "unseen samples".

## 10. Suggested execution order and stop conditions

The following is the order of work; days are counted from when pilot conditions are actually in place, and are not a promise of automatic completion on the calendar.

| Stage | Minimum deliverable | Acceptance and decision |
|---|---|---|
| Working days 1–3: fix a credible baseline | Fix the full code SHA, model, and configuration; recheck deleted-assertion migration, weak-test counterexamples, and scan's actual budget; add a plan for standards positive/negative canaries | Fixed and unfixed items recorded separately; input degradation does not produce stronger conclusions; large files can advance or clearly stall |
| Working days 4–10: prove single-item benefit | Extract a batch of real high-value findings; the manual table records the independent oracle, handling, and verification; complete one real pushdown paired example | Show at least a protection strengthening or defect fix that can be rechecked; samples with only proxy changes do not count as an effective loop |
| Weeks 2–4: human incremental pilot | Reuse export, blind labeling, and the weekly report; additionally add first-screen summary, full-cycle cost, and effective intervention | Decide to continue or extend only after the predetermined sample and guardrails are met; if insufficient, report insufficient evidence |
| Weeks 8–12: escape recheck | Follow up on QA/production for the pilot PRs with the same maturity observation window | Report risk strata, control differences, and intervals; when attribution is not possible, keep the correlational conclusion |

The following stop or narrowing conditions are recommended to be agreed in advance:

- Findings are mainly duplicates of existing lint/CI: reduce delivery of this class and concentrate on requirement and behavior gaps.
- There are plenty of valid findings, but authors cannot handle them for a long time: check timing, ownership, and suggestion cost, and do not increase the number of findings first.
- Only the scan reports grow and effective pre-PR interventions do not: limit scan investment and first get the action loop working.
- Requirements are never available: narrow to behavior-verification review, keeping the true boundary of "requirement alignment unknown".
- At equal risk, handling cost and waiting time exceed the confirmable benefit: first narrow to high-value types or summary delivery, and re-verify.

The narrowing above is a future pilot decision and does not change this project's current per-push run commitment. Cross-team automatic notification, automatic assignment, automatic code changes, and blocking merges are not prerequisites for this round.

## 11. Evidence to deliver in the next phase

The greatest value can first be proven with a small auditable sample, without relying on a huge new platform:

1. Real cases on a fixed version: the requirement, the original protection gap, actual delivery, the author's decision, the fix, and execution evidence can be strung together.
2. Clean controls and a false-positive list: explain when not to comment, especially equivalent refactors, cross-file test migration, and source conflicts.
3. A pilot report using a unified denominator: distinguishing potential findings, human-valid, effective early interventions, and lagged escape results.
4. An investment decision: which findings are worth delivering first, which verifications are worth running, and which capabilities are not to be extended for now.

When the team can point out "this error under this requirement was found before handoff to QA and received actionable protection, and the existing process gave no equivalent hint", SpecGuard's shift-left value changes from a design claim into a verifiable fact. After that, judge the benefit at scale with controls and mature observation windows.

## 12. Basis and boundaries of this document

- Goals and existing decisions: [design.md](design.md).
- Fix history and field observations: [handoff-2026-10-15.md](handoff-2026-10-15.md), [critical-shift-left-followup-2026-10-15.md](critical-shift-left-followup-2026-10-15.md), [context completeness](review-context-completeness-2026-10-15.md). These are historical snapshots, distinguished from the current state by the local baseline declared in this document.
- Value validation plans and tools: [validation-plan.md](validation-plan.md), [replay rubric](../eval/replay/README.md), [prove harness](../eval/prove/README.md), [field study](field-study.md).
- This change only adds the strategy document and a README entry; it checks local links, diff format, and the key implementation basis, does not modify runtime logic, does not rerun the full engineering test suite, and does not claim historical results as new acceptance of this baseline.
