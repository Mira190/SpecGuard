# SpecGuard Improvement Plan (First Principles, Benchmarked Against Top Practitioners)

Date: 2026-10-19.

**Audience**: management and repo contributors. They must first be convinced by a causal explanation before the project can shift left quickly.

**Baseline**: `origin/main` = `4176c33` (#388). All keyword checks were done with `git grep` on this SHA. This round called no model and made no write operations on GitHub.

**Revision note**: the first draft was based on a local branch 173 commits behind main, and missed `docs/validation-plan.md`. The first draft's statement that "randomized assignment, preregistration, blind labelling, and author feedback do not exist" was wrong; this version has corrected it, see §1.

## 0. The one sentence to prove

**Claim**: on the same class of PRs, turning SpecGuard on is better than leaving it off. Specifically, three points:

- fewer defects escape to QA or production;
- defects are fixed earlier;
- the benefit exceeds the cost of human attention and money.

Every link of the causal chain must be measured separately, and one composite score cannot replace that.

| Link | Current evidence | Existing measurement design |
|---|---|---|
| ① A defect exists and SpecGuard detects it | Offline replay hit rate 20.7% (9.33/45, `eval/replay/README.md` line 129); mutation pilot line-level hits 0/10 (`eval/mutation/README.md` line 44, #374) | SZZ replay (validation-plan Step 1) |
| ② Delivered to the author (inline comment that names the defect) | Only 5 of 30 detection events were delivered (`eval/replay/README.md` line 172); 213 of 288 replays (line 208) were incomplete (source: an uncommitted third-party review, not re-verified on main) | None |
| ③ Author adoption | fix-through A is only a touch proxy; author verdict is implemented (#353/#355), but across all PRs there is only 1, and it comes from the owner | fix-through and verdict in the three-arm trial |
| ④ The new test really catches the defect | **None** | **None** |
| ⑤ Without SpecGuard, the defect would escape to QA or production (counterfactual) | **None** | **None**: the trial's outcome variables are fix-through, precision, TTM, unique; there are no escaped defects |
| ⑥ Benefit exceeds cost | **None** | F2's P×A is an economic assumption, not a measured value |

A top practitioner's judgment would be: **the design is already complete; what is missing is execution and outcome variables.**

- `validation-plan.md` already has a complete plan: a three-arm trial (PR# mod 3), blind labelling by two seniors, power-based sample size, cluster bootstrap, preregistered continue/stop thresholds, and SZZ-first falsification (F5). But this plan has never been run on a real team. Kite's PRs are all seeds made by the owner, and have been halted since 10-18 because of billing.
- The three reviews of 10-14, 10-15, and 10-18 each proposed shadow and escaped defects, but neither entered validation-plan nor was implemented.
- Across 10-18 to 10-19, 15 more AI review documents were added to `docs/`. They are the same kind of evidence and cannot advance ③–⑥.

## 1. What exists, what is really missing

### 1.1 Already exists, not raised again

| Capability | Location |
|---|---|
| Three-arm assignment: 0 = SpecGuard, 1 = Copilot, 2 = both | `eval/assign.js`, `docs/validation-plan.md` |
| Preregistered thresholds (fix-through ≥25% with lower bound >15%; precision ≥65%; TTM ≤ +15%; unique ≥40%) and falsification conditions | `validation-plan.md` Step 6; `RULE` / `TARGET` in `eval/weekly-report.js` |
| Blind labelling: two seniors annotate independently, tool names hidden, shuffled by seed | `eval/label-export.js` |
| Sample-size threshold (reports "insufficient data" when short), PR cluster bootstrap, Wilson interval | `weekly-report.js`, `aggregate-counts.js` |
| Author verdict (fixed / wrong / intentional / not important) and author-judgment noise | #353, #355 |
| SZZ replay, contamination labelling, mutation pilot | `eval/szz.js`, `eval/replay/`, `eval/mutation/` |

### 1.2 Gaps: what top practitioners would fill

1. **The outcome variables lack escaped defects, i.e. phase containment / DRE (Capers Jones).**
   - The trial measures only adoption and noise, and cannot answer what management cares about most: "are there fewer defects in QA and production".
   - Fix: for bug-fix PRs during the trial period, use `szz.js` to trace back the PR that introduced them, then count escaped defects per 100 PRs by arm.
   - Report this number after 8–12 weeks (the 10-15 review already pointed out the need to wait this long).
2. **Arm 1 does not record what SpecGuard would have said, so no counterfactual is possible.**
   - Fix: turn arm 1 into shadow; SpecGuard runs as usual, but findings are only written to an artifact and no comment is posted. Later, aligning with SZZ lets us directly count "how many escaped defects the hidden findings would have stopped".
   - This is the fastest path to convince management of causality, without waiting for the difference in escape rates between the two groups to become significant.
   - This change does not violate "nobody goes without review", because arm 1 still has Copilot review.
3. **Assignment is predictable.**
   - An author can compute from PR# mod 3 which group they will land in, and can open an empty PR to choose the group.
   - Fix: switch to `HMAC(salt, PR#) mod 3`, with the salt stored in a secret and published after the trial ends.
4. **Blind labelling lacks agreement statistics.**
   - Currently "disagreements are merged into one file through discussion".
   - Fix: compute Krippendorff α (or Cohen κ) before merging. When α < 0.67 the labels cannot be used, and the labelling guideline must be revised first. Without α, there is no way to judge whether the precision 65% threshold is credible.
5. **There is no executable oracle to verify link ④.**
   - A `missing_test` / `weak_test` counts as verified only if it satisfies fail-to-pass: a test written per the suggestion fails on the buggy version and passes on the fixed version. This is the SWT-bench method.
   - `weak_test` is instead judged using pseudo-tested methods (Descartes / extreme mutation).
6. **Role-reversal ablation: machine locates, model explains.**
   - Candidates come from machines: diff-cover finds lines that are uncovered after the change, plus mutants that survive on changed lines. The LLM is only responsible for triage and mapping to requirements.
   - Precedents: Google shows surviving mutants in code review (Petrović et al., ICSE-SEIP 2021); Meta's TestGen-LLM / ACH only show results that passed machine filters.
   - This item directly corresponds to the line-level hit 0/10.
7. **Use an assurance case (GSN / CAE) to consolidate the review documents.**
   - Structure: claim → sub-claim → evidence → rebuttal. Each review is attached as an evidence node, with its level on the evidence ladder noted.
   - Recurring proposals (shadow, escaped defects) will show up in the assurance case as "unclosed rebuttals", and will not be considered done just because a new round of review raises them again.
8. **The repository's own quality is evidenced by third-party tools**: OpenSSF Scorecard, zizmor, actionlint, shellcheck, Stryker on `src/`, gitleaks in CI. On main, Scorecard is mentioned only once, in the 10-18 audit document; none of the others appear as requirements.
9. **Requirement testability**: check ACs per ISO/IEC/IEEE 29148; annotate each obligation with which ISTQB technique it was derived by (boundary value, equivalence class, decision table), so that reviewers can check completeness.

**Check results**: the following concepts appear 0 times on `4176c33`: Presidio, gitleaks, trufflehog, pseudo-tested, Descartes, SWT-bench, GSN, assurance case, fail-to-pass, Defects4J. A few others appear only in review documents and never entered the plan or code:
- shadow: 10-14 audit lines 226, 377;
- escaped defects: 10-15 review line 295, 10-18 audit line 60.

### 1.3 How top practitioners review

- Review the claim and the falsification conditions first, then the code.
- Every number must be labelled with its level on the evidence ladder: mechanism < seed < offline history < shadow < randomized control < longitudinal QA outcome. Currently it reaches only "offline history".
- Every number is first challenged with the dumbest baseline: diff-cover, the "changed the function but not the test" heuristic, a bare LLM prompt. If it cannot beat the baseline, there is no increment.
- Run a pre-mortem: assume the project is cut three months from now, what is the most likely reason? The answer is mostly noise, incomplete becoming the norm, and being unable to produce proof.
- **That an existing plan has never been executed is itself the number-one risk.** No new reviews should be written; instead, Steps 1–2 of validation-plan should first be run on a non-owner repository.

## 2. Sanitization: which raw materials to start with

| Raw material | Risk |
|---|---|
| Actions artifact `specguard-ctx` (diff, prompt context, raw model output) | Anyone who can read that repository's Actions can download it |
| Shadow arm artifacts (if §1.2 item 2 is implemented) | Same, and these findings were deliberately not sent to authors. For private repositories, shorten retention and restrict access |
| Actions logs, job summary, sticky comments, inline comments, scan issues | Contain private code references |
| `raw_excerpt` in `eval/results/*.json` (first 2000 characters of the raw output) | Private code snippets |
| CSVs exported by `label-export.js` (original finding text and PR links), labeller notes | Whether labellers may see private code must be authorized first; notes may quote code |
| Remote branches | **Verified**: the tips of 54 remote branches (the first draft's 64 came from unpruned local remote refs) still contain `docs/shift-left-live-review-evidence-2026-10-17.json`, which #334 removed from main. The local branch `codex/publish-sanitized-review-2026-10-17` is 173 commits behind main and still tracks two removed files; the remote branch of the same name (`b70c8d2`) does not contain them |
| Git history: in the rehearsal it affected 730/1053 commits, 153 branches, 247 PR refs | Deleting current files ≠ history cleared |
| Local `docs/branch-archives/`, `pr311-ctx`, `mirror.git` and evidence directories under the system temp directory | Contain source copies |
| 15 untracked review documents in `docs/` | Local paths (including the user name), temp directory names, possibly private repository names |
| `eval/replay/*.json`, `research/*.csv` | Handles and original issue text of public-repository contributors: respect the license and keep attribution; pseudonymize when used as a labelling set |
| Prompts already sent to Copilot / Anthropic | Cannot be sanitized after the fact, only controlled at the source (`deny.js`, `ignore`, content exclusion) |

## 3. Concrete methods and tools

- **Default deny publishing**: extend the `.gitignore` allowlist approach of `!report-public.md` to the whole repository. First assign a level to each field (public / pseudonymized / aggregate only / never publish), and publish only aggregate fields within the allowlisted schema.
- **Pseudonymization**: use HMAC-SHA256 with a key. Sets such as repository names and login names are small, and plain SHA can be reversed by dictionary. Keep file extensions and path depth. The finding id in `label-export.js` is already a hash; during review confirm it cannot be reversed.
- **Free text** uses Microsoft Presidio, plus custom recognizers (repository names, internal domains, ticket IDs). **Code snippets** are replaced with structural descriptions (language, kind, line count), and the original text is not published.
- **Secret scanning**:
  - gitleaks: put it in pre-commit and PR CI, and run it once over the entire history;
  - trufflehog: scan history with `--only-verified`;
  - GitHub secret scanning plus push protection.
- **Honeytoken strings for an end-to-end leak test**: plant unique markers in the private target repository, and have CI scan all outward outputs (artifacts, comments, docs), turning the job red on any hit. Note: the repository's existing "canary" means a canary PR, not a honeytoken.
- **History cleanup**:
  1. Rewrite history with git-filter-repo (`--invert-paths`, `--replace-text`).
  2. Ask GitHub Support to clean PR refs and caches, with the process in `privacy-and-pr-disposition-2026-10-18.md`.
  3. Delete the artifacts and logs of affected runs with `gh run delete` or the REST API.
- **Prevent re-identification**: do not publish cells with n<5. Record a manifest for each sanitization (input hash → tool and version → output hash), reviewed by a second person.

## 4. Who can prove it besides you and me

| Prover | What it proves | Whom it convinces |
|---|---|---|
| Execution oracle (test runs, mutation, fail-to-pass) | Whether a finding is real; whether the new test catches the defect (④) | Contributors |
| Pre-existing third-party ground truth: maintainers' own fix PRs (SZZ), SWT-bench, Defects4J, BugsJS | Detection rate, with standards not set by us | Both |
| A three-arm trial run by a non-owner team per validation-plan, plus shadow and escaped-defect tickets | Counterfactual and causality (⑤) | **Management** |
| Verdict replies from real contributors (≥30, non-owner) | ③ and author-judgment noise | Contributors |
| Blind labelling by two seniors, with α attached | precision | Both |
| Copilot code review on the same set of PRs (already designed as arm 1 / arm 2) and other competitors | Incremental value (unique share) | Management |
| Scorecard, CodeQL, zizmor, Stryker badges | The repository's own engineering quality | Contributors |
| A reproducible package (fixed SHA, manifest, raw answers) | Anyone can re-run | Both |

Codex or another LLM acting as reviewer is the same kind of evidence as "you". They can only be used for triage, and must first be calibrated against human labels.

## 5. Execution order

Each step comes with an eval that can prove it works.

**P0: this week, no model spend**

1. **Privacy stopgap**
   - Handle the 54 remote branch tips that still contain private files, and the old local branches: back up first, then delete by exact path; then do history cleanup.
   - Add gitleaks, honeytoken scanning, and the allowlist publishing check.
   - eval: plant a honeytoken in a fixture; CI must turn red.
2. **Complete validation-plan, without redoing what code already has**
   - turn arm 1 into shadow;
   - change assignment to HMAC with salt;
   - compute α before merging labels;
   - add the escaped-defect outcome variable (SZZ counted by arm).
   - eval: fixture tests of `weekly-report.js` cover alignment of shadow findings with fix PRs, and the α computation.
3. **Create `docs/assurance-case.md`**: attach the rebuttals raised repeatedly but not closed in §1.2. Until this document exists, pause adding new AI review documents.

**P1: 2–3 weeks**

4. **Find a non-owner real repository and run validation-plan Step 1** (SZZ replay of the most recent 50 bugs, passing the F5 falsification threshold) **and Step 2** (canary plus three arms). The precondition is that Kite's billing is restored or another repository is available.
5. **Add a fail-to-pass "verified" label to the replay set and the mutation set**, reusing `eval/replay.js` and `eval/mutation/`.

**P2**

6. Role-reversal ablation (machine locates, model explains). The goal is to push line-level hits above 0/10.
7. Third-party quality badges, and the requirement testability check (§1.2 items 8 and 9).

**Thresholds**: keep the four already preregistered in validation-plan Step 6, and add three:
- labels are valid only when α ≥ 0.67;
- the CI lower bound of the number of escaped defects stopped in the shadow arm is above the best baseline;
- verified precision ≥ 60%.

If any one is not met, shrink the scope, consistent with the third-party review's recommendation.
