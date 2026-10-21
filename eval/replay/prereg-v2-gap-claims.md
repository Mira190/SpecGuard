# Pre-registration V2: unit-test gap claims backed by an execution oracle (e0, 2026-10-21; red-team amendments 2026-10-22; not frozen until the red team OKs the corpus)

**Pins.** SUT = SpecGuard main `dfe1493`. Corpus = `eval/replay/v2-corpus.json`, built by `eval/replay/v2-sample.js sample` (seed 20261021) and committed before any coverage or model run. The "later tested" proxy data (E1′ (p)) comes from `eval/replay/v2-sample.js later`, which reads git only. Revision 2 below is binding: it overrides Revision 1 and the original sections where they conflict.

**Question.** When a coverage report is present, does V2 SpecGuard make unit-test gap claims that are true, stable and quiet? This is not a bug-catch question: that is deferred to the pilot (owner constraints, 2026-10-21: no human labels, an LLM judge at most sonnet-5-5, the pilot comes later, and v1 focuses on unit-test gaps).

## Baseline (V1, design data, already measured)

The V1 baseline comes from E3's 120 haiku runs on 40 bug PRs (measured from the E3 runs reported in `coverage-e3-results-2026-10-21.md`; raw outputs stay in the local evidence directory, outside this repository):

| Measure | Value |
|---|---|
| missing_test precision vs the unit-coverage oracle, all claims | 23.7% |
| missing_test precision, delivered claims | 34.8% |
| Stability (Jaccard, kind+path+±5) | median 0.24 |
| Recall of deterministic gap units | 9/59 (15%) |

This set informed the V2 rules. It is the design set and confirms nothing.

## System under test: V2 rules, all deterministic and applied in post.js

**R-a, deterministic missing_test.** One finding per changed code definition (`test-map.enclosingName`; a top-level unit per file otherwise) that has ≥1 added, instrumented line the unit report shows never executed.
- Line: the first such line.
- `source: coverage`, confidence high.
- Text: "lines a–b are never executed by any unit test", followed by the model's test skeleton for that definition if the model produced one; otherwise none.

**R-b, relabel.** A model `missing_test` whose cited line ran under unit tests becomes `missing_case`: "this line runs under tests; the claim is about an untested case or assertion".
- It goes to the summary at medium confidence or lower, and is never inline.
- If R-a already produced a finding in the same definition, the two merge.

**R-c, unknown.** A model `missing_test` on an uninstrumented line keeps today's behaviour, with "(not verified by coverage)" added.

**No report.** Without a report, everything is unchanged, except that a model `missing_test` carries "(not verified: no coverage report)".

## Corpus (fresh, drawn before any run)

- **Repos:** hono (`src/**/*.test.{ts,tsx}`), langchain-core (`libs/core/tests/unit_tests`) and sqlglot (`tests/`), with the E1 harness configs.
- **Draw:** 30 merged PRs, 10 per repo.
  - Each must be a single-parent squash commit with 30–1200 changed lines and ≥1 changed code file under the repo's unit scope.
  - Window: 2025-07-01 to clone HEAD.
  - Selection uses `szz.js cleanSample`, seed 20261021, with no bug filter. These are ordinary PRs, which is what users see.
  - Exclusions: every E1, E3 and holdout-1/2 row, and the pairs.json and clean.json corpora.
- **Freeze:** the list is committed before any coverage or model run.

## Runs

1. **Cover:** the E1 runner at main ≥ d737045, set `v2`, the same unit scopes and the same health rules. A PR is unusable when there is no report, 0 selected tests, or a collection error in a test file that names or neighbours a changed module. Unusable PRs are reported and excluded from precision. Each failed group gets ONE health rerun.
2. **Model:** claude-haiku-5-5, claude-api, the #409 batch, 3 reps, `--budget 0.25`, `--max-total 6`. The owner runs it in their own shell.
   - SUT = SpecGuard main `dfe1493` (the #430 merge, which carries the V2 rules), with `coverage_files` pointing at that PR's report, so post.js applies R-a, R-b and R-c.
3. **Replay arm A (today):** the same model outputs post-processed by main before V2. This is a $0 replay of post.js, so A and V2 share their model calls.

## Primary measures, with pre-stated targets

These are product-quality gates for v1, not significance tests.

- **P1, gap-claim precision.** Among delivered `missing_test` findings in V2 that cite an instrumented line, the share whose line never ran. Target ≥ 95%. R-a gives 100% by construction, so anything below that is an implementation defect.
- **P2, stability.** The kind+path+±5 Jaccard of delivered findings across the 3 reps. Target: median ≥ 0.8, against A's median.
- **P3, volume.** Delivered findings per PR: median and p90. Target: median ≤ 3, p90 ≤ 6.
  - Also reported: the share of PRs with ≥1 delivered finding, and how many of those findings are R-a.
- **P4, recall of deterministic gaps.** Gap units that receive a delivered finding, out of all gap units. It is 100% by construction for R-a, so this checks the implementation.

**Pass rule:** v1 passes when P1 ≥ 95%, P2 median ≥ 0.8 and P3 holds. The result is reported next to A on every measure. A failing measure is reported as such, and the targets do not change after the run.

## Secondary measures (descriptive)

- **S1, skeleton quality.** A sonnet-5-5 judge, run as a Claude Code subagent, grades each R-a finding's test skeleton on three questions:
  - (i) Does it target the never-executed lines?
  - (ii) Is its expected value taken from the PR text or requirements, or copied from the code?
  - (iii) Would it compile as written?

  The judge is calibrated first on known-answer controls: skeletons for a different definition, which should fail (i); expected values copied from the implementation, which should fail (ii); and syntactically broken skeletons, which should fail (iii). The judge's control accuracy is reported. If it falls below 90% on any control type, that dimension is "judge not valid".

- **S2, what happens to the relabelled claims.** The share of model `missing_test` that becomes `missing_case`, and how often those land in a definition that R-a also flagged.

- **S3, cost per run and per delivered finding.**

## Readings, fixed now

- **Pass:** "with a unit-coverage report, SpecGuard v1's missing-unit-test claims are execution-verified (P1), stable (P2) and bounded in volume (P3)". That is the v1 claim, and nothing about catching bugs.
- **Fail:** report which gate failed, fix the defect, and re-run on a NEW draw. The same corpus is never re-scored.

## Revision 1 (2026-10-21, after the independent red-team review): binding, and it overrides the sections above where they conflict

**B1, no tautology.**
- P1 and P4 are scored by an **independent** parser of the raw report: E1's scorer units and loadHits. coverage.json is not used.
- New headline measure **H**: of **all** delivered gap claims (R-a + R-b + R-c), the share verified true. R-c counts as unknown, and H is reported as a worst/best range.
- **Oracle validity:** pick 8 PRs (seed 20261021) and re-run the unit scope once in the same env. Target: ≥95% of R-a lines still never ran. A fresh-lockfile env is skipped, because it needs dependency installs (see B7); this is a stated limitation.

**B2, positive evidence.**
- coverage.json v2 already has `ran` ranges for changed added lines (#413). V2 extends it to every cited file: per-file executed-line ranges for changed files and for files a model finding cites (capped, with a `truncated` flag).
- R-b fires only on positive evidence (hits > 0). Everything else is R-c.
- Tests cover the truncated, uninstrumented and unchanged-file cases.
- Measure: share of R-b relabels backed by hits > 0. Target 100%.

**B3, health.**
- P1 and H are split by "the counterpart test file had no failures or errors" vs not.
- R-a volume on unusable PRs is reported (descriptive).
- The product prints the report's test-run status when the adopter supplies it. That is deferred and stated. The v1 claim is scoped to "from a healthy unit-test run".

**B4, sampler.**
- A new sampler with no message filter: single-parent squash commits with `(#N)`, stratified by changed lines (30–150 / 150–500 / 500–1200). Per repo, 3 + 4 + 3 = 10.
- Seeded shuffle; the first rows that pass are taken; the oversampling is stated. Same exclusions.
- Frozen before any run.

**B5, arm A.**
- V2 changes post.js and coverage.js only. The prompt bytes of both arms are hashed: if they differ, A runs live, at a cost of ≤$6 more.
- The V1 baseline is labelled "different condition (bug PRs, no coverage in prompt)", not a before/after.

**B6, judge.** Two dimensions become deterministic:
- (iii): compiles, checked with tsc --noEmit or py_compile;
- (i): executes the gap lines — the skeleton is added and the unit scope's coverage re-run.

Only (ii), "the expected value comes from the PR text/requirements and is not copied from code", uses the judge.
- Judge setup: sonnet-5-5, with a fixed, logged prompt. It runs on the owner's API key in the batch shell, not as a Claude Code subagent, because a subagent inherits memory and CLAUDE.md.
- Calibration items (n ≥ 20 per type, blinded, shuffled):
  - positive controls: hand-checkable skeletons whose expected value is quoted from the PR body;
  - negative controls: expected values copied from the implementation.
- Report sensitivity and specificity. If either is below 0.9, (ii) is "judge not valid".
- PRs with an empty body are reported apart.

**B7, security.**
- `cover` runs PR test code. It runs in a shell with no ANTHROPIC key and no gh token. The f2p harness passes only its ENV_KEEP whitelist, and installs use --ignore-scripts.
- The residual risk (filesystem access to the user profile) is accepted as in #410. A container is preferred but not available.
- Raw reports stay in the local evidence directory (outside this repository) and are never committed; only counts and hashes are.

**Targets** (no longer round numbers):
- H ≥ 90% verified-true, worst case. This is the Tricorder rule of about 10% effective false positives, though the 10% figure is from memory and must be verified.
- P1 = 100%, except for listed defects.
- R-a stability = 1.0 (a check).
- Model-sourced delivered-finding stability: median ≥ 0.5. This is a judgement call against the V1 0.24, labelled as such.
- Volume:
  - a cap is pre-registered: at most 5 inline R-a per PR, the rest rolled up per file in the summary;
  - delivered = inline + visible summary;
  - median ≤ 3 inline per PR;
  - p90 ≤ 7 inline. This follows Google's cap of 7 mutants per file, applied per PR here, and is a judgement call.
  - Also reported per changed definition and per 100 changed code lines.
- n = 30 means a share near 50% has a CI of about ±17 pt, and p90 is the 3rd-largest value. All of this is stated; per-repo numbers are descriptive only.

**Differentiation:**
- A primary measure **D**: the share of R-a findings with a skeleton that compiles AND executes the gap lines.
- The share without a skeleton is reported.
- The requirement link is NOT measured here; that is stated.
- Pass reading without D ≥ 50%: "patch coverage grouped by definition". With D ≥ 50%: "...plus an executable test skeleton for most gaps". The 50% is a judgement call.

**Other:**
- The exact SUT sha is pinned at the freeze.
- At most 2 fail→fix→new-draw cycles, each listed under multiplicity.
- Kind: R-b relabels to the existing `weak_test` kind with "(executed; untested case)", so no schema change.
- Coverage note text in the summary stays truncated and escaped.
- Budget: --max-total 12. The run order is shuffled by seed. If the cap stops the batch, only PRs with all 3 reps are scored.

## Revision 2 (2026-10-21): binding; it overrides Revision 1 and the original where they conflict

**Reframe (owner question, e0 analysis).** Technical truth is a guardrail, not the goal. Reviewers' attention is the scarce resource, so the target is **effective precision**: a finding a reviewer would act on. That follows Tricorder's "effective false positive", a developer-perceived figure. A search summary of Sadowski et al. (ICSE 2015) confirms the ~10% threshold, but I have not read the original text verbatim, and the analogy is to a perceived rate, not an oracle-true one. Precision is scored **per finding kind** and judged at **k = 3** per PR (judgement call). Recall counts only within that budget.

**V2 product rules, revised:**
- **R-a**, the deterministic coverage gap, has two additions:
  - a **not-worth-testing filter**, deterministic: a gap whose never-run lines are only logging/print calls, constant or type declarations, argument-forwarding one-liners, or generated code gets no finding;
  - **ranking**: by branching or error-handling lines in the gap, then gap size, then the `focus.js` risk score, then whether the PR text mentions the definition. At most 3 go inline; the rest are rolled up per file in the summary.
- **R-b**, the relabel: kind `weak_test`, `source: relabel`, at most medium confidence, **summary only**, and only on positive evidence. Positive evidence means a hit > 0 in coverage.json v2's `ran`, which covers **changed files only** (N2, option 2). A model claim on any other file is R-c.
- **R-c**: "(not verified by coverage)", unchanged.

**Measures:**
- **G1, guardrail.** Technical truth of R-a = 100%.
  - It is scored at **line level** from the raw report with E1's loadHits, so it is independent of grouping (B1a).
  - The definition grouping is audited separately: share of null or duplicate names, plus a judged audit of 30 groupings, reported.
  - **Env-artifact check, $0:** for each R-a, count the cases where a test file names the definition while coverage says "never ran". This is reported next to G1 (B1b).
- **G2, guardrail.** R-a stability = 1.0, as a check.
- **E1′ (primary, per kind), effective precision@3** of delivered findings. It has two proxies, reported side by side; neither one alone is the truth.
  - (p) **"Later tested"**: within 90 days after the PR merges, a commit adds or edits a test file that names the definition (whole word, by the fixed testsName). Use: compare **V2 ranking vs arm A vs a random-order arm** over the same R-a set. The ranking gate is relative: V2@3 > random@3, one-sided PR-cluster permutation, p < .05.
  - (j) **The judge**: sonnet-5-5 through the API, with a fixed, logged prompt (B6). It answers "worth a unit test?" with yes / no / unsure. Calibration, with n ≥ 40 per type:
    - positive controls: real gaps in branching logic that the PR text names;
    - negative controls: real gaps that are only logging, constants or forwarding.
    - Sensitivity and specificity are reported with Wilson bounds. The judge is valid only if both lower bounds are ≥ 0.75.
- **Silence.** The share of PRs with 0 inline findings. Reported, and the pass reading states it. No gate, since there is no basis for one.
- **Volume.** Inline median and p90 per PR, summary p90, and counts per stratum.
- **D, differentiation.** The share of inline R-a findings whose skeleton, run verbatim at the counterpart test path, compiles (tsc --noEmit / py_compile) AND executes the gap lines. The counterpart test path follows E1's "names the module" rule. Expected-value source, judged: PR text / code / neither.
- **H, all delivered gap claims.** R-a is verified. R-b and R-c count as **unknown** in the worst case (N3). Reported as a worst/best range.

**Explicit PASS rule (N1).** All of the following, gated on the **clean-counterpart subset** (B3); all-PR numbers are reported:
1. G1 = 100% (barring listed defects) and G2 = 1.0.
2. The ranking gate: (p) V2@3 > random@3 with p < .05.
3. The judge is valid, and (j) effective precision@3 of inline R-a has a lower Wilson bound ≥ 0.70. That bound is the v1 floor and a judgement call; Tricorder's target is 0.9.
4. Inline median ≤ 3 per PR.

D and silence are reported with their readings: D ≥ 50% means "plus an executable test skeleton"; otherwise "patch coverage grouped and ranked by definition". They are not gates.

**Corpus fallback (B4).** A short stratum is filled from the next smaller stratum, and that is stated. Medians and p90s are reported per stratum.

**Security (B7), stronger.**
- `cover` and the D skeleton runs execute untrusted code: PR tests and model-written skeletons. They run **under a separate local Windows user account** with no credentials (no ~/.claude, no gh, no git credentials, no SSH keys), with installs using --ignore-scripts.
- The batch, which holds the key, runs in the owner's own account and executes no repo code beyond collect.
- SpecGuard-evidence gets a `.gitignore` that stops raw reports from being committed.
- Owner action is required to create that account.

**Arm A.** It uses coverage.json from pre-V2 coverage.js.

## Multiplicity and history

This adds V2 to the list. Earlier attempts and their results are listed in `prereg-coverage-gap-e1.md`.

## Amendment 3 (red team, 2026-10-22, before any draw): binding; it overrides everything above where they conflict

**SUT.** SpecGuard main `dfe1493`. Arm A is main before #430, i.e. `dfe1493^1`.

**Window ends 90 days before the clone's HEAD.** The sampling window is 2025-07-01 to (clone HEAD committer date − 90 days), per repo. Reason: the primary proxy (p) "later tested within 90 days after merge" needs a full 90-day follow-up for every sampled PR; a PR merged closer to HEAD would have a truncated follow-up and a biased-low (p). Decided by the red team on technical merit before any draw.

**Corpus draw, as implemented (`eval/replay/v2-sample.js sample`, seed 20261021).** This replaces the `szz.js cleanSample` wording in "Corpus" (B4 already did); scope and repos are unchanged.
- Clones: hono, langchain and sqlglot at their recorded HEADs (written into `v2-corpus.json`).
- Pool: commits in the window with exactly one parent whose subject ends in `(#N)` (squash merges). No message or bug filter.
- Exclusions: every 40-hex commit sha that appears anywhere in `coverage-e1-design.json`, `coverage-e1-confirm.json` (E1 and E3 rows), `coverage-e3-manifest.json`, `pairs.json`, `holdout-pairs.json`, `holdout2-pairs.json`, `clean.json`, `holdout-clean.json` and `holdout2-clean.json`, and every `repo#PR` number those rows name (introducing and fix PRs).
- Changed lines: added + deleted lines over the commit's files, not counting docs and lockfiles (`szz.js` DOCS). Strata: s1 = 30 ≤ lines < 150, s2 = 150 ≤ lines < 500, s3 = 500 ≤ lines ≤ 1200; quotas s1 3, s2 4, s3 3 per repo.
- Unit scope (from `eval/f2p/repos.json` `cover`): a scope code file is a code file under `src/` (hono), `sqlglot/` (sqlglot) or `libs/core/langchain_core/` (langchain). A PR needs ≥ 1 changed scope code file. langchain also needs the core rule: every changed code file lies under `libs/core/`.
- Order: per repo, one seeded Fisher-Yates shuffle (mulberry32, as `cleanSample`); the shuffled pool is walked in order and the first rows that pass fill their stratum. The walk stops once every quota and both fallbacks are certainly covered (s1 ≥ 7, s2 ≥ 7, s3 ≥ 3 accepted); the number of commits examined (oversampling) and the drops by reason are recorded per repo.
- Short stratum: a short s3 is filled from s2's surplus, then a short s2 from s1's surplus, in walk order; such a row is counted in the stratum it fills (`stratum`) and records where it came from (`drawn_from`). s1 has no smaller stratum and stays short. Every fallback and shortfall is reported.
- PR text: the PR's own GitHub title and body (read-only `gh api`, cached outside the repo; stored in `v2-corpus.json`); on a failed fetch, the commit subject and an empty body, counted as `pr_text_fallback`. The PR's recorded merge commit is compared with the drawn sha and mismatches are counted (not dropped).

**(p) "later tested", as implemented (`eval/replay/v2-sample.js later`, git only).** For each sampled PR: the clone's first-parent (mainline) commits from HEAD with committer date strictly after the PR's commit and at most 90 days later, that add or modify ≥ 1 unit test file of the repo's cover scope (`dirs`, `file_re`, `exclude` in `eval/f2p/repos.json`). A definition counts as "later tested" when one of those files, at that commit, contains the definition's name as a whole word (`testsName` in `eval/replay/testgap-score.js`). Each row also records the follow-up days actually available before the clone's HEAD (90 for every row by the window rule). Per-repo (p) base rates (the share of R-a definitions later tested, regardless of rank) are reported; in busy repos (sqlglot: 2970 test-touching mainline commits across its 10 follow-up windows) (p) is near saturation, so it is read only as the relative ranking comparison it is defined as (V2@3 vs random@3), never as an absolute rate. The commit lists are raw data kept outside the repo; only the script and the counts are committed.

**Security (B7 as written in Revision 2 stands).** `cover` and the D skeleton runs are not started until the owner has decided on the separate no-credentials account. Drawing the corpus and the (p) data read git history only and run no repo code.

## Amendment 4 (red team, 2026-10-22, before any cover or model run): binding; it overrides everything above where they conflict

These six points fix how measures already defined above are computed. They were decided before any coverage or model run on the corpus, and `eval/replay/v2-score.js` and the replay wiring implement them.

1. **Clean-counterpart subset (B3, PASS rule).** "The counterpart test file had no failures or errors" means: that file has no test failures (`file_failures`, recorded per file by `cover`) and no collection or run errors (`file_errors`). The subset is defined per PR and does not depend on any finding (otherwise a PR with no R-a would be vacuously clean): a PR is clean when its cover run is usable and no counterpart test file of ANY changed code file of the PR (counterpart = a test file that names or neighbours the module, E1's rule) has file failures or file errors.
2. **Ranking gate unit (E1′ (p)).** The permutation test runs on one ranking per PR: that PR's R-a set, in V2 order vs random order. By G2, R-a is identical across the 3 reps, so reps are not averaged and do not add units.
3. **Ranking gate readability.** The gate is **not readable** (reported as "not readable", not as FAIL; PASS is then not achieved) when R-a items that are unnamed (no definition name) or unscorable fill more than 20% of all top-3 slots across the corpus. V2@3 with those items counted as "not later tested" is always reported alongside. The 20% threshold is a judgement call.
4. **G1 coverage.** Besides inline R-a, G1 is also reported over every never-run added line of the changed files (`g1_all`), so a defect outside the inline cap cannot hide.
5. **Volume and silence are per PR.** Each PR's value is the median of its per-rep values; medians, p90s and the silence share are then taken over PRs, not over runs.
6. **Judge gate completeness.** The judge-based gate (PASS rule item 3) is null unless every item in scope has a judge label (yes / no / unsure); missing labels are never imputed.

Also fixed: changed non-test files that are not code (md/json) are included in the clean check, which can only exclude more PRs (conservative); H counts rollup R-a as unknown in the worst case.
