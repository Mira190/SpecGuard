# Evaluation full1

Repo Mira190/SpecGuard, target feature/verified-review. Cost: not measured (check the Copilot billing page for the run window). Latency is the dogfood job duration.

| Case | Goal | Rep | Pass | TP | FP | FN | Summary only | JSON valid | Degraded | Latency | Notes |
|---|---|---|---|---|---|---|---|---|---|---|---|
| l1 | layering | 1 | no | 0 | 4 | 1 | 0 | yes | yes | 262s | FN pushdown pricing.py:6; FP missing_test pricing.py:1; FP missing_test pricing.py:5; FP missing_test pricing.py:10; FP standard pricing.py:4; degraded: 6 validation note(s) |
| p1 | requirements | 1 | yes | 1 | 0 | 0 | 0 | yes | no | 98s |  |
| r1 | requirements | 1 | yes | 4 | 0 | 0 | 0 | yes | no | 162s |  |
| r2 | requirements | 1 | yes | 0 | 0 | 0 | 0 | yes | no | 188s |  |
| r3 | requirements | 1 | no | 0 | 1 | 1 | 0 | yes | yes | 123s | FN missing_test name.js:5; FP standard name.spec.js:1; degraded: 4 validation note(s) |
| r4 | requirements | 1 | yes | 1 | 0 | 0 | 0 | yes | no | 93s |  |
| s1 | standards | 1 | yes | 1 | 2 | 0 | 0 | yes | no | 131s | FP missing_test config.js:2; FP standard config.spec.js:1 |
| s2 | robustness | 1 | yes | 1 | 0 | 0 | 0 | yes | no | 159s |  |
| t1 | test_quality | 1 | no | 0 | 0 | 1 | 0 | no | no | 252s | FN weak_test tax.spec.js:6; model JSON missing or invalid; incomplete |
| t2 | test_quality | 1 | yes | 1 | 0 | 0 | 0 | yes | no | 83s |  |
| t3 | test_quality | 1 | no | 0 | 0 | 1 | 0 | yes | yes | 138s | FN weak_test|missing_test qty.spec.js:9; degraded: 2 validation note(s) |
| t4 | test_quality | 1 | yes | 1 | 0 | 0 | 2 | yes | no | 105s |  |
| x1 | robustness | 1 | yes | 0 | 0 | 0 | 0 | yes | no | 7s |  |
| x2 | robustness | 1 | yes | 4 | 2 | 0 | 0 | yes | no | 128s | FP missing_test discount.js:1; FP missing_test discount.js:8 |

## Aggregate

| Scope | Runs | Errors | Precision | Recall | JSON valid | Degraded | Pass rate | Latency median | Latency max |
|---|---|---|---|---|---|---|---|---|---|
| all | 14 | 0 | 61% | 78% | 93% | 21% | 71% | 129.5s | 262s |
| layering | 1 | 0 | 0% | 0% | 100% | 100% | 0% | 262s | 262s |
| requirements | 5 | 0 | 86% | 86% | 100% | 20% | 80% | 123s | 188s |
| standards | 1 | 0 | 33% | 100% | 100% | 0% | 100% | 131s | 131s |
| robustness | 3 | 0 | 71% | 100% | 100% | 0% | 100% | 128s | 159s |
| test_quality | 4 | 0 | 100% | 50% | 75% | 25% | 50% | 121.5s | 252s |
