# SpecGuard 与 Kite：基于实际 Actions、PR review 和 scan 的 shift-left 复核

日期：2026-10-17，Australia/Sydney。线上最终快照：2026-10-16 23:43 UTC（悉尼 10:43）；本地读取延续至约 10:45。本文续接[策略报告](/C:/Files/Projects/SpecGuard/docs/shift-left-value-strategy-2026-10-16.md)和[上一轮未知风险复查](/C:/Files/Projects/SpecGuard/docs/unknown-unknown-review-2026-10-17.md)。

**判断：已证明能在合并前发现有价值的测试与需求问题，并出现了实际修复闭环；尚不足以证明稳定、全面地满足 shift left，更不能据此宣称降低了真实团队的 QA 返工或缺陷逃逸。** 当前优先级应是让已有证据被正确识别、让范围和失败状态可解释、让发现与修复对应起来，再扩大扫描量。

本轮通过 GitHub 插件读取两仓库的运行元数据、选定 job 原始日志、PR 最新摘要和 review 讨论、变更 patch、workflow、scan issue 和 artifact 列表；另检查本地新修复状态。没有重新运行付费模型、修改 GitHub、合并或清理分支。详细样本见 [18 条 PR 台账](/C:/Files/Projects/SpecGuard/docs/shift-left-live-review-ledger-2026-10-17.csv)及[原始证据快照](/C:/Files/Projects/SpecGuard/docs/shift-left-live-review-evidence-2026-10-17.json)。

## 1. 判定标准与版本边界

这里的 shift left 是：在作者仍能修改、且尚未合并时，基于当时可获得的需求和代码，指出可信且可执行的验证缺口；随后有修正和验证，并保留可追溯证据。advisory review 也可以满足目标，不要求把所有 AI 发现改为强制阻断。

| 边界 | 实际读取结果 | 对结论的影响 |
|---|---|---|
| SpecGuard 初始主分支 | 8415eae，#223 已合入 | 上轮缺陷必须按后续修复重新分类 |
| SpecGuard 最终主分支 | 9cdc780c55e1352fffab6397698c87edc388175d，#224、#225 均已合入 | 不能继续把对应问题描述为“当前主分支尚未修复” |
| Kite 目标主分支 | master：8583c5000c360ab437e07f60ada03f895a87c0b7 | 不是 main；scan 和种子 PR 的基线明确 |
| Kite 最新已运行 Action | 242507f176a296e1c1a65a4acd42c870aefccb76，build ac93c6d8e3f4 | 不是本轮最新 SpecGuard 主分支，不能当作新修复验收 |
| Kite 上一次 scan Action | aa183c7c09dc8cde1fac2a3c2607520c72be2c80 | 同一目标 commit 的两次结果，工具版本不同 |
| 本地 DENY 修复 | fix/deny-all-inputs：e367359；包含 0cc092c，并合入最新 main；读取时工作树干净 | 新修复已成为本地提交；尚未建立它已上线及重新验收的证据 |

版本依据：[SpecGuard 最终主分支](https://github.com/Mira190/SpecGuard/commit/9cdc780c55e1352fffab6397698c87edc388175d)、[Kite 最新 scan 日志入口](https://github.com/Mira190/Kite/actions/runs/38713252604)、[上一 scan](https://github.com/Mira190/Kite/actions/runs/38704392965)。本地修复工作树仍由其他任务使用，本轮仅观察。

## 2. 运行成功与审查有效是两组数字

最终快照的最近 50 条运行：SpecGuard 47 success、2 failure、1 cancelled；Kite 50 success。它们是 GitHub 执行结论，不能直接换算成发现准确率、测试充分性或完整审查率。窗口会随新运行移动，不能与前一报告的窗口直接比较。

本轮逐条审查的 PR 摘要固定为 SpecGuard #218–#225 共 8 条、Kite #10–#19 共 10 条，每 PR 只取快照时最新 sticky summary：

| 指标 | SpecGuard：8 条 | Kite：10 条 | 正确解释 |
|---|---:|---:|---|
| 摘要 head 与当前 PR head 对齐 | 8/8 | 10/10 | 已排除直接拿旧 head 摘要评价新代码 |
| reduced=true | 8/8 | 10/10 | 都是 fast-tier 审查，不代表模型调用失败 |
| complete=true | 0/8 | 0/10 | 不能宣称完整检查通过 |
| execution_complete=true | 1/8 | 10/10 | PR 执行状态；不等于仓库全覆盖 |
| 摘要 ms 中位数 | 48.33 秒 | 20.86 秒 | 摘要计时，非单次 API 或纯模型时延 |
| run 创建至摘要更新中位数 | 64.5 秒 | 40 秒 | 通过相同 head、最新事件近似关联，非精确 trace |
| 最新摘要成本合计 | $0.53 | $0.0491 | 不含旧 push、早期重试、runner 或其他工具成本 |
| 最终 PR 状态 | 8 条均已合入 | 10 条均 open、未合入 | 不能仅凭合入或评论数量判定修复收益 |

SpecGuard 最终主分支 [CI 38982638077](https://github.com/Mira190/SpecGuard/actions/runs/38982638077) 实际日志为 **1218 tests、1214 pass、0 fail、3 skipped、1 TODO**；push 事件的 dogfood job 是 skipped。前一个 8415eae 主分支运行是 1208 tests、1204 pass，报告使用更新后的结果，避免混淆。

这说明项目具备快速合并前反馈和正常测试基础。但“CI 绿 + 摘要无高置信发现”仍不足以证明改动受到充分保护。

## 3. 已经发生的有效 shift-left 案例

### 3.1 #224：机器人 review → 新回归测试 → CI → 合入

这是本轮最直接的正面证据：

| UTC 时间 | 事件 |
|---|---|
| 23:36:42 | review 指出：-w 处理时，删除/新增行数不同，即使某一对只差空白，也必须保留这个变更段 |
| 23:37:14 | f6204b8 新增对应边界测试，距评论 32 秒 |
| 23:38:29 左右 | 新 head 的测试完成：1213 tests、1209 pass、0 fail、3 skipped、1 TODO |
| 23:40:06 | #224 合入 main |
| 23:41:00 左右 | 两个修复合并后的主分支 CI：1218 tests、1214 pass、0 fail |

新增测试同时断言“行数不同仍保留”和“行数相同且仅空白差异则忽略”，是约束具体错误行为的回归测试，具有实际价值。[review 原文](https://github.com/Mira190/SpecGuard/pull/224#discussion_r4300257588)、[新增测试提交](https://github.com/Mira190/SpecGuard/commit/f6204b8a2e7e7063cd9c38a87cca548f79854e7b)、[PR CI](https://github.com/Mira190/SpecGuard/actions/runs/38982400348)。

不过，最新机器计数仍是 prior_total=1、outcomes=[]，没有完整表达这次修复。**实际闭环存在，而现有聚合指标没捕获到；不能把 addressed=0 解读成没有价值。** 本例也不能证明真人采用率：账户下的修改可能来自 agent。

### 3.2 #215：评审避免把不确定性变成重复运行循环

较早的实际讨论在 11:49:52 UTC 指出 weak-only Unknown 不应自动要求重复运行；11:52:43 的 debb50a 修改了提示与相关测试，11:54:14 回复确认此循环风险，12:12:37 合入。随后 #221 又加强结构化 reduced 原因。

这是合并前识别产品反馈循环的案例；贡献来自评审链路整体，不能全部归因于模型。[PR #215](https://github.com/Mira190/SpecGuard/pull/215)、[修复提交](https://github.com/Mira190/SpecGuard/commit/debb50a66d933bee825457a90e254d3775d5a0d6)。

### 3.3 Kite：普通测试容易放过的“代码与测试一起偏离需求”

Kite #15–#19 的代码和测试一起接受新行为，但设计文档没有改：时长、前置可写性检查、快捷键默认值、按钮文案、允许范围都发生漂移。review 能指出两边的具体差异，是与普通测试执行互补的能力。

因此应继续聚焦“行为与需求是否一致、断言是否保护行为”，而不是把评论数和文件扫描数作为价值目标。

## 4. Kite 十个种子 PR：有效检出，但不能当成真实团队收益

这些 PR 是项目验证计划明确记录的 agent 编写种子实验，每个 PR 预埋一个问题，且都是正样本。本轮核对 patch、最新摘要、相关测试和设计文档，沿用原计划的“首屏能看见具体差异”口径；没有把 Details 里的低置信镜像当作首屏成功。

| PR / 种子 | 实际预设问题 | 最新摘要呈现 | 本轮判定 |
|---|---|---|---|
| [#10 / U1](https://github.com/Mira190/Kite/pull/10#issuecomment-6163634111) | 删除大小写不敏感重复名称 BIG 的断言 | 首屏称无高置信缺口；Details 有低置信内容，历史有 inline | 未达到首屏标准 |
| [#11 / U2](https://github.com/Mira190/Kite/pull/11#issuecomment-6163639256) | 精确裁剪值断言弱化为 assert.ok | 首屏 weak test，另有额外发现 | 检出预设问题 |
| [#12 / U3](https://github.com/Mira190/Kite/pull/12#issuecomment-6163642313) | 删除“恰好当前时刻”的调度边界用例 | 明确指出边界用例缺失 | 检出 |
| [#13 / U4](https://github.com/Mira190/Kite/pull/13#issuecomment-6163641119) | 新增鼠标按钮 4/5 分支，只加无关 keyName 测试 | 明确指出新分支无测试 | 检出 |
| [#14 / U5](https://github.com/Mira190/Kite/pull/14#issuecomment-6163639462) | 中止空间阈值 100→128 MiB，未保护新边界 | summary-only 明确指出阈值边界 | 检出，无须强求 inline |
| [#15 / R1](https://github.com/Mira190/Kite/pull/15#issuecomment-6163638242) | 静默时长 10→15 秒，文档仍 10 秒 | 明确 spec mismatch | 检出 |
| [#16 / R2](https://github.com/Mira190/Kite/pull/16#issuecomment-6163641048) | 移除输出目录可写性前置检查，测试同步改成允许 | 引用文档要求可写 | 检出 |
| [#17 / R3](https://github.com/Mira190/Kite/pull/17#issuecomment-6163643321) | 摄像头快捷键默认未绑定→Ctrl+F4 | 明确默认值冲突 | 检出 |
| [#18 / R4](https://github.com/Mira190/Kite/pull/18#issuecomment-6163640934) | 停止录制→结束录制，文档文案未改 | 明确文案冲突 | 检出 |
| [#19 / R5](https://github.com/Mira190/Kite/pull/19#issuecomment-6163642034) | 倒计时范围 0–9→0–5，文档仍 0–9 | 明确范围冲突 | 检出 |

本轮观察值：**首屏呈现 9/10；单测种子 4/5，需求种子 5/5。** 它是旧 Action 版本在这个固定正样本集的结果，不能写成“最新 SpecGuard 总体召回率 90%”，也不能计算 blind precision。#11 的额外发现不增加预设问题分母或命中数。

#14 应补独立值 127 MiB 与 128 MiB 两侧的预期；若测试只引用同一个生产常量，常量错误时生产和测试可能一起通过。应保护需求规定的行为。

十条 PR 全部未合入；样本讨论中未观察到维护者处置评论，也没有 review-arm 标签。当前没有证据证明这十条反馈完成了修复，更没有真人 fix-through。Kite 摘要的 addressed=0、open=9、not_observed=3 是线程观测，可能含历史重复，不能换算为漏检率或误报率。

实验定义见[验证计划的种子实验说明](https://github.com/Mira190/SpecGuard/blob/9cdc780c55e1352fffab6397698c87edc388175d/docs/validation-plan.md)；需求核对来自固定版本 [Kite design.md](https://github.com/Mira190/Kite/blob/8583c5000c360ab437e07f60ada03f895a87c0b7/docs/design.md)。

## 5. Kite 全仓 scan：有存量发现能力，尚未形成全面保障

[scan run 38713252604](https://github.com/Mira190/Kite/actions/runs/38713252604) 与 [issue #3](https://github.com/Mira190/Kite/issues/3) 的实际范围如下。issue 是可变的最新状态，不是不可变的历次运行档案。

| 层次 | 实际证据 | 不应推导的结论 |
|---|---|---|
| 单元发现 | 43 个单元；26 有匹配测试、17 未匹配 | 匹配到文件不等于测试有效；未匹配不等于没有任何测试 |
| 收集 / 实际审查 | 选入 12 个，实际 reviewed 9/43 | 不能说本次完整扫描了 43 个 |
| 未装入上下文 | engine.cjs、scene.ts、settings.ts 三个单元未审查 | 本轮应继续保持待检查 |
| 大文件 | app.cjs 本轮只有 part 1/2，行 1–481 | 不能把整个文件计为完成 |
| 需求文档 | 1 份；131 个块历史曾审，80 个本轮审、51 个沿用 | 历史曾审不等于当前版本全量复核 |
| 证据候选 | 80 块中 66 有代码候选、65 有测试候选 | 候选路径不能当作满足需求的证明 |
| 文档结果 | 可见分组：11 个两轮报告 gap、88 unsure、26 covered | 两轮同意不等于问题已被独立验证 |
| 状态变化 | 相同目标 commit 的 38 个块状态变化 | 两次 Action SHA 不同，不能直接算模型随机波动 |
| 执行方式 | 静态 review，明确未执行测试 | covered 不能解释为测试已运行并通过 |

此外，风险表把 scene/settings 标成“this run”，而范围清单又说它们未 fit。本轮能确认的是这份旧运行报告呈现不一致；需要最新版本回放验证，不能直接认定新修复后仍存在。

issue 中有可核验的文档漂移，例如窗口高度：代码 800 与文档 740 不一致。已有 open [PR #4](https://github.com/Mira190/Kite/pull/4) 涉及同类窗口和默认选择问题，但尚未合入，也不能仅凭主题相同断言它由这次 scan 触发。

报告体积约 62.9K 字符，已接近 GitHub issue 容量；它明确省略 4 行并指向 audit.json。然而本轮读取最新 scan、上一 scan 和所抽查 PR 的 artifact 列表均无条目，无法取回被省略证据。**能确认“当前无法从列表获取”，不能擅自归因于过期、删除或从未上传。**

最新 scan 的 footer 为约 $0.52，772.9k input、34.6k cache、60.2k output、4分03秒，6 次 API 调用，19 个未答块重试一次。它说明 scan 的成本和时延显著高于单条 PR review；应优先按变更和高风险缺口增量审查，而不是无条件反复全仓扩大上下文。

全仓 scan 的合理定位是补存量债务、找 PR diff 外的需求漂移，并把相关义务带回后续 PR；单独周期扫仓库，不能证明已经把问题左移到引入它的 PR。

## 6. 新修复后，实际 review 暴露出的优先问题

### 6.1 高优先：需求来源协议不一致，造成“有测试仍被要求找测试”

#224 最新摘要中 7/7 obligation 被降为 Unconfirmed：模型用了“PR body U1/U2/U3/U4”，验证器认可规范来源“PR body”，以及可剥离 AC 数字后缀的形式；U1 被当成不在已收集集合的文档来源。

其中 O1–O6 已列出 eval/weekly-report.test.js 的具体断言，包括缺 patch 返回 null、重命名前后路径、真实 Git 对比和 -w 新边界。因为关联需求来源不合法，界面仍给出 4 条“Point to the unit test or add one”。[实际摘要](https://github.com/Mira190/SpecGuard/pull/224#issuecomment-6226700210)、[来源验证实现](https://github.com/Mira190/SpecGuard/blob/9cdc780c55e1352fffab6397698c87edc388175d/src/post.js#L1102)。

**原因是模型输出与验证器的来源协议没有对齐，不能直接断言测试不存在。** 保持拒绝非法来源的原则；由 collector 提供 canonical source ID，让模型只能引用现有 ID，U1 等显示标题单独保存。来源错误应返回有限次数修正机会，仍无法验证则如实 Unknown。不要通过放宽任意文件引用或直接把 Unknown 改 covered 来恢复绿色。

对作者的下一步也应区分：来源待确认、测试证据确实缺失、上下文未收集；来源格式问题优先由工具自行修正。

### 6.2 高优先：测试层级字段缺失，不能转译成“请再补一个单测”

#225 的 6 个 obligation 中 4 个因“layer not stated / path not clearly unit”降级，并且多个引擎及测试文件被截断。最新摘要自己承认有 planner→adapter→audit-post→gate 的链路测试，却仍将相关义务反馈为未确认。[实际摘要](https://github.com/Mira190/SpecGuard/pull/225#issuecomment-6226704295)。

最小改进是让 evidence 的层级必填，路径分类由 collector 提供可核对标识，结构错误可有限重试；把“有集成保护但不证明独立单元行为”“未见证据”“证据格式无效”分开。确需单元证据时，应具体说明哪个可独立约束的行为尚缺保护。不要为了获得单元覆盖标签，把本来合适的链路测试拆成只验证实现细节的测试。

### 6.3 高优先：正确发现文档冲突，不代表模型建议的修复方向正确

#222 review 正确发现 PR body 的“policy advisory”与代码 CONFIG 包含 policy 冲突，但建议移除 policy，以服从旧 PR body。维护者实际意图是组织禁用等配置错误应红灯，而安全拒绝又可能共用 policy 分类。[review 原文](https://github.com/Mira190/SpecGuard/pull/222#discussion_r4299937890)、[PR #222](https://github.com/Mira190/SpecGuard/pull/222)。

这里应该要求确认错误分类与验收意图、同步 PR body/文档，而不是默认把代码改回旧文案。quota/policy 分类修正提交的时间还早于后续 review 回复，不能把它记成该评论促成的修复。

需求冲突有价值，但建议需要区分“已确认违约”与“意图待确认”。尤其不能因为自然语言更早存在，就默认它永远优于已明确的产品决策。

### 6.4 中优先：上下文预算应围绕行为义务，而不是平均塞文件

SpecGuard 多条摘要受大测试文件、关联测试片段截断影响；#223 还涉及 collect.sh 的适当测试层级。盲目提高全局字数、增加相邻文件，可能增加成本却仍看不到真正的断言与调用链。

建议优先装入“改动行为 → 调用者/关键 guard → 对应断言片段 → 必要需求原文”；每个义务记录缺的是哪条边。如果文件局部完整、整体不完整，状态也应按义务计算，避免一处截断把不相关结论全部变成 Unknown。

### 6.5 已推进的上轮问题：按真实状态验收，避免重复开缺陷

| 上轮项目 | 最新状态 | 尚需的验收 |
|---|---|---|
| API diff 缺 patch、重命名、-w 语义 | #224 已合入，并有新边界回归 | 观察真实后续 PR 的触碰/修复判断，避免历史数据被错误改写 |
| coverage row 与低置信镜像的计分口径 | #224 用测试明确：有低置信/Details 镜像的行不另算 FP；无 finding 的行仍算 | 这是合同澄清，不能继续直接列为已确认算法 bug；首屏检出与 FP 指标需分别说明 |
| split scan 部分成功后配置失败被绿色掩盖 | #225 已合入，链路回归和 CI 通过 | 对配置失败、瞬时故障、预算停止分别核验；部分有效结果仍应保留 |
| DENY 文档/trace 等入口 | 本地 0cc092c 修复已提交，e367359 合入新 main；读取时干净 | 确认发布状态，并按所有输入入口执行回归；尚无 Kite 最新运行验收 |

本轮没有把本地已存在的新提交误当成“尚未修复”，也没有把本地候选修复直接视为已上线保护。

## 7. Observability 和 trace：先让每个结论可以复核

当前已有 head、build、model、ms、cost、reduced 和 outcomes 等信息，基础不错。主要缺口是跨运行关联、部分结果的原因、工件可达性与修复事件。无需先引入大型追踪平台。

| 最小记录 | 要解决的实际问题 |
|---|---|
| repo、PR、target/base/head SHA、Action 完整 SHA、run_id、run_attempt、job_id | Kite 用浮动 main，两个版本被混作稳定性验证；build 片段不足以直接定位源代码 |
| model、提示/配置摘要指纹、budget、超时、分片 ID、输入集合指纹 | 区分代码变了、工具变了、输入截断和模型波动 |
| collector→pack→provider→validator→render→post 各阶段耗时和结果 | 区分等待、推理、证据校验和投递延迟 |
| 每个义务的 source ID、代码/测试 ref+path+range、证据层级、降级原因枚举 | #224/#225 的协议问题不应被统计成缺测试 |
| 分片成功/失败分类、重试、保留结果、最终 gate 决策及理由 | 部分成功后 quota/auth 错误不得被执行成功掩盖 |
| result.json / audit.json 的 schema 版本、SHA 摘要、保存位置和有效期 | issue 省略内容仍需能够取回；空 artifact 列表要明确提示证据不可用 |
| finding 稳定 ID、关联修复 commit、后续 CI、最终处置 | #224 的有效修复不能丢在 addressed=0 之外 |

建议用现有 JSON 增加上述字段，阶段名可以采用 span 概念，但先以可下载的结构化记录实现。日志和摘要引用同一 trace ID；每分片作为子记录。覆盖度以当前 target SHA、当前输入和证据为准，历史状态带来源时间与版本。

原始 prompt/context 可以短期保留；体积小且经处理的结果、版本、决策与修复关联应保留到足以做试点评估。具体保留天数按项目数据政策决定，不需为了 trace 永久保存全部私有源码。

## 8. 是否满足 shift-left 的逐项判断

| 要求 | SpecGuard 实际表现 | Kite 实际表现 | 判定 |
|---|---|---|---|
| 在合并前送达作者 | PR 事件执行，约一分钟；#224 明确合并前送达 | PR 事件执行，约 40 秒；种子 PR 仍 open | 已证明 |
| 发现普通测试会放过的行为风险 | #224 边界测试、#215 反馈循环 | 弱断言、删除边界、代码测试一起偏离需求 | 已证明存在价值 |
| 结论受可验证证据约束 | 校验失败会降级，避免虚假 covered | 引用需求和代码，低置信内容单独呈现 | 部分满足；来源/层级协议妨碍可用性 |
| 当前范围明确、无虚假全覆盖 | reduced 和截断显式呈现 | 9/43、分片、沿用历史显式呈现；表格有不一致 | 部分满足 |
| 建议具体且修复方向可靠 | #224 具体；#222 方向需人工确认 | 大多数种子反馈具体 | 部分满足 |
| 修复后验证并合入 | #224 有直接闭环；#215 有历史闭环 | 十个种子 PR 无闭环 | SpecGuard 有案例，Kite 未证明 |
| 失败与不完整状态可信 | #222/#225 改善配置失败处理 | 最新实际执行仍是旧 Action | 新代码有验证，跨仓上线未证明 |
| 全链路可追溯 | 版本与计数已有，修复关联不足 | 工件当前不可取、issue 可变、版本漂移 | 部分满足 |
| 相对现有评审产生真实团队增量收益 | 尚无合格真人对照样本 | 种子正样本不回答此问题 | 未证明 |
| 必需的合并 gate 配置 | protection API 403 | protection API 403 | 无法核验；advisory 设计不因此自动失败 |

**产品阶段判断：适合继续做受控的 PR advisory 试点与定向 scan；尚无证据支持对外宣称“全面保障 shift left”或“已降低真实缺陷率”。**

## 9. 下一轮最有利于目标的工作顺序

### P0：先消除本次真实运行中的证据损耗

1. 统一来源 ID 与测试层级协议；为 #224 的 U 标签和 #225 的层级缺失保留回放样本。验收：规范化后可引用既有有效证据，非法来源仍被拒绝；修正失败则具体说明未知原因，不自动改成通过。
2. 将已合入 #224/#225 与本地 DENY 修复分别记为“已合入 / 本地候选 / 跨仓已验证”。DENY 验收覆盖需求文档、trace 索引、关联文件等所有入口，不只 diff。
3. 为 partial scan 的成功+配置失败路径保留现有链路回归；同时保证普通 rate/network/budget 情况按既定 advisory 合同呈现，避免一律红灯。

### P1：做一次版本受控的跨仓验收，再扩大范围

固定 SpecGuard 完整 SHA、Kite target/head、模型和配置，使用现有十个种子，再补没有预埋问题的正常变更对照。需要真实模型复测时先限定预算和次数；本轮没有触发这些运行。

验收至少回答：#10 首屏漏呈现是否解决；#14 summary-only 是否被正确纳入可行动发现；需求漂移是否持续能给出具体证据；正常对照是否产生错误缺口；#224/#225 的协议错误是否消失；新版本下 scan 的范围表是否自洽。固定输入的小规模重复用于观察变动，不把不同 Action 版本的两轮一致当作稳定性结论。

同时保证完整 audit.json 可取得，或者给出明确的“证据不可用”状态。结果 JSON 和简短人工摘要分开，避免 64K 字符上限迫使关键证据消失。

### P2：从发现计数转向可核验的增量收益

先把 #224 这样的发现→测试提交→CI→合入链路记下来；区分自动匹配“触碰过文件”、作者承认有效、人工核验已修复、以及测试确能捕获错误。not_observed 保持未知，不自动当作修复或误报。

真人试点继续沿用现有 validation-plan：每工具至少 30 条盲标，fix-through 目标样本 40 PR / 100 findings，合并时间至少 30 条相关已合并 PR；不足时只报告计数。现有继续条件包括 precision ≥65%、fix-through ≥25% 且 PR 聚类下界 >15%、合并时间增幅 ≤15%、对照中独有有效发现 ≥40%。这些是项目预先写下的验收标准，当前样本尚未满足。

agent 编写的种子和自审 PR 单独报告；不能用个人账户名替代作者类型核验。长期缺陷逃逸和 QA 返工需要后续观察，当前最新运行不能给出这类因果结论。

## 10. 本轮边界与交付物

- 这是一份实际运行复核，不是全仓所有历史 PR、每个测试和每条 findings 的完整重判。逐条 PR 样本为 18 条；另读两个 scan 和选定 job 日志、#215 历史闭环。
- workflow 的同仓、非 draft 条件意味着 fork/draft 不在这条自动路径内；应把范围写入采用文档。Kite 本轮读取的两个 SpecGuard workflow 没有测试执行步骤，不能据此推断整个 Kite 仓库没有其他测试或检查。
- 分支保护 API 无权限；工件列表无条目；没有读取到缺失的完整 audit.json；未运行 Kite 应用或新模型 replay。这些边界不以猜测补齐。
- 本地根目录仍是较早 fix 分支，远程 main 与其他工作树更新；本轮按 SHA 和实际文件状态比较，没有把目录位置或提交日期简单等同于“最新全部代码”。

交付：[18 条 PR CSV](/C:/Files/Projects/SpecGuard/docs/shift-left-live-review-ledger-2026-10-17.csv)、[证据 JSON](/C:/Files/Projects/SpecGuard/docs/shift-left-live-review-evidence-2026-10-17.json)。它们保存了摘要正文、相关讨论、版本、最新运行窗口与选定日志，支持在 sticky summary 或 issue 后续变化后复核本轮判断。
