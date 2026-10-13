# Engine adapters

An engine runs the model for one review. Everything before it (collect, prompt) and after it (post.js, audit-post.js) is engine-agnostic: an engine is one script, `src/engines/<name>.sh`, that reads a prompt file and leaves files in `$CTX`. The action runs `src/engines/$ENGINE.sh` after checking `ENGINE` against the allow-list in `src/validate-inputs.sh`.

| name | script | notes |
|---|---|---|
| `copilot` | `copilot.sh` | Copilot CLI: JSON in prose, one repair turn on the same session. Credential: a GitHub fine-grained PAT (`COPILOT_GITHUB_TOKEN`) or the job token. |
| `claude` | `claude.sh` | An Anthropic API key (`ANTHROPIC_API_KEY`, billed to that key's Anthropic account). Default `CLAUDE_MODE=api`: ONE Messages API call (`claude-api.js`, Node `fetch`, no CLI), schema-enforced JSON, worst-case cost checked against the budget BEFORE the call. `CLAUDE_MODE=agent`: Claude Code CLI with read-only tools (one turn with `--json-schema`; after a budget or turn-limit stop, one no-tools finalize turn). |

The action's `engine` input is `auto` by default: `src/credential.js` detects the credential by prefix (`github_pat_`, `gho_`, `ghu_` = Copilot; `sk-ant-` = Anthropic; `ghp_` and anything else fail) and picks `copilot` or `claude`; no token means `copilot` on the job token. It also maps the model alias `haiku-5.5` to `claude-haiku-5.5` (copilot) or `claude-haiku-5-5` (claude); full ids pass through. The adapters never see `auto` and never print a credential.

A Copilot SDK adapter (`submit_review` tool call instead of JSON in prose) was trialled on 2026-10-13: it tied with the CLI on the eval cases, its auth with the job token in Actions was never verified, and its permission handler was a lexical path check, so it was removed. It can be restored from commit `58d8937` (and `b5316db`, which wired it into the action).

## Inputs (environment)

| variable | meaning |
|---|---|
| `CTX` | context directory (exists, holds the collector's files). All outputs go here. |
| `PROMPT_FILE` | the prompt (can be 128 KiB or more: never pass it as an argument or an environment variable). `PROMPT` is accepted for small prompts and written to `$CTX/prompt.txt`. |
| `CHECK` | `audit` when the run is a unit test gap scan (mode scan; validate with `audit-post.js`, schema `audit.schema.json`); empty for a PR review (`post.js`, `findings.schema.json`). |
| `MODEL`, `EFFORT`, `AUTO_TIER`, `FAST_MODELS` | model choice. Empty `MODEL` means Copilot Auto; effort is never sent with Auto; `AUTO_TIER` only applies to Auto (the CLI needs an explicit `--model auto` for it, so an empty `MODEL` with a tier is sent as `--model auto --auto-tier X`). |
| `MAX_CREDITS` | soft cap of AI credits per turn (copilot). `claude` ignores it. |
| `MAX_BUDGET_USD` | `claude` only: the budget in USD (default `1.00`, a positive decimal of at most 20; the `max_budget_usd` input). api mode: a hard bound, checked before the call. agent mode: `--max-budget-usd`, a soft cap checked between turns (the CLI can overshoot it several times over); the finalize turn gets 20% of it, at least 0.10. |
| `CLAUDE_MODE`, `MAX_OUTPUT_TOKENS` | `claude` only: `api` (default) or `agent`; api mode's output limit (default 16000, 1000-64000, the `max_output_tokens` input). `MODEL` empty means `claude-haiku-5-5` in api mode. |
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
| `usage-repair.json` | usage of the second turn (copilot repair, claude finalize), same shape; post.js and audit-post.js sum it into the usage line. |
| `engine-repair` | `repaired` or `repair_failed` when a repair turn or an in-session retry happened; `finalized` or `finalize_failed` for the claude finalize turn. |
| `engine-model.json` | which model(s) actually ran, written with `src/engine-model.js`. |

## Rules

- Never throw past the script: every failure ends in `engine-status` (and a `::warning::`), exit code 0. Exit non-zero only for configuration errors.
- Never write to the PR, the repository or any GitHub resource. The engine reads; post.js is the only writer.
- Read-only tools only: `view`, `glob`, `grep` (`claude`: `--tools Read,Grep,Glob` with `--permission-mode dontAsk`, `--restricted` so the file tools stay in the workspace, `--bare` so the reviewed repository's settings, hooks and MCP servers are ignored). Nothing that writes or runs commands. Never `--allow-all`, `--allow-all-paths`, `--yolo`, `--dangerously-skip-permissions`.
- Redaction: every stderr line copied into a note, `engine-error` or the log goes through `_redact.sh` first (`github_pat_...`, `gh[pousr]_...`, `sk-ant-...` and `Bearer ...` become `***`). Source it and call `redact` / `redact_file`.
- Respect `TIMEOUT` including the install: cap the install, give the model what is left, and kill the process tree (`timeout -k`). A kill is `timeout`, not `failed`.
- The prompt may contain untrusted repository text; the engine adds nothing to it except its own output-format instructions.

## The claude adapter

`claude.sh` dispatches on `CLAUDE_MODE` after the common checks: `api` (default) runs `node claude-api.js`, `agent` runs the Claude Code CLI.

### api mode (default)

`claude-api.js` sends ONE `POST https://api.anthropic.com/v1/messages` (headers `x-api-key` from the environment only, `anthropic-version: 2023-06-01`). Why not an agent: `src/prompt.js` already inlines the numbered diff, test candidates, leads, trace candidates, requirements, rule files and coverage, and the CLI's tool loop re-sends the whole context every turn (two live runs: 1.2M and 737k input tokens, $3.58 and $3.44 against a $1 budget; the CLI budget is a soft cap).

- Request: `model` (empty = `claude-haiku-5-5`), `max_tokens` (`MAX_OUTPUT_TOKENS`), `system` = the static prompt prefix (skill, references, schema; everything before the `---` / `Context directory` line of `prompt.js`) with `cache_control: {type: ephemeral}`, one `user` message = a note that no file tools exist + the per-PR context, `output_config.format = {type: json_schema, schema}`. No tools. The schema (`findings.schema.json`, or `audit.schema.json` for `CHECK=audit`) is reduced in memory: every object gets `additionalProperties:false`; `minLength`, `maxLength`, `minimum`, `maximum`, `uniqueItems`, `if/then/else` are dropped (not supported by structured outputs). `post.js` validates the full schema anyway. If the API refuses the schema (400 mentioning it), ONE retry asks for plain JSON, with a note.
- Pre-flight: worst case = (static tokens x 1.25 + dynamic tokens) x input price + `max_tokens` x output price, tokens estimated as bytes / 3.5. Above `MAX_BUDGET_USD` nothing is sent: `engine-status` failed, `engine-error` = `budget` / `estimated worst-case cost $X exceeds max_budget_usd $Y ...`.
- Prices: the table `PRICES` in `claude-api.js` (haiku 5.5 has a second card above 100K prompt tokens; cache read 0.1x, write 1.25x). `usage.json` carries the exact `totalCostUsd` for a model in the table; any other model is priced at a high default card and a note says the cost is an estimate. A typical PR review on `claude-haiku-5-5` costs about half a cent; the largest prompt with 16000 output tokens is under two cents.
- Errors (`engine-error` reason): 401/403 `auth`; 402 or "credit balance" `quota` (the ACCOUNT has no credit, not the budget); 429/529 `rate`, 404 or an unavailable model `model`; `refusal` `policy`; `max_tokens` `length` (raise `max_output_tokens`); a timeout is `timeout`; anything else `failed` with the API message. 429, 529, 5xx and network errors are retried once (`retry-after` up to 30 s). Every text copied into a note passes the redaction (the key itself and `sk-ant-...` become `***`).
- Files: `findings.json` = the parsed answer, `usage.json` (normalized shape), `engine-model.json`, `engine-notes`. There is no repair or finalize turn and no `engine-repair`.

### agent mode

`claude -p --bare --restricted --session-id <uuid> --permission-mode dontAsk --tools Read,Grep,Glob --allowedTools Read,Grep,Glob --output-format json --json-schema <schema> --max-budget-usd <usd> [--model M]`, prompt on stdin. `claude-result.js` turns the JSON result into `findings.json` input (`structured_output`, else the `result` text for `extract-json.js`) and `usage.json`. The session id is ours (the session is kept, so `--no-session-persistence` is not used). **`--max-budget-usd` is a soft cap checked between turns**: a run can cost several times `max_budget_usd`, and the budget is cumulative across a resumed session. When the main turn ends without an answer because the budget (`error_max_budget_usd`) or the turn limit was reached, ONE finalize turn runs `claude -p --bare --restricted --resume <uuid> --tools "" --json-schema <schema> --max-budget-usd <20% of the budget, min 0.10>` with the prompt "Stop investigating. Using only what you have already read, return the final JSON object now; mark anything unsettled as unknown." (`engine-repair` = `finalized` or `finalize_failed`; its usage goes to `usage-repair.json`; it fails at once when the main turn already spent more than the budget). An unclassified error after money was spent gets the same turn; auth, rate, model and account-quota errors, a timeout and an invalid answer do not. Any other unusable answer is not repaired: post.js reports "could not complete". Failures are classified like api mode's (`engine-error`: `budget`, `quota`, `turns`, `auth`, `rate`, `model`). `effort` is ignored with a note. The Claude Code version is pinned by the `claude_version` input and verified with `claude --version` after the bounded install.

## Add an engine

1. Write `src/engines/<name>.sh` following the rules above (copy `copilot.sh`).
2. Add the name to `ENGINES=(...)` in `src/validate-inputs.sh` (the allow-list; the action and the adapters both read it).
3. Add a pinned version input to `action.yml` and its `env` entry in the engine step if the engine installs something.
4. Add it to the adapter contract test in `src/engines.test.js`.

`post.js` needs no change: it only reads the files above.
