# 第三方复杂仓库全仓 audit 评测与优化（2026-10-17）

基线：main `2fb6f91`（#258 之后）。所有数字来自本日真实运行或离线可复跑的种子评测，附运行 ID 或文件位置。推算值单独标注，没测的写明“未测”。

## 0. 结论

| 问题 | 结论 | 证据 |
|---|---|---|
| 全仓 audit 能否在多语言大仓库上跑完 | **能**：5 个仓库全绿，$0.03–$0.20/次，27–48 秒模型时间 | §2 |
| 模型发现是否有价值 | **没有**：计入的 8 条发现中有价值的是 0 条；其中 6 条对应的测试其实存在，只是不在匹配到的测试文件里 | §3 |
| 确定性静态信号的召回 | **在 delivered（可见前 20 行）口径下只有 11/40**；不设上限时 21/40；边界类 0/10 | §4 |
| 静态信号的精确率 | weak 线索抽样 23 条里有 18 条判错；unref 线索在 cobra（Go）上 6/10 为真缺口，在 flask 和 fastify 上主要是“经由别的入口已测” | §4.3 |
| 覆盖率的瓶颈 | **预算预检偏高约 25 倍**：每次都显示“$1 只够 4–5 次调用”，实际只花了 $0.03–$0.20 | §2.2 |

一句话：**全仓 audit 在第三方仓库上跑得动、成本低，但目前交付给用户的内容几乎都是噪音。** 模型发现的误报主要来自测试匹配的召回不足；静态信号则被 7 个可修的确定性 bug 压低了召回和精确率（二进制测试文件、`t.assert.ok`、`toBeInstanceOf`、布尔值、行号取错、目录规则、CommonJS 导出名）。这些 bug 都已定位到代码行，修复 PR 正在进行（§6）。

## 1. 方法

1. **真实运行**：在 `specguard-run.yml` 上手动跑 5 次，默认设置（haiku-5.5，$1，max_units 12），`scan_issue: none`（无状态，一次性）。

| 仓库 | 语言 / 测试框架 | 提交 | 运行 |
|---|---|---|---|
| nestjs/nest | TS monorepo / vitest | `c215fd9` | 39010882792 |
| fastify/fastify | JS / node:test (`t.assert.*`) | `37df44a` | 39010887745 |
| pallets/flask | Python / pytest | `d086db8` | 39010892833 |
| spf13/cobra | Go / testing | `adbc881` | 39010897273 |
| honojs/hono | TS / vitest | `08807ce` | 39010902493 |

2. **人工标注**：逐条打开 5 次运行中计入的 8 条模型发现，到对应提交的测试里找证据，并记录 `文件:行`。
3. **离线种子评测**：在每个仓库的本地克隆上各埋 8 个缺口，共 40 个：
   - 3 个“删除对某个导出函数的全部测试引用”
   - 3 个“把值断言改成只断言真值”
   - 2 个“删除边界值用例”

   然后在 HEAD 和种子提交上分别直接调用 `inventory()` + `staticLeads()`，对比新增线索。整个过程不执行仓库代码，不推送任何内容。脚本和数据在会话 scratchpad 的 `seed-eval/`（`scripts/scan.js`、`out/<repo>-truth.json`、`out/results.json`）。

## 2. 真实运行

### 2.1 漏斗与成本

| 仓库 | eligible units | 本次审查（完整 + 部分测试） | 调用次数 | 成本 | 计入发现 | 静态线索 |
|---|---|---|---|---|---|---|
| nest | 1015 | 40（30 + 10） | 5 | $0.034 | 1 | 53 |
| fastify | 35 | 16（10 + 6） | 6 | $0.195 | 4 | 13 |
| flask | 21 | 19（9 + 10） | 5 | $0.038 | 2 | 32 |
| cobra | 13 | 8（2 + 6） | 5 | $0.081 | 0（incomplete） | 29 |
| hono | 206 | 15（8 + 7） | 5 | $0.039 | 1 | 28 |

漏斗行全部能对账：eligible = inventoried；selected = 完整 + 强制 + 未达。

### 2.2 预算预检偏高约 25 倍（覆盖率的第一瓶颈）

每次运行都写着“max_budget_usd $1.00 allows 4–5 calls”，同时列出 7–18 个“unit parts not reached (budget)”。实际花费只有 $0.03–$0.20。原因在 `src/engines/claude-api.js`：

- `worstCase()`（第 32 行）按 `PRE_FLIGHT_BPT = 1.5` 字节/token 估算输入。实测带行号的代码是 1.7–2 字节/token。一个约 150 KB 的 pack 因此被估成大于 100k token，落入 haiku-5.5 的长上下文价位（输入和输出都贵 5 倍，第 16 行）。
- 输出按 `max_output_tokens` 32000 全额计入。实测每次调用约 1–2k 输出 token。

worst case 本身是正确的硬预算保证，不应该改成乐观估计。正确的修法是**运行时准入**：保持 worst-case 计划不变；每次调用完成后，如果“已花费 + 下一部分的 worst case ≤ 预算”，就从广度优先队列里追加部分；追加和跳过的部分都记入 #264 的 part ledger。按本次数据推算，同样 $1 下每次运行可达到 `MAX_UNIT_CALLS` 的 8 次上限，约多 60% 的 unit。**这是推算值，未实测。**

## 3. 模型发现的人工标注

| # | 仓库 | 发现 | 标注 | 证据 |
|---|---|---|---|---|
| 1 | flask | `json/provider.py:79` args 与 kwargs 同时传入时抛 TypeError，称“未测” | 误报：已有测试 | `tests/test_basic.py:1358` 断言 `"args or kwargs" in str(e.value)` |
| 2 | flask | `json/provider.py:115` dataclass 序列化，称“未测” | 误报：已有测试 | `tests/test_basic.py:1346` `test_json_dump_dataclass` |
| 3 | nest | `base-ws-exception-filter.ts:98` handleUnknownError，称“未测” | 误报：经由子类测试 | `packages/websockets/test/exceptions/ws-exceptions-handler.spec.ts:30,70,116` |
| 4 | fastify | `lib/request.js:136` trust-proxy host 回退到空串，称“未测” | 误报：已有测试 | `test/request-header-host.test.js:75,107,143` |
| 5 | fastify | `lib/error-handler.js:124` buildErrorHandler 原型链 | 误报：经由公开入口测试 | 27 个测试文件经 `setErrorHandler` 覆盖 |
| 6 | fastify | `lib/error-handler.js:134` statusCode/status 映射 | 误报：已有测试 | `test/reply-error.test.js:282`（`err.status = 418`） |
| 7 | fastify | `lib/error-serializer.js:44` 输出形状 | 误报：已有测试 | `test/build/error-serializer.test.js`（被 `build/` 忽略规则吞掉，见 §5 第 8 条） |
| 8 | hono | `perf-measures/.../process-results.ts:14` | 属实但没有价值：性能脚本，不是产品代码 | — |

有价值的为 **0/8**，与 2026-10-11 至 10-17 在 nest 和 TypeScript 上的标注结论一致。根因有两类：

- 6/8 是“测试存在于没有匹配到的文件里”。模型只能依据匹配集推断，然后断言“the only matched test file 没有覆盖”。
- 1/8 是选到了非产品代码。

结论不变：**模型路径在全仓 audit 中不应对外宣称质量。** 继续给模型加门控收益递减（详见 `docs/goal-assessment-2026-10-17.md` §3.2）。

## 4. 离线种子评测（40 个种子）

### 4.1 召回

括号里是落在可见前 20 行内的个数，即 delivered 口径。

| 仓库 | 删除引用 | 弱化断言 | 删除边界 | 合计（delivered） |
|---|---|---|---|---|
| fastify | 3/3 (3) | 0/3 | 0/2 | 3/8 (3) |
| hono | 0/3 | 3/3 (1) | 0/2 | 3/8 (1) |
| nest | 3/3 (3) | 2/3 (0) | 0/2 | 5/8 (3) |
| flask | 3/3 (2) | 1/3 (0) | 0/2 | 4/8 (2) |
| cobra | 3/3 (3) | 3/3 (0) | 0/2 | 6/8 (3) |
| **合计** | **12/15 (11)** | **9/15 (1)** | **0/10** | **21/40 (11)** |

种子之外的新增线索只有 1 条：cobra 的 `SetIn`，因为种子删掉了它唯一的测试，所以这条也属实。Kite 上测得的 6/8 没有在第三方仓库上复现。另一个会话在 Kite 上按 delivered 口径复测，得到 3/8（cap 把弱断言线索挤到“+N more”之后）；#263 正在把 cap 改成按类型轮转。

### 4.2 弱断言线索为什么进不了前 20

`staticLeads` 把所有 unref 线索排在所有 weak 线索之前（`src/audit-units.js:302`）。unref 线索一旦有 20 条或更多，weak 线索就一条也显示不出来：cobra 排第 29–31，flask 第 44，nest 第 131 和 136。此外 `write()` 每行只保留 3 条 weak 和 5 条 unref，并且只保留前 100 行（`src/audit-units.js:15`、`:271-272`）：nest 的 unref 从 121 条剩 31 条，weak 从 304 条剩 108 条。

### 4.3 精确率抽样（每个仓库 unref、weak 各至多 10 条，固定随机种子）

| 仓库 | unref 线索 | weak 线索 |
|---|---|---|
| fastify | 经由别的入口已测 5、不可单测 1（只有 6 条） | 无线索（`t.assert.ok` 识别不到） |
| hono | 经由别的入口已测 10（在修复二进制文件 bug 之后抽样；main 上是 0 条） | 判错 8、真缺口 1、不确定 1 |
| nest | 不可单测 3、判错 2、不确定 2、真缺口 2、经由别的入口已测 1 | 判错 8、真缺口 2 |
| flask | 经由别的入口已测 9、真缺口 1 | 判错 9、不确定 1 |
| cobra | **真缺口 6**、经由别的入口已测 4 | 判错 2 |

“未被任何测试引用的导出”在 Go 这类测试直接调用公开 API 的仓库里精确率高；在 Python 和 JS 这类经由框架入口测试的仓库里，它是“测试债务清单”，而不是缺口。界面措辞已经是“lead, not a confirmed gap”，这个定位是对的。

## 5. 根因（按对交付召回和精确率的影响排序）

| # | 根因 | 影响 | 代码位置 | 修复 |
|---|---|---|---|---|
| 1 | 测试目录里的二进制文件（`favicon.ico`）读不到，使全局 `unread > 0`，把所有 unit 的 unref 线索清空 | hono unref 0 条（修复后 77 条），删除引用类召回 0/3；flask `tests/static/config.toml` 同理被当作测试 | `src/audit-units.js:166`, `:209`, `:227` | 测试条目只取代码文件；unread 改为按 unit 判断（PR-B） |
| 2 | node:test 的 `t.assert.ok(x)` 识别不到：lookbehind `(?<![.\w$])assert` 排除了 `t.` 前缀 | fastify weak 0 条，弱化类召回 0/3 | `src/post.js:145` OK_ARG, `src/leads.js:159` | 允许 `t.` 前缀（PR-A） |
| 3 | 把 `toBeInstanceOf`/`toBeTypeOf` 当成弱断言，界面还写成“asserts only truthiness” | nest weak 抽样 7/10 判错，hono 2/10 | `src/leads.js:161-163` | 移除（PR-A） |
| 4 | 布尔值被当成弱断言（`handlerExecuted`、`headers.has()`、`assert rv.is_json`） | hono 和 flask weak 抽样里大部分判错 | `src/leads.js:146-152` truthyArg；expect 路径没走 BOOL_CALL | 对布尔形名字和谓词跳过（PR-A） |
| 5 | Go 的 `== nil` 守卫后面跟着 else 分支或钉值断言，仍被判为弱断言 | cobra weak 2/2 判错 | `src/leads.js:173` | 有 else 或后续钉值时跳过（PR-A） |
| 6 | cap 和排序把 weak 线索挤出可见区 | delivered 召回 21→11 | `src/audit-units.js:15`, `:271-272`, `:302` | #263 轮转（另一会话）；write() 持久化由 pack-zero-and-rows 处理 |
| 7 | 线索行号取的是第一次出现处而不是声明处；类型过滤也作用在那一行，导致 TS interface 成了“无测试引用” | nest `IHeaders`/`KafkaConfig` 判错；flask/cobra 行号错 | `src/audit-units.js:53` leadNames | 先定位声明行，再在声明行上做类型过滤（PR-B） |
| 8 | 目录规则两头都错：`docs?/` 吞掉了 cobra 的 Go 包 `doc/`；缺少 `integration/`、`e2e/`、根目录 `scripts/`、`perf-*`；纯类型文件（`*.interface.ts`）被当成 unit；`build/` 忽略规则吞掉了 `test/build/*.test.js` | nest 前 20 行里 12 行是 interface 文件，模型调用也花在了上面；hono 唯一的发现是性能脚本；fastify 发现 #7 是误报 | `src/audit-units.js:18` NOT_UNIT, `src/trace.js:43` | 前几项由 PR-B 修；`build/` 涉及 `src/trace.js`（另一会话的 isTestPath PR 正在改），在那边跟进 |
| 9 | CommonJS 的 `module.exports = fn` / `{ a, b }` 取不到名字，且 `pub` 非空时会丢掉顶层函数名 | fastify 34 个 unit 中 23 个、hono 52 个、nest 164 个 unit 永远产生不了 unref 线索 | `src/test-map.js:50` namesOf | 解析导出对象（PR-C） |
| 10 | 预算预检偏高约 25 倍 | 每次少审 7–18 个 unit 部分 | `src/engines/claude-api.js:29-38` | 运行时准入（§2.2，在 #264 之后做） |
| 11 | 边界值删除 0/10 | 单个快照中没有可用信号 | — | 不是 bug。#263 的 `boundary_unpinned`（命名常量比较且没有测试钉住）覆盖其中一部分；其余需要 git 历史 |
| 12 | Go 测试被大量计为“没有断言”（cobra 每个 unit 35 个） | 风险排序失真 | `src/audit-units.js:57` testSignals + `src/post.js:138` ASSERTION | 未修：cobra 测试通过 `checkStringContains(t, ...)` 之类的辅助函数断言。候选做法是“把 `t` 作为第一个参数的调用算作断言”，先做离线评估 |

## 6. 优化：已做 / 进行中 / 不做

| 项 | 状态 | 文件 |
|---|---|---|
| PR-A 弱断言分类器（根因 2–5） | 进行中（Sonnet 实现，带种子复测） | `src/leads.js`, `src/post.js` |
| PR-B unit 与线索修复（根因 1、7、8） | 进行中；在 #263 和 pack-zero-and-rows 合入后 rebase | `src/audit-units.js` |
| PR-C CommonJS 导出名（根因 9） | 进行中；不碰 hunkTokens | `src/test-map.js` |
| 线索 cap 轮转（根因 6） | #263（另一会话） | `src/audit-units.js`, `src/audit-post.js` |
| 运行时预算准入（根因 10） | 等 #264 和 pack-zero-and-rows 合入后开始；合入前在自建的 Kite `eval/*` 分支上跑真实种子扫描 | `src/engines/claude-api.js` |
| 模型 missing_test 门控（错误消息字面量与测试共享时降为低置信） | **不做**：8 条里只能挡住 1 条（#1），标注噪音下无法证明净收益 | — |
| Go 辅助函数断言（根因 12） | 待离线评估 | — |

每个 PR 合并前都要跑同一套 40 种子评测，并按 delivered 口径报告前后对比。凡是涉及扫描选择或预算的改动，还要在 Kite 种子分支上跑真实运行（见 memory：real-run-before-merge）。

## 7. 仍未知

1. **合并 PR-A/B/C 和 #263 之后 delivered 召回实际是多少**：需要重跑本评测和这 5 次真实运行。
2. **模型路径在修好匹配之后能否有价值**：6/8 的误报来自测试匹配召回不足。根本解决需要更好的代码→测试检索（不只按名字和一级 import），本日未做。
3. **Python 和 Go 的 unref 精确率是否稳定**：每个仓库只抽 10 条，单人标注，未做第二人复核。
4. **更大的仓库**：nest 的 1015 个 unit 每次只审 40 个；即使做了运行时准入，一轮全量也要约 20 次运行（推算）。在这个规模上，确定性清单比模型审查更实际。
