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

12 behaviours, each as 3 variants: R (requirement doc edited), C (code edited), RC (both), plus T (a test assertion weakened) for 10 of them. The 46 variants are **12 independent cases**, not 46. A case is counted once per variant, so a rate such as 18/24 is 12 cases seen twice. Never quote it as "24 cases".

| Direction | Variants | Query | Relevant items (ground truth in `cases.json`) |
|---|---|---|---|
| req->code | R, RC | the changed requirement | `expect.code` line ranges (a retrieved window must overlap the range); `expect.tests` files |
| code->req | C, RC | the changed code | `expect.requirement` doc range (first line of the item within the range +-1); `expect.tests` via `test-candidates.txt` |
| test->code | T | the changed test (one assertion weakened) | `expect.code` line ranges, matched against the code windows trace.js emits (`requirement_to_code`) |
| test->req | T | the changed test (one assertion weakened) | `expect.requirement` doc range, matched against `code_to_requirement` candidates |

**T variant.** `edits.T` is a test-only edit that replaces an exact assertion with a truthiness check (`strictEqual(1048576, x)` becomes `ok(x)`). It exists only where a test in `expect.tests` has one clear asserting line; 10 of the 12 cases have it, so test->code / test->req have 10 queries. Skipped: `hookOrder` (order is checked through a call counter across many tests, no single line) and `stringPlain` (the `text/plain; charset=utf-8` assertion in `500s.test.js` is on the error path, the others are on `reply.type()`; none pins the send(string) default). Ground truth is the case's own `expect.code` / `expect.requirement`. The five cases `connectionTimeout`, `keepAliveTimeout`, `maxParamLength`, `ignoreTrailingSlash`, `pluginTimeout` share one T edit (the `deepStrictEqual(Fastify().initialConfig, fastifyDefaultOptions)` line in `initial-config.test.js`), so those five are one weakened test, not five independent ones.

What a test-only PR retrieves today: nothing. `src/trace.js` drops test hunks from `code_to_requirement` (`codeHunks(...).filter(!h.is_test ...)`, trace.js:981) and a test file is no requirement, so no criterion exists for `requirement_to_code`. `collect.sh`'s `candidates()` skips test files as changed files (collect.sh:287). Both outputs are empty, so T scores 0 by construction. This is the measured gap, not a harness fault: nothing in `src/` was changed to make T pass. The deleted/weakened-assertion signal comes only from `src/leads.js` (`assertionDelta`), which names the test, not the code behaviour or requirement.

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

## T result (pinned fastify, main at the time of this PR)

| Direction | Hit@3 | Recall@K | MRR@10 |
|---|---|---|---|
| test->code | 0/10 | 0/26 relevant code ranges | 0 |
| test->req | 0/10 | 0/10 | 0 |

All 10 T variants ran with status ok and emitted empty `requirement_to_code`, `code_to_requirement` and `test-candidates.txt`. The req->code and code->req numbers on the same run, computed with the pre-change `analyze.js` on the R/C/RC variants only, are identical to the new `analyze.js` (all fields compared). These 10 are 10 cases (at most 6 distinct weakened tests, see above), not 10 independent trials; the result is all-or-nothing because the pipeline has no test-to-code path.

## Baseline

`baseline.json` has the same metrics for main before and after PR #239, taken from the raw `trace.js` outputs of the harness that first measured it. Compare a new run to `after_239`.

## Add a case

1. Pick one behaviour stated in the target's docs with a literal value, and find the doc lines and every code location (and tests) that carry it.
2. Add an entry to `cases.json`: `edits.R` changes the doc, `edits.C` changes the code (each edit is `{file, old, new}`, optionally `line` to limit to one line or `all`). `expect.requirement`, `expect.code` (`lines`, optional `alt` ranges for generated duplicates) and `expect.tests` are the ground truth. List every required location, not only the first.
3. `node run.js --only <id>` must apply without an "edit misses" error. Then run the full set and check the numbers.
4. To use another target or SHA, change `target` and re-measure; keep old baselines tied to their SHA.

Cover other value formats too (thousands separators, units, long files, multi-entry behaviours); one fixed format hides regressions in the others.
