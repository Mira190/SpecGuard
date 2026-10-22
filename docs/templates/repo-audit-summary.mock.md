<!-- specguard:repo-audit template v1. MOCK: every number, path and finding below is illustrative. Field rules: docs/repo-audit-summary-design-2026-10-22.md -->
## SpecGuard repository audit · example/cart-service @ `4f2c9e1`

> **Mock report.** Illustrative data for the template, not a measurement.

**❌ 9 things to fix: 6 backed by coverage, CI results or exact rules, 3 model judgements to check first.** Scope: `src/`, 212 files, all reviewed. SpecGuard read the code and the repository's own reports; it did not run any tests.

| Evidence this report used | |
|---|---|
| Unit / integration coverage | ✅ the repository's own reports for this commit (Codecov flags `unit`, `integration`) |
| End-to-end coverage | ❌ none. End-to-end numbers below are test counts, not coverage |
| CI history | ✅ 30 runs on `main` and 41 PR runs, last 14 days |
| Requirements / design docs | 3 documents, 64 requirements / 1 document, 9 components |
| Mutation testing | ❌ not run. Whether the tests fail when the code is wrong is not measured |

### Scores

| Area | Score | Since last scan | Ev. | To act on | Raised by |
|---|---|---|---|---|---|
| Unit test coverage | **71.4%** of lines (3,402 of 4,765) · 58.2% of branches (611 of 1,050) | +1.2 pp | E | 12 definitions with lines no unit test runs | #1, #4 |
| Tests run on every PR | **89%** (1,352 of 1,527 tests) | same | S E | 38 tests no CI job runs; integration and E2E skip PRs | #2 |
| Unit tests free of known defects | **98.1%** (1,326 of 1,352) | +0.5 pp | S E | 26 tests: no assertion, flaky, skipped, mocked | #3, #6 |
| Rules tested at the lowest level | **89%** (31 of 35 rules that have a unit seam) | same | S M | 4 rules tested only end-to-end | #5 |
| Requirement coverage | **66%** fully tested (42 of 64) | +3 pp | M | 7 with no test, 8 partly tested, 2 contradicted | #8 |
| Requirement health | **81%** pass every check (52 of 64) | −2 pp | M | 12 requirements, 5 of them not testable as written | #8 |
| Design coverage | **78%** of components have code and a test (7 of 9) | same | S M | 2 components untested; 1 design/code mismatch | #9 |
| Design structure | **79%** of modules break no dependency rule (11 of 14) | −14 pp | S | 1 new cycle, 1 layer skip | |
| CI protections | **3 of 8** in place · 1 unknown | same | S | no coverage gate on new code; retries hide failures | #2, #7 |

Each score is a count over a fixed denominator taken from the files at this commit, so the same commit always gives the same score, and the last column names the fixes that raise it. There is no overall score: one number cannot tell you which test to write. "Ev.": **E** executed (coverage report, CI results) · **S** static rule (exact, can miss things) · **M** model judgement (check before acting).

### Do these first

| # | Do | Where | Why | Ev. | Owner | Seen |
|---|---|---|---|---|---|---|
| 1 | **Add a unit test** for the refund error path | [`src/payments/refund.ts:88-104`](#) `refund()` | 17 lines never run by any test, 6 are `catch`/`throw`; 4 fix commits in 180 days | E | @payments | 3 scans |
| 2 | **Make CI run** `test/integration/legacy/**` | [`vitest.integration.config.ts:7`](#) | `include` matches `*.int.ts`; these 38 tests are `*.spec.ts`, so no job runs them | S E | @platform | new |
| 3 | **Fix or quarantine** a flaky test | [`test/cart/merge.test.ts:41`](#) `merges guest cart` | failed, then passed on retry, in 4 of 71 runs | E | @cart | 2 scans |
| 4 | **Add a unit test** for the coupon stacking limit | [`src/pricing/coupons.ts:52-61`](#) `applyCoupons()` | branch `stack > MAX_STACK` never runs in unit or integration tests; only `e2e/checkout.e2e.ts` names the function | E | @pricing | new |
| 5 | **Move down** the tax-rounding cases | [`e2e/checkout.e2e.ts:120-188`](#) → `src/pricing/tax.ts` `roundTax()` | 6 E2E cases vary only the amount; `roundTax()` is pure. Keep 1 E2E for the wiring | S M | @pricing | 3 scans |
| 6 | **Add an assertion** or delete | [`test/inventory/reserve.test.ts:15`](#) and 3 more | the test body has no `expect`; it passes whatever the code does | S | @inventory | 3 scans |
| 7 | **Add a coverage gate on new code** | [`.github/workflows/ci.yml`](#) | only a 60% project-wide check exists; changed lines can ship untested | S | @platform | 3 scans |
| 8 | **Clarify** with the requirement owner | [`docs/requirements/checkout.md:34`](#) REQ-CHK-12 | "the page must load quickly": no number, so no test can pass or fail it | M | @product | new |
| 9 | **Check:** the code may contradict the design | [`docs/design.md:58`](#) vs [`src/clients/inventory.ts:22`](#) | design: "3 retries, exponential backoff"; code: `retries: 5`, fixed 200 ms delay | M | @inventory | 2 scans |

Ranking: evidence (E, S) before model judgements (M), then risk (fix commits, error-handling lines), then effort; at most 2 per file. "Owner" comes from CODEOWNERS; "Seen" counts the scans that reported it. Not useful? Comment `/specguard not-useful 5`; a finding type that more than 10% of readers mark not useful is turned off.

<details><summary><b>Unit test coverage 71.4%</b>: 12 definitions with lines no unit test runs, 5 with error handling</summary>

Source: the repository's unit coverage report for `4f2c9e1` (flag `unit`). A line that only integration or E2E tests run still counts as untested here, because the fix is a unit test.

| Definition | Lines never run | Error handling | Fix commits (180 d) | Run by other levels |
|---|---|---|---|---|
| `src/payments/refund.ts` `refund()` | 88-104 (17) | 6 | 4 | none |
| `src/pricing/coupons.ts` `applyCoupons()` | 52-61 (10) | 2 | 2 | none (named in an E2E test) |
| `src/cart/merge.ts` `mergeCarts()` | 30-37 (8) | 3 | 1 | integration |
| `src/orders/cancel.ts` `cancelOrder()` | 71-79 (9) | 4 | 0 | none |
| `src/shipping/zones.ts` `zoneFor()` | 12-15 (4) | 0 | 1 | none |

**Example: the missing unit test for #1.** `refund()` checks the amount against the captured payment, but no test ever passes a larger amount:

```ts
// src/payments/refund.ts:88
if (req.amount > payment.captured) {
  throw new RefundExceedsCaptureError(req.orderId);   // never run
}
```

Test sketch (not run; adjust the fixture):

```ts
it('rejects a refund larger than the captured amount', async () => {
  const gateway = fakeGateway({ captured: 50_00 });
  await expect(refund(gateway, { orderId: 'o1', amount: 60_00 }))
    .rejects.toThrow(RefundExceedsCaptureError);
  expect(gateway.refunds).toHaveLength(0);
});
```

+7 more definitions in the run artifact (`audit.json`). 14 source files are not in the coverage report at all: 9 excluded by its config as generated (`src/gen/**`), 5 for no stated reason (`src/admin/**`). A file missing from the report is not a tested file.

| Coverage by level | Test files | Tests | Runs on PRs | Line | Branch |
|---|---|---|---|---|---|
| Unit | 84 | 1,212 | ✅ | 71.4% | 58.2% |
| Component (UI, jsdom) | 22 | 140 | ✅ | in the unit report | |
| Integration | 17 | 134 | ❌ 96 nightly; 38 never | 44.0% | 31.5% |
| Contract (API) | 0 | 0 | | | |
| End-to-end | 9 | 41 | ❌ `main` only | not measured | |

No contract tests, although the service calls 2 external APIs (`src/clients/payments.ts`, `src/clients/inventory.ts`). A test's level comes from its runner config, then its folder, then its file name ([rules](#)).
</details>

<details><summary><b>Tests run on every PR 89%</b>: 38 tests no job runs · integration nightly · E2E on main only</summary>

| Tests | Count | Where they run |
|---|---|---|
| Unit and component | 1,352 | every PR (`ci.yml` job `test`) |
| Integration | 96 | nightly only (`nightly.yml`): a PR can break them unseen until the next night |
| Integration, legacy | 38 | nowhere: `test/integration/legacy/*.spec.ts` matches no runner `include` |
| End-to-end | 41 | pushes to `main` only (`e2e.yml`) |
</details>

<details><summary><b>Unit tests free of known defects 98.1%</b>: 4 assert nothing · 6 only check a value exists · 3 flaky · 9 skipped over 90 days · 2 mock the code they test · 2 duplicates</summary>

98.1% only means 1,326 tests break none of the rules below. Whether they catch wrong code is not measured: that needs mutation testing (enable `mutation: changed-lines`).

| Problem | Test | Evidence | Do |
|---|---|---|---|
| No assertion | `test/inventory/reserve.test.ts:15` `reserves stock` | no `expect` or `assert` in the body or its helpers (S) | add an assertion or delete |
| Only checks a value exists | `test/orders/create.test.ts:40` | `expect(order).toBeTruthy()` (S) | assert the fields the rule sets |
| Flaky | `test/cart/merge.test.ts:41` | passed on retry in 4 of 71 CI runs (E) | fix; quarantine if not fixed in 14 days |
| Skipped 412 days | `test/shipping/zones.test.ts:88` `it.skip(...)` | skipped since 2025-09-05 (S) | fix or delete |
| Mocks the code under test | `test/pricing/tax.test.ts:9` | `vi.mock('../../src/pricing/tax')` in the test of `tax.ts` (S) | test the real function |

**Example: a test that cannot fail.** `test/orders/create.test.ts:40`:

```ts
const order = await createOrder(cart);
expect(order).toBeTruthy();
```

It still passes if `createOrder` returns the wrong total, the wrong currency or no line items. Assert what the rule says, for example `expect(order.total).toBe(cart.subtotal - cart.discount + cart.shipping)`.

+21 more rows in the run artifact.
</details>

<details><summary><b>Rules tested at the lowest level 89%</b>: 4 business rules tested only end-to-end · 3 "unit" tests use the network or a database</summary>

A rule belongs in a unit test when a function that decides it can be called without the network, a database or a browser. Rules that need those stay above unit level and are not counted against this score.

| Rule | Tested now in | Unit seam | Keep above unit | Ev. |
|---|---|---|---|---|
| Tax rounding per region | `e2e/checkout.e2e.ts:120-188` (6 cases) | `roundTax()` in `src/pricing/tax.ts`, pure | 1 E2E for the checkout flow | S M |
| Coupon stacking limit | `e2e/checkout.e2e.ts:201` | `applyCoupons()`, pure | none | S M |
| Free-shipping threshold | `e2e/cart.e2e.ts:33` | `shippingFee()`, pure | none | S M |
| Guest cart merge on login | `test/integration/auth.int.ts:55` | `mergeCarts()`, needs a cart store fake | the login wiring | M |

**Example: #5, tax rounding.** Today each case drives a browser through checkout (about 9 s each, and E2E runs only on `main`):

```ts
// e2e/checkout.e2e.ts:120
for (const [region, amount, expected] of TAX_CASES) {
  test(`tax for ${region} ${amount}`, async ({ page }) => {
    await checkoutWith(page, { region, amount });
    await expect(page.getByTestId('tax')).toHaveText(expected);
  });
}
```

Only the amount and region change, and `roundTax()` is a pure function. The same 6 cases as a unit test run in milliseconds on every PR:

```ts
// test/pricing/tax.test.ts
it.each(TAX_CASES)('rounds tax for %s %d', (region, amount, expected) => {
  expect(roundTax(region, amount)).toBe(expected);
});
```

Keep one E2E case that checks the tax is shown at checkout.

**Tests in the wrong place (upward):** `test/orders/history.test.ts` (a real `pg` client), `test/clients/payments.test.ts` (a live `fetch`), `test/cart/session.test.ts` (Redis). They sit with the unit tests but are integration tests, so they are slow and can flake. Move them to `test/integration/` or fake the dependency.
</details>

<details><summary><b>Requirement coverage 66%</b>: 64 requirements · 31 unit-tested · 11 tested only above unit · 8 partly · 7 no test · 2 contradicted · 5 not testable</summary>

The model maps each requirement to code and tests; SpecGuard checks that every quoted line exists. "No test found" means the search found none, not that none exists. Requirements that cannot be tested stay in the denominator, so clarifying them raises the score.

| Status | Requirements | Do |
|---|---|---|
| No test found | 7 | add a test at the level in the row |
| Code contradicts it | 2 | fix the code or the requirement |
| Partly tested | 8 | test the missing case |
| Tested only above unit level | 11 | move down where a unit seam exists (see Rules tested at the lowest level) |
| Unit-tested | 31 | nothing |
| Not testable as written | 5 | see Requirement health |

| Requirement | Says | Status | Where |
|---|---|---|---|
| REQ-CHK-07 | A refund can't exceed the captured amount | no test found | `src/payments/refund.ts:91` |
| REQ-CART-03 | Guest cart items merge on login, keeping the larger quantity | contradicted: the code adds the quantities | `src/cart/merge.ts:33` |
| REQ-ORD-11 | A cancelled order releases reserved stock | partly: the release is tested, the restock event is not | `test/orders/cancel.test.ts:22` |

+14 more gap rows in the run artifact.
</details>

<details><summary><b>Requirement health 81%</b>: 5 not testable · 3 ambiguous · 2 compound · 1 conflict between documents · 2 describe removed features</summary>

Checks from ISO/IEC/IEEE 29148: verifiable, unambiguous, singular, complete, consistent, current, traceable to code. A model applies them, so check before acting. 12 requirements have 13 problems.

| Problem | Requirement | Text | Do |
|---|---|---|---|
| Not testable | REQ-CHK-12 | "The page must load quickly." | add a number, e.g. p95 under 2 s |
| Ambiguous | REQ-CART-09 | "Handle large carts appropriately." | name the limit and what happens at it |
| Compound | REQ-ORD-04 | "Cancel the order and notify the user and refund." | split into 3 requirements |
| Conflict | REQ-SHP-02 vs `docs/api.md:140` | free shipping from €50 vs from €40 | one owner decides; fix the other |
| Removed feature | REQ-GIFT-01, REQ-GIFT-02 | gift wrapping | no code since `b71e0aa`; delete or mark obsolete |

+7 more problems in the run artifact.
</details>

<details><summary><b>Design coverage 78%, structure 79%</b>: 2 components untested · 1 design/code mismatch · 1 new dependency cycle · 1 layer skip</summary>

| Component (`docs/design.md`) | Code | Tests | Note |
|---|---|---|---|
| Inventory client | `src/clients/inventory.ts` | unit | retry policy differs from the design (M) |
| Payment client | `src/clients/payments.ts` | none | external API, no contract test |
| Admin API | `src/admin/` | none | not in the coverage report |

+6 components with code and tests.

Dependency cycle (S, new): `src/cart` → `src/pricing` → `src/cart`, through `src/pricing/discounts.ts:3`. Layer skip (S): `src/routes/orders.ts:5` imports `src/db/` directly; the design says routes call services.
</details>

<details><summary><b>CI protections 3 of 8</b>: no coverage gate on new code · retries hide failures · integration and E2E skip PRs</summary>

From the workflow files and the check runs of the last 14 days. SpecGuard did not change or rerun anything.

| Protection | Status | Evidence |
|---|---|---|
| Unit and component tests on every PR | ✅ required | `ci.yml` job `test` |
| Integration tests on PRs | ❌ nightly only | `nightly.yml` |
| E2E tests on PRs | ❌ `main` only | `e2e.yml` `on: push: branches: [main]` |
| Every test file run by some job | ❌ 38 tests not | `test/integration/legacy/*.spec.ts` |
| Coverage gate on new code | ❌ project-wide 60% only | `codecov.yml` has no `patch` target |
| Lint, format, type check | ✅ | `ci.yml` jobs `lint`, `typecheck` |
| Retries do not hide failures | ❌ | `retry: 2` in `vitest.config.ts`; 7 green runs needed a retry |
| Security scans | ✅ CodeQL, Dependabot | secret scanning: the token can't read it |
| Branch protection on `main` | ❔ unknown, not counted | the token can't read it |
</details>

<details><summary>How this report was made, why these scores, and how accurate each finding type is</summary>

**Why these scores.** A tester needs three things from this page: whether to trust it, what to fix first, and where the risk is. So each score follows the same rules:
- It is a count with a fixed denominator from the files at this commit. A model answering less can't make a score look better.
- It shows its evidence grade. A 98% from static rules is not a 98% from mutation testing, so the row says what was measured.
- It names the fixes that raise it. A score no fix can move is not shown.
- Not measured is shown as "not measured", never as 0% or 100%.
- No targets or grade bands: a target becomes the ceiling teams stop at. The change since the last scan shows the direction.
- No overall score: it would mix evidence grades and hide which fix to make.

**Method.** Scope: `src/`; requirements, tests and evidence are read from the whole repository. Not reviewed this run: none. SpecGuard does not run the repository's code: coverage and CI facts come from the repository's own reports and check runs for this commit, and a report for another commit is not used.

**Accuracy, measured on SpecGuard's own evaluations.**

| Finding type | Measured accuracy |
|---|---|
| Coverage gaps | the cited lines never ran in 100% of checked cases |
| Model claims that a unit test is missing | 0–15% correct; never ranked above evidence |
| Requirement mapping, requirement health, design checks | not yet measured |

Full data: `audit.json` in the run artifact. Run, cost and versions: see the run log.
</details>
