#!/usr/bin/env bash
# ════════════════════════════════════════════════════════════════════════════
# NOTE: This script is for LOCAL development/testing builds only.
#
# For production releases, use the GitHub Actions CI workflow (release.yml),
# which is the primary release path and handles all platforms (macOS signed +
# notarized, Linux, and Windows):
#
#   gh workflow run release.yml -f platforms=all -f tag=vX.Y.Z
#
# Or use the Makefile shortcut:
#
#   make release            # trigger CI for all platforms
#   make release-macos      # trigger CI for macOS only
#   make release-linux      # trigger CI for Linux only
#   make release-windows    # trigger CI for Windows only
#
# This script remains useful as a fallback for local builds and debugging.
# ════════════════════════════════════════════════════════════════════════════
# ────────────────────────────────────────────────────────────────────────────
# Hermes IDE — Full Interactive Release
#
# Build strategy:
#   macOS (aarch64 + x86_64) — locally on this Mac (signed + notarized)
#   Linux (x86_64 + aarch64)  — locally via Docker
#   Windows (x86_64 + arm64)  — GitHub Actions CI
#
# Usage:
#   ./scripts/release-full.sh                 # all 6 platforms
#   ./scripts/release-full.sh --skip-windows  # macOS + Linux only
# ────────────────────────────────────────────────────────────────────────────

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR/.."

VERSION=$(node -p "require('./src-tauri/tauri.conf.json').version")
TAG="v$VERSION"
PRIVATE_REPO="hermes-hq/hermes-ide"
PUBLIC_REPO="hermes-hq/hermes-ide"

# Colors
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'

banner() { echo -e "\n${CYAN}${BOLD}══════════════════════════════════════════════════${NC}"; echo -e "${CYAN}${BOLD}  $*${NC}"; echo -e "${CYAN}${BOLD}══════════════════════════════════════════════════${NC}\n"; }
step()   { echo -e "\n${GREEN}${BOLD}━━━ $* ━━━${NC}\n"; }
info()   { echo -e "  ${CYAN}[info]${NC}  $*"; }
ok()     { echo -e "  ${GREEN}[done]${NC}  $*"; }
warn()   { echo -e "  ${YELLOW}[warn]${NC}  $*"; }
err()    { echo -e "  ${RED}[error]${NC} $*"; }

wait_for_user() {
  echo ""
  echo -e "  ${YELLOW}${BOLD}▶ $1${NC}"
  echo ""
  read -rp "  Press Enter to continue (or 'skip' to skip): " answer
  [[ "$answer" == "skip" ]] && return 1 || return 0
}

SKIP_WINDOWS=false
for arg in "$@"; do
  case "$arg" in
    --skip-windows) SKIP_WINDOWS=true ;;
  esac
done

# ═══════════════════════════════════════════════════════════════════════════

banner "Hermes IDE — Release $TAG"

echo "  Version:  $VERSION"
echo "  Tag:      $TAG"
echo ""
echo "  Build plan:"
echo "    ✓ macOS aarch64 + x86_64  (local — signed & notarized)"
echo "    ✓ Linux x86_64 + aarch64  (local — Docker)"
if ! $SKIP_WINDOWS; then
  echo "    ✓ Windows x86_64 + arm64  (GitHub Actions CI)"
else
  echo "    ✗ Windows                 (skipped)"
fi
echo ""

wait_for_user "Ready to start?" || exit 0

# ═══════════════════════════════════════════════════════════════════════════
# STEP 1: macOS + Linux (local)
# ═══════════════════════════════════════════════════════════════════════════

step "Step 1: Building macOS + Linux locally"
./scripts/release-local.sh --all --skip-manifests
ok "macOS + Linux — built, signed, uploaded"

# ═══════════════════════════════════════════════════════════════════════════
# STEP 2: Windows (CI)
# ═══════════════════════════════════════════════════════════════════════════

if ! $SKIP_WINDOWS; then
  step "Step 2: Windows — GitHub Actions CI"

  info "Triggering CI for Windows (x86_64 + arm64)..."
  gh workflow run release.yml --repo "$PRIVATE_REPO" -f platforms=windows -f tag="$TAG"

  info "Waiting 10s for CI run to register..."
  sleep 10

  RUN_ID=$(gh run list --repo "$PRIVATE_REPO" --limit 1 --json databaseId -q '.[0].databaseId')
  info "Watching CI run $RUN_ID... (this may take 10-15 min)"

  if gh run watch "$RUN_ID" --repo "$PRIVATE_REPO" --exit-status; then
    ok "Windows CI complete"
  else
    err "Windows CI failed. Check: gh run view $RUN_ID --repo $PRIVATE_REPO"
    echo ""
    if ! wait_for_user "Continue to manifests anyway?"; then
      exit 1
    fi
  fi
fi

# ═══════════════════════════════════════════════════════════════════════════
# STEP 3: Manifests
# ═══════════════════════════════════════════════════════════════════════════

if $SKIP_WINDOWS; then
  step "Step 2: Regenerating manifests"
else
  step "Step 3: Regenerating manifests"
fi
./scripts/release-local.sh --manifests
ok "Manifests regenerated and uploaded"

# ═══════════════════════════════════════════════════════════════════════════
# DONE
# ═══════════════════════════════════════════════════════════════════════════

banner "Release $TAG Complete!"

echo "  https://github.com/$PUBLIC_REPO/releases/tag/$TAG"
echo ""

# Show platform coverage
assets=$(gh release view "$TAG" --repo "$PUBLIC_REPO" --json assets -q '.assets[].name' 2>/dev/null || true)
echo "  Platform coverage:"
echo "    macOS aarch64:   $(echo "$assets" | grep -c '_aarch64\.dmg$' || echo 0)"
echo "    macOS x86_64:    $(echo "$assets" | grep -c '_x86_64\.dmg$' || echo 0)"
echo "    Linux x86_64:    $(echo "$assets" | grep -c '_amd64\.' || echo 0)"
echo "    Linux aarch64:   $(echo "$assets" | grep -c '_aarch64\.\|_arm64\.' || echo 0)"
echo "    Windows x86_64:  $(echo "$assets" | grep -c '_x64-setup\.exe$' || echo 0)"
echo "    Windows arm64:   $(echo "$assets" | grep -c '_arm64-setup\.exe$' || echo 0)"
echo ""

if $SKIP_WINDOWS; then
  echo "  Windows was skipped. To add it later:"
  echo "    make release-ci-windows && make release-manifests"
  echo ""
fi
