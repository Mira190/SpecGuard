# Cross-repository shift-left scan and reporting playbook

Date: 2026-10-16. Applicable baseline: SpecGuard `b1aaf113aae3ca69fcc70e7b9026130affa6c30f`.

This document accompanies the [big-tech research report](shift-left-industry-research-2026-10-16.md). The goal is to analyze other repositories with an honest scope, reviewable evidence, and a path through to fixes. The commands below are operating examples; this time no external scan, paid call or publishing action was run; use them only after replacing the placeholders.

## 1. First choose the problem to solve

| Problem | Entry point | Reasonable output |
|---|---|---|
| Before submitting a PR, is this branch missing protection? | The current local script or direct skill use; the script actually reviews only committed changes | Changed-behavior gaps; uncommitted content is outside the script's scope |
| Does this PR introduce a test gap / requirement deviation? | The normal PR Action or a manual PR link | Introduced findings, with historical drift listed separately |
| What should this repository fill in first? | Single-repo scan | High-value historical gaps, a scope ledger and the next batch |
| Do multiple repositories have the same known bug? | A variant campaign with explicit conditions | Independent evidence per repository, plus unsupported/unreadable targets |
| Does it reduce QA rework? | Real replay + a pilot with a human control | Effective early interventions and escape results over a mature observation window |

Do not name a single risk-focused scan a whole-repo quality certification. For a newly onboarded repository, first produce a single-repo read-only report, confirm the noise and the scope, and only then expand.

## 2. Prepare the scan manifest and an immutable snapshot

A recommended manifest contains:

```json
{
  "manifest_version": "proposal-1",
  "campaign_id": "pilot-001",
  "purpose": "requirements-aware unit-test-gap baseline",
  "targets": [
    {
      "repository": "ORG/target",
      "requested_ref": "main",
      "resolved_sha": "FULL_TARGET_COMMIT_SHA",
      "scope": ["**"],
      "requirements_paths": ["docs/requirements/**"],
      "standards_paths": ["CONTRIBUTING.md"],
      "test_paths": ["tests/**"],
      "delivery": "local-report",
      "execution_policy": "static-only",
      "owner": "TEAM_OR_PERSON"
    }
  ],
  "analyzer": {"action_sha": "FULL_SPECGUARD_COMMIT_SHA", "config_ref": "approved-config"},
  "budget_policy": {"max_total_usd": null, "max_wall_minutes": null}
}
```

This is a proposed report manifest; the current CLI does not read it directly. `null` means the budget has not been decided yet; it does not mean unlimited authorization. The scope should include the related tests and requirements; if restricting to a subtree makes external relationships invisible, report the boundary, and do not treat a failed search as a missing implementation.

The target list is determined by the actually authorized scope; do not expand the scan automatically just because "the token can list it". Read access to the source repository, model calls, execution verification and write access to the report are each made explicit; readers of a central report repository must not be broader than the readers the source material allows. The current visibility guard is not a complete proof of member ACLs.

The following read-only queries can resolve and record the target version; replace `main` if the default branch is not `main`, treat the output as a record, and do not splice unchecked output into commands:

```powershell
gh api repos/ORG/target/commits/main --jq .sha
gh api repos/ORG/target --jq '{name: .full_name, visibility: .visibility, default_branch: .default_branch}'
```

The analyzer version is also pinned to a full SHA. When comparing repeatedly, keep the target tree, model, prompt and budget the same; record deliberately changed variables separately.

## 3. Three currently usable run paths

### 3.1 Path A: collect only a single-repo profile first, without calling a model

Check out the confirmed target SHA in a separate scratch clone so the collector never touches the workspace the user is editing. Do not install the target's dependencies or run its hooks, MCP, builds and tests. Prepare the supported Git/Node environment and access conditions as the existing project requires.

The following runs on a prepared clone; `CTX` must point to a fresh, disposable directory dedicated to this round, because the collector deletes and rebuilds that directory:

```powershell
$env:CTX = 'C:/scratch/specguard-run-001/ctx'
$env:SCAN_ISSUE = 'false'
$env:MAX_UNITS = '12'
$env:SCAN_MAX_BLOCKS = '80'
$env:AUDIT_BRANCH_GUARD = 'off'
Push-Location 'C:/scratch/target-at-fixed-sha'
try {
    git rev-parse HEAD
    git ls-tree -r --full-tree HEAD
    node C:/path/to/SpecGuard/src/audit-collect.js
} finally {
    Pop-Location
}
```

First save or clear any inherited environment that would affect this analysis, especially `REQ_PATHS`, `STANDARDS_PATHS`, `TEST_PATHS`, `IGNORE_EXTRA`, `SCAN_PATHS` and the GitHub run variables; record the final effective configuration in the output. The example calls only the static collector and produces no model-quality conclusion; do not treat the risk leads in `audit-inventory.json` as confirmed defects.

Read `audit-meta.json`, `audit-inventory.json`, the candidate documents, the documents not included, test-layout, standards and the carry information, and add a complete tracked-tree ledger. The existing collector output has caps; do not assume it has already classified every file completely.

`SCAN_ISSUE=false` does not read the historical rotation state; repeated calls with the same input may always look at the same batch. This path suits profiling and scope checking; it is not a persistent whole-repo scheduler. After the run, restore the environment set for this run so it does not contaminate the analysis of the next repository.

### 3.2 Path B: reuse the central manual workflow for one model scan

The existing `.github/workflows/specguard-run.yml` supports target repo/tree/PR links. `resolve-inputs.js` in the code can recognize the 40-character SHA in a tree URL, so the target can be pinned:

```powershell
gh workflow run specguard-run.yml --repo ORG/SpecGuard --ref main -f target=https://github.com/ORG/target/tree/FULL_TARGET_COMMIT_SHA -f scan_issue=none -f post_to_pr=false
```

Running this command starts a remote Actions run and consumes model/runner resources; `--ref main` selects the version of the controlling workflow and does not pin the scan engine version. The actual dispatch commit needs to be saved in the run record; for long-term comparison, a pinned trusted workflow should call an Action at a pinned SHA. If the organization's environment allows only main, do not work around the environment protection just to pin a version.

This configuration does not publish to the target PR or the scan issue; the result stays on the control run page, but the control run page may still contain source-repository snippets and must stay within the audience scope. First prepare the App/PAT, the model credentials and the protected environment as the existing workflow requires; do not write secrets into documents or commands.

**Actual limits of this baseline:** the manual workflow currently pins `haiku-5.5`, and the input form has no model/engine/scan_paths/max_units switches; context artifact retention is set to 0. Do not operate it with an imagined `--model` or `--scope` input, and do not promise that this round's raw context can be downloaded. When these settings are needed, use/review a specific adopter workflow, and do not change the secret constraints to get around this.

Only choosing `scan_issue=specguard` or `target` writes an issue and saves cross-round state; this should be an explicit choice. The `none` mode cannot provide two-round confirmation or continuous rotation. Even if the issue is saved, two-round agreement is only a signal that the model result is stable, not semantic proof.

### 3.3 Path C: when sustainable scanning is needed, reuse the Action and pin the scope

In a trusted workflow, check out the authorized target and a pinned version of SpecGuard, and set the following through the existing interface:

- `mode: scan`, `repository`, and the exact checkout/head SHA.
- `scan_paths`, `requirements_paths`, `standards_paths`, `test_paths`, `ignore`.
- `max_units`, `scan_max_blocks`, model/engine, total budget and timeout.
- Whether to write the scan issue, where to write it and who can read it; when no issue is written, the task frontier must be saved explicitly outside, since there is currently no ready-made general ledger input.
- An approved artifact retention policy; an ACL check before output goes to a broader audience.

This is a concrete piece of workflow configuration work, not a new entry point this report has implemented. In the first round, reuse the existing state; capabilities such as a complete task ledger, budget fitting and cross-repo aggregation are honestly listed as still to be built.

Do not call the existing local PR script a whole-repo scan CLI; it is a change review of the committed branch against base, and it does not support automatically rotating through all source files.

## 4. Build a mutually exclusive scope ledger

Every tracked file first gets one and only one inclusion decision:

`included / excluded / unsupported / unreadable / unclassified`.

Describe usage such as source/test/requirement/rule/config with separate multi-select roles, so a file that serves as both requirement and rule does not double-count in the denominator. For submodules, LFS, generated files, migrations and external specifications, state the expansion status and the responsibility scope separately.

```text
tracked_total = included + excluded + unsupported + unreadable + unclassified
```

This equation only reconciles assets. The behavior tasks within included get a separate queue:

`pending / running / reviewed / unknown / deferred / failed`.

The queue carries `revision, task_id, evidence_dependencies, cursor, attempt, last_actual_progress, next_action`. Multiple attempts must not repeatedly consume the independent-task denominator; unknown, deferred and failed cannot be filed under "no gap".

Any change produces a new snapshot and invalidates the related evidence; "is it finally fully scanned" is discussed only for the same snapshot. For a large repository that keeps changing, the age of the reviewed evidence should be reported separately, and no single always-moving global endpoint should be promised.

## 5. What each review batch does, fixed

1. Choose this batch's behaviors and related requirements, and state the oracle source, conflicts and versions.
2. Search the public entry points, the implementation and all related test candidates; record the locations not read.
3. Treat source+test+requirement as the budget unit; split or defer tasks that do not fit the budget.
4. Form one evidence chain per behavior, with concrete inputs/expectations; do not require every helper to be tested directly.
5. Verify the citations and applicable rules, and check for substitute tests, cross-file migration, existing drift and staged releases.
6. Try to refute high-value candidates; when it can run, go through isolated verification.
7. Summarize across the four axes, without letting "no rule" become "standard confirmed", and without letting high-level coverage pass as unit protection.
8. Save the scope actually completed in this batch, the verification downgrades and the next batch; the cursor advances by the range actually processed.

A suggested finding record has at least: the behavior, the consequence, the independent requirement, concrete citations, existing tests, the target error/counterexample, the evidence level, the unproven parts, the minimal fix, the owner and the acceptance method. Model confidence is only a signal and cannot replace the precision after human calibration.

## 6. Two kinds of success in executed verification

| Task | Valid success | Invalid success |
|---|---|---|
| Strengthen protection of behavior that was already correct | The new test passes at HEAD; it can reject a meaningful target fault | It only adds line coverage or repeats existing assertions |
| Expose a requirement deviation | The requirement expectation is independently confirmed; the new test fails on the wrong implementation and passes after the fix | Changing the requirement expectation to the result of the wrong implementation just to make the test green |

Build failures, missing dependencies, timeouts, flaky runs and real assertion failures are kept separate. The necessary baseline is run in the same environment; an environment crash must not be taken as discovering a business defect. Cross-service errors that a unit test is unsuited to express should keep integration verification.

The existing `eval/prove.js` applies only to the local-eval output structure it supports and a limited range of Node tests; it is not a one-click proof tool for any repository. Read its README first, and then run it in a controlled copy; do not automatically run arbitrary discovered test commands in pursuit of "generality".

## 7. How the whole-repo baseline serves later PRs

The whole-repo report first registers high-value historical risks and leaves the team to decide the order of handling. Later PRs then link the changed behavior to its current evidence:

- Newly introduced by this PR: the fix can be raised to the author on the first screen.
- A historical problem but related to this change: explain the earlier state and this change's risk, to avoid misattributing responsibility.
- Existing issues unrelated to this PR: stay in the baseline and are not shown to the author again and again.
- The related requirement/test changed: the old covered becomes invalid and is re-checked.

After a fix, record the verified result of the independent behavior, and do not count the fix again for each push. Prioritize the PR's immediate feedback budget; whole-repo background tasks should not crowd out all the model quota and the author's capacity to handle findings.

## 8. Artifacts to save

The suggested output layout is below; it does not mean all these files will now be generated automatically by SpecGuard:

```text
campaign/
  manifest.json
  portfolio-summary.md
  repos/REPO_ID/REVISION/RUN_ID/
    provenance.json
    inventory.jsonl
    scope-ledger.jsonl
    evidence-manifest.json
    review-events.jsonl
    validated-findings.json
    report.md
    verification/INDEX.md
    follow-up.csv
```

The existing `audit-meta.json`, `audit-inventory.json`, `audit.json`, `engine-model.json` and the usage/omission information can map onto these responsibilities; prefer reusing them, and do not maintain two sets of ground truth whose semantics conflict. Write missing for artifacts that were not generated; do not disguise them with empty files.

Raw code/prompts/test output is saved only where explicitly allowed, isolated by source-repo ACL and deleted periodically; cross-repo summaries keep counts and controlled links by default. The hidden `scan_issue` state is not invisible; issue readers can read it.

## 9. Checks before publishing a report

- The repository and exact SHA are correct, and source links are pinned to that SHA; LEFT references link to base.
- Inclusion decisions are conserved across all files, the task scope can be recomputed, and exclusions and unsupported items are explicitly visible.
- Requirements, unit, standards and layers each get a conclusion and limits; not applicable is not recorded as a failure.
- Missing-test claims rely on a sufficient search; when truncated or unreadable, no absolute does-not-exist judgment is made.
- Findings are de-duplicated by behavior and root cause; the summary and inline comments do not double-count benefit.
- Static, executed and fault evidence, and capability and requirement-oracle evidence, are kept separate.
- There is an owner, a minimal action, a verification method and the scope of the next round.
- Cost includes all attempts; the model's estimated price and the actual billing source are kept separate.
- The audience of any shared destination has been checked; future capabilities in the documentation are not written as completed.

Use the [report template](templates/repository-shift-left-report.md) to generate each repository's report, and then organize the action list by risk, trustworthy evidence and team capacity. Passing the checks means the report credibly describes the work done; it does not mean the repository has no defects.

## 10. Use the existing replay tools to validate potential benefit

The following reuses the actual CLI interface; the samples need a separate scratch directory, gh read access and human confirmation, and do not automatically call a model:

```powershell
node eval/szz.js mine --repo C:/scratch/target --since 2026-04-01 --gh-repo ORG/target --label-scan --max 50 --out C:/scratch/replay/manifest.json
node eval/replay.js prepare --repo C:/scratch/target --base ORIGINAL_BASE_SHA --head ORIGINAL_HEAD_SHA --out C:/scratch/replay --id bug01 --title ORIGINAL_TITLE --body ORIGINAL_BODY --trace auto --shared
node eval/replay.js finish --id bug01 --out C:/scratch/replay
```

Between the second and third steps, an approved model must produce and save the finding output as the replay README says; running finish empty and claiming verification is complete is not allowed. `--body` in this CLI takes the body text, not a path to a body file; long bodies should be passed through proper shell arguments or a controlled invocation, and a `--body-file` must not be invented.

First confirm the introduction relationship and the scope by hand, and freeze the intent available at that time; the later fix is given only to the adjudicator. Record direct/indirect/miss separately, together with clean samples; see the [replay rubric](../eval/replay/README.md) and the [original validation plan](validation-plan.md).

## 11. When this plan counts as landed

At least on one real authorized repository, complete: a scope ledger on a pinned snapshot, one four-axis analysis report, one reviewable pre-QA protection improvement or defect fix, one re-run on the same version whose progress can be explained, and one record of false positives / false negatives / cost. Only then expand to more languages and repository types.

"Workflow green", "all file names scanned", "two model rounds agree" and "comment was closed" do not substitute for these acceptance criteria.
