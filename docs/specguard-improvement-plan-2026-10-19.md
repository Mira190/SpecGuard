# SpecGuard 改进方案（第一性原理，对标顶尖从业者）

日期：2026-10-19。

**对象**：管理层与 repo 贡献者。他们先信服因果解释，项目才能快速 shift left。

**基线**：`origin/main` = `4176c33`（#388）。所有关键词核查都在这个 SHA 上用 `git grep` 完成。本轮未调用模型，也未对 GitHub 做写操作。

**修订说明**：初稿依据的是落后 main 173 个提交的本地分支，并且漏读了 `docs/validation-plan.md`。初稿里关于"随机分组、预注册、盲标、作者反馈都不存在"的说法有误，本版已改正，见 §1。

## 0. 要证明的那一句话

**主张**：在同一类 PR 上，打开 SpecGuard 比不打开好。具体是三点：

- 逃到 QA 或生产的缺陷更少；
- 缺陷修得更早；
- 收益大于人的注意力成本和费用。

因果链上的每一环都要单独测量，不能用一个综合分数代替。

| 环节 | 现状证据 | 已有的测量设计 |
|---|---|---|
| ① 缺陷存在，SpecGuard 检出 | 离线回放命中 20.7%（9.33/45）；mutation 试点行级命中 0/10（#374） | SZZ 回放（validation-plan Step 1） |
| ② 送达作者（inline 评论，且点名该缺陷） | 30 个检出事件中只有 5 个送达；288 次回放中 213 次 incomplete | 无 |
| ③ 作者采纳 | fix-through A 只是触碰代理；作者 verdict 已实现（#353/#355），但全部 PR 中只有 1 条，而且来自 owner | 三臂试验中的 fix-through 和 verdict |
| ④ 新测试真的能抓住该缺陷 | **无** | **无** |
| ⑤ 没有 SpecGuard 时，缺陷会逃到 QA 或生产（反事实） | **无** | **无**：试验的结果变量是 fix-through、precision、TTM、unique，没有逃逸缺陷 |
| ⑥ 收益大于成本 | **无** | F2 的 P×A 是经济假设，不是实测值 |

顶尖从业者的判断会是：**设计已经齐了，缺的是执行和结果变量。**

- `validation-plan.md` 已有一套完整的方案：三臂试验（PR# mod 3）、两名 senior 盲标、功效样本量、cluster bootstrap、预注册的继续/停止门槛，以及 SZZ 先行证伪（F5）。但这套方案从来没在真实团队上跑过。Kite 的 PR 都是 owner 造的种子，而且 10-18 起因为 billing 停跑。
- 10-14、10-15、10-18 三份评审都提议过 shadow 和逃逸缺陷，但都没有进入 validation-plan，也没有实现。
- 10-18 到 10-19 这两天，`docs/` 又新增了 15 份 AI 评审文档。它们是同一类证据，推不进 ③–⑥。

## 1. 已有什么、真正缺什么

### 1.1 已有，不再重复提

| 能力 | 位置 |
|---|---|
| 三臂分组：0 = SpecGuard、1 = Copilot、2 = 两者 | `eval/assign.js`、`docs/validation-plan.md` |
| 预注册门槛（fix-through ≥25% 且下界 >15%；precision ≥65%；TTM ≤ +15%；unique ≥40%）和证伪条件 | `validation-plan.md` Step 6；`eval/weekly-report.js` 的 `RULE` / `TARGET` |
| 盲标：两名 senior 独立标注，隐藏工具名，按 seed 打乱 | `eval/label-export.js` |
| 样本量门槛（不足时报 "insufficient data"）、PR cluster bootstrap、Wilson 区间 | `weekly-report.js`、`aggregate-counts.js` |
| 作者 verdict（fixed / wrong / intentional / not important）和作者判定噪音 | #353、#355 |
| SZZ 回放、contamination 标注、mutation 试点 | `eval/szz.js`、`eval/replay/`、`eval/mutation/` |

### 1.2 缺口：顶尖从业者会补的

1. **结果变量缺少逃逸缺陷，也就是 phase containment / DRE（Capers Jones）。**
   - 试验只测采纳和噪音，回答不了管理层最关心的"QA 和生产的缺陷是否变少"。
   - 补法：试验期内的 bug-fix PR 用 `szz.js` 反查引入它的 PR，再按 arm 统计每 100 个 PR 的逃逸缺陷数。
   - 8–12 周后再出这个数（10-15 评审已经指出需要等这么久）。
2. **arm 1 没有记录 SpecGuard 本来会说什么，所以无法做反事实。**
   - 补法：arm 1 改成 shadow，SpecGuard 照常运行，但 findings 只写入 artifact，不发评论。之后用 SZZ 对齐，就能直接数出"被隐藏的 findings 本来能拦住几个逃逸缺陷"。
   - 这是让管理层信服因果的最快路径，不必等两组逃逸率的差异达到显著。
   - 这样改不违反"nobody goes without review"，因为 arm 1 仍然有 Copilot 审查。
3. **分组可以被预测。**
   - 作者能从 PR# mod 3 算出自己会落在哪一组，可以开空 PR 来挑选分组。
   - 补法：改用 `HMAC(salt, PR#) mod 3`，salt 存在 secret 中，试验结束后公开。
4. **盲标缺少一致性统计。**
   - 现在是"分歧靠讨论合并成一个文件"。
   - 补法：合并之前先计算 Krippendorff α（或 Cohen κ）。α < 0.67 时标签不能用，先修订标注口径。没有 α，precision 65% 的门槛就无从判断是否可信。
5. **缺执行型 oracle，用来验证环节 ④。**
   - 一条 `missing_test` / `weak_test`，只有满足 fail-to-pass 才算 verified：照建议写出的测试在 buggy 版本上失败，在修复版本上通过。这是 SWT-bench 的方法。
   - `weak_test` 改用 pseudo-tested methods（Descartes / extreme mutation）判定。
6. **角色反转消融：机器定位，模型解释。**
   - 候选来自机器：diff-cover 找出变更后未覆盖的行，加上变更行上存活的 mutant。LLM 只负责分诊和映射到需求。
   - 先例：Google 在 code review 中展示存活 mutant（Petrović et al., ICSE-SEIP 2021）；Meta 的 TestGen-LLM / ACH 只展示通过机器过滤的结果。
   - 这一项直接对应行级命中 0/10。
7. **用 assurance case（GSN / CAE）收敛评审文档。**
   - 结构：主张 → 子主张 → 证据 → 反驳点。每份评审作为证据节点挂上去，并标明它在证据阶梯的哪一层。
   - 反复出现的提议（shadow、逃逸缺陷）在 assurance case 里会显示为"未关闭的反驳点"，不会被新一轮评审再提一次就算完。
8. **仓库自身的质量由第三方工具出证据**：OpenSSF Scorecard、zizmor、actionlint、shellcheck、`src/` 上的 Stryker、CI 中的 gitleaks。在 main 上，Scorecard 只在 10-18 的审计文档里被提到过一次，其余几项都没有作为要求出现。
9. **需求可测性**：按 ISO/IEC/IEEE 29148 检查 AC；每条 obligation 标注它由哪种 ISTQB 技术推导（边界值、等价类、决策表），这样审阅者能检查是否完整。

**核查结果**：以下概念在 `4176c33` 上出现 0 次：Presidio、gitleaks、trufflehog、pseudo-tested、Descartes、SWT-bench、GSN、assurance case、fail-to-pass、Defects4J。另外几项只出现在评审文档里，从未进入计划或代码：
- shadow：10-14 审计第 226、377 行；
- 逃逸缺陷：10-15 评审第 295 行、10-18 审计第 60 行。

### 1.3 顶尖从业者怎样 review

- 先审主张和证伪条件，再看代码。
- 每个数字都要标出它在证据阶梯的哪一层：机制 < 种子 < 离线历史 < shadow < 随机对照 < 纵向 QA 结果。现在最高只到"离线历史"。
- 每个数字都先拿最笨的基线挑战：diff-cover、"改了函数没改测试"启发式、裸 LLM prompt。打不过基线，就说明没有增量。
- 做 pre-mortem：假设三个月后项目被砍，最可能的原因是什么？答案多半是噪音、incomplete 成为常态、拿不出证明。
- **一个已经存在的计划从未执行，这本身就是头号风险。** 不应该再写新的评审，而应该先让 validation-plan 的 Step 1–2 在一个非 owner 的仓库上跑起来。

## 2. 脱敏：从哪些原始材料入手

| 原始材料 | 风险 |
|---|---|
| Actions artifact `specguard-ctx`（diff、prompt 上下文、原始模型输出） | 任何能读该仓库 Actions 的人都能下载 |
| shadow 臂的 artifact（若实施 §1.2 第 2 条） | 同上，而且这些 findings 刻意没有发给作者。私有仓库要缩短保留期、限制访问 |
| Actions 日志、job summary、sticky 评论、inline 评论、scan issue | 含私有代码引用 |
| `eval/results/*.json` 中的 `raw_excerpt`（原始输出前 2000 字符） | 私有代码片段 |
| `label-export.js` 导出的 CSV（finding 原文和 PR 链接）、标注者备注 | 标注者是否可以看私有代码要先授权；备注可能引用代码 |
| 远端分支 | **已核实**：64 个远端分支的 tip 仍包含 #334 已从 main 移除的 `docs/shift-left-live-review-evidence-2026-10-17.json`。本地分支 `codex/publish-sanitized-review-2026-10-17` 落后 main 173 个提交，仍在跟踪两个已移除的文件；远端同名分支（`b70c8d2`）不包含它们 |
| Git 历史：演练时影响 730/1053 个提交、153 个分支、247 个 PR 引用 | 删掉当前文件 ≠ 历史已清除 |
| 本地 `docs/branch-archives/`、`pr311-ctx`、系统临时目录下的 `mirror.git` 和证据目录 | 含源码副本 |
| `docs/` 中 15 份未跟踪的评审文档 | 本机路径（含用户名）、临时目录名，可能还有私有仓库名 |
| `eval/replay/*.json`、`research/*.csv` | 公开仓库贡献者的 handle 和 issue 原文：要遵守许可、保留署名；用作标注集时要假名化 |
| 已经发给 Copilot / Anthropic 的 prompt | 事后无法脱敏，只能在源头控制（`deny.js`、`ignore`、content exclusion） |

## 3. 具体方法和工具

- **默认拒绝发布**：把 `.gitignore` 中 `!report-public.md` 的白名单做法推广到全仓库。先给每个字段定级（公开 / 假名化 / 只出聚合 / 永不发布），只发布白名单 schema 内的聚合字段。
- **假名化**：用 HMAC-SHA256 加密钥。仓库名、登录名这类集合很小，用普通 SHA 可以被字典反推。保留文件扩展名和路径深度。`label-export.js` 的 finding id 已经是 hash，复核时要确认它不能被反推。
- **自由文本**用 Microsoft Presidio，并加自定义 recognizer（仓库名、内部域名、ticket ID）。**代码片段**换成结构描述（语言、kind、行数），不发布原文。
- **密钥扫描**：
  - gitleaks：放进 pre-commit 和 PR CI，并对全部历史跑一次；
  - trufflehog：用 `--only-verified` 扫历史；
  - GitHub secret scanning 加 push protection。
- **蜜标字符串做端到端泄露测试**：在私有目标仓库中埋入唯一标记，CI 扫描所有对外输出（artifact、评论、docs），一旦命中就让 job 变红。注意：仓库现有的 "canary" 指的是 canary PR，不是蜜标。
- **历史清理**：
  1. 用 git-filter-repo（`--invert-paths`、`--replace-text`）重写历史。
  2. 请 GitHub Support 清理 PR refs 和缓存，流程见 `privacy-and-pr-disposition-2026-10-18.md`。
  3. 用 `gh run delete` 或 REST API 删除受影响运行的 artifact 和日志。
- **防止重新识别**：n<5 的单元格不公开。每次脱敏都记录一份 manifest（输入 hash → 工具和版本 → 输出 hash），并由第二个人复核。

## 4. 除了你我之外，谁能证明

| 证明者 | 证明什么 | 说服谁 |
|---|---|---|
| 执行 oracle（测试运行、mutation、fail-to-pass） | finding 是否真实；新测试能否抓住缺陷（④） | 贡献者 |
| 第三方既有的 ground truth：维护者自己的 fix PR（SZZ）、SWT-bench、Defects4J、BugsJS | 检出率，而且标准不由我们制定 | 两者 |
| 非 owner 团队按 validation-plan 跑出的三臂试验，加 shadow 和逃逸缺陷工单 | 反事实与因果（⑤） | **管理层** |
| 真实贡献者的 verdict 回复（≥30 条，非 owner） | ③ 和作者判定噪音 | 贡献者 |
| 两名 senior 盲标，附 α | precision | 两者 |
| 同一批 PR 上的 Copilot code review（已作为 arm 1 / arm 2 设计）及其他竞品 | 增量价值（unique 份额） | 管理层 |
| Scorecard、CodeQL、zizmor、Stryker 徽章 | 仓库自身的工程质量 | 贡献者 |
| 可复现包（固定 SHA、manifest、原始回答） | 任何人都能复跑 | 两者 |

Codex 或其他 LLM 当评审，和"你"是同一类证据。它们只能用来分诊，并且要先用人工标签校准。

## 5. 执行顺序

每一步都附带一个能证明它有效的 eval。

**P0：本周，不花模型费用**

1. **隐私止血**
   - 处理 64 个仍含私有文件的远端分支 tip，以及本地旧分支：先备份，再按精确路径删除；之后做历史清理。
   - 加入 gitleaks、蜜标扫描和白名单发布检查。
   - eval：在 fixture 中埋入蜜标，CI 必须变红。
2. **补全 validation-plan，代码已有部分不重做**
   - arm 1 改成 shadow；
   - 分组改为 HMAC 加 salt；
   - 标注合并前计算 α；
   - 加入逃逸缺陷结果变量（SZZ 按 arm 统计）。
   - eval：`weekly-report.js` 的 fixture 测试覆盖 shadow findings 与 fix PR 的对齐，以及 α 计算。
3. **建立 `docs/assurance-case.md`**：把 §1.2 中反复提出却未关闭的反驳点挂上去。这份文档建立之前，暂停新增 AI 评审文档。

**P1：2–3 周**

4. **找一个非 owner 的真实仓库，跑 validation-plan 的 Step 1**（SZZ 回放最近 50 个 bug，过 F5 证伪门槛）**和 Step 2**（canary 加三臂）。前提是 Kite 的 billing 恢复，或者有另一个仓库可用。
5. **给回放集和 mutation 集加 fail-to-pass 的 "verified" 标签**，复用 `eval/replay.js` 和 `eval/mutation/`。

**P2**

6. 角色反转消融（机器定位、模型解释）。目标是让行级命中超过 0/10。
7. 第三方质量徽章，以及需求可测性检查（§1.2 第 8、9 条）。

**门槛**：沿用 validation-plan Step 6 已预注册的四条，并新增三条：
- α ≥ 0.67 时标签才有效；
- shadow 臂中被拦住的逃逸缺陷数，其 CI 下限高于最佳基线；
- verified precision ≥ 60%。

任一条达不到就收缩范围，这与第三方评审的建议一致。
