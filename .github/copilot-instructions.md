# SpecGuard coding standard

- JavaScript targets Node 22 and uses only Node built-ins: no npm dependencies.
- Unit tests use `node:test` and `node:assert`, and live next to the code as `<name>.test.js`.
- Every exported function needs a unit test that asserts on its return value or thrown error. A `typeof` check or "does not throw" alone does not count.
- Test names describe the behaviour under test, e.g. `rejects negative totals`, not `works` or `test 1`.
- Throw `Error` (or a subclass) with a message; never throw strings.
