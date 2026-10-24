# SpecGuard Latest Re-Check: Shift-Left Metrics, Recall and Precision, and the Correct Use of Error Functions

> **Disposition status (2026-10-17):** M1 actionable TP/FP asymmetry, M4 end-to-end recall, M5 summary-only blind-labelling denominator, the P×A basis, and sizeVariants thousands separators have been scheduled for fixes (see follow-up PRs); the full ledger schema and Brier/calibration are deferred.

Date: 2026-10-17, Australia/Sydney. Code baseline: cb235b11f4234570f6506d0a278d786554b287d3, with #238–#241 merged; initial online snapshot 01:40 UTC (Sydney 12:40). The main branch observed at wrap-up is 1f84964da10665f5b99ee15a9aeb0195af345753; compared with the baseline it has only the docs/old-evidence archival of #242, with no change to the evaluator or product source, so the probe conclusions below still apply. The root workspace is still the older b1aaf113; this round checked the relevant local fix branches and the remote version, and used newer pinned Git objects to read and execute the probes.

**Core judgement: what is most worth optimizing in the next stage is not raising "recall", "accuracy", or the scan count on their own, but, under an acceptable author burden, steadily delivering real, evidence-backed, actionable problems before merge, and verifying that the follow-up fixes are truly effective.** The first thing to fix now is the asymmetry in the evaluation basis and the inconsistency of samples; otherwise suppressing the number of findings, increasing Unknown, or changing the display position could all make the metrics look better without improving shift-left.

This round read the latest PR discussions, the job logs and artifact metadata of three Actions, and re-checked the evaluation, fix-tracking, retrieval, and scan degradation paths; 8 deterministic probes were run with the pinned-version real functions (including an actual summary-rendering comparison for the same issue). No model re-run was launched, and no product code or GitHub was modified.

Deliverables: [evidence snapshot](/C:/Files/Projects/SpecGuard/docs/shift-left-metrics-review-evidence-2026-10-17.json), [probe results](/C:/Files/Projects/SpecGuard/docs/shift-left-metrics-probe-results-2026-10-17.json), [metrics dictionary CSV](/C:/Files/Projects/SpecGuard/docs/shift-left-metrics-dictionary-2026-10-17.csv). The metrics research uses 15 primary sources; proposals, probes, the maintainers' reported measurements, and the online facts read directly this round are each labelled separately.

## 1. First, a Clarification: What the MRE / MSE You Remember Might Be

| Name | Meaning | Use for SpecGuard | Current priority |
|---|---|---|---|
| MRR | Mean Reciprocal Rank | Whether the correct requirement/code appears quickly near the front of the candidates | High, suited to the retrieval layer |
| MSE | Mean Squared Error | Error of continuous numeric predictions such as duration and cost; the probability version corresponds to Brier | Not applicable as the main metric of classification quality |
| RMSE | Square root of MSE | Brings continuous prediction error back to the original unit such as seconds or dollars | Only when there is a numeric prediction need |
| MAE | Mean Absolute Error | Intuitive deviation for cost/duration prediction | Auxiliary |
| MRE | An abbreviation of Mean Relative Error; the definition may vary | Relative prediction deviation; it must be stated whether absolute values are taken and what the denominator is | A vague abbreviation is not recommended as the main metric |
| MAPE | Mean Absolute Percentage Error | Relative numeric prediction error; very unstable when the true value is near zero | Not suitable for scenarios such as a valid-finding count of zero |
| SEM / standard error | Uncertainty of the mean estimate | Whether a change in results might be just sampling/model fluctuation | High, statistical interpretation layer |
| Brier / log loss | Probability prediction scoring | If we later have calibrated, labelled validity probabilities, they can be used for evaluation | Deferred; the current high/low is not a probability |

Therefore no single error function can evaluate the whole Action. It contains information retrieval, gap identification, selective output, the execution system, and the author workflow, and must be measured in layers.

Sources: [NIST reciprocal rank implementation](https://github.com/usnistgov/trec_eval/blob/main/m_recip_rank.c), [MSE](https://scikit-learn.org/stable/modules/generated/sklearn.metrics.mean_squared_error.html), [the zero-value problem of relative error](https://scikit-learn.org/stable/modules/generated/sklearn.metrics.mean_absolute_percentage_error.html), [scoring functions and target matching](https://scikit-learn.org/stable/modules/model_evaluation.html).

## 2. New Repository State: Where Progress Has Been Made

| New fix | Effect on shift-left | What should not be directly inferred |
|---|---|---|
| #238: scan_paths selects only the main units, evidence reading covers the whole repo | Central requirements and shared tests no longer disappear directly because of package scope | Whole-repo searchable does not equal already reviewed |
| #239: headings, size expressions, excluded-document candidates, displaying candidates outside the top 3 | Requirement→code recall and scope explainability improved | Displaying trimmed candidates does not mean they entered the model's judgement |
| #240: whole-repo symbols, sibling tests, baseline downgrade | Reduces the disturbance of "other protection exists yet it is said there is no test" | That every downgraded finding is a false positive, or that precision has been empirically improved |
| #241: tiered ranking of import, filename variants, plural/class matching | Test candidates are closer to reality, reducing wrong missing_test | That matching more tests proves stronger behavioral coverage |
| #233: judge effective-fix observation per finding, track summary-only | fast-tier/partial runs no longer lose disposition observations across the board | That addressed equals a verified fix, or that all statistics already use the same sample |

Basis: [PR #238](https://github.com/Mira190/SpecGuard/pull/238), [#239](https://github.com/Mira190/SpecGuard/pull/239), [#240](https://github.com/Mira190/SpecGuard/pull/240), [#241](https://github.com/Mira190/SpecGuard/pull/241), [#233](https://github.com/Mira190/SpecGuard/pull/233).

All four relevant local fix branches can be traced as ancestors of this round's pinned main branch; although leads.js in the old worktree reports modified, the normalized diff was empty at check time, and it was not regarded as a behavioral fix of a higher version. This round preserved the existing README and report changes in the root directory, and did not switch branches, fetch, or overwrite other tasks' worktrees.

## 3. The Latest Actual Actions: Throughput, Completeness, and Accuracy Must Be Looked at Separately

| Actual run | Tool version / target version | Log facts | Conclusion that can be drawn |
|---|---|---|---|
| [main-branch CI 38991100182](https://github.com/Mira190/SpecGuard/actions/runs/38991100182) | cb235b11 | 1291 tests; 1287 pass, 0 fail, 3 skipped, 1 TODO | The tests currently pass; this is not an acceptance of model quality |
| [Nest scan 38991206203](https://github.com/Mira190/SpecGuard/actions/runs/38991206203) | cb235b11; nestjs/nest c215fd9b4f583486c6ce39a3c43f257dc67e8329 | collector 40/1015 units; 10 read only part of the tests, recorded as unsure; job success, result incomplete | The new version does have multi-pack throughput, but there are still evidence-fitting limits |
| [TypeScript scan 38991208512](https://github.com/Mira190/SpecGuard/actions/runs/38991208512) | cb235b11; microsoft/TypeScript 2e9fb00f5f5c9186d09aabd78cced5ce2497456d | collector 24/727 units; 6 read only part of the tests, recorded as unsure; 0 design docs, 2 not admitted | Executed successfully; requirement alignment or complete protection cannot be inferred |

40/1015 and 24/727 are this round's selected count and inventory denominator, not defect recall. Nor can one merely subtract the partial counts and assert that all behaviors of the remaining units have been completely verified.

Both new scans have unexpired result artifacts, and the logs explicitly show the upload completed. This improves on the previous round's situation in which the old Kite artifacts could not be obtained. The GitHub tool this round obtained file references, but the local network could not download the returned file URLs, so the two full facts/summary files were not read and all findings were not re-labelled; the latest precision or the number of high-confidence findings cannot be fabricated.

The TypeScript log also shows that history fetching took noticeable time, so model calls are not the only source of elapsed time. The "speed" of the Action should count the whole process of queueing, checkout/history, collection, model, validation, and publishing.

## 4. The New Re-Check's Primary Finding: TP and FP Impose Inconsistent Requirements on Display Level

**Priority fix: the same low-confidence, collapsed content must not both be used to reward recall and be exempt from false-positive cost in normal samples.**

In the actual code, grade()'s summaryHits collects summary items and coverage rows; the TP matching of allow_summary does not adopt the same actionable restriction as FP. The FP path filters out non-actionable items, and an existing contract explicitly says that low-confidence/Details mirrors are not counted separately as coverage FP.

Results of probes M1/M1b:

| Same output | Positive sample, allow_summary=true | Normal control |
|---|---:|---:|
| Low-confidence missing_test in Details | TP=1, FN=0 | FP=0, clean=true |
| Rendered with the current buildSummary, the same low-confidence finding and row | TP=1, case pass=true | FP=0, clean=true |

This is not a re-argument of the contract, clarified in the previous round, that "a low-confidence mirror does not count as FP"; **the new problem is that the TP side can still obtain credit from this kind of already-discounted output.** It gives a system that switches to low confidence/collapsed display an asymmetric benefit in evaluation.

Minimal direction of correction: compute raw candidate recall and delivered actionable recall separately; the main TP and main FP use the same actionable candidate set and the same deduplication identity. Candidates shown only in Details can be evaluated separately, and must not be mixed into first-screen/actionable recall.

Code: [summaryHits and pickSummary](https://github.com/Mira190/SpecGuard/blob/cb235b11f4234570f6506d0a278d786554b287d3/eval/grade.js#L97), [FP path](https://github.com/Mira190/SpecGuard/blob/cb235b11f4234570f6506d0a278d786554b287d3/eval/grade.js#L135). The evidence is the M1/M1b executed this round, and does not represent its frequency across all historical results.

## 5. Other Evaluation Bases That Should Be Improved First

### 5.1 A Location-Matched TP Is Not Semantically Correct

M2: kind, path, and line match, the required text does not appear, and it is still TP=1, FN=0; the case fails because of text_miss. This is a contract the README already states, not an unknown algorithm bug newly found this round.

Impact: currently precision/recall can express "matched the preset location", and cannot be taken directly as "correctly explained the specific problem". We suggest adding semantic_validated_tp/recall, with location hits listed separately; semantic judgement should allow reasonable rewording and not rely mechanically on a single regex.

Code: [text_misses and TP](https://github.com/Mira190/SpecGuard/blob/cb235b11f4234570f6506d0a278d786554b287d3/eval/grade.js#L122).

### 5.2 A Pass Rate That Tolerates False Positives Is Not Precision to Begin With

M3: one TP plus one extra FP gives precision=0.5, while pass_rate is still 1. The current docs explicitly say FPs lower precision but do not automatically make an ordinary positive-sample case fail.

The explainability of this contract should be kept, naming it acceptance_case_pass or stating its conditions; if a strict regression threshold is needed, add a strict_pass that includes FP/semantic/citation/delivery conditions. Do not change the basis after the fact to rewrite historical scores.

Code: [pass condition](https://github.com/Mira190/SpecGuard/blob/cb235b11f4234570f6506d0a278d786554b287d3/eval/grade.js#L178), [evaluation contract](https://github.com/Mira190/SpecGuard/blob/cb235b11f4234570f6506d0a278d786554b287d3/eval/README.md).

### 5.3 Model-Conditional Recall and End-to-End Recall Need to Be Side by Side

M4: two preset positive tasks, one delivered successfully and one failed on infrastructure; the aggregate shows errors=1, but precision/recall/pass_rate are all 1, because the errored run is excluded.

When measuring the model itself, such a conditional metric is reasonable; when measuring the actual protection the Action gives users, the denominator should also be all assigned tasks that have an oracle. In the example, end-to-end delivered recall is 1/2. A failure should be attributed to execution loss; it must not be counted as a model FP, nor vanish from the denominator of user effect.

Code: [summarize's error filter](https://github.com/Mira190/SpecGuard/blob/cb235b11f4234570f6506d0a278d786554b287d3/eval/grade.js#L190).

### 5.4 The Fix Denominator and the Blind-Labelling Denominator of Summary-Only Do Not Match

#233 has brought summary-only into fix-through tracking, but weekly-report.findingsOf still iterates only over review_comments; blind labelling, partial findings/PR, overlap, and unique are all produced from this list.

M5: one summary-only finding can contribute fix-through findings=1, A=1, yet produce 0 blind-labelling candidates. The current validation-plan also acknowledges that the findings count is mainly inline; this is a known scope and needs to be aligned with the new tracking capability.

We suggest exporting a unified finding ledger, keeping the delivery field for inline/file/summary/Details; each metric states its exposure set explicitly, and precision and fix-through use stable IDs that can be linked. Do not multiply the precision of one set of comments by the A of another set of findings.

Code: [findingsOf](https://github.com/Mira190/SpecGuard/blob/cb235b11f4234570f6506d0a278d786554b287d3/eval/weekly-report.js#L122), [new outcomes and sum](https://github.com/Mira190/SpecGuard/blob/cb235b11f4234570f6506d0a278d786554b287d3/src/post.js#L1812).

### 5.5 Precision × A Cannot Be Taken Directly as the "Effective-Fix Rate"

The current F2 uses P×A as the break-even term of the value model. It can be kept as an economic model with assumptions, but it is not a measured joint proportion of "valid and fixed".

Counterexample: 100 findings, 50 valid and 50 invalid, exactly 50 touched. P=0.5, A=0.5, product 0.25 in both cases; if everything touched is invalid, effective fixes are zero; if everything is valid, the effective touched proportion is 0.5. Two marginal proportions cannot determine the joint result.

The correct relation is P(valid and verified_fix)=P(valid)×P(verified_fix|valid). It is best to observe the joint event directly by the same finding ID, and touched does not equal verified_fix.

Code: [P×A and F2](https://github.com/Mira190/SpecGuard/blob/cb235b11f4234570f6506d0a278d786554b287d3/eval/weekly-report.js#L235). This does not authorize rewriting already pre-registered thresholds; new trials should first revise the description and hypotheses, and then collect new data.

## 6. The Precision Gate of #240: Reasonably Conservative, but What It Misses Must Be Quantified

M6 uses the current audit.verify: for exactly the same missing_test finding, merely adding 200 unrelated baseline paths to the tracked set flips low from false to true. The code does indeed downgrade all missing_test by the repository-level baseline mechanism.

This is a conservative trade-off that #240 explicitly accepted, and not a method to prove coverage. The current status logic records low-only as unsure and keeps the uncertain state of historical gaps; this round did not report it as a new bug of "automatically covered".

The next step should record, for each kind of downgrade rule:

- demoted_valid: findings that were originally valid and were downgraded to low confidence.
- demoted_invalid: false positives that were successfully suppressed.
- retained_valid / retained_invalid: results retained in the actionable layer.
- Rule trigger count, reasons, affected repositories/behavior categories.

From this one computes, for each gate, "how many false positives it reduces and how many valid findings it loses", and draws a precision–recall or output-coverage curve on the same oracle set. For repo-wide same-name symbols and sibling tests, text appearing / a different assertion existing also only indicates something worth checking, and cannot directly prove that the target input and boundary are protected.

Sources: [downgrade implementation](https://github.com/Mira190/SpecGuard/blob/cb235b11f4234570f6506d0a278d786554b287d3/src/audit-post.js#L285), [#240 discussion](https://github.com/Mira190/SpecGuard/pull/240#discussion_r4300720635).

## 7. Retrieval Has Improved, but How the Current Numbers Should Be Interpreted

The maintainer's re-test discussion for #239 reports: Fastify 12 cases × 3 variants, req→code recall@1 about 11%→33%, recall@3 about 26%→47%, cases with all locations found from 1→3; code→req did not improve. **This round did not obtain an independent re-run of the original harness; the above are values reported in the discussion, not measured this round.**

This precisely shows that multiple retrieval metrics are needed: the first location being earlier, more of the necessary locations recovered, and all necessary entry points found are different abilities. 36 variant runs do not equal 36 independent business scenarios.

M7 additionally reproduced a format problem that was already left as a follow-up in that PR: sizeVariants('1048576 bytes') returns results, while sizeVariants('1,048,576 bytes') returns empty. We suggest adding held-out variants with separators/units; fixing just one format must not lead to claiming that all numeric requirements can be recalled. [Re-test discussion](https://github.com/Mira190/SpecGuard/pull/239#pullrequestreview-5555328740), [recorded follow-up](https://github.com/Mira190/SpecGuard/pull/239#discussion_r4300699900).

The discussion of #241 also reports "units with no matching test 625→306". This proves the candidate matching changed, and does not prove that the 319 additional units obtained correct assertion protection. The more candidates there are, the more easily the pack is truncated; the fact that part of the tests were unread in the latest external-repo runs should be observed together with matching recall. [#241 review](https://github.com/Mira190/SpecGuard/pull/241#pullrequestreview-5555356211).

## 8. Precision, Recall, Accuracy: Fix the Evaluation Unit First

We recommend separating at least three units:

| Unit | What a positive sample is | Reasonable use |
|---|---|---|
| Retrieval query—evidence location | Requirement/symbol/test scope labelled as relevant | recall@K, MRR, MAP, NDCG |
| Behavioral gap / finding | A real verification gap or requirement deviation that is observable at PR time and within the product scope | precision, recall, duplicate rate |
| PR / author work item | One pre-merge decision opportunity | FP/100 PR, valid interventions/100 PR, waiting and rework |

Lines, files, findings, and PRs must not be mixed into the same denominator. A gap that triggers three comments should be deduplicated; a comment claiming two independent problems should be split for verification by a pre-agreed rule.

At the finding level:

- TP: presented by the tool in the specified delivery manner, and independently verified as a real, applicable problem.
- FP: actually requires the author to act, but the problem is wrong, already correctly protected, out of scope, or misreads the requirement.
- FN: a problem in the oracle that could have been found at PR time and is within product scope, but was not effectively delivered.
- TN: can be counted only after a finite normal task set is defined; all code lines that raised no alarm cannot be treated as TN.

Precision=TP/(TP+FP); Recall=TP/(TP+FN); Accuracy=(TP+TN)/(TP+FP+FN+TN). A zero denominator returns N/A with the counts shown, not filled with 100%.

For rare defects, never raising an alarm can have a very high accuracy, even a very low MSE, yet have no shift-left value at all. So accuracy cannot be the north-star metric. Informal Chinese usage of "accuracy" should also be made explicit as either precision or overall accuracy. [Classification metric definitions](https://scikit-learn.org/stable/modules/generated/sklearn.metrics.precision_recall_fscore_support.html).

## 9. False Positives and False Negatives: Which Matters More

For the current advisory Action, persistent false positives consume authors' attention and harm adoption; but pursuing only high precision while hiding all hard items also prevents valid problems from being found early.

We recommend a constrained objective rather than maximizing a single number:

> Provided that key-risk recall does not regress, actionable precision meets the floor agreed for the pilot, and there are no wrong "protected" conclusions, increase the valid interventions per 100 eligible PRs and reduce disturbance and waiting.

The concrete trade-off is decided by the scenario:

- Ordinary test-adding suggestions: author noise and actionability matter; require concrete behavior and evidence.
- Confirmed requirement conflicts: keep recall and intent confirmation together, and do not by default demand a code rollback.
- High-consequence gaps: the cost of a miss is higher; list recall by tier, and do not let it be averaged away by many simple cases.
- "Covered / no problem" conclusions: a wrong assurance is more dangerous than keeping Unknown, and needs its own metric.
- Configuration/authentication failures: these belong to execution reliability and differ from the TP/FP of defect classification; model-quality reasons must not be used to cover up the inability to run.

F1 is the harmonic mean of P/R. F-beta=(1+beta²)PR/(beta²P+R); beta<1 favors precision, beta>1 favors recall. F0.5 can serve as an auxiliary comparison for ordinary advisory, and F2 for high-risk recall comparison; **this is not an industry-uniform standard, and cannot replace risk cost or coverage constraints.**

If continuous scores exist in the future, AP/PR curves can be reported; the current high/low has only a few operating points and cannot draw a seemingly fine-grained continuous performance curve. AP and trapezoid-interpolated PR-AUC are also not the same algorithm, so the implementation must be stated. [F-beta and AP](https://scikit-learn.org/stable/modules/model_evaluation.html#precision-recall-f-measure-metrics).

## 10. Retrieval Layer: MRR Is Very Useful, but Do Not Look at It Alone

For each query q, pre-label the required relevant set Gq:

| Metric | Definition / intuition | How this repo should use it |
|---|---|---|
| Recall@K | How much of Gq the top K deduplicated candidates recover | Separate code→req and req→code; also separate code and tests |
| Hit@K | At least one relevant result in the top K | Suited to a quick starting point; cannot be taken as set recall |
| MRR@K | Mean of the reciprocal rank of the first relevant result; counts 0 if there is no hit in the top K | Measures how quickly the correct location can be reached |
| MAP@K | Average the precision at the positions where relevant results appear, then average across queries | Multiple necessary locations; evaluates the ranking as a whole |
| NDCG@K | Assign gain by relevance grade and discount later results, divided by the ideal ranking | Distinguish key entry points, supporting helpers, and unrelated similar code |
| All-required@K | Proportion of queries for which the whole necessary evidence set is recovered | Especially important for multi-entry / cross-module behavior |
| Evidence-set completeness | Joint loading rate of the necessary requirements, implementations, tests, and dependencies | Retrieval hits that are not loaded into the model also lose value |

Example: a requirement must be implemented in three places, UI, CLI, and background job; the first candidate hits the UI, MRR=1; having found only the UI, Recall=1/3 and All-required=0. **A high MRR cannot prove the impact scope is complete.**

The unit of relevance should be a symbol or behavior location, to avoid one file with ten overlapping windows filling the top-K. K, empty queries, queries with no relevant items, tie ordering, and deduplication rules must all be fixed; same-named/similar modules in large repos need negative examples added.

Sources: [NIST first relevant rank](https://github.com/usnistgov/trec_eval/blob/main/m_recip_rank.c), [Stanford retrieval evaluation](https://nlp.stanford.edu/IR-book/html/htmledition/evaluation-of-ranked-retrieval-results-1.html), [NDCG](https://scikit-learn.org/stable/modules/generated/sklearn.metrics.ndcg_score.html).

## 11. Unknown, Downgrade, and Coverage: An Abstention Ledger Is Needed

We suggest making the "behavior oracle" and the "tool conclusion" an explicit matrix:

| Actual situation | Tool flags a gap | Tool claims protection | Tool Unknown / unhandled |
|---|---|---|---|
| A real gap exists | Valid finding | Wrong assurance | Not effectively detected in user effect; reason recorded separately |
| Normal or already protected | False positive | Correctly supported | Conservative abstention, may increase manual burden |

Report at least:

- scope_coverage: how many of all applicable behaviors entered the evaluable scope this round.
- evidence_complete_rate: how many obligations have the evidence needed for this round's judgement.
- decision_coverage: how many tasks with an oracle got a clear judgement, with Unknown listed separately.
- actionable_precision: how many of the results that truly require action are correct.
- delivered_recall: how many of all applicable oracle positives were effectively delivered.
- false_assurance_rate: of the results that explicitly claim "protected", how many actually lack protection.

The false_assurance_rate here is a product metric that this report suggests naming explicitly, and is not passed off as a generic standard name.

If abstentions grow, a risk–coverage trade-off should be shown; an abstention is neither a wrong covered nor automatically counted as correct. In the small-sample stage, first list the four-cell counts of the same batch of tasks before and after the gate, without rushing to complex AURC. Existing research also points out that summary metrics of different abstention curves have limitations, and an area must not be taken as the final answer. [Selective classification research](https://arxiv.org/abs/2407.01032).

## 12. MSE / MAE / MRE: When They Make Sense

For continuous true values yi and predictions yhat_i:

- MSE=mean((yhat_i-yi)²) penalizes large deviations more heavily; its unit is the square of the original unit.
- RMSE=sqrt(MSE) returns to the original unit such as seconds/dollars.
- MAE=mean(abs(yhat_i-yi)) is less sensitive to extreme errors.
- Relative error needs a definition agreed first; the signed mean((yhat-y)/y) cancels positive and negative, while taking absolute values blows up when y≈0.

An optional use for SpecGuard is future prediction of scan cost/duration; it is better to separately list the proportion of underestimates that cause budget/time-limit breaches and the tail error, rather than optimizing only the mean error. If a p95 resource prediction is needed, the target quantile should be evaluated, rather than treating the MSE of a mean model as a p95 guarantee.

Practices that are not suitable:

1. Arbitrarily encoding missing/weak/unknown/covered as 0/1/2/3 and then computing MSE: the encoding distance has no business meaning.
2. Comparing the MSE of "predicted finding count" with "author fix count" in place of precision/recall.
3. Computing MRE/MAPE on normal PRs whose true value is zero.
4. Looking only at average cost error and ignoring a single severe budget overrun.

Strictly speaking, the MSE of hard 0/1 predictions in binary classification is just the error rate; it does not automatically solve class imbalance or author cost. Sources: [MSE](https://scikit-learn.org/stable/modules/generated/sklearn.metrics.mean_squared_error.html), [MAPE boundary](https://scikit-learn.org/stable/modules/generated/sklearn.metrics.mean_absolute_percentage_error.html).

## 13. If Confidence Is to Be Calibrated, Which Loss to Use

Only when we explicitly predict "the probability p that this finding would be judged valid by independent labelling", and have reliable labels y∈{0,1}, do we have:

- Binary Brier score=mean((p-y)²), smaller is better.
- log loss=-mean(y log p+(1-y) log(1-p)), which penalizes confident but wrong probabilities heavily.

Brier can be understood as the probability version of squared error; but Brier/log loss are affected simultaneously by discrimination, calibration, and data uncertainty, so a low score does not necessarily mean better calibration. Reliability binning plots, sample sizes, and baseline predictions should be looked at together; a model's self-claimed 0.9 cannot be taken directly as ninety percent trustworthy.

The current high/low is a combination of category and rule downgrades, and BM25 is a retrieval ranking score; neither equals p. Do not force high=0.9, low=0.3 just in order to use Brier.

When probabilities are really needed in the future, validate the distribution by repository/type, hold out calibration training and evaluation, and output uncertainty intervals; ECE is sensitive to binning and sample size and cannot be relied on alone. At this stage, finishing independent blind labelling and a consistent actionable basis is more valuable than adding a probability field.

Sources: [Brier](https://scikit-learn.org/stable/modules/generated/sklearn.metrics.brier_score_loss.html), [log loss](https://scikit-learn.org/stable/modules/generated/sklearn.metrics.log_loss.html), [calibration curves and scoring limitations](https://scikit-learn.org/stable/modules/calibration.html).

## 14. For a Shift-Left Action, the Metrics That Should Really Be Valued

We recommend limiting the main panel to the following eight groups; the others are for locating causes, to avoid piling up an unmaintainable large dashboard.

| Priority | Metric | Denominator and judgement | Why it matters |
|---|---|---|---|
| P0 | Valid pre-merge interventions / 100 eligible PRs | All PRs that should be reviewed in the same cohort; deduplicated, valid, targeted fix and verification | Closest to the current product goal |
| P0 | Actionable precision + FP/100 PR | Each delivery channel the author actually receives; independent labelling | Protects attention and trust |
| P0 | End-to-end delivered recall | All applicable positives with an oracle, including execution failures and deferral losses | Prevents counting only when it succeeds |
| P0 | False-assurance rate | Behaviors that the tool explicitly claims are protected, verified by sampling/in full | Prevents Unknown from being beautified as safe |
| P0 | Unknown / incomplete evidence / scope not reached | Fixed denominator and concrete reason for each stage | See the cost of the conservative strategy clearly |
| P1 | Time to first valid feedback, pre-merge delivery rate | From push/event to durable publication; p50/p95; report failures separately | Feedback must arrive within the window for changes |
| P1 | Verified fix-through of confirmed valid findings | Same ID, targeted verification completed within the observation window | Go from comment to actual protection |
| P1 | Author burden and cost per valid intervention | Minutes to check false positives, duplicate feedback, cost of all retries | Findings must be worth handling |

The "valid intervention" here is a currently observable proxy metric, and is not directly called "avoided a production incident". We suggest recording: whether the author already knew, whether only docs were changed, whether the requirement intent was changed, whether a regression was added, whether it was proven that the error is caught by tests. An acceptable intent clarification also has value, and should be listed separately rather than passed off as a code defect fix.

testChanged/anchorTouched only indicate activity; a verified fix needs confirmation that it is related to the target behavior, using fail-before/pass-after, a targeted counterexample, or suitable manual acceptance where necessary. Record integration/e2e/manual evidence at the appropriate level, without forcing every item to be split into unit.

### 14.1 Looking at Each Metric With the Same Hypothetical Example

Suppose 100 eligible PRs have 10 applicable gaps after independent review: the model produces 6 correct candidates, and finally only 4 are validly delivered; 2 false positives are also delivered; among them 2 real gaps complete targeted fix and verification.

- raw candidate recall=6/10=60%, delivered recall=4/10=40%.
- actionable precision=4/(4+2)=66.7%, false-positive burden=2/100 PR.
- valid interventions=2/100 PR; if these 4 validly delivered ones have all reached the observation window, verified fix-through=2/4=50%.
- The loss of the remaining 6 gaps must continue to be attributed to the stages of retrieval, pack, model, downgrade, delivery, etc.; they cannot all be put down to "the model is not smart enough".

This is only a calculation example, not a measured value of this project. It shows that precision, recall, intervention, and fix conversion complement each other, and a high score on any one cannot replace the other links.

## 15. Choose Thresholds by Business Cost, Not by Believing in One Loss

A transparent decision model can be used to discuss trade-offs:

```text
Expected benefit of one prompt
  = P(valid) × P(effective action | valid) × action benefit
    - P(invalid) × false-positive handling cost
    - reading/waiting cost
    - model and execution cost
```

This is not an ROI measured this round; each term needs sample estimation. Findings with different consequences should have different costs, with weights agreed first by the product/maintainers, and not assigned for severity arbitrarily by the model.

A cost-weighted error can also be defined on an offline held-out set:

```text
L = C_FP × FP
  + C_FN × FN
  + C_false_assurance × false_assurance
  + C_unknown × unresolved
  + C_delay × delay
```

Double charging must be avoided: if an unresolved positive has already been counted in delivered FN, C_unknown only represents the extra manual handling cost and cannot be counted again as a loss from the same defect; all terms must share a unified unit, observation window, and deduplication identity.

A single total score still cannot replace hard constraints. An invalid citation must not get "protected", an identity/permission error must not leak data, and a run failure must not be disguised as normal; these should be guarded by deterministic checks and regressions.

## 16. How to Design Evaluation Experiments So That a Better Model Is Not Confused With a Better Metric

### 16.1 Three-Layer Evaluation Sets

1. **Deterministic regression**: protocols such as source, citation, status, context truncation, deduplication, and statistics; this round's M1–M7 are suitable for conversion into this kind of regression.
2. **Capability evaluation**: requirement drift with an independent oracle, deleted/weakened assertions, complex call chains, cross-language and long files. Positives, normal controls, and existing substitute tests are all needed.
3. **Real adoption**: pre-merge feedback, author actions, burden, verification within the observation window, and later rework.

The existing ten Kite positive seeds only answer the detection of known problems; with no clean controls, no real author adoption, and not covering all behaviors, overall precision or ROI cannot be estimated. A complex-repository capability set should include baseline-driven tests, DI, wrappers, generated code, unchanged consumers, and 1000+ line tail behavior.

### 16.2 Make Every Gate/Retrieval Change a Paired Comparison

Fix the target SHA, tool SHA, model, prompt, budget, execution resources, input scope, and oracle; declare the changed item separately. Run the old and new versions on the same tasks, and report new TP/FP, lost TP, corrected FP, and Unknown changes, rather than only comparing two overall percentages.

A retry across pushes is not a new independent sample; three variants of the same case, and multiple findings of the same PR, are also correlated. Cluster by base case/PR, and stratify cross-repo results by repository or use appropriate hierarchical estimation. The current PR-cluster bootstrap is the right direction; the independent Wilson interval for blind-labelled precision still needs to state the correlation limitation.

When humans label valid/invalid/unsure, hide the tool source and keep sufficient context; at least two reviewers should first work independently and then reconcile. Report the unsure proportion and possible upper and lower bounds separately, and do not heavily exclude it and then advertise a high precision.

Sources: [Anthropic statistics recommendations](https://www.anthropic.com/research/statistical-approach-to-model-evals), [agent eval design](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents).

### 16.3 For Repeated Runs, Look at pass@1 or pass@k

pass@k concerns at least one success in k attempts; consistency-type pass^k concerns whether every attempt of a repeated task succeeds. For an Action that usually runs only once per push, pass@1, the stability of valid feedback, and repeat noise are closer to the actual experience.

"Finally found it after five reruns" must not be treated as normal single-run recall; if the product really auto-retries / ensembles multiple results, all costs, time, and erroneous findings must be evaluated together. Two consecutive claims of a gap by the same model are only a stability signal, not independent ground-truth confirmation.

Resources, time limits, concurrency, and the network can also change evaluation; infrastructure errors are diagnosed separately on the one hand, and on the other enter the delivery loss at the user end. [pass metric explanation](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents), [infrastructure noise](https://www.anthropic.com/engineering/infrastructure-noise).

## 17. What Real Production Feedback Can and Cannot Tell

PRs without an alarm may still contain FN. Blind labelling only from published findings can estimate precision, not recall. To estimate recall, additional sampling of no-alarm/Unknown/skipped PRs for independent review is needed, or replay of defects fixed later.

The denominator of historical bug replay is limited to "gaps visible in the PR at the time and within SpecGuard's scope"; one cannot demand that a static test-adding Action find all production bugs. SZZ/change attribution is only a candidate tool, and cases such as refactors, mechanical moves, test fixes, and the original requirement being invisible need to be excluded.

DORA's current public model has five delivery metrics, including change lead time, deployment frequency, failed deployment recovery time, change fail rate, and deployment rework rate. They suit long-term outcomes and guardrails at the application/service level; a change in one team cannot be attributed directly to a particular Action, and comparing across different services by mixing them is also inadvisable. [DORA official description](https://dora.dev/guides/dora-metrics/).

For this project, nearer-term follow-up observations can first be: requirement deviations / verification gaps sent back by QA, related follow-up patches after merge, author handling minutes, and review waiting. To infer causal benefit, a control or random assignment and a sufficient observation window are needed; fixes that an agent wrote and reviewed itself are analyzed separately, and a personal account name is not used to conclude that it was human adoption.

## 18. Recommended Handling of the Existing validation-plan

The existing plan pre-registered continuation conditions such as precision ≥65%, fix-through ≥25% with lower bound >15%, merge-time increase ≤15%, and valid unique findings ≥40%, and shows insufficient data for insufficient samples. This is valuable discipline and should be kept.

But we suggest supplementing the definitions before the next new pilot begins:

- Whether the precision sampling includes summary-only, file-level, and actually actionable coverage rows.
- Whether A is the touched proxy metric or a verified fix, when the observation window closes; how not_observed / immature samples are handled.
- Whether P and A come from the same exposure cohort, and whether F2 is only an economic hypothesis or a joint result.
- The positional proximity of unique is only a coarse filter; two tools may point out the same problem at different locations, or different problems at the same location, so semantic labelling is needed.
- The roles of the time-merge baseline and the three-arm control; the existing 0/1/2 arms do not automatically provide a concurrent no-AI control.
- Identify bot and agent authors separately, to avoid agent samples entering the human adoption rate.
- Attach raw counts, effective samples, and intervals to every proportion; specify which changes require re-collecting data.

The existing minimums such as 30 labels are project pilot conditions, not a universally sufficient sample statistically. A distinction is needed between "can give a rough estimate" and "can identify a 2–3 percentage point improvement"; the latter usually needs a larger, sufficiently independent sample and a power analysis.

Basis: [current plan](https://github.com/Mira190/SpecGuard/blob/cb235b11f4234570f6506d0a278d786554b287d3/docs/validation-plan.md), [blind-labelling implementation](https://github.com/Mira190/SpecGuard/blob/cb235b11f4234570f6506d0a278d786554b287d3/eval/label-export.js#L75).

## 19. Minimal Implementable Metric Recording

There is no need to first bring in a large observability platform. First have a versioned ledger:

```json
{
  "schema": "proposal-1",
  "task_id": "stable-behaviour-and-revision",
  "repository": "owner/repo",
  "pr": 123,
  "base": "<sha>",
  "head": "<sha>",
  "tool_sha": "<sha>",
  "run_id": "<run>",
  "finding_id": "<stable-id>",
  "stage": {
    "oracle_scope": "in_scope",
    "retrieved": true,
    "packed": true,
    "raw_detected": true,
    "validated": true,
    "delivered": true
  },
  "delivery": {
    "channel": "summary",
    "actionability": "actionable",
    "posted_at": "<timestamp>"
  },
  "label": {
    "validity": "unsure",
    "provenance": "not_yet_adjudicated"
  },
  "resolution": {
    "anchor_touched": null,
    "verified_fix": null,
    "commit": null,
    "ci_run": null,
    "observed_until": "<timestamp>"
  }
}
```

This is a proposal, not the current Action schema. For online tasks with no oracle, do not fabricate oracle_scope or FN; both before and after the model, and the gate rules, keep auditable reasons.

Decompose the pipeline by the same batch of tasks:

```text
Applicable oracle positives
 → evidence found/retrieved
 → evidence loaded
 → model identifies
 → retained after validation/downgrade
 → actionable delivery
 → author confirms
 → targeted fix and verification
```

The conditional rate of each stage can diagnose bottlenecks; only when denominators are nested, the cohort is the same, and event definitions are consistent does the product of conditional rates equal the overall conversion. Average precision/recall/fix rates over different samples cannot be multiplied directly.

## 20. Suggested Concrete Order of Next Steps

| Order | Work | Acceptance method |
|---|---|---|
| 1 | Fix M1's actionable TP/FP asymmetry; keep both raw and delivered metric sets | Low-confidence Details from the actual renderer cannot raise delivered TP; actionable summary-only positives can still score |
| 2 | Unify the finding ledger, add blind labelling for summary-only and semantic duplicate verification | The same ID can connect exposure, label, outcome, and cost |
| 3 | Report location/semantic, conditional/end-to-end, scope/decision coverage together | Each of the M2–M5 situations can be clearly distinguished in the report |
| 4 | Build paired positive/negative samples and a downgrade ledger for #240/#241 | Report reduced FP, lost TP, and changes in Unknown and pack truncation |
| 5 | Turn #239's retrieval harness into a reviewable, version-pinned capability set | Both directions, MRR@K, Recall@K, All-required; cover value formats/long files/multiple entries |
| 6 | In the existing pilot plan, make joint valid+verified-fix and author burden explicit | Stop passing off touched or P×A as measured effective fixes |
| 7 | Validate incremental value with a real-PR control sample, then decide whether to expand scanning / hook up a calibration model | Limited sample, budget, and observation window agreed in advance |

This round did not directly fix product code, to avoid treating "whether the evaluation contract should change" as an implementation choice that has not been reviewed. The minimal useful engineering change is to unify the explicitly agreed delivered-metric basis and to solidify renderer-level counterexamples as regressions; there is no need to first introduce a training platform or a new error-function framework.

## 21. Scope and Limitations of This Round

- Re-checked the evaluation/tracking/retrieval/downgrade paths of the pinned version; the probes read and loaded 22 modules via Git and recorded the source-content SHA256; this is not an exhaustive audit of every feature in the whole repo.
- The 8 probes include one renderer comparison and cover 7 kinds of situations in total; among them M2/M3/M4 are contracts already declared in the docs, M6 is a conservative policy explicitly accepted, and M7 is a recorded follow-up, so not all are new bugs.
- No external model evaluation was re-run, the full content of the new scan artifacts was not obtained, and the latest real findings were not re-blind-labelled; there is no overall precision, recall, calibration error, or ROI that can be publicly claimed this round.
- The existing acceptance thresholds, product code, and GitHub state were not changed; the report, metrics dictionary, evidence, and reproducible probes were saved.
