# Evidence and weak tests

Read at procedure steps 4 and 5.

## What counts as evidence

A test counts only if the cited line names the behaviour it proves. A good test checks behaviour through the public interface, so it survives refactors.

Not evidence (counts as zero):
- assertions that mirror the implementation, change detectors, "mock exists" checks;
- fakes that accept anything;
- assertions that can only fail by crashing;
- a tautological assertion: the expected value is recomputed the way the code computes it, so it passes by construction. Expected values must come from an independent source: a literal, a worked example, or the acceptance criterion's own numbers.

Tautology is a `weak_test` on the assertion line, not a `missing_test` on the production line. Code `return x * RATE;` with test `expect(fn(10)).toBe(10 * RATE)` exercises the behaviour but proves nothing; cite the `expect` line.

SpecGuard does not execute tests. A test in the repo's conventional location and naming counts as existing evidence even if you cannot see a runner configuration or CI step that runs it. Report "not collected or not executed" only with concrete evidence (an explicit skip, or a name outside an explicitly configured pattern), and then only as a low-confidence `weak_test`; otherwise mention it in `not_reviewed`.

## Weak-test catalogue

Report `weak_test` on the assertion line when a test exercises the behaviour but:
- survives a plausible mutation: flipped condition, dropped branch, off-by-one, swapped error;
- is coupled to the implementation in a way that hides a specific required outcome or violates an applicable repo rule:
  - mocks the project's own modules or internal collaborators;
  - tests a private method;
  - asserts call counts or call order;
  - verifies through a side channel (querying the DB directly) instead of reading back through the interface;
  - would break on a refactor that does not change behaviour;
- asserts only that something is truthy, non-null or did not throw, when a value is available to compare.

## Mocks and seams

Prefer mocks at system boundaries: external APIs, time, randomness, sometimes the DB or file system. An internal mock or a call-count assertion alone is not proof of a weak test: identify the missed behavioural regression and respect the repo's testing contract.

Test at seams, meaning public boundaries. For `pushdown`, if a unit test would need to mock the project's own modules, it is not a candidate. Otherwise target the smallest public seam, never a private function.

## Test layers

A unit test isolates a behaviour through a public seam, without network or a real DB. Use repository configuration, fixtures and dependencies to distinguish unit, component, integration and end-to-end tests. Preserve the repo's names in the explanation while using the schema's layer labels. When the layer is uncertain, mark the obligation `unknown` instead of crediting unit coverage.

For every cited assertion, copy a real source line and explain the input and expected outcome it checks. A test name, a file's existence, or execution of a branch alone is not assertion evidence. `covered` requires unit evidence; `higher_level_only` records evidence at other layers without implying it should always move. Keep integration checks for wiring, persistence, protocols and cross-component contracts. Recommend pushdown only for separable deterministic logic, and retain those integration responsibilities.
