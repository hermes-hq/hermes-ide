// ─── Release channel detection ────────────────────────────────────────
//
// Hermes ships one binary; a build is promoted from beta to stable without
// changing its version number. So the channel a person is on is the
// `update_channel` setting ("stable" | "beta"). Anything other than exactly
// "beta" is stable. Today nothing in the app writes this setting yet: the
// updater's channel picker (N05) will store it there and read the same key
// to pick its manifest. Until then it only changes by editing the settings.
//
// A version with a `-beta` prerelease tag (e.g. "1.4.0-beta.2") also counts
// as beta, for builds that are only ever published to beta testers.

export type ReleaseChannel = "stable" | "beta";

/** Settings key for the release channel (stable | beta); the updater reads it once N05 lands. */
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
