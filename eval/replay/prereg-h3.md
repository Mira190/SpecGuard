# Pre-registration H3 (fixed before any confirmatory data is read)

**H3:** the partial-visibility gate demotes real catches when the cut candidate test is only weakly matched.
Arm G = `EXP_PARTIAL_GATE=strong`; arm A = main.

## Exploratory

Offline on the already-scored raw-answer runs 39120706885 / 18089 / 29276 (bugs) and 39120712567 / 23905 / 35452 (controls). Report only; NOT used to decide (the author has seen this data, incl. vitest-7878).

## Confirmatory

A fresh 3-rep raw-answer run of holdout2-pairs and holdout2-clean (dispatched 2026-10-19 on main). Paired offline arms via `replay-arms --engine mock-replay`; the faithfulness gate (arm A == downloaded summaries on status, headline, counts) must pass first.

## Grading

Grade each finding once, blind to arm (README rubric); visibility per arm is mechanical (inline or summary body outside Details).

## Adopt G iff ALL of

1. visible catch events G - A >= +5 over 45 bug PRs x 3 reps AND >= +4 on the 33 PRs not carried over from holdout 1;
2. TP lost = 0 (an event visible in A and not in G), and inline catch events not lower;
3. visible findings per no_known_bug control PR-run G - A <= +0.35, and per bug PR-run <= +1.0; mixed_fix / non_code reported separately;
4. summaries within the existing caps.

## Also report

Newly visible control findings, adjudicated as plausible gap vs noise; per category; per stratum (new 33 / reused 12).

## Limitation

Same PRs as the exploratory data, new model samples only.
