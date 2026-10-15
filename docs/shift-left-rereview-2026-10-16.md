# SpecGuard 再审查：从局部修复到可验证的 shift-left 结果

What this repo does: SpecGuard 在 PR 阶段对照需求、代码、测试和仓库规范，提出测试缺口与需求偏差；scan 模式轮转审查既有代码与需求文档。它提供静态、建议性的审查，目标是在 QA 之前形成有效保护。

审查于 Sydney 2026-10-15 开始，2026-10-16 整理交付。固定代码基线：`a90608cc040ddd1a0e6bbcb6539b63c31ad9b64f`，build `43f6581ae316`。负载假设：正常团队 PR、数个至十余个候选单元、需要多轮 scan 的中等仓库，以及文档支持的跨仓库集中报告部署。

本轮只提交审查文档，不修改产品实现。发现编号接续前两轮 F01–F18。所有新发现均有当前代码的本地反例；模型输出和 GitHub API 使用合成数据及 mock，没有发布测试评论、运行付费模型或读取私有业务源码。

## 1. 结论与证据边界

**本轮确认六项问题：两个结果状态问题、一个需求身份问题、两个轮转进度问题、一个跨仓库状态读取问题。工程修复已有明显进展，但“上下文诚实、审查持续推进、结果可追溯”尚未形成端到端保证。**

最值得先修的是 F19–F21：信息缺失、输出损坏或需求错配，仍可能得到更强的“complete / covered”结论。F22–F24 则说明：单次调用能运行、单个源码窗口能装下，并不证明多轮审查能覆盖当前版本。

现有回归通过与上述反例同时成立。原因是这些反例跨越了多个已分别测试的组件：collector → pack → validator → state → publisher → 下一次 preflight/collector。将每段实现分别验收，仍会漏掉组合后的错误。

本文不把以下事实当作目标已达成的证明：CI 绿、JSON 合法、引用文本存在、两次模型报告相同问题、单个 seeded PR 被发现、报告写成 covered。这些事实各自只能支持较窄的结论。

## 2. 第一性原理：目标需要什么证据

[原始目标](goal-first-principles.md)要求审查需求和测试、发现缺失单测、确认 coding standards，并在合适时将高层测试中的逻辑下推到单测。真正的完成条件是：开发者在 QA 之前得到正确、可执行的建议，并因此补上能约束错误行为的保护。

需要修正旧分析中的一个过强简化：**CI 绿只表示被配置、被发现且实际执行的检查通过；它不证明代码与测试全面一致，更不证明二者符合需求。** 同样，静态覆盖证据只能说明某个断言看起来约束某个行为，不能证明测试在当前配置下运行并能阻止目标缺陷。

| 必须成立的关系 | 最小可验证证据 | 不足以替代它的代理 |
|---|---|---|
| 审查的是正确需求 | 候选 ID 绑定具体来源、块或区间、内容版本 | 任意已准入文档中的一句真实引用 |
| 审查范围完整且诚实 | 明确的目标集合、已读范围、遗漏原因和可重试状态 | pack 文件存在、调用成功、模型没有发现 |
| 测试约束目标行为 | 输入、预期、可区分的错误结果，以及相关断言 | 同名函数、相同错误字符串、测试文件存在 |
| 历史结论适用于当前版本 | 代码/测试版本与已审查区间同时有效 | 相同路径 ID、整数游标、上轮 covered |
| 建议带来 shift-left 收益 | 作者采取相关修正，目标故障不再通过，反馈发生在 QA 前 | 任意测试文件有变化、thread resolved、评论数增加 |
| 推进成本合理 | 所有尝试的费用、耗时、重复扫描和人工核查成本 | 最后一次运行的费用、只看成功样本 |

因此，“未找到测试”“没有可发布 finding”“完成当前窗口”“已覆盖整个当前版本”需要分开。丢失证据只能降低结论强度，不能生成 covered 或允许永久跳过复查。

## 3. Must fix：确认的新问题

### F19 · P1 · PR 的 pack 截断不进入完整性状态，下一次会跳过复查

- **这是什么：** [post.js:1469](../src/post.js#L1469) 读取 `pack-cut.txt`，但只对已经出现的 missing/weak finding 降低置信度。最终 [execution_complete](../src/post.js#L1710)、[状态与 head marker](../src/post.js#L1725) 不检查这些遗漏。
- **问题：** 合成一个有合法 covered citation、没有 finding 的 PR，同时将源码和候选测试列入 `pack-cut.txt`。真实 `post` 输出 `status=complete`、`execution_complete=true`、`No unit test gaps found`，写入 head marker；真实 `preflight.decide` 随后跳过同 head。证据是发布协议反例，不是声称真实模型必然这样回答。
- **最小修正：** 将必需审查文件的遗漏作为 run-level incomplete 输入，保留可验证的正向证据，但禁用全局 clean 结论、head 缓存与自动清理线程。复用已有 `incomplete` 列表，先保守标记现有 `pack-cut.txt`，不需要新框架。
- **不修的后果：** 模型漏读后越少报告问题，系统越容易认定完成；缺口不会因普通重跑被重新审查。

**验收：** 同一合法输出分别配完整 pack 和截断 pack，后者必须 incomplete、无 clean 结论、无可跳过 marker；已有真实 citation 可以保留。再测试“源码截断但无 finding”“只有测试截断”“未知/已失败 engine”及与 reduced review 的组合。

### F20 · P1 · scan 丢弃坏 finding 后，把相关单元记为 covered

- **这是什么：** [validate:150](../src/audit-post.js#L150) 容忍并删除 malformed unit finding；[main:752](../src/audit-post.js#L752) 的完整性条件没有纳入单元裁决失败；[stateOf:383](../src/audit-post.js#L383) 用“没有保留下来的 finding”生成 covered。
- **问题：** 模型针对一个合法 unit ID 返回 missing_test，但缺少 title。真实 scan 发布路径会把该 finding 删除，在说明里记一条校验提示，仍输出 `status=complete`，并把该单元写成 `covered`。报告中的说明没有阻止历史状态变强。
- **最小修正：** 记录无法裁决的 unit ID，使它保持 unknown/due、不刷新审查日期、不推进窗口；若损坏结果无法归属具体 unit，则保守处理该调用的单元集合。对 missing/non-array `unit_findings` 区分“没有结果”和“合法空结果”，不要默认为成功的否定结论。
- **不修的后果：** 格式或引用越差，问题越容易从结果中消失；错误状态会影响下一轮优先级及历史解释。

**验收：** 缺 title、坏 unit ID、错误引用、整个 findings 字段损坏，以及明确 `not_reviewed`，都不得生成新的 covered 或推进游标；合法空结果和完整有效 finding 保留原有正常行为。即使保留内部 covered 枚举，也应明确其仅表示“该范围未发现缺口”，不等于执行覆盖证明。

### F21 · P1 · 合法候选 ID 可以引用另一个需求，重复 covered 掩盖漏审

- **这是什么：** [verify:230](../src/audit-post.js#L230) 检查引用确实存在于已准入文档；[verify:237](../src/audit-post.js#L237) 使用 ID 查到的 candidate 主要取得 heading，没有核对 citation 是否属于该 candidate。
- **问题：** A.md 的需求是“拒绝负数”，B.md 是“接受正数”。输出保留 A、B 两个合法 ID，但两行都引用 B.md 和正数测试；validate 成功，verify 输出两条 covered，零校验提示。A 的需求没有被审查，却占据一个 covered 身份。
- **最小修正：** 将 candidate 的来源路径与块区间作为可信边界，验证子需求的 source 确实落在该块；错配时用原 candidate 恢复 unknown。保留 `.1/.2` 原子拆分，但不能允许它们换成其他块的内容。
- **不修的后果：** 引用真实性验证看似通过，需求召回和覆盖分母却被重复证据污染，尤其容易隐藏否定条件、边界和第二条 AC。

**验收：** 不同文档交换 ID、同文档不同块交换引用、重复引用另一需求，均保持漏审项 unknown；同块合法拆分和允许范围内的引用定位修正仍通过。只核对文件名还不够，同文件中的跨块替换也必须被拦截。

### F22 · P1 · 分段游标没有绑定内容版本和窗口布局，能跨版本漏审

- **这是什么：** [partOf:69](../src/audit-units.js#L69) 用 prior `uc[id]` 直接选择当前窗口。[staleUnit:60](../src/audit-units.js#L60) 已能识别版本变化，但没有使游标失效；[stale:150](../src/audit-units.js#L150) 只返回本轮未选中的 stale 单元。
- **问题：** 600 行源码分三段。首轮读 1–200；随后修改第 1 行，第二、三轮仍读 201–400、401–600，最后状态为 covered，新第 1 行从未重审。另一个反例只改 `max_units: 12 → 1`：窗口由五段变三段，整数游标仍为 1，下一轮直接从 201 开始，121–200 永久漏过本轮遍历。
- **最小修正：** 游标至少绑定现有 unit version 和稳定的分段布局标识（或直接保存下一行与对应版本）。版本或布局不一致时从头开始；不可将旧版本其他分段的 finding 与当前版本组合为完成。选中单元也需要版本失效处理。
- **不修的后果：** “最终扫到最后一段”被误当成“当前版本每段都扫过”；在活跃仓库和正常调整预算时，历史结果会拼接成不存在的完整审查。

**验收：** 同版本同预算按序完成；修改已读区间、修改匹配测试、调整 max_units、切换 engine/窗口规则时，游标必须重新验证。最终完成必须满足：当前版本的目标区间并集无洞；不能只断言 `k === n-1`。

### F23 · P1 · 全部源码装入 pack 后，测试仍可让所有单元永久不前进

- **这是什么：** [contextPack:225](../src/engines/claude-api.js#L225) 先加入全部源码，再分配剩余空间给测试；[audit-post:739](../src/audit-post.js#L739) 只要任一候选测试不完整，就将该 unit 标成 unseen，并在 [759](../src/audit-post.js#L759) 排除状态推进。
- **问题：** 复用最新 [八单元预算回归的 fixture](../src/audit-units.test.js#L274)：250000 字节 pack、规则文件、八个分段源码及对应较大测试文件。实测源码截断 0 个，测试截断 8 个，unseen 单元 8 个，保存状态包含 0 个单元；下一轮仍选择完全相同的八个初始窗口。最新测试只断言 [源码没有截断](../src/audit-units.test.js#L292)，因此它可以通过，而整条轮转链不前进。
- **最小修正：** 预算调度至少保证一个“源码窗口 + 审查所需测试上下文”可完成。最简单的起点是根据实际 pack 结果减少同批单元数并重新打包；仍装不下时采用明确可推进的测试范围策略，或返回需缩小范围的终止原因。不要通过忽略 cut 来伪造推进。
- **不修的后果：** 用户付费重复扫描同一内容，报告持续 incomplete；`scan_issue: true` 与新增游标仍不能兑现轮转进度。这是已有 fixture 下的实际失败，不是超大规模假设。

**验收：** 对同一 fixture 连续执行“inventory → pack → publisher state → 下次 inventory”，在有限轮次内看到已审查范围单调推进。允许诚实 incomplete，但必须能进展或给出可操作的不可推进原因；同时检查 source 与 tests，不再只检查 `src/` 前缀。

### F24 · P2 · 跨仓库报告写到目标 issue，下一轮却回源仓库读状态

- **这是什么：** action 的 [scan collector 环境](../action.yml#L140) 只提供源仓库 `GH_REPO` 和源 token；[loadPrior:295](../src/audit-collect.js#L295) 据此读取 issues。[publisher](../src/audit-post.js#L670) 另行使用 `ISSUE_REPO`、issue client 和带源仓库名称的 title。
- **问题：** mock 仅在 `org/reports` 放置合法历史 scan issue，源为 `org/source`。真实 `loadPrior` 只请求 `/repos/org/source/issues`，返回 null；即使显式传入 `ISSUE_REPO` 也无效。发布端能更新外部 issue，但下次收集仍从第一批候选开始。
- **最小修正：** collector 与 publisher 统一使用同一组状态地址：源仓库、issue 仓库、scope marker、完整 title 和对应 token。源代码读取仍使用源 token；当多个 target 共享 reports 仓库时不能只靠相同 scope marker 选 issue。
- **不修的后果：** 文档支持的集中 scan 部署持续重复首批内容，大仓库后续部分饥饿；若源仓库碰巧也有 scan issue，还可能读取与发布位置不同的状态。

**验收：** 同仓库与跨仓库均能读回刚写入的状态；两个 target 共用 reports、相同 scope、不同凭据时不能串状态；metadata 不可读继续遵守已有发布可见性保护。

## 4. 对既有修复的重新判断

| 既有工作 | 本轮判断 |
|---|---|
| F01/F13/F14：删除断言、表格迁移和断言词法规则 | 不重报已修复的旧输入；新问题不依赖撤回这些修复 |
| F02/F03/F17：skip、分类冲突与损坏来源 | 保留修复；F20/F21 发现的是另一条“unit 裁决失败”和“candidate 身份错配”路径 |
| F05/F15/F16：摘要 FP、一对一评分、机器完整性 | 保留修复；F19 表明 producer 本身还能写出错误 complete，grader 忠实读取仍会受影响 |
| F06/F07：版本失效、上下文 cut、分段游标 | 机制有用，但 F22/F23 证明版本与进度的组合保证仍不足 |
| F18：跨仓库 visibility | 保留边界保护；F24 是状态地址不一致，不是重新声称已有公开泄露 |
| F04/F09/F10/F11/F12 | counterexample 形状、execution 状态、issue freshness、standards 展示、build ID 均是进展；不能外推为语义精度、有效修复率或真实 pilot 已通过 |

本轮开始时的 [handoff](handoff-2026-10-15.md) 还记录了低置信模型 finding 抑制确定性 lead、真实 standards/pushdown canary、组织计费和真人 pilot 等未完项。共享工作区随后出现另一条修复分支；本文冻结在上述基线，**不评判或关闭随后分支上的修复**。

## 5. 如何继续找 unknown unknown

本轮的发现来自四种组合扰动：换版本不换路径、换预算不换游标、损坏一条输出但保持 JSON 合法、换需求身份但保持引用真实。它们说明下一轮应围绕不变量构造反例，不能只给每个已知 case 增加一个特判。

以下是待执行实验；除已关联 F19–F24 的部分外，不计入本轮确认缺陷。

| 要证伪的假设 | 反事实或故障注入 | 通过条件 |
|---|---|---|
| 有效引用必然属于正确义务 | 换 ID、换来源块、重复一条引用 | F21 的身份约束始终成立 |
| 信息更少不会得到更强结论 | 截断、读失败、丢 title、坏 citation、遗漏 unit 回答的组合 | 只能保留已证明部分或降低为 unknown/incomplete |
| 分段等价于一次完整审查 | 变预算、变版本、变排序、变候选测试，缺陷放在分界两侧 | 当前版本区间无洞；跨边界行为有上下文或明确限制 |
| 调度有进展就代表风险被审查 | 大测试、长期高风险文件、每天修改热点、重复确认 gap | 记录最老未审查年龄；可完成工作不会无限饥饿 |
| 找到测试文本即可否定缺测 | 相同字面量放入注释、skip、未调用 helper；wrapper 增加独立分支 | 无效文本不得把真实风险无条件压到不可行动层 |
| 可执行外观就是实际保护 | 不 await、runner 排除、条件跳过、错误环境、assertion 只检验 mock | 保持执行未知；仅在有运行证据时提升执行结论 |
| 重复模型结论意味着独立确认 | 同提示重复误报，对照独立反例与人工裁决 | 重复性与正确性分开统计 |
| 最后一次状态写入就是最新 | 旧 run 延迟发布、两次 scan 并发、读取后 issue 被更新 | 拒绝或明确标记过期写入，不覆盖新版本状态 |
| read-only 描述足以约束所有引擎 | 恶意 repo 文本、hook/MCP 配置、ctx 路径和工具权限组合 | 按真实 engine 能力测试边界，不靠 prompt 承诺 |
| 模型切换不改变质量样本分母 | 同批盲样分别跑 fast/full、失败/重试/摘要输出 | 先保留所有尝试与行动项，再分层报告质量和成本 |
| 时间上更早就是 shift left | PR 提示之后只有无关测试改动，或只修改需求以配合错误实现 | 需要相关、有效的保护或明确的人类需求决策 |

建议把这些性质加入已有测试文件。优先测试真实组件连接；不需要引入通用状态机框架、全语言解析器、向量数据库或更多模型调用来解决本轮确定性问题。

## 6. 实施顺序与 goal 的完成条件

### 第一批：阻止虚假完成

先修 F19、F20、F21。目标是：有遗漏时不缓存成功；坏 finding 不成为 clean 单元；需求身份不可替换。验收应同时跑错误输入与有效输入，确保没有简单地把所有结果一律降为 unknown。

### 第二批：让每次扫描有可验证的进展

处理 F22、F23、F24。最小交付是版本和布局绑定、源码与测试共同预算、统一状态地址。用固定 fixture 连续跑到完成，检查每轮输入、审查范围和保存状态；只对有真实进展的范围更新时间。先实现简单的减少批大小和失效重启，再根据测量决定是否需要更复杂调度。

### 第三批：验证原始四项目标

| 目标 | 发布前需要的直接证据 |
|---|---|
| 需求与测试审查 | 独立的需求 oracle；同一缺陷有“实现和测试一起错”“只改需求”“只改测试”等控制；来源冲突交由人裁决 |
| 缺失/弱单测 | 固定 SHA 的 holdout PR；有效 finding 的建议能让目标故障失败，并保留正确行为；等价重构不创造新义务 |
| coding standards confirmed | 故意违规与干净控制；真实命名检查的 failed/pending/unavailable/passed 与正确 head/merge SHA；未配置不能算 confirmed |
| 合理下推高层测试 | 至少一个真实逻辑案例，用同一组故障比较原测试与新 unit + 必需集成 smoke；记录执行时长和维护代价 |

### 第四批：证明投入有实际回报

沿用 [validation-plan](validation-plan.md) 的真人样本、独立标注、按 PR 聚类和样本不足不判通过原则，但结果解释必须分清三件事：发现是否正确、作者是否采取相关行动、行动是否形成有效保护。`addressed` 的代码变化代理不能代替第三件事。

完整记录每次运行及重跑成本、inline/file/summary 的全部可行动建议、人工核查分钟、相关测试结果和 QA 前后的缺陷信息。按 action SHA、model、配置、仓库和人类/agent 作者分层；留出未参与调优的样本，历史回放只使用引入缺陷当时已存在的材料。

验收阈值保持原文用途：validation plan 的 65% 是其继续试点门槛，design 的 80% 是讨论 blocking 前的门槛，二者不是同一个完成标准。当前仍应保持 advisory；测量缺陷逃逸需要后续观察，不能用这次静态审查承诺“保证没有未知缺陷”。

## 7. 验证记录

环境：Windows，Node `v26.11.1`；CI 配置为 Ubuntu / Node 22。本机结果不冒充 CI 或线上结果。第一次沙箱运行因临时 Git 仓库 `.git/config` 无法写入而失败，随后在获准的本地执行环境重跑。

先前共享工作区的相关回归为 467 tests、466 pass、0 fail、1 skip；由于工作区随后变化，本轮另建独立工作树冻结 `a90608c`，重新运行探针及以下测试，最终以冻结工作树结果为准：

```sh
node --test --test-reporter=tap --test-concurrency=3 src/audit-units.test.js src/audit-code.test.js src/audit-post.test.js src/preflight.test.js src/claude-api.test.js src/post.test.js eval/grade.test.js
```

冻结基线回归结果：**467 tests；466 pass，0 fail，1 skip，0 todo；退出码 0，约 74.1 秒。** 七个反例探针也在该基线上全部复现。

| 探针 | 真实调用链或函数 | 实测结果 |
|---|---|---|
| P1 | inventory → stateOf → 修改文件 → inventory → stateOf，走完三段 | 新第 1 行未重审，最终 covered |
| P2 | 同版本，max_units 12 → 1 | 1–120 后直接 201–400，121–200 未读 |
| P3 | loadPrior + mock fetch | 只读 org/source；org/reports 中的历史状态未读到 |
| P4 | validate → verify，两个 candidate ID 引用同一 B.md | 两条 covered，零校验提示 |
| P5 | 真实 scan publisher + mock issue API | 坏 finding 被删除，status complete，保存 covered |
| P6 | 真实 PR publisher → 真实 preflight | pack cut 仍 complete / clean / head marker，下次 skip |
| P7 | 最新八单元 fixture：inventory → contextPack → stateOf → inventory | 源码 cut=0，测试 cut=8，unseen=8，状态无推进，下轮相同窗口 |

P1/P2/P7 直接连接生产函数并采用 publisher 当前的状态筛选规则；P5/P6 调用了完整 publisher。所有 API 都是 mock。探针断言通过表示**该反例存在**，不表示产品已经修复；冻结基线上的完整脚本附后。

**Verdict:** 优先修复 F19–F21 的错误完成结论，再打通 F22–F24 的状态和进度；之后用真实 standards、pushdown 与独立真人样本关闭目标。

**Not checked:** 未全量运行所有仓库测试，未重新触发线上 GitHub Actions/Kite/付费模型，未验证组织计费、跨平台真实引擎隔离、真人采纳或 QA 缺陷下降。深读集中在收集/打包、证据校验、状态轮转、发布/preflight 与相关评估契约；其余引擎、安全边界和历史数据仅按范围抽查。六个发现不代表穷尽全部缺陷。

## 附录：可执行的反例脚本

将下列代码保存为仓库根目录的 `review-probes.cjs`，在上述固定基线执行 `node review-probes.cjs`。仅创建并清理系统临时目录下的合成 Git 仓库，不联网；需要 Node、Git，以及临时 `.git` 写权限。不要把“复现断言通过”用作修复后的验收通过标准；修复后应反转相关错误状态断言，并保留正常控制。

<details>
<summary>展开完整离线探针（不修改产品实现）</summary>

```js
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const audit = require('./src/audit-post');
const au = require('./src/audit-units');
const collector = require('./src/audit-collect');
const post = require('./src/post');
const preflight = require('./src/preflight');
const results = {};
const roots = [];
const empty = () => ({ requirements: [], not_requirements: [], not_reviewed: [], docs_reviewed: [], unit_findings: [] });
function fixture(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-new-review-'));
  roots.push(root);
  const git = (...args) => execFileSync('git', ['-c', 'core.autocrlf=false', ...args], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-q');
  for (const [name, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), body);
  }
  const commit = () => { git('add', '.'); git('-c', 'user.name=Review', '-c', 'user.email=review@example.invalid', 'commit', '-qm', 'synthetic review fixture'); return git('rev-parse', 'HEAD'); };
  const head = commit();
  const ctx = path.join(root, '.specguard-ctx'); fs.mkdirSync(ctx);
  const put = (name, value) => fs.writeFileSync(path.join(ctx, name), typeof value === 'string' ? value : JSON.stringify(value));
  return { root, ctx, git, head, commit, put };
}
function trackedState(row, head, prior = null, findings = []) {
  return audit.readState(audit.stateOf(head, empty(), prior, { date: '2026-10-15', code: {
    picked: [row.id], findings, carried: [], versions: new Map([[row.id, row.ver]]), parts: new Map(row.part ? [[row.id, row.part]] : [])
  } }).raw);
}
async function withEnv(values, fn) {
  const before = { ...process.env };
  try { Object.assign(process.env, values); return await fn(); }
  finally { for (const k of Object.keys(process.env)) if (!(k in before)) delete process.env[k]; Object.assign(process.env, before); }
}
async function run() {
  // P1: the cursor remains valid syntactically after its content version changes.
  const big = Array.from({ length: 600 }, (_, i) => `exports.function${i} = () => '${'x'.repeat(80)}';`).join('\n') + '\n';
  const f = fixture({ 'src/big.js': big });
  const inv = (head, prior, maxUnits = 1) => au.inventory({ cwd: f.root, head, prior, maxUnits, packBytes: 250000 });
  const first = inv(f.head).picked[0];
  const prior = trackedState(first, f.head);
  fs.writeFileSync(path.join(f.root, 'src/big.js'), big.replace('xxxxxxxx', 'yyyyyyyy'));
  const nextHead = f.commit(), nextInv = inv(nextHead, prior), next = nextInv.picked[0];
  const after = trackedState(next, nextHead, prior);
  assert.notEqual(next.ver, first.ver); assert.equal(next.part.k, 1);
  const finalRow = inv(nextHead, after).picked[0], finalState = trackedState(finalRow, nextHead, after);
  assert.equal(finalState.blocks[0].status, 'covered');
  results.P1_cursor_after_edit = { first: first.part, next: next.part, final: finalRow.part, versionChanged: first.ver !== next.ver, selectedStaleIds: nextInv.stale, finalState: finalState.blocks[0].status, changedLineRevisited: false };
  // Budget change alone changes what the same integer cursor means.
  const small = inv(nextHead, null, 12).picked[0];
  const smallState = trackedState(small, nextHead);
  const large = inv(nextHead, smallState, 1).picked[0];
  assert.ok(large.part.a > small.part.b + 1);
  results.P2_cursor_after_budget_change = { first: small.part, next: large.part, neverRead: [small.part.b + 1, large.part.a - 1] };
  // P3: the public state loader queries the source despite an external issue destination.
  const requests = [];
  const external = { number: 7, state: 'open', user: { type: 'Bot', login: 'github-actions[bot]' }, title: audit.scopeOf('', 'org/source').title, body: audit.MARK + '\n' + audit.stateOf('abc1234', empty()).raw };
  const fetchFn = async (url) => {
    requests.push(url);
    const data = url.endsWith('/user') ? null : url.includes('/repos/org/reports/issues?') ? [external] : [];
    return { ok: !url.endsWith('/user'), status: url.endsWith('/user') ? 403 : 200, json: async () => data };
  };
  const loaded = await collector.loadPrior({ GH_REPO: 'org/source', GH_TOKEN: 'synthetic', ISSUE_REPO: 'org/reports' }, fetchFn);
  assert.equal(loaded, null);
  results.P3_external_state = { requests, foundPrior: !!loaded, expectedDestination: 'org/reports' };
  // P4: a valid candidate id may cite a different admitted requirement entirely.
  const docFiles = { 'A.md': ['Negative amounts must be rejected.'], 'B.md': ['Positive amounts must be accepted.'], 'src/amount.js': ['exports.validAmount = amount => amount > 0;'], 'test/amount.test.js': ['assert.equal(validAmount(10), true);'] };
  const cite = (p) => ({ path: p, line: 1, quote: docFiles[p][0] });
  const candidates = audit.readCandidates('aaaaaaaa\tA.md:1\tNegative\tNegative amounts must be rejected.\nbbbbbbbb\tB.md:1\tPositive\tPositive amounts must be accepted.\n');
  const row = (id) => ({ id, text: docFiles['B.md'][0], source: cite('B.md'), class: 'unit', status: 'covered', code: [cite('src/amount.js')], tests: [{ ...cite('test/amount.test.js'), layer: 'unit' }], note: '' });
  const data = { ...empty(), docs_reviewed: ['A.md', 'B.md'], requirements: [row('aaaaaaaa'), row('bbbbbbbb')] };
  assert.equal(audit.validate(data, candidates, new Map()).ok, true);
  const verified = audit.verify(data, { read: p => docFiles[p] || null, cands: candidates, docs: new Set(['A.md', 'B.md']), tracked: new Set(Object.keys(docFiles)) });
  assert.equal(verified.requirements[0].status, 'covered');
  results.P4_requirement_identity = { rows: verified.requirements.map(r => ({ id: r.id, source: r.source.path, status: r.status })), warnings: verified.not_reviewed };
  // P5: malformed findings are dropped, then the production publisher records every unit as covered.
  const s = fixture({ 'src/amount.js': 'exports.positive = v => v > 0;\nexports.negative = v => v < 0;\nexports.zero = v => v === 0;\n' });
  const id = au.sha8('src/amount.js');
  s.put('audit-meta.json', { head: s.head, max_requirements: 80, units: { total: 1, picked: 1 }, docs: 0, candidates: 0, rotation: { rotate: true, picked: 0 }, limitations: [] });
  s.put('audit-units.txt', `${id}\tsrc/amount.js\t10\tno test\tnone\t-\tabcdef12\t-\n`);
  s.put('audit-inventory.json', { units: 1, max_units: 1, selected: { units: 1, without_tests: 1 }, rotation: { picked: 1, total: 1, reviewed: 1 }, rows: [{ id, path: 'src/amount.js', score: 10, tests: [], why: 'no test' }], unreviewed: [] });
  s.put('engine-status', 'success'); s.put('pack-cut.txt', '');
  s.put('findings.json', { ...empty(), unit_findings: [{ unit: id, kind: 'missing_test', path: 'src/amount.js', line: 1, quote: 'exports.positive = v => v > 0;' }] });
  let issueBody = '', summary = ''; const outputs = {}, warnings = [];
  const github = { paginate: async fn => fn(), rest: { users: { getAuthenticated: async () => { throw Error('job token'); } }, issues: { listForRepo: async () => [], create: async a => { issueBody = a.body; } } } };
  const core = { setOutput: (k,v) => { outputs[k] = v; }, warning: s => warnings.push(s), summary: { addRaw(s) { summary = s; return this; }, async write() {} } };
  await withEnv({ CTX: s.ctx, GITHUB_WORKSPACE: s.root, SCAN_ISSUE: 'true', ISSUE_REPO: '', SKIP: 'false', ENGINE: 'claude' }, () => audit({ github, core, context: { repo: { owner: 'org', repo: 'source' }, sha: s.head } }));
  const publishedState = audit.readState(issueBody);
  assert.equal(outputs.status, 'complete'); assert.equal(publishedState.blocks[0].status, 'covered');
  results.P5_invalid_finding = { outputs, state: publishedState.blocks[0].status, validationVisible: summary.includes('path, line, quote and title are required'), warnings };
  // P6: PR context omissions do not affect a clean report's completeness or the cache marker.
  const p = fixture({ 'src.js': 'exports.total = x => x + 1;\n', 'test.js': 'assert.equal(total(1), 2);\n' });
  const b = { path: 'src.js', line: 1, quote: 'exports.total = x => x + 1;' };
  p.put('files.txt', 'src.js\n');
  p.put('diff.patch', 'diff --git a/src.js b/src.js\n--- a/src.js\n+++ b/src.js\n@@ -1 +1 @@\n-exports.total = x => x;\n+exports.total = x => x + 1;\n');
  p.put('test-candidates.txt', 'src.js\ttest.js\n');
  p.put('pack-cut.txt', 'src.js\ntest.js\n'); p.put('engine-status', 'success');
  p.put('requirements-status.json', { status: 'available', sources: ['PR body'], limitations: [], criteria: [] });
  p.put('findings.json', { requirements: [], requirements_source: 'PR body', not_reviewed: '', coverage: [{ id: 'O1', obligation: 'Increment the input', source: 'from behaviour', behaviour: b, change: b, evidence: [{ path: 'test.js', line: 1, quote: 'assert.equal(total(1), 2);', layer: 'unit', kind: 'assertion', proves: 'Increments one.' }], status: 'covered', reason: 'The assertion checks the increment.', alignment: { status: 'not_applicable', reason: 'No explicit requirement.' } }], findings: [], standards: { status: 'no_rules', sources: [], reason: 'No rule files.' }, layering: { status: 'checked', reason: 'No higher-layer tests.' } });
  let prSummary = ''; const prOutputs = {}, prWarnings = [];
  const pr = { state: 'open', title: 'Increment input', body: '', head: { sha: p.head }, user: { login: 'dev', type: 'User' } };
  const gh = { paginate: async (fn, args) => (await fn(args)).data, graphql: async () => ({ repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [] } } } }), rest: { users: { getAuthenticated: async () => { throw Error('job token'); } }, pulls: { get: async () => ({ data: pr }), listReviewComments: async () => ({ data: [] }), listFiles: async () => ({ data: [] }) }, issues: { listComments: async () => ({ data: [] }), createComment: async a => { prSummary = a.body; return {}; } } } };
  const pc = { setOutput: (k,v) => { prOutputs[k] = v; }, warning: s => prWarnings.push(s), summary: { addRaw(s) { prSummary = s; return this; }, async write() {} } };
  await withEnv({ CTX: p.ctx, GITHUB_WORKSPACE: p.root, HEAD_SHA: p.head, ENGINE: 'claude', MODEL: 'claude-sonnet-4-6', SKIP: 'false', PARTIAL: 'false', DELIVERY: '', STANDARDS_CHECKS: '', STANDARDS_REF: 'head', RESOLVE_STALE: 'false' }, () => post({ github: gh, core: pc, context: { repo: { owner: 'o', repo: 'r' }, serverUrl: 'https://github.com', payload: { pull_request: { ...pr, number: 1 } } } }));
  const counts = JSON.parse(fs.readFileSync(path.join(p.ctx, 'counts.json'), 'utf8'));
  const skip = preflight.decide({ pr, headSha: p.head, comments: [{ user: { type: 'Bot', login: 'github-actions[bot]' }, body: prSummary }] });
  results.P6_PR_pack_cut = { outputs: prOutputs, complete: counts.complete, execution_complete: counts.execution_complete, cleanVerdict: prSummary.includes('No unit test gaps found'), headMarker: prSummary.includes(`<!-- specguard:head=${p.head} -->`), nextRunSkip: !!skip, warnings: prWarnings };
  assert.equal(prOutputs.status, 'complete'); assert.equal(counts.execution_complete, true); assert.ok(skip);
  // P7: reproduce the latest source-packing fixture, but follow the actual state advancement rule.
  const packedFiles = { 'docs/rules.md': '# Rules\n' + '- keep functions small and tested\n'.repeat(300) };
  for (let u = 0; u < 8; u++) {
    packedFiles[`src/js/u${u}.js`] = Array.from({ length: u < 4 ? 3500 : 330 }, (_, i) => `exports.f${i} = ${u < 4 ? i : `(x) => x + ${i}; // ${'pad '.repeat(40)}`};`).join('\n') + '\n';
    packedFiles[`test/u${u}.test.js`] = [`const u = require('../src/js/u${u}');`, "it('works', () => { assert.equal(u.f1, 1); });", ...Array.from({ length: 700 }, (_, i) => `// ${'filler '.repeat(4)}${i}`)].join('\n') + '\n';
  }
  const pf = fixture(packedFiles), packInv = au.inventory({ cwd: pf.root, head: pf.head, maxUnits: 8, packBytes: 250000 });
  au.write(pf.ctx, pf.head, 8, packInv); pf.put('standards.txt', 'docs/rules.md\n');
  const packed = require('./src/engines/claude-api').contextPack(pf.ctx, pf.root, 250000), cuts = new Set(packed.notWhole);
  const unseen = packInv.picked.filter(u => cuts.has(u.path) || u.tests.some(t => cuts.has(t)));
  const seen = packInv.picked.filter(u => !unseen.includes(u));
  const state = audit.readState(audit.stateOf(pf.head, empty(), null, { date: '2026-10-15', code: { picked: seen.map(u => u.id), findings: [], carried: [], versions: new Map(seen.map(u => [u.id, u.ver])), parts: new Map(seen.filter(u => u.part).map(u => [u.id, u.part])) } }).raw);
  const again = au.inventory({ cwd: pf.root, head: pf.head, maxUnits: 8, packBytes: 250000, prior: state });
  assert.equal(cuts.size, 8); assert.equal(unseen.length, 8); assert.equal(state.blocks.length, 0);
  assert.deepEqual(again.picked.map(u => [u.id, u.part]), packInv.picked.map(u => [u.id, u.part]));
  results.P7_scan_stall = { sourceFilesCut: packed.notWhole.filter(p => p.startsWith('src/')).length, testFilesCut: cuts.size, unseenUnits: unseen.length, stateBlocks: state.blocks.length, samePartsNextRun: true };
  console.log(JSON.stringify(results, null, 2));
}
run().catch(e => { console.error(e.stack); process.exitCode = 1; }).finally(() => {
  for (const root of roots) {
    const resolved = path.resolve(root), temp = path.resolve(os.tmpdir()) + path.sep;
    if (!resolved.startsWith(temp) || !path.basename(resolved).startsWith('sg-new-review-')) throw Error('unsafe cleanup path');
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});

```

</details>
