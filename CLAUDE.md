# Hermes IDE

## Overview
AI-native terminal emulator / IDE built on Tauri 2 + React + Vite. Supports macOS, Windows, and Linux.

## Architecture — terminal first

Each session has a `mode` of either `"terminal"` or `"agent"`:

- **Terminal mode** (the default for every agent, Claude included, and any shell) — PTY + xterm running the agent's own interface. See `src-tauri/src/pty/`, `src/components/TerminalPane.tsx`.
- **Agent view** (`mode: "agent"`, optional, Claude only) — a per-session Node bridge (`src-tauri/bridge/hermes-claude-bridge.mjs`) runs the Claude Agent SDK and speaks the stream-json wire format to the app. The pane renders messages, thinking, tool calls, and diffs as React components driven by an event-stream reducer; the composer writes JSON `user` events to the bridge's stdin. See `src-tauri/src/agent/`, `src/agent/`, `src/components/SessionComposer.tsx`.

`SplitPane.tsx` routes between the two based on `session.mode`. `resolveSessionMode` (`src/state/SessionContext.tsx`) returns `"agent"` only when the caller asked for it and the agent has an Agent view; everything else is terminal. The New Session wizard offers "Agent view for Claude" on the agent step and remembers the choice per agent (`session_mode_by_provider` setting). Saved sessions restore in the mode they were saved with; a missing mode restores as terminal.

For the rationale, read [ADR 003 — Terminal first, vendor-neutral](docs/adr/003-terminal-first-vendor-neutral.md). [ADR 001](docs/adr/001-agent-mode.md) is superseded in part.

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
