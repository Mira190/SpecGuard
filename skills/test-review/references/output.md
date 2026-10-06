# Output

Read before producing output.

## Style

Each body is the gap, then the fix. No hedging, no praise, no diff summary. When nothing is wrong, say so plainly ("No test gaps found.") and return empty `findings`.

## CI mode: JSON only

One object matching the provided schema, no prose.

- `requirements_source`: e.g. "issue #12, PR body".
- `coverage[]`: unique `id`, `obligation`, `source`, `behaviour: {path,line,quote}`, `evidence: [{path,line,quote,layer,proves}]`, `status`, and `reason`. Cite sources as "issue #N AC k", "PR body AC k", "PR body", or "from behaviour", never as context-file paths. Evidence quotes must be assertion lines. `covered` and `weak_test` require unit evidence; `higher_level_only` requires higher-layer evidence and no unit evidence; `missing_test` has no evidence. `unknown` and `needs_human` never generate test findings.
- `standards`: `{status, sources, reason}`; `sources` is an array of rule-file paths. `checked`: `sources` must list, exactly as written in `standards.txt`, every rule file you applied to the changed files; an empty `sources` is invalid. `no_rules`: only when `standards.txt` is empty. `not_reviewed`: in every other case, with the reason. Checked means the applicable rules were assessed, not necessarily satisfied; state any violations, and explain non-applicable inventories as a completed scoped check.
  Example: `{"status":"checked","sources":["CONTRIBUTING.md","billing/REVIEW.md"],"reason":"Assessed both files against the changed billing code; one violation reported."}`
- `layering`: `{status: "checked" | "not_reviewed", reason}`. Identify the layers searched, candidates found, or why moving tests would not help.
- `findings[]`: see below.
- `not_reviewed`: what you could not review, e.g. a truncated diff; empty string if nothing.

Finding fields:
- `kind`: `missing_test`, `weak_test`, `standard` or `pushdown`.
- `obligation_ids`: IDs of all coverage rows this finding addresses. Required and nonempty for test findings; may be empty for `standard`.
- `path`: a file in `files.txt`, or an unchanged test file holding the weak assertion (summary only).
- `line`: per the anchoring rule in SKILL.md.
- `start_line`: only for a multi-line range inside one hunk.
- `quote`: the exact text of line `line`, copied from the file, not retyped. The poster snaps the line to it and drops the finding on a mismatch.
- `source`: the coverage source the finding addresses, e.g. "issue #1 AC 2". Required when the finding is tied to an acceptance criterion; it keeps the finding stable across runs.
- `title`: one short line.
- `body`: the gap, then the fix; a test skeleton for test kinds.
- `rule_source`: `path:line`. Required for `standard`; omit when inferred.
- `rule_quote`: the rule's line copied verbatim from the rule file. Required with `rule_source`; the poster corrects the line number from it and drops the finding if the text is not found.
- `suggestion`: see `references/standards.md`.
- `confidence`: `high` or `low`.

```json
{"kind":"standard","obligation_ids":[],"path":"billing/invoice.py","line":42,"quote":"        log.info(\"total=%s\" % total)","title":"Log with structured fields","body":"`CONTRIBUTING.md:31` asks for structured log fields so totals can be queried.","rule_source":"CONTRIBUTING.md:31","rule_quote":"Use structured log fields so totals can be queried.","suggestion":"        log.info(\"invoice total\", extra={\"total\": total})","confidence":"high"}
```

## Local mode: report

```
Tests: X missing, Y weak · Standards: Z · Layering: W
Unit evidence: P/N obligations (static review; tests not executed)

| Obligation | Source / behaviour | Assertion evidence / layer | Status / reason |

Coding standards: checked / no_rules / not_reviewed, with sources and explanation
Test layers: checked / not_reviewed, with explanation

### missing_test / weak_test / standard / pushdown
- file:line  title
  gap, then fix (skeleton or replacement)
```

Omit the ratio when N is 0. N counts obligations except `needs_human`; P counts only `covered` rows with unit assertion evidence. An empty report, partial context, or `unknown` row must never be described as a clean review. Print JSON only if asked.
