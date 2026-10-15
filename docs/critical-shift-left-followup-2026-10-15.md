# SpecGuard 继续审查：修复之后的反例与跨路径不变量

日期：2026-10-15。代码冻结在 main [`d3234e34924405ebd4febd38aa2691675f0fad59`](https://github.com/Mira190/SpecGuard/commit/d3234e34924405ebd4febd38aa2691675f0fad59)，即 PR #190 合并后。本文接续[第一轮审查](critical-shift-left-review-2026-10-15.md)，保留原报告的历史基线，不把旧问题直接套到新版本。

GitHub 复查时间：2026-10-15 07:35 UTC 左右（Sydney 18:35）。只新增审查文档及入口链接，不修改产品实现，不运行付费模型，不向 GitHub 发布测试评论或测试 issue。

## 1. 本轮结论

**第一批修复确实处理了原来的具体反例，但有些修复仍然把词法相似当成语义证明；评估器也没有完整守住“一条观察只能消费一次”和“完整性状态一致”的约束。** 本轮新增六项可复现发现 F13–F18，其中 F14 是新表格识别规则带来的漏报路径，F13/F17 是修复未覆盖的边界，F15/F16 是评估可信度问题，F18 是跨仓库输出边界不一致。

原来的四个可直接重放的反例已按修复预期通过：完整表格化不再产生 removed lead，空 `test.skip` 不再 covered，正常的分类冲突保留 unknown，额外可见摘要 finding 会计为 FP 并使 clean case 失败。F08 的展示也已从 fixed 改成“后续有修改、修复未验证”。这值得确认，不能把这些已修复输入继续作为当前缺陷。

但是，**关闭一个样例与建立一个可靠规则仍有差距**：同样的最终状态应当由同样强度的证据支持；同一个边界应当在所有入口和出口成立；增加无关信息不应让真实风险消失。

## 2. 修复和线上证据的增量

| 第一轮事项 | 当前复核 | 状态 |
|---|---|---|
| F01 等价表格迁移误报 | 原合成例现在输出 `[]`；真删行控制仍在现有测试中 | 原例已修复；新的不相关表格抑制见 F14 |
| F02 空/跳过测试算 covered | 原 `test.skip` 例变为 unknown；复用 PR 的 `assertionKind` | 原例已修复；注释、导入和变量仍被接受，见 F13 |
| F03 requirement/not_requirement 冲突 | 正常来源的冲突保留 unknown，并删除 not_requirement | 原例已修复；来源字段损坏时仍丢分母，见 F17 |
| F05 摘要误报不计分 | 可见 unmatched summary 现在计 FP、使 expect_clean 失败 | 原例已修复；摘要重复匹配、完整性口径见 F15/F16 |
| F08 addressed 被称 fixed | UI 改成 `with later changes (fix not verified)` | 展示问题已修复；因果修复率仍未测量 |
| F07 上下文不完整 | main 仍是第一轮所述路径；另有未合并 PR #191 | 不能把在审 PR 当成已部署结果，见下文 |
| F04/F06/F09/F10/F11/F12 | weak_test 语义、历史失效、模型档位、issue新鲜度、标准/下推pilot、版本验收 | 本轮没有新的关闭证据，继续开放 |

[第一批修复记录](reliability-hardening-2026-10-15-batch1.md) 自报全套1056 pass、0 fail、1 skip、1 todo；本文没有重跑全套，用下文限定的测试和探针独立核对相关路径。

### GitHub 的实际进展

- **Kite 没有新运行。** 复查返回的总数仍为80；最新 PR review 仍是2026-10-14 09:46–09:47 UTC的那十个 run，最新 [scan #12](https://github.com/Mira190/Kite/actions/runs/38515926303) 仍是05:18 UTC的旧版本。不能宣称第一批修复已经通过 Kite 新一轮线上验收。
- **SpecGuard PR #190 已合并。** [最后一次 bot 摘要](https://github.com/Mira190/SpecGuard/pull/190#issuecomment-6179321352) 给出 reduced review、无高置信 gap，机器状态 `complete:false`，7个 obligations 中5个为 unit evidence。它证明 reviewer 看到了部分新增保护，不证明修复已穷尽边界；本轮残余反例均能在合并版本复现。
- **PR #191 尚未合并。** [Fix incomplete scan evidence and isolate offline engine tests](https://github.com/Mira190/SpecGuard/pull/191)，head `5cac39cb9a3d7f0ae3815f67ce3415e670383ab3`，普通 [CI](https://github.com/Mira190/SpecGuard/actions/runs/38676856532) success，读取到的 review timeline 为空。静态检查其 diff：新增窗口截断/读失败记录、matched tests 不完整时保留 unit due、split document 的 `blockCuts` 传播，以及隔离离线测试中的 npm 安装。它正确缩小了 F07 的范围，也明确没有实现大文件进度游标、single-call 完整性协议或真实模型验证。本文未 checkout、运行或批准该 PR，以下代码级复现均针对已合并的 main。

PR #190 的 obligation 表还有一个值得追踪的产品问题：O4要求私有 `esc` helper 有“直接断言”，O7也围绕本地 `tidy` helper 的直接测试，而输出自己承认存在间接覆盖或上下文不足。它们没有被发成 high finding，因此不计为新的误报；但把这种实现细节加入“5/7”分母，会让覆盖比例受代码拆分方式影响。目标应是保护可观察行为，不是要求每个私有 helper 都有直接测试。应以“内联↔提取等价 helper”的变换验证 obligation 数量和风险结论是否稳定。

## 3. 必须优先处理

以下 P1 表示扩大采用或把报告用于质量决策前应解决；P2 是有明确复现、但影响范围较窄的可靠性问题。没有将本地模拟解释为真实泄露或真实生产事故。

### F13 · P1 · 变量、注释和导入仍被认作有效断言

**发生了什么：** scan 新增的证据校验调用 [post.assertionKind](../src/post.js#L140)，使用 [ASSERTION 正则](../src/post.js#L137)。这个正则允许 `Expect*`/`Assert*` 等单词，不要求它们是断言调用，也不排除注释或 import/require 声明。[audit-post](../src/audit-post.js#L230) 因此仍可把“真实存在的无效引用”保留为 covered。

**复现：** 将测试文件的唯一内容分别设为以下任意一行，给 scan 一个指向该行的 unit citation，同时提供有效需求和代码引用。三个例子都得到 `assertionKind=assertion`、`status=covered`：

```js
const expectedTotal = 42;
// assert.equal(total, 42);
const assert = require('node:assert/strict');
```

这些文件没有保护目标行为的可执行断言，甚至没有测试。它不是对未知框架的苛求，而是最常见 JS 词法结构的假阳性。共享 verifier 使这个问题同时影响 PR 与 scan 的正向证据判断；本轮直接验证了 scan，PR 的调用点见 [verifyEvidence](../src/post.js#L957)。

**最小修正：** 让“可识别的断言调用”与“含相关单词的文本”分开，先排除注释、导入、仅赋值等确定无效情况；无法判断的 helper 保持 unknown，不升级 covered。复用共享入口是对的，但需要把共同规则修正，而不是两个模式分别加例外。

**不修的代价与验收：** 开发者会得到不存在的保护。上述三例必须 unknown；真实 `assert.equal`、真实 predicate assertion、支持的非JS断言仍能保留正确证据。静态识别通过仍不意味着 CI 实际执行。

### F14 · P1 · 新表格规则没有关联数据与断言，无关数据能抹掉真实线索

**发生了什么：** [assertionDelta](../src/leads.js#L236) 只要求“有一个新增断言调用同名函数”和“任意新增行包含旧字面量序列”。它不要求那一行被该断言消费。因此为减少原误报添加的启发式，会压掉真实删除。

**复现：** 下面的改动确实移除了 `next(2)` 的保护。`otherCases` 没有被使用，新的断言只检查10。当前 `assertionDelta` 却返回 `[]`：

```diff
-assert.equal(next(2), 3);
+const otherCases = [[2, 3]];
+assert.equal(next(10), 11);
```

这里确认的是**确定性 lead 被错误删除**，不是声称模型一定漏报：模型仍可能独立发现问题，但丢失了原本应帮助它的线索。第一轮问题的根因——把词法差异/相似度当成行为覆盖结论——并未消失。

**最小修正：** 无法证明数据确实属于相关循环/断言时，保留“待核查的删除线索”；同时取消从不确定 lead 自动生成 high finding 的强推断。若保留精确迁移识别，只对能建立局部数据关联的形态抑制，不再用全文件共现兜底。无需为此构建全语言数据流分析器。

**不修的代价与验收：** 为消除误报而引入静默漏报。完整迁移应安静；删一行应保留线索；额外加入无关数组、别的测试fixture或死代码，不得改变后一结论。

### F15 · P1 · 一条摘要发现可以重复计为两个 TP

**发生了什么：** [grade.js](../eval/grade.js#L109) 用 `summaryHits.some(...)` 判命中，再通过 `usedItems` 避免该条被算 FP；但下一条 expectation 的命中判断仍能使用同一个 item。行内评论已有一对一消费逻辑，摘要路径没有。

**复现：** 两个 expected findings 分别指向 `a.js:10` 的boundary A和 `a.js:30` 的boundary B，均允许 summary。实际只有一条 `a.js:900` 的无关 missing_test。当前结果为：

```text
observed actionable items = 1
tp = 2, fp = 0, fn = 0, pass = true
```

摘要宽松匹配 kind/path 是已写明的规则；本发现并非只抱怨容差宽，而是**同一个观测被重复消费**，且摘要路径跳过期望的行为文本检查。合成例表明分数可以超出证据数量；没有据此反推历史评测已被多算多少。

**最小修正：** 将摘要item/coverage row也变成有稳定身份、只能消费一次的候选，与行内结果共享匹配规则。保留 LEFT-side 位置容差需要，但若 fixture 指定行为文本/来源，应照常验证。不能通过把全部匹配改得更宽来避免FP。

**不修的代价与验收：** 漏掉第二个边界仍拿到全中，误导 prompt/模型选择。加入两期望一结果、同kind同文件但不同语义、摘要与行内重复呈现的控制；TP数量不能超过可独立对应的观测数。

### F18 · P1 · 跨仓库 scan issue 没有执行已有的可见性边界

**发生了什么：** 手动 workflow 的 [visibility guard](../.github/workflows/specguard-run.yml#L81) 会拦截非公开目标输出到公开 control；但 composite action 直接提供 [`scan_issue_repo` 和 `scan_issue_token`](../action.yml#L43)。[audit-post](../src/audit-post.js#L620) 解析目标后便查找/创建issue，在 [publish](../src/audit-post.js#L643) 前没有检查源/目标可见性。仓库唯一生产调用 `visibility-guard.js` 的地方是上述手动 workflow，直接调用 action 不经过它。

**复现：** 使用临时、实际被 Git 跟踪的合成需求/源码和真实 `audit-post`，把上下文设为 `org/private-source`、`ISSUE_REPO=org/public-reports`。两个 GitHub client 均为本地 mock，其 metadata接口可返回 private/public；发布API只记录参数。实际结果：

```text
destination = org/public-reports
body contains source requirement text = true
repository visibility queries = 0
status = complete
real network calls / real issues created = 0 / 0
```

**影响条件：** 部署者显式配置跨仓库目的地，并提供能在那里写issue的凭据。这不是低权限用户绕过GitHub授权，也没有发现真实数据泄露；风险是一个受支持配置绕过了另一入口已经实施的输出保护。拥有写权限不意味着输出读者与源仓库读者相同。

**最小修正：** 将受众检查落实到公共发布边界或所有action入口，对实际源和实际issue目的地检查并在未知时拒绝跨边界发布；复用现有决策函数。保留合法的同仓库/同受众发布。private与internal的细粒度成员权限仍需单独规定，visibility检查不能证明ACL完全一致。

**不修的代价与验收：** 错配目的地可能把非公开需求/代码片段写入更广受众的issue。用fake clients验证 private→public 不写、metadata不可读不写，以及合法发布仍成功；不要用真实私有源码做这个canary。

## 4. 应修复的剩余边界

### F16 · P2 · 运行完整性在 producer 和 grader 之间丢失

**发生了什么：** [parseSummary](../eval/grade.js#L74) 依赖几个旧英文短语识别 incomplete，未读取已有 `specguard:status=incomplete` 或 counts.complete。最后 [grade](../eval/grade.js#L148) 因此可把生产方明确标注不完整的报告叫作 complete。

**复现：** 本次读取的 PR #190 最终摘要含 `complete:false` 和 incomplete marker。把其原文作为 observation，并使用 `expect_clean:true` 的合成state-check case，得到 `machineIncomplete=true, gradeComplete=true, gradePass=true, degraded=true`。这不是声称 PR #190 实际拥有该fixture；是对真实输出和真实解析器的契约检查。纯合成最小marker例同样复现。

**最小修正：** 先消费已有机器状态，再对老报告兼容文本解析；如果“执行是否完成”和“质量是否降低”需要不同口径，显式拆字段。不要强行把所有 fast model 都判为失败，也不要把相互矛盾的 complete 当作同一指标。

**不修的代价与验收：** 生产侧不计入outcomes的运行，评估侧却可进入完整通过样本，导致比较与趋势口径错位。对于每个合法生产状态，用真实render输出验证grader读取结果，避免对手写摘要做自洽测试。

### F17 · P2 · 分类冲突遇到损坏的 source，义务仍能从分母消失

**发生了什么：** [validate](../src/audit-post.js#L111) 已识别 conflict，但 `conflicts.add(cid)` 在来源字段验证之后。如果 source缺失/损坏，该row提前drop，not_requirement仍保留；后续verify把这个cid视为已排除，不补unknown。

**复现：** 两个listed blocks各有一个requirement；第一个同时在not_requirements，且 `source=null`，第二个有效。因坏row只占一半，整体validate成功。verify结果只保留第二个requirement，第一个仍在not_requirements。原正常source冲突控制则确实得到unknown。

**最小修正：** 在row可能提前drop之前登记分类冲突；使用可信candidate恢复最小unknown记录，或让verify为已冲突但无法验证的block补unknown。模型无法提供合格引用时，不能由此获得删除义务的权力。

**不修的代价与验收：** 结构退化与语义冲突一组合，分母又缩小。添加source缺失、非法行号、重复/分裂子行的成对控制；原子义务始终处于reviewed、unknown或明确未审查之一，不能因冲突成为非需求。

## 5. 第一性原理上的共同根因

这轮最重要的不是增加六条启发式，而是区分三种不同职责：

| 职责 | 合适的手段 | 不能越过的边界 |
|---|---|---|
| 搜索候选 | 函数名、文本、字面量、位置、相似性 | 候选命中不构成covered；候选缺失不证明无测试 |
| 裁决结论 | 可观察行为、输入→预期、测试是否实际约束该行为 | 无关数据不能充当迁移证明；不确定不应升级为high |
| 评价价值 | 一对一的语义匹配、真实运行状态、人工有效性和修复结果 | 一个输出不能同时充当多个独立命中；代理不能改名为因果收益 |

F13是搜索正则越权成为正向证明；F14是同现关系越权成为替代证明；F15是宽松检索越权成为多个命中；F17是结构失败越权变成排除义务；F18是入口保护被误当成所有出口都已保护。它们都可以发生在JSON合法、引用存在、测试套件全绿的情况下。

因此，shift left 的下一步应先保证**报告不会制造虚假保护、评估不会奖励错误判断、输出不会跨越未核验的受众边界**。这比继续增加发现类别更接近用户的实际目标。

## 6. 下一组验收应围绕不变量

| 不变量 | 至少需要的对照 | 对应问题 |
|---|---|---|
| 名字/注释不创造测试保护 | expected变量、assert导入、注释；真实断言正例 | F13 |
| 加入无关数据不删除真实风险 | 无关数组、未消费fixture；真实完整迁移与真实漏行 | F14 |
| 一个观测最多匹配一个独立目标 | 同文件双边界，单item；多item；跨投递方式去重 | F15 |
| 同一状态跨组件含义一致 | producer的complete/incomplete/failed/skipped/reduced输出逐一送grader | F16 |
| 信息损坏只能降低把握，不能提高覆盖或缩小义务集 | 分类冲突叠加坏citation、遗漏与部分输出 | F17 |
| 所有输出口保留授权受众边界 | manual/direct action、同repo/跨repo、create/update、metadata未知 | F18 |
| 代码组织不改变行为覆盖分母 | private helper提取/内联、函数改名，行为与测试不变 | PR #190 obligation观察 |

建议顺序：先修F18发布边界及F13虚假covered；同步修F14、F15以避免一边去噪一边奖励漏报；再修F16/F17。复跑原反例和相邻反向控制，之后才用固定SHA跑Kite canary。PR #191的F07改进可以独立评审推进，但不能替代上述语义与评分修复。

第一轮关于真人采用率、有效修复、标准确认、真实pushdown收益和QA缺陷下降的结论仍成立：本轮没有新增这些目标已完成的证据。

## 7. 验证记录与限制

- 隔离工作树，冻结 `d3234e3`；保留用户主工作区和既有未提交文件。
- 环境：Windows / Node `v26.11.1`；仓库CI目标仍是Ubuntu/Node22。
- 原F01/F02/F03/F05的四个修复控制均通过；F08措辞由diff与已有回归确认。
- F13三个非断言引用均得到covered；F14无关表格令lead消失；F15单item得到两个TP；F16合成marker与PR #190原文均出现状态不一致；F17损坏来源的冲突仍被排除；F18在有真实tracked files的本地fixture中记录到未检查visibility的跨repo发布。
- 运行 `node --test --test-concurrency=3 src/audit-post.test.js src/leads.test.js eval/grade.test.js`：**103 tests，102 pass，0 fail，1 skip，约19.2秒**。这证明现有测试通过，也说明新增反例没有被这些测试覆盖；不代表全套回归或模型质量验收。
- 只读取线上GitHub数据；mock没有发送网络请求。未新跑Kite/付费模型，未运行PR #191，也未评估真人采纳或生产缺陷率。

**判断：继续advisory有价值，但下一次“修复完成”应以跨路径不变量及正反对照为准，不能仅以原用例变绿、bot没有再评论或CI成功为准。**
