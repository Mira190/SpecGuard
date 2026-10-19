# Pre-registration: cut relevance for the PR run status (fixed 2026-10-19, before any arm R data is read)

**Problem.** A PR run is marked incomplete ("Review context was cut") whenever any candidate test file was cut from the context pack. That was 195 of the 213 incomplete runs out of 288 in holdout 2, and 29 of 38 of SpecGuard's own PRs #345-#386 (all mostly large test files that are weak candidates). A label that is on for most runs tells the reader nothing.

**Rule R** (the scan already uses it for findings: `src/audit-post.js` `cutTest`). A cut candidate test of a changed file makes the run incomplete only when it mentions (whole word) the name of a definition that encloses a changed line of that file (`test-map.enclosingName`). It stays incomplete, as on main, when:
- no name can be derived for some changed line of that file;
- the cut test cannot be read;
- any finding was gated by partial visibility;
- a changed file itself was cut past a changed line (unchanged rule).

R changes only the status, the head marker and the notice. It never changes which findings are kept, their confidence or where they are placed.

**Arms.** A = main. R = `EXP_CUT_RELEVANCE=1`, a measurement switch that is removed once a decision is made.

**Corpora.**
1. Holdout-2 raw answers: Kite runs 39120706885, 39120718089, 39120729276 (bugs) and 39120712567, 39120723905, 39120735452 (controls). They are re-run with `eval/replay-arms.js --engine mock-replay`.
2. SpecGuard's own dogfood runs on PRs #345-#386, where the `specguard-ctx` artifact can still be downloaded.

**Gate first.** Arm A must reproduce the published status, headline and inline count. The bar is the existing one: 288/288 on corpus 1.

**Adopt R as the default iff all of:**
1. On every run, the findings, their confidence and their placement (inline / summary / Details) are identical between A and R. Only the status, notice and head marker may differ. This is checked mechanically.
2. No run in R shows a clean verdict while it has a finding gated by partial visibility. This is checked mechanically.
3. Audit of the flips (A incomplete, R complete). Take all of them, or 30 drawn with seed 20261019. A grader reads the unseen part of each cut test together with the diff, and answers: does it directly test a changed definition? At most 1 of the audited flips may be judged "yes".
4. Effect: at least one third of the corpus-1 runs whose only incomplete reason on main is the cut become complete. Below that, the extra code is not worth it.

**Report** k/n for each corpus: incomplete A vs R; flips; audit verdicts; runs whose verdict changed to ✅.

**Limitation.** The rule is a name-mention proxy. A test that drives the change through a public entry point (route, CLI) without naming the definition counts as irrelevant. Audit item 3 is what bounds that risk. Corpus 1 repeats a fixed PR set (3 reps of the same PRs are not independent). Corpus 2 is a different repository and was not used to design R.

## Amendment 1 (2026-10-19, after the red-team review by specguard-cf)

**What had been read when this was written.** The implementing agent had already computed corpus 2's per-PR A/R decisions for a914ff5. Of those, the author saw one row: #345, where the cut set is the same under A and R. On corpus 1, arm outputs existed for 2 of the 6 runs, and the author had not read them. This amendment therefore only tightens the gates or adds an arm. It never loosens them.

**Code changes, before any arm is re-run:**
- A changed file whose diff has a deletion-only hunk (LEFT lines with no RIGHT line in the same hunk) makes every cut candidate of that file count. The deleted definition's tests are exactly the ones that need reading. In a914ff5 such a file counted as irrelevant: this was a bug.
- Names are deduplicated per changed file, one regex is compiled per file, and reads are memoised.
- New tests: a deletion-only diff; two changed definitions where the cut test names only one (relevant); a changed top-level statement with no derivable name (relevant).

R is re-run on both corpora with the fixed code. Output from a914ff5 is discarded.

**Arm S, added.** A cut candidate counts only if it is a strong candidate. "Strong" is decided from the reason string in `test-candidates.txt`:
- same name (stem), or one that imports the changed file, is strong;
- a file name containing a changed token, or a file that mentions a changed name, is weak.

The agent lists the full reason vocabulary from `collect.sh` and fixes this classification in the report before computing S. S reads no files. If both R and S pass, S is adopted, because it is simpler. If only one passes, that one is adopted. If neither passes, nothing is adopted.

**Gate 3, replaced.**
- **Sample.** Every flip (A incomplete → arm complete) is audited, per arm, up to 120 drawn with seed 20261019. They are mixed with an equal number of cuts that the arm judged relevant, drawn with the same seed. The order is shuffled and the arm is hidden.
- **Packet.** Each packet shows the changed file's diff and the unseen part of the cut test: the lines past pack-shown, or the whole file if it was not shown.
- **Question.** "Does the unseen part directly test a changed or deleted definition?"
- **Graders.** Two independent model graders, a Sonnet and an Opus subagent, each with no other context. Report raw agreement and Cohen's kappa. If kappa < 0.8, the verdict does not count and the decision is deferred. The main session adjudicates disagreements and records how each was settled.
- **Bar.** The 95% Clopper-Pearson upper bound of the "yes" rate among the flips must be ≤ 10%. For example: 0 bad needs n ≥ 29, 1 bad needs n ≥ 46, 2 bad needs n ≥ 61. If there are too few flips to reach the bound, the arm is not adopted.
- **Why 10% and not 5%:** findings never change. A false complete costs only the notice and the retry. On main, the notice is wrong in the other direction on most runs.

**Gates 1–4 must pass on both corpora** (stricter than the original rule). The unit is the PR.
- **Corpus 1.** A PR counts as flipped when all of its runs whose only incomplete reason on main is the cut become complete. The gate 4 denominator is the PRs that have at least one such run.
- **Corpus 2.** Use the latest run with an artifact per PR.
- Run-level counts are reported as well.

**Also report** the flips split by the enclosing name that was matched: the top 10 names and the distribution of name lengths. This shows whether the effect comes from short common names.
