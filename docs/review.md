# Review of the SpecGuard GitHub Actions Summary

Subject of the review: [Kite — SpecGuard audit #10](https://github.com/Mira190/Kite/actions/runs/38510141042), 14 October 2026.

I have read this run's Job Log, the Workflow configuration, and the generated `summary.md` and analysis Artifact.

## I. Initial conclusion: it can find test risks, but it has not yet formed a complete Shift Left loop

What matters most in this run is not how many missing tests were found, but that the report's review scope, the credibility of its conclusions, and its recommended team actions are not yet well connected.

Execution overview for this run

Action succeeded

Unit Review actually completed

# 10 / 44

22.7% of code units

Unit Gaps this round

# 3

But one item in the report explicitly says no gap was found

Carried-over requirement gaps

# 12

From the continuing scan state; not re-verified in this round

Review failures this round

# 1 / 5

One batch of 20 requirement blocks was not analysed

The run used Claude Haiku 5.5, took about 3 minutes 55 seconds, and the report shows an API cost of about US$0.46. The green success mark on the Action only means the workflow executed successfully; it is not proof that the tests are sufficient, that the design meets the requirements, or that the scan is complete.

The three most obvious problems:

1. The content classification is wrong. `Untested behaviour` contains `cursorBoxes`, which explicitly says it is already covered by tests, and another entry, `eraseAt`, admits that most of its behaviour is already covered.
2. The review is not complete. Only 10 of the 44 code units were reviewed this round, and one requirement analysis failed because of the model output limit. The report easily makes readers trust the scan result too much.
3. There is no decision layer. The report repeatedly writes `Add a unit test that checks it`, but does not sufficiently explain which specific behaviour should be tested, why it belongs at the unit level, how high the risk is, or which team should handle it.

This means it is already a valuable test gap discovery prototype, but its conclusions cannot yet be used directly as the team's development to-do list or as a basis for blocking PRs.

## II. Item-by-item verification: the problems actually found

I cross-checked `audit.json` and `findings.json` against Kite's source code and tests.

Distribution of the 71 requirement judgements this round

Not code coverage

37

Covered

21

Unknown

4

Partial

4

Missing test

3

Contradicted

2

Needs human

Nearly a third of the requirements were judged `unknown`. Expressing uncertainty honestly is good practice, but the report should go further and tell the team why it does not know: no implementation evidence, no test found, insufficient context, or the need for human judgement.

### Actual problems and severity

| Priority | Finding | Verification result |
| --- | -------------------- | ----------------------------------------------------- |
| P0  | Missing test wrongly reported | `cursorBoxes` is already covered, yet it is counted among the 3 unit gaps |
| P0  | Requirement conflict wrongly judged | `ListPage` has name, duration and date sorting; adding size sorting does not violate the requirement |
| P0  | Suggested test code is wrong | The `eraseAt` skeleton builds a state in which a deletion cannot be triggered |
| P0  | Model failed but there is no completeness warning status | 20 document blocks were not fully reviewed because the output was truncated, yet the main headline is still a generic ❌ gaps |
| P0  | Test layers are not clearly distinguished | Higher-level UI scenarios are all recommended to get a unit test |
| P1  | Coding standards not confirmed | `standards.txt` is an empty file |
| P1  | Technical design omitted | `docs/architecture.md` was excluded by the automatic document filter |
| P1  | Full-repo scan scope insufficient | Only 10/44 units had their context loaded this round, and some of those were not analysed sufficiently |
| P1  | No Gap priority | One cannot quickly tell which gaps affect core business and which are only UI specification differences |

### Case A: the sorting feature was wrongly reported as a design conflict

Design document: [docs/design.md:178](https://github.com/Mira190/Kite/blob/985758cb9b07937959906a787f605d511aaabf0f/docs/design.md#L178)

It requires the recording list to support sorting by name, duration and date.

Actual source: [src/ui/ListPage.tsx](https://github.com/Mira190/Kite/blob/985758cb9b07937959906a787f605d511aaabf0f/src/ui/ListPage.tsx#L49)

It already defines three comparable columns, `name`, `dur` and `date`, and additionally supports `size`.

The report holds that having one extra size sort constitutes `contradicted`.

This reasoning does not hold. Unless the requirement explicitly limits sorting to three ways, an extra feature cannot be treated as violating the requirement.

A Requirement Semantics Validator should be added to distinguish the following logical relations:

| Requirement relation | Is it a conflict |
| ----------------------- | ------------- |
| Must include A, B, C; code includes A, B, C, D | No |
| May include only A, B, C; code includes D | Yes |
| Minimum height is 600; code sets 500 | Yes |
| Document describes A, but the source only finds B | Needs further retrieval; cannot be decided directly |

### Case B: the test suggestion for `eraseAt` is itself wrong

Source: [src/engine/board.ts:99](https://github.com/Mira190/Kite/blob/985758cb9b07937959906a787f605d511aaabf0f/src/engine/board.ts#L99).

The report suggests running `eraseAt` after one `undo` to verify that the redo history is cleared.

But the given skeleton creates only one stroke, and after the final `undo` the board has no stroke left. `eraseAt` therefore hits nothing and returns the original board directly, so `future` is not cleared.

Even if the implementation is completely correct, this suggested test would fail.

A more reasonable test is:

> Private pilot source excerpt removed; the surrounding analysis describes the behavior.

Here `line` is a helper function in the existing `test/board.test.ts`.

This reveals an architectural problem: SpecGuard verifies whether a reference exists, but does not verify whether the generated test scenario is self-consistent.

I suggest introducing an independent Test Suggestion Verifier that type-checks and executes the generated code in isolation; at the very least it should require setting up the precondition first and then verifying the test target.

### Case C: behaviour better suited to a component test is pushed to a Unit Test

The report points out that the play, rename and delete shortcuts of the recording list are not covered.

This is a meaningful test finding, but it was already classified as `higher_level` in `audit.json`, and the final Summary still writes:

`Add a unit test that checks it.`

This is a deterministic problem of the report generator, not only a model misjudgement.

For this kind of behaviour, one should distinguish the pure-function key mapping logic, React event handling, Electron IPC, and actual system operations.

For example:

| Test obligation | Suitable layer |
| -------------------------------- | ----------- |
| F2 maps to the rename command             | Unit        |
| F2 triggers RenameField                | Component   |
| The rename command correctly calls Electron IPC | Integration |
| After the user presses F2 the file is renamed successfully                 | E2E         |

The goal of Shift Left should be to verify earlier the logic that can be verified reliably at a low level, not to turn all tests into Unit Tests.

## III. The Summary's organisation needs to be redone

The current Summary is about 77 KB, 357 lines and 327 links, with a large amount of information in a single Details section.

Although the information is rich, the cost of finding things is too high for developers on other teams.

I suggest changing it into a three-layer report.

## Suggested structure of the GitHub Actions Summary

SpecGuard · Verification Gap Review

Incomplete

Repository: Kite · Commit: 985758c · Scan mode

# 2

Gap hypotheses requiring validation

# 3

Reported document conflicts

# 60/131

Document blocks assessed this run

Illustrative revised headline after excluding the explicitly non-gap cursorBoxes finding; remaining hypotheses still need validation.

01 · Action Required

Review

`checkRecording` — Default FPS tolerance boundary

Unit · `src/engine/probe.ts:73`

The existing tests verify the normal pass and a clear failure, but do not prove the default ±10% boundary.

Suggestion: add boundary tests where 27 fps passes and 26.9 fps fails.

Review

`eraseAt` — Redo history after a hit

Unit · `src/engine/board.ts:99`

The existing tests cover erase and merge, but lack an explicit assertion on the redo-branch behaviour after a deletion.

Suggestion: build two strokes, undo one, then delete the remaining stroke, and check that future is cleared.

02 · Review Completeness

Code scan coverage

10 / 44

Requirement block review this round

60 / 131

Coding standards

Not assessed

Model output truncation

20 blocks affected

03 · Full Evidence

The detailed requirement → code → tests mapping, false-positive candidates, unreviewed scope and model output stay in a separate Artifact.

The key point of this structure is: the Summary is a decision interface, not a complete audit database.

The detailed content of a single finding should use a unified format:

`Behaviour → Risk → Evidence → Missing assertion → Recommended layer → Suggested test → Confidence`

The result should also mark `New / Existing / Resolved / Needs review` directly, instead of calling something `Confirmed` merely because the model reached the same judgement in two consecutive rounds.

In the current code, confirmed actually means confirmed by a repeated scan; it was not verified by a test or by a human.

## IV. How much of the Shift Left goal is actually met?

What you originally wanted to achieve is:

> Requirement-aware reviewer that maps changed behaviour to test obligations, assertions, and test layers to find high-confidence verification gaps.

I assess this run against that goal.

| Capability | Judgement | Reason |
| --------------------------- | ----- | -------------------------------------- |
| Automatically discover Requirements           | Partially met  | Only `docs/design.md` was included |
| Map requirements to code                     | Partially met  | There are evidence links, but the associations contain misjudgements |
| Map requirements to tests                     | Partially met  | Currently based on static retrieval and LLM judgement |
| Identify missing Unit Tests            | Partially met  | There are valid candidates, and also clear false positives |
| Identify weak Assertions             | Partially met  | The mechanism exists, but this round has no reliable weak-assertion finding |
| Test layer recommendation                      | Insufficient   | The Summary does not distinguish Unit/Component/Integration |
| Coding Standard confirmation          | Not met   | The `standards.txt` loaded this round is empty |
| PR Changed Behaviour Review | Not verified this round | This was a manual full-repo scan |
| Timely feedback before development / before the PR                | Not met this round | The only triggers are manual and weekly scheduled |
| Results directly actionable                     | Insufficient   | The test skeletons are not verified, and there is no owner or priority |

Another notable phenomenon is that `audit-inventory.json` identified 44 source files, of which 18 have no matching test file.

But this number cannot be interpreted directly as 18 files missing unit tests. It includes different kinds of files such as UI, the Electron main process and the smoke runner, and module roles and reasonable test boundaries must be distinguished first.

### What really needs to change is the timing of feedback

The path Kite's verification took this time

Code already exists

Weekly / manual scan

Issue

Shift Left path to add

Requirement / Design

Test Obligations

Local / PR Verification

Feedback and fixes before Merge

A rotation that covers the whole repo in four rounds, once a week, can be used for continuous auditing, but it cannot replace an incremental scan at the moment of development. High-risk changes should be verified in their own PR, without waiting for the next rotation.

## V. Technical changes to implement first

| Order | Optimisation | Concrete change | Expected effect |
| -- | ---------------------- | -------------------------------------------------------- | --------------------- |
| P0 | Finding Validator      | Reject results that are “covered but judged missing”, and detect self-contradictory titles and bodies                       | Fewer false positives                  |
| P0 | Test Skeleton Verifier | Verify the precondition state, assertions and executability of the test                                        | Keep wrong suggestions from reaching the team            |
| P0 | Layer-aware Renderer   | Output the matching Unit / Component / Integration / E2E suggestion according to `class` | Guide Shift Left correctly       |
| P0 | Completeness Gate      | Output `INCOMPLETE` whenever any model shard fails or any scope is missed                            | Keep a green run from misleading              |
| P1 | Requirement Authority  | Mark the authority level and version of product requirements, architecture constraints and coding standards                               | Keep outdated documents from becoming a wrong oracle     |
| P1 | Standards Check        | Load the rules and show where they come from; a missing rule gives an explicit warning instead of passing by default                              | Meet the Coding Standard requirement |
| P1 | PR Incremental Review  | PR diff → affected scope → Requirement → Test obligation           | Truly move feedback earlier                |
| P1 | Evidence Report        | Use structured JSON as the data source; the Summary shows only actionable findings                           | Significantly improve readability               |
| P2 | Feedback Loop          | The team marks valid, false positive, accepted risk, fixed            | Keep measuring accuracy                  |

Three run configuration values are also worth changing.

Scan budget and sharding mechanism: this run made 5 model calls, and 1 was truncated by `max_output_tokens=22000`. First reduce the number of requirements in each batch, and add a retry and bisecting-split mechanism for failed shards, instead of simply raising the token limit. The completeness marker must be computed by the program and cannot be left to the model to describe.

Artifact retention: the output is currently retained for only 1 day, while the scheduled scan runs weekly. This makes it hard to manually re-check historical evidence and to assess fixes. I suggest keeping the structured results, under the company's data retention policy, for at least one full scan cycle, while avoiding keeping unnecessary full prompts and private source copies in long-lived Artifacts.

Action version and failure policy: Kite currently uses `Mira190/SpecGuard@main`, and `fail_on_error` defaults to `false`. Once stable, I suggest pinning the Action to a commit SHA; handle an incomplete review and a confirmed high-risk gap separately: the former is a tool reliability problem, and only the latter is a code quality problem.

## VI. The two capabilities I think most need to be added

First, Requirement Completeness Review. SpecGuard should not only answer whether the existing requirements have tests, but also be able to point out which acceptance conditions the requirements themselves omit, for example state transitions, failure recovery, boundary values, permission changes and concurrent behaviour. But these should be treated as test obligations awaiting confirmation, not arbitrarily declared formal requirements.

Kite's `docs/architecture.md` contains important constraints such as crash recovery, audio/video synchronisation, stream key protection and recording performance; this time it was excluded by the document-density heuristic. This shows that relying only on automatic document admission will miss key behaviour.

Second, Risk-based Verification Planning. Every requirement should not be mechanically converted into a Unit Test. One should first determine the consequence of failure and the layer best suited to verify it, and then check whether enough independent assertions already exist.

These two capabilities decide whether SpecGuard is an ordinary AI test commenter or a system that really helps other teams find verification gaps early.

## VII. How to measure whether the optimisation succeeded

Do not use the number of findings or the length of the report as the main KPI. I suggest the following metrics:

| Metric | Meaning |
| ------------------------ | -------------------------------- |
| Verified Precision       | Human-confirmed valid findings / verified findings  |
| Actionability Rate       | Share of findings that have a location, test layer, explicit assertion and reproduction steps |
| Fresh Scan Completeness  | Share of the target scope actually reviewed this round                  |
| Requirement Traceability | Share of requirements that can be clearly linked to code and test evidence                |
| Pre-merge Detection Rate | Share of verification gaps found and handled before merge                  |
| False Positive Rate      | Share of findings rejected by the team as invalid           |

I suggest that in the first phase Verified Precision, Actionability and Scan Completeness be the core acceptance metrics, and only then should the scope of automated scanning be expanded.

## Overall judgement

SpecGuard has now completed the basic capability of finding test evidence from code and requirement documents. Its biggest shortcoming is not that the model is not strong enough, but that it lacks a reliable mechanism to turn model results into test obligations that are verifiable, layered, assignable and traceable.

My implementation order would be: first fix accuracy and the report structure, then add the Coding Standard and completeness checks, and then connect PR incremental review and local feedback.

Only after this optimisation will the output it gives other teams really approach:

> Here is the behaviour your change introduces, the verification evidence we found, the exact assertion that is still missing, the best test layer, and the test you can add before merging.

Existing results to compare against: [this Action](https://github.com/Mira190/Kite/actions/runs/38510141042) · [scan Issue #3](https://github.com/Mira190/Kite/issues/3) · [SpecGuard source](https://github.com/Mira190/SpecGuard).