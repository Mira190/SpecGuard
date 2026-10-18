# Mutation-survivor test-gap pilot

Ground truth for the product's core goal (missing or weak unit tests in code that is currently correct) without human labels. The replay holdouts measure bug catches in PRs; they have no pure test-gap cases. Here the gap is manufactured and known:

1. Mutate a source file by one small semantic change (`mutate.js`: boundary `<`/`<=`, `+`/`-`, `&&`/`||`, `===`/`!==`, integer literal +1, return value dropped or flipped).
2. Run only that file's own unit test file. **Survived** = every test still passes: the tests do not pin that behaviour (a candidate gap at that line). **Killed** = a test failed: behaviour the tests pin (negative control). `invalid` (nothing ran, crash) and `timeout` mutants are dropped.
3. Scan the UNMUTATED repo at the frozen SHA with SpecGuard (`mode: scan`) and score the findings against the mutants (`score.js`).

## Files

- `mutate.js gen|run`: mutant generator and runner. A mutant is `(file, line, op, col)`; the manifest holds no third-party code text. `run` refuses a repo whose HEAD differs from the manifest SHA or that has local changes, restores the file after each mutant, and passes only a whitelisted environment (no secrets) to the test command.
- `score.js`: scorer. Input: manifest plus the scan's `specguard-ctx` artifact (`findings.json`, `audit-units.txt`, `summary.md`).
- `hono-5ca49b0.json`: frozen manifest (pilot repo), with per-mutant status and the exact test command template.
- `*.test.js`: `node --test eval/mutation/`.

## Metrics (unit = source file)

- **Survivor-unit recall**: units with at least one survived mutant that got a `missing_test` or `weak_test` finding. Reported as "any" (all verified findings) and "visible" (not Details-only). Units SpecGuard did not review count as misses; both denominators (all units, reviewed units) are printed.
- **Line hit rate**: survived mutants (in reviewed units) with a `missing_test` finding on the same file within +-5 lines. `weak_test` cites a test-file line, so it only counts at unit level.
- **False-alarm rate**: units whose mutants were all killed (at least one killed, none survived) that still got a finding. Unreviewed units are excluded, not counted as quiet.

## Limits (read before quoting a number)

- Survivors include **equivalent mutants** (the change cannot alter behaviour) and mutants in code the product legitimately judges not worth a unit test. Recall against survivors is therefore a ceiling-style signal, not a labelled precision.
- A killed unit is not "fully tested": it only means the sampled mutants were caught. False alarms here are an upper bound on noise only for those lines.
- n is tiny (40 mutants, 10 files, one repo, one scan run). Model output varies run to run; no confidence interval is claimed.
- Mutants are line-local; SpecGuard reasons per behaviour/unit, so a hit at unit level is much easier than a line hit.
- The pilot repo (Hono utils) has a mature test suite, so few survivors exist; a repo with weaker tests would give more positives.

## Pilot result (honojs/hono @ 5ca49b0, `src/utils`: 10 files, 40 mutants)

Mutation run (vitest 3.2.4, one test file per mutant, about 15 s each): **12 survived, 28 killed, 0 invalid.** 9 of 10 files have at least one survivor; only `basic-auth.ts` is killed-only (n=1 negative-control unit, so the false-alarm rate cannot be estimated meaningfully on this sample). Survivors per file: html 3, buffer 2, one each in accept, cookie, encode, filepath, ipaddr, mime, url.

**SpecGuard numbers: not produced.** The scan workflow is ready on Mira190/Kite branch `eval/mutation-pilot-1019` (checks out honojs/hono at the frozen SHA, `Mira190/SpecGuard@dce3336`, `model: haiku-5.5`, `scan_paths` = the 10 mutated files, `max_budget_usd: 2`, `fail_on_error: true`). The dispatched run failed before any step: "The job was not started because recent account payments have failed or your spending limit needs to be increased" (Kite owner billing). Needed: fix Actions billing for Mira190, then `gh workflow run specguard-audit.yml -R Mira190/Kite --ref eval/mutation-pilot-1019`, download the `specguard-audit-1` artifact and run `node eval/mutation/score.js --manifest eval/mutation/hono-5ca49b0.json --ctx <artifact dir>`. The scorer is covered by a synthetic unit test only; its parsing of `summary.md` (visible vs Details-only) and `not_reviewed` has not been checked against a real artifact.

Reproduce the mutants: clone hono at the SHA, install vitest outside the clone (`npm i --ignore-scripts vitest@3.2.4`; a short path avoids an esbuild/Windows path problem), use a config `export default { test: { globals: true } }`, then `node eval/mutation/mutate.js run --repo <clone> --manifest eval/mutation/hono-5ca49b0.json --cmd '<vitest ... --reporter=json --outputFile={out} {test}>'`.
