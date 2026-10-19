# Pre-registration: changed lines before rule files in the PR context pack (fixed 2026-10-19, before any arm is computed)

**Problem.** `contextPack` (`src/engines/claude-api.js`) adds every file in `standards.txt` first, limited only by the per-file cap and the total budget. In holdout 2, 21 of 96 PRs (63 of 288 runs, the same in all three reps) cut a changed file past a changed line, so the model never saw code under review. 14 of these PRs lost changed source or config lines. In 11 of the 21, the rule and skill files alone filled 243 of the 250 KB budget, so some changed files got 0 lines. pydantic-ai lists about 140 such files.

The diagnosis also found two other causes:
- A changed file over the per-file cap is shown as its head only, unless the pack is "tight". Lines past the head go unseen: for example gitea `notification.go` and query `Devtools.tsx`.
- A changed test file reached as another file's candidate gets only a fair share.

These numbers come from an exploratory read of holdout 2. Holdout 2 is therefore a design corpus here, and the gates below also use a fresh corpus.

**Principle.** The model cannot review lines it never sees. `post.js` already drops a standards finding whose rule does not cover the cited path (`standards-map.json`). A rule whose scope covers no changed file therefore cannot back any kept finding, yet it costs budget.

**Arms** (behind `EXP_PACK`, a measurement switch that is removed once a decision is made):
- **A:** main.
- **F:** a `standards.txt` file goes into the pack only if its `standards-map.json` scope covers at least one changed file. If the map is missing or unreadable, every file goes in, as on main.
- **FC:** F, plus the rule files together are capped at one file cap (`fileCap(limit)`). Files are kept in list order and the first file that does not fit stops the block. A dropped file is listed in the note as not included, not as cut.
- **FCH:** FC, plus a changed source file (not `TESTISH`) larger than its room is shown as its hunks with context (the existing `hunks` mode, window [10, 30]) even when the pack is not tight.

The change is the pack only. Prompts, schema, `post.js` and findings logic are unchanged.

**Corpora.** All measures are offline and deterministic; no model call.
1. **Holdout 2 (design corpus).** The 96 PRs, one rep each (the reps' packs are identical). Inputs are the saved collector outputs in `SpecGuard-evidence/holdout2-raw`, with the head trees from `SpecGuard-evidence/repos`.
2. **Fresh corpus, not used in the design.**
   - Source: the most recent first-parent merge commits of every repo under `SpecGuard-evidence/repos` whose rule files (the collector's standards globs) total over one file cap at the base commit.
   - Size: up to 30 merges per repo, excluding the holdout-2 PRs.
   - Inputs: built by running `src/collect.sh` (or the same code paths) on base = first parent, head = merge.
   - Freeze: the list of repos and commits is written down before any arm is computed.
3. **SpecGuard's own PRs #345–#386**, using their `specguard-ctx` artifacts.

**Measures, per PR:**
- whether any changed RIGHT line falls past what the pack shows (the `post.js` lost rule);
- the number of changed lines unseen;
- the rule bytes shown;
- candidate tests cut (`notWhole`) and how that set changes against A.

The unit is the PR.

**Adopt the simplest passing arm (F < FC < FCH) iff all of the following hold:**
1. **Design corpus.** PRs losing a changed source or config line go from 14/96 to ≤ 7/96. 0 PRs newly lose a changed line that A showed.
2. **Fresh corpus.** Among PRs where A loses a changed line, at least half no longer do, and 0 PRs newly lose a changed line. If A loses a changed line on fewer than 5 fresh PRs, the fresh corpus cannot test the fix: report that, and the decision rests on gate 1 plus a written caveat.
3. **SpecGuard PRs.** 0 PRs newly lose a changed line. For F and FC, the pack text is byte-identical to A on every PR whose rule files fit within one file cap and are all in scope.
4. **Kept rules still back findings.** In the holdout-2 arm-A published outputs, 0 kept standards findings cite a rule file that the arm would drop. F drops only out-of-scope files, so this holds for F by construction; for FC and FCH it is a real check.
5. **The full test suite passes**, with new tests:
   - an out-of-scope rule file is dropped;
   - a missing map keeps all rule files;
   - the cap stops the block in list order;
   - (FCH) a changed source file over its room is shown as hunks when the pack is not tight.

**Report** k/n for every gate, per arm and per corpus. Also report how changes in the cut-test set affect the run status: count PRs whose cut-test set grows or shrinks, and the flips of the "Review context was cut" notice.

**Limitation.** This measures what the model can see, not what it finds. Seeing the changed lines is necessary, not sufficient. Effects on findings need live runs, and those are not part of this decision. The cap value (one file cap) follows an existing constant; it was not tuned.
