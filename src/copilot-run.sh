#!/usr/bin/env bash
# Copilot review run: one turn, then ONE repair turn on the same session when its JSON is missing or fails post.js's validator.
# Env: CTX PROMPT MODEL EFFORT MAX_CREDITS TIMEOUT (minutes, shared by both turns). Never --allow-all, --allow-all-paths, --yolo.
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
bash "$here/validate-inputs.sh" || exit 1
TIMEOUT="${TIMEOUT:-12}"
[[ $TIMEOUT =~ ^[0-9]{1,4}$ ]] && ((10#$TIMEOUT > 0)) || { echo "::error::review_timeout_minutes must be a positive integer"; exit 1; }
SECONDS=0; budget=$((10#$TIMEOUT * 60))
SID="$(node -e "console.log(require('crypto').randomUUID())")"
out="$CTX/copilot.out"; err="$CTX/copilot.err"
common=(--available-tools view,glob,grep --allow-all-tools --no-ask-user -s --max-ai-credits "${MAX_CREDITS:-200}")

model_args=(); effort_args=(); effort_note=''; fallback_note=''
[ -n "${MODEL:-}" ] && model_args=(--model "$MODEL")
if [ -n "${EFFORT:-}" ]; then # auto does not support reasoning effort (hard error), so it is never passed with it
  if [ -n "${MODEL:-}" ] && [ "$MODEL" != auto ]; then effort_args=(--reasoning-effort "$EFFORT"); effort_note="effort: $EFFORT"
  else effort_note='effort ignored: model auto'; fi
fi
save_notes() { printf '%s\n' "$effort_note" "$fallback_note" | grep . > "$CTX/engine-notes"; }

turn() { # <prompt> <usage file> <stdout file>; the time left of the shared budget is the limit
  local left=$((budget - SECONDS)) rc=0
  [ "$left" -ge 1 ] || return 124
  timeout "${left}s" copilot -p "$1" --session-id "$SID" "${common[@]}" --usage-output-file "$2" "${model_args[@]}" "${effort_args[@]}" > "$3" 2> "$err" || rc=$?
  cat "$err" >&2
  return $rc
}
check() { node "$here/extract-json.js" "$1" "$CTX/findings.json" --check; } # prints the problem (if any); findings.json = what was extracted

rc=0; turn "$PROMPT" "$CTX/usage.json" "$out" || rc=$?
if [ $rc != 0 ] && grep -q 'from --model flag is not available' "$err"; then # not on this token owner's plan: no credits were spent, run once on auto
  fallback_note="model_fallback: $MODEL → auto"; effort_note=''; model_args=(--model auto); effort_args=()
  rc=0; turn "$PROMPT" "$CTX/usage.json" "$out" || rc=$?
fi
save_notes
[ $rc = 0 ] || { echo "::warning::Copilot review failed or timed out (needs 'permissions: copilot-requests: write' or a copilot_token)"; [ $rc = 124 ] && echo timeout > "$CTX/engine-status" || echo failed > "$CTX/engine-status"; }
problem="$(check "$out")"
if [ $rc = 0 ] && [ -n "$problem" ]; then
  echo "$problem"
  msg="${problem#::warning::}"
  repair="Your final answer was not usable: ${msg:0:500}. Reply with ONLY the complete corrected JSON object, with no prose and no code fences. Do not investigate again."
  rrc=0; turn "$repair" "$CTX/usage-repair.json" "$CTX/copilot-repair.out" || rrc=$?
  [ $rrc = 0 ] || { [ $rrc = 124 ] && echo timeout || echo failed; } > "$CTX/engine-status"
  if check "$CTX/copilot-repair.out" > /dev/null; then echo repaired; else echo repair_failed; fi > "$CTX/engine-repair"
else
  [ -n "$problem" ] && echo "$problem"
fi
exit 0
