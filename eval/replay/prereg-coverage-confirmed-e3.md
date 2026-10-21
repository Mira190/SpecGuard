# Pre-registration E3 (DRAFT, not frozen): does coverage confirmation pick the LLM's precise missing-test findings?

**Status.** Draft by specguard-33, 2026-10-20, for red-team review by specguard-e0. Branch eval/e3-prereg off eval/coverage-gap-e1 @ 2fffc35. Nothing has run on the confirmation set.

**Decision record.** The owner delegated the post-design-look decision to the red team. e0 chose option 1 (2026-10-20): pre-register E3, freeze it, then run the confirmation set once for both E1 and E3.

**Question.** On E1's confirmation bug PRs, do haiku missing_test findings whose cited line the unit-coverage report shows was never executed ("confirmed") hit the bug location more often than findings whose cited line was executed ("contradicted")? This is the product rule shipped in #413.

**Motivating look, not evidence.** E1's design look (comparison 4, 11 holdout-2 PRs, 3 saved runs) gave:
- confirmed 4/5;
- contradicted 9/27;
- unknown 0/24.

Those runs, PRs and labels are excluded from every E3 count.

**Alpha.** E3 has its own alpha, separate from E1's: it tests a different hypothesis under its own prereg. It goes on the multiplicity list next to E1 and every earlier attempt (`prereg-coverage-gap-e1.md`, Multiplicity).

## Data

- **PRs.** The 40 bug PRs (`kind: bug`, filtered 16 + unfiltered 24) of `eval/replay/coverage-e1-confirm.json` at 2fffc35. The 30 controls get coverage for E1 but have no E3 role.
- **Coverage.**
  - There is a single E1 cover run over the 70 confirmation rows, under E1's rules. The runner is main d737045 or later with the same eval/f2p (amended freeze note (b)). The job list is checked before cover runs.
  - E1 (its frozen command) and E3 are scored from the same reports. Cover is not rerun for E3.
- **LLM runs.**
  - Model: `claude-haiku-5-5`, engine claude-api, through the local `eval/replay.js batch` (#409).
  - 3 reps, rep-major, over the 40 bug PRs, in manifest order: 120 runs.
  - `--budget 0.25` per run (red team: holdout 2 peaked at $0.1228, and claude-api's pre-flight is a hard bound, so a tighter budget would fail big-pack PRs). `--max-total 8` (USD) for the whole batch. `--cap 120`. Expected spend is about $5.5 (holdout-2 mean $0.046 × 120).
  - Each run's checkout is the PR's introducing head, with the PR title and body as the batch manifest gives them.
  - No reruns of a run that reached the model; #409's no-re-roll rule applies. A run that is invalid for any other reason is a miss for every metric it would have fed, and is counted.
  - If the cap stops the batch early, every PR with all 3 reps done is scored. The rest are reported as not run and are never topped up later.
- **Manifest.** `eval/replay/coverage-e3-manifest.json` (the testgap-confirm-build `bugs` format that `replay.js` reads, `controls: []`). It is built deterministically from the 40 bug rows by `coverage-e3-manifest.js`, with the INTRODUCING PR's own title and body (each run serves only the PR title and body), read-only via `gh api repos/<repo>/pulls/<n>` and cached. If a fetch fails, it falls back to the commit subject and an empty body, as in testgap-confirm-build.js `prText`. Every entry records `pr_text` (github or commit), and the fallback count is reported. It is committed before the freeze.

## Findings and labels

- **Included.** Every `missing_test` finding of a valid run (`runValid`), any confidence, delivered or not, whose `path` and `line` are set and whose path passes E1's `isCode`.
  - Excluded findings are counted by reason: no line, no path, non-code path, invalid run.
- **Label**, from the E1 cover report of that PR at I's head (the coverage report as parsed by `src/coverage.js`, looking up the cited file in the whole report, not only in changed files):
  - **confirmed:** the cited line is instrumented with 0 hits;
  - **contradicted:** the cited line is instrumented with more than 0 hits;
  - **unknown:** the line or file is not instrumented, there is no report, or the PR is unusable under E1's rules.
- **Catch.** E1's B: inside the span of a definition enclosing a blamed line of the PR, or within ±3 lines of a blamed line (`testgap-score.js` `pairData(...).B`).
- **Delivered.** A finding counts as delivered if it would reach the PR reader, as defined in `testgap-score.js` (#412). This is used only for the delivered-only secondary.

## Primary test

- **Statistic.** Catch rate of confirmed findings minus catch rate of contradicted findings, pooled at finding level over all runs.
- **Null.** A one-sided permutation test. Labels are shuffled **within each PR-run** (PR × rep) among that run's confirmed and contradicted findings; unknown findings are never shuffled in.
  - A PR-run with findings of only one label keeps them as they are.
  - 10000 permutations, seed 20261020.
  - p = share of permutations whose statistic is ≥ the observed one, ties included.
- **PASS iff both:**
  - p < 0.05; and
  - the difference is at least 15 points.
- **Not tested** if there are fewer than 10 confirmed findings in total, or fewer than 10 contradicted findings in total. This is decided before anything else is computed and reported as such.
- **Interval.** A PR-cluster bootstrap 95% CI of the difference (resample the 40 PRs with replacement, carrying each PR's findings from all reps; 2000 boots, seed 20261020).

## Secondary (descriptive, no tests)

1. Confirmed vs unknown: catch rates and the cluster-bootstrap CI of the difference.
2. Delivered-only: the primary statistic on delivered findings.
3. Per repo (hono, langchain, sqlglot): counts and catch rates for each label.
4. Subgroups filtered (16) and unfiltered (24): counts and catch rates for each label.
5. **Environment-breakage split.** The design look found hono bug trees with about 480 failing tests each, and every PR deps_changed.
   - The rates for each label are reported split by deps_changed.
   - They are also split by the PR's failing-test count, ≤ 20 vs > 20, a cut fixed now.
6. Counts: findings per label, per run, and excluded by reason; spend; runs not run or invalid.
7. The design-set values (4/5, 9/27, 0/24), shown next to the result as the motivating look.

## Readings (fixed now)

- **PASS:** coverage confirmation selects more precise LLM missing-test findings on this corpus. This supports phase 1, where coverage-confirmed findings become first class.
- **FAIL:** coverage confirmation does not separate them on this corpus, and the claim is not made.
- **Not tested:** reported with the counts. No relaxation, no extra runs.
- Scope of every reading: "haiku missing_test findings on these 40 SZZ bug PRs in hono, sqlglot and langchain-core, with the harness's unit scope". Nothing is claimed for other models or repos.

## Scorer

- `eval/replay/coverage-e3-score.js` reuses E1's exports where they exist: `loadHits`/`labelLine` semantics, `runValid`, `rawDir`, `bootCi`, and `pairData` from testgap-score.
- Its synthetic test `coverage-e3-score.test.js` must fail under each of these mutations:
  - shuffling labels across PRs (or across runs) instead of within the PR-run;
  - dropping ties (counting `>` instead of `≥`);
  - labelling unknown as contradicted (or letting unknown findings into the shuffle);
  - looking up hits only in changed files.
- Red-team review of the scorer comes before the freeze.

## Order

1. E3 freeze OK (red team).
2. The cover run on the 70 confirmation rows (E1 rules, the d737045 runner, the job list checked before the run).
3. The haiku batch on the 40 bugs. The owner approved the $8 cap on 2026-10-20 and sets the key themselves. The owner runs the exact batch command, prepared after the freeze OK, in their own shell with the key set only there. The scorer reads the batch out dir.
4. Score E1 (its frozen command, plus the power-flag note) and E3 (its frozen command).
5. Results PRs.

## Resources

All work is local and serial, under the shared-machine rules:
- each agent kills only its own PIDs;
- C: must have at least 5 GB free before cover and at least 1.5 GB before each batch run;
- RAM must stay at least 1.2 GB free.

The batch drops each checkout after its run (#409).

## TBD before freeze

- The scorer and test sha, reviewed by the red team: `coverage-e3-score.js` and its test as of 230449b. 5de39c0 changed only the manifest builder.
- The manifest builder and manifest sha: 5de39c0. 40 bugs, `pr_text_fallback: 0`.
- Commands, fixed now. The cover set name is `e1confirm`. The runner is a fresh worktree of main at d737045 or later with the same eval/f2p, and the list is `coverage-e1-confirm.json` at 2fffc35.
  1. `node eval/f2p/f2p.js import eval/replay/coverage-e1-confirm.json --name e1confirm`, then `export --set e1confirm`. Before cover runs, log the job list and check that it is exactly the 70 row ids.
  2. `node eval/f2p/f2p.js cover --set e1confirm`. Hono verify afterwards.
  3. The batch: `node eval/replay.js batch --out <evidence>/e3/batch --repos <evidence>/repos --cap 120 --budget 0.25 --max-total 8 --reps 3 --model claude-haiku-5-5 --manifest eval/replay/coverage-e3-manifest.json --ids all`, run by the owner.
  4. E1, its frozen step 3 with the confirmation inputs (`--rows eval/replay/coverage-e1-confirm.json`, `--cover-results` and `--cover-dir` for e1confirm), with no `--power-n` (power was a design-look check). The red team fixes E1's confirmation scorer command separately if it differs.
  5. E3: `node eval/replay/coverage-e3-score.js --rows eval/replay/coverage-e1-confirm.json --repos <evidence>/repos --cover-results <runner>/eval/f2p/results-cover-e1confirm.json --cover-dir <evidence>/f2p/cover/e1confirm --raw <evidence>/e3/batch --reps 3 --out <evidence>/e3/result.json` (defaults: seed 20261020, perms 10000, boots 2000).
- The exact batch command: worktree path, Git Bash PATH prefix for collect.sh, out dir. It is handed to the owner after the freeze OK. docs/.env is never read by any agent.
