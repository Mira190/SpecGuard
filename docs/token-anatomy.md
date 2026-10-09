# Token anatomy of simulated reviewer runs

Script: `eval/token/anatomy.js` (streams the JSONL transcripts, prints aggregates only). Re-run: `node eval/token/anatomy.js`.

## Method

- Source: sub-agent transcripts in `~/.claude/projects/C--Files-Projects-SpecGuard/*/subagents/agent-*.jsonl` (the `tasks/*.output` files are empty stubs). Reviewer runs are recognised by "acting as the review model inside a CI code-review Action". 96 runs parsed: 6 real-repo replays, 38 seeded tr1-tr23, 52 other (clean PRs, older regression cases such as js2/l1/p1/r1).
- Per API call, context size = `input_tokens + cache_read + cache_creation` from `usage` (exact). Cumulative input = sum of that over all calls (the no-caching figure).
- Static-prefix-cached model: first call full, every later call bills the first call's context at 10% and the rest at 100%. Full-cache cost-equivalent = `input + 0.1*read + 1.25*create` (what the API actually billed).
- Source attribution: the context growth between call i and i+1 is split among the items introduced in between (tool results by type, model text/tool arguments, the Write payload) proportionally to chars/4, then each item is charged once per later call. "base" = the first call's context (system prompt, tool schemas, hook context, kickoff message) re-sent every turn.
- Caveat 1: usage implies about 1.1-1.5 chars/token in this harness (prompt.md is 34.8k chars = about 9k tokens by chars/4 but the usage jump on the call after reading it is 32k). I report usage-scaled shares as primary and a pure chars/4 model as a cross-check. The lever ranking is the same under both.
- Caveat 2: the 36k "base" includes harness material that real CI will not have (ponytail hook text, deferred-tool list, Claude Code system prompt). Treat "excl. base" shares as the controllable part.
- Caveat 3: the simulated agents begin by Reading `prompt.md`, which costs a turn that the real Action does not need (the prompt is the user message). Its tokens are still re-sent every turn in both.

## Results (median / p90)

| group | n | turns | cum input tok, no cache | static-prefix cached | full-cache cost-equiv | output tok | findings.json tok |
|---|---|---|---|---|---|---|---|
| all | 96 | 5 / 7 | 334k / 476k | 205k | 98k | 1457 | 838 / 1388 |
| real-repo | 6 | 6 / 9 | 445k / 639k | 286k | 126k | 1807 | 1632 / 2200 |
| seeded | 38 | 5 / 6 | 335k / 414k | 206k | 99k | 1457 | 660 / 930 |
| other (clean+old) | 52 | 5 / 7 | 332k / 489k | 203k | 98k | 1396 | 1009 / 1388 |

Context per turn (median): 36.0k, 67.6k, 73.2k, 76.2k, 78.2k, 79.7k. The jump 36k to 68k is reading prompt.md (about 32k usage tokens). After that, each turn adds only 2-6k. A run is basically "carry about 70-80k for 5 turns".

Tool calls per run (median): Read 8 (real 7), Glob 1 (in 86 of 96 runs), Grep 3 (only runs that use it; real 3), Write 1. Calls per turn 2.1; 30% of turns have more than one call; max parallel 4-12. Parallelism is already used for the big read batch. The pattern is: T1 Read prompt.md, T2 Glob ctx dir, T3 batch-read all ctx files, T4 (optional) batch-read repo files or Grep, then Write, then final reply.

### Share of cumulative input tokens by source

| source | incl. harness base (usage-scaled) | excl. base (usage-scaled) | chars/4 model |
|---|---|---|---|
| harness base (system, tool defs, hooks) | 53.0% | - | - |
| prompt.md (skill + references + schema) | 37.7% | 80.0% | 72.2% |
| Glob listing of ctx dir | 3.3% | 7.1% | 8.8% |
| ctx diff.patch | 1.8% | 3.9% | 6.3% |
| model text + tool args | 1.2% | 2.6% | 3.0% |
| ctx trace-candidates | 0.7% | 1.6% | 2.6% |
| Grep outputs | 0.5% | 1.2% | 1.5% |
| final JSON Write payload | 0.5% | 1.1% | 1.8% |
| ctx requirements | 0.5% | 1.0% | 1.6% |
| repo file reads | 0.4% | 0.8% | 0.7% |
| standards.txt, files.txt, other ctx | under 0.2% | under 0.2% | under 0.3% |

Real-repo runs differ: prompt 37.1% (60.8% chars model), ctx diff 6.6% (18.1% chars model), Grep 2.1%, repo reads 1.3%. All file, Grep and Glob reads together are 7.4% overall and 12.9% for real repos. In short, the cost is the static prompt multiplied by the number of turns, not the evidence the reviewer gathers.

prompt.md section sizes (chars, 34.8k total): Procedure 7.1k; CI-mode JSON spec 4.9k; trace Findings 5.5k; trace Alignment 1.2k plus other trace sections about 3.5k; evidence reference about 4.7k; output refs about 1.8k; standards 2.0k; test-skeletons about 1.8k; Local mode report and local discovery about 0.8k (never used in CI).

### Wasted work

- Duplicate reads of the same file: 1 run in 96, 0.0% of cumulative input (0.6% in real replays). The agents do not re-read.
- Repo files read but never cited in findings: median 0 of 1-2 repo reads; 1.6% of repo-read tokens. Negligible.
- Glob of the ctx directory: 86 of 96 runs, about 1.5k tokens each, but it costs a whole serial turn (turn 2), which is the real waste: 3.3% direct plus the extra re-send of 68k+ context. The file list is already known to the harness.
- Empty or trivial ctx files (trace-candidates `[]`, empty standards.txt, "contents are empty" reminders): read in 88 of 96 runs. Token cost under 0.3% because they are parallel calls inside the same turn. They cost no extra turns.
- Turns before the first useful read (diff.patch or a repo file): median 2 (prompt read, then Glob).

### findings.json size and composition

Median 838 tokens (seeded 660, real 1632, max 2200), by chars: `reason` 24%, `quote` 14.7%, `body` 12%, `path` 9.1%, `obligation` 5.9%, `proves` 5.5%, `not_reviewed` 4.4%, `status` 3.7%, `source` 2.7%, `line` 2.4%, `requirements_source` 2.1%. Median 2 empty arrays per file. Output is about 0.4% of input volume, but output tokens are priced several times input, so it is roughly 2% of cost. Not a first-order lever.

### Effort vs. result quality (real replays, n=3 vs 3, anecdotal)

| | cases | turns | cum input | repo reads | output tok |
|---|---|---|---|---|---|
| hit | sqlglot-7036, rqlite-1722, rqlite-1556 | 9, 6, 8 (mean 7.7) | 639k, 500k, 609k (mean 583k) | 3, 0, 2 | 3173, 1065, 4076 |
| miss | sqlglot-7641, orpc-1961, orpc-2113 | 6, 5, 6 (mean 5.7) | 445k, 335k, 399k (mean 393k) | 1, 0, 1 | 2413, 1039, 1807 |

Hits used about 35% more turns and about 48% more cumulative tokens than misses. Misses are the cheapest runs, with orpc-1961 at the minimum turn count of 5 and no repo reads. Direction: exploration depth correlates with finding the bug. So do not cut exploration (Grep, repo reads, extra turns); cut fixed overhead that is paid every turn. With n=6 this is a hint, not a result.

## Ranked token-saving levers (estimated % of cumulative input tokens)

Estimates use the usage-scaled model (incl. harness base). In real CI the base is smaller, so each percentage on a lean base would be larger.

1. **Prompt compaction and conditional section inclusion.** About 32k of every turn's context is prompt.md. Drop Local-mode sections, include `trace.md` only if trace-candidates or requirements exist, include `evidence.md`/`test-skeletons.md` only when the diff touches tests or code with no tests, and tighten the CI JSON spec prose. A 35-45% cut saves about 13-17% of cumulative (28-35% of the controllable part). Quality risk: dropped rule text causes new false negatives or schema errors. Measure: rerun tr1-tr23 and the 6 replays with the compacted prompt, compare hit/miss and finding-level diffs, and track schema-validation failures.
2. **Remove the Glob turn and pre-inline the manifest.** Put the ctx file list (and file sizes) in the prompt so turn 1 is directly a batched Read. Saves one serial turn: about 73k of 334k, so about 20% (the 3.3% Glob output is included). Quality risk: none expected. Measure: turn count, identical findings.
3. **Pre-inline small ctx artefacts into the prompt** (diff.patch if under about 6k tokens, requirements, trace-candidates, files.txt, standards). Removes the batch-read turn too, taking a typical run from 5 turns to 3-4 (read repo files if needed, Write, reply). Worth another 15-20% on small PRs. Large diffs must stay file reads. Quality risk: the model skims inlined text (lost-in-the-middle). Measure: seeded tr cases hit rate.
4. **Cache-friendly prompt layout.** Put the static skill and references first and byte-identical across PRs, and the per-PR data last. The actual billed cost-equivalent is 98k vs 334k raw (-71%), but only the first call pays the 1.25x write if the prefix is shared; across PRs in the same window the 32k prompt becomes a cache read. Saves up to about 30-45% of billed cost on warm runs and none of the raw token count. Quality risk: none. Measure: `cache_read_input_tokens` share on call 1 across consecutive runs.
5. **Trivial-PR deterministic skip.** Clean PRs cost the same as real ones (median about 6 turns, 395-670k cum, 400k median). If a deterministic gate (docs-only, lockfile-only, test-only without behaviour change, rename) skips 20-30% of PRs, saves 20-30% of the total CI spend. Quality risk: missed bugs in "trivial" diffs. Measure: replay the corpus and check the gate never fires on a known bug case; log gate decisions in CI.
6. **Model tiering** (small model for the first pass or for gated-in clean-looking PRs; larger model only when the first pass flags or the PR is large). 30-60% of dollar cost on the tiered portion, no token reduction. Quality risk is the highest of all: hits needed 6-9 turns of careful exploration. Measure: the replay set with the small model; require equal hit rate before enabling.
7. **Instruct parallel batched reads for repo exploration.** Big read batches are already parallel, but real-repo hits used serial Grep/Read follow-ups (6-9 turns). Telling the model to issue all candidate Greps and Reads together saves 0-1 turn on real-repo runs: about 10-15% on those, about 3% overall. Quality risk: over-reading. Measure: turns and bytes read on the 6 replays.
8. **Pre-computed test map** (test file to source file mapping from the diff). Cuts Grep and repo reads, which total only 1-4% of cumulative tokens but drive the turn count on real repos. Maybe 1-5%, up to one saved turn. Quality risk: stale or wrong map causing wrong coverage claims. Measure: reviewer citations vs ground truth.
9. **Trim output verbosity** (shorter `reason`, no `quote` when the path and line are given, no `proves`/`not_reviewed` for covered rows, omit empty arrays). Findings JSON is about 840 tokens; a 30% cut is about 250 output tokens: under 1% of input, about 2% of cost. Quality risk: lower human readability and weaker auditability. Measure: downstream checker (`field`, `prove`) pass rates.
10. **Skip empty ctx files.** Under 0.3% because the calls are parallel. Do it only because it is free (omit the files from the manifest).

Not a lever: de-duplicating reads (0.0% observed).

## Bottom line

Per-turn cost is about 70-80k context, and typical runs take 5 turns. Cutting a turn is worth about 20%, and cutting the prompt by a third is worth about 13-17%. Evidence reading is under 8% of the total, so improving what the reviewer reads is not where the money is. Keep exploration for real repos, because hits spent more turns than misses.
