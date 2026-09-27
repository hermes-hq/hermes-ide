import { invoke } from "@tauri-apps/api/core";
import type { ContextPin, ApplyContextResult } from "../types";

export function getContextPins(sessionId: string, projectId: string | null): Promise<ContextPin[]> {
  return invoke<ContextPin[]>("get_context_pins", { sessionId, projectId });
}

export function addContextPin(opts: {
  sessionId: string | null;
  projectId: string | null;
  kind: string;
  target: string;
  label: string | null;
  priority: number | null;
}): Promise<number> {
  return invoke<number>("add_context_pin", opts);
}

export function removeContextPin(id: number): Promise<void> {
  return invoke("remove_context_pin", { id });
}

export function applyContext(sessionId: string): Promise<ApplyContextResult> {
  return invoke<ApplyContextResult>("apply_context", { sessionId });
}

/** Deletes Hermes's own cached data for one session (history, token usage,
 * context pins/snapshots, session-scoped memory, the on-disk context file).
 * Leaves the session and the repo it works in untouched. */
export function deleteSessionData(sessionId: string): Promise<void> {
  return invoke("delete_session_data", { sessionId });
}
