# Research 与 Original Goal 实现审查

日期：2026-10-06。审查对象是当前工作区（包含上一轮尚未提交的重构）。本报告只评估，不修改运行时代码。

结论：research 能帮助优化，最重要的是规范工具执行证据、测试退化场景和验收方法。当前已经实现可运行的 requirement-aware 静态 AI review 框架，但不能认定 Original Goal 已经完整验收。上一轮 26 项测试验证的是程序行为，不是模型发现缺失测试的准确率；本轮还复现了两个程序层面的漏报/信任边界问题。

## 1. 三份 research 的价值

| 文件 | 可采纳内容 | 不宜直接迁移的内容 |
|---|---|---|
| `research/AI Unit Test Review Workflow Research Report.md` | 将需求、测试质量、规范、层级分别验收；规范确认要有执行证据；先 advisory 再用真实 PR 校准 | “没有任何其他工具能做到”的市场结论缺乏完整验证；四路模型和 merge gate 是该方案新增设计，不是原始需求 |
| `research/SKILL.md` | 拆分复合 AC；零断言、disabled、删弱断言、bug-fix regression test；分清哪些逻辑可下沉、哪些集成职责必须保留 | 不宜因包含 must、缺回归测试、或发现指令式文本就自动 blocking；模型自报 confidence 80 不是经校准的 80% 正确率 |
| `research/ai-unit-test-review.yml` | 从 Checks/Statuses 收集执行结果；记录 commit、来源、状态；上下文 manifest 和可追溯结果 | 720 行 workflow、四次模型执行、inline 写权限、轮询等待及 gate 不应整体替换当前较小的 composite Action |

research 中两项表述需要修正：coverage 的未命中最多证明该次、该范围的运行未执行某行，不证明整个仓库不存在合适测试；跨模块并不自动等于应该拆成 unit test，仍要保留公开接口、集成契约和成本判断。

## 2. Original Goal 逐项判断

原文保留于 `docs/design.md:21`，不应把 research 扩展功能反向当成原始硬要求。

| 原始目标 | 当前实现 | 判断 |
|---|---|---|
| GitHub Actions workflow | `action.yml`、README 消费者 workflow、`.github/workflows/ci.yml` dogfood，Copilot/Claude 两种引擎 | 工作流结构已实现；新版报告契约未做两引擎真实运行验收 |
| requirement-aware | `requirements.js` 收集 PR 和最多五个关联 issue；跨 repo 引用和读取限制可见；skill 要求读取关联 spec | GitHub PR/issue 路径已实现；没有独立、可核对的 AC 清单，Jira 等不是现成功能 |
| changed behaviour → test obligations | coverage 行带 id、obligation、source、behaviour；提示词要求枚举分支、边界、错误路径 | 结构已实现；枚举仍由模型完成，校验器不知道模型漏列了什么 |
| obligations → assertions | assertion path/line/quote/proves，精确引用校验和 finding/obligation 一致性检查 | 能验证引用文本存在，不能证明断言有效、会执行或真的覆盖该行为；仅改测试和零断言情形有缺口 |
| assertions → test layers | unit/component/integration/e2e；仅高层覆盖不会计入 unit evidence | 结构已实现，层级分类仍依赖模型；没有测试执行结果或 runner 配置的确定性证明 |
| identify missing unit tests | `missing_test`、`weak_test`、建议测试骨架，搜索已有测试，逐条报告 | 主路径已实现；关键边界未完善，模型准确率未验收 |
| coding standard has been confirmed | base 规则清单、规则引用校验、checked/no_rules/not_reviewed | 仅实现静态规范审查。若 confirmed 包含 lint/format 已运行并通过，尚未实现；规则发现和 base 恢复也有缺陷 |
| component/integration → appropriate unit tests | higher_level_only + pushdown，要求公开 seam、输入/输出，并保留集成职责 | 符合原始可选目标的最小实现；真实仓库收益与误报未评估。pull-up/duplicate cleanup 不是必需 |
| high-confidence verification gaps | high/low、搜索要求、文本校验、unknown 降级 | 有降低误报的机制，没有准确率数据证明 high-confidence 已达标 |

因此，应把状态写成“核心框架已实现，已知边界待修复，产品级准确率待验证”，不能写“全部要求完美实现”。

## 3. 当前实现的具体缺口

### P1 — 仅修改测试的 PR 会失去合法 finding（已复现）

位置：`src/post.js:190`，尤其 `reviewable.has(c.behaviour.path)`。

案例：生产文件 `src/price.js` 未改变；PR 把 `assert.equal(total(5), 10)` 改成 `assert.ok(total(5))`。模型正确引用生产行为和改变后的断言，初始 `validate()` 通过，但 `verifyEvidence()` 由于生产路径不在 changed files，把该行降成 unknown 并删除 weak_test finding。

离线调用当前导出函数所得结果：

```text
Test-only PR validates: { ok: true }
After verification: { status: "unknown", findings: 0 }
```

这不是模型没有识别问题，而是程序丢弃了识别结果。应分开“本 PR 的变化/影响依据”“生产行为位置”“测试证据位置”：允许生产行为位于未修改文件，但必须有可核对的 changed-test 依据；不能简单取消全部范围限制。新增 assertion weakened、test skipped、assertion deleted、test file deleted 的验收案例。

### P1 — 规范清单与恢复规则不一致（已复现）

位置：`src/collect.sh:13`、`:25`、`:54`、`:60`。

`match()` 接受任意子目录中的 `REVIEW.md`、`CONTRIBUTING.md` 等文件，而恢复使用的 `:(glob)REVIEW.md` 等路径只覆盖根目录。临时 Git 仓库中，base 的 `pkg/REVIEW.md` 要求独立断言，head 将其改为跳过检查；运行现有 collector 后：

```text
Rule inventory: "pkg/REVIEW.md"
Nested rule after restore: HEAD: skip assertion reviews.
```

于是 PR 修改的文本仍被列为可信 base 规范。这项问题在上一轮根目录 AGENTS.md 的集成测试中没有被覆盖。

另一个同次确认的问题：根目录 `CODING_STANDARDS.md` 不在规范清单中。research 明确列出的 `docs/**/standards*`、`docs/**/conventions*` 也没有当前默认发现路径。模型即使引用这些规则，poster 也不能按可信规则验证它们。

优化：先确定一份路径清单，再用同一清单完成发现、base 内容读取/恢复和验证；对 head-only、删除、嵌套文件分别测试。规范路径可支持明确的消费者配置，但配置也要来自可信来源，不要让 PR 任意替换。

### P1（按 confirmed 的执行证据解释）— 缺少 lint/format 确认

当前没有 Checks/Statuses 的读取代码，也没有对应的 collector 输入。`standards.status = checked` 是模型的静态审查声明；`references/standards.md` 明确说它不代表 lint 已执行。原始 brief 没有规定必须用 lint 和作者 checkbox，但 research 将“confirmed”明确解释成工具证据；按这一解释当前不满足。

建议最小补充：保留 AI 的规则审查，另行记录消费者指定的规范检查结果（来源、check 名称、commit、run URL、status、conclusion）。采用 passed/failed/pending/not_found/unavailable；未配置时明确 not_configured，不把任意绿色 job 当成 lint 通过。作者 checkbox 只能算人工声明。

不照搬原研究中的固定 regex 与八分钟轮询：要核对指定检查是否全部出现、结果对应 head 还是 PR merge commit、重跑时使用哪个结果；neutral/skipped 不应自动等于成功执行。GitHub 提供按 ref 读取 check runs 的 API，但“哪些 checks 足以证明团队规范被执行”仍需要消费者契约。

### P2 — 无法证明所有 acceptance criteria 都被评估

位置：`src/requirements.js:28`、`src/post.js:31`、`src/post.js:149`，以及 schema 的自由文本 source。

collector 保留需求文本和来源，但未形成独立 AC 清单。模型自己列 coverage 行、自己声明 covered，校验器只检查这些已输出的行。PR 有 AC1 与 AC2，模型只输出 AC1，仍可能生成合法的 1/1 报告。当前措辞“assessed obligations”比“全部覆盖”诚实，但不等价于研究要求的逐 AC 完整性。

建议借鉴 research 的“先拆复合标准，再逐项映射”：输出原始 criterion 引文与来源、criterion ID、拆分后的 obligation IDs；未实现/无法关联到生产代码的要求也必须保留。不要让一个必填的 changed-behaviour 引用导致尚未实现的需求被省略。做 ID 关联检查能防止内部遗漏，但不能确定性保证任意自然语言已被完整提取；仍须评估提取召回率。

### P2 — 零断言的现有测试不能正确表达为 weak_test（已复现）

位置：`src/post.js:54`，`skills/test-review/SKILL.md:35`。

weak_test 必须携带 unit assertion evidence；已有测试只执行 `total(5)` 而完全没有 assertion 时，合法的“测试存在但没有断言”报告会被拒绝：

```text
{ ok: false, error: "coverage[0] weak_test needs a unit assertion" }
```

模型可改报 missing_test，但这丢失了现有测试与缺失断言的区别，也不能满足 research 的 no-assertion 分析。应允许引用实际测试/调用位置并明确 assertion 缺失，covered 则仍必须有断言证据。还应明确检查 skipped/disabled、删除/削弱断言、bug-fix 回归测试；源码中存在断言不等于该测试被 runner 执行。

### P2 — 高置信度尚未通过端到端评估

位置：`docs/design.md:277` 的 Success criteria 与 `:286` 的 Acceptance matrix。

现有测试主要将人工构造的 findings 传给 validator/poster，证明报告如何被处理。它们不验证模型能否在真实代码中找到遗漏需求、识别镜像断言、找到已有测试或正确推荐 pushdown。

文档提出跨三种语言、约二十个真实 PR、高置信度 precision >= 80%、时间和成本测量；当前没有对应评估产物。四次模型调用或自报分数不能替代这些证据。

## 4. Research 原型本身的风险

1. `research/ai-unit-test-review.yml:297` 把 neutral 与 success 合并；按名称 regex 匹配到一个成功检查也不能证明要求的 lint 与 format 全部执行。
2. `:618` 的 headline 在没有 blocking/important finding 时使用 passed，没有优先判断 reviewer errors。所有 AI legs 出错时，轴明细虽然写 Error，总标题仍可能 passed。advisory job 不阻塞与审查结论通过必须区分。
3. `:462` 使用 allowedTools 加 disallowedTools 列表。官方 CLI 文档区分 allowedTools（无需询问即可执行）与 tools（可用工具集合）。不能将前者的描述直接当成完整工具隔离保证；当前 Action 的 tools 策略应保留。
4. 四个 reviewer 自己发 inline 评论，报告过滤在其后执行；后处理无法撤回已经发布的误报或完成统一去重。当前由 poster 集中发布更适合保留。
5. `requirements` 在 research schema 中不是各轴强制字段；模型漏输出该数组也可能返回形式上有效的结果。其“完整需求矩阵”同样需要补充验证。
6. 阻塞 gate、四 agent、Jira、mutation execution 是选项或后续扩展，不应为了套用研究而默认添加。

## 5. 建议优化顺序与验收

| 顺序 | 改动 | 最低验收 |
|---|---|---|
| 1 | 修正测试变化的影响范围与引用模型 | 仅改测试、删除断言、skip 测试能保留有依据的 finding；无关的历史缺陷仍不进入本次 review |
| 2 | 统一规范发现和 base 信任来源 | 嵌套 REVIEW/CONTRIBUTING、CODING_STANDARDS、head-only、删除规范等情形测试通过 |
| 3 | 单独提供规范工具执行证据 | 指定 checks 全部成功才 confirmed；pending/missing/unavailable 均明确显示；不改变 advisory 默认 |
| 4 | 补 AC 引文映射和零断言表示 | 两个 AC 不能因只输出一个而显示完整；复合 AC 分拆；已有零断言测试能被准确描述 |
| 5 | 运行真实模型验收集 | 每个原始目标都有 seeded 正例/反例；记录 finding precision、seeded gap recall、JSON 有效率、时延和成本 |
| 后续按需 | ingest 已有 coverage / mutation artifacts | 校验 commit、producer、范围与完整性，只读取，不在持有 AI 凭据的任务中执行 PR 代码 |

保留一个 agent 和独立的报告维度。只有测量表明单 agent 存在系统性跨维度遗漏，而且增加模型执行确实改善结果，才考虑拆分。门禁的引入应另作产品决策，不属于补齐 Original Goal 的前提。

## 6. 本轮证据与限制

- 已逐份阅读 research 的报告、skill 和完整 workflow，并对照当前 collector、schema、skill、poster、测试与 design。
- 使用当前导出函数复现了 test-only PR 丢失 finding、weak_test 无断言被拒绝；验证单行 coverage 无法表达遗漏的第二个 AC。
- 在临时 Git 仓库实际执行 collector，复现了嵌套 REVIEW.md 未恢复、CODING_STANDARDS.md 未被发现；临时目录已清理。
- 本轮未再次执行完整测试套件，未调用付费模型、发布评论或修改运行时代码。上一轮的 26 项通过不覆盖本轮新发现的反例。
- 外部复核仅用于必要的能力边界；没有把研究报告的竞品覆盖、成本和市场唯一性断言当成已验证事实。

官方参考：[Claude CLI 工具控制](https://code.claude.com/docs/en/cli-reference)、[GitHub Check Runs API](https://docs.github.com/en/rest/checks/runs#list-check-runs-for-a-git-reference)。
