// ─── TerminalProvider: the SessionEvent contract for every terminal ───
//
// F19. Implements the contract for every terminal session, whatever agent
// (or none) runs in it, from what Hermes already observes:
//
//   - the PTY phase heuristics  -> status, confidence guessed, source "pty"
//   - the launch helper's startup states (hi run, N12) -> status with the
//     helper's own confidence, source "hi"
//   - the session's process ending -> exit
//   - the conversation id Hermes assigned, the model the output named and
//     the permission mode Hermes launched with -> identity
//
// Pure: `observe(prev, next, at)` returns the events between two
// observations. Nothing here depends on which agent it is.

import type { SessionEvent } from "../contract/events";
import type { AgentStatusKind, Confidence } from "../contract/status";
import { isConfidence } from "../contract/status";
import type { SessionData } from "../../types/session";
import { hasIdentity, sameIdentity, type IdentityFields, type SessionProvider } from "./types";

export const TERMINAL_SOURCE = "pty";
export const HELPER_SOURCE = "hi";
export const HERMES_SOURCE = "hermes";

export interface TerminalStartup {
  readonly state: string;
  readonly confidence: Confidence;
  readonly detail: string;
}

export interface TerminalObservation extends IdentityFields {
  /** The PTY phase ("creating", "shell_ready", "idle", "busy", "needs_input", "destroyed", ...). */
  readonly phase: string;
  readonly startup: TerminalStartup | null;
}

/** What the PTY phase means, as a guess. Phases not listed say nothing. */
const PHASE_STATUS: Readonly<Record<string, AgentStatusKind>> = {
  creating: "starting",
  shell_ready: "idle",
  idle: "idle",
  busy: "working",
  needs_input: "needs_answer",
};

/** What each launch-helper startup state means. */
const STARTUP_STATUS: Readonly<Record<string, AgentStatusKind>> = {
  launching: "starting",
  started: "idle",
  waiting_at_startup_prompt: "startup_prompt",
  ended: "exited",
};

export function terminalObservationOf(session: SessionData): TerminalObservation {
  const s = session.agent_startup;
  const hasAgent = !!session.ai_provider || !!session.detected_agent;
  return {
    phase: session.phase,
    startup: s
      ? { state: s.state, confidence: isConfidence(s.confidence) ? s.confidence : "guessed", detail: s.detail ?? "" }
      : null,
    vendorSessionId: session.vendor_session_id ?? null,
    model: session.detected_agent?.model ?? null,
    permissionMode: hasAgent && session.permission_mode ? session.permission_mode : null,
  };
}

function sameStartup(a: TerminalStartup | null, b: TerminalStartup | null): boolean {
  if (a === null || b === null) return a === b;
  return a.state === b.state && a.confidence === b.confidence && a.detail === b.detail;
}

function phaseEvent(phase: string, at: number): SessionEvent | null {
  if (phase === "destroyed") return { type: "exit", at, source: TERMINAL_SOURCE, code: null, signal: null };
  const kind = PHASE_STATUS[phase];
  if (!kind) return null;
  return { type: "status", at, source: TERMINAL_SOURCE, status: { kind, confidence: "guessed", detail: "" } };
}

export const terminalProvider: SessionProvider<TerminalObservation> = {
  id: "terminal",
  source: TERMINAL_SOURCE,
  // `questions: false`: a terminal only guesses a question from the PTY
  // (needs_answer, guessed); it cannot tell one.
  capabilities: { status: "exact", approvals: false, questions: false, turnBoundaries: false, identity: true },
  observe(prev, next, at) {
    const events: SessionEvent[] = [];
    const startupChanged = next.startup !== null && !sameStartup(prev?.startup ?? null, next.startup);
    if (startupChanged && next.startup) {
      const kind = STARTUP_STATUS[next.startup.state];
      if (kind) {
        events.push({
          type: "status",
          at,
          source: HELPER_SOURCE,
          status: { kind, confidence: next.startup.confidence, detail: next.startup.detail },
        });
      }
    }
    // The phase goes after the helper's state: once the agent has started,
    // the terminal's current activity is what the session is doing. While
    // it starts, the helper's state holds (see deriveStatus).
    if (prev?.phase !== next.phase || (startupChanged && next.phase !== "destroyed")) {
      const e = phaseEvent(next.phase, at);
      if (e) events.push(e);
    }
    const identity: IdentityFields = {
      vendorSessionId: next.vendorSessionId,
      model: next.model,
      permissionMode: next.permissionMode,
    };
    if (hasIdentity(identity) && !sameIdentity(prev, identity)) {
      events.push({ type: "identity", at, source: HERMES_SOURCE, ...identity });
    }
    return events;
  },
};
