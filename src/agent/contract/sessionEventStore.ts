// ─── Per-session event store ──────────────────────────────────────────
//
// Contract C0 (docs/adr/004-2.0-contracts.md). Holds the SessionEvents of
// every session, folded into one frozen snapshot per session that React
// reads with `useSyncExternalStore` (subscribe / getSnapshot below).
//
// The store is deliberately dumb: it records what events say and derives
// nothing (F10 owns deriveStatus; F12 owns what becomes an inbox item).
// The one exception is `exit`, a fact from the process itself, which sets
// the status to `exited` exactly.
//
// Snapshots are immutable and only replaced when an event lands, so a
// component re-renders exactly when its session changed.

import { useSyncExternalStore } from "react";
import type { SessionEvent } from "./events";
import { UNKNOWN_STATUS, type AgentStatus } from "./status";

/** How many events a session keeps in memory (oldest dropped first). */
export const SESSION_EVENT_CAP = 200;

export interface SessionIdentity {
  readonly vendorSessionId: string | null;
  readonly model: string | null;
  readonly permissionMode: string | null;
}

export interface SessionTurnState {
  /** The turn in progress, or null between turns. */
  readonly current: number | null;
  /** Turns that ended (normally, failed or interrupted). */
  readonly completed: number;
}

export interface SessionEventSnapshot {
  readonly sessionId: string;
  readonly status: AgentStatus;
  readonly identity: SessionIdentity;
  readonly turn: SessionTurnState;
  /** The last attention detail, or null when none was raised. */
  readonly attention: string | null;
  readonly exit: { readonly code: number | null; readonly signal: string | null } | null;
  /** Sub-agents the agent reports as running (F11); 0 when none or unknown. */
  readonly subagents: number;
  /** The most recent events, oldest first, at most SESSION_EVENT_CAP. */
  readonly events: readonly SessionEvent[];
  /** Bumps on every accepted event; 0 for a session nothing reported on. */
  readonly version: number;
}

const NO_IDENTITY: SessionIdentity = Object.freeze({ vendorSessionId: null, model: null, permissionMode: null });
const NO_TURN: SessionTurnState = Object.freeze({ current: null, completed: 0 });

function emptySnapshot(sessionId: string): SessionEventSnapshot {
  return Object.freeze({
    sessionId,
    status: UNKNOWN_STATUS,
    identity: NO_IDENTITY,
    turn: NO_TURN,
    attention: null,
    exit: null,
    subagents: 0,
    events: Object.freeze([]) as readonly SessionEvent[],
    version: 0,
  });
}

/** Pure: the snapshot after `event`. Exported for table tests. */
export function reduceSessionEvent(prev: SessionEventSnapshot, event: SessionEvent): SessionEventSnapshot {
  const events = prev.events.length >= SESSION_EVENT_CAP ? [...prev.events.slice(1), event] : [...prev.events, event];
  const next = { ...prev, events: Object.freeze(events), version: prev.version + 1 };
  switch (event.type) {
    case "status":
      next.status = event.status;
      break;
    case "turn_start":
      next.turn = { current: event.n, completed: prev.turn.completed };
      break;
    case "turn_end":
    case "turn_failed":
    case "turn_interrupted":
      next.turn = {
        current: prev.turn.current === event.n ? null : prev.turn.current,
        completed: prev.turn.completed + 1,
      };
      break;
    case "attention":
      next.attention = event.detail;
      break;
    case "identity":
      next.identity = { vendorSessionId: event.vendorSessionId, model: event.model, permissionMode: event.permissionMode };
      break;
    case "subagents":
      next.subagents = event.running;
      break;
    case "exit":
      next.exit = { code: event.code, signal: event.signal };
      next.subagents = 0;
      // The detail stays empty on purpose: the store holds no user-facing
      // text. A renderer (F10) builds the line from `snapshot.exit` with the
      // localised agentError.exitCode / agentError.exitSignal strings.
      next.status = { kind: "exited", confidence: "exact", detail: "" };
      next.turn = { current: null, completed: prev.turn.completed + (prev.turn.current === null ? 0 : 1) };
      break;
  }
  return Object.freeze(next);
}

type Listener = () => void;
/** Told which session changed; for stores that span every session. */
export type AnySessionListener = (sessionId: string) => void;

const snapshots = new Map<string, SessionEventSnapshot>();
const listeners = new Map<string, Set<Listener>>();
const anyListeners = new Set<AnySessionEventListener>();
const emptyCache = new Map<string, SessionEventSnapshot>();

/**
 * Told about every session (F10 and F12 recount, F36 fans out to plugins).
 * On an accepted event: the event, the snapshot after and the one before.
 * When a session is cleared: `event` is null and `snapshot` is the empty
 * snapshot; listeners that only follow events skip that call.
 */
export type AnySessionEventListener = (
  sessionId: string,
  event: SessionEvent | null,
  snapshot: SessionEventSnapshot,
  previous: SessionEventSnapshot,
) => void;

function notifyAny(
  sessionId: string,
  event: SessionEvent | null,
  snapshot: SessionEventSnapshot,
  previous: SessionEventSnapshot,
): void {
  for (const l of [...anyListeners]) {
    try {
      l(sessionId, event, snapshot, previous);
    } catch (err) {
      console.warn("[session-event] a listener for every session threw", err);
    }
  }
}

/** The current snapshot of a session; stable until an event lands. */
export function getSessionEventSnapshot(sessionId: string): SessionEventSnapshot {
  const known = snapshots.get(sessionId);
  if (known) return known;
  let empty = emptyCache.get(sessionId);
  if (!empty) {
    empty = emptySnapshot(sessionId);
    emptyCache.set(sessionId, empty);
  }
  return empty;
}

export function subscribeSessionEvents(sessionId: string, listener: Listener): () => void {
  let set = listeners.get(sessionId);
  if (!set) {
    set = new Set();
    listeners.set(sessionId, set);
  }
  set.add(listener);
  return () => {
    set.delete(listener);
    if (set.size === 0) listeners.delete(sessionId);
  };
}

/**
 * Subscribe to every session at once (added by F10 for the attention store,
 * which summarises all sessions; F12's inbox uses it to follow sessions it
 * has not seen yet; F36's plugin API fans the events out to plugins). The
 * listener runs after that session's own subscribers were woken, on every
 * accepted event and on clear (see AnySessionEventListener). A listener
 * that throws is logged and never stops the others or the store.
 */
export function subscribeAllSessionEvents(listener: AnySessionEventListener): () => void {
  anyListeners.add(listener);
  return () => {
    anyListeners.delete(listener);
  };
}

/** Fold one event into its session and wake that session's subscribers. */
export function dispatchSessionEvent(sessionId: string, event: SessionEvent): SessionEventSnapshot {
  const prev = getSessionEventSnapshot(sessionId);
  const next = reduceSessionEvent(prev, event);
  snapshots.set(sessionId, next);
  emptyCache.delete(sessionId);
  const set = listeners.get(sessionId);
  if (set) for (const l of [...set]) l();
  notifyAny(sessionId, event, next, prev);
  return next;
}

/** Sessions that have at least one event. */
export function sessionIdsWithEvents(): string[] {
  return [...snapshots.keys()];
}

/** Forget a closed session (its subscribers are left to unsubscribe). */
export function clearSessionEvents(sessionId: string): void {
  const previous = getSessionEventSnapshot(sessionId);
  snapshots.delete(sessionId);
  emptyCache.delete(sessionId);
  const set = listeners.get(sessionId);
  if (set) for (const l of [...set]) l();
  notifyAny(sessionId, null, getSessionEventSnapshot(sessionId), previous);
}

/** The snapshot of one session, re-rendering only when that session changes. */
export function useSessionEvents(sessionId: string): SessionEventSnapshot {
  return useSyncExternalStore(
    (listener) => subscribeSessionEvents(sessionId, listener),
    () => getSessionEventSnapshot(sessionId),
    () => getSessionEventSnapshot(sessionId),
  );
}

export function _resetSessionEventStoreForTest(): void {
  snapshots.clear();
  listeners.clear();
  emptyCache.clear();
  anyListeners.clear();
}
