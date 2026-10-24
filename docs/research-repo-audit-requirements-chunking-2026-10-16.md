# Research on Whole-Repo Unit-Test Audit, Requirement Identification, and Chunking for Large Repositories

What this repo does: SpecGuard statically reads requirements, source code, and tests to flag actionable unit-test gaps before QA. A whole-repo scan has to answer "which behaviors still lack credible evidence", while a PR review has to answer "what gaps did this change add or expose". This round reviewed monorepos, multiple requirement documents, shared test helpers, larger source files, and limited model context; it delivers only research and counterexamples and does not modify runtime code.

Date: 2026-10-16, Australia/Sydney. Code baseline: `origin/main` **`ee1c15812bae4315f39ce7d5bf1bf7511ac58553`**; the working branch sits after the earlier documentation commit `c2f056f`, and its runtime code is identical to that main. The baseline was confirmed by re-fetching; the latest head of #198 is still `c77841d`, and the results cited here for it come from the [previous round's fixed-version re-verification](full-repo-shift-left-audit-2026-10-16.md), without claiming that all of #198's tests were re-run.

## 1. Conclusion First

**Large repositories need a resumable task partition, but should not simply be cut by a fixed number of lines with the model then drawing conclusions on each piece separately.** A minimal review task must carry the behavior, the applicable requirement, the implementation and its dependencies, and the relevant assertions and test preconditions together. When one of these is missing, an unknown with a traceable reason should be left behind; reading every file, a successful JSON return, or a sufficient number of runs cannot substitute for that.

This round yielded **7 new confirmed findings, F30–F36**; F35 is empirical evidence that a declared scale limit restricts the full-repo goal, and F36 is a counterexample to a declared mapping heuristic in monorepos. Real collector output was also used to reinforce the earlier F28, and to correct the original report's description of the source of the YAML sample. None of the 8 probes calls a model or accesses the real GitHub API.

The unknown unknowns most worth handling first are not inside the model's reasoning, but in three steps that are easily mistaken for done:

- A document being discovered does not mean all the real requirements in it enter the candidate set.
- Finding a test file does not mean it belongs to this package, actually constrains this behavior, or that its helpers are still valid.
- Every chunk being completed does not mean the cross-chunk preconditions, contracts, and current version have been reviewed together.

## 2. What the External Research Supports, and What It Does Not

Only papers or official project documentation are used below. The older papers are used to form hypotheses to be tested, **not to infer the specific window, accuracy, or optimal chunk size of any 2026 model**.

| Primary source | Judgement it can support | Inference for SpecGuard and its limits |
|---|---|---|
| [Lost in the Middle, TACL 2024](https://aclanthology.org/2024.tacl-1.9/) | In the QA/retrieval tasks measured, the position of the evidence affects how well the model uses a long context | "It fits" must not be treated as "understood completely"; evidence-position permutation experiments are needed. The paper is not a code-review quality experiment |
| [RULER, COLM 2024](https://arxiv.org/abs/2404.06654) | Single-needle retrieval is not enough to evaluate long-context abilities such as multi-hop association and aggregation | Review evaluation should test multi-hop evidence "requirement→implementation→test", not just whether one line can be found; its model samples cannot directly represent current production models |
| [RepoCoder, EMNLP 2023](https://aclanthology.org/2023.emnlp-main.151/) | When repository information is scattered across files, iterative retrieval helps its code-completion task | Supports the direction of expanding related context after retrieval; completion gains cannot be converted into a drop in SpecGuard's miss rate |
| [Anthropic: Effective context engineering, 2025](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) | Curated context, on-demand retrieval, compression, and persistent notes have different costs and distortion risks | First use the existing search and lightweight task state; there is no need to introduce a vector store or multiple agents immediately; a pure API pack has no tools and cannot copy an agent's ability to read more |
| [Cucumber Gherkin Reference](https://cucumber.io/docs/gherkin/reference/) | A Scenario uses the preconditions of Background; Rule, Examples, and language declarations have structural semantics | Chunking must keep inherited context and example parameters; the local text of a scenario cannot be treated as the complete contract |
| [Stryker: mutant states and metrics](https://stryker-mutator.io/docs/mutation-testing-elements/mutant-states-and-metrics/); [PIT: basic concepts](https://pitest.org/quickstart/basic_concepts/) | Execution coverage differs from being able to kill a mutant; equivalent mutants and run errors cannot simply be counted as missing tests | In controlled replay, use behavior mutations to test assertion strength, and distinguish survived, no coverage, invalid, and equivalent; do not require the whole repo to pursue a 100% mutation score across the board |
| [Bazel query guide](https://bazel.build/query/guide#reverse-dependencies) | An existing build graph can be queried for reverse dependencies | If an adopter already has a reliable graph, reuse it to expand affected tests/callers; this does not require every project to migrate to Bazel |
| [OpenAPI 3.1.1 specification](https://spec.openapis.org/oas/v3.1.1.html) | An HTTP API contract can be expressed by a machine-readable interface description | The requirement source should not be equated with MUST in Markdown. This round cites a fixed specification version to illustrate the input form, and does not claim it is the latest version |

## 3. What the Current System Actually Does

`trace.discover → parseItems/blocksOf → audit-collect.select/evidence → audit-units.inventory → prompt/contextPack/scan-parts → validate/verify → state/publish` is the chain traced in this round. The source code, the test mapping, and the scheduling were checked together; not just the prompt.

| Stage | Current implementation and limits | Meaning for whole-repo review |
|---|---|---|
| Document discovery | `trace.js` supports MD/MDX/RST/ADOC/TXT/feature; automatic discovery combines location, name, and normative content, and an explicit path can force admission; 2000 candidates, 500 admitted, 256 KiB per ordinary file, 48 MiB parse-byte budget | "No requirement found" is not "the repo has no requirements"; unsupported format, budget-unread, and filtered-as-data should be accounted for separately |
| scan document set | `audit-collect.js:16,228` at most 60 documents, then rotates through their block set; by default at most 80 blocks per round | Document admission and block rotation are two layers; the latter cannot automatically recover documents the former did not admit |
| Requirement body | candidate text 240 characters, retrieval text at most 600 characters, block body at most 4000 characters | A summary cannot carry the identity of the complete contract; negations, exceptions, units, and table headers may be in the truncated part |
| code-first inventory | `audit-units.js:13,89–90`: source ≤512 KiB, at least 3 non-comment lines; reads at most 6000 source files sorted by path | Once the largest files are filtered out, the later slicing mechanism never sees them; the 6000 limit is not "automatically continue reading in the next round" |
| Test discovery/mapping | Reads at most 4000 test files, 512 KiB per file, about 48 MiB in total; at most 20 candidates per unit; name, call-word, and path heuristics | Candidates ranked from the input are not an execution coverage set; unread tests already have a limitation, but it cannot be equated to inferring they have no assertions |
| Current slicing | In main, large units derive a fixed line window from about 40 KiB; a multi-call plan arises only when the number of blocks exceeds the batch | The code-first units of `scan-parts.js:15,47` are still concentrated in one unit call; 0 document blocks will not automatically be split into multiple calls just because there is a lot of source |
| Model semantic boundary | API mode has only the pack; agent mode can use read-only file tools | "Please keep reading files" cannot remedy missing evidence in an API pack; both modes must share the completeness semantics, not share one line of read-more prompt |

This is a list of limits, and not every limit is treated as a bug. Below, only findings with concrete counterexamples that can affect this goal are listed.

## 4. Must fix: New Counterexamples

### 1. [P1] F30: A short but complete requirement disappears before entering the candidates

- **What this is:** `src/trace.js:297,359–364` filters blocks with `MIN_BLOCK=20`, ahead of the later rule interpretation.
- **Problem:** `AC-1: Reject zero.` and `必须拒绝负数。` (Chinese for "Must reject negative numbers.") are both recognized by parseItems as 1 item, yet both become `admitted=0, ruled=0`. It is not that the model decided they do not constitute requirements; they never had a chance to enter the review, nor did they enter the ruled list.
- **Fix:** IDs, acceptance items, and explicit constraints should not be subject to a crude length rejection; for descriptive short fragments, keep the context and then classify. Any rejection must leave a reason, distinguishing "there is no requirement" from "the requirement was filtered out".
- **If we skip it:** Concise ACs and non-English requirements will be systematically missed; asking authors to write longer sentences does not improve requirement quality.

Evidence: Q1. This only proves the Chinese and English examples above; it does not claim to cover the requirement grammar of all languages.

### 2. [P1] F31: A real threshold table is excluded by the numeric-share rule

- **What this is:** `src/trace.js:323,349–355` decides a data table by numeric-cell share; when the row itself has no English must/shall/should/will, the header's contract semantics do not prevent the exclusion.
- **Problem:** The two rows `Starter subscription | 10 | 20` and `Enterprise subscription | 100 | 200` under `Subscription | Maximum requests per minute | Burst limit` are both marked `results/data table row`, giving 0 candidates. This is an API rate-limit contract, not a measurement result.
- **Fix:** Classify the row together with the header, units, and parent heading; the pure numeric share serves only as a ranking clue. A suspected constraint table in an explicit requirements_paths should be preferentially retained for judgement, and must not be directly treated as already-excluded no-requirement data.
- **If we skip it:** The numeric constraints best suited to generating boundary unit tests are exactly what disappears, and no later retrieval or model, however good, can remedy it.

Evidence: Q2. The exclusion reason is visible, so it differs from F30's no-ruled-record case; but a visible wrong exclusion still harms the goal.

### 3. [P1] F32: Gherkin chunking loses inherited preconditions, and changing them does not change scenario identity

- **What this is:** `src/trace.js:239–259` outputs the scenario's original text on its own; `audit-collect` computes the cid from the local block, and `scan-parts` carries only the body of the blocks in this batch.
- **Problem:** 21 scenarios share a Background, with default batch=20. Changing the tenant precondition from `SUSPENDED_TENANT` to `ACTIVE_TENANT` leaves the cid of the last scenario unchanged; neither the prompt nor the pack of the part containing that scenario has this precondition, `blockCuts={}`.
- **Fix:** Attach the applicable Feature/Rule/Background, inherited tags, and Examples bindings to the scenario, and have the content version include these dependencies. Do not merely enlarge a fixed overlap window to guess the position of ancestors.
- **If we skip it:** The same "reject payment" result has entirely different meanings under different tenant states; the local block looks unchanged while the actual contract has changed. This proves missing context/unchanged identity; it does not claim that a real model run necessarily misjudges.

Evidence: Q3, real collect and scan-parts. The role of Background for a scenario is based on the [official Cucumber rules](https://cucumber.io/docs/gherkin/reference/#background); listing the Background as a candidate of its own does not establish the dependency.

### 4. [P1] F33: A weakened test helper does not make the historical evidence of the affected unit stale

- **What this is:** The version at `src/audit-units.js:131` includes only the blobs of the source and the matched test files, not the dependencies of those tests.
- **Problem:** `amount.test.js` calls verifyExact from `helpers/check.js`; the helper changes from `assert.equal(actual, expected)` to `assert.ok(actual)`. The amount test file is unchanged, the unit ver is unchanged, the changed priority is 0, and the stale list is empty; the unit added in the same run is selected first, and the helper is not a code-first unit.
- **Fix:** At minimum, include the recognized test helpers, fixtures, setup, and related config in the evidence dependency hash; when dependencies cannot be resolved, conservatively invalidate by the affected package scope, and do not mark the version as still trustworthy. Prefer reusing the dependency information the project already has.
- **If we skip it:** The original exact assertion no longer constrains wrong values, but the historical covered may be retained for a long time. It is not claimed that it will never be reviewed again; the problem is the loss of the proper change priority and the staleness signal.

Evidence: Q4. There is no need to first build a generic all-language call graph; first cover the simple import/require/helper forms that this project actually uses, and state the remaining unknowns explicitly.

### 5. [P1] F34: Larger source files are silently excluded before slicing

- **What this is:** `src/audit-units.js:89` filters `e.size > 512 KiB` before constructing units, and `partOf` acts only on the remaining units.
- **Problem:** An ordinary 627,780-byte `src/large.js` produces `units=0, limitations=[]` in a controlled Git sample. Shrinking the chunk, adding more run rounds, or increasing max_units will not bring this file into slicing.
- **Fix:** At minimum record the path, size, and unreviewed status of over-limit sources; when full-repo coverage is truly needed, safely read/index them in segments and then divide tasks semantically. Generated files can be excluded by explicit rules; size must not stand in for "not product code".
- **If we skip it:** In a large repo the files that most need chunking are outside the review denominator, and "no unit to review" hides the actual unreviewed scope.

Evidence: Q5. The sample is a constructed valid source set that proves the limit behavior; it does not claim that actual adopters have already hit a production defect of the same size.

## 5. Should fix: Problems of Declared Boundaries Under the Target Load

### 6. [P2] F35: Block rotation cannot traverse the 61st requirement document

- **What this is:** `audit-collect.js:228` first takes a fixed first 60 documents, and only afterwards selects blocks based on prior state.
- **Problem:** With 61 explicitly matched requirement documents, both rounds admit the same 60, and the 61st stays in rejected. The code order allows a further inference: under a fixed tree/config, updating the state of admitted blocks cannot bring tail documents into the candidate universe.
- **Fix:** Give document admission a resumable page/rotation too, or explicitly partition the package scope and record the completion of each partition. The report should list the total eligible, admitted, excluded, and pending-scan counts together.
- **If we skip it:** Rotation completing only means the first 60 are done, and cannot represent the whole repo. There is already an explicit over-limit notice; this item is a scale gap for the full-repo goal, and is not packaged as a hidden anomaly or an unlimited-rounds measured result.

Evidence: Q6. The 6000 source limit also sits before risk ranking and is a similar admission boundary; this round did not build a 6001-file stress test and lists it as an acceptance condition for the next phase.

### 7. [P2] F36: Same-named tests from other packages fill the cap and crowd out more relevant candidates

- **What this is:** `src/test-map.js:64–83` first collects same-name tests, then handles tests that call multiple public symbols; scan caps each unit at 20.
- **Problem:** For `packages/z/src/ledger.js`, each of 20 other packages has a ledger.test.js; this package's account-behaviour.test.js calls two public methods. mapTests accepts the 20 external same-named files, and the latter is excluded by the cap.
- **Fix:** Rank by combining package/import/call association before the final truncation; same-name is a signal, not a hard priority stronger than all call evidence. If candidates must be trimmed, record "search incomplete" and keep the existence of the relevant test unknown.
- **If we skip it:** The common duplicate naming in monorepos wastes context and misses the real test. A model with tools may search further; an API pack has no such remedy path; the counterexample proves that candidates are lost, and does not directly prove any particular false positive from a model.

Evidence: Q7. The repository has already noted the limits of name search; what is new is the combined counterexample where a strong candidate is crowded out by weak candidates when the cap is actually reached.

## 6. Evidence Correction and Reinforcement for F28 in the Previous Report

The previous report's N4 manually wrote `audit-evidence.txt` and used a YAML sample to verify the difference between single-batch and multi-batch packing paths. **It does not prove that the collector found the YAML automatically**; NOT_EVIDENCE in `audit-collect.js` actually excludes YAML/JSON and similar files. Therefore the original statement "evidence search has explicitly found it" is inaccurate, and this round corrects it in the original report as well.

Q8 now starts from the real collector: the requirement demands that the validator reject negative numbers before charging; code-first max_units=1 selected another, higher-risk module. The collector did put `billing/validator.js` into the requirement evidence; but the default single-batch pack does not contain its body, `notWhole=[]`. So **the core problem of F28 still holds**, and no longer depends on an input that does not conform to the automatic retrieval rules.

This correction also shows that a test of some downstream function accepting a manual payload does not prove that the real upstream will produce that payload. Future unknown-unknown counterexamples should preferably pass through the real producer → consumer, and explicitly narrow the model/network boundary.

## 7. The Structure Requirement Identification Should Preserve

"Document found", "candidate found", "applicable contract confirmed", and "code/tests associated" need to be separate observable steps; they can continue to use existing files and functions, without first building a new platform.

| Layer | Minimum information | What it cannot be swapped for |
|---|---|---|
| Document inventory | commit/blob, path, format, scope, discovery method, unread/over-limit reason | A filename that looks like a spec does not make it an authoritative oracle |
| Atomic behavior | subject, trigger condition, expected result, negation, boundary/unit, exception, and the original text location | A keyword hit does not mean testable; a short sentence does not mean non-requirement |
| Inherited context | heading hierarchy, table headers and units, Background/Rule, Examples rows, reference dependencies | A single line quoted truthfully does not mean the complete semantics are truthful |
| Applicability | package/product version, draft/accepted/superseded, contract source and conflicts | The most recently modified document does not automatically override an earlier but still valid contract |
| Identity and version | traceable identity + content version that preserves semantics + dependency version | A hash after lower-casing/stripping punctuation is not suitable for representing a contract version (F25 of the previous round) |
| Association and conclusion | code, tests, rule evidence, and unresolved dependencies; each obligation has a reviewed/unknown reason | Not finding it in search cannot be inferred as nonexistence; covering one positive example cannot cover another opposite requirement |

Automatic discovery keeps three kinds of clues: path/name/content; `requirements_paths` is for supplementing and limiting scope, and should not be misread as "every sentence in the file is correct and current". For draft, deprecated ADR, and mutually contradictory documents, keep the source and require an explicit authoritative rule; when there is no rule, mark conflict/unknown, and do not let the model quietly pick a version.

Structured contracts should be evaluated independently: OpenAPI, JSON Schema, protobuf, GraphQL, database constraints, and config defaults can all express behavior. This round confirmed that default discovery leans toward text, and generic semantic recognition of these formats is not implemented; it was also not proven that "explicitly passing them in absolutely cannot get them admitted". It is recommended to first use samples from real adopters to count their share, then pick the one or two most common formats for adaptation, keeping `$ref`/references and versions. Do not lose constraints by converting a whole YAML into a natural-language summary.

Without an independent requirement source, boundaries, exception paths, and assertion strength can still be reviewed, but "code and tests agree" cannot be upgraded to "conforms to business intent". Requirement conflicts, not found, parsing unsupported, budget-unread, and explicitly not applicable should be displayed separately.

## 8. What a Whole-Repo Unit-Test Audit Should Review

The review object should be **observable behavior**; it is not required that every private function have its own test. The candidate evidence of a unit must at least answer:

1. What normal inputs, boundaries, invalid inputs, error propagation, and state changes are worth testing? Only dimensions related to the behavior enter this task, avoiding mechanical enumeration.
2. Which implementation does the test actually call? Same-named files, string hits, and line coverage are only candidate signals; check imports, indirect calls, and package boundaries.
3. Would the assertion fail for a reasonable wrong implementation? Also check the role of helpers, fixtures, setup, parameterized cases, skip/only, async waiting, and mocks; these are not all bugs already found, but a matrix to be verified.
4. Does the expected value come from the requirement / an independent constant, or was it computed by calling the implementation again? Even if a test can kill some mutations, it is still necessary to judge whether the oracle is correct.
5. Can pure logic covered by higher-level tests be pushed down? Contracts involving real transactions, protocols, serialization, and framework wiring may still need integration tests, and must not be deleted to raise the unit count.

Static conclusions, execution coverage, and mutation results are different layers of evidence. It is recommended to choose a few high-risk behaviors in a trusted, isolated existing CI/replay environment for targeted mutation, to verify whether concrete errors such as `>= → >`, a changed return value, or a swallowed exception are blocked. Equivalent mutants and environment errors should be recorded separately, per [PIT's statement of limitations](https://pitest.org/quickstart/basic_concepts/); this round did not install mutation tools or execute model-generated tests of the reviewed repositories.

Version invalidation must at least consider: the reviewed source, related tests, the helpers/fixtures/setup read, the applicable requirement and its parent context, rules and related config, and the analyzer version. One cannot cache only "this SHA once had a covered". When the dependency graph is incomplete, state the conservative scope explicitly and avoid claiming precise incrementality.

## 9. When and How Large Repositories Should Actually Be Chunked

### 9.1 First Distinguish Four Different Operations

| Operation | Purpose | What still cannot be concluded after it completes |
|---|---|---|
| Inventory paging | Enumerate the whole set of eligible objects, so that a fixed prefix does not hog the slots forever | Having been enumerated does not mean having been reviewed |
| Retrieval window | Locate candidate evidence in files, reducing irrelevant content | A search window is not the complete behavior |
| Review-task chunking | Provide enough behavior and evidence within budget to obtain a local conclusion | A local conclusion is not cross-boundary consistency |
| Cross-round scheduling | Advance the remaining scope over multiple runs, and respond to version changes | Multiple runs do not mean everything is complete for the current version |

The current implementation mainly has parts of the latter two. The previous round's F22/F23/F27/F28, plus this round's F32/F34/F35, show that merely adjusting `partBytes` cannot solve them.

### 9.2 Selection Rules

| Situation | Recommendation |
|---|---|
| A behavior and its necessary evidence fit completely in the budget | Keep one task; do not force a split for the sake of uniform size |
| A single file is large but function/behavior boundaries are clear | Divide by function/related behavior; shared imports, types, preconditions, and call interfaces serve as supporting context |
| The same behavior spans multiple files | Prefer carrying the related callers/callees, contract, and tests in the same task; the number of files is not the basis for splitting |
| A single behavior still exceeds the budget on its own | First build a structure and dependency inventory, then analyze in stages; keep unresolved dependencies; add a cross-stage check, and do not automatically get covered from "no findings" in each piece |
| A multi-package large repo | First queue by package/owner/domain scope, then pick behavior tasks; a shared-library change triggers a consumer check; a directory cannot be treated as an absolute semantic boundary |
| Code-first scan without requirement documents | Likewise split unit calls by the total volume of source + test evidence; whether to split cannot be decided by the number of document blocks |

The budget should be computed on the **entire actual request**: the input space the model allows minus system, schema, output reservation, and a safety margin, then bounded by this run's cost/time limits. 250,000 bytes is not a fixed number of tokens; different languages, characters, and body structures differ, so one cannot call a request safe merely by adding up file bytes. The specific target token size is decided by the comparison experiment below, without giving an unmeasured "best 2K/8K/32K".

### 9.3 Minimum Implementation Order

1. **First fix truthfulness.** Keep the list of filtered/trimmed/unanswered objects; bind old cursors to content and layout, and reject stale evidence. Do first what can be done with the existing state format.
2. **Give the admission layer resumability.** Page the document and source sets in a deterministic order, and record eligible/visited/excluded/remaining; priority may change the order but must not permanently change the universe. Record whether the partition is exhaustive.
3. **Fill in the supporting context of the current task.** First add the requirement parent structure, the helpers of matched tests, and this package's associations; the existing lexical/path index and simple dependency extraction are enough to start. Repos with an existing build graph then hook up its reverse dependencies.
4. **Make blocks and units share the budget rules.** When a task exceeds the limit, split out independent behaviors; each subtask explicitly returns assessed, unresolved, evidence ranges, and version. The single-task and multi-task paths follow the same evidence completeness.
5. **The final merge does only evidence-backed things.** Deduplicate by obligation identity, and keep conflicts, failures, incompletes, and cross-block dependencies; the read-only supporting context shared by chunks is not double-counted in the "reviewed business scope". When a cross-boundary re-review is needed, create an explicit task, and do not let the reducer guess a conclusion from summaries.

It is not recommended to add right now: an all-language AST service, a vector database, a permanent graph database, multi-agent orchestration, or an arbitrary percentage of fixed overlap. They may be valuable, but should be justified by actual failure samples and gains. Evaluate embedding/reranker when lexical retrieval is insufficient; introduce a mature parser for the main languages when pure function-boundary extraction is insufficient. The latter is incremental by evidence, not dependency forever at zero.

A minimal task record can continue to be saved as a JSON file: `snapshot, scope, primary obligation/range, supporting refs+hashes, analyzer/layout version, unresolved dependencies, result state`. Failures and budget exhaustion remain pending review; the final judgement must target the full set of obligations of the same version. Validate first with simple, recoverable single-process scheduling, and do not let concurrency complexity stand in for correctness.

## 10. Use Experiments to Decide Whether to Upgrade Chunking

On the same fixed corpus, same model/parameters, and total budget, compare: A the current pack, B package + behavior chunking, C B + dependency read-more. First check structural invariants offline, then compare effects in a separately authorized real-model evaluation; this round did not execute B/C product implementations or paid-model evaluations.

| Dimension | Counterexamples/controls that must be included | Core metrics |
|---|---|---|
| Requirement discovery | This round's short Chinese and English ACs and numeric tables; additionally deprecated ADRs, mutually contradictory contracts, structured formats, negations, and units | Document discovery recall and block recall separately; false-exclusion rate; one cannot use only the selected candidates as the denominator |
| Test quality | helper weakening, parameterization, mock returning fixed values, code and expectation wrong together, a valid helper assertion as control | Behavior-gap precision/recall; false-positive fix time; same-name test false-association rate |
| Boundary and scale | 60/61 documents, 6000/6001 source files, both sides of 512 KiB; 20/21 blocks; function across slices, no documents, multiple packages | Inventory exhaustiveness, version consistency, newly reviewed scope per round, tail waiting time |
| Context completeness | Change Background; move evidence to the beginning/middle/end; lower the budget; split the same behavior across two files | Unread evidence must be unknown; changing evidence position/layout should not raise complete out of thin air |
| Lifecycle | helper or requirement change, analyzer upgrade, slicing layout change, run interruption/retry | Whether stale state is re-queued; whether anything is double-counted; whether unfinished work is mistakenly recorded as covered |
| True shift-left | Replay real QA defects using the evidence available at the time of the introducing PR, with normal PRs as a noise control | Actionable hits before QA, actual adoption/confirmed fix, latency, token/cost; kept separate from offline proxy metrics |

Merge thresholds use deterministic invariants first: eligible objects must have a destination, short requirements must not vanish without a record, scenario inherited conditions must be visible, a helper change must invalidate the dependent evidence, trimming must not raise confidence, and repeated display must not add TP. Numeric thresholds for model precision should come from the adopter's noise cost and the baseline; this document does not invent percentages that have been achieved.

## 11. Verification Record and Reproducible Material

Verification environment: Windows / Node v26.11.1; shell-related tests put Git Bash at the front of PATH. The related tests were run on the runtime code of the main above, with these commands:

```powershell
$env:PATH = 'C:\Program Files\Git\bin;C:\Program Files\Git\usr\bin;' + $env:PATH
node --test --test-reporter=tap --test-concurrency=2 src/trace.test.js src/audit-collect.test.js src/audit-units.test.js src/test-map.test.js src/claude-api.test.js
```

This combined run, after 1504546.7662 ms (about 25 minutes), actively stopped the trace subprocess that had still not finished. The **107 tests passed** in the other four files; the runner's raw summary was **108 tests / 107 pass / 1 fail / 0 cancelled / 0 skipped / 0 todo**, of which the only fail was the file-level `ERR_TEST_FAILURE` of the stopped `src/trace.test.js`. This is not a located product assertion failure, and the unfinished trace regression cannot be recorded as passing.

Subsequently, the cases in trace directly related to requirement parsing were verified separately:

```powershell
node --test --test-reporter=tap --test-name-pattern='^(parseItems|blocksOf|isRequirementDoc|isSpecDoc)' src/trace.test.js
```

Result: **22 tests / 22 pass / 0 fail / 0 cancelled / 0 skipped / 0 todo**, 5321.8197 ms. In addition, all 8 independent gap probes reproduced. The existing cases passing does not contradict these gaps: they did not block the behaviors shown in the appendix.

The verification scope is four complete test files + 22 designated parsing cases of trace + 8 counterexamples; **this round did not complete the Git/CLI regression of the full trace, nor re-run all tests of the whole repo**, and did not treat the previous round's full-suite test counts as this round's results. No product code was modified, no dependencies installed, no real model called, and no real GitHub comment written; it was not verified that the product findings have been fixed.

The appendix script is saved at the baseline root above and executed with `node audit-research.cjs`; it creates a temporary Git fixture with boundary checks and cleans it up. A successful assert on the wrong behavior only means the reproduction succeeded, not that the product has been fixed. Q7 directly isolates the mapper input; the other probes that need Git use the real related producer/consumer. They do not represent the distribution of all real repositories, and are not performance benchmarks.

<details>
<summary>Full reproduction script (Node.js + Git, no new dependencies)</summary>

```javascript
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { execFileSync } = require('node:child_process');
const assert = require('node:assert/strict');
const T = require('./src/trace'), A = require('./src/audit-collect'), U = require('./src/audit-units');
const P = require('./src/engines/claude-api'), S = require('./src/scan-parts'), M = require('./src/test-map');
const results = [];
const write = (d, p, s) => { const f = path.join(d, p); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s); };
const git = (d, ...a) => execFileSync('git', ['-c', 'core.autocrlf=false', ...a], { cwd: d, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = d => { git(d, 'add', '.'); git(d, '-c', 'user.name=Audit', '-c', 'user.email=audit@example.invalid', 'commit', '-qm', 'fixture'); return git(d, 'rev-parse', 'HEAD'); };
function fixture(files, fn) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-research-'));
  try { git(d, 'init', '-q'); for (const [p, s] of Object.entries(files)) write(d, p, s); commit(d); return fn(d); }
  finally { const real = fs.realpathSync(d), temp = fs.realpathSync(os.tmpdir()) + path.sep; assert(real.startsWith(temp) && path.basename(real).startsWith('sg-research-')); fs.rmSync(real, { recursive: true, force: true }); }
}
function check(id, fn) { try { results.push({ id, reproduced: true, ...fn() }); } catch (e) { results.push({ id, reproduced: false, error: e.stack }); process.exitCode = 1; } }
check('Q1-short-explicit-requirements', () => {
  const examples = ['# Rules\n\nAC-1: Reject zero.\n', '# 规则\n\n必须拒绝负数。\n'];
  const counts = examples.map(text => { const ruled = []; return { parsed: T.parseItems('specs/r.md', text).length, admitted: T.blocksOf('specs/r.md', text, ruled).length, ruled: ruled.length }; });
  for (const c of counts) { assert(c.parsed > 0); assert.equal(c.admitted, 0); assert.equal(c.ruled, 0); }
  return { counts };
});
check('Q2-threshold-table-filtered', () => {
  const text = '# Request rate contract\n\n| Subscription | Maximum requests per minute | Burst limit |\n|---|---|---|\n| Starter subscription | 10 | 20 |\n| Enterprise subscription | 100 | 200 |\n';
  const ruled = [], kept = T.blocksOf('specs/rate-limits.md', text, ruled);
  assert.equal(kept.length, 0); assert.equal(ruled.length, 2);
  return { kept: kept.length, rejected: ruled.map(x => ({ text: x.text, reason: x.reason })) };
});
check('Q3-gherkin-inherited-context', () => fixture({
  'specs/payment.feature': 'Feature: Payment approval\n\n  Background:\n    Given the account belongs to a SUSPENDED_TENANT\n\n' + Array.from({ length: 21 }, (_, i) => `  Scenario: Denied payment${i}\n    When the customer submits a payment\n    Then the request is rejected\n`).join('\n'),
}, d => {
  const h = git(d, 'rev-parse', 'HEAD'), before = A.allBlocks(d, h, ['specs/payment.feature']);
  const row = before.find(b => b.body.includes('Scenario: Denied payment20'));
  assert(row); assert(!row.body.includes('SUSPENDED_TENANT'));
  write(d, 'specs/payment.feature', fs.readFileSync(path.join(d, 'specs/payment.feature'), 'utf8').replace('SUSPENDED_TENANT', 'ACTIVE_TENANT'));
  const next = A.allBlocks(d, commit(d), ['specs/payment.feature']).find(b => b.body.includes('Scenario: Denied payment20'));
  assert.equal(next.cid, row.cid);
  const ctx = path.join(d, '.ctx'); A.collect({ cwd: d, ctx, reqPaths: 'specs/**', maxRequirements: 80 });
  const plan = S.plan({ ctx, root: d, batch: 20, limit: 250000, schemaFile: path.join(__dirname, 'src/audit.schema.json'), contextPack: P.contextPack, windowPack: P.windowPack, assembleAudit: require('./src/prompt').assembleAudit });
  const part = plan.parts.find(p => p.cids && p.cids.includes(next.cid));
  assert(part); assert(!part.prompt.includes('ACTIVE_TENANT')); assert(!part.pack.text.includes('ACTIVE_TENANT'));
  return { scenarioCidUnchanged: true, inheritedConditionInBody: false, inheritedConditionInPart: false, blockCuts: part.blockCuts };
}));
check('Q4-shared-test-helper-freshness', () => fixture({
  'src/amount.js': 'function amount(value) {\n  return value + 1;\n}\nmodule.exports = { amount };\n',
  'tests/amount.test.js': 'const test = require("node:test");\nconst { amount } = require("../src/amount");\nconst { verifyExact } = require("./helpers/check");\ntest("increment", () => { verifyExact(amount(2), 3); });\n',
  'tests/helpers/check.js': 'const assert = require("node:assert/strict");\nexports.verifyExact = (actual, expected) => {\n  assert.equal(actual, expected);\n};\n',
}, d => {
  const h = git(d, 'rev-parse', 'HEAD'), first = U.inventory({ cwd: d, head: h, maxUnits: 1 }).picked[0];
  assert.deepEqual(first.tests, ['tests/amount.test.js']);
  const prior = { head: h, blocks: [{ cid: first.id, status: 'covered', runs: 2, at: { date: '2026-10-16', head: h } }], versions: { uv: { [first.id]: first.ver }, ev: {} } };
  write(d, 'tests/helpers/check.js', 'const assert = require("node:assert/strict");\nexports.verifyExact = (actual, expected) => {\n  assert.ok(actual);\n};\n');
  write(d, 'src/new-entry.js', 'function newEntry(value) {\n  return value;\n}\nmodule.exports = { newEntry };\n');
  const next = U.inventory({ cwd: d, head: commit(d), maxUnits: 1, prior });
  assert.equal(next.rows.find(x => x.id === first.id).ver, first.ver); assert.equal(next.rotation.changed, 0); assert.equal(next.picked[0].path, 'src/new-entry.js'); assert.deepEqual(next.stale, []);
  return { tests: first.tests, versionUnchanged: true, changedPriority: next.rotation.changed, selectedInstead: next.picked[0].path, stale: next.stale, helpersInUnits: next.rows.some(x => x.path.includes('helpers')) };
}));
check('Q5-large-source-outside-universe', () => fixture({
  'src/large.js': Array.from({ length: 4500 }, (_, i) => `exports.fn${i} = value => value + ${i}; // ${'padding '.repeat(12)}`).join('\n') + '\n',
}, d => {
  const bytes = fs.statSync(path.join(d, 'src/large.js')).size; assert(bytes > 512 * 1024);
  const inv = U.inventory({ cwd: d, head: 'HEAD', maxUnits: 12 });
  assert.equal(inv.rows.length, 0); assert.equal(inv.limitations.length, 0);
  return { sourceBytes: bytes, units: inv.rows.length, limitations: inv.limitations };
}));
check('Q6-document-admission-does-not-rotate', () => {
  const files = Object.fromEntries(Array.from({ length: 61 }, (_, i) => [`specs/r${String(i).padStart(3, '0')}.md`, `# Contract ${i}\n\nAC-1: The account ${i} must reject duplicate transfers.\n`]));
  return fixture(files, d => {
    const ctx = path.join(d, '.ctx'); const first = A.collect({ cwd: d, ctx, reqPaths: 'specs/**', maxRequirements: 80 });
    const chosen = A.allBlocks(d, 'HEAD', first.docs);
    const prior = { head: git(d, 'rev-parse', 'HEAD'), blocks: chosen.map(b => ({ cid: b.cid, status: 'covered', runs: 2, at: { date: '2026-10-15', head: 'HEAD' } })), versions: { ev: {}, uv: {} } };
    const second = A.collect({ cwd: d, ctx, reqPaths: 'specs/**', maxRequirements: 80, prior, rotate: true });
    assert.equal(first.docs.length, 60); assert.deepEqual(second.docs, first.docs); assert(!second.docs.includes('specs/r060.md'));
    return { trackedRequirementDocs: 61, admitted: second.docs.length, tailEverSelected: false, explicitlyRejected: fs.readFileSync(path.join(ctx, 'audit-rejected.txt'), 'utf8').includes('specs/r060.md') };
  });
});
check('Q7-monorepo-name-collision-candidate-cap', () => {
  const source = 'packages/z/src/ledger.js', relevant = 'packages/z/qa/account-behaviour.test.js';
  const tests = [...Array.from({ length: 20 }, (_, i) => `packages/p${i}/tests/ledger.test.js`), relevant];
  const got = M.mapTests(source, { tests, per: 20, names: ['depositFunds', 'withdrawFunds'], calls: () => [relevant], mentions: () => [relevant] });
  assert.equal(got.size, 20); assert(!got.has(relevant));
  return { chosen: got.size, unrelatedSameName: [...got.keys()].filter(p => !p.startsWith('packages/z/')).length, twoSymbolCandidateAdmitted: got.has(relevant) };
});
check('Q8-real-collector-single-call-evidence', () => fixture({
  'specs/contract.md': '# Contract\n\nAC-1: The validator rejects negative invoice amounts before charging.\n',
  'app/selection.js': Array.from({ length: 30 }, (_, i) => `exports.select${i} = value => value ? ${i} : 0;`).join('\n') + '\n',
  'billing/validator.js': 'function validateInvoice(amount) {\n  if (amount < 0) throw new Error("validator rejects negative invoice amounts before charging");\n  return amount;\n}\nmodule.exports = { validateInvoice };\n',
  'billing/validator.test.js': 'const test = require("node:test"), assert = require("node:assert/strict");\nconst { validateInvoice } = require("./validator");\ntest("validator rejects negative invoice amounts before charging", () => {\n  assert.throws(() => validateInvoice(-1));\n});\n',
}, d => {
  const ctx = path.join(d, '.ctx'); A.collect({ cwd: d, ctx, reqPaths: 'specs/**', maxUnits: 1 });
  const ev = fs.readFileSync(path.join(ctx, 'audit-evidence.txt'), 'utf8'), units = fs.readFileSync(path.join(ctx, 'audit-units.txt'), 'utf8');
  assert(ev.includes('billing/validator.js')); assert(units.includes('app/selection.js')); assert(!units.includes('billing/validator.js'));
  const pack = P.contextPack(ctx, d, 250000);
  assert(!pack.text.includes('validator rejects negative invoice amounts')); assert.deepEqual(pack.notWhole, []);
  return { evidenceFromRealCollector: true, selectedUnit: 'app/selection.js', evidencePacked: false, notWhole: pack.notWhole };
}));
console.log(JSON.stringify(results, null, 2));
```

</details>

<details>
<summary>Actual output: 8 counterexamples</summary>

```json
[
  {
    "id": "Q1-short-explicit-requirements",
    "reproduced": true,
    "counts": [
      {
        "parsed": 1,
        "admitted": 0,
        "ruled": 0
      },
      {
        "parsed": 1,
        "admitted": 0,
        "ruled": 0
      }
    ]
  },
  {
    "id": "Q2-threshold-table-filtered",
    "reproduced": true,
    "kept": 0,
    "rejected": [
      {
        "text": "| Starter subscription | 10 | 20 |",
        "reason": "results/data table row"
      },
      {
        "text": "| Enterprise subscription | 100 | 200 |",
        "reason": "results/data table row"
      }
    ]
  },
  {
    "id": "Q3-gherkin-inherited-context",
    "reproduced": true,
    "scenarioCidUnchanged": true,
    "inheritedConditionInBody": false,
    "inheritedConditionInPart": false,
    "blockCuts": {}
  },
  {
    "id": "Q4-shared-test-helper-freshness",
    "reproduced": true,
    "tests": [
      "tests/amount.test.js"
    ],
    "versionUnchanged": true,
    "changedPriority": 0,
    "selectedInstead": "src/new-entry.js",
    "stale": [],
    "helpersInUnits": false
  },
  {
    "id": "Q5-large-source-outside-universe",
    "reproduced": true,
    "sourceBytes": 627780,
    "units": 0,
    "limitations": []
  },
  {
    "id": "Q6-document-admission-does-not-rotate",
    "reproduced": true,
    "trackedRequirementDocs": 61,
    "admitted": 60,
    "tailEverSelected": false,
    "explicitlyRejected": true
  },
  {
    "id": "Q7-monorepo-name-collision-candidate-cap",
    "reproduced": true,
    "chosen": 20,
    "unrelatedSameName": 20,
    "twoSymbolCandidateAdmitted": false
  },
  {
    "id": "Q8-real-collector-single-call-evidence",
    "reproduced": true,
    "evidenceFromRealCollector": true,
    "selectedUnit": "app/selection.js",
    "evidencePacked": false,
    "notWhole": []
  }
]
```

</details>

## 12. Verdict

**Verdict:** First ensure that requirements and source can fully enter a traceable review set, then ensure that behavior and evidence enter the chunk together, and finally verify consistency across chunks/versions. A whole-repo unit-test audit should output credible behavioral evidence and an explicit unknown scope, and must not treat file counts, candidate counts, or the number of successful runs as proof of quality.

**Not checked:** No real model/pilot was run, no new chunker was implemented, not all contract formats and programming languages were covered, and no performance stress test was done on 6001 files or actual large adopter repositories. The full trace regression was actively aborted; its 22 directly related parsing cases passed separately, which cannot replace the remaining Git/CLI scenarios. This round corrects the evidence statements in the documentation, and the product findings are still pending implementation and regression verification.
