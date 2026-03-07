# Hermes IDE — Main App

## Overview
AI-native terminal emulator / IDE built on Tauri 2 + React + Vite. Supports macOS, Windows, and Linux.

## Changelog & Release Notes Rules

**This project is NOT open source.** All public-facing text (changelog on the site, GitHub release notes) must follow these rules:

1. **User-facing language only** — Describe what changed from the user's perspective, not how it was implemented.
2. **Never expose internal details** — No component names (e.g., ProviderActionsBar, SessionContext), library names (e.g., xterm.js, WKWebView, Aptabase), architectural patterns (e.g., "prop drilling", "dedup guard", "reducer"), file paths, or code-level specifics.
3. **No implementation counts** — Don't say "17 bugs fixed across terminal, git panel, process panel" — instead say "17 bugs fixed across the app" or just list the user-visible fixes.
4. **Focus on outcomes** — "Fast typing no longer causes missing characters" is good. "Added dedup guard to PTY write path" is bad.
5. **Keep it concise** — Each item should be one clear sentence describing the change a user would notice.

**Examples:**
- Bad: "Reworked CompositionHelper to use beforeinput events for dead key handling"
- Good: "Dead key composition (ã, õ, é, etc.) now works reliably in all terminal sessions"
- Bad: "Added OPEN_COMPOSER / CLOSE_COMPOSER actions to SessionContext reducer"
- Good: "Prompt Composer is now accessible directly from the command toolbar"

These rules apply to:
- The changelog on the website (`hermes-ide-site/src/data/changelog.ts`)
- GitHub release notes on `Vinci-26/hermes-ide-releases`
- Any other public-facing release communication

## Key Paths
- Tauri config: `src-tauri/tauri.conf.json`
- Version synced across: `package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`
- Bump version: `npm run bump -- X.Y.Z`

## Commands
- `npm run dev` — Vite dev server
- `npm run tauri dev` — Full Tauri app dev mode
- `npm run test` — Run tests
- `npx tsc --noEmit` — Type check
