# Mutation-survivor test-gap pilot

Ground truth for the product's core goal (missing or weak unit tests in code that is currently correct) without human labels. The replay holdouts measure bug catches in PRs; they have no pure test-gap cases. Here the gap is manufactured and known:

1. Mutate a source file by one small semantic change (`mutate.js`: boundary `<`/`<=`, `+`/`-`, `&&`/`||`, `===`/`!==`, integer literal +1, return value dropped or flipped).
2. Run only that file's own unit test file. **Killed** = at least one test **assertion** failed in that test file (behaviour the tests pin: a negative control). **Survived** = every test passed: the tests do not pin that behaviour (a *candidate* gap at that line, never a "found gap"). Everything else is **invalid** and not counted, with a `kill_reason` in the manifest: a thrown error or test-level timeout that is not an assertion failure, a failed suite (import, compile or setup error), no report, a baseline that does not pass. `timeout` = the process timed out.
3. Survivors that are probably **equivalent** (the change cannot alter reachable behaviour) or sit in defensive-only code are marked `uncertain` by hand, with the reason, in the manifest. They stay `survived` but are scored separately.
4. Scan the UNMUTATED repo at the frozen SHA with SpecGuard (`mode: scan`) and score the findings against the mutants (`score.js`).

## Files

- `mutate.js gen|run`: mutant generator and runner. A mutant is `(file, line, op, col)`; the manifest holds no third-party code text. `run` refuses a repo whose HEAD differs from the manifest SHA or that has local changes, restores the file after each mutant, and passes only a whitelisted environment (no secrets) to the test command.
- `score.js`: scorer. Input: manifest plus the manual run's result artifact (`findings.json`, `summary.md`, `usage.json`; `audit-units.txt` only if present, the artifact does not carry it). A finding's unit file is its `path` (`missing_test`) or the source file beside its test path (`weak_test`).
- `hono-5ca49b0.json`: the frozen manifest (80 mutants, 14 files) with status, `kill_reason`, `uncertain` and per-unit counts.
- `fixtures/real-shape/`: trimmed, hand-written fixture with the shape of a real result artifact (free-text `not_reviewed`, "Units reviewed X of Y" cell, "Low-confidence unit findings" section; no third-party code). Used by the scorer test.
- `*.test.js`: `node --test eval/mutation/`.

## Metrics (unit = source file)

- **Survivor-unit recall**: units with at least one survived, non-uncertain mutant that got a `missing_test` or `weak_test` finding. "any" = every verified finding; "visible" = not in the "Low-confidence unit findings" section of the summary.
- **Line hit rate**: survived non-uncertain mutants (in reviewed units) with a `missing_test` finding on the same file within +-5 lines. `weak_test` cites a test-file line, so it counts only at unit level.
- **False-alarm rate**: killed-only units (at least one killed, no survivor of any kind) that still got a finding. A unit named in `not_reviewed` counts as not reviewed only when the summary's "Units reviewed X of Y" has X < Y; with X = Y the mention is a caveat.
- **Uncertain-only units**: units whose survivors are all `uncertain`; reported apart, not in recall.
- **Cost**: `usage.json` `totalCostUsd`.

## Method used for the numbers below

- Repo: honojs/hono @ 5ca49b0720755c585c9a9835f0a479ceea36fb52 (MIT), cloned outside the repo and mutated there only; vitest 3.2.4 installed outside the clone with `--ignore-scripts`, run with a minimal config (`export default { test: { globals: true } }`, hono's own config bypassed), whitelisted environment, about 1 s per mutant. `src/utils/color.test.ts` fails at baseline, so `color.ts` is not mutated.
- Generation: `mutate.js gen --seed 1 --max 80` over the 14 `src/utils` files that have a test file beside them (round-robin over files and operators, never two mutants on one line).
- Scan: `specguard-run.yml` from `Mira190/SpecGuard` main, one dispatch (run 39187431386), `target` = `https://github.com/honojs/hono/tree/5ca49b0720755c585c9a9835f0a479ceea36fb52/src/utils` (resolves to the commit and the directory), `scan_scope: all`, `model: haiku-5.5`, `max_budget_usd: 1`, `scan_issue: none`. The scan covers all of `src/utils`, not only the 14 mutated files.

## Mutation result (80 mutants, 14 files)

**53 killed, 19 survived, 8 invalid, 0 timeout.** The 8 invalid are failed tests that threw a non-assertion error (not counted either way). 9 of the 19 survivors are marked `uncertain` (likely equivalent: `<` to `<=` reading `charCodeAt(length)` = NaN, defensive null checks, `crypto && crypto.subtle` vs `||`; some marked "unverified" in the manifest), so **10 candidate survivors** remain.

| Group | Units |
|---|---|
| Units with a candidate survivor (5) | body, crypto, html, ipaddr, stream |
| Units whose survivors are all uncertain (4) | accept, buffer, cookie, url |
| Killed-only negative controls (5) | basic-auth (5 killed), concurrent (4), encode (4), filepath (5), mime (3) |

## SpecGuard result (one run, n = 5 / 5 / 4 units, 10 candidate survivors)

Run 39187431386: success; 20 of 20 units reviewed (7 whole, 13 with part of their tests); 12 model calls; no budget or deadline cut; **cost $0.089** (usage.json). 16 unit findings, 9 visible, 7 low-confidence; 2 findings outside the manifest (middleware/jwk test, color.test.ts).

| Metric | Result |
|---|---|
| Survivor-unit recall, any | 5 / 5 units |
| Survivor-unit recall, visible only | 3 / 5 units (body and ipaddr are low-confidence only) |
| Line hit within +-5 | 0 / 10 candidate survivors |
| False alarm on killed-only units, any or visible | 2 / 5 (basic-auth: 2 visible; encode: 1 visible weak_test + 1 low-confidence); concurrent, filepath, mime quiet |
| Uncertain-only units flagged | 4 / 4 any (accept, buffer, cookie, url), 3 / 4 visible (accept low-confidence only) |
| Units not reviewed | 0 of 20 (9 mutated files are named as partly visible in `not_reviewed`) |

Reading it carefully:

- Every survivor unit got a finding, but at line level nothing matched: findings sit at function starts or other lines (ipaddr:149 vs mutant at 134; html:129 vs 63-180; stream:106 vs 57-66; body:111 vs 165). The one unit-level hit that matches its mutant's meaning is `crypto.test.ts:24` "md5 digest test is skipped" and the surviving mutant that drops md5's return value. The html finding concerns `resolveCallbackSync`, not the mutated lines.
- The two killed-only units that were flagged are not clearly false alarms: the basic-auth findings (lowercase scheme accepted, colon inside the password) name inputs the sampled mutants did not touch, so "killed-only" means "5 sampled mutants were caught", not "fully tested". The false-alarm rate here is an upper bound on noise for the sampled lines only. One finding (`cookie.test.ts:163`) says in its own title that it found no gap in cookie.ts.
- Uncertain-only units were flagged at the same rate as survivor units; with 4 units this says nothing about whether the equivalent-mutant guesses are right.

## Limits (read before quoting a number)

- n is tiny: 80 mutants, 14 files (5 / 5 / 4 units per group, 10 candidate survivors), one repo, one scan run, one model. Percentages above are counts of a handful of units; no confidence interval is claimed and differences of one unit move them by 20 points.
- Survivors include equivalent mutants and code the product legitimately judges not worth a unit test. `uncertain` is a hand judgement from reading a few lines, partly unverified. Recall against survivors is a ceiling-style signal, not a labelled precision, and a finding on a non-survivor line is not necessarily wrong.
- Mutants are line-local; SpecGuard reasons per behaviour or unit, so unit-level hits are far easier than line hits. Findings that are not about a mutated line (the large majority here) say nothing about the mutants.
- Killed-only does not mean fully tested. The pilot repo has a mature test suite, so few survivors exist.
- Model output varies run to run; this is one sample. The scan also reviewed 6 units outside the manifest, which are ignored.
- `invalid` mutants (thrown error, not an assertion) are dropped, which also drops some real behavioural kills; the choice is deliberately strict.

Reproduce the mutants: clone hono at the SHA, install vitest outside the clone (`npm i --ignore-scripts vitest@3.2.4`; a short path avoids an esbuild/Windows path problem), then `node eval/mutation/mutate.js run --repo <clone> --manifest eval/mutation/hono-5ca49b0.json --cmd 'node <vitest>/vitest.mjs run --config <vc.mjs> --root . --reporter=json --outputFile={out} {test}'`. Score a run with `node eval/mutation/score.js --manifest eval/mutation/hono-5ca49b0.json --ctx <artifact dir>`.
