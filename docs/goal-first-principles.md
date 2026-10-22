# First-Principles Analysis of the SpecGuard Goal, and Unknown Unknowns

Date: 2026-10-09.

**Scope**
- Original goal: unit test review.
- Purpose: shift-left quality engineering.
- New requirement: bidirectional requirement ↔ code traceability.

**Basis**
- Verification against the current code: `collect.sh`, `requirements.js`, `post.js`, `SKILL.md`.
- Six lines of research, including academic literature, industrial empirical studies, existing tools, GitHub Actions feasibility, and blind-spot techniques.
- Companion implementation plan: `docs/traceability-plan.md`.

This document is analysis only and changes no runtime code. Any number marked "unverified" comes from secondary sources or search summaries, and must be checked against the original before being cited.

## 0. Conclusion

1. **The logic defects QA cares about can all be described as inconsistency or absence among three artifacts.** The three artifacts are the requirement R (intent), the code C (implementation), and the test T (verification), plus a set of rules S. Every item of the original goal falls on some edge of this R–C–T triangle (see §1.3).
2. **SpecGuard's marginal value is in the defects that are still wrong even though CI is green.** CI can only prove that C and T agree; only by bringing in R can one judge whether that agreement is correct.
3. **When the current system has no R, `covered` really only means "the test is consistent with the code" (verification), not "the behavior is correct" (validation).** When tests are derived backwards from the implementation, errors get frozen by the tests. AI-generated tests are the most prone to this.
4. **The two requirement scenarios are exactly the two "CI green" states the current system handles wrongly (see §2).**
   - Scenario B (only the requirement changed): skipped outright by `collect.sh:44`.
   - Scenario A (code and tests changed together, requirement unchanged): marked `covered`, giving false reassurance.

   So bidirectional traceability is not an add-on feature. It fills in the missing oracle half of the original goal "review requirements and the tests".
5. **Ranked by impact, the five unknown unknowns that most need handling first are (§4):**
   - attributing pre-existing drift to this PR;
   - the test's expected value itself being wrong (C=T≠R);
   - a change synchronized to only some of the locations;
   - the implementation not being in this repository;
   - equivalent conversions of units and boundaries.

   All five can be handled cheaply by deterministic means.
6. **The direct way to prove shift-left works is replay.** Use SZZ to trace a QA or production defect back to the PR that introduced it, replay SpecGuard, and see whether it could have found it early on that PR (§6). Seeded cases can only prove the mechanism is feasible, not that it has value.

## 1. Goal decomposition

### 1.1 Original goal (verbatim)

> Create a unit test review AI GitHub Workflow. Must review requirements and the tests, and identify missing unit tests. 1. Must check coding standard has been confirmed too. 2. If possible — review other testing like component or integration testing and see what can and should be in the unit testing.

The purpose is to shift QA left: catch test gaps and requirement deviations at the PR stage, before QA gets the build.

### 1.2 First principles: what exactly does QA judge

QA judges "actual behavior = expected behavior". At PR time, static review can see four things:

| Artifact | Meaning | Location in the repo or PR |
|---|---|---|
| R intent | What should be done | PR body, issue, spec/Gherkin/ADR, historical PRs and issues, test names, comments, user-visible copy |
| C implementation | What is actually done | Source code, configuration, migrations, feature flags, templates, other services |
| T verification | What proves C conforms to R | Tests at every level, snapshots, golden files |
| S rules | How to write | The repository's standards files, and lint/format checks |

Logic defects take five forms:

| Defect form | Existing check |
|---|---|
| R exists, C does not implement it | Not implemented |
| C contradicts R | Violates requirement |
| C changed, no T | `missing_test` |
| T cannot constrain C | `weak_test` |
| The value T asserts contradicts R | **No check currently** |

In addition, the same R may land in multiple places in C, with only part of them changed (partial propagation).

### 1.3 Original requirements and the triangle's edges

| Original requirement | Corresponding edge | Current state | Gap |
|---|---|---|---|
| review requirements and the tests | R→T | `requirements[]`, `coverage[]`, per-AC checklist | R comes only from the PR and issues; in-repo specs and historical intent are not used at all |
| identify missing unit tests | (R ∪ ΔC)→T | `missing_test`, and `from behaviour` obligations | When the requirement changed but the code did not (scenario B), the whole PR is skipped |
| Implicit requirement: the test tests the right thing | Whether T's oracle comes from R | `weak_test` only looks at whether T can constrain C | **C=T≠R**: when test and code are wrong together it is judged `covered` |
| coding standard confirmed | S→C, plus execution evidence | standards dimension and `inspectChecks` | Already handled by the goal audit |
| component/integration → unit | T's level | `higher_level_only` plus `pushdown` | None |
| shift-left (purpose) | Discover before QA | advisory PR review | Value has never been measured (§6) |

### 1.4 Scope statement

Static review does not execute code and has no runtime environment, so it cannot see the following kinds of problems:
- environment or configuration combination problems;
- integration timing problems;
- user experience and performance problems;
- cross-service contract problems.

SpecGuard covers the defect class of "logic plus requirements", and external descriptions should say so clearly. The traceability feature makes coverage of this class more complete, but does not widen its boundary.

## 2. Core inference: the value lies where CI cannot see

CI runs tests, so CI green means C≈T. For a reviewer that only looks at C and T, most of what it finds CI can find itself; its unique value is introducing R into the CI-green states.

The table below lists the state space of a single requirement-constrained behavior. v0 is the old value, v1 the new value, ∅ means nonexistent, and "changed" means this PR modified it.

| # | R | C | T | CI | Current SpecGuard | Expected conclusion |
|---|---|---|---|---|---|---|
| 1 | v1 changed | v1 changed | v1 changed | green | covered | Consistent, and covered by tests |
| **2** | v1 changed | v0 | v0 | **green** | **skipped (`collect.sh:44`)** | **Scenario B**: both implementation and tests are stale |
| 3 | v1 changed | v1 changed | v0 | red | weak/missing | CI can already find it, only locating information needs to be added |
| 4 | v1 changed | v0 | v1 changed | red | skipped or partially handled | CI can already find it |
| **5** | v0 | v1 changed | v1 changed | **green** | **covered (false reassurance)** | **Scenario A**: violates the requirement, or the spec was not synchronized |
| 6 | v0 | v1 changed | v0 | red | weak_test | CI can already find it |
| 7 | v0 | v1 changed | ∅ | green | missing_test | missing_test, and point out the requirement violation |
| 8 | ∅ (not found) | v1 changed | v1 changed | green | covered (from behaviour) | A hidden requirement may exist, see U7 historical intent in §4 |
| 9 | ∅ | v1 changed | ∅ | green | missing_test | Unchanged |
| 10 | new AC | ∅ | ∅ | green | missing_test or unknown | Requirement not implemented |
| **11** | Already inconsistent with C at BASE | v0 (untouched, the PR only changed nearby) | any | green | undefined | **pre-existing**: summary only, not attributed to this PR |
| **12** | v1 changed | C1=v1, C2=v0 | only C1 tested | **green** | sees only C1 | **Partial synchronization**: list C2, and likewise stale copy, config, snapshots |

Three points can be read from the table:
- For the CI-red rows (3, 4, 6), SpecGuard's marginal value is low and they should be ranked later.
- The CI-green rows (2, 5, 7, 8, 11, 12) are where shift-left value lies. The current system judges wrongly or cannot see on 2, 5, 11, 12.
- This table is itself the evaluation matrix: each row corresponds to a seeded case (§6 L1), so coverage is guaranteed by construction and not by after-the-fact picking.

## 3. Evidence: what to invest in, how much noise can be tolerated

| Evidence | Source | Inference |
|---|---|---|
| Code that was modified but not tested has a defect rate about 5 times that of unmodified code; over 70% of field defects occur in untested code | CQSE/Teamscale's Test Gap Analysis ([AST'13](https://wwwbroy.in.tum.de/publ/papers/AST13Hauptmann.pdf), [2016 practice report](https://teamscale.com/hubfs/26978363/Publications/2016-did-we-test-the-right-thing-experiences-with-test-gap-analysis-in-practice.pdf)). The data comes from the vendor's own cases; original tables not verified | `missing_test` for modified behavior remains the backbone, and the traceability feature must not crowd it out |
| "Incomplete or hidden requirements" is the most often cited problem (48%) | NaPiRE ([arXiv 1612.00163](https://arxiv.org/pdf/1612.00163)) | Requirement gaps are common, but mostly occur before the PR. A PR bot can only expose the gap between "written-down requirements" and the code, and flag ambiguity |
| 82.3% of projects have historically had documentation with outdated code references | Tan et al. ([arXiv 2212.01479](https://arxiv.org/pdf/2212.01479)) | **The spec is not the truth**: a traceability link can only be treated as a claim to be verified. When the spec in the repository has already drifted, a differencing mechanism (U1) is needed, otherwise noise will drown everything |
| Only about 19% of teams use BDD; formal requirement documents are rare (reliable data lacking) | State of Agile (secondary, unverified), [Patkar 2022](https://scg.unibe.ch/assets/archive/papers/Patk22b.pdf) | Most repositories have no spec files. The **PR body, issues, and historical intent** are the main requirement sources (U7) |
| The adoption rate of general LLM review comments is about 7–20%; refactoring suggestions (18.6%) are far higher than functional ones (5.2%) | RevMate, Mozilla/Ubisoft ([arXiv 2411.07091](https://arxiv.org/html/2411.07091v1)) | Functional and requirement assertions are the hardest to get accepted, so give the strongest evidence: original quotes at both ends, validated deterministically |
| 73.8% of comments were handled, but PR close time rose from 5h52m to 8h20m | Beko/Qodo, ICSE SEIP 2025 ([arXiv 2412.18531](https://arxiv.org/abs/2412.18531)) | Besides the handling rate, time-to-merge must be measured |
| When AI patches are shown only to the author, review does not slow down | Meta MetaMateCR ([arXiv 2507.13499](https://arxiv.org/abs/2507.13499)) | Findings should face the author and stay off the reviewer's critical path (consistent with the existing COMMENT approach) |
| The fix rate of issues reported on a diff is about 70%, while offline batch reports get about 0% | Meta Infer ([CACM 2019](https://cacm.acm.org/magazines/2019/8/238344-scaling-static-analyses-at-facebook/pdf)) | **Report only issues introduced by this PR**. Pre-existing issues go to the summary only |
| After controlling for test suite size, coverage and mutation score have only weak to moderate correlation with real defect detection | Inozemtseva & Holmes ICSE 2014, Papadakis et al. ICSE 2018 | Coverage and mutation score can only be used to point a direction, not as a verdict (consistent with the positioning of L2a/L3b in design.md) |
| Evidence for the "1:100 fix cost curve" is insufficient | Bossavit, *Leprechauns of Software Engineering* | Do not use this number in external statements |

**Noise budget**: based on the above data, requirement-type inline comments per PR should be kept to single digits, with only "inconsistencies introduced by this PR and referenced at both ends" going inline, and the rest going to the summary. This is a data-based design assumption and needs to be verified in a pilot.

## 4. Unknown unknowns

### 4.1 Mining method

Use the Rumsfeld matrix to scan systematically from seven perspectives, rather than relying on inspiration:

| Perspective | Question to ask |
|---|---|
| ① Triangle state space (§2) | Is the conclusion right under every combination of R/C/T? |
| ② Where the information is | In which places might R, C, and T each be written? Which places did we not read? (This class is "known but unused knowledge") |
| ③ Representation equivalence | How many ways can the same value or rule be written? |
| ④ Time | BASE vs HEAD differences, staged rollouts, versions |
| ⑤ Authority and people | When the two sides disagree, who decides? Who handles this comment? |
| ⑥ Adversarial | Malicious or improper PR content |
| ⑦ Empirical replay | For defects that really leaked to QA, why did we miss them? Only this perspective can find true unknown unknowns |

### 4.2 Blind-spot list

Precision is P, recall is R; cost is graded S/M/L.

| ID | Blind spot | Perspective | Impact | Current state | Countermeasure | Cost |
|---|---|---|---|---|---|---|
| **U1** | **Pre-existing drift attributed to this PR**: at BASE the spec and code were already inconsistent, and the PR merely touched nearby code | ④ | P, the biggest precision risk | No concept of differencing | Add `since: introduced\|pre_existing`. Deterministic rule: when neither the requirement entry nor the behavior reference line is in the diff, it cannot be marked introduced. pre_existing goes to the summary only | S |
| **U2** | **Wrong oracle (C=T≠R)**: the test and code were changed together, contradict the requirement, yet are judged covered | ① | P, false reassurance | `covered` only requires unit assertions | Rule: when `alignment=mismatch` the status cannot be covered; replace that missing or weak finding with `spec_mismatch` | S |
| U3 | PRs that change only the spec are skipped | ① | R | `collect.sh:44` | Spec documents enter the reviewable scope (see the plan) | S |
| **U4** | **Partial synchronization**: the same value appears in frontend, backend, config, i18n copy, snapshots, email templates, and only one place was changed | ①② | R, the biggest recall gain | Invisible; `*.snap` and `__snapshots__` are ignored by default | A deterministic "old-value occurrence table": grep the whole repository for the old value and its unit variants, including snapshots, i18n, and config, and annotate whether this PR changed them | S–M |
| **U5** | **Implementation not in this repository**: in remote config, a feature-flag platform, or another service; not found by search and so falsely reported as "not implemented" | ② | P | None | Add `alignment=not_verifiable`, which must list the scope searched; mismatch must not be reported unless config, migrations, and schemas have been exhausted | S |
| **U6** | **Representation equivalence**: 30 days = `2592000000` ms = `P30D`; "more than 30 days" maps to `>` and not `>=`; calendar days vs business days; time zones; rounding | ③ | P and R | None | The collector generates unit variants; `references/trace.md` gives a normalization list, and the normalized value is written down before comparison; both sides of the boundary need tests (29/30/31) | S |
| **U7** | **Historical intent (known but unused)**: in repositories without a spec, the requirement is actually written in the PR and issue that originally introduced the line | ② | R, the widest coverage in spec-poor repositories | Unused | Run `git blame` at BASE on modified lines to get the commit, then look up the corresponding PR, then fetch its linked issue, as an optional requirement source (at most 3, quotes verified by post) | S–M |
| **U20** | **The PR links no issue and its body is thin**: requirement sources 1, 2, and 4 all depend on the PR body or issue links, and many repositories have neither | ② | R, otherwise scenario A is left with only from behaviour | Reads only the PR body and linked issues | In-repo requirement documents are discovered by **content**, across the whole repository, no longer gated by glob. The root README, RULES.md next to code, `.kiro/specs`, and `openspec/` can all be recognized automatically; globs are used only for ranking, and `requirements_paths` only for supplementing or excluding; unreadable docx/pdf requirement files are listed in limitations. See plan §4.0 and §4.1.1, cases tr16 and tr17 | S |
| U8 | Requirements written in test names, comments, and user docs (tests as spec) | ② | R | The agent reads them, but not as a requirement source | Allow citing them as "implied requirements", marked `inferred`, summary only | S |
| U9 | Multiple requirement sources contradict each other (issue says 45, spec says 30) | ⑤ | P | None | Report the source conflict itself, without ruling for people on which side is right (intent signals are used only to hint at direction) | S |
| U10 | The requirement itself is ambiguous and untestable ("within 30 days" counted from which day?) | ⑤ | P | None | Mark as `needs_human`, explaining where the ambiguity lies. This is itself a QE finding, but whether to make it a separate kind needs measurement first | S |
| U11 | Staged rollout: the spec changes first and the code in a later PR; or feature flags or versioned APIs let old and new values coexist | ④ | P | None | Downgrade when the PR body has "follow-up #N" or a flag; mark not_verifiable when versions or flags are involved | S |
| U12 | Non-functional and negative requirements ("must not log PII") cannot be pinned to a specific line | ② | — | — | Put in `needs_human`, explicitly out of scope | 0 |
| U13 | The test exists but is not run (skipped, excluded, not reached by CI) | ② | P | Purely static judgment | L2a in design.md: read the coverage and JUnit artifacts the consumer's CI already has, as pointing evidence | M |
| U14 | Renaming or moving files makes BASE and HEAD fail to line up | ④ | P | collect uses `--no-renames` | Enable `-M` when determining the diff | S |
| U15 | The same PR gives different results on each run | ⑦ | P | stability has run 12/12 | Measure per-finding Jaccard stability; do majority voting only if necessary (cost is N times the tokens) | M |
| U16 | Evaluation ground truth is too small and hand-picked, and recall has never been measured | ⑦ | Evaluation validity | 14 + 7 seeded cases | L2/L3 in §6: mutation generation and historical replay | M–L |
| U17 | A spec inconsistency should be handled by the PO or spec owner, but the comment reaches only the developer | ⑤ | Adoption rate | None | List the CODEOWNERS of that spec file in the summary (read-only, deterministic) | S |
| U18 | PRs get slower after adding review (Beko +42%) | ⑤ | Adoption rate | Not measured | The pilot records time-to-merge and handling rate by category | Process |
| U19 | The spec is modified by the PR to "legitimize" violating code | ⑥ | — | — | This is exactly a case where a human needs to look. `reflected_in.spec=true` plus a hint "spec modified within this PR" is enough. Spec text is still treated as data only | 0 |

### 4.3 Priority

| Level | Items | Notes |
|---|---|---|
| P0 (do together with traceability v1) | U1 differencing, U2 wrong oracle, U3 spec-only PRs, U4 occurrence table, U5 not_verifiable, U6 normalization, U14 rename, **U20 content-based discovery of requirement documents** | All are deterministic rules or a few dozen lines of code, and directly determine precision |
| P1 | U7 historical intent (depends on the PR body; stronger when an issue is linked, but does not depend on the link), U8 implied requirements, U9 source conflict, U11 staged rollout | Low cost, widens applicability |
| P2 (do only once the threshold is reached) | U13 coverage artifacts, U15 majority voting, U17 CODEOWNERS, U10 ambiguity as its own kind | Needs pilot data to prove they are worth doing |

## 5. Revisions to the design

Already written into `docs/traceability-plan.md`:
- **Differencing**: the `since` field, and deterministic downgrade rules.
- **New alignment state**: `not_verifiable`, which must attach the search scope.
- **Wrong-oracle rule**: `mismatch` cannot be covered, and `spec_mismatch` takes the place of that missing or weak finding.
- **Occurrence table**: generated in the collector, covering unit variants of the old value as well as snapshots, i18n, and config files.
- **Historical intent source**: blame → PR → issue, as an optional requirement, not forced into evaluation.
- **Normalization list**: merged into the agent guide.
- **Evaluation expansion**: corresponds to the state matrix of §2. Add two deterministic generators: spec mutation and code mutation, with no-op controls and consistent-change controls.

## 6. Evaluation: how to prove shift-left works

| Level | Method | What it proves | Cost |
|---|---|---|---|
| L0 | `node:test` deterministic tests, including candidate recall recall@8 | The mechanisms of the collector and validator are correct | Existing system |
| L1 | State-matrix seeded cases (the 12 rows of §2, one case per row, plus adversarial cases) | The conclusion logic is complete, and coverage is guaranteed by construction | M |
| L2 | Mutation generation on real OSS repositories: change a value in the spec, expect the code and tests to be found; change a value or comparator in the code, expect the spec to be flagged; a no-op refactor as control, nothing should be reported; a consistent change of spec, code, and tests as control, nothing should be reported. Ground truth comes from the old-value occurrence table, with sampled human review of equivalent mutants | Recall and false-positive rate at real scale | M |
| L3 | Historical replay: mine commits that changed both spec and code, revert one side to construct positives, and use the original commit as the negative | Performance under real distribution | L |
| **L4** | **SZZ replay**: start from bugs found by QA or production in the issue tracker, use the SZZ algorithm (Śliwerski, Zimmermann, Zeller, MSR 2005) to find the PR that introduced them, and replay SpecGuard on that PR | **Directly measures the original purpose: how many QA-found defects could be stopped at the PR stage** | L (needs a pilot repository with bug labels) |
| Field | Handling and rejection rates by category, comments per PR, change in time-to-merge | Adoption and cost | Process |

Thresholds follow design.md: only when high-confidence precision is ≥80% is blocking mode discussed. The threshold for requirement-type findings is stricter (≥90% in the plan), because they are the hardest to get accepted.

The executable plans for L2, L3, and L4 are written in `docs/traceability-plan.md` §7.4, and the corresponding work packages are WP6–WP8:
- **WP6 external repository evaluation mode**: mirror the repository, inject the workflow by merging, and copy the requirement context.
- **WP7 mutation benchmark**: humans confirm the correspondence among requirement, code, and test, for 8 mutation operators in total (including 3 control groups).
- **WP8 SZZ replay**: humans confirm the correspondence between a defect and the PR that introduced it; before replay, first determine whether the defect is in scope, then adjudicate on three levels, direct, indirect, and miss, and use defect-free PRs as a noise baseline.

Each scenario is run separately with `trace: off` and `trace: auto`, directly measuring the incremental value the traceability feature brings.

## 7. Questions that need your confirmation

1. The constraint list in the original requirement text is truncated at "Gherkin, Git…"; what are item 3 and later? Does "Git…" mean GitHub Issues, the Wiki, or Git history? If it is Git history, U7 should be raised to P0.
2. Is there a pilot repository with QA or production defect labels? This determines whether L4 (the most direct proof of value) can be done.
3. Inline budget for requirement-type findings: the suggestion is no more than 5 per PR, only introduced and high-confidence ones, with the rest going to the summary. Is this acceptable?
4. Should U10 "requirement ambiguity" be reported separately as a kind of QE finding? It extends the boundary of the original goal, so you need to decide.
