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
- Validity: `result.valid` is true only if collect succeeded and was not skipped, the engine exited 0 (`engine_exit`), `engine_status` is `success`, `findings.json` exists, and (when the PR changed files) the engine notes carry `context pack: N files` with N > 0, and the publisher status is not `failed`. Otherwise `invalid_reason` says why and the job fails after writing `result.json`. Invalid runs count as misses in the end-to-end catch rate; conditional catch is over valid runs only.
- Input parity: the replay serves only the PR title and body. Linked issues are empty (`closingIssuesReferences: []`) and `gh api` returns `[]`, so results are for "PR text only" requirements, not production with linked issues.
- "inline" means `src/post.js` chose inline against the fake GitHub in `eval/local.js`. It is not a GitHub-accepted comment and nobody saw it.
- The dispatch input `specguard_ref` runs that ref's code with the API secret. Dispatch only refs you trust (your own branches), never a fork PR ref.
- Grade `result.json` against the later fix diff with the rubric above. Only `eval/replay/*.json` hold PR metadata; no third-party source is stored or uploaded (artifacts: `result.json`, `engine.log`, 3 days).

## Contamination caveat

All manifests here come from public repos. The model may have seen the later fix in its training data, so older fixes are suspect. Mining prefers fixes from the last few months. Report public and private pilots separately; private-repo results are the headline.

## Experiment 2026-10-18: delivery arms (no change)

> Correction: this experiment and the baseline before it ran with an EMPTY context pack (every result's engine notes read "context pack: 0 files, 0 KB"). `runEngine` started `claude.sh` with cwd = `<out>/<id>`, not the prepared checkout `<out>/<id>/repo`, and `claude-api.js` reads the pack from `GITHUB_WORKSPACE` or cwd. They measured a diff-only configuration, not production, and are superseded by "Experiment 2026-10-18 (v2, with context pack)" below. `run` now sets `GITHUB_WORKSPACE` to the checkout and exits non-zero when a PR with changed files reports "context pack: 0 files".

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

## Holdout 2 (n=45 bug PRs, 30 no_known_bug controls)

Why: holdout 1 had 12 replay-eligible bug PRs, too few to see a +1 change when haiku varies by 1-4 catches between identical reps. Holdout 2 is `holdout2-pairs.json` (45 replay-eligible, confirmed, in-scope bug-introducing PRs) and `holdout2-clean.json` (51 clean PRs). `holdout-pairs.json` and the tuning sets (`pairs.json`, `clean.json`) are unchanged and no tuning pair is reused.

How the pairs were built. The 12 eligible pairs of holdout 1 (plus its one oversize confirmed pair) are carried over unchanged; the other 51 of its 69 pairs were already screened out there, and its 6 `confirmed: null` pairs are oversize (over 1200 lines), so that pool was exhausted. New pairs: `node eval/szz.js mine --since 2026-06-01 --gh-repo ...` on nine active public repos: honojs/hono, TanStack/query, trpc/trpc, vitest-dev/vitest (TS), pydantic/pydantic, pydantic/pydantic-ai, langchain-ai/langchain (Python), go-gitea/gitea, cli/cli (Go). The mined pairs were filtered to PR-mapped blame pairs with at least 3 blamed lines, the introducing PR 30-1200 changed lines and at most 40 files, a fix PR of at most 400 changed lines, one pair per introducing PR (139 pairs to review). Each pair was confirmed by reading the fix PR and the introducing PR diff and body, with no SpecGuard output available, using the confirmation and scope rubric above and "when unsure, not confirmed / out". The confirming was done by Sonnet subagents with a strict brief, not by a human, in 7 batches of about 20; notes hold no source quotes. `replay_eligible` additionally requires that the introducing commit on the default branch is the PR's squash commit (changed-file count equals the GitHub PR's). That dropped 3 confirmed in-scope pairs (cli-13449, cli-13723, hono-5373).

Counts. 152 pairs recorded (13 carried over, 139 new). Confirmed 62, of which in scope 49, of which replay-eligible 45. Confirmation rate on the new pairs: 49 of 139 (35%). Eligible per repo: gitea 9, pydantic-ai 7, orpc 6, hono 6, vitest 4, sqlglot 3, rqlite 3, langchain 3, query 2, pydantic 2 (trpc and cli: 0). Category mix of the 45: logic 27, validation 6, boundary 5, error_handling 4, requirement_mismatch 3, pure test gap 0 (a test gap is graded as `indirect`, not mined as a category). Contamination: the 12 carried-over pairs and the new ones are public; new fixes are from 2026-06 onward.

Clean controls. `szz.js clean` sampled seeded non-fix PR-sized commits from the same repos and window. Because a title and label screen is not enough (a clean PR can say "also fixes a crash", or be deps-only), every clean PR in BOTH `holdout-clean.json` and `holdout2-clean.json` now carries `control` and `control_why`, set by reading its body and diff: `no_known_bug`, `mixed_fix` (body or diff fixes something) or `non_code` (deps, lockfile, release, docs, CI only). Holdout 2 clean has 51 PRs: 30 no_known_bug, 4 mixed_fix, 17 non_code (holdout 1 clean: 7 no_known_bug, 5 mixed_fix, 0 non_code, not rerun here). A second sampling round (seed 12, body without fix/bug/crash words, title not chore/ci/docs/deps/release) topped the no_known_bug group up to 30; its mixed and non_code PRs were not replayed. no_known_bug per repo: pydantic-ai 7, vitest 7, gitea 5, hono 3, pydantic 2, query 2, cli 2, trpc 1, langchain 1. Control calls were also made by Sonnet subagents.

### Baseline (haiku-5.5, main `src/`, 3 reps, trace auto, context pack on)

Run on Mira190/Kite from `specguard_ref = eval/expand-holdout` (the manifests had to be in the checkout; `src/` and `eval/replay.js` are identical to main at 9271df2). Valid = the engine succeeded and wrote `findings.json` (an empty findings list is valid); also required: `collect_ok`, not skipped, and a context pack with more than 0 files in the engine notes. Every run reported a non-empty pack. Publisher-aware (current `post.js` on the saved answers): 283/288 valid (bug 132/135, non_code 49/51); the 3 extra invalid runs (engine ok, publisher status=failed) are hono-3787 rep 2 and vitest-10583 rep 2 ("coverage must be an array") and trpc-hclean2-3 rep 3 ("coverage[0]: invalid status"). The tables below count engine validity only (286/288); the end-to-end 9.33/45 is unchanged because failed runs were already misses.

| measure | value |
|---|---|
| bug PRs / runs attempted / valid | 45 / 135 / 132 (pydantic-ai-6890 rep 3: engine failed; hono-3787 rep 2, vitest-10583 rep 2: publisher failed; all graded misses) |
| caught (direct + indirect), per rep | 9, 7, 12 (direct 6/5/10, indirect 3/2/2) |
| caught, mean (min-max) | 9.33 (7-12) of 45 = 20.7%; 28 caught events (PR-runs) from 15 distinct PRs. CI unit is the PR: Wilson 95% on n = 45 with x = 9.33 (mean per rep, fractional) = 11.4%-34.6%; PR-cluster bootstrap 11.1%-31.1% (use this one). Wilson on pooled 28/135 would be 14.8%-28.3% and is too narrow because the 3 runs of a PR are not independent |
| conditional catch over valid runs | 28 caught events / 132 valid PR-runs = 21.2% (was 28/134 = 20.9% before the publisher check) (end-to-end 28 / 135 = 20.7%); descriptive only, PR-runs are clustered by PR |
| caught and delivered inline, per rep | 4, 3, 3 (mean 3.33) |
| PRs caught in 0 / 1 / 2 / 3 of 3 reps | 30 / 7 / 3 / 5 |
| findings per bug PR-run | 2.04 (0.38 inline) |
| cost per PR-run | bug PRs $0.0464, clean PRs $0.0285 |

Clean noise, never pooled (valid runs only):

| control | PRs | runs valid / attempted | findings per PR-run | inline per PR-run | runs with any finding |
|---|---|---|---|---|---|
| no_known_bug | 30 | 90 / 90 | 0.71 | 0.13 | 36% |
| mixed_fix | 4 | 12 / 12 | 0.42 | 0.08 | 42% |
| non_code | 17 | 49 / 51 (langchain-hclean2-3 rep 3: engine failed; trpc-hclean2-3 rep 3: publisher failed) | 0.02 | 0.00 | 2% |

Pooling all three would give 0.46 findings per PR-run and hide the difference, so only the no_known_bug row (0.71 findings, 0.13 inline per PR-run) is the noise of a code-changing PR with no known bug. Catch rate by repo (caught reps of 3 per PR): gitea 8/27, rqlite 5/9, pydantic-ai 4/21, hono 4/18, vitest 3/12, sqlglot 2/9, pydantic 1/6, orpc 1/18, langchain 0/9, query 0/6.

Grading: strict, by the rubric above, by Sonnet subagents from the bug cards, fix diffs and finding titles (path, line, where, kind, confidence), then every positive and every borderline miss re-checked against the fix diff by a second pass (2 indirect grades downgraded: query-7005 rep 1, hono-3413 rep 3). Direct grades on orpc-1718, sqlglot-7054, rqlite-2313, pydantic-ai-5020, pydantic-13890 rest on the finding text and bug card, not a full read of the fix diff. One strict grader pass; a human audit of the 28 positives is still open. Per-rep scores differ a lot (7 vs 12): rep 3 caught 5 more than rep 2.

### Audit of the baseline grades (event = one PR-run; no model calls)

All 28 caught events and all 90 miss events of the 30 never-caught PRs (plus the 17 miss events of the other caught PRs) were re-read against the fix diffs and the full `summary.md` of the run (inline-linked titles, summary bullets, Details), by fresh Sonnet passes, with my own adjudication of every disagreement. Per-event rows, delivery and reasons are in the scratch directory (`analysis/audit.json`), not in the repo.

| measure | baseline | audited |
|---|---|---|
| caught events (PR-runs) | 28 | 30 |
| distinct PRs caught | 15 | 16 |
| PRs caught in 0 / 1 / 2 / 3 of 3 reps | 30 / 7 / 3 / 5 | 29 / 7 / 4 / 5 |
| caught per rep | 9, 7, 12 | 8, 9, 13 (mean 10.0 of 45 = 22.2%, PR-cluster bootstrap 12.6%-32.6%) |
| direct per rep | 6, 5, 10 | 7, 5, 10 |

Event changes: 24 of the 28 caught events confirmed with the same grade; 2 still caught with a changed grade (rqlite-2318 rep 1 and gitea-32210 rep 3, indirect to direct); 2 downgraded to miss (hono-3604 rep 1, gitea-22610 rep 3); 4 miss events upgraded to indirect (rqlite-2318 rep 2, gitea-28691 reps 2 and 3, hono-3413 rep 3). Two PRs became caught (gitea-28691, hono-3413; the gitea-28691 upgrades are borderline) and one stopped being caught (gitea-22610: the finding named a swallowed request-build error that the fix deletes incidentally, not the fixed timeout, status and size handling). pydantic-13890 rep 3 stays direct on my adjudication (the revert restores the call the finding says was bypassed); the second pass graded it a miss.

Strict rule applied: a bug named only in a Details obligation row (Unconfirmed or needs-a-person status, no published finding) is a miss. Seven such events (vitest-9464 reps 1-3, pydantic-ai-5455 rep 1, sqlglot-7315 rep 2, rqlite-2313 rep 2, rqlite-2061 rep 3) would count under a lenient reading: 37 events, 19 PRs.

Delivery of the 30 audited caught events (judged from where the finding sits in `summary.md`; the `where=summary` label of `result.json` also covers low-confidence findings that exist only in the collapsed Details block):

| delivered | events |
|---|---|
| inline | 11 (the inline text names the bug in 5, only a nearby test gap in 6) |
| summary body (visible) | 4 |
| collapsed Details only | 15 |

So the earlier "caught and delivered inline 4, 3, 3" is 3, 4, 4 after the audit, and only about a sixth of the caught events (5 of 30) reach a reader as an inline comment that names the bug. Raw inline comment bodies were not uploaded; "names the bug" is judged from the summary entry of the same finding.

### Why the never-caught PRs are missed (30 PRs, first class that applies)

| class | PRs | meaning |
|---|---|---|
| a. grading miss | 2 | upgraded by the audit (gitea-28691, hono-3413) |
| b. found, not delivered | 3 | bug named only in a Details obligation row (vitest-9464, pydantic-ai-5455, sqlglot-7315) |
| c. bug code not in what the model saw | 3 | main fix site is outside the PR's changed files (vitest-6924, gitea-37365, langchain-33461) |
| d. in context, model silent | 22 | fix site is in the diff or a changed file |

Method for c: SpecGuard's real collector (`replay.js prepare`, no model) was run for each PR and the fix's removed lines were matched against `prompt.md`; the model also sees every changed file whole through the context pack, so a fix site counts as seen when its file is among the PR's changed files. No PR had a dropped diff (`diff-dropped.txt` empty) and no fix source file is in a pack "not included" list. Focus mode was on in 7 PRs and in each the fix site was in the focused files. Publisher drops are only partly visible because raw `ctx/findings.json` was not uploaded: the Validation notes of `summary.md` show findings dropped as "not counted" on a fix source file in 8 of the 30 PRs (orpc-1851, gitea-30156, gitea-36986, hono-2339, hono-3366, pydantic-ai-1812, langchain-33817, langchain-18592), but their text is lost, so they stay in class d. gitea-22610 (the PR that stopped being caught) is class d as well.

By bug category (a / b / c / d): logic 19 PRs (2 / 3 / 2 / 12), boundary 4 (0 / 0 / 0 / 4), validation 3 (0 / 0 / 0 / 3), requirement_mismatch 2 (0 / 0 / 0 / 2), error_handling 2 (0 / 0 / 1 / 1). By repo (never-caught / a / b / c / d): orpc 5 (0/0/0/5), gitea 5 (1/0/1/3), pydantic-ai 5 (0/1/0/4), hono 4 (1/0/0/3), langchain 3 (0/0/1/2), vitest 3 (0/1/1/1), sqlglot 2 (0/1/0/1), query 2 (0/0/0/2), pydantic 1 (0/0/0/1).

Class d is the bulk. Its causes, from reading the findings: bugs that need a cross-file invariant or intended semantics the PR text does not state (orpc-1846, orpc-1851, gitea-30156, pydantic-ai-6890), domain knowledge (JWT, RFC q-values, git trailers, DOM shadow roots, numpy comparison), and findings spent on adjacent test gaps instead of the defect; one PR (pydantic-ai-3454) got no findings in any rep.

### Power note

Question: what is the smallest change in mean catches that 3 reps per arm can tell apart on these 45 PRs? Method (simple): treat PR i as a Bernoulli with catch probability p_i, estimated by k_i/3 from the 3 reps; the unbiased within-PR variance of one rep is k_i(3-k_i)/6, and summing over PRs gives the variance of one rep's total, V = 3.33 (sd 1.83). The mean of 3 reps has variance V/3; the difference of two 3-rep means, same PRs in both arms, has variance 2V/3, sd 1.49 catches. At 80% power and two-sided alpha 0.05 the minimum detectable difference is 2.8 x 1.49 = 4.2 catches (9.3 percentage points). The observed spread of rep totals (9, 7, 12; sd 2.5) is wider than the 1.83 the model predicts (run-level effects shared by all PRs), and with that sd the figure is about 5.8 catches (13 points). So: with 3 reps a change under about 4 catches (roughly 9-13 points of 45) is not distinguishable from rep noise; the old +1 target is invisible; to see +2 catches you need about 4 times the reps (about 12 per arm: a planning estimate from the variance model, not a guarantee) or a paired per-PR test with more PRs. The simulation below puts power at 12 reps at about 50% for +2 and 80% for +3. A paired comparison on the same PRs already cancels the between-PR spread, which this estimate assumes. This is an estimate from one 3-rep sample, not a measured power curve.

Simulation (2000 runs per cell, no run-level effect modelled, so optimistic): arm A draws p_i from Beta(k_i+0.5, 3-k_i+0.5) per PR, arm B adds +delta expected catches per rep, spread either proportionally to (1-p_i) or only over the k=0 PRs; test = sign-flip permutation on per-PR mean differences, two-sided alpha 0.05, type I error 3-4%. Power by reps per arm, proportional spread (the k=0-only spread is within 3 points):

| delta (catches per rep) | R=3 | R=6 | R=12 | R=20 |
|---|---|---|---|---|
| +1 | 5% | 9% | 16% | 26% |
| +2 | 14% | 27% | 50% | 72% |
| +3 | 26% | 50% | 78% | 96% |
| +4 | 42% | 74% | 96% | 100% |

So 12 reps is a planning estimate that detects +3 with about 80% power, not +2; +1 is out of reach even at 20 reps. Use the PR-cluster bootstrap CI above for the headline, not a Wilson interval on pooled PR-runs.

Caveats: public repos (contamination possible, new fixes are recent but the model may still have seen them), one automated grader, confirmation and control calls by subagents, n = 45 is the minimum for a rate and the interval is still wide (11%-35%), tuned engine settings are those of main at run time. Total run cost $10.63 (135 bug runs $6.27, 153 clean runs $4.36); the cost guide of about $10 was exceeded by $0.63 because the control adjudication required 16 more no_known_bug PRs.

## Delivery experiment V1/V2 (holdout 2, raw answers): not adopted

Offline re-run of the real `src/post.js` on the saved raw model answers (`ctx/findings.json`, 288 PR-runs, no model call) with `replay-arms.js --engine mock-replay --arms A,NAME=ENV=VAL` (arm A = main; any other arm sets one env var for its post.js run, so a publisher experiment needs no replay code). V1/V2 showed low-confidence defect claims in the visible body.
- Faithfulness gate (arm A reproduces the published summaries): 288/288, measured at status, headline and inline-count level only (full summary-body equality was not the criterion). V1/V2 corpus (Kite runs 39120706885 to 39120735452, ref 188e2a1): 287/288 valid, pydantic-ai-hclean2-2 in run 39120735452 ("requirements must be an array") was counted valid; it is a non_code control that publishes nothing, so the deltas below and the decision are unchanged (invariance argument, deltas not recomputed).
- V1 changed 2 PR-runs: +1 visible catch event.
- V2 changed 16 PR-runs (12 bug, 4 control): +3 visible catch events in total (orpc-1766 x2, langchain-33817 x1), +1 on the 33 NEW PRs. Pre-registered bars: +5 total and +4 new, so not met.
- Control noise +0.06 per no_known_bug PR-run. TP lost 0.
- Root cause: the Details-only catches are `gated` by the partial-test-visibility gate (`src/post.js`, "a candidate test file was only partly visible"), which V2 deliberately excludes, so V2 cannot surface them.
- Decision: not adopted; the post.js arms were not merged (PR #366 closed). Next: H3 (`prereg-h3.md`, a retest on the same PR set, not an adoption test).

## Pack: changed lines before rule files (prereg-pack-changed-first.md + amendment 1): not adopted

Switch `EXP_PACK` (O, F, FC, FCH; unset = main, byte-identical) in `contextPack`; scripts in `pack-analysis/` (`lib.js` measures, `repro.js` faithfulness, `freeze.js` / `prep-fresh.js` fresh corpus, `run-arms.js`, `summarize.js`); frozen fresh list `pack-analysis/fresh-corpus.txt`. Offline, no model call. Raw outputs are outside the repo (SpecGuard-evidence/pack).

**Faithfulness (arm A against the saved runs).** Holdout 2: main's `contextPack` on the saved collector inputs reproduces the saved `pack-cut.txt` and `pack-shown.txt` on 96/96 PRs (21 PRs lose a changed line, as in the prereg; 14 of them a source/config line, i.e. neither a doc nor a test file). SpecGuard #345-#386: 38/38 PRs with a saved `pack-cut.txt` reproduce (4 have none). The first attempt reproduced 41/96; the causes were in the harness (a symlink the Windows collector had written as a plain file, and a path that changed from directory to file between two heads). The fresh corpus has no saved packs, so A is not checked there.

**Corpora.** Holdout 2: 96 PRs. SpecGuard: 42 PRs, #345-#386 (n for the gates below is 42; 35 where A loses no changed line). Fresh: step 1 of the frozen list (120 first-parent commits, 30 each of cli, orpc, pydantic-ai, vitest; the repos whose rule files exceed one file cap at the tip); 14 were skipped by the collector, so n=106. A loses a changed line on 76 of them (at least 10, so steps 2 and 3 were not needed). Those 76 sit in cli 25/25, orpc 28/29, pydantic-ai 23/24, vitest 0/28, and consecutive commits share rule files, so they are not independent.

**Gates, k/n.** "Code" = a changed file that is not a doc or a test. "Newly lost" = a changed line unseen in the arm that A showed.

| Gate | A | O | F | FC | FCH |
|---|---|---|---|---|---|
| 1 holdout, PRs losing a code line (pass: <= 7/96) | 14/96 | 0/96 | 14/96 | 4/96 | 2/96 |
| 1 holdout, newly lost (pass: 0) | - | 0 | 0 | 0 | 0 |
| 2 fresh, A-lost PRs no longer lost (pass: >= 38/76) | - | 71/76 | 0/76 | 63/76 | 64/76 |
| 2 fresh, newly lost (pass: 0) | - | 0 | 0 | 0 | 0 |
| 3 SpecGuard, newly lost (pass: 0) | - | 0/42 | 0/42 | 0/42 | 0/42 |
| 3 SpecGuard, text identical to A where rules fit one cap and are all in scope (F, FC) | - | n/a | 28/28 | 8/28 | n/a |
| 4 holdout-2 kept standards findings citing a rule the arm drops (runs; pass: 0) | - | 0/10 | 0/10 | 2/10 | 2/10 |
| 5 suite | - | 1633 tests, 1630 pass, 0 fail, 2 skipped, 1 todo (all arms share one build) |||||
| 6 no in-scope rule lost or changed where A loses no line: holdout | - | 1/75 | 0/75 | 8/75 | 8/75 |
| 6 same, SpecGuard | - | 0/35 | 0/35 | 0/35 | 0/35 |
| 6 same, fresh | - | 2/30 | 1/30 | 30/30 | 30/30 |

(Counts in the gate 6 rows are PRs that violate it; pass is 0.) FC fails gate 3 only through rule order: the sort reorders the same rules at the same byte count on all 20 PRs. F fails gate 6 once on fresh because dropping out-of-scope rules lets a rule that A showed partly be shown at another size; the same happens for O in all three cases (O: the last fitting rule is cut shorter, in one holdout PR one rule is gone, because the review files, which A did not show at all, take budget; the changed files there have only deleted lines, so A's lost rule does not count them).

**Rule cost (in-scope rules dropped relative to A, total / PRs affected).** Holdout: O 70 / 10, F 0, FC 387 / 20, FCH 387 / 20 (324 of them on the 21 PRs where A loses a line). SpecGuard: 0 for all. Fresh: O 284 / 61, F 0, FC 1679 / 106, FCH 1679 / 106. Rule bytes shown, holdout: A 4.67 MB, O 3.83, F 4.48, FC 1.82; fresh: A 20.8 MB, O 16.7, F 20.7, FC 1.77.

**Other measures (A / O / F / FC / FCH).**
- Cut-test set vs A, PRs where it grows / shrinks: holdout O 12 / 9, F 0 / 1, FC 0 / 7, FCH 0 / 8; SpecGuard O 3 / 1, others 0 / 0; fresh O 1 / 28, F 0 / 1, FC 0 / 51, FCH 1 / 51.
- "Review context was cut" notice, on to off / off to on: holdout O 5 / 1, F 0 / 0, FC 3 / 0, FCH 4 / 0; SpecGuard O 1 / 0, FCH 1 / 0; fresh O 24 / 0, F 0 / 0, FC 48 / 0, FCH 48 / 1.
- (a) PRs where one file takes over 50% of the budget: 0 in every arm and corpus. Confirmed for O as implemented: the largest block is 42152 bytes (the file cap is 41666 plus block markup) across all arms.
- (b) PRs where the review files together take over 50%: holdout A 5, O 11, F 5, FC 7, FCH 7; SpecGuard 6 in every arm; fresh A 0, O 10, F 0, FC 4, FCH 4.
- (c) PRs with an empty rule block while an in-scope rule exists: 0 for A, O, F everywhere; FC and FCH 2 on holdout, 0 on SpecGuard, 44 on fresh (the first sorted rule is larger than the cap).
- (d) The collector already drops lockfiles, generated files, snapshots, vendored and build output before `files.txt` is written: `src/collect.sh:26-28` (IGNORES: package-lock.json, yarn.lock, pnpm-lock.yaml, Cargo.lock, go.sum, `*.lock`, dist/, build/, vendor/, node_modules/, `*.min.*`, `__snapshots__/`, `*.snap`, `*.svg`, `*.pb.go`, `*_pb2.py`, `*.generated.*`, ...), applied at `src/collect.sh:90`, plus `IGNORE_EXTRA` at `:37`. Other large data files (e.g. `assets/go-licenses.json`) are not excluded.

**Decision (rule: adopt the first of O < F < FC < FCH that passes every gate): nothing is adopted.** The default is unchanged; the switch stays.
- O passes gates 1 to 5 and is the only arm that removes the loss without newly losing a line (holdout code losses 14 to 0; fresh 71 of 76 fixed). It fails gate 6 literally, on 3 PRs (1 of 75 holdout, 2 of 30 fresh): a rule file that A showed is lost (1 case) or shown shorter (2 cases) because the review files now come first. All three are a trade of the last rule against a changed file, where A's lost-line rule saw no loss. The prereg does not allow a waiver.
- F fails gates 1 and 2: dropping out-of-scope rules frees almost no budget (it fixes 1 of 21 holdout PRs and 0 of 76 fresh).
- FC and FCH fail gates 3 (FC), 4 and 6, and empty the rule block on 44 of 106 fresh PRs. Their rule cost is 387 (holdout) and 1679 (fresh) dropped in-scope rules; no written acceptance of that cost is made because neither is adopted.

**Limitation.** This measures what the model can see, not what it finds. Deviations: (1) fresh-corpus repos qualify on rule bytes at the default-branch tip, not at each base (per-commit tree scans over thousands of commits did not finish); (2) 94 of the 120 fresh collector runs used `TRACE=off` (26 used `auto`) to finish in time, which empties only the last pack tier (spec files); (3) `collect.sh` ran in throwaway shared clones, one per commit, because it checks out and restores rule files in its work tree; (4) head trees for the arms are built from the object store without `git checkout`, and a git symlink is written as the plain file git writes with `core.symlinks=false`, as the holdout-2 collector did on Windows (on a Linux runner a symlinked rule file is followed, so SpecGuard-style `.claude/skills/x` links would show their target); (5) the "code" definition (not doc, not test) is the reading that gives the prereg's 14/96; with "any non-doc" it is 20/96 for A. (6) Fresh results come from four repos with very large rule sets; a repo with small rules would show no effect either way.

### Amendment 2: arm O on the confirmation corpus under "loses changed content": not adopted (final)

Run once, O unchanged from e94f451 (`src/` identical), list in `pack-analysis/confirm-corpus.txt` (all of step 2 + first 10 per repo of step 3, 200 commits; the collector skipped 14, so n=186). Collector: real `src/collect.sh`, gh shimmed, `TRACE=off` for all 200 (step 1 had used 94 off / 26 auto). "Loses content" = a changed RIGHT line past what is shown, or a changed file with deleted lines shown with 0 lines. Raw rows are in SpecGuard-evidence/pack (conf.json).

**Gates on the confirmation corpus, k/n**
1. A loses changed content on at least 10 PRs: 70/186 (pass).
2. At least half of those fixed under O: 46/70 (pass; 24 still lose content).
3. PRs newly losing content under O: 0/186 (pass).
4. Gate 6 (A loses no content, so O must keep every in-scope rule A had at the same bytes): 1 violation in 116 PRs (fail). `langchain-f37ca688f9e6`: A loses nothing; O shows 241 KB of the changed files against A's 223 KB, and `AGENTS.md` is cut at another size.
5. Gate 4 on holdout 2 for O: 0/10 kept standards findings cite a rule O drops (pass; unchanged, O's pack is the same). SpecGuard #345-#386 newly losing content: 0/42 (pass).
6. Rule cost of O: 359 in-scope rules dropped on 41 PRs (all 359 on PRs where A loses content); 0 on 145 PRs.

**Per-repo split (A loses / still lost under O, of n):** cli 11/1 of 25; gitea 5/5 of 10; hono 0/0 of 10; langchain 2/0 of 8 (the gate 6 violation); orpc 20/3 of 29; pydantic 1/0 of 10; pydantic-ai 28/12 of 28; query 0 of 9; rqlite 0 of 10; sqlglot 1/1 of 10; trpc 0 of 9; vitest 2/2 of 28. Rule drops: pydantic-ai 305, orpc 36, cli 18, others 0.

**Design corpora under the new measure (information only; A loses / still lost under O, newly lost, gate 6 violations, rule drops total / PRs):**
- Holdout 2 (n=96): 24 / 4, 0 new, 1 of 72 (pydantic-ai-hclean2-1, a rule lost), 70 / 10. Split: pydantic-ai 11/0 of 16, orpc 4/1 of 6, gitea 2/1 of 17, langchain 2/0 of 8, cli 1/0, pydantic 1/0, query 1/0, sqlglot 1/1, trpc 1/1, others 0.
- Fresh step 1 (n=106): 78 / 11, 0 new, 0 of 28, 284 / 61. Split: cli 25/2, orpc 29/5, pydantic-ai 24/4, vitest 0.
- SpecGuard #345-#386 (n=42): 8 / 3, 0 new, 0 of 34, 0 / 0.

**Conclusion.** The amendment-2 rule requires every gate on the confirmation corpus, and gate 6 fails on 1 PR. O is not adopted. This is final: nothing is tuned, rerun or amended, and the `EXP_PACK` switch and its tests stay as they are. O fixes 46 of 70 losing PRs with no new loss, but it does so by giving the changed files budget that A spent on rule files, and on one PR that moved a rule the literal gate protects. The cost is 359 dropped in-scope rules on 41 PRs.
