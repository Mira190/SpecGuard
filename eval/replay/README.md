# SZZ replay manifests and rubric

Implements `docs/traceability-plan.md` section 7.4.3 (WP8). Tooling: `eval/szz.js` (mine), `eval/replay.js` (prepare and finish).

## Workflow

1. `node eval/szz.js mine --repo <clone> --since <date> --gh-repo owner/name --out eval/replay/<repo>.json` lists fix candidates and blames their deleted or modified production lines. Manifests hold metadata only (shas, PR numbers, titles, signals). Never commit third-party source.
2. A human or agent validates every (bug, introducing PR) pair: set `confirmed` (true/false) and `note` on the pair, **before** any replay.
3. Classify `scope` for each confirmed pair, without seeing SpecGuard output, with the rubric below.
4. `node eval/replay.js prepare` for each in-scope introducing PR, with the PR's title and body exactly as originally written, `--trace off` and `--trace auto`. An agent writes `ctx/findings.json`; `node eval/replay.js finish` posts it through the real `post.run` against a fake GitHub and prints counts. There is no pass or fail.
5. A human grades each replay against the later fix diff (`grade`).
6. `node eval/szz.js clean` draws a seeded noise baseline of non-fix, PR-sized commits from the same window. Report findings per PR on bug-introducing versus clean PRs.

## Manifest fields

Per candidate: `fix` (sha, parent, title, date, pr), `signals`, `issue`, `report_date` (+ source), `status` (`located`, `unlocatable`, `no_introducing`), `dropped` (filter counts), `introducing[]`. Per introducing entry: `sha`, `title`, `date`, `pr`, `lines` (blamed line count), `via` (`blame` or `revert`), and the human fields `confirmed`, `scope`, `grade`, `note`, all `null` until set.

`unlocatable` means the fix only added code, so there are no lines to blame. These are counted and reported, never guessed.
`report_date_source: fix_commit_upper_bound` means no linked issue was found, so the fix date stands in for the report date.

## Scope rubric (set `scope` to `in` or `out`)

In scope (SpecGuard could plausibly see it from the PR diff, its description and the repo's requirement docs):
- logic errors, wrong condition or operator, off-by-one, wrong default
- boundary and edge-case handling
- missing or wrong validation
- error handling (swallowed, wrong type, missing path)
- requirement mismatch: code disagrees with a spec, doc, issue or PR statement
- a missing or weak test of the behaviour the PR changed

Out of scope:
- config, environment or deployment problems
- integration timing, races that depend on external systems, flaky infrastructure
- performance
- UX or visual issues
- third-party or dependency defects, platform quirks
- pure refactors or typos with no behaviour change (set `scope: "out"`, note `no behaviour`)

When unsure, mark `out` and say why in `note`. Only `in` bugs enter the denominator; report `out` counts beside it.

## Grading rubric (set `grade` after replay)

- `direct`: a finding names the defective behaviour or the violated requirement.
- `indirect`: a `missing_test` or `weak_test` finding on the exact behaviour that later broke, such that a test written to that finding would have failed.
- `miss`: neither.

Only findings on the blamed or fixed lines, or naming the same requirement, count. Record inline and summary-only findings separately. Catch rate is (direct + indirect) / in-scope confirmed bugs with a Wilson 95% interval; report nothing as a rate below 30 in-scope confirmed bugs.

## Running on the real engine

`node eval/replay.js run` does prepare, the production engine (`src/engines/claude.sh`, api mode, the env `action.yml` passes: `CTX`, `PROMPT_FILE`, `MODEL`, `MAX_BUDGET_USD`, `MAX_OUTPUT_TOKENS`, `TIMEOUT`), and finish (real `post.run` against the fake GitHub), then writes `<out>/<id>/result.json`: engine status and notes, cost, and every finding (`where` inline or summary, kind, path, line, title, confidence). It needs `ANTHROPIC_API_KEY`; there is none locally, so it runs in GitHub Actions on `Mira190/Kite` (secret `SPEC`) through `eval/replay-workflow.yml` (the header says how to install and dispatch it). `node eval/replay.js plan --manifest FILE [--ids a,b]` prints the matrix.

- Bugs: `--manifest eval/replay/holdout-pairs.json` replays the introducing PR of every `replay_eligible` pair (12). Clean baseline: `holdout-clean.json` (12). Title, body, base and head come from the manifest, as originally written; the target repo is checked out read-only with full history.
- `specguard_ref` must contain this runner (it is `eval/` only; `src/` is what is scored). Compare two refs by dispatching twice and diffing the grades.
- Grade `result.json` against the later fix diff with the rubric above. Only `eval/replay/*.json` hold PR metadata; no third-party source is stored or uploaded (artifacts: `result.json`, `engine.log`, 3 days).

## Contamination caveat

All manifests here come from public repos. The model may have seen the later fix in its training data, so older fixes are suspect. Mining prefers fixes from the last few months. Report public and private pilots separately; private-repo results are the headline.

## Experiment 2026-10-18: delivery arms (no change)

Question: can more of the catches reach the PR as inline comments, or does a stronger model catch more? Replay of the 12 holdout bug PRs and 12 clean PRs, 3 repetitions per arm, strict grading by the rubric above. Arms: A haiku-5.5 (main), B `claude-sonnet-5-5` (main), C haiku-5.5 plus a temporary switch that let a non-high-confidence finding on a PR-added line go inline in a reduced review (all other gates kept).

Pre-registered rules: C becomes default if mean inline-delivered catches >= A + 1 and inline comments per clean PR <= 0.25. B becomes the recommended PR-mode model if mean catches >= A + 2, cost <= $0.05/PR and clean-PR findings per PR <= A's. Otherwise no change.

| arm | caught (of 12) | caught and inline | inline / clean PR | findings / clean PR | inline noise on bug PRs (per rep) | cost / PR |
|---|---|---|---|---|---|---|
| A | 2.67 (2-3) | 0 | 0.00 | 0.28 | 0.7 | $0.0059 |
| B | 4.67 (4-5) | 0 | 0.00 | 0.17 | 0 | $0.0998 |
| C | 2.67 (2-3) | 0 | 0.17 | 0.22 | 5.0 | $0.0061 |

Catch matrix (reps 1/2/3; X = caught): orpc-1766 B XXX; sqlglot-7054 B XXX; sqlglot-7315 B XXX, C ..X; rqlite-2318 A XXX, B .XX, C XX.; rqlite-2313 A XXX, B XXX, C XXX; rqlite-2061 A XX., C XX.. Not caught by any arm: orpc-1846, 1851, 1705, 1718, 1743, sqlglot-7097. Haiku is not stable between identical reps (the earlier baseline's orpc-1766 and sqlglot-7315 catches did not reproduce in any A rep).

Outcome: no change, and the switch was removed. C: inline-delivered catches 0 (needed 1). B passes the catch and clean-noise conditions (4.67 = A + 2, 0.17 <= 0.28) but fails the cost bound ($0.0998/PR against $0.05).

Why C's catches stayed summary-only (C catches: rqlite-2313 x3, rqlite-2318 x2, rqlite-2061 x2, sqlglot-7315 x1). Every one is a `missing_test` finding listed as "reduced review: needs high confidence and two citations" (none says "inline limit", so the REDUCED_INLINE cap did not apply, and dedup only drops repeats of already-posted comments, none here). The cited lines of rqlite-2313/2318 are the blamed lines, which the introducing PR added, so the added-line condition held. What failed is the two-citation gate: `citationsOf` counts the located behaviour plus test evidence or a linked requirement, and a `missing_test` row has no test evidence by definition, so without a requirement link it has one citation and can never go inline in a reduced review, whatever its confidence. rqlite-2061 (cited line next to the blamed one) and sqlglot-7315 (same added region) fit the same reading. This is inferred from the result files and the code, not from per-finding gate logs. Consequence: an inline switch aimed at the confidence gate alone cannot help the dominant finding kind; the citation gate would have to change, which was not pre-registered.

Side finding: tier `normal` does not guarantee a normal review. 9 of the 42 B PRs that had findings still got a reduced review because at least 25% of obligations were degraded by validation (probe: "4 of 9 obligations degraded", status incomplete). Even in B's normal reviews no finding went inline: they are low confidence and low confidence goes to the summary.

Caveats: n = 12 (below the 30 needed for a rate), 3 reps, public repos (contamination possible), one strict grader. The replay workflow now also uploads `summary.md`, `ctx/engine-model.json`, `ctx/counts.json` and `ctx/engine-notes`, so the reason for a reduced review is visible next time.

## Experiment 2026-10-18 (v2, with context pack)

Rerun of the two experiments above on the fixed runner (the engine now reads the prepared checkout: every run reports a pack, mean 19.2 files / 147 KB, none empty). Same 12 bug and 12 clean PRs, strict grading by the rubric above against the bug cards and fix diffs. Arms: A haiku-5.5 (3 reps, the corrected baseline); B `claude-sonnet-5-5` (1 rep, direction and cost only, no decision); D haiku-5.5 plus an env switch `EXP_UNTESTED_ADDED=1`, default off, 3 reps. D: in a reduced review a `missing_test` finding whose cited line the PR added and whose enclosing symbol no tracked test names (test-map `covers.symbol`) is exempt from both reduced gates (high confidence, two citations) and goes inline although low confidence; cap, anchor and dedup unchanged.

Pre-registered rule: D is adopted (switch default on) only if mean inline-delivered catches >= A + 1 AND mean inline per clean PR <= 0.25 AND mean bug-PR inline noise <= 1 per rep; otherwise the switch is removed.

| arm | caught (of 12) | caught and inline | inline / clean PR | inline noise on bug PRs (per rep) | cost / PR | pack (files / KB) |
|---|---|---|---|---|---|---|
| A | 2.67 (1-4) | 0 (0-0) | 0.19 (0.08-0.25) | 1.0 (1-1) | $0.0386 | 19.2 / 147 |
| B (1 rep) | 4 | 1 | 0.17 | 1 | $0.2381 | 19.2 / 147 |
| D | 2.00 (2-2) | 0.33 (0-1) | 0.19 (0.17-0.25) | 0.33 (0-1) | $0.0388 | 19.2 / 147 |

Catch matrix (reps 1/2/3; X = caught; ids only): orpc-1705 A .X.; orpc-1718 D ..X; orpc-1766 A .XX, B X; sqlglot-7315 D .X., B X; rqlite-2318 A .XX, D XX., B X; rqlite-2313 A XXX, D X.X, B X. Not caught by any arm: orpc-1846, 1851, 1743, sqlglot-7054, 7097, rqlite-2061. Two A runs (rqlite-2318 rep 1, rqlite-2061 rep 3) ended with engine status failed and count as misses.

Decision: D not adopted (0.33 < 0 + 1); the switch was removed. The switch never fired: no low-confidence inline comment appeared in any D run. On the bug PRs the cited symbol is usually named by an existing test (checked for rqlite-2313: `TableColumnTypes` is referenced in `db/db_common_test.go`), so "no test names the symbol" is the wrong signal for these bugs, which are wrong behaviour inside a tested function. D's single inline catch (orpc-1718) was a high-confidence `spec_mismatch`, unrelated to the switch. Sonnet: 4 catches in one rep is inside haiku's range (1-4), at 6 times the cost, so no model recommendation follows.

What the context pack changed against the diff-only runs above: haiku's catches are about the same (2.67), cost per PR is 6.5 times higher ($0.0059 to $0.0386), clean-PR findings rose (0.28 to 0.36 per PR), and inline noise on bug PRs rose (0.7 to 1.0). Catches moved between PRs: with the pack haiku found orpc-1766 and orpc-1705 in some reps, and lost rqlite-2061 (the findings there now point at the callback error counter, not the conversion-error counter). Sonnet's earlier sqlglot-7054 catch did not reproduce.

Lenient sensitivity (borderline findings that name a nearby behaviour but not the defect, not counted): sqlglot-7097 (empty-pattern branch untested, without flags; A reps 1 and 3, D rep 2, B), orpc-1851 (stacked-schema failure path; D rep 2, B), rqlite-2061 (error branch of the update hook; B). Counted with a note: orpc-1718 D rep 3 (names the defect on `procedure-utils.ts`, not on the fixed `router-utils.ts`) and rqlite-2318 B (weak_test on the test file naming the double-quote escaping).

Caveats: n = 12 (below 30), 3 reps, public repos, one strict grader, haiku is not stable between identical reps (A caught 1, 4 and 3 PRs).
