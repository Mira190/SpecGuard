# Evaluation auto-rep3

Repo Mira190/SpecGuard, target feature/verified-review. Model: unchanged (requested via SPECGUARD_EVAL_MODEL; the Copilot output does not state the model actually used). Cost: not measured (pass --billing). Latency is the dogfood job duration.

| Case | Goal | Rep | Pass | TP | FP | Acceptable | FN | Summary only | JSON valid | Degraded | Latency | Notes |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| l1 | layering | 1 | yes | 1 | 5 | 0 | 0 | 0 | yes | no | 185s | FP missing_test pricing.py:5; FP missing_test pricing.py:1; FP missing_test pricing.py:6; FP missing_test pricing.py:7; FP missing_test pricing.py:10 |
| p1 | requirements | 1 | yes | 1 | 0 | 0 | 0 | 0 | yes | yes | 55s | degraded: 1 validation note(s) |
| r1 | requirements | 1 | yes | 4 | 0 | 0 | 0 | 1 | yes | no | 138s |  |
| r2 | requirements | 1 | yes | 0 | 0 | 0 | 0 | 0 | yes | no | 47s |  |
| r3 | requirements | 1 | no | 1 | 1 | 0 | 0 | 0 | yes | no | 66s | FP missing_test name.js:2; must_not {"kind":"missing_test","path":"eval-sandbox/r3/name.js","line":3,"tolerance":1} |
| r4 | requirements | 1 | no | 0 | 0 | 0 | 1 | 0 | yes | no | 47s | FN missing_test users.js:6 |
| s1 | standards | 1 | yes | 1 | 0 | 1 | 0 | 0 | yes | no | 89s | acceptable missing_test config.js:2 |
| s2 | robustness | 1 | no | 0 | 1 | 0 | 1 | 0 | yes | no | 101s | FN standard config.js:3; FP weak_test config.test.js:6 |
| t1 | test_quality | 1 | no | 0 | 0 | 1 | 1 | 0 | yes | no | 85s | FN weak_test tax.test.js:6; acceptable missing_test tax.js:4 |
| t2 | test_quality | 1 | yes | 1 | 0 | 0 | 0 | 0 | yes | no | 66s |  |
| t3 | test_quality | 1 | yes | 1 | 0 | 0 | 0 | 0 | yes | yes | 86s | degraded: 1 validation note(s) |
| t4 | test_quality | 1 | yes | 1 | 0 | 0 | 0 | 2 | yes | no | 113s |  |
| x1 | robustness | 1 | yes | 0 | 0 | 0 | 0 | 0 | yes | no | 11s |  |
| x2 | robustness | 1 | yes | 4 | 0 | 1 | 0 | 0 | yes | no | 118s | acceptable missing_test discount.js:8 |

## Aggregate

| Scope | Runs | Errors | Acceptable | Precision | Recall | JSON valid | Degraded | Pass rate | Latency median | Latency max |
|---|---|---|---|---|---|---|---|---|---|---|
| all | 14 | 0 | 3 | 68% | 83% | 100% | 14% | 71% | 85.5s | 185s |
| layering | 1 | 0 | 0 | 17% | 100% | 100% | 0% | 100% | 185s | 185s |
| requirements | 5 | 0 | 0 | 86% | 86% | 100% | 20% | 60% | 55s | 138s |
| standards | 1 | 0 | 1 | 100% | 100% | 100% | 0% | 100% | 89s | 89s |
| robustness | 3 | 0 | 1 | 80% | 80% | 100% | 0% | 67% | 101s | 118s |
| test_quality | 4 | 0 | 1 | 100% | 75% | 100% | 25% | 75% | 85.5s | 113s |
