# Validation plan: prove or disprove SpecGuard on your own repos in 2 to 4 weeks

Goal: replace the unknowns (human fix rate, precision, time-to-merge, overlap with native Copilot review) with measurements from your repos. Everything below is read-only analysis plus one workflow file. Nothing here changes what SpecGuard posts.

Design: every PR gets exactly one of three setups, so nobody goes without review and the authors, repos and PR template are the same across arms. The arm is `HMAC-SHA256(salt, PR number)`, first 4 bytes as an unsigned integer, mod 3, with the salt in the repository secret `SPECGUARD_ARM_SALT`. Authors cannot compute it, so they cannot predict an arm BEFORE opening a PR. Salting does not stop re-rolls: an author can open a PR, see the `review-arm:N` label, close and reopen it, or open a new PR from the same branch, until the arm suits them. The arms are therefore not tamper-proof: the protection against re-rolls and label tampering depends on the weekly-report checks below (weekly-report enforces it (pending): checks on branch feat/escaped-defect-outcome, which must merge first). Rules:

- Analysis is intention-to-treat: every PR counts in the arm it was FIRST assigned (the arm re-derived from the salt after the trial, not the current label), closed and unmerged PRs included.
- Flag (a) more than one PR per `headRefName`, and (b) closed-and-reopened PRs, and report the results with and without the flagged PRs.
- A label that differs from the re-derived arm is a tampering flag.

Reveal the salt after the trial so anyone can re-derive the arms (`SPECGUARD_ARM_SALT=... node eval/assign.js N`). Without the secret the workflow's arm job FAILS with an error (no fallback to PR number mod 3: that is predictable). The unsalted mod 3 in `eval/assign.js` exists only to re-derive the arms of older trials and for back-compat tests.

Who is in the study: the arm job's `if:` skips draft PRs, fork PRs and bot PRs, and the other jobs need it, so those PRs are skipped, not failed, and the missing-salt failure can only hit a same-repo, non-draft PR opened by a person, which is exactly a study PR (`eval/assign.test.js` checks the three exclusions in the workflow). A fork PR's token is read-only, so no `review-arm:excluded` label can be written there. Instead the exclusion is by design and not random: fork, bot and draft-only PRs get no arm and are no part of the comparison, and the report must count them (how many PRs were skipped and why) so a reader sees the study population (weekly-report enforces it (pending, branch feat/escaped-defect-outcome)).

| Arm | Review |
|---|---|
| 0 | SpecGuard only |
| 1 | native Copilot code review only, plus a shadow SpecGuard run that posts nothing |
| 2 | both |

The shadow run is the counterfactual for arm 1: it keeps what SpecGuard would have said (the `specguard-ctx` artifact, see the workflow header), so later escaped defects on arm 1 PRs can be matched against SpecGuard's findings. Costs and caveats: the shadow costs SpecGuard credits on arm 1 too; its job summary is visible in the Actions tab (a small contamination risk: do not point authors to it); the artifact is kept 90 days, but escapes are read 8 to 12 weeks AFTER the trial and the trial runs up to 4 weeks, so an early PR's artifact can be about 16 weeks (about 112 days) old by then; the weekly report caches the shadow findings every week, and that cache is why it still works; the artifact holds the diff and raw model output, which anyone with repo read access can download (on a private repo they already have the code).

The no-AI baseline is the 4 weeks before the trial (confounded by season and staffing; say so when you quote it).

## Step 1: days 1-2, SZZ replay of the last 50 bugs (falsifier F5)

Needs a clone of the repo and `gh` logged in.

```sh
# 1. Mine fix commits and the PRs that introduced the bugs (last ~6 months of QA/prod fixes). Review the file: set confirmed/scope by hand.
node eval/szz.js mine --repo ../my-repo --since 2026-04-01 --gh-repo ORG/my-repo --label-scan --max 50 --out eval/replay/my-repo.json
# 2. For each confirmed, in-scope pair (rubric: eval/replay/README.md), prepare a replay with the PR's ORIGINAL title and body.
node eval/replay.js prepare --repo ../my-repo --base <parent-of-introducing-pr> --head <introducing-pr-head> --out ../replay --id bug01 --title "<title>" --body "<body>" --trace auto --shared
# 3. Give ../replay/bug01/prompt.md to a model your company approves (Copilot CLI, Claude); save its JSON answer as ../replay/bug01/ctx/findings.json
# 4. Post it through the real post.js against a fake GitHub and read the counts
node eval/replay.js finish --id bug01,bug02 --out ../replay
```

Then grade each replay against the later fix (`direct`, `indirect`, `miss`, rubric in `eval/replay/README.md`). Report two numbers: the share of the 50 bugs that were PR-time visible test gaps or requirement mismatches, and the share of those SpecGuard flagged. Fewer than about 10% visible, or under a third flagged: F5 fires, stop before running the trial. Below 30 in-scope bugs report counts only. Public repos can be in the model's training data; private results are the headline.

## Step 2: day 3, install the workflow and run a canary

1. Copy `docs/validation-workflow.example.yml` to `.github/workflows/specguard-validation.yml`. Replace `<full-commit-sha>` with a full SpecGuard commit SHA (in both SpecGuard steps). Create the repository secret `SPECGUARD_ARM_SALT` (a long random string, kept private until the trial ends). Without it the arm job fails on every PR, by design: check that the canary fails with "SPECGUARD_ARM_SALT is not set" before you add the secret. Remove any other SpecGuard workflow. Turn off automatic Copilot review for the repo, org and your own settings, otherwise every PR is arm 2.
2. Requesting the Copilot review from Actions is the one unverified part (see the file header). Open canary PRs until one lands in arm 1 (the `review-arm:1` label; the arm job log shows it) and look at the `copilot` job and the `shadow` job (its run must have an artifact `specguard-ctx-<PR>-<attempt>`). If it passes and Copilot appears as a reviewer, go on. If it fails: add the repo secret `COPILOT_REVIEW_TOKEN` (fine-grained PAT of a Copilot-licensed user, Pull requests: write) and retry. If the API path stays closed, use the two-arm fallback in the file header (ruleset keeps Copilot on for every PR; the workflow varies only SpecGuard; you learn the added value of SpecGuard, not a head-to-head).
3. Also check an arm 0 and an arm 2 canary: the `review-arm:N` label is set and SpecGuard posts (on arm 1 it must post nothing). PRs where the Copilot request failed get the label `copilot-request-failed` and are excluded by the report.
4. Run for 2 to 4 weeks. Target at about 300 PRs per month: 100 PRs per arm in 4 weeks. With fewer than 30 PRs per arm the report only gives counts.

## Step 3: every week

```sh
node eval/weekly-report.js --repo ORG/my-repo --since 2026-10-19 --baseline-since 2026-09-21 --baseline-until 2026-10-18
node eval/weekly-report.js --repo ORG/my-repo --since 2026-10-19 --json > week2.json    # for a spreadsheet
node eval/aggregate-counts.js --repo ORG/my-repo        # SpecGuard-only fix-through, same numbers as the report's SpecGuard row
```

Always use the same `--since` (trial start) so the numbers are cumulative. The report states "insufficient data" until the sample-size targets below are met.

## Step 4: labelling (weeks 2 and 4)

```sh
node eval/label-export.js --repo ORG/my-repo --since 2026-10-19 --sample 100 --seed 1 --out labels.csv
# two senior reviewers each get a copy and fill their own column (label_a / label_b: valid | invalid | unsure) and notes, independently, without looking at which tool wrote a finding
# afterwards each also fills guess_tool_a / guess_tool_b (specguard | copilot | blank = no idea) for every row: the blinding check
node eval/label-export.js  --repo ORG/my-repo --since 2026-10-19 --import labels-both.csv   # 1: prints alpha per tool and overall, unsure rates, blinding; stops on a failed gate
# agreement passed: reconcile disagreements by discussion into the label column of the same file, then
node eval/label-export.js  --repo ORG/my-repo --since 2026-10-19 --import labels-done.csv   # 2: precision per tool only
node eval/weekly-report.js --repo ORG/my-repo --since 2026-10-19 --labels labels-done.csv
```

- 100 doubly labelled findings per tool is the minimum for a decision (`--sample 100` is the default). Why 100: `node eval/alpha-power.js` simulates two labellers (valid prevalence 25%, 200 trials per cell, seed 1) against the gate. Share of trials that reach decision grade:

  | Raw agreement (true alpha) | n=30 | n=60 | n=100 | n=150 | n=200 |
  |---|---|---|---|---|---|
  | 95% (about 0.87) | 44% | 61% | 82% | 94% | 98% |
  | 90% (about 0.75) | 18% | 14% | 21% | 23% | 22% |

  Two good labellers (95%) fail the gate more often than not below about 60 findings, so 30 is too few; two mediocre labellers (90%) pass about one time in five at any n (a limit of a 200-trial gate, not of n), so a pass is not proof, a fail is informative. Fewer than 100 doubly labelled findings in a scope is therefore "tentative, no decision" whatever the alpha. A smaller sample can still give a descriptive precision with the Wilson interval (the report's own floor is 30 labelled), not a decision. If less than 100 findings exist per tool, label all of them and say so.
- Bootstrap draws in which the resample has no variation have no alpha and are dropped; at low prevalence this biases the interval. The import prints the share of dropped draws, and more than 5% makes that scope "tentative, no decision". The tool name is hidden and rows are shuffled by `--seed`. Keep the same seed and window for the import, because the ids are hashes of the finding (a different window gives "ids matched no finding").
- Label `valid` = a real gap or bug that a reviewer would want fixed on this PR. `invalid` = wrong, already covered, or noise. `unsure` is reported but not counted.
- Agreement before reconciling: the import prints Krippendorff's alpha (nominal) over valid and invalid, PER TOOL (SpecGuard and Copilot separately) and overall, each with a bootstrap 95% interval (findings resampled, 1000 draws, fixed seed), the share labelled valid (prevalence) and each labeller's unsure rate. `unsure` and blank are treated as missing, and a finding with fewer than two valid or invalid labels does not count.
  - alpha >= 0.800, bootstrap lower bound >= 0.667, at least 100 doubly labelled findings and at most 5% dropped bootstrap draws, in a scope: decision grade for that scope (0.800 is Krippendorff's threshold for drawing conclusions). The import checks every scope; `eval/label-export.js` `agreement()` is the single implementation and `eval/weekly-report.js` calls it. No Step 6 rule uses Copilot precision, so the SpecGuard scope gates the precision rules; the Copilot and overall scopes only gate comparison text.
  - alpha between 0.667 and 0.800, or a lower bound below 0.667: "TENTATIVE, NO DECISION". Precision is printed but is not evidence for Step 6.
  - alpha below 0.667 in any scope (also undefined when every label is the same): "labels not reliable: alpha=X < 0.667, revise the labelling guide and relabel", no precision.
  - Either labeller's unsure rate above 20%: refused (the guide is too vague; unsure removes the hard cases from alpha and would flatter it).
  Only after the gate passes do the reviewers reconcile disagreements by discussion into the `label` column of one file; precision comes from that column. An old file with only `label` still imports but has no agreement check, so it cannot support the decision in Step 6.
- Blinding is not perfect. The export strips markdown bold and headers, HTML comments, links, tool names and leading labels such as "Gap:" or "Suggestion:", but SpecGuard's comment format and style stay recognisable. So the labellers guess the tool (`guess_tool_a` / `guess_tool_b`) and the import reports, per labeller, the share of correct guesses against 50% (with a 95% interval) and a Bang blinding index (0 = blind, 1 = fully unblinded). If the interval lower bound is above 50% the import says NOT BLIND, and precision must be quoted with that caveat. Residual risk: even when guesses are near 50%, style can still sway a judgement; it cannot be removed, only measured.
- The `link` column opens the PR files page, which shows who wrote each comment: label from the CSV text and open the link only when the text is not enough.

## Step 5: read the numbers

| Number | Meaning | Caveat |
|---|---|---|
| Arm of a PR | the arm first assigned, re-derived from the salt: intention-to-treat | every PR counts in that arm, closed and unmerged included. Flag more than one PR per `headRefName` and closed-and-reopened PRs; report with and without them. A label that differs from the re-derived arm is a tampering flag. weekly-report enforces it (pending, branch feat/escaped-defect-outcome merges first) |
| Findings/PR | volume the developer must read | SpecGuard counts inline comments and summary-only findings (the sticky summary's counts `sum`, tracked from 2026-10-17; earlier counts carry none). The report splits them by delivery channel |
| Fix-through A (addressed / all outcomes) | share of findings where the flagged lines or a test file changed later | Not proof of a fix. Read at the latest run, not at merge. Copilot A uses the same rule from thread state; "dismissed" means a human resolved it with nothing changed. Re-raised findings under a new fingerprint can inflate SpecGuard's `open`/`addressed` |
| Cluster bootstrap interval | the honest interval: PRs are resampled, not findings | the Wilson interval assumes independent findings and is too narrow |
| Blind precision | valid / (valid + invalid) from labels, Wilson interval | needs 30 labelled per tool |
| Time-to-merge median / p75 | creation to merge, human PRs only | at 50 PRs per arm only about a 2x difference is detectable: a guardrail, not a headline |
| Credits/PR | SpecGuard credits of the last run per PR (1 credit = $0.01) | not summed over pushes; runner minutes and native Copilot cost come from the Actions billing page and the Copilot usage report |
| Overlap (arm 2) | SpecGuard findings with a Copilot finding on the same file within 3 lines, and the reverse | location overlap only; the labelled "unique valid" share is the real test |

What A measures, and how P and A combine:

- A is a touched proxy: the flagged lines or a test file changed after the comment. It is not a verified fix.
- P (blind precision) and A must come from the same exposure cohort: the same findings, joined by the same finding id. Summary-only findings are now in the blind-label sample as well as in fix-through. Each is labelled on its recorded title; the sheet does not say how a finding was delivered, and entries from older counts with no title are left out and counted.
- F2's P × A is an economic assumption, not a measured joint rate: two marginals cannot give the joint (50 valid and 50 invalid findings with 50 touched allows anything from 0 to 0.5). The report also prints the measured joint, valid and addressed over labelled findings with an observed outcome, and says "insufficient data" below the label target. The thresholds are unchanged.

Sample-size targets used by the report (from the power arithmetic behind this plan): fix-through needs 40 PRs and 100 findings; precision 30 labelled findings; time-to-merge 30 merged PRs in the arm and in the baseline; unique share 15 valid labelled SpecGuard findings in arm 2.

## Step 6: decide

Preconditions (Step 4, weekly-report enforces them (pending)):

- Labeller agreement on the SpecGuard scope (the Step 6 rules use SpecGuard precision only; the Copilot and overall scopes only gate comparison text): alpha >= 0.800, bootstrap 95% lower bound >= 0.667, at least 100 doubly labelled SpecGuard findings (Step 4 power table), at most 5% dropped bootstrap draws, and neither labeller above 20% unsure. weekly-report applies exactly this through label-export's `agreement()`. Between 0.667 and 0.800, or short of any other condition, the result is "tentative, no decision"; below 0.667 the precision number is not evidence. Nothing below is decided without it.
- The arm analysis is intention-to-treat (every PR in its first-assigned arm, closed and unmerged included) and PRs flagged for a second PR per branch or a close-and-reopen are reported with and without. If the verdict changes when they are dropped, say so; a re-roll can bias the arms.
- The blinding result is quoted next to precision.

Continue or expand SpecGuard only if all four hold (pre-registered, evaluated line by line by the report):

1. Fix-through A at least 25% and the PR-cluster lower bound above 15%.
2. Blind precision at least 65%.
3. Time-to-merge in the SpecGuard-only arm no more than +15% against the no-AI baseline.
4. In arm 2, at least 40% of the valid SpecGuard findings are unique (no Copilot finding nearby).

Stop or reposition (summary-only, pre-push only) if any falsifier fires:

- F1 A below 15% over at least 40 PRs, or precision below 50% on 30 labelled findings.
- F2 precision x A below 0.18 (break-even in the value model).
- F3 time-to-merge more than 15% worse with no drop in human review comments (check the comment counts by hand).
- F4 native Copilot raises at least 60% of the valid SpecGuard findings.
- F5 from step 1.

"Insufficient data" is not a pass: keep collecting. Escaped defects are not measurable in 4 weeks: repeat the SZZ step on the trial PRs at 8 to 12 weeks and report counts with intervals. AI-agent-authored PRs have no human fix rate; exclude them or analyse them separately (the report already drops bot accounts, not agents that commit under a person's name).

## Privacy

- `weekly-report` output holds counts only. `labels.csv` holds finding text, which quotes your code, and `replay` copies private source into its `--out` folder and sends `prompt.md` (diff, requirement text) to a model. Keep both inside the company, use an approved model, delete the folders when done.
- The report reads PR comments, review threads and compare diffs through `gh` with your own login; it writes nothing to GitHub.
- The workflow sends the diff to Copilot (SpecGuard and native review) as your org's Copilot plan allows; the `COPILOT_REVIEW_TOKEN` PAT should belong to a service user with the least access (Pull requests: write on this repo).

## Results: seeded recall on Kite, PR mode (2026-10-14)

A blind check of the PR path on a real repository, before any team pilot. It measures recall on known gaps; it is not the fix-through or precision study above.

**Setup.** Repository `Mira190/Kite` (Electron, React, TypeScript, `node --test`; requirements in `docs/design.md`). Engine: Claude Haiku 5.5, API mode, about $0.01 per PR. Ten PRs (#10–#19), each a believable small change with exactly one seeded gap, written by an agent playing the developer. The answer key stayed outside every repository; PR titles and bodies do not hint at the gap.

- Unit-test side: U1 a test refactor deletes one assertion; U2 a value assertion weakened to `assert.ok`; U3 an exact-boundary test case dropped; U4 a new branch with no test; U5 a boundary constant changed with no test change.
- Requirement side, each against an unchanged sentence of `docs/design.md`: R1 a stated duration changed (10 s → 15 s); R2 a required pre-start check removed; R3 a default changed (camera shortcut bound by default); R4 a stated label changed; R5 a stated range narrowed (0–9 → 0–5).

A case counts as found when the gap is visible on the first screen of the summary (an inline comment, a counted gap, or a requirement row that names the difference). A requirement row that only asks a person to check, without the difference, counts as half.

| Case | Round 1 (main at #179) | Round 2 (after #180–#182) | Round 4 (final main, after #183–#184) |
|---|---|---|---|
| U1 deleted assertion | missed | found | missed |
| U2 weakened assertion | missed | found | found |
| U3 dropped boundary case | found | missed (finding dropped by validation) | missed |
| U4 untested new branch | found | missed (downgraded by the delegate check) | found |
| U5 boundary moved, untested | found | found | found |
| R1 duration 10 → 15 s | missed | found (mismatch, inline) | found |
| R2 required check removed | half | half | half (the finding cited the removed line and failed the citation check) |
| R3 default changed | found (asked a person, difference named) | found (mismatch, inline) | found |
| R4 label changed | missed | found (mismatch, inline) | found |
| R5 range narrowed | missed | found (mismatch, inline) | found |
| **Total** | **4.5 / 10** | **7.5 / 10** | **7.5 / 10** |

Round 3 re-ran only U3, U4 and R2 after #183 and #184: U3 and U4 were found, R2 stayed half. Across all runs, no counted finding was wrong; the noise was two or three "check this requirement" rows for loosely related design lines.

**What changed between rounds.**
- Round 1 → 2, requirement side 1.5 → 4.5. The model had seen R1 and R4 ("design.md still says 10 seconds", "still quotes the old label") and filed them as impacted, because the PR skill said a stated intent downgrades a requirement mismatch. #182 makes an unchanged admitted requirement document the baseline: an intended change against it is still a spec_mismatch. #180 links a requirement block to the hunk that removes a value the block states (10, 停止录制, 9), so R1, R4 and R5 get a requirement row at all.
- Round 1 → 2, U1 and U2 found: #182 adds deterministic leads for removed and weakened assertions in test-only PRs.
- Round 2 regressions fixed: U4 was downgraded because #179's delegate check counted `filter` and `deepEqual` as tested helpers (#183: only functions the repository defines in non-test files count). U3 was found by the model but dropped, because removed evidence without side LEFT demoted its coverage row (#184: the side is set instead).

**Reading.** The requirement-side gain is stable across rounds (4.5 / 5, as inline mismatches on the changed line). The unit-test side varies between runs: every unit case was found in at least one run after the fixes, but a single run finds 3 or 4 of 5. Two deterministic improvements are open: a finding that cites a removed line should be set to the LEFT side like #184 does for evidence (R2), and a removed assertion with no replacement is a fact that could be reported without depending on the model (U1). Sample size is ten cases on one repository; treat the numbers as a regression check, not a rate.

## Step 7: escaped defects (weeks 8-12)

Negative result on real data (from PR #397): on SpecGuard's own history since 2026-10-01 (301 usable escaped defects), the observed line-hit rate was 15/301 = 5.0% (Wilson 3.0 to 8.1%) against a primary-null chance rate of 4.5% (95% 3.0 to 6.3%). That is not above chance. A whole-file null (1.4%) would have wrongly called it above chance. A hand check found 2 of 6 hits genuine. So far, SpecGuard's findings do not locate the lines where defects later escape any better than chance; the trial must show otherwise before anyone claims it does.

The trial measures adoption and noise. The outcome that matters is defects that got past review into QA or production, so repeat the SZZ step on the trial PRs 8 to 12 weeks after the trial starts and ask, per arm, how many escaped and what SpecGuard said about the buggy lines.

```sh
# 1. Mine the bug-fix commits made since the trial started (needs a clone and gh; the manifest records the blamed path and line of each introducing commit)
node eval/szz.js mine --repo ../my-repo --since 2026-10-19 --gh-repo ORG/my-repo --label-scan --out fixes.json
# 2. Review fixes.json: set `confirmed: false` on pairs that are not real bugs (they are dropped). Then add the section to the weekly report
node eval/weekly-report.js --repo ORG/my-repo --since 2026-10-19 --fixes fixes.json --shadow-cache shadow.jsonl
# 3. After the trial the arm salt is revealed: also check that every label equals the assignment
node eval/weekly-report.js --repo ORG/my-repo --since 2026-10-19 --fixes fixes.json --shadow-cache shadow.jsonl --arm-salt "$SALT"
```

`--shadow-cache` is only needed for arm 1. Arm 1 runs SpecGuard in the background with `delivery: summary` and `ctx_retention_days: 90`; nothing is posted to the PR. Each weekly run looks at the runs of the workflow "SpecGuard validation" (matched to the PR by number, or by head SHA for fork PRs), downloads the artifact `specguard-ctx-<PR>-<attempt>` for each head it has not cached yet (newest attempt first; if that attempt failed, the latest good one), and appends the finding paths and lines to `shadow.jsonl`, so the data outlives the 90-day expiry. Run the report every week and keep the same cache file. The workflow and artifact names are one constant (`SHADOW` in `eval/escapes.js`), and a test reads the name template from `action.yml`. Findings come from `counts.json` (the validated set SpecGuard would have delivered), not the raw `findings.json`. Only the last run of a PR counts, because that is the final head: if it failed the PR is unusable, whatever an earlier push said.

Two tables, with different meanings. Do not compare them with each other.

1. **Escaped defects per 100 PRs, per arm.** This is the outcome that compares arms. Every PR counts in the arm it was first labelled with (intention to treat), with the PR-cluster bootstrap interval. Withheld below 30 PRs per arm.
2. **What SpecGuard said about the blamed lines.** Arms 0 and 2: "flagged but still escaped", a finding was delivered on the PR and the defect escaped anyway (an adoption or noise failure, not a catch). Arm 1: "would have caught", a counterfactual from the hidden shadow run. A line hit is a finding on the same file within 3 lines of a blamed line; a file-level or summary finding with no line, or one farther away in the same file, is counted separately as "same file only". Both sides use every finding SpecGuard reported (any kind and confidence, inline plus summary). Withheld below 10 located defects.

A line-hit rate means nothing without a chance baseline, so the table carries one. Chance = the same findings with their lines redrawn 1000 times (fixed seed), each keeping its file. Primary null: the line is drawn from the lines the introducing commit added in that file, because findings and SZZ-blamed lines both live in changed hunks (needs `--clone REPO_DIR` for the diff; without it the line is permuted among the findings other PRs have in that file, and the table says how many findings each way). Weak null: a random line anywhere in the file; it favours big files and is shown only for comparison. "Not above chance" is printed when the observed rate does not exceed the upper bound of the primary null's 95% interval; "observed - chance" is the excess in points. Arm 1 (shadow) is judged the same way.

Other columns: *unusable review* = the SpecGuard run for the PR failed (auth_failed, quota, any `failed` status) or the shadow artifact is missing or expired; never a miss and not in the denominator. *no location* = SZZ gave no blamed lines (reverts, manifests mined before spots were recorded). *runs with the 20-finding cap* = shadow runs whose summary list is full (the producer keeps at most 20), so findings may be missing.

Trial integrity block (printed when branch data, reopen events or a salt are available):

- Same head branch opened more than once, and PRs closed and reopened: a PR can be re-rolled until it lands in a wanted arm. They stay in their first arm; read the flags, and exclude them in a sensitivity run if there are many.
- With the salt: any PR whose label differs from the salted assignment is listed (a PR can edit its own workflow).

Labeller agreement (when `--labels` has `label_a` and `label_b`): Krippendorff's alpha per tool. Precision-based rules are decided only at alpha 0.800 or more; from 0.667 to 0.800 they are tentative and not decided; below it, or with a single reconciled `label` column and no agreement evidence, they print "not evaluated" and the verdict stays at "keep collecting".

Caveats:

- SZZ is noisy. Blame follows the last commit to touch a line, so refactors and renames misattribute; a fix blamed on several PRs counts once for each. Review `fixes.json` by hand (`confirmed: false`) before quoting a rate.
- The lag is real. Bugs not yet found and fixes not yet made are invisible, so every arm is undercounted and recent PRs most. Read at 8 to 12 weeks, and compare arms only on the same cut-off date.
- Escapes are rare: with 100 PRs per arm expect a handful, so the intervals are wide. The plan reports counts with intervals, not a verdict.
- The line match uses the line number in the introducing commit. A PR that kept changing after the finding was posted shifts lines, which lowers the match rate. On the 240 SZZ replay pairs with known fix lines (`eval/replay/*pairs.json`), the lines a fix removed fall inside a line the introducing PR added in 156 (65%) and within 3 lines in 171 (71%); in the same file in 224 (93%). So expect about a quarter of true line-level hits to be recorded as "same file only" or as misses.
- Privacy: `shadow.jsonl` holds model findings as file paths, line numbers and kinds (no finding text, no code), and `fixes.json` holds commit titles. Keep both inside the company and delete them when the study ends.
