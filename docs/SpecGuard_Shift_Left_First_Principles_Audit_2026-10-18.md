# SpecGuard 全面技术评估：Shift Left、目标完成度、近期优化净收益与 Unknown Unknowns

> **审查截点：2026-10-18（Australia/Sydney）。** 仓库 [`Mira190/SpecGuard`](https://github.com/Mira190/SpecGuard)；默认分支 `main`；审查的实际主线 SHA 为 [`08d2c5b87bb8ffc144f4ca3135e8aa4ec79f327c`](https://github.com/Mira190/SpecGuard/tree/08d2c5b87bb8ffc144f4ca3135e8aa4ec79f327c)。PR #345 在截点仍为 OPEN，**不能计入 main**；#334 也仍开放。最新主线 [CI #39085373622](https://github.com/Mira190/SpecGuard/actions/runs/39085373622) 成功。本文只读取远程 repo、PR、Actions/jobs/logs、仓库内评测与代码；**没有重新发起模型调用或独立复刻第三方仓库实验，分析阶段未修改产品代码；本文后续作为独立 docs-only 提交，不改变审查截点**。下文明确区分“本轮直接核对”“维护者实验记录”“推论/待证伪”。

## 0. 执行摘要与决策

**结论：SpecGuard 已具备真正的 Shift-Left *机制*，但还不能声称已证明真正的 Shift-Left *组织效果*。** PR 早期反馈、需求—代码—测试追溯、测试层级建议、手动跨仓扫描、成本约束、发现状态与覆盖缺口账本都已实现。不过，本项目最大的风险已从“做不到、跑不动”变成“**看起来审完了，却把缺乏证据解释为没有缺口；或反过来，把找不到测试解释为测试不存在**”。

五个核心判断：

1. **PR 模式：受控样本有效，真实泛化未证实。** Kite 10 个种子 PR 首屏 10/10（来自项目已有记录，非本轮复跑）；另一次对 10 个零发现 dogfood PR 的独立复审发现 4/10 存在真实漏报。两个数字对应不同、非随机样本，不能互相抵消，更不能外推为生产 recall。详见 [`goal-assessment`](https://github.com/Mira190/SpecGuard/blob/main/docs/goal-assessment-2026-10-17.md)。
2. **全仓扫描：可用性大幅改善，发现质量仍是主瓶颈。** 10 月 17 日原始第三方 5 仓扫描的 8 条计入模型发现，人工标注 0 条有价值；同日合入多项修复后，五仓单次全量运行已触达其清单中的所有 unit parts/blocks。Cobra 抽查有 7/7“找不到直接测试引用”的陈述属实，**但“属实”不等于应该补独立单测**；其余四仓的新发现尚未系统盲标。
3. **#343 是有实测支持的正向工程优化，但收益主要是减少误判为 `unsure`，不是召回率/准确率已提高。** 最新 PR 提供离线对照 + branch-pinned 真实 runs；不能把“forced 减少”直接记作“真缺口发现更多”。
4. **当前绿灯与审查充分性有意解耦，但可用性风险显著。** 最新主线 test job 1480 tests / 1476 pass / 0 fail / 3 skipped / 1 TODO；然而部分 dogfood review 仍为 `incomplete`。手动运行 [`39035605423`](https://github.com/Mira190/SpecGuard/actions/runs/39035605423) 绿色，job log 明示 `STATUS: incomplete`，原因是 20 units 仅看到部分测试；这符合当前 `fail_on_error` 的定义，但用户仅看 Actions 绿色会误解。
5. **#345 不应仅凭降误报的局部样本直接合并。** 它把“同一测试块中另有精确断言”当作弱测试发现的降级依据；这并不能证明**被指出的那个输出/分支**受到那些断言约束。需同时测试真阴性与假阴性，尤其是不同 assertion subject 的反例。

**建议定位**：当前可作为“PR 前置验证证据审查助手 + 实验性仓库测试债务雷达”；不应包装为“可靠证明没有缺失单测”“全仓行为已验证”“企业级自动 QA 门禁”。下一里程碑不是增加功能数量，而是证明 **delivered precision / recall、完整性、真实作者修复率** 在不同语言、不同仓库、不同改动类型上稳定改善。

---

## 1. 第一性原理：SpecGuard 到底应当优化什么

原始要求见 [`goal-first-principles`](https://github.com/Mira190/SpecGuard/blob/main/docs/goal-first-principles.md)：

> Create a unit test review AI GitHub Workflow. Must review requirements and the tests, and identify missing unit tests. Must check coding standard has been confirmed too. If possible, review component/integration testing and determine what can and should move down to unit testing.

质量问题应拆成四个对象：**R 需求意图、C 代码行为、T 测试及其 oracle、S 工程标准**，以及发生时间 **t**。真正需要在 QA 之前回答的不是“代码有没有测试文件”，而是：

- `R → C`：需求是否实现、是否一致；旧需求和新需求是否混淆？
- `R → T`：每项关键行为、失败路径、边界、不变量是否有正确 oracle？
- `C → T`：新增/改变的行为是否真被断言约束，而不是仅执行或覆盖？
- `S → C`：适用的编码规范是否找到、实际 lint/format/check 是否执行并确认？
- `T_high → T_unit`：能否把稳定、确定、低环境依赖的验证下沉到 unit，同时保留真正的集成契约测试？
- `t_before_QA`：这些建议是否在 QA 接手之前被送达并采用，最终减少下游缺陷/返工？

一个形式化但实用的目标：

`Expected early QA value = P(true actionable gap) × P(delivered) × P(author fixes before QA) × expected downstream cost avoided − review/triage/compute/false-alarm cost`

这个公式提醒：**即便 precision 提高，只要大量真实问题被静默降级（recall 下降），价值可能为负；即便全仓调用 100% 成功，如果报告没有被看见或没有被修复，也不等于 Shift Left。**

建议采用五个互不混淆的状态变量：`execution`（引擎及交付执行）；`scope`（对象/文档是否被清点）；`evidence`（候选测试/代码/引用是否完整可见）；`judgement`（模型判定可靠程度）；`delivery`（作者看到何种发现）。任何一个失败都不能被一句“no gaps found”替代。

## 2. 目标完成度矩阵（功能验收与效果验收分开）

| 原始/演进目标 | 实现成熟度（以 main 为准） | 实际收益证据 | 未完成的验收条件 |
|---|---|---|---|
| PR 触发、随 push 提前审查 | **已实现**。CI `pull_request` 和 reusable Action | Kite 种子样本、真实 dogfood 评论 | 真实团队、无报警样本的 FN、作者处理率、跨仓稳定性 |
| 需求提取及 R↔C↔T 追溯 | **部分至较完整**：PR/issue + 仓库 docs + trace | 既有检索集指标 R→C MRR 0.444→0.750、C→T Hit@3 4/24→20/24（Fastify 受控集） | 不同语言/monorepo、历史需求冲突、规范仅修改的 PR、动态依赖/跨服务 |
| 发现 missing unit tests | **已实现但高不确定** | PR 种子 10/10；全仓旧版第三方 0/8 有价值；新版需大样本盲标 | 区分 no matching test、no assertion、no effective oracle、genuine new requirement gap |
| 发现 weak tests、价值断言与边界 | **已实现基础规则+模型** | 三方 40 个静态种子旧基线 delivered 11/40、raw 21/40、边界 0/10；后续补强但无同口径全面复测 | 语义数据流、属性/不变量、跨测试辅助函数、变异存活验证 |
| 确认 coding standards | **功能已接入**：instruction/CLAUDE/CONTRIBUTING 与 `standards_checks`, `standards_paths` | 本轮未看到独立完整、真实“违规+lint check”闭环验收 | 适用规则的来源/版本/范围、检查实际通过、缺配置显式 UNKNOWN |
| integration/component→unit 建议 | **已有语义分类**：`higher_level_only`、`pushdown` | 有真实报告输出，但缺成体系人工价值标注 | 何时必须保留集成测试、单位测试替代成本、无错误降级的设计审查 |
| 手动输入目标 repo/PR/文件夹扫描 | **已实现 GitHub 内资源**；`scan_paths` + scope anchor、`scan_scope=all` | 5 外部开源仓真实全仓运行 | 非 GitHub 文档 URL 不可直接读；企业内 GitHub repo/App 权限与 end-to-end 验收；scan `all` 只支持 Claude API 引擎 |
| Reusable workflow / 独立 action | **已实现**，可被其他目标仓调用 | CI 中接口转发校验、README 说明 | 不同企业 org 安全策略、Copilot org quota、private/internal 网络/权限真实 canary |
| 本地 Shift Left | **有 CLI** `bin/specguard-local.js` 与 Windows bash 修复 | 单测、平台模拟 | IDE 开发循环 UX、与云端配置一致性、取消/缓存/异常收敛真实用户体验 |
| 整仓全量扫描 | **技术上已实现** `scan_scope=all`，会分段并用预算准入 | 五仓第 2 轮没有未审分段/文档块 | “所有纳入 inventory 的分段”不等于“仓库全部行为”；还有部分测试被切片（unsure） |
| 真正降低 QA 返工 | **未证明** | 仅 agent 写的种子 PR/闭环实例，无真人作者群组 | 真实作者时间、介入前后缺陷逃逸率、QA 返工时长、干预/对照比较 |

“功能具备”与“目标达成”的差距是本次最重要结论。不要给一个没有可复算定义的“整体完成 85%”。若必须分阶段，当前属于 **技术能力 MVP → 受控试点**；尚未达到经验证的组织级 Shift Left。

## 3. 本轮 GitHub 快照：主线、PR、Actions

### 3.1 Git/PR 冻结点

- 主线 [`08d2c5b`](https://github.com/Mira190/SpecGuard/commit/08d2c5b87bb8ffc144f4ca3135e8aa4ec79f327c) 是合并 [#343](https://github.com/Mira190/SpecGuard/pull/343) 的提交；GitHub 时间 2026-10-18 01:08 UTC（Sydney 12:08）。
- [#344](https://github.com/Mira190/SpecGuard/pull/344) 已于 2026-10-18 00:21 UTC 合并：unit provenance、目录 scope 锚定、CommonJS 导出名、repair reserve、Windows Git Bash。
- [#343](https://github.com/Mira190/SpecGuard/pull/343) 已合并：每个模型调用各自的 cut attribution、按测试内容大小排序、完整 slice 定价。
- [#345](https://github.com/Mira190/SpecGuard/pull/345) **仍开放**：同测试块 pin 值门控 + `NO_GAP` 正则修订；其 [CI #39084816569](https://github.com/Mira190/SpecGuard/actions/runs/39084816569) 通过，但不代表主线含有该功能。
- [#334](https://github.com/Mira190/SpecGuard/pull/334) 仍开放，内容为文档/敏感本地证据清理；非主线已落地事实。
- 近期关键已合并：[#329](https://github.com/Mira190/SpecGuard/pull/329) 整仓一次运行、[#333](https://github.com/Mira190/SpecGuard/pull/333) eval 构造/计分修正、[#335](https://github.com/Mira190/SpecGuard/pull/335) call-level 证据与保守 usage、[#336](https://github.com/Mira190/SpecGuard/pull/336) eval 范围、[#340](https://github.com/Mira190/SpecGuard/pull/340) 报告完整性、[#341](https://github.com/Mira190/SpecGuard/pull/341) 匹配与切片 forced 修正、[#342](https://github.com/Mira190/SpecGuard/pull/342) 手动表单 scope。

### 3.2 CI 与审查状态的实际区别

| 证据 | 观察 | 可/不可推断 |
|---|---|---|
| [main CI #39085373622](https://github.com/Mira190/SpecGuard/actions/runs/39085373622) | test success、dogfood skipped（push，不是 PR） | `node --test` 1480 tests，1476 pass，0 fail，3 skipped，1 TODO；**没有主线这次 push 的 dogfood review** |
| [#343 CI #39083902859](https://github.com/Mira190/SpecGuard/actions/runs/39083902859) | PR test/dogfood 执行成功 | [#343 summary](https://github.com/Mira190/SpecGuard/pull/343#issuecomment-6243528183) 却明确 `incomplete`：7 个 test files 部分可见；不可当作“PR 审得完整” |
| [#345 CI #39084816569](https://github.com/Mira190/SpecGuard/actions/runs/39084816569) | test 1478/1474 pass/0 fail/3 skipped/1 TODO；dogfood success | [#345 summary](https://github.com/Mira190/SpecGuard/pull/345#issuecomment-6243678817) `complete=false`，summary-only finding 1，历史 finding 多个 `not_observed`；不能证明这些旧发现都已修复 |
| [manual #39035605423](https://github.com/Mira190/SpecGuard/actions/runs/39035605423) | job success、`scan` 23/23 units（25 parts） | 日志 `STATUS: incomplete; REASON: 20 units were reviewed with only part of their tests`；`fail_on_error:true` 只把真正 failed 变红；part-of-tests 属 unsure/警告。是**执行成功但验证不完整**的具体反例 |

当前 [`action.yml`](https://github.com/Mira190/SpecGuard/blob/08d2c5b87bb8ffc144f4ca3135e8aa4ec79f327c/action.yml) 的 `fail_on_error` 文案本来就说明 incomplete only warns。逻辑未必是 bug，但 dashboard/branch protection/用户心智有风险。建议把 `execution_status` 与 `verification_assurance` 两个独立 check 交付，明确 required check 的策略：**执行失败阻塞；证据不足默认不应被 UI 误展示为“安全通过”**。

### 3.3 还有一个安全/产品边界

手动 workflow 使用 environment `specguard`，文件本身注释明确要求在 GitHub 仓库设置中**限制到受保护的 main**；YAML 本身不能替代这条组织级配置。它将 private target 结果公开暴露作 fail-closed 防范；`ctx_retention_days:0` 关闭手动结果中的敏感上下文 artifact。反之 [`ci.yml`](https://github.com/Mira190/SpecGuard/blob/main/.github/workflows/ci.yml) dogfood 仍上传 `specguard-ctx` 7 天的 artifact。对将来推广到 internal/private 仓库，**必须单独做权限、artifact 可见范围、fork/PR 信任边界与 prompt injection 测试**。上述是需验收的信任边界，不等于已经发现数据泄露。

## 4. 最重要的实测：全仓范围与模型/静态发现质量

### 4.1 修复前基线——不要遗忘负面数据

项目仓库发布的 [`third-party-scan-eval-2026-10-17.md`](https://github.com/Mira190/SpecGuard/blob/main/docs/third-party-scan-eval-2026-10-17.md) 记录，10 月 17 日对 Nest / Fastify / Flask / Cobra / Hono 的第一批真实扫描：

- 模型计入 8 条发现，人工评定 **0/8 真正有价值**。其中 6 条已经存在测试（只是候选检索未匹配）；还有非产品性能脚本被当作缺口。
- 40 个离线静态种子：**raw 21/40，delivered 11/40**；删边界用例 **0/10**。这里是早期版本，不能冒充 #343 之后的分数。
- weak-lead 抽样存在很高噪声；未引用的导出在 Go 等直接测试入口上比较有用，在 JS/Python 经 public API/DI 间接测试的仓库上常是错的。
- 这反映开放世界逻辑：`test lookup returns empty` **不蕴含** `no test exists`；`export not lexically mentioned` **不蕴含** `behavior untested`。

### 4.2 10 月 17 日修复后的真实全仓运行

第 2 轮在 main `b30696a`，五仓通过 `scan_scope: all`；**每个被 inventory 纳入的 unit part 和 doc block 均有调用覆盖，无因预算/时间未调用者**。数据取自同一文档 §8：

| 仓库 | inventory units | 被认为部分测试的 units（第二轮） | 模型调用 | 成本 | 报告 gap 数量（未经统一标注） |
|---|---:|---:|---:|---:|---|
| Nest | 489 | 262 | 108 | $0.77 | 16 + 1 pushdown |
| Fastify | 33 | 19 | 24 | $0.36 | 10 + 1 pushdown |
| Flask | 21 | 11 | 9 | $0.06 | 4 + 2 |
| Cobra | 18 | 7 | 14 | $0.19 | 6 |
| Hono | 172 | 133 | 81 | $0.77 | 17 |

Cobra 第 1 轮抽查 7 条“找不到 `_test.go` 直接引用”均属事实；但这只是**精确的静态观察**，并非 7 个经验证需要新增单元测试的义务。其余四仓这一轮的发现缺盲标：**不能给出全仓最新 precision**。

Kite 8 个种子：在 #329 全量（`130/130` unit parts + `131/131` docs blocks）时模型 3/8、静态可见 6/8；#341/#340 之后全量模型 2/8、静态可见 7/8。全量覆盖没有拯救删除测试类种子（1–3）：说明不足的不仅是检索/预算，还是缺口推断与模型行为的独立瓶颈。注：这是一组专门设计、模型多轮接触过的种子，不可当生产泛化得分。

### 4.3 #343：哪部分可以判定为正向，哪部分还不能

[#343 PR](https://github.com/Mira190/SpecGuard/pull/343) 提供的离线 before/after（collector+真实 pack，不等同全新端到端 blinded eval）：

| 仓库 | forced before → after | 变化 | 单位调用 before → after |
|---|---:|---:|---:|
| Nest | 263 → 78 | -70.3% | 108 → 104 |
| Hono | 133 → 82 | -38.3% | 81 → 78 |
| Fastify | 19 → 12 | -36.8% | 22 → 21 |
| Flask | 11 → 5 | -54.5% | 9 → 9 |
| Cobra | 11 → 7 | -36.4% | 14 → 13 |

同 PR 的 branch-pinned **真实运行**（非 main 合并后的新运行）见 [#343 description](https://github.com/Mira190/SpecGuard/pull/343)：

- Nest [#39083946253](https://github.com/Mira190/SpecGuard/actions/runs/39083946253)：forced 262→79、104 calls、$1.46；
- Hono [#39083944276](https://github.com/Mira190/SpecGuard/actions/runs/39083944276)：133→81、78 calls、$1.14；
- Kite seeded [#39083942363](https://github.com/Mira190/SpecGuard/actions/runs/39083942363)：13→0、43/43 units 测试被认为完整；报告 6 missing + 3 weak，**不是**“8/8 种子召回”（发现数量不能当 seed recall）。

**为什么是工程正收益：** 修复了所有调用共享全局 `pack-cut` 的误归因（一个 shared test 在调用 B 被切，导致调用 A 的单位也变 unsure）；其后按小 test pack 优先、超长 test 按完整 slices 定价，减少部分测试可见性的误分类。PR 在实际 pack 上检查了部分由 forced→非 forced 的单位，没发现“应截断却误认完整”的违反实例。

**还不能说的：** 不能说模型 precision/recall 比 #341 更好；不能说所有 80-line test block 都可见；不能说 #343 在最新 `main` 已跑新一轮五仓盲标；不能以 $1.46/$1.14 证明默认 $1 能做到相同（真实 runs 的预算输入需单独核对）。优先保留 #343，不回滚；但给 forced、`cut attribution`、实际 visible-span 加对账回归，避免未来被优化吞掉。

### 4.4 每项最近修复是否“正优化”（净收益判定）

| PR | 正向证据 | 主要反向风险/证据不足 | 结论 |
|---|---|---|---|
| #329 全仓 all | 5 仓一次 run 全 parts；Kite 种子 130/130 part | 依赖 Claude API 而非 Copilot；成本、超大仓及完整性语义 | **可保留，功能正向；质量未证** |
| #333/#336 eval 可信性 | 修复零 diff、错误排除文档、重复计算等，降低“测错对象”的风险 | 历史成绩不可直接跨版本比较 | **高价值正向；需版本化重建基线** |
| #335/#344 provenance | 限制 finding 引用不存在于自身 call/unit 的来源 | 过强的“own file”门禁可能静默压制跨单元真实缺口 | **大体正向；需负例召回测试** |
| #340 报告诚实性 | 未评估不再伪装非需求、all 输出完整静态线索、账本 | all 输出增多增加信息过载 | **正向；改 UX 分级** |
| #341 test 匹配收敛 | 消除同名 index/handler 测试跨目录污染、弱匹配 cut 虚高 | 可能排除跨包 integration 的真实候选 | **正向倾向；需检索 Recall@k 守门** |
| #342 手动 scope | 目录 URL 锚定扫描范围，降低误审范围 | 非 GitHub URL 和私仓权限仍限制 | **正向 UX/安全** |
| #343 per-call cut/slice | 离线+branch 实验大量减少 forced；减少调用 | “部分测试可见性”不等于 finding quality | **明确正向工程优化，收益范围限定** |
| #345 same-test pin（未合入） | Hono/Flask 实例中有真实冗余 weak 断言 | 其他 subject 的断言不能证明当前 subject、分支/参数/路径 | **暂不判定；要求 FN regression** |

---

## 5. PR 模式当前的真正瓶颈：从找到，到作者能用

现阶段 PR 链路可拆为 `Changed behavior → obligation → evidence candidates → context pack → model → evidence verifier → confidence gate → inline/summary → author action`。每一步都可能丢真阳性，并且“CI 全绿”不会暴露这一事实。

1. **Retrieval**：hunk identifiers 改进了 Fastify 的 C→T 搜索，Hit@3 4/24→20/24；然而相关基线集中一个高贡献文件，剔除后依然进步到 14/24，但仍不是全语言/跨服务保证。改善候选 recall 更应排在扩大模型调用之前。
2. **Packing**：[#343 dogfood](https://github.com/Mira190/SpecGuard/pull/343#issuecomment-6243528183) 列出多个测试文件只看到部分文本；报告 `execution_complete=false`。这里的根因是证据传输/预算—not reasoning；把上下文丢失标 `unknown` 是对的，但应测损失发生比例与 top-risk 优先权。
3. **Verification**：模型生成的合理故事可能引用“并非调用真实看到”的行。#335/#344 已加强 provenance，但要防将验证规则改成“只接受单文件局部缺陷”，使跨模块/间接调用类更易漏报。
4. **Publishing**：fast tier 最多 3 条 inline，其余总结；combined 大 PR 的 10/24 delivered（隔离时 14/24，仓库记录）说明“模型找到了”和“用户第一屏看到了”不是同一事件。优化发送层比盲目拆更多模型 call 更直接。
5. **Lifecycle**：旧发现 `not_observed` 并不等于 fixed；PR #345 的最新摘要有多个此前记录不再可观察。必须将 `addressed-by-validated-test`、`code-touched`、`still-present`、`unobserved`、`dismissed` 分开，任何修复率都不能把后几类自动算 addressed。

**强制 UX 原则**：若 `input/source/candidate/pack` 任一环节不完整，顶栏必须明确 `Reviewed X/Y behavior obligations; evidence cut for Z; verdict for affected criteria: UNKNOWN`。`No findings` 应当只代表“在确实审过的范围内暂无可发布发现”，不能被误解为“测试已经充分”。

## 6. Unknown unknown：从第一性原理新提出的高风险假说

这些是**需要主动证伪的候选故障模式**，不是已证实 bug。P0 表示若成立将直接损害核心 shift-left 判断。

| 优先级 | 未知/风险假说 | 为什么可能骗过现有测试 | 最小证伪实验与成功门槛 |
|---|---|---|---|
| **P0** | **相关性谬误：#345 同块另一个值断言使目标弱断言被降级** | `expect(a.ok).toBeTruthy()` 与 `expect(text).toBe('Hello')` 可以彼此独立；“同块”不构成因果保护 | 同块不同 subject、不同参数、不同 branch 三种真缺口对照 + 真误报对照；前者 delivered recall 不得下降，后者误报须下降；否则只降措辞不压投递 |
| **P0** | **错误的完备性量化：inventory=100% 却不含生成代码/配置/SQL/schema/外部契约/动态行为** | 分母由启发式清单自己定义，`100% of inventoried` 可能掩盖未纳入对象 | 每仓人工抽 50 个实际 changed behavior；比较 `discoverable / inventoried / reviewed / delivered` 四重分母；不识别的类别显示 excluded/unknown |
| **P0** | **跨调用 finding 的 provenance 过强或过弱** | 同一行为跨多个 unit、共享测试或一条调用链；严格 own-file gate 可能删正确发现，不严格则幻觉通过 | 双向 mutation：跨 unit 真实缺口、伪造 other-call 引用；分别测 FP/FN，必须有拒绝理由可审计 |
| **P0** | **实际完整片段 ≠ 语义测试完整** | 80 行窗口可能覆盖断言，却遗漏 setup、helper、fixture、beforeEach、参数表 | 构造断言在窗口内但断言前置 setup/fixture 在窗口外的样本；必须降级 UNKNOWN 或扩上下文；禁止判“fully verified” |
| **P0** | **相同 CI 绿色但实际 review incomplete** | `fail_on_error` 对 unsure 不阻塞，用户可能只看 badge | 以 Actions consumer 视角抽样 20 次成功 run，统计 complete/unsure/failed；两个明确独立 check + 真实 UI canary |
| **P0** | **需求 oracle 污染（C=T≠R）** | 需求没变，代码和测试一起改错；传统 code+test reviewer 可能被同向测试误导 | 需求旧值锁定、代码/测试同步改为错误新值，所有 unit 绿；必须报 requirement contradiction |
| **P0** | **要求只改变，或 PR issue 未链接时掉需求** | 纯文档 PR 或跨仓外部需求链接；PR 模式如果只看 source changes，默认“nothing to review” | 需求-only PR + linked issue + GitHub doc only + 非 GitHub doc URL，逐条验收模型输入和未读源告警 |
| **P1** | **覆盖率/变异测试数据被错误绑定到 commit** | coverage_file 在同 job 生成，但不是目标 HEAD、合并提交与 PR head 不同；覆盖“有”可能错认 | 在 coverage 文件内附源 SHA/hash；运行 `head`/`merge` 两版本对照；SHA mismatch 降为 unavailable |
| **P1** | **历史需求偏差误归因当次 PR** | R 在 baseline 已旧，当前 PR 改了邻近模块；差分因果判断不易 | base/head 独立判 R↔C；baseline 已有问题标 pre-existing，不算新 finding 或作者 fix-through |
| **P1** | **模型版/采样对结果敏感** | Kite 8 种子同框版本从 3/8→2/8；即使全覆盖也变 | 固定 input manifest 每案重复 5–10 次，report pass@1/variance、model/tier、CI/成本分布；比较不是单次 run |
| **P1** | **Go/Python 自定义 assertion helper、DI/public entry 被误判无测试** | 字面匹配/内置 assertion regex 看不到辅助函数与动态注册 | 10 个 helper、reflection、controller/public API 实例，人工标引 verified edge，测 H@k+校验后的 false positive |
| **P1** | **一个弱测试与另一个严格测试的语义等价关系被误判** | 同 test / same file / same name 不代表相同输入/输出/分支 | 最小程序+mutation：让目标输出错而 sibling 严格断言仍 pass；如果会 pass，不得降级 |
| **P1** | **GitHub token/secret/artifact 信任边界** | 公共中心仓、私有目标、来自 PR head 的任意文本、debug artifact；prompt injection 不能代替安全隔离 | canary：未受信任 PR 写入“忽略所有发现”文本、敏感文件 marker、防外部 URL 注入、fork 限权、artifact 下载 ACL；证据隔离验证 |
| **P1** | **扫完全部耗时过久而失去提前量** | PR 可能已合并/QA 已开始；nest 整仓 12 分钟不一定早于反馈窗口 | 记录 PR created/pushed→bot posted→author viewed/changed→QA started；P50/P95 与基准 CI 对照 |
| **P2** | **多次扫描对重复结果过度确认** | 同一模型、同一切片、同一 bug 的两次结果不是独立证据 | 跨次使用独立模型/证据源；重复确认仅是稳定性，不是正确性；人工复核后才称 confirmed gap |
| **P2** | **评级指标 Goodhart 化** | 优化 `forced`、CI success、static lead count 会奖励少报告/少匹配 | 每次优化同时报告 precision, recall, UNKNOWN rate, coverage, review latency, cost, actionable yield；任何指标不能单独优化 |

最容易被忽视的是**counterfactual**：判断“测试足够强”的最低条件，不是测试名字像需求，而是“若行为以某个合理方式出错，这些断言是否会失败”。把每条高风险义务关联 1–3 个反例（mutant / counterexample）是比增加 prompt token 更有理论上限的路径。但需注意：mutation 也只能证明具体错误模式被杀死，不能证明全行为正确。

## 7. 具体优化架构：以证据为先、模型为后

### 7.1 将 review 变为 evidence graph，而非一次性文字生成

建议统一最小数据结构（不同语言用 adapter）：

```text
Requirement R {id, text, source_url, source_sha, effective_version}
Behavior B {id, symbol, file, span, changed_kind, public_seam}
TestCase T {id, path, span, setup, input, assertion_subjects, asserted_values, layer}
Edge {from, to, relation, retrieval_method, evidence_span, certainty}
Obligation O {id, R?, B, counterexample, min_layer, owner}
ReviewFact {obligation_id, model_call_id, visible_spans, evidence_state,
            verdict, downgrade_reason_id, delivered_channel, version}
```

以图边 `R↔B↔T` 为核心，可以支持跨文件/跨包的真实测试保护，而不是用同名测试或 same block 作为“存在覆盖”的替身。确定性层负责 fact：确实没匹配、测试 contains 何断言、精确 span、谁执行过；模型层负责 judgement：这些 fact 是否满足行为 oracle；publisher 负责不要把低置信推成确定结论。

### 7.2 先区分三类缺口，减少错误承诺

1. **No test evidence found**：检索未找到证据（通常静态 lead，**不是 missing test**）。
2. **Test does not constrain changed behavior**：有匹配测试，但特定 mutant/counterexample 仍会 pass（更高价值）。
3. **Requirement mismatch**：已有需求与代码/测试实际验证矛盾（最高价值，哪怕 unit tests 全绿）。

UI 建议主视图按 `Requirement contradictions → High-confidence missing/weak unit obligations → Pushdown opportunities → Evidence gaps / unknown`，每项只展示可操作证据与最小新测试案例（inputs、expected、为何当前断言会通过）。“规则违规”需要独立显示 `standards applicable / check executed / result`，不可只说“coding standard confirmed”。

### 7.3 避免对全仓无 diff 场景投入过多模型调用

全仓与 PR 是两种根本不同的推理问题：PR 有明确 ΔC/ΔR，能看到删掉的断言；全仓要从巨大代码空间推断**缺少什么**，属于开放世界信息不完备问题。建议全仓采用静态候选→小规模模型复核→周期状态；让模型只审 `(risk × uncertainty × evidence availability)` 最高的条目。PR 采用 Δ 驱动、精确检索、高价值 counterexample；把关键回归/变异/历史 bug replay 放在优先路径。

### 7.4 与现有 CI 的协作而非重复

- `unit coverage`: 作为执行证据和风险优先级，不代表 oracle 正确；标注 coverage report SHA。
- `mutation`: 对重点义务验证 counterexample 的可杀性；不必每个 PR 运行全仓 mutation。
- `lint/format/typecheck`: 直接消费 CI check 结果，模型不重复判断 formatter 已知道的事。
- `integration/e2e`: 明确哪些网络/合同/兼容性断言必须保留，哪些纯输入输出逻辑能下沉；不鼓励“以 unit 替代端到端”。
- `historical bugs`: 用曾经逃过 CI 的真实 bug 做 SZZ PR replay，比人工设计种子更接近商业目标。

## 8. 行动优先级：每个 PR 必须附反证和退出条件

### P0：下一个工作周期，不继续泛化宣传

| 任务 | 改动点 | 验收（可执行） | 不通过时 |
|---|---|---|---|
| **P0-A 评估 #345 负收益风险** | `src/audit-post.js` `pinnedInTest` | 至少 20 个阴/阳例，覆盖不同 assertion subject / call args / branches / fixture / anchored regex，盲标 delivered FP/FN | 保留特例白名单，撤销广义“同 test 有别的 pin 值即可降级” |
| **P0-B 可见性/覆盖账本** | `src/audit-units.js`, `src/engines/claude-api.js`, publisher | 产出每个 unit 的 `candidate tests / packed tests / visible full-or-slices / notWhole / verdict`; 守恒对账；对 #343 前后取样反例 | forced 指标不允许单独作为发布成功信号 |
| **P0-C Release gate** | CI + eval harness | 固定 SHA 的 8 Kite + 40 外仓种子 + 真实正/负 PR，产出 raw/delivered TP/FP/FN + cut rate、准入失败 | 阻止无验证的语义门控发布；CI pass 仅证明代码健康 |
| **P0-D 编码规范目标验收** | integration eval fixtures | 真正违规与已配置 lint 各 2–3 个 PR，规则适用/未适用/未执行均可辨 | coding standard 在 scorecard 保留未证明 |
| **P0-E Review status** | summary/check UX | 独立 `engine_result=success`、`evidence=partial`；人工在 GitHub PR/Actions 两处能看懂，无“绿色=全覆盖”歧义 | 不能将 inconclusive 标为通过质量门禁 |

### P1：建立跨仓和跨语言可迁移质量

- **测试检索 Recall@k 基准**：真实 Nest/Fastify/Flask/Cobra/Hono 各抽定量行为，直接调用匹配 API 前后对比 `hit@3`, `all-required`, `unread`, false matches；每个 FP 给出真实保护路径。若召回下降，不允许用减少 forced 掩盖它。
- **大 PR delivery 研究**：同一固定输入在 `inline cap 3/10`、高低置信、单次/分块条件下交付端 recall 与 reviewer cognitive load；先解决被压到 Details 的高价值发现，再花钱拆调用。
- **至少两次真实 Copilot 端到端 canary**：用公司实际授权的 token/org billing；需要核验 model、权限、成本、json repair、发布、失败分类，而非只测试 adapter mock。
- **Requirements source adapters**：对 GitHub 之外的 Confluence/SharePoint/Docs 链接，提供明示的可信抓取机制或要求提前导入 snapshot，包含版本/ACL；不可默默忽略。当前手动表单输入只支持能从 GitHub 访问的文档源。
- **独立人工标签**：两名审阅者不看模型结论来源，标注“真实测试义务/可行动/值得 unit/已有间接测试/不确定”，冲突仲裁、计算一致性。

### P2：产品化、性价比与组织采用

- 把 unit/requirement/call/source manifest 做增量缓存，以 commit/tree/hash 失效，不让全仓每 push 重扫；每次报告 cache hit、material delta 和漏评边界。
- 对异常场景（API throttling、超时、output invalid、scan interruptions）保留上次已确认结论但标为 stale，绝不假装新审通过；确保 status/check 消费端区分“失败”“未审”。
- 做真实开发者 A/B 或交叉试点，测被提前修复的真实缺陷、QA 被退回次数、作者耗时、噪声投诉、token 消耗；仅比较模型 tokens 不是最终目标。

## 9. 建议使用的评测协议与最低验收门槛

当前没有足够数据制定绝对“合格 precision”。建议以下 **预注册试点门槛（目标，不是现状）**：

| 指标 | 精确定义 | 建议试点门槛 |
|---|---|---|
| Delivered actionable precision | 人工判真正值得处理的已送达发现 / 全部已送达可行动发现 | ≥ 70%，并报告 95% CI 与分语言/类型结果 |
| Delivered recall | 被送达的真实缺口 / 事先独立确认的真实缺口（包括运行失败） | ≥ 70% 正样本种子；真实回放基线逐步设定，不得用种子冒充生产值 |
| FN silent rate | 真缺口未发现在 summary/inline 且也未标 UNKNOWN 的比例 | 趋近 0；每项 gate 优化 FN 不上升 |
| Evidence completeness | 对纳入的 obligation 真正收齐必需 R/B/T spans 的比例 | 报告率 100%；比例本身单独测量，不能用 inventory coverage 代替 |
| Run reliability | PR/scan 预期执行中确实完成且可追溯状态的次数 / 预期执行次数 | ≥ 99% 运行分类准确（从原始 jobs/summary 验证） |
| Fix-through (verified) | 作者在 QA 前新增/修改测试且新测试能杀死对应 counterexample 的发现比例 | 先建立 ≥ 30 个真人作者事件的基线，再制定门槛 |
| Time-to-feedback | push→可见结果 P50/P95；与 QA 接手时间比较 | PR P95 需符合目标团队时效，且在 QA 前送达 |
| Cost per *validated* finding | 总模型/runner/人工分诊成本 / 人工确认并提前修复的缺口数 | 逐月下降；不得只优化 cost/run |

**必须采用配对实验：** 在相同 repository SHA、gold truth、预算、模型/tier 和上下文上测试 baseline 与 candidate；模型有波动时重复多次；同时看 FN、FP、unknown 与交付渠道。禁止用“本版本生成了更多 leads”来证明“测试缺口抓得更准”。把原来因 eval 构造失败而生成 `zero-diff` 的案例重新审定（[#333](https://github.com/Mira190/SpecGuard/pull/333) 已修工具），历史分数要注明不可直比。

## 10. 对 #345 的专门批判性设计复审

本轮 #345 是最值得优先关注的**潜在负优化**。它提出 `pinnedInTest(lines, citedLine)`：以测试声明边界扫描 same test；如果找到任意被认定为精确的断言，则把弱断言 finding 降为 low confidence；对 `CALL_SUBJECT` 的被质疑行作例外；增加 `NO_GAP` 对“not a gap”的识别。正动机明确：原先 Hono/Flask 有“test 其实已经 pin value”的误报。问题是：

```js
it('checkout', () => {
  expect(result.success).toBeTruthy();   // 需要测试 true/false 的语义
  expect(receipt.label).toBe('Paid');    // 只钉住另一个字段
});
```

若 bug 令 `success=true` 且 receipt.label 仍为 `Paid`，第二个严格断言无法证伪前一个行为缺陷。此时用“same test pins a value”降级并非 sound。更复杂情况是两条独立 API 调用、不同 branch、fixture 初始化与表格驱动场景；当前 `CALL_SUBJECT` 例外只覆盖部分直接调用表达式。**同一个 test block 是组织结构，不是因果证据。**

建议更安全的策略：只有能展示同一行为的 data/control-dependency 或同一输入输出的严格 oracle 时才降级；否则仅在详情中说明“同测试块还存在其他断言，人工确认是否约束此行为”，**不改变 delivered 级别**。先用三个真实发现保持 recall 的控制组，再做多语言反例和 5 仓 before/after 盲标。如果 #345 在降低 FP 的同时引入不可接受 FN，应缩小规则而非用更长正则修补。

`NO_GAP` 文本判断也属于弱语义信号：模型写“not a gap in legacy but new path is a gap”已被该 PR 排除误删，但更多否定/转述上下文仍可能误触。建议改为模型输出显式 `verdict: gap | no_gap | unsure` 并由 schema、证据校验，而不让自由文本触发关键 gate。任何 LLM 自我否定的字符串都不能替代评审证据。

## 11. 建议的端到端用户体验（Shift Left 真正落地）

**PR 作者收到的首屏**应回答：

- 哪个 requirement/changed behavior 最可能出问题？
- 当前哪一个测试（含路径/行/输入与断言）没有约束它？
- 给出一个能让当前测试依然通过但行为错误的反例；建议补的 unit assertion 应钉哪个值？
- 是否确实阅读了相关测试/规范；未读/截断/未匹配的是什么？
- 是本 PR 新引入、还是 pre-existing；属于 unit、integration 或更高层？

在 Actions 手动全仓模式：第一屏只给 `scope coverage / evidence coverage / verified high-confidence issues / leads / unknowns` 5 项，后面是可下载 JSON/CSV 的 per-unit ledger。不要默认把几十个 `unreferenced_export` 作为“漏单测”推给其他团队；应提供“review candidate + how to check”的明确行动建议。手动 one-off `scan_issue=none` 必须标注未跨次确认。

## 12. 结论：什么才是下一次可以宣布的里程碑

**现在可以合理宣布：** SpecGuard 已在 PR 和跨仓扫描两个入口提供前置测试证据审查；全仓一次 run 的分段执行、预算和可观察性较 10 月 17 日早期明显改善；#343 对 `unsure` 误归因有实测的大幅修正；主线自动化测试健康。

**现在不能合理宣布：** “已证明让 QA 工作量下降”“扫描 100% 就意味着全部测试充分”“模型能可靠发现复杂第三方项目遗漏的 unit tests”“近期每次 gate 变化都是正优化”“#345 已落地主线”。

**单一最重要的下个里程碑：** 在固定真实 PR/SZZ 回放 + 五仓人工标注 + 受控 counterexample 集上，建立按 `source→candidate→packed evidence→model→verified→delivered→author fixed` 每一层的损失账本，然后证明一个优化在 **delivered recall 不降**的情况下显著提高 actionable precision 或缩短 QA 前的反馈周期。届时才可把“Shift Left 机制”升级为“Shift Left 效果”。

---

## 附录 A：核心直接证据（固定 URL，便于复核）

1. **主线、CI 与产品配置**：[`main 08d2c5b`](https://github.com/Mira190/SpecGuard/commit/08d2c5b87bb8ffc144f4ca3135e8aa4ec79f327c)；[CI run 39085373622](https://github.com/Mira190/SpecGuard/actions/runs/39085373622)；[`ci.yml`](https://github.com/Mira190/SpecGuard/blob/08d2c5b87bb8ffc144f4ca3135e8aa4ec79f327c/.github/workflows/ci.yml)；[`action.yml`](https://github.com/Mira190/SpecGuard/blob/08d2c5b87bb8ffc144f4ca3135e8aa4ec79f327c/action.yml)；[manual workflow](https://github.com/Mira190/SpecGuard/blob/08d2c5b87bb8ffc144f4ca3135e8aa4ec79f327c/.github/workflows/specguard-run.yml)。
2. **最新重要 PR**：[#329](https://github.com/Mira190/SpecGuard/pull/329)、[#333](https://github.com/Mira190/SpecGuard/pull/333)、[#335](https://github.com/Mira190/SpecGuard/pull/335)、[#336](https://github.com/Mira190/SpecGuard/pull/336)、[#340](https://github.com/Mira190/SpecGuard/pull/340)、[#341](https://github.com/Mira190/SpecGuard/pull/341)、[#342](https://github.com/Mira190/SpecGuard/pull/342)、[#343](https://github.com/Mira190/SpecGuard/pull/343)、[#344](https://github.com/Mira190/SpecGuard/pull/344)、[开放 #345](https://github.com/Mira190/SpecGuard/pull/345)。
3. **真实评价与局限**：[`third-party-scan-eval`](https://github.com/Mira190/SpecGuard/blob/main/docs/third-party-scan-eval-2026-10-17.md)；[`goal-assessment`](https://github.com/Mira190/SpecGuard/blob/main/docs/goal-assessment-2026-10-17.md)；[`goal-first-principles`](https://github.com/Mira190/SpecGuard/blob/main/docs/goal-first-principles.md)；[`latest-pr-actions-shift-left-followup`](https://github.com/Mira190/SpecGuard/blob/main/docs/latest-pr-actions-shift-left-followup-2026-10-17.md)。
4. **独立运行/发布证据**：[#343 真实分支 runs 汇总](https://github.com/Mira190/SpecGuard/pull/343)；[#343 incomplete dogfood summary](https://github.com/Mira190/SpecGuard/pull/343#issuecomment-6243528183)；[#345 incomplete dogfood summary](https://github.com/Mira190/SpecGuard/pull/345#issuecomment-6243678817)；[手动 run 39035605423](https://github.com/Mira190/SpecGuard/actions/runs/39035605423)。
5. **实现定位**：[`src/audit-units.js` — slices/cost/pack/risk](https://github.com/Mira190/SpecGuard/blob/08d2c5b87bb8ffc144f4ca3135e8aa4ec79f327c/src/audit-units.js)；[`src/audit-post.js` — provenance/gates/cuts](https://github.com/Mira190/SpecGuard/blob/08d2c5b87bb8ffc144f4ca3135e8aa4ec79f327c/src/audit-post.js)；[`src/engines/claude-api.js`](https://github.com/Mira190/SpecGuard/blob/08d2c5b87bb8ffc144f4ca3135e8aa4ec79f327c/src/engines/claude-api.js)。

## 附录 B：证据分级及本报告未做的事

- **A：本轮直接核对**：GitHub repo SHA、PR state/merge、CI job log 的 TAP 统计、真实 dogfood issue comment JSON/正文、手动 run 39035605423 log、main 主要 workflow/action 与部分实现代码。
- **B：仓库发布的试验记录**：Nest/Hono/Kite 分支实跑数字、五仓盲标、40 静态种子、10 PR 种子/复审数据。阅读其报告与 PR 描述，但**未在本轮重新标注每一条或解开 artifact ZIP**；推断应以 B 级证据陈述。
- **C：需要验证的新风险**：#345 主体不匹配降级、不可见 fixture、inventory 定义漏洞、需求 oracle 版本、用户看到绿色误会、真实人类 adoption 等；它们是实验待办，不是已坐实的代码缺陷。
- 分析阶段没有触发付费模型、没有覆盖用户本地未提交 worktree，也没有修改产品代码或原有 issue/PR。本文以独立 docs-only PR 提交，报告证据级别需复核后再合入主分支。