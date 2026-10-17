# 跨仓库 shift-left 扫描与报告操作方案

日期：2026-10-16。适用基线：SpecGuard `b1aaf113aae3ca69fcc70e7b9026130affa6c30f`。

本文配套[大厂调研报告](shift-left-industry-research-2026-10-16.md)。目标是对其他仓库做范围诚实、证据可复核、能推进到修复的分析。以下命令是操作示例，本次没有执行外部扫描、付费调用或发布操作；替换占位符后才可使用。

## 1. 先选择要解决的问题

| 问题 | 入口 | 合理输出 |
|---|---|---|
| 提交PR前，本分支是否缺保护？ | 当前本地脚本或直接技能使用；脚本实际只审已提交变更 | 变更行为缺口，未提交内容不在脚本范围 |
| 这个PR是否引入测试缺口/需求偏差？ | 正常PR Action或手动PR链接 | introduced发现、历史漂移另列 |
| 这个仓库优先补什么？ | 单仓scan | 高价值历史缺口、范围账本和下一批 |
| 多个仓库是否存在同类已知错误？ | 明确条件的variant campaign | 每仓独立证据和未支持/不可读目标 |
| 是否减少QA返工？ | 真实回放+真人对照试点 | 有效提前干预与成熟观察窗的逃逸结果 |

不要把一次 risk-focused scan 命名为全仓质量认证。新接入仓库先做单仓只读报告，确认噪声和范围后再扩展。

## 2. 准备扫描清单与不可变快照

建议 manifest 包含：

```json
{
  "manifest_version": "proposal-1",
  "campaign_id": "pilot-001",
  "purpose": "requirements-aware unit-test-gap baseline",
  "targets": [
    {
      "repository": "ORG/target",
      "requested_ref": "main",
      "resolved_sha": "FULL_TARGET_COMMIT_SHA",
      "scope": ["**"],
      "requirements_paths": ["docs/requirements/**"],
      "standards_paths": ["CONTRIBUTING.md"],
      "test_paths": ["tests/**"],
      "delivery": "local-report",
      "execution_policy": "static-only",
      "owner": "TEAM_OR_PERSON"
    }
  ],
  "analyzer": {"action_sha": "FULL_SPECGUARD_COMMIT_SHA", "config_ref": "approved-config"},
  "budget_policy": {"max_total_usd": null, "max_wall_minutes": null}
}
```

这是拟议的报告清单，当前CLI不会直接读取它；`null` 表示预算尚未确定，不代表无限授权。scope 应包含关联测试与需求；若限制子树导致外部关系不可见，报告边界，不将搜索失败当作缺实现。

目标清单由实际授权范围确定，不以“token能列出”自动扩大扫描。源仓库读权限、模型调用、执行验证和报告写权限各自明确；集中报告库的读者不能比源材料允许的读者更广。当前 visibility guard 不是完整成员ACL证明。

可用以下只读查询解析并记录目标版本；分支默认不是 `main` 时替换，输出作为记录，不拿未核对的输出拼接命令：

```powershell
gh api repos/ORG/target/commits/main --jq .sha
gh api repos/ORG/target --jq '{name: .full_name, visibility: .visibility, default_branch: .default_branch}'
```

分析版本也固定完整 SHA。重复比较时保持目标树、模型、提示和预算一致；故意改变的变量单独记录。

## 3. 三条当前可用的运行路径

### 3.1 路径A：先只收集单仓画像，不调用模型

在独立 scratch clone 中检出已确认的目标 SHA，避免让 collector 接触用户正在编辑的工作区。不要安装目标依赖或运行其 hook、MCP、构建与测试。支持 Git/Node 环境与访问条件需按现有项目要求准备。

以下在已准备好的 clone 上运行；`CTX` 必须指向本轮专用、可丢弃的全新目录，因为 collector 会删除并重建该目录：

```powershell
$env:CTX = 'C:/scratch/specguard-run-001/ctx'
$env:SCAN_ISSUE = 'false'
$env:MAX_UNITS = '12'
$env:SCAN_MAX_BLOCKS = '80'
$env:AUDIT_BRANCH_GUARD = 'off'
Push-Location 'C:/scratch/target-at-fixed-sha'
try {
    git rev-parse HEAD
    git ls-tree -r --full-tree HEAD
    node C:/path/to/SpecGuard/src/audit-collect.js
} finally {
    Pop-Location
}
```

先保存或清理会影响本次分析的继承环境，特别是 `REQ_PATHS`、`STANDARDS_PATHS`、`TEST_PATHS`、`IGNORE_EXTRA`、`SCAN_PATHS` 和 GitHub 运行变量；输出记录最终有效配置。示例只调用静态收集器，不会产生模型质量结论；不要把 `audit-inventory.json` 的风险线索当确认缺陷。

读取 `audit-meta.json`、`audit-inventory.json`、候选文档、未纳入文档、test-layout、standards及carry信息，补一份完整tracked tree账本。现有collector输出有caps，不能假定它已经给所有文件完整分类。

`SCAN_ISSUE=false` 不读取历史轮转状态；相同输入重复调用可能总看同一批。此路径适合画像与范围核对，不是持久化全仓调度器。运行后恢复本次设置的环境，避免污染下一仓的分析。

### 3.2 路径B：复用中央manual workflow做一次模型扫描

已有 `.github/workflows/specguard-run.yml` 支持target repo/tree/PR链接。代码中的 `resolve-inputs.js` 能识别tree URL中的40位SHA，因此可固定目标：

```powershell
gh workflow run specguard-run.yml --repo ORG/SpecGuard --ref main -f target=https://github.com/ORG/target/tree/FULL_TARGET_COMMIT_SHA -f scan_issue=none -f post_to_pr=false
```

执行这条命令会启动远端Actions并消耗模型/runner资源；`--ref main` 选择控制工作流版本，并不固定扫描引擎版本。需要在运行记录中保存实际dispatch commit；长期比较应由固定受信工作流调用固定SHA的Action。若组织环境只允许main，不为固定版本绕过环境保护。

此配置不向目标PR或scan issue发布，结果留在control run page，但control run page仍可能包含源仓片段，必须符合受众范围。先按已有workflow要求准备App/PAT、模型凭据及受保护environment；不要把密钥写进文档或命令。

**本基线的实际限制：** manual workflow 当前pin了 `haiku-5.5`，输入界面没有model/engine/scan_paths/max_units开关；上下文artifact保留设为0。不能用想象中的 `--model` 或 `--scope` 输入操作它，也不能承诺下载到本轮raw context。需要这些配置时，使用/评审具体的adopter workflow，不改secret约束来绕过。

选择 `scan_issue=specguard` 或 `target` 才会写issue并保存跨轮状态；这应作为明确选择。`none` 模式不能提供两次确认和持续轮转。即使保存了issue，两轮同意也只是模型结果稳定信号，不是语义证明。

### 3.3 路径C：需要可持续扫描时，复用Action并固定范围

在受信workflow中检出授权目标和固定版本的SpecGuard，按现有接口设置：

- `mode: scan`、`repository`、确切checkout/head SHA。
- `scan_paths`、`requirements_paths`、`standards_paths`、`test_paths`、`ignore`。
- `max_units`、`scan_max_blocks`、模型/engine、总预算和超时。
- 是否写scan issue，写到哪里，谁可以读；不写issue时由外部明确保存任务前沿，当前没有现成通用ledger输入。
- 经批准的artifact保留策略；输出到更广受众前做ACL核对。

这是一项具体workflow配置工作，不是本报告已实现的新入口。首轮复用现有状态；缺少完整任务账本、预算适配、跨仓聚合等能力时诚实列为待建。

不要把现有本地PR脚本称作全仓scan CLI；它是已提交分支与base的变更审查，也不支持自动轮转所有source文件。

## 4. 建立互斥的范围账本

每个tracked文件先有且仅有一个纳入决策：

`included / excluded / unsupported / unreadable / unclassified`。

另用可多选roles描述source/test/requirement/rule/config等用途，避免同一文件兼任需求和规则时重复计分母。对submodule、LFS、generated、迁移和外部规格单独说明展开状态与责任范围。

```text
tracked_total = included + excluded + unsupported + unreadable + unclassified
```

该等式只核对资产。included中的行为任务再有单独队列：

`pending / running / reviewed / unknown / deferred / failed`。

队列带 `revision、task_id、evidence_dependencies、cursor、attempt、last_actual_progress、next_action`。多次attempt不得重复消耗独立任务分母；unknown、deferred、failed不能被归入“无缺口”。

任何变更会生成新snapshot并触发相关证据失效；只对同一snapshot讨论“是否最终扫完”。持续变化的大仓应另报已审证据年龄，不能承诺一个永远移动的全局终点。

## 5. 每批审查固定做什么

1. 选本批行为及相关需求，说明oracle来源、冲突与版本。
2. 搜公共入口、实现和所有相关测试候选；记录未读位置。
3. 将source+test+requirement作为预算单元；不适配预算的任务分裂或延期。
4. 形成每行为的一条证据链和具体输入/预期，不要求每个helper直接测试。
5. 核验引用和适用规则，查替代测试、跨文件迁移、已有漂移和分阶段发布。
6. 对高价值候选做反证；能运行时再走隔离验证。
7. 汇总四轴，不让“没有规则”变成“标准已确认”，也不让高层覆盖冒充unit保护。
8. 保存本批实际完成范围、验证降级和下一批；cursor按已处理范围推进。

建议一份finding记录至少有：行为、后果、独立需求、具体引用、已有测试、目标错误/反例、证据等级、未证实部分、最小修正、负责人和验收方法。模型confidence仅是信号，不能替代人工校准后的precision。

## 6. 执行验证的两种成功

| 任务 | 有效成功 | 无效成功 |
|---|---|---|
| 增强本来正确的行为保护 | 新测试在HEAD通过；能够拒绝有意义的目标故障 | 只是增加行覆盖或重复已有断言 |
| 暴露需求偏差 | 需求期望独立确认；新测试在错误实现失败，修复后通过 | 为让测试绿而把需求期望改成错误实现的结果 |

构建失败、依赖缺失、timeout、flaky和真正断言失败分开。必要的baseline在同环境运行；不能把环境崩溃当发现了业务缺陷。单位测试不适合表达的跨服务错误应保留集成验证。

现有 `eval/prove.js` 只适用于它支持的local-eval输出结构与有限Node测试范围，不是任意仓库的一键证明工具。先阅读其README，再在受控副本执行；不要为追求“通用”自动运行发现的任意test command。

## 7. 全仓基线怎样服务后续PR

全仓报告先登记高价值历史风险，交团队决定处理顺序。后续PR再关联变更行为及其当前证据：

- 本PR新引入：可首屏向作者提出修正。
- 历史问题但与本次修改相关：说明先前状态和此次风险，避免归错责任。
- 与本PR无关的存量：留在基线，不反复刷到作者。
- 相关需求/测试变了：旧covered失效，重新核对。

修复后记录独立行为的verified结果，不按每次push重复计修复。优先保证PR即时反馈预算；全仓后台任务不应挤占所有模型额度和作者处理能力。

## 8. 需要保存的工件

建议输出布局如下，不表示这些文件现在都会由SpecGuard自动生成：

```text
campaign/
  manifest.json
  portfolio-summary.md
  repos/REPO_ID/REVISION/RUN_ID/
    provenance.json
    inventory.jsonl
    scope-ledger.jsonl
    evidence-manifest.json
    review-events.jsonl
    validated-findings.json
    report.md
    verification/INDEX.md
    follow-up.csv
```

现有 `audit-meta.json`、`audit-inventory.json`、`audit.json`、`engine-model.json`、用量/遗漏信息可映射到这些职责，优先复用，不同时维护两套语义冲突的真值。没有生成的工件写missing，不能用空文件伪装。

原始代码/prompt/测试输出只在明确允许时保存，按源仓ACL隔离和定期删除；跨仓汇总默认保留计数和受控链接。`scan_issue`隐藏状态不是不可见，issue读者能读取它。

## 9. 报告发布前核对

- 仓库和精确SHA正确，源码链接固定到该SHA；LEFT引用链接到base。
- 所有文件纳入决策守恒，任务范围可复算，排除和不支持显式可见。
- 需求、unit、标准、层级分别给结论和限制；不把not applicable记为失败。
- 缺测试依赖充分搜索；截断或不可读时不作绝对不存在判断。
- finding按行为和根因去重；summary与inline不重复计收益。
- 静态、执行、故障区分能力和需求oracle证据分开。
- 有负责人、最小行动、验证方式和下一轮范围。
- 费用包含全部attempt；模型估价与实际账单来源分开。
- 共享目的地受众已核对；文档中的未来能力没有写成已完成。

用[报告模板](templates/repository-shift-left-report.md)生成每仓报告，再以风险、可信证据和团队容量汇总组织行动清单。检查通过意味着报告可信地描述了已做工作，不意味着仓库无缺陷。

## 10. 用现有回放工具验证潜在收益

以下复用实际CLI接口；样例需要独立scratch目录、gh读权限以及人工确认，不自动调用模型：

```powershell
node eval/szz.js mine --repo C:/scratch/target --since 2026-04-01 --gh-repo ORG/target --label-scan --max 50 --out C:/scratch/replay/manifest.json
node eval/replay.js prepare --repo C:/scratch/target --base ORIGINAL_BASE_SHA --head ORIGINAL_HEAD_SHA --out C:/scratch/replay --id bug01 --title ORIGINAL_TITLE --body ORIGINAL_BODY --trace auto --shared
node eval/replay.js finish --id bug01 --out C:/scratch/replay
```

第二步与第三步之间，需按replay README用批准的模型产生并保存finding输出，不能空跑finish就声称验证完成。`--body` 在这个CLI接收正文文本，不是正文文件路径；长正文应通过正确shell参数或受控调用传入，不能擅自发明 `--body-file`。

先人工确认引入关系和scope，冻结当时可得意图；后续fix只给裁定者。分别记direct/indirect/miss，并配干净样本；看[replay rubric](../eval/replay/README.md)与[原验证计划](validation-plan.md)。

## 11. 本方案何时算落地

至少在一个真实授权仓库完成：固定snapshot的范围账本、一份四轴分析报告、一个可复核的QA前保护增强或缺陷修复、一次按同版本复跑且进度可解释、以及一份误报/漏报/成本记录。再扩语言与仓库类型。

不以“workflow绿”“扫到了所有文件名”“两轮模型同意”“评论被关闭”替代这些验收。
