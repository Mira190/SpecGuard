# Evaluation lang-b2

Repo Mira190/SpecGuard, target feature/verified-review. Model: unchanged (requested via SPECGUARD_EVAL_MODEL; the Copilot output does not state the model actually used). Cost: not measured (pass --billing). Latency is the dogfood job duration.

| Case | Goal | Rep | Pass | TP | FP | Acceptable | FN | Summary only | JSON valid | Degraded | Latency | Notes |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| rx3 | test_quality | 1 | yes | 1 | 0 | 0 | 0 | 0 | yes | no | 88s |  |
| ts2 | test_quality | 1 | yes | 1 | 0 | 3 | 0 | 0 | yes | no | 106s | acceptable missing_test coupon.ts:1; acceptable missing_test coupon.ts:4; acceptable missing_test coupon.ts:5 |
| js2 | requirements | 1 | no | 1 | 1 | 1 | 1 | 0 | yes | no | 117s | FN missing_test fetchWithRetry.js:10; acceptable missing_test fetchWithRetry.js:1; FP missing_test fetchWithRetry.js:7 |

## Aggregate

| Scope | Runs | Errors | Acceptable | Precision | Recall | JSON valid | Degraded | Pass rate | Latency median | Latency max |
|---|---|---|---|---|---|---|---|---|---|---|
| all | 3 | 0 | 4 | 75% | 75% | 100% | 0% | 67% | 106s | 117s |
| test_quality | 2 | 0 | 3 | 100% | 100% | 100% | 0% | 100% | 97s | 106s |
| requirements | 1 | 0 | 1 | 50% | 50% | 100% | 0% | 0% | 117s | 117s |
