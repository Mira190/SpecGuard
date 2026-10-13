# Evaluation smoke2

Repo Mira190/SpecGuard, target feature/verified-review. Cost: not measured (check the Copilot billing page for the run window). Latency is the dogfood job duration.

| Case | Goal | Rep | Pass | TP | FP | FN | Summary only | JSON valid | Latency | Notes |
|---|---|---|---|---|---|---|---|---|---|---|
| r1 | requirements | 1 | no | 0 | 0 | 4 | 0 | no | 176s | FN missing_test discount.js:5; FN missing_test discount.js:11; FN missing_test discount.js:14; FN weak_test discount.spec.js:7; invalid or incomplete |

## Aggregate

| Scope | Runs | Errors | Precision | Recall | JSON valid | Pass rate | Latency median | Latency max |
|---|---|---|---|---|---|---|---|---|
| all | 1 | 0 | n/a | 0% | 0% | 0% | 176s | 176s |
| requirements | 1 | 0 | n/a | 0% | 0% | 0% | 176s | 176s |
