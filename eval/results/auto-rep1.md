# Evaluation auto-rep1

Repo Mira190/SpecGuard, target feature/verified-review. Model: unchanged (requested via SPECGUARD_EVAL_MODEL; the Copilot output does not state the model actually used). Cost: not measured (pass --billing). Latency is the dogfood job duration.

| Case | Goal | Rep | Pass | TP | FP | Acceptable | FN | Summary only | JSON valid | Degraded | Latency | Notes |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| l1 | layering | 1 | no | 0 | 0 | 0 | 1 | 0 | no | no | 738s | FN pushdown pricing.py:6; model JSON missing or invalid; incomplete |
| p1 | requirements | 1 | yes | 1 | 2 | 0 | 0 | 0 | yes | no | 122s | FP missing_test cart.py:2; FP missing_test cart.py:6 |
| r1 | requirements | 1 | yes | 4 | 0 | 0 | 0 | 0 | yes | no | 185s |  |
| r2 | requirements | 1 | yes | 0 | 0 | 0 | 0 | 0 | yes | no | 88s |  |
| r3 | requirements | 1 | yes | 1 | 1 | 0 | 0 | 0 | yes | no | 106s | FP weak_test name.test.js:6 |
| r4 | requirements | 1 | yes | 1 | 0 | 0 | 0 | 0 | yes | no | 97s |  |
| s1 | standards | 1 | yes | 1 | 0 | 0 | 0 | 0 | yes | no | 80s |  |
| s2 | robustness | 1 | yes | 1 | 1 | 0 | 0 | 0 | yes | no | 122s | FP missing_test config.js:2 |
| t1 | test_quality | 1 | no | 0 | 1 | 0 | 1 | 0 | yes | no | 104s | FN weak_test tax.test.js:6; FP missing_test tax.js:4 |
| t2 | test_quality | 1 | yes | 1 | 0 | 0 | 0 | 0 | yes | no | 59s |  |
| t3 | test_quality | 1 | yes | 1 | 0 | 0 | 0 | 0 | yes | no | 147s |  |
| t4 | test_quality | 1 | yes | 1 | 0 | 0 | 0 | 2 | yes | no | 101s |  |
| x1 | robustness | 1 | yes | 0 | 0 | 0 | 0 | 0 | yes | no | 7s |  |
| x2 | robustness | 1 | yes | 4 | 0 | 0 | 0 | 0 | yes | no | 128s |  |

## Aggregate

| Scope | Runs | Errors | Acceptable | Precision | Recall | JSON valid | Degraded | Pass rate | Latency median | Latency max |
|---|---|---|---|---|---|---|---|---|---|---|
| all | 14 | 0 | 0 | 76% | 89% | 93% | 0% | 86% | 105s | 738s |
| layering | 1 | 0 | 0 | n/a | 0% | 0% | 0% | 0% | 738s | 738s |
| requirements | 5 | 0 | 0 | 70% | 100% | 100% | 0% | 100% | 106s | 185s |
| standards | 1 | 0 | 0 | 100% | 100% | 100% | 0% | 100% | 80s | 80s |
| robustness | 3 | 0 | 0 | 83% | 100% | 100% | 0% | 100% | 122s | 128s |
| test_quality | 4 | 0 | 0 | 75% | 75% | 100% | 0% | 75% | 102.5s | 147s |
