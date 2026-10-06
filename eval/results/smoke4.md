# Evaluation smoke4

Repo Mira190/SpecGuard, target feature/verified-review. Cost: not measured (check the Copilot billing page for the run window). Latency is the dogfood job duration.

| Case | Goal | Rep | Pass | TP | FP | FN | Summary only | JSON valid | Degraded | Latency | Notes |
|---|---|---|---|---|---|---|---|---|---|---|---|
| r1 | requirements | 1 | yes | 4 | 2 | 0 | 0 | yes | no | 162s | FP missing_test discount.js:8; FP standard discount.spec.js:5 |

## Aggregate

| Scope | Runs | Errors | Precision | Recall | JSON valid | Degraded | Pass rate | Latency median | Latency max |
|---|---|---|---|---|---|---|---|---|---|
| all | 1 | 0 | 67% | 100% | 100% | 0% | 100% | 162s | 162s |
| requirements | 1 | 0 | 67% | 100% | 100% | 0% | 100% | 162s | 162s |
