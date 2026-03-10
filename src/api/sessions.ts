import { invoke } from "@tauri-apps/api/core";
import type { SessionData, SessionHistoryEntry } from "../types/session";

export function createSession(opts: {
  sessionId: string | null;
  label: string | null;
  workingDirectory: string | null;
  color: string | null;
  workspacePaths: string[] | null;
  aiProvider: string | null;
  realmIds: string[] | null;
  autoApprove?: boolean;
  sshHost?: string | null;
  sshPort?: number | null;
  sshUser?: string | null;
}): Promise<SessionData> {
  return invoke<SessionData>("create_session", opts);
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

export function writeToSession(sessionId: string, data: string): Promise<void> {
  return invoke("write_to_session", { sessionId, data });
}

export function saveAllSnapshots(): Promise<void> {
  return invoke("save_all_snapshots");
}
