#!/usr/bin/env bash
# Copilot review run: one turn, then ONE repair turn on the same session when its JSON is missing or fails post.js's validator.
# Every prompt goes to copilot on stdin from a file in $CTX: one argv entry is capped at 128 KiB on Linux and ~32K characters on Windows, an env var too.
# Env: CTX PROMPT_FILE (path of the prompt; or PROMPT, small prompts only, written to $CTX/prompt.txt) MODEL EFFORT AUTO_TIER FAST_MODELS MAX_CREDITS TIMEOUT (minutes, shared by both turns); engine-model.js records the model each turn used. CHECK=audit validates with audit-post.js (audit mode; read by extract-json.js). Never --allow-all, --allow-all-paths, --yolo.
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
bash "$here/validate-inputs.sh" || exit 1
TIMEOUT="${TIMEOUT:-12}" # validated above
unset GH_TOKEN # Copilot CLI token precedence is COPILOT_GITHUB_TOKEN > GH_TOKEN > GITHUB_TOKEN: a job-level GH_TOKEN would hijack the auth
SECONDS=0; budget=$((10#$TIMEOUT * 60))
SID="$(node -e "console.log(require('crypto').randomUUID())")"
out="$CTX/copilot.out"; err="$CTX/copilot.err"
if [ -z "${PROMPT_FILE:-}" ]; then PROMPT_FILE="$CTX/prompt.txt"; printf '%s' "$PROMPT" > "$PROMPT_FILE"; fi
common=(--available-tools view,glob,grep --allow-all-tools --no-ask-user -s --max-ai-credits "${MAX_CREDITS:-60}")

model_args=(); effort_args=(); tier_args=(); effort_note=''; fallback_note=''; usage_note=''; repair_note=''; tier_note=''
[ -n "${MODEL:-}" ] && model_args=(--model "$MODEL")
set_tier() { tier_args=(); { [ -z "${MODEL:-}" ] || [ "${model_args[1]:-}" = auto ]; } && [ -n "${AUTO_TIER-intelligence}" ] && tier_args=(--auto-tier "${AUTO_TIER-intelligence}"); return 0; } # the router profile only exists for auto
set_tier
if [ -n "${EFFORT:-}" ]; then # auto does not support reasoning effort (hard error), so it is never passed with it
  if [ -n "${MODEL:-}" ] && [ "$MODEL" != auto ]; then effort_args=(--reasoning-effort "$EFFORT"); effort_note="effort: $EFFORT"
  else effort_note='effort ignored: model auto'; fi
fi
save_notes() { printf '%s\n' "$effort_note" "$fallback_note" "$tier_note" "$usage_note" "$repair_note" | grep . > "$CTX/engine-notes"; }

turn() { # <prompt file> <usage file> <stdout file>; the time left of the shared budget is the limit
  local left=$((budget - SECONDS)) rc=0
  [ "$left" -ge 1 ] || return 124
  timeout -k 10s "${left}s" copilot --session-id "$SID" "${common[@]}" --usage-output-file "$2" "${model_args[@]}" "${effort_args[@]}" "${tier_args[@]}" < "$1" > "$3" 2> "$err" || rc=$?
  cat "$err" >&2
  [ $rc = 137 ] && rc=124 # timeout -k had to KILL it: still a timeout
  if [ $rc != 0 ] && [ ${#tier_args[@]} != 0 ] && grep -qiE 'auto-tier|auto tier|auto preference' "$err"; then # old CLI or a strict org policy: run this turn once more without the flag
    tier_args=(); tier_note='auto_tier ignored'; turn "$@"; return $?
  fi
  return $rc
}
record() { MSYS2_ENV_CONV_EXCL=FAST_MODELS SID="$SID" FAST_MODELS="${FAST_MODELS:-}" node "$here/engine-model.js" --turn "$1" --usage "$2" || true; } # <turn label> <usage file>; never fails the step
check() { node "$here/extract-json.js" "$1" "$CTX/findings.json" --check; } # prints the problem (if any); findings.json = what was extracted

rc=0; turn "$PROMPT_FILE" "$CTX/usage.json" "$out" || rc=$?
record main "$CTX/usage.json"
if [ $rc != 0 ] && grep -q 'from --model flag is not available' "$err"; then # not on this token owner's plan: no credits were spent, run once on auto
  fallback_note="model_fallback: $MODEL → auto"; effort_note=''; model_args=(--model auto); effort_args=(); set_tier
  rc=0; turn "$PROMPT_FILE" "$CTX/usage.json" "$out" || rc=$?
  record fallback "$CTX/usage.json"
fi
[ $rc = 0 ] || usage_note='usage partial' # a killed or failed turn leaves whatever usage file it wrote; its total cannot be trusted
save_notes
[ $rc = 0 ] || { echo "::warning::Copilot review failed or timed out (needs 'permissions: copilot-requests: write' or a copilot_token)"; [ $rc = 124 ] && echo timeout > "$CTX/engine-status" || echo failed > "$CTX/engine-status"; }
problem="$(check "$out")"
if [ $rc = 0 ] && [ -n "$problem" ]; then
  echo "$problem"
  msg="${problem#::warning::}"
  if [ $((budget - SECONDS)) -lt 60 ]; then repair_note='repair_skipped: no time'; save_notes; exit 0; fi # a repair turn needs time to answer
  repair="Your final answer was not usable: ${msg:0:500}. Reply with ONLY the complete corrected JSON object, with no prose and no code fences. Do not investigate again."
  printf '%s' "$repair" > "$CTX/prompt-repair.txt"
  rrc=0; turn "$CTX/prompt-repair.txt" "$CTX/usage-repair.json" "$CTX/copilot-repair.out" || rrc=$?
  record repair "$CTX/usage-repair.json"
  [ $rrc = 0 ] || { [ $rrc = 124 ] && echo timeout || echo failed; } > "$CTX/engine-status"
  [ $rrc = 0 ] || { usage_note='usage partial'; save_notes; }
  if check "$CTX/copilot-repair.out" > /dev/null; then echo repaired; else echo repair_failed; fi > "$CTX/engine-repair"
else
  [ -n "$problem" ] && echo "$problem"
fi
exit 0
