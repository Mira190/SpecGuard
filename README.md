# SpecGuard

A GitHub Action that reviews pull requests for missing or weak unit tests. It maps the linked issue's acceptance criteria and the changed behaviour to test obligations, checks the repo's own coding standards, and flags logic that is only covered by integration tests but belongs in unit tests. The goal is to catch gaps on the PR, before QA does. It is advisory: it posts `COMMENT` reviews and never blocks a merge.

SpecGuard brings no rules of its own. The standard is whatever your repo already has (Copilot/Claude/agent instruction files, `REVIEW.md`, `CONTRIBUTING.md`, `.editorconfig`). It knows no language or framework.

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
- A sticky summary comment with a requirement, test and status coverage table. Low-confidence items are collapsed in it.
- Docs-only and lockfile-only PRs are skipped with no AI call.
- Advisory only: the job stays green.

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

The review is a plain skill: [`skills/test-review/SKILL.md`](skills/test-review/SKILL.md). With no context directory it diffs against the default branch and prints a human-readable report.

```sh
claude -p "$(cat skills/test-review/SKILL.md) Review my branch against main." --tools "Read,Grep,Glob"
copilot -p "$(cat skills/test-review/SKILL.md) Review my branch against main."
```

Lite tier: copy `skills/test-review` to `.github/skills/` and Copilot code review can pick it up, with no workflow. No guarantees: it reads instructions from the PR head, output is free-form, and nothing is deduped or capped.

## Troubleshooting

- "Could not complete" in the summary: the engine failed or returned invalid JSON. Check the job log. Common causes are a missing `copilot-requests: write` permission or a Copilot policy that is not enabled.
- Fork and draft PRs are skipped: a fork's token is read-only and its code is untrusted.
- Review not posted, with warning annotations (403/404): the token lacks `pull-requests: write`. Findings appear as annotations and in the job summary instead.
- A false positive: open an issue with the finding, the cited rule or test line and why it is wrong. Add "do not report" rules to `REVIEW.md` meanwhile.

## Security model

`pull_request` only (never `pull_request_target`). No PR code is executed. The agent has read tools only, and rule and agent-config files are restored from the base commit so a PR cannot weaken its own rules or run its own hooks. CLI versions and third-party actions are pinned. The Claude step gets no GitHub token; the Copilot step authenticates with the job token, which also carries `pull-requests: write`, but the model only has view, glob and grep. All findings are filtered to the diff, redacted and capped before posting. The action refuses to run if `COPILOT_ALLOW_ALL` or `GITHUB_COPILOT_PROMPT_MODE_*` is set.

## How it works

1. `src/collect.sh` gathers the diff, applies ignores, restores rule files from base, and fetches PR and linked-issue text.
2. One read-only agent run follows `skills/test-review/SKILL.md` and returns JSON matching `src/findings.schema.json`.
3. `src/post.js` validates, drops findings outside the diff, dedupes, and posts one inline review plus the sticky summary.

Design and rationale: [docs/design.md](docs/design.md).

## Credits

Rubric and approach are adapted from prior art, listed in [NOTICE](NOTICE).
