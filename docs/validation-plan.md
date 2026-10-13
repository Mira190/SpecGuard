# Validation plan: prove or disprove SpecGuard on your own repos in 2 to 4 weeks

Goal: replace the unknowns (human fix rate, precision, time-to-merge, overlap with native Copilot review) with measurements from your repos. Everything below is read-only analysis plus one workflow file. Nothing here changes what SpecGuard posts.

Design: every PR gets exactly one of three setups by PR number mod 3, so nobody goes without review and the authors, repos and PR template are the same across arms.

| Arm | PR number mod 3 | Review |
|---|---|---|
| 0 | 0 | SpecGuard only |
| 1 | 1 | native Copilot code review only |
| 2 | 2 | both |

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

1. Copy `docs/validation-workflow.example.yml` to `.github/workflows/specguard-validation.yml`. Replace `<full-commit-sha>` with a full SpecGuard commit SHA. Remove any other SpecGuard workflow. Turn off automatic Copilot review for the repo, org and your own settings, otherwise every PR is arm 2.
2. Requesting the Copilot review from Actions is the one unverified part (see the file header). Open a canary PR with number mod 3 equal to 1 and look at the `copilot` job. If it passes and Copilot appears as a reviewer, go on. If it fails: add the repo secret `COPILOT_REVIEW_TOKEN` (fine-grained PAT of a Copilot-licensed user, Pull requests: write) and retry. If the API path stays closed, use the two-arm fallback in the file header (ruleset keeps Copilot on for every PR; the workflow varies only SpecGuard; you learn the added value of SpecGuard, not a head-to-head).
3. Also check an arm 0 and an arm 2 canary: the `review-arm:N` label is set and SpecGuard posts. PRs where the Copilot request failed get the label `copilot-request-failed` and are excluded by the report.
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
node eval/label-export.js --repo ORG/my-repo --since 2026-10-19 --sample 30 --seed 1 --out labels.csv
# two senior reviewers fill the label column (valid | invalid | unsure) and notes, independently, without looking at which tool wrote a finding
node eval/weekly-report.js --repo ORG/my-repo --since 2026-10-19 --labels labels-done.csv
node eval/label-export.js  --repo ORG/my-repo --since 2026-10-19 --import labels-done.csv   # precision per tool only
```

- 30 findings per tool is the minimum; the tool name is hidden and rows are shuffled by `--seed`. Keep the same seed and window for the import, because the ids are hashes of the finding (a different window gives "ids matched no finding").
- Label `valid` = a real gap or bug that a reviewer would want fixed on this PR. `invalid` = wrong, already covered, or noise. `unsure` is reported but not counted. Reconcile disagreements by discussion and write one file.
- The `link` column opens the PR files page, which shows who wrote each comment: label from the CSV text and open the link only when the text is not enough.

## Step 5: read the numbers

| Number | Meaning | Caveat |
|---|---|---|
| Findings/PR | volume the developer must read | SpecGuard counts inline comments only (summary-only items are not included) |
| Fix-through A (addressed / all outcomes) | share of findings where the flagged lines or a test file changed later | Not proof of a fix. Read at the latest run, not at merge. Copilot A uses the same rule from thread state; "dismissed" means a human resolved it with nothing changed. Re-raised findings under a new fingerprint can inflate SpecGuard's `open`/`addressed` |
| Cluster bootstrap interval | the honest interval: PRs are resampled, not findings | the Wilson interval assumes independent findings and is too narrow |
| Blind precision | valid / (valid + invalid) from labels, Wilson interval | needs 30 labelled per tool |
| Time-to-merge median / p75 | creation to merge, human PRs only | at 50 PRs per arm only about a 2x difference is detectable: a guardrail, not a headline |
| Credits/PR | SpecGuard credits of the last run per PR (1 credit = $0.01) | not summed over pushes; runner minutes and native Copilot cost come from the Actions billing page and the Copilot usage report |
| Overlap (arm 2) | SpecGuard findings with a Copilot finding on the same file within 3 lines, and the reverse | location overlap only; the labelled "unique valid" share is the real test |

Sample-size targets used by the report (from the power arithmetic behind this plan): fix-through needs 40 PRs and 100 findings; precision 30 labelled findings; time-to-merge 30 merged PRs in the arm and in the baseline; unique share 15 valid labelled SpecGuard findings in arm 2.

## Step 6: decide

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
