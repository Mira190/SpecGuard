# Full-repository audit evaluation and optimization on complex third-party repositories (2026-10-17)

Baseline: main `2fb6f91` (after #258). All numbers come from real runs made today or from seeded evaluations that can be re-run offline, with the run ID or file location attached. Extrapolated values are marked separately, and anything not measured is written as "not measured".

## 0. Conclusions

| Question | Conclusion | Evidence |
|---|---|---|
| Can the full-repository audit finish on large multi-language repositories | **Yes**: all 5 repositories were green, $0.03–$0.20 per run, 27–48 seconds of model time | §2 |
| Are the model findings valuable | **No**: of the 8 counted findings, 0 are valuable; 6 of them correspond to tests that do exist, just not in the matched test files | §3 |
| Recall of deterministic static signals | **Only 11/40 under the delivered (first 20 visible lines) definition**; 21/40 with no cap; boundary class 0/10 | §4 |
| Precision of static signals | In a sample of 23 weak leads, 18 were judged wrong; unref leads on cobra (Go) were 6/10 real gaps, while on flask and fastify they were mainly "already tested through another entry point" | §4.3 |
| Bottleneck of coverage | **The budget pre-check is about 25 times too high**: every run shows "$1 allows only 4–5 calls", while only $0.03–$0.20 was actually spent | §2.2 |

> **Same-day update (§8)**: The optimizations have been merged, and `scan_scope: all` lets all 5 repositories finish every unit and document block in a single Action run (each < $1); a spot check of cobra found 7/7 true. §0–§7 below are the baseline before optimization.

> October 18 update (§9): after the external reviews were checked item by item, #343–#351 were merged; in full-repository scans, units that saw only part of their tests went from 262 → 79 on nest and 133 → 81 on hono; the manually labeled precision of the second-round findings is 65% (15% counting TP only); two deterministic downgrade rules were withdrawn because of counterexamples.

In one sentence: **the full-repository audit runs and is cheap on third-party repositories, but what is currently delivered to the user is almost all noise.** The false positives from model findings mainly come from insufficient recall of test matching; the static signals are held down in both recall and precision by 7 fixable deterministic bugs (binary test files, `t.assert.ok`, `toBeInstanceOf`, booleans, wrong line numbers, directory rules, CommonJS export names). All of these bugs have been located to code lines, and fix PRs are in progress (§6).

## 1. Method

1. **Real runs**: 5 manual runs on `specguard-run.yml`, with default settings (haiku-5.5, $1, max_units 12), `scan_issue: none` (stateless, one-off).

| Repository | Language / test framework | Commit | Run |
|---|---|---|---|
| nestjs/nest | TS monorepo / vitest | `c215fd9` | 39010882792 |
| fastify/fastify | JS / node:test (`t.assert.*`) | `37df44a` | 39010887745 |
| pallets/flask | Python / pytest | `d086db8` | 39010892833 |
| spf13/cobra | Go / testing | `adbc881` | 39010897273 |
| honojs/hono | TS / vitest | `08807ce` | 39010902493 |

2. **Manual labeling**: open, one by one, the 8 counted model findings from the 5 runs, look for evidence in the tests at the corresponding commit, and record `file:line`.
3. **Offline seeded evaluation**: plant 8 gaps in the local clone of each repository, 40 in total:
   - 3 "delete all test references to an exported function"
   - 3 "change a value assertion to a truthiness-only assertion"
   - 2 "delete a boundary-value case"

   Then call `inventory()` + `staticLeads()` directly on HEAD and on the seeded commit, and compare the newly added leads. The whole process does not execute repository code and pushes nothing. The scripts and data are in `seed-eval/` in the session scratchpad (`scripts/scan.js`, `out/<repo>-truth.json`, `out/results.json`).

## 2. Real runs

### 2.1 Funnel and cost

| Repository | eligible units | Reviewed this run (full + partial tests) | Calls | Cost | Counted findings | Static leads |
|---|---|---|---|---|---|---|
| nest | 1015 | 40 (30 + 10) | 5 | $0.034 | 1 | 53 |
| fastify | 35 | 16 (10 + 6) | 6 | $0.195 | 4 | 13 |
| flask | 21 | 19 (9 + 10) | 5 | $0.038 | 2 | 32 |
| cobra | 13 | 8 (2 + 6) | 5 | $0.081 | 0 (incomplete) | 29 |
| hono | 206 | 15 (8 + 7) | 5 | $0.039 | 1 | 28 |

All funnel rows reconcile: eligible = inventoried; selected = full + forced + not reached.

### 2.2 The budget pre-check is about 25 times too high (the first bottleneck of coverage)

Every run says "max_budget_usd $1.00 allows 4–5 calls" while also listing 7–18 "unit parts not reached (budget)". The actual spend was only $0.03–$0.20. The cause is in `src/engines/claude-api.js`:

- `worstCase()` (line 32) estimates the input using `PRE_FLIGHT_BPT = 1.5` bytes/token. Measured code with line numbers is 1.7–2 bytes/token. A pack of about 150 KB is therefore estimated at more than 100k tokens, which falls into haiku-5.5's long-context price tier (both input and output 5 times more expensive, line 16).
- Output is counted in full at `max_output_tokens` 32000. Measured output is about 1–2k tokens per call.

The worst case itself is a correct hard-budget guarantee and should not be changed into an optimistic estimate. The correct fix is **runtime admission**: keep the worst-case plan unchanged; after each call completes, if "spent so far + the worst case of the next part ≤ budget", append parts from a breadth-first queue; parts that are appended and parts that are skipped are both recorded in the part ledger of #264. Extrapolating from this data, with the same $1 each run could reach the 8-call cap of `MAX_UNIT_CALLS`, about 60% more units. **This is an extrapolated value, not measured.**

## 3. Manual labeling of model findings

| # | Repository | Finding | Label | Evidence |
|---|---|---|---|---|
| 1 | flask | `json/provider.py:79` raises TypeError when both args and kwargs are passed, claimed "untested" | False positive: a test exists | `tests/test_basic.py:1358` asserts `"args or kwargs" in str(e.value)` |
| 2 | flask | `json/provider.py:115` dataclass serialization, claimed "untested" | False positive: a test exists | `tests/test_basic.py:1346` `test_json_dump_dataclass` |
| 3 | nest | `base-ws-exception-filter.ts:98` handleUnknownError, claimed "untested" | False positive: tested through a subclass | `packages/websockets/test/exceptions/ws-exceptions-handler.spec.ts:30,70,116` |
| 4 | fastify | `lib/request.js:136` trust-proxy host falls back to an empty string, claimed "untested" | False positive: a test exists | `test/request-header-host.test.js:75,107,143` |
| 5 | fastify | `lib/error-handler.js:124` buildErrorHandler prototype chain | False positive: tested through the public entry point | Covered by 27 test files via `setErrorHandler` |
| 6 | fastify | `lib/error-handler.js:134` statusCode/status mapping | False positive: a test exists | `test/reply-error.test.js:282` (`err.status = 418`) |
| 7 | fastify | `lib/error-serializer.js:44` output shape | False positive: a test exists | `test/build/error-serializer.test.js` (swallowed by the `build/` ignore rule, see item 8 of §5) |
| 8 | hono | `perf-measures/.../process-results.ts:14` | True but of no value: a performance script, not product code | — |

The number of valuable ones is **0/8**, consistent with the labeling conclusions on nest and TypeScript from 2026-10-11 to 10-17. There are two root causes:

- 6/8 are "the test exists in a file that was not matched". The model can only infer from the matched set, and then asserts that "the only matched test file does not cover it".
- 1/8 selected non-product code.

The conclusion is unchanged: **the model path should not claim quality externally in the full-repository audit.** Adding more gates to the model has diminishing returns (see `docs/goal-assessment-2026-10-17.md` §3.2).

## 4. Offline seeded evaluation (40 seeds)

### 4.1 Recall

The number in parentheses is the count that fell within the first 20 visible lines, i.e. the delivered definition.

| Repository | Delete references | Weaken assertion | Delete boundary | Total (delivered) |
|---|---|---|---|---|
| fastify | 3/3 (3) | 0/3 | 0/2 | 3/8 (3) |
| hono | 0/3 | 3/3 (1) | 0/2 | 3/8 (1) |
| nest | 3/3 (3) | 2/3 (0) | 0/2 | 5/8 (3) |
| flask | 3/3 (2) | 1/3 (0) | 0/2 | 4/8 (2) |
| cobra | 3/3 (3) | 3/3 (0) | 0/2 | 6/8 (3) |
| **Total** | **12/15 (11)** | **9/15 (1)** | **0/10** | **21/40 (11)** |

Beyond the seeds there was only 1 new lead: cobra's `SetIn`, which is also true because the seed deleted its only test. The 6/8 measured on Kite did not reproduce on third-party repositories. Another session re-measured on Kite under the delivered definition and got 3/8 (the cap pushed weak-assertion leads behind "+N more"); #263 is changing the cap to rotate by kind.

### 4.2 Why weak-assertion leads do not make the first 20

`staticLeads` ranks all unref leads before all weak leads (`src/audit-units.js:302`). Once there are 20 or more unref leads, not a single weak lead can be displayed: cobra ranks them 29–31, flask 44, nest 131 and 136. In addition, `write()` keeps only 3 weak and 5 unref per row, and only the first 100 rows (`src/audit-units.js:15`, `:271-272`): nest's unref goes from 121 down to 31, and weak from 304 down to 108.

### 4.3 Precision sampling (at most 10 unref and 10 weak per repository, fixed random seed)

| Repository | unref leads | weak leads |
|---|---|---|
| fastify | already tested through another entry point 5, not unit-testable 1 (only 6 leads) | no leads (`t.assert.ok` not recognized) |
| hono | already tested through another entry point 10 (sampled after fixing the binary-file bug; on main there are 0) | judged wrong 8, real gap 1, unsure 1 |
| nest | not unit-testable 3, judged wrong 2, unsure 2, real gap 2, already tested through another entry point 1 | judged wrong 8, real gap 2 |
| flask | already tested through another entry point 9, real gap 1 | judged wrong 9, unsure 1 |
| cobra | **real gap 6**, already tested through another entry point 4 | judged wrong 2 |

"Exports not referenced by any test" has high precision in repositories like Go where tests call the public API directly; in repositories like Python and JS whose tests go through framework entry points, it is a "test-debt list", not gaps. The UI wording is already "lead, not a confirmed gap", and that positioning is right.

## 5. Root causes (ordered by impact on delivered recall and precision)

| # | Root cause | Impact | Code location | Fix |
|---|---|---|---|---|
| 1 | Binary files in the test directory (`favicon.ico`) cannot be read, which makes the global `unread > 0` and clears the unref leads of all units | hono unref 0 leads (77 after the fix), delete-reference recall 0/3; flask `tests/static/config.toml` likewise gets treated as a test | `src/audit-units.js:166`, `:209`, `:227` | Test entries take only code files; unread is judged per unit (PR-B) |
| 2 | node:test's `t.assert.ok(x)` is not recognized: the lookbehind `(?<![.\w$])assert` excludes the `t.` prefix | fastify weak 0 leads, weaken-class recall 0/3 | `src/post.js:145` OK_ARG, `src/leads.js:159` | Allow the `t.` prefix (PR-A) |
| 3 | `toBeInstanceOf`/`toBeTypeOf` are treated as weak assertions, and the UI even says "asserts only truthiness" | nest weak sample 7/10 judged wrong, hono 2/10 | `src/leads.js:161-163` | Remove (PR-A) |
| 4 | Booleans are treated as weak assertions (`handlerExecuted`, `headers.has()`, `assert rv.is_json`) | Most of the weak samples in hono and flask are judged wrong | `src/leads.js:146-152` truthyArg; the expect path does not go through BOOL_CALL | Skip boolean-shaped names and predicates (PR-A) |
| 5 | A Go `== nil` guard followed by an else branch or a value-pinning assertion is still judged a weak assertion | cobra weak 2/2 judged wrong | `src/leads.js:173` | Skip when there is an else or a later pinning (PR-A) |
| 6 | The cap and ordering push weak leads out of the visible area | delivered recall 21→11 | `src/audit-units.js:15`, `:271-272`, `:302` | #263 rotation (another session); persistence in write() is handled by pack-zero-and-rows |
| 7 | The lead's line number is taken from the first occurrence rather than the declaration; the type filter also acts on that line, so a TS interface became "no test references" | nest `IHeaders`/`KafkaConfig` judged wrong; flask/cobra line numbers wrong | `src/audit-units.js:53` leadNames | Locate the declaration line first, then apply the type filter on the declaration line (PR-B) |
| 8 | The directory rules are wrong at both ends: `docs?/` swallows cobra's Go package `doc/`; `integration/`, `e2e/`, root-level `scripts/`, and `perf-*` are missing; type-only files (`*.interface.ts`) are treated as units; the `build/` ignore rule swallows `test/build/*.test.js` | In nest, 12 of the first 20 lines are interface files and model calls were spent on them; hono's only finding is a performance script; fastify finding #7 is a false positive | `src/audit-units.js:18` NOT_UNIT, `src/trace.js:43` | The first few items are fixed by PR-B; `build/` involves `src/trace.js` (which another session's isTestPath PR is changing), follow up there |
| 9 | CommonJS `module.exports = fn` / `{ a, b }` cannot get names, and when `pub` is non-empty the top-level function names are lost | 23 of fastify's 34 units, 52 of hono's, and 164 of nest's can never produce unref leads | `src/test-map.js:50` namesOf | Parse the exported object (PR-C) |
| 10 | The budget pre-check is about 25 times too high | 7–18 unit parts fewer reviewed each time | `src/engines/claude-api.js:29-38` | Runtime admission (§2.2, to be done after #264) |
| 11 | Boundary-value deletion 0/10 | No usable signal in a single snapshot | — | Not a bug. #263's `boundary_unpinned` (comparison against a named constant with no test pinning it) covers part of this; the rest needs git history |
| 12 | Go tests are widely counted as "no assertion" (35 per unit in cobra) | Risk ranking is distorted | `src/audit-units.js:57` testSignals + `src/post.js:138` ASSERTION | Not fixed: cobra tests assert through helpers such as `checkStringContains(t, ...)`. A candidate approach is "count a call with `t` as the first argument as an assertion", to be evaluated offline first |

## 6. Optimization: done / in progress / not doing

| Item | Status | Files |
|---|---|---|
| PR-A weak-assertion classifier (root causes 2–5) | In progress (implemented by Sonnet, with seeded re-measurement) | `src/leads.js`, `src/post.js` |
| PR-B unit and lead fixes (root causes 1, 7, 8) | In progress; rebase after #263 and pack-zero-and-rows are merged | `src/audit-units.js` |
| PR-C CommonJS export names (root cause 9) | In progress; does not touch hunkTokens | `src/test-map.js` |
| Lead cap rotation (root cause 6) | #263 (another session) | `src/audit-units.js`, `src/audit-post.js` |
| Runtime budget admission (root cause 10) | Starts after #264 and pack-zero-and-rows are merged; before merging, run a real seeded scan on the self-built Kite `eval/*` branch | `src/engines/claude-api.js` |
| Model missing_test gate (downgrade to low confidence when an error-message literal is shared with a test) | **Not doing**: it would block only 1 of 8 (#1), and net benefit cannot be proven under labeling noise | — |
| Go helper-function assertions (root cause 12) | Awaiting offline evaluation | — |

Before every PR is merged, the same 40-seed evaluation must be run, with before/after comparison reported under the delivered definition. For any change involving scan selection or budget, a real run on the Kite seeded branch is also required (see memory: real-run-before-merge).

## 7. Still unknown

1. **What delivered recall actually is after PR-A/B/C and #263 are merged**: this evaluation and the 5 real runs need to be rerun.
2. **Whether the model path can have value once matching is fixed**: 6/8 of the false positives come from insufficient recall of test matching. A fundamental fix needs better code→test retrieval (not only by name and first-level import), which was not done today.
3. **Whether the unref precision for Python and Go is stable**: only 10 sampled per repository, labeled by a single person, with no second-person recheck.
4. **Larger repositories**: nest's 1015 units get only 40 reviewed each time; even with runtime admission, one full round would take about 20 runs (extrapolated). At this scale a deterministic list is more practical than model review.

## 8. Same-day follow-up: optimizations merged and "finish the whole repository in one Action"

### 8.1 Merged changes

| PR | Content | Corresponding root cause / source |
|---|---|---|
| #270 | Weak-assertion classifier: `t.assert.ok`, boolean names and predicates, `toBeInstanceOf`/`toBeTypeOf` removed, Go nil guard | Root causes 2–5 |
| #271 | Units and leads: binary test files, declaration line, directory rules, type-only files | Root causes 1, 7, 8 (nest eligible 1015 → 489) |
| #269 | CommonJS export names | **Closed**: fastify unref 6 → 42, with 5/5 of the sample being already tested through another entry point, net negative |
| #275 | Runtime budget admission (unknown usage counted at worst case) | Root cause 10 |
| #289 | verifyUnits recognizes only parts actually executed; boundary leads support negative numbers and decimals | unknown-unknown review U1–U3 |
| #329 | `scan_scope: all`: one run plans all unit parts and document blocks; hard budget + deadline (margin 300 seconds or 2 times the longest call); parts not reached are accounted for one by one; it turns red only when something was "truly not reviewed" | User requirement "review the whole repository in one action" |
| #333, #336 | eval: construction gates for zero diff / partial overlay; combined scoring isolation and deduplication; requirement exclusions anchored to the repository root; test candidates of the eval PR exclude SpecGuard's own tests | version-eval and Actions re-review |
| #335 | A finding is bound to the call that produced it; lines outside the source cut in a single call are downgraded to low confidence; unknown usage in a single call counted at worst case | version-eval R1–R3 |
| #340 | "Not assessed" is no longer recorded as non-requirement; cross-unit deduplication; under all, all static leads are listed; the manual-run artifact carries `scan-parts.json` | Actions re-review |
| #341 | Same-named tests keep only those in this directory/with an import; weakly matched tests that do not fit are no longer recorded as cut; import-line hits no longer mark truncation | The forced bottleneck exposed by full-repository runs |

### 8.2 Third-party full-repository runs (`specguard-run.yml`, main, haiku-5.5, `scan_scope: all`, `scan_issue: none`, one run per repository)

Round 1 was after #329 was merged (main `5945f81`), and round 2 was after #341 was merged (main `b30696a`). Both rounds were 5/5 green, **with no unit part or document block left unreviewed because of budget or time**, and no failed calls.

| Repository | units | forced (partial tests, recorded as unsure) round 1 → 2 | Calls | Cost round 1 → 2 | Model time | Reported gaps round 1 → 2 |
|---|---|---|---|---|---|---|
| nest | 489 | 277 → 262 | 108 → 108 | $0.77 → $0.77 | 12 min | 18 + 2 push-down → 16 + 1 |
| fastify | 33 | 20 → 19 | ? → 24 | $0.41 → $0.36 | 3 min | 14 + 1 doc → 10 + 1 push-down |
| flask | 21 | 13 → 11 | ? → 9 | $0.06 → $0.06 | 1 min | 7 + 1 → 4 + 2 |
| cobra | 18 | 7 → 7 | ? → 14 | $0.19 → $0.19 | 2 min | 9 + 1 → 6 |
| hono | 172 | 171 → 133 | 103 → 81 | $1.12 → $0.77 | 7–10 min | 8 → 17 |

The round 1 artifacts do not yet have `scan-parts.json` (added only in #340), so the call counts could only be read from the nest/hono Summary, and the rest are recorded as "?". Round 2 runs: 39032664154, 39032666155, 39032667965, 39032669964, 39032672271.

Compared with §2.1: the same repositories used to have only 8–40 units reviewed each time (40 of nest's 1015), and now all are reviewed in one run, with cost still within $1.

**Spot check (cobra round 1)**: all 7 "no test" conclusions were true on the scanned commit `adbc881` (`SOURCE_DATE_EPOCH`, `GenReSTCustom`, `GenMarkdownCustom`, `forceMultiLine`, `hasAllFlags`, `HasAvailableSubCommands`, `OutOrStderr` have no reference in any `_test.go`), and most are reasonable tests to add. Compared with 0/8 in §3, this is a clear improvement, but it is only one repository, checked by one person, and the other 4 repositories are not labeled.

### 8.3 Kite seeded repository (43 units, 8 seeds)

| Version | Coverage | Calls / cost | Model hits | Static leads visible |
|---|---|---|---|---|
| #289 (selected, $1) | 72 parts not reviewed | 7 / $0.46 | 3/8 | 6/8 |
| #329 (all, $5) | 130/130 parts, 131/131 blocks | 26 / $0.93 | 3/8 (seeds 4–6) | 6/8 |
| #341 + #340 (all) | All | 24 / $0.68 | 2/8 (seed 6 lost: the matched tests of filename.ts were exactly the same both times, so it is model variance) | **7/8** (moveCrop was delivered through the full lead list of #340) |

Full coverage did not raise model recall: the units of the delete-test seeds 1–3 were all reviewed, and the model still did not report them. This is the ceiling of model capability, not a coverage problem.

### 8.4 Document reviews and decisions

- **PR-mode chunking (the single-review-chunking plan)**: P1/P3 are not done. P2 (adding a call for the files dropped by focus) is **also not done**: after correcting the scoring, the detection for a combined large PR is about 10/24 (isolated 14/24), and the loss is mainly in the delivery layer — the fast-tier `REDUCED_INLINE = 3` sends only 3 inline comments and the rest go into the Summary. An additional call cannot change this.
- **version-eval report**: R1–R3 are true and have been fixed (#335); "whole repository in one run is not met" is outdated thanks to #329; making R1/R2 high priority is overweighted — the quoted original text must appear verbatim on the cited line, and a call that cannot see that line will hardly pass validation.
- **Actions results re-review**: requirement documents excluded by the eval configuration, "not assessed → non-requirement", cross-unit duplicates, and static leads hidden by the cap are all true and have been fixed (#336, #340). We disagree that "fastify turning red is as expected": partial tests mean an uncertain conclusion, not unreviewed, and a red light is reserved for the part that was not reviewed.
- **Manual-run form UX review**: directory links should limit the scan scope (use the existing `scan_paths` instead), the wording of `max_units`, and writing a tracking issue by default are true; "default all is incompatible with Copilot" is only half right — it explicitly errors and prompts to switch to selected, and does not silently degrade. The fix PR is in progress.

### 8.5 Still unknown (updating §7)

1. §7.1 and §7.4 are answered: a full-repository single run is feasible, and even at nest scale it takes only about $0.8 and 12 minutes.
2. **forced is still the main evidence gap**: 54% of nest's and 77% of hono's units see only part of their tests. What remains is mainly the test slice window (80 lines) and tests being costed by whole file, in `slices()` and the collector's `tcost`.
3. The model's detection of "tests were deleted" is still weak (Kite seeds 1–3 have always been 0/3).
4. The round 2 findings of the other 4 third-party repositories are not manually labeled; the precision conclusion is based only on the cobra spot check.

## 9. October 18: external reviews, evidence completeness, and precision

The numbers in this section all come from real runs (the Kite workflow pinned to the PR branch, haiku-5.5, `scan_scope: all`) or from collector measurements that can be re-run offline. The conclusions of four external reviews (`docs/branch-archives/repo-review-2026-10-18/`, `docs/branch-archives/pr-actions-goal-review-2026-10-18/`, `docs/comprehensive-assessment-2026-10-18.md`, PR #347/#348) were checked against the code item by item before being handled.

### 9.1 Merged changes

| PR | Change | Basis |
|---|---|---|
| #344 | The source of a unit finding must be its own file / a listed test / the call that produced it; directory links are anchored to the repository root, and when branch and path cannot be told apart it errors instead of widening the scope; CommonJS export names enter test matching; JSON-repair calls separately reserve the worst-case cost; on Windows, prefer Git Bash | Review repo-review items 2–6, each with a synthetic counterexample |
| #343 | `pack-cut.txt` is recorded per call (`path<TAB>unit ids`), and no longer attributes a shared test truncated in one call to all units; tests over the limit are priced by their slices; units are packed in order of test bytes from small to large | See 9.2 |
| #346 | Re-review when the PR body is edited (`edited`): if the requirement fingerprint (title + body) is unchanged, preflight skips without calling the model; the ci.yml test job is skipped on edited; the manual form budget defaults to $5 (a cap, not the spend) | Real run 39088516123: test=skipped, dogfood re-reviewed |
| #349 | A call containing only one document block that exceeds 3500 output tokens is retried once with a larger limit (up to 4 times, not exceeding max_output_tokens), with the same budget rule as bisection; the README is unified into a single "task colors" table, removing the wrong claim of "always green" | 39083942363 had 2 single-block calls fail because of this; after the fix 39090694256 was complete (failed is empty) |
| #345 | `NO_GAP` recognizes "not a gap", but sentences followed by in / but / however are kept; the scan prompt requires reading the whole test first, and an assertion in another field or another call does not count as pinning this value | See 9.4: two deterministic downgrade rules were withdrawn |
| #350 | Names known only from a CommonJS export object are still used for test matching, but no longer generate "no test references it" leads | fastify 9 → 35 → 9; the same pattern as the closed #269 (see 9.3) |
| #351 | On the same head, if the requirement is modified during the review, the old run does not publish (no comment, no summary update) and the newer run publishes; the siblingCall gate takes effect only when the sibling test is called with the same arguments; the test still runs when a PR changes base | Real race: 39094987660 recorded "requirements changed during the review" and wrote nothing, and the edited run 39095039083 published; in Kite 39095007207 the fps weak assertion that was previously downgraded is now published |

After the merge, the Kite seeded run 39093382612 on main (`9cd2bb4`) (`fail_on_error: true`): green, failed 0, 43/43 whole, 24 calls, $0.70, all 3 weak-assertion seeds published; only 3 document blocks were not answered by the model (a warning, does not turn red). The `# specguard-pin` of the reusable workflow was updated to `2255abd`.

### 9.2 Evidence completeness: units that saw only part of their tests (publisher definition)

| Run | Repository | Units | Before → after | Calls | Cost | Published gaps |
|---|---|---|---|---|---|---|
| 39083946253 | nest | 489 | 262 → 79 | 104 | $1.46 | 27 + 1 moved down |
| 39083944276 | hono | 172 | 133 → 81 | 78 | $1.14 | 13 + 1 |
| 39083942363 | Kite seeded | 43 | 13 → 0 | 44 | — | 6 missing + 3 weak (all 3 weak-assertion seeds published) |

"Before" is the second-round main runs (nest 39032664154, hono 39031978219, Kite 39031973425). The decline has three sources: the truncation-attribution fix (measured separately offline: nest 263 → 125, hono 133 → 86), slice pricing and packing order (down further to 78 / 82). Offline check: for units that were incomplete before and complete after, none of their listed tests appears in notWhole of the real pack. This is an improvement in evidence completeness, not a measurement of recall or precision. The cost increase (nest $0.77 → $1.46) comes from the complete tests in the pack; therefore the default budget of the manual form was changed to $5.

### 9.3 Manual labeling of second-round findings (fastify / flask / cobra / hono)

Labeling criteria: TP = the claim is true and worth handling; TP-low = true but of very low value; FP = the claim does not hold (with the counter-evidence file and line number attached). The item-by-item table is in the labeling file of this session, and the table below is the summary.

| Repository | Published | TP | TP-low | FP | Precision (TP + TP-low) |
|---|---|---|---|---|---|
| fastify | 11 | 0 | 6 | 5 | 55% |
| flask | 6 | 1 | 3 | 2 | 67% |
| cobra | 6 | 5 | 1 | 0 | 100% |
| hono | 17 | 0 | 10 | 7 | 59% |
| Total | 40 | 6 | 20 | 14 | 65% (TP only: 15%) |

- Among cobra's TPs there is a real bug: `GenYamlCustom` in `doc/yaml_docs.go` receives `linkHandler` but never calls it.
- fastify's 5 FPs are all "seeing only the matched unit tests and concluding that no test exists"; these behaviors are covered by integration tests elsewhere (for example, `test/internals/initial-config.test.js:29` asserts the default value). Name retrieval cannot catch this kind of coverage, which is a known ceiling of static review.
- Weak-assertion FPs in hono / flask: the model looked only at the cited line and did not read the later assertions in the same test.
- CommonJS leads: after #344 fastify's unreferenced_export leads rose from 9 to 35, and the 26 newly added are all `lib/*` internal functions tested through the public API, so they were withdrawn by #350; the 5 leads of the same kind on Kite are true, but cannot be generalized.

### 9.4 Handling of review conclusions

- **Adopted**: the two deterministic downgrade rules of #345 (downgrade if another exact assertion exists in the same test; downgrade if the regex is anchored) were overturned by two counterexamples — `assert.equal(result.currency, 'USD')` next to `assert.ok(result.total)` does not constrain total; `/^.*$/` is anchored but accepts anything. The two rules would remove only 2–3 FPs but would suppress real gaps, so they were withdrawn and replaced by a prompt requirement and two regression controls.
- **Adopted**: when the PR body changes but the head does not, no re-review happens (#346); the default $1 budget is not enough for a full scan of a large repository (#346); a single-block document call that overflows cannot be split (#349); the README failure policy is self-contradictory (#349); "not a gap … but …" would drop the whole entry (#345).
- **Adopted (incremental review `docs/incremental-review-2026-10-18.md`)**: #346 lets the edited run and the push run be concurrent, so the result for the old body may overwrite the new result; siblingCall treats "the parser has tests on literals" as "the derived value is already pinned"; changing base also skips test. All three were fixed by #351. When a linked issue is edited, re-review still does not happen automatically (an issue → PR mapping is needed), listed as follow-up.
- **Corrected my own verification method**: the Kite evaluation workflow originally lacked `fail_on_error: true`, so incomplete runs also showed green; all later evaluation runs turned it on.
- **Deferred (needs data or a product decision)**: the baseline gate (when a repository has more than 200 baseline / `__snapshots__` files, all missing_test are downgraded to low confidence) may be too broad for large React repositories, but there is no sample to measure it; an authoritative product contract for dogfood (the content needs confirmation from the product owner); versioned requirement–code–test traceability edges; a frozen independent evaluation set, human blind review, and pre-merge fix tracking.
- **Not changing**: the review content of the private Kite repository has already entered two evidence JSONs in the public repository (`docs/latest-pr-actions-followup-evidence-2026-10-17.json`, `docs/shift-left-live-review-evidence-2026-10-17.json`); deleting them from the current tree does not remove them from history. Whether to rewrite history and force-push is up to the repository owner.

### 9.5 Still unknown

- Recall: the Kite seeds are only a development set; the published missing_test entries differed between the seeded runs this round (2–6), they were not relabeled by seed ID, and whether recall of the delete-test seeds improved is unknown; this needs repeated runs with fixed inputs, scoring by seed ID, and a holdout set that did not participate in tuning.
- 81 hono units still see only part of their tests: the main remaining reason is test blocks exceeding the 80-line slice window (55 of the 78 remaining in nest).
- The default Copilot path was not run for real this round (quota exhausted), and all conclusions come from the Claude API engine.
