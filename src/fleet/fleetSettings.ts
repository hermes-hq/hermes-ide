// ─── Fleet caps (2.0: F31 spend caps, N22 task queue) ────────────────
//
// Four numbers the user sets in Settings > Limits, all off until set:
//
//   sessionUsd   stop a session whose agent reports spending this much
//   featureUsd   the same for every session working on one feature branch
//   maxRunning   how many agents may run at once; more tasks wait in a queue
//   maxMemoryMb  how much memory running agents may use before tasks wait
//
// Stored as plain settings (see VALID_SETTING_KEYS in src-tauri/src/db) and
// held here so the watchers see a change the moment it is saved.

import { useSyncExternalStore } from "react";
import { getSettings, setSetting, type SettingsMap } from "../api/settings";

export interface FleetCaps {
  readonly sessionUsd: number | null;
  readonly featureUsd: number | null;
  readonly maxRunning: number | null;
  readonly maxMemoryMb: number | null;
}

export type FleetCapField = keyof FleetCaps;

export const FLEET_SETTING_KEYS: Readonly<Record<FleetCapField, string>> = Object.freeze({
  sessionUsd: "fleet_spend_cap_session_usd",
  featureUsd: "fleet_spend_cap_feature_usd",
  maxRunning: "fleet_max_running_agents",
  maxMemoryMb: "fleet_max_agent_memory_mb",
});

export const NO_CAPS: FleetCaps = Object.freeze({ sessionUsd: null, featureUsd: null, maxRunning: null, maxMemoryMb: null });

/** A cap value from text: a positive number (a whole one for counts), else null (off). */
export function parseCapValue(field: FleetCapField, raw: string | null | undefined): number | null {
  if (raw === undefined || raw === null) return null;
  const text = raw.trim();
  if (text === "" || !/^\d+(\.\d+)?$/.test(text)) return null;
  const value = Number(text);
  if (!Number.isFinite(value) || value <= 0) return null;
  if (field === "maxRunning" || field === "maxMemoryMb") return Number.isInteger(value) ? value : null;
  return value;
}

export function parseFleetCaps(map: SettingsMap): FleetCaps {
  return Object.freeze({
    sessionUsd: parseCapValue("sessionUsd", map[FLEET_SETTING_KEYS.sessionUsd]),
    featureUsd: parseCapValue("featureUsd", map[FLEET_SETTING_KEYS.featureUsd]),
    maxRunning: parseCapValue("maxRunning", map[FLEET_SETTING_KEYS.maxRunning]),
    maxMemoryMb: parseCapValue("maxMemoryMb", map[FLEET_SETTING_KEYS.maxMemoryMb]),
  });
}

type Listener = () => void;
let caps: FleetCaps = NO_CAPS;
const listeners = new Set<Listener>();

function publish(next: FleetCaps): void {
  caps = next;
  for (const l of [...listeners]) l();
}

export function getFleetCaps(): FleetCaps {
  return caps;
}

export function subscribeFleetCaps(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useFleetCaps(): FleetCaps {
  return useSyncExternalStore(subscribeFleetCaps, getFleetCaps, getFleetCaps);
}

/** Read the caps once at startup. Never rejects; unreadable settings mean no caps. */
export async function loadFleetCaps(read: () => Promise<SettingsMap> = getSettings): Promise<FleetCaps> {
  try {
    publish(parseFleetCaps(await read()));
  } catch (err) {
    console.warn("[fleet] could not read the caps:", err);
  }
  return caps;
}

/** Save one cap (null turns it off) and apply it at once. */
export async function setFleetCap(
  field: FleetCapField,
  value: number | null,
  write: (key: string, value: string) => Promise<void> = setSetting,
): Promise<void> {
  const clean = value === null ? null : parseCapValue(field, String(value));
  await write(FLEET_SETTING_KEYS[field], clean === null ? "" : String(clean));
  publish(Object.freeze({ ...caps, [field]: clean }));
}

export function _resetFleetCapsForTest(next: FleetCaps = NO_CAPS): void {
  caps = next;
  listeners.clear();
}
