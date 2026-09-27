// Setting keys shared by the first-launch dialogs and the small gates in the
// startup bundle that decide whether to load them at all. Kept in their own
// module so a gate can read them without pulling in the dialog's code.

/** "true" once the user has finished the welcome wizard. */
export const ONBOARDING_COMPLETED_SETTING = "onboarding_completed";

/** The app version whose "What's new" the user last saw. */
export const WHATS_NEW_LAST_SEEN_SETTING = "last_seen_version";

/** "true" when the user asked not to see "What's new" again. */
export const WHATS_NEW_SUPPRESS_SETTING = "suppress_whats_new";

/** localStorage key that forces the "What's new" dialog for a given version. */
export const WHATS_NEW_PREVIEW_STORAGE_KEY = "hermesPreviewWhatsNew";
