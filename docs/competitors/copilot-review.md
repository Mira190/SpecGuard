# GitHub Copilot native code review: competitor notes for SpecGuard

Research date and access date for all URLs: 2026-10-09. Sources are mostly GitHub docs/blog/changelog (primary) plus third-party roundups (secondary, flagged). Pages were read through a summarising fetcher, so exact wording is paraphrase unless quoted; anything not confirmed is marked UNVERIFIED.

## 1. How it works (as documented)

**Architecture.** Since 2026-03-05 review runs on an "agentic tool-calling architecture": the reviewer fetches repository context on demand (relevant code, directory structure, references) instead of only reading the diff. It runs on GitHub Actions runners (GitHub-hosted, larger, or self-hosted); if Actions is unavailable it falls back to a limited analysis. GitHub says it is a "carefully tuned mix of models"; users cannot pick the model (the Models settings page governs Chat only). Per GitHub's 60M-reviews post, the agent catches issues incrementally, plans a strategy up front for complex PRs, keeps memory across reviews, and reads linked issues/PRs for requirement alignment.
- https://github.blog/changelog/2026-03-05-copilot-code-review-now-runs-on-an-agentic-architecture/
- https://docs.github.com/en/copilot/concepts/agents/code-review
- https://github.blog/ai-and-ml/github-copilot/60-million-copilot-code-reviews-and-counting/

**Inputs.** PR diff; PR description and linked issue identifiers; repo-wide `.github/copilot-instructions.md`; path-scoped `.github/instructions/**/*.instructions.md` (frontmatter `applyTo`); `AGENTS.md`; repo agent skills; MCP servers (GitHub and Playwright on by default, disable-able per repo); Copilot Memory (public preview, Pro/Pro+/Max). Instructions and skills are read from the PR **head** branch, so instruction changes can be tested inside the PR itself. Not reviewed: dependency/lock files, logs, SVGs. Secondary sources claim it also skips "low risk" files such as config/generated code (UNVERIFIED, third-party only).
- https://docs.github.com/en/copilot/tutorials/customize-code-review
- https://github.blog/ai-and-ml/unlocking-the-full-power-of-copilot-code-review-master-your-instructions-files/

**Outputs.** A "Comment" review (not approve/request-changes) with a PR overview comment, inline comments, one-click suggested changes (individually or batched into one commit), severity label High/Medium/Low (since 2026-05-12), and similar comments grouped (a repeated rename is flagged once). Multi-line range comments. Typical latency "under 30 seconds" per docs; a third-party guide says 2-5 minutes (conflicting; UNVERIFIED which is current). Copilot Approvals (public preview, off by default) can satisfy required-approval rules and are dismissed on new commits. Humans' replies to its comments are invisible to Copilot and it does not reply. Re-review may repeat comments that were dismissed.
- https://docs.github.com/en/copilot/how-tos/use-copilot-agents/request-a-code-review/use-code-review
- https://github.blog/changelog/2026-05-12-copilot-code-review-comment-experience-improvements

**Triggering and config.** Manual (Reviewers menu, `gh pr edit --add-reviewer @copilot`, IDEs, mobile), or automatic via user settings, repo rulesets, or org policy (any one enables it): on PR open, first draft-to-ready, optionally every push, optionally drafts. New 2026-10-02: REST and GraphQL API to request a review with a per-request effort level. Effort levels: **Lite** (fast, glaring issues; est. USD 0.05-1/review) and **Balanced** (higher-reasoning model; est. USD 0.25-5; default since 2026-09-28 for everyone who had not picked Lite). Settable at enterprise/org/repo/personal level.
- https://github.blog/changelog/2026-10-02-copilot-code-review-api-support-and-new-default-effort-level

**Billing.** AI credits for model usage plus Actions minutes for the agentic part. Billed to the PR author (automatic), the requester (manual), the org (bot-initiated). Access blocked when a budget is exhausted. Plans: Pro, Pro+, Max, Business, Enterprise. (The older "premium requests" wording is superseded by AI credits in the current docs; UNVERIFIED exact conversion.)
- https://docs.github.com/en/copilot/concepts/agents/code-review

**Deterministic tools.** The concept doc and the 60M post do not mention CodeQL or linters in review. A third-party guide states it bundles no ESLint/Pylint-style linters (https://aicodereview.cc/blog/github-copilot-code-review). The coding agent (not the reviewer) runs CodeQL, secret scanning and dependency checks on its own output (https://docs.github.com/en/copilot/responsible-use/code-review). Treat "review includes CodeQL" as NOT confirmed. Reviewer does not execute tests (no source says it does; absence only).

**Limits.** Docs: "may not identify all problems, especially where changes are large or complex"; hallucinated findings possible; quality varies by language. Instruction size: current tutorial says keep each file under ~1,000 lines; an older and widely repeated rule was "only first 4,000 characters are read" for code review. The current doc fetch did not confirm the 4,000-char rule (UNVERIFIED, possibly stale). Instructions cannot change comment format, the overview's purpose, or make Copilot follow external links.

## 2. Strengths worth borrowing

1. **Silence over noise.** GitHub: 29% of reviews post nothing; no filler praise; 71% of reviews have actionable feedback; avg 5.1 comments/review. Matches SpecGuard's low-noise goal.
2. **Severity label on every comment** plus **grouping of repeated findings** into one comment.
3. **Zero-friction fix surface**: native `suggestion` blocks.
4. **Instructions as versioned, path-scoped files read from head branch** (testable in the PR).
5. **Requirement alignment via linked issues/PRs** is now in the agent's context: validates SpecGuard's thesis, and shows the incumbent treats it as a context input, not a first-class check.
6. **Effort tiers with a published cost range** and an API trigger.
7. **Offline benchmark discipline** (ReviewBench, with a validated-by-senior-engineers label set) that predicted production A/B gains.

## 3. Limitations and gaps SpecGuard can exploit

- **No traceability model.** Requirements are free-text context; there is no spec-item to code to test mapping, no "this requirement has no test" verdict, no coverage-of-acceptance-criteria view. (Inferred from docs; no documented feature.)
- **No test-gap analysis and no test execution** documented. Reviewer reasons about code, not about what the changed behaviour lacks in tests.
- **Non-determinism and repetition**: third-party reports of different findings on re-request, and re-posting of dismissed comments (the repeat behaviour is in GitHub docs; the 5/3/6 variance anecdote is third-party, UNVERIFIED).
- **No evidence ledger.** Comments are prose + suggestion; no machine-checkable citation (file:line of the requirement, of the missing test) and no reproducible stable IDs.
- **Cost opacity**: USD 0.25-5 per Balanced review on Actions+credits, with a wide range; SpecGuard can publish a hard per-PR token budget.
- **Cannot be tuned in format** (instructions cannot change comment UX), so a team cannot get a gating status, SARIF or JSON output from it.
- **Weak on out-of-file context** per outside studies (see below); vendor-sponsored, so discount.
- Human replies are invisible to it, so no learning loop inside the PR thread.

## 4. Design ideas for SpecGuard

| # | Idea | What Copilot does | Why it serves SpecGuard | Risk | Measure |
|---|---|---|---|---|---|
| 1 | Post nothing when no finding clears a confidence/evidence bar; no summary filler | Posts nothing on 29% of reviews | Core of low noise | Silent failures read as "all clear"; use a status check that says "0 gaps, N requirements checked" | Rate of empty runs; maintainers' perceived trust; missed-gap rate on seeded repos |
| 2 | Severity (High/Med/Low) defined by traceability rules (e.g. High = acceptance criterion with zero test touching changed code) | Model-judged severity label | Deterministic severity is auditable | Over-rigid | Agreement between severity and human triage on replay set |
| 3 | Group findings per requirement, one comment per root cause | Groups repeated comments | Fewer comments, less token spend | Merging unrelated issues | Comments per PR; resolved rate |
| 4 | Suggest a concrete test skeleton in a `suggestion` block or a collapsible stub | One-click suggested fix | Converts a gap into an action | Wrong test API guesses | Accept/apply rate; compile pass rate of stubs |
| 5 | Evidence line on every finding: requirement ID + file:line + the test search that found nothing | Prose explanation only | Differentiator, enables verification | Longer comments | Fraction of findings with checkable evidence; reviewer verification time |
| 6 | Effort tiers: tier 0 = deterministic mapping (no LLM), tier 1 = LLM only on unresolved items | Lite/Balanced model tiers | Token cost control | Tier-0 misses naming conventions | Tokens per PR; recall tier0 vs tier1 |
| 7 | Read instructions from head branch; spec-mapping config in repo, path-scoped | `applyTo` instructions | Same ergonomics; testable in-PR | Config drift | Config PR dry-run success |
| 8 | Do not re-post dismissed findings (stable finding fingerprint) | Re-posts dismissed comments | Direct annoyance fix | Fingerprint collisions | Re-post count across pushes |
| 9 | Evaluate on a ReviewBench-style labelled set plus own SZZ replay | ReviewBench grounded/augmented metrics | Credible precision/recall claims | Benchmark overfitting (GitHub itself notes this) | Precision/recall/F-beta weighted to precision |
| 10 | Coexist: run alongside Copilot, never duplicate generic bug comments | Generic bug/security/style | Positioning: complementary | Overlap | Share of SpecGuard comments also made by Copilot (target near 0) |

## 5. Facts table

| Fact | Value | URL |
|---|---|---|
| Agentic architecture GA | 2026-03-05, Pro/Pro+/Business/Enterprise | https://github.blog/changelog/2026-03-05-copilot-code-review-now-runs-on-an-agentic-architecture/ |
| API + default effort | REST/GraphQL, per-request effort; Balanced default from 2026-09-28 | https://github.blog/changelog/2026-10-02-copilot-code-review-api-support-and-new-default-effort-level |
| Severity + grouping | High/Med/Low; grouped comments, 2026-05-12 | https://github.blog/changelog/2026-05-12-copilot-code-review-comment-experience-improvements |
| Volume | 60M reviews; 1 in 5 GitHub reviews; 12,000+ orgs | https://github.blog/ai-and-ml/github-copilot/60-million-copilot-code-reviews-and-counting/ |
| Quality (GitHub-reported) | 71% actionable; 29% silent; 5.1 comments/review; +6% positive feedback for 16% more latency | same |
| Cost estimate | Lite USD 0.05-1; Balanced 0.25-5 | https://docs.github.com/en/copilot/concepts/agents/code-review |
| Excluded files | lockfiles/dependency manifests, logs, SVG | same |
| Instruction files | copilot-instructions.md, `*.instructions.md` with applyTo, AGENTS.md; head branch; ~1,000 line guidance | https://docs.github.com/en/copilot/tutorials/customize-code-review |
| Unsupported in instructions | change comment format, overview, external links | https://github.blog/ai-and-ml/unlocking-the-full-power-of-copilot-code-review-master-your-instructions-files/ |
| Approvals | public preview, off by default | https://docs.github.com/en/copilot/how-tos/use-copilot-agents/request-a-code-review/use-code-review |
| ReviewBench | 2026-10-05; 219 PRs, 187 repos, 19 languages; grounded + augmented metrics; Claude Sonnet 5 judge; 96.6% senior-engineer agreement; no Copilot leaderboard numbers retrieved | https://github.blog/ai-and-ml/github-copilot/reviewbench-an-open-benchmark-for-ai-code-review/ |
| ReviewBench lite A/B | addressed +8.0%, recall +13.6%, comments +61%, cost per review -8.0% | https://www.nxcode.io/resources/news/github-reviewbench-ai-code-review-precision-recall-2026 (secondary) |
| Third-party: Greptile (vendor) | catch rate Greptile 82, Cursor 58, Copilot 54, CodeRabbit 44 (via aggregator; vendor-run, UNVERIFIED) | https://www.greptile.com/benchmarks |
| Third-party: Signal65 | Copilot lowest precision (64.35%), Cursor BugBot highest (95.95%); document is linked to CodeRabbit marketing; PDF not parseable, numbers via search snippet only, UNVERIFIED | https://signal65.com/wp-content/uploads/2026/03/Signal65-Insights_Evaluating-AI-Code-Review-Tools.pdf |
| Third-party: Morph | Copilot F1 44.5 vs CodeRabbit 51.5; recall 36.7 vs 52.5; precision 56.5 vs 50.5 (competitor-authored, UNVERIFIED; page returned 429 on direct fetch) | https://www.morphllm.com/comparisons/coderabbit-vs-copilot |
| Responsible-use | may miss problems in large/complex changes; hallucinated findings | https://docs.github.com/en/copilot/responsible-use/code-review |

Not found: any independent (non-vendor) precision/recall evaluation of Copilot review; a published "comment acceptance rate" beyond GitHub's "addressed rate" in A/B tests. "Copilot coding agent follow-ups" (agent opening fix PRs from review comments, "public preview" in the concept doc) is only lightly documented; details UNVERIFIED.

## 6. Inferred behavioural conventions and stand-in prompt

Inferred (not official; derived from docs/changelogs above and from third-party descriptions of comment shape):
- One overview comment (what the PR does, optionally a file table), then inline comments anchored to a line range.
- Each inline comment: severity label (High/Medium/Low), short problem statement, why it matters, then a `suggestion` block when a fix is local and small.
- Related occurrences are merged into one comment rather than repeated.
- Review state is always "Comment". No praise, no filler. Zero comments if nothing found.
- Typically about 5 comments per review (avg 5.1), skewed to correctness and maintainability over style.
- Neutral, impersonal, imperative tone; no questions to the author unless intent is ambiguous.

Draft stand-in prompt (INFERRED, NOT OFFICIAL; for SpecGuard A/B comparison only):

```
You are a pull request reviewer. Review only the changes in this PR, using the repository files you can read for context. Report only issues you are confident are real and that the author would want to fix.

Priorities, in order: correctness bugs, security problems, reliability and error handling, maintainability issues with real consequence. Do not comment on formatting, naming taste, or anything a linter would catch. Do not praise. Do not restate the diff.

Output format:
1. If you find nothing worth reporting, output nothing at all.
2. Otherwise output a short overview (2-4 sentences: what the PR changes and the main risk), then a JSON list of comments.
3. Each comment has: path, start_line, end_line, severity ("High" | "Medium" | "Low"), body, and optional suggestion (exact replacement lines for the range).
   - body: one or two sentences naming the problem and why it matters. No headings, no bullet lists.
   - Include a suggestion only when the fix is local, small and you are sure it compiles and preserves behaviour.
4. One comment per root cause. If the same problem appears in several places, make one comment on the first occurrence and mention the other locations by file and line.
5. Aim for at most 5 comments. If you have more, keep the highest severity ones.
6. Severity: High = likely bug, data loss, security hole, or crash; Medium = incorrect in some conditions or missing handling that will bite later; Low = minor maintainability or robustness.
7. Do not repeat a finding that already appears in the existing review comments provided to you.
8. Never claim you ran code or tests. If a conclusion depends on code you could not see, say so briefly or drop the comment.

Follow any repository instructions provided below, treating path-specific instructions as applying only to matching files.
```

## 7. Decision-relevant takeaways

See the final report returned alongside this file. Biggest open question: Copilot's actual traceability behaviour when a linked issue lists acceptance criteria; recommend a 10-PR bake-off using the stand-in prompt and a real Copilot run on the same PRs.
