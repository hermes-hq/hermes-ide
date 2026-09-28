// ─── What the attention center did, for the test hooks ────────────────
//
// F12. The attention center records its decisions here; src/e2e/hooks.ts
// (test builds only) reads them so a real-app scenario can check what was
// notified, what was sent away, and which badge and keep-awake states the
// app asked the OS for. Nothing reads this in a normal build.

import type { AwaySendResult } from "../api/attention";
import type { AwayPayload, Notifier } from "./notifier";

export interface AwayLogEntry {
  readonly payload: AwayPayload;
  readonly result: AwaySendResult | { readonly outcome: "error"; readonly error: string } | null;
}

export interface OsNotificationLogEntry {
  readonly itemId: string;
  readonly title: string;
  readonly body: string;
  /** False when the OS gave no permission to notify. */
  readonly delivered: boolean;
}

export const attentionDebug = {
  notifier: null as Notifier | null,
  os: [] as OsNotificationLogEntry[],
  away: [] as AwayLogEntry[],
  /** Every badge count asked of the OS, in order. */
  badge: [] as number[],
  /** Every keep-awake state asked of the OS, in order. */
  keepAwake: [] as boolean[],
};

const CAP = 100;

export function pushCapped<T>(list: T[], entry: T): void {
  list.push(entry);
  if (list.length > CAP) list.shift();
}
