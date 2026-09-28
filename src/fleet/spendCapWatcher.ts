// ─── Spend cap watcher (F31) ──────────────────────────────────────────
//
// Watches the usage each agent reports (the `usage` SessionEvent) against
// the caps in Settings > Limits. When a cap is reached it does two things,
// once while the cap keeps that value:
//
//   1. interrupts the agent in every session of the scope (Ctrl+C, the way
//      a person would; the conversation can be resumed), and
//   2. raises a `limit` item in the attention inbox (source "cap").
//
// It is a plain object with injected effects so it is tested without Tauri;
// useFleetControls wires it to the app.

import { useSyncExternalStore } from "react";
import { getSessionEventSnapshot } from "../agent/contract/sessionEventStore";
import type { InboxItem, InboxRaise } from "../agent/contract/inbox";
import type { FleetCaps } from "./fleetSettings";
import { evaluateSpendCaps, type CapTrip, type FeatureRef, type SpendSession } from "./spend";

export interface SpendWatcherDeps {
  readonly sessions: () => readonly { readonly id: string; readonly label: string }[];
  readonly featureOf: (sessionId: string) => FeatureRef | null;
  readonly caps: () => FleetCaps;
  readonly interrupt: (sessionId: string) => Promise<boolean>;
  readonly raise: (input: InboxRaise) => InboxItem;
  /** The inbox line for a trip, in the user's language. */
  readonly describe: (trip: CapTrip) => string;
}

// ── Which sessions were stopped by a cap (read by the session rows) ───

type Listener = () => void;
let capped: ReadonlyMap<string, CapTrip> = new Map();
const cappedListeners = new Set<Listener>();

function setCapped(next: ReadonlyMap<string, CapTrip>): void {
  capped = next;
  for (const l of [...cappedListeners]) l();
}

export function getCapTrip(sessionId: string): CapTrip | null {
  return capped.get(sessionId) ?? null;
}

function subscribeCapped(listener: Listener): () => void {
  cappedListeners.add(listener);
  return () => {
    cappedListeners.delete(listener);
  };
}

/** The cap that stopped this session, or null. */
export function useSessionCapTrip(sessionId: string): CapTrip | null {
  return useSyncExternalStore(
    subscribeCapped,
    () => getCapTrip(sessionId),
    () => getCapTrip(sessionId),
  );
}

export function _resetCapTripsForTest(): void {
  capped = new Map();
  cappedListeners.clear();
}

// ── The watcher ─────────────────────────────────────────────────────

export interface SpendCapWatcher {
  /** Compare what every session reported with the caps; act on new trips. */
  check(): CapTrip[];
  /** Crossings already acted on (scope + cap value) under the current caps. */
  trippedKeys(): ReadonlySet<string>;
}

export function createSpendCapWatcher(deps: SpendWatcherDeps): SpendCapWatcher {
  // Crossings acted on, with the cap they crossed. Only remembered while
  // that cap keeps its value: a cap the user changes (or turns off and on
  // again) is a new cap, so setting $1 again after $2 trips again.
  const tripped = new Map<string, { kind: CapTrip["kind"]; capUsd: number }>();
  const trippedKeys = new Set<string>();
  return {
    check() {
      const sessions: SpendSession[] = deps.sessions().map((s) => ({
        id: s.id,
        label: s.label,
        costUsd: getSessionEventSnapshot(s.id).usage?.costUsd ?? null,
        feature: deps.featureOf(s.id),
      }));
      const caps = deps.caps();
      for (const [key, crossed] of tripped) {
        if ((crossed.kind === "session" ? caps.sessionUsd : caps.featureUsd) !== crossed.capUsd) {
          tripped.delete(key);
          trippedKeys.delete(key);
        }
      }
      const trips = evaluateSpendCaps(sessions, caps, trippedKeys);
      // A cap the user has since changed or turned off no longer marks
      // the sessions it stopped.
      const next = new Map(
        [...capped].filter(([, trip]) => (trip.kind === "session" ? caps.sessionUsd : caps.featureUsd) === trip.capUsd),
      );
      if (trips.length === 0) {
        if (next.size !== capped.size) setCapped(next);
        return trips;
      }
      for (const trip of trips) {
        tripped.set(trip.tripKey, { kind: trip.kind, capUsd: trip.capUsd });
        trippedKeys.add(trip.tripKey);
        for (const id of trip.sessionIds) {
          next.set(id, trip);
          deps.interrupt(id).catch((err) => console.warn("[fleet] could not interrupt", id, err));
        }
        deps.raise({ kind: "limit", sessionId: trip.leadSessionId, detail: deps.describe(trip), source: "cap" });
      }
      setCapped(next);
      return trips;
    },
    trippedKeys: () => trippedKeys,
  };
}
