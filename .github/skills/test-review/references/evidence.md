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

Operational check: when the expected value is an expression rather than a literal, compare it with the implementation's computation. If it repeats the same operations with the same constants (an inlined literal is the same constant as a named one: `1.2` vs `RATE = 1.2`), it is tautological, so the obligation is `weak_test`, never `covered`. Check every cited assertion before marking a row `covered`: it needs at least one whose expected value is independent of the implementation (a literal, a worked example, or the acceptance criterion's own numbers). Example: `assert.equal(addTax(50), Math.round(50 * 1.2 * 100) / 100)` against `Math.round(amount * RATE * 100) / 100` with `RATE = 1.2` is the same formula; use a literal such as `60`.

SpecGuard does not execute tests or evaluate CI configuration, and CI workflows are often incomplete. Never infer that a test is not collected or not executed from a CI workflow, a missing runner config, or CI using a different language's runner; such a test is existing evidence at its layer. Only an explicit marker in the test code (skip, xfail, disabled, commented out, an `if False`-style guard) shows a test does not run, and then it is a low-confidence `weak_test`. Do not suggest CI or runner configuration changes; they are outside SpecGuard's scope.

A test that drives the same branch with an equivalent input is evidence for that branch: a whitespace-only name that trims to empty covers the empty-name rejection. Suggest boundary variants only as a low-confidence `weak_test` on the test line, never as a `missing_test` on production code.

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
