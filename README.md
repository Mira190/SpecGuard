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
- **Large PRs are reviewed in focus.** Time and cost grow with how much the model reads, so past 600 changed lines or 25 changed files SpecGuard ranks the changed files by risk before the model runs (logic over config, docs and generated files; more changed lines; no test found; named by a requirement; removed branch and error-handling lines) and reviews only the top 12 whose diff fits, plus their changed tests. The model is told to read only about 20 files beyond the diff. The summary says "Large PR: focused review of N of M files (highest risk first); not reviewed: ...", the run is marked incomplete (not reduced, not failed) so the next push reviews again, and the hidden counts carry `focused: {files, of}`. Split the PR or raise `focus_threshold` to review more.
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
- **Never make SpecGuard a required check, and never put `paths:` on its trigger.** A skipped workflow leaves a required check pending, a merge queue (`merge_group`) gets no result, and a superseded push cancels the older run. It is advisory and always green. The same goes for "Require conversation resolution": its review threads are advisory, so `resolve_stale` is off by default (the job token cannot resolve threads); where that branch-protection rule is on, give the action a `github_token` that can resolve threads and set `resolve_stale: "true"`, or developers must resolve each thread by hand.
- **Least-privilege permissions** (job-level; `github_token` and `copilot-requests` as below):

| Mode | Permissions |
|---|---|
| PR review | `contents: read`, `pull-requests: write`, `issues: read`, `copilot-requests: write` (Copilot only) |
| PR review with `standards_checks` | the above plus `checks: read`, `statuses: read` |
| Unit test gap scan | `contents: read`, `copilot-requests: write` |
| Unit test gap scan with `scan_issue: true` | the above plus `issues: write` |

- **Bursts of pushes:** SpecGuard re-checks the PR head right before calling the model, so a run superseded by a newer push costs no credits (the example's `concurrency` group cancels it anyway). If your team pushes in quick bursts, an optional first step coalesces them:

  ```yaml
  - name: Wait for a push burst to settle
    run: sleep 60
  ```

- **Cost control:** put the Copilot usage in a cost center with a budget and "stop usage when budget is reached", and lower `copilot_max_ai_credits` (the worst case per push is about twice the cap: one turn plus one repair turn). Limit triggers: `ready_for_review` only instead of every `synchronize`, or a label gate in the job `if:`. There is no incremental review: every run reviews the whole PR diff.
- **Data handling:** Copilot content exclusion is not enforced by SpecGuard. Mirror excluded paths into `ignore` and set `ctx_retention_days: 0`: the `specguard-ctx` artifact holds the diff, prompt context and raw engine output, and anyone who can read the repository's Actions runs can download it (set `0` on public repositories).
- **Runner requirements:** bash, GNU `timeout`, git, node (installed by the Action), and reachability of the npm registry and the Copilot endpoints. Self-hosted runners behind a proxy need both allow-listed.
- **Supply chain:** the Action pins its CLI versions (`copilot_version`) and its third-party actions by SHA.

## Configuration

### Core inputs

| Input | Default | Meaning |
|---|---|---|
| `github_token` | `github.token` | Needs `pull-requests: write` (PR review). |
| `model` | Copilot Auto | Model name passed to the Copilot CLI (`auto` or a name of letters, digits and `. _ : [ ] -`). The models you can use depend on the token owner's Copilot plan (Free/Student: `auto` only); an unavailable model falls back to `auto` once, and the summary says so. |
| `effort` | Copilot default | `low`, `medium`, `high`, `xhigh` or `max`. Passed to Copilot as `--reasoning-effort`, only with an explicit non-`auto` model (Free and Student plans can only use `auto`, so effort never applies there; the summary notes "effort ignored: model auto"). |
| `max_comments` | `10` | Max inline comments (hard cap 30). |
| `requirements_paths` | | Globs, one per line, that add requirement documents to the ones found by content; `!glob` excludes noisy docs (e.g. `!docs/**`). Empty = content-based discovery only. |
| `standards_paths` | | Globs, one per line, that add coding-standard or review-guideline documents (e.g. `docs/testing-guidelines.md`) to the instruction files found automatically. Read from the base commit like every rule file; `!glob` excludes. |
| `test_paths` | | Globs or folders, one per line (`!glob` excludes), that are the authoritative unit-test locations: files there are the tests whatever their names, they are searched first, and the prompt says so. A bare name (`qa/checks`) is a file or a folder. Empty = tests are discovered by name and layout. |
| `standards_checks` | | Your own lint/format checks to report, `check:NAME` or `status:CONTEXT`, one per line. See [Standards evidence](#standards-evidence). |
| `mode` | `pr` | `pr` reviews a pull request; `scan` runs the unit test gap scan on the checked-out repository (`audit` is accepted as an alias). See [Unit test gap scan](#unit-test-gap-scan-whole-repository). |
| `scan_issue` | `false` | Scan mode: `true` also creates or updates one issue titled "SpecGuard: unit test gap scan" (needs `issues: write`). It is what lets a gap be confirmed across runs. |

<details>
<summary>Advanced inputs</summary>

| Input | Default | Meaning |
|---|---|---|
| `copilot_token` | | Fine-grained PAT (Copilot Requests), only if the job token cannot be used. |
| `engine` | `copilot` | The engine adapter; `copilot` (Copilot CLI) is the only one. Any other value fails the step. See [Engines](#engines). |
| `auto_tier` | `intelligence` | Copilot Auto routing profile when `model` is empty or `auto`: `intelligence` (default), `balance`, `efficiency`, or empty to omit. Ignored with a note if rejected; does not change which models your plan offers. |
| `fast_models` | | Extra model names treated as fast tier: exact names or `/regex/`, one per line or comma separated. Built-in: flash, mini, haiku, nano, lite, small. |
| `copilot_max_ai_credits` | `60` | Copilot soft cap on AI credits per turn, integer 30-2000. A run is one turn plus at most one repair turn on the same session, so the worst case per push is about twice this. |
| `review_timeout_minutes` | `12` | Engine time limit, a positive integer (a timeout is reported as such, not as a green review). The job `timeout-minutes` must exceed it by at least 3. |
| `max_diff_kb` | `300` | Above this the diff is cut at file boundaries: whole files that fit are reviewed, the dropped files are listed, and the run is marked incomplete. |
| `focus_threshold` | `600,25` | Large-PR gate as `lines,files`: a PR with more changed lines or more changed files gets a focused review (see above). `off` disables it. |
| `focus_files` | `12` | Most files a focused review covers, riskiest first (their diffs must also fit about 60% of the prompt diff budget). |
| `ignore` | | Extra ignore globs, one per line, added to the defaults (lockfiles, `dist/`, `build/`, `vendor/`, `node_modules/`, minified files, snapshots, generated code such as `*.pb.go` and `*.g.cs`, non-standard `.md`). |
| `standards_ref` | `head` | `head` or `merge`: the commit the `standards_checks` ran on. |
| `trace` | `auto` | `auto` links requirement docs and changed code in both directions when any requirement doc exists; `off` disables it. |
| `include_bots` | `false` | Bot-authored PRs (Dependabot, Renovate, any `[bot]` author) are skipped before the model runs; `true` reviews them. |
| `force` | `false` | A head SHA that already has a complete SpecGuard summary from this Action's own bot is skipped (an incomplete run records none, so it is retried) (idempotent rerun, no tokens spent); `true` reviews it again. Closed PRs are always skipped. |
| `ctx_retention_days` | `1` | Days to keep the `specguard-ctx-<PR>-<attempt>` artifact (diff, prompt context and raw engine output, for diagnosing a failed review). Anyone who can read the repo's Actions runs can download it: set `0` (no upload) on public repositories and wherever the diff must not be stored. |
| `resolve_stale` | `false` | `true` resolves SpecGuard's own review threads that have no replies and whose finding is no longer reported anywhere, including the summary (at most 20 per run), after a complete review (diff not truncated, engine finished, requirement collection and comment delivery not degraded). Enable it only with a `github_token` that can resolve review threads: the default `GITHUB_TOKEN` with `pull-requests: write` was refused in a live run ("Resource not accessible by integration"; for example a fine-grained PAT with Pull requests: write; adding `contents: write` to the job is unverified), and when the token is refused the summary says the threads were left open. Off by default because of "Require conversation resolution": where it is on, every unresolved advisory thread blocks the merge, and a token that cannot resolve means the developer must resolve each one by hand. Failures never fail the run. |
| `copilot_version` | `1.0.92` | Pinned `@github/copilot` (>= 1.0.85). |
| `scan_max_blocks` | `80` | Scan mode: most document blocks scanned per run, taken in document order; the rest are listed under not reviewed (integer 1-500). |
| `audit_max_requirements`, `audit_issue` | | Deprecated aliases of `scan_max_blocks` and `scan_issue`; when both names are set, the `scan_*` one wins. |
| `delivery`, `repository`, `pr_number`, `base_sha`, `head_sha` | | For [manual runs](#manual-run-specguard-repo) that review another repository on a `workflow_dispatch`: `delivery: summary` writes nothing to the PR (job summary only); the others replace what a `pull_request` event would supply. Leave them empty in your own workflow. |

</details>

## Engines

An engine is one script, `src/engines/<name>.sh`: it reads the prompt file and leaves `findings.json`, `usage.json`, `engine-status` and a few notes in the context directory; everything before it (collect, prompt) and after it (`post.js`) is engine-agnostic. The `engine` input is checked against an allow-list, then the action runs `src/engines/$ENGINE.sh`.

- `engine: copilot` (default and only): Copilot CLI, the answer is JSON in prose with one repair turn.

A Copilot SDK adapter was trialled on 2026-10-13 (it tied with the CLI) and removed; it can be restored from commit `58d8937`. The contract (inputs, output files, rules, how to add an engine) is in [src/engines/README.md](src/engines/README.md). Adding an engine means one script and one line in the allow-list; `post.js` does not change.

## Unit test gap scan (whole repository)

`mode: scan` is a repository-wide list of unit test gaps for QA, not a PR review and not a requirements audit: the design documents are the oracle, the output is the documented behaviour that lacks unit-test evidence. On demand or on a schedule it reads the design documents at the checked-out commit (found by content, plus `requirements_paths`), extracts the atomic behaviours they describe (descriptive design prose counts: "a repeating plan stays on after it fires" is a behaviour) and, for each, says whether it has unit-test evidence, only higher-level tests, no test, or looks unimplemented or contradicted by the code, or needs a human. (`mode: audit`, the earlier name, still works.) It is advisory and static: tests are not executed, the counts are not a coverage figure, and they are not for scoring people.

Run it on the default branch (that is the trusted base for rule and requirement files), not on a pull request:

```yaml
name: SpecGuard unit test gap scan
on:
  workflow_dispatch:
  schedule: [{ cron: "0 6 * * 1" }]
permissions:
  contents: read
  copilot-requests: write
  # issues: write # only with scan_issue: true
jobs:
  scan:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803 # v6.1.0
        with: { persist-credentials: false }
      - uses: Mira190/SpecGuard@<full-commit-sha>
        with:
          mode: scan
          review_timeout_minutes: 25
          copilot_max_ai_credits: "400"
          # scan_issue: "true"
```

The result is the job summary: one line per document block (link, text, block status, and its sub-rows' statuses; a block is a `gap` when any sub-row is `missing_test`, `partial`, `contradicted` or `not_implemented`, `covered` when all are, `unsure` otherwise) with counts by block status, the per-sub-row evidence in a collapsed table per document, the candidate documents that were not admitted ("add to `requirements_paths` to include"), and what was not reviewed (skipped documents, rows whose citation did not verify, the `scan_max_blocks` cap). Every citation is checked against the file at HEAD: a requirement whose quote is not found is moved to "not reviewed"; test or code evidence that is not found is removed and a `covered` row becomes `unknown`. `audit.json` (the validated result) stays in the `specguard-audit-<attempt>` artifact (`ctx_retention_days`). Reporting is per block and confirmed across runs, because a model's detail varies from run to run (the same commit scanned twice agreed on a block's gap about two times in three, and on individual sub-rows far less): with `scan_issue: true` the issue keeps a hidden per-block state, a gap is listed as **confirmed** only when the block was a gap in this run and the previous one (otherwise "new gap, unconfirmed"), a confirmed gap that is covered is "resolved? recheck next run" until it is covered twice, and "Changed since the last scan" lists only those two-run-stable changes plus a count of unstable blocks. Schedule the scan weekly so each run confirms the last; without `scan_issue` every gap stays unconfirmed (a [manual run](#manual-run-specguard-repo) is always one-off for this reason). With `scan_issue: true` the same report is written to a single issue (found by a hidden marker and authored by this action; whole rows are dropped, never cut, to fit GitHub's body limit).

Cost: the model reads every admitted document in full (at most 60), so a scan uses far more tokens than a PR review. Cap it with `copilot_max_ai_credits` (per turn), lower `scan_max_blocks`, narrow the documents with `requirements_paths` (`!glob` excludes), and raise `review_timeout_minutes` and the job `timeout-minutes` for large repositories.

## Manual run (SpecGuard repo)

`.github/workflows/specguard-run.yml` runs SpecGuard on demand against **another repository** from the SpecGuard repo's Actions tab (`workflow_dispatch`). It is not shipped to target repos; their own workflow stays the `pull_request` one above. The form has one required field and four optional ones:

| Input | Meaning |
|---|---|
| `target` (required) | A **PR link** reviews that PR. A **repo link**, `owner/name` or a **branch (tree) link** runs the unit test gap scan of that branch (the default branch when the link names none). |
| `design_docs`, `rules_docs`, `test_dirs` | Requirement/design documents, coding-standard documents and unit-test folders, one per line: repository paths, globs (`!` excludes), or github.com blob/tree links of the **same** repository. A folder (`docs/specs`) means everything under it. Empty = auto-discovery. They become `requirements_paths`, `standards_paths` and `test_paths`. |
| `post_to_pr` | PR links only, default off: results stay on the run page. On: the normal review and summary comment are also posted to the target PR. |

Model and effort are not on the form: the run uses Copilot Auto with `auto_tier: intelligence`. To pick a model or effort, use the action in your own workflow (`model`, `effort` above).

`src/resolve-inputs.js` turns the form into repository paths first. A link into another repository is rejected (copy the document into the target repository); a non-GitHub link (Confluence, Google Docs, ...) fails with "not readable from GitHub Actions; add the document to the repository or paste it". PR mode reviews an open PR (head and base from the API, checked out with `fetch-depth: 0`). With a token that can read the target, the resolver also looks up which part of a branch link is the branch name (branches may contain slashes: the longest existing branch or tag wins) and whether an extension-less path (`Makefile`, `docs/specs`) is a file or a folder; without access it reads the link literally (the first segment is the branch, a path without a trailing slash stays as given, so end a folder with `/`). Nothing is kept after the run (`ctx_retention_days` is `0`), and a scan has no issue.

**A manual scan is one-off.** The summary starts with "One-off scan: gaps are unconfirmed; schedule the scan in the target repo to confirm across runs." Two-run confirmation and "changed since the last scan" need state: put the [scan workflow](#unit-test-gap-scan-whole-repository) with `scan_issue: true` in the target repository on a schedule.

**Setup (do this once, in the SpecGuard repo).**

1. Settings > Environments > New environment `specguard`. Under "Deployment branches and tags" choose **Selected branches and tags** and allow only `main`. Both jobs of the workflow run in this environment, so a branch that edits the workflow or `src/` and is dispatched cannot start the job, and the token is never exposed to code that is not on `main`.
2. Put `SPECGUARD_PAT` in that environment's **secrets** (not in the repository secrets: the workflow never reads it outside the environment, and an environment secret of the same name would shadow a repository one anyway). The PAT is a fine-grained token whose resource owner is the target repos' owner, with **Contents: read, Issues: read, Pull requests: read** on the target repositories. Add **Pull requests: write** only if you will use `post_to_pr`. Without it the job token is used, which reads only the SpecGuard repository and public repositories. Copilot itself runs on the job token (`copilot-requests: write`). The checkout does not persist the token.
3. Keep the SpecGuard repository **private**, with access that is a subset of the access to every repository you point it at (collaborators who can already read the targets). The run page quotes the reviewed repository's code and requirement text, and anyone who can read the SpecGuard repo's Actions runs can read it (logs and summaries are kept 90 days). Artifacts are off for the same reason; do not add one.

SpecGuard itself is checked out next to the target in a path that must not exist (`.specguard-src`), after the target, and the job fails if the reviewed repository already has a path of that name; the review ignores that folder.

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
node bin/specguard-local.js --fail-on-gaps        # exit 1 when the validated review holds a unit test gap
node bin/specguard-local.js --requirements-paths 'docs/**' --requirements-paths '!docs/old/**' --standards-paths docs/testing.md --test-paths qa/ --ignore generated/
```

It reviews committed changes only (uncommitted work is ignored, with a warning), in a throwaway git worktree, so your checkout is untouched (Ctrl-C or `kill` removes the worktree too). A remote base such as `origin/main` is fetched first, so a branch that merged a newer main does not review main's commits; offline, it warns and uses the base you have. The PR text is your commit messages (or `--body FILE`); linked issues are unavailable offline.

Config parity with CI: `--requirements-paths`, `--standards-paths`, `--test-paths` and `--ignore` are the action inputs of the same names (repeat a flag for each line; `!glob` excludes). Copy them from your workflow; the runner does not read the workflow or any config file, and ignores `REQ_PATHS`-style environment variables.

The exit code is 0 unless the tool crashed (advisory), or 1 with `--fail-on-gaps`. The gate reads what the post step delivered after validation (citations verified, anchored to the diff): a high-confidence missing or weak unit test in the comments, or in the summary list when it is not marked "low confidence". Findings the validator drops never block.

It takes a few minutes and spends AI credits, so run it on demand, not on every push:

```sh
node path/to/SpecGuard/bin/specguard-local.js --fail-on-gaps
```

If you want a push gate, make it opt-in per push (`.git/hooks/pre-push`, made executable). It does nothing unless you ask:

```sh
#!/bin/sh
# SPECGUARD=1 git push   -> review first; a plain git push is untouched
[ "$SPECGUARD" = 1 ] || exit 0
node path/to/SpecGuard/bin/specguard-local.js --fail-on-gaps || { echo "SpecGuard found unit test gaps (push again without SPECGUARD=1 to skip)"; exit 1; }
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

Contributors: run `node --test src/*.test.js eval/*.test.js bin/*.test.js` from a POSIX shell (a bare `node --test` would also discover the `eval/cases` fixtures) and `bash -n src/collect.sh`. Keep `skills/test-review/` identical to `.github/skills/test-review/`; CI checks this. Changes to the report schema require matching validator, prompt and fixture updates. Older findings JSON without evidence and assessment fields is intentionally rejected as incomplete.

Design and rationale: [docs/design.md](docs/design.md).

## Credits

Rubric and approach are adapted from prior art, listed in [NOTICE](NOTICE).
