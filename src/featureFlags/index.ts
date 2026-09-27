// ─── Feature flags ─────────────────────────────────────────────────────
//
// Off by default on stable, on for beta (the channel comes from the
// `update_channel` setting the updater also uses — see ./channel.ts). Overridable per-flag from a hidden
// section of Settings (Settings.tsx > "flags" tab, unlocked by clicking the
// panel title 7 times) for testing before a feature ships to everyone.
//
// Flags are read ONCE, at startup (see initFeatureFlags, called from
// src/main.tsx before the app renders). Changing an override afterwards
// only takes effect the next time Hermes launches — there is no live
// reactivity, on purpose: it keeps "is this flag on" a simple synchronous
// question for the rest of the app, and matches how a real release channel
// works (you don't hot-swap channels mid-session).
//
// See src/featureFlags/registry.ts for the flag list and
// src/featureFlags/channel.ts for channel detection.

import { getVersion } from "@tauri-apps/api/app";
import { getSettings, setSetting, type SettingsMap } from "../api/settings";
import { FEATURE_FLAGS, type FeatureFlagId } from "./registry";
import { detectReleaseChannel, UPDATE_CHANNEL_KEY, type ReleaseChannel } from "./channel";

export { FEATURE_FLAGS };
export type { FeatureFlagId, ReleaseChannel };
export { detectReleaseChannel, UPDATE_CHANNEL_KEY };

/** Settings key: JSON-encoded `Partial<Record<FeatureFlagId, boolean>>`. */
export const FEATURE_FLAG_OVERRIDES_KEY = "feature_flag_overrides";

export type FeatureFlagOverrides = Partial<Record<FeatureFlagId, boolean>>;

const KNOWN_IDS: ReadonlySet<string> = new Set(FEATURE_FLAGS.map((f) => f.id));

/** Parses the raw setting value, dropping unknown ids and malformed entries. */
export function parseFeatureFlagOverrides(raw: string | undefined | null): FeatureFlagOverrides {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object") return {};
  const out: FeatureFlagOverrides = {};
  for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (KNOWN_IDS.has(id) && typeof value === "boolean") {
      out[id as FeatureFlagId] = value;
    }
  }
  return out;
}

interface FlagState {
  channel: ReleaseChannel;
  overrides: FeatureFlagOverrides;
}

let state: FlagState | null = null;

/** How long startup waits for the channel and overrides before giving up. */
export const FEATURE_FLAG_INIT_TIMEOUT_MS = 2000;

/**
 * Reads the release channel (the `update_channel` setting, or a -beta app
 * version — see ./channel.ts) and the persisted overrides once. Call this
 * exactly once, before the app renders anything that depends on a flag
 * (src/main.tsx does this).
 *
 * Never rejects. If the reads take longer than `timeoutMs`, it resolves with
 * every flag at its stable default and ignores the late answer, so flags
 * never change mid-session.
 */
export async function initFeatureFlags(
  settings?: SettingsMap,
  timeoutMs: number = FEATURE_FLAG_INIT_TIMEOUT_MS,
): Promise<void> {
  const read = Promise.all([
    settings ? Promise.resolve(settings) : getSettings().catch(() => ({} as SettingsMap)),
    getVersion().catch(() => "0.0.0"),
  ]).then(([map, version]): FlagState => ({
    channel: detectReleaseChannel(map[UPDATE_CHANNEL_KEY], version),
    overrides: parseFeatureFlagOverrides(map[FEATURE_FLAG_OVERRIDES_KEY]),
  }));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<FlagState>((resolve) => {
    timer = setTimeout(() => resolve({ channel: "stable", overrides: {} }), timeoutMs);
  });
  try {
    state = await Promise.race([read, timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

/** The channel detected at startup. "stable" until initFeatureFlags resolves. */
export function getReleaseChannel(): ReleaseChannel {
  return state?.channel ?? "stable";
}

/** Whether flags have finished their one-time startup read. */
export function areFeatureFlagsReady(): boolean {
  return state !== null;
}

/**
 * Whether a flag is on: an override wins if one is set, otherwise it
 * follows the release channel (on for beta, off for stable).
 */
export function isFeatureFlagEnabled(id: FeatureFlagId): boolean {
  const override = state?.overrides[id];
  if (typeof override === "boolean") return override;
  return getReleaseChannel() === "beta";
}

/** The current override for a flag, or undefined if it follows the channel. */
export function getFeatureFlagOverride(id: FeatureFlagId): boolean | undefined {
  return state?.overrides[id];
}

/**
 * Persists an override (or clears it with `null`). Takes effect on next
 * launch — see the module doc comment above.
 */
export async function setFeatureFlagOverride(id: FeatureFlagId, value: boolean | null): Promise<void> {
  const next: FeatureFlagOverrides = { ...(state?.overrides ?? {}) };
  if (value === null) delete next[id];
  else next[id] = value;
  if (state) state.overrides = next;
  await setSetting(FEATURE_FLAG_OVERRIDES_KEY, JSON.stringify(next));
}

/** Test-only: reset the module's cached state between tests. */
export function __resetFeatureFlagsForTest(): void {
  state = null;
}
