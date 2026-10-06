# Real-model evaluation

Runs the design's acceptance matrix against the real Action on GitHub and records finding precision, seeded-gap recall, JSON validity, latency and per-case pass/fail.

## Run

Needs `git`, `gh` (authenticated, able to push and open PRs) and a repo whose CI runs the Action (the `dogfood` job of `.github/workflows/ci.yml`). `origin` must point at `--repo`, and `--target` must already contain the Action and workflow.

```sh
node eval/run.js --dry-run                                   # validate case dirs, no git, no GitHub
node eval/run.js --repo OWNER/REPO --target main --cases r1  # smoke
node eval/run.js --repo OWNER/REPO --target main             # all cases
```

Options: `--runs N` repeats each case, `--run-id ID`, `--workflow NAME` (default `CI`), `--keep` leaves the PRs and branches. Runs are sequential. Each run uses a temporary `git worktree` from `origin/<target>` (the main tree is never touched), pushes `eval/<runId>-<case>-<n>-base` and `-head`, opens a PR, waits up to 25 min for the `pull_request` run of the head SHA, grades, then closes the PR (no comment) and deletes both branches. Push auth is `!gh auth git-credential`; set `SPECGUARD_EVAL_CRED_HELPER` to change it.

Results go to `eval/results/<runId>.json` and `.md`.

## Cost and latency

Every run spends Copilot AI Credits. The harness cannot read them reliably, so cost is recorded as `not measured`: check the billing page for the run's time window. Latency is the `dogfood` job duration.

## Grading

All fixtures live under `eval-sandbox/<id>/` in the PR, so cases never touch real files. `eval/cases/<id>/base/` and `head/` mirror that directory; `case.json` paths are repo-relative (`eval-sandbox/<id>/...`). Fixture tests are named `*.spec.js` so the repo's own `node --test` does not run them; they are never executed by the Action either.

- Only high-confidence inline and file-level comments count as observed findings. A match needs equal kind and path (either may be a list of accepted values), and the line within `tolerance` (default 2) or an equal `source`. `rule` (substring of the cited rule) and `text` (regex over title and body) are optional. Matching is one-to-one, closest line first.
- Unmatched observed = FP, unmatched expected = FN. A `text` miss fails the case but still counts as a match.
- Low-confidence and summary-only items are counted as `summary_only`, never TP or FP. An expectation with `allow_summary: true` (t4: the finding sits on removed lines, so it lands in the summary) is satisfied by a summary item or coverage row with matching kind and path.
- `must_not` entries: `{kind?, path?, line?, tolerance?, text?}` against posted comments (a text-only entry also scans review bodies), or `{state: "APPROVED"}` against review states.
- `expect_skip`: the summary says "Nothing to review" and nothing was posted. `expect_clean`: no high-confidence comment. `json_valid`: a sticky summary exists and does not say "Could not complete" or "Partially reviewed" and does not report standards tooling as incomplete.
- A case passes with no FN, no `must_not` violation, no `text` miss, `json_valid`, and skip/clean as expected. FPs lower precision but do not fail a case.
- Aggregate: precision = TP/(TP+FP), recall = TP/(TP+FN), JSON validity rate, pass rate, latency median and max, overall and per goal. Runs that errored (timeout, push or API failure) are counted as `errors` and excluded from every metric.

## Add a case

1. `eval/cases/<id>/case.json` with `id`, `goal` (`requirements`, `test_quality`, `standards`, `layering`, `robustness`), `description`, `pr_title`, `pr_body` (plain text), `delete` and `expected`.
2. Put files added in the base commit in `base/` and files added or changed in the PR in `head/`. `delete` lists repo-relative base files removed in head.
3. Give each expected finding a `quote` that the target line must contain; `--dry-run` checks it. Seed exactly the gaps you list and keep the rest well tested.
4. `node eval/run.js --dry-run`, then `node --test`.
