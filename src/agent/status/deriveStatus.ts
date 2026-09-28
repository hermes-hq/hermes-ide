// ─── deriveStatus: SessionEvents -> the one status a session shows ────
//
// F10 (docs/adr/004-2.0-contracts.md §1). Every provider (the terminal, the
// optional Agent view, agent hooks, OSC notifications, plugins) reports into
// the same per-session event store. This folds a session's events into the
// single AgentStatus the sidebar, the status strip and the inbox show.
//
// Pure and vendor-neutral: it reads events and their `source` only.
//
// Precedence, in words:
//   1. A process exit is a fact: it always wins.
//   2. A report at least as certain as the current one replaces it.
//   3. A source may always correct itself (the launch helper replacing its
//      own "starting" with a guessed "waiting at a startup prompt").
//   4. A less certain report cannot replace a more certain one, except
//      over `idle`: a quiet state yields to any evidence of activity.
//   5. An agent reported as ended inside a terminal that is still open
//      (the launch helper's "ended", not the process exiting) stays
//      "exited" while the shell sits idle, and yields to any other
//      evidence that something runs there again.
// Certainty tiers, highest first: exact, signal, guessed, and below every
// named guess the terminal's generic heuristics (source "pty"), so a
// helper's specific guess is never overwritten by shell-output shapes.
//
// Known limit (F11 reconciles it): an exact `working` holds until the agent
// reports again, so an agent that stops without saying so keeps showing
// working until its next hook event.

import type { SessionEvent } from "../contract/events";
import type { SessionEventSnapshot } from "../contract/sessionEventStore";
import { UNKNOWN_STATUS, type AgentStatus, type AgentStatusKind, type Confidence } from "../contract/status";

/** A status plus where and when it came from. */
export interface DerivedStatus extends AgentStatus {
  /** When the deciding event happened (epoch ms); null when nothing reported. */
  readonly at: number | null;
  /** The deciding event's source; null when unknown. */
  readonly source: string | null;
  /**
   * Set on `exited` when the session's process itself ended (an `exit`
   * event), as opposed to an agent reported as ended in a live terminal.
   */
  readonly processExited?: true;
}

export const PTY_SOURCE = "pty";

/**
 * How sure an event is when it does not say so itself (turn, attention and
 * exit events carry no confidence): by where it came from.
 */
export function confidenceOfSource(source: string | undefined | null): Confidence {
  if (!source) return "signal";
  if (source === PTY_SOURCE) return "guessed";
  if (source === "hi" || source === "agent-view" || source === "hook" || source.startsWith("hook:") || source.startsWith("protocol:")) {
    return "exact";
  }
  return "signal";
}

/** Higher is more certain. The terminal's heuristics rank below any named guess. */
export function certaintyRank(confidence: Confidence, source: string | null | undefined): number {
  switch (confidence) {
    case "exact":
      return 3;
    case "signal":
      return 2;
    case "guessed":
      return source === PTY_SOURCE ? 0 : 1;
  }
}

/** Kinds a less certain report may replace. */
const YIELDING: ReadonlySet<AgentStatusKind> = new Set<AgentStatusKind>(["idle"]);

/** The status an event means on its own, or null when it says nothing about status. */
export function statusOfEvent(event: SessionEvent): DerivedStatus | null {
  const source = event.source ?? null;
  const confidence = confidenceOfSource(event.source);
  const make = (kind: AgentStatusKind, detail = "", c: Confidence = confidence): DerivedStatus => ({
    kind,
    confidence: c,
    detail,
    at: event.at,
    source,
  });
  switch (event.type) {
    case "status":
      return { ...event.status, at: event.at, source };
    case "turn_start":
      return make("working");
    case "turn_end":
      return make("done_unread");
    case "turn_failed":
      return make("error", event.detail);
    case "turn_interrupted":
      return make("idle");
    case "attention":
      return make("needs_answer", event.detail);
    case "exit":
      // The detail stays empty: the renderer words the exit from the
      // snapshot's { code, signal } in the person's language.
      return { ...make("exited", "", "exact"), processExited: true };
    case "identity":
    case "subagents":
      return null;
  }
}

/** Whether `next` replaces `current` (see the precedence rules above). */
export function replaces(current: DerivedStatus, next: DerivedStatus, nextIsExit: boolean): boolean {
  if (nextIsExit) return true;
  if (current.source !== null && current.source === next.source) return true;
  const cur = certaintyRank(current.confidence, current.source);
  const nxt = certaintyRank(next.confidence, next.source);
  if (nxt >= cur) return true;
  if (current.kind === "exited" && !current.processExited) return next.kind !== "idle";
  return YIELDING.has(current.kind);
}

const NOTHING: DerivedStatus = Object.freeze({ ...UNKNOWN_STATUS, at: null, source: null });

/** Fold a list of events, oldest first, from `start`. */
export function foldStatus(events: readonly SessionEvent[], start: DerivedStatus = NOTHING): DerivedStatus {
  let current = start;
  for (const event of events) {
    const next = statusOfEvent(event);
    if (!next) continue;
    if (current === NOTHING || replaces(current, next, event.type === "exit")) current = next;
  }
  return current;
}

export interface DeriveStatusInput {
  readonly snapshot: SessionEventSnapshot;
  /**
   * When a person last looked at this session (epoch ms), or null when
   * never. `done_unread` older than this reads as `idle`. Pass Infinity
   * while the session is on screen in a focused window.
   */
  readonly seenAt: number | null;
}

/**
 * The status a session shows. Pure: the same snapshot and seen time always
 * give the same answer.
 */
export function deriveStatus({ snapshot, seenAt }: DeriveStatusInput): DerivedStatus {
  // The store keeps the last SESSION_EVENT_CAP events. When older ones were
  // dropped, start from the last status the store recorded.
  const truncated = snapshot.version > snapshot.events.length;
  const start: DerivedStatus = truncated ? { ...snapshot.status, at: null, source: null } : NOTHING;
  const folded = foldStatus(snapshot.events, start);
  if (folded.kind === "done_unread" && seenAt !== null && (folded.at === null || seenAt >= folded.at)) {
    return { ...folded, kind: "idle" };
  }
  return folded;
}
