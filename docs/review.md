# SpecGuard GitHub Actions Summary 审查

审查对象：[Kite — SpecGuard audit #10](https://github.com/Mira190/Kite/actions/runs/38510141042)，2026 年 10 月 14 日。

我已经读取了这次运行的 Job Log、Workflow 配置，以及生成的 `summary.md` 和分析 Artifact。

## 一、初步结论：能发现测试风险，但还没有形成完整的 Shift Left 闭环

这次运行最值得注意的不是发现了多少个缺失测试，而是报告的审查范围、结论可信度和团队行动建议尚未很好地衔接。

本次执行概况

Action 成功

实际完成 Unit Review

# 10 / 44

22.7% 的代码单元

本轮 Unit Gap

# 3

但报告中一项明确表示没有发现缺口

延续的需求缺口

# 12

来自持续扫描状态，不等于本轮重新验证

本轮审查失败

# 1 / 5

一批 20 个需求块未完成分析

运行用的是 Claude Haiku 5.5，耗时约 3 分 55 秒，报告显示 API 成本约 US$0.46。Action 的绿色成功标记只是工作流执行成功，不是测试充分、设计符合要求或扫描完整的证明。

最明显的三个问题：

1. 内容分类有误。 `Untested behaviour` 中包含一个明确说已经被测试覆盖的 `cursorBoxes`，同时另一个 `eraseAt` 条目承认大部分行为已经覆盖。
2. 审查并不完整。 44 个代码单元只完成 10 个的本轮审查，而且有一次需求分析因模型输出上限失败。报告容易让读者过度相信扫描结果。
3. 缺少决策层。 报告多次写 `Add a unit test that checks it`，但没有充分解释应该测试哪个具体行为、为何属于 unit 层、风险多高，以及应该由哪个团队处理。

这意味着它已经是一个有价值的 test gap discovery prototype，但还不能把所有结论直接作为团队的开发待办或 PR 阻断依据。

## 二、逐项核验：实际发现的问题

我把 `audit.json`、`findings.json` 与 Kite 的源码和测试进行了交叉检查。

本轮 71 条需求判断的分布

不是代码覆盖率

37

Covered

21

Unknown

4

Partial

4

Missing test

3

Contradicted

2

Needs human

将近三分之一的需求被判为 `unknown`。这是诚实表达不确定性的好做法，但应进一步告诉团队：不知道的原因是没有实现证据、没有找到测试、上下文不足，还是需要人工判断。

### 实际问题与严重程度

| 优先级 | 发现                   | 核验结果                                                  |
| --- | -------------------- | ----------------------------------------------------- |
| P0  | 错误报告缺失测试             | `cursorBoxes` 已覆盖，却计入 3 个 unit gaps                   |
| P0  | 错误判断需求冲突             | `ListPage` 具有 name、duration、date 排序，增加 size 排序不代表违反需求 |
| P0  | 建议测试代码错误             | `eraseAt` skeleton 构造了不可能触发删除的状态                      |
| P0  | 模型失败但没有完整性警示状态       | 20 个 document blocks 因输出截断未审完，主标题仍是一般的 ❌ gaps         |
| P0  | 没有明确区分测试层            | Higher-level UI 场景被统一建议添加 unit test                   |
| P1  | Coding standards 未确认 | `standards.txt` 是空文件                                  |
| P1  | 技术设计遗漏               | `docs/architecture.md` 被自动文档筛选排除                      |
| P1  | 全仓扫描范围不足             | 本轮只有 10/44 units 完成上下文装载，且其中部分没有充分分析                  |
| P1  | 缺少 Gap 优先级           | 不能快速判断哪些影响核心业务、哪些只是 UI 规范差异                           |

### 案例 A：排序功能被误报为设计冲突

设计文档：[docs/design.md:178](https://github.com/Mira190/Kite/blob/985758cb9b07937959906a787f605d511aaabf0f/docs/design.md#L178)

要求录像列表支持按名称、时长、日期排序。

实际源码：[src/ui/ListPage.tsx](https://github.com/Mira190/Kite/blob/985758cb9b07937959906a787f605d511aaabf0f/src/ui/ListPage.tsx#L49)

它已经定义了 `name`、`dur`、`date` 三个可比较列，还额外支持 `size`。

报告认为多了一个 size 排序就构成 `contradicted`。

这个判断逻辑不成立。 除非需求明确限定只能有三种排序方式，否则额外功能不能被当作违反需求。

应当加入 Requirement Semantics Validator，区分以下逻辑关系：

| 需求关系                    | 是否构成冲突        |
| ----------------------- | ------------- |
| 必须包含 A、B、C，代码包含 A、B、C、D | 否             |
| 只能包含 A、B、C，代码包含 D       | 是             |
| 最小高度为 600，代码设置 500      | 是             |
| 文档描述 A，但源码仅发现 B         | 需要继续检索，不能直接认定 |

### 案例 B：`eraseAt` 的测试建议本身有错误

源码：[src/engine/board.ts:99](https://github.com/Mira190/Kite/blob/985758cb9b07937959906a787f605d511aaabf0f/src/engine/board.ts#L99)。

报告建议在一次 `undo` 后执行 `eraseAt`，验证 redo history 被清空。

但所给 skeleton 只创建了一条 stroke，最后 `undo` 后棋盘已经没有 stroke。`eraseAt` 因此没有命中，直接返回原 board，`future` 不会被清空。

即使实现完全正确，这个建议测试也会失败。

更合理的测试是：

```

test('eraseAt clears redo history on a hit', () => {
  let b = emptyBoard()
  b = line(b, 0, 0, 100, 0)
  b = line(b, 0, 30, 100, 30)

  b = undo(b)
  assert.equal(b.strokes.length, 1)
  assert.equal(b.future.length, 1)

  const result = eraseAt(b, { x: 50, y: 0 }, 4)

  assert.equal(result.strokes.length, 0)
  assert.equal(result.future.length, 0)
  assert.equal(result.past.length, 2)
})

```

其中 `line` 是现有 `test/board.test.ts` 的辅助函数。

这揭示一个架构问题：SpecGuard 验证了引用是否存在，却没有验证生成的测试场景是否自洽。

建议引入独立的 Test Suggestion Verifier，对生成代码做隔离的类型检查和执行；至少要求先建立前置条件，再验证测试目标。

### 案例 C：更适合组件测试的行为被推给 Unit Test

报告指出录像列表的播放、重命名、删除快捷键没有覆盖。

这是有意义的测试发现，但它在 `audit.json` 中已经被分类为 `higher_level`，最终 Summary 却仍然写：

`Add a unit test that checks it.`

这是报告生成器的确定性问题，而不只是模型判断失误。

对于这种行为，应区分纯函数的键位映射逻辑、React 事件处理、Electron IPC 以及实际系统操作。

例如：

| 测试义务                             | 适合层级        |
| -------------------------------- | ----------- |
| F2 对应 rename command             | Unit        |
| F2 触发 RenameField                | Component   |
| Rename command 正确调用 Electron IPC | Integration |
| 用户按 F2 后文件成功重命名                  | E2E         |

Shift Left 的目标应是把能在低层可靠验证的逻辑提前验证，不是让所有测试都变成 Unit Test。

## 三、Summary 的组织需要重做

当前 Summary 约 77 KB、357 行、327 个链接，并有大量信息放在单个 Details 区域。

虽然信息丰富，但对其他 team 的 developer 来说，信息查找成本过高。

我建议改成三层报告。

## 建议的 GitHub Actions Summary 结构

SpecGuard · Verification Gap Review

Incomplete

Repository: Kite · Commit: 985758c · Scan mode

# 2

Gap hypotheses requiring validation

# 3

Reported document conflicts

# 60/131

Document blocks assessed this run

Illustrative revised headline after excluding the explicitly non-gap cursorBoxes finding; remaining hypotheses still need validation.

01 · Action Required

Review

`checkRecording` — Default FPS tolerance boundary

Unit · `src/engine/probe.ts:73`

现有测试验证常规通过和显著失败，但没有证明默认 ±10% 边界。

建议：增加 27 fps 通过与 26.9 fps 失败的边界测试。

Review

`eraseAt` — Redo history after a hit

Unit · `src/engine/board.ts:99`

现有测试覆盖 erase 和 merge，但缺少删除后 redo 分支行为的显式断言。

建议：构造两条 stroke，撤销一条后删除剩余 stroke，检查 future 清空。

02 · Review Completeness

代码扫描覆盖范围

10 / 44

本轮需求块审查

60 / 131

Coding standards

Not assessed

Model output truncation

20 blocks affected

03 · Full Evidence

详细的 requirement → code → tests 映射、误报候选、未审查范围与模型输出，保留在独立 Artifact 中。

这个结构的关键是：Summary 是决策界面，不是完整审计数据库。

单条 finding 的详细内容应该采用统一格式：

`Behaviour → Risk → Evidence → Missing assertion → Recommended layer → Suggested test → Confidence`

同时应该在结果中直接标出 `New / Existing / Resolved / Needs review`，而不是仅仅根据模型连续两轮得出相同判断，就称作 `Confirmed`。

当前代码中的 confirmed 实际是重复扫描确认，并非经过测试或人工证实。

## 四、Shift Left 目标究竟满足了多少？

你们原本要实现的是：

> Requirement-aware reviewer that maps changed behaviour to test obligations, assertions, and test layers to find high-confidence verification gaps.

我按这个目标评估当前这次运行。

| 能力                          | 判断    | 原因                                     |
| --------------------------- | ----- | -------------------------------------- |
| 自动发现 Requirements           | 部分实现  | 只纳入了 `docs/design.md`                  |
| 需求映射到代码                     | 部分实现  | 有证据链接，但关联存在误判                          |
| 需求映射到测试                     | 部分实现  | 目前基于静态检索与 LLM 判断                       |
| 识别缺失的 Unit Tests            | 部分实现  | 有有效候选，也有明显假阳性                          |
| 识别薄弱 Assertions             | 部分实现  | 具备机制，但本轮没有可靠的弱断言发现                     |
| 测试层级推荐                      | 不充分   | Summary 不区分 Unit/Component/Integration |
| Coding Standard 确认          | 未满足   | 本轮加载的 `standards.txt` 为空               |
| PR Changed Behaviour Review | 本轮未验证 | 这次是全仓手动扫描                              |
| 开发前/PR 前及时反馈                | 本轮未满足 | 触发器只有手动与每周定时                           |
| 结果可直接执行                     | 不充分   | 测试 skeleton 未验证，缺少处理责任和优先级             |

另一个值得注意的现象是 `audit-inventory.json` 识别出 44 个源文件，其中 18 个没有匹配的测试文件。

但这个数字不能直接解释为 18 个缺失 unit test 的文件。它包含 UI、Electron 主进程和 smoke runner 等不同类型的文件，必须先区分模块角色与合理测试边界。

### 真正需要改变的是反馈时机

目前 Kite 这次验证的路径

代码已存在

每周/手动扫描

Issue

建议增加的 Shift Left 路径

Requirement / Design

Test Obligations

Local / PR Verification

Merge 前反馈和修复

每周一次、四轮覆盖全仓的 rotation 可以用于持续审计，但不能替代开发当下的增量扫描。高风险修改应该在对应 PR 中就进行验证，而不必等到下一次 rotation。

## 五、优先实施的技术改动

| 次序 | 优化项                    | 具体改动                                                     | 预期效果                  |
| -- | ---------------------- | -------------------------------------------------------- | --------------------- |
| P0 | Finding Validator      | 拒绝“已覆盖但判为 missing”的结果，检测自相矛盾的标题和正文                       | 降低误报                  |
| P0 | Test Skeleton Verifier | 验证测试的前置状态、断言和可执行性                                        | 防止错误建议进入团队            |
| P0 | Layer-aware Renderer   | 根据 `class` 输出对应的 Unit / Component / Integration / E2E 建议 | 正确指导 Shift Left       |
| P0 | Completeness Gate      | 任何模型分片失败、范围遗漏都输出 `INCOMPLETE`                            | 避免绿色运行误导              |
| P1 | Requirement Authority  | 标注产品要求、架构约束、编码标准各自的权威级别和版本                               | 避免过期文档成为错误 oracle     |
| P1 | Standards Check        | 加载规则并显示规则来源；缺失规则明确提示，而非默认通过                              | 满足 Coding Standard 要求 |
| P1 | PR Incremental Review  | PR diff → 影响范围 → Requirement → Test obligation           | 真正前移反馈                |
| P1 | Evidence Report        | 结构化 JSON 为数据源，Summary 只展示可行动发现                           | 显著改善可读性               |
| P2 | Feedback Loop          | 团队标记 valid、false positive、accepted risk、fixed            | 持续衡量准确度               |

还有三个运行配置值得改。

扫描预算与分片机制： 这次是 5 次模型调用，1 次因 `max_output_tokens=22000` 被截断。优先减少每个 batch 的需求数量，并加入对失败分片的重试与二分拆分机制，而不是单纯增加 token 上限。完整性标记必须由程序计算，不能交给模型自行描述。

Artifact 保存： 当前输出保留期仅 1 天，而定时扫描每周运行。这样不利于人工复核历史证据和评估修复情况。建议按公司数据保留策略保存结构化结果至少覆盖一个完整扫描周期，同时避免在长生命周期 Artifact 中保留不必要的完整 prompt 和私有源码副本。

Action 版本与失败策略： Kite 目前使用 `Mira190/SpecGuard@main`，且 `fail_on_error` 默认是 `false`。建议稳定后固定 Action 的 commit SHA；将审查未完成与确认的高风险缺口分别处理，前者是工具可靠性问题，后者才是代码质量问题。

## 六、我认为最需要补充的两个能力

第一，Requirement Completeness Review。 SpecGuard 不仅要回答现有需求有没有测试，还要能提出需求本身遗漏了哪些验收条件，例如状态转换、失败恢复、边界值、权限变化及并发行为。但这些应作为待确认的测试义务，而不是擅自认定为正式需求。

Kite 的 `docs/architecture.md` 中包含崩溃恢复、音视频同步、流密钥保护和录制性能等重要约束；此次却因为文档密度启发式规则被排除。这说明单纯依赖文档自动准入，会遗漏关键行为。

第二，Risk-based Verification Planning。 不应该把每条需求都机械转换为一个 Unit Test。应该先确定失败后果与最适合验证的层级，再检查是否已经有足够的独立断言。

这两项能力决定了 SpecGuard 是普通的 AI 测试评论器，还是一个真正帮助其他 team 提前发现验证缺口的系统。

## 七、如何衡量优化是否成功

不要把发现数量或报告长度作为主要 KPI。建议使用以下指标：

| 指标                       | 含义                               |
| ------------------------ | -------------------------------- |
| Verified Precision       | 人工确认有效的 findings / 已核验 findings  |
| Actionability Rate       | 具有定位、测试层级、明确断言与复现步骤的 findings 比例 |
| Fresh Scan Completeness  | 本轮实际完成审查的目标范围比例                  |
| Requirement Traceability | 能明确关联代码及测试证据的需求比例                |
| Pre-merge Detection Rate | 在合并前被发现和处理的验证缺口比例                |
| False Positive Rate      | 被团队拒绝为不成立的 findings 比例           |

我建议第一阶段把 Verified Precision、Actionability 和 Scan Completeness 作为核心验收指标，然后再扩大自动化扫描范围。

## 总体判断

SpecGuard 目前已经完成了从代码和需求文档中寻找测试证据的基础能力。它最大的不足不是模型不够强，而是缺少将模型结果转化为可验证、分层级、可分配、可追踪的测试义务的可靠机制。

我的实施顺序会是：先修准确性和报告结构，再补 Coding Standard 与完整性检查，然后打通 PR 增量审查和本地反馈。

这样优化后，它给其他团队的输出才真正接近：

> Here is the behaviour your change introduces, the verification evidence we found, the exact assertion that is still missing, the best test layer, and the test you can add before merging.

现有结果可对照：[本次 Action](https://github.com/Mira190/Kite/actions/runs/38510141042) · [扫描 Issue #3](https://github.com/Mira190/Kite/issues/3) · [SpecGuard 源码](https://github.com/Mira190/SpecGuard)。