#!/usr/bin/env bash
# Config checks for the engine inputs (env: ENGINE (copilot or claude; auto is resolved before, by credential.js) MODEL EFFORT AUTO_TIER FAST_MODELS MAX_CREDITS MAX_BUDGET_USD CLAUDE_MODE MAX_OUTPUT_TOKENS TIMEOUT MAX_UNITS); fails the step with a clear error.
die() { echo "::error::$1"; exit 1; }
ENGINES=(copilot claude) # the engine allow-list: each name needs src/engines/NAME.sh (src/engines/README.md)
if [[ -n ${ENGINE+x} ]]; then [[ " ${ENGINES[*]} " == *" $ENGINE "* ]] || die "engine must be one of: ${ENGINES[*]}"; fi
v="${COPILOT_VERSION:-}"; [[ -z $v || $v =~ ^[0-9][0-9A-Za-z.+-]{0,40}$ ]] || die "copilot_version must be a plain version such as 1.0.92" # becomes an npm package spec
v="${CLAUDE_VERSION:-}"; [[ -z $v || $v =~ ^[0-9][0-9A-Za-z.+-]{0,40}$ ]] || die "claude_version must be a plain version such as 2.1.284" # becomes an npm package spec
re='^([A-Za-z0-9][]A-Za-z0-9._:[-]{0,63}|auto)$' # never starts with '-': the value becomes a CLI argument
[[ -z ${MODEL:-} || $MODEL =~ $re ]] || die "model must be 'auto' or a model name (letters, digits and . _ : [ ] -, at most 64 characters, not starting with '-')"
case "${EFFORT:-}" in ""|low|medium|high|xhigh|max) ;; *) die "effort must be empty, low, medium, high, xhigh or max" ;; esac
case "${AUTO_TIER-intelligence}" in ""|intelligence|balance|efficiency) ;; *) die "auto_tier must be empty, intelligence, balance or efficiency" ;; esac
[[ ${#FAST_MODELS} -le 500 ]] || die "fast_models must be at most 500 characters"
c="${MAX_CREDITS:-60}"
[[ $c =~ ^[0-9]{1,4}$ ]] && ((10#$c >= 30 && 10#$c <= 2000)) || die "copilot_max_ai_credits must be an integer from 30 to 2000"
b="${MAX_BUDGET_USD:-1.00}" # the claude engine's per-run budget in USD
[[ $b =~ ^[0-9]{1,2}(\.[0-9]{1,2})?$ ]] && awk -v b="$b" 'BEGIN{exit !(b > 0 && b <= 20)}' || die "max_budget_usd must be a positive decimal of at most 20 (for example 1.00)"
case "${CLAUDE_MODE:-api}" in api|agent) ;; *) die "claude_mode must be api or agent" ;; esac
o="${MAX_OUTPUT_TOKENS:-32000}"
[[ $o =~ ^[0-9]{4,6}$ ]] && ((10#$o >= 1000 && 10#$o <= 64000)) || die "max_output_tokens must be an integer from 1000 to 64000"
u="${MAX_UNITS:-12}" # scan mode: units reviewed per run (audit-collect.js checks it too)
[[ $u =~ ^[0-9]{1,3}$ ]] && ((10#$u >= 1 && 10#$u <= 100)) || die "max_units must be an integer from 1 to 100"
t="${TIMEOUT:-12}"
[[ $t =~ ^[0-9]{1,4}$ ]] && ((10#$t > 0)) || die "review_timeout_minutes must be a positive integer"
exit 0
