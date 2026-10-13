# Shift-left 与目标对齐：第一性原理批判审查

日期：2026-10-14。基线：main `59bfffb`（#120–#124 已合并）。
性质：只做分析。本文建立在 `docs/goal-first-principles.md`（U1–U20）和 `docs/handoff-goal-critique.md`（N1–N18、P0/P1）之上，不重复它们的论证，只给出这两份文档写完之后的状态变化和新问题。

## 1. 结论

1. **SpecGuard 现在能在真实的外部 PR 上找到真实的测试缺陷，单次成本约 $0.01。** 2026-10-14 在 date-fns#4366 上做了一次手动运行，找到 2 个问题，人工核对后都成立：一个缺失测试，一个"去掉修复也照样通过"的弱测试（§4）。这是 shift-left 最想要的那类发现。
2. **最大的缺口仍然是"结果有没有用"从来没在真实使用中测过。** did-fix、误报率、time-to-merge 至今都是零数据（§5 C1）。另外，**手动运行这条主线在结构上就收集不到 did-fix**：它只把结果写到 run 页面，不写 PR，也不跟踪后续推送。
3. **今天验证过的引擎，并不是公司要用的引擎。** 今天所有的质量数据都来自 Claude Haiku 5.5（临时 secret `SPEC`）。公司的默认路径是 Copilot PAT，这条路径因为额度用完，最近一直没有跑过（§5 C2）。
4. **把公司代码发给哪家模型服务商（Q8），是用 SpecGuard 分析内部仓库之前必须先定下来的问题。** 现在手动运行一旦对私有仓库使用 `SPEC`，代码就会被发到 Anthropic API。
5. **在 precision（不误报）上做了很多，recall（不漏报）却没有在当前引擎上测过。** 截断防护、降级评审只展示高置信项，这些都在压误报。但如果没有在真实仓库上用植入缺陷测过 recall，"安静"可能只是"漏看"（§5 C4）。
6. **测试分层的判断仍然靠模型，而 push-down 建议依赖这个判断。** express 用 supertest 走 HTTP 的测试被标成了 "unit"（§5 C5）。这类测试按很多团队的定义属于组件测试。
7. **需求捕获依赖 PR 正文。** 今天三次运行都显示 "no structured acceptance criteria found"。一旦公司的 PR 正文写得很薄，评审就会退化成"只看代码的测试缺口"（§5 C6）。

## 2. 第一性原理：shift-left 的价值链

一个缺陷要在 PR 阶段被拦下，下面每一环都必须成立。任何一环断掉，价值就归零。

| 环节 | 必须成立的条件 | 今天的证据 | 状态 |
|---|---|---|---|
| E1 存在 | 缺陷在 PR 时刻能被静态看出来 | 只有 OSS 数据；用户仓库的 50 个缺陷分类（N7/P0-1）没做 | 未知 |
| E2 看到 | 引擎读到了相关代码、测试和需求 | context pack 会读需求里点名的文件和同目录文件（#124）；date-fns 读到了 `subMonths/test.ts` | 部分 |
| E3 说对 | 发现是真的，引用准确 | 今天 4 条外部发现人工核对全部成立；dogfood 有 1 条误报（测试文件被截断），已加防护（#123） | 小样本好 |
| E4 及时 | 合并前送到作者面前 | PR 模式每次推送都跑，大约 1 分钟。**手动运行只写 run 页面，作者看不到** | PR 模式成立，手动运行不成立 |
| E5 看懂 | 10 秒内知道补哪个测试 | summary v2：结论在第一行，带测试骨架；顶部排版正在重做（`feat/summary-clarity`） | 进行中 |
| E6 行动 | 作者真的改了 | 零真实数据（N18） | 未测 |
| E7 值得 | 收益大于噪声、延迟、成本 | 成本已降到每次 $0.01–0.10；噪声和延迟没有真实数据 | 成本成立 |

**推论：** E3 和 E5 是这一轮投入最多的环节，现在已经接近可用。真正的风险在 E1、E4、E6：它们决定 SpecGuard 是"工具"还是"摆设"，可是这三环一个都没测过。

## 3. 目标对齐

原始需求（`docs/design.md:40-47`）：评审需求和测试，找出缺失的单元测试；确认编码规范；检查组件/集成测试里哪些应该下沉为单元测试；第一阶段交付 GitHub Actions workflow。用户在 2026-10-13 补充的决定见 `design.md:57-63`，并且把主线定为在 SpecGuard 仓库里手动运行、分析其他仓库。

| 目标 | 现状 | 证据 | 差距 |
|---|---|---|---|
| G1 需求 + 测试 → 缺失单元测试 | 能做，质量在小样本上好 | date-fns 的缺失测试和弱测试（§4）；express 9/9 义务项有证据 | recall 没测；需求依赖 PR 正文 |
| G2 编码规范已确认 | 能读规则文件；lint 结果需要配置 `standards_checks` | express 运行："Lint/format tools are configured … results are not confirmed" | 手动运行拿不到目标仓库的 CI check 结果，"确认"只能做到读规则文件这一步 |
| G3 测试下沉 | 有建议机制，但从未被验证 | `design.md:511` "Pushdown suggestions are not validated"；supertest 被标成 unit | 分层定义因组织而异（N14），模型判断不可靠 |
| G4 GitHub workflow 交付 | 完成：PR workflow、reusable workflow、手动运行、本地运行 | `.github/workflows/*`、`bin/specguard-local.js` | 私有仓库需要 `SPECGUARD_PAT`（未设置） |
| G5 手动运行分析其他仓库（主线） | 能跑通公开仓库；结果可下载（artifact） | 今天 4 次手动运行 | 不能分析已关闭或已合并的 PR；scan 模式今天没有用 Claude 实跑；结果不会回到作者手里 |
| G6 PAT 优先计费 | Copilot PAT 路径代码就绪，Claude 作为自动适配的另一条路径 | `src/credential.js` | Copilot 路径最近没有实跑（额度用完） |

## 4. 今天的实证（手动运行，Claude Haiku 5.5）

| 运行 | 修复前（#124 之前） | 修复后 |
|---|---|---|
| express#7511 | 3/7 义务项有证据；4 条被引用校验误降级；需求 X1 显示 "Check by hand" | 9/9 有证据，没有误报 |
| date-fns#4366 | context pack 只读了 20 KB；`subMonths` 没读到 | 读到 `subMonths/test.ts`，报出 1 个缺失测试和 1 个弱测试，人工核对都成立 |

date-fns 的弱测试值得单独说一下：`addMonths(1月15日, -1.5)` 在修复前后结果相同，因为 JS 的 `setMonth` 本身就会截断。所以这条断言测不出回归。SpecGuard 给出了能区分修复前后的输入（3月15日）。这类问题正是覆盖率工具和"测试是否存在"检查都看不出来的。

dogfood（SpecGuard 评审自己的 PR）期间，报出 2 条真实的弱测试或缺失测试，都已修复，并做了反向验证（去掉被测逻辑，测试会失败）。另有 1 条误报，原因是 3000 行的测试文件被截断。#123 加了防护：测试文件没看全时，不允许断言"缺测试"。

**样本局限：** 外部只有 2 个 PR，而且都是测试规范很好的 OSS 库。这不能代表公司仓库。

## 5. 关键问题（按影响排序）

### C1 没有真实使用的结果数据，手动运行也收集不到

- did-fix、误报率、time-to-merge：零数据（Explore 核对，2026-10-14）。`eval/weekly-report.js` 等脚本存在，但从未在真实数据上跑过。
- 手动运行使用 `delivery: summary`，不写 PR，没有 sticky summary，也就没有 "Since last push" 和 fix-through 的累积。已关闭或已合并的 PR 会被拒绝分析。
- **建议：** 把手动运行的结果 artifact 汇总进 SpecGuard 仓库里的一个台账（ledger）issue，每次运行追加一行：目标、发现数、类型、成本。对同一个 PR，作者推送后再跑一次，比较两次结果就能得到 fixed/new。这样不需要往目标仓库写任何东西，就能开始积累 E6 的数据。

### C2 验证用的引擎与公司路径不一致，合规问题还没定

- 今天的质量数据全部来自 Claude Haiku 5.5。公司默认的 Copilot 路径（`auto` 模型）从额度用完起就没有实跑过；Kite 试点中 Copilot 有 2/5 次没满足 JSON 契约（`docs/pilot-kite.md:29`）。
- `specguard-run.yml` 和 `ci.yml` 里还留着临时的 `llm_token: … || secrets.SPEC` 和 `model: haiku-5.5`。
- Q8（能否把代码发给 Copilot / Anthropic）没有答复。对私有仓库做手动运行之前，必须先回答。
- **建议：** 做一个明确决定。要么 Claude 成为正式支持的引擎（需要 Q8 批准，并把 `SPEC` 改名为 `SPECGUARD_LLM_TOKEN`），要么等 Copilot 额度恢复后，在同样两个 PR 上用 Copilot 重跑做 A/B，再移除临时配置。

### C3 降级评审是 Haiku 的常态，代价没有量化

- Haiku 被归为 fast tier，所以每次都是 reduced：只展示高置信的发现。今天 date-fns 的两条发现都通过了这个门槛，但被挡掉的发现有多少、其中多少是真的，没有数据。
- **建议：** 对今天这两个 PR，比较 reduced 输出和完整输出（看 findings.json 里被过滤掉的部分），决定 Haiku 加上 context pack 之后是否还需要降级。

### C4 recall 没有在当前引擎上测过

- 这一轮的改动大多在压误报（引用校验、截断防护、低置信项不计数）。这些都对，但"安静"和"漏看"在输出上看起来一样。
- 植入缺陷的工具已经有了（`eval/mutate`、seeded cases），只是没有用 Claude 和 context pack 跑过。
- **建议：** 选 1 个公开仓库，植入 10 个已知的测试缺口（删断言、放宽断言、删边界用例），走手动运行，报告 recall。recall 低于 6/10，就不要再加防误报的规则。

### C5 测试分层靠模型判断，push-down 建议不可靠

- express 用 supertest 发 HTTP 请求的测试被标成 "unit"。对很多团队来说这是组件测试。G3（下沉建议）依赖这个判断，而它从未被验证过（`design.md:511`）。
- **建议：** 让手动运行支持一个 `test_layers` 映射（路径 glob → 层级），由用户声明；没有声明时，确定性规则优先于模型判断（例如：用到 supertest/HTTP 客户端的算组件测试）。

### C6 需求捕获依赖 PR 正文，公司 PR 可能更薄

- 今天三次运行都是 "no structured acceptance criteria found"，需求来自 PR 正文的条目和关联 issue。OSS PR 的正文通常写得很仔细，公司的 PR 不一定。
- P1-1（PR 模板里的 "Acceptance criteria:" 段）没有作为交付物提供。
- **建议：** 提供一个可复制的 PR 模板，并在 summary 的 Details 里注明"没有结构化验收条件；在 PR 正文加 `Acceptance criteria:` 段会让评审更准"。在第一屏只出现一次，不制造噪声。

### C7 手动运行的覆盖面

- 能做：公开仓库的 open PR（PR 模式），仓库或分支的 scan。
- 不能做：私有仓库（`SPECGUARD_PAT` 未设置）、已关闭或已合并的 PR、执行证据（手动运行没有 `coverage_files`）。
- scan 模式今天没有用 Claude 实跑过。scan 的两次确认机制依赖 issue 状态，但还没在真实仓库上走完一个周期。

### C8 summary 仍有可读性债务

- 顶部排版和 "Not assessed" 的歧义正在修（`feat/summary-clarity`）。
- Details 里的义务项表格仍然很重，"Unit evidence X/Y" 可能被误读成 KPI（N12）。PR summary 没有"不是覆盖率、不用于考核个人"的说明，scan 模式有。

## 6. 已验证与未验证

| 已验证（有实跑证据） | 未验证 |
|---|---|
| 凭证自动适配（Claude 路径）；成本有硬上限 | Copilot 路径的当前质量 |
| 在外部公开 PR 上找到真实的缺失测试和弱测试（n=2 个 PR） | recall；公司仓库上的表现 |
| context pack 能读到需求点名的文件 | 大型 monorepo 上的打包效果 |
| 截断时不再断言缺测试 | 防护是否压掉了太多真实发现 |
| 手动运行端到端：触发、评审、artifact | 私有仓库、scan 模式的两次确认周期 |
| summary v2 的结构 | 开发者是否真的在 10 秒内看懂并去修（E5、E6） |

## 7. 需要用户决定的事

| 问题 | 为什么只有用户能定 | 阻塞什么 |
|---|---|---|
| Q8：能否把公司代码发给 Anthropic（或 Copilot） | 公司合规政策 | 用 Claude 分析任何内部仓库 |
| Claude 是否成为正式引擎 | 采购和计费 | 移除临时配置；C2 |
| 建 `SPECGUARD_PAT`（只读，目标仓库） | 需要用户账号创建 | 分析私有仓库 |
| 50 个历史缺陷样本（Q6 剩下的部分） | 只有用户能访问缺陷系统 | E1：确定上限 |
| Q4：是否评审"需求本身是否可测试" | 产品范围 | U10、N10 |
| Q7：是否评审 coding agent 写的 PR | 产品范围 | N1 |

## 8. 下一步（按优先级，带退出条件）

| 优先级 | 动作 | 退出条件 |
|---|---|---|
| P0 | 合并 summary 排版修复 | 重跑 date-fns 后，第一屏 ≤ 8 行，没有内部用语 |
| P0 | 用户答复 Q8，并决定正式引擎（C2） | 临时 `SPEC` 和 `haiku-5.5` 从两个 workflow 中移除 |
| P0 | 手动运行结果台账（C1） | SpecGuard 仓库里有一个 issue，自动追加每次手动运行的结果行 |
| P1 | recall 实验（C4） | 10 个植入缺口的 recall 和 precision 数字写进 `docs/validation-plan.md` |
| P1 | reduced 与完整输出对比（C3） | 决定 Haiku 加 context pack 后是否保留降级评审 |
| P1 | 用 `SPECGUARD_PAT` 在 Kite 上做一次手动运行 | 私有仓库路径端到端跑通 |
| P2 | `test_layers` 声明（C5）；PR 模板（C6）；scan 用 Claude 实跑一个周期（C7） | 各自有一次实跑结果 |

**不做的事：** 在 C1 和 C4 有数据之前，不再增加新的检测机制或防误报规则。现在缺的不是机制，是证据。
