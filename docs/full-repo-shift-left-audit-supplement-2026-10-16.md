# 全仓 shift-left audit 补充：覆盖记录与 27 项已复现缺陷（另 1 项按设计）

What this repo does: SpecGuard 在 PR 阶段把需求、代码、测试和仓库规则联系起来，提示缺失或薄弱的单元测试，也提供全仓轮转扫描。本文补充 [主报告](full-repo-shift-left-audit-2026-10-16.md)，不重复其 F19–F29。

## 1. 标题与范围

日期：2026-10-16。基线：`origin/main` `ee1c15812bae4315f39ce7d5bf1bf7511ac58553`。性质：只提交报告，不修改产品代码。

**目的：** 补齐主报告 §2 未覆盖或未深读的文件，使全仓审计完整。§2 是逐文件的覆盖记录，§3 是补读得到的 27 项缺陷加 1 项按设计（探针编号 S1–S14、U1–U13、V1–V2；U13 是单行验证）。

**证据标准：** 每一项都由探针复现，探针断言的是 **当前行为**。没有调用真实模型，没有访问真实 GitHub（GitHub 与 `gh` 用本地 mock；`collect.sh` 在临时 git 仓库里真实执行）。探针通过只证明错误行为存在，**不是**产品测试通过，也**不是**修复通过。所有数字取自附录 A、B 的 JSON 结果（S 系列在附录 A，U 系列在附录 B）。U13 是事实核查时补的 `node -e` 单行验证，不在探针脚本里，输出见 §3.1。

**限制：** Windows，Node `v26.11.1`；`collect.sh` 探针把 Git for Windows 的 `bin`、`usr/bin` 放在 PATH 前面。S12 的 "pinned action ref" 事实依赖本机 clone 含该提交。没有重跑 Ubuntu/Node 22 全套 CI。S6 探针未经 `audit-post` 入口；S7 的故障是人为注入的。

## 2. 覆盖记录

范围：`origin/main` 中全部非测试、非 fixture 的源码、workflow 和 skill 文件（`git ls-tree -r --name-only origin/main`）。标记：**主报告已审** = 主报告 §2 表中列为已读的关键链路；**本补充全读** = 本次通读全文；**本补充部分读** = 只读与探针相关的段落；**未读** = 本次和主报告均未读。

| 文件 | 状态 |
|---|---|
| `src/post.js`、`src/audit-post.js`、`src/audit-collect.js`、`src/audit-units.js`、`src/scan-parts.js`、`src/prompt.js`、`src/preflight.js`、`src/requirements.js`、`src/trace.js`、`src/test-map.js`、`src/engines/claude-api.js` | 主报告已审 |
| `src/audit.schema.json`、`src/findings.schema.json` | 主报告已审 |
| `action.yml`、`package.json`、`README.md`、`.github/workflows/ci.yml`、`.github/workflows/specguard-run.yml` | 主报告已审 |
| `eval/grade.js`、`eval/weekly-report.js` | 主报告已审 |
| `src/collect.sh`、`src/coverage.js`、`src/leads.js`、`bin/specguard-local.js`、`eval/label-export.js` | 主报告已审；本补充全读 |
| `src/engines/claude.sh`、`src/engines/copilot.sh`、`src/engines/claude-result.js`、`src/engines/_redact.sh`、`src/engines/README.md` | 本补充全读 |
| `src/focus.js`、`src/resolve-inputs.js`、`src/extract-json.js`、`src/credential.js`、`src/engine-model.js`、`src/standards-map.js`、`src/checks.js`、`src/superseded.js`、`src/target.js`、`src/fail-on-error.js`、`src/limitations.js`、`src/numdiff.js`、`src/version.js`、`src/visibility-guard.js`、`src/tee-summary.js`、`src/validate-inputs.sh` | 本补充全读 |
| `eval/run.js`、`eval/local.js`、`eval/field.js`、`eval/ab.js`、`eval/degrade.js`、`eval/mutate.js`、`eval/bundle.js`、`eval/szz.js`、`eval/prove.js`、`eval/replay.js`、`eval/mirror-workflow.yml` | 本补充全读 |
| `bin/pin-reusable.js`、`.github/workflows/specguard.yml` | 本补充全读 |
| `.github/instructions/specguard.instructions.md` | 本补充全读 |
| `skills/test-review/SKILL.md`、`skills/test-review/references/*`、`skills/spec-audit/SKILL.md` | 本补充全读 |
| `.github/skills/test-review/**`、`.github/instructions/test-review.instructions.md`、`ccr/test-review.instructions.md` | 本补充全读（与 `skills/test-review/**` 同内容的拷贝，见下） |
| `eval/aggregate-counts.js`、`eval/signal.js`、`eval/assign.js` | 本补充部分读 |
| `eval/token/anatomy.js`、`.claude/skills/ste-mini/SKILL.md` | 未读 |

三个原本"未读"的文件已读完，按同一标准（探针或静态引文能证明才列）检查：

- `.github/instructions/specguard.instructions.md`（仓库自己的编码标准，`applyTo: "src/**,eval/*.js"`）：其第 8 行要求"每个导出函数都需要断言返回值或抛错的单元测试"，仓库自身不满足，见 V1。其余规则（Node 22、无依赖、`node:test`、测试命名、不抛字符串）：`throw '...'` 只出现在 `eval/cases/s1`、`s2` 的故意用例里，源码无此情况。
- `eval/replay.js`：回放只数 summary items 和 inline 评论（`countFindings`），不做 TP/FP 评分，所以不受 S10/F29 的重复计数影响。发现一项：`findings_present=false` 的 PR 打印成全 0 行，见 V2。
- `src/engines/README.md`：逐条对照代码，`MODEL` 空 → `claude-haiku-5-5`（`claude-api.js:281`）、`CONTEXT_PACK_BYTES` 默认 250000（`:285`）、单文件 48 KiB 与 2 MiB（`:64`）、别名映射（`credential.js:10`）均一致；"`engine-status` 缺省即 success"（README:37）与 "An engine note says how many files went in and which did not fit"（README:61）为 S7 提供旁证：打包失败时没有这类 note（S7 的 `engine.notes` 只有价格估算一条）。已读，无新发现。

**覆盖核对（脚本）：** `coverage-check.cjs`（附录 C）取 `git ls-tree -r --name-only origin/main`，减去下列不在范围的模式，再与本表中出现的路径和通配符做差集：

| 不在范围的模式 | 原因 |
|---|---|
| `**/*.test.js`、`test/**`、`tests/**`、`**/fixtures/**` | 任务明确排除测试与 fixture |
| `eval/cases/**`、`eval/replay/*.json` | 评估输入数据，不是被执行的代码 |
| `eval/results/**` | 历史运行产物 |
| `docs/**` | 历史研究与评审文档，不被产品加载 |
| `research/**` | 外部调研材料，不被产品加载 |
| `eval/**/README.md` | 评估说明文档，无运行行为 |
| `NOTICE` | 许可声明，无运行行为 |
| `.gitattributes`、`.gitignore` | 仓库元数据（换行、忽略规则），不影响被审查行为 |

计数：`git ls-tree` 共 543 个路径；不在范围 459；范围内 84；表中已列 84；差集 0（空）。表中通配符 71 个，未匹配到任何路径的 0 个，匹配到范围外路径的 0 个。

重复拷贝：`.github/skills/test-review/` 与 `skills/test-review/` 整目录逐字节相同（`diff -rq` 无输出），所以 skill 的发现只计一次。`ccr/test-review.instructions.md` 与 `.github/instructions/test-review.instructions.md` 忽略换行符后内容一致（工作区检出的换行符不同，哈希因此不同）。

## 3. 发现

27 项缺陷 + 1 项按设计：P1 PR 模式 10 项、P1 scan 模式 4 项、P2 5 项、P3 8 项（eval 指标 7 项、仓库自身标准 1 项）；另有 S11 按设计，不计为缺陷。行号均指 `ee1c158`。"影响模式"：PR（shift-left 主路径）、scan（全仓轮转）、local（`specguard-local`）、eval（评估工具）。

### 3.1 P1：PR 模式

#### U1 [P1] 缺少 merge-base 时被当作 "Nothing to review"，仍写 complete 与 head marker

- **位置：** `src/collect.sh:69–70`（只告警）、`:87`（`done < <(git diff ...)` 的失败无人检查）、`:115`（`nothing reviewable in diff` → `skip true`）。**影响模式：** PR。
- **What this is:** `BASE_SHA` 不在 clone 里（浅克隆）时，三点 diff 失败。
- **Problem:** 失败被当作空 diff：`skip=true`，post.js 发布 "Nothing to review" 并写 head marker，之后同 head 的 preflight 会跳过。
- **Fix:** diff 命令失败时 collect 非零退出或产出 incomplete；不要把"取不到 diff"当作"没有变更"。
- **If we skip it:** 没有 `fetch-depth: 0` 的采用者得到"无需审查"的放心信号，真正的 PR 完全没被看。
- **证据 U1：** `baseInClone=false`、`collectExit=0`、`collectOutputs=["skip=false","partial=false","skip=true"]`、`diffPatchBytes=0`、`postStatus="complete"`、`summaryHasNothingToReview=true`、`summaryHasHeadMarker=true`。警告只在 stdout：`::warning::no merge-base of BASE_SHA and HEAD_SHA (shallow clone? ...)`。
- **回归测试应断言：** `BASE_SHA` 不在 clone 里时，collect 不输出 `skip=true`，post 不发布 "Nothing to review"、不写 head marker（预期非零退出或 `incomplete`）。

#### S2 [P1] 读不到的 closing issue：状态仍是 complete 并被缓存

- **位置：** `src/requirements.js:285`（`fact(...)`）、`src/limitations.js:4`（`FACT_LIMITATION` 含 `Could not read (?:issue|history issue) `）、`src/post.js:1528`。**影响模式：** PR。
- **What this is:** 读不到的引用被分类为 fact（只是注记），而不是 gap（使运行 incomplete）。
- **Problem:** PR 声明 `Fixes #7`，该 issue 读取失败（HTTP 403）。需求状态 `partial`，但运行 `status=complete`、`execution_complete=true`，写 head marker，下次 push 被 preflight 跳过。标题已措辞为 "❔ No gaps found; part of the review could not be assessed"，不是 "No unit test gaps found"，所以问题不在文案，在状态与缓存。对照：issue 数超过五个上限时，同类缺失被判 `incomplete`，不写 marker。
- **Fix:** 让"没读到声明过的 closing issue"进入 gap（或至少不写 head marker），与超上限的处理一致；权限或临时 API 错误应让下一次 push 重试。
- **If we skip it:** 一次 403 或 API 抖动，就把该 head 的需求侧审查永久缓存为完成。
- **证据 S2：** `unreadableClosing.status="partial"`、`limitations[0]={l:"Could not read issue #7.",fact:true}`、`run.status="complete"`、`complete=true`、`execution_complete=true`、`headline="❔ No gaps found; part of the review could not be assessed"`、`headMarker=true`、`nextPushSkipped=true`；对照 `cappedClosing.run.status="incomplete"`、`headMarker=false`。
- **回归测试应断言：** 读不到 closing issue 时 `status` 为 `incomplete`、无 head marker，`nextPushSkipped` 为 `false`。

#### U5 [P1] 同 subject 的别处断言隐藏已删除或被弱化的断言

- **位置：** `src/leads.js:263–265`（`same = add.filter(a => a.x === r.x)` 取整个文件的新增断言；`same.some(a => !a.weak)` 即视为 "still pinned"）。**影响模式：** PR。
- **What this is:** `assertionDelta` 用 subject 判断被删除的断言是否被重新钉住。
- **Problem:** `add` 汇集整个测试文件的新增断言，不限 hunk 或 test 块。文件另一处新增 `expect(result).toBe(true)`，subject 恰好是 `result`，就让 `result` 上被删的 `toEqual({a:1,b:2})` 不报。`expect(total(2)).toBe(5)` 改成 `expect(total(2)).toBeGreaterThan(0)` 同样被抑制：同 subject 的非弱新断言被算作仍然钉住，不比较强度（从 :265 的逻辑推断，未单独探针；探针只证明结果为空）。
- **Fix:** "已重新钉住"限制在同一 hunk 或同一 test 块内；同 subject 的更弱断言仍报 `weakened`。
- **If we skip it:** 这条 lead 的目的就是提示测试被削弱，抑制发生在最该提示的时候。
- **证据 U5：** `removedOnly=[{kind:"removed",line:12,old:"expect(result).toEqual({a:1,b:2});"}]`；加入无关 hunk C 后 `withC=[]`；`weakA` 有一条 `weakened`，`weakAC=[]`；`toBe5ToGreaterThan=[]`、`toBe5Suppressed=true`；对照不同 subject：`controlOtherSubject` 仍报 `removed`。注：PR #197（断言删除后提升低置信度）作用在 lead 之后，不改变 lead 是否产生。
- **回归测试应断言：** 加入无关 hunk C 后 `assertionDelta` 仍返回 `removed`（`withC.length===1`、`weakAC.length===1`）；`toBe(5)` → `toBeGreaterThan(0)` 返回 `weakened`。

#### U6 [P1] 删除整个测试文件不产生 lead

- **位置：** `src/leads.js:214`（`+++ /dev/null` → `file = null`）。**影响模式：** PR。
- **What this is:** `assertionDelta` 把 `+++ /dev/null` 当作"没有文件"。
- **Problem:** 同一条断言从保留的文件里删掉会报 `removed`；整个文件被删除却无输出。
- **Fix:** 对 `deleted file` 的旧侧断言同样产出 `removed` lead。
- **If we skip it:** 弱化测试最省事的方式（删文件）被排除在检查之外。
- **证据 U6：** `deletedFile=[]`，`sameAssertionRemovedFromLiveFile=["removed"]`。
- **回归测试应断言：** 删除整个测试文件时 `assertionDelta` 至少返回一条 `removed`（`deletedFile.length>=1`）。

#### U3 [P1] 测试候选 60 文件上限与 focus 选择不一致

- **位置：** `src/collect.sh:248`（`CAP = 16 * 1024`、`MAX_FILES = 60`）、`:269`（`(N more changed file(s) not listed)`）；`src/focus.js` 之后另行挑选文件。**影响模式：** PR。
- **What this is:** 候选测试表只列前 60 个变更文件；focus 对大 PR 按风险重新排序。
- **Problem:** 风险最高的文件排在 60 个之后时，它被 focus 选中、源码进了 pack，但测试不在 pack，`notWhole` 为空，`pack-cut.txt` 不存在，下游认为测试全部可见。
- **Fix:** 候选表优先列 focus 选中的文件（或在 focus 之后生成候选）；至少把"被选中但没有候选"记入 `pack-cut.txt`。
- **If we skip it:** 大 PR 里最该有测试证据的文件，恰好得到"没有测试"的输入。
- **证据 U3：** `candidatesListZzz=false`、`candidatesTail="(2 more changed file(s) not listed)"`、`focusPicksZzz=true`、`packHasZzzSource=true`、`packHasZzzTest=false`、`packNotWhole=[]`、`packCutTxt=null`；对照 `control.packHasZzzTest=true`。
- **回归测试应断言：** focus 选中的 `src/zzz.js` 的测试要么在 pack 中（`packHasZzzTest===true`），要么在 `pack-cut.txt`/`notWhole` 中被点名。

#### S3 [P1] 共享的大测试文件只按第一个文件的符号切片，`notWhole` 为空

- **位置：** `src/engines/claude-api.js:182–188`（`seen` 去重）、`:222`（`unitSymbols`）。**影响模式：** PR。
- **What this is:** 同一测试文件被多个变更源码文件命中时只打包一次。
- **Problem:** 66,992 字节的共享测试文件超过每文件上限 41,666，被切成"提到第一个文件符号的窗口"；第二个文件的断言不在 pack 中，`notWhole` 仍为空。
- **Fix:** 按所有命中它的源码文件的符号并集切片；或第二次命中发现窗口不含其符号时记入 `notWhole`。
- **If we skip it:** 第二个文件被报缺测试，而 `pack-cut.txt` 为空，post 保持高置信度。
- **证据 S3：** `testFileBytes=66992`、`perFileCap=41666`、`aAssertionInPack=true`、`bAssertionInPack=false`、`notWhole=[]`、`testBlockCount=1`。
- **回归测试应断言：** 两个源码文件的断言都在 pack 中（`bAssertionInPack===true`），或共享测试文件出现在 `notWhole`。

#### S7 [P1] 被吞掉的 pack 错误被当作"全部可见"

- **位置：** `src/engines/claude-api.js:416`（`catch { /* the pack is optional */ }`）、`src/scan-parts.js:26`（`catch { return { text: '', note: '', notWhole: [] } }`）。**影响模式：** PR、scan。
- **What this is:** 打包失败被当作可选步骤。
- **Problem:** (a) 单次调用路径：`contextPack` 抛错，没有 `pack-cut.txt`，`engine-status` 视为 success，findings 照常写出，post 保留高置信度；对照：`pack-cut.txt` 点名该测试时，同一 finding 降为低置信度。(b) scan 路径：`contextPack` 抛错时 unit pack 文本为空、`packCut=[]`。
- **Fix:** 打包失败写入 `pack-cut.txt`（或失败状态），把所有文件视为未看全。
- **If we skip it:** 打包故障把"模型什么也没看到"变成"没有裁剪"。
- **证据 S7：** `engine.status="success (no engine-status file)"`、`packCutFile=false`、`findingsWritten=true`；`postNoPackCut.postedHighConfidence=1`、`lowConfidenceNote=false`；`postPackCutNamesTest.postedHighConfidence=0`、`lowConfidenceNote=true`；`scanParts.parts=3`、`unitPackText=""`、`packCut=[]`。故障是人为注入的（附录 A 的 `injected` 字段），证明的是错误处理缺口，不代表该故障常见。
- **回归测试应断言：** `contextPack` 抛错时 `pack-cut.txt` 非空（或 `engine-status` 不是 success），且 `postedHighConfidence===0`；scan 路径的 `packCut` 非空。

#### S8 [P1] `findLine` 的 20 字符前缀接受不同的期望值，并改写引用

- **位置：** `src/post.js:349`（`findLine`）及 `verifyEvidence`。**影响模式：** PR。
- **What this is:** 对较长的引用，`findLine` 只比较前 20 个非空白字符。
- **Problem:** 模型引用 `assert.equal(compute(1), 2)`，实际行是 `assert.equal(compute(1), 3);`，前缀相同，引用被判有效并被**改写**为实际行；`status` 保持 `covered`，没有 note 或降级。
- **Fix:** 前缀匹配后仍比较整条引用的规范化文本；不一致就算引用未验证，或改写时降级并记 note。
- **If we skip it:** 模型编造的期望值被悄悄纠正，覆盖结论看起来被证据证实了。
- **证据 S8：** `longerQuote.findLine=2`、`verifyEvidence.status="covered"`、`evidenceQuoteAfter="assert.equal(compute(1), 3);"`、`noteOrDowngrade=[]`。边界：恰好 20 个非空白字符的引用不受影响（`briefQuoteLiteral.matchesLine=0`）。
- **回归测试应断言：** 引用 `assert.equal(compute(1), 2)` 对实际行 `assert.equal(compute(1), 3);` 不得成为 `covered` 证据（`findLine===0`，或证据被降级并有 note）。

#### S13 [P1] preflight 跳过键忽略规则文件、配置、模型和 SpecGuard 版本

- **位置：** `src/preflight.js:30`（`reqKey`：title+body）、`:48`（`decide`）。**影响模式：** PR。
- **What this is:** 同一 head、同一 title/body 已有 SpecGuard 摘要时，跳过本次运行。
- **Problem:** `decide` 的输入只有 `pr, comments, headSha, includeBots, force, actor, issueAt`；真实摘要里的 marker 是 `summary, head, counts, req, status`，没有规则文件、配置、模型的 marker。基线分支上的规则文件更新、配置变更或模型切换后，同一 head 仍被跳过。
- **Fix:** 把规则文件内容哈希、关键配置、模型与版本写入摘要 marker，由 `decide` 比对。现有逃生口是 `force: true`，需要用户先知道。
- **If we skip it:** 采用者改了规则，期待下次 push 生效，却看到 "already has a SpecGuard summary"。
- **证据 S13：** 同 head/title/body：`"head 07fe197 already has a SpecGuard summary (set force: true to rerun)"`；改标题则 `"review (no skip)"`；`markersInRealSummary=["summary","head","counts","req","status"]`、`markerForRulesConfigOrModel=false`。
- **回归测试应断言：** 规则文件、配置、模型或版本变化后，同 head 的 `decide` 不返回跳过。

#### U13（新增，对调研文档做事实核查时发现）[P1] `AC-1:` 不被识别为结构化验收条件

- **位置：** `src/requirements.js:62`（`/^\s*AC\s*\d+\s*[:：]\s*(.+)$/i`）、`:216`（同形的第二处）。**影响模式：** PR。
- **What this is:** `extractCriteria` 从结构化 AC 区块和 `AC<n>:` 行产生确定性的 R 项。
- **Problem:** `AC\s*\d+` 只允许 `AC` 与数字之间有空白；`AC-1:`、`AC.1:` 不匹配，不产生 R 项，`AC1:`、`AC 1:` 可以。叙述性需求仍交给模型解释，所以后果是少了确定性的 R 项和对应追溯行，不是需求被完全忽略。
- **Fix:** 允许 `[\s._-]*` 作分隔，并同步修改 `:62` 与 `:216`。
- **If we skip it:** 用 `AC-1:` 写验收条件的仓库，得到的结构化 R→T 追溯比用 `AC1:` 的少。
- **证据 U13（本次对 `extractCriteria` 的 `node -e` 直接调用）：**

```
"AC1: Reject negative amounts"   => [{"id":"R1","source":"PR body","quote":"Reject negative amounts"}]
"AC-1: Reject negative amounts"  => []
"AC 1: Reject negative amounts"  => [{"id":"R1","source":"PR body","quote":"Reject negative amounts"}]
"AC.1: Reject negative amounts"  => []
```

**交叉引用（不另立编号）：** 调研文档 F32（Gherkin `Background` 被丢弃）也影响 PR 模式：`src/trace.js:254`（`if (/^(Feature|Rule|Background)$/.test(s.kind)) return;`）在分块循环里直接跳过 `Background`，其前置条件不进入任何 scenario 的身份。细节见 [调研文档](research-repo-audit-requirements-chunking-2026-10-16.md) 的 F32，本文不重复。

- **回归测试应断言（U13）：** `extractCriteria([{source:"PR body",text:"AC-1: Reject negative amounts"}])` 返回 1 项 R。
- **回归测试应断言（F32）：** 修改 `Background` 的前置条件后，受它影响的 scenario 的身份与版本（含 #203 的 `tv`）改变，旧的 `covered` 状态过期。

### 3.2 P1：scan 模式

#### S5 [P1] 只有低置信度 finding 的 unit 被记为 covered

- **位置：** `src/audit-post.js:383`（unit 状态：`hit.has(cid) ? 'gap' : ... 'covered'`）、`:759`（`code.findings.filter((f) => !f.low)`）。**影响模式：** scan。
- **What this is:** 低置信度 finding 只显示在 Details，不计数。
- **Problem:** 一个 unit 的唯一 finding 缺 test sketch，被标 `low`（`lowWhy: "no test sketch: the finding may not be a gap"`），状态推导忽略它，unit 写成 `covered`；有 sketch 的同一 finding 则写 `gap`。
- **Fix:** 有 low finding 的 unit 写 `unsure`，不推进 covered。该问题正在 PR #201 下审查（见 §4），此处因有独立探针而列出。
- **If we skip it:** 模型可能真实的发现因缺一个格式字段而被洗成已审。
- **证据 S5：** `lowFinding.low=true`、`status="complete"`、`unitStateInIssue="covered"`；对照 `control.low=false`、`unitStateInIssue="gap"`。
- **回归测试应断言：** 只有低置信度 finding 的 unit 状态为 `unsure`，不是 `covered`（`unitStateInIssue!=="covered"`）。

#### S4 [P1] `EV_PER_BLOCK=8` 截断：第 9 个被引用文件的变更不使 block 过期

- **位置：** `src/audit-post.js:347`（`EV_PER_BLOCK = 8`）、`:351`、`:357`。**影响模式：** scan。
- **What this is:** 每个 block 的状态只保存最多 8 个证据文件的哈希。
- **Problem:** block 引用 9 个文件，只存前 8 个；只改第 9 个文件，block 不被标 stale，继续携带 `covered`。
- **Fix:** 保存全部引用文件哈希的聚合哈希；或超限时标记为不可验证。
- **If we skip it:** 证据多的 block 依赖面最大、最容易被改，却最不容易被重审。
- **证据 S4：** `citedFiles=9`、`storedHashes=8`、`ninthFileEdited_blockStale=false`；对照 `firstFileEdited_blockStale=true`。
- **回归测试应断言：** 只改第 9 个被引用文件时 block 为 stale（`ninthFileEdited_blockStale===true`）。

#### S6 [P1] 未被回答的 block 被记上今天的审查日期，在轮转中沉底

- **位置：** `src/audit-post.js:383–386`（状态按本次日期写入，`when(b)` 取 `b.at.date`）；`src/audit-collect.js` 的最旧优先层读取该日期。**影响模式：** scan。
- **What this is:** 轮转按存储的审查日期最旧优先。
- **Problem:** 模型没有回答的 block（`verify` 产出 `unknown`，note 为 "did not assess"）以 `unsure` 写入，日期是本次。下一轮最旧优先把它排在 A、B（已回答、covered）之后。
- **Fix:** 未回答的 block 不更新审查日期（或标为未审），使其在轮转里保持靠前。
- **If we skip it:** 模型最没能处理的 block 被推到队尾。
- **证据 S6：** `stored.C_unanswered=["unsure","2026-10-15"]`、`stored.D_not_sent=["covered","2026-10-01"]`；`nextRunCap1=["D"]`、`nextRunCap3=["A","B","D"]`（C 被挤出）。此探针经 `verify/stateOf/readState/collect`，**未**经 `audit-post` 入口。
- **回归测试应断言：** 未回答的 block 不带本次日期（`C_unanswered` 的日期不是 `2026-10-15`），且 `nextRunCap3` 含 C。

#### S14 = 调研 F34 [P1] 大于 512 KiB 的源码被静默排除

- **位置：** `src/audit-units.js:13`（`MAX_FILE = 512 * 1024`）、`:89`（`e.size <= MAX_FILE`）。**影响模式：** scan。
- **What this is / Problem:** 超过上限的源文件在进入 inventory 前被过滤；没有 limitation，meta 与 ctx 中都不出现。
- **Fix:** 把被跳过的文件及原因写入 `limitations`，并在 issue 摘要里体现。
- **If we skip it:** 最大的文件往往最复杂，却永远不被扫描，用户也看不到。
- **证据 S14：** `bigFileBytes=633787`、`inventoryRows=["src/small.js"]`、`limitationsFromInventory=[]`、`metaLimitations=[]`、`bigFileMentionedAnywhereInCtx=false`。与调研 F34 是同一问题，不重复计数。
- **回归测试应断言：** 超过 512 KiB 的源文件出现在 `limitations` 中并点名该文件（`limitationsFromInventory` 非空）。

### 3.3 P2

#### U2 [P2] 嵌套 `build/` 目录的变更被静默忽略

- **位置：** `src/collect.sh:27`（默认 IGNORES 含 `build/`）、`:84`。**影响模式：** PR。
- **What this is / Problem:** `build/` 匹配任一层级的路径段，所以 `internal/build/x.go`（真实 Go 源码）被忽略；整个 PR 只改它时 `skip=true`，输出 "nothing reviewable in diff"，`collect-limits.txt` 与 `diff-dropped.txt` 都是 0 字节，没有任何记录。
- **Fix:** 被默认 ignore 丢弃的文件写入 `diff-dropped.txt` 并在摘要里显示；或默认 ignore 只匹配仓库根的 `build/`。
- **If we skip it:** 目录恰好叫 `build` 的源码包永远得不到审查，也看不到原因。
- **证据 U2：** `outputs=["skip=false","partial=false","skip=true"]`、`stdout="nothing reviewable in diff"`、`collectLimitsBytes=0`、`diffDroppedBytes=0`；对照 `controlOutputs=["skip=false","partial=false"]`、`controlFiles="internal/other/y.go\n"`。
- **回归测试应断言：** `internal/build/x.go` 的变更要么被审查（`skip=false`），要么出现在 `diff-dropped.txt`（`diffDroppedBytes>0`）。

#### U4 [P2] `--fail-on-gaps` 对失败的运行返回 0

- **位置：** `bin/specguard-local.js:183–185`（`gaps`）、`:205`（`return o['fail-on-gaps'] && r.gaps ? 1 : 0`）。**影响模式：** local。
- **What this is / Problem:** 退出码只看 `gaps`。findings 不是合法 JSON 时 `status="failed"`、`gaps=false`，退出 0，summary 写 "Could not complete: no valid findings.json"。带 `unknown` 行与 `not_reviewed` 的不完整报告也是 0。USAGE 把它写成 advisory，所以这是行为边界，不是文档矛盾。
- **Fix:** `--fail-on-gaps` 在 `status` 非 `complete` 时也非零退出（或另加 `--fail-on-incomplete`）。
- **If we skip it:** 把它当 pre-push 闸的人，在审查失败时被放行。
- **证据 U4：** `failedRun={exit:0,status:"failed",gaps:false}`；`partialRun={exit:0,status:"complete",gaps:false}`（报告含 `unknown` 行，status 仍是 `complete`）。
- **回归测试应断言：** `status==="failed"` 时 `--fail-on-gaps` 的退出码非 0。

#### S1 / U12 [P2] 仅含排除项的 `test_paths` 被忽略（S1 与 U12 是同一问题）

- **位置：** `src/trace.js:535`（`testScope` 在没有 include 行时返回 `null`）；消费者 `src/collect.sh:252–253`、`src/audit-collect.js:47–51`、`src/audit-units.js:85–87`、`src/leads.js:286–287`、`src/test-map.js:137`。**影响模式：** PR、scan、local。
- **What this is / Problem:** `test_paths: "!tests/legacy/**"` 令 `testScope` 返回 `null`，等同未配置，各消费者回退到按文件名判断，排除不生效；`scan_paths` 用同样的 `!` 语法却生效。
- **Fix:** `testScope` 对只有排除项的配置返回"默认判断并排除"的函数；或在输入校验阶段拒绝并提示。
- **If we skip it:** 用户配置了排除，旧测试仍被当作证据。
- **证据 S1：** `testScopeForExclusionOnly=null`、`layoutHeaderShowsConfig=false`、`layoutLists="test directories: tests/legacy (1), tests/new (1)"`、`unitTestsColumn="tests/new/amount.test.js, tests/legacy/old.test.js"`；对照 `scan_paths`：`"tests/new/amount.test.js"`。**U12：** `scopeIsNull=true`、`legacyTestStillATest=true`。
- **回归测试应断言：** `testScope("!legacy/**")` 不为 `null`，`legacy/a.test.js` 不被当作测试；`unitTestsColumn` 不含 `tests/legacy/old.test.js`。

#### S12 [P2] 可复用 workflow 只转发 action 47 个输入中的 12 个

- **位置：** `.github/workflows/specguard.yml:14`（`workflow_call`）、`:36–37`（`uses: Mira190/SpecGuard@caa99fbbef...` 的 `with:`）。**影响模式：** PR、scan。
- **What this is / Problem:** `action.yml` 有 47 个输入，workflow 只转发 12 个。`workflow_call` 暴露的 7 个（`mode, requirements_paths, standards_paths, test_paths, scan_issue, model, effort`）都被转发，没有"暴露但未转发"。未转发的 35 个里重要的有：`engine`、`max_budget_usd`、`ignore`、`max_diff_kb`、`focus_threshold`、`focus_files`、`max_comments`、`standards_checks`、`standards_ref`、`coverage_files`、`resolve_stale`、`force`、`include_bots`、`fail_on_error`、`max_units`、`scan_paths`、`scan_issue_repo`、`scan_issue_token`、`scan_batch_blocks`、`audit_max_requirements`。通过可复用 workflow 使用的采用者无法设置它们；`force`（S13 的 preflight 逃生口）也在其中。
- **Fix:** 转发全部输入，或在 README 声明哪些只能直接使用 action。
- **If we skip it:** 采用者以为能调的开关，其实没有传进去。
- **证据 S12：** `actionInputs=47`、`forwarded=12`、`workflowCallInputsNotForwarded=[]`、`forwardedButNotDeclaredInAction=[]`、`actionInputsNotForwarded` 共 35 项（附录 A）；`pinnedActionRef={pin:"caa99fbbef",inputsAtPin:45}`，即 workflow 固定的 action 提交比 main 少 2 个输入。
- **回归测试应断言：** 转发的输入集合等于 `action.yml` 的输入集合（`actionInputsNotForwarded` 为空），或 README 列出的白名单与实际一致。

#### U9 [P2] skill 示例与边界规则矛盾

- **位置：** `skills/test-review/references/trace.md:44`、`skills/test-review/references/example.json:4`（`.github/skills/test-review/` 是字节相同的拷贝）。**影响模式：** PR。
- **What this is / Problem:** 规则要求两侧边界；示例却只用一条断言就判 `covered`。
  - trace.md:44：`A test must assert both sides of the boundary (n-1, n, n+1); if it does not, report `weak_test` for the missing boundary.`
  - example.json:4：`"obligation":"Orders of 100 or more get a 10% discount"`，`"evidence":[{"path":"test/discount.test.js","line":9,"quote":"assert.equal(discount(100), 90);"}]`，`"status":"covered"`，`"reason":"The unit test asserts the boundary 100 against the literal 90."`
- **Fix:** 示例改成两侧都有断言，或把该示例改为 `weak_test`；示例会被模型当作先例，应与规则一致。
- **If we skip it:** 模型更可能模仿示例：只有 `n` 一侧的断言就报 covered（影响程度未测，没有调用模型）。
- **证据 U9：** `evidenceAssertions=["assert.equal(discount(100)"]`，示例证据中只有这 1 条断言。
- **回归测试应断言：** `example.json` 的 `covered` 证据同时含边界两侧的断言，或该示例的状态为 `weak_test`。

### 3.4 P3：eval 指标与仓库自身标准

除 V1 外，这些只影响离线评估的数字，不影响 PR 或 scan 的运行结果。V1 是仓库自己的编码标准未被满足。

- **S9：** `eval/weekly-report.js:62–68` 与 `post.anchorTouched/testsChanged`（`src/post.js:1295`、`:1317`）规则不同。把 base 合并进 PR 分支后，weekly 判 `anchor_touched=true, tests_changed=true, outcome="addressed"`，post 规则判 `false/false/"open"`；评论所在文件被删除时，weekly 判 `addressed`，post 规则为 `anchor_touched=null`、`"not_observed"`。效果：base 合并会抬高 reviewer 的 "addressed" 率。 回归测试应断言：weekly 与 post 对同一输入给出相同的 `anchor_touched`/`tests_changed`（base 合并场景同为 `false/false`，删除文件同为 `null`）。
- **S10：** `eval/grade.js:96–104`、`:151`。同一个 missing_test 作为 summary item 出现时 `fp=1, clean_ok=false, pass=false`；只作为 coverage 行出现时 `fp=0, clean_ok=true, pass=true`。clean 用例的 FP 取决于该发现显示在哪里。与主报告 F29 相关（F29 是 TP 重复计数，S10 是 FP 漏计）。 回归测试应断言：clean 用例中，同一 missing_test 作为 summary item 或仅作为 coverage 行，`fp` 相同（`coverageRowOnly.fp===sameGapAsSummaryItem.fp`）。
- **U7：** `eval/bundle.js:37–60`。真实 `buildSummary` 的摘要含 `### Missing unit tests (2)`，但没有 "N more item(s)" details，`bundle.parseSummary` 返回 0 项（`bundleSummaryCount=0`）；`parseDropped` 返回 1 项（`bundleDroppedCount=1`），而摘要里有 2 行 `Dropped findings`。bundle 的计数与真实摘要不一致。 回归测试应断言：`bundle.parseSummary(summary).length` 等于摘要列出的 item 数（本例为 2）。
- **U8：** `eval/prove.js:443`。`results-prove.json` 写在共享的 `out` 目录，而不是各 case 目录；跑两个 case 后 `out` 下只有一份 `results-prove.json`，`perCaseResults=[false,false]`，多 case 互相覆盖。 回归测试应断言：每个 case 的 `results-prove.json` 在各自 case 目录里（`perCaseResults` 全为 `true`），`out` 根目录下没有该文件。
- **U10：** `eval/label-export.js:16`。`findingId` 不含 `kind`；同 path/line 的 `missing_test` 与 `weak_test` 得到相同 id `F502e6ddc0`，`exportRowIds=["F502e6ddc0","F502e6ddc0"]`，标注时互相覆盖。 回归测试应断言：`findingId(a)!==findingId(b)`（`kind` 不同），`exportRowIds` 无重复。
- **U11：** `eval/szz.js:91`。`.sql` 文件里被删除的 `-- header comment` 行以 `--- ` 开头，被当作 diff 文件头，旧侧行号丢失：含该注释时 `lines=[]`、`addOnly=true`；对照 `lines=[1,4]`、`addOnly=false`。SZZ 归因因此漏掉修复行。 回归测试应断言：含 `-- header comment` 的 `.sql` 的 `fixLines` 与对照一致（`lines` 含 4，`addOnly===false`）。
- **V2（新增，读 `eval/replay.js` 时发现）：** `eval/replay.js:85` 的行带 `findings_present`，`:90` 的表头没有这一列。模型没有写 `findings.json` 的 PR，在打印出来的表里是全 0 的一行，与"审查过、没有发现"无法区分。探针 V2：`row.findings_present=false`，`printedTable="pr          trace  inline  high  low  summary  pre-existing\nnofindings  auto   0       0     0    0        0"`，`tableMentionsFindingsPresent=false`。只影响回放的人工判读；修复是在表里加一列或标 `NO FINDINGS`。 回归测试应断言：`finish` 打印的表对 `findings_present===false` 的行有可见标记，且不与全 0 的正常行相同。
- **V1（新增，读 `.github/instructions/specguard.instructions.md` 时发现）：** 该文件第 8 行要求"每个导出函数都需要断言返回值或抛错的单元测试"。探针 V1 在 `src/*.js` 与 `eval/*.js` 的 43 个非测试文件中，找到 15 个文件共 34 个导出函数，没有任何 `*.test.js` 按名字提到（例：`src/post.js` 的 `assertionKind`、`counterexampleOk`、`citationsOf`、`loadCoverage`、`applyCoverage`、`coverageAtoms`、`findingBlock`、`findingHead`；`src/trace.js` 的 `testScope`、`catBatch`；`src/test-map.js` 的 `indexTests`、`noExt`、`classAndMethod`）；`src/limitations.js` 和 `src/scan-parts.js` 没有同名的 `.test.js`（标准要求测试"live next to the code"）。边界：按名字匹配，间接覆盖（例如经由 `post.js` 入口的测试）不会被识别，所以这是"没有直接单元测试"的上界，不是"完全未被测试"。SpecGuard 用同一标准审别人的仓库，自己不满足它。 回归测试应断言：每个导出函数至少被一个 `*.test.js` 按名引用并断言返回值（`filesWithUnreferencedExports` 为空，`exportingFilesWithoutSiblingTest` 为空）。

### 3.5 By design

#### S11 大 PR 的 hunk 被截断但状态仍是 complete：按设计，不记为缺陷

- **位置：** `src/post.js:1442`、`src/focus.js:1–8`（文件头注释）。
- **事实：** 3001 个变更行的单文件 PR 中，`changedLinesNotShownToModel=2495`，`runStatus="complete"`、`headMarker=true`；摘要显示 `Large PR: diffs of 1 large file was shortened in the prompt`，`cleanVerdict=false`（不显示 "No unit test gaps found"）。
- **为什么不记缺陷：** post.js:1442 的注释写明 `not reduced mode, not a failure: incomplete only when a changed file was left out, so the next push reviews again`；focus.js 头部写明 `a chosen file is never dropped for size`。这是明示的取舍，且用户可见。
- **可选改进（不计入缺陷）：** 若团队认为被截断的行里可能有未覆盖的义务，可以把 `shortened > 0` 提升为 incomplete。
- **回归测试应断言：** （保持现状）`shortened>0` 时摘要含 `Large PR` 横幅且 `cleanVerdict===false`。

## 4. 修复状态

主报告 F19–F29 的在审修复 PR：

| 发现 | PR | 说明 |
|---|---|---|
| F19、F20 | #201 | |
| F21、F25 | #203 | |
| F22、F23 | #202 | 叠在 #198 之上 |
| F24、F26 | #200 | |
| F27、F28 | #205 | 叠在 #198 之上 |
| F29 | #204 | |

另：#197 是"断言被删除后提升低置信度"的 raise fix，作用在 lead 之后，与 U5、U6 不重叠。

本补充各项的状态：

- **S5：** 正在 #201 第三轮修复（只有低置信度 finding 或 finding 被丢弃的 unit 记为 `unsure`，并推进日期以免轮转停滞），不是"未修复"。
- **S1 / U12：** 已在 #200 的 PR 描述里作为已知问题记录，修复未开始。
- **其余各项**（含 V1、V2）尚未修复，也没有已知的在审 PR。

建议顺序：

1. **第一组（PR 主路径，改动都小）：** U13（`AC-1:` 解析）和调研 F32（Gherkin `Background`）。修 F32 时，继承的 `Background` 必须同时进入 #203 引入的 `tv` 文本版本，否则修改前置条件后 scenario 不会过期。
2. **错误放心：** U1、S2、S7、S13。
3. **证据可见性：** U3、S3、S8。
4. **lead 覆盖面与 scan 状态：** U5、U6；S4、S6、S14（S5 在 #201）。
5. 其余按 P2、P3。

每项修复保留对应探针，把断言反过来作为回归测试；每项的"回归测试应断言"见 §3。

## 5. 附录

探针从 `ee1c158` 的 checkout 根目录运行：`node audit-supplement.cjs`、`node audit-supplement-2.cjs`（U 系列需要 Git bash 在 PATH 前，脚本头注释有说明）。U13 的验证命令见 §3.1。

### 附录 A：探针 S1–S14（audit-supplement.cjs）

<details>
<summary>展开脚本或结果</summary>

```javascript
// Supplementary audit probes S1-S14. Each probe asserts the CURRENT (suspected buggy) behaviour and returns the observed facts.
// Run from the repo root (or from .audit-probe/): node audit-supplement.cjs   (Git Bash on Windows). No network, no model: GitHub and gh are mocked.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const ROOT = process.env.SG_ROOT || (fs.existsSync(path.join(__dirname, 'src')) ? __dirname : path.join(__dirname, '..'));
const req = (p) => require(path.join(ROOT, p));
const execFileSync0 = cp.execFileSync; // the weekly-report probe patches execFileSync for 'gh' only
const ac = req('src/audit-collect'), ap = req('src/audit-post'), au = req('src/audit-units');
const post = req('src/post'), trace = req('src/trace'), packer = req('src/engines/claude-api'), scanParts = req('src/scan-parts');
const reqs = req('src/requirements'), preflight = req('src/preflight'), focus = req('src/focus');
const { grade, parseSummary } = req('eval/grade');
const results = [], roots = [];

// ---------- helpers ----------
function write(dir, file, content) { const p = path.join(dir, file); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, content); }
function git(dir, ...args) { return execFileSync0('git', ['-c', 'core.autocrlf=false', ...args], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
function commit(dir, msg = 'fixture') { git(dir, 'add', '-A'); git(dir, '-c', 'user.name=Probe', '-c', 'user.email=probe@example.invalid', 'commit', '-qm', msg); return git(dir, 'rev-parse', 'HEAD'); }
function fixture(files) { // a temp git repo under os.tmpdir(); removed (guarded) at the end
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-supp-'));
  roots.push(dir); git(dir, 'init', '-q', '-b', 'main');
  for (const [p, s] of Object.entries(files)) write(dir, p, s);
  const head = commit(dir);
  return { dir, head, ctx: path.join(dir, '.specguard-ctx') };
}
function cleanup() {
  for (const r of roots) {
    const p = fs.realpathSync(r), base = fs.realpathSync(os.tmpdir());
    if (!p.startsWith(base + path.sep) || !path.basename(p).startsWith('sg-supp-')) throw Error('unsafe cleanup path ' + p);
    fs.rmSync(p, { recursive: true, force: true });
  }
}
const pending = [];
function probe(id, fn) { pending.push([id, fn]); }
async function runAll() {
  for (const [id, fn] of pending) {
    try { const detail = await fn(); results.push({ id, reproduced: true, ...detail }); }
    catch (e) { results.push({ id, reproduced: false, error: e.stack.split('\n').slice(0, 4).join(' | ') }); process.exitCode = 1; }
  }
}
async function withEnv(values, fn) {
  const before = { ...process.env };
  try { Object.assign(process.env, values); return await fn(); }
  finally { for (const k of Object.keys(process.env)) if (!(k in before)) delete process.env[k]; Object.assign(process.env, before); }
}
const lineOf = (s) => s.split('\n');

// PR-mode post.js harness (same mocks as the earlier audit's P6). files: ctx files; returns the observed publication.
async function runPost(p, { files, pr: prOver = {}, env = {} }) {
  fs.mkdirSync(p.ctx, { recursive: true });
  for (const [n, v] of Object.entries(files)) fs.writeFileSync(path.join(p.ctx, n), typeof v === 'string' ? v : JSON.stringify(v));
  let summary = '', reviews = [], inline = [];
  const outputs = {}, warnings = [];
  const pr = { state: 'open', title: 'Probe PR', body: '', head: { sha: p.head }, base: { sha: p.head }, user: { login: 'dev', type: 'User' }, ...prOver };
  const gh = {
    paginate: async (fn, args) => (await fn(args)).data,
    graphql: async () => ({ repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [] } } } }),
    rest: {
      users: { getAuthenticated: async () => { throw Error('job token'); } },
      pulls: { get: async () => ({ data: pr }), listReviewComments: async () => ({ data: [] }), listFiles: async () => ({ data: [] }),
        createReview: async (a) => { reviews.push(a); return { data: {} }; }, createReviewComment: async (a) => { inline.push(a); return { data: { html_url: 'https://example.invalid/c' } }; } },
      issues: { listComments: async () => ({ data: [] }), createComment: async (a) => { summary = a.body; return {}; } },
    },
  };
  const core = { setOutput: (k, v) => { outputs[k] = v; }, warning: (s) => warnings.push(s), summary: { addRaw(s) { summary = s; return this; }, async write() {} } };
  await withEnv({ CTX: p.ctx, GITHUB_WORKSPACE: p.dir, HEAD_SHA: p.head, BASE_SHA: p.head, ENGINE: 'claude', MODEL: 'claude-sonnet-4-6', SKIP: 'false', PARTIAL: 'false', DELIVERY: '', STANDARDS_CHECKS: '', STANDARDS_REF: 'head', RESOLVE_STALE: 'false', ...env },
    () => post({ github: gh, core, context: { repo: { owner: 'o', repo: 'r' }, serverUrl: 'https://github.com', payload: { pull_request: { ...pr, number: 1 } } } }));
  let counts = null; try { counts = JSON.parse(fs.readFileSync(path.join(p.ctx, 'counts.json'), 'utf8')); } catch { /* none */ }
  return { summary, outputs, counts, warnings, inline, reviews, pr };
}
const cleanData = (b) => ({ requirements: [], requirements_source: 'PR body', not_reviewed: '',
  coverage: [{ id: 'O1', obligation: 'Increment the input', source: 'from behaviour', behaviour: b, change: b, evidence: [{ path: 'test.js', line: 1, quote: 'assert.equal(total(1), 2);', layer: 'unit', kind: 'assertion', proves: 'Increments one.' }], status: 'covered', reason: 'The assertion checks the increment.', alignment: { status: 'not_applicable', reason: 'No explicit requirement.' } }],
  findings: [], standards: { status: 'no_rules', sources: [], reason: 'No rule files.' }, layering: { status: 'checked', reason: 'No higher-layer tests.' } });
const SRC = 'exports.total = x => x + 1;\n', TEST = 'assert.equal(total(1), 2);\n';
const SRC_DIFF = 'diff --git a/src.js b/src.js\n--- a/src.js\n+++ b/src.js\n@@ -1 +1 @@\n-exports.total = x => x;\n+exports.total = x => x + 1;\n';
const BEH = { path: 'src.js', line: 1, quote: 'exports.total = x => x + 1;' };
const prFiles = (extra = {}) => ({ 'files.txt': 'src.js\n', 'diff.patch': SRC_DIFF, 'test-candidates.txt': 'src.js\n  test.js  (name match)\n', 'engine-status': 'success', 'requirements-status.json': { status: 'available', sources: ['PR body'], limitations: [], criteria: [] }, 'findings.json': cleanData(BEH), ...extra });
const prRepo = () => fixture({ 'src.js': SRC, 'test.js': TEST });

// ---------- S1 ----------
probe('S1-test-paths-exclusion-only', () => {
  const f = fixture({
    'docs/design.md': '# Design\n\nService must reject invalid amounts.\n',
    'src/amount.js': 'function amount(value) {\n  if (value < 0) throw new Error("neg");\n  return value >= 10;\n}\nmodule.exports = { amount };\n',
    'tests/legacy/old.test.js': 'test("legacy", () => { assert.equal(amount(10), true); });\n',
    'tests/new/amount.test.js': 'test("new", () => { assert.equal(amount(11), true); });\n',
  });
  const spec = '!tests/legacy/**';
  const ts = trace.testScope(spec);                       // null: no include line
  const sc = ac.__scopeFn || null;                        // scopeFn is not exported; replicate by calling collect(scanPaths) below
  assert.equal(ts, null);
  ac.collect({ cwd: f.dir, ctx: f.ctx, reqPaths: 'docs/design.md', testPaths: spec, maxUnits: 5 });
  const layout = fs.readFileSync(path.join(f.ctx, 'test-layout.txt'), 'utf8');
  const unitsTxt = fs.readFileSync(path.join(f.ctx, 'audit-units.txt'), 'utf8');
  assert(layout.includes('tests/legacy (1)')); assert(unitsTxt.includes('tests/legacy/old.test.js'));
  // contrast: the scan_paths scope (same '!' syntax) excludes it. collect() with scanPaths drops tests/legacy from the layout and the unit tests.
  ac.collect({ cwd: f.dir, ctx: f.ctx, reqPaths: 'docs/design.md', scanPaths: spec, maxUnits: 5 });
  const unitsScoped = fs.readFileSync(path.join(f.ctx, 'audit-units.txt'), 'utf8'), layoutScoped = fs.readFileSync(path.join(f.ctx, 'test-layout.txt'), 'utf8');
  assert(!unitsScoped.includes('tests/legacy/old.test.js')); assert(!layoutScoped.includes('tests/legacy'));
  // PR-mode consumers of the same helper
  const cover = require(path.join(ROOT, 'src/test-map')).makeCoverGuard({ cwd: f.dir, testPaths: spec });
  return { testScopeForExclusionOnly: ts, layoutHeaderShowsConfig: layout.includes('configured test locations'), layoutLists: layout.split('\n')[0], unitTestsColumn: unitsTxt.trim().split('\t')[4],
    scanPathsExclusionWorks: true, contrast: { unitTestsColumnWithScanPaths: unitsScoped.trim().split('\t')[4] }, level: 'collect() (audit-collect.collect) + trace.testScope' };
});

// ---------- S2 ----------
probe('S2-unreadable-closing-issue', async () => {
  const mk = (n) => ({ number: 5, title: 'Fix total', body: Array.from({ length: n }, (_, i) => `Fixes #${i + 7}`).join('\n'), headRefName: 'fix', labels: [] });
  const err = (s) => Object.assign(new Error(`HTTP ${s}`), { status: s });
  const unreadable = reqs.collectRequirements({ pr: mk(1), repo: 'o/r', commits: '', history: { shas: [], pulls: () => [], pr: () => null }, loadIssue: () => { throw err(403); } });
  const capped = reqs.collectRequirements({ pr: mk(6), repo: 'o/r', commits: '', history: { shas: [], pulls: () => [], pr: () => null }, loadIssue: (r, n) => ({ title: `T${n}`, body: `It must work ${n}.`, url: `https://github.com/o/r/issues/${n}`, labels: [], comments: [] }) });
  const lim = require(path.join(ROOT, 'src/limitations'));
  const kinds = (r) => r.limitations.map((l) => ({ l, fact: lim.isFactLimitation(l) }));
  const run = async (status) => { const p = prRepo(); return runPost(p, { files: prFiles({ 'requirements-status.json': status }) }); };
  const a = await run(unreadable), b = await run(capped);
  assert.equal(a.outputs.status, 'complete'); assert(a.summary.includes('<!-- specguard:head=')); assert(/Could not read issue #7/.test(a.summary));
  assert.equal(b.outputs.status, 'incomplete'); assert(!b.summary.includes('<!-- specguard:head='));
  const head = (s) => (/^\*\*(.+)\*\*$/m.exec(s) || [])[1];
  const sk = preflight.decide({ pr: a.pr, comments: [{ user: { type: 'Bot', login: 'github-actions[bot]' }, body: a.summary }], headSha: a.pr.head.sha });
  return { unreadableClosing: { status: unreadable.status, limitations: kinds(unreadable), sources: unreadable.sources, run: { status: a.outputs.status, complete: a.counts.complete, execution_complete: a.counts.execution_complete, headline: head(a.summary), noUnitTestGapsFound: a.summary.includes('No unit test gaps found'), unreadableNoteOnlyIn: 'Details > Not reviewed (1 item)', headMarker: true, nextPushSkipped: !!sk } },
    cappedClosing: { status: capped.status, limitations: kinds(capped).slice(0, 2), run: { status: b.outputs.status, complete: b.counts.complete, headline: head(b.summary), headMarker: b.summary.includes('<!-- specguard:head=') } },
    level: 'requirements.collectRequirements (real) -> post.js entry (mocked GitHub)' };
});

// ---------- S3 ----------
probe('S3-shared-test-file-seen-dedupe', () => {
  const tests = [], pad = 'x'.repeat(100);
  for (let i = 0; i < 400; i++) tests.push(`test('filler ${i}', () => { assert.equal(filler${i}(1), ${i}); }); // ${pad}`);
  tests.splice(100, 0, `test('alpha', () => {\n  assert.equal(alphaThing(1), 111);\n});`);
  tests.splice(300, 0, `test('beta', () => {\n  assert.equal(betaThing(2), 222);\n});`);
  const f = fixture({ 'src/a.js': 'function alphaThing(v) { return v + 110; }\nmodule.exports = { alphaThing };\n', 'src/b.js': 'function betaThing(v) { return v + 220; }\nmodule.exports = { betaThing };\n', 'tests/shared.test.js': tests.join('\n') + '\n' });
  const size = fs.statSync(path.join(f.dir, 'tests/shared.test.js')).size;
  const ctx = f.ctx; fs.mkdirSync(ctx);
  const diff = (p, fn) => `diff --git a/${p} b/${p}\n--- a/${p}\n+++ b/${p}\n@@ -0,0 +1,2 @@\n+function ${fn}(v) { return v; }\n+module.exports = { ${fn} };\n`;
  write(ctx, 'files.txt', 'src/a.js\nsrc/b.js\n'); write(ctx, 'diff.patch', diff('src/a.js', 'alphaThing') + diff('src/b.js', 'betaThing'));
  write(ctx, 'test-candidates.txt', 'src/a.js\n  tests/shared.test.js  (name)\nsrc/b.js\n  tests/shared.test.js  (name)\n');
  const pack = packer.contextPack(ctx, f.dir, 250000);
  const t = pack.text;
  assert(size > 41666); assert(t.includes('assert.equal(alphaThing(1), 111)')); assert(!t.includes('assert.equal(betaThing(2), 222)'));
  assert.deepEqual(pack.notWhole, []);
  return { testFileBytes: size, perFileCap: 41666, aAssertionInPack: true, bAssertionInPack: false, notWhole: pack.notWhole, testBlockCount: (t.match(/tests\/shared\.test\.js/g) || []).length, level: 'engines/claude-api.contextPack (real)' };
});

// ---------- S4 ----------
probe('S4-ev-per-block-cap', () => {
  const files = { 'docs/design.md': '# Design\n\n## Rule\nService must reject invalid amounts.\n' };
  for (let i = 1; i <= 5; i++) { files[`src/c${i}.js`] = `function c${i}(v) {\n  return v + ${i};\n}\nmodule.exports = { c${i} };\n`; }
  for (let i = 1; i <= 4; i++) { files[`tests/t${i}.test.js`] = `test('t${i}', () => { assert.equal(${i}, ${i}); });\n`; }
  const f = fixture(files);
  const blocks = ac.allBlocks(f.dir, f.head, ['docs/design.md']); assert.equal(blocks.length, 1);
  const cid = blocks[0].cid, cited = [1, 2, 3, 4, 5].map((i) => `src/c${i}.js`).concat([1, 2, 3, 4].map((i) => `tests/t${i}.test.js`)); // 9 files
  const rows = cited.map((p) => ({ path: p, line: 1, quote: 'x' }));
  const data = { requirements: [{ id: cid, source: { path: 'docs/design.md', line: 4, quote: 'x' }, text: 'x', class: 'unit', status: 'covered', code: rows.slice(0, 5), tests: rows.slice(5).map((r) => ({ ...r, layer: 'unit' })), note: '' }], not_requirements: [], not_reviewed: [], docs_reviewed: [], unit_findings: [] };
  const raw = ap.stateOf(f.head, data, null, { date: '2026-10-01' }).raw;
  const prior = ap.readState(raw);
  const h8 = (p) => crypto.createHash('sha1').update(p).digest('hex').slice(0, 8);
  assert.equal(prior.versions.ev[cid].length, 8); assert(!prior.versions.ev[cid].includes(h8(cited[8])));
  const stale = (edit) => { write(f.dir, edit, fs.readFileSync(path.join(f.dir, edit), 'utf8') + '// edited\n'); commit(f.dir, 'edit ' + edit); ac.collect({ cwd: f.dir, ctx: f.ctx, reqPaths: 'docs/design.md', prior, rotate: true, maxUnits: 1 }); return fs.readFileSync(path.join(f.ctx, 'audit-stale.txt'), 'utf8').includes(cid); };
  // prior.blocks[].at.head must be the audited commit: stateOf recorded it as f.head.slice(0,7)
  const ninth = stale(cited[8]);                 // edit ONLY the 9th cited file
  const first = stale(cited[0]);                 // control: edit the 1st cited file
  assert.equal(ninth, false); assert.equal(first, true);
  return { citedFiles: cited.length, storedHashes: prior.versions.ev[cid].length, ninthFileEdited_blockStale: ninth, firstFileEdited_blockStale: first, level: 'audit-post.stateOf/readState + audit-collect.collect (real)' };
});

// ---------- S5 + S6 helper: audit-post main with the code-first fixture ----------
async function runScan(unitFindings, { priorBody = null } = {}) {
  const s = fixture({ 'src/amount.js': 'exports.positive = v => v > 0;\nexports.negative = v => v < 0;\nexports.zero = v => v === 0;\n' });
  fs.mkdirSync(s.ctx);
  const put = (n, v) => fs.writeFileSync(path.join(s.ctx, n), typeof v === 'string' ? v : JSON.stringify(v));
  const id = au.sha8('src/amount.js');
  put('audit-meta.json', { head: s.head, max_requirements: 80, units: { total: 1, picked: 1 }, docs: 0, candidates: 0, rotation: { rotate: true, picked: 0 }, limitations: [] });
  put('audit-units.txt', `${id}\tsrc/amount.js\t10\tno test\tnone\t-\tabcdef12\t-\n`);
  put('audit-inventory.json', { units: 1, max_units: 1, selected: { units: 1, without_tests: 1 }, rotation: { picked: 1, total: 1, reviewed: 1 }, rows: [{ id, path: 'src/amount.js', score: 10, tests: [], why: 'no test' }], unreviewed: [] });
  put('engine-status', 'success'); put('pack-cut.txt', '');
  put('findings.json', { requirements: [], not_requirements: [], not_reviewed: [], docs_reviewed: [], unit_findings: unitFindings(id) });
  let issueBody = '', summary = ''; const outputs = {};
  const github = { paginate: async (fn) => fn(), rest: { users: { getAuthenticated: async () => { throw Error('job token'); } }, issues: { listForRepo: async () => [], create: async (a) => { issueBody = a.body; } } } };
  const core = { setOutput: (k, v) => { outputs[k] = v; }, warning: () => {}, summary: { addRaw(x) { summary = x; return this; }, async write() {} } };
  await withEnv({ CTX: s.ctx, GITHUB_WORKSPACE: s.dir, SCAN_ISSUE: 'true', ISSUE_REPO: '', SKIP: 'false', ENGINE: 'claude' }, () => ap({ github, core, context: { repo: { owner: 'org', repo: 'source' }, sha: s.head } }));
  const audit = JSON.parse(fs.readFileSync(path.join(s.ctx, 'audit.json'), 'utf8'));
  return { outputs, state: ap.readState(issueBody), audit, summary, id };
}
probe('S5-low-confidence-unit-covered', async () => {
  const f = (id, extra = {}) => [{ unit: id, kind: 'missing_test', path: 'src/amount.js', line: 1, quote: 'exports.positive = v => v > 0;', title: 'positive has no test', body: 'b', ...extra }];
  const low = await runScan((id) => f(id));                                                         // no skeleton: low confidence
  const high = await runScan((id) => f(id, { skeleton: "test('positive', () => { assert.equal(positive(1), true); });", body: 'Add a test for positive.' })); // control: sketch present
  const lowState = low.state.blocks[0].status, highState = high.state.blocks[0].status;
  assert.equal(low.audit.unit_findings[0].low, true); assert.equal(lowState, 'covered'); assert.equal(highState, 'gap');
  return { lowFinding: { low: low.audit.unit_findings[0].low, lowWhy: low.audit.unit_findings[0].lowWhy, status: low.outputs.status, unitStateInIssue: lowState }, control: { low: high.audit.unit_findings[0].low, unitStateInIssue: highState }, level: 'audit-post main entry (mocked GitHub)' };
});

// ---------- S6 ----------
probe('S6-unanswered-blocks-today-date', () => {
  const files = { 'docs/design.md': '# D\n\n## A\nService must reject negative amounts.\n\n## B\nService must reject blank names.\n\n## C\nService must round totals half up.\n\n## D\nService must log every refund.\n', 'src/x.js': 'exports.x = () => 1;\n', 'tests/x.test.js': 'assert.equal(x(), 1);\n' };
  const f = fixture(files);
  const blocks = ac.allBlocks(f.dir, f.head, ['docs/design.md']); assert.equal(blocks.length, 4);
  const [A, B, C, D] = blocks;
  const covered = (b) => ({ id: b.cid, source: { path: b.path, line: b.line, quote: b.text }, text: b.text, class: 'unit', status: 'covered', code: [{ path: 'src/x.js', line: 1, quote: 'exports.x = () => 1;' }], tests: [{ path: 'tests/x.test.js', line: 1, quote: 'assert.equal(x(), 1);', layer: 'unit' }], note: '' });
  const base = { not_requirements: [], not_reviewed: [], docs_reviewed: [], unit_findings: [] };
  // run 1 (2026-10-01): all four audited and covered
  const s1 = ap.readState(ap.stateOf(f.head, { ...base, requirements: blocks.map(covered) }, null, { date: '2026-10-01' }).raw);
  // run 2 (2026-10-15): A, B, C were sent; the model answers A and B only. D was not sent (carried with its 2026-10-01 date).
  const cands = ap.readCandidates([A, B, C].map((b) => `${b.cid}\t${b.path}:${b.line}\t${b.heading}\t${b.text}`).join('\n') + '\n');
  const read = (p) => { try { return fs.readFileSync(path.join(f.dir, p), 'utf8').split('\n'); } catch { return null; } };
  const verified = ap.verify({ ...base, requirements: [A, B].map(covered) }, { read, cands, docs: new Set(['docs/design.md']) });
  const cRow = verified.requirements.find((r) => r.id === C.cid);
  assert(cRow && cRow.status === 'unknown' && /did not assess/.test(cRow.note));
  const s2 = ap.readState(ap.stateOf(f.head, verified, s1, { date: '2026-10-15', carried: [s1.blocks.find((b) => b.cid === D.cid)] }).raw);
  const dateOf = (cid) => (s2.blocks.find((b) => b.cid === cid).at || {}).date, statusOf = (cid) => s2.blocks.find((b) => b.cid === cid).status;
  assert.equal(dateOf(C.cid), '2026-10-15'); assert.equal(statusOf(C.cid), 'unsure');
  // run 3: which blocks are audited first? cap 1, then cap 3
  const order = (cap) => { ac.collect({ cwd: f.dir, ctx: f.ctx, reqPaths: 'docs/design.md', maxRequirements: cap, maxUnits: 1, prior: s2, rotate: true }); return fs.readFileSync(path.join(f.ctx, 'audit-candidates.txt'), 'utf8').trim().split('\n').map((l) => l.split('\t')[0]); };
  const name = new Map([[A.cid, 'A'], [B.cid, 'B'], [C.cid, 'C'], [D.cid, 'D']]);
  const one = order(1).map((c) => name.get(c)), three = order(3).map((c) => name.get(c));
  assert.deepEqual(one, ['D']); assert(!three.includes('C'));
  return { stored: { A: [statusOf(A.cid), dateOf(A.cid)], B: [statusOf(B.cid), dateOf(B.cid)], C_unanswered: [statusOf(C.cid), dateOf(C.cid)], D_not_sent: [statusOf(D.cid), dateOf(D.cid)] }, nextRunCap1: one, nextRunCap3: three,
    note: 'cap 3 picks D (old), A, B (answered, covered 10-15) and leaves C (never answered) out; the oldest-first tier sorts by the stored date', level: 'audit-post.verify/stateOf/readState + audit-collect.collect (real); not through audit-post main' };
});

// ---------- S7 ----------
probe('S7-pack-error-leaves-no-pack-cut', async () => {
  const out = {};
  // (a) single-call path: GITHUB_WORKSPACE points at a path that does not exist, so root() (realpathSync) throws inside the pack try/catch
  const p = prRepo(); fs.mkdirSync(p.ctx, { recursive: true });
  const ctx = p.ctx; write(ctx, 'diff.patch', SRC_DIFF); write(ctx, 'files.txt', 'src.js\n'); write(ctx, 'test-candidates.txt', 'src.js\n  test.js  (name)\n');
  write(ctx, 'prompt.txt', 'Review.\n\n---\n\nContext directory (absolute path): ' + ctx + '\n');
  const body = JSON.stringify(cleanData(BEH));
  const fetchFn = async () => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ model: 'claude-sonnet-4-6', stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 10 }, content: [{ type: 'text', text: body }] }) });
  await packer.run({ CTX: ctx, PROMPT_FILE: path.join(ctx, 'prompt.txt'), ANTHROPIC_API_KEY: 'sk-ant-probe', MODEL: 'claude-sonnet-4-6', GITHUB_WORKSPACE: path.join(os.tmpdir(), 'sg-supp-does-not-exist') }, { fetchFn });
  const had = fs.readdirSync(ctx);
  out.engine = { status: fs.existsSync(path.join(ctx, 'engine-status')) ? fs.readFileSync(path.join(ctx, 'engine-status'), 'utf8') : 'success (no engine-status file)', packCutFile: had.includes('pack-cut.txt'), findingsWritten: had.includes('findings.json'), notes: fs.readFileSync(path.join(ctx, 'engine-notes'), 'utf8').trim() || '(none)' };
  assert(!had.includes('pack-cut.txt')); assert(had.includes('findings.json'));
  // post.js on that ctx vs on a ctx whose pack-cut.txt names the candidate test: a missing_test finding stays high only in the first
  const finding = { kind: 'missing_test', obligation_ids: ['O1'], ...BEH, title: 'Verify total', body: 'Add assert.equal(total(1), 2).', confidence: 'high' };
  const miss = () => ({ ...cleanData(BEH), coverage: [{ ...cleanData(BEH).coverage[0], status: 'missing_test', evidence: [] }], findings: [finding] });
  const noCut = await runPost(prRepo(), { files: prFiles({ 'findings.json': miss() }) });
  const withCut = await runPost(prRepo(), { files: prFiles({ 'findings.json': miss(), 'pack-cut.txt': 'test.js\n' }) });
  const countHigh = (r) => r.inline.length + r.reviews.reduce((a, x) => a + (x.comments || []).length, 0);
  out.postNoPackCut = { status: noCut.outputs.status, postedHighConfidence: countHigh(noCut), lowConfidenceNote: /partly visible/.test(noCut.summary) };
  out.postPackCutNamesTest = { status: withCut.outputs.status, postedHighConfidence: countHigh(withCut), lowConfidenceNote: /partly visible/.test(withCut.summary) };
  assert(!out.postNoPackCut.lowConfidenceNote); assert(out.postPackCutNamesTest.lowConfidenceNote);
  // (b) scan-parts path: contextPack throws -> plan() swallows it and packCut is [] (claude-api then writes an EMPTY pack-cut.txt)
  const s = fixture({ 'src/a.js': 'x\n' }); fs.mkdirSync(s.ctx);
  write(s.ctx, 'audit-units.txt', 'aaaaaaaa\tsrc/a.js\t5\tno test\tnone\t-\tabcdef12\t-\n');
  write(s.ctx, 'audit-candidates.txt', Array.from({ length: 21 }, (_, i) => `${i.toString(16).padStart(8, '0')}\td.md:${i + 1}\tH\ttext`).join('\n') + '\n');
  const plan = scanParts.plan({ ctx: s.ctx, root: s.dir, batch: 20, limit: 250000, schemaFile: path.join(ROOT, 'src/audit.schema.json'), contextPack: () => { throw new Error('injected pack failure'); }, windowPack: packer.windowPack, assembleAudit: req('src/prompt').assembleAudit });
  out.scanParts = { parts: plan.parts.length, unitPackText: plan.parts[0].pack.text, packCut: plan.packCut };
  assert.deepEqual(plan.packCut, []);
  out.injected = '(a) GITHUB_WORKSPACE -> nonexistent dir so claude-api run() root() throws; (b) stubbed contextPack that throws, passed to scan-parts.plan';
  out.level = '(a) engines/claude-api.run entry (mocked fetch) + post.js entry; (b) scan-parts.plan internal';
  return out;
});

// ---------- S8 ----------
probe('S8-findline-prefix20', () => {
  const lines = ['test("x", () => {', '  assert.equal(compute(1), 3);', '});'];
  const at = (l) => lines[l - 1], all = [1, 2, 3];
  const brief = post.findLine('assert.equal(f(1), 2)', 2, (l) => ['', 'assert.equal(f(1), 3)'][l - 1], [1, 2]);       // the quote from the brief: exactly 20 non-space chars
  const longer = post.findLine('assert.equal(compute(1), 2)', 2, at, all);
  assert.equal(brief, 0); assert.equal(longer, 2);
  // through verifyEvidence (the real PR-mode citation check): the evidence row is "verified" and its quote is rewritten
  const ev = { path: 'test.js', line: 2, quote: 'assert.equal(compute(1), 2)', layer: 'unit', kind: 'assertion', proves: 'p' };
  const b = { path: 'src.js', line: 1, quote: 'x' };
  const data = { requirements: [], coverage: [{ id: 'O1', obligation: 'o', source: 'from behaviour', behaviour: null, change: null, evidence: [ev], status: 'covered', reason: 'r', alignment: { status: 'not_applicable', reason: 'r' } }], findings: [], standards: { status: 'no_rules', sources: [], reason: 'r' }, layering: { status: 'checked', reason: 'r' }, validation_notes: [] };
  const read = (p) => (p === 'test.js' ? lines : null);
  post.verifyEvidence(data, new Set(['src.js']), new Set(), read, new Map());
  const c = data.coverage[0];
  assert.equal(c.evidence[0].quote, 'assert.equal(compute(1), 3);'); assert.equal(c.status, 'covered');
  return { briefQuoteLiteral: { quote: 'assert.equal(f(1), 2)', matchesLine: brief, why: 'exactly 20 non-space characters, so the prefix is the whole quote and the different tail fails' },
    longerQuote: { quote: 'assert.equal(compute(1), 2)', line: 'assert.equal(compute(1), 3);', findLine: longer }, verifyEvidence: { status: c.status, evidenceQuoteAfter: c.evidence[0].quote, noteOrDowngrade: data.validation_notes }, level: 'post.findLine + post.verifyEvidence (internal, real)' };
});

// ---------- S9 ----------
probe('S9-weekly-vs-post-anchor-rule', async () => {
  const W = require(path.join(ROOT, 'eval/weekly-report'));
  const f = fixture({ 'src/a.js': Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join('\n') + '\n', 'src/gone.js': 'a\nb\nc\nd\ne\nf\n' });
  const base = f.head;
  git(f.dir, 'checkout', '-q', '-b', 'pr'); write(f.dir, 'README.md', 'pr work\n'); const orig = commit(f.dir, 'pr work (comment anchored here)');
  git(f.dir, 'checkout', '-q', 'main'); write(f.dir, 'src/a.js', fs.readFileSync(path.join(f.dir, 'src/a.js'), 'utf8').replace('line 5', 'line 5 CHANGED ON MAIN')); write(f.dir, 'tests/base.test.js', 'assert(1)\n'); commit(f.dir, 'main: edits the anchor file and adds a test');
  git(f.dir, 'checkout', '-q', 'pr'); git(f.dir, '-c', 'user.name=Probe', '-c', 'user.email=p@e.invalid', 'merge', '-q', '--no-edit', 'main'); const merged = git(f.dir, 'rev-parse', 'HEAD');
  git(f.dir, 'rm', '-q', 'src/gone.js'); const deleted = commit(f.dir, 'pr deletes gone.js');
  // GitHub compare mock: files between two commits, with status and patch (what the compare API returns)
  const compareFiles = (a, b) => git(f.dir, 'diff', '--name-status', '--no-renames', a, b).split('\n').filter(Boolean).map((l) => {
    const [s, name] = l.split('\t'); const d = git(f.dir, 'diff', '--no-renames', '-U3', a, b, '--', name); const i = d.indexOf('\n@@');
    return { filename: name, status: s === 'D' ? 'removed' : s === 'A' ? 'added' : 'modified', patch: i < 0 ? undefined : d.slice(i + 1) };
  });
  const comment = (id, path_, line, commit_id) => ({ id, user: { login: 'copilot-pull-request-reviewer[bot]', type: 'Bot' }, pull_request_url: 'https://api.github.com/repos/o/r/pulls/1', path: path_, line, original_line: line, original_commit_id: commit_id, body: 'x' });
  const cmts = [comment(11, 'src/a.js', 5, orig), comment(12, 'src/gone.js', 3, merged)];
  let head = merged;
  const fakeGh = (args) => {
    const a = args.join(' ');
    if (a.includes('search/issues')) return JSON.stringify([{ number: 1, created_at: '2026-10-10T00:00:00Z', closed_at: null, pull_request: { merged_at: null }, user: { login: 'dev', type: 'User' }, labels: [] }]);
    if (a.includes('issues/comments')) return '[]';
    if (a.includes('pulls/comments')) return JSON.stringify(cmts);
    if (a.includes('graphql')) return JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes: cmts.map((c) => ({ isResolved: false, resolvedBy: null, comments: { nodes: [{ databaseId: c.id, author: { login: c.user.login } }] } })) } } } } });
    const m = /compare\/(\w+)\.\.\.(\w+)/.exec(a); if (m) return JSON.stringify({ files: compareFiles(m[1], m[2]) });
    if (/repos\/o\/r\/pulls\/1$/.test(a)) return JSON.stringify({ head: { sha: head } });
    throw new Error('unexpected gh call: ' + a);
  };
  const real = cp.execFileSync;
  const resultFor = async (headSha) => { // weekly-report resolves the head once per PR; run the loader for each scenario's head
    head = headSha; cp.execFileSync = (cmd, args, opts) => (cmd === 'gh' ? fakeGh(args) : real(cmd, args, opts));
    try { delete require.cache[require.resolve(path.join(ROOT, 'eval/weekly-report'))]; const WR = require(path.join(ROOT, 'eval/weekly-report')); return WR.load({ repo: 'o/r', since: '2026-10-01', until: '2026-10-16' }); }
    finally { cp.execFileSync = real; }
  };
  // (a) comment on src/a.js@orig, head = merge commit of main into the PR branch
  const dsA = await resultFor(merged);
  const cA = dsA.review_comments.find((c) => c.id === 11);
  const postA = { anchor_touched: post.anchorTouched(orig, merged, 'src/a.js', 5, 5, f.dir), tests_changed: post.testsChanged(orig, merged, f.dir) };
  // (b) comment on src/gone.js@merged, head = the commit that deletes the file
  cmts[1].original_commit_id = merged;
  const dsB = await resultFor(deleted);
  const cB = dsB.review_comments.find((c) => c.id === 12);
  const postB = { anchor_touched: post.anchorTouched(merged, deleted, 'src/gone.js', 3, 3, f.dir), tests_changed: post.testsChanged(merged, deleted, f.dir) };
  const outcome = (c, thread) => W.copilotOutcome({ thread, anchor_touched: c.anchor_touched, tests_changed: c.tests_changed });
  const open = { isResolved: false };
  const o = {
    a_baseMerge: { weekly: { anchor_touched: cA.anchor_touched, tests_changed: cA.tests_changed, outcome: outcome(cA, open) }, postRule: { ...postA, outcome: W.copilotOutcome({ thread: open, ...postA }) } },
    b_deletedFile: { weekly: { anchor_touched: cB.anchor_touched, tests_changed: cB.tests_changed, outcome: outcome(cB, open) }, postRule: { ...postB, outcome: W.copilotOutcome({ thread: open, ...postB }) } },
  };
  assert.equal(o.a_baseMerge.weekly.anchor_touched, true); assert.equal(o.a_baseMerge.postRule.anchor_touched, false);
  assert.equal(o.a_baseMerge.weekly.tests_changed, true); assert.equal(o.a_baseMerge.postRule.tests_changed, false);
  assert.equal(o.b_deletedFile.weekly.anchor_touched, true); assert.equal(o.b_deletedFile.postRule.anchor_touched, null);
  return { ...o, level: 'eval/weekly-report.load (real, gh mocked at execFileSync with compare data from a real git repo) vs post.anchorTouched/testsChanged (real)' };
});

// ---------- S10 ----------
probe('S10-wrong-coverage-row-no-fp', () => {
  const b = { path: 'a.js', line: 10, quote: 'return boundary(value);' };
  const mk = (findings, items) => post.buildSummary({ cov: { reports: 0 }, data: { requirements: [], requirements_source: 'none', not_reviewed: '', coverage: [{ id: 'O1', obligation: 'Boundary A', source: 'from behaviour', behaviour: b, change: b, evidence: [], status: 'missing_test', reason: 'No test', alignment: { status: 'not_applicable', reason: 'No explicit requirement' } }], findings, standards: { status: 'no_rules', sources: [], reason: 'None' }, layering: { status: 'checked', reason: 'No higher layer tests' } }, items, notes: [], blob: 'https://github.com/example/repo/blob/abc/' });
  const rowOnly = mk([], []);
  const parsed = parseSummary(rowOnly);
  const g = grade({ id: 'clean', goal: 'requirements', expected: { findings: [], expect_clean: true } }, { comments: [], reviews: [], summary: rowOnly });
  const f = { kind: 'missing_test', path: 'a.js', line: 10, title: 'Boundary A', body: 'Missing assertion', confidence: 'high', obligation_ids: ['O1'] };
  const asItem = mk([f], [{ f, why: 'not on diff' }]);
  const gi = grade({ id: 'clean', goal: 'requirements', expected: { findings: [], expect_clean: true } }, { comments: [], reviews: [], summary: asItem });
  assert.equal(parsed.rows.length, 1); assert.equal(parsed.rows[0].status, 'missing_test'); assert.equal(g.fp, 0); assert.equal(g.clean_ok, true); assert.equal(g.pass, true); assert(gi.fp >= 1);
  return { coverageRowOnly: { parsedRows: parsed.rows.map((r) => ({ status: r.status, path: r.path, line: r.line })), fp: g.fp, clean_ok: g.clean_ok, pass: g.pass }, sameGapAsSummaryItem: { fp: gi.fp, clean_ok: gi.clean_ok, pass: gi.pass }, level: 'post.buildSummary (real) + eval/grade.grade (real)' };
});

// ---------- S11 ----------
probe('S11-trimmed-hunks-still-complete', async () => {
  const big = Array.from({ length: 3000 }, (_, i) => `+  const v${i} = compute(${i}); // ${'p'.repeat(40)}`).join('\n');
  const patch = `diff --git a/src.js b/src.js\n--- a/src.js\n+++ b/src.js\n@@ -1 +1,3000 @@\n-exports.total = x => x;\n${big}\n`;
  const p = prRepo(); fs.mkdirSync(p.ctx, { recursive: true });
  write(p.ctx, 'diff.patch', patch); write(p.ctx, 'files.txt', 'src.js\n'); write(p.ctx, 'test-candidates.txt', 'src.js\n  test.js  (name)\n');
  const r = focus.main(p.ctx, { FOCUS_THRESHOLD: '100,1', FOCUS_FILES: '12', FOCUS_ROOT: p.dir });
  assert(r.focused); assert.equal(r.skipped.length, 0);
  const numbered = fs.readFileSync(path.join(p.ctx, 'diff.numbered.txt'), 'utf8');
  const marker = /^… (\d+) more changed lines in this file not shown/m.exec(numbered);
  assert(marker);
  const run = await runPost(p, { files: { 'engine-status': 'success', 'requirements-status.json': { status: 'available', sources: ['PR body'], limitations: [], criteria: [] }, 'findings.json': cleanData(BEH) } });
  assert.equal(run.outputs.status, 'complete'); assert(run.summary.includes('<!-- specguard:head='));
  const banner = /Large PR: diffs of [^\n]*/.exec(run.summary);
  return { changedLines: 3001, filesChosen: r.chosen.length, filesSkipped: r.skipped.length, changedLinesNotShownToModel: +marker[1], runStatus: run.outputs.status, complete: run.counts.complete, headMarker: true, cleanVerdict: run.summary.includes('No unit test gaps found'), visibleBanner: banner ? banner[0] : null, level: 'focus.main (real) -> post.js entry (mocked GitHub)' };
});

// ---------- S12 ----------
probe('S12-workflow-input-forwarding', () => {
  const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
  const inputsOf = (text) => { const m = /^inputs:\n([\s\S]*?)^\S/m.exec(text.replace(/\r/g, '') + '\nz'); return [...m[1].matchAll(/^  ([a-z_]+):/gm)].map((x) => x[1]); };
  const action = inputsOf(read('action.yml'));
  const wfText = read('.github/workflows/specguard.yml').replace(/\r/g, '');
  const withBlock = /uses: Mira190\/SpecGuard@[^\n]*\n\s+with:\n([\s\S]*)$/.exec(wfText)[1];
  const forwarded = [...withBlock.matchAll(/^\s+([a-z_]+):/gm)].map((x) => x[1]);
  const callInputs = (() => { const m = /workflow_call:\n\s+inputs:\n([\s\S]*?)\n\s+secrets:/.exec(wfText)[1]; return [...m.matchAll(/^      ([a-z_]+):/gm)].map((x) => x[1]); })();
  const notForwarded = action.filter((i) => !forwarded.includes(i));
  const exposedNotForwarded = callInputs.filter((i) => !forwarded.includes(i));
  const forwardedNotDeclared = forwarded.filter((i) => !action.includes(i));
  let atPin = null;
  try {
    const pin = /uses: Mira190\/SpecGuard@([0-9a-f]{40})/.exec(wfText)[1];
    const old = git(ROOT, 'show', `${pin}:action.yml`);
    atPin = { pin: pin.slice(0, 10), inputsAtPin: inputsOf(old).length };
  } catch (e) { atPin = 'pinned commit not in this clone'; }
  assert(notForwarded.length > 0);
  return { actionInputs: action.length, forwarded: forwarded.length, workflowCallInputs: callInputs, workflowCallInputsNotForwarded: exposedNotForwarded, forwardedButNotDeclaredInAction: forwardedNotDeclared, actionInputsNotForwarded: notForwarded, pinnedActionRef: atPin, level: 'static parse of action.yml and .github/workflows/specguard.yml' };
});

// ---------- S13 ----------
probe('S13-preflight-skip-key', async () => {
  const p = prRepo();
  const r = await runPost(p, { files: prFiles() }); // a real SpecGuard summary for head H
  const markers = [...r.summary.matchAll(/<!-- specguard:([a-z]+)/g)].map((m) => m[1]);
  const comments = [{ user: { type: 'Bot', login: 'github-actions[bot]' }, body: r.summary }];
  const pr = r.pr, same = (extra = {}) => preflight.decide({ pr: { ...pr, ...extra }, comments, headSha: p.head });
  const skipSame = same();
  assert(skipSame);
  // what a rule-file / config / model change would be: none of them is an input of decide, nor does the summary record them
  const params = /function decide\(\{([^}]*)\}\)/.exec(fs.readFileSync(path.join(ROOT, 'src/preflight.js'), 'utf8'))[1].trim();
  const changedTitle = same({ title: 'Probe PR changed' });
  assert.equal(changedTitle, '');
  const hasRuleOrModelMarker = markers.some((m) => /rule|model|config|standards|engine/.test(m));
  assert(!hasRuleOrModelMarker);
  return { sameHeadTitleBody: skipSame, titleChanged: changedTitle === '' ? 'review (no skip)' : changedTitle, decideInputs: params, markersInRealSummary: markers, markerForRulesConfigOrModel: hasRuleOrModelMarker, escapeHatch: 'force: true (action.yml input)',
    note: 'a changed base-branch rule file, config or model is invisible to decide(): same head+title+body => skip', level: 'preflight.decide (real) on a summary produced by post.js' };
});

// ---------- S14 ----------
probe('S14-big-source-dropped-silently', () => {
  const big = '// big\n' + Array.from({ length: 16000 }, (_, i) => `function f${i}(v) { return v + ${i}; }`).join('\n') + '\n';
  const small = 'function a(v) {\n  return v + 1;\n}\nfunction b(v) {\n  return v + 2;\n}\nmodule.exports = { a, b };\n';
  const f = fixture({ 'src/big.js': big, 'src/small.js': small });
  const size = fs.statSync(path.join(f.dir, 'src/big.js')).size; assert(size > 512 * 1024);
  const inv = au.inventory({ cwd: f.dir, head: f.head, maxUnits: 5 });
  const paths = inv.rows.map((r) => r.path);
  assert(paths.includes('src/small.js')); assert(!paths.includes('src/big.js'));
  assert(!inv.limitations.some((l) => /big|512|size|large/i.test(l)));
  ac.collect({ cwd: f.dir, ctx: f.ctx, reqPaths: '', maxUnits: 5 });
  const meta = JSON.parse(fs.readFileSync(path.join(f.ctx, 'audit-meta.json'), 'utf8'));
  const mentions = JSON.stringify(meta.limitations).includes('big.js') || fs.readdirSync(f.ctx).some((n) => /big\.js/.test(fs.readFileSync(path.join(f.ctx, n), 'utf8')));
  assert(!mentions);
  return { bigFileBytes: size, inventoryRows: paths, limitationsFromInventory: inv.limitations, metaLimitations: meta.limitations, bigFileMentionedAnywhereInCtx: mentions, level: 'audit-units.inventory + audit-collect.collect (real)' };
});

runAll().then(() => { console.log(JSON.stringify(results, null, 2)); }).finally(cleanup);
```

</details>

### 附录 A 实际结果（main ee1c158）

<details>
<summary>展开脚本或结果</summary>

```json
[
  {
    "id": "S1-test-paths-exclusion-only",
    "reproduced": true,
    "testScopeForExclusionOnly": null,
    "layoutHeaderShowsConfig": false,
    "layoutLists": "test directories: tests/legacy (1), tests/new (1)",
    "unitTestsColumn": "tests/new/amount.test.js, tests/legacy/old.test.js",
    "scanPathsExclusionWorks": true,
    "contrast": {
      "unitTestsColumnWithScanPaths": "tests/new/amount.test.js"
    },
    "level": "collect() (audit-collect.collect) + trace.testScope"
  },
  {
    "id": "S2-unreadable-closing-issue",
    "reproduced": true,
    "unreadableClosing": {
      "status": "partial",
      "limitations": [
        {
          "l": "Could not read issue #7.",
          "fact": true
        }
      ],
      "sources": [
        "PR body"
      ],
      "run": {
        "status": "complete",
        "complete": true,
        "execution_complete": true,
        "headline": "❔ No gaps found; part of the review could not be assessed",
        "noUnitTestGapsFound": false,
        "unreadableNoteOnlyIn": "Details > Not reviewed (1 item)",
        "headMarker": true,
        "nextPushSkipped": true
      }
    },
    "cappedClosing": {
      "status": "partial",
      "limitations": [
        {
          "l": "1 linked issue(s) omitted by the five-issue limit.",
          "fact": false
        }
      ],
      "run": {
        "status": "incomplete",
        "complete": false,
        "headline": "⚠️ Incomplete review: no unit test gaps found so far",
        "headMarker": false
      }
    },
    "level": "requirements.collectRequirements (real) -> post.js entry (mocked GitHub)"
  },
  {
    "id": "S3-shared-test-file-seen-dedupe",
    "reproduced": true,
    "testFileBytes": 66992,
    "perFileCap": 41666,
    "aAssertionInPack": true,
    "bAssertionInPack": false,
    "notWhole": [],
    "testBlockCount": 1,
    "level": "engines/claude-api.contextPack (real)"
  },
  {
    "id": "S4-ev-per-block-cap",
    "reproduced": true,
    "citedFiles": 9,
    "storedHashes": 8,
    "ninthFileEdited_blockStale": false,
    "firstFileEdited_blockStale": true,
    "level": "audit-post.stateOf/readState + audit-collect.collect (real)"
  },
  {
    "id": "S5-low-confidence-unit-covered",
    "reproduced": true,
    "lowFinding": {
      "low": true,
      "lowWhy": "no test sketch: the finding may not be a gap",
      "status": "complete",
      "unitStateInIssue": "covered"
    },
    "control": {
      "low": false,
      "unitStateInIssue": "gap"
    },
    "level": "audit-post main entry (mocked GitHub)"
  },
  {
    "id": "S6-unanswered-blocks-today-date",
    "reproduced": true,
    "stored": {
      "A": [
        "covered",
        "2026-10-15"
      ],
      "B": [
        "covered",
        "2026-10-15"
      ],
      "C_unanswered": [
        "unsure",
        "2026-10-15"
      ],
      "D_not_sent": [
        "covered",
        "2026-10-01"
      ]
    },
    "nextRunCap1": [
      "D"
    ],
    "nextRunCap3": [
      "A",
      "B",
      "D"
    ],
    "note": "cap 3 picks D (old), A, B (answered, covered 10-15) and leaves C (never answered) out; the oldest-first tier sorts by the stored date",
    "level": "audit-post.verify/stateOf/readState + audit-collect.collect (real); not through audit-post main"
  },
  {
    "id": "S7-pack-error-leaves-no-pack-cut",
    "reproduced": true,
    "engine": {
      "status": "success (no engine-status file)",
      "packCutFile": false,
      "findingsWritten": true,
      "notes": "cost estimated at default rates: claude-sonnet-4-6 is not in the price table"
    },
    "postNoPackCut": {
      "status": "complete",
      "postedHighConfidence": 1,
      "lowConfidenceNote": false
    },
    "postPackCutNamesTest": {
      "status": "complete",
      "postedHighConfidence": 0,
      "lowConfidenceNote": true
    },
    "scanParts": {
      "parts": 3,
      "unitPackText": "",
      "packCut": []
    },
    "injected": "(a) GITHUB_WORKSPACE -> nonexistent dir so claude-api run() root() throws; (b) stubbed contextPack that throws, passed to scan-parts.plan",
    "level": "(a) engines/claude-api.run entry (mocked fetch) + post.js entry; (b) scan-parts.plan internal"
  },
  {
    "id": "S8-findline-prefix20",
    "reproduced": true,
    "briefQuoteLiteral": {
      "quote": "assert.equal(f(1), 2)",
      "matchesLine": 0,
      "why": "exactly 20 non-space characters, so the prefix is the whole quote and the different tail fails"
    },
    "longerQuote": {
      "quote": "assert.equal(compute(1), 2)",
      "line": "assert.equal(compute(1), 3);",
      "findLine": 2
    },
    "verifyEvidence": {
      "status": "covered",
      "evidenceQuoteAfter": "assert.equal(compute(1), 3);",
      "noteOrDowngrade": []
    },
    "level": "post.findLine + post.verifyEvidence (internal, real)"
  },
  {
    "id": "S9-weekly-vs-post-anchor-rule",
    "reproduced": true,
    "a_baseMerge": {
      "weekly": {
        "anchor_touched": true,
        "tests_changed": true,
        "outcome": "addressed"
      },
      "postRule": {
        "anchor_touched": false,
        "tests_changed": false,
        "outcome": "open"
      }
    },
    "b_deletedFile": {
      "weekly": {
        "anchor_touched": true,
        "tests_changed": false,
        "outcome": "addressed"
      },
      "postRule": {
        "anchor_touched": null,
        "tests_changed": false,
        "outcome": "not_observed"
      }
    },
    "level": "eval/weekly-report.load (real, gh mocked at execFileSync with compare data from a real git repo) vs post.anchorTouched/testsChanged (real)"
  },
  {
    "id": "S10-wrong-coverage-row-no-fp",
    "reproduced": true,
    "coverageRowOnly": {
      "parsedRows": [
        {
          "status": "missing_test",
          "path": "a.js",
          "line": 10
        }
      ],
      "fp": 0,
      "clean_ok": true,
      "pass": true
    },
    "sameGapAsSummaryItem": {
      "fp": 1,
      "clean_ok": false,
      "pass": false
    },
    "level": "post.buildSummary (real) + eval/grade.grade (real)"
  },
  {
    "id": "S11-trimmed-hunks-still-complete",
    "reproduced": true,
    "changedLines": 3001,
    "filesChosen": 1,
    "filesSkipped": 0,
    "changedLinesNotShownToModel": 2495,
    "runStatus": "complete",
    "complete": true,
    "headMarker": true,
    "cleanVerdict": false,
    "visibleBanner": "Large PR: diffs of 1 large file was shortened in the prompt",
    "level": "focus.main (real) -> post.js entry (mocked GitHub)"
  },
  {
    "id": "S12-workflow-input-forwarding",
    "reproduced": true,
    "actionInputs": 47,
    "forwarded": 12,
    "workflowCallInputs": [
      "mode",
      "requirements_paths",
      "standards_paths",
      "test_paths",
      "scan_issue",
      "model",
      "effort"
    ],
    "workflowCallInputsNotForwarded": [],
    "forwardedButNotDeclaredInAction": [],
    "actionInputsNotForwarded": [
      "engine",
      "auto_tier",
      "fast_models",
      "max_budget_usd",
      "claude_mode",
      "max_output_tokens",
      "max_comments",
      "max_diff_kb",
      "focus_threshold",
      "focus_files",
      "ignore",
      "standards_checks",
      "standards_ref",
      "coverage_files",
      "trace",
      "claude_version",
      "copilot_version",
      "include_bots",
      "resolve_stale",
      "force",
      "ctx_retention_days",
      "max_units",
      "scan_batch_blocks",
      "scan_max_blocks",
      "scan_paths",
      "scan_issue_repo",
      "scan_issue_token",
      "audit_max_requirements",
      "audit_issue",
      "delivery",
      "fail_on_error",
      "repository",
      "pr_number",
      "base_sha",
      "head_sha"
    ],
    "pinnedActionRef": {
      "pin": "caa99fbbef",
      "inputsAtPin": 45
    },
    "level": "static parse of action.yml and .github/workflows/specguard.yml"
  },
  {
    "id": "S13-preflight-skip-key",
    "reproduced": true,
    "sameHeadTitleBody": "head 07fe197 already has a SpecGuard summary (set force: true to rerun)",
    "titleChanged": "review (no skip)",
    "decideInputs": "pr, comments = [], headSha, includeBots = false, force = false, actor = null, issueAt = null",
    "markersInRealSummary": [
      "summary",
      "head",
      "counts",
      "req",
      "status"
    ],
    "markerForRulesConfigOrModel": false,
    "escapeHatch": "force: true (action.yml input)",
    "note": "a changed base-branch rule file, config or model is invisible to decide(): same head+title+body => skip",
    "level": "preflight.decide (real) on a summary produced by post.js"
  },
  {
    "id": "S14-big-source-dropped-silently",
    "reproduced": true,
    "bigFileBytes": 633787,
    "inventoryRows": [
      "src/small.js"
    ],
    "limitationsFromInventory": [],
    "metaLimitations": [],
    "bigFileMentionedAnywhereInCtx": false,
    "level": "audit-units.inventory + audit-collect.collect (real)"
  }
]
```

</details>

### 附录 B：探针 U1–U12（audit-supplement-2.cjs）

<details>
<summary>展开脚本或结果</summary>

```javascript
// Supplement-2 probes (U1-U12). Run from the SpecGuard checkout root: node .audit-probe/audit-supplement-2.cjs
// (or SG_ROOT=<checkout> node audit-supplement-2.cjs). Git's bin + usr/bin are put first on PATH so `bash` is Git bash, not WSL.
// Each probe asserts the suspected-buggy behaviour; reproduced=false carries what actually happened. No network, no model.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const root = process.env.SG_ROOT || path.resolve(__dirname, '..');
for (const d of ['C:\\Program Files\\Git\\usr\\bin', 'C:\\Program Files\\Git\\bin']) if (fs.existsSync(d)) process.env.PATH = d + path.delimiter + process.env.PATH;
const R = (p) => require(path.join(root, p));
const results = [];
const roots = [];
const git = (cwd, ...a) => execFileSync('git', ['-c', 'core.autocrlf=false', ...a], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const fwd = (p) => path.resolve(p).replace(/\\/g, '/');
function repo(files, prefix = 'sg-supp2-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); roots.push(dir);
  git(dir, 'init', '-q', '-b', 'main');
  const put = (map) => { for (const [n, s] of Object.entries(map)) { const p = path.join(dir, n); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); } };
  const commit = (m = 'c') => { git(dir, 'add', '-A'); git(dir, '-c', 'user.name=T', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', m); return git(dir, 'rev-parse', 'HEAD'); };
  put(files);
  return { dir, put, commit, git: (...a) => git(dir, ...a) };
}
const rd = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };
function collect(dir, ctx, env) {
  const out = path.join(os.tmpdir(), 'sg-supp2-ghout-' + process.pid + '-' + path.basename(ctx)); roots.push(out); fs.writeFileSync(out, '');
  const r = spawnSync('bash', [fwd(path.join(root, 'src/collect.sh'))], { cwd: dir, encoding: 'utf8', timeout: 240000,
    env: { ...process.env, CTX: fwd(ctx), GITHUB_OUTPUT: fwd(out), TRACE: 'off', ...env } });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, outputs: (rd(out) || '').split('\n').filter(Boolean) };
}
async function probe(id, fn) {
  try { results.push({ id, ...(await fn()) }); }
  catch (e) { results.push({ id, reproduced: false, error: String(e.message).slice(0, 600) }); }
}
async function withEnv(values, fn) {
  const before = { ...process.env };
  try { Object.assign(process.env, values); return await fn(); }
  finally { for (const k of Object.keys(process.env)) if (!(k in before)) delete process.env[k]; Object.assign(process.env, before); }
}

(async () => {
// U1: BASE_SHA absent from a depth-1 clone; the head is present. The diff in `< <(...)` fails silently -> skip=true -> post.js "Nothing to review", complete.
await probe('U1-absent-base-silent-skip', async () => {
  const up = repo({ 'README.txt': 'x\n', 'src/a.js': 'exports.f = x => x;\n' });
  const base = up.commit('base');
  up.put({ 'src/a.js': 'exports.f = x => x > 0 ? x : 0;\n' }); up.commit('mid');
  up.put({ 'src/a.js': 'exports.f = x => x > 1 ? x : 1;\n' }); const head = up.commit('head');
  const clone = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-supp2-clone-')); roots.push(clone);
  git(os.tmpdir(), 'clone', '-q', '--depth', '1', 'file://' + fwd(up.dir), clone);
  const baseThere = spawnSync('git', ['cat-file', '-e', base + '^{commit}'], { cwd: clone }).status === 0;
  const ctx = path.join(clone, '.specguard-ctx');
  const c = collect(clone, ctx, { BASE_SHA: base, HEAD_SHA: head });
  const diffPatch = rd(path.join(ctx, 'diff.patch')), files = rd(path.join(ctx, 'files.txt'));
  assert.equal(baseThere, false);
  assert(c.outputs.includes('skip=true'), 'collect did not skip: ' + JSON.stringify(c));
  // post.js with SKIP=true (mock as audit-doc Appendix B P6)
  const post = R('src/post.js');
  let summary = ''; const outputs = {};
  const pr = { state: 'open', title: 't', body: '', head: { sha: head }, user: { login: 'dev', type: 'User' } };
  const gh = { paginate: async (fn, args) => (await fn(args)).data, graphql: async () => ({ repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [] } } } }),
    rest: { users: { getAuthenticated: async () => { throw Error('job token'); } }, pulls: { get: async () => ({ data: pr }), listReviewComments: async () => ({ data: [] }), listFiles: async () => ({ data: [] }) },
      issues: { listComments: async () => ({ data: [] }), createComment: async (a) => { summary = a.body; return {}; }, updateComment: async (a) => { summary = a.body; return {}; } } } };
  const core = { setOutput: (k, v) => { outputs[k] = v; }, warning() {}, notice() {}, summary: { addRaw(s) { return this; }, async write() {} } };
  await withEnv({ CTX: ctx, GITHUB_WORKSPACE: clone, HEAD_SHA: head, ENGINE: 'claude', MODEL: 'claude-sonnet-4-6', SKIP: 'true', PARTIAL: 'false', DELIVERY: '', STANDARDS_CHECKS: '', STANDARDS_REF: 'head', RESOLVE_STALE: 'false' },
    () => post({ github: gh, core, context: { repo: { owner: 'o', repo: 'r' }, serverUrl: 'https://github.com', payload: { pull_request: { ...pr, number: 1 } } } }));
  const counts = rd(path.join(ctx, 'counts.json'));
  const out = { reproduced: true, baseInClone: baseThere, collectExit: c.status, collectOutputs: c.outputs, collectStdout: c.stdout.trim().slice(0, 200), warning: (c.stderr.match(/::warning::[^\n]*/) || [''])[0], diffPatchBytes: (diffPatch || '').length, filesTxt: files,
    postStatus: outputs.status, summaryHasNothingToReview: /Nothing to review/.test(summary), summaryHasHeadMarker: summary.includes(`specguard:head=${head}`), countsComplete: counts && JSON.parse(counts).complete };
  assert.equal(out.summaryHasNothingToReview, true); assert.equal(out.postStatus, 'complete');
  return out;
});

// U2: only internal/build/x.go changed -> `build/` default ignore matches any path segment -> skipped; nothing recorded.
await probe('U2-nested-build-dir-ignored-silently', async () => {
  const r = repo({ 'internal/build/x.go': 'package build\nfunc F() int { return 1 }\n', 'internal/other/y.go': 'package other\nfunc G() int { return 1 }\n' });
  const base = r.commit('base');
  r.put({ 'internal/build/x.go': 'package build\nfunc F() int { return 2 }\n' }); const head = r.commit('head');
  const ctx = path.join(r.dir, '.specguard-ctx');
  const c = collect(r.dir, ctx, { BASE_SHA: base, HEAD_SHA: head });
  const limits = rd(path.join(ctx, 'collect-limits.txt')), dropped = rd(path.join(ctx, 'diff-dropped.txt'));
  // control: same change in a non-ignored dir is reviewed
  r.git('checkout', '-q', base); r.git('checkout', '-q', '-b', 'ctl'); r.put({ 'internal/other/y.go': 'package other\nfunc G() int { return 2 }\n' }); const head2 = r.commit('ctl');
  const ctx2 = path.join(r.dir, '.specguard-ctx2');
  const c2 = collect(r.dir, ctx2, { BASE_SHA: base, HEAD_SHA: head2 });
  const out = { reproduced: c.outputs.includes('skip=true'), outputs: c.outputs, stdout: c.stdout.trim(), collectLimitsBytes: (limits || '').length, diffDroppedBytes: (dropped || '').length, controlOutputs: c2.outputs, controlFiles: rd(path.join(ctx2, 'files.txt')) };
  assert.equal(out.reproduced, true); assert.equal(out.collectLimitsBytes, 0); assert.equal(out.diffDroppedBytes, 0);
  return out;
});

// U3: test-candidates capped at 60 files (also 16 KiB); a file past the cap that focus.js picks gets no candidate tests and is not in pack-cut.txt.
await probe('U3-candidate-cap-vs-focus', async () => {
  const files = {};
  for (let i = 0; i < 61; i++) files[`src/f${String(i).padStart(2, '0')}.js`] = 'exports.a = 1;\n';
  files['src/zzz.js'] = 'exports.zzz = function (v) { return v; };\n';
  files['tests/zzz.test.js'] = 'const { zzz } = require("../src/zzz");\nassert.equal(zzz(1), 1);\n';
  const r = repo(files); const base = r.commit('base');
  const risky = ['exports.zzz = function (v) {'].concat(Array.from({ length: 40 }, (_, i) => `  if (v === ${i}) { throw new Error("bad ${i}"); } else if (v > ${i + 100}) { return ${i}; }`), ['  return v + 1;', '};']).join('\n') + '\n';
  const edit = {}; for (let i = 0; i < 61; i++) edit[`src/f${String(i).padStart(2, '0')}.js`] = 'exports.a = 2;\n';
  edit['src/zzz.js'] = risky; r.put(edit); const head = r.commit('head');
  const ctx = path.join(r.dir, '.specguard-ctx');
  const c = collect(r.dir, ctx, { BASE_SHA: base, HEAD_SHA: head });
  const cand = rd(path.join(ctx, 'test-candidates.txt')) || '', focus = rd(path.join(ctx, 'focus.txt')) || '';
  const packer = R('src/engines/claude-api.js');
  const pack = packer.contextPack(ctx, r.dir, 250000);
  const out = { reproduced: false, collectOutputs: c.outputs, candidatesListZzz: /^src\/zzz\.js$/m.test(cand), candidatesTail: cand.trim().split('\n').slice(-1)[0], focusPicksZzz: /^src\/zzz\.js\t/m.test(focus), focusFirst: focus.split('\n')[0],
    packHasZzzSource: pack.text.includes('src/zzz.js'), packHasZzzTest: pack.text.includes('tests/zzz.test.js'), packNotWhole: pack.notWhole, packCutTxt: rd(path.join(ctx, 'pack-cut.txt')) };
  r.git('checkout', '-q', base); r.git('checkout', '-q', '-b', 'ctl'); r.put({ 'src/zzz.js': risky }); const head2 = r.commit('ctl');
  const ctx2 = path.join(r.dir, '.specguard-ctx2'); collect(r.dir, ctx2, { BASE_SHA: base, HEAD_SHA: head2 });
  out.control = { candidates: (rd(path.join(ctx2, 'test-candidates.txt')) || '').trim(), packHasZzzTest: packer.contextPack(ctx2, r.dir, 250000).text.includes('tests/zzz.test.js') };
  out.reproduced = !out.candidatesListZzz && out.focusPicksZzz && !out.packHasZzzTest && !out.packNotWhole.includes('tests/zzz.test.js');
  return out;
});

// U4: --fail-on-gaps returns 0 when post.js status is not complete and there are no gaps.
await probe('U4-fail-on-gaps-ignores-failed-status', async () => {
  const r = repo({ 'src/price.js': 'function total(x) {\n  return x;\n}\nmodule.exports = { total };\n' }); r.commit('base');
  r.git('checkout', '-q', '-b', 'feature'); r.put({ 'src/price.js': 'function total(x) {\n  if (x > 100) return 100;\n  return x;\n}\nmodule.exports = { total };\n' }); r.commit('cap');
  const local = R('bin/specguard-local.js');
  const canned = (name, body) => { const p = path.join(r.dir, '..', name); fs.writeFileSync(p, body); roots.push(p); return p; };
  const runMain = async (file, extra = []) => {
    const lines = [], oLog = console.log, oErr = console.error, cwd = process.cwd();
    process.chdir(r.dir); console.log = (m) => lines.push(String(m)); console.error = () => {};
    try { return await withEnv({ SPECGUARD_LOCAL_FINDINGS: file }, async () => { const code = await local.main(['--base', 'main', '--json', '--fail-on-gaps', ...extra]); return { code, json: JSON.parse(lines.join('\n')) }; }); }
    finally { process.chdir(cwd); console.log = oLog; console.error = oErr; }
  };
  const bad = await runMain(canned('sg-supp2-bad-findings.json', 'this is not json'));
  const out = { reproduced: false, failedRun: { exit: bad.code, status: bad.json.status, gaps: bad.json.gaps, summaryHead: String(bad.json.summary).slice(0, 160) } };
  // incomplete: valid report that leaves a thing unreviewed
  const beh = { path: 'src/price.js', line: 2, quote: 'if (x > 100) return 100;' };
  const inc = { requirements: [], requirements_source: 'commit messages', not_reviewed: 'Could not read the second module.', coverage: [{ id: 'O1', obligation: 'cap at 100', source: 'commit message', behaviour: beh, change: { ...beh }, evidence: [], status: 'unknown', reason: 'ran out of context', alignment: { status: 'not_applicable', reason: 'none' } }], findings: [], standards: { status: 'no_rules', sources: [], reason: 'none' }, layering: { status: 'checked', reason: 'none' } };
  const part = await runMain(canned('sg-supp2-partial-findings.json', JSON.stringify(inc)));
  out.partialRun = { exit: part.code, status: part.json.status, gaps: part.json.gaps };
  out.reproduced = bad.code === 0 && bad.json.status !== 'complete' && bad.json.gaps === false;
  return out;
});

// U5/U6: leads.assertionDelta
const { assertionDelta } = R('src/leads.js');
const isTest = (f) => /\.test\./.test(f);
const mk = (file, hunks) => `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n${hunks}`;
await probe('U5-assertion-delta-cross-test-repin', async () => {
  const A = (add) => `@@ -10,5 +10,${add ? 6 : 4} @@\n test('a', () => {\n   const result = run();\n-  expect(result).toEqual({a:1,b:2});\n${add}   done();\n });\n`;
  const C = `@@ -40,3 +40,4 @@\n test('c', () => {\n   const result = other();\n+  expect(result).toBe(true);\n });\n`;
  const removedOnly = assertionDelta(mk('t/x.test.js', A('')), isTest);
  const withC = assertionDelta(mk('t/x.test.js', A('') + C), isTest);
  const weakA = assertionDelta(mk('t/x.test.js', A('+  expect(result).toBeDefined();\n')), isTest);
  const weakAC = assertionDelta(mk('t/x.test.js', A('+  expect(result).toBeDefined();\n') + C), isTest);
  const five = (add) => assertionDelta(mk('t/y.test.js', `@@ -3,3 +3,3 @@\n test('p', () => {\n-  expect(total(2)).toBe(5);\n${add}\n });\n`), isTest);
  const g = five('+  expect(total(2)).toBeGreaterThan(0);'), g0 = five('+  expect(total(3)).toBe(1);');
  const out = { removedOnly, withC, weakA, weakAC, toBe5ToGreaterThan: g, controlOtherSubject: g0 };
  out.reproduced = removedOnly.length === 1 && withC.length === 0;
  out.toBe5Suppressed = g.length === 0;
  return out;
});
await probe('U6-deleted-test-file-no-lead', async () => {
  const del = 'diff --git a/t/x.test.js b/t/x.test.js\ndeleted file mode 100644\n--- a/t/x.test.js\n+++ /dev/null\n@@ -1,3 +0,0 @@\n-test("f", () => {\n-  expect(f(1)).toBe(2);\n-});\n';
  const mod = mk('t/x.test.js', '@@ -1,3 +1,2 @@\n test("f", () => {\n-  expect(f(1)).toBe(2);\n });\n');
  const d = assertionDelta(del, isTest), m = assertionDelta(mod, isTest);
  return { reproduced: d.length === 0 && m.length === 1, deletedFile: d, sameAssertionRemovedFromLiveFile: m.map((x) => x.kind) };
});

// U7: bundle.js parsers vs a real buildSummary (dropped + over-cap finding)
await probe('U7-bundle-parsers-vs-buildSummary', async () => {
  const post = R('src/post.js'), bundle = R('eval/bundle.js');
  const b = { path: 'a.js', line: 10, quote: 'return boundary(value);' };
  const f = { kind: 'missing_test', path: 'a.js', line: 10, title: 'Boundary A', body: 'Missing assertion', quote: b.quote, confidence: 'high', obligation_ids: ['O1'] };
  const b2 = { ...b, line: 20 };
  const f2 = { ...f, line: 20, title: 'Boundary B', obligation_ids: ['O2'] };
  const bad = { kind: 'missing_test', path: 'a.js', line: 30, quote: b.quote, body: 'no title', confidence: 'high', obligation_ids: ['O1'] };
  const row = (id, bb) => ({ id, obligation: 'Boundary ' + id, source: 'from behaviour', behaviour: bb, change: bb, evidence: [], status: 'missing_test', reason: 'No test', alignment: { status: 'not_applicable', reason: 'none' } });
  const raw = { requirements: [], requirements_source: 'none', not_reviewed: '', coverage: [row('O1', b), row('O2', b2)], findings: [f, f2, bad, { kind: 'missing_test', path: 'a.js', line: 40, title: 'Titled but no quote', body: 'x', confidence: 'high', obligation_ids: ['O1'] }], standards: { status: 'no_rules', sources: [], reason: 'None' }, layering: { status: 'checked', reason: 'none' } };
  const data = JSON.parse(JSON.stringify(raw));
  const v = post.validate(data); const notes = data.validation_notes || [];
  assert(v.ok, JSON.stringify(v));
  const summary = post.buildSummary({ cov: { reports: 0 }, data, items: [{ f: data.findings[0], why: 'over max_comments' }, { f: data.findings[1], why: 'over max_comments' }], notes, blob: 'https://github.com/example/repo/blob/abc/' });
  const parsedSummary = bundle.parseSummary(summary), parsedDropped = bundle.parseDropped(summary, raw);
  const dropLine = (summary.split('\n').find((l) => /Dropped findings/.test(l)) || null);
  return { reproduced: parsedSummary.length === 0, bundleDroppedMatchesTitled: parsedDropped.length > 0, droppedLines: summary.split('\n').filter((l) => /Dropped findings/.test(l)), validateKeys: Object.keys(v), notes, droppedLineInSummary: dropLine, hasMoreItemsDetails: /\d+ more item\(s\)/.test(summary),
    bundleSummaryCount: parsedSummary.length, bundleDroppedCount: parsedDropped.length, summaryHeadings: summary.split('\n').filter((l) => /^#{2,3} |<summary>/.test(l)).slice(0, 12) };
});

// U8: results-prove.json location
await probe('U8-results-prove-shared-path', async () => {
  const src = rd(path.join(root, 'eval/prove.js')).split('\n');
  const line = src.findIndex((l) => l.includes("'results-prove.json'")) + 1;
  const prove = R('eval/prove.js');
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-supp2-prove-')); roots.push(out);
  const mkcase = (id) => { const d = path.join(out, id); fs.mkdirSync(path.join(d, 'repo'), { recursive: true }); fs.writeFileSync(path.join(d, 'prove.json'), JSON.stringify({ findings: [] }));
    fs.writeFileSync(path.join(d, 'repo', 'a.txt'), 'x\n'); git(path.join(d, 'repo'), 'init', '-q'); git(path.join(d, 'repo'), 'add', '-A'); git(path.join(d, 'repo'), '-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'i'); return d; };
  mkcase('caseA'); mkcase('caseB');
  const detail = { line, lineText: src[line - 1].trim(), reproduced: false };
  try {
    const ra = prove.check({ id: 'caseA', out }); const rb = prove.check({ id: 'caseB', out });
    detail.runOk = true; detail.resultFilesInOut = fs.readdirSync(out).filter((n) => n.endsWith('.json')); detail.perCaseResults = ['caseA', 'caseB'].map((c) => fs.existsSync(path.join(out, c, 'results-prove.json')));
    detail.reproduced = detail.resultFilesInOut.includes('results-prove.json') && detail.perCaseResults.every((x) => !x);
  } catch (e) { detail.runOk = false; detail.runError = String(e.message).slice(0, 200); detail.reproduced = /path\.resolve\(out\), 'results-prove\.json'/.test(src[line - 1]); detail.note = 'static only'; }
  return detail;
});

// U9: static quote of both lines
await probe('U9-example-vs-trace-boundary-rule', async () => {
  const ex = rd(path.join(root, 'skills/test-review/references/example.json')).split('\n'), tr = rd(path.join(root, 'skills/test-review/references/trace.md')).split('\n');
  const t44 = tr[43], e4 = ex[3];
  const evidenceAsserts = (e4.match(/assert\.\w+\([^)]*\)/g) || []);
  return { reproduced: /both sides of the boundary/.test(t44) && /"status":"covered"/.test(e4) && evidenceAsserts.length === 1, trace_md_44: t44, example_json_4: e4.slice(0, 520), evidenceAssertions: evidenceAsserts };
});

// U10: findingId collision
await probe('U10-findingId-ignores-kind', async () => {
  const { findingId, exportRows } = R('eval/label-export.js');
  const base = { tool: 'specguard', repo: 'o/r', pr: 5, path: 'a.js', line: 10 };
  const a = { ...base, kind: 'missing_test', text: 'No test for the cap' }, b = { ...base, kind: 'weak_test', text: 'Assertion too weak' };
  let rows = null; try { rows = exportRows([a, b], { sample: 30, seed: 1 }); } catch (e) { rows = String(e.message); }
  return { reproduced: findingId(a) === findingId(b), idA: findingId(a), idB: findingId(b), exportRowIds: Array.isArray(rows) ? rows.map((x) => x.id) : rows };
});

// U11: szz.fixLines on a .sql diff with a removed `-- comment` line
await probe('U11-szz-sql-comment-as-header', async () => {
  const szz = R('eval/szz.js');
  const mkr = (first) => { const r = repo({ 'db/q.sql': `${first}\nselect 1;\nselect 2;\nselect 3;\n` }); const p = r.commit('parent'); r.put({ 'db/q.sql': `select 1;\nselect 2;\nselect 33;\n` }); const s = r.commit('fix'); return { r, p, s }; };
  const sql = mkr('-- header comment'), ctl = mkr('select 0;');
  const got = szz.fixLines(sql.r.dir, sql.p, sql.s), ref = szz.fixLines(ctl.r.dir, ctl.p, ctl.s);
  return { reproduced: JSON.stringify(got.map((f) => f.lines)) !== JSON.stringify(ref.map((f) => f.lines)) && got.every((f) => !f.lines.includes(4)) && ref.some((f) => f.lines.includes(4)),
    withSqlComment: got, control: ref, rawDiff: git(sql.r.dir, 'diff', '-U0', '-w', '-M', '--no-color', sql.p, sql.s).split('\n').slice(0, 12) };
});

// U12: testScope with an exclusion-only test_paths
await probe('U12-testScope-exclusion-only', async () => {
  const trace = R('src/trace.js');
  const s = trace.testScope('!legacy/**');
  return { reproduced: s === null, scopeIsNull: s === null, note: 'null = discovery by name, i.e. the exclusion is not applied to the test set (collect.sh: `scope ? ... : isTestPath`)', legacyTestStillATest: trace.isTestPath('legacy/a.test.js') };
});

console.log(JSON.stringify(results, null, 2));
})().finally(() => {
  const tmp = path.resolve(fs.realpathSync(os.tmpdir())) + path.sep;
  for (const r of roots) { try { const p = fs.realpathSync(r); if (p.startsWith(tmp) && path.basename(p).startsWith('sg-supp2-')) fs.rmSync(p, { recursive: true, force: true }); } catch {} }
});
```

</details>

### 附录 B 实际结果（main ee1c158）

<details>
<summary>展开脚本或结果</summary>

```json
[
  {
    "id": "U1-absent-base-silent-skip",
    "reproduced": true,
    "baseInClone": false,
    "collectExit": 0,
    "collectOutputs": [
      "skip=false",
      "partial=false",
      "skip=true"
    ],
    "collectStdout": "::warning::no merge-base of BASE_SHA and HEAD_SHA (shallow clone? use fetch-depth 0); diff-side history may not line up\nnothing reviewable in diff",
    "warning": "",
    "diffPatchBytes": 0,
    "filesTxt": "",
    "postStatus": "complete",
    "summaryHasNothingToReview": true,
    "summaryHasHeadMarker": true,
    "countsComplete": null
  },
  {
    "id": "U2-nested-build-dir-ignored-silently",
    "reproduced": true,
    "outputs": [
      "skip=false",
      "partial=false",
      "skip=true"
    ],
    "stdout": "nothing reviewable in diff",
    "collectLimitsBytes": 0,
    "diffDroppedBytes": 0,
    "controlOutputs": [
      "skip=false",
      "partial=false"
    ],
    "controlFiles": "internal/other/y.go\n"
  },
  {
    "id": "U3-candidate-cap-vs-focus",
    "reproduced": true,
    "collectOutputs": [
      "skip=false",
      "partial=false"
    ],
    "candidatesListZzz": false,
    "candidatesTail": "(2 more changed file(s) not listed)",
    "focusPicksZzz": true,
    "focusFirst": "src/zzz.js\t8.0\tlogic +3.0, size +2.5, 42 branch/error line(s) changed +2.0, 1 of them removed +0.5",
    "packHasZzzSource": true,
    "packHasZzzTest": false,
    "packNotWhole": [],
    "packCutTxt": null,
    "control": {
      "candidates": "src/zzz.js\n  tests/zzz.test.js  (same name)",
      "packHasZzzTest": true
    }
  },
  {
    "id": "U4-fail-on-gaps-ignores-failed-status",
    "reproduced": true,
    "failedRun": {
      "exit": 0,
      "status": "failed",
      "gaps": false,
      "summaryHead": "<!-- specguard:summary -->\n<!-- specguard:status=failed -->\n## SpecGuard\n\n**⚠️ Could not complete: no valid findings.json (parse error); see the job log**\n\n<det"
    },
    "partialRun": {
      "exit": 0,
      "status": "complete",
      "gaps": false
    }
  },
  {
    "id": "U5-assertion-delta-cross-test-repin",
    "removedOnly": [
      {
        "file": "t/x.test.js",
        "kind": "removed",
        "line": 12,
        "old": "expect(result).toEqual({a:1,b:2});"
      }
    ],
    "withC": [],
    "weakA": [
      {
        "file": "t/x.test.js",
        "kind": "weakened",
        "line": 12,
        "old": "expect(result).toEqual({a:1,b:2});",
        "new": "expect(result).toBeDefined();"
      }
    ],
    "weakAC": [],
    "toBe5ToGreaterThan": [],
    "controlOtherSubject": [
      {
        "file": "t/y.test.js",
        "kind": "removed",
        "line": 4,
        "old": "expect(total(2)).toBe(5);"
      }
    ],
    "reproduced": true,
    "toBe5Suppressed": true
  },
  {
    "id": "U6-deleted-test-file-no-lead",
    "reproduced": true,
    "deletedFile": [],
    "sameAssertionRemovedFromLiveFile": [
      "removed"
    ]
  },
  {
    "id": "U7-bundle-parsers-vs-buildSummary",
    "reproduced": true,
    "bundleDroppedMatchesTitled": true,
    "droppedLines": [
      "- Dropped findings[2] missing_test a.js: path, title, body and quote must be strings.",
      "- Dropped findings[3] missing_test a.js Titled but no quote: path, title, body and quote must be strings."
    ],
    "validateKeys": [
      "ok"
    ],
    "notes": [
      "Dropped findings[2] missing_test a.js: path, title, body and quote must be strings.",
      "Dropped findings[3] missing_test a.js Titled but no quote: path, title, body and quote must be strings."
    ],
    "droppedLineInSummary": "- Dropped findings[2] missing_test a.js: path, title, body and quote must be strings.",
    "hasMoreItemsDetails": false,
    "bundleSummaryCount": 0,
    "bundleDroppedCount": 1,
    "summaryHeadings": [
      "## SpecGuard",
      "### Missing unit tests (2)",
      "<details><summary>Details: evidenced criteria, obligations, sources, run information</summary>"
    ]
  },
  {
    "id": "U8-results-prove-shared-path",
    "line": 443,
    "lineText": "fs.writeFileSync(path.join(path.resolve(out), 'results-prove.json'), JSON.stringify(result, null, 2) + '\\n');",
    "reproduced": true,
    "runOk": true,
    "resultFilesInOut": [
      "results-prove.json"
    ],
    "perCaseResults": [
      false,
      false
    ]
  },
  {
    "id": "U9-example-vs-trace-boundary-rule",
    "reproduced": true,
    "trace_md_44": "A test must assert both sides of the boundary (n-1, n, n+1); if it does not, report `weak_test` for the missing boundary.",
    "example_json_4": "{\"id\":\"O1\",\"obligation\":\"Orders of 100 or more get a 10% discount\",\"source\":\"PR body AC 1\",\"behaviour\":{\"path\":\"src/discount.js\",\"line\":4,\"quote\":\"if (total >= 100) return total * 0.9;\"},\"evidence\":[{\"path\":\"test/discount.test.js\",\"line\":9,\"quote\":\"assert.equal(discount(100), 90);\"}],\"status\":\"covered\",\"reason\":\"The unit test asserts the boundary 100 against the literal 90.\",\"alignment\":{\"status\":\"consistent\",\"reason\":\"R: 100 or more; C: total >= 100\"}},",
    "evidenceAssertions": [
      "assert.equal(discount(100)"
    ]
  },
  {
    "id": "U10-findingId-ignores-kind",
    "reproduced": true,
    "idA": "F502e6ddc0",
    "idB": "F502e6ddc0",
    "exportRowIds": [
      "F502e6ddc0",
      "F502e6ddc0"
    ]
  },
  {
    "id": "U11-szz-sql-comment-as-header",
    "reproduced": true,
    "withSqlComment": [
      {
        "path": "db/q.sql",
        "lines": [],
        "addOnly": true
      }
    ],
    "control": [
      {
        "path": "db/q.sql",
        "lines": [
          1,
          4
        ],
        "addOnly": false
      }
    ],
    "rawDiff": [
      "diff --git a/db/q.sql b/db/q.sql",
      "index 1d39ca9..d546eb1 100644",
      "--- a/db/q.sql",
      "+++ b/db/q.sql",
      "@@ -1 +0,0 @@",
      "--- header comment",
      "@@ -4 +3 @@ select 2;",
      "-select 3;",
      "+select 33;"
    ]
  },
  {
    "id": "U12-testScope-exclusion-only",
    "reproduced": true,
    "scopeIsNull": true,
    "note": "null = discovery by name, i.e. the exclusion is not applied to the test set (collect.sh: `scope ? ... : isTestPath`)",
    "legacyTestStillATest": true
  }
]
```

</details>

### 附录 C：探针 V1–V2（audit-supplement-3.cjs）

<details>
<summary>展开脚本或结果</summary>

```javascript
// Supplement-3 probes (V1, V2). Run from the checkout root of ee1c158: node audit-supplement-3.cjs
// V1: exported functions of src/*.js and eval/*.js that no test file mentions by name (the repo's own coding standard, .github/instructions/specguard.instructions.md:8).
// V2: eval/replay.js finishRealOne/table when the model never wrote findings.json (the row says findings_present:false; the printed table has no such column).
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), cp = require('node:child_process');
const root = process.env.SG_ROOT || process.cwd();
const R = (p) => require(path.join(root, p));
const out = {};
const tracked = cp.execFileSync('git', ['ls-tree', '-r', '--name-only', process.env.SG_REF || 'origin/main'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean);
// ---- V1
const tests = tracked.filter((f) => /\.test\.js$/.test(f)).map((f) => fs.readFileSync(path.join(root, f), 'utf8')).join('\n');
const prod = tracked.filter((f) => /^(src|eval)\/[^/]+\.js$/.test(f) && !/\.test\.js$/.test(f));
const unref = [], noSibling = [];
for (const f of prod) {
  let m; try { m = require(path.join(root, f)); } catch { continue; }
  const names = Object.keys(m).filter((k) => typeof m[k] === 'function');
  const miss = names.filter((n) => !new RegExp('\\b' + n.replace(/\$/g, '\\$') + '\\b').test(tests));
  if (miss.length) unref.push({ file: f, unreferenced: miss });
  if (names.length && !tracked.includes(f.replace(/\.js$/, '.test.js'))) noSibling.push(f);
}
out.V1 = { prodFilesChecked: prod.length, filesWithUnreferencedExports: unref, exportingFilesWithoutSiblingTest: noSibling };
// ---- V2
(async () => {
  const replay = R('eval/replay.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-supp3-'));
  try {
    const id = 'nofindings', d = path.join(dir, id); fs.mkdirSync(path.join(d, 'ctx'), { recursive: true });
    fs.writeFileSync(path.join(d, 'meta.json'), JSON.stringify({ id, base: 'b'.repeat(40), head: 'a'.repeat(40), trace: 'auto', skip: false, partial: false, repo: dir }));
    let row, err = null;
    try { row = await replay.finishRealOne(id, dir); } catch (e) { err = String(e.message).split('\n')[0]; }
    out.V2 = row ? { row, printedTable: replay.table([row]), tableMentionsFindingsPresent: /findings_present|present/.test(replay.table([row])) } : { error: err };
  } finally { const p = fs.realpathSync(dir); if (p.startsWith(fs.realpathSync(os.tmpdir())) && path.basename(p).startsWith('sg-supp3-')) fs.rmSync(p, { recursive: true, force: true }); }
  console.log(JSON.stringify(out, null, 2));
})();
```

</details>

### 附录 C 实际结果（main ee1c158）

<details>
<summary>展开脚本或结果</summary>

```json
﻿{
  "V1": {
    "prodFilesChecked": 43,
    "filesWithUnreferencedExports": [
      {
        "file": "eval/ab.js",
        "unreferenced": [
          "convertFree"
        ]
      },
      {
        "file": "eval/bundle.js",
        "unreferenced": [
          "rng",
          "shuffle"
        ]
      },
      {
        "file": "eval/degrade.js",
        "unreferenced": [
          "auditBuiltin",
          "auditFixture",
          "evaluateAudit",
          "fromCase"
        ]
      },
      {
        "file": "eval/field.js",
        "unreferenced": [
          "isDoc",
          "isCode",
          "measureCommit",
          "measureRepo",
          "bigCommit"
        ]
      },
      {
        "file": "eval/label-export.js",
        "unreferenced": [
          "shuffle"
        ]
      },
      {
        "file": "eval/prove.js",
        "unreferenced": [
          "subExprVariants",
          "checkPlan"
        ]
      },
      {
        "file": "eval/run.js",
        "unreferenced": [
          "rawOutput"
        ]
      },
      {
        "file": "eval/signal.js",
        "unreferenced": [
          "enclosingFn"
        ]
      },
      {
        "file": "src/audit-collect.js",
        "unreferenced": [
          "allBlocks"
        ]
      },
      {
        "file": "src/audit-post.js",
        "unreferenced": [
          "findIssue"
        ]
      },
      {
        "file": "src/coverage.js",
        "unreferenced": [
          "gocover"
        ]
      },
      {
        "file": "src/leads.js",
        "unreferenced": [
          "symbolsOf"
        ]
      },
      {
        "file": "src/post.js",
        "unreferenced": [
          "assertionKind",
          "counterexampleOk",
          "citationsOf",
          "loadCoverage",
          "applyCoverage",
          "coverageAtoms",
          "findingBlock",
          "findingHead"
        ]
      },
      {
        "file": "src/test-map.js",
        "unreferenced": [
          "indexTests",
          "noExt",
          "classAndMethod"
        ]
      },
      {
        "file": "src/trace.js",
        "unreferenced": [
          "testScope",
          "catBatch"
        ]
      }
    ],
    "exportingFilesWithoutSiblingTest": [
      "src/limitations.js",
      "src/scan-parts.js"
    ]
  },
  "V2": {
    "row": {
      "id": "nofindings",
      "trace": "auto",
      "findings_present": false,
      "inline": {
        "total": 0,
        "byKind": {},
        "byConfidence": {
          "high": 0,
          "low": 0
        }
      },
      "summary_only": 0,
      "pre_existing": 0
    },
    "printedTable": "pr          trace  inline  high  low  summary  pre-existing\nnofindings  auto   0       0     0    0        0",
    "tableMentionsFindingsPresent": false
  }
}
```

</details>

### 附录 C：覆盖核对脚本（coverage-check.cjs）

<details>
<summary>展开脚本或结果</summary>

```javascript
// Coverage check for the supplement's section 2: git ls-tree minus the declared out-of-scope patterns, diffed against the paths/globs in the table.
// Run from a checkout: node coverage-check.cjs <doc.md> [ref]
const fs = require('node:fs'), cp = require('node:child_process');
const doc = fs.readFileSync(process.argv[2], 'utf8').replace(/\r/g, ''), ref = process.argv[3] || 'origin/main';
const tracked = cp.execFileSync('git', ['ls-tree', '-r', '--name-only', ref], { encoding: 'utf8' }).split('\n').filter(Boolean);
const rx = (g) => new RegExp('^' + g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*\//g, '\u0001').replace(/\*\*/g, '\u0002').replace(/\*/g, '[^/]*').replace(/\u0001/g, '(.*/)?').replace(/\u0002/g, '.*') + '$');
const OUT = ['**/*.test.js', 'test/**', 'tests/**', '**/fixtures/**', 'eval/cases/**', 'eval/results/**', 'eval/replay/*.json', 'docs/**', 'research/**', 'NOTICE', '.gitattributes', '.gitignore', 'eval/**/README.md'].map(rx);
const inScope = tracked.filter((f) => !OUT.some((r) => r.test(f)));
const sec = doc.slice(doc.indexOf('\n## 2.'), doc.indexOf('\n## 3.'));
const secLines = sec.split('\n'), start = secLines.findIndex((l) => l.startsWith('| 文件 | 状态 |'));
let end = start + 1; while (end < secLines.length && secLines[end].startsWith('|')) end++;
const rows = secLines.slice(start + 2, end); // the first table only (the out-of-scope table below it is not a coverage claim)
const globs = rows.flatMap((l) => [...l.split('|')[1].matchAll(/`([^`]+)`/g)].map((m) => m[1]));
const listed = new Set(), unmatchedGlobs = [];
for (const g of globs) { const r = rx(g); const hit = tracked.filter((f) => r.test(f)); if (!hit.length) unmatchedGlobs.push(g); hit.forEach((f) => listed.add(f)); }
const missing = inScope.filter((f) => !listed.has(f)), extra = [...listed].filter((f) => !inScope.includes(f));
console.log(JSON.stringify({ ref, tracked: tracked.length, outOfScope: tracked.length - inScope.length, inScope: inScope.length, listedInScope: inScope.length - missing.length, tableGlobs: globs.length, missing, listedButOutOfScope: extra, globsMatchingNothing: unmatchedGlobs }, null, 2));
```

</details>

### 附录 C：覆盖核对输出

<details>
<summary>展开脚本或结果</summary>

```json
{
  "ref": "origin/main",
  "tracked": 543,
  "outOfScope": 459,
  "inScope": 84,
  "listedInScope": 84,
  "tableGlobs": 71,
  "missing": [],
  "listedButOutOfScope": [],
  "globsMatchingNothing": []
}
```

</details>
