# Evaluation smoke3

Repo Mira190/SpecGuard, target feature/verified-review. Cost: not measured (check the Copilot billing page for the run window). Latency is the dogfood job duration.

| Case | Goal | Rep | Pass | TP | FP | FN | Summary only | JSON valid | Degraded | Latency | Notes |
|---|---|---|---|---|---|---|---|---|---|---|---|
| r1 | requirements | 1 | no | 0 | 1 | 4 | 0 | yes | no | 223s | FN missing_test discount.js:5; FN missing_test discount.js:11; FN missing_test discount.js:14; FN weak_test discount.spec.js:7; FP missing_test discount.js:8 |

## Aggregate

| Scope | Runs | Errors | Precision | Recall | JSON valid | Degraded | Pass rate | Latency median | Latency max |
|---|---|---|---|---|---|---|---|---|---|
| all | 1 | 0 | 0% | 0% | 100% | 0% | 0% | 223s | 223s |
| requirements | 1 | 0 | 0% | 0% | 100% | 0% | 0% | 223s | 223s |
