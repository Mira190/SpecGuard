# 全仓审计 summary 模板：调研、批判与字段规则（2026-10-22）

样板：[`templates/repo-audit-summary.mock.md`](templates/repo-audit-summary.mock.md)（mock 数据；产品输出一律英文）。
本文回答四件事：读者要什么（§1）、对需求的批判（§2）、业界怎么做（§3）、每个字段怎么算（§4）。§5 列 unknown unknowns，§6 对照现有 `src/audit-post.js` 列出差距和实现顺序。

旧模板 [`templates/repository-shift-left-report.md`](templates/repository-shift-left-report.md) 是写给人工审计员的 12 节填空表，字段很全，但它不是给测试者看的 summary。新模板取代它作为产品输出；旧模板留作人工深审的清单。

## 1. 第一性原理：测试者打开报告，要在一分钟内知道什么

读者是测试者 / QA lead。他读这份报告只为了决定下一步做什么。所以报告只有三个问题要回答，顺序固定：

1. **这份报告可信吗？** 范围有没有审完，用了哪些证据（有没有覆盖率报告、CI 历史、需求文档），哪些数字是"没测到"而不是"零"。
2. **先做哪几件事？** 最多 10 条，每条一个动词（Add / Strengthen / Move down / Make CI run / Fix or delete / Clarify / Check），带位置、理由、证据等级、负责人。
3. **风险集中在哪？** 每个领域一行：状态、要处理的数量、证据等级。细节折叠。

由此推出的设计规则：

- **可见部分只放会改变下一步行动的内容**（owner 10-13 的规则：summary 只放可行动内容）。每个领域的明细放进 `<details>`，但 `<summary>` 行本身带关键数字，不展开也能看到全貌。
- **每条发现标证据等级**：E = 执行证据（覆盖率报告、CI 结果）、S = 确定性静态规则、M = 模型判断。排序时 E/S 永远排在 M 前面。理由是我们自己测过：覆盖率缺口在行级 100% 正确（A3），模型的 missing_test 只有 0–15%（A3）、24%（E3 基线）；稳定性 Jaccard 0.17（A1）。把 M 级发现和 E 级混排，等于用低精度结论稀释高精度结论。
- **不给总分。** 一个 0–100 的健康分不告诉测试者改哪里，而且会被刷分（Goodhart）。我们对模型判断类指标没有 ground truth，合成分会把不可靠的输入包装成看似精确的数字。每个领域给"要处理的数量 + 例子"，数量本身就是可行动的。
- **"没测到"和"零"必须区分。** 没有 E2E 覆盖率报告就写 "not measured"，不写 0%，也不用静态匹配的测试数冒充覆盖率。没有设计文档就写 "no design document"，不写 0/0。
- **分母固定由文件决定，不由模型决定。** 同一 commit 同一配置给出同一分母；模型少输出不能让覆盖率变好看。
- **每条行动有负责人**（CODEOWNERS）。批量报告没有归属就没人修（见 §3.6 Infer 的数据）。
- **和上次比**：新增 / 已修 / 仍未修，一行。第二次看到同一份长列表的读者会停止阅读。

## 2. 对需求的批判

需求原文：summary 要包含 requirement health、design health、requirement coverage、design coverage、placement issue、CI check 等；coverage 包括 unit、E2E、integration、component；告诉测试者哪里要加测试、删除、修改，包括 unit test 质量。

| # | 需求 | 问题 | 决定 |
|---|---|---|---|
| C1 | requirement / design **health 评分** | 评分需要 ground truth 校准；我们没有人工标注（owner 10-21），模型判断的精度未测。总分不指向行动。 | 不打分。按 ISO/IEC/IEEE 29148 的维度列"违反条数 + 例子"，标 M 级。 |
| C2 | **design coverage** | 没有通用定义。多数仓库没有设计文档（我们的 docless 分支就是为此存在）。 | 定义为"设计文档中的组件/接口/决策 → 有代码位置 → 有对应层级的测试"的比例；无设计文档时整节显示 "no design document"，不出现在 At a glance 的 ❌ 里。 |
| C3 | 各层 **coverage**（unit/integration/component/E2E） | SpecGuard scan 是静态的，owner 禁止在本地执行第三方代码（10-22）。各层覆盖率只能来自仓库自己的报告（Codecov flag、CI artifact）。静态"有测试文件"不是覆盖率。测试分层本身是启发式（目录、文件名、runner 配置）。 | 表里分两类列：测试清单（静态，总有）和覆盖率（只在有该层报告时有，否则 "not measured"）。分层规则在报告里给链接。 |
| C4 | 告诉测试者 **哪些要删除** | 静态审查建议删除测试风险高：删错了就丢保护。 | 只在有确定证据时建议删除：长期 skip（带天数）、无断言、测试被测对象自身被 mock、引用已删除功能的需求。措辞是 "fix or delete"，不是 "delete"。 |
| C5 | 维度很多（"等等"） | 每多一节就多一份读者注意力成本。我们的核心目标是 unit test 缺口（v1，owner 10-21）。 | 全部维度进模板，但只有 E/S 级能支撑的先实现（§6）。M 级领域默认折叠。 |
| C6 | **unit test quality** | 真正的质量问题是"代码错了测试会不会失败"，这只有 mutation testing 能回答，scan 不执行代码。现有静态信号有噪声：`audit-units.js:289` 把一个 unit 匹配到的所有测试文件的信号相加，而测试文件按名字、提及或目录匹配，一个大的共享测试文件可以匹配多个 unit。A1 自检报告里 52 行 "weak test signal" 指的是 unit（如 `src/post.js`："57 tests without an assertion"），读者不知道该改哪个测试。 | 质量信号按**测试**归属，不按 unit 归属；没有 mutation 时明说 "test strength not measured"。 |
| C7 | **CI check** 范围 | 安全扫描（SAST、依赖、secret）不是测试者的主要职责，但"测试有没有在 CI 里跑"是。 | CI 节以测试为中心（各层是否在 PR 上跑、有没有测试文件从不被任何 job 跑、重试掩盖失败、覆盖率门禁）；安全只占一行。读不到的设置写 ❔ unknown，不算通过。 |
| C8 | "让测试者快速抓住重要信息" 与 "包含所有维度" 冲突 | 两者需要取舍。 | 用"可见 = 结论 + 证据来源 + At a glance + Top 10；其余折叠"解决。 |

## 3. 调研：业界做法与证据

（见 §3 各小节；带来源。调研时间 2026-10-22。）

<!-- RESEARCH -->

## 4. 字段规则（每个数字怎么来）

### 4.1 顶部

| 字段 | 来源 | 规则 |
|---|---|---|
| 结论行 | 所有发现 | `N things to fix`；拆成 E/S 条数和 M 条数。scan 不完整时改为 ⚠️ 并在同一行写没审到什么。 |
| Evidence used | 输入 | 每类证据一行：有/没有/与本 commit 不符（不符 = 不用）。 |
| At a glance | 各领域 | 固定 8 行，固定顺序（§4.3）。状态：❌ 有 E/S 级问题；⚠️ 只有 M 级问题或部分测量；✅ 测了且无问题；➖ 不适用（如无设计文档）；❔ 没测到。 |
| 和上次比 | scan state | new / fixed / still open，按 finding id。 |

### 4.2 Top actions 排序

1. 证据等级：E > S > M（一条同时有 S 和 M 时按 M 算）。
2. 风险：近 180 天 fix commit 数、错误处理行数、churn（沿用 `audit-units.js` 的 risk）。
3. 工作量：小的在前（加一个断言 < 加一个测试 < 移动一组测试）。
4. 上限 10 条；同一文件最多 2 条，避免一个大文件占满列表。

### 4.3 领域顺序（"你来排序"的答案）

按"测试者能直接动手、证据最硬、越往左成本越低"排序：

1. **Untested code (unit)**：E 级，直接产出要写的测试；这是 v1 核心目标。
2. **Tests that never run**：E/S 级，修一行配置就恢复一批保护，回报最高，而且最容易被忽略。
3. **Unit test quality**：S 级为主（无断言、只断言 truthy、skip、mock 被测对象），flaky 来自 CI（E）。
4. **Test placement**：shift-left 的核心动作（往下推），S+M。
5. **Requirement coverage**：M 级（模型映射需求 → 测试）。
6. **Requirement health**：M 级；只有在它阻碍写测试时才是测试者的事（"不可测"）。
7. **Design coverage and health**：大多数仓库缺文档；结构问题（循环依赖、分层违反）是 S 级但不是测试者的主要行动。
8. **CI checks**：放最后作为明细，但其中"测试不跑"已经提到第 2 行。

覆盖率各层的顺序：Unit → Component → Integration → Contract → End-to-end。理由：越靠下的层越便宜、越快、越确定；shift-left 的目标就是把能在左边证明的东西放到左边。Contract 单列，因为它是服务间调用最常见的缺口，而且通常是 0。

### 4.4 各节

| 节 | 行 | 证据 | 规则 |
|---|---|---|---|
| Untested code | 每个定义一行 | E（unit flag 覆盖率） | 只用 unit 报告；integration/E2E 跑到的行在"Also run by"列说明，但仍算 unit 缺口。报告的 commit 必须等于审计 commit。不在报告里的文件单独计数并说明原因（配置排除/未知）。沿用 #430/#433 的 not-worth-testing 过滤和排序。 |
| Coverage by level | 每层一行 | S（清单）+ E（覆盖率） | 测试分层规则：runner 配置 > 目录 > 文件名后缀；规则可见。没有该层报告 → "not measured"。"Runs on PRs" 来自 workflow 文件 + 最近 check runs。 |
| Unit test quality | 每个测试一行 | S / E | 无断言（含 helper 内断言的跨函数检查）、只断言存在、skip 天数（git blame）、mock 被测模块、flaky（CI 中 retry 后通过的次数 / 总次数）、疑似重复（测试体规范化后相同）。 |
| Test placement | 每条规则一行 | S + M | 下推候选：高层测试中只改变输入数据的多个用例 + 被调用的纯函数 seam（S 找 seam，M 判断是否同一规则）。上推候选：放在 unit 目录但使用真实网络/数据库的测试（S：import 和调用）。 |
| Requirement coverage | 状态桶 + 缺口行 | M（引用经校验） | 沿用 trace 的状态；"only above unit level" 来自 `class: higher_level`。分母 = 文档中的需求块数，固定。 |
| Requirement health | 每条问题一行 | M | 维度：verifiable、unambiguous、singular、complete、consistent（跨文档）、current（引用已删除的功能）、traceable（找不到代码）。 |
| Design coverage | 每个组件一行 | S + M | 组件来自设计文档的标题/列表；代码位置由模型给出并校验存在；测试层级同上。结构检查：import 图的环、设计文档写明的分层规则。 |
| CI checks | 固定检查项 | S / E | 读 workflow 文件和 check runs（只读 API）。读不到 = ❔，不算通过。 |
| 方法与精度 | 固定段落 | — | 每类发现的已测精度（来自我们自己的 eval），未测的写 "not yet measured"。 |

## 5. Unknown unknowns：测试者和报告设计者都容易漏掉的事

1. **测试存在但从不运行。** runner 的 include 规则匹配不到、job 只在 nightly 或 main 跑、`describe.skip` 包住整个文件。覆盖率报告和测试计数都看不出来，只有把 workflow + runner 配置 + 测试文件放在一起才看得到。我们自己的 CI 就漏跑了 eval/replay、eval/f2p、eval/mutation 的测试（#432）。
2. **覆盖率报告和代码不是同一个 commit。** 用旧报告会把已修的缺口报成缺口。规则：commit 不符就不用（#434 已经校验 Codecov 的 sha）。
3. **"不在报告里" ≠ "被覆盖"。** 覆盖工具的配置会排除文件（生成代码、某些目录），这些文件在百分比里根本不存在。
4. **E2E 跑过的行会让 unit 覆盖率看起来更高**，如果所有层合并成一个报告。只有按层分 flag 才能说"unit 缺口"。
5. **重试掩盖 flaky。** `retry: 2` 让 CI 变绿；flaky 只能从"重试后通过"的记录看到。
6. **skip 的测试在统计里算通过。** 长期 skip 的测试是零保护但看起来有测试。
7. **mock 了被测对象的测试**，以及只有 snapshot 的测试：都会通过，保护为零或接近零。
8. **测试分层本身是猜的。** 目录名、文件后缀、runner 配置可能互相矛盾；报告要给出规则，否则读者不信层级统计。
9. **需求文档和代码谁是真相？** 文档可能描述已删除的功能，也可能代码偏离了文档。报告只能说"不一致"，让负责人决定，不能自动判定代码错。
10. **非功能需求（性能、安全）不能用 unit 测试证明。** 不应计为 unit 缺口，而应指向合适的层级或标为"需要数字才能测"。
11. **模型输出不稳定**（A1 Jaccard 0.17）：两次扫描列表不同，读者会以为代码变了。M 级发现需要"两次都报告"才升级（现有的 confirmed 机制）。
12. **批量报告没人看。** 没有负责人、没有和上次的差异、列表太长，报告就会被忽略。
13. **预算截断**：scan 没审完时，"没发现问题"是假阴性。顶部必须写清楚没审到什么。
14. **monorepo**：每个 package 有自己的 runner 和覆盖率，合并百分比没有意义；按 package 分组。
15. **跨仓契约**：消费者端的契约测试在别的仓库，本仓看起来"没有 contract test"不一定是缺口。

## 6. 与现有实现的差距和实现顺序

现有 scan summary（`src/audit-post.js` `render()`，A1 自检输出见 SpecGuard-evidence/a1-self-audit）的问题：

- 第一屏是漏斗行（"31 eligible = 31 inventoried; 31 selected = 3 reviewed whole + 28 forced (recorded unsure)"），测试者看不懂，也不改变行动。应移入 Details。
- 52 行 "Static test signals" 按 unit 汇总测试文件级数字，不指向具体测试，读者无法行动。
- 没有证据等级、没有负责人、没有 At a glance、没有 CI 节。

实现顺序（每一步都要有对应 eval，owner 10-18 的规则）：

| 步 | 内容 | 证据等级 | 依赖 |
|---|---|---|---|
| R1 | 新骨架：结论行、Evidence used、At a glance、Top actions、折叠节；现有发现映射进去 | — | 无；纯渲染，可用现有 audit.json 回放对比 |
| R2 | 质量信号按测试归属，去掉按 unit 重复 | S | test-map |
| R3 | Tests that never run：workflow + runner 配置 + 测试文件交叉 | S | 新模块，只读 |
| R4 | CI 节：check runs 历史（retry 后通过、各层是否在 PR 跑） | E | 只读 API |
| R5 | 按层覆盖率（Codecov flags） | E | #434 |
| R6 | Placement 下推候选（S 找 seam + M 判断） | S M | trace |
| R7 | Requirement health、Design coverage | M | 需要先测精度（judge 校准） |

R1–R5 不依赖模型，可以先上；R6、R7 在测出精度之前默认折叠，并在方法段写 "not yet measured"。
