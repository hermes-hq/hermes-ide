import { invoke } from "@tauri-apps/api/core";
import type { Project, ProjectOrdered } from "../types/project";
import type { ProjectContextInfo } from "../types/context";

export function getProjects(): Promise<Project[]> {
  return invoke<Project[]>("get_registered_projects").then((projects) =>
    projects.filter((p) => !isWorktreePath(p.path))
  );
}

/** Detect both current and legacy worktree path formats. */
export function isWorktreePath(path: string): boolean {
  return path.includes("hermes-worktrees/") || path.includes(".hermes/worktrees/");
}

export function createProject(path: string, name: string | null): Promise<Project> {
  return invoke<Project>("create_project", { path, name });
}

export function deleteProject(id: string): Promise<void> {
  return invoke("delete_project", { id });
}

export function getProjectsOrdered(): Promise<ProjectOrdered[]> {
  return invoke<ProjectOrdered[]>("get_projects_ordered").then((projects) =>
    projects.filter((p) => !isWorktreePath(p.path))
  );
}

export function getSessionProjects(sessionId: string): Promise<Project[]> {
  return invoke<Project[]>("get_session_projects", { sessionId });
}

export function attachSessionProject(sessionId: string, projectId: string, role: string): Promise<void> {
  return invoke("attach_session_project", { sessionId, projectId, role });
}

export function detachSessionProject(sessionId: string, projectId: string): Promise<void> {
  return invoke("detach_session_project", { sessionId, projectId });
}

export function scanProject(id: string, depth: string): Promise<void> {
  return invoke("scan_project", { id, depth });
}

export function setProjectWorktreePath(id: string, path: string | null): Promise<void> {
  return invoke("set_project_worktree_path", { id, path });
}

export function nudgeProjectContext(sessionId: string): Promise<void> {
  return invoke("nudge_project_context", { sessionId });
}

export function scanDirectory(path: string, maxDepth: number): Promise<void> {
  return invoke("scan_directory", { path, maxDepth });
}

export function detectProject(path: string): Promise<void> {
  return invoke("detect_project", { path });
}

export function assembleSessionContext(sessionId: string, tokenBudget: number): Promise<{ projects: ProjectContextInfo[]; estimated_tokens: number; token_budget: number }> {
  return invoke<{ projects: ProjectContextInfo[]; estimated_tokens: number; token_budget: number }>("assemble_session_context", { sessionId, tokenBudget });
}
