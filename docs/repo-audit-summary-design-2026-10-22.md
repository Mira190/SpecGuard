# 全仓审计 summary 模板：调研、批判与字段规则（2026-10-22）

样板：[`templates/repo-audit-summary.mock.md`](templates/repo-audit-summary.mock.md)（mock 数据；产品输出一律英文）。
本文回答四件事：读者要什么（§1）、对需求的批判（§2）、业界怎么做（§3）、每个字段怎么算（§4）。§5 列 unknown unknowns，§6 对照现有 `src/audit-post.js` 列出差距和实现顺序。

旧模板 [`templates/repository-shift-left-report.md`](templates/repository-shift-left-report.md) 是写给人工审计员的 12 节填空表，字段很全，但它不是给测试者看的 summary。新模板取代它作为产品输出；旧模板留作人工深审的清单。

## 1. 第一性原理：测试者打开报告，要在一分钟内知道什么

读者是测试者 / QA lead。他读这份报告只为了决定下一步做什么。所以报告只有三个问题要回答，顺序固定：

1. **这份报告可信吗？** 范围有没有审完，用了哪些证据（有没有覆盖率报告、CI 历史、需求文档），哪些数字是"没测到"而不是"零"。
2. **先做哪几件事？** 最多 10 条，每条一个动词（Add / Strengthen / Move down / Make CI run / Fix or delete / Clarify / Check），带位置、理由、证据等级、负责人。
3. **风险集中在哪？** 每个领域一行：状态、要处理的数量、证据等级。细节折叠。

由此推出的设计规则：

- **可见部分只放会改变下一步行动的内容**（owner 10-13 的规则：summary 只放可行动内容）。每个领域的明细放进 `<details>`，但 `<summary>` 行本身带关键数字，不展开也能看到全貌。
- **每条发现标证据等级**：E = 执行证据（覆盖率报告、CI 结果）、S = 确定性静态规则、M = 模型判断。排序时 E/S 永远排在 M 前面。理由是我们自己测过：覆盖率缺口在行级 100% 正确（A3），模型的 missing_test 只有 0–15%（A3）、24%（E3 基线）；稳定性 Jaccard 0.17（A1）。把 M 级发现和 E 级混排，等于用低精度结论稀释高精度结论。
- **不给总分。** 一个 0–100 的健康分不告诉测试者改哪里，而且会被刷分（Goodhart）。我们对模型判断类指标没有 ground truth，合成分会把不可靠的输入包装成看似精确的数字。每个领域给"要处理的数量 + 例子"，数量本身就是可行动的。
- **"没测到"和"零"必须区分。** 没有 E2E 覆盖率报告就写 "not measured"，不写 0%，也不用静态匹配的测试数冒充覆盖率。没有设计文档就写 "no design document"，不写 0/0。
- **分母固定由文件决定，不由模型决定。** 同一 commit 同一配置给出同一分母；模型少输出不能让覆盖率变好看。
- **每条行动有负责人**（CODEOWNERS）。批量报告没有归属就没人修（见 §3.6 Infer 的数据）。
- **和上次比**：新增 / 已修 / 仍未修，一行。第二次看到同一份长列表的读者会停止阅读。

## 2. 对需求的批判

需求原文：summary 要包含 requirement health、design health、requirement coverage、design coverage、placement issue、CI check 等；coverage 包括 unit、E2E、integration、component；告诉测试者哪里要加测试、删除、修改，包括 unit test 质量。

| # | 需求 | 问题 | 决定 |
|---|---|---|---|
| C1 | requirement / design **health 评分** | 评分需要 ground truth 校准；我们没有人工标注（owner 10-21），模型判断的精度未测。总分不指向行动。 | 不打分。按 ISO/IEC/IEEE 29148 的维度列"违反条数 + 例子"，标 M 级。 |
| C2 | **design coverage** | 没有通用定义。多数仓库没有设计文档（我们的 docless 分支就是为此存在）。 | 定义为"设计文档中的组件/接口/决策 → 有代码位置 → 有对应层级的测试"的比例；无设计文档时整节显示 "no design document"，不出现在 At a glance 的 ❌ 里。 |
| C3 | 各层 **coverage**（unit/integration/component/E2E） | SpecGuard scan 是静态的，owner 禁止在本地执行第三方代码（10-22）。各层覆盖率只能来自仓库自己的报告（Codecov flag、CI artifact）。静态"有测试文件"不是覆盖率。测试分层本身是启发式（目录、文件名、runner 配置）。 | 表里分两类列：测试清单（静态，总有）和覆盖率（只在有该层报告时有，否则 "not measured"）。分层规则在报告里给链接。 |
| C4 | 告诉测试者 **哪些要删除** | 静态审查建议删除测试风险高：删错了就丢保护。 | 只在有确定证据时建议删除：长期 skip（带天数）、无断言、测试被测对象自身被 mock、引用已删除功能的需求。措辞是 "fix or delete"，不是 "delete"。 |
| C5 | 维度很多（"等等"） | 每多一节就多一份读者注意力成本。我们的核心目标是 unit test 缺口（v1，owner 10-21）。 | 全部维度进模板，但只有 E/S 级能支撑的先实现（§6）。M 级领域默认折叠。 |
| C6 | **unit test quality** | 真正的质量问题是"代码错了测试会不会失败"，这只有 mutation testing 能回答，scan 不执行代码。现有静态信号有噪声：`audit-units.js:289` 把一个 unit 匹配到的所有测试文件的信号相加，而测试文件按名字、提及或目录匹配，一个大的共享测试文件可以匹配多个 unit。A1 自检报告里 52 行 "weak test signal" 指的是 unit（如 `src/post.js`："57 tests without an assertion"），读者不知道该改哪个测试。 | 质量信号按**测试**归属，不按 unit 归属；没有 mutation 时明说 "test strength not measured"。 |
| C7 | **CI check** 范围 | 安全扫描（SAST、依赖、secret）不是测试者的主要职责，但"测试有没有在 CI 里跑"是。 | CI 节以测试为中心（各层是否在 PR 上跑、有没有测试文件从不被任何 job 跑、重试掩盖失败、覆盖率门禁）；安全只占一行。读不到的设置写 ❔ unknown，不算通过。 |
| C8 | "让测试者快速抓住重要信息" 与 "包含所有维度" 冲突 | 两者需要取舍。 | 用"可见 = 结论 + 证据来源 + At a glance + Top 10；其余折叠"解决。 |

## 3. 调研：业界做法与证据

调研时间 2026-10-22。每条结论带来源；标 *(secondary)* 的来自二手总结，标 UNVERIFIED 的没有核实到原文。ISO 29148、ISO 26262、DO-178C 是付费标准，内容来自二手来源。每小节最后一行写"对模板的影响"。

### 3.1 需求质量（requirement health）

| 来源 | 维度 / 打分方式 |
|---|---|
| ISO/IEC/IEEE 29148（经 INCOSE C1–C14） | 单条 9 项：necessary、appropriate、unambiguous、complete、singular、feasible、verifiable、correct、conforming；集合 5 项：complete、consistent、feasible、comprehensible、able to be validated（[arXiv 2408.10886](https://arxiv.org/pdf/2408.10886)、[se-trends](https://www.se-trends.de/en/review-incose-guide-for-writing-requirements/)） |
| INCOSE Guide for Writing Requirements v4（2023） | 41 条写作规则 + 14 个特性（[INCOSE](https://www.incose.org/docs/default-source/working-groups/requirements-wg/gtwr/incose_rwg_gtwr_v4_040423_final_drafts.pdf)） |
| IBM RQA | 按 INCOSE 规则给分，代理商称 11 个质量分覆盖指南 80% 以上（[requisis](https://requisis.com/en/saas-doors-dng/rqa-saas.html)；完整清单 UNVERIFIED） |
| QVscribe | 每条 1–5 格：唯一 imperative、无否定、无模糊词、无逃避条款、EARS 句式（[QRA](https://edu.qracorp.com/knowledge/quality-analysis-scoring-guide-3)） |
| Jama Connect Advisor | INCOSE 规则符合度 0–100%：81–100 绿，61–80 黄，0–60 红（[Jama](https://help.jamasoftware.com/ah/en/jama-connect-advisor-/interpreting-the-results.html)） |

自动化能做到哪一步：措辞层面的规则（模糊词、逃避条款、多个 shall、缺单位）可以自动查；necessary、correct、feasible、跨集合一致性需要语义和上下文。需求坏味检测（Smella）平均 precision 59%、recall 82%，项目间差异大（[Femmer et al. JSS 2017](https://arxiv.org/pdf/1611.08847)）。

**对模板的影响：** 商业工具确实给分（Jama 0–100%），但在 59% 的 precision 下，打出来的分有四成是噪声。模板只列测试者能动手的维度（不可测、模糊、复合、冲突、过时、找不到代码），每行带原文，标 M 级，默认折叠。"necessary / correct / feasible" 是产品负责人的事，不进测试者报告。

### 3.2 设计健康（design health）

| 来源 | 内容 |
|---|---|
| ISO/IEC 25010 maintainability | modularity、reusability、analysability、modifiability、testability（[TMap](https://www.tmap.net/wiki/quality-characteristics-iso25010/)） |
| ISO/IEC 5055（CISQ） | 138 个 CWE：Security 73、Reliability 74、Performance 18、Maintainability 29（含过度耦合、跨层调用、死代码）（[CISQ](https://www.it-cisq.org/?p=486)） |
| Martin 包指标 | I = Ce/(Ca+Ce)，A = 抽象类型占比，D = \|A + I − 1\|；没找到 D 预测缺陷的证据 |
| ArchUnit / dependency-cruiser | 分层规则、洋葱架构、`beFreeOfCycles()`、`no-circular`（[ArchUnit](https://www.archunit.org/userguide/html/000_Index.html)） |
| Fitness function | "对某个架构特性的客观完整性评估"（[Building Evolutionary Architectures](https://oreilly.com/library/view/building-evolutionary-architectures/9781491986356/ch02.html)） |
| CodeScene Code Health | 25+ 因素，1–10 分（≥9 健康、4–9 警告、<4 告警）；厂商研究：红色代码缺陷多 15 倍、开发慢 124%（[Tornhill & Borg 2022](https://arxiv.org/pdf/2203.04374)，厂商作者） |
| SonarQube | 技术债比率 = 修复成本 /（每行成本 × 行数），默认每行 30 分钟；A ≤5%、B 6–10%、C 11–20%、D 21–50%、E >50%（[Sonar](https://docs.sonarsource.com/sonarqube-server/10.4/user-guide/metric-definitions)） |
| Google design docs / ADR | 大项目 10–20 页，小的 1–3 页；ADR 1–2 页：Context、Decision、Status、Consequences（[Ubl](https://www.industrialempathy.com/posts/design-docs-at-google/)、[Nygard](https://cognitect.com/blog/2011/11/15/documenting-architecture-decisions)） |

哪些能预测缺陷：
- **依赖网络：** 在 Windows Server 2003 上，依赖网络指标的 recall 比复杂度指标高 10 个百分点，找出 60% 的关键二进制（[Zimmermann & Nagappan ICSE 2008](https://www.microsoft.com/en-us/research/publication/predicting-defects-using-network-analysis-on-dependency-graphs/)）。
- **循环依赖：** 缺陷最多、最严重的组件集中在循环依赖里（[Oyetoyan et al.](https://ntnuopen.ntnu.no/ntnu-xmlui/handle/11250/297522)）。
- **相对 churn：** 区分易错二进制的准确率 89%（[Nagappan & Ball ICSE 2005](https://microsoft.com/en-us/research/?p=151819)）。
- **组织结构：** 在 Vista 上 precision 和 recall 约 85%，超过 churn、复杂度、覆盖率和依赖指标（[MSR](https://www.microsoft.com/en-us/research/publication/the-influence-of-organizational-structure-on-software-quality-an-empirical-case-study/)）。
- **反例：** 控制类大小之后，OO 指标与缺陷不再相关（[El Emam et al. TSE 2001](https://neverworkintheory.org/2011/07/07/the-confounding-effect-of-class-size-on-the-validity-of-object-oriented-metrics.html)）。
- **反例：** Google 的 117 个代码指标都预测不了工程师感知的技术债，解释的方差不到 1%（[DX 总结](https://newsletter.getdx.com/p/measuring-and-managing-tech-debt) *(secondary)*）。

**对模板的影响：** 不做设计总分（Google 自己的数据说明指标分数和人的感受对不上）。只保留有缺陷证据、而且确定可查的两项：循环依赖和设计文档写明的分层规则（S 级）。再加上测试者关心的"设计 ↔ 代码不一致"和"组件没有测试"。风险排序用 churn 和 fix commit（现有 `audit-units.js` 已经这样做，有 Nagappan 的证据支持）；CODEOWNERS 既用来分派，也可以作为风险信号。

### 3.3 覆盖率怎么算

**种类**
- **Line / statement：** Google 主要用 line 覆盖率，C++、Java、Python 另加 branch。
- **Delta coverage：** 只看新增或修改的行，Codecov 叫 patch coverage。
- **Flags：** Codecov 用 flag 按测试类型拆分报告（[Google FSE 2019](https://homes.cs.washington.edu/~rjust/publ/google_coverage_fse_2019.pdf)、[Codecov flags](https://docs.codecov.com/docs/flags)）。

**阈值**
- **项目级：** Google 2020 年的建议是 60% acceptable、75% commendable、90% exemplary。
- **每次提交：** 99% 合理，90% 是好的下限；项目级超过 90% "多半不值得"（[Testing Blog 2020](https://testing.googleblog.com/2020/08/code-coverage-best-practices.html)）。

**Google 实践（FSE 2019）**
- **规模：** 每天约 10 亿行，中位数项目覆盖率约 80%。
- **使用：** 45% 的开发者写代码时常看覆盖率，40% 评审时常看。每天手动跑覆盖率的只有 0.5%，自动显示在 code review 里才是用起来的原因。
- **范围：** 论文只统计单机 "unit" 测试，并说 line 覆盖率"不适合"集成测试。

**只用小测试算覆盖率**
- SWE at Google 第 11 章："只用 small tests 测覆盖率，避免覆盖率虚高"。
- 门槛会变成天花板：设 80% 的门槛，工程师就把 80% 当目标（[SWE book ch.11](https://abseil.io/resources/swe-book/html/ch11.html)）。

**需求覆盖率（安全标准）**
- **DO-178C：** 先做基于需求的测试，再用这些测试测结构覆盖率。
- **缺口的四种处理：** 补测试、改需求、删死代码、标为停用代码（[LDRA](https://ldra.com/ldra-blog/do-178c-structural-coverage-analysis/)）。
- **ISO 26262-6：** 所有 ASIL 都高度推荐基于需求的测试。
- **公式：** "有至少一个已追溯、通过的测试的需求数 / 需求总数"。这是推断，标准原文 UNVERIFIED。

**层级与比例**
- **Size 和 scope 是两个独立的轴。** Size 指资源：small 单进程、medium 单机、large 多机；scope 指被验证的代码范围（[SWE book ch.11](https://abseil.io/resources/swe-book/html/ch11.html)）。
- **SWE book 的比例：** 约 80% unit / 15% integration / 5% E2E（按用例数）。
- **2015 年博客的比例：** 70/20/10（[Testing Blog 2015](https://testing.googleblog.com/2015/04/just-say-no-to-more-end-to-end-tests.html)）。
- **其他形状：** Pyramid（Fowler）、Trophy（Dodds，以集成为主）、Honeycomb（Spotify，以集成为主）。Fowler 指出分歧主要在于 "unit" 的定义不同（[test shapes](https://martinfowler.com/articles/2021-test-shapes.html)）。

**覆盖率与缺陷的关系**
- 控制测试集大小后，覆盖率和测试有效性只有低到中等相关（[Inozemtseva & Holmes ICSE 2014](https://cs.ubc.ca/~rtholmes/papers/icse_2014_inozemtseva.pdf)）。
- 在真实缺陷上，相关性从中等到强（[Kochhar SANER 2015](https://ink.library.smu.edu.sg/sis_research/2974)）。
- 100 个 Java 项目：项目级不显著，文件级没有相关（[Kochhar 2017](https://www.microsoft.com/en-us/research/publication/code-coverage-and-post-release-defects-a-large-scale-study-on-open-source-projects/)）。
- 和我们 E1 的结论一致：覆盖率缺口不能预测 bug 在哪。

**对模板的影响：**
1. Unit 覆盖率只用 unit 报告（Google 的做法）；E2E 跑到的行不算 unit 已测，这正是"placement"发现的来源。
2. 覆盖率只作为"这行没有任何测试跑过"的事实来报告，不说"覆盖率低 = 缺陷多"。
3. 门禁看新代码（patch），不看项目总数，所以 Top action 7 是"加新代码门禁"。
4. 不在报告里显示 60/75/90 的分档，避免门槛变成天花板。
5. 层级比例（80/15/5）只作为背景，不作为判定。不同"形状"的主张互相冲突，而且依赖 unit 的定义。
6. 用户要的层级顺序按 scope 从窄到宽排：Unit → Component → Integration → Contract → E2E。

### 3.4 Unit test 质量

**Google mutation testing 2018**（[PDF](https://web.eecs.umich.edu/~weimerw/2022-481W/readings/mutation-google.pdf)）
- 只对 diff 做，每行最多 1 个 mutant，跳过未覆盖行和 "arid" 行。
- 约 6,000 名工程师使用；70,000 个 diff、1.1M 个 mutant。
- **压掉 arid 节点后，"有用"率从 20% 升到 80%。**

**Google mutation testing 2021**（[Petrović et al. ICSE 2021](https://ar5iv.labs.arxiv.org/html/2103.07189)）
- 每个文件在 review 里最多显示 7 个 mutant。
- 接触 mutant 越多，写的测试越多（rs = 0.9）。
- 1,502 个高优先级 bug 里，约 70% 与当时会被报告的 mutant 耦合。

**测试坏味**
- tsDetect：19 种坏味，在它的基准上 precision 96%、recall 97%（[Peruma FSE 2020](https://2020.esec-fse.org/details/esecfse-2020-tool-demos/4/tsDetect-An-Open-Source-Test-Smells-Detection-Tool)）。
- 有坏味的测试更容易改动、更容易出缺陷，最重要的是 Indirect Testing、Eager Test、Assertion Roulette（[Spadini ICSME 2018](https://research.tudelft.nl/en/publications/on-the-relation-of-test-smells-to-software-code-quality/)）。
- 但工具和开发者判断差距大（[Panichella EMSE 2022](https://pure.tudelft.nl/ws/portalfiles/portal/137994226/s10664_022_10207_5.pdf)）。

**Flaky**
- **Google 2016：** 1.5% 的运行 flaky，约 16% 的测试有过 flaky；84% 的 pass→fail 跳变涉及 flaky 测试（[Micco](https://testing.googleblog.com/2016/05/flaky-tests-at-google-and-how-we.html)）。
- **Meta：** 每个测试有一个概率 flaky 分，unit 基线 <1%，部分 E2E 框架约 10%（[Meta](https://engineering.fb.com/2020/12/10/developer-tools/probabilistic-flakiness/)）。
- **Microsoft：** quarantine 后测试照跑但结果被压掉，bug 关闭后自动解除 *(secondary)*。

**删除测试**
- Google TAP 的 5.5M 个受影响测试里，只有 63K 失败过（[Memon ICSE-SEIP 2017](https://research.google/pubs/taming-google-scale-continuous-testing/)）。
- Meta 的预测性选择只跑约 1/3 的测试，仍报告 >99.9% 的坏改动（[Meta](https://engineering.fb.com/developer-tools/predictive-test-selection/)）。
- 没有找到大厂公开的"删除测试"政策（UNVERIFIED）。

**对模板的影响：**
1. "测试强度"只有 mutation 能回答，Google 的经验是每文件封顶 + 压掉无意义位置。没有 mutation 时明写 "not measured"。
2. 静态坏味只报高确定性的几种（无断言、只断言存在、mock 被测对象、长期 skip），这些是 Indirect Testing 和 Assertion Roulette 的近亲。
3. Flaky 报成比率（"4 of 71 runs"），不报成是或否，而且要考虑层级的噪声底：E2E 一次红不说明问题。
4. **"从没失败过"不是删除理由**（63K/5.5M）。删除只针对零保护的测试（无断言、长期 skip、mock 被测对象）。

### 3.5 CI 检查

| 来源 | 内容 |
|---|---|
| SonarQube "Sonar way" 门禁（只看新代码） | 无新问题、所有新安全热点已审、覆盖率 ≥80.0%、重复 ≤3.0%；新增不足 20 行时不检查覆盖率和重复（[Sonar](https://docs.sonarsource.com/sonarqube-community-build/quality-standards-administration/managing-quality-gates/introduction-to-quality-gates)） |
| OpenSSF Scorecard 风险等级 | Critical：Dangerous-Workflow、Webhooks；High：Binary-Artifacts、Branch-Protection、Code-Review、Dependency-Update-Tool、Maintained、Signed-Releases、Token-Permissions、Vulnerabilities；Medium：Fuzzing、Packaging、Pinned-Dependencies、SAST、SBOM、Security-Policy；Low：CI-Tests、CII-Best-Practices、Contributors、License（[checks.md](https://github.com/ossf/scorecard/blob/main/docs/checks.md)） |
| SLSA v1.0 Build | L1 有 provenance；L2 托管构建 + 签名 provenance；L3 加固隔离构建（[slsa.dev](https://slsa.dev/spec/v1.0/levels)） |
| DORA（现为 5 项） | change lead time、deployment frequency、failed deployment recovery time、change fail rate、deployment rework rate（[dora.dev](https://dora.dev/guides/dora-metrics/)） |
| CI 健康 | Uber iOS 主干在 SubmitQueue 之前只有 52% 的时间是绿的 *(secondary)*；"time-to-green" 没有标准定义（UNVERIFIED） |

**对模板的影响：**
1. CI 节以测试为中心：各层测试是否在 PR 上跑、有没有测试文件不被任何 job 跑、retry 是否掩盖失败、有没有新代码覆盖率门禁（Sonar 用 80% + 20 行豁免作参考）。
2. Scorecard 里与测试者有关的是 CI-Tests 和 Branch-Protection；其余安全项只占一行"有/没有/读不到"。
3. DORA 和 SLSA 不进测试者报告：它们衡量交付和供应链，测试者不会因此改测试。

### 3.6 呈现与可行动性（最重要）

**Google（Sadowski et al. CACM 2018）**（[PDF](https://6826.csail.mit.edu/2020/papers/google-analysis-cacm.pdf)）
- **定义：** 开发者没有采取积极行动的发现，就是 "effective false positive"。
- **2006 年的 FindBugs 夜间 dashboard** 几乎没人用，因为它在开发者的日常流程之外。
- **2009 年的 fixit：** 审了 3,954 条警告，44% 报了 bug，只修了 16%。
- **进入 code review 的检查要满足：** 可理解、可行动、易修复、effective false positive <10%、影响显著。"Not useful" 超过 10% 的分析器会被关掉，直到修好。
- **时机：** 编译时的问题有 74% 被认为是真问题，已提交代码里的问题只有 21%。
- **整库修复：** 以 patch 形式发给负责人，正面反馈 57%，负面 2%。

**Meta Infer（Distefano et al. CACM 2019）**（[PDF](https://6826.csail.mit.edu/2020/papers/facebook-infer-cacm.pdf)）
- **批量模式：** 夜间运行并分派给开发者，误报率 <20%，修复率仍"接近零"。
- **改到 diff 时报告：** 同一个分析，修复率 >70%。原因是上下文切换成本和归属。
- **只报新问题：** Infer 用与位置无关的 bug hash 识别新问题。
- **反例：** Zoncolan 的批量模式给专职安全专家用，行动率 >80%。**读者是专职 triager 时，批量报告可以有效。**

**其他研究**
- **Johnson ICSE 2013：** 开发者不用静态分析，主要因为误报和呈现方式（[PDF](https://cs.gmu.edu/%7Ejohnsonb/docs/icse2013.pdf)）。
- **Coverity 开源数据：** 中位数只有 36.7% 的告警可行动；修复中位数 96 天，尽管修复本身中位数只有 4 行（[Imtiaz ISSRE 2019](https://www.microsoft.com/en-us/research/?p=690690)）。

**同类工具的首页**
- **SonarQube：** 门禁通过/失败放第一位，然后是 New Code / Overall Code 两个标签页（"Clean as You Code"）。
- **Codecov PR 评论：** 覆盖率差值 → 受影响文件 → flags。
- **CodeScene：** 按 hotspot（改动频繁 × 健康差）排序的"优先技术债"。
- **SARIF：** `baselineState` 支持 new / unchanged / updated / absent（[SARIF 2.1.0](https://docs.oasis-open.org/sarif/sarif/v2.1.0/sarif-v2.1.0.html)）。

**对模板的影响（这是全文最重要的一条）：**
1. 全仓审计本质上是批量报告，按 Google 和 Meta 的数据，给普通开发者看几乎没人修。它能成立的条件和 Zoncolan 一样：读者是专职 triager（测试者 / QA lead），并且精度够高。所以：
   - 顶部先给结论和"证据是否完整"，等同于 Sonar 的门禁优先。
   - 每条行动标 **new / 持续 N 次扫描**（等同于 SARIF baselineState），而且和上次比放在第一屏。
   - 每条行动有负责人（CODEOWNERS）和建议修法（测试草稿），对应 Google 的"以 patch 发给负责人得到 57% 正面反馈"。
   - 列表封顶（Top 10，同文件最多 2 条），对应 Google 每文件最多 7 个 mutant。
   - 每类发现可以被标记 "not useful"，某一类超过 10% 就关掉，对应 Google 的规则。这一条是新功能，见 §6 R8。
2. 长期看，最有效的是把同样的发现送到 PR 时刻（diff time）。全仓审计的价值是建立基线、给 QA lead 排优先级；它不应该替代 PR 模式。

## 4. 字段规则（每个数字怎么来）

### 4.1 顶部

| 字段 | 来源 | 规则 |
|---|---|---|
| 结论行 | 所有发现 | `N things to fix`；拆成 E/S 条数和 M 条数。scan 不完整时改为 ⚠️ 并在同一行写没审到什么。 |
| Evidence used | 输入 | 每类证据一行：有/没有/与本 commit 不符（不符 = 不用）。 |
| At a glance | 各领域 | 固定 8 行，固定顺序（§4.3）。状态：❌ 有 E/S 级问题；⚠️ 只有 M 级问题或部分测量；✅ 测了且无问题；➖ 不适用（如无设计文档）；❔ 没测到。 |
| 和上次比 | scan state | new / fixed / still open，按 finding id。 |

### 4.2 Top actions 排序

1. 证据等级：E > S > M（一条同时有 S 和 M 时按 M 算）。
2. 风险：近 180 天 fix commit 数、错误处理行数、churn（沿用 `audit-units.js` 的 risk）。
3. 工作量：小的在前（加一个断言 < 加一个测试 < 移动一组测试）。
4. 上限 10 条；同一文件最多 2 条，避免一个大文件占满列表。

### 4.3 领域顺序（"你来排序"的答案）

按"测试者能直接动手、证据最硬、越往左成本越低"排序：

1. **Untested code (unit)**：E 级，直接产出要写的测试；这是 v1 核心目标。
2. **Tests that never run**：E/S 级，修一行配置就恢复一批保护，回报最高，而且最容易被忽略。
3. **Unit test quality**：S 级为主（无断言、只断言 truthy、skip、mock 被测对象），flaky 来自 CI（E）。
4. **Test placement**：shift-left 的核心动作（往下推），S+M。
5. **Requirement coverage**：M 级（模型映射需求 → 测试）。
6. **Requirement health**：M 级；只有在它阻碍写测试时才是测试者的事（"不可测"）。
7. **Design coverage and health**：大多数仓库缺文档；结构问题（循环依赖、分层违反）是 S 级但不是测试者的主要行动。
8. **CI checks**：放最后作为明细，但其中"测试不跑"已经提到第 2 行。

覆盖率各层的顺序：Unit → Component → Integration → Contract → End-to-end。理由：越靠下的层越便宜、越快、越确定；shift-left 的目标就是把能在左边证明的东西放到左边。Contract 单列，因为它是服务间调用最常见的缺口，而且通常是 0。

### 4.4 各节

| 节 | 行 | 证据 | 规则 |
|---|---|---|---|
| Untested code | 每个定义一行 | E（unit flag 覆盖率） | 只用 unit 报告；integration/E2E 跑到的行在"Also run by"列说明，但仍算 unit 缺口。报告的 commit 必须等于审计 commit。不在报告里的文件单独计数并说明原因（配置排除/未知）。沿用 #430/#433 的 not-worth-testing 过滤和排序。 |
| Coverage by level | 每层一行 | S（清单）+ E（覆盖率） | 测试分层规则：runner 配置 > 目录 > 文件名后缀；规则可见。没有该层报告 → "not measured"。"Runs on PRs" 来自 workflow 文件 + 最近 check runs。 |
| Unit test quality | 每个测试一行 | S / E | 无断言（含 helper 内断言的跨函数检查）、只断言存在、skip 天数（git blame）、mock 被测模块、flaky（CI 中 retry 后通过的次数 / 总次数）、疑似重复（测试体规范化后相同）。 |
| Test placement | 每条规则一行 | S + M | 下推候选：高层测试中只改变输入数据的多个用例 + 被调用的纯函数 seam（S 找 seam，M 判断是否同一规则）。上推候选：放在 unit 目录但使用真实网络/数据库的测试（S：import 和调用）。 |
| Requirement coverage | 状态桶 + 缺口行 | M（引用经校验） | 沿用 trace 的状态；"only above unit level" 来自 `class: higher_level`。分母 = 文档中的需求块数，固定。 |
| Requirement health | 每条问题一行 | M | 维度：verifiable、unambiguous、singular、complete、consistent（跨文档）、current（引用已删除的功能）、traceable（找不到代码）。 |
| Design coverage | 每个组件一行 | S + M | 组件来自设计文档的标题/列表；代码位置由模型给出并校验存在；测试层级同上。结构检查：import 图的环、设计文档写明的分层规则。 |
| CI checks | 固定检查项 | S / E | 读 workflow 文件和 check runs（只读 API）。读不到 = ❔，不算通过。 |
| 方法与精度 | 固定段落 | — | 每类发现的已测精度（来自我们自己的 eval），未测的写 "not yet measured"。 |

## 5. Unknown unknowns：测试者和报告设计者都容易漏掉的事

1. **测试存在但从不运行。** runner 的 include 规则匹配不到、job 只在 nightly 或 main 跑、`describe.skip` 包住整个文件。覆盖率报告和测试计数都看不出来，只有把 workflow + runner 配置 + 测试文件放在一起才看得到。我们自己的 CI 就漏跑了 eval/replay、eval/f2p、eval/mutation 的测试（#432）。
2. **覆盖率报告和代码不是同一个 commit。** 用旧报告会把已修的缺口报成缺口。规则：commit 不符就不用（#434 已经校验 Codecov 的 sha）。
3. **"不在报告里" ≠ "被覆盖"。** 覆盖工具的配置会排除文件（生成代码、某些目录），这些文件在百分比里根本不存在。
4. **E2E 跑过的行会让 unit 覆盖率看起来更高**，如果所有层合并成一个报告。只有按层分 flag 才能说"unit 缺口"。
5. **重试掩盖 flaky。** `retry: 2` 让 CI 变绿；flaky 只能从"重试后通过"的记录看到。
6. **skip 的测试在统计里算通过。** 长期 skip 的测试是零保护但看起来有测试。
7. **mock 了被测对象的测试**，以及只有 snapshot 的测试：都会通过，保护为零或接近零。
8. **测试分层本身是猜的。** 目录名、文件后缀、runner 配置可能互相矛盾；报告要给出规则，否则读者不信层级统计。
9. **需求文档和代码谁是真相？** 文档可能描述已删除的功能，也可能代码偏离了文档。报告只能说"不一致"，让负责人决定，不能自动判定代码错。
10. **非功能需求（性能、安全）不能用 unit 测试证明。** 不应计为 unit 缺口，而应指向合适的层级或标为"需要数字才能测"。
11. **模型输出不稳定**（A1 Jaccard 0.17）：两次扫描列表不同，读者会以为代码变了。M 级发现需要"两次都报告"才升级（现有的 confirmed 机制）。
12. **批量报告没人看。** 没有负责人、没有和上次的差异、列表太长，报告就会被忽略。
13. **预算截断**：scan 没审完时，"没发现问题"是假阴性。顶部必须写清楚没审到什么。
14. **monorepo**：每个 package 有自己的 runner 和覆盖率，合并百分比没有意义；按 package 分组。
15. **跨仓契约**：消费者端的契约测试在别的仓库，本仓看起来"没有 contract test"不一定是缺口。
16. **门槛变天花板**：报告里显示"80% 达标"会让团队停在 80%（SWE book）。报告只说哪些行没跑，不评档。
17. **小改动豁免**：新增不到 20 行时，百分比门禁没有意义（Sonar 的 fudge factor）。
18. **工具对生成代码的处理不同**：JaCoCo 会静默过滤带 `Generated` 注解的类（[JaCoCo](https://www.jacoco.org/jacoco/trunk/doc/changes.html)），换工具后数字会变。
19. **覆盖率运行本身会失败**：插桩会引起超时、OOM、更多 flaky（Google FSE 2019）。没有报告时写 "not measured"，不写 0%。
20. **"从没失败过"不是低价值**：Google 5.5M 个测试里只有 63K 失败过。
21. **一个吵的章节会拖垮整份报告的信任**：忽略 flaky 告警是"人之常情"（Google 2016）。M 级章节默认折叠，就是为了不让它们拖累 E 级发现。
22. **测试 size 和 scope 是两回事**：窄 scope 的 UI 测试可能要浏览器（large），宽 scope 的测试也可能是 small。按目录分层会分错一部分，所以分层规则必须可见。

## 6. 与现有实现的差距和实现顺序

现有 scan summary（`src/audit-post.js` `render()`，A1 自检输出见 SpecGuard-evidence/a1-self-audit）的问题：

- 第一屏是漏斗行（"31 eligible = 31 inventoried; 31 selected = 3 reviewed whole + 28 forced (recorded unsure)"），测试者看不懂，也不改变行动。应移入 Details。
- 52 行 "Static test signals" 按 unit 汇总测试文件级数字，不指向具体测试，读者无法行动。
- 没有证据等级、没有负责人、没有 At a glance、没有 CI 节。

实现顺序（每一步都要有对应 eval，owner 10-18 的规则）：

| 步 | 内容 | 证据等级 | 依赖 |
|---|---|---|---|
| R1 | 新骨架：结论行、Evidence used、At a glance、Top actions、折叠节；现有发现映射进去 | — | 无；纯渲染，可用现有 audit.json 回放对比 |
| R2 | 质量信号按测试归属，去掉按 unit 重复 | S | test-map |
| R3 | Tests that never run：workflow + runner 配置 + 测试文件交叉 | S | 新模块，只读 |
| R4 | CI 节：check runs 历史（retry 后通过、各层是否在 PR 跑） | E | 只读 API |
| R5 | 按层覆盖率（Codecov flags） | E | #434 |
| R6 | Placement 下推候选（S 找 seam + M 判断） | S M | trace |
| R7 | Requirement health、Design coverage | M | 需要先测精度（judge 校准） |
| R8 | 每条行动可标 "not useful"（scan issue 里的命令或勾选），某类发现的 not-useful 率超过 10% 就默认关掉（Google 的规则） | — | scan issue state |

R1–R5 不依赖模型，可以先上；R6、R7 在测出精度之前默认折叠，并在方法段写 "not yet measured"。
