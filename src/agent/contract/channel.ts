// ─── Rust -> frontend session-event channel ───────────────────────────
//
// Contract C0 (docs/adr/004-2.0-contracts.md). Rust emits every
// SessionEvent on ONE Tauri event, `hermes:session-event`, with the payload
// { sessionId, event } (see src-tauri/src/contract/mod.rs). One listener,
// started once at boot, parses each payload and folds it into the store.
// A malformed payload is logged and dropped, never thrown.

import { parseSessionEvent } from "./events";
import { dispatchSessionEvent } from "./sessionEventStore";

export const SESSION_EVENT_CHANNEL = "hermes:session-event";

export interface SessionEventEnvelope {
  readonly sessionId: string;
  readonly event: unknown;
}

type Unlisten = () => void;
export type ListenFn = <T>(event: string, handler: (msg: { payload: T }) => void) => Promise<Unlisten>;

/**
 * Handle one payload off the channel. Returns true when it was accepted.
 * Separate from the listener so it can be exercised without Tauri.
 */
export function receiveSessionEventEnvelope(payload: unknown): boolean {
  if (!payload || typeof payload !== "object") return false;
  const { sessionId, event } = payload as Partial<SessionEventEnvelope>;
  if (typeof sessionId !== "string" || sessionId === "") return false;
  const parsed = parseSessionEvent(event);
  if (!parsed) {
    console.warn("[session-event] dropped a malformed event for", sessionId, event);
    return false;
  }
  dispatchSessionEvent(sessionId, parsed);
  return true;
}

let started: Promise<Unlisten> | null = null;

/** Attach the channel once; later calls return the same subscription. */
export function startSessionEventChannel(listen: ListenFn): Promise<Unlisten> {
  if (!started) {
    started = listen<unknown>(SESSION_EVENT_CHANNEL, (msg) => {
      receiveSessionEventEnvelope(msg.payload);
    });
  }
  return started;
}

export function _resetSessionEventChannelForTest(): void {
  started = null;
}
