# SpecGuard third critical review — Run #12

[GitHub Actions Run #12](https://github.com/Mira190/Kite/actions/runs/38515926303) · 14 October 2026 · Kite commit `985758c`

## I. Core conclusion

The new version improves in how it words its results and in the breadth of its test findings, but a more serious problem has appeared: the statistics in the report can no longer be fully trusted.

I read the GitHub Issue of this run, the full Job Log, and `audit.json`, `scan-parts.json`, `audit-meta.json` and `audit-inventory.json` from the Artifact.

Requirement review completed this round

# 70 / 80

Requirement blocks in the 10 failed shards were not reviewed

Unit Findings effectively shown this round

# 7

5 missing · 2 weak

Code units reviewed cumulatively

# 35 / 44

9 have still never been fully reviewed

Model calls and cost

# 7

About US$0.485 · Claude Haiku 5.5

The most serious statistical contradiction is:

Coverage shows 141 / 131

The report text reads `Coverage: 141 of 131 blocks audited at least once`, which cannot hold under a definition that counts requirement blocks uniquely.

The same report also claims at the same time that 70 and 80 requirement blocks were reviewed this round. The Artifact confirms: 80 were preselected, but 10 of them were not successfully reviewed because the model output was unacceptable.

This is not merely a layout problem. For a Shift Left tool to be rolled out to other Teams, the scan scope and its completeness are themselves part of the review result and must be reliable.

From this round on, I will divide the findings into two kinds: valuable problems that SpecGuard really identified, and false positives or misleading output that SpecGuard itself may cause.

## II. What was actually fixed this time?

| Problem from the previous round | Situation this round | Assessment |
| ------------------- | ---------------------------- | ------------- |
| Repeated findings were called Confirmed   | Changed to `Reported in two runs`    | Improved            |
| Unit Test recommended for every gap  | Component / Integration partly supported | Partly improved          |
| Model output truncated              | Automatic splitting added                       | Right direction, but one batch still failed   |
| No Weak Test findings     | This round reports 2                     | Discovery ability improved, accuracy still to be verified |
| Design Exception false positive | This round no longer judges the white selection border directly as a conflict            | Improved            |
| Historical Findings lose their type     | Still present                         | Not fixed           |
| Coding Standards    | Still no standards file obtained                   | Not fixed           |
| Summary actionability        | Still has generic advice and incomplete test drafts                       | Limited improvement          |

Especially worth acknowledging, the report now lists low-confidence findings separately instead of putting them all in the main conclusion. This is necessary.

But this does not yet mean the high-confidence mechanism is reliable, because several findings that were put into the main list below still have problems themselves.

## III. Item-by-item check: which findings are accurate?

### 1. `ownFile` — a missing core unit test was falsely reported

High priority: fix SpecGuard

This round's report says that `ownFile` at [electron/app.cjs:617](https://github.com/Mira190/Kite/blob/985758cb9b07937959906a787f605d511aaabf0f/electron/app.cjs#L617) has no unit test, and that the path traversal protection is verified only in the Smoke Test.

But the source is actually:

> Private pilot source excerpt removed; the surrounding analysis describes the behavior.

The core protection logic `isDirectChild` already has a direct Unit Test:

[View test/filename.test.ts](https://github.com/Mira190/Kite/blob/985758cb9b07937959906a787f605d511aaabf0f/test/filename.test.ts)

That test covers direct child files, subdirectories, `..` path traversal, similar directory prefixes, case, and different slashes.

So the correct conclusion should be:

- Core path traversal logic: already has a Unit Test.
- The combination of `MEDIA_EXT` and entry-argument validation in `ownFile`: a Contract/Integration Test could be considered.
- Actual Electron delete and rename operations: Smoke evidence exists, but whether it is sufficient still needs to be assessed.

It cannot be simply written as the whole `ownFile guard` not being covered by a Unit Test.

This is a typical failure to trace test evidence across modules:

`Wrapper → Delegated Helper → Existing Unit Test`

SpecGuard should follow the call relationship to the helper under test and then decide on the remaining gap, instead of only checking whether the wrapper has a corresponding test file.

### 2. `toolbox.test.ts` — the Weak Assertion judgement does not hold

Very likely a false positive

The report says that the `has()` assertion at [test/toolbox.test.ts:25](https://github.com/Mira190/Kite/blob/985758cb9b07937959906a787f605d511aaabf0f/test/toolbox.test.ts#L25) is too weak, because it only checks whether a group of arguments appears anywhere.

But the implementation of `has()` is:

> Private pilot source excerpt removed; the surrounding analysis describes the behavior.

It verifies whether the expected contiguous argument sequence exists, not the truthiness of an arbitrary string.

For an FFmpeg argument builder, this is usually a reasonable contract test. For example, whether `-c:v libx264` is present and which position of the argument array it appears in are usually two different requirements.

The report suggests switching to fixed array position assertions, which may instead make the test depend too much on implementation details and lower its maintainability.

Unless the relative order of FFmpeg arguments really affects behaviour, or duplicated options cause overriding, this kind of assertion should not be judged a Weak Test.

This is the second clear counterexample worth adding to the regression test set.

### 3. `textBox` — valuable, but should not be over-interpreted

Partly valid

The report points out that [test/board.test.ts:81](https://github.com/Mira190/Kite/blob/985758cb9b07937959906a787f605d511aaabf0f/test/board.test.ts#L81) writes the expected value as a formula identical to the implementation:

> Private pilot source excerpt removed; the surrounding analysis describes the behavior.

If this formula and the code are changed wrongly in sync, the test may fail to detect the problem.

It suggests switching to a concrete expected value `64` that comes from an independent specification, and adding boundary examples. This is a reasonable test quality suggestion.

However, the current test is not incapable of failing. As long as the implementation's computed result deviates from the expected formula, it can still detect the error. The report's absolute wording, something like “cannot detect a change”, is too strong.

The correct classification should be:

Oracle independence weakness, rather than no effective assertion.

### 4. `capture.cjs` — the test gap most worth pursuing this round

High-value finding

This is a fairly reliable direction for improvement.

[Code location](https://github.com/Mira190/Kite/blob/985758cb9b07937959906a787f605d511aaabf0f/electron/capture.cjs#L16)

The `rec:chunk` handler manages the active state, byte counting, disk writing and live-stream forwarding together. These behaviours are highly related.

I suggest covering at least: normal writing, a chunk when recording has not started, abnormal exit, repeated end, live streaming without a file, write errors, and the case where the number sent differs from the number received.

There is also a potential risk that SpecGuard did not point out:

Right after calling the write operation, the code immediately increases `written.chunks` and `written.bytes`. These counts reflect the chunks the handler received and processed, and do not necessarily prove that the bytes were successfully persisted to disk.

Therefore, even if the number the recorder sent is exactly the same as main's count, that alone is not enough to prove the recording file is complete. File verification after the write ends and stream error handling are still necessary.

This is closer than simply checking whether the chunk counter has a Unit Test to the unknown unknowns you really hope to find.

## IV. The Design Contradictions really worth attention this round

Compared with the Unit Test Findings, I think two inconsistencies between design and implementation this time deserve more attention.

### A. `ListPage` selects the first record by default: valid

Design: [docs/design.md:115](https://github.com/Mira190/Kite/blob/985758cb9b07937959906a787f605d511aaabf0f/docs/design.md#L115)

It requires the first row of the recording list to be selected by default, without entering the editing state.

Implementation: [src/ui/ListPage.tsx:35](https://github.com/Mira190/Kite/blob/985758cb9b07937959906a787f605d511aaabf0f/src/ui/ListPage.tsx#L35)

> Private pilot source excerpt removed; the surrounding analysis describes the behavior.

`sel` is initialised as empty, and after `rows` are obtained asynchronously there is no logic that selects the first one automatically.

This is a credible difference between design and implementation.

But a Component Test should be recommended to verify the default selection after the list loads, instead of broadly asking for a Unit Test to be added.

### B. Shortcut registration failure: SpecGuard found the surface difference but missed the more important problem

Design: [docs/design.md:141](https://github.com/Mira190/Kite/blob/985758cb9b07937959906a787f605d511aaabf0f/docs/design.md#L141)

It requires that on a conflict saving is refused and the old shortcut is kept; when the operating system refuses to register the shortcut, a conflict message must also be shown.

The report only points out that the error message text is inconsistent.

But I checked `setHotkey` in [electron/app.cjs](https://github.com/Mira190/Kite/blob/985758cb9b07937959906a787f605d511aaabf0f/electron/app.cjs#L643):

> Private pilot source excerpt removed; the surrounding analysis describes the behavior.

Here the shortcut is first updated and persisted, and only then is Electron `globalShortcut.register` attempted.

If the operating system refuses the registration, the code returns a warning, but the new shortcut has already been saved, and the old shortcut may already have been unregistered.

If the requirement of “keeping the old value” also applies to operating system registration failure, this is a real state-consistency defect.

What needs testing is not only the warning text, but:

`Previous Binding → Registration Failure → Persisted State → Actual Active Binding`

This is exactly the kind of high-value unknown risk SpecGuard should dig out from first principles: not only verifying the assertions of a single function, but also verifying the system invariants on the failure path.

## V. Architectural problems that still exist in the third round

### P0 — The scan ledger is inconsistent

The code computes cumulative coverage with logic like the following:

```
const k = rotation.picked
const total = k + carried.length
```

Here `picked` is the planned number of reviews, while `carried` also contains, after a failed shard, some blocks that were originally selected but not completed.

So this appears:

`80 selected + 61 carried = 141`

instead of taking the union over the unique Block IDs that were really reviewed.

At least four sets should be stored independently:

`selected / completed / failed / previouslyReviewed`

All cumulative coverage numbers may only be computed from unique Block IDs, with the following constraints added:

```
assert(completedIds.size <= selectedIds.size)
assert(auditedEverIds.size <= totalCandidateIds.size)
assert(completedIds.size + failedIds.size <= selectedIds.size)
```

The completion rate of this round and the historical cumulative coverage rate should also be reported separately and must not be mixed together.

### P0 — A model failure still returns a green success

This `scan-parts.json` shows 7 model calls, 1 automatic split and 1 final failure:

`9 of 10 blocks were not answered`

But the GitHub Job is still `success`, and the latest Issue was still updated with the scan result.

I suggest distinguishing three states:

| State       | Meaning                | Should it count as a qualified review |
| -------- | ----------------- | --------- |
| Complete | The review of all targets is complete          | Yes         |
| Partial  | There are valid findings, but there are failures or missing context | No         |
| Failed   | No reliable output, or evidence verification failed      | No         |

For Audit mode, other CI need not be interrupted, but the analysis result of the Check Run should be marked incomplete. A partial failure result should not directly advance the confirmation and elimination status of historical findings.

### P0 — The model does not reliably get the full requirement context

This round's `audit.json` explicitly contains a limitation note: “`docs/design.md` was not fully inlined, only the candidate block text was assessed”.

I also checked the top-level `prompt.txt` of the Artifact, and it is not the full text of the design document. Although the model shards attach evidence windows, one cannot conclude from that that the complete requirement context was provided.

This explains why SpecGuard sometimes sees only one rule but not the exception later in the same document.

Moreover, `docs/architecture.md` is still excluded by the automatic filter, although it contains important design information such as recording integrity, crash recovery and performance constraints.

I suggest separating “discovering documents” from “determining the authoritative context” and building a document-level dependency index; when a requirement is met, it must be possible to find the related exceptions, definitions, referenced sections and architecture constraints.

### P1 — Historical Findings still lose their type

`docs/design.md:208`, judged `contradicted` in the previous round, now has its recommended action turned into `Add a unit test that checks it` after being carried over as a historical record.

The same problem also happens with sorting and other UI requirements.

This is a problem of the persisted data structure, and cannot be fully solved by re-prompting the model.

Each finding should keep an independent, traceable structure:

```
{
  "finding_id": "stable-id",
  "requirement_id": "requirement-id",
  "kind": "spec_drift",
  "recommended_layer": "static",
  "evidence_sha": "commit-sha",
  "verification": "unverified",
  "lifecycle": "open"
}
```

Historical state should follow the specific Finding, not just the document block. Otherwise, when one problem in a complex paragraph disappears and another appears, they will be wrongly taken to be the same gap persisting.

### P1 — Inventory treats a test driver as a business unit under test

This round treated `electron/smoke.cjs` as source that may lack a Unit Test, and only afterwards downgraded it to Low Confidence.

In fact it is an E2E Test Runner.

This shows that the code inventory build stage lacks a responsibility classification.

It should first be divided into Production Logic, UI, Integration Adapter, Test Infrastructure, Generated/Vendored and so on, and only then decide how to rank the risk and whether a Unit Test is needed.

Also, the heuristic count of “no weak assertions” in `test/` does not contradict the two Weak Test findings the model finally produced, but the Summary should state clearly that the former is the number of static clues and the latter is the number of model judgements, to avoid looking like a statistical error.

## VI. Summary organisation: clearly shorter than the previous version, but still not usable

Summary size over three rounds

From the Artifact of the corresponding Run, in KB

0 KB30 KB60 KB90 KB120 KBRun #10Run #11Run #12

This round dropped from about 105 KB in the previous version to 63 KB, which is indeed an improvement.

But for other development teams, a single audit Summary of 63 KB is still too long.

What most needs to change is not to keep cutting text, but to organise the information along the developer's decision flow.

I suggest changing to the following front page:

SpecGuard — Repository Verification

Partial

Kite · 985758c · Full-repo rotating audit

## 70/80

Blocks assessed

## 10

Failed blocks

## 35/44

Units audited ever

Priority findings

Spec drift

ListPage initial row is not selected

State risk

Shortcut registration failure persists invalid binding

Test gap

Capture lifecycle and byte accounting

Details: findings with evidence, unresolved hypotheses, reviewed areas, rejected documents and full machine-readable audit.

This is only a suggested presentation; the Priority Findings in it went through this independent review, and are not the same as the three problems directly confirmed by SpecGuard's original report.

This way a developer knows as soon as they open it: what needs changing, why, what should be verified, and whether the tool ran completely this time.

## VII. From the Shift Left angle, the most critical next step is not to increase the number of findings

These three runs are all full-repo scans of the same Kite Commit. They prove that SpecGuard can keep finding some verification gaps, but do not yet prove that when a requirement or a PR changes, it can hand the right test suggestion to the Team responsible for development in time.

The current `workflow_dispatch` and weekly `schedule` still only verify the periodic audit mode.

I suggest advancing in the following order in the next phase:

| Priority | Suggested task                             | Acceptance criterion                                        |
| --- | -------------------------------- | ------------------------------------------- |
| P0  | Fix Coverage Accounting           | An audit coverage greater than 100% never appears                          |
| P0  | Fix Partial Scan Lifecycle        | Failed shards do not pollute the historical confirmation state                              |
| P0  | Cross-module Test Evidence Linking        | `ownFile` can find the existing Unit Test of `isDirectChild` |
| P0  | Redefine Weak Assertions             | FFmpeg contiguous-argument matching is not judged weak without reason                  |
| P1  | Requirement Exception Resolution | A theme-colour exception does not become a contradiction                    |
| P1  | Finding Identity & History       | Every historical finding keeps its type, evidence and applicable layer                   |
| P1  | Risk-based Ranking               | High-impact state-consistency problems take priority over simple UI text formatting                    |
| P1  | PR / Local Modes verification              | A PR change produces the matching test obligation at the time of the change                             |
| P1  | Coding Standards Check           | State clearly which standards are loaded; return Not assessed when none exist                |
| P2  | Human Feedback Dataset           | Can compute precision and false-positive rate verified by humans   |

## VIII. Overall assessment

| Run robustness           | Improving       |
| --------------- | --------- |
| Test gap discovery ability        | Already of real value    |
| Accuracy of conclusions           | Still needs strengthening      |
| Report readability           | Somewhat improved      |
| Traceability of audit results        | Has data structure problems  |
| Completeness of Shift Left | Currently still leans towards after-the-fact auditing |

I do not currently recommend automatically using this version's findings to block PRs across teams. But it can continue to be used as an advisory scanner, provided the results are clearly labelled as hypotheses, verified evidence and unreviewed scope.

The most important lesson of this round is: SpecGuard should not keep simply chasing more scanned files and more reported gaps. The next upgrade should concentrate on Verification Integrity, that is, making sure every test suggestion has independent evidence, the correct test layer and a stable identity, while making sure the scan process itself can be verified.

Related material: [Run #12](https://github.com/Mira190/Kite/actions/runs/38515926303) · [Artifact](https://github.com/Mira190/Kite/actions/runs/38515926303/artifacts/11872232061) · [Issue #3](https://github.com/Mira190/Kite/issues/3) · [SpecGuard source](https://github.com/Mira190/SpecGuard).