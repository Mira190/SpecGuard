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
- UNTOUCHED: the cited path was not touched by the fix. Run through the same pipeline and reported as a third column "structural zero, not a null". Never used in a comparison. If larger than NEAR, a seed-1 random sample of NEAR's size is run (mulberry32 over the pool sorted by id, Fisher-Yates); the pool size is reported.
- Unit-touched weak_test: a `weak_test` whose cited test file was not touched but whose unit source file (same directory, same stem with the `.test`/`.spec`/`_test`/`test_` marker removed) was. Own subgroup, reported apart, in neither NEAR nor FAR.
- Excluded, no line: a finding on a touched file with no integer line cannot be placed; counted and reported, not run.

Known limit: the cited line comes from the introducing PR's head while hunks are in fix-parent coordinates, so lines can drift when the file changed in between.

Sensitivity: the table is also reported at N = 10 and N = 40 by reclassifying the same runs (no new runs; everything touched-with-line is run, so no reclassification needs a new test).

Counts (actual, from `holdout2-candidates.json`):

| arm | findings | PRs |
|---|---|---|
| NEAR | 38 (35 missing_test, 3 weak_test) | 14 |
| FAR | 62 (45 missing_test, 17 weak_test) | 20 |
| UNTOUCHED pool | 89 (78 missing_test, 11 weak_test) | 23 |
| UNTOUCHED run (seed-1 sample of 38) | 38 | |
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

Writers (phase B, separate agents) get one packet per PR: the finding fields verbatim (kind, title, body/rationale, counterexample and quote if present, path, line), the exported buggy tree path, the repo test command and where to save the test. A packet does NOT show the fix title, fix diff, fix commit message, bug card, the fix-touched flag, the distance or the arm; NEAR, FAR and UNTOUCHED findings are mixed in each packet and shuffled with seed 1. The buggy tree has no history. Writers may run the repo's tests on the buggy tree. Limits: the tree is the real project, so a writer can reason about likely bugs from the code; the finding text was produced from the introducing PR, which a writer might recognise; the fixed tree is never shown; nothing stops a writer fitting a test to the finding wording rather than the defect, which the claim-match step checks. A finding's own location in the buggy tree hints at nothing about the arm beyond what the finding says.

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
- Also: `verified` with `claim_match` no and with unsure, reported separately; `flaky`, `reversed`, `invalid`, `not_discriminating`, `unrunnable` counts per arm and per repo; the UNTOUCHED column ("structural zero, not a null"); the unit-touched weak_test subgroup; the N = 10 / 40 sensitivity table.
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
