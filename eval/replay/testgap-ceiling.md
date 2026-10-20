# Test-gap slicing ceiling check (no model calls)

24 qualifying holdout-2 pairs x 3 saved runs, derived reading, seed 20261020, 1000 perms, verdict null = the larger-CI one (primary in all three rows).
Command: `node eval/replay/testgap-score.js <args of c64501b> --powern 48 [--undemote testgap-demotion/result.json --undemote-reasons a|all]`.

| delivered set | catch runs | PR-level | chance primary / secondary | effect (pts, verdict null) | p primary / secondary | lift primary / secondary | P(p<.05 and effect>=10), n=48 x 3 |
|---|---|---|---|---|---|---|---|
| today | 2/72 | 0.028 | 0.0266 / 0.0166 | +0.1 | 0.646 / 0.340 | 1.05 / 1.67 | 0.000 |
| U: + demoted (a) | 19/72 | 0.264 | 0.2008 / 0.1681 | +6.3 | 0.025 / 0.003 | 1.31 / 1.57 | 0.197 |
| U+: + all demoted | 22/72 | 0.306 | 0.2156 / 0.1803 | +9.0 | 0.004 / 0.000 | 1.42 / 1.70 | 0.409 |

U+ equals the earlier literal reading (22/72, 30.6% vs 21.6%) exactly: that reading never excluded low-marked findings, so it is the same set.
(a) findings added in U: 39, of which 21 are inside B (catches). Added findings raise the null-eligible count 12 -> 51 (U), 61 (U+).
