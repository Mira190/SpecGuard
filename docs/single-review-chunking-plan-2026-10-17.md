# 一次 review、分批执行、一份 GitHub Actions Summary：调研与实施计划

日期：2026-10-17（Australia/Sydney）。代码基线：本地 `7c131b5f6ad78d46279ca038518b2818fc757f1f`，未把它声称为当前远程最新版本。

本次由主 agent 加两个 worker 分别调研 PR pipeline、scan batching 与聚合，再交叉核对。工作范围是调研和计划；没有修改运行代码、触发 Actions 或调用付费模型。

## 1. 结论与目标

**可以实现。建议保留一次 workflow run 中的一个 review job，在 job 内分批、有限并发，最后由一个 publisher 写一份 Summary。** 对用户而言，仍是对同一代码快照的一次 review；worker 数和模型调用数属于执行细节。

当前 scan + Claude API 已经具备“多次调用 → 聚合 → 一份 Summary”的主要路径。需要先补齐范围、part、证据可见性和状态的统一记录，再增加并发。PR 路径则需要把分块提前到 diff 截断之前。

建议验收目标：

1. 一次 review 固定 repository、PR/ref、head、policy base、diff base、需求版本和有效配置。
2. 所有目标先进入清单；分批不能使未选中、未执行或失败的范围消失。
3. worker 只产生结构化结果；统一验证、合并、去重后，只发布一次 Summary。
4. 部分失败仍保留成功批次的有效发现，并明确标记 incomplete。
5. 预算和 deadline 属于整次 review，不能变成每个 worker 各拿一份预算。
6. “全部完成”指声明范围内的必要审查任务完成，不能解释为证明代码没有缺陷或穷尽所有行为。

## 2. 当前实现的证据

以下路径和行号均以本地代码基线为准。

| 环节 | 当前实现 | 对方案的影响 |
|---|---|---|
| Action 入口 | `action.yml:184–242` 选择一个 engine、生成 prompt，再调用一次 adapter | 可在内部增加分批执行，保持 Action 的外部调用方式 |
| scan planner | `src/scan-parts.js:13` 的 `plan()` 生成 unit parts、文档 block batches，复用已有 prompt builder | 应复用，避免再写一套 prompt 系统 |
| scan executor | `src/engines/claude-api.js:425–479` 分配预算、逐批调用、处理局部失败、合并答案和 usage | 已经具备多调用能力；`while` 中 `await call()`，当前严格串行 |
| scan 选取范围 | `src/audit-collect.js:374–376`、`src/engines/claude-api.js:38–39`；默认每调用 12 units、每 run 默认最多 80 文档 blocks、unit calls 最多 8 | 当前不能承诺一次运行扫完整仓库；8 是 unit calls 上限，不是整个 run 的 API 调用总数上限 |
| 大 unit 分段 | `src/audit-units.js:109,242–270` 已有 `id:part`、`parts_left`、unit rooms | 分段身份已有基础，但不是所有后续层都保留 part 粒度 |
| scan completeness | `src/audit-post.js:834–889` 消费失败、预算未执行、未回答等信息 | `incomplete` 表达式未直接消费 collector 的 `inv.parts_left`；只看 engine droppedParts 不足以证明全部分段完成 |
| scan 失败身份 | `src/scan-parts.js` 同时保留 `units` 与 `keys`；engine 的失败记录主要写 `units`，post 用 unit ID 判断 unseen | 同一 unit 多段时需要用稳定 part ID 记录成功和失败，避免合并后丢失分段差异 |
| PR diff | `src/collect.sh:232–263` 默认超过 300 KiB 就裁剪 `diff.patch` | 在这里之后派 worker，已经无法从该文件恢复被裁掉的范围 |
| PR focus | `src/focus.js:133–190`；默认超过 600 行或 25 文件，选风险最高的 12 文件 | 全范围模式应把风险用作执行顺序，不能继续把其余文件移出 review |
| PR 测试候选 | `src/collect.sh:276–318` 有前 60 个 source files、总 16 KiB、每文件 5 个候选等限制 | 必须为每块生成适用候选，并记录候选检索的限制 |
| Prompt/context | `src/prompt.js:9`：diff 40 KiB、requirements 8 KiB、criteria 6 KiB；`src/pack-cap.js`：默认 pack 250000 bytes、单文件 48 KiB | 分块应按实际 source、tests、rules、requirements 的组合大小规划，不能只按文件数 |
| PR 结果契约 | `src/post.js:245,274,296–333` 要求义务 ID 唯一、需求引用有效、finding 与 coverage status 一致 | 多个 worker 的 JSON arrays 不能直接拼接 |
| PR 证据可见性 | `src/post.js:1552–1570` 等位置消费 path 粒度的 `pack-cut.txt` | 多 worker 场景必须先按结果来源验证证据可见性 |
| 单一发布点 | `action.yml:243–271,283–307`，`src/post.js:1476`、`src/audit-post.js:789` | 已有统一 publisher，可保留 |
| Summary 副本 | `src/tee-summary.js` 保存 `.specguard-ctx/summary.md` | 最终报告和下载副本可由同一份渲染内容生成 |
| 展示限制 | PR `src/post.js:14,727,937–959` 共用约 65000 字符 comment 预算；scan `src/audit-post.js:31,678–719` 有 1000000 bytes 和各表行数限制 | 一份 Summary 已存在，但并不表示所有结果已经全部显示 |
| 最终 job 状态 | `src/fail-on-error.js`：配置类失败强制红灯；普通 incomplete 仅 warning | `fail_on_error: true` 当前也不会自动把 incomplete 变成失败；实施时要明确兼容语义 |

还需区分库存发现与执行范围：`src/audit-units.js:14` 有 source/test 数量、文件大小、检索时间等限制。即使所有已发现单位都分批执行，也不能隐去 inventory 本身的遗漏。

## 3. GitHub 平台允许的方式与限制

GitHub 的 `GITHUB_STEP_SUMMARY` 是每个 step 独立的文件；同一 job 的各 step 内容会在 job 完成后归到该 job 的 Summary。多个 job 写 Summary 会显示为多个 job 报告，不能依靠共享环境变量把它们自动合并。已经结束的 step 内容不能由后续 step 修改。因此应让 worker 写 JSON，最后一个发布步骤统一写 Markdown。[GitHub job summary 文档](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-commands#adding-a-job-summary)。

平台对每 step Summary 限制为 **1 MiB**，每 job 最多显示 20 个 step summaries；超限上传失败不必然使 job 失败。因此“任意规模的所有原始细节都放进一份 Summary”无法无条件保证。需要按 UTF-8 bytes 计算空间，并把报告展示截断与审查范围未完成分开记录。[GitHub Summary limits](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-commands#step-isolation-and-limits)。

如果以后需要跨 runner，GitHub 支持由一个 job 定义 matrix、worker jobs 产出不同 artifacts、下游 job 收集。matrix 默认 fail-fast，局部失败保留其他 worker 时需关闭它并限制 max-parallel。[GitHub matrix 文档](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/run-job-variations)。

不能拿 matrix reusable-workflow 的同名 output 当结果数组：其输出选择与最后成功完成并设置该值的调用有关。跨 job 应以稳定名称的结构化 artifacts 收集，再核对完整清单。[GitHub reusable workflow outputs](https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows#using-outputs-from-a-reusable-workflow)。

以上平台约束支持“内部并行、一个发布者”的设计；并不要求第一版就上 matrix。

## 4. 推荐架构

```text
一次 review / 一个固定 snapshot / 一个 review job
  │
  ├─ collect + inventory：保留完整目标与收集限制
  ├─ plan：给各 chunk 分配 primary scope 和共享 evidence
  │
  ├─ queue ── worker 1 ── 独立结果、usage、visibility
  │         ├ worker 2 ── 独立结果、usage、visibility
  │         └ worker 3 ── 独立结果、usage、visibility
  │                       （默认先串行，再做低并发试运行）
  │
  ├─ validate + merge：校验归属、引用、ID、冲突、覆盖、费用
  ├─ 有需要时定向补审跨块关系或证据冲突，再回到 validate
  └─ one publisher → 一份 GitHub Actions Summary
                     + 同内容 summary.md + 完整结构化结果
```

chunk 是任务，worker 是消费队列的执行槽位：例如 30 chunks 可以交给 3 workers 处理。不要把“派三个 worker”实现成只产生三个巨大上下文。

| 方案 | 适用情况 | 本次建议 |
|---|---|---|
| 一个 job，串行 chunks | 先解决范围截断、验证合并正确性 | 第一阶段采用 |
| 一个 job，有限并发 worker pool | 减少模型等待时间，统一预算和发布 | 推荐目标形态 |
| 多个 matrix jobs + aggregate job | 单 runner 时间或资源已成为实测瓶颈 | 延后；会增加快照分发、artifact、安全和跨 job 预算协调 |
| 模型自行决定派 agent、自由探索 | 需要额外探索能力的实验 | 本次不作为默认执行协议，难以用清单证明覆盖并限制总开销 |

第一版优先 Claude API，它已有分批、usage 和费用预检。Copilot / Claude agent 保留已有路径；之后接入相同任务清单时，再处理独立 session、安装复用和软预算语义。不能因新增 workers 就把 CLI 软限制描述成整个 review 的硬预算。

## 5. 范围与分块规则

**scan：** 目标是当前 snapshot 内、用户路径配置选中的 source units、unit parts 和 requirement blocks。全范围执行时不要沿用“只选本轮 80 blocks，再轮到下一次”的逻辑。`max_units` 继续表示每调用容量，`scan_batch_blocks` 表示每调用文档批量；历史 rotation 只服务增量/选定模式。

**PR：** 目标是完整 reviewable diff 中的 hunks、相关测试变化、需求准则和必要的跨文件关系。保留完整 diff，先建立清单再分块；`max_diff_kb` 在新模式中用作每块大小边界，而不是整次 review 的丢弃边界。旧模式保留原语义，输入说明必须明确区分。

每块采用“行为所在 source + 候选 tests + 相关 requirements + 适用规则”。直接耦合且都发生变化的文件尽量同块；超大文件按完整 hunk、函数或相关窗口拆分，保留全局文件路径和原始 LEFT/RIGHT 行号。纯字节等分会破坏 diff 和引用，应避免。

每个任务范围有且仅有一个 primary owner。直接依赖、调用方、共享测试、规则和需求可以进入多个 chunk 作为 evidence，但重复出现不等于完成两份审查。

为跨块关系安排明确任务：调用方与被调用方同时变化、共享配置契约、同一需求的多文件实现、跨文件测试迁移等。先从现有 imports、test map、trace 和 leads 建立有界关系清单；不能宣称这是完备的调用图。必要的跨块任务未完成时，同样进入未完成清单。

不能靠把 `focus_threshold` 关掉、把 `max_units` 调大或把 prompt limit 拉大来实现全范围 review；这样只会把遗漏挪到下一层。

## 6. 一个计划与执行账本

建议先增加小型 `review-manifest.json`，保留现有 `audit-inventory.json`、`scan-parts.json` 的兼容消费。planner、executor、publisher 消费同一份 scope/part 身份，避免各层重新推算“审到了谁”。不需要为此建设通用任务平台。

| 层级 | 最小记录 |
|---|---|
| snapshot | repository、PR/ref、head、policy base、diff base、需求/linked issue 版本、有效配置 hash、SpecGuard build、planner version |
| inventory | 声明目标、发现目标、明确 exclusions、无法枚举/读取的范围和原因 |
| chunk | 稳定 chunk ID、owned unit-part/hunk/block IDs、共享 evidence 引用、prompt/pack hash、估算费用 |
| attempt | chunk ID、attempt ID、开始/结束、API request ID（可得时）、状态、实际模型、usage、费用是否已知 |
| visibility | 实际送入该调用的文件与行区间、完整/部分证据、未送入证据和原因 |
| result | 原始结果位置、验证结果、归一化 ID、finding provenance、未回答任务 |

chunk ID 由 snapshot 和 owned scope 内容生成，不由 worker 编号或完成顺序生成。父块二分后，子块替换父块的目标分配；不得把父块和子块重复计入分母。

任务状态至少区分：待执行、执行中、成功回答、未回答/结果无效、失败、预算未启动、超时未启动。证据完整性是另一维：请求成功不代表上下文完整，更不代表结论为 covered。

建议总状态：

- `complete`：声明范围内所有必要任务均完成验证，重要证据缺口、收集遗漏和未执行项均为零；findings 可以非零。
- `incomplete`：已有可用结果，但存在失败、未执行、未回答、重要证据不完整或 inventory 无法闭合。成功范围的发现继续发布。
- `failed`：没有可用审查结果，或身份校验/收集/聚合/发布等关键阶段失败。若仅有可靠的确定性结果，要在报告中明确它与模型结果的来源。

Summary 同时展示范围是否完成和结论是否有缺口，不能把“没有 finding”“所有文件触达”“selected scope 完成”“全仓完成”混成一件事。

例如：43 units 都触达，但只有 70/74 parts 回答、13 units 的测试证据不完整，应显示 incomplete，不能写“43/43，全部审完”。

## 7. worker 调度、预算和失败处理

先固定队列和串行行为，再加 2 workers 试运行；有质量、限流和费用数据后再评估 3–4。第一版不做自适应扩缩容。

协调器在每次发出请求前检查：

```text
已确认花费 + 结果未知请求仍保留的费用上界
           + 全部在途请求预留 + 本次请求/补审预留
    <= 整次 review 的预算
```

预留与入队必须由同一协调器完成。不能让几个 worker 各自读取 remaining budget 后同时决定“还能花”。已知真实 usage 后才结算；超时、网络断开且可能已计费的调用不能当成零花费释放预留。

沿用现有 worst-case 预检，但要单独审计重试、schema fallback、overflow 拆分、遗漏重答的每次请求。价格表、token 上界、缓存策略和计费假设要可追溯；未知模型价格或未知消耗时，不能把估算描述成提供商账单的绝对保证。

deadline 属于整个 review。停止派发要早于 job timeout，为收拢结果、验证、渲染、上传留出实测安全余量。单个请求有自己的剩余时间限制，429/5xx 使用有界退避；账号/权限/模型配置错误应停止继续派发。

worker 写入各自的 chunk/attempt 路径，采用完成后原子提交结果的方式。禁止竞争写公共 `findings.json`、`usage.json`、`engine-status`、`scan-parts.json` 或 Summary。聚合器处理 worker 未写出文件、异常退出和输出损坏。

发生部分失败后，尽量完成仍可执行的独立任务；已确认配置错误时停止新增调用。scan issue 由 publisher 最后更新一次，失败 part 不推进审查进度。**同一 run 的两个 worker、重试或重复发现都不算两次跨 run 确认。**

取消和 runner 强制终止属于平台边界：保留现有 superseded/cancelled 不向 PR 发布旧结果的约束。正常超时可预留发布窗口；整个 runner 被杀或 workflow 被取消时，不能保证一定还有最终 Summary。

## 8. 聚合的正确性要求

1. **先按来源验证，再合并。** 每个结果只准判断其 owned scope；可以引用获准共享 evidence。文件路径必须在快照内，行号和 quote 必须对上对应 commit，规则来源继续信任 policy base。
2. **重写局部 ID 与全部引用。** `O1` 变成如 `chunkA:O1`，同步改写 finding/requirement 的 `obligation_ids`。collector 分配的 `R/S/H/D` ID 保持全局，同一 criterion 合并有效引用集合；模型自行发现的 requirement ID 再命名空间化。
3. **可见性随结论保留。** A 没看全某测试，B 看全了，不能把两个 worker 的 `pack-cut.txt` 简单 union。先验证各自结论，合并后仍保留 provenance；B 的完整上下文也不能凭空补足 A 的无关结论。
4. **覆盖合并保守且可追溯。** 一个需求对应多个义务时，某一行 covered 不能覆盖其他行的 verified gap 或 unknown。证据矛盾进入定向补审或 needs_human；不能靠模型多数票或更高 confidence 决胜。
5. **去重与冲突分开处理。** 重复 finding 按 kind、行为/位置、quote、需求来源归并，保留来源集合；不同义务、不同 LEFT/RIGHT 或相同位置的独立问题不能误删。现有 publication fingerprint 可复用，但不足以承担所有语义冲突处理。
6. **按计划顺序合并。** 结果不受 worker 完成顺序影响。最终排序、数量、状态应稳定；动态耗时和 request ID 可不同。
7. **全局限制最后应用。** inline comments、每文件 comment 数和展示行数只在全体结果聚合后应用一次。worker 不发布 PR comments 或 reviews。
8. **完成标记与消旧线程依赖全局完成。** 不完整 review 不写 complete HEAD marker，不把未审到的旧 finding 视为已解决，不执行以完整审查为前提的 stale-thread resolution。
9. **完整 identity 校验。** 不能混合不同 head、diff base、需求版本或有效配置的文件。发布 PR 前再次检查 live head；review 配置变化同步进入 preflight/post 的 CFG。

最终仍生成现有 publisher 可消费的聚合结果和 usage。PR 对 worker-local 验证和 visibility 的支持需要有针对性的改动；不能只生成一个大 `findings.json` 就假定原有单调用校验全部适用。

## 9. 最终 Summary 的内容

用户首先看到结论和可采取行动的发现，分批细节放在同一报告的 Details 中。建议示意如下，数字仅为展示例子：

```text
SpecGuard review · repo@head
Incomplete：发现 7 项缺口，另有 4 个任务未完成。

Scope：43 units；完整证据 30，证据部分可见 13。
Execution：70/74 parts 有效回答；2 failed、2 budget-not-started。
Requirements：已回答 X/Y blocks；未知、存在缺口分别计数。

Findings：去重后的全部简明结论，带文件/行链接和测试建议。
Not completed：具体范围、原因、下一步，不只给一个百分比。

Details：按文件展开的证据、任务结果、实际模型、调用数、费用。
Artifacts：完整结构化结果和报告副本（有生成时才提供链接）。
```

呈现顺序：总状态 → findings → 未完成范围 → scope/evidence → 折叠的执行详情。独立 units、parts、hunks、blocks、API attempts 使用各自分母，不再出现“71 of 43 units”一类混用。

PR Summary 与 PR comment 分开设置大小预算：Actions Summary 建议控制在 900 KiB 以内，PR comment 继续守其较小限制。scan 现有 top-N 列表应改为“简明结论优先、详细 skeleton/证据折叠”，尽可能让所有发现的简明条目进入同一份 Summary。

若仍超限，保留总状态、总数、未完成范围、优先发现和明确的省略数量，并提供真正可下载的完整结果。完整 JSON 不因展示 cap 丢弃条目。报告分别标记 `execution_complete` 与 `report_truncated`；展示省略本身不代表对应代码未审查，反过来也不能因 JSON 存在就把未审查项写为完成。

artifact 不存在或用户关闭上传时，不能提示去下载一个不存在的文件。结果引用目标仓库内容，继续沿用现有跨仓可见性检查、保留期和访问限制；worker 不把原始 prompt、密钥或 source 直接写入日志。

## 10. 建议新增的配置与兼容方式

建议只新增两个公开输入，具体命名可在实现 PR 中与现有约定统一：

| 输入 | 建议值 | 行为 |
|---|---|---|
| `review_scope` | `selected`（兼容默认） / `all` | selected 保留当前选取/rotation；all 为声明路径内全部目标建任务，预算不足仍明确 incomplete，不静默改回抽样 |
| `review_workers` | 整数 1–4，默认 1 | 先保证串行分批正确，再用 2 做并发 canary；不改变总预算 |

手动 workflow 可以显式选择 all，符合“一次 review 看完整范围”的使用场景。不要靠用户关闭 scan issue 才偶然触发某种全量行为；scan state 和本轮审查范围是两个独立概念。

all 模式下对 `max_units`、`scan_max_blocks`、`max_diff_kb`、`focus_*` 的语义需写清并验证，尤其不能让 scan_max_blocks 继续暗中限制全量范围。已有 ignore、secret deny、用户 scope 和安全边界不因 all 取消；all 也不代表读取整个磁盘。

首版仅 Claude API 支持 all 时，其他 engine 对该组合给出清晰配置错误，并照常走单一失败报告；不要静默退回 selected。接入其他 engine 后再扩大支持矩阵。

继续保留 `complete / incomplete / failed`。对 all 模式的手动 run，建议在 Summary 发布后将 incomplete 作为未达成目标返回非零；selected advisory 路径保持当前行为。这个变化需落在 `fail-on-error.js` 和输入说明中，不能只把现有 `fail_on_error` 打开就假设已经实现。

## 11. 按依赖排序的实施计划

| 阶段 | 修改范围 | 交付与验收门槛 |
|---|---|---|
| P0：统一范围与 part 身份 | `audit-units.js`、`audit-collect.js`、`scan-parts.js`、`claude-api.js`、`audit-post.js` | 最小 manifest；collector 未计划的 parts、engine 未执行的 parts、失败/未回答 parts 全部可追踪；修复 parts_left 不参与全局完成判断的问题；一次 Summary |
| P1：scan 同次全范围、串行分批 | 上述文件、`action.yml`、`validate-inputs.sh`、相关 tests | all 的所有目标先入清单；每次按预算执行，超过预算如实 incomplete；不把固定八次 unit calls 当全量证明；scan issue 最后统一更新一次 |
| P2：PR 同次全范围、串行分批 | `collect.sh`、`focus.js`、`prompt.js`、小型 `pr-parts.js`、engine、`post.js` | 截断前保存完整快照；风险用于排序；逐块构建候选与证据；ID 重写、visibility、跨块必要任务和聚合验证通过；小 PR 仍一次调用 |
| P3：有限并发 | engine 调度、attempt/usage 记录、并发测试 | 从 1 到 2 workers；在途预算、deadline、重试、乱序输出可证明正确；所有公共输出只由协调器写 |
| P4：交付与试运行 | 两个 publisher、`tee-summary.js`、`fail-on-error.js`、manual/reusable workflows、README、engine docs | Summary/comment 大小分离；全局发现和 scope 信息完整；新增输入转发、CFG、结果 artifacts、自举 pin 和文档一致；真实小规模 Actions 验证 |

每个阶段的基本 findings、状态和 Summary 验收必须当阶段完成，不能拖到 P4 才知道中间结果是否被丢弃。P4 做完整的展示、兼容和真实环境验收。

建议分成四个可审查 PR：①账本与 scan correctness；②scan all + 单一报告完善；③PR chunking + 聚合；④有限并发。真实试运行贯穿后续 PR。先完成 correctness，再用性能数据决定是否需要跨 runner。

`.github/workflows/specguard.yml` 会转发 Action inputs，并以固定 SHA 引用 Action；新增配置后需同步转发和契约测试，按仓库现有 `bin/pin-reusable.js` 流程更新 pin。manual workflow 的结果 artifact 需加入 manifest 和聚合状态，不能只上传 worker 局部文件。

## 12. 验证与效果衡量

以下测试是目标行为测试，不只是复刻实现细节：

| 场景 | 必须验证的结果 |
|---|---|
| PR >300 KiB、>60 source files、风险 top 12 之外埋一个缺口 | 该范围进入任务，实际被对应 worker 看到，最终一份 Summary 出现有效 finding |
| 大文件后半段、删除测试、跨文件重命名或契约变化 | 分段无遗漏/重复；LEFT/RIGHT quote 和原始行号正确；跨块缺口可检出 |
| scan 的某 unit 第一段成功，后续段未入选或失败 | unit touched 不等于 fully reviewed；最终 incomplete，具体 part 留在未完成清单 |
| 两个 chunk 都返回 O1；同一 R1 对应不同义务 | ID、引用无损，需求不被去重误删，covered 不覆盖 gap |
| A 的测试证据被 cut，B 看到完整测试 | 各自 visibility 正确生效，无相互污染或无证据升级 |
| 一块 invalid JSON、超时、529、遗漏答案、预算不足 | 其他成功 findings 保留；未完成范围明确；无 complete marker、无误消旧线程 |
| 并发乱序、动态二分、重试、未知费用 | 全部任务唯一归属；最大并发受控；预留不透支；规范化结果稳定 |
| 新 head/需求版本到来，或混入其他 snapshot 的文件 | 拒绝混合，PR 不发布过时结果 |
| 同一 run 多 worker 重复发现 | findings 去重；不触发“两次 run 已确认” |
| 超多发现、多字节中文、大 skeleton | Summary UTF-8 bytes 守限；省略数准确；完整结果不因展示 cap 丢失 |
| `delivery: summary` | 只写一个报告，无任何 PR writes；失败路径也有单一报告 |
| 新 inputs、CFG、reusable pin、unsupported engine | 转发一致；配置变化触发重审；不静默降级 |

离线阶段使用现有 eval/seeded cases，加上跨块和后半文件 planted gaps。比较固定 snapshot、模型、prompt/pack 配置下的单调用、串行 chunks、2-worker chunks。分别记录 verified findings、漏报、误报、证据保留率、scope 完成率、实际 tokens/cost、付费失败与 p50/p95 耗时。

并发收益以实测为准：它主要减少等待时间，不能先承诺提高召回或降低费用。更细的 chunks 可能改善局部上下文，也会重复共享信息并增加跨块关系成本。

上线门槛：关键 coverage/aggregation/failure 测试通过；相同 fixture 的串行和并行结果一致；预算/限流符合预期；真实 Actions 中只有一个最终 review Summary；旧的小 PR 和 selected scan 无行为回归。保留配置回退到 1 worker 和 selected 的路径。

## 13. 本次验证范围与剩余不确定性

本次读取了 Action、manual/reusable workflows、PR collector/focus/prompt/post、scan planner/collector/post、Claude API engine、schemas、preflight 和相关测试，核对了 GitHub 官方 Summary/matrix 文档。已有本地历史调研仅作线索，现状结论以本轮代码为准。

尝试运行相关离线测试。主 agent 执行 `node --test --test-reporter=dot src/claude-api.test.js src/audit-post.test.js src/prompt.test.js src/focus.test.js src/audit-action.test.js`；scan worker 也执行了相关测试。整体未通过：Windows sandbox 下临时 Git fixtures 无法写 `.git/config`，Bash 启动出现 Access denied/`0xC0000142`，部分 context-pack 断言亦失败。worker 观察到 scan-parts、unit-rooms、keptRooms 的核心测试通过，但这不能代替全套绿色验证。

实施后需在项目实际使用的 Linux/Node 22 CI 验证。尚未通过真实模型实验测量最佳 chunk 大小、跨文件召回、并发限流、总费用和耗时；因此本计划没有给出无依据的价格、性能提升比例或完成工期。

本次只新增此调研文档，未改运行逻辑、未发布 GitHub 内容。建议的下一步是 P0：先让同一个 part 身份贯穿计划、执行和报告，再把一次 review 扩到全部目标。
