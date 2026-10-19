## SpecGuard scan

**❌ 2 unit test gaps in the 5 riskiest units** at `0123abc`. Static review; tests were not run.

| Units reviewed | No unit test | Weak tests | Skipped tests | Design documents |
|---|---|---|---|---|
| 4 of 5 | 1 | 1 | none | none |

### Untested behaviour (1)

- [parse hex digit](https://example.test/blob/0123abc/src/a.ts#L134) `src/a.ts:134` (first report) — Upper-case digits are never parsed in a test.
  Sketch, not run:

### Weak tests (1)

- [only checks existence](https://example.test/blob/0123abc/src/b.test.ts#L40) `src/b.test.ts:40` — The assertion passes for any value.

<details><summary>Details: riskiest units, inventory, rotation, document blocks, sources</summary>

**Riskiest units (top 5 of 5)**

**Low-confidence unit findings (1)**

A test file the model could not see whole is behind each; they are not counted.

- [return value dropped](https://example.test/blob/0123abc/src/c.ts#L57) `src/c.ts:57` (low confidence) — Chaining is not asserted.

**This scan**

**Not reviewed (2 items)**

- src/e.ts did not fit the model context window
- Candidate blocks were judged from their text.
</details>
