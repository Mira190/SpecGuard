#!/usr/bin/env bash
# Step 1: deterministic context gathering. No AI, no PR code execution.
set -euo pipefail

: "${BASE_SHA:?}" "${HEAD_SHA:?}" "${CTX:?}"
MAX_DIFF_KB=${MAX_DIFF_KB:-300}
# PR head, not the merge commit: line numbers match the PR diff. Then wipe CTX: the PR may have committed a fake one.
git checkout -q --detach "$HEAD_SHA"
rm -rf "$CTX"
mkdir -p "$CTX"
# Present from the start so that an absent list never means "no restriction": a trace.js failure leaves trace-status=failed
# and an empty list (post.js then fails closed for path-sourced requirements). trace-status: ok | failed | off.
: > "$CTX/collect-limits.txt"; : > "$CTX/spec-files.txt"; : > "$CTX/spec-rejected.txt"; : > "$CTX/diff-dropped.txt"
if [ "${TRACE:-auto}" = off ]; then echo off > "$CTX/trace-status"; else echo failed > "$CTX/trace-status"; fi
out() { [ -n "${GITHUB_OUTPUT:-}" ] && echo "$1=$2" >> "$GITHUB_OUTPUT"; return 0; }
out skip false; out partial false

# Globs: * crosses '/', leading **/ is optional (ponytail: not full gitignore semantics, swap for git check-ignore if it bites)
STANDARDS=(.github/copilot-instructions.md '.github/instructions/**' '**/AGENTS.md' '**/AGENT.md' '**/CLAUDE.md'
  '**/GEMINI.md' REVIEW.md CONTRIBUTING.md CODING_STANDARDS.md .editorconfig 'docs/*standards*'.{md,mdx,rst,txt,adoc} 'docs/*conventions*'.{md,mdx,rst,txt,adoc} '.claude/rules/**'
  '.github/skills/**' '.claude/skills/**' '.agents/skills/**'
  .cursorrules '.cursor/rules/**' .windsurfrules '.clinerules/**'
  .cursor/BUGBOT.md '**/BUGBOT.md' .gemini/styleguide.md .greptile/rules.md)
EXEC_CFG=('.claude/**' .mcp.json .claude.json CLAUDE.local.md .gitmodules .ripgreprc '.husky/**'
  '.github/hooks/**' '.github/copilot/**' .github/mcp.json)
IGNORES=(package-lock.json yarn.lock pnpm-lock.yaml Cargo.lock poetry.lock go.sum composer.lock Gemfile.lock '*.lock'
  .specguard-ctx/ dist/ build/ vendor/ node_modules/ '*.min.*' __snapshots__/ '*.snap' '*.svg' '*.log' '*.map'
  packages.lock.json gradle.lockfile '*.pb.go' '*_pb2.py' '*_pb2_grpc.py' '*.g.cs' '*.Designer.cs' '*.generated.*')
# STANDARDS_PATHS: newline-separated globs, '!glob' excludes (same semantics as REQ_PATHS). Matches join the standards set: restored from base, never taken from the PR head.
STD_EXC=()
while IFS= read -r l; do
  l=${l%$'\r'}; l=${l#"${l%%[![:space:]]*}"}; l=${l%"${l##*[![:space:]]}"}
  case $l in '') ;; '!'*) STD_EXC+=("${l#!}") ;; *) STANDARDS+=("$l") ;; esac
done <<< "${STANDARDS_PATHS:-}"
# SpecGuard's own instructions are never the repo's coding standard (still restored from base)
OWN=('**/skills/test-review/**' .github/instructions/test-review.instructions.md)
while IFS= read -r l; do l=${l%$'\r'}; [ -n "$l" ] && IGNORES+=("$l"); done <<< "${IGNORE_EXTRA:-}"

# match FILE PATTERN...
match() {
  local f=$1 p; shift
  for p in "$@"; do
    MP=$p; p=${p#\*\*/} # MP: the pattern that matched (the caller may report it)
    if [[ $p == */ ]]; then [[ $f == $p* || $f == */$p* ]] && return 0
    else [[ $f == $p || $f == */$p ]] && return 0; fi
  done
  return 1
}

# std FILE: a rule file (a STANDARDS glob not excluded by STANDARDS_PATHS); rulefile also counts agent config.
std() { match "$1" "${STANDARDS[@]}" && { [ ${#STD_EXC[@]} -eq 0 ] || ! match "$1" "${STD_EXC[@]}"; }; }
rulefile() { std "$1" || match "$1" "${EXEC_CFG[@]}"; }

# lintcfg FILE REF...: a well-known linter/formatter config (by name); pyproject.toml only with a ruff/black/flake8/pylint section at one of the REFs.
# Not rule documents: they stay where the PR left them, and are only listed (lint-configs.txt) and reported when the PR changes them (lint-changes.txt).
lintcfg() {
  local f=$1 r; shift
  case ${f##*/} in
    .eslintrc*|eslint.config.*|.prettierrc*|prettier.config.*|biome.json*|ruff.toml|.flake8|.pylintrc|.golangci.*|checkstyle*.xml|.rubocop.yml|.editorconfig|stylelint.config.*|.swiftlint.yml|detekt.yml|.clang-format|.clang-tidy) return 0 ;;
    pyproject.toml) for r in "$@"; do git show "$r:$f" 2>/dev/null | grep -Eq '^\[tool\.(ruff|black|flake8|pylint)[].]' && return 0; done ;;
  esac
  return 1
}

# 0. Two bases, not to be merged. BASE_SHA is the policy base: trusted rules and spec sources come from it. DIFF_BASE_SHA is the
# merge-base of BASE_SHA and HEAD_SHA: the left side of every PR diff hunk (three-dot) lives there, so blame, requirement-change
# comparison and diff-side references must use it. Exported for the node steps and written to $CTX/diff-base-sha.
# With several merge-bases (criss-cross history) git picks one (its default); that is the same one the three-dot diff uses.
if DIFF_BASE_SHA=$(git merge-base "$BASE_SHA" "$HEAD_SHA" 2>/dev/null) && [ -n "$DIFF_BASE_SHA" ]; then :
else DIFF_BASE_SHA=$BASE_SHA; echo "::warning::no merge-base of BASE_SHA and HEAD_SHA (shallow clone? use fetch-depth 0); diff-side history may not line up"; fi
export DIFF_BASE_SHA
echo "$DIFF_BASE_SHA" > "$CTX/diff-base-sha"

# 1. diff (three-dot = merge-base, same as GitHub's PR diff; needs fetch-depth 0)
# Rule and agent-config files are never reviewed (they are restored from base below); the modified ones are reported.
HERE=$(dirname "$0")
files=(); rules=(); ignored=(); docs=(); dropped=(); specs=(); lintchg=(); nctl=0
# A path with a control character (git allows a newline) would split the newline-delimited lists below: drop it, say so.
cntrl() { [[ $1 == *[[:cntrl:]]* ]]; }
# The name list is read to a file first: a failed diff inside `< <(...)` is invisible and would end as "nothing to review".
# post.js reads collect-error.txt and publishes a failed run naming the cause (the job's red/green then follows fail_on_error); skip=true keeps the engine steps off.
git diff --name-only --no-renames -z "$BASE_SHA...$HEAD_SHA" > "$CTX/diff-names.tmp" || {
  echo "the PR diff could not be computed: base commit $BASE_SHA is missing from the clone or has no merge-base with the head (shallow clone); check out with fetch-depth: 0" > "$CTX/collect-error.txt"
  echo "::error::$(cat "$CTX/collect-error.txt")"; rm -f "$CTX/diff-names.tmp"; : > "$CTX/files.txt"; : > "$CTX/diff.patch"; out skip true; exit 0; }
while IFS= read -r -d '' f; do
  if cntrl "$f"; then nctl=$((nctl + 1)); continue; fi
  if lintcfg "$f" "$HEAD_SHA" "$BASE_SHA"; then lintchg+=("$f"); fi
  rulefile "$f" && rules+=("$f") && continue
  if match "$f" "${IGNORES[@]}"; then ignored+=("$f ($MP)"); continue; fi
  [[ $f =~ \.(md|mdx|markdown|rst|adoc|txt|feature)$ ]] && { docs+=("$f"); continue; }
  files+=("$f")
done < "$CTX/diff-names.tmp"
rm -f "$CTX/diff-names.tmp"

# Changed docs are reviewable only when trace.js names them requirement docs (classify runs before diff.patch is written).
# Unclassified .md is dropped as before; other doc types stay as ordinary files. A trace.js failure degrades to that old behaviour.
if [ ${#docs[@]} -gt 0 ]; then
  cls=""
  if [ "${TRACE:-auto}" != off ]; then
    cls=$(timeout 60 node "$HERE/trace.js" classify "${docs[@]}" 2>/dev/null) || { echo "::warning::requirement-doc classification failed; changed docs are not reviewed"; cls=""; }
  fi
  for f in "${docs[@]}"; do
    if [ -n "$cls" ] && grep -qxF -- "$f" <<< "$cls"; then specs+=("$f")
    elif [[ $f != *.md ]]; then files+=("$f")
    else dropped+=("$f"); fi
  done
fi
# Files a default or extra ignore pattern removed are never reviewed: say which, with the pattern (a pattern like build/ matches at any depth).
if [ ${#ignored[@]} -gt 0 ]; then
  printf 'Not reviewed, matched an ignore pattern (%d): %s%s
' "${#ignored[@]}" "$(printf '`%s`, ' "${ignored[@]:0:10}" | sed 's/, $//')" "$([ ${#ignored[@]} -gt 10 ] && echo ", … (+$(( ${#ignored[@]} - 10 )) more)")" | tr -d '
' >> "$CTX/collect-limits.txt"
  echo >> "$CTX/collect-limits.txt"
fi
[ "$nctl" -eq 0 ] || echo "$nctl changed path(s) containing control characters were not reviewed." >> "$CTX/collect-limits.txt"
nspecs=${#specs[@]}
[ "$nspecs" -eq 0 ] || files+=("${specs[@]}")
ncode=$(( ${#files[@]} - nspecs ))

: > "$CTX/rule-changes.txt"
[ ${#rules[@]} -eq 0 ] || printf '%s\n' "${rules[@]}" > "$CTX/rule-changes.txt"
: > "$CTX/lint-changes.txt"
[ ${#lintchg[@]} -eq 0 ] || printf '%s\n' "${lintchg[@]}" > "$CTX/lint-changes.txt"
# a dropped .md may still be named by the PR text (step 4a): keep going then, the skip check after trace.js decides
ndrop=${#dropped[@]}; [ "${TRACE:-auto}" != off ] || ndrop=0
if [ ${#files[@]} -eq 0 ] && [ "$ndrop" -eq 0 ]; then
  : > "$CTX/diff.patch"; : > "$CTX/files.txt"
  echo "nothing reviewable in diff"; out skip true; exit 0
fi
: > "$CTX/files.txt"; : > "$CTX/diff.patch"
if [ ${#files[@]} -gt 0 ]; then
  printf '%s\n' "${files[@]}" > "$CTX/files.txt"
  # ponytail: argv pathspecs, hits ARG_MAX only on absurdly large PRs
  GIT_LITERAL_PATHSPECS=1 git diff --no-color --no-ext-diff --no-renames \
    "$BASE_SHA...$HEAD_SHA" -- "${files[@]}" > "$CTX/diff.patch"
fi

# 2. Discover exact paths once per tree. The same matched set governs restoration and the trusted inventory,
# including nested rules and head-only agent config.
base_hit=(); head_hit=()
while IFS= read -r -d '' f; do
  if rulefile "$f"; then base_hit+=("$f"); fi
done < <(git ls-tree -r -z --name-only "$BASE_SHA")
while IFS= read -r -d '' f; do
  if rulefile "$f"; then head_hit+=("$f"); fi
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
    clear_path "$f"; cntrl "$f" || printf '%s\n' "$f" >> "$CTX/restore-failures.txt"
    echo "::warning::could not restore ${f//[[:cntrl:]]/?} from base; removed it and excluded it from the rule inventory"
  fi
done
[ -s "$CTX/restore-failures.txt" ] || rm -f "$CTX/restore-failures.txt"

# 3. Never follow a PR-controlled symlink as a trusted rule source. A path that failed to restore is gone, so it is not listed.
: > "$CTX/standards.txt"
for f in "${base_hit[@]}"; do
  if ! cntrl "$f" && std "$f" && ! match "$f" "${IGNORES[@]}" "${OWN[@]}" && [ -f "$f" ] && [ ! -L "$f" ]; then
    printf '%s\n' "$f" >> "$CTX/standards.txt"
  fi
done

# 3a. linter/formatter configs in the BASE tree (what the repo enforces by tooling); the model is told not to raise what they enforce.
: > "$CTX/lint-configs.txt"
while IFS= read -r -d '' f; do
  if ! cntrl "$f" && ! match "$f" "${IGNORES[@]}" && lintcfg "$f" "$BASE_SHA"; then printf '%s\n' "$f" >> "$CTX/lint-configs.txt"; fi
done < <(git ls-tree -r -z --name-only "$BASE_SHA")

# 3b. where each trusted rule file applies (applyTo / paths / directory); fail-soft, post.js skips the check without it
timeout 30 node "$HERE/standards-map.js" || echo "::warning::standards applicability map failed; continuing without it"

# 4. requirements, including explicit collection limitations; a failure here must not abort collection
if ! timeout 60 node "$(dirname "$0")/requirements.js"; then
  echo "::warning::requirement collection failed; continuing without requirements"
  echo none > "$CTX/requirements.md"
  rm -f "$CTX/pr-req-key.txt" "$CTX/pr-issues.txt" # the model gets no PR text: post must not record it as reviewed
  printf '{\n  "status": "unavailable",\n  "sources": [],\n  "limitations": ["Requirement collection failed; review is limited to changed behaviour."],\n  "documents": [],\n  "criteria": []\n}\n' > "$CTX/requirements-status.json"
fi

# 4a. A changed .md that the PR or a linked issue names is a requirement doc after all (requirements-status.json is known now): add its diff.
if [ "${TRACE:-auto}" != off ] && [ ${#dropped[@]} -gt 0 ]; then
  late=$(timeout 60 node "$HERE/trace.js" classify "${dropped[@]}" 2>/dev/null) || late=""
  more=(); while IFS= read -r l; do [ -n "$l" ] && more+=("$l"); done <<< "$late"
  if [ ${#more[@]} -gt 0 ]; then
    GIT_LITERAL_PATHSPECS=1 git diff --no-color --no-ext-diff --no-renames "$BASE_SHA...$HEAD_SHA" -- "${more[@]}" >> "$CTX/diff.patch"
    printf '%s\n' "${more[@]}" >> "$CTX/files.txt"
  fi
fi

# 4b. trace: spec items, candidates and occurrences. Fail-soft like step 4. Prints the count of changed normative spec items.
# A PR with no code files is reviewed only if a normative spec item changed.
if [ "${TRACE:-auto}" != off ]; then
  if nchanged=$(timeout 60 node "$HERE/trace.js" | tail -n 1); then echo ok > "$CTX/trace-status"
  else echo "::warning::requirement tracing failed; continuing without trace data"; nchanged=0; fi
else nchanged=0; fi
[[ $nchanged =~ ^[0-9]+$ ]] || nchanged=0
if [ "$ncode" -eq 0 ] && [ "$nchanged" -eq 0 ]; then
  : > "$CTX/diff.patch"; : > "$CTX/files.txt"
  echo "nothing reviewable in diff"; out skip true; exit 0
fi

# 5. oversize: keep whole files in diff order within the budget. A file that does not fit is dropped and listed in diff-dropped.txt
# (a later, smaller one may still fit); the first file alone over the budget keeps its first whole hunks and is listed as "path (partial)".
if [ "$(wc -c < "$CTX/diff.patch")" -gt $((MAX_DIFF_KB * 1024)) ]; then
  MAX=$((MAX_DIFF_KB * 1024)) KEEP="$CTX/diff.tmp" DROP="$CTX/diff-dropped.txt" LC_ALL=C awk '
function flush(   i, j, k, s, sz, hs, nh) {
  if (!n) return
  sz = 0; for (i = 1; i <= n; i++) sz += length(L[i]) + 1
  if (sz <= max - used) { for (i = 1; i <= n; i++) print L[i] > keep; used += sz }
  else if (nfiles == 1) { # the first file alone exceeds the budget: its header and whole hunks that fit, else the first hunk cut at a line
    hs = n + 1; for (i = 1; i <= n; i++) if (L[i] ~ /^@@ /) { hs = i; break }
    for (i = 1; i < hs; i++) { print L[i] > keep; used += length(L[i]) + 1 }
    i = hs; nh = 0
    while (i <= n) {
      j = i + 1; while (j <= n && L[j] !~ /^@@ /) j++
      s = 0; for (k = i; k < j; k++) s += length(L[k]) + 1
      if (used + s > max) break
      for (k = i; k < j; k++) print L[k] > keep
      used += s; nh++; i = j
    }
    if (!nh && i <= n) for (k = i; k < j && used + length(L[k]) + 1 <= max; k++) { print L[k] > keep; used += length(L[k]) + 1 }
    print path " (partial)" > drop
  } else print path > drop
  n = 0
}
function pathof(l,   r) { # "diff --git a/X b/X" (no renames: both sides equal, so X survives spaces) or the quoted form
  if (l ~ /^diff --git "a\//) { r = substr(l, 15); return substr(r, 1, (length(r) - 6) / 2) }
  r = substr(l, 14); return substr(r, 1, (length(r) - 3) / 2)
}
BEGIN { max = ENVIRON["MAX"] + 0; keep = ENVIRON["KEEP"]; drop = ENVIRON["DROP"]; printf "" > keep; printf "" > drop }
/^diff --git / { flush(); nfiles++; path = pathof($0) }
{ L[++n] = $0 }
END { flush() }
  ' "$CTX/diff.patch" && mv "$CTX/diff.tmp" "$CTX/diff.patch"
  out partial true
fi

# 6. Deterministic scaffolding for weak models (fail-soft, no AI): the PR diff with explicit line numbers, and per changed file the
# existing test files most likely to cover it. diff.patch stays on disk untouched. Written last so they match the truncated diff.patch.
node "$HERE/numdiff.js" "$CTX/diff.patch" "$CTX/diff.numbered.txt" 2>/dev/null || { rm -f "$CTX/diff.numbered.txt"; echo "::warning::numbered diff failed; the raw diff is used"; }
# Up to 5 per changed non-test file: same basename stem with test/spec affixes (any directory), test files named after a public name of the file (res.status.js), tests that mention the stem as a whole word
# (imports, references), then tests in the same directory. ponytail: names and a word grep only, no per-language import parsing.
# CAND_ONLY=file (paths in the first column): add blocks for those files only, to the existing list (step 7a: the files focus chose).
# candidates-cut.txt: changed files left without a block (file or byte cap); post.js distrusts missing_test claims about them.
candidates() { timeout 60 node - "$HERE/trace.js" "$CTX" <<'JS'
const fs = require('node:fs'), path = require('node:path'), { execFileSync } = require('node:child_process');
const { isTestPath, testScope } = require(path.resolve(process.argv[2])), { mapTests, publicDefs } = require(path.join(path.dirname(path.resolve(process.argv[2])), 'test-map.js'));
const ctx = process.argv[3], CAP = 16 * 1024, PER = 5, MAX_FILES = 60;
const lines = (f) => { try { return fs.readFileSync(path.join(ctx, f), 'utf8').split('\n').filter(Boolean); } catch { return []; } };
const tracked = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8', maxBuffer: 1 << 28 }).split('\0').filter((p) => p && !/[\x00-\x1F]/.test(p));
// TEST_PATHS (test_paths): the repo owner's authoritative test locations; files there are the tests, whatever their name. Empty = discovery by name.
const scope = testScope(process.env.TEST_PATHS), DOC = /\.(md|mdx|markdown|rst|adoc|txt)$/i;
const isTest = scope ? (p) => scope(p) && !DOC.test(p) : isTestPath;
const tests = tracked.filter(isTest), testSet = new Set(tests);
if (scope) fs.writeFileSync(path.join(ctx, 'test-paths.txt'), String(process.env.TEST_PATHS).split(/\r?\n/).map((l) => l.trim()).filter(Boolean).join('\n') + '\n');
const specs = new Set(lines('spec-files.txt'));
const changed = lines('files.txt').filter((f) => !isTest(f) && !isTestPath(f) && !specs.has(f) && !/\.(md|mdx|markdown|rst|adoc|txt|feature|json|ya?ml|toml|lock)$/i.test(f));
const only = process.env.CAND_ONLY ? new Set(lines(path.relative(ctx, process.env.CAND_ONLY)).map((l) => l.split('\t')[0])) : null;
const prev = only ? lines('test-candidates.txt').filter((l) => !/^\(\d+ more changed file/.test(l)).join('\n') : '';
const listed = new Set(prev.split('\n').filter((l) => l && !/^[ (]/.test(l)));
const todo = changed.filter((f) => !listed.has(f) && (!only || only.has(f)));
const out = []; let size = prev.length;
for (const [k, f] of todo.entries()) {
  if (k >= MAX_FILES) break;
  let names = []; try { names = publicDefs(f, fs.readFileSync(f, 'utf8').split(/\r?\n/)).names; } catch {} // public names: a test file named after one (res.status.js) is a candidate
  const got = mapTests(f, { tests, names, per: PER, mentions: (stem) => { // tests that name the stem as a whole word (a timeout or no match: none)
    try { return execFileSync('git', ['grep', '-l', '-w', '-F', '-I', '-e', stem], { encoding: 'utf8', timeout: 15000, maxBuffer: 1 << 26, env: { ...process.env, GIT_LITERAL_PATHSPECS: '1' } }).split('\n').filter((t) => testSet.has(t)); } catch { return []; }
  } });
  const block = f + '\n' + (got.size ? [...got].map(([t, why]) => `  ${t}  (${why})\n`).join('') : '  (no candidate test file found)\n');
  if (size + block.length > CAP) break;
  out.push(block); size += block.length; listed.add(f);
}
const unlisted = changed.filter((f) => !listed.has(f));
if (unlisted.length) out.push(`(${unlisted.length} more changed file(s) not listed)\n`);
fs.writeFileSync(path.join(ctx, 'test-candidates.txt'), (prev ? prev + '\n' : '') + out.join(''));
fs.writeFileSync(path.join(ctx, 'candidates-cut.txt'), unlisted.map((f) => f + '\n').join(''));
JS
}
candidates || { echo "::warning::test candidates failed; continuing without them"; rm -f "$CTX/test-candidates.txt" "$CTX/candidates-cut.txt"; }

# 7. Large PR (over FOCUS_THRESHOLD lines,files): rank the changed files by risk and give the model only the top FOCUS_FILES (src/focus.js).
# Writes focus.txt, focus-skipped.txt and focus-requirements.txt and narrows diff.numbered.txt; diff.patch stays whole. Fail-soft: the full numbered diff comes back.
timeout 60 node "$HERE/focus.js" "$CTX" || { echo "::warning::focused review failed; the whole diff is used"; rm -f "$CTX/focus.txt" "$CTX/focus-skipped.txt" "$CTX/focus-requirements.txt"; node "$HERE/numdiff.js" "$CTX/diff.patch" "$CTX/diff.numbered.txt" 2>/dev/null || rm -f "$CTX/diff.numbered.txt"; }

# 7a. Step 6 caps by files.txt order, not by risk: give the files focus chose their candidate tests too.
if [ -s "$CTX/focus.txt" ] && [ -f "$CTX/test-candidates.txt" ]; then
  CAND_ONLY="$CTX/focus.txt" candidates || echo "::warning::test candidates for the focused files failed; continuing without them"
fi

# 8. Deterministic leads (src/leads.js): changed symbols with/without a test reference, suspected mirror assertions. Hints for the reviewer, never findings.
# Runs after focus.js so a focused review only sees leads for the chosen files. Fail-soft: no leads.txt is the normal prompt.
rm -f "$CTX/leads.txt"
timeout 30 node "$HERE/leads.js" "$CTX" || { echo "::warning::leads failed; continuing without them"; rm -f "$CTX/leads.txt"; }
