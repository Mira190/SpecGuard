# Standards check

Read at procedure step 6.

## Discovery (local mode)

Instruction files, `AGENTS.md`/`CLAUDE.md`, `REVIEW.md`, `CONTRIBUTING.md`, `.editorconfig`, `.claude/rules`, `.cursor/rules`, skills dirs. In CI mode use `standards.txt`.

## Scope

- Apply only rule files in the changed file's directory or a parent.
- Honour `applyTo`/`paths` frontmatter and any "do not report" list in `REVIEW.md`.
- Skip pre-existing issues, lint-ignored code, and anything a linter or compiler catches.
- Only changed lines can carry a finding.

## Citation

Quote the exact rule as `rule_source`: `path:line`, and copy that rule line verbatim from the rule file into `rule_quote`. The poster corrects the line number from `rule_quote` and drops the finding if the text is not found. Explain why the rule applies and how the changed code violates it. A test that breaks a quoted test rule is a `weak_test` only when a specific behavioural regression escapes it; otherwise it is a `standard` finding.

Always report the check's status and the applicable rule files in `standards`, including when there are no findings. Unavailable rules or an incomplete review are `not_reviewed`, never implicit confirmation. `checked` records completion of a static assessment; it does not certify compliance or successful lint execution.

No citable rule means the finding is inferred: say so in `body`, set `confidence: low`, omit `rule_source`. An inferred finding is never `high`.

## suggestion field

Only for a mechanical `standard` fix. The exact drop-in replacement for `line` (or `start_line..line`), with the original indentation and no code fences. Never put a suggestion block in `body`. Omit for every other kind and for any fix that needs judgement.
