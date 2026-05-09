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
  "1.1.0": {
    items: [
      "Modern session timeline — speaker chips with avatars, sans-serif body, soft message cards instead of the brass-bar logbook",
      "Type / to see every Claude command — built-ins, plugins, skills — clearly labeled in-app or terminal",
      "Embedded inline terminal runs interactive /mcp, /agents, /cost, /help and friends without leaving the chat",
      "New Terminal button opens a quick shell right next to the composer for git, npm, ls — anything",
      "MCP server panel shows transport, command, env keys, tools, with restart and remove actions",
      "Cloud-managed MCP servers (claude.ai Gmail, Drive, Calendar) detected and labeled — no more stuck delete",
      "Approve / deny / always-allow buttons are now real prominent buttons, not tiny links",
      "Plan-mode replies and multi-question answers actually reach Claude (silent drops are fixed)",
      "Picker chips stay in sync when Claude flips model or permission mode mid-conversation",
      "30 themes look genuinely distinct — phosphor scanlines on hacker, paper grain on designer, glass aurora on nightowl, pulsing rails on tron",
      "First-message thinking indicator fires immediately so you don't sit in silence",
      "Composer chips truncate cleanly on narrow windows instead of overlapping",
      "Activity-bar Context button now actually toggles the agent panel (Cmd+E)",
      "Dirty-close dialog stops surfacing .aider.chat.history.md and similar auto-generated noise",
      "Prefer the previous look? Settings → Appearance → Use classic compact timeline",
    ],
  },
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
