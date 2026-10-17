# SpecGuard 最新 GitHub Actions 与 PR 实际证据复核

> **处置状态（2026-10-17，main 45713a2）：** 本文发现已复核。已修复：auth 失败下 dogfood 仍绿（#222、#225）；reducedReasons 依赖文案（#221）；PR 模式真实 guard 端到端（#221）。未修复/待办：k2 TODO；跳过的真实 audit replay。行号与 SHA 以本文写作时为准。

> 本文保留较早运行快照。#218–#223 后续已合入，新 dogfood 已能运行模型；最新状态及新发现见[unknown unknown 复核](C:/Files/Projects/SpecGuard/docs/unknown-unknown-review-2026-10-17.md)。下文 19 个认证失败摘要不是最新运行现状。

本报告是[分支整理报告](C:/Files/Projects/SpecGuard/docs/repository-branch-review-2026-10-17.md)的远程运行证据补充。通过用户指定的 GitHub 插件读取，未重跑 workflow、调用模型、修改配置或向 GitHub 写入评论。

复核快照：2026-10-16 21:54 UTC，悉尼 2026-10-17 08:54。main 仍为 `bcddf784f70d4f5b5a854d2c75789bd33f1591aa`，83 条远程分支；开放 PR 仍是 #218、#199、#9、#8。

**核心结论：最近代码修复有远程自动化测试和人工评审支持，但近期 dogfood 的模型评审链路没有成功证据。应优先恢复并验证真实运行，再扩大扫描和统计质量。**

## 1. 这次实际读取了什么

- 最新 50 次 Actions 运行元数据：2026-10-16 09:48:24–12:28:06 UTC 创建，包含 35 次 PR 事件、15 次 main push。
- #197–#218 共 22 个 PR 的最新 SpecGuard 机器人摘要；另读取 #199、#215、#217、#218 的评审讨论。
- 9 个关键 run 的 job/step 状态、其中 10 个 job 的原始日志。包括最新 main、#218、#215/#217 的 dogfood、两次失败测试、#199，以及最近两次 manual run。
- 当前 main 的 CI workflow 和相关本地缓存代码；当前缓存 main 与实时 SHA 一致。
- 4 个 run 的 artifact 元数据；取得 #218 ZIP 下载引用，但本地下载因 DNS 解析失败，**没有读取 ZIP 内容**。

完整元数据、选取的日志行和摘要正文保存在[证据 JSON](C:/Files/Projects/SpecGuard/docs/github-actions-pr-evidence-2026-10-17.json)。未保存临时签名下载 URL、密钥或整份原始上下文。

## 2. 必须拆开的三个结论

| 观察层 | 实际结果 | 正确解释 |
|---|---|---|
| workflow 成功率 | 最近 50 次：47 success、2 failure、1 cancelled，即 94% success | 仅代表运行的检查结果，不代表模型完成率或缺陷召回率 |
| main 自动化测试 | 1186 项：1182 pass、0 fail、3 skipped、1 TODO | 当前确定性测试通过；没有覆盖被跳过/TODO 的能力 |
| PR 最新模型摘要 | 22 个中 19 个 auth_failed、3 个因全部文件被忽略而未调用模型 | 在这批最新摘要中，19 次尝试均无成功模型评审证据 |

第三行按 **PR 最新摘要**计数，不按 workflow 尝试次数计数。机器人评论会被更新，不能据此还原所有历史调用，也不能把 19/22 当作全服务长期认证失败率。3 个 ignored 也不应算成成功模型评审。

## 3. [P1] dogfood 的认证问题是持续存在的链路故障

[#218 dogfood 原始日志](https://github.com/Mira190/SpecGuard/actions/runs/38900709026/job/116971973269) 在 12:28:20 UTC 记录认证被拒绝；随后 engine step 和 job 均 success。相同现象也出现在 [#215](https://github.com/Mira190/SpecGuard/actions/runs/38898412110/job/116964379407) 和 [#217](https://github.com/Mira190/SpecGuard/actions/runs/38897355440/job/116960930096) 的最终运行日志中。

这与现有设计一致：Action 默认 `fail_on_error: false`，向 PR 提供 advisory 结果；失败已经在机器人摘要中明确显示。因此问题不是“完全没有失败状态”，而是 **CI 绿色和用户期待的模型评审完成之间缺少门禁对应关系**。

当前 [CI workflow](https://github.com/Mira190/SpecGuard/blob/bcddf784f70d4f5b5a854d2c75789bd33f1591aa/.github/workflows/ci.yml) 使用临时 token fallback 和固定 `haiku-5.5`，未设置 `fail_on_error: true`。日志只能证明 provider 拒绝了凭据，不能判断究竟是哪一个 secret 被选中、是否过期、填错或权限不符；不应从变量名猜测原因。

建议按最小改动处理：

1. 核对实际 provider、凭据来源和模型配置，修复后只对一个有代表性的 PR 重跑验证。只记录 provider 和来源名，不输出密钥。
2. 本仓库 dogfood 使用现有 `fail_on_error: true`，让认证/配额/无法使用的输出等运行失败可见；是否设为 required check，再结合服务稳定性决定。无需改变所有下游用户的 advisory 默认值。
3. 引用 Action 已有的 `status`、`skip`、`partial`、`superseded` outputs，并把“全部忽略”与“模型完成”分开统计，不再只读取 job conclusion。
4. 验收必须同时满足：provider 成功响应、结构化输出可用、post 校验完成、summary 指向正确 head，且存在可追踪的终态。单凭重跑后绿色不够。

不建议在失败期间用 `force` 批量重跑所有 PR；认证错误无法靠增加调用次数解决。历史修复仍可根据确定性测试和人工 review 判断，不能因为 dogfood 失败就推断所有修复无效。

## 4. [P1] 最新 main 确实通过测试，但仍有明确的质量盲区

[main 测试日志](https://github.com/Mira190/SpecGuard/actions/runs/38898934737/job/116966103621)显示 1182 pass / 0 fail，约 54 秒；main push 的 dogfood 是 skipped，不能称为 main 的模型扫描通过。

[#218 测试日志](https://github.com/Mira190/SpecGuard/actions/runs/38900709026/job/116971973683)显示 1187 项：1183 pass、0 fail、3 skipped、1 TODO，约 48.9 秒。这补足了上一份报告中“本地完整测试因临时 Git 权限受阻”的远程证据，但不替代模型质量评测。

main 的例外项：

| 例外 | 影响 | 建议 |
|---|---|---|
| k2 toolbox has() 的 weak_test 误报期望是 TODO，实际断言仍失败 | CI fail=0 不代表该误报已解决 | 保持已知限制，单独列为 release 质量指标；修复时带真实模型召回对照 |
| two-real-audits replay 被跳过 | 本次 CI 没有证明两次真实扫描确认链路仍有效 | 保存可取得的脱敏 fixture，安排该回放在具备数据的环境执行并记录结果 |
| pinned commit 验证因 shallow checkout 跳过 | 此运行未完成该来源核验 | 对这一检查补取需要的对象，避免为了单项检查无条件拉取全部历史 |
| competitor prompt 检查被跳过 | 该项约束本次未验收 | 核对跳过条件与使用场景；不把它计入已通过能力 |

[kite-fp.test.js](https://github.com/Mira190/SpecGuard/blob/bcddf784f70d4f5b5a854d2c75789bd33f1591aa/eval/kite-fp.test.js)明确说明：k2 回归使用 canned model answer，经真实 collect/post/fake GitHub 验证；其中一个测试故意固定“当前误报仍会发布”，另一个 TODO 描述期望行为。它能验证后处理边界，不能测量最新模型的 precision/recall。不要仅修改断言或关闭 TODO 来提高表面通过率。

## 5. 最近两次测试失败有具体原因，不能泛化为当前 main 仍失败

| 运行 | 当时失败 | 后续证据和判断 |
|---|---|---|
| [38896210918，#217 早期 head](https://github.com/Mira190/SpecGuard/actions/runs/38896210918/job/116957180120) | 3 个实际失败：ownFile delegated-helper 误报、scan real guard 的委托控制、TEST_PATHS 场景；另有独立 TODO | 后续 #217 head 已更换，最终 CI success，main 全套通过。人工 review 解释：候选测试范围不能误限制 delegated-helper 搜索 |
| [38895860994，#215 早期 head](https://github.com/Mira190/SpecGuard/actions/runs/38895860994/job/116956040137) | 2 个实际失败：原先期待“干净”的文档/单元组合，现在显示需人工检查；不完整扫描标题也增加未知块说明 | 与新的弱证据语义有关，随后调整了测试场景；最终 main 通过。不应只读旧红灯就认定新 head 不可合入 |

这体现了 shift left 的已有价值：有正反例的确定性回归能在合并前拦截真实兼容问题；人工 review 还能解释为什么一个范围限制修复会影响委托测试。应保留这些回归，而不是只追求减少 CI 红灯。

## 6. PR 评审记录如何改变优先级

### #215：结构化降级原因的 WIP 应保留，原循环问题已经修过

[#215 的评审与回复](https://github.com/Mira190/SpecGuard/pull/215#discussion_r4294373791)确认过一个真实问题：说明文字被 `reducedReasons` 正则当作 citation failure，导致 incomplete、无 head marker 和重复付费评审。该循环在 `debb50a` 通过调整文字并加端到端断言修复，不能再报告为当前仍必现。

不过[后续 review](https://github.com/Mira190/SpecGuard/pull/215#discussion_r4294380962)明确指出根因仍依赖文字解析，建议结构化字段。这与本地 `fix/structured-reduced-reasons` 的未提交修复方向吻合，建议完成该 WIP，而不是再开一份重复修复。

验收包括：全 weak → unknown、无虚假 clean headline，同时 complete=true、head marker 存在；真正 citation failure 仍能降级。**运行完成不等于证据支持 covered**，不能为避免重跑把 unknown 升成 covered。

### #217：PR 模式的真实 guard 反向控制值得补齐

[#217 后续 review](https://github.com/Mira190/SpecGuard/pull/217#discussion_r4294378210)指出，PR 模式主要通过 mock guard 验证参数，建议加入真实 post-level 的逆向测试：一个不相关测试恰好含相同字面量时，真实 gap 仍应该发布。旧报告已发现该方向，本地 structured-reasons WIP 也新增了相关 cover-guard 场景；后续应核对它能否完整满足该控制，避免重复增加同类测试。

review 还说明缺少 candidate 信息时的安全性依赖 candidates-cut 的降级顺序。这是跨阶段契约，适合用一条真实组合回归固定，而不是为每个函数增加一套 mock。

### #199：旧 finding 已被后续 PR 转成实现，文档应更新状态

[#199 review](https://github.com/Mira190/SpecGuard/pull/199#pullrequestreview-5547200106)提出的证据层级、静态反驳、依赖新鲜度和候选范围，已有 #215/#217 覆盖，漏斗由 #216 实现并由 #218 继续拆分原因。保留研究链条，但明确引用日期、来源 SHA 和解决 PR；否则旧报告会持续制造重复开发。

## 7. 真实跨仓扫描：有旧运行，尚不能验收最新版本

SpecGuard 仓库 API 返回 19 次 workflow_dispatch、0 次 schedule；本次读取最近 10 次 dispatch 元数据，并深入核查最新两次。该结论仅覆盖本仓库，不代表其他仓库没有计划扫描。

最近一次 [manual run 38515041761](https://github.com/Mira190/SpecGuard/actions/runs/38515041761/job/115691893065) 在 2026-10-14 扫描 expressjs/express：目标 SHA `a419aa7350389a275ab45fde2e849ed1f02449ef`；日志显示 6/6 units、0 个 design documents、1 个 not admitted，scan_issue=false，末尾 STATUS=complete。调度提交是旧 `eb324296c8ee5c17ddd5aa10846d4dd35de2d611`，早于本轮最新修复。

这能证明旧版本跑过静态单元扫描流程；不能证明最新 main 的跨仓能力、设计文档对齐能力、两次确认能力或 finding 准确性。该次 result artifact 的元数据存在，正文没有读取，因此不评价其实际发现内容。`6/6 units` 也不等于 6 个单元的测试保护都充分。

相邻的[失败运行](https://github.com/Mira190/SpecGuard/actions/runs/38515025925/job/115691779809)在 resolve 阶段无法确定目标仓库可见性就拒绝继续，review 被跳过。这类失败应分类为 target_access/resolve_error，不能混成“模型没发现缺陷”。

建议下一次执行验证时，以最新 main 固定 Action SHA、固定目标 SHA，选“有需求文档且有正反例”的代表仓库：先验证只读扫描，再验证状态轮转和二次确认；明确每次范围、未审部分和输出。不要用旧 Express 成功记录替代最新验收。本轮只读取记录，没有发起新的付费运行。

## 8. observability 与 trace：从已有数据补最小闭环

Action 已有 summary、状态输出、counts/usage、scan-parts 等产物，应先建立稳定关联，不急于引入新的 tracing 平台。建议字段均为待实现/待规范的契约，不表示当前已全部存在。

| 层次 | 最少记录 | 主要用途 |
|---|---|---|
| run | repository、run_id、run_attempt、PR、target/base/head SHA、Action SHA、配置摘要 | 区分被审代码、评审器版本和 workflow 版本 |
| collect | eligible/inventoried/selected 数量，排除与截断原因 | 证明扫描范围；接入 #216/#218 的原因拆分 |
| pack | 入选路径、完整/部分/未传输、预算、part id | 回答模型实际看见什么；不把候选列表当实际输入 |
| provider | provider、requested/actual model、attempt、耗时、错误类别、可用时的 request id、usage | 区分认证/配额/超时/坏输出；失败时未知成本保持 unknown |
| validate/post | 有效/降级/丢弃原因、unknown、发布数量、终态 | 解释模型提议如何成为可信 findings |
| outcome | 修复 PR、人工确认/误报/拒绝、检测与修复时点 | 衡量是否在 merge 前解决了问题 |

一个 run trace 可包含 resolve → collect → pack → provider → validate → post；多 part 使用 parent run + part/attempt id。SHA、路径和 request id 放入 trace/event 属性，不作为高基数指标标签；原始 diff、prompt 和凭据不要进入常规指标与日志。

最先建设的指标是：eligible PR 的有效模型评审完成率、auth/target access 等失败率、未知/截断占比、从输入到可见结果的时延、人工确认的 actionable precision，以及修复是否发生在 merge 前。样本小的类别同时显示分子/分母；没有人工标注就不填 precision，没有 usage 就不宣称零成本。

建议 summary 同时显示 workflow=success、review=failed、reason=auth_failed 一类组合；保留 unknown 和 scope_partial 等独立维度。认证失败、可见性失败和已知 TODO 必须能定位到原始 run、head 和责任配置，避免用户只能翻日志。

## 9. 更新后的行动顺序

| 优先级 | 建议 | 验收 |
|---|---|---|
| P1 | 恢复 dogfood 凭据并使用已有 fail_on_error 配置，补终态关联 | 一个代表性 PR 的真实 review 成功，认证失败能明确失败 |
| P1 | 继续评审 #218，不因缺少模型评审而忽略远程测试证据 | 1183 pass 的证据可追踪；人工审核 cap/time 改动 |
| P1 | 保留并完成 structured-reasons 和 eval-integrity WIP；提取 DENY 残余 | 对应真实失败模式有正反例，不能只改通过率 |
| P2 | 处理 k2 已知误报、跳过的 real-audit replay、PR 真实 guard 控制 | 同时保持真阳性控制；另做真实模型召回评测 |
| P2 | 最新 main 的跨仓扫描验收与最小 trace | 固定版本、范围可算、状态可关联；失败与 unknown 可解释 |
| P2 | 更新 #199 和重复报告后按清单整理分支 | finding → 修复 PR → 验证证据 → 清理记录可追溯 |

原分支报告中的 76 条远程、95 条本地分支和 35 个 worktree 候选没有因本次读取而变为“可直接删除”；所有数据保全、锁、ignored 文件及外部 Action 引用条件仍有效。

## 10. 22 个 PR 的最新摘要逐项记录

以下是读取时的可变评论快照；不是对每一次 CI attempt 的映射。#202/#205/#207 先合入其他分支，最终已进入 main。

| PR | 状态 | 最新 SpecGuard 摘要 | 证据 |
|---|---|---|---|
| [#218](https://github.com/Mira190/SpecGuard/pull/218) | 开放 | failed / auth_failed | [最新摘要](https://github.com/Mira190/SpecGuard/pull/218#issuecomment-6215503834) |
| [#217](https://github.com/Mira190/SpecGuard/pull/217) | 已合入 | failed / auth_failed | [最新摘要](https://github.com/Mira190/SpecGuard/pull/217#issuecomment-6214838288) |
| [#216](https://github.com/Mira190/SpecGuard/pull/216) | 已合入 | failed / auth_failed | [最新摘要](https://github.com/Mira190/SpecGuard/pull/216#issuecomment-6214800701) |
| [#215](https://github.com/Mira190/SpecGuard/pull/215) | 已合入 | failed / auth_failed | [最新摘要](https://github.com/Mira190/SpecGuard/pull/215#issuecomment-6214784943) |
| [#214](https://github.com/Mira190/SpecGuard/pull/214) | 已合入 | failed / auth_failed | [最新摘要](https://github.com/Mira190/SpecGuard/pull/214#issuecomment-6213523088) |
| [#213](https://github.com/Mira190/SpecGuard/pull/213) | 已合入 | failed / auth_failed | [最新摘要](https://github.com/Mira190/SpecGuard/pull/213#issuecomment-6213474983) |
| [#212](https://github.com/Mira190/SpecGuard/pull/212) | 已合入 | failed / auth_failed | [最新摘要](https://github.com/Mira190/SpecGuard/pull/212#issuecomment-6213433756) |
| [#211](https://github.com/Mira190/SpecGuard/pull/211) | 已合入 | failed / auth_failed | [最新摘要](https://github.com/Mira190/SpecGuard/pull/211#issuecomment-6213420984) |
| [#210](https://github.com/Mira190/SpecGuard/pull/210) | 已合入 | failed / auth_failed | [最新摘要](https://github.com/Mira190/SpecGuard/pull/210#issuecomment-6212783229) |
| [#209](https://github.com/Mira190/SpecGuard/pull/209) | 已合入 | failed / auth_failed | [最新摘要](https://github.com/Mira190/SpecGuard/pull/209#issuecomment-6212747167) |
| [#208](https://github.com/Mira190/SpecGuard/pull/208) | 已合入 | failed / auth_failed | [最新摘要](https://github.com/Mira190/SpecGuard/pull/208#issuecomment-6212669416) |
| [#207](https://github.com/Mira190/SpecGuard/pull/207) | 已合入 | complete / ignored，无模型评审 | [最新摘要](https://github.com/Mira190/SpecGuard/pull/207#issuecomment-6212546041) |
| [#206](https://github.com/Mira190/SpecGuard/pull/206) | 已合入 | complete / ignored，无模型评审 | [最新摘要](https://github.com/Mira190/SpecGuard/pull/206#issuecomment-6212340326) |
| [#205](https://github.com/Mira190/SpecGuard/pull/205) | 已合入 | failed / auth_failed | [最新摘要](https://github.com/Mira190/SpecGuard/pull/205#issuecomment-6212304807) |
| [#204](https://github.com/Mira190/SpecGuard/pull/204) | 已合入 | failed / auth_failed | [最新摘要](https://github.com/Mira190/SpecGuard/pull/204#issuecomment-6212297188) |
| [#203](https://github.com/Mira190/SpecGuard/pull/203) | 已合入 | failed / auth_failed | [最新摘要](https://github.com/Mira190/SpecGuard/pull/203#issuecomment-6212287077) |
| [#202](https://github.com/Mira190/SpecGuard/pull/202) | 已合入 | failed / auth_failed | [最新摘要](https://github.com/Mira190/SpecGuard/pull/202#issuecomment-6212282822) |
| [#201](https://github.com/Mira190/SpecGuard/pull/201) | 已合入 | failed / auth_failed | [最新摘要](https://github.com/Mira190/SpecGuard/pull/201#issuecomment-6212282012) |
| [#200](https://github.com/Mira190/SpecGuard/pull/200) | 已合入 | failed / auth_failed | [最新摘要](https://github.com/Mira190/SpecGuard/pull/200#issuecomment-6212060723) |
| [#199](https://github.com/Mira190/SpecGuard/pull/199) | 开放 | complete / ignored，无模型评审 | [最新摘要](https://github.com/Mira190/SpecGuard/pull/199#issuecomment-6205647388) |
| [#198](https://github.com/Mira190/SpecGuard/pull/198) | 已合入 | failed / auth_failed | [最新摘要](https://github.com/Mira190/SpecGuard/pull/198#issuecomment-6202263329) |
| [#197](https://github.com/Mira190/SpecGuard/pull/197) | 已合入 | failed / auth_failed | [最新摘要](https://github.com/Mira190/SpecGuard/pull/197#issuecomment-6202263053) |

## 11. 未验收范围

没有读取 artifact ZIP 正文或 GitHub 网页中的 step-summary HTML；summary 的结论来自实际 PR 机器人摘要及 job 日志。没有审计全部 382 次运行、全部 19 次 dispatch，也没有重跑模型、测量生产召回率或判断 secret 的具体错误原因。认证失败统计只对应这批 PR 最新摘要，不能外推到所有消费者。

Verdict：远程证据强化了“保留测试与人工 review、修复运行健康、保护 WIP、选择性迁移旧分支”的决策。当前最大价值缺口是模型评审链路持续不可用，以及绿色 CI 容易被当成有效评审；扩大扫描前，应先让一次真实评审可完成、可解释、可重放。
