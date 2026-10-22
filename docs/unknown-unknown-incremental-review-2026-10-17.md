# SpecGuard Incremental Re-review of New Changes and Unknown Unknowns (2026-10-17)

The most important new finding: the segment ledger has corrected "the summary says which parts were reviewed", but the finding validator still uses the original planned scope. A reference in an unexecuted segment can be kept as a non-low-confidence gap. **The report correctly describes the uncovered scope, but that does not guarantee that every finding in the report obeys that scope.**

This round also reproduced a false positive on a negative-number boundary, the unknown precision of an old eval record being written as zero, and the boundary where the to-be-merged runtime admission keeps admitting extra calls when usage is missing. No product code was modified.

## 1. Version boundaries

| Object | Version and handling |
|---|---|
| Remote main at the start | 769b7396cbc35b18379c4dbe00c5c5345bed01b8, after #274 was merged |
| Deterministic reproduction on main | First reproduced on 769b739; at hand-in all mainline assertions were re-run on 44ed3eb with identical results, and the source hash was recorded |
| Main refreshed at hand-in | 44ed3eb8f093981c685027d0c1596aa78fa92939, with #271/#276 merged |
| Last incremental check | Read 769b739→44ed3eb through GitHub compare; nothing changed U1's executed-scope filtering, U2's number extraction, or U3's metric computation |
| To-be-merged #275 | 489009da4c55b08157a52b2ee5c2d6628e5d5e87, loaded separately to reproduce U4 |
| To-be-merged #273 | da8f9890ebe58e40f8f6366daa46637bf6b88268, read the diff, tests, and the actual review |
| Latest new local commit | cac0d53df6e56d28d2cee786031f70dea764186a; corresponds to #276, which the remote merged after I read it |
| Current root directory | Still behind the remote; no branch switched, existing untracked reports not overwritten |

The uncommitted state of the relevant active worktrees was checked, and no product-semantic change newer than the commits above was found. The remote's last merge object was initially not local; by hand-in check it had been synced by another process, so the **mainline probes were re-run on 44ed3eb and all passed**. Some code links in the body keep the locations of the original 769b739; the final result files and source hash correspond to 44ed3eb.

The evidence window is about 2026-10-17 08:28–08:38 UTC, Sydney 19:28–19:38. [Initial mainline reproduction baseline](https://github.com/Mira190/SpecGuard/tree/769b7396cbc35b18379c4dbe00c5c5345bed01b8), [remote mainline at hand-in and final probe baseline](https://github.com/Mira190/SpecGuard/tree/44ed3eb8f093981c685027d0c1596aa78fa92939).

## 2. The previous round's problems have substantive fixes

| Previous item | Corresponding new fix | This round's judgment |
|---|---|---|
| F1/F2: summary loses samples after fixing, upgrading to inline changes the ID | #261 keeps the metadata of handled summaries; SpecGuard identity uses a unified fp prefix | The basic scenarios are fixed; this round directly verifies cross-channel and cross-position ID consistency |
| F3/F4/F7: retrieval failure, target identity, and environment not pinned | #259 adds failure information, target validation, and environment pinning | Not reported again as old problems |
| F5/F6: missing delivered precision, unknown historical error denominator | #259 new fields and unknown_expected | The error denominator already uses null; historical compatibility of precision still has U3 |
| F8: hunk diff failure swallowed | #260 limitation; #273 further restricts grep to test paths | Failures are now visible; #273 is still to be merged in this round's snapshot |
| N1/N2/N3/N6: segment unreviewed status, wrong reviewed list, failure granularity, and log units | #264 unified part keys | Status and output are fixed; the executed-scope constraint on findings still has U1 |
| N4/N5: zero pack, static clues beyond the first 100 rows dropped | #267 configuration rejection and keeping selected rows | The old counterexamples are no longer treated as current defects |
| "Touched counts as reviewed whole" | #274 adds exact parts_left_by_path | The new funnel is improved; it still cannot replace verifying the visible evidence of each finding |
| Third-party noise, coverage guard search failure | #270/#271/#276 | New filtering, restricted search scope, and failure explanation; the relevant increments were read |

A fixed status does not mean all boundaries are proven safe. Only new counterexamples are listed below, and closed old problems are not listed again.

## 3. U1 · P1: references in unexecuted parts can still become non-low-confidence gaps

### Problem and actual input

A unit is divided into two segments:

- part 1: lines 1–2, executed successfully;
- part 2: lines 3–4, dropped due to budget, or the call failed;
- the successful call returns a missing_test referencing the error branch at line 3 of part 2;
- the quoted text does exist in the local source, and the finding carries a valid test sketch.

In both cases the results are:

| Result field | Actual result |
|---|---|
| Summary reviewed scope | part 1 of 2, lines 1–2 |
| Finding reference | line 3, in unexecuted part 2 |
| audit.json retained count | 1 |
| low | false |
| run status | incomplete |

So this is a problem of **globally incomplete, yet an individual finding still over-confirmed**, not yet another case of "the whole job being green equals a complete review".

### Root cause

The render's ran computation already subtracts dropped/failed keys. But main passes readUnits' original planned spans directly to verify; verifyUnits' "is it within this part" check is still performed against these planned ranges.

"The quoted statement can be found in the source" and "the quote lies within the successfully reviewed scope of this run" are two different facts. At present, satisfying only the former, plus matching the planned range, is enough to pass.

Code: [verifyUnits range check](https://github.com/Mira190/SpecGuard/blob/769b7396cbc35b18379c4dbe00c5c5345bed01b8/src/audit-post.js#L336), [render's ran](https://github.com/Mira190/SpecGuard/blob/769b7396cbc35b18379c4dbe00c5c5345bed01b8/src/audit-post.js#L620), [main calling verify](https://github.com/Mira190/SpecGuard/blob/769b7396cbc35b18379c4dbe00c5c5345bed01b8/src/audit-post.js#L866).

### Minimal fix and acceptance

Before validation, compute the successfully executed ranges from the existing part keys as a separate input to verify; the planned ranges are still kept for the summary and scheduling. Model gaps from dropped, failed, and not_started regions should be removed or explicitly listed as leads not confirmed by this review.

Validation should also be bound to call ownership: part 2 succeeding in another call must not automatically give part 1's answer all of part 2's evidence. First implement the constraint on this run's successful ranges, then add call-level provenance.

Minimal acceptance matrix:

| Input | Expected result |
|---|---|
| Correct reference in a successful part | Kept |
| Reference in a budget-dropped part | Does not become a validated non-low-confidence gap |
| Reference in a failed part | Same |
| The part succeeds after retry | Judged by the actual range of the successful attempt |
| Non-contiguous successful segments | The unreviewed region in between must not be covered by min/max line numbers |
| Clues produced by the static fact scanner | Keep independent provenance, and do not apply model-call visibility rules |

This is the unknown unknown most worth fixing first now: the ledger has been passed from scheduling to the report, but has not yet been fully passed into evidence validation.

## 4. U2 · P2: a negative boundary is already asserted precisely, yet boundary_unpinned is still generated

This round used a real inventory for two paired scenarios. The source has a named numeric constant LOWER_LIMIT and a function with value < LOWER_LIMIT; the corresponding test directly asserts the function's behavior at the equality boundary.

| Constant / test input | Actual boundary clues |
|---|---:|
| LOWER_LIMIT=10; the expectation of tooLow(10) is asserted | 0, correct control |
| LOWER_LIMIT=-10; the expectation of tooLow(-10) is asserted | 1, wrong clue |

The negative version of the test can indeed distinguish < from <=; it is not merely an unrelated number appearing.

The root cause is that the source arithmetic parsing allows negative numbers, but the number extraction in tests matches only unsigned digits. The target set stores "-10", the scan of the test gets only "10", and so the match fails.

This is an accuracy problem of a limited static clue; the current lead is not a confirmed gap, and its severity is lower than U1. It must not be interpreted as a model false positive, nor ignored when computing the precision of static facts.

Minimal fix: make the numeric normalization of source and tests consistent, covering sign, decimals, and digit separators; handle unary minus and subtraction separately, to avoid unconditionally treating x-10 as a negative test value. Expressions beyond the grammar's capability continue to be marked unknown, and are not evaluated by executing code.

Acceptance should include at least -10, -0.5, a positive control, subtraction expressions, numbers in comments/strings, and parameterized inputs. [Number extraction](https://github.com/Mira190/SpecGuard/blob/769b7396cbc35b18379c4dbe00c5c5345bed01b8/src/audit-units.js#L259), [generating boundary](https://github.com/Mira190/SpecGuard/blob/769b7396cbc35b18379c4dbe00c5c5345bed01b8/src/audit-units.js#L287).

## 5. U3 · P2: delivered precision of old records writes unknown as zero

The new precision_delivered in #259 is the right direction; but when an old eval row has no tp_delivered, this field is not protected by noDelivered the way recall_delivered is.

The reproduction input is an old successful record: tp=1, fp=1, fn=0, with no delivered field.

| Field | Currently returned |
|---|---:|
| raw precision | 0.5 |
| recall_delivered | null |
| precision_delivered | 0 |

The zero here cannot mean "the number of delivered correct findings is zero", because the data did not record the delivered set. When old and new historical reports are mixed, missing data will be misread as quality regression.

Minimal fix: precision_delivered should also return null per noDelivered, and print the number of missing records; do not silently fall back to raw precision. Keep the historical-compatibility policy consistent between raw and delivered.

A positive control in this round also confirmed: when an old error lacks expected_findings, E2E recall already correctly returns null, so F6 should not continue to be reported as unfixed. [grade.js:214–219](https://github.com/Mira190/SpecGuard/blob/769b7396cbc35b18379c4dbe00c5c5345bed01b8/eval/grade.js#L214).

## 6. U4 · P2, to be merged in #275: admits extra calls at zero spend when usage is missing

### Behavior proven

This round loaded #275's real adapter, replacing only the local plan and the provider response. The plan has one normal part and one extra part; both have the same reserve. The budget can cover one reserve, but not two.

| Item | Reproduced value |
|---|---:|
| Reserve per call | $0.0020748 |
| Total budget | $0.0031122 |
| Sum of two reserves | $0.0041496 |
| Returns valid findings JSON but lacks usage | 2 calls, usage.json records total cost 0 |
| Returns the same kind of JSON with known usage (control) | 1 call |

This is computed with the repository's current price table, with no real API request and no real billing overrun.

### Risk boundary

#275 decides whether to append via actual spent + next worst case. When j.usage is missing it becomes {}, and the cost result is zero; so even without settlement information the budget is treated as released.

A normal provider success response should usually have usage, and this round did not prove that the real Anthropic service is under-reporting. The problem is that after the adapter accepts such a response it still claims to have sufficient basis for hard-budget admission. Abnormal responses, compatible implementations, or missing metadata must not be equivalent to a "free call".

Minimal fix: when usage is unknown, keep that attempt's reserve, or pause extras and disclose usage_unknown; release the difference only after trustworthy usage is obtained. Do not just add a warning and continue computing as zero spend.

Acceptance includes missing usage, empty usage, partially missing fields, a request timeout without usable usage, and attempt settlement after retry. Keep the existing equality-boundary test with normal usage.

Code: [usage default](https://github.com/Mira190/SpecGuard/blob/489009da4c55b08157a52b2ee5c2d6628e5d5e87/src/engines/claude-api.js#L399), [spent and runtime admission](https://github.com/Mira190/SpecGuard/blob/489009da4c55b08157a52b2ee5c2d6628e5d5e87/src/engines/claude-api.js#L438).

This problem lies in a to-be-merged branch, and should not be written as a production overspend that has already happened on the latest main. [PR #275](https://github.com/Mira190/SpecGuard/pull/275).

## 7. Could real PRs/Actions find these problems

### Verified mainline CI

The test of [39016918543](https://github.com/Mira190/SpecGuard/actions/runs/39016918543) corresponding to 769b739 is success: 1399 tests, 1395 pass, 0 fail, 3 skipped, 1 TODO. dogfood was skipped on the main push. This number is not passed off as the full test result of 44ed3eb.

These tests prove that the corresponding existing regressions pass; the key gap of U1 is "the new ledger's constraint on the final finding", which asserting only status, funnel, and summary cannot cover. The new test should go through the publisher's real validation path, rather than adding yet another isolated assertion on the ran set.

### #274's real review

The maintainer has confirmed that the old funnel counted a unit with unreviewed parts as whole; #274 adds exact parts_left_by_path and handles old artifacts conservatively. This fix is valuable and must not be withdrawn because of U1.

But its actual bot summary is still incomplete, and reports that some large test files were truncated; "no high-confidence gap" cannot be taken as acceptance of the finding-validation scope. [#274 human review](https://github.com/Mira190/SpecGuard/pull/274#pullrequestreview-5556982757), [bot summary](https://github.com/Mira190/SpecGuard/pull/274#issuecomment-6231591925).

### #275's real review

CI success; the bot points out that part of the admission-related evidence was not seen, especially that src/claude-api.test.js is very large and only a slice was seen. So "no explicit missing_test" cannot be used as evidence that the budget logic has been exhausted.

U4's input is not a repeat of the existing successful-usage tests: it checks whether, when settlement metadata is lost, it is still entitled to add work. [#275 summary](https://github.com/Mira190/SpecGuard/pull/275#issuecomment-6231610521).

### Boundaries confirmable from Kite's latest run

This round directly read the job log of [39016251110](https://github.com/Mira190/Kite/actions/runs/39016251110):

- independent units and parts are separated: 43 of 43 units (58 parts);
- the Action ref is fix/scan-units-third-party;
- status=incomplete;
- artifact upload succeeded.

This was a run of the corresponding third-party filtering branch, and cannot be used to prove that the current #275 runtime admission has been through a real scan, nor to replace the full acceptance of the main at hand-in. This round did not read the raw prompt, usage, and per-seed ground truth inside the artifact ZIP.

## 8. Beyond the fixes: newly emerging systemic blind spots

These are directions for next-round experiments, not additional bugs already reproduced:

| Hypothesis | Why it is worth checking now | Minimal experiment |
|---|---|---|
| The reference exists in the source but not in the evidence the model actually had | U1 already proved that planned and executed scopes are disconnected | Record source spans and test blocks per call/attempt, and have the validator connect to that source |
| After adding recall rules, the precision of facts and of suggestions change separately | New boundary, weak-assertion classification, and third-party filtering changed at the same time | Compute fact precision and actionable precision per rule, per language, and per value format |
| After a small pack adds calls, failures and missing usage influence each other | #275 depends on runtime settlement and the extra queue | Inject failures, timeouts, and missing metadata into a fixed plan, and verify that budget and coverage ledger are conserved |
| Output trimming affects author-visible recall | Previously generated 6/8 but actually visible 3/8, now changed to round-robin | Report the three layers generated/verified/visible together, not just the generated total |
| Filtering non-unit noise wrongly excludes actual production code | #271 excludes paths such as scripts/integration | Hold out a repository and label each item eligible / excluded; do not just check for fewer alerts |
| Requirements, tests, and obligations each have ground truth, but cross-layer connections may still be wrong | The new fixes mostly revolve around single-layer fields | Build cross-file behavior cases: requirement → all implementations → corresponding assertions → final comment reconciling layer by layer |

For complex repositories, the next high-value observation field is evidence provenance, not adding yet another overall coverage percentage.

Suggestion: reuse the existing scan-parts data: for each part/attempt record the planned range, actual pack, execution result, finding source, and validation result. A reusable range set is generated once, then consumed by scheduling, validation, and reporting.

## 9. Priority order and acceptance

1. **Fix U1 first.** Model conclusions on unexecuted ranges cannot be labelled as validated high-value output; accept positive cases, dropped, failed, retry, and non-contiguous ranges together.
2. **Add U4 before #275 is merged.** Normal usage scenarios already have tests, but abnormal settlement data must still keep the reserve.
3. **Add U2's negative-number and expression paired cases.** Keep the lead identity, and do not upgrade it to an automatically confirmed test gap.
4. **Fix U3's historical-missing definition.** Do not fill unknown data with a zero score.
5. **After merging, run a fixed-target real run.** Fix the target SHA, action SHA, effective configuration, and seed ground truth, to avoid being unable to attribute results after changing rules, budget, and output caps in the same round.
6. **Re-check ordinary no-alert PRs.** Controlled seed scores cannot answer real FN; the current review still needs an independent review of negative samples.

It is not recommended to introduce a new database, a whole-repo AST platform, or a separate trace service at the same time for four counterexamples. First get the existing range and identity fields flowing through, which can raise output trustworthiness with very small changes.

## 10. Reproduction and attachments

Mainline cases and fix controls:

    node docs/review-probes/unknown-incremental-2026-10-17/main.cjs

Budget admission case for the to-be-merged #275:

    node docs/review-probes/unknown-incremental-2026-10-17/admission.cjs

U1 contains the dropped/failed branches; U2 has a positive-number paired control; U4 has a known-usage control. In addition, three positive fix controls were checked: cross-channel ID stability, invalid pack configuration rejection, and unknown expected denominator returning null. All assertions pass.

The scripts load only the fixed Git tree, use self-built temp files, controlled Git reads, and a mock provider. Source hashes are saved with the results; they do not write .git, call paid models, or write to GitHub.

- [Mainline reproduction results](C:/Files/Projects/SpecGuard/docs/unknown-unknown-incremental-probes-2026-10-17.json)
- [#275 admission reproduction results](C:/Files/Projects/SpecGuard/docs/unknown-unknown-runtime-admission-probe-2026-10-17.json)
- [PR / Actions evidence](C:/Files/Projects/SpecGuard/docs/unknown-unknown-incremental-evidence-2026-10-17.json)
- [Version at hand-in and remote increments](C:/Files/Projects/SpecGuard/docs/unknown-unknown-incremental-final-state-2026-10-17.json)
- [Mainline probe](C:/Files/Projects/SpecGuard/docs/review-probes/unknown-incremental-2026-10-17/main.cjs)
- [Budget probe](C:/Files/Projects/SpecGuard/docs/review-probes/unknown-incremental-2026-10-17/admission.cjs)

Not checked: the latest artifact ZIP, real billing, independent re-labelling of each seed, human author adoption, real FN on ordinary PRs, and a local re-run of the full test suite on 44ed3eb. The mainline deterministic probes on 44ed3eb were run; these limitations mainly constrain inference about production incidence and team benefit.

