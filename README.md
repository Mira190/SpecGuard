# SpecGuard

A GitHub Action that reviews pull requests for missing or weak unit tests. It maps the linked issue's acceptance criteria and the changed behaviour to test obligations, checks the repo's own coding standards, and flags logic that is only covered by integration tests but belongs in unit tests. The goal is to catch gaps on the PR, before QA does. It is advisory: it posts `COMMENT` reviews and never blocks a merge.

Coding standards come from your repo (Copilot/CLAUDE.md/agent instruction files, `REVIEW.md`, `CONTRIBUTING.md`, `.editorconfig`). SpecGuard applies a framework-independent test-evidence rubric and reports which rules and test layers it assessed.

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
- **Model choice (Copilot).** Pin `model` when your plan allows: an unavailable model falls back to `auto` once and the summary says so. With `auto` the router picks the model per prompt; the model actually used is recorded in `engine-model.json` (in the context directory) and shown in the usage line, marked `(fast tier)` when it matches a fast-tier name. A fast-tier model, a run whose JSON needed a repair turn, three or more engine notes, or more than a quarter of the obligations degraded by validation publishes a **reduced review**: a banner under the verdict names the reason and the model, at most 3 inline comments (high confidence with two verified citations), everything else as one-line items in the summary, never the "No test gaps found" wording, no auto-resolved threads, and no head marker so the next push retries.
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
| Copilot CLI | the org, via the policy above | the owner's Copilot plan |

Copilot usage is token-based, so cost grows with agent turns. The PR diff, PR and linked-issue text and any repo files the model reads are sent to GitHub Copilot. The Copilot step unsets a job-level `GH_TOKEN` (Copilot CLI would prefer it over the job token and hijack the auth).

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
- **Runner requirements:** bash, GNU `timeout`, git, node (installed by the Action), and reachability of the npm registry and the Copilot endpoints. Self-hosted runners behind a proxy need both allow-listed.
- **Supply chain:** the Action pins its CLI versions (`copilot_version`) and its third-party actions by SHA.

## Configuration

| Input | Default | Meaning |
|---|---|---|
| `engine` | `copilot` | The engine adapter: `copilot` (Copilot CLI) or `copilot-sdk` (Copilot SDK, opt-in). Any other value fails the step. See [Engines](#engines). |
| `copilot_token` | | Fine-grained PAT (Copilot Requests), only if the job token cannot be used. |
| `github_token` | `github.token` | Needs `pull-requests: write`. |
| `model` | Copilot default | Model name passed to the Copilot CLI (`auto` or a name of letters, digits and `. _ : [ ] -`). Copilot: the models you can use depend on the token owner's Copilot plan (Free/Student: `auto` only); an unavailable model falls back to `auto` once, and the summary says so. |
| `effort` | Copilot default | `low`, `medium`, `high`, `xhigh` or `max`. Passed to Copilot as `--reasoning-effort`, only with an explicit non-`auto` model (Free and Student plans can only use `auto`, so effort never applies there; the summary notes "effort ignored: model auto"). |
| `auto_tier` | `intelligence` | Copilot Auto routing profile when `model` is empty or `auto`: `intelligence` (default), `balance`, `efficiency`, or empty to omit. Ignored with a note if rejected; does not change which models your plan offers. |
| `fast_models` | | Extra model names treated as fast tier: exact names or `/regex/`, one per line or comma separated. Built-in: flash, mini, haiku, nano, lite, small. |
| `copilot_max_ai_credits` | `60` | Copilot soft cap on AI credits per turn, integer 30-2000. A run is one turn plus at most one repair turn on the same session, so the worst case per push is about twice this. |
| `review_timeout_minutes` | `12` | Engine time limit, a positive integer (a timeout is reported as such, not as a green review). The job `timeout-minutes` must exceed it by at least 3. |
| `max_comments` | `10` | Max inline comments (hard cap 30). |
| `max_diff_kb` | `300` | Above this the diff is cut at file boundaries: whole files that fit are reviewed, the dropped files are listed, and the run is marked incomplete. |
| `ignore` | | Extra ignore globs, one per line, added to the defaults (lockfiles, `dist/`, `build/`, `vendor/`, `node_modules/`, minified files, snapshots, generated code such as `*.pb.go` and `*.g.cs`, non-standard `.md`). |
| `standards_checks` | | Your own lint/format checks to report, `check:NAME` or `status:CONTEXT`, one per line. See [Standards evidence](#standards-evidence). |
| `standards_ref` | `head` | `head` or `merge`: the commit those checks ran on. |
| `requirements_paths` | | Globs, one per line, that add requirement documents to the ones found by content; `!glob` excludes noisy docs (e.g. `!docs/**`). Empty = content-based discovery only. |
| `test_paths` | | Globs or folders, one per line (`!glob` excludes), that are the authoritative unit-test locations: files there are the tests whatever their names, they are searched first, and the prompt says so. A bare name (`qa/checks`) is a file or a folder. Empty = tests are discovered by name and layout. |
| `standards_paths` | | Globs, one per line, that add coding-standard or review-guideline documents (e.g. `docs/testing-guidelines.md`) to the instruction files found automatically. Read from the base commit like every rule file; `!glob` excludes. |
| `trace` | `auto` | `auto` links requirement docs and changed code in both directions when any requirement doc exists; `off` disables it. |
| `include_bots` | `false` | Bot-authored PRs (Dependabot, Renovate, any `[bot]` author) are skipped before the model runs; `true` reviews them. |
| `force` | `false` | A head SHA that already has a complete SpecGuard summary from this Action's own bot is skipped (an incomplete run records none, so it is retried) (idempotent rerun, no tokens spent); `true` reviews it again. Closed PRs are always skipped. |
| `ctx_retention_days` | `1` | Days to keep the `specguard-ctx-<PR>-<attempt>` artifact (diff, prompt context and raw engine output, for diagnosing a failed review). Anyone who can read the repo's Actions runs can download it: set `0` (no upload) on public repositories and wherever the diff must not be stored. |
| `resolve_stale` | `true` | After a complete review (diff not truncated, engine finished, requirement collection and comment delivery not degraded; an incomplete run says so in the summary), resolves SpecGuard's own review threads that have no replies and whose finding is no longer reported anywhere, including the summary (at most 20 per run). Resolving threads needs a token allowed to resolve review threads: the default `GITHUB_TOKEN` with `pull-requests: write` was refused in a live run ("Resource not accessible by integration"), so either pass a `github_token` that can (e.g. a fine-grained PAT with Pull requests: write; adding `contents: write` to the job is unverified), or rely on the summary's "Since earlier reviews" line; when the token is refused the summary says the threads were left open. Failures never fail the run. `false` disables it. |
| `copilot_version` | `1.0.92` | Pinned `@github/copilot` (>= 1.0.85). |
| `copilot_sdk_version` | `1.0.15` | Pinned `@github/copilot-sdk`, installed only with `engine: copilot-sdk`. |
| `mode` | `pr` | `pr` reviews a pull request; `audit` audits the checked-out repository against its requirement documents. See [Audit mode](#audit-mode). |
| `audit_max_requirements` | `80` | Audit mode: most document blocks audited per run, taken in document order; the rest are listed under not reviewed (integer 1-500). |
| `audit_issue` | `false` | Audit mode: `true` also creates or updates one issue titled "SpecGuard requirements audit" (needs `issues: write`). |
| `delivery`, `repository`, `pr_number`, `base_sha`, `head_sha` | | For [manual runs](#manual-run-specguard-repo) that review another repository on a `workflow_dispatch`: `delivery: summary` writes nothing to the PR (job summary only); the others replace what a `pull_request` event would supply. Leave them empty in your own workflow. |

## Engines

An engine is one script, `src/engines/<name>.sh`: it reads the prompt file and leaves `findings.json`, `usage.json`, `engine-status` and a few notes in the context directory; everything before it (collect, prompt) and after it (`post.js`) is engine-agnostic. The `engine` input is checked against an allow-list, then the action runs `src/engines/$ENGINE.sh`.

- `engine: copilot` (default): Copilot CLI, the answer is JSON in prose with one repair turn.
- `engine: copilot-sdk` (opt-in): Copilot SDK pinned by `copilot_sdk_version`; the answer is the arguments of a `submit_review` tool, validated by the same validator as `post.js`. **Its authentication with the job `GITHUB_TOKEN` in Actions is unverified**: try it with `copilot_token` if the default fails, and compare results before relying on it (`eval/engine-ab.js` runs both on the same cases).

The contract (inputs, output files, rules, how to add an engine such as gh-aw) is in [src/engines/README.md](src/engines/README.md). Adding an engine means one script and one line in the allow-list; `post.js` does not change.

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

The result is the job summary: one line per document block (link, text, block status, and its sub-rows' statuses; a block is a `gap` when any sub-row is `missing_test`, `partial`, `contradicted` or `not_implemented`, `covered` when all are, `unsure` otherwise) with counts by block status, the per-sub-row evidence in a collapsed table per document, the candidate documents that were not admitted ("add to `requirements_paths` to include"), and what was not reviewed (skipped documents, rows whose citation did not verify, the `audit_max_requirements` cap). Every citation is checked against the file at HEAD: a requirement whose quote is not found is moved to "not reviewed"; test or code evidence that is not found is removed and a `covered` row becomes `unknown`. `audit.json` (the validated result) stays in the `specguard-audit-<attempt>` artifact (`ctx_retention_days`). Reporting is per block and confirmed across runs, because a model's detail varies from run to run (the same commit audited twice agreed on a block's gap about two times in three, and on individual sub-rows far less): with `audit_issue: true` the issue keeps a hidden per-block state, a gap is listed as **confirmed** only when the block was a gap in this run and the previous one (otherwise "new gap, unconfirmed"), a confirmed gap that is covered is "resolved? recheck next run" until it is covered twice, and "Changed since last audit" lists only those two-run-stable changes plus a count of unstable blocks. Schedule the audit weekly so each run confirms the last; without `audit_issue` every gap stays unconfirmed. With `audit_issue: true` the same report is written to a single issue (found by a hidden marker and authored by this action; whole rows are dropped, never cut, to fit GitHub's body limit).

Cost: the model reads every admitted document in full (at most 60), so an audit uses far more tokens than a PR review. Cap it with `copilot_max_ai_credits` (per turn), lower `audit_max_requirements`, narrow the documents with `requirements_paths` (`!glob` excludes), and raise `review_timeout_minutes` and the job `timeout-minutes` for large repositories.

## Manual run (SpecGuard repo)

`.github/workflows/specguard-run.yml` runs SpecGuard on demand against **another repository** from the SpecGuard repo's Actions tab (`workflow_dispatch`). It is not shipped to target repos; their own workflow stays the `pull_request` one above.

| Input | Meaning |
|---|---|
| `repo` (required) | `owner/name` or a github.com URL (a `.../pull/N` URL also sets `pr`). |
| `pr` | PR number to review. |
| `ref` | Branch, tag or SHA to audit (default: the default branch). |
| `design_docs`, `rules_docs`, `test_dirs` | Requirement/design documents, coding-standard documents and unit-test folders, one per line: repository paths, globs (`!` excludes), or github.com blob/tree URLs of the **same** repository. A folder (`docs/specs`) means everything under it. Empty = auto-discovery. They become `requirements_paths`, `standards_paths` and `test_paths`. |
| `mode` | `auto` (default: `pr` when `pr` is set, else `audit`), `pr` or `audit`. |
| `post_to_pr` | PR mode, default off: results go to the job summary only. On: the normal review and summary comment are posted to the target PR. |
| `model`, `effort` | As in the action. |

`src/resolve-inputs.js` turns the inputs into repository paths first. A URL of another repository is rejected (copy the document into the target repository); a non-GitHub URL (Confluence, Google Docs, ...) fails with "not readable from GitHub Actions; add the document to the repository or paste it". PR mode reviews an open PR (head and base from the API, checked out with `fetch-depth: 0`); audit mode audits `ref` or the default branch. There is no issue, and `ctx_retention_days` is `0`: no artifact is uploaded.

**The token.** For other private or internal repositories, add the repository secret `SPECGUARD_PAT` (without it the job token is used, which reads only the SpecGuard repository itself and public repositories): a fine-grained PAT whose resource owner is the target repos' owner, with **Contents: read, Issues: read, Pull requests: read** on the target repositories. Add **Pull requests: write** only if you will use `post_to_pr`. Copilot itself runs on the job token (`copilot-requests: write`). The checkout does not persist the token.

**Security rule.** The summary of a manual run quotes the reviewed repository's code and requirement text, and anyone who can read the SpecGuard repo's Actions runs can read it. Keep the SpecGuard repo's access a subset of the access to every repository you point it at (a private SpecGuard repo, collaborators who can already read the targets). Artifacts are off (`0` days) for the same reason; do not add one.

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

Recommended: the runner. It runs the same pipeline as CI before the PR exists: the real collector, prompt, Copilot CLI step (same safety flags) and post step, with citation checks and the summary, against a fake GitHub that prints instead of posting. Needs Node 22, git, bash and a logged-in [Copilot CLI](https://github.com/github/copilot-cli).

```sh
node bin/specguard-local.js                       # branch vs the remote default branch
node bin/specguard-local.js --base origin/develop --model auto --json
node bin/specguard-local.js --fail-on-gaps        # exit 1 when unit test gaps exist
```

It reviews committed changes only (uncommitted work is ignored, with a warning), in a throwaway git worktree, so your checkout is untouched. The PR text is your commit messages (or `--body FILE`); linked issues are unavailable offline. The exit code is 0 unless the tool crashed (advisory), or 1 with `--fail-on-gaps`. Options: `--base`, `--body`, `--model`, `--effort`, `--auto-tier`, `--json`, `--keep`.

As a pre-push hook (`.git/hooks/pre-push`, made executable):

```sh
#!/bin/sh
node path/to/SpecGuard/bin/specguard-local.js --fail-on-gaps || { echo "SpecGuard found unit test gaps (git push --no-verify to skip)"; exit 1; }
```

CI skips draft PRs by default: remove `!github.event.pull_request.draft` from the workflow `if` to review drafts too (costs one run per push).

Fallback without the runner: the review is a plain skill, [`skills/test-review/SKILL.md`](skills/test-review/SKILL.md), which loads detail from `skills/test-review/references/` only when needed. Copy the whole folder, not just `SKILL.md`. With no context directory it diffs against the default branch and prints a human-readable report, but has no deterministic collector, citation verifier or summary.

```sh
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

`pull_request` only (never `pull_request_target`). No PR code is executed. The agent has read tools only, and rule and agent-config files are restored from the base commit so a PR cannot weaken its own rules or run its own hooks. CLI versions and third-party actions are pinned. The Copilot step authenticates with the job token, which also carries `pull-requests: write`, but the model only has view, glob and grep. All findings are filtered to the diff, redacted and capped before posting. The action refuses to run if `COPILOT_ALLOW_ALL` or `GITHUB_COPILOT_PROMPT_MODE_*` is set.

## How it works

1. `src/collect.sh` gathers the diff, applies ignores and restores rule files from base. `src/requirements.js` fetches PR text plus up to 5 linked issues, preserving cross-repository references and recording unavailable or omitted context in `requirements-status.json`.
2. The action builds the prompt by concatenating `SKILL.md` (frontmatter stripped) and every `skills/test-review/references/*.md` under a `# references/<name>` header, because the model can only read the workspace, not the action's own files. One read-only agent run follows it and returns JSON matching `src/findings.schema.json`.
3. `src/post.js` validates assessment fields and obligation/finding consistency, verifies behaviour and assertion quotes, and checks cited rules against the base inventory. It routes weak assertions outside the diff to the summary, dedupes comment delivery without removing current gaps, and checks the live PR HEAD before publishing.

Before step 1, `src/preflight.js` skips the run (one log line, green job, no model tokens) for a closed PR, a bot author or an already-reviewed head SHA. `src/standards-map.js` records where each base-branch rule file applies (`applyTo`, `paths:`, directory-scoped `AGENTS.md`/`CLAUDE.md`) in `standards-map.json`; a standards finding that cites a rule not covering its file is dropped with a note. The sticky summary ends with collapsed reference sections, the last being "Sources read".

Contributors: run `node --test src/*.test.js eval/*.test.js` from a POSIX shell (a bare `node --test` would also discover the `eval/cases` fixtures) and `bash -n src/collect.sh`. Keep `skills/test-review/` identical to `.github/skills/test-review/`; CI checks this. Changes to the report schema require matching validator, prompt and fixture updates. Older findings JSON without evidence and assessment fields is intentionally rejected as incomplete.

Design and rationale: [docs/design.md](docs/design.md).

## Credits

Rubric and approach are adapted from prior art, listed in [NOTICE](NOTICE).
