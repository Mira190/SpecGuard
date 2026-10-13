#!/usr/bin/env bash
# Engine adapter: Claude Code CLI on an Anthropic API key. Contract: src/engines/README.md.
# One turn with a JSON schema (structured output); no repair turn: an unusable answer is reported by post.js as "could not complete".
# The prompt goes to claude on stdin from a file in $CTX (never argv). Read-only tools only: Read, Grep, Glob; dontAsk denies everything else; --restricted confines the file tools to the workspace (no reading /proc/self/environ, where the key lives); --bare ignores the reviewed repo's settings, hooks, MCP servers and CLAUDE.md.
# Env: CTX PROMPT_FILE (or PROMPT, small prompts) ANTHROPIC_API_KEY (environment only) MODEL (empty = the CLI default) EFFORT (ignored, noted) MAX_CREDITS (budget, $0.05 per credit: 60 = $3.00) TIMEOUT (minutes, install included)
# CLAUDE_VERSION (npm install -g @anthropic-ai/claude-code@V; empty = use the claude already on PATH). CHECK=audit selects audit.schema.json. Never --dangerously-skip-permissions.
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; src="$(cd "$here/.." && pwd)"
. "$here/_redact.sh"
bash "$src/validate-inputs.sh" || exit 1
TIMEOUT="${TIMEOUT:-12}" # validated above
unset GH_TOKEN GITHUB_TOKEN COPILOT_GITHUB_TOKEN # an Anthropic key is the only credential this engine gets
[ -n "${ANTHROPIC_API_KEY:-}" ] || unset ANTHROPIC_API_KEY
SECONDS=0; budget=$((10#$TIMEOUT * 60))
mkdir -p "$CTX"
fail() { echo "::warning::$1"; echo failed > "$CTX/engine-status"; printf '%s\n' "$2" >> "$CTX/engine-notes"; exit 0; } # <warning> <note>
if [ -n "${CLAUDE_VERSION:-}" ]; then # at most 5 minutes, and never more than the budget
  cap=300; [ "$budget" -ge "$cap" ] || cap=$budget
  timeout -k 10s "${cap}s" npm install -g "@anthropic-ai/claude-code@$CLAUDE_VERSION" >/dev/null || fail "could not install @anthropic-ai/claude-code@$CLAUDE_VERSION (failed or over ${cap}s)" "engine install failed: @anthropic-ai/claude-code@$CLAUDE_VERSION"
fi
ver="$(timeout -k 5s 30s claude --version < /dev/null 2>&1 | head -n 3)" || true
if ! printf '%s\n' "$ver" | grep -qE '[0-9]+\.[0-9]+\.[0-9]+.*Claude Code'; then
  first="$(printf '%s\n' "$ver" | grep . | head -n 1 | redact)"; first="${first:0:200}"
  fail "Claude Code CLI not found or not runnable (${first:-no output})" "Claude Code CLI not found or not runnable (${first:-no output})"
fi
if [ -z "${PROMPT_FILE:-}" ]; then PROMPT_FILE="$CTX/prompt.txt"; printf '%s' "$PROMPT" > "$PROMPT_FILE"; fi
schema="$src/findings.schema.json"; [ "${CHECK:-}" = audit ] && schema="$src/audit.schema.json"
usd="$(awk -v c="$((10#${MAX_CREDITS:-60}))" 'BEGIN{printf "%.2f", c * 0.05}')"
args=(-p --bare --restricted --no-session-persistence --permission-mode dontAsk --tools "Read,Grep,Glob" --allowedTools "Read,Grep,Glob" --output-format json --json-schema "$(cat "$schema")" --max-budget-usd "$usd")
[ -n "${MODEL:-}" ] && args+=(--model "$MODEL")
effort_note=''; [ -n "${EFFORT:-}" ] && effort_note='effort ignored: claude engine'
out="$CTX/claude.out"; err="$CTX/claude.err"; ans="$CTX/claude.answer"
left=$((budget - SECONDS)); rc=0
if [ "$left" -ge 1 ]; then timeout -k 10s "${left}s" claude "${args[@]}" < "$PROMPT_FILE" > "$out" 2> "$err" || rc=$?; else rc=124; fi
[ $rc = 137 ] && rc=124 # timeout -k had to KILL it: still a timeout
redact_file "$err"; cat "$err" >&2 2>/dev/null # redacted before it is copied anywhere
status="$(MODEL="${MODEL:-}" node "$here/claude-result.js" "$out" "$ans" "$CTX/usage.json" 2>/dev/null)" || status='error unparsable: claude-result failed'
[ -f "$ans" ] || : > "$ans"
node "$src/engine-model.js" --turn main --usage "$CTX/usage.json" || true # the model(s) that ran, from the usage file
problem=''; [ $rc = 124 ] || problem="$(node "$src/extract-json.js" "$ans" "$CTX/findings.json" --check)" # findings.json = what was extracted; prints the problem, if any
reason=''; why=''; class_note=''; exit_note=''
# ponytail: substring table over the CLI's stderr and its JSON error text (no machine-readable codes); first match wins, the raw first line is always added.
if [ $rc != 124 ] && { [ $rc != 0 ] || [ "$status" != ok ]; }; then
  text="$(cat "$err" 2>/dev/null; printf '\n%s\n' "$status")"
  has() { printf '%s' "$text" | grep -qiE "$1"; }
  if has 'credit balance|quota|billing|insufficient|usage limit|error_max_budget|exceeded.*budget|budget.*exceeded'; then reason=quota; why='Anthropic credit balance, quota or the per-run budget is exhausted (add credits, or raise copilot_max_ai_credits: $0.05 per credit)'
  elif has 'invalid x-api-key|invalid api key|authentication|\b401\b|\b403\b|permission_error|not logged in|/login'; then reason=auth; why='The Anthropic API key was rejected (check the llm_token secret)'
  elif has 'rate.?limit|\b429\b|overloaded|\b529\b|too many requests'; then reason=rate; why='Anthropic rate limit or overload; the next push retries'
  elif has 'not_found_error|model.*(not found|not available|does not exist)|invalid model|issue with the selected model'; then reason=model; why="The model '${MODEL:-default}' is not available to this API key (check the model input)"
  fi
  if [ -n "$reason" ]; then
    raw="$(printf '%s\n%s\n' "$(cat "$err" 2>/dev/null)" "$status" | grep -m1 '[^[:space:]]' | cut -c1-200 | redact)"
    printf '%s\n%s\n' "$reason" "$why" > "$CTX/engine-error"; class_note="$why${raw:+: $raw}"
  fi
fi
if [ $rc = 124 ]; then echo timeout > "$CTX/engine-status"; echo "::warning::Claude review timed out"
elif [ $rc != 0 ] && [ "$status" = ok ] && [ -z "$problem" ]; then exit_note="claude exited with code $rc after a complete answer" # a complete answer still counts
elif [ $rc != 0 ] || [ "$status" != ok ]; then
  echo failed > "$CTX/engine-status"; echo "::warning::Claude review failed${reason:+: $why}"
  [ -n "$class_note" ] || class_note="claude: $(printf '%s' "${status#error }" | redact | cut -c1-200)"
fi
[ -z "$problem" ] || echo "$problem"
printf '%s\n' "$class_note" "$effort_note" "$exit_note" | grep . | redact > "$CTX/engine-notes"
exit 0
