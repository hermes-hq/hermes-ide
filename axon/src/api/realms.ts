import { invoke } from "@tauri-apps/api/core";
import type { Realm } from "../types/realm";
import type { RealmContextInfo } from "../types/context";

export function getRealms(): Promise<Realm[]> {
  return invoke<Realm[]>("get_realms");
}

export function createRealm(path: string, name: string | null): Promise<Realm> {
  return invoke<Realm>("create_realm", { path, name });
}

export function deleteRealm(id: string): Promise<void> {
  return invoke("delete_realm", { id });
}

export function getSessionRealms(sessionId: string): Promise<Realm[]> {
  return invoke<Realm[]>("get_session_realms", { sessionId });
}

export function attachSessionRealm(sessionId: string, realmId: string, role: string): Promise<void> {
  return invoke("attach_session_realm", { sessionId, realmId, role });
}

export function detachSessionRealm(sessionId: string, realmId: string): Promise<void> {
  return invoke("detach_session_realm", { sessionId, realmId });
}

export function scanRealm(id: string, depth: string): Promise<void> {
  return invoke("scan_realm", { id, depth });
}

export function nudgeRealmContext(sessionId: string): Promise<void> {
  return invoke("nudge_realm_context", { sessionId });
}

export function scanDirectory(path: string, maxDepth: number): Promise<void> {
  return invoke("scan_directory", { path, maxDepth });
}

export function detectProject(path: string): Promise<void> {
  return invoke("detect_project", { path });
}

export function assembleSessionContext(sessionId: string, tokenBudget: number): Promise<{ realms: RealmContextInfo[] }> {
  return invoke<{ realms: RealmContextInfo[] }>("assemble_session_context", { sessionId, tokenBudget });
}
