# trace-recall: requirement and code retrieval set

A versioned set that measures what `src/trace.js` (and the test-candidates step of `src/collect.sh`) retrieves. No model is called. The target is fastify at a pinned SHA, so a number only moves when SpecGuard moves.

The set holds no target code: only paths, line ranges and the small edit strings in `cases.json`.

## Run

```
node eval/trace-recall/run.js      # needs the network and git; about 1 minute; writes results.json (git-ignored)
node eval/trace-recall/analyze.js  # prints the metrics; add --json out.json to save them
```

`run.js` fetches only the pinned commit into `<tmp>/specguard-trace-recall-<sha8>` (reused on later runs), makes each variant a local commit, runs `src/trace.js` with the same environment as `collect.sh`, then runs the very `candidates()` script found inside `src/collect.sh`. Options: `--out`, `--work`, `--only id1,id2`, and `--src <dir>` to measure another checkout's `trace.js` + `collect.sh` (for before/after comparisons).

It is not part of CI (network). CI runs only `analyze.test.js`, which checks the metric math on `fixture.json`.

## What is measured

12 behaviours, each as 3 variants: R (requirement doc edited), C (code edited), RC (both). The 36 variants are **12 independent cases**, not 36. A case is counted once per variant, so a rate such as 18/24 is 12 cases seen twice. Never quote it as "24 cases".

| Direction | Variants | Query | Relevant items (ground truth in `cases.json`) |
|---|---|---|---|
| req->code | R, RC | the changed requirement | `expect.code` line ranges (a retrieved window must overlap the range); `expect.tests` files |
| code->req | C, RC | the changed code | `expect.requirement` doc range (first line of the item within the range +-1); `expect.tests` via `test-candidates.txt` |

`code_file_level` is the same req->code retrieval counted by file only. It is secondary: a file is not a location.

Ranking: each criterion (or changed hunk, or changed file) gives one ranked list; an item's rank is its best rank over those lists. Candidates in a code->req hunk are ordered by score. Windows trace.js drops (the "more" note) are not ranked.

| Metric | Meaning |
|---|---|
| Hit@1, Hit@3 | at least one relevant item is within the top 1 or 3. Share of queries |
| Recall@1, @3, @K | share of all relevant items found within the top 1, 3, or anywhere in what was delivered (K = whole delivered list; equals @3 while trace.js keeps 3 per criterion). Pooled over queries |
| MRR@10 | mean of 1 / rank of the first relevant item (0 when none in the top 10) |
| All-required@3 | share of queries where every relevant item is within the top 3 |
| runtime p50, max | milliseconds per variant, trace plus candidates step, nearest-rank p50 |

Every rate prints as `k/n` next to the percentage. A query with no relevant item is excluded from every denominator and reported as `empty_relevant_excluded`; it is never scored 0 or 1.

**MRR high does not mean all entries were found.** A behaviour that must change in three places can have MRR 1 (the first candidate is right) and Recall 1/3 and All-required 0. Read MRR as "how fast the first right place appears", Recall as "how much of the impact is covered", and All-required as "is the evidence complete". Quote them together.

## Baseline

`baseline.json` has the same metrics for main before and after PR #239, taken from the raw `trace.js` outputs of the harness that first measured it. Compare a new run to `after_239`.

## Add a case

1. Pick one behaviour stated in the target's docs with a literal value, and find the doc lines and every code location (and tests) that carry it.
2. Add an entry to `cases.json`: `edits.R` changes the doc, `edits.C` changes the code (each edit is `{file, old, new}`, optionally `line` to limit to one line or `all`). `expect.requirement`, `expect.code` (`lines`, optional `alt` ranges for generated duplicates) and `expect.tests` are the ground truth. List every required location, not only the first.
3. `node run.js --only <id>` must apply without an "edit misses" error. Then run the full set and check the numbers.
4. To use another target or SHA, change `target` and re-measure; keep old baselines tied to their SHA.

Cover other value formats too (thousands separators, units, long files, multi-entry behaviours); one fixed format hides regressions in the others.
