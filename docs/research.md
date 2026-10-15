Shift Left 应该不止是普通 PR Review
你之前研究的 Unit Test Review Workflow，其实可以扩展成下面这个分析链：
1

Repository Understanding
识别项目结构、测试框架、现有规范及相关 Skills



2

Requirement Analysis
关联 Issue、需求描述、Acceptance Criteria



3

Change Impact Analysis
识别被修改代码影响的调用路径、逻辑分支



4

Test Gap Analysis
检查遗漏的单元测试、边界场景和异常路径



5

Evidence Verification
结合 AST、测试结果和静态分析验证结论



6

Actionable Feedback
输出定位明确、证据充分、可操作的建议



对 Shift Left 更关键的是：让这些能力在开发者本地、PR Draft、CI 和合并前多个阶段复用，而不是只在最终 Code Review 执行一次

# Cross-Repository Shift-Left Review Agent：统一架构与实施方案

我建议把你的项目定位为：

A repository-independent, requirement-aware test verification agent that operates across local development, pull requests, and repository-wide analysis.

中文就是：一个独立于仓库、支持多个 Agent Runtime、专门检查测试充分性的 Shift-Left Agent。

这不是再做一个 GitHub Copilot Code Review，而是解决 Copilot Review 不一定系统解决的问题：

> 代码实现了哪些行为？需求要求验证哪些行为？现有测试究竟证明了什么？哪些关键行为没有得到合适层级的测试验证？

我们继续沿用你之前确定的核心分析链：

`Requirement → Changed Behaviour → Test Obligation → Existing Assertion → Test Layer → Evidence → Gap`

项目同时支持：

- Local Shift Left：开发者在本地编写或提交代码前分析测试缺口。
- PR Review：其他仓库创建或更新 PR 时自动审查。
- Repository Scan：没有 PR，也能主动分析整个代码库的测试充分性。

## 1. 首先确定技术方案

推荐架构

## One Core, Three Entry Points

三个入口只决定分析范围、执行环境和结果发布方式；不会维护三套不同的评审逻辑。

## 2. 发现了一个对你的项目很重要的 GitHub 更新

GitHub 现在已正式支持 在 GitHub Actions 中用 `GITHUB_TOKEN` 运行 Copilot CLI，不需要自己提供 Copilot PAT 或第三方模型 API Key。

官方文档明确要求：

```
permissions:
  contents: read
  copilot-requests: write
```

然后 Copilot CLI 就能通过 Actions 提供的 `GITHUB_TOKEN` 进行认证。

但计费归属必须区分：

| 场景                      | AI 用量归属                  |
| ----------------------- | ------------------------ |
| 个人仓库 + `GITHUB_TOKEN`   | 仓库所有者的 Copilot seat      |
| 组织仓库 + `GITHUB_TOKEN`   | 组织计费，需启用相应策略             |
| 用户提供的 Copilot PAT       | 该 PAT 所属用户的 Copilot seat |
| 用户主动请求原生 Copilot Review | 按原生 Code Review 规则       |

最重要的结论：你现在已经有了一个无需自备长期 API Token 的 GitHub Action 方案，但不是把费用自动算给 PR 发起人。 组织仓库还需启用 Allow use of Copilot CLI billed to the organization，并为用量设置预算。

[image](https://www.google.com/s2/favicons?domain=https://docs.github.com\&sz=32)

GitHub Docs

+1



因此，我建议：

第一版保留 Copilot CLI Runtime + GitHub Actions，优先把 Review Engine 做成跨仓库可调用的工具；不要一开始就重构成纯 MCP Server 或 GitHub App。

## 3. Review Core：核心分析引擎

这里是整个项目最值得投入的部分。

我建议不要以 `SKILL.md` 或 Prompt 为核心，而是以一个能够在不同 Runtime 中执行的 确定性 Pipeline + Agent 推理模块 为核心。

01

Scope Resolver

Deterministic

确定 PR Diff、Staged Changes 或 Repository Scan 范围

02

Context Resolver

Deterministic

收集 Requirements、Instructions、Skills、测试框架和已有测试

03

Behaviour & Obligation Mapper

Agent Reasoning

识别变更行为，推导需要验证的测试义务

04

Assertion & Test Layer Mapper

Agent Reasoning

将现有测试断言映射到行为，识别 Unit / Component / Integration 层级

05

Gap Generator

Agent Reasoning

提出尚未被充分验证的行为及反例

06

Independent Verifier

Agent + Tools

查找反证、检查现有测试是否已覆盖、确认代码位置

07

Finding Publisher

Deterministic

去重、排序、限制评论数量，产生结构化输出

### 为什么要独立 Verifier？

假设需求是：

> 当客户选择取消保险时，应正确计算退款；如果保单已过期，则不能退款。

代码修改了退款计算逻辑。

Agent 找到现有测试：

```
it("refunds cancelled policy", () => {
  expect(calculateRefund(activePolicy)).toBe(100);
});
```

它可能提出缺失的测试：

```
it("does not refund expired policy", () => {
  expect(calculateRefund(expiredPolicy)).toBe(0);
});
```

但 Verifier 不能立即认定缺失。它应该继续检查：

- 是否有其他单元测试验证过期情形。
- Component / Integration Tests 是否已经有效验证这个行为。
- 需求是否真的规定退款必须为零。
- 是否属于本次代码修改引入的风险。
- 新建议是否只是重复已有断言。

只有没有找到足够反证，且有可靠需求、代码和测试证据时，才发布 Finding。

我会让 Verifier 使用独立上下文，避免第一个 Agent 已经认定有问题后，第二个 Agent 只是重复同样的判断。

这才是你区别于普通 Copilot Review 的核心价值。

## 4. Skills、MCP、Agent Runtime 如何分工？

这三者不能混在一起。

| 组件             | 主要职责               | 是否核心 |
| -------------- | ------------------ | ---- |
| Review Engine  | 控制分析顺序、数据流和验证机制    | 是    |
| Agent Skills   | 告诉模型如何理解测试义务与分析方法  | 是    |
| MCP Server     | 对外暴露分析能力和外部上下文     | 可选接口 |
| Copilot CLI    | 执行需要推理的 Agent 任务   | 可替换  |
| GitHub Actions | CI 执行与自动触发         | 接入方式 |
| GitHub App     | 跨仓库授权、Webhook、结果发布 | 后期接入 |

### 中央 Skills 怎么复用到其他仓库？

假设你的项目维护：

```
skills/
├── requirement-analysis/
│   └── SKILL.md
├── test-obligation-mapping/
│   └── SKILL.md
├── assertion-tracing/
│   └── SKILL.md
├── test-layer-classification/
│   └── SKILL.md
└── finding-verification/
    └── SKILL.md
```

你不需要要求其他仓库复制这些文件。

GitHub 官方文档确认，Copilot CLI 支持项目级 Skills，以及 `~/.copilot/skills` 或 `~/.agents/skills` 中的个人 Skills。还支持通过 `COPILOT_HOME` 指定独立的 Copilot 配置目录。

[image](https://www.google.com/s2/favicons?domain=https://docs.github.com\&sz=32)

GitHub Docs

+1



因此在 CI 里可以：

1. Checkout 目标仓库，作为分析工作目录。
2. 下载指定版本的中央 Review Engine。
3. 在隔离的 `COPILOT_HOME` 下安装中央 Skills。
4. 同时发现目标仓库已有的 Instructions、Skills 和测试规范。
5. 将两类上下文交给 Core 统一解析。

这样你修改中央的 Skill，就能够升级其他仓库的审查能力，而无需每次修改目标仓库。

但是要区分两种机制：

Copilot CLI 自定义运行： 你控制 Skill 安装、调用时机、分析流程。

原生 Copilot Code Review： GitHub 会自行决定是否加载相关 Skills 和 MCP Tools。它能消费你的分析结果，但不能保证严格执行你的七阶段 Pipeline。

[image](https://www.google.com/s2/favicons?domain=https://docs.github.com\&sz=32)

GitHub Docs



### MCP 最适合放在哪里？

我会把 MCP 做成 Core 的一个 只读能力接口，而不是把 MCP 当成整个架构。

例如：

```
shift-left-mcp
├── get_repo_context
├── get_test_obligations
├── get_assertion_evidence
├── get_test_layer_assessment
└── get_verified_test_gaps
```

调用时：

```
Copilot / Claude / IDE
        |
        v
    MCP Server
        |
        v
  Shared Review Core
        |
        v
    Evidence Store
```

这些工具可以返回预先计算的结果；需要执行完整扫描时，则由你的 Core 在合适的受控环境中处理。

未来甚至可以让 GitHub 原生 Copilot Review 通过 MCP 查询：

> 当前 PR 有哪些经过独立验证的 Test Adequacy Gaps？

这样你原生 Copilot Review 也可以成为你项目的一个 consumer，而不是必须取代它。

注意 GitHub 的原生 Review 目前要求 MCP Tool 标记 `annotations.readOnlyHint: true` 才能使用。

[image](https://www.google.com/s2/favicons?domain=https://docs.github.com\&sz=32)

GitHub Docs



## 5. 三种入口的具体实现

A. Local Shift Left

开发者在 VS Code 终端、Git Hook 或普通 CLI 中启动分析。支持 staged changes、working tree changes 和指定 Git diff。

B. PR Review

通过中央 Reusable Workflow，在其他仓库的 PR 上运行。完整分析后发布高信号评论，不直接修改代码。

C. Repository Scan

使用 `workflow_dispatch`、`schedule` 或后期 GitHub App 触发，对整个代码库建立测试充分性基线，并进行增量扫描。

### A. Local Shift Left

计划提供统一 CLI（以下是建议设计的命令，不是已经发布的软件）：

```
# 检查 Git staged changes
shift-left review --staged

# 检查当前所有本地修改
shift-left review --working-tree

# 相对 main 分支分析
shift-left review --base origin/main

# 扫描当前仓库
shift-left scan --scope repo
```

本地可以支持两个运行档位：

| 模式   | 行为                               | 场景         |
| ---- | -------------------------------- | ---------- |
| Fast | 静态收集 + 测试映射 + 低成本检查              | Pre-commit |
| Deep | Agent 推理 + Evidence Verification | 提交 PR 前    |

不建议在每一次 Git Commit 都执行完整 LLM Pipeline。它可能严重影响开发体验。

第一版 CLI 可以用 TypeScript 编写，之后再把它包装成 GitHub CLI extension 或 VS Code Extension。GitHub 官方支持开发自定义 `gh` extension。

[image](https://www.google.com/s2/favicons?domain=https://docs.github.com\&sz=32)

GitHub Docs



### B. Cross-Repository PR Review

假设核心项目是：

`your-org/shift-left-review`

其他仓库只需要一个调用入口：

```
name: Test Adequacy Review

on:
  pull_request:
    types: [opened, synchronize, reopened]

permissions:
  contents: read
  pull-requests: write
  copilot-requests: write

jobs:
  review:
    if: ${{ github.event.pull_request.head.repo.full_name == github.repository }}
    uses: your-org/shift-left-review/.github/workflows/pr-review.yml@v1
```

这是内部同仓库分支 PR 的初始示例。正式使用时建议固定到已审核的 Commit SHA，且中央 Workflow 必须声明 `workflow_call`。

这里 GitHub 的行为非常适合你的需求：

- 可复用 Workflow 可以存储在其他仓库。
- 执行时使用调用方仓库的 GitHub 上下文。
- 可以集中维护规则和执行逻辑。
- 私有仓库的跨仓库复用受 GitHub Actions Access Policy 限制。

[image](https://www.google.com/s2/favicons?domain=https://docs.github.com\&sz=32)

GitHub Docs

+1

但 fork PR 要单独设计安全路径。 GitHub 会对 fork PR 限制 Token 权限，不能假设上面的示例能处理所有外部贡献者。

[image](https://www.google.com/s2/favicons?domain=https://docs.github.com\&sz=32)

GitHub Docs



内部分析也需要隔离权限：

```
Job 1: Evidence Collection
        ↓
Job 2: Agent Analysis (read-only)
        ↓
Job 3: Finding Validation
        ↓
Job 4: PR Publisher (write permission)
```

尤其不能在拥有写入 Token 的环境中直接执行不可信 PR 代码。GitHub 对 `pull_request_target` 加载不可信代码的风险有明确警告。

[image](https://www.google.com/s2/favicons?domain=https://docs.github.com\&sz=32)

GitHub Docs



### C. Repository-wide Scan

这个模式比 PR Review 更难，因为可能根本没有明确的需求描述。

因此要区分两类结果：

有明确需求来源：可以从 Issue、需求文件、Acceptance Criteria 及相关实现中推导测试义务。

只有代码，没有需求：只能从现有行为、接口契约和测试中推断候选测试义务，不能把模型猜测当成真实业务需求。

Repository Scan 可以采用：

```
Initial Baseline Scan
        ↓
Build Behaviour / Test Index
        ↓
Prioritize High-Risk Modules
        ↓
Deep Test Adequacy Analysis
        ↓
Store Baseline
        ↓
Incremental Scans
```

这样不会每次都把整个仓库送给 LLM 分析。

建议按 `package/module` 建立增量缓存，用 Git SHA、配置版本、分析规则版本和相关依赖变化决定哪些模块需要重扫。

## 6. 所有入口必须共享一种 Finding Schema

这一点非常重要。

无论分析来自本地、PR 还是仓库扫描，都必须产生相同的数据结构。

例如：

```
{
  "id": "test-gap-001",
  "type": "missing_test_obligation",
  "requirement": {
    "source": "issue-123",
    "text": "Expired policies cannot be refunded",
    "confidence": "explicit"
  },
  "changed_behavior": "Refund eligibility",
  "existing_test_evidence": [
    "refund.test.ts:20-35"
  ],
  "missing_scenario": "Expired policy",
  "recommended_test_layer": "unit",
  "verification": {
    "status": "verified",
    "counterevidence_found": false
  },
  "location": {
    "file": "src/refund.ts",
    "line": 42
  }
}
```

这个结构是建议中的内部 Contract，不是 GitHub 提供的格式。

有了它之后，你可以用不同的 Publisher 输出：

| 入口              | 输出                              |
| --------------- | ------------------------------- |
| Local CLI       | Terminal / JSON                 |
| GitHub Action   | PR Comments + Workflow Summary  |
| GitHub App      | PR Comments + Check Runs        |
| Repository Scan | JSON Baseline + Markdown Report |
| MCP             | 结构化 Tool Response               |

第一版最好 每个 PR 最多发布 3–5 条高可信度评论，优先过滤重复、推测性和无法验证的缺口。

不建议一开始把普通安全漏洞、格式问题、性能问题都加入输出。那些属于已有 Code Review 和静态分析工具的范围，你真正应该做的是 Test Adequacy Verification。

## 7. 建议的 Monorepo 项目结构

```
shift-left-review/
│
├── packages/
│   ├── core/
│   │   ├── scope-resolver/
│   │   ├── context-resolver/
│   │   ├── requirement-mapper/
│   │   ├── behavior-mapper/
│   │   ├── assertion-mapper/
│   │   ├── layer-classifier/
│   │   ├── gap-generator/
│   │   ├── verifier/
│   │   └── finding-schema/
│   │
│   ├── runtime/
│   │   ├── copilot-cli/
│   │   ├── claude-code/
│   │   └── mock/
│   │
│   ├── adapters/
│   │   ├── local-cli/
│   │   ├── github-action/
│   │   ├── github-app/
│   │   └── mcp-server/
│   │
│   └── publishers/
│       ├── terminal/
│       ├── github-pr/
│       ├── json/
│       └── markdown/
│
├── skills/
│   ├── requirement-analysis/
│   ├── test-obligation-mapping/
│   ├── assertion-tracing/
│   └── finding-verification/
│
├── .github/
│   └── workflows/
│       ├── pr-review.yml
│       ├── repository-scan.yml
│       └── release.yml
│
├── evals/
│   ├── fixtures/
│   ├── golden-findings/
│   └── regression-tests/
│
└── docs/
    ├── architecture.md
    ├── security.md
    └── integration.md
```

我推荐 TypeScript Monorepo + Zod Schema + Copilot CLI Runtime 起步。对你现有的 GitHub / TypeScript / Agentic Workflow 技术栈来说，学习和迁移成本比较低。

不过要注意：跨仓库 Instructions 不是全部可信的执行指令。Core 应区分组织策略、目标仓库已审核的规范和 PR 中新增的未审查内容。外部规则和代码都应该先作为分析数据，而不是直接赋予任意命令执行权限。

## 8. 分阶段实施路线

P0

建立 Evaluation Baseline

第一优先

准备有真实 Test Gap、已有充分测试、无明确需求等案例；定义稳定的评测标准。

验收：能够判断新架构是否优于原有 Prompt Review。

P1

Extract Shared Review Core

核心开发

从现有 GitHub Action 抽取七阶段 Pipeline、统一 Finding Schema 和 Copilot CLI Runtime Adapter。

验收：不依赖 GitHub Actions 也能在本地目录运行分析。

P2

Local CLI + PR Workflow

第一版可用

实现 staged/diff 分析、跨仓库 Reusable Workflow、验证后发布评论。

验收：同一组测试用例，本地和 CI 得到相同的证据及可比较的 Findings。

P3

Repository Scanner

扩大覆盖

实现仓库基线、按模块分析、增量缓存、低置信度结果隔离。

验收：扫描无 PR 仓库，持续追踪测试缺口变化。

P4

MCP + Native Copilot Integration

生态接入

将已验证的 Findings 通过只读 MCP 提供给 Copilot、其他 Agents 或 IDE。

验收：第三方 Agent 可以消费 Core 分析结果，而不重复实现完整 Pipeline。

P5

GitHub App Distribution

产品化

增加 App 安装授权、Webhooks、任务队列、组织级政策和预算管理。

验收：目标仓库不需要逐个添加 Workflow，也可以统一纳入管理。

其中 P4、P5 都不是第一版上线的前置条件。

## 9. GitHub App 是否应该作为最终方案？

我认为是，但它应该是 Distribution Layer，不是 Review Engine 本身。

原因在于你提出了一个更高阶的需求：

> 其他仓库甚至不需要知道你的 GitHub Action，授权之后就能被统一纳入扫描与 Review。

这个要求是单纯 Reusable Workflow 无法完全达到的。

GitHub App 可以让仓库管理员选择授予访问权限的仓库，并通过 Webhook 对 PR 活动做出响应；发布 Check Runs 也可以使用 GitHub App 的 `checks:write` 权限。

[image](https://www.google.com/s2/favicons?domain=https://docs.github.com\&sz=32)

GitHub Docs

+1



但这里还有一个必须提前考虑的取舍：

|                                         | Reusable Workflow | GitHub App + 中央服务 |
| --------------------------------------- | ----------------- | ----------------- |
| 需要目标仓库 YAML                             | 是                 | 否                 |
| 自动 PR Review                            | 是                 | 是                 |
| 无 PR 主动扫描                               | 是                 | 是                 |
| 使用 Actions `GITHUB_TOKEN` 调 Copilot CLI | 可行，取决于策略与权限       | 中央服务不能直接继承        |
| 是否需要自己维护服务                              | 否                 | 是                 |
| 跨组织推广                                   | 需各仓库配置            | 安装授权更自然           |

因此，如果未来要做到 GitHub App 的零 YAML 接入，同时继续使用目标组织的 Copilot Actions 用量，你还需要专门设计执行和计费路径；安装 GitHub App 本身并不等于获得了目标组织的 Copilot CLI 计费身份。

## 10. 怎么验证这个架构真的实现了 Shift Left？

我不会把“Agent 输出了多少条评论”作为核心 KPI。

建议使用以下指标：

| KPI                        | 目标                          |
| -------------------------- | --------------------------- |
| Verified Finding Precision | 试点目标 ≥90%                   |
| False Positive Rate        | 尽可能降低，重点跟踪                  |
| Duplicate Finding Rate     | 不重复提醒同一未解决问题                |
| Requirement Traceability   | 每个正式 Finding 都有需求或明确标记的推导依据 |
| Cross-Entry Consistency    | Local / PR / Scan 使用相同分析契约  |
| Cost per Verified Finding  | 能追踪并逐步降低                    |
| Time to Detection          | 证明问题能在 PR Review 之前被发现      |

其中最重要的是 Time to Detection。

如果开发者在写完函数时就得到一个可靠的 Missing Unit Test 提示，而不是等到 PR 创建之后才看到，这才是 Shift Left 的实际收益。

## 11. 最终架构决策

| 决策点                    | 我的建议                                           |
| ---------------------- | ---------------------------------------------- |
| 项目核心                   | Test Adequacy / Verification Core              |
| 首个 Agent Runtime       | Copilot CLI                                    |
| 后续 Runtime             | 可插拔 Claude / Codex                             |
| 核心开发语言                 | TypeScript                                     |
| Skills                 | 中央维护，可在不同执行环境中分发                               |
| MCP                    | Read-only Adapter，不作为执行引擎                      |
| 第一版跨仓库方案               | Reusable GitHub Workflow                       |
| Local Shift Left       | CLI 优先，IDE 集成随后                                |
| 主动仓库扫描                 | 增量分析 + Baseline                                |
| 长期发布形态                 | GitHub App                                     |
| 和原生 Copilot Review 的关系 | 互补而非替代                                         |
| AI 计费策略                | CI 优先 `GITHUB_TOKEN`，本地使用用户已授权的 Runtime；明确成本归属 |
| 安全与发布                  | 默认只读分析，独立验证后发布，非阻塞                             |

最值得先实现的完整闭环是：

一个 `review-core`，一个 `copilot-runtime`，一个本地 CLI，一个跨仓库 Reusable Workflow，以及一套可靠的 Evaluation Fixtures。

当这五个部分工作稳定之后，再扩展到主动全仓扫描、MCP 和 GitHub App。这样你现在开发的 GitHub Action 不需要推倒重来，而且可以逐步演进为真正的跨仓库 Shift-Left 平台。

### 关键官方参考

- [Copilot CLI in GitHub Actions：认证与计费](https://docs.github.com/en/copilot/concepts/agents/copilot-cli/copilot-cli-in-github-actions)
- [GitHub Reusable Workflows：跨仓库复用规则](https://docs.github.com/en/actions/reference/workflows-and-actions/reusing-workflow-configurations)
- [Agent Skills：Skills 路径与复用方式](https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/customize-cloud-agent/add-skills)
- [GitHub Agentic Workflows：安全执行及 Safe Outputs 参考实现](https://github.com/github/gh-aw)

这个功能应该直接加入我们的统一架构，而且我建议把它作为 Manual Cross-Repository Analysis（手动跨仓库分析），在 GitHub App 开发之前就实现。

最重要的是：用户只需要输入 Repository URL，其他三个 URL 都可以留空。Agent 会自己进入目标仓库寻找设计文档、代码规范、Agent Skills 和测试目录。

## 1. 最终的 GitHub Actions 操作界面

用户打开你的中央项目：

`shift-left-review → Actions → Manual Repository Analysis → Run workflow`

GitHub 会根据 `workflow_dispatch.inputs` 自动显示输入字段，不需要额外开发前端。

[image](https://www.google.com/s2/favicons?domain=https://docs.github.com\&sz=32)

GitHub Docs



Manual Repository Analysis

界面示意

Repository URL \*

Required · The repository to analyse

Design Document URL

Rules / Instructions Document URL

Test Folder URL

Automatic discovery

空白字段将从目标仓库自动寻找。这里是交互示意，实际提交在 GitHub Actions 页面完成。

&#x20;Copy equivalent GitHub CLI command

## 2. 四个输入的处理规则

| Input             | 是否必填 | 没有提供时                                    |
| ----------------- | ---- | ---------------------------------------- |
| `repo_url`        | 必填   | 拒绝运行                                     |
| `design_doc_url`  | 可选   | 搜索 README、docs、ADR、需求文档                  |
| `rules_doc_url`   | 可选   | 发现 AGENTS.md、Copilot instructions、Skills |
| `test_folder_url` | 可选   | 检测测试框架与测试目录                              |

明确输入的 URL 应当是高优先级上下文，但不是唯一上下文。

例如用户指定了 `docs/architecture.md`，Agent 仍然需要读取代码、现有测试和其他相关文档；不能只分析用户给定的一个文件。

## 3. 完整执行流程

Manual Trigger

读取四个输入字段

URL Validation

解析目标 owner/repo，验证 URL

Repository Access

检查权限并 Checkout 目标仓库

Context Discovery

补齐缺失的设计、规则、测试上下文

Review Core

需求 → 行为 → 测试义务 → 断言 → 验证

Evidence Verification

验证发现的问题，过滤误报

Report Generation

生成 GitHub Summary、Markdown 与 JSON

### 自动发现不应该只是让 LLM 猜文件名

我建议 `Context Resolver` 先进行确定性搜索，再由 Agent 判断相关性。

例如：

```
Target Repository
│
├── Design / Requirements
│   ├── README.md
│   ├── docs/design/
│   ├── docs/architecture/
│   ├── docs/adr/
│   └── docs/requirements/
│
├── Rules / Agent Context
│   ├── AGENTS.md
│   ├── .github/copilot-instructions.md
│   ├── .github/instructions/
│   ├── .github/skills/
│   ├── .agents/skills/
│   └── CLAUDE.md
│
└── Tests
    ├── tests/
    ├── test/
    ├── __tests__/
    ├── **/*.test.ts
    ├── **/*.spec.ts
    ├── pytest.ini
    ├── jest.config.*
    └── playwright.config.*
```

还要做两点：第一，识别具体的 Unit、Component、Integration、E2E 测试，不把所有测试混为一谈；第二，如果找不到设计文档，就明确标记相关结论是从代码推导出来的，不能伪装成已确认的业务需求。

## 4. GitHub Actions Workflow 具体实现

在中央仓库增加：

`.github/workflows/manual-repository-analysis.yml`

下面是接入模板。它会创建四个输入框、验证目标仓库 URL、Checkout 目标仓库，然后调用我们将要实现的 `review:manual` 命令。

```

name: Manual Repository Analysis

on:
  workflow_dispatch:
    inputs:
      repo_url:
        description: "Target GitHub repository URL (required)"
        required: true
        type: string

      design_doc_url:
        description: "Design document URL (optional)"
        required: false
        type: string
        default: ""

      rules_doc_url:
        description: "Rules / instructions URL (optional)"
        required: false
        type: string
        default: ""

      test_folder_url:
        description: "Test folder URL (optional)"
        required: false
        type: string
        default: ""

permissions:
  contents: read
  copilot-requests: write

jobs:
  analyze:
    runs-on: ubuntu-latest
    timeout-minutes: 45

    steps:
      - name: Checkout Review Engine
        uses: actions/checkout@v4
        with:
          path: engine
          persist-credentials: false

      - name: Validate Repository URL
        id: target
        env:
          REPO_URL: ${{ inputs.repo_url }}
        run: |
          python3 - <<'PY'
          import os, re
          from urllib.parse import urlparse

          url = urlparse(os.environ["REPO_URL"].strip())

          if (url.scheme != "https"
              or url.netloc != "github.com"
              or url.query or url.fragment):
              raise ValueError("Expected a GitHub HTTPS repository URL")

          path = url.path.rstrip("/").removesuffix(".git")
          parts = path.strip("/").split("/")

          if len(parts) != 2 or not all(
              re.fullmatch(r"[A-Za-z0-9_.-]+", p) for p in parts
          ):
              raise ValueError("Expected https://github.com/owner/repo")

          with open(os.environ["GITHUB_OUTPUT"], "a") as output:
              output.write(f"repository={parts[0]}/{parts[1]}\n")
          PY

      - name: Checkout Target Repository
        uses: actions/checkout@v4
        with:
          repository: ${{ steps.target.outputs.repository }}
          token: ${{ secrets.CROSS_REPO_READ_TOKEN || github.token }}
          path: target
          persist-credentials: false

      - name: Setup Node
        uses: actions/setup-node@v4
        with:
          node-version: "22"

      - name: Build Review Engine
        working-directory: engine
        run: |
          npm ci
          npm run build

      - name: Install Copilot CLI
        run: npm install -g @github/copilot

      - name: Analyze Repository
        working-directory: engine
        env:
          GITHUB_TOKEN: ${{ github.token }}
          TARGET_REPO_DIR: ${{ github.workspace }}/target
          DESIGN_DOC_URL: ${{ inputs.design_doc_url }}
          RULES_DOC_URL: ${{ inputs.rules_doc_url }}
          TEST_FOLDER_URL: ${{ inputs.test_folder_url }}
          OUTPUT_DIR: ${{ github.workspace }}/results
        run: npm run review:manual

      - name: Publish Summary
        if: always()
        run: |
          if [ -f results/summary.md ]; then
            cat results/summary.md >> "$GITHUB_STEP_SUMMARY"
          fi

      - name: Upload Analysis Report
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: repository-analysis
          path: results/
          if-no-files-found: warn

```

这里 `npm run review:manual` 是我们需要在 Core 中实现的 CLI 入口，不是 npm 自带命令。Workflow 本身负责触发、权限、Checkout 和结果发布；自动发现和分析逻辑都由 Core 实现。

GitHub 官方已确认 Copilot CLI 可以使用 `GITHUB_TOKEN` 在 Actions 中运行，但需要 `copilot-requests: write` 权限以及适用的组织策略。

[image](https://www.google.com/s2/favicons?domain=https://docs.github.com\&sz=32)

GitHub Docs



## 5. 跨仓库扫描最重要的权限问题

这点必须在设计时处理好，因为你希望任何授权的仓库都能够被分析。

| 目标仓库类型             | 能否扫描 | 所需条件                   |
| ------------------ | ---- | ---------------------- |
| Public Repo        | 可以   | 公开读取                   |
| 当前 Action 所在仓库     | 可以   | `GITHUB_TOKEN`         |
| 同组织其他 Private Repo | 可以   | 额外的跨仓库授权               |
| 其他组织的 Private Repo | 可以   | 对方授权的 PAT 或 GitHub App |
| 没有权限的 Private Repo | 不可以  | 必须先授权                  |

GitHub 的 `GITHUB_TOKEN` 默认只授权当前 Workflow 所属的仓库，不能因为用户填了另一个私有仓库 URL 就自动读取。

[image](https://www.google.com/s2/favicons?domain=https://github.com\&sz=32)

GitHub

+1



因此建议：

- MVP：支持 Public Repo，以及通过只读 Fine-grained PAT 授权的 Private Repo。
- 正式组织部署：使用 GitHub App Installation Token，按目标仓库授权。
- Copilot 计费：独立使用执行 Workflow 的组织凭据，和目标仓库的代码读取权限分开管理。

GitHub App 令牌可以使用官方的 [actions/create-github-app-token](https://github.com/actions/create-github-app-token) 获取。

[image](https://www.google.com/s2/favicons?domain=https://github.com\&sz=32)

GitHub



另外，中央仓库的 Run workflow 按钮通常要求用户有该仓库的 Write 权限。如果你最终希望其他组织的普通开发者也能自行提交扫描任务，就需要 GitHub App 或独立 Web UI 作为入口。

[image](https://www.google.com/s2/favicons?domain=https://docs.github.com\&sz=32)

GitHub Docs



## 6. URL Resolver 应该如何设计？

我建议新增加一个共享模块：

`packages/core/context-resolver/`

其中分别处理四类输入。

RepositoryResolver

将 `https://github.com/org/repo` 解析成 owner/repo，获得默认分支、Commit SHA，并确认读取权限。

DesignResolver

如果填写了 GitHub 文件 URL，解析对应版本；如果填写了 Confluence、Google Docs 等地址，则使用相应授权的内容读取方式。未填写时自动进行仓库发现。

RulesResolver

合并显式规则、仓库 Instructions、适用的 Agent Skills 和中央 Review Policy，同时记录每条规则的来源及优先级。

TestResolver

支持 GitHub `tree/.../tests` URL 或仓库相对路径。未指定时检测测试框架、配置文件和测试目录。

有几个工程细节很重要：

1. GitHub 的 `blob` 和 `tree` URL 可能包含带斜杠的分支名，需要结合 GitHub API 解析，不能简单按照 `/` 截断。
2. 外部文档 URL 必须做域名白名单、重定向及内网地址限制，不能让 Agent 任意访问 URL。
3. 扫描外部仓库时默认只读，不执行仓库提供的任意脚本、安装脚本或者测试命令。需要执行测试时，应使用额外的受限 Sandbox。
4. 显式规则不能覆盖中央平台的安全限制；仓库代码和文档应视为待分析数据，而不是高权限系统指令。

## 7. 执行完成后用户看到什么？

GitHub Actions 的 Summary 页面应该直接展示结果，而不是让用户翻几千行日志。

示例报告 · 非真实扫描结果

## Repository Analysis Report

example-org/payment-service · main

# 24

Modules

# 186

Tests

# 5

Verified Gaps

Discovered Context

Design Documentation

&#x20;Auto-discovered

Review Instructions

&#x20;Auto-discovered

Test Locations

&#x20;Auto-discovered

Example Findings

Missing expired-policy test

refund.ts · Unit test obligation · High confidence

Unverified payment retry behaviour

payment-service.ts · Boundary scenario · Medium confidence

Full report: summary.md · findings.json · context-manifest.json

尤其建议保留 `context-manifest.json`，记录：

- 系统找到了哪些文档。
- 哪些是用户显式提供、哪些是自动发现。
- 有哪些关键上下文没有找到。
- 每个 Finding 依据的是哪个版本的文件。

这样其他开发者可以复核你的 Agent 是否真的理解了目标仓库。

## 8. 更新我们的实施顺序

| 顺序 | 功能                                | 优先级  |
| -- | --------------------------------- | ---- |
| P0 | Review Core + Evaluation Baseline | 必需   |
| P1 | Repository Context Auto-discovery | 必需   |
| P2 | Manual Run workflow + 四个 URL 输入   | 优先完成 |
| P3 | Local CLI Shift Left              | 高    |
| P4 | 跨仓库自动 PR Review                   | 高    |
| P5 | 定时扫描 + 增量分析                       | 中    |
| P6 | MCP Server + GitHub App           | 后续   |

我建议把 Manual Repository Analysis 作为第一个端到端 MVP。

原因是它同时验证了跨仓库权限、自动上下文发现、中央 Skills、Agent Runtime 和完整测试分析能力。一旦它运行稳定，自动 PR Review 和定时扫描只需要替换触发器与扫描范围，Core 不用重新开发。

还有一个需要明确的产品行为：只输入 Repo URL 时，扫描该仓库默认分支的当前快照；不会自动选择某个 PR。 后续可以增加可选的 `target_ref` 或 `pr_url`，但第一版先保留你指定的四个输入框，避免操作界面变复杂。

这样项目就能实现你真正想要的体验：一个统一的 Review Engine，可以从 GitHub Actions 手动指定任意授权仓库进行分析，也可以在本地、PR 和定时任务中自动运行。