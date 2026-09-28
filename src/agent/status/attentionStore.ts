// ─── Attention store: the status of every session, for React ──────────
//
// F10. An external store (read with useSyncExternalStore) over the C0
// session-event store: for each session it serves the derived status
// (deriveStatus), and across sessions a summary of who needs a person.
// It adds the one thing the event store does not know: when a person last
// looked at a session, so a finished turn reads "done" until it is seen and
// "idle" afterwards.
//
// Snapshots are cached and only replaced when that session's events or its
// seen time change, so a row re-renders exactly when its status changed.
// Vendor-neutral: nothing here knows which agent a session runs.

import { useSyncExternalStore } from "react";
import {
  getSessionEventSnapshot,
  sessionIdsWithEvents,
  subscribeAllSessionEvents,
  subscribeSessionEvents,
} from "../contract/sessionEventStore";
import { AGENT_STATUS_KINDS, BLOCKING_STATUS_KINDS, type AgentStatusKind } from "../contract/status";
import { deriveStatus, type DerivedStatus } from "./deriveStatus";
import { userInputTimes } from "./userInput";

type Listener = () => void;

/** The session on screen in a focused window, if any. */
let viewed: string | null = null;
const seenAt = new Map<string, number>();
const seenListeners = new Map<string, Set<Listener>>();
const summaryListeners = new Set<Listener>();
const cache = new Map<string, { version: number; seen: number | null; inputs: readonly number[]; value: DerivedStatus }>();

/** When a person last saw the session; Infinity while it is on screen. */
export function seenAtOf(sessionId: string): number | null {
  if (viewed === sessionId) return Infinity;
  return seenAt.get(sessionId) ?? null;
}

function notifySeen(sessionId: string): void {
  const set = seenListeners.get(sessionId);
  if (set) for (const l of [...set]) l();
  notifySummary();
}

/** The derived status of one session; the same object until it changes. */
export function getSessionStatus(sessionId: string): DerivedStatus {
  const snapshot = getSessionEventSnapshot(sessionId);
  const seen = seenAtOf(sessionId);
  const inputs = userInputTimes(sessionId);
  const hit = cache.get(sessionId);
  if (hit && hit.version === snapshot.version && hit.seen === seen && hit.inputs === inputs) return hit.value;
  const value = deriveStatus({ snapshot, seenAt: seen, inputTimes: inputs });
  // Keep the old object when the answer did not change (a new event that
  // left the status as it was must not re-render the row).
  const same =
    hit &&
    hit.value.kind === value.kind &&
    hit.value.confidence === value.confidence &&
    hit.value.detail === value.detail &&
    hit.value.at === value.at &&
    hit.value.source === value.source;
  const kept = same ? hit.value : value;
  cache.set(sessionId, { version: snapshot.version, seen, inputs, value: kept });
  return kept;
}

export function subscribeSessionStatus(sessionId: string, listener: Listener): () => void {
  const unsubEvents = subscribeSessionEvents(sessionId, listener);
  let set = seenListeners.get(sessionId);
  if (!set) {
    set = new Set();
    seenListeners.set(sessionId, set);
  }
  set.add(listener);
  return () => {
    unsubEvents();
    set.delete(listener);
    if (set.size === 0) seenListeners.delete(sessionId);
  };
}

/** The status one session shows, re-rendering only when it changes. */
export function useSessionStatus(sessionId: string): DerivedStatus {
  return useSyncExternalStore(
    (l) => subscribeSessionStatus(sessionId, l),
    () => getSessionStatus(sessionId),
    () => getSessionStatus(sessionId),
  );
}

/**
 * Which session is on screen in a focused window (null: none, e.g. the
 * window lost focus). Leaving a session counts as having seen it.
 */
export function setViewedSession(sessionId: string | null, now: number = Date.now()): void {
  if (viewed === sessionId) return;
  const previous = viewed;
  viewed = sessionId;
  if (previous) {
    seenAt.set(previous, Math.max(seenAt.get(previous) ?? 0, now));
    notifySeen(previous);
  }
  if (sessionId) notifySeen(sessionId);
}

/** A person looked at the session (for example: clicked it in the list). */
export function markSessionSeen(sessionId: string, now: number = Date.now()): void {
  const before = seenAt.get(sessionId) ?? null;
  if (before !== null && before >= now) return;
  seenAt.set(sessionId, now);
  notifySeen(sessionId);
}

/** Forget a closed session. */
export function forgetSessionStatus(sessionId: string): void {
  seenAt.delete(sessionId);
  cache.delete(sessionId);
  if (viewed === sessionId) viewed = null;
  notifySeen(sessionId);
}

// ── Across sessions ───────────────────────────────────────────────────

export interface AttentionSummary {
  /** How many sessions show each kind. */
  readonly counts: Readonly<Record<AgentStatusKind, number>>;
  /** Sessions a person has to act on, most urgent kind first, then by time. */
  readonly needsYou: readonly { readonly sessionId: string; readonly status: DerivedStatus }[];
}

let summary: AttentionSummary | null = null;
let summarySubscription: (() => void) | null = null;

function notifySummary(): void {
  summary = null;
  for (const l of [...summaryListeners]) l();
}

function computeSummary(): AttentionSummary {
  const counts = Object.fromEntries(AGENT_STATUS_KINDS.map((k) => [k, 0])) as Record<AgentStatusKind, number>;
  const needsYou: { sessionId: string; status: DerivedStatus }[] = [];
  for (const sessionId of sessionIdsWithEvents()) {
    const status = getSessionStatus(sessionId);
    counts[status.kind] += 1;
    if (BLOCKING_STATUS_KINDS.includes(status.kind)) needsYou.push({ sessionId, status });
  }
  const order = (k: AgentStatusKind) => AGENT_STATUS_KINDS.indexOf(k);
  needsYou.sort((a, b) => order(a.status.kind) - order(b.status.kind) || (a.status.at ?? 0) - (b.status.at ?? 0));
  return Object.freeze({ counts: Object.freeze(counts), needsYou: Object.freeze(needsYou) });
}

export function getAttentionSummary(): AttentionSummary {
  // Without a subscriber nothing invalidates the cache, so answer fresh.
  if (!summarySubscription) return computeSummary();
  if (!summary) summary = computeSummary();
  return summary;
}

export function subscribeAttentionSummary(listener: Listener): () => void {
  summaryListeners.add(listener);
  if (!summarySubscription) summarySubscription = subscribeAllSessionEvents(() => notifySummary());
  return () => {
    summaryListeners.delete(listener);
    if (summaryListeners.size === 0 && summarySubscription) {
      summarySubscription();
      summarySubscription = null;
    }
  };
}

/** Every session's status at a glance; re-renders when any of them changes. */
export function useAttentionSummary(): AttentionSummary {
  return useSyncExternalStore(subscribeAttentionSummary, getAttentionSummary, getAttentionSummary);
}

export function _resetAttentionStoreForTest(): void {
  viewed = null;
  seenAt.clear();
  seenListeners.clear();
  summaryListeners.clear();
  cache.clear();
  summary = null;
  summarySubscription?.();
  summarySubscription = null;
}
