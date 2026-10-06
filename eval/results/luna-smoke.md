# Evaluation luna-smoke

Repo Mira190/SpecGuard, target feature/verified-review. Model: gpt-6-luna (requested via SPECGUARD_EVAL_MODEL; the Copilot output does not state the model actually used). Cost: not measured: billing API returned no Copilot usage items (AI Credits not itemized or delayed); check the billing page. Latency is the dogfood job duration.

| Case | Goal | Rep | Pass | TP | FP | Acceptable | FN | Summary only | JSON valid | Degraded | Latency | Notes |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| r1 | requirements | 1 | no | 0 | 0 | 0 | 4 | 0 | no | no | 15s | FN missing_test discount.js:5; FN missing_test discount.js:11; FN missing_test discount.js:14; FN weak_test discount.test.js:7; model JSON missing or invalid; incomplete |

## Aggregate

| Scope | Runs | Errors | Acceptable | Precision | Recall | JSON valid | Degraded | Pass rate | Latency median | Latency max |
|---|---|---|---|---|---|---|---|---|---|---|
| all | 1 | 0 | 0 | n/a | 0% | 0% | 0% | 0% | 15s | 15s |
| requirements | 1 | 0 | 0 | n/a | 0% | 0% | 0% | 0% | 15s | 15s |
