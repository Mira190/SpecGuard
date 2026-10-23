# Repo-wide audit summary template: research, critique and field rules (2026-10-22)

Sample: [`templates/repo-audit-summary.mock.md`](templates/repo-audit-summary.mock.md) (mock data; product output is always English).
This document answers four questions: what the reader needs (§1), a critique of the requirements (§2), what the industry does (§3), and how each field is computed (§4). §5 lists unknown unknowns; §6 compares against the current `src/audit-post.js` and lists the gaps and the implementation order.

The old template [`templates/repository-shift-left-report.md`](templates/repository-shift-left-report.md) is a 12-section fill-in form written for human auditors. Its fields are comprehensive, but it is not a summary for testers. The new template replaces it as the product output; the old template stays as a checklist for manual deep reviews.

## 1. First principles: what a tester must learn within one minute of opening the report

The reader is a tester / QA lead. They read the report only to decide what to do next. So the report answers three questions, in a fixed order:

1. **Can I trust this report?** Was the scope fully audited, what evidence was used (coverage reports, CI history, requirement documents), and which numbers mean "not measured" rather than "zero".
2. **What do I do first?** At most 10 items, each with one verb (Add / Strengthen / Move down / Make CI run / Fix or delete / Clarify / Check), with location, reason, evidence level and owner.
3. **Where is the risk concentrated?** One row per area: status, number of items to handle, evidence level. Details are collapsed.

Design rules that follow:

- **The visible part contains only what changes the next action** (owner rule of 10-13: the summary holds actionable content only). Each area's details go into `<details>`, but the `<summary>` line itself carries the key numbers, so the overall picture is visible without expanding.
- **Every finding carries an evidence level**: E = execution evidence (coverage report, CI result), S = deterministic static rule, M = model judgement. When ranking, E/S always come before M. The reason is our own measurements: coverage gaps are 100% correct at line level (A3), while the model's missing_test is only 0–15% (A3) and 24% (E3 baseline); stability Jaccard is 0.17 (A1). Mixing M-level findings with E-level ones dilutes high-precision conclusions with low-precision ones.
- **One score per area, no total score.** Owner 10-22 asked for concrete scores. Each area gets a score that is a count over a fixed denominator (e.g. "89%: 31 of 35 rules that have a unit seam"), shows its evidence level, and names the fixes that raise it (§4.5). There is still no composite: a 0–100 total does not tell a tester what to change, mixes evidence levels, and invites gaming (Goodhart). No targets or grade bands either: a target becomes a ceiling (§3.3).
- **"Not measured" and "zero" must be distinguished.** With no E2E coverage report, write "not measured", not 0%, and do not pass off a count of statically matched tests as coverage. With no design document, write "no design document", not 0/0.
- **The denominator is fixed by files, not by the model.** The same commit with the same configuration gives the same denominator; the model emitting less must not make coverage look better.
- **Every action has an owner** (CODEOWNERS). A bulk report with no ownership gets no fixes (see the Infer data in §3.6).
- **Compare with last time**: new / fixed / still open, in one line. A reader who sees the same long list a second time stops reading.

## 2. Critique of the requirements

Original requirement: the summary should include requirement health, design health, requirement coverage, design coverage, placement issues, CI checks, etc.; coverage includes unit, E2E, integration and component; it should tell testers where to add, delete or modify tests, including unit test quality.

| # | Requirement | Problem | Decision |
|---|---|---|---|
| C1 | requirement / design **health score** | Scoring needs ground-truth calibration; we have no human labels (owner 10-21) and the precision of model judgement is unmeasured. A total score does not point to an action. | Revised 10-22 after the owner asked for concrete scores: requirement health = share of requirements that pass every ISO/IEC/IEEE 29148 check, design coverage = share of components with code and a test, each with its denominator, M/S level and the violations listed. No composite (§4.5). |
| C2 | **design coverage** | There is no general definition. Most repos have no design documents (our docless branch exists for this reason). | Defined as the share of "components/interfaces/decisions in the design document → have a code location → have a test at the matching level"; with no design document the whole section shows "no design document" and is not ranked in the Scores table. |
| C3 | **coverage** per level (unit/integration/component/E2E) | SpecGuard scan is static, and the owner forbids executing third-party code locally (10-22). Per-level coverage can only come from the repo's own reports (Codecov flag, CI artifact). Statically "having test files" is not coverage. Test layering itself is heuristic (directory, file name, runner config). | The table has two kinds of columns: test inventory (static, always present) and coverage (only when a report exists for that level, otherwise "not measured"). The layering rules are linked in the report. |
| C4 | Tell testers **what to delete** | Recommending test deletion from static review is risky: deleting the wrong test loses protection. | Recommend deletion only with definite evidence: long-term skip (with days), no assertions, the test's own subject is mocked, requirements that reference a removed feature. Wording is "fix or delete", not "delete". |
| C5 | Many dimensions ("etc.") | Every extra section costs reader attention. Our core goal is unit test gaps (v1, owner 10-21). | All dimensions go into the template, but only those that E/S level can support are implemented first (§6). M-level areas are collapsed by default. |
| C6 | **unit test quality** | The real quality question is "does the test fail if the code is wrong", which only mutation testing can answer; scan does not execute code. The existing static signals are noisy: `audit-units.js:289` sums the signals of all test files matched to one unit, and test files match by name, mention or directory, so one large shared test file can match several units. The 52 "weak test signal" rows in the A1 self-audit refer to units (e.g. `src/post.js`: "57 tests without an assertion"), so the reader does not know which test to change. | Attribute quality signals to the **test**, not to the unit; without mutation, say plainly "test strength not measured". |
| C7 | **CI check** scope | Security scanning (SAST, dependencies, secrets) is not a tester's main responsibility, but "do the tests run in CI" is. | The CI section is test-centred (does each level run on PRs, are there test files that no job ever runs, do retries mask failures, coverage gates); security takes one line. Settings that cannot be read are written ❔ unknown and do not count as passing. |
| C8 | "Let testers grasp the important information quickly" conflicts with "include all dimensions" | The two need a trade-off. | Resolved by "visible = conclusion + evidence sources + Scores + Top 10; everything else collapsed". |

## 3. Research: industry practice and evidence

Research date 2026-10-22. Every conclusion carries a source; items marked *(secondary)* come from second-hand summaries, and items marked UNVERIFIED were not checked against the original. ISO 29148, ISO 26262 and DO-178C are paid standards, so their content comes from secondary sources. The last line of each subsection states "Impact on the template".

### 3.1 Requirement quality (requirement health)

| Source | Dimensions / scoring method |
|---|---|
| ISO/IEC/IEEE 29148 (via INCOSE C1–C14) | 9 per-requirement items: necessary, appropriate, unambiguous, complete, singular, feasible, verifiable, correct, conforming; 5 set-level items: complete, consistent, feasible, comprehensible, able to be validated ([arXiv 2408.10886](https://arxiv.org/pdf/2408.10886), [se-trends](https://www.se-trends.de/en/review-incose-guide-for-writing-requirements/)) |
| INCOSE Guide for Writing Requirements v4 (2023) | 41 writing rules + 14 characteristics ([INCOSE](https://www.incose.org/docs/default-source/working-groups/requirements-wg/gtwr/incose_rwg_gtwr_v4_040423_final_drafts.pdf)) |
| IBM RQA | Scores against INCOSE rules; a reseller claims 11 quality scores cover over 80% of the guide ([requisis](https://requisis.com/en/saas-doors-dng/rqa-saas.html); full list UNVERIFIED) |
| QVscribe | 1–5 cells per requirement: single imperative, no negation, no vague words, no escape clauses, EARS sentence pattern ([QRA](https://edu.qracorp.com/knowledge/quality-analysis-scoring-guide-3)) |
| Jama Connect Advisor | INCOSE rule conformance 0–100%: 81–100 green, 61–80 yellow, 0–60 red ([Jama](https://help.jamasoftware.com/ah/en/jama-connect-advisor-/interpreting-the-results.html)) |

How far automation can go: wording-level rules (vague words, escape clauses, multiple shalls, missing units) can be checked automatically; necessary, correct, feasible and cross-set consistency need semantics and context. The requirements smell detector (Smella) averages 59% precision and 82% recall, with large variation between projects ([Femmer et al. JSS 2017](https://arxiv.org/pdf/1611.08847)).

**Impact on the template:** Commercial tools do give scores (Jama 0–100%), but at 59% precision, four in ten of the points awarded are noise. The template lists only the dimensions a tester can act on (untestable, vague, compound, conflicting, outdated, no code found), each row with the original text, marked M level and collapsed by default. "necessary / correct / feasible" are the product owner's concern and stay out of the tester report.

### 3.2 Design health

| Source | Content |
|---|---|
| ISO/IEC 25010 maintainability | modularity, reusability, analysability, modifiability, testability ([TMap](https://www.tmap.net/wiki/quality-characteristics-iso25010/)) |
| ISO/IEC 5055 (CISQ) | 138 CWEs: Security 73, Reliability 74, Performance 18, Maintainability 29 (including excessive coupling, cross-layer calls, dead code) ([CISQ](https://www.it-cisq.org/?p=486)) |
| Martin package metrics | I = Ce/(Ca+Ce), A = share of abstract types, D = \|A + I − 1\|; no evidence found that D predicts defects |
| ArchUnit / dependency-cruiser | Layering rules, onion architecture, `beFreeOfCycles()`, `no-circular` ([ArchUnit](https://www.archunit.org/userguide/html/000_Index.html)) |
| Fitness function | "An objective integrity assessment of some architectural characteristic" ([Building Evolutionary Architectures](https://oreilly.com/library/view/building-evolutionary-architectures/9781491986356/ch02.html)) |
| CodeScene Code Health | 25+ factors, score 1–10 (≥9 healthy, 4–9 warning, <4 alert); vendor study: red code has 15 times more defects and 124% slower development ([Tornhill & Borg 2022](https://arxiv.org/pdf/2203.04374), vendor authors) |
| SonarQube | Technical debt ratio = remediation cost / (cost per line × lines), default 30 minutes per line; A ≤5%, B 6–10%, C 11–20%, D 21–50%, E >50% ([Sonar](https://docs.sonarsource.com/sonarqube-server/10.4/user-guide/metric-definitions)) |
| Google design docs / ADR | Large projects 10–20 pages, small ones 1–3 pages; ADR 1–2 pages: Context, Decision, Status, Consequences ([Ubl](https://www.industrialempathy.com/posts/design-docs-at-google/), [Nygard](https://cognitect.com/blog/2011/11/15/documenting-architecture-decisions)) |

What predicts defects:
- **Dependency network:** On Windows Server 2003, dependency-network metrics had 10 percentage points higher recall than complexity metrics and found 60% of the critical binaries ([Zimmermann & Nagappan ICSE 2008](https://www.microsoft.com/en-us/research/publication/predicting-defects-using-network-analysis-on-dependency-graphs/)).
- **Cyclic dependencies:** The components with the most and the most severe defects concentrate in cyclic dependencies ([Oyetoyan et al.](https://ntnuopen.ntnu.no/ntnu-xmlui/handle/11250/297522)).
- **Relative churn:** 89% accuracy at separating fault-prone binaries ([Nagappan & Ball ICSE 2005](https://microsoft.com/en-us/research/?p=151819)).
- **Organizational structure:** On Vista, precision and recall of about 85%, beating churn, complexity, coverage and dependency metrics ([MSR](https://www.microsoft.com/en-us/research/publication/the-influence-of-organizational-structure-on-software-quality-an-empirical-case-study/)).
- **Counterexample:** After controlling for class size, OO metrics no longer correlate with defects ([El Emam et al. TSE 2001](https://neverworkintheory.org/2011/07/07/the-confounding-effect-of-class-size-on-the-validity-of-object-oriented-metrics.html)).
- **Counterexample:** None of Google's 117 code metrics predicted engineer-perceived technical debt, explaining less than 1% of the variance ([DX summary](https://newsletter.getdx.com/p/measuring-and-managing-tech-debt) *(secondary)*).

**Impact on the template:** No overall design score (Google's own data shows metric scores do not match how people feel). Keep only the two items that have defect evidence and can be checked deterministically: cyclic dependencies and the layering rules stated in the design document (S level). Add the "design ↔ code mismatch" and "component has no tests" that testers care about. Risk ranking uses churn and fix commits (the existing `audit-units.js` already does this, backed by Nagappan's evidence); CODEOWNERS is used both for assignment and as a risk signal.

### 3.3 How coverage is computed

**Kinds**
- **Line / statement:** Google mainly uses line coverage, plus branch coverage for C++, Java and Python.
- **Delta coverage:** Only added or modified lines; Codecov calls it patch coverage.
- **Flags:** Codecov uses flags to split reports by test type ([Google FSE 2019](https://homes.cs.washington.edu/~rjust/publ/google_coverage_fse_2019.pdf), [Codecov flags](https://docs.codecov.com/docs/flags)).

**Thresholds**
- **Project level:** Google's 2020 recommendation is 60% acceptable, 75% commendable, 90% exemplary.
- **Per commit:** 99% is reasonable and 90% is a good lower bound; going above 90% at project level is "probably not worth it" ([Testing Blog 2020](https://testing.googleblog.com/2020/08/code-coverage-best-practices.html)).

**Google practice (FSE 2019)**
- **Scale:** About 1 billion lines per day; the median project has about 80% coverage.
- **Usage:** 45% of developers often look at coverage while writing code, and 40% while reviewing. Only 0.5% run coverage manually each day; showing it automatically in code review is why it gets used.
- **Scope:** The paper counts only single-machine "unit" tests and says line coverage is "not suitable" for integration tests.

**Compute coverage from small tests only**
- SWE at Google chapter 11: "measure coverage with small tests only, to avoid inflated coverage".
- A threshold becomes a ceiling: set an 80% threshold and engineers treat 80% as the goal ([SWE book ch.11](https://abseil.io/resources/swe-book/html/ch11.html)).

**Requirement coverage (safety standards)**
- **DO-178C:** Do requirements-based testing first, then use those tests to measure structural coverage.
- **Four ways to handle a gap:** add tests, change the requirement, delete dead code, mark it as deactivated code ([LDRA](https://ldra.com/ldra-blog/do-178c-structural-coverage-analysis/)).
- **ISO 26262-6:** Requirements-based testing is highly recommended for all ASILs.
- **Formula:** "number of requirements with at least one traced, passing test / total number of requirements". This is an inference; the original standard text is UNVERIFIED.

**Levels and proportions**
- **Size and scope are two independent axes.** Size is about resources: small is one process, medium is one machine, large is multiple machines; scope is the range of code being verified ([SWE book ch.11](https://abseil.io/resources/swe-book/html/ch11.html)).
- **SWE book proportions:** about 80% unit / 15% integration / 5% E2E (by number of cases).
- **2015 blog proportions:** 70/20/10 ([Testing Blog 2015](https://testing.googleblog.com/2015/04/just-say-no-to-more-end-to-end-tests.html)).
- **Other shapes:** Pyramid (Fowler), Trophy (Dodds, integration-heavy), Honeycomb (Spotify, integration-heavy). Fowler notes that the disagreement is mostly about how "unit" is defined ([test shapes](https://martinfowler.com/articles/2021-test-shapes.html)).

**Relationship between coverage and defects**
- After controlling for test suite size, coverage and test effectiveness are only low to moderately correlated ([Inozemtseva & Holmes ICSE 2014](https://cs.ubc.ca/~rtholmes/papers/icse_2014_inozemtseva.pdf)).
- On real defects, the correlation is moderate to strong ([Kochhar SANER 2015](https://ink.library.smu.edu.sg/sis_research/2974)).
- 100 Java projects: not significant at project level, no correlation at file level ([Kochhar 2017](https://www.microsoft.com/en-us/research/publication/code-coverage-and-post-release-defects-a-large-scale-study-on-open-source-projects/)).
- Consistent with our E1 result: coverage gaps cannot predict where the bugs are.

**Impact on the template:**
1. Unit coverage uses only unit reports (Google's approach); lines run by E2E do not count as unit-tested, which is exactly where "placement" findings come from.
2. Coverage is reported only as the fact "no test ran this line", never as "low coverage = more defects".
3. The gate looks at new code (patch), not the project total, so Top action 7 is "add a new-code gate".
4. The 60/75/90 tiers are not shown in the report, so that thresholds do not become ceilings.
5. Level proportions (80/15/5) are background only, not a verdict. Claims about different "shapes" conflict with each other and depend on the definition of unit.
6. The level order the user asked for runs by scope from narrow to wide: Unit → Component → Integration → Contract → E2E.

### 3.4 Unit test quality

**Google mutation testing 2018** ([PDF](https://web.eecs.umich.edu/~weimerw/2022-481W/readings/mutation-google.pdf))
- Done on the diff only, at most 1 mutant per line, skipping uncovered lines and "arid" lines.
- About 6,000 engineers used it; 70,000 diffs, 1.1M mutants.
- **After suppressing arid nodes, the "useful" rate rose from 20% to 80%.**

**Google mutation testing 2021** ([Petrović et al. ICSE 2021](https://ar5iv.labs.arxiv.org/html/2103.07189))
- At most 7 mutants are shown per file in review.
- The more mutants engineers engaged with, the more tests they wrote (rs = 0.9).
- Of 1,502 high-priority bugs, about 70% were coupled with a mutant that would have been reported at the time.

**Test smells**
- tsDetect: 19 smells, 96% precision and 97% recall on its benchmark ([Peruma FSE 2020](https://2020.esec-fse.org/details/esecfse-2020-tool-demos/4/tsDetect-An-Open-Source-Test-Smells-Detection-Tool)).
- Tests with smells change more often and are more defect-prone; the most important are Indirect Testing, Eager Test and Assertion Roulette ([Spadini ICSME 2018](https://research.tudelft.nl/en/publications/on-the-relation-of-test-smells-to-software-code-quality/)).
- But tools and developers' judgement differ widely ([Panichella EMSE 2022](https://pure.tudelft.nl/ws/portalfiles/portal/137994226/s10664_022_10207_5.pdf)).

**Flaky**
- **Google 2016:** 1.5% of runs are flaky, about 16% of tests have been flaky; 84% of pass→fail transitions involve flaky tests ([Micco](https://testing.googleblog.com/2016/05/flaky-tests-at-google-and-how-we.html)).
- **Meta:** Each test has a probabilistic flakiness score; the unit baseline is <1% and some E2E frameworks are around 10% ([Meta](https://engineering.fb.com/2020/12/10/developer-tools/probabilistic-flakiness/)).
- **Microsoft:** After quarantine, the test still runs but its result is suppressed, and the quarantine lifts automatically once the bug is closed *(secondary)*.

**Deleting tests**
- Of the 5.5M affected tests in Google TAP, only 63K ever failed ([Memon ICSE-SEIP 2017](https://research.google/pubs/taming-google-scale-continuous-testing/)).
- Meta's predictive test selection runs only about 1/3 of the tests and still reports >99.9% of bad changes ([Meta](https://engineering.fb.com/developer-tools/predictive-test-selection/)).
- No public "delete tests" policy from a large company was found (UNVERIFIED).

**Impact on the template:**
1. "Test strength" can only be answered by mutation; Google's experience is a per-file cap plus suppressing meaningless locations. Without mutation, write "not measured".
2. Static smells report only the high-certainty ones (no assertions, existence-only assertions, mocked subject under test, long-term skip), which are close relatives of Indirect Testing and Assertion Roulette.
3. Report flaky as a ratio ("4 of 71 runs"), not as yes or no, and account for each level's noise floor: a single red E2E run proves nothing.
4. **"Never failed" is not a reason to delete** (63K/5.5M). Deletion targets only tests with zero protection (no assertions, long-term skip, mocked subject under test).

### 3.5 CI checks

| Source | Content |
|---|---|
| SonarQube "Sonar way" gate (new code only) | No new issues, all new security hotspots reviewed, coverage ≥80.0%, duplication ≤3.0%; coverage and duplication are not checked when fewer than 20 lines are added ([Sonar](https://docs.sonarsource.com/sonarqube-community-build/quality-standards-administration/managing-quality-gates/introduction-to-quality-gates)) |
| OpenSSF Scorecard risk levels | Critical: Dangerous-Workflow, Webhooks; High: Binary-Artifacts, Branch-Protection, Code-Review, Dependency-Update-Tool, Maintained, Signed-Releases, Token-Permissions, Vulnerabilities; Medium: Fuzzing, Packaging, Pinned-Dependencies, SAST, SBOM, Security-Policy; Low: CI-Tests, CII-Best-Practices, Contributors, License ([checks.md](https://github.com/ossf/scorecard/blob/main/docs/checks.md)) |
| SLSA v1.0 Build | L1 has provenance; L2 hosted build + signed provenance; L3 hardened, isolated build ([slsa.dev](https://slsa.dev/spec/v1.0/levels)) |
| DORA (now 5 metrics) | change lead time, deployment frequency, failed deployment recovery time, change fail rate, deployment rework rate ([dora.dev](https://dora.dev/guides/dora-metrics/)) |
| CI health | Uber's iOS trunk was green only 52% of the time before SubmitQueue *(secondary)*; "time-to-green" has no standard definition (UNVERIFIED) |

**Impact on the template:**
1. The CI section is test-centred: do tests at each level run on PRs, are there test files that no job runs, do retries mask failures, is there a new-code coverage gate (Sonar's 80% + 20-line exemption as a reference).
2. In Scorecard, the items relevant to testers are CI-Tests and Branch-Protection; the other security items take one line: "yes/no/cannot read".
3. DORA and SLSA stay out of the tester report: they measure delivery and supply chain, and testers would not change tests because of them.

### 3.6 Presentation and actionability (the most important)

**Google (Sadowski et al. CACM 2018)** ([PDF](https://6826.csail.mit.edu/2020/papers/google-analysis-cacm.pdf))
- **Definition:** A finding on which developers take no positive action is an "effective false positive".
- **The 2006 FindBugs nightly dashboard** was barely used because it sat outside developers' daily workflow.
- **The 2009 fixit:** 3,954 warnings reviewed, 44% led to a bug report, only 16% were fixed.
- **Checks admitted into code review must be:** understandable, actionable, easy to fix, effective false positive <10%, significant impact. An analyzer with more than 10% "Not useful" is turned off until fixed.
- **Timing:** 74% of issues found at compile time were judged real problems, versus only 21% for issues in committed code.
- **Codebase-wide fixes:** Sent to owners as patches, 57% positive feedback and 2% negative.

**Meta Infer (Distefano et al. CACM 2019)** ([PDF](https://6826.csail.mit.edu/2020/papers/facebook-infer-cacm.pdf))
- **Batch mode:** Run overnight and assigned to developers, with a false-positive rate <20% but a fix rate still "close to zero".
- **Reporting at diff time:** The same analysis gets a fix rate >70%. The reasons are context-switching cost and ownership.
- **Report only new issues:** Infer identifies new issues with a location-independent bug hash.
- **Counterexample:** Zoncolan's batch mode, used by dedicated security experts, has an action rate >80%. **When the reader is a dedicated triager, batch reports can be effective.**

**Other research**
- **Johnson ICSE 2013:** Developers do not use static analysis mainly because of false positives and how results are presented ([PDF](https://cs.gmu.edu/%7Ejohnsonb/docs/icse2013.pdf)).
- **Coverity open-source data:** Only a median of 36.7% of warnings are actionable; the median fix takes 96 days even though the median fix itself is only 4 lines ([Imtiaz ISSRE 2019](https://www.microsoft.com/en-us/research/?p=690690)).

**Landing pages of comparable tools**
- **SonarQube:** Gate pass/fail comes first, then two tabs, New Code / Overall Code ("Clean as You Code").
- **Codecov PR comment:** coverage delta → affected files → flags.
- **CodeScene:** "Prioritized technical debt" ranked by hotspot (frequently changed × poor health).
- **SARIF:** `baselineState` supports new / unchanged / updated / absent ([SARIF 2.1.0](https://docs.oasis-open.org/sarif/sarif/v2.1.0/sarif-v2.1.0.html)).

**Impact on the template (the most important item in this document):**
1. A repo-wide audit is inherently a batch report, and by Google's and Meta's data, shown to ordinary developers it is almost never fixed. It can work under the same condition as Zoncolan: the reader is a dedicated triager (tester / QA lead) and precision is high enough. Therefore:
   - The top gives the conclusion and "is the evidence complete" first, equivalent to Sonar's gate-first layout.
   - Every action is marked **new / persisting for N scans** (equivalent to SARIF baselineState), and the comparison with last time sits on the first screen.
   - Every action has an owner (CODEOWNERS) and a suggested fix (test draft), matching Google's "sent to the owner as a patch, 57% positive feedback".
   - The list is capped (Top 10, at most 2 per file), matching Google's at most 7 mutants per file.
   - Each category of finding can be marked "not useful", and a category above 10% is turned off, matching Google's rule. This one is a new feature, see §6 R8.
2. In the long run, the most effective thing is to deliver the same findings at PR time (diff time). The value of a repo-wide audit is to establish a baseline and let the QA lead prioritize; it should not replace PR mode.

## 4. Field rules (where each number comes from)

### 4.1 Top

| Field | Source | Rule |
|---|---|---|
| Conclusion line | all findings | `N things to fix`; split into the E/S count and the M count. When the scan is incomplete, change to ⚠️ and state on the same line what was not audited. |
| Evidence used | inputs | One line per kind of evidence: present / absent / does not match this commit (mismatch = not used). |
| Scores | each area | Fixed 9 rows in a fixed order (§4.3): score with numerator and denominator, change since the last scan, evidence level, what to act on, the actions that raise it. Rules in §4.5. |
| Compared with last time | scan state | new / fixed / still open, by finding id. |

### 4.2 Top actions ordering

1. Evidence level: E > S > M (an item with both S and M counts as M).
2. Risk: number of fix commits in the last 180 days, error-handling lines, churn (reusing the risk of `audit-units.js`).
3. Effort: smaller first (add an assertion < add a test < move a group of tests).
4. Capped at 10 items; at most 2 per file, so one large file cannot fill the list.

### 4.3 Area order (the answer to "you decide the order")

Ordered by "the tester can act directly, the evidence is hardest, the further left the lower the cost":

1. **Untested code (unit)**: E level, directly yields the tests to write; this is the v1 core goal.
2. **Tests that never run**: E/S level, fixing one line of configuration restores a batch of protection; the highest payoff and the easiest to overlook.
3. **Unit test quality**: mostly S level (no assertions, truthy-only assertions, skip, mocked subject under test); flaky comes from CI (E).
4. **Test placement**: the core shift-left action (push down), S+M.
5. **Requirement coverage**: M level (model maps requirement → test).
6. **Requirement health**: M level; it is the tester's concern only when it blocks writing tests ("untestable").
7. **Design coverage and health**: most repos lack documents; structural problems (cycles, layering violations) are S level but not the tester's main action.
8. **CI checks**: last, as detail, but "tests that do not run" is already raised in row 2.

Order of the coverage levels: Unit → Component → Integration → Contract → End-to-end. Reason: the lower the level the cheaper, faster and more deterministic; the goal of shift-left is to put whatever can be proven on the left on the left. Contract has its own row because it is the most common gap in service-to-service calls and is usually 0.

### 4.4 Sections

| Section | Rows | Evidence | Rule |
|---|---|---|---|
| Untested code | one row per definition | E (unit flag coverage) | Use only the unit report; lines run by integration/E2E are noted in the "Also run by" column but still count as unit gaps. The report's commit must equal the audited commit. Files not in the report are counted separately with the reason (excluded by config / unknown). Reuse the not-worth-testing filter and ordering from #430/#433. |
| Coverage by level | one row per level | S (inventory) + E (coverage) | Test layering rule: runner config > directory > file-name suffix; the rule is visible. No report for that level → "not measured". "Runs on PRs" comes from workflow files + recent check runs. |
| Unit test quality | one row per test | S / E | No assertions (including a cross-function check for assertions inside helpers), existence-only assertions, skip days (git blame), mocked module under test, flaky (number of passes after retry in CI / total runs), suspected duplicates (identical after normalizing the test body). |
| Test placement | one row per rule | S + M | Push-down candidates: multiple cases in a higher-level test that only change input data + the pure-function seam they call (S finds the seam, M judges whether it is the same rule). Push-up candidates: tests placed in a unit directory but using a real network/database (S: imports and calls). |
| Requirement coverage | status buckets + gap rows | M (citations verified) | Reuse the trace statuses; "only above unit level" comes from `class: higher_level`. Denominator = number of requirement blocks in the documents, fixed. |
| Requirement health | one row per problem | M | Dimensions: verifiable, unambiguous, singular, complete, consistent (across documents), current (references a removed feature), traceable (no code found). |
| Design coverage | one row per component | S + M | Components come from the design document's headings/lists; the code location is given by the model and verified to exist; test level as above. Structural checks: cycles in the import graph, layering rules stated in the design document. |
| CI checks | fixed check items | S / E | Read workflow files and check runs (read-only API). Cannot read = ❔, does not count as passing. |
| Method and precision | fixed paragraph | — | Measured precision of each kind of finding (from our own evals); write "not yet measured" for those not measured. |

### 4.5 Scores

Every score obeys five rules, derived from §1:

1. **Fixed denominator** from the files at this commit (or the CI window). The model answering less cannot raise a score.
2. **Evidence level shown.** A score from static rules is never presented as if it came from execution.
3. **Movable by a listed fix.** Each row names the Top actions that raise it; a score no fix can move is not shown.
4. **"Not measured" is not 0% or 100%.** Without the input (coverage flag, CI history, documents) the row says "not measured" or "no design document" and drops out of the ranking.
5. **No targets, no bands, no composite.** Only the change since the last scan is shown.

| Score | Numerator / denominator | Level | Not shown when |
|---|---|---|---|
| Unit test coverage | lines (and branches) the unit report marks executed / executable lines in scope in that report; files missing from the report are counted separately | E | no unit coverage report for this commit |
| Tests run on every PR | tests in files that some job runs on `pull_request` / all tests in the inventory | S E | no workflow files |
| Unit tests free of known defects | unit + component tests with no rule finding (no assertion, existence-only, mocks the code under test, skipped > 90 days, flaky in the CI window, duplicate) / unit + component tests | S E | no unit tests |
| Rules tested at the lowest level | requirements or rules with a unit seam that a unit test checks / requirements or rules with a unit seam | S M | no requirements and no placement candidates |
| Requirement coverage | requirements fully tested at any level / all requirement blocks (untestable ones stay in the denominator, so clarifying them raises the score) | M | no requirement documents |
| Requirement health | requirements that pass every check (verifiable, unambiguous, singular, complete, consistent, current, traceable) / all requirement blocks | M | no requirement documents |
| Design coverage | design components with a verified code location and a test at the expected level / design components | S M | no design document |
| Design structure | modules (top-level source folders) in no dependency cycle and no stated layer violation / modules | S | always shown (cycles need no document; layer rules need one) |
| CI protections | protections in place / protections the token can read (fixed list of 8; unreadable ones are listed as unknown and left out of both numbers) | S | no workflow files |

Percentages are rounded to whole numbers except coverage (one decimal, as coverage tools show it); the numerator and denominator are always shown next to the percentage.

## 5. Unknown unknowns: things both testers and report designers easily miss

1. **Tests exist but never run.** The runner's include rule does not match them, the job runs only nightly or on main, or `describe.skip` wraps the whole file. Neither the coverage report nor the test count shows it; it is visible only when workflow + runner config + test files are put together. Our own CI missed running the eval/replay, eval/f2p and eval/mutation tests (#432).
2. **The coverage report and the code are not the same commit.** An old report reports already-fixed gaps as gaps. Rule: if the commit does not match, do not use it (#434 already verifies the Codecov sha).
3. **"Not in the report" ≠ "covered".** Coverage tool configuration excludes files (generated code, some directories), and those files do not exist in the percentage at all.
4. **Lines run by E2E make unit coverage look higher** if all levels are merged into one report. Only per-level flags allow saying "unit gap".
5. **Retries mask flaky tests.** `retry: 2` turns CI green; flakiness is visible only in the "passed after retry" records.
6. **Skipped tests count as passing in statistics.** A long-term skipped test gives zero protection but looks like a test exists.
7. **Tests that mock the subject under test**, and snapshot-only tests: both pass, with zero or near-zero protection.
8. **Test layering itself is a guess.** Directory names, file suffixes and runner config can contradict each other; the report must give its rules, or readers will not trust the level statistics.
9. **Which is the truth, the requirement document or the code?** The document may describe a removed feature, or the code may have drifted from the document. The report can only say "inconsistent" and let the owner decide; it cannot automatically conclude the code is wrong.
10. **Non-functional requirements (performance, security) cannot be proven with unit tests.** They should not count as unit gaps; they should point to the right level or be marked "needs numbers to be testable".
11. **Model output is unstable** (A1 Jaccard 0.17): two scans give different lists, and the reader will think the code changed. M-level findings need to be reported in both runs before being promoted (the existing confirmed mechanism).
12. **Nobody reads bulk reports.** With no owner, no diff against last time, and a list that is too long, the report gets ignored.
13. **Budget truncation**: when the scan did not finish, "no problems found" is a false negative. The top must state clearly what was not audited.
14. **Monorepo**: each package has its own runner and coverage, so a merged percentage is meaningless; group by package.
15. **Cross-repo contracts**: the consumer-side contract tests live in another repo, so "no contract test" in this repo is not necessarily a gap.
16. **Thresholds become ceilings**: showing "80% reached" in the report makes the team stop at 80% (SWE book). The report only says which lines did not run and gives no grade.
17. **Small-change exemption**: for fewer than 20 added lines, a percentage gate is meaningless (Sonar's fudge factor).
18. **Tools treat generated code differently**: JaCoCo silently filters classes with a `Generated` annotation ([JaCoCo](https://www.jacoco.org/jacoco/trunk/doc/changes.html)), so numbers change when the tool changes.
19. **The coverage run itself can fail**: instrumentation causes timeouts, OOM and more flakiness (Google FSE 2019). With no report, write "not measured", not 0%.
20. **"Never failed" does not mean low value**: only 63K of Google's 5.5M tests ever failed.
21. **One noisy section can sink trust in the whole report**: ignoring flaky alerts is "only human" (Google 2016). M-level sections are collapsed by default precisely so they do not drag down E-level findings.
22. **Test size and scope are different things**: a narrow-scope UI test may need a browser (large), and a wide-scope test may still be small. Layering by directory gets some of them wrong, so the layering rules must be visible.

## 6. Gaps against the current implementation and the implementation order

Problems with the current scan summary (`src/audit-post.js` `render()`; the A1 self-audit output is in SpecGuard-evidence/a1-self-audit):

- The first screen is a funnel line ("31 eligible = 31 inventoried; 31 selected = 3 reviewed whole + 28 forced (recorded unsure)") that testers cannot parse and that changes no action. It should move into Details.
- The 52 "Static test signals" rows aggregate test-file-level numbers per unit and do not point to a specific test, so the reader cannot act.
- There are no evidence levels, no owners, no Scores table and no CI section.

Implementation order (each step needs a matching eval, owner rule of 10-18):

| Step | Content | Evidence level | Depends on |
|---|---|---|---|
| R1 | New skeleton: conclusion line, Evidence used, Scores, Top actions, collapsed sections; map existing findings into it | — | None; pure rendering, can be compared by replaying existing audit.json |
| R2 | Attribute quality signals to the test and remove the per-unit duplication | S | test-map |
| R3 | Tests that never run: cross workflow + runner config + test files | S | New module, read-only |
| R4 | CI section: check-runs history (passed after retry, whether each level runs on PRs) | E | Read-only API |
| R5 | Per-level coverage (Codecov flags) | E | #434 |
| R6 | Placement push-down candidates (S finds the seam + M judges) | S M | trace |
| R7 | Requirement health, Design coverage | M | Precision must be measured first (judge calibration) |
| R8 | Each action can be marked "not useful" (a command or checkbox in the scan issue); a category whose not-useful rate exceeds 10% is turned off by default (Google's rule) | — | scan issue state |

R1–R5 do not depend on the model and can ship first; R6 and R7 stay collapsed by default until their precision is measured, and the method paragraph says "not yet measured".
