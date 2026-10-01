// ─── Away notifications: when to send, and what to name (N16) ─────────
//
// Two settings next to the address (Settings > General):
//
//   away_notify_delay  how long an agent may wait on you unanswered while a
//                      Hermes window has the focus before the message goes
//                      out anyway: "0" (Immediately), "120" (After 2 min, the
//                      default) or "600" (After 10 min), in seconds. With no
//                      Hermes window focused it goes out at once.
//   away_notify_names  "on": the message carries the session's name, whatever
//                      named it (a name can come from a first message);
//                      otherwise only names that cannot come from a prompt.
//
// Read once at startup and kept here, so a change in Settings applies at
// once (the dialog publishes what it saves).

import { useSyncExternalStore } from "react";
import { getSettings, type SettingsMap } from "../api/settings";

export const AWAY_NOTIFY_DELAY_KEY = "away_notify_delay";
export const AWAY_NOTIFY_NAMES_KEY = "away_notify_names";

/** The choices of "Send after", in seconds, as stored. */
export const AWAY_DELAY_CHOICES = ["0", "120", "600"] as const;
export type AwayDelayChoice = (typeof AWAY_DELAY_CHOICES)[number];
export const DEFAULT_AWAY_DELAY: AwayDelayChoice = "120";

export interface AwayPrefs {
  readonly delay: AwayDelayChoice;
  readonly includeNames: boolean;
}

export const DEFAULT_AWAY_PREFS: AwayPrefs = Object.freeze({ delay: DEFAULT_AWAY_DELAY, includeNames: false });

/** A stored delay, or the default for anything else. */
export function parseAwayDelay(raw: string | null | undefined): AwayDelayChoice {
  const v = (raw ?? "").trim();
  return (AWAY_DELAY_CHOICES as readonly string[]).includes(v) ? (v as AwayDelayChoice) : DEFAULT_AWAY_DELAY;
}

export function awayDelayMs(delay: AwayDelayChoice): number {
  return Number(delay) * 1000;
}

export function parseAwayPrefs(map: SettingsMap): AwayPrefs {
  return Object.freeze({
    delay: parseAwayDelay(map[AWAY_NOTIFY_DELAY_KEY]),
    includeNames: (map[AWAY_NOTIFY_NAMES_KEY] ?? "").trim() === "on",
  });
}

type Listener = () => void;
let prefs: AwayPrefs = DEFAULT_AWAY_PREFS;
const listeners = new Set<Listener>();

function publish(next: AwayPrefs): void {
  prefs = next;
  for (const l of [...listeners]) l();
}

export function getAwayPrefs(): AwayPrefs {
  return prefs;
}

export function subscribeAwayPrefs(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useAwayPrefs(): AwayPrefs {
  return useSyncExternalStore(subscribeAwayPrefs, getAwayPrefs, getAwayPrefs);
}

/** Read the settings. Never rejects; unreadable settings keep the defaults. */
export async function loadAwayPrefs(read: () => Promise<SettingsMap> = getSettings): Promise<AwayPrefs> {
  try {
    publish(parseAwayPrefs(await read()));
  } catch (err) {
    console.warn("[attention] could not read the away settings:", err);
  }
  return prefs;
}

/** Apply a value Settings just saved. */
export function applyAwayPref(key: string, value: string): void {
  if (key === AWAY_NOTIFY_DELAY_KEY) publish(Object.freeze({ ...prefs, delay: parseAwayDelay(value) }));
  else if (key === AWAY_NOTIFY_NAMES_KEY) publish(Object.freeze({ ...prefs, includeNames: value === "on" }));
}

export function _resetAwayPrefsForTest(next: AwayPrefs = DEFAULT_AWAY_PREFS): void {
  prefs = next;
  listeners.clear();
}
