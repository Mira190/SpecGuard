# Unknown unknown re-check after the new fixes

> **Disposition status (2026-10-17, main 45713a2):** The findings in this document have been re-checked. Fixed: U1–U4 (#224), U5 (#226), U6 (#225). Unfixed / to do: none. Line numbers and SHAs are as of when this document was written.

What this repo does: SpecGuard links the requirements, code, tests, and evidence of a PR/repository to expose gaps before merge. It also uses evaluations and weekly reports to judge whether these findings have value. This round assumes normal load is one PR or a multi-segment repository scan, and made no capacity judgment from production throughput data.

**Conclusion: 2 P1 boundary defects and 3 P2 forensic-semantics differences were confirmed, and 1 evaluation definition that needs to be made explicit was also found. The most worthwhile to fix first are DENY content re-entering the prompt through trace, and quota exhaustion after a partially successful scan still bypassing the new gate.**

This continues looking for interaction problems on top of the new fixes, and does not re-count defects fixed in the previous round. No product code was modified, nothing was merged, pushed, or branch-deleted, and no real model was called.

## Baseline: check local, remote, and uncommitted content at the same time

Dates are Sydney 2026-10-17; this round's remote records and probes are pinned to the versions below, with exact times in the companion JSON.

| Layer | Version used this round | How it was checked |
|---|---|---|
| Final remote integration main | `8415eae217a5c4eed3c1d46ccf9294b127fc97d2` | Re-checked at 22:50 UTC; #223 was merged at 22:39:36 UTC, and all six probe groups were re-run on the final version |
| Initial main / local cache | `fd8c62b877ecbc74ff704425cdd7593bbb68c28c` | Initial remote was consistent with origin/main; not the latest remote at wrap-up time |
| #223 fix head | `84475bad28af4f452f70ab4bbc779851cc36c094` | Local fix/deny-secret-diff matches the remote PR head, worktree unchanged; finally merged |
| Local-only commits | Reachability comparison of all local refs against main | 236 branches; after excluding eval, 8 branch heads not in main were identified one by one |
| Uncommitted content | 65 registered worktrees | 17 had status changes, 5 failed to read; the 5 new fix worktrees in the new round have no uncommitted changes |

"Which is the latest" cannot be judged by commit time alone: the initial main is the integration version, and #223 was at that time a separate fix line not yet merged, which does not contain all of main's fixes. At wrap-up the remote was read again, and after confirming #223 had been merged, the six probe groups were all switched to the final main; the problems still exist in the integration version that contains these new fixes.

The main directory is still at the old `b1aaf11`, with its README/research documents uncommitted; the old src was not directly required there as evidence for the new version. The initial probes loaded the specified commit via git show; for the final merge object, which is not yet available locally, the remote's full tree (548 blobs, not truncated) was read, and local objects were loaded by blob SHA. The only missing merged claude-api.js was read from GitHub and cached, with the Git blob SHA verified on load; no Git data was modified and no checkout was done for this.

In the initial local snapshot, the non-eval branches not yet in main relative to fd8c62b: codex/shift-left-rereview-2026-10-16, fix/deny-secret-diff, fix/rereview-batch1, fix/scan-part-size, fix/scan-state-address, gates/evidence, test/ccr-seeded, test/seeded-gaps-v7. Since #223 is finally merged, deny-secret-diff is no longer a feature awaiting merge; the local snapshot keeps the original time and comparison SHA. The commits of the old batch/state were also read and compared; having unique commits does not mean unique features remain, so the whole branch must not be merged back on that basis.

The commits of the local structured-reduced-reasons, eval-metric-integrity, and scan-issue-foreign-target are already in main's history, and the original two WIP groups have become fix commits. This round found no newer uncommitted implementation in the readable new fix worktrees; the 5 unreadable directories cannot support asserting that there is no new local work.

### Fixed items, explicitly removed from the current problem list

| New PR | Current status and evidence | What this round continues to check |
|---|---|---|
| #218 | Merged; cap/time separated | Whether the aggregate status also retains the reason |
| #219 | Merged; row-only FP, weekly reuses post's rules | Whether the adapter really retains all of Git's semantics |
| #220 | Merged; foreign issue, case handling | This round does not repeat the original cross-target matching problem |
| #221 | Merged; structured degraded, real guard control | Whether degraded data is consistent between display and evaluation |
| #222 | Merged; configuration-failure gate and error classification | Whether a partially successful multi-segment scan can still propagate a configuration failure |
| #223 | Initially open, merged at wrap-up; filters changed-file diffs | Whether other text entry points can still re-introduce DENY content |

The latest [#222 dogfood](https://github.com/Mira190/SpecGuard/actions/runs/38976247001/job/117226277852) and [#223 dogfood](https://github.com/Mira190/SpecGuard/actions/runs/38976743598/job/117227890968) have entered reduced review; the new PR bot summaries carry model/counts markers. The previous report's "latest summaries of 19 PRs show authentication failure" is an old snapshot and **can no longer be taken as the current state of this round's new runs**. But reduced, execution_complete, and full evidence support must still be looked at separately.

## Must fix

### 1. [P1] After a DENY file is excluded, its content can still enter the prompt through the requirement index (U5)

- **What this is:** #223 filters secret-like paths before generating the diff, to prevent sending the diff of files such as `.env` directly to the model; but trace is a separate, later corpus entry point.
- **Problem:** For a DENY-matched `.env.production.md`, when it is explicitly included via requirements_paths, the real trace.run still generates spec-files and requirements-index, and the synthetic content appears again in the real prompt.assemble. The filtering of the changed-file list did not become the common boundary of all inputs.
- **Fix:** Move the DENY predicate to a shared location with no engine dependency, and apply it also to trace's document discovery / corpus generation; confirm the source boundary one by one for pre-assembled text such as indices, candidates, and scan blocks. Do not add filtering only at packRead or the final file list.
- **If we skip it:** Users see "secret-like files not sent", but the model input may still contain text derived from that path; that the direct diff has become safe also cannot prove that the whole input is safe.

Locations: [collect.sh:108](https://github.com/Mira190/SpecGuard/blob/8415eae217a5c4eed3c1d46ccf9294b127fc97d2/src/collect.sh#L108), [trace.js:611](https://github.com/Mira190/SpecGuard/blob/8415eae217a5c4eed3c1d46ccf9294b127fc97d2/src/trace.js#L611), [trace.js:1027](https://github.com/Mira190/SpecGuard/blob/8415eae217a5c4eed3c1d46ccf9294b127fc97d2/src/trace.js#L1027), [prompt.js:119](https://github.com/Mira190/SpecGuard/blob/8415eae217a5c4eed3c1d46ccf9294b127fc97d2/src/prompt.js#L119).

Reproduction result: DENY.test(path)=true; ctx already has denied.txt, files.txt has only app.js, and trace still lists that document in spec-files; both the index and the final prompt contain `SYNTHETIC_NOT_A_REAL_SECRET_U5`. In the control group, with that path explicitly excluded, neither contains the marker.

Evidence scope: uses the real trace and prompt, with Git objects from a synthetic fixture; it is not a full collect.sh end-to-end run, and nothing was sent to a provider. It confirms the bypass where trace does not consume the DENY boundary, and does not mean a real secret leak was observed. Content detection for a secret renamed as an ordinary file is another limitation already acknowledged in the #223 review, and is not conflated with this item.

### 2. [P1] A multi-segment scan that "succeeds first, then runs out of quota" bypasses the #222 configuration-failure gate (U6)

- **What this is:** A scan is split into multiple API calls, and the successful parts should be kept; the #222 contract is that configuration errors such as auth/quota/model must visibly fail the job.
- **Problem:** In the real flow, the first segment returns a usable result and the second returns 402 billing_error; the adapter ends the overall engine as success and leaves the reason only as text in scan-parts; audit-post outputs incomplete, and the new gate exits 0, even with FAIL_ON_ERROR=true.
- **Fix:** Keep the successful findings, and at the same time propagate each segment's machine error category to the terminal state, so that configuration failure decides job health. Ordinary incomplete scope, fast-tier, deliberate budget stops, and transient failures still follow their own policies; do not turn every incomplete red.
- **If we skip it:** When the account runs out of quota midway through a scan, administrators still see only a green workflow; the same configuration problem keeps affecting later rotations, reproducing the phenomenon the new gate was meant to eliminate.

Locations: [claude-api.js:425](https://github.com/Mira190/SpecGuard/blob/8415eae217a5c4eed3c1d46ccf9294b127fc97d2/src/engines/claude-api.js#L425), [claude-api.js:442](https://github.com/Mira190/SpecGuard/blob/8415eae217a5c4eed3c1d46ccf9294b127fc97d2/src/engines/claude-api.js#L442), [audit-post.js:813](https://github.com/Mira190/SpecGuard/blob/8415eae217a5c4eed3c1d46ccf9294b127fc97d2/src/audit-post.js#L813), [fail-on-error.js:13](https://github.com/Mira190/SpecGuard/blob/8415eae217a5c4eed3c1d46ccf9294b127fc97d2/src/fail-on-error.js#L13).

This item went through the real scan-parts planner → API adapter → audit-post → fail-on-error; only the fetch responses are synthetic. The two calls were 200/402; the artifact kept the first segment, listed the second as not audited, status=incomplete, engine-error absent, gate=0. In the control group with STATUS=failed and engine-error=quota the gate is 1, showing that #222's overall failure path works and what is missing is the aggregate propagation.

## Should fix

### 3. [P2] When the API lacks a patch, "don't know whether it was changed" is counted as "not changed" (U1)

- **What this is:** #219 uses the apiGit adapter to call the real post.anchorTouched, and the weekly report uses it to judge whether a finding has been handled.
- **Problem:** When an API file object shows modified but has no patch, unified0(undefined) becomes an empty string and anchorTouched=false. The real meaning should be insufficient forensic data; on a thread a human has already resolved, this may miscount not_observed as dismissed.
- **Fix:** For a target file that needs a patch but has none, return unknown, and do not treat an empty result as a valid "unchanged". Check that the commit file list is complete, and likewise keep unknown for ranges not covered.
- **If we skip it:** The weekly report's addressed/dismissed denominator and the product value judgment get affected by the forensic gap, and the appearance of a successful API request will hide it.

Location: [weekly-report.js:54](https://github.com/Mira190/SpecGuard/blob/8415eae217a5c4eed3c1d46ccf9294b127fc97d2/eval/weekly-report.js#L54). A synthetic modified object without patch → false; the same object with a real replacement patch for line 7 → true. This item does not claim a missing patch has been observed on any live PR.

### 4. [P2] When a test file is renamed into an ordinary file, weekly misses the test change (U2)

- **What this is:** post.testsChanged's Git command uses --no-renames; moving or renaming away from a test file should also count as the tests having changed.
- **Problem:** apiGit's name-only branch returns only filename. For `{filename:'app.js', previous_filename:'app.test.js', status:'renamed'}` it returns tests_changed=false; the old test path is lost, inconsistent with the real call contract.
- **Fix:** The name-only adaptation should likewise reflect --no-renames, keep both new and old paths of a renamed object, and test renames in both directions. Do not fix only the renamed-away branch of the anchor.
- **If we skip it:** The same developer action may produce different "was it handled" judgments in the SpecGuard and Copilot weekly reports, affecting the comparison.

Location: [weekly-report.js:51](https://github.com/Mira190/SpecGuard/blob/8415eae217a5c4eed3c1d46ccf9294b127fc97d2/eval/weekly-report.js#L51). In the control group, directly modifying app.test.js is recognized as true. The #219 review's note that a renamed-away anchor returns null is correct; this item points to a different name-only/test branch, and does not misreport that already correct behavior as a defect.

### 5. [P2] Changing only whitespace is also counted by weekly as having changed the code that was pointed out (U3)

- **What this is:** post.anchorTouched's real Git command carries -w, to avoid counting pure whitespace formatting changes as fixes.
- **Problem:** apiGit receives -w but ignores it and converts the API patch directly into hunks. `return value;` → `return  value;` makes anchor_touched=true; an independent real git diff -w outputs empty for that change and exits 0.
- **Fix:** Keep the ignore-whitespace contract in the adapter; mark touched only when a non-whitespace change in the original range can be proven, and return unknown when it cannot be reliably converted. Do not claim the rule is fully equivalent merely by verifying that the U3/U0 hunk headers agree.
- **If we skip it:** Pure formatting commits can also raise the apparent addressed ratio, and the product value assessment is overestimated.

Location: [weekly-report.js:55](https://github.com/Mira190/SpecGuard/blob/8415eae217a5c4eed3c1d46ccf9294b127fc97d2/eval/weekly-report.js#L55). The non-whitespace replacement control still returns true. This item, together with 3 and 4, belongs to adapter semantic loss, and is suitable to handle together in one small PR rather than adding a second outcome rule set.

### 6. [P2, definition to be clarified] Hiding the low-confidence copy makes the same coverage row go from FP=1 to FP=0 (U4)

- **What this is:** #219/S10 started counting wrong weak/missing coverage rows as FP and using them for expect_clean; low-confidence findings are deliberately not counted as items requiring user action.
- **Problem:** The real buildSummary produces the same missing_test coverage row and adds a low-confidence copy in Details, and the real grade gives fp=0, clean_ok=true, pass=true; keeping only that row gives fp=1, clean_ok=false. The group representative selected the hidden item that does not take part in the actionable count, and rowFps in turn skips non-representative rows.
- **Fix:** First fix the statistics contract: if the coverage row itself is still an action request, the hidden mirror must not cancel the FP; if low confidence should exempt the row as a whole, carry that state explicitly and handle the row-only case consistently. Use this real producer/consumer comparison to pin down the contract.
- **If we skip it:** A change in presentation alone can improve expect_clean/FP, and it is hard to tell whether the model got better or the same request just got rendered differently.

Locations: [grade.js:49](https://github.com/Mira190/SpecGuard/blob/8415eae217a5c4eed3c1d46ccf9294b127fc97d2/eval/grade.js#L49), [grade.js:99](https://github.com/Mira190/SpecGuard/blob/8415eae217a5c4eed3c1d46ccf9294b127fc97d2/eval/grade.js#L99), [grade.js:136](https://github.com/Mira190/SpecGuard/blob/8415eae217a5c4eed3c1d46ccf9294b127fc97d2/eval/grade.js#L136).

What is confirmed here is behavior where the count depends on presentation; **"all low confidence should count as FP" is not taken as an established product requirement**. The #219 review already acknowledged that deduplication of nearby positions may underestimate FP; this item is a different interaction between a hidden item and the row representative, which needs to be clarified separately, and does not ask to overturn all deduplication rules.

## Why these problems easily slip past single-item fixes

| Local correctness after the fix | Cross-stage information still lost | This round's probe |
|---|---|---|
| The file list is already DENY | Index/candidate text generated from the same path has a separate entry | U5 |
| Overall failed/config turns red | Partial success aggregates away the later configuration error | U6 |
| post's judgment function is reused | The API adapter does not fully retain missing-data, rename, -w semantics | U1/U2/U3 |
| row-only already counts FP, mirror already deduplicated | Interaction between the hidden low-confidence representative and the actionable set | U4 |

The key is not to keep adding function-level tests, but to fix a few invariants at stage boundaries: a rejected source cannot re-enter through another route; partial success cannot erase run-health errors; unknown cannot become false; the same semantics do not change with transport and presentation form.

## Verification most worth doing next round

1. **Input source matrix:** use the same synthetic marker for changed diff, unmodified requirement documents, spec index, trace candidates, scan blocks, candidate tests, and rule files respectively, and test DENY and normal paths; first complete the real collect.sh integration regression for U5.
2. **Multi-segment failure matrix:** first/middle/last segment × auth/quota/model/rate/timeout; assert separately that valid results are kept, the error category, the not-audited range, and the job terminal state. Do not treat fast-tier reduced review as a configuration failure.
3. **Weekly report vs real Git:** compute the same change through local Git and through API objects; including whitespace, renames, missing patch, unavailable compare, deletion, merge commit. Assert that values and unknown are both consistent.
4. **producer/consumer evaluation:** hand buildSummary's real output to grade; the counting definitions for the same semantics in row-only, inline, visible item, and Details mirror should be explainable, and the known deduplication tolerance listed separately.
5. **Real model quality:** after authentication is restored, label precision/recall separately for seeded and real PRs. The new green CI and reduced review are run evidence, and cannot replace resolving the known k2 TODO or a real recall evaluation.

These are suggested next-round verifications; it is not claimed that this round completed the whole matrix.

## Replayable evidence and verification scope

- [Probe script](C:/Files/Projects/SpecGuard/docs/review-probes/unknown-unknown-2026-10-17.cjs): run `node docs/review-probes/unknown-unknown-2026-10-17.cjs` at the repo root; it loads local Git blobs and the companion remote tree / merged source cache, and replay does not touch the network.
- [Final source manifest](C:/Files/Projects/SpecGuard/docs/review-probes/latest-source-manifest-2026-10-17.json): remote pinned commit/tree, path → blob SHA, and the one verified source blob missing locally.
- [Six-group probe results](C:/Files/Projects/SpecGuard/docs/unknown-unknown-probe-results-2026-10-17.json): each group contains observed, control group, and evidence scope.
- [Local refs/worktree snapshot](C:/Files/Projects/SpecGuard/docs/unknown-unknown-local-snapshot-2026-10-17.json): contains 236 refs, 65 worktrees, and failure status, and does not treat unreadable directories as clean.
- [Remote PR/review/job evidence](C:/Files/Projects/SpecGuard/docs/unknown-unknown-remote-evidence-2026-10-17.json): new fix status, review discussions, and the new reduced review logs.

All six probe groups reproduced the behavior above and passed the corresponding control assertions; **"probe executed successfully" means the defect/difference was stably reproduced, not that the product tests are all green**. U6 uses the real multi-segment planner/adapter/post/gate; U5 uses the real trace/prompt and synthetic Git objects. All probes made 0 network calls, used no real secrets, and executed no target-repository code.

Verdict: first fill the two boundaries of input sources and multi-segment terminal state, then fix the consistency of the weekly report adapter; clarify the evaluation definition separately, to avoid mistaking "results look better" for an increase in shift-left value.

Not checked: the full test suite, a real provider, production regression frequency, and all input source combinations were not re-run; the state of 5 worktrees could not be read, and ignored files were not comprehensively inventoried. It has not been confirmed that a real secret leak occurred online, or that these differences have already affected any actual weekly report.
