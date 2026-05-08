# Hermes IDE

## Overview
AI-native terminal emulator / IDE built on Tauri 2 + React + Vite. Supports macOS, Windows, and Linux.

## Architecture (1.0.0)

Each session has a `mode` of either `"agent"` or `"terminal"`:

- **Agent mode** (Claude only) — `claude --print --output-format stream-json --input-format stream-json` runs as a per-session subprocess. The pane renders messages, thinking, tool calls, and diffs as React components driven by an event-stream reducer. The composer writes JSON `user` events directly to the subprocess's stdin. See `src-tauri/src/agent/`, `src/agent/`, `src/components/SessionComposer.tsx`, ADR `docs/adr/001-agent-mode.md`.
- **Terminal mode** (any provider, any shell) — classic PTY + xterm. No composer. See `src-tauri/src/pty/`, `src/components/TerminalPane.tsx`.

`SplitPane.tsx` routes between the two based on `session.mode`. New Claude sessions default to Agent mode; everything else defaults to Terminal mode. Restored 0.6.16 sessions default to Terminal mode (no surprise behavior).

For the full rationale and forks, read [ADR 001 — Agent mode for Claude](docs/adr/001-agent-mode.md).

## License
Source-available under the Business Source License 1.1 (BSL). Converts to Apache 2.0 three years after each release. See [LICENSE](LICENSE) for details.

## Key Paths
- Tauri config: `src-tauri/tauri.conf.json`
- Version synced across: `package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`
- Bump version: `npm run bump -- X.Y.Z`

## Commands
- `npm run dev` — Vite dev server
- `npm run tauri dev` — Full Tauri app dev mode
- `npm run test` — Run tests
- `npx tsc --noEmit` — Type check

## Code Style
- **TypeScript**: Strict mode. Follow existing patterns in `src/`.
- **Rust**: Standard `cargo fmt` and `cargo clippy` conventions.
- **CSS**: Per-component CSS files in `src/styles/`. No CSS-in-JS.
- **Components**: Functional React components with hooks. State lives in `SessionContext`.

## Contribution Rules
- Read [CONTRIBUTING.md](CONTRIBUTING.md) and [DESIGN_PRINCIPLES.md](DESIGN_PRINCIPLES.md) before making changes.
- Open an issue or discussion before working on any new feature.
- Bug fixes and docs do not require prior discussion.
- All contributors must sign the [CLA](CLA.md).

## Changelog & Release Notes
All public-facing release text must follow these rules:
1. **User-facing language only** — Describe what changed from the user's perspective.
2. **Never expose internal details** — No component names, library names, architecture patterns, file paths, or code-level specifics.
3. **Focus on outcomes** — "Fast typing no longer causes missing characters" is good. "Added dedup guard to PTY write path" is bad.
4. **Keep it concise** — Each item should be one clear sentence describing a change a user would notice.
