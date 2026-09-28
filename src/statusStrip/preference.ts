// ─── Status strip preference ──────────────────────────────────────────
//
// F11: the one-line strip above a terminal agent session (state, source,
// ⌘I) can be switched off in Settings. The setting is `status_strip`
// ("on" | "off", on by default). It is read once at startup with the other
// settings and changes live when Settings flips it; components read it
// through `useStatusStripEnabled`.

import { useSyncExternalStore } from "react";
import { setSetting, type SettingsMap } from "../api/settings";

export const STATUS_STRIP_KEY = "status_strip";

let enabled = true;
const listeners = new Set<() => void>();

function notify(): void {
  for (const l of [...listeners]) l();
}

/** Pure: what the stored value means (anything but "off" is on). */
export function statusStripEnabledFrom(value: string | undefined | null): boolean {
  return value?.trim().toLowerCase() !== "off";
}

/** Read the preference from the settings map loaded at startup. */
export function initStatusStripPreference(settings: SettingsMap): void {
  const next = statusStripEnabledFrom(settings[STATUS_STRIP_KEY]);
  if (next !== enabled) {
    enabled = next;
    notify();
  }
}

export function isStatusStripEnabled(): boolean {
  return enabled;
}

/** Flip the preference now and persist it. */
export function setStatusStripEnabled(value: boolean): Promise<void> {
  if (value !== enabled) {
    enabled = value;
    notify();
  }
  return setSetting(STATUS_STRIP_KEY, value ? "on" : "off");
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useStatusStripEnabled(): boolean {
  return useSyncExternalStore(subscribe, isStatusStripEnabled, isStatusStripEnabled);
}

export function _resetStatusStripPreferenceForTest(): void {
  enabled = true;
  listeners.clear();
}
