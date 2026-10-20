# SpecGuard assurance case（主张—论证—证据）

日期：2026-10-19。基线：`origin/main` = `4176c33`。

用途：取代"再写一份评审"的习惯。每个主张只有证据能改状态；评审文档不算证据（见 §3 规则）。
数字只取自 main 上的文件；来自改进方案的数字标注"方案"（[specguard-improvement-plan-2026-10-19.md](specguard-improvement-plan-2026-10-19.md)，下称"方案"）。

证据阶梯：**机制 < 种子 < 离线历史 < shadow < 随机对照 < 纵向 QA 结果**。现在最高只到"离线历史"。

## 1. 主张树

**G0（顶层）**：在同一类 PR 上，打开 SpecGuard 比不打开好：逃到 QA/生产的缺陷更少、修得更早，且收益大于人的注意力成本和费用。状态：**unsupported**。

```
G0 ── G1 检出 ── G2 送达 ── G3 采纳 ── G4 新测试能抓住缺陷 ── G5 反事实 ── G6 收益>成本
 └── 侧主张：G7 仓库自身工程质量；G8 数据处理与隐私
```

## 2. 节点表

| 节点 | 论证（一行） | 证据 | 阶梯 | 状态 | 未关闭的反驳点（defeaters） |
|---|---|---|---|---|---|
| G1 检出 | 回放历史 bug 引入 PR，SpecGuard 能指出该缺陷 | [eval/replay/README.md](../eval/replay/README.md)（SZZ 流程与 rubric）；[eval/mutation/README.md](../eval/mutation/README.md)（mutation 试点方法）；数字：回放命中 20.7%（9.33/45，`eval/replay/README.md` 第 129 行），mutation 行级命中 0/10（`eval/mutation/README.md` 第 44 行）；2026-10-20 测试缺口集（[testgap-evidence-2026-10-20.md](../eval/replay/testgap-evidence-2026-10-20.md)）：送达的 missing_test 落在 bug 定义内 2/72，与随机持平（2.7%，p=0.65）；计入隐藏 finding 也只有 +9 分，低于预注册的 +10 门槛；盲评中送达且 direct 的命中为 5/129，其中 missing_test 只有 1/129 | 离线历史 | partial | D1.1 行级定位 0/10，单元级命中约等于基数（方案 §1.2 第 6 条）；D1.2 未与最笨基线对比（diff-cover、"改函数没改测试"、裸 prompt），通用模板对照尚未跑；D1.3 回放集来自公开仓库，可能被训练数据污染；D1.4 内容评分来自 LLM 评审，没有人工标注；D1.5 假设（n=5，不作主张）：送达的 direct 命中 5 个里有 4 个是 spec_mismatch |
| G2 送达 | 检出的 finding 以 inline 评论送达作者并点名该缺陷 | [docs/validation-plan.md](validation-plan.md)（Step 3/5 指标定义）；数字：30 个检出事件仅 5 个送达（`eval/replay/README.md` 第 172 行），288 次回放（第 208 行）中 213 次 incomplete（来源：未入库的第三方评审，未在 main 上复核） ；2026-10-20：盲评 direct 命中 7 个被隐藏、只有 5 个送达；被降级的 missing_test 有 39/49 是因为候选测试只部分可见（切片失败），见 [testgap-evidence-2026-10-20.md](../eval/replay/testgap-evidence-2026-10-20.md) | 离线历史 | partial | D2.1 incomplete 成为常态；D2.2 无送达率的预注册门槛；D2.3 haiku 一律走 reduced review（`src/engine-model.js:14`），但关掉它释放 0 条被降级的 finding；#413 使有覆盖率证据的 missing_test finding 可送达（不再被三道降级门槛降级），状态不变，无实测效果 |
| G3 采纳 | 作者看到后按建议补测试或修代码 | [docs/validation-plan.md](validation-plan.md)（Step 6：fix-through ≥25%、下界 >15%）；作者 verdict 已实现，但全部 PR 只有 1 条，且来自 owner（方案 §0） | 种子 | unsupported | D3.1 无非 owner 真人数据（≥30 条 verdict 未达）；D3.2 fix-through 只是"触碰"代理；D3.3 作者判定本身有噪音 |
| G4 新测试抓住缺陷 | 按建议写的测试在缺陷版本失败、修复版本通过 | [eval/f2p/README.md](../eval/f2p/README.md)（预注册 fail-to-pass oracle，#410）；数字：修复改动 ±20 行内的 finding（NEAR）0/9，同文件较远的对照（FAR）1/23，hono 内部 0/9 对 0/17（均为 verified 且失败原因与 finding 一致）；hono mutation 14 个有效测试杀死 0 个存活 mutant（仅 3 个面对严格存活 mutant）；唯一 NEAR verified 的失败原因与 finding 不符 | 离线历史 | unsupported（描述性结果无正向信号：NEAR+FAR 合计 1/32 verified 且原因一致） | D4.1 已关闭（oracle 已建、阳性对照 hono 6/6、sqlglot 1/1、langchain 1/1）；D4.2 `weak_test` 无 pseudo-tested 判定；D4.3 样本小，只做描述（聚类 MDD 86 pp），仅 3 个 repo，rqlite 未跑；D4.4 48 个测试中 42 个在无试跑反馈下写成（写测试反馈与分组混杂）；D4.5 单一模型写测试、公开 repo 可能污染 |
| G5 反事实 | 没有 SpecGuard，该缺陷会逃到 QA/生产 | 无 | 无 | unsupported | **D5.1 shadow 臂从未执行**：首次提出 2026-10-14（[audit](SpecGuard_critical_shift_left_audit_2026-10-14.md) 第 226、377 行），仍未进入 validation-plan；**D5.2 逃逸缺陷结果变量从未执行**：首次提出 2026-10-15（[review](critical-shift-left-review-2026-10-15.md) 第 295 行），2026-10-18 重复（[first-principles audit](SpecGuard_Shift_Left_First_Principles_Audit_2026-10-18.md) 第 60 行）重复；D5.3 分组可预测（PR# mod 3），可被挑选 |
| G6 收益>成本 | 避免的返工价值大于注意力与模型费用 | 无实测；F2 的 P×A 是经济假设（方案 §0）；成本字段 `totalCostUsd` 见 [eval/mutation/README.md](../eval/mutation/README.md) | 机制 | unsupported | D6.1 无非 owner 团队的实测；D6.2 Kite 自 10-18 因 billing 停跑，种子 PR 全由 owner 制造（方案 §0） |
| G7 工程质量 | 仓库自身代码有测试、CI、可复现 | [.github/workflows/ci.yml](../.github/workflows/ci.yml)；`src/*.test.js`；mutation 与回放的冻结 manifest | 机制 | partial | D7.1 无第三方指标（Scorecard、zizmor、actionlint、Stryker）；D7.2 已解决：[.github/workflows/gitleaks.yml](../.github/workflows/gitleaks.yml) 在 main 上，触发条件为 pull_request、所有分支 push 与手动 workflow_dispatch（全历史扫描） |
| G8 数据与隐私 | 不泄露私有代码，发布物已脱敏 | [docs/validation-plan.md](validation-plan.md)（Privacy 节）；风险清单见方案 §2 | 机制 | partial | D8.1 已解决：2026-10-19 按所有者决定重写了历史，main 上的记录是 [.github/workflows/ci.yml](../.github/workflows/ci.yml) 第 25 行的注释（"history was rewritten 2026-10-19 (two private files and local user paths removed)"）；防护：ci.yml 与 [gitleaks.yml](../.github/workflows/gitleaks.yml) 拒绝仍含已移除文件的旧历史（#403，提交 `792dbe5`、`6f71729`）；D8.2 无蜜标端到端泄露测试；D8.3 标注 CSV 与 `raw_excerpt` 可能含私有代码 |

## 3. 规则

1. 新增评审文档，只有在**改变某节点状态**或**新增/关闭某 defeater**时才允许，并且必须写明节点编号（如 "G5/D5.1"）。
2. Codex/LLM 评审只算分诊，证据阶梯不得高于"机制"。
3. defeater 只能被证据关闭（跑出的数据、执行 oracle、第三方结果），不能因为有更新的评审又提了一次而算关闭，也不能因为被提过多次而算已处理。
4. 状态变化与证据一起提交，在节点表里改一行。

## 4. 进行中（合并后更新对应节点）

| 在做的事 | 影响节点 |
|---|---|
| gitleaks / 泄露检查 | G7、G8（D7.2、D8.2） |
| 加盐 shadow 臂 + Krippendorff α | G5（D5.1、D5.3）、标注可信度（G1 的 precision、G3 的作者判定噪音） |
| weekly-report 加入逃逸缺陷结果变量 | G5（D5.2） |

以上均为 in progress：合并只说明工具就绪，要等真实团队跑出数据，才能改变状态。
