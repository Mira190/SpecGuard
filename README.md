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
    types: [opened, synchronize, reopened, ready_for_review, edited]
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

**4. Recommended:** run your unit tests with coverage in a separate job with no secrets, upload the report, download it in the SpecGuard job and set `coverage_files` to it (LCOV, Cobertura, JaCoCo, Go or Istanbul JSON). Never run PR code in the job that holds SpecGuard's tokens. See [Coverage evidence](#coverage-evidence-optional).

## What you get

- Inline comments from `github-actions[bot]` (or the App or PAT that posted them): test skeletons for missing tests, one-click suggested fixes for standard violations. Each is a standalone review comment: there is no review wrapper, and the summary comment is the only aggregate. A low-confidence finding says so in its bold title; there are no reaction buttons and no coding-agent prompt block. Kind, confidence and rule stay in a hidden HTML comment.
- The sticky summary (and the job summary, same text) follows the review goal: a one-line verdict (the only line with an icon), a counts table (unit tests first), then plain sections that end with their count: **Missing unit tests (N)** and **Weak unit tests (N)** (one linked line per finding with its requirement on a second line; findings that were not posted inline keep their full text there), **Requirements to check (N)** (only criteria that add information: unconfirmed ones and gaps no list above shows), **Coding standard violations (N)**, **Tests to move down (N)** and **Not reviewed (N)**. A single blockquote with the caveats (reduced or incomplete review, rule files changed) sits after the last section. Low-confidence findings are listed in Details only. After a push the numbers line adds what changed since the last review ("Since last push: 2 with later changes (fix not verified) · 1 new"; a finding that is no longer reported after its lines or a test changed, a proxy, not a verified fix). Reference material is collapsed at the end: the obligation/evidence table, the requirement-document to code Traceability table, pre-existing drift, validation notes and the sources read. Over the comment size limit, whole items are dropped from the end first and the summary says how many.
- The last line, outside the collapsed Details, is a visible `<sub>` cost line when the engine ran: cost first, then model, tokens (in, cached, out) and API time, merged with the delivery line. Failed runs show it too. Copilot cost is an estimate from AI credits (1 credit = $0.01); the billing API remains authoritative. Copilot has no schema enforcement, so an answer with missing or invalid JSON gets one repair turn on the same session, and its usage is added to the line.
- **Model choice (Copilot).** Pin `model` when your plan allows: an unavailable model falls back to `auto` once and the summary says so. With `auto` the router picks the model per prompt; the model actually used is recorded in `engine-model.json` (in the context directory) and shown in the usage line. A fast-tier model, a run whose JSON needed a repair turn, three or more engine notes, or more than a quarter of the obligations degraded by validation publishes a **reduced review**: the verdict is followed by the usual counts line, a one-line note says only high-confidence findings are shown, at most 3 inline comments (high confidence with two verified citations), everything else as one-line items in the summary, never the "No unit test gaps found" wording, no auto-resolved threads. A run that is incomplete or struggling (repair turn, engine notes, degraded obligations) writes no head marker so the next push retries; the fast tier alone still writes it.
- A `<sub>` "Since earlier reviews" line on a complete re-review: how many earlier findings are addressed, still open, dismissed or not observed. The labels are conservative: "addressed" means the anchored lines or a test file changed since the comment, never proof of a fix; "of the N most recent" appears when more earlier findings exist than were tracked.
- **Tell SpecGuard how a finding landed.** Reply on its review thread with `wrong: <why>`, `intentional`, `not important` or `fixed` (also "false positive", "by design", "won't fix", "nit"). The reply must start with that word, optionally after `specguard:`; the last such reply by a person counts. SpecGuard records it as a reply verdict in the counts line (a reply by any person, not only the PR author; self-reported, not verified) and the weekly report shows the share judged wrong or not important; it does not change the finding or the "Since earlier reviews" labels.
- Hidden markers in the summary: `specguard:status` (`complete`, `incomplete` or `failed`: whether the review finished; a fast-tier model alone does not make it incomplete, the grade is in the counts `tier`/`reduced` and a one-line note), `specguard:by` (the login that posted it), `specguard:head` (written only for a complete run, so an incomplete head is retried) and `specguard:counts` (the telemetry behind the line above).
- The Action output `status` carries the same `complete` / `incomplete` / `failed` and is empty when the run was skipped. The job is green unless the setup is broken or `fail_on_error` asks otherwise ([job colour](#job-colour)), so read this output (or the summary) to notice a failed or incomplete review.
- Separate coding-standard and test-layer assessments, including when no violations or pushdown candidates were found.
- `covered` requires a unit assertion; `higher_level_only` records component/integration/e2e evidence without counting it as unit coverage. Pushdown suggestions identify a public unit seam and preserve necessary integration checks.
- Unknown evidence, inaccessible issues and partial reviews remain visible. Empty findings never imply that requirements were fully reviewed.
- A diff over `max_diff_kb` is cut at file boundaries: whole files that fit are reviewed, the files that were dropped are listed in the summary, and the run is marked incomplete.
- **Large PRs are reviewed in focus.** Time and cost grow with how much the model reads, so past 600 changed lines or 25 changed files SpecGuard ranks the changed files by risk before the model runs (logic over config, docs and generated files; more changed lines; no test found; named by a requirement; removed branch and error-handling lines) and reviews only the top 12 whose diff fits, plus their changed tests. The model is told to read only about 20 files beyond the diff. The summary says "Large PR: focused review of N of M files (highest risk first); not reviewed: ...", the run is marked incomplete (not reduced, not failed) so the next push reviews again, and the hidden counts carry `focused: {files, of}`. Split the PR or raise `focus_threshold` to review more.
- Skipped with no AI call: docs-only and lockfile-only PRs, closed PRs, bot authors and heads that already have a complete summary. Default ignores include lockfiles, `dist/`, `build/`, `vendor/`, snapshots and generated code (`*.pb.go`, `*_pb2.py`, `*.g.cs`, `*.Designer.cs`, `*.generated.*`).
- A linked issue is found from "Closes #N" in the PR body, and from the branch name only by explicit markers: `issue-N`, `issues/N`, `gh-N`, or a leading `N-` (`123-fix-bug`).
- Advisory: green unless the setup is broken ([job colour](#job-colour)).

The default Action runs the reviewer directly so it can require this complete report. It reads tests but does not execute PR code: `Unit evidence: X/Y` is a static assessment of the listed obligations, not measured code coverage or proof that tests pass. AI can miss or misinterpret behaviour; source-quote validation checks citation existence, not semantic correctness. Run your normal test/lint CI alongside it.

## Credentials

Give the action one model credential as `llm_token` (a secret). It is detected by its prefix, never printed, and picks the engine (`engine: auto`, the default):

| `llm_token` holds | Engine | Billed to |
|---|---|---|
| Copilot fine-grained PAT (`github_pat_...`, also `gho_...`, `ghu_...`), account permission **Copilot Requests** | `copilot` (Copilot CLI) | the token owner's Copilot seat |
| Anthropic API key (`sk-ant-...`) | `claude` (default: one Messages API call, schema-enforced JSON, cost bounded up front; optional `claude_mode: agent` = Claude Code CLI) | the key's Anthropic account |
| empty | `copilot` on the job token (`copilot-requests: write`, org billing) | the organization |

A classic `ghp_` token (Copilot rejects it) and anything unrecognized fail with a clear error. `copilot_token` is an alias of `llm_token` and still works (`llm_token` wins when both are set). The `model` input takes any model id, or the alias `haiku-5.5` (`claude-haiku-5.5` on Copilot, `claude-haiku-5-5` on Claude).

## Who pays

It is never the action author's quota. Copilot CLI is billed by the token it runs on, and the tokens are separate:

| Token | What it is | Billed to / used for | Where to store it |
|---|---|---|---|
| **Copilot token** (`llm_token`; alias `copilot_token`) | fine-grained PAT, resource owner = **a user** (not an org), account permission **Copilot Requests**. Classic `ghp_` tokens are rejected by the Copilot CLI | that user's Copilot seat (AI credits / premium requests) | `SPECGUARD_COPILOT_TOKEN`: environment secret in `specguard` for [manual runs](#manual-run-specguard-repo); repo or org secret for a [target-side caller](#enterprise-setup) |
| **Repository-read token** (central runs on other repos only) | GitHub App (preferred) or fine-grained PAT owned by the org, Contents / Pull requests / Issues read | reads the target; costs nothing | `SPECGUARD_APP_ID` + `SPECGUARD_APP_PRIVATE_KEY`, or `SPECGUARD_PAT` (environment secrets) |
| **Org billing** (alternative, no Copilot token) | job token with `copilot-requests: write` | the org, only if an owner enables "Allow use of Copilot CLI billed to the organization" (personal repo: the repo owner's seat) | nothing to store |

One fine-grained PAT has a single resource owner, so the Copilot token (user-owned) and the repository-read PAT (org-owned) are two tokens; they cannot be merged. All runs on a Copilot token spend that user's own quota: use a service/bot account with its own Copilot seat if your company allows it, so a person's quota is not drained. When the quota is used up the run reports "Copilot quota or budget exhausted" (a configuration failure: the job goes red, see [job colour](#job-colour)). The org may also have to enable the Copilot CLI policy for that user, and an org that requires approval of fine-grained PATs affects only the repository-read PAT (the Copilot token touches no org resources).

Copilot usage is token-based, so cost grows with agent turns. The PR diff, PR and linked-issue text and any repo files the model reads are sent to GitHub Copilot. The Copilot step unsets a job-level `GH_TOKEN` (Copilot CLI would prefer it over the job token and hijack the auth).

## Rolling out in a company

- **Pin a full commit SHA**, not a branch or `@v1` (the `v1` tag predates this behaviour). Update it deliberately.
- **Org prerequisites:** either a Copilot token (see [Who pays](#who-pays); the user needs a Copilot seat with Copilot CLI allowed), or an org admin enables Copilot CLI and the policy "Allow use of Copilot CLI billed to the organization" for `GITHUB_TOKEN` billing. Without one of them every PR shows "Could not complete" and the job goes red (a configuration failure). Run a **canary PR** first and watch the `status` output (or the summary); alert on `failed`.
- **Never make SpecGuard a required check, and never put `paths:` on its trigger.** A skipped workflow leaves a required check pending, a merge queue (`merge_group`) gets no result, and a superseded push cancels the older run. It is advisory (green unless the setup is broken, see [job colour](#job-colour)). The same goes for "Require conversation resolution": its review threads are advisory, so `resolve_stale` is off by default (the job token cannot resolve threads); where that branch-protection rule is on, give the action a `github_token` that can resolve threads and set `resolve_stale: "true"`, or developers must resolve each thread by hand.
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
| `requirements_paths` | | Globs, one per line, that add requirement documents to the ones found by content; `!glob` excludes noisy docs (e.g. `!docs/**`; a leading `/` anchors at the repository root: `!/docs/**` keeps `pkg/docs/` in). Empty = content-based discovery only. |
| `standards_paths` | | Globs, one per line, that add coding-standard or review-guideline documents (e.g. `docs/testing-guidelines.md`) to the instruction files found automatically. Read from the base commit like every rule file; `!glob` excludes. |
| `test_paths` | | Globs or folders, one per line (`!glob` excludes), that are the authoritative unit-test locations: files there are the tests whatever their names, they are searched first, and the prompt says so. A bare name (`qa/checks`) is a file or a folder. Empty = tests are discovered by name and layout. |
| `coverage_files` | | Optional. Coverage report globs, one per line, relative to the workspace (LCOV, Cobertura XML, JaCoCo XML, Go cover profile, Istanbul `coverage-final.json`). SpecGuard never runs tests: your workflow runs them with coverage before the SpecGuard step. See [Coverage evidence](#coverage-evidence-optional). Empty = off. |
| `standards_checks` | | Your own lint/format checks to report, `check:NAME` or `status:CONTEXT`, one per line. See [Standards evidence](#standards-evidence). |
| `mode` | `pr` | `pr` reviews a pull request; `scan` runs the unit test gap scan on the checked-out repository (`audit` is accepted as an alias). See [Unit test gap scan](#unit-test-gap-scan-whole-repository). |
| `scan_issue` | `false` | Scan mode: `true` also creates or updates one issue titled "SpecGuard: unit test gap scan" (one per `scan_paths` scope; needs `issues: write`). It is what lets a gap be confirmed across runs and lets the runs rotate through all blocks. |

<details>
<summary>Advanced inputs</summary>

| Input | Default | Meaning |
|---|---|---|
| `llm_token` | | The model credential, detected by prefix ([Credentials](#credentials)): a Copilot fine-grained PAT runs Copilot, an Anthropic API key runs the `claude` engine (one Messages API call, billed to the key's Anthropic account). Empty = the job token with `copilot-requests: write` (needs the org policy). |
| `copilot_token` | | Alias of `llm_token` (`llm_token` wins when both are set). A fine-grained PAT owned by a user, permission Copilot Requests: Copilot runs on it and is billed to that user's seat ([Who pays](#who-pays)). |
| `claude_mode` | `api` | `claude` engine: `api` (default) = ONE Anthropic Messages API call with the context SpecGuard already built, no CLI install, cost bounded up front; `agent` = Claude Code CLI with read-only tools (not bounded up front, see [Engines](#engines)). |
| `max_output_tokens` | `32000` | `claude` engine, api mode: most output tokens the model may produce (1000-64000); part of the worst-case cost checked against `max_budget_usd`. |
| `claude_version` | `2.1.284` | Pinned `@anthropic-ai/claude-code` version for `claude_mode: agent`. |
| `engine` | `auto` | `auto` (by the credential kind), `copilot` (Copilot CLI) or `claude` (Anthropic API). An explicit engine must match the credential. Any other value fails the step. See [Engines](#engines). |
| `auto_tier` | `intelligence` | Copilot Auto routing profile when `model` is empty or `auto`: `intelligence` (default), `balance`, `efficiency`, or empty to omit. Ignored with a note if rejected; does not change which models your plan offers. |
| `fast_models` | | Extra model names treated as fast tier: exact names or `/regex/`, one per line or comma separated. Built-in: flash, mini, haiku, nano, lite, small. |
| `max_budget_usd` | `1.00` | `claude` engine: budget in USD per run (positive decimal, at most 20). In api mode a HARD bound: the worst-case cost (prompt size plus `max_output_tokens` at the model's price) is computed before the call, and the call is not made, with the reason in the summary, when it exceeds this. In agent mode the Claude Code CLI's soft cap (checked between turns; a live run with $1.00 cost $3.44) plus a finalize turn of 20% of it. |
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
| `fail_on_error` | `false` | Configuration failures (bad or missing key, no credit, unknown model) always fail the job; this input controls the rest: `true` also fails on a transient failure (`::error::SpecGuard could not complete: <reason>`) and, in a `scan_scope: all` scan, on anything not reviewed (including document blocks the model did not answer). The manual-run workflow sets it. Leave it off for PR checks. See [job colour](#job-colour). |
| `ctx_retention_days` | `1` | Days to keep the `specguard-ctx-<PR>-<attempt>` artifact (diff, prompt context and raw engine output, for diagnosing a failed review). Anyone who can read the repo's Actions runs can download it: set `0` (no upload) on public repositories and wherever the diff must not be stored. |
| `resolve_stale` | `false` | `true` resolves SpecGuard's own review threads that have no replies and whose finding is no longer reported anywhere, including the summary (at most 20 per run), after a complete review (diff not truncated, engine finished, requirement collection and comment delivery not degraded). Enable it only with a `github_token` that can resolve review threads: the default `GITHUB_TOKEN` with `pull-requests: write` was refused in a live run ("Resource not accessible by integration"; for example a fine-grained PAT with Pull requests: write; adding `contents: write` to the job is unverified), and when the token is refused the summary says the threads were left open. Off by default because of "Require conversation resolution": where it is on, every unresolved advisory thread blocks the merge, and a token that cannot resolve means the developer must resolve each one by hand. Failures never fail the run. |
| `copilot_version` | `1.0.92` | Pinned `@github/copilot` (>= 1.0.85). |
| `scan_max_blocks` | `80` | Scan mode: most document blocks audited per run (integer 1-500). With `scan_issue: true` the runs rotate through all blocks (see [Large repositories and monorepos](#large-repositories-and-monorepos)); without it the first blocks in document order are audited and the rest are listed under not reviewed. |
| `max_units` | `12` | Scan mode: most source files (units) per call, riskiest first (integer 1-100). The claude engine (api mode) makes as many unit calls per run as `max_budget_usd` allows (up to 8), each with its own `max_units` units; the other engines make one. With `scan_issue: true` the runs rotate through all units. |
| `scan_paths` | | Scan mode: newline-separated globs (`!glob` excludes) that select which source files (units) are reviewed, for a monorepo package. Requirement documents, tests and evidence are still read from the whole repository; restrict the documents with `requirements_paths` / `design_docs`. The scan issue is per scope. Empty = the whole repository. |
| `audit_max_requirements`, `audit_issue` | | Deprecated aliases of `scan_max_blocks` and `scan_issue`; when both names are set, the `scan_*` one wins. |
| `delivery`, `repository`, `pr_number`, `base_sha`, `head_sha` | | For [manual runs](#manual-run-specguard-repo) that review another repository on a `workflow_dispatch`: `delivery: summary` writes nothing to the PR (job summary only); the others replace what a `pull_request` event would supply. Leave them empty in your own workflow. |

</details>

#### Job colour

`src/fail-on-error.js` runs last. A configuration failure is one only the owner can fix (bad or missing key, no credit, unknown model, Copilot policy off, adapter error).

| Outcome (`status`) | `fail_on_error` off (default) | `fail_on_error` on |
|---|---|---|
| `complete` | green | green |
| `incomplete`, PR review or scan | green, warning | green, warning |
| `incomplete`, `scan_scope: all`, parts or blocks not reached, a call failed or blocks unanswered by the model | green, warning | **red** |
| `incomplete` with a configuration failure in a part | **red** | **red** |
| `failed`, configuration failure | **red** | **red** |
| `failed`, transient (timeout, bad JSON, overload) | green, warning | **red** |

Unsure verdicts on reviewed code (`scan_scope: all`) only warn. Never make SpecGuard a required check, whatever the colour.

### Coverage evidence (optional)

SpecGuard never executes tests, so its "covered" judgements are static. If your CI already produces a coverage report, point `coverage_files` at it and the changed lines get hard execution evidence. Run the tests with coverage in a **separate job** that has no secrets, and hand the report over as an artifact (SpecGuard does not run them):

```yaml
jobs:
  test: # runs PR code: read-only token, no secrets
    runs-on: ubuntu-latest
    permissions: { contents: read }
    steps:
      - uses: actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803 # v6.1.0
        with: { persist-credentials: false }
      - run: npx c8 --reporter=lcov npm test       # JS: coverage/lcov.info (nyc/istanbul lcov works the same)
      # Python: coverage run -m pytest && coverage xml     -> coverage.xml (Cobertura)
      # Java:   mvn verify (JaCoCo plugin)                 -> target/site/jacoco/jacoco.xml (Gradle: build/reports/jacoco/test/jacocoTestReport.xml, xml enabled)
      # Go:     go test -coverprofile=cover.out ./...      -> cover.out
      - uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7.0.1
        if: ${{ !cancelled() }} # a failing test still hands over its report
        with: { name: coverage, path: coverage/lcov.info }
  review:
    needs: test
    if: ${{ !cancelled() }} # review even when tests fail
    runs-on: ubuntu-latest
    permissions: { contents: read, pull-requests: write, issues: read }
    steps:
      - uses: actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803 # v6.1.0
        with: { fetch-depth: 0, persist-credentials: false }
      - uses: actions/download-artifact@9000827ccba6bdab643e8b6fd33ac0654aef8333 # v8.0.2
        continue-on-error: true # no report: SpecGuard runs without coverage evidence
        with: { name: coverage, path: coverage }
      - uses: Mira190/SpecGuard@<full-commit-sha>
        with:
          coverage_files: coverage/lcov.info
```

Why two jobs: a step that runs PR code can write to `$GITHUB_ENV` (e.g. `NODE_OPTIONS=--require ./x.js`) or `$GITHUB_PATH` (a fake `node`), and every later step in that job, SpecGuard's included, would then run that code with your LLM key and write token in its environment ([design rule](docs/design.md)). The downloaded report is untrusted input: SpecGuard only parses it (it never executes it), and a forged report can only change that PR's own coverage facts and findings.

What it changes, all deterministic and only for the changed non-test files that the report covers:

- The summary's Unit test gaps section states "Changed lines executed by tests: X of Y instrumented" and lists the added lines no test executed, per file.
- A requirement the model judged `covered`, whose cited behaviour line never ran in the report, becomes `unknown` ("the coverage report shows this line never ran").
- A `missing_test` finding on a line that never ran gains "(coverage: never executed)".
- The model also sees the per-file numbers in its prompt (`coverage.txt` in the debug artifact).

Paths in the report may be absolute CI paths, relative to a source root, JaCoCo package paths or Go import paths; they are matched to the changed files by suffix. A report older than the head commit (when it carries a timestamp: Cobertura, JaCoCo) is ignored and the summary says so. An unreadable or unmatched report only leaves a note; it never fails the job. Leave `coverage_files` empty to turn all of this off.

**Already uploading coverage elsewhere?** The same file works. Upload the report your test job already produces for the tool below, download it in the SpecGuard job as above, and point `coverage_files` at it (SpecGuard reads it from the workspace and uploads nothing). The example path is what the usual generator writes; use your own if it differs.

| Tool | Formats it ingests that SpecGuard also reads | `coverage_files:` example | Docs |
|---|---|---|---|
| Codecov | LCOV, Cobertura, JaCoCo, Go | `coverage/lcov.info` | [Supported report formats](https://docs.codecov.com/docs/supported-report-formats) |
| Coveralls | LCOV, Cobertura, JaCoCo, Go (`golang`) | `coverage/lcov.info` | [coverallsapp/github-action](https://github.com/coverallsapp/github-action), [coverage-reporter](https://github.com/coverallsapp/coverage-reporter) |
| SonarQube / SonarCloud | JaCoCo XML (Java/Kotlin/Scala), LCOV (JS/TS), Cobertura (Python) | `target/site/jacoco/jacoco.xml` | [Test coverage parameters](https://docs.sonarsource.com/sonarqube-server/2026.3/analyzing-source-code/test-coverage/test-coverage-parameters) |
| GitHub code coverage (Code Quality) | Cobertura XML | `coverage.xml` | [Set up code coverage](https://docs.github.com/en/enterprise-cloud@latest/code-security/how-tos/maintain-quality-code/set-up-code-coverage) (uploaded with `actions/upload-code-coverage`) |

The table lists only formats the cited docs name. [diff-cover](https://github.com/Bachmann1234/diff_cover) works from the same kinds of reports (Cobertura, Clover, JaCoCo XML, LCOV); SpecGuard does not need it.

SpecGuard does not repeat those tools' percentage comments; it adds line-level "never executed" evidence tied to a finding, and since #413 a `missing_test` finding on a line the report shows never ran is no longer demoted by the "candidate test only partly visible", "a test may already cover this" or reduced-review gates.

## Engines

An engine is one script, `src/engines/<name>.sh`: it reads the prompt file and leaves `findings.json`, `usage.json`, `engine-status` and a few notes in the context directory; everything before it (collect, prompt) and after it (`post.js`) is engine-agnostic. The `engine` input is checked against an allow-list, then the action runs `src/engines/$ENGINE.sh`.

- `engine: auto` (default): `claude` when `llm_token` is an Anthropic API key, otherwise `copilot`.
- `engine: copilot`: Copilot CLI, the answer is JSON in prose with one repair turn.
- `engine: claude`: an Anthropic API key (usage is billed to the key's account). **Default `claude_mode: api`: one Messages API call, no agent loop.** SpecGuard already builds the context a review needs (numbered diff, test candidates, leads, requirements, rule files, coverage) and inlines it in the prompt, so the model needs no tools. The static part of the prompt (skill, references, schema) is the cached `system` block, the per-PR context the user message, and the answer is schema-enforced JSON (`output_config.format`; the schema is reduced in memory to what structured outputs accept, `post.js` validates the full one). Before the call the worst-case cost is computed (input at bytes/1.5 tokens plus `max_output_tokens`, at the model's price) and the call is refused when it exceeds `max_budget_usd`, so the budget is hard. Cost is exact in the usage line, from the response's token counts and a small price table in `src/engines/claude-api.js`. Typical PR review on `claude-haiku-5-5` ($0.10 / $0.50 per million tokens up to 100K prompt tokens): with the context pack a small PR is about 40-80k input tokens, around one cent; a large PR crosses the 100K step ($0.50 / $2.50) and costs about $0.10-0.15. A 429, 529 or 5xx is retried once; no credit, a rejected key, a rate limit and an unavailable model are told apart in the summary. `effort` is ignored.  
  `claude_mode: agent` runs the Claude Code CLI instead (read-only `Read`, `Grep`, `Glob` confined to the workspace, one finalize turn after a budget stop). It is not the default because the tool loop re-sends the whole context every turn and `--max-budget-usd` is a soft cap checked between turns: two live runs on `claude-haiku-5-5` cost $3.58 and $3.44 against a $1.00 budget, and the finalize turn failed because the budget is cumulative across the resumed session. Use it only when you want the model to explore files the prompt does not contain, and set `max_budget_usd` knowing it is not a ceiling.

A Copilot SDK adapter was trialled on 2026-10-13 (it tied with the CLI) and removed; it can be restored from commit `58d8937`. The contract (inputs, output files, rules, how to add an engine) is in [src/engines/README.md](src/engines/README.md). Adding an engine means one script and one line in the allow-list (and, for a new credential kind, one line in `src/credential.js`); `post.js` does not change.

## Unit test gap scan (whole repository)

`mode: scan` is a repository-wide list of unit test gaps for QA, not a PR review and not a requirements audit: the design documents are the oracle, the output is the documented behaviour that lacks unit-test evidence. On demand or on a schedule it reads the design documents at the checked-out commit (found by content, plus `requirements_paths`), extracts the atomic behaviours they describe (descriptive design prose counts: "a repeating plan stays on after it fires" is a behaviour) and, for each, says whether it has unit-test evidence, only higher-level tests, no test, or looks unimplemented or contradicted by the code, or needs a human. (`mode: audit`, the earlier name, still works.) It is advisory and static: tests are not executed, the counts are not a coverage figure, and they are not for scoring people.

The scan does not need design documents. It ranks the tracked source files by risk (public definitions, size, commits and fix commits of the last 180 days (needs `fetch-depth: 0`; a shallow clone ranks without them), and how well their matched tests protect them: none, no assertion, skipped or weak), reviews the `max_units` riskiest (default 12; with `scan_issue: true` the runs rotate through all of them) and lists untested behaviour, weak unit tests and tests to move down, each with a test skeleton. A missing test for a unit with no test file is confirmed at once; any other finding is confirmed when the next run reports it again. A repository that also has design documents gets the document audit described below in the same summary.

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

In Claude API scans, a source unit stays unreviewed and due when its source or any matched candidate test was unreadable or did not fit the context. Long test windows are marked incomplete when the search cuts through the test. For split document calls, `scan-parts.json` records incomplete evidence files per block (`blockCuts`); absence claims (`missing_test`, `partial`, `not_implemented`) for those blocks become `unknown`. Positive cited evidence is still verified normally. This makes incomplete input visible; it does not guarantee that a persistently oversized file will fit on a later run.

The result is the job summary: one line per document block (link, text, block status, and its sub-rows' statuses; a block is a `gap` when any sub-row is `missing_test`, `partial`, `contradicted` or `not_implemented`, `covered` when all are, `unsure` otherwise) with counts by block status, the per-sub-row evidence in a collapsed table per document, the candidate documents that were not admitted ("add to `requirements_paths` to include"), and what was not reviewed (skipped documents, rows whose citation did not verify, the `scan_max_blocks` cap). Every citation is checked against the file at HEAD: a requirement whose quote is not found is moved to "not reviewed"; test or code evidence that is not found is removed and a `covered` row becomes `unknown`. `audit.json` (the validated result) stays in the `specguard-audit-<attempt>` artifact (`ctx_retention_days`). Reporting is per block and confirmed across runs, because a model's detail varies from run to run (the same commit scanned twice agreed on a block's gap about two times in three, and on individual sub-rows far less): with `scan_issue: true` the issue keeps a hidden per-block state, a gap is listed as **confirmed** only when the block was a gap in this run and the previous one (otherwise "new gap, unconfirmed"), a confirmed gap that is covered is "resolved? recheck next run" until it is covered twice, and "Changed since the last scan" lists only those two-run-stable changes plus a count of unstable blocks. Schedule the scan weekly so each run confirms the last; without `scan_issue` every gap stays unconfirmed (a [manual run](#manual-run-specguard-repo) is always one-off for this reason). With `scan_issue: true` the same report is written to a single issue (found by a hidden marker and authored by this action; whole rows are dropped, never cut, to fit GitHub's body limit).

Cost: the model reads every admitted document in full (at most 60), so a scan uses far more tokens than a PR review. Cap it with `copilot_max_ai_credits` (per turn), lower `scan_max_blocks`, narrow the documents with `requirements_paths` (`!glob` excludes) or the whole scan with `scan_paths`, and raise `review_timeout_minutes` and the job `timeout-minutes` for large repositories.

### Large repositories and monorepos

A scan does bounded work per run and covers everything across runs:

- **Evidence is searched before the model starts.** For every block of the run, a deterministic search (the same requirement-to-code ranking the PR review uses, bounded by a 40 s budget) finds up to 3 code and 3 test locations (`path:line` and the matching line) and hands them to the model as leads (`audit-evidence.txt`). The model verifies those first and searches the repository itself only when none fits; every citation is still checked against the file by the publisher. A block with no match says `none`; matches are a heuristic (a shared word is not a match, but prose-heavy tables can still match), so they are leads, never evidence.
- **Runs rotate** (with `scan_issue: true`, because the issue holds the state: per block, its status and the commit and date it was last audited). Each run audits up to `scan_max_blocks` blocks in this order: blocks that are new or edited since the last scanned commit (needs `fetch-depth: 0`; a shallow clone is noted and skipped), gaps seen once that need confirming, blocks never audited (in document order), then the least recently audited. The other blocks keep their status from their last audit in the report, marked "from <date>", so the issue always shows the whole picture. The summary says `Coverage: X of Y blocks audited at least once; this run audited K (changed D, confirming C, new N, oldest O)`. Without `scan_issue` there is no state: each run audits the first blocks in document order and the summary says so ("schedule with scan_issue: true to rotate through all blocks").
- **`scan_paths` scopes a package.** It selects which units are reviewed; requirement documents, tests and evidence are read from the whole repository (so the discovery limits of 2000 candidate files and 500 documents count the whole tree; restrict the documents with `requirements_paths` / `design_docs`). A scoped run audits a requirement block only if its document is in scope or its code evidence is; the others are skipped, listed in the limitations, and keep their last status. Each scope has its own issue (the title ends with the scope, e.g. "SpecGuard: unit test gap scan (packages/payments/**)"; the hidden marker carries a hash of the globs), so scans of different packages never overwrite each other. A scan without `scan_paths` keeps the original issue title and marker, so an issue created before scopes existed is still found.
- **Every cap is shown** under "Not reviewed": the discovery limits, the 40 s evidence budget, 3 + 3 locations per block, the 64 KB evidence file, the blocks left for later runs, and the 600 blocks the issue state can keep (older ones count as never audited again).

One job per package, each with its own issue:

```yaml
jobs:
  scan:
    strategy:
      fail-fast: false
      matrix:
        package: [packages/payments, packages/search, packages/web]
    runs-on: ubuntu-latest
    timeout-minutes: 30
    permissions: { contents: read, issues: write, copilot-requests: write }
    steps:
      - uses: actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803 # v6.1.0
        with: { persist-credentials: false, fetch-depth: 0 }
      - uses: Mira190/SpecGuard@<full-commit-sha>
        with:
          mode: scan
          scan_paths: ${{ matrix.package }}/**
          scan_issue: "true"
          scan_max_blocks: "60"
```

## Manual run (SpecGuard repo)

`.github/workflows/specguard-run.yml` runs SpecGuard on demand against **another repository** from the SpecGuard repo's Actions tab (`workflow_dispatch`). It is not shipped to target repos; their own workflow stays the `pull_request` one above. The form has one required field and six optional ones:

| Input | Meaning |
|---|---|
| `target` (required) | A **PR link** reviews that PR. A **repo link**, `owner/name`, a **branch link** or a **directory or file link** runs the unit test gap scan of that branch (the default branch when the link names none); a directory or file link also limits the scan to the source files under that path (`scan_paths`; documents and tests still come from the whole repository). GitHub's "Use workflow from" picks the SpecGuard version that runs; the code reviewed comes from `target`. |
| `design_docs`, `rules_docs`, `test_dirs` | Requirement/design documents, coding-standard documents and unit-test folders, one per line: repository paths, globs (`!` excludes), or github.com blob/tree links of the **same** repository. A folder (`docs/specs`) means everything under it. Empty = auto-discovery. They become `requirements_paths`, `standards_paths` and `test_paths`. |
| `post_to_pr` | PR links only, default off: results stay on the run page. On: the normal review and summary comment are also posted to the target PR. |
| `scan_scope` | Scans only, default `all`: review the whole repository in this one run (every unit part and document block, no per-run cap, no rotation) with the claude api engine; calls beyond the worst-case plan are admitted while the actual spend plus their worst case fits `max_budget_usd`, and no new call starts in the last minutes of `review_timeout_minutes` (150 here, inside the 180-minute job). A run that did not cover everything says so on top ("N unit parts / M document blocks not reached (budget or deadline)", with the most the rest could cost by the worst-case estimate), is incomplete and, when something was not reviewed (budget, deadline, a failed call), goes red; unsure verdicts such as units reviewed with part of their tests only warn. The action's default $1 budget caps an `all` run, so set `max_budget_usd` (a 489-unit repository needs about 85 calls and cost about $1.5 on haiku-5.5); the manual form defaults it to 5, a ceiling rather than a cost. `selected`: the riskiest units and first blocks only; any engine but claude api needs `selected`. |
| `scan_issue` | Scans only: where the scan keeps its state. `none` (default): this run's page only, one-off. `specguard`: one tracking issue per scanned repository in **this** repository, titled `SpecGuard: unit test gap scan: owner/name`, so the target needs no write access. `target`: an issue in the scanned repository (the token needs Issues write there). This repository is public, so its run pages and issues are visible to anyone (non-public targets are refused). |

Each run also uploads a 14-day artifact `specguard-result-<run id>` with the rendered summary, `findings.json`, the requirement/obligation status, `usage.json` and `scan-parts.json` (the call ledger: ids, counts and reasons; not the prompt, the diff or repository files). It quotes the target repository, so keep this repository private with access no wider than the targets'; a public SpecGuard repository scans public targets only (the resolve job fails a non-public one).

Model and effort are not on the form: the run uses Copilot Auto with `auto_tier: intelligence`. To pick a model or effort, use the action in your own workflow (`model`, `effort` above).

`src/resolve-inputs.js` turns the form into repository paths first. A link into another repository is rejected (copy the document into the target repository); a non-GitHub link (Confluence, Google Docs, ...) fails with "not readable from GitHub Actions; add the document to the repository or paste it". PR mode reviews an open PR (head and base from the API, checked out with `fetch-depth: 0`). With a token that can read the target, the resolver also looks up which part of a branch link is the branch name (branches may contain slashes: the longest existing branch or tag wins) and whether an extension-less path (`Makefile`, `docs/specs`) is a file or a folder; without access a branch link with a path fails (it cannot tell the branch from the path; link the branch root instead), and a path without a trailing slash stays as given, so end a folder with `/`. The link path scopes the scan from the repository root (`tree/main/packages/payments` is `/packages/payments`, not `legacy/packages/payments`). No artifact is kept (`ctx_retention_days` is `0`); a scan keeps its state only in the scan issue chosen by `scan_issue`.

**Confirming gaps across runs.** With `scan_issue: specguard` or `target` the issue keeps the per-block state, so re-running the manual scan (or scheduling it in the target, see [Enterprise setup](#enterprise-setup)) confirms gaps the same way as the scheduled scan. With `none` the summary starts with "One-off scan: gaps are unconfirmed".

**Setup (do this once, in the SpecGuard repo).**

1. Settings > Environments > New environment `specguard`. Under "Deployment branches and tags" choose **Selected branches and tags** and allow only `main`. Both jobs of the workflow run in this environment, so a branch that edits the workflow or `src/` and is dispatched cannot start the job, and the token is never exposed to code that is not on `main`.
2. Give the run read access to the targets, in the same environment's **secrets** (never the repository secrets). Preferred: a **GitHub App** (no personal token): secrets `SPECGUARD_APP_ID` (the App's Client ID or App ID) and `SPECGUARD_APP_PRIVATE_KEY`; the App needs **Contents, Pull requests and Issues: read** (add **Pull requests: write** for `post_to_pr`, **Issues: write** for `scan_issue: target`) and must be installed on the target repositories. Each job mints a one-hour installation token scoped to the single target repository with `actions/create-github-app-token`, read-only unless `post_to_pr` / `scan_issue: target` ask for write. Alternative: `SPECGUARD_PAT`, a fine-grained PAT whose resource owner is the target repos' owner with the same permissions. Order: App, else PAT, else the job token (this repository and public repositories only). Copilot never runs on the App or `SPECGUARD_PAT` (an org-owned token cannot carry Copilot Requests): add the environment secret `SPECGUARD_COPILOT_TOKEN`, a fine-grained PAT owned by a user with the account permission **Copilot Requests** (billed to that user's seat; see [Who pays](#who-pays)). Without it Copilot runs on the job token (`copilot-requests: write`), which works only when the organization enables "Allow use of Copilot CLI billed to the organization". The checkout does not persist the token.
3. Keep the SpecGuard repository **private**, with access that is a subset of the access to every repository you point it at (collaborators who can already read the targets). The run page quotes the reviewed repository's code and requirement text, and anyone who can read the SpecGuard repo's Actions runs can read it (logs and summaries are kept 90 days); the result artifact above quotes it too. A public SpecGuard repository is allowed for public targets only: the resolve job fails a non-public target.

SpecGuard itself is checked out next to the target in a path that must not exist (`.specguard-src`), after the target, and the job fails if the reviewed repository already has a path of that name; the review ignores that folder.

## Enterprise setup

Which setup fits depends on where the code lives and who may hold a token. GitHub's `GITHUB_TOKEN` is scoped to the repository that runs the workflow: it cannot read another private or internal repository, even in the same organization or enterprise, and the "Access" setting below does not change that. A PAT-free setup therefore runs SpecGuard **in the repository under review**; reading other repositories needs a GitHub App or a PAT.

| | 1. Reusable workflow in the target repo (recommended) | 2. Central manual run with a GitHub App | 3. Central manual run with a fine-grained PAT | 4. Same repo or public repos, job token |
|---|---|---|---|---|
| Runs | in the target repo: PR review, on-demand scan, scheduled scan | in the SpecGuard repo, on demand: PR or whole-repo scan of any repo the App is installed on | same as 2 | in the SpecGuard repo, only for it and public repos |
| Token | the target's own `GITHUB_TOKEN`: **no PAT, no secret** | App installation token, one repo, one hour | PAT in the `specguard` environment | job token |
| Needs | SpecGuard repo Access setting (below); the caller job grants the permissions | an App (Contents, Pull requests, Issues read) installed on the targets; two environment secrets | PAT with the same read scopes, rotation by its owner | nothing |
| Copilot billed to (PAT-first) | the user who owns `SPECGUARD_COPILOT_TOKEN`, stored as a secret of the target repo or org and passed as `llm_token` | the user who owns `SPECGUARD_COPILOT_TOKEN` (environment secret) | same as 2 | same as 2 |
| Copilot billed to (alternative, no Copilot token) | the org that owns the target repo (policy "Allow use of Copilot CLI billed to the organization") | the org that owns the SpecGuard repo (same policy) | same as 2 | same as 2 |
| Security | run pages and artifacts are visible to that repo's readers only | run pages and scan issues in the SpecGuard repo quote target code: keep it private, access no wider than the targets' | the PAT reads everything it was granted: smallest scope, short expiry | none beyond 2 |

**1. Reusable workflow (recommended).** Org settings, once:

1. In the SpecGuard repo: Settings > Actions > General > **Access** > "Accessible from repositories in the '*ORG*' organization" (for an organization owned by an enterprise, the enterprise option). It lets workflows of other repositories **use** the repository's actions and reusable workflows; the runner fetches them with a read token that expires after an hour. It does not let those repositories' `GITHUB_TOKEN` read the code, which is why SpecGuard is used by `uses:` and never checked out by the caller. Outside collaborators on a calling repository can see its run logs.
2. In the calling organization (Settings > Actions > General) allow the actions in use: `actions/*` (checkout, github-script, setup-node, upload-artifact) and the SpecGuard repository, or actions from your enterprise. "Allow only actions and reusable workflows in this organization" also blocks GitHub's own actions.
3. Copilot, one of: (a) a Copilot token (the company default when the org does not bill Copilot CLI): create a fine-grained PAT owned by a user (a service account with its own Copilot seat is best), account permission **Copilot Requests**, and store it as the secret `SPECGUARD_COPILOT_TOKEN` in the calling repository or as an organization secret shared with it; (b) an org owner enables Copilot CLI and "Allow use of Copilot CLI billed to the organization", and no token is needed.

Pass the token to the reusable workflow as `llm_token` (`copilot_token` still works as an alias), in either form (the secret is optional; without it Copilot uses the job token, i.e. (b)):

```yaml
    uses: ORG/SpecGuard/.github/workflows/specguard.yml@<full-commit-sha>
    secrets: { llm_token: "${{ secrets.SPECGUARD_COPILOT_TOKEN }}" }   # explicit
    # secrets: inherit                                                   # or: passes all caller secrets; SPECGUARD_COPILOT_TOKEN is read by name
```

The caller job grants the permissions (a called workflow can only keep or reduce them): PR review `contents: read`, `pull-requests: write`, `issues: read`, `copilot-requests: write`; scan `contents: read`, `copilot-requests: write` (+ `issues: write` with `scan_issue`). Pin the reusable workflow by **full commit SHA**. It pins the action by SHA itself (the `# specguard-pin` line), so the caller's pin decides the exact SpecGuard code. After a change to `action.yml` or `src/`, run `node bin/pin-reusable.js` and commit (pass `owner/repo` as the second argument when your internal copy has another name). Inputs: `mode` (`pr` default or `scan`), `requirements_paths`, `standards_paths`, `test_paths`, `scan_issue`, `model`, `effort`. Fork and draft PRs are skipped inside the workflow.

```yaml
# .github/workflows/specguard.yml in the target repo: PR review
name: SpecGuard
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review, edited]
concurrency: { group: "specguard-${{ github.event.pull_request.number }}", cancel-in-progress: true }
jobs:
  review:
    permissions: { contents: read, pull-requests: write, issues: read, copilot-requests: write } # copilot-requests only for org billing; harmless with a Copilot token
    uses: ORG/SpecGuard/.github/workflows/specguard.yml@<full-commit-sha>
    secrets: { llm_token: "${{ secrets.SPECGUARD_COPILOT_TOKEN }}" } # omit when the org bills Copilot CLI
```

```yaml
# .github/workflows/specguard-scan.yml in the target repo: on demand and weekly (a schedule runs on the default branch)
name: SpecGuard scan
on:
  workflow_dispatch:
  schedule: [{ cron: "0 6 * * 1" }]
jobs:
  scan:
    permissions: { contents: read, issues: write, copilot-requests: write }
    uses: ORG/SpecGuard/.github/workflows/specguard.yml@<full-commit-sha>
    with: { mode: scan, scan_issue: true } # drop scan_issue and issues: write to keep results on the run page
    secrets: { llm_token: "${{ secrets.SPECGUARD_COPILOT_TOKEN }}" }
```

**2 and 3. Central manual run.** See [Manual run](#manual-run-specguard-repo) for the environment, the App (preferred) or PAT, and `scan_issue` (default: an issue in the SpecGuard repo, so the target needs no write access). Copilot needs its own token in both: `SPECGUARD_COPILOT_TOKEN` in the `specguard` environment (the App or `SPECGUARD_PAT` is for reading the target only). Choose the App when policy forbids personal repository-read tokens (the Copilot token is still a user's PAT): its token is minted per job, limited to the one target repository, and revoked when the job ends. Install it on the target repositories only; a target in another organization needs the App installed there.

**4. Job token.** The SpecGuard repo scanning itself, or a public repo.

GitHub Enterprise Server: the setup avoids the `job.workflow_*` context values that GHES lacks, but needs the actions it uses available on the instance (`create-github-app-token` runs on node24, so the runner must support it) and Copilot CLI with `copilot-requests` on your version. Check these before rolling out; they are not verified here.

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

Anything other than `passed` or `not_configured` stops the summary from saying "No unit test gaps found". Advisory only: it does not change the job colour.

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

The exit code is 0 unless the tool crashed (advisory). With `--fail-on-gaps`: 1 on a gap, 2 when the run did not complete (failed or incomplete, so the review is not whole), else 0. The gate reads what the post step delivered after validation (citations verified, anchored to the diff): a high-confidence missing or weak unit test in the comments, or in the summary list when it is not marked "low confidence". Findings the validator drops never block.

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

- "Could not complete" in the summary: the engine failed, timed out or returned invalid JSON; the `status` output is `failed` and the job colour follows [job colour](#job-colour). Check the job log. Common causes: no usable Copilot token (set `SPECGUARD_COPILOT_TOKEN` / `llm_token` when the organization does not bill Copilot CLI; a classic `ghp_` or org-owned PAT is rejected), a missing `copilot-requests: write` permission, a Copilot policy that is not enabled, or the token owner's quota used up. The summary names which one.
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

Shift-left value strategy and validation (中文): [docs/shift-left-value-strategy-2026-10-16.md](docs/shift-left-value-strategy-2026-10-16.md).
Goal completion, full-repo audit and unknown-unknown assessment (中文): [docs/goal-assessment-2026-10-17.md](docs/goal-assessment-2026-10-17.md).

Industry research, cross-repository scanning, observability and traces (中文): [research report](docs/shift-left-industry-research-2026-10-16.md), [scan playbook](docs/cross-repository-scan-playbook-2026-10-16.md), [repository report template](docs/templates/repository-shift-left-report.md).

## Credits

Rubric and approach are adapted from prior art, listed in [NOTICE](NOTICE).
