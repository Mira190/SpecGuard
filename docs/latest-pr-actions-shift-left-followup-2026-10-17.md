# SpecGuard 最新 PR、Actions 与 shift-left 深度复审（2026-10-17）

本轮结论：PR 时的需求、代码和测试检索已有实质进展，但“找到候选 → 看见完整证据 → 判断缺口 → 作者修复 → 正确计量”的链路仍有损失。最值得优先处理的是候选被误当成覆盖证据、检索失败未被披露，以及修复后的发现从评测样本中消失。继续增加扫描次数，暂时不能替代修好这些环节。

本文延续之前的分析，重点检查新合入的 #243–#250，以及正在推进的 #251/#252。产品代码未修改；未发 GitHub 评论、未触发付费模型或 Actions、未合并或清理分支。

## 1. 版本与证据边界

### 1.1 本次实际审阅的版本

| 对象 | 版本 | 本轮处理 |
|---|---|---|
| GitHub main | ab2cfc0aafe098d5e47704ebe36df85d687847e5，#250 合入后 | 主要审阅基线；确定性复现加载此 Git tree |
| 上轮中途基线 | 94196844df85cb0525fe68e84a698e6025df1454 | 对照新增 #246/#248/#249/#250，避免把已修问题继续报成缺陷 |
| 当前根目录 checkout | b1aaf113aae3ca69fcc70e7b9026130affa6c30f | 较旧，有 README 修改与多份报告；没有将它误当最新产品代码 |
| #251 初次实际 review | 1c17ee36739eb5d5bcef1e00d27f59f15000e468 | 对应已读取的狗粮运行及机器人摘要 |
| #251 新修复 | 5cd5293 → 9bb42c4 → 34709585be3f7b787a74671ca54183f94c3d876c | 阅读补测、共享前缀及随后 lazy require 修复；确定性复现已在 3470958 再跑通过；该 head 的 test/dogfood 已通过 |
| #252 | 5343879 → 494a9fa9b3ca860b857508bf795f4ff69ea5ca99 | 本地与远程均已看到；审阅 stateless 修改及 branchGuard 直接补测，最新 test/dogfood 已通过 |
| Kite Actions | 最新返回的运行仍为 2026-10-15 那批 | 没有把 SpecGuard 新代码的效果倒推为 Kite 已经重新验证 |

主要证据窗口：2026-10-17 02:38–02:44 UTC，即 Sydney 13:38–13:44；交稿刷新延伸至约 02:49 UTC，纳入 #251 循环依赖失败和后续修复。版本会继续前进，表中的“待验证”表示明确快照的状态，不预判之后的运行。

对相关活跃 worktree 检查了 HEAD、状态和差异。期间 #251 的未提交 src/test-map.js 修改已成为 9bb42c4；旧 worktree 的 src/leads.js 状态没有产生语义 diff。历史 scratch checkout 的大量删除状态不能直接解释成产品待合并修改，也不应自动清理。

[main 固定版本](https://github.com/Mira190/SpecGuard/tree/ab2cfc0aafe098d5e47704ebe36df85d687847e5)、[PR #251](https://github.com/Mira190/SpecGuard/pull/251)、[PR #252](https://github.com/Mira190/SpecGuard/pull/252)。

### 1.2 证据分级

- **实际运行证据**：GitHub jobs、解码日志、真实 PR summary 和 review comments。
- **本轮确定性复现**：从固定 SHA 加载真实模块，提供合成输入，断言实际返回值；不调用模型。共 8 个边界案例、1 个已修复对照；在 main 和 #251 新提交上各执行一次。
- **仓库已有实验**：baseline.json、goal-assessment、维护者的评审说明。本文核对文件与口径，但没有重新 fetch Fastify 并跑完整 36 variants，也没有独立重标其所有发现。
- **改进建议**：说明目标和验收方式，不写成已经测得的效果。

本轮未读取 artifact ZIP 内部的 prompt/pack。因此 PR 摘要说“某测试未 inlined”是模型对本次上下文的报告，不能直接等同为已独立证实的打包缺陷；artifact 上传成功及 ID 有日志证据。

## 2. 最新 Actions：绿色究竟证明了什么

### 2.1 运行窗口概况

首次刷新返回最近 35 次运行：30 success、3 failure、2 cancelled。这是一个包含重跑与不同工作流的时间窗口，**不是 35 个独立 PR，也不是产品审查成功率**。

后续刷新看到 #251 新 push 以及 #252 新运行，因此不把该窗口统计描述成不断更新的“当前全部”。附带 JSON 分别保存首次和后续快照。

| 运行 | 实际情况 | 对 shift-left 的解释 |
|---|---|---|
| [main CI 38995641146](https://github.com/Mira190/SpecGuard/actions/runs/38995641146) | test success；dogfood 按 push 条件 skipped | 证明测试套件在该版本通过；不表示主线又进行了一次模型审查 |
| [#251 CI 38995709971](https://github.com/Mira190/SpecGuard/actions/runs/38995709971) | test、dogfood success；产品 STATUS=incomplete | 工作流执行成功，审查范围仍不完整；两者在当前 advisory 设计中可以同时成立 |
| [#251 补测 CI 38995834823](https://github.com/Mira190/SpecGuard/actions/runs/38995834823) | 5cd5293 运行 success | 能确认这一轮运行通过；不将它冒充后续 9bb42c4 的运行结果 |
| [Kite 扫描 38994519895](https://github.com/Mira190/SpecGuard/actions/runs/38994519895) | resolve 失败；review skipped | 没有形成新 scan 质量样本 |
| [Kite 扫描 38994550844](https://github.com/Mira190/SpecGuard/actions/runs/38994550844) | resolve 失败；review skipped | 同上；不能当成 0 finding 的负样本 |
| [#251 38996053676](https://github.com/Mira190/SpecGuard/actions/runs/38996053676) | 9bb42c4 test failure，dogfood success | 共享前缀引入循环加载回归；模型运行绿不能替代集成测试 |
| [#251 修复运行 38996261102](https://github.com/Mira190/SpecGuard/actions/runs/38996261102) | 3470958 的 test/dogfood success | 最新 lazy require 修复已过检查；不能套用 5cd5293 的旧绿色 |
| [#252 最新运行 38996181974](https://github.com/Mira190/SpecGuard/actions/runs/38996181974) | 494a9fa 的 test/dogfood success | 分支逻辑与补测通过，尚不代表 Kite 访问及 seeded scan 已跑通 |

main 测试日志末尾是 1332 tests、1328 pass、0 fail、3 skipped、1 TODO。原始 TAP 中带 TODO 的 not ok 不应另算一个真实 CI failure；同样，测试总数也不能用作模型召回率。依据：[main test job](https://github.com/Mira190/SpecGuard/actions/runs/38995641146/job/117287476804)。

#251 dogfood 日志明确打印 STATUS: incomplete，并成功上传两个同为 41230 bytes 的 context artifacts；fail_on_error 为 false。建议仪表盘并列显示 execution、review completeness、grade、delivery，不再从 GitHub conclusion 一个字段推断“审过、审全、无问题”。这不要求把所有上下文截断都升级为阻塞合并。

### 2.2 新的 Kite 扫描为什么失败

两次失败都在 review 之前：

1. 日志提示 specguard environment 没有配置可用的 App secrets 或 SPECGUARD_PAT，回退到 job token。
2. 扫描目标分别是 Kite 的 seeded 分支与 master。
3. visibility guard 无法确定目标仓库可见性，报错“cannot determine the visibility … token may not reach it”。
4. review job skipped。

seeded 分支运行还出现额外 warning：不能解析带斜杠的完整分支名，回退为 eval，而不是 eval/seeded-scan-gaps-1017。即使只修后面的访问检查，输入解析仍需要重新核对，不能据此确认扫描目标正确。

这是**目标访问/解析未完成**的证据，不是已经证明目标属于某一种 visibility 的证据。建议保留当前 fail-closed 行为，并在失败输出中记录 stage=resolve、target_access=unknown、review_started=false；扫描吞吐、precision、recall 都不接纳这两次运行。

若目标确为私有仓库，给 token 读权限也不能替代结果保存位置的检查。应使用受控的非公开执行/结果位置，再验证该完整链路；不要通过绕过 visibility guard 来取得一次绿色。相关实现：[manual workflow](https://github.com/Mira190/SpecGuard/blob/ab2cfc0aafe098d5e47704ebe36df85d687847e5/.github/workflows/specguard-run.yml)。

### 2.3 #252 解决哪一层，尚未解决哪一层

#252 允许 scan_issue 关闭、既不读也不写 scan state 的运行扫描非默认分支，并在摘要记录 ref 与 SHA；有状态扫描继续受到默认分支约束。这能帮助隔离种子实验，避免 seeded 分支污染默认分支的扫描状态。

它没有改变前述目标访问、visibility guard 或带斜杠分支解析的权限前提。因此即使 #252 测试通过，也应另行确认 resolve 成功、实际 target SHA 正确、review 已启动，再测种子召回。

建议验收：同一 seeded SHA，stateless 运行成功且输出 ref；stateful 非默认分支仍被阻止；默认分支的既有 issue/state 未发生变化。本文只审阅代码和已有测试，没有执行这个远程实验。[#252 差异](https://github.com/Mira190/SpecGuard/pull/252/files)。

## 3. 新 PR 的实际 review：哪些已经产生价值

### 3.1 #243 / #248：状态与快速档拆开，已修复

#243 把执行是否完成与 fast-tier grade 分开；#248 又把关键判断从人类可读的 reason 文案转为 reason id。此前“改一句提示文本就改变状态语义”的风险不应继续作为未修问题上报。

但 #248/#249/#251 的真实摘要仍显示 execution_complete=false，原因包括上下文截断与 citation 验证降级。说明“修了 fast-tier 一律 incomplete”不等于“所有 review 现在都 complete”。实际摘要需要按具体损失原因判断。[#248 实际摘要](https://github.com/Mira190/SpecGuard/pull/248#issuecomment-6228484039)。

### 3.2 #245：交付召回与严格验收已补充，仍缺同口径 precision

现在有 tp_delivered、fn_delivered、recall_delivered、recall_delivered_e2e 和 strict_pass。当前 runner 在出错路径写 expected_findings，使失败样本进入端到端分母；这解决了之前的重要偏差。

旧 precision 仍以 raw TP 计算。保留历史数字有兼容价值，但不能将它直接配上 delivered recall 后宣称二者已使用同一个曝光集合，见第 4 节 F5/F6。[#245](https://github.com/Mira190/SpecGuard/pull/245)。

### 3.3 #246：summary 进入盲标是进步，生命周期尚未闭合

新版本做对了三件事：

- summary-only 的标题进入盲标候选；旧数据没有 claim 的条目被排除并披露。
- 不导出 delivery 列，使用一致链接，减少由表格格式泄露工具身份。
- P×A 明确称为经济假设；同 ID 的标签与 outcome 才计算 measured joint，样本不足显示 insufficient data。

但导出/导入依赖“重新从最新 sticky summary 重建 finding 列表”，所以发现消失或渠道升级后仍可能丢标签。F1/F2 是本轮新复现的剩余问题，并非否认 #246 已修的静态同批次场景。

实际机器人在 #246 提出“表格行未断言”“追踪起始说明未断言”等意见；最新摘要记录 addressed。但本轮 main 的 weekly-report.test.js 中未看到对应建议那两条精确的输出断言。因此 addressed 在这里最多说明处置启发式触发，不能独立证明建议的回归测试已补齐。[#246 review](https://github.com/Mira190/SpecGuard/pull/246#pullrequestreview-5555502361)、[实际跟进摘要](https://github.com/Mira190/SpecGuard/pull/246#issuecomment-6228253867)。

### 3.4 #247 / #249：检索优化开始由测量驱动

#247 引入固定 Fastify SHA 的 12 个行为，每个 R/C/RC 三种变体。#249 根据该评测暴露的 code→test 短板，加入 changed-hunk 标识符检索，抑制泛化 stem 占满候选。

baseline.json 中的 code→test 数据：

| 指标 | after_239 | after_hunk_tokens | 含义 |
|---|---:|---:|---|
| Hit@3 | 4/24 | 20/24 | 至少找到一个相关测试的查询数 |
| Recall@3 | 约 7% | 28/54，51.9% | 所需测试条目实际找到多少 |
| MRR@10 | 0.167 | 0.8125 | 首个相关测试出现的位置 |
| All-required@3 | 2/24，8.3% | 6/24，25% | 所有相关测试均在候选前三的查询数 |

24 是 12 个行为在两个相关变体上的查询数，不是 24 个独立行为。20/24 Hit@3 很好，但还不能说 83% 的行为已有完整测试证据；All-required 只有 25%，仍有大量多入口遗漏。

同一最新基线中，req→code 的精确位置 Recall@3 为 26/58（44.8%），All-required@3 为 6/24（25%）；code→requirement Hit@3 为 15/24（62.5%）。这说明 #249 主要改善 code→test，不应把收益扩写到所有方向。

维护者还记录了去掉 initial-config 的敏感性分析，以及 SpecGuard 自身最近 10 个 PR 的候选对照。这有助于检查单个集中测试文件贡献过大，但仍需要第二个外部仓库作为留出集；“PR 自带测试在前三”只是定位代理指标，不能证明断言足够。[基线文件](https://github.com/Mira190/SpecGuard/blob/ab2cfc0aafe098d5e47704ebe36df85d687847e5/eval/trace-recall/baseline.json)、[#249 实际人工评审](https://github.com/Mira190/SpecGuard/pull/249#pullrequestreview-5555591206)。

### 3.5 #249 → #251：一次直接有利于目标的联动修复

#249 的人工评审明确指出：共享字面量的无关测试成为候选是允许的，但 cover guard 如果把这种候选当成覆盖理由，会压掉真正的 missing_test。#251 已提供最小修复：

- hunk-tier 测试继续进入检索上下文；
- cover guard 的候选作用域排除这一 tier；
- 真实 post 流程测试断言：hunk-tier 共享字面量不降级；same-stem 对照仍按原设计降级；
- 5cd5293 补 parseCandidates 默认保留/skipHunk 排除的直接返回值断言；
- 9bb42c4 共享 HUNK_REASON，避免 producer/parser 的类型前缀各写一份；随后 3470958 改为 lazy require，处理该共享引入的循环依赖。

这比“增加一条缺测试评论”更直接保护真实缺口召回。检查时 #251 尚未合入 main，因此主线风险仍需要这个 PR 完成；不要重复开一份同样的修复。[#249 风险说明](https://github.com/Mira190/SpecGuard/pull/249#discussion_r4300935274)、[#251 首轮机器人意见](https://github.com/Mira190/SpecGuard/pull/251#discussion_r4300946398)、[#251 补测提交](https://github.com/Mira190/SpecGuard/commit/5cd5293a666d9f3fcd2785ff0eb75e4c4f1299cb)。

交稿时的新证据很关键：9bb42c4 的 CI 出现循环依赖 warning，1334 tests 中 20 个真实失败，而 dogfood job 仍然 success。3470958 将 focus 对 test-map 的读取改为 lazy，后续 test/dogfood 均已通过。这里不能把“共享常量”一概视为风险更低的整理；模块加载顺序是它改变的真实行为。本轮模块级复现曾在 9bb42c4 通过，也没有覆盖这个冷启动顺序，进一步说明本文复现的证明范围是特定反例，不能替代完整测试套件。

### 3.6 当前 review 仍有明显的证据读取损失

#249 真实摘要报告：

- 11 个 obligations，unit evidence 0/11；
- 多个大测试文件被截断；
- src/test-map.test.js 未 inlined，因此相关单测是否存在被列为 unknown；
- 3 个 obligation 的引用验证降级；
- 没有执行测试。

这不证明代码没有测试：仓库确有 hunkTokens/hunkTests 的返回值断言。它说明目前“仓库中有测试”和“本次模型能够看到并核实测试”之间仍有距离。

先对保存的 artifact 检查 source→candidate→pack→model 四个阶段，再决定修复位置。优先保留 changed source 自己的直接单测及相关 test block，再给远处的泛化候选分预算；不要只提高总 token 上限。对引用无效的条目保留 unknown，另外统计损失率，不能自动转成 missing_test。[#249 实际摘要](https://github.com/Mira190/SpecGuard/pull/249#issuecomment-6228562297)。

## 4. 本轮确认的问题与最小优化

优先级表示对本项目目标的影响。以下均有真实代码位置与确定性反例；并不声称每个反例已经在生产运行中发生。

### F1 · P1：修复后的 summary-only 发现从标签池消失

**现状。** findingsOf 读取所有历史 inline 评论，却只读取最新 sticky summary 的 sum；producer 的 sum 明确只存本轮 summary/unanchored findings。解决后的 finding 可能只留在 outcomes，不在当前 sum。

**复现。** 第一轮 summary 有 1 条 finding，导出并标 valid；第二轮 sum=[]，同 fp outcome=addressed。结果：fix-through findings=1、A=100%，但盲标池=0、joint.with_outcome=0，原标签 unmatched。

**对目标的影响。** 周报恰好丢掉已经被处置的 summary 样本；inline 历史却保留，造成渠道生命周期不对称。偏差方向取决于哪些发现更快消失，不能假定只是低估或高估 precision。

**最小修复。** 采样 cohort 一旦建立就不可由当前 summary 重新定义。利用已有每次运行 artifact 保存小型 finding manifest（canonical ID、原始 claim、首次曝光、原渠道），周报对固定 cohort 连接最新 outcome；导出标签时保存该 cohort 清单。仅保存导出清单还不够恢复“导出前已经解决”的发现，因此运行级 manifest 应覆盖窗口内已曝光发现。无需先引入新数据库。

**验收。** export→修复→rerun→import 后，同一标签仍匹配，valid_addressed 由 0 变 1；首次导出发生在修复之后也能读到原 claim。

代码：[weekly-report.js:135](https://github.com/Mira190/SpecGuard/blob/ab2cfc0aafe098d5e47704ebe36df85d687847e5/eval/weekly-report.js#L135)、[post.js:1828](https://github.com/Mira190/SpecGuard/blob/ab2cfc0aafe098d5e47704ebe36df85d687847e5/src/post.js#L1828)。复现编号 F1。

### F2 · P1：summary 升级 inline 会改变盲标 ID

**现状。** summary ref 是 16 位 fp，inline ref 是完整 40 位 fp；findingId 对完整 ref 加 path、line 等字段做 hash。去重偏好 inline，故渠道升级会更换 ID。

**复现。** 相同 repo、PR、path、line、fp 前缀，从 summary 变为 inline：F9a5e30c2e → F420a685ac；条目仍只有一条，旧标签却 unmatched。不是重复计数问题，是身份漂移。

**最小修复。** SpecGuard 的 canonical ID 使用统一的 fp 表示及 repo/PR；把位置和渠道作为可变属性。沿用现有 16 位跟踪键可减少改动，但须做冲突检查并保留完整 fp；Copilot comment ID 继续使用自己的命名空间。旧标签要有兼容映射，不能直接全部作废。

**验收。** summary→inline、inline 在新 diff 中移动、原始行号回退这几种情况，标签仍归于同一 finding；不同 PR 不串联。

代码：[label-export.js:16](https://github.com/Mira190/SpecGuard/blob/ab2cfc0aafe098d5e47704ebe36df85d687847e5/eval/label-export.js#L16)。复现编号 F2。

### F8 · P1：changed-hunk diff 失败被静默吞掉

**现状。** collect.sh 在外层 try 中执行带 20 秒 timeout 的 git diff；hunkTests 内部的 grep 失败会产生 limitation，但外层 catch 只返回空 Map。注释和 #249 的验收描述承诺失败进入 collect-limits，这条路径没有做到。

**复现。** 执行从真实 collect.sh 提取的 candidates heredoc，仅替换文件系统与 git 调用：ls-files 成功，git diff 抛 status=124；随后仍正常生成 a.test.js 候选，collect-limits 为空。该复现没有在真实仓库制造 timeout 或修改 Git。

**对目标的影响。** 大 PR 最需要的 hunk 检索失效时，下游不知道为何退回较弱匹配，也可能继续在不足的测试证据上作判断；run-level error 监控看不到这类损失。

**最小修复。** 外层 catch 追加一条简短 limitation，区分 diff 获取失败和正常零匹配；沿用已有 collect-limits 传播路径。不要因正常“没有相关测试”而报 infrastructure error。

**验收。** diff timeout/nonzero → limitation 非空；grep timeout → limitation 非空；正常无 token/无命中 → 可合法返回空列表。测试应覆盖真实 heredoc 的外层 wiring，不能只测 hunkTests。

代码：[collect.sh:291–299](https://github.com/Mira190/SpecGuard/blob/ab2cfc0aafe098d5e47704ebe36df85d687847e5/src/collect.sh#L291)。复现编号 F8；在 #251 最新提交也存在。

### F3 · P2：trace 失败在分析报告中退化成普通检索零分

**现状。** runVariant 记录 trace failed，但 analyze 不读取 status；失败与正常空结果使用同一评分路径。缺失耗时还通过 ||0 当成零。

**复现。** 一个 trace timeout 的 C variant 被分析为 requirement Hit@3=0，格式化报告没有 failed/error/timeout；把 status 改成 ok，输出完全相同。合成记录缺少 trace_ms 时，runtime 只剩 cand_ms。

当前 runner 通常会写实际耗时，因此“runtime 缺失被当零”主要是输入校验问题；核心缺陷是即使有失败 status，最终分析也不披露。

**最小修复。** 同时打印 planned/completed/failed 数、失败阶段、conditional retrieval 与 end-to-end retrieval；失败保留在端到端分母，但不能被当作算法词面召回失败来归因。缺失耗时用 unknown，不冒充性能改善。

**验收。** 相同零分下，正常 no-match 与 trace-failed 报告明显不同；失败样本不被悄悄删除而抬高总成绩。

代码：[run.js:91](https://github.com/Mira190/SpecGuard/blob/ab2cfc0aafe098d5e47704ebe36df85d687847e5/eval/trace-recall/run.js#L91)、[analyze.js:65](https://github.com/Mira190/SpecGuard/blob/ab2cfc0aafe098d5e47704ebe36df85d687847e5/eval/trace-recall/analyze.js#L65)。复现编号 F3。

### F4 / F7 · P2：评测输入身份和有效配置不够固定

**反例一。** results.target.sha 与 cases.target.sha 不一致，analyze 仍给出与正确 SHA 完全相同的成功分数。使用旧结果配新 case 文件时缺少保护；不表示当前 baseline 已经混用了版本。

**反例二。** harness 继承 process.env，只删除 TEST_PATHS，没有固定 TRACE、IGNORE_EXTRA、STANDARDS_PATHS、TRACE_BUDGET_MS。真实 trace.run(trace='off') 会正常返回合法空结果且 limitations=[]；若工作环境留下 TRACE=off，harness 可以把禁用检索记录成正常低召回。

**最小修复。** 输出并校验 target SHA、cases hash、实际 source 文件 hash、有效检索配置；评测默认明确固定这些环境变量，允许覆盖时必须记录。source Git HEAD 不足以标识 --src 指向的脏文件。analyzer 校验合法 variant、重复 case×variant；部分 --only 运行声明所选集合，不强迫每次必须全跑。

**验收。** 错 target/错 cases 明确拒绝；相同源码和固定配置重复运行排名一致；TRACE=off 必须显式声明而非隐式继承。

代码：[run.js:81](https://github.com/Mira190/SpecGuard/blob/ab2cfc0aafe098d5e47704ebe36df85d687847e5/eval/trace-recall/run.js#L81)、[analyze.js:57](https://github.com/Mira190/SpecGuard/blob/ab2cfc0aafe098d5e47704ebe36df85d687847e5/eval/trace-recall/analyze.js#L57)。复现编号 F4、F7。

### F5 · P2：precision 还没有 delivered 版本

**复现。** 一个只藏在低置信 Details 的正确 finding：raw TP=1、delivered TP=0；另一个 clean case 出现可行动误报 FP=1。aggregate 输出 precision=0.5，而同口径 delivered precision 应为 0/(0+1)=0。

**判断。** 旧 raw precision 可以继续保存；问题在于缺少命名明确的新字段，而不是要求重写历史结果。

**最小修复。** 新增 precision_delivered 与相应 TP/FP 口径说明；报告中把 raw 与 delivered 成对展示。unknown/no-data 保留 null，不造零。

代码：[grade.js:217](https://github.com/Mira190/SpecGuard/blob/ab2cfc0aafe098d5e47704ebe36df85d687847e5/eval/grade.js#L217)。复现编号 F5。

### F6 · P2：旧 error 行的未知 expected 数被当成零

**复现。** 新成功样本检出 1 个预期 finding，混入旧 error 行且没有 expected_findings：E2E recall=1；同一 error 补 expected_findings=1 后，E2E recall=0.5。

**边界。** 当前 runner 新生成的 error 已补该字段，因此不是新 runner 全部继续漏算；风险在读取/混合历史评测文件。

**最小修复。** 检测 unknown expected denominator，返回 recall_delivered_e2e=null 及数量，或要求提供可校验的 fixture manifest 后补齐。不要将未知当成“这个失败样本没有正例”。

代码：[grade.js:210–218](https://github.com/Mira190/SpecGuard/blob/ab2cfc0aafe098d5e47704ebe36df85d687847e5/eval/grade.js#L210)。复现编号 F6。

### 已修的对照：不要重复上报

candidates 子步骤非零或 spawn error 现在会 throw；正常空列表允许计零分。旧的“找不到 heredoc 还静默继续”和“candidate 子进程失败无声”不应继续作为未修问题。复现 C1 验证了这一点。

F3 针对仍留下来的 trace 失败归因，F8 针对真实 collect heredoc 内部吞异常，是不同层面的剩余问题。[candidates.js](https://github.com/Mira190/SpecGuard/blob/ab2cfc0aafe098d5e47704ebe36df85d687847e5/eval/trace-recall/candidates.js)。

## 5. 是否满足 shift-left：按结果链判断

| 层次 | 当前证据 | 判断与下一步 |
|---|---|---|
| 在合并前运行 | PR dogfood、inline/summary 均有实例 | 已具备 |
| 输入是当前 PR/当前实现 | 摘要携带 head、base、build；本地与远程需分别看 | 已有基础；run head、reviewed head、action source ref 必须分列 |
| 需求变更找到多处实现 | Fastify req→code Recall@3 44.8%，All-required 25% | 尚不足以宣称全面影响分析 |
| 代码变更找到需求与测试 | code→test 改善明显；code→req Hit@3 62.5% | 有效，但遗漏与多入口仍存在 |
| 完整证据进入判断 | #249 自身直接单测被报告不可见，citation 有降级 | 需要测 pack 后的证据保留率 |
| 发现真实且可行动 | 种子集已有成功；全仓 audit 质量样本弱 | 必须分 PR/scan、inline/summary、repo/语言统计 |
| 发现促进修复 | 有真实 addressed 记录与 #251 补测 | 是弱行为代理；不等于 verified fix |
| 修复减少后续缺陷 | 没有独立后续结果对照 | 未证明 |
| 价值能稳定计量 | 新字段和盲标已改善，但 F1/F2/F5/F6 仍在 | 不能说“只缺样本，计量已完全闭合” |

对新 goal-assessment 的两处建议：

1. “受控种子 PR 证明有效”的限定应保留，并紧邻 10/10 的数字；不要扩展为普通 PR 的真实 recall。
2. 将“缺的只是样本”改为“需要真实样本，同时补齐标签生命周期与 delivered 口径校验”。本文 F1/F2 已证明即使新样本到来，当前导入仍可能失联。

[已有目标评估](https://github.com/Mira190/SpecGuard/blob/ab2cfc0aafe098d5e47704ebe36df85d687847e5/docs/goal-assessment-2026-10-17.md) 中对真人作者、真实 FN、双人标注、模型波动等限制的披露应继续保留。

## 6. 复杂外部仓库：真正需要观测的是证据如何丢失

### 6.1 最小可用 trace，不先建设独立平台

建议给现有 context artifact 增加结构化 JSONL；先能离线连成一条链，再决定是否接入外部观测后端：

resolve → inventory → requirement discovery → impact retrieval → test retrieval → pack → model → validation → delivery → outcome → label join

每个阶段记录 run_id、attempt、target_repo、target/base/action SHA、case/requirement/obligation/finding ID、耗时、输入输出数量、预算和截断原因。不要把 token、私有代码正文写进全局日志。

| 阶段 | 最有用的新增字段 | 能回答的问题 |
|---|---|---|
| resolve | resolved_ref、resolved_sha、access_check、review_started | 扫的是 seeded 分支还是误解析为 eval？是否根本没开审？ |
| inventory | eligible/inventoried/oversized/unreached | “全仓”实际看到多少？ |
| retrieval | query_id、direction、candidate IDs、rank、why、cut | 找不到，还是找到后落在 cap 外？ |
| pack | candidate→included、line ranges、bytes、reason | 自己的单测为什么没进入上下文？ |
| validation | supported/unknown/rejected、citation reason | 模型没发现，还是发现被引用验证降级？ |
| delivery | inline/summary/Details/unanchored、canonical ID | TP 是否真的到达作者可行动区域？ |
| outcome | still_reported、touched/tests_changed、observed_at | 是处置代理，还是被独立确认修复？ |
| labels | cohort_id、canonical ID、matched/unmatched、reason | 解决和渠道转换会不会丢样本？ |

最先应实现 F8 的 limitation 与 F1/F2 的失联计数。这些比单独做“平均模型耗时”仪表盘更有助于排障。当前 counts 已有 ms、head、build、outcomes，建议复用，避免另建一套同义字段。

### 6.2 千行文件与多文件行为的验收重点

长代码不应以整文件是否放进 prompt 作为唯一验收。建议固定一组真实多入口行为，逐层检查：

- 文档变化：找到全部受影响实现位置，而不仅是文件名正确；
- 实现变化：回链相关 requirement，并区分显式 requirement、隐含行为和未知来源；
- 测试定位：找到对应测试 block 的输入、调用、assertion，避免只有文件头或测试名称；
- 跨文件委托：区分“helper 被调用过”和“当前边界/失败路径被断言”；
- 多入口修改：All-required 统计所有必需位置，而不是只看第一条正确结果；
- 装不下：具体列出哪些 obligation 的证据缺失，避免用全局“部分截断”掩盖每条结论的可信边界。

固定预算下对比“候选排名”和“真正进入 pack 的排名”。代码行数超过 1000 是分层条件；不能据此假定行为一定复杂，也不能认为多拆 chunk 就已覆盖调用关系。

## 7. 指标和实验：接下来什么最有价值

### 7.1 产品决策优先看这些

| 指标 | 推荐口径 | 当前容易混淆的地方 |
|---|---|---|
| delivered precision | 可行动曝光中的 valid / (valid+invalid)，unsure 单列 | grade 目前仍只有 raw precision |
| delivered E2E recall | 交付的已知正例 / 全部计划正例，失败与截断保留归因 | 历史 error expected 不详时不能出完整率 |
| unknown rate | 不可评估 obligations / 全部 obligations，按原因分层 | unknown 既不是 FN 的真值，也不是通过 |
| All-required@K | 一项行为所需的全部位置是否找到 | 高 MRR/Hit 可能只命中一个入口 |
| pack evidence retention | 已找到的必需证据最终有多少进入模型可见范围 | 检索分数不能替代打包质量 |
| verified-fix rate | 独立确认修复的 valid finding / 有足够观察期的 valid finding | addressed 只表示触碰规则触发 |
| escaped visible defect rate | 合并后缺陷中，当时信息足以发现却未交付的比例 | 需事后真值和完整历史输入 |
| cost per valid actionable finding | 全部运行成本 / valid actionable finding | 低单次成本不保证低误报处置成本 |

#248/#249/#251 的摘要示例成本分别约 $0.12、$0.02、$0.02，模型时长约 78、115、55 秒。它们不是随机样本，不能替代总体成本与延迟分布；但足以说明不应沿用早期种子约 $0.005/PR 作为所有当前 PR 的成本承诺。

### 7.2 MRR、MSE 与 error function 的落点

MRR 是排名指标，本项目已经实现，适合判断作者多快看到第一个正确位置。MSE 是数值预测的平方误差，不应作为“是否检出需求/测试缺口”的主成绩。

本项目当前更适合用 precision/recall、strict pass、All-required 及分阶段 unknown，必要时给决策一个透明的加权损失：

L = 漏掉高影响缺陷的代价 + 误报处置代价 + 审阅延迟代价 + 运行成本。

权重需要按实际作者处置时间和缺陷影响标定，本文没有测得这些代价。若以后输出数值概率，再评估概率校准；当前 high/low confidence 标签不应直接拿来充当已校准的 0–1 概率。

### 7.3 两类召回实验要分开

**检索召回。** 保持当前 Fastify 固定集作为开发集，再增加一个不同语言/组织结构的外部留出集；包含千行文件、多入口、跨文件委托、不同命名与动态注册。R/C/RC 同组切分，避免把同一行为的变体分别放入开发与留出集。

**产品召回。** 对普通无报警 PR 独立复审，找真实 FN；对 scan 使用已知缺口与干净对照的配对实验。先冻结真值，再运行工具，不能按工具输出反过来定义正例。

种子本身也需要双人确认：是真缺口、原本不被现有测试断言、修改前后可执行行为明确。单看“额外 finding 共 3 条，其中 valid 0 条”不能推出全仓工具 precision 恒为零；也不能以样本少为由忽略质量风险。

## 8. 建议执行顺序与验收

| 顺序 | 工作 | 最小验收 | 与目标的关系 |
|---|---|---|---|
| 1 | 完成 #251，等待最新 head 的必要检查 | hunk 候选保留在上下文，但不触发 literal cover 降级；直接 parser 与真实 post 回归均通过 | 先保护真实缺口召回 |
| 2 | 修 F8 的外层异常披露 | 注入 git diff timeout 后 collect-limits 非空；正常零命中不报故障 | 复杂 PR 的损失不再静默 |
| 3 | 修 F1/F2 标签 cohort 与 canonical ID | export→fix→rerun→promote→import 全链路仍关联 | 得到可信价值结论 |
| 4 | 补 F3/F4/F7 的评测身份和失败归因 | 错 SHA 拒绝；trace 失败明确披露；有效配置可复现 | 避免按伪回归优化算法 |
| 5 | 新增 delivered precision；修旧 error 分母 | F5 的 0.5 与 0 分开命名；F6 未知分母不输出 100% | 统一产品成绩口径 |
| 6 | 在 #252 之后跑通 seeded scan 前置条件 | 访问、完整 ref、目标 SHA、stateless 均确认，再算 recall | 真正测 scan，而非统计 resolve 失败 |
| 7 | 分析 #249 artifact 的 pack 损失 | 定位 src/test-map.test.js 在哪一阶段丢失或未被读取 | 降低错误补测建议 |
| 8 | 留出仓库、无报警 PR 抽样、双人盲标 | 固定 cohort、预注册分母、报告 unknown 与区间 | 检验真实泛化与漏报 |

暂时不需要先建设向量数据库、跨仓全量 AST 图或独立 observability 平台。这些是否值得，应由“哪类遗漏占主要 FN、现有候选/pack 改动是否已无效”的测量决定。

分支处理仅建议：#251/#252 是当前相关的待合入工作，应分别完成检查，不以提交时间更新代替兼容性验证；已合入的 #243–#250 不再重复合并。本轮不删除历史 worktree，尤其不碰仍有未提交内容或被其他 agent 锁定的目录。

## 9. 复现、附件与未检查项

主线复现命令：

    node docs/review-probes/actions-followup-2026-10-17/probe.cjs

最新已审 #251 对照：

    node docs/review-probes/actions-followup-2026-10-17/probe.cjs 34709585be3f7b787a74671ca54183f94c3d876c docs/latest-pr-actions-pr251-probe-results-2026-10-17.json

脚本加载固定 Git tree 的真实 CommonJS 模块，并记录 source hash。F8 使用真实 heredoc 加注入的内存文件系统与 git timeout；其他案例为模块级确定性输入。两轮均完成全部断言。临时 trace-off 文件在脚本自己的新建目录内逐文件清理，产品代码与 Git 状态未更改。

附件：

- [本轮运行与 PR 原始证据](/C:/Files/Projects/SpecGuard/docs/latest-pr-actions-followup-evidence-2026-10-17.json)
- [后续版本刷新记录](/C:/Files/Projects/SpecGuard/docs/latest-pr-actions-refresh-2026-10-17.json)
- [交稿截止 PR/CI 与循环依赖失败证据](/C:/Files/Projects/SpecGuard/docs/latest-pr-actions-final-cutoff-2026-10-17.json)
- [main 确定性复现结果](/C:/Files/Projects/SpecGuard/docs/latest-pr-actions-probe-results-2026-10-17.json)
- [#251 新提交复现结果](/C:/Files/Projects/SpecGuard/docs/latest-pr-actions-pr251-probe-results-2026-10-17.json)
- [复现脚本](/C:/Files/Projects/SpecGuard/docs/review-probes/actions-followup-2026-10-17/probe.cjs)
- [前轮指标与口径分析](/C:/Files/Projects/SpecGuard/docs/shift-left-metrics-and-latest-review-2026-10-17.md)
- [复杂仓库双向追踪调研](/C:/Files/Projects/SpecGuard/docs/complex-repository-bidirectional-traceability-research-2026-10-17.md)

未检查：artifact ZIP 内部原始 pack、Fastify 全量检索重跑、Kite seeded scan 真值实验、真人作者采用与合并后缺陷数据。#251/#252 最新 head 的 test/dogfood 结论已核对，但未审阅其每条模型输出。对应结论均保留为待验收，不使用 CI 绿色或合成复现替代。

