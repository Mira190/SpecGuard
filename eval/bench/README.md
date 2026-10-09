# Mutation benchmark (L2/L3)

Recall and false-alarm rates at real-repo scale, with ground truth by construction (`docs/traceability-plan.md` §7.4.2). Tooling: `eval/mutate.js`. Runs through `eval/run.js --external` (§7.4.1). Source code of third-party repos is never committed here; only proposals and manifests (SHAs, line edits, expectations) are.

## Status: no repos chosen

**No source repositories have been selected, and none are assumed.** Nothing in this directory names a candidate. The three picks, the candidate list and the reason for each pick are recorded below after the search in step 1 has been done by a human.

| # | Repo (URL @ SHA) | Language | Licence | Files | Normative items with values | Why picked |
|---|---|---|---|---|---|---|
| 1 | not chosen | | | | | |
| 2 | not chosen | | | | | |
| 3 | not chosen | | | | | |

Candidates considered and rejected (with reason): none recorded yet.

## 1. Pick 3 repos

Selection rules (all must hold):
- permissive licence (MIT, Apache-2.0 or BSD);
- at most 10k files;
- a real test suite;
- spec content that `trace.js` parses, with at least 20 normative items that contain numeric or enumerated values (check with `--propose` below: the number of proposals is a lower bound);
- three different languages.

Find candidates with GitHub code search, for example `path:*.feature "Examples:"` and `path:docs "shall"` combined with `language:`. Record the candidates and the reasons in the table above before generating anything.

## 2. Workflow

All commands are deterministic and offline.

1. **Snapshot.** Clone the source repo into a temp directory, check out the chosen SHA, and work on a copy of the base snapshot. Never inside this repo.
2. **Propose.** `node eval/mutate.js --propose DIR --out eval/bench/<repo>.proposals.json`. For each normative item with an integer value (>= 2) it proposes a triple: the spec item, 1-3 production sites that contain the value and whose window ranks in the BM25 top 8 for the item (`trace.js` tokenizer and index), and at least one test line with the value or value +-1 in a test file that mentions the site module. Every triple has `confirmed: null`.
3. **Confirm (human, about 1 minute per triple).** Read the sentence and the sites. Set `confirmed: true` only if "this constant implements this sentence" is true; otherwise `false`. Optionally write `note`. Aim for 15-20 confirmed triples per repo.
4. **Mine (L3, optional).** `node eval/mutate.js --mine DIR --out eval/bench/<repo>.mined.json [--commits 200]` lists commits that change a spec line and a production line with the same integer (`30 -> 45` in both). Reverting the production half by hand gives a real "spec changed, code not" positive; the untouched commit is the paired negative. Mined entries need the same human confirmation and are not mutation sources (`mutate` refuses them).
5. **Emit.** `node eval/mutate.js --emit eval/bench/<repo>.proposals.json --dir DIR --source-url URL --source-sha SHA --manifest eval/bench/<repo>.json [--ops B-value,A-value] [--triple ID] [--cases-dir D]`. Only triples with `confirmed: true` are used; `--triple` on an unconfirmed triple, or a file with none confirmed, is an error and writes nothing. Operators that do not apply to a triple (for example Partial with one site, no-op in an unsupported language) are listed as skipped.
6. **Materialise.** `run.js --external` needs `base`/`head` to exist in the source. The mutations do not, so create a **private fork** of the source, clone it into a temp directory, and call `materialize({dir, entry})` from `eval/mutate.js` for each entry. It creates the branches `entry.base` and `entry.head` and returns their SHAs. Push them to the fork, then set `source.url` to the fork and `base`/`head` to the SHAs in the committed manifest. (`materialize` refuses to run inside this repository.)
7. **Run.** `node eval/run.js --external eval/bench/<repo>.json --repo OWNER/MIRROR --action OWNER/specguard@SHA --trace off,auto`. Stratified sample of about 120 cases, one run each, both trace modes. Record Copilot credits per batch with `--billing`.

The manifests are validated by `validateBenchManifest` (it runs `eval/run.js` `validateManifest` first, then checks the operator, that the triple is confirmed, and the edit lists).

## Operators

`mutate(operator, triple, files)` returns `{id, operator, triple, edits: {base, head}, expected, ...}`. An edit is `{path, line, before, after}`: line `line` must equal `before` and becomes `after`. Head edits apply to the tree after the base edits. `n'` is `max(n + 1, round(n * 1.5))`, so it never equals `n`.

| Operator | Id suffix | Mutation | Expected (case.json schema) |
|---|---|---|---|
| B-value | `-bv` | spec n -> n' | `spec_mismatch` on the spec line; `text` matches any confirmed site; `sites` lists all for site recall |
| B-boundary | `-bb` | "more than" <-> "at least", "fewer/less than" <-> "at most" on the spec line | `spec_mismatch` or `weak_test` |
| A-value | `-av` | first confirmed production literal n -> n' | `spec_mismatch` on that line; `text` names the spec item |
| A-operator | `-ao` | `>` <-> `>=`, `<` <-> `<=` at the comparison within 8 lines of a site | `spec_mismatch` or `weak_test` |
| Partial | `-pt` | spec, first site and its test file n -> n'; other sites untouched | `spec_mismatch` on the spec line; `text` names the remaining sites |
| Control: no-op | `-cn` | extract the literal at a site into a named constant on the line above (js/ts, python, go; plain statement sites only) | `must_not spec_mismatch`; Traceability alignment `consistent` |
| Control: consistent | `-cc` | spec, every site and the tests changed together | `must_not spec_mismatch` |
| Control: pre-existing | `-cp` | A-value goes into **base**; head adds a log line after the site (js/ts, python) | `must_not spec_mismatch`; `pre_existing: true` |

Tests shift `n`, `n+1`, `n-1` together (so a boundary pair `31`/`29` follows `30 -> 45` as `46`/`44`).

## Metrics (per operator and per repo)

- **Finding precision:** TP / (TP + FP) over high-confidence inline findings (`grade.js`).
- **Detection rate (A and B):** share of A-value, A-operator, B-value and B-boundary cases whose expected finding is matched.
- **Site recall (B-value, Partial):** confirmed sites named in the matched finding / confirmed sites (`expected.findings[].sites`, matched against the finding text).
- **False-alarm rate:** share of the three controls (no-op, consistent, pre-existing) that violate `must_not` (any `spec_mismatch`).
- **Pre-existing inline leak rate:** share of Control: pre-existing cases with an inline `spec_mismatch` (the summary section is allowed).
- **Trace delta:** each metric under `trace: off` versus `trace: auto`, the marginal value of traceability.

## Provisional gates

Re-calibrated after the first run; every change is recorded here with its reason.

| Metric | Gate |
|---|---|
| Finding precision | >= 90% |
| A/B detection | >= 70% |
| Control false-alarm rate | <= 10% |
| Pre-existing inline leak | <= 5% |

Recalibration log: none yet (no run has happened).
