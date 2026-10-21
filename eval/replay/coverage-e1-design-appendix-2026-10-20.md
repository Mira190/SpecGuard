# E1 design-look appendix (2026-10-20)

Dated appendix to `prereg-coverage-gap-e1.md`, frozen at 2fffc35 (red team specguard-e0). Run by specguard-33. Counts only. The design look changes no gate, alpha or ceiling. The confirmation set (`coverage-e1-confirm.json`) was not touched.

## Freeze notes, quoted

- (a) "Design-look command: import (done), then `export --set e1design` (done), then `cover --set e1design`, then the scorer, step 3 exactly as written in the prereg TBD block. That block's 'list sha pending' line is superseded by this sha."
- (b) "The runner is main b8f1357 or later, with no eval/f2p diff." **Amended** under the defect-amendment rule (red team, 2026-10-20). The amended note reads: main at d737045 (#425); eval/f2p diff vs b8f1357 = this fix only (`cover.js` +1 line, `f2p.test.js` +13).
- (c) "The confirmation set stays untouched until the design appendix is committed and the power check is reported to me and the owner. The confirmation run needs a separate go."

## Run 1: invalid

- **What ran:** `cover --set e1design` on 2026-10-20, 21:05–21:15, runner main 2969e6d (no eval/f2p diff vs b8f1357).
- **Cause:** a runner bug from #419. `f2p.js` passed the set name to `cmdCover` only for output paths, and never called `harness.useSet`. So `scope()` read `holdout2-candidates.json`.
- **Effect:** it covered the 8 holdout-2 f2p groups that have cover configs (hono-2339, 3366, 3413, 3604, 3727, 3787; langchain-18592; sqlglot-7315), at f2p fix-parent shas, under e1design output names. None of the 15 e1 rows ran.
- **No outcome look:** no scorer was run on it, and no changed-line coverage was read.
- **Quarantine:** `<evidence>/f2p/cover/INVALID-e1design-run1-holdout2-trees-2026-10-20/`, with the log, the results file and a README.
- **Fix:** #425, merged at d737045. `cmdCover` now calls `useSet` before `scope()`. Two tests were added; both fail without the fix.

## Run 2: the design look

- **Runner:** a fresh worktree at d737045.
- **Design list:** byte-identical to `2fffc35:eval/replay/coverage-e1-design.json`.
- **Re-import:** 15 rows, ok 15, unresolved 0, unrunnable 0.
- **Re-export:** `checkTree` passed on all 15 trees. Every tree's `.sha` equals its row's buggy_sha.
- **Job-list check, logged before cover ran:** the job list was exactly the 15 `e1-` groups at their I-head shas.
- **Cover:** `cover --set e1design`, 2026-10-20, 21:21–21:36, serial. No timeouts. Afterwards the hono work dir verified: 583 tracked files identical to 5ca49b07.
- **Scorer:** `coverage-e1-score.js` at 2fffc35, step 3 exactly as written. Result sha256:
  - `design.json`: 3feb730b…f65258
  - `results-cover-e1design.json`: c57e9af7…01fb4
- **Power check:** per the prereg; the flag was omitted from the frozen command line. It is the same command plus `--power-n 40` (n = the primary union's 40 bugs; power resamples bug PRs only). All other fields are identical to the frozen run. `design-power.json` sha256: 41207bcf…0904.

### Suite health per PR (cover)

| PR | deps_changed | selected | passed / failed / errored / skipped | exit | file errors (collection / empty / other) |
|---|---|---|---|---|---|
| e1-sqlglot-7054 | true | 53 | 18199 / 0 / 0 / 0 | 0 | 0 / 0 / 0 |
| e1-sqlglot-7097 | true | 53 | 18284 / 0 / 0 / 0 | 0 | 0 / 0 / 0 |
| e1-sqlglot-7315 | true | 54 | 18885 / 0 / 0 / 0 | 0 | 0 / 0 / 0 |
| e1-hono-3604 | true | 107 | 1934 / 480 / 2 / 12 | 1 | 0 / 2 / 0 |
| e1-hono-3787 | true | 110 | 2010 / 485 / 2 / 13 | 1 | 0 / 2 / 0 |
| e1-hono-2339 | true | 78 | 1391 / 20 / 5 / 4 | 1 | 0 / 2 / 3 |
| e1-hono-3413 | true | 106 | 1874 / 478 / 4 / 12 | 1 | 0 / 2 / 2 |
| e1-hono-3366 | true | 106 | 1851 / 473 / 4 / 12 | 1 | 0 / 2 / 2 |
| e1-hono-3727 | true | 107 | 1942 / 484 / 2 / 12 | 1 | 0 / 2 / 0 |
| e1-langchain-18592 | true | 61 | 458 / 55 / 1 / 8 | 1 | 0 / 0 / 1 |
| e1-langchain-33461 | true | 114 | 1267 / 18 / 2 / 33 | 1 | 2 / 0 / 0 |
| e1-hono-hclean2-1 (control) | true | 123 | 3917 / 0 / 2 / 37 | 1 | 0 / 2 / 0 |
| e1-hono-hclean2-3 (control) | true | 123 | 3856 / 0 / 2 / 28 | 1 | 0 / 2 / 0 |
| e1-hono-hclean3-1 (control) | true | 121 | 3678 / 0 / 2 / 28 | 1 | 0 / 2 / 0 |
| e1-langchain-hclean3-1 (control) | true | 130 | 2077 / 18 / 0 / 33 | 1 | 0 / 0 / 0 |

Failing tests do not make a PR unusable (prereg). The 2 collection errors in langchain-33461 did not meet the unusable rule (scorer: 0 unusable).

### Scorer output (counts, as printed)

File error kinds over all 15 PRs: collection 2, empty 18, other 8.

| Set | PRs | unusable | C observed | C chance (verdict null) | p | effect | effect 95% CI | secondary null chance / p | C pass |
|---|---|---|---|---|---|---|---|---|---|
| all | 11 | 0 | 0.455 | 0.371 (primary) | 0.357 | +0.084 | [−0.101, 0.251] | 0.243 / 0.055 | false |
| filtered | 3 | 0 | 0.333 | 0.283 (primary) | 0.848 | +0.051 | [0, 0.152] | 0.224 / 0.673 | false |
| unfiltered | 8 | 0 | 0.500 | 0.400 (primary) | 0.405 | +0.100 | [−0.156, 0.328] | 0.242 / 0.075 | false |

- `c_usable_only` equals `c` in every set (0 unusable).
- `by_deps_changed`: every PR is deps_changed=true; the false group has 0 PRs.
- Units with no instrumented lines: all 42, filtered 5, unfiltered 37.
- Usable suite health: all 11 PRs, of which 4 have other errors, 8 have a non-zero exit, and 0 timed out.

**Static:**

| Set | observed | chance | p | effect | effect 95% CI | pass |
|---|---|---|---|---|---|---|
| all | 0.636 | 0.787 | 0.999 | −0.151 | [−0.378, 0.010] | false |
| filtered | 0.333 | 0.631 | 0.998 | −0.297 | [−0.904, 0.012] | false |
| unfiltered | 0.750 | 0.839 | 0.993 | −0.089 | [−0.287, 0.019] | false |

**C − static:**

| Set | mean | 95% CI |
|---|---|---|
| all | −0.182 | [−0.636, 0.273] |
| filtered | 0 | [−1, 1] |
| unfiltered | −0.250 | [−0.625, 0.250] |

**Flags per PR (C / static), with the PR's failing tests from cover:**

| PR | C | static | failing tests |
|---|---|---|---|
| sqlglot-7054 | 1 | 3 | 0 |
| sqlglot-7097 | 1 | 2 | 0 |
| sqlglot-7315 | 0 | 3 | 0 |
| hono-3604 | 0 | 2 | 480 |
| hono-3787 | 10 | 16 | 485 |
| langchain-18592 | 2 | 9 | 55 |
| langchain-33461 | 2 | 3 | 18 |
| hono-2339 | 4 | 18 | 20 |
| hono-3413 | 0 | 2 | 478 |
| hono-3366 | 0 | 0 | 473 |
| hono-3727 | 0 | 0 | 484 |

**Validity flag** (red team, 2026-10-20):
- The hono bug rows have about 475–485 failing tests each (hono-2339 has 20), while the hono controls have 0. Every PR is deps_changed=true.
- This looks like environment breakage on older trees (one env built at 5ca49b0), not bug behaviour.
- The within-PR null absorbs much of it, because the env is the same within a PR.
- The C-on-controls noise comparison below (0 flags) is **not comparable** to the bug PRs, because the controls ran on healthier suites.

The filtered set is langchain-33461, hono-3413 and hono-3727.

**Noise on controls** (4 usable, 0 unusable for C):

| Arm | flags per PR | median | share of units flagged | share of PRs with a flag | ceiling |
|---|---|---|---|---|---|
| C | 0, 0, 0, 0 | 0 | 0 | 0 | met (≤ 2) |
| static | 3, 1, 1, 2 | 2 | 0.368 | 1 | – |

**Comparison 4** (descriptive; saved holdout-2 haiku runs 39120706885, 39120718089, 39120729276; 0 findings dropped; 0 invalid runs skipped):

| Label | n | catches | rate |
|---|---|---|---|
| confirmed | 5 | 4 | 0.8 |
| contradicted | 27 | 9 | 0.333 |
| unknown | 24 | 0 | 0 |

These are descriptive figures from the design set only, and n is tiny. Coverage-confirmed findings were caught 4/5; n = 5 proves nothing (red team).

### Power at the confirmation n

`power_c`, n = 40, 1000 sims:

| Set | pass_share |
|---|---|
| all | 0 |
| filtered | 0 |
| unfiltered | 0 |

It is **below 0.5**, so under the prereg it is reported to e0 and the owner before the confirmation run.

**Diagnostic, not frozen, reported for the red team.** `powerOf` reuses each design PR's precomputed permutation column for every duplicate draw: 11 distinct PRs resampled to 40. Duplicates therefore move together in the null, which makes the null about as wide as at n = 11. The same resampling with an independent random column offset per draw (a temporary copy of the scorer, not committed) gives:

| Set | pass_share |
|---|---|
| all | 0.363 |
| filtered | 0 |
| unfiltered | 0.486 |

This is also below 0.5.

**Red-team ruling (2026-10-20):**
- The frozen `powerOf` figure (0) is the pre-registered number, and it is reported as such.
- The independent-column figure is the better estimate, labelled "diagnostic, not frozen".
- Both are below 0.5, so the reading is the same. Neither changes the gate.
