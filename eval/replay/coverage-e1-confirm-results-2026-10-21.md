# E1 confirmation results (2026-10-21)

Dated appendix to `prereg-coverage-gap-e1.md` (frozen at 2fffc35, red team specguard-e0). Run by specguard-33. Counts only. It follows the design-look appendix (`coverage-e1-design-appendix-2026-10-20.md`), and the confirmation set was scored once, with the E3 prereg's (`prereg-coverage-confirmed-e3.md`, frozen at 0a16765) shared run.

## Reading (per the prereg)

**C: FAIL.** On this corpus, coverage gaps at PR time do not predict where bugs are introduced. Per the prereg, this is a real negative for the goal's premise, reported as such and added to the multiplicity list and the assurance case.

**Scope:**
- The fallback applies. The primary population is all mechanically eligible SZZ bugs in hono, sqlglot and langchain-core, with the harness's unit scope: 40 = 16 filtered + 24 unfiltered.
- The filtered subgroup carries the test-gap scope.
- Nothing is claimed about the model or other repos.

## What ran

- **List:** `coverage-e1-confirm.json` at 2fffc35, 70 rows: 40 bugs, 30 controls.
- **Import and export:** 70/70 ok. The job list was checked before cover ran, and was exactly the 70 row ids. Each tree's `.sha` equals its row's buggy_sha.
- **Runner:** a fresh worktree of main at d737045 (amended freeze note (b)).
- **Cover, attempt 1** (`cover --set e1confirm`, started 2026-10-20):
  - Claude Code stopped the background shell that ran it for low memory. The node child process kept running as an orphan, and finished the group it was on (sqlglot-8585).
  - 21 groups got a report: 0 errors, 0 timeouts.
  - The other 49 (19 bugs, 30 controls) recorded an `error` with no report, at the first setup step: `git diff --name-status --no-renames <env_base> <tree_sha>` failed. No test ran for any of them.
  - The same command succeeded afterwards (hono-4214: exit 0, 523 lines). The cause was a transient spawn failure under memory pressure: about 0.7 GB of 15.7 GB was free.
- **Overlap:** the owner started the E3 haiku batch at about 22:15 on 2026-10-20, while attempt 1 was at 11/70 (accepted by the red team).
  - Batch prepare only reads the source clones (`clone --shared --no-checkout`; checkout and config happen only in the per-run clone).
  - The lock-error scan found 0 `index.lock` lines in the batch log and the rerun log.
- **Health rerun:** under the rule the red team fixed before any scoring, every group whose row has an error, a timeout or no report is rerun once. A group that fails again is unusable. There is no third attempt.
  - It ran 2026-10-21, 18:21–19:54, one group at a time, waiting for at least 1.5 GB free RAM before each group, so cover's 1.2 GB guard could not use up a group's single attempt.
  - Result: 49/49 ok, 0 failed again.
  - The attempt-1 rows were kept as `results-cover-e1confirm.json.before-rerun`.
- **Final results** `results-cover-e1confirm.json`: sha256 71a37cd3…54f8ea.
- **Hono verify:** `honojs/hono: 583 tracked files identical to 5ca49b07`.

### Scorer and the `--rows` amendment

The confirmation command was fixed by the red team at the E3 freeze: frozen step 3 with only `--rows`, `--cover-results` and `--cover-dir` changed; `--pairs` and `--fixshas` kept; no `--raw`, no `--power-n`; scorer at 2fffc35.

- **Defect:** run as fixed, the scorer exited 1 before writing anything, with `TypeError: rows is not iterable` at `coverage-e1-score.js:188`.
  - The scorer reads `--rows` as a bare array, like `coverage-e1-design.json`. But `coverage-e1-confirm.json` is an object, with the 70 rows under `.rows`.
  - The red team named this defect as its own: the fixed command was written against the wrapper object.
  - The 16-line stdout of that failed run (a stack trace) was deleted by mistake. The error line and cause above are the record.
- **Amendment** (defect-amendment rule, red team OK before any outcome was seen):
  - `--rows` points to `coverage-e1-confirm-rows.json`, which is `JSON.stringify(rows, null, 2)` of that file.
  - Before scoring, its 70 rows were checked to deep-equal `2fffc35:eval/replay/coverage-e1-confirm.json`.rows: same order, same fields, same key order.
  - The scorer, its logic and every other flag are unchanged.

| File | sha256 |
|---|---|
| source blob b7adc89 (`git show`, LF) | e97c5ca1…0de0c7 |
| source, CRLF working-tree copy | c60c0c5a…dc1bd59 |
| `coverage-e1-confirm-rows.json` | 8f32949b…7b68 |
| result `confirm.json` | 918d00a7…d5d13a |

## Scorer output (counts, as printed)

File error kinds over all 70 PRs: collection 46, empty 44, other 17.

| Set | PRs | unusable | C observed | C chance (verdict null) | p | effect | effect 95% CI | secondary null chance / p | C pass |
|---|---|---|---|---|---|---|---|---|---|
| all | 40 | 0 | 0.175 | 0.281 (primary) | 0.997 | −0.106 | [−0.214, −0.002] | 0.169 / 0.555 | false |
| filtered | 16 | 0 | 0.063 | 0.325 (primary) | 1 | −0.263 | [−0.448, −0.092] | 0.215 / 0.995 | false |
| unfiltered | 24 | 0 | 0.250 | 0.247 (primary) | 0.636 | +0.003 | [−0.102, 0.110] | 0.138 / 0.075 | false |

- `c_usable_only` equals `c` in every set (0 unusable).
- Units with no instrumented lines: all 131, filtered 38, unfiltered 93.
- Usable suite health:

| Set | with other errors | non-zero exit | timed out |
|---|---|---|---|
| all | 9 | 31 | 0 |
| filtered | 2 | 12 | 0 |
| unfiltered | 7 | 19 | 0 |

**By deps_changed (usable only), all:**

| deps_changed | PRs | observed | chance | p | effect |
|---|---|---|---|---|---|
| true | 39 | 0.154 | 0.268 | 0.998 | −0.114 |
| false | 1 | 1 | 0.752 | 0.752 | +0.248 |

**Static:**

| Set | observed | chance | p | effect | effect 95% CI | pass |
|---|---|---|---|---|---|---|
| all | 0.500 | 0.643 | 1 | −0.143 | [−0.253, −0.045] | false |
| filtered | 0.375 | 0.624 | 1 | −0.249 | [−0.442, −0.087] | false |
| unfiltered | 0.583 | 0.659 | 0.984 | −0.075 | [−0.207, 0.033] | false |

**C − static:**

| Set | mean | 95% CI |
|---|---|---|
| all | −0.325 | [−0.525, −0.125] |
| filtered | −0.313 | [−0.625, 0] |
| unfiltered | −0.333 | [−0.583, −0.083] |

**Noise on controls** (30 PRs; 5 unusable for C: hono-ctl-5028, hono-ctl-4620, hono-ctl-4798, langchain-ctl-35850, sqlglot-ctl-7087):

| Arm | flags | median | share of units flagged | share of PRs with a flag | ceiling |
|---|---|---|---|---|---|
| C | 0 on every usable PR except sqlglot-ctl-7536 (1) | 0 | 0.014 | 0.04 | met (≤ 2) |
| static | 1–4 on 6 PRs, 0 elsewhere | 0 | 0.169 | 0.2 | – |

The per-PR flags (C / static) are in `confirm.json` (`flags_per_pr`).

## Descriptive only (labelled as such by the red team)

These are not tested claims:
- **C's effect is negative, and its CI excludes 0.** All: −10.6 points [−21.4, −0.2]. Filtered: −26.3 points. In this corpus, bug locations fall in code that the unit tests execute **more** often than chance.
- **C is nearly silent on controls:** 1 flag in 30 PRs.
- **Environment caveats:**
  - deps_changed is true for 39 of 40 bug PRs. Every tree runs in one environment built at each repo's env base.
  - There are 46 collection-kind file errors, but 0 PRs are unusable under the prereg's rule.
  - 31 of 40 bug PRs have a non-zero exit.
  - 15 bug PRs have more than 20 failing tests (the design look's hono flag), and 17 of 30 controls have at least one failing test.

## Suite health per PR (cover)

`attempt` 2 means the group's report comes from the health rerun.

| PR | kind | attempt | deps_changed | selected | passed / failed / errored / skipped | exit | file errors (collection / empty / other) |
|---|---|---|---|---|---|---|---|
| hono-76 | bug | 1 | true | 12 | 23 / 1 / 0 / 4 | 1 | 0 / 0 / 0 |
| hono-53 | bug | 1 | true | 5 | 9 / 0 / 0 / 2 | 1 | 0 / 0 / 0 |
| hono-3961 | bug | 1 | true | 111 | 2211 / 487 / 2 / 15 | 1 | 0 / 2 / 0 |
| hono-1630 | bug | 1 | true | 54 | 815 / 7 / 3 / 2 | 1 | 0 / 0 / 3 |
| hono-3589 | bug | 1 | true | 108 | 1970 / 485 / 2 / 13 | 1 | 0 / 2 / 0 |
| hono-4314 | bug | 1 | true | 114 | 2291 / 483 / 2 / 18 | 1 | 0 / 2 / 0 |
| langchain-25493 | bug | 1 | true | 95 | 851 / 73 / 4 / 20 | 1 | 3 / 0 / 1 |
| langchain-38003 | bug | 1 | true | 130 | 2011 / 18 / 0 / 33 | 1 | 0 / 0 / 0 |
| langchain-34035 | bug | 1 | true | 115 | 1300 / 17 / 2 / 36 | 1 | 2 / 0 / 0 |
| sqlglot-1031 | bug | 1 | true | 45 | 5069 / 29 / 3 / 0 | 1 | 3 / 0 / 0 |
| sqlglot-7560 | bug | 1 | true | 54 | 18955 / 1 / 0 / 0 | 1 | 0 / 0 / 0 |
| sqlglot-8063 | bug | 1 | true | 57 | 20290 / 0 / 0 / 0 | 0 | 0 / 0 / 0 |
| sqlglot-7736 | bug | 1 | true | 54 | 19286 / 0 / 0 / 0 | 0 | 0 / 0 / 0 |
| sqlglot-7407 | bug | 1 | true | 54 | 18863 / 0 / 0 / 0 | 0 | 0 / 0 / 0 |
| sqlglot-7873 | bug | 1 | true | 54 | 19682 / 0 / 0 / 0 | 0 | 0 / 0 / 0 |
| hono-5199 | bug | 1 | true | 122 | 3777 / 0 / 2 / 28 | 1 | 0 / 2 / 0 |
| langchain-34257 | bug | 1 | true | 118 | 1354 / 12 / 2 / 34 | 1 | 2 / 0 / 0 |
| sqlglot-8027 | bug | 1 | true | 55 | 20073 / 0 / 0 / 0 | 0 | 0 / 0 / 0 |
| hono-2261 | bug | 1 | true | 72 | 1290 / 20 / 5 / 4 | 1 | 0 / 2 / 3 |
| langchain-36080 | bug | 1 | true | 122 | 1626 / 12 / 2 / 33 | 1 | 2 / 0 / 0 |
| sqlglot-8585 | bug | 1 | true | 57 | 22156 / 0 / 0 / 0 | 0 | 0 / 0 / 0 |
| hono-4214 | bug | 2 | true | 112 | 2237 / 489 / 2 / 15 | 1 | 0 / 2 / 0 |
| langchain-34414 | bug | 2 | true | 117 | 1338 / 14 / 2 / 34 | 1 | 2 / 0 / 0 |
| sqlglot-8588 | bug | 2 | true | 57 | 22195 / 0 / 0 / 0 | 0 | 0 / 0 / 0 |
| hono-4556 | bug | 2 | true | 116 | 2623 / 499 / 2 / 26 | 1 | 0 / 2 / 0 |
| langchain-35281 | bug | 2 | true | 121 | 1602 / 15 / 2 / 33 | 1 | 2 / 0 / 0 |
| sqlglot-2513 | bug | 2 | true | 47 | 8037 / 30 / 3 / 0 | 1 | 3 / 0 / 0 |
| hono-3288 | bug | 2 | true | 104 | 1822 / 479 / 4 / 4 | 1 | 0 / 2 / 2 |
| langchain-35319 | bug | 2 | true | 121 | 1601 / 15 / 2 / 33 | 1 | 2 / 0 / 0 |
| sqlglot-1900 | bug | 2 | true | 45 | 6886 / 32 / 3 / 0 | 1 | 3 / 0 / 0 |
| hono-2499 | bug | 2 | true | 82 | 1495 / 26 / 5 / 4 | 1 | 0 / 2 / 3 |
| langchain-31555 | bug | 2 | true | 107 | 1160 / 17 / 3 / 32 | 1 | 2 / 0 / 1 |
| sqlglot-4437 | bug | 2 | true | 42 | 10722 / 1 / 0 / 0 | 1 | 0 / 0 / 0 |
| hono-444 | bug | 2 | true | 32 | 328 / 7 / 2 / 10 | 1 | 0 / 0 / 2 |
| langchain-25169 | bug | 2 | true | 95 | 861 / 74 / 4 / 22 | 1 | 3 / 0 / 1 |
| sqlglot-7639 | bug | 2 | true | 54 | 19105 / 0 / 0 / 0 | 0 | 0 / 0 / 0 |
| hono-3670 | bug | 2 | true | 107 | 1936 / 480 / 2 / 12 | 1 | 0 / 2 / 0 |
| langchain-25360 | bug | 2 | true | 94 | 847 / 72 / 4 / 20 | 1 | 3 / 0 / 1 |
| sqlglot-8486 | bug | 2 | false | 57 | 21628 / 0 / 0 / 0 | 0 | 0 / 0 / 0 |
| hono-4405 | bug | 2 | true | 114 | 2336 / 483 / 2 / 18 | 1 | 0 / 2 / 0 |
| hono-ctl-4626 | control | 2 | true | 116 | 2591 / 487 / 2 / 25 | 1 | 0 / 2 / 0 |
| hono-ctl-4791 | control | 2 | true | 120 | 3237 / 18 / 2 / 26 | 1 | 0 / 2 / 0 |
| hono-ctl-5028 | control | 2 | true | 120 | 3564 / 0 / 2 / 26 | 1 | 0 / 2 / 0 |
| hono-ctl-4620 | control | 2 | true | 116 | 2560 / 487 / 2 / 25 | 1 | 0 / 2 / 0 |
| hono-ctl-4961 | control | 2 | true | 120 | 3537 / 0 / 2 / 26 | 1 | 0 / 2 / 0 |
| hono-ctl-4780 | control | 2 | true | 120 | 3217 / 18 / 2 / 26 | 1 | 0 / 2 / 0 |
| hono-ctl-5104 | control | 2 | true | 121 | 3639 / 0 / 2 / 28 | 1 | 0 / 2 / 0 |
| hono-ctl-4599 | control | 2 | true | 117 | 2630 / 499 / 2 / 26 | 1 | 0 / 2 / 0 |
| hono-ctl-4798 | control | 2 | true | 120 | 3216 / 18 / 2 / 26 | 1 | 0 / 2 / 0 |
| hono-ctl-4921 | control | 2 | true | 120 | 3455 / 18 / 2 / 26 | 1 | 0 / 2 / 0 |
| hono-ctl-4645 | control | 2 | true | 117 | 2644 / 499 / 2 / 26 | 1 | 0 / 2 / 0 |
| langchain-ctl-35230 | control | 2 | true | 121 | 1595 / 13 / 2 / 33 | 1 | 2 / 0 / 0 |
| langchain-ctl-35025 | control | 2 | true | 120 | 1553 / 15 / 2 / 33 | 1 | 2 / 0 / 0 |
| langchain-ctl-34756 | control | 2 | true | 120 | 1488 / 14 / 2 / 33 | 1 | 2 / 0 / 0 |
| langchain-ctl-36771 | control | 2 | true | 124 | 1747 / 17 / 2 / 33 | 1 | 2 / 0 / 0 |
| langchain-ctl-36972 | control | 2 | true | 124 | 1756 / 19 / 2 / 33 | 1 | 2 / 0 / 0 |
| langchain-ctl-35850 | control | 2 | true | 122 | 1612 / 14 / 2 / 33 | 1 | 2 / 0 / 0 |
| langchain-ctl-34851 | control | 2 | true | 120 | 1550 / 14 / 2 / 33 | 1 | 2 / 0 / 0 |
| langchain-ctl-36990 | control | 2 | true | 129 | 1973 / 18 / 0 / 33 | 1 | 0 / 0 / 0 |
| sqlglot-ctl-6759 | control | 2 | true | 53 | 17064 / 0 / 0 / 0 | 0 | 0 / 0 / 0 |
| sqlglot-ctl-6948 | control | 2 | true | 53 | 17798 / 0 / 0 / 0 | 0 | 0 / 0 / 0 |
| sqlglot-ctl-7242 | control | 2 | true | 54 | 18605 / 0 / 0 / 0 | 0 | 0 / 0 / 0 |
| sqlglot-ctl-7846 | control | 2 | true | 54 | 19596 / 0 / 0 / 0 | 0 | 0 / 0 / 0 |
| sqlglot-ctl-6848 | control | 2 | true | 53 | 17550 / 0 / 0 / 0 | 0 | 0 / 0 / 0 |
| sqlglot-ctl-6918 | control | 2 | true | 53 | 17733 / 0 / 0 / 0 | 0 | 0 / 0 / 0 |
| sqlglot-ctl-7536 | control | 2 | true | 54 | 18955 / 0 / 0 / 0 | 0 | 0 / 0 / 0 |
| sqlglot-ctl-7016 | control | 2 | true | 53 | 18084 / 1 / 0 / 0 | 1 | 0 / 0 / 0 |
| sqlglot-ctl-7524 | control | 2 | true | 54 | 18934 / 0 / 0 / 0 | 0 | 0 / 0 / 0 |
| sqlglot-ctl-6892 | control | 2 | true | 53 | 17665 / 0 / 0 / 0 | 0 | 0 / 0 / 0 |
| sqlglot-ctl-7087 | control | 2 | true | 53 | 18239 / 0 / 0 / 0 | 0 | 0 / 0 / 0 |
