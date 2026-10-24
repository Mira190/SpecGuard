# Handoff: a first-principles critique of the goal and the "requirement ↔ code two-way traceability" positioning

Date: 2026-10-09. Branch: `experiment/trace-local-eval` (HEAD `eaa60ce`).
Nature: analysis only, no runtime code changes. The reader is the next session that takes over.

## 0. Handoff notes

**Read this section first, then the rest.**

1. **The pasted content in the user's original message did not arrive.** The user's message says `[Pasted text #7 +3 lines]`, and the body was not transmitted. Inferring from the repository, it is most likely the truncated list of constraints in the two-way traceability requirement (`docs/traceability-plan.md:12`: "requirements may live in `docs/`, `specs/`, Gherkin, or Git…"). **The first thing to do after taking over: ask the user to paste it again.** If constraint 3 onward differ from what this document infers, §4 and §6 must be reordered.
2. The user's position: **quality engineering (QE)**. The goal is a GitHub Action that does code review, for the purpose of **shift-left**.
3. This document does not repeat `docs/goal-first-principles.md` (the R–C–T triangle, the 12-row state matrix, U1–U20). It reviews the **premises of that analysis itself**, and then compares them against data measured in the repository. Newly found blind spots are numbered **N1–N18**, without clashing with the U numbers.
4. Working conventions (from the user's memory):
   - Implementation code is written by a Sonnet sub-agent; the main session writes the specs and does the review.
   - No AI attribution in PRs, commits, or issues.
   - Briefs for parallel agents forbid `git stash/checkout/reset/restore/clean`; ownership is partitioned by file, or worktrees are used instead.
5. Must-read files, in priority order:

| File | Why read it |
|---|---|
| `docs/design.md` §0 (original goal text), Status, §9–§11, the Evaluation findings at the end | The original goal text, what has been verified, and approaches explicitly rejected |
| `docs/goal-first-principles.md` | The subject of this document's critique |
| `docs/traceability-plan.md` §0, §1, §4.0, §7 | The design and evaluation plan for two-way traceability |
| `docs/competitors/head-to-head.md` | The only head-to-head comparison on real defects |
| `docs/field-study.md` §3.4, §7 | Noise of requirement-document discovery on real repositories |
| `docs/token-anatomy.md` | Cost structure |
| `eval/replay/holdout-pairs.json`, `eval/replay/README.md` | Category distribution of real defects |

## 1. Conclusions

1. **The objective function has never been written down.** For QE, the value of shift-left is roughly:
   > number of defects that could have been found at the PR × proportion the developer actually fixed × (cost of finding it in QA or production − cost of finding it at the PR) − noise, latency, and token cost

   The repository has plenty of detection mechanisms, but the other terms (the upper bound of the detectable proportion, the actual fix rate, cost, latency) have **all not been measured** in real use. The next step should be to measure these first, and only then keep adding mechanisms (§2).
2. **The argument for two-way traceability was enumerated, not weighted by frequency.** The 12-row state matrix says "what can go wrong when CI is green", but not "how common each case is". The repository's own data:
   - In head-to-head, **all direct hits came from test gaps between the code and sibling paths, and none from spec comparison**;
   - Of the 13 pairs of confirmed in-scope defects in the replay pool, `requirement_mismatch` has only 2 pairs, and they are the **same orpc mechanism**;
   - The R in these two pairs is **a merge rule written by the PR itself**, not a numeric value in a spec document (§3 C2).
3. **The traceability feature is on by default (`trace: auto`), yet no live evaluation has ever been done.** The live eval of tr1–tr17 has not been run (`docs/design.md:432`), and the plan's own threshold is precision ≥90%. Having a never-measured feature on by default conflicts with the repository's principle of "measure first, then upgrade" (§3 C4).
4. **Only one reading of the original requirement was adopted.** "coding standard has been confirmed" and "review requirements" both have more literal, cheaper readings: whether the author ticked a confirmation item; whether the requirement itself is testable. Neither reading has been confirmed with the user (N9, N10).
5. **The core path has never run in a real adopter's repository.** The S6 pilot ran only once, on a personal repository; org billing and the Claude engine are both unverified; head-to-head used a Sonnet sub-agent, while the production default is Copilot `auto`. All existing evidence is offline simulation (§3 C7, C8).
6. **The biggest unknown unknowns are at the system boundary, not in the algorithms:**
   - PRs written by AI are skipped by preflight (N1);
   - tests that a coding agent adds in response to `missing_test` are mirror tests, which "launder" a finding into `covered` (N2);
   - every push triggers a full re-review (N3);
   - unstable results, combined with `resolve_stale` auto-closing threads, make threads open and close repeatedly (N4);
   - QE itself gets no aggregate view (N11).
7. **The suggested next step is a zero-code experiment:** the user takes the most recent 50 QA or production defects from their own defect system and classifies them using the table in §6 P0-1. This step determines the upper bound and also which axis to invest in. Before it, do not add more traceability mechanisms.

## 2. First principles: the shift-left objective function from the QE perspective

| Factor | Question | Current evidence | Status |
|---|---|---|---|
| **Upper bound F** | Of the user's QA or production defects, how many can be seen statically at PR time (logic, boundary, validation, requirement mismatch, test gap)? | Only OSS library data: 63 of the 69 pairs in the holdout pool are `scope=in`. Library projects are mostly logic, and the sample has selection bias | **Unknown for the user's repositories** |
| **Detection D** | How many in-scope defects are hit? | head-to-head: lean 7/12, copilot style 8/12, pocock style 9/12. n=12, the gaps are within noise | Recall is not an advantage |
| **Action A** | After a hit, how many did the developer actually fix? | Only the proxy metric `would_fix` given by the judge: lean 13/22=59%. did-fix has never been measured | **Not measured** |
| **Cost difference ΔC** | How much is saved by finding at the PR rather than in QA? | "1:100" is a leprechaun (`goal-first-principles.md` §3). What is saved is mainly QA rounds and feedback cycles, and the size depends on where QA sits in the pipeline (N6) | **Undefined** |
| **Cost K** | Noise, slower PRs, tokens, compliance | About 559k cumulative input tokens per run (simulated value), about 50% more than free-form review; time-to-merge has never been measured; re-runs on every push (N3) | Partly measured |

Inferences:
- **Net value = F·D·A·ΔC − K**. Currently only D has data, and it is offline data.
- Every later piece of work should answer: which factor does it change, and by how much. The traceability feature changes the small "requirement mismatch" part of D, and the share of that part itself (its share within F) has not been measured by anyone.
- This formula also says SpecGuard should make **A as high and K as low as possible**, rather than pursuing the highest D. This is consistent with the head-to-head conclusion: the advantage is in precision, not recall.

## 3. Critique of the existing analysis

### C1 Enumerating the state space ≠ frequency weighting

The matrix in `goal-first-principles.md` §2 is right as an **evaluation coverage checklist**: every row should have a test case. But it was used as the **basis for investment priority** ("two-way traceability is not an add-on feature").

What should decide priority is *Σ state frequency × cost of the defect in that state*. The frequency evidence already in the repository all points the opposite way:
- head-to-head: traceability contributed 0 direct hits.
- holdout pool: of the 13 confirmed in-scope pairs, logic 8, validation 3, requirement_mismatch 2. These 2 pairs are one mechanism (`orpc-2098<-1705`, `<-1718`).
- field study: 7 of the 12 repositories have no requirement document at all.

None of these three sets of data represents the user's repositories, but they are the **only** frequency data in the repository, and they point in the same direction.

### C2 The real shape of a "requirement mismatch" differs from the mechanism's assumption

The traceability v1 mechanism was designed around "a numeric value in a spec document was changed": `deltas`, an occurrence table with unit variants, 30→45, 2×→3×. The seeded cases tr1–tr17 are also almost all numeric literals.

The real requirement mismatches in the replay pool look different:
- `orpc-2098`: "Code disagrees with the **PR's own documented merge rule**".
- `orpc-2057`: "Schema requires a field the handler never sends".

In both, R is **in the same PR or in adjacent code** (a rule the PR wrote, a doc comment, a schema), at the semantic level, not numeric.

**Hypothesis to verify:** In PRs like these, was R dropped by our own collector? Non-requirement `.md` changes are still removed from the diff by `collect.sh`. If a PR wrote the rule in `docs/` and implemented it wrongly in code, then R happens to lie exactly in the part that is removed. The person taking over should check these three cases, to see which file R actually lives in and whether the collector kept it.

**Construct validity problem:** The seeded cases only cover the forms the mechanism is good at, so even if all tr cases pass, that cannot prove effectiveness on real requirement mismatches.

### C3 The theory is self-consistent, the data points the other way, yet the conclusion did not change

Section 5 at the end of `design.md` already wrote "Traceability value is not proven on real repos", and head-to-head also suggested "tighten `trace: auto` to strong signals". But the default is still `auto`, and what is queued later in the plan is still WP7 mutation benchmark and WP8 SZZ (more traceability evaluation), rather than first validating the core path.

**It was found, but the decision was not changed accordingly.** This is the point this document most wants to correct.

### C4 A default-on feature violates the repository's own threshold

- Threshold: `traceability-plan.md` §7.2 requires precision ≥90% and recall ≥80%.
- Current state: the live evaluation has never been run.
- The precision after the discovery fix (strict 66%) comes from an **uncommitted copy of the harness** and cannot be reproduced from the repository (`field-study.md` §7).
- Risk: an adopter's first encounter with SpecGuard may be a noisy `spec_mismatch`. Requirement-type comments are already the class with the lowest adoption rate (RevMate: functional suggestions 5.2%).

### C5 The frame of reference for "shift-left" is undefined

"Left" is relative to QA. Where QA sits in the pipeline decides whether SpecGuard is really earlier:
- QA tests the post-merge staging build: the PR moment is indeed earlier.
- QA tests in each PR's preview environment: SpecGuard and QA are at **the same moment**, and the value becomes "save QA time" rather than "earlier".

There are also points further left than the PR: local pre-push (the repository already supports running the same skill with `claude -p` / `copilot -p`); further left still is when requirements are being written (N10). None of these points has been designed or measured as a product surface.

### C6 Only one reading of the original requirement was taken

See N9 ("confirmed") and N10 ("review requirements"). Both are **for the user alone to decide**, and the repository has no record of the user confirming.

### C7 The evaluation is self-referential

- The subject under test is a Sonnet sub-agent, and the judges are three Sonnet adjudicators, the same family; the gap between two rounds of judging (84% versus 100%) already shows that the variance is large.
- The production default engine is Copilot `auto`, where model routing may differ each time, and real Copilot has never been run in head-to-head.
- Two things have no data at all: the failure rate of the strict JSON contract on the weaker models routed to (that is, the proportion where the summary shows "Could not complete"), and the agreement rate between adjudicators and human judgment.

### C8 Scope keeps expanding, while core acceptance stalls

The original goal was unit test review. Also under construction or already built: two-way traceability, `spec_mismatch`, blame for historical intent, the occurrence table, SZZ, mutation benchmark, field harness, CCR mode, competitor comparison.

Meanwhile, **S4 (engine, org billing) and S6 (3 pilots) of `design.md` §9 are both unfinished**. None of these expansions can replace a real pilot. By ponytail's standard: **what has been proven valuable so far is exactly the simplest part**, i.e. test-gap review within the diff scope plus deterministic validation.

## 4. Repositioning "two-way localization"

### 4.1 Traceability should be a conditional module, not a default capability

The value of traceability depends on one premise: **whether the team adopts spec-driven development (SDD)**.

| Repository type | Where R is | Value of traceability | Default behavior (suggested) |
|---|---|---|---|
| SDD repository: `.kiro/specs`, `openspec/`, Spec Kit `specs/`, requirements with explicit IDs, `.feature` | In the repository, structured | **Core value**: the AI agent implements per the spec, the spec is R, and scenario B is very common | On |
| Ordinary repository with scattered "must" prose (README, guides) | In documents, but a document is not a requirement | Low. Hits are mostly documentation drift, which the document owner should handle (U17) | **Off**, or summary only |
| R is in Jira, ADO, Confluence (the norm for enterprise QE) | Outside the repository | **Structurally excluded** by the "no new secrets" constraint (N8) | Bring R into the PR via a PR template (§6 P1-1) |

So the trigger condition of `trace: auto` should be tightened from "any requirement document found" to "**a strong signal found**": an SDD directory, items with explicit IDs, Gherkin `.feature`. Generic normative prose does not trigger it by default. This needs the user's decision (§7 Q2).

### 4.2 Reorder the sources of R by cost and precision

| Rank | Source | Cost | Precision | Current state |
|---|---|---|---|---|
| 1 | **The PR's own statements**: PR body, documents changed in the same PR, docstrings, schemas | 0 (already at hand) | High: what the author says himself | The PR body is already collected; non-requirement `.md` in the same PR is discarded (the hypothesis of C2) |
| 2 | **The AC section in the PR template** (a process change, no code) | 0 code | High | `extractCriteria` can already recognize AC headings; what is missing is the template itself and promotion |
| 3 | Linked issue | Low | Medium to high | Implemented, but many PRs do not link an issue |
| 4 | SDD spec directory, items with explicit IDs | Medium | Medium to high | Implemented, mixed into generalized discovery |
| 5 | Generic normative prose | High (noise) | Low (field study) | On by default, suggest downgrading |
| 6 | Historical intent recovered by blame | Medium | Low (may be outdated) | Implemented, an optional source |

**Key point:** "Moving R capture left" is itself shift-left. Having the author write the AC in the PR is cheaper and more accurate than digging documents out afterwards by heuristics. This is a process lever that QE can push directly, with no code to write.

### 4.3 There is also an ignored "two-way": developer ↔ QA

Currently information flows only from SpecGuard to the developer. The other two directions QE cares about do not exist:
- **To the right, SpecGuard → QA:** tell QA which PRs and which ACs have only `needs_human`, `higher_level_only`, or `unknown`, so QA can do risk-based testing. There is currently no aggregate output (N11).
- **To the left, QA → SpecGuard:** escaped defects flow back as evaluation samples and rules (SZZ is the offline way). There is currently no routine mechanism.

For QE, this loop may be more valuable than the two-way between requirements and code. Whether to include it in scope is the user's decision (§7 Q5).

## 5. Newly found unknown unknowns (N1–N18)

Perspectives: ⑧ system boundary (interaction with other tools and agents), ⑨ economics, ⑩ organization and process, ⑪ validity of measurement. ①–⑦ continue from `goal-first-principles.md` §4.1.

| ID | Blind spot | Perspective | Impact | Evidence or status | Cheapest verification | Cost |
|---|---|---|---|---|---|---|
| **N1** | **PRs written by AI are skipped.** `preflight.js:15` skips all authors with `type==='Bot'` or `[bot]`. If an agent such as the Copilot coding agent opens PRs as a Bot, then the fastest-growing PR source, and the one most prone to C=T≠R, is exactly the one not reviewed | ⑧ | Recall, coverage | Code verified; the agent's PR author type is **not verified** | In the user's org, look at the `user.type` of one agent PR. Consider treating agents separately from dependency bots (Dependabot, Renovate) | S |
| **N2** | **Goodhart loop.** A coding agent, or a person in a hurry, adds tests following the skeleton in `missing_test`, copying the expected values from the implementation, and the finding gets "laundered" into `covered`. Conclusion 3 of `goal-first-principles.md` said AI tests tend to cement errors, but did not foresee that **SpecGuard's own comments can trigger this cementing** | ⑧⑪ | Precision: false reassurance | Not measured | The skeleton's expected values must quote the original text of R (when R exists); when R is missing, the skeleton uses placeholders rather than values inferred from code (the G4 placeholder rule already exists and can be reused); add to the evaluation an adversarial case of "mirror tests added per the comment" | S |
| **N3** | **Cost grows with the number of pushes, not the number of PRs.** Every `synchronize` triggers a full re-review, and only the same SHA is skipped. Cumulative input is about 500k tokens per run, mainly from static prompt × number of rounds (`token-anatomy.md`). There is no incremental review | ⑨ | K | Average pushes per PR not measured | Use `gh api` to count the number of pushes per PR in the pilot repository; consider triggering only at `ready_for_review` or when a label is applied, or reviewing only the increment since the last reviewed state | S–M |
| **N4** | **Unstable results × `resolve_stale`.** The same gap is reported this time and not the next, the thread is auto-closed, and then it reappears the time after. Threads opening and closing repeatedly harms trust | ⑧ | Adoption | `resolve_stale` is on by default; U15 only tested stability, not its interaction with auto-close | On the same PR, make 3 empty pushes in a row (`force: true`), and count thread open/close events | S |
| **N5** | **The PR is already merged when the review arrives.** When auto-merge is on, the merge happens as soon as CI is green, and SpecGuard, which takes up to 12 minutes, may arrive late | ⑩ | A=0 | Not measured | In the pilot, record the proportion where "comment time is later than merge time" | S |
| **N6** | **Where QA sits in the pipeline** (see C5), which determines the size of ΔC and whether "shift-left" holds | ⑩ | The whole value proposition | Unknown | Ask the user | 0 |
| **N7** | **The upper bound F varies by organization.** About 91% of OSS library defects are in scope; among a web application's QA defects, UI, integration, and environment types may be the majority | ⑩⑪ | Value upper bound | Only OSS data | §6 P0-1: classification of 50 defects | 0 code |
| **N8** | **An enterprise's R is outside the repository** (Jira, ADO, Confluence), and the constraint "only GitHub Actions, no new secrets" excludes it. The ticket key in the PR title can be obtained, but the ticket body cannot | ⑩ | The requirement axis gets no input in enterprise environments | The constraint comes from the user's words (truncated); `design.md` already rejected ticket key parsing | Ask the user where R is; optional approaches: a PR template (zero secrets), or an optional tracker secret (violates the constraint, needs the user's clearance) | 0 / M |
| **N9** | **The literal reading of "coding standard has been confirmed"**: whether the item "I have followed the coding standard" in the PR template was ticked. This is a deterministic process-compliance check, and a single regex is enough. The current implementation is lint evidence plus AI static review, and does not implement this reading | ⑤ | Conformance to the original requirement | `research-goal-audit.md` only mentioned that "an author checkbox can only count as a human declaration", and never asked the user | Ask the user which of the three readings are wanted (§7 Q3) | S |
| **N10** | **Another reading of "review requirements"**: review whether the requirement itself is testable and unambiguous. This is the most classic left-shift activity for QE (three amigos). The current approach treats R only as an oracle. U10 mentioned it, but filed it under "extending the boundary" | ⑤ | Conformance to the original requirement | Unconfirmed | Ask the user | 0 |
| **N11** | **QE cannot get an aggregate view.** Output is aimed only at developers (inline comments and the sticky summary). QE, as the party paying, needs to see trends by repository or team: gap categories, handling rate, AC coverage, the `needs_human` list. The data actually exists (findings and fingerprints of each run), but is not persisted | ⑩ | Adoption, the reason for continued investment | Not implemented | Minimal approach: upload a `findings.json` artifact on every run, plus an offline aggregation script. No dashboard | S |
| **N12** | **`Unit evidence X/Y` gets treated as a KPI.** Managers will read it as coverage, and once it is used for assessment it will be gamed | ⑪ | Metric distortion | The wording already says it is a static judgment | Add a sentence to the summary "not coverage, not for assessment"; the aggregate view does not display ratio rankings | S |
| **N13** | **Evaluation engine ≠ production engine.** Copilot `auto` routing is uncertain, and the failure rate of strict JSON, the number of rounds, and the timeout rate have not been measured in a real org | ⑪ | D and availability | `design.md` section 9 Open items: "No real Copilot run" | The pilot records the completion status, rounds, and elapsed time of every run | S |
| **N14** | **The definition of test layers and pushdown varies by organization.** The pyramid and trophy strategies already disagree; Pocock's tdd favors integration tests that go through public interfaces. Pushdown may go against the team's testing strategy | ⑤ | Precision | `design.md`: "Pushdown suggestions are not validated" | Read the layer definitions from the repository's standards files; when there is no definition, pushdown goes only to the summary | S |
| **N15** | **Compliance of sending code out.** An enterprise's data policy may directly forbid sending code to Copilot or Anthropic | ⑩ | Whether it can be adopted | `design.md` §12 Q3 has never had an answer | Ask the user | 0 |
| **N16** | **Comments from multiple bots stack up.** Native CCR, SpecGuard, CodeRabbit, and others comment at the same time, with no cross-tool deduplication | ⑧ | K | The trigger condition for peer deduplication is in "Not in v1" | In the pilot, count the total number of bot comments per PR | S |
| **N17** | **Defects SZZ cannot see.** A defect that QA finds at the PR or preview stage and fixes in the same PR never shows up in mainline history. If the user's QA tests at the PR stage, L4 replay exactly misses the target samples of shift-left | ⑪ | Evaluation validity | Not discussed | Combined with N6, sample from the defect system rather than only from git history | 0 |
| **N18** | **`would_fix` ≠ did-fix.** Currently the judge decides "would it be changed". The real fix rate can be computed deterministically: a fingerprint appears at SHA n, disappears at SHA n+1, and its anchor line was modified | ⑪ | Measurement of A | `resolve_stale` already compares fingerprints, but does not record them | Add a fix-through field to the artifact of N11 | S |

**Priority:**
- P0: N6, N7, N8, N9 only need questions to the user or classification, no code, but will change all later decisions.
- P1: N1, N2, N3, N13 decide whether the pilot's conclusion can be trusted.
- P2: the rest, to be decided after the pilot data comes in.

## 6. Suggested order of execution

### P0: first measure the upper bound, then decide where to invest (zero or very little code)

1. **Classify 50 defects (done by the user, with the successor providing the table).** From the user's issue tracker, take the most recent 50 QA or production defects, and fill in the table below for each:

   | Field | Values |
   |---|---|
   | Stage found | PR, QA (before PR / after PR), production |
   | Statically visible | yes / no (reason: environment, integration timing, UI, performance, third party) |
   | Category | logic, boundary, validation, error handling, requirement mismatch, missing test |
   | Was there a written-down R at the time | PR body, issue, spec, none; in which system R lives |
   | Could a unit test have caught it | yes / no / only an integration test could |
   | Can the PR that introduced it be found | yes / no |

   **Decision rules (suggested, to be confirmed by the user):**
   - If the share of "requirement mismatch" with "R written in the repository" is below 10%: make traceability opt-in, and return resources to test gaps and process.
   - If "statically visible" is below 40%: restate SpecGuard's positioning externally (only intercepts logic-type defects), and turn the QE value proposition toward the N11 risk report.
   - If "R in Jira and similar" is the majority: first do the PR template (P1-1), rather than continuing with document discovery.

2. **Decide the default of `trace` (the user decides).** Three options:
   - (a) change to `off`, and those who need it turn it on explicitly;
   - (b) turn on only with a strong signal (SDD directory, explicit ID, `.feature`);
   - (c) keep `auto`.

   We suggest **(b)**, and until the live eval of the tr cases clears the threshold, restrict `spec_mismatch` to the summary only.

3. **Run a pilot (S6) in the user's real repository.** Use the production engine (Copilot), for 2–4 weeks. Record for each run:
   - completion status (N13), number of rounds, elapsed time;
   - whether the comment came after the merge (N5);
   - the number of pushes and runs per PR (N3);
   - the total number of bot comments per PR (N16);
   - fix-through (N18);
   - handling rate and rejection rate by category.

   The only minimal code change needed is the artifact of N11.

### P1: cheap levers

1. **PR template (a process change).** Add an "Acceptance criteria" section, and an "I have followed the coding standard" checkbox (N9, depending on the user's answer).
   - Already there: `extractCriteria` in `requirements.js` can recognize AC headings.
   - To add: the checkbox check is a deterministic regex, with the result written into the Standards section of the summary, labeled as "author declaration" and shown separately from lint evidence.
2. **Verify the hypothesis of C2.** Take the three cases `orpc-2098<-1705`, `<-1718`, `orpc-2057<-1721`, and see whether the file R lives in was dropped by `collect.sh`. If dropped: non-requirement documents changed in the same PR enter the context under the identity of "the PR's own statements", read-only and not reviewed (producing no document-type findings).
3. **Guard against N2.** The skeleton's expected values must come from the original text of R; use placeholders when there is no R. Add an adversarial case to the evaluation: an agent adds a mirror test per the comment, and SpecGuard should not judge it as `covered`.
4. **Control N3.** First get the data on the number of pushes, then choose among three options: trigger only at `ready_for_review`, trigger only when a label is applied, or review only the increment.
5. **Decide N1.** After confirming the author type of agent PRs, set up a separate switch for them.

### P2: do after the pilot has data

- WP7 mutation benchmark, WP8 SZZ replay: do them only after the classification in P0-1 shows that the share of requirement mismatch is high enough. SZZ samples should come from the defect system (N17).
- The aggregate view of N11 as an offline script is enough, with no dashboard.
- Native CCR deduplication, blocking mode: follow the original trigger conditions in `design.md` §11.

### Do not do (until the corresponding threshold is triggered by data)

- Do not add embeddings, tree-sitter, co-change, or index caches (`traceability-plan.md` §8 already made them threshold-triggered upgrades).
- Do not add new traceability finding kinds, and do not extend the tr seeded cases. Until the construct validity problem of C2 is solved, even more seeded cases cannot prove real value.
- Do not announce precision externally based on the results of the Sonnet judge (C7).

## 7. Questions for the user to answer

Ordered from largest to smallest impact; each lists what the answer would change.

| # | Question | What the answer changes |
|---|---|---|
| Q1 | **Please paste the truncated constraint list again (Pasted text #7).** Does "Git…" mean GitHub Issues, the Wiki, or Git history? Is there a constraint 3 after it? | The ordering of §4.2, N8 |
| Q2 | Where is your R mainly written: the PR body, GitHub Issues, specs in the repository, or Jira, ADO, Confluence? Has the team adopted SDD (Kiro, Spec Kit, OpenSpec)? | Whether traceability is a core capability or opt-in; the default of `trace` (P0-2) |
| Q3 | Which does "coding standard has been confirmed" mean: (a) the author ticked a confirmation in the PR template; (b) the lint and format tools passed; (c) the AI reviewed the diff against the standard? Multiple choices are allowed | Whether to do N9; the README wording |
| Q4 | Does "review requirements" include reviewing whether the requirement itself is testable and unambiguous? | Whether N10 and U10 enter scope |
| Q5 | Where QA sits in your pipeline: testing the post-merge staging, or testing each PR's preview environment? As QE, what do you want from the tool: only comments for developers, or also a risk list and trends for QA? | Whether ΔC holds (C5, N6); whether N11 and §4.3 enter scope |
| Q6 | Can you provide the most recent 50 QA or production defects for classification? Can a pilot be run on a real repository? | Whether P0-1 and P0-3 can be executed |
| Q7 | Does the team use a coding agent to open PRs? Should those PRs be reviewed? | N1, N2 |
| Q8 | Does company policy allow sending code to Copilot or Anthropic? | N15, whether it can be adopted |

## 8. Task list for the successor session

| # | Task | Prerequisite | Acceptance |
|---|---|---|---|
| H1 | Give Q1–Q8 of §7 to the user, and write the answers back into §7 of this document | None | Every question has an answer or "unknown", with the date noted |
| H2 | Write the classification table of P0-1 (a CSV template plus filling instructions) and give it to the user | None | The user can fill it in directly |
| H3 | Verify C2: the file R lives in for the three orpc cases, and whether `collect.sh` discarded it | None | Write the conclusion: dropped or not, with the file path |
| H4 | Verify N1: for a PR opened by the Copilot coding agent, what are its `user.type` and `login` | Needs a sample PR | Give the API return values |
| H5 | Based on the answer to Q2, write a spec for changing the default of `trace`; implementation goes to Sonnet | Q2 | The spec states the trigger conditions and the exit for `spec_mismatch` (inline or summary) |
| H6 | Write the minimal artifact spec for N11 plus N18: one JSON per run, containing findings, fingerprint, completion status, number of rounds, elapsed time, merge time | None | The spec goes to Sonnet; the aggregation script has one `node:test` |
| H7 | Based on Q3, write the spec for the PR template and the checkbox check | Q3 | The checkbox result is shown in the summary separately from the lint evidence |
| H8 | Based on Q5 and Q6, draw up the pilot plan (repository, duration, recorded fields) | Q5, Q6 | One-to-one with the fields of P0-3 |

## 9. Verified and not verified

**Verified in this session (code or data was read):**
- The original goal text: `docs/design.md:38-47`.
- The default of `trace` is `auto`: `action.yml:20`.
- preflight skips Bot authors: `src/preflight.js:15`.
- The triggers include `synchronize`, and the repository has no incremental-review code.
- tr live eval not run: `docs/design.md:432`.
- The head-to-head numbers and "traceability contributed 0 direct hits": `docs/competitors/head-to-head.md`.
- Distribution of the holdout pool: 69 pairs, of which the 13 pairs that are confirmed and in-scope are logic 8, validation 3, requirement_mismatch 2; both of these 2 pairs are orpc-2098, with `scope_reason` "Code disagrees with the PR's own documented merge rule". Source: `eval/replay/holdout-pairs.json`.
- The field study's post-fix numbers cannot be reproduced from the committed harness: `docs/field-study.md` §7.

**Not verified; go back to the source and check before citing:**
- The author type of Copilot coding agent PRs (N1).
- Average number of pushes per PR (N3).
- Whether R in C2 was dropped by the collector (H3).
- External research numbers: following those already marked "not verified" in `goal-first-principles.md` §3.
