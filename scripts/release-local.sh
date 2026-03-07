#!/usr/bin/env bash
# ────────────────────────────────────────────────────────────────────────────
# release-local.sh — Build Hermes IDE locally and upload to GitHub Releases
#
# Usage:
#   ./scripts/release-local.sh              # build macOS + Linux (all local targets)
#   ./scripts/release-local.sh --macos      # build macOS only (aarch64 + x86_64)
#   ./scripts/release-local.sh --linux      # build Linux only via Docker (x86_64 + aarch64)
#   ./scripts/release-local.sh --manifests  # only regenerate & upload latest.json + downloads.json
#   ./scripts/release-local.sh --skip-notarize  # skip Apple notarization (faster for testing)
#
# Credentials are loaded from scripts/release-local.env (see release-local.env.example).
# ────────────────────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
RELEASES_REPO="Vinci-26/hermes-ide-releases"
ARTIFACTS_DIR="$PROJECT_DIR/release-artifacts"
DOCKER_IMAGE="hermes-linux-builder"

# ── Colors ──────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'
info()  { echo -e "${BLUE}[info]${NC}  $*"; }
ok()    { echo -e "${GREEN}[ok]${NC}    $*"; }
warn()  { echo -e "${YELLOW}[warn]${NC}  $*"; }
fail()  { echo -e "${RED}[fail]${NC}  $*"; exit 1; }
step()  { echo -e "\n${GREEN}━━━ $* ━━━${NC}\n"; }

# ── Parse arguments ─────────────────────────────────────────────────────────
BUILD_MACOS=false
BUILD_LINUX=false
SKIP_NOTARIZE=false
MANIFESTS_ONLY=false

for arg in "$@"; do
  case "$arg" in
    --macos)          BUILD_MACOS=true ;;
    --linux)          BUILD_LINUX=true ;;
    --all)            BUILD_MACOS=true; BUILD_LINUX=true ;;
    --skip-notarize)  SKIP_NOTARIZE=true ;;
    --manifests)      MANIFESTS_ONLY=true ;;
    --help|-h)
      sed -n '2,/^# ─/{ /^# ─/d; s/^# //; s/^#//; p }' "$0"
      exit 0 ;;
    *) fail "Unknown flag: $arg (use --help)" ;;
  esac
done

# Default to --all if nothing specified
if ! $BUILD_MACOS && ! $BUILD_LINUX && ! $MANIFESTS_ONLY; then
  BUILD_MACOS=true
  BUILD_LINUX=true
fi

# ── Load environment ────────────────────────────────────────────────────────
ENV_FILE="$SCRIPT_DIR/release-local.env"
if [[ -f "$ENV_FILE" ]]; then
  set -a; source "$ENV_FILE"; set +a
  info "Loaded credentials from release-local.env"
fi

# ── Read version ────────────────────────────────────────────────────────────
cd "$PROJECT_DIR"
VERSION=$(node -p "require('./src-tauri/tauri.conf.json').version")
TAG="v$VERSION"
info "Version: $VERSION  Tag: $TAG"

# ── Load updater signing key ────────────────────────────────────────────────
if [[ -z "${TAURI_SIGNING_PRIVATE_KEY:-}" ]]; then
  KEY_FILE="$HOME/.tauri/hermes-ide.key"
  if [[ -f "$KEY_FILE" ]]; then
    export TAURI_SIGNING_PRIVATE_KEY
    TAURI_SIGNING_PRIVATE_KEY=$(cat "$KEY_FILE")
    info "Loaded signing key from $KEY_FILE"
  else
    fail "No TAURI_SIGNING_PRIVATE_KEY set and $KEY_FILE not found"
  fi
fi

if [[ -z "${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}" ]]; then
  echo -n "Enter updater signing key password: "
  read -rs TAURI_SIGNING_PRIVATE_KEY_PASSWORD
  echo
  export TAURI_SIGNING_PRIVATE_KEY_PASSWORD
fi

# ── Validate prerequisites ──────────────────────────────────────────────────
command -v gh    >/dev/null || fail "gh CLI not found (brew install gh)"
command -v node  >/dev/null || fail "node not found"
command -v jq    >/dev/null || fail "jq not found (brew install jq)"
gh auth status   >/dev/null 2>&1 || fail "gh not authenticated (run: gh auth login)"

if $BUILD_MACOS; then
  command -v cargo >/dev/null || fail "cargo not found"
fi
if $BUILD_LINUX; then
  command -v docker >/dev/null || fail "docker not found (install Docker Desktop)"
  docker info >/dev/null 2>&1 || fail "Docker daemon not running"
fi

# ── Prepare artifacts directory ─────────────────────────────────────────────
rm -rf "$ARTIFACTS_DIR"
mkdir -p "$ARTIFACTS_DIR"

# ═══════════════════════════════════════════════════════════════════════════
# BUILD FUNCTIONS
# ═══════════════════════════════════════════════════════════════════════════

build_macos_target() {
  local target="$1"
  local platform_key="$2"

  step "Building macOS — $target"
  cd "$PROJECT_DIR"

  # Tauri picks up the signing identity from the keychain automatically
  export APPLE_SIGNING_IDENTITY="Developer ID Application: Gabriel Anhaia da Silva (4987F43NL6)"
  npx tauri build --target "$target"

  local target_dir="src-tauri/target/$target/release/bundle"

  # Collect installer (DMG)
  for f in "$target_dir"/dmg/*.dmg; do
    [[ -f "$f" ]] && cp "$f" "$ARTIFACTS_DIR/"
  done

  # Collect updater bundle with platform prefix (avoids name collisions)
  for f in "$target_dir"/macos/*.tar.gz; do
    [[ -f "$f" ]] || continue
    local basename
    basename=$(basename "$f")
    cp "$f" "$ARTIFACTS_DIR/${platform_key}-${basename}"
    [[ -f "${f}.sig" ]] && cp "${f}.sig" "$ARTIFACTS_DIR/${platform_key}-${basename}.sig"
  done

  ok "Built $platform_key"
}

notarize_dmg() {
  local dmg_path="$1"
  local dmg_name
  dmg_name=$(basename "$dmg_path")

  if $SKIP_NOTARIZE; then
    warn "Skipping notarization for $dmg_name (--skip-notarize)"
    return 0
  fi

  # Validate notarization credentials
  [[ -n "${APPLE_ID:-}" ]]          || fail "APPLE_ID not set (needed for notarization)"
  [[ -n "${APPLE_ID_PASSWORD:-}" ]] || fail "APPLE_ID_PASSWORD not set"
  [[ -n "${APPLE_TEAM_ID:-}" ]]     || fail "APPLE_TEAM_ID not set"

  info "Notarizing $dmg_name..."
  local notarized=false
  for attempt in 1 2 3; do
    if xcrun notarytool submit "$dmg_path" \
      --apple-id "$APPLE_ID" \
      --password "$APPLE_ID_PASSWORD" \
      --team-id "$APPLE_TEAM_ID" \
      --wait --timeout 8m 2>&1; then
      notarized=true
      break
    fi
    warn "Notarization attempt $attempt failed"
    [[ "$attempt" -lt 3 ]] && sleep 15
  done

  if ! $notarized; then
    fail "All 3 notarization attempts failed for $dmg_name"
  fi

  xcrun stapler staple "$dmg_path"
  ok "Notarized $dmg_name"
}

build_linux_target() {
  local docker_platform="$1"    # linux/amd64 or linux/arm64
  local rust_target="$2"        # x86_64-unknown-linux-gnu or aarch64-unknown-linux-gnu
  local platform_key="$3"       # linux-x86_64 or linux-aarch64

  step "Building Linux — $rust_target (Docker $docker_platform)"

  # Build the Docker image if not already built
  if ! docker image inspect "$DOCKER_IMAGE" >/dev/null 2>&1; then
    info "Building Docker image ($DOCKER_IMAGE)..."
    docker build \
      --platform "$docker_platform" \
      -t "$DOCKER_IMAGE" \
      -f "$SCRIPT_DIR/docker/Dockerfile.linux" \
      "$SCRIPT_DIR/docker"
  fi

  local out_dir="$ARTIFACTS_DIR/$platform_key"
  mkdir -p "$out_dir"

  docker run --rm \
    --platform "$docker_platform" \
    -v "$PROJECT_DIR":/src:ro \
    -v "hermes-cargo-registry-${platform_key}":/usr/local/cargo/registry \
    -v "hermes-cargo-git-${platform_key}":/usr/local/cargo/git \
    -v "hermes-target-${platform_key}":/build/src-tauri/target \
    -v "$out_dir":/out \
    -e TAURI_SIGNING_PRIVATE_KEY \
    -e TAURI_SIGNING_PRIVATE_KEY_PASSWORD \
    "$DOCKER_IMAGE" \
    "$rust_target"

  # Move artifacts from sub-dir to main artifacts dir with proper naming
  for f in "$out_dir"/*; do
    [[ -f "$f" ]] || continue
    local basename
    basename=$(basename "$f")
    # Updater bundles (AppImage + sig) get platform prefix
    if [[ "$basename" == *.AppImage.sig ]] || [[ "$basename" == *.AppImage && ! "$basename" == ${platform_key}-* ]]; then
      mv "$f" "$ARTIFACTS_DIR/${platform_key}-${basename}"
    else
      mv "$f" "$ARTIFACTS_DIR/${basename}"
    fi
  done
  rmdir "$out_dir" 2>/dev/null || true

  ok "Built $platform_key"
}

# ═══════════════════════════════════════════════════════════════════════════
# UPLOAD & MANIFEST FUNCTIONS
# ═══════════════════════════════════════════════════════════════════════════

ensure_release_exists() {
  step "Ensuring GitHub release $TAG exists"
  if gh release view "$TAG" --repo "$RELEASES_REPO" >/dev/null 2>&1; then
    info "Release $TAG already exists"
  else
    info "Creating release $TAG..."
    gh release create "$TAG" \
      --repo "$RELEASES_REPO" \
      --title "Hermes IDE $TAG" \
      --notes "Download the installer for your platform, or update in-app. Full changelog: https://hermes-ide.com/changelog"
    ok "Created release $TAG"
  fi
}

upload_artifacts() {
  step "Uploading artifacts to $TAG"

  # Collect files to upload (exclude manifests — those are uploaded separately)
  local files=()
  for f in "$ARTIFACTS_DIR"/*; do
    [[ -f "$f" ]] || continue
    local name
    name=$(basename "$f")
    # Skip manifests and directories
    [[ "$name" == "latest.json" || "$name" == "downloads.json" ]] && continue
    files+=("$f")
  done

  if [[ ${#files[@]} -eq 0 ]]; then
    warn "No artifacts to upload"
    return 0
  fi

  info "Uploading ${#files[@]} files..."
  gh release upload "$TAG" \
    --repo "$RELEASES_REPO" \
    --clobber \
    "${files[@]}"

  ok "Uploaded ${#files[@]} artifacts"
}

regenerate_manifests() {
  step "Regenerating manifests from release assets"

  local tmp_dir
  tmp_dir=$(mktemp -d)
  trap "rm -rf '$tmp_dir'" RETURN

  # Download all .sig files from the release
  info "Downloading signature files..."
  gh release download "$TAG" \
    --repo "$RELEASES_REPO" \
    --pattern "*.sig" \
    --dir "$tmp_dir" \
    --clobber 2>/dev/null || true

  # Get the full list of release assets
  local assets
  assets=$(gh release view "$TAG" --repo "$RELEASES_REPO" --json assets -q '.assets[].name')
  local base_url="https://github.com/$RELEASES_REPO/releases/download/$TAG"

  # ── latest.json (updater manifest) ──────────────────────────────────────
  info "Building latest.json..."
  local platforms_json='{}'

  add_updater_platform() {
    local key="$1" pattern="$2"
    local bundle_name sig_content=""

    # Find the bundle file (not the .sig)
    bundle_name=$(echo "$assets" | grep -E "$pattern" | grep -v '\.sig$' | head -1 || true)
    [[ -z "$bundle_name" ]] && return 0

    # Read signature
    if [[ -f "$tmp_dir/${bundle_name}.sig" ]]; then
      sig_content=$(cat "$tmp_dir/${bundle_name}.sig")
    fi

    platforms_json=$(echo "$platforms_json" | jq \
      --arg k "$key" \
      --arg sig "$sig_content" \
      --arg url "${base_url}/${bundle_name}" \
      '.[$k] = {signature: $sig, url: $url}')
  }

  add_updater_platform "darwin-aarch64"  "^darwin-aarch64-.*\.tar\.gz$"
  add_updater_platform "darwin-x86_64"   "^darwin-x86_64-.*\.tar\.gz$"
  add_updater_platform "linux-x86_64"    "^linux-x86_64-.*\.AppImage$"
  add_updater_platform "linux-aarch64"   "^linux-aarch64-.*\.AppImage$"
  add_updater_platform "windows-x86_64"  "^windows-x86_64-.*-setup\.exe$"
  add_updater_platform "windows-aarch64" "^windows-aarch64-.*-setup\.exe$"

  jq -n \
    --arg version "$VERSION" \
    --arg notes "See the full changelog at https://hermes-ide.com/changelog" \
    --arg pub_date "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --argjson platforms "$platforms_json" \
    '{version: $version, notes: $notes, pub_date: $pub_date, platforms: $platforms}' \
    > "$ARTIFACTS_DIR/latest.json"

  info "latest.json platforms: $(echo "$platforms_json" | jq -r 'keys | join(", ")')"

  # ── downloads.json (website download links) ─────────────────────────────
  info "Building downloads.json..."
  local dl_json='{}'

  add_download() {
    local platform="$1" arch="$2" format="$3" pattern="$4"
    local filename
    filename=$(echo "$assets" | grep -E "$pattern" | head -1 || true)
    [[ -z "$filename" ]] && return 0
    dl_json=$(echo "$dl_json" | jq \
      --arg p "$platform" --arg a "$arch" --arg f "$format" --arg n "$filename" \
      '.[$p][$a][$f] = $n')
  }

  add_download "macos"   "aarch64" "dmg"      "_aarch64\.dmg$"
  add_download "macos"   "x86_64"  "dmg"      "_x86_64\.dmg$"
  add_download "linux"   "x86_64"  "appimage" "_amd64\.AppImage$"
  add_download "linux"   "x86_64"  "deb"      "_amd64\.deb$"
  add_download "linux"   "aarch64" "appimage" "_arm64\.AppImage$"
  add_download "windows" "x86_64"  "exe"      "_x64-setup\.exe$"
  add_download "windows" "aarch64" "exe"      "_arm64-setup\.exe$"

  jq -n \
    --arg version "$VERSION" \
    --argjson platforms "$dl_json" \
    '{version: $version, platforms: $platforms}' \
    > "$ARTIFACTS_DIR/downloads.json"

  # Upload manifests
  info "Uploading manifests..."
  gh release upload "$TAG" \
    --repo "$RELEASES_REPO" \
    --clobber \
    "$ARTIFACTS_DIR/latest.json" \
    "$ARTIFACTS_DIR/downloads.json"

  ok "Manifests uploaded"
  echo
  echo "  latest.json:    ${base_url}/latest.json"
  echo "  downloads.json: ${base_url}/downloads.json"
}

# ═══════════════════════════════════════════════════════════════════════════
# MAIN
# ═══════════════════════════════════════════════════════════════════════════

echo
echo "  Hermes IDE — Local Release Builder"
echo "  Version: $VERSION   Tag: $TAG"
echo "  macOS: $BUILD_MACOS   Linux: $BUILD_LINUX   Manifests only: $MANIFESTS_ONLY"
echo

if ! $MANIFESTS_ONLY; then
  # ── macOS builds ──────────────────────────────────────────────────────
  if $BUILD_MACOS; then
    npm ci

    build_macos_target "aarch64-apple-darwin" "darwin-aarch64"
    build_macos_target "x86_64-apple-darwin"  "darwin-x86_64"

    # Notarize all DMGs
    for dmg in "$ARTIFACTS_DIR"/*.dmg; do
      [[ -f "$dmg" ]] && notarize_dmg "$dmg"
    done
  fi

  # ── Linux builds (Docker) ────────────────────────────────────────────
  if $BUILD_LINUX; then
    build_linux_target "linux/amd64" "x86_64-unknown-linux-gnu"  "linux-x86_64"
    build_linux_target "linux/arm64" "aarch64-unknown-linux-gnu" "linux-aarch64"
  fi

  # ── Upload ────────────────────────────────────────────────────────────
  ensure_release_exists
  upload_artifacts
fi

# ── Always regenerate manifests ─────────────────────────────────────────
ensure_release_exists
regenerate_manifests

step "Done"
echo "  Release: https://github.com/$RELEASES_REPO/releases/tag/$TAG"
echo
echo "  Tip: If you need Windows builds, trigger CI with:"
echo "    gh workflow run release.yml --repo <your-private-repo> -f platforms=windows"
echo
