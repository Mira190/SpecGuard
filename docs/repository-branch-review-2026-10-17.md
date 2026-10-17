# SpecGuard 本地与远程分支复核报告

> **处置状态（2026-10-17，main 45713a2）：** 本文发现已复核。已修复：dogfood 认证失败被绿色掩盖（#222 配置失败变红，secret 已重设）；DENY diff 进入 prompt（#223、#226）；跨目标 scan issue（#220）；两个 WIP（#221、#219）；#218 已合入。未修复/待办：分支/worktree 清理（涉及删除，暂缓）；#199 仍开放。行号与 SHA 以本文写作时为准。

> 本文为早先分支快照，部分修复现已合入。最新整合版本与本地未提交内容的复核见[新修复后的 unknown unknown 报告](C:/Files/Projects/SpecGuard/docs/unknown-unknown-review-2026-10-17.md)，请勿把下文的当时待合入/WIP 状态当成当前状态。

> 最新远程证据补充：[GitHub Actions 与 PR 实际运行复核](C:/Files/Projects/SpecGuard/docs/github-actions-pr-review-2026-10-17.md)。最新 50 次运行有 47 次成功，但 #197–#218 的 22 个 PR 最新摘要中，19 个认证失败、3 个因文件全部忽略未调用模型。main 远程测试 1182 pass / 0 fail；#218 为 1183 pass / 0 fail，均另有 3 skipped、1 TODO。分支和开放 PR 清单未变；应并行优先修复 dogfood 认证及终态可见性，不能把绿色 workflow 当作有效模型评审。

What this repo does: SpecGuard 在 PR 和仓库扫描中核对需求、代码、测试与证据，帮助开发者在合并前发现遗漏。它还包含 GitHub Action、评测夹具、覆盖证据分级和扫描状态管理。

负载与目标：本报告关注真实 PR/扫描流程以及评测可信度；没有生产流量、调用量或成本实测，因此不推断容量。对 shift left 最有价值的工作是：保护输入边界、让缺失证据和运行失败可见、提高评测可信度，再扩大扫描范围。

复核日期：2026-10-17，Australia/Sydney。分支/PR 元数据快照：2026-10-16 21:39:20 UTC，即悉尼 10 月 17 日 08:39:20。21:51 UTC 再次读取远程 main 和全部开放 PR，SHA 与开放 PR 清单未变。

远程基线：[Mira190/SpecGuard](https://github.com/Mira190/SpecGuard)，main = `bcddf784f70d4f5b5a854d2c75789bd33f1591aa`。本报告只新增文档与清单，没有执行合并、删除、推送、切换分支、解锁或 worktree 清理。

## 1. 决策摘要

**优先评审合入 #218；保住两个未提交修复；从旧分支提取两项仍存在的问题；更新旧审计文档后再合入。不要把所有 ahead 分支都合并。**

| 项目 | 数量/状态 | 决策 |
|---|---:|---|
| 远程分支 | 83 | 78 个分支头已在 main 历史中，含 main 本身 |
| 远程清理候选 | 76 | 已排除 main 和仍被开放 PR #9 用作 base 的 feature/ccr-mode；需检查外部引用 |
| 远程尚未进入 main 的分支 | 5 | #218、#199、1 条孤立报告分支、2 条故意植入缺陷的测试分支 |
| 本地分支 | 230 | 150 个分支头在 main 历史中，80 个不在 |
| 本地第一批分支清理候选 | 95 | 已在 main 中、不是 main、没有 worktree 占用；仍需留档和引用检查 |
| 本地评测分支 | 72 | 36 对 head/base，upstream 均 gone；作为夹具归档，不合入产品 |
| 注册 worktree | 62 | 38 个状态干净、19 个有改动、5 个状态读取失败 |
| worktree 初筛清理候选 | 35 | 干净、未锁定、HEAD 在 main 中；尚未盘点 ignored 文件和使用者 |
| 必须保护的未提交功能修改 | 2 组 | structured-reduced-reasons、eval-metric-integrity |

这些集合有交集，不能把 76、95、35 相加理解为独立可删除对象。这里的“已进入 main”按提交祖先关系判断；没有祖先关系也不等于功能未实现，仍需逐项比较。

## 2. 本次 review 的重要发现

### 1）[P1] 当前工作目录过旧，继续在这里判断“还没修”会制造重复修复

当前目录分支 `fix/auto-lead-low-confidence`，HEAD `b1aaf113aae3ca69fcc70e7b9026130affa6c30f`，相对远程 main 落后 **101 个提交**；本地 main `ee1c15812bae4315f39ce7d5bf1bf7511ac58553` 落后 **105 个提交**，没有领先提交。这些包含 merge commit，不代表 105 个独立功能。

主目录还有原有 README 修改和四份 shift-left 文档。本次报告不能直接当作工作目录已经升级到最新 main 的证明。后续应先保存原有改动，在最新 main 上建立新的文档分支，再按实际差异迁移；README 只迁移需要的段落。

**影响：**旧 checkout 会把已修复问题重新列为 P1，旧分支整体回合还可能覆盖新的证据分级、漏斗和配置修复。以后每份 audit 应记录 repo、base/head SHA、构建版本和运行状态。

### 2）[P1] “分支头已合入”无法保护未提交改动，两个 worktree 不能清理

`fix/structured-reduced-reasons` 和 `fix/eval-metric-integrity` 的 HEAD 都等于当前 main，但工作目录分别还有 2 和 4 个修改文件。仅凭 merged 分支列表删除目录，会丢失真正尚未进入提交历史的工作。

| 分支 | 当前未提交内容 | 建议 |
|---|---|---|
| fix/structured-reduced-reasons | src/post.js、src/post.test.js；31 行增加/5 行删除，将降级原因改为结构化 id | 在当前 main 基础上完成测试并单独提 PR |
| fix/eval-metric-integrity | eval/grade.js、grade.test.js、weekly-report.js、weekly-report.test.js；107 行增加/9 行删除 | 拆清评测计数与周报取证语义后提 PR；补齐 Git 场景测试 |

第一组减少依赖英文说明文本解析 `reducedReasons` 的脆弱性；第二组把 row-only 的 weak/missing findings 纳入误报与 expect_clean 判断，并改进周报对有效代码变更的识别。这两组都直接服务于“报告有没有诚实反映证据”。它们目前是 **WIP，不是已完成修复**。

### 3）[P1] #218 的 CI 绿色，但实际 dogfood 没有完成模型评审

[#218](https://github.com/Mira190/SpecGuard/pull/218) 的 [test](https://github.com/Mira190/SpecGuard/actions/runs/38900709026/job/116971973683) 和 [dogfood](https://github.com/Mira190/SpecGuard/actions/runs/38900709026/job/116971973269) 均 success；但机器人[实际评论](https://github.com/Mira190/SpecGuard/pull/218#issuecomment-6215503834) 明确显示 Anthropic API key 被拒绝，要求检查 `llm_token`。因此它证明 workflow 运行完毕，**不证明模型已经完成此次评审**。

评论还记录 context pack 为 8 个文件、202KB，未包含 audit-collect.test.js 和 audit-units.test.js。这不证明产品逻辑有错，但不能把该次 dogfood 当作完整模型覆盖证据。

建议将 `workflow_conclusion` 与 `review_status` 分开：completed、skipped、auth_failed、provider_failed、partial。运行摘要显示 included/omitted 文件及原因、head SHA、pack 版本、trace/run id。advisory 模式可以保持 job 绿色，但 dashboard/summary 必须显示未完成；这是可观测性优先项。修复密钥时只检查配置与权限，不在日志或报告输出密钥。

### 4）[P1] 旧 rereview 分支仍有应提取的输入过滤修复

当前 main 的 [collect.sh](https://github.com/Mira190/SpecGuard/blob/bcddf784f70d4f5b5a854d2c75789bd33f1591aa/src/collect.sh#L26) 默认忽略规则未统一覆盖 `.env` 等 DENY 路径；[prompt.js](https://github.com/Mira190/SpecGuard/blob/bcddf784f70d4f5b5a854d2c75789bd33f1591aa/src/prompt.js#L129) 会把已经收集的 diff 放进 prompt。packRead 的文件拒绝规则不能自动清洗此前组装好的 diff。

本次用合成 `.env` diff 和字面量 `SPECGUARD_SYNTHETIC_NOT_A_REAL_SECRET` 调用 prompt assemble，确认该字面量保留在 prompt 中。没有使用真实秘密，也没有调用模型或网络。此结果证明该组装路径存在缺口，**不代表已经观察到真实凭据外泄，也不是完整 PR 端到端复现**。

`fix/rereview-batch1` 的 `8921744` 引入了 `src/deny-filter.js` 及相关收集/组装过滤，是值得保留的修复来源。建议从最新 main 提取最小修复：让文件列表、raw/numbered diff、focus 和各引擎输入共用过滤边界，并测试不会误删普通业务 diff。不要整体合并 8 个旧提交。

### 5）[P2] 旧 state 分支还有跨目标 issue 识别问题，不能因 #200 合入就全部丢弃

当前 main 的 [findIssue](https://github.com/Mira190/SpecGuard/blob/bcddf784f70d4f5b5a854d2c75789bd33f1591aa/src/audit-post.js#L672) 在默认空 title 下主要按公共标记匹配，未充分区分本仓库扫描和写到同一仓库的外部目标扫描；[resolveIssueTarget](https://github.com/Mira190/SpecGuard/blob/bcddf784f70d4f5b5a854d2c75789bd33f1591aa/src/audit-post.js#L681) 还使用大小写敏感的 owner/repo 比较。

本次 fake GitHub client 返回两个同机器人账号、带公共标记的 issue：先是外部目标 org/other 的 #1，再是本目标 #2。默认调用实际选中 #1。测试不联网、不修改 issue。影响是可能关联错误的进度/状态；实际线上发生频率未测。

`fix/scan-state-address` 已有 foreign-target/title guard 和大小写处理。#200 合入了共享 resolver 等修复，但不足以证明这些剩余 guard 已进入 main。建议只迁移剩余差异，并覆盖 own/foreign、同名不同大小写、显式 issue、state 仓库和无匹配场景。

## 3. 应该合入什么：按价值排序

| 顺序 | 对象 | 建议动作 | 合入前完成条件 |
|---:|---|---|---|
| 0 | 现有 WIP、报告、probe、读取失败 worktree | 先留档，不合代码 | 提交内容、未跟踪文件和 ignored 文件分别核实 |
| 1 | PR #218，fix/funnel-deterministic-split | 优先完成评审后合入 | 确认必需检查、人工 review，运行 cap/time 与渲染断言；如要声称模型评审完成，先恢复认证并重跑 |
| 2 | rereview-batch1 的 DENY 过滤残余 | 从最新 main 新开小 PR | 不引入旧架构；覆盖所有进入模型的 diff 路径 |
| 3 | fix/structured-reduced-reasons 未提交修改 | 完成并提小 PR | 验证每个降级路径产生明确 id，保留原有输出兼容性 |
| 4 | fix/eval-metric-integrity 未提交修改 | 完成并提 PR | 回归 FP、expect_clean、跨组去重、删除文件/merge base/周报场景 |
| 5 | scan-state-address 的剩余 guard | 从 main 提取小 PR | fake client 正反例通过，避免读错/写错目标状态 |
| 6 | PR #199、孤立 rereview 报告、本地四份文档 | 更新后集中整合 | 每项 finding 都绑定新 SHA 和状态，不重复发布已经修复的问题 |

顺序 2–5 是建议的价值优先级，可独立推进；这不是现成可直接执行的 cherry-pick 清单。尤其第 2 项应先核对现有过滤契约，避免以“修复”名义引入另一套不一致规则。

### PR #218 的具体判断

Head `5f2b1904e80cb3ca28059d1ec147b44f943b949d`，比 main 领先 1、落后 0；远程当时 mergeable=true、mergeable_state=clean。仅 4 个文件，21 行增加/7 行删除。

它把 `not_reached` 拆成 inventory cap 与 time budget 两个原因，同时保留总数，补充 cap 控制、零预算和报告渲染测试。收益是避免把确定性的扫描数量限制误说成超时，也让后续优化有正确分母。没有理由为这项局部修复回合整批旧 audit 分支。

本地渲染定向测试 1 个通过。涉及临时 Git 仓库的完整组合测试受环境权限阻塞，见第 8 节；本报告不据此宣称本地全套通过。远程检查也不能替代人工评审。

### PR #199：保留调研价值，先修正文档状态

[#199](https://github.com/Mira190/SpecGuard/pull/199) 基于旧 `ee1c158`，只有一份约 63 行报告。[既有 review](https://github.com/Mira190/SpecGuard/pull/199#pullrequestreview-5547200106) 已指出多处结论过时；此后 #215、#216、#217 又进入 main，需要再更新一次。

其 test/dogfood 绿色，但机器人表示所有修改文件被忽略，没有实际审查内容。它适合“标明日期的历史发现 + 最新处置状态”，不适合原样作为当前未修复清单合入。

`codex/shift-left-rereview-2026-10-16` 在本地和远程均存在，领先 1、落后 103，没有 PR。它增加约 330 行报告，与已合入 #206/#207 的材料有重叠。建议抽取独有 probe 和推理，补最新状态后合并文档；其余保留为归档，避免维护三份互相矛盾的当前结论。

## 4. 本地未合入分支逐项处置

除 72 条 eval 分支外，本地有 8 条分支头未进入 main：

| 分支 | ahead / behind main | 处置 |
|---|---:|---|
| fix/funnel-deterministic-split | 1 / 0 | #218，优先评审合入 |
| codex/shift-left-rereview-2026-10-16 | 1 / 103 | 更新并整合报告，不原样合入 |
| fix/rereview-batch1 | 8 / 105 | 提取 DENY 等经复核仍缺失的修复；其余逐项标为已替代 |
| fix/scan-part-size | 14 / 101 | 本地与远程同名但分叉；先归档、比较残余，禁止覆盖远程 |
| fix/scan-state-address | 4 / 105 | 提取 foreign-target/title/case guard，不整体回合 |
| gates/evidence | 2 / 315 | 不建议合入，记录历史实验依据后归档 |
| test/ccr-seeded | 1 / 356 | 故意带缺陷的评测分支，不合产品 |
| test/seeded-gaps-v7 | 2 / 359 | 同上 |

**fix/scan-part-size 是容易误操作的一条。**本地 `c392b5b13eb732eaf744038af0c3a270c05f3dc2`，远程 `ea5554dac9bc5e226ae2b994236c35ba6d10639f`。远程已随 #198 合入，不能由此删除本地独有提交，也不能把本地 force-push 到同名远程。本地分支包含 rereview-batch1 的全部 8 个提交及其他旧整合内容，应作为同一组残余修复来源去重。

`git cherry` 显示 batch1 有 8 个、scan-state 有 4 个、scan-part-size 有 13 个非等价 patch；这只说明补丁不等价，不说明每个 patch 的业务目标仍未实现。

**gates/evidence 不应因为有独有提交就合入。**当前 main 的 design 文档“Rejected gates”已记录 G1/G2/G3 被否决、只保留 G4 skeleton 方向；未见足以推翻该决策的新测量。保留实验历史比恢复旧门禁更有价值。

另有 upstream 配置问题：`docs/audit-supplement` 跟踪的是 `codex/full-repo-shift-left-audit-2026-10-16`，不是同名远程；full-repo 本地又落后自己的远程 63 个提交。batch1/state 等跟踪 origin/main，不能用普通 ahead/behind 提示推断“自己的远程没同步”。清单分别列出 SHA、upstream、相对 main 的距离。

## 5. 最近哪些工作已经进入 main

| 已合入 PR | 已覆盖方向 | 对分支整理的含义 |
|---|---|---|
| #197、#209 | auto-lead/removed leads 等确定性候选修复 | 不重做旧 lead 修复；另核未提交 leads.js 是否只有换行状态 |
| #198，含 #202/#205 链 | pack 分片、游标和可见性 | 旧 scan-part-size 不再整体合入 |
| #200 | 配置、testpaths、共享 state 地址逻辑 | 只提取剩余状态隔离 guard |
| #201、#203、#208 | cut/invalid、需求身份与 AC | 旧 batch 中相同目标先判定被替代 |
| #204 | grading identity | eval WIP 聚焦 row-only 误报等剩余问题 |
| #206、#207 | 全仓审计和补充文档 | 不重复合入多个未更新的报告副本 |
| #210、#211 | 诚实 skip、扫描状态 | 保持显式失败/跳过语义 |
| #212、#213、#214 | Gherkin/test scope、pack quote、重跑及工作流输入 | 避免旧修复覆盖新契约 |
| #216 | 可核对的 unit funnel | #218 是原因拆分的后续小改动 |
| #217 | 一级依赖及 cover guard | 旧报告不能再写成完全没有依赖上下文 |
| #215 | weak assertion 证据层级、反驳 counterexample 的检查 | 旧“完全没有证据验证”的描述过时；仍不能等同完整语义证明 |

以上以 PR 合并记录和提交可达性核对，不等于对每项能力做了新的全量验收。旧文档应使用“已合入/部分覆盖/待验证/仍开放”四类状态，附当前证据。

## 6. 哪些可以进入清理队列

### 远程：76 个条件清理候选

83 个远程分支中，5 个不在 main，另保留 main 和 feature/ccr-mode，剩余 76 个可进入队列。全部名称和 SHA 在分支 CSV，筛选 `remote-cleanup-candidate` 即可。

不能只按 merged 删除，因为本仓库提供 GitHub Action，其他仓库可能使用 `Mira190/SpecGuard@branch`。本次没有全面扫描其他仓库的消费者，也没有证明这些引用不存在。清理前先查组织内 workflow/reusable workflow、文档和外部消费者，迁移到受维护的版本或固定 SHA；确认没有开放 PR 以该分支为 base，留档当前 SHA，再删除具体分支。

`feature/ccr-mode` 虽已在 main，仍是开放 #9 的 base，暂不进入队列。仓库当前 `delete_branch_on_merge=false`；未来可在确认版本分支/消费约定后考虑自动删除普通 PR head，避免再次积累。不能将版本分支视作普通临时分支。

### 本地：95 个无 worktree 占用的已合入分支先排队

150 个本地已合入分支 = main 1 个 + 无 worktree 的非 main 95 个 + 有 worktree 的 54 个。95 个可以在留档、引用检查后先处理，不必为了“保留历史”重建 PR。

另有 15 条 `m数字` 整合分支和 43 条 `worktree-agent-*` 占位分支，分支头全部进入 main；它们不是 58 份待合入产品功能。但必须先解决占用它们的 worktree，不能绕过占用直接强删。

### 72 个 eval 分支与两个 seeded PR：不属于待合入产品积压

72 条 `eval/*` 分支形成 36 对 head/base，全部 upstream gone，分支头都不在 main。建议生成夹具 manifest：head/base SHA、PR、场景标签、预期发现、使用的模型/提示词版本和重放命令；保存 Git 对象后再删除本地引用。删除分支前保证离线评测仍可按 SHA 重放。

[#8](https://github.com/Mira190/SpecGuard/pull/8) 与 [#9](https://github.com/Mira190/SpecGuard/pull/9) 的 sandbox 是故意植入缺陷的评测输入。需要它们时保留并明确标注；不用时可关闭 PR 后归档。**不应为减少开放 PR 数把缺陷代码合进 main。**本轮未关闭任何 PR。

## 7. Worktree 风险与清理次序

| 状态 | 数量 | 处置 |
|---|---:|---|
| 干净、未锁、HEAD 已进入 main | 35 | 检查 ignored 文件和归属后可归档/移除 |
| 干净但锁定 | 2 | 保留，核实使用者后处理 |
| 干净但未合入 | 1 | #218 worktree，合入后再评估 |
| 有改动 | 19 | 逐类保存，不能批量删除 |
| status 读取失败 | 5 | 先恢复可读并检查，不能当干净目录 |

19 个有改动目录包括：主目录 1 个、两组功能 WIP、1 个 leads.js 状态差异、4 个 probe/log 目录、11 个历史 scratch 目录。

`fix/drift-rubric-leads` 的 leads.js 显示 modified，但 numstat 无内容差异，并有 LF/CRLF 提示；目前只能判定需要核对换行/索引状态，不能声称存在另一项功能修复。4 个 probe/log 目录有未跟踪的脚本、JSON 和日志，应先归档审计证据。

11 个历史 scratchpad（adopt、crlffix、disc、docs2、gates、harden、lean、met、pd、skillv2、stale）各有 341–367 个 tracked 文件删除，没有未跟踪文件；其 HEAD 均已在 main。形态更像旧临时目录被部分清理，**不是应合入 main 的大规模业务删除**。保留核对记录后再处理注册关系。

锁定目录为 `agent-a30f13df4363ec8f9` 与 `agent-a72b7f7bbeeef3abe`，锁记录都提到 PID 8384。本次查进程未找到该 PID，但这不足以自动解锁或认定没有使用者。

以下 5 个 worktree 目录仍存在，`git status` 返回 `this operation must be run in a work tree`：

- C:/Files/Projects/SpecGuard-wt/batch1
- C:/Files/Projects/SpecGuard-wt/scan
- C:/Files/Projects/SpecGuard-wt/state
- <local-user-dir>/.codex/worktrees/critical-shift-left-review/SpecGuard
- <local-user-dir>/.codex/worktrees/shift-left-rereview-2026-10-15/SpecGuard

本次未修改它们的 Git 配置。应单独检查 common gitdir、worktree config 和目录绑定，恢复可读后重新盘点；错误原因未完全确定，不能把它们标成无用目录。

### 建议的实际清理流程

1. 固定本报告的 SHA 清单，再重新读取实时 main、分支头、开放 PR；若有变化重新分类。
2. 先保存提交对象，再分别保存 staged/unstaged 的 binary diff、未跟踪文件和需要的 ignored 文件。Git bundle 只保存提交及引用，**不会保存工作目录改动**；stash 为 0 也不代表没有 WIP。
3. 为两个有价值 WIP 建立明确提交/PR；为旧分支残余修复建立“来源 SHA → 新 PR → 验证结果”记录。
4. 完成 #218 和文档整合；对 seeded/eval 明确保留或归档，不向 main 合并。
5. 先处理 35 个 worktree 候选，核实目录的绝对路径、归属和 ignored 数据，逐个移除；锁定、dirty、读取失败目录另外处理。
6. 再处理本地分支和远程普通 PR 分支。每次删除前比较当前 head SHA 与清单，保留 `branch → SHA → PR → archive` 台账。
7. 最后刷新 tracking 信息、复查开放 PR base 和评测重放；不要使用整目录递归强删、全局 force delete 或统一 `git clean` 代替分类。

本轮没有执行上述写操作；清理候选不是已验证可无条件删除的白名单。

## 8. 核查、证据与限制

本次读取 83 条实时远程分支、4 个开放 PR、212 个关闭 PR，共 216 个 PR 记录；对比 230 条本地分支、62 个注册 worktree 和 cached remote SHA。83 条远程 head 均与缓存相同，因此本轮祖先分析没有使用已知过期的远程引用，也没有执行 fetch。

| 检查 | 结果 | 能证明什么 |
|---|---|---|
| #218 远程 test/dogfood | success / success | workflow 检查结果；模型评审未完成见评论 |
| main 远程测试原始日志（后续读取） | 1182 pass、0 fail、3 skipped、1 TODO | 补充当前 main 的远程确定性测试证据；TODO 的 k2 误报未解决 |
| #218 远程测试原始日志（后续读取） | 1183 pass、0 fail、3 skipped、1 TODO | 补足本地权限受阻时的远程测试证据；不代表模型评审成功 |
| #199 远程 test/dogfood | success / success | 文档未进入实际模型评审范围 |
| #218 funnel 渲染定向测试 | 1 pass，0 fail | cap/time 漏斗展示定向行为 |
| structured-reduced-reasons 定向测试 | 1 pass，0 fail | 新增 cover-guard 降级原因场景 |
| eval grade + weekly-report 组合 | 40 项，39 pass、1 fail | 失败发生在临时 git init 写 .git/config 权限；不能宣称全套通过或认定产品逻辑失败 |
| audit-units/audit-code 组合 | 未完成有效全量验证 | 多个临时 Git 仓库初始化同样受权限限制 |
| 合成 DENY prompt 探针 | 合成标记仍进入 prompt | 本地组装路径边界问题，无真实秘密/模型调用 |
| fake-client issue 选择探针 | 选到 foreign-target #1 | 默认匹配隔离不足，无线上 issue 修改 |

本次是分支整合与清理 review，并针对关键残余差异做代码核查和探针，不是对 main 每条路径重新做完整安全审计。没有验证全组织所有消费者、ignored 文件、实际密钥配置、生产流量或所有历史 fixture 的运行结果；5 个 worktree 的未提交内容仍不可判定。分支保护存在，但本报告不声称已完整审核所有 ruleset/必需审批策略。

此前 Kite Actions audit 工件的部分元数据未取得，终端读取曾因自动审批服务用量限制未执行；本报告不把未读取工件或旧 summary 当作证据。当前建议主要基于 SpecGuard 实时 PR/分支信息、机器人评论、本地提交与探针。

## 9. 配套完整清单

- [313 行本地/远程分支处置清单](C:/Files/Projects/SpecGuard/docs/branch-review-inventory-2026-10-17.csv)：230 本地 + 83 远程；含 SHA、PR、祖先关系、upstream、worktree 和建议。
- [62 行 worktree 处置清单](C:/Files/Projects/SpecGuard/docs/worktree-review-inventory-2026-10-17.csv)：状态、锁、读取错误、路径和保护要求。
- [证据快照 JSON](C:/Files/Projects/SpecGuard/docs/branch-review-evidence-2026-10-17.json)：PR 元数据、检查链接、分支关系和工作目录状态摘要。大批删除状态只保留样本及完整数量。

Verdict：仓库近期已经完成大量关键修复，主要风险从“有没有修”转为“最新修复是否被实际验证、未提交工作是否会丢、旧分支是否会把旧实现带回来”。先合 #218，提取输入过滤/状态隔离残余，完成结构化降级和评测 WIP，最后按证据清理；这比批量回合所有旧分支更有利于 shift left 的实际价值。
