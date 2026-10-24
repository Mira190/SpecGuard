# SpecGuard Goal Completion Assessment: PR Shift-Left, Whole-Repo Audit, and Unknown Unknown (2026-10-17)

Baseline: main `d3365c0` and the PRs merged after it (see the list at the end). All numbers come from real runs of the day, offline reproducible eval sets, or human labelling, with run IDs or file locations attached. **Inferred values and measured values are labelled separately; anything unmeasured is explicitly written "not measured".**

## 0. Conclusion

| Dimension | Judgment | Key evidence |
|---|---|---|
| Shift-left at PR time (main path) | **Proven effective on controlled samples** | Kite's 10 seeded PRs detected 10/10 on the first screen, 1 extra noise item, about $0.005/PR, about 40 seconds (small seeded PRs; SpecGuard's own recent PRs are about $0.02–$0.12 per run, see §2.1) |
| Run trustworthiness (failures do not masquerade as success) | **Largely achieved** | Configuration failures are always red; a failed rerun does not overwrite existing results; status only indicates whether execution completed |
| Whole-repo audit reach and cost | **unit reach 100%, but under default settings only about 45% of segments were reviewed; runtime admission is the lever** | nest reviews 7→40 units per run, about $0.03/run; the funnel numbers reconcile; no more hangs. Reaching 43/43 units ≠ every segment/test was seen: the default $1 reviewed only 58 of 130 unit segments (about 45%), 72 were not reached due to worst-case pre-checks; 13 units had their tests only partly loaded |
| Whole-repo audit finding quality | **Model path not achieved; deterministic signal path partly achieved** | 8 known gaps: haiku 0/8 (early configuration), default settings 3/8 (after #255/#256), normal tier 2/8 ($1.91/run); the newly added deterministic static signals (#253, no extra model cost) generated 6/8, but only 3/8 were visible at the time (the 20-row cap was filled by "unreferenced exports"); after #263 (cap by round-robin over clue types + boundary clues) 6/8 are visible (Kite run 39012216164, 7/8 generated); for current main see §3.3 |
| Requirement ↔ code ↔ test retrieval | **Greatly improved, re-testable** | requirement→code MRR 0.444→0.750; code→test Hit@3 4/24→20/24 (14/24 after removing the single high-contribution file) |
| Value measurement (whether it really shifts left) | **Definitions are ready and starting to produce output, samples are not ready** | fix-through, delivered recall, and blind labels align on the same ID; the real run of #248 recorded the first 1 addressed; there are no human-author samples yet |

In one sentence: **PR mode can already reliably put known types of problems in front of the author before merge; the whole-repo audit now runs and its accounts reconcile, but having the model "infer missing tests" without a diff is almost ineffective (seeded recall 0–2/8), and what really works is deterministic facts (exports referenced by no test, tests that only assert truthiness, boundary constants; on current main 6/8 are visible with no extra model cost). Goal completion is roughly at "usable as a pilot, team benefit not yet proven".**

## 1. Goal review (per the 2026-10-13 agreement)

| Goal | Current status | Evidence / gap |
|---|---|---|
| Requirements can come from the PR or repository documents, and SpecGuard discovers them itself | **Achieved** | trace auto-discovers documents; #229 normalizes source labels; #232 broken links do not drop gaps; #238 scan_paths no longer blocks the central docs |
| "Coding standard" = repository instruction files + lint/format check results | **Implemented, not specifically accepted in real runs** | The rules are in the code; today there was no real PR validation with an instruction-file violation (the seed set contains none) |
| QA runs in the PR Action on every push | **Achieved** | Kite and SpecGuard run on every push of every PR; the head marker reuses the conclusion for the same head (#243) |
| Pilot repository Kite | **Achieved** | 10 seeded PRs + 1 seeded scan branch; the owner has updated Kite's secrets |
| Engine: company default Copilot PAT, Claude as a pluggable engine | **Claude path sufficiently verified, Copilot path not run today** | All real runs used claude-haiku-5-5; Copilot's configuration-failure classification (#222) has unit tests but no real run |
| Manual review entry for external repositories | **Public repositories achieved, private repositories not working** | nest/TypeScript succeeded multiple times; the manual scan of private Kite cannot read without a PAT/App |

## 2. Shift-left at PR time

### 2.1 What has been proven

- **Detection:** Kite seeds #10–#19 (5 unit-test types, 5 requirement-drift types), the new build detected 10/10 on the first screen (old build 9/10). #10 "deleted the case-insensitive duplicate-name assertion" was promoted from low confidence in Details only to a first-screen title; what #14 requires is independent assertions on both sides, `128*1048576` and `-1`, rather than reusing the constant.
- **Noise:** 10 PRs had 2 extra findings in total, 1 reasonable and 1 noise.
- **Cost and latency:** about $0.005/PR comes from Kite's small seeded PRs; SpecGuard's recent dogfood PRs are about $0.02–$0.12 per run (non-random examples: #248 $0.12, #249 $0.02, #251 $0.02), and both must be stated. Kite's summary median is about 40 seconds, SpecGuard's own about 60 seconds.
- **Closed-loop example:** after the bot's finding on SpecGuard #224, the test was added, CI passed, and it merged 32 seconds later; after #233 such fixes can be measured.

### 2.2 Problems fixed today that would have made shift-left ineffective

| Problem | Consequence | Fix |
|---|---|---|
| Anthropic key invalid, 19 PRs all green | Users thought it was reviewed, but it never ran | #222, #225: configuration failures are always red |
| A failed rerun overwrote valid results | Findings for the same commit disappeared from the PR | #228 |
| "Please add a test" when the test already exists | The author was wrongly asked | #229, #232 |
| Large test files kept only the file header | Tests newly added by the PR itself could not be seen | #234 slices by diff hunk |
| Fast tier = incomplete | The status line was always ⚠️, losing information | #243 |
| Sensitive file diffs entering the prompt | Exfiltration risk | #223, #226 |

### 2.3 What has not been proven

- **Recall on ordinary PRs:** the seeds are all positive samples of "one PR, one known problem" and cannot be extrapolated to ordinary PRs.
- **PR-mode recall sampling (new):** an independent re-review of 10 recent SpecGuard PRs where the bot had zero findings found at least 1 real miss in 4/10 (95% interval about 15%–70%); every sampled run was fast tier and incomplete; in all four cases the bot's own "Not reviewed" list named the location of the miss — misses mainly come from truncated context becoming unknown, plus 1 retrieval bug (a source file named test-*.js was treated as a test, fixed by #265). The sample is small and non-random, and only shows that misses are real.
- **Human adoption:** all sample PRs were written by agents, there is no human author handling data, so "does team QA rework decrease" cannot be answered.
- **Model variance:** each PR was run only once, and the pass@1 stability was not measured.

## 3. Shift-left value of the whole-repo audit

### 3.1 Capability is in place

| Metric | 1st time | Now | Source |
|---|---|---|---|
| nest units per run (full + partial) | 7+0 | 30+10 | runs 38983359975 → 38991206203 |
| TypeScript units per run | 3+0 | 18+6 | runs 38983362780 → 38991208512 |
| Cost per run | $0.006 | $0.03–0.04 | usage.json |
| Runs needed for one full pass (nest, inferred) | ~145 | ~25 | 1015 / 40 |
| TypeScript checkout | 3m56s | ~2m (blobless) | #230 |

The funnel rows reconcile (eligible = inventoried + oversized + not reached; selected = full + partial + not reached for budget); the hangs and the invisibility of large units were both fixed (#231, #235, #237).

### 3.2 Value not yet proven

- **Precision (human labelled):** the 3rd run counted 11 items, 1 valuable; the 4th run (after the gate and matching fixes) counted 3 items, 0 valuable; of the 8 downgraded to low confidence, 1 was valuable (the gate wrongly hurt 1).
- **Two labelling passes disagreed on the same conclusion** (whether supplementalreferences.go is covered by the baseline), showing that single-person single-pass labelling is itself noisy.
- **Root-cause judgment:** real unit-test gaps in mature repositories are scarce to begin with, the denominator is too small; adding more gates has diminishing returns and hurts valid findings.
### 3.3 Seeded evaluation: recall is measured for the first time

On the Kite branch `eval/seeded-scan-gaps-1017`, 8 real test gaps were planted (3 whole test blocks deleted, 3 value assertions changed to `assert.ok`, 2 boundary cases deleted); after planting, all 136 tests were still green, so ordinary CI cannot find them. #252 allows scans that do not read or write scan state to run on non-default branches (the owner chose option A on 2026-10-17); one run covers all 43 units; the control branch comes from master.

| Method | Recall (8) | Counted toward precision | Cost/run | Notes |
|---|---|---|---|---|
| haiku (fast tier, early configuration, before #255) | **0/8** | 0/1 | $0.45 | 6 seeds were fully seen by the model and still not reported |
| sonnet (normal tier) | **2/8** (seeds 4, 5) | 7/8 (including 1 duplicate) | $1.91 | The default $1 budget silently reviews only 25/43 units; about $6 is needed to cover them in one run |
| Deterministic static signals (#253) | generated **6/8** (seeds 1–6); visible only **3/8** (the 20-row cap was filled by unreferenced exports) | 9 of 18 clues sampled against master were all true | No extra model cost (not a $0 run) | Exports referenced by no test + tests that only assert truthiness |
| None of the three found (before #263) | Seeds 7, 8 | — | — | Boundary values (`<=` vs `<`) need semantic judgment; after #263's boundary clues seed 8 is visible |
| **Default settings end-to-end (after #255/#256, main 9c08f80: haiku, $1; not the same version as the haiku 0/8 above)** | Model 3/8 (seeds 4, 5, 6), static visible 2/8 (seeds 3, 4; 6/8 generated), **total visible 4/8** (seeds 3–6; checked item by item against that run's summary; correction: previously the generated clues were counted as static 6/8) | 5 counted: 3 seeds + 1 duplicate + 1 doubtful, no clear false positive | $0.42 | 43/43 units reached (coverage by segment is in the §3.3 current-main results; the "30 full" label is inaccurate); the 20-row clue table was filled by unreferenced exports |

**Correction and follow-up (#263/#268):** the earlier "static 6/8" counted generated clues, and only 3/8 were visible to users, because the 20-row cap was filled by unreferenced exports. After #263 changed the cap to round-robin over clue types and added boundary clues, Kite run 39012216164 showed static visible 6/8 and generated 7/8.

**Results on current main (Kite run 39015026706, SpecGuard main `247c596`, default inputs: haiku, $1, max_units 60):**

| Measure | Visible recall | Generated recall | Notes |
|---|---|---|---|
| Model | 2/8 (seeds 4, 5) | 2/8 | Plus 1 non-seed finding (electron/live.cjs) |
| Static | 6/8 (seeds 2, 3, 4, 5, 6, 8) | 7/8 (seed 7 missing) | Seed 1 (moveCrop) had a clue generated but did not enter the visible table; seed 7 had no clue |
| Total | **6/8** | **7/8** | Seeds 1, 7 not delivered |

Cost $0.45 (7 calls, 5m43s); 43/43 units were reached, but by segment only 58/130 (about 45%) were reviewed, and 72 segments were not reached because of the worst-case pre-check (budget). "30 reviewed whole" in the funnel is mislabelled: a unit with even one segment reviewed is counted as full (for example check-launch.cjs had only 2 of 6 segments reviewed); a fix is in progress.

**N1 is now visible:** under the default $1, the pre-check reserves for the worst case, and with only about $0.43–0.45 actually spent many unit segments were never planned; runtime admission (admitting by actual spend) is the next step (owned by another session).

**Process lesson:** #255 (read all segments) passed in CI and offline simulation, but the real seeded run showed default-settings coverage dropping from 30 to 16 (the collector-side budget estimate missed document-block calls); its fix #256 crashed at engine startup on its first real run because of a declaration-order error, while the job was still green. Both were found only by real runs. Now any change involving scan selection, budget, and engine entry points must be run for real on the Kite seeded branch before merging; internal exceptions (`internal`) are always red.

**First-principles reading:** PR mode points straight at "this assertion was deleted" through the diff, hence 10/10; the whole repository has no diff, so the model must infer "what is missing" from the whole, which small models can hardly do and large models add only 2 more. **The mainstay of the whole-repo audit should be deterministic facts, with the model used only for what facts cannot decide (boundaries, requirement consistency).** Another 2 seeds fell in the 2nd segment of large units; **in the pre-#255 implementation** a single stateless run could never read them (a method limit at the time, not a model limit); after #255 all segments are read, and the remaining limits should be looked at concretely in the segments actually deferred/failed.

**Positioning:** the whole-repo audit is currently suited to being a "deterministic test-debt list + periodic clues", carrying obligations back into later PRs; the model-found part should not be advertised for quality externally.

## 4. Unknown unknown: which blind spots are now visible, which remain blind spots

"What cannot be seen must be shown" is this project's first principle. Today the following previously **silent** losses became visible rows:

| Previously silent | Now shown as |
|---|---|
| Model call failed but job green | Red + categories such as `(auth, HTTP 401)` |
| Multi-segment scan ran out of quota midway | Red, completed parts retained |
| Sensitive files excluded | "Not reviewed: N secret-like files" |
| Units whose tests do not fit | "Reviewed with part of their tests (unsure)" |
| Units not covered by budget | "not reached (budget)" |
| Candidates outside retrieval top-3 | "N more candidates not shown" |
| Document blocks outside scan_paths | "N document blocks skipped: evidence outside scan_paths" |
| Large test files truncated | pack-cut and the "context was cut" row |
| Baseline-driven repositories | A one-time note that all missing_test were downgraded, and why |

**Still blind spots (ranked by impact on the goal):**

1. **True recall**: PR mode has no independent re-review of no-alert samples; scan mode has only one set of 8 seeds (Kite), and boundary-type gaps were found by none of the three methods. This is the biggest unknown at present.
2. **Human author behavior**: whether they read, agree, or change; all samples are agent-written and agent-reviewed.
3. **Non-JS/TS languages**: Go test matching, import versions, and the baseline system have only rough support; Python untested.
4. **Dynamic relations**: DI, events, registries, mapping from generated code to generators; retrieval can only find lexical matches and first-level imports.
5. **Model variance in a single run**: whether rerunning the same input gives consistent results was not measured.
6. **Copilot engine**: the company default path had zero real runs today.
7. **Coding standard checks**: real violation scenarios with instruction files + lint results are not accepted.
8. **Labelling reliability**: single-person labelling, no independent two-person labelling and reconciliation.
9. **Scale limits**: how the 6000-file inventory cap, the 512 KiB file cap, and the 40-second trace budget behave on larger repositories was tested only once (TypeScript), not systematically.
10. **hunk-identifier test retrieval times out on SpecGuard's own dogfood PRs**: #264's summary says "search for changed identifiers ... failed or timed out". This problem became visible only after #260 and is not yet fixed.
11. **Self-contradictory summary**: the summary of an all-segment run contains "Only the first part of each unit under review was visible" at the same time; a fix is in progress.
12. **Internally inconsistent output**: SpecGuard's summary may list a requirement as "Unconfirmed" while the same comment marks its obligations as having evidence (see #264). Not yet fixed.

## 5. Can the metering answer "did it shift left"

Before today, the core value metric fix-through was structurally zero in almost all real runs (incomplete runs discarded wholesale, fast tier always downgraded, only inline tracked). Now:

- Whether each finding was handled is judged per finding, and only files that cannot be seen count as not_observed (#233).
- summary-only findings enter blind labelling with a title, sharing the ID with fix-through, and the blind-label table does not expose the source (#246).
- The evaluation distinguishes raw recall from delivered recall, the latter using the same actionable set as false positives; failed runs are counted in the end-to-end denominator (#245).
- Retrieval has a versioned eval set: Recall@K, MRR, All-required (#247).
- Code→test candidates read the identifiers changed by the diff itself (#249): fastify set Hit@3 4/24→20/24, Recall@3 7%→52%, MRR 0.167→0.813; after removing the biggest contributor initial-config Hit@3 is still 4/24→14/24; on SpecGuard's own latest 10 PRs, the share where the PR's own tests enter the top 3 went 16/18→17/18, and the average candidate count 4.05→4.29 (not flooding).
- Metering has started to produce real data: in the dogfood run of #248, the previous round's finding was recorded as addressed — a similar earlier fix (#224) was recorded as 0.

**What is lacking is more than samples:** the preregistered thresholds (precision ≥65%, fix-through ≥25%, etc.) need PRs from real authors, and there are currently none; the label lifecycle (#261: resolved summary findings, and summary→inline promotion no longer drops labels) and consistency of execution-coverage definitions (scan segment ledger #264, pack-zero/rows #267) have been merged.

## 6. Next steps (ranked by value to the goal)

1. **Boundary-type gaps**: 0/2 for all three methods. Offline study: the "named constant comparison" clue hits seed 8 on mature repositories with 0–1 clues; seed 7 (two dynamic operands) cannot be captured deterministically and is left to the model; the clue was merged by #263 (#268 adds tests). Also: the inconsistency of `context_pack_bytes` between the two ends was resolved by #258; the budget pre-check is about 4 times more conservative than real spend, to be calibrated after accumulating several usage.json.
2. The risk that hunk retrieval candidates wrongly downgrade real gaps through the cover guard (the same-literal risk of #249) was fixed by the merge of #251. Retrieval cases still need to be added on a second external repository, to reduce dependence on the single fastify repository.
3. **PR-mode recall sampling**: the first batch of 10 is done (see §2.3, 4/10 had misses), and it needs to be expanded and include non-SpecGuard repositories.
4. **One real run of the Copilot engine**, to confirm the company default path has not regressed.
5. **Real acceptance of the coding standard**: put a PR in Kite that violates the instruction file and lint.
6. **Two-person blind labelling**: have a second person independently label the existing 25 labels, to measure agreement.
7. Once there are human author samples, produce the first weekly report against the preregistered thresholds.

**Next steps in progress:**

- U1 (finding validation uses the planned rather than the actually executed segment range), U2 (negative/decimal boundary normalization), U3 (`precision_delivered` of old records is null), U4 (the worst-case reserve must be kept when usage is missing, blocking #275) are being fixed in another session.
- Real run of the runtime pre-check #275: unreached segments 72 → 15, spend $0.44 (Kite 39017602602), pending U4.
- Single-review split plan: P0 (shared segment identity) is largely done by #264/#274; the next lever in PR mode is evidence retention inside the pack (misses are traceable to truncated context), measure first, then decide whether to do splitting or concurrency.

## Appendix: merged today (#218–#248)

#218–#223 run trustworthiness and security; #224–#226 unknown-risk re-check fixes; #227–#235 evidence protocol, failure retention, recall, metering, context slicing, scan throughput; #236–#242 documentation and scan wording; #238–#241 scan_paths, retrieval, precision gate, test matching; #243 status semantics; #244 documentation; #245–#247 eval definitions and retrieval eval set; #248 wrap-up fixes; #249 code→test hunk identifier retrieval; #250 first version of this document; #251 cover guard ignores hunk candidates; #252 stateless scan usable on non-default branches; #253 deterministic static signals; #254 seeded results of this document; #255 stateless scan reads all segments and budget hints; #256 collector and engine budgets consistent, discards recorded per segment, internal exceptions red; #259/#260 eval and collection fixes; #261 label lifecycle; #263/#268 boundary clues and tests; #264 scan segment ledger; #265 test paths and deletion hunks; #267 pack-zero/rows.
