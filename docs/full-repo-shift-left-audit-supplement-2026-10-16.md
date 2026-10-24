# Full-repo shift-left audit supplement: coverage record and 27 reproduced defects (plus 1 by design)

What this repo does: At the PR stage SpecGuard links requirements, code, tests and repo rules, flags missing or weak unit tests, and also provides a rotating full-repo scan. This document supplements the [main report](full-repo-shift-left-audit-2026-10-16.md) and does not repeat its F19–F29.

## 1. Title and scope

Date: 2026-10-16. Baseline: `origin/main` `ee1c15812bae4315f39ce7d5bf1bf7511ac58553`. Nature: the report is committed only; no product code is changed.

**Purpose:** fill in the files that §2 of the main report did not cover or did not read in depth, so that the full-repo audit is complete. §2 is a file-by-file coverage record, and §3 holds the 27 defects found by the additional reading plus 1 by design (probe IDs S1–S14, U1–U13, V1–V2; U13 is a one-line verification).

**Evidence standard:** every item is reproduced by a probe, and the probe asserts the **current behaviour**. No real model was called and no real GitHub was accessed (GitHub and `gh` are local mocks; `collect.sh` really ran in a temporary git repo). A probe passing only proves that the wrong behaviour exists; it is **not** a product test passing and **not** a fix passing. All numbers come from the JSON results in appendices A and B (the S series in appendix A, the U series in appendix B). U13 is a `node -e` one-line verification added during fact checking; it is not in the probe scripts, and its output is in §3.1.

**Limitations:** Windows, Node `v26.11.1`; the `collect.sh` probes put Git for Windows' `bin` and `usr/bin` in front of PATH. The "pinned action ref" fact in S12 depends on the local clone containing that commit. The full Ubuntu/Node 22 CI was not rerun. The S6 probe did not go through the `audit-post` entry point; the fault in S7 was injected by hand.

## 2. Coverage record

Scope: all non-test, non-fixture source, workflow and skill files in `origin/main` (`git ls-tree -r --name-only origin/main`). Markers: **reviewed in the main report** = a key path listed as read in the §2 table of the main report; **read in full in this supplement** = read through in full this time; **partly read in this supplement** = only the passages relevant to the probes were read; **not read** = read neither this time nor in the main report.

| File | Status |
|---|---|
| `src/post.js`, `src/audit-post.js`, `src/audit-collect.js`, `src/audit-units.js`, `src/scan-parts.js`, `src/prompt.js`, `src/preflight.js`, `src/requirements.js`, `src/trace.js`, `src/test-map.js`, `src/engines/claude-api.js` | Reviewed in the main report |
| `src/audit.schema.json`, `src/findings.schema.json` | Reviewed in the main report |
| `action.yml`, `package.json`, `README.md`, `.github/workflows/ci.yml`, `.github/workflows/specguard-run.yml` | Reviewed in the main report |
| `eval/grade.js`, `eval/weekly-report.js` | Reviewed in the main report |
| `src/collect.sh`, `src/coverage.js`, `src/leads.js`, `bin/specguard-local.js`, `eval/label-export.js` | Reviewed in the main report; read in full in this supplement |
| `src/engines/claude.sh`, `src/engines/copilot.sh`, `src/engines/claude-result.js`, `src/engines/_redact.sh`, `src/engines/README.md` | Read in full in this supplement |
| `src/focus.js`, `src/resolve-inputs.js`, `src/extract-json.js`, `src/credential.js`, `src/engine-model.js`, `src/standards-map.js`, `src/checks.js`, `src/superseded.js`, `src/target.js`, `src/fail-on-error.js`, `src/limitations.js`, `src/numdiff.js`, `src/version.js`, `src/visibility-guard.js`, `src/tee-summary.js`, `src/validate-inputs.sh` | Read in full in this supplement |
| `eval/run.js`, `eval/local.js`, `eval/field.js`, `eval/ab.js`, `eval/degrade.js`, `eval/mutate.js`, `eval/bundle.js`, `eval/szz.js`, `eval/prove.js`, `eval/replay.js`, `eval/mirror-workflow.yml` | Read in full in this supplement |
| `bin/pin-reusable.js`, `.github/workflows/specguard.yml` | Read in full in this supplement |
| `.github/instructions/specguard.instructions.md` | Read in full in this supplement |
| `skills/test-review/SKILL.md`, `skills/test-review/references/*`, `skills/spec-audit/SKILL.md` | Read in full in this supplement |
| `.github/skills/test-review/**`, `.github/instructions/test-review.instructions.md`, `ccr/test-review.instructions.md` | Read in full in this supplement (a copy with the same content as `skills/test-review/**`, see below) |
| `eval/aggregate-counts.js`, `eval/signal.js`, `eval/assign.js` | Partly read in this supplement |
| `eval/token/anatomy.js`, `.claude/skills/ste-mini/SKILL.md` | Not read |

Three files that were originally "not read" have now been read, and checked against the same standard (listed only if a probe or a static quotation can prove it):

- `.github/instructions/specguard.instructions.md` (the repo's own coding standard, `applyTo: "src/**,eval/*.js"`): its line 8 requires "every exported function needs a unit test that asserts the return value or the thrown error", which the repo itself does not satisfy, see V1. The other rules (Node 22, no dependencies, `node:test`, test naming, do not throw strings): `throw '...'` appears only in the deliberate cases `eval/cases/s1` and `s2`; there is none in the source.
- `eval/replay.js`: replay only counts summary items and inline comments (`countFindings`) and does no TP/FP scoring, so it is not affected by the double counting of S10/F29. One item found: a PR with `findings_present=false` is printed as an all-zero row, see V2.
- `src/engines/README.md`: checked line by line against the code; `MODEL` empty → `claude-haiku-5-5` (`claude-api.js:281`), `CONTEXT_PACK_BYTES` default 250000 (`:285`), per-file 48 KiB and 2 MiB (`:64`), and the alias mapping (`credential.js:10`) are all consistent; "`engine-status` defaults to success when absent" (README:37) and "An engine note says how many files went in and which did not fit" (README:61) give corroborating evidence for S7: when packing fails there is no such note (the `engine.notes` of S7 has only the price estimate). Read; no new findings.

**Coverage check (script):** `coverage-check.cjs` (appendix C) takes `git ls-tree -r --name-only origin/main`, subtracts the out-of-scope patterns below, and then computes the set difference against the paths and wildcards that appear in this table:

| Out-of-scope pattern | Reason |
|---|---|
| `**/*.test.js`, `test/**`, `tests/**`, `**/fixtures/**` | The task explicitly excludes tests and fixtures |
| `eval/cases/**`, `eval/replay/*.json` | Evaluation input data, not executed code |
| `eval/results/**` | Artifacts of historical runs |
| `docs/**` | Historical research and review documents, not loaded by the product |
| `research/**` | External research material, not loaded by the product |
| `eval/**/README.md` | Evaluation documentation, no runtime behaviour |
| `NOTICE` | License notice, no runtime behaviour |
| `.gitattributes`, `.gitignore` | Repo metadata (line endings, ignore rules), does not affect the reviewed behaviour |

Counts: `git ls-tree` gives 543 paths in total; out of scope 459; in scope 84; listed in the table 84; set difference 0 (empty). The table has 71 wildcards, 0 of which matched no path and 0 of which matched a path outside the scope.

Duplicate copies: the whole directory `.github/skills/test-review/` is byte-for-byte identical to `skills/test-review/` (`diff -rq` prints nothing), so findings in the skill are counted only once. `ccr/test-review.instructions.md` and `.github/instructions/test-review.instructions.md` have the same content once line endings are ignored (the line endings of the working-tree checkouts differ, so the hashes differ).

## 3. Findings

27 defects + 1 by design: P1 PR mode 10 items, P1 scan mode 4 items, P2 5 items, P3 8 items (eval metrics 7 items, the repo's own standard 1 item); in addition S11 is by design and is not counted as a defect. Line numbers all refer to `ee1c158`. "Affected mode": PR (the main shift-left path), scan (full-repo rotation), local (`specguard-local`), eval (evaluation tooling).

### 3.1 P1: PR mode

#### U1 [P1] A missing merge-base is treated as "Nothing to review", and a complete status and head marker are still written

- **Location:** `src/collect.sh:69–70` (warning only), `:87` (`done < <(git diff ...)` failure is checked by no one), `:115` (`nothing reviewable in diff` → `skip true`). **Affected mode:** PR.
- **What this is:** `BASE_SHA` is not in the clone (shallow clone), the three-dot diff fails.
- **Problem:** The failure is treated as an empty diff: `skip=true`, post.js publishes "Nothing to review" and writes the head marker, and afterwards preflight skips the same head.
- **Fix:** When the diff command fails, collect should exit non-zero or produce incomplete; do not treat "could not get the diff" as "no changes".
- **If we skip it:** Adopters without `fetch-depth: 0` get a reassuring "nothing to review" signal, and the real PR is not looked at at all.
- **Evidence U1:** `baseInClone=false`, `collectExit=0`, `collectOutputs=["skip=false","partial=false","skip=true"]`, `diffPatchBytes=0`, `postStatus="complete"`, `summaryHasNothingToReview=true`, `summaryHasHeadMarker=true`. The warning is only on stdout: `::warning::no merge-base of BASE_SHA and HEAD_SHA (shallow clone? ...)`.
- **The regression test should assert:** `BASE_SHA` is not in the clone, collect does not output `skip=true`, and post does not publish "Nothing to review" or write the head marker (expected: non-zero exit or `incomplete`).

#### S2 [P1] An unreadable closing issue: the status is still complete and gets cached

- **Location:** `src/requirements.js:285` (`fact(...)`), `src/limitations.js:4` (`FACT_LIMITATION` contains `Could not read (?:issue|history issue) `), `src/post.js:1528`. **Affected mode:** PR.
- **What this is:** An unreadable reference is classified as a fact (only a note) instead of a gap (which makes the run incomplete).
- **Problem:** The PR declares `Fixes #7`, and reading that issue fails (HTTP 403). The requirement status is `partial`, but the run has `status=complete` and `execution_complete=true`, writes the head marker, and the next push is skipped by preflight. The headline is already worded as "❔ No gaps found; part of the review could not be assessed", not "No unit test gaps found", so the problem is not the wording but the status and the cache. For comparison: when the number of issues exceeds the cap of five, the same kind of omission is judged `incomplete` and no marker is written.
- **Fix:** Make "a declared closing issue could not be read" a gap (or at least do not write the head marker), consistent with the over-cap handling; a permission or transient API error should let the next push retry.
- **If we skip it:** A single 403 or API hiccup caches the requirement-side review of that head as complete permanently.
- **Evidence S2:** `unreadableClosing.status="partial"`, `limitations[0]={l:"Could not read issue #7.",fact:true}`, `run.status="complete"`, `complete=true`, `execution_complete=true`, `headline="❔ No gaps found; part of the review could not be assessed"`, `headMarker=true`, `nextPushSkipped=true`; for comparison `cappedClosing.run.status="incomplete"`, `headMarker=false`.
- **The regression test should assert:** when a closing issue cannot be read, `status` is `incomplete`, there is no head marker, and `nextPushSkipped` is `false`.

#### U5 [P1] An assertion elsewhere with the same subject hides a deleted or weakened assertion

- **Location:** `src/leads.js:263–265` (`same = add.filter(a => a.x === r.x)` takes the new assertions of the whole file; `same.some(a => !a.weak)` is taken to mean "still pinned"). **Affected mode:** PR.
- **What this is:** `assertionDelta` uses the subject to decide whether a deleted assertion has been pinned again.
- **Problem:** `add` collects the new assertions of the whole test file, not limited to a hunk or a test block. If another place in the file adds `expect(result).toBe(true)` and its subject happens to be `result`, the deleted `toEqual({a:1,b:2})` on `result` is not reported. Changing `expect(total(2)).toBe(5)` to `expect(total(2)).toBeGreaterThan(0)` is suppressed in the same way: a non-weak new assertion with the same subject is counted as still pinning, and strength is not compared (inferred from the logic at :265, not probed separately; the probe only proves the result is empty).
- **Fix:** Limit "pinned again" to the same hunk or the same test block; a weaker assertion with the same subject should still be reported as `weakened`.
- **If we skip it:** The purpose of this lead is exactly to flag weakened tests, and the suppression happens at the moment it should flag the most.
- **Evidence U5:** `removedOnly=[{kind:"removed",line:12,old:"expect(result).toEqual({a:1,b:2});"}]`; after adding the unrelated hunk C, `withC=[]`; `weakA` has one `weakened`, `weakAC=[]`; `toBe5ToGreaterThan=[]`, `toBe5Suppressed=true`; for comparison, with a different subject `controlOtherSubject` still reports `removed`. Note: PR #197 (raise low confidence after an assertion is deleted) acts after the lead and does not change whether the lead is produced.
- **The regression test should assert:** after adding the unrelated hunk C, `assertionDelta` still returns `removed` (`withC.length===1`, `weakAC.length===1`); `toBe(5)` → `toBeGreaterThan(0)` returns `weakened`.

#### U6 [P1] Deleting a whole test file produces no lead

- **Location:** `src/leads.js:214` (`+++ /dev/null` → `file = null`). **Affected mode:** PR.
- **What this is:** `assertionDelta` treats `+++ /dev/null` as "no file".
- **Problem:** Deleting the same assertion from a retained file reports `removed`; deleting the whole file produces no output.
- **Fix:** Produce a `removed` lead for the old-side assertions of a `deleted file` as well.
- **If we skip it:** The easiest way to weaken tests (deleting the file) is left out of the check.
- **Evidence U6:** `deletedFile=[]`, `sameAssertionRemovedFromLiveFile=["removed"]`.
- **The regression test should assert:** when a whole test file is deleted, `assertionDelta` returns at least one `removed` (`deletedFile.length>=1`).

#### U3 [P1] The 60-file cap on test candidates is inconsistent with focus selection

- **Location:** `src/collect.sh:248` (`CAP = 16 * 1024`, `MAX_FILES = 60`), `:269` (`(N more changed file(s) not listed)`); `src/focus.js` picks files separately afterwards. **Affected mode:** PR.
- **What this is:** The candidate test table lists only the first 60 changed files; for a large PR focus re-orders by risk.
- **Problem:** When the highest-risk file is ranked after the first 60, it is chosen by focus and its source goes into the pack, but its tests are not in the pack, `notWhole` is empty, `pack-cut.txt` does not exist, and downstream believes all tests are visible.
- **Fix:** Let the candidate table list the files chosen by focus first (or generate the candidates after focus); at the very least record "chosen but has no candidate" in `pack-cut.txt`.
- **If we skip it:** In a large PR the file that most needs test evidence happens to get an input saying "no tests".
- **Evidence U3:** `candidatesListZzz=false`, `candidatesTail="(2 more changed file(s) not listed)"`, `focusPicksZzz=true`, `packHasZzzSource=true`, `packHasZzzTest=false`, `packNotWhole=[]`, `packCutTxt=null`; for comparison `control.packHasZzzTest=true`.
- **The regression test should assert:** the tests of `src/zzz.js`, chosen by focus, are either in the pack (`packHasZzzTest===true`) or named in `pack-cut.txt`/`notWhole`.

#### S3 [P1] A shared large test file is sliced only by the symbols of the first file, and `notWhole` is empty

- **Location:** `src/engines/claude-api.js:182–188` (`seen` de-duplication), `:222` (`unitSymbols`). **Affected mode:** PR.
- **What this is:** When the same test file is hit by several changed source files it is packed only once.
- **Problem:** A shared test file of 66,992 bytes exceeds the per-file cap of 41,666 and is cut into "windows that mention the first file's symbols"; the assertions of the second file are not in the pack, and `notWhole` is still empty.
- **Fix:** Slice by the union of the symbols of all source files that hit it; or, when the second hit finds that the window does not contain its symbols, record it in `notWhole`.
- **If we skip it:** The second file is reported as missing tests while `pack-cut.txt` is empty, so post keeps high confidence.
- **Evidence S3:** `testFileBytes=66992`, `perFileCap=41666`, `aAssertionInPack=true`, `bAssertionInPack=false`, `notWhole=[]`, `testBlockCount=1`.
- **The regression test should assert:** the assertions of both source files are in the pack (`bAssertionInPack===true`), or the shared test file appears in `notWhole`.

#### S7 [P1] A swallowed pack error is treated as "all visible"

- **Location:** `src/engines/claude-api.js:416` (`catch { /* the pack is optional */ }`), `src/scan-parts.js:26` (`catch { return { text: '', note: '', notWhole: [] } }`). **Affected mode:** PR, scan.
- **What this is:** A packing failure is treated as an optional step.
- **Problem:** (a) Single-call path: `contextPack` throws, there is no `pack-cut.txt`, `engine-status` is treated as success, findings are written as usual, and post keeps high confidence; for comparison, when `pack-cut.txt` names that test, the same finding is downgraded to low confidence. (b) Scan path: when `contextPack` throws, the unit pack text is empty and `packCut=[]`.
- **Fix:** Write a packing failure to `pack-cut.txt` (or a failed status), and treat all files as not fully seen.
- **If we skip it:** A packing fault turns "the model saw nothing" into "nothing was cut".
- **Evidence S7:** `engine.status="success (no engine-status file)"`, `packCutFile=false`, `findingsWritten=true`; `postNoPackCut.postedHighConfidence=1`, `lowConfidenceNote=false`; `postPackCutNamesTest.postedHighConfidence=0`, `lowConfidenceNote=true`; `scanParts.parts=3`, `unitPackText=""`, `packCut=[]`. The fault was injected by hand (the `injected` field in appendix A); what it proves is a gap in error handling, not that this fault is common.
- **The regression test should assert:** when `contextPack` throws, `pack-cut.txt` is non-empty (or `engine-status` is not success) and `postedHighConfidence===0`; the `packCut` of the scan path is non-empty.

#### S8 [P1] The 20-character prefix of `findLine` accepts a different expected value and rewrites the quotation

- **Location:** `src/post.js:349` (`findLine`) and `verifyEvidence`.**Affected mode:** PR.
- **What this is:** For longer quotations, `findLine` compares only the first 20 non-whitespace characters.
- **Problem:** The model quotes `assert.equal(compute(1), 2)`, the actual line is `assert.equal(compute(1), 3);`, the prefixes are the same, and the quotation is judged valid and **rewritten** to the actual line; `status` stays `covered`, with no note or downgrade.
- **Fix:** After the prefix matches, still compare the normalised text of the whole quotation; if they differ, count the quotation as unverified, or downgrade and add a note when rewriting.
- **If we skip it:** An expected value invented by the model is quietly corrected, and the coverage conclusion looks confirmed by the evidence.
- **Evidence S8:** `longerQuote.findLine=2`, `verifyEvidence.status="covered"`, `evidenceQuoteAfter="assert.equal(compute(1), 3);"`, `noteOrDowngrade=[]`. Boundary: a quotation of exactly 20 non-whitespace characters is not affected (`briefQuoteLiteral.matchesLine=0`).
- **The regression test should assert:** the quotation `assert.equal(compute(1), 2)` against the actual line `assert.equal(compute(1), 3);` must not become `covered` evidence (`findLine===0`, or the evidence is downgraded with a note).

#### S13 [P1] The preflight skip key ignores rule files, configuration, the model and the SpecGuard version

- **Location:** `src/preflight.js:30` (`reqKey`: title+body), `:48` (`decide`). **Affected mode:** PR.
- **What this is:** When a SpecGuard summary already exists for the same head and the same title/body, this run is skipped.
- **Problem:** The inputs of `decide` are only `pr, comments, headSha, includeBots, force, actor, issueAt`; the markers in a real summary are `summary, head, counts, req, status`, and there is no marker for rule files, configuration or model. After a rule file update on the base branch, a configuration change or a model switch, the same head is still skipped.
- **Fix:** Write the content hash of the rule files, the key configuration, and the model and version into the summary marker, to be compared by `decide`. The existing escape hatch is `force: true`, which the user has to know about first.
- **If we skip it:** An adopter changes the rules, expects them to take effect on the next push, and instead sees "already has a SpecGuard summary".
- **Evidence S13:** Same head/title/body: `"head 07fe197 already has a SpecGuard summary (set force: true to rerun)"`; if the title is changed, `"review (no skip)"`; `markersInRealSummary=["summary","head","counts","req","status"]`, `markerForRulesConfigOrModel=false`.
- **The regression test should assert:** after a change in the rule files, configuration, model or version, `decide` for the same head does not return a skip.

#### U13 (new, found while fact-checking the research document) [P1] `AC-1:` is not recognised as a structured acceptance criterion

- **Location:** `src/requirements.js:62` (`/^\s*AC\s*\d+\s*[:：]\s*(.+)$/i`), `:216` (the second place of the same form). **Affected mode:** PR.
- **What this is:** `extractCriteria` produces deterministic R items from structured AC blocks and `AC<n>:` lines.
- **Problem:** `AC\s*\d+` only allows whitespace between `AC` and the digits; `AC-1:` and `AC.1:` do not match and produce no R item, while `AC1:` and `AC 1:` do. Narrative requirements are still left to the model to interpret, so the consequence is a missing deterministic R item and its trace row, not the requirement being ignored altogether.
- **Fix:** Allow `[\s._-]*` as the separator, and change `:62` and `:216` together.
- **If we skip it:** A repo that writes its acceptance criteria as `AC-1:` gets less structured R→T traceability than one that uses `AC1:`.
- **Evidence U13 (this time a direct `node -e` call of `extractCriteria`):**

```
"AC1: Reject negative amounts"   => [{"id":"R1","source":"PR body","quote":"Reject negative amounts"}]
"AC-1: Reject negative amounts"  => []
"AC 1: Reject negative amounts"  => [{"id":"R1","source":"PR body","quote":"Reject negative amounts"}]
"AC.1: Reject negative amounts"  => []
```

**Cross-reference (no separate number):** F32 of the research document (Gherkin `Background` is dropped) also affects PR mode: `src/trace.js:254` (`if (/^(Feature|Rule|Background)$/.test(s.kind)) return;`) skips `Background` directly in the chunking loop, so its preconditions do not enter the identity of any scenario. For details see the [research document](research-repo-audit-requirements-chunking-2026-10-16.md) , F32; this document does not repeat it.

- **The regression test should assert (U13):** `extractCriteria([{source:"PR body",text:"AC-1: Reject negative amounts"}])` returns 1 R item.
- **The regression test should assert (F32):** after the preconditions of `Background` are modified, the identity and version (including the `tv` of #203) of the scenarios it affects change, and the old `covered` status expires.

### 3.2 P1: scan mode

#### S5 [P1] A unit that has only low-confidence findings is recorded as covered

- **Location:** `src/audit-post.js:383` (unit state: `hit.has(cid) ? 'gap' : ... 'covered'`), `:759` (`code.findings.filter((f) => !f.low)`). **Affected mode:** scan.
- **What this is:** A low-confidence finding is shown only in Details and is not counted.
- **Problem:** The only finding of a unit lacks a test sketch and is marked `low` (`lowWhy: "no test sketch: the finding may not be a gap"`), the state derivation ignores it, and the unit is written as `covered`; the same finding with a sketch is written as `gap`.
- **Fix:** Write a unit that has a low finding as `unsure`, and do not advance it to covered. This problem is under review in PR #201 (see §4); it is listed here because it has an independent probe.
- **If we skip it:** A possibly real finding of the model is laundered into reviewed because a format field is missing.
- **Evidence S5:** `lowFinding.low=true`, `status="complete"`, `unitStateInIssue="covered"`; for comparison `control.low=false`, `unitStateInIssue="gap"`.
- **The regression test should assert:** a unit that has only low-confidence findings has the state `unsure`, not `covered` (`unitStateInIssue!=="covered"`).

#### S4 [P1] `EV_PER_BLOCK=8` truncation: a change to the 9th cited file does not make the block stale

- **Location:** `src/audit-post.js:347` (`EV_PER_BLOCK = 8`), `:351`, `:357`. **Affected mode:** scan.
- **What this is:** The state of each block stores the hashes of at most 8 evidence files.
- **Problem:** A block cites 9 files and only the first 8 are stored; if only the 9th file is changed, the block is not marked stale and keeps carrying `covered`.
- **Fix:** Store an aggregate hash of the hashes of all cited files; or mark the block as unverifiable when over the limit.
- **If we skip it:** A block with a lot of evidence has the largest dependency surface and is the most likely to be changed, yet it is the least likely to be re-reviewed.
- **Evidence S4:** `citedFiles=9`, `storedHashes=8`, `ninthFileEdited_blockStale=false`; for comparison `firstFileEdited_blockStale=true`.
- **The regression test should assert:** when only the 9th cited file is changed the block is stale (`ninthFileEdited_blockStale===true`).

#### S6 [P1] An unanswered block is recorded with today's review date and sinks to the bottom in the rotation

- **Location:** `src/audit-post.js:383–386` (the state is written with this run's date, `when(b)` takes `b.at.date`); the oldest-first layer of `src/audit-collect.js` reads that date. **Affected mode:** scan.
- **What this is:** The rotation goes oldest-first by the stored review date.
- **Problem:** A block the model did not answer (`verify` yields `unknown`, with the note "did not assess") is written as `unsure`, with this run's date. In the next round oldest-first ranks it after A and B (answered, covered).
- **Fix:** Do not let an unanswered block stay at the front indefinitely (that would cause a new stall). In the next round put it in the priority layer and retry once; if it is unanswered for two consecutive rounds, record it as `unsure`, advance its date, and name it in limitations as "unanswered in consecutive rounds", so the rotation keeps moving.
- **If we skip it:** The block the model was least able to handle is pushed to the back of the queue.
- **Evidence S6:** `stored.C_unanswered=["unsure","2026-10-15"]`, `stored.D_not_sent=["covered","2026-10-01"]`; `nextRunCap1=["D"]`, `nextRunCap3=["A","B","D"]` (C is squeezed out). This probe goes through `verify/stateOf/readState/collect` and does **not** go through the `audit-post` entry point.
- **The regression test should assert:** after C goes unanswered in round 2, the selection of round 3 includes C (`nextRunCap3` includes C); if C is still unanswered in round 3, its date advances, and "unanswered in consecutive rounds" appears in limitations naming C.

#### S14 = research F34 [P1] Source files larger than 512 KiB are silently excluded

- **Location:** `src/audit-units.js:13` (`MAX_FILE = 512 * 1024`), `:89` (`e.size <= MAX_FILE`). **Affected mode:** scan.
- **What this is / Problem:** Source files over the limit are filtered out before entering the inventory; there is no limitation, and they appear in neither meta nor ctx.
- **Fix:** Write the skipped files and the reason into `limitations`, and show them in the issue summary.
- **If we skip it:** The largest files are often the most complex, yet they are never scanned, and the user cannot see this.
- **Evidence S14:** `bigFileBytes=633787`, `inventoryRows=["src/small.js"]`, `limitationsFromInventory=[]`, `metaLimitations=[]`, `bigFileMentionedAnywhereInCtx=false`. It is the same problem as research F34 and is not counted twice.
- **The regression test should assert:** a source file over 512 KiB appears in `limitations` with the file named (`limitationsFromInventory` is non-empty).

### 3.3 P2

#### U2 [P2] Changes in a nested `build/` directory are silently ignored

- **Location:** `src/collect.sh:27` (the default IGNORES contains `build/`), `:84`. **Affected mode:** PR.
- **What this is / Problem:** `build/` matches a path segment at any level, so `internal/build/x.go` (real Go source) is ignored; when a whole PR changes only it, `skip=true`, the output is "nothing reviewable in diff", and `collect-limits.txt` and `diff-dropped.txt` are both 0 bytes, leaving no record at all.
- **Fix:** Write files dropped by the default ignore to `diff-dropped.txt` and show them in the summary; or make the default ignore match only the `build/` at the repo root.
- **If we skip it:** A source package whose directory happens to be called `build` is never reviewed, and the reason cannot be seen.
- **Evidence U2:** `outputs=["skip=false","partial=false","skip=true"]`, `stdout="nothing reviewable in diff"`, `collectLimitsBytes=0`, `diffDroppedBytes=0`; for comparison `controlOutputs=["skip=false","partial=false"]`, `controlFiles="internal/other/y.go\n"`.
- **The regression test should assert:** a change to `internal/build/x.go` is either reviewed (`skip=false`) or appears in `diff-dropped.txt` (`diffDroppedBytes>0`).

#### U4 [P2] `--fail-on-gaps` returns 0 for a failed run

- **Location:** `bin/specguard-local.js:183–185` (`gaps`), `:205` (`return o['fail-on-gaps'] && r.gaps ? 1 : 0`). **Affected mode:** local.
- **What this is / Problem:** The exit code looks only at `gaps`. When findings is not valid JSON, `status="failed"` and `gaps=false`, the exit code is 0, and the summary says "Could not complete: no valid findings.json". An incomplete report with `unknown` rows and `not_reviewed` also gives 0. USAGE describes it as advisory, so this is a behavioural boundary, not a documentation contradiction.
- **Fix:** Make `--fail-on-gaps` exit non-zero also when `status` is not `complete` (or add a separate `--fail-on-incomplete`).
- **If we skip it:** Someone who uses it as a pre-push gate is let through when the review fails.
- **Evidence U4:** `failedRun={exit:0,status:"failed",gaps:false}`; `partialRun={exit:0,status:"complete",gaps:false}` (the report contains `unknown` rows and the status is still `complete`).
- **The regression test should assert:** when `status==="failed"`, the exit code of `--fail-on-gaps` is non-zero.

#### S1 / U12 [P2] `test_paths` containing only exclusions is ignored (S1 and U12 are the same problem)

- **Location:** `src/trace.js:535` (`testScope` returns `null` when there are no include lines); consumers `src/collect.sh:252–253`, `src/audit-collect.js:47–51`, `src/audit-units.js:85–87`, `src/leads.js:286–287`, `src/test-map.js:137`. **Affected mode:** PR, scan, local.
- **What this is / Problem:** `test_paths: "!tests/legacy/**"` makes `testScope` return `null`, which is the same as not configured, so the consumers fall back to judging by file name and the exclusion has no effect; `scan_paths` uses the same `!` syntax and does take effect.
- **Fix:** Make `testScope` return a "default judgement plus exclusion" function for a configuration with only exclusions; or reject it with a message at the input validation stage.
- **If we skip it:** The user configured an exclusion, yet the old tests are still used as evidence.
- **Evidence S1:** `testScopeForExclusionOnly=null`, `layoutHeaderShowsConfig=false`, `layoutLists="test directories: tests/legacy (1), tests/new (1)"`, `unitTestsColumn="tests/new/amount.test.js, tests/legacy/old.test.js"`; for comparison `scan_paths`: `"tests/new/amount.test.js"`. **U12:** `scopeIsNull=true`, `legacyTestStillATest=true`.
- **The regression test should assert:** `testScope("!legacy/**")` is not `null`, `legacy/a.test.js` is not treated as a test, and `unitTestsColumn` does not contain `tests/legacy/old.test.js`.

#### S12 [P2] The reusable workflow forwards only 12 of the action's 47 inputs

- **Location:** `.github/workflows/specguard.yml:14` (`workflow_call`), `:36–37` (`uses: Mira190/SpecGuard@caa99fbbef...` 's `with:`). **Affected mode:** PR, scan.
- **What this is / Problem:** `action.yml` has 47 inputs and the workflow forwards only 12. The 7 exposed by `workflow_call` (`mode, requirements_paths, standards_paths, test_paths, scan_issue, model, effort`) are all forwarded, and there is no "exposed but not forwarded". Important ones among the 35 not forwarded: `engine`, `max_budget_usd`, `ignore`, `max_diff_kb`, `focus_threshold`, `focus_files`, `max_comments`, `standards_checks`, `standards_ref`, `coverage_files`, `resolve_stale`, `force`, `include_bots`, `fail_on_error`, `max_units`, `scan_paths`, `scan_issue_repo`, `scan_issue_token`, `scan_batch_blocks`, `audit_max_requirements`. Adopters who use it through the reusable workflow cannot set them; `force` (the preflight escape hatch of S13) is among them.
- **Fix:** Forward all inputs, or state in the README which ones can only be used by using the action directly.
- **If we skip it:** Switches that adopters believe they can set are in fact not passed in.
- **Evidence S12:** `actionInputs=47`, `forwarded=12`, `workflowCallInputsNotForwarded=[]`, `forwardedButNotDeclaredInAction=[]`, `actionInputsNotForwarded` has 35 items in total (appendix A); `pinnedActionRef={pin:"caa99fbbef",inputsAtPin:45}`, i.e. the action commit pinned by the workflow has 2 fewer inputs than main.
- **The regression test should assert:** the set of forwarded inputs equals the set of inputs of `action.yml` (`actionInputsNotForwarded` is empty), or the allowlist listed in the README matches the actual state.

#### U9 [P2] The skill example contradicts the boundary rule

- **Location:** `skills/test-review/references/trace.md:44`, `skills/test-review/references/example.json:4` (`.github/skills/test-review/` is a byte-identical copy). **Affected mode:** PR.
- **What this is / Problem:** The rule requires both sides of the boundary; the example nevertheless judges `covered` with a single assertion.
  - trace.md:44: `A test must assert both sides of the boundary (n-1, n, n+1); if it does not, report `weak_test` for the missing boundary.`
  - example.json:4: `"obligation":"Orders of 100 or more get a 10% discount"`, `"evidence":[{"path":"test/discount.test.js","line":9,"quote":"assert.equal(discount(100), 90);"}]`, `"status":"covered"`, `"reason":"The unit test asserts the boundary 100 against the literal 90."`
- **Fix:** Change the example so that both sides have assertions, or change the example to `weak_test`; the model treats the example as a precedent, so it should agree with the rule.
- **If we skip it:** The model is more likely to imitate the example: report covered with an assertion on only the `n` side (the degree of impact was not measured, no model was called).
- **Evidence U9:** `evidenceAssertions=["assert.equal(discount(100)"]`, the example evidence has only this 1 assertion.
- **The regression test should assert:** the `covered` evidence of `example.json` contains assertions on both sides of the boundary, or the status of that example is `weak_test`.

### 3.4 P3: eval metrics and the repo's own standard

Apart from V1, these affect only the numbers of the offline evaluation and not the run results of PR or scan. V1 is that the repo's own coding standard is not met.

- **S9:** `eval/weekly-report.js:62–68` and `post.anchorTouched/testsChanged` (`src/post.js:1295`, `:1317`) have different rules. After the base is merged into the PR branch, weekly judges `anchor_touched=true, tests_changed=true, outcome="addressed"`, while the post rules judge `false/false/"open"`; when the file holding the comment is deleted, weekly judges `addressed`, while the post rules give `anchor_touched=null`, `"not_observed"`. Effect: a base merge raises the reviewer's "addressed" rate. The regression test should assert: weekly and post give the same `anchor_touched`/`tests_changed` for the same input (`false/false` for the base-merge scenario, `null` for the deleted file).
- **S10:** `eval/grade.js:96–104`, `:151`. When the same missing_test appears as a summary item, `fp=1, clean_ok=false, pass=false`; when it appears only as a coverage row, `fp=0, clean_ok=true, pass=true`. The FP of a clean case depends on where the finding is displayed. Related to F29 of the main report (F29 is TP double counting, S10 is FP under-counting). The regression test should assert: in a clean case, the same missing_test gives the same `fp` whether it appears as a summary item or only as a coverage row (`coverageRowOnly.fp===sameGapAsSummaryItem.fp`).
- **U7:** `eval/bundle.js:37–60`. The summary of the real `buildSummary` contains `### Missing unit tests (2)` but no "N more item(s)" details, and `bundle.parseSummary` returns 0 items (`bundleSummaryCount=0`); `parseDropped` returns 1 item (`bundleDroppedCount=1`), while the summary has 2 `Dropped findings` rows. The bundle's counts do not agree with the real summary. The regression test should assert: `bundle.parseSummary(summary).length` equals the number of items the summary lists (2 in this example).
- **U8:** `eval/prove.js:443`. `results-prove.json` is written in the shared `out` directory instead of each case directory; after running two cases there is only one `results-prove.json` under `out`, `perCaseResults=[false,false]`, and multiple cases overwrite each other. The regression test should assert: the `results-prove.json` of each case is in its own case directory (`perCaseResults` are all `true`), and there is no such file in the root of `out`.
- **U10:** `eval/label-export.js:16`. `findingId` does not contain `kind`; a `missing_test` and a `weak_test` at the same path/line get the same id `F502e6ddc0`, `exportRowIds=["F502e6ddc0","F502e6ddc0"]`, and they overwrite each other during labelling. The regression test should assert: `findingId(a)!==findingId(b)` (different `kind`), and `exportRowIds` has no duplicates.
- **U11:** `eval/szz.js:91`. A deleted `-- header comment` line in a `.sql` file starts with `--- ` and is treated as a diff file header, so the old-side line numbers are lost: with that comment `lines=[]` and `addOnly=true`; for comparison `lines=[1,4]` and `addOnly=false`. SZZ attribution therefore misses the fix lines. The regression test should assert: the `fixLines` of a `.sql` containing `-- header comment` are consistent with the comparison (`lines` contains 4, `addOnly===false`).
- **V2 (new, found while reading `eval/replay.js`):** `eval/replay.js:85` has a row carrying `findings_present`, and the header at `:90` has no such column. A PR for which the model did not write `findings.json` appears in the printed table as an all-zero row, which cannot be told apart from "reviewed, nothing found". Probe V2: `row.findings_present=false`, `printedTable="pr          trace  inline  high  low  summary  pre-existing\nnofindings  auto   0       0     0    0        0"`, `tableMentionsFindingsPresent=false`. It only affects the human reading of the replay; the fix is to add a column to the table or to mark `NO FINDINGS`. The regression test should assert: the table printed by `finish` has a visible marker for rows with `findings_present===false`, and it is not identical to a normal all-zero row.
- **V1 (new, found while reading `.github/instructions/specguard.instructions.md`):** Line 8 of that file requires "every exported function needs a unit test that asserts the return value or the thrown error". Among the 43 non-test files in `src/*.js` and `eval/*.js`, probe V1 finds 34 exported functions in 15 files that no `*.test.js` mentions by name (for example `assertionKind`, `counterexampleOk`, `citationsOf`, `loadCoverage`, `applyCoverage`, `coverageAtoms`, `findingBlock`, `findingHead` of `src/post.js`; `testScope`, `catBatch` of `src/trace.js`; `indexTests`, `noExt`, `classAndMethod` of `src/test-map.js`); `src/limitations.js` and `src/scan-parts.js` have no `.test.js` of the same name (the standard requires tests to "live next to the code"). Boundary: matching is by name, so indirect coverage (for example by a test going through the `post.js` entry point) is not recognised; this is therefore an **upper bound** on "has no direct unit test", not "is not tested at all". Known false positive: `plan()` of `src/scan-parts.js` is tested directly in `src/claude-api.test.js`, there is just no `scan-parts.test.js` of the same name. When fixing, first handle the exports that are really untested decision paths (for example `counterexampleOk`, `applyCoverage`, `findingBlock` of `post.js`), instead of mechanically filling in all 34. SpecGuard audits other people's repos by the same standard and does not meet it itself. The regression test should assert: every exported function is referenced by name by at least one `*.test.js` and its return value is asserted (`filesWithUnreferencedExports` is empty, `exportingFilesWithoutSiblingTest` is empty).

### 3.5 By design

#### S11 Large-PR hunks are truncated but the status is still complete: by design, not counted as a defect

- **Location:** `src/post.js:1442`, `src/focus.js:1–8` (file header comment).
- **Fact:** In a single-file PR with 3001 changed lines, `changedLinesNotShownToModel=2495`, `runStatus="complete"`, `headMarker=true`; the summary shows `Large PR: diffs of 1 large file was shortened in the prompt`, `cleanVerdict=false` (it does not show "No unit test gaps found").
- **Why it is not counted as a defect:** post.js:1442 's comment states `not reduced mode, not a failure: incomplete only when a changed file was left out, so the next push reviews again`; focus.js header states `a chosen file is never dropped for size`. This is an explicit trade-off, and it is visible to the user.
- **Optional improvement (not counted as a defect):** If the team thinks the truncated lines may contain uncovered obligations, `shortened > 0` can be promoted to incomplete.
- **The regression test should assert:** (keep the current behaviour) when `shortened>0`, the summary contains the `Large PR` banner and `cleanVerdict===false`.

## 4. Fix status

Fix PRs under review for F19–F29 of the main report:

| Finding | PR | Note |
|---|---|---|
| F19, F20 | #201 | |
| F21, F25 | #203 | |
| F22, F23 | #202 | Stacked on top of #198 |
| F24, F26 | #200 | |
| F27, F28 | #205 | Stacked on top of #198 |
| F29 | #204 | |

Also: #197 is the raise fix for "raise low confidence after an assertion is deleted"; it acts after the lead and does not overlap with U5 and U6.

Status of each item in this supplement:

- **S5:** being fixed in the third round of #201 (a unit with only a low-confidence finding, or whose finding was dropped, is recorded as `unsure`, and the date is advanced so the rotation does not stall); it is not "unfixed".
- **S1 / U12:** already recorded as a known problem in the PR description of #200; the fix has not started.
- **All other items** (including V1 and V2) are not fixed yet, and there is no known PR under review for them.

Suggested order:

1. **First group (main PR path, all small changes):** U13 (`AC-1:` parsing) and research F32 (Gherkin `Background`). When fixing F32, the inherited `Background` must also enter the `tv` text version introduced by #203, otherwise scenarios do not expire after the preconditions are modified.
2. **False reassurance:** U1, S2, S7, S13.
3. **Evidence visibility:** U3, S3, S8.
4. **Lead coverage and scan state:** U5, U6; S4, S6, S14 (S5 is in #201).
5. The rest in order of P2, P3.

Keep the matching probe for every fix and invert its assertions to use as the regression test; the "regression test should assert" of each item is in §3.

## 5. Appendices

The probes are run from the checkout root of `ee1c158`: `node audit-supplement.cjs`, `node audit-supplement-2.cjs` (the U series needs Git bash in front of PATH, as explained in the script header comment). The verification command of U13 is in §3.1.

### Appendix A: probes S1–S14 (audit-supplement.cjs)

<details>
<summary>Expand the script or result</summary>

```javascript
// Supplementary audit probes S1-S14. Each probe asserts the CURRENT (suspected buggy) behaviour and returns the observed facts.
// Run from the repo root (or from .audit-probe/): node audit-supplement.cjs   (Git Bash on Windows). No network, no model: GitHub and gh are mocked.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const ROOT = process.env.SG_ROOT || (fs.existsSync(path.join(__dirname, 'src')) ? __dirname : path.join(__dirname, '..'));
const req = (p) => require(path.join(ROOT, p));
const execFileSync0 = cp.execFileSync; // the weekly-report probe patches execFileSync for 'gh' only
const ac = req('src/audit-collect'), ap = req('src/audit-post'), au = req('src/audit-units');
const post = req('src/post'), trace = req('src/trace'), packer = req('src/engines/claude-api'), scanParts = req('src/scan-parts');
const reqs = req('src/requirements'), preflight = req('src/preflight'), focus = req('src/focus');
const { grade, parseSummary } = req('eval/grade');
const results = [], roots = [];

// ---------- helpers ----------
function write(dir, file, content) { const p = path.join(dir, file); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, content); }
function git(dir, ...args) { return execFileSync0('git', ['-c', 'core.autocrlf=false', ...args], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
function commit(dir, msg = 'fixture') { git(dir, 'add', '-A'); git(dir, '-c', 'user.name=Probe', '-c', 'user.email=probe@example.invalid', 'commit', '-qm', msg); return git(dir, 'rev-parse', 'HEAD'); }
function fixture(files) { // a temp git repo under os.tmpdir(); removed (guarded) at the end
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-supp-'));
  roots.push(dir); git(dir, 'init', '-q', '-b', 'main');
  for (const [p, s] of Object.entries(files)) write(dir, p, s);
  const head = commit(dir);
  return { dir, head, ctx: path.join(dir, '.specguard-ctx') };
}
function cleanup() {
  for (const r of roots) {
    const p = fs.realpathSync(r), base = fs.realpathSync(os.tmpdir());
    if (!p.startsWith(base + path.sep) || !path.basename(p).startsWith('sg-supp-')) throw Error('unsafe cleanup path ' + p);
    fs.rmSync(p, { recursive: true, force: true });
  }
}
const pending = [];
function probe(id, fn) { pending.push([id, fn]); }
async function runAll() {
  for (const [id, fn] of pending) {
    try { const detail = await fn(); results.push({ id, reproduced: true, ...detail }); }
    catch (e) { results.push({ id, reproduced: false, error: e.stack.split('\n').slice(0, 4).join(' | ') }); process.exitCode = 1; }
  }
}
async function withEnv(values, fn) {
  const before = { ...process.env };
  try { Object.assign(process.env, values); return await fn(); }
  finally { for (const k of Object.keys(process.env)) if (!(k in before)) delete process.env[k]; Object.assign(process.env, before); }
}
const lineOf = (s) => s.split('\n');

// PR-mode post.js harness (same mocks as the earlier audit's P6). files: ctx files; returns the observed publication.
async function runPost(p, { files, pr: prOver = {}, env = {} }) {
  fs.mkdirSync(p.ctx, { recursive: true });
  for (const [n, v] of Object.entries(files)) fs.writeFileSync(path.join(p.ctx, n), typeof v === 'string' ? v : JSON.stringify(v));
  let summary = '', reviews = [], inline = [];
  const outputs = {}, warnings = [];
  const pr = { state: 'open', title: 'Probe PR', body: '', head: { sha: p.head }, base: { sha: p.head }, user: { login: 'dev', type: 'User' }, ...prOver };
  const gh = {
    paginate: async (fn, args) => (await fn(args)).data,
    graphql: async () => ({ repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [] } } } }),
    rest: {
      users: { getAuthenticated: async () => { throw Error('job token'); } },
      pulls: { get: async () => ({ data: pr }), listReviewComments: async () => ({ data: [] }), listFiles: async () => ({ data: [] }),
        createReview: async (a) => { reviews.push(a); return { data: {} }; }, createReviewComment: async (a) => { inline.push(a); return { data: { html_url: 'https://example.invalid/c' } }; } },
      issues: { listComments: async () => ({ data: [] }), createComment: async (a) => { summary = a.body; return {}; } },
    },
  };
  const core = { setOutput: (k, v) => { outputs[k] = v; }, warning: (s) => warnings.push(s), summary: { addRaw(s) { summary = s; return this; }, async write() {} } };
  await withEnv({ CTX: p.ctx, GITHUB_WORKSPACE: p.dir, HEAD_SHA: p.head, BASE_SHA: p.head, ENGINE: 'claude', MODEL: 'claude-sonnet-4-6', SKIP: 'false', PARTIAL: 'false', DELIVERY: '', STANDARDS_CHECKS: '', STANDARDS_REF: 'head', RESOLVE_STALE: 'false', ...env },
    () => post({ github: gh, core, context: { repo: { owner: 'o', repo: 'r' }, serverUrl: 'https://github.com', payload: { pull_request: { ...pr, number: 1 } } } }));
  let counts = null; try { counts = JSON.parse(fs.readFileSync(path.join(p.ctx, 'counts.json'), 'utf8')); } catch { /* none */ }
  return { summary, outputs, counts, warnings, inline, reviews, pr };
}
const cleanData = (b) => ({ requirements: [], requirements_source: 'PR body', not_reviewed: '',
  coverage: [{ id: 'O1', obligation: 'Increment the input', source: 'from behaviour', behaviour: b, change: b, evidence: [{ path: 'test.js', line: 1, quote: 'assert.equal(total(1), 2);', layer: 'unit', kind: 'assertion', proves: 'Increments one.' }], status: 'covered', reason: 'The assertion checks the increment.', alignment: { status: 'not_applicable', reason: 'No explicit requirement.' } }],
  findings: [], standards: { status: 'no_rules', sources: [], reason: 'No rule files.' }, layering: { status: 'checked', reason: 'No higher-layer tests.' } });
const SRC = 'exports.total = x => x + 1;\n', TEST = 'assert.equal(total(1), 2);\n';
const SRC_DIFF = 'diff --git a/src.js b/src.js\n--- a/src.js\n+++ b/src.js\n@@ -1 +1 @@\n-exports.total = x => x;\n+exports.total = x => x + 1;\n';
const BEH = { path: 'src.js', line: 1, quote: 'exports.total = x => x + 1;' };
const prFiles = (extra = {}) => ({ 'files.txt': 'src.js\n', 'diff.patch': SRC_DIFF, 'test-candidates.txt': 'src.js\n  test.js  (name match)\n', 'engine-status': 'success', 'requirements-status.json': { status: 'available', sources: ['PR body'], limitations: [], criteria: [] }, 'findings.json': cleanData(BEH), ...extra });
const prRepo = () => fixture({ 'src.js': SRC, 'test.js': TEST });

// ---------- S1 ----------
probe('S1-test-paths-exclusion-only', () => {
  const f = fixture({
    'docs/design.md': '# Design\n\nService must reject invalid amounts.\n',
    'src/amount.js': 'function amount(value) {\n  if (value < 0) throw new Error("neg");\n  return value >= 10;\n}\nmodule.exports = { amount };\n',
    'tests/legacy/old.test.js': 'test("legacy", () => { assert.equal(amount(10), true); });\n',
    'tests/new/amount.test.js': 'test("new", () => { assert.equal(amount(11), true); });\n',
  });
  const spec = '!tests/legacy/**';
  const ts = trace.testScope(spec);                       // null: no include line
  const sc = ac.__scopeFn || null;                        // scopeFn is not exported; replicate by calling collect(scanPaths) below
  assert.equal(ts, null);
  ac.collect({ cwd: f.dir, ctx: f.ctx, reqPaths: 'docs/design.md', testPaths: spec, maxUnits: 5 });
  const layout = fs.readFileSync(path.join(f.ctx, 'test-layout.txt'), 'utf8');
  const unitsTxt = fs.readFileSync(path.join(f.ctx, 'audit-units.txt'), 'utf8');
  assert(layout.includes('tests/legacy (1)')); assert(unitsTxt.includes('tests/legacy/old.test.js'));
  // contrast: the scan_paths scope (same '!' syntax) excludes it. collect() with scanPaths drops tests/legacy from the layout and the unit tests.
  ac.collect({ cwd: f.dir, ctx: f.ctx, reqPaths: 'docs/design.md', scanPaths: spec, maxUnits: 5 });
  const unitsScoped = fs.readFileSync(path.join(f.ctx, 'audit-units.txt'), 'utf8'), layoutScoped = fs.readFileSync(path.join(f.ctx, 'test-layout.txt'), 'utf8');
  assert(!unitsScoped.includes('tests/legacy/old.test.js')); assert(!layoutScoped.includes('tests/legacy'));
  // PR-mode consumers of the same helper
  const cover = require(path.join(ROOT, 'src/test-map')).makeCoverGuard({ cwd: f.dir, testPaths: spec });
  return { testScopeForExclusionOnly: ts, layoutHeaderShowsConfig: layout.includes('configured test locations'), layoutLists: layout.split('\n')[0], unitTestsColumn: unitsTxt.trim().split('\t')[4],
    scanPathsExclusionWorks: true, contrast: { unitTestsColumnWithScanPaths: unitsScoped.trim().split('\t')[4] }, level: 'collect() (audit-collect.collect) + trace.testScope' };
});

// ---------- S2 ----------
probe('S2-unreadable-closing-issue', async () => {
  const mk = (n) => ({ number: 5, title: 'Fix total', body: Array.from({ length: n }, (_, i) => `Fixes #${i + 7}`).join('\n'), headRefName: 'fix', labels: [] });
  const err = (s) => Object.assign(new Error(`HTTP ${s}`), { status: s });
  const unreadable = reqs.collectRequirements({ pr: mk(1), repo: 'o/r', commits: '', history: { shas: [], pulls: () => [], pr: () => null }, loadIssue: () => { throw err(403); } });
  const capped = reqs.collectRequirements({ pr: mk(6), repo: 'o/r', commits: '', history: { shas: [], pulls: () => [], pr: () => null }, loadIssue: (r, n) => ({ title: `T${n}`, body: `It must work ${n}.`, url: `https://github.com/o/r/issues/${n}`, labels: [], comments: [] }) });
  const lim = require(path.join(ROOT, 'src/limitations'));
  const kinds = (r) => r.limitations.map((l) => ({ l, fact: lim.isFactLimitation(l) }));
  const run = async (status) => { const p = prRepo(); return runPost(p, { files: prFiles({ 'requirements-status.json': status }) }); };
  const a = await run(unreadable), b = await run(capped);
  assert.equal(a.outputs.status, 'complete'); assert(a.summary.includes('<!-- specguard:head=')); assert(/Could not read issue #7/.test(a.summary));
  assert.equal(b.outputs.status, 'incomplete'); assert(!b.summary.includes('<!-- specguard:head='));
  const head = (s) => (/^\*\*(.+)\*\*$/m.exec(s) || [])[1];
  const sk = preflight.decide({ pr: a.pr, comments: [{ user: { type: 'Bot', login: 'github-actions[bot]' }, body: a.summary }], headSha: a.pr.head.sha });
  return { unreadableClosing: { status: unreadable.status, limitations: kinds(unreadable), sources: unreadable.sources, run: { status: a.outputs.status, complete: a.counts.complete, execution_complete: a.counts.execution_complete, headline: head(a.summary), noUnitTestGapsFound: a.summary.includes('No unit test gaps found'), unreadableNoteOnlyIn: 'Details > Not reviewed (1 item)', headMarker: true, nextPushSkipped: !!sk } },
    cappedClosing: { status: capped.status, limitations: kinds(capped).slice(0, 2), run: { status: b.outputs.status, complete: b.counts.complete, headline: head(b.summary), headMarker: b.summary.includes('<!-- specguard:head=') } },
    level: 'requirements.collectRequirements (real) -> post.js entry (mocked GitHub)' };
});

// ---------- S3 ----------
probe('S3-shared-test-file-seen-dedupe', () => {
  const tests = [], pad = 'x'.repeat(100);
  for (let i = 0; i < 400; i++) tests.push(`test('filler ${i}', () => { assert.equal(filler${i}(1), ${i}); }); // ${pad}`);
  tests.splice(100, 0, `test('alpha', () => {\n  assert.equal(alphaThing(1), 111);\n});`);
  tests.splice(300, 0, `test('beta', () => {\n  assert.equal(betaThing(2), 222);\n});`);
  const f = fixture({ 'src/a.js': 'function alphaThing(v) { return v + 110; }\nmodule.exports = { alphaThing };\n', 'src/b.js': 'function betaThing(v) { return v + 220; }\nmodule.exports = { betaThing };\n', 'tests/shared.test.js': tests.join('\n') + '\n' });
  const size = fs.statSync(path.join(f.dir, 'tests/shared.test.js')).size;
  const ctx = f.ctx; fs.mkdirSync(ctx);
  const diff = (p, fn) => `diff --git a/${p} b/${p}\n--- a/${p}\n+++ b/${p}\n@@ -0,0 +1,2 @@\n+function ${fn}(v) { return v; }\n+module.exports = { ${fn} };\n`;
  write(ctx, 'files.txt', 'src/a.js\nsrc/b.js\n'); write(ctx, 'diff.patch', diff('src/a.js', 'alphaThing') + diff('src/b.js', 'betaThing'));
  write(ctx, 'test-candidates.txt', 'src/a.js\n  tests/shared.test.js  (name)\nsrc/b.js\n  tests/shared.test.js  (name)\n');
  const pack = packer.contextPack(ctx, f.dir, 250000);
  const t = pack.text;
  assert(size > 41666); assert(t.includes('assert.equal(alphaThing(1), 111)')); assert(!t.includes('assert.equal(betaThing(2), 222)'));
  assert.deepEqual(pack.notWhole, []);
  return { testFileBytes: size, perFileCap: 41666, aAssertionInPack: true, bAssertionInPack: false, notWhole: pack.notWhole, testBlockCount: (t.match(/tests\/shared\.test\.js/g) || []).length, level: 'engines/claude-api.contextPack (real)' };
});

// ---------- S4 ----------
probe('S4-ev-per-block-cap', () => {
  const files = { 'docs/design.md': '# Design\n\n## Rule\nService must reject invalid amounts.\n' };
  for (let i = 1; i <= 5; i++) { files[`src/c${i}.js`] = `function c${i}(v) {\n  return v + ${i};\n}\nmodule.exports = { c${i} };\n`; }
  for (let i = 1; i <= 4; i++) { files[`tests/t${i}.test.js`] = `test('t${i}', () => { assert.equal(${i}, ${i}); });\n`; }
  const f = fixture(files);
  const blocks = ac.allBlocks(f.dir, f.head, ['docs/design.md']); assert.equal(blocks.length, 1);
  const cid = blocks[0].cid, cited = [1, 2, 3, 4, 5].map((i) => `src/c${i}.js`).concat([1, 2, 3, 4].map((i) => `tests/t${i}.test.js`)); // 9 files
  const rows = cited.map((p) => ({ path: p, line: 1, quote: 'x' }));
  const data = { requirements: [{ id: cid, source: { path: 'docs/design.md', line: 4, quote: 'x' }, text: 'x', class: 'unit', status: 'covered', code: rows.slice(0, 5), tests: rows.slice(5).map((r) => ({ ...r, layer: 'unit' })), note: '' }], not_requirements: [], not_reviewed: [], docs_reviewed: [], unit_findings: [] };
  const raw = ap.stateOf(f.head, data, null, { date: '2026-10-01' }).raw;
  const prior = ap.readState(raw);
  const h8 = (p) => crypto.createHash('sha1').update(p).digest('hex').slice(0, 8);
  assert.equal(prior.versions.ev[cid].length, 8); assert(!prior.versions.ev[cid].includes(h8(cited[8])));
  const stale = (edit) => { write(f.dir, edit, fs.readFileSync(path.join(f.dir, edit), 'utf8') + '// edited\n'); commit(f.dir, 'edit ' + edit); ac.collect({ cwd: f.dir, ctx: f.ctx, reqPaths: 'docs/design.md', prior, rotate: true, maxUnits: 1 }); return fs.readFileSync(path.join(f.ctx, 'audit-stale.txt'), 'utf8').includes(cid); };
  // prior.blocks[].at.head must be the audited commit: stateOf recorded it as f.head.slice(0,7)
  const ninth = stale(cited[8]);                 // edit ONLY the 9th cited file
  const first = stale(cited[0]);                 // control: edit the 1st cited file
  assert.equal(ninth, false); assert.equal(first, true);
  return { citedFiles: cited.length, storedHashes: prior.versions.ev[cid].length, ninthFileEdited_blockStale: ninth, firstFileEdited_blockStale: first, level: 'audit-post.stateOf/readState + audit-collect.collect (real)' };
});

// ---------- S5 + S6 helper: audit-post main with the code-first fixture ----------
async function runScan(unitFindings, { priorBody = null } = {}) {
  const s = fixture({ 'src/amount.js': 'exports.positive = v => v > 0;\nexports.negative = v => v < 0;\nexports.zero = v => v === 0;\n' });
  fs.mkdirSync(s.ctx);
  const put = (n, v) => fs.writeFileSync(path.join(s.ctx, n), typeof v === 'string' ? v : JSON.stringify(v));
  const id = au.sha8('src/amount.js');
  put('audit-meta.json', { head: s.head, max_requirements: 80, units: { total: 1, picked: 1 }, docs: 0, candidates: 0, rotation: { rotate: true, picked: 0 }, limitations: [] });
  put('audit-units.txt', `${id}\tsrc/amount.js\t10\tno test\tnone\t-\tabcdef12\t-\n`);
  put('audit-inventory.json', { units: 1, max_units: 1, selected: { units: 1, without_tests: 1 }, rotation: { picked: 1, total: 1, reviewed: 1 }, rows: [{ id, path: 'src/amount.js', score: 10, tests: [], why: 'no test' }], unreviewed: [] });
  put('engine-status', 'success'); put('pack-cut.txt', '');
  put('findings.json', { requirements: [], not_requirements: [], not_reviewed: [], docs_reviewed: [], unit_findings: unitFindings(id) });
  let issueBody = '', summary = ''; const outputs = {};
  const github = { paginate: async (fn) => fn(), rest: { users: { getAuthenticated: async () => { throw Error('job token'); } }, issues: { listForRepo: async () => [], create: async (a) => { issueBody = a.body; } } } };
  const core = { setOutput: (k, v) => { outputs[k] = v; }, warning: () => {}, summary: { addRaw(x) { summary = x; return this; }, async write() {} } };
  await withEnv({ CTX: s.ctx, GITHUB_WORKSPACE: s.dir, SCAN_ISSUE: 'true', ISSUE_REPO: '', SKIP: 'false', ENGINE: 'claude' }, () => ap({ github, core, context: { repo: { owner: 'org', repo: 'source' }, sha: s.head } }));
  const audit = JSON.parse(fs.readFileSync(path.join(s.ctx, 'audit.json'), 'utf8'));
  return { outputs, state: ap.readState(issueBody), audit, summary, id };
}
probe('S5-low-confidence-unit-covered', async () => {
  const f = (id, extra = {}) => [{ unit: id, kind: 'missing_test', path: 'src/amount.js', line: 1, quote: 'exports.positive = v => v > 0;', title: 'positive has no test', body: 'b', ...extra }];
  const low = await runScan((id) => f(id));                                                         // no skeleton: low confidence
  const high = await runScan((id) => f(id, { skeleton: "test('positive', () => { assert.equal(positive(1), true); });", body: 'Add a test for positive.' })); // control: sketch present
  const lowState = low.state.blocks[0].status, highState = high.state.blocks[0].status;
  assert.equal(low.audit.unit_findings[0].low, true); assert.equal(lowState, 'covered'); assert.equal(highState, 'gap');
  return { lowFinding: { low: low.audit.unit_findings[0].low, lowWhy: low.audit.unit_findings[0].lowWhy, status: low.outputs.status, unitStateInIssue: lowState }, control: { low: high.audit.unit_findings[0].low, unitStateInIssue: highState }, level: 'audit-post main entry (mocked GitHub)' };
});

// ---------- S6 ----------
probe('S6-unanswered-blocks-today-date', () => {
  const files = { 'docs/design.md': '# D\n\n## A\nService must reject negative amounts.\n\n## B\nService must reject blank names.\n\n## C\nService must round totals half up.\n\n## D\nService must log every refund.\n', 'src/x.js': 'exports.x = () => 1;\n', 'tests/x.test.js': 'assert.equal(x(), 1);\n' };
  const f = fixture(files);
  const blocks = ac.allBlocks(f.dir, f.head, ['docs/design.md']); assert.equal(blocks.length, 4);
  const [A, B, C, D] = blocks;
  const covered = (b) => ({ id: b.cid, source: { path: b.path, line: b.line, quote: b.text }, text: b.text, class: 'unit', status: 'covered', code: [{ path: 'src/x.js', line: 1, quote: 'exports.x = () => 1;' }], tests: [{ path: 'tests/x.test.js', line: 1, quote: 'assert.equal(x(), 1);', layer: 'unit' }], note: '' });
  const base = { not_requirements: [], not_reviewed: [], docs_reviewed: [], unit_findings: [] };
  // run 1 (2026-10-01): all four audited and covered
  const s1 = ap.readState(ap.stateOf(f.head, { ...base, requirements: blocks.map(covered) }, null, { date: '2026-10-01' }).raw);
  // run 2 (2026-10-15): A, B, C were sent; the model answers A and B only. D was not sent (carried with its 2026-10-01 date).
  const cands = ap.readCandidates([A, B, C].map((b) => `${b.cid}\t${b.path}:${b.line}\t${b.heading}\t${b.text}`).join('\n') + '\n');
  const read = (p) => { try { return fs.readFileSync(path.join(f.dir, p), 'utf8').split('\n'); } catch { return null; } };
  const verified = ap.verify({ ...base, requirements: [A, B].map(covered) }, { read, cands, docs: new Set(['docs/design.md']) });
  const cRow = verified.requirements.find((r) => r.id === C.cid);
  assert(cRow && cRow.status === 'unknown' && /did not assess/.test(cRow.note));
  const s2 = ap.readState(ap.stateOf(f.head, verified, s1, { date: '2026-10-15', carried: [s1.blocks.find((b) => b.cid === D.cid)] }).raw);
  const dateOf = (cid) => (s2.blocks.find((b) => b.cid === cid).at || {}).date, statusOf = (cid) => s2.blocks.find((b) => b.cid === cid).status;
  assert.equal(dateOf(C.cid), '2026-10-15'); assert.equal(statusOf(C.cid), 'unsure');
  // run 3: which blocks are audited first? cap 1, then cap 3
  const order = (cap) => { ac.collect({ cwd: f.dir, ctx: f.ctx, reqPaths: 'docs/design.md', maxRequirements: cap, maxUnits: 1, prior: s2, rotate: true }); return fs.readFileSync(path.join(f.ctx, 'audit-candidates.txt'), 'utf8').trim().split('\n').map((l) => l.split('\t')[0]); };
  const name = new Map([[A.cid, 'A'], [B.cid, 'B'], [C.cid, 'C'], [D.cid, 'D']]);
  const one = order(1).map((c) => name.get(c)), three = order(3).map((c) => name.get(c));
  assert.deepEqual(one, ['D']); assert(!three.includes('C'));
  return { stored: { A: [statusOf(A.cid), dateOf(A.cid)], B: [statusOf(B.cid), dateOf(B.cid)], C_unanswered: [statusOf(C.cid), dateOf(C.cid)], D_not_sent: [statusOf(D.cid), dateOf(D.cid)] }, nextRunCap1: one, nextRunCap3: three,
    note: 'cap 3 picks D (old), A, B (answered, covered 10-15) and leaves C (never answered) out; the oldest-first tier sorts by the stored date', level: 'audit-post.verify/stateOf/readState + audit-collect.collect (real); not through audit-post main' };
});

// ---------- S7 ----------
probe('S7-pack-error-leaves-no-pack-cut', async () => {
  const out = {};
  // (a) single-call path: GITHUB_WORKSPACE points at a path that does not exist, so root() (realpathSync) throws inside the pack try/catch
  const p = prRepo(); fs.mkdirSync(p.ctx, { recursive: true });
  const ctx = p.ctx; write(ctx, 'diff.patch', SRC_DIFF); write(ctx, 'files.txt', 'src.js\n'); write(ctx, 'test-candidates.txt', 'src.js\n  test.js  (name)\n');
  write(ctx, 'prompt.txt', 'Review.\n\n---\n\nContext directory (absolute path): ' + ctx + '\n');
  const body = JSON.stringify(cleanData(BEH));
  const fetchFn = async () => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ model: 'claude-sonnet-4-6', stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 10 }, content: [{ type: 'text', text: body }] }) });
  await packer.run({ CTX: ctx, PROMPT_FILE: path.join(ctx, 'prompt.txt'), ANTHROPIC_API_KEY: 'sk-ant-probe', MODEL: 'claude-sonnet-4-6', GITHUB_WORKSPACE: path.join(os.tmpdir(), 'sg-supp-does-not-exist') }, { fetchFn });
  const had = fs.readdirSync(ctx);
  out.engine = { status: fs.existsSync(path.join(ctx, 'engine-status')) ? fs.readFileSync(path.join(ctx, 'engine-status'), 'utf8') : 'success (no engine-status file)', packCutFile: had.includes('pack-cut.txt'), findingsWritten: had.includes('findings.json'), notes: fs.readFileSync(path.join(ctx, 'engine-notes'), 'utf8').trim() || '(none)' };
  assert(!had.includes('pack-cut.txt')); assert(had.includes('findings.json'));
  // post.js on that ctx vs on a ctx whose pack-cut.txt names the candidate test: a missing_test finding stays high only in the first
  const finding = { kind: 'missing_test', obligation_ids: ['O1'], ...BEH, title: 'Verify total', body: 'Add assert.equal(total(1), 2).', confidence: 'high' };
  const miss = () => ({ ...cleanData(BEH), coverage: [{ ...cleanData(BEH).coverage[0], status: 'missing_test', evidence: [] }], findings: [finding] });
  const noCut = await runPost(prRepo(), { files: prFiles({ 'findings.json': miss() }) });
  const withCut = await runPost(prRepo(), { files: prFiles({ 'findings.json': miss(), 'pack-cut.txt': 'test.js\n' }) });
  const countHigh = (r) => r.inline.length + r.reviews.reduce((a, x) => a + (x.comments || []).length, 0);
  out.postNoPackCut = { status: noCut.outputs.status, postedHighConfidence: countHigh(noCut), lowConfidenceNote: /partly visible/.test(noCut.summary) };
  out.postPackCutNamesTest = { status: withCut.outputs.status, postedHighConfidence: countHigh(withCut), lowConfidenceNote: /partly visible/.test(withCut.summary) };
  assert(!out.postNoPackCut.lowConfidenceNote); assert(out.postPackCutNamesTest.lowConfidenceNote);
  // (b) scan-parts path: contextPack throws -> plan() swallows it and packCut is [] (claude-api then writes an EMPTY pack-cut.txt)
  const s = fixture({ 'src/a.js': 'x\n' }); fs.mkdirSync(s.ctx);
  write(s.ctx, 'audit-units.txt', 'aaaaaaaa\tsrc/a.js\t5\tno test\tnone\t-\tabcdef12\t-\n');
  write(s.ctx, 'audit-candidates.txt', Array.from({ length: 21 }, (_, i) => `${i.toString(16).padStart(8, '0')}\td.md:${i + 1}\tH\ttext`).join('\n') + '\n');
  const plan = scanParts.plan({ ctx: s.ctx, root: s.dir, batch: 20, limit: 250000, schemaFile: path.join(ROOT, 'src/audit.schema.json'), contextPack: () => { throw new Error('injected pack failure'); }, windowPack: packer.windowPack, assembleAudit: req('src/prompt').assembleAudit });
  out.scanParts = { parts: plan.parts.length, unitPackText: plan.parts[0].pack.text, packCut: plan.packCut };
  assert.deepEqual(plan.packCut, []);
  out.injected = '(a) GITHUB_WORKSPACE -> nonexistent dir so claude-api run() root() throws; (b) stubbed contextPack that throws, passed to scan-parts.plan';
  out.level = '(a) engines/claude-api.run entry (mocked fetch) + post.js entry; (b) scan-parts.plan internal';
  return out;
});

// ---------- S8 ----------
probe('S8-findline-prefix20', () => {
  const lines = ['test("x", () => {', '  assert.equal(compute(1), 3);', '});'];
  const at = (l) => lines[l - 1], all = [1, 2, 3];
  const brief = post.findLine('assert.equal(f(1), 2)', 2, (l) => ['', 'assert.equal(f(1), 3)'][l - 1], [1, 2]);       // the quote from the brief: exactly 20 non-space chars
  const longer = post.findLine('assert.equal(compute(1), 2)', 2, at, all);
  assert.equal(brief, 0); assert.equal(longer, 2);
  // through verifyEvidence (the real PR-mode citation check): the evidence row is "verified" and its quote is rewritten
  const ev = { path: 'test.js', line: 2, quote: 'assert.equal(compute(1), 2)', layer: 'unit', kind: 'assertion', proves: 'p' };
  const b = { path: 'src.js', line: 1, quote: 'x' };
  const data = { requirements: [], coverage: [{ id: 'O1', obligation: 'o', source: 'from behaviour', behaviour: null, change: null, evidence: [ev], status: 'covered', reason: 'r', alignment: { status: 'not_applicable', reason: 'r' } }], findings: [], standards: { status: 'no_rules', sources: [], reason: 'r' }, layering: { status: 'checked', reason: 'r' }, validation_notes: [] };
  const read = (p) => (p === 'test.js' ? lines : null);
  post.verifyEvidence(data, new Set(['src.js']), new Set(), read, new Map());
  const c = data.coverage[0];
  assert.equal(c.evidence[0].quote, 'assert.equal(compute(1), 3);'); assert.equal(c.status, 'covered');
  return { briefQuoteLiteral: { quote: 'assert.equal(f(1), 2)', matchesLine: brief, why: 'exactly 20 non-space characters, so the prefix is the whole quote and the different tail fails' },
    longerQuote: { quote: 'assert.equal(compute(1), 2)', line: 'assert.equal(compute(1), 3);', findLine: longer }, verifyEvidence: { status: c.status, evidenceQuoteAfter: c.evidence[0].quote, noteOrDowngrade: data.validation_notes }, level: 'post.findLine + post.verifyEvidence (internal, real)' };
});

// ---------- S9 ----------
probe('S9-weekly-vs-post-anchor-rule', async () => {
  const W = require(path.join(ROOT, 'eval/weekly-report'));
  const f = fixture({ 'src/a.js': Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join('\n') + '\n', 'src/gone.js': 'a\nb\nc\nd\ne\nf\n' });
  const base = f.head;
  git(f.dir, 'checkout', '-q', '-b', 'pr'); write(f.dir, 'README.md', 'pr work\n'); const orig = commit(f.dir, 'pr work (comment anchored here)');
  git(f.dir, 'checkout', '-q', 'main'); write(f.dir, 'src/a.js', fs.readFileSync(path.join(f.dir, 'src/a.js'), 'utf8').replace('line 5', 'line 5 CHANGED ON MAIN')); write(f.dir, 'tests/base.test.js', 'assert(1)\n'); commit(f.dir, 'main: edits the anchor file and adds a test');
  git(f.dir, 'checkout', '-q', 'pr'); git(f.dir, '-c', 'user.name=Probe', '-c', 'user.email=p@e.invalid', 'merge', '-q', '--no-edit', 'main'); const merged = git(f.dir, 'rev-parse', 'HEAD');
  git(f.dir, 'rm', '-q', 'src/gone.js'); const deleted = commit(f.dir, 'pr deletes gone.js');
  // GitHub compare mock: files between two commits, with status and patch (what the compare API returns)
  const compareFiles = (a, b) => git(f.dir, 'diff', '--name-status', '--no-renames', a, b).split('\n').filter(Boolean).map((l) => {
    const [s, name] = l.split('\t'); const d = git(f.dir, 'diff', '--no-renames', '-U3', a, b, '--', name); const i = d.indexOf('\n@@');
    return { filename: name, status: s === 'D' ? 'removed' : s === 'A' ? 'added' : 'modified', patch: i < 0 ? undefined : d.slice(i + 1) };
  });
  const comment = (id, path_, line, commit_id) => ({ id, user: { login: 'copilot-pull-request-reviewer[bot]', type: 'Bot' }, pull_request_url: 'https://api.github.com/repos/o/r/pulls/1', path: path_, line, original_line: line, original_commit_id: commit_id, body: 'x' });
  const cmts = [comment(11, 'src/a.js', 5, orig), comment(12, 'src/gone.js', 3, merged)];
  let head = merged;
  const fakeGh = (args) => {
    const a = args.join(' ');
    if (a.includes('search/issues')) return JSON.stringify([{ number: 1, created_at: '2026-10-10T00:00:00Z', closed_at: null, pull_request: { merged_at: null }, user: { login: 'dev', type: 'User' }, labels: [] }]);
    if (a.includes('issues/comments')) return '[]';
    if (a.includes('pulls/comments')) return JSON.stringify(cmts);
    if (a.includes('graphql')) return JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes: cmts.map((c) => ({ isResolved: false, resolvedBy: null, comments: { nodes: [{ databaseId: c.id, author: { login: c.user.login } }] } })) } } } } });
    const m = /compare\/(\w+)\.\.\.(\w+)/.exec(a); if (m) return JSON.stringify({ files: compareFiles(m[1], m[2]) });
    if (/repos\/o\/r\/pulls\/1$/.test(a)) return JSON.stringify({ head: { sha: head } });
    throw new Error('unexpected gh call: ' + a);
  };
  const real = cp.execFileSync;
  const resultFor = async (headSha) => { // weekly-report resolves the head once per PR; run the loader for each scenario's head
    head = headSha; cp.execFileSync = (cmd, args, opts) => (cmd === 'gh' ? fakeGh(args) : real(cmd, args, opts));
    try { delete require.cache[require.resolve(path.join(ROOT, 'eval/weekly-report'))]; const WR = require(path.join(ROOT, 'eval/weekly-report')); return WR.load({ repo: 'o/r', since: '2026-10-01', until: '2026-10-16' }); }
    finally { cp.execFileSync = real; }
  };
  // (a) comment on src/a.js@orig, head = merge commit of main into the PR branch
  const dsA = await resultFor(merged);
  const cA = dsA.review_comments.find((c) => c.id === 11);
  const postA = { anchor_touched: post.anchorTouched(orig, merged, 'src/a.js', 5, 5, f.dir), tests_changed: post.testsChanged(orig, merged, f.dir) };
  // (b) comment on src/gone.js@merged, head = the commit that deletes the file
  cmts[1].original_commit_id = merged;
  const dsB = await resultFor(deleted);
  const cB = dsB.review_comments.find((c) => c.id === 12);
  const postB = { anchor_touched: post.anchorTouched(merged, deleted, 'src/gone.js', 3, 3, f.dir), tests_changed: post.testsChanged(merged, deleted, f.dir) };
  const outcome = (c, thread) => W.copilotOutcome({ thread, anchor_touched: c.anchor_touched, tests_changed: c.tests_changed });
  const open = { isResolved: false };
  const o = {
    a_baseMerge: { weekly: { anchor_touched: cA.anchor_touched, tests_changed: cA.tests_changed, outcome: outcome(cA, open) }, postRule: { ...postA, outcome: W.copilotOutcome({ thread: open, ...postA }) } },
    b_deletedFile: { weekly: { anchor_touched: cB.anchor_touched, tests_changed: cB.tests_changed, outcome: outcome(cB, open) }, postRule: { ...postB, outcome: W.copilotOutcome({ thread: open, ...postB }) } },
  };
  assert.equal(o.a_baseMerge.weekly.anchor_touched, true); assert.equal(o.a_baseMerge.postRule.anchor_touched, false);
  assert.equal(o.a_baseMerge.weekly.tests_changed, true); assert.equal(o.a_baseMerge.postRule.tests_changed, false);
  assert.equal(o.b_deletedFile.weekly.anchor_touched, true); assert.equal(o.b_deletedFile.postRule.anchor_touched, null);
  return { ...o, level: 'eval/weekly-report.load (real, gh mocked at execFileSync with compare data from a real git repo) vs post.anchorTouched/testsChanged (real)' };
});

// ---------- S10 ----------
probe('S10-wrong-coverage-row-no-fp', () => {
  const b = { path: 'a.js', line: 10, quote: 'return boundary(value);' };
  const mk = (findings, items) => post.buildSummary({ cov: { reports: 0 }, data: { requirements: [], requirements_source: 'none', not_reviewed: '', coverage: [{ id: 'O1', obligation: 'Boundary A', source: 'from behaviour', behaviour: b, change: b, evidence: [], status: 'missing_test', reason: 'No test', alignment: { status: 'not_applicable', reason: 'No explicit requirement' } }], findings, standards: { status: 'no_rules', sources: [], reason: 'None' }, layering: { status: 'checked', reason: 'No higher layer tests' } }, items, notes: [], blob: 'https://github.com/example/repo/blob/abc/' });
  const rowOnly = mk([], []);
  const parsed = parseSummary(rowOnly);
  const g = grade({ id: 'clean', goal: 'requirements', expected: { findings: [], expect_clean: true } }, { comments: [], reviews: [], summary: rowOnly });
  const f = { kind: 'missing_test', path: 'a.js', line: 10, title: 'Boundary A', body: 'Missing assertion', confidence: 'high', obligation_ids: ['O1'] };
  const asItem = mk([f], [{ f, why: 'not on diff' }]);
  const gi = grade({ id: 'clean', goal: 'requirements', expected: { findings: [], expect_clean: true } }, { comments: [], reviews: [], summary: asItem });
  assert.equal(parsed.rows.length, 1); assert.equal(parsed.rows[0].status, 'missing_test'); assert.equal(g.fp, 0); assert.equal(g.clean_ok, true); assert.equal(g.pass, true); assert(gi.fp >= 1);
  return { coverageRowOnly: { parsedRows: parsed.rows.map((r) => ({ status: r.status, path: r.path, line: r.line })), fp: g.fp, clean_ok: g.clean_ok, pass: g.pass }, sameGapAsSummaryItem: { fp: gi.fp, clean_ok: gi.clean_ok, pass: gi.pass }, level: 'post.buildSummary (real) + eval/grade.grade (real)' };
});

// ---------- S11 ----------
probe('S11-trimmed-hunks-still-complete', async () => {
  const big = Array.from({ length: 3000 }, (_, i) => `+  const v${i} = compute(${i}); // ${'p'.repeat(40)}`).join('\n');
  const patch = `diff --git a/src.js b/src.js\n--- a/src.js\n+++ b/src.js\n@@ -1 +1,3000 @@\n-exports.total = x => x;\n${big}\n`;
  const p = prRepo(); fs.mkdirSync(p.ctx, { recursive: true });
  write(p.ctx, 'diff.patch', patch); write(p.ctx, 'files.txt', 'src.js\n'); write(p.ctx, 'test-candidates.txt', 'src.js\n  test.js  (name)\n');
  const r = focus.main(p.ctx, { FOCUS_THRESHOLD: '100,1', FOCUS_FILES: '12', FOCUS_ROOT: p.dir });
  assert(r.focused); assert.equal(r.skipped.length, 0);
  const numbered = fs.readFileSync(path.join(p.ctx, 'diff.numbered.txt'), 'utf8');
  const marker = /^… (\d+) more changed lines in this file not shown/m.exec(numbered);
  assert(marker);
  const run = await runPost(p, { files: { 'engine-status': 'success', 'requirements-status.json': { status: 'available', sources: ['PR body'], limitations: [], criteria: [] }, 'findings.json': cleanData(BEH) } });
  assert.equal(run.outputs.status, 'complete'); assert(run.summary.includes('<!-- specguard:head='));
  const banner = /Large PR: diffs of [^\n]*/.exec(run.summary);
  return { changedLines: 3001, filesChosen: r.chosen.length, filesSkipped: r.skipped.length, changedLinesNotShownToModel: +marker[1], runStatus: run.outputs.status, complete: run.counts.complete, headMarker: true, cleanVerdict: run.summary.includes('No unit test gaps found'), visibleBanner: banner ? banner[0] : null, level: 'focus.main (real) -> post.js entry (mocked GitHub)' };
});

// ---------- S12 ----------
probe('S12-workflow-input-forwarding', () => {
  const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
  const inputsOf = (text) => { const m = /^inputs:\n([\s\S]*?)^\S/m.exec(text.replace(/\r/g, '') + '\nz'); return [...m[1].matchAll(/^  ([a-z_]+):/gm)].map((x) => x[1]); };
  const action = inputsOf(read('action.yml'));
  const wfText = read('.github/workflows/specguard.yml').replace(/\r/g, '');
  const withBlock = /uses: Mira190\/SpecGuard@[^\n]*\n\s+with:\n([\s\S]*)$/.exec(wfText)[1];
  const forwarded = [...withBlock.matchAll(/^\s+([a-z_]+):/gm)].map((x) => x[1]);
  const callInputs = (() => { const m = /workflow_call:\n\s+inputs:\n([\s\S]*?)\n\s+secrets:/.exec(wfText)[1]; return [...m.matchAll(/^      ([a-z_]+):/gm)].map((x) => x[1]); })();
  const notForwarded = action.filter((i) => !forwarded.includes(i));
  const exposedNotForwarded = callInputs.filter((i) => !forwarded.includes(i));
  const forwardedNotDeclared = forwarded.filter((i) => !action.includes(i));
  let atPin = null;
  try {
    const pin = /uses: Mira190\/SpecGuard@([0-9a-f]{40})/.exec(wfText)[1];
    const old = git(ROOT, 'show', `${pin}:action.yml`);
    atPin = { pin: pin.slice(0, 10), inputsAtPin: inputsOf(old).length };
  } catch (e) { atPin = 'pinned commit not in this clone'; }
  assert(notForwarded.length > 0);
  return { actionInputs: action.length, forwarded: forwarded.length, workflowCallInputs: callInputs, workflowCallInputsNotForwarded: exposedNotForwarded, forwardedButNotDeclaredInAction: forwardedNotDeclared, actionInputsNotForwarded: notForwarded, pinnedActionRef: atPin, level: 'static parse of action.yml and .github/workflows/specguard.yml' };
});

// ---------- S13 ----------
probe('S13-preflight-skip-key', async () => {
  const p = prRepo();
  const r = await runPost(p, { files: prFiles() }); // a real SpecGuard summary for head H
  const markers = [...r.summary.matchAll(/<!-- specguard:([a-z]+)/g)].map((m) => m[1]);
  const comments = [{ user: { type: 'Bot', login: 'github-actions[bot]' }, body: r.summary }];
  const pr = r.pr, same = (extra = {}) => preflight.decide({ pr: { ...pr, ...extra }, comments, headSha: p.head });
  const skipSame = same();
  assert(skipSame);
  // what a rule-file / config / model change would be: none of them is an input of decide, nor does the summary record them
  const params = /function decide\(\{([^}]*)\}\)/.exec(fs.readFileSync(path.join(ROOT, 'src/preflight.js'), 'utf8'))[1].trim();
  const changedTitle = same({ title: 'Probe PR changed' });
  assert.equal(changedTitle, '');
  const hasRuleOrModelMarker = markers.some((m) => /rule|model|config|standards|engine/.test(m));
  assert(!hasRuleOrModelMarker);
  return { sameHeadTitleBody: skipSame, titleChanged: changedTitle === '' ? 'review (no skip)' : changedTitle, decideInputs: params, markersInRealSummary: markers, markerForRulesConfigOrModel: hasRuleOrModelMarker, escapeHatch: 'force: true (action.yml input)',
    note: 'a changed base-branch rule file, config or model is invisible to decide(): same head+title+body => skip', level: 'preflight.decide (real) on a summary produced by post.js' };
});

// ---------- S14 ----------
probe('S14-big-source-dropped-silently', () => {
  const big = '// big\n' + Array.from({ length: 16000 }, (_, i) => `function f${i}(v) { return v + ${i}; }`).join('\n') + '\n';
  const small = 'function a(v) {\n  return v + 1;\n}\nfunction b(v) {\n  return v + 2;\n}\nmodule.exports = { a, b };\n';
  const f = fixture({ 'src/big.js': big, 'src/small.js': small });
  const size = fs.statSync(path.join(f.dir, 'src/big.js')).size; assert(size > 512 * 1024);
  const inv = au.inventory({ cwd: f.dir, head: f.head, maxUnits: 5 });
  const paths = inv.rows.map((r) => r.path);
  assert(paths.includes('src/small.js')); assert(!paths.includes('src/big.js'));
  assert(!inv.limitations.some((l) => /big|512|size|large/i.test(l)));
  ac.collect({ cwd: f.dir, ctx: f.ctx, reqPaths: '', maxUnits: 5 });
  const meta = JSON.parse(fs.readFileSync(path.join(f.ctx, 'audit-meta.json'), 'utf8'));
  const mentions = JSON.stringify(meta.limitations).includes('big.js') || fs.readdirSync(f.ctx).some((n) => /big\.js/.test(fs.readFileSync(path.join(f.ctx, n), 'utf8')));
  assert(!mentions);
  return { bigFileBytes: size, inventoryRows: paths, limitationsFromInventory: inv.limitations, metaLimitations: meta.limitations, bigFileMentionedAnywhereInCtx: mentions, level: 'audit-units.inventory + audit-collect.collect (real)' };
});

runAll().then(() => { console.log(JSON.stringify(results, null, 2)); }).finally(cleanup);
```

</details>

### Appendix A actual results (main ee1c158)

<details>
<summary>Expand the script or result</summary>

```json
[
  {
    "id": "S1-test-paths-exclusion-only",
    "reproduced": true,
    "testScopeForExclusionOnly": null,
    "layoutHeaderShowsConfig": false,
    "layoutLists": "test directories: tests/legacy (1), tests/new (1)",
    "unitTestsColumn": "tests/new/amount.test.js, tests/legacy/old.test.js",
    "scanPathsExclusionWorks": true,
    "contrast": {
      "unitTestsColumnWithScanPaths": "tests/new/amount.test.js"
    },
    "level": "collect() (audit-collect.collect) + trace.testScope"
  },
  {
    "id": "S2-unreadable-closing-issue",
    "reproduced": true,
    "unreadableClosing": {
      "status": "partial",
      "limitations": [
        {
          "l": "Could not read issue #7.",
          "fact": true
        }
      ],
      "sources": [
        "PR body"
      ],
      "run": {
        "status": "complete",
        "complete": true,
        "execution_complete": true,
        "headline": "❔ No gaps found; part of the review could not be assessed",
        "noUnitTestGapsFound": false,
        "unreadableNoteOnlyIn": "Details > Not reviewed (1 item)",
        "headMarker": true,
        "nextPushSkipped": true
      }
    },
    "cappedClosing": {
      "status": "partial",
      "limitations": [
        {
          "l": "1 linked issue(s) omitted by the five-issue limit.",
          "fact": false
        }
      ],
      "run": {
        "status": "incomplete",
        "complete": false,
        "headline": "⚠️ Incomplete review: no unit test gaps found so far",
        "headMarker": false
      }
    },
    "level": "requirements.collectRequirements (real) -> post.js entry (mocked GitHub)"
  },
  {
    "id": "S3-shared-test-file-seen-dedupe",
    "reproduced": true,
    "testFileBytes": 66992,
    "perFileCap": 41666,
    "aAssertionInPack": true,
    "bAssertionInPack": false,
    "notWhole": [],
    "testBlockCount": 1,
    "level": "engines/claude-api.contextPack (real)"
  },
  {
    "id": "S4-ev-per-block-cap",
    "reproduced": true,
    "citedFiles": 9,
    "storedHashes": 8,
    "ninthFileEdited_blockStale": false,
    "firstFileEdited_blockStale": true,
    "level": "audit-post.stateOf/readState + audit-collect.collect (real)"
  },
  {
    "id": "S5-low-confidence-unit-covered",
    "reproduced": true,
    "lowFinding": {
      "low": true,
      "lowWhy": "no test sketch: the finding may not be a gap",
      "status": "complete",
      "unitStateInIssue": "covered"
    },
    "control": {
      "low": false,
      "unitStateInIssue": "gap"
    },
    "level": "audit-post main entry (mocked GitHub)"
  },
  {
    "id": "S6-unanswered-blocks-today-date",
    "reproduced": true,
    "stored": {
      "A": [
        "covered",
        "2026-10-15"
      ],
      "B": [
        "covered",
        "2026-10-15"
      ],
      "C_unanswered": [
        "unsure",
        "2026-10-15"
      ],
      "D_not_sent": [
        "covered",
        "2026-10-01"
      ]
    },
    "nextRunCap1": [
      "D"
    ],
    "nextRunCap3": [
      "A",
      "B",
      "D"
    ],
    "note": "cap 3 picks D (old), A, B (answered, covered 10-15) and leaves C (never answered) out; the oldest-first tier sorts by the stored date",
    "level": "audit-post.verify/stateOf/readState + audit-collect.collect (real); not through audit-post main"
  },
  {
    "id": "S7-pack-error-leaves-no-pack-cut",
    "reproduced": true,
    "engine": {
      "status": "success (no engine-status file)",
      "packCutFile": false,
      "findingsWritten": true,
      "notes": "cost estimated at default rates: claude-sonnet-4-6 is not in the price table"
    },
    "postNoPackCut": {
      "status": "complete",
      "postedHighConfidence": 1,
      "lowConfidenceNote": false
    },
    "postPackCutNamesTest": {
      "status": "complete",
      "postedHighConfidence": 0,
      "lowConfidenceNote": true
    },
    "scanParts": {
      "parts": 3,
      "unitPackText": "",
      "packCut": []
    },
    "injected": "(a) GITHUB_WORKSPACE -> nonexistent dir so claude-api run() root() throws; (b) stubbed contextPack that throws, passed to scan-parts.plan",
    "level": "(a) engines/claude-api.run entry (mocked fetch) + post.js entry; (b) scan-parts.plan internal"
  },
  {
    "id": "S8-findline-prefix20",
    "reproduced": true,
    "briefQuoteLiteral": {
      "quote": "assert.equal(f(1), 2)",
      "matchesLine": 0,
      "why": "exactly 20 non-space characters, so the prefix is the whole quote and the different tail fails"
    },
    "longerQuote": {
      "quote": "assert.equal(compute(1), 2)",
      "line": "assert.equal(compute(1), 3);",
      "findLine": 2
    },
    "verifyEvidence": {
      "status": "covered",
      "evidenceQuoteAfter": "assert.equal(compute(1), 3);",
      "noteOrDowngrade": []
    },
    "level": "post.findLine + post.verifyEvidence (internal, real)"
  },
  {
    "id": "S9-weekly-vs-post-anchor-rule",
    "reproduced": true,
    "a_baseMerge": {
      "weekly": {
        "anchor_touched": true,
        "tests_changed": true,
        "outcome": "addressed"
      },
      "postRule": {
        "anchor_touched": false,
        "tests_changed": false,
        "outcome": "open"
      }
    },
    "b_deletedFile": {
      "weekly": {
        "anchor_touched": true,
        "tests_changed": false,
        "outcome": "addressed"
      },
      "postRule": {
        "anchor_touched": null,
        "tests_changed": false,
        "outcome": "not_observed"
      }
    },
    "level": "eval/weekly-report.load (real, gh mocked at execFileSync with compare data from a real git repo) vs post.anchorTouched/testsChanged (real)"
  },
  {
    "id": "S10-wrong-coverage-row-no-fp",
    "reproduced": true,
    "coverageRowOnly": {
      "parsedRows": [
        {
          "status": "missing_test",
          "path": "a.js",
          "line": 10
        }
      ],
      "fp": 0,
      "clean_ok": true,
      "pass": true
    },
    "sameGapAsSummaryItem": {
      "fp": 1,
      "clean_ok": false,
      "pass": false
    },
    "level": "post.buildSummary (real) + eval/grade.grade (real)"
  },
  {
    "id": "S11-trimmed-hunks-still-complete",
    "reproduced": true,
    "changedLines": 3001,
    "filesChosen": 1,
    "filesSkipped": 0,
    "changedLinesNotShownToModel": 2495,
    "runStatus": "complete",
    "complete": true,
    "headMarker": true,
    "cleanVerdict": false,
    "visibleBanner": "Large PR: diffs of 1 large file was shortened in the prompt",
    "level": "focus.main (real) -> post.js entry (mocked GitHub)"
  },
  {
    "id": "S12-workflow-input-forwarding",
    "reproduced": true,
    "actionInputs": 47,
    "forwarded": 12,
    "workflowCallInputs": [
      "mode",
      "requirements_paths",
      "standards_paths",
      "test_paths",
      "scan_issue",
      "model",
      "effort"
    ],
    "workflowCallInputsNotForwarded": [],
    "forwardedButNotDeclaredInAction": [],
    "actionInputsNotForwarded": [
      "engine",
      "auto_tier",
      "fast_models",
      "max_budget_usd",
      "claude_mode",
      "max_output_tokens",
      "max_comments",
      "max_diff_kb",
      "focus_threshold",
      "focus_files",
      "ignore",
      "standards_checks",
      "standards_ref",
      "coverage_files",
      "trace",
      "claude_version",
      "copilot_version",
      "include_bots",
      "resolve_stale",
      "force",
      "ctx_retention_days",
      "max_units",
      "scan_batch_blocks",
      "scan_max_blocks",
      "scan_paths",
      "scan_issue_repo",
      "scan_issue_token",
      "audit_max_requirements",
      "audit_issue",
      "delivery",
      "fail_on_error",
      "repository",
      "pr_number",
      "base_sha",
      "head_sha"
    ],
    "pinnedActionRef": {
      "pin": "caa99fbbef",
      "inputsAtPin": 45
    },
    "level": "static parse of action.yml and .github/workflows/specguard.yml"
  },
  {
    "id": "S13-preflight-skip-key",
    "reproduced": true,
    "sameHeadTitleBody": "head 07fe197 already has a SpecGuard summary (set force: true to rerun)",
    "titleChanged": "review (no skip)",
    "decideInputs": "pr, comments = [], headSha, includeBots = false, force = false, actor = null, issueAt = null",
    "markersInRealSummary": [
      "summary",
      "head",
      "counts",
      "req",
      "status"
    ],
    "markerForRulesConfigOrModel": false,
    "escapeHatch": "force: true (action.yml input)",
    "note": "a changed base-branch rule file, config or model is invisible to decide(): same head+title+body => skip",
    "level": "preflight.decide (real) on a summary produced by post.js"
  },
  {
    "id": "S14-big-source-dropped-silently",
    "reproduced": true,
    "bigFileBytes": 633787,
    "inventoryRows": [
      "src/small.js"
    ],
    "limitationsFromInventory": [],
    "metaLimitations": [],
    "bigFileMentionedAnywhereInCtx": false,
    "level": "audit-units.inventory + audit-collect.collect (real)"
  }
]
```

</details>

### Appendix B: probes U1–U12 (audit-supplement-2.cjs)

<details>
<summary>Expand the script or result</summary>

```javascript
// Supplement-2 probes (U1-U12). Run from the SpecGuard checkout root: node .audit-probe/audit-supplement-2.cjs
// (or SG_ROOT=<checkout> node audit-supplement-2.cjs). Git's bin + usr/bin are put first on PATH so `bash` is Git bash, not WSL.
// Each probe asserts the suspected-buggy behaviour; reproduced=false carries what actually happened. No network, no model.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const root = process.env.SG_ROOT || path.resolve(__dirname, '..');
for (const d of ['C:\\Program Files\\Git\\usr\\bin', 'C:\\Program Files\\Git\\bin']) if (fs.existsSync(d)) process.env.PATH = d + path.delimiter + process.env.PATH;
const R = (p) => require(path.join(root, p));
const results = [];
const roots = [];
const git = (cwd, ...a) => execFileSync('git', ['-c', 'core.autocrlf=false', ...a], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const fwd = (p) => path.resolve(p).replace(/\\/g, '/');
function repo(files, prefix = 'sg-supp2-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); roots.push(dir);
  git(dir, 'init', '-q', '-b', 'main');
  const put = (map) => { for (const [n, s] of Object.entries(map)) { const p = path.join(dir, n); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); } };
  const commit = (m = 'c') => { git(dir, 'add', '-A'); git(dir, '-c', 'user.name=T', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', m); return git(dir, 'rev-parse', 'HEAD'); };
  put(files);
  return { dir, put, commit, git: (...a) => git(dir, ...a) };
}
const rd = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };
function collect(dir, ctx, env) {
  const out = path.join(os.tmpdir(), 'sg-supp2-ghout-' + process.pid + '-' + path.basename(ctx)); roots.push(out); fs.writeFileSync(out, '');
  const r = spawnSync('bash', [fwd(path.join(root, 'src/collect.sh'))], { cwd: dir, encoding: 'utf8', timeout: 240000,
    env: { ...process.env, CTX: fwd(ctx), GITHUB_OUTPUT: fwd(out), TRACE: 'off', ...env } });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, outputs: (rd(out) || '').split('\n').filter(Boolean) };
}
async function probe(id, fn) {
  try { results.push({ id, ...(await fn()) }); }
  catch (e) { results.push({ id, reproduced: false, error: String(e.message).slice(0, 600) }); }
}
async function withEnv(values, fn) {
  const before = { ...process.env };
  try { Object.assign(process.env, values); return await fn(); }
  finally { for (const k of Object.keys(process.env)) if (!(k in before)) delete process.env[k]; Object.assign(process.env, before); }
}

(async () => {
// U1: BASE_SHA absent from a depth-1 clone; the head is present. The diff in `< <(...)` fails silently -> skip=true -> post.js "Nothing to review", complete.
await probe('U1-absent-base-silent-skip', async () => {
  const up = repo({ 'README.txt': 'x\n', 'src/a.js': 'exports.f = x => x;\n' });
  const base = up.commit('base');
  up.put({ 'src/a.js': 'exports.f = x => x > 0 ? x : 0;\n' }); up.commit('mid');
  up.put({ 'src/a.js': 'exports.f = x => x > 1 ? x : 1;\n' }); const head = up.commit('head');
  const clone = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-supp2-clone-')); roots.push(clone);
  git(os.tmpdir(), 'clone', '-q', '--depth', '1', 'file://' + fwd(up.dir), clone);
  const baseThere = spawnSync('git', ['cat-file', '-e', base + '^{commit}'], { cwd: clone }).status === 0;
  const ctx = path.join(clone, '.specguard-ctx');
  const c = collect(clone, ctx, { BASE_SHA: base, HEAD_SHA: head });
  const diffPatch = rd(path.join(ctx, 'diff.patch')), files = rd(path.join(ctx, 'files.txt'));
  assert.equal(baseThere, false);
  assert(c.outputs.includes('skip=true'), 'collect did not skip: ' + JSON.stringify(c));
  // post.js with SKIP=true (mock as audit-doc Appendix B P6)
  const post = R('src/post.js');
  let summary = ''; const outputs = {};
  const pr = { state: 'open', title: 't', body: '', head: { sha: head }, user: { login: 'dev', type: 'User' } };
  const gh = { paginate: async (fn, args) => (await fn(args)).data, graphql: async () => ({ repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [] } } } }),
    rest: { users: { getAuthenticated: async () => { throw Error('job token'); } }, pulls: { get: async () => ({ data: pr }), listReviewComments: async () => ({ data: [] }), listFiles: async () => ({ data: [] }) },
      issues: { listComments: async () => ({ data: [] }), createComment: async (a) => { summary = a.body; return {}; }, updateComment: async (a) => { summary = a.body; return {}; } } } };
  const core = { setOutput: (k, v) => { outputs[k] = v; }, warning() {}, notice() {}, summary: { addRaw(s) { return this; }, async write() {} } };
  await withEnv({ CTX: ctx, GITHUB_WORKSPACE: clone, HEAD_SHA: head, ENGINE: 'claude', MODEL: 'claude-sonnet-4-6', SKIP: 'true', PARTIAL: 'false', DELIVERY: '', STANDARDS_CHECKS: '', STANDARDS_REF: 'head', RESOLVE_STALE: 'false' },
    () => post({ github: gh, core, context: { repo: { owner: 'o', repo: 'r' }, serverUrl: 'https://github.com', payload: { pull_request: { ...pr, number: 1 } } } }));
  const counts = rd(path.join(ctx, 'counts.json'));
  const out = { reproduced: true, baseInClone: baseThere, collectExit: c.status, collectOutputs: c.outputs, collectStdout: c.stdout.trim().slice(0, 200), warning: (c.stderr.match(/::warning::[^\n]*/) || [''])[0], diffPatchBytes: (diffPatch || '').length, filesTxt: files,
    postStatus: outputs.status, summaryHasNothingToReview: /Nothing to review/.test(summary), summaryHasHeadMarker: summary.includes(`specguard:head=${head}`), countsComplete: counts && JSON.parse(counts).complete };
  assert.equal(out.summaryHasNothingToReview, true); assert.equal(out.postStatus, 'complete');
  return out;
});

// U2: only internal/build/x.go changed -> `build/` default ignore matches any path segment -> skipped; nothing recorded.
await probe('U2-nested-build-dir-ignored-silently', async () => {
  const r = repo({ 'internal/build/x.go': 'package build\nfunc F() int { return 1 }\n', 'internal/other/y.go': 'package other\nfunc G() int { return 1 }\n' });
  const base = r.commit('base');
  r.put({ 'internal/build/x.go': 'package build\nfunc F() int { return 2 }\n' }); const head = r.commit('head');
  const ctx = path.join(r.dir, '.specguard-ctx');
  const c = collect(r.dir, ctx, { BASE_SHA: base, HEAD_SHA: head });
  const limits = rd(path.join(ctx, 'collect-limits.txt')), dropped = rd(path.join(ctx, 'diff-dropped.txt'));
  // control: same change in a non-ignored dir is reviewed
  r.git('checkout', '-q', base); r.git('checkout', '-q', '-b', 'ctl'); r.put({ 'internal/other/y.go': 'package other\nfunc G() int { return 2 }\n' }); const head2 = r.commit('ctl');
  const ctx2 = path.join(r.dir, '.specguard-ctx2');
  const c2 = collect(r.dir, ctx2, { BASE_SHA: base, HEAD_SHA: head2 });
  const out = { reproduced: c.outputs.includes('skip=true'), outputs: c.outputs, stdout: c.stdout.trim(), collectLimitsBytes: (limits || '').length, diffDroppedBytes: (dropped || '').length, controlOutputs: c2.outputs, controlFiles: rd(path.join(ctx2, 'files.txt')) };
  assert.equal(out.reproduced, true); assert.equal(out.collectLimitsBytes, 0); assert.equal(out.diffDroppedBytes, 0);
  return out;
});

// U3: test-candidates capped at 60 files (also 16 KiB); a file past the cap that focus.js picks gets no candidate tests and is not in pack-cut.txt.
await probe('U3-candidate-cap-vs-focus', async () => {
  const files = {};
  for (let i = 0; i < 61; i++) files[`src/f${String(i).padStart(2, '0')}.js`] = 'exports.a = 1;\n';
  files['src/zzz.js'] = 'exports.zzz = function (v) { return v; };\n';
  files['tests/zzz.test.js'] = 'const { zzz } = require("../src/zzz");\nassert.equal(zzz(1), 1);\n';
  const r = repo(files); const base = r.commit('base');
  const risky = ['exports.zzz = function (v) {'].concat(Array.from({ length: 40 }, (_, i) => `  if (v === ${i}) { throw new Error("bad ${i}"); } else if (v > ${i + 100}) { return ${i}; }`), ['  return v + 1;', '};']).join('\n') + '\n';
  const edit = {}; for (let i = 0; i < 61; i++) edit[`src/f${String(i).padStart(2, '0')}.js`] = 'exports.a = 2;\n';
  edit['src/zzz.js'] = risky; r.put(edit); const head = r.commit('head');
  const ctx = path.join(r.dir, '.specguard-ctx');
  const c = collect(r.dir, ctx, { BASE_SHA: base, HEAD_SHA: head });
  const cand = rd(path.join(ctx, 'test-candidates.txt')) || '', focus = rd(path.join(ctx, 'focus.txt')) || '';
  const packer = R('src/engines/claude-api.js');
  const pack = packer.contextPack(ctx, r.dir, 250000);
  const out = { reproduced: false, collectOutputs: c.outputs, candidatesListZzz: /^src\/zzz\.js$/m.test(cand), candidatesTail: cand.trim().split('\n').slice(-1)[0], focusPicksZzz: /^src\/zzz\.js\t/m.test(focus), focusFirst: focus.split('\n')[0],
    packHasZzzSource: pack.text.includes('src/zzz.js'), packHasZzzTest: pack.text.includes('tests/zzz.test.js'), packNotWhole: pack.notWhole, packCutTxt: rd(path.join(ctx, 'pack-cut.txt')) };
  r.git('checkout', '-q', base); r.git('checkout', '-q', '-b', 'ctl'); r.put({ 'src/zzz.js': risky }); const head2 = r.commit('ctl');
  const ctx2 = path.join(r.dir, '.specguard-ctx2'); collect(r.dir, ctx2, { BASE_SHA: base, HEAD_SHA: head2 });
  out.control = { candidates: (rd(path.join(ctx2, 'test-candidates.txt')) || '').trim(), packHasZzzTest: packer.contextPack(ctx2, r.dir, 250000).text.includes('tests/zzz.test.js') };
  out.reproduced = !out.candidatesListZzz && out.focusPicksZzz && !out.packHasZzzTest && !out.packNotWhole.includes('tests/zzz.test.js');
  return out;
});

// U4: --fail-on-gaps returns 0 when post.js status is not complete and there are no gaps.
await probe('U4-fail-on-gaps-ignores-failed-status', async () => {
  const r = repo({ 'src/price.js': 'function total(x) {\n  return x;\n}\nmodule.exports = { total };\n' }); r.commit('base');
  r.git('checkout', '-q', '-b', 'feature'); r.put({ 'src/price.js': 'function total(x) {\n  if (x > 100) return 100;\n  return x;\n}\nmodule.exports = { total };\n' }); r.commit('cap');
  const local = R('bin/specguard-local.js');
  const canned = (name, body) => { const p = path.join(r.dir, '..', name); fs.writeFileSync(p, body); roots.push(p); return p; };
  const runMain = async (file, extra = []) => {
    const lines = [], oLog = console.log, oErr = console.error, cwd = process.cwd();
    process.chdir(r.dir); console.log = (m) => lines.push(String(m)); console.error = () => {};
    try { return await withEnv({ SPECGUARD_LOCAL_FINDINGS: file }, async () => { const code = await local.main(['--base', 'main', '--json', '--fail-on-gaps', ...extra]); return { code, json: JSON.parse(lines.join('\n')) }; }); }
    finally { process.chdir(cwd); console.log = oLog; console.error = oErr; }
  };
  const bad = await runMain(canned('sg-supp2-bad-findings.json', 'this is not json'));
  const out = { reproduced: false, failedRun: { exit: bad.code, status: bad.json.status, gaps: bad.json.gaps, summaryHead: String(bad.json.summary).slice(0, 160) } };
  // incomplete: valid report that leaves a thing unreviewed
  const beh = { path: 'src/price.js', line: 2, quote: 'if (x > 100) return 100;' };
  const inc = { requirements: [], requirements_source: 'commit messages', not_reviewed: 'Could not read the second module.', coverage: [{ id: 'O1', obligation: 'cap at 100', source: 'commit message', behaviour: beh, change: { ...beh }, evidence: [], status: 'unknown', reason: 'ran out of context', alignment: { status: 'not_applicable', reason: 'none' } }], findings: [], standards: { status: 'no_rules', sources: [], reason: 'none' }, layering: { status: 'checked', reason: 'none' } };
  const part = await runMain(canned('sg-supp2-partial-findings.json', JSON.stringify(inc)));
  out.partialRun = { exit: part.code, status: part.json.status, gaps: part.json.gaps };
  out.reproduced = bad.code === 0 && bad.json.status !== 'complete' && bad.json.gaps === false;
  return out;
});

// U5/U6: leads.assertionDelta
const { assertionDelta } = R('src/leads.js');
const isTest = (f) => /\.test\./.test(f);
const mk = (file, hunks) => `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n${hunks}`;
await probe('U5-assertion-delta-cross-test-repin', async () => {
  const A = (add) => `@@ -10,5 +10,${add ? 6 : 4} @@\n test('a', () => {\n   const result = run();\n-  expect(result).toEqual({a:1,b:2});\n${add}   done();\n });\n`;
  const C = `@@ -40,3 +40,4 @@\n test('c', () => {\n   const result = other();\n+  expect(result).toBe(true);\n });\n`;
  const removedOnly = assertionDelta(mk('t/x.test.js', A('')), isTest);
  const withC = assertionDelta(mk('t/x.test.js', A('') + C), isTest);
  const weakA = assertionDelta(mk('t/x.test.js', A('+  expect(result).toBeDefined();\n')), isTest);
  const weakAC = assertionDelta(mk('t/x.test.js', A('+  expect(result).toBeDefined();\n') + C), isTest);
  const five = (add) => assertionDelta(mk('t/y.test.js', `@@ -3,3 +3,3 @@\n test('p', () => {\n-  expect(total(2)).toBe(5);\n${add}\n });\n`), isTest);
  const g = five('+  expect(total(2)).toBeGreaterThan(0);'), g0 = five('+  expect(total(3)).toBe(1);');
  const out = { removedOnly, withC, weakA, weakAC, toBe5ToGreaterThan: g, controlOtherSubject: g0 };
  out.reproduced = removedOnly.length === 1 && withC.length === 0;
  out.toBe5Suppressed = g.length === 0;
  return out;
});
await probe('U6-deleted-test-file-no-lead', async () => {
  const del = 'diff --git a/t/x.test.js b/t/x.test.js\ndeleted file mode 100644\n--- a/t/x.test.js\n+++ /dev/null\n@@ -1,3 +0,0 @@\n-test("f", () => {\n-  expect(f(1)).toBe(2);\n-});\n';
  const mod = mk('t/x.test.js', '@@ -1,3 +1,2 @@\n test("f", () => {\n-  expect(f(1)).toBe(2);\n });\n');
  const d = assertionDelta(del, isTest), m = assertionDelta(mod, isTest);
  return { reproduced: d.length === 0 && m.length === 1, deletedFile: d, sameAssertionRemovedFromLiveFile: m.map((x) => x.kind) };
});

// U7: bundle.js parsers vs a real buildSummary (dropped + over-cap finding)
await probe('U7-bundle-parsers-vs-buildSummary', async () => {
  const post = R('src/post.js'), bundle = R('eval/bundle.js');
  const b = { path: 'a.js', line: 10, quote: 'return boundary(value);' };
  const f = { kind: 'missing_test', path: 'a.js', line: 10, title: 'Boundary A', body: 'Missing assertion', quote: b.quote, confidence: 'high', obligation_ids: ['O1'] };
  const b2 = { ...b, line: 20 };
  const f2 = { ...f, line: 20, title: 'Boundary B', obligation_ids: ['O2'] };
  const bad = { kind: 'missing_test', path: 'a.js', line: 30, quote: b.quote, body: 'no title', confidence: 'high', obligation_ids: ['O1'] };
  const row = (id, bb) => ({ id, obligation: 'Boundary ' + id, source: 'from behaviour', behaviour: bb, change: bb, evidence: [], status: 'missing_test', reason: 'No test', alignment: { status: 'not_applicable', reason: 'none' } });
  const raw = { requirements: [], requirements_source: 'none', not_reviewed: '', coverage: [row('O1', b), row('O2', b2)], findings: [f, f2, bad, { kind: 'missing_test', path: 'a.js', line: 40, title: 'Titled but no quote', body: 'x', confidence: 'high', obligation_ids: ['O1'] }], standards: { status: 'no_rules', sources: [], reason: 'None' }, layering: { status: 'checked', reason: 'none' } };
  const data = JSON.parse(JSON.stringify(raw));
  const v = post.validate(data); const notes = data.validation_notes || [];
  assert(v.ok, JSON.stringify(v));
  const summary = post.buildSummary({ cov: { reports: 0 }, data, items: [{ f: data.findings[0], why: 'over max_comments' }, { f: data.findings[1], why: 'over max_comments' }], notes, blob: 'https://github.com/example/repo/blob/abc/' });
  const parsedSummary = bundle.parseSummary(summary), parsedDropped = bundle.parseDropped(summary, raw);
  const dropLine = (summary.split('\n').find((l) => /Dropped findings/.test(l)) || null);
  return { reproduced: parsedSummary.length === 0, bundleDroppedMatchesTitled: parsedDropped.length > 0, droppedLines: summary.split('\n').filter((l) => /Dropped findings/.test(l)), validateKeys: Object.keys(v), notes, droppedLineInSummary: dropLine, hasMoreItemsDetails: /\d+ more item\(s\)/.test(summary),
    bundleSummaryCount: parsedSummary.length, bundleDroppedCount: parsedDropped.length, summaryHeadings: summary.split('\n').filter((l) => /^#{2,3} |<summary>/.test(l)).slice(0, 12) };
});

// U8: results-prove.json location
await probe('U8-results-prove-shared-path', async () => {
  const src = rd(path.join(root, 'eval/prove.js')).split('\n');
  const line = src.findIndex((l) => l.includes("'results-prove.json'")) + 1;
  const prove = R('eval/prove.js');
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-supp2-prove-')); roots.push(out);
  const mkcase = (id) => { const d = path.join(out, id); fs.mkdirSync(path.join(d, 'repo'), { recursive: true }); fs.writeFileSync(path.join(d, 'prove.json'), JSON.stringify({ findings: [] }));
    fs.writeFileSync(path.join(d, 'repo', 'a.txt'), 'x\n'); git(path.join(d, 'repo'), 'init', '-q'); git(path.join(d, 'repo'), 'add', '-A'); git(path.join(d, 'repo'), '-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'i'); return d; };
  mkcase('caseA'); mkcase('caseB');
  const detail = { line, lineText: src[line - 1].trim(), reproduced: false };
  try {
    const ra = prove.check({ id: 'caseA', out }); const rb = prove.check({ id: 'caseB', out });
    detail.runOk = true; detail.resultFilesInOut = fs.readdirSync(out).filter((n) => n.endsWith('.json')); detail.perCaseResults = ['caseA', 'caseB'].map((c) => fs.existsSync(path.join(out, c, 'results-prove.json')));
    detail.reproduced = detail.resultFilesInOut.includes('results-prove.json') && detail.perCaseResults.every((x) => !x);
  } catch (e) { detail.runOk = false; detail.runError = String(e.message).slice(0, 200); detail.reproduced = /path\.resolve\(out\), 'results-prove\.json'/.test(src[line - 1]); detail.note = 'static only'; }
  return detail;
});

// U9: static quote of both lines
await probe('U9-example-vs-trace-boundary-rule', async () => {
  const ex = rd(path.join(root, 'skills/test-review/references/example.json')).split('\n'), tr = rd(path.join(root, 'skills/test-review/references/trace.md')).split('\n');
  const t44 = tr[43], e4 = ex[3];
  const evidenceAsserts = (e4.match(/assert\.\w+\([^)]*\)/g) || []);
  return { reproduced: /both sides of the boundary/.test(t44) && /"status":"covered"/.test(e4) && evidenceAsserts.length === 1, trace_md_44: t44, example_json_4: e4.slice(0, 520), evidenceAssertions: evidenceAsserts };
});

// U10: findingId collision
await probe('U10-findingId-ignores-kind', async () => {
  const { findingId, exportRows } = R('eval/label-export.js');
  const base = { tool: 'specguard', repo: 'o/r', pr: 5, path: 'a.js', line: 10 };
  const a = { ...base, kind: 'missing_test', text: 'No test for the cap' }, b = { ...base, kind: 'weak_test', text: 'Assertion too weak' };
  let rows = null; try { rows = exportRows([a, b], { sample: 30, seed: 1 }); } catch (e) { rows = String(e.message); }
  return { reproduced: findingId(a) === findingId(b), idA: findingId(a), idB: findingId(b), exportRowIds: Array.isArray(rows) ? rows.map((x) => x.id) : rows };
});

// U11: szz.fixLines on a .sql diff with a removed `-- comment` line
await probe('U11-szz-sql-comment-as-header', async () => {
  const szz = R('eval/szz.js');
  const mkr = (first) => { const r = repo({ 'db/q.sql': `${first}\nselect 1;\nselect 2;\nselect 3;\n` }); const p = r.commit('parent'); r.put({ 'db/q.sql': `select 1;\nselect 2;\nselect 33;\n` }); const s = r.commit('fix'); return { r, p, s }; };
  const sql = mkr('-- header comment'), ctl = mkr('select 0;');
  const got = szz.fixLines(sql.r.dir, sql.p, sql.s), ref = szz.fixLines(ctl.r.dir, ctl.p, ctl.s);
  return { reproduced: JSON.stringify(got.map((f) => f.lines)) !== JSON.stringify(ref.map((f) => f.lines)) && got.every((f) => !f.lines.includes(4)) && ref.some((f) => f.lines.includes(4)),
    withSqlComment: got, control: ref, rawDiff: git(sql.r.dir, 'diff', '-U0', '-w', '-M', '--no-color', sql.p, sql.s).split('\n').slice(0, 12) };
});

// U12: testScope with an exclusion-only test_paths
await probe('U12-testScope-exclusion-only', async () => {
  const trace = R('src/trace.js');
  const s = trace.testScope('!legacy/**');
  return { reproduced: s === null, scopeIsNull: s === null, note: 'null = discovery by name, i.e. the exclusion is not applied to the test set (collect.sh: `scope ? ... : isTestPath`)', legacyTestStillATest: trace.isTestPath('legacy/a.test.js') };
});

console.log(JSON.stringify(results, null, 2));
})().finally(() => {
  const tmp = path.resolve(fs.realpathSync(os.tmpdir())) + path.sep;
  for (const r of roots) { try { const p = fs.realpathSync(r); if (p.startsWith(tmp) && path.basename(p).startsWith('sg-supp2-')) fs.rmSync(p, { recursive: true, force: true }); } catch {} }
});
```

</details>

### Appendix B actual results (main ee1c158)

<details>
<summary>Expand the script or result</summary>

```json
[
  {
    "id": "U1-absent-base-silent-skip",
    "reproduced": true,
    "baseInClone": false,
    "collectExit": 0,
    "collectOutputs": [
      "skip=false",
      "partial=false",
      "skip=true"
    ],
    "collectStdout": "::warning::no merge-base of BASE_SHA and HEAD_SHA (shallow clone? use fetch-depth 0); diff-side history may not line up\nnothing reviewable in diff",
    "warning": "",
    "diffPatchBytes": 0,
    "filesTxt": "",
    "postStatus": "complete",
    "summaryHasNothingToReview": true,
    "summaryHasHeadMarker": true,
    "countsComplete": null
  },
  {
    "id": "U2-nested-build-dir-ignored-silently",
    "reproduced": true,
    "outputs": [
      "skip=false",
      "partial=false",
      "skip=true"
    ],
    "stdout": "nothing reviewable in diff",
    "collectLimitsBytes": 0,
    "diffDroppedBytes": 0,
    "controlOutputs": [
      "skip=false",
      "partial=false"
    ],
    "controlFiles": "internal/other/y.go\n"
  },
  {
    "id": "U3-candidate-cap-vs-focus",
    "reproduced": true,
    "collectOutputs": [
      "skip=false",
      "partial=false"
    ],
    "candidatesListZzz": false,
    "candidatesTail": "(2 more changed file(s) not listed)",
    "focusPicksZzz": true,
    "focusFirst": "src/zzz.js\t8.0\tlogic +3.0, size +2.5, 42 branch/error line(s) changed +2.0, 1 of them removed +0.5",
    "packHasZzzSource": true,
    "packHasZzzTest": false,
    "packNotWhole": [],
    "packCutTxt": null,
    "control": {
      "candidates": "src/zzz.js\n  tests/zzz.test.js  (same name)",
      "packHasZzzTest": true
    }
  },
  {
    "id": "U4-fail-on-gaps-ignores-failed-status",
    "reproduced": true,
    "failedRun": {
      "exit": 0,
      "status": "failed",
      "gaps": false,
      "summaryHead": "<!-- specguard:summary -->\n<!-- specguard:status=failed -->\n## SpecGuard\n\n**⚠️ Could not complete: no valid findings.json (parse error); see the job log**\n\n<det"
    },
    "partialRun": {
      "exit": 0,
      "status": "complete",
      "gaps": false
    }
  },
  {
    "id": "U5-assertion-delta-cross-test-repin",
    "removedOnly": [
      {
        "file": "t/x.test.js",
        "kind": "removed",
        "line": 12,
        "old": "expect(result).toEqual({a:1,b:2});"
      }
    ],
    "withC": [],
    "weakA": [
      {
        "file": "t/x.test.js",
        "kind": "weakened",
        "line": 12,
        "old": "expect(result).toEqual({a:1,b:2});",
        "new": "expect(result).toBeDefined();"
      }
    ],
    "weakAC": [],
    "toBe5ToGreaterThan": [],
    "controlOtherSubject": [
      {
        "file": "t/y.test.js",
        "kind": "removed",
        "line": 4,
        "old": "expect(total(2)).toBe(5);"
      }
    ],
    "reproduced": true,
    "toBe5Suppressed": true
  },
  {
    "id": "U6-deleted-test-file-no-lead",
    "reproduced": true,
    "deletedFile": [],
    "sameAssertionRemovedFromLiveFile": [
      "removed"
    ]
  },
  {
    "id": "U7-bundle-parsers-vs-buildSummary",
    "reproduced": true,
    "bundleDroppedMatchesTitled": true,
    "droppedLines": [
      "- Dropped findings[2] missing_test a.js: path, title, body and quote must be strings.",
      "- Dropped findings[3] missing_test a.js Titled but no quote: path, title, body and quote must be strings."
    ],
    "validateKeys": [
      "ok"
    ],
    "notes": [
      "Dropped findings[2] missing_test a.js: path, title, body and quote must be strings.",
      "Dropped findings[3] missing_test a.js Titled but no quote: path, title, body and quote must be strings."
    ],
    "droppedLineInSummary": "- Dropped findings[2] missing_test a.js: path, title, body and quote must be strings.",
    "hasMoreItemsDetails": false,
    "bundleSummaryCount": 0,
    "bundleDroppedCount": 1,
    "summaryHeadings": [
      "## SpecGuard",
      "### Missing unit tests (2)",
      "<details><summary>Details: evidenced criteria, obligations, sources, run information</summary>"
    ]
  },
  {
    "id": "U8-results-prove-shared-path",
    "line": 443,
    "lineText": "fs.writeFileSync(path.join(path.resolve(out), 'results-prove.json'), JSON.stringify(result, null, 2) + '\\n');",
    "reproduced": true,
    "runOk": true,
    "resultFilesInOut": [
      "results-prove.json"
    ],
    "perCaseResults": [
      false,
      false
    ]
  },
  {
    "id": "U9-example-vs-trace-boundary-rule",
    "reproduced": true,
    "trace_md_44": "A test must assert both sides of the boundary (n-1, n, n+1); if it does not, report `weak_test` for the missing boundary.",
    "example_json_4": "{\"id\":\"O1\",\"obligation\":\"Orders of 100 or more get a 10% discount\",\"source\":\"PR body AC 1\",\"behaviour\":{\"path\":\"src/discount.js\",\"line\":4,\"quote\":\"if (total >= 100) return total * 0.9;\"},\"evidence\":[{\"path\":\"test/discount.test.js\",\"line\":9,\"quote\":\"assert.equal(discount(100), 90);\"}],\"status\":\"covered\",\"reason\":\"The unit test asserts the boundary 100 against the literal 90.\",\"alignment\":{\"status\":\"consistent\",\"reason\":\"R: 100 or more; C: total >= 100\"}},",
    "evidenceAssertions": [
      "assert.equal(discount(100)"
    ]
  },
  {
    "id": "U10-findingId-ignores-kind",
    "reproduced": true,
    "idA": "F502e6ddc0",
    "idB": "F502e6ddc0",
    "exportRowIds": [
      "F502e6ddc0",
      "F502e6ddc0"
    ]
  },
  {
    "id": "U11-szz-sql-comment-as-header",
    "reproduced": true,
    "withSqlComment": [
      {
        "path": "db/q.sql",
        "lines": [],
        "addOnly": true
      }
    ],
    "control": [
      {
        "path": "db/q.sql",
        "lines": [
          1,
          4
        ],
        "addOnly": false
      }
    ],
    "rawDiff": [
      "diff --git a/db/q.sql b/db/q.sql",
      "index 1d39ca9..d546eb1 100644",
      "--- a/db/q.sql",
      "+++ b/db/q.sql",
      "@@ -1 +0,0 @@",
      "--- header comment",
      "@@ -4 +3 @@ select 2;",
      "-select 3;",
      "+select 33;"
    ]
  },
  {
    "id": "U12-testScope-exclusion-only",
    "reproduced": true,
    "scopeIsNull": true,
    "note": "null = discovery by name, i.e. the exclusion is not applied to the test set (collect.sh: `scope ? ... : isTestPath`)",
    "legacyTestStillATest": true
  }
]
```

</details>

### Appendix C: probes V1–V2 (audit-supplement-3.cjs)

<details>
<summary>Expand the script or result</summary>

```javascript
// Supplement-3 probes (V1, V2). Run from the checkout root of ee1c158: node audit-supplement-3.cjs
// V1: exported functions of src/*.js and eval/*.js that no test file mentions by name (the repo's own coding standard, .github/instructions/specguard.instructions.md:8).
// V2: eval/replay.js finishRealOne/table when the model never wrote findings.json (the row says findings_present:false; the printed table has no such column).
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), cp = require('node:child_process');
const root = process.env.SG_ROOT || process.cwd();
const R = (p) => require(path.join(root, p));
const out = {};
const tracked = cp.execFileSync('git', ['ls-tree', '-r', '--name-only', process.env.SG_REF || 'origin/main'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean);
// ---- V1
const tests = tracked.filter((f) => /\.test\.js$/.test(f)).map((f) => fs.readFileSync(path.join(root, f), 'utf8')).join('\n');
const prod = tracked.filter((f) => /^(src|eval)\/[^/]+\.js$/.test(f) && !/\.test\.js$/.test(f));
const unref = [], noSibling = [];
for (const f of prod) {
  let m; try { m = require(path.join(root, f)); } catch { continue; }
  const names = Object.keys(m).filter((k) => typeof m[k] === 'function');
  const miss = names.filter((n) => !new RegExp('\\b' + n.replace(/\$/g, '\\$') + '\\b').test(tests));
  if (miss.length) unref.push({ file: f, unreferenced: miss });
  if (names.length && !tracked.includes(f.replace(/\.js$/, '.test.js'))) noSibling.push(f);
}
out.V1 = { prodFilesChecked: prod.length, filesWithUnreferencedExports: unref, exportingFilesWithoutSiblingTest: noSibling };
// ---- V2
(async () => {
  const replay = R('eval/replay.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-supp3-'));
  try {
    const id = 'nofindings', d = path.join(dir, id); fs.mkdirSync(path.join(d, 'ctx'), { recursive: true });
    fs.writeFileSync(path.join(d, 'meta.json'), JSON.stringify({ id, base: 'b'.repeat(40), head: 'a'.repeat(40), trace: 'auto', skip: false, partial: false, repo: dir }));
    let row, err = null;
    try { row = await replay.finishRealOne(id, dir); } catch (e) { err = String(e.message).split('\n')[0]; }
    out.V2 = row ? { row, printedTable: replay.table([row]), tableMentionsFindingsPresent: /findings_present|present/.test(replay.table([row])) } : { error: err };
  } finally { const p = fs.realpathSync(dir); if (p.startsWith(fs.realpathSync(os.tmpdir())) && path.basename(p).startsWith('sg-supp3-')) fs.rmSync(p, { recursive: true, force: true }); }
  console.log(JSON.stringify(out, null, 2));
})();
```

</details>

### Appendix C actual results (main ee1c158)

<details>
<summary>Expand the script or result</summary>

```json
﻿{
  "V1": {
    "prodFilesChecked": 43,
    "filesWithUnreferencedExports": [
      {
        "file": "eval/ab.js",
        "unreferenced": [
          "convertFree"
        ]
      },
      {
        "file": "eval/bundle.js",
        "unreferenced": [
          "rng",
          "shuffle"
        ]
      },
      {
        "file": "eval/degrade.js",
        "unreferenced": [
          "auditBuiltin",
          "auditFixture",
          "evaluateAudit",
          "fromCase"
        ]
      },
      {
        "file": "eval/field.js",
        "unreferenced": [
          "isDoc",
          "isCode",
          "measureCommit",
          "measureRepo",
          "bigCommit"
        ]
      },
      {
        "file": "eval/label-export.js",
        "unreferenced": [
          "shuffle"
        ]
      },
      {
        "file": "eval/prove.js",
        "unreferenced": [
          "subExprVariants",
          "checkPlan"
        ]
      },
      {
        "file": "eval/run.js",
        "unreferenced": [
          "rawOutput"
        ]
      },
      {
        "file": "eval/signal.js",
        "unreferenced": [
          "enclosingFn"
        ]
      },
      {
        "file": "src/audit-collect.js",
        "unreferenced": [
          "allBlocks"
        ]
      },
      {
        "file": "src/audit-post.js",
        "unreferenced": [
          "findIssue"
        ]
      },
      {
        "file": "src/coverage.js",
        "unreferenced": [
          "gocover"
        ]
      },
      {
        "file": "src/leads.js",
        "unreferenced": [
          "symbolsOf"
        ]
      },
      {
        "file": "src/post.js",
        "unreferenced": [
          "assertionKind",
          "counterexampleOk",
          "citationsOf",
          "loadCoverage",
          "applyCoverage",
          "coverageAtoms",
          "findingBlock",
          "findingHead"
        ]
      },
      {
        "file": "src/test-map.js",
        "unreferenced": [
          "indexTests",
          "noExt",
          "classAndMethod"
        ]
      },
      {
        "file": "src/trace.js",
        "unreferenced": [
          "testScope",
          "catBatch"
        ]
      }
    ],
    "exportingFilesWithoutSiblingTest": [
      "src/limitations.js",
      "src/scan-parts.js"
    ]
  },
  "V2": {
    "row": {
      "id": "nofindings",
      "trace": "auto",
      "findings_present": false,
      "inline": {
        "total": 0,
        "byKind": {},
        "byConfidence": {
          "high": 0,
          "low": 0
        }
      },
      "summary_only": 0,
      "pre_existing": 0
    },
    "printedTable": "pr          trace  inline  high  low  summary  pre-existing\nnofindings  auto   0       0     0    0        0",
    "tableMentionsFindingsPresent": false
  }
}
```

</details>

### Appendix C: coverage check script (coverage-check.cjs)

<details>
<summary>Expand the script or result</summary>

```javascript
// Coverage check for the supplement's section 2: git ls-tree minus the declared out-of-scope patterns, diffed against the paths/globs in the table.
// Run from a checkout: node coverage-check.cjs <doc.md> [ref]
const fs = require('node:fs'), cp = require('node:child_process');
const doc = fs.readFileSync(process.argv[2], 'utf8').replace(/\r/g, ''), ref = process.argv[3] || 'origin/main';
const tracked = cp.execFileSync('git', ['ls-tree', '-r', '--name-only', ref], { encoding: 'utf8' }).split('\n').filter(Boolean);
const rx = (g) => new RegExp('^' + g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*\//g, '\u0001').replace(/\*\*/g, '\u0002').replace(/\*/g, '[^/]*').replace(/\u0001/g, '(.*/)?').replace(/\u0002/g, '.*') + '$');
const OUT = ['**/*.test.js', 'test/**', 'tests/**', '**/fixtures/**', 'eval/cases/**', 'eval/results/**', 'eval/replay/*.json', 'docs/**', 'research/**', 'NOTICE', '.gitattributes', '.gitignore', 'eval/**/README.md'].map(rx);
const inScope = tracked.filter((f) => !OUT.some((r) => r.test(f)));
const sec = doc.slice(doc.indexOf('\n## 2.'), doc.indexOf('\n## 3.'));
const secLines = sec.split('\n'), start = secLines.findIndex((l) => l.startsWith('| File | Status |'));
let end = start + 1; while (end < secLines.length && secLines[end].startsWith('|')) end++;
const rows = secLines.slice(start + 2, end); // the first table only (the out-of-scope table below it is not a coverage claim)
const globs = rows.flatMap((l) => [...l.split('|')[1].matchAll(/`([^`]+)`/g)].map((m) => m[1]));
const listed = new Set(), unmatchedGlobs = [];
for (const g of globs) { const r = rx(g); const hit = tracked.filter((f) => r.test(f)); if (!hit.length) unmatchedGlobs.push(g); hit.forEach((f) => listed.add(f)); }
const missing = inScope.filter((f) => !listed.has(f)), extra = [...listed].filter((f) => !inScope.includes(f));
console.log(JSON.stringify({ ref, tracked: tracked.length, outOfScope: tracked.length - inScope.length, inScope: inScope.length, listedInScope: inScope.length - missing.length, tableGlobs: globs.length, missing, listedButOutOfScope: extra, globsMatchingNothing: unmatchedGlobs }, null, 2));
```

</details>

### Appendix C: coverage check output

<details>
<summary>Expand the script or result</summary>

```json
{
  "ref": "origin/main",
  "tracked": 543,
  "outOfScope": 459,
  "inScope": 84,
  "listedInScope": 84,
  "tableGlobs": 71,
  "missing": [],
  "listedButOutOfScope": [],
  "globsMatchingNothing": []
}
```

</details>
