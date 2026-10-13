# Landscape report fact-check (2026-10-09)

Source report: Downloads/code_review_landscape_research_2026.md. Primary sources only. Fetched via WebFetch (summarising) and curl of raw.githubusercontent.com (verbatim, where noted).

## 1. Head branch, not base: VERIFIED
URL: https://github.blog/changelog/2026-07-17-copilot-code-review-customization-and-configurability-improvements/
Quote: "Custom instructions are now read from the head branch of the pull request instead of the base branch." Applies to copilot-instructions.md, *.instructions.md, agent skills, AGENTS.md (WebFetch paraphrase of the list; the sentence above is quoted).

## 2. CLAUDE.md, GEMINI.md, REVIEW.md: VERIFIED
Same changelog. Quote: "Copilot code review now reads `REVIEW.md`, `GEMINI.md`, and `CLAUDE.md` files from your repository."

## 3. .github/skills/*/SKILL.md and copilot-code-review.yml
- copilot-code-review.yml: VERIFIED. Changelog: "You can now configure the environment available to Copilot code review during runtime using a `copilot-code-review.yml` file in your `.github/workflows/` directory." Fallback: `copilot-setup-steps.yml`.
- .github/skills: VERIFIED (path). https://github.com/github/docs/blob/main/content/copilot/concepts/agents/code-review.md (raw): "can automatically use relevant skills when reviewing a pull request"; table row "Stored in ... `.github/skills/...`".
- The literal filename `SKILL.md` was not seen on the fetched page: UNVERIFIED (minor).

## 4. applyTo and excludeAgent: VERIFIED
URL: https://docs.github.com/en/copilot/how-tos/configure-custom-instructions/add-repository-instructions
Quotes: "Use glob syntax to specify what files or directories the instructions apply to." / "To prevent the file from being used by either Copilot cloud agent or Copilot code review, add the `excludeAgent` keyword to the frontmatter block. Use either "code-review" or "cloud-agent"." / "Currently, on GitHub.com, path-specific custom instructions are only supported for Copilot cloud agent and Copilot code review."
Concepts page also lists `.github/instructions/**/*.instructions.md` as "Stored in". The 2026-07-17 changelog itself does not mention applyTo/excludeAgent.

## 5. claude-plugins-official code-review.md: VERIFIED (all parts), verbatim via curl
URL: https://raw.githubusercontent.com/anthropics/claude-plugins-official/main/plugins/code-review/commands/code-review.md
- "launch 5 parallel Sonnet agents": #1 CLAUDE.md compliance, #2 "shallow scan for obvious bugs", #3 "git blame and history", #4 "previous pull requests that touched these files, and check for any comments", #5 "Read code comments in the modified files".
- Scoring: "score each issue on a scale from 0-100"; "Filter out any issues with a score less than 80."
- Exclusion: "General code quality issues (eg. lack of test coverage, general security issues, poor documentation), unless explicitly required in CLAUDE.md".
- Nuance: verification and eligibility checks use Haiku agents; PR eligibility rechecked in step 7. Report's "explicit exclusion" wording is accurate.

## 6. claude-code plugins/code-review README says four agents: VERIFIED
URL: https://raw.githubusercontent.com/anthropics/claude-code/main/plugins/code-review/README.md
Quote: "Launches 4 parallel agents to independently review: Agents #1 & #2: Audit for CLAUDE.md compliance; Agent #3: Scan for obvious bugs in changes; Agent #4: Analyze git blame/history". Note: the 4 are 2x CLAUDE.md + bug + history, with no prior-PR-comments or code-comments agent, so they differ in content, not only count.

## 7. pr-review-toolkit: VERIFIED
- Six agents (README headings 1-6): comment-analyzer, pr-test-analyzer, silent-failure-hunter, type-design-analyzer, code-reviewer, code-simplifier. https://raw.githubusercontent.com/anthropics/claude-code/main/plugins/pr-review-toolkit/README.md
- pr-test-analyzer (https://raw.githubusercontent.com/anthropics/claude-plugins-official/main/plugins/pr-review-toolkit/agents/pr-test-analyzer.md): "Focus on behavioral coverage rather than line coverage."; "Absent negative test cases for validation logic"; "Rate criticality from 1-10 (10 being absolutely essential)"; "without being overly pedantic about 100% coverage"; "some code paths may be covered by existing integration tests"; "Avoid suggesting tests for trivial getters/setters unless they contain logic".

## 8. mattpocock/skills review skill: MIXED
Real path: https://github.com/mattpocock/skills/blob/main/skills/engineering/code-review/SKILL.md (name: `code-review`). The URL guessed for `review` returned 404. skills.sh `review` link was not fetched (non-primary).
- Fixed baseline: VERIFIED. "Capture the diff command once: `git diff <fixed-point>...HEAD`"; `git log <fixed-point>..HEAD --oneline`; `git rev-parse <fixed-point>`.
- Two parallel isolated subagents Standards and Spec: VERIFIED. "Both axes run as **parallel sub-agents** so they don't pollute each other's context".
- Spec search order: PARTLY CONTRADICTED. Real order: (1) "Issue references in the commit messages ... fetched via the workflow in the tracker doc." (2) "A path the user passed as an argument." (3) "A spec file under `docs/`, `specs/`, or `.scratch/` matching the branch name or feature." (4) "ask the user". Report's order matches, but the literal path `docs/agents/issue-tracker.md` is NOT in the skill (it says "the tracker doc" and "run `/setup-matt-pocock-skills`"); the changeset says it "resolves the issue tracker through the provided tracker doc instead of a hard-coded path (#937)". "docs/specs/.scratch" in the claim is a mangling of three separate dirs: UNVERIFIED/CONTRADICTED as written.
- No spec, do not invent: VERIFIED in substance. "If they say there isn't one, the **Spec** sub-agent will skip and report "no spec available"." No literal "do not invent" sentence.
- Labels EXPLICIT_REPOSITORY_RULE / INFERRED_CONVENTION / GENERAL_BEST_PRACTICE: CONTRADICTED. grep count 0 in SKILL.md; also absent from docs/engineering/code-review.md. They are NOT in the source. The report's section 4.2 presents them as the skill's output categories; invented (or from a third-party mirror).
- Also unreported by the research: real Standards axis carries a fixed Fowler "smell baseline" (12 smells), and the report's claim "即使未找到正式规范，仍可依合理的内建代码质量基线审查" is only loosely right (baseline is the smells, "always a judgement call").

## 9. Issue anthropics/claude-code#69232: VERIFIED
URL: https://github.com/anthropics/claude-code/issues/69232
Title: "Two first-party `/code-review` commands (bundled skill + official plugin) collide with contradictory docs". State: closed as not planned. Quote: "There appear to be two different first-party `/code-review` implementations that share the same command name".

## Tally
VERIFIED: 1, 2, 4, 5, 6, 7, 9 (plus 3 mostly). CONTRADICTED/partly: 8 (labels absent; path docs/agents/issue-tracker.md not in skill; skill named code-review not review). UNVERIFIED: literal `SKILL.md` filename on the Copilot docs page.
