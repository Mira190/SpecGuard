# Evaluation combined-auto

Mode: combined: 12 cases in one PR, budget 30 (l1, p1, r1, r2, r3, r4, s1, s2, t1, t2, t3, t4). Results measure big-PR behaviour, not per-scenario accuracy; findings outside every sandbox count as FP of the combined run.

Repo Mira190/SpecGuard, target feature/verified-review. Model: unchanged (requested via SPECGUARD_EVAL_MODEL; the Copilot output does not state the model actually used). Cost: not measured (pass --billing). Latency is the dogfood job duration.

| Case | Goal | Rep | Pass | TP | FP | Acceptable | FN | Summary only | JSON valid | Degraded | Latency | Notes |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| l1 | layering | 1 | no | 0 | 0 | 0 | 1 | 0 | yes | no | 439s | FN pushdown pricing.py:6 |
| p1 | requirements | 1 | yes | 1 | 0 | 0 | 0 | 0 | yes | no | 439s |  |
| r1 | requirements | 1 | no | 3 | 0 | 0 | 1 | 0 | yes | no | 439s | FN missing_test discount.js:14 |
| r2 | requirements | 1 | yes | 0 | 0 | 0 | 0 | 0 | yes | no | 439s |  |
| r3 | requirements | 1 | yes | 1 | 0 | 0 | 0 | 0 | yes | no | 439s |  |
| r4 | requirements | 1 | no | 0 | 0 | 0 | 1 | 0 | yes | no | 439s | FN missing_test users.js:6 |
| s1 | standards | 1 | yes | 1 | 0 | 0 | 0 | 0 | yes | no | 439s |  |
| s2 | robustness | 1 | no | 0 | 0 | 0 | 1 | 0 | yes | no | 439s | FN standard config.js:3 |
| t1 | test_quality | 1 | no | 0 | 0 | 0 | 1 | 0 | yes | no | 439s | FN weak_test tax.test.js:6 |
| t2 | test_quality | 1 | yes | 1 | 0 | 0 | 0 | 0 | yes | no | 439s |  |
| t3 | test_quality | 1 | no | 0 | 0 | 0 | 1 | 0 | yes | no | 439s | FN weak_test|missing_test qty.test.js:9 |
| t4 | test_quality | 1 | yes | 1 | 0 | 0 | 0 | 1 | yes | no | 439s |  |
| l1 | layering | 2 | no | 0 | 0 | 0 | 1 | 0 | yes | yes | 409s | FN pushdown pricing.py:6; degraded: 1 validation note(s) |
| p1 | requirements | 2 | yes | 1 | 0 | 0 | 0 | 0 | yes | yes | 409s | degraded: 1 validation note(s) |
| r1 | requirements | 2 | no | 3 | 0 | 0 | 1 | 0 | yes | yes | 409s | FN missing_test discount.js:5; degraded: 1 validation note(s) |
| r2 | requirements | 2 | yes | 0 | 0 | 0 | 0 | 0 | yes | yes | 409s | degraded: 1 validation note(s) |
| r3 | requirements | 2 | yes | 1 | 0 | 0 | 0 | 0 | yes | yes | 409s | degraded: 1 validation note(s) |
| r4 | requirements | 2 | yes | 1 | 0 | 0 | 0 | 0 | yes | yes | 409s | degraded: 1 validation note(s) |
| s1 | standards | 2 | no | 0 | 0 | 0 | 1 | 0 | yes | yes | 409s | FN standard config.js:3; degraded: 1 validation note(s) |
| s2 | robustness | 2 | no | 1 | 0 | 0 | 0 | 0 | yes | yes | 409s | text /Error objects/; degraded: 1 validation note(s) |
| t1 | test_quality | 2 | no | 0 | 1 | 0 | 1 | 0 | yes | yes | 409s | FN weak_test tax.test.js:6; FP weak_test tax.test.js:10; degraded: 1 validation note(s) |
| t2 | test_quality | 2 | yes | 1 | 0 | 0 | 0 | 0 | yes | yes | 409s | degraded: 1 validation note(s) |
| t3 | test_quality | 2 | yes | 1 | 0 | 0 | 0 | 0 | yes | yes | 409s | degraded: 1 validation note(s) |
| t4 | test_quality | 2 | yes | 1 | 0 | 0 | 0 | 1 | yes | yes | 409s | degraded: 1 validation note(s) |
| l1 | layering | 3 | no | 0 | 0 | 0 | 1 | 0 | yes | yes | 343s | FN pushdown pricing.py:6; degraded: 3 validation note(s) |
| p1 | requirements | 3 | yes | 1 | 0 | 0 | 0 | 0 | yes | yes | 343s | degraded: 3 validation note(s) |
| r1 | requirements | 3 | yes | 4 | 0 | 0 | 0 | 0 | yes | yes | 343s | degraded: 3 validation note(s) |
| r2 | requirements | 3 | yes | 0 | 0 | 0 | 0 | 0 | yes | yes | 343s | degraded: 3 validation note(s) |
| r3 | requirements | 3 | yes | 1 | 0 | 0 | 0 | 0 | yes | yes | 343s | degraded: 3 validation note(s) |
| r4 | requirements | 3 | yes | 1 | 0 | 0 | 0 | 0 | yes | yes | 343s | degraded: 3 validation note(s) |
| s1 | standards | 3 | yes | 1 | 0 | 0 | 0 | 0 | yes | yes | 343s | degraded: 3 validation note(s) |
| s2 | robustness | 3 | no | 0 | 0 | 0 | 1 | 0 | yes | yes | 343s | FN standard config.js:3; degraded: 3 validation note(s) |
| t1 | test_quality | 3 | yes | 1 | 1 | 0 | 0 | 0 | yes | yes | 343s | FP weak_test tax.test.js:10; degraded: 3 validation note(s) |
| t2 | test_quality | 3 | no | 0 | 0 | 0 | 1 | 0 | yes | yes | 343s | FN weak_test limits.test.js:6; degraded: 3 validation note(s) |
| t3 | test_quality | 3 | no | 0 | 0 | 0 | 1 | 0 | yes | yes | 343s | FN weak_test|missing_test qty.test.js:9; degraded: 3 validation note(s) |
| t4 | test_quality | 3 | yes | 1 | 0 | 0 | 0 | 2 | yes | yes | 343s | degraded: 3 validation note(s) |

## Aggregate

| Scope | Runs | Errors | Acceptable | Precision | Recall | JSON valid | Degraded | Pass rate | Latency median | Latency max |
|---|---|---|---|---|---|---|---|---|---|---|
| all | 36 | 0 | 0 | 93% | 67% | 100% | 67% | 58% | 409s | 439s |
| layering | 3 | 0 | 0 | n/a | 0% | 100% | 67% | 0% | 409s | 439s |
| requirements | 15 | 0 | 0 | 100% | 86% | 100% | 67% | 80% | 409s | 439s |
| standards | 3 | 0 | 0 | 100% | 67% | 100% | 67% | 67% | 409s | 439s |
| robustness | 3 | 0 | 0 | 100% | 33% | 100% | 67% | 0% | 409s | 439s |
| test_quality | 12 | 0 | 0 | 78% | 58% | 100% | 67% | 58% | 409s | 439s |

## Combined PR

| Rep | Pass | TP | FP | FN | Outside sandbox (FP) | Posted / budget | Summary overflow | Latency | PR |
|---|---|---|---|---|---|---|---|---|---|
| 1 | no | 8 | 0 | 6 | 0 | 7 / 30 | 0 | 439s | https://github.com/Mira190/SpecGuard/pull/42 |
| 2 | no | 10 | 1 | 4 | 0 | 10 / 30 | 0 | 409s | https://github.com/Mira190/SpecGuard/pull/43 |
| 3 | no | 10 | 1 | 4 | 0 | 10 / 30 | 0 | 343s | https://github.com/Mira190/SpecGuard/pull/44 |
