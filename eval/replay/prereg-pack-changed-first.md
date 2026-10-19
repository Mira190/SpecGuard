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

## Amendment 1 (2026-10-19, after the red-team review by specguard-cf; before any arm was computed)

The implementing agent had started on the arm-A reproduction and the fresh-corpus inputs. It was told to compute no arm until this amendment. The changes below only add an arm or tighten gates.

**Arm O, added; it is tried first.**
- **Order.** The review files of `files.txt` go in first: changed source files over their room use the `hunks` mode, the others go in as on main. Then come the in-scope rule files (the F filter), filling the remaining budget in the FC sort order below. Then the candidate tests and the remaining tiers, as on main.
- **Why.** It addresses the cause directly: the order, not the amount of rules. It drops a rule only when the budget is exhausted.
- **Adoption order** becomes O < F < FC < FCH. The first arm that passes is adopted.

**FC sort.** Before the cap, the in-scope rule files are sorted:
1. by the number of changed files their scope covers, most first;
2. then by scope width: a scope that names a directory or file pattern comes before `**` or a missing scope;
3. then by `standards.txt` order.

The cap then stops the block at the first file that does not fit. O fills its remaining budget in the same order.

**Gate 6, added: no lost rule where there was room.** On every PR where A loses no changed line, each arm's pack contains every in-scope rule file that A's pack contained, at the same bytes. This applies on all three corpora.

**Rule cost, reported.** For every arm, report the number of in-scope rule files dropped (relative to A), per PR and in total, on each corpus.
- O drops in-scope rules only when the review files exhaust the budget. Those drops are reported as the cost of the fix.
- For FC and FCH, the result section must state the drop count, and the decision must accept that cost in writing.
- Gate 6 already forbids drops where A had room.

This departs from the red-team text, which asked for "0 in-scope drops for O" on every PR. That would fail O on exactly the PRs it is meant to fix, where the rules and the changed code cannot both fit. Gate 6 enforces 0 wherever both fit.

**Gate 2, tightened.**
- **Fresh-corpus source.** The fresh corpus uses the latest first-parent commits of the default branch, whether or not they are merges, so squash-merge repos are included. Each commit is diffed against its first parent.
- **Growing the corpus.** If fewer than 10 PRs in the fresh corpus have A losing a changed line, the corpus is grown in fixed steps until it reaches 10: up to 60 commits per repo, then the remaining cloned repos, whatever the size of their rule files. Each step's list is frozen before any arm runs on it.
- **No fallback.** If 10 still cannot be reached, nothing is adopted. The gate-1 fallback is removed.

## Amendment 2 (2026-10-19, after the amendment-1 result; a new test, not a rescue)

The amendment-1 decision stands: nothing is adopted. O failed gate 6 on 3 PRs (1 holdout, 2 fresh step 1).

**Cause, read from the result.** In all 3 PRs, a changed file has only deleted lines. A showed that file with 0 lines. The lost-line measure checks RIGHT lines only, so it counted A as "no loss". O showed the deleted lines, and the rule file went to make room for them. So the gate measured a blind spot, the same deletion-only blind spot found in the cut-relevance experiment. It was not a defect in O.

**New measure, "loses changed content".** A PR loses changed content when either of these holds:
- a changed RIGHT line falls past what the pack shows (the old measure);
- a changed file with deleted LEFT lines appears in the pack with 0 lines.

Gates 1, 2, 3 and 6 use this measure from now on.

**Design corpora.** Holdout 2, fresh step 1 and SpecGuard #345–#386 have now been read. They are design corpora. Their numbers under the new measure are reported, but they decide nothing.

**Confirmation corpus.** It uses steps already frozen in `pack-analysis/fresh-corpus.txt` (09:37:15Z) and never run for any arm:
- all of step 2;
- from step 3, the first 10 lines of each repo in file order.

It has not been prepared yet. Consecutive commits share rule files, so the unit is the PR, and the per-repo split is reported.

**The arm.** O only, with the code unchanged from amendment 1 (`EXP_PACK=O`, commit e94f451 on the rewritten history). There is no new arm and no tuning.

**Adopt O iff all of these hold on the confirmation corpus:**
1. **Enough loss to test.** A loses changed content on at least 10 PRs. Otherwise nothing is adopted.
2. **The fix works.** At least half of those PRs no longer lose changed content under O.
3. **No new loss.** 0 PRs newly lose changed content.
4. **No rule loss where both fit (gate 6).** On every PR where A loses no changed content, O's pack contains every in-scope rule file that A's pack contained, at the same bytes.
5. **Rule citations (gate 4, re-checked on holdout 2).** 0 kept standards findings cite a rule file that O drops. SpecGuard #345–#386 must show 0 newly lost.
6. **Rule cost.** O's in-scope rule drops (total, and PRs affected) are reported on every corpus. The adoption text accepts that cost in writing.

**Not changed by this amendment.** `post.js` still counts RIGHT lines only for the run status. Whether a deletion-only changed file shown with 0 lines should mark a run incomplete is a separate question. It needs its own pre-registration.

**Amendment 2 conditions (specguard-cf, accepted before any confirmation run).**
- **Provenance.** The measure was changed after O's result on step 1 had been seen. Two things make that acceptable:
  - The change has its own motivation. It closes the same deletion-only blind spot that the red team found in the cut-relevance experiment (amendment 1, first code change), where a deletion-only file was not counted as unseen.
  - The verdict comes only from frozen steps that were never run for any arm.
- **Sample floor.** The confirmation corpus is fixed as defined above: all of step 2, plus the first 10 per repo of step 3. If A loses changed content on fewer than 10 of its PRs, nothing is adopted. No further lines of step 3 are drawn.
- **One run.** O at e94f451 runs once on the confirmation corpus. There is no amendment 3 to rescue it.
  - **If it fails:** the result is "not adopted", and the reason is written down.
  - **If it passes:** the PR that adopts O deletes the F, FC and FCH code and the `EXP_PACK` switch, and keeps only O's code path as the default.
