import { invoke } from "@tauri-apps/api/core";
import type { ContextPin, ApplyContextResult, ErrorCorrelation, HermesProjectConfig } from "../types";

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

export function applyContext(sessionId: string, executionMode: string): Promise<ApplyContextResult> {
  return invoke<ApplyContextResult>("apply_context", { sessionId, executionMode });
}

export function getErrorResolutions(projectId: string, limit: number): Promise<{ fingerprint: string; resolution: string | null; occurrence_count: number }[]> {
  return invoke<{ fingerprint: string; resolution: string | null; occurrence_count: number }[]>("get_error_resolutions", { projectId, limit });
}

export function findErrorCorrelations(opts: {
  fingerprint: string;
  projectId: string;
  excludeSession: string;
  limit: number;
}): Promise<ErrorCorrelation[]> {
  return invoke<ErrorCorrelation[]>("find_error_correlations", opts);
}

export function forkSessionContext(sourceSessionId: string, targetSessionId: string): Promise<number> {
  return invoke<number>("fork_session_context", { sourceSessionId, targetSessionId });
}

export function loadHermesProjectConfig(realmId: string, realmPath: string): Promise<HermesProjectConfig | null> {
  return invoke<HermesProjectConfig | null>("load_hermes_project_config", { realmId, realmPath });
}
