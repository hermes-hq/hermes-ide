// ─── Feature flag registry ────────────────────────────────────────────
//
// A flag gates a feature so it can be switched off without a new release.
// Since 2.0 every flag here is ON by default on both channels (the 2.0
// experience is for everyone); a flag can list the platforms where it is not
// ready yet (`stableOffOn`: off there by default on the stable channel). The
// hidden Settings > Flags section still forces any flag off: that is the
// kill switch. Flags are meant to be SHORT-LIVED: delete a flag's entry (and
// the `if (isFeatureFlagEnabled(...))` branch it guards) once the feature is
// proven.
//
// At most 15 flags may exist at once (raised from 5 for the 2.0 build, where
// every new feature ships behind its own flag; 15 once fleetControls,
// taskLauncher and fleetPerf joined the twelve already there) — enforced by
// src/__tests__/feature-flags.test.ts. If you need a 16th, retire one first.
//
// See src-tauri (none needed today: flags are a frontend-only concept, read
// once at startup from the app version + the `feature_flag_overrides`
// setting — see src/featureFlags/index.ts).

import type { Platform } from "../utils/platform";

export interface FeatureFlagDefinition {
  readonly id: string;
  /** Short label shown in the hidden Settings > Flags section. */
  readonly label: string;
  /** One sentence explaining what the flag gates and why it exists. */
  readonly description: string;
  /**
   * Platforms where the feature is not ready: there it is off by default on
   * the stable channel (an override still turns it on). Absent: on
   * everywhere.
   */
  readonly stableOffOn?: readonly Platform[];
}

export const FEATURE_FLAGS = [
  {
    id: "diskGuard",
    label: "Disk guard and fast worktrees",
    description:
      "Refuses to create a worktree below 10 GB free, shows disk used per worktree, removes build output on request and sweeps orphaned worktree folders in one action (Git panel > Worktrees). New worktrees get their dependencies cloned copy-on-write when the lockfile matches another checkout (on Windows, small files are copied, so disk use is lower but not near zero), and their own block of ports: terminals in them get PORT, HERMES_PORT_BASE and HERMES_PORT_COUNT, so dev servers that read PORT bind 21000 and up instead of their default. Agent view sessions do not get these ports.",
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
      "Shows the agents new in 2.0 (Antigravity CLI, OpenCode, goose, Hermes Agent) and the Custom agent card in the New Session agent step. Also, from the same catalog: new sessions start in each agent's mapping of Hermes's one safety default, a terminal pane shows the instruction files its agent loads (with Link CLAUDE.md to AGENTS.md) and a Looser than default chip, and MCP servers added in the Agent view go to the project's .mcp.json. Settings > Agents shows each installed agent's accounts (add one: a profile of its own, signed in with the agent's own sign-in), the models and effort levels it offers at launch, and the saved launch presets.",
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
      "Start agents through the bundled helper instead of typing their command into the shell, resume their conversation after a restart, report an agent stuck at a startup prompt, show every session's status (needs approval, working, done, ...) as a glyph and a word, marked when it is only a guess, and switch on each agent's own event reporting per launch (nothing written to your global config) with a status line above the session. Also Done-When checks: a repository's done_when commands run on their own when a turn ends, like its hooks do (Claude is sent back while they fail, at most 3 times and within 30 minutes of retrying), and a chip shows the result. When an agent's own CLI refuses a launch (a model its account does not have, signed out), Hermes stops it at once and the session says why in the CLI's words, with Try again, Retry with default model, Pick another model or Sign in; a session launched with a chosen model shows that model, marked requested, until the agent reports its own.",
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
  {
    id: "featureTracks",
    label: "Feature Tracks",
    description:
      "Guided work as short files in the repository (.hermes/features/<slug>): phases with gates you approve from the Track panel, the hi helper on PATH in every Hermes shell, and an inbox item when a phase or a blocking question waits on you.",
  },
  {
    id: "sessionHost",
    label: "Sessions survive quit, update and crash",
    description:
      "Run terminals in a small background host so agents keep working while Hermes is closed, updated or crashes; Hermes reattaches to them and replays what you missed. Quitting with a working agent asks whether to keep it running. macOS and Linux.",
    // Windows: a redraw wipes the restored snapshot, not ready yet.
    stableOffOn: ["win"],
  },
  {
    id: "fleetControls",
    label: "Spend caps, overlap badges and the task queue",
    description:
      "Shows only the spend an agent reports itself (n/a otherwise) and stops a session at a spend cap you set, marks sessions whose latest turns touched the same files, and queues new agent tasks beyond a running-agents or memory cap (Settings > Limits).",
  },
  {
    id: "taskLauncher",
    label: "Task launcher and agent doctor",
    description:
      "New Session (⌘N) opens the task launcher: describe the task and it starts on its own hermes/<name> branch as the agent's first prompt; the full creator moves to ⌘⇧N. Agents it starts always go through the bundled helper (it carries the task), even with that flag off. First launch shows the three-step welcome with the agent doctor, which also lives in Settings > Agents.",
  },
  {
    id: "fleetPerf",
    label: "Fleet performance",
    description:
      "Only terminals on screen hold a graphics context (hidden ones give it back and take it again when shown), each session row shows the memory its processes use, and the command palette can tile the working agents.",
  },
] as const satisfies readonly FeatureFlagDefinition[];

/** Derived from FEATURE_FLAGS, so adding or deleting an entry is the only step. */
export type FeatureFlagId = (typeof FEATURE_FLAGS)[number]["id"];
