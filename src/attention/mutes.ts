// ─── Per-session mutes (M in the inbox) ───────────────────────────────
//
// A muted session stays in the inbox but is left out of the badge, ⌘I and
// every notification until its mute runs out (an hour). Kept in memory: a
// restart forgets mutes, which is the safe direction.

import { useSyncExternalStore } from "react";
import { MUTE_DURATION_MS, type MuteMap } from "./model";

type Listener = () => void;

let mutes: MuteMap = new Map();
const listeners = new Set<Listener>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
let clock: () => number = () => Date.now();

function publish(next: Map<string, number>): void {
  mutes = next;
  for (const l of [...listeners]) l();
}

export function getMutes(): MuteMap {
  return mutes;
}

export function subscribeMutes(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useMutes(): MuteMap {
  return useSyncExternalStore(subscribeMutes, getMutes, getMutes);
}

/** Mute a session for an hour (or `durationMs`). Returns when it ends. */
export function muteSession(sessionId: string, durationMs: number = MUTE_DURATION_MS): number {
  const until = clock() + durationMs;
  const next = new Map(mutes);
  next.set(sessionId, until);
  clearTimeout(timers.get(sessionId));
  // Wake subscribers when the mute ends, so the badge counts it again.
  timers.set(
    sessionId,
    setTimeout(() => {
      timers.delete(sessionId);
      if (mutes.get(sessionId) === until) unmuteSession(sessionId);
    }, durationMs),
  );
  publish(next);
  return until;
}

export function unmuteSession(sessionId: string): boolean {
  if (!mutes.has(sessionId)) return false;
  clearTimeout(timers.get(sessionId));
  timers.delete(sessionId);
  const next = new Map(mutes);
  next.delete(sessionId);
  publish(next);
  return true;
}

export function _resetMutesForTest(now?: () => number): void {
  for (const t of timers.values()) clearTimeout(t);
  timers.clear();
  listeners.clear();
  mutes = new Map();
  clock = now ?? (() => Date.now());
}
