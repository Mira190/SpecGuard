# SpecGuard 新变化与 unknown unknown 增量复审（2026-10-17）

最重要的新发现：分段账本已经修正了“摘要说哪些 part 审过”，但 finding 验证器仍然使用原始计划范围。一个未执行分段里的引用，可以被保留为非低置信缺口。**报告正确描述了未覆盖范围，并不保证报告里的每条 finding 都遵守该范围。**

本轮另复现负数边界误报、旧评测记录的未知 precision 被写成零，以及待合入 runtime admission 在 usage 缺失时继续准入额外调用的边界。没有修改产品代码。

## 1. 版本边界

| 对象 | 版本与处理 |
|---|---|
| 开始时远程 main | 769b7396cbc35b18379c4dbe00c5c5345bed01b8，#274 合入后 |
| 主线确定性复现 | 先在 769b739 复现；交稿时已在 44ed3eb 重跑全部主线断言，结果一致，记录 source hash |
| 交稿刷新 main | 44ed3eb8f093981c685027d0c1596aa78fa92939，已合入 #271/#276 |
| 最后增量核对 | 通过 GitHub compare 阅读 769b739→44ed3eb；没有改动 U1 的执行范围过滤、U2 的数字提取或 U3 的指标计算 |
| 待合入 #275 | 489009da4c55b08157a52b2ee5c2d6628e5d5e87，单独加载该版本复现 U4 |
| 待合入 #273 | da8f9890ebe58e40f8f6366daa46637bf6b88268，读取 diff、测试与实际 review |
| 最新本地新提交 | cac0d53df6e56d28d2cee786031f70dea764186a；对应 #276，阅读后远程已合入 |
| 当前根目录 | 仍落后于远程；未切分支、未覆盖现有未跟踪报告 |

相关活跃 worktree 的未提交状态已检查，没有发现比上述提交更新的产品语义修改。远程最后的 merge object 起初不在本地；交稿检查时它已被其他进程同步，因此又在 **44ed3eb 重跑主线探针并全部通过**。正文部分代码链接保留最初 769b739 的定位，最终结果文件与 source hash 对应 44ed3eb。

证据窗口约为 2026-10-17 08:28–08:38 UTC，Sydney 19:28–19:38。[最初主线复现基线](https://github.com/Mira190/SpecGuard/tree/769b7396cbc35b18379c4dbe00c5c5345bed01b8)、[交稿时远程主线及最终探针基线](https://github.com/Mira190/SpecGuard/tree/44ed3eb8f093981c685027d0c1596aa78fa92939)。

## 2. 上轮问题已有实质修复

| 上轮事项 | 对应新修复 | 本轮判断 |
|---|---|---|
| F1/F2：summary 修复后丢样本、升级 inline 换 ID | #261 保留已处置 summary 元数据；SpecGuard 身份使用统一 fp 前缀 | 基本场景已有修复；本轮直接验证跨渠道、跨位置 ID 一致 |
| F3/F4/F7：retrieval 失败、目标身份与环境不固定 | #259 增加失败信息、target 校验与环境固定 | 不重复当成旧问题上报 |
| F5/F6：缺 delivered precision、历史 error 分母未知 | #259 新字段与 unknown_expected | error 分母已用 null；precision 的历史兼容仍有 U3 |
| F8：hunk diff 失败被吞 | #260 limitation；#273 进一步限定 grep 到测试路径 | 失败已可见；#273 在本轮快照仍待合入 |
| N1/N2/N3/N6：分段未审状态、错误已审列表、失败粒度和日志单位 | #264 统一 part keys | 状态与输出已有修复；finding 的执行范围约束仍有 U1 |
| N4/N5：零 pack、前 100 行外丢静态线索 | #267 配置拒绝与保留 selected rows | 不再把旧反例作为当前缺陷 |
| “触达就算 reviewed whole” | #274 增加 exact parts_left_by_path | 新漏斗有改进；仍不能替代单条 finding 的可见证据验证 |
| 第三方噪声、覆盖 guard 搜索失效 | #270/#271/#276 | 新增过滤、限制搜索范围与失败说明，已阅读相关增量 |

修复状态不等同于所有边界都已证明安全。下面只列新反例，不再次列出已关闭的旧问题。

## 3. U1 · P1：未执行 part 的引用仍能变成非低置信缺口

### 问题与实际输入

一个 unit 分为两段：

- part 1：第 1–2 行，成功执行；
- part 2：第 3–4 行，因预算丢弃，或调用失败；
- 成功调用返回一个 missing_test，引用 part 2 第 3 行的错误分支；
- 引用文本确实存在于本地源码，finding 带合法测试草图。

两种情况下都得到：

| 结果字段 | 实际结果 |
|---|---|
| 摘要已审范围 | part 1 of 2，lines 1–2 |
| finding 引用 | line 3，位于未执行 part 2 |
| audit.json 保留条数 | 1 |
| low | false |
| run status | incomplete |

因此这是**全局 incomplete、单条 finding 仍过度确认**的问题，不是又一次“整个 job 绿色等于完整审查”。

### 根因

render 的 ran 计算已经扣除 dropped/failed keys。但 main 把 readUnits 的原始 planned spans 直接传给 verify；verifyUnits 的“是否位于本次 part”检查仍对这些计划范围执行。

“源码里找得到这句引用”和“该引用处于本次成功审阅范围”是两个不同事实。现在只满足前者、外加计划范围匹配，就能通过。

代码：[verifyUnits 范围检查](https://github.com/Mira190/SpecGuard/blob/769b7396cbc35b18379c4dbe00c5c5345bed01b8/src/audit-post.js#L336)、[render 的 ran](https://github.com/Mira190/SpecGuard/blob/769b7396cbc35b18379c4dbe00c5c5345bed01b8/src/audit-post.js#L620)、[main 调用 verify](https://github.com/Mira190/SpecGuard/blob/769b7396cbc35b18379c4dbe00c5c5345bed01b8/src/audit-post.js#L866)。

### 最小修复与验收

在验证前，从现有 part keys 计算成功执行范围，作为 verify 的单独输入；planned 范围仍保留给摘要与调度。来自 dropped、failed、not_started 区域的模型缺口应剔除或明确列为未经本次审查确认的线索。

验证也应绑定调用归属：不能因为 part 2 在另一调用中成功，就自动让 part 1 的回答获得 part 2 的全部证据。先实现本次成功范围的约束，再补调用级 provenance。

最小验收矩阵：

| 输入 | 应有结果 |
|---|---|
| 成功 part 中的正确引用 | 保留 |
| budget-dropped part 中的引用 | 不成为已验证非低置信缺口 |
| failed part 中的引用 | 同上 |
| 重试后该 part 成功 | 按成功 attempt 的实际范围判断 |
| 非连续成功分段 | 中间未审区域不能被最小/最大行号覆盖 |
| 静态事实扫描器产生的线索 | 保留独立 provenance，不套用模型调用可见性规则 |

这是当前最值得先修的 unknown unknown：账本从调度传到报告了，但尚未完整传入证据验证。

## 4. U2 · P2：负数边界已经被精确断言，仍生成 boundary_unpinned

本轮使用真实 inventory 进行两个配对场景。源码具有命名数值常量 LOWER_LIMIT，以及 value < LOWER_LIMIT 的函数；对应测试直接断言该函数在等号边界的行为。

| 常量 / 测试输入 | 实际 boundary 线索 |
|---|---:|
| LOWER_LIMIT=10；tooLow(10) 的期望被断言 | 0，正确对照 |
| LOWER_LIMIT=-10；tooLow(-10) 的期望被断言 | 1，错误线索 |

负数版本的测试确实能区分 < 与 <=，不是只出现一个不相关数字。

根因是源码算术解析允许负数，但测试里的数字提取只匹配无符号数字。目标集合保存 "-10"，扫描测试只拿到 "10"，于是未能匹配。

这是有限静态线索的准确性问题；当前 lead 并非 confirmed gap，严重性低于 U1。不能把它解释为模型误报，也不能在计算静态事实精确率时忽略。

最小修复：让源码与测试的数值规范化一致，覆盖符号、小数、数字分隔符；单独处理一元负号与减法，避免把 x-10 无条件当成负数测试值。超出语法能力的表达式继续标为未知，不通过执行代码求值。

验收至少包含 -10、-0.5、正数对照、减法表达式、注释/字符串里的数字和参数化输入。[数字提取](https://github.com/Mira190/SpecGuard/blob/769b7396cbc35b18379c4dbe00c5c5345bed01b8/src/audit-units.js#L259)、[生成 boundary](https://github.com/Mira190/SpecGuard/blob/769b7396cbc35b18379c4dbe00c5c5345bed01b8/src/audit-units.js#L287)。

## 5. U3 · P2：旧记录的 delivered precision 把未知写成零

#259 新增 precision_delivered 是正确方向；但旧评测行没有 tp_delivered 时，该字段没有像 recall_delivered 一样受 noDelivered 保护。

复现输入是一条旧成功记录：tp=1、fp=1、fn=0，没有 delivered 字段。

| 字段 | 当前返回 |
|---|---:|
| raw precision | 0.5 |
| recall_delivered | null |
| precision_delivered | 0 |

这里的零不能说明“已交付的正确发现为零”，因为数据没有记录交付集合。混合新旧历史报告时，会把数据缺失误读成质量退化。

最小修复：precision_delivered 也按 noDelivered 返回 null，同时打印缺失记录数；不要默默回退 raw precision。raw 与 delivered 的历史兼容策略保持一致。

本轮正向对照还确认：旧 error 缺 expected_findings 时，E2E recall 已正确返回 null，不应把 F6 继续报成未修。[grade.js:214–219](https://github.com/Mira190/SpecGuard/blob/769b7396cbc35b18379c4dbe00c5c5345bed01b8/eval/grade.js#L214)。

## 6. U4 · P2，待合入 #275：缺 usage 时按零支出准入额外调用

### 已证明的行为

本轮加载 #275 的真实 adapter，只替换本地计划与 provider 响应。计划有一个正常 part、一个 extra part；两者的 reserve 相同。预算可以覆盖一个 reserve，不能覆盖两个。

| 项目 | 复现值 |
|---|---:|
| 每个调用 reserve | $0.0020748 |
| 总预算 | $0.0031122 |
| 两个 reserve 之和 | $0.0041496 |
| 返回合法发现 JSON，但缺 usage | 调用 2 次，usage.json 记录总成本 0 |
| 返回同类 JSON，带已知 usage 的对照 | 调用 1 次 |

这里使用仓库当前价格表计算，没有真实 API 请求，也没有真实账单超支。

### 风险边界

#275 通过 actual spent + next worst case 决定是否追加。j.usage 缺失时变为 {}，cost 结果为零；因此没有结算信息也被当成预算已释放。

正常 provider 成功响应通常应有用量，本轮没有证明真实 Anthropic 服务正在漏报。问题是 adapter 接受这种响应后仍宣称有足够依据进行硬预算准入。异常响应、兼容实现或缺失元数据不能与“免费调用”等价。

最小修复：usage 未知时保留该 attempt 的 reserve，或者暂停 extras 并披露 usage_unknown；只在获得可信用量后释放差额。不要只补一条 warning、继续按零支出计算。

验收包含缺 usage、空 usage、缺部分字段、请求超时未取得可用量、重试后的 attempt 结算。保留已有正常 usage 的等号边界测试。

代码：[usage 默认值](https://github.com/Mira190/SpecGuard/blob/489009da4c55b08157a52b2ee5c2d6628e5d5e87/src/engines/claude-api.js#L399)、[spent 与 runtime admission](https://github.com/Mira190/SpecGuard/blob/489009da4c55b08157a52b2ee5c2d6628e5d5e87/src/engines/claude-api.js#L438)。

这个问题位于待合入分支，不应写成最新 main 已经发生的生产超支。[PR #275](https://github.com/Mira190/SpecGuard/pull/275)。

## 7. 真实 PR/Actions 是否能发现这些问题

### 已核实的主线 CI

769b739 对应的 [39016918543](https://github.com/Mira190/SpecGuard/actions/runs/39016918543) 的 test 为 success：1399 tests、1395 pass、0 fail、3 skipped、1 TODO。dogfood 在 main push 被跳过。该数字不冒充 44ed3eb 的完整测试结果。

这些测试证明相应已有回归通过；U1 的关键缺失是“新 ledger 对最终 finding 的约束”，只断言状态、漏斗和摘要无法覆盖它。新增测试应穿过 publisher 的真实验证路径，而不是再对 ran 集合做一个孤立断言。

### #274 的真实 review

维护者已经确认旧漏斗把有未审 part 的 unit 算成 whole；#274 增加 exact parts_left_by_path，对旧 artifact 保守处理。这个修复有价值，不能因 U1 而撤回它。

但其实际机器人 summary 仍是 incomplete，报告部分大测试文件截断；“没有高置信缺口”不能视为把 finding 验证范围也验收了。[#274 人工 review](https://github.com/Mira190/SpecGuard/pull/274#pullrequestreview-5556982757)、[机器人 summary](https://github.com/Mira190/SpecGuard/pull/274#issuecomment-6231591925)。

### #275 的真实 review

CI success，机器人指出 admission 相关证据有一部分未见，尤其 src/claude-api.test.js 很大、只看到切片。因此不能把“没有明确 missing_test”用作预算逻辑已经穷尽的证据。

U4 的输入不是现有成功 usage 测试的重复：它检查丢失结算元数据时，是否仍有权增加工作。[#275 summary](https://github.com/Mira190/SpecGuard/pull/275#issuecomment-6231610521)。

### Kite 最新运行的可确认边界

本轮直接读取 [39016251110](https://github.com/Mira190/Kite/actions/runs/39016251110) 的 job 日志：

- 独立 unit 与 part 已分开：43 of 43 units (58 parts)；
- Action ref 是 fix/scan-units-third-party；
- status=incomplete；
- artifact 上传成功。

这次是对应第三方过滤分支的运行，不能拿来证明当前 #275 runtime admission 已经过真实扫描，也不能用它替代交稿 main 的完整验收。本轮未读取 artifact ZIP 内的原始 prompt、usage 与逐个种子真值。

## 8. 修复之外，新出现的系统性盲区

这些是下一轮实验方向，不是已经复现的额外 bug：

| 假设 | 为什么现在值得查 | 最小实验 |
|---|---|---|
| 引用在源码存在，但不在模型实际证据中 | U1 已证明计划/执行范围脱节 | 按 call/attempt 记录 source spans 与 test blocks，验证器连接该来源 |
| 增加召回规则后，事实与建议的精度分开变化 | 新 boundary、弱断言分类、第三方过滤同时变化 | 分规则、分语言、分值格式计算 fact precision 与 actionable precision |
| 小 pack 增加调用后，失败与 usage 缺失会相互影响 | #275 依赖运行时结算与 extra 队列 | 固定计划注入失败、超时、缺元数据，验证预算和覆盖账本守恒 |
| 输出裁剪影响作者可见召回 | 曾经生成 6/8、实际可见 3/8，现改轮询 | 同时报告 generated/verified/visible 三层，不只报告生成总数 |
| 过滤非 unit 噪声时误排实际生产代码 | #271 排除 scripts/integration 等路径 | 留出仓库中逐项标注 eligible / excluded，不能只检查告警更少 |
| 需求、测试、义务分别有真值，跨层连接仍可能错 | 新修复多围绕单层字段 | 建跨文件行为用例：需求→全部实现→对应断言→最终评论逐层可对账 |

对复杂仓库而言，下一项高价值观测字段是 evidence provenance，而不是再增加一个总体 coverage 百分比。

建议复用现有 scan-parts 数据：每个 part/attempt 记录计划范围、实际 pack、执行结果、finding 来源和验证结果。能复用的范围集合只生成一次，再由调度、验证、报告消费。

## 9. 优先顺序与验收

1. **先修 U1。** 未执行范围的模型结论不能被标成已经验证的高价值输出；正例、dropped、failed、重试和非连续范围一起验收。
2. **在 #275 合入前补 U4。** 正常使用场景已有测试，异常结算数据仍须保留 reserve。
3. **补 U2 的负数与表达式配对用例。** 维持 lead 身份，不升级为自动确认测试缺口。
4. **修 U3 的历史缺失口径。** 不以零分填补未知数据。
5. **合并后再做固定目标的真实运行。** target SHA、action SHA、有效配置和种子真值固定，避免同一轮改规则、改预算、改输出上限之后无法归因。
6. **复核普通无报警 PR。** 受控种子成绩不能回答真实 FN；当前 review 仍需要独立的阴性样本审阅。

不建议为了四个反例同时引入新的数据库、整仓 AST 平台或独立 trace 服务。先让已有范围与身份字段贯通，能用很小的改动提高输出可信度。

## 10. 复现与附件

主线案例及修复对照：

    node docs/review-probes/unknown-incremental-2026-10-17/main.cjs

待合入 #275 的预算准入案例：

    node docs/review-probes/unknown-incremental-2026-10-17/admission.cjs

U1 含 dropped/failed 两个分支；U2 有正数配对对照；U4 有已知 usage 对照。另外检查了跨渠道 ID 稳定、非法 pack 配置拒绝、未知 expected 分母返回 null 三个正向修复对照。全部断言通过。

脚本只加载固定 Git tree，使用自建临时文件、受控 Git 读取及 mock provider。源码 hash 随结果保存；不写 .git、不调用付费模型、不向 GitHub 写入。

- [主线复现结果](C:/Files/Projects/SpecGuard/docs/unknown-unknown-incremental-probes-2026-10-17.json)
- [#275 准入复现结果](C:/Files/Projects/SpecGuard/docs/unknown-unknown-runtime-admission-probe-2026-10-17.json)
- [PR / Actions 证据](C:/Files/Projects/SpecGuard/docs/unknown-unknown-incremental-evidence-2026-10-17.json)
- [交稿版本及远程增量](C:/Files/Projects/SpecGuard/docs/unknown-unknown-incremental-final-state-2026-10-17.json)
- [主线探针](C:/Files/Projects/SpecGuard/docs/review-probes/unknown-incremental-2026-10-17/main.cjs)
- [预算探针](C:/Files/Projects/SpecGuard/docs/review-probes/unknown-incremental-2026-10-17/admission.cjs)

未检查：最新 artifact ZIP、真实账单、每个种子的独立重标、真人作者采用、普通 PR 的真实 FN，以及 44ed3eb 完整测试套件的本地重跑。44ed3eb 的主线确定性探针已运行；这些限制主要约束对生产发生率和团队收益的推断。

