# SpecGuard version evaluation · 2026-10-17

**Conclusion: there is a reproducible reliability improvement; the full goal, call-level provenance, and team shift-left benefit have not yet passed acceptance.**

Comparison: 7c131b5 → b377cff; additionally checked main 5247da3 (#305 diagnostic improvements). This round made no new paid model calls.

| Paired metric | Old version | New version |
|---|---:|---:|
| 21 path-classification regression samples | 16/21 | 21/21 |
| Out-of-bounds validated findings from dropped/failed parts | 1 each | 0 each |
| Collector still has later parts | complete | incomplete |
| Calls admitted under the same budget at low actual consumption | 1 | 2 |
| Changed test's own hunk visible | 0/1 | 1/1 |
| Test for changed identifier visible | 0/1 | 1/1 |

The above are controlled module probes, not overall model accuracy. The visibility rate of new source/test lines in the real #301 pack rebuild is the same in both versions; it cannot be said that every PR improved.

Real Linux CI on the fixed candidate tree: 1436 tests, 1432 pass, 0 fail, 3 skipped, 1 TODO. The dogfood review itself was incomplete; job success does not mean a complete review.

Of the 23 real eval PRs read this time, 5 did not commit the expected change (#299, #302, #303, #304, #306) and cannot be counted as reviewer pass/miss. The 18 valid ones span three product builds, and the grader has counterexamples of double-counting FPs across inline/coverage, so no latest-version precision or improvement ratio can be given from them.

Not achieved: a finding can still pass validation using source from another successful call; findings from a single-call cut source can still be non-low confidence; unknown single-call usage is still recorded as zero estimated cost; selected-scope complete still does not equal whole-repo complete; there is no human QA benefit or valid matched model A/B evidence.

Next round: first validate the eval inputs and fix the scoring identity, then fill in the full provenance chain of call/attempt → actually visible source/test scope → requirement version → final delivery, and finally run a fixed-condition model A/B and a human pilot.

[Full public report](report.md). Raw evidence, source snapshots, and rerun scripts are kept locally and were not committed with this public version; this cleanup did not re-run the historical evaluation.
