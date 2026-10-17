# SpecGuard 新版详细 eval：提升、shift-left、完整目标与溯源

> 公开整理版：以下结论属于文中固定版本的历史评测，并非当前版本的重新验收。原始日志、上下文、源码快照、诊断脚本及结果 JSON 留在本地；文中的这些文件名是证据标识，不是公开仓库中的可用下载或复跑入口。

日期：2026-10-17，Australia/Sydney。主 agent 与两个 worker 分别评测实际打包/真实运行/计分、需求检索、scan 执行与证据来源。本轮没有修改产品逻辑、推送分支、创建 PR 或触发新的付费模型调用；真实模型证据来自已经存在的 GitHub Actions。

## 1. 结论

**新版有可复现的提升，主要在证据进入上下文、分段执行完整性、预算利用与结果计量方面；尚不能判定已达到完整目标，也没有足够有效的配对模型数据证明实际召回或团队 shift-left 收益提高。**

现在适合受控试点。不能将它验收为“完整审完声明范围、所有 finding 都可追溯到生成它的调用、已证明减少 QA 返工”。前一轮的单 review 多 worker / 全范围执行方案也尚未在本次主线实现。

本轮最关键的发现：

1. 已关闭全局未执行 part 仍产生已验证 finding 的旧反例，但**调用级来源仍然丢失**：call1 的 finding 可以借 call2 的可见源码被放行。
2. 同样的预算下，运行时准入可以多审分段；但 **selected-scope complete 仍不等于 full-target complete**。
3. 文件分类和 PR 测试上下文确实改善，但**上下文更好不等于模型已更准确**。
4. 近期 23 个真实 eval PR 中，**5 个构造无效**；有效的 18 个又跨三个不同 product builds，不能充当最新版本的同条件 A/B。
5. grader 对同一条 inline finding 和其 coverage 行存在重复误报计数。原始计分需保留作诊断，不能直接当模型 precision。

## 2. 版本边界与证据等级

| 对象 | 固定版本 / build | 用途 |
|---|---|---|
| 上一轮版本 | `7c131b5f6ad78d46279ca038518b2818fc757f1f` / `89b1e3504c13` | 全部配对探针的 baseline |
| 本轮开始时新版 main | `b377cff939d452d339d5ec284d9b137e2c0b85e6`，#301 / `9224bdda240f` | 完整配对 candidate |
| 评测期间新增 main | `5247da3ebf95826f1e544b2df0e1ca45ddc813ce`，#305 / `34dfad4db80c` | 诊断增量及 scan 反例复测 |
| #301 实际 CI head | `59c9dbc2065e9654370ac4075fadc9502f2698d3` | tree 与 b377cff 相同，均为 `5e7b3ca2681d8fd6fb4fc0df4e140a7afcb58fd1` |
| 近期真实 eval 样本 | PR #280–#306 中固定抽取的 23 个 case PR | 现存端到端运行与评测输入审计，不冒充同条件新版 A/B |

版本来源：[b377cff](https://github.com/Mira190/SpecGuard/commit/b377cff939d452d339d5ec284d9b137e2c0b85e6)、[5247da3](https://github.com/Mira190/SpecGuard/commit/5247da3ebf95826f1e544b2df0e1ca45ddc813ce)。原工作区没有被切换；从固定 Git objects 导出快照执行。

本文区分三种证据：**实际模块配对探针**证明确定性行为；**真实 Actions / artifact**证明现场执行；**历史报告或 PR 作者数字**只作背景。受控 provider stub 不计为模型召回实验，marker 可见率不计为缺陷召回。

## 3. 本轮实跑的版本提升

### 3.1 scan 状态、证据约束与预算

复现脚本：`scan-worker/paired.cjs`；结果：`scan-worker/paired-results.json`。最后用 5247da3 重跑同组探针，保存为 `scan-worker/latest-results.json`，关键结果一致。

| 相同输入 | 7c131b5 | b377cff；5247da3 复测一致 | 可得结论 |
|---|---:|---:|---|
| finding 引用预算 dropped part 的行 | 1 条非 low finding | 0 条 | 关闭已知全局范围越界反例 |
| finding 引用 failed part 的行 | 1 条非 low finding | 0 条 | 失败分段不再提供已审证据 |
| collector 留下后续 part 未计划 | complete；reviewed whole | incomplete；reviewed in part | 覆盖状态更诚实 |
| 全部 part 成功的正向控制 | finding 保留、complete | 相同 | 没有用全盘禁用 findings 掩盖问题 |
| 预算为 1.5 次最坏预留，实际 usage 很低 | 1 次调用 | 2 次调用 | 同预算可继续执行额外 part |
| split 请求 usage 缺失 | 成本记 0 | 记 $0.0020748 保守预留、estimated | 不再把未知请求当免费来准入下一批 |

预算探针每次最坏预留约 $0.0020748，总预算约 $0.0031122，provider usage 是固定 stub。这里的“1→2”不能外推成真实吞吐翻倍或实际成本下降。

新 runtime admission 仍主要用于 stateless split scan；八次 unit-call 上限、inventory 的文件/字节/时间限制仍在。它改善有限预算利用率，没有实现无限范围完整 review。

### 3.2 PR 上下文打包

`paired-pack.cjs` 调用两版真正的 `contextPack()`，固定 source、test、diff、候选列表和大小边界，只替换打包实现。结果见 `paired-pack-results.json`。

| 回归场景 | baseline 可见 marker | candidate 可见 marker | 解释 |
|---|---:|---:|---|
| 前面大文件挤占 pack，后面仍有 source 与 test | 4/5 | 5/5 | 后面的测试不再被饿死 |
| changed test 先作为另一个 source 的 candidate 被遇到 | 0/1 | 1/1 | 它自己的新增 hunk 得到保留 |
| candidate test 只提到 changed identifier | 0/1 | 1/1 | source hunk 标识符能驱动测试切片 |
| 小 PR 正向控制 | 2/2 | 2/2，pack 文本相同 | 小范围行为保留 |

这组是专门选择的回归样例，不能把 4/5→5/5 或 0/1→1/1 写成代表性仓库的总体提升率。

另用 **#301 的真实 artifact**，对同一个 candidate target tree 重建两版 pack，250000-byte 限制相同：

| 指标 | baseline pack | candidate pack |
|---|---:|---:|
| `src/claude-api.test.js` 新增行可见 | 30/30 | 30/30 |
| `src/engines/claude-api.js` 新增行可见 | 10/10 | 10/10 |
| pack bytes | 149909 | 163718 |
| 列入 cut 的路径数 | 4 | 5 |

这个真实控制例**没有新增行可见率增益**，且 candidate 仍有截断；应保留这个结果。它说明改进有触发条件，不能从回归样例推导“每个 PR 都更好”。cut 路径数变化不是单独的质量分数，需要看实际相关证据是否完整。

这次重建固定了 collector 产物，因此测的是 pack implementation，不是整个新旧 collector 的端到端效果。

### 3.3 需求→代码→测试定位

`trace-worker/probe.cjs` 的 21 个明确路径样例：**16/21 → 21/21**。此前会把 `src/test-map.js`、`src/spec-loader.js` 等生产文件当作测试；新版能正确分类，正常测试文件仍被识别。

同一 requirement、相同既有 Git blobs、合成生产路径 `src/test-premium.js`，调用真正的 `requirementToCode()`：baseline 缺少该生产代码候选，candidate 正确出现。证明修复已经传播到实际需求定位路径，不只是 regex 单测。

但 `tokenize / buildIndex / parseItems / isRequirementDoc / pairItems / valueDeltas / requirementToCode` 七个核心函数源码相同。**新版没有新增完整语义图、动态依赖推断或持久需求身份。**

仓库历史 fastify 数字的归属必须修正：MRR .444→.750 和 hunk-test Hit@3 4/24→20/24 来自 #239/#249，早于本次 baseline，不能再次算作本轮提升。历史集保留的不足包括：

- req→code Recall@3：26/58，44.8%。
- req→code All-required@3：6/24，25%。
- code→req Hit@3：15/24，62.5%。
- code→tests All-required@3：6/24，25%。

这不是对 b377cff 的新检索全量重跑；这里只读取版本化历史结果，防止只报 MRR 而忽略遗漏位置。24 queries 来自 12 个行为的不同变体，不是 24 个独立行为。

### 3.4 计量与诊断

`metric-audit.cjs` 实测旧行缺 delivered 字段时：baseline `precision_delivered=0`，candidate 为 `null`。这是正确的兼容改进：未知不再冒充零。

5247da3 仅增加 provider schema 拒绝原因和无 JSON 时脱敏原文留存。本轮运行它的两个新增测试：**2/2 通过**。这改善故障溯源，不等于已经修复 schema 拒绝的原因，也不改变前述召回、分段或来源约束。

## 4. 真实 GitHub Actions 的独立核查

[run 39022520963](https://github.com/Mira190/SpecGuard/actions/runs/39022520963) 的 head tree 与 b377cff 完全一致。读取了 jobs、完整测试日志、dogfood 日志，并下载 artifact `12097695057`；证据摘要在 `candidate-ci-evidence.json`，原始上下文在 `candidate-live-ctx/`。

| 检查项 | 实际结果 |
|---|---|
| Linux CI | 1436 tests；1432 pass、0 fail、3 skipped、1 TODO |
| dogfood job | success |
| review 状态 | **incomplete**，0 findings；不能把 job success 写成完整审查 |
| 实际模型 | claude-haiku-5-5 |
| usage | input 含 cache 共 101257；output 6110 |
| engine duration | 29.154 秒；不是包含排队的端到端反馈时延 |
| 报告计算的成本 | $0.0602632，来自 usage × 当前代码价表，不是独立账单核对 |
| 证据状态 | 源码/测试仍有 cut；原始模型的部分 covered 在最终报告中降为 unknown |
| schema 输出 | 日志存在 schema fallback，最终保留可解析 findings.json；不据此声称 schema-enforced 输出始终可用 |

这说明新构建现场跑通、能输出诚实的不完整状态，但单个没有种子 oracle 的 dogfood run 无法测召回。

本地另跑了 candidate 的四个相关测试文件：240 项中 235 pass、5 fail；五项失败均出现临时 fixture 路径的 `EPERM`，其中四项是清理 hook。没有把它们忽略后宣称本地全绿，也没有把它们当作已确认产品回归。最初 sandbox 尝试因环境受限中止；完整日志保存在 `targeted-tests-elevated.tap`。Linux CI 的绿色结论只归属于上面固定的 b377cff 等价 tree，未冒充 5247da3 全套 CI。

## 5. 最近真实 eval 样本：先验证评测本身

从现存 PR 提取 23 个案例，不开启新 PR 或调用模型。`score-live.cjs` 逐一比较 case head overlay 与实际提交的 Git blobs，并核查该 sandbox 的真实 diff，再用 candidate 的 canonical grader 重算。

### 5.1 五个溯源场景没有提交预期变更

| PR / case | 实际 diff 文件数 | 与 head fixture 不符的文件数 |
|---|---:|---:|
| #299 / tr1 | 0 | 1 |
| #302 / tr11 | 0 | 2 |
| #303 / tr12 | 0 | 3 |
| #304 / tr13 | 0 | 1 |
| #306 / tr14 | 0 | 1 |

它们的 summary 都是 Nothing to review。**这些样本属于 evaluation-construction failure，不能计作 reviewer-quality 的通过或漏报；同时应保留 5/23 的 harness 失败记录，避免通过剔除失败美化系统可靠性。**

对 [#302](https://github.com/Mira190/SpecGuard/pull/302) 做了额外的全 tree 核验：base/head tree 都是 `89195348a3ffd3086a91aa63d9216cc419c62d9e`；实际 head 仍为 `CAP_MULTIPLIER=2`，预期的 `=3` 不存在。

`eval/run.js:142–150` 只有 copy → add → `commit --allow-empty`，没有校验 staged blobs、提交 diff 或 oracle 引文。`eval/local.js` 已注明同大小文件与时间戳 stat-cache 风险；但本轮没有因果重现其为这些提交的唯一根因。能确认的是输入构造缺少有效性 gate。修复时还需考虑 linked worktree 的 `.git` 是文件，不能直接照抄删除 `.git/index`。

最近六个 traceability 样本中，五个构造无效；剩下 tr10 没有预期正例 finding，且未满足 pre-existing trace 展示期待。因此**这批运行不能证明新版的需求漂移端到端召回**。

### 5.2 有效的 18 个样本并非当前构建配对实验

| 产品 build | 有效 case PR 数 |
|---|---:|
| `94d2150be31e` | 14 |
| `61e48fd94d4b` | 3 |
| `51e34a80f71b` | 1 |

它们都不同于 b377cff 的 `9224bdda240f`，也不同于 5247da3 的 `34dfad4db80c`。因此只能作近期系统行为证据，不能把组间差异叫新版提升。

canonical grader 对这 18 个有效构造的原始诊断输出是：TP 8、FN 10、FP 10，delivered recall 8/18，strict pass 2/18。8 个 summary 为 incomplete、10 个 complete。原始结果完整保存在 `live-scores.json`。

**这些数不能直接叫“新版 precision/recall”。** 除版本不同，还存在以下计分限制：

1. [#296](https://github.com/Mira190/SpecGuard/pull/296) 实际只有一个 high-confidence weak-test 评论，目标是 clamp 的弱断言；产品 counts 也只记一个。grader 却把同一义务的源码 coverage 行再次记为 FP，最终 1 TP + 1 FP。`metric-audit.json` 保留可复现证据。它依赖 path/line/title 分组，没有可靠 join obligation/fingerprint。
2. #288 的 strikethrough finding 是 fixture 已允许的同一实际保护缺口，但 kind/anchor 不同，因此被 exact oracle 记为 FP；该项需要语义裁定，不能将所有 unmatched 当成真实误报。
3. 预期 finding 的 `allow_summary` 约束、低置信 Details 和正文要求澄清是不同交付层级。模型曾提到一个缺口，不代表开发者收到明确修复请求，也不能用宽松“语义差不多”掩盖交付失败。
4. 这批只读取了 comments，没有逐例下载 raw findings；grader 的 `json_valid` 此时回退为 summary 完整性判断。其 10/18 不能称为真正 JSON parse rate。

仍有可核实的产品行为：#293/#294 确实发出了带 base 规则来源的 coding-standard 评论；#296 有具体反例与断言替换建议；#287 指出需求与返回 null 的实现冲突。反面例子是 #286/#292/#295/#297 的已知缺口仍主要出现在 low-confidence / unconfirmed 路径，不能拿隐藏 counts 的标题当作已交付。

完整 fixture-level 和人工语义裁定需要分开保存，不修改预期答案去追求更漂亮分数。本轮未替这些样本编造独立双人标注。

## 6. 溯源仍未闭合：已复现的残余问题

以下均在 baseline、b377cff 和 5247da3 的实际模块中验证；是尚存问题，不冒充新版引入的回归。请求体、真实 publisher 摘要和源码哈希见 `scan-worker/fixtures/` 与结果 JSON。

### R1 · 高优先级：finding 没有绑定生成它的调用

同一 unit 分两次调用。实际 request1 只看到 part1，request2 才看到 part2。只让 request1 返回引用 part2 的 missing_test，request2 返回空结果。**最终仍保留一条非 low finding，status complete。**

candidate 修复了“全局从没成功执行的范围”，但合并答案时丢失 origin，验证的是所有成功 spans 的并集。另一调用看过这段代码，无法证明产生 finding 的调用看过它、看过对应测试或根据它做过判断。

位置：candidate `src/engines/claude-api.js:473,489` 聚合，`src/audit-post.js:338,869` 成功范围约束。解决方向是每条 finding 带 call/attempt ID，并绑定该 attempt 的实际 source/test visibility；静态线索保留独立 producer。

### R2 · 高优先级：单次调用源码被 cut，finding 仍可过度确认

pack 1000 bytes，引用位于 source line99，实际请求没有该语句，`pack-cut.txt` 也明确列了该源文件。最终全局正确显示 incomplete，但该行的 missing_test 仍为非 low。

当前测试证据 cut guard 与 `u.part` 跨度检查没有覆盖普通 source 文件的精确可见区间。**全局 warning 不能替代逐条结论的证据约束。** 应统一 single/split 的 source/test spans，再按 origin 验证或降级。

### R3 · 中优先级：单次请求未知 usage 仍显示零成本

split 已有最坏 reserve；single path 未赋相同的 reserve。5247da3 复测仍是 `totalCostUsd=0,costEstimated=true`。这证明成本报告不完整，**没有证明发生预算透支**，因为该 single path 没有继续准入额外请求。

### R4 · 目标缺口：完整范围与结果完整展示尚未实现

2 个 eligible/inventoried units，只选 1 个并审完、另 1 个 unreviewed，两版均可 status complete。当前语义是 selected scope；用户需要的 full-target 还没有单独的完成契约。

另有 60 条 unit findings 接收上限、Summary 主列表/Details/证据表 caps；PR 仍有前置 diff/focus 截断。单一 publisher 已存在，但“只有一份报告”不等于“整个声明范围全部审完、所有结论无损交付”。

## 7. 是否满足 shift-left 与原目标

| 目标 | 本轮判断 | 依据 / 验收差距 |
|---|---|---|
| 在 PR、QA 前提供检查 | 流程已具备，受控案例可用 | 真实 Action 已运行；缺 queue-inclusive 时延、真人实际收到反馈时点 |
| 更早发现有效单测缺口 | 有正例，稳定性尚未验收 | 具体 weak-test/删除测试发现可见；近期有效样本仍有大量低置信/未交付和上下文不完整 |
| 按需求发现实现/测试一起偏离 | 检索与规则路径存在，当前端到端证据不足 | 测试与实现共同错误的有效新正例未建立；五个 trace eval 构造无效 |
| 需求↔代码↔测试可追溯 | 引用级部分满足，调用级不满足 | quote/path/line/base 来源和 build 可核查；R1/R2 未闭合，相关性也不等于语义证明 |
| 编码规范遵循仓库规则 | 机制与特定真实 canary 有证据 | #293/#294 说明 base 规则能生效；不能外推所有语言和规范 |
| 全仓 review 一次完成 | 未满足 | 同预算更多 parts 不等于全部 parts；仍有选取、调用、文件与结果上限 |
| 多 worker 汇总到一个 Action Summary | 单一报告满足，worker 执行未实现 | 当前 scan 串行分批；前一份架构计划尚未成为产品能力 |
| unknown unknown | 未证明 | 静态 boundary/export/assertion 信号是有限启发式，种子检出不代表发现未知类别 |
| 修复闭环 | 有追踪代理，未证明修复有效 | addressed 表示相关行/测试发生变化；未默认执行新测试与针对错误的验证 |
| 减少 QA 逃逸和返工 | 未证明 | 无本轮真人对照数据；不能用种子召回、评论数或 unit touched 替代 |
| 公司 Copilot 默认路径 | 本轮未验收 | 真实模型证据是 Claude 路径，不能据此验收 Copilot PAT 现场行为 |

不建议给“总体完成 80%”这类合成分数。不同目标的证据强度、剩余风险和价值不可用一个任意权重抵消。

真正的 shift-left 最少需要闭合：当时可获得的独立需求 → 有效、及时、可行动的发现 → 作者确认并修改 → 新保护可抓住对应错误 → QA 前仍保留保护。本轮提升主要在前半链条的可靠性；未证明整条价值链。

## 8. 下一轮验收的最短路径

1. **先修评测有效性和身份。** 在开 PR/花模型额度前，对 worktree bytes、staged blobs、commit diff、预期引用做 gate；零 diff 的正例直接 construction error。固定 Action SHA/build、target SHA、model、trace、pack、预算、需求版本。结果表分别记录 construction failure、engine failure、valid review，不藏失败。
2. **修计分去重，再做 matched real-model A/B。** raw finding、coverage、inline、summary 按稳定 ID/义务关系合一；预注册 kind/anchor 替代规则。保留 fixture strict score 与独立语义裁定两列。先跑代表性的正常/边界/失败/删除/跨文件需求冲突/clean controls，再对足够独立 case 重复，按 case 聚类报告不确定性。
3. **先补 provenance，再并发。** finding → attempt → snapshot → 实际 source/test spans → requirement source/version → final delivery。将 R1/R2 的反例固定为回归测试，确保同一问题在 single/split 路径一致处理。
4. **全范围验收看任务分母。** 不只数 unit touched；记录 eligible、inventoried、planned、executed、answered、verified、full-evidence 和未完成原因。全量目标单独判定，预算不足保留已验证结果并明确 incomplete。
5. **验证反馈能形成保护。** 对样本 finding 独立写测试：先在正确版本通过，再在对应错误/合理 mutant 上失败；mirror/oracle-independence 用独立业务预期裁定，不能仅靠 production mutation。
6. **再用真人 PR 试点证明团队价值。** 沿用仓库 validation plan：盲标 precision ≥65%、fix-through 代理 ≥25% 且区间下界 >15%、time-to-merge 增长 ≤15%、与原生 review 的有效独有发现占比 ≥40%；同时直接记录 verified fix、作者处理时间、QA 逃逸和全部 attempts 成本。没有样本时写“证据不足”，不预填通过。

这些是尚未通过的验收条件，不表示本轮已经开展新的线上试点或付费 A/B。

## 9. 公开交付边界

本公开版保留固定版本、确定性观察、实际公开 PR 的核查结果与局限。原始上下文和依赖本地快照的脚本未纳入公开提交；读者无法仅凭本公开版重跑这些历史实验。本次整理没有重新调用模型或开展新的线上试点。

[精简摘要](summary.md) 使用相同的证据边界。公开发布这些观察不表示已修复本文发现，也不表示已证明模型质量或 QA 收益提升。优先解决评测构造、计分身份和调用级证据来源，再开展固定条件的新旧版本比较。
