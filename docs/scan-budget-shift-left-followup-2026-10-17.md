# SpecGuard 最新增量复审：种子扫描、分段预算与 shift-left（2026-10-17）

本轮结论：#251–#258 已把种子扫描跑通，修掉了真实运行暴露的分段与预算问题；但“触达全部 unit”仍不等于“审完全部代码与测试”。新复现发现，状态、分段执行记录和静态线索输出之间还有断层。当前应先补齐这些断层，再扩展扫描规模。

主要变化是：现在有真实 seeded scan 可以讨论召回，不必继续停留在“扫描入口受阻”。不过静态线索的 6/8 与模型发现的 3/8，不能直接合并解释为“模型审阅准确率 75%”。

## 1. 本轮版本与方法

| 对象 | 固定版本 / 状态 |
|---|---|
| 最新远程 main | 2fb6f911b262a239bc8e21d84b7ff92a6bbfa8b7，#258 合入后；交稿前再次核对一致 |
| 新增已合入 PR | #251、#252、#253、#254、#255、#256、#257、#258 |
| 本地最新实现 | 相关 worktree 包含 #255/#256/#258 的最终提交；检查时无产品语义 diff |
| 根目录 checkout | 工作开始较旧，期间被其他进程切换，最终与 main 2fb6f91 一致 |
| GitHub 读取窗口 | 2026-10-17 约 06:36–06:45 UTC，Sydney 17:36–17:45 |
| 代码审阅方法 | 固定 Git tree 读取，检查实现、调用方、测试与真实 PR review |
| 新复现 | 5 个确定性场景；真实模块、临时文件、受控 Git 读取、mock API / GitHub，无网络调用 |
| 旧问题复查 | F1/F2 在最新 SHA 再复现；其余旧问题按源文件是否改变分级说明 |

本轮只新增报告、证据与复现脚本，没有修改产品代码、切换分支、清理 worktree、发 GitHub 评论或重跑付费模型。

有一次其他进程操作使未跟踪目录被移走；本轮探针随后重建，最终文件已核对。没有从根目录瞬时 HEAD 推断“最新实现”，所有结果均绑定固定 SHA。

[固定 main](https://github.com/Mira190/SpecGuard/tree/2fb6f911b262a239bc8e21d84b7ff92a6bbfa8b7)。

## 2. 最新真实运行：已有进展与仍需限定的结论

### 2.1 SpecGuard 主线 CI

[main CI 39003157050](https://github.com/Mira190/SpecGuard/actions/runs/39003157050)：

- test success：1362 tests，1358 pass，0 fail，3 skipped，1 TODO。
- dogfood skipped：push 到 main 按工作流条件不执行模型审查。
- 这证明当前测试套件通过，不能证明所有分段状态或真实缺口都已覆盖。

[#258 早期运行 39002444159](https://github.com/Mira190/SpecGuard/actions/runs/39002444159) 的真实失败是固定 manual form 输入契约：新增输入使测试失败，最后选择不向 specguard-run 表单添加该项。当前最终版本已通过，不能把它继续列为未修产品故障。

### 2.2 Kite 运行序列

| 运行 | 本轮直接核实的事实 | 应如何解读 |
|---|---|---|
| [39001043636](https://github.com/Mira190/Kite/actions/runs/39001043636) | audit job success，末尾 STATUS=failed；过程仅数秒 | 当时确实存在“引擎失败、job 却绿”的失真；不是正常无发现 |
| [39001362367](https://github.com/Mira190/Kite/actions/runs/39001362367) | audit success，STATUS=incomplete；日志 58 of 43 units | 后续扫描已实际启动并完成多轮调用，但日志分母混用了 part 与 unit |
| [39002428421](https://github.com/Mira190/Kite/actions/runs/39002428421) | audit success，STATUS=incomplete；CONTEXT_PACK_BYTES=150000；日志 71 of 43 units | 新 pack 配置已同时到达收集与引擎；仍不能把 71 当 71 个独立 unit |

#256 的评审说明和补丁将第一条失败归因到引擎脚本入口的声明初始化顺序，并增加脚本入口回归与 internal 错误类别。本轮日志直接证实的是 STATUS=failed 与 job success 的冲突；没有把未读取的 engine-notes 内容冒充为日志全文。

修复后 internal 被加入强制失败类别，这是实质进步。仍需保留一次启动入口测试，因为模块 import 正常并不保证直接运行脚本时初始化顺序正确。[#256 评审](https://github.com/Mira190/SpecGuard/pull/256#pullrequestreview-5556083187)。

### 2.3 关于 43/43、30 whole + 13 forced

#256/#258 的维护者评审记录：43 个独立 unit 都触达，30 whole、13 forced，后者测试只能部分装入，记为 unsure。#258 还记录 SceneEditor 的后续 part 未覆盖。

这些数字说明“没有一个 unit 完全没轮到”，不表示：

- 全部 source parts 都已审到；
- 全部匹配测试都进入模型上下文；
- 每个 obligation 都已回答；
- 43 个 unit 都获得了完整、可验证的覆盖结论。

本轮拿到了最新 artifact 文件引用，上传日志也证实 artifact 存在；但终端无法解析下载主机 DNS，未能读取 ZIP 内的 audit-inventory、usage 和原始 pack。因此这里的 30/13、调用数和成本属于**维护者的实际实验记录**，日志中能独立确认的字段另列，不混为同一证据等级。[#258 评审](https://github.com/Mira190/SpecGuard/pull/258#pullrequestreview-5556216391)。

### 2.4 pack 从 250000 降到 150000 的收益

维护者记录同一批种子扫描从 7 calls / $0.42 变成 10 calls / $0.09。更多小调用仍可能更便宜，值得继续实验，而不是默认“大 pack 省调用所以省成本”。

本轮另用 GitHub compare 核对两个 Kite HEAD：只改变 .github/workflows/specguard-audit.yml，没有应用代码变化。这消除了目标应用代码变化这一项混杂；Action ref、打包实现与有效配置仍需固定，且两次单次运行不足以证明普遍的成本规律。

建议下一步记录每次调用的 actual input/output/cache tokens、worst-case reserve、unit-part 数、证据保留率与检出结果。保持硬预算，不用一次平均花费替换最坏情况上限。[#258 用量说明](https://github.com/Mira190/SpecGuard/pull/258#discussion_r4301394677)、[Kite HEAD 对比](https://github.com/Mira190/Kite/compare/11e80a98139ac83af59d9d013a85d1db31b591b6...b90f22c7906e2197afb1d7935b1622e439142d97)。

## 3. 新 PR 对目标的贡献

| PR | 已完成的改进 | 本轮判断 |
|---|---|---|
| #251 | hunk-tier 候选继续用于检索，排除出 literal cover guard；补 parser 直接断言；修循环依赖 | 已合入，关闭上一轮该项待合入状态 |
| #252 | 不读写 scan state 时允许非默认分支 | seeded scan 已在 Kite 自身 workflow 跑通；不代表跨仓 manual token 路径也已修好 |
| #253 | 统一弱断言分类；增加 truthiness、unreferenced export 等静态事实 | 有价值，但需要与已确认缺口分开计量 |
| #255 | stateless 按多个 part 计划，优先各 unit 的第一段；预算提示 | 方向正确；单测与离线通过后，真实运行仍暴露预算不一致 |
| #256 | 收集器使用引擎 pre-flight 重新计划；预算丢弃按 part 记录；internal 红灯 | 修复真实覆盖退化；失败 part 的记录还没完全统一 |
| #258 | collector 与 engine 共用 packLimit，并让新 input 到达两端 | 修掉 override 时再次分叉；0 值和无效值仍需要可见性契约 |
| #254/#257 | 更新目标评估和种子结果 | 提高透明度，但已有部分结论、待办未随最终实现更新 |

#255→#256→#258 的重要经验不是“需要更多抽象”，而是 planner、执行器、报告三者必须消费同一份实际计划与执行结果。当前还在不同层重建“哪些 part 审过”，新问题 N1–N3 就出在这里。

## 4. 本轮新确认问题

以下为固定 2fb6f91 的真实模块反例，未声称每个边界都在最新 Kite 运行中发生。优先级按对 shift-left 可信度与预期规模的影响排列。

### N1 · P1：收集器未选中的后续 part 没有使状态变为 incomplete

**做了什么。** inventory 已记录 parts_left 与 limitation；render 也会写“part 2 not reached”。

**问题。** 最终 incomplete 判断包含引擎 droppedParts，却没有包含收集器 parts_left。因此同一个报告可以说明“第二段没审到”，输出 status=complete。

**复现。** 单个 unit，两段；第一段成功，第二段因收集预算未选中。没有其他干扰因素。实际输出：

- status: complete；
- Reviewed in parts: part 1 of 2；
- part 2 not reached (budget)。

这是状态契约与已知覆盖损失矛盾，不是要求缺口报警必须让 CI 失败。

**最小修复。** 把“收集器 deferred parts”纳入结构化完整性判断，保留原因 budget / max_units。定义 complete 是本轮所选范围完成还是目标扫描范围完成；当前已把引擎 droppedParts 算 incomplete，应对收集器遗漏采用相同口径。

**验收。** 收集器省掉后续 part 和引擎省掉同一 part，完整性结果一致；全部 part 成功的对照仍为 complete。stateful 按设计轮转的一段扫描应另外明确范围，避免强行永远 incomplete。

代码：[audit-units.js:242](https://github.com/Mira190/SpecGuard/blob/2fb6f911b262a239bc8e21d84b7ff92a6bbfa8b7/src/audit-units.js#L242)、[audit-post.js:878](https://github.com/Mira190/SpecGuard/blob/2fb6f911b262a239bc8e21d84b7ff92a6bbfa8b7/src/audit-post.js#L878)。

### N5 · P1：超过前 100 个 inventory row 后，已选 unit 的静态线索会消失

**做了什么。** 为限制 inventory 展示体积，write 只保留风险排序前 100 行；新静态事实的 publisher 从这些行取 leads，再筛本次选中的 unit。

**问题。** 一旦轮转选中前 100 之外的 unit，它的源代码可以已经审了，静态信号也已经算出来，却不在持久化 rows 中。publisher 的对应线索变为空，没有披露这是 inventory 序列化截断。

**复现。** 101 个 unit，每个都有一个 unreferenced export fact；本轮选择第 101 个。序列化前该 unit 有 1 条 lead；写出的 inventory 只有 100 rows；publisher 过滤后可用 lead=0。

在 Kite 的 43 个 unit 上不会触发，在千 unit 仓库或有状态轮转中才会跨过该阈值。它直接限制了“静态事实作为全仓主力”的可扩展性。

**最小修复。** 将本轮 selected unit 的事实单独持久化，或者保证 selected rows 不受“前 100 行展示”限制。展示可以裁剪，检测输入不能跟着丢。继续报告事实层的 searched/available/delivered 数。

**验收。** 101+ unit，选择第 101 个及之后的 unit，lead 在 publisher 保留；同时验证窗口内重复 test lead 去重与报告体积限制。

代码：[audit-units.js:271](https://github.com/Mira190/SpecGuard/blob/2fb6f911b262a239bc8e21d84b7ff92a6bbfa8b7/src/audit-units.js#L271)、[audit-post.js:525](https://github.com/Mira190/SpecGuard/blob/2fb6f911b262a239bc8e21d84b7ff92a6bbfa8b7/src/audit-post.js#L525)。

### N4 · P1：context_pack_bytes=0 可在没有源码的情况下给出 complete

**做了什么。** 新公开输入明确允许 0，表示不附加 repository files；共用 packLimit 使两端读到相同值。

**问题。** API 单调用路径在 packBytes=0 时跳过 pack，也没有写出被遗漏文件的 pack-cut。publisher 无法区分“没有截断”与“根本没有发送源码”，可正常输出 complete。

**复现。** 真实 api.run + audit publisher，provider 返回合法空发现 JSON；检查请求确实不含 fixture 的关键源码标识符；engine_status=success、pack-cut 不存在、status=complete。provider 与 GitHub 均为本地 mock，未实际发送请求。

**最小修复。** 若 0 继续合法，就记录 pack disabled，并将依赖缺失源码的义务标 unknown；或者在需要源码的 API review 路径明确拒绝 0。不要只改两个 parser 数值一致就认为输入语义已一致。非数字配置目前也可能落为 0，建议明确报配置错误。

**验收。** 0、空串默认值、合法小 pack、非法字符串分别验证；禁止用“未附源码的空 JSON”推导完整审查。其他读取代码的引擎须按自己的工具读取证据判断，不套用 API 模式结论。

代码：[pack-cap.js](https://github.com/Mira190/SpecGuard/blob/2fb6f911b262a239bc8e21d84b7ff92a6bbfa8b7/src/pack-cap.js)、[claude-api.js:483](https://github.com/Mira190/SpecGuard/blob/2fb6f911b262a239bc8e21d84b7ff92a6bbfa8b7/src/engines/claude-api.js#L483)。

### N2 · P2：预算丢弃的 part 同时被列为已审 part

**做了什么。** #256 已单独输出 droppedParts，并使状态 incomplete。这部分修复有效。

**问题。** readUnits 合并的是原始 planned rows；Reviewed in parts 直接使用该合并列表，没有减去执行器丢弃的 part。

**复现。** 计划 part 1、2，预算丢弃 part 2。实际同一份摘要先显示“parts 1, 2 of 2 已审”，再显示“part 2 未触达”。

**最小修复。** Reviewed in parts 来自 succeeded part keys，计划总数和未执行清单分别显示。不要用 source window 的最大/最小行号合并结果代替真实可见范围。

**验收。** 不连续成功 part、预算丢弃、未启动、失败这几种组合都不会出现在已审列表中。该问题目前是覆盖描述冲突，不是全局状态继续绿色。

代码：[audit-post.js:62](https://github.com/Mira190/SpecGuard/blob/2fb6f911b262a239bc8e21d84b7ff92a6bbfa8b7/src/audit-post.js#L62)、[audit-post.js:616](https://github.com/Mira190/SpecGuard/blob/2fb6f911b262a239bc8e21d84b7ff92a6bbfa8b7/src/audit-post.js#L616)。

### N3 · P2：失败仍只记 unit ID，成功分段的覆盖归因丢失

**做了什么。** 引擎对预算丢弃使用 id:part，但对 failed call 只写 units，不写 part keys。

**问题。** publisher 只要看到某个 unit 在 failed 中，就把该 unit 整体放入 notSeen。多分段扫描新增后，一个后续分段失败会吞掉“前一段已经成功审到”的覆盖事实。

**复现。** 同一 unit 两段，第二段失败、第一段有成功结果：摘要变成“could not review any unit”“1 unit were not reviewed”；漏斗还把它计入 did not fit，混淆运行失败与容量不够。

本轮没有证明所有成功 finding 都因此被删除；源码仍会保留部分已验证 finding。确认的问题是执行与覆盖的归因粒度不够。

**最小修复。** failed 与 dropped 一样携带 part keys；执行账本列 succeeded / failed / not_started / dropped，unit 层由账本聚合 reached_any、source_complete、tests_complete。兼容旧 artifact 没有 part keys 的保守回退。

**验收。** 同一 unit 首段成功、次段 timeout 时应显示“部分成功、部分失败”，不宣称完全没触达；也不把该 unit 宣称为完整 covered。

代码：[claude-api.js:435](https://github.com/Mira190/SpecGuard/blob/2fb6f911b262a239bc8e21d84b7ff92a6bbfa8b7/src/engines/claude-api.js#L435)、[audit-post.js:838](https://github.com/Mira190/SpecGuard/blob/2fb6f911b262a239bc8e21d84b7ff92a6bbfa8b7/src/audit-post.js#L838)。

### N6 · P2：运行日志把 part 数写成 unit 数

真实日志出现 58 of 43 units 和 71 of 43 units。main 函数返回 units.picked 为每个选中 part 的 unit ID，stdout 用 picked.length；分母 total 是独立 unit 数，统计单位不同。

最小修复：显示 unique units reached / inventory units，并另外显示 selected parts。已有 inventory.rotation.picked 基于去重集合，可以复用。不要通过扩大分母掩盖 part 重复。

这个问题没有另外写测试来镜像字符串，真实日志和直接调用路径已构成充分证据。[audit-collect.js:378](https://github.com/Mira190/SpecGuard/blob/2fb6f911b262a239bc8e21d84b7ff92a6bbfa8b7/src/audit-collect.js#L378)。

## 5. 旧发现是否解决

| 上轮事项 | 最新状态 | 证据 |
|---|---|---|
| hunk 候选导致 cover guard 误降缺口 | #251 已合入 | 不再列为待修；循环依赖也已有修复 |
| stateless 非默认分支被拒 | #252 已合入，Kite 本仓 workflow 已运行 | 跨仓 manual 权限前提继续单列 |
| summary 解决后从标签池消失 | 仍存在 | 最新 SHA 再现：A=1，但 blind pool 从 1 到 0、旧标签 unmatched |
| summary→inline 标签 ID 改变 | 仍存在 | 最新 SHA 再现 F9a5e30c2e → F420a685ac |
| changed-hunk diff timeout 静默吞掉 | 相关 collect.sh 未变化 | 上轮反例依然适用；本轮未重新注入 timeout |
| delivered precision 缺失、旧 error 分母未知 | eval/grade.js 未变化 | 不把 #258 扫描预算修复说成同时修好了评测口径 |
| retrieval 失败与配置身份披露不足 | trace-recall 相关实现未变化 | 仍需后续；本轮聚焦新的 scan 执行链 |

最新 goal-assessment 仍写“口径已就绪”“缺的只是样本”。F1/F2 的复现说明这句话需要收窄：样本增长之前，也要保证已解决的发现和渠道转换不会使标签失联。

## 6. 实际 PR review 的质量：应优化哪一种误报

#256 机器人把 audit-post.test.js 的两条删除断言标成“Assertion removed with no replacement”。维护者明确判为误报；本轮检查 diff，旧 cap-of-10 断言确实被新的完整可见性断言替换：

- 原先检查 12 条信号只有 10 条可见、2 条在 Details；
- 新版检查全部 12 条可见，并确认不再存在 More static signals；
- 另加 lead cap=20 的回归。

这个 PR 改的是输出契约，旧断言失效是合理变更。不能仅按“某 assert 行删除”产生两条独立缺口；应先查看新断言是否覆盖对应的新 obligation。相同主题的两条删除也应合并。

最小优化：给 removed-assertion lead 附原契约、新契约、候选替代断言；只有无法核实替代证据时才形成 actionable gap。保留真实削弱断言的正例和“契约改变并补替代断言”的负例，不能一律抑制删除检测。[#256 实际 summary](https://github.com/Mira190/SpecGuard/pull/256#issuecomment-6229335004)、[#256 人工 review](https://github.com/Mira190/SpecGuard/pull/256#pullrequestreview-5556083187)。

#258 还产生一条低置信 standard：packLimit 的测试不在 pack-cap.test.js。当前规则的确写了同名测试文件约定，所以不能简单宣布机器人错了。但它与 unitCalls 放在 claude-api.test.js 的直接对照测试相比，边际目标价值很低。建议将“行为未验证”与“文件放置规范”分开展示和度量，避免规范意见挤占真正的 QA 缺口。[#258 实际 summary](https://github.com/Mira190/SpecGuard/pull/258#issuecomment-6229607959)。

多个最新 PR 的 summary 仍报告大测试文件截断与 obligation unknown。CI 有测试、仓库有测试、本次模型看见并核实了测试，是三个不同事实；unknown 应继续保留，而不是为了减少警告自动判 covered。

## 7. 如何正确解释新种子结果

当前 goal-assessment 记录：

| 实验路径 | 仓库记录 | 本轮应采用的解释 |
|---|---|---|
| 早期 haiku | 0/8 | 早期特定覆盖与配置的模型召回 |
| normal tier | 2/8，约 $1.91 | 更强模型的该次结果；不是通用上限 |
| #253 静态信号 | 6/8 对应种子位置 | 已知缺口上的 lead-location recall |
| 后续默认配置 | 模型 3/8、静态 6/8、合计 6/8 | 模型有改善，但对这些种子的增量独有检出暂未体现 |
| 边界种子 | 仍未检出两项 | 需要把证据是否完整送达与语义推理能力分开诊断 |

[目标评估文件](https://github.com/Mira190/SpecGuard/blob/2fb6f911b262a239bc8e21d84b7ff92a6bbfa8b7/docs/goal-assessment-2026-10-17.md)。

“只断言 truthiness”和“没有测试文件提及一个导出名”可以是准确事实，但事实准确不等于产品意见正确：

- 测试可能通过别名或公共入口间接覆盖函数；
- truthiness 可能正是合法契约；
- UI 导出没单测不一定应改成 unit test；
- 未检出一个函数名与确认没有测试是不同强度的结论。

因此至少分三层报告：事实精确率、人工确认缺口精确率、作者可行动发现精确率。master 对照抽查 9 条事实全部成立，不应被改写成产品 precision=100%。

静态检测的“$0”应解释为不需要额外模型调用的增量成本，不能说包含模型扫描的整次 Action 花费为零。目前同一次运行仍花 $0.09 或 $0.42；独立静态模式尚不能从这些运行数字推导出已验证的全部体验。

“模型无 diff 几乎无效”也应限定为当前 Kite 种子与配置的实验结果；模型从早期 0/8 到后续 3/8 已说明结果会随输入范围与计划变化。先证明证据到达，再将剩余 FN 归为模型能力问题。

## 8. 针对目标的下一轮最小路线

### 8.1 先统一执行账本

复用已有 scan-parts.json，不先建设新平台。建议增加以下最小字段：

| 字段 | 目的 |
|---|---|
| target_sha、action_sha、effective_config_hash | 固定被审代码、工具实现和配置 |
| unit_id、part_key、planned_source_spans | 明确计划审哪一段 |
| execution_state | selected / succeeded / failed / dropped / not_started |
| source_spans_shown、test_blocks_shown | 实际发送了什么，不只知道文件名 |
| selected_units、reached_any_units、source_complete_units、tests_complete_units | 防止 unit 与 part 混算 |
| static_facts_computed、persisted、delivered | 揭示 N5 这类序列化损失 |
| failure_stage、reason、reserved_usd、actual_usd | 对齐覆盖、失败和预算 |

publisher 直接消费账本；不要再从 planned rows 减去部分 dropped 列表后猜执行结果。part 本身的范围、测试范围、失败结果可以复用已有对象，不需要为每条数据增加一套复杂层次。

### 8.2 修复与验收顺序

| 顺序 | 工作 | 最小验收 |
|---|---|---|
| 1 | N1 / N4 完整性契约 | 已知未审 part 或 disabled pack 不能产生无保留的完整结论 |
| 2 | N5 静态事实持久化 | 101+ unit、选择前 100 外的 unit，线索仍可交付 |
| 3 | N2 / N3 part 执行账本 | dropped / failed part 不进已审集合；成功 part 不因同 unit 的其他失败而消失 |
| 4 | N6 日志计量 | numerator 与 denominator 同为 unique units，part 数另列 |
| 5 | F1 / F2 cohort 身份 | export→fix→rerun→promote→import，标签仍可对齐 |
| 6 | removed-assertion 负例 | 输出契约变化并补替代断言时，不误报成削弱测试 |
| 7 | 固定留出集复测 | JS/TS 之外至少一个仓库，覆盖长文件、多入口、跨文件委托 |

### 8.3 对边界种子做有约束的实验

不要立即把“常量在测试里出现一侧”写成确认缺口：测试可能通过参数化、fixtures 或 wrapper 覆盖边界。先作为 lead，标注被测 predicate、阈值、相关测试块与无法判定的动态来源。

对每个 FN 先记录：真值是否可靠→关键源码段是否到达→相关测试是否到达→模型是否提出→验证是否保留→是否交付。再选择增强检索、打包、模型或门控。这样才是围绕实际损失优化，而不是针对 8 个种子硬编码新规则。

### 8.4 继续保持预算上限，校准计划效率

记录多种 pack、模型和文件结构的实际用量后，再优化保守 reserve。先区分：

- 因最坏情况 reserve 没有选择的 part；
- 执行后实际剩余但没有继续使用的预算；
- 超时、输出长度、验证失败造成的损失；
- 更小 pack 导致的证据缺失及重复上下文。

优化目标是固定成本下的完整有效发现，不是调用数越少越好，也不是支出越接近预算越好。

## 9. 应更新的评估文档

最新 goal-assessment 有几处已过时或口径过宽：

1. “hunk 候选修复进行中”应更新为 #251 已合入。
2. “context_pack_bytes 两端不一致需统一”已由 #258 解决；新的待办是 N4 输入语义与 N1–N3 执行结果一致。
3. “另有两个种子在第二段，单次 stateless 永远读不到”应注明属于旧实现；#255 已计划多段，剩余限制应具体写实际 deferred/failed parts。
4. 顶部 haiku 0/8 与后文默认模型 3/8 应按运行版本分开，避免读者以为同一条件自相矛盾。
5. “覆盖与成本达成”建议改成“触达与预算控制已有实证，完整证据覆盖仍有限”。
6. “缺的只是样本”应补上标签生命周期与执行覆盖契约的剩余实现问题。

这些修改都可以复用现有实验数据，无需为了文档再跑一次付费扫描。

## 10. 复现与证据附件

运行本轮 5 个新场景：

    node docs/review-probes/scan-budget-followup-2026-10-17/probe.cjs

复查旧 F1/F2：

    node docs/review-probes/scan-budget-followup-2026-10-17/previous-findings.cjs

探针从固定 Git tree 加载模块，记录源码 hash。使用本地临时文件和受控 Git 返回值，不修改 .git、不执行被审仓库代码、不真实调用 provider 或 GitHub。临时目录按已核实的绝对路径边界清理。模块级反例不代替完整产品测试或真实模型实验。

附件：

- [本轮新场景结果](C:/Files/Projects/SpecGuard/docs/scan-budget-followup-probe-results-2026-10-17.json)
- [F1/F2 最新复查](C:/Files/Projects/SpecGuard/docs/scan-budget-followup-previous-findings-2026-10-17.json)
- [PR、Actions 与日志证据](C:/Files/Projects/SpecGuard/docs/scan-budget-followup-evidence-2026-10-17.json)
- [版本切换与 Kite 对比快照](C:/Files/Projects/SpecGuard/docs/scan-budget-followup-snapshot-2026-10-17.json)
- [新场景脚本](C:/Files/Projects/SpecGuard/docs/review-probes/scan-budget-followup-2026-10-17/probe.cjs)
- [固定版本模块加载器](C:/Files/Projects/SpecGuard/docs/review-probes/scan-budget-followup-2026-10-17/loader.cjs)

尚未核实：Kite artifact ZIP 原始内容、种子逐项独立重标、真人作者采用、普通无报警 PR 的真实 FN、Copilot 最新真实路径、跨仓 private manual 入口。本文对这些项目保留限制，没有用 job 绿色或维护者描述替代全部实证。

