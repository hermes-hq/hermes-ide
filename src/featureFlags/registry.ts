// ─── Feature flag registry ────────────────────────────────────────────
//
// A flag hides a not-yet-proven feature from stable users while it ships to
// beta. Flags are meant to be SHORT-LIVED: delete a flag's entry (and the
// `if (isFeatureFlagEnabled(...))` branch it guards) once the feature is
// proven and shipping to everyone.
//
// At most 5 flags may exist at once — enforced by
// src/__tests__/feature-flags.test.ts. If you need a 6th, retire one first.
//
// See src-tauri (none needed today: flags are a frontend-only concept, read
// once at startup from the app version + the `feature_flag_overrides`
// setting — see src/featureFlags/index.ts).

export interface FeatureFlagDefinition {
  readonly id: string;
  /** Short label shown in the hidden Settings > Flags section. */
  readonly label: string;
  /** One sentence explaining what the flag gates and why it exists. */
  readonly description: string;
}

export const FEATURE_FLAGS = [
  {
    id: "dummyProofSurface",
    label: "Dummy proof surface",
    description:
      "A harmless badge in the top bar used to prove the feature-flag mechanism end to end. Delete this flag once a real flagged feature exists.",
  },
  {
    id: "diskGuard",
    label: "Disk guard and worktree hygiene",
    description:
      "Refuses to create a worktree below 10 GB free, shows disk used per worktree, removes build output on request and sweeps orphaned worktree folders in one action (Git panel > Worktrees).",
  },
] as const satisfies readonly FeatureFlagDefinition[];

/** Derived from FEATURE_FLAGS, so adding or deleting an entry is the only step. */
export type FeatureFlagId = (typeof FEATURE_FLAGS)[number]["id"];
