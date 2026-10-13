# Native Copilot code review: can SpecGuard drive it?

Researched 2026-10-09. Primary sources only (docs.github.com, github.blog changelog, code.claude.com, raw GitHub). Page text was read through a fetch tool that summarises; sentences in quotes are what the tool returned from the page. Anything the fetch did not return is marked UNVERIFIED. Third-party material (community threads, demo repos) is labelled and never used as a verdict on its own.

## Short answer

- Native review CAN be requested from a workflow or script (REST, gh CLI, GraphQL; REST/GraphQL with an optional effort level since 2026-10-02).
- There is NO documented parameter to pass a custom prompt, schema or output format for a single review. The only per-request knob found is effort.
- Customisation is by repo files (instructions, skills, REVIEW.md, MCP). GitHub documents that format and summary instructions are ignored. So the native review cannot be made to emit SpecGuard's obligations/findings contract.
- Recommendation: keep SpecGuard on its own engine; coexist with native review (hybrid A). Do not post-process native comments (B). Offer a skill pointer only as an opt-in experiment (C).

## 0. Fact-check of the research report (ai-code-review-research-2026-10-09.md)

| Claim | Verdict | Evidence |
|---|---|---|
| (a) Agentic full-project context runs on Actions runners; degrades without them | VERIFIED | "Copilot uses GitHub Actions to run the agentic capabilities." "If GitHub Actions is unavailable or if Actions workflows used by Copilot code review fail, reviews will still be generated. However, they will not include the additional features provided by the agentic capabilities." https://docs.github.com/en/copilot/concepts/agents/code-review |
| (b) MCP context triggered by PR-description identifiers, skill descriptions, instructions | VERIFIED (paraphrase) | Fetch of how-to page: reviews use MCP when PR descriptions reference items (issue keys, incident IDs), skill directories have review-focused names, or instructions reference MCP context. https://docs.github.com/en/copilot/how-tos/use-copilot-agents/request-a-code-review/use-code-review (exact wording UNVERIFIED, summary only) |
| (b) GitHub MCP and Playwright MCP on by default | VERIFIED via search excerpt of changelog: "The GitHub and Playwright MCP will be turned on by default." Also "all MCP tool calls performed by Copilot code review will be limited to read-only." https://github.blog/changelog/2026-07-29-copilot-code-review-agent-skills-and-mcp-now-generally-available (the page fetch itself returned only the read-only sentence, so the default-on sentence is from the search excerpt) |
| (c) Reads CLAUDE.md / GEMINI.md / REVIEW.md / AGENTS.md | VERIFIED | Support table, GitHub.com code review: "AGENTS.md, CLAUDE.md, GEMINI.md or REVIEW.md files". https://docs.github.com/en/copilot/reference/custom-instructions-support |
| (c) Skills in .github/skills, .claude/skills, .agents/skills | VERIFIED | Project skills: ".github/skills", ".claude/skills", ".agents/skills". "If you want to ensure that Copilot code review will read and use a skill, use a review-focused skill directory name such as `code-review`." https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/customize-cloud-agent/add-skills |
| (d) Reads from head branch | VERIFIED | "Copilot reads repository custom instructions, agent instructions, and agent skills from the head branch (the branch with your changes), not the base branch." Same on the how-to and customize-code-review pages. |
| (e) Attribution + linked review session | VERIFIED | "check review comment bottoms for attributions showing which agent skill or MCP server was used" and "You can also open the linked review session from the pull request timeline, then check the session logs." how-to page; changelog 2026-07-29 confirms attribution. |
| (f) Re-review can repeat comments | VERIFIED | "When re-reviewing a pull request, Copilot may repeat the same comments again, even if they have been dismissed." how-to page. |
| (f) Excluded file types | VERIFIED | "Some file types are excluded...: Dependency management files, such as package.json and Gemfile.lock, Log files, SVG files." concepts/agents/code-review |
| (g) REVIEW.md read by finding, verification and ranking stages | VERIFIED (ranking is "consulted") | "The agents in the review pipeline that find and verify findings receive its contents as your repository's review instructions... and the agents that rank and report findings consult it before settling severity and writing the review." https://code.claude.com/docs/en/code-review |
| (g) Nit cap, re-review convergence, skip rules, summary shape | VERIFIED | Sections "Nit volume", "Skip rules", "Re-review convergence" ("after the first review, suppress new nits and post Important findings only"), "Summary shape" ("open with a one-line tally such as `2 factual, 4 style`"). Same page. |
| (g) Local /code-review does not read REVIEW.md | VERIFIED | "The review follows your `CLAUDE.md` like any Claude Code session, but it doesn't read `REVIEW.md`." Same page. |
| (g) New CLAUDE.md violations default to Nit | VERIFIED | "treats newly introduced violations as nit-level findings"; REVIEW.md may escalate. Same page. |
| (g, report 4.2) Default does not cover missing test coverage | VERIFIED | "Code Review focuses on correctness: bugs that would break production, not formatting preferences or missing test coverage." Same page. |
| (h) Plugin passes PR title+description to reviewers | VERIFIED | Raw file line 53: "each subagent should be told the PR title and description. This will help provide context regarding the author's intent." https://raw.githubusercontent.com/anthropics/claude-code/main/plugins/code-review/commands/code-review.md |
| (h) Per-type verifier model tiers | VERIFIED | Line 55: "Use Opus subagents for bugs and logic issues, and sonnet agents for CLAUDE.md violations." (Also haiku for eligibility/CLAUDE.md path discovery, sonnet for PR summary.) Line 85 excludes "lack of test coverage ... unless explicitly required in CLAUDE.md". |

Report errors / caveats found: none contradicted. One precision point: Anthropic managed review is per-review $15-25 average on usage credits (code.claude.com pricing section), not comparable to Copilot's per-review figures below.

## 1. Requesting a native review programmatically

| Method | Evidence | Status |
|---|---|---|
| gh CLI | "`gh pr create --reviewer @copilot` or `gh pr edit PR-NUMBER --add-reviewer @copilot`" (how-to page) | VERIFIED |
| REST | "You can also request a review from Copilot through the GitHub REST API by requesting `copilot-pull-request-reviewer[bot]` as a reviewer." Endpoint is the generic `POST /repos/{owner}/{repo}/pulls/{pull_number}/requested_reviewers`; its reference page lists only `reviewers` and `team_reviewers` and does not mention Copilot or effort. https://docs.github.com/en/rest/pulls/review-requests | VERIFIED request method; effort field name UNVERIFIED |
| REST + GraphQL with effort | "You can now request a review from Copilot using the supported REST and GraphQL APIs" and "optionally set the review effort level for that request." The changelog gives no endpoint, field names or auth. https://github.blog/changelog/2026-10-02-copilot-code-review-api-support-and-new-default-effort-level | VERIFIED existence; parameter shape UNVERIFIED |
| GraphQL `requestReviews` with `botIds` | Community thread only (not primary): bot id `BOT_kgDOCnlnWA` used to re-request after a review exists. https://github.com/orgs/community/discussions/186152 | UNVERIFIED (third party) |
| Auto-review | Repo branch rule: "Under 'Branch rules,' select **Automatically request Copilot code review**", plus "Review new pushes" and "Review draft pull requests". Personal setting added 2026-09-23. https://docs.github.com/en/copilot/how-tos/copilot-on-github/set-up-copilot/configure-code-review | VERIFIED |

Auth and billing:
- Can the job `GITHUB_TOKEN` do it? Not stated on any primary page I loaded. A third-party demo (github.com/amarun22-PS/copilot-code-review-api-demo) says `GITHUB_TOKEN` with `pull-requests: write` works and fine-grained PATs need "Pull requests: write". UNVERIFIED as a primary fact. The same 2026-10-02 changelog is silent on auth. A community thread reports `gh pr edit --add-reviewer "@copilot"` working with a PAT. Test before relying on it.
- Whose seat/quota: not stated for API-triggered requests. Docs: "Copilot code review is also available for organization members without a Copilot license, when enabled by an enterprise administrator or organization owner." Changelog 2026-08-27: for bot-authored PRs "there's no Copilot-licensed account to attribute the review to"; with the "members without a Copilot license" policy it bills "directly to your organization". That implies the review is otherwise attributed to a licensed account (the requester or PR author); the exact rule for API requests is UNVERIFIED.
- Cost components: "AI credits for the model interaction... and GitHub Actions minutes for the agentic capabilities." "A review typically consumes an estimated $0.05 USD to $1 USD worth of AI credits with 'Lite' effort, and $0.25 USD to $5 USD ... with 'Balanced' effort." "Self-hosted runners do not consume GitHub Actions minutes." (concepts page and configure page)
- Fork PRs: no statement on the Copilot pages I loaded. UNVERIFIED. (Contrast: Claude managed review never auto-reviews forks; needs `@claude review` by someone with write access.)
- Draft PRs: third-party issue reports REST request silently no-ops on drafts, `gh pr edit --add-reviewer @copilot` works. UNVERIFIED (third party).

## 2. Reading the result

- Events (`pull_request_review`, `pull_request_review_comment`) and the reviews API: nothing in primary docs about Copilot-specific payloads. Standard reviews/comments APIs apply by construction; a third-party demo verifies via `review_requested` timeline events and `/pulls/{n}/reviews`. UNVERIFIED for Copilot specifics (author login, whether a workflow triggered by the bot's review needs approval).
- Shape that IS documented: "By default, Copilot provides comments rather than approvals" (can approve if admins enable it, changelog 2026-09-01). Each comment gets a severity: "Copilot labels each comment with a severity level of 'High,' 'Medium,' or 'Low'" and "includes suggested changes which you can apply" (suggestion blocks). 2026-09-18 changelog: overview comment lists findings as "Open", "Resolved since last review", "Previously missed", comments have "concise titles". 2026-09-01: each review "includes an approval assessment within its overview comment".
- Structured output / custom prompt per review: none found. The REST endpoint takes only `reviewers`/`team_reviewers`; the only added option is effort (Lite/Balanced; "Max" shown as "Coming soon"). Verdict: no per-review prompt, schema or structured output is documented.
- Machine-readable severity exists only on the Claude managed side: a check-run text ends with `bughunter-severity: {...}` JSON (code.claude.com). Not available for Copilot.

## 3. What customisation controls

Controls (documented):
- `.github/copilot-instructions.md`, `.github/instructions/**/*.instructions.md` (`applyTo`, optional `excludeAgent: "code-review"`), AGENTS.md / CLAUDE.md / GEMINI.md / REVIEW.md, org instructions.
- Skills (`.github/skills`, `.claude/skills`, `.agents/skills`), used "automatically when relevant".
- MCP servers (read-only tool calls), repo-configured; GitHub and Playwright by default.
- Effort level (Lite/Balanced), automatic review rules, runner type ("standard GitHub-hosted runners... larger... or self-hosted").
- Toggle: "Use custom instructions when reviewing pull requests" in repo settings.

Cannot control (documented as ignored), https://docs.github.com/en/copilot/tutorials/customize-code-review: Copilot code review "currently ignores" instructions that try to change user experience/formatting ("Use bold text for critical issues"), modify the PR overview ("Include a summary of security issues in the PR overview"), alter core function ("Block a PR from merging unless..."), follow external links, or give vague directives. So summary shape, comment format and any output schema are out. Comment count and verdict are not controllable either (no documented knob; the effort level changes depth, not count).

Size limits: that page says "Limit any single instruction file to a maximum of about 1,000 lines. Beyond this, the quality of responses may deteriorate." A search-engine excerpt of docs.github.com claimed "only reads the first 4,000 characters of any custom instruction file", but the page text returned by my fetches did not contain it. UNVERIFIED; treat 4,000 characters as the conservative budget until checked in a browser.

Contrast: Claude managed review does let REVIEW.md control summary shape ("Summary shape"), nit cap, skip rules. Different product, different ceiling.

## 4. Hybrid design assessment

Context: docs/design.md already says "Native CCR is optional: its sparse comments cannot reconstruct a complete requirements/evidence table, so no hybrid coverage gate is introduced." The research confirms that.

| Option | Feasibility | Gain | Loss / risk | Verdict |
|---|---|---|---|---|
| A. Native for general bugs, SpecGuard for test gaps (separate runs) | High. Both already can run independently. Native is auto-review rule or `gh pr edit --add-reviewer @copilot`. | Bug coverage and agentic context without SpecGuard spending tokens on it; scoped product boundary (test obligations). | Duplicate/overlapping comments on test-related lines; two billing meters (AI credits + Actions minutes for native; Copilot/Claude for SpecGuard); native "may repeat the same comments" on re-review. | RECOMMENDED. Document coexistence; SpecGuard dedupes only against its own markers. |
| B. SpecGuard post-processes native comments into its findings contract | Low. Native output has no schema, free-text titles, severity High/Medium/Low, suggestion blocks; no obligation IDs or evidence citations. Reading Copilot reviews is possible but the content is unconstrained. | Would save one model call only if native already found test gaps (it does not target them; Claude's equivalent explicitly excludes missing test coverage by default). | Unparseable output; cannot satisfy design.md evidence contract (obligation IDs, assertion evidence, layers); trust problem if native text is promoted as "validated". Timing: native finishes asynchronously, SpecGuard would have to poll. | REJECT. |
| C. Install a `test-review` skill under `.github/skills` so native also does test-gap work | Medium. The repo already has `skills/test-review/SKILL.md` and `.github/skills/test-review`; skills load "automatically when relevant", best with a review-focused directory name. | Free (no extra SpecGuard token spend) test-gap hints inside the native review for repos that opt in. | Output is not controllable (format instructions ignored), so findings land as ordinary native comments with no evidence contract; native reads skills from the HEAD branch, so a PR author can alter the skill that reviews their PR (SpecGuard restores rule files from base for this reason); duplicates SpecGuard's comments; could double-count gaps. | OPTIONAL, opt-in experiment only; never a gate. |

Trust of head-branch instructions: confirmed behaviour ("from the head branch... not the base branch"). SpecGuard's collect step uses base-restored rule files, which native review cannot do. Any hybrid keeps SpecGuard's verdict independent of head-branch native instructions.

## 5. 2026 developments the user may have missed (changelog, all github.blog/changelog)

| Date | Entry | Relevance |
|---|---|---|
| 2026-06-18 | AGENTS.md support and UI improvements | Native now reads root AGENTS.md. |
| 2026-06-25 | Analysis depth and efficiency updates | Review moved to CLI file tools (`grep`, `rg`, `glob`, `view`) and cut review cost "by about 20%". Note: same tool family SpecGuard's Copilot engine uses (`--available-tools view,glob,grep`). |
| 2026-07-29 | Agent skills and MCP GA for code review | Skills in `.github/skills`; MCP read-only; attribution on comments; GitHub and Playwright MCP default-on (search excerpt). |
| 2026-08-07 | Effort levels GA (Lite, Balanced) | "Balanced reviews use more AI credits, and may consume marginally more GitHub Actions minutes." |
| 2026-08-27 | Bot-authored PRs, no size limit, resolution reasons | Removed the previous 300 files / 20,000 lines limit; billing to org for bot PRs when the no-licence policy is on. |
| 2026-09-01 | Copilot can approve PRs (public preview) | Approval assessment in overview; approvals count toward required reviews if enabled; auto-dismissed on new commits. SpecGuard stays COMMENT-only. |
| 2026-09-11 | Auto-resolution and analysis updates | Not read in detail (UNVERIFIED content). |
| 2026-09-18 | Improved review experience | Open / Resolved since last review / Previously missed overview; honours user replies; Won't Fix / Incorrect reasons. Mirrors what SpecGuard's sticky summary does. |
| 2026-09-23 | More ways to request and configure | Personal auto-review settings on all plans; enterprise default effort. |
| 2026-09-28 | Default effort changed to Balanced | Cost per native review rises (Balanced estimate $0.25-$5 vs Lite $0.05-$1). |
| 2026-10-02 | REST/GraphQL API support + effort | The enabling change for item 1. |
| 2026-09-25 | Usage metrics API adds pull request review stages | Possible way to measure native review spend; contents UNVERIFIED. |
| Claude side (code.claude.com) | July 2026: `@claude review` no longer subscribes to pushes; `@claude review always` does. Check run ends with machine-readable `bughunter-severity` JSON. Local `/code-review --max-findings`, `--comment`. | Informational; Claude managed review needs Team/Enterprise, billed on usage credits ($15-25/review average), no ZDR. |

Model availability in Copilot (Sonnet 5.5, GPT-6.1 Sol, Haiku 5.5, Sep-Oct) is listed but model selection for code review is NOT possible: "Model switching is not supported". Only effort is selectable.

## 6. Ranked adoption list for SpecGuard

| # | Item | Benefit | Token cost | Risk | How to test |
|---|---|---|---|---|---|
| 1 | Document coexistence with native review (hybrid A): README note, no code. State that SpecGuard owns test gaps/standards; native owns general bugs; no shared state. | Avoids user confusion, positions product | 0 | Low | Review of the README; run both on one seeded PR and check no marker collision |
| 2 | Measure overlap: a one-off eval script that requests native review on 5-10 seeded eval PRs (`gh pr edit --add-reviewer @copilot` with a PAT), then diffs comments vs `eval/grade.js` expectations | Evidence on whether native catches any test-gap case; decides whether C is worth shipping | 0 SpecGuard tokens; native ~$0.25-$5 per Balanced review | Low (eval only; keep out of src/) | Count seeded gaps hit by native; compare precision |
| 3 | Learn from native summary shape: Open / Resolved / Previously missed sections in the sticky summary | Better re-review UX | 0 | Low | Unit tests on summary renderer |
| 4 | Opt-in `.github/skills` pointer (option C) for repos that want native to mention test gaps too | Cheap extra signal | 0 for SpecGuard, native credits for the repo | Medium (head-branch skills, duplicates) | Eval from #2 with and without the skill |
| 5 | Use the usage metrics API pull request review stages to report native vs SpecGuard cost | Fills the "cost not measured" gap in design.md | 0 | Low; contents UNVERIFIED | Check API response on a real org |

## 7. Rejected

- Using native Copilot review as SpecGuard's engine: no custom prompt, no schema, no model selection, output format instructions ignored, async and unparseable.
- Post-processing native comments into the findings contract (B): no obligation/evidence data to map from; would violate design.md "unknown, never covered".
- Relying on custom instructions/REVIEW.md to force a summary format on Copilot: documented as ignored.
- Treating Copilot approvals or its approval assessment as a SpecGuard gate: SpecGuard is advisory COMMENT-only, and approvals are a separate preview feature.
- Adopting Claude managed Code Review as a dependency: Team/Enterprise only, no ZDR/HIPAA, $15-25 per review, excludes missing test coverage by default.
- Reading head-branch instructions/skills as authoritative policy: confirmed behaviour is head branch; SpecGuard keeps its base-restored rule inventory.
- Relying on `GITHUB_TOKEN` for programmatic Copilot review requests without a live test: no primary statement exists.

## Open items to verify in a live repo

1. Does `GITHUB_TOKEN` (`pull-requests: write`) request the review, and whose AI credits are billed.
2. Exact REST/GraphQL effort field name (changelog gives none).
3. Fork PR behaviour of native review.
4. The 4,000-character instruction cap (excerpt only) versus the documented ~1,000 lines.
5. Author login and event behaviour of Copilot's reviews for `pull_request_review` workflows.
