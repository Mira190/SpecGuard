<!-- specguard:repo-audit template v0. MOCK: every number, path and finding below is illustrative. Field rules: docs/repo-audit-summary-design-2026-10-22.md -->
## SpecGuard repository audit · example/cart-service @ `4f2c9e1`

> **Mock report.** Illustrative data for the template, not a measurement.

**❌ 9 things to fix. 6 come from coverage, CI results or exact rules; 3 are model judgements to check first.** Scope: `src/`, 212 files, all reviewed. Tests were not run by SpecGuard.

| Evidence this report used | |
|---|---|
| Unit / integration coverage | ✅ the repository's own reports for this commit (Codecov flags `unit`, `integration`) |
| End-to-end coverage | ❌ none. End-to-end numbers below are test counts, not coverage |
| CI history | ✅ 30 runs on `main` and 41 PR runs, last 14 days |
| Requirements / design docs | 3 documents, 64 requirements / 1 document, 9 components |
| Mutation testing | ❌ not run. Test strength comes from static rules only |

### At a glance

| Area | | To act on | Evidence |
|---|---|---|---|
| Untested code (unit) | ❌ | 12 definitions no unit test runs, 5 with error handling | E |
| Tests that never run | ❌ | 38 integration tests no CI job runs | E S |
| Unit test quality | ⚠️ | 4 tests assert nothing, 3 flaky, 9 skipped over 90 days | E S |
| Test placement | ⚠️ | 4 business rules tested only end-to-end | S M |
| Requirement coverage | ⚠️ | 7 of 64 requirements have no test; 11 only above unit level | M |
| Requirement health | ⚠️ | 5 requirements cannot be tested as written | M |
| Design coverage | ⚠️ | 2 of 9 components have no test; 1 design/code mismatch | S M |
| CI checks | ⚠️ | no coverage gate on new code; E2E skipped on PRs | S |

Evidence: **E** executed (coverage report, CI results) · **S** static rule (exact, can miss things) · **M** model judgement (check before acting). Changes since the last scan (`9d1a0b7`, 7 days ago): 3 new, 5 fixed, 9 still open.

### Do these first

| # | Do | Where | Why | Ev. | Owner | Seen |
|---|---|---|---|---|---|---|
| 1 | **Add a unit test** for the refund error path | [`src/payments/refund.ts:88-104`](#) `refund()` | 17 lines never run by any test, 6 are `catch`/`throw`; 4 fix commits in 180 days | E | @payments | 3 scans |
| 2 | **Make CI run** `test/integration/legacy/**` | [`vitest.integration.config.ts:7`](#) | `include` matches `*.int.ts`; these 38 tests are `*.spec.ts`, so no job runs them | S E | @platform | new |
| 3 | **Fix or quarantine** a flaky test | [`test/cart/merge.test.ts:41`](#) `merges guest cart` | failed then passed on retry in 4 of 71 runs | E | @cart | 2 scans |
| 4 | **Add a unit test** for the coupon stacking limit | [`src/pricing/coupons.ts:52-61`](#) `applyCoupons()` | branch `stack > MAX_STACK` never runs in unit or integration tests; only `e2e/checkout.e2e.ts` names the function | E | @pricing | new |
| 5 | **Move down** the tax-rounding cases | [`e2e/checkout.e2e.ts:120-188`](#) → `src/pricing/tax.ts` `roundTax()` | 6 E2E cases vary only the amount; `roundTax()` is pure. Keep 1 E2E for the wiring | S M | @pricing | 3 scans |
| 6 | **Add an assertion** or delete | [`test/inventory/reserve.test.ts:15`](#) and 3 more | the test body has no `expect`; it passes whatever the code does | S | @inventory | 3 scans |
| 7 | **Add a coverage gate on new code** | [`.github/workflows/ci.yml`](#) | only a 60% project-wide check exists; changed lines can be untested | S | @platform | 3 scans |
| 8 | **Clarify** with the requirement owner | [`docs/requirements/checkout.md:34`](#) REQ-CHK-12 | "the page must load quickly": no number, so no test can pass or fail it | M | @product | new |
| 9 | **Check:** the code may contradict the design | [`docs/design.md:58`](#) vs [`src/clients/inventory.ts:22`](#) | doc: "3 retries, exponential backoff"; code: `retries: 5`, fixed 200 ms delay | M | @inventory | 2 scans |

Ranking: items backed by evidence (E, S) come before model judgements (M); then by risk (fix commits, error-handling lines); then by effort; at most 2 per file. "Owner" comes from CODEOWNERS. "Seen" counts the scans that reported it. Not useful? Comment `/specguard not-useful 5`; a finding type that more than 10% of readers mark not useful is turned off.

<details><summary><b>Untested code (unit)</b>: 12 definitions with lines no unit test runs · unit line coverage 71.4%, branch 58.2%</summary>

Source: the repository's unit coverage report for `4f2c9e1` (flag `unit`). Lines that only integration or E2E tests run count as untested here: the goal is a unit test.

| Definition | Lines never run | Error handling | Fix commits (180 d) | Also run by |
|---|---|---|---|---|
| `src/payments/refund.ts` `refund()` | 88-104 (17) | 6 | 4 | none |
| `src/pricing/coupons.ts` `applyCoupons()` | 52-61 (10) | 2 | 2 | none (named in an E2E test) |
| `src/cart/merge.ts` `mergeCarts()` | 30-37 (8) | 3 | 1 | integration |
| `src/orders/cancel.ts` `cancelOrder()` | 71-79 (9) | 4 | 0 | none |
| `src/shipping/zones.ts` `zoneFor()` | 12-15 (4) | 0 | 1 | none |

Test sketch for `refund()` (not run; fill in the fixture):

```ts
it('rejects a refund larger than the captured amount', async () => {
  const gateway = fakeGateway({ captured: 50_00 });
  await expect(refund(gateway, { orderId: 'o1', amount: 60_00 }))
    .rejects.toThrow(RefundExceedsCaptureError);
  expect(gateway.refunds).toHaveLength(0);
});
```

+7 more in the run artifact (`audit.json`). 14 source files are not in the coverage report at all: 9 excluded by its config as generated (`src/gen/**`), 5 for no stated reason (`src/admin/**`). Not in the report does not mean tested.

| Coverage by level | Test files | Tests | Runs on PRs | Line | Branch | Change |
|---|---|---|---|---|---|---|
| Unit | 84 | 1,212 | ✅ | 71.4% | 58.2% | +1.2 pp |
| Component (UI, jsdom) | 22 | 140 | ✅ | in the unit report | | |
| Integration | 12 | 96 | ❌ nightly only; 38 tests never | 44.0% | 31.5% | −0.4 pp |
| Contract (API) | 0 | 0 | | | | |
| End-to-end | 9 | 41 | ❌ `main` only | not measured | | |

No contract tests although the service calls 2 external APIs (`src/clients/payments.ts`, `src/clients/inventory.ts`). The level of a test comes from its folder, file name and runner config ([rules](#)).
</details>

<details><summary><b>Unit test quality</b>: 4 tests assert nothing · 3 flaky · 9 skipped over 90 days · 2 likely duplicates · test strength not measured</summary>

| Problem | Test | Evidence | Do |
|---|---|---|---|
| No assertion | `test/inventory/reserve.test.ts:15` `reserves stock` | no `expect`/`assert` in the body or its helpers (S) | add an assertion or delete |
| Asserts only that a value exists | `test/orders/create.test.ts:40` | `expect(order).toBeTruthy()`: any non-empty order passes (S) | assert the fields the rule sets |
| Flaky | `test/cart/merge.test.ts:41` | retried green in 4 of 71 CI runs (E) | fix; quarantine if not fixed in 14 days |
| Skipped 412 days | `test/shipping/zones.test.ts:88` `it.skip(...)` | skipped since `2025-09-05` (S) | fix or delete |
| Mocks the code under test | `test/pricing/tax.test.ts:9` | `vi.mock('../../src/pricing/tax')` in the test of `tax.ts` (S) | test the real function |

+11 more rows in the run artifact.

Test strength (do the tests fail when the code is wrong?) needs mutation testing; this scan did not run it. Enable `mutation: changed-lines` to measure it for new code.
</details>

<details><summary><b>Test placement</b>: 4 business rules tested only end-to-end · 3 "unit" tests use the network</summary>

| Rule or behaviour | Tested now in | Unit seam | Keep above unit | Ev. |
|---|---|---|---|---|
| Tax rounding per region | `e2e/checkout.e2e.ts:120-188` (6 cases) | `roundTax()` in `src/pricing/tax.ts`, pure | 1 E2E for the checkout flow | S M |
| Coupon stacking limit | `e2e/checkout.e2e.ts:201` | `applyCoupons()`, pure | none | S M |
| Guest cart merge on login | `test/integration/auth.int.ts:55` | `mergeCarts()`; needs a cart store fake | login wiring | M |
| Free-shipping threshold | `e2e/cart.e2e.ts:33` | `zoneFor()` + `shippingFee()`, pure | none | S M |

Unit tests that are really integration tests (they open a socket or real database, so they are slow and can flake): `test/orders/history.test.ts` (real `pg` client), `test/clients/payments.test.ts` (live `fetch`), `test/cart/session.test.ts` (Redis). Move them to `test/integration/` or fake the dependency.
</details>

<details><summary><b>Requirement coverage</b>: 64 requirements · 31 unit-tested · 11 only above unit · 8 partly · 7 no test · 2 contradicted · 5 not testable</summary>

The model maps each requirement to code and tests; SpecGuard checks that every quoted line exists. A "no test" result means the search found none, not that none exists.

| Status | Requirements | Do |
|---|---|---|
| No test found | 7 | add a test at the level in the row |
| Code contradicts it | 2 | fix the code or the requirement |
| Partly tested | 8 | test the missing case |
| Only above unit level | 11 | move down where a unit seam exists (see Test placement) |
| Unit-tested | 31 | nothing |
| Not testable as written | 5 | see Requirement health |

| Requirement | Says | Status | Where |
|---|---|---|---|
| REQ-CHK-07 | A refund can't exceed the captured amount | no test found | `src/payments/refund.ts:91` |
| REQ-CART-03 | Guest cart items merge on login, keeping the larger quantity | contradicted: code sums quantities | `src/cart/merge.ts:33` |
| REQ-ORD-11 | A cancelled order releases reserved stock | partly: release tested, not the restock event | `test/orders/cancel.test.ts:22` |

+14 more gap rows in the run artifact.
</details>

<details><summary><b>Requirement health</b>: 5 not testable · 3 ambiguous · 2 compound · 1 conflict between documents · 2 describe removed features</summary>

Rules from ISO/IEC/IEEE 29148 (verifiable, unambiguous, singular, complete, consistent); a model applies them, so check before acting.

| Problem | Requirement | Text | Do |
|---|---|---|---|
| Not testable | REQ-CHK-12 | "The page must load quickly." | add a number, e.g. p95 under 2 s |
| Ambiguous | REQ-CART-09 | "Handle large carts appropriately." | name the limit and the behaviour at the limit |
| Compound | REQ-ORD-04 | "Cancel the order and notify the user and refund." | split into 3 requirements |
| Conflict | REQ-SHP-02 vs `docs/api.md:140` | free shipping from €50 vs from €40 | one owner decides; fix the other |
| Removed feature | REQ-GIFT-01..02 | gift wrapping | no code since `b71e0aa`; delete or mark obsolete |

+8 more rows in the run artifact.
</details>

<details><summary><b>Design coverage and health</b>: 9 components · 7 with tests · 1 design/code mismatch · 1 dependency cycle</summary>

| Component (`docs/design.md`) | Code | Tests | Note |
|---|---|---|---|
| Inventory client | `src/clients/inventory.ts` | unit | retry policy differs from the design (M) |
| Payment client | `src/clients/payments.ts` | none | external API, no contract test |
| Admin API | `src/admin/` | none | not in the coverage report |

Dependency cycle (S): `src/cart` → `src/pricing` → `src/cart` (`pricing/discounts.ts:3`). Layering (S): `src/routes/orders.ts:5` imports `src/db/` directly; the design says routes call services.
</details>

<details><summary><b>CI checks</b>: unit ✅ on PRs · integration nightly · E2E on main only · no coverage gate on new code · 38 tests never run</summary>

From the workflow files and the check runs of the last 14 days. SpecGuard did not change or rerun anything.

| Check | Status | Evidence |
|---|---|---|
| Unit tests on every PR | ✅ required | `ci.yml` job `test` |
| Integration tests on PRs | ❌ nightly only | `nightly.yml`; a PR can break them unseen until the next night |
| E2E on PRs | ⚠️ `main` only | `e2e.yml` `on: push: branches: [main]` |
| Every test file run by some job | ❌ 38 not | `test/integration/legacy/*.spec.ts` matches no runner config |
| Coverage gate | ⚠️ 60% project-wide only | no gate on changed lines |
| Lint, format, type check | ✅ | `ci.yml` jobs `lint`, `typecheck` |
| Retries hide failures | ⚠️ | `retry: 2` in `vitest.config.ts`; 7 green runs needed a retry |
| Security scans | ✅ CodeQL, Dependabot · ❔ secret scanning | the token can't read secret-scanning settings |
| Branch protection | ❔ unknown | the token can't read it; not counted as passing |
</details>

<details><summary>How this report was made, what it did not cover, and how accurate each finding type is</summary>

- Scope: `src/`; requirements, tests and evidence are read from the whole repository. Not reviewed: none this run.
- SpecGuard does not run the repository's code. Coverage and CI facts come from the repository's own reports and check runs for this commit; a report for another commit is not used.
- Counts are fixed by the files, not by the model: the same commit gives the same denominators.
- Accuracy measured on SpecGuard's own evaluations (see `docs/`). Coverage gaps: the cited lines never ran in 100% of checked cases. Model claims that a test is missing: 0–15% correct, so they are never ranked above evidence. Requirement mapping and design checks: not yet measured.
- No overall score: a single number hides which fix to make and invites gaming the number.
- Full data: `audit.json` in the run artifact. Run, cost and versions: see the run log.
</details>
