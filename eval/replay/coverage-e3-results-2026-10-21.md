# E3 results (2026-10-21)

Results note for `prereg-coverage-confirmed-e3.md`, frozen at 0a16765 by red team specguard-e0. Run by specguard-33, with the haiku batch run by the owner. Counts only.

## Reading (per the prereg)

**FAIL.** On this corpus, coverage confirmation does not separate the more precise LLM missing-test findings, and the claim is not made.

- The design look's 4/5 did not replicate: confirmed findings were 4/18 (22%), against 26/58 (45%) for contradicted findings.
- **Scope:** haiku missing_test findings on these 40 SZZ bug PRs in hono, sqlglot and langchain-core, with the harness's unit scope. Nothing is claimed for other models or repos.

## What ran

**SUT and model**
- SpecGuard main d737045, engine claude-api, model `claude-haiku-5-5`.
- Manifest `coverage-e3-manifest.json`, sha256 199d6102…937f1f, equal to 0a16765. All 40 entries have `pr_text` github; fallback 0.

**Batch**, run by the owner in their own shell with the key set only there:
- Command: `eval/replay.js batch --cap 120 --budget 0.25 --max-total 8 --reps 3 --ids all`.
- Log: `{"ran":120,"skipped":0,"stopped":null,"spent":3.665…,"attempts":[]}`, batch exit 0.
- rep1, rep2 and rep3 each have 40/40 valid `result.json`. Each rep dir also holds `gh-shim.js`, the replay's offline gh shim.
- Red-team check: 0 `sk-ant-` hits under the out dir.
- No coverage_files go to post.js, so #413's exemption does not act on these runs. Coverage labels come only from the E1 cover reports (set `e1confirm`).

**Coverage**
- The single E1 cover run over the 70 confirmation rows, after its one health rerun (49/49 ok).
- The overlap with the batch, the memory kill and the setup errors are recorded in `coverage-e1-confirm-results-2026-10-21.md`.
- Results sha256 71a37cd3…54f8ea.

**Scorer**
- `coverage-e3-score.js` at 0a16765, run exactly as frozen.
- Defaults: seed 20261020, 10000 perms, 2000 boots.
- `result.json` sha256 6615a76f…80f6.

## Scorer output (counts, as printed)

| | value |
|---|---|
| PRs | 40 rows, 40 scored, 0 not run |
| runs | 120 scored, 120 valid, 0 invalid misses |
| unusable PRs | 0 |
| findings included | 97 (confirmed 18, contradicted 58, unknown 21); 0.81 per valid run |
| excluded | non-code path 15 |
| spend | $3.665 |

**Primary:**

| confirmed | contradicted | confirmed rate | contradicted rate | difference | p (10000 perms) | 95% CI (PR cluster, 2000 boots) | verdict |
|---|---|---|---|---|---|---|---|
| 18 (4 caught) | 58 (26 caught) | 0.222 | 0.448 | −0.226 | 1 | [−0.593, 0.285] (12 skipped) | FAIL |

Both counts are at least 10, so the test was run.

**Secondaries (descriptive):**

1. Confirmed vs unknown: difference −0.254, 95% CI [−0.708, 0.346] (12 skipped).
2. Delivered only (24 findings):
   - confirmed 4/8;
   - contradicted 8/15;
   - unknown 1/1;
   - difference −0.033.
3. Per label (catches/n):

| Group | findings | confirmed | contradicted | unknown | confirmed − contradicted |
|---|---|---|---|---|---|
| hono | 49 | 4/8 | 12/33 | 6/8 | +0.136 |
| langchain | 34 | 0/10 | 11/16 | 2/8 | −0.688 |
| sqlglot | 14 | 0/0 | 3/9 | 2/5 | – |
| filtered (16 PRs) | 44 | 0/12 | 14/31 | 0/1 | −0.452 |
| unfiltered (24 PRs) | 53 | 4/6 | 12/27 | 10/20 | +0.222 |
| deps_changed true | 95 | 4/18 | 25/57 | 9/20 | −0.216 |
| deps_changed false | 2 | 0/0 | 1/1 | 1/1 | – |
| failing tests ≤ 20 | 52 | 0/10 | 15/34 | 4/8 | −0.441 |
| failing tests > 20 | 45 | 4/8 | 11/24 | 6/13 | +0.042 |

4. Motivating design look (not evidence): confirmed 4/5, contradicted 9/27, unknown 0/24.

## Multiplicity

E3 is added to the multiplicity list in `prereg-coverage-gap-e1.md`.
