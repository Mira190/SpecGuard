# prove: are test-gap findings actionable and discriminating?

Mutation of production code is the ground truth for `missing_test` and for `weak_test` findings about **coverage gaps / assertion strength**. For every such finding in a local-eval output:

1. `node eval/prove.js plan --case ID --out DIR` writes `DIR/ID/prove.json`: the target production line and up to 40 syntax-checked (`node --check`), deduplicated single-line mutants. Re-planning only rewrites `prove.json`; tests added under `DIR/ID/repo` are untouched.
2. `node eval/prove.js agent-brief --case ID --out DIR` writes `DIR/ID/test-writer-prompt.md` (finding text only, no mutants). A test-writing agent creates test file(s) under `DIR/ID/repo` without touching production code.
3. `node eval/prove.js check --case ID --out DIR [--timeout MS]` finds new/changed test files via `git status` in `DIR/ID/repo`, runs them in temp copies on head and on each mutant (also the existing tracked tests of the module), and writes `DIR/results-prove.json`.
4. `node eval/prove.js oracle-check --case ID --out DIR` lists the findings treated as oracle-independence findings (see below).

## Mutants

Scopes (labelled `scope` in `prove.json`): `cited` (the cited line), `head` (the enclosing if/while/for head), `neighbour` (other statements of the enclosing function body within 10 lines of the cited line, because a weak assertion's blind spot may be on a neighbouring line). Cited + head get at most 30 mutants, neighbours fill the rest up to 40; operators are picked round-robin so no single operator crowds out the others.

Operators: relational, logical, boolean, negation removal, number/boundary (+/-1), arithmetic, return-value (null/0/''), delete-throw, and value-level ones: `replace-expr` (returned/assigned expression replaced by each other identifier or numeric literal on the statement), `arith-shift` (expr+1, expr-1, expr*2 when numeric-looking), `bool-flip` (`!(expr)` for boolean-ish expressions), `negate-cond` (`if (!(cond))`), `minmax` (Math.min <-> Math.max), `swap-args` (adjacent call arguments; skipped for the commutative Math.min/Math.max). The value-level ones are what a truthy assertion such as `assert.ok(clamp(15, 0, 10))` cannot catch. Sub-expression operators (each applied independently to every occurrence on the statement): `sub-shift` (an identifier or numeric literal becomes id+1, id-1, id*2), `sub-replace` (replaced by another identifier/literal of the statement), `unwrap-call` (`f(a, b)` becomes `a` or `b`, which includes dropping an argument of Math.min/Math.max). Without them a returned `Math.min(Math.max(v, min), max)` could lose its upper clamp unnoticed. Some mutants are still equivalent (never killable).

## Outcomes (per finding) and metrics

- `discriminating`: new test passes on head and kills more mutants than the existing tests.
- `defect_exposed`: the new test written to the requirement FAILS on head with an assertion failure (AssertionError / ERR_ASSERTION / expected-vs-actual diff). The code deviates from the requirement. The failing test names are reported (`failing_tests`) with `failure_names_finding_behaviour` (heuristic: failing test name/output shares >= 2 words with the finding text; confirm by reading).
- `broken_test`: the new test fails on head for a harness / authoring reason (SyntaxError, ReferenceError, TypeError, MODULE_NOT_FOUND, timeout).
- `false_alarm`: existing tests already kill every mutant.
- `no_mutants`: nothing to mutate. `undetermined`: anything else (mixed assertion + harness errors, partial kills with no uplift, no new test).
- `oracle_independence (not mutation-testable)`: see below.

Metrics: `actionable_rate` (new test passes on head), `discriminating_rate`, `false_alarm_rate` (oracle findings excluded from numerator and denominator), `kill_rate_new/existing/uplift`, `defect_exposed_rate` = defect_exposed / findings, `value_shown_rate` = (discriminating + defect_exposed) / findings, and `outcomes` (counts). `defect_exposed` is a success: a requirement-derived test found a real defect.

## Limits: mirror / oracle-not-independent tests

Production mutation CANNOT show the weakness of "mirror" tests whose expected value is recomputed from the implementation (same formula, tautology). Such tests are change-detectors: they kill production mutants yet would still pass if the formula were wrong in both places. Mutating the spec constant on both sides is not possible mechanically, so a `weak_test` whose title/body matches mirror / recompute / tautolog / same formula / derived from the implementation (case-insensitive) is reported with outcome `oracle_independence (not mutation-testable)`, still listed, and excluded from `false_alarm_rate`. Judge those by reading, not by kill rate. The match is a keyword heuristic and can misfire either way.

The mutant set is a lower bound on blind spots: a surviving mutant proves a gap, but killing every mutant does not prove the tests are adequate (the generator has no operators for e.g. statement deletion, multi-line or cross-function defects). A `false_alarm` result must therefore be hand-validated (try plausible defects the generator cannot produce) before it is used to judge a finding.

Other caveats: `.ts` tests run only on Node >= 22.6; vitest/jest suites are not supported (`node --test` only).
