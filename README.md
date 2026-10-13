# SpecGuard

A GitHub Action that reviews pull requests for missing or weak unit tests. It maps the linked issue's acceptance criteria and the changed behaviour to test obligations, checks the repo's own coding standards, and flags logic that is only covered by integration tests but belongs in unit tests. The goal is to catch gaps on the PR, before QA does. It is advisory: it posts `COMMENT` reviews and never blocks a merge.

Coding standards come from your repo (Copilot/Claude/agent instruction files, `REVIEW.md`, `CONTRIBUTING.md`, `.editorconfig`). SpecGuard applies a framework-independent test-evidence rubric and reports which rules and test layers it assessed.

## Quick start

**1. Prerequisites**

- Org repo: an org owner enables the Copilot policy "Allow use of Copilot CLI billed to the organization", and allow-lists the action if Actions are restricted.
- Personal repo: the owner has a paid Copilot plan.

**2. Add this workflow** as `.github/workflows/specguard.yml`:

```yaml
name: SpecGuard
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
concurrency: { group: "specguard-${{ github.event.pull_request.number }}", cancel-in-progress: true }
permissions:
  contents: read
  pull-requests: write
  issues: read
  copilot-requests: write # Copilot billed to the org (org repo) or the owner's seat (personal repo)
jobs:
  review:
    if: ${{ !github.event.pull_request.draft && github.event.pull_request.head.repo.full_name == github.repository }}
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803 # v6.1.0
        with: { fetch-depth: 0, persist-credentials: false }
      - uses: Mira190/SpecGuard@<full-commit-sha> # pin a full commit SHA, not a branch or @v1 (the v1 tag predates the current behaviour)
```

Requirement documents anywhere in the repo (IDs such as `AC-4`, acceptance-criteria lists, Gherkin, "shall/must" sentences) are found by content, and a PR that changes one is reviewed. Historical intent is read via `git blame` and `gh api commits/{sha}/pulls`, which the default `contents: read`, `pull-requests` and `issues: read` permissions cover; if the API is unavailable the review notes a limitation and continues.

**3. Optional:** add standards files (e.g. `.github/copilot-instructions.md`) and link an issue with acceptance criteria by writing "Closes #N" in the PR body.

## What you get

- Inline comments from `github-actions[bot]` (or the App or PAT that posted them): test skeletons for missing tests, one-click suggested fixes for standard violations. Every test-gap comment ends with one fixed sentence ("Take the expected value from the requirement or an independent literal, not from the code under test."). A low-confidence finding says so in its bold title; there are no reaction buttons and no coding-agent prompt block. Kind, confidence and rule stay in a hidden HTML comment.
- The sticky summary (and the job summary, same text) follows the review goal: a one-line verdict, then **Unit test gaps** (one linked line per finding; findings that were not posted inline keep their full text there), **Requirements** (criteria table and spec mismatches), **Coding standards**, **Test layers** and **Not reviewed**. Reference material is collapsed at the end: the obligation/evidence table, the requirement-document to code Traceability table, pre-existing drift, validation notes and the sources read. Over the comment size limit, whole items are dropped from the end first and the summary says how many.
- A `<sub>` usage line when the engine ran: model, tokens (in, cached, out), cost and API time. Copilot cost is an estimate from AI credits (1 credit = $0.01); the billing API remains authoritative. Copilot has no schema enforcement, so an answer with missing or invalid JSON gets one repair turn on the same session, and its usage is added to the line.
- A `<sub>` "Since earlier reviews" line on a complete re-review: how many earlier findings are addressed, still open, dismissed or not observed. The labels are conservative: "addressed" means the anchored lines or a test file changed since the comment, never proof of a fix; "of the N most recent" appears when more earlier findings exist than were tracked.
- Hidden markers in the summary: `specguard:status` (`complete`, `incomplete` or `failed`), `specguard:by` (the login that posted it), `specguard:head` (written only for a complete run, so an incomplete head is retried) and `specguard:counts` (the telemetry behind the line above).
- The Action output `status` carries the same `complete` / `incomplete` / `failed` and is empty when the run was skipped. The job stays green in every case, so read this output (or the summary) to notice a failing setup.
- Separate coding-standard and test-layer assessments, including when no violations or pushdown candidates were found.
- `covered` requires a unit assertion; `higher_level_only` records component/integration/e2e evidence without counting it as unit coverage. Pushdown suggestions identify a public unit seam and preserve necessary integration checks.
- Unknown evidence, inaccessible issues and partial reviews remain visible. Empty findings never imply that requirements were fully reviewed.
- A diff over `max_diff_kb` is cut at file boundaries: whole files that fit are reviewed, the files that were dropped are listed in the summary, and the run is marked incomplete.
- Skipped with no AI call: docs-only and lockfile-only PRs, closed PRs, bot authors and heads that already have a complete summary. Default ignores include lockfiles, `dist/`, `build/`, `vendor/`, snapshots and generated code (`*.pb.go`, `*_pb2.py`, `*.g.cs`, `*.Designer.cs`, `*.generated.*`).
- A linked issue is found from "Closes #N" in the PR body, and from the branch name only by explicit markers: `issue-N`, `issues/N`, `gh-N`, or a leading `N-` (`123-fix-bug`).
- Advisory only: the job stays green.

The default Action runs the reviewer directly so it can require this complete report. It reads tests but does not execute PR code: `Unit evidence: X/Y` is a static assessment of the listed obligations, not measured code coverage or proof that tests pass. AI can miss or misinterpret behaviour; source-quote validation checks citation existence, not semantic correctness. Run your normal test/lint CI alongside it.

## Who pays

It is always the adopting repo's owner or org, never the action author's quota.

| Engine | Org repo | Personal repo |
|---|---|---|
| Copilot CLI (default) | the org, via the policy above | the owner's Copilot plan |
| Claude Code | the token owner's Claude subscription, or the API key | same |

Copilot usage is token-based, so cost grows with agent turns. Claude runs are capped by `max_budget_usd` and `max_turns`. The PR diff, PR and linked-issue text and any repo files the model reads are sent to GitHub Copilot or Anthropic, depending on the engine. The Copilot step unsets a job-level `GH_TOKEN` (Copilot CLI would prefer it over the job token and hijack the auth).

## Rolling out in a company

- **Pin a full commit SHA**, not a branch or `@v1` (the `v1` tag predates this behaviour). Update it deliberately.
- **Org prerequisites:** an org admin enables Copilot CLI and the policy "Allow use of Copilot CLI billed to the organization" for `GITHUB_TOKEN` billing. Without it every PR shows "Could not complete" while the job stays green. Run a **canary PR** first and watch the `status` output (or the summary); alert on `failed`.
- **Never make SpecGuard a required check, and never put `paths:` on its trigger.** A skipped workflow leaves a required check pending, a merge queue (`merge_group`) gets no result, and a superseded push cancels the older run. It is advisory and always green.
- **Least-privilege permissions** (job-level; `github_token` and `copilot-requests` as below):

| Mode | Permissions |
|---|---|
| PR review | `contents: read`, `pull-requests: write`, `issues: read`, `copilot-requests: write` (Copilot only) |
| PR review with `standards_checks` | the above plus `checks: read`, `statuses: read` |
| Audit | `contents: read`, `copilot-requests: write` |
| Audit with `audit_issue: true` | the above plus `issues: write` |

- **Cost control:** put the Copilot usage in a cost center with a budget and "stop usage when budget is reached", and lower `copilot_max_ai_credits` (the worst case per push is about twice the cap: one turn plus one repair turn). Limit triggers: `ready_for_review` only instead of every `synchronize`, or a label gate in the job `if:`. There is no incremental review: every run reviews the whole PR diff.
- **Data handling:** Copilot content exclusion is not enforced by SpecGuard. Mirror excluded paths into `ignore` and set `ctx_retention_days: 0`: the `specguard-ctx` artifact holds the diff, prompt context and raw engine output, and anyone who can read the repository's Actions runs can download it (set `0` on public repositories).
- **Runner requirements:** bash, GNU `timeout`, git, node (installed by the Action), and reachability of the npm registry and the Copilot (or Anthropic) endpoints. Self-hosted runners behind a proxy need both allow-listed.
- **Supply chain:** the Action pins its CLI versions (`copilot_version`, `claude_version`) and its third-party actions by SHA.

## Configuration

| Input | Default | Meaning |
|---|---|---|
| `engine` | `auto` | `auto`, `copilot` or `claude`. `auto` picks Claude when a Claude credential is passed, else Copilot. |
| `claude_code_oauth_token` | | From `claude setup-token`. Selects Claude. |
| `anthropic_api_key` | | Alternative Claude credential. |
| `copilot_token` | | Fine-grained PAT (Copilot Requests), only if the job token cannot be used. |
| `github_token` | `github.token` | Needs `pull-requests: write`. |
| `model` | engine default | Model name passed to the CLI (`auto` or a name of letters, digits and `. _ : [ ] -`). Copilot: the models you can use depend on the token owner's Copilot plan (Free/Student: `auto` only); an unavailable model falls back to `auto` once, and the summary says so. |
| `effort` | engine default | `low`, `medium`, `high`, `xhigh` or `max`. Claude: `--effort`. Copilot: `--reasoning-effort`, passed only with an explicit non-`auto` model (Free and Student plans can only use `auto`, so effort never applies there; the summary notes "effort ignored: model auto"). |
| `copilot_max_ai_credits` | `60` | Copilot soft cap on AI credits per turn, integer 30-2000. A run is one turn plus at most one repair turn on the same session, so the worst case per push is about twice this. |
| `max_turns` | `30` | Agent turn cap (Claude only). |
| `max_budget_usd` | `2` | Spend cap per run (Claude only). |
| `review_timeout_minutes` | `12` | Engine time limit, a positive integer, for both engines (a timeout is reported as such, not as a green review). The job `timeout-minutes` must exceed it by at least 3. |
| `max_comments` | `10` | Max inline comments (hard cap 30). |
| `max_diff_kb` | `300` | Above this the diff is cut at file boundaries: whole files that fit are reviewed, the dropped files are listed, and the run is marked incomplete. |
| `ignore` | | Extra ignore globs, one per line, added to the defaults (lockfiles, `dist/`, `build/`, `vendor/`, `node_modules/`, minified files, snapshots, generated code such as `*.pb.go` and `*.g.cs`, non-standard `.md`). |
| `standards_checks` | | Your own lint/format checks to report, `check:NAME` or `status:CONTEXT`, one per line. See [Standards evidence](#standards-evidence). |
| `standards_ref` | `head` | `head` or `merge`: the commit those checks ran on. |
| `requirements_paths` | | Globs, one per line, that add requirement documents to the ones found by content; `!glob` excludes noisy docs (e.g. `!docs/**`). Empty = content-based discovery only. |
| `standards_paths` | | Globs, one per line, that add coding-standard or review-guideline documents (e.g. `docs/testing-guidelines.md`) to the instruction files found automatically. Read from the base commit like every rule file; `!glob` excludes. |
| `trace` | `auto` | `auto` links requirement docs and changed code in both directions when any requirement doc exists; `off` disables it. |
| `include_bots` | `false` | Bot-authored PRs (Dependabot, Renovate, any `[bot]` author) are skipped before the model runs; `true` reviews them. |
| `force` | `false` | A head SHA that already has a complete SpecGuard summary from this Action's own bot is skipped (an incomplete run records none, so it is retried) (idempotent rerun, no tokens spent); `true` reviews it again. Closed PRs are always skipped. |
| `ctx_retention_days` | `1` | Days to keep the `specguard-ctx-<PR>-<attempt>` artifact (diff, prompt context and raw engine output, for diagnosing a failed review). Anyone who can read the repo's Actions runs can download it: set `0` (no upload) on public repositories and wherever the diff must not be stored. |
| `resolve_stale` | `true` | After a complete review (diff not truncated, engine finished, requirement collection and comment delivery not degraded; an incomplete run says so in the summary), resolves SpecGuard's own review threads that have no replies and whose finding is no longer reported anywhere, including the summary (at most 20 per run). Resolving threads needs a token allowed to resolve review threads: the default `GITHUB_TOKEN` with `pull-requests: write` was refused in a live run ("Resource not accessible by integration"), so either pass a `github_token` that can (e.g. a fine-grained PAT with Pull requests: write; adding `contents: write` to the job is unverified), or rely on the summary's "Since earlier reviews" line; when the token is refused the summary says the threads were left open. Failures never fail the run. `false` disables it. |
| `copilot_version` | `1.0.92` | Pinned `@github/copilot` (>= 1.0.85). |
| `claude_version` | `2.1.290` | Pinned `@anthropic-ai/claude-code` (>= 2.1.205). |
| `mode` | `pr` | `pr` reviews a pull request; `audit` audits the checked-out repository against its requirement documents. See [Audit mode](#audit-mode). |
| `audit_max_requirements` | `80` | Audit mode: most document blocks audited per run, taken in document order; the rest are listed under not reviewed (integer 1-500). |
| `audit_issue` | `false` | Audit mode: `true` also creates or updates one issue titled "SpecGuard requirements audit" (needs `issues: write`). |

Claude engine:

```yaml
      - uses: Mira190/SpecGuard@<full-commit-sha>
        with:
          claude_code_oauth_token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
```

## Audit mode

`mode: audit` is a repository-wide risk list for QA, not a PR review. On demand or on a schedule it reads the requirement documents at the checked-out commit (found by content, plus `requirements_paths`), extracts the atomic requirements (descriptive design prose counts: "a repeating plan stays on after it fires" is a requirement) and, for each, says whether it has unit-test evidence, only higher-level tests, no test, or looks unimplemented or contradicted by the code, or needs a human. It is advisory and static: tests are not executed, the counts are not a coverage figure, and they are not for scoring people.

Run it on the default branch (that is the trusted base for rule and requirement files), not on a pull request:

```yaml
name: SpecGuard audit
on:
  workflow_dispatch:
  schedule: [{ cron: "0 6 * * 1" }]
permissions:
  contents: read
  copilot-requests: write
  # issues: write # only with audit_issue: true
jobs:
  audit:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803 # v6.1.0
        with: { persist-credentials: false }
      - uses: Mira190/SpecGuard@<full-commit-sha>
        with:
          mode: audit
          review_timeout_minutes: 25
          copilot_max_ai_credits: "400"
          # audit_issue: "true"
```

The result is the job summary: counts by status and by class, one table per requirement document (requirement, status, class, evidence links at the audited commit), the candidate documents that were not admitted ("add to `requirements_paths` to include"), and what was not reviewed (skipped documents, rows whose citation did not verify, the `audit_max_requirements` cap). Every citation is checked against the file at HEAD: a requirement whose quote is not found is moved to "not reviewed"; test or code evidence that is not found is removed and a `covered` row becomes `unknown`. `audit.json` (the validated result) stays in the `specguard-audit-<attempt>` artifact (`ctx_retention_days`). With `audit_issue: true` the same report is written to a single issue (found by a hidden marker and authored by this action; whole rows are dropped, never cut, to fit GitHub's body limit).

Cost: the model reads every admitted document in full (at most 60), so an audit uses far more tokens than a PR review. Cap it with `copilot_max_ai_credits` (per turn) or `max_budget_usd` and `max_turns` (Claude, raise them for large repositories), lower `audit_max_requirements`, narrow the documents with `requirements_paths` (`!glob` excludes), and raise `review_timeout_minutes` and the job `timeout-minutes` for large repositories.

## Standards evidence

The AI's standards review is static. To also show whether your real lint/format jobs passed, name them:

```yaml
permissions:
  contents: read
  pull-requests: write
  issues: read
  checks: read
  statuses: read
  copilot-requests: write
...
      - uses: Mira190/SpecGuard@<full-commit-sha>
        with:
          standards_checks: |
            check:lint
            status:ci/format
```

`check:NAME` matches a check run by name, `status:CONTEXT` a commit status by context. The state is read from the GitHub API on `standards_ref` (default: the PR head) and shown in the summary as "Standards tooling". It is independent of the AI: the model cannot set or override it, and SpecGuard never runs the tools or waits for them. Statuses:

| Status | Meaning |
|---|---|
| `passed` | every named check succeeded |
| `failed` | at least one failed, errored, was cancelled or timed out |
| `pending` | at least one has not finished |
| `not_found` | at least one named check or status does not exist on that commit |
| `unavailable` | could not be read: missing `checks: read` / `statuses: read`, a malformed entry, or an unusable `standards_ref` |
| `not_configured` | `standards_checks` is empty |
| `incomplete` | all found, none failed or pending, but not all succeeded (for example skipped or neutral) |

Anything other than `passed` or `not_configured` stops the summary from saying "No test gaps found". Advisory only; the job stays green.

## Run locally

The review is a plain skill: [`skills/test-review/SKILL.md`](skills/test-review/SKILL.md), which loads detail from `skills/test-review/references/` only when needed. Copy the whole folder, not just `SKILL.md`. With no context directory it diffs against the default branch and prints a human-readable report.

```sh
claude -p "$(cat skills/test-review/SKILL.md skills/test-review/references/*.md) Review my branch against main." --tools "Read,Grep,Glob"
copilot -p "$(cat skills/test-review/SKILL.md skills/test-review/references/*.md) Review my branch against main."
```

To run it inside Copilot code review with no workflow, see [Use with native Copilot code review](#use-with-native-copilot-code-review).

## Use with native Copilot code review

Same skill, no workflow: Copilot code review (CCR) runs it and posts the comments itself.

1. Enable automatic Copilot code review: the user setting, or a ruleset with "Review new pushes".
2. Install the skill and the instructions file:

```sh
gh skill install Mira190/SpecGuard test-review --dir .github/skills
mkdir -p .github/instructions && curl -fsSL https://raw.githubusercontent.com/Mira190/SpecGuard/main/ccr/test-review.instructions.md -o .github/instructions/test-review.instructions.md
```

3. Commit both files. Runtime or user-scope installs are ignored; CCR reads only what is committed.

| | Action mode | CCR mode |
|---|---|---|
| Rules read from | the base branch | the PR head, so a PR can weaken its own rules |
| Output | structured evidence table, explicit standards/layer assessments, capped and deduped comments | free-form comments and CCR's own overview |
| Skill used | always | chosen by the model |
| Requirements | PR plus linked issues | PR body; issues only if CCR fetches them |
| Usage and billing | the repo owner or org via the job token, plus Actions minutes | automatic reviews usually attribute usage to the author; organization pools, unlicensed-user and bot billing rules still apply |
| Setup | one workflow file | two committed files plus the CCR setting |

Use Action mode when you need the guarantees. Use CCR mode for zero-workflow adoption. Both can run together.

Native CCR remains optional. Its comments cannot reconstruct the complete obligation inventory or confirm unmentioned requirements. SpecGuard does not turn a zero-comment native review into a coverage pass. Author usage attribution does not mean the organization avoids charges; see [GitHub's billing rules](https://docs.github.com/en/copilot/concepts/agents/code-review#code-review-usage).

## Troubleshooting

- "Could not complete" in the summary: the engine failed, timed out or returned invalid JSON; the job stays green and the `status` output is `failed`. Check the job log. Common causes are a missing `copilot-requests: write` permission or a Copilot policy that is not enabled.
- Fork and draft PRs are skipped: a fork's token is read-only and its code is untrusted.
- Review not posted, with warning annotations (403/404): the token lacks `pull-requests: write`. Findings appear as annotations and in the job summary instead.
- A false positive: open an issue with the finding, the cited rule or test line and why it is wrong. Add "do not report" rules to `REVIEW.md` meanwhile.

## Security model

`pull_request` only (never `pull_request_target`). No PR code is executed. The agent has read tools only, and rule and agent-config files are restored from the base commit so a PR cannot weaken its own rules or run its own hooks. CLI versions and third-party actions are pinned. The Claude step gets no GitHub token; the Copilot step authenticates with the job token, which also carries `pull-requests: write`, but the model only has view, glob and grep. All findings are filtered to the diff, redacted and capped before posting. The action refuses to run if `COPILOT_ALLOW_ALL` or `GITHUB_COPILOT_PROMPT_MODE_*` is set.

## How it works

1. `src/collect.sh` gathers the diff, applies ignores and restores rule files from base. `src/requirements.js` fetches PR text plus up to 5 linked issues, preserving cross-repository references and recording unavailable or omitted context in `requirements-status.json`.
2. The action builds the prompt by concatenating `SKILL.md` (frontmatter stripped) and every `skills/test-review/references/*.md` under a `# references/<name>` header, because the model can only read the workspace, not the action's own files. One read-only agent run follows it and returns JSON matching `src/findings.schema.json`.
3. `src/post.js` validates assessment fields and obligation/finding consistency, verifies behaviour and assertion quotes, and checks cited rules against the base inventory. It routes weak assertions outside the diff to the summary, dedupes comment delivery without removing current gaps, and checks the live PR HEAD before publishing.

Before step 1, `src/preflight.js` skips the run (one log line, green job, no model tokens) for a closed PR, a bot author or an already-reviewed head SHA. `src/standards-map.js` records where each base-branch rule file applies (`applyTo`, `paths:`, directory-scoped `AGENTS.md`/`CLAUDE.md`) in `standards-map.json`; a standards finding that cites a rule not covering its file is dropped with a note. The sticky summary ends with collapsed reference sections, the last being "Sources read".

Contributors: run `node --test src/*.test.js eval/*.test.js` from a POSIX shell (a bare `node --test` would also discover the `eval/cases` fixtures) and `bash -n src/collect.sh`. Keep `skills/test-review/` identical to `.github/skills/test-review/`; CI checks this. Changes to the report schema require matching validator, prompt and fixture updates. Older findings JSON without evidence and assessment fields is intentionally rejected as incomplete.

Design and rationale: [docs/design.md](docs/design.md).

## Credits

Rubric and approach are adapted from prior art, listed in [NOTICE](NOTICE).
