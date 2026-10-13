# Engine adapters

An engine runs the model for one review. Everything before it (collect, prompt) and after it (post.js, audit-post.js) is engine-agnostic: an engine is one script, `src/engines/<name>.sh`, that reads a prompt file and leaves files in `$CTX`. The action runs `src/engines/$ENGINE.sh` after checking `ENGINE` against the allow-list in `src/validate-inputs.sh`.

| name | script | notes |
|---|---|---|
| `copilot` (default) | `copilot.sh` | Copilot CLI: JSON in prose, one repair turn on the same session. |
| `copilot-sdk` | `copilot-sdk.sh` | Copilot SDK (`@github/copilot-sdk`, pinned by `copilot_sdk_version`): a `submit_review` tool whose parameters are the findings schema. Opt-in; its `GITHUB_TOKEN` auth in Actions is unverified. |

## Inputs (environment)

| variable | meaning |
|---|---|
| `CTX` | context directory (exists, holds the collector's files). All outputs go here. |
| `PROMPT_FILE` | the prompt (can be 128 KiB or more: never pass it as an argument or an environment variable). `PROMPT` is accepted for small prompts and written to `$CTX/prompt.txt`. |
| `CHECK` | `audit` when the run is a requirements audit (validate with `audit-post.js`, schema `audit.schema.json`); empty for a PR review (`post.js`, `findings.schema.json`). |
| `MODEL`, `EFFORT`, `AUTO_TIER`, `FAST_MODELS` | model choice. Empty `MODEL` means Copilot Auto; effort is never sent with Auto; `AUTO_TIER` only applies to Auto (the CLI needs an explicit `--model auto` for it, so an empty `MODEL` with a tier is sent as `--model auto --auto-tier X`). |
| `MAX_CREDITS` | soft cap of AI credits per turn. |
| `TIMEOUT` | minutes for the WHOLE run, install included. |
| `COPILOT_GITHUB_TOKEN`, `GITHUB_TOKEN` | credentials. Empty `COPILOT_GITHUB_TOKEN` must be unset; `GH_TOKEN` must be removed (it would win over both). |
| engine specific | `COPILOT_VERSION` (copilot), `SDK_VERSION` (copilot-sdk). Empty = do not install, use what is on `PATH` / `NODE_PATH` (local runs, tests). |

Adapters call `src/validate-inputs.sh` first (a config error fails the step loudly).

## Outputs (files in `$CTX`)

| file | content |
|---|---|
| `findings.json` | the raw result object (what the model answered). post.js validates it again, so an adapter may write a rejected object: post.js degrades and reports. |
| `usage.json` | usage in the shape of `copilot --usage-output-file` (`totalNanoAiu`, `currentModel`, `modelMetrics`, ...). Missing is allowed. |
| `engine-status` | `success` is the default (file absent or `success`); `failed` or `timeout` makes post.js report "could not complete". |
| `engine-notes` | one note per line (`effort ignored: model auto`, `model_fallback: X → auto`, `auto_tier ignored`, `usage partial`, ...), shown in the summary. |
| `engine-repair` | `repaired` or `repair_failed` when a repair turn or an in-session retry happened. |
| `engine-model.json` | which model(s) actually ran, written with `src/engine-model.js`. |

## Rules

- Never throw past the script: every failure ends in `engine-status` (and a `::warning::`), exit code 0. Exit non-zero only for configuration errors.
- Never write to the PR, the repository or any GitHub resource. The engine reads; post.js is the only writer.
- Read-only tools only: `view`, `glob`, `grep` (the SDK adapter refuses everything else). Never `--allow-all`, `--allow-all-paths`, `--yolo`.
- Respect `TIMEOUT` including the install: cap the install, give the model what is left, and kill the process tree (`timeout -k`). A kill is `timeout`, not `failed`.
- The prompt may contain untrusted repository text; the engine adds nothing to it except its own output-format instructions.

## Add an engine

1. Write `src/engines/<name>.sh` following the rules above (copy `copilot.sh`; `copilot-sdk.sh` shows a Node-based one).
2. Add the name to `ENGINES=(...)` in `src/validate-inputs.sh` (the allow-list; the action and the adapters both read it).
3. Add a pinned version input to `action.yml` and its `env` entry in the engine step if the engine installs something.
4. Add it to the adapter contract test in `src/engines.test.js`.

`post.js` needs no change: it only reads the files above.
