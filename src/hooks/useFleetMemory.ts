// ─── Memory per session (F24) ─────────────────────────────────────────
//
// One poller for the whole window: while any session row shows its memory,
// the backend is asked every few seconds for the memory of every session's
// process tree (src-tauri/src/fleet.rs). Rows read their own number from
// the shared snapshot and re-render only when it changes.

import { useSyncExternalStore } from "react";
import { getFleetMemory } from "../api/processes";
import type { FleetMemory } from "../types/process";

export const FLEET_MEMORY_POLL_MS = 5000;

type Listener = () => void;

interface FleetMemoryStore {
  subscribe: (listener: Listener) => () => void;
  bytesOf: (sessionId: string) => number | null;
  /** The last reading, or null before the first. */
  latest: () => FleetMemory | null;
}

/** A store around a reader; separate so tests can drive it with a fake. */
export function createFleetMemoryStore(
  read: () => Promise<FleetMemory>,
  intervalMs = FLEET_MEMORY_POLL_MS,
): FleetMemoryStore {
  let latest: FleetMemory | null = null;
  let bySession = new Map<string, number>();
  const listeners = new Set<Listener>();
  let timer: ReturnType<typeof setInterval> | null = null;
  let inFlight = false;

  const poll = () => {
    if (inFlight) return;
    inFlight = true;
    read()
      .then((reading) => {
        const next = new Map<string, number>();
        for (const s of reading.sessions) if (s.processes > 0) next.set(s.sessionId, s.bytes);
        latest = reading;
        bySession = next;
        for (const l of [...listeners]) l();
      })
      .catch(() => { /* keep the last reading */ })
      .finally(() => {
        inFlight = false;
      });
  };

  return {
    subscribe(listener) {
      listeners.add(listener);
      if (!timer) {
        poll();
        timer = setInterval(poll, intervalMs);
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0 && timer) {
          clearInterval(timer);
          timer = null;
        }
      };
    },
    bytesOf: (sessionId) => bySession.get(sessionId) ?? null,
    latest: () => latest,
  };
}

const store = createFleetMemoryStore(getFleetMemory);

/** Resident memory of a session's processes in bytes; null until known. */
export function useSessionMemory(sessionId: string): number | null {
  return useSyncExternalStore(store.subscribe, () => store.bytesOf(sessionId), () => null);
}

const MB = 1024 * 1024;

/** "182 MB", "1.4 GB": what a row has room for. */
export function formatMemory(bytes: number): string {
  if (bytes >= 1024 * MB) return `${(bytes / (1024 * MB)).toFixed(1)} GB`;
  return `${Math.max(1, Math.round(bytes / MB))} MB`;
}
