# Matt Pocock's approach to AI-assisted code review

Research and access date for all URLs: 2026-10-09. Read-only research; nothing here was executed against SpecGuard.
Verification legend: [V] read directly from the primary source; [S] secondary or third-party summary; [U] unverified.

## 0. Plain answer

There is no standalone "code review product". What exists:

- One review skill, `code-review`, in `mattpocock/skills` (MIT, created 2026-02-03, very active; SKILL.md last changed 2026-10-07) [V].
- Sandcastle reviewer prompts that are refactoring-oriented, not gap-finding [V].
- A review philosophy spread across a PR-body skill, `tdd`, `retro`, `codebase-design`, and workshop talks [V/S].

His method: automate a narrow, cited, fresh-context review; keep humans on planning and QA; keep diffs small.

## 1. Inventory of primary sources

| Source | URL | Date | Contains | Reliability |
|---|---|---|---|---|
| `code-review` SKILL.md | https://github.com/mattpocock/skills/blob/main/skills/engineering/code-review/SKILL.md | edited 2026-10-07 | The review recipe: two parallel sub-agents (Standards, Spec), Fowler smell baseline | High, primary |
| `code-review` docs page | https://github.com/mattpocock/skills/blob/main/docs/engineering/code-review.md | current | Rationale, FAQ, known failure modes, "it's working if" checklist | High, primary; candid about flaws |
| `tdd` SKILL.md + tests.md | https://github.com/mattpocock/skills/tree/main/skills/engineering/tdd | current | Test anti-patterns (implementation-coupled, tautological, horizontal slicing), seams | High, primary |
| `pr` SKILL.md | https://github.com/mattpocock/skills/blob/main/skills/engineering/pr/SKILL.md | current | PR body: Summary visual, Evidence (before/after), Merge Danger (one-way/two-way door, blast radius); credited to Dex Horthy's "show-me" | High, primary |
| `retro` SKILL.md | https://github.com/mattpocock/skills/blob/main/skills/engineering/retro/SKILL.md | current | Turns reviewer misses into deterministic checks vs `CODING_STANDARDS.md` rules; "review agent has least context pressure" | High, primary |
| `codebase-design`, `improve-codebase-architecture`, `implement` | https://github.com/mattpocock/skills/tree/main/skills/engineering | current | Deep-module vocabulary, deletion test; whole-codebase review with Strong / Worth exploring / Speculative badges; `implement` calls code-review before commit | High, primary |
| Sandcastle review prompts | https://github.com/mattpocock/sandcastle (`.sandcastle/review-prompt.md`, `.sandcastle/agent-workflows/review/prompt.md`, `src/templates/sequential-reviewer/review-prompt.md`) | pushed 2026-10-08 | Real reviewer prompts: improve clarity/consistency/maintainability "while preserving exact functionality"; PR variant verifies the linked issue | High, primary |
| Workshop video "Full Walkthrough: Workflow for AI Coding" (AI Engineer) | https://www.youtube.com/watch?v=-QFHIoCo-Ko | 2026-04-24 | I read the auto-captions: review in the smart zone, QA vs code review, "more code review now", push standards to reviewer | High for his stated views; captions noisy |
| Smart-zone dictionary entry | https://www.aihero.dev/ai-coding-dictionary/smart-zone | n/a | 404 to me on two URL variants; known only via search snippets | [U] |
| Pragmatic Engineer podcast | https://newsletter.pragmaticengineer.com/p/ai-skills-with-matt-pocock | 2026-09-17 | "mixed feelings" on TDD with agents; wants agents to "produce proof that their code works" | Medium; summary excerpt only [S] |
| contextstudios.ai summary | https://www.contextstudios.ai/blog/pocock-workflow-grill-me-spec-tickets-subagent-review | n/a | Third-party gloss of two-axis review | Low-medium [S] |
| sean-weldon.com workshop summary | https://www.sean-weldon.com/blog/2026-04-27-workflow-for-ai-coding-matt-pocock | 2026-04-27 | Claims small self-contained PRs, "slop" warning | [S]; consistent with captions |
| Repo issues (field evidence) | https://github.com/mattpocock/skills/issues/858 , /845 , /1044 , /498 , /919 | Aug-Sep 2026 | User-reported failure modes (section 4) | High as evidence of behaviour; user-authored |

Not found: a Total TypeScript or aihero.dev blog/newsletter post specifically about reviewing AI code (archive not reachable; searches surfaced none). `grill-me` is a planning interview, not a review tool.

## 2. His review method

### 2.1 The `code-review` skill (primary)
1. Pin a fixed point (user-supplied ref). Check it resolves and the diff is non-empty before spawning anything. Diff is `git diff <ref>...HEAD` (merge-base) plus the commit list.
2. Find the spec: issue refs in commits, a passed path, a `docs/specs/.scratch` file, else ask. No spec means skip the Spec agent and report "no spec available" rather than inventing requirements.
3. Find standards files (`CODING_STANDARDS.md` / `CONTRIBUTING.md` mandatory). Add a 12-smell Fowler baseline (Mysterious Name, Duplicated Code, Feature Envy, Data Clumps, Primitive Obsession, Repeated Switches, Shotgun Surgery, Divergent Change, Speculative Generality, Message Chains, Middle Man, Refused Bequest), each as "what it is -> fix".
4. Two foreground sub-agents in parallel, each under 400 words:
   - Standards: per hunk, cite the violated documented rule (file + rule) or name a smell and quote the hunk. Documented breaches may be "hard"; smells are always judgement calls; the repo overrides the baseline; skip anything tooling enforces.
   - Spec: requirements missing or partial; unrequested behaviour (scope creep); requirements that look implemented but wrong. Quote the spec line for each.
5. Present verbatim or lightly cleaned under `## Standards` and `## Spec`. Never merge or re-rank. End with a count per axis and the worst issue per axis, with no overall winner.

Severity: only the hard-vs-judgement split and "worst per axis". No numeric severity or confidence. Ignore list: whatever tooling already enforces. Output cap: 400 words per axis.

### 2.2 Surrounding doctrine
- Fresh context for review. The implementer uses up the smart zone, so a same-session reviewer "will be dumber"; clear the context and review in the smart zone (workshop, ~61:00 in captions) [V]. The docs page quotes a reader calling same-context review "confirmation bias with a slash command" [V].
- Push standards to the reviewer; let the implementer pull them (workshop) [V]. `retro`: the review agent has the least context pressure, so it, not the implementer, enforces standards [V].
- Mechanical violations become deterministic checks (lint rule, hook, CI job). `CODING_STANDARDS.md` is reserved for judgement calls [V, retro].
- Tests: review the tests first, then the code (workshop) [V]. Anti-patterns: implementation-coupled, tautological (expected value recomputed the way the code does), horizontal slicing. Expected values must come from an independent source: a literal, a worked example, the spec [V].
- Feedback loops: types, tests, browser. README quotes Pragmatic Programmer: "The rate of feedback is your speed limit." [V]. On TDD with agents he is now ambivalent but wants proof the code works (Sep 2026) [S].
- Human role: he does not read the PRD or ticket text after grilling (he is "checking the LLM's ability to summarize"), but does QA the running app and reads tests and code at the interface. Deep modules let him treat internals as grey boxes: "I don't necessarily need to code review everything inside that module." [V workshop]. He concedes more code review is inevitable and small PRs conflict with batched agent loops: "I don't honestly know what the answer to this yet." [V].
- PR body: smallest-visual summary, before/after evidence (screenshots S-tier, execution evidence A-tier), merge danger (one-way vs two-way door, blast radius) [V].
- Smart zone is roughly 100K tokens; one task per session [S].
- Sandcastle reviewers: refactor for clarity, "Never change what the code does", commit directly, do nothing if clean. The newer PR reviewer also verifies the PR satisfies the linked issue and stress-tests edge cases, adding tests where useful. The `sequential-reviewer` template adds a correctness block (edge cases, tests for new behaviour, unsafe casts, security) [V].

## 3. What serves SpecGuard (Test-Gap/Traceability GitHub Action)

| # | Idea | Source | Why it serves SpecGuard | Risk | How to measure |
|---|---|---|---|---|---|
| 1 | Spec axis as three questions (missing/partial, scope creep, implemented-but-wrong), each quoting the spec line | code-review SKILL.md | Same evidence model as quote verification; ready finding taxonomy | Scope-creep findings add noise in a test-gap tool | Per-category precision on the replay set |
| 2 | Honest "no spec available" instead of inferred requirements | SKILL.md, docs checklist | Low noise | Silent skip hides gaps in spec-less repos | Rate of "no spec" runs plus manual spot check |
| 3 | Fail fast before any LLM call (ref resolves, diff non-empty) | SKILL.md step 1 | Zero tokens on bad input | Probably already present | Tokens on empty/invalid runs equal 0 |
| 4 | Immutable review target: snapshot the diff text, not the command | issue #845 | Determinism | Minimal | Re-run on same SHA gives identical findings |
| 5 | Tautological and implementation-coupled test definitions with the "independent source of truth" rule | tdd/tests.md | Defines test-gap subtypes SpecGuard can flag; issue #858 shows users want "inert/self-proving test oracle" detection | Tautology verdict is LLM judgement; only the quote is verifiable | Mutation proof and seeded tautological tests: recall and false-positive rate |
| 6 | Reviewer gets spec + diff + standards, not authoring chatter | workshop, retro | Matches Action context | Needs spec/standards discovery | Findings delta with standards file added vs removed |
| 7 | Convert recurring misses into deterministic checks | retro | Matches deterministic verification and low token cost | Needs a dismissal feedback channel | Share of findings backed by a deterministic check over time |
| 8 | Per-axis report, no blended verdict | SKILL.md step 5 | A passing dimension cannot hide a failing one | Extra output tokens | Small comprehension test |
| 9 | Evidence tiers: name the exact test that fails/passes | pr/SKILL.md | Fits "evidence-backed" | Cannot execute in every repo | Fraction of findings with a quoted or runnable witness |
| 10 | Hard word cap per reviewer output (400) | SKILL.md | Token cost, prioritisation | May drop real findings | Recall at cap vs uncapped |
| 11 | A "simplify this guard" suggestion must name the input the old branch handled | issue #1044 | Guards against fix suggestions that remove unseen behaviour | Relevant only if SpecGuard suggests fixes | Review fix suggestions in the replay set |

## 4. What does not transfer, and where SpecGuard is stronger

Does not transfer:
- Interactive steps: asking for the fixed point or spec location, grilling loops, seams "confirmed with the user". An Action has no one to ask.
- Fixing in place: Sandcastle reviewers edit and commit; SpecGuard should only report.
- Session clearing for the smart zone is moot for a stateless CI call.
- Refactor smells (Feature Envy, Middle Man) are quality opinions, off-target for test-gap/traceability, and would raise noise.
- Manual QA of a running app as the main safety net.
- `improve-codebase-architecture` is a periodic whole-codebase HTML-report tool, a different job.

Where his own repo shows weaknesses (SpecGuard's openings):
- Findings are not re-verified. Docs: sub-agent output "is a hypothesis, not evidence"; the skill passes reports through "as they are, or lightly cleaned" [V]. SpecGuard verifies quotes deterministically.
- No convergence: re-runs always find new items [V docs]. Issues #498 and #858 describe endless review-fix cycles and an unstable "final" review.
- Moving target (#845), uncommitted work invisible (#511), sub-agent recursion reaching 50+ agents, name clash with the built-in `/code-review` (#1234, #1215), a security-scanner alert (#919, closed) [V].
- No confidence, severity scale, or dedupe; test quality is advice in `tdd`, not a review output; no stated token budget; two LLM agents per run.
- Depends on the repo having specs and standards files, else one axis is empty or smell-only.

## 5. Stand-in "Matt Pocock-style" reviewer prompt

RECONSTRUCTED from the sources above. This is not his published prompt. It is the one-agent merge of his two axes plus the `tdd` test rules, with bracketed source tags. For a two-agent run, split Part A and Part B.

```
You review a diff in a fresh context. You did not write this code. [workshop: fresh context; docs]
Inputs: DIFF (merge-base..HEAD, pasted), COMMITS, SPEC (originating issue/spec text, may be absent), STANDARDS (repo coding-standards files). [SKILL.md steps 1-3]
Ignore anything a linter, formatter, or type-checker already enforces. [SKILL.md]

Part A, Spec. If SPEC is absent, write "no spec available" and skip this part; never infer requirements. [SKILL.md, docs]
 (a) requirements missing or only partly met; (b) behaviour not asked for (scope creep); (c) requirements that look implemented but seem wrong. Quote the spec line for every finding. [SKILL.md Spec brief]
 Also check each new or changed behaviour for a test that exercises it through the public interface. Review the tests before the code. [workshop; tdd]
 Flag a test as weak if it mocks internal collaborators or asserts call counts/order; verifies through a side channel instead of the interface; or computes its expected value the way the code does (tautological) instead of using a known literal or the spec. [tdd/tests.md]

Part B, Standards. For each hunk, cite the documented rule (file plus rule) that is broken. Documented breaches may be called hard. [SKILL.md Standards brief]
 Only if no repo rule covers it, name baseline smells (Mysterious Name, Duplicated Code, Feature Envy, Data Clumps, Primitive Obsession, Repeated Switches, Shotgun Surgery, Divergent Change, Speculative Generality, Message Chains, Middle Man, Refused Bequest), quote the hunk, and label each "possible X (judgement call)". The repo overrides the baseline. [SKILL.md smell baseline]

Output: "## Spec" and "## Standards", each under 400 words. Do not merge or re-rank. End with the finding count per section and the single worst issue per section; do not pick an overall winner. [SKILL.md step 5]
Every finding needs a citation (spec line, rule, or smell plus quoted hunk). Treat your findings as hypotheses; if a suggested simplification removes a guard or branch, say which input that branch handled. [docs "trust"; issue #1044]
Optionally state merge danger: one-way or two-way door, and blast radius. [pr/SKILL.md]
```

For a fair head-to-head: same diff, same spec text, same token cap; score precision, recall on seeded gaps, quote-verifiability rate, and tokens per true positive. This prompt is not designed for test-gap detection beyond the tdd-derived weak-test rules, so a recall loss there reflects design intent, not a strawman.
