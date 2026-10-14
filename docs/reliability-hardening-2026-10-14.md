# Reliability hardening — verification report (2026-10-14)

Branch `fix/shift-left-improvements`. Offline only: no paid model, no live scan. Implementation, regression tests and independent reviews were delegated to Claude Sonnet 5.5 subagents (each subprocess checked: every assistant message `anthropic/claude-sonnet-5-5`); planning, integration and final review by Opus 5.5.

## Results

| Check | Baseline (`251180c`) | Updated |
|---|---|---|
| `node --test src/*.test.js bin/*.test.js eval/*.test.js` | 1045 pass, 0 fail, 1 skip, 1 todo | **1049 pass, 0 fail, 1 skip, 1 todo** (`--test-concurrency=4`, 522 s) |
| Mirror check (`skills/test-review`, `ccr` vs `.github/…`) | ok (identical git blobs) | ok |
| `node eval/run.js --dry-run` | 46 ok | 46 ok |

- skip = the `SPECGUARD_REPLAY`-gated replay test; todo = the known k2 false positive below.
- At default concurrency on a Windows workstation, `auto-engine.test.js` "falls back to auto once" hit its 60 s `spawnSync` cap in 2 of 3 full runs (pre-existing, load-sensitive; passes alone in 24 s and on `251180c`). Ubuntu CI has not shown it.

## Seeded false-positive regressions (`eval/kite-fp.test.js`, cases `k1`, `k2`)

Real `collect.sh` → canned model answer that makes the original claim → real `post.run` → `grade.js`, each with a true-positive control.

| Case | Claim | Result |
|---|---|---|
| k1 `ownFile` | missing_test on a wrapper whose delegate (`isDirectChild`) is unit-tested | **Handled**: kept off the PR, downgrade names `test/filename.test.js`; control (`titleOf` → untested `labelOf`) posts. Mutation-checked both ways (no delegate following → FP returns; guard that suppresses everything → control fails). |
| k2 `toolbox` | weak_test on a contiguous-argument `has()` assertion | **Not handled (model-dependent)**: no deterministic layer judges what a weak_test claim says about an assertion; the claim posts unchanged. Pinned by a current-behaviour test plus a `todo` stating the wanted behaviour. No heuristic was tuned. |

Scan mode now has the same regression with the real guard (`src/audit-code.test.js`, mutation-checked): delegate downgrade with recall control, and `TEST_PATHS` reaching the scan post step.

## Defect fixed this round

**Requirements fingerprint recorded the wrong PR text (verified, billable re-review loop).** The model reads the PR text `requirements.js` fetches live at collect time, preflight keys the live PR, but post keyed the event payload. A workflow re-run after a PR-body edit (re-runs reuse the payload; `edited` does not trigger) recorded the old key, so every later run at that head re-reviewed.
- Fix: `requirements.js` writes `pr-req-key.txt` only after collection succeeds; `collect.sh` removes it when collection fails; `post.js` uses it when well-formed, else the previous fallback.
- Evidence: `post.test.js` "collected from the PR text the model read" fails on the old logic and passes now (includes the preflight `decide` round trip); `eval/kite-fp.test.js` k1 asserts the real `collect.sh` key reaches the summary marker (fails if the write is removed).

## Previously fixed defects — executable evidence

| Defect | Test |
|---|---|
| Carried finding keeps its kind through state | `src/audit-post.test.js` "a carried block keeps its real status and class" |
| Coverage ledger from unique ids, completed ≤ total | `src/audit-post.test.js` "coverage ledger: counts come from unique block ids" |
| Incomplete status for unseen units / unanswered blocks | `src/audit-post.test.js` "unseen units or unanswered blocks…", two `run:` status tests |
| Missing test evidence never auto-confirmed | `src/audit-code.test.js` "confirmed … never at once"; static leads never enter the state |
| Visibility guard fail-closed | `src/visibility-guard.test.js` `decide` + script end to end with a failing `gh` (fail-open mutant caught) |

## Detection quality (recorded real-model runs, not unit tests)

From `eval/results/recall-claude-2026-10-14{,b}.json` (18 seeded cases, 1 rep each, 0 errors, 18/18 JSON valid):

| Metric | Run a | Run b |
|---|---|---|
| False positives / precision | 1 FP / 0.947 | 0 FP / 1.000 |
| Missed findings / recall | 3 FN / 0.857 | 3 FN / 0.857 |
| Degraded runs | 5/18 | 4/18 |

- Weak/missing assertions are the weakest category (most FNs across runs; 0/2 correct in a manual review of real scan findings) and have no deterministic guard.
- Test-layer placement: 2 cases per run; no validated positive pushdown case.
- `robustness` and `traceability` have no run on the current engine; k1/k2 have no real-model run yet.
- Seeded precision does not transfer to real repositories; FPs do not fail a case; summary-only and acceptable findings are outside TP/FP.

## Remaining risks / unknowns

- k2-class false positives (weak_test semantics) depend on the model.
- Real-repository recall is unmeasured; seeded fixtures are small and partly tuned.
- Untested inputs (name-grep only): `ctx_retention_days`, `max_diff_kb` effect, `review_timeout_minutes`, CLI version pins.
- A unit that never fits the model context keeps a scan `incomplete` on every run (honest, but a permanent warning).
- The engine step shares the workspace with ctx files; a prompt-injected agent could write ctx files (existing exposure, not new).
- CI runtime: bin tests add about 2 min of wall time; `kite-fp` adds about 15 s.

Follow-up (2026-10-15): chained scan test added (`src/audit-code.test.js` "chained:": real `collect` → real post step, no hand-written ctx files); main merged in; full suite 1052 pass, 0 fail, 1 skip, 1 todo, plus the known `auto-engine` timeout under load (passes alone).

Next: run `eval/run.js --cases k1,k2,t1,t2,t3,t4` on a real model; consider a deterministic weak_test check only with a recall run before and after.
