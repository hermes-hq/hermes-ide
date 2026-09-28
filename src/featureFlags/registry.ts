// ─── Feature flag registry ────────────────────────────────────────────
//
// A flag hides a not-yet-proven feature from stable users while it ships to
// beta. Flags are meant to be SHORT-LIVED: delete a flag's entry (and the
// `if (isFeatureFlagEnabled(...))` branch it guards) once the feature is
// proven and shipping to everyone.
//
// At most 12 flags may exist at once (raised from 5 for the 2.0 build, where
// every new feature ships behind its own flag) — enforced by
// src/__tests__/feature-flags.test.ts. If you need a 13th, retire one first.
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
    id: "diskGuard",
    label: "Disk guard and worktree hygiene",
    description:
      "Refuses to create a worktree below 10 GB free, shows disk used per worktree, removes build output on request and sweeps orphaned worktree folders in one action (Git panel > Worktrees).",
  },
  {
    id: "agentViewErrors",
    label: "Agent view: clear errors",
    description:
      "In the optional Agent view, say why the agent stopped (could not start, signed out, exited, busy, unreadable output) with a Retry or Sign in button, instead of the one-line exit notice.",
  },
  {
    id: "agentCatalog",
    label: "More agents and Custom agent",
    description:
      "Shows the agents new in 2.0 (Antigravity CLI, OpenCode, goose, Hermes Agent) and the Custom agent card in the New Session agent step. Also, from the same catalog: new sessions start in each agent's mapping of Hermes's one safety default, a terminal pane shows the instruction files its agent loads (with Link CLAUDE.md to AGENTS.md) and a Looser than default chip, and MCP servers added in the Agent view go to the project's .mcp.json.",
  },
  {
    id: "honestIsolation",
    label: "Honest isolation",
    description:
      "New tasks get their own hermes/<name> branch, a branch already in use asks before it is shared, and closing a session with changes commits them to its branch or archives them instead of stashing. A repository's .hermes/worktree.toml prepares each new worktree (setup commands, git-ignored files, ports) after asking once.",
  },
  {
    id: "launchHelper",
    label: "Launch helper (hi run), session status and zero-setup signals",
    description:
      "Start agents through the bundled helper instead of typing their command into the shell, resume their conversation after a restart, report an agent stuck at a startup prompt, show every session's status (needs approval, working, done, ...) as a glyph and a word, marked when it is only a guess, and switch on each agent's own event reporting per launch (nothing written to your global config) with a status line above the session. Also Done-When checks: a repository's done_when commands run on their own when a turn ends, like its hooks do (Claude is sent back while they fail, at most 3 times and within 30 minutes of retrying), and a chip shows the result.",
  },
  {
    id: "attentionInbox",
    label: "Attention inbox",
    description:
      "A title-bar badge with the number of agents blocked on you opens the attention inbox (⌘⇧I); ⌘I jumps to the agent waiting longest. Adds grouped notifications, the dock/taskbar badge, keeping the machine awake while an agent works, and optional away messages to a web address.",
  },
  {
    id: "pluginApiV2",
    label: "Plugin API v2",
    description:
      "Plugins can declare \"apiVersion\": 2 to react to every agent's status, add inbox items, read feature tracks and add review checks; plugins built for v1 keep working and are marked as using the old API.",
  },
  {
    id: "turnLedger",
    label: "Turn history",
    description:
      "Save a snapshot of the working tree after every agent turn (including changes made through shell commands) into a hidden git reference, and show a bar under terminal sessions with each turn's Diff and Restore. Snapshots include untracked files and live inside the repository's .git folder (refs/hermes/...), so a mirror push copies them; they are removed 14 days after the session is closed.",
  },
  {
    id: "reviewDesk",
    label: "Review Desk (⌘G)",
    description:
      "Replaces the git panels with one review surface: the diff from the merge-base grouped by turn or by file, viewed checkboxes, line comments sent back to the agent that made the turn with a delivery receipt, revert of one turn, and risk flags on lockfiles, workflows, secrets and binaries.",
  },
  {
    id: "landSheet",
    label: "Land sheet with undo",
    description:
      "A Land button in the session's Git panel: commit, open a pull request or squash-merge locally in one step, archive the worktree, and undo any of it.",
  },
] as const satisfies readonly FeatureFlagDefinition[];

/** Derived from FEATURE_FLAGS, so adding or deleting an entry is the only step. */
export type FeatureFlagId = (typeof FEATURE_FLAGS)[number]["id"];
