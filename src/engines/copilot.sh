#!/usr/bin/env bash
# Engine adapter: GitHub Copilot CLI. Contract: src/engines/README.md.
# One turn, then ONE repair turn on the same session when its JSON is missing or fails post.js's validator.
# Every prompt goes to copilot on stdin from a file in $CTX: one argv entry is capped at 128 KiB on Linux and ~32K characters on Windows, an env var too.
# Env: CTX PROMPT_FILE (path of the prompt; or PROMPT, small prompts only, written to $CTX/prompt.txt) MODEL EFFORT AUTO_TIER FAST_MODELS MAX_CREDITS TIMEOUT (minutes, install included, shared by all turns); engine-model.js records the model each turn used.
# COPILOT_VERSION (npm install -g @github/copilot@V; empty = use the copilot already on PATH). CHECK=audit validates with audit-post.js (audit mode; read by extract-json.js). Never --allow-all, --allow-all-paths, --yolo.
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; src="$(cd "$here/.." && pwd)"
bash "$src/validate-inputs.sh" || exit 1
TIMEOUT="${TIMEOUT:-12}" # validated above
unset GH_TOKEN # Copilot CLI token precedence is COPILOT_GITHUB_TOKEN > GH_TOKEN > GITHUB_TOKEN: a job-level GH_TOKEN would hijack the auth
[ -n "${COPILOT_GITHUB_TOKEN:-}" ] || unset COPILOT_GITHUB_TOKEN
SECONDS=0; budget=$((10#$TIMEOUT * 60))
mkdir -p "$CTX"
if [ -n "${COPILOT_VERSION:-}" ]; then # an unbounded install once hung the whole job: at most 5 minutes, and never more than the budget
  cap=300; [ "$budget" -ge "$cap" ] || cap=$budget
  timeout -k 10s "${cap}s" npm install -g "@github/copilot@$COPILOT_VERSION" >/dev/null || { echo "::warning::could not install @github/copilot@$COPILOT_VERSION (failed or over ${cap}s)"; echo failed > "$CTX/engine-status"; echo "engine install failed: @github/copilot@$COPILOT_VERSION" >> "$CTX/engine-notes"; exit 0; }
fi
# A stub named copilot (VS Code's prints "Cannot find GitHub Copilot CLI" and exits 0) must not pass for a turn: the copilot on PATH (the one installed above when COPILOT_VERSION is set) has to report its version.
ver="$(timeout -k 5s 30s copilot --version < /dev/null 2>&1 | head -n 3)" || true
if ! printf '%s\n' "$ver" | grep -qiE 'GitHub Copilot CLI v?[0-9]+\.[0-9]+\.[0-9]+'; then
  first="$(printf '%s\n' "$ver" | grep . | head -n 1)"; first="${first:0:200}"
  echo "::warning::Copilot CLI not found or not runnable (${first:-no output})"; echo failed > "$CTX/engine-status"; echo "Copilot CLI not found or not runnable (${first:-no output})" >> "$CTX/engine-notes"; exit 0
fi
SID="$(node -e "console.log(require('crypto').randomUUID())")"
out="$CTX/copilot.out"; err="$CTX/copilot.err"
if [ -z "${PROMPT_FILE:-}" ]; then PROMPT_FILE="$CTX/prompt.txt"; printf '%s' "$PROMPT" > "$PROMPT_FILE"; fi
common=(--available-tools view,glob,grep --allow-all-tools --no-ask-user -s --max-ai-credits "${MAX_CREDITS:-60}")

model_args=(); effort_args=(); tier_args=(); effort_note=''; fallback_note=''; usage_note=''; repair_note=''; tier_note=''; exit_note=''; class_note=''
[ -n "${MODEL:-}" ] && model_args=(--model "$MODEL")
# The router profile only exists for auto, and the CLI rejects --auto-tier unless --model auto is explicit ("Auto preference requires the selected model to be `auto`"):
# an empty MODEL with a tier therefore becomes `--model auto --auto-tier X`; without a tier the CLI default applies and no model flag is passed.
set_tier() { tier_args=(); { [ -z "${MODEL:-}" ] || [ "${model_args[1]:-}" = auto ]; } && [ -n "${AUTO_TIER-intelligence}" ] && { tier_args=(--auto-tier "${AUTO_TIER-intelligence}"); model_args=(--model auto); }; return 0; }
set_tier
if [ -n "${EFFORT:-}" ]; then # auto does not support reasoning effort (hard error), so it is never passed with it
  if [ -n "${MODEL:-}" ] && [ "$MODEL" != auto ]; then effort_args=(--reasoning-effort "$EFFORT"); effort_note="effort: $EFFORT"
  else effort_note='effort ignored: model auto'; fi
fi
save_notes() { printf '%s\n' "$class_note" "$effort_note" "$exit_note" "$fallback_note" "$tier_note" "$usage_note" "$repair_note" | grep . > "$CTX/engine-notes"; }

turn() { # <prompt file> <usage file> <stdout file>; the time left of the shared budget is the limit
  local left=$((budget - SECONDS)) rc=0
  [ "$left" -ge 1 ] || return 124
  timeout -k 10s "${left}s" copilot --session-id "$SID" "${common[@]}" --usage-output-file "$2" "${model_args[@]}" "${effort_args[@]}" "${tier_args[@]}" < "$1" > "$3" 2> "$err" || rc=$?
  cat "$err" >&2
  [ $rc = 137 ] && rc=124 # timeout -k had to KILL it: still a timeout
  [ $rc = 0 ] && grep -q 'Cannot find GitHub Copilot CLI' "$3" && rc=1 # a stub that exits 0: a failed turn, never one to repair
  if [ $rc != 0 ] && [ ${#tier_args[@]} != 0 ] && grep -qiE 'auto-tier|auto tier|auto preference' "$err"; then # old CLI or a strict org policy: run this turn once more without the flag
    tier_args=(); [ -n "${MODEL:-}" ] || model_args=(); tier_note='auto_tier ignored'; turn "$@"; return $?
  fi
  return $rc
}
record() { MSYS2_ENV_CONV_EXCL=FAST_MODELS SID="$SID" FAST_MODELS="${FAST_MODELS:-}" node "$src/engine-model.js" --turn "$1" --usage "$2" || true; } # <turn label> <usage file>; never fails the step
check() { node "$src/extract-json.js" "$1" "$CTX/findings.json" --check; } # prints the problem (if any); findings.json = what was extracted

settle() { # <label> <rc> <stdout file> -> $settled. A non-zero exit that is not a timeout, after a complete answer (the repair trigger's own rule), still counts as a success; otherwise the exit code goes to the notes (one line either way: 3+ notes make the review reduced)
  settled=$2; [ "$2" = 0 ] || [ "$2" = 124 ] && return 0
  if [ -z "$(check "$3")" ]; then settled=0; exit_note+="Copilot exited with code $2 after a complete answer"$'\n'; echo success > "$CTX/engine-status"
  else exit_note+="copilot exit $2 ($1)"$'\n'; fi
}

rc=0; turn "$PROMPT_FILE" "$CTX/usage.json" "$out" || rc=$?
record main "$CTX/usage.json"
if [ $rc != 0 ] && grep -q 'from --model flag is not available' "$err"; then # not on this token owner's plan: no credits were spent, run once on auto
  fallback_note="model_fallback: $MODEL → auto"; effort_note=''; model_args=(--model auto); effort_args=(); set_tier
  rc=0; turn "$PROMPT_FILE" "$CTX/usage.json" "$out" || rc=$?
  record fallback "$CTX/usage.json"
  settle fallback $rc "$out"; rc=$settled
else settle main $rc "$out"; rc=$settled
fi
[ $rc = 0 ] || usage_note='usage partial' # a killed or failed turn leaves whatever usage file it wrote; its total cannot be trusted
# ponytail: heuristic substring table over a failed turn's stderr+stdout (the CLI has no machine-readable error codes); first match wins, the raw first line is always added. Unmatched = unknown = today's generic text.
reason=''; why=''
if [ $rc != 0 ] && [ $rc != 124 ]; then
  text="$(cat "$err" "$out" 2>/dev/null)"
  has() { printf '%s' "$text" | grep -qiE "$1"; }
  if has 'exceeded your monthly quota|quota|budget limit|ai credits.*exceed|exceed.*ai credits'; then reason=quota; why="Copilot quota or budget exhausted for this token's account/org (raise the budget or wait for the reset)"
  elif has 'access denied by policy|policy settings|not enabled|disabled by your organization'; then reason=policy; why='Copilot is disabled by an organization or enterprise policy for this token'
  elif has 'not authorized|\b401\b|authentication|no copilot access|requires a copilot'; then reason=auth; why='The token cannot use Copilot (check copilot-requests: write or copilot_token)'
  elif has 'rate limit|\b429\b|too many requests'; then reason=rate; why='Copilot rate limit hit; the next push retries'
  fi
  if [ -n "$reason" ]; then
    raw="$(printf '%s\n' "$(cat "$err" 2>/dev/null)" "$text" | grep -m1 '[^[:space:]]' | cut -c1-200)"
    printf '%s\n%s\n' "$reason" "$why" > "$CTX/engine-error"; class_note="$why${raw:+: $raw}"
  fi
fi
save_notes
if [ $rc != 0 ]; then
  case "$reason" in ''|auth) echo "::warning::Copilot review failed or timed out (needs 'permissions: copilot-requests: write' or a copilot_token)";; *) echo "::warning::Copilot review failed: $why";; esac
  [ $rc = 124 ] && echo timeout > "$CTX/engine-status" || echo failed > "$CTX/engine-status"
fi
problem="$(check "$out")"
if [ $rc = 0 ] && [ -n "$problem" ]; then
  echo "$problem"
  msg="${problem#::warning::}"
  if [ $((budget - SECONDS)) -lt 60 ]; then repair_note='repair_skipped: no time'; save_notes; exit 0; fi # a repair turn needs time to answer
  repair="Your final answer was not usable: ${msg:0:500}. Reply with ONLY the complete corrected JSON object, with no prose and no code fences. Do not investigate again."
  printf '%s' "$repair" > "$CTX/prompt-repair.txt"
  rrc=0; turn "$CTX/prompt-repair.txt" "$CTX/usage-repair.json" "$CTX/copilot-repair.out" || rrc=$?
  record repair "$CTX/usage-repair.json"
  settle repair $rrc "$CTX/copilot-repair.out"; rrc=$settled; save_notes
  [ $rrc = 0 ] || { [ $rrc = 124 ] && echo timeout || echo failed; } > "$CTX/engine-status"
  [ $rrc = 0 ] || { usage_note='usage partial'; save_notes; }
  if check "$CTX/copilot-repair.out" > /dev/null; then echo repaired; else echo repair_failed; fi > "$CTX/engine-repair"
else
  [ -n "$problem" ] && echo "$problem"
fi
exit 0
