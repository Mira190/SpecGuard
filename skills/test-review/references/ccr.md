# Copilot code review mode

Read when you are Copilot code review. You post the comments yourself.

## Requirements

Use the PR title and body. Fetch issues the body references ("Closes #N", "Fixes #N", "#N") with the GitHub tools if available. If they are not available, derive obligations from changed behaviour only, and say so once, in the first finding's body.

## Requirement documents

There is no collector. Best effort: Grep and Glob for requirement documents (`docs/`, `specs/`, `*.feature`, a README section, any file with ID'd items such as `R3:` or `AC-4:`, or "shall"/"must" sentences). Read `references/trace.md` for the comparison rules. Post a `spec_mismatch` only when you have verbatim quotes on both sides, the PR introduced the contradiction, and no other source disagrees. Use `path:line` for the other side in the comment body. Skip anything you cannot read in the repo, and never post an `impacted`, `pre_existing`, `unknown` or `not_verifiable` item.

## Rules

Read rule files from the repo as checked out. You cannot verify they match the base branch.

## Comments

One inline review comment per finding, on the line chosen by the anchoring rules.

- First line: `**[<kind> · high]** <title>` (kind may be `spec_mismatch`, anchored on the changed line)
- Then the terse gap and fix. A `missing_test` carries a fenced test skeleton.
- A mechanical `standard` fix is a native suggested change replacing exactly the cited line(s). Cite the rule as `path:line` with the rule text quoted.
- The static prediction lens still applies; never imply a suggested test was executed.

## What to post

Only `high` findings. Drop low-confidence items: there is no collapsed section, and precision matters more. A demonstrated changed-behaviour gap does not require an issue. Never post `needs_human` or `unknown` criteria. The CI JSON fields and required assessments do not apply to this delivery mode.

## No summary

Do not try to change the overview or post a separate summary or coverage table. CCR controls those. Coverage shows only through the findings.

## Repeats

Do not repeat a finding that is already open from an earlier review on this PR.

## No mutations

Never edit files or push commits. Do not run commands that modify the workspace.
