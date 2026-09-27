// ─── Release channel detection ────────────────────────────────────────
//
// Hermes ships one binary; a build is promoted from beta to stable without
// changing its version number. So the channel a person is on is the
// `update_channel` setting ("stable" | "beta") that the updater also reads
// to pick its manifest. Anything other than exactly "beta" is stable.
//
// A version with a `-beta` prerelease tag (e.g. "1.4.0-beta.2") also counts
// as beta, for builds that are only ever published to beta testers.

export type ReleaseChannel = "stable" | "beta";

/** Settings key shared with the updater (stable | beta). */
export const UPDATE_CHANNEL_KEY = "update_channel";

const BETA_TAG = /-beta(\.|$)/i;

/** Pure function so it's testable without a Tauri runtime. */
export function channelFromVersion(version: string): ReleaseChannel {
  return BETA_TAG.test(version) ? "beta" : "stable";
}

/** Normalises the stored `update_channel` value: only "beta" is beta. */
export function channelFromSetting(value: string | undefined | null): ReleaseChannel {
  return value?.trim().toLowerCase() === "beta" ? "beta" : "stable";
}

/** Beta if the person picked the beta update channel or runs a -beta build. */
export function detectReleaseChannel(updateChannel: string | undefined | null, version: string): ReleaseChannel {
  return channelFromSetting(updateChannel) === "beta" || channelFromVersion(version) === "beta" ? "beta" : "stable";
}
