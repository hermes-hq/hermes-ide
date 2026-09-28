// ─── Session events -> turn ledger (F20) ──────────────────────────────
//
// Turn boundaries reach the frontend as SessionEvents (an agent's own hook
// forwarded by Rust, a plugin, the e2e injector). This bridge forwards the
// ones that matter to the backend ledger, which snapshots the worktree:
//
//   turn_start                              -> reportTurnStarted
//   turn_end / turn_failed / turn_interrupted -> reportTurnEnded
//
// An event is `exact` unless its source is the PTY heuristic ("pty"); the
// backend keeps its own guess (Busy -> Idle) only for sessions that never
// report an exact boundary. Started once from main.tsx when the flag is on.

import { subscribeAllSessionEvents } from "../contract/sessionEventStore";
import type { SessionEvent } from "../contract/events";
import { reportTurnEnded, reportTurnStarted, setTurnLedgerEnabled } from "./turnLedgerApi";

export interface TurnLedgerBridgeDeps {
  setEnabled: (enabled: boolean) => Promise<void>;
  turnStarted: (sessionId: string, at: number, exact: boolean) => Promise<void>;
  turnEnded: (sessionId: string, at: number, exact: boolean) => Promise<void>;
}

const REAL: TurnLedgerBridgeDeps = {
  setEnabled: setTurnLedgerEnabled,
  turnStarted: reportTurnStarted,
  turnEnded: reportTurnEnded,
};

/** Whether an event's source is the agent (or a test) rather than a PTY guess. */
export function isExactTurnSource(event: SessionEvent): boolean {
  return event.source !== "pty";
}

let stop: (() => void) | null = null;

/**
 * Start forwarding. With `enabled` false the backend is told to stay off and
 * nothing is forwarded (the stable default). Returns a function that stops
 * forwarding; calling start twice replaces the first subscription.
 */
export function startTurnLedgerBridge(enabled: boolean, deps: TurnLedgerBridgeDeps = REAL): () => void {
  stop?.();
  stop = null;
  deps.setEnabled(enabled).catch((e) => console.warn("[turn-ledger] could not tell the backend the flag state:", e));
  if (!enabled) return () => {};
  const unsubscribe = subscribeAllSessionEvents((sessionId, event) => {
    if (!event) return; // a cleared session ends no turn
    const exact = isExactTurnSource(event);
    switch (event.type) {
      case "turn_start":
        deps.turnStarted(sessionId, event.at, exact).catch((e) => console.warn("[turn-ledger] turn start not reported:", e));
        break;
      case "turn_end":
      case "turn_failed":
      case "turn_interrupted":
        deps.turnEnded(sessionId, event.at, exact).catch((e) => console.warn("[turn-ledger] turn end not reported:", e));
        break;
      default:
        break;
    }
  });
  stop = unsubscribe;
  return () => {
    unsubscribe();
    if (stop === unsubscribe) stop = null;
  };
}
