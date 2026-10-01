// ─── How the last away message went (N16) ─────────────────────────────
//
// Settings > General shows it under the address ("Last message: sent 12:04 ✓"
// or "failed 12:04: the address answered 500"), and the first failure raises
// one Hermes notice in the inbox, so a broken address never fails in silence.
// Kept for this run of the app only.

import { useSyncExternalStore } from "react";
import { listInboxItems, resolveInboxItem } from "../agent/contract/inbox";
import type { AwaySendResult } from "../api/attention";

export type AwayLast =
  | { readonly outcome: "sent"; readonly at: number }
  | { readonly outcome: "failed"; readonly at: number; readonly error: string };

/** The inbox source of the notice raised when an away message fails. */
export const AWAY_FAILURE_SOURCE = "away";

type Listener = () => void;
let last: AwayLast | null = null;
const listeners = new Set<Listener>();

/**
 * Record what a send returned. "unset" (no address, nothing sent) changes
 * nothing. Returns what was recorded, or null.
 */
export function noteAwayResult(
  result: AwaySendResult | { readonly outcome: "error"; readonly error: string },
  at: number = Date.now(),
): AwayLast | null {
  if (result.outcome === "unset") return null;
  last = result.outcome === "sent" ? { outcome: "sent", at } : { outcome: "failed", at, error: result.error };
  for (const l of [...listeners]) l();
  return last;
}

/** The open Hermes notices about a failed away message. */
export function awayFailureNotices() {
  return listInboxItems().filter((i) => i.sessionId === null && i.source === AWAY_FAILURE_SOURCE);
}

/** A message got through: the notice about an earlier failure goes. */
export function clearAwayFailureNotices(): void {
  for (const i of awayFailureNotices()) resolveInboxItem(i.id);
}

export function getAwayLast(): AwayLast | null {
  return last;
}

export function subscribeAwayLast(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useAwayLast(): AwayLast | null {
  return useSyncExternalStore(subscribeAwayLast, getAwayLast, getAwayLast);
}

/** "12:04" in the person's locale. */
export function awayTime(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function _resetAwayLastForTest(): void {
  last = null;
  listeners.clear();
}
