# Field study: `src/trace.js` and `src/collect.sh` on real repositories

Status: measurement only. No `src/**` file was changed; every fix below is a recommendation.
Harness: `eval/field.js` (tests: `eval/field.test.js`). No LLM and no network were used at run time; `gh` is shimmed offline the same way `eval/local.js` does it.

Goal: find unknown unknowns (noise, scale, parsing gaps) in the deterministic stage before any model sees the output.

## 1. Method and caveats

- 12 public repositories were cloned with `git clone --depth 200 --no-tags` (kubernetes: depth 120) into a scratch directory outside this repo. Nothing third-party is committed.
- Discovery: `trace.classify` over every tracked `md mdx markdown rst adoc txt feature` file at the default-branch tip, then `parseItems` on the admitted docs.
- Per-commit runs: for each repo, the last 15 non-merge commits that touch a doc and a code file ("mixed") and the last 15 code-only commits ("code"), skipping root/shallow-boundary commits and commits over 200 files. For each, `BASE=parent HEAD=commit`, the real `src/collect.sh` ran inside the clone (it does `git checkout`; the clone is scratch and is reset between runs), then `src/trace.js` ran again alone on a copy of the context to time it separately. 333 runs (fewer than 360: guava has only 4 mixed commits in its window, curl 14, laravel none).
- Timeout: a run is "timed out" when collect.sh wall time reached 60 s. collect.sh's own `timeout 60` on trace.js is what produces the `requirement tracing failed; continuing without trace data` warning.
- Adjudication of discovered docs is manual: path rules in `eval/field.js` (`RULES`), written after reading the samples in the results file. Three verdicts: TP (testable product or system rules: specs, RFC 2119 prose, Gherkin, architecture constraints), BORDER (design/plan/proposal prose that mixes rules with rationale), FP (process text, changelog-like, API/CLI reference, tutorial, LLM prompt, template placeholder, test data, license text). "Strict" precision counts TP only; "lenient" counts TP+BORDER.
- Caveats. One Windows 11 machine, Git for Windows bash, Node 20.17. Other processes were running on the machine during the study (one orphaned `trace.js` from another session was at 2.8 GB RSS), so timings are upper-ish bounds and p95 values are noisy. Shallow clones. 9 early trace.js exits (within 0.1 s) on the first pass did not reproduce on retry (section 4, item 17); the table uses the retried rows.
- Results file (not committed): `scratchpad/field/results.json`. Regenerate: `node eval/field.js discover|measure|big|summary|adjudicate` (usage at the top of `eval/field.js`).

## 2. Repositories

Pins are the default-branch tip at study time (shortened SHA, commit date).

| repo | lang | licence | tip | tracked files | docs (ext) | classified | items | why |
|---|---|---|---|---|---|---|---|---|
| Fission-AI/OpenSpec | TypeScript | MIT | 9111a7654d 2026-10-06 | 1,287 | 729 | 265 | 3,157 | Has `openspec/specs/**/spec.md` with SHALL requirements and scenarios: the format the tool targets. |
| github/spec-kit | Python | MIT | 93989802b1 2026-10-08 | 903 | 165 | 48 | 261 | Spec-driven-development docs, a constitution with MUST rules, many LLM prompt templates (a trap). |
| OAI/OpenAPI-Specification | Markdown/JS | Apache-2.0 | aebfd13708 2026-10-04 | 120 | 60 | 17 | 899 | RFC 2119 prose, tables of fields, 12 versioned copies of the same spec (10 of them classified), two docs over 256 KB. |
| kubernetes/enhancements | Go/YAML | Apache-2.0 | 8659e382ef 2026-10-08 | 2,306 | 718 | 563 | 2,000 | ~560 KEP design docs from one template (scale of design docs), symlinks. |
| cucumber/cucumber-ruby | Ruby | MIT | ff5f86a628 2026-10-08 | 643 | 173 | 92 | 579 | Gherkin `.feature` files, i18n examples, an ISO-8859-1 feature. |
| fastapi/fastapi | Python | MIT | f5c6e9b4f9 2026-10-08 | 3,182 | 1,705 | 26 | 88 | No requirement docs: tutorials in ~20 languages (non-English), LLM translation prompts. |
| expressjs/express | JavaScript | MIT | 9efc29e280 2026-10-06 | 214 | 15 | 1 | 6 | Small repo, no requirement docs. |
| BurntSushi/ripgrep | Rust | Unlicense/MIT | 3fce3b5bb0 2026-08-04 | 237 | 24 | 2 | 6 | No requirement docs; a symlink; a binary-ish doc. |
| google/guava | Java | Apache-2.0 | 1da08c4d38 2026-10-08 | 3,363 | 18 | 2 | 84 | Large Java tree, almost no docs; test-data `.txt` files. |
| curl/curl | C | curl (MIT-style) | 424aa994ac 2026-10-08 | 4,563 | 963 | 348 | 498 | No requirement docs by intent; ~280 man-page option docs (YAML front matter), `.txt`/CMake files. |
| laravel/framework | PHP | MIT | 848f3edfc0 2026-10-09 | 3,477 | 49 | 0 | 0 | Control: no docs at all. 0 mixed commits in the window. |
| kubernetes/kubernetes | Go | Apache-2.0 | f322464da4 2026-10-08 | 31,366 | 625 | 14 | 70 | Biggest repo (31k files) for scale; vendored docs, generated test data. |

Coverage: 9 languages, 5 repos with requirement-like docs (OpenSpec, spec-kit, OpenAPI-Specification, enhancements, cucumber-ruby), 7 without, sizes from 214 to 31,366 tracked files. Hazard scan over all 12 tips: symlinks 14 (none in a doc that matters), submodules 0, CRLF docs 1, BOM docs 0, non-UTF8 docs 1, docs over 256 KB 41 (34 generated, in kubernetes).

## 3. Results

### 3.1 Time and size per run (333 runs)

| group | runs | wall p50 / p95 / max (s) | trace.js alone p50 / p95 / max (s) | runs reaching 60 s |
|---|---|---|---|---|
| all | 333 | 4.4 / 59.4 / 117.9 | 0.4 / 8.3 / 120 (killed) | 17 |
| all except kubernetes | 303 | 4.0 / 19.2 / 76.7 | 0.4 / 8.6 / 120 (killed) | 6 |
| mixed (doc+code) | 153 | 5.5 / 61.3 / 76.7 | 0.5 / 44 / 120 (killed) | 10 |
| code-only | 180 | 4.2 / 54.8 / 117.9 | 0.3 / 1.1 / 2.5 | 7 |

- Crashes: 0 reproducible. 6 runs hit the 60 s trace timeout (OpenAPI-Specification 3, enhancements 2, cucumber-ruby 1) and degraded to "no trace data". 7 runs printed `requirement tracing failed`. 9 first-pass runs (curl 4, laravel 4, OpenAPI 1) exited in under 0.1 s and passed on retry (item 17).
- Index and candidates, successful runs: `requirements-index.md` p50 2.1 KB, p95 43 KB (cap is 60 KB); `trace-candidates.json` p50 2.0 KB, p95 34 KB, max 510 KB. Candidates per hunk: p50 5 (the cap), i.e. every hunk with any lexical overlap gets a full list. S items per mixed commit: p50 0, p95 2, max 18; 23 of 153 mixed commits had at least one S item (81 in total). Occurrence rows: p50 0, max 63 (one KEP edit).
- Trace cost grows with S, not with repo size: commits with S > 0 have trace p50 8.1 s (n=23), commits with S = 0 have p50 0.4 s.
- `requirements-index.md exceeded 60 KB; it lists only candidate and changed items.` was emitted in 143 of 333 runs (43%), including runs whose index was 1 KB. `N requirement documents skipped by the 500-file limit` appeared in 25 runs (enhancements: 563 docs, 63 dropped, silently ranked last).

Per repo (mixed commits | code-only commits; times in seconds):

| repo | mixed n | wall p50 / p95 | trace p50 / p95 | S max | cand p95 (B) | tokens p95 | code wall p50 / p95 |
|---|---|---|---|---|---|---|---|
| OpenSpec | 15 | 4.6 / 34.2 | 0.8 / 27.7 | 18 | 48,103 | 12.9k | 4.0 / 6.0 |
| spec-kit | 15 | 3.6 / 14.8 | 0.5 / 12.2 | 4 | 20,677 | 16.1k | 2.5 / 2.7 |
| OpenAPI-Specification | 15 | 1.3 / 62.6 | 0.3 / 120 (3 killed) | 57 (measured off-harness) | 5,241 | 2.0k | 1.1 / 1.3 |
| enhancements | 15 | 11.4 / 68.5 | 8.1 / 117 (2 killed) | 16 | 290,803 | 73.1k | 4.4 / 4.7 |
| cucumber-ruby | 15 | 1.7 / 25.6 | 0.3 / 37.8 (1 killed) | 2 | 12,384 | 4.1k | 1.4 / 1.5 |
| fastapi | 15 | 6.0 / 7.2 | 0.8 / 1.0 | 0 | 11,166 | 8.0k | 5.7 / 7.7 |
| express | 15 | 1.7 / 2.4 | 0.3 / 0.4 | 0 | 1,442 | 0.5k | 1.3 / 1.8 |
| ripgrep | 15 | 1.5 / 2.3 | 0.3 / 0.3 | 0 | 10,382 | 2.8k | 2.1 / 2.9 |
| guava | 4 | 6.6 / 7.0 | 0.2 / 0.3 | 0 | 18,698 | 8.6k | 6.3 / 10.5 |
| curl | 14 | 13.7 / 21.4 | 1.1 / 16.3 | 4 | 31,181 | 8.5k | 13.5 / 22.8 |
| laravel-framework | 0 | - | - | - | - | - | 11.5 / 13.7 |
| kubernetes | 15 | 53.3 / 65.1 | 0.4 / 0.6 | 0 | 49,561 | 14.5k | 56.6 / 117.2 |

The kubernetes wall time is not trace.js. It is two bash loops in collect.sh (item 7): 31k paths x ~30 `match` patterns took 40 s per loop in Git for Windows bash; the loop runs on BASE and on HEAD.

### 3.2 Largest commit and full-range diffs on the biggest repo (kubernetes, 31,366 files)

trace.js alone, run directly with `BASE_SHA/HEAD_SHA/CTX` (not through collect.sh):

| diff | changed files | diff size | trace.js | hunks with candidates | trace-candidates.json | tokens (index + candidates, bytes/4) |
|---|---|---|---|---|---|---|
| largest commit in window (a58f772aa0) | 579 | 2.9 MB | 3.2 s | 386 | 379 KB | 96.9k |
| last 20 commits (a3589c024a...f322464da4) | 313 | 7.1 MB | 4.2 s | 290 | 278 KB | 71.5k |
| last 100 commits (4f6984bad6...f322464da4) | 1,246 | 13.1 MB | 32.0 s | 942 | 902 KB | 227.5k |

trace.js scales fine in time on a big diff (no S items, so no requirement-to-code work). The output does not: every hunk carries its own 5-candidate list, with no floor and no cap on hunks. Those 386 hunks reference only 8 distinct requirement items, all in FP docs (cri-api README, client-go ARCHITECTURE).

### 3.3 Prompt-size implication

Estimate: tokens = (bytes of `requirements-index.md` + `trace-candidates.json`) / 4, against a 200k context budget. The diff (cap 300 KB, about 75k tokens), SKILL.md and references come on top.

| case | tokens | share of 200k |
|---|---|---|
| p50, all runs | 1.4k | 0.7% |
| p95, all runs | 12.9k | 6% |
| p95, mixed commits | 17.0k | 8.5% |
| max, enhancements KEP edit (S=1, 63 occurrence rows, 510 KB of candidates) | 128k | 64% |
| OpenAPI-Specification 510dfb4ff5 (S=57), measured off-harness | 328k | 164% (over budget) |
| kubernetes, 100-commit range | 227k | 114% (over budget) |

Conclusion: the common case is cheap (p95 is about 6-9% of the budget). The tail is the problem and it comes from three unbounded outputs: one candidate list per hunk, one `requirement_to_code` block per S item, and up to 50 occurrence rows per delta value. With the 75k-token diff cap added, a p95 mixed run is about 92k tokens (46%). A whole-document S item (128k), S=57 (328k) or about 900 hunks (227k) do not fit once the diff is added. Items 2, 4 and 13 below cap these.

### 3.4 Discovery precision (doc level)

Hand adjudication of all 1,378 classified docs (path rules, reasons in `eval/field.js`):

| repo | classified | TP | BORDER | FP | strict | lenient | items | items in FP docs | noise items (whole-doc or boilerplate) |
|---|---|---|---|---|---|---|---|---|---|
| OpenSpec | 265 | 196 | 56 | 13 | 74% | 95% | 3,157 | 46 | 3 |
| spec-kit | 48 | 6 | 1 | 41 | 13% | 15% | 261 | 180 | 1 |
| OpenAPI-Specification | 17 | 15 | 0 | 2 | 88% | 88% | 899 | 4 | 0 |
| enhancements | 563 | 2 | 557 | 4 | 0% | 99% | 2,000 | 36 | 579 |
| cucumber-ruby | 92 | 85 | 6 | 1 | 92% | 99% | 579 | 3 | 1 |
| fastapi | 26 | 0 | 0 | 26 | 0% | 0% | 88 | 88 | 0 |
| express | 1 | 0 | 0 | 1 | 0% | 0% | 6 | 6 | 0 |
| ripgrep | 2 | 0 | 0 | 2 | 0% | 0% | 6 | 6 | 0 |
| guava | 2 | 0 | 0 | 2 | 0% | 0% | 84 | 84 | 0 |
| curl | 348 | 0 | 8 | 340 | 0% | 2% | 498 | 476 | 52 |
| laravel-framework | 0 | - | - | - | - | - | 0 | 0 | 0 |
| kubernetes | 14 | 0 | 2 | 12 | 0% | 14% | 70 | 62 | 1 |
| total | 1,378 | 304 | 630 | 444 | 22% | 68% | 7,648 | 991 (13%) | 637 (8%) |

- In the 5 repos that have requirement docs: 985 classified, strict 31%, lenient 94%. The strict number is dragged down by enhancements, where I classed every KEP README as BORDER (design doc) because the items the tool extracts from them are mostly the title and template boilerplate, not requirements. See the next bullets for the other cuts.
- In the 7 repos without requirement docs: 393 docs classified, 383 are FP (97%); 10 are BORDER. The tool "finds" requirement docs in every repo that has any prose with "must": express (release history), ripgrep (user guide), guava (a novel), curl (340 docs), kubernetes (12), fastapi (26).
- Excluding enhancements and curl (the two where one systematic bug dominates), strict 65%, lenient 79% over 467 docs.
- Item-level noise, heuristic regexes over all 7,648 items: 13% sit in FP docs, 8% are whole-document or template boilerplate items (KEP titles, "Note: Any PRs to move a KEP..."), 13% mention process words (PR, commit, review, release), 4% are second-person or "we", under 1% marketing words. Among the 81 S items produced in the 333 runs, 30 (37%) are obvious noise by rule: 23 KEP title or `[KEP-n]:` link-reference items, 4 bare `Example:` pseudo-scenarios, 3 hits on `must` inside the identifier `triage-must-have`. The rest are mostly genuine (all 23 OpenSpec S items are real added SHALL scenarios; curl's 4 are real "must be PEM" statements from API man pages).

Recall (requirement docs missed, found by scanning unclassified docs for RFC 2119 words, Gherkin keywords and 3+ "must/shall"):

| missed | where | why |
|---|---|---|
| The current spec | OAI/OpenAPI-Specification `versions/3.2.0.md` (296 KB), `3.2.1.md` (298 KB) | over the 256 KB limit, silently, no limitation (item 5). Older versions 3.0.x and 3.1.x are indexed. |
| Single-requirement spec files | OpenSpec `openspec/changes/archive/2025-08-13-add-diff-command/specs/cli-diff/spec.md`, `.../specs-sync-skill/spec.md` | only 1 normative sentence, no Scenario block: the "2 normative sentences" rule misses them. |
| WHEN/THEN style behaviour spec | the cli-diff spec above | uses `WHEN ... THEN ... AND` lines with no shall/must (EARS-style without SHALL). |
| Docs with an odd number of code-fence lines | enhancements KEPs 3352, 2896, 213; spec-kit `extensions/EXTENSION-DEVELOPMENT-GUIDE.md`; OpenAPI proposals/2019-07-17-Webhooks.md | fence-parity inversion (item 6); about 12 docs in the 12 repos. |
| RFC-style bullet lists | OpenSpec `docs-lab/reference/schemas/spec-driven/index.md` (10 RFC words, 0 items) | list items that start with an imperative ("Use SHALL/MUST ...") are dropped by the process-text filter. This one is meta-documentation of the format, so arguably correct. |
| Gherkin in README code | cucumber-ruby README.md (2 Scenario lines in a fence) | correct skip. |
| JSON schema and OpenAPI descriptions | 0 files in these repos (kubernetes has `api/openapi-spec`); the tool never reads `json/yaml` | by design (extension list); not measured further. |

Parsing hazards, covered by real files or synthetic repos run through the real collect.sh:

| hazard | result |
|---|---|
| CRLF spec (synthetic) | OK: same S item as LF. |
| UTF-8 BOM + CRLF (synthetic) | OK. |
| Latin-1 spec (synthetic, "reçu") | OK, one decoded replacement char in the text only. |
| Latin-1 real file (cucumber-ruby `features/docs/iso-8859-1.feature`) | classified; item text contains U+FFFD. Cosmetic. |
| Chinese spec and a Chinese path (synthetic, `docs/规则.md`) | OK; deltas lose the unit (`30` not `30天`). |
| Path with spaces (synthetic) | OK. |
| Symlinked doc (synthetic `docs/alias.md -> spec.md`) | OK, ignored. Real symlinks in enhancements (8), kubernetes (5), ripgrep (1) were skipped. |
| Submodules | none tracked in the 12 repos; `.gitmodules` is excluded by rule. |
| Huge generated docs | 34 files over 256 KB in kubernetes are skipped; none of the skips is reported. |
| RFC 2119 docs | handled (OpenAPI 3.0-3.1: 85-120 items each). |
| Markdown tables of rules | broken pairing (item 12). |
| Non-English | `必须` is matched, but the second-person filter is English-only (item 9). |

## 4. Bugs and gaps, ranked by expected impact on false positives, crashes and cost

Impact rank takes into account how often it fired in the 12 repos and how bad the consequence is (a mandatory S criterion with no code change is a guaranteed false alarm; a timeout silently drops the whole feature). Repros are shell commands; `<clones>` is the study directory. Repos are at the tips listed in section 2.

1. **Bare `Example:` is treated as a Gherkin scenario in any file.** `GHERKIN = /^\s*(...|Example(?!s))\s*:/` also matches `Example:` in Markdown prose and in YAML front matter. Any such line makes the document a requirement doc (the "any Gherkin" rule) and the line an item with `kind: gherkin`.
   - Evidence: curl, 280 man-page option docs `docs/cmdline-opts/*.md` (front matter `Example:`), 340 of 348 classified curl docs are FP; fastapi (llm prompts), spec-kit (`Example: ```bash`), 4 of 81 S items. Editing any such doc makes a mandatory S criterion.
   - Repro: `git -C <clones>/curl checkout 424aa994ac && HEAD_SHA=424aa994ac node src/trace.js classify docs/cmdline-opts/anyauth.md` prints the path. Synthetic: `docs/opt.md` containing `---\nExample:\n- --foo $URL\n---\n# --foo\nDo foo.` then editing the prose yields S1 `ref: "Scenario: "`.
   - Fix: recognise Gherkin keywords only in `.feature` files, or in other files only when `Feature:`/`Scenario:`/`Scenario Outline:` is followed within 3 lines by a `Given|When|Then|And|But` step. Never accept `Example:` outside `.feature`. Also ignore YAML front matter (`---` block at the top) when parsing.

2. **A document-title ID makes the whole document one item.** `# KEP-2400: Title` matches `ID_LINE`; because the line is a level-1 heading the item runs until the next level-1 heading, which is the end of the file. 424 of 2,000 items in enhancements span at least half of their document (longest 3,449 lines).
   - Consequences: any edit anywhere in a KEP is a "modified normative item" (S item), the `deltas` contain every number and identifier that changed in the file (up to hundreds), each removed value triggers a repo-wide `git grep` (63 occurrence rows for one edit), trace time rises to 5-44 s, and `trace-candidates.json` reached 510 KB (128k tokens) for a single S item. 23 of 81 S items are of this kind.
   - Repro: `git -C <clones>/enhancements show 8659e382ef:keps/sig-node/2400-node-swap/README.md` gives one `id` item, lines 1-1436. Run: commit `32f6337100` in enhancements (`BASE=32f6337100^ HEAD=32f6337100 node src/trace.js` after `git checkout`). Synthetic: `# KEP-7: Swap support` + sections, change an unrelated paragraph: S1 `ref: KEP-7`, empty deltas.
   - Fix: (a) do not treat a level-1 heading (document title) as an ID'd item; (b) cap an ID'd item's span (for example the heading line plus its first paragraph, or at most 40 lines); (c) cap `deltas` to about 20 values and skip the occurrence search for items with more.

3. **Markdown reference-link definitions are ID'd items.** `[KEP-4671]: Gang Scheduling.` and `[RFC-2119]: https://...` match `ID_LINE` through the allowed `[...]` wrapper. Among the 81 S items they account for the rest of the 23 KEP noise items (enhancements commits `15907f2da2`, `d350f1d7e2`).
   - Repro: any Markdown file with `[KEP-4671]: https://github.com/...`; real: enhancements commit `15907f2da2` (items `[KEP-4671]`, `[KEP-5710]`, `[KEP-5732]`, `[KEP-6089]` of `6276-integrate-workload-with-deployment/README.md`).
   - Fix: do not accept the `[ID]:` form when what follows is a URL, a path or an anchor (a reference definition); keep `[ID]` wrapping only when followed by prose.

4. **trace.js time is O(S x tree) and has no budget; 6 of the 153 mixed runs hit the 60 s limit, all PRs with many or large requirement changes.** `requirementToCode` runs, per criterion, `transitiveTests` for each of the top 8 windows: one repo-wide `git grep` with 12 patterns, then up to 20,000 hit lines times 12 freshly built `RegExp` objects. Cost is about 1.4-11 s per S item here (OpenSpec 2.7-3.7 s per item, a single S item in enhancements 4.5-20 s). Observed: OpenAPI-Specification (3 of 15 mixed commits), enhancements (2), cucumber-ruby (1) exceeded 60 s; the pipeline then continues "without trace data" with only a warning, so the highest-S (most requirement-heavy) PRs get no candidates at all.
   - Repro: OpenAPI-Specification, `git checkout 510dfb4ff5; BASE_SHA=510dfb4ff5^ HEAD_SHA=510dfb4ff5 CTX=<tmp> node src/trace.js` (S=57). Unmodified: 96 s and 83 s in two harness runs, killed at 300 s once while the machine was loaded. V8 `--prof`: 84% of ticks inside node.exe itself, top JS frames `transitiveTests` and RegExp construction. Hoisting the RegExp objects (scratch copy, not applied) still took 143 s (S=57, 96 occurrence rows, a 1.3 MB `trace-candidates.json`, 328k tokens), so regex construction is not the main cost; the per-criterion repo-wide `git grep` and window scoring are.
   - Fix, in order: run the transitive-test grep once per commit with the union of identifiers (not per criterion per window); process at most about 20 S items by rank and record the rest in `limitations`; add a wall-clock budget inside trace.js (about 45 s) that writes the partial results it has (index, spec-files, criteria) instead of being killed with nothing; skip `transitiveTests` for criteria with no deltas.

5. **Documents over 256 KB are skipped silently.** `discover` filters `e.size <= MAX_FILE` with no limitation record, unlike the other caps. In OpenAPI-Specification the current spec versions `3.2.0.md` and `3.2.1.md` (296/298 KB) are invisible while 3.0.x and 3.1.x are indexed. Editing the 300 KB spec in a synthetic repo gives S=0, no limitation, no warning.
   - Repro: `git -C <clones>/OpenAPI-Specification checkout aebfd13708 && HEAD_SHA=aebfd13708 node src/trace.js classify versions/3.2.1.md` prints nothing; `versions/3.1.2.md` is printed.
   - Fix: add a limitation line `requirement-like document over 256 KB not parsed: path` (names and sizes, capped at 10), and for files matching the hint patterns (`spec`, `versions/`, RFC words) parse the first 2 MB.

6. **Code-fence parity inversion.** `parseItems` toggles on every line starting with a triple backtick or tilde. A line such as ``` ``` <<[UNRESOLVED ... ]>> Stuff ``` ``` (the KEP template, and any inline triple-backtick text) opens a fence that never closes, so for the rest of the file prose is "fenced" and code blocks are parsed as prose. Closing fences must be a bare fence line with the same character and at least the same length.
   - Evidence: 12 docs in these repos have an odd fence count (7 outside CHANGELOG files); KEPs `3352-aggregated-discovery` (14 "must" sentences, 0 items) and `2896-openapi-v3` are missed completely, and spec-kit `EXTENSION-DEVELOPMENT-GUIDE.md` and the OpenAPI Webhooks proposal are parsed inverted.
   - Repro: `node -e` with `parseItems('x.md', ...)` on `git show 8659e382ef:keps/sig-api-machinery/3352-aggregated-discovery/README.md` returns 0 items; line 38 starts the bad fence.
   - Fix: CommonMark rule: closing fence = same character, length at least the opening length, no info string; an opening fence line with trailing ``` on the same line is not an opener.

7. **collect.sh is O(files x patterns) in bash, twice.** Step 2 loops `git ls-tree -r -z --name-only` for BASE and HEAD and calls `match` against about 30 globs per path in pure bash. On kubernetes (31,366 files) one loop took 40.2 s in Git for Windows bash (measured in isolation: `bash loop.sh <sha>`), so collect.sh took 53 s p50 and 117 s max, and 11 of 30 runs exceeded the 60 s mark, although trace.js needed 0.4 s. This part is not under `timeout 60`. Linux runners are probably several times faster, but the loop is still two passes of 31k x 30 shell tests; the figure was not measured on Linux.
   - Repro: `git -C <clones>/kubernetes checkout f322464da4~1; BASE_SHA=f322464da4~1 HEAD_SHA=f322464da4 CTX=<tmp> time bash src/collect.sh`.
   - Fix: filter in one process: `git ls-tree -r -z --name-only "$SHA" | node -e '...'` using trace.js `matchGlob`, or `git ls-tree` with a small `-- ':(glob)**/AGENTS.md' ...` pathspec list; the STANDARDS/EXEC_CFG lists are short and mostly fixed names.

8. **`.txt` and test fixtures are "documents".** `DOC_EXT` includes `txt`, so `CMakeLists.txt` (curl: classified with 2 items from `# FIXME ... must specify` comments), license texts in `LICENSES/*.txt` (named by SPDX id, so the `LICENSE*` exclusion misses them: "IN NO EVENT SHALL ..."), `requirements.txt`-style files, and test data (guava `alice_in_wonderland.txt`, two copies, 42 "shall" items from a novel) are classified, and hunks in any `.txt` file are removed from the code side (`!DOC_EXT.test(h.path)`).
   - Fix: classify `.txt` only outside test/testdata/fixtures paths and not for names `CMakeLists.txt`, `requirements*.txt`, `CMakeCache.txt`, `*.cmake.txt`, `LICENSES/**`, `COPYING*`; do not drop `.txt` hunks from `code_to_requirement` unless the file was actually classified as a spec.

9. **Second-person/process filter is English-only.** `SECOND_PERSON` knows `you|your|please`; Chinese tutorials say `你必须...` and pass. 19 of 26 fastapi classified docs are Chinese tutorials (all FP). English tutorials ("the client must send username and password") also pass because they are descriptive, not second-person.
   - Fix: add CJK second-person markers (`你`, `您`, `我们`) and the usual German/French/Spanish/Japanese pronouns only if a case demands it; more effective: weight the doc-type, for example require at least 2 normative sentences in a doc whose path contains `tutorial`, `guide`, `howto`, `getting-started`, `blog` or a language-code directory, and never admit `docs/<lang>/` translations when an `en` twin exists.

10. **`must` and `shall` inside identifiers count as normative.** `\b(shall|must)\b` matches `triage-must-have`, `--must-staple`, a branch or label name in backticks. 3 of the 81 S items (spec-kit `b49bb5f020`, `9fb13c1571`, `1111ee59ca`) are of this kind.
    - Fix: strip inline code spans and use `(?<![\w-])(shall|must)(?![\w-])` before testing.

11. **Gherkin docstrings are not respected.** In `.feature` files `Scenario:` lines inside `"""` docstrings (very common in cucumber's own tests) start new items: `features/docs/cli/backtraces.feature` has 1 outer scenario and yields 3 items, and an edit in the outer scenario is attributed to `Scenario: Nested`.
    - Repro (synthetic, S1 `ref: Scenario: Nested`): see the `docstring` probe; real file at cucumber-ruby `ff5f86a628`.
    - Fix: skip lines between `"""` (or three backticks) pairs when scanning Gherkin keywords.

12. **Markdown tables of rules pair by ordinal.** A table is one paragraph, so the first "sentence" swallows the header, and refs are `heading#n`; inserting one row at the top of a 3-row table marks two unrelated rows as modified, with deltas `10 MB` removed/added, and then searches the repo for `10 MB`. The new row is not reported as added.
    - Repro: synthetic `docs/rules.md` probe (`table`), 3 rows, insert a row first: S1 `rules#1` modified (removed `10 mb`), S2 `rules#2` modified (added `10 mb`).
    - Fix: split a table into one item per row (the first cell is a natural ref if it looks like an ID, else a hash of the row text), and pair by that ref.

13. **Candidate output has no relevance floor and no size cap.** Top 5 per hunk is always filled when there is any token overlap. In repos with no requirement docs every hunk still gets 5 "requirements" (kubernetes: top-1 score p50 13.7, from 14 FP docs; express p50 2.4; curl 17.1; spec-kit 16.8; OpenSpec 22.0). Generated or fixture files count as code hunks (kubernetes `staging/.../testdata/*.yaml` hunks match `cri-api/README.md`). The "15 unique per PR" cap is applied to which items are kept, but the per-hunk records still repeat: 386 hunks gave 379 KB, 942 hunks gave 902 KB (227k tokens).
    - Fix: (a) relative floor, for example drop a candidate below max(8, 0.4 x best score in the PR), which separates express/ripgrep/guava (top-1 under 6) from real spec repos (over 10) but does not separate curl or kubernetes; (b) exclude `testdata/`, `fixtures/`, `__snapshots__/`, generated and binary-like paths from code hunks; (c) cap hunks at about 40 by best score and emit a table of distinct candidate items plus `hunk -> item ids` instead of repeating records.

14. **Doc moves and renames generate mandatory criteria.** collect.sh and trace.js both use `--no-renames`, so a moved requirement doc is `removed` + `added` for every item. A pure `git mv docs/spec.md docs/requirements/spec.md` of a 2-item doc produced S1-S4 (2 added, 2 removed), `nchanged=4`, and the skip rule did not apply: a PR with no behaviour change is sent to the agent with 4 mandatory criteria. OpenSpec archives changes by moving specs, so this is routine there.
    - Repro: synthetic `rename` probe (code unchanged, one doc moved).
    - Fix: after pairing, drop an added item and a removed item whose normalized text is identical (cross-path), and treat a path pair that git detects as a rename (`-M90%`) as one doc.

15. **Near-duplicate versioned docs inflate the index.** OpenAPI-Specification has 12 copies of the spec (`versions/1.2.md` ... `3.2.1.md`); the 10 that are classified add 59-120 items each, about 880 index lines. A hunk matches the oldest copy as readily as the current one; the index spends tokens on duplicates.
    - Fix: collapse items with identical normalized text across documents into one index line with a "also in" list, or rank docs from the highest version first.

16. **Caps drop requirement docs without ranking by relevance.** The 500-doc cap in enhancements dropped 63 KEPs in 25 runs; `keps/` is not a rank hint, so ordering is alphabetical within the same rank. The "index exceeded 60 KB" limitation fires in 43% of runs even when the written index is 1 KB (it describes the pre-filter size). Low severity; the limitation text is noise for the agent.
    - Fix: rank by BM25 overlap with the PR before the cap; reword to "index limited to candidates (full index was N KB)" and emit it only when it hides at least one item the PR could use.

17. **Early trace.js exits that did not reproduce (unresolved).** 9 first-pass runs (curl code commits 954065b77c, 55652ad0de, 64fb3e7a7b, d8363b7720; laravel 40c0d0b1d5, dc3455f165, 68e78fe401, d73760a879; OpenAPI 95e0f7e872) exited within 0.1 s with status 1 (one -1) and collect.sh printed `requirement tracing failed`. They ran clean on retry (same SHAs, trace 0.4-2.5 s). The harness kept only the stderr tail (a Node stack frame), so the message was lost; the harness now keeps the head. They coincide with a 2.8 GB trace.js from another session running on the machine, so memory pressure is the likeliest cause, but this is not proven. Treat as an open question. The harness had only the warning lines and the trace.js stderr tail; the collect log was not kept.
    - Fix: have `collect.sh` print the first 3 stderr lines of a failed trace run next to the warning. The harness now also keeps the head of the collect log when a warning is printed.

Not bugs, checked and fine: CRLF, BOM, Latin-1, CJK path and text, spaces in paths, symlinked doc, empty repo window, 31k-file repo for trace.js itself (0.4 s p50, 0.9 s max), code-only commits (trace p95 1.1 s).

## 5. What to do first

1. Items 1, 2, 3 (precision of what counts as a spec item): each fires without any model and creates mandatory S criteria with no real requirement change. Together they remove most S-item noise (30 of 81 here) and most of the 424 whole-document items.
2. Items 4 and 13 (cost and size): without them, the PRs that matter most (many changed requirements) time out or overflow the 200k budget.
3. Items 5 and 6 (silent recall holes), then 14 (renames), 7 (collect.sh loop), 8-12.
4. Add the discovery fixtures from section 3.4 as committed micro-cases (a front-matter `Example:` doc, a KEP-like title doc, a `[KEP-1]: url` link definition, an odd-fence doc, a 300 KB spec, a moved spec, a table of rules, a docstring feature) so each fix has a regression test; the synthetic probes used here are small enough to inline.

## 6. Reproduce

```
node eval/field.js clone    --dir <clones>
node eval/field.js discover --dir <clones> --out discover.json
node eval/field.js adjudicate --out discover.json
node eval/field.js measure  --dir <clones> --out measure.json -n 15
node eval/field.js summary  --out measure.json --discover discover.json
node eval/field.js big      --dir <clones> --repo kubernetes --out big.json
node --test eval/field.test.js
```

`measure` takes about 1 h on this machine (kubernetes is most of it). `big` times the largest commit; the 20- and 100-commit range runs in section 3.2 were run with the same `trace.js` invocation by hand (`BASE_SHA=<tip~N> HEAD_SHA=<tip> CTX=<dir> node src/trace.js` with the clone as cwd).
