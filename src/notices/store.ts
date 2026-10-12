// ─── Notices from the Hermes team: the switch and the backend calls ───
//
// The Settings switch "Show notices from the Hermes team" is the setting
// `notices_enabled` ("on" | "off", on by default). It is read at startup
// with the other settings and changes live when Settings flips it; the
// sidebar card reads it through `useNoticesEnabled`. The rules live in
// ./model.ts, the fetch and its validation in src-tauri/src/notices.rs.
// This file is startup code (Settings and the sidebar read the switch); the
// card and its rules load on demand.

import { useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { setSetting, type SettingsMap } from "../api/settings";
import type { NoticesState, RemoteNotice } from "./model";

export const NOTICES_ENABLED_KEY = "notices_enabled";
export const NOTICES_STATE_KEY = "notices_state";
export const NOTICES_LANDED_KEY = "notices_landed";

/** Pure: what the stored value means (anything but "off" is on). */
export function noticesEnabledFrom(value: string | undefined | null): boolean {
  return value?.trim().toLowerCase() !== "off";
}

let enabled = true;
const listeners = new Set<() => void>();

function notify(): void {
  for (const l of [...listeners]) l();
}

export function initNoticesPreference(settings: SettingsMap): void {
  const next = noticesEnabledFrom(settings[NOTICES_ENABLED_KEY]);
  if (next !== enabled) {
    enabled = next;
    notify();
  }
}

export function isNoticesEnabled(): boolean {
  return enabled;
}

/** Flip the switch now and persist it. */
export function setNoticesEnabled(value: boolean): Promise<void> {
  if (value !== enabled) {
    enabled = value;
    notify();
  }
  return setSetting(NOTICES_ENABLED_KEY, value ? "on" : "off");
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useNoticesEnabled(): boolean {
  return useSyncExternalStore(subscribe, isNoticesEnabled, isNoticesEnabled);
}

/** The validated remote notices (the backend fetches at most once a day). Never rejects. */
export async function listRemoteNotices(): Promise<RemoteNotice[]> {
  try {
    const list = await invoke<RemoteNotice[]>("notices_list");
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

export function saveNoticesState(state: NoticesState): Promise<void> {
  return setSetting(NOTICES_STATE_KEY, JSON.stringify(state)).catch(() => {});
}
