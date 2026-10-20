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
- Runs are serial, keeping at least 1.2 GB of RAM free.

## Repositories and unit tests

The runner is `cover` in specguard-33's f2p harness (#416, merged into main at 26735ba). Rows are imported with `import` as (repo, buggy sha = I's head) under `--set <name>`, then run with `cover --set <name>`.

| Repo | Unit tests run with coverage at I's head | Report |
|---|---|---|
| honojs/hono | `src/**/*.test.{ts,tsx}` (file_re `\.test\.tsx?$`), runtime-tests excluded (vitest, v8, lcov, no e2e). The `.tsx` files are JSX unit tests (22 files, about 1090 tests); leaving them out would fake gaps in JSX code. #416 runs exactly this set (124 selected = 124 run at hono HEAD). Known env fact: `jsx/context-isolation.test.ts` fails when run without the `.tsx` set. | lcov |
| tobymao/sqlglot | the harness's unit scope (pytest under coverage) | Cobertura |
| langchain-ai/langchain | `libs/core` only (langchain_core unit tests); the env exists only for that package | Cobertura |

**rqlite is excluded from E1** (e0, 2026-10-20). The cgo build needs about 2 GB of RAM plus 1–2 GB of Go cache, which is not worth the risk for a first look, and its f2p controls have not been rerun under amendment 6/7 rules.

**langchain scope.** A langchain pair is eligible only if every changed source file of I lies under `libs/core/`. This is fixed now, before any draw.
- A source file is a code file that `isProd` accepts, outside `.github/`. Docs, lockfiles, CI scripts and test files don't count.
- In design this keeps langchain-33461 and langchain-18592. 18592's files outside core are docs and tests; an earlier draft wrongly listed it as dropped (corrected before any outcome look).
- It drops langchain-33817 (`libs/langchain_v1`).

**What counts.**
- Executed means a hit count above 0 on the line in the report (`src/coverage.js` parsers).
- A line the report does not instrument is not executable and is ignored.
- A changed definition with 0 instrumented added lines is not a unit for C. These are counted and reported.

**Suite health** is recorded for every PR from the `cover` report: passed, failed, file errors by kind (per test file), skipped, exit code, number of selected test files, `deps_changed`, and tool versions.
- File error kinds (labelled by the harness): `collection` (a collection or import error), `empty` (a helper file with no tests, e.g. hono's "No test suite found"), and `other`.

**deps_changed.** The f2p venvs were built for older trees, so `deps_changed` is already true at clone HEAD for sqlglot and langchain (the #416 smoke run), and it will be true for many E1 PRs. It is reported per PR and **never excludes a PR on its own**. Whether a PR is usable rests only on the rules below. C's catch rate is also reported split by `deps_changed`, as descriptive only.

**Unusable PRs.** These count as a miss for C: observed 0, and the null places 1 flag, so unusable PRs pull lift down. A sensitivity with unusable PRs dropped is descriptive only. The count and reasons are reported per repo:
- no report;
- 0 selected test files;
- the report covers none of I's changed source files;
- **a file error of kind `collection` in a test file that names a changed source file's module or sits in the same directory as its test counterpart.** Such an error removes coverage the file would have given, which would make fake gaps. This option (unusable) was chosen over dropping only that file's flags. Errors of kind `empty` or `other` do not make a PR unusable; they are counted.

Failing tests do not make a PR unusable; their count is reported.

## Arms (scored on the same PRs)

- **C (coverage, deterministic).**
  - Definition units are I's changed definitions (`testgap-score.js` units: `enclosingName` spans, plus one top-level unit per file).
  - C flags a unit if it has at least one added executable line that no unit test executed.
  - The flag is placed at the first such line.
- **Static (name lookup)**, carried over: flag a changed definition whose name appears in no test file at I's head. It uses `git grep -lw`, with the grepTests bug fixed first.
- **LLM delivered.** Design look only, from the saved holdout-2 haiku runs (3 runs). No new model runs are made.

## Catch rule, nulls, test

- **Catch:** the same as `testgap-score.js`. A flag (or finding) is a catch if it lies inside B, meaning the spans of the definitions that enclose the blamed lines, or within ±3 lines of a blamed line.
- **Unit of analysis:** the PR. C and static are deterministic, so each counts 1 run per PR.
- **Nulls:**
  - Primary: function-level, weighted by added lines.
  - Secondary: uniform.
  - Each arm's own flags are permuted among the units that arm could flag, as distinct units drawn without replacement (each arm flags a unit at most once): 1000 permutations, seed 20261020. The verdict uses the null with the higher chance.
    - C: units with at least 1 instrumented added line; a flag goes on a random instrumented added line. Weights are instrumented added lines (primary) or 1 (secondary).
    - static: named changed units.
    - An unusable PR: 1 flag over all changed units.
    - If an arm flags every unit it could flag, chance equals observed.
- **PASS for C iff both:**
  - the one-sided within-PR permutation p is below 0.05; and
  - observed − chance is at least 10 points.
- This is the only test. The other comparisons are descriptive, with their intervals.
- **A high raw catch rate is not value.** An arm that flags (almost) every changed definition has chance ≈ observed: the within-PR null permutes its flags over the same changed units. So it earns no lift, and the null penalises it correctly. The same mechanism capped the model's location ceiling: un-demoting every hidden finding raised chance from 2.7% to 20% (eval/testgap-demotion @bdd2f9a). C's raw catch rate must therefore never be read or reported as value without its chance level next to it.

## Descriptive comparisons (pre-stated, no tests)

1. C vs chance: lift, plus a PR-cluster bootstrap interval with 2000 resamples.
2. C vs static: the per-PR difference, with a cluster bootstrap interval. The static arm has no unusable state, so this comparison also reports how many PRs are unusable for C only (a penalty static does not carry).
3. C vs LLM delivered, on the design set only.
4. Does coverage separate the LLM's hits from its misses? Design set only. Every saved LLM missing_test finding is counted, hidden or delivered. Each is labelled "confirmed" if its cited line is executable and not executed, "contradicted" if executed, or "unknown" if the line is not instrumented. For each label, report the count and the catch rate.
5. Noise on controls: the share of changed units that C flags, C flags per control PR, and the same for static.
6. C's catch rate and chance split by `deps_changed` (true / false).

## Corpus

- **Design look.** Holdout 2's replay-eligible pairs in hono, sqlglot and langchain-core: hono 6, sqlglot 3, langchain 2 (33461, 18592). That is **11 pairs** (`coverage-e1-design.json`), plus holdout 2's clean `no_known_bug` controls in these repos (hono 3, langchain 1). The scorer reports how many pass the test-gap filter.
  - The look reports, for all 10 and for the filtered 3: C's catch rate vs chance, the unusable rate and reasons, flags per PR, and noise on the holdout-2 clean `no_known_bug` PRs in these repos.
  - **Power** for the confirmation n against the +10 floor comes from resampling the 11 design PRs. If it is below 0.5, it is reported to e0 and the owner before the confirmation run.
  - The design look changes no gate. Like the slicing draft, it is a dated appendix after the freeze, and defect amendments follow the same rule.
- **Confirmation.**
  - The frozen 88 (`testgap-confirm.json`) keep at most 6 bug PRs per repo, so these repos contribute at most 18. E1 draws its own set:
    - every frozen-set bug PR in hono, sqlglot or langchain-core;
    - then further qualifying pairs from the same mining output (`SpecGuard-evidence/testgap-confirm/mine-*.json`, fixes from 2026-01-01 to clone HEAD). These use the same mechanical filter, exclusions and langchain-core rule, drawn round-robin over the three repos in alphabetical order, newest first, until there are 40.
    - If fewer than 40 qualify, the window extends once to 2025-07-01. Fewer than 30 then means "not tested".
  - **Unfiltered comparison set (descriptive).** Up to 20 runnable bug PRs from the same mining output that pass every rule EXCEPT the test-gap filter (their fix adds no test naming a changed definition). They are drawn by the same round-robin rule.
  - **Controls.** The frozen set's controls in these repos, topped up with `szz.js clean` (seed 20261020) to 30, under the same 90-day blame exclusion and langchain-core rule.
  - All three lists go to `eval/replay/coverage-e1-confirm.json`, committed before any coverage run on them. The commit message carries the touch rule.
- **Ownership.** E1 owns the single look at the frozen-set PRs in hono, sqlglot and langchain-core. The slicing draft stays paused, and would need a new draw for those repos.

## How the result reads (fixed now)

- **Scope of every reading:** "on bugs that were later fixed together with a new unit test naming the changed definition", in hono, sqlglot and langchain-core, with the harness's unit scope. Nothing is claimed about the model or other repos.
- **C does not pass:** on this corpus, coverage gaps at PR time do not predict where test-gap bugs are introduced. This is a real negative for the goal's premise, reported as such and added to the multiplicity list and the assurance case.
- **C passes:** product phase 1 goes ahead. Coverage-backed missing_test findings become first-class and high-confidence.
- **C passes but its catch rate on the unfiltered comparison set is at chance** (its cluster interval of observed − chance includes 0): the lift is mostly a product of the selection filter, which favours untested definitions. The reading must say so.
- **C passes but does not beat static** (lower bound of C − static ≤ 0): "a name lookup does as well on location". Phase 1 still uses coverage, because the static lookup cannot see execution.
- **Comparison 4 (does coverage separate the LLM's hits from its misses?) is descriptive and decides nothing.** It uses at most 11 design PRs. It only informs whether LLM-only missing_test findings that coverage contradicts should be hidden; that is a product choice with its own later check.
- **Noise ceiling (fixed now):** the median number of C flags per control PR is at most 2. The share of control PRs with any flag is always reported. If C passes and is over the ceiling, the result reads "PASS (location), noise above ceiling".

## Multiplicity

The final report lists every attempt, as in `testgap-evidence-2026-10-20.md`: the mutation pilot (#374), #397, f2p (#410), the retired `prereg-testgap-mvp.md`, pack arms R/S/O/H (#406), the paused slicing draft, and E1.

## TBD before freeze

- ~~The grepTests fix sha~~: done, b6accfd on eval/testgap-demotion (`testsName`, with a test that fails with `-q`). E1 code builds on that branch.
- ~~The `cover` runner sha~~: done, #416 merged at 26735ba (file errors by kind; hono runs exactly `src/**/*.test.{ts,tsx}` minus runtime-tests). `file_errors` is already keyed by path with `{kind, msg}`. The findings-free `import` is #419, merged at b8f1357; the runs use a worktree of main at that sha.
- ~~Scorer and design rows~~: done, bce5f46 (`coverage-e1-score.js`, its synthetic test, `coverage-e1-design.json`: 11 bugs, 4 controls).
- Design-look command (set `e1design`; the runner on main @ b8f1357, the scorer from this branch):
  1. `node eval/f2p/f2p.js import eval/replay/coverage-e1-design.json --name e1design`
  2. `node eval/f2p/f2p.js cover --set e1design`
  3. `node eval/replay/coverage-e1-score.js --pairs eval/replay/holdout2-pairs.json --fixshas <evidence>/blind-h2/fixshas.json --repos <evidence>/repos --cover-results eval/f2p/results-cover-e1design.json --cover-dir <evidence>/f2p/cover/e1design --rows eval/replay/coverage-e1-design.json --out <evidence>/e1/design.json --raw <evidence>/blind-h2/raw --runs 39120706885,39120718089,39120729276`
- The confirmation list sha.
- The design-look appendix comes after the freeze.
