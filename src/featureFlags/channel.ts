// ─── Release channel detection ────────────────────────────────────────
//
// Hermes ships one binary. The channel is derived from the app version
// string: a version with a `-beta` prerelease tag (e.g. "1.4.0-beta.2") is
// the beta channel; anything else (including plain "1.4.0" and "-rc"/"-dev"
// tags) is stable.

export type ReleaseChannel = "stable" | "beta";

const BETA_TAG = /-beta(\.|$)/i;

/** Pure function so it's testable without a Tauri runtime. */
export function channelFromVersion(version: string): ReleaseChannel {
  return BETA_TAG.test(version) ? "beta" : "stable";
}
