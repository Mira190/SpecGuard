# Pre-registration E1 (DRAFT, not frozen): do coverage gaps at PR time land where test-gap bugs were introduced?

**Status.** Draft opened on 2026-10-20 for the red-team review by specguard-e0. Nothing has run.

**Why.** Every null measured so far tested what the model can guess:
- `eval/replay/testgap-evidence-2026-10-20.md` (#412): delivered missing_test findings land at chance, and delivered direct content catches are 1/129;
- #397: line hits at chance;
- the mutation pilot: 0/10.

SpecGuard also has an evidence mode, the target repo's own coverage (`coverage_files`, `src/coverage.js`), which has never been evaluated. E1 asks the premise question without a model: on this corpus, do changed definitions that no unit test executes predict where test-gap bugs are introduced?

**Cost.** No model calls. Compute only, run locally in specguard-33's f2p environments. The shared-machine rules apply:
- each agent kills only the PIDs it started;
- C: must have at least 1.5 GB free before each step;
- rqlite runs only while its memory and disk use stay within the f2p harness caps.

## Repositories and unit tests

E1 runs only in the repos that are runnable in the f2p harness (main f6e4eb7).

| Repo | Unit-test command run with coverage at I's head | Report |
|---|---|---|
| honojs/hono | `vitest run --coverage` (provider v8, reporter lcov), with the repo's unit config and no e2e | lcov |
| tobymao/sqlglot | `pytest tests/` under `coverage run`, then `coverage xml` | Cobertura |
| langchain-ai/langchain | `pytest libs/<pkg>/tests/unit_tests` under coverage, for each package I touches | Cobertura |
| rqlite/rqlite | `go test -coverprofile` on the packages I touches, excluding `system_test/` | Go profile |

- rqlite is included only once its f2p controls have been rerun under amendment 6/7 rules. If not, it is excluded and reported.
- **Executed** means a hit count above 0 on that line in the report, read with `src/coverage.js`'s parsers.
- A line the report does not instrument is not executable and is ignored.
- A PR is **unusable** if the coverage run produces no report, or the report covers none of I's changed source files. An unusable PR counts as a miss for arm C and is reported. Failing tests at I's head do not make a PR unusable; their count is reported.

## Arms (scored on the same PRs)

- **C (coverage, deterministic).**
  - Definition units are I's changed definitions (`testgap-score.js` units: `enclosingName` spans, plus one top-level unit per file).
  - C flags a unit if it has at least one added executable line that no unit test executed.
  - The flag is placed at the first such line.
- **Static (name lookup)**, carried over: flag a changed definition whose name appears in no test file at I's head. It uses `git grep -lw`, with the grepTests bug fixed first.
- **LLM delivered.** Design set only, from the saved holdout-2 haiku runs (3 runs). No new model runs are made.

## Catch rule, nulls, test

- **Catch:** the same as `testgap-score.js`. A flag (or finding) is a catch if it lies inside B, meaning the spans of the definitions that enclose the blamed lines, or within ±3 lines of a blamed line.
- **Unit of analysis:** the PR. C and static are deterministic, so each counts 1 run per PR.
- **Nulls:**
  - Primary: function-level, weighted by added lines.
  - Secondary: uniform.
  - Each arm's own flags are permuted among I's changed units: 1000 permutations, seed 20261020. The verdict uses the null with the higher chance.
- **PASS for C iff both:**
  - the one-sided within-PR permutation p is below 0.05; and
  - observed − chance is at least 10 points.
- This is the only test. The other comparisons are descriptive, with their intervals.

## Descriptive comparisons (pre-stated, no tests)

1. C vs chance: lift, plus a PR-cluster bootstrap interval with 2000 resamples.
2. C vs static: the per-PR difference, with a cluster bootstrap interval.
3. C vs LLM delivered, on the design set only.
4. Does coverage separate the LLM's hits from its misses? Design set only. Every saved LLM missing_test finding is counted, hidden or delivered. Each is labelled "confirmed" if its cited line is executable and not executed, "contradicted" if executed, or "unknown" if the line is not instrumented. For each label, report the count and the catch rate.
5. Noise on controls: the share of changed units that C flags, C flags per control PR, and the same for static.

## Corpus

- **Design.**
  - Holdout 2's replay-eligible pairs in runnable repos: 15 pairs (hono 6, sqlglot 3, langchain 3, rqlite 3).
  - 6 of them pass the test-gap filter: hono 2, langchain 2, rqlite 2 (one shared fix). None are from sqlglot.
  - Both rows are reported: the 6 test-gap pairs, and all 15.
  - n is too small for the design numbers to steer anything except defect fixes. They are reported, not used for power.
  - Design controls: holdout 2's clean `no_known_bug` PRs in these repos.
- **Confirmation.**
  - The frozen 88 (`testgap-confirm.json`) keep at most 6 bug PRs per repo, so the runnable repos contribute at most 24. That is fewer than 30, so E1 needs its own draw. This draw is E1's choice.
  - E1 confirmation set:
    - every frozen-set bug PR in hono, sqlglot, langchain and (if included) rqlite;
    - then further qualifying pairs from the same mining output (`SpecGuard-evidence/testgap-confirm/mine-*.json`, fixes from 2026-01-01 to the clone HEAD), under the same mechanical filter and exclusions. They are drawn round-robin over these repos in alphabetical order, newest first, until there are 40 bug PRs.
    - If fewer than 40 qualify, the window is extended back to 2025-07-01 in one fixed step. If there are still fewer than 30, the result is "not tested".
  - Controls: the frozen set's controls in these repos, topped up with `szz.js clean` (seed 20261020) to 30, under the same 90-day blame exclusion.
  - The list is written to `eval/replay/coverage-e1-confirm.json` and committed before any coverage run on it. The commit message carries the touch rule: nothing touches the set except the builder.
- **Ownership.** E1 owns the single look at the frozen-set PRs in these repos. The slicing draft stays paused. The slicing draft keeps its claim on the frozen-set PRs in the other repos, but the slicing prereg would need a new draw for any repo E1 has used.

## How the result reads (fixed now)

- **C does not pass:** on this corpus, coverage gaps at PR time do not predict where test-gap bugs are introduced. This is a real negative for the goal's premise. It is reported as such, and it goes into the multiplicity list and the assurance case.
- **C passes and comparison 4 separates** (the confirmed catch rate is above the contradicted catch rate, with non-overlapping cluster intervals on the design set): this supports product phase 1. Coverage-backed missing_test becomes a first-class finding; LLM-only missing_test is labelled unverified.
- **C passes but does not beat static** (lower bound of C − static ≤ 0): "a name lookup does as well; coverage adds no location value". Phase 1 still needs a separate cost/benefit decision.
- **Scope:** the claim covers only these repos, their unit-test commands, and coverage at I's head. It says nothing about the model.

## Multiplicity

The final report lists every attempt, as in `testgap-evidence-2026-10-20.md`, and adds E1.

## TBD before freeze

- The grepTests fix sha (`testgap-score.js`).
- The coverage runner sha: a script in the f2p harness or in `eval/replay`.
- The design run results, as a dated appendix that changes no gate.
- The confirmation list sha.
- rqlite included or excluded.
