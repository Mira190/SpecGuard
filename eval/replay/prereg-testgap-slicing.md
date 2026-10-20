# Pre-registration (DRAFT, not frozen): test-gap catches with sliced candidate tests in the context pack

**Status.** Draft, opened 2026-10-20T00:16Z, before any sliced run. It is frozen only after specguard-e0's OK. Until then, every number marked TBD may change, except the noise ceiling, which was fixed at draft time (below).

**Predecessor.** `prereg-testgap-mvp.md` (OK at 881cfcb) was retired unrun: its design power was 0 at c64501b, and it never looked at the frozen confirmation set. This prereg owns the single look at the frozen set (`eval/replay/testgap-confirm.json`) at α = 0.05. Its static arm transfers here.

**Why this arm.** On holdout 2, 49 missing_test findings were demoted on the 24 test-gap pairs × 3 runs (eval/testgap-demotion @ 6e0c829). For 39 of them, and for 21 of the 24 demoted findings inside the bug's function, the reason was "candidate test only partly visible": the context pack cut a large test file to its head. 11 of those test files were over the per-file cap and 10 were squeezed out by the budget. The hypothesis: when the pack shows the test blocks relevant to the changed definitions instead of cutting the file, fewer findings are demoted, and the delivered missing_test findings point at test-gap bugs more often than chance.

## System under test
- Arm S: claude-api with claude-haiku-5-5, run locally, with pack slicing of candidate test files. The implementation sha is TBD. It is frozen with this prereg.
- S is the only model arm run on the frozen set.
- The unsliced pack (current main) is not run on the frozen set. The comparison with it is descriptive and comes from the design set only.
- Everything else is as in the predecessor: PR title and body only, 3 runs per PR, rep-major order, the $35 cap, and the cap rule.

## Corpus
- The frozen confirmation set exactly as committed (freeze sha TBD), with the rule in that commit's message: nothing touches it before this prereg is frozen.
- Design set: holdout 2, the 24 test-gap pairs (unchanged from c64501b). Iteration is allowed there and every iteration is recorded.

## Metric, null, verdict
The same as the predecessor, unchanged:
- **Catch:** a delivered missing_test or weak_test finding (inline, or in the visible summary, and not low) inside B: the definition spans enclosing the blamed lines, or ±3 lines of a blamed line.
- **Unit:** the PR. The per-PR value is the mean over runs.
- **Nulls:** the primary null is function-level and weighted by added lines; the secondary null is uniform. The verdict uses whichever gives the higher chance.
- **Location PASS iff both:**
  - the one-sided within-PR permutation p is below 0.05; and
  - observed − chance is at least 10 points.
- This is the ONLY test. Lift, the cluster bootstrap and the comparison with the unsliced design set are descriptive.

## Static arm (transferred, no test of its own)
- It flags changed definitions of I whose name appears neither in I's test diff nor in any test file at I's head.
- It uses `git grep -lw`, after the grepTests fix. No static-arm number from c64501b is valid.
- It is scored with the same rule and nulls, and is only reported next to S.
- How the verdict reads:
  - S passes but the per-PR lower bound of S − static is ≤ 0: "the static rule does as well; the model adds no location value".
  - Only static passes: the result says so.

## Noise (fixed before any sliced run)
- **Ceiling:** at most 30% of the missing_test findings S delivers, on the frozen set's bug PRs, may name a definition (`enclosingName` at the cited line) that some test file at I's head mentions as a whole word.
- **Provenance:** the 30% was set on 2026-10-20 AFTER seeing the unsliced diagnosis. There, 19 of 49 demoted findings (39%) and 10 of 24 would-be catches named a definition that a test file mentions. It was set BEFORE any sliced run. The design-look value is reported next to it.
- **Reading:** if S passes on location but exceeds the ceiling, the result is "PASS (location), noise above ceiling".
- **Also reported, carried over from the predecessor:** the median number of inline comments per control PR, at most 2, and the share of controls with any missing_test inline.

## Content tier
"Catches the bug" needs, on top of a location PASS, at least 3 verified f2p catches on hono, rqlite, sqlglot or langchain (specguard-33's harness, list input @ 11ecb27). Buggy is I's head and fixed is F. The blind-grade budget is spent, so the blind grade is not part of this prereg.

## Design look (paid, before the freeze)
- Haiku on the 24 qualifying holdout-2 pairs × 3 runs, with slicing on. Estimated $3–4 (the holdout-2 mean was $0.0464 per run).
- The command and budget flags are TBD.
- It needs specguard-e0's OK on the design, then the owner's OK in the running session.
- It reports: delivered catch rate vs chance, the number of demoted findings by reason against 6e0c829, and the noise share against the 30% ceiling.

## TBD before freeze
- The slicing implementation sha.
- The freeze sha of the confirmation set.
- The design-look results.
- The grepTests fix sha.
