# ADR 001 — Agent mode for Claude (v1.0.0)

**Status:** Accepted
**Date:** 2026-05-07
**Deciders:** Project lead, contributors

## Context

Through 0.x, Hermes IDE has been a polished terminal emulator that bolts AI features onto whatever TUI the user runs (Claude Code, Aider, Codex, Gemini, Copilot, Kiro). We detect the running agent by parsing terminal output, scrape `claude --help` to discover capabilities, and — most awkwardly — write to the TUI's stdin via bracketed paste to simulate a chat experience for Claude users.

This approach has hit its ceiling. The composer chat surface we built (`feat/composer-mentions`, PR #246) goes as far as TUI scraping reasonably can: `@`-mentions, `/`-autocomplete, image attachments via `Ctrl+V` injection, dynamic capability discovery. But the underlying mechanism — typing into a UI that wasn't designed for us — is fundamentally a hack that breaks subtly whenever Claude's TUI evolves, and it cannot deliver the experience users actually want (rich tool-call rendering, diff cards, thinking visualization, true image input).

Anthropic ships a clean alternative: `claude --print --output-format stream-json --input-format stream-json` is a stable, bidirectional NDJSON wire protocol with typed events (`system/init`, `assistant`, `user`, `result`, hook events). Tools execute autonomously inside the Claude subprocess; the host application observes `tool_use` and `tool_result` events and renders them however it wants. Conductor (the reference app users have been pointing us at) is built on this exact contract and has shipped against it for months across many CLI versions.

## Decision

For v1.0.0, Hermes IDE adds a new **Agent mode** for Claude sessions, alongside the existing **Terminal mode**.

- **Agent mode (Claude only)** — spawns `claude --print --output-format stream-json --input-format stream-json` as a child process per session. The pane renders a rich message stream (text, thinking, tool-use, tool-result, result-summary) as React components. The composer is the only input surface and writes JSON `user` events to the subprocess's stdin.
- **Terminal mode (any provider, any shell)** — unchanged from 0.6.16. xterm hosts a TUI subprocess. No composer, no chat puppetry.

Each `SessionData` carries `mode: "terminal" | "agent"`. The mode determines the entire render path.

### Forks (decided)

| Question | Decision | Rationale |
|---|---|---|
| Architecture | **Side-by-side**, feature-flagged per session | Zero regression risk for existing flows |
| Default for new Claude sessions | **Agent mode** | v1.0.0 is the agent-mode pivot; users should land on the new experience |
| Default for restored 0.6.16 sessions | **Terminal mode** | Saved workspaces have no `mode` field; we treat absent as terminal |
| Default for non-Claude providers | **Terminal mode (locked)** | Aider/Codex/Gemini/Copilot/Kiro have no equivalent JSON wire protocol. Address in 1.x |
| Claude binary | **System PATH (require user-installed)** | No bundle in 1.0.0. Detect at startup, prompt to install if missing. Bundling is a 1.x optimization |
| Auth | **Inherit from CLI** (whatever `claude` is configured with) | Pro/Max OAuth users would be locked out by the npm Agent SDK; subprocess preserves their auth |
| Tool execution | **Autonomous, observed** | Claude executes tools in its own process; we don't broker Bash/Read/Edit. `--permission-mode dontAsk` + hook events are the optional brake |
| Mode conversion | **Explicit only**, with confirmation dialog | Auto-conversion would lose data (TUI scrollback or JSON history). Explicit user action only |

### Out of scope for 1.0.0

- Bundled `claude` binary (1.x optimization)
- Agent mode for non-Claude providers (each provider needs its own protocol; 1.x)
- MCP server installer UI
- Tool permission gating UX (basic permission modes work; richer UX is 1.x)
- Multi-session agent ergonomics (parallel runs, task queue, etc.)

## Consequences

### Positive

- **Stable contract** — stream-json is documented, typed, and version-tolerant via serde aliases. Anthropic ships their own SDK against it
- **Real images, real diffs, real tool calls** — rendered as first-class UI, not parsed out of bytes
- **No more `claude --help` scraping** — capabilities come from the `init` event, always fresh
- **Authoritative slash commands** — the `init` event's `slash_commands[]` field is the source of truth, replacing the bundled JSON fallback
- **Auth-flexible** — Pro/Max, API key, Bedrock, Vertex, Foundry — anything the CLI supports works without code changes
- **Cleaner mental model** — Terminal mode is for running programs; Agent mode is for talking to Claude. No more pretending the terminal is a chat

### Negative

- **Two render paths to maintain** — but the alternative (kill terminal mode entirely) is too disruptive for v1.0.0
- **First-turn cold start** (~5 s) on `claude --print` — mitigated by spawning the subprocess on session creation, not on first message, and showing a small "warming up Claude…" indicator until the `init` event arrives
- **Format drift risk** — Anthropic could change the stream-json shape. Mitigated by serde aliases, "unknown event type" graceful fallback (log + continue), and the fact that Anthropic's own SDK consumes this format and stays compatible across CLI versions
- **Mode-toggle data loss** — converting a session between modes throws away the previous mode's history. Mitigated by an explicit confirmation dialog; never automatic

## Implementation

See `wondrous-wishing-quilt` plan file for the phase-by-phase build (Phase 0 design principles → Phase 7 ship). Branch: `feat/v1-agent-mode` off `main`.

Critical components added in 1.0.0:

- `src-tauri/src/agent/mod.rs` — subprocess lifecycle, NDJSON streaming, IPC surface
- `src/agent/types.ts` — typed event union + content-block types
- `src/agent/messageStore.ts` — event-stream → message-list folder
- `src/agent/AgentSessionView.tsx` — pane root for agent sessions
- `src/agent/blocks/*.tsx` — one component per content-block type

Reused from `feat/composer-mentions` (PR #246) but rewired:

- `SessionComposer.tsx` and its dropdowns/pickers — UI surface unchanged, submit path swaps from `submitToPty` (TUI hack) to `submitToAgent` (JSON RPC)
- `useClaudeCommands` / `useClaudeCapabilities` — superseded by the `init` event for Agent mode; may stay alive for Terminal mode if useful

## Revisit

- **3 months after 1.0.0 ships** — review whether Terminal mode for Claude gets meaningful use, or whether we can deprecate it for Claude specifically
- **When Aider/Codex ship structured output** — extend Agent mode to those providers
- **If Anthropic releases a stable embeddable SDK that supports OAuth** — reconsider whether to switch from CLI subprocess to in-process SDK
