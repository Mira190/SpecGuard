# Test skeletons

Read before writing the body of a `missing_test`, `weak_test` or `pushdown` finding.

## Shape of a finding body

The gap, then the fix. Terse. No hedging ("might", "consider whether", "it may be worth"), no praise, no restating the diff.

## The suggested test

- The smallest check that fails if the logic breaks. No new fixtures, helpers or frameworks.
- Follow the repo's existing test style, framework and file location.
- Name it for the behaviour (WHAT), not the mechanism (HOW): `rejects negative totals`, not `calls validate`. Use the project's domain language.
- One logical assertion per test.
- Expected values are literals or come from the acceptance criterion, never recomputed with the code's own formula.
- Exercise the public interface only. Mock only system boundaries.
- Put it in a fenced block inside `body`.

## By kind

- `missing_test`: skeleton of the new test, plus the input and expected output that pins the behaviour. For a boundary, use the value on each side of the edge.
- `weak_test`: say which mutation survives, then give the replacement assertion for the cited line.
- `pushdown`: name the smallest public function that holds the logic, give its direct inputs and expected outputs, and cite the current higher-layer assertion. Say which integration test needs less and which wiring or contract checks must remain. Do not recommend replacing integration coverage wholesale.

## Spec lens

When you write the test an acceptance criterion needs, check it against the current implementation. If static inspection predicts a failure because the code contradicts the criterion, start the body with "Expected to fail against the current code: ..." and cite the contradiction. Never imply the test was run. It stays a `missing_test`, not a new kind.
