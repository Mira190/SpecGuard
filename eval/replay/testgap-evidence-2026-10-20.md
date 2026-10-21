# Test-gap MVP evidence on holdout 2 (2026-10-20): confirmation paused

**Decision (specguard-e0, red team, 2026-10-20).** No confirmation spend. The slicing prereg stays a draft (branch `eval/testgap-slicing-prereg`). The frozen confirmation set is kept untouched; only its builder and a 20-pair read may touch it. Next is product work, measured on this design set.

**Question.** At PR time, do SpecGuard's delivered missing-test findings point at, and describe, real bugs that a test would later have caught?

Setup:
- Design set: holdout 2, 45 bug PRs × 3 saved haiku-5-5 runs.
- 24 of the 45 pairs pass the mechanical test-gap filter: the fix adds or changes a test that names a definition the fix changed.
- All numbers below are offline and use no new model runs, except the blind grade ($4.71, sonnet-5-5).

## Location: within the bug's definition or ±3 lines of a blamed line, against a function-level chance null

| Findings counted | Runs with a hit | Chance | Effect | p | Source |
|---|---|---|---|---|---|
| Delivered missing_test/weak_test (inline or visible, not low) | 2/72 | 2.7% | +0.1 pt | 0.65 | `eval/testgap-mvp-prereg` @ c64501b |
| Also the hidden low-confidence ones | 22/72 | 21.6% | +9.0 pt | 0.004 | same |
| Any kind, any delivery, ±3 lines only (all 45 pairs) | 45/135 | 23.7% | +9.6 pt | — | `eval/holdout2-null` @ bcd568b |

- The location ceiling is about +9 points, against the +10-point floor the prereg set before seeing it. That holds even if every hidden finding were delivered.
- The pre-registered location test (`prereg-testgap-mvp.md`, OK at 881cfcb) was therefore retired unrun, with design power 0.
- `weak_test` findings caught 0 runs.

## Content: blind grade, real findings vs findings from another PR of the same repo

Branch `eval/blind-grade` @ 3680ef1, with the shared-fix pairs excluded (129 pairs):

| | Real | Content swap (M2) | Whole-PR swap (M1) |
|---|---|---|---|
| Caught (direct or indirect) | 17/129 = 13.2% | 0/129 | 0/129 |
| After regrading 19 truncated answers (max_tokens 2000) | 26/129 = 20.2% | 0/129 | 0/129 |

Truncation defect: claude-sonnet-5-5 thinks by default, and `max_tokens` was 400. That truncated 19 answers, 17 of them real, which lowered the real rate. Graders need `max_tokens` of at least 2000, and the model rejects `temperature`.

The 26 real catches, cut by grade and by delivery:

| | Direct | Indirect |
|---|---|---|
| Delivered (inline) | 5 | 2 |
| Hidden (low confidence, summary Details only) | 7 | 3 |
| Unknown (a regrade with no finding index recorded) | 3 | 6 |

- **Delivered direct: 5/129 = 3.9%, on 3 PRs. Only 1 of the 129 is a missing_test finding.**
- An "indirect" grade (a missing_test finding at the right place) is roughly what a generic "this changed without a test" template at the bug's function would also earn. So only direct grades count as content evidence. A control for that template has not been run.
- Hypothesis only (n = 5, 2 repos, no claim): 4 of the 5 delivered direct catches are `spec_mismatch` findings, not `missing_test`.
- Stability: 13 of 43 PRs were caught in at least 1 of 3 runs; 5 were caught in all 3.
- Grader validity: an LLM grader with no human labels. The content claim's ceiling is "an LLM judge says so".

## Why catches are hidden

Branch `eval/testgap-demotion` @ 6e0c829 covers the 24 test-gap pairs × 3. There are 49 demoted missing_test findings:
- 39 are reason (a), "candidate test only partly visible". These include 21 of the 24 demoted findings inside the bug's definition.
- The cause is slicing failures in the context pack: test blocks flagged as truncated, merged windows too large for their room, and a fixture file picked as a candidate test (specguard-ad, `fix/slice-test-blocks`).
- Turning off the haiku fast-tier reduced review (`src/engine-model.js:14`, `src/post.js:494`) releases 0 findings; it only moves 31 from the summary to inline.

## Earlier attempts at the same question (multiplicity)

- The mutation pilot (#374): 0/10 gaps located at line level.
- Escaped-defect line hits on SpecGuard's own history (#397): 5.0% vs a chance level of 4.5%.
- f2p, a test written from the finding fails on the bug and passes on the fix (#410): 1/32 verified.
- `prereg-testgap-mvp.md`: retired unrun, design power 0.
- Pack arms R, S, O and H: not adopted (#406).
- This note.

## Correction 2026-10-20 (later the same day): code files only

The red team (specguard-e0) found that `pairData` built units and B from every file `isProd` accepts. That included lockfiles, package manifests, gitlinks and `.github/` scripts. The fix (`isCode`, eval/testgap-demotion @ 1afefce) keeps code files only. The re-run cost $0, and its results are in SpecGuard-evidence/e1-recheck.

| Number above | Was | Now |
|---|---|---|
| Delivered missing_test/weak_test | 2/72, chance 2.7%, p 0.65 | unchanged |
| Also the hidden low-confidence ones | chance 21.6%, +9.0 pt, p 0.004 | chance 22.2%, +8.3 pt, p 0.007 |
| Line hits, any kind ±3 (`holdout2-null`, default) | 45/135 at 23.7% | unchanged (with `--code-only`: 45/135 at 23.9%) |
| Static arm, qualifying | 50.0% vs 53.2%, p 0.83 | 50.0% vs 55.2%, p 0.90 |
| Static arm, all 45 | 66.7% vs 63.2%, p 0.32 | 66.7% vs 64.3%, p 0.40 |
| Ceiling U / U+ (bdd2f9a) | +6.3 / +9.0 pt | +5.9 / +8.3 pt |

No conclusion changes. Every row is still below the +10-point floor, and the location ceiling is now about +8 points.

## Where the cited shas live

Each branch is merged into main with its own merge commit, so every cited sha stays reachable.
- `eval/holdout2-null` (bcd568b): the line-hit chance baseline, `holdout2-null.js`.
- `eval/blind-grade` (3680ef1): the blind content grade, `blind-grade.js` plus its prompt and test. Results stay in SpecGuard-evidence.
- `eval/testgap-demotion` (6e0c829, bdd2f9a, b6accfd, 1afefce): demotion diagnosis, ceiling check (`testgap-ceiling.md`), the grepTests fix, and the code-only fix.
- `eval/testgap-mvp-prereg` (881cfcb, c64501b, plus the corpus builder up to tip 71c31b7; no corpus freeze was ever committed): `prereg-testgap-mvp.md` (retired unrun), `testgap-score.js`, `testgap-confirm-build.js`.

## Product fixes to measure on this design set (candidates, not claims)

1. **Delivery.** 7 direct catches are hidden, against 5 delivered.
2. **missing_test specificity.** A finding should name the failing behaviour or case, not only "untested".
