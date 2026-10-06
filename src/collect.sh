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
  '**/GEMINI.md' REVIEW.md CONTRIBUTING.md .editorconfig '.claude/rules/**'
  '.github/skills/**' '.claude/skills/**' '.agents/skills/**'
  .cursorrules '.cursor/rules/**' .windsurfrules '.clinerules/**')
EXEC_CFG=('.claude/**' .mcp.json .claude.json CLAUDE.local.md .gitmodules .ripgreprc '.husky/**'
  '.github/hooks/**' '.github/copilot/**' .github/mcp.json)
IGNORES=(package-lock.json yarn.lock pnpm-lock.yaml Cargo.lock poetry.lock go.sum composer.lock Gemfile.lock '*.lock'
  .specguard-ctx/ dist/ build/ vendor/ node_modules/ '*.min.*' __snapshots__/ '*.snap')
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

# 2. restore standards + executable agent config from base (deletes head-only copies)
for p in "${STANDARDS[@]}" "${EXEC_CFG[@]}"; do
  git restore --source="$BASE_SHA" --worktree -- ":(glob)$p" 2>/dev/null || true # no match in either tree is fine
done

# 3. standards present at base (a rule file the PR deleted is restored above, so it counts)
git ls-tree -r -z --name-only "$BASE_SHA" | while IFS= read -r -d '' f; do match "$f" "${STANDARDS[@]}" && [ -f "$f" ] && echo "$f"; done | sort -u > "$CTX/standards.txt" || true

# 4. requirements (untrusted: sanitised, non-fatal)
sanitize() {
  node -e 'let s=require("fs").readFileSync(0,"utf8");
  s=s.replace(/<!--[\s\S]*?-->/g,"").replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g,"").replace(/[\x00-\x08\x0B-\x1F\x7F]/g,"");
  process.stdout.write(s)'
}
req=none
if [ -n "${PR_NUMBER:-}" ] && command -v gh >/dev/null; then
  # closing issues, then #N in the PR body and commit messages; deduped, max 5, self excluded
  nums=$({
    gh pr view "$PR_NUMBER" --json closingIssuesReferences --jq '.closingIssuesReferences[].number'
    { gh pr view "$PR_NUMBER" --json body --jq .body; git log "$BASE_SHA..$HEAD_SHA" --format=%B; } | grep -oE '#[0-9]+' | tr -d '#'
  } 2>/dev/null | grep -vx "$PR_NUMBER" | awk '!s[$0]++' | head -5) || true
  req=$({
    gh pr view "$PR_NUMBER" --json title,body --jq '"# PR: " + .title + "\n\n" + .body'
    for n in $nums; do
      gh issue view "$n" --json title,body --jq '"\n# Issue #'"$n"': " + .title + "\n\n" + .body' || true # not an issue, or no access: skip
    done
  } 2>/dev/null | sanitize) || req=none
  [ -n "$req" ] || req=none
fi
printf '%s\n' "$req" > "$CTX/requirements.md"

# 5. oversize
if [ "$(wc -c < "$CTX/diff.patch")" -gt $((MAX_DIFF_KB * 1024)) ]; then
  head -c $((MAX_DIFF_KB * 1024)) "$CTX/diff.patch" > "$CTX/diff.tmp" && mv "$CTX/diff.tmp" "$CTX/diff.patch"
  out partial true
fi
