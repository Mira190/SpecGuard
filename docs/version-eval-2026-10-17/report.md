# SpecGuard new-version detailed eval: improvements, shift-left, full goal, and provenance

> Public cleaned-up version: the conclusions below belong to a historical evaluation of the fixed versions named in the text and are not a fresh acceptance of the current version. Raw logs, contexts, source snapshots, diagnostic scripts, and result JSON stay local; the file names mentioned in the text are evidence identifiers, not downloads or rerun entry points available in the public repository.

Date: 2026-10-17, Australia/Sydney. The main agent and two workers separately evaluated actual packing / real runs / scoring, requirement retrieval, and scan execution with evidence provenance. This round did not change product logic, push branches, create PRs, or trigger new paid model calls; the real-model evidence comes from GitHub Actions runs that already existed.

## 1. Conclusion

**The new version has a reproducible improvement, mainly in evidence entering the context, completeness of segmented execution, budget utilization, and result metering; it cannot yet be judged to have reached the full goal, and there is not enough valid paired model data to show that actual recall or team shift-left benefit has increased.**

It is now suitable for a controlled pilot. It cannot be accepted as "fully reviews the declared scope, every finding is traceable to the call that produced it, and QA rework is proven to be reduced". The previous round's single-review multi-worker / full-scope execution plan has also not been implemented on main in this round.

The most critical findings of this round:

1. The old counterexample where a part that was never executed globally still produced validated findings is closed, but **call-level provenance is still lost**: a finding from call1 can be let through using call2's visible source.
2. Under the same budget, runtime admission can review more segments; but **selected-scope complete still does not equal full-target complete**.
3. File classification and PR test context did improve, but **better context does not mean the model is more accurate**.
4. Of the 23 recent real eval PRs, **5 were constructed invalidly**; the 18 valid ones in turn span three different product builds and cannot serve as a same-condition A/B for the latest version.
5. The grader double-counts false positives for the same inline finding and its coverage row. The raw scoring must be kept as diagnostics and cannot be used directly as model precision.

## 2. Version boundaries and evidence levels

| Object | Fixed version / build | Purpose |
|---|---|---|
| Previous round version | `7c131b5f6ad78d46279ca038518b2818fc757f1f` / `89b1e3504c13` | Baseline for all paired probes |
| New-version main at the start of this round | `b377cff939d452d339d5ec284d9b137e2c0b85e6`, #301 / `9224bdda240f` | Full paired candidate |
| Main added during the evaluation | `5247da3ebf95826f1e544b2df0e1ca45ddc813ce`, #305 / `34dfad4db80c` | Diagnostic increment and re-test of scan counterexamples |
| #301 actual CI head | `59c9dbc2065e9654370ac4075fadc9502f2698d3` | Tree is identical to b377cff, both `5e7b3ca2681d8fd6fb4fc0df4e140a7afcb58fd1` |
| Recent real eval samples | 23 case PRs fixedly sampled from PR #280–#306 | Audit of existing end-to-end runs and eval inputs; not passed off as a same-condition new-version A/B |

Version sources: [b377cff](https://github.com/Mira190/SpecGuard/commit/b377cff939d452d339d5ec284d9b137e2c0b85e6), [5247da3](https://github.com/Mira190/SpecGuard/commit/5247da3ebf95826f1e544b2df0e1ca45ddc813ce). The original working tree was not switched; snapshots were exported from fixed Git objects and executed from there.

This document distinguishes three kinds of evidence: **actual module paired probes** prove deterministic behavior; **real Actions / artifacts** prove on-site execution; **historical reports or PR author numbers** serve as background only. A controlled provider stub is not counted as a model recall experiment, and marker visibility is not counted as defect recall.

## 3. Version improvements actually run this round

### 3.1 Scan status, evidence constraints, and budget

Reproduction script: `scan-worker/paired.cjs`; results: `scan-worker/paired-results.json`. Finally the same probe set was re-run with 5247da3 and saved as `scan-worker/latest-results.json`; the key results are consistent.

| Same input | 7c131b5 | b377cff; 5247da3 re-test identical | Conclusion available |
|---|---:|---:|---|
| Finding references lines of a budget-dropped part | 1 non-low finding | 0 | Closes the known global-scope out-of-bounds counterexample |
| Finding references lines of a failed part | 1 non-low finding | 0 | A failed segment no longer supplies reviewed evidence |
| Collector leaves later parts unplanned | complete; reviewed whole | incomplete; reviewed in part | Coverage status is more honest |
| Positive control where all parts succeed | finding kept, complete | same | Problems were not masked by disabling findings wholesale |
| Budget is 1.5 worst-case reservations, actual usage very low | 1 call | 2 calls | Extra parts can continue under the same budget |
| split request usage missing | cost recorded as 0 | recorded as $0.0020748 conservative reserve, estimated | Unknown requests are no longer treated as free when admitting the next batch |

In the budget probe each worst-case reservation is about $0.0020748 and the total budget about $0.0031122; provider usage is a fixed stub. The "1→2" here cannot be extrapolated to a real doubling of throughput or an actual cost reduction.

The new runtime admission is still mainly used for stateless split scans; the eight-unit-call cap and the inventory's file/byte/time limits are still in place. It improves utilization of a limited budget; it does not implement an unlimited-scope complete review.

### 3.2 PR context packing

`paired-pack.cjs` calls the real `contextPack()` of both versions, fixing source, test, diff, candidate list, and size boundary, and replacing only the packing implementation. Results are in `paired-pack-results.json`.

| Regression scenario | Baseline visible markers | Candidate visible markers | Interpretation |
|---|---:|---:|---|
| Large earlier files crowd out the pack, later source and test still exist | 4/5 | 5/5 | Later tests are no longer starved |
| A changed test is first encountered as a candidate of another source | 0/1 | 1/1 | Its own added hunk is retained |
| Candidate test only mentions a changed identifier | 0/1 | 1/1 | Identifiers in the source hunk can drive test slicing |
| Small-PR positive control | 2/2 | 2/2, identical pack text | Small-scope behavior preserved |

This set consists of specially chosen regression samples; 4/5→5/5 or 0/1→1/1 must not be written as an overall improvement rate for representative repositories.

Additionally, using **the real artifact of #301**, both versions' packs were rebuilt for the same candidate target tree with the same 250000-byte limit:

| Metric | Baseline pack | Candidate pack |
|---|---:|---:|
| `src/claude-api.test.js` added lines visible | 30/30 | 30/30 |
| `src/engines/claude-api.js` added lines visible | 10/10 | 10/10 |
| pack bytes | 149909 | 163718 |
| Number of paths listed as cut | 4 | 5 |

This real control example **shows no gain in added-line visibility**, and the candidate still has truncation; this result should be kept. It shows the improvement has trigger conditions, and one cannot infer "every PR is better" from the regression samples. The change in the number of cut paths is not a standalone quality score; one needs to look at whether the actually relevant evidence is complete.

This rebuild fixed the collector output, so it measures the pack implementation, not the end-to-end effect of the whole old and new collector.

### 3.3 Requirement → code → test location

The 21 explicit path samples of `trace-worker/probe.cjs`: **16/21 → 21/21**. Previously production files such as `src/test-map.js` and `src/spec-loader.js` were treated as tests; the new version classifies them correctly, and normal test files are still recognized.

For the same requirement, the same existing Git blobs, and the synthetic production path `src/test-premium.js`, calling the real `requirementToCode()`: the baseline lacks that production-code candidate and the candidate correctly shows it. This proves the fix has propagated into the actual requirement-location path, not just the regex unit test.

But the source of the seven core functions `tokenize / buildIndex / parseItems / isRequirementDoc / pairItems / valueDeltas / requirementToCode` is identical. **The new version adds no complete semantic graph, dynamic dependency inference, or persistent requirement identity.**

The attribution of the repository's historical fastify numbers must be corrected: MRR .444→.750 and hunk-test Hit@3 4/24→20/24 come from #239/#249, which predate this baseline, and cannot be counted again as improvements of this round. Shortfalls retained in the historical set include:

- req→code Recall@3: 26/58, 44.8%.
- req→code All-required@3: 6/24, 25%.
- code→req Hit@3: 15/24, 62.5%.
- code→tests All-required@3: 6/24, 25%.

This is not a full new retrieval re-run on b377cff; it only reads versioned historical results here, to avoid reporting only MRR while ignoring missed positions. The 24 queries come from different variants of 12 behaviors, not 24 independent behaviors.

### 3.4 Metering and diagnostics

`metric-audit.cjs` measured, when the old row lacks the delivered field: baseline `precision_delivered=0`, candidate `null`. This is a correct compatibility improvement: unknown no longer masquerades as zero.

5247da3 only adds the provider schema rejection reason and redacted raw-text retention when there is no JSON. This round ran its two new tests: **2/2 passed**. This improves fault tracing; it does not mean the cause of schema rejection has been fixed, nor does it change the recall, segmentation, or provenance constraints above.

## 4. Independent check of the real GitHub Actions

The head tree of [run 39022520963](https://github.com/Mira190/SpecGuard/actions/runs/39022520963) is identical to b377cff. Jobs, the full test log, and the dogfood log were read, and artifact `12097695057` was downloaded; the evidence summary is in `candidate-ci-evidence.json` and the raw context in `candidate-live-ctx/`.

| Check item | Actual result |
|---|---|
| Linux CI | 1436 tests; 1432 pass, 0 fail, 3 skipped, 1 TODO |
| dogfood job | success |
| review status | **incomplete**, 0 findings; job success must not be written as a complete review |
| Actual model | claude-haiku-5-5 |
| usage | input including cache 101257 in total; output 6110 |
| engine duration | 29.154 seconds; not an end-to-end feedback latency including queueing |
| Cost computed by the report | $0.0602632, from usage × the current code price table, not an independent bill reconciliation |
| Evidence status | source/tests still have cuts; some of the raw model's covered were downgraded to unknown in the final report |
| schema output | the log shows a schema fallback, and a parseable findings.json was finally kept; this is not grounds to claim schema-enforced output is always available |

This shows the new build runs on site and can output an honest incomplete status, but a single dogfood run without a seeded oracle cannot measure recall.

The candidate's four relevant test files were also run locally: 235 of 240 pass, 5 fail; all five failures show `EPERM` on temporary fixture paths, four of them being cleanup hooks. They were not ignored to claim a green local run, nor treated as confirmed product regressions. The initial sandbox attempt was aborted due to environment restrictions; the full log is saved in `targeted-tests-elevated.tap`. The green Linux CI conclusion belongs only to the fixed b377cff-equivalent tree above and is not passed off as a full CI suite for 5247da3.

## 5. Recent real eval samples: validate the evaluation itself first

23 cases were extracted from existing PRs, without opening new PRs or calling models. `score-live.cjs` compares each case's head overlay against the Git blobs actually committed and checks that sandbox's real diff, then recomputes with the candidate's canonical grader.

### 5.1 Five traceability scenarios did not commit the expected change

| PR / case | Actual diff file count | File count mismatching the head fixture |
|---|---:|---:|
| #299 / tr1 | 0 | 1 |
| #302 / tr11 | 0 | 2 |
| #303 / tr12 | 0 | 3 |
| #304 / tr13 | 0 | 1 |
| #306 / tr14 | 0 | 1 |

Their summaries are all Nothing to review. **These samples are evaluation-construction failures and cannot be counted as reviewer-quality passes or misses; the 5/23 harness failure record should also be kept, to avoid prettifying system reliability by dropping failures.**

An extra whole-tree check was done for [#302](https://github.com/Mira190/SpecGuard/pull/302): base and head trees are both `89195348a3ffd3086a91aa63d9216cc419c62d9e`; the actual head is still `CAP_MULTIPLIER=2`, and the expected `=3` does not exist.

`eval/run.js:142–150` only does copy → add → `commit --allow-empty`, with no check of staged blobs, the commit diff, or oracle quotes. `eval/local.js` already notes the risk of a stat-cache with same-size files and timestamps; but this round did not causally reproduce it as the sole root cause of these commits. What can be confirmed is that input construction lacks a validity gate. When fixing, one must also consider that in a linked worktree `.git` is a file, so deleting `.git/index` cannot simply be copied.

Of the latest six traceability samples, five were constructed invalidly; the remaining tr10 has no expected positive finding and does not meet the expectation for showing a pre-existing trace. So **this batch of runs cannot prove end-to-end recall of the new version for requirement drift.**

### 5.2 The 18 valid samples are not a current-build paired experiment

| Product build | Valid case PR count |
|---|---:|
| `94d2150be31e` | 14 |
| `61e48fd94d4b` | 3 |
| `51e34a80f71b` | 1 |

None of them equals b377cff's `9224bdda240f` or 5247da3's `34dfad4db80c`. So they can only serve as evidence of recent system behavior, and differences between groups cannot be called new-version improvements.

The canonical grader's raw diagnostic output for these 18 valid constructions is: TP 8, FN 10, FP 10, delivered recall 8/18, strict pass 2/18. 8 summaries are incomplete and 10 are complete. The full raw results are saved in `live-scores.json`.

**These numbers cannot be called "new-version precision/recall" directly.** Besides the version difference, there are the following scoring limits:

1. [#296](https://github.com/Mira190/SpecGuard/pull/296) actually has only one high-confidence weak-test comment, targeting the weak assertion of clamp; the product counts also record only one. The grader nevertheless records the source coverage row of the same obligation as another FP, ending at 1 TP + 1 FP. `metric-audit.json` keeps the reproducible evidence. It relies on path/line/title grouping and has no reliable join obligation/fingerprint.
2. #288's strikethrough finding is the same actual protection gap that the fixture already allows, but its kind/anchor differ, so the exact oracle records it as an FP; this item needs a semantic ruling, and not every unmatched item can be taken as a real false positive.
3. The expected finding's `allow_summary` constraint, low-confidence Details, and body-text clarification requirements are different delivery levels. That the model once mentioned a gap does not mean the developer received a clear fix request, and a loose "roughly the same semantics" must not be used to mask a delivery failure.
4. This batch only read comments and did not download raw findings case by case; the grader's `json_valid` then falls back to a summary-completeness judgment. Its 10/18 cannot be called a true JSON parse rate.

There is still verifiable product behavior: #293/#294 did emit coding-standard comments with the base rule source; #296 has a concrete counterexample and an assertion-replacement suggestion; #287 points out a conflict between the requirement and an implementation returning null. A counter-example is that the known gaps of #286/#292/#295/#297 still appear mainly via low-confidence / unconfirmed paths, and titles with hidden counts cannot be taken as delivered.

Complete fixture-level results and human semantic rulings need to be saved separately, without modifying expected answers to chase a prettier score. This round did not fabricate independent two-person annotations for these samples.

## 6. Provenance is still not closed: reproduced residual problems

All of the following were verified in the actual modules of baseline, b377cff, and 5247da3; they are remaining problems, not passed off as regressions introduced by the new version. Request bodies, real publisher summaries, and source hashes are in `scan-worker/fixtures/` and the result JSON.

### R1 · High priority: a finding is not bound to the call that produced it

The same unit is split into two calls. The actual request1 sees only part1, and only request2 sees part2. Let only request1 return a missing_test referencing part2, with request2 returning an empty result. **A non-low finding is still kept in the end, status complete.**

The candidate fixes "ranges never successfully executed globally", but loses the origin when merging answers, and validates against the union of all successful spans. That another call saw this code cannot prove that the call that produced the finding saw it, saw the corresponding test, or made a judgment based on it.

Location: candidate `src/engines/claude-api.js:473,489` aggregation, `src/audit-post.js:338,869` successful-range constraints. The direction of the fix is for each finding to carry a call/attempt ID and bind to that attempt's actual source/test visibility; static clues keep an independent producer.

### R2 · High priority: single-call source is cut, yet a finding can still be over-confirmed

Pack 1000 bytes, the reference is at source line99, the actual request does not contain that statement, and `pack-cut.txt` also explicitly lists that source file. The final global status correctly shows incomplete, but the missing_test on that line is still non-low.

The current test-evidence cut guard and the `u.part` span check do not cover the exact visible interval of ordinary source files. **A global warning cannot replace per-conclusion evidence constraints.** The source/test spans of single/split should be unified, and then validated or downgraded by origin.

### R3 · Medium priority: unknown usage of a single request is still shown as zero cost

split already has a worst-case reserve; the single path is not given the same reserve. The 5247da3 re-test is still `totalCostUsd=0,costEstimated=true`. This proves cost reporting is incomplete; **it does not prove a budget overrun occurred**, because that single path does not go on to admit additional requests.

### R4 · Goal gap: full scope and complete result presentation are not yet implemented

With 2 eligible/inventoried units, selecting and reviewing only 1 and leaving the other unreviewed, both versions can have status complete. The current semantics are selected scope; the full-target that users need has no separate completion contract.

There are also the 60-unit-findings intake cap and the caps on the Summary main list/Details/evidence table; the PR still has upfront diff/focus truncation. A single publisher exists, but "only one report" does not equal "the whole declared scope fully reviewed and all conclusions delivered losslessly".

## 7. Does it satisfy shift-left and the original goal

| Goal | This round's judgment | Basis / acceptance gap |
|---|---|---|
| Provide checks on the PR, before QA | Process in place, usable in controlled cases | Real Action ran; missing queue-inclusive latency and the moment real people actually received feedback |
| Find effective unit-test gaps earlier | Positive examples exist, stability not accepted | Concrete weak-test / deleted-test findings are visible; recent valid samples still show many low-confidence / undelivered items and incomplete context |
| Find implementation/test deviating together from the requirement | Retrieval and rule paths exist, current end-to-end evidence insufficient | No valid new positive example where tests and implementation are wrong together has been established; five trace eval constructions are invalid |
| Requirement ↔ code ↔ test traceability | Reference-level partly satisfied, call-level not satisfied | quote/path/line/base source and build are checkable; R1/R2 not closed, and relevance is not semantic proof |
| Coding standard follows repository rules | Mechanism and specific real canary have evidence | #293/#294 show base rules can take effect; cannot be extrapolated to all languages and standards |
| Whole-repo review completed in one pass | Not satisfied | More parts under the same budget is not all parts; selection, call, file, and result caps remain |
| Multiple workers aggregated into one Action Summary | Single report satisfied, worker execution not implemented | The current scan runs batches serially; the previous architecture plan has not become a product capability |
| unknown unknown | Not proven | Static boundary/export/assertion signals are limited heuristics; detecting seeds does not mean discovering unknown categories |
| Fix loop | Tracking proxy exists, fix effectiveness not proven | addressed means related lines/tests changed; new tests and error-targeted validation are not run by default |
| Reduce QA escapes and rework | Not proven | No human control data this round; seeded recall, comment counts, or unit touched cannot substitute |
| Company Copilot default path | Not accepted this round | The real-model evidence is the Claude path; Copilot PAT on-site behavior cannot be accepted from it |

A synthetic score such as "overall 80% complete" is not recommended. The evidence strength, remaining risk, and value of different goals cannot be offset by one arbitrary weighting.

A true shift-left needs at least this closed: independent requirement available at the time → valid, timely, actionable finding → author confirms and changes → new protection can catch the corresponding error → protection still retained before QA. This round's improvement is mainly in the reliability of the first half of the chain; the whole value chain is not proven.

## 8. Shortest path to next-round acceptance

1. **Fix evaluation validity and identity first.** Before opening PRs / spending model quota, gate on worktree bytes, staged blobs, the commit diff, and expected quotes; a zero-diff positive example is directly a construction error. Fix the Action SHA/build, target SHA, model, trace, pack, budget, and requirement version. The result table records construction failure, engine failure, and valid review separately, without hiding failures.
2. **Fix score deduplication, then run a matched real-model A/B.** Merge raw finding, coverage, inline, and summary by stable ID / obligation relationship; preregister kind/anchor substitution rules. Keep two columns: fixture strict score and independent semantic ruling. First run representative normal / boundary / failure / deletion / cross-file requirement conflict / clean controls, then repeat over enough independent cases, reporting uncertainty clustered by case.
3. **Fill in provenance first, then concurrency.** finding → attempt → snapshot → actual source/test spans → requirement source/version → final delivery. Fix the R1/R2 counterexamples as regression tests, ensuring the same problem is handled consistently in the single/split paths.
4. **Full-scope acceptance looks at the task denominator.** Do not only count unit touched; record eligible, inventoried, planned, executed, answered, verified, full-evidence, and reasons for incompleteness. The full-target goal is judged separately; when the budget is insufficient, keep the validated results and mark incomplete explicitly.
5. **Verify that feedback can become protection.** Write tests independently for sample findings: first pass on the correct version, then fail on the corresponding error / reasonable mutant; mirror/oracle-independence is ruled by independent business expectation, not by production mutation alone.
6. **Then prove team value with a human PR pilot.** Following the repository validation plan: blind-labelled precision ≥65%, fix-through proxy ≥25% with interval lower bound >15%, time-to-merge increase ≤15%, share of valid unique findings versus native review ≥40%; also directly record verified fix, author handling time, QA escapes, and the cost of all attempts. When there are no samples write "insufficient evidence", and do not prefill a pass.

These are acceptance conditions not yet passed; they do not mean a new online pilot or paid A/B was carried out this round.

## 9. Public delivery boundary

This public version keeps the fixed versions, deterministic observations, the check results of actual public PRs, and the limitations. Raw contexts and scripts that depend on local snapshots are not included in the public commit; readers cannot re-run these historical experiments from this public version alone. This cleanup did not re-call models or run a new online pilot.

The [short summary](summary.md) uses the same evidence boundary. Publishing these observations does not mean the findings in this document have been fixed, nor that model quality or QA benefit has been proven to improve. Resolve evaluation construction, scoring identity, and call-level evidence provenance first, then run fixed-condition old-vs-new comparisons.
