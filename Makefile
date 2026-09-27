# ────────────────────────────────────────────────────────────────────────────
# Hermes IDE — Release & Development Makefile
#
# Release Strategy:
#   The primary release path is the GitHub Actions CI workflow (release.yml).
#   CI handles all platforms: macOS (signed + notarized), Linux, and Windows.
#
#   Local scripts (release-local.sh, release-full.sh) are DEPRECATED. They
#   predate the release train (draft -> smoke -> beta -> stable) and upload
#   straight to a public release; only their manifest step follows the
#   current rules. Use them for local build debugging, not for shipping.
#
# Quick start:
#   make bump v=1.4.1        # bump version (write RELEASE_NOTES.md first)
#   make release-push        # push the bump branch; merging its PR to main releases
#   make release-dry-run n=3 # run the release train on a throwaway tag
#   make release-promote t=v1.4.1  # promote a beta build to stable now
#
# Usage:  make help
# ────────────────────────────────────────────────────────────────────────────

SHELL := /bin/bash
VERSION := $(shell node -p "require('./src-tauri/tauri.conf.json').version")
TAG := v$(VERSION)
PRIVATE_REPO := hermes-hq/hermes-ide
PUBLIC_REPO := hermes-hq/hermes-ide

.PHONY: help dev build test bump release-push \
        release-dry-run release-promote \
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
	@echo "  Local Builds (deprecated — not the release path)"
	@echo "  ─────────────────────────────────────────────────"
	@grep -E '^[a-z].*:.*## LOCAL:' $(MAKEFILE_LIST) | sed 's/:.* ## LOCAL: /\t/' | awk '{printf "  make %-28s %s\n", $$1, substr($$0, index($$0,"\t")+1)}'
	@echo ""
	@echo "  Recommended Workflow"
	@echo "  ─────────────────────────────────────────────────"
	@echo "    make bump v=1.4.1           # write RELEASE_NOTES.md first"
	@echo "    make release-push           # push the bump branch and open its PR"
	@echo "    (merge the PR)              # the merge to main starts the release train"
	@echo "    make release-watch          # monitor the train"
	@echo "    make release-promote t=v1.4.1   # optional: promote beta to stable now"
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

bump: ## BUMP: Bump version — make bump v=1.4.1 (RELEASE_NOTES.md must name it)
ifndef v
	$(error Usage: make bump v=1.4.1)
endif
	npm run bump -- $(v)
	@echo ""
	@echo "  Version bumped to $(v). Now run:"
	@echo "    git switch -c release/$(v) && git commit -am 'Release $(v)' && make release-push"
	@echo ""

release-push: ## BUMP: Push the current branch; open a PR to main (the merge releases)
	git push -u origin HEAD
	@echo ""
	@echo "  Pushed $$(git branch --show-current). Open a PR to main — when it merges,"
	@echo "  the release workflow builds, tests, tags $(TAG) and publishes to the beta channel."
	@echo ""

# ═══════════════════════════════════════════════════════════════════════════
# RELEASE — CI-driven (primary path)
# ═══════════════════════════════════════════════════════════════════════════

release-dry-run: ## REL: Run the release train on a throwaway tag — make release-dry-run n=3 [p=macos,linux,windows]
ifndef n
	$(error Usage: make release-dry-run n=<number> [p=macos,linux,windows])
endif
	gh workflow run release.yml --repo $(PUBLIC_REPO) --ref $$(git branch --show-current) \
		-f dry_run_tag="v0.0.0-dryrun-$(n)" -f platforms="$(or $(p),all)"
	@echo "  Dry run v0.0.0-dryrun-$(n) started — make release-watch"

release-promote: ## REL: Promote a beta (prerelease) build to stable now — make release-promote t=v1.4.1
ifndef t
	$(error Usage: make release-promote t=v1.4.1)
endif
	gh workflow run promote.yml --repo $(PUBLIC_REPO) -f tag="$(t)"

release-manifests: ## REL: Build + lint latest.json and downloads.json from a release folder — make release-manifests d=<dir>
ifndef d
	$(error Usage: make release-manifests d=<folder with the release files>)
endif
	node scripts/ci/release-manifests.mjs build "$(d)" --tag $(TAG) --repo $(PUBLIC_REPO)
	node scripts/ci/release-manifests.mjs lint "$(d)" --tag $(TAG)

# ═══════════════════════════════════════════════════════════════════════════
# RELEASE — Local builds (DEPRECATED: for build debugging only, the release
# train in release.yml is the only supported way to ship)
# ═══════════════════════════════════════════════════════════════════════════

release-local-full: ## LOCAL: (deprecated) All 6 platforms — Mac+Linux local, Windows CI (interactive)
	./scripts/release-full.sh

release-local-full-no-windows: ## LOCAL: (deprecated) macOS + Linux only (4 platforms, no CI)
	./scripts/release-full.sh --skip-windows

release-local: ## LOCAL: (deprecated) Build macOS + Linux locally, sign, notarize, upload
	./scripts/release-local.sh --all

release-local-macos: ## LOCAL: (deprecated) Build macOS only (signed + notarized), upload
	./scripts/release-local.sh --macos

release-local-macos-fast: ## LOCAL: (deprecated) Build macOS only, skip notarization
	./scripts/release-local.sh --macos --skip-notarize

release-local-linux: ## LOCAL: (deprecated) Build Linux via Docker (x86_64 + aarch64), upload
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
