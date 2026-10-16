# SpecGuard: first-principles follow-up review (2026-10-16)

Baseline: main `ee1c158` (PR #196). Source-inspection review; no tests or paid-model runs were executed in this session. Previous PR #189–#195 fixes are not treated as unresolved defects.

## Product invariant
Shift-left is not counting tests. It is mapping **observable changed behavior → falsifiable obligation → executable assertion → trustworthy conclusion**, while honestly reporting unavailable context. Private helper extraction should not change the obligation count.

## Priority findings and experiments

### P1: Weak-test counterexamples have no semantic validation
`src/post.js` `counterexampleOk` checks only length (20 non-whitespace characters) and a digit/quote/arrow. This establishes formatting, not that the purported incorrect behavior passes the existing assertion. The 2026-10-15 handoff also calls F04 shape-only.

**Test:** paired counterexamples, one actually accepted by the old assertion and one rejected. The latter must never yield a *verified* high-confidence weak-test claim. Keep arbitrary target-code execution sandboxed and opt-in; otherwise label the counterexample unverified.

### P1: Weak model output must not suppress deterministic evidence
The handoff reports Kite PR #10: a low-confidence nearby model finding suppresses a deterministic removed-assertion lead in `src/post.js`. This live observation has not been independently reproduced here.

**Test:** identical diff with zero model findings, irrelevant low-confidence finding, and corroborating high-confidence finding. Preserve deterministic provenance in all cases; deduplicate only with explicit evidence linkage.

### P1: Scan inclusion differs from inventory and selection
`src/audit-units.js` uses a 40 KiB part size. The handoff records a smaller effective context-pack share and three selected Kite files that did not fit. A selected file is not necessarily transmitted or reviewed.

**Test:** budget-stress fixtures with multiple units, oversize windows and read failures. Report counts for inventory, selected, transmitted, interpreted, verified, and deferred; persist resumable progress. Never label a partial pack a complete repository review.

### P1: Assertion presence is not behavioral protection
`src/audit-units.js` computes test signals with regex and a heuristic risk factor. Such signals can rank candidates but do not prove assertions execute, cover the right behavior, or fail on a regression.

**Test:** unreachable assertion, mock-only assertion, invocation-only assertion, and meaningful result assertion. Keep file-name and path matches constant. Require a distinct evidence tier for each.

### P2: Version fingerprints may miss transitive invalidation
The handoff says F06 fingerprints cited files and relies on git history. A requirement, shared helper, or imported dependency can change without changing cited lines.

**Test:** mutate only a dependency or requirement. Previously covered status should become stale or require revalidation when dependency closure cannot be established.

### P2: Standards and pushdown still need real canaries
The handoff explicitly lists F11 live canaries and the pushdown positive case as incomplete. Run a standards violation plus clean control, then a test moved from integration to unit without changing the fault set. Distinguish discovered standards from actually executed checks.

### P2: Seeded recall is not real-world precision
The handoff reports 9/10 seeded targets visible, with one variable-model run per PR. `docs/validation-plan.md` separates this from blind precision and fix-through. Do not enable blocking from seeded recall alone.

**Test:** blind-label real PR findings; track false positives per PR, severity, actionable acceptance, incremental value over native Copilot, model/build version, cost, and completeness.

## Unknown-unknown probes (hypotheses, not confirmed defects)

| Metamorphic change | Expected invariant |
|---|---|
| Extract or inline a private helper | Same observable obligations |
| Add an unrelated test or fixture | Existing gap does not disappear |
| Truncate context or fail to read a file | Completeness drops visibly |
| Paraphrase a model finding without changing evidence | Confidence does not rise |
| Change a shared dependency only | Historical conclusion is revalidated |
| Publish private-source evidence to a public report destination | Publication denied |
| Duplicate a summary finding | One observation counts at most once |

## Suggested order

1. Preserve deterministic leads and honest context accounting.
2. Separate demonstrated, statically supported, model-proposed and unknown evidence.
3. Add metamorphic and mutation-based fixtures to CI.
4. Complete F11 and pushdown live canaries; pin action/model revisions.
5. Conduct blind real-PR evaluation before any blocking deployment.
6. Improve dependency-aware stale-state detection.

## Limits

This is a targeted review of current source and the 2026-10-15 handoff, not a full repository audit. No runtime reproduction, end-to-end GitHub Actions run, or real-model evaluation was performed. The handoff observations are attributed, and untested cases remain hypotheses.
