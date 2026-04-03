#!/bin/bash
# Copy the hermes-pty-setup binary into the macOS .app bundle.
# Run AFTER `cargo tauri build` to place the sidecar next to the main binary.
#
# Usage: ./prepare-sidecar.sh [--release]
#
# This binary sets the controlling terminal (ioctl TIOCSCTTY) before exec'ing
# the shell, working around a macOS posix_spawn limitation.  See issue #214.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$(dirname "$SCRIPT_DIR")")"
PROFILE="${1:-release}"
TARGET="${TAURI_TARGET:-$(rustc -vV | grep host | cut -d' ' -f2)}"

SRC="$ROOT_DIR/target/$TARGET/$PROFILE/hermes-pty-setup"
if [ ! -f "$SRC" ]; then
    SRC="$ROOT_DIR/target/$PROFILE/hermes-pty-setup"
fi

if [ ! -f "$SRC" ]; then
    echo "Error: hermes-pty-setup binary not found"
    echo "Build it first: cargo build --release --bin hermes-pty-setup"
    exit 1
fi

# Find the .app bundle
APP_DIR=$(find "$ROOT_DIR/target" -path "*/bundle/macos/HERMES-IDE.app/Contents/MacOS" -type d 2>/dev/null | head -1)
if [ -n "$APP_DIR" ]; then
    cp "$SRC" "$APP_DIR/hermes-pty-setup"
    echo "Copied hermes-pty-setup to $APP_DIR/"
else
    echo "No .app bundle found — skipping (this is OK for dev builds)"
fi
