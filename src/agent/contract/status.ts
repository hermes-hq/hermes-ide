// ─── AgentStatus: one status vocabulary for every agent ───────────────
//
// Contract C0 (docs/adr/004-2.0-contracts.md). Every session, whatever the
// agent, reports one of these states, with how sure Hermes is about it.
// The Rust mirror is src-tauri/src/contract/mod.rs; the shared fixture
// src/agent/contract/fixtures/session-events.json pins the wire format on
// both sides.
//
// Owners: F10 fills `deriveStatus` (signals -> status); F11 produces the
// exact/signal/guessed sources. Later features may only ADD kinds or fields.

/** Every status a session can be in, in the order the inbox sorts them. */
export const AGENT_STATUS_KINDS = [
  "needs_approval",
  "needs_answer",
  "gate",
  "check_failed",
  "error",
  "limited",
  "plan_ready",
  "done_unread",
  "working",
  "startup_prompt",
  "starting",
  "idle",
  "exited",
] as const;

export type AgentStatusKind = (typeof AGENT_STATUS_KINDS)[number];

/**
 * How sure Hermes is:
 *   exact   — a nonce-verified hook or a protocol event from the agent itself
 *   signal  — a notification any program could print (OSC, BEL)
 *   guessed — a PTY heuristic (idle time, prompt shape)
 */
export const CONFIDENCES = ["exact", "signal", "guessed"] as const;
export type Confidence = (typeof CONFIDENCES)[number];

export interface AgentStatus {
  readonly kind: AgentStatusKind;
  readonly confidence: Confidence;
  /** One line for people: the command awaiting approval, the question, the
   *  reset time of a limit, the failing check. Empty when there is nothing
   *  to say. */
  readonly detail: string;
}

export function isAgentStatusKind(value: unknown): value is AgentStatusKind {
  return typeof value === "string" && (AGENT_STATUS_KINDS as readonly string[]).includes(value);
}

export function isConfidence(value: unknown): value is Confidence {
  return typeof value === "string" && (CONFIDENCES as readonly string[]).includes(value);
}

/** Validating parser for a status object off the wire. Null when malformed. */
export function parseAgentStatus(value: unknown): AgentStatus | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (!isAgentStatusKind(v.kind) || !isConfidence(v.confidence)) return null;
  const detail = v.detail === undefined ? "" : v.detail;
  if (typeof detail !== "string") return null;
  return { kind: v.kind, confidence: v.confidence, detail };
}

/** The status of a session nothing has reported about yet. */
export const UNKNOWN_STATUS: AgentStatus = Object.freeze({
  kind: "idle",
  confidence: "guessed",
  detail: "",
});

/** Statuses that mean a person has to act before the agent can go on. */
export const BLOCKING_STATUS_KINDS: readonly AgentStatusKind[] = [
  "needs_approval",
  "needs_answer",
  "gate",
  "check_failed",
  "error",
  "limited",
];
