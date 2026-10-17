# 新修复后的 unknown unknown 复核

> **处置状态（2026-10-17，main 45713a2）：** 本文发现已复核。已修复：U1–U4（#224）、U5（#226）、U6（#225）。未修复/待办：无。配套探针脚本与源码 manifest 暂未提交（待所有者复核）。行号与 SHA 以本文写作时为准。

What this repo does: SpecGuard 将 PR/仓库的需求、代码、测试与证据关联起来，在合并前暴露缺口。它还用评测与周报判断这些发现是否有价值。本轮假设正常负载是一个 PR 或多段仓库扫描，没有用生产吞吐数据做容量判断。

**结论：确认 2 项 P1 边界缺陷、3 项 P2 取证语义差异，另发现 1 项需要明确的评测口径。最值得先修的是 DENY 内容经 trace 重新进入 prompt，以及部分扫描成功后额度耗尽仍绕过新门禁。**

这是在新修复上继续寻找交互问题，不把上一轮已经修复的缺陷重新计入。没有修改产品代码、合并、推送、删除分支或调用真实模型。

## 基线：同时检查本地、远程和未提交内容

日期为悉尼 2026-10-17；本轮远程记录与探针固定在以下版本，具体时间见配套 JSON。

| 层次 | 本轮使用版本 | 核查方式 |
|---|---|---|
| 最终远程整合 main | `8415eae217a5c4eed3c1d46ccf9294b127fc97d2` | 22:50 UTC 复查；#223 已在 22:39:36 UTC 合入，六组探针均按最终版本复跑 |
| 初始 main / 本地缓存 | `fd8c62b877ecbc74ff704425cdd7593bbb68c28c` | 初始远程与 origin/main 一致；不是收尾时的最新远程 |
| #223 修复 head | `84475bad28af4f452f70ab4bbc779851cc36c094` | 本地 fix/deny-secret-diff 与远程 PR head 一致，worktree 无改动；最终已合入 |
| 本地独有提交 | 全部本地 refs 与 main 可达性比较 | 236 个分支，排除 eval 后逐项识别 8 个未进入 main 的分支头 |
| 未提交内容 | 65 个注册 worktree | 17 个有状态变化、5 个读取失败；新一轮 5 个 fix worktree 均无未提交改动 |

“哪个最新”不能只看提交时间：初始 main 是整合版本，#223 当时是另一条尚未合入的修复线，并不包含 main 的全部修复。收尾时再次读取远程，确认 #223 已合入后，将六组探针统一切到最终 main；问题在包含这些新修复的整合版本中仍存在。

主目录仍在旧 `b1aaf11`，其 README/研究文档未提交；没有在这里直接 require 旧 src 作为新版本证据。初始探针通过 git show 加载指定提交；最终 merge 对象本地尚无，则读取远程完整 tree（548 个 blob、未截断），按 blob SHA 加载本地对象。唯一缺少的合并版 claude-api.js 从 GitHub 读取并缓存，加载时校验 Git blob SHA；没有为此修改 Git 数据或 checkout。

初始本地快照中，相对 fd8c62b 尚未进入 main 的非 eval 分支：codex/shift-left-rereview-2026-10-16、fix/deny-secret-diff、fix/rereview-batch1、fix/scan-part-size、fix/scan-state-address、gates/evidence、test/ccr-seeded、test/seeded-gaps-v7。最终 #223 已合入，deny-secret-diff 不再属于待合入功能；本地快照保留原时间和比较 SHA。旧 batch/state 的提交也读取比较过；有独有提交不代表仍有独有功能，不能因此整支回合。

本地 structured-reduced-reasons、eval-metric-integrity、scan-issue-foreign-target 的提交已进入 main 历史，原来的两组 WIP 已变成修复提交。本轮没有在可读的新 fix worktree 中发现更新的未提交实现；5 个读取失败目录不能据此断言没有本地新工作。

### 已修复项，明确从当前问题清单移除

| 新 PR | 当前状态与证据 | 本轮继续查什么 |
|---|---|---|
| #218 | 已合入；cap/time 分开 | 聚合状态是否也保留原因 |
| #219 | 已合入；row-only FP、weekly 复用 post 的规则 | 适配器是否真的保留 Git 的全部语义 |
| #220 | 已合入；foreign issue、大小写处理 | 本轮不重复报告原始跨目标匹配问题 |
| #221 | 已合入；结构化 degraded，真实 guard 控制 | 降级数据在展示、评测之间是否一致 |
| #222 | 已合入；配置失败门禁与错误分类 | 部分成功的多段扫描是否仍能传播配置失败 |
| #223 | 初始开放，收尾已合入；过滤 changed-file diff | 其他文本入口是否仍能重新引入 DENY 内容 |

最新 [#222 dogfood](https://github.com/Mira190/SpecGuard/actions/runs/38976247001/job/117226277852) 和 [#223 dogfood](https://github.com/Mira190/SpecGuard/actions/runs/38976743598/job/117227890968) 已进入 reduced review；新 PR 机器人摘要有 model/counts 标记。上一份报告的“19 个 PR 最新摘要认证失败”是旧快照，**不能再当作这轮新运行的现状**。但 reduced、execution_complete、完整证据支持仍要分开看。

## Must fix

### 1. [P1] DENY 文件被排除后，内容仍能经需求索引进入 prompt（U5）

- **What this is：**#223 在生成 diff 前过滤 secret-like 路径，防止直接把 `.env` 等文件的 diff 发给模型；但 trace 是后续独立的语料入口。
- **Problem：**对 DENY 匹配的 `.env.production.md`，当它被 requirements_paths 显式纳入时，真实 trace.run 仍生成 spec-files 和 requirements-index，真实 prompt.assemble 中再次出现合成内容。changed-file 列表的过滤没有成为所有输入的共同边界。
- **Fix：**将 DENY 谓词放到无引擎依赖的共享位置，trace 的文档发现/语料生成同样应用；对 indices、candidates、scan blocks 等预组装文本逐一确认来源边界。不要只在 packRead 或最终文件列表上补过滤。
- **If we skip it：**用户看到“secret-like 文件未发送”，但模型输入仍可能含该路径派生的文字；直接 diff 已变安全也不能证明整体输入安全。

定位：[collect.sh:108](https://github.com/Mira190/SpecGuard/blob/8415eae217a5c4eed3c1d46ccf9294b127fc97d2/src/collect.sh#L108)、[trace.js:611](https://github.com/Mira190/SpecGuard/blob/8415eae217a5c4eed3c1d46ccf9294b127fc97d2/src/trace.js#L611)、[trace.js:1027](https://github.com/Mira190/SpecGuard/blob/8415eae217a5c4eed3c1d46ccf9294b127fc97d2/src/trace.js#L1027)、[prompt.js:119](https://github.com/Mira190/SpecGuard/blob/8415eae217a5c4eed3c1d46ccf9294b127fc97d2/src/prompt.js#L119)。

复现结果：DENY.test(path)=true；ctx 已有 denied.txt，files.txt 只有 app.js，trace 仍将该文档列入 spec-files；index 与最终 prompt 都含 `SYNTHETIC_NOT_A_REAL_SECRET_U5`。控制组用显式排除该路径后，两者均不含标记。

证据范围：使用真实 trace 与 prompt，Git 对象来自合成 fixture；不是完整 collect.sh 端到端运行，也没有向 provider 发送。它证实了 trace 不消费 DENY 边界的旁路，不代表观察到了真实秘密外泄。把秘密重命名为普通文件的内容检测是 #223 review 已承认的另一项限制，本条不与它混淆。

### 2. [P1] 多段扫描“先成功、后无额度”绕过 #222 的配置失败门禁（U6）

- **What this is：**扫描分多个 API 调用，成功部分应保留；#222 的契约是 auth/quota/model 等配置错误必须可见地让 job 失败。
- **Problem：**真实流程中第一段返回可用结果，第二段返回 402 billing_error 后，adapter 把总引擎结束为 success，只在 scan-parts 中留文字原因；audit-post 输出 incomplete，新 gate 退出 0，甚至 FAIL_ON_ERROR=true 也退出 0。
- **Fix：**保留成功 findings，同时将每段的机器错误类别传播到终态，让配置失败决定 job 健康。普通范围不完整、fast-tier、预算主动停止和 transient 失败仍按各自策略处理，不要把所有 incomplete 都判红。
- **If we skip it：**账户在扫描途中耗尽额度时，管理员仍只看到绿色 workflow；相同配置问题会持续影响后续轮转，重现新门禁本来要消除的现象。

定位：[claude-api.js:425](https://github.com/Mira190/SpecGuard/blob/8415eae217a5c4eed3c1d46ccf9294b127fc97d2/src/engines/claude-api.js#L425)、[claude-api.js:442](https://github.com/Mira190/SpecGuard/blob/8415eae217a5c4eed3c1d46ccf9294b127fc97d2/src/engines/claude-api.js#L442)、[audit-post.js:813](https://github.com/Mira190/SpecGuard/blob/8415eae217a5c4eed3c1d46ccf9294b127fc97d2/src/audit-post.js#L813)、[fail-on-error.js:13](https://github.com/Mira190/SpecGuard/blob/8415eae217a5c4eed3c1d46ccf9294b127fc97d2/src/fail-on-error.js#L13)。

本条经过真实 scan-parts planner → API adapter → audit-post → fail-on-error；仅 fetch 响应为合成数据。两次调用分别为 200/402，产物保留第一段，第二段列为 not audited，status=incomplete，engine-error 不存在，gate=0。控制组 STATUS=failed 且 engine-error=quota 时 gate=1，说明 #222 的整体失败路径有效，缺的是聚合传播。

## Should fix

### 3. [P2] API 缺少 patch 时，“不知道是否改过”被算成“没有改”（U1）

- **What this is：**#219 用 apiGit 适配器调用真实 post.anchorTouched，周报据此判断一个发现是否已处理。
- **Problem：**API 文件对象显示 modified、但没有 patch 时，unified0(undefined) 变成空字符串，anchorTouched=false。真实含义应是缺少足够取证数据；在人已 resolve 的线程上，这可能把 not_observed 错算成 dismissed。
- **Fix：**对需要 patch 却没有 patch 的目标文件返回 unknown，不把空结果当有效的“未改”。检查 commit 文件列表是否完整，未覆盖的范围同样保留 unknown。
- **If we skip it：**周报的 addressed/dismissed 分母和产品价值判断会被取证缺口影响，且 API 请求成功的外观会掩盖它。

定位：[weekly-report.js:54](https://github.com/Mira190/SpecGuard/blob/8415eae217a5c4eed3c1d46ccf9294b127fc97d2/eval/weekly-report.js#L54)。合成 modified 对象无 patch → false；同一对象补上第 7 行真实替换 patch → true。本条未声称已在某个线上 PR 观察到缺失 patch。

### 4. [P2] 测试文件重命名成普通文件时，weekly 漏掉测试变更（U2）

- **What this is：**post.testsChanged 的 Git 命令使用 --no-renames；从测试文件移出/改名也应计入测试发生变化。
- **Problem：**apiGit 的 name-only 分支只返回 filename。对 `{filename:'app.js', previous_filename:'app.test.js', status:'renamed'}`，它返回 tests_changed=false；旧测试路径丢失，和真实调用契约不一致。
- **Fix：**name-only 适配同样反映 --no-renames，保留 renamed 对象的新旧路径，并测试两个方向的改名。不要只修 anchor 的 renamed-away 分支。
- **If we skip it：**相同开发者操作在 SpecGuard 与 Copilot 周报中可能产生不同的“是否处理过”判断，影响对照结果。

定位：[weekly-report.js:51](https://github.com/Mira190/SpecGuard/blob/8415eae217a5c4eed3c1d46ccf9294b127fc97d2/eval/weekly-report.js#L51)。控制组直接修改 app.test.js 能识别为 true。#219 review 关于 renamed-away anchor 返回 null 的说明是正确的，本条指出的是不同的 name-only/test 分支，不将该已有正确行为误报为缺陷。

### 5. [P2] 只改变空格，也会被 weekly 算成改了被指出的代码（U3）

- **What this is：**post.anchorTouched 的真实 Git 命令带 -w，避免把纯空白格式变化算成修复。
- **Problem：**apiGit 收到 -w 却忽略它，直接把 API patch 转为 hunks。`return value;` → `return  value;` 使 anchor_touched=true；独立真实 git diff -w 对该变化输出为空、退出 0。
- **Fix：**在适配器中保留忽略空白的契约；只在能证明原范围发生非空白变化时标记 touched，无法可靠换算时返回 unknown。不要只验证 U3/U0 hunk 头一致就称规则完全等价。
- **If we skip it：**纯格式提交也能提高表面的 addressed 比例，产品价值评估被高估。

定位：[weekly-report.js:55](https://github.com/Mira190/SpecGuard/blob/8415eae217a5c4eed3c1d46ccf9294b127fc97d2/eval/weekly-report.js#L55)。非空白替换控制仍返回 true。本条与 3、4 都属于适配器丢失语义，适合一个小 PR 一起处理，而不是新增第二套 outcome 规则。

### 6. [P2，口径待明确] 隐藏低置信度副本，会让相同 coverage 行从 FP=1 变成 FP=0（U4）

- **What this is：**#219/S10 开始把错误的 weak/missing coverage 行计为 FP，并用于 expect_clean；低置信度 findings 则有意不算需要用户行动的项。
- **Problem：**真实 buildSummary 产生同一个 missing_test coverage 行，并在 Details 添加低置信度副本后，真实 grade 给出 fp=0、clean_ok=true、pass=true；仅保留该行时是 fp=1、clean_ok=false。分组代表项选中了不参与 actionable 计数的隐藏 item，rowFps 又跳过非代表行。
- **Fix：**先固定统计契约：若 coverage 行本身仍是行动请求，隐藏镜像不得取消 FP；若低置信度应让该行整体免计，显式携带这一状态并一致处理 row-only 情形。用这组真实 producer/consumer 对照固定契约。
- **If we skip it：**展示方式变化即可改善 expect_clean/FP，难以分辨是模型变好了，还是同一请求换了渲染方式。

定位：[grade.js:49](https://github.com/Mira190/SpecGuard/blob/8415eae217a5c4eed3c1d46ccf9294b127fc97d2/eval/grade.js#L49)、[grade.js:99](https://github.com/Mira190/SpecGuard/blob/8415eae217a5c4eed3c1d46ccf9294b127fc97d2/eval/grade.js#L99)、[grade.js:136](https://github.com/Mira190/SpecGuard/blob/8415eae217a5c4eed3c1d46ccf9294b127fc97d2/eval/grade.js#L136)。

这里确认的是计数依赖展示的行为，**不把“所有低置信度都应计 FP”当成已经确定的产品要求**。#219 review 已承认相近位置去重可能低估 FP；本条是另一条隐藏 item 与 row 代表项交互，需要单独明确，而非要求推翻全部去重规则。

## 为什么这些问题容易躲过单项修复

| 修复后的局部正确性 | 仍丢失的跨阶段信息 | 本轮探针 |
|---|---|---|
| 文件列表已经 DENY | 同一路径生成的索引/候选文字还有独立入口 | U5 |
| 整体 failed/config 会变红 | 部分成功把后续配置错误聚合掉了 | U6 |
| 重用 post 的判断函数 | API 适配器没有完整保留缺失数据、rename、-w 语义 | U1/U2/U3 |
| row-only 已计 FP、镜像已去重 | 隐藏低置信度代表项和 actionable 集合的交互 | U4 |

关键不是不断增加函数级测试，而是在阶段交界处固定几条不变量：拒绝的来源不能从另一路重入；部分成功不能擦掉运行健康错误；未知不能变成 false；同一语义不随传输和展示形式改变。

## 下一轮最值得做的验证

1. **输入来源矩阵：**changed diff、未修改需求文档、spec index、trace candidates、scan blocks、候选测试、规则文件分别使用同一合成标记，测试 DENY 和正常路径；优先完成 U5 的真实 collect.sh 集成回归。
2. **多段失败矩阵：**第一段/中间段/最后一段 × auth/quota/model/rate/timeout；分别断言有效结果保留、错误类别、not audited 范围、job 终态。不要把 fast-tier 的 reduced review 当配置失败。
3. **周报与真实 Git 对照：**同一变化分别经本地 Git 和 API 对象计算；包括空白、重命名、缺 patch、不可用 compare、删除、merge commit。断言值和 unknown 都一致。
4. **producer/consumer 评测：**buildSummary 的真实输出再交给 grade；相同语义在 row-only、inline、visible item、Details mirror 中的统计口径应可解释，已知去重容忍度要单列。
5. **真实模型质量：**认证恢复后，对 seeded 与真实 PR 分开标注 precision/recall。新的绿色 CI 与 reduced review 是运行证据，不能替代已知 k2 TODO 的解决或真实召回评测。

这些是建议的下一轮验证，不声称本轮已经完成整个矩阵。

## 可重放证据与验证范围

- [探针脚本](C:/Files/Projects/SpecGuard/docs/review-probes/unknown-unknown-2026-10-17.cjs)：在仓库根运行 `node docs/review-probes/unknown-unknown-2026-10-17.cjs`；加载本地 Git blob 与配套远程 tree/合并源码缓存，重放不联网。
- [最终源码 manifest](C:/Files/Projects/SpecGuard/docs/review-probes/latest-source-manifest-2026-10-17.json)：远程固定 commit/tree、path → blob SHA，以及本地缺少的一个已校验源码 blob。
- [六组探针结果](C:/Files/Projects/SpecGuard/docs/unknown-unknown-probe-results-2026-10-17.json)：每组含 observed、控制组和证据范围。
- [本地 refs/worktree 快照](C:/Files/Projects/SpecGuard/docs/unknown-unknown-local-snapshot-2026-10-17.json)：含 236 refs、65 worktree 与失败状态，不把不可读目录当干净。
- [远程 PR/评审/job 证据](C:/Files/Projects/SpecGuard/docs/unknown-unknown-remote-evidence-2026-10-17.json)：新修复状态、评审讨论与新的 reduced review 日志。

六组探针均复现上述行为，并通过相应对照断言；**“探针执行成功”表示缺陷/差异被稳定复现，不表示产品测试全绿**。U6 使用真实多段 planner/adapter/post/gate；U5 使用真实 trace/prompt 和合成 Git 对象。全部探针网络调用为 0，没有真实秘密，也不执行目标仓库代码。

Verdict：先补输入来源与多段终态这两个边界，再修周报适配器的一致性；评测口径单独定清楚，避免把“结果看起来更好”误当成 shift-left 价值增加。

Not checked：没有重跑完整测试套件、真实 provider、生产回归频率或所有输入来源组合；5 个 worktree 的状态无法读取，ignored 文件未全面盘点。没有确认线上发生过真实秘密泄露，或这些差异已经影响了某份实际周报。
