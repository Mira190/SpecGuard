# Shift-left and goal alignment: a first-principles critical review

Date: 2026-10-14. Baseline: main `59bfffb` (#120–#124 merged).
Nature: analysis only. This document builds on `docs/goal-first-principles.md` (U1–U20) and `docs/handoff-goal-critique.md` (N1–N18, P0/P1). It does not repeat their arguments; it only gives the state changes and new problems that appeared after those two documents were written.

**Update (same day, afternoon):** §1–§8 are the morning review, kept as originally written. The afternoon's real runs, the status changes of C1–C8, newly found problems, and the problems still unresolved are in §9. The evening's fixes, the handling of two external reviews, the safety backstops, and the Kite acceptance are in §10.

## 1. Conclusions

1. **SpecGuard can now find real test defects on real external PRs, at about $0.01 per run.** A manual run on date-fns#4366 on 2026-10-14 found 2 problems, and both held up under human checking: one missing test and one weak test that "still passes with the fix removed" (§4). This is exactly the kind of finding shift-left wants most.
2. **The biggest gap is still that "is the result useful" has never been measured in real use.** did-fix, false-positive rate, and time-to-merge are all zero data so far (§5 C1). Moreover, **the manual-run main path structurally cannot collect did-fix**: it only writes results to the run page, does not write to the PR, and does not track later pushes.
3. **The engine validated today is not the engine the company will use.** All of today's quality data comes from Claude Haiku 5.5 (temporary secret `SPEC`). The company's default path is the Copilot PAT, which has not run recently because the quota ran out (§5 C2).
4. **Which model provider company code is sent to (Q8) must be settled before SpecGuard analyzes any internal repository.** Right now, a manual run that uses `SPEC` on a private repository sends the code to the Anthropic API.
5. **A lot has been done on precision (no false positives), but recall (no misses) has not been measured on the current engine.** Truncation guards and the reduced review showing only high-confidence items all suppress false positives. But without recall measured on a real repository with seeded defects, "quiet" may just mean "not looking" (§5 C4).
6. **Test layering is still judged by the model, and push-down suggestions depend on that judgment.** An express test that goes through HTTP with supertest was labeled "unit" (§5 C5). By many teams' definitions, this kind of test is a component test.
7. **Requirement capture depends on the PR body.** All three runs today showed "no structured acceptance criteria found". If the company's PR bodies are thin, the review degrades into "code-only test gaps" (§5 C6).

## 2. First principles: the shift-left value chain

For a defect to be stopped at the PR stage, every link below must hold. If any link breaks, the value drops to zero.

| Link | Condition that must hold | Evidence today | Status |
|---|---|---|---|
| E1 Exists | The defect can be seen statically at PR time | Only OSS data; the 50-defect classification of the user's repositories (N7/P0-1) has not been done | Unknown |
| E2 Sees | The engine reads the relevant code, tests, and requirements | The context pack reads files named in the requirements and files in the same directory (#124); date-fns read `subMonths/test.ts` | Partial |
| E3 Says it right | Findings are real and citations are accurate | All 4 external findings today were verified by hand; dogfood had 1 false positive (test file truncated), and a guard was added (#123) | Good on a small sample |
| E4 In time | Delivered to the author before merge | PR mode runs on every push, in about 1 minute. **Manual runs only write the run page, which the author cannot see** | Holds for PR mode, not for manual runs |
| E5 Understood | Within 10 seconds the author knows which test to add | summary v2: conclusion on the first line, with a test skeleton; the top layout is being redone (`feat/summary-clarity`) | In progress |
| E6 Acts | The author actually made changes | Zero real data (N18) | Not tested |
| E7 Worth it | Benefit exceeds noise, latency, and cost | Cost is down to $0.01–0.10 per run; there is no real data on noise and latency | Cost holds |

**Inference:** E3 and E5 are the links that got the most investment this round and are now close to usable. The real risk is in E1, E4, and E6: they decide whether SpecGuard is a "tool" or a "decoration", yet none of the three has been tested.

## 3. Goal alignment

Original requirement (`docs/design.md:40-47`): review requirements and tests, find missing unit tests; confirm coding standards; check which component/integration tests should be pushed down to unit tests; the first phase delivers a GitHub Actions workflow. The decisions the user added on 2026-10-13 are in `design.md:57-63`, and they make the main path a manual run in the SpecGuard repository that analyzes other repositories.

| Goal | Current state | Evidence | Gap |
|---|---|---|---|
| G1 Requirements + tests → missing unit tests | Works; quality is good on a small sample | date-fns missing test and weak test (§4); express 9/9 obligations have evidence | recall not measured; requirements depend on the PR body |
| G2 Coding standards confirmed | Can read rule files; lint results need `standards_checks` to be configured | express run: "Lint/format tools are configured … results are not confirmed" | A manual run cannot get the target repository's CI check results, so "confirmation" only goes as far as reading the rule files |
| G3 Test push-down | A suggestion mechanism exists, but it has never been validated | `design.md:511` "Pushdown suggestions are not validated"; supertest was labeled unit | The layering definition varies by organization (N14), and the model's judgment is unreliable |
| G4 GitHub workflow delivery | Done: PR workflow, reusable workflow, manual run, local run | `.github/workflows/*`, `bin/specguard-local.js` | Private repositories need `SPECGUARD_PAT` (not set) |
| G5 Manual run analyzes other repositories (main path) | Works on public repositories; results can be downloaded (artifact) | 4 manual runs today | Cannot analyze closed or merged PRs; scan mode was not run for real with Claude today; results do not reach the author |
| G6 PAT-first billing | The Copilot PAT path is code-ready; Claude is the other, auto-adapted path | `src/credential.js` | The Copilot path has not been run for real recently (quota ran out) |

## 4. Today's empirical results (manual runs, Claude Haiku 5.5)

| Run | Before the fix (before #124) | After the fix |
|---|---|---|
| express#7511 | 3/7 obligations have evidence; 4 were wrongly downgraded by citation validation; requirement X1 showed "Check by hand" | 9/9 have evidence, no false positives |
| date-fns#4366 | The context pack read only 20 KB; `subMonths` was not read | Read `subMonths/test.ts`, reported 1 missing test and 1 weak test, both verified by hand |

The date-fns weak test deserves a separate mention: `addMonths(January 15, -1.5)` gives the same result before and after the fix, because JS `setMonth` truncates on its own. So this assertion cannot detect a regression. SpecGuard supplied an input that distinguishes before from after (March 15). This is exactly the kind of problem that coverage tools and "does a test exist" checks cannot see.

During dogfood (SpecGuard reviewing its own PRs), it reported 2 real weak or missing tests, both fixed and verified in reverse (remove the logic under test and the test fails). There was also 1 false positive, caused by a 3000-line test file being truncated. #123 added a guard: when a test file was not fully read, asserting "missing test" is not allowed.

**Sample limitation:** There are only 2 external PRs, and both are from OSS libraries with excellent testing practices. This cannot represent the company's repositories.

## 5. Key problems (ordered by impact)

### C1 No result data from real use, and manual runs cannot collect it

- did-fix, false-positive rate, time-to-merge: zero data (checked by Explore, 2026-10-14). Scripts such as `eval/weekly-report.js` exist but have never run on real data.
- Manual runs use `delivery: summary`, do not write to the PR, and have no sticky summary, so there is no "Since last push" and no accumulation of fix-through. Closed or merged PRs are refused for analysis.
- **Suggestion:** Aggregate the manual-run result artifacts into a ledger issue in the SpecGuard repository, appending one row per run: target, number of findings, types, cost. For the same PR, run again after the author pushes, and comparing the two results gives fixed/new. This starts accumulating E6 data without writing anything to the target repository.

### C2 The validation engine differs from the company path, and the compliance question is still open

- All of today's quality data comes from Claude Haiku 5.5. The company's default Copilot path (`auto` model) has not run for real since the quota ran out; in the Kite pilot, Copilot failed to satisfy the JSON contract in 2 of 5 runs (`docs/pilot-kite.md:29`).
- `specguard-run.yml` and `ci.yml` still contain the temporary `llm_token: … || secrets.SPEC` and `model: haiku-5.5`.
- Q8 (may code be sent to Copilot / Anthropic) has no answer. It must be answered before running manual runs on private repositories.
- **Suggestion:** Make an explicit decision. Either Claude becomes an officially supported engine (requires Q8 approval, and renaming `SPEC` to `SPECGUARD_LLM_TOKEN`), or wait for the Copilot quota to recover, rerun the same two PRs with Copilot for an A/B comparison, and then remove the temporary configuration.

### C3 Reduced review is the norm for Haiku, and its cost is not quantified

- Haiku is classified as the fast tier, so every run is reduced: only high-confidence findings are shown. Both of today's date-fns findings passed this gate, but there is no data on how many findings were held back or how many of those were real.
- **Suggestion:** For today's two PRs, compare the reduced output with the full output (look at the filtered-out part of findings.json) and decide whether Haiku plus the context pack still needs the reduced review.

### C4 Recall has not been measured on the current engine

- Most changes this round suppress false positives (citation validation, truncation guard, low-confidence items not counted). All of that is right, but "quiet" and "not looking" look identical in the output.
- Tools for seeding defects already exist (`eval/mutate`, seeded cases); they just have not been run with Claude and the context pack.
- **Suggestion:** Pick 1 public repository, seed 10 known test gaps (delete assertions, loosen assertions, delete boundary cases), run it as a manual run, and report recall. If recall is below 6/10, stop adding rules that suppress false positives.

### C5 Test layering relies on model judgment, so push-down suggestions are unreliable

- An express test that sends HTTP requests with supertest was labeled "unit". For many teams that is a component test. G3 (push-down suggestions) depends on this judgment, and it has never been validated (`design.md:511`).
- **Suggestion:** Let manual runs support a `test_layers` mapping (path glob → layer), declared by the user; when none is declared, deterministic rules take precedence over model judgment (for example: anything using supertest or an HTTP client counts as a component test).

### C6 Requirement capture depends on the PR body, and company PRs may be thinner

- All three runs today said "no structured acceptance criteria found"; the requirements came from items in the PR body and linked issues. The bodies of OSS PRs are usually written carefully; company PRs may not be.
- P1-1 (an "Acceptance criteria:" section in the PR template) has not been provided as a deliverable.
- **Suggestion:** Provide a copyable PR template, and note in the summary's Details "no structured acceptance criteria; adding an `Acceptance criteria:` section to the PR body would make the review more accurate". Show it only once on the first screen, so it does not create noise.

### C7 Coverage of manual runs

- Can do: open PRs of public repositories (PR mode), scans of a repository or branch.
- Cannot do: private repositories (`SPECGUARD_PAT` not set), closed or merged PRs, execution evidence (manual runs have no `coverage_files`).
- Scan mode was not run for real with Claude today. Scan's two-run confirmation mechanism depends on issue state, but it has not completed a full cycle on a real repository.

### C8 The summary still has readability debt

- The top layout and the "Not assessed" ambiguity are being fixed (`feat/summary-clarity`).
- The obligation table in Details is still heavy, and "Unit evidence X/Y" may be misread as a KPI (N12). The PR summary has no note saying "this is not coverage and not for evaluating individuals"; scan mode has it.

## 6. Verified and not verified

| Verified (with evidence from real runs) | Not verified |
|---|---|
| Credential auto-adaptation (Claude path); cost has a hard cap | Current quality of the Copilot path |
| Found real missing tests and weak tests on external public PRs (n=2 PRs) | recall; performance on company repositories |
| The context pack can read files named by requirements | Packing effectiveness on large monorepos |
| No longer asserts missing tests when truncated | Whether the guard suppresses too many real findings |
| Manual run end to end: trigger, review, artifact | Private repositories; the two-run confirmation cycle of scan mode |
| Structure of summary v2 | Whether developers really understand within 10 seconds and go fix it (E5, E6) |

## 7. Decisions needed from the user

| Question | Why only the user can decide | What it blocks |
|---|---|---|
| Q8: may company code be sent to Anthropic (or Copilot) | Company compliance policy | Analyzing any internal repository with Claude |
| Whether Claude becomes an official engine | Procurement and billing | Removing the temporary configuration; C2 |
| Create `SPECGUARD_PAT` (read-only, target repository) | Needs creation from the user's account | Analyzing private repositories |
| 50 historical defect samples (the remaining part of Q6) | Only the user can access the defect system | E1: determining the upper bound |
| Q4: whether to review "is the requirement itself testable" | Product scope | U10, N10 |
| Q7: whether to review PRs written by coding agents | Product scope | N1 |

## 8. Next steps (by priority, with exit conditions)

| Priority | Action | Exit condition |
|---|---|---|
| P0 | Merge the summary layout fix | After rerunning date-fns, the first screen is ≤ 8 lines with no internal jargon |
| P0 | User answers Q8 and decides the official engine (C2) | Temporary `SPEC` and `haiku-5.5` are removed from both workflows |
| P0 | Manual-run result ledger (C1) | There is an issue in the SpecGuard repository that automatically appends a result row for each manual run |
| P1 | recall experiment (C4) | recall and precision numbers for 10 seeded gaps are written into `docs/validation-plan.md` |
| P1 | Compare reduced and full output (C3) | Decide whether to keep reduced review after Haiku plus the context pack |
| P1 | Do one manual run on Kite with `SPECGUARD_PAT` | The private-repository path runs end to end |
| P2 | `test_layers` declaration (C5); PR template (C6); one cycle of scan run for real with Claude (C7) | Each has one real-run result |

**What not to do:** Until C1 and C4 have data, do not add new detection mechanisms or false-positive-suppression rules. What is missing now is not mechanisms but evidence.

## 9. Afternoon update: real-run results and unresolved problems

Baseline: main `87667c0` (#164–#166 merged). Engine: Claude Haiku 5.5, API mode (one call, no tools).

### 9.1 Merged changes

| PR | Content | Problem addressed |
|---|---|---|
| #164 | The summary keeps icons only on the conclusion line; tables and headings are plain text; each finding gets its own comment | C8 |
| #165 | Match tests by public name (`test/res.status.js` corresponds to `res.status = function`); more assertion styles count (supertest `.expect(`, chai, tap, etc.); literal guard: when the error message of the cited line already appears in some test, missing_test is downgraded to low confidence | C9 (new), false positives |
| #166 | Fair-share packing: each reviewed unit's tests may use at most an equal share of the remaining budget; units that did not fully enter the context are not counted, not recorded as `covered`, and are noted on the first screen; properties defined by name (`defineGetter`) count as public names | C11 (new) |
| Kite #7, #8 | Kite's scan workflow changed to SpecGuard main plus the Claude engine, and fetches the full git history | C7 |

**Conflict with §8 "What not to do":** #165's literal guard and the in-progress `D*` criterion are both new mechanisms, which violates "no new mechanisms until there is C1 and C4 data". The justification is that each corresponds to a failure that was already verified by hand: two express false positives, and a dropped Kite requirement row. The principle still stands. Any mechanism added later must first have a verified failure as evidence.

### 9.2 Empirical results

| Run | Result | Human check |
|---|---|---|
| express scan, before #165 | Only 2 of 6 units were seen, yet it showed "6 of 6"; the other 4 were recorded as `covered`; both missing_test findings were false positives | Both false positives have corresponding tests (`test/res.status.js:119-201`, `test/res.cookie.js:274`) |
| express scan, after #165 | Both false positives disappeared; 1 new weak-test false positive appeared (`res.sendFile.js:170`, whose real check is `cb(error)`) | False positive |
| express scan, after #166, run 2 times | All 6 units fully entered the context; both runs reported `test/req.fresh.js:102`, where `toUTCString` is missing `()`, so the If-Modified-Since path is actually not tested | **Real, a bug in the express test.** In addition, both runs showed 1 likely-valid weak test (`app.listen.js:41`) and 1 false positive (`utils.js:130`) |
| express real gap: `req.fresh` returns false for non-GET methods | Reported in only 1 of 4 runs, and with low confidence (hidden in Details) | Miss |
| Kite PR #6 (developer is Sonnet, implementing `design.md` §4.1) | 17 seconds, $0.0075, uses the job token, no PAT needed; two unit tests verified as valid; the `overlayDone` wiring is untested, marked "needs human judgment" | Valid. But the requirement row was dropped (see C10) |
| Kite scan (131 requirement blocks plus 12 units) | Only 2 of 80 blocks were answered, and the whole run was voided by validation; output was 553 tokens; the requirements document did not enter the context | Failed (see C12) |
| Seeded-defect recall evaluation (#162, SpecGuard repository) | Precision 100%, recall 86% (by scoring) or 91% (also counting what is visible in the summary) | Seeded cases; does not represent real repositories |

### 9.3 Status of C1–C8

| Problem | Status | Change |
|---|---|---|
| C1 No real-use data | Unresolved | Kite's PR mode writes back to the PR, so fix-through can start accumulating, but the developer is an agent, so it does not count as real data. The ledger is not done |
| C2 Engine and compliance | Partial | The user confirmed Kite is a personal repository and Anthropic may be used. Q8 for company repositories is still unanswered; the Copilot path has still not run for real; the temporary `SPEC` and `haiku-5.5` in `ci.yml` are still there |
| C3 Cost of reduced review | Unresolved | No comparison data |
| C4 recall | Partial | Seeded-case recall is 86–91%. On a real repository: the real express gap was reported in 1 of 4 runs. Nothing has been tested by seeding gaps in a real repository |
| C5 Test layering | Unresolved | Every run outputs "nothing to move down"; not one positive case has been validated |
| C6 Requirements depend on the PR body | Partial | Kite's requirements are in repository documents, and `design.md` can be discovered. But when a PR implements an unchanged spec sentence, the requirement is lost (C10) |
| C7 Coverage of manual runs | Partial | Private personal repositories can use the repository's own workflow with the job token. Scan has been run for real with Claude: repositories with only code work, repositories with documents do not (C12) |
| C8 summary readability | Partial | #164 is merged. The PR summary still has no note saying "this is not coverage and not for evaluating individuals" |

### 9.4 New problems found in the afternoon

| ID | Problem | Impact | Status |
|---|---|---|---|
| C9 | Test matching misses the "one test file per method" convention (`test/res.status.js`); the assertion regex does not recognize supertest and similar styles, so 140 tests with assertions were counted as "no assertions" | scan false positives | Fixed in #165 and #166. Names shorter than 4 characters (`req.ip`, `req.get`) still cannot be matched |
| C10 | **Scenario A provenance is broken**: a PR implements an unchanged spec sentence. Deterministic tracing already found `design.md:93` (score 15.55), but when the model output the requirement row it left out the quote, the whole row was discarded by validation, the first screen showed "Requirements: none found", and the "rounded vs floor" inconsistency was buried | The product's core value (validation) is broken | In progress: the `D*` criterion collects the requirement blocks with high tracing scores, and the system fills in the quote deterministically |
| C11 | Packing is depth-first: the 1st unit eats the whole budget, the other units do not enter the context, yet are counted as reviewed and recorded as `covered` | False "clean" | Fixed in #166, verified as 6/6 on express |
| C12 | **The document part of the full-repository audit does not work on Claude**: one call has to answer 80 blocks plus 12 units, and the requirements documents are packed last and starved; more than 20% of blocks went unanswered and the whole run was voided | Automatic provenance is completely unusable | In progress: scan is split into multiple calls, requirement blocks are batched by budget, results are merged deterministically, and one failed batch affects only that batch |
| C13 | A single source file larger than the per-file limit (about 41 KB) can never enter the context and can only be honestly marked as unreviewed | In large repositories the riskiest file is often also the largest | Unresolved. Direction: refine the review unit from file to function |
| C14 | A stable false positive repeats on every run (`utils.js:130` was reported both times), and two-run confirmation cannot block it | After a scan issue is opened, the false positive will be confirmed | Unresolved. Decide whether to handle it after C4 has data |
| C15 | scan mode does not check the coding standard | Item 1 of the original requirement is covered only in PR mode | Undecided: whether scan needs to handle this |

### 9.5 Still-unresolved problems, ordered by impact on the goal

1. **Automatic provenance (C10, C12).** Only the requirement side can distinguish "the tests agree with the code" from "the behavior is correct" (`goal-first-principles.md` conclusions 2, 3). Now both modes break here: scenario A in PR mode and the document part of the full-repository audit. The cause is the same: the system had already found the requirement deterministically, but handed the job of carrying the requirement text to the model, and gave it too much at once. Both fixes are in progress.
2. **Effect in real use (C1, i.e. E6).** There is still not a single record of a real developer seeing a finding and going to fix it. Kite's PR mode can already write back to the PR, but the developer is an agent.
3. **recall on real repositories (C4).** Seeded cases are at 86–91%, but the real express gap was reported in only 1 of 4 runs. Nothing has been quantified by seeding gaps in a real repository.
4. **Test push-down (C5, G3).** Item 2 of the original requirement has never been validated.
5. **Company path (C2).** Which engine company repositories use and whether Q8 allows sending code to a model provider are both undecided. The current quality of the Copilot path is unknown.
6. **Large files (C13) and stable false positives (C14).** They will get worse as repositories grow.
7. **Coding standard missing in scan (C15)**, and the missing disclaimer in the PR summary (C8).

### 9.6 Updated next steps

| Priority | Action | Exit condition |
|---|---|---|
| P0 (in progress) | Add the `D*` criterion to PR mode (C10) | After rerunning Kite PR #6, §4.1 appears on the first screen, and "rounded vs floor" is handed to a human to judge |
| P0 (in progress) | Split scan into multiple calls (C12) | Kite's 131 blocks are reviewed in batches and the run is no longer voided as a whole. The 3 requirement-vs-code inconsistencies found with Copilot on 10-13 can be reproduced |
| P1 | Seed 10 known gaps on Kite, covering both the unit-test side and the requirement side (C4) | recall and precision are written into `docs/validation-plan.md` |
| P1 | Function-level review unit (C13) | A unit larger than 41 KB can be reviewed |
| P1 | User decides the company engine and Q8 (C2) | Temporary configuration in `ci.yml` is removed |
| P2 | Find one positive case for test push-down (C5); whether scan handles coding standard (C15); add a disclaimer to the PR summary (C8); manual-run ledger (C1) | Each has one real-run result or one decision |

## 10. Evening update: automatic provenance works, two external reviews, safety backstops

Baseline: main (#168–#177 merged). Engine: Claude Haiku 5.5. Acceptance repository: Mira190/Kite (a personal private repository; SpecGuard runs in Kite's own workflow, using the job token, no PAT needed).

### 10.1 Merged changes

| PR | Content | Problem addressed |
|---|---|---|
| #168, #171, #172, #176 | `D*` criterion: requirement blocks with high deterministic-tracing scores are collected by SpecGuard, and the quote is filled in by the system; `D*` is associated through tracing to obligations inside the hunk; when consistency is inconclusive, the first screen prompts "Check that the change does what this requirement says", with the reason given by the model attached | C10 |
| #169, #173, #177 | scan is split into multiple calls: requirement blocks go in batches of 20, and results are merged deterministically; a batch whose output was truncated is split in half and retried; for blocks left unanswered, the answered part is kept and unanswered ones are re-queued once; total cost is bounded by the hard cap `max_budget_usd` | C12 |
| #170 | When batching, packing opens windows around cited lines; numbers in a requirement block serve as evidence literals, and code windows hitting two numbers at once get priority as candidates | C12, C9 |
| #174 | A private target with a public control repository fails immediately, and failing to look up visibility also fails (SG-01); the full original text of the requirement block goes to the model, replacing the earlier 240-character truncation (SG-03) | Security, C12 |
| #175 | Suggestions by test layer; conflict semantics; gap findings without a skeleton are not counted; status is incomplete when incomplete (SG-02); removed "confirm on the spot when no test matched" (SG-04); skeletons labeled "Sketch, not run"; "Confirmed" changed to "Reported in two runs"; Details shortened | External review |
| #177 | An ambiguous requirement is judged needs_human or unknown, not contradicted or mismatch | External review |

### 10.2 Kite acceptance

| Exit condition | Result |
|---|---|
| PR mode scenario A: a PR implements an unchanged spec sentence (`design.md:93` "rounded to even numbers") | ✅ The first screen shows "Check that the change does what this requirement says: R: rounded to even (direction unspecified); C: floor via evenFloor". It triggers reliably no matter how the model associates obligations (#176) |
| The full-repository audit is no longer voided as a whole | ✅ Batched calls; truncated batches are split and retried; the status honestly states the number of unreviewed blocks |
| The known requirement-vs-code inconsistencies of 10-13 can be reproduced | ✅ Window size (spec 1000×740, code `height: 800`) was judged contradicted 3 times in a row; "first row selected by default" was reported once the full original text entered the model. The 3rd one (completion notification lacks an action button) has not yet come up in rotation |
| Evidence search can deterministically find `app.cjs:127` | ✅ It ranks first in the evidence (#173) |
| scan and PR modes judge the same inconsistency consistently | ✅ The full-repository audit judged `design.md:93` as contradicted (citing master's `evenFloor`), and PR mode handed the same issue to a human to judge |
| False positives pointed out by external reviews | ✅ The "extra size sorting" conflict disappeared; findings without a skeleton such as `cursorBoxes` go into Details and are not counted |

**Human check of unit-test gaps** (run 38515926303, 7 counted): 3 valid (the region restriction in `Overlay.tsx`, stream cleanup in `capture.cjs`, the label in `Kbd.tsx`), 2 partly valid or wrong layer (`Bar.tsx` belongs to the component layer; the core path-traversal protection of `ownFile` already has unit tests), 2 false positives (`has()` is an adjacent pair check, not a weak assertion; the expected value of `textBox` is a constant expression). The missing-test category is fairly reliable; **the weak-test category is 0/2 on Kite**.

### 10.3 Handling of the two external reviews

The factual statements in `docs/review.md` (reviewing Kite audit run 38510141042) and `docs/SpecGuard_critical_shift_left_audit_2026-10-14.md` (a code review at a pinned SHA) were mostly checked and found valid; what was adopted is in 10.1. The following were not accepted wholesale:

| Claim or suggestion | Handling | Reason |
|---|---|---|
| "Kite has only manual and weekly triggers"; suggests adding incremental PR review | Not adopted | Factually wrong: Kite has a PR workflow, and PR #6 is an example |
| Execute the generated test skeletons in CI | Not adopted as is | Executing model-generated code in the target repository's CI has security risk and also goes against the static-review positioning. Instead, skeletons are labeled "Sketch, not run", and findings without a skeleton are not counted |
| Requirement Completeness Review | Pending user decision | This is the open question Q4, which is product scope |
| SG-08 random sampling, SG-09 requirement authority, SG-11 standards source, SG-13 dynamic evidence | Deferred | They depend, respectively, on recall data, a product decision, the conclusion of C15, and the static-review positioning |

### 10.4 Safety backstops (premise: SpecGuard stays a public repository)

Principle: a public control repository may carry only public data, and the results for a private repository may stay only within that private repository's own scope (the Kite pattern).

| Backstop | Status |
|---|---|
| G1 Private target with a public control repository: fail immediately, and also fail if visibility cannot be looked up | ✅ #174. Real run: scanning Kite from SpecGuard failed at the guard step, the review job was skipped, there was no artifact, and the log contained only the repository name; scanning express passed normally |
| G2 The `specguard` environment allows deployment only from protected branches | ✅ Set up |
| G3 main branch protection: `test` must pass, administrators are also bound, force-push is forbidden | ✅ Set up |
| G4 A dedicated Anthropic key with a monthly spending cap | ⏳ Needs the user to act in the Anthropic console |
| G5 Prompt injection (Copilot's `view` may read files outside the workspace) | Residual risk: credentials of known formats in the output are replaced with `[REDACTED]`; the improvement direction is to restrict `view` to the workspace |

### 10.5 Still-unresolved problems, ordered by impact on the goal

1. **Usage data from real developers (C1, i.e. E6)**: still zero. The developer on Kite is an agent.
2. **recall and precision on real repositories (C4)**: seeded-case recall is 86–91%; on Kite the missing-test category is 3–5/7 valid and weak tests 0/2; the express `req.fresh` gap was reported in only 1 of 4 runs. Gaps need to be seeded on Kite, covering both the unit-test side and the requirement side, to get quantified numbers.
3. **Test layers (C5)**: it can now suggest component or integration tests according to `higher_level`, but "what should be pushed down" still has no validated positive case.
4. **Large files (C13)**: `electron/app.cjs` failed to enter the context for several rounds in a row and was honestly marked as unreviewed. The direction is a function-level review unit.
5. **Stale state (SG-06)**: the confirmation state is not bound to hashes of the code and tests.
6. **summary size**: one output was 63 KB, smaller than 77 KB, but still large when there are many findings.
7. **Company path (C2)**: the engine for company repositories and Q8 are undecided; the temporary `SPEC` configuration in `ci.yml` is still there.

### 10.6 Next steps

| Priority | Action | Exit condition |
|---|---|---|
| P0 | Seed 10 known gaps on Kite (5 each on the unit-test side and the requirement side), and run PR mode and the full-repository audit once each | recall and precision are written into `docs/validation-plan.md`, with the weak-test category counted separately |
| P1 | Function-level review unit (C13) | `electron/app.cjs` can be reviewed in slices |
| P1 | Bind state to code and test hashes (SG-06) | After a dependency changes, the old conclusion shows as stale and is re-queued |
| P2 | Positive case for test push-down (C5); whether scan checks coding standard (C15); G4 | Each has one real run or one decision |
