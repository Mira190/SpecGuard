# Engine adapters

An engine runs the model for one review. Everything before it (collect, prompt) and after it (post.js, audit-post.js) is engine-agnostic: an engine is one script, `src/engines/<name>.sh`, that reads a prompt file and leaves files in `$CTX`. The action runs `src/engines/$ENGINE.sh` after checking `ENGINE` against the allow-list in `src/validate-inputs.sh`.

| name | script | notes |
|---|---|---|
| `copilot` | `copilot.sh` | Copilot CLI: JSON in prose, one repair turn on the same session. Credential: a GitHub fine-grained PAT (`COPILOT_GITHUB_TOKEN`) or the job token. |
| `claude` | `claude.sh` | Claude Code CLI on an Anthropic API key (`ANTHROPIC_API_KEY`, billed to that key's Anthropic account): one turn with `--json-schema` structured output, no repair turn. |

The action's `engine` input is `auto` by default: `src/credential.js` detects the credential by prefix (`github_pat_`, `gho_`, `ghu_` = Copilot; `sk-ant-` = Anthropic; `ghp_` and anything else fail) and picks `copilot` or `claude`; no token means `copilot` on the job token. It also maps the model alias `haiku-5.5` to `claude-haiku-5.5` (copilot) or `claude-haiku-5-5` (claude); full ids pass through. The adapters never see `auto` and never print a credential.

A Copilot SDK adapter (`submit_review` tool call instead of JSON in prose) was trialled on 2026-10-13: it tied with the CLI on the eval cases, its auth with the job token in Actions was never verified, and its permission handler was a lexical path check, so it was removed. It can be restored from commit `58d8937` (and `b5316db`, which wired it into the action).

## Inputs (environment)

| variable | meaning |
|---|---|
| `CTX` | context directory (exists, holds the collector's files). All outputs go here. |
| `PROMPT_FILE` | the prompt (can be 128 KiB or more: never pass it as an argument or an environment variable). `PROMPT` is accepted for small prompts and written to `$CTX/prompt.txt`. |
| `CHECK` | `audit` when the run is a unit test gap scan (mode scan; validate with `audit-post.js`, schema `audit.schema.json`); empty for a PR review (`post.js`, `findings.schema.json`). |
| `MODEL`, `EFFORT`, `AUTO_TIER`, `FAST_MODELS` | model choice. Empty `MODEL` means Copilot Auto; effort is never sent with Auto; `AUTO_TIER` only applies to Auto (the CLI needs an explicit `--model auto` for it, so an empty `MODEL` with a tier is sent as `--model auto --auto-tier X`). |
| `MAX_CREDITS` | soft cap of AI credits per turn. `claude` turns it into a per-run budget (`--max-budget-usd`, $0.05 per credit: 60 = $3.00). |
| `TIMEOUT` | minutes for the WHOLE run, install included. |
| `COPILOT_GITHUB_TOKEN`, `GITHUB_TOKEN`, `ANTHROPIC_API_KEY` | credentials, by environment only (never argv). Empty `COPILOT_GITHUB_TOKEN` must be unset; `GH_TOKEN` must be removed (it would win over both). `claude` unsets every GitHub token and uses only `ANTHROPIC_API_KEY`. |
| engine specific | `COPILOT_VERSION` (copilot), `CLAUDE_VERSION` (claude). Empty = do not install, use what is on `PATH` (local runs, tests). |

Adapters call `src/validate-inputs.sh` first (a config error fails the step loudly).

## Outputs (files in `$CTX`)

| file | content |
|---|---|
| `findings.json` | the raw result object (what the model answered). post.js validates it again, so an adapter may write a rejected object: post.js degrades and reports. |
| `usage.json` | usage in the shape of `copilot --usage-output-file` (`totalNanoAiu`, `currentModel`, `modelMetrics`, ...); an engine that knows the exact cost in USD adds `totalCostUsd` (`claude` does, from `total_cost_usd`; per-model `inputTokens` include the cache read and write tokens). Missing is allowed. |
| `engine-status` | `success` is the default (file absent or `success`); `failed` or `timeout` makes post.js report "could not complete". |
| `engine-notes` | one note per line (`effort ignored: model auto`, `model_fallback: X → auto`, `auto_tier ignored`, `usage partial`, ...), shown in the summary. |
| `engine-repair` | `repaired` or `repair_failed` when a repair turn or an in-session retry happened. |
| `engine-model.json` | which model(s) actually ran, written with `src/engine-model.js`. |

## Rules

- Never throw past the script: every failure ends in `engine-status` (and a `::warning::`), exit code 0. Exit non-zero only for configuration errors.
- Never write to the PR, the repository or any GitHub resource. The engine reads; post.js is the only writer.
- Read-only tools only: `view`, `glob`, `grep` (`claude`: `--tools Read,Grep,Glob` with `--permission-mode dontAsk`, `--restricted` so the file tools stay in the workspace, `--bare` so the reviewed repository's settings, hooks and MCP servers are ignored). Nothing that writes or runs commands. Never `--allow-all`, `--allow-all-paths`, `--yolo`, `--dangerously-skip-permissions`.
- Redaction: every stderr line copied into a note, `engine-error` or the log goes through `_redact.sh` first (`github_pat_...`, `gh[pousr]_...`, `sk-ant-...` and `Bearer ...` become `***`). Source it and call `redact` / `redact_file`.
- Respect `TIMEOUT` including the install: cap the install, give the model what is left, and kill the process tree (`timeout -k`). A kill is `timeout`, not `failed`.
- The prompt may contain untrusted repository text; the engine adds nothing to it except its own output-format instructions.

## The claude adapter

`claude -p --bare --restricted --no-session-persistence --permission-mode dontAsk --tools Read,Grep,Glob --allowedTools Read,Grep,Glob --output-format json --json-schema <schema> --max-budget-usd <usd> [--model M]`, prompt on stdin. `claude-result.js` turns the JSON result into `findings.json` input (`structured_output`, else the `result` text for `extract-json.js`) and `usage.json`. An unusable answer is not repaired: post.js reports "could not complete". Failures are classified like Copilot's (`engine-error`: `quota` incl. the budget cap, `auth`, `rate`, `model`). `effort` is ignored with a note. The Claude Code version is pinned by the `claude_version` input and verified with `claude --version` after the bounded install.

## Add an engine

1. Write `src/engines/<name>.sh` following the rules above (copy `copilot.sh`).
2. Add the name to `ENGINES=(...)` in `src/validate-inputs.sh` (the allow-list; the action and the adapters both read it).
3. Add a pinned version input to `action.yml` and its `env` entry in the engine step if the engine installs something.
4. Add it to the adapter contract test in `src/engines.test.js`.

`post.js` needs no change: it only reads the files above.
