// ─── Done-When (F27): per-session check results ───────────────────────
//
// The latest result of each session, whether a run is under way, and every
// final result by turn ("results are stored on the turn"). React reads a
// session with useDoneWhen(sessionId); snapshots are frozen and replaced
// only when that session changes.

import { useSyncExternalStore } from "react";
import type { CheckRecord } from "./types";

export interface DoneWhenSnapshot {
  readonly sessionId: string;
  /** The newest result, or null when no check ran yet. */
  readonly last: CheckRecord | null;
  /** A run Hermes asked for is under way. */
  readonly running: boolean;
  /** When "Send failures back" last sent the result shown (epoch ms). */
  readonly sentAt: number | null;
  /** Final results by turn number. */
  readonly byTurn: Readonly<Record<number, CheckRecord>>;
}

type Listener = () => void;

const snapshots = new Map<string, DoneWhenSnapshot>();
const listeners = new Map<string, Set<Listener>>();
const empties = new Map<string, DoneWhenSnapshot>();

function empty(sessionId: string): DoneWhenSnapshot {
  let e = empties.get(sessionId);
  if (!e) {
    e = Object.freeze({ sessionId, last: null, running: false, sentAt: null, byTurn: Object.freeze({}) });
    empties.set(sessionId, e);
  }
  return e;
}

export function getDoneWhenSnapshot(sessionId: string): DoneWhenSnapshot {
  return snapshots.get(sessionId) ?? empty(sessionId);
}

function update(sessionId: string, patch: (prev: DoneWhenSnapshot) => DoneWhenSnapshot): DoneWhenSnapshot {
  const next = Object.freeze(patch(getDoneWhenSnapshot(sessionId)));
  snapshots.set(sessionId, next);
  const set = listeners.get(sessionId);
  if (set) for (const l of [...set]) l();
  return next;
}

/** A new result arrived (from a run Hermes asked for, or the agent's hook). */
export function recordDoneWhen(record: CheckRecord): DoneWhenSnapshot {
  return update(record.session_id, (prev) => {
    const byTurn =
      record.turn !== null && record.run.final ? Object.freeze({ ...prev.byTurn, [record.turn]: record }) : prev.byTurn;
    return { ...prev, last: record, running: false, sentAt: null, byTurn };
  });
}

export function setDoneWhenRunning(sessionId: string, running: boolean): void {
  if (getDoneWhenSnapshot(sessionId).running === running) return;
  update(sessionId, (prev) => ({ ...prev, running }));
}

export function markDoneWhenSent(sessionId: string, at: number): void {
  update(sessionId, (prev) => ({ ...prev, sentAt: at }));
}

/** The final result recorded for turn `n` of a session, if any. */
export function checksForTurn(sessionId: string, n: number): CheckRecord | null {
  return getDoneWhenSnapshot(sessionId).byTurn[n] ?? null;
}

export function forgetDoneWhen(sessionId: string): void {
  snapshots.delete(sessionId);
  const set = listeners.get(sessionId);
  if (set) for (const l of [...set]) l();
}

export function subscribeDoneWhen(sessionId: string, listener: Listener): () => void {
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

export function useDoneWhen(sessionId: string): DoneWhenSnapshot {
  return useSyncExternalStore(
    (l) => subscribeDoneWhen(sessionId, l),
    () => getDoneWhenSnapshot(sessionId),
    () => getDoneWhenSnapshot(sessionId),
  );
}

export function _resetDoneWhenStoreForTest(): void {
  snapshots.clear();
  listeners.clear();
  empties.clear();
}
