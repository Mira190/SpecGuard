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

## Current main and where misses are lost

Measured on main `dce3336` (after #373) with `run.js` then `analyze.js`: every metric equals `after_hunk_tokens` (no k/n moved); row `main_dce33369` in `baseline.json`. 24 queries per kind are 12 cases seen twice.

| list | Hit@1 | Hit@3 | Recall@3 | MRR@10 | All-required@3 |
|---|---|---|---|---|---|
| req->code code | 18/24 | 18/24 | 26/58 | 18/24 (0.750) | 6/24 |
| req->code tests | 18/24 | 20/24 | 28/54 | 19/24 (0.792) | 8/24 |
| code->req requirement | 10/24 | 15/24 | 15/24 | 12.17/24 (0.507) | 15/24 |
| code->req tests | 18/24 | 20/24 | 28/54 | 19.5/24 (0.813) | 6/24 |

(MRR is a sum of reciprocal ranks over the 24 queries.) Recall@K equals Recall@3 except code->req tests (32/54).

### Attribution (`node analyze.js results.json --attribute`)

Every relevant item that is not within the top 3, by what the raw outputs show. `trace.js` keeps only the top 3 code and top 3 test windows per criterion and names at most 5 dropped paths in the "more" note, so many items are `unknown` from the outputs alone.

| list | misses | ranked_out | cut (note names it) | not_retrieved | unknown |
|---|---|---|---|---|---|
| req->code code | 32/58 | 0 | 6 | 2 | 24 |
| req->code tests | 26/54 | 0 | 6 | 4 | 16 |
| code->req requirement | 9/24 | 0 | 0 | 9 | 0 |
| code->req tests | 26/54 | 4 | 0 | 22 | 0 |

To resolve the `unknown` (and the silent per-hunk cap in code->req), the same set was run once against a scratch copy of `src/` with `TOP_CAND`, `PER_HUNK` and the BM25 `FLOOR` lifted (`run.js --src <copy>`; not committed, measurement only). Result:

| list | misses | in the list only beyond the caps (cut) | absent even uncut (never found) |
|---|---|---|---|
| req->code code | 32 | 14 (ranks 4 to 7) | 18 |
| req->code tests | 26 | 8 (ranks 4 to 6) | 18 |
| code->req requirement | 9 | 0 | 9 |
| code->req tests | 26 | 4 (ranks 4, 5; plain ranked_out) | 22 |

The uncut run is only for attribution: Hit@3 and All-required@3 are unchanged because they count ranks 1 to 3; the cut items sit at ranks 4 to 7.

### req->code: required locations found, per case (R and RC give the same result)

Found (at any delivered rank) / required: bodyLimit 1/3, connectionTimeout 2/3, keepAliveTimeout 1/3, maxParamLength 2/3, ignoreTrailingSlash 0/3, return503OnClosing 2/2, pluginTimeout 1/3, requestIdHeader 0/2, hookOrder 0/1, redirect302 1/1, stringPlain 2/2, notFound404 1/3. Only 3 cases are complete.

The 32 missed locations (counted per query): 24 a different file in another directory, 4 a different file of the same directory (`lib/content-type-parser.js`, `lib/server.js`), 2 a second location in the same file as a hit (`lib/four-oh-four.js:119` next to the hit at `:52-60`), 2 the generated duplicate (`lib/config-validator.js:883`, generated from `build/build-validation.js`).

### Three largest loss buckets

1. **Never found, even uncut: the schema source `build/build-validation.js`** (12 of the 18 never-found code items; also the only place a value is declared). Example `bodyLimit-R`, `build/build-validation.js:32`: the retrieval returns the generated `lib/config-validator.js` lines, not the generator.
2. **code->req tests never listed (22/54)** and 9/24 code->req requirements never found. Example `keepAliveTimeout-C`: the edit is in `lib/config-validator.js`, `test-candidates.txt` lists tests that mention the changed tokens, not `test/keep-alive-timeout.test.js`; `hookOrder-C` (`lib/route.js:394`) gets `docs/Reference/Hooks.md:593` and never the required `Hooks.md:770-815`.
3. **Cut by the top-3 per criterion (14 code, 8 test items, ranks 4 to 7).** Example `notFound404-R`, `lib/four-oh-four.js:119`: found at rank 7 behind other windows, while `lib/four-oh-four.js:52-60` is delivered; `ignoreTrailingSlash-R` `lib/route.js:108` is rank 6, `lib/config-validator.js:883` rank 4.
