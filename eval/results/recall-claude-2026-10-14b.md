# Evaluation recall-claude-2026-10-14b

Repo Mira190/SpecGuard, target main. Model: unchanged (requested via SPECGUARD_EVAL_MODEL; the Copilot output does not state the model actually used). Cost: not measured (pass --billing). Latency is the dogfood job duration.

| Case | Goal | Rep | Pass | TP | FP | Acceptable | FN | Summary only | JSON valid | Degraded | Latency | Notes |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| js2 | requirements | 1 | yes | 2 | 0 | 1 | 0 | 0 | yes | no | 43s | acceptable missing_test fetchWithRetry.js:1 |
| l1 | layering | 1 | yes | 1 | 0 | 0 | 0 | 1 | yes | yes | 48s | degraded: 1 validation note(s) |
| p1 | requirements | 1 | yes | 1 | 0 | 0 | 0 | 0 | yes | no | 26s |  |
| r1 | requirements | 1 | no | 3 | 0 | 0 | 1 | 1 | yes | no | 35s | FN weak_test discount.test.js:7 |
| r2 | requirements | 1 | yes | 0 | 0 | 0 | 0 | 0 | yes | no | 26s |  |
| r3 | requirements | 1 | yes | 1 | 0 | 0 | 0 | 0 | yes | no | 32s |  |
| r4 | requirements | 1 | yes | 1 | 0 | 0 | 0 | 0 | yes | no | 30s |  |
| rx1 | layering | 1 | yes | 0 | 0 | 0 | 0 | 0 | yes | no | 48s |  |
| rx2 | requirements | 1 | yes | 1 | 0 | 0 | 0 | 0 | yes | no | 41s |  |
| rx3 | test_quality | 1 | no | 0 | 0 | 1 | 1 | 0 | yes | yes | 31s | FN weak_test CartSummary.test.tsx:10; acceptable missing_test CartSummary.tsx:5; degraded: 1 validation note(s) |
| s1 | standards | 1 | yes | 1 | 0 | 0 | 0 | 0 | yes | no | 27s |  |
| t1 | test_quality | 1 | yes | 1 | 0 | 0 | 0 | 0 | yes | yes | 46s | degraded: 4 validation note(s) |
| t2 | test_quality | 1 | yes | 1 | 0 | 0 | 0 | 0 | yes | no | 27s |  |
| t3 | test_quality | 1 | yes | 1 | 0 | 0 | 0 | 0 | yes | yes | 31s | degraded: 2 validation note(s) |
| t4 | test_quality | 1 | no | 0 | 0 | 0 | 1 | 0 | yes | no | 35s | FN missing_test|weak_test invoice.js:2 |
| ts1 | requirements | 1 | yes | 2 | 0 | 0 | 0 | 0 | yes | no | 30s |  |
| ts2 | test_quality | 1 | yes | 1 | 0 | 1 | 0 | 1 | yes | no | 46s | acceptable weak_test coupon.test.ts:10 |
| ts3 | standards | 1 | yes | 1 | 0 | 0 | 0 | 0 | yes | no | 37s |  |

## Aggregate

| Scope | Runs | Errors | Acceptable | Precision | Recall | JSON valid | Degraded | Pass rate | Latency median | Latency max |
|---|---|---|---|---|---|---|---|---|---|---|
| all | 18 | 0 | 3 | 100% | 86% | 100% | 22% | 83% | 33.5s | 48s |
| requirements | 8 | 0 | 1 | 100% | 92% | 100% | 0% | 88% | 31s | 43s |
| layering | 2 | 0 | 0 | 100% | 100% | 100% | 50% | 100% | 48s | 48s |
| test_quality | 6 | 0 | 2 | 100% | 67% | 100% | 50% | 67% | 33s | 46s |
| standards | 2 | 0 | 0 | 100% | 100% | 100% | 0% | 100% | 32s | 37s |
