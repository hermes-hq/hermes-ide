/**
 * Slash-command classifier + curated catalog of Claude Code's built-in
 * interactive verbs.
 *
 * Two routing kinds:
 *
 *   - `native` — runs through the stream-json prompt channel.  Plugins,
 *     skills, user `.claude/commands/*.md` markdown commands, and any
 *     Claude-described slash command falls here.
 *   - `cli`    — purely-interactive TUI built-in that the SDK CAN'T
 *     drive over stream-json (because it expects a real terminal).
 *     Hermes routes these to an embedded `claude /<cmd>` PTY instead
 *     of submitting them as user prompts.
 *
 * Why a curated catalog: the SDK's `init.slash_commands` only reports
 * verbs available via stream-json — about 15 in a typical session.
 * Run `claude` interactively and you'll see ~70 more (`/mcp`,
 * `/agents`, `/cost`, `/login`, etc.).  The Claude binary doesn't
 * expose an enumeration API, so Conductor and other clients curate
 * the same list.  Sourced from `code.claude.com/docs/en/commands.md`
 * + observed `/help` output, against the v2.1.x binary line.
 */

export type SlashCommandKind = "native" | "cli";

/** Built-in interactive verbs the SDK omits from `init.slash_commands`.
 *  Used by the manual-typing classifier as a fallback when no
 *  description hint is available.  Lowercase, no leading slash. */
const KNOWN_CLI_COMMANDS = new Set<string>([
  "add-dir",
  "agents",
  "branch",
  "btw",
  "chrome",
  "clear",
  "color",
  "compact",
  "config",
  "context",
  "copy",
  "cost",
  "desktop",
  "diff",
  "doctor",
  "effort",
  "exit",
  "export",
  "extra-usage",
  "fast",
  "feedback",
  "focus",
  "heapdump",
  "help",
  "hooks",
  "ide",
  "insights",
  "install-github-app",
  "install-slack-app",
  "keybindings",
  "login",
  "logout",
  "mcp",
  "mcp-status",
  "memory",
  "mobile",
  "model",
  "passes",
  "permissions",
  "plan",
  "plugin",
  "powerup",
  "pr-comments",
  "privacy-settings",
  "radio",
  "recap",
  "release-notes",
  "reload-plugins",
  "remote-control",
  "remote-env",
  "rename",
  "resume",
  "rewind",
  "sandbox",
  "setup-bedrock",
  "setup-vertex",
  "skills",
  "stats",
  "status",
  "statusline",
  "stickers",
  "tasks",
  "team-onboarding",
  "teleport",
  "terminal-setup",
  "theme",
  "tui",
  "upgrade",
  "usage",
  "vim",
  "voice",
  "web-setup",
]);

/** Description-text hints the SDK adds when a command needs the CLI.
 *  Match case-insensitively. */
const DESCRIPTION_CLI_HINTS = [
  /\bopens? terminal\b/i,
  /\binteractive cli\b/i,
  /\bin the terminal\b/i,
  /\brequires? cli\b/i,
];

export interface ClassifiableCommand {
  command: string; // "/mcp" or "/foo:bar"
  description?: string;
}

/** Classify a slash command for routing.  Priority:
 *
 *    1. `<plugin>:<skill>` namespace → always native (the SDK runs
 *       these as agent prompts).
 *    2. Description text hints terminal → cli.
 *    3. SDK-PROVIDED description (non-empty, no CLI hint) → native.
 *       Trust the SDK's word: if it bothered to give a description,
 *       this is a skill or programmatic command, not an interactive
 *       built-in that happens to share a name.
 *    4. No description AND name in KNOWN_CLI_COMMANDS → cli.
 *       This is the manual-typing fallback (`/mcp` typed at the
 *       composer with no popover entry to lean on).
 *    5. Otherwise → native.
 *
 *  The priority order matters: a future Claude release where `/init`
 *  is an SDK-reported skill MUST classify as native, not cli — the
 *  SDK's description (which exists) overrides our heuristic list. */
export function classifySlashCommand(item: ClassifiableCommand): SlashCommandKind {
  if (item.command.includes(":")) return "native";

  const desc = item.description ?? "";
  if (desc.trim().length > 0) {
    for (const re of DESCRIPTION_CLI_HINTS) {
      if (re.test(desc)) return "cli";
    }
    // SDK-described command, no CLI hint → trust it as native.
    return "native";
  }

  // No description: fall back to the curated CLI verb list.
  const bare = item.command.replace(/^\//, "").toLowerCase();
  if (KNOWN_CLI_COMMANDS.has(bare)) return "cli";

  return "native";
}

/** Strip the leading `/` so callers can pass the bare verb to a
 *  spawned `claude <cmd>` process. */
export function stripSlash(command: string): string {
  return command.startsWith("/") ? command.slice(1) : command;
}

/** Curated catalog of Claude Code's well-known interactive built-ins
 *  with one-line descriptions.  Each entry is implicitly `kind: "cli"`
 *  — they're all interactive TUIs by definition.  Descriptions are
 *  short enough to fit the popover row.  Sourced from the official
 *  Claude Code commands reference; bumped per binary release.
 *
 *  Skills, plugins, and user-defined commands DON'T live here — those
 *  come from `init.slash_commands`. */
export interface BuiltinSlashEntry {
  command: string;
  description: string;
}

const CLAUDE_CLI_BUILTINS: BuiltinSlashEntry[] = [
  { command: "/add-dir", description: "Add directory for file access" },
  { command: "/agents", description: "Manage agents and subagents" },
  { command: "/branch", description: "Branch the conversation here" },
  { command: "/btw", description: "Quick side question" },
  { command: "/chrome", description: "Configure Chrome integration" },
  { command: "/clear", description: "Start a fresh conversation" },
  { command: "/color", description: "Set the prompt bar color" },
  { command: "/compact", description: "Summarize conversation history" },
  { command: "/config", description: "Open the Settings UI" },
  { command: "/context", description: "Visualize context-token usage" },
  { command: "/copy", description: "Copy a response to clipboard" },
  { command: "/cost", description: "Show session cost (alias /usage)" },
  { command: "/desktop", description: "Open Claude in the Desktop app" },
  { command: "/diff", description: "Open the interactive diff viewer" },
  { command: "/doctor", description: "Verify installation health" },
  { command: "/effort", description: "Set the model effort level" },
  { command: "/exit", description: "Exit the CLI" },
  { command: "/export", description: "Export conversation to a file" },
  { command: "/extra-usage", description: "Configure rate-limit override" },
  { command: "/fast", description: "Toggle fast mode" },
  { command: "/feedback", description: "Submit feedback / bug report" },
  { command: "/focus", description: "Toggle focus view" },
  { command: "/heapdump", description: "Dump memory for debugging" },
  { command: "/help", description: "Show built-in help" },
  { command: "/hooks", description: "View hook configurations" },
  { command: "/ide", description: "Manage IDE integrations" },
  { command: "/insights", description: "Analyze your sessions" },
  { command: "/install-github-app", description: "Set up the GitHub Actions app" },
  { command: "/install-slack-app", description: "Install the Slack app" },
  { command: "/keybindings", description: "Edit keybindings config" },
  { command: "/login", description: "Sign in to Claude Code" },
  { command: "/logout", description: "Sign out of Claude Code" },
  { command: "/mcp", description: "Manage MCP servers" },
  { command: "/mcp-status", description: "View MCP server connection status" },
  { command: "/memory", description: "Edit CLAUDE.md memory files" },
  { command: "/mobile", description: "Show mobile-app QR code" },
  { command: "/model", description: "Change the active model" },
  { command: "/passes", description: "Share a free-week trial" },
  { command: "/permissions", description: "Manage tool permissions" },
  { command: "/plan", description: "Enter plan mode" },
  { command: "/plugin", description: "Manage plugins" },
  { command: "/powerup", description: "Interactive feature lessons" },
  { command: "/pr-comments", description: "Read PR review comments" },
  { command: "/privacy-settings", description: "View privacy options" },
  { command: "/radio", description: "Open Claude FM lo-fi radio" },
  { command: "/recap", description: "Generate a session summary" },
  { command: "/release-notes", description: "View the changelog" },
  { command: "/reload-plugins", description: "Reload installed plugins" },
  { command: "/remote-control", description: "Enable remote control" },
  { command: "/remote-env", description: "Configure remote environment" },
  { command: "/rename", description: "Rename the current session" },
  { command: "/resume", description: "Resume a prior conversation" },
  { command: "/rewind", description: "Undo to a checkpoint" },
  { command: "/sandbox", description: "Toggle sandbox mode" },
  { command: "/setup-bedrock", description: "Configure AWS Bedrock" },
  { command: "/setup-vertex", description: "Configure Google Vertex AI" },
  { command: "/skills", description: "List available skills" },
  { command: "/stats", description: "Show usage stats" },
  { command: "/status", description: "Show version + account status" },
  { command: "/statusline", description: "Configure the status line" },
  { command: "/stickers", description: "Order Claude stickers" },
  { command: "/tasks", description: "List background tasks" },
  { command: "/team-onboarding", description: "Generate a team-onboarding guide" },
  { command: "/teleport", description: "Pull a web session to the CLI" },
  { command: "/terminal-setup", description: "Configure terminal keybindings" },
  { command: "/theme", description: "Change the color theme" },
  { command: "/tui", description: "Set the terminal-UI renderer" },
  { command: "/upgrade", description: "Switch to a higher plan" },
  { command: "/usage", description: "Show cost & rate limits" },
  { command: "/vim", description: "Toggle Vim keybindings" },
  { command: "/voice", description: "Toggle voice dictation" },
  { command: "/web-setup", description: "GitHub connect for web" },
];

/** Return only the curated built-ins that aren't already in the
 *  SDK's reported list — caller appends these so every well-known
 *  interactive verb is visible in the popover regardless of whether
 *  the SDK chose to expose it. */
export function missingCliBuiltins(
  existing: ReadonlyArray<{ command: string }>,
): BuiltinSlashEntry[] {
  const have = new Set(existing.map((e) => e.command.toLowerCase()));
  return CLAUDE_CLI_BUILTINS.filter((b) => !have.has(b.command.toLowerCase()));
}
