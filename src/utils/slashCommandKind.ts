/**
 * Slash-command classifier.
 *
 * The Claude SDK reports every available slash command in
 * `init.slash_commands` — a mix of:
 *
 *   - Native skills / plugins / user commands that run through the
 *     stream-json prompt channel (e.g. `/<plugin>:<skill>`,
 *     `~/.claude/commands/<name>.md`).
 *   - Built-in CLI-only commands (e.g. `/mcp`, `/help`, `/agents`,
 *     `/cost`, `/init`) that are interactive TUIs in the actual
 *     `claude` CLI binary and DON'T work over stream-json.  Sending
 *     them as a user message either no-ops or returns a polite
 *     error from the model.
 *
 * Conductor's UX (which the user wants Hermes to match) shows ALL of
 * them in the popover, but routes the CLI-only ones into an embedded
 * mini-terminal that runs the real `claude /<cmd>` interactively.
 *
 * This module classifies commands so the composer can branch on it.
 */

export type SlashCommandKind = "native" | "cli";

/** Built-in Claude CLI commands that ONLY work in interactive TUI
 *  mode.  Names without the leading slash, lowercased.  Curated from
 *  the public Claude Code reference + observed `/help` output. */
const KNOWN_CLI_COMMANDS = new Set<string>([
  "agents",
  "clear",
  "compact",
  "config",
  "cost",
  "doctor",
  "help",
  "init",
  "login",
  "logout",
  "mcp",
  "mcp-status",
  "memory",
  "model",
  "output-style",
  "permissions",
  "pr-comments",
  "release-notes",
  "review",
  "settings",
  "status",
  "terminal-setup",
  "vim",
]);

/** Description-text hints the SDK adds when a command is CLI-only.
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

/** Classify a single slash command as `native` (run via stream-json)
 *  or `cli` (must run in an embedded `claude /<cmd>` PTY). */
export function classifySlashCommand(item: ClassifiableCommand): SlashCommandKind {
  // Plugin / skill commands always look like `/<plugin>:<skill>` —
  // those are stream-json-native by construction (the SDK runs them
  // as agent prompts).  Trust the namespace separator.
  if (item.command.includes(":")) return "native";

  // User / project custom commands from `~/.claude/commands/*.md` are
  // also native — they're prompt templates, not CLI subcommands.  But
  // we can't tell from the command name alone whether `/foo` is a
  // user command or a CLI built-in, so check the known CLI list
  // FIRST and fall through to native.
  const bare = item.command.replace(/^\//, "").toLowerCase();
  if (KNOWN_CLI_COMMANDS.has(bare)) return "cli";

  // Description hint — if the SDK said the command "opens terminal"
  // or similar, trust that signal even when the name isn't on our
  // known list.  Future-proofs against new CLI commands.
  if (item.description) {
    for (const re of DESCRIPTION_CLI_HINTS) {
      if (re.test(item.description)) return "cli";
    }
  }

  return "native";
}

/** Strip the leading `/` so callers can pass the bare verb to a
 *  spawned `claude <cmd>` process. */
export function stripSlash(command: string): string {
  return command.startsWith("/") ? command.slice(1) : command;
}
