# Fail-to-pass (F2P) execution oracle

Pre-registered protocol. First measurement of assurance-case node G4: "a test written to a SpecGuard `missing_test` / `weak_test` finding fails on the buggy version and passes on the fixed version" (SWT-bench method). No adoption decision rides on it. This file is committed before any oracle run. The candidate counts and the power numbers below come from metadata and git diffs only (`node eval/f2p/f2p.js candidates`, then `power`); no test was written and no outcome exists yet.

Placeholders: `<evidence>` is the local evidence root (outside the repo). Generated tests, exported trees, dependency installs and packets live under `<evidence>/f2p/`. The repo holds only code, this README and manifests of ids, hashes, statuses and verdicts. No third-party source and no generated test text is committed.

## Replay arm (unit = one deduplicated finding)

Bug set: `eval/replay/holdout2-pairs.json`, the 45 `replay_eligible` pairs. Raw replay outputs: `<evidence>/holdout2-raw/<run>/replay-<replay_id>/`. The three runs that contain the 45 bug PR dirs are the three reps (rep order = ascending Actions run id: 39120706885, 39120718089, 39120729276).

### Candidate pool

All reps 1-3. Every finding of kind `missing_test` or `weak_test` from two sources per PR-run: `ctx/findings.json` `findings[]` (model findings, including low confidence), and `ctx/counts.json` `sum[]` entries not already present there (the deterministic "assertion removed" summary findings); for those the body is the summary bullet text of `summary.md`. Deduplicated within a PR by path + line + title (first rep's run kept, all reps recorded). Finding id = sha256 of `run|pr|path|line|title`. Result: 39 of the 45 PRs have at least one candidate (pydantic, trpc, cli have none).

### Trees

Fixed tree = the fix PR's merge or squash commit, found on the clone's HEAD by subject `(#N)` or `Merge pull request #N`; for rebase merges (rqlite-2318, -2313, -2061) by GitHub's `merge_commit_sha`, accepted only when it is in the clone and its first-parent diff has the PR's `changed_files` count. Buggy tree = its first parent. The method is recorded per PR (`sha_method`) in `holdout2-candidates.json`. All 45 resolved. Trees are exported with `git archive` (no `.git`, no history).

### Arms (all from reps 1-3, N = 20 fixed now)

Hunks = old-side ranges of `git diff --no-renames -U0 <parent> <fix>` (a pure insertion counts as the line it follows). Distance = lines from the cited line to the nearest hunk of the cited file (0 inside a hunk).

- NEAR (treatment): the cited path is a file the fix touched and the distance is <= 20.
- FAR (primary control): the cited path is a file the fix touched and the distance is > 20 for every hunk (a touched file with no old-side hunk, i.e. added by the fix, is FAR). Same file, not about this fix, so it can pass.
- UNTOUCHED: the cited path was not touched by the fix. UNTOUCHED was not run: structural zero by construction.
- Unit-touched weak_test: a `weak_test` whose cited test file was not touched but whose unit source file (same directory, same stem with the `.test`/`.spec`/`_test`/`test_` marker removed) was. Own subgroup, reported apart, in neither NEAR nor FAR.
- Excluded, no line: a finding on a touched file with no integer line cannot be placed; counted and reported, not run.

Known limit: the cited line comes from the introducing PR's head while hunks are in fix-parent coordinates, so lines can drift when the file changed in between.

Sensitivity: the table is also reported at N = 10 and N = 40 by reclassifying the same runs (no new runs; everything touched-with-line is run, so no reclassification needs a new test).

Counts (actual, from `holdout2-candidates.json`):

| arm | findings | PRs |
|---|---|---|
| NEAR | 38 (35 missing_test, 3 weak_test) | 14 |
| FAR | 62 (45 missing_test, 17 weak_test) | 20 |
| UNTOUCHED pool (for the record, not run) | 89 (78 missing_test, 11 weak_test) | 23 |
| unit-touched weak_test | 0 | 0 |
| excluded, no line | 0 | 0 |

Sensitivity (NEAR / FAR): N = 10: 28 / 72; N = 20: 38 / 62; N = 40: 48 / 52.

Per-repo (NEAR + FAR): orpc 5 + 3, sqlglot 0 + 1, rqlite 0 + 13, gitea 14 + 6, pydantic-ai 1 + 16, query 2 + 1, hono 9 + 17, vitest 7 + 0, langchain 0 + 5.

### Power (simulated, no clustering, upper bound)

`node eval/f2p/f2p.js power`: minimum detectable NEAR-FAR difference at 80% power, Fisher two-sided alpha 0.05, per-finding binomial simulation, seed 1, 2000 sims, n_NEAR = 38, n_FAR = 62 (before dropping `unrunnable`, which makes it worse):

| control rate p0 | MDD |
|---|---|
| 0.02 | 18 pp |
| 0.05 | 21 pp |
| 0.10 | 24 pp |

Rule fixed in advance: if the MDD at p0 = 0.05 is greater than 30 pp the comparison is descriptive and no inferential claim is made. It is 21 pp now; it is recomputed on the runnable counts at report time, and that recomputed value decides (the PR-cluster bootstrap below is the more honest interval, because findings of one PR are not independent).

### Blinding (and its limits)

Writers (phase B, separate agents) get one packet per PR: the finding fields verbatim (kind, title, body/rationale, counterexample and quote if present, path, line), the exported buggy tree path, the repo test command and where to save the test. A packet does NOT show the fix title, fix diff, fix commit message, bug card, the fix-touched flag, the distance or the arm; NEAR and FAR findings are mixed in each packet and shuffled with seed 1. The buggy tree has no history. Writers may run the repo's tests on the buggy tree. Limits: the tree is the real project, so a writer can reason about likely bugs from the code; the finding text was produced from the introducing PR, which a writer might recognise; the fixed tree is never shown; nothing stops a writer fitting a test to the finding wording rather than the defect, which the claim-match step checks. A finding's own location in the buggy tree hints at nothing about the arm beyond what the finding says.

### Running

A test is a NEW file next to the existing tests. `run` copies it into a temp copy of the buggy tree and of the fixed tree and runs the per-repo test command for that file with a whitelisted environment and a timeout. Each test runs 3 times on buggy and 3 times on fixed. Per-run outcome: `pass`, `assert_fail` (assertion failure; the hono runner reuses the classification of `eval/mutation/mutate.js`, other runners use the equivalent assertion markers) or `error` (compile, import or collection error, a thrown non-assertion error, a timeout).

Tree result = the common outcome of its 3 runs, or `mixed`.

### Verdicts (exact)

- `unrunnable`: the repo's own test command for that test file cannot run green at the buggy tree at baseline, with the new test absent. Reason recorded per repo.
- `invalid`: any run of the new test has outcome `error` on buggy or on fixed (reason recorded: compile/import/collection/non-assertion throw).
- `flaky`: any tree result is `mixed` and no run errored. Reported separately; never a hit.
- `verified`: buggy = `assert_fail` on all 3 runs and fixed = `pass` on all 3 runs.
- `reversed`: buggy `pass` on all 3, fixed `assert_fail` on all 3.
- `not_discriminating`: everything else (pass/pass, or assert_fail/assert_fail, on all runs).

### Claim match

For every `verified` test a separate labeller agent sees the finding text, the test file and the failing assertion output on buggy, and NOT the fix diff, fix title or tree. It labels `claim_match` yes, no or unsure with a one-line reason. Pre-registered labeller prompt:

> You are checking whether a test actually tests what a code-review finding claimed. Input: (1) a finding (title, body, path, line, optional counterexample), (2) a test file, (3) the assertion failure output when the test ran on a version that has a defect. Question: is the subject of the failing assertion the same behaviour the finding says is untested or weakly tested? Answer `yes` if the failing assertion checks the behaviour the finding names; `no` if the test fails for a different behaviour than the finding claims (it merely happens to fail on the defect); `unsure` if you cannot tell from this material. Do not guess what the defect was. Output exactly: `claim_match: yes|no|unsure` then `reason: <one line>`.

`results.json` carries `claim_match` and the one-line reason per verified finding.

### Headline measures

- Primary: NEAR vs FAR rate of (`verified` and `claim_match = yes`) over runnable findings (runnable = not `unrunnable`). Report each rate with a Wilson 95% interval, the difference with a two-sided Fisher exact test at alpha 0.05, and a PR-cluster bootstrap 95% interval for the difference (seed 1, 2000 resamples of PRs). Findings are clustered by PR, so the bootstrap interval governs interpretation.
- Also: `verified` with `claim_match` no and with unsure, reported separately; `flaky`, `reversed`, `invalid`, `not_discriminating`, `unrunnable` counts per arm and per repo; the unit-touched weak_test subgroup; the N = 10 / 40 sensitivity table.
- NEAR PRs with at least one headline hit / PRs with a runnable NEAR finding, Wilson 95%, noting n below 30 when fewer than 30 PRs are runnable (NEAR covers 14 PRs, so n < 30 is certain).
- Arms are never pooled.

## Mutation arm (hono at 5ca49b0): descriptive only

Candidates: the 16 `missing_test` / `weak_test` findings (10 missing_test, 6 weak_test) of scan run 39187431386 on the 14 manifest units (`hono-candidates.json`; 2 weak_test findings, `jwk/index.test.ts` and `color.test.ts`, have no manifest unit and can only be `invalid` or `not_discriminating`). The test is written against the UNMUTATED tree at 5ca49b0; the packet carries the finding and the tree only, no mutants, no survivor list.

- `invalid`: fails on the unmutated tree on any of 3 runs.
- `verified`: passes on the unmutated tree on 3/3 runs and kills (assertion failure on all 3 runs of that mutant) at least one `survived`, non-uncertain mutant of its unit (10 such survivors exist across the candidate units).
- Kills of `uncertain` survivors are reported separately.
- Each mutant run is repeated 3 times; a mixed result is `flaky`, not a kill.
- There are 10 candidate survivors and no meaningful null, so NO rate and no interval is claimed, only counts and per-finding results.

## Per-repo commands and environments

Chosen by feasibility, time-boxed to about 20 minutes per repo, recorded in `repos.json` with the reason when a repo is unrunnable. TS/JS: install with `--ignore-scripts` outside the tree. Python: venv under `<evidence>/f2p/env`. Go: module cache under `<evidence>`. A repo that does not run at baseline marks all its candidates `unrunnable`. Baseline: the existing test file nearest each candidate path runs green at the buggy tree.

## Subcommands (`node eval/f2p/f2p.js`)

`candidates`, `power`, `export`, `packets`, `run`, `report`. `run` writes `eval/f2p/results.json` (ids, test-file hashes, statuses, verdicts, reasons, claim_match; no test text).

## Amendments

Amendment 1 (before any oracle run; after red-team review of the first commit). It supersedes the "Power" section, the claim-match prompt and the verdict list where they differ.

### A) Clustered power decides

The unclustered MDD above treats 38 NEAR findings from 14 PRs as independent, which contradicts the PR-cluster analysis, so it overstates power and is not used for the decision (kept for reference). `node eval/f2p/f2p.js power` now simulates clustered data with the actual per-PR finding counts of NEAR (38 findings, 14 PRs) and FAR (62, 20 PRs): a PR's true rate is Beta with mean p (FAR: p0; NEAR: p0 + delta) and intra-PR correlation ICC, drawn independently per arm and PR; each finding is Bernoulli(that rate). The test inside the simulation is the governing analysis: the PR-cluster bootstrap 95% interval of NEAR - FAR excludes 0. Seed 1, 1000 simulations x 1000 resamples, delta searched on a 1 pp grid (binary search).

MDD at 80% power:

| p0 | ICC 0.1 | ICC 0.3 | unclustered Fisher (not used for the decision) |
|---|---|---|---|
| 0.02 | 20 pp | 24 pp | 18 pp |
| 0.05 | 25 pp | 27 pp | 21 pp |
| 0.10 | 27 pp | 34 pp | 24 pp |

Rule fixed in advance: the clustered MDD at p0 = 0.05 and ICC = 0.3 decides. If it is greater than 30 pp the comparison is DESCRIPTIVE ONLY (no inferential claim; the Fisher p is reported only as descriptive). If it is 30 pp or less the result is inferential. It is 27 pp now, so inferential on the candidate counts; it is recomputed at report time on the runnable counts (`report`) with the same rule and the recomputed value decides. Power at that point is small enough that only a large effect is detectable; a null result will not show absence of an effect.

### B) `verified_throw` (secondary measure; the primary stays assertion-only)

- A test that is collected and runs, throws a non-assertion error on buggy 3/3 and passes on fixed 3/3 is `verified_throw` only if the throw originates in code under test: the innermost stack frame (or panic site) that is not a framework, runtime or dependency frame (node_modules, node:, site-packages, Go module cache/GOROOT, pytest/vitest) must be repo production source, not a test file, helper, fixture or setup file; frames above it can then only be framework frames. That top production frame (path:line) is recorded in `results.json`.
- A throw from the test's own file, setup or fixture, or from a bad call (a message such as "x is not a function", wrong arity or unexpected keyword, missing import or attribute), stays `invalid`. Compile, import and collection errors stay `invalid`. A throw on fixed is `invalid`. Throws on buggy but assertion failure on fixed is `not_discriminating`; mixed repeats are `flaky`.
- `api_shift`: if the fix diff changes a declaration line (def/function/func/fn/method/arrow-function declaration, including its parameter list) of the function containing the recorded top production frame, or of a function the test file calls directly (any identifier called with `name(` in the test), the result is `api_shift`. It is reported separately and kept out of both measures.
- Measures: primary = `verified` (assertion) and `claim_match = yes`. Secondary = (`verified` or `verified_throw`) and `claim_match = yes`. Same arms and statistics for both.
- Logic: `eval/f2p/verdict.js` (`throwOrigin`, `signatureChanged`, `verdict`), covered by `eval/f2p/f2p.test.js`.

Amended labeller prompt (the first sentence of the answer rule and the inputs change; everything else is as before):

> You are checking whether a test actually tests what a code-review finding claimed. Input: (1) a finding (title, body, path, line, optional counterexample), (2) a test file, (3) the failing assertion or the thrown error, and its top production frame, when the test ran on a version that has a defect. Question: is the subject of the failing assertion or thrown error the same behaviour the finding says is untested or weakly tested? Answer `yes` if it checks the behaviour the finding names; `no` if the test fails for a different behaviour than the finding claims (it merely happens to fail on the defect); `unsure` if you cannot tell from this material. Do not guess what the defect was. Output exactly: `claim_match: yes|no|unsure` then `reason: <one line>`.

### Reporting commitments (amendment 2)

- `report` gives per-arm (NEAR / FAR) counts for each exclusion class: `api_shift`, invalid by bad call, invalid by test/setup/fixture throw, invalid by throw on fixed, other invalid, `flaky`, `unrunnable` (invalid by compile/import/collection error is listed too).
- Reason: a NEAR fix touches nearby code and is more likely to change signatures, so the exclusions can bias NEAR downward.
- One sensitivity line per measure for NEAR and FAR: "every excluded test (api_shift, and the invalid classes except compile/import/collection error) whose claim_match is yes is counted as verified". To support this the labeller also labels those excluded tests (same prompt, same inputs; for a throw the thrown error and its top frame).

### Scope and isolation (amendment 3)

- UNTOUCHED was not run: structural zero by construction. No packet and no test exists for it; the pool count (89) stays in the counts table for the record. Scope is NEAR + FAR (100 findings in 29 PRs) and the 16 hono mutation-arm findings. A PR whose only findings were UNTOUCHED has no packet.
- `export` writes only buggy trees, to `<evidence>/f2p/trees/<id>/buggy`; packets name only that path. No fixed tree is written under `trees/`.
- Fixed runs: for Go and Python the fixed tree is exported with `git archive` into a fresh temp directory after the writer has finished, the 3 fixed repeats run there, and the directory is deleted. For JS/TS monorepos dependencies are installed once in a work directory (`<evidence>/f2p/work/<repo>`), because workspace links resolve to real paths inside the install tree; there the fixed runs overlay the fix's changed files (read with `git show`) onto the work directory, run, and the directory is restored to its base commit. In both cases fixed sources exist only during the fixed runs, and never in the writer-visible tree or packet.
- Before any fixed run, `run` records the sha256 of every submitted test file in `results.json` (`test_sha256_frozen`). It refuses to run when a test file differs from the recorded hash, also on a later re-run.
- A writer may iterate on the buggy tree until its test runs (no compile/collection error); the submitted version is frozen and is not changed after the fixed runs.
- Limit, stated honestly: the shared clones under `<evidence>/repos` hold full history, including the fix. Writers are instructed to read only their packet and buggy tree, but nothing enforces it at the filesystem level. For hono the mutants are applied by the harness at run time only; the writer gets the unmutated tree.

### Harness validation and deviations (amendment 4)

Written before any writer starts; the positive controls below were run on the harness only (no writer test exists).

- Positive control, per repo. For every in-scope PR whose fix adds or edits a test file, each such fix test file is run through the identical harness: the fix's version is copied into the buggy tree and run 3 times, then run 3 times on the fixed tree, with the same verdict logic. Expected: `verified` (or `verified_throw`). A PR is a control success when at least one of its fix test files is `verified` or `verified_throw`. Per repo k/n = control successes / runnable controls (PRs with a fix test file and a runnable repo). Below 80%: the repo is "harness invalid" (its NEAR and FAR results are reported but excluded from the measures). No control at all: "harness unvalidated" (stays in, flagged). Per-PR results are in `results.json` under `positive_control`. Fix tests never appear in packets and are never shown to writers. Controls run before any writer starts, so the dependency work directory is never in an overlaid state while a writer is active.
- Whole-fix overlay (JS/TS): the overlay applies the whole fix (added, modified and deleted files, from `git diff --name-status --no-renames`). After overlaying, every path of the diff is checked byte-for-byte (sha256) against `git archive` of that revision (absent if deleted there); the run refuses on any difference. Archive content is used rather than raw blobs because the clones convert line endings in `git archive`.
- Restore check: after the fixed runs the work directory is restored to its base commit and the same check is made against the base; the run refuses on any difference. `f2p.js verify <repo> [--repair]` checks a whole work directory.
- Writers and the overlaid state: a writer's `try` command works on the dependency work directory (JS/TS) or on a fresh temp export of the buggy tree (Go, Python), under a per-repo lock; `try` always moves the work directory to the buggy commit first, so a writer never sees an overlaid state. `run` skips a finding (and says so) until `f2p.js writers-done <repo>` has been recorded for its repo; for a list set the marker is per set (`writers-done <repo> --set <set>`, directory `writers_done-<set>`), so the holdout2 marker does not open a list set. The code records one marker per repo and set, not per writer: the caller must call it only after every writer of that repo in that set has finished.
- Rebuild and cache clearing: after every overlay and every restore the harness removes `node_modules/.vite`, `node_modules/.vitest`, `node_modules/.cache`, `.vitest`, `.turbo` and every `*.tsbuildinfo`, then runs the repo's `build` command if `repos.json` has one. The positive controls are what prove this works for a repo.
- `deps_changed`: if a fix changes a dependency manifest (package.json, a lockfile, pyproject, requirements*.txt, go.mod, go.sum) and the harness does not reinstall dependencies, that PR's fixed runs are not made: its rows get the verdict `deps_changed`, are EXCLUDED from the measures and are reported per arm. No reinstall is implemented. Candidate PRs with `deps_changed`: none (checked in `holdout2-candidates.json`, `prs[].deps_changed`).
- Dependency versions for Python repos are those installed today, not those of each fix commit; the per-PR baseline (nearest existing test file green at the buggy tree) is the check. A PR whose baseline is not green is `unrunnable`.

Positive-control results (run 2026-10-19/20 on the harness before any writer; `results.json` `positive_control`, `baseline.json`):

| repo | tree / runner | baseline green PRs | positive control k/n | harness | PRs and findings in scope |
|---|---|---|---|---|---|
| honojs/hono | overlay, vitest 3.2.4 | 6/6 | 6/6 | valid | 6 PRs, 26 replay findings (+16 mutation findings, same work dir) |
| rqlite/rqlite | temp export, go test (Go 1.25.3 then 1.26 by GOTOOLCHAIN=auto; cgo via zig cc) | 3/3 | 2/2 (rqlite-2061: the fix adds no test, no control) | valid | 3 PRs, 13 findings |
| tobymao/sqlglot | temp export, pytest | 1/1 | 1/1 | valid (n = 1) | 1 PR, 1 finding |
| langchain-ai/langchain | temp export, pytest (libs/core) | 1/1 | 1/1 (one fix test verified, one verified_throw) | valid (n = 1) | 1 PR, 5 findings |
| pydantic/pydantic-ai | temp export, pytest, dependencies as of today (two venvs) | 4/5 (3454: no tests collected) | 1/4 (7141 verified; 5020, 1812 and 5455 not verified in the last run) | invalid (< 80%): reported, excluded from the measures; no packets | 5 PRs, 17 findings |
| go-gitea/gitea | not set up | - | - | unrunnable (see `repos.json`) | 6 PRs, 20 findings |
| middleapi/orpc, TanStack/query, vitest-dev/vitest | not set up | - | - | unrunnable (disk and monorepo build; see `repos.json`) | 3 + 2 + 2 PRs, 8 + 3 + 7 findings |

pydantic-ai, from the data (`baseline.json`, `results.json`): baseline green on 4 of 5 PRs (3454 collects no tests at the nearest test file, so it has no runnable control); positive controls 1/4. 7141 verified; 1812 throws from the test frame on a snapshot mismatch; 5020 became not_discriminating/invalid after a second venv (cassetter instead of pytest-recording) fixed its baseline; the 5455 row is from a run cut off at the 1.5 GB disk floor, although 5455 was verified in an earlier run with the first venv. Causes are dependency drift (today's package versions against 2026 fix commits) and test plugins that differ between commits. The 80% rule is applied as pre-registered, not tuned.

### Harness bug fix (amendment 5, 2026-10-20, before any oracle outcome)

Harness bug found before any outcome existed: `repos.json` held a prose note in hono's `build` field ("none (single package, ...)"), and `rebuild` ran it as a shell command, so every hono `try` failed in setup and no hono writer could check its test. Fix: the note moved to `build_note`, so hono has no build step. Nothing else changed: no test was rerun, edited or replaced because of how it scored. After the fix:

- The 6 hono positive controls were rerun under the final harness (rebuild step included): 6/6 `verified`, the same as the earlier run.
- All 42 hono writer tests (26 replay, 16 mutation) were dry-run once on the buggy (unmutated, for the mutation arm) tree only, through `try`: 42/42 executed without a compile, import, collection or harness error. Only error versus no error was looked at; pass or fail on buggy was not read.

Shared-machine rule (from 2026-10-20): agents kill only process ids they started themselves, never by name or pattern. During phase A, node processes matching `--test` or `f2p` were killed by pattern while freeing the machine; that may have hit another session's test run.

Deviation recorded before the oracle run (2026-10-20): because `try` failed in setup, the hono writers wrote every hono test without feedback, while the rqlite, sqlglot and langchain writers had feedback. All 9 NEAR findings are hono, so writer feedback is confounded with the arm across repos. The within-hono NEAR vs FAR comparison is the primary descriptive comparison; the cross-repo comparison is reported but confounded by writer feedback. The hono tests are not rewritten.

## Results (2026-10-20, runnable scope: hono, sqlglot, langchain; rqlite not yet run)

Two harness changes were made after the first outcomes and change no verdict: `run --mutation` with no ids filtered out every finding (empty-list bug; fixed before the mutation arm ran), and the runners now keep the assertion failure text (`msg`) so the claim_match labeller can see it (outcome classification unchanged; the two verified tests were rerun on buggy only to capture it). A replay run of hono-3413 died mid-way on out-of-memory in `git archive`; its 5 unfinished findings were run once afterwards (the 3 finished ones were not rerun), and the hono work dir was verified identical to 5ca49b0 before and after the mutation arm.

**Decision rule:** clustered MDD at p0 0.05, ICC 0.3 on the runnable counts (NEAR 9 findings / 3 PRs, FAR 23 / 6 PRs) is 86 pp > 30 pp, so everything below is DESCRIPTIVE ONLY.

| arm | findings | runnable | verified | verified + claim_match yes (primary) | sensitivity (excluded + yes) | not_discriminating | reversed | invalid |
|---|---|---|---|---|---|---|---|---|
| NEAR (all hono) | 9 | 9 | 1 | **0** | 0 | 8 | 0 | 0 |
| FAR (hono 17, sqlglot 1, langchain 5) | 23 | 23 | 1 | **1** | 2 | 19 | 2 | 1 (throw on fixed) |

- Primary: NEAR 0/9 (Wilson 0-29.9%) vs FAR 1/23 (0.8-21.0%); Fisher p 1.0 (descriptive); PR-cluster bootstrap of the difference [-23.1, 0.0] pp.
- Within hono (the primary descriptive comparison, because writer feedback is confounded with the arm across repos): NEAR 0/9 vs FAR 0/17 primary; sensitivity 0/9 vs 1/17.
- The one NEAR `verified` test (hono-3727, `expandIPv6('::ffff:0.0.0.0')`) failed on buggy for a different defect than the finding claimed (labeller: `claim_match: no`).
- The FAR primary hit is sqlglot-7315 (TRY_TO_NUMBER to TRY_CAST in DuckDB; `claim_match: yes`).
- The sensitivity line counts hono-2339 (missing JwtHeaderInvalid rejection test; `claim_match: yes`) as the pre-registered rule says, but that test threw on BOTH trees, so it is not fail-to-pass in any sense. (Under the amendment-6/7 rules this test is `not_discriminating`, so the sensitivity line is now 0/9 vs 1/23; see amendment 7.)
- Exclusions per arm: no api_shift, bad_call, test-setup throw, flaky, unrunnable, deps_changed or harness-invalid in either arm; 1 FAR throw on fixed.
- Positive controls: hono 6/6, sqlglot 1/1 and langchain 1/1 (weakly validated, n = 1).

**Mutation arm (hono 5ca49b0, descriptive, no rate):** 16 tests written to the 16 scan findings; 2 `invalid` (fail on the unmutated tree), 14 pass on the unmutated tree and kill no surviving mutant (0 kills). The 2 invalid tests covered ipaddr and crypto, so the 14 valid tests faced 8 of the 10 candidate (strict) survivors and 6 of the 9 uncertain ones (9 distinct units). Only 3 of the 14 valid tests (body, html, stream) faced a strict survivor in their unit; 5 faced only uncertain survivors (url, cookie, accept, buffer x2); 6 had no surviving mutant of either kind in their unit (encode x2, basic-auth x2; jwk and color have no manifest unit). So a 0-kill result is weak evidence: at most 3 of the 14 tests could have killed a strict survivor at all. This agrees with the pilot's 0/10 line-level result. (Counts computed from hono-5ca49b0.json, hono-candidates.json and results.json.)

**Reading:** no finding near the fix produced a test that catches the bug for the reason the finding gave (0/9). Across 32 replay findings and 16 mutation findings, tests written from SpecGuard's missing_test / weak_test text caught a real defect for the stated reason once (sqlglot-7315, a FAR finding). This is G4 evidence against the claim at this scope, with wide intervals, public repos and one model writer. Caveat (the amendment 5 confound): 42 of the 48 tests (every hono test) were written without `try` feedback, so the pooled 1-in-48 comes mostly from no-feedback writers and is not a clean G4 estimate.

Not run: rqlite (13 findings; 6 tests not yet compile-checked, build stopped by machine memory), and the repos listed as unrunnable or harness-invalid above.

## List input (for other evals)

The harness can verify catches that come from another eval: the caller supplies, per finding, the buggy and the fixed commit and the finding text. Nothing here assumes a bug PR: `buggy_sha` and `fixed_sha` are whatever the caller supplies (the testgap prereg, "Secondary measure 3", uses the introducing PR's head as buggy and the fix commit F as fixed).

Input, a JSON array:

```json
[{ "id": "optional", "pr": "optional group name", "repo": "honojs/hono", "buggy_sha": "...", "fixed_sha": "...",
   "finding": { "kind": "missing_test", "path": "src/x.ts", "line": 12, "title": "...", "body": "...", "counterexample": "optional", "quote": "optional" } }]
```

Commands (a set is a lowercase name; every command that takes `--set <set>` works on `eval/f2p/<set>-candidates.json` instead of the holdout 2 files and writes `results-<set>.json` and `baseline-<set>.json`; without `--set` nothing changes for the existing sets):

```
node eval/f2p/f2p.js import list.json --name <set>      # writes <set>-candidates.json (+ the finding text under <evidence>/f2p/<set>-fields.json)
node eval/f2p/f2p.js export --set <set>                  # buggy trees only
node eval/f2p/f2p.js baseline --set <set>                # nearest existing test green at each buggy tree
node eval/f2p/f2p.js packets --set <set>                 # one blinded packet per group, same format as before
node eval/f2p/f2p.js try <finding-id> --set <set>        # writers
node eval/f2p/f2p.js writers-done <repo> --set <set>     # per set: the holdout2 gate does not open a list set
node eval/f2p/f2p.js run --set <set>                     # freeze, 3 buggy + 3 fixed runs, same verdict logic, same gates
node eval/f2p/f2p.js report --set <set>                  # per-finding verdicts and verified + claim_match yes over runnable
```

Rules. `id` defaults to sha256 of `set|repo|buggy|path|line|title`; `group` is `pr` or `<repo-name>-<first 8 of buggy_sha>` (it names the tree and the packet, so it must not carry fix information). Rows have the holdout 2 shape with `arm = "LIST"` and `in_oracle_set = true`, plus `status` and `reason`. Only repos in `repos.json` whose harness is valid (positive controls, 80% rule) are runnable (today: hono, rqlite, sqlglot, langchain); any other repo is recorded `unrunnable` with the reason, never dropped. A buggy or fixed sha that is not in the local clone under `<evidence>/repos` makes the row `unresolved`. `unrunnable` and `unresolved` rows get no packet and are listed by `report`. Blinding is unchanged: a packet carries the finding fields and the buggy tree path, never a fix sha, title or diff, and findings are shuffled with seed 1. `report --set` prints no NEAR/FAR arms and no power; the claim_match labels are filled in as for the other sets. Positive controls and the mutation arm stay holdout 2 only. The same disk guard, freeze (`test_sha256_frozen`), writers-done gate and fixed-tree isolation apply.

### Red-team fixes B1-B4 (amendment 6, 2026-10-20, no result changed)

Code and README fixes only; no row of `results.json` was changed and nothing was rerun.

- B1, stdlib frames. Go: a trace frame is the standard library, GOROOT or a dependency (and so skipped when finding the origin of a panic) when it is an absolute path outside the work tree, carries `@v`, or, in a `-trimpath` trace, has a first path element without a dot; a dotted element is a module path (the repo). A nil dereference inside a `_test.go` is origin `test`. `panic: test timed out` is an `error`; go test now gets `-trimpath -timeout 20m` (larger than the 900 s harness timeout). Python: Windows interpreter stdlib frames (`...\Lib\json\...`) and `lib/python3.x` paths are skipped. The traceback in a junit `<failure>` starts right after the tag; it is now put on its own line so its first frame is matched too.
- B2, set isolation. With `--set`, trees, packets and tests live under `trees/<set>/`, `packets/<set>/` and `tests/<set>/`; without it the paths are unchanged (packets regenerated byte-identically). `import` refuses an id that exists in any other candidate file (holdout2, hono, other sets), a group that exists in another set, and a group with more than one buggy/fixed pair. `export` writes `.sha` (the commit) into each tree; export, baseline, try and run refuse a tree whose `.sha` differs or is missing. `seal-trees` writes `.sha` into existing trees only after the tree matches `git archive` of its buggy sha byte for byte (symlinks of the archive are plain files on Windows and are not compared as extra files); a tree that does not match is reported and left alone. Result: 12 trees sealed (10 first, then sqlglot-7315 and langchain-18592 after I deleted the `__pycache__` my own manual test runs had written into them), 0 mismatches, 18 groups have no tree on disk (gitea, orpc, query, vitest, pydantic-ai).
- B4, skipped is not a pass. For Go and vitest a `pass` needs at least one non-skipped passing test, as for pytest; all-skipped is `error` ("all tests skipped"). The only verified vitest row, hono-3727, is unaffected: its frozen test file (8 lines, hash matches the recorded one) has no skip, todo or only marker, so its fixed runs executed a passing test. The other verified row is pytest (sqlglot-7315), which already had the rule.
- Also: pytest `DID NOT RAISE` and `pytest.fail` count as assertion failures; a file with both an assertion failure and a thrown error (pytest) or a non-assertion failure (vitest) is an `error`; a run over several test files is an `error` if any file errors (the old reduce let a first assertion failure hide a second file's error); the freeze now happens after every gate (writers-done, runnable, baseline, deps_changed) so a skipped or refused finding is never frozen; `--set` without a value and `--set=x` are refused; `CI=1` is set for every run so vitest never writes snapshots; a test file is placed only at a path that does not exist in the tree.
- Disk guard: it checks free space on the temp drive (`os.tmpdir()`) only, not on the evidence drive. It is called by every command that exports or checks out a tree: baseline, controls, try, run, run --mutation, export, setup and seal-trees. It is not called by packets, report, import, verify, candidates or power (they write only small files).

### Positive controls rerun under the amendment 6 and 7 rules (amendment 7, 2026-10-20, no writer test rerun)

Before the rerun the `positive_control` block of `results.json` was copied to `positive_control_pre_amendment6`, so the old values stay in the file. Amendment 7 adds four code rules, all tested: a vitest `rejects` failure ("promise resolved ... instead of rejecting") is an assertion failure; ids, groups and set names are letters, digits, `.`, `_`, `-` only and may not be `buggy`, `fixed`, only dots, an existing group or (for a group) an existing set; `archive` refuses an export whose tar did not run or whose file count differs from `git ls-tree -r` of the commit (a non-zero tar exit with every file present, the Windows symlink case, is accepted); an interrupted control (disk guard, memory, harness exception) is a `harness_error`, never replaces a completed result (kept under `positive_control_errors`) and is not in k/n.

The controls were rerun for hono, sqlglot and langchain only (local, no model calls; rqlite and pydantic-ai were not rerun, their old values stay: rqlite 2/2 under the old rules must be rerun before its writer rows, pydantic-ai stays invalid at 1/4). After the rerun the hono work directory was checked: 583 tracked files byte-identical to 5ca49b0.

| PR | file verdicts, before amendment 6 | file verdicts, now | PR control |
|---|---|---|---|
| hono-3604, 3787, 2339, 3413, 3366, 3727 | verified (one test file each) | verified | verified, unchanged |
| sqlglot-7315 | verified, verified | verified, verified | verified, unchanged |
| langchain-18592 | verified, verified_throw | invalid, verified_throw | verified, unchanged (one of its two fix test files now counts as invalid: assertion failure and a thrown error in the same file is an error) |

| repo | k/n before | k/n now | harness before | harness now |
|---|---|---|---|---|
| honojs/hono | 6/6 | 6/6 | valid | valid |
| tobymao/sqlglot | 1/1 | 1/1 | valid (n = 1) | valid (n = 1) |
| langchain-ai/langchain | 1/1 | 1/1 | valid (n = 1) | valid (n = 1) |
| rqlite/rqlite | 2/2 | not rerun | valid | valid under the old rules, to be rerun |
| pydantic/pydantic-ai | 1/4 | not rerun | invalid | invalid |

No repo changed validity, so no NEAR/FAR row left the measures and the Results table above is unchanged (no writer row was touched: the 48 rows are byte-identical to the committed ones).

### Which committed writer verdicts the new rules could change (amendment 7)

Every committed writer verdict was produced under the pre-amendment-6 rules. Checked against `results.json` and the frozen test files (48 writer rows: 42 hono including the 16 mutation tests, 5 langchain, 1 sqlglot):

- all 48 tests are single files, none has a skip, todo, only, xfail or parametrize marker;
- the 8 rows with any failing run are single-test files, so the new "assertion plus thrown error in one file is an error" rule cannot touch them; there is no pytest throw in the replay rows;
- 7 test files hold more than one test: 4 replay files (langchain 2, hono-3787, hono-3366) are pass/pass on both trees, 2 mutation files pass 3/3 on the unmutated tree and kill nothing, and 1 mutation file is invalid (its first unmutated run errored; a stricter rule cannot make it pass);
- so hono-3727, sqlglot-7315, hono-3604 (two reversed rows) and the mutation rows are unaffected.

One row was not covered by this argument: hono-2339's writer test uses `.rejects.toThrow` and threw on both trees under the old rules (verdict `invalid`, throw on fixed). Its buggy failure text had been captured for the labeller: "promise resolved ... instead of rejecting". Because the new vitest rule changes exactly that class, this one test was rerun once (3 buggy + 3 fixed) under the amendment-6/7 rules, after the controls and before any other run: assert_fail on both trees, verdict `not_discriminating`. The old verdict is kept in the row as `pre_amendment6`. Consequence: the sensitivity line drops from FAR 2/23 to 1/23 (NEAR unchanged 0/9); the primary and secondary lines are unchanged (NEAR 0/9, FAR 1/23). No other writer test was rerun.

The rules of amendments 6 and 7 govern all future rows, including rqlite and list sets, in the same `results.json`.

## Coverage (cover) for E1

`cover` runs the UNIT test suite of a tree under coverage so E1 can find changed definitions that no test executed. Suite failures on a buggy tree are expected and still produce coverage.

```
node eval/f2p/f2p.js cover [--set <set>] [group | repo | hono|sqlglot|langchain ...]   # every cover group of the set (default: holdout2 plus the hono mutation tree)
node eval/f2p/f2p.js cover head:hono                                                   # smoke: the shared clone's HEAD, nothing written to the repo
```

Each group runs on its `.sha`-verified tree (hono: overlay with verify and restore; pytest repos: fresh export), under the per-repo lock, the disk guard (here at least 5 GB free) and a RAM guard (at least 1.2 GB free), with the whitelisted environment and no shell (a timeout kills only the child PID).

Scope is the `cover` block of `repos.json`, written into every report:

| repo | dirs | files | source measured |
| --- | --- | --- | --- |
| hono (vitest, existing `vc.mjs`, not hono's own config) | `src` | `*.test.ts` and `*.test.tsx` (the JSX unit tests), `runtime-tests/` excluded; vitest runs exactly the selected files (generated include config) | `src/**` |
| sqlglot (pytest) | `tests` | `test_*.py`, `*_test.py` | `sqlglot` |
| langchain (pytest) | `libs/core/tests/unit_tests` | `test_*.py`, `*_test.py` | `libs/core/langchain_core` |

A missing dir or 0 selected test files is an error, never "0% covered". `deps_files` lists the manifests that matter for the env; `deps_changed` is true when one differs between the env's base sha (hono work dir `.base`; pytest repos `env_base`) and the tree.

Tools (installed into the existing envs only, never into a tree): `coverage==7.16.2` (`uv pip install --python <venv python> coverage==7.16.2`); hono `npm i --no-save --ignore-scripts --legacy-peer-deps @vitest/coverage-v8@3.2.4 vitest@3.2.4` in the work dir (hono's package.json declares vitest 5.0.1, so the plain command fails with ERESOLVE). Versions are recorded in each report.

Reports go to `<evidence>/f2p/cover/<set or holdout2 or smoke>/<group>/` (`lcov.info` or `coverage.xml`, the runner's own test report, `summary.json`). The repo gets only `results-cover[-<set>].json`: group, tree sha, scope, `selected_tests`, `health`, `file_errors`, `deps_changed`, `tools`, `report` (format, sha256, bytes) and `files` (covered and total lines per source file). No source text and no local paths (messages are scrubbed to one line).

Health fields: `passed`, `failed`, `errored` (collection/import/fixture errors, or vitest files that failed to load or have no result), `skipped`, `exit_code`, `timed_out`, `file_errors_by_kind` (`collection`: the file failed to load, its tests did not run; `empty`: the file has no tests; `other`: e.g. no result). `file_errors` maps each test file that failed to collect or import (repo-relative posix path, for example `src/utils/foo.test.ts` or `tests/test_x.py`) to a short message; collection and import errors silently zero a file's coverage, so E1 should exclude or flag the source files those tests cover. pytest runs with `--continue-on-collection-errors` so one broken file does not hide the rest.
