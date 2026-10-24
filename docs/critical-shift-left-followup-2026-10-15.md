# SpecGuard continued review: counterexamples after the fixes and cross-path invariants

Date: 2026-10-15. Code frozen at main [`d3234e34924405ebd4febd38aa2691675f0fad59`](https://github.com/Mira190/SpecGuard/commit/d3234e34924405ebd4febd38aa2691675f0fad59), i.e. after PR #190 was merged. This document follows on from the [first-round review](critical-shift-left-review-2026-10-15.md); it keeps the historical baseline of the original report and does not apply the old problems directly to the new version.

GitHub re-check time: around 2026-10-15 07:35 UTC (Sydney 18:35). It only adds a review document and entry links; it does not change the product implementation, does not run paid models, and does not post test comments or test issues to GitHub.

## 1. Conclusions of this round

**The first batch of fixes did handle the original concrete counterexamples, but some fixes still treat lexical similarity as semantic proof; the evaluator also does not fully hold the constraints that "an observation can be consumed only once" and "completeness state is consistent".** This round adds six reproducible findings F13–F18: F14 is a missed-report path introduced by the new table-recognition rule, F13/F17 are boundaries the fixes did not cover, F15/F16 are evaluation-trustworthiness problems, and F18 is an inconsistent cross-repository output boundary.

The original four directly replayable counterexamples now pass as the fixes intended: a full tabularization no longer produces a removed lead, an empty `test.skip` is no longer covered, a normal classification conflict keeps unknown, and an extra visible summary finding is counted as FP and makes the clean case fail. The display for F08 was also changed from fixed to "with later changes, fix not verified". This is worth confirming; these fixed inputs must not keep being treated as current defects.

However, **closing one example is still different from establishing a reliable rule**: the same final state should be supported by evidence of the same strength; the same boundary should hold at every entry and exit; adding irrelevant information should not make a real risk disappear.

## 2. Increments in the fixes and the online evidence

| First-round item | Current re-check | Status |
|---|---|---|
| F01 false positive on equivalent table migration | The original synthetic example now outputs `[]`; the real-row-deletion control is still in the existing tests | Original example fixed; for the new unrelated-table suppression see F14 |
| F02 empty/skipped test counted as covered | The original `test.skip` example becomes unknown; reuses the PR's `assertionKind` | Original example fixed; comments, imports and variables are still accepted, see F13 |
| F03 requirement/not_requirement conflict | A conflict from a normal source keeps unknown and deletes not_requirement | Original example fixed; the denominator is still lost when a source field is corrupted, see F17 |
| F05 summary false positive not scored | A visible unmatched summary is now counted as FP and fails expect_clean | Original example fixed; for repeated summary matching and the completeness definition see F15/F16 |
| F08 addressed called fixed | The UI is changed to `with later changes (fix not verified)` | Display problem fixed; the causal fix rate is still unmeasured |
| F07 incomplete context | main is still the path described in the first round; there is also the unmerged PR #191 | An in-review PR must not be treated as a deployed result, see below |
| F04/F06/F09/F10/F11/F12 | weak_test semantics, historical invalidation, model tier, issue freshness, standards/pushdown pilot, version acceptance | No new closing evidence this round; remain open |

The [first-batch fix record](reliability-hardening-2026-10-15-batch1.md) self-reports the full suite as 1056 pass, 0 fail, 1 skip, 1 todo; this document did not re-run the full suite, and independently checks the relevant paths with the tests and probes limited below.

### Actual progress on GitHub

- **Kite has no new runs.** The re-check still returns a total of 80; the latest PR reviews are still those ten runs at 2026-10-14 09:46–09:47 UTC, and the latest [scan #12](https://github.com/Mira190/Kite/actions/runs/38515926303) is still the old version from 05:18 UTC. It cannot be claimed that the first batch of fixes has passed a new round of online acceptance on Kite.
- **SpecGuard PR #190 has been merged.** The [last bot summary](https://github.com/Mira190/SpecGuard/pull/190#issuecomment-6179321352) gives a reduced review and no high-confidence gap, with machine status `complete:false`, and 5 of the 7 obligations are unit evidence. It proves the reviewer saw part of the newly added protection; it does not prove the fix has exhausted the boundaries; the residual counterexamples in this round can all be reproduced on the merged version.
- **PR #191 is not merged yet.** [Fix incomplete scan evidence and isolate offline engine tests](https://github.com/Mira190/SpecGuard/pull/191), head `5cac39cb9a3d7f0ae3815f67ce3415e670383ab3`, the normal [CI](https://github.com/Mira190/SpecGuard/actions/runs/38676856532) succeeded, and the review timeline that could be read is empty. Static inspection of its diff: it adds window truncation / read failure records, keeps the unit due when matched tests are incomplete, propagates `blockCuts` for split documents, and does the npm install in isolated offline tests. It correctly narrows the scope of F07, and it also explicitly does not implement a large-file progress cursor, a single-call completeness protocol or real model verification. This document did not check out, run or approve that PR; the code-level reproductions below all target the merged main.

The obligation table of PR #190 also has a product problem worth tracking: O4 requires a "direct assertion" for the private `esc` helper, and O7 is likewise about direct tests of the local `tidy` helper, while the output itself admits there is indirect coverage or insufficient context. They were not raised as high findings, so they are not counted as new false positives; but adding such implementation details to the denominator of "5/7" makes the coverage ratio depend on how the code is split. The goal should be to protect observable behavior, not to require every private helper to have a direct test. The "inline ↔ extracted equivalent helper" transformation should be used to verify that the number of obligations and the risk conclusion are stable.

## 3. Must be handled first

P1 below means it should be resolved before adoption is widened or the report is used for quality decisions; P2 is a reliability problem with a clear reproduction but a narrower impact. Local simulations are not interpreted as real leaks or real production incidents.

### F13 · P1 · Variables, comments and imports are still recognized as valid assertions

**What happened:** The evidence check newly added to scan calls [post.assertionKind](../src/post.js#L140), which uses the [ASSERTION regex](../src/post.js#L137). This regex allows words such as `Expect*`/`Assert*`, does not require them to be assertion calls, and does not exclude comments or import/require declarations. [audit-post](../src/audit-post.js#L230) can therefore still keep a "really existing but invalid reference" as covered.

**Reproduction:** Set the only content of the test file to any one of the lines below, and give scan a unit citation pointing at that line, together with a valid requirement and code citation. All three examples get `assertionKind=assertion`, `status=covered`:

```js
const expectedTotal = 42;
// assert.equal(total, 42);
const assert = require('node:assert/strict');
```

These files have no executable assertion protecting the target behavior, and not even a test. This is not being harsh on unknown frameworks; it is a false positive on the most common JS lexical structures. The shared verifier makes this problem affect the positive-evidence judgment of both PR and scan; this round verified scan directly, and the PR call site is in [verifyEvidence](../src/post.js#L957).

**Minimal fix:** Separate "a recognizable assertion call" from "text containing a related word", and first exclude definitely-invalid cases such as comments, imports and pure assignments; helpers that cannot be judged stay unknown and are not upgraded to covered. Reusing the shared entry is right, but the common rule needs to be fixed, rather than adding exceptions to the two modes separately.

**Cost of not fixing, and acceptance:** Developers get protection that does not exist. The three examples above must be unknown; a real `assert.equal`, a real predicate assertion and supported non-JS assertions must still keep the correct evidence. Passing static recognition still does not mean CI actually executes it.

### F14 · P1 · The new table rule does not associate data with assertions, so irrelevant data can erase a real lead

**What happened:** [assertionDelta](../src/leads.js#L236) only requires "a newly added assertion call to a function of the same name" and "any newly added line containing the old literal sequence". It does not require that line to be consumed by that assertion. The heuristic added to reduce the original false positive therefore suppresses a real deletion.

**Reproduction:** The change below really removes the protection of `next(2)`. `otherCases` is not used, and the new assertion only checks 10. The current `assertionDelta` nevertheless returns `[]`:

```diff
-assert.equal(next(2), 3);
+const otherCases = [[2, 3]];
+assert.equal(next(10), 11);
```

What is confirmed here is that a **deterministic lead is wrongly deleted**; it is not a claim that the model will certainly miss it: the model may still find the problem independently, but the lead that was supposed to help it is lost. The root cause of the first-round problem — treating a lexical difference / similarity as a behavior-coverage conclusion — has not gone away.

**Minimal fix:** When it cannot be proven that the data really belongs to the relevant loop/assertion, keep a "deletion lead to be checked"; at the same time, drop the strong inference of automatically generating a high finding from an uncertain lead. If exact migration recognition is kept, suppress only the shapes where a local data association can be established, and no longer fall back on whole-file co-occurrence. A whole-language data-flow analyzer need not be built for this.

**Cost of not fixing, and acceptance:** A silent miss is introduced in order to remove a false positive. A complete migration should be quiet; deleting a row should keep the lead; adding an irrelevant array, another test fixture or dead code must not change the latter conclusion.

### F15 · P1 · One summary finding can be counted as two TPs

**What happened:** [grade.js](../eval/grade.js#L109) uses `summaryHits.some(...)` to decide a hit, and then uses `usedItems` to avoid that item being counted as FP; but the hit check of the next expectation can still use the same item. Inline comments already have a one-to-one consumption logic; the summary path does not.

**Reproduction:** Two expected findings point respectively at boundary A at `a.js:10` and boundary B at `a.js:30`, and both allow summary. The actual output has only one unrelated missing_test at `a.js:900`. The current result is:

```text
observed actionable items = 1
tp = 2, fp = 0, fn = 0, pass = true
```

The summary's loose matching of kind/path is a rule that is stated explicitly; this finding is not only complaining that the tolerance is wide, but that **the same observation is consumed repeatedly**, and the summary path skips the expected behavior-text check. The synthetic example shows the score can exceed the amount of evidence; it is not used to infer how much the historical evaluations have been over-counted.

**Minimal fix:** Make the summary item / coverage row a candidate with a stable identity that can be consumed only once, sharing the matching rule with inline results. The LEFT-side position tolerance should be kept as needed, but if a fixture specifies behavior text / source, it should be verified as usual. Do not avoid FPs by making all matching wider.

**Cost of not fixing, and acceptance:** Missing the second boundary still gets a full hit, misleading prompt/model selection. Add controls for two expectations with one result, the same kind and same file but different semantics, and the summary and inline presentations duplicating each other; the TP count cannot exceed the number of observations that can be independently mapped.

### F18 · P1 · The cross-repository scan issue does not enforce the existing visibility boundary

**What happened:** The manual workflow's [visibility guard](../.github/workflows/specguard-run.yml#L81) blocks output of a non-public target to a public control; but the composite action directly offers [`scan_issue_repo` and `scan_issue_token`](../action.yml#L43). After resolving the target, [audit-post](../src/audit-post.js#L620) looks up/creates the issue, and before [publish](../src/audit-post.js#L643) it does not check the source/target visibility. The only production place in the repository that calls `visibility-guard.js` is the manual workflow above; calling the action directly does not go through it.

**Reproduction:** Using temporary, actually Git-tracked synthetic requirements/source and the real `audit-post`, set the context to `org/private-source` and `ISSUE_REPO=org/public-reports`. Both GitHub clients are local mocks, whose metadata interface can return private/public; the publish API only records the arguments. Actual result:

```text
destination = org/public-reports
body contains source requirement text = true
repository visibility queries = 0
status = complete
real network calls / real issues created = 0 / 0
```

**Conditions for impact:** The deployer explicitly configures a cross-repository destination and provides credentials that can write issues there. This is not a low-privilege user bypassing GitHub authorization, and no real data leak was found; the risk is that a supported configuration bypasses the output protection already enforced at another entry. Having write permission does not mean the readers of the output are the same as the readers of the source repository.

**Minimal fix:** Put the audience check at the common publishing boundary or at all action entries, check the actual source and the actual issue destination, and refuse cross-boundary publishing when unknown; reuse the existing decision function. Keep legitimate same-repository / same-audience publishing. The fine-grained member permissions of private and internal still need separate specification, and a visibility check cannot prove the ACLs are fully consistent.

**Cost of not fixing, and acceptance:** A mismatched destination may write non-public requirements / code snippets into an issue with a broader audience. Use fake clients to verify that private→public does not write, that unreadable metadata does not write, and that legitimate publishing still succeeds; do not use real private source for this canary.

## 4. Remaining boundaries that should be fixed

### F16 · P2 · Run completeness is lost between the producer and the grader

**What happened:** [parseSummary](../eval/grade.js#L74) relies on a few old English phrases to recognize incomplete, and does not read the existing `specguard:status=incomplete` or counts.complete. In the end [grade](../eval/grade.js#L148) can therefore call a report that the producer explicitly marked incomplete complete.

**Reproduction:** The final summary of PR #190 read this time contains `complete:false` and an incomplete marker. Using its original text as the observation, with a synthetic state-check case with `expect_clean:true`, gives `machineIncomplete=true, gradeComplete=true, gradePass=true, degraded=true`. This is not a claim that PR #190 actually owns that fixture; it is a contract check of the real output and the real parser. A purely synthetic minimal marker example reproduces the same.

**Minimal fix:** Consume the existing machine status first, and then do compatible text parsing for old reports; if "was execution completed" and "was quality reduced" need different definitions, split the fields explicitly. Do not force all fast models to be judged as failures, and do not treat contradictory complete values as the same metric.

**Cost of not fixing, and acceptance:** A run that the producer side does not count in outcomes can enter the fully passing sample on the evaluation side, misaligning comparisons and trend definitions. For each legal production state, verify the grader's read result with real render output, and avoid self-consistent tests on hand-written summaries.

### F17 · P2 · When a classification conflict meets a corrupted source, an obligation can still disappear from the denominator

**What happened:** [validate](../src/audit-post.js#L111) has already recognized the conflict, but `conflicts.add(cid)` comes after the source-field validation. If the source is missing/corrupted, that row is dropped early and not_requirement is still kept; the later verify treats this cid as already excluded and does not add unknown.

**Reproduction:** Two listed blocks each have one requirement; the first is also in not_requirements, with `source=null`, and the second is valid. Because the bad row accounts for only half, the overall validate succeeds. The verify result keeps only the second requirement, and the first stays in not_requirements. The original normal-source conflict control does get unknown.

**Minimal fix:** Register the classification conflict before the row can be dropped early; use a trusted candidate to recover a minimal unknown record, or let verify add unknown for a block that has a conflict but cannot be verified. When the model cannot provide a qualified citation, it must not thereby gain the power to delete an obligation.

**Cost of not fixing, and acceptance:** Structural degradation combined with a semantic conflict shrinks the denominator again. Add paired controls for a missing source, an illegal line number, and duplicated/split sub-lines; an atomic obligation is always one of reviewed, unknown or explicitly not reviewed, and cannot become a non-requirement because of a conflict.

## 5. Common root causes from first principles

The most important thing in this round is not adding six heuristics, but distinguishing three different responsibilities:

| Responsibility | Appropriate means | Boundary that must not be crossed |
|---|---|---|
| Searching for candidates | Function names, text, literals, position, similarity | A candidate hit does not constitute covered; a missing candidate does not prove there is no test |
| Adjudicating conclusions | Observable behavior, input→expectation, whether the test actually constrains that behavior | Irrelevant data cannot serve as migration proof; uncertainty should not be upgraded to high |
| Evaluating value | One-to-one semantic matching, real run state, human validity and fix results | One output cannot serve as several independent hits; a proxy cannot be renamed a causal benefit |

F13 is a search regex overstepping into positive proof; F14 is a co-occurrence relation overstepping into substitution proof; F15 is loose retrieval overstepping into multiple hits; F17 is a structural failure overstepping into excluding an obligation; F18 is an entry protection mistaken for all exits being protected. All of them can happen while the JSON is valid, the citations exist and the test suite is all green.

Therefore, the next step of shift left should first ensure that **reports do not create false protection, evaluation does not reward wrong judgments, and output does not cross an unverified audience boundary**. This is closer to the user's actual goal than continuing to add finding categories.

## 6. The next set of acceptance criteria should revolve around invariants

| Invariant | Minimum controls needed | Corresponding problem |
|---|---|---|
| A name/comment does not create test protection | expected variable, assert import, comment; a positive example with a real assertion | F13 |
| Adding irrelevant data does not delete a real risk | An irrelevant array, an unconsumed fixture; a real complete migration and a real missing row | F14 |
| One observation matches at most one independent target | Two boundaries in the same file with a single item; multiple items; de-duplication across delivery methods | F15 |
| The same state has the same meaning across components | Feed each of the producer's complete/incomplete/failed/skipped/reduced outputs to the grader | F16 |
| Information corruption can only lower confidence, not raise coverage or shrink the obligation set | Classification conflict combined with a bad citation, omissions and partial output | F17 |
| All output exits preserve the authorized audience boundary | manual/direct action, same repo/cross repo, create/update, metadata unknown | F18 |
| Code organization does not change the behavior-coverage denominator | Private helper extraction/inlining, function renaming, behavior and tests unchanged | PR #190 obligation observation |

Suggested order: first fix the F18 publishing boundary and the F13 false covered; fix F14 and F15 in step, to avoid de-noising on one side while rewarding misses on the other; then fix F16/F17. Re-run the original counterexamples and the adjacent reverse controls, and only after that run a Kite canary on a pinned SHA. The F07 improvement in PR #191 can be reviewed and advanced independently, but it cannot replace the semantic and scoring fixes above.

The first-round conclusions about human adoption rate, effective fixes, standards confirmation, real pushdown benefit and QA defect reduction still stand: this round added no new evidence that these goals have been achieved.

## 7. Verification record and limits

- Isolated worktree, frozen at `d3234e3`; the user's main workspace and existing uncommitted files were left alone.
- Environment: Windows / Node `v26.11.1`; the repository's CI target is still Ubuntu/Node22.
- The four fix controls for the original F01/F02/F03/F05 all passed; the F08 wording was confirmed by the diff and existing regressions.
- The three non-assertion references of F13 all got covered; the irrelevant table of F14 made the lead disappear; the single item of F15 got two TPs; both the synthetic marker of F16 and the original text of PR #190 show state inconsistency; the conflict of F17's corrupted source was still excluded; F18 recorded cross-repo publishing without a visibility check in a local fixture with real tracked files.
- Ran `node --test --test-concurrency=3 src/audit-post.test.js src/leads.test.js eval/grade.test.js`: **103 tests, 102 pass, 0 fail, 1 skip, about 19.2 seconds**. This proves the existing tests pass, and also shows the new counterexamples are not covered by these tests; it does not represent a full-suite regression or model-quality acceptance.
- Only online GitHub data was read; the mocks sent no network requests. No new Kite / paid-model run was made, PR #191 was not run, and neither human adoption nor the production defect rate was evaluated.

**Judgment: continuing as advisory is valuable, but the next "fix complete" should be judged by the cross-path invariants and positive/negative controls, and not merely by the original cases turning green, the bot commenting no more, or CI succeeding.**
