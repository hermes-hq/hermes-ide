// ─── Agent load: what runs in each agent session (N22) ────────────────
//
// Asks the backend (fleet_agent_load, src-tauri/src/fleet.rs) whether a
// program runs in each agent session's shell and how much memory it uses.
// Polled only while the queue needs it: a cap is set.

import { invoke } from "@tauri-apps/api/core";
import { useSyncExternalStore } from "react";

export interface AgentLoadRow {
  readonly sessionId: string;
  readonly running: boolean | null;
  readonly memoryBytes: number;
}

export interface SessionLoad {
  readonly running: boolean | null;
  readonly memoryBytes: number;
  /** A program was seen running at some point. */
  readonly seenRunning: boolean;
}

export const LOAD_POLL_MS = 1000;

export function fetchAgentLoad(sessionIds: readonly string[]): Promise<AgentLoadRow[]> {
  return invoke<AgentLoadRow[]>("fleet_agent_load", { sessionIds });
}

type Listener = () => void;
let loads: ReadonlyMap<string, SessionLoad> = new Map();
const listeners = new Set<Listener>();

/** Fold one answer in; sessions not asked about are forgotten. */
export function applyAgentLoad(rows: readonly AgentLoadRow[]): void {
  const next = new Map<string, SessionLoad>();
  for (const r of rows) {
    const prev = loads.get(r.sessionId);
    next.set(r.sessionId, {
      running: r.running,
      memoryBytes: r.memoryBytes,
      seenRunning: (prev?.seenRunning ?? false) || r.running === true,
    });
  }
  loads = next;
  for (const l of [...listeners]) l();
}

export function getSessionLoad(sessionId: string): SessionLoad | null {
  return loads.get(sessionId) ?? null;
}

export function getAllLoads(): ReadonlyMap<string, SessionLoad> {
  return loads;
}

export function subscribeAgentLoad(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useAgentLoads(): ReadonlyMap<string, SessionLoad> {
  return useSyncExternalStore(subscribeAgentLoad, getAllLoads, getAllLoads);
}

export function _resetAgentLoadForTest(): void {
  loads = new Map();
  listeners.clear();
}
