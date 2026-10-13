# Evaluation auto-targeted

Repo Mira190/SpecGuard, target feature/verified-review. Model: unchanged (requested via SPECGUARD_EVAL_MODEL; the Copilot output does not state the model actually used). Cost: not measured (pass --billing). Latency is the dogfood job duration.

| Case | Goal | Rep | Pass | TP | FP | Acceptable | FN | Summary only | JSON valid | Degraded | Latency | Notes |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| r1 | requirements | 1 | yes | 4 | 1 | 2 | 0 | 0 | yes | no | 126s | acceptable missing_test discount.js:1; acceptable missing_test discount.js:8; FP missing_test discount.js:14 |
| p1 | requirements | 1 | no | 0 | 0 | 0 | 1 | 1 | yes | no | 136s | FN missing_test cart.py:5 |
| t1 | test_quality | 1 | yes | 1 | 0 | 2 | 0 | 0 | yes | no | 93s | acceptable missing_test tax.js:4; acceptable weak_test tax.test.js:10 |
| l1 | layering | 1 | no | 0 | 5 | 0 | 1 | 0 | yes | no | 201s | FN pushdown pricing.py:6; FP missing_test app.py:8; FP missing_test pricing.py:6; FP missing_test pricing.py:5; FP missing_test pricing.py:7; FP missing_test pricing.py:8 |

## Aggregate

| Scope | Runs | Errors | Acceptable | Precision | Recall | JSON valid | Degraded | Pass rate | Latency median | Latency max |
|---|---|---|---|---|---|---|---|---|---|---|
| all | 4 | 0 | 4 | 46% | 71% | 100% | 0% | 50% | 131s | 201s |
| requirements | 2 | 0 | 2 | 80% | 80% | 100% | 0% | 50% | 131s | 136s |
| test_quality | 1 | 0 | 2 | 100% | 100% | 100% | 0% | 100% | 93s | 93s |
| layering | 1 | 0 | 0 | 0% | 0% | 100% | 0% | 0% | 201s | 201s |
