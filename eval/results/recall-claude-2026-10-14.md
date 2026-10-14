# Evaluation recall-claude-2026-10-14

Repo Mira190/SpecGuard, target main. Model: unchanged (requested via SPECGUARD_EVAL_MODEL; the Copilot output does not state the model actually used). Cost: not measured (pass --billing). Latency is the dogfood job duration.

| Case | Goal | Rep | Pass | TP | FP | Acceptable | FN | Summary only | JSON valid | Degraded | Latency | Notes |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| js2 | requirements | 1 | yes | 2 | 0 | 0 | 0 | 0 | yes | no | 37s |  |
| l1 | layering | 1 | yes | 1 | 0 | 0 | 0 | 1 | yes | yes | 53s | degraded: 1 validation note(s) |
| p1 | requirements | 1 | yes | 1 | 0 | 0 | 0 | 0 | yes | no | 29s |  |
| r1 | requirements | 1 | no | 3 | 0 | 0 | 1 | 1 | yes | no | 38s | FN weak_test discount.test.js:7 |
| r2 | requirements | 1 | yes | 0 | 0 | 0 | 0 | 0 | yes | no | 28s |  |
| r3 | requirements | 1 | yes | 1 | 0 | 0 | 0 | 0 | yes | no | 33s |  |
| r4 | requirements | 1 | no | 0 | 1 | 0 | 1 | 0 | yes | no | 30s | FN missing_test users.js:6; FP spec_mismatch users.js:6 |
| rx1 | layering | 1 | yes | 0 | 0 | 0 | 0 | 0 | yes | no | 43s |  |
| rx2 | requirements | 1 | yes | 1 | 0 | 0 | 0 | 0 | yes | no | 38s |  |
| rx3 | test_quality | 1 | yes | 1 | 0 | 0 | 0 | 0 | yes | no | 32s |  |
| s1 | standards | 1 | yes | 1 | 0 | 0 | 0 | 0 | yes | no | 31s |  |
| t1 | test_quality | 1 | yes | 1 | 0 | 0 | 0 | 0 | yes | no | 39s |  |
| t2 | test_quality | 1 | yes | 1 | 0 | 0 | 0 | 0 | yes | no | 27s |  |
| t3 | test_quality | 1 | yes | 1 | 0 | 0 | 0 | 0 | yes | yes | 32s | degraded: 1 validation note(s) |
| t4 | test_quality | 1 | yes | 1 | 0 | 0 | 0 | 1 | yes | yes | 31s | degraded: 2 validation note(s) |
| ts1 | requirements | 1 | yes | 2 | 0 | 0 | 0 | 1 | yes | yes | 38s | degraded: 1 validation note(s) |
| ts2 | test_quality | 1 | no | 0 | 0 | 1 | 1 | 1 | yes | no | 38s | FN weak_test coupon.test.ts:6; acceptable weak_test coupon.test.ts:10 |
| ts3 | standards | 1 | yes | 1 | 0 | 0 | 0 | 0 | yes | yes | 32s | degraded: 4 validation note(s) |

## Aggregate

| Scope | Runs | Errors | Acceptable | Precision | Recall | JSON valid | Degraded | Pass rate | Latency median | Latency max |
|---|---|---|---|---|---|---|---|---|---|---|
| all | 18 | 0 | 1 | 95% | 86% | 100% | 28% | 83% | 32.5s | 53s |
| requirements | 8 | 0 | 0 | 91% | 83% | 100% | 13% | 75% | 35s | 38s |
| layering | 2 | 0 | 0 | 100% | 100% | 100% | 50% | 100% | 48s | 53s |
| test_quality | 6 | 0 | 1 | 100% | 83% | 100% | 33% | 83% | 32s | 39s |
| standards | 2 | 0 | 0 | 100% | 100% | 100% | 50% | 100% | 31.5s | 32s |
