# trace-recall: requirement and code retrieval set

A versioned set that measures what `src/trace.js` (and the test-candidates step of `src/collect.sh`) retrieves. No model is called. The target is fastify at a pinned SHA, so a number only moves when SpecGuard moves.

The set holds no target code: only paths, line ranges and the small edit strings in `cases.json`.

## Run

```
node eval/trace-recall/run.js      # needs the network and git; about 1 minute; writes results.json (git-ignored)
node eval/trace-recall/analyze.js  # prints the metrics; add --json out.json to save them; --group original|holdout or --only id1,id2 to select cases
```

`run.js` fetches only the pinned commit into `<tmp>/specguard-trace-recall-<sha8>` (reused on later runs), makes each variant a local commit, runs `src/trace.js` with the same environment as `collect.sh`, then runs the very `candidates()` script found inside `src/collect.sh`. Options: `--out`, `--work`, `--only id1,id2`, and `--src <dir>` to measure another checkout's `trace.js` + `collect.sh` (for before/after comparisons).

It is not part of CI (network). CI runs only `analyze.test.js`, which checks the metric math on `fixture.json`.

## What is measured

12 behaviours (plus 3 holdout, below), each as 3 variants: R (requirement doc edited), C (code edited), RC (both), plus T (a test assertion weakened) for 10 of them. The 46 variants are **12 independent cases**, not 46. A case is counted once per variant, so a rate such as 18/24 is 12 cases seen twice. Never quote it as "24 cases".

| Direction | Variants | Query | Relevant items (ground truth in `cases.json`) |
|---|---|---|---|
| req->code | R, RC | the changed requirement | `expect.code` line ranges (a retrieved window must overlap the range); `expect.tests` files |
| code->req | C, RC | the changed code | `expect.requirement` doc range (first line of the item within the range +-1); `expect.tests` via `test-candidates.txt` |
| test->code | T | the changed test (one assertion weakened) | `expect.code` line ranges, matched against the code windows trace.js emits (`requirement_to_code`) |
| test->req | T | the changed test (one assertion weakened) | `expect.requirement` doc range, matched against `code_to_requirement` candidates |

**T variant.** `edits.T` is a test-only edit that replaces an exact assertion with a truthiness check (`strictEqual(1048576, x)` becomes `ok(x)`). It exists only where a test in `expect.tests` has one clear asserting line; 10 of the 12 cases have it, so test->code / test->req have 10 queries. Skipped: `hookOrder` (order is checked through a call counter across many tests, no single line) and `stringPlain` (the `text/plain; charset=utf-8` assertion in `500s.test.js` is on the error path, the others are on `reply.type()`; none pins the send(string) default). Ground truth is the case's own `expect.code` / `expect.requirement`. The five cases `connectionTimeout`, `keepAliveTimeout`, `maxParamLength`, `ignoreTrailingSlash`, `pluginTimeout` share one T edit (the `deepStrictEqual(Fastify().initialConfig, fastifyDefaultOptions)` line in `initial-config.test.js`), so those five are one weakened test, not five independent ones.

Before the fix a test-only PR retrieved nothing: `src/trace.js` dropped test hunks from `code_to_requirement` and a test file is no requirement, so no criterion existed for `requirement_to_code`. Now `weakenedQueries` (trace.js) takes the removed or weakened assertions that `src/leads.js` `assertionDelta` flags (the one heuristic, reused) and builds a query from the removed line: its literals and subject identifiers. A removed line with no literal makes no query. The query ranks requirement items and descriptive blocks that hold one of its literals (test->req, emitted as `code_to_requirement` hunks on the test file) and searches the code windows, keeping those that hold a literal (test->code, emitted as `requirement_to_code` rows `T1`.. with no tests). Entries carry `via: "test"` and a `note`. They are appended after the real code hunks and S* rows, under the same hunk limit and budget.

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

## T result (pinned fastify, after the weakened-assertion trace)

| Direction | Hit@3 before | Hit@3 after | Recall@K after | MRR@10 after |
|---|---|---|---|---|
| test->code | 0/10 | 2/10 | 2/26 relevant code ranges | 0.200 |
| test->req | 0/10 | 3/10 | 3/10 | 0.150 |

False locations: 0 of the 2 emitted T code windows miss every `expect.code` range (`bodyLimit` and `redirect302` hit; the other 8 variants emit no code window). All 3 emitted test->req hunks (`bodyLimit`, `return503OnClosing`, `redirect302`) contain the expected doc item within their top 3; they also list other doc items of the same hunk. A literal held by over 1% of the code windows (3 at least), or by the same share of requirement items, is dropped, and so is a literal the code scan found common (`LIT_SHARE`, trace.js); a query whose literals are all dropped makes no query. This removed `notFound404` (404 is a common status code, the same class as 200). Noise check on real fastify tests, not in cases.json: removing a `statusCode, 200` line, a `content-type` `application/json` line and a `route.method, 'GET'` line emitted 3 code windows and 2-3 doc items each before the cutoff, 0 and 0 after; a `listening, true` line has no quoted or numeric literal and emitted nothing either way. The five initial-config cases stay misses by design: their one shared assertion has no literal on the line, so no query is made (identifiers alone would point at unrelated code).

req->code and code->req (and test candidates) are field-for-field identical to main on all 36 R/C/RC variants (raw trace outputs compared, plus the `analyze.js` summary). These 10 are 10 cases (at most 6 distinct weakened tests), not 10 independent trials. Unit tests: `src/trace-weakened.test.js`.

## T random sample (unselected assertions)

The 10 T cases above were hand-picked. This asks what the weakened-assertion trace does on assertions nobody chose. `t-sample.js` lists every single-line `t.assert.{strictEqual,equal,deepStrictEqual,deepEqual,notStrictEqual,notEqual,notDeepStrictEqual,match}(...)` statement in the pinned fastify `test/` that `assertionDelta` flags once weakened (4646 lines in 187 files), draws 50 with a fixed seed (20261019), and turns each into a T variant: the line becomes `t.assert.ok(<the argument without a literal, else the first>)`. The sample, the emitted rows and the labels are in `t-sample.json`; `t-cases.json` is the same sample in `cases.json` shape.

```
node run.js --only none --work <dir>        # fetch + check out the pinned SHA once
node t-sample.js --work <dir> --force       # redraw (drops the labels); same seed, same sample
node run.js --cases t-cases.json --variants T --work <dir> --out <dir>/t-results.json
node t-sample.js --report                   # the table below, from the labelled t-sample.json
```

Measured on main `3046d4a` (after #381). Labels: `right` = the window decides / the item states the value or behaviour the assertion pins; `related` = same feature, not the deciding place; `wrong` = unrelated (a literal coincidence is wrong). **One labeller, one target.** The 50 are 40 distinct test files, and the 6 variants that emit are in 6 files; assertions in one file are not independent trials.

| Measure | Result |
|---|---|
| variants with a literal on the removed line (a query) | 39/50 |
| variants that emit at least one row | 6/50 |
| variants with at least one `right` row | 3/50 |
| test->code windows emitted | 9 (4 variants: `right` 2/9, `right`+`related` 6/9, `wrong` 3/9) |
| test->req items emitted | 9 (4 variants: `right` 3/9, `right`+`related` 3/9, `wrong` 6/9) |
| bytes added to `trace-candidates.json` | p50 0, max 1419 (the 6 emitting variants add 409 to 1419) |

No row in 44/50: no literal of 2+ characters on the line 11 (`undefined`, `null`, `''`, `'/'`, `{ ok: true }`, a variable); literal found nowhere outside `test/` 8 (error messages, response bodies); literal held by many files 14 (`200`, `'content-type'`, `'world'`, `false`, `'fastify'`); literal rare enough to appear in 1-7 non-test files but still no row 11 (`415`, `204`, `400`, `500`, `'kaboom'`; for `415` and `204` the deciding line exists: `lib/handle-request.js:78`, `integration/server.js:28`).

Wrong rows (9 of 18): `'one','two','three','four','five'` matched number words in `TypeScript.md` / `Encapsulation.md` prose (5 doc items, 1 variant); `18`, `30` matched an SVG diagram, `package.json` version ranges and "30 consecutive days" in `LTS.md` (3 rows, 1 variant); `8000` matched an example server's listen port (1 row). Every wrong row comes from a bare number or a number word; all 5 `right` code/doc rows come from a long identifier (`FST_ERR_*`) or a full sentence. `related` rows are `types/errors.d.ts` unions and an import block for the same `FST_ERR_*` name.

Reading: the trace is silent on most real assertions (44/50 emit nothing), and its output on the rest is mixed: all 3 variants whose literal is a whole error code or sentence (`close`, `errors`, `throw` tests) get at least one `right` row (the code definition or the doc row), and all 3 variants whose literals are short (`'one'`..`'five'`, `'Boo'`/`18`/`30`, `8000`) get only `wrong` rows (6 doc items, 3 windows). Test->req precision is 3/9 and test->code `right` 2/9 (6/9 with `related`), so per row the noise is larger than the signal; per variant it is small (3 of 50 variants add noise, at most 1.4 KB).

Smallest change that the evidence supports (not implemented): make a query only when the removed line has a literal of 6+ characters (`weakenedQueries`, trace.js). In this sample it drops exactly the 3 noisy variants and keeps the 3 variants with `right` rows (their literals are 29, 30 and 30 characters). Caveat: chosen after seeing these 50, so it is fitted to them; confirm on a second seed (`--seed`) before shipping.

## Delivered windows and the per-criterion cap (wrong_windows)

`analyze.js` also reports, for req->code, `wrong_windows`: delivered code windows that overlap no `expect.code` range (incl. alt), as k/n of delivered windows (one window delivered for two criteria counts twice), the windows delivered per query (p50, max), and the bytes of `trace-candidates.json` per variant (p50, max; `run.js` records `cand_bytes`).

Cases flagged `holdout: true` (`onProtoPoisoning`, `exposeHeadRoutes`, `http2SessionTimeout`, 9 R/RC queries, 6 of them with code ranges) were written and committed before any cap rule was tried; report them apart from the original 12 (`--group holdout`).

Cap experiment (main at ccaf02d; trace.js keeps the top 3 code windows per criterion, ranks 4-8 are dropped). Rules: (a) flat top 5; (b) top 3, then up to 2 more windows from files already among those 3; (c) as (b), also from the same directory. 12 original cases, 24 queries (R/RC), then the 3 holdout cases, 6 queries:

| Rule | original: Recall@K | All-required@3 | wrong_windows | windows/query p50 (max) | bytes p50 | holdout: Recall@K | wrong_windows | windows/query p50 (max) |
|---|---|---|---|---|---|---|---|---|
| main (top 3) | 26/58 | 6/24 | 39/72 | 3 (6) | 8462 | 10/22 | 5/18 | 3 (3) |
| (a) top 5 | 32/58 | 6/24 | 80/120 | 5 (10) | 8947 | 16/22 | 11/30 | 5 (5) |
| (b) +2 same file | 32/58 | 6/24 | 61/101 | 4 (8) | 8462 | 13/22 | 12/28 | 5 (5) |
| (c) +2 same dir | 34/58 | 6/24 | 76/118 | 5 (10) | 8932 | 15/22 | 12/30 | 5 (5) |

Recall@3 and All-required@3 do not move by construction (extra windows sit at rank 4-5), and All-required over everything delivered stays 6/24 and 0/6 too: no rule completes a query. Every rule raises the wrong-window share (original 54% to 60-67%, holdout 28% to 37-43%), so none was shipped; `src/` is unchanged. The code->req, test candidates and the tests of req->code are field-for-field identical in all four runs.

Where the wrong windows are (main at 33b4862, by file class): original 23/39 `.js` source and 14/39 `.d.ts`, 2/39 a workflow `.yml`; holdout 3/5 `.js`, 2/5 `.d.ts`. All 46 right windows are `.js`. No wrong window on the 15 cases is in package.json/lockfiles, svg/html/css, `examples/` or `NOT_CODE_DIR`, so excluding those classes from the window search (tried in a scratch copy) changes nothing here; it only removed the 3 wrong windows of the T random sample (the sample that suggested it), so it was not shipped. The precision loss is ranking among source and declaration files, not file eligibility. Not acted on: `.d.ts` (it decides type contracts; every case here is a runtime value, and the holdout has now been seen).

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
