# SZZ replay manifests and rubric

Implements `docs/traceability-plan.md` section 7.4.3 (WP8). Tooling: `eval/szz.js` (mine), `eval/replay.js` (prepare and finish).

## Workflow

1. `node eval/szz.js mine --repo <clone> --since <date> --gh-repo owner/name --out eval/replay/<repo>.json` lists fix candidates and blames their deleted or modified production lines. Manifests hold metadata only (shas, PR numbers, titles, signals). Never commit third-party source.
2. A human or agent validates every (bug, introducing PR) pair: set `confirmed` (true/false) and `note` on the pair, **before** any replay.
3. Classify `scope` for each confirmed pair, without seeing SpecGuard output, with the rubric below.
4. `node eval/replay.js prepare` for each in-scope introducing PR, with the PR's title and body exactly as originally written, `--trace off` and `--trace auto`. An agent writes `ctx/findings.json`; `node eval/replay.js finish` posts it through the real `post.run` against a fake GitHub and prints counts. There is no pass or fail.
5. A human grades each replay against the later fix diff (`grade`).
6. `node eval/szz.js clean` draws a seeded noise baseline of non-fix, PR-sized commits from the same window. Report findings per PR on bug-introducing versus clean PRs.

## Manifest fields

Per candidate: `fix` (sha, parent, title, date, pr), `signals`, `issue`, `report_date` (+ source), `status` (`located`, `unlocatable`, `no_introducing`), `dropped` (filter counts), `introducing[]`. Per introducing entry: `sha`, `title`, `date`, `pr`, `lines` (blamed line count), `via` (`blame` or `revert`), and the human fields `confirmed`, `scope`, `grade`, `note`, all `null` until set.

`unlocatable` means the fix only added code, so there are no lines to blame. These are counted and reported, never guessed.
`report_date_source: fix_commit_upper_bound` means no linked issue was found, so the fix date stands in for the report date.

## Scope rubric (set `scope` to `in` or `out`)

In scope (SpecGuard could plausibly see it from the PR diff, its description and the repo's requirement docs):
- logic errors, wrong condition or operator, off-by-one, wrong default
- boundary and edge-case handling
- missing or wrong validation
- error handling (swallowed, wrong type, missing path)
- requirement mismatch: code disagrees with a spec, doc, issue or PR statement
- a missing or weak test of the behaviour the PR changed

Out of scope:
- config, environment or deployment problems
- integration timing, races that depend on external systems, flaky infrastructure
- performance
- UX or visual issues
- third-party or dependency defects, platform quirks
- pure refactors or typos with no behaviour change (set `scope: "out"`, note `no behaviour`)

When unsure, mark `out` and say why in `note`. Only `in` bugs enter the denominator; report `out` counts beside it.

## Grading rubric (set `grade` after replay)

- `direct`: a finding names the defective behaviour or the violated requirement.
- `indirect`: a `missing_test` or `weak_test` finding on the exact behaviour that later broke, such that a test written to that finding would have failed.
- `miss`: neither.

Only findings on the blamed or fixed lines, or naming the same requirement, count. Record inline and summary-only findings separately. Catch rate is (direct + indirect) / in-scope confirmed bugs with a Wilson 95% interval; report nothing as a rate below 30 in-scope confirmed bugs.

## Contamination caveat

All manifests here come from public repos. The model may have seen the later fix in its training data, so older fixes are suspect. Mining prefers fixes from the last few months. Report public and private pilots separately; private-repo results are the headline.
