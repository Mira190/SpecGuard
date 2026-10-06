# Evaluation stability-a

Repo Mira190/SpecGuard, target feature/verified-review. Model: unchanged (requested via SPECGUARD_EVAL_MODEL; the Copilot output does not state the model actually used). Cost: not measured (pass --billing). Latency is the dogfood job duration.

| Case | Goal | Rep | Pass | TP | FP | Acceptable | FN | Summary only | JSON valid | Degraded | Latency | Notes |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| r3 | requirements | 1 | yes | 1 | 0 | 0 | 0 | 0 | yes | no | 121s |  |
| r3 | requirements | 2 | yes | 1 | 0 | 0 | 0 | 0 | yes | no | 52s |  |
| r3 | requirements | 3 | yes | 1 | 0 | 0 | 0 | 0 | yes | no | 77s |  |
| r4 | requirements | 1 | yes | 1 | 0 | 0 | 0 | 0 | yes | no | 92s |  |
| r4 | requirements | 2 | yes | 1 | 0 | 0 | 0 | 0 | yes | no | 64s |  |
| r4 | requirements | 3 | yes | 1 | 0 | 0 | 0 | 0 | yes | no | 133s |  |
| s2 | robustness | 1 | yes | 1 | 0 | 0 | 0 | 0 | yes | no | 165s |  |
| s2 | robustness | 2 | yes | 1 | 0 | 0 | 0 | 0 | yes | no | 128s |  |
| s2 | robustness | 3 | yes | 1 | 0 | 0 | 0 | 0 | yes | no | 135s |  |
| t1 | test_quality | 1 | yes | 1 | 0 | 1 | 0 | 0 | yes | no | 128s | acceptable weak_test tax.test.js:10 |
| t1 | test_quality | 2 | yes | 1 | 0 | 0 | 0 | 0 | yes | no | 98s |  |
| t1 | test_quality | 3 | yes | 1 | 0 | 1 | 0 | 0 | yes | no | 143s | acceptable weak_test tax.test.js:10 |

## Aggregate

| Scope | Runs | Errors | Acceptable | Precision | Recall | JSON valid | Degraded | Pass rate | Latency median | Latency max |
|---|---|---|---|---|---|---|---|---|---|---|
| all | 12 | 0 | 2 | 100% | 100% | 100% | 0% | 100% | 124.5s | 165s |
| requirements | 6 | 0 | 0 | 100% | 100% | 100% | 0% | 100% | 84.5s | 133s |
| robustness | 3 | 0 | 0 | 100% | 100% | 100% | 0% | 100% | 135s | 165s |
| test_quality | 3 | 0 | 2 | 100% | 100% | 100% | 0% | 100% | 128s | 143s |
