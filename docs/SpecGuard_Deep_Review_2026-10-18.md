# SpecGuard 深度技术审查：最近更新的净收益、退化风险与下一阶段路线图

**日期：** 2026-10-18（澳大利亚悉尼时间）  
**Repository：** [`Mira190/SpecGuard`](https://github.com/Mira190/SpecGuard)（公开仓库）  
**审查基线：** `main` @ [`08d2c5b87bb8ffc144f4ca3135e8aa4ec79f327c`](https://github.com/Mira190/SpecGuard/commit/08d2c5b87bb8ffc144f4ca3135e8aa4ec79f327c)  
**特别比较：** 已合并 PR #329、#335、#336、#340、#341、#342、#343、#344；**尚未合并** PR #345。  
**来源：** GitHub Connector 读取的仓库当前源文件、提交差异、PR 内容、CI 与 Kite Actions 日志，及仓库内的历史评估。  
**修改范围：** 本次仅审查与写报告，**未推送代码、未合并 PR、未启动新的付费模型评测**。

---

## 0. 执行摘要：最重要的七项结论

1. **总体方向正确，不能宣称所有优化都是正优化。** 最近的修复在执行完整性、证据归属、预算记账、扫描 UX 和回归约束上有可核验的工程收益；但多数收益并未转化为经过独立标注证明的新增真实 TP 或减少 FP。
2. **#343 是近期可量化改善最显著的修改。** 在 PR 作者的离线同配置比较中，Nest 因测试证据被截断而强制降为 unsure 的单元从 **263/489 降至 78/489（-70.3%）**，Hono 从 **133/172 降至 82/172（-38.3%）**。这种“减少虚假不完整”的收益有合理的代码机制支持，且实测扫描运行成功，但**不是精确率或召回率的测量**。
3. **#344 修复了一组真实可靠性漏洞，净收益很可能为正**：unit finding provenance、目录链接 root anchoring、未知 usage 的修复轮预留成本、Windows Git Bash 定位。**CommonJS 导出名扩展**则需单独评估：它可能重现早期 #269 遇到的“事实成立但实际上已由公开入口覆盖”的低价值静态告警。
4. **开放的 #345 有实质性的 false-negative 风险，不建议按现有门控直接合并。** 其 `pinnedInTest()` 会因为同一测试中的**不相关**精确断言降低弱断言告警置信度；正则 `^.*$` 也会被当成有效 anchored matching。已利用从差异提取的判断逻辑单独运行最小反例验证；这不是猜测模型行为，而是确定性 publisher heuristic 的过宽条件。
5. **“CI 绿”不等于产品通过。** 主线最新 CI 在 2026-10-18 的 [`39085373622`](https://github.com/Mira190/SpecGuard/actions/runs/39085373622) 运行：**1480 tests / 1476 pass / 0 fail / 3 skipped / 1 TODO**，但主线 `dogfood` job 被跳过；PR #345 的 [`39084816569`](https://github.com/Mira190/SpecGuard/actions/runs/39084816569) 虽有成功 dogfood，日志仍说明 **reduced review (fast-tier model)**。
6. **全仓扫描的最大产品瓶颈是“找到证据→证明缺口”，而不是能否扫完。** 仓库先前第三方评估曾给出 8 条模型结论 **0 条有价值**（历史旧版本的结果，不代表今日精确率），问题主要是匹配不到通过 wrapper、DI、导出入口、共用测试文件、baseline 间接覆盖的真实证据。这一机制性风险没有因增加调用次数而自然消失。
7. **下一阶段应从“堆 heuristic / 堆扫描量”转向“行为级证据图 + 因果性评估”。** 先解决可验证的假阴性门控与真实测试映射，再建设严格的同版本 A/B 和修复闭环。不要继续把降低 unsure、提高已扫描文件数当成 Shift Left 本身。

### 对最近优化的分类（区分证据强弱）

| 改动 | 净收益判断 | 证据等级 | 仍然可能退化的地方 |
|---|---|---|---|
| #329 全仓 `scan_scope=all`、分段和预算准入 | **明确工程正向** | 代码/真实 Actions | 更多调用不意味着更高 TP，长任务与成本增长；大仓库 all 不支持 Copilot 同一路径 |
| #335 每个 finding 绑定执行 call、缺 usage 按最坏收费 | **明确可靠性正向** | 代码/针对性回归 | 跨 call 引用仍可能被保守拒绝，需要完整 provenance ledger |
| #336 requirements 排除模式 root anchored、eval 构造校验 | **明确正确性正向** | 代码/回归 | 非锚定旧配置仍可能按原语义过滤，用户需要理解 scope 规则 |
| #340 “未评估”不冒充非需求、重复 weak 去除、静态线索全量保存 | **明确正确性正向** | 代码/回归 | 更诚实的状态可能显示更多 incomplete；重复去除要避免合并不同原因 |
| #341 测试匹配和切片误判修正 | **较强正向** | 离线比较/回归 | 省略弱关联 tests 有漏查风险；80 行切片边界仍存在 |
| #342 手动表单简化、默认不创建追踪 issue | **正向 UX/隐私取舍** | 代码/回归 | 无状态运行没有跨次确认；应明确提醒 |
| #343 call-specific cuts、切片定价、pack 小测试优先 | **显著工程正向，准确性未证实** | 离线比较/真实 Action/回归 | pack 覆盖计量 ≠ 故障检测；新计价逻辑复杂，应防计划/实际分歧 |
| #344 provenance、目录锚定、repair reserve、Windows bash | **多数正向** | 差异/回归/Kite 运行 | CommonJS 名字扩展可能增加噪音；Windows 仅 mock 测试不代表真实各类安装 |
| #345 same-test pinned 和 NO_GAP | **混合，当前不宜合并** | 独立反例/PR CI | 直接压低可能真实的 weak-test TP，`not a gap` 文本门控过宽 |

**评级原则：**“正向”指对其声称的工程问题有效，**不自动**代表端到端发现质量改进。没有独立同口径标签时，只写“未证实”，不把没有找到反例等同于通过。

---

## 1. 从第一性原理看 SpecGuard 应该优化什么

SpecGuard 的价值不在于“读很多代码”或“生成很多建议”，而是尽早交付**新的、正确的、可执行的测试义务**。对于 PR：已修改的行为有没有关联需求、哪些用例应新增或强化、应属于 unit/component/integration/e2e 哪一层、哪些 Coding Standard 的真实执行状态能确认。对于全仓：发现尚未锁定的关键行为与需求偏差，同时诚实表示哪些没有足够证据判断。

端到端链路：

```text
真实适用的行为/缺口（独立 oracle）
  -> 变更/需求/符号/测试定位（retrieval）
  -> 上下文完整装载（pack / provenance）
  -> 模型或静态检测（candidate）
  -> 确定性核验/降级/去重（verified）
  -> 用户可见、可行动（delivered）
  -> 作者理解并补测试（acted upon）
  -> CI 或人工证明缺口真的被修复（verified fix）
```

因此要分别测：**eligible → reached、reached → evidence_complete、oracle → delivered TP、published → actionable TP/FP、delivered valid → verified fix**。这不是一个“覆盖率”数字能够描述的系统。

特别注意四个不等号：

- `unit seen != unit fully verified`；
- `test file mentions symbol != test proves specified behaviour`；
- `no matched test != no test exists`；
- `CI passed != SpecGuard's recommendations are correct`。

### 当前架构（根据源码）

- `src/collect.sh`、`src/requirements.js`、`src/test-map.js`、`src/trace.js`、`src/audit-units.js`：收集文档、行为、测试候选、单元和静态线索。
- `src/engines/claude-api.js` 和 Copilot/Claude 运行器：上下文拼装、切片、分段、API 预算与结构化输出。
- `src/post.js`：PR 发现校验、评论、追踪与结果展示；`src/audit-post.js`：scan 的要求与 unit 校验、置信度门控、完整性、issue 状态与摘要。
- `eval/grade.js` 等：评测、召回、精确率、严格模式；`.github/workflows/ci.yml`、`specguard-run.yml`、`specguard.yml`、`action.yml`：CI、手动、复用和组合 Action 接入。
- 本地运行 `bin/specguard-local.js`。项目已有丰富的 fixture 和回归用例，这是优势；缺陷在于部分“真实发现是否有用”尚没有稳定的独立 oracle。

证据：[代码 `test-map.js`](https://github.com/Mira190/SpecGuard/blob/08d2c5b/src/test-map.js)、[`audit-post.js`](https://github.com/Mira190/SpecGuard/blob/08d2c5b/src/audit-post.js)、[`eval/grade.js`](https://github.com/Mira190/SpecGuard/blob/08d2c5b/eval/grade.js)、[CI 工作流](https://github.com/Mira190/SpecGuard/blob/08d2c5b/.github/workflows/ci.yml)。

---

## 2. 最近版本的具体复核

### 2.1 #329：从轮转扫描到一次计划全仓

优势：规划 all units 与文档 block，明确硬预算、deadline、未到达部件；用户无需反复触发 selected 以覆盖整个仓库。后续第三方扫描已在 Nest、Hono、Fastify、Flask、Cobra 上实践（见仓库中的 [`third-party-scan-eval-2026-10-17.md`](https://github.com/Mira190/SpecGuard/blob/main/docs/third-party-scan-eval-2026-10-17.md)）。

限制：全部 unit **被选中/触达**不能推出所有测试已完整载入、所有需求都有 oracle、所有风险都被模型正确识别。`scan_scope=all` 在产品定义里当前是 Claude API path 专用，不应宣传成每个 engine 都可等价运行。在 2026-10-18 的真实 Kite 目标运行上，尽管单位全部触达，publisher 仍给 `STATUS: incomplete`：属于证据/审查覆盖不完全，不是运行失败。

### 2.2 #335 / #336：可靠性和 eval 可信度

#335 的 `callKeys` 确保一个 finding 只能基于**产生它的实际调用**已见的 unit part，消除“整个 run 看过这一行，但这个 call 没看过”的 provenance 漏洞；未知 usage 预留最坏成本避免错误超预算。#336 修复 root requirements exclude 误删 nested eval 文档、无关的工具自身测试污染目标项目 test candidates、partial-head eval 构造也能通过的问题。这些都是功能性正确修复，优先维持。

回归建议：任何新增 cut/pack/merge/repair 逻辑，都同时测试 provenance：原始引用、源 sha、call id、part spans、可见行、候选关联、过滤原因；对不可观测的引用降为 unknown 而非确认 gap。

证据：[#335](https://github.com/Mira190/SpecGuard/pull/335)、[#336](https://github.com/Mira190/SpecGuard/pull/336)。

### 2.3 #340 / #341：更诚实的状态和更少的假截断

#340 阻止模型用“不评估”把 requirement block 假装为 non-requirement，去除同位置重复 weak findings，并将静态线索从仅展示前 20 改为在详情/工件保留全部。属于直接改善用户判断能力的正向变化。

#341 改善通用文件名 (`index.test.ts`) 在不相关目录中的泛滥匹配、弱关联测试抢占 pack room、导入行触发不正确的 slice truncation。其离线对照：Hono forced **136→86**，Nest **153→125**（这一表与 #343 使用的基线不同，不能跨表相加算整体增益）。

潜在代价：测试映射进一步“精简”以后，真实的远端/间接测试会更难进入候选集。应把“省下 token”与“丢失真实必要测试”的 delta 同时列出，而不是只看 forced 降低。原先的 80 行 test-block window 仍为高风险复杂度瓶颈。

证据：[#340](https://github.com/Mira190/SpecGuard/pull/340)、[#341](https://github.com/Mira190/SpecGuard/pull/341)。

### 2.4 #342：手动触发体验更好，但明确无状态语义

`workflow_dispatch` 的 target 参数可用 `owner/repo`、PR URL 或 `tree/<branch>/<directory>`，后者从目标路径派生 scan scope；移除不需要暴露给常规用户的 max_units/output_tokens；`scan_issue` 默认为 `none` 避免在公开 SpecGuard 仓库写入扫描状态。主要是 UX 与数据位置控制收益。

注意：无状态 `scan_issue=none` 不能等同于跨次追踪确认。用户必须能看见“这次只是一张快照；缺口未经过第二次独立证据核对”，以及“source 作用域缩小、共享 design/tests 检索仍来自整个仓库”的提示。[#342](https://github.com/Mira190/SpecGuard/pull/342)。

### 2.5 #343：本轮最值得保留的优化，但需分离三种指标

该 PR 包括：

- `pack-cut.txt` 从“跨所有 call 的文件 cut 并集”改为 `path<TAB>unitIds`，使 unit A 不为 unit B 调用中的同名文件 cut 负责；
- 大 test 的“完整语义相关 slice”按实际 slice 成本计价，而不是按被截断的整文件计价；
- `audit-units.txt` 中 unit 按所需测试 byte 从小到大排序，降低共享分配饥饿。

PR 作者的同配置离线测量：

| Repo | Units | forced before | forced after | 变化 | planned unit calls |
|---|---:|---:|---:|---:|---:|
| Nest | 489 | 263 | 78 | **-70.3%** | 108→104 |
| Hono | 172 | 133 | 82 | **-38.3%** | 81→78 |
| Fastify | 33 | 19 | 12 | **-36.8%** | 22→21 |
| Flask | 21 | 11 | 5 | **-54.5%** | 9→9 |
| Cobra | 18 | 11 | 7 | **-36.4%** | 14→13 |

PR 同时披露尝试过 half-room policy：增加调用次数但没有有效收益，因此未保留。这种**负结果也公开**的做法值得保持。

**独立可核验的实跑事实：** 对 PR 分支 `fix/forced-tests`，在 [`Kite run 39083946253`](https://github.com/Mira190/Kite/actions/runs/39083946253)、[`39083944276`](https://github.com/Mira190/Kite/actions/runs/39083944276)、[`39083942363`](https://github.com/Mira190/Kite/actions/runs/39083942363) 上，GitHub Action job 确实 success，且 logs 显示审查的是 489/489、172/172、43/43 单元的目标。**但这些日志的 `STATUS` 均为 `incomplete`。** “跑完”与“所有测试证据完整”没有冲突，不能把 job success 当覆盖认证。对应真实运行的数量详情与成本来自 PR 作者记录，而非本次独立重新计算 artifact。

**建议新增两个断言：** `pack_cut == expected_per_call_cuts` 和 `unit_decision_not_covered_without_all_obligation_evidence`。此外针对相同 test 文件在不同 call 间、unit part 间被 slice 或完整装载的各种排列做 property-based / metamorphic tests。[#343](https://github.com/Mira190/SpecGuard/pull/343)。

### 2.6 #344：四项可确认修复 + 一个值得再次抽检的静态信号扩展

正向：

1. `audit-post.js` 验证 declared unit 是产生 finding 的 call 成员；`missing_test` 必须引用 unit 自己的代码，`weak_test` 必须引用 unit 列出的测试（允许 matched / pack）。修复 provenance 串线。
2. `resolve-inputs.js` 将 directory link 变为 `/packages/payments` 等**root anchored** 路径，解决 `legacy/packages/payments` 被错误纳入，并在 branch/path 无法核验时拒绝模糊扫描。
3. `claude-api.js` 的一次 JSON repair turn 必须单独预留最坏成本；返回 `usage:{}` 不能让第二次调用免费入账。
4. `bin/specguard-local.js` Windows 优先定位 Git for Windows 的 `bin/bash.exe`，而非偶然调用 System32/WSL bash。实机不同安装布局仍需补 smoke test。

**有争议：** `src/test-map.js` `publicDefs/cjsNames` 为 `module.exports={...}` 额外识别导出名。它改善被动静态清单的**字面识别能力**，但扩大“某名字从未在测试里出现”的线索集合，并不自动意味着发现了应加单测的真实缺口。

仓库内旧评估指出 **#269 的 CommonJS export name 扩展曾被关闭**：Fastify unref 线索 6→42，抽查 5/5 已通过别的入口测试，净负。#344 是不同实现，不能说“同一个 bug 重现”；但它处于**完全相同的高风险机制**，在 Fastify/Hono/Kite 的真实负样本上必须检查新增 TP 与 FP。仅证明导出名被正确提取，不足以证明告警有用。来源：[#344](https://github.com/Mira190/SpecGuard/pull/344)、[第三方评估 §8.1](https://github.com/Mira190/SpecGuard/blob/main/docs/third-party-scan-eval-2026-10-17.md)。

### 2.7 #345（Open）：明确不建议按当前形式合并

新规则试图处理：`weak_test` 只引用测试中的一行 truthy 断言，但同一测试实际存在其他精确断言；以及“not a gap”措辞。

**确定性误伤反例 A：同一 `it` 里不同 subject**：

```js
it('validates authorization and metrics', () => {
  expect(auth.allowed).toBeTruthy(); // 弱断言；例如错误状态被误当允许
  expect(metrics.count).toBe(42);   // 与 auth 无关的精确断言
});
```

当前新增 `pinnedInTest()` 搜索 enclosing test block 内任何非弱断言，不要求它证明 `auth.allowed` 同一输入、同一 subject 或同一变更行为，因此会把第一条发现标为 low（`the same test also pins a value`）。本次以原 PR 里的 `TEST_DECL/ASSERTION/ANCHORED/LOOSE/CALL_SUBJECT` 判断结构编写独立 Node 最小实验，复现其返回行号 **3**（下调）；这是**未合并分支**的门控退化，而不是 main 上已发生的结果。

**确定性误伤反例 B：形式上锚定、语义上无约束**：

```js
expect(payload).toMatch(/^.*$/);
```

`ANCHORED` 只认 `/^...$/` 形状，会把空匹配/任意文本的模式判为 pinned；这个判断也独立运行确认返回 true。即便正则 anchored，也不等价于验证了该行为所需的值或边界。

**文本门控风险 C：** 新 `NO_GAP` 识别 `not a gap`，但只排除紧随的 `in`，对 `not a gap for X, but Y still lacks coverage` 等可能误杀实际 finding。不是已复现的产品 TP 损失，属于应加入反例的高优先级测试。

**建议实现而非“扩大或删掉整个规则”：**

- 仅当另一条断言能映射到**同一调用返回值、同一属性/派生行为、同一输入/边界**时，降低 confidence；如果关联无法证明，保留原发现与 `possible_existing_assertion` 提示。
- 把对测试块的归属改为语法/AST（至少对主力 JS/TS/Python/Go）或保守解析：嵌套 `describe`、内层 `test`、参数化测试、辅助函数和跳过的断言应有明确边界。
- anchored regex 必须检查约束强度，而不只是头尾锚字符；`^.*$`、`^.+$`（仍有广泛结果）、`^\s*$` 应按目标语义评价。规则宁可说“同测试存在精确检查，需要人工判定”，不要直接假设保护了同一行为。
- 一组 frozen oracle A/B：来源于 Hono/Flask/Cobra 的 FP 必须减少，同时保留上述授权反例、不同参数调用、不同测试块、只断言错误不存在、边界被弱化的 TP。
- 对每次 demotion 输出 rule id、original confidence、new confidence、关联引用与可验证原因；按同样 cohort 报 FP removed、TP lost，不只看总报警下降。

证据：[#345 开放 PR](https://github.com/Mira190/SpecGuard/pull/345)、[`src/audit-post.js` main（不含该规则）](https://github.com/Mira190/SpecGuard/blob/08d2c5b/src/audit-post.js)。

---

## 3. 主分支的仍存问题：按业务危害而不是代码易改度排序

### P0-A：False negatives 不能因“置信度规则”悄悄消失

**当前状态：** publisher 已存在 baseline/sibling/symbol、quote、counterexample、test-file matching 等门控；这些机制确实降低噪音，却可能把合法缺口折叠至 Details。#345 加重这一风险。现有 `audit-post.js` 只需仓库某处 baseline 文件超过 **200** 就可能把**全部** `missing_test` 降低置信度；该规则在代码上有明确定义，但 baseline 的存在并不证明这条行为受到覆盖。

**建议：** 每个 gate 必须通过有标注的 counterfactual eval：`demoted_invalid`（好）、`demoted_valid`（坏）、`retained_invalid`（坏）、`retained_valid`（好）。升级门槛应禁止高危行为 TP 丢失超出预注册阈值。记录 raw/delivered 两种召回。

### P0-B：测试匹配仍是最大语义缺口

`test-map.js` 头部明示：file stem、token、名字和目录规则，**不是** per-language import/调用链解析；同一个功能被公开入口、DI、wrapper、integration helper、fixtures、snapshots 或动态注册间接覆盖时，匹配失败导致错误 `missing_test`。

历史第三方复核在老版本 8 条模型发现中，6 条因为测试没有被找到而误报；这个指标不能代表最新产品精度，但直接指出目前最有价值的改进方向：

- JS/TS：构建有限 depth（例如 2-3）的 import/export/re-export、CommonJS 和测试引用图；识别模块公开入口，汇总“unit 的可达测试”。
- Python：包导出、fixture、parametrize、factory、monkeypatch 与框架 test client 入口。
- Go：package / receiver / public API、table-driven cases 和 helper 引用；不要把没有直接函数名的测试误判为没有覆盖。
- 多层级：`test coverage claim` 必须表明证据是**直接断言**、**通过 wrapper 的证明链**、还是**名字/文本相似度**。只有前两者可支持对“已被测”的强肯定。

不必立刻做全语言精确跨过程程序分析。先对 3 种主力语言/框架做证据图 MVP，让检索质量能够在 curated benchmarks 上超过字符串 heuristic。

### P0-C：`covered`、`complete`、`unknown` 三个维度不要混为一谈

现有 `audit-post.js:884–912` 用 cutUnits、unsure、unseen、incomplete 记录大量细节，方向正确；但产品级用户看“43/43 units”容易理解成保护已验证。建议把状态拆成：

```text
Execution: COMPLETED / FAILED / TIMED_OUT
Evidence: COMPLETE / PARTIAL / UNREACHABLE
Decision: GAP / NO_GAP_WITH_PROOF / UNKNOWN
Delivery: ACTIONABLE / INFORMATIONAL / SUPPRESSED
```

只有具备指向行为及断言的证据，才允许 `NO_GAP_WITH_PROOF`。没有模型发现、仅“单元被扫完”，必须是 `NO_ACTIONABLE_FINDING`，而不是“已全面覆盖”。在扫描 summary 第一屏给出明确分母：eligible files/units/parts、实际完整可见 tests、只读部分 tests、未到达、unanswered docs。

### P1-D：真实模型发现质量与确定性静态信号仍有差距

历史第三方评估（2026-10-17 基线）称：40 个种子新增线索产生 **21/40**，但可见只有 **11/40**；其中删除边界值案例为 **0/10**。Kite 早期全仓种子模型检出 **2–3/8**，新增 all 与 packed coverage 也未自动改善删测试类种子；这个结果说明 **能力（检出正确缺口）可能仍是瓶颈**。之后静态 lead 的输出与配额已迭代，这些历史数字绝不能包装为当前最新版的精度。

建议优先让静态层做精确而可验证的事实：删除/弱化了哪条具体断言、哪些新值/分支未见对应条件、曾有测试证据现在消失了没有。静态 lead “导出未被任何测试直接提及”应排在 informational，而非 confirmed gap。

### P1-E：真实 eval 仍应防止“自测自证”

项目内已有 `eval/grade.js` 的 `tp_delivered`、`strict_pass`、出错样本端到端分母处理等改进（当前源码可见）；这比以往只看 aggregate pass 好。但仍需：

- 独立冻结 `oracle.json`，模型/publisher 不得读取答案；
- 相同 target head SHA、SpecGuard SHA、模型版本、token budget、seed 或多次重复、相同 prompt/config；
- **Clean PR** 与已有替代测试的负样本必须与正种子一起回归；
- raw TP、verified TP、delivered actionable TP 分开；FP 需要人工语义裁决，而不是只按行号近邻；
- 计算 `precision`、`delivered recall`、`FP / 100 PR`、`unknown rate`、`median/P95 runtime` 和支出；
- 不以同一代码改动的多个变体冒充多个独立业务场景，按原始 PR/行为聚类置信区间；
- CI 绿只作 protocol regression gate，**prod readiness** 单列 model-quality gate。

**新增重要约束：** 任何修 publisher gate 的 PR，必须提供新增 **TP lost / FP removed / Unknown changed** 三列，不接受“弱告警减少 40%”作为唯一成功标准。

### P1-F：Windows smoke、跨仓库权限与 artifact 隔离

#344 Windows `bashPath` 的测试是传参 mock：能验证路径推导，却不能证明独立 runner 上安装模式覆盖（Git Bash、WSL PATH、MSYS、带空格路径）。在 Windows 工作机上最好追加最小 Git checkout + real `collect.sh` smoke；CI 可用 `windows-latest` 只跑边界子集。

对于跨仓库 PR/全仓使用，GitHub Action 可能把源码、文档和测试片段打包给外部模型；在企业用户视角，必须明确权限边界、允许输出哪些路径、artifact retention/读权限、禁用读取 secrets 或密钥文件的策略。当前 pack 有 path realpath 限制与 `.env`/keys 避免读取，这些是优点；但**“路径不是 `.env`”不代表文件内容没有机密**。建议允许组织配置 deny globs 与数据域，并提供 preflight privacy manifest（只显示路径和类别，不记录秘密内容）。

部分 Kite 真实工作流会上传整份 `.specguard-ctx` 的 artifact；在公开测试仓库中尚可接受，但企业目标 repo 要限制谁能下载、留存多久、是否包含未脱敏的源码片段。手动工作流已有 named results artifact 控制，优先推广其最小化思想。

### P2-G：维护性、性能与 scope UX

- 核心 `post.js`、`audit-post.js` 与大型测试文件承担较多职责，建议**围绕稳定 schema** 分离 provenance、evidence gates、render、state、artifact writer，而非盲目重写整个模块。
- 避免 `claude-api.js` 的 slice 模拟和 `audit-units.js` 的定价策略逻辑漂移：导出统一 `estimatePack(unit,tests)` 并给出 `estimated/actual bytes` 对账；关键行为必须一致。
- 用更细的 `review_paths / evidence_paths / requirement_paths` UI 标签解释 `scan_paths` 的真实 scope；避免使用者以为仅扫描目录内的 tests/docs。
- 强化局部/外部依赖环境版本矩阵：Node 22、Git for Windows、GitHub API 速率限制、fork PR 的只读权限、token 失效、工作流取消与并发。

---

## 4. “正优化”的最低实验要求：建议固定评测合同

### 4.1 固定任务集

**Set A — 确定性协议（每次 PR 必跑，低成本）：** 目录锚定、边界文件路径、恶意指令文本与 quote、call-part attribution、未知 usage、repair、截断完整性、dedup、output size、执行状态、fallback、Windows 环境。

**Set B — 有 oracle 的模型能力：** 至少 5 类缺口：删除测试、弱化断言、删除边界、需求/代码漂移、测试层级推下；各类都必须有 clean PR、间接测试仍存在、无关 sibling assertion 等负样本。跨 Nest/Hono/Fastify/Flask/Cobra/Kite，配合小型 fixture 快速跑；对于模型有波动的案例，每个版本同模型重复多次，报告分布。

**Set C — 真正交付：** 真实开发者 PR，抽样无报警 PR 作独立 FN 审查；记录作者认为有效/无效的原因、是否真正增加测试、测试能否在修复前失败、是否减少返工、造成的 review 延时。

### 4.2 指标与定义（推荐）

| 指标 | 公式/判定 | 为什么需要 |
|---|---|---|
| Raw defect recall | oracle 正例中被生成候选的比率 | 分离模型检出 |
| Delivered actionable recall | oracle 正例中被可行动送达且语义正确的比率（含执行失败损失） | 用户实际保护 |
| Actionable precision | 经独立标注有效的可行动发现 / 全部可行动发现 | 管控误报负担 |
| TP lost from gate | 变更前可行动的有效 finding 变为不可行动的数 | 防止 #345 式退化 |
| FP removed by gate | 原先可行动的无效 finding 被压制的数 | 证明 gate 净价值 |
| Decision abstention | UNKNOWN / eligible obligations | 防止以拒判美化 accuracy |
| Evidence completeness | 完整装载代码+必要 tests+要求的单元 / eligible | 与模型能力隔离 |
| Verified fix-through | valid findings 中，补充测试确证修复的比例 | 衡量 Shift Left |
| Cost/latency | 每次 run USD、tokens、wall time 中位/P95、失败率 | ROI 和规模 |

不得将 `pass rate` 当 precision；不得将“被触碰代码”当 verified fix；不得将 `precision × acted_on_rate` 当作联合有效修复率。对于分母为 0/标签未知的情况，明确输出 N/A 与样本量。

### 4.3 预注册 PR 质量门槛（可调整的候选值）

下面是**建议下一批实验的工程门槛**，不是声称 SpecGuard 已达到的成绩：

- Protocol Regression：全部确定性 CI 与负样本通过；不得出现不明来源高置信发现、越界引用、未读全证据仍称 complete。
- Gate 变更：任何高风险正例 TP loss 一律需解释；在小型 frozen oracle 上默认 `TP lost = 0`，且 `FP removed > 0`，才能自动合并。若存在价值权衡，要求明确产品决策。
- 检索：同样候选预算下 Hit@3、All-required@3、正确的测试路径/调用链 recall **不可显著下降**，记录新增 FP 与扫描成本。
- 真实采用：继续沿用现有 `docs/validation-plan.md` 的预注册阈值（例如 precision ≥65%、已验证修复的门槛等），但先统一 exposure cohort、成熟窗口和标注标准，不得拿旧定义的成绩直接对比新定义。

### 4.4 确认优化为净正的判定流程

```text
锁定 target/tool SHA、oracle、模型、预算与配置
→ 基线运行，保存 raw/verified/delivered/ledger
→ 只替换一个变更版本
→ 同样的任务配对运行
→ 对 delta findings 做 blind annotation
→ 看 TP gained / TP lost / FP removed / FP added
→ 审完整性、花费、时延、失败率
→ 达成预注册门槛才 merge；否则 revert 或降低功能曝光
```

保证“相同条件”还应考虑分支 seed 与模型不确定性；同一场景 3 次重跑不是 3 个独立业务样本。

---

## 5. 推荐的开发路线（直接可拆成 Issues/PR）

### P0（立即，合并前）

**P0-1 审查 #345 的 `pinnedInTest`，不直接自动合并。**

- 修改：仅针对同 subject + 同输入行为的 pinned 证据降级；无充分关联时提示而不压制。
- 测试：授权/指标两个字段不相关；独立调用不同参数；嵌套 `it`/`describe`；`/^.*$/`、`/^Deno!(\\r?\\n)?$/`、Python/Go assertion idioms；`not a gap for X but Y...`。
- KPI：至少修掉 Hono/Flask 原 FP，**0/所有 frozen 高价值种子**发生新增漏报；每项 demotion 附原因。
- 反证：如果无法可靠认定同一 subject，回退为“可能已由同测试其他断言验证”的 informational note，不要降低置信度。

**P0-2 建立“发现级 stage ledger + 误伤报告”。**

- 字段：`repoSha, toolSha, mode, caseId, obligationId, unitId, callId, partSpans, sourcePath, evidencePath, relationType, packedLines, rawFinding, gateRule, gateOutcome, deliveryChannel, oracleLabel, verifiedFix`。
- 测试：同一 finding 从原始输出到 Summary/Inline/Details 的每一步有稳定 id，异常/裁剪显式记录。
- KPI：在有 oracle 的任务集能完整对账 raw/delivered TP/FP/FN，`unknown` 有明确原因；基线与新版差异报告可自动生成。

### P1（接下来 1–2 个迭代）

**P1-1 证据图 MVP（以 JS/TS 为先）。** 从测试调用→公开 API→export/re-export→实现行为建立多跳路径，并给每条边强弱标识（解析确定/文本启发）。接受接口：输入源码和测试集合，返回 `test -> module/symbol -> behavior -> assertion` 路径及 provenance；不要求推断完全的 runtime coverage。

**P1-2 重新评估 CommonJS 新线索。** 在 Fastify、Hono、Nest、Kite 固定提交的新增 CJS leads 上盲标真实测试缺口；按“有直接测试/通过入口已覆盖/不需单独测/确有缺口/不确定”分组。若多数是假缺口，则保持信息级别并在报告区分“直接符号引用缺席”与“没有覆盖”。

**P1-3 大文件切片覆盖验证。** 测试块跨 80 行、helper 在测试外、嵌套/参数化、文件大于 cap、同测试用于多 unit、part 之间共享。验证 slice 的 `complete` 只是**语法块可见**而非“覆盖行为完整”。记录真实装载 test blocks 数及必要 evidence misses。

**P1-4 Windows 真实 smoke + API 故障注入。** Windows Git Bash/WSL/空格路径运行；GitHub 403、429、repo 缺权限、分支含 `/`、token 失效与 workflow cancel；不可默默当成 no gap。

### P2（后续 2–4 个迭代）

**P2-1 需求到行为的双向 traceability**：需求段落→实现→分支/例外→对应断言与测试层级；支持反向从 diff 定位受影响 requirement。报告必须明确：需求未找到、未解析、版本不匹配、已证实不一致等不同状态。

**P2-2 把全仓静态 leads 转为 PR 时的可行动义务。** 全仓可保留以证据为主的 informational tech-debt inventory；当 PR 变更到相关行为时，携带稳定 obligation IDs 到 PR，给出具体错误输入、可失败的 test skeleton、测试层级建议。重点在减少合并前返工，而非生成更长的周期性清单。

**P2-3 性能/成本**：对装箱和切片估计 `estimated/actual bytes`、token 与失效率做闭环；重复模块摘要按内容哈希缓存；先诊断瓶颈再改变 `max_output_tokens`、cap 或模型档次。省 token 不能以丢掉必要证据为代价。

**P2-4 试点**：同一类团队/仓库同期对照 `native code review`、`native + SpecGuard`、可选 `SpecGuard only`，同等人工投入。以独立有效发现/百 PR、已验证补测、作者干扰、等待时间作为决策，而非“我们跑过的测试总数”。

---

## 6. 验收清单（可直接贴到后续 PR 模板）

```markdown
### Claim
- [ ] 描述具体改善的行为，不只写“提高质量”
- [ ] 明确本次改动的影响边界：scan/pr/both；language/engine；publisher/collector/model

### Evidence
- [ ] 固定 old SHA、new SHA、target SHA、model、prompt、budget
- [ ] 至少一个旧版失败新版成功的正向反例
- [ ] 至少一个旧版成功新版也必须成功的负向反例
- [ ] 报 raw/delivered TP/FP/FN 与 Unknown 的 delta；没有 oracle 时明示“未测”
- [ ] 所有引用都给出文件、行、来源 call/part 和验证方式

### Safety and correctness
- [ ] 未加载到的证据不能被声称为已证实缺口/覆盖
- [ ] 任何 gate 的 TP lost 已检查并说明
- [ ] Error/timeout/budget/config failures 不能装成无报警
- [ ] 在主线 CI + 真实目标 end-to-end run 上验证

### Resources and rollout
- [ ] 成本和总时间有对比
- [ ] 告警数量减少是否因为压制有效发现已被测试
- [ ] 如果指标未达到门槛，具备 revert / feature-flag 方案
```

---

## 7. 关于“最近变好了吗”的最终判断

### 确认变好的部分

- 更不容易把本来已在某个 call 充分展示的测试误当截断（#343），避免许多无意义 unsure；
- 更不容易把没评估的文档冒充非需求、把跨 call 引用冒充本 call 证据（#335/#340/#344）；
- Scope 输入更安全可预期、repair/unknown usage 更遵守预算（#336/#342/#344）；
- 主线单元回归测试覆盖较广且目前通过；真实扫描流程可在第三方复杂仓库完整执行大批 unit calls。

### 仍未证明变好的部分

- 对真实未测行为的**语义 Recall**；
- 对真实开发者有用的可行动 Precision；
- 将高置信静态事实变成确定需要新 unit test 的结论的能力；
- 反事实条件/边界需求与组件交互对应的缺口发现能力；
- 作者是否因此写出可以先失败再通过的测试、是否缩短 PR/交付周期；
- 多种语言、大规模间接测试和企业权限情境的稳定性。

### 确定需要警惕的退化

- **#345：有确定性反例，尚未合并，不建议现状合并。**
- **#344 CommonJS：有历史同类净负经验，必须按发布价值复核新增线索。**
- **#341/#343 coverage 数字：若被营销成“已验证单测覆盖”，属解释性退化而非代码测量收益。**
- **过度 conservative gating：减少 FP 的同时可能吞掉真正 TP；需要 gate-level counterfactual 证明。**

**综合裁决：** SpecGuard 正从“LLM 会审查代码的 Action”成长为“有证据归属、范围、状态和成本协议的测试义务发现系统”；工程基础已有明显进步。但现在还不能说“它在真实开发中稳定地比原生 Review 提供更多正确且可执行的测试缺口”。下一次最有价值的优化**不是再加一种宽泛静态规则**，而是把每个发现绑定到更完整的行为证据图，并使用有真值的实验防止精确率优化伤害召回率。

---

## 8. 复核证据与局限（可审计）

**本次确实核实：**

- GitHub 默认分支为 main，HEAD=`08d2c5b`；PR #343/#344 已合并、PR #345 Open，检视了上述 PR descriptions/changes 和相关现行代码。
- [`CI 39085373622`](https://github.com/Mira190/SpecGuard/actions/runs/39085373622)：实际日志 1480、1476 pass、0 fail、3 skipped、1 TODO；test job success、dogfood skipped。
- [`PR345 CI 39084816569`](https://github.com/Mira190/SpecGuard/actions/runs/39084816569)：1478、1474 pass、0 fail、3 skipped、1 TODO；dogfood success，但 reduced-review warning。
- [`Kite 39083946253`](https://github.com/Mira190/Kite/actions/runs/39083946253)（Nest）、[`39083944276`](https://github.com/Mira190/Kite/actions/runs/39083944276)（Hono）、[`39083942363`](https://github.com/Mira190/Kite/actions/runs/39083942363)（seeded Kite）：各自 job success，审查计划 489/489、172/172、43/43 unit，publisher `STATUS: incomplete`。
- 对未合并 #345 中的 same-test/anchored-regex 逻辑，以本地 Node 22 最小测试独立重现了上述两类错误降级条件。

**来自 PR / 历史文档、未独立重跑的声称：** PR #343 五仓 forced 前后数量、调用总数与成本；Kite 最新 seed 的真实 TP；之前 Fastify #269 CJS 5/5 间接覆盖抽样；2026-10-17 40 种子、8 旧模型发现。已作为有来源的历史证据，而非今日独立测量的精确率。

**未执行事项：** 当前运行环境不能通过网络 clone GitHub 仓库，因此未在本地完整 checkout 新版并运行全部测试或新的模型 A/B；未独立提取并盲标每个最新 Action artifact 中的全部 findings；未检查企业私有 repo 的真实权限策略，也未对真实用户的修复行为做纵向观测。因此本文的结论分为“源码可证明”“Actions 可证明”“旧报告有声称”“需进一步实验”四类，不以主观高分替代未测能力。

**核心引用：**

- [仓库](https://github.com/Mira190/SpecGuard) · [#343](https://github.com/Mira190/SpecGuard/pull/343) · [#344](https://github.com/Mira190/SpecGuard/pull/344) · [#345](https://github.com/Mira190/SpecGuard/pull/345)
- [当前 `audit-post.js`](https://github.com/Mira190/SpecGuard/blob/08d2c5b/src/audit-post.js) · [当前 `test-map.js`](https://github.com/Mira190/SpecGuard/blob/08d2c5b/src/test-map.js) · [当前 `claude-api.js`](https://github.com/Mira190/SpecGuard/blob/08d2c5b/src/engines/claude-api.js)
- [历史第三方评估](https://github.com/Mira190/SpecGuard/blob/main/docs/third-party-scan-eval-2026-10-17.md) · [指标审查](https://github.com/Mira190/SpecGuard/blob/main/docs/shift-left-metrics-and-latest-review-2026-10-17.md) · [目标完成度审查](https://github.com/Mira190/SpecGuard/blob/main/docs/goal-assessment-2026-10-17.md)

*本报告为审查与实施建议，不含代码修改或 GitHub 写操作。*