#!/usr/bin/env bash
# Engine adapter: GitHub Copilot SDK (opt-in; auth with GITHUB_TOKEN in Actions is unverified). Contract: src/engines/README.md.
# Installs the pinned SDK into a private prefix, then runs src/copilot-sdk-run.js (read-only tools plus a submit_review tool that validates with post.js).
# Env: CTX PROMPT_FILE MODEL EFFORT AUTO_TIER MAX_CREDITS TIMEOUT (minutes, install included) CHECK=audit; SDK_VERSION (empty = use an SDK already on NODE_PATH or globally).
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; src="$(cd "$here/.." && pwd)"
bash "$src/validate-inputs.sh" || exit 1
TIMEOUT="${TIMEOUT:-12}" # validated above
unset GH_TOKEN # precedence is COPILOT_GITHUB_TOKEN > GH_TOKEN > GITHUB_TOKEN: a job-level GH_TOKEN would hijack the auth
[ -n "${COPILOT_GITHUB_TOKEN:-}" ] || unset COPILOT_GITHUB_TOKEN
SECONDS=0; budget=$((10#$TIMEOUT * 60))
mkdir -p "$CTX"
fail() { echo "::warning::$1"; echo failed > "$CTX/engine-status"; echo "$2" >> "$CTX/engine-notes"; exit 0; }
if [ -n "${SDK_VERSION:-}" ]; then
  prefix="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/sg-sdk"
  cap=300; [ "$budget" -ge "$cap" ] || cap=$budget
  timeout -k 10s "${cap}s" npm install --prefix "$prefix" --no-audit --no-fund --ignore-scripts "@github/copilot-sdk@$SDK_VERSION" >/dev/null \
    || fail "could not install @github/copilot-sdk@$SDK_VERSION (failed or over ${cap}s)" "engine install failed: @github/copilot-sdk@$SDK_VERSION"
  export NODE_PATH="$prefix/node_modules${NODE_PATH:+:$NODE_PATH}"
fi
left=$((budget - SECONDS)); [ "$left" -ge 60 ] || fail "no time left for the review after the SDK install" "engine install used the whole time limit"
export TIMEOUT=$(( (left + 59) / 60 )) # the run's own deadline, in whole minutes; the outer timeout below is the backstop
[ -n "${PROMPT_FILE:-}" ] || { PROMPT_FILE="$CTX/prompt.txt"; printf '%s' "${PROMPT:-}" > "$PROMPT_FILE"; }
export PROMPT_FILE
rc=0; timeout -k 10s "$((left + 60))s" node "$src/copilot-sdk-run.js" || rc=$?
[ $rc = 0 ] || [ -s "$CTX/engine-status" ] || { [ $rc = 124 ] || [ $rc = 137 ] && echo timeout || echo failed; } > "$CTX/engine-status" # the backstop fired or node crashed
exit 0 # the script never fails the step: post reports "could not complete" from engine-status
