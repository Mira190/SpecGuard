# 全仓 shift-left audit：最新 main、在审修复与新增反例

What this repo does: SpecGuard 在 PR 阶段把需求、代码、测试和仓库规则联系起来，提示缺失或薄弱的单元测试，也提供全仓轮转扫描。目标是在 QA 之前发现可行动的缺口；静态审查本身不执行测试，也不能证明行为正确。本次按默认扫描上限、250,000-byte API pack、有较大源码/测试文件、持续提交和跨仓保存扫描结果的实际使用方式审查。

日期：2026-10-16，Australia/Sydney。性质：全仓风险审计，只提交报告，不修改产品代码。

## 1. 版本与结论

**本次正式基线是重新 fetch 后的最新 `origin/main`，不是上一份报告的分支快照。** 2026-10-16 18:06 AEDT 再次 fetch，main 与以下两项修复的 head 均未变化。

| 对象 | 固定提交 | 本次验证方式 |
|---|---|---|
| main | `ee1c15812bae4315f39ce7d5bf1bf7511ac58553` | 全套离线测试首跑、失败项复测、10 个确定性反例 |
| [PR #197](https://github.com/Mira190/SpecGuard/pull/197)，断言删除后提升低置信度 | `b1aaf113aae3ca69fcc70e7b9026130affa6c30f` | 对 main 的全部 diff；未把它当成已合入代码，也未声称跑过其完整测试集 |
| [PR #198](https://github.com/Mira190/SpecGuard/pull/198)，按 pack 预算分片 | `c77841d638a7ce1e3de8280fdad6539a05653d1c` | 独立导出这个提交的源码，复跑 5 个新增及 7 个此前反例 |

上一份 [复审报告](https://github.com/Mira190/SpecGuard/blob/60a3028e265b40f7c016129f87f2593d15c1f369/docs/shift-left-rereview-2026-10-16.md) 使用的 `a90608c` 是 #198 的较早提交，**不是最新 main**。本文更正版本归属，重新验证其结论，不把旧测试数字移用为新基线的验证结果。

**结论：目前不能认定 shift-left 的关键质量约束已经闭合。** 此次确认 11 项问题：此前 F19–F24 的 6 项仍有复现依据；另外得到 5 项新反例 F25–F29。这里的“新增”是相对上一份复审；不是声称历史上从未有人提出过，也不是证明已经找尽 unknown unknowns。

最先需要堵住的是：证据丢失、输出验证失败、需求身份错配、历史状态过期时，仍能留下“完整/covered”的结论。其次是确保扫描真的推进、测试路径配置全链路一致、评估不会把同一个发现算两次。扩大 prompt、增加模型预算或继续堆测试数量，都不能替代这些约束。

## 2. 第一性原理与全仓覆盖范围

仓库原始 goal 是：审查需求和测试，找出缺失单元测试，确认编码标准，并识别可以下沉到单元层的高层测试。对应的必要条件是：

1. **需求身份正确。** 某条需求的测试证据不能冒充另一条需求；改变运算符、大小写或值也可能改变契约。
2. **证据足够且属于当前版本。** “未发现”必须区分没有缺口、没有看到、没有回答、没有验证成功。
3. **负面结论比正面证据要求更强。** 发现一个真实断言只能证明这一个断言存在；“没有测试”需要搜索相关测试，裁剪不能自动变成不存在。
4. **增量扫描覆盖当前版本。** cursor 只有绑定内容版本与分片布局才有意义；重复运行要能扩大已审范围。
5. **反馈发生在可行动时点，效果度量保持身份。** 同一发现移到摘要或多展示一次，不应改变 recall；修改过相关行也不等于已经修复缺陷。

这些是本次审计使用的不变量，不是新增产品框架。以最小输入变化去尝试破坏它们，比重复已有 happy-path 用例更容易发现系统边界的问题。

| 全仓路径 | 检查的边界与证据 | 本次结论 |
|---|---|---|
| README、package、`action.yml`、`.github/workflows/ci.yml`、`specguard-run.yml` | 入口、输入传递、事件/分支限制、权限、CI 与本地运行环境 | main 与在审修复分开；测试路径和跨仓状态读取没有全链路一致 |
| `collect.sh`、`requirements.js`、`trace.js`、`test-map.js`、`leads.js` | 文档发现、需求身份、候选测试、断言线索、明确的预算和启发式边界 | 不把已声明的启发式局限单独充当新 bug；语义变化被 identity 归一化抹掉是实证问题 |
| `audit-collect.js`、`audit-units.js`、`scan-parts.js` | 需求轮转、源码分片、版本、证据检索、跨轮状态 | F22–F28；包含有文档与无文档的 code-first 路径 |
| `prompt.js`、两个产品 skill、`engines/claude-api.js` 与引擎 shell | API 无文件工具约束、上下文打包、分批、预算/失败传播、只读工具参数 | 当前分片与测试切片不同步；单批/多批证据约定不一致；只读参数已检查，但未进行真实模型攻击测试 |
| `post.js`、`audit-post.js`、schema、`preflight.js` | 输出验证、引用、发布、complete/unknown、缓存及 issue 状态 | F19–F21；反例经过真实 publisher，GitHub API 用本地 mock |
| `bin/specguard-local.js`、`coverage.js` | 本地提前反馈、与 CI 的输入/后处理复用、覆盖率输入边界 | 已读关键链路并运行相关测试；没有把注入旧覆盖率报告这类未完成论证的猜测列为漏洞 |
| `eval/grade.js`、`weekly-report.js`、`label-export.js`、replay/seeded 测试及 validation 文档 | 指标身份、summary/inline 展示、真实修复与代理指标 | F29；weekly 的 inline 样本边界已有说明，不能外推为所有摘要反馈的有效性 |

“全仓”指跨入口、采集、推理上下文、验证、状态、发布、本地使用和评估的端到端审查。不是宣称逐行深读了每个 fixture、历史研究文档和所有 shell 分支；重点深读了可能造成错误放心、漏检或扫描停滞的链路。外部 SDK 的最新行为未联网核实，本文关于它们只陈述仓库配置，没有引用外部产品保证。

## 3. Must fix

### 1. [P1] F19：PR 证据被裁掉，仍发布 complete 并缓存 clean 结论

- **What this is:** `src/post.js:1469–1476` 读取 `pack-cut.txt`，但主要用它压低已有 missing/weak finding；`1710–1729` 决定 completeness 和 head marker。
- **Problem:** 让源码、测试都在 pack-cut 中，提供引用能够在磁盘上核对的 covered 输出，真实 publisher 仍返回 `complete=true`、`execution_complete=true`，显示 `No unit test gaps found` 并写 head marker；真实 preflight 随后跳过同一 head。磁盘上存在引用不能证明模型看到了所需上下文。
- **Fix:** 把影响本次义务的上下文丢失送入 completion 与 obligation 状态；阻止这种结果进入完整 head 缓存。保留可核实的局部发现，但不能据此给整次审查完整背书。
- **If we skip it:** 用户看见放心信号，同一提交重跑又被跳过，QA 前发现缺陷的机会被直接关闭。main 与 #198 均复现；#197 的 diff 未修改这一 completion/cache 约束。

证据：附录 B `P6_PR_pack_cut`，`status=complete`、`cleanVerdict=true`、`headMarker=true`、`nextRunSkip=true`。

### 2. [P1] F20：无效 finding 被删除后，unit 被写成 covered

- **What this is:** `src/audit-post.js:150–169` 验证 unit finding；`383–386` 从保留 finding 推导 unit 状态；`752–760` 发布并持久化。
- **Problem:** 一个 selected unit 的唯一 missing_test 缺少 title，验证器正确删除它并留下说明；publisher 却把“没有有效 finding”当成“没有缺口”，返回 complete，并在 issue 状态写 covered。
- **Fix:** 将验证失败关联回具体 unit，使其保持 unknown/未完成，不推进 covered 或确认次数；补一个经过 validate → verify → publish → readState 的用例。
- **If we skip it:** 模型一次结构错误就能从扫描待办中洗掉一个缺口，之后轮转还会把它当作已审查。main、#198 均复现。

证据：附录 B `P5_invalid_finding`，说明确实可见，但输出 `complete`、持久状态 `covered`。因此仅增加可见 warning 不足以修复。

### 3. [P1] F21：需求 cid 没有绑定其自己的 source block

- **What this is:** `src/audit-post.js:228–238` 验证 source 位于获准文档、引用存在，再用 cid 找 heading。
- **Problem:** A 要求拒绝负数，B 要求接受正数；两个合法 cid 都引用 B 和同一个正数断言，验证后两个都 covered，且无 warning。来源真实不等于来源属于这个需求。
- **Fix:** 将 source 绑定候选的文档和 block 范围；对 bundled block 的 `.N` 子项使用同一父 block 边界。错配行归回其 cid 的 unknown，不能用另一条需求补齐。
- **If we skip it:** 正向 happy path 能冒充负向边界的测试，R→T 追溯看起来完整，实际核心目标漏检。main、#198 均复现。

证据：附录 B `P4_requirement_identity`，`aaaaaaaa`、`bbbbbbbb` 都指向 `B.md`，两行 `covered`，warnings 为空。

### 4. [P1] F22：分片 cursor 在内容或布局变化后仍继续使用

- **What this is:** `src/audit-units.js:63–68` 的 partOf 使用整数 cursor；state 中虽然有 `uv`，但它没有在这里使旧 cursor 失效。
- **Problem:** main 的 600 行样本先读 1–300，修改第 1 行后继续 301–600，最终 covered，却未重读修改行。#198 上同一内容变成三片，仍复现；另将 `max_units` 从 12 改为 1，同一 cursor 的解释从“下一片 121 起”变为“201 起”，121–200 从未读取。
- **Fix:** 内容版本变化时清空进度；预算改变导致布局变化时也重置，或持久化可验证的布局/范围。最小修复优先重置，不必先建立复杂覆盖账本。
- **If we skip it:** 多轮扫描“读完了文件”只在不同版本、不同布局的拼接意义上成立，当前版本可以漏段仍显示 covered。布局改变反例属于 #198，不能误写为 main 的自适应分片行为。

证据：附录 B `P1_cursor_after_edit`；#198 的原始反例 `P2_cursor_after_budget_change`：`1–120 → 201–400`，未读区间 `[121,200]`。

### 5. [P1] F25（新增）：需求运算符变化被当成同一个已覆盖需求

- **What this is:** `src/audit-collect.js:69,91` 对 block 文本先转小写，再把所有非字母数字字符归为空格，作为 cid 的哈希输入；`113` 用 cid 判断新改需求。
- **Problem:** `Service must accept amounts >= 10.` 改为 `> 10.`，cid 仍是 `090622e0`。在一条旧 gap 待确认、每轮只选 1 条的样本中，collect 选择旧 gap，将已改变的边界要求 carry；stateOf 仍保留其 covered。代码和测试没有改，所以证据版本检测也不能替代需求版本检测。
- **Fix:** cid 的内容归一化只忽略无语义格式，不丢弃运算符、符号、大小写敏感字面量；迁移时使已有覆盖状态重新接受审查。为 `>= → >`、`-1 → 1`、大小写敏感值增加状态级用例，而非只测 hash 函数。
- **If we skip it:** “只改需求、CI 仍绿”的边界错误不会获得 changed 优先级，还携带旧的放心状态。这正是 shift-left 应优先发现的变化；后续普通轮转可能发现，不能描述成永远不会再扫描。

证据：附录 A `N1-semantic-requirement-change`。比较运算符反例在 main 和 #198 均执行通过；其余符号变化是建议验收向量，不冒充本次已运行证据。

### 6. [P1] F27（新增）：读后半段代码，却只打包前 40 个符号的测试

- **What this is:** `src/engines/claude-api.js:222–224` 的 unitSymbols 从整文件开头取最多 40 个符号；源码打包单独遵守 unitPart，测试切片却仍用整文件符号。
- **Problem:** 一个 200 个函数的文件，真实 inventory 本轮选中源码范围 101–200。pack 有 `unit170` 的实现，却没有其实际存在的 `assert.equal(unit170(...))`；它装入了前半段测试，`notWhole=[]`。slices 的“complete”只证明它选到的符号的测试读完，并不证明本轮源码的测试读完。
- **Fix:** 根据当前 part 提取符号，再选择测试窗口；符号上限、别名或切片不能涵盖当前范围时传播 unknown/cut。用带真实后半段断言的大测试文件验证，不能只断言源码窗口装得下。
- **If we skip it:** 可能把已有测试报成缺失，或接受缺乏相关上下文的无缺口结论。实测证明的是证据丢失和完整性标记错误，未调用真实模型来声称必然生成某条误报。

证据：附录 A `N3-current-part-test-slices`；main、#198 均为 `currentSourceVisible=true`、`currentAssertionVisible=false`、`notWhole=[]`。

### 7. [P1] F28（新增）：20 条需求时丢掉证据正文，21 条反而能读到

- **What this is:** `src/scan-parts.js:15` 在候选不超过 batch 时返回 null；`claude-api.js:179–249` 的常规 contextPack 不按 `audit-evidence.txt` 装载需求证据文件。多批路径则显式用 windowPack 装载。
- **Problem:** 手工构造 `audit-evidence.txt`、引用 `config/policy.yaml` 且没有对应入选 code unit 的样本，20 条候选时正文未进入 pack，`notWhole=[]`；21 条时相同证据被 block-part 正确装入。这个样本隔离验证消费者的打包差异，不证明自动 collector 会检出该 YAML。证据候选中的短摘要不能代替上下文，API 模型又没有文件工具补读。
- **Fix:** 单批与多批共用 block evidence 的装载/缺失记录；只有一批时也执行同样的上下文规则。测试 batch−1、batch、batch+1，要求同一 obligation 所需证据的可见性不受这一阈值影响。
- **If we skip it:** 小文档反而更容易缺少验证材料。若模型遵守提示会降低可检出率；若模型直接判定，后处理也缺少 blockCuts 来强制收敛为 unknown。

证据：附录 A `N4-evidence-at-batch-boundary`。main、#198 均复现上述手工输入的打包差异。**2026-10-16 更正：** 原文称“evidence search 已明确找到了它”不准确；collector 的 `NOT_EVIDENCE` 会排除 YAML/JSON。后续[调研报告第 6 节及 Q8](research-repo-audit-requirements-chunking-2026-10-16.md#6-对上一报告-f28-的证据更正与补强) 使用真实 collector 产出的 JavaScript 证据，在 main 复现默认单批 pack 缺正文且 `notWhole=[]`，补强 F28 的核心问题；没有把这个新实验说成重新验证了 #198。

### 8. [P1] F23：#198 的源码装包保证没有保证扫描进度

- **What this is:** #198 `c77841d` 让多个 unit 的源码片段优先进入 pack；`src/audit-post.js:739,759–760` 在任一 matched test 被裁掉时不推进对应 unit。
- **Problem:** 8 个 unit、各约 23 KB 测试及规则文档、250,000-byte pack 的固定样本，源码裁剪 0，测试裁剪 8，unseen unit 8，写入状态 0。再次 inventory 选到完全相同的 unit 和 part。
- **Fix:** 以能完成一个 unit 的“源码范围＋相关测试＋规则”分配预算，减少本轮选中数量，或使完整上下文分批推进；对同样输入不能无提示地无限重试原片。不要为了推进 cursor 忽略未读测试。
- **If we skip it:** 源码 pack 测试全绿，定时扫描却重复花费预算而不扩大审查范围。此项报告的是最新 #198 的修复边界，不声称 main 已采用该源码优先算法。

证据：在 #198 导出源码执行上一报告完整脚本，`P7_scan_stall={sourceFilesCut:0,testFilesCut:8,unseenUnits:8,stateBlocks:0,samePartsNextRun:true}`。

## 4. Should fix

### 9. [P2] F26（新增）：配置的测试位置到了验证器又不算测试

- **What this is:** `audit-collect.js:44–60` 和 `audit-units.js:85–89` 接受 authoritative `test_paths`；`audit-post.js:36,231–232,283` 却只按文件名启发式判断。
- **Problem:** 配置 `qa/checks/**`，collect 把 `qa/checks/amount.js` 识别并匹配为测试；真实有效的 `assert.equal(amount(10), true)` 到 verify 被删除，covered 降为 unknown。weak_test/pushdown 引用同类路径也面对同一分类边界。
- **Fix:** 把相同的 testScope 传到 verify/verifyUnits 和 cover guard；配置存在时统一采用 owner 的范围与排除规则。增加从 action 配置一直走到最终 verdict 的非标准目录用例。
- **If we skip it:** 用户已经显式告诉系统测试在哪里，系统仍无法承认这些证据；漏掉弱测试反馈、长期 unknown 和重复人工解释会损害采用率。已复现的是 covered→unknown，不将它夸大为 false covered。

证据：附录 A `N2-authoritative-test-paths`，main、#198 均 `collectorMatchedTest=true`、`verifiedTests=0`。

### 10. [P2] F29（新增）：同一发现的摘要与证据表各算一次 TP

- **What this is:** `eval/grade.js:97–104` 把 summary item 和 coverage row 各做一个候选；`usedHits` 只限制候选使用次数，没有关联同一 finding 的两种展示。
- **Problem:** 使用真实 `post.buildSummary` 生成一个 missing_test，它自然同时显示在正文和义务表。期望有 A、B 两个缺口时，grade 得到 `tp=2,fn=0,pass=true`；去掉同一发现的镜像表格，变成 `tp=1,fn=1`。summary 允许按 path/kind 匹配且不执行同样的行距约束，使 B 能吃掉 A 的镜像。
- **Fix:** 一项逻辑 finding 只有一个匹配身份；当正文已代表该义务时，表格不能再作为独立命中。保留摘要落点容错，但要求身份/行为匹配，不能只凭同路径和类型；内联与摘要也需检查重复呈现。
- **If we skip it:** UI 展示变化能虚增 recall/pass，团队据此宣称 shift-left 改善并不可信。这是评估器 bug，不是已观测到真实业务指标被提高的声明。

证据：附录 A `N5-mirrored-summary-double-count`。main、#198 均复现；不是手写一个并不存在的输出格式。

### 11. [P2] F24：跨仓 issue 发布与前一轮状态读取指向不同仓库

- **What this is:** action 的 scan publisher 支持 `scan_issue_repo`/单独 token；`src/audit-collect.js:292–308` 的 loadPrior 只按源仓库、默认 scope 查找。
- **Problem:** 源仓 `org/source`、目标 `org/reports`，此前状态存在目标 issue 中；实际 loader 只请求 `/repos/org/source/issues` 并返回 null。即使直接向 loader 提供 `ISSUE_REPO` 也不会使用；action 的采集步骤还没有把该目标和 token 传进来。
- **Fix:** 采集与发布共用目标解析、scope/title 和目标读取凭证；验证源仓→目标仓的完整闭环，保持已有 visibility guard。
- **If we skip it:** 发布的报告看起来成功，下一轮仍从前排重新开始；风险较低的尾部长期得不到审查，多源仓共用报告仓时还需正确区分来源身份。

证据：附录 B `P3_external_state`。所有 HTTP 均为 mock，未向任何真实仓库写 issue。main、#198 均复现。

## 5. 从发现到可验收修复

不需要先重构整个系统。建议按下面的依赖顺序提交小修复，每一步都保留证明错误行为的反例：

| 顺序 | 必须成立的验收条件 | 对应发现 |
|---|---|---|
| 1：结论可信 | 有义务相关的未读证据/无效输出时，不写完整缓存或 covered；有效局部发现仍保留 | F19、F20 |
| 2：身份与版本 | A 不能借 B 的 source 覆盖；需求契约改变要重新审；内容或布局改变不能沿用旧进度 | F21、F22、F25 |
| 3：能看到也能推进 | 当前源码片段的实际测试被读到；batch 阈值前后证据规则相同；默认 pack 下多轮能扩大审查范围 | F23、F27、F28 |
| 4：配置闭环 | 非标准测试目录的配置在最终验证仍生效；状态读写同一目标、同一来源身份 | F24、F26 |
| 5：度量可信 | 同一 finding 的镜像、摘要/内联转换不改变 TP/FP/FN；缺失 B 不能用 A 的第二个展示补齐 | F29 |

用于继续挖掘 unknown unknown 的组合，不是仅补每个 happy path：

- **语义变化与无关变化分离：** 空白变动可以保持身份；运算符/否定/大小写敏感字面量变动必须触发审查。代码和测试不变也是必测状态。
- **单调性：** 缩小预算/删除证据只能使结论更不确定，不能提高 complete；增加展示副本不能提高 TP；完成下一轮应能指出新增审查范围。
- **身份互换：** 交换两个合法 cid 的 source、交换两个测试路径、搬到 owner 明确配置的目录，分别验证错误引用被拒绝、等价配置被接受。
- **边界组合：** 第 40/41 个符号、20/21 个 block、最后一片、新 commit、预算变化、部分输出坏掉；组合比只测单个上限更重要。
- **时序：** 发布成功但下轮读不到状态、原 issue 关闭/重开、旧版本被 supersede。现有 guard 不能替代逐个跨步骤契约的检查。

完成这些修复后仍要验证实际 goal，而非将全部测试通过等同于 shift-left 已有效：固定代表性历史 QA/生产缺陷、只使用引入 PR 当时可得的 R/C/T/S，盲评是否命中可行动缺口；另测正常 PR 的噪声、开发者真实采纳/修复比例、反馈时点、延迟和成本。将“改过相关行”与“行为反例已被测试阻止”分别记账。离线 seeded/replay 与真实采用者结果必须分别报告。

这部分是验收计划，不是已经跑过的 pilot，也不建议为了验证报告直接调用付费模型或在采用者仓库发布评论。

## 6. 实际验证与限制

- 基线环境：Windows、Node `v26.11.1`；仓库 CI 使用 Ubuntu、Node 22。首次执行 `node --test --test-reporter=tap --test-concurrency=3 src/*.test.js bin/*.test.js eval/*.test.js`：**1085 tests，1061 pass，21 fail，2 skipped，1 todo**。
- 默认 `bash` 指向 `C:\Windows\System32\bash.exe`。多项 shell 测试明确失败于 `/bin/bash: C:/.../src/collect.sh: No such file or directory`；没有把这些环境失败写成产品漏洞。
- 将 Git for Windows 的 `bin`、`usr/bin` 放到本进程 PATH 前面后，复跑相关文件：第一组 **62/62 pass**；第二组 **25 tests，24 pass，0 fail，1 todo**。单独复跑首轮失败的 `fixture tr14 in CRLF`：**1/1 pass**，首轮该例耗时约 122 秒，独立复跑约 7 秒；证据支持负载/时限相关，不据此断言已证明根因。
- 最后补跑 `eval/local.test.js`：**10/10 pass**。四组复测合计 **98 tests，97 pass，0 fail，1 todo**；这包含对照测试，不是 98 项首轮失败。
- 逐项比对首轮失败的 test name：21 项意外失败均在上述复测中通过；未把被跳过或 TODO 的项计入这 21 项。
- TODO 是仓库既有的 `k2 toolbox (wanted): the has() claim is not posted as a weak test`，注明无确定性 weak_test guard、依赖模型；它不能算修好了，也不能算意外失败。
- main：附录 A 的 **5/5** 新反例和附录 B 的 **5/5** 旧反例均复现。#198 固定导出：同样 **5/5** 新反例和上一报告完整脚本 **7/7** 反例均复现。反例通过意味着成功证明当前错误行为，**不是产品测试通过或修复通过**。
- 没有重跑整套 Ubuntu/Node 22 CI；没有把复测结果拼接伪装成一次全绿全套运行。没有执行真实 Claude/Copilot 模型、付费评估、真实 PR 评论或跨仓 issue 发布。未逐一深审全部历史 fixture/研究文档，也没有证明全部安全边界无漏洞。

下面附实际执行脚本与输出摘要，便于修改后反向设置预期，建立真正能阻止回归的测试。脚本在临时 Git 仓库中构造数据，mock GitHub；清理前检查临时目录边界，不触碰用户工作分支。

## 7. 可执行复现

在上述固定 main checkout 根目录保存附录脚本为指定 `.cjs` 文件后执行 `node 文件名.cjs`。新反例脚本可直接用于固定 #198 源码；附录 B 是针对 main 两片布局调整后的版本。#198 的七项完整脚本可从上一份固定提交报告的附录原样提取执行，不能把 main 的两片期望硬套到 #198 三片布局。

### 附录 A：新增反例（保存为 audit-new.cjs）

<details>
<summary>展开脚本或结果</summary>

```javascript
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const root = __dirname;
const ac = require('./src/audit-collect');
const ap = require('./src/audit-post');
const packer = require('./src/engines/claude-api');
const { plan } = require('./src/scan-parts');
const { grade, parseSummary } = require('./eval/grade');
const results = [];
function write(dir, file, content) { const p = path.join(dir, file); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, content); }
function git(dir, ...args) { return execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
function commit(dir) { git(dir, 'add', '.'); git(dir, '-c', 'user.name=Audit Fixture', '-c', 'user.email=audit@example.invalid', 'commit', '-qm', 'fixture'); return git(dir, 'rev-parse', 'HEAD'); }
function fixture(files, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'specguard-full-audit-'));
  try { git(dir, 'init', '-q'); for (const [p, s] of Object.entries(files)) write(dir, p, s); commit(dir); return fn(dir); }
  finally { const p = fs.realpathSync(dir), base = fs.realpathSync(os.tmpdir()); assert(p.startsWith(base + path.sep) && path.basename(p).startsWith('specguard-full-audit-')); fs.rmSync(p, { recursive: true, force: true }); }
}
function probe(id, fn) { try { const detail = fn(); results.push({ id, reproduced: true, ...detail }); } catch (e) { results.push({ id, reproduced: false, error: e.stack }); process.exitCode = 1; } }
probe('N1-semantic-requirement-change', () => fixture({
  'docs/design.md': '# Design\n\n## Amount\nService must accept amounts >= 10.\n\n## Name\nService must reject blank names.\n',
  'src/amount.js': 'function amount(value) { return value >= 10; }\n',
  'tests/amount.test.js': 'test("inclusive minimum", () => { assert.equal(amount(10), true); });\n',
}, dir => {
  const oldHead = git(dir, 'rev-parse', 'HEAD'), before = ac.allBlocks(dir, oldHead, ['docs/design.md']);
  assert.equal(before.length, 2);
  const a = before.find(b => b.text.includes('amounts')), b = before.find(b => b.text.includes('blank'));
  write(dir, 'docs/design.md', fs.readFileSync(path.join(dir, 'docs/design.md'), 'utf8').replace('>= 10', '> 10'));
  const head = commit(dir), after = ac.allBlocks(dir, head, ['docs/design.md']);
  const changed = after.find(x => x.text.includes('amounts'));
  assert.equal(changed.cid, a.cid);
  const prior = { head: oldHead, blocks: [{ cid: a.cid, status: 'covered', runs: 2, since: oldHead.slice(0, 7), at: { head: oldHead.slice(0, 7), date: '2026-10-15' } }, { cid: b.cid, status: 'gap', runs: 1, since: oldHead.slice(0, 7), at: { head: oldHead.slice(0, 7), date: '2026-10-15' } }], versions: { ev: {}, uv: {} } };
  prior.versions.ev[a.cid] = ['src/amount.js', 'tests/amount.test.js'].map(p => require('node:crypto').createHash('sha1').update(p).digest('hex').slice(0, 8));
  const ctx = path.join(dir, '.ctx');
  ac.collect({ cwd: dir, ctx, reqPaths: 'docs/design.md', maxRequirements: 1, maxUnits: 1, prior, rotate: true });
  const selected = fs.readFileSync(path.join(ctx, 'audit-candidates.txt'), 'utf8');
  const carried = fs.readFileSync(path.join(ctx, 'audit-carried.txt'), 'utf8');
  assert(selected.includes(b.cid)); assert(!selected.includes(a.cid)); assert(carried.includes(a.cid));
  const state = ap.readState(ap.stateOf(head, { requirements: [], not_requirements: [] }, prior, { carried: [prior.blocks[0]] }).raw);
  assert.equal(state.blocks[0].status, 'covered');
  return { sameCid: a.cid, selectedChanged: false, carriedStatus: state.blocks[0].status };
}));
probe('N2-authoritative-test-paths', () => fixture({
  'docs/design.md': '# Design\n\nService must reject invalid amounts.\n',
  'src/amount.js': 'function amount(value) {\n  return value >= 10;\n}\nmodule.exports = { amount };\n',
  'qa/checks/amount.js': 'const { amount } = require("../../src/amount");\ntest("amount boundary", () => {\n  assert.equal(amount(10), true);\n});\n',
}, dir => {
  const ctx = path.join(dir, '.ctx');
  ac.collect({ cwd: dir, ctx, reqPaths: 'docs/design.md', testPaths: 'qa/checks/**', maxUnits: 1 });
  const layout = fs.readFileSync(path.join(ctx, 'test-layout.txt'), 'utf8');
  const units = fs.readFileSync(path.join(ctx, 'audit-units.txt'), 'utf8');
  assert(layout.includes('qa/checks (1)')); assert(units.includes('qa/checks/amount.js'));
  const read = p => { try { return fs.readFileSync(path.join(dir, p), 'utf8').split('\n'); } catch { return null; } };
  const cite = (p, n) => ({ path: p, line: n, quote: read(p)[n - 1] });
  const req = { id: '1111111a', source: cite('docs/design.md', 3), text: 'Reject invalid amounts', class: 'unit', status: 'covered', code: [cite('src/amount.js', 2)], tests: [{ ...cite('qa/checks/amount.js', 3), layer: 'unit' }], note: '' };
  const verified = ap.verify({ requirements: [req], not_reviewed: [], not_requirements: [], unit_findings: [] }, { read });
  assert.equal(verified.requirements[0].status, 'unknown'); assert.equal(verified.requirements[0].tests.length, 0);
  return { collectorMatchedTest: true, verifiedStatus: verified.requirements[0].status, verifiedTests: 0 };
}));
probe('N3-current-part-test-slices', () => fixture({
  'src/units.js': Array.from({ length: 200 }, (_, i) => `function unit${String(i).padStart(3, '0')}(value) { return value + ${i}; } // ${'x'.repeat(200)}`).join('\n') + '\n',
  'tests/units.test.js': Array.from({ length: 200 }, (_, i) => `test('unit ${i}', () => { assert.equal(unit${String(i).padStart(3, '0')}(1), ${i + 1}); }); // ${'x'.repeat(600)}`).join('\n') + '\n',
}, dir => {
  const ctx = path.join(dir, '.ctx');
  const au = require('./src/audit-units'), head = git(dir, 'rev-parse', 'HEAD');
  const first = au.inventory({ cwd: dir, head, maxUnits: 1, packBytes: 250000 }).picked[0];
  const prior = { blocks: [{ cid: first.id, status: 'unsure', runs: 1 }], versions: { uv: { [first.id]: first.ver }, ev: {}, uc: { [first.id]: 1 } } };
  const next = au.inventory({ cwd: dir, head, maxUnits: 1, packBytes: 250000, prior });
  assert.equal(next.picked[0].part.a, 101); assert.equal(next.picked[0].part.b, 200);
  fs.mkdirSync(ctx); au.write(ctx, head, 1, next);
  const p = packer.contextPack(ctx, dir, 250000);
  assert(p.text.includes('function unit170')); assert(!p.text.includes('assert.equal(unit170'));
  assert(p.text.includes('assert.equal(unit000')); assert.deepEqual(p.notWhole, []);
  return { currentSourceVisible: true, currentAssertionVisible: false, irrelevantEarlyTestsVisible: true, notWhole: p.notWhole };
}));
probe('N4-evidence-at-batch-boundary', () => fixture({
  'config/policy.yaml': 'amount_minimum: 10\n',
  'tests/policy.test.js': 'test("minimum", () => { assert.equal(policy.amount_minimum, 10); });\n',
}, dir => {
  const ctx = path.join(dir, '.ctx');
  const cid = i => i.toString(16).padStart(8, '0');
  function setup(n) {
    write(ctx, 'audit-candidates.txt', Array.from({ length: n }, (_, i) => `${cid(i)}\tdocs/design.md:${i + 1}\tPolicy\tMinimum must be 10.`).join('\n') + '\n');
    write(ctx, 'audit-evidence.txt', Array.from({ length: n }, (_, i) => `${cid(i)}\tcode\tconfig/policy.yaml:1\tamount_minimum: 10\n${cid(i)}\ttest\ttests/policy.test.js:1\tassert.equal(policy.amount_minimum, 10)`).join('\n') + '\n');
  }
  const opts = { ctx, root: dir, batch: 20, limit: 250000, schemaFile: path.join(root, 'src/audit.schema.json'), contextPack: packer.contextPack, windowPack: packer.windowPack, assembleAudit: require('./src/prompt').assembleAudit };
  setup(20); assert.equal(plan(opts), null); const one = packer.contextPack(ctx, dir, 250000);
  assert(!one.text.includes('amount_minimum: 10')); assert.deepEqual(one.notWhole, []);
  setup(21); const split = plan(opts); assert(split.parts[0].pack.text.includes('amount_minimum: 10'));
  return { at20: { evidencePacked: false, notWhole: one.notWhole }, at21: { evidencePacked: true } };
}));
probe('N5-mirrored-summary-double-count', () => {
  const f = { kind: 'missing_test', path: 'a.js', line: 10, title: 'Boundary A', body: 'Missing assertion', confidence: 'high', obligation_id: 'O1' };
  const b = { path: 'a.js', line: 10, quote: 'return boundary(value);' };
  const data = { requirements: [], requirements_source: 'none', not_reviewed: '', coverage: [{ id: 'O1', obligation: 'Boundary A', source: 'from behaviour', behaviour: b, change: b, evidence: [], status: 'missing_test', reason: 'No test', alignment: { status: 'not_applicable', reason: 'No explicit requirement' } }], findings: [f], standards: { status: 'no_rules', sources: [], reason: 'None' }, layering: { status: 'checked', reason: 'No higher layer tests' } };
  const summary = require('./src/post').buildSummary({ cov: { reports: 0 }, data, items: [{ f, why: 'not on diff' }], notes: [], blob: 'https://github.com/example/repo/blob/abc/' });
  const one = { kind: 'missing_test', path: 'a.js', line: 10, allow_summary: true };
  const parsed = parseSummary(summary); assert.equal(parsed.items.length, 1); assert.equal(parsed.rows.length, 1);
  const g = grade({ id: 'mirror', goal: 'requirements', expected: { findings: [one, { ...one, line: 30 }] } }, { comments: [], reviews: [], summary });
  assert.equal(g.tp, 2); assert.equal(g.fn, 0); assert.equal(g.pass, true);
  const control = grade({ id: 'mirror', goal: 'requirements', expected: { findings: [one, { ...one, line: 30 }] } }, { comments: [], reviews: [], summary: summary.split('\n').filter(l => !l.startsWith('| O1:')).join('\n') });
  assert.equal(control.tp, 1); assert.equal(control.fn, 1);
  return { distinctFindings: 1, tp: g.tp, fn: g.fn, pass: g.pass, withoutMirrorTP: control.tp };
});
console.log(JSON.stringify(results, null, 2));
```

</details>

### 附录 A 实际结果（main）

<details>
<summary>展开脚本或结果</summary>

```json
[
  {
    "id": "N1-semantic-requirement-change",
    "reproduced": true,
    "sameCid": "090622e0",
    "selectedChanged": false,
    "carriedStatus": "covered"
  },
  {
    "id": "N2-authoritative-test-paths",
    "reproduced": true,
    "collectorMatchedTest": true,
    "verifiedStatus": "unknown",
    "verifiedTests": 0
  },
  {
    "id": "N3-current-part-test-slices",
    "reproduced": true,
    "currentSourceVisible": true,
    "currentAssertionVisible": false,
    "irrelevantEarlyTestsVisible": true,
    "notWhole": []
  },
  {
    "id": "N4-evidence-at-batch-boundary",
    "reproduced": true,
    "at20": {
      "evidencePacked": false,
      "notWhole": []
    },
    "at21": {
      "evidencePacked": true
    }
  },
  {
    "id": "N5-mirrored-summary-double-count",
    "reproduced": true,
    "distinctFindings": 1,
    "tp": 2,
    "fn": 0,
    "pass": true,
    "withoutMirrorTP": 1
  }
]
```

</details>

### 附录 B：main 旧问题复验（保存为 audit-main.cjs）

<details>
<summary>展开脚本或结果</summary>

```javascript
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
  const finalRow = next, finalState = after;
  assert.equal(finalState.blocks[0].status, 'covered');
  results.P1_cursor_after_edit = { first: first.part, next: next.part, final: finalRow.part, versionChanged: first.ver !== next.ver, selectedStaleIds: nextInv.stale, finalState: finalState.blocks[0].status, changedLineRevisited: false };
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

### 附录 B 实际结果（main）

<details>
<summary>展开脚本或结果</summary>

```json
{
  "P1_cursor_after_edit": {
    "first": {
      "k": 0,
      "n": 2,
      "a": 1,
      "b": 300
    },
    "next": {
      "k": 1,
      "n": 2,
      "a": 301,
      "b": 600
    },
    "final": {
      "k": 1,
      "n": 2,
      "a": 301,
      "b": 600
    },
    "versionChanged": true,
    "selectedStaleIds": [],
    "finalState": "covered",
    "changedLineRevisited": false
  },
  "P3_external_state": {
    "requests": [
      "https://api.github.com/user",
      "https://api.github.com/repos/org/source/issues?state=all&per_page=100&page=1"
    ],
    "foundPrior": false,
    "expectedDestination": "org/reports"
  },
  "P4_requirement_identity": {
    "rows": [
      {
        "id": "aaaaaaaa",
        "source": "B.md",
        "status": "covered"
      },
      {
        "id": "bbbbbbbb",
        "source": "B.md",
        "status": "covered"
      }
    ],
    "warnings": []
  },
  "P5_invalid_finding": {
    "outputs": {
      "status": "complete"
    },
    "state": "covered",
    "validationVisible": true,
    "warnings": []
  },
  "P6_PR_pack_cut": {
    "outputs": {
      "status": "complete"
    },
    "complete": true,
    "execution_complete": true,
    "cleanVerdict": true,
    "headMarker": true,
    "nextRunSkip": true,
    "warnings": []
  }
}
```

</details>

### 附录 C：#198 完整复验实际结果

<details>
<summary>展开脚本或结果</summary>

```json
{
  "P1_cursor_after_edit": {
    "first": {
      "k": 0,
      "n": 3,
      "a": 1,
      "b": 200
    },
    "next": {
      "k": 1,
      "n": 3,
      "a": 201,
      "b": 400
    },
    "final": {
      "k": 2,
      "n": 3,
      "a": 401,
      "b": 600
    },
    "versionChanged": true,
    "selectedStaleIds": [],
    "finalState": "covered",
    "changedLineRevisited": false
  },
  "P2_cursor_after_budget_change": {
    "first": {
      "k": 0,
      "n": 5,
      "a": 1,
      "b": 120
    },
    "next": {
      "k": 1,
      "n": 3,
      "a": 201,
      "b": 400
    },
    "neverRead": [
      121,
      200
    ]
  },
  "P3_external_state": {
    "requests": [
      "https://api.github.com/user",
      "https://api.github.com/repos/org/source/issues?state=all&per_page=100&page=1"
    ],
    "foundPrior": false,
    "expectedDestination": "org/reports"
  },
  "P4_requirement_identity": {
    "rows": [
      {
        "id": "aaaaaaaa",
        "source": "B.md",
        "status": "covered"
      },
      {
        "id": "bbbbbbbb",
        "source": "B.md",
        "status": "covered"
      }
    ],
    "warnings": []
  },
  "P5_invalid_finding": {
    "outputs": {
      "status": "complete"
    },
    "state": "covered",
    "validationVisible": true,
    "warnings": []
  },
  "P6_PR_pack_cut": {
    "outputs": {
      "status": "complete"
    },
    "complete": true,
    "execution_complete": true,
    "cleanVerdict": true,
    "headMarker": true,
    "nextRunSkip": true,
    "warnings": []
  },
  "P7_scan_stall": {
    "sourceFilesCut": 0,
    "testFilesCut": 8,
    "unseenUnits": 8,
    "stateBlocks": 0,
    "samePartsNextRun": true
  }
}
```

</details>


## 8. Verdict

**Verdict:** 先修错误放心与状态失真，再修证据完整性、扫描进度和度量身份。当前实现已具备多层防护，但尚不能凭“测试多、报告完整、源码装得下”确认 goal 达成。本文交付的是可复现审计和验收依据，11 项产品问题仍待修复。

**Not checked:** 真实采用者 pilot、线上模型行为、Ubuntu/Node 22 全套重跑，以及每个历史 fixture 的逐行审计。没有删除/合并代码建议，因此不报告虚构的行数或依赖节省。
