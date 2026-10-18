# SpecGuard 第三轮批判性审查 — Run #12

[GitHub Actions Run #12](https://github.com/Mira190/Kite/actions/runs/38515926303) · 2026 年 10 月 14 日 · Kite commit `985758c`

## 一、核心结论

新版本在结果措辞和测试发现的广度上有进步，但出现了一个更严重的问题：报告的统计信息已经不再完全可信。

我读取了这次运行的 GitHub Issue、完整 Job Log 和 Artifact 中的 `audit.json`、`scan-parts.json`、`audit-meta.json`、`audit-inventory.json`。

本轮完成需求审查

# 70 / 80

10 个失败分片中的需求块未审查

本轮有效展示的 Unit Findings

# 7

5 个 missing · 2 个 weak

累计已审代码单元

# 35 / 44

仍有 9 个从未完整审查

模型调用与费用

# 7

约 US$0.485 · Claude Haiku 5.5

最严重的统计矛盾是：

Coverage 显示 141 / 131

报告原文写的是 `Coverage: 141 of 131 blocks audited at least once`，这在需求块唯一计数的定义下不可能成立。

同一个报告还同时声称本轮审查了 70 个和 80 个需求块。Artifact 证实：预选 80 个，但其中 10 个因模型输出不合格而没有成功审查。

这不仅是排版问题。对于要在其他 Team 中推广的 Shift Left 工具，扫描范围及其完整性本身就是审查结果的一部分，必须可靠。

从这轮开始，我会把发现区分为两类：一类是 SpecGuard 确实识别出的有价值问题，另一类是 SpecGuard 自身可能造成的误报或误导。

## 二、这次确实修复了什么？

| 上轮问题                | 本轮情况                         | 评价            |
| ------------------- | ---------------------------- | ------------- |
| 把重复发现称为 Confirmed   | 改为 `Reported in two runs`    | 改善            |
| 所有缺口统一推荐 Unit Test  | 部分支持 Component / Integration | 部分改善          |
| 模型输出截断              | 增加自动拆分                       | 方向正确，但仍失败一批   |
| 缺少 Weak Test 发现     | 本轮报告 2 条                     | 发现能力提升，准确性待核验 |
| Design Exception 误报 | 本轮不再把白色选区边框直接判为冲突            | 改善            |
| 历史 Finding 丢失类型     | 仍然存在                         | 未修复           |
| Coding Standards    | 仍未获得任何标准文件                   | 未修复           |
| Summary 可执行性        | 仍有通用建议和不完整测试草案               | 改善有限          |

尤其值得肯定的是，报告现在把 low-confidence findings 单独列出，没有全部放入主结论。这是必要的。

但这还不等于高置信度机制已经可靠，因为下面几项被放进主列表的 finding 本身仍然有问题。

## 三、逐条核查：哪些发现是准确的？

### 1. `ownFile` — 误报了缺失的核心单元测试

高优先级修复 SpecGuard

本轮报告称 [electron/app.cjs:617](https://github.com/Mira190/Kite/blob/985758cb9b07937959906a787f605d511aaabf0f/electron/app.cjs#L617) 的 `ownFile` 没有单元测试，路径穿越防护只在 Smoke Test 中验证。

但源码实际上是：

> Private pilot source excerpt removed; the surrounding analysis describes the behavior.

核心防护逻辑 `isDirectChild` 已有直接的 Unit Test：

[查看 test/filename.test.ts](https://github.com/Mira190/Kite/blob/985758cb9b07937959906a787f605d511aaabf0f/test/filename.test.ts)

该测试覆盖了直接子文件、子目录、`..` 路径穿越、相似目录前缀、大小写与不同斜杠。

因此正确结论应该是：

- 路径穿越核心逻辑：已有 Unit Test。
- `ownFile` 的 `MEDIA_EXT` 与入口参数校验组合：可以考虑补充 Contract/Integration Test。
- Electron 实际删除、重命名操作：已有 Smoke 证据，但是否充分仍需评估。

不能简单写成整个 `ownFile guard` 未经 Unit Test 覆盖。

这是一个典型的跨模块测试证据追踪失败：

`Wrapper → Delegated Helper → Existing Unit Test`

SpecGuard 应沿调用关系追踪到被测 helper，再决定剩余缺口，而不是只检查 wrapper 有没有对应测试文件。

### 2. `toolbox.test.ts` — Weak Assertion 判断并不成立

很可能是假阳性

报告称 [test/toolbox.test.ts:25](https://github.com/Mira190/Kite/blob/985758cb9b07937959906a787f605d511aaabf0f/test/toolbox.test.ts#L25) 的 `has()` 断言太弱，因为只检查一组参数是否出现在任意位置。

但 `has()` 的实现是：

> Private pilot source excerpt removed; the surrounding analysis describes the behavior.

它验证的是预期的连续参数序列是否存在，不是任意字符串的 truthiness。

对 FFmpeg 参数构造函数来说，这通常是合理的契约测试。比如 `-c:v libx264` 是否存在，与其出现在参数数组第几项，通常是两个不同的要求。

报告建议改用固定数组位置断言，反而可能让测试过度依赖实现细节，降低可维护性。

除非 FFmpeg 参数的相对顺序确实影响行为，或者存在重复选项导致覆盖，否则不应把这种断言判为 Weak Test。

这是第二个值得加入回归测试集的明确反例。

### 3. `textBox` — 有价值，但不应过度解读

部分成立

报告指出 [test/board.test.ts:81](https://github.com/Mira190/Kite/blob/985758cb9b07937959906a787f605d511aaabf0f/test/board.test.ts#L81) 把期望值写成与实现一致的公式：

> Private pilot source excerpt removed; the surrounding analysis describes the behavior.

如果这个公式和代码同步被错误修改，测试可能无法发现问题。

建议改为来自独立规格的具体期望值 `64`，并增加边界例子。这是合理的测试质量建议。

不过，当前测试并非不能失败。只要实现计算结果偏离期望公式，它仍然可以检测错误。报告写成类似“无法检测变更”的绝对措辞过强。

正确分类应是：

Oracle independence weakness，而不是没有有效断言。

### 4. `capture.cjs` — 本轮最值得深入处理的测试缺口

高价值发现

这是比较可靠的改进方向。

[代码位置](https://github.com/Mira190/Kite/blob/985758cb9b07937959906a787f605d511aaabf0f/electron/capture.cjs#L16)

`rec:chunk` handler 同时管理 active 状态、字节计数、磁盘写入和直播转发。这些行为高度相关。

建议至少覆盖正常写入、未开始录制的 chunk、异常退出、重复结束、无文件直播、写入错误，以及发送数量与接收数量不一致的情况。

还有一个 SpecGuard 没有指出的潜在风险：

代码在调用 写入操作 后，立即增加 `written.chunks` 和 `written.bytes`。这些计数反映的是 handler 接收并处理的 chunk，不必然证明字节已经成功持久化到磁盘。

因此，即使 recorder 发送数和 main 的计数完全相同，也不足以单独证明录像文件完整。写入结束后的文件验证和流错误处理仍是必要的。

这比简单检查 chunk counter 有没有 Unit Test 更接近你们真正希望发现的 unknown unknown。

## 四、这轮真正值得关注的 Design Contradictions

相比 Unit Test Findings，我认为本次有两项设计与实现不一致更值得关注。

### A. `ListPage` 默认选中第一条记录：成立

设计：[docs/design.md:115](https://github.com/Mira190/Kite/blob/985758cb9b07937959906a787f605d511aaabf0f/docs/design.md#L115)

要求录像列表的第一行默认选中，但不进入编辑状态。

实现：[src/ui/ListPage.tsx:35](https://github.com/Mira190/Kite/blob/985758cb9b07937959906a787f605d511aaabf0f/src/ui/ListPage.tsx#L35)

> Private pilot source excerpt removed; the surrounding analysis describes the behavior.

`sel` 初始化为空，异步取得 `rows` 后也没有自动选择第一条的逻辑。

这是一个可信的设计与实现差异。

但应推荐 Component Test 验证列表加载后的默认选中行为，而不是笼统要求添加 Unit Test。

### B. 快捷键注册失败：SpecGuard 找到了表面差异，却遗漏了更重要的问题

设计：[docs/design.md:141](https://github.com/Mira190/Kite/blob/985758cb9b07937959906a787f605d511aaabf0f/docs/design.md#L141)

要求冲突时拒绝保存并保留旧快捷键；当操作系统拒绝注册快捷键时，也要显示冲突消息。

报告只指出了错误提示文字不一致。

但我检查 [electron/app.cjs](https://github.com/Mira190/Kite/blob/985758cb9b07937959906a787f605d511aaabf0f/electron/app.cjs#L643) 的 `setHotkey`：

> Private pilot source excerpt removed; the surrounding analysis describes the behavior.

这里先更新并持久化快捷键，再尝试调用 Electron `globalShortcut.register`。

如果操作系统拒绝注册，代码返回 warning，但新快捷键已经保存，旧快捷键还可能已经被注销。

如果需求中的“旧值保留”同样适用于操作系统注册失败，这就是一个真实的状态一致性缺陷。

需要测试的不只是 warning 文本，而是：

`Previous Binding → Registration Failure → Persisted State → Actual Active Binding`

这正是 SpecGuard 应当从第一性原理挖掘的高价值未知风险：不仅验证单个函数的断言，还要验证失败路径上的系统不变量。

## 五、第三轮仍然存在的架构问题

### P0 — 扫描账本不一致

代码里通过类似以下逻辑计算累计覆盖：

```
const k = rotation.picked
const total = k + carried.length
```

这里的 `picked` 是预定审查数量，而 `carried` 在失败分片后还会包含部分原本已选但未完成的块。

所以出现：

`80 selected + 61 carried = 141`

而不是对真正完成过审查的唯一 Block ID 求并集。

应将至少四个集合独立保存：

`selected / completed / failed / previouslyReviewed`

所有累计覆盖数字只能通过唯一 Block ID 计算，并加上如下约束：

```
assert(completedIds.size <= selectedIds.size)
assert(auditedEverIds.size <= totalCandidateIds.size)
assert(completedIds.size + failedIds.size <= selectedIds.size)
```

还应分别报告 本轮完成率 和 历史累计覆盖率，不能混为一谈。

### P0 — 模型失败仍然返回绿色成功

本次 `scan-parts.json` 显示 7 次模型调用，1 次自动拆分，1 次最终失败：

`9 of 10 blocks were not answered`

但 GitHub Job 仍然是 `success`，且最新 Issue 依旧更新了扫描结果。

我建议区分三种状态：

| 状态       | 含义                | 是否应作为合格审查 |
| -------- | ----------------- | --------- |
| Complete | 全部目标审查完成          | 是         |
| Partial  | 有有效发现，但存在失败、上下文遗漏 | 否         |
| Failed   | 无可靠输出或证据验证失败      | 否         |

对于 Audit 模式，可以不中断其他 CI，但应将 Check Run 的分析结果标记为不完整。部分失败结果不应直接推进历史 finding 的确认与消除状态。

### P0 — 模型没有稳定获得完整需求上下文

本轮 `audit.json` 明确包含“`docs/design.md` 没有完整内联，只评估了 candidate block 文本”的限制说明。

我还检查了 Artifact 的顶层 `prompt.txt`，它不是完整的设计文档正文。虽然模型分片会附加证据窗口，但不能据此认为完整需求上下文都已提供。

这解释了为什么有时 SpecGuard 只看到某项规定，却看不到同一文档后面的例外。

而且 `docs/architecture.md` 仍被自动筛选排除，尽管其中包含录制完整性、崩溃恢复、性能约束等重要设计信息。

建议把“发现文档”与“确定权威上下文”分离，并建立文档级依赖索引；遇到一个需求时，必须能找到相关例外、定义、引用章节和架构约束。

### P1 — 历史 Finding 仍然丢失类型

上一轮被判断为 `contradicted` 的 `docs/design.md:208`，这次作为历史记录延续后，推荐动作又变成 `Add a unit test that checks it`。

同类问题还发生在排序和其他 UI 要求上。

这是持久化数据结构的问题，不是通过重新提示模型就能彻底解决的。

每个 finding 应保存独立的、可追踪的结构：

```
{
  "finding_id": "stable-id",
  "requirement_id": "requirement-id",
  "kind": "spec_drift",
  "recommended_layer": "static",
  "evidence_sha": "commit-sha",
  "verification": "unverified",
  "lifecycle": "open"
}
```

历史状态应该跟随具体 Finding，而不是只跟随 document block。否则一个复杂段落中的某项问题消失、另一项问题出现时，会被错误地认为是同一缺口持续存在。

### P1 — Inventory 把测试驱动程序当成待测业务单元

本轮把 `electron/smoke.cjs` 作为可能缺失 Unit Test 的源码，之后才降为 Low Confidence。

实际上它是 E2E Test Runner。

这说明代码清单构建阶段缺少职责分类。

应该先分为 Production Logic、UI、Integration Adapter、Test Infrastructure、Generated/Vendored 等，再决定如何进行风险排序和是否需要 Unit Test。

同时，`test/` 中“没有弱断言”的启发式计数与模型最终发现的两项 Weak Test 并不矛盾，但 Summary 应明确前者是静态线索数量、后者是模型判断数量，避免看起来像统计错误。

## 六、Summary 组织：比上一版明显短，但仍然不好用

三轮 Summary 大小

来自对应 Run 的 Artifact，单位 KB

0 KB30 KB60 KB90 KB120 KBRun #10Run #11Run #12

这轮从上一版的约 105 KB 降到 63 KB，确实有所改善。

但是对于其他开发团队，63 KB 的单个审计 Summary 仍然太长。

最需要改变的不是继续减少文本，而是按照开发人员的决策流程组织信息。

建议改成以下首页：

SpecGuard — Repository Verification

Partial

Kite · 985758c · Full-repo rotating audit

## 70/80

Blocks assessed

## 10

Failed blocks

## 35/44

Units audited ever

Priority findings

Spec drift

ListPage initial row is not selected

State risk

Shortcut registration failure persists invalid binding

Test gap

Capture lifecycle and byte accounting

Details: findings with evidence, unresolved hypotheses, reviewed areas, rejected documents and full machine-readable audit.

这只是建议的呈现方式，其中 Priority Findings 经过了本次独立审查，不等同于 SpecGuard 原报告直接确认的三个问题。

这样开发人员一打开就知道：哪里要改、为什么、应该验证什么、工具这次有没有完整运行。

## 七、从 Shift Left 角度，下一步最关键的不是增加发现数量

这三轮运行都是对同一 Kite Commit 的全仓扫描。它们证明了 SpecGuard 能持续发现一些验证缺口，但还没有证明它能够在需求或 PR 发生变化时，把正确的测试建议及时交给负责开发的 Team。

目前的 `workflow_dispatch` 和每周 `schedule` 仍然只验证了周期性审计模式。

我建议下一阶段按以下顺序推进：

| 优先级 | 建议任务                             | 验收标准                                        |
| --- | -------------------------------- | ------------------------------------------- |
| P0  | 修复 Coverage Accounting           | 绝不出现大于 100% 的审计覆盖率                          |
| P0  | 修复 Partial Scan Lifecycle        | 失败分片不会污染历史确认状态                              |
| P0  | 跨模块 Test Evidence Linking        | `ownFile` 能找到 `isDirectChild` 已有的 Unit Test |
| P0  | 重新定义 Weak Assertions             | FFmpeg 连续参数匹配不会无理由被判为 weak                  |
| P1  | Requirement Exception Resolution | 主题颜色例外不会变成 contradiction                    |
| P1  | Finding Identity & History       | 每项历史 finding 保留类型、证据和适用层级                   |
| P1  | Risk-based Ranking               | 高影响状态一致性问题优先于简单 UI 文本格式化                    |
| P1  | PR / Local Modes 验证              | PR 修改当下产生对应测试义务                             |
| P1  | Coding Standards Check           | 明确加载哪些标准；不存在时返回 Not assessed                |
| P2  | Human Feedback Dataset           | 能计算经人工核验的 precision 与 false-positive rate   |

## 八、总体评价

| 运行健壮性           | 改进中       |
| --------------- | --------- |
| 测试缺口发现能力        | 已有实际价值    |
| 结论准确性           | 仍需加强      |
| 报告可读性           | 有所改善      |
| 审计结果可追踪性        | 存在数据结构问题  |
| Shift Left 完整程度 | 当前仍偏向事后审计 |

我目前不建议把这一版的 findings 自动用于跨团队阻断 PR。 但它可以继续作为 advisory scanner 使用，前提是把结果清晰标为假设、已验证的证据和未审查范围。

这轮最重要的启示是：SpecGuard 不应该继续单纯追求扫描更多文件、输出更多缺口。下一次升级应该集中在 Verification Integrity，即确保每条测试建议有独立证据、正确测试层级和稳定身份，同时确保扫描过程自身可被验证。

相关材料：[Run #12](https://github.com/Mira190/Kite/actions/runs/38515926303) · [Artifact](https://github.com/Mira190/Kite/actions/runs/38515926303/artifacts/11872232061) · [Issue #3](https://github.com/Mira190/Kite/issues/3) · [SpecGuard 源码](https://github.com/Mira190/SpecGuard)。