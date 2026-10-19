# Privacy cleanup and SHA migration decision — 2026-10-18

Decision: remove identified copied private-pilot source from the current public tree, using synthetic regression inputs where needed. Do not rewrite published history now. Historical copies remain accessible; this is not a completed confidential-data purge.

The earlier two-JSON-path rewrite rehearsal is insufficient for this expanded scope and must not be used for a remote push. The current cleanup additionally replaces two copied diff fixtures, removes source excerpts from pilot review documents, and reconstructs the delegate-wrapper regression example. Historical analysis links remain provenance, not newly verified product claims.

## Dependency migration required before any rewrite

The inventory found 81 workflow references across 42 repository/branch contexts: two literal full-SHA uses and 79 branch/tag uses. It covers all branch workflows in the accessible pilot mirror and current SpecGuard workflows, not unknown third-party consumers. The per-branch inventory is kept locally because it contains private repository metadata.

| Consumer | Required update before cutover |
|---|---|
| `.github/workflows/specguard.yml`, `# specguard-pin` | Publish a clean action commit first; run `node bin/pin-reusable.js <new-action-sha>` and commit the updated wrapper. |
| Reusable workflow callers | Pin the subsequently published wrapper commit, not the earlier action commit. |
| Pilot workflow full-SHA pins | Replace each with the corresponding published clean action/wrapper SHA; run a canary. |
| Pilot workflow branch refs | Publish each clean branch tip and check nested pins; record old-tip/new-tip identity for eval reproducibility. |
| Reports and eval records | Preserve the originally measured SHA as provenance; append old/new mapping and tree-equivalence status. Do not silently rewrite experimental evidence. |
| README full-SHA guidance and outside users | Keep full-SHA pinning guidance; publish migration instructions and update concrete affected examples. Unknown consumers prevent a claim of exhaustive migration. |

Stage clean action and wrapper commits before changing callers. Validate callers before replacing public history. Only then address PR refs, caches, forks, Actions artifacts and old clones, including GitHub Support where necessary. GitHub garbage collection can make old SHA references unavailable; current reachability is not a migration strategy.

## Evaluation work already underway

The incident set already exists: 24 + 69 SZZ pairs, 12 confirmed in-scope replayable cases, plus clean PR controls. The missing work is a production-engine runner, not another dataset. The previous agent-as-model run is not a production baseline. Separate ongoing work is adding author-response classification and weekly author-judged noise; this cleanup does not change either implementation.

Every PR-mode behavior change should compare direct/indirect/miss, clean-PR false positives, execution failures and cost on fixed inputs and engine settings. Keep indirect separate from direct; report response coverage for author labels; silence is not approval. Retain temporal holdouts, inspect future-fix leakage and measure repeat-run variation. A passing workflow alone does not establish shift-left effectiveness: results must precede merge and describe the current head with incomplete runs visible.

This privacy change is evaluated by deterministic lead/post/offline regression equivalence. It makes no claim of improved production-model recall or precision.

## Leak guard

This repository is public, so a pushed leak is already published. The checks below detect a leak; only the opt-in hook prevents one, because it runs before the push.

- `bin/leak-check.js` (run in the CI `test` job) fails on three things in tracked files: a `SPECGUARD-HONEY-` + 16 hex marker (a longer hex run also fails), a local absolute user path, and any token whose lower-cased sha256 is listed in `SPECGUARD_DENY_SHA256` (comma or newline separated hashes of private repo or project names; output is file:line and the hash, never the token). The hash list lives in a repository secret of that name; when unset the denylist check is skipped.
- Honey markers are planted only in the owner's pilot repo Kite. Other target repos are read-only analysis targets and carry none. A marker catches verbatim copies only, which is why the hashed denylist exists for names and identifiers.
- The Gitleaks workflow scans a PR's commits and pushes to any branch with gitleaks; run it by hand (workflow_dispatch) for a full-history scan. `.gitleaksignore` lists the 46 verified false-positive findings (commit SHAs and hashes in evidence docs, fake tokens in tests) by fingerprint, so a new secret in the same files is still reported.
- Prevention is opt-in per clone and is zero until a clone runs `git config core.hooksPath .githooks` (the owner's call). Then `.githooks/pre-push` scans the added lines of every commit being pushed (so a leak added and later deleted is still caught) with the leak check and, when gitleaks is installed, gitleaks on the same range (it prints a note and skips gitleaks otherwise).
- The hook cannot see the repository secret, so put the denylist hashes (one sha256 per line) in the untracked file `.git/specguard-deny` of each clone (per clone, never committed; located with `git rev-parse --git-path specguard-deny`, so worktrees share it). The leak check reads it in addition to `SPECGUARD_DENY_SHA256`. A name is matched whole and inside paths, URLs and kebab or snake names (1 to 3 adjacent parts).
- History: 79 local username paths in 9 files were replaced with `<local-user-dir>` in the working tree only; they remain in git history. The full-history gitleaks run checks secrets, not paths, so it does not cover them. Rewriting history is the owner's decision (see the migration steps above).