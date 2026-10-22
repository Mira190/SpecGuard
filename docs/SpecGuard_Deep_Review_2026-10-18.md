# SpecGuard Deep Technical Review: Net Benefit of Recent Updates, Regression Risk, and the Next-Phase Roadmap

> Historical snapshot note (updated 2026-10-18): this document is based on main `08d2c5b` and the PR #345 draft at that time. The deterministic same-test / anchored-regex downgrade rule in that draft has been withdrawn; the revised #345 has been merged, replacing it with prompt constraints while keeping the counterexample tests. The risk analysis of that old approach in the text is a historical record, and does not mean current main still contains that rule. Later, #351 added a requirement-version publication check, same-call gating, and base-retarget test behaviour; this report does not replace the latest acceptance of those commits.

**Date:** 2026-10-18 (Sydney, Australia time)  
**Repository:** [`Mira190/SpecGuard`](https://github.com/Mira190/SpecGuard) (public repository)  
**Review baseline:** `main` @ [`08d2c5b87bb8ffc144f4ca3135e8aa4ec79f327c`](https://github.com/Mira190/SpecGuard/commit/08d2c5b87bb8ffc144f4ca3135e8aa4ec79f327c)  
**Special comparison:** merged PRs #329, #335, #336, #340, #341, #342, #343, #344; **not yet merged** PR #345.  
**Sources:** the repository's current source files read through the GitHub Connector, commit diffs, PR contents, CI and Kite Actions logs, and historical evaluations in the repository.  
**Scope of changes:** this round only reviewed and wrote the report; **no code was pushed, no PR was merged, and no new paid model evaluation was started**.

---

## 0. Executive summary: the seven most important conclusions

1. **The overall direction is right, but it cannot be claimed that every optimization is a positive one.** Recent fixes have verifiable engineering benefits in execution completeness, evidence attribution, budget accounting, scan UX, and regression constraints; but most of the benefits have not been translated into new real TPs or reduced FPs proven by independent labelling.
2. **#343 is the recent change with the most significant quantifiable improvement.** In the PR author's offline same-configuration comparison, the units that Nest was forced down to unsure because test evidence was truncated fell from **263/489 to 78/489 (-70.3%)**, and Hono from **133/172 to 82/172 (-38.3%)**. This "reduction of spurious incompleteness" benefit has reasonable code-mechanism support, and the measured scans ran successfully, but **it is not a measurement of precision or recall**.
3. **#344 fixes a set of real reliability holes, and its net benefit is probably positive**: unit finding provenance, directory-link root anchoring, reserved repair-turn cost for unknown usage, and Windows Git Bash location. The **CommonJS export-name expansion** needs separate evaluation: it may reproduce the low-value static alerts met earlier in #269, "the fact holds but it is actually already covered by a public entry point".
4. **The open #345 has a substantive false-negative risk, and is not recommended for merge under the existing gating.** Its `pinnedInTest()` lowers the confidence of weak-assertion alerts because of an **unrelated** exact assertion in the same test; the regex `^.*$` is also treated as valid anchored matching. A minimal counterexample was run separately using the judgment logic extracted from the diff; this is not guessing model behaviour, but an over-broad condition in a deterministic publisher heuristic.
5. **"Green CI" does not equal the product passing.** The latest mainline CI on 2026-10-18, run [`39085373622`](https://github.com/Mira190/SpecGuard/actions/runs/39085373622): **1480 tests / 1476 pass / 0 fail / 3 skipped / 1 TODO**, but the mainline `dogfood` job was skipped; PR #345's [`39084816569`](https://github.com/Mira190/SpecGuard/actions/runs/39084816569) had a successful dogfood, yet the log still says **reduced review (fast-tier model)**.
6. **The biggest product bottleneck of the full-repo scan is "finding evidence → proving the gap", not whether the scan can be completed.** An earlier third-party evaluation of the repository gave 8 model conclusions of which **0 were valuable** (a result of an old historical version, not representing today's precision); the problem was mainly failing to match real evidence passing through wrappers, DI, export entry points, shared test files, and baseline indirect coverage. This mechanistic risk did not disappear naturally by adding more calls.
7. **The next phase should move from "piling up heuristics / piling up scan volume" to "a behaviour-level evidence graph + causal evaluation".** First solve the verifiable false-negative gating and real test mapping, then build a strict same-version A/B and a fix-through loop. Do not continue to treat lowering unsure and raising the number of scanned files as Shift Left itself.

### Classification of recent optimizations (distinguishing strong from weak evidence)

| Change | Net benefit judgment | Evidence grade | Where it may still regress |
|---|---|---|---|
| #329 full-repo `scan_scope=all`, segmentation, and budget admission | **Clear engineering positive** | Code / real Actions | More calls do not mean higher TP, long tasks and cost grow; `all` on a large repo does not support the same path for Copilot |
| #335 each finding bound to the executing call, missing usage charged at worst case | **Clear reliability positive** | Code / targeted regression | Cross-call references may still be conservatively rejected; a complete provenance ledger is needed |
| #336 requirements exclude patterns root anchored, eval construction validation | **Clear correctness positive** | Code / regression | Non-anchored old configs may still filter with the original semantics; users need to understand the scope rules |
| #340 "not evaluated" no longer impersonates non-requirement, duplicate weak removed, static leads saved in full | **Clear correctness positive** | Code / regression | More honest status may show more incomplete; duplicate removal must avoid merging different causes |
| #341 test matching and slicing misjudgment fixes | **Fairly strong positive** | Offline comparison / regression | Omitting weakly associated tests risks misses; the 80-line slice boundary still exists |
| #342 manual form simplified, tracking issue not created by default | **Positive UX / privacy trade-off** | Code / regression | A stateless run has no cross-run confirmation; this should be flagged clearly |
| #343 call-specific cuts, slice pricing, pack small tests first | **Significant engineering positive, accuracy unproven** | Offline comparison / real Action / regression | Pack coverage accounting ≠ fault detection; the new pricing logic is complex and should guard against plan/actual divergence |
| #344 provenance, directory anchoring, repair reserve, Windows bash | **Mostly positive** | Diff / regression / Kite run | CommonJS name expansion may add noise; Windows mock-only tests do not represent real installs of all kinds |
| #345 same-test pinned and NO_GAP | **Mixed, not suitable to merge currently** | Independent counterexamples / PR CI | Directly suppresses possibly real weak-test TPs; the `not a gap` text gating is too broad |

**Rating principle:** "positive" means effective for the engineering problem it claims to address, and **does not automatically** mean an improvement in end-to-end discovery quality. Without independent same-basis labels, only write "unproven"; not finding a counterexample is not equated with passing.

---

## 1. What SpecGuard should optimize, from first principles

SpecGuard's value lies not in "reading a lot of code" or "generating many suggestions", but in delivering **new, correct, executable test obligations** as early as possible. For a PR: whether the modified behaviour has associated requirements, which cases should be added or strengthened, which layer (unit/component/integration/e2e) they belong to, and which Coding Standards have a confirmable real execution status. For the whole repository: finding key behaviours and requirement deviations not yet locked in, while honestly stating which lack enough evidence to judge.

End-to-end chain:

```text
Truly applicable behaviour/gap (independent oracle)
  -> change/requirement/symbol/test location (retrieval)
  -> context fully loaded (pack / provenance)
  -> model or static detection (candidate)
  -> deterministic verification/downgrade/dedup (verified)
  -> user-visible, actionable (delivered)
  -> author understands and adds tests (acted upon)
  -> CI or a human proves the gap is really fixed (verified fix)
```

So these must be measured separately: **eligible → reached, reached → evidence_complete, oracle → delivered TP, published → actionable TP/FP, delivered valid → verified fix**. This is not a system that a single "coverage" number can describe.

Pay particular attention to four inequalities:

- `unit seen != unit fully verified`;
- `test file mentions symbol != test proves specified behaviour`;
- `no matched test != no test exists`;
- `CI passed != SpecGuard's recommendations are correct`.

### Current architecture (from source)

- `src/collect.sh`, `src/requirements.js`, `src/test-map.js`, `src/trace.js`, `src/audit-units.js`: collect documentation, behaviours, test candidates, units, and static leads.
- `src/engines/claude-api.js` and the Copilot/Claude runners: context assembly, slicing, segmentation, API budget, and structured output.
- `src/post.js`: PR finding validation, comments, tracking, and result display; `src/audit-post.js`: the scan's requirement and unit validation, confidence gating, completeness, issue state, and summary.
- `eval/grade.js` etc.: evaluation, recall, precision, strict mode; `.github/workflows/ci.yml`, `specguard-run.yml`, `specguard.yml`, `action.yml`: CI, manual, reuse, and composite Action integration.
- Local run `bin/specguard-local.js`. The project already has rich fixtures and regression cases, which is a strength; the weakness is that for some of it, "whether a real finding is useful" does not yet have a stable independent oracle.

Evidence: [code `test-map.js`](https://github.com/Mira190/SpecGuard/blob/08d2c5b/src/test-map.js), [`audit-post.js`](https://github.com/Mira190/SpecGuard/blob/08d2c5b/src/audit-post.js), [`eval/grade.js`](https://github.com/Mira190/SpecGuard/blob/08d2c5b/eval/grade.js), [CI workflow](https://github.com/Mira190/SpecGuard/blob/08d2c5b/.github/workflows/ci.yml).

---

## 2. Specific re-check of recent versions

### 2.1 #329: from rotating scans to one planned full-repo scan

Strengths: plans all units and documentation blocks, with an explicit hard budget, deadline, and unreached parts; users no longer need to trigger selected repeatedly to cover the entire repository. A later third-party scan has been practised on Nest, Hono, Fastify, Flask, and Cobra (see [`third-party-scan-eval-2026-10-17.md`](https://github.com/Mira190/SpecGuard/blob/main/docs/third-party-scan-eval-2026-10-17.md) in the repository).

Limitations: all units being **selected / reached** does not imply all tests are fully loaded, all requirements have an oracle, or all risks are correctly identified by the model. `scan_scope=all` is currently specific to the Claude API path in the product definition, and should not be advertised as equivalently runnable on every engine. In the real Kite target run on 2026-10-18, although all units were reached, the publisher still gave `STATUS: incomplete`: this is incomplete evidence / review coverage, not a run failure.

### 2.2 #335 / #336: reliability and eval credibility

#335's `callKeys` ensures a finding can only be based on the unit parts already seen by **the actual call that produced it**, eliminating the provenance hole of "the whole run saw this line, but this call did not"; reserving worst-case cost for unknown usage avoids wrongly exceeding the budget. #336 fixes the root requirements exclude wrongly deleting nested eval documents, the tool's own unrelated tests polluting the target project's test candidates, and partial-head eval construction passing. These are all functional correctness fixes and should be maintained first.

Regression recommendation: for any newly added cut/pack/merge/repair logic, also test provenance: original reference, source sha, call id, part spans, visible lines, candidate association, filter reason; references that cannot be observed are downgraded to unknown rather than confirmed gaps.

Evidence: [#335](https://github.com/Mira190/SpecGuard/pull/335), [#336](https://github.com/Mira190/SpecGuard/pull/336).

### 2.3 #340 / #341: more honest state and fewer false truncations

#340 stops the model from using "not evaluated" to disguise a requirement block as non-requirement, removes duplicate weak findings at the same position, and changes static leads from showing only the first 20 to keeping all in the details/artifact. A positive change that directly improves users' ability to judge.

#341 improves the flooding matches of generic file names (`index.test.ts`) in unrelated directories, weakly associated tests taking pack room, and import lines triggering incorrect slice truncation. Its offline comparison: Hono forced **136→86**, Nest **153→125** (this table uses a different baseline from #343's, so the two cannot be added across tables to compute an overall gain).

Potential cost: once test mapping is further "slimmed", real remote/indirect tests will have a harder time entering the candidate set. The "tokens saved" and "real necessary tests lost" deltas should be listed together, rather than looking only at forced decreasing. The original 80-line test-block window remains a high-risk complexity bottleneck.

Evidence: [#340](https://github.com/Mira190/SpecGuard/pull/340), [#341](https://github.com/Mira190/SpecGuard/pull/341).

### 2.4 #342: better manual-trigger experience, but explicitly stateless semantics

The `workflow_dispatch` target parameter can be `owner/repo`, a PR URL, or `tree/<branch>/<directory>`, the latter deriving the scan scope from the target path; max_units/output_tokens, which do not need to be exposed to ordinary users, are removed; `scan_issue` defaults to `none` to avoid writing scan state in the public SpecGuard repository. Mainly a UX and data-location-control benefit.

Note: stateless `scan_issue=none` cannot be equated with cross-run tracked confirmation. Users must be able to see "this is only one snapshot; the gap has not gone through a second independent evidence check", and the reminder that "the source scope is narrowed while shared design/tests retrieval still comes from the whole repository". [#342](https://github.com/Mira190/SpecGuard/pull/342).

### 2.5 #343: the optimization most worth keeping this round, but three metrics must be separated

This PR includes:

- `pack-cut.txt` changed from "the union of file cuts across all calls" to `path<TAB>unitIds`, so that unit A is not responsible for a same-named file's cut in unit B's call;
- the "fully semantically relevant slice" of big tests is priced by the actual slice cost, rather than by the truncated whole file;
- units in `audit-units.txt` are sorted by required test bytes from small to large, reducing shared-allocation starvation.

The PR author's same-configuration offline measurements:

| Repo | Units | forced before | forced after | Change | planned unit calls |
|---|---:|---:|---:|---:|---:|
| Nest | 489 | 263 | 78 | **-70.3%** | 108→104 |
| Hono | 172 | 133 | 82 | **-38.3%** | 81→78 |
| Fastify | 33 | 19 | 12 | **-36.8%** | 22→21 |
| Flask | 21 | 11 | 5 | **-54.5%** | 9→9 |
| Cobra | 18 | 11 | 7 | **-36.4%** | 14→13 |

The PR also discloses that a half-room policy was tried: it increased the number of calls without effective benefit, so it was not kept. This practice of **also publishing negative results** is worth maintaining.

**Independently verifiable real-run facts:** for the PR branch `fix/forced-tests`, on [`Kite run 39083946253`](https://github.com/Mira190/Kite/actions/runs/39083946253), [`39083944276`](https://github.com/Mira190/Kite/actions/runs/39083944276), [`39083942363`](https://github.com/Mira190/Kite/actions/runs/39083942363), the GitHub Action jobs really succeeded, and the logs show targets with 489/489, 172/172, 43/43 units being reviewed. **But the `STATUS` in these logs was `incomplete` in every case.** "Ran to completion" does not conflict with "all test evidence is complete"; job success cannot be treated as coverage certification. The quantity details and costs of the corresponding real runs come from the PR author's record, not from an independent recomputation of the artifacts in this review.

**Two new assertions are recommended:** `pack_cut == expected_per_call_cuts` and `unit_decision_not_covered_without_all_obligation_evidence`. In addition, property-based / metamorphic tests for the various arrangements in which the same test file is sliced or fully loaded across different calls and unit parts. [#343](https://github.com/Mira190/SpecGuard/pull/343).

### 2.6 #344: four confirmable fixes + one static-signal expansion worth spot-checking again

Positive:

1. `audit-post.js` verifies that the declared unit is a member of the call that produced the finding; `missing_test` must cite the unit's own code, and `weak_test` must cite the tests listed by the unit (matched / pack allowed). Fixes provenance cross-wiring.
2. `resolve-inputs.js` turns directory links into **root anchored** paths such as `/packages/payments`, fixing `legacy/packages/payments` being wrongly included, and refuses ambiguous scans when branch/path cannot be verified.
3. The one JSON repair turn of `claude-api.js` must separately reserve the worst-case cost; returning `usage:{}` cannot make the second call free of charge.
4. `bin/specguard-local.js` on Windows prefers locating Git for Windows' `bin/bash.exe`, rather than accidentally calling System32/WSL bash. Different installation layouts on real machines still need a smoke test.

**Disputed:** `src/test-map.js` `publicDefs/cjsNames` additionally recognizes export names for `module.exports={...}`. It improves the **literal recognition ability** of the passive static inventory, but enlarges the set of leads where "some name never appears in tests", and does not automatically mean a real gap needing a unit test was found.

The old evaluation in the repository points out that **#269's CommonJS export name expansion was closed**: Fastify unref leads 6→42, a spot check of 5/5 were already covered via other entries, net negative. #344 is a different implementation, so it cannot be said that "the same bug reappeared"; but it sits on **exactly the same high-risk mechanism**, and on the real negative samples of Fastify/Hono/Kite the newly added TP and FP must be checked. Merely showing the export names are extracted correctly is not enough to prove the alerts are useful. Sources: [#344](https://github.com/Mira190/SpecGuard/pull/344), [third-party evaluation §8.1](https://github.com/Mira190/SpecGuard/blob/main/docs/third-party-scan-eval-2026-10-17.md).

### 2.7 #345 (Open): explicitly not recommended for merge in its current form

The new rule tries to handle: `weak_test` citing only one truthy-assertion line in a test while the same test actually has other exact assertions; and the "not a gap" wording.

**Deterministic collateral-damage counterexample A: different subjects in the same `it`**:

```js
it('validates authorization and metrics', () => {
  expect(auth.allowed).toBeTruthy(); // weak assertion; e.g. a wrong state mistaken for allowed
  expect(metrics.count).toBe(42);   // exact assertion unrelated to auth
});
```

The newly added `pinnedInTest()` searches for any non-weak assertion within the enclosing test block, and does not require it to prove the same input, same subject, or same changed behaviour as `auth.allowed`, so it marks the first finding as low (`the same test also pins a value`). In this review, an independent minimal Node experiment was written following the original PR's `TEST_DECL/ASSERTION/ANCHORED/LOOSE/CALL_SUBJECT` judgment structure, and it reproduced a returned line number **3** (downgrade); this is a gating regression of an **unmerged branch**, not a result that has already occurred on main.

**Deterministic collateral-damage counterexample B: formally anchored, semantically unconstrained**:

```js
expect(payload).toMatch(/^.*$/);
```

`ANCHORED` only recognizes the `/^...$/` shape, and will judge empty-match / any-text patterns as pinned; this judgment was also independently run and confirmed to return true. Even if a regex is anchored, it is not equivalent to verifying the value or boundary that behaviour requires.

**Text-gating risk C:** the new `NO_GAP` recognizes `not a gap`, but only excludes a directly following `in`, and may wrongly kill real findings such as `not a gap for X, but Y still lacks coverage`. Not a reproduced product TP loss; a high-priority test that should get a counterexample.

**Recommended implementation, rather than "widening or deleting the whole rule":**

- Lower confidence only when another assertion can be mapped to the **same call return value, same property / derived behaviour, same input/boundary**; if the association cannot be proven, keep the original finding and a `possible_existing_assertion` hint.
- Change the assignment to test blocks to syntax/AST (at least for the main JS/TS/Python/Go) or conservative parsing: nested `describe`, inner `test`, parameterized tests, helper functions, and skipped assertions should have explicit boundaries.
- Anchored regexes must check constraint strength, not just the head and tail anchor characters; `^.*$`, `^.+$` (still broad results), and `^\s*$` should be evaluated by the target semantics. The rule had better say "an exact check exists in the same test, human judgment needed", rather than directly assuming the same behaviour is protected.
- A frozen oracle A/B set: FPs originating from Hono/Flask/Cobra must decrease, while the above authorization counterexample, different-parameter calls, different test blocks, assertions that only an error does not exist, and TPs where a boundary is weakened are kept.
- For each demotion, output the rule id, original confidence, new confidence, associated references, and a verifiable reason; report FP removed and TP lost over the same cohort, not just the total alert decrease.

Evidence: [#345 open PR](https://github.com/Mira190/SpecGuard/pull/345), [`src/audit-post.js` main (without this rule)](https://github.com/Mira190/SpecGuard/blob/08d2c5b/src/audit-post.js).

---

## 3. Problems remaining on the main branch: ordered by business harm, not by ease of code change

### P0-A: False negatives must not silently disappear because of "confidence rules"

**Current state:** the publisher already has gates such as baseline/sibling/symbol, quote, counterexample, and test-file matching; these mechanisms do reduce noise, but may fold legitimate gaps into Details. #345 aggravates this risk. The existing `audit-post.js` only needs a baseline file somewhere in the repository to exceed **200** to possibly lower the confidence of **all** `missing_test`; this rule is clearly defined in code, but the existence of a baseline does not prove this behaviour is covered.

**Recommendation:** every gate must pass a labelled counterfactual eval: `demoted_invalid` (good), `demoted_valid` (bad), `retained_invalid` (bad), `retained_valid` (good). The promotion threshold should forbid TP loss on high-risk behaviours beyond a pre-registered threshold. Record both raw and delivered recall.

### P0-B: Test matching is still the largest semantic gap

The header of `test-map.js` states explicitly: file stem, token, name, and directory rules, **not** per-language import/call-chain resolution; when the same feature is covered indirectly by a public entry point, DI, wrapper, integration helper, fixtures, snapshots, or dynamic registration, a matching failure leads to a wrong `missing_test`.

In the historical third-party re-check of the 8 model findings on the old version, 6 were false positives because the tests were not found; this metric cannot represent the latest product precision, but directly points to the currently most valuable direction for improvement:

- JS/TS: build an import/export/re-export, CommonJS, and test-reference graph of bounded depth (e.g. 2-3); identify the module's public entry points and aggregate "the reachable tests of a unit".
- Python: package exports, fixtures, parametrize, factories, monkeypatch, and framework test client entry points.
- Go: package / receiver / public API, table-driven cases, and helper references; do not misjudge a test without a direct function name as lacking coverage.
- Multi-level: a `test coverage claim` must indicate whether the evidence is a **direct assertion**, a **proof chain through a wrapper**, or **name/text similarity**. Only the first two can support a strong affirmation of "already tested".

There is no need to immediately do exact inter-procedural program analysis for all languages. First build an evidence-graph MVP for the 3 main languages / frameworks, so that retrieval quality can exceed the string heuristic on curated benchmarks.

### P0-C: Do not conflate the three dimensions `covered`, `complete`, and `unknown`

The existing `audit-post.js:884–912` records many details with cutUnits, unsure, unseen, and incomplete, which is the right direction; but product-level users seeing "43/43 units" can easily read it as protection having been verified. It is recommended to split the status into:

```text
Execution: COMPLETED / FAILED / TIMED_OUT
Evidence: COMPLETE / PARTIAL / UNREACHABLE
Decision: GAP / NO_GAP_WITH_PROOF / UNKNOWN
Delivery: ACTIONABLE / INFORMATIONAL / SUPPRESSED
```

Only evidence that points at the behaviour and an assertion allows `NO_GAP_WITH_PROOF`. With no model finding and merely "the unit was fully scanned", it must be `NO_ACTIONABLE_FINDING`, not "fully covered". On the first screen of the scan summary, give an explicit denominator: eligible files/units/parts, tests actually completely visible, tests only partially read, unreached, unanswered docs.

### P1-D: There is still a gap between real model-finding quality and deterministic static signals

The historical third-party evaluation (2026-10-17 baseline) says: 40 seeded new leads produced **21/40**, but only **11/40** were visible; among them the deleted-boundary-value cases were **0/10**. The early Kite full-repo seeds were detected by the model at **2–3/8**, and the newly added all and packed coverage did not automatically improve the test-deletion seeds; this result shows that **capability (detecting the correct gap) may still be the bottleneck**. The static lead output and quotas have since been iterated, and these historical numbers must never be packaged as the precision of the current latest version.

It is recommended to first have the static layer do exact and verifiable facts: which specific assertion was deleted/weakened, which new values/branches have no corresponding condition seen, and whether previously existing test evidence has now disappeared. A static lead "export not directly mentioned by any test" should be ranked informational, not confirmed gap.

### P1-E: Real eval should still guard against "self-testing, self-proving"

The project already has improvements in `eval/grade.js` such as `tp_delivered`, `strict_pass`, and end-to-end denominator handling for error samples (visible in the current source); this is better than only looking at the aggregate pass as before. But still needed:

- an independently frozen `oracle.json`, which the model/publisher must not read for the answers;
- the same target head SHA, SpecGuard SHA, model version, token budget, seed or multiple repetitions, and the same prompt/config;
- **Clean PRs** and negative samples with existing replacement tests must be regressed together with the positive seeds;
- raw TP, verified TP, and delivered actionable TP kept separate; FP needs human semantic adjudication, not just line-number proximity;
- compute `precision`, `delivered recall`, `FP / 100 PR`, `unknown rate`, `median/P95 runtime`, and spend;
- do not pass multiple variants of the same code change off as multiple independent business scenarios; cluster confidence intervals by original PR/behaviour;
- CI green is only a protocol regression gate; **prod readiness** is listed separately as a model-quality gate.

**New important constraint:** any PR fixing a publisher gate must provide new **TP lost / FP removed / Unknown changed** columns; "weak alerts down 40%" is not accepted as the sole success criterion.

### P1-F: Windows smoke, cross-repository permissions, and artifact isolation

The test for #344's Windows `bashPath` is a parameter-passing mock: it can verify path derivation but cannot prove installation-mode coverage on an independent runner (Git Bash, WSL PATH, MSYS, paths with spaces). On a Windows work machine it would be best to add a minimal Git checkout + real `collect.sh` smoke; CI can use `windows-latest` to run only a boundary subset.

For cross-repository PR / full-repo use, the GitHub Action may package source, documentation, and test fragments to an external model; from an enterprise user's perspective, the permission boundary, which paths may be output, artifact retention / read permissions, and a policy of disabling reading secrets or key files must be made explicit. The current pack has path realpath restrictions and avoids reading `.env`/keys, which are strengths; but **"the path is not `.env`" does not mean the file content contains no secrets**. It is recommended to let organizations configure deny globs and data domains, and provide a preflight privacy manifest (showing only paths and categories, not recording secret content).

Some real Kite workflows upload the whole `.specguard-ctx` as an artifact; that is acceptable in a public test repository, but for an enterprise target repo one must restrict who can download it, how long it is kept, and whether it contains unredacted source fragments. The manual workflow already has named results artifact control; promote its minimization idea first.

### P2-G: Maintainability, performance, and scope UX

- The core `post.js`, `audit-post.js`, and large test files carry many responsibilities; it is recommended to separate provenance, evidence gates, render, state, and artifact writer **around a stable schema**, rather than blindly rewriting the whole module.
- Avoid drift between the slice simulation in `claude-api.js` and the pricing strategy logic in `audit-units.js`: export a unified `estimatePack(unit,tests)` and provide an `estimated/actual bytes` reconciliation; key behaviours must be consistent.
- Use finer `review_paths / evidence_paths / requirement_paths` UI labels to explain the real scope of `scan_paths`; avoid users thinking only the tests/docs inside the directory are scanned.
- Strengthen the version matrix of local/external dependency environments: Node 22, Git for Windows, GitHub API rate limits, read-only permission for fork PRs, token expiry, workflow cancellation, and concurrency.

---

## 4. Minimum experimental requirements for a "positive optimization": a recommended fixed evaluation contract

### 4.1 Fixed task sets

**Set A — deterministic protocol (run on every PR, low cost):** directory anchoring, boundary file paths, malicious instruction text and quote, call-part attribution, unknown usage, repair, truncation completeness, dedup, output size, execution status, fallback, Windows environment.

**Set B — model capability with an oracle:** at least 5 kinds of gaps: deleted tests, weakened assertions, deleted boundaries, requirement/code drift, test-level pushdown; each kind must have negative samples such as a clean PR, indirect tests still present, and unrelated sibling assertions. Across Nest/Hono/Fastify/Flask/Cobra/Kite, run quickly with small fixtures; for cases where the model fluctuates, repeat the same model several times per version and report the distribution.

**Set C — real delivery:** real developer PRs, sampling no-alert PRs for independent FN review; record the reasons the author considered a finding valid/invalid, whether tests were actually added, whether the tests could fail before the fix, whether rework was reduced, and the review delay caused.

### 4.2 Metrics and definitions (recommended)

| Metric | Formula / criterion | Why needed |
|---|---|---|
| Raw defect recall | Share of oracle positives that were generated as candidates | Isolates model detection |
| Delivered actionable recall | Share of oracle positives delivered as actionable and semantically correct (including losses from execution failures) | Actual user protection |
| Actionable precision | Actionable findings validated by independent labelling / all actionable findings | Controls false-positive burden |
| TP lost from gate | Number of valid findings that were actionable before the change and became non-actionable | Prevents #345-style regressions |
| FP removed by gate | Number of invalid findings that were previously actionable and are now suppressed | Proves the gate's net value |
| Decision abstention | UNKNOWN / eligible obligations | Prevents beautifying accuracy by refusing to judge |
| Evidence completeness | Units with code + necessary tests + requirements completely loaded / eligible | Isolated from model capability |
| Verified fix-through | Among valid findings, the share where an added test confirms the fix | Measures Shift Left |
| Cost/latency | USD, tokens, wall time median/P95 per run, failure rate | ROI and scale |

`pass rate` must not be taken as precision; "touched code" must not be taken as a verified fix; `precision × acted_on_rate` must not be taken as the joint effective-fix rate. When the denominator is 0 or labels are unknown, explicitly output N/A and the sample size.

### 4.3 Pre-registered PR quality thresholds (adjustable candidate values)

The following are **engineering thresholds suggested for the next batch of experiments**, not a claim of results SpecGuard has already achieved:

- Protocol Regression: all deterministic CI and negative samples pass; there must be no high-confidence finding of unknown origin, no out-of-bounds reference, and no claim of complete when evidence was not fully read.
- Gate changes: any TP loss on a high-risk positive must be explained; on a small frozen oracle, by default `TP lost = 0` and `FP removed > 0` are required before automatic merge. If there is a value trade-off, an explicit product decision is required.
- Retrieval: under the same candidate budget, Hit@3, All-required@3, and correct test path / call-chain recall **must not drop significantly**, and newly added FP and scan cost are recorded.
- Real adoption: continue to use the pre-registered thresholds in the existing `docs/validation-plan.md` (e.g. precision ≥65%, the threshold for verified fixes, etc.), but first unify the exposure cohort, maturity window, and labelling standard; results under the old definition must not be compared directly with the new definition.

### 4.4 Procedure for confirming an optimization is net positive

```text
Lock target/tool SHA, oracle, model, budget, and configuration
→ Baseline run, save raw/verified/delivered/ledger
→ Replace only one changed version
→ Paired run on the same tasks
→ Blind annotation of the delta findings
→ Look at TP gained / TP lost / FP removed / FP added
→ Review completeness, spend, latency, failure rate
→ Merge only if the pre-registered thresholds are met; otherwise revert or reduce feature exposure
```

To guarantee "the same conditions", branch seeds and model nondeterminism should also be considered; three re-runs of the same scenario are not three independent business samples.

---

## 5. Recommended development roadmap (directly splittable into Issues/PRs)

### P0 (immediately, before merge)

**P0-1 Review #345's `pinnedInTest`, do not merge automatically.**

- Change: downgrade only on pinned evidence with the same subject + same input behaviour; without sufficient association, hint rather than suppress.
- Tests: the authorization/metrics fields being unrelated; independent calls with different parameters; nested `it`/`describe`; `/^.*$/`, `/^Deno!(\\r?\\n)?$/`, Python/Go assertion idioms; `not a gap for X but Y...`.
- KPI: at least fix the original Hono/Flask FPs, with **0 of all frozen high-value seeds** getting new misses; every demotion carries a reason.
- Counter-evidence: if the same subject cannot be reliably determined, fall back to an informational note "may already be verified by other assertions in the same test", and do not lower confidence.

**P0-2 Build a "finding-level stage ledger + collateral-damage report".**

- Fields: `repoSha, toolSha, mode, caseId, obligationId, unitId, callId, partSpans, sourcePath, evidencePath, relationType, packedLines, rawFinding, gateRule, gateOutcome, deliveryChannel, oracleLabel, verifiedFix`.
- Tests: the same finding has a stable id at every step from raw output to Summary/Inline/Details, and anomalies / trimming are recorded explicitly.
- KPI: on the oracle task set, raw/delivered TP/FP/FN can be fully reconciled, `unknown` has an explicit reason; a baseline vs new-version difference report can be generated automatically.

### P1 (next 1–2 iterations)

**P1-1 Evidence graph MVP (JS/TS first).** Build multi-hop paths from test calls → public API → export/re-export → implementation behaviour, and give each edge a strength marker (resolution-certain / text-heuristic). Accepted interface: input source code and test set, return `test -> module/symbol -> behavior -> assertion` paths with provenance; complete runtime coverage inference is not required.

**P1-2 Re-evaluate the new CommonJS leads.** Blind-label real test gaps on the newly added CJS leads at fixed commits of Fastify, Hono, Nest, and Kite; group by "has a direct test / covered through an entry point / needs no separate test / real gap / uncertain". If most are false gaps, keep them at informational level and distinguish in the report "direct symbol reference absent" from "no coverage".

**P1-3 Large-file slice coverage verification.** Test blocks spanning 80 lines, helpers outside the test, nested/parameterized, file larger than the cap, the same test used by multiple units, sharing between parts. Verify that the slice's `complete` only means **syntactic block visible** and not "behaviour coverage complete". Record the number of test blocks actually loaded and necessary evidence misses.

**P1-4 Windows real smoke + API fault injection.** Run on Windows Git Bash/WSL/paths with spaces; GitHub 403, 429, repo missing permissions, branches containing `/`, token expiry and workflow cancel; these must not be silently treated as no gap.

### P2 (subsequent 2–4 iterations)

**P2-1 Bidirectional requirement-to-behaviour traceability**: requirement paragraph → implementation → branch/exception → corresponding assertion and test level; support locating affected requirements in reverse from the diff. The report must distinguish clearly: requirement not found, not parsed, version mismatch, and confirmed inconsistency.

**P2-2 Turn full-repo static leads into actionable obligations at PR time.** The full-repo scan can keep an evidence-based informational tech-debt inventory; when a PR changes the related behaviour, carry stable obligation IDs into the PR, giving specific wrong inputs, failable test skeletons, and test-level recommendations. The focus is on reducing pre-merge rework, not generating longer periodic lists.

**P2-3 Performance/cost**: close the loop on `estimated/actual bytes`, tokens, and failure rate for packing and slice estimation; cache repeated module summaries by content hash; diagnose the bottleneck before changing `max_output_tokens`, the cap, or the model tier. Saving tokens must not come at the price of dropping necessary evidence.

**P2-4 Pilot**: in the same class of team/repository over the same period, compare `native code review`, `native + SpecGuard`, and optionally `SpecGuard only`, with equal human effort. Decide on independent valid findings per hundred PRs, verified added tests, author disturbance, and waiting time, rather than "the total number of tests we have run".

---

## 6. Acceptance checklist (can be pasted directly into later PR templates)

```markdown
### Claim
- [ ] Describe the specific behaviour improved, not just "improves quality"
- [ ] State the impact boundary of this change: scan/pr/both; language/engine; publisher/collector/model

### Evidence
- [ ] Fix old SHA, new SHA, target SHA, model, prompt, budget
- [ ] At least one positive counterexample that fails on the old version and succeeds on the new
- [ ] At least one negative counterexample that succeeds on the old version and must also succeed on the new
- [ ] Report the delta of raw/delivered TP/FP/FN and Unknown; when there is no oracle, state "not measured"
- [ ] Every reference gives file, line, source call/part, and verification method

### Safety and correctness
- [ ] Evidence not loaded cannot be claimed as a confirmed gap/coverage
- [ ] Any gate's TP lost has been checked and explained
- [ ] Error/timeout/budget/config failures cannot masquerade as no alerts
- [ ] Validated on mainline CI + a real target end-to-end run

### Resources and rollout
- [ ] Cost and total time are compared
- [ ] Whether the reduction in alert count is because valid findings were suppressed has been tested
- [ ] If metrics miss the threshold, a revert / feature-flag plan exists
```

---

## 7. Final judgment on "has it gotten better recently"

### Parts confirmed better

- Less likely to mistake tests that were already fully shown in some call for truncated ones (#343), avoiding many meaningless unsures;
- Less likely to disguise unevaluated documentation as non-requirement, or pass off a cross-call reference as this call's evidence (#335/#340/#344);
- Scope input is safer and more predictable, and repair / unknown usage better respect the budget (#336/#342/#344);
- Mainline unit regression tests cover a wide range and currently pass; the real scan flow can fully execute large batches of unit calls on complex third-party repositories.

### Parts not yet proven better

- **Semantic recall** on real untested behaviour;
- Actionable precision that is useful to real developers;
- The ability to turn high-confidence static facts into conclusions that definitely need a new unit test;
- The ability to discover gaps corresponding to counterfactual conditions / boundary requirements and component interactions;
- Whether authors therefore write tests that first fail and then pass, and whether PR / delivery cycles get shorter;
- Stability across multiple languages, large-scale indirect tests, and enterprise permission scenarios.

### Regressions that definitely warrant vigilance

- **#345: it has deterministic counterexamples, is not merged, and is not recommended for merge as it stands.**
- **#344 CommonJS: there is historical net-negative experience with the same kind, and the new leads must be re-reviewed against release value.**
- **#341/#343 coverage numbers: if marketed as "verified unit test coverage", that is an interpretive regression, not a benefit measured in code.**
- **Over-conservative gating: while reducing FP it may swallow real TP; gate-level counterfactual proof is needed.**

**Overall verdict:** SpecGuard is growing from "an Action in which an LLM reviews code" into "a test-obligation discovery system with protocols for evidence attribution, scope, state, and cost"; the engineering foundation has clearly progressed. But it cannot yet be said that "in real development it consistently provides more correct and executable test gaps than native Review". The most valuable next optimization is **not to add another broad static rule**, but to bind every finding to a more complete behaviour evidence graph, and to use experiments with ground truth to prevent precision optimization from hurting recall.

---

## 8. Verification evidence and limitations (auditable)

**Actually verified in this review:**

- The GitHub default branch is main, HEAD=`08d2c5b`; PRs #343/#344 are merged, PR #345 is Open, and the above PR descriptions/changes and the related current code were inspected.
- [`CI 39085373622`](https://github.com/Mira190/SpecGuard/actions/runs/39085373622): actual log 1480, 1476 pass, 0 fail, 3 skipped, 1 TODO; test job success, dogfood skipped.
- [`PR345 CI 39084816569`](https://github.com/Mira190/SpecGuard/actions/runs/39084816569): 1478, 1474 pass, 0 fail, 3 skipped, 1 TODO; dogfood success, but a reduced-review warning.
- [`Kite 39083946253`](https://github.com/Mira190/Kite/actions/runs/39083946253) (Nest), [`39083944276`](https://github.com/Mira190/Kite/actions/runs/39083944276) (Hono), [`39083942363`](https://github.com/Mira190/Kite/actions/runs/39083942363) (seeded Kite): each job success, review plan 489/489, 172/172, 43/43 units, publisher `STATUS: incomplete`.
- For the same-test / anchored-regex logic in the unmerged #345, the above two kinds of wrong-downgrade conditions were independently reproduced with a minimal local Node 22 test.

**Claims from PRs / historical documents, not independently re-run:** the PR #343 five-repo forced before/after counts, total call counts, and costs; the real TP of the latest Kite seed; the earlier Fastify #269 CJS 5/5 indirect-coverage sampling; the 2026-10-17 40 seeds and 8 old model findings. They are treated as sourced historical evidence, not as precision independently measured today.

**Not done:** the current runtime environment cannot clone GitHub repositories over the network, so the new version was not fully checked out locally to run all tests or a new model A/B; all findings in every latest Action artifact were not independently extracted and blind-labelled; the real permission policy of enterprise private repos was not examined, and no longitudinal observation of real users' fix behaviour was made. Therefore the conclusions of this document fall into four classes: "provable from source", "provable from Actions", "claimed by old reports", and "needs further experiment", and a subjective high score is not used to substitute for unmeasured capability.

**Core references:**

- [Repository](https://github.com/Mira190/SpecGuard) · [#343](https://github.com/Mira190/SpecGuard/pull/343) · [#344](https://github.com/Mira190/SpecGuard/pull/344) · [#345](https://github.com/Mira190/SpecGuard/pull/345)
- [Current `audit-post.js`](https://github.com/Mira190/SpecGuard/blob/08d2c5b/src/audit-post.js) · [Current `test-map.js`](https://github.com/Mira190/SpecGuard/blob/08d2c5b/src/test-map.js) · [Current `claude-api.js`](https://github.com/Mira190/SpecGuard/blob/08d2c5b/src/engines/claude-api.js)
- [Historical third-party evaluation](https://github.com/Mira190/SpecGuard/blob/main/docs/third-party-scan-eval-2026-10-17.md) · [Metrics review](https://github.com/Mira190/SpecGuard/blob/main/docs/shift-left-metrics-and-latest-review-2026-10-17.md) · [Goal-completion review](https://github.com/Mira190/SpecGuard/blob/main/docs/goal-assessment-2026-10-17.md)

*This report is a review and implementation recommendations; it contains no code changes or GitHub write operations.*
