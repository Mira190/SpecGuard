#!/usr/bin/env bash
# Config checks for the engine inputs (env: ENGINE MODEL EFFORT AUTO_TIER FAST_MODELS MAX_CREDITS TIMEOUT); fails the step with a clear error.
die() { echo "::error::$1"; exit 1; }
ENGINES=(copilot copilot-sdk) # the engine allow-list: each name needs src/engines/NAME.sh (src/engines/README.md)
if [[ -n ${ENGINE+x} ]]; then [[ " ${ENGINES[*]} " == *" $ENGINE "* ]] || die "engine must be one of: ${ENGINES[*]}"; fi
for v in "${COPILOT_VERSION:-}" "${SDK_VERSION:-}"; do [[ -z $v || $v =~ ^[0-9][0-9A-Za-z.+-]{0,40}$ ]] || die "copilot_version and copilot_sdk_version must be plain versions such as 1.0.15"; done # becomes an npm package spec
re='^([A-Za-z0-9][]A-Za-z0-9._:[-]{0,63}|auto)$' # never starts with '-': the value becomes a CLI argument
[[ -z ${MODEL:-} || $MODEL =~ $re ]] || die "model must be 'auto' or a model name (letters, digits and . _ : [ ] -, at most 64 characters, not starting with '-')"
case "${EFFORT:-}" in ""|low|medium|high|xhigh|max) ;; *) die "effort must be empty, low, medium, high, xhigh or max" ;; esac
case "${AUTO_TIER-intelligence}" in ""|intelligence|balance|efficiency) ;; *) die "auto_tier must be empty, intelligence, balance or efficiency" ;; esac
[[ ${#FAST_MODELS} -le 500 ]] || die "fast_models must be at most 500 characters"
c="${MAX_CREDITS:-60}"
[[ $c =~ ^[0-9]{1,4}$ ]] && ((10#$c >= 30 && 10#$c <= 2000)) || die "copilot_max_ai_credits must be an integer from 30 to 2000"
t="${TIMEOUT:-12}"
[[ $t =~ ^[0-9]{1,4}$ ]] && ((10#$t > 0)) || die "review_timeout_minutes must be a positive integer"
exit 0
