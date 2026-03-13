# ────────────────────────────────────────────────────────────────────────────
# Hermes IDE — Release & Development Makefile
#
# Release Strategy:
#   The primary release path is the GitHub Actions CI workflow (release.yml).
#   CI handles all platforms: macOS (signed + notarized), Linux, and Windows.
#
#   Local scripts (release-local.sh, release-full.sh) are kept as fallback
#   for development/testing builds.
#
# Quick start:
#   make bump v=0.4.0       # bump version
#   make release-push        # push tag to remote
#   make release             # trigger CI release for all platforms
#
# Usage:  make help
# ────────────────────────────────────────────────────────────────────────────

SHELL := /bin/bash
VERSION := $(shell node -p "require('./src-tauri/tauri.conf.json').version")
TAG := v$(VERSION)
PRIVATE_REPO := hermes-hq/hermes-ide
PUBLIC_REPO := hermes-hq/hermes-ide

.PHONY: help dev build test bump release-push \
        release release-macos release-linux release-windows \
        release-local-full release-local-full-no-windows \
        release-local release-local-macos release-local-macos-fast release-local-linux \
        release-ci-windows release-ci-all \
        release-manifests release-watch release-status release-check release-check-platforms \
        clean

# ═══════════════════════════════════════════════════════════════════════════
# HELP
# ═══════════════════════════════════════════════════════════════════════════

help: ## Show this help
	@echo ""
	@echo "  Hermes IDE — v$(VERSION)"
	@echo ""
	@echo "  Development"
	@echo "  ─────────────────────────────────────────────────"
	@grep -E '^[a-z].*:.*## DEV:' $(MAKEFILE_LIST) | sed 's/:.* ## DEV: /\t/' | awk '{printf "  make %-28s %s\n", $$1, substr($$0, index($$0,"\t")+1)}'
	@echo ""
	@echo "  Version Bump"
	@echo "  ─────────────────────────────────────────────────"
	@grep -E '^[a-z].*:.*## BUMP:' $(MAKEFILE_LIST) | sed 's/:.* ## BUMP: /\t/' | awk '{printf "  make %-28s %s\n", $$1, substr($$0, index($$0,"\t")+1)}'
	@echo ""
	@echo "  Release"
	@echo "  ─────────────────────────────────────────────────"
	@grep -E '^[a-z].*:.*## REL:' $(MAKEFILE_LIST) | sed 's/:.* ## REL: /\t/' | awk '{printf "  make %-28s %s\n", $$1, substr($$0, index($$0,"\t")+1)}'
	@echo ""
	@echo "  Monitoring"
	@echo "  ─────────────────────────────────────────────────"
	@grep -E '^[a-z].*:.*## MON:' $(MAKEFILE_LIST) | sed 's/:.* ## MON: /\t/' | awk '{printf "  make %-28s %s\n", $$1, substr($$0, index($$0,"\t")+1)}'
	@echo ""
	@echo "  Local Builds (fallback)"
	@echo "  ─────────────────────────────────────────────────"
	@grep -E '^[a-z].*:.*## LOCAL:' $(MAKEFILE_LIST) | sed 's/:.* ## LOCAL: /\t/' | awk '{printf "  make %-28s %s\n", $$1, substr($$0, index($$0,"\t")+1)}'
	@echo ""
	@echo "  Recommended Workflow"
	@echo "  ─────────────────────────────────────────────────"
	@echo "    make bump v=0.4.0"
	@echo "    make release-push"
	@echo "    make release                # trigger CI for all platforms"
	@echo "    make release-watch          # monitor CI progress"
	@echo ""

# ═══════════════════════════════════════════════════════════════════════════
# DEVELOPMENT
# ═══════════════════════════════════════════════════════════════════════════

dev: ## DEV: Start Tauri dev mode
	npm run tauri dev

build: ## DEV: Production build (no upload)
	npm run tauri build

test: ## DEV: Run all tests (frontend + type check)
	npx tsc --noEmit && npx vitest run

# ═══════════════════════════════════════════════════════════════════════════
# VERSION BUMP
# ═══════════════════════════════════════════════════════════════════════════

bump: ## BUMP: Bump version — make bump v=0.4.0
ifndef v
	$(error Usage: make bump v=0.4.0)
endif
	npm run bump -- $(v)
	@echo ""
	@echo "  Version bumped to $(v). Now run:"
	@echo "    make release-push"
	@echo ""

release-push: ## BUMP: Push main + tag to remote
	git push origin main && git push origin --tags
	@echo ""
	@echo "  Pushed $(TAG)."
	@echo ""

# ═══════════════════════════════════════════════════════════════════════════
# RELEASE — CI-driven (primary path)
# ═══════════════════════════════════════════════════════════════════════════

release: ## REL: Trigger a full release via CI (all platforms)
	@VERSION=$$(node -p "require('./src-tauri/tauri.conf.json').version"); \
	echo "Triggering release v$$VERSION for all platforms..."; \
	gh workflow run release.yml -f platforms=all -f tag="v$$VERSION"

release-macos: ## REL: Trigger macOS-only release via CI
	@VERSION=$$(node -p "require('./src-tauri/tauri.conf.json').version"); \
	gh workflow run release.yml -f platforms=macos -f tag="v$$VERSION"

release-linux: ## REL: Trigger Linux-only release via CI
	@VERSION=$$(node -p "require('./src-tauri/tauri.conf.json').version"); \
	gh workflow run release.yml -f platforms=linux -f tag="v$$VERSION"

release-windows: ## REL: Trigger Windows-only release via CI
	@VERSION=$$(node -p "require('./src-tauri/tauri.conf.json').version"); \
	gh workflow run release.yml -f platforms=windows -f tag="v$$VERSION"

release-manifests: ## REL: Regenerate latest.json + downloads.json
	./scripts/release-local.sh --manifests

# ═══════════════════════════════════════════════════════════════════════════
# RELEASE — Local builds (fallback for development/testing)
# ═══════════════════════════════════════════════════════════════════════════

release-local-full: ## LOCAL: All 6 platforms — Mac+Linux local, Windows CI (interactive)
	./scripts/release-full.sh

release-local-full-no-windows: ## LOCAL: macOS + Linux only (4 platforms, no CI)
	./scripts/release-full.sh --skip-windows

release-local: ## LOCAL: Build macOS + Linux locally, sign, notarize, upload
	./scripts/release-local.sh --all

release-local-macos: ## LOCAL: Build macOS only (signed + notarized), upload
	./scripts/release-local.sh --macos

release-local-macos-fast: ## LOCAL: Build macOS only, skip notarization
	./scripts/release-local.sh --macos --skip-notarize

release-local-linux: ## LOCAL: Build Linux via Docker (x86_64 + aarch64), upload
	./scripts/release-local.sh --linux

# ═══════════════════════════════════════════════════════════════════════════
# MONITORING
# ═══════════════════════════════════════════════════════════════════════════

release-watch: ## MON: Watch the latest CI run in real-time
	@RUN_ID=$$(gh run list --repo $(PRIVATE_REPO) --limit 1 --json databaseId -q '.[0].databaseId'); \
	echo "  Watching run $$RUN_ID..."; \
	gh run watch $$RUN_ID --repo $(PRIVATE_REPO)

release-status: ## MON: Show status of latest CI runs
	@gh run list --repo $(PRIVATE_REPO) --limit 5 --json databaseId,displayTitle,status,conclusion,createdAt \
		-q '.[] | "\(.status)\t\(.conclusion // "-")\t\(.displayTitle)\t\(.createdAt)"' | \
		column -t -s $$'\t'

release-check: ## MON: List all assets in the release
	@echo ""
	@echo "  Release: $(TAG) on $(PUBLIC_REPO)"
	@echo "  ─────────────────────────────────────────────────"
	@gh release view $(TAG) --repo $(PUBLIC_REPO) --json assets -q '.assets[].name' 2>/dev/null | sort || echo "  (no release found)"
	@echo ""

release-check-platforms: ## MON: Show per-platform coverage
	@echo ""
	@echo "  Release: $(TAG) — Platform coverage"
	@echo "  ─────────────────────────────────────────────────"
	@assets=$$(gh release view $(TAG) --repo $(PUBLIC_REPO) --json assets -q '.assets[].name' 2>/dev/null); \
	echo "  macOS aarch64:   $$(echo "$$assets" | grep -c '_aarch64\.dmg$$' || true)"; \
	echo "  macOS x86_64:    $$(echo "$$assets" | grep -c '_x86_64\.dmg$$' || true)"; \
	echo "  Linux x86_64:    $$(echo "$$assets" | grep -c '_amd64\.' || true)"; \
	echo "  Linux aarch64:   $$(echo "$$assets" | grep -c '_arm64\.\|_aarch64\.AppImage\|_aarch64\.deb' || true)"; \
	echo "  Windows x86_64:  $$(echo "$$assets" | grep -c '_x64-setup\.exe$$' || true)"; \
	echo "  Windows arm64:   $$(echo "$$assets" | grep -c '_arm64-setup\.exe$$' || true)"; \
	echo ""

clean: ## DEV: Remove local release artifacts
	rm -rf release-artifacts/
	@echo "  Cleaned release-artifacts/"
