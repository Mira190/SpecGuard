# A/B harness for reviewer prompt variants

Compares prompt variants on identical inputs: quality (real `post.run`, graded) and token cost (sub-agent transcripts). `node eval/ab.js` has three subcommands.

## Workflow

1. Prepare inputs once with `eval/local.js prepare` or `eval/replay.js prepare` (output dir `OUT` holds `<id>/{repo,ctx,meta.json}`).
2. `node eval/ab.js setup --src OUT --ids r1,t1 --ab ABDIR --variant v2=<skill worktree> --variant lean=<lean worktree>`
   - Per variant and id: `ABDIR/<variant>/<id>/{ctx,meta.json,prompt.md,task.md}`. ctx is a copy without `findings.json`/`engine-status*`; `meta.repo` still points at the shared source repo (never copied); the prompt is built against the variant's ctx path (setup fails if it points elsewhere).
   - The prompt builder is auto-detected: `<worktree>/src/prompt.js` (`assemble`, copilot wording, that worktree's schema) else `<worktree>/eval/local.js` `buildPrompt(ctx)`. The first `--variant` is the baseline for paired comparisons.
   - Also writes `ABDIR/manifest.json`.
3. The orchestrator spawns one simulated reviewer agent per manifest entry, passing the contents of its `task.md` (prompt path, ctx, shared repo, read rule, 30-turn cap). Each writes `ABDIR/<variant>/<id>/ctx/findings.json`. Keep the agent model identical across variants.
4. `node eval/ab.js finish --ab ABDIR [--post-root MAINREPO]` runs the real `src/post.js` of `--post-root` (default this repo) against a fake GitHub. Ids with `eval/cases/<id>/case.json` are graded (pass, TP/FP/FN, text, summary, must_not); other ids (real PRs) only get finding counts. Prints a side-by-side table plus per-variant totals and writes `results.json`. Runs without `findings.json` show as `engine failed`.
5. `node eval/ab.js tokens --ab ABDIR` parses `~/.claude/projects/C--Files-Projects-SpecGuard/*/subagents/agent-*.jsonl` with `eval/token/anatomy.js`'s `parse` (loaded, not copied), matches each run by the `ABDIR/<variant>/<id>` path in its kickoff message (newest transcript wins on reruns), and reports per variant: runs, median/mean turns, cumulative input tokens (no cache and static-prefix cache), first-turn context, output tokens; then paired deltas (variant minus baseline) over ids both completed. Writes `tokens.json`. `--transcripts a.jsonl,b.jsonl` overrides discovery.

## Reading the numbers

- Constant across variants: system prompt, tool schemas, hook context and the `task.md` wrapper (inside the first-turn context, re-sent every turn), plus the extra turn spent reading `prompt.md`. Differences come from prompt size and the turns and tool results the prompt induces.
- Quality grading is per-run on one sample of a stochastic agent; with small n treat deltas as hints, not results. Rerun the same ids to see noise.
- Reviewer transcripts are recognised by "review model inside a CI code-review Action" in `task.md`; keep that sentence.

## Free-form competitor stand-ins (`--prompt-file`)

`setup ... --prompt-file copilot=FILE --prompt-file pocock=FILE` adds variants whose prompt is the file's text (leading `<!-- ... -->` provenance comments are stripped) plus a fixed per-PR tail: context dir, inlined `files.txt`, `standards.txt`, `requirements.md`, `diff.patch` (same 4/4/8/40 KiB limits and block format as `src/prompt.js`) and the same "one parallel batch" instruction. Tools and context match the lean variant; only the review philosophy differs.

- Output contract: free-form `<ctx>/review.json` = `{"comments":[{path,line,severity:high|medium|low,title,body,suggestion?}],"summary"}`. No schema, no coverage rows, no citation verification, nothing dropped (deliberately generous to the stand-ins). `task.md` asks for `review.json`; manifest entries carry `free: true`.
- `finish` does not call `post.run` for these: it counts comments by severity (`inline` = all comments) and writes `posted.json` (every comment inline, kind `review_comment`, confidence = severity), `summary.md` and `ctx/findings.json` (`kind: review_comment`, `origin: 'free'`) so `eval/bundle.js` can adjudicate them next to schema variants. Standalone: `convertFree(dir)` in `ab.js`.
- Mix with other variants by copying a variant directory (plus its manifest entries) into the ab dir that bundle.js reads.

## Adjudication metrics (`node eval/bundle.js join`)

After the hit tables, `join` prints a quality/volume table per variant (also returned as `metrics` on each variant of the result object). Only shown findings count (inline + summary; `dropped` are excluded). Unjudged findings (no `verdict`) stay in the share denominators but not in the false-gap denominators. A zero denominator prints `-` (null).

- false-gap rate (inline / all classes): findings with verdict `wrong` or `unverifiable`, divided by findings with any verdict, within inline only or inline + summary.
- comment density: inline findings per PR (mean over all PRs the variant ran, and max) and summary-class findings per PR (mean).
- actionable share: inline findings with `useful: would_fix`, divided by all inline findings.
- noise share: inline findings with verdict `trivial` or `wrong`, divided by all inline findings.

Bug hits read a `hit: direct|near` field when present (current adjudicators, with verdict `true_gap|wrong|trivial|unverifiable`), else the legacy verdicts `hit_direct` / `hit_near`.

Keep the `_mapping.json` that `bundle.js build` wrote: verdict files are keyed by its finding ids, and rebuilding the bundle (even with the same seed, if the variant set or findings changed) yields different ids, so `join` then scores the wrong findings. Pass the original out directory to `join`.
