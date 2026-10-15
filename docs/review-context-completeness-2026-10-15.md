# Review follow-up: context completeness (2026-10-15)

Baseline: `d3234e34924405ebd4febd38aa2691675f0fad59` (main, PR #190 merged). Review source: `critical-shift-left-review-2026-10-15.md`, primarily F07. The previous batch's F01/F02/F03/F05/F08 changes are already present; this patch does not claim to close all remaining review findings.

## Confirmed findings and changes

1. **P1 — A bounded test slice could claim completeness while hiding the assertion.** `slices()` stopped after 80 lines but only considered budget-dropped windows incomplete. A synthetic long test whose call is at the start and assertion is over 100 lines later reproduced an empty `pack-cut.txt`. It now marks search-window truncation as incomplete and removes the prompt's claim that every relevant test was shown. Existing short-test controls remain complete.
2. **P1 — Read failures disappeared from context accounting.** `contextPack()` returned without recording a requested path when `packRead()` returned null. Missing, denied, oversized, or otherwise unreadable requested files now enter the omission list. Empty readable files remain distinct from read failures. Optional extra-tier neighbours retain their existing quiet behavior.
3. **P1 — Incomplete candidate tests could turn a scan unit into historical covered state.** The report only excluded units whose source was cut. It now excludes a unit when either its source or any matched test was incomplete; its prior age is carried rather than refreshed as reviewed. This is intentionally conservative when a candidate is only loosely related.
4. **P1 — Document windows lost their incompleteness before verification.** `windowPack()` always returned `notWhole: []`. Partial and unreadable files now propagate through the successful split calls into `scan-parts.json.blockCuts`, keyed by candidate block ID. `audit-post.verify()` downgrades absence-dependent statuses (`missing_test`, `partial`, `not_implemented`) to `unknown` for affected blocks. Positive cited evidence still uses the existing verification path. Another block's partial evidence does not contaminate a complete block.
5. **P2 — The offline engine routing suite attempted real CLI installs.** Five baseline tests failed because they inherited the action's pinned install inputs despite using fake CLIs. The harness now explicitly clears those version inputs and adds an npm stub that fails unexpected calls. Existing dedicated installation tests in `engines.test.js` and `claude-run.test.js` still cover versioned installs with their own stubs.

The implementation reuses the existing omission list, scan-parts metadata and verifier. No dependency, parser, service or new state schema is introduced. README documents the changed reporting behavior.

## Validation

Five new focused regression groups were run before implementation and all failed for the reported behavior. After implementation, the engine/context/report targeted suite passed (156 pass, 0 fail, 1 pre-existing skip). An additional run-level regression verifies that per-block omissions reach the saved `audit.json`, beyond the direct verifier and engine tests.

Environment: Linux, Node v24.19.0; CI targets Node 22. No real-model quality evaluation or paid scan was requested by this change. Full-suite command:

```sh
node --test --test-concurrency=3 src/*.test.js bin/*.test.js eval/*.test.js
```

The pre-change run produced 1050 pass, 5 fail, 2 skip, 1 todo. All five failures were in `auto-engine.test.js`, as described above. Final full suite: **1064 tests; 1061 pass, 0 fail, 2 skip, 1 todo**, exit 0 (52.8 seconds). The existing TODO is `eval/kite-fp.test.js` k2; it remains an expected unresolved weak-test false-positive case. `node eval/degrade.js`: **63/63 ok**, exit 0. Skill/instruction mirror checks and `git diff --check` passed.

## Remaining review work and limits

- **F07 remains partially open:** bounded windows are honest now, but this does not implement a cursor or guarantee progress through persistently oversized files. A unit may remain due until scope or context changes. Symbol matching is still a heuristic, not a parser or execution proof.
- The per-block guard in this patch covers split document calls. Single-call document scans and disabled packs need a separate evidence-range contract; this change does not claim universal completeness enforcement.
- **F06** historical evidence invalidation, **F09** execution/model-quality separation, **F10** external issue freshness and **F12** broader version/acceptance alignment remain open.
- **F04/F11** semantic weak-test validation, standards and real pushdown pilots require their own positive and negative controls. Offline pipeline tests cannot establish model precision or actual shift-left benefit.
- Existing carried historical states are preserved. This patch prevents a new incomplete unit review from refreshing a covered state; it does not retrospectively invalidate prior states.
