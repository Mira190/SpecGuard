# 交接：目标与「需求 ↔ 代码双向追溯」定位的第一性原理批判

日期：2026-10-09。分支：`experiment/trace-local-eval`（HEAD `eaa60ce`）。
性质：只做分析，不改运行时代码。读者是接手的下一个 session。

## 0. 交接须知

**先读这一节，再读别的。**

1. **用户原话里的粘贴内容没有送达。** 用户消息里写的是 `[Pasted text #7 +3 lines]`，正文没有传过来。从仓库推断，它很可能就是双向追溯需求里那段被截断的约束列表（`docs/traceability-plan.md:12`：「requirements may live in `docs/`, `specs/`, Gherkin, or Git…」）。**接手后第一件事：请用户重新粘贴。** 如果第 3 条及以后的约束和本文推断的不同，§4、§6 要重排。
2. 用户的立场：**质量工程（QE）**。目标是一个做 code review 的 GitHub Action，目的是 **shift-left**。
3. 本文不重复 `docs/goal-first-principles.md`（R–C–T 三角、12 行状态矩阵、U1–U20）。本文审查的是**那份分析本身的前提**，再把仓库自己测到的数据拿来对照。新发现的盲点编号为 **N1–N18**，不与 U 编号冲突。
4. 工作约定（来自用户记忆）：
   - 实现代码交给 Sonnet 子 agent 写，主 session 负责写规格和评审。
   - PR、commit、issue 里一律不加 AI 署名。
   - 并行 agent 的 brief 里禁止 `git stash/checkout/reset/restore/clean`；按文件划分归属，或改用 worktree。
5. 必读文件，按优先级：

| 文件 | 为什么读 |
|---|---|
| `docs/design.md` §0（原始目标原文）、Status、§9–§11、末尾的 Evaluation findings | 目标原文、已验证的部分、明确拒绝过的方案 |
| `docs/goal-first-principles.md` | 本文批判的对象 |
| `docs/traceability-plan.md` §0、§1、§4.0、§7 | 双向追溯的设计和评测计划 |
| `docs/competitors/head-to-head.md` | 唯一一次在真实缺陷上的横向对比 |
| `docs/field-study.md` §3.4、§7 | 需求文档发现在真实仓库上的噪声 |
| `docs/token-anatomy.md` | 成本结构 |
| `eval/replay/holdout-pairs.json`、`eval/replay/README.md` | 真实缺陷的类别分布 |

## 1. 结论

1. **目标函数从来没有写下来。** 对 QE 来说，shift-left 的价值大致是：
   > 本可在 PR 上发现的缺陷数 × 开发者真的改了的比例 × （在 QA 或生产发现的代价 − 在 PR 发现的代价） − 噪声、延迟和 token 成本

   仓库里有大量检出机制，但其余各项（可检出比例的上限、实际修复率、成本、延迟）在真实使用中**都没有测过**。下一步应先测这几项，再继续加机制（§2）。
2. **双向追溯的论证是枚举出来的，不是按频率加权出来的。** 12 行状态矩阵说明「CI 绿时什么情况可能出错」，但不说明「这种情况多常见」。仓库自己的数据：
   - head-to-head 里，**所有 direct hit 都来自代码与兄弟路径之间的测试缺口，没有一个来自 spec 比较**；
   - 回放池中 13 对确认在范围内的缺陷，`requirement_mismatch` 只有 2 对，而且是**同一个 orpc 机制**；
   - 这两对里的 R 是 **PR 自己写下的合并规则**，不是 spec 文档里的数值（§3 C2）。
3. **追溯功能已默认开启（`trace: auto`），却从未做过 live 评测。** tr1–tr17 的 live eval 没有跑（`docs/design.md:432`），而计划自己定的门槛是 precision ≥90%。默认开着一个从未测量的功能，和仓库「先测量再升级」的原则相冲突（§3 C4）。
4. **对原始需求只采用了一种解读。** 「coding standard has been confirmed」和「review requirements」都还有更字面、更便宜的读法：作者是否勾选了确认项；需求本身是否可测试。这两种读法都没有向用户确认过（N9、N10）。
5. **核心路径从未在真实采用者的仓库里跑过。** S6 pilot 只跑过一次个人仓库；org 计费和 Claude 引擎都未验证；head-to-head 用的是 Sonnet 子 agent，而生产默认是 Copilot `auto`。现有证据都是离线模拟（§3 C7、C8）。
6. **最大的 unknown unknowns 在系统边界上，不在算法里：**
   - AI 写的 PR 被 preflight 跳过（N1）；
   - coding agent 按 `missing_test` 补出来的测试是镜像测试，会把发现「洗」成 `covered`（N2）；
   - 每次 push 都全量重审（N3）；
   - 结果不稳定，加上 `resolve_stale` 自动关线程，会让线程反复开关（N4）；
   - QE 自己拿不到任何汇总视图（N11）。
7. **建议的下一步是一个零代码实验：** 用户从自己的缺陷系统取最近 50 个 QA 或生产缺陷，按 §6 P0-1 的表格分类。这一步决定上限，也决定该把投入放在哪一条轴上。在它之前，不要再加追溯机制。

## 2. 第一性原理：QE 视角的 shift-left 目标函数

| 因子 | 问题 | 当前证据 | 状态 |
|---|---|---|---|
| **上限 F** | 用户的 QA 或生产缺陷中，有多少在 PR 时刻能被静态看出来（逻辑、边界、校验、需求不符、测试缺口）？ | 只有 OSS 库的数据：holdout 池 69 对中 63 对 `scope=in`。库项目以逻辑为主，样本有选择偏差 | **用户的仓库未知** |
| **检出 D** | 范围内的缺陷有多少被命中？ | head-to-head：lean 7/12，copilot 风格 8/12，pocock 风格 9/12。n=12，差距在噪声内 | 召回不是优势 |
| **行动 A** | 命中之后，开发者有多少真的改了？ | 只有 judge 给的 `would_fix` 代理指标：lean 13/22=59%。从未测过 did-fix | **未测** |
| **成本差 ΔC** | 在 PR 发现比在 QA 发现省多少？ | 「1:100」是 leprechaun（`goal-first-principles.md` §3）。省下的主要是 QA 轮次和反馈周期，大小取决于 QA 在流水线中的位置（N6） | **未定义** |
| **代价 K** | 噪声、PR 变慢、token、合规 | 每次运行约 559k 累计输入 token（模拟值），比自由格式 review 多约 50%；从未测过 time-to-merge；每次 push 都重跑（N3） | 部分测过 |

推论：
- **净价值 = F·D·A·ΔC − K**。现在只有 D 有数据，而且是离线数据。
- 后续每一项工作都应回答：它改的是哪个因子，改多少。追溯功能改的是 D 中「需求不符」那一小部分，而这部分本身的占比（F 里的份额）没人测过。
- 这条式子也说明 SpecGuard 应该让 **A 尽量高、K 尽量低**，而不是追求 D 最高。这和 head-to-head 的结论一致：优势在精度，不在召回。

## 3. 对现有分析的批判

### C1 状态空间枚举 ≠ 频率加权

`goal-first-principles.md` §2 的矩阵作为**评测覆盖清单**是对的：每一行都应有一个用例。但它被当成了**投入优先级的依据**（「双向追溯不是附加功能」）。

决定优先级的应该是 *Σ 状态频率 × 该状态下缺陷的代价*。仓库里已有的频率证据都指向反方向：
- head-to-head：追溯贡献的 direct hit 为 0。
- holdout 池：确认在范围内的 13 对里，logic 8、validation 3、requirement_mismatch 2。这 2 对是同一个机制（`orpc-2098<-1705`、`<-1718`）。
- field study：12 个仓库里 7 个根本没有需求文档。

这三份数据都不代表用户的仓库，但它们是仓库里**仅有**的频率数据，而且方向一致。

### C2 「需求不符」的真实形态和机制的假设不一样

追溯 v1 的机制按「spec 文档里的数值被改了」来设计：`deltas`、带单位变体的出现位置表、30→45、2×→3×。种子用例 tr1–tr17 也几乎都是数值字面量。

回放池里真实的需求不符是另一种样子：
- `orpc-2098`：「Code disagrees with the **PR's own documented merge rule**」。
- `orpc-2057`：「Schema requires a field the handler never sends」。

两者的 R 都**在同一个 PR 或相邻的代码里**（PR 写下的规则、文档注释、schema），是语义层面的，不是数值。

**需要验证的假设：** 在这类 PR 里，R 有没有被我们自己的 collector 丢掉？非需求类的 `.md` 改动仍然会被 `collect.sh` 从 diff 里删掉。如果 PR 在 `docs/` 写了规则、在代码里实现错了，那么 R 恰好就在被删掉的那部分里。接手者应拿这三个 case 核对，看 R 实际放在哪个文件、collector 有没有保留它。

**构造效度问题：** 种子用例只覆盖机制擅长的形态，所以 tr 用例全过，也证明不了对真实需求不符有效。

### C3 理论自洽，数据反向，结论却没有改

`design.md` 末尾第 5 节已经写了「Traceability value is not proven on real repos」，head-to-head 也建议「tighten `trace: auto` to strong signals」。但默认值仍然是 `auto`，计划里排在后面的仍然是 WP7 变异基准和 WP8 SZZ（更多追溯评测），而不是先验证核心路径。

**发现了，但没有据此改决策。** 这是本文最想纠正的一点。

### C4 默认开启的功能违反了仓库自己的门槛

- 门槛：`traceability-plan.md` §7.2 要求 precision ≥90%、recall ≥80%。
- 现状：live 评测从未跑过。
- discovery 修复后的精度（strict 66%）来自一份**未提交的 harness 副本**，无法从仓库复现（`field-study.md` §7）。
- 风险：采用者第一次见到 SpecGuard，看到的可能就是一条噪声 `spec_mismatch`。需求类评论本来就是采纳率最低的一类（RevMate：功能类建议 5.2%）。

### C5 「shift-left」的参照系没有定义

「左」是相对于 QA 而言的。QA 在流水线里的位置决定 SpecGuard 是否真的更早：
- QA 测合并后的 staging 构建：PR 时刻确实更早。
- QA 在每个 PR 的 preview 环境里测：SpecGuard 和 QA 处在**同一时刻**，价值就变成「替 QA 省时间」，而不是「更早」。

还有比 PR 更左的点：本地 pre-push（仓库已经支持 `claude -p` / `copilot -p` 跑同一个 skill）；更左的是写需求的时候（N10）。这些点都没有被当作产品面来设计和测量。

### C6 原始需求只取了一种解读

见 N9（「confirmed」）、N10（「review requirements」）。这两处都是**用户才能裁决的**，仓库里没有记录用户确认过。

### C7 评测是自我参照的

- 被测的是 Sonnet 子 agent，裁判是三个 Sonnet adjudicator，同一家族；两轮裁判之间的差距（84% 对 100%）已经说明方差很大。
- 生产默认引擎是 Copilot `auto`，模型路由每次可能不同，而真实的 Copilot 从未在 head-to-head 里跑过。
- 有两样东西完全没有数据：严格 JSON 契约在被路由到的较弱模型上的失败率（也就是摘要显示「Could not complete」的比例），以及 adjudicator 与人工判断的一致率。

### C8 范围持续扩张，核心验收却停着

原始目标是 unit test review。目前在建或已建的还有：双向追溯、`spec_mismatch`、blame 历史意图、出现位置表、SZZ、变异基准、field harness、CCR 模式、竞品对比。

与此同时，`design.md` §9 的 **S4（引擎、org 计费）和 S6（3 个 pilot）都没有完成**。这些扩张没有一项能替代真实 pilot。按 ponytail 的标准：**目前被证明有价值的，正是最简单的那部分**，即 diff 范围内的测试缺口审查加确定性校验。

## 4. 「双向定位」的重新定位

### 4.1 追溯应是有条件的模块，不是默认能力

追溯的价值取决于一个前提：**团队是否采用 spec-driven development（SDD）**。

| 仓库类型 | R 在哪里 | 追溯的价值 | 默认行为（建议） |
|---|---|---|---|
| SDD 仓库：`.kiro/specs`、`openspec/`、Spec Kit `specs/`、带显式 ID 的需求、`.feature` | 仓库内，结构化 | **核心价值**：AI agent 按 spec 实现，spec 就是 R，场景 B 很常见 | 开 |
| 有零散「must」散文（README、指南）的普通仓库 | 文档里有，但是文档不是需求 | 低。命中多半是文档漂移，应由文档负责人处理（U17） | **关**，或只进摘要 |
| R 在 Jira、ADO、Confluence（企业 QE 的常态） | 仓库外 | 被「不加新 secret」的约束**结构性排除**（N8） | 靠 PR 模板把 R 带进 PR（§6 P1-1） |

所以 `trace: auto` 的触发条件应从「发现任何需求文档」收紧为「**发现强信号**」：SDD 目录、显式 ID 条目、Gherkin `.feature`。泛泛的 normative 散文默认不触发。这需要用户决定（§7 Q2）。

### 4.2 R 的来源按成本和精度重排

| 排序 | 来源 | 成本 | 精度 | 当前状态 |
|---|---|---|---|---|
| 1 | **PR 自身的声明**：PR 正文、同一 PR 改动的文档、docstring、schema | 0（已在手边） | 高：作者自己说的 | PR 正文已经收集；同一 PR 的非需求 `.md` 会被丢弃（C2 的假设） |
| 2 | **PR 模板里的 AC 段落**（流程改动，不写代码） | 0 代码 | 高 | `extractCriteria` 已能识别 AC 标题；缺的是模板本身和推广 |
| 3 | 关联的 issue | 低 | 中到高 | 已实现，但很多 PR 不关联 issue |
| 4 | SDD spec 目录、显式 ID 条目 | 中 | 中到高 | 已实现，混在泛化发现里 |
| 5 | 泛化 normative 散文 | 高（噪声） | 低（field study） | 默认开着，建议降级 |
| 6 | blame 找回的历史意图 | 中 | 低（可能已过时） | 已实现，属于可选来源 |

**要点：** 「把 R 捕获左移」本身就是 shift-left。让作者在 PR 里写下 AC，比事后用启发式去挖文档便宜，也准确。这是 QE 能直接推动的流程杠杆，不需要写代码。

### 4.3 还有一组被忽略的「双向」：开发者 ↔ QA

当前的信息只从 SpecGuard 流向开发者。QE 关心的另外两个方向都不存在：
- **向右，SpecGuard → QA：** 告诉 QA 哪些 PR、哪些 AC 只有 `needs_human`、`higher_level_only` 或 `unknown`，好让 QA 做基于风险的测试。目前没有汇总输出（N11）。
- **向左，QA → SpecGuard：** 逃逸缺陷回流成评测样本和规则（SZZ 是离线做法）。目前没有常态化机制。

对 QE 来说，这条闭环可能比需求和代码之间的双向更有价值。是否纳入范围由用户决定（§7 Q5）。

## 5. 新发现的 unknown unknowns（N1–N18）

视角：⑧ 系统边界（与其他工具和 agent 的交互），⑨ 经济性，⑩ 组织与流程，⑪ 度量有效性。①–⑦ 沿用 `goal-first-principles.md` §4.1。

| ID | 盲点 | 视角 | 影响 | 证据或状态 | 最便宜的验证 | 成本 |
|---|---|---|---|---|---|---|
| **N1** | **AI 写的 PR 被跳过。** `preflight.js:15` 跳过所有 `type==='Bot'` 或 `[bot]` 作者。若 Copilot coding agent 等 agent 以 Bot 身份开 PR，那么增长最快、最容易出现 C=T≠R 的 PR 来源正好不被审查 | ⑧ | 召回，覆盖面 | 代码已核实；agent 的 PR 作者类型**未核实** | 在用户的 org 里看一个 agent PR 的 `user.type`。可以考虑把 agent 与依赖机器人（Dependabot、Renovate）分开处理 | S |
| **N2** | **Goodhart 闭环。** coding agent，或赶时间的人，按 `missing_test` 的骨架补测试，期望值从实现里抄，发现就被「洗」成 `covered`。`goal-first-principles.md` 结论 3 说过 AI 测试容易固化错误，但没有想到 **SpecGuard 自己的评论会触发这种固化** | ⑧⑪ | 精度：错误的放心 | 未测 | 骨架的期望值必须引用 R 的原文（有 R 时）；R 缺失时，骨架用占位符而不是从代码推出的值（G4 占位规则已经存在，可以复用）；评测增加「按评论补镜像测试」的对抗用例 | S |
| **N3** | **成本随 push 次数增长，不随 PR 数增长。** 每次 `synchronize` 都全量重审，同一个 SHA 才会跳过。累计输入约 500k token/次，主要来自静态 prompt × 轮数（`token-anatomy.md`）。没有增量审查 | ⑨ | K | 未测每个 PR 平均 push 几次 | 用 `gh api` 统计 pilot 仓库每个 PR 的 push 次数；考虑只在 `ready_for_review` 或打标签时触发，或者只审上次审过之后的增量 | S–M |
| **N4** | **结果不稳定 × `resolve_stale`。** 同一个缺口这次报、下次没报，线程就被自动关掉，再下次又冒出来。线程反复开关会损害信任 | ⑧ | 采纳 | `resolve_stale` 默认开；U15 只测过稳定性，没测与自动关闭的交互 | 同一个 PR 连续空 push 3 次（`force: true`），统计线程开关次数 | S |
| **N5** | **评审到达时 PR 已经合并。** auto-merge 打开时，CI 一绿就合并，SpecGuard 最长 12 分钟，可能晚到 | ⑩ | A=0 | 未测 | pilot 中记录「评论时间晚于合并时间」的比例 | S |
| **N6** | **QA 在流水线中的位置**（见 C5），它决定 ΔC 的大小，以及「左移」是否成立 | ⑩ | 整个价值主张 | 未知 | 问用户 | 0 |
| **N7** | **上限 F 因组织而异。** OSS 库约 91% 在范围内；Web 应用的 QA 缺陷里，UI、集成、环境类可能占多数 | ⑩⑪ | 价值上限 | 只有 OSS 数据 | §6 P0-1：50 个缺陷的分类 | 0 代码 |
| **N8** | **企业的 R 在仓库外**（Jira、ADO、Confluence），「只用 GitHub Actions、不加新 secret」的约束把它排除在外。PR 标题里的 ticket key 能拿到，ticket 正文拿不到 | ⑩ | 需求轴在企业环境里拿不到输入 | 约束来自用户原话（被截断）；`design.md` 已拒绝 ticket key 解析 | 问用户 R 在哪里；可选方案：PR 模板（零 secret），或者一个可选的 tracker secret（违反约束，需要用户放行） | 0 / M |
| **N9** | **「coding standard has been confirmed」的字面读法**：PR 模板里「我已遵守编码规范」这一项有没有被勾选。这是一条确定性的流程合规检查，一个正则就够。当前实现的是 lint 证据加 AI 静态审查，没实现这一种 | ⑤ | 原始需求的符合度 | `research-goal-audit.md` 只提到「作者 checkbox 只能算人工声明」，没有问过用户 | 问用户三种读法要哪几种（§7 Q3） | S |
| **N10** | **「review requirements」的另一种读法**：审查需求本身是否可测试、有没有歧义。这是 QE 最经典的左移活动（three amigos）。当前把 R 只当作 oracle。U10 提过，但归在「扩展边界」 | ⑤ | 原始需求的符合度 | 未确认 | 问用户 | 0 |
| **N11** | **QE 拿不到汇总视图。** 输出只面向开发者（inline 评论和 sticky summary）。QE 作为买单方，需要按仓库或团队看趋势：缺口类别、处理率、AC 覆盖、`needs_human` 清单。数据其实已有（每次运行的 findings、fingerprint），只是没有落地 | ⑩ | 采纳，持续投入的理由 | 未实现 | 最小做法：每次运行上传一个 `findings.json` artifact，再写一个离线聚合脚本。不做 dashboard | S |
| **N12** | **`Unit evidence X/Y` 被当成 KPI。** 管理者会把它读成覆盖率，被考核之后会被刷 | ⑪ | 度量被扭曲 | 文案已写明是静态判断 | 摘要里加一句「不是覆盖率，不能用于考核」；聚合视图不展示比值排名 | S |
| **N13** | **评测引擎 ≠ 生产引擎。** Copilot `auto` 的路由不确定，严格 JSON 的失败率、轮数、超时率在真实 org 里都没测过 | ⑪ | D 和可用性 | `design.md` 第 9 节 Open items：「No real Copilot run」 | pilot 记录每次运行的完成状态、轮数、耗时 | S |
| **N14** | **测试层级和 pushdown 的定义因组织而异。** pyramid 和 trophy 两种策略本来就有分歧；Pocock 的 tdd 倾向于走公开接口的集成测试。pushdown 可能违背团队的测试策略 | ⑤ | 精度 | `design.md`：「Pushdown suggestions are not validated」 | 层级定义从仓库的标准文件读取；没有定义时，pushdown 只进摘要 | S |
| **N15** | **代码外发的合规问题。** 企业的数据政策可能直接禁止把代码发给 Copilot 或 Anthropic | ⑩ | 能否采用 | `design.md` §12 Q3 一直没有答案 | 问用户 | 0 |
| **N16** | **多个机器人的评论叠加。** 原生 CCR、SpecGuard、CodeRabbit 等同时评论，没有跨工具去重 | ⑧ | K | 「Not in v1」里有同行去重的触发条件 | pilot 中统计每个 PR 的机器人评论总数 | S |
| **N17** | **SZZ 看不见的缺陷。** QA 在 PR 或 preview 阶段发现、并在同一个 PR 里修掉的缺陷，不会出现在主干历史里。如果用户的 QA 是在 PR 阶段测的，L4 回放恰好漏掉 shift-left 的目标样本 | ⑪ | 评测有效性 | 未讨论 | 结合 N6，从缺陷系统取样，而不是只从 git 历史取 | 0 |
| **N18** | **`would_fix` ≠ did-fix。** 现在用 judge 判断「会不会改」。真实的修复率可以确定性地算出来：某个 fingerprint 在 SHA n 出现，在 SHA n+1 消失，并且其锚点行被改过 | ⑪ | A 的测量 | `resolve_stale` 已经在比较 fingerprint，但没有记录 | 在 N11 的 artifact 里加 fix-through 字段 | S |

**优先级：**
- P0：N6、N7、N8、N9 只需要向用户提问或做分类，不写代码，但会改变后面所有决策。
- P1：N1、N2、N3、N13 决定 pilot 的结论能不能信。
- P2：其余，等 pilot 数据出来再定。

## 6. 建议的执行顺序

### P0：先测上限，再决定往哪里投入（零代码或极少代码）

1. **对 50 个缺陷做分类（由用户执行，接手者提供表格）。** 从用户的 issue tracker 取最近 50 个 QA 或生产缺陷，每个填下表：

   | 字段 | 取值 |
   |---|---|
   | 发现阶段 | PR、QA（PR 前 / PR 后）、生产 |
   | 静态可见 | 是 / 否（原因：环境、集成时序、UI、性能、第三方） |
   | 类别 | 逻辑、边界、校验、错误处理、需求不符、缺测试 |
   | 当时有没有写下来的 R | PR 正文、issue、spec、无；R 在哪个系统 |
   | 一个单元测试能否拦住 | 是 / 否 / 只有集成测试能 |
   | 引入它的 PR 能否找到 | 是 / 否 |

   **决策规则（建议，由用户确认）：**
   - 「需求不符」且「R 写在仓库内」的占比低于 10%：追溯改为 opt-in，资源回到测试缺口和流程。
   - 「静态可见」低于 40%：对外重新说明 SpecGuard 的定位（只拦逻辑类缺陷），QE 价值主张转向 N11 风险报告。
   - 「R 在 Jira 等」占多数：先做 PR 模板（P1-1），而不是继续做文档发现。

2. **决定 `trace` 的默认值（用户决定）。** 三个选项：
   - (a) 改为 `off`，需要的人显式打开；
   - (b) 只在强信号下开启（SDD 目录、显式 ID、`.feature`）；
   - (c) 保持 `auto`。

   建议 **(b)**，并在 tr 用例的 live eval 过门槛之前，把 `spec_mismatch` 限制为只进摘要。

3. **在用户的真实仓库里跑 pilot（S6）。** 用生产引擎（Copilot），跑 2–4 周。每次运行记录：
   - 完成状态（N13）、轮数、耗时；
   - 评论是否晚于合并（N5）；
   - 每个 PR 的 push 次数和运行次数（N3）；
   - 每个 PR 的机器人评论总数（N16）；
   - fix-through（N18）；
   - 按类别的处理率和驳回率。

   需要的最小代码改动只有 N11 那个 artifact。

### P1：便宜的杠杆

1. **PR 模板（流程改动）。** 加一个「Acceptance criteria」段，以及「我已遵守编码规范」勾选项（N9，取决于用户的回答）。
   - 已有：`requirements.js` 的 `extractCriteria` 能识别 AC 标题。
   - 要补：勾选项检查是一个确定性正则，结果写进摘要的 Standards 一节，标注为「作者声明」，和 lint 证据分开显示。
2. **核实 C2 的假设。** 拿 `orpc-2098<-1705`、`<-1718`、`orpc-2057<-1721` 三个 case，看 R 所在的文件有没有被 `collect.sh` 丢掉。如果被丢了：同一个 PR 改动的非需求文档以「PR 自身声明」的身份进入上下文，只读不审（不产生文档类发现）。
3. **防 N2。** 骨架的期望值必须出自 R 的原文；没有 R 时用占位符。评测增加一个对抗用例：agent 按评论补了镜像测试，SpecGuard 不应把它判成 `covered`。
4. **控制 N3。** 先拿到 push 次数的数据，再从三个选项里选：只在 `ready_for_review` 时触发、只在打标签时触发、只审增量。
5. **决定 N1。** 确认 agent PR 的作者类型之后，单独为它设一个开关。

### P2：等 pilot 有数据再做

- WP7 变异基准、WP8 SZZ 回放：在 P0-1 分类表明需求不符占比够高之后再做。SZZ 的样本应来自缺陷系统（N17）。
- N11 的聚合视图做成离线脚本就够了，不做 dashboard。
- 原生 CCR 去重、阻断模式：按 `design.md` §11 原有的触发条件。

### 不要做（直到对应门槛被数据触发）

- 不加 embeddings、tree-sitter、co-change、索引缓存（`traceability-plan.md` §8 已把它们设为门槛触发的升级）。
- 不新增追溯类的 finding kind，也不扩充 tr 种子用例。在 C2 的构造效度问题解决之前，再多的种子用例也证明不了真实价值。
- 不拿 Sonnet judge 的结果对外宣称精度（C7）。

## 7. 需要用户回答的问题

按影响从大到小排列；每题附上答案会改变什么。

| # | 问题 | 答案会改变什么 |
|---|---|---|
| Q1 | **请重新粘贴被截断的约束列表（Pasted text #7）。**「Git…」指的是 GitHub Issues、Wiki，还是 Git 历史？后面还有第 3 条吗？ | §4.2 的排序、N8 |
| Q2 | 你们的 R 主要写在哪里：PR 正文、GitHub Issues、仓库里的 spec，还是 Jira、ADO、Confluence？团队有没有采用 SDD（Kiro、Spec Kit、OpenSpec）？ | 追溯是核心能力还是 opt-in；`trace` 的默认值（P0-2） |
| Q3 | 「coding standard has been confirmed」指哪一种：(a) 作者在 PR 模板里勾选了确认；(b) lint 和 format 工具通过了；(c) AI 按规范审查了 diff？可以多选 | N9 是否要做；README 的表述 |
| Q4 | 「review requirements」是否包括审查需求本身是否可测试、有没有歧义？ | N10 和 U10 是否进入范围 |
| Q5 | QA 在你们流水线里的位置：测合并后的 staging，还是测每个 PR 的 preview 环境？你作为 QE，希望从工具拿到什么：只要给开发者的评论，还是也要给 QA 的风险清单和趋势？ | ΔC 是否成立（C5、N6）；N11 和 §4.3 是否进入范围 |
| Q6 | 能不能提供最近 50 个 QA 或生产缺陷做分类？能不能在一个真实仓库上跑 pilot？ | P0-1、P0-3 能否执行 |
| Q7 | 团队有没有用 coding agent 开 PR？这些 PR 是否要审？ | N1、N2 |
| Q8 | 公司政策是否允许把代码发给 Copilot 或 Anthropic？ | N15，是否能采用 |

## 8. 给接手 session 的任务清单

| # | 任务 | 前置 | 验收 |
|---|---|---|---|
| H1 | 把 §7 的 Q1–Q8 交给用户，答案写回本文 §7 | 无 | 每题有答案或「未知」，并注明日期 |
| H2 | 按 P0-1 写分类表格（CSV 模板加填写说明）交给用户 | 无 | 用户能直接填 |
| H3 | 核实 C2：三个 orpc case 中 R 所在的文件，以及 `collect.sh` 是否丢弃了它 | 无 | 写出结论：丢了或没丢，并给出文件路径 |
| H4 | 核实 N1：Copilot coding agent 开的 PR，其 `user.type` 和 `login` 是什么 | 需要样例 PR | 给出 API 返回值 |
| H5 | 根据 Q2 的答案，写一份 `trace` 默认值变更的规格；实现交给 Sonnet | Q2 | 规格里写清触发条件和 `spec_mismatch` 的出口（inline 还是摘要） |
| H6 | 写 N11 加 N18 的最小 artifact 规格：每次运行一个 JSON，包含 findings、fingerprint、完成状态、轮数、耗时、合并时间 | 无 | 规格交给 Sonnet；聚合脚本有一个 `node:test` |
| H7 | 根据 Q3，写 PR 模板和勾选项检查的规格 | Q3 | 勾选项结果在摘要里与 lint 证据分开显示 |
| H8 | 根据 Q5 和 Q6，制定 pilot 计划（仓库、时长、记录字段） | Q5、Q6 | 和 P0-3 的字段一一对应 |

## 9. 已核实与未核实

**本 session 核实过（读了代码或数据）：**
- 原始目标原文：`docs/design.md:38-47`。
- `trace` 的默认值是 `auto`：`action.yml:20`。
- preflight 跳过 Bot 作者：`src/preflight.js:15`。
- 触发器包含 `synchronize`，仓库里没有增量审查的代码。
- tr live eval 未跑：`docs/design.md:432`。
- head-to-head 的数字和「追溯贡献 0 个 direct hit」：`docs/competitors/head-to-head.md`。
- holdout 池的分布：69 对，其中 confirmed 且 in-scope 的 13 对为 logic 8、validation 3、requirement_mismatch 2，这 2 对都是 orpc-2098，`scope_reason` 为「Code disagrees with the PR's own documented merge rule」。来源：`eval/replay/holdout-pairs.json`。
- field study 修复后的数字无法从已提交的 harness 复现：`docs/field-study.md` §7。

**未核实，引用前要回到原处核对：**
- Copilot coding agent 的 PR 作者类型（N1）。
- 每个 PR 平均 push 几次（N3）。
- C2 中 R 是否被 collector 丢弃（H3）。
- 外部研究数字：沿用 `goal-first-principles.md` §3 中已标注「未核实」的那些。
