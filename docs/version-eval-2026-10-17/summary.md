# SpecGuard version evaluation · 2026-10-17

**结论：有可复现的可靠性提升；完整目标、调用级溯源和团队 shift-left 收益尚未通过验收。**

比较：7c131b5 → b377cff；追加核对 main 5247da3（#305 诊断改进）。本轮没有新付费模型调用。

| 配对指标 | 旧版 | 新版 |
|---|---:|---:|
| 21 个路径分类回归样例 | 16/21 | 21/21 |
| dropped/failed part 的越界已验证 finding | 各 1 | 各 0 |
| collector 仍有后续 part | complete | incomplete |
| 低实际消耗下、同预算准入调用 | 1 | 2 |
| changed test 自己的 hunk 可见 | 0/1 | 1/1 |
| changed identifier 对应测试可见 | 0/1 | 1/1 |

上述是受控模块探针，不是总体模型准确率。真实 #301 pack 重建的新源码/测试行可见率两版相同；不能说所有 PR 都提升。

固定 candidate tree 的真实 Linux CI：1436 tests，1432 pass，0 fail，3 skipped，1 TODO。dogfood review 本身为 incomplete；job success 不等于完整审查。

本次读取的 23 个真实 eval PR 中，5 个没有提交预期变更（#299、#302、#303、#304、#306），不能计作 reviewer pass/miss。18 个有效构造跨三个 product builds，且 grader 存在 inline/coverage 重复计 FP 的反例，不能据此给出最新版本 precision 或提升比例。

未达成项：finding 仍可借另一成功调用的源码通过校验；单调用 cut-source 的 finding 仍可非低置信；未知 single-call usage 仍记零估算成本；selected-scope complete 仍不等于全仓完成；没有真人 QA 收益或有效 matched model A/B 证据。

下一轮：先验证 eval 输入和修复计分身份，再补 call/attempt→实际源码/测试可见范围→需求版本→最终送达的完整来源链，最后做固定条件模型 A/B 与真人试点。

[完整公开报告](report.md)。原始证据、源码快照与复跑脚本保存在本地，未随本公开版提交；本次整理没有重新执行历史评测。
