import { invoke } from "@tauri-apps/api/core";
import type { PersistedMemory } from "../types";

export function saveMemory(opts: {
  scope: string;
  scopeId: string;
  key: string;
  value: string;
  source: string;
  category: string;
  confidence: number;
}): Promise<void> {
  return invoke("save_memory", opts);
}

export function getAllMemory(scope: string, scopeId: string): Promise<PersistedMemory[]> {
  return invoke<PersistedMemory[]>("get_all_memory", { scope, scopeId });
}

export function deleteMemory(scope: string, scopeId: string, key: string): Promise<void> {
  return invoke("delete_memory", { scope, scopeId, key });
}

/** Save memory at project scope for a given project */
export function saveProjectMemory(projectId: string, key: string, value: string, source: string = "user"): Promise<void> {
  return saveMemory({
    scope: "project",
    scopeId: projectId,
    key,
    value,
    source,
    category: "general",
    confidence: 1.0,
  });
}

/** Get project-scoped memory for a given project */
export function getProjectMemory(projectId: string): Promise<PersistedMemory[]> {
  return getAllMemory("project", projectId);
}
