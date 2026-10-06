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
      - uses: Mira190/SpecGuard@v1 # pin a full commit SHA instead of the tag for supply-chain safety
```

**3. Optional:** add standards files (e.g. `.github/copilot-instructions.md`) and link an issue with acceptance criteria by writing "Closes #N" in the PR body.

## What you get

- Inline comments from `github-actions[bot]`: test skeletons for missing tests, one-click suggested fixes for standard violations.
- A sticky summary maps each requirement or changed behaviour to an obligation, an exact behaviour citation, assertion quotes, test layers, and an explained status. Low-confidence items are collapsed in it.
- Separate coding-standard and test-layer assessments, including when no violations or pushdown candidates were found.
- `covered` requires a unit assertion; `higher_level_only` records component/integration/e2e evidence without counting it as unit coverage. Pushdown suggestions identify a public unit seam and preserve necessary integration checks.
- Unknown evidence, inaccessible issues and partial reviews remain visible. Empty findings never imply that requirements were fully reviewed.
- Docs-only and lockfile-only PRs are skipped with no AI call.
- Advisory only: the job stays green.

The default Action runs the reviewer directly so it can require this complete report. It reads tests but does not execute PR code: `Unit evidence: X/Y` is a static assessment of the listed obligations, not measured code coverage or proof that tests pass. AI can miss or misinterpret behaviour; source-quote validation checks citation existence, not semantic correctness. Run your normal test/lint CI alongside it.

## Who pays

It is always the adopting repo's owner or org, never the action author's quota.

| Engine | Org repo | Personal repo |
|---|---|---|
| Copilot CLI (default) | the org, via the policy above | the owner's Copilot plan |
| Claude Code | the token owner's Claude subscription, or the API key | same |

Copilot usage is token-based, so cost grows with agent turns. Claude runs are capped by `max_budget_usd` and `max_turns`. The PR diff, PR and linked-issue text and any repo files the model reads are sent to GitHub Copilot or Anthropic, depending on the engine.

## Configuration

| Input | Default | Meaning |
|---|---|---|
| `engine` | `auto` | `auto`, `copilot` or `claude`. `auto` picks Claude when a Claude credential is passed, else Copilot. |
| `claude_code_oauth_token` | | From `claude setup-token`. Selects Claude. |
| `anthropic_api_key` | | Alternative Claude credential. |
| `copilot_token` | | Fine-grained PAT (Copilot Requests), only if the job token cannot be used. |
| `github_token` | `github.token` | Needs `pull-requests: write`. |
| `model` | engine default | Model name passed to the CLI. |
| `max_turns` | `30` | Agent turn cap (Claude only). |
| `max_budget_usd` | `2` | Spend cap per run (Claude only). |
| `max_comments` | `10` | Max inline comments (hard cap 30). |
| `max_diff_kb` | `300` | Above this the review is partial. |
| `ignore` | | Extra ignore globs, one per line, added to the defaults (lockfiles, `dist/`, `build/`, `vendor/`, `node_modules/`, minified files, snapshots, non-standard `.md`). |
| `copilot_version` | `1.0.92` | Pinned `@github/copilot` (>= 1.0.85). |
| `claude_version` | `2.1.290` | Pinned `@anthropic-ai/claude-code` (>= 2.1.205). |

Claude engine:

```yaml
      - uses: Mira190/SpecGuard@v1
        with:
          claude_code_oauth_token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
```

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

- "Could not complete" in the summary: the engine failed or returned invalid JSON. Check the job log. Common causes are a missing `copilot-requests: write` permission or a Copilot policy that is not enabled.
- Fork and draft PRs are skipped: a fork's token is read-only and its code is untrusted.
- Review not posted, with warning annotations (403/404): the token lacks `pull-requests: write`. Findings appear as annotations and in the job summary instead.
- A false positive: open an issue with the finding, the cited rule or test line and why it is wrong. Add "do not report" rules to `REVIEW.md` meanwhile.

## Security model

`pull_request` only (never `pull_request_target`). No PR code is executed. The agent has read tools only, and rule and agent-config files are restored from the base commit so a PR cannot weaken its own rules or run its own hooks. CLI versions and third-party actions are pinned. The Claude step gets no GitHub token; the Copilot step authenticates with the job token, which also carries `pull-requests: write`, but the model only has view, glob and grep. All findings are filtered to the diff, redacted and capped before posting. The action refuses to run if `COPILOT_ALLOW_ALL` or `GITHUB_COPILOT_PROMPT_MODE_*` is set.

## How it works

1. `src/collect.sh` gathers the diff, applies ignores and restores rule files from base. `src/requirements.js` fetches PR text plus up to 5 linked issues, preserving cross-repository references and recording unavailable or omitted context in `requirements-status.json`.
2. The action builds the prompt by concatenating `SKILL.md` (frontmatter stripped) and every `skills/test-review/references/*.md` under a `# references/<name>` header, because the model can only read the workspace, not the action's own files. One read-only agent run follows it and returns JSON matching `src/findings.schema.json`.
3. `src/post.js` validates assessment fields and obligation/finding consistency, verifies behaviour and assertion quotes, and checks cited rules against the base inventory. It routes weak assertions outside the diff to the summary, dedupes comment delivery without removing current gaps, and checks the live PR HEAD before publishing.

Contributors: run `node --test` (Node 22) and `bash -n src/collect.sh`. Keep `skills/test-review/` identical to `.github/skills/test-review/`; CI checks this. Changes to the report schema require matching validator, prompt and fixture updates. Older findings JSON without evidence and assessment fields is intentionally rejected as incomplete.

Design and rationale: [docs/design.md](docs/design.md).

## Credits

Rubric and approach are adapted from prior art, listed in [NOTICE](NOTICE).
