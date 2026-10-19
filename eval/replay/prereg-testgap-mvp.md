# Pre-registration: do missing-test findings land on real test-gap bugs at PR time? (fixed 2026-10-20, before any arm is run)

**Question.** The phase-1 MVP claim is: when SpecGuard reviews a PR, its delivered `missing_test` and `weak_test` findings point at the code where a bug was introduced that a test would later have caught. "Point at" means more often than findings placed at random among the PR's changed functions.

**What earlier evals say:**
- The holdout-2 semantic catch rate (20.7%) has no chance baseline.
- The mutation pilot located 0/10 gaps at line level (#374).
- On SpecGuard's own history, line hits were 5.0% against a chance level of 4.5% (#397).

So this eval is designed to be able to fail.

**System under test.** The copilot engine, model `gpt-6-luna`, run through the local copilot runner (specguard-ad). Before the confirmation run, the following are frozen and written into the result: the SpecGuard sha, the prompt files, engine settings, budget, and `focus`/pack settings. Each run serves only the PR title and body, with no linked issues, as in holdout 2.

## Corpus: test-gap bug pairs (mechanical, no human confirmation)

A **fix F** qualifies iff all of these hold:
1. `eval/szz.js mine` lists it as a fix (message or label signal).
2. It is a single-parent commit on the default branch.
3. It changes at least one non-test source line and has at most 400 changed lines.
4. It adds or changes test lines, and those test lines contain, as a whole word, the name of a definition that encloses one of F's changed source lines. Names come from `enclosingName` in `src/test-map.js` on F's parent and head.

The **introducing PR I** is the commit that `szz.js` blame of F's removed source lines attributes the most lines to (at least 3 blamed lines). Further conditions:
- It is a squash commit that maps to a PR, as in holdout 2's `replay_eligible`.
- It has 30–1200 changed lines and at most 40 files.
- One pair per I.
- Fixes that only add lines have no blamed lines. They are excluded and their count is reported.

The **bug location B** is:
- the blamed lines, as their line numbers in I (`szz.js` `spots`); plus
- the line span of each definition in I's head that encloses a blamed line.
- A blamed line outside any definition gets only its ±3-line window.
- The share of blamed lines that resolve to a definition is reported.

**Design set.** Holdout 2's 45 pairs filtered by the rule above. Prompt, model settings and code may be iterated here, with every iteration and its result recorded. Nothing measured on this set decides anything.

**Confirmation set.** It comes from the 12 clones in `SpecGuard-evidence/repos`, at their current HEADs (clone HEAD dates 2026-10-15 to 10-19); nothing new is cloned.
- **Bug PRs.** Fixes dated 2026-01-01 to clone HEAD. Excluded: any pair in holdout 1, holdout 2, `pairs.json`, `clean.json` or the design set. Take the most recent qualifying pairs per repo, at most 6 per repo, until there are 48. That allows up to 8 unusable runs and still leaves n ≥ 40.
- **Controls.** 40 PRs from `szz.js clean` on the same repos, spread over the repos in proportion to the bug PRs, with seed 20261020 and a window ending at least 90 days before the clone HEAD. A control is dropped and replaced, in sampler order, if any of its lines is blamed by a fix from the mined list within 90 days after it.
- **Freeze.** Both lists go to `eval/replay/testgap-confirm.json` with a UTC timestamp, committed before any arm runs on any of them. If fewer than 40 bug PRs qualify, the result is "not tested", not a smaller-n verdict.

## Primary metric (mechanical, no grader)

A **catch** on a bug PR is a delivered finding that meets all three conditions:
- Delivered: inline, or in the summary's visible list. Not low confidence, and not only in the collapsed Details.
- Its kind is `missing_test` or `weak_test`.
- Its path and line fall inside B's definition spans or within ±3 lines of a blamed line, on I's head.

A finding with no line is never a catch. The unit is the PR, and observed = PRs with at least 1 catch / usable PRs. A run is unusable if the engine or publisher failed or the context pack is empty; unusable runs count as misses end to end, and are also reported separately.

`weak_test` findings usually cite a test file, so they rarely hit B. Their hits are reported separately as well as inside the total.

## Null and lift

- **Eligible findings.** Delivered missing_test/weak_test findings with a line in a non-test source file.
- **Units.** I's changed definitions: every definition in I's head that contains at least one added line. Added lines outside any definition form one top-level unit per file.
- **Primary null.**
  - Each eligible finding is reassigned to a unit drawn with probability proportional to its added lines. This is the function-level form of #397's "draw from the added lines".
  - Its line becomes a uniformly drawn added line in that unit, and it is then scored by the catch rule.
  - 1000 permutations, seed 20261020, giving a chance rate with a 95% interval.
- **Secondary null.** The same, with units drawn uniformly.
- **Verdict null.** The verdict uses whichever of the primary and secondary nulls gives the higher upper bound.
- **Report:**
  - observed k/n, with its PR-cluster bootstrap 95% interval (2000 resamples, same seed);
  - chance [95%], from both nulls;
  - lift = observed / chance;
  - the one-sided permutation p, where p = the share of permutations with at least as many catching PRs as observed;
  - the per-repo split;
  - findings eligible, permuted, and not eligible.

## MVP pass: confirmation set, single run, no rescue amendment

**PASS iff** the PR-cluster bootstrap lower bound of observed is above the verdict null's 95% upper bound.

Otherwise the result is FAIL. The result is written as observed, chance, lift and p, whatever happens. There is no second run and no amendment after the confirmation run starts.

**Repetitions.** These are fixed before the freeze, from the copilot cost per run that specguard-ad measures:
- 3 runs per PR if 3 × 88 runs fit the owner's approved budget; otherwise 1 run per PR.
- With 3 runs, a PR's observed value is the mean of its runs, and the bootstrap resamples PRs.

**Power check.** This runs on the design set before the freeze and is reported, not gating. It gives the probability of PASS at n = 40, given the design-set observed and chance rates. If that probability is below 0.5, it is reported to the owner before the confirmation run.

## Secondary measures (reported, not gating)

1. **Semantic grade with blinding.** The holdout-2 rubric, graded blind on real pairs mixed with mismatched pairs (a finding set from a different PR of the same repo). The false-catch rate is the share of mismatched pairs graded caught. This needs the owner's cost approval; if it is not approved, it is not run.
2. **Noise.**
   - On controls: delivered missing_test findings per PR, inline comments per PR, and the share of PRs with any inline comment.
   - The same figures on bug PRs, for comparison.
3. **Verified fail-to-pass.** On catches in hono, rqlite, sqlglot and langchain, specguard-33's harness writes a test from the finding text alone. The test is verified if it fails on I's tree and passes on F's tree. Reported as k/catches.
4. **Cost.** Copilot cost per run and per PR.

## Limitations

- SZZ blame and the mechanical fix filter are noisy, and pairs are not confirmed by reading. Before any arm runs, a reading of 20 random confirmation pairs reports the share that are real test-gap bugs. That share is reported but changes nothing.
- The repos are public. Contamination cannot be ruled out: the fixes may predate the model's training cutoff.
- `enclosingName` uses line regexes, not a parser. The share of blamed lines resolved to a definition is reported.
- Location is necessary but not sufficient: a catch here shows that the finding pointed at the right code. Whether its text describes the bug is measured only by secondary measures 1 and 3.
