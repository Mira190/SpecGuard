# Review of Research and Original Goal Implementation

Date: 2026-10-06. The review covers the current workspace (including the previous round's uncommitted refactor). This report only assesses; it does not change runtime code.

Conclusion: the research can help with optimization, most importantly by standardizing tool-execution evidence, testing degraded scenarios, and defining acceptance methods. A runnable requirement-aware static AI review framework is already implemented, but the Original Goal cannot be considered fully accepted. The 26 tests from the previous round verify program behavior, not the accuracy with which the model finds missing tests; this round also reproduced two program-level false-negative / trust-boundary problems.

## 1. Value of the three research files

| File | Adoptable content | Content that should not be migrated directly |
|---|---|---|
| `research/AI Unit Test Review Workflow Research Report.md` | Accept requirements, test quality, standards, and layers separately; standards confirmation needs execution evidence; start advisory, then calibrate on real PRs | The market conclusion that "no other tool can do this" lacks full verification; the four-way model setup and merge gate are new designs of that proposal, not original requirements |
| `research/SKILL.md` | Split compound ACs; zero assertions, disabled tests, weakened assertions removed, bug-fix regression tests; distinguish which logic can be pushed down and which integration responsibilities must stay | Do not auto-block just because the text contains must, a missing regression test, or instruction-like text; a model's self-reported confidence of 80 is not a calibrated 80% accuracy |
| `research/ai-unit-test-review.yml` | Collect execution results from Checks/Statuses; record commit, source, and status; context manifest and traceable results | The 720-line workflow, four model runs, inline write permission, polling wait, and gate should not wholesale replace the current smaller composite Action |

Two statements in the research need correcting: a coverage miss proves at most that this particular run over this scope did not execute a line; it does not prove that no suitable test exists anywhere in the repository. And crossing modules does not automatically mean it should be split into a unit test; the public interface, integration contract, and cost judgment still have to be kept.

## 2. Item-by-item judgment of the Original Goal

The original text is preserved at `docs/design.md:21`; research-extended features should not be taken back as hard original requirements.

| Original goal | Current implementation | Judgment |
|---|---|---|
| GitHub Actions workflow | `action.yml`, the README consumer workflow, `.github/workflows/ci.yml` dogfood, Copilot/Claude engines | Workflow structure is implemented; the new report contract has not been accepted with real runs on both engines |
| requirement-aware | `requirements.js` collects the PR and up to five linked issues; cross-repo references and read limits are visible; the skill requires reading the linked spec | The GitHub PR/issue path is implemented; there is no independent, checkable AC list, and Jira etc. is not an off-the-shelf feature |
| changed behaviour → test obligations | coverage rows carry id, obligation, source, behaviour; the prompt requires enumerating branches, boundaries, error paths | Structure is implemented; enumeration is still done by the model, and the validator does not know what the model failed to list |
| obligations → assertions | assertion path/line/quote/proves, exact quote validation and finding/obligation consistency check | It can verify that the quoted text exists, but cannot prove the assertion is valid, will execute, or really covers that behaviour; there are gaps for test-only changes and zero-assertion cases |
| assertions → test layers | unit/component/integration/e2e; higher-level-only coverage is not counted as unit evidence | Structure is implemented, layer classification still depends on the model; there is no deterministic proof from test execution results or runner configuration |
| identify missing unit tests | `missing_test`, `weak_test`, suggested test skeletons, search of existing tests, per-item reporting | The main path is implemented; key boundaries are incomplete and model accuracy is not accepted |
| coding standard has been confirmed | base rule inventory, rule reference validation, checked/no_rules/not_reviewed | Only static standards review is implemented. If confirmed includes lint/format having run and passed, it is not implemented; rule discovery and base restoration also have defects |
| component/integration → appropriate unit tests | higher_level_only + pushdown, requires a public seam, inputs/outputs, and keeps integration responsibilities | A minimal implementation matching the original optional goal; real-repository benefit and false positives are not evaluated. pull-up/duplicate cleanup is not required |
| high-confidence verification gaps | high/low, search requirement, text validation, unknown downgrade | There are mechanisms to reduce false positives, but no accuracy data proving high-confidence has been reached |

Therefore the status should be written as "core framework implemented, known boundaries awaiting fixes, product-grade accuracy awaiting validation", not "all requirements perfectly implemented".

## 3. Specific gaps in the current implementation

### P1 — A test-only PR loses legitimate findings (reproduced)

Location: `src/post.js:190`, especially `reviewable.has(c.behaviour.path)`.

Case: production file `src/price.js` is unchanged; the PR changes `assert.equal(total(5), 10)` to `assert.ok(total(5))`. The model correctly cites the production behaviour and the changed assertion, and the initial `validate()` passes, but `verifyEvidence()` downgrades the row to unknown and deletes the weak_test finding because the production path is not in the changed files.

Result of calling the current exported functions offline:

```text
Test-only PR validates: { ok: true }
After verification: { status: "unknown", findings: 0 }
```

This is not the model failing to recognize the problem; the program discards the recognition result. "What changed in this PR / the basis of impact", "production behaviour location", and "test evidence location" should be separated: allow the production behaviour to be in an unmodified file, but require a checkable changed-test basis; the scope restriction cannot simply be removed entirely. Add acceptance cases for assertion weakened, test skipped, assertion deleted, and test file deleted.

### P1 — Standards inventory and restore rules are inconsistent (reproduced)

Location: `src/collect.sh:13`, `:25`, `:54`, `:60`.

`match()` accepts `REVIEW.md`, `CONTRIBUTING.md` and similar files in any subdirectory, while the restore paths such as `:(glob)REVIEW.md` cover only the root directory. In a temporary Git repository, base's `pkg/REVIEW.md` requires independent assertions and head changes it to skip the check; after running the existing collector:

```text
Rule inventory: "pkg/REVIEW.md"
Nested rule after restore: HEAD: skip assertion reviews.
```

So text modified by the PR is still listed as trusted base standards. This problem was not covered by the previous round's integration test of the root AGENTS.md.

Another problem confirmed in the same run: the root `CODING_STANDARDS.md` is not in the standards inventory. The `docs/**/standards*` and `docs/**/conventions*` that the research explicitly lists are also not in the current default discovery paths. Even if the model cites these rules, the poster cannot verify them against trusted rules.

Optimization: first fix a single path list, then use the same list for discovery, base content reading/restoration, and validation; test head-only, deleted, and nested files separately. Standards paths may support explicit consumer configuration, but that configuration must also come from a trusted source, not be replaceable by the PR.

### P1 (interpreting confirmed as execution evidence) — No lint/format confirmation

There is currently no code reading Checks/Statuses and no corresponding collector input. `standards.status = checked` is the model's static review claim; `references/standards.md` explicitly says it does not mean lint was executed. The original brief did not require lint and an author checkbox, but the research explicitly interprets "confirmed" as tool evidence; under that interpretation the current state does not satisfy it.

Suggested minimal addition: keep the AI's rule review, and separately record the standards-check results specified by the consumer (source, check name, commit, run URL, status, conclusion). Use passed/failed/pending/not_found/unavailable; when not configured, explicitly say not_configured, and do not treat an arbitrary green job as lint passing. An author checkbox can only count as a manual declaration.

Do not copy the original research's fixed regex and eight-minute polling: check whether all specified checks appear, whether the result corresponds to head or the PR merge commit, and which result is used on re-runs; neutral/skipped should not automatically equal successful execution. GitHub provides an API to read check runs by ref, but "which checks suffice to prove the team's standards were enforced" still needs a consumer contract.

### P2 — Cannot prove that all acceptance criteria were evaluated

Location: `src/requirements.js:28`, `src/post.js:31`, `src/post.js:149`, and the free-text source in the schema.

The collector keeps requirement text and sources but does not form an independent AC list. The model lists its own coverage rows and declares covered itself, and the validator only checks the rows already output. If a PR has AC1 and AC2 and the model outputs only AC1, it can still produce a legitimate 1/1 report. The current wording "assessed obligations" is more honest than "all covered", but it is not equivalent to the per-AC completeness the research requires.

Suggestion: borrow the research's "split compound criteria first, then map item by item": output the original criterion quote and source, the criterion ID, and the obligation IDs after splitting; requirements that are unimplemented / cannot be linked to production code must also be kept. Do not let a mandatory changed-behaviour reference cause an unimplemented requirement to be omitted. An ID-linkage check can prevent internal omissions but cannot deterministically guarantee that arbitrary natural language was fully extracted; extraction recall still has to be evaluated.

### P2 — An existing zero-assertion test cannot be correctly expressed as weak_test (reproduced)

Location: `src/post.js:54`, `skills/test-review/SKILL.md:35`.

weak_test must carry unit assertion evidence; when an existing test only executes `total(5)` and has no assertion at all, the legitimate report "the test exists but has no assertion" is rejected:

```text
{ ok: false, error: "coverage[0] weak_test needs a unit assertion" }
```

The model could report missing_test instead, but that loses the distinction between an existing test and a missing assertion, and also does not satisfy the research's no-assertion analysis. It should be allowed to cite the actual test/call location and state explicitly that the assertion is absent, while covered must still have assertion evidence. Skipped/disabled, deleted/weakened assertions, and bug-fix regression tests should also be checked explicitly; an assertion existing in the source does not mean the test is executed by the runner.

### P2 — High confidence has not passed end-to-end evaluation

Location: Success criteria at `docs/design.md:277` and Acceptance matrix at `:286`.

The existing tests mostly feed hand-constructed findings to the validator/poster, showing how reports are processed. They do not verify whether the model can find missing requirements in real code, recognize mirrored assertions, find existing tests, or correctly recommend pushdown.

The document proposes about twenty real PRs across three languages, high-confidence precision >= 80%, and time and cost measurement; there is currently no corresponding evaluation artifact. Four model calls or self-reported scores cannot replace this evidence.

## 4. Risks in the research prototype itself

1. `research/ai-unit-test-review.yml:297` merges neutral with success; matching one successful check by name regex also cannot prove that all required lint and format checks ran.
2. The headline at `:618` uses passed when there is no blocking/important finding, without first checking reviewer errors. When all AI legs error, the per-axis detail says Error but the overall headline may still be passed. An advisory job not blocking must be distinguished from the review conclusion passing.
3. `:462` uses allowedTools plus a disallowedTools list. The official CLI documentation distinguishes allowedTools (run without asking) from tools (the set of available tools). The description of the former cannot be taken as a complete tool-isolation guarantee; the current Action's tools policy should be kept.
4. The four reviewers post inline comments themselves, and report filtering runs afterwards; post-processing cannot retract false positives already published or do unified deduplication. The current centralized posting by the poster is better to keep.
5. `requirements` is not a mandatory field on each axis in the research schema; if the model omits that array it may still return a formally valid result. Its "complete requirements matrix" likewise needs additional verification.
6. Blocking gate, four agents, Jira, and mutation execution are options or later extensions, and should not be added by default just to match the research.

## 5. Suggested optimization order and acceptance

| Order | Change | Minimum acceptance |
|---|---|---|
| 1 | Fix the impact scope and citation model for test changes | Test-only changes, deleted assertions, and skipped tests keep well-founded findings; unrelated historical defects still do not enter this review |
| 2 | Unify standards discovery and the base trust source | Tests pass for nested REVIEW/CONTRIBUTING, CODING_STANDARDS, head-only, and deleted standards |
| 3 | Provide standards tool-execution evidence separately | confirmed only if all specified checks succeed; pending/missing/unavailable are all shown explicitly; the advisory default is unchanged |
| 4 | Add AC quote mapping and zero-assertion representation | Two ACs cannot appear complete because only one was output; compound ACs are split; existing zero-assertion tests can be accurately described |
| 5 | Run the real-model acceptance set | Every original goal has seeded positive/negative cases; record finding precision, seeded gap recall, JSON validity rate, latency, and cost |
| Later, as needed | ingest existing coverage / mutation artifacts | Verify commit, producer, scope, and integrity; read only, and do not execute PR code in a job holding AI credentials |

Keep a single agent and separate report dimensions. Consider splitting only if measurement shows the single agent has systematic cross-dimension omissions and that adding model runs really improves results. Introducing a gate should be a separate product decision and is not a prerequisite for completing the Original Goal.

## 6. Evidence and limitations of this round

- Read the research report, skill, and full workflow one by one, and compared them against the current collector, schema, skill, poster, tests, and design.
- Using the current exported functions, reproduced the test-only PR losing a finding and weak_test without an assertion being rejected; verified that a single-row coverage cannot express an omitted second AC.
- Actually ran the collector in a temporary Git repository, reproducing nested REVIEW.md not being restored and CODING_STANDARDS.md not being discovered; the temporary directory has been cleaned up.
- This round did not run the full test suite again, call a paid model, post comments, or modify runtime code. The 26 passes from the previous round do not cover the counterexamples newly found this round.
- External checks were used only where necessary for capability boundaries; the research report's claims about competitor coverage, cost, and market uniqueness were not treated as verified facts.

Official references: [Claude CLI tool controls](https://code.claude.com/docs/en/cli-reference), [GitHub Check Runs API](https://docs.github.com/en/rest/checks/runs#list-check-runs-for-a-git-reference).
