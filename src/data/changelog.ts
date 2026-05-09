/**
 * Embedded changelog shown in the "What's New" dialog after updates.
 *
 * Each entry is keyed by the version string (without "v" prefix).
 *
 * Two shapes are supported:
 *   - Legacy `items: string[]` — a flat bullet list (older releases).
 *   - New `sections: ChangelogSection[]` — grouped, illustrated cards
 *     for richer announcements.  Use this for any non-trivial release.
 *
 * When releasing a new version, add an entry here.
 */

export interface ChangelogSection {
  /** Short heading (3-6 words). */
  title: string;
  /** Single emoji or short string icon shown next to the title. */
  icon?: string;
  /** Optional one-paragraph intro that opens the section. */
  description?: string;
  /** Bullet list of changes inside this section. */
  items: string[];
  /** Optional CTA — surfaced as a quiet hint at the bottom of the
   *  section ("try `/mcp`", "Settings → Appearance"). */
  hint?: string;
}

export interface ChangelogEntry {
  /** Optional short tagline shown under the version pill. */
  tagline?: string;
  /** Optional accent color theme: `default` | `warm` | `cool`. */
  accent?: "default" | "warm" | "cool";
  /** Legacy flat bullet list. */
  items?: string[];
  /** Grouped section cards (preferred for rich releases). */
  sections?: ChangelogSection[];
}

export const changelog: Record<string, ChangelogEntry> = {
  "1.1.0": {
    tagline: "A modern timeline, every Claude command at your fingertips, and a way back if you need it.",
    accent: "default",
    sections: [
      {
        title: "A modern session timeline",
        icon: "✦",
        description:
          "The agent timeline now reads like a real conversation. Speaker chips identify who's talking; messages get a soft accent-tinted card; whitespace replaces the hairline rules.",
        items: [
          "Avatar chips with bot / person icons replace the № 01 marginalia",
          "Refined sans-serif body — mono is preserved for code, paths, and tool calls",
          "30 themes paint the layout differently — phosphor scanlines on hacker, paper grain on designer, glass aurora on nightowl, pulsing rails on tron",
        ],
      },
      {
        title: "Every slash command, in or out",
        icon: "▣",
        description:
          "Type / and you see every Claude command — built-ins, plugins, skills — clearly labeled in-app or terminal.",
        items: [
          "Pick /mcp, /agents, /cost, /help — Hermes spawns claude in an inline xterm and auto-types the command for you",
          "New Terminal button next to Builder opens a quick shell for git, npm, ls — anything",
        ],
        hint: "Type / in the composer to see them all.",
      },
      {
        title: "MCP server panel that helps",
        icon: "◇",
        description:
          "Click any MCP server to see why its dot is the color it is, what command runs it, and which env keys it expects.",
        items: [
          "Status explanation (Connected / Needs auth / Failed) with a color tone you can read at a glance",
          "Transport, command, env keys, header keys, and the tools the server exposes",
          "Restart and Remove actions with a confirmation step",
          "Cloud-managed servers (claude.ai Gmail, Drive, Calendar) are detected and labeled — no more stuck delete",
        ],
      },
      {
        title: "Plan mode and permissions, fixed",
        icon: "✓",
        description:
          "Send no longer silently drops your reply when Claude is asking you something. Approve / deny buttons stop hiding.",
        items: [
          "Plan-mode replies and AskUserQuestion answers actually reach Claude",
          "Approve once / Always allow / Deny / Edit input are now real, prominent buttons — the primary CTA pulses to mark it as your turn",
          "Picker chips stay in sync when Claude flips model or permission mode mid-conversation",
        ],
      },
      {
        title: "Smaller polish you'll notice",
        icon: "·",
        items: [
          "First-message thinking indicator fires immediately — no more silent boot pause",
          "Cost & Tokens panel section is gone (the live cost meter in the header is the source of truth)",
          "Activity-bar Context button actually toggles the agent panel (Cmd+E)",
          ".aider.chat.history.md and other auto-generated files don't surface on session-close",
          "Composer chips truncate cleanly on narrow widths instead of overlapping",
        ],
      },
      {
        title: "Prefer the previous look?",
        icon: "↺",
        description:
          "If the modern timeline isn't for you, the denser logbook style is one toggle away.",
        items: [
          "Settings → Appearance → Agent Timeline Style → Classic compact",
          "Restores the mono body, brass left bar on user messages, and hairline rules between turns",
          "Themes still apply on top, so the classic look paints in your active theme's colors",
        ],
        hint: "Toggle it back any time.",
      },
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
