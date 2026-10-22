# Pilot: Kite (2026-10-13)

Repo: `Mira190/Kite` (private; Electron/React/TypeScript, `node --test`, `docs/design.md` product design spec, no instruction files, no lint). Engine: Copilot via `GITHUB_TOKEN` on a personal repo, `model` unset (auto). Action ref: `Mira190/SpecGuard@fix/run-integrity`. Docs were translated to English before PR #2 (target repos are English).

The "developer" who answered review comments was a Sonnet agent told to address them. Fix-through numbers below are therefore mechanism checks, not evidence of real developer behaviour.

## Runs

| # | Where | Head | Result | Model | Tokens in (cached) / out | Credits | API time | Inline |
|---|---|---|---|---|---|---|---|---|
| 1 | PR #1 (Chinese docs) | b770b4f | complete | n/a (before usage line) | n/a | n/a | n/a | 3 |
| 2a | PR #2 | cacf01f | **no JSON in output** (266 s spent) | auto | n/a | n/a | n/a | 0 |
| 2b | PR #2 rerun | cacf01f | complete | auto | n/a | n/a | n/a | 1 |
| 3a | PR #2 | 09a09b9 | **invalid JSON** (`coverage[9].alignment` missing) | gpt-6-luna | 386.5k (310.1k) / 36.2k | 3.08 | 6m07s | 0 |
| 3b | PR #2 rerun, all fixes | 09a09b9 | complete | gpt-6-luna | 108.9k (62.5k) / 36.0k | 2.44 | 5m14s | 1 |
| A | Audit, master | cca5965 | complete, issue #3 | gpt-6-luna | 1.25M cache read / 32.6k | 5.10 | n/a | n/a |

Copilot cost is an estimate: 1 AI credit = $0.01, so a PR review was about $0.02-0.03 and the audit about $0.05 on auto routing.

## What worked
- Run 1's three inline findings were all valid: repeating-plan re-arm untested (high value), weekday month rollover (nit), weekday toggle persistence (valid, low actionability without component tests). All three were addressed in the next push.
- After WP-F, run 3b turned every changed block of `docs/design.md` §4.5 into an `S*` criterion and traced each to code and tests. "Starts on wake" was correctly `not_verifiable` (runtime behaviour).
- Fix-through: the run-2 finding was labelled `addressed` (anchor changed, not reported again).
- "npm test passes" went to `not_reviewed` instead of becoming an obligation.
- The citation verifier caught a real misquote (C4, a quote missing `=== 7 ? '每天重复' :`).
- The audit extracted 48 requirements from §1-4 (capped, the rest listed under not reviewed). Of the 5 `contradicted` rows, 3 were checked by hand and are real doc/code drift: main window height 800 vs 740 in the spec; recording list has no default selection; the completion notification has no Play / Show in folder actions.

## What did not
- **JSON contract under auto: 2 of 5 PR runs failed** (no JSON; missing required field), wasting the whole run. Fixed by the repair turn (WP-E); not yet observed live.
- **Requirement docs missed twice**: a descriptive `docs/design.md` fails the density rule (3 normative sentences in 27 KB). Fixed by the spec-like filename rule plus changed-block criteria; `docs/architecture.md` and README stay rejected and are listed as rejected candidates.
- **Threads cannot be auto-resolved with the default `GITHUB_TOKEN`**: `resolveReviewThread` returned "Resource not accessible by integration". Granting `contents: write` was not tested (left to the owner).
- Run 3b re-raised the repeat re-arm gap at the app wiring (the app-layer logic that restarts repeat scheduling) after the logic moved into a unit-tested pure function. Arguably still valid (the wiring is untested), but it risks reading as nagging.
- Model and effort could not be pinned: the local account offers `auto` only, and `auto` rejects `--reasoning-effort`. The owner will test on a company plan.

## Open
- Repair turn, model pin and effort on a paid plan (owner's device).
- Thread resolution permission.
- Real developer fix-through and 👍/👎 data: needs human-authored PRs over 2-4 weeks.
