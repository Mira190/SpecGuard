# SpecGuard 目标的第一性原理分析与 Unknown Unknowns

日期：2026-10-09。

**范围**
- 原始目标：unit test review。
- 用途：shift-left 质量工程。
- 新增需求：需求 ↔ 代码双向追溯。

**依据**
- 对当前代码的核对：`collect.sh`、`requirements.js`、`post.js`、`SKILL.md`。
- 六路调研，含学术文献、工业实证、现有工具、GitHub Actions 可行性和盲点技术。
- 配套实现计划：`docs/traceability-plan.md`。

本文只做分析，不改运行时代码。凡标注「未核实」的数字，均来自二手资料或检索摘要，引用前须回到原文核对。

## 0. 结论

1. **QA 关心的逻辑缺陷，都可以描述为三个工件之间的不一致或缺失。** 三个工件是需求 R（意图）、代码 C（实现）、测试 T（验证），另有一组规则 S。原始目标里的每一条，都落在这个 R–C–T 三角的某一条边上（见 §1.3）。
2. **SpecGuard 的边际价值，是那些 CI 跑绿了却仍然是错的缺陷。** CI 只能证明 C 与 T 一致；只有把 R 拉进来，才能判断这一致是否正确。
3. **当前系统没有 R 的时候，`covered` 实际上只表示「测试与代码一致」（verification），不表示「行为正确」（validation）。** 当测试从实现反推出来时，错误会被测试固化。AI 生成的测试最容易这样。
4. **需求的两个场景，恰好是当前系统处理错的两个「CI 绿」状态（见 §2）。**
   - 场景 B（只改了需求）：被 `collect.sh:44` 直接跳过。
   - 场景 A（代码与测试一起改了、需求没改）：被标成 `covered`，给出错误的放心。

   所以双向追溯不是附加功能。它补的是原始目标「review requirements and the tests」里 oracle 缺失的那一半。
5. **按影响排，最需要先处理的 unknown unknowns 有五个（§4）：**
   - 把既有漂移算到本 PR 头上；
   - 测试的预期值本身错了（C=T≠R）；
   - 修改只同步到了部分位置；
   - 实现不在本仓库；
   - 单位和边界的等价换算。

   这五个都能用确定性手段低成本处理。
6. **证明 shift-left 有效的直接方法是回放。** 用 SZZ 从 QA 或生产缺陷反查引入它的 PR，回放 SpecGuard，看它能不能在那个 PR 上提前发现（§6）。种子用例只能证明机制可行，不能证明价值。

## 1. 目标拆解

### 1.1 原始目标（原文）

> Create a unit test review AI GitHub Workflow. Must review requirements and the tests, and identify missing unit tests. 1. Must check coding standard has been confirmed too. 2. If possible — review other testing like component or integration testing and see what can and should be in the unit testing.

目的是 shift QA left：在 PR 阶段、QA 拿到构建之前，抓住测试缺口和需求偏差。

### 1.2 第一性原理：QA 到底在判断什么

QA 判断的是「实际行为 = 预期行为」。PR 时刻，静态审查能看到四样东西：

| 工件 | 含义 | 在仓库或 PR 里的位置 |
|---|---|---|
| R 意图 | 应该做什么 | PR 正文、issue、spec/Gherkin/ADR、历史 PR 和 issue、测试名、注释、用户可见文案 |
| C 实现 | 实际做什么 | 源码、配置、迁移、特性开关、模板、其他服务 |
| T 验证 | 用什么证明 C 符合 R | 各层测试、快照、golden 文件 |
| S 规则 | 怎么写 | 仓库的标准文件，以及 lint/format 检查 |

逻辑类缺陷有五种形态：

| 缺陷形态 | 现有检查 |
|---|---|
| R 有，C 没实现 | 未实现 |
| C 与 R 矛盾 | 违反需求 |
| C 变了，没有 T | `missing_test` |
| T 约束不住 C | `weak_test` |
| T 断言的值与 R 矛盾 | **当前没有检查** |

此外，同一个 R 可能落在多处 C，只改了其中一部分（partial propagation）。

### 1.3 原始要求与三角的边

| 原始要求 | 对应的边 | 现状 | 缺口 |
|---|---|---|---|
| review requirements and the tests | R→T | `requirements[]`、`coverage[]`、逐条 AC 清单 | R 只来自 PR 和 issue；仓库内的 spec 与历史意图都没有用上 |
| identify missing unit tests | (R ∪ ΔC)→T | `missing_test`，以及 `from behaviour` 义务 | 需求变了但代码没动时（场景 B）整个 PR 被跳过 |
| 隐含要求：测试测的是对的东西 | T 的 oracle 是否来自 R | `weak_test` 只看 T 能否约束 C | **C=T≠R**：测试与代码一起错时会被判成 `covered` |
| coding standard confirmed | S→C，加执行证据 | standards 维度和 `inspectChecks` | 已由 goal audit 处理 |
| component/integration → unit | T 的层级 | `higher_level_only` 加 `pushdown` | 无 |
| shift-left（目的） | 在 QA 之前发现 | advisory PR review | 价值从未测量过（§6） |

### 1.4 范围声明

静态审查不执行代码，也没有运行环境，所以它看不见以下几类问题：
- 环境或配置组合问题；
- 集成时序问题；
- 用户体验和性能问题；
- 跨服务契约问题。

SpecGuard 覆盖的是「逻辑加需求」这一类缺陷，对外的说明应写清这一点。追溯功能让这一类覆盖得更完整，但不会扩大它的边界。

## 2. 核心推论：价值在 CI 看不见的地方

CI 跑测试，所以 CI 绿意味着 C≈T。一个只盯 C 与 T 的审查者，大部分发现 CI 自己也能发现；它独有的价值，是在 CI 绿的状态里引入 R。

下表列出单个受需求约束的行为的状态空间。v0 是旧值，v1 是新值，∅ 表示不存在，「改」表示本 PR 修改了它。

| # | R | C | T | CI | 当前 SpecGuard | 应有结论 |
|---|---|---|---|---|---|---|
| 1 | v1 改 | v1 改 | v1 改 | 绿 | covered | 一致，且被测试覆盖 |
| **2** | v1 改 | v0 | v0 | **绿** | **跳过（`collect.sh:44`）** | **场景 B**：实现和测试都过时了 |
| 3 | v1 改 | v1 改 | v0 | 红 | weak/missing | CI 已经能发现，只需补充定位信息 |
| 4 | v1 改 | v0 | v1 改 | 红 | 跳过或部分处理 | CI 已经能发现 |
| **5** | v0 | v1 改 | v1 改 | **绿** | **covered（错误的放心）** | **场景 A**：违反需求，或 spec 没有同步 |
| 6 | v0 | v1 改 | v0 | 红 | weak_test | CI 已经能发现 |
| 7 | v0 | v1 改 | ∅ | 绿 | missing_test | missing_test，并指出违反需求 |
| 8 | ∅（未找到） | v1 改 | v1 改 | 绿 | covered（from behaviour） | 可能存在隐藏需求，见 §4 的 U7 历史意图 |
| 9 | ∅ | v1 改 | ∅ | 绿 | missing_test | 不变 |
| 10 | 新增 AC | ∅ | ∅ | 绿 | missing_test 或 unknown | 需求未实现 |
| **11** | 在 BASE 已与 C 不一致 | v0（未动，PR 只改了附近） | 任意 | 绿 | 未定义 | **pre-existing**：只进摘要，不算到本 PR 头上 |
| **12** | v1 改 | C1=v1，C2=v0 | 只测了 C1 | **绿** | 只看到 C1 | **部分同步**：列出 C2，以及同样过时的文案、配置、快照 |

从表中可以读出三点：
- CI 红的那几行（3、4、6），SpecGuard 的边际价值低，排序时应往后放。
- CI 绿的那几行（2、5、7、8、11、12）才是 shift-left 的价值所在。当前系统在 2、5、11、12 上判断错误或看不见。
- 这张表本身就是评测矩阵：每一行对应一个种子用例（§6 L1），所以覆盖度由构造保证，不靠事后挑选。

## 3. 实证：该投入什么，噪声能容忍多少

| 证据 | 来源 | 推论 |
|---|---|---|
| 已修改但未被测试的代码，缺陷率约为未修改代码的 5 倍；超过 70% 的现场缺陷出在未测试的代码里 | CQSE/Teamscale 的 Test Gap Analysis（[AST'13](https://wwwbroy.in.tum.de/publ/papers/AST13Hauptmann.pdf)、[2016 实践报告](https://teamscale.com/hubfs/26978363/Publications/2016-did-we-test-the-right-thing-experiences-with-test-gap-analysis-in-practice.pdf)）。数据来自厂商自己的案例，未核实原表 | 针对已修改行为的 `missing_test` 仍是主干，追溯功能不能挤掉它 |
| 「需求不完整或隐藏」是最常被提到的问题（48%） | NaPiRE（[arXiv 1612.00163](https://arxiv.org/pdf/1612.00163)） | 需求缺口很常见，但多数发生在 PR 之前。PR 机器人只能暴露「已写下的需求」与代码之间的差距，并标出歧义 |
| 82.3% 的项目在历史上有过过时的代码引用文档 | Tan et al.（[arXiv 2212.01479](https://arxiv.org/pdf/2212.01479)） | **spec 不是真理**：追溯链接只能当作待核实的主张。仓库里的 spec 已经漂移时，必须有差分机制（U1），否则噪声会淹没一切 |
| 只有约 19% 的团队用 BDD；正式需求文档很少见（缺少可靠数据） | State of Agile（二手，未核实）、[Patkar 2022](https://scg.unibe.ch/assets/archive/papers/Patk22b.pdf) | 多数仓库里没有 spec 文件。**PR 正文、issue 和历史意图**才是主要的需求来源（U7） |
| 一般 LLM review 评论的采纳率约 7–20%；重构类建议（18.6%）远高于功能类（5.2%） | RevMate，Mozilla/Ubisoft（[arXiv 2411.07091](https://arxiv.org/html/2411.07091v1)） | 功能类、需求类断言最难被接受，所以要给出最强的证据：两端都有原文引用，并由确定性校验 |
| 73.8% 的评论被处理，但 PR 关闭时间从 5h52m 增加到 8h20m | Beko/Qodo，ICSE SEIP 2025（[arXiv 2412.18531](https://arxiv.org/abs/2412.18531)） | 除了处理率，还要测 time-to-merge |
| AI 补丁只展示给作者时，评审不再变慢 | Meta MetaMateCR（[arXiv 2507.13499](https://arxiv.org/abs/2507.13499)） | 发现应面向作者，不进入评审者的关键路径（与现有 COMMENT 方式一致） |
| 在 diff 上报告的问题修复率约 70%，离线批量报告约 0% | Meta Infer（[CACM 2019](https://cacm.acm.org/magazines/2019/8/238344-scaling-static-analyses-at-facebook/pdf)） | **只报告本 PR 引入的问题**。既有问题只进摘要 |
| 控制测试套件规模后，覆盖率和变异分数与真实缺陷检测只有弱到中等的相关 | Inozemtseva & Holmes ICSE 2014、Papadakis et al. ICSE 2018 | 覆盖率和变异分数只能用来指出方向，不能当作判决（与 design.md 中 L2a/L3b 的定位一致） |
| 「1:100 修复成本曲线」证据不足 | Bossavit，*Leprechauns of Software Engineering* | 对外表述不要用这个数字 |

**噪声预算**：按上述数据，每个 PR 的需求类 inline 评论应控制在个位数，只放「本 PR 引入的、两端都有引用的」不一致，其余进摘要。这是基于数据的设计假设，需要在 pilot 中验证。

## 4. Unknown unknowns

### 4.1 挖掘方法

用 Rumsfeld 矩阵，从七个视角系统地扫，而不是靠灵感：

| 视角 | 要问的问题 |
|---|---|
| ① 三角状态空间（§2） | R/C/T 的每种组合下，结论都对吗？ |
| ② 信息在哪里 | R、C、T 各自可能写在哪些地方？哪些地方我们没读？（这一类是「已知但没用上的知识」） |
| ③ 表示等价 | 同一个值或规则，有多少种写法？ |
| ④ 时间 | BASE 与 HEAD 的差异、分阶段发布、版本 |
| ⑤ 权威与人 | 两边不一致时谁说了算？谁来处理这条评论？ |
| ⑥ 对抗 | 恶意或不当的 PR 内容 |
| ⑦ 实证回放 | 真实漏到 QA 的缺陷，我们为什么会漏？只有这个视角能找到真正的 unknown unknowns |

### 4.2 盲点清单

精度是 P，召回是 R；成本按 S/M/L 分级。

| ID | 盲点 | 视角 | 影响 | 现状 | 对策 | 成本 |
|---|---|---|---|---|---|---|
| **U1** | **既有漂移被算到本 PR 头上**：BASE 时 spec 与代码已经不一致，PR 只是动了附近的代码 | ④ | P，最大的精度风险 | 无差分概念 | 增加 `since: introduced\|pre_existing`。确定性规则：需求条目和行为引用行都不在 diff 里时，不能标为 introduced。pre_existing 只进摘要 | S |
| **U2** | **错误的 oracle（C=T≠R）**：测试与代码一起改了，与需求矛盾，却被判为 covered | ① | P，错误的放心 | `covered` 只要求单元断言 | 规则：`alignment=mismatch` 时状态不能是 covered；用 `spec_mismatch` 替代那一条 missing 或 weak 发现 | S |
| U3 | 只改了 spec 的 PR 被跳过 | ① | R | `collect.sh:44` | spec 文档进入可审查范围（见计划） | S |
| **U4** | **部分同步**：同一个值出现在前端、后端、配置、i18n 文案、快照、邮件模板里，只改了一处 | ①② | R，最大的召回收益 | 不可见；`*.snap` 和 `__snapshots__` 被默认忽略 | 确定性的「旧值出现位置表」：全仓 grep 旧值及其单位变体，范围包括快照、i18n 和配置，并标注本 PR 是否改到 | S–M |
| **U5** | **实现不在本仓库**：在远程配置、特性开关平台、另一个服务里，搜不到就被误报为「未实现」 | ② | P | 无 | 增加 `alignment=not_verifiable`，必须列出搜过的范围；未穷尽配置、迁移和 schema 时，不允许报 mismatch | S |
| **U6** | **表示等价**：30 天 = `2592000000` ms = `P30D`；「超过 30 天」对应 `>` 而不是 `>=`；自然日与工作日；时区；舍入 | ③ | P 和 R | 无 | 由 collector 生成单位变体；`references/trace.md` 给出归一化清单，比较之前先写出归一化后的值；边界两侧都要有测试（29/30/31） | S |
| **U7** | **历史意图（已知但没用上）**：没有 spec 的仓库，需求其实写在当初引入这行代码的 PR 和 issue 里 | ② | R，在 spec 少的仓库里覆盖面最大 | 未使用 | 对被修改行做 BASE 的 `git blame`，得到 commit，再查对应的 PR，再取其关联 issue，作为可选需求来源（最多 3 个，引用由 post 核对） | S–M |
| **U20** | **PR 不关联 issue，正文也很单薄**：需求来源 1、2、4 都依赖 PR 正文或 issue 关联，很多仓库两样都没有 | ② | R，否则场景 A 只剩 from behaviour | 只读 PR 正文和关联 issue | 仓库内需求文档按**内容**发现，范围是全仓，不再按 glob 卡门槛。根目录 README、代码旁的 RULES.md、`.kiro/specs`、`openspec/` 都能自动识别；glob 只用于排序，`requirements_paths` 只用于补充或排除；读不了的 docx/pdf 需求文件列入 limitations。详见计划 §4.0 和 §4.1.1，用例 tr16 和 tr17 | S |
| U8 | 测试名、注释、用户文档里写着需求（测试即规格） | ② | R | agent 会读到，但不作为需求来源 | 允许把它们引作「隐含需求」，标为 `inferred`，只进摘要 | S |
| U9 | 多个需求来源互相矛盾（issue 说 45，spec 说 30） | ⑤ | P | 无 | 报告来源冲突本身，不替人裁决哪边对（意图信号只用来提示方向） | S |
| U10 | 需求本身有歧义、无法测试（「30 天内」从哪一天算起？） | ⑤ | P | 无 | 标为 `needs_human`，说明歧义在哪里。这本身就是一种 QE 发现，但是否做成独立 kind 需要先测量 | S |
| U11 | 分阶段发布：spec 先改，代码在后续 PR；或者靠特性开关、版本化 API 让新旧值并存 | ④ | P | 无 | PR 正文里有「follow-up #N」或 flag 时降级处理；涉及版本或开关时标 not_verifiable | S |
| U12 | 非功能需求、否定性需求（「不得记录 PII」），无法落到具体某一行 | ② | — | — | 归入 `needs_human`，明确不在范围内 | 0 |
| U13 | 测试存在，但没被运行（被 skip、被排除、CI 没跑到） | ② | P | 纯静态判断 | design.md 里的 L2a：读取消费方 CI 已有的 coverage 和 JUnit 产物，作为指向证据 | M |
| U14 | 重命名或移动文件，导致 BASE 和 HEAD 对不上 | ④ | P | collect 使用 `--no-renames` | 差分判定时启用 `-M` | S |
| U15 | 同一个 PR 每次运行结果不同 | ⑦ | P | stability 运行过 12/12 | 测量每条发现的 Jaccard 稳定度；必要时才做多数投票（代价是 N 倍 token） | M |
| U16 | 评测真值太小，又是人工挑的，召回从未被测过 | ⑦ | 评测有效性 | 14 + 7 个种子用例 | §6 的 L2/L3：变异生成和历史回放 | M–L |
| U17 | spec 不一致该由 PO 或 spec 负责人处理，评论却只到了开发者 | ⑤ | 采纳率 | 无 | 在摘要里列出该 spec 文件的 CODEOWNERS（只读、确定性） | S |
| U18 | 加了 review 之后 PR 变慢（Beko +42%） | ⑤ | 采纳率 | 未测 | pilot 记录 time-to-merge 和按类别的处理率 | 流程 |
| U19 | spec 被 PR 修改去「合法化」违规代码 | ⑥ | — | — | 这正是需要人来看的情况。`reflected_in.spec=true` 加上「spec 在本 PR 内修改」的提示即可。spec 文本仍然只当数据 | 0 |

### 4.3 优先级

| 级别 | 项目 | 说明 |
|---|---|---|
| P0（随追溯 v1 一起做） | U1 差分、U2 错误 oracle、U3 只改 spec 的 PR、U4 出现位置表、U5 not_verifiable、U6 归一化、U14 重命名、**U20 按内容发现需求文档** | 全部是确定性规则或几十行代码，直接决定精度 |
| P1 | U7 历史意图（依赖 PR 正文；关联了 issue 时更强，但不依赖关联）、U8 隐含需求、U9 来源冲突、U11 分阶段发布 | 低成本，扩大适用面 |
| P2（达到门槛才做） | U13 覆盖率产物、U15 多数投票、U17 CODEOWNERS、U10 歧义独立成 kind | 需要 pilot 数据来证明值得做 |

## 5. 对设计的修订

已写入 `docs/traceability-plan.md`：
- **差分判定**：`since` 字段，以及确定性的降级规则。
- **新增 alignment 状态**：`not_verifiable`，必须附上搜索范围。
- **错误 oracle 规则**：`mismatch` 不能是 covered，由 `spec_mismatch` 顶替那一条 missing 或 weak 发现。
- **出现位置表**：在 collector 里生成，涵盖旧值的单位变体以及快照、i18n、配置文件。
- **历史意图来源**：blame → PR → issue，作为可选需求，不强制评估。
- **归一化清单**：并入 agent 指南。
- **评测扩充**：对应 §2 的状态矩阵。另加两个确定性生成器：spec 变异和代码变异，并配无操作对照与一致修改对照。

## 6. 评测：怎样证明 shift-left 有效

| 层级 | 方法 | 证明了什么 | 成本 |
|---|---|---|---|
| L0 | `node:test` 确定性测试，包括候选召回 recall@8 | collector 和 validator 的机制正确 | 已有体系 |
| L1 | 状态矩阵种子用例（§2 的 12 行，每行一个 case，外加对抗用例） | 结论逻辑完整，覆盖度由构造保证 | M |
| L2 | 在真实 OSS 仓库上做变异生成：改 spec 里的值，预期找到代码和测试；改代码里的值或比较符，预期 spec 被标出；无操作重构作对照，不应报告；spec、代码、测试一致修改作对照，不应报告。真值取自旧值出现位置表，并抽样人工复核等价变异 | 真实规模下的召回和误报率 | M |
| L3 | 历史回放：挖出同时修改 spec 和代码的提交，回滚其中一边构造正例，原提交作为反例 | 真实分布下的表现 | L |
| **L4** | **SZZ 回放**：从 issue tracker 里 QA 或生产发现的 bug 出发，用 SZZ 算法（Śliwerski、Zimmermann、Zeller，MSR 2005）找到引入它的 PR，在那个 PR 上回放 SpecGuard | **直接测量原始目的：有多少 QA 发现的缺陷能在 PR 阶段被拦下** | L（需要有 bug 标签的 pilot 仓库） |
| 现场 | 按类别统计处理率和驳回率、每个 PR 的评论数、time-to-merge 的变化 | 采纳度和代价 | 流程 |

门槛沿用 design.md：高置信度精度 ≥80% 才讨论阻断模式。需求类发现的门槛更严（计划中 ≥90%），因为它最难被接受。

L2、L3 和 L4 的可执行方案已写入 `docs/traceability-plan.md` §7.4，对应的工作包是 WP6–WP8：
- **WP6 外部仓库评测模式**：镜像仓库，通过合并的方式注入 workflow，复制需求上下文。
- **WP7 变异基准**：由人工确认需求、代码、测试三者的对应关系，共 8 种变异算子（含 3 组对照）。
- **WP8 SZZ 回放**：人工确认缺陷与引入它的 PR 的对应关系，回放前先判定缺陷是否在范围内，再按 direct、indirect、miss 三档裁定，并用无缺陷 PR 作为噪声基线。

每个场景都分别以 `trace: off` 和 `trace: auto` 运行，直接测出追溯功能带来的增量价值。

## 7. 需要你确认的问题

1. 需求原文的约束列表在「Gherkin, Git…」处被截断，第 3 条及以后是什么？「Git…」是指 GitHub Issues、Wiki，还是 Git 历史？如果是 Git 历史，U7 应提升到 P0。
2. 有没有带 QA 或生产缺陷标签的 pilot 仓库？这决定 L4（最直接的价值证明）能不能做。
3. 需求类发现的 inline 预算：建议每个 PR 不超过 5 条，只放 introduced 且高置信度的，其余进摘要。可以接受吗？
4. U10「需求歧义」是否要作为一种 QE 发现单独报出来？它扩展了原始目标的边界，所以需要你来决定。
