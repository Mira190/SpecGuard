# Head-to-head: SpecGuard vs competitor-style reviewers

Local, offline, simulated. Read the limits before the numbers.

## Setup

- 24 real PRs from three repos (orpc, rqlite, sqlglot): 12 with a known shipped bug (SZZ-style replay, holdout set) and 12 clean PRs.
- Five variants, same model class (Sonnet subagents), same read-only checkouts, same tool budget:
  - `v1` SpecGuard baseline, `v2` SpecGuard with the v2 skill, `lean` SpecGuard lean prompt (current default).
  - `copilot` and `pocock`: **stand-in prompts we wrote** to mimic each competitor's published style (`docs/competitors/copilot-review.md`, `matt-pocock-review.md`). Free-form comments, no coverage table, no validator. They are not the real products.
- Outputs went through the same bundler, were deduplicated and anonymised, then judged blind by three Sonnet adjudicators (one per repo) against the code and the `bug_card`. Scripts: `eval/ab.js`, `eval/bundle.js`.

## Results (n = 12 bug PRs, 12 clean PRs)

| variant | bug PRs with a direct hit | inline findings | judged good (true_gap) | would_fix | wrong | trivial | clean PRs with a would_fix finding | clean findings / would_fix |
|---|---|---|---|---|---|---|---|---|
| v1 | 6/12 | 13 | 12 | 6 | 0 | 1 | 2/12 | 9 / 3 |
| v2 | 6/12 | 28 | 25 | 9 | 1 | 2 | 4/12 | 13 / 4 |
| **lean** | **7/12** | 22 | 22 | **13** | 0 | 0 | **5/12** | 14 / 7 |
| copilot-style | 8/12 | 28 | 18 | 13 | 0 | 11 | 3/12 | 10 / 4 |
| pocock-style | 9/12 | 104 | 39 | 17 | 2 | 61 | 1/12 | 44 / 2 |

Per-comment actionability (would_fix / inline findings): lean 59%, copilot-style 46%, pocock-style 16%, v2 32%, v1 46%.

Tokens (cumulative input per run, no cache, mean over 24 runs): copilot-style ~372k, pocock-style ~381k, **lean ~559k** (median 470k), v1 ~686k, v2 ~703k.

## What this says

1. **Recall is not our advantage.** The competitor-style prompts found as many or more of the 12 shipped bugs (8 and 9 vs lean 7). The gap is within noise at n = 12, but it removes any claim that SpecGuard finds more bugs.
2. **Precision and actionability are.** Lean produced no trivial or wrong inline findings and a maintainer would act on 13 of 22. The Pocock style buries 17 useful comments under 61 trivial ones and 104 total, which is the review-fatigue the original goal was meant to avoid. The Copilot style is cleaner but 11 of 28 were trivial.
3. **Clean PRs: lean surfaced real, fixable issues on 5 of 12; Pocock style on 1 of 12 despite commenting on all 12.** The count of comments is not the value.
4. **Cost is a gap.** Lean spends roughly 50% more input tokens than the competitor-style prompts (559k vs ~375k mean). It was the cheapest of our three variants (-18% mean, -28% median vs v1), but it is still more expensive than a free-form review. The structure that produces the precision costs tokens.
5. **What no variant here tests.** Traceability (requirement to code) contributed none of the real-bug hits; every direct hit came from code-vs-sibling-path test gaps. The coverage table, the `trace` section and the deterministic validator (post.js) are not exercised by this comparison, so it neither proves nor disproves them. The validator is what stops unverifiable quotes from being posted.

## Limits (do not quote the table without these)

- The competitors are our imitation of a published style, not Copilot or Pocock's actual tooling. Real Copilot was never run.
- The model is Sonnet subagents, not the model behind Copilot. n is 12 and 12; differences of one or two PRs are noise.
- The same adjudicator family judged all variants. The earlier round that judged v1/v2/lean alone gave lean 84% inline precision; this round gives 100%. Adjudicator variance is at least that large.
- Judges saw findings, not whether the validator would have posted them; `dropped` is 0 for every variant after the validator fixes.
- Seeded and replay results are in-sample for the changes we tuned on (lean was chosen on the first holdout; this is the second pass over the same PRs).

## Gap analysis

| gap | evidence | action |
|---|---|---|
| Recall on shipped bugs is not above a plain review | 7 vs 8 vs 9 of 12 | do not claim it; the target is fewer, verified comments |
| Token cost above free-form review | 559k vs ~375k | keep trimming lean; measure again after any prompt growth |
| Standards findings are weakest | 0 hits, claims of reading rule files not backed by reads | see `copilot-instructions-discovery.md`: per-file rule applicability, a read log, validate `standards.sources` |
| Traceability value unproven on real repos | no real-bug hit from spec comparison; discovery noise in field study | tighten `trace: auto` to strong signals; keep `off` documented |
| Competitor ideas worth keeping | Copilot: path-scoped instructions; Pocock: explicit "baseline smell" vs "documented rule" split (already in the skill) | scoped instructions are the next change |
