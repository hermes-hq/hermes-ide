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
