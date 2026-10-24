# SpecGuard Local and Remote Branch Review Report

> **Disposition status (2026-10-17, main 45713a2):** The findings in this document have been re-checked. Fixed: dogfood authentication failure masked by green (#222 makes configuration failures red, the secret has been reset); DENY diff entering the prompt (#223, #226); cross-target scan issue (#220); two WIPs (#221, #219); #218 has been merged. Unfixed / to do: branch/worktree cleanup (involves deletion, deferred); #199 is still open. Line numbers and SHAs are as of when this document was written.

> This document is an earlier branch snapshot, and some fixes have since been merged. For the re-check of the latest integrated version and local uncommitted content, see the [unknown unknown report after the new fixes](C:/Files/Projects/SpecGuard/docs/unknown-unknown-review-2026-10-17.md); do not take the to-be-merged / WIP statuses below as the current status.

> Latest remote evidence supplement: [GitHub Actions and actual PR run re-check](C:/Files/Projects/SpecGuard/docs/github-actions-pr-review-2026-10-17.md). Of the latest 50 runs, 47 succeeded, but among the latest summaries of the 22 PRs #197–#218, 19 had authentication failures and 3 did not call the model because all files were ignored. Remote tests on main: 1182 pass / 0 fail; #218 has 1183 pass / 0 fail, each with 3 skipped and 1 TODO in addition. The branch and open PR lists are unchanged; fixing dogfood authentication and terminal-state visibility should be prioritized in parallel, and a green workflow must not be taken as an effective model review.

What this repo does: SpecGuard checks requirements, code, tests, and evidence in PRs and repository scans, to help developers find omissions before merge. It also includes a GitHub Action, evaluation fixtures, coverage-evidence grading, and scan state management.

Load and goals: this report focuses on real PR/scan flows and evaluation trustworthiness; there is no measurement of production traffic, call volume, or cost, so capacity is not inferred. The most valuable work for shift left is: protect input boundaries, make missing evidence and run failures visible, raise evaluation trustworthiness, and then widen scan scope.

Review date: 2026-10-17, Australia/Sydney. Branch/PR metadata snapshot: 2026-10-16 21:39:20 UTC, i.e. Sydney October 17 08:39:20. At 21:51 UTC the remote main and all open PRs were read again, and the SHA and the open PR list were unchanged.

Remote baseline: [Mira190/SpecGuard](https://github.com/Mira190/SpecGuard), main = `bcddf784f70d4f5b5a854d2c75789bd33f1591aa`. This report only adds documents and lists, and performed no merge, deletion, push, branch switch, unlock, or worktree cleanup.

## 1. Decision summary

**Review and merge #218 first; protect the two uncommitted fixes; extract the two still-existing problems from old branches; update the old audit documents before merging them. Do not merge all ahead branches.**

| Item | Count/status | Decision |
|---|---:|---|
| Remote branches | 83 | 78 branch heads are already in main's history, including main itself |
| Remote cleanup candidates | 76 | main and feature/ccr-mode, which is still used as the base of open PR #9, are excluded; external references need checking |
| Remote branches not yet in main | 5 | #218, #199, 1 orphan report branch, 2 test branches with deliberately planted defects |
| Local branches | 230 | 150 branch heads are in main's history, 80 are not |
| First-batch local branch cleanup candidates | 95 | Already in main, not main, not occupied by a worktree; still need archiving and reference checks |
| Local eval branches | 72 | 36 head/base pairs, upstream all gone; archived as fixtures, not merged into the product |
| Registered worktrees | 62 | 38 clean, 19 with changes, 5 with status read failures |
| Worktree first-pass cleanup candidates | 35 | Clean, unlocked, HEAD in main; ignored files and users not yet inventoried |
| Uncommitted feature changes that must be protected | 2 groups | structured-reduced-reasons, eval-metric-integrity |

These sets overlap, and 76, 95, and 35 must not be added up and read as independently deletable objects. Here, "already in main" is judged by commit ancestry; having no ancestry also does not mean the feature is unimplemented, and still needs to be compared item by item.

## 2. Important findings of this review

### 1) [P1] The current working directory is too old, and continuing to judge "not yet fixed" here would create duplicate fixes

The current directory's branch is `fix/auto-lead-low-confidence`, HEAD `b1aaf113aae3ca69fcc70e7b9026130affa6c30f`, **101 commits** behind the remote main; local main `ee1c15812bae4315f39ce7d5bf1bf7511ac58553` is **105 commits** behind, with no ahead commits. These include merge commits and do not represent 105 independent features.

The main directory also has the original README modifications and four shift-left documents. This report cannot be taken directly as proof that the working directory has been upgraded to the latest main. Later, the existing changes should be saved first, a new documentation branch created on the latest main, and then migrated by actual differences; for the README, migrate only the needed paragraphs.

**Impact:** an old checkout will re-list fixed problems as P1, and merging old branches back wholesale may overwrite the new evidence grading, funnel, and configuration fixes. In future each audit should record the repo, base/head SHA, build version, and run status.

### 2) [P1] "Branch head merged" cannot protect uncommitted changes, and two worktrees cannot be cleaned

The HEAD of both `fix/structured-reduced-reasons` and `fix/eval-metric-integrity` equals the current main, but their working directories still have 2 and 4 modified files respectively. Deleting directories based solely on a merged-branch list would lose work that has really not entered commit history.

| Branch | Current uncommitted content | Suggestion |
|---|---|---|
| fix/structured-reduced-reasons | src/post.js, src/post.test.js; 31 lines added / 5 deleted, changing degradation reasons to structured ids | Complete the tests on top of the current main and submit a separate PR |
| fix/eval-metric-integrity | eval/grade.js, grade.test.js, weekly-report.js, weekly-report.test.js; 107 lines added / 9 deleted | Separate the evaluation counting from the weekly-report forensic semantics, then submit a PR; add Git scenario tests |

The first group reduces the fragility of parsing English explanatory text for `reducedReasons`; the second counts row-only weak/missing findings in false-positive and expect_clean judgments, and improves the weekly report's recognition of valid code changes. Both groups directly serve "does the report honestly reflect the evidence". They are currently **WIP, not completed fixes**.

### 3) [P1] #218's CI is green, but the actual dogfood did not complete the model review

[#218](https://github.com/Mira190/SpecGuard/pull/218)'s [test](https://github.com/Mira190/SpecGuard/actions/runs/38900709026/job/116971973683) and [dogfood](https://github.com/Mira190/SpecGuard/actions/runs/38900709026/job/116971973269) are both success; but the bot's [actual comment](https://github.com/Mira190/SpecGuard/pull/218#issuecomment-6215503834) explicitly shows the Anthropic API key was rejected and asks to check `llm_token`. So it proves the workflow ran to completion, and **does not prove the model completed this review**.

The comment also records the context pack as 8 files, 202KB, not including audit-collect.test.js and audit-units.test.js. This does not prove the product logic is wrong, but that dogfood run cannot be taken as evidence of complete model coverage.

It is suggested to separate `workflow_conclusion` from `review_status`: completed, skipped, auth_failed, provider_failed, partial. The run summary should show included/omitted files and reasons, the head SHA, the pack version, and the trace/run id. Advisory mode may keep the job green, but the dashboard/summary must show it as incomplete; this is an observability priority. When fixing the secret, only check configuration and permissions, and do not output the secret in logs or reports.

### 4) [P1] The old rereview branch still has an input-filtering fix that should be extracted

Current main's [collect.sh](https://github.com/Mira190/SpecGuard/blob/bcddf784f70d4f5b5a854d2c75789bd33f1591aa/src/collect.sh#L26) default ignore rules do not uniformly cover DENY paths such as `.env`; [prompt.js](https://github.com/Mira190/SpecGuard/blob/bcddf784f70d4f5b5a854d2c75789bd33f1591aa/src/prompt.js#L129) puts the already collected diff into the prompt. packRead's file rejection rule cannot automatically sanitize a diff assembled earlier.

This time a synthetic `.env` diff and the literal `SPECGUARD_SYNTHETIC_NOT_A_REAL_SECRET` were used to call prompt assemble, confirming that the literal remains in the prompt. No real secret was used, and no model or network was called. This result proves a gap exists in that assembly path, **and does not mean a real credential leak has been observed, nor is it a full PR end-to-end reproduction**.

`8921744` of `fix/rereview-batch1` introduced `src/deny-filter.js` and the related collection/assembly filtering, and is a fix source worth keeping. It is suggested to extract a minimal fix from the latest main: make the file list, raw/numbered diff, focus, and each engine's input share one filtering boundary, and test that ordinary business diffs are not wrongly removed. Do not merge the 8 old commits wholesale.

### 5) [P2] The old state branch still has a cross-target issue identification problem, and must not be wholly discarded just because #200 was merged

Current main's [findIssue](https://github.com/Mira190/SpecGuard/blob/bcddf784f70d4f5b5a854d2c75789bd33f1591aa/src/audit-post.js#L672) under the default empty title matches mainly by the common marker, and does not sufficiently distinguish scans of this repository from scans of external targets written to the same repository; [resolveIssueTarget](https://github.com/Mira190/SpecGuard/blob/bcddf784f70d4f5b5a854d2c75789bd33f1591aa/src/audit-post.js#L681) also uses a case-sensitive owner/repo comparison.

This time a fake GitHub client returned two issues from the same bot account carrying the common marker: first #1 of the external target org/other, then #2 of this target. The default call actually selected #1. The test did not touch the network or modify any issue. The impact is that wrong progress/state may be associated; the actual online frequency was not measured.

`fix/scan-state-address` already has a foreign-target/title guard and case handling. #200 merged the shared resolver and other fixes, but that is not enough to prove these remaining guards have entered main. It is suggested to migrate only the remaining differences, and cover own/foreign, same names with different case, explicit issue, state repository, and no-match scenarios.

## 3. What should be merged: ranked by value

| Order | Object | Suggested action | Completion conditions before merge |
|---:|---|---|---|
| 0 | Existing WIP, reports, probes, unreadable worktrees | Archive first, do not merge code | Verify committed content, untracked files, and ignored files separately |
| 1 | PR #218, fix/funnel-deterministic-split | Complete review first and then merge | Confirm required checks and human review, run cap/time and rendering assertions; if claiming the model review is complete, restore authentication and re-run first |
| 2 | The DENY-filtering residue of rereview-batch1 | Open a new small PR from the latest main | Do not introduce the old architecture; cover all diff paths that enter the model |
| 3 | Uncommitted changes of fix/structured-reduced-reasons | Complete and submit a small PR | Verify each degradation path produces an explicit id, keeping compatibility with the existing output |
| 4 | Uncommitted changes of fix/eval-metric-integrity | Complete and submit a PR | Regress FP, expect_clean, cross-group deduplication, deleted file / merge base / weekly-report scenarios |
| 5 | Remaining guards of scan-state-address | Extract a small PR from main | fake client positive and negative cases pass, avoiding reading/writing the wrong target state |
| 6 | PR #199, orphan rereview report, four local documents | Consolidate together after updating | Each finding is bound to a new SHA and status, without republishing problems already fixed |

Orders 2–5 are a suggested value priority and can proceed independently; this is not a ready-to-execute cherry-pick list. Item 2 in particular should first verify the existing filtering contract, to avoid introducing another inconsistent rule set in the name of "fixing".

### Specific judgment on PR #218

Head `5f2b1904e80cb3ca28059d1ec147b44f943b949d`, 1 ahead of main, 0 behind; the remote was at that time mergeable=true, mergeable_state=clean. Only 4 files, 21 lines added / 7 deleted.

It splits `not_reached` into two reasons, the inventory cap and the time budget, while keeping the total, and adds cap control, zero-budget, and report-rendering tests. The benefit is to avoid describing a deterministic scan quantity limit as a timeout, and to give later optimization the correct denominator. There is no reason to merge the whole batch of old audit branches back for this local fix.

The local targeted rendering test: 1 passed. The full combined tests involving temporary Git repositories were blocked by environment permissions, see section 8; this report does not claim the local full suite passed on this basis. Remote checks also cannot replace human review.

### PR #199: keep the research value, fix the document status first

[#199](https://github.com/Mira190/SpecGuard/pull/199) is based on the old `ee1c158` and has only one report of about 63 lines. The [existing review](https://github.com/Mira190/SpecGuard/pull/199#pullrequestreview-5547200106) already pointed out that several conclusions are outdated; afterwards #215, #216, #217 entered main, so it needs updating again.

Its test/dogfood are green, but the bot said all modified files were ignored and there was no actual review content. It is suited to "dated historical findings + latest disposition status", and is not suited to being merged as-is as the current unfixed list.

`codex/shift-left-rereview-2026-10-16` exists both locally and remotely, 1 ahead, 103 behind, with no PR. It adds about 330 lines of reports, overlapping with material already merged in #206/#207. It is suggested to extract the unique probes and reasoning, add the latest status and merge the documents; keep the rest as an archive, avoiding maintaining three mutually contradictory current conclusions.

## 4. Item-by-item disposition of local unmerged branches

Besides the 72 eval branches, there are 8 local branch heads not in main:

| Branch | ahead / behind main | Disposition |
|---|---:|---|
| fix/funnel-deterministic-split | 1 / 0 | #218, review and merge first |
| codex/shift-left-rereview-2026-10-16 | 1 / 103 | Update and consolidate the report, do not merge as-is |
| fix/rereview-batch1 | 8 / 105 | Extract fixes such as DENY that remain missing after review; mark the rest individually as superseded |
| fix/scan-part-size | 14 / 101 | Same name locally and remotely but diverged; archive first, compare residues, no overwriting the remote |
| fix/scan-state-address | 4 / 105 | Extract the foreign-target/title/case guards, do not merge back wholesale |
| gates/evidence | 2 / 315 | Not recommended to merge; record the basis of the historical experiment, then archive |
| test/ccr-seeded | 1 / 356 | Evaluation branch with deliberate defects, do not merge into the product |
| test/seeded-gaps-v7 | 2 / 359 | Same as above |

**fix/scan-part-size is the one most prone to mistakes.** Locally `c392b5b13eb732eaf744038af0c3a270c05f3dc2`, remotely `ea5554dac9bc5e226ae2b994236c35ba6d10639f`. The remote was merged along with #198, but local-only commits must not be deleted on that basis, and the local branch must not be force-pushed to the same-name remote. The local branch contains all 8 commits of rereview-batch1 and other old integration content, and should be treated as one group of residual fix sources and deduplicated.

`git cherry` shows batch1 has 8, scan-state has 4, scan-part-size has 13 non-equivalent patches; this only says the patches are not equivalent, not that the business goal of each patch is still unimplemented.

**gates/evidence should not be merged just because it has unique commits.** The "Rejected gates" in the current main design document already records that G1/G2/G3 were rejected and only the G4 skeleton direction was kept; no new measurement sufficient to overturn that decision was seen. Keeping the experiment history is worth more than restoring the old gates.

There is also an upstream configuration problem: `docs/audit-supplement` tracks `codex/full-repo-shift-left-audit-2026-10-16`, not the same-name remote; the local full-repo is in turn 63 commits behind its own remote. batch1/state etc. track origin/main, so ordinary ahead/behind hints cannot be used to infer "their own remote is not synced". The list gives the SHA, upstream, and distance from main separately.

## 5. Which recent work has entered main

| Merged PR | Direction covered | Meaning for branch cleanup |
|---|---|---|
| #197, #209 | Deterministic candidate fixes such as auto-lead/removed leads | Do not redo the old lead fixes; also check whether the uncommitted leads.js has only a line-ending state |
| #198, including the #202/#205 chain | pack sharding, cursor, and visibility | The old scan-part-size is no longer merged wholesale |
| #200 | Configuration, testpaths, shared state address logic | Extract only the remaining state-isolation guards |
| #201, #203, #208 | cut/invalid, requirement identity and AC | Identical targets in the old batch are first judged superseded |
| #204 | grading identity | The eval WIP focuses on remaining problems such as row-only false positives |
| #206, #207 | Whole-repo audit and supplementary documents | Do not merge multiple un-updated report copies again |
| #210, #211 | Honest skip, scan status | Keep explicit failure/skip semantics |
| #212, #213, #214 | Gherkin/test scope, pack quote, re-run and workflow inputs | Avoid old fixes overwriting new contracts |
| #216 | Verifiable unit funnel | #218 is a follow-up small change that splits the reasons |
| #217 | First-level dependencies and cover guard | The old report can no longer be written as having no dependency context at all |
| #215 | weak assertion evidence grading, check for rebutting counterexamples | The old description "no evidence verification at all" is outdated; still not equivalent to complete semantic proof |

The above is checked against PR merge records and commit reachability, and does not mean a new full acceptance of each capability. Old documents should use four statuses, "merged / partially covered / to be verified / still open", with current evidence attached.

## 6. What can enter the cleanup queue

### Remote: 76 conditional cleanup candidates

Of the 83 remote branches, 5 are not in main, main and feature/ccr-mode are also kept, and the remaining 76 can enter the queue. All names and SHAs are in the branch CSV; filter by `remote-cleanup-candidate`.

Deleting purely by merged status is not allowed, because this repository provides a GitHub Action and other repositories may use `Mira190/SpecGuard@branch`. This time other repositories' consumers were not scanned comprehensively, and it was not proven that these references do not exist. Before cleanup, check the organization's workflows/reusable workflows, documents, and external consumers, and migrate to a maintained version or a pinned SHA; confirm no open PR uses the branch as base, archive the current SHA, and then delete the specific branch.

Although `feature/ccr-mode` is already in main, it is still the base of open #9, so it does not enter the queue for now. The repository currently has `delete_branch_on_merge=false`; in the future, after the version-branch / consumption conventions are confirmed, automatic deletion of ordinary PR heads can be considered to avoid accumulating again. Version branches cannot be treated as ordinary temporary branches.

### Local: 95 merged branches not occupied by a worktree are queued first

150 local merged branches = main 1 + non-main without worktree 95 + with worktree 54. The 95 can be handled first after archiving and reference checks, with no need to rebuild PRs just to "preserve history".

There are also 15 `m数字` (m followed by digits) integration branches and 43 `worktree-agent-*` placeholder branches, whose heads are all in main; they are not 58 pieces of product features awaiting merge. But the worktrees occupying them must be resolved first, and the occupation must not be bypassed by force-deleting.

### 72 eval branches and two seeded PRs: not part of the product backlog to be merged

The 72 `eval/*` branches form 36 head/base pairs, all with upstream gone, and no branch head is in main. It is suggested to generate a fixture manifest: head/base SHA, PR, scenario label, expected findings, the model/prompt version used, and the replay command; save the Git objects before deleting local refs. Before deleting branches, ensure offline evaluation can still be replayed by SHA.

The sandboxes of [#8](https://github.com/Mira190/SpecGuard/pull/8) and [#9](https://github.com/Mira190/SpecGuard/pull/9) are evaluation inputs with deliberately planted defects. Keep them and label them explicitly when needed; when not needed, the PRs can be closed and archived. **Defective code should not be merged into main just to reduce the number of open PRs.** This round closed no PR.

## 7. Worktree risks and cleanup order

| Status | Count | Disposition |
|---|---:|---|
| Clean, unlocked, HEAD already in main | 35 | Can be archived/removed after checking ignored files and ownership |
| Clean but locked | 2 | Keep, handle after verifying the user |
| Clean but not merged | 1 | The #218 worktree, evaluate after merge |
| With changes | 19 | Save by category, must not be bulk-deleted |
| status read failure | 5 | Restore readability and inspect first, cannot be treated as a clean directory |

The 19 directories with changes include: 1 main directory, two feature WIP groups, 1 leads.js state difference, 4 probe/log directories, 11 historical scratch directories.

The leads.js of `fix/drift-rubric-leads` shows modified, but numstat shows no content difference, with an LF/CRLF hint; for now it can only be determined that the line-ending / index state needs checking, and it cannot be claimed that another functional fix exists. The 4 probe/log directories have untracked scripts, JSON, and logs, and the audit evidence should be archived first.

The 11 historical scratchpads (adopt, crlffix, disc, docs2, gates, harden, lean, met, pd, skillv2, stale) each have 341–367 tracked files deleted and no untracked files; their HEADs are all already in main. The form looks more like old temporary directories having been partly cleaned, **not a large-scale business deletion that should be merged into main**. Handle the registration relationships after keeping the verification record.

The locked directories are `agent-a30f13df4363ec8f9` and `agent-a72b7f7bbeeef3abe`, and the lock records both mention PID 8384. This time a process lookup did not find that PID, but that is not enough to unlock automatically or to conclude there is no user.

The following 5 worktree directories still exist, and `git status` returns `this operation must be run in a work tree`:

- C:/Files/Projects/SpecGuard-wt/batch1
- C:/Files/Projects/SpecGuard-wt/scan
- C:/Files/Projects/SpecGuard-wt/state
- <local-user-dir>/.codex/worktrees/critical-shift-left-review/SpecGuard
- <local-user-dir>/.codex/worktrees/shift-left-rereview-2026-10-15/SpecGuard

Their Git configuration was not modified this time. The common gitdir, worktree config, and directory bindings should be checked separately, and re-inventoried once readable; the cause of the error is not fully determined, so they cannot be labelled useless directories.

### Suggested actual cleanup process

1. Pin this report's SHA list, then re-read the live main, branch heads, and open PRs; reclassify if anything changed.
2. First save the commit objects, then separately save the binary diffs of staged/unstaged changes, untracked files, and the ignored files that are needed. A Git bundle saves only commits and refs and **does not save working-directory changes**; a stash count of 0 also does not mean there is no WIP.
3. Create explicit commits/PRs for the two valuable WIPs; for the residual fixes of old branches, create "source SHA → new PR → verification result" records.
4. Complete #218 and the document consolidation; explicitly keep or archive seeded/eval, and do not merge them into main.
5. Handle the 35 worktree candidates first, verifying the directory's absolute path, ownership, and ignored data, and remove them one by one; locked, dirty, and read-failure directories are handled separately.
6. Then handle local branches and remote ordinary PR branches. Before each deletion compare the current head SHA with the list, and keep a `branch → SHA → PR → archive` ledger.
7. Finally refresh the tracking information, re-check open PR bases and evaluation replay; do not use whole-directory recursive force-deletion, global force delete, or a blanket `git clean` in place of classification.

This round performed none of the write operations above; the cleanup candidates are not a verified whitelist that can be deleted unconditionally.

## 8. Verification, evidence, and limitations

This time 83 live remote branches, 4 open PRs, and 212 closed PRs were read, 216 PR records in total; compared against 230 local branches, 62 registered worktrees, and cached remote SHAs. All 83 remote heads are identical to the cache, so this round's ancestry analysis did not use known stale remote refs and did not run fetch.

| Check | Result | What it can prove |
|---|---|---|
| #218 remote test/dogfood | success / success | workflow check results; that the model review did not complete is in the comment |
| main remote test raw log (read later) | 1182 pass, 0 fail, 3 skipped, 1 TODO | Supplements the remote deterministic test evidence of current main; the k2 false positive in the TODO is unresolved |
| #218 remote test raw log (read later) | 1183 pass, 0 fail, 3 skipped, 1 TODO | Supplies the remote test evidence when local permissions were blocked; does not mean the model review succeeded |
| #199 remote test/dogfood | success / success | The document did not enter the actual model review scope |
| #218 funnel rendering targeted test | 1 pass, 0 fail | Targeted behavior of cap/time funnel display |
| structured-reduced-reasons targeted test | 1 pass, 0 fail | The new cover-guard degradation reason scenario |
| eval grade + weekly-report combined | 40 items, 39 pass, 1 fail | The failure was a permission problem writing .git/config in a temporary git init; cannot claim the full suite passed or conclude product logic failed |
| audit-units/audit-code combined | No valid full verification completed | Initialization of multiple temporary Git repositories was likewise limited by permissions |
| Synthetic DENY prompt probe | The synthetic marker still enters the prompt | A local assembly-path boundary problem, no real secret / model call |
| fake-client issue selection probe | Selected foreign-target #1 | Default matching isolation insufficient, no online issue modified |

This was a branch integration and cleanup review, with code checks and probes on key residual differences, and not a new complete security audit of every path in main. The runs of all organization-wide consumers, ignored files, actual secret configuration, production traffic, or all historical fixtures were not verified; the uncommitted content of the 5 worktrees is still undeterminable. Branch protection exists, but this report does not claim to have fully audited all rulesets / required approval policies.

Part of the metadata of the earlier Kite Actions audit artifacts was not obtained, and a terminal read was not executed earlier because of the auto-approval service usage limit; this report does not treat unread artifacts or old summaries as evidence. The current suggestions are based mainly on SpecGuard's live PR/branch information, bot comments, local commits, and probes.

## 9. Companion full lists

- [313-row local/remote branch disposition list](C:/Files/Projects/SpecGuard/docs/branch-review-inventory-2026-10-17.csv): 230 local + 83 remote; with SHA, PR, ancestry, upstream, worktree, and suggestions.
- [62-row worktree disposition list](C:/Files/Projects/SpecGuard/docs/worktree-review-inventory-2026-10-17.csv): status, lock, read error, path, and protection requirements.
- [Evidence snapshot JSON](C:/Files/Projects/SpecGuard/docs/branch-review-evidence-2026-10-17.json): PR metadata, check links, branch relationships, and a working-directory status summary. For large batches of deletion status only samples and the full count are kept.

Verdict: the repository has recently completed a large number of key fixes, and the main risk has shifted from "has it been fixed" to "have the latest fixes been actually verified, will uncommitted work be lost, and will old branches bring the old implementation back". Merge #218 first, extract the input-filtering / state-isolation residues, complete the structured degradation and evaluation WIPs, and finally clean up according to the evidence; this is better for the actual value of shift left than bulk merging back all old branches.
