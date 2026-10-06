#!/usr/bin/env bash
# Step 1: deterministic context gathering. No AI, no PR code execution.
set -euo pipefail

: "${BASE_SHA:?}" "${HEAD_SHA:?}" "${CTX:?}"
MAX_DIFF_KB=${MAX_DIFF_KB:-300}
# PR head, not the merge commit: line numbers match the PR diff. Then wipe CTX: the PR may have committed a fake one.
git checkout -q --detach "$HEAD_SHA"
rm -rf "$CTX"
mkdir -p "$CTX"
out() { [ -n "${GITHUB_OUTPUT:-}" ] && echo "$1=$2" >> "$GITHUB_OUTPUT"; return 0; }
out skip false; out partial false

# Globs: * crosses '/', leading **/ is optional (ponytail: not full gitignore semantics, swap for git check-ignore if it bites)
STANDARDS=(.github/copilot-instructions.md '.github/instructions/**' '**/AGENTS.md' '**/AGENT.md' '**/CLAUDE.md'
  '**/GEMINI.md' REVIEW.md CONTRIBUTING.md CODING_STANDARDS.md .editorconfig 'docs/*standards*'.{md,mdx,rst,txt,adoc} 'docs/*conventions*'.{md,mdx,rst,txt,adoc} '.claude/rules/**'
  '.github/skills/**' '.claude/skills/**' '.agents/skills/**'
  .cursorrules '.cursor/rules/**' .windsurfrules '.clinerules/**')
EXEC_CFG=('.claude/**' .mcp.json .claude.json CLAUDE.local.md .gitmodules .ripgreprc '.husky/**'
  '.github/hooks/**' '.github/copilot/**' .github/mcp.json)
IGNORES=(package-lock.json yarn.lock pnpm-lock.yaml Cargo.lock poetry.lock go.sum composer.lock Gemfile.lock '*.lock'
  .specguard-ctx/ dist/ build/ vendor/ node_modules/ '*.min.*' __snapshots__/ '*.snap')
# SpecGuard's own instructions are never the repo's coding standard (still restored from base)
OWN=('**/skills/test-review/**' .github/instructions/test-review.instructions.md)
while IFS= read -r l; do [ -n "$l" ] && IGNORES+=("$l"); done <<< "${IGNORE_EXTRA:-}"

# match FILE PATTERN...
match() {
  local f=$1 p; shift
  for p in "$@"; do
    p=${p#\*\*/}
    if [[ $p == */ ]]; then [[ $f == $p* || $f == */$p* ]] && return 0
    else [[ $f == $p || $f == */$p ]] && return 0; fi
  done
  return 1
}

# 1. diff (three-dot = merge-base, same as GitHub's PR diff; needs fetch-depth 0)
files=()
while IFS= read -r -d '' f; do
  match "$f" "${STANDARDS[@]}" && files+=("$f") && continue
  match "$f" "${IGNORES[@]}" && continue
  [[ $f == *.md ]] && continue
  files+=("$f")
done < <(git diff --name-only --no-renames -z "$BASE_SHA...$HEAD_SHA")

if [ ${#files[@]} -eq 0 ]; then
  : > "$CTX/diff.patch"; : > "$CTX/files.txt"
  echo "nothing reviewable in diff"; out skip true; exit 0
fi
printf '%s\n' "${files[@]}" > "$CTX/files.txt"
# ponytail: argv pathspecs, hits ARG_MAX only on absurdly large PRs
GIT_LITERAL_PATHSPECS=1 git diff --no-color --no-ext-diff --no-renames \
  "$BASE_SHA...$HEAD_SHA" -- "${files[@]}" > "$CTX/diff.patch"

# 2. Discover exact paths once per tree. The same matched set governs restoration and the trusted inventory,
# including nested rules and head-only agent config.
base_hit=(); head_hit=()
while IFS= read -r -d '' f; do
  if match "$f" "${STANDARDS[@]}" "${EXEC_CFG[@]}"; then base_hit+=("$f"); fi
done < <(git ls-tree -r -z --name-only "$BASE_SHA")
while IFS= read -r -d '' f; do
  if match "$f" "${STANDARDS[@]}" "${EXEC_CFG[@]}"; then head_hit+=("$f"); fi
done < <(git ls-tree -r -z --name-only "$HEAD_SHA")

# Remove whatever the PR put at $1 (file, directory, or a parent that is a file or symlink). Never follows a PR symlink.
clear_path() {
  local d=$1
  while [[ $d == */* ]]; do
    d=${d%/*}
    if [ -L "$d" ] || { [ -e "$d" ] && [ ! -d "$d" ]; }; then rm -f -- "$d"; fi
  done
  rm -rf -- "$1"
}
# One path at a time so a failure cannot abort the rest (ponytail: one git process per matched path, batch if it ever matters).
# A path that cannot be restored is deleted: a PR-controlled rule or agent config is never left in place.
: > "$CTX/restore-failures.txt"
for f in "${head_hit[@]}"; do clear_path "$f"; done
for f in "${base_hit[@]}"; do
  clear_path "$f"
  if ! GIT_LITERAL_PATHSPECS=1 git restore --source="$BASE_SHA" --worktree -- "$f" 2>/dev/null; then
    clear_path "$f"; printf '%s\n' "$f" >> "$CTX/restore-failures.txt"
    echo "::warning::could not restore $f from base; removed it and excluded it from the rule inventory"
  fi
done
[ -s "$CTX/restore-failures.txt" ] || rm -f "$CTX/restore-failures.txt"

# 3. Never follow a PR-controlled symlink as a trusted rule source. A path that failed to restore is gone, so it is not listed.
: > "$CTX/standards.txt"
for f in "${base_hit[@]}"; do
  if match "$f" "${STANDARDS[@]}" && ! match "$f" "${IGNORES[@]}" "${OWN[@]}" && [ -f "$f" ] && [ ! -L "$f" ]; then
    printf '%s\n' "$f" >> "$CTX/standards.txt"
  fi
done

# 4. requirements, including explicit collection limitations; a failure here must not abort collection
if ! node "$(dirname "$0")/requirements.js"; then
  echo "::warning::requirement collection failed; continuing without requirements"
  echo none > "$CTX/requirements.md"
  printf '{\n  "status": "unavailable",\n  "sources": [],\n  "limitations": ["Requirement collection failed; review is limited to changed behaviour."],\n  "documents": [],\n  "criteria": []\n}\n' > "$CTX/requirements-status.json"
fi

# 5. oversize
if [ "$(wc -c < "$CTX/diff.patch")" -gt $((MAX_DIFF_KB * 1024)) ]; then
  head -c $((MAX_DIFF_KB * 1024)) "$CTX/diff.patch" > "$CTX/diff.tmp" && mv "$CTX/diff.tmp" "$CTX/diff.patch"
  out partial true
fi
