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
