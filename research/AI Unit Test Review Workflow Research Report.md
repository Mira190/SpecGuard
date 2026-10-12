# AI Unit Test Review Workflow: Research Report

Oct 2, 2026 · @MIra

## Summary

Build a small custom workflow on Anthropic's `claude-code-action` rather than install an existing reviewer: no surveyed tool covers more than two of the five checks, and none can gate a merge on them.

- **What to reuse.** The action as the engine, with its structured output and tool allow-list. The 1 to 10 gap rating from Anthropic's pr-test-analyzer. The separate-axes structure from Matt Pocock's code-review skill, and the test anti-patterns from his tdd skill and from Superpowers. Ponytail contributes a terse finding format and a brake on over-testing, nothing more.
- **What had to be built.** A matrix tracing each acceptance criterion to named unit tests. Proof from check results that lint and format actually ran and passed. A pass or fail gate. A reviewer that asks whether component or integration tests assert logic that belongs in unit tests.
- **What was delivered.** A three-job workflow and a review skill. A script gathers the evidence, four isolated Claude runs with read-only tools review it, and a script posts one PR comment and decides the result.
- **Status.** Lint-clean and exercised against mocked GitHub data. Not yet run in a real repository, and the defaults for lint job names, test locations and the requirements source are generic.
- **Recommendation.** Run it advisory first. Enforce only after the team has measured how often its blocking findings are right and what a review costs.

## Scope

The workflow reviews every pull request against five checks. Three are mandatory in the brief; two are the "if possible" extensions.

| # | Check | Question it answers | Inputs it needs | Priority |
| --- | --- | --- | --- | --- |
| 1 | Requirements coverage | Does each acceptance criterion have at least one unit test that would fail if the criterion were broken? | PR description, linked issue or ticket, spec files in the repo | Must |
| 2 | Test quality | Do the existing unit tests assert behaviour, or do they only execute code? | Changed test files and the code under test | Must |
| 3 | Missing unit tests | Which changed functions, branches, error paths and boundaries have no test? | Diff, coverage report (when available), neighbouring tests | Must |
| 4 | Coding standard | Has the standard been enforced by tooling, and does the diff break rules that tooling cannot catch? | Lint and format results, the standards document, repo conventions | Must |
| 5 | Test-level placement | Which component or integration tests verify logic that could be tested faster and more precisely at unit level? | Component and integration test files touched by, or covering, the changed code | Should |

Out of scope: generating and committing tests automatically, and general code review (bugs, security, design). Both are covered by existing tools described below and can run beside this workflow.

## What exists: Anthropic

Anthropic ships the runner we should build on and one agent that already covers about half of check 3. Nothing it ships covers requirements traceability or test-level placement.

| Component | What it does | Covers which checks | Reuse decision |
| --- | --- | --- | --- |
| [claude-code-action v1](https://code.claude.com/docs/en/github-actions) | Runs Claude Code in a workflow. A `prompt` input puts it in automation mode. `claude_args` passes CLI flags such as `--model`, `--max-turns`, `--allowedTools`. | None by itself; it is the runner | Use as the engine |
| [Structured outputs](https://github.com/anthropics/claude-code-action/blob/main/docs/usage.md) | `--json-schema` in `claude_args` returns validated JSON in the step output `structured_output`. | Enables a pass or fail gate | Use for the merge gate |
| Inline comment tool | `mcp__github_inline_comment__create_inline_comment` posts line-level comments. It starts only when named in `--allowedTools`. | Delivery of findings | Use for missing-test findings |
| [pr-test-analyzer agent](https://github.com/anthropics/claude-plugins-official) (pr-review-toolkit plugin) | Reviews behavioural rather than line coverage. Flags untested error paths, boundaries and negative cases. Rates each gap 1 to 10 and flags implementation-coupled tests. | 2 and 3, partly | Adopt its criteria and its 1 to 10 rating |
| code-review plugin | Parallel agents with confidence scoring to drop false positives. Explicitly skips lint, type and test failures because CI owns them. | 4, only for rules written in CLAUDE.md | Adopt confidence filtering; run beside, not inside |
| [Managed Code Review](https://code.claude.com/docs/en/code-review) | Hosted multi-agent review on every PR. Tuned by `CLAUDE.md` and `REVIEW.md`. Research preview, Team and Enterprise plans. Findings never block a PR. | General bugs | Not a fit: cannot gate, and is not a test review |

Three behaviours of the action shape the design:

- **Results go to the run log by default.** In automation mode Claude posts to the PR only when the prompt says so and a posting tool is allowed.
- **A plain-text prompt has no shell or GitHub access** until tools are granted through `--allowedTools`. The allow-list is the security boundary.
- **Actor checks run first.** The triggering user needs write access, and bot actors are rejected unless listed in `allowed_bots`.

Skills in `.claude/skills/` are available to the action once the repo is checked out, so the review logic can live in the repo as a skill and be run locally with the same result.

## What exists: community skills

The community skills supply the best review criteria, but all three are built for interactive sessions and none is a CI gate. We borrow their rules and write our own skill.

| Source | Relevant skill | What it contributes | Limit for our use |
| --- | --- | --- | --- |
| [Matt Pocock, skills](https://github.com/mattpocock/skills/) (MIT, about 265k stars) | [code-review](https://github.com/mattpocock/skills/blob/main/skills/engineering/code-review/SKILL.md) | Two separate axes run as parallel sub-agents: **Standards** (documented repo standards plus a baseline of 12 Fowler code smells) and **Spec** (missing, partial, wrong or unrequested behaviour, each quoting the spec line). Findings are never merged across axes. Skips anything tooling enforces. | Reviews code against the spec, not tests against the spec. Asks the user when no spec is found, which a CI job cannot do. |
| Matt Pocock, skills | [tdd](https://github.com/mattpocock/skills/blob/main/skills/engineering/tdd/SKILL.md) | The clearest definition of a good test: verify behaviour through public interfaces at agreed seams. Names three anti-patterns: implementation-coupled, tautological, horizontal slicing. Mock only at system boundaries. | A writing discipline, not a review. Prefers integration-style tests through real interfaces, which pulls against "push everything down to unit". |
| [Ponytail](https://github.com/dietrichgebert/ponytail) (MIT) | ponytail-review, ponytail-audit | One line per finding: location, tag, replacement. Hunts over-engineering only. States that a single smoke test is the minimum and must never be flagged for deletion. | Correctness, coverage and standards are explicitly out of scope. Useful as an output format and as a brake on over-testing, not as a test reviewer. |
| [Superpowers](https://github.com/obra/superpowers) (obra) | test-driven-development, with a testing anti-patterns reference | Anti-patterns to detect: asserting on mock behaviour, test-only methods in production code, mock setup longer than the test logic, integration tests added as an afterthought. | Also a writing discipline. No requirements mapping, no CI output. |

Three ideas carry over directly:

1. **Separate axes, separate agents.** Pocock's split stops a clean standards result from masking a spec failure. We extend it to four axes: requirements, test quality, standards, placement.
2. **Tooling first, model second.** Both Pocock's skill and Anthropic's code-review plugin refuse to restate what linters catch. Our standards check does the same.
3. **Do not demand tests for everything.** Pocock's seams and Ponytail's minimum both argue against coverage for its own sake. The reviewer must rate each gap and stay silent on trivial code.

One tension needs a decision. Pocock's tdd skill treats a test through the real public interface as the ideal, even when it crosses modules. A strict "move it to unit" rule would contradict that. The rubric below resolves it by moving only **logic-level** assertions down, and leaving wiring and contract checks where they are.

## What exists: other tools

Commercial reviewers each cover one or two of the five checks, and the deterministic tools give the model evidence it would otherwise have to guess. Claims about commercial products below come from third-party comparisons, not from testing them here.

| Tool | Type | Closest capability | Covers which checks |
| --- | --- | --- | --- |
| Qodo Merge (open-source engine: PR-Agent) | AI PR reviewer | [Ticket compliance](https://www.aikido.dev/blog/coderabbit-alternatives) against Jira, Linear or GitHub Issues; flags diff paths without tests; Qodo Cover generates tests | 1 and 3, partly. Rates code against the ticket, not tests against each criterion |
| CodeRabbit | AI PR reviewer | Comments on missing tests; natural-language custom rules; optional unit test generation in beta | 3 and 4, partly |
| GitHub Copilot code review | AI PR reviewer | Built in to GitHub; custom rules through `copilot-instructions.md`; lint and CodeQL signals | 4, partly |
| Patch coverage (Codecov, diff-cover) | Deterministic | Exact changed lines that no test executed | Evidence for 3 |
| Mutation testing (Stryker, PIT, mutmut) | Deterministic | Shows assertions that would not notice a behaviour change | Evidence for 2 |
| [Meta ACH](https://engineering.fb.com/2025/09/30/security/llms-are-the-key-to-mutation-testing-and-better-compliance/) | Research system | An LLM writes targeted mutants that no existing test catches, then writes tests that catch them | Direction for a later phase |

Two findings from this group shape the design:

- **Coverage tells you a line ran, not that it was checked.** Meta's work argues mutation testing beats structural coverage as an adequacy measure. The reviewer therefore treats coverage as evidence of absence only: an uncovered changed line is a real gap, a covered line proves nothing.
- **No surveyed tool reasons about test level.** None asks whether an integration test should be a unit test.

## Gap analysis

No existing option covers more than two of the five checks, and two checks have no real coverage anywhere.

| Check | Anthropic pr-test-analyzer | Pocock code-review | Ponytail review | Qodo Merge | What we must build |
| --- | --- | --- | --- | --- | --- |
| 1. Requirements to tests | None | Partial: spec to code | None | Partial: ticket to code | A criterion-by-criterion matrix mapping each requirement to named tests |
| 2. Test quality | Partial | None in review; rules in tdd skill | None | None | An anti-pattern checklist merged from Pocock and Superpowers |
| 3. Missing unit tests | Partial: no coverage data, no gate | None | None | Partial | Coverage-informed gap list with a 1 to 10 rating and a blocking threshold |
| 4. Coding standard | CLAUDE.md rules only | Good: documented rules plus smells | Over-engineering only | Custom rules | Proof that lint and format ran, then review of rules tooling cannot check |
| 5. Test-level placement | None | None | None | None | New: classify what each higher-level test asserts and propose unit equivalents |

Four things are missing everywhere and are the reason to build rather than install:

1. **Tests are never traced to requirements.** Existing tools compare code to the spec. A PR can implement a criterion correctly and still leave it untested.
2. **Nothing verifies the standard was actually enforced.** Tools either re-review style with a model or skip it and trust CI. Nobody checks that the lint job exists, ran and passed.
3. **Nothing produces a gate.** Managed Code Review never blocks, and the plugins write prose. A required status check needs structured output.
4. **Nothing reasons about the test pyramid.**

## Workflow design

The workflow has three jobs: a script collects the evidence, four isolated Claude runs review it, and a script decides the result. The model never runs code and never decides the gate.

&#91;embedded content: workflow design · 3 jobs, 4 parallel review legs\]

Only the middle job uses a model. Everything the gate depends on for the coding standard, and the final pass or fail, is computed from data.

| Decision | Choice | Reason |
| --- | --- | --- |
| Engine | `claude-code-action@v1` in automation mode | Official runner; supports structured output and a tool allow-list |
| Isolation | One matrix leg per axis, `fail-fast: false` | Pocock's rule that axes must not pollute each other; one failed leg does not lose the rest |
| Model tools | `Read`, `Glob`, `Grep`, plus the inline comment tool. No shell, no edits, no web | PR code is never executed, and an injected instruction has nothing to act with |
| Context | Gathered by script before the model starts | Repeatable, auditable as an artifact, and the model spends its turns reviewing |
| Rubric | A skill file, loaded from the **base** branch | A PR cannot rewrite the rules it is judged by; the same file runs locally as `/unit-test-review` |
| Output | JSON schema, read from `structured_output` | A gate needs data, not prose |
| Coding standard | Decided from check runs and the PR checkbox, not by the model | "Confirmed" has to be a fact. The model only reviews rules tooling cannot check |
| Confidence | Blocking findings below 80 are downgraded | Borrowed from Anthropic's code-review plugin to cut false positives |
| Reporting | One comment updated in place; inline comments for blocking findings only, at most five per axis | Keeps the PR readable across pushes |
| Gate | Advisory by default; `blocking` by repository variable; override by label | Lets the team measure accuracy before enforcing |
| Failure mode | A reviewer error is reported but never fails the gate | An API outage must not block merges |

**Triggers.** Pull request opened, updated, reopened or marked ready, plus a manual run by PR number. Drafts, forks, bot authors and PRs labelled `skip-ai-test-review` are skipped. Docs-only changes pass without calling the model.

**Files delivered.**

- `.github/workflows/ai-unit-test-review.yml`: the workflow, about 720 lines with setup notes in the header
- `.claude/skills/unit-test-review/SKILL.md`: the rubric the reviewers follow

The workflow passes `actionlint` with `shellcheck`. Its shell steps and both scripts were exercised against mocked GitHub data. It has not been run in your repository, so the first live run is the real test of the action inputs.

## Review rubric

Every finding carries a file, a criticality from 1 to 10, a confidence from 0 to 100 and a named test to add. The full rubric is the skill file; this section records the rules that decide outcomes.

### How findings are graded

| Severity | Rule | Effect in blocking mode |
| --- | --- | --- |
| Blocking | Criticality 8 or higher, or a rule below marked blocking, with confidence 80 or higher | Fails the gate |
| Important | Criticality 5 to 7, or a blocking finding with confidence under 80 | Reported, does not fail |
| Suggestion | Criticality 4 or lower, and every gap that predates the PR | Collapsed in the comment |

The criticality scale is Anthropic's pr-test-analyzer scale: 9 to 10 for data loss, security or money; 7 to 8 for business logic a user would see break; 5 to 6 for edge cases. Each reviewer reports at most 12 findings and none it could not verify.

### What each axis blocks on

| Axis | Blocking | Not blocking |
| --- | --- | --- |
| requirements | An explicit acceptance criterion with no test at any level; a criterion the code does not implement | Partial coverage; criteria the reviewer had to derive; a PR with no requirement source (reported as important) |
| unit-tests | A test with no assertion or a tautological assertion as the only test of new logic; a weakened or deleted assertion on changed code; a bug fix with no regression test; any untested gap rated 8 or higher | Over-mocking, implementation coupling, unclear names, flaky patterns |
| standards | Lint or format checks failed; no lint or format check ran on the commit; a documented rule that says "must" | Checks still running; unticked author checkbox; other documented rules; departures from neighbouring code |
| placement | Nothing | All placement findings are important at most |

### Requirements traceability

The reviewer splits the requirement sources into numbered criteria and gives each one status. The comment shows the full matrix, including covered criteria, so a human can audit the mapping.

| Status | Meaning |
| --- | --- |
| covered | A unit test would fail if the criterion were broken, including its stated negative or boundary case |
| partial | Main path tested; a stated negative, boundary or error case is not |
| missing | No test at any level |
| covered elsewhere | Only a component, integration or end-to-end test asserts it |
| not unit testable | Wiring, infrastructure, layout or a manual step |

### Test-level placement

The reviewer classifies what each higher-level test asserts, then recommends one of four moves.

| The assertion is about | Belongs at |
| --- | --- |
| A calculation, rule, validation, mapping, parse or state transition with no I/O | Unit |
| Many input permutations of one rule driven through a slow path | Unit, table-driven |
| An error branch triggered by a bad input value; a boundary value | Unit |
| Wiring, configuration, routing, middleware | Higher level |
| A query, transaction, migration or contract across a process boundary | Higher level |
| Behaviour that only emerges from real components together; real browser behaviour | Higher level |

- **Push down**: several higher-level cases vary only the input to one rule. Move the permutations to a table-driven unit test and keep one case for the wiring.
- **Unit missing below**: logic whose only test is higher-level. Add the unit test and keep the existing one.
- **Duplicate**: the same assertion at both levels. Delete the higher-level copy.
- **Pull up**: a unit test so mocked that it verifies wiring. Replace it with a test through the real interface.

The reviewer never recommends moving a test down when that would require mocking an internal collaborator. This is the rule that reconciles "push logic down" with Pocock's "test through public interfaces".

## Security, cost and reliability

The main risk is prompt injection through PR content, and the design answers it by giving the model nothing to act with. Cost is unmeasured until the advisory phase runs on real PRs.

### Security

| Risk | Control in the workflow | Residual risk |
| --- | --- | --- |
| PR text or code instructs the model | Tools limited to `Read`, `Glob`, `Grep` and the inline comment tool. No shell, edits or web access. The rubric tells the reviewer to report any such attempt as a blocking finding. | The model could still be talked into a wrong verdict. The gate is advisory first, and humans still approve. |
| PR rewrites the rubric to pass itself | Rubric is fetched from the base branch | While the rubric is first being introduced, the PR copy is used and a warning is logged |
| PR plants fake context files | Context is built outside the workspace; the directory is deleted from the checkout before the artifact is restored | None known |
| PR edits the workflow file itself | None inside the workflow: `pull_request` runs the PR's version of the file | Add CODEOWNERS on `.github/` and `.claude/`. For hard enforcement, run it as an organisation-level required workflow |
| Secrets exposed to forks | `pull_request`, not `pull_request_target`; fork PRs are skipped | External contributors get no review |
| Model output abuses the comment | Mentions neutralised, HTML comments escaped, lengths capped, table cells escaped | None known |
| Over-broad token | Top-level `permissions: {}`; review legs get `contents: read` and `pull-requests: write` only | Inline comments need the write scope; set `AI_REVIEW_INLINE_COMMENTS=false` and drop it to read |
| Supply chain | Workflow notes where to pin the action to a commit SHA | Pinning is a manual step |

Two items sit outside the workflow. Claude Code reads `CLAUDE.md` from the PR head on its own, so that file is an instruction channel a PR author controls. Source code is sent to the model provider; the action supports Amazon Bedrock, Google Cloud and Microsoft Foundry through OIDC if code must stay inside your cloud account.

### Cost

Each PR push starts up to four model runs of at most 40 turns each. Third-party reporting puts Anthropic's managed review at [15 to 25 US dollars per review](https://www.getorchestra.io/knowledge-hub/data-tools/using-claude-code-for-automated-code-reviews); this workflow is narrower, but its real cost per PR is an open question until measured.

Levers, cheapest first:

- Superseded runs are cancelled, and docs-only PRs never call the model.
- `AI_REVIEW_AXES` drops axes. Placement is the natural one to run on demand.
- `AI_REVIEW_MODEL` and `AI_REVIEW_MAX_TURNS` trade depth for spend.
- The `skip-ai-test-review` label opts a PR out.

### Reliability

- **Non-determinism.** Two runs on the same commit can differ. The confidence threshold, the cap of 12 findings and the deterministic standards check limit the effect. Do not enforce before measuring.
- **Timing.** The context job waits up to 90 seconds for lint checks to appear and up to 8 minutes for them to finish. Slower lint jobs report as pending; raise `AI_REVIEW_STANDARDS_WAIT_SECONDS`.
- **Coverage is best effort.** It is used only if CI has already uploaded an artifact named `coverage` for the commit. Without it the reviewer judges gaps by reading tests.
- **Large PRs.** The diff is cut at 400 KB and the reviewer reads files directly. Very large PRs will hit the turn limit and return partial results.
- **Repeated inline comments.** Each push can post fresh inline comments on blockers that are still open. The summary comment is updated in place.
- **Manual runs.** A run started by PR number updates the comment, but its status attaches to the default branch, not the PR.

## Rollout and open decisions

Ship it advisory, measure it on real PRs, and only then make it a required check. I could not see the repository, so the first phase includes fitting the defaults to it.

1. **Set up.** Commit the workflow and the skill to the default branch. Add the `ANTHROPIC_API_KEY` secret. Set `AI_REVIEW_STANDARDS_CHECK_PATTERN` to match the real lint job names, and the two test-location hints. Exit when a test PR receives a review comment.
2. **Advisory.** Run on every PR with `AI_REVIEW_MODE` unset. The gate never fails. Reviewers mark each blocking finding as right or wrong in the PR thread. Exit when the share of correct blocking findings and the cost per PR are both acceptable to the team.
3. **Tune.** Feed repeated false positives back into the skill file as explicit exclusions. Document the unit and integration boundary in `CONTRIBUTING.md` so the placement axis has a rule to cite.
4. **Enforce.** Set `AI_REVIEW_MODE=blocking` and make "Unit test review gate" a required status check. Maintainers bypass with the `ai-test-review-override` label, which the comment records.
5. **Extend.** Publish coverage on every PR so gaps rest on data. Add mutation testing on changed files as evidence for the test-quality axis, following the direction of Meta's ACH work.

### Open decisions

- [ ] What "coding standard confirmed" means for you. The workflow treats passing lint and format checks as the proof (blocking), and a ticked PR-template checkbox as a secondary signal (important). Say if the checkbox alone should count, or should block.
- [ ] Where requirements live. GitHub Issues work out of the box. Jira needs `JIRA_BASE_URL`, two secrets and, if acceptance criteria sit in a custom field, `JIRA_AC_FIELD`.
- [ ] Language and test framework of the target repo, to replace the generic test-location hints.
- [ ] Model route: Anthropic API key, or your own cloud account through Bedrock, Google Cloud or Foundry.
- [ ] The accuracy threshold that moves the gate from advisory to blocking, and who signs it off.
- [ ] Whether a PR with no linked requirement should block. Today it is reported as important.

## Sources

Sources read in full on 2 October 2026 carry the design. Those marked "search summary" were seen only as search-result extracts and support background claims.

| Source | Used for | How read |
| --- | --- | --- |
| [Claude Code GitHub Actions docs](https://code.claude.com/docs/en/github-actions) | Automation mode, actor checks, tool allow-list, inline comment tool, cloud providers | Full page |
| [claude-code-action usage reference](https://github.com/anthropics/claude-code-action/blob/main/docs/usage.md) | Inputs, `--json-schema` and `structured_output` | Full page |
| claude-code-action `action.yml` and `docs/security.md` | Declared outputs, `github_token` override, prompt-injection notes | Source files |
| [anthropics/claude-plugins-official](https://github.com/anthropics/claude-plugins-official): `pr-test-analyzer.md` | Behavioural coverage criteria and the 1 to 10 rating | Source file |
| [Claude Code Code Review docs](https://code.claude.com/docs/en/code-review) | Managed review: plans, severities, never blocks | Search summary |
| [mattpocock/skills](https://github.com/mattpocock/skills/) README, [code-review](https://github.com/mattpocock/skills/blob/main/skills/engineering/code-review/SKILL.md), [tdd](https://github.com/mattpocock/skills/blob/main/skills/engineering/tdd/SKILL.md) with `tests.md` and `mocking.md` | Two-axis review, smell baseline, good-test definition, mocking rules | Full page and source files |
| [DietrichGebert/ponytail](https://github.com/dietrichgebert/ponytail): `ponytail`, `ponytail-review`, `ponytail-audit` skills | Scope and output format of Ponytail's review | Source files |
| [InfoQ on Ponytail](https://www.infoq.com/news/2026/08/ponytail-agent-skill-benchmark/) | What Ponytail is and its adoption | Search summary |
| [obra/superpowers](https://github.com/obra/superpowers) | Testing anti-patterns reference | Search summary |
| [Aikido: CodeRabbit alternatives](https://www.aikido.dev/blog/coderabbit-alternatives) and [DEV: Qodo vs CodeRabbit](https://dev.to/rahulxsingh/qodo-vs-coderabbit-ai-code-review-tools-compared-2026-kdp) | Qodo ticket compliance and test generation; CodeRabbit and Copilot review | Search summary |
| [Meta Engineering on ACH](https://engineering.fb.com/2025/09/30/security/llms-are-the-key-to-mutation-testing-and-better-compliance/) and [the ACH paper](https://arxiv.org/pdf/2501.12862) | Mutation-guided test generation; mutation testing over structural coverage | Search summary |
| [Orchestra: Claude Code automated reviews](https://www.getorchestra.io/knowledge-hub/data-tools/using-claude-code-for-automated-code-reviews) | Reported cost of managed review | Search summary |

Patch-coverage and mutation-testing tools (Codecov, diff-cover, Stryker, PIT, mutmut) are named from general knowledge and were not looked up.
