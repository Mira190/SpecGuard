# Evidence and weak tests

Read at procedure steps 4 and 5.

## What counts as evidence

A test counts only if the cited line names the behaviour it proves. A good test checks behaviour through the public interface, so it survives refactors.

Not evidence (counts as zero):
- assertions that mirror the implementation, change detectors, "mock exists" checks;
- fakes that accept anything;
- assertions that can only fail by crashing;
- a tautological assertion: the expected value repeats the implementation's operations and constants (an inlined literal is the same constant as a named one: `1.2` vs `RATE = 1.2`), so it passes by construction. Expected values must come from an independent source: a literal, a worked example, or the acceptance criterion's own numbers.

Tautology is a `weak_test` on the assertion line, never a `missing_test` on the production line and never `covered`: before marking a row `covered`, check that at least one cited assertion has an independent expected value. Code `return x * RATE;` with `expect(fn(10)).toBe(10 * RATE)` exercises the behaviour but proves nothing; cite the `expect` line. Likewise `assert.equal(addTax(50), Math.round(50 * 1.2 * 100) / 100)` against `Math.round(amount * RATE * 100) / 100` with `RATE = 1.2`; use a literal such as `60`.

SpecGuard does not execute tests or evaluate CI configuration, and CI workflows are often incomplete. Never infer that a test is not collected or not executed from a CI workflow, a missing runner config, or CI using a different language's runner; such a test is existing evidence at its layer. Only an explicit marker in the test code (skip, xfail, disabled, commented out, an `if False`-style guard) shows a test does not run, and then it is a `weak_test` (confidence per the evidence rule in SKILL.md). Do not suggest CI or runner configuration changes.

A test that drives the same branch with an equivalent input is evidence for that branch: a whitespace-only name that trims to empty covers the empty-name rejection. Suggest boundary variants only as a `weak_test` on the test line, never as a `missing_test` on production code; an untested sibling-path divergence or unguarded input shape is a `missing_test` (SKILL.md steps 2c, 2d).

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

Report each weak assertion line as its own finding (one line each), never merged into one finding on the last of them, so the developer can fix each.

Weak means the assertion would still pass for a wrong value of the behaviour under test: truthiness, existence or type of the result itself, or an expected value computed by calling the implementation. A boolean helper that compares against explicit expected values (e.g. `assert.ok(has(args, '-c:v', 'mpeg4'))`, which checks an exact adjacent sequence), or an expected value written as constant arithmetic (`w: 20 * 2 + 20 * 0.6 * 2`), is a real check: at most an oracle-independence note, never `weak_test`.

## Mocks and seams

Prefer mocks at system boundaries: external APIs, time, randomness, sometimes the DB or file system. An internal mock or a call-count assertion alone is not proof of a weak test: identify the missed behavioural regression and respect the repo's testing contract.

Test at seams, meaning public boundaries. For `pushdown`, if a unit test would need to mock the project's own modules, it is not a candidate; otherwise target the smallest public seam, never a private function.

## Test layers

A unit test isolates a behaviour through a public seam, without network or a real DB. Use repository configuration, fixtures and dependencies to tell unit, component, integration and end-to-end tests apart; keep the repo's names in the explanation but use the schema's layer labels. When the layer is uncertain, mark the obligation `unknown` instead of crediting unit coverage.

For every cited assertion, copy a real source line and explain the input and expected outcome it checks. A test name, a file's existence, or execution of a branch alone is not assertion evidence. `covered` requires unit evidence; `higher_level_only` records evidence at other layers without implying it should always move. Keep integration checks for wiring, persistence, protocols and cross-component contracts. Recommend pushdown only for separable deterministic logic, and retain those integration responsibilities.
