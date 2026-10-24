# Re-review of the new Actions results: public PRs and evaluation validity

Date: 2026-10-17, Australia/Sydney. This round checked runs that already exist; it did not rerun the paid model, change the product, switch workspaces, or write comments to GitHub. The source code is pinned to main `47130d45c518a09cb475f1157469c4e2a30a40ec`.

## 1. Conclusions

**The results from the public PRs show that the new PR JSON path runs end to end and that combined can put several kinds of findings into one Summary; they cannot yet be used to accept the full review or the traceability goal.** The main limitations this report confirms are still the validity of the evaluation inputs, the exclusion of requirement documents, scoring isolation, and the completeness of the evidence.

The public scope of this round covers: the final CI and dogfood of #311; 21 isolated PRs among #307–#328; and the actual artifacts and commits of the two 21-case combined runs #331/#332. This public version records only observations about SpecGuard's public PRs; the raw context, diagnostic scripts, JSON and source snapshots stay local and are not published with this report. The file names mentioned in the text are labels for historical evidence, not public download or rerun entry points.

Look at the findings below first, rather than at the green ratio of Actions.

## 2. P1: requirement documents are excluded by the eval workflow, and a wrong test oracle even appears

The actual dogfood configuration claims "only eval-sandbox is a requirement source", yet it passes exclusion patterns such as `!docs/**` and `!README.md`. The real `trace.matchGlob()` supports matching at any depth, so these patterns also exclude the sandbox's own `docs/requirements.md`, `docs/specs/*.md` and README. Exclusion takes priority over include, so adding a sandbox include alone is not enough to correct it.

An independent reproduction with the actual function is saved in `isolated-worker/config-probe.json`; it is not guessed from the output:

| Requirement source | Pattern that excludes it |
|---|---|
| `eval-sandbox/tr19/docs/requirements.md` | `docs/**` |
| `eval-sandbox/tr22/docs/specs/signup.md` | `docs/**` |
| `eval-sandbox/tr23/docs/specs/http.md` | `docs/**` |
| `eval-sandbox/tr16/README.md` | `README.md` |

Two live examples are the most valuable:

- [#312 / tr19](https://github.com/Mira190/SpecGuard/pull/312): the actual commit is complete; the requirement changes the log retention period from 90 to 180 days, while the source and tests are still 90. The Action nevertheless reported Nothing to review, and recorded a complete/head marker. The cause is that the input configuration removed the requirement first, so this sample cannot be used to judge whether the model would recognise the drift once it saw the correct R; measured against the user's end-to-end goal, the target alert was indeed not delivered.
- [#316 / tr22](https://github.com/Mira190/SpecGuard/pull/316): the actual commit is complete and changes `age >= 18` to `age > 18`. The existing R2 says explicitly "at least 18 years old", yet it was excluded. The output reported only a boundary-test gap, and its skeleton suggests `assert.equal(canRegister(18), false)`, which would pin the wrong implementation as the test expectation. It also reminds the author to first confirm whether this behaviour change is intended, and that caveat is valuable; but under the explicit R2, false is still a wrong oracle, and this cannot count as a requirement-traceability hit.

This is not a blanket excuse for all models: a missing R and a wrong suggestion should be counted separately. The requirement-scope contract of the evaluation should be fixed, verifying item by item that the governing docs have entered spec-files/criteria, and then R→C, C→R and C=T≠R should be tested. Do not silently change the glob semantics for all users just for these evals.

## 3. P1: the combined scorer does not isolate entries of the new Summary, and false positives are copied many times over

The **actual commit inputs of both combined runs are complete**: in each run the head overlay of all 21/21 cases agrees with the Git blobs, and the deletions also check out. This is more reliable than the invalid trace inputs of the previous batch.

But after running `eval/grade.js.filterSummary(summary, casePrefix)`, a body entry of the new format:

```markdown
- Gap B [`eval-sandbox/b/b.js:1`](...) (inline limit reached) — ...
```

still remains in case A's Summary. The function only recognises the older `- **Missing test:** ...` form and some table rows, and does not cover the new unlabelled body list.

`filter-summary-probe.json` is a minimal counterexample with two bullets: after requesting prefix A, the parsed items still contain both A and B. Using the repo's canonical grader on the real artifacts:

| Run | canonical TP | canonical FP | canonical FN |
|---|---:|---:|---:|
| #331 | 4 | 168 | 20 |
| #332 | 4 | 147 | 20 |

**168/147 does not mean the model produced that much independent noise.** Summary entries of the other cases in the same batch are counted again and again in each case, so this precision cannot be taken as real model quality.

The raw results are kept in `combined-results.json`; the shipped grader and the original expected were not modified. A separate diagnostic inside the evaluation directory is also provided: it isolates by the actual current Markdown path and explicitly adopts the alternative policy that "an actionable Summary also counts as delivered", keeping the original kind/path/tolerance. The result is that for #331 the raw matchable leads are 14/24 and the actually actionable delivered ones are 10/24; for #332 they are 12/24 and 9/24 respectively. This is only a diagnostic with a stated definition; it cannot replace the original canonical score, and it has not removed the existing coverage/inline duplication or the limits of the semantic labelling, so its precision is not published as a product conclusion.

Fix first the grouping identity and the current Markdown parsing, add the invariant "after filtering, there are no items/coverage from other cases", and then recompute; there is no need to rerun the model for this.

## 4. P1: the new isolated batch still contains invalid constructions, and most runs are not the latest build

Comparing, case by case, the pinned base/head overlays, the actually committed blobs and the deletions gives:

- Of the 21 isolated PRs, 10 are constructed completely and 11 are invalid.
- Of the invalid ones, 9 have a zero diff and 2 committed only part of the expected overlay (tr2/tr5).
- Of the 17 trace cases only 6 have complete commits; complete does not mean the requirement configuration is also valid.
- Of the 8 runs that actually called the model and left counts, 1 is build `9224bdda240f` and 7 are `34dfad4db80c`; none includes the latest #311. One cannot assert that the latest engine was used just because the PR number is later.

The complete case-by-case table is in `isolated-worker/report.md` and `audit.json`. Positive cases with a zero diff are evaluation construction failures; the expected skip of x1/tr9 is a correct negative control and must not be counted as a failure along with them. A partial overlay cannot be judged valid merely by changed-files>0.

The positive evidence should also be kept: the three legal TypeScript cases #325/#326/#327 delivered 3, 3 and 1 inline test-gap or standard-violation findings respectively. They prove that these mechanisms work on that sample, but they do not prove the capability gain of the latest #311 or that end-to-end traceability has been achieved.

Next, before opening an eval PR and spending model quota, check the worktree contents, the actually staged blobs, the commit diff and the oracle quotations; pin the Action SHA/build rather than letting uses ./ change with the creation time of the sandbox base.

## 5. What combined actually proves

The two runs are [#331 / run 39025832897](https://github.com/Mira190/SpecGuard/actions/runs/39025832897) and [#332 / run 39026004319](https://github.com/Mira190/SpecGuard/actions/runs/39026004319). The actual build of both runs is `6c64d4887d04`, the same as main #311.

| Actual artifact | #331 | #332 |
|---|---:|---:|
| Input cases constructed completely | 21/21 | 21/21 |
| reviewable changed files | 41 | 41 |
| focus files | 20 (12 source + 8 tests) | same |
| raw model findings | 13 | 12 |
| raw obligations | 18 | 17 |
| inline comments | 3 | 3 |
| Final first-screen action items | 11 | 10 |
| Low-confidence findings in Details | 4 | 4 |
| Actual model | claude-haiku-5-5 | same |
| engine duration | 105.175 s | 92.460 s |
| Input tokens (including cache) | 66951 | 66951 |
| Output tokens | 25816 | 22981 |
| Reported cost of usage × price table | $0.01847504 | $0.01705754 |
| job / review status | success / incomplete | success / incomplete |

The cost comes from the artifact's usage and the price table in the code; it was not checked independently against the provider's bill. The two prompt hashes differ, so equal token totals do not prove that the inputs are byte-for-byte identical. These are two stress samples of a large PR on the same build, not 42 independent reviews, and not an A/B of old versus new versions.

Good examples that were actually delivered: network-error retry and the final failure path, unknown user violating the error requirement, two throw-string standard violations, pushing pure computation down into tests, and a deleted assertion. This shows that **a single Summary can carry the actionable findings that overflow the inline limit**. Counting only the 3 inline comments would understate delivery.

But the 21 cases were not all reviewed: k2, r2, rx2, rx3, t1–t4 and ts1–ts3 never entered focus. The deleted assertion in t4 still reached the report through the deterministic path, so it cannot be counted as the model having reviewed that case. The credit-floor finding of r1 is also inconsistent between the two runs; the four low-confidence gaps are mainly clip label, FIVEOFF, empty order and trim, and a title in the hidden counts must not be taken as an explicit fix request.

Under the diagnostic definition that explicitly lets "a Summary also count as delivered", each run delivered only 10 and 9 respectively of the 24 seeded expectations as actionable items. The scope that was not selected stays in the denominator; one cannot report only the hit rate of the selected scope.

`max_comments=30` also does not give the fast tier 30 inline comments: `REDUCED_INLINE=3` in `post.js` is a global policy. The focus should be on the final delivered set, confidence and evidence, not on the number of comments.

## 6. P2: the evaluation's own code and other cases pollute the test candidates and waste the evidence budget

In the real `pr332-ctx/test-candidates.txt`:

- The first four candidates for `l1/pricing.py` are SpecGuard's `eval/grade.test.js`, `src/collect.test.js`, `src/post.test.js` and `src/trace.test.js`; the real `l1/test_quote_api.py` ranks fifth.
- The fixture copy `eval/cases/...` is treated as an actual candidate test; k1 also matches SpecGuard's own tests.
- p1 matches the React tests of rx2/rx3, and s1/s2 match each other's config tests of the same name.

Both Summaries therefore report that many unrelated reviewer tests were cut; the small isolated runs have the same problem. The workflow's ignore is mainly used for the diff scope and is not the same as isolating candidate and pack evidence.

This drags small business modules into incomplete through retrieval noise, and also creates the conditions for "does the same literal imply it is already covered". The current artifacts directly prove candidate pollution and the loss of budget; they do not attribute every low-confidence downgrade, without evidence, to the same guard.

The eval scaffolding should be isolated from the business evidence, keeping the real sandbox tests; the same words across cases must not serve as proof of coverage. Merely enlarging the pack or lowering the confidence gate cannot replace this fix.

## 7. Live results of the new PR JSON path in #311

[Final CI run 39024966831](https://github.com/Mira190/SpecGuard/actions/runs/39024966831): 1442 tests, 1438 pass, 0 fail, 3 skipped, 1 TODO.

The new PR mode requests plain JSON directly, while scan still keeps the schema/fallback. The final artifacts of #311, #331 and #332 can all be parsed as findings.json; the latest dogfood log that was read does not contain the schema 400 fallback that previously appeared every time. It can be confirmed that the new success path runs end to end; this cannot be called a recovery of schema-enforced output, and it cannot be claimed that a stable improvement ratio has been measured.

#311's own dogfood is still incomplete, with 0 current findings, and its three historical findings are not_observed rather than verified fixes; the original text states explicitly that part of the engine/test context was not visible. "All tests green + zero current findings" cannot be used to conclude that all old problems are fixed.

## 8. Follow-up and the limits of the evidence

1. Before opening an eval PR or calling the model, verify the staged blobs, the commit diff, the complete overlay and the files actually collected as requirement files.
2. Fix the cross-case Summary filtering and the finding/coverage deduplication, and recompute the scores from the existing artifacts first.
3. Isolate the evaluation scaffolding, other cases and the reviewer's self-tests, and prefer keeping the source and direct tests of the target business.
4. Only after the Action build, the target snapshots and the oracle are pinned, run the model comparison of old versus new versions.

The above is a historical re-review conclusion for a pinned version; this public write-up did not re-verify the current mainline and did not fix the product or the evaluation logic. The raw context and the material related to other repositories stay local; this public version does not publish cross-repository run details, and does not claim that the full review, call-level traceability or QA benefit has been accepted.
