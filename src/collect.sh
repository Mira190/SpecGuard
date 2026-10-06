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
  '**/GEMINI.md' REVIEW.md CONTRIBUTING.md CODING_STANDARDS.md .editorconfig 'docs/*standards*' 'docs/*conventions*' '.claude/rules/**'
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

# 2. Discover exact paths once from both trees. The same matcher governs restoration
# and the trusted inventory, including nested rules and head-only agent config.
restore=()
while IFS= read -r -d '' f; do
  if match "$f" "${STANDARDS[@]}" "${EXEC_CFG[@]}"; then restore+=("$f"); fi
done < <({ git ls-tree -r -z --name-only "$BASE_SHA"; git ls-tree -r -z --name-only "$HEAD_SHA"; } | sort -zu)
if [ ${#restore[@]} -gt 0 ]; then
  GIT_LITERAL_PATHSPECS=1 git restore --source="$BASE_SHA" --worktree -- "${restore[@]}"
fi

# 3. Never follow a PR-controlled symlink as a trusted rule source.
: > "$CTX/standards.txt"
while IFS= read -r -d '' f; do
  if match "$f" "${STANDARDS[@]}" && ! match "$f" "${IGNORES[@]}" "${OWN[@]}" && [ -f "$f" ] && [ ! -L "$f" ]; then
    printf '%s\n' "$f" >> "$CTX/standards.txt"
  fi
done < <(git ls-tree -r -z --name-only "$BASE_SHA")

# 4. requirements, including explicit collection limitations
node "$(dirname "$0")/requirements.js"

# 5. oversize
if [ "$(wc -c < "$CTX/diff.patch")" -gt $((MAX_DIFF_KB * 1024)) ]; then
  head -c $((MAX_DIFF_KB * 1024)) "$CTX/diff.patch" > "$CTX/diff.tmp" && mv "$CTX/diff.tmp" "$CTX/diff.patch"
  out partial true
fi
