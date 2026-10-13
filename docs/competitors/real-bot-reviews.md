# What other AI reviewers actually said on the PRs we replayed

Collected 2026-10-09. Raw structured data (comment ids, URLs, timestamps, 300-char excerpts, per-PR grades): `eval/replay/competitor-reviews.json`. No third-party source is stored; quotes are short and linked.

## Method

- PR set (64 PRs after de-duplication): the 18 replay-eligible bug-introducing PRs (6 first batch in `eval/replay/pairs.json`, 12 hold-out in `holdout-pairs.json`), their fix PRs, and the 30 clean PRs (`clean.json`, `holdout-clean.json`).
- For each PR: `gh api repos/{o}/{r}/pulls/{n}/reviews`, `/pulls/{n}/comments`, `/issues/{n}/comments`, all `--paginate`. Authors classified by login (Copilot, CodeRabbit, Qodo, Gemini Code Assist, Sourcery, Greptile, CodeAnt, Ellipsis, Cursor, Claude, Devin, GHAS/CodeQL, other bots, human). Only three AI tools ever appeared: Copilot, Gemini Code Assist, and Pullfrog (an LLM review agent, footers say it ran "DeepSeek Flash (free via Pullfrog for OSS)"). Codecov, CodSpeed, pkg-pr-new, Vercel, Cloudflare and github-actions are CI/infra bots and are not counted as reviewers.
- Bug grades: I read each AI comment against the `bug_card`. direct = names the defective behaviour. near = right function or area, defect not named. miss = neither. not_covered = no AI reviewer posted at all. Strict: a reviewer that described the behaviour and called it intended is a miss.
- Clean PRs: every AI inline finding labelled valuable / nit / wrong by reading the comment text (and, for a few, the merged code). Review-level "No new issues" summaries are not findings.
- Coverage denominator: the 30 and the 100 most recently merged PRs per repo (2026 only), checked for any AI reviewer.

## Per-repo coverage (is an AI reviewer even on?)

| Repo | Tool seen | Last 30 merged (2026-09/10) | Last 100 merged | On our replayed PRs |
|---|---|---|---|---|
| tobymao/sqlglot | GitHub Copilot (copilot-pull-request-reviewer, inline as "Copilot") | 5 of 30 | 25 of 100 (2026-09-17..10-09) | first seen 2026-08-06; 0 of 5 bug PRs, 1 of 10 clean PRs, 1 fix PR |
| rqlite/rqlite | Gemini Code Assist | 0 of 30 | 2 of 100 (2026-07-22..10-09) | 2025-04-04 to 2026-07-05; 3 of 5 bug PRs, 4 of 10 clean PRs |
| middleapi/orpc | Pullfrog (plus one Copilot review on #1705) | 30 of 30 | 100 of 100 (2026-09-22..10-09) | first seen 2026-07-20; 8 of 8 bug PRs, 10 of 10 clean PRs |

Notes: sqlglot's github-actions comment is an integration-test summary, not review. Gemini's consumer code review is being shut down ("all code review activity will officially cease on July 17, 2026", quoted in the rqlite#2708 review). No CodeRabbit, Qodo, Sourcery, Greptile, CodeAnt, Ellipsis, Cursor, Claude, Devin or GHAS comments appeared on any of the 64 PRs or the sampled coverage PRs.

## Bug PRs (18): who reviewed, and did they point at the defect?

First-batch PRs are marked (B1). SpecGuard grades exist only for the first batch (`adjudication-bugs.json`).

| Bug PR | AI present | Grade | Evidence |
|---|---|---|---|
| sqlglot#7641 (B1) | none | not_covered | SpecGuard: miss |
| sqlglot#7036 (B1) | none | not_covered | SpecGuard: direct |
| sqlglot#7054 | none | not_covered | |
| sqlglot#7097 | none | not_covered | |
| sqlglot#7315 | none | not_covered | |
| rqlite#1722 (B1) | none | not_covered | SpecGuard: direct |
| rqlite#1556 (B1) | none | not_covered | SpecGuard: direct |
| rqlite#2061 | Gemini | **direct** | [inline](https://github.com/rqlite/rqlite/pull/2061#discussion_r2027980564): wrong stat incremented on conversion error, should be numUpdateHooksErrors |
| rqlite#2313 | Gemini | near | [test request](https://github.com/rqlite/rqlite/pull/2313#discussion_r2338463603) for special-character table names; flagged unquoting, not the later faulty escape |
| rqlite#2318 | Gemini | miss | [inline](https://github.com/rqlite/rqlite/pull/2318#discussion_r2341706253) is about test message wording |
| orpc#1961 (B1) | Pullfrog | near (weak) | [inline](https://github.com/middleapi/orpc/pull/1961#discussion_r3869572372): same walk, but stack depth, not the array named-key bypass |
| orpc#2113 (B1) | Pullfrog | miss | [review](https://github.com/middleapi/orpc/pull/2113#pullrequestreview-5335423430) lists the toString/valueOf behaviour change and endorses it as intended |
| orpc#1846 | Pullfrog | miss | [approved twice](https://github.com/middleapi/orpc/pull/1846#pullrequestreview-4912404134), checks the pre-routing 403 as designed |
| orpc#1851 | Pullfrog | miss | [no issues](https://github.com/middleapi/orpc/pull/1851#pullrequestreview-4924792515); dismisses mixed-schema divergence as not a regression |
| orpc#1705 | Pullfrog, Copilot | miss | found other real merge bugs ([Copilot](https://github.com/middleapi/orpc/pull/1705#discussion_r3642703579)), not the dropped interceptors |
| orpc#1718 | Pullfrog | miss | [inline](https://github.com/middleapi/orpc/pull/1718#discussion_r3642828076): different real bug (function modifiers rejected) |
| orpc#1743 | Pullfrog | miss | [no issues](https://github.com/middleapi/orpc/pull/1743#pullrequestreview-4803439935) |
| orpc#1766 | Pullfrog | miss | [no issues](https://github.com/middleapi/orpc/pull/1766#pullrequestreview-4838785093) |

Tally (18 bug PRs): any AI reviewer present on 11; direct 1, near 2, miss 8; 7 had no AI reviewer.

| Tool | PRs present | direct | near | miss |
|---|---|---|---|---|
| Pullfrog | 8 | 0 | 1 | 7 |
| Gemini Code Assist | 3 | 1 | 1 | 1 |
| Copilot | 1 | 0 | 0 | 1 |

On the first batch of 6: AI reviewers covered 2 (orpc#2113 miss, orpc#1961 near); the other 4 had none. SpecGuard graded 3 direct of 6; its three directs (sqlglot#7036, rqlite#1722, rqlite#1556) are exactly PRs where no AI reviewer was present. On the two PRs that both saw, SpecGuard and Pullfrog both missed orpc#2113; orpc#1961 was a SpecGuard miss and a weak near for Pullfrog. SpecGuard has not been run on the 12 hold-out PRs, so no head-to-head exists there.

Observations: Pullfrog and Copilot did find real, different bugs in the same PRs (orpc#1705, #1718), and the Gemini hit on rqlite#2061 is a clean direct. Pullfrog's reviews were mostly "No new issues found" approvals, including on PRs later fixed for a regression.

## Clean PRs (30): noise

| Repo | Clean PRs | With any AI reviewer | AI inline findings | valuable | nit | wrong |
|---|---|---|---|---|---|---|
| sqlglot | 10 | 1 (Copilot) | 2 | 0 | 1 | 1 |
| orpc | 10 | 10 (Pullfrog) | 6 | 2 | 4 | 0 |
| rqlite | 10 | 4 (Gemini) | 1 | 1 | 0 | 0 |
| Total | 30 | 15 | 9 | 3 | 5 | 1 |

Per covered clean PR: 0.6 findings (9 over 15 PRs); 8 covered PRs produced none (7 produced at least one). Per finding: 33% valuable, 56% nit, 11% wrong. Covered clean PRs also got 25 summary-level reviews, almost all "No new issues" (Pullfrog posts one per push). The only wrong finding is Copilot on sqlglot#8065 claiming missing tests that live in a private submodule.

## Caveats and unfairness

- Tool presence is confounded by repo and era. Copilot reviewed sqlglot only from 2026-08-06; the sqlglot bug PRs merged earlier (e.g. #7641 on 2026-05-19) could not have had it. rqlite#1722 and #1556 predate Gemini on that repo. So 7 of 18 "not covered" cells say nothing about tool quality.
- Bug PRs are pre-selected by a later fix (SZZ), so recall on them is not comparable to the clean-PR noise rate, which is a small, uncontrolled sample.
- Sample sizes are tiny: Gemini n=3, Copilot n=1, Pullfrog n=8 bug PRs; 9 clean findings. Percentages are descriptive, not estimates.
- Tools differ in setup. Pullfrog is a free OSS agent on a small model reviewing every push of one repo; Copilot runs by repo/author setting (25 of 100 sqlglot PRs); Gemini is a retired consumer product. None had repo-specific instructions that I checked. Incremental re-reviews inflate Pullfrog's summary-comment count.
- SpecGuard was run on a checked-out diff with its own test-gap framing; the other tools were live products with comments that sometimes preceded later commits. A comment on an earlier commit (rqlite#2313, #2061) is credited if its content matches the merged defect.
- Grades are my reading of text against the bug card, single rater, not blind. Near/direct boundaries (rqlite#2313, orpc#1961) are judgement calls; moving both to miss changes the AI tally to 1 direct, 0 near, 10 miss.
- Human reviewers are recorded as counts only in the JSON and not graded.
