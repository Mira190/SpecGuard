# Review batch 1 — fixes for `critical-shift-left-review-2026-10-15.md` (2026-10-15)

Offline only; no paid model run. Full suite: 1056 pass, 0 fail, 1 skip, 1 todo.

| Finding | Fix | Regression |
|---|---|---|
| F01 / P3 | `leads.assertionDelta`: assertions moved into a parameter table (same function asserted with variables, removed literals in order on one added row) are no lead, so no auto `missing_test` | `src/leads.test.js` "parameter table": array and object rows pass; a dropped row and numbers split across rows stay leads; mutation-checked |
| F02 / P1 | scan `verify`: a test citation must be an assertion outside a skipped test (`post.assertionKind`, the PR-mode rule) or it is removed and `covered` downgrades | `src/audit-post.test.js` "skipped, empty or declaration-only" with a real-assertion control |
| F03 / P2 | scan `validate`: a block answered both as requirement and not-requirement keeps its row as `unknown` with both answers noted; it is no longer deleted from the denominator | `src/audit-post.test.js` "every result names a listed block" |
| F05 / P5 | `eval/grade.js`: a visible, not low-confidence summary finding that matches nothing is a FP (`level: 'summary'`) and breaks `expect_clean`; one that served an `allow_summary` TP or is `acceptable` is not | `eval/grade.test.js` "visible summary-only finding" |
| F08 / P4 | summary delta says "N with later changes (fix not verified)", never "fixed"; `outcome` logic unchanged | `src/post.test.js` layout test; README |

Not done here: F04 (weak_test counterfactual; model-side), F06–F12 (batch 2+), the table rule only covers one-line rows in the same file; `assertionKind` still reads a custom helper without assert/expect in its name as no assertion (same limit as PR mode).
