#!/usr/bin/env bash
# Config checks for the engine inputs (env: MODEL EFFORT MAX_CREDITS TIMEOUT); fails the step with a clear error.
die() { echo "::error::$1"; exit 1; }
re='^([A-Za-z0-9][]A-Za-z0-9._:[-]{0,63}|auto)$' # never starts with '-': the value becomes a CLI argument
[[ -z ${MODEL:-} || $MODEL =~ $re ]] || die "model must be 'auto' or a model name (letters, digits and . _ : [ ] -, at most 64 characters, not starting with '-')"
case "${EFFORT:-}" in ""|low|medium|high|xhigh|max) ;; *) die "effort must be empty, low, medium, high, xhigh or max" ;; esac
c="${MAX_CREDITS:-60}"
[[ $c =~ ^[0-9]{1,4}$ ]] && ((10#$c >= 30 && 10#$c <= 2000)) || die "copilot_max_ai_credits must be an integer from 30 to 2000"
t="${TIMEOUT:-12}"
[[ $t =~ ^[0-9]{1,4}$ ]] && ((10#$t > 0)) || die "review_timeout_minutes must be a positive integer"
exit 0
