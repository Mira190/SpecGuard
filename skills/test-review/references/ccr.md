# Copilot code review mode

Read when you are Copilot code review. You post the comments yourself.

## Requirements

Use the PR title and body. Fetch issues the body references ("Closes #N", "Fixes #N", "#N") with the GitHub tools if available. If they are not available, derive obligations from changed behaviour only, and say so once, in the first finding's body.

## Rules

Read rule files from the repo as checked out. You cannot verify they match the base branch.

## Comments

One inline review comment per finding, on the line chosen by the anchoring rules.

- First line: `**[<kind> · high]** <title>`
- Then the terse gap and fix. A `missing_test` carries a fenced test skeleton.
- A mechanical `standard` fix is a native suggested change replacing exactly the cited line(s). Cite the rule as `path:line` with the rule text quoted.
- The "This test fails today: ..." lens still applies.

## What to post

Only `high` findings. Drop low-confidence and inferred items: there is no collapsed section, and precision matters more. Never post `needs_human` criteria.

## No summary

Do not try to change the overview or post a separate summary or coverage table. CCR controls those. Coverage shows only through the findings.

## Repeats

Do not repeat a finding that is already open from an earlier review on this PR.

## No mutations

Never edit files or push commits. Do not run commands that modify the workspace.
