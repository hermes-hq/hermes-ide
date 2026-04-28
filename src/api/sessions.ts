import { invoke } from "@tauri-apps/api/core";
import type { SessionData, SessionHistoryEntry, TmuxSessionEntry, TmuxWindowEntry, PortForward } from "../types/session";

export interface RemoteGitInfo {
  branch: string | null;
  change_count: number;
}

export function createSession(opts: {
  sessionId: string | null;
  label: string | null;
  workingDirectory: string | null;
  color: string | null;
  workspacePaths: string[] | null;
  aiProvider: string | null;
  projectIds: string[] | null;
  autoApprove?: boolean;
  permissionMode?: string | null;
  customPrefix?: string | null;
  customSuffix?: string | null;
  channels?: string[] | null;
  sshHost?: string | null;
  sshPort?: number | null;
  sshUser?: string | null;
  tmuxSession?: string | null;
  sshIdentityFile?: string | null;
  initialRows?: number | null;
  initialCols?: number | null;
}): Promise<SessionData> {
  return invoke<SessionData>("create_session", opts);
}

export function sshListTmuxSessions(
  host: string,
  port?: number,
  user?: string,
): Promise<TmuxSessionEntry[]> {
  return invoke<TmuxSessionEntry[]>("ssh_list_tmux_sessions", { host, port, user });
}

export function sshListTmuxWindows(
  host: string,
  tmuxSession: string,
  port?: number,
  user?: string,
): Promise<TmuxWindowEntry[]> {
  return invoke<TmuxWindowEntry[]>("ssh_list_tmux_windows", { host, port, user, tmuxSession });
}

export function sshTmuxSelectWindow(
  host: string,
  tmuxSession: string,
  windowIndex: number,
  port?: number,
  user?: string,
): Promise<void> {
  return invoke("ssh_tmux_select_window", { host, port, user, tmuxSession, windowIndex });
}

export function sshTmuxRenameWindow(
  host: string,
  tmuxSession: string,
  windowIndex: number,
  newName: string,
  port?: number,
  user?: string,
): Promise<void> {
  return invoke("ssh_tmux_rename_window", { host, port, user, tmuxSession, windowIndex, newName });
}

export function sshTmuxNewWindow(
  host: string,
  tmuxSession: string,
  port?: number,
  user?: string,
  windowName?: string,
): Promise<void> {
  return invoke("ssh_tmux_new_window", { host, port, user, tmuxSession, windowName });
}

export function checkAiProviders(): Promise<Record<string, boolean>> {
  return invoke<Record<string, boolean>>("check_ai_providers");
}

export function closeSession(sessionId: string): Promise<void> {
  return invoke("close_session", { sessionId });
}

export function getSessions(): Promise<SessionData[]> {
  return invoke<SessionData[]>("get_sessions");
}

export function getRecentSessions(limit: number): Promise<SessionHistoryEntry[]> {
  return invoke<SessionHistoryEntry[]>("get_recent_sessions", { limit });
}

export function getSessionSnapshot(sessionId: string): Promise<string | null> {
  return invoke<string | null>("get_session_snapshot", { sessionId });
}

export function resizeSession(sessionId: string, rows: number, cols: number): Promise<void> {
  return invoke("resize_session", { sessionId, rows, cols });
}

export function updateSessionLabel(sessionId: string, label: string): Promise<void> {
  return invoke("update_session_label", { sessionId, label });
}

export function updateSessionDescription(sessionId: string, description: string): Promise<void> {
  return invoke("update_session_description", { sessionId, description });
}

export function updateSessionGroup(sessionId: string, group: string | null): Promise<void> {
  return invoke("update_session_group", { sessionId, group });
}

export function updateSessionColor(sessionId: string, color: string): Promise<void> {
  return invoke("update_session_color", { sessionId, color });
}

export function addWorkspacePath(sessionId: string, path: string): Promise<void> {
  return invoke("add_workspace_path", { sessionId, path });
}

export function removeWorkspacePath(sessionId: string, path: string): Promise<void> {
  return invoke("remove_workspace_path", { sessionId, path });
}

export function writeToSession(sessionId: string, data: string): Promise<void> {
  return invoke("write_to_session", { sessionId, data });
}

export function saveAllSnapshots(): Promise<void> {
  return invoke("save_all_snapshots");
}

/** Check if the shell is the foreground process (no child program running). */
export function isShellForeground(sessionId: string): Promise<boolean> {
  return invoke<boolean>("is_shell_foreground", { sessionId });
}

// ─── Port Forwarding ─────────────────────────────────────────────────

export function sshAddPortForward(
  sessionId: string,
  localPort: number,
  remoteHost: string,
  remotePort: number,
  label?: string,
): Promise<void> {
  return invoke("ssh_add_port_forward", { sessionId, localPort, remoteHost, remotePort, label });
}

export function sshRemovePortForward(sessionId: string, localPort: number): Promise<void> {
  return invoke("ssh_remove_port_forward", { sessionId, localPort });
}

export function sshListPortForwards(sessionId: string): Promise<PortForward[]> {
  return invoke<PortForward[]>("ssh_list_port_forwards", { sessionId });
}

// ─── Remote CWD & Git ────────────────────────────────────────────────

export function sshGetRemoteCwd(sessionId: string): Promise<string> {
  return invoke<string>("ssh_get_remote_cwd", { sessionId });
}

export function sshGetRemoteGitInfo(sessionId: string, remotePath: string): Promise<RemoteGitInfo> {
  return invoke<RemoteGitInfo>("ssh_get_remote_git_info", { sessionId, remotePath });
}

// ─── SSH File Transfer ───────────────────────────────────────────────

export function sshUploadFile(sessionId: string, localPath: string, remoteDir: string): Promise<void> {
  return invoke("ssh_upload_file", { sessionId, localPath, remoteDir });
}

export function sshDownloadFile(sessionId: string, remotePath: string, localPath: string): Promise<void> {
  return invoke("ssh_download_file", { sessionId, remotePath, localPath });
}

// ─── Composer (mentions + image paste) ───────────────────────────────

/**
 * List non-ignored files in a session's working directory.
 * Returns paths relative to the working directory, capped at 5000 entries.
 * Powers the composer's `@`-mention dropdown.
 */
export function listSessionFiles(sessionId: string): Promise<string[]> {
  return invoke<string[]>("list_session_files", { sessionId });
}

/**
 * Save a pasted image to the app cache and return its absolute path.
 *
 * `bytes` is sent as a JSON array of numbers (Tauri's serialization for
 * `Vec<u8>`). Build it from a `Blob` with:
 *   `Array.from(new Uint8Array(await blob.arrayBuffer()))`.
 *
 * `ext` must be one of `png`, `jpg`, `jpeg`, `gif`, `webp`, `bmp`.
 * Images larger than 20 MB are rejected.
 */
export function savePastedImage(
  sessionId: string,
  bytes: number[],
  ext: string,
): Promise<string> {
  return invoke<string>("save_pasted_image", { sessionId, bytes, ext });
}

/** Read an image file from disk as raw bytes (for thumbnail data-URL preview). */
export function readImageBytes(path: string): Promise<number[]> {
  return invoke<number[]>("read_image_bytes", { path });
}

// ─── Claude slash commands ───────────────────────────────────────────

export interface ClaudeCommand {
  command: string;
  description: string;
  source: "user" | "project" | "builtin";
  body: string;
}

/**
 * List Claude Code slash commands available in this session.
 *
 * Combines three sources:
 *   - `builtin` — discovered from the `claude` CLI itself (via `--print` /
 *     `--help`); empty when discovery fails.
 *   - `user` — `~/.claude/commands/**\/*.md` (user-global on-disk commands).
 *   - `project` — `<cwd>/.claude/commands/**\/*.md` (project-local).
 *
 * Project overrides user, user overrides builtin (same name). Each `.md`
 * filename becomes the command name; the body is the prompt template;
 * `description` comes from YAML frontmatter or the first non-empty body line.
 * Built-in entries have an empty `body`.
 */
export function listClaudeCommands(sessionId: string): Promise<ClaudeCommand[]> {
  return invoke<ClaudeCommand[]>("list_claude_commands", { sessionId });
}

/**
 * Begin watching the user-global and project-local Claude command directories
 * (and `~/.claude/settings.json`) for this session. Emits
 * `"claude-commands-changed"` (debounced ~500ms) when commands change, and
 * `"claude-settings-changed"` when settings.json changes. Idempotent per
 * session.
 *
 * @deprecated Use {@link startClaudeWatcher} — this delegates to the same
 * watcher and is kept only for backwards compatibility.
 */
export function startClaudeCommandsWatcher(sessionId: string): Promise<void> {
  return invoke("start_claude_commands_watcher", { sessionId });
}

/**
 * Stop the Claude commands watcher previously started for this session.
 *
 * @deprecated Use {@link stopClaudeWatcher}.
 */
export function stopClaudeCommandsWatcher(sessionId: string): Promise<void> {
  return invoke("stop_claude_commands_watcher", { sessionId });
}

/**
 * Begin watching Claude's user-global and project-local command directories
 * AND `~/.claude/settings.json` for this session. Emits
 * `"claude-commands-changed"` (debounced ~500ms) when commands change, and
 * `"claude-settings-changed"` when settings.json changes. Idempotent per
 * session — calling start a second time is a no-op.
 */
export function startClaudeWatcher(sessionId: string): Promise<void> {
  return invoke("start_claude_watcher", { sessionId });
}

/** Stop the Claude watcher previously started for this session. */
export function stopClaudeWatcher(sessionId: string): Promise<void> {
  return invoke("stop_claude_watcher", { sessionId });
}

// ─── Claude capability discovery ─────────────────────────────────────

export interface ModelInfo {
  id: string;
  label: string;
  description: string;
}

export interface BuiltinCommand {
  command: string;
  description: string;
}

/**
 * Live snapshot of what the local `claude` CLI supports. All four lists are
 * independently discoverable; a list arrives empty (or `effort_current` is
 * `null`) when discovery couldn't determine that capability — the UI should
 * hide the relevant control rather than guessing.
 */
export interface ClaudeCapabilities {
  effort_levels: string[];
  effort_current: string | null;
  models: ModelInfo[];
  slash_commands_builtin: BuiltinCommand[];
}

/**
 * Discover everything the local Claude CLI can do, in one call.
 *
 * Runs four discoveries in parallel: parse `claude --help` for `--effort`
 * options, read `~/.claude/settings.json` for the current effort level,
 * spawn `claude --print` to enumerate models and built-in slash commands.
 * Cached per process for 30 seconds; the cache is invalidated automatically
 * when `~/.claude/settings.json` changes (see `claude-settings-changed`),
 * and can be invalidated manually via {@link invalidateClaudeCapabilitiesCache}
 * (e.g. immediately after the user fires a state-changing slash command).
 */
export function discoverClaudeCapabilities(sessionId: string): Promise<ClaudeCapabilities> {
  return invoke<ClaudeCapabilities>("discover_claude_capabilities", { sessionId });
}

/**
 * Force the discovery cache to drop its current entry so the next
 * `discoverClaudeCapabilities` call re-reads `~/.claude/settings.json` and
 * re-runs `claude --help`.  Use after the frontend writes state-changing
 * slash commands like `/effort <level>` so the chip reflects the new value
 * without waiting for the filesystem watcher's debounce.
 */
export function invalidateClaudeCapabilitiesCache(): Promise<void> {
  return invoke("invalidate_claude_capabilities_cache");
}
