// ─── Agent load: what runs in each agent session (N22) ────────────────
//
// Asks the backend (fleet_agent_load, src-tauri/src/fleet.rs) whether a
// program runs in each agent session's shell and how much memory it uses.
// Polled only while the queue needs it: a cap is set. Each poll reads the
// whole process table, so it runs every LOAD_POLL_IDLE_MS, and every
// LOAD_POLL_MS only while tasks wait for a slot to free.

import { invoke } from "@tauri-apps/api/core";

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
export const LOAD_POLL_IDLE_MS = 3000;

/** How long until the next poll: short only while tasks wait. */
export function loadPollDelay(queuedTasks: number): number {
  return queuedTasks > 0 ? LOAD_POLL_MS : LOAD_POLL_IDLE_MS;
}

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

export function getAllLoads(): ReadonlyMap<string, SessionLoad> {
  return loads;
}

export function subscribeAgentLoad(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function _resetAgentLoadForTest(): void {
  loads = new Map();
  listeners.clear();
}
