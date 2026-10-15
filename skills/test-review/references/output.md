# Output

Read before producing output.

## Style

Each body is the gap, then the fix; no hedging, praise or diff summary. When nothing is wrong, say "No test gaps found." and return empty `findings`. Write every title, body and reason in English; repository text (code, document wording) appears only inside quotes, verbatim in its own language.

## CI mode: JSON only

One object matching the provided schema, no prose.

- `requirements_source`: e.g. "issue #12, PR body".
- `requirements[]`: one entry per criterion in `requirements-status.json` `criteria`, with `id`, `obligation_ids` and `reason` only: the collected `source`, `quote`, `ref` and `line` of `R*`, `S*`, `D*` and `H*` criteria are filled in for you, so omit them. When `criteria` is empty (no structured acceptance criteria were collected), emit no `R*`, `S*`, `D*` or `H*` ids at all: every criterion you find gets an `X1`.. id, the real `source` label and a verbatim `quote` from `requirements.md`; an `R*` id that was not collected is ignored. Add criteria you find that are not listed, with new ids (`G1`.. at most 10 for a governing requirement document, else e.g. `X1`), the real `source` label and a verbatim `quote` from `requirements.md` (a `G` requirement's `source` is the document path and its `quote` must appear in that file). Id prefixes: `R` collected PR or issue criterion, `S` collected requirement-document change, `D` collected unchanged requirement block that governs the changed code, `G` governing requirement you add, `H` collected history (optional). A requirement may also carry `ref` (item id or heading), `line` (integer >= 1) and `pr_quote` (verbatim PR-body sentence describing the change, or `null`).
- `coverage[]`: required per row: unique `id`, `obligation`, `source`, `behaviour: {path,line,quote}`, `evidence`, `status`, `reason`. Optional, derived when omitted: `change: {path,line,quote}` (the changed line in the diff, or `null`; omitted means the `behaviour` line, so give it only when the changed line differs; needed for every status except `unknown` and `needs_human`) and `alignment: {status, since?, reason}` (give it on every row that links a requirement, omit it on the rest; see `references/trace.md`). `evidence: [{path,line,quote,layer?,kind?}]`: `layer` is omitted only for a plain unit-test file (`*.test.*`, `test_*.py`, `*_test.go`, `FooTest.java`, not under an integration, e2e, api, db, ui or component name, not a `.tsx` component test) and stated (`unit`, `component`, `integration`, `e2e`) otherwise: a `covered` row whose unit evidence omits the layer on any other path becomes `unknown`; `kind` is `assertion` when omitted (a live assertion line), else `no_assertion`, `disabled` (a skipped, commented-out or uncollected test) or `removed` (a deleted test, cited on the diff LEFT side). A `quote` is one line, copied; for a long line its first 100 characters are enough. Sources are labels as in step 3 ("from behaviour" when none), never context-file paths. Evidence quotes must be assertion lines (`expect`, `assert*`, `should`, `toBe`, `assertEquals`, `t.Errorf`, pytest `assert`, ...) of a test that runs: a `covered` row whose quote is not an assertion line, or sits in a skipped or disabled test, becomes `unknown`. `covered` and `weak_test` require unit evidence; `higher_level_only` requires higher-layer evidence and no unit evidence; `missing_test` has no `assertion` evidence; it may cite a `disabled`, `no_assertion` or `removed` test to show why that test proves nothing. `unknown` and `needs_human` never generate test findings. A row with `alignment.status` `mismatch` has status `weak_test` (a test asserts the old or contradicting value, or cannot pin the boundary), `missing_test` (no test covers it) or `needs_human`, never `covered` or `unknown`; its single `spec_mismatch` finding is its only finding (see `references/trace.md`).
- `standards`: `{status, sources, reason}`; `sources` is an array of rule-file paths. `checked`: `sources` must list, exactly as written in `standards.txt`, every rule file you applied to the changed files; an empty `sources` is invalid. `no_rules`: only when `standards.txt` is empty. `not_reviewed`: in every other case, with the reason. Checked means the applicable rules were assessed, not necessarily satisfied; state any violations, and explain non-applicable inventories as a completed scoped check.
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
- `confidence`: `high` or `low`, by the evidence rule in SKILL.md. A `high` body states the failure scenario: input X → code does Y, requirement/sibling does Z.
- `counterexample` (`weak_test`): one concrete wrong behaviour of the code under test that the cited assertion still accepts: input → the wrong result a broken implementation would return → why the assertion still passes, e.g. `total([2, 3]) returns 6 -> assert.ok(total([2, 3])) still passes`. Required for `high`; when you cannot name one, the assertion may be strong enough: use `low` or no finding. The poster sets a `weak_test` without one to `low`.

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
