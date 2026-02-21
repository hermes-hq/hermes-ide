import { invoke } from "@tauri-apps/api/core";
import type { ShellEnvironment } from "../terminal/intelligence/shellEnvironment";
import type { ProjectContext } from "../terminal/intelligence/contextAnalyzer";

export function detectShellEnvironment(sessionId: string): Promise<ShellEnvironment> {
  return invoke<ShellEnvironment>("detect_shell_environment", { sessionId });
}

export function readShellHistory(shell: string, limit: number): Promise<string[]> {
  return invoke<string[]>("read_shell_history", { shell, limit });
}

export function getSessionCommands(sessionId: string, limit: number): Promise<string[]> {
  return invoke<string[]>("get_session_commands", { sessionId, limit });
}

export function getProjectContext(path: string): Promise<ProjectContext> {
  return invoke<ProjectContext>("get_project_context", { path });
}
