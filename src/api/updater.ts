// ─── Update channel API ──────────────────────────────────────────────
//
// The update check runs in the backend (`check_for_update`) so it can read
// the channel the user picked in Settings (`update_channel`: stable | beta)
// and point the updater at the matching manifest. The result has the same
// shape as the updater plugin's own check, so it is wrapped in the plugin's
// `Update` class and download/install work unchanged.

import { invoke } from "@tauri-apps/api/core";
import { Update } from "@tauri-apps/plugin-updater";

export type UpdateChannel = "stable" | "beta";

/** Anything that is not exactly "beta" is the stable channel. */
export function normalizeUpdateChannel(value: string | undefined | null): UpdateChannel {
  return value?.trim().toLowerCase() === "beta" ? "beta" : "stable";
}

export interface UpdateChannelInfo {
  channel: UpdateChannel;
  /** The manifest URL the next check will read. */
  endpoint: string;
  /** Checks are switched off for this process (test rigs, self-test). */
  disabled: boolean;
}

interface UpdateMetadata {
  rid: number;
  currentVersion: string;
  version: string;
  date?: string | null;
  body?: string | null;
  rawJson: Record<string, unknown>;
}

export function getUpdateChannelInfo(): Promise<UpdateChannelInfo> {
  return invoke<UpdateChannelInfo>("get_update_channel_info");
}

/** Check for an update on the user's channel. Resolves to null when up to date. */
export async function checkForUpdate(): Promise<Update | null> {
  const meta = await invoke<UpdateMetadata | null>("check_for_update");
  if (!meta) return null;
  return new Update({
    rid: meta.rid,
    currentVersion: meta.currentVersion,
    version: meta.version,
    date: meta.date ?? undefined,
    body: meta.body ?? undefined,
    rawJson: meta.rawJson,
  });
}
