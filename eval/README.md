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

## Diagnostics artifact

This repo's `dogfood` job uploads `.specguard-ctx/` as the 7-day artifact `specguard-ctx` (adopters are unaffected). After each run the harness downloads it with `gh run download` (non-fatal) and records per case `raw_findings_present`, `raw_findings_valid_json`, `raw_excerpt` (first 2000 characters of `copilot.out` or `findings.json`) and `validation_notes` parsed from the sticky summary. With the artifact, `json_valid` means the model produced parseable JSON (the raw `findings.json` exists and parses), which is separate from "report complete" (no "Could not complete", "Partially reviewed" or incomplete tooling; still required to pass). `degraded` counts runs whose summary lists validation notes, meaning part of the output was demoted or dropped but the rest was kept; the aggregate reports its rate. Without the artifact, `json_valid` falls back to the summary-based rule.

## Cost and latency

Every run spends Copilot AI Credits. The harness cannot read them reliably, so cost is recorded as `not measured`: check the billing page for the run's time window. Latency is the `dogfood` job duration.

## Grading

All fixtures live under `eval-sandbox/<id>/` in the PR, so cases never touch real files. `eval/cases/<id>/base/` and `head/` mirror that directory; `case.json` paths are repo-relative (`eval-sandbox/<id>/...`). Fixture tests are named like real tests of their stack (`*.test.js`, `*.test.ts`, `*.test.tsx`; the jest JS case js2 uses `*.spec.js` so the `node --test` step on eval PRs skips it), so the model judges them as it would in any repo. Fixtures are never run by main-branch CI or locally: run tests with `node --test src/*.test.js eval/*.test.js` (never bare `node --test`, which would discover `eval/cases`). On an eval PR, CI also runs `eval-sandbox/**/*.test.js`; some may fail on purpose (r4 contradicts an AC), which only affects that PR's `test` job, not the review or grading. This repo's own coding standard (`.github/instructions/specguard.instructions.md`) applies only to `src/**` and `eval/*.js`, so it does not flag the fixtures.

- Only high-confidence inline and file-level comments count as observed findings. A match needs equal kind and path (either may be a list of accepted values), and the line within `tolerance` (default 2) or an equal `source`. `rule` (substring of the cited rule) and `text` (regex over title and body) are optional. Matching is one-to-one, closest line first.
- Unmatched observed = FP, unmatched expected = FN. An unmatched observed finding that fits an `expected.acceptable` entry (`{kind, path, line, tolerance?, reason}`, same matching rules, one observed per entry) is `acceptable` instead: neither TP nor FP, shown in its own column and as an aggregate count. Use it only for behaviour the fixture truly leaves untested but did not seed (r1/x2: the `subtotal` helper and non-SAVE10 coupons; s1: falsy `PORT` values), with a `reason`; never to excuse a wrong finding or a finding the tests do cover. A `text` miss fails the case but still counts as a match.
- Low-confidence and summary-only items are counted as `summary_only`, never TP or FP. An expectation with `allow_summary: true` (t4: the finding sits on removed lines, so it lands in the summary) is satisfied by a summary item or coverage row with matching kind and path.
- `must_not` entries: `{kind?, path?, line?, tolerance?, text?}` against posted comments (a text-only entry also scans review bodies), or `{state: "APPROVED"}` against review states.
- `expect_skip`: the summary says "Nothing to review" and nothing was posted. `expect_clean`: no high-confidence comment. `json_valid`: a sticky summary exists and does not say "Could not complete" or "Partially reviewed" and does not report standards tooling as incomplete.
- A case passes with no FN, no `must_not` violation, no `text` miss, `json_valid`, and skip/clean as expected. FPs lower precision but do not fail a case.
- Aggregate: precision = TP/(TP+FP), recall = TP/(TP+FN), JSON validity rate, pass rate, latency median and max, overall and per goal. Runs that errored (timeout, push or API failure) are counted as `errors` and excluded from every metric.

## Traceability cases (tr1-tr17)

Goal `traceability` (see `docs/traceability-plan.md` §7.1). Requirement documents are ordinary case files, so they live inside the case's own sandbox tree (`eval-sandbox/<id>/docs/specs/...`, `features/...`, `README.md`); the dogfood step excludes everything outside `eval-sandbox/` from discovery. Expected findings use kind `spec_mismatch`, anchored on the changed code line (A) or changed spec line (B); `text` is a regex that must match the title and body (it names the other side, e.g. `deadline.js:2`, `README.md`). Extra `expected` keys, all optional, are checked against the sticky summary and any miss fails the case (listed as `summary ...` in the notes):

- `summary_has` / `summary_lacks`: regexes (case-insensitive) that must / must not match the summary (tr7 "No requirement documents found", tr13 `not_verifiable`, tr15 `conflict`, tr17 no `development.md`).
- `trace`: entries `{requirement, alignment?, alignment_not?, reflected?: {spec, tests, pr}}` against the **Traceability** table (columns Requirement | Changed | Implementation | Tests | Alignment | Reflected in). `requirement` is a regex over the first cell; the first matching row is used. `alignment` is one of `consistent|mismatch|impacted|not_verifiable|not_applicable|unknown`. The Reflected cell is read as labelled marks (`spec ✓ tests ✗ PR ✗`, also `yes/no`) or three unlabelled marks in spec, tests, PR order.
- `pre_existing`: `true` or a regex; the section "Pre-existing drift (not caused by this PR)" must exist and match (tr10).
- `rows_not`: `{status, text?}`; no coverage row with that status whose line matches `text` (tr11: R3 never `covered`).

`must_not: [{kind: "spec_mismatch"}]` (no path or line) forbids any such comment on the PR.

## Add a case

1. `eval/cases/<id>/case.json` with `id`, `goal` (`requirements`, `test_quality`, `standards`, `layering`, `robustness`, `traceability`), `description`, `pr_title`, `pr_body` (plain text), `delete` and `expected`.
2. Put files added in the base commit in `base/` and files added or changed in the PR in `head/`. `delete` lists repo-relative base files removed in head.
3. Give each expected finding a `quote` that the target line must contain; `--dry-run` checks it. Seed exactly the gaps you list and keep the rest well tested.
4. `node eval/run.js --dry-run`, then `node --test src/*.test.js eval/*.test.js`.

## Combined mode

`node eval/run.js --combined --repo OWNER/REPO --target main` puts every case except x1 and x2 into ONE PR, runs ONE review and grades each case by its sandbox path (`eval-sandbox/<id>/`). Findings, summary items and coverage rows outside a case's path are ignored for that case. `json_valid` and `complete` are shared from the single run. The result adds a "Combined PR" row per repetition: total TP/FP/FN, findings outside every sandbox (counted as FP), findings posted vs the budget, and summary overflow. `--runs N` opens N fresh PRs; `--cases` narrows the set; `--dry-run` builds and validates the merged overlay and PR body without git or GitHub.

- **Isolated vs combined.** Isolated (default): one PR and one review per case; use it for attribution and releases. Combined: one PR, one review; use it for cheap regression and stability checks.
- **Excluded.** x1 (`expect_skip`: a docs/lockfile-only PR cannot coexist with code changes), x2 (the prompt injection in its PR body would contaminate every other scenario) and tr1-tr17 (content-based discovery would see every case's requirement docs, and their summary expectations are per PR). r2 stays in: its `expect_clean` means no high-confidence finding under `eval-sandbox/r2/`. The opt-out list is `COMBINED_SKIP` in `eval/run.js`.
- **PR body.** One `## <id>: <title>` section per case, each followed by its own body. The level-2 heading ends the previous case's `## Acceptance criteria` section, so the criteria are exactly the union of the cases' own. Criterion ids (R1..Rn) are renumbered across cases; grading is by path, so that does not matter.
- **Budget.** The harness sets repo variable `SPECGUARD_EVAL_MAX_COMMENTS` to 30 for the batch (CI passes it as `max_comments`, default 10) and restores the previous value afterwards, also on SIGINT. The model is not told the budget: `post.js` posts at most N inline comments and moves the rest to the summary as "over max_comments".
- **Interpretation.** Combined results measure big-PR behaviour (budget pressure, attention across many files), not per-scenario accuracy: a miss may be a budget or attention effect, and the diff is much larger than any single case.

## External mode (real repositories)

`node eval/run.js --external manifest.json --repo OWNER/MIRROR --action OWNER/specguard@SHA [--trace off,auto] [--model ID|default] [--keep]` reviews whole source repositories at historical commits (`docs/traceability-plan.md` §7.4.1). Source code is never committed here: only manifests are. The source is cloned into a temp directory at run time and pushed to the private mirror.

- **Mirror.** Its default branch holds only `.github/workflows/specguard-eval.yml`, made from `eval/mirror-workflow.yml` (job `dogfood`, uploads `.specguard-ctx`; reads `SPECGUARD_EVAL_MODEL`, `SPECGUARD_EVAL_TRACE` and `SPECGUARD_EVAL_MAX_COMMENTS`). `--action` replaces the `OWNER/specguard@SHA` placeholder with the SpecGuard commit under test. The workflow is named `specguard-eval`, which is the default for `--workflow` in this mode.
- **Injection.** `base' = base + W` (W only adds the workflow), `head' = merge(head, base')`, PR from `head'` into `base'`. The three-dot diff of the PR therefore equals the original `git diff base...head`. Branches are `eval/<runId>-<id>-base|head`, deleted afterwards unless `--keep`.
- **Trace.** Each scenario runs once per value of `--trace` (default `off,auto`); the harness sets repo variable `SPECGUARD_EVAL_TRACE` before opening each PR and restores it at the end. Rows are named `<id> [trace off]`, `<id> [trace auto]`, so the marginal value of traceability shows in the table.
- **Manifest.** A JSON array of `{id, source: {url, sha}, base, head, pr_title, pr_body, expected, goal?, linked_issues?}`. `source.url` is https, `source.sha` a 40-character SHA, `base`/`head` any commit-ish in the source, `expected` the `case.json` schema with paths relative to the source repo. Bare `#N` in `pr_body` and `linked_issues` becomes `<source url>/issues/N`; `linked_issues: [{number, title?, body}]` is inlined under `## Linked issue (copied)` (HTML comments dropped, 8000 characters per issue). Historical intent (U7) cannot work in a mirror, so replay does not measure it.
- **Dry run.** `--external manifest.json --dry-run` validates the manifest, clones the sources and builds `base'`/`head'` locally. It pushes nothing and calls no GitHub API, but it does need network access to clone.
- Grading is `grade.js`, unchanged. Results go to `eval/results/ext-<timestamp>.{json,md}`; cost is not measured.
