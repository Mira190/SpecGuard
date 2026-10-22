Shift Left should be more than an ordinary PR Review
The Unit Test Review Workflow you researched earlier can actually be extended into the following analysis chain:
1

Repository Understanding
Identify the project structure, test framework, existing standards, and related Skills



2

Requirement Analysis
Link Issues, requirement descriptions, and Acceptance Criteria



3

Change Impact Analysis
Identify the call paths and logic branches affected by the modified code



4

Test Gap Analysis
Check for missing unit tests, boundary scenarios, and exception paths



5

Evidence Verification
Verify conclusions using AST, test results, and static analysis



6

Actionable Feedback
Output precisely located, well-evidenced, actionable suggestions



What matters more for Shift Left is: make these capabilities reusable at multiple stages (on the developer's machine, PR Draft, CI, and before merge), rather than running them only once in the final Code Review

# Cross-Repository Shift-Left Review Agent: Unified Architecture and Implementation Plan

I suggest positioning your project as:

A repository-independent, requirement-aware test verification agent that operates across local development, pull requests, and repository-wide analysis.

In plain terms: a Shift-Left Agent that is independent of the repository, supports multiple Agent Runtimes, and specializes in checking test adequacy.

This is not building yet another GitHub Copilot Code Review, but solving problems that Copilot Review does not necessarily solve systematically:

> Which behaviours does the code implement? Which behaviours do the requirements require to be verified? What do the existing tests actually prove? Which key behaviours have not been verified by tests at an appropriate level?

We continue to use the core analysis chain you settled on earlier:

`Requirement → Changed Behaviour → Test Obligation → Existing Assertion → Test Layer → Evidence → Gap`

The project supports the following at the same time:

- Local Shift Left: developers analyze test gaps locally before writing or committing code.
- PR Review: automatic review when a PR is created or updated in other repositories.
- Repository Scan: proactively analyze the test adequacy of the whole codebase, even without a PR.

## 1. First settle the technical approach

Recommended architecture

## One Core, Three Entry Points

The three entry points decide only the analysis scope, execution environment, and how results are published; three different sets of review logic will not be maintained.

## 2. A GitHub update that matters a lot for your project

GitHub now officially supports running Copilot CLI in GitHub Actions with `GITHUB_TOKEN`, with no need to supply your own Copilot PAT or third-party model API Key.

The official documentation explicitly requires:

```
permissions:
  contents: read
  copilot-requests: write
```

Then Copilot CLI can authenticate through the `GITHUB_TOKEN` provided by Actions.

But billing attribution must be distinguished:

| Scenario                      | AI usage attributed to                  |
| ----------------------- | ------------------------ |
| Personal repository + `GITHUB_TOKEN`   | The repository owner's Copilot seat      |
| Organization repository + `GITHUB_TOKEN`   | Organization billing, requires enabling the relevant policy             |
| User-provided Copilot PAT       | The Copilot seat of the user who owns that PAT |
| User explicitly requests native Copilot Review | Per native Code Review rules       |

The most important conclusion: you now have a GitHub Action approach that needs no self-supplied long-lived API Token, but it does not automatically bill the cost to the PR author. Organization repositories also need to enable Allow use of Copilot CLI billed to the organization, and set a budget for usage.

[image](https://www.google.com/s2/favicons?domain=https://docs.github.com\&sz=32)

GitHub Docs

+1



Therefore, I suggest:

For the first version, keep Copilot CLI Runtime + GitHub Actions, and prioritize making the Review Engine a cross-repository callable tool; do not restructure into a pure MCP Server or GitHub App from the start.

## 3. Review Core: the core analysis engine

This is the part of the whole project most worth investing in.

I suggest not making `SKILL.md` or a Prompt the core, but rather a deterministic Pipeline + Agent reasoning modules that can execute in different Runtimes.

01

Scope Resolver

Deterministic

Determine the PR Diff, Staged Changes, or Repository Scan scope

02

Context Resolver

Deterministic

Collect Requirements, Instructions, Skills, test framework, and existing tests

03

Behaviour & Obligation Mapper

Agent Reasoning

Identify changed behaviours and derive the test obligations that need verification

04

Assertion & Test Layer Mapper

Agent Reasoning

Map existing test assertions to behaviours, and identify the Unit / Component / Integration level

05

Gap Generator

Agent Reasoning

Propose behaviours not yet adequately verified, with counterexamples

06

Independent Verifier

Agent + Tools

Look for counter-evidence, check whether existing tests already cover it, and confirm the code location

07

Finding Publisher

Deterministic

Dedupe, rank, limit the number of comments, and produce structured output

### Why an independent Verifier?

Suppose the requirement is:

> When a customer chooses to cancel insurance, the refund should be calculated correctly; if the policy has expired, no refund is allowed.

The code modified the refund calculation logic.

The Agent finds an existing test:

```
it("refunds cancelled policy", () => {
  expect(calculateRefund(activePolicy)).toBe(100);
});
```

It may propose a missing test:

```
it("does not refund expired policy", () => {
  expect(calculateRefund(expiredPolicy)).toBe(0);
});
```

But the Verifier cannot immediately conclude it is missing. It should keep checking:

- Whether other unit tests verify the expired case.
- Whether Component / Integration Tests already verify this behaviour effectively.
- Whether the requirement really specifies that the refund must be zero.
- Whether it is a risk introduced by this code change.
- Whether the new suggestion merely repeats an existing assertion.

A Finding is published only when no sufficient counter-evidence is found and there is reliable requirement, code, and test evidence.

I would have the Verifier use an independent context, to avoid the second Agent merely repeating the same judgment after the first Agent has already concluded there is a problem.

This is your core value that distinguishes you from an ordinary Copilot Review.

## 4. How to divide the work among Skills, MCP, and Agent Runtime?

These three cannot be mixed together.

| Component             | Main responsibility               | Core or not |
| -------------- | ------------------ | ---- |
| Review Engine  | Control analysis order, data flow, and verification mechanisms    | Yes    |
| Agent Skills   | Tell the model how to understand test obligations and analysis methods  | Yes    |
| MCP Server     | Expose analysis capability and external context to the outside     | Optional interface |
| Copilot CLI    | Execute Agent tasks that need reasoning   | Replaceable   |
| GitHub Actions | CI execution and automatic triggering         | Integration method |
| GitHub App     | Cross-repository authorization, Webhooks, result publishing | Later integration |

### How do central Skills get reused in other repositories?

Suppose your project maintains:

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

You do not need to require other repositories to copy these files.

The official GitHub documentation confirms that Copilot CLI supports project-level Skills, as well as personal Skills in `~/.copilot/skills` or `~/.agents/skills`. It also supports specifying a separate Copilot configuration directory via `COPILOT_HOME`.

[image](https://www.google.com/s2/favicons?domain=https://docs.github.com\&sz=32)

GitHub Docs

+1



Therefore in CI you can:

1. Checkout the target repository as the analysis working directory.
2. Download the specified version of the central Review Engine.
3. Install the central Skills under an isolated `COPILOT_HOME`.
4. At the same time discover the Instructions, Skills, and test standards already in the target repository.
5. Hand both kinds of context to the Core for unified parsing.

This way, changing the central Skill upgrades the review capability of other repositories without modifying the target repository each time.

But two mechanisms must be distinguished:

Copilot CLI custom run: you control Skill installation, invocation timing, and the analysis flow.

Native Copilot Code Review: GitHub decides on its own whether to load the relevant Skills and MCP Tools. It can consume your analysis results, but cannot be guaranteed to strictly execute your seven-stage Pipeline.

[image](https://www.google.com/s2/favicons?domain=https://docs.github.com\&sz=32)

GitHub Docs



### Where is MCP best placed?

I would make MCP a read-only capability interface of the Core, rather than treating MCP as the whole architecture.

For example:

```
shift-left-mcp
├── get_repo_context
├── get_test_obligations
├── get_assertion_evidence
├── get_test_layer_assessment
└── get_verified_test_gaps
```

When called:

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

These tools can return precomputed results; when a full scan needs to run, your Core handles it in a suitable controlled environment.

In the future you could even let GitHub's native Copilot Review query via MCP:

> Which independently verified Test Adequacy Gaps does the current PR have?

This way native Copilot Review can also become a consumer of your project, rather than something you must replace.

Note that GitHub's native Review currently requires an MCP Tool to be marked `annotations.readOnlyHint: true` in order to be used.

[image](https://www.google.com/s2/favicons?domain=https://docs.github.com\&sz=32)

GitHub Docs



## 5. Concrete implementation of the three entry points

A. Local Shift Left

Developers start the analysis from the VS Code terminal, a Git Hook, or an ordinary CLI. Supports staged changes, working tree changes, and a specified Git diff.

B. PR Review

Run on PRs in other repositories through a central Reusable Workflow. Publish high-signal comments after complete analysis, without modifying code directly.

C. Repository Scan

Triggered with `workflow_dispatch`, `schedule`, or a later GitHub App, build a test adequacy baseline for the whole codebase and perform incremental scans.

### A. Local Shift Left

A unified CLI is planned (the following are suggested command designs, not already-released software):

```
# Check Git staged changes
shift-left review --staged

# Check all current local modifications
shift-left review --working-tree

# Analyze relative to the main branch
shift-left review --base origin/main

# Scan the current repository
shift-left scan --scope repo
```

Locally, two run tiers can be supported:

| Mode   | Behaviour                               | Scenario         |
| ---- | -------------------------------- | ---------- |
| Fast | Static collection + test mapping + low-cost checks              | Pre-commit |
| Deep | Agent reasoning + Evidence Verification | Before submitting a PR    |

It is not recommended to run the full LLM Pipeline on every Git Commit. It could seriously hurt the development experience.

The first version of the CLI can be written in TypeScript, and later wrapped as a GitHub CLI extension or VS Code Extension. GitHub officially supports developing custom `gh` extensions.

[image](https://www.google.com/s2/favicons?domain=https://docs.github.com\&sz=32)

GitHub Docs



### B. Cross-Repository PR Review

Suppose the core project is:

`your-org/shift-left-review`

Other repositories only need one calling entry:

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

This is an initial example for same-repository branch PRs. For formal use it is recommended to pin to a reviewed Commit SHA, and the central Workflow must declare `workflow_call`.

GitHub's behaviour here suits your needs very well:

- A reusable Workflow can be stored in another repository.
- At execution time it uses the GitHub context of the calling repository.
- Rules and execution logic can be maintained centrally.
- Cross-repository reuse of private repositories is limited by the GitHub Actions Access Policy.

[image](https://www.google.com/s2/favicons?domain=https://docs.github.com\&sz=32)

GitHub Docs

+1



But fork PRs need a separately designed secure path. GitHub restricts Token permissions for fork PRs, so you cannot assume the example above handles all external contributors.

[image](https://www.google.com/s2/favicons?domain=https://docs.github.com\&sz=32)

GitHub Docs



Internal analysis also needs permission isolation:

```
Job 1: Evidence Collection
        ↓
Job 2: Agent Analysis (read-only)
        ↓
Job 3: Finding Validation
        ↓
Job 4: PR Publisher (write permission)
```

In particular, untrusted PR code must not be executed directly in an environment holding a write Token. GitHub gives explicit warnings about the risk of `pull_request_target` loading untrusted code.

[image](https://www.google.com/s2/favicons?domain=https://docs.github.com\&sz=32)

GitHub Docs



### C. Repository-wide Scan

This mode is harder than PR Review, because there may be no explicit requirement description at all.

So two kinds of results must be distinguished:

With an explicit requirement source: test obligations can be derived from Issues, requirement files, Acceptance Criteria, and related implementations.

Code only, no requirements: candidate test obligations can only be inferred from existing behaviour, interface contracts, and tests; model guesses cannot be treated as real business requirements.

Repository Scan can use:

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

This way the whole repository is not sent to the LLM for analysis every time.

It is recommended to build an incremental cache by `package/module`, using Git SHA, configuration version, analysis rule version, and related dependency changes to decide which modules need re-scanning.

## 6. All entry points must share one Finding Schema

This is very important.

Whether the analysis comes from local, PR, or repository scan, the same data structure must be produced.

For example:

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

This structure is a suggested internal Contract, not a format provided by GitHub.

With it you can use different Publishers for output:

| Entry              | Output                              |
| --------------- | ------------------------------- |
| Local CLI       | Terminal / JSON                 |
| GitHub Action   | PR Comments + Workflow Summary  |
| GitHub App      | PR Comments + Check Runs        |
| Repository Scan | JSON Baseline + Markdown Report |
| MCP             | Structured Tool Response               |

For the first version it is best to publish at most 3–5 high-confidence comments per PR, giving priority to filtering out duplicate, speculative, and unverifiable gaps.

It is not recommended to add ordinary security vulnerabilities, formatting issues, and performance issues to the output at the start. Those fall in the scope of existing Code Review and static analysis tools; what you should really do is Test Adequacy Verification.

## 7. Suggested Monorepo project structure

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

I recommend starting with a TypeScript Monorepo + Zod Schema + Copilot CLI Runtime. For your existing GitHub / TypeScript / Agentic Workflow tech stack, the learning and migration cost is relatively low.

But note: cross-repository Instructions are not all trustworthy execution instructions. The Core should distinguish organization policy, the reviewed standards of the target repository, and unreviewed content newly added in the PR. External rules and code should first be treated as analysis data, rather than directly being given arbitrary command execution permissions.

## 8. Phased implementation roadmap

P0

Establish the Evaluation Baseline

First priority

Prepare cases with real Test Gaps, already-adequate tests, and no explicit requirements; define stable evaluation criteria.

Acceptance: able to judge whether the new architecture is better than the original Prompt Review.

P1

Extract Shared Review Core

Core development

Extract the seven-stage Pipeline, the unified Finding Schema, and the Copilot CLI Runtime Adapter from the existing GitHub Action.

Acceptance: analysis can run on a local directory without depending on GitHub Actions.

P2

Local CLI + PR Workflow

First usable version

Implement staged/diff analysis, a cross-repository Reusable Workflow, and publishing comments after verification.

Acceptance: for the same set of test cases, local and CI get the same evidence and comparable Findings.

P3

Repository Scanner

Expand coverage

Implement repository baseline, per-module analysis, incremental cache, and isolation of low-confidence results.

Acceptance: scan a repository with no PRs, and continuously track changes in test gaps.

P4

MCP + Native Copilot Integration

Ecosystem integration

Provide verified Findings to Copilot, other Agents, or IDEs through a read-only MCP.

Acceptance: third-party Agents can consume the Core's analysis results without re-implementing the full Pipeline.

P5

GitHub App Distribution

Productization

Add App installation authorization, Webhooks, a task queue, organization-level policies, and budget management.

Acceptance: target repositories can be brought under unified management without adding a Workflow to each one.

Neither P4 nor P5 is a prerequisite for launching the first version.

## 9. Should the GitHub App be the final approach?

I think yes, but it should be the Distribution Layer, not the Review Engine itself.

The reason is that you raised a higher-level requirement:

> Other repositories should not even need to know about your GitHub Action; once authorized they can be brought uniformly into scanning and Review.

This requirement cannot be fully met by a plain Reusable Workflow.

A GitHub App lets repository administrators choose which repositories to grant access to, and respond to PR activity through Webhooks; publishing Check Runs can also use the GitHub App's `checks:write` permission.

[image](https://www.google.com/s2/favicons?domain=https://docs.github.com\&sz=32)

GitHub Docs

+1



But there is a trade-off here that must be considered in advance:

|                                         | Reusable Workflow | GitHub App + central service |
| --------------------------------------- | ----------------- | ----------------- |
| Needs YAML in the target repository                             | Yes                 | No                 |
| Automatic PR Review                            | Yes                 | Yes                 |
| Proactive scan without a PR                               | Yes                 | Yes                 |
| Use Actions `GITHUB_TOKEN` to call Copilot CLI | Feasible, depending on policy and permissions       | The central service cannot inherit it directly        |
| Need to maintain your own service                              | No                 | Yes                 |
| Cross-organization rollout                                   | Each repository must be configured            | Installation authorization is more natural           |

Therefore, if in the future you want zero-YAML onboarding with a GitHub App while still using the target organization's Copilot Actions usage, you will also need to design the execution and billing path specifically; installing the GitHub App itself does not mean obtaining the target organization's Copilot CLI billing identity.

## 10. How to verify that this architecture really achieves Shift Left?

I would not use "how many comments the Agent output" as the core KPI.

The following metrics are suggested:

| KPI                        | Target                          |
| -------------------------- | --------------------------- |
| Verified Finding Precision | Pilot target ≥90%                   |
| False Positive Rate        | Reduce as much as possible, track closely                  |
| Duplicate Finding Rate     | Do not remind about the same unresolved problem repeatedly                |
| Requirement Traceability   | Every formal Finding has a requirement or an explicitly marked derivation basis |
| Cross-Entry Consistency    | Local / PR / Scan use the same analysis contract  |
| Cost per Verified Finding  | Can be tracked and gradually reduced                  |
| Time to Detection          | Prove that problems can be found before PR Review      |

The most important of these is Time to Detection.

If the developer gets a reliable Missing Unit Test hint right when finishing writing a function, rather than seeing it only after the PR is created, that is the real benefit of Shift Left.

## 11. Final architecture decisions

| Decision point                    | My recommendation                                           |
| ---------------------- | ---------------------------------------------- |
| Project core                   | Test Adequacy / Verification Core              |
| First Agent Runtime       | Copilot CLI                                    |
| Later Runtimes             | Pluggable Claude / Codex                             |
| Core development language                 | TypeScript                                     |
| Skills                 | Maintained centrally, distributable across execution environments                               |
| MCP                    | Read-only Adapter, not an execution engine                      |
| First-version cross-repository approach               | Reusable GitHub Workflow                       |
| Local Shift Left       | CLI first, IDE integration afterwards                                |
| Proactive repository scan                 | Incremental analysis + Baseline                                |
| Long-term release form                 | GitHub App                                     |
| Relationship with native Copilot Review | Complementary rather than a replacement                                         |
| AI billing strategy                | In CI prefer `GITHUB_TOKEN`, locally use the Runtime the user has authorized; make cost attribution explicit |
| Security and publishing                  | Read-only analysis by default, publish after independent verification, non-blocking                             |

The most worthwhile complete loop to implement first is:

One `review-core`, one `copilot-runtime`, one local CLI, one cross-repository Reusable Workflow, and a reliable set of Evaluation Fixtures.

Once these five parts work stably, expand to proactive whole-repository scanning, MCP, and the GitHub App. This way the GitHub Action you are developing now does not need to be torn down and redone, and can evolve step by step into a true cross-repository Shift-Left platform.

### Key official references

- [Copilot CLI in GitHub Actions: authentication and billing](https://docs.github.com/en/copilot/concepts/agents/copilot-cli/copilot-cli-in-github-actions)
- [GitHub Reusable Workflows: cross-repository reuse rules](https://docs.github.com/en/actions/reference/workflows-and-actions/reusing-workflow-configurations)
- [Agent Skills: Skills paths and reuse](https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/customize-cloud-agent/add-skills)
- [GitHub Agentic Workflows: secure execution and Safe Outputs reference implementation](https://github.com/github/gh-aw)

This feature should be added directly to our unified architecture, and I suggest implementing it as Manual Cross-Repository Analysis, before the GitHub App is developed.

Most importantly: the user only needs to enter the Repository URL, and the other three URLs can all be left blank. The Agent will itself enter the target repository to look for design documents, code standards, Agent Skills, and test directories.

## 1. The final GitHub Actions operating interface

The user opens your central project:

`shift-left-review → Actions → Manual Repository Analysis → Run workflow`

GitHub automatically displays the input fields based on `workflow_dispatch.inputs`, with no extra frontend development needed.

[image](https://www.google.com/s2/favicons?domain=https://docs.github.com\&sz=32)

GitHub Docs



Manual Repository Analysis

Interface mock-up

Repository URL \*

Required · The repository to analyse

Design Document URL

Rules / Instructions Document URL

Test Folder URL

Automatic discovery

Blank fields will be looked up automatically from the target repository. This is an interaction mock-up; actual submission is done on the GitHub Actions page.

&#x20;Copy equivalent GitHub CLI command

## 2. Handling rules for the four inputs

| Input             | Required | When not provided                                    |
| ----------------- | ---- | ---------------------------------------- |
| `repo_url`        | Required   | Refuse to run                                     |
| `design_doc_url`  | Optional   | Search README, docs, ADR, requirement documents                  |
| `rules_doc_url`   | Optional   | Discover AGENTS.md, Copilot instructions, Skills |
| `test_folder_url` | Optional   | Detect the test framework and test directories                              |

An explicitly provided URL should be high-priority context, but not the only context.

For example, if the user specifies `docs/architecture.md`, the Agent still needs to read the code, existing tests, and other related documents; it cannot analyze only the one file the user gave.

## 3. Complete execution flow

Manual Trigger

Read the four input fields

URL Validation

Parse the target owner/repo, validate the URL

Repository Access

Check permissions and Checkout the target repository

Context Discovery

Fill in missing design, rule, and test context

Review Core

Requirement → Behaviour → Test Obligation → Assertion → Verification

Evidence Verification

Verify the problems found and filter false positives

Report Generation

Generate GitHub Summary, Markdown, and JSON

### Automatic discovery should not just have the LLM guess file names

I suggest that the `Context Resolver` first do a deterministic search, and then let the Agent judge relevance.

For example:

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

Two more things must be done: first, identify the specific Unit, Component, Integration, and E2E tests, and do not lump all tests together; second, if no design document can be found, explicitly mark the related conclusions as derived from the code, and they must not be disguised as confirmed business requirements.

## 4. Concrete implementation of the GitHub Actions Workflow

Add to the central repository:

`.github/workflows/manual-repository-analysis.yml`

Below is the integration template. It creates four input boxes, validates the target repository URL, Checks out the target repository, and then calls the `review:manual` command we are going to implement.

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

Here `npm run review:manual` is a CLI entry point we need to implement in the Core, not a command that comes with npm. The Workflow itself is responsible for triggering, permissions, Checkout, and result publishing; automatic discovery and analysis logic are all implemented by the Core.

GitHub has officially confirmed that Copilot CLI can run in Actions using `GITHUB_TOKEN`, but it requires the `copilot-requests: write` permission and the applicable organization policy.

[image](https://www.google.com/s2/favicons?domain=https://docs.github.com\&sz=32)

GitHub Docs



## 5. The most important permission issue for cross-repository scanning

This must be handled well in the design, because you want any authorized repository to be analyzable.

| Target repository type             | Scannable | Conditions required                   |
| ------------------ | ---- | ---------------------- |
| Public Repo        | Yes   | Public read                   |
| The repository where the current Action lives     | Yes   | `GITHUB_TOKEN`         |
| Other Private Repos in the same organization | Yes   | Additional cross-repository authorization               |
| Private Repos in other organizations | Yes   | A PAT or GitHub App authorized by the other party |
| Private Repos without permission | No  | Must be authorized first                  |

GitHub's `GITHUB_TOKEN` by default only authorizes the repository the Workflow belongs to, and cannot automatically read another private repository just because the user filled in its URL.

[image](https://www.google.com/s2/favicons?domain=https://github.com\&sz=32)

GitHub

+1



Therefore the recommendations are:

- MVP: support Public Repos, and Private Repos authorized through a read-only Fine-grained PAT.
- Formal organization deployment: use a GitHub App Installation Token, authorized per target repository.
- Copilot billing: use the organization credentials that execute the Workflow independently, managed separately from the code-read permission on the target repository.

A GitHub App token can be obtained with the official [actions/create-github-app-token](https://github.com/actions/create-github-app-token).

[image](https://www.google.com/s2/favicons?domain=https://github.com\&sz=32)

GitHub



In addition, the Run workflow button of the central repository usually requires the user to have Write permission on that repository. If you ultimately want ordinary developers in other organizations to be able to submit scan jobs themselves, you will need a GitHub App or a standalone Web UI as the entry point.

[image](https://www.google.com/s2/favicons?domain=https://docs.github.com\&sz=32)

GitHub Docs



## 6. How should the URL Resolver be designed?

I suggest adding a shared module:

`packages/core/context-resolver/`

which handles the four kinds of input separately.

RepositoryResolver

Resolve `https://github.com/org/repo` into owner/repo, obtain the default branch and Commit SHA, and confirm read permission.

DesignResolver

If a GitHub file URL is given, resolve the corresponding version; if an address such as Confluence or Google Docs is given, use a correspondingly authorized way to read the content. When not given, perform repository discovery automatically.

RulesResolver

Merge explicit rules, repository Instructions, applicable Agent Skills, and the central Review Policy, while recording the source and priority of each rule.

TestResolver

Supports GitHub `tree/.../tests` URLs or repository-relative paths. When unspecified, detect the test framework, configuration files, and test directories.

A few engineering details are important:

1. GitHub `blob` and `tree` URLs may contain branch names with slashes, which need to be resolved with the GitHub API, and cannot simply be cut on `/`.
2. External document URLs must have a domain allowlist, redirect, and internal-network-address restrictions; the Agent must not be allowed to access arbitrary URLs.
3. When scanning an external repository, be read-only by default, and do not execute arbitrary scripts, install scripts, or test commands provided by the repository. When tests need to be executed, an additional restricted Sandbox should be used.
4. Explicit rules cannot override the central platform's security restrictions; repository code and documents should be treated as data to be analyzed, not as high-privilege system instructions.

## 7. What does the user see after execution?

The GitHub Actions Summary page should display the result directly, rather than making the user scroll through thousands of log lines.

Example report · not a real scan result

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

It is especially recommended to keep `context-manifest.json`, recording:

- Which documents the system found.
- Which were explicitly provided by the user and which were auto-discovered.
- Which key context was not found.
- Which version of which file each Finding is based on.

This way other developers can verify whether your Agent really understood the target repository.

## 8. Update our implementation order

| Order | Feature                                | Priority  |
| -- | --------------------------------- | ---- |
| P0 | Review Core + Evaluation Baseline | Required   |
| P1 | Repository Context Auto-discovery | Required   |
| P2 | Manual Run workflow + four URL inputs   | Complete first |
| P3 | Local CLI Shift Left              | High    |
| P4 | Cross-repository automatic PR Review                   | High    |
| P5 | Scheduled scanning + incremental analysis                       | Medium    |
| P6 | MCP Server + GitHub App           | Later   |

I suggest making Manual Repository Analysis the first end-to-end MVP.

The reason is that it validates cross-repository permissions, automatic context discovery, central Skills, the Agent Runtime, and the complete test analysis capability all at once. Once it runs stably, automatic PR Review and scheduled scanning only need to replace the trigger and scan scope, and the Core does not need to be redeveloped.

There is also a product behaviour that needs to be made explicit: when only the Repo URL is entered, scan the current snapshot of that repository's default branch; no PR is chosen automatically. An optional `target_ref` or `pr_url` can be added later, but the first version keeps just the four input boxes you specified, to avoid making the operation interface complicated.
