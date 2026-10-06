# Evaluation lang-b

Repo Mira190/SpecGuard, target feature/verified-review. Model: unchanged (requested via SPECGUARD_EVAL_MODEL; the Copilot output does not state the model actually used). Cost: not measured (pass --billing). Latency is the dogfood job duration.

| Case | Goal | Rep | Pass | TP | FP | Acceptable | FN | Summary only | JSON valid | Degraded | Latency | Notes |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| ts1 | requirements | 1 | yes | 2 | 1 | 0 | 0 | 0 | yes | no | 122s | FP missing_test duration.ts:5 |
| ts1 | requirements | 2 | yes | 2 | 0 | 0 | 0 | 0 | yes | no | 111s |  |
| ts2 | test_quality | 1 | error | | | | | | | | | error: Command failed: gh run list --repo Mira190/SpecGuard --branch eval/lang-b-ts2-1-head --event pull_request --limit 20 --json databaseId,headSha,status,conclusion,workflowName,url |
| ts2 | test_quality | 2 | yes | 1 | 1 | 2 | 0 | 0 | yes | no | 144s | acceptable missing_test coupon.ts:4; acceptable weak_test coupon.test.ts:10; FP missing_test coupon.ts:1 |
| ts3 | standards | 1 | yes | 1 | 0 | 0 | 0 | 0 | yes | no | 122s |  |
| ts3 | standards | 2 | yes | 1 | 0 | 0 | 0 | 0 | yes | no | 104s |  |
| rx1 | layering | 1 | yes | 1 | 1 | 0 | 0 | 0 | yes | no | 160s | FP missing_test PriceTag.tsx:12 |
| rx1 | layering | 2 | yes | 1 | 1 | 0 | 0 | 0 | yes | no | 234s | FP missing_test PriceTag.tsx:12 |
| rx2 | requirements | 1 | yes | 1 | 0 | 0 | 0 | 0 | yes | no | 140s |  |
| rx2 | requirements | 2 | yes | 1 | 0 | 0 | 0 | 0 | yes | no | 128s |  |
| rx3 | test_quality | 1 | error | | | | | | | | | error: Command failed: gh run view 37474278084 --repo Mira190/SpecGuard --json jobs |
| rx3 | test_quality | 2 | no | 0 | 1 | 0 | 1 | 0 | yes | no | 100s | FN weak_test CartSummary.test.tsx:10; FP weak_test CartSummary.tsx:5 |
| js2 | requirements | 1 | no | 1 | 2 | 0 | 1 | 0 | yes | no | 97s | FN missing_test fetchWithRetry.js:7; FP missing_test fetchWithRetry.js:3; FP missing_test fetchWithRetry.js:1 |
| js2 | requirements | 2 | no | 1 | 2 | 0 | 1 | 0 | yes | no | 96s | FN missing_test fetchWithRetry.js:7; FP missing_test fetchWithRetry.js:3; FP missing_test fetchWithRetry.js:1 |

## Aggregate

| Scope | Runs | Errors | Acceptable | Precision | Recall | JSON valid | Degraded | Pass rate | Latency median | Latency max |
|---|---|---|---|---|---|---|---|---|---|---|
| all | 14 | 2 | 2 | 59% | 81% | 100% | 0% | 75% | 122s | 234s |
| requirements | 6 | 0 | 0 | 62% | 80% | 100% | 0% | 67% | 116.5s | 140s |
| test_quality | 4 | 2 | 2 | 33% | 50% | 100% | 0% | 50% | 122s | 144s |
| standards | 2 | 0 | 0 | 100% | 100% | 100% | 0% | 100% | 113s | 122s |
| layering | 2 | 0 | 0 | 50% | 100% | 100% | 0% | 100% | 197s | 234s |
