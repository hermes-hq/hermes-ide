import { invoke } from "@tauri-apps/api/core";
import type { Project } from "../types/project";
import type { ProjectContextInfo } from "../types/context";

export function getProjects(): Promise<Project[]> {
  return invoke<Project[]>("get_realms").then((projects) =>
    projects.filter((p) => !p.path.includes("/.hermes/worktrees/"))
  );
}

export function createProject(path: string, name: string | null): Promise<Project> {
  return invoke<Project>("create_realm", { path, name });
}

export function deleteProject(id: string): Promise<void> {
  return invoke("delete_realm", { id });
}

export function getSessionProjects(sessionId: string): Promise<Project[]> {
  return invoke<Project[]>("get_session_realms", { sessionId });
}

export function attachSessionProject(sessionId: string, realmId: string, role: string): Promise<void> {
  return invoke("attach_session_realm", { sessionId, realmId, role });
}

export function detachSessionProject(sessionId: string, realmId: string): Promise<void> {
  return invoke("detach_session_realm", { sessionId, realmId });
}

export function scanProject(id: string, depth: string): Promise<void> {
  return invoke("scan_realm", { id, depth });
}

export function nudgeProjectContext(sessionId: string): Promise<void> {
  return invoke("nudge_realm_context", { sessionId });
}

export function scanDirectory(path: string, maxDepth: number): Promise<void> {
  return invoke("scan_directory", { path, maxDepth });
}

export function detectProject(path: string): Promise<void> {
  return invoke("detect_project", { path });
}

export function assembleSessionContext(sessionId: string, tokenBudget: number): Promise<{ realms: ProjectContextInfo[]; estimated_tokens: number; token_budget: number }> {
  return invoke<{ realms: ProjectContextInfo[]; estimated_tokens: number; token_budget: number }>("assemble_session_context", { sessionId, tokenBudget });
}
