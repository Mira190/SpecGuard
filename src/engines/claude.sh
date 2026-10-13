#!/usr/bin/env bash
# Engine adapter: Claude Code CLI on an Anthropic API key. Contract: src/engines/README.md.
# One main turn with a JSON schema (structured output), session id ours. When it ends without an answer because the per-run budget or the turn limit was reached, ONE finalize turn resumes the same session with no tools and asks for the final JSON from what was already read (engine-repair = finalized | finalize_failed). Other failures are reported by post.js as "could not complete".
# The prompt goes to claude on stdin from a file in $CTX (never argv). Read-only tools only: Read, Grep, Glob; dontAsk denies everything else; --restricted confines the file tools to the workspace (no reading /proc/self/environ, where the key lives); --bare ignores the reviewed repo's settings, hooks, MCP servers and CLAUDE.md.
# Env: CTX PROMPT_FILE (or PROMPT, small prompts) ANTHROPIC_API_KEY (environment only) MODEL (empty = the CLI default) EFFORT (ignored, noted) MAX_BUDGET_USD (per-run budget in USD, default 1.00; the finalize turn gets 20% of it, at least 0.10) TIMEOUT (minutes, install included)
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
usd="$(awk -v b="${MAX_BUDGET_USD:-1.00}" 'BEGIN{printf "%.2f", b}')"; fusd="$(awk -v b="$usd" 'BEGIN{x = b * 0.2; if (x < 0.1) x = 0.1; printf "%.2f", x}')"
sid="$(node -e 'console.log(require("node:crypto").randomUUID())')" # ours, so the finalize turn can resume this session (no --no-session-persistence)
args=(-p --bare --restricted --session-id "$sid" --permission-mode dontAsk --tools "Read,Grep,Glob" --allowedTools "Read,Grep,Glob" --output-format json --json-schema "$(cat "$schema")" --max-budget-usd "$usd")
[ -n "${MODEL:-}" ] && args+=(--model "$MODEL")
effort_note=''; [ -n "${EFFORT:-}" ] && effort_note='effort ignored: claude engine'
turn() { # <prompt file> <stdout file> <stderr file> <claude args...>: what is left of the shared TIMEOUT is the limit; returns 124 on a timeout
  local p="$1" o="$2" e="$3" left=$((budget - SECONDS)) r=0; shift 3
  [ "$left" -ge 1 ] || return 124
  timeout -k 10s "${left}s" claude "$@" < "$p" > "$o" 2> "$e" || r=$?
  [ $r = 137 ] && r=124 # timeout -k had to KILL it: still a timeout
  redact_file "$e"; cat "$e" >&2 2>/dev/null # redacted before it is copied anywhere
  return $r
}
result() { # <stdout file> <answer file> <usage file> -> prints "ok" or "error <subtype>: <message>"; the answer file always exists
  local st; st="$(MODEL="${MODEL:-}" node "$here/claude-result.js" "$1" "$2" "$3" 2>/dev/null)" || st='error unparsable: claude-result failed'
  [ -f "$2" ] || : > "$2"; printf '%s' "$st"
}
out="$CTX/claude.out"; err="$CTX/claude.err"; ans="$CTX/claude.answer"
rc=0; turn "$PROMPT_FILE" "$out" "$err" "${args[@]}" || rc=$?
status="$(result "$out" "$ans" "$CTX/usage.json")"
node "$src/engine-model.js" --turn main --usage "$CTX/usage.json" || true # the model(s) that ran, from the usage file
problem=''; [ $rc = 124 ] || problem="$(node "$src/extract-json.js" "$ans" "$CTX/findings.json" --check)" # findings.json = what was extracted; prints the problem, if any
reason=''; why=''; class_note=''; exit_note=''
# ponytail: substring table over the CLI's stderr and its JSON error text (no machine-readable codes); first match wins, the raw first line is always added.
# budget (the CLI's own per-run stop) is told apart from quota (the ACCOUNT has no credit): only a budget stop gets a finalize turn.
if [ $rc != 124 ] && { [ $rc != 0 ] || [ "$status" != ok ]; }; then
  text="$(cat "$err" 2>/dev/null; printf '\n%s\n' "$status")"
  has() { printf '%s' "$text" | grep -qiE "$1"; }
  if has 'error_max_budget|exceeded.*budget|budget.*exceeded|max.?budget'; then reason=budget; why="The per-run budget of \$$usd was reached before the review finished (raise max_budget_usd)"
  elif has 'error_max_turns|max.?turns'; then reason=turns; why='The review ran out of turns before it finished (the PR is large; the next push retries)'
  elif has 'credit balance|quota|billing|insufficient|usage limit|\b402\b|payment required'; then reason=quota; why='The Anthropic account has no credit left or hit its quota (add credits to the API account; this is not the per-run budget)'
  elif has 'invalid x-api-key|invalid api key|authentication|\b401\b|\b403\b|permission_error|not logged in|/login'; then reason=auth; why='The Anthropic API key was rejected (check the llm_token secret)'
  elif has 'rate.?limit|\b429\b|overloaded|\b529\b|too many requests'; then reason=rate; why='Anthropic rate limit or overload; the next push retries'
  elif has 'not_found_error|model.*(not found|not available|does not exist)|invalid model|issue with the selected model'; then reason=model; why="The model '${MODEL:-default}' is not available to this API key (check the model input)"
  fi
  if [ -n "$reason" ]; then
    raw="$(printf '%s\n%s\n' "$(cat "$err" 2>/dev/null)" "$status" | grep -m1 '[^[:space:]]' | cut -c1-200 | redact)"
    printf '%s\n%s\n' "$reason" "$why" > "$CTX/engine-error"; class_note="$why${raw:+: $raw}"
  fi
fi
# The finalize turn: the same session, no tools, the same schema, a small budget of its own. Only after a budget or turn-limit stop, or an unclassified error after work was paid for.
spent_note=''; finalized=''
work=1; node -e 'process.exit(+require(process.argv[1]).totalCostUsd > 0 ? 0 : 1)' "$CTX/usage.json" 2>/dev/null || work=''
if [ $rc != 124 ] && [ "$status" != ok ] && { [ "$reason" = budget ] || [ "$reason" = turns ] || { [ -z "$reason" ] && [ -n "$work" ]; }; }; then
  if [ $((budget - SECONDS)) -lt 30 ]; then spent_note='finalize_skipped: no time'
  else
    printf '%s' 'Stop investigating. Using only what you have already read, return the final JSON object now; mark anything unsettled as unknown.' > "$CTX/prompt-finalize.txt"
    fargs=(-p --bare --restricted --resume "$sid" --permission-mode dontAsk --tools "" --output-format json --json-schema "$(cat "$schema")" --max-budget-usd "$fusd")
    [ -n "${MODEL:-}" ] && fargs+=(--model "$MODEL")
    frc=0; turn "$CTX/prompt-finalize.txt" "$CTX/claude-finalize.out" "$CTX/claude-finalize.err" "${fargs[@]}" || frc=$?
    fstatus="$(result "$CTX/claude-finalize.out" "$CTX/claude-finalize.answer" "$CTX/usage-repair.json")" # post.js sums it into the usage line
    node "$src/engine-model.js" --turn repair --usage "$CTX/usage-repair.json" || true
    fproblem=''; [ $frc = 124 ] || fproblem="$(node "$src/extract-json.js" "$CTX/claude-finalize.answer" "$CTX/findings.json" --check)"
    if [ $frc != 124 ] && [ "$fstatus" = ok ] && [ -z "$fproblem" ]; then finalized=1; echo finalized > "$CTX/engine-repair"
    else echo finalize_failed > "$CTX/engine-repair"; spent_note="finalize turn failed: ${fstatus#error }"; [ -z "$fproblem" ] || problem="$fproblem"; fi
  fi
fi
if [ -n "$finalized" ]; then
  echo success > "$CTX/engine-status"; rm -f "$CTX/engine-error"
  echo "::warning::Claude review stopped early (${reason:-error}); finalized from what it had read"
  printf '%s\n' "finalized: ${why:-the run stopped early}; the answer was requested without further investigation" "$effort_note" | grep . | redact > "$CTX/engine-notes"
  exit 0
fi
if [ $rc = 124 ]; then echo timeout > "$CTX/engine-status"; echo "::warning::Claude review timed out"
elif [ $rc != 0 ] && [ "$status" = ok ] && [ -z "$problem" ]; then exit_note="claude exited with code $rc after a complete answer" # a complete answer still counts
elif [ $rc != 0 ] || [ "$status" != ok ]; then
  echo failed > "$CTX/engine-status"; echo "::warning::Claude review failed${reason:+: $why}"
  [ -n "$class_note" ] || class_note="claude: $(printf '%s' "${status#error }" | redact | cut -c1-200)"
fi
[ -z "$problem" ] || echo "$problem"
printf '%s\n' "$class_note" "$effort_note" "$exit_note" "$spent_note" | grep . | redact | cut -c1-300 > "$CTX/engine-notes"
exit 0
