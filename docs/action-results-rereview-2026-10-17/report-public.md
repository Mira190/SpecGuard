# 新 Actions 结果复审：公开 PR 与评测有效性

日期：2026-10-17，Australia/Sydney。本轮核查已存在的实际运行，没有重跑付费模型、修改产品、切换工作区或向 GitHub 写评论。源代码固定为 main `47130d45c518a09cb475f1157469c4e2a30a40ec`。

## 1. 结论

**公开 PR 的结果证明新 PR JSON 路径可以跑通，combined 能把多类发现放在同一份 Summary；尚不能据此验收完整 review 或溯源目标。** 评测输入有效性、需求文档排除、计分隔离和证据完整性仍是本报告确认的主要限制。

本轮公开范围包括：#311 最终 CI 与 dogfood；#307–#328 中 21 个 isolated PR；#331/#332 两次 21-case combined 的实际 artifacts 与提交。本公开版只整理 SpecGuard 公开 PR 的观察；原始上下文、诊断脚本、JSON 和源码快照留在本地，不随本报告发布。文中的这些文件名是历史证据标识，不是公开下载或复跑入口。

应先看以下发现，而不是 Actions 的绿色比例。

## 2. P1：需求文档被 eval workflow 排除，甚至出现错误测试 oracle

实际 dogfood 配置宣称“只有 eval-sandbox 是需求来源”，却传了 `!docs/**`、`!README.md` 等排除模式。真实 `trace.matchGlob()` 支持任意层级匹配，因此它们也排除了 sandbox 自己的 `docs/requirements.md`、`docs/specs/*.md` 和 README。排除优先于 include，仅再加 sandbox include 不足以纠正。

独立实际函数复现保存在 `isolated-worker/config-probe.json`，不是从输出猜测：

| 需求来源 | 被哪个模式排除 |
|---|---|
| `eval-sandbox/tr19/docs/requirements.md` | `docs/**` |
| `eval-sandbox/tr22/docs/specs/signup.md` | `docs/**` |
| `eval-sandbox/tr23/docs/specs/http.md` | `docs/**` |
| `eval-sandbox/tr16/README.md` | `README.md` |

两个现场例子最有价值：

- [#312 / tr19](https://github.com/Mira190/SpecGuard/pull/312)：实际提交完整，需求把日志保留期从 90 改到 180 天，源码和测试仍为 90。Action 却 Nothing to review，并记录 complete/head marker。归因是输入配置先移除了需求，不能用这个样本判断模型看到正确 R 后会不会识别漂移；按用户端到端目标，目标警报确实没有送达。
- [#316 / tr22](https://github.com/Mira190/SpecGuard/pull/316)：实际提交完整，把 `age >= 18` 改为 `age > 18`。现有 R2 明确“至少 18 岁”，却被排除。输出只报边界测试缺口，骨架建议 `assert.equal(canRegister(18), false)`，会把错误实现固定为测试预期。它同时提醒先确认这次行为改变是否有意，这个限定有价值；但在明确 R2 下，false 仍是错误 oracle，不能算需求溯源命中。

这不是给全体模型错误统一找借口：缺失 R 与错误建议应分别计数。应修复评测的需求范围契约，逐项核验 governing docs 已进入 spec-files/criteria，再测 R→C、C→R 和 C=T≠R。不要为了这些 eval 静默改变所有用户的 glob 语义。

## 3. P1：combined 计分器未隔离新版 Summary 条目，误报成倍复制

两次 combined 的**实际提交输入均完整**：每次 21/21 个 case 的 head overlay 与 Git blobs 一致，deletion 也核对通过。这点比前一批无效 trace 输入更可靠。

但运行 `eval/grade.js.filterSummary(summary, casePrefix)` 后，新版正文条目：

```markdown
- Gap B [`eval-sandbox/b/b.js:1`](...) (inline limit reached) — ...
```

仍会留在 case A 的 Summary 中。函数只识别较旧的 `- **Missing test:** ...` 形式与部分表行，没有覆盖新版无标签正文列表。

`filter-summary-probe.json` 的两条 bullet 最小反例：请求前缀 A 后，parsed items 仍有 A 和 B。对真实产物使用仓库 canonical grader：

| 运行 | canonical TP | canonical FP | canonical FN |
|---|---:|---:|---:|
| #331 | 4 | 168 | 20 |
| #332 | 4 | 147 | 20 |

**168/147 不是模型产生了那么多独立噪音。** 同一批其他 case 的 Summary 条目在各 case 反复记账，不能把这个 precision 当真实模型质量。

原始结果保留在 `combined-results.json`；没有修改 shipped grader 或原始 expected。另提供评测目录内的诊断：按当前 Markdown 实际路径隔离，并明确采用“可行动 Summary 也算送达”的替代政策，保持原 kind/path/tolerance。结果是 #331 原始可匹配线索 14/24、实际可行动送达 10/24；#332 分别 12/24、9/24。这只是有定义的诊断，不能替换原 canonical score，也未消除已有 coverage/inline 重复和语义标注限制，因此不发布其 precision 作为产品结论。

优先修复分组身份与当前 Markdown 解析，增加“过滤后无外 case item/coverage”的不变量，再重新计算；不需要为此重跑模型。

## 4. P1：新的 isolated 批次仍有无效构造，且多数不是最新构建

逐一比较固定 case 的 base/head overlay、实际提交 blobs 和删除，结果：

- 21 个 isolated PR，10 个构造完整、11 个无效。
- 无效中 9 个零 diff，2 个只提交了部分预期 overlay（tr2/tr5）。
- 17 个 trace case 仅 6 个提交完整；完整不代表需求配置也有效。
- 8 个实际调用模型并留下 counts 的运行，1 个 build `9224bdda240f`、7 个 `34dfad4db80c`，均没有包含最新版 #311。不能凭 PR 编号较晚就断言使用了最新引擎。

完整逐例表在 `isolated-worker/report.md` 与 `audit.json`。零 diff 的正例属于评测构造失败；x1/tr9 的预期 skip 则是正确负对照，不能一起算故障。部分 overlay 不能只靠 changed-files>0 判成有效。

正面证据也应保留：#325/#326/#327 三个合法 TypeScript case 分别送达 3、3、1 条 inline 测试缺口或标准违规。它们证明这些机制在该样例生效，但不证明最新 #311 的能力增益或端到端 traceability 达成。

下一步在开 eval PR、花模型额度前，核查 worktree 内容、实际 staged blob、提交 diff 和 oracle 引文；固定 Action SHA/build，而不是让 uses ./ 随 sandbox base 的创建时间变化。

## 5. combined 真正证明了什么

两次运行分别是 [#331 / run 39025832897](https://github.com/Mira190/SpecGuard/actions/runs/39025832897)、[#332 / run 39026004319](https://github.com/Mira190/SpecGuard/actions/runs/39026004319)。两次 actual build 都是 `6c64d4887d04`，与 main #311 相同。

| 实际产物 | #331 | #332 |
|---|---:|---:|
| 输入 case 构造完整 | 21/21 | 21/21 |
| reviewable changed files | 41 | 41 |
| focus files | 20（12 source + 8 tests） | 相同 |
| raw model findings | 13 | 12 |
| raw obligations | 18 | 17 |
| inline comments | 3 | 3 |
| 最终首屏行动项 | 11 | 10 |
| Details 中低置信 findings | 4 | 4 |
| 实际模型 | claude-haiku-5-5 | 相同 |
| engine duration | 105.175 秒 | 92.460 秒 |
| 输入 tokens（含 cache） | 66951 | 66951 |
| 输出 tokens | 25816 | 22981 |
| usage × 价表的报告成本 | $0.01847504 | $0.01705754 |
| job / review status | success / incomplete | success / incomplete |

成本来自 artifact 的 usage 与代码价表，没有独立核对 provider 账单。两次 prompt hashes 不同，token 总量相同不能证明字节级输入完全相同。这是两次同构建的大 PR 压力样本，不是 42 次独立评审，也不是新旧版本 A/B。

实际送达的好例子：网络错误重试和最终失败路径、unknown user 违反错误需求、两个 throw-string 规范违规、纯计算下沉测试、删除断言。这说明**单份 Summary 可以承载溢出 inline 的可行动发现**。仅数 3 条 inline 会低估交付。

但 21 case 并没有全部审完：k2、r2、rx2、rx3、t1–t4、ts1–ts3 都没有进入 focus。t4 的删除断言仍由确定性路径进入报告，不能把它算成模型审完该 case。两次 r1 的 credit-floor finding 也不一致；四个低置信缺口主要是 clip label、FIVEOFF、empty order、trim，不能把隐藏 counts 中的标题当作明确修复要求。

在明确“Summary 也算送达”的诊断口径下，两次各只把 24 个 seeded expectation 中的 10/9 个作为可行动项交付。未选中的范围仍保留在分母，不能只报 selected scope 的命中率。

`max_comments=30` 也不会让 fast-tier 有 30 条 inline：`post.js` 的 `REDUCED_INLINE=3` 是全局策略。重点应是最终送达集合、置信度与证据，不是评论数量。

## 6. P2：评测自身代码和其他 case 污染测试候选，浪费证据预算

真实 `pr332-ctx/test-candidates.txt` 中：

- `l1/pricing.py` 的前四个候选是 SpecGuard 的 `eval/grade.test.js`、`src/collect.test.js`、`src/post.test.js`、`src/trace.test.js`，真正 `l1/test_quote_api.py` 排第五。
- fixture 副本 `eval/cases/...` 被当作实际候选测试；k1 也会匹配 SpecGuard 自测。
- p1 会匹配 rx2/rx3 的 React tests，s1/s2 会互相匹配同名 config tests。

两个 Summary 都因此报告多份无关 reviewer tests 被 cut；小 isolated 也有同样问题。workflow 的 ignore 主要用于 diff 范围，不等于候选与 pack 证据的隔离。

它使小业务模块被检索噪音拖成 incomplete，也给“相同字面量是否意味着已覆盖”制造条件。当前产物直接证明候选污染和预算损失；没有把所有低置信降级都无证据归因给同一个 guard。

应隔离 eval scaffolding 与业务 evidence，保留真正 sandbox tests；跨 case 的相同词不能成为覆盖证明。仅增大 pack 或降低 confidence gate 都不能代替这个修复。

## 7. #311 新 PR JSON 路径的现场结果

[最终 CI run 39024966831](https://github.com/Mira190/SpecGuard/actions/runs/39024966831)：1442 tests，1438 pass、0 fail、3 skipped、1 TODO。

新 PR 模式直接请求 plain JSON，scan 仍保留 schema/fallback。#311、#331、#332 最终产物都能解析为 findings.json；所读最新 dogfood 日志没有先前必然出现的 schema 400 fallback。能确认新的成功路径跑通，不能因此称为 schema-enforced 输出已恢复，也不能声称已测出稳定性提升比例。

#311 自己的 dogfood 仍是 incomplete，0 当前 findings，三个历史发现是 not_observed，而非已验证修复；原文明确部分引擎/测试上下文未可见。不能拿“测试全绿 + 当前零发现”认定所有旧问题修好。

## 8. 后续处理与证据边界

1. 在开启 eval PR 或调用模型前，核验 staged blobs、提交 diff、完整 overlay 和需求文件的实际收集范围。
2. 修复跨 case 的 Summary 过滤及 finding/coverage 去重，先使用既有产物重算分数。
3. 隔离评测脚手架、其他 case 与 reviewer 自测，优先保留目标业务的源码和直接测试。
4. 固定 Action build、目标快照与 oracle 后，再进行新旧版本的模型比较。

以上是固定版本的历史复审结论，本次公开整理没有重新验证当前主线，也没有修复产品或评测逻辑。原始上下文和与其他仓库有关的材料保留在本地；本公开版不发布跨仓库运行详情，亦不主张完整审查、调用级溯源或 QA 收益已经通过验收。
