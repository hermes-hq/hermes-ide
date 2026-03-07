/**
 * Embedded changelog shown in the "What's New" dialog after updates.
 *
 * Each entry is keyed by the version string (without "v" prefix).
 * The `items` array contains user-facing descriptions of changes.
 *
 * When releasing a new version, add an entry here with the changes.
 * Only the current version's entry is shown — past entries are kept
 * for reference but not displayed.
 */

export interface ChangelogEntry {
  /** Short list of user-facing changes */
  items: string[];
}

export const changelog: Record<string, ChangelogEntry> = {
  "0.3.31": {
    items: [
      "\"What's New\" dialog after app updates shows what changed",
      "Redesigned left navigation with clear session hierarchy",
      "Git, Files, and Search panels now live inside each session",
      "Session sub-view buttons are always accessible while browsing sessions",
      "Drag-and-drop files directly into terminal sessions",
      "Working directory indicator in the Git panel",
      "Isolated copy badge for worktree sessions",
      "Hover tooltips added across all interactive elements for better discoverability",
    ],
  },
  "0.3.30": {
    items: [
      "Drag-and-drop files directly into terminal sessions",
      "Redesigned left navigation with clear session hierarchy",
      "Git, Files, and Search panels now live inside each session",
      "Session sub-view buttons are always accessible while browsing sessions",
      "Working directory indicator in the Git panel",
      "Isolated copy badge for worktree sessions",
    ],
  },
};
