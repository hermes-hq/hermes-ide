#!/usr/bin/env bash
#
# generate-changelog.sh — Generate user-facing changelog entries from git commits.
#
# Usage:
#   ./scripts/generate-changelog.sh [VERSION_TAG]
#
# Examples:
#   ./scripts/generate-changelog.sh v0.3.38
#   ./scripts/generate-changelog.sh              # auto-detects from package.json
#
# Generates changelog entries grouped by category (New, Fixed, Improved, Removed)
# based on conventional commit prefixes. Output follows the project's
# RELEASE_TEMPLATE.md format with user-facing language only.
#
# Non-user-facing commits (version bumps, CI, dependency updates, tests) are
# automatically filtered out to keep the changelog focused on what users notice.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# ── Resolve version tag ─────────────────────────────────────────────────────

if [[ -n "${1:-}" ]]; then
  VERSION_TAG="$1"
else
  VERSION=$(node -p "require('$PROJECT_ROOT/package.json').version" 2>/dev/null || echo "")
  if [[ -z "$VERSION" ]]; then
    echo "Error: Could not detect version. Pass a tag as argument (e.g., v0.3.38)." >&2
    exit 1
  fi
  VERSION_TAG="v${VERSION}"
fi

# Strip leading 'v' for display, ensure tag has it
VERSION_DISPLAY="${VERSION_TAG#v}"
[[ "$VERSION_TAG" != v* ]] && VERSION_TAG="v${VERSION_TAG}"

# ── Find previous tag ────────────────────────────────────────────────────────

# Get the tag just before VERSION_TAG. If VERSION_TAG doesn't exist yet
# (pre-release), use the latest tag on the current branch.
if git rev-parse "$VERSION_TAG" >/dev/null 2>&1; then
  PREV_TAG=$(git tag --sort=-v:refname --merged "$VERSION_TAG" | grep -v "^${VERSION_TAG}$" | head -1 || true)
  RANGE="${PREV_TAG:+${PREV_TAG}..${VERSION_TAG}}"
  [[ -z "$PREV_TAG" ]] && RANGE="$VERSION_TAG"
else
  # Tag doesn't exist yet — compare HEAD against the latest existing tag
  PREV_TAG=$(git describe --tags --abbrev=0 HEAD 2>/dev/null || true)
  RANGE="${PREV_TAG:+${PREV_TAG}..HEAD}"
  [[ -z "$PREV_TAG" ]] && RANGE="HEAD"
fi

# ── Collect commits ──────────────────────────────────────────────────────────

COMMITS=$(git log --first-parent --pretty=format:"%s" "$RANGE" 2>/dev/null || true)

if [[ -z "$COMMITS" ]]; then
  echo "No commits found in range ${RANGE}." >&2
  exit 0
fi

# ── Helper: clean up a commit message for user-facing display ────────────────

clean_message() {
  local msg="$1"

  # Strip trailing PR reference (#123)
  msg=$(echo "$msg" | sed -E 's/ *\(#[0-9]+\)$//')

  # Capitalize first letter
  msg="$(echo "${msg:0:1}" | tr '[:lower:]' '[:upper:]')${msg:1}"

  echo "$msg"
}

# ── Categorize commits ───────────────────────────────────────────────────────

NEW_ITEMS=()
FIXED_ITEMS=()
IMPROVED_ITEMS=()
REMOVED_ITEMS=()
UNCATEGORIZED=()

while IFS= read -r line; do
  [[ -z "$line" ]] && continue

  # ── Skip non-user-facing commits ──────────────────────────────────────────
  # Merge commits
  [[ "$line" =~ ^Merge\ (branch|pull\ request|remote) ]] && continue
  # Version bumps
  [[ "$line" =~ ^Bump\ v[0-9] ]] && continue
  # Dependency bumps (Dependabot, manual)
  [[ "$line" =~ ^Bump\ .+\ from\ .+\ to ]] && continue
  # CI/build-only changes
  CI_RE='^(ci|build|test|chore)(\(.*\))?(!)?: '
  [[ "$line" =~ $CI_RE ]] && continue
  # Commits that are purely CI/infra by content
  [[ "$line" =~ CI|workflow|"artifact retention"|Dependabot|clippy|"cargo audit"|Cargo.lock ]] && continue

  # ── Extract prefix and message ────────────────────────────────────────────
  CONV_RE='^(feat|fix|docs|refactor|perf|style|revert|remove|breaking)(\(.*\))?(!)?: (.+)'
  if [[ "$line" =~ $CONV_RE ]]; then
    prefix="${BASH_REMATCH[1]}"
    msg=$(clean_message "${BASH_REMATCH[4]}")

    case "$prefix" in
      feat)
        NEW_ITEMS+=("$msg")
        ;;
      fix)
        FIXED_ITEMS+=("$msg")
        ;;
      refactor|perf|docs|style)
        IMPROVED_ITEMS+=("$msg")
        ;;
      remove|revert)
        REMOVED_ITEMS+=("$msg")
        ;;
      breaking)
        NEW_ITEMS+=("$msg")
        ;;
    esac
  else
    # Non-conventional commit — categorize by keywords
    msg=$(clean_message "$line")

    if [[ "$line" =~ ^[Ff]ix ]]; then
      FIXED_ITEMS+=("$msg")
    elif [[ "$line" =~ ^[Aa]dd ]]; then
      NEW_ITEMS+=("$msg")
    elif [[ "$line" =~ ^[Rr]emove ]]; then
      REMOVED_ITEMS+=("$msg")
    else
      IMPROVED_ITEMS+=("$msg")
    fi
  fi
done <<< "$COMMITS"

# ── Generate output ──────────────────────────────────────────────────────────

OUTPUT=""
HAS_CONTENT=false

add_section() {
  local heading="$1"
  shift
  local items=("$@")

  if [[ ${#items[@]} -gt 0 ]]; then
    [[ "$HAS_CONTENT" == true ]] && OUTPUT+=$'\n'
    OUTPUT+="## ${heading}"$'\n'
    for item in "${items[@]}"; do
      OUTPUT+="- ${item}"$'\n'
    done
    HAS_CONTENT=true
  fi
}

add_section "New" "${NEW_ITEMS[@]+"${NEW_ITEMS[@]}"}"
add_section "Improved" "${IMPROVED_ITEMS[@]+"${IMPROVED_ITEMS[@]}"}"
add_section "Fixed" "${FIXED_ITEMS[@]+"${FIXED_ITEMS[@]}"}"
add_section "Removed" "${REMOVED_ITEMS[@]+"${REMOVED_ITEMS[@]}"}"

if [[ "$HAS_CONTENT" == false ]]; then
  echo "No notable changes found in range ${RANGE}." >&2
  exit 0
fi

# ── Print to stdout ──────────────────────────────────────────────────────────

echo "$OUTPUT"

# ── Optionally update CHANGELOG.md ───────────────────────────────────────────

CHANGELOG="$PROJECT_ROOT/CHANGELOG.md"

if [[ "${UPDATE_CHANGELOG:-false}" == "true" ]]; then
  DATE=$(date +%Y-%m-%d)
  ENTRY="# ${VERSION_DISPLAY} (${DATE})"$'\n\n'"${OUTPUT}"

  if [[ -f "$CHANGELOG" ]]; then
    # Prepend new entry after the header line
    HEADER=$(head -1 "$CHANGELOG")
    REST=$(tail -n +2 "$CHANGELOG")
    printf '%s\n\n%s\n%s\n' "$HEADER" "$ENTRY" "$REST" > "$CHANGELOG"
  else
    printf '# Changelog\n\n%s\n' "$ENTRY" > "$CHANGELOG"
  fi

  echo "" >&2
  echo "Updated $CHANGELOG" >&2
fi
