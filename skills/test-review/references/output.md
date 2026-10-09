# Output

Read before producing output.

## Style

Each body is the gap, then the fix; no hedging, praise or diff summary. When nothing is wrong, say "No test gaps found." and return empty `findings`.

## CI mode: JSON only

One object matching the provided schema, no prose.

- `requirements_source`: e.g. "issue #12, PR body".
- `requirements[]`: one entry per criterion in `requirements-status.json` `criteria`, copying `id`, `source` and `quote` exactly, plus `obligation_ids` and `reason`. Add criteria you find that are not listed with new ids (e.g. `X1`), the real source label and a verbatim quote from `requirements.md`. Id prefixes: `S` collected requirement-document change, `G` governing requirement you add from a requirement document (at most 10), `H` collected history (optional). A requirement may also carry `ref` (item id or heading), `line` (integer >= 1) and `pr_quote` (verbatim PR-body sentence describing the change, or `null`); a `G` requirement's `source` is the document path and its `quote` must appear in that file.
- `coverage[]`: unique `id`, `alignment: {status, since?, reason}` (required on every row; see `references/trace.md`), `obligation`, `source`, `behaviour: {path,line,quote}`, `change: {path,line,quote}` (the changed line in `diff.patch`, or `null`; required for every status except `unknown` and `needs_human`; usually the same line as `behaviour`), `evidence: [{path,line,quote,layer,proves,kind}]`, `status`, and `reason`. Every evidence entry must have `kind`: `assertion` (a live assertion line), `no_assertion`, `disabled` (a skipped, commented-out or uncollected test) or `removed` (a deleted test, cited on the diff LEFT side). Cite sources as "issue #N AC k", "PR body AC k", "PR body", or "from behaviour", never as context-file paths. Evidence quotes must be assertion lines. `covered` and `weak_test` require unit evidence; `higher_level_only` requires higher-layer evidence and no unit evidence; `missing_test` has no `assertion` evidence; it may cite a `disabled`, `no_assertion` or `removed` test to show why that test proves nothing. `unknown` and `needs_human` never generate test findings. A row with `alignment.status` `mismatch` has status `weak_test` (a test asserts the old or contradicting value, or cannot pin the boundary), `missing_test` (no test covers it) or `needs_human`, never `covered` or `unknown`; its single `spec_mismatch` finding is its only finding (see `references/trace.md`).
- `standards`: `{status, sources, reason}`; `sources` is an array of rule-file paths. `checked`: `sources` must list, exactly as written in `standards.txt`, every rule file you applied to the changed files; an empty `sources` is invalid. `no_rules`: only when `standards.txt` is empty. `not_reviewed`: in every other case, with the reason. Checked means the applicable rules were assessed, not necessarily satisfied; state any violations, and explain non-applicable inventories as a completed scoped check.
  Example: `{"status":"checked","sources":["CONTRIBUTING.md","billing/REVIEW.md"],"reason":"Assessed both files against the changed billing code; one violation reported."}`
- `layering`: `{status: "checked" | "not_reviewed", reason}`. Identify the layers searched, candidates found, or why moving tests would not help.
- `findings[]`: see below.
- `not_reviewed`: what you could not review, e.g. a truncated diff; empty string if nothing.

Finding fields:
- `kind`: `missing_test`, `weak_test`, `standard`, `pushdown` or `spec_mismatch`.
- `obligation_ids`: IDs of all coverage rows this finding addresses. Required and nonempty for test findings and `spec_mismatch` (exactly one `mismatch` row per finding); may be empty for `standard`.
- `path`: a file in `files.txt`, or an unchanged test file holding the weak assertion (summary only).
- `line`: per the anchoring rule in SKILL.md; it is the line number in the checked-out file, never a line of `diff.patch`.
- `start_line`: only for a multi-line range inside one hunk.
- `quote`: the exact text of line `line`, copied, not retyped; the poster snaps the line to it and drops the finding on a mismatch.
- `source`: the coverage source the finding addresses, e.g. "issue #1 AC 2"; required when tied to an acceptance criterion (keeps the finding stable across runs).
- `title`: one short line.
- `body`: the gap, then the fix; a test skeleton for test kinds.
- `rule_source`: `path:line`. Required for `standard`; omit when inferred.
- `rule_quote`: the rule's line copied verbatim; required with `rule_source` (the poster corrects the line number from it and drops the finding if not found).
- `suggestion`: see `references/standards.md`.
- `confidence`: `high` or `low`, by the evidence rule in SKILL.md (two verified disagreeing citations, or a concrete input whose result the cited code makes unambiguous, is `high`; never `low` merely because the code was not run). A `high` body states the failure scenario: input X → code does Y, requirement/sibling does Z.

```json
{"kind":"standard","obligation_ids":[],"path":"billing/invoice.py","line":42,"quote":"        log.info(\"total=%s\" % total)","title":"Log with structured fields","body":"`CONTRIBUTING.md:31` asks for structured log fields so totals can be queried.","rule_source":"CONTRIBUTING.md:31","rule_quote":"Use structured log fields so totals can be queried.","suggestion":"        log.info(\"invoice total\", extra={\"total\": total})","confidence":"high"}
```

<!-- mode:local -->
## Local mode: report

```
Tests: X missing, Y weak · Standards: Z · Layering: W
Unit evidence: P/N obligations (static review; tests not executed)

| Obligation | Source / behaviour | Assertion evidence / layer | Status / reason |

Coding standards: checked / no_rules / not_reviewed, with sources and explanation
Test layers: checked / not_reviewed, with explanation

### missing_test / weak_test / standard / pushdown / spec_mismatch
- file:line  title
  gap, then fix (skeleton or replacement)
```

Omit the ratio when N is 0. N counts obligations except `needs_human`; P counts only `covered` rows with unit assertion evidence. An empty report, partial context, or `unknown` row must never be described as a clean review. Print JSON only if asked.
<!-- /mode -->
