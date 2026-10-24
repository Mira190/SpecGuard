# Repository Shift-left Analysis Report

> Template: every `To be filled in` and empty value must be replaced or explicitly marked unknown. Do not leave illustrative numbers in place as measurement results. The fields in this template are reporting conventions, not the current SpecGuard schema.

## 1. Conclusion and top-priority actions

The most valuable early intervention in this repository: fill in the specific behavior, consequence, and evidence. Confirmed findings, candidate risks, and unknowns are listed separately.

| Priority | Behavior/requirement | User or business consequence | Evidence level | Minimal action | Owner | Acceptance |
|---|---|---|---|---|---|---|
| To fill | To fill | To fill | Static/execution/targeted-fault validation | To fill | To fill | To fill |

Scope conclusion of this report: fill in an accurate statement such as "scoped static review complete / partially complete / execution validation partially complete". When no gaps are reported, state explicitly which scopes remain unverified, and do not use "whole repository safe / complete coverage".

## 2. Identity and reproducibility conditions

| Item | Value |
|---|---|
| Repository and visibility | To be filled in |
| Report audience and artifact location | To be filled in |
| Requested ref / resolved SHA | To be filled in |
| PR base/head or scan snapshot | To be filled in |
| Scope, include and exclude configuration | To be filled in |
| Run / attempt / campaign ID | To be filled in |
| SpecGuard Action SHA / build | To be filled in |
| Engine, requested/actual model | To be filled in |
| Prompt/schema/config version | To be filled in |
| Run time, environment, budget | To be filled in |
| Whether target code was executed | No/Yes, commands and isolated environment |
| Execution / scope / strength / delivery status | Fill in each |

## 3. Assets, scope, and unsupported items

| File inclusion decision (mutually exclusive) | Count | Reason/artifact |
|---|---|---|
| Included | To be filled in | To be filled in |
| Excluded | To be filled in | Include specific boundaries such as generated/config/migration |
| Unsupported | To be filled in | Language/file type and importance |
| Unreadable | To be filled in | Permissions, encoding, size, etc. |
| Unclassified | To be filled in | Must not be silently dropped |
| Tracked total | To be filled in | Check against the totals above |

Roles can be multiple: source/test/requirement/rule/config; do not add up role counts as the total file count.

| Behavior task status (deduplicated for this snapshot) | Count | Scope read / evidence and next step |
|---|---|---|
| Reviewed | To be filled in | To be filled in |
| Unknown | To be filled in | Which information is missing, who can supply it |
| Pending / running | Fill in separately | To be filled in |
| Deferred / failed | Fill in separately | Reason, next action |

Submodules, LFS, external requirements, cross-repo implementations, runtime configuration, unexpanded dependencies: to be filled in. Age of long-unreviewed items and actual progress this round: to be filled in.

## 4. Four-axis conclusion on the original goal

| Axis | Status and evidence | Main gaps | Limits |
|---|---|---|---|
| Requirements and acceptance criteria | Source, version, conflicts, whether inferred only | To be filled in | Mark unknown when there is no independent requirement |
| Unit-test protection | Public behavior, boundaries, error paths, effective assertions | To be filled in | Keep static references and execution separate |
| Coding standard | Applicable rules and the exact SHA/result of configured checks | To be filled in | not configured/pending/unavailable does not count as passing |
| Test level | Existing unit/component/integration/E2E responsibilities | To be filled in | Explain separately what can be pushed down and which integration checks are necessary |

## 5. Per-item findings

### F-To be filled in: specific error or behavior gap

- **Ownership:** introduced by this PR / existing debt / intent to be confirmed; state the basis.
- **Behavior and impact:** who is affected, under which input, boundary, exception, or state.
- **Independent requirement:** source, revision, short quote of the original text, applicable version, and owner; state explicitly if none.
- **Implementation references:** exact repo/SHA/path/line numbers, minimal original text.
- **Existing tests:** scope searched, relevant assertions, level, alternative protection, and unread locations.
- **Concrete counterexample:** which wrong behavior the current assertions still accept; or which requirement expectation the implementation violates.
- **Verified:** write separately what the references, static logic, run, and targeted-fault discrimination verified.
- **Not verified:** limits such as external implementations, configuration, execution environment, oracle.
- **Recommendation:** minimal test/implementation/spec correction and the integration checks that should be kept.
- **Validation:** runnable commands, baseline/candidate, expected success and failure; state explicitly if not executed.
- **Owner and decision:** to be filled in.
- **Artifacts/trace:** accessible evidence references; do not paste secrets or unnecessary sensitive original text.

## 6. Requirement to behavior to protection matrix

| Requirement ID/version | Public behavior and input/expectation | Implementation | Tests and assertions | Level | Executed version/result | Alignment/protection status | Limits |
|---|---|---|---|---|---|---|---|
| To be filled in | To be filled in | To be filled in | To be filled in | To be filled in | Not executed/execution result | Fill in separately | To be filled in |

One requirement may have multiple obligations; a single test cannot be taken to cover a compound requirement. The statistics denominator comes from an explicit scope and does not shrink when the model outputs less.

## 7. Rules and execution checks

| Rule source/applicable path | Check method | Check producer / SHA | Actual status | Conclusion |
|---|---|---|---|---|
| To be filled in | AI rule review / existing lint, etc. | To be filled in | To be filled in | To be filled in |

## 8. Test levels and push-down plan

| Rule/scenario | Current higher-level test responsibility | Public unit seam that can be asserted independently | Integration protection that must be kept | Same-fault-set comparison | Benefit/cost |
|---|---|---|---|---|---|
| To be filled in | To be filled in | To be filled in or not suitable | To be filled in | Not executed/result | To be filled in |

Benefit is not proven by the number of new unit tests, and pushing down must not introduce excessive mocking of private implementation.

## 9. Observation and diagnostics

| Metric/question | Result | Denominator, time window, evidence |
|---|---|---|
| Latency to first actionable feedback | To be filled in | Includes queueing; undelivered listed separately |
| Collection/pack/model/validation/delivery time | To be filled in | To be filled in |
| Truncation, unreadable, budget deferral, failures and retries | To be filled in | To be filled in |
| Candidate → validated → delivered, deduplicated by behavior | To be filled in | All inline/summary outlets |
| Human valid/invalid/unsure | To be filled in | Sample and adjudication method |
| Model/runner cost, human time | To be filled in | All attempts; distinguish estimates from bills |
| Whether trace/event/artifact is complete | To be filled in | Missing must not be treated as zero events |

Most important false positives and false negatives and the stage where they failed: to be filled in.

## 10. Author handling, protection strengthening, and QA feedback

| Independent behavior ID | Human validity | Decision/fix commit | Only changed later or verified | Corresponding counterexample/fault execution result | Completed before QA handoff? | Later escapes |
|---|---|---|---|---|---|---|
| To be filled in | To be filled in | To be filled in | To be filled in | To be filled in | Unknown/Yes/No | Observation window and result |

No longer observed, dismissed, and thread-closed are listed separately and are not equivalent to fixed. Historical replay direct/indirect/miss is kept separate from effective on-site interventions; without a control, no causal defect reduction is claimed.

## 11. Next batch and stop conditions

- Next behaviors to review, scope, and prioritization basis: to be filled in.
- Missing requirements, permissions, language adaptation, or run artifacts: to be filled in.
- Owner, budget, expected check window: to be filled in; do not fabricate dates when unknown.
- When to narrow scope / stop delivering a category of suggestions: to be filled in.

## 12. Artifacts and rerun record

List the manifest, scope ledger, evidence, validated findings, run events, validation results, commands, and environment actually used. Mark files that were not generated as missing; pin external code references to a SHA; the report copy and the original code follow the same audience boundary.

Report author/reviewer: to be filled in. Data cutoff and incomplete validation: to be filled in.
