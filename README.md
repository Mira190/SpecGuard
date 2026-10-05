# SpecGuard

A PR reviewer that maps requirements and changed behaviour to unit-test obligations, finds missing or weak tests, checks the repo's own coding standards, and flags logic that should be unit-tested instead of only integration-tested. Advisory: it posts `COMMENT` reviews and never blocks a PR.

SpecGuard brings no rules of its own. The standard is whatever the repo already has (Copilot/Claude/agent instruction files, `REVIEW.md`, `CONTRIBUTING.md`, `.editorconfig`). It knows no language or framework.

## Adopt

Copy [`examples/specguard.yml`](examples/specguard.yml) to `.github/workflows/specguard.yml` and replace `OWNER`. Same-repo, non-draft PRs only; fork PRs are skipped (the token would be read-only, and the PR is untrusted).

## Engines and billing

| Engine | Setup | Billed to |
|---|---|---|
| Copilot CLI (default) | none; the workflow grants `copilot-requests: write` | the org (org repo, policy "Allow use of Copilot CLI billed to the organization") or the owner's Copilot seat (personal repo). Usage is token-based AI Credits, so cost grows with agent turns. |
| Claude Code | secret `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`) or `anthropic_api_key` | the token owner's Claude subscription (every push draws on that person's interactive quota) or the API key |

`engine: auto` uses Claude when a Claude credential is passed, else Copilot. Pass `copilot_token` (fine-grained PAT, Copilot Requests) only if the job token cannot be used. Cost per PR is not measured yet; Claude runs are capped by `max_budget_usd` (default 2) and `max_turns`.

Data sent: the PR diff, PR/linked-issue text and any repo files the model reads go to GitHub Copilot or Anthropic, depending on the engine.

## Inputs

`engine`, `claude_code_oauth_token`, `anthropic_api_key`, `copilot_token`, `github_token`, `model`, `max_turns`, `max_budget_usd`, `max_comments` (default 10, hard cap 30), `max_diff_kb` (300), `ignore` (extra globs, one per line; defaults cover lockfiles, `dist/`, `build/`, `vendor/`, `node_modules/`, minified files, snapshots, non-standard `.md`), `copilot_version`, `claude_version` (pinned CLI versions). See [`action.yml`](action.yml).

## What it does

1. `collect.sh`: diff (merge-base), ignore filter, then restores the repo's rule files and agent config (`.claude/`, `.mcp.json`, hooks, ...) from the base commit so a PR cannot weaken its own rules or run its own hooks. Gathers PR and linked-issue text (sanitised). The workspace is left at the PR head with rule/config files restored from base.
2. One read-only agent run (`Read/Grep/Glob` or Copilot `view/glob/grep`, no shell) using [`skills/specguard/SKILL.md`](skills/specguard/SKILL.md). Output must match [`findings.schema.json`](findings.schema.json).
3. `post.js`: validates, drops findings outside the diff or with bad rule citations, dedupes by fingerprint, and posts one inline review plus a sticky summary comment (coverage table, collapsed low-confidence items) and the job summary.

## Degradation

- Nothing reviewable (lockfiles/docs only): skipped, no AI call, summary says so.
- Engine failure or invalid JSON: summary says "could not complete", job stays green.
- Diff over `max_diff_kb`: truncated, summary says "partially reviewed".
- A finding outside any diff hunk: file-level comment (high confidence, max 3) or summary only.
- Review rejected (422): retried once as a body-only review. 403/404: `::warning` annotations plus the job summary.

## Run locally (earliest shift-left)

Use the same skill with your own CLI: `claude -p "$(cat skills/specguard/SKILL.md) Review my branch against main." --tools "Read,Grep,Glob"`, or `copilot -p ...` with the skill in `.github/skills/specguard/`.

## Lite tier

Copy `skills/specguard` to `.github/skills/` and native Copilot code review will pick it up. No workflow, but no guarantees: it reads instructions from the PR head, output is free-form, and it is not deduped or capped.

## Reporting false positives

Open an issue with the finding text, the cited rule/test line and why it is wrong. Add "do not report" rules to your `REVIEW.md` to silence a class meanwhile.

## Safety

`pull_request` only (never `pull_request_target`), no PR code is executed, the agent has read tools only, CLI versions and third-party actions are pinned, the Copilot step's job token also carries `pull-requests: write` but only `view`/`glob`/`grep` are exposed to the model, and the Claude step receives no GitHub token; all findings are filtered to the diff, redacted and capped before posting. The action refuses to run if `COPILOT_ALLOW_ALL` or `GITHUB_COPILOT_PROMPT_MODE_*` is set.

Rubric credits: see [NOTICE](NOTICE).
