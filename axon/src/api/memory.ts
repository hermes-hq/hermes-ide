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
