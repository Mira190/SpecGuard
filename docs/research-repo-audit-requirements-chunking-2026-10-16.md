# 全仓 unit-test audit、需求识别与大仓库 chunking 调研

What this repo does: SpecGuard 通过静态阅读需求、源码和测试，在 QA 前提示可行动的单元测试缺口。全仓 scan 要回答“哪些行为还缺可信证据”，PR review 要回答“本次变化新增或暴露了什么缺口”。本轮按 monorepo、多份需求文档、共享测试 helper、较大源码和受限模型上下文审查；只交付研究与反例，不修改运行时代码。

日期：2026-10-16，Australia/Sydney。代码基线：`origin/main` **`ee1c15812bae4315f39ce7d5bf1bf7511ac58553`**；工作分支在此前文档提交 `c2f056f` 之后，运行时代码与该 main 相同。重新 fetch 确认基线；#198 最新 head 仍为 `c77841d`，本文引用它的结果来自[上一轮固定版本复验](full-repo-shift-left-audit-2026-10-16.md)，没有声称重新执行了 #198 的全部测试。

## 1. 结论先行

**大仓库需要可续跑的任务划分，但不应直接按固定行数切完就分别让模型下结论。** 一个最小审查任务要同时带上行为、适用需求、实现及依赖、相关断言与测试前置条件。缺其中一项应能留下 unknown 和可追踪原因；文件全读过、JSON 返回成功、运行次数足够，都不能替代这件事。

本次得到 **7 项新增的确认发现 F30–F36**，其中 F35 是已声明规模上限对 full-repo goal 的实证限制，F36 是已声明映射启发式在 monorepo 下的反例。另用真实 collector 产物补强此前 F28，并纠正原报告对 YAML 样本来源的描述。全部 8 个 probe 都不调用模型、不访问真实 GitHub API。

最值得优先处理的 unknown unknown 不在模型推理内部，而在三个容易被误认为已经完成的步骤：

- 文档被发现，不代表其中所有真实需求进入候选集合。
- 找到了测试文件，不代表它属于这个 package、实际约束这个行为，或它的 helper 仍有效。
- 每个 chunk 都完成，不代表跨 chunk 的前置条件、契约和当前版本已经一起审过。

## 2. 外部研究支持什么，不支持什么

以下只使用论文或项目官方文档。旧论文用于建立待检验假设，**不拿它们推断 2026 年某个模型的具体窗口、准确率或最优 chunk 大小**。

| 一手来源 | 可以支持的判断 | 对 SpecGuard 的推论与限制 |
|---|---|---|
| [Lost in the Middle，TACL 2024](https://aclanthology.org/2024.tacl-1.9/) | 所测 QA/检索任务中，证据位置影响模型使用长上下文的效果 | 不能把“装得下”当成“理解完整”；需做证据位置置换实验。论文不是 code-review 质量实验 |
| [RULER，COLM 2024](https://arxiv.org/abs/2404.06654) | 单条 needle 检索不足以评价多跳关联、聚合等长上下文能力 | 审查评估要测“需求→实现→测试”的多跳证据，不只测能否找到一行；其模型样本不能直接代表当前生产模型 |
| [RepoCoder，EMNLP 2023](https://aclanthology.org/2023.emnlp-main.151/) | 仓库信息分散在多文件，迭代检索能帮助其代码补全任务 | 支持检索后扩展相关上下文的方向；不能把补全收益换算成 SpecGuard 漏检率下降 |
| [Anthropic：Effective context engineering，2025](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) | 精选上下文、按需检索、压缩和持久笔记有不同成本与失真风险 | 先用现有搜索和轻量任务状态，不需要立即引入向量库或多 agent；纯 API pack 没有工具，不能照搬 agent 的补读能力 |
| [Cucumber Gherkin Reference](https://cucumber.io/docs/gherkin/reference/) | Scenario 使用 Background 的前置条件；Rule、Examples 和语言声明有结构语义 | 分块要保留继承上下文与实例参数，不能把 scenario 的局部原文视为完整契约 |
| [Stryker：mutant states and metrics](https://stryker-mutator.io/docs/mutation-testing-elements/mutant-states-and-metrics/)；[PIT：basic concepts](https://pitest.org/quickstart/basic_concepts/) | 执行覆盖和能杀死变异不同；等价变异、运行错误也不能简单当成缺测试 | 在受控回放中使用行为变异检验断言强度，区分 survived、no coverage、invalid、equivalent；不要要求全仓一律追求 100% mutation score |
| [Bazel query guide](https://bazel.build/query/guide#reverse-dependencies) | 已有构建图可以查询反向依赖 | 若采用者已有可靠图，复用它做受影响测试/调用方扩展；这不是要求所有项目迁移 Bazel |
| [OpenAPI 3.1.1 规范](https://spec.openapis.org/oas/v3.1.1.html) | HTTP API 契约可由机器可读接口描述表达 | 需求来源不应等同于 Markdown 中的 MUST。本轮引用固定规范版本说明输入形态，不主张它是最新版本 |

## 3. 当前系统实际在做什么

`trace.discover → parseItems/blocksOf → audit-collect.select/evidence → audit-units.inventory → prompt/contextPack/scan-parts → validate/verify → state/发布` 是本轮追踪的链路。源码、测试映射和调度被共同检查；不是只看 prompt。

| 环节 | 当前实现与上限 | 对全仓审查的含义 |
|---|---|---|
| 文档发现 | `trace.js` 支持 MD/MDX/RST/ADOC/TXT/feature；自动发现结合位置、名称和规范性内容，显式路径可强制准入；候选 2000、准入 500、普通文件 256 KiB、解析字节预算 48 MiB | “未发现需求”不是“仓库没有需求”；格式不支持、预算未读、过滤为数据应分别记账 |
| scan 文档集合 | `audit-collect.js:16,228` 最多 60 份，再从其 block 集合轮转；默认每轮至多 80 block | 文档准入和 block 轮转是两层，后者不能自动补回前者未准入的文档 |
| 需求正文 | candidate 文本 240 字符、检索文本最多 600 字符、block 正文最多 4000 字符 | 摘要不能承担完整契约身份；否定、例外、单位、表头可能在被截掉部分 |
| code-first inventory | `audit-units.js:13,89–90`：源码 ≤512 KiB、至少 3 个非注释行；最多读取按路径排序的 6000 源文件 | 最大文件被过滤后，后面的分片机制根本见不到它；6000 上限不是“下一轮自动续读” |
| 测试发现/映射 | 最多读取 4000 测试文件、每文件 512 KiB、总量约 48 MiB；每 unit 最多 20 个候选；名称、调用词和路径启发式 | 输入排名的候选不是执行覆盖集合；未读测试已经有 limitation，但不能等价推断其无断言 |
| 当前分片 | main 的大 unit 按约 40 KiB 推导固定行窗口；block 数量超过 batch 才产生多调用计划 | `scan-parts.js:15,47` 的 code-first units 仍集中在一个 unit call；0 个文档 block 不会因为源码多就自动分成多个调用 |
| 模型语义边界 | API 模式只有 pack；agent 模式可用只读文件工具 | “请继续读文件”不能补救 API pack 缺证据；两种模式必须共享完整性语义，而不是共享一句补读提示 |

这些是限制清单，不把每个上限都当成 bug。下面只列有具体反例、能影响本次目标的发现。

## 4. Must fix：新反例

### 1. [P1] F30：短但完整的需求在进入候选前消失

- **What this is:** `src/trace.js:297,359–364` 用 `MIN_BLOCK=20` 过滤 block，先于后面的规则解释。
- **Problem:** `AC-1: Reject zero.` 和 `必须拒绝负数。` 都被 parseItems 识别为 1 项，却都变成 `admitted=0, ruled=0`。不是模型认为它们不构成需求，而是它们没有机会进入审查，也没有进入 ruled 清单。
- **Fix:** ID、验收项和明确约束不套用粗略长度拒绝；对描述性短片段保留上下文再分类。任何拒绝必须留下原因，区分“没有需求”与“过滤掉需求”。
- **If we skip it:** 简洁 AC 和非英语需求会系统性漏检；要求作者写更长句子不会提高需求质量。

证据：Q1。这里只证明上述中英文例子；不声称完整覆盖所有语言的需求语法。

### 2. [P1] F31：真实阈值表被数值占比规则排除

- **What this is:** `src/trace.js:323,349–355` 以 numeric-cell share 判断数据表；行自身没有英文 must/shall/should/will 时，表头契约语义不会阻止排除。
- **Problem:** `Subscription | Maximum requests per minute | Burst limit` 下的 `Starter subscription | 10 | 20` 和 `Enterprise subscription | 100 | 200` 两行均被标记为 `results/data table row`，候选数为 0。这是接口限流契约，不是测量结果。
- **Fix:** 行与表头、单位、上级标题一起分类；纯数值占比仅作为排序线索。显式 requirements_paths 中的疑似约束表优先保留待判，不能直接作为已排除的无需求数据。
- **If we skip it:** 最适合生成边界单元测试的数值约束恰好消失，后续再好的检索和模型都无从补救。

证据：Q2。排除原因可见，因此它不同于 F30 的无 ruled 记录；但可见的错误排除仍会损害目标。

### 3. [P1] F32：Gherkin 分块丢失继承前置条件，修改它也不改变 scenario 身份

- **What this is:** `src/trace.js:239–259` 单独输出 scenario 原文；`audit-collect` 用局部 block 计算 cid，`scan-parts` 只带本批 block 的正文。
- **Problem:** 21 个 scenario 共享 Background，使用默认 batch=20。把租户前提从 `SUSPENDED_TENANT` 改为 `ACTIVE_TENANT`，最后一个 scenario 的 cid 不变；该 scenario 所在 part 的 prompt 和 pack 都没有此前提，`blockCuts={}`。
- **Fix:** 为 scenario 附加适用的 Feature/Rule/Background、继承标签及 Examples 绑定，内容版本包含这些依赖。不要只扩大一个固定重叠窗口来猜测祖先位置。
- **If we skip it:** 同样“拒绝付款”的结果在不同租户状态下有完全不同的含义；局部 block 看似未变，实际契约已变。这里证明上下文缺失/身份不变，没有声称实跑模型必然误判。

证据：Q3，真实 collect 和 scan-parts。Background 对 scenario 的作用以 [Cucumber 官方规则](https://cucumber.io/docs/gherkin/reference/#background) 为依据；Background 自己另列一个候选并不能建立依赖关系。

### 4. [P1] F33：测试 helper 变弱不会使受影响 unit 的历史证据过期

- **What this is:** `src/audit-units.js:131` 的版本只包含源码和已匹配测试文件的 blob，没有这些测试的依赖。
- **Problem:** `amount.test.js` 调用 `helpers/check.js` 的 verifyExact；helper 从 `assert.equal(actual, expected)` 改为 `assert.ok(actual)`。amount 的测试文件未变，unit ver 不变、changed 优先级为 0、stale 清单为空；同次新增 unit 被先选中，helper 又不是 code-first unit。
- **Fix:** 至少把已识别的测试 helper、fixture、setup 和相关配置纳入证据依赖哈希；解析不了依赖时，以受影响 package 范围保守失效，不应标成版本仍可信。优先复用项目已有依赖信息。
- **If we skip it:** 原来的精确断言已不再约束错误值，但历史 covered 可能长期保留。不是声称永远不再审，问题是失去了应有的变更优先级和过期提示。

证据：Q4。无需先构建通用全语言调用图；先覆盖本项目实际使用的简单 import/require/helper 形式，并明确剩余 unknown。

### 5. [P1] F34：较大源码在分片前已被静默排除

- **What this is:** `src/audit-units.js:89` 在构造 unit 之前过滤 `e.size > 512 KiB`，`partOf` 只作用于剩余 unit。
- **Problem:** 627,780-byte 的普通 `src/large.js` 在受控 Git 样本中产生 `units=0, limitations=[]`。把 chunk 调小、增加运行轮数或增大 max_units 都不会使这个文件进入分片。
- **Fix:** 至少记录超限源码的路径、大小和未审状态；确需全仓覆盖时对其安全分段读取/建索引，再按语义划分任务。生成文件可按明确规则排除，不能用大小替代“非产品代码”。
- **If we skip it:** 大仓库里最需要分块的文件反而不在审查分母中，“没有 unit 可审”会掩盖实际未审范围。

证据：Q5。样本是构造的有效源码集合，证明上限行为；没有声称实际采用者已出现某个同尺寸生产缺陷。

## 5. Should fix：已声明边界在目标负载下的问题

### 6. [P2] F35：block 轮转无法遍历第 61 份需求文档

- **What this is:** `audit-collect.js:228` 先取固定前 60 份文档，之后才依据 prior state 选择 block。
- **Problem:** 61 份显式匹配的需求文档，两轮都只准入同样的 60 份，第 61 份留在 rejected。代码顺序可进一步推导：固定 tree/config 下，更新已准入 block 的状态不能让尾部文档进入候选全集。
- **Fix:** 让文档准入也有可续跑页/轮转，或把 package scope 明确分区并记录各分区完成情况。报告同时列 eligible 总数、准入数、排除数、待扫描数。
- **If we skip it:** 轮转完成只表示前 60 份完成，不能代表全仓。当前已有显式 over-limit 提示；本项是全仓 goal 的规模缺口，不把它包装成隐藏异常或无限轮次实测结果。

证据：Q6。源码 6000 上限也位于风险排序之前，具有类似的准入边界；本轮没有构造 6001 文件压测，将其列为下一阶段验收条件。

### 7. [P2] F36：其他 package 的同名测试填满 cap，挤掉更相关的候选

- **What this is:** `src/test-map.js:64–83` 先收 same-name 测试，再处理调用多个公开符号的测试；scan 每 unit cap=20。
- **Problem:** 对 `packages/z/src/ledger.js`，其他 20 个 package 各有一个 ledger.test.js；本 package 的 account-behaviour.test.js 调用两个公开方法。mapTests 收下 20 个外部同名文件，后者被 cap 排除。
- **Fix:** 在最终截断前综合 package/import/call 关联排名；同名只是信号，不是强于所有调用证据的硬优先级。若不得不裁剪候选，记录“搜索不全”，保持相关测试存在性未知。
- **If we skip it:** monorepo 的常见重复命名会浪费上下文并漏掉真正测试。模型有工具时或可补搜，API pack 没有这条补救路径；反例证明候选丢失，不直接证明某次模型误报。

证据：Q7。仓库已注明名称搜索的局限；新增的是实际达到 cap 时强候选被弱候选排挤的组合反例。

## 6. 对上一报告 F28 的证据更正与补强

上一报告的 N4 手工写入 `audit-evidence.txt`，用 YAML 样本验证单批/多批打包路径的差异。**它不证明 collector 自动找到了 YAML**；`audit-collect.js` 的 NOT_EVIDENCE 实际排除 YAML/JSON 等文件。因此原文“evidence search 已明确找到了它”不准确，本次在原报告同步更正。

Q8 现在从真实 collector 开始：需求要求 validator 在扣款前拒绝负数；code-first 的 max_units=1 选中了另一个风险更高的模块。collector 确实将 `billing/validator.js` 放入需求 evidence；默认单批 pack 却没有其正文，`notWhole=[]`。所以 **F28 的核心问题仍成立**，不再依赖不符合自动检索规则的输入。

这个更正也说明：测试某个下游函数接受手工 payload，不等于证明真实上游会产生该 payload。今后的 unknown-unknown 反例，应优先经过真实 producer → consumer，并明确缩小后的模型/网络边界。

## 7. 需求识别应该保留的结构

需要把“找到文档”“找到候选”“确认适用契约”“关联代码/测试”分成可观察的步骤；它们可以继续使用现有文件和函数，不需要先建一个新平台。

| 层次 | 最小信息 | 不能偷换成什么 |
|---|---|---|
| 文档清单 | commit/blob、path、格式、scope、来源方式、未读/超限原因 | 文件名像 spec 不等于权威 oracle |
| 原子行为 | 主体、触发条件、预期结果、否定、边界/单位、例外，以及原文位置 | 关键词命中不等于可测试；短句也不等于非需求 |
| 继承上下文 | 标题层级、表头与单位、Background/Rule、Examples 行、引用依赖 | 单行引用真实不等于完整语义真实 |
| 适用性 | package/产品版本、draft/accepted/superseded、契约来源与冲突 | 最近修改的文档不自动覆盖较早但仍有效的契约 |
| 身份与版本 | 可追踪身份 + 保留语义的内容版本 + 依赖版本 | lower-case/删标点后的 hash 不适合表示契约版本（前轮 F25） |
| 关联和结论 | 代码、测试、规则证据及未解决依赖；每条义务有已审/未知原因 | 没搜到不能推成不存在；覆盖一个正向例子不能覆盖另一个反向要求 |

自动发现保留路径/名称/内容三类线索；`requirements_paths` 用于补充和限定范围，不应被误解为“文件中的每句话都正确且现行”。对 draft、废弃 ADR、相互矛盾文档，应保留来源并要求明确的权威规则；没有规则时标 conflict/unknown，不让模型悄悄选一个版本。

结构化契约应独立评估：OpenAPI、JSON Schema、protobuf、GraphQL、数据库约束和配置默认值都可能表达行为。本轮确认默认发现偏重文本，未实现这些格式的通用语义识别；也没有证明“显式传入它们绝对无法准入”。建议先用真实采用者样本统计占比，再选最常用的一两种格式做适配，保留 `$ref`/引用和版本。不要靠把整份 YAML 转成自然语言摘要来丢失约束。

没有独立需求来源时，仍能审查边界、异常路径和断言强度，但不能把“代码与测试相同”升级为“符合业务意图”。需求冲突、未发现、解析不支持、预算未读、明确不适用应分别展示。

## 8. 全仓 unit-test audit 应审什么

审查对象应该是**可观察行为**，不强求每个私有函数都有独立测试。一个 unit 的候选证据至少要回答：

1. 什么正常输入、边界、非法输入、错误传播、状态变化值得测试？只有与行为相关的维度进入本次任务，避免机械枚举。
2. 测试实际调用了哪个实现？同名文件、字符串命中和行覆盖只是候选信号；检查 import、间接调用和 package 边界。
3. 断言是否对一个合理错误实现会失败？同时检查 helper、fixture、setup、参数化案例、skip/only、异步等待和 mock 的作用；这些不是全部已发现的 bug，而是待验证矩阵。
4. 期望值来自需求/独立常量，还是再次调用实现算出来？即便测试可杀死某些变异，仍需判断 oracle 是否正确。
5. 较高层测试覆盖的纯逻辑是否能下沉？涉及真实事务、协议、序列化、框架 wiring 的契约可能仍需集成测试，不能为提高 unit 数量而删除。

静态结论、执行覆盖、变异结果是不同证据层。建议在可信、隔离的既有 CI/回放环境中选择少量高风险行为做 targeted mutation，验证 `>= → >`、返回值改变、异常吞掉等具体错误是否被阻止。等价变异和环境错误需分开记录，依据 [PIT 的限制说明](https://pitest.org/quickstart/basic_concepts/)；本次没有安装变异工具或执行被审查仓库的模型生成测试。

版本失效至少需要考虑：被审源码、相关测试、读到的 helper/fixture/setup、适用需求及其父上下文、规则和相关配置、分析器版本。不能只缓存“这个 SHA 曾经有过一句 covered”。依赖图不全时明确保守范围，避免声称精确增量。

## 9. 大仓库到底何时、怎样 chunk

### 9.1 先区分四种不同操作

| 操作 | 目的 | 完成后仍不能推出的结论 |
|---|---|---|
| Inventory 分页 | 枚举整个合格对象集合，避免固定前缀永远霸占名额 | 枚举过不等于审查过 |
| 检索窗口 | 从文件中定位候选证据，减少无关内容 | 搜索窗口不等于完整行为 |
| 审查任务分块 | 在预算内提供足够的行为与证据，得到局部结论 | 局部结论不等于跨边界一致 |
| 跨轮调度 | 在多次运行中推进剩余范围，并响应版本变化 | 多次运行不等于当前版本全部完成 |

当前实现主要有后两种的一部分。前一轮 F22/F23/F27/F28，加上本轮 F32/F34/F35，说明仅调整 `partBytes` 无法解决它们。

### 9.2 选择规则

| 情况 | 建议 |
|---|---|
| 一个行为及其必要证据能在预算中完整容纳 | 保持一个任务，不为追求统一尺寸强拆 |
| 单文件较大但函数/行为边界清楚 | 按函数/相关行为划分；共享 imports、类型、前置条件和调用接口作为支持上下文 |
| 同一行为跨多文件 | 同一任务优先带上相关调用方/被调方、契约和测试；文件数不是切分依据 |
| 单行为本身仍超预算 | 先建结构与依赖清单，再分阶段分析；保留 unresolved dependencies；增加一个跨阶段核对，不以各片的“无发现”自动得到 covered |
| 多 package 大仓 | 先 package/owner/domain scope 排队，再选行为任务；共享库变化触发消费者检查，不能把目录当成绝对语义边界 |
| 无需求文档的 code-first scan | 同样依据源码＋测试证据的总体积拆 unit calls，不能由文档 block 数量决定是否拆分 |

预算应以**整次实际请求**计算：模型允许输入空间减去 system、schema、输出预留和安全余量，再受到本次费用/时间限额约束。250,000 bytes 不是固定数量的 tokens；不同语言、字符和正文结构不同，不能只把文件字节加起来就称请求安全。具体目标 token 大小通过下面的对照实验决定，不给一个未经测量的“最佳 2K/8K/32K”。

### 9.3 最小实现顺序

1. **先修真实性。** 保留被过滤/裁剪/未回答对象的清单；旧 cursor 绑定内容和布局，拒绝过期证据。沿用现有 state 格式能做的先做。
2. **给准入层可续跑能力。** 文档和源码集合按确定性顺序分页，记录 eligible/visited/excluded/remaining；优先级可以改变顺序，不能永久改变全集。记录分区是否穷尽。
3. **补齐当前任务的支持上下文。** requirement 父结构、被匹配测试的 helper 和本 package 关联先补；使用现有词法/路径索引和简单依赖提取即可起步。已有构建图的仓库再接其反向依赖。
4. **让 block 和 unit 共用预算规则。** 一个任务超限时分拆独立行为；每个子任务显式返回 assessed、unresolved、evidence ranges 和 version。单任务与多任务路径遵循同样的 evidence completeness。
5. **最终归并只做有证据的事。** 按 obligation 身份去重，保留冲突、失败、未完成和跨块依赖；共同 chunk 的只读支持上下文不重复计入“已审业务范围”。需要跨边界再审时建明确任务，不让 reducer 从摘要猜结论。

不建议现在直接增加：全语言 AST 服务、向量数据库、永久图数据库、多 agent 编排、任意百分比固定 overlap。它们可能有价值，但应由实际失败样本和收益证明。检索词法不足时再评估 embedding/reranker；纯函数边界提取不足时再为主要语言引入成熟 parser。后者是按证据增量，不是依赖永远为零。

一个最小任务记录可以继续作为 JSON 文件保存：`snapshot、scope、primary obligation/range、supporting refs+hashes、analyzer/layout version、未解决依赖、result state`。失败和预算耗尽保持待审；最终判断必须针对同一版本的义务全集。先以简单、可恢复的单进程调度验证，不以并发复杂度替代正确性。

## 10. 用实验决定是否升级 chunking

对同一固定 corpus、同一模型/参数和总预算，比较：A 当前 pack，B package＋行为分块，C B＋依赖补读。先离线检查结构不变量，再在另行授权的真实模型评估中比较效果；本次没有执行 B/C 产品实现或付费模型评测。

| 维度 | 必须包含的反例/对照 | 核心指标 |
|---|---|---|
| 需求发现 | 本轮短中英文 AC、数值表；另补废弃 ADR、互相矛盾契约、结构化格式、否定和单位 | 文档发现 recall 与 block recall 分开；误排除率；不能只用入选候选做分母 |
| 测试质量 | helper 弱化、参数化、mock 返回固定值、代码和预期一起错、有效 helper 断言对照 | 行为缺口 precision/recall；误报修复时间；同名测试误关联率 |
| 边界与规模 | 60/61 文档、6000/6001 源文件、512 KiB 两侧；20/21 block；函数跨分片、无文档、多 package | inventory 穷尽性、版本一致性、每轮新增已审范围、尾部等待时间 |
| 上下文完整性 | 改 Background；移动证据到开头/中间/末尾；预算降低；同一行为拆到两文件 | 未读证据必须 unknown；证据位置/布局改变不应凭空提高 complete |
| 生命周期 | helper 或需求变更、分析器升级、分片布局改变、运行中断/重试 | 过期状态是否重新排队；是否重复计数；未完成是否被误记 covered |
| 真正 shift-left | 使用引入 PR 当时可得证据回放真实 QA 缺陷，正常 PR 作噪声对照 | QA 前可行动命中、实际采纳/确认修复、时延、token/费用；与离线代理指标分开 |

合并门槛先用确定性不变量：合格对象要有去向、短需求不能无记录消失、scenario 继承条件必须可见、helper 变化使依赖证据失效、裁剪不能提高 confidence、重复展示不增加 TP。模型 precision 的数值门槛应来自采用者噪声成本和基线，本文不杜撰已达成的百分比。

## 11. 验证记录与可复现材料

验证环境：Windows / Node v26.11.1；shell 相关测试把 Git Bash 放在 PATH 前端。相关测试在上述 main 运行时代码上执行，命令如下：

```powershell
$env:PATH = 'C:\Program Files\Git\bin;C:\Program Files\Git\usr\bin;' + $env:PATH
node --test --test-reporter=tap --test-concurrency=2 src/trace.test.js src/audit-collect.test.js src/audit-units.test.js src/test-map.test.js src/claude-api.test.js
```

这次组合运行在 1504546.7662 ms（约 25 分钟）后，主动停止了仍未结束的 trace 子进程。其他四个文件的 **107 项测试通过**；runner 原始汇总为 **108 tests / 107 pass / 1 fail / 0 cancelled / 0 skipped / 0 todo**，其中唯一 fail 是被停止的 `src/trace.test.js` 文件级 `ERR_TEST_FAILURE`。这不是已定位的产品断言失败，也不能把未结束的 trace 回归记为通过。

随后对 trace 中与需求解析直接相关的用例单独验证：

```powershell
node --test --test-reporter=tap --test-name-pattern='^(parseItems|blocksOf|isRequirementDoc|isSpecDoc)' src/trace.test.js
```

结果：**22 tests / 22 pass / 0 fail / 0 cancelled / 0 skipped / 0 todo**，5321.8197 ms。另外，8 个独立缺口 probe 全部复现。现有用例通过与这些缺口并不矛盾：它们没有阻止附录展示的行为。

验证范围是四个完整测试文件＋trace 的 22 项指定解析用例＋8 个反例；**本轮未完成完整 trace 的 Git/CLI 回归，也未重跑全仓所有测试**，没有把上一轮全套测试计数当成此次结果。没有修改产品代码、安装依赖、调用真实模型或写入真实 GitHub 评论；并未验证产品发现已经修复。

附录脚本保存到上述基线根目录，以 `node audit-research.cjs` 执行；它创建有边界检查的临时 Git fixture 并清理。对错误行为的 assert 成功只代表复现成功，不代表产品已修复。Q7 直接隔离 mapper 输入；其余需 Git 的 probe 使用真实相关 producer/consumer。它们没有代表全部真实仓库分布，也不是性能 benchmark。

<details>
<summary>完整复现脚本（Node.js + Git，无新增依赖）</summary>

```javascript
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { execFileSync } = require('node:child_process');
const assert = require('node:assert/strict');
const T = require('./src/trace'), A = require('./src/audit-collect'), U = require('./src/audit-units');
const P = require('./src/engines/claude-api'), S = require('./src/scan-parts'), M = require('./src/test-map');
const results = [];
const write = (d, p, s) => { const f = path.join(d, p); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s); };
const git = (d, ...a) => execFileSync('git', ['-c', 'core.autocrlf=false', ...a], { cwd: d, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = d => { git(d, 'add', '.'); git(d, '-c', 'user.name=Audit', '-c', 'user.email=audit@example.invalid', 'commit', '-qm', 'fixture'); return git(d, 'rev-parse', 'HEAD'); };
function fixture(files, fn) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-research-'));
  try { git(d, 'init', '-q'); for (const [p, s] of Object.entries(files)) write(d, p, s); commit(d); return fn(d); }
  finally { const real = fs.realpathSync(d), temp = fs.realpathSync(os.tmpdir()) + path.sep; assert(real.startsWith(temp) && path.basename(real).startsWith('sg-research-')); fs.rmSync(real, { recursive: true, force: true }); }
}
function check(id, fn) { try { results.push({ id, reproduced: true, ...fn() }); } catch (e) { results.push({ id, reproduced: false, error: e.stack }); process.exitCode = 1; } }
check('Q1-short-explicit-requirements', () => {
  const examples = ['# Rules\n\nAC-1: Reject zero.\n', '# 规则\n\n必须拒绝负数。\n'];
  const counts = examples.map(text => { const ruled = []; return { parsed: T.parseItems('specs/r.md', text).length, admitted: T.blocksOf('specs/r.md', text, ruled).length, ruled: ruled.length }; });
  for (const c of counts) { assert(c.parsed > 0); assert.equal(c.admitted, 0); assert.equal(c.ruled, 0); }
  return { counts };
});
check('Q2-threshold-table-filtered', () => {
  const text = '# Request rate contract\n\n| Subscription | Maximum requests per minute | Burst limit |\n|---|---|---|\n| Starter subscription | 10 | 20 |\n| Enterprise subscription | 100 | 200 |\n';
  const ruled = [], kept = T.blocksOf('specs/rate-limits.md', text, ruled);
  assert.equal(kept.length, 0); assert.equal(ruled.length, 2);
  return { kept: kept.length, rejected: ruled.map(x => ({ text: x.text, reason: x.reason })) };
});
check('Q3-gherkin-inherited-context', () => fixture({
  'specs/payment.feature': 'Feature: Payment approval\n\n  Background:\n    Given the account belongs to a SUSPENDED_TENANT\n\n' + Array.from({ length: 21 }, (_, i) => `  Scenario: Denied payment${i}\n    When the customer submits a payment\n    Then the request is rejected\n`).join('\n'),
}, d => {
  const h = git(d, 'rev-parse', 'HEAD'), before = A.allBlocks(d, h, ['specs/payment.feature']);
  const row = before.find(b => b.body.includes('Scenario: Denied payment20'));
  assert(row); assert(!row.body.includes('SUSPENDED_TENANT'));
  write(d, 'specs/payment.feature', fs.readFileSync(path.join(d, 'specs/payment.feature'), 'utf8').replace('SUSPENDED_TENANT', 'ACTIVE_TENANT'));
  const next = A.allBlocks(d, commit(d), ['specs/payment.feature']).find(b => b.body.includes('Scenario: Denied payment20'));
  assert.equal(next.cid, row.cid);
  const ctx = path.join(d, '.ctx'); A.collect({ cwd: d, ctx, reqPaths: 'specs/**', maxRequirements: 80 });
  const plan = S.plan({ ctx, root: d, batch: 20, limit: 250000, schemaFile: path.join(__dirname, 'src/audit.schema.json'), contextPack: P.contextPack, windowPack: P.windowPack, assembleAudit: require('./src/prompt').assembleAudit });
  const part = plan.parts.find(p => p.cids && p.cids.includes(next.cid));
  assert(part); assert(!part.prompt.includes('ACTIVE_TENANT')); assert(!part.pack.text.includes('ACTIVE_TENANT'));
  return { scenarioCidUnchanged: true, inheritedConditionInBody: false, inheritedConditionInPart: false, blockCuts: part.blockCuts };
}));
check('Q4-shared-test-helper-freshness', () => fixture({
  'src/amount.js': 'function amount(value) {\n  return value + 1;\n}\nmodule.exports = { amount };\n',
  'tests/amount.test.js': 'const test = require("node:test");\nconst { amount } = require("../src/amount");\nconst { verifyExact } = require("./helpers/check");\ntest("increment", () => { verifyExact(amount(2), 3); });\n',
  'tests/helpers/check.js': 'const assert = require("node:assert/strict");\nexports.verifyExact = (actual, expected) => {\n  assert.equal(actual, expected);\n};\n',
}, d => {
  const h = git(d, 'rev-parse', 'HEAD'), first = U.inventory({ cwd: d, head: h, maxUnits: 1 }).picked[0];
  assert.deepEqual(first.tests, ['tests/amount.test.js']);
  const prior = { head: h, blocks: [{ cid: first.id, status: 'covered', runs: 2, at: { date: '2026-10-16', head: h } }], versions: { uv: { [first.id]: first.ver }, ev: {} } };
  write(d, 'tests/helpers/check.js', 'const assert = require("node:assert/strict");\nexports.verifyExact = (actual, expected) => {\n  assert.ok(actual);\n};\n');
  write(d, 'src/new-entry.js', 'function newEntry(value) {\n  return value;\n}\nmodule.exports = { newEntry };\n');
  const next = U.inventory({ cwd: d, head: commit(d), maxUnits: 1, prior });
  assert.equal(next.rows.find(x => x.id === first.id).ver, first.ver); assert.equal(next.rotation.changed, 0); assert.equal(next.picked[0].path, 'src/new-entry.js'); assert.deepEqual(next.stale, []);
  return { tests: first.tests, versionUnchanged: true, changedPriority: next.rotation.changed, selectedInstead: next.picked[0].path, stale: next.stale, helpersInUnits: next.rows.some(x => x.path.includes('helpers')) };
}));
check('Q5-large-source-outside-universe', () => fixture({
  'src/large.js': Array.from({ length: 4500 }, (_, i) => `exports.fn${i} = value => value + ${i}; // ${'padding '.repeat(12)}`).join('\n') + '\n',
}, d => {
  const bytes = fs.statSync(path.join(d, 'src/large.js')).size; assert(bytes > 512 * 1024);
  const inv = U.inventory({ cwd: d, head: 'HEAD', maxUnits: 12 });
  assert.equal(inv.rows.length, 0); assert.equal(inv.limitations.length, 0);
  return { sourceBytes: bytes, units: inv.rows.length, limitations: inv.limitations };
}));
check('Q6-document-admission-does-not-rotate', () => {
  const files = Object.fromEntries(Array.from({ length: 61 }, (_, i) => [`specs/r${String(i).padStart(3, '0')}.md`, `# Contract ${i}\n\nAC-1: The account ${i} must reject duplicate transfers.\n`]));
  return fixture(files, d => {
    const ctx = path.join(d, '.ctx'); const first = A.collect({ cwd: d, ctx, reqPaths: 'specs/**', maxRequirements: 80 });
    const chosen = A.allBlocks(d, 'HEAD', first.docs);
    const prior = { head: git(d, 'rev-parse', 'HEAD'), blocks: chosen.map(b => ({ cid: b.cid, status: 'covered', runs: 2, at: { date: '2026-10-15', head: 'HEAD' } })), versions: { ev: {}, uv: {} } };
    const second = A.collect({ cwd: d, ctx, reqPaths: 'specs/**', maxRequirements: 80, prior, rotate: true });
    assert.equal(first.docs.length, 60); assert.deepEqual(second.docs, first.docs); assert(!second.docs.includes('specs/r060.md'));
    return { trackedRequirementDocs: 61, admitted: second.docs.length, tailEverSelected: false, explicitlyRejected: fs.readFileSync(path.join(ctx, 'audit-rejected.txt'), 'utf8').includes('specs/r060.md') };
  });
});
check('Q7-monorepo-name-collision-candidate-cap', () => {
  const source = 'packages/z/src/ledger.js', relevant = 'packages/z/qa/account-behaviour.test.js';
  const tests = [...Array.from({ length: 20 }, (_, i) => `packages/p${i}/tests/ledger.test.js`), relevant];
  const got = M.mapTests(source, { tests, per: 20, names: ['depositFunds', 'withdrawFunds'], calls: () => [relevant], mentions: () => [relevant] });
  assert.equal(got.size, 20); assert(!got.has(relevant));
  return { chosen: got.size, unrelatedSameName: [...got.keys()].filter(p => !p.startsWith('packages/z/')).length, twoSymbolCandidateAdmitted: got.has(relevant) };
});
check('Q8-real-collector-single-call-evidence', () => fixture({
  'specs/contract.md': '# Contract\n\nAC-1: The validator rejects negative invoice amounts before charging.\n',
  'app/selection.js': Array.from({ length: 30 }, (_, i) => `exports.select${i} = value => value ? ${i} : 0;`).join('\n') + '\n',
  'billing/validator.js': 'function validateInvoice(amount) {\n  if (amount < 0) throw new Error("validator rejects negative invoice amounts before charging");\n  return amount;\n}\nmodule.exports = { validateInvoice };\n',
  'billing/validator.test.js': 'const test = require("node:test"), assert = require("node:assert/strict");\nconst { validateInvoice } = require("./validator");\ntest("validator rejects negative invoice amounts before charging", () => {\n  assert.throws(() => validateInvoice(-1));\n});\n',
}, d => {
  const ctx = path.join(d, '.ctx'); A.collect({ cwd: d, ctx, reqPaths: 'specs/**', maxUnits: 1 });
  const ev = fs.readFileSync(path.join(ctx, 'audit-evidence.txt'), 'utf8'), units = fs.readFileSync(path.join(ctx, 'audit-units.txt'), 'utf8');
  assert(ev.includes('billing/validator.js')); assert(units.includes('app/selection.js')); assert(!units.includes('billing/validator.js'));
  const pack = P.contextPack(ctx, d, 250000);
  assert(!pack.text.includes('validator rejects negative invoice amounts')); assert.deepEqual(pack.notWhole, []);
  return { evidenceFromRealCollector: true, selectedUnit: 'app/selection.js', evidencePacked: false, notWhole: pack.notWhole };
}));
console.log(JSON.stringify(results, null, 2));
```

</details>

<details>
<summary>实际输出：8 个反例</summary>

```json
[
  {
    "id": "Q1-short-explicit-requirements",
    "reproduced": true,
    "counts": [
      {
        "parsed": 1,
        "admitted": 0,
        "ruled": 0
      },
      {
        "parsed": 1,
        "admitted": 0,
        "ruled": 0
      }
    ]
  },
  {
    "id": "Q2-threshold-table-filtered",
    "reproduced": true,
    "kept": 0,
    "rejected": [
      {
        "text": "| Starter subscription | 10 | 20 |",
        "reason": "results/data table row"
      },
      {
        "text": "| Enterprise subscription | 100 | 200 |",
        "reason": "results/data table row"
      }
    ]
  },
  {
    "id": "Q3-gherkin-inherited-context",
    "reproduced": true,
    "scenarioCidUnchanged": true,
    "inheritedConditionInBody": false,
    "inheritedConditionInPart": false,
    "blockCuts": {}
  },
  {
    "id": "Q4-shared-test-helper-freshness",
    "reproduced": true,
    "tests": [
      "tests/amount.test.js"
    ],
    "versionUnchanged": true,
    "changedPriority": 0,
    "selectedInstead": "src/new-entry.js",
    "stale": [],
    "helpersInUnits": false
  },
  {
    "id": "Q5-large-source-outside-universe",
    "reproduced": true,
    "sourceBytes": 627780,
    "units": 0,
    "limitations": []
  },
  {
    "id": "Q6-document-admission-does-not-rotate",
    "reproduced": true,
    "trackedRequirementDocs": 61,
    "admitted": 60,
    "tailEverSelected": false,
    "explicitlyRejected": true
  },
  {
    "id": "Q7-monorepo-name-collision-candidate-cap",
    "reproduced": true,
    "chosen": 20,
    "unrelatedSameName": 20,
    "twoSymbolCandidateAdmitted": false
  },
  {
    "id": "Q8-real-collector-single-call-evidence",
    "reproduced": true,
    "evidenceFromRealCollector": true,
    "selectedUnit": "app/selection.js",
    "evidencePacked": false,
    "notWhole": []
  }
]
```

</details>

## 12. Verdict

**Verdict:** 先确保需求和源码能完整进入可追踪的审查集合，再保证行为及证据一起进 chunk，最后验证跨 chunk/跨版本的一致性。全仓 unit-test audit 应输出可信的行为证据和明确未知范围，不能把文件计数、候选数量或成功运行次数当成质量证明。

**Not checked:** 未执行真实模型/pilot、未实现新的分块器、未覆盖所有契约格式和编程语言、未对 6001 文件或实际大型采用者仓库做性能压测。完整 trace 回归被主动中止；其 22 项直接相关解析用例另行通过，不能替代剩余 Git/CLI 场景。本轮修正文档中的证据表述，产品发现仍待实现与回归验证。
