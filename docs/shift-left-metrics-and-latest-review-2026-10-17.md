# SpecGuard 最新复核：shift left 的指标、召回与精确率，以及误差函数的正确用途

> **处置状态（2026-10-17）：** M1 可行动 TP/FP 不对称、M4 端到端召回、M5 summary-only 盲标分母、P×A 口径与 sizeVariants 千分位已安排修复（见后续 PR）；ledger 全量 schema、Brier/校准暂缓。

日期：2026-10-17，Australia/Sydney。代码基线：cb235b11f4234570f6506d0a278d786554b287d3，已合入 #238–#241；线上初始快照 01:40 UTC（悉尼 12:40）。收尾观察主分支为 1f84964da10665f5b99ee15a9aeb0195af345753；与基线相比只有 #242 的文档/旧证据归档，没有修改评估器或产品源码，因此以下探针结论仍适用。根工作区仍为较旧 b1aaf113，本轮核对了本地相关修复分支和远程版本，使用较新的固定 Git 对象读取与执行探针。

**核心判断：下一阶段最值得优化的，不是单独提高“召回率”“准确率”或扫描数量，而是在可接受的作者负担下，稳定地把真实、有证据、可采取行动的问题送到合并前，并验证后续修正确实有效。** 当前最先要修的是评估口径不对称及样本不一致，否则压低发现数量、增加 Unknown 或调整展示位置，都可能让指标改善，却没有改善 shift left。

本轮读取最新 PR 讨论、三条 Actions 的 job 日志和 artifact 元数据，复查评估、修复追踪、检索与 scan 降级路径；用固定版本实际函数运行了 8 个确定性探针（含同一问题的实际摘要渲染对照）。没有启动模型重跑、修改产品代码或 GitHub。

交付：[证据快照](/C:/Files/Projects/SpecGuard/docs/shift-left-metrics-review-evidence-2026-10-17.json)、[探针结果](/C:/Files/Projects/SpecGuard/docs/shift-left-metrics-probe-results-2026-10-17.json)、[指标字典 CSV](/C:/Files/Projects/SpecGuard/docs/shift-left-metrics-dictionary-2026-10-17.csv)。指标研究采用 15 项一手来源；提案、探针、维护者报告的测量与本轮直接读取的线上事实分别标注。

## 1. 先澄清：你记得的 MRE / MSE 可能是什么

| 名称 | 含义 | 对 SpecGuard 的用途 | 现在的优先级 |
|---|---|---|---|
| MRR | Mean Reciprocal Rank，平均倒数排名 | 正确需求/代码能否很快出现在候选前列 | 高，适合检索层 |
| MSE | Mean Squared Error，均方误差 | 预测耗时、成本等连续数值的误差；概率版可对应 Brier | 分类质量的主指标不适用 |
| RMSE | MSE 的平方根 | 让连续预测误差回到秒、美元等原单位 | 仅有数值预测需求时 |
| MAE | Mean Absolute Error，平均绝对误差 | 成本/耗时预测的直观偏差 | 辅助 |
| MRE | Mean Relative Error 的一种缩写，定义可能不同 | 相对预测偏差，必须写清是否取绝对值、分母是什么 | 不建议用模糊缩写作主指标 |
| MAPE | Mean Absolute Percentage Error | 相对数值预测误差；真值近零时很不稳定 | 不适合有效发现数为零等场景 |
| SEM / standard error | 均值估计的不确定性 | 结果变化是否可能只是抽样/模型波动 | 高，统计解释层 |
| Brier / log loss | 概率预测评分 | 将来若有经标注校准的有效性概率，可用于评估 | 暂缓，当前 high/low 不是概率 |

因此不能用一种 error function 评价整个 Action。它同时包含信息检索、缺口识别、选择性输出、执行系统与作者工作流，必须分层衡量。

来源：[NIST reciprocal rank 实现](https://github.com/usnistgov/trec_eval/blob/main/m_recip_rank.c)、[MSE](https://scikit-learn.org/stable/modules/generated/sklearn.metrics.mean_squared_error.html)、[相对误差的零值问题](https://scikit-learn.org/stable/modules/generated/sklearn.metrics.mean_absolute_percentage_error.html)、[评分函数与目标匹配](https://scikit-learn.org/stable/modules/model_evaluation.html)。

## 2. 新仓库状态：已经进步的地方

| 新修复 | 对 shift left 的作用 | 不应直接推导 |
|---|---|---|
| #238：scan_paths 只选择主要 unit，证据读取全仓 | 中央需求、共享测试不再因 package 范围直接消失 | 全仓可搜不等于已经审完 |
| #239：heading、大小表达、排除文档候选、显示 top-3 外候选 | 需求→代码召回及范围可解释性改善 | 显示被裁剪候选不等于它们已进入模型判断 |
| #240：全仓符号、sibling test、baseline 降级 | 减少“已有其他保护却被说成没有测试”的打扰 | 所有被降级的发现都不是误报，或 precision 已实证提高 |
| #241：import、文件名变体、plural/class 匹配分层排序 | 测试候选更贴近实际，减少错误 missing_test | 匹配更多测试就证明行为覆盖更强 |
| #233：按发现判断有效修复观测，追踪 summary-only | fast-tier/部分运行不再一律丢失处置观测 | addressed 等于已核验修复，或所有统计已使用相同样本 |

依据：[PR #238](https://github.com/Mira190/SpecGuard/pull/238)、[#239](https://github.com/Mira190/SpecGuard/pull/239)、[#240](https://github.com/Mira190/SpecGuard/pull/240)、[#241](https://github.com/Mira190/SpecGuard/pull/241)、[#233](https://github.com/Mira190/SpecGuard/pull/233)。

本地四个相关 fix 分支均可追溯为本轮固定主分支的祖先；旧 worktree 的 leads.js 虽报告 modified，但核查时规范化 diff 为空，未视为更高版本的行为修复。本轮保留根目录既有 README 和报告变更，没有切分支、fetch 或覆盖其他任务工作树。

## 3. 最新实际 Actions：吞吐、完整性、准确性要分别看

| 实际运行 | 工具版本 / 目标版本 | 日志事实 | 可以得出的结论 |
|---|---|---|---|
| [主分支 CI 38991100182](https://github.com/Mira190/SpecGuard/actions/runs/38991100182) | cb235b11 | 1291 tests；1287 pass、0 fail、3 skipped、1 TODO | 当前测试通过，不是模型质量验收 |
| [Nest scan 38991206203](https://github.com/Mira190/SpecGuard/actions/runs/38991206203) | cb235b11；nestjs/nest c215fd9b4f583486c6ce39a3c43f257dc67e8329 | collector 40/1015 units；10 个只读了部分测试，记录 unsure；job success、结果 incomplete | 新版确有多 pack 吞吐，仍有证据装入限制 |
| [TypeScript scan 38991208512](https://github.com/Mira190/SpecGuard/actions/runs/38991208512) | cb235b11；microsoft/TypeScript 2e9fb00f5f5c9186d09aabd78cced5ce2497456d | collector 24/727 units；6 个只读部分测试，记录 unsure；0 design docs、2 not admitted | 执行成功；不能推出需求对齐或完整保护 |

40/1015 和 24/727 是本轮选入量与 inventory 分母，不是 defect recall。也不能只拿 partial 数相减，就断言其余单元的所有行为已完整验证。

两个新 scan 都有未过期 result artifact，且日志明确完成上传。这改善了上一轮旧 Kite 工件不可取得的状况。本轮 GitHub 工具取得了文件引用，但本地网络无法下载返回的文件 URL，因此没有读取两份完整 facts/summary 并重新标注所有发现；不能编造最新 precision 或高置信发现数。

TypeScript 日志还显示，历史拉取占用了明显时间，模型调用并非唯一耗时来源。Action 的“快”应计队列、checkout/历史、收集、模型、校验与发布全过程。

## 4. 新复核的首要发现：TP 与 FP 对展示层级的要求不一致

**优先修正：同一低置信、折叠的内容，不能既用来奖励召回，又在正常样本里免除误报成本。**

实际代码中，grade() 的 summaryHits 收集摘要项与 coverage row；allow_summary 的 TP 匹配没有采用与 FP 一致的 actionable 限制。FP 路径则过滤非 actionable 项，且已有合同明确低置信/Details 镜像不另算 coverage FP。

探针 M1/M1b 的结果：

| 同一输出 | 正样本，allow_summary=true | 正常对照 |
|---|---:|---:|
| Details 中低置信 missing_test | TP=1、FN=0 | FP=0、clean=true |
| 使用当前 buildSummary 实际渲染，同一低置信 finding 与 row | TP=1、case pass=true | FP=0、clean=true |

这不是重新争论上一轮已澄清的“低置信镜像不算 FP”合同；**新问题在于 TP 侧仍能从这类已折价输出获得信用。** 它会使改为低置信/折叠的系统在评估上得到不对称好处。

最小修正方向：分别计算 raw candidate recall 和 delivered actionable recall；主 TP 与主 FP 使用同一可行动候选集合及同一去重身份。仅展示在 Details 的候选可以单独评估，不能混入首屏/可行动召回。

代码：[summaryHits 与 pickSummary](https://github.com/Mira190/SpecGuard/blob/cb235b11f4234570f6506d0a278d786554b287d3/eval/grade.js#L97)、[FP 路径](https://github.com/Mira190/SpecGuard/blob/cb235b11f4234570f6506d0a278d786554b287d3/eval/grade.js#L135)。证据为本轮执行的 M1/M1b，不代表它在所有历史结果中的发生频率。

## 5. 其他应优先完善的评估口径

### 5.1 位置匹配 TP 不等于语义正确

M2：kind、path、line 符合，要求的 text 没出现，仍 TP=1、FN=0；case 因 text_miss 失败。这是 README 已写明的合同，不是本轮新发现的未知算法 bug。

影响：目前 precision/recall 可表示“匹配预设位置”，不能直接当作“正确解释了具体问题”。建议增加 semantic_validated_tp/recall，位置命中单列；语义判定允许合理改写，不能只机械依赖一个正则。

代码：[text_misses 与 TP](https://github.com/Mira190/SpecGuard/blob/cb235b11f4234570f6506d0a278d786554b287d3/eval/grade.js#L122)。

### 5.2 pass rate 允许误报，本来就不是准确率

M3：一个 TP 加一个额外 FP，precision=0.5，pass_rate 仍为 1。当前文档明确 FPs 降低 precision，但不会自动让普通正样本 case 失败。

应保留这种合同的可解释性，把它命名为 acceptance_case_pass 或说明其条件；若需要严格回归门槛，新增含 FP/语义/引用/交付条件的 strict_pass。不要事后改口径重写历史成绩。

代码：[pass 条件](https://github.com/Mira190/SpecGuard/blob/cb235b11f4234570f6506d0a278d786554b287d3/eval/grade.js#L178)、[评估合同](https://github.com/Mira190/SpecGuard/blob/cb235b11f4234570f6506d0a278d786554b287d3/eval/README.md)。

### 5.3 模型条件召回与端到端召回需要并列

M4：两个预设正任务，一个成功送达，一个基础设施失败；aggregate 显示 errors=1，但 precision/recall/pass_rate 都是 1，因为 errored run 被剔除。

测模型本身时，这样的条件指标合理；测 Action 给用户的实际保护时，还需以全部已分配且有 oracle 的任务为分母。示例端到端送达召回为 1/2。失败应归于执行损失，不能算模型 FP，也不能从用户效果的分母消失。

代码：[summarize 的 error 过滤](https://github.com/Mira190/SpecGuard/blob/cb235b11f4234570f6506d0a278d786554b287d3/eval/grade.js#L190)。

### 5.4 summary-only 的修复分母与盲标分母不一致

#233 已把 summary-only 纳入 fix-through 追踪，但 weekly-report.findingsOf 仍只遍历 review_comments；盲标、部分 findings/PR、overlap 和 unique 由这个列表产生。

M5：一个 summary-only finding 可贡献 fix-through findings=1、A=1，却产生 0 个盲标候选。当前 validation-plan 也承认 findings 计数主要为 inline，这属于已知范围，需要随新追踪能力对齐。

建议导出统一 finding ledger，保留 inline/file/summary/Details 的 delivery 字段；每个指标明确 exposure 集合，precision 和 fix-through 使用可关联的稳定 ID。不要用一组评论的 precision 乘另一组发现的 A。

代码：[findingsOf](https://github.com/Mira190/SpecGuard/blob/cb235b11f4234570f6506d0a278d786554b287d3/eval/weekly-report.js#L122)、[新 outcomes 与 sum](https://github.com/Mira190/SpecGuard/blob/cb235b11f4234570f6506d0a278d786554b287d3/src/post.js#L1812)。

### 5.5 precision × A 不能直接当“有效修复率”

当前 F2 用 P×A 作为价值模型的 break-even 项。它可以保留为带假设的经济模型，但不是“有效且已修复”的实测联合比例。

反例：100 个发现，50 valid、50 invalid，恰好 50 个被触碰。P=0.5、A=0.5，乘积都是 0.25；若被触碰的全是 invalid，有效修复为零；若全是 valid，有效触碰比例为 0.5。两个边缘比例无法确定联合结果。

正确关系是 P(valid 且 verified_fix)=P(valid)×P(verified_fix|valid)。最好按同一 finding ID 直接观察联合事件，且 touched 不等于 verified_fix。

代码：[P×A 和 F2](https://github.com/Mira190/SpecGuard/blob/cb235b11f4234570f6506d0a278d786554b287d3/eval/weekly-report.js#L235)。这不授权改写已有预注册阈值；新试验应先修订说明和假设，再采新数据。

## 6. #240 的 precision gate：合理保守，但必须量化漏掉什么

M6 使用当前 audit.verify：完全相同的 missing_test finding，只在 tracked set 增加 200 个无关 baseline 路径，low 从 false 变 true。代码确实按仓库级 baseline 体系对所有 missing_test 降级。

这是 #240 明确接受的保守取舍，不是证明 coverage 的方法。当前状态逻辑把 low-only 记为 unsure，并保留历史 gap 的不确定状态；本轮没有把它误报为“自动 covered”的新 bug。

下一步应对每类降级规则记录：

- demoted_valid：原本有效、被降为低置信的发现。
- demoted_invalid：被成功抑制的误报。
- retained_valid / retained_invalid：保留在可行动层的结果。
- 规则触发次数、原因、受影响仓库/行为类别。

由此计算每条 gate 的“减少多少误报、损失多少有效发现”，画出同一 oracle 集上的 precision–recall 或输出覆盖曲线。对于 repo-wide 同名符号和 sibling test，文字出现/有别的断言也只表示值得核查，不能直接证明目标输入和边界被保护。

来源：[降级实现](https://github.com/Mira190/SpecGuard/blob/cb235b11f4234570f6506d0a278d786554b287d3/src/audit-post.js#L285)、[#240 讨论](https://github.com/Mira190/SpecGuard/pull/240#discussion_r4300720635)。

## 7. 检索已经改善，但目前数字应怎样解释

#239 的维护者复测讨论报告：Fastify 12 个案例×3种变化，req→code recall@1 约 11%→33%，recall@3 约 26%→47%，全部位置找到的案例由 1→3；code→req 未改善。**本轮未拿到原 harness 独立重跑，以上是讨论中的报告值，不是本轮测量。**

这恰好说明需要多种检索指标：第一处更靠前、找回的必要位置更多、全部必要入口都找到，是不同能力。36 次变体并不等于 36 个独立业务场景。

M7 另复现了已在该 PR 留作 follow-up 的格式问题：sizeVariants('1048576 bytes') 有结果，sizeVariants('1,048,576 bytes') 返回空。建议补入分隔符/单位的留出变体；不能只修一个格式后就宣称数值需求全部可召回。[复测讨论](https://github.com/Mira190/SpecGuard/pull/239#pullrequestreview-5555328740)、[已记录 follow-up](https://github.com/Mira190/SpecGuard/pull/239#discussion_r4300699900)。

#241 的讨论还报告“无匹配测试的 unit 625→306”。这证明候选匹配有变化，不证明新增 319 个 unit 获得了正确断言保护。候选越多，pack 也越容易截断；最新外仓运行中部分测试未读的事实，应与匹配召回一起观察。[#241 review](https://github.com/Mira190/SpecGuard/pull/241#pullrequestreview-5555356211)。

## 8. Precision、Recall、Accuracy：先固定评价单位

推荐至少分开三种单位：

| 单位 | 正样本是什么 | 合理用途 |
|---|---|---|
| 检索 query—证据位置 | 标注为相关的需求/符号/测试范围 | recall@K、MRR、MAP、NDCG |
| 行为缺口 / finding | PR 时刻可观察、在产品范围内的真实验证缺口或需求偏差 | precision、recall、重复率 |
| PR / 作者工作项 | 一次合并前决策机会 | FP/100 PR、有效干预/100 PR、等待和返工 |

不能把行、文件、发现和 PR 混为同一分母。一个缺口发三条评论应去重；一条评论声称两个独立问题，应按预先约定拆分核验。

对 finding 层：

- TP：被工具以规定交付方式呈现，且独立核验为真实、适用的问题。
- FP：实际要求作者行动，但问题错误、已被正确保护、范围不适用或误解需求。
- FN：oracle 中本来可在 PR 时发现、在产品范围内，却未有效送达的问题。
- TN：只有定义有限正常任务集后才可统计；不能把未报警的所有代码行当 TN。

Precision=TP/(TP+FP)；Recall=TP/(TP+FN)；Accuracy=(TP+TN)/(TP+FP+FN+TN)。分母为零返回 N/A 并显示计数，不填 100%。

对于稀少缺陷，永远不报警可以有很高 accuracy，甚至 MSE 很低，却完全没有左移价值。因此 accuracy 不能作北极星指标。中文“准确率”也应明确是 precision 还是 overall accuracy。[分类指标定义](https://scikit-learn.org/stable/modules/generated/sklearn.metrics.precision_recall_fscore_support.html)。

## 9. 误报和漏报，哪个更重要

对当前 advisory Action，持续误报会消耗作者注意力并损害采用；但只追求高 precision、把困难项全部隐藏，也会让有效问题无法提前发现。

建议采用约束式目标，而非单独最大化一个数：

> 在关键风险召回不倒退、可行动 precision 达到试点约定下限、无错误“已保护”结论的前提下，提高每 100 个合格 PR 的有效干预，降低打扰与等待。

具体权衡由场景决定：

- 普通补测建议：作者噪声和可执行性重要，要求具体行为与证据。
- 已确认需求冲突：同时保留召回与意图确认，不默认要求回退代码。
- 高后果缺口：漏报代价更高，召回分层单列，不能被大量简单案例平均掉。
- “已覆盖/无问题”结论：错误保证比保留 Unknown 更危险，必须有单独指标。
- 配置/认证失败：属于执行可靠性，和缺陷分类的 TP/FP 不同；不能用模型质量理由掩盖无法运行。

F1 为 P/R 的调和平均。F-beta=(1+beta²)PR/(beta²P+R)，beta<1 更偏重 precision，beta>1 更偏重 recall。F0.5 可以作为普通 advisory 的辅助比较，F2 可用于高风险召回对比；**这不是行业统一标准，也不能替代风险成本或覆盖约束。**

若未来有连续评分，可报告 AP/PR 曲线；当前 high/low 只有少数工作点，不能绘制看似精细的连续性能曲线。AP 与梯形插值的 PR-AUC 也非同一算法，应写明实现。[F-beta 与 AP](https://scikit-learn.org/stable/modules/model_evaluation.html#precision-recall-f-measure-metrics)。

## 10. 检索层：MRR 很有用，但不能只看它

对每个 query q，预先标注所需的相关集合 Gq：

| 指标 | 定义/直觉 | 本 repo 应怎样用 |
|---|---|---|
| Recall@K | 前 K 个去重候选找回多少 Gq | code→req 和 req→code 分开；代码与测试也分开 |
| Hit@K | 前 K 至少有一个相关结果 | 适合快速起点，不能当集合召回 |
| MRR@K | 第一条相关结果排名的倒数取均值；前 K 无命中计 0 | 衡量能多快碰到正确位置 |
| MAP@K | 对相关结果出现处的 precision 做平均，再跨 query 平均 | 多个必要位置，评价排序整体 |
| NDCG@K | 按相关等级赋 gain 并对靠后结果折扣，除理想排序 | 区分关键入口、支持 helper 和无关相似代码 |
| All-required@K | 必要证据集合全部找回的 query 比例 | 多入口/跨模块行为尤其重要 |
| Evidence-set completeness | 必要需求、实现、测试与依赖的联合装入率 | 检索命中但没装入模型也会丢失价值 |

例：一个需求必须在 UI、CLI、后台任务三处实现，候选第一名命中 UI，MRR=1；只找到 UI 的 Recall=1/3、All-required=0。**MRR 高不能证明影响范围完整。**

相关性的单元应是符号或行为位置，避免一个文件十个重叠窗口充满 top-K。K、空 query、无相关项 query、同分排序与去重规则均要固定；大仓同名/相似模块需加入负例。

来源：[NIST 首相关排名](https://github.com/usnistgov/trec_eval/blob/main/m_recip_rank.c)、[Stanford 检索评估](https://nlp.stanford.edu/IR-book/html/htmledition/evaluation-of-ranked-retrieval-results-1.html)、[NDCG](https://scikit-learn.org/stable/modules/generated/sklearn.metrics.ndcg_score.html)。

## 11. Unknown、降级和覆盖：必须有拒判账本

建议将“行为 oracle”与“工具结论”做成明确的矩阵：

| 实际情况 | 工具提示 gap | 工具称有保护 | 工具 Unknown / 未处理 |
|---|---|---|---|
| 确有缺口 | 有效发现 | 错误保证 | 用户效果中未有效检出；原因另记 |
| 正常或已保护 | 误报 | 正确支持 | 保守拒判，可能增加人工负担 |

至少报告：

- scope_coverage：全部适用行为中多少进入了本轮可评价范围。
- evidence_complete_rate：多少义务具备本轮判断所需证据。
- decision_coverage：多少有 oracle 的任务得到了明确判断，另列 Unknown。
- actionable_precision：真实要求行动的结果有多少正确。
- delivered_recall：所有适用 oracle 正例有多少有效送达。
- false_assurance_rate：明确称“有保护”的结果中，有多少实际缺保护。

这里的 false_assurance_rate 是本报告建议明确命名的产品指标，不冒充一种通用标准名称。

若拒判越来越多，应展示 risk–coverage 取舍；拒判不是错误 covered，也不是自动算正确。小样本阶段先列同一批任务在 gate 前后的四格计数，不必急于上复杂 AURC。已有研究也指出不同拒判曲线汇总指标有局限，不能把一个面积当最终答案。[Selective classification 研究](https://arxiv.org/abs/2407.01032)。

## 12. MSE / MAE / MRE：什么时候有意义

对连续真值 yi 与预测 yhat_i：

- MSE=mean((yhat_i-yi)²)，大偏差惩罚更重，单位为原单位平方。
- RMSE=sqrt(MSE)，回到秒/美元等原单位。
- MAE=mean(abs(yhat_i-yi))，对极端误差较不敏感。
- 相对误差需先约定定义；有符号 mean((yhat-y)/y) 会正负抵消，取绝对值又会在 y≈0 时放大。

SpecGuard 可选用途是未来的 scan 费用/耗时预测；更应单列低估导致预算/时限失守的比例、尾部误差，而不是只优化平均误差。若需要 p95 资源预测，应评价目标分位数，而不是把平均值模型的 MSE 当 p95 保证。

不适合的做法：

1. 把 missing/weak/unknown/covered 任意编码为 0/1/2/3 再算 MSE：编码距离没有业务意义。
2. 比较“预测发现数量”与“作者修复数量”的 MSE 来代替 precision/recall。
3. 对真值为零的正常 PR 算 MRE/MAPE。
4. 只看平均成本误差，忽略一次严重超预算。

严格说，硬 0/1 预测的 MSE 在二分类下就是错误比例；并不会自动解决类别不平衡或作者成本问题。来源：[MSE](https://scikit-learn.org/stable/modules/generated/sklearn.metrics.mean_squared_error.html)、[MAPE 边界](https://scikit-learn.org/stable/modules/generated/sklearn.metrics.mean_absolute_percentage_error.html)。

## 13. 如果要校准 confidence，用什么 loss

只有当我们明确预测“这个 finding 经独立标注会被判 valid 的概率 p”，并有可靠标签 y∈{0,1} 时，才有：

- 二元 Brier score=mean((p-y)²)，越小越好。
- log loss=-mean(y log p+(1-y) log(1-p))，对自信但错误的概率惩罚很大。

Brier 可以理解为概率版的平方误差；但 Brier/log loss 同时受区分能力、校准及数据不确定性影响，低分不必然表示校准更好。应同时看可靠性分箱图、样本数和基线预测；不能把模型自称 0.9 直接当九成可信。

当前 high/low 是类别与规则降级的组合，BM25 是检索排序分数，都不等于 p。不能为了使用 Brier 强行把 high=0.9、low=0.3。

未来真的需要概率时，按仓库/类型验证分布，校准训练与评价留出，输出不确定区间；ECE 对分箱与样本量敏感，不能单独依赖。现阶段优先完成独立盲标和可行动口径一致，比增加概率字段更有价值。

来源：[Brier](https://scikit-learn.org/stable/modules/generated/sklearn.metrics.brier_score_loss.html)、[log loss](https://scikit-learn.org/stable/modules/generated/sklearn.metrics.log_loss.html)、[校准曲线与评分局限](https://scikit-learn.org/stable/modules/calibration.html)。

## 14. 对 shift-left Action，真正应该看重的指标

推荐主面板限制为以下八组；其他用于定位原因，避免堆出不可维护的大仪表盘。

| 优先级 | 指标 | 分母与判定 | 为什么重要 |
|---|---|---|---|
| P0 | 有效合并前干预 / 100 合格 PR | 同一 cohort 所有应审 PR；去重、valid、有针对性修正及验证 | 最接近当前产品目标 |
| P0 | 可行动 precision + FP/100 PR | 作者真正收到的各交付通道；独立标注 | 保护注意力与信任 |
| P0 | 端到端 delivered recall | 有 oracle 的所有适用正例，含执行失败与延期损失 | 防止只在能成功时统计 |
| P0 | 错误保证率 | 工具明确称有保护的行为，抽样/全量核验 | 防止 Unknown 被美化为安全 |
| P0 | Unknown/证据不完整/范围未达 | 每阶段固定分母和具体原因 | 看清保守策略的代价 |
| P1 | 首个有效反馈时延、合并前送达率 | 从 push/事件到持久发布；p50/p95；失败另报 | 反馈必须赶得上修改窗口 |
| P1 | 已确认 valid finding 的 verified fix-through | 同一 ID，观察窗内完成针对性验证 | 从评论走到实际保护 |
| P1 | 作者负担和单位有效干预成本 | 误报核查分钟、重复反馈、所有重试的费用 | 发现必须值得处理 |

这里的“有效干预”是当前可观察的代理指标，不直接叫“避免了一个生产事故”。建议记录：作者是否原已知道、是否只改文档、是否改变需求意图、是否补回归、是否证明错误被测试捕获。可接受的意图澄清也有价值，应单列，不能冒充代码缺陷修复。

testChanged/anchorTouched 只表示活动；verified fix 需要确认与目标行为相关，必要时使用 fail-before/pass-after、针对性反例或合适的人工验收。integration/e2e/manual 证据按适当层级记，不强迫每项都拆成 unit。

### 14.1 用同一个假设例子看各指标

假设 100 个合格 PR 经独立复核有 10 个适用缺口：模型产生 6 个正确候选，最终只有 4 个有效送达；另送达 2 个误报；其中 2 个真实缺口完成针对性修正与验证。

- raw candidate recall=6/10=60%，delivered recall=4/10=40%。
- actionable precision=4/(4+2)=66.7%，误报负担=2/100 PR。
- 有效干预=2/100 PR；若这 4 个有效送达都已达到观察窗，verified fix-through=2/4=50%。
- 剩余 6 个缺口的损失要继续分到检索、pack、模型、降级、交付等阶段；不能都归为“模型不够聪明”。

这只是计算示例，不是本项目实测值。它说明 precision、recall、干预与修复转化互相补充，任何一个高分都不能替代其他环节。

## 15. 用业务成本选择阈值，而不是迷信一个 loss

可用一个透明的决策模型讨论取舍：

```text
某条提示的预期收益
  = P(valid) × P(有效行动 | valid) × 行动收益
    - P(invalid) × 误报处置成本
    - 阅读/等待成本
    - 模型与执行成本
```

这不是本轮已测 ROI；各项需要采样估计。后果不同的 finding 应有不同成本，权重由产品/维护者先约定，不由模型随意打严重性。

也可在离线留出集定义成本加权错误：

```text
L = C_FP × FP
  + C_FN × FN
  + C_false_assurance × false_assurance
  + C_unknown × unresolved
  + C_delay × delay
```

必须避免重复计费：若 unresolved 的正例已计入 delivered FN，C_unknown 仅表示额外人工处置成本，不能又当一次相同缺陷损失；所有项要统一单位、观察窗口和去重身份。

一个总分仍不能代替硬约束。无效引用不得得到“有保护”，身份/权限错误不得泄漏数据，运行失败不得伪装正常；这些应由确定性检查与回归守住。

## 16. 评估实验怎么设计，才不会把模型变好与指标变好混淆

### 16.1 三层评估集

1. **确定性回归**：来源、引用、状态、上下文截断、去重、统计等协议；本轮 M1–M7 适合转化为此类回归。
2. **能力评估**：有独立 oracle 的需求漂移、删除/弱化断言、复杂调用链、跨语言和长文件。正例、正常对照、已有替代测试都要有。
3. **真实采用**：合并前反馈、作者行动、负担、观察窗内的验证及后续返工。

已有 Kite 十个正种子只回答已知问题检出；没有干净对照、真实作者采用和覆盖所有行为，不可估总体 precision 或 ROI。复杂仓库能力集要纳入 baseline-driven 测试、DI、wrapper、generated 代码、未变消费者与 1000+ 行尾部行为。

### 16.2 每次改 gate/检索都做成对比较

固定目标 SHA、工具 SHA、模型、提示、预算、执行资源、输入范围与 oracle；变化项单独声明。对同一任务跑旧/新两版，报告新增 TP/FP、失去 TP、修正 FP、Unknown 变化，而不是只比较两个总百分比。

跨 push 重试不是独立新样本；同一案例的三个变体、同一 PR 的多个 findings 也存在相关性。按基础案例/PR 聚类，跨仓结果再按仓库分层或做适当层级估计。当前 PR-cluster bootstrap 是正确方向；盲标 precision 的独立 Wilson 区间仍需说明相关性限制。

人类标注 valid/invalid/unsure 时隐藏工具来源，保留充分上下文；至少两位评审先独立再协调。unsure 单独报比例与可能上下界，不能大幅排除后只宣传高 precision。

来源：[Anthropic 统计建议](https://www.anthropic.com/research/statistical-approach-to-model-evals)、[agent eval 设计](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)。

### 16.3 重复运行该看 pass@1 还是 pass@k

pass@k 关注 k 次至少一次成功；一致性类 pass^k 关注重复任务是否每次成功。对每 push 通常只跑一次的 Action，pass@1、有效反馈稳定性和重复噪声更贴近实际体验。

不能把“重跑五次终于发现”当作正常单次 recall；若产品确实自动重试/集成多次结果，要将全部费用、时间和错误发现一同评价。连续两次相同模型说有 gap 只是稳定信号，不是独立真值确认。

资源、时限、并发和网络也可能改变评估；基础设施错误一方面单独诊断，另一方面进入用户端的交付损失。[pass 指标解释](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)、[基础设施噪声](https://www.anthropic.com/engineering/infrastructure-noise)。

## 17. 真实生产反馈能告诉什么，不能告诉什么

没有报警的 PR 里还可能有 FN。仅从已发布发现做盲标，可以估 precision，不能估 recall。要估 recall，需要额外抽样无报警/Unknown/跳过的 PR 做独立审查，或回放后来修复的缺陷。

历史 bug 回放的分母限定为“当时 PR 可见且属于 SpecGuard 范围的缺口”，不能拿所有生产 bug 要求静态补测 Action 都发现。SZZ/变更归因只是候选工具，需要排除重构、机械移动、测试修复及原需求不可见等情形。

DORA 当前公开模型为五项交付指标，包括 change lead time、deployment frequency、failed deployment recovery time、change fail rate、deployment rework rate。它们适合作为应用/服务级长期结果与护栏，不能把一个团队的变化直接归因于某个 Action，也不宜混合不同服务比较。[DORA 官方说明](https://dora.dev/guides/dora-metrics/)。

对本项目，更近端的后续观测可先是：QA 退回的需求偏差/验证缺口、合并后相关修补、作者处理分钟和 review 等待。要推断因果收益，需对照或随机分配及足够观察窗；agent 自写自审的修复单独分析，不凭个人账户名认定是真人采用。

## 18. 对现有 validation-plan 的处理建议

已有计划预注册了 precision ≥65%、fix-through ≥25% 且下界 >15%、合并时间增幅 ≤15%、有效独有发现 ≥40% 等继续条件，且不足样本显示 insufficient data。这是有价值的纪律，应保留。

但建议在下一轮新试点开始前补充口径：

- precision 采样是否包括 summary-only、file-level 和实际可行动 coverage row。
- A 是 touched 代理指标还是 verified fix，观察窗截止何时；not_observed/未成熟样本如何处理。
- P 与 A 是否来自同一 exposure cohort，F2 只是经济假设还是联合结果。
- unique 的位置邻近只是粗筛；两个工具可能在不同位置指出同一问题，或同一位置指出不同问题，需语义标注。
- 时间合并基线与三臂对照的角色；现有 0/1/2 臂并非自动提供同期无 AI 对照。
- bot 与 agent 作者分别识别，避免 agent 样本进入真人采用率。
- 每个比例附原始计数、有效样本与区间；规定哪些改动需要重新收集数据。

30 条标签等现有最低数量是项目试点条件，不是统计学上普适充分样本。需要区分“能给一个粗估”和“能识别 2–3 个百分点改进”；后者通常需要更大、且足够独立的样本与功效分析。

依据：[当前计划](https://github.com/Mira190/SpecGuard/blob/cb235b11f4234570f6506d0a278d786554b287d3/docs/validation-plan.md)、[盲标实现](https://github.com/Mira190/SpecGuard/blob/cb235b11f4234570f6506d0a278d786554b287d3/eval/label-export.js#L75)。

## 19. 最小可实施的指标记录

不用先上大型观测平台。先有一份版本化 ledger：

```json
{
  "schema": "proposal-1",
  "task_id": "stable-behaviour-and-revision",
  "repository": "owner/repo",
  "pr": 123,
  "base": "<sha>",
  "head": "<sha>",
  "tool_sha": "<sha>",
  "run_id": "<run>",
  "finding_id": "<stable-id>",
  "stage": {
    "oracle_scope": "in_scope",
    "retrieved": true,
    "packed": true,
    "raw_detected": true,
    "validated": true,
    "delivered": true
  },
  "delivery": {
    "channel": "summary",
    "actionability": "actionable",
    "posted_at": "<timestamp>"
  },
  "label": {
    "validity": "unsure",
    "provenance": "not_yet_adjudicated"
  },
  "resolution": {
    "anchor_touched": null,
    "verified_fix": null,
    "commit": null,
    "ci_run": null,
    "observed_until": "<timestamp>"
  }
}
```

这是提案，不是当前 Action schema。对没有 oracle 的线上任务，不伪造 oracle_scope 或 FN；模型前后与 gate 规则都保留可审计原因。

按同一批任务分解流水线：

```text
适用 oracle 正例
 → 被发现/检索到证据
 → 证据装入
 → 模型识别
 → 校验/降级后保留
 → 可行动送达
 → 作者确认
 → 针对性修正与验证
```

每阶段条件率可以诊断瓶颈；只有分母嵌套、同一 cohort 且事件定义一致时，条件率乘积才等于整体转化。不能直接相乘不同样本上的平均 precision/recall/fix rate。

## 20. 建议下一步的具体顺序

| 顺序 | 工作 | 验收方式 |
|---|---|---|
| 1 | 修复 M1 的可行动 TP/FP 不对称；保留 raw 与 delivered 两组指标 | 实际 renderer 的低置信 Details 不能提升 delivered TP；可行动 summary-only 正例仍能得分 |
| 2 | 统一 finding ledger，补 summary-only 的盲标与语义重复核验 | 同一 ID 可连接 exposure、标签、outcome 和成本 |
| 3 | 同时报告位置/语义、条件/端到端、scope/decision coverage | M2–M5 每种情况都能在报告上明确区分 |
| 4 | 对 #240/#241 建成对正反样本与降级账本 | 报减少 FP、损失 TP、Unknown 与 pack 截断的变化 |
| 5 | 将 #239 的检索 harness 变成可复核、版本固定的能力集 | 两个方向、MRR@K、Recall@K、All-required；覆盖值格式/长文件/多入口 |
| 6 | 在既有试点计划中明确 joint valid+verified-fix 与作者负担 | 不再用触碰或 P×A 冒充有效修复实测 |
| 7 | 用真实 PR 对照采样验证增量价值，再决定是否扩扫描/接校准模型 | 有限样本、预算和观察窗预先约定 |

本轮没有直接修产品代码，避免把“评估合同是否要改变”当成未经评审的实现选择。最小有用工程改动是统一已明确的 delivered 指标口径，并把 renderer 级反例固化为回归；无需先引入训练平台或新的 error-function 框架。

## 21. 本轮范围与局限

- 复查固定版本的评估/追踪/检索/降级路径，探针通过 Git 读取并加载了 22 个模块，记录源内容 SHA256；不是全仓每个功能的穷尽审计。
- 8 个探针含一个 renderer 对照，共覆盖 7 类情况；其中 M2/M3/M4 是文档已声明的合同，M6 是已明确接受的保守策略，M7 是已记录 follow-up，不全是新 bug。
- 未重跑外部模型评估、未拿到完整新 scan artifact 内容、未重新盲标真实最新发现；没有本轮可公开宣称的总体 precision、recall、校准误差或 ROI。
- 未更改现有验收阈值、产品代码或 GitHub 状态；保存了报告、指标字典、证据与可复现探针。
