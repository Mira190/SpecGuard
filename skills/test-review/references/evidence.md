# Evidence and weak tests

Read at procedure steps 4 and 5.

## What counts as evidence

A test counts only if the cited line names the behaviour it proves. A good test checks behaviour through the public interface, so it survives refactors.

Not evidence (counts as zero):
- assertions that mirror the implementation, change detectors, "mock exists" checks;
- fakes that accept anything;
- assertions that can only fail by crashing;
- a tautological assertion: the expected value is recomputed the way the code computes it, so it passes by construction. Expected values must come from an independent source: a literal, a worked example, or the acceptance criterion's own numbers.

## Weak-test catalogue

Report `weak_test` on the assertion line when a test exercises the behaviour but:
- survives a plausible mutation: flipped condition, dropped branch, off-by-one, swapped error;
- is coupled to the implementation:
  - mocks the project's own modules or internal collaborators;
  - tests a private method;
  - asserts call counts or call order;
  - verifies through a side channel (querying the DB directly) instead of reading back through the interface;
  - would break on a refactor that does not change behaviour;
- asserts only that something is truthy, non-null or did not throw, when a value is available to compare.

## Mocks and seams

Mock only at system boundaries: external APIs, time, randomness, sometimes the DB or file system. Never mock the project's own modules.

Test at seams, meaning public boundaries. For `pushdown`, if a unit test would need to mock the project's own modules, it is not a candidate. Otherwise target the smallest public seam, never a private function.

## Test layers

A unit test covers one function or class through its public interface, with no network and no real DB. Anything wider is component or integration. Use the repo's own names for layers.
