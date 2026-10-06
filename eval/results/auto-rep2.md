# Evaluation auto-rep2

Repo Mira190/SpecGuard, target feature/verified-review. Model: unchanged (requested via SPECGUARD_EVAL_MODEL; the Copilot output does not state the model actually used). Cost: not measured (pass --billing). Latency is the dogfood job duration.

| Case | Goal | Rep | Pass | TP | FP | Acceptable | FN | Summary only | JSON valid | Degraded | Latency | Notes |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| l1 | layering | 1 | yes | 1 | 4 | 0 | 0 | 0 | yes | no | 342s | FP missing_test pricing.py:1; FP missing_test pricing.py:5; FP missing_test pricing.py:7; FP missing_test pricing.py:10 |
| p1 | requirements | 1 | no | 0 | 0 | 0 | 1 | 0 | yes | no | 122s | FN missing_test cart.py:5; incomplete |
| r1 | requirements | 1 | no | 0 | 0 | 0 | 4 | 0 | yes | no | 210s | FN missing_test discount.js:5; FN missing_test discount.js:11; FN missing_test discount.js:14; FN weak_test discount.test.js:7; incomplete |
| r2 | requirements | 1 | yes | 0 | 0 | 0 | 0 | 0 | yes | no | 95s |  |
| r3 | requirements | 1 | no | 0 | 0 | 1 | 1 | 0 | yes | no | 126s | FN missing_test name.js:5; acceptable weak_test name.test.js:6 |
| r4 | requirements | 1 | yes | 1 | 0 | 0 | 0 | 0 | yes | no | 78s |  |
| s1 | standards | 1 | yes | 1 | 0 | 1 | 0 | 0 | yes | no | 117s | acceptable missing_test config.js:2 |
| s2 | robustness | 1 | no | 1 | 0 | 1 | 0 | 0 | yes | no | 131s | acceptable missing_test config.js:2; text /Error objects/ |
| t1 | test_quality | 1 | no | 0 | 1 | 1 | 1 | 0 | yes | no | 94s | FN weak_test tax.test.js:6; acceptable weak_test tax.test.js:10; FP weak_test tax.test.js:14 |
| t2 | test_quality | 1 | yes | 1 | 0 | 0 | 0 | 0 | yes | yes | 62s | degraded: 1 validation note(s) |
| t3 | test_quality | 1 | yes | 1 | 0 | 0 | 0 | 0 | yes | no | 90s |  |
| t4 | test_quality | 1 | yes | 1 | 0 | 0 | 0 | 1 | yes | no | 74s |  |
| x1 | robustness | 1 | yes | 0 | 0 | 0 | 0 | 0 | yes | no | 7s |  |
| x2 | robustness | 1 | no | 3 | 0 | 0 | 1 | 0 | yes | no | 97s | FN missing_test discount.js:14 |

## Aggregate

| Scope | Runs | Errors | Acceptable | Precision | Recall | JSON valid | Degraded | Pass rate | Latency median | Latency max |
|---|---|---|---|---|---|---|---|---|---|---|
| all | 14 | 0 | 4 | 67% | 56% | 100% | 7% | 57% | 96s | 342s |
| layering | 1 | 0 | 0 | 20% | 100% | 100% | 0% | 100% | 342s | 342s |
| requirements | 5 | 0 | 1 | 100% | 14% | 100% | 0% | 40% | 122s | 210s |
| standards | 1 | 0 | 1 | 100% | 100% | 100% | 0% | 100% | 117s | 117s |
| robustness | 3 | 0 | 1 | 100% | 80% | 100% | 0% | 33% | 97s | 131s |
| test_quality | 4 | 0 | 1 | 75% | 75% | 100% | 25% | 75% | 82s | 94s |
