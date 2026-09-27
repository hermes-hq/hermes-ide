# ADR 003 — Terminal first, vendor-neutral

**Status:** Accepted
**Date:** 2026-09-27
**Deciders:** Project lead
**Supersedes:** [ADR 001](001-agent-mode.md) forks "Default for new Claude sessions: Agent mode" and "Default for non-Claude providers: Terminal mode (locked)", and Principle 0 of [DESIGN_PRINCIPLES.md](../DESIGN_PRINCIPLES.md) ("Agent-native for Claude, terminal-faithful for everything else")

## Context

ADR 001 made Claude the one agent with a Hermes-rendered chat surface and made that surface the default for Claude. Since then:

- People run several agents side by side — Claude Code, Codex, Gemini, Aider, Copilot, Kiro — and each vendor keeps shipping its own terminal interface with its own features (rewind, model and permission switching, subagents, plan mode). A Hermes-rendered view lags behind those interfaces and has to be rebuilt for every vendor.
- The agents now report what Hermes needs to supervise them on purpose: Claude hooks, Codex `notify`, Gemini hooks, terminal notifications, exit codes. Hermes can supervise an agent without re-implementing its interface.
- Two defaults (Agent mode for Claude, Terminal for everyone else) made Hermes behave differently per vendor, and the design principles promised a Claude-first product the rest of the app does not deliver.

## Decision

**Terminal first, for every agent.** A new session runs the agent's own terminal interface, Claude included. A structured view is optional.

### Principle 0, rewritten

> **Terminal-faithful first; structured views are optional.** Every agent runs in its own terminal interface by default, byte for byte. Hermes observes only what the agent reports on purpose (its hooks, notifications, exit codes) and what git shows. Supervision (status, history, review, landing) works the same for every agent. Hermes never types into a terminal on its own; the only allowed write is one visible line you trigger yourself.

### What ships with this decision

- `resolveSessionMode` returns `"agent"` only when the caller explicitly asks for it and the agent has an Agent view (Claude today). Everything else is `"terminal"`.
- The New Session wizard drops its separate mode step. It opens on the agent step; choosing Claude offers an opt-in **"Agent view for Claude"** checkbox, and a link on the same step switches to SSH.
- The wizard remembers the Terminal / Agent view choice per agent (`session_mode_by_provider`) and preselects it next time. It never changes an existing session.
- Saved sessions restore as they were saved: an Agent-view session restores in the Agent view, a missing mode restores as terminal. No migration.
- README, CLAUDE.md, ADR 001 and DESIGN_PRINCIPLES.md describe terminal first.

### What Hermes may observe

1. Signals the agent emits on purpose: hook payloads, terminal notifications (OSC 9 / 99 / 777, BEL), the vendor's own status commands, and the process exit code.
2. The working tree and git history of the session's folder.
3. The terminal byte stream, only for rendering and for heuristics that are labelled as guesses.

Hermes does not scrape an agent's interface to fake structure it does not report, and a status always says where it came from (exact, signal or guessed).

### Observe, never answer

Hermes never answers a permission prompt or a question on the user's behalf. Hooks that Hermes installs only observe; they never return a decision. Approval happens in the agent's own interface, or in a structured view the user chose.

### Every new surface retires one

A change that adds a panel, mode or view names the one it removes or merges. This ADR follows the rule: the mode step leaves the wizard, and "Chat with Claude" stops being the headline.

### When a structured view is worth building

A structured view for an agent is built only when all of these hold:

1. The vendor ships a documented, stable machine protocol for it (for example the Claude Agent SDK stream, ACP, the Codex app server).
2. It gives the user something the vendor's terminal interface cannot (for example rendered diffs next to the conversation, real image input).
3. Opt-in usage of existing structured views shows demand.
4. It runs behind the same per-session opt-in, and the terminal stays the default.

## Consequences

### Positive

- One default for every agent; nothing to relearn when switching vendors.
- Vendor features (new commands, new modes) work in Hermes the day they ship, because Hermes runs the vendor's own interface.
- The Agent view stays available for people who want it, and their saved sessions keep working.

### Negative

- Claude users who liked the chat surface as the default must tick one box once; after that the wizard remembers.
- Features that depended on the structured stream (tool-call cards, per-turn diffs in the conversation) are only in the Agent view until terminal-mode supervision catches up.

### Known gaps (tracked, not solved by this ADR)

- A restored terminal session starts a new agent conversation instead of resuming the previous one.
- Hermes still sends a context nudge into a detected agent's terminal when project context changes. Under Principle 0 that write must become something the user triggers.
- Status for terminal agents is still mostly heuristic until hook-based signals land.

## Revisit

- When hook-based status and resume work for terminal agents on all three platforms.
- If opt-in Agent-view usage grows enough to justify a structured view for a second vendor.
