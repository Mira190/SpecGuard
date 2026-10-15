# Review batch 2: fixes for `critical-shift-left-followup-2026-10-15.md` (2026-10-15)

Base: main `d3234e3` + PR #191 (F07 context completeness). Offline only; no paid model run, no Kite run.
Full suite: 1067 pass, 0 fail, 1 skip, 1 todo (k2). Every new test was mutation-checked: it fails with the old source file.

| Finding | Fix | Regression |
|---|---|---|
| F18 (P1) | `audit-post`: a scan issue in another repository (`scan_issue_repo`) is written only after `visibility-guard.decide(destination, source)` passes; an unreadable visibility fails closed; status `failed` with the reason. Same rule as the manual workflow, now at the action's own output boundary | `src/enterprise-workflows.test.js` "audience is no wider": private→public and both unknown cases make no issue call; private→private, internal→private, public→public still write |
| F13 (P1) | `post.ASSERTION` (shared by PR mode, scan and the unit inventory): a keyword counts only as a call or member access (`assert.`, `expect(`, `x.should.`); `expected…` names, `const assert = require(…)`, test titles ("should…", "throws…") and `throw new Error` are no assertion; `assertionKind` ignores comment lines in the quote | `src/test-map.test.js` "assertion styles" negatives; `src/audit-post.test.js` "variable, a commented-out assertion or an import line" (the review's three inputs) |
| F14 (P1) | `leads.assertionDelta` table rule: the added assertion must be parameterised (no literal in its subject) and the row must sit in the table its loop iterates (`for … of`, `.forEach`, `.each`; inline or a `const` added in the diff) | `src/leads.test.js` "parameter table": the review's unused-array repro stays a lead; a named and a multi-line table pass; a row in an array the loop does not read stays a lead |
| F15 (P1) | `eval/grade.js`: each summary item / coverage row is consumed by at most one expected finding (nearest line); an expected `text` is checked against a summary hit too | `eval/grade.test.js` "matches at most one expected finding" |
| F16 (P2) | `parseSummary` reads the producer's `specguard:status=` marker first (phrases stay for old summaries); `reduced` (fast tier) is reported separately and does not fail a case | `src/post.test.js` "grade reads the completeness", on real `buildSummary` output |
| F17 (P2) | `audit-post.validate`: a requirement/not-requirement conflict is registered before any drop of the requirement row, so a malformed row cannot turn the block into a non-requirement; the block becomes an unknown row | `src/audit-post.test.js` "every result names a listed block" (`source: null` case) |
| (found while reviewing #191) | `claude-api.slices`: the symbol regex lost its escapes in a template literal, so `computeTotal` matched inside `recomputeTotal`; whole-word again | `src/claude-api.test.js` "symbol counts only as a whole word" |

## Limits

- F13: an assertion helper whose name has none of the keywords (`checkTotal(x)`) still reads as no assertion (unknown, never covered); `expected.foo(` still reads as an assertion.
- F14: other table forms (`[…].forEach` with the array before the call, tables in another file or built by a function) keep the lead. Auto-posting a high `missing_test` from a standing lead is unchanged.
- F18 checks repository visibility, not member-level ACLs (two private repositories with different readers pass).
- F16: `complete` still means "the run declared itself complete"; a reduced run passes if its findings match.
- Still open: F04, F06, F09–F12, the observation that private helpers enter the obligation denominator (PR #190), and a Kite canary at a fixed SHA.
