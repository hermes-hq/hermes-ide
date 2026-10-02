// ─── Attention: the OS side (F12, N16) ────────────────────────────────
//
// Backend: src-tauri/src/attention/.

import { invoke } from "@tauri-apps/api/core";
import type { AwayPayload } from "../attention/notifier";

/** Settings key: the address away messages go to ("" = off, no network call). */
export const AWAY_NOTIFY_URL_KEY = "away_notify_url";

/**
 * Show the Blocked on you count on the app icon: the dock badge on macOS, a
 * taskbar overlay on Windows, the window's urgency hint on Linux. `count` is
 * agents blocked on you; with none, open Hermes notices show "!". Both 0
 * clear it.
 */
export function setAttentionBadge(count: number, notices = 0): Promise<string> {
  return invoke<string>("set_attention_badge", { count, notices });
}

/** Keep the machine from sleeping while an agent works; false lets it sleep again. */
export function setKeepAwake(active: boolean): Promise<string> {
  return invoke<string>("set_keep_awake", { active });
}

export type AwaySendResult =
  | { readonly outcome: "unset" }
  | { readonly outcome: "sent"; readonly status: number; readonly target: string }
  | { readonly outcome: "failed"; readonly error: string; readonly target: string };

/**
 * Send one away message to the configured address. The backend reads the
 * address itself and makes no network call when none is set.
 */
export function sendAwayNotification(payload: AwayPayload): Promise<AwaySendResult> {
  return invoke<AwaySendResult>("send_away_notification", { payload });
}
