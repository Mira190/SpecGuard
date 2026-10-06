# Output

Read before producing output.

## Style

Each body is the gap, then the fix. No hedging, no praise, no diff summary. When nothing is wrong, say so plainly ("No test gaps found.") and return empty `findings`.

## CI mode: JSON only

One object matching the provided schema, no prose.

- `requirements_source`: e.g. "issue #12, PR body".
- `coverage[]`: `obligation`, `source`, `tests[]` as `file:line`, `status`. Cite sources as "issue #N AC k", "PR body AC k" or "PR body", never as context-file paths.
- `findings[]`: see below.
- `not_reviewed`: what you could not review, e.g. a truncated diff; empty string if nothing.

Finding fields:
- `kind`: `missing_test`, `weak_test`, `standard` or `pushdown`.
- `path`: a file in `files.txt`.
- `line`: per the anchoring rule in SKILL.md.
- `start_line`: only for a multi-line range inside one hunk.
- `quote`: the exact text of line `line`, copied from the file, not retyped. The poster snaps the line to it and drops the finding on a mismatch.
- `source`: the coverage source the finding addresses, e.g. "issue #1 AC 2". Required when the finding is tied to an acceptance criterion; it keeps the finding stable across runs.
- `title`: one short line.
- `body`: the gap, then the fix; a test skeleton for test kinds.
- `rule_source`: `path:line`. Required for `standard`; omit when inferred.
- `suggestion`: see `references/standards.md`.
- `confidence`: `high` or `low`.

```json
{"kind":"standard","path":"billing/invoice.py","line":42,"quote":"        log.info(\"total=%s\" % total)","title":"Log with structured fields","body":"`CONTRIBUTING.md:31` asks for structured log fields so totals can be queried.","rule_source":"CONTRIBUTING.md:31","suggestion":"        log.info(\"invoice total\", extra={\"total\": total})","confidence":"high"}
```

## Local mode: report

```
Tests: X missing, Y weak · Standards: Z · Layering: W
Proven: P/N obligations

| Obligation | Source | Tests | Status |

### missing_test / weak_test / standard / pushdown
- file:line  title
  gap, then fix (skeleton or replacement)
```

Omit "Proven" when N is 0. N counts obligations except `needs_human`. Print JSON only if asked.
