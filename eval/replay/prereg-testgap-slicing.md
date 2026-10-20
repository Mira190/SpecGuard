# Pre-registration (DRAFT, not frozen): test-gap catches with sliced candidate tests in the context pack

**Status.** PAUSED 2026-10-20 (specguard-e0): no confirmation spend; this stays a draft and the frozen set stays untouched (evidence: eval/replay/testgap-evidence-2026-10-20.md, PR #412). Draft opened 2026-10-20T00:16Z, before any sliced run. It is frozen only after specguard-e0's OK. Until then, every number marked TBD may change, except the noise ceiling, which was fixed at draft time (below).

**Predecessor.** `prereg-testgap-mvp.md` (OK at 881cfcb) was retired unrun: its design power was 0 at c64501b, and it never looked at the frozen confirmation set. This prereg owns the single look at the frozen set (`eval/replay/testgap-confirm.json`) at α = 0.05. Its static arm transfers here.

**Why this arm.** On holdout 2, 49 missing_test findings were demoted on the 24 test-gap pairs × 3 runs (eval/testgap-demotion @ 6e0c829). For 39 of them, and for 21 of the 24 demoted findings inside the bug's function, the reason was "candidate test only partly visible". In each case, `pack-cut.txt` listed a candidate test file. 11 of those test files were over the per-file cap and 10 were squeezed by the budget.

Candidate tests are already sliced: `contextPack` → `addFile` shows windows around the lines that name a changed symbol (specguard-ad). The 21 are cases where that slicing failed, for one of four reasons: a matching block was dropped for lack of room, a test block was cut short by the 30-up/80-line window, the symbol set was capped, or no block fit at all. The fix targets whichever of these dominates; specguard-ad will diagnose it at $0 first.

The hypothesis: when the matching test blocks are shown in full, fewer findings are demoted, and the delivered missing_test findings point at test-gap bugs more often than chance.

## System under test
- Arm S: claude-api with claude-haiku-5-5, run locally, with pack slicing of candidate test files. The implementation sha is TBD. It is frozen with this prereg.
- S is the only model arm run on the frozen set.
- The unsliced pack (current main) is not run on the frozen set. The comparison with it is descriptive and comes from the design set only.
- Everything else is as in the predecessor: PR title and body only, 3 runs per PR, rep-major order, the $35 cap, and the cap rule.

## Scope of the claim
- The system under test is claude-haiku-5-5 on the claude-api engine, with SpecGuard's shipped defaults at the frozen sha.
- Those defaults include the fast-tier reduced review (`src/engine-model.js:14`, `src/post.js:494`), a 250 KB context pack, and `focus` on.
- The claim covers only this configuration. It does not transfer to the company default engine (Copilot) or to any other model.

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
- **Reading (chosen, not FAIL):** if S passes on location but exceeds the ceiling, the result is "PASS (location), noise above ceiling". The MVP claim then states the noise share, and does not call it an acceptable noise level.
- **Also reported, carried over from the predecessor:** the median number of inline comments per control PR, at most 2, and the share of controls with any missing_test inline.

## Content tier
"Catches the bug" needs a location PASS AND content evidence. Content evidence is either of:
1. **Blind grade on the frozen set.** The owner approved a cap of $6 on 2026-10-20, before the set was looked at.
   - The method is the same as `eval/replay/blind-grade.js`: real items against M2 content-swap items (each finding keeps X's path and line, and takes another frozen bug PR's text from the same repo, by seeded derangement). The prompts are blinded, with neutral ids and a leak check.
   - Grader: claude-sonnet-5-5, with no temperature and max_tokens 2000. The holdout-2 run hit truncation at 400.
   - It runs once, after S's runs. Repos with only one frozen bug PR are dropped and counted, and shared-fix pairs are excluded from the primary.
   - Passes iff the real catch rate is above the M2 false-catch rate, with a one-sided within-repo label permutation p < 0.05 (10000 permutations, seed 20261020).
   - About 288 items (48 bug PRs × 3 runs, real plus M2); estimated at $4–5. If the cap is reached, the pairs not graded are reported and the analysis uses complete pairs.
2. **f2p:** at least 3 verified f2p catches, from specguard-33's harness on main at f6e4eb7, under its amendment 6/7 rules. The rqlite controls are rerun under those rules before any rqlite row counts. Only hono, sqlglot and langchain run there; rqlite is skipped for memory. At #408's rates (NEAR 0/9 verified, FAR 1/23), the expected yield is close to 0. f2p is therefore reported, but in practice the content tier rests on the blind grade.

The blind grade is a content measure of its own and does not test location. It is the content condition of the two-tier reading, not a second primary test.

## Order (specguard-e0, 2026-10-20)
1. The slicing implementation is merged with e0's OK.
2. This prereg is frozen: every arm, gate, α, the noise ceiling and the implementation sha. e0 OKs the prereg sha.
3. e0 OKs the design-look command.
4. The design look runs: haiku-5-5, claude-api, local, on the 24 qualifying holdout-2 pairs × 3. Hard cap `--max-total 4`. The owner approved the spend on 2026-10-20 (relayed by e0).
5. Its results are added as a dated, descriptive appendix that changes no gate.
6. The owner gives the go for the confirmation run. The power check is reported to the owner first; it does not gate the run, and the owner may still decline the $35.
7. Only then is the frozen set touched.

**Defect amendment.** If the design look exposes a defect, a dated amendment is allowed before any touch of the frozen set. A defect is an implementation bug, packs not sliced as specified, or an invalid-run rate above 10%.
- The amendment names the defect and the design-look evidence.
- No gate, α or ceiling moves because of it.
- A changed implementation sha means the design look is re-run under the same $4 cap, with a new spend OK from the owner.

## TBD before freeze
- The slicing implementation sha.
- The freeze sha of the confirmation set.
- The design-look results (appendix, after the freeze; descriptive only).
- The grepTests fix sha.

## Reporting every attempt (commitment)
The final MVP report lists every earlier attempt at this question with its result, next to this prereg's result:
- the mutation pilot (#374): 0/10 gaps located at line level;
- #397: escape line hits at chance (5.0% vs 4.5%);
- f2p (#408): 1/32 verified;
- `prereg-testgap-mvp.md`: retired unrun, design power 0;
- pack arms R, S, O and H: not adopted (#406);
- this prereg.
